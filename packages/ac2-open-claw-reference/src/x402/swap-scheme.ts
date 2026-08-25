/**
 * Swap-funding x402 client scheme.
 *
 * Wraps `@x402/avm`'s `ExactAvmScheme`. When the paying wallet already holds
 * enough of the required asset, payment creation is delegated unchanged. When
 * it does not, a single atomic group is built instead:
 *
 *   [asset opt-in (if needed)] + [DEX swap ALGO -> asset] + [x402 payment]
 *
 * with `paymentIndex` pointing at the final transaction. Every transaction is
 * sent and signed by the wallet, which the facilitator accepts: it verifies
 * the transaction at `paymentIndex` against the requirements, requires all
 * non-facilitator transactions to be signed, and simulates the whole group.
 *
 * Sponsored fees (`requirements.extra.feePayer`) are intentionally not used on
 * the swap path: the wallet must hold ALGO to fund the swap anyway, so it pays
 * its own fees and the group stays free of facilitator-signed transactions.
 */

import { AlgorandClient } from '@algorandfoundation/algokit-utils/algorand-client';
import { MAX_TRANSACTION_GROUP_SIZE } from '@algorandfoundation/algokit-utils/common';
import {
  encodeTransactionRaw,
  groupTransactions,
  makeEmptyTransactionSigner,
  Transaction,
} from '@algorandfoundation/algokit-utils/transact';
import {
  encodeTransaction,
  USDC_CONFIG,
  type ClientAvmConfig,
  type ClientAvmSigner,
} from '@x402/avm';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types';

import {
  assertSwapAffordable,
  isTestnetCaip2,
  planFunding,
  X402SwapUnavailableError,
  type ChainLookup,
  type SwapFundingInfo,
  type SwapFundingOptions,
  type SwapProvider,
} from './swap.js';

export interface SwapFundingSchemeOptions {
  readonly provider: SwapProvider;
  readonly swap: SwapFundingOptions;
  /** Called when a payment is funded by a swap, so callers can surface it. */
  readonly onSwapFunded?: (info: SwapFundingInfo) => void;
  /** Injectable chain reads for tests; defaults to algod lookups. */
  readonly lookup?: ChainLookup;
  /** Injectable delegate for tests; defaults to a real ExactAvmScheme. */
  readonly baseScheme?: Pick<SchemeNetworkClient, 'createPaymentPayload'>;
}

function isNotOptedInError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | undefined)?.status;
  return status === 404 || /not\s*found|does not exist|no asset holding/i.test(message);
}

function algodLookup(algorand: AlgorandClient): ChainLookup {
  return {
    async getAssetHolding(address, assetId) {
      try {
        const info = await algorand.asset.getAccountInformation(address, assetId);
        return { optedIn: true, balance: info.balance };
      } catch (err) {
        if (isNotOptedInError(err)) return { optedIn: false, balance: 0n };
        throw err;
      }
    },
    async getAlgoBalance(address) {
      const info = await algorand.account.getInformation(address);
      return { balance: info.balance.microAlgo, minBalance: info.minBalance.microAlgo };
    },
  };
}

/**
 * Resolve the requirements asset to a numeric ASA id (mirrors ExactAvmScheme).
 * The USDC_CONFIG lookup tolerates both CAIP-2 spellings (truncated vs full
 * genesis hash) by prefix-matching keys against the advertised network.
 */
function resolveAssetId(asset: string, network: string): bigint {
  if (/^\d+$/.test(asset)) return BigInt(asset);
  const usdc =
    USDC_CONFIG[network] ??
    Object.entries(USDC_CONFIG).find(
      ([key]) => network.startsWith(key) || key.startsWith(network),
    )?.[1];
  if (usdc !== undefined && /^\d+$/.test(usdc.asaId)) return BigInt(usdc.asaId);
  throw new X402SwapUnavailableError(
    `asset ${JSON.stringify(asset)} on ${network} does not resolve to a numeric ASA id.`,
  );
}

/** Total microAlgos leaving the wallet via payment transactions (the swap input escrow). */
export function totalAlgoInput(txns: readonly Transaction[], sender: string): bigint {
  let total = 0n;
  for (const txn of txns) {
    if (txn.payment !== undefined && txn.sender.toString() === sender) {
      total += txn.payment.amount ?? 0n;
    }
  }
  return total;
}

/** Strip any existing group ids and form one atomic group in the given order. */
export function assembleFundedGroup(txns: readonly Transaction[]): Transaction[] {
  if (txns.length > MAX_TRANSACTION_GROUP_SIZE) {
    throw new X402SwapUnavailableError(
      `funded payment group needs ${txns.length} transactions; the protocol maximum is ${MAX_TRANSACTION_GROUP_SIZE}.`,
    );
  }
  const ungrouped = txns.map((txn) => {
    const { group: _group, ...params } = txn;
    return new Transaction(params);
  });
  return groupTransactions(ungrouped);
}

export class SwapFundingExactAvmScheme implements SchemeNetworkClient {
  readonly scheme = 'exact';
  private readonly base: Pick<SchemeNetworkClient, 'createPaymentPayload'>;

  constructor(
    private readonly signer: ClientAvmSigner,
    private readonly config: ClientAvmConfig | undefined,
    private readonly options: SwapFundingSchemeOptions,
  ) {
    this.base = options.baseScheme ?? new ExactAvmScheme(signer, config);
  }

  private getAlgorandClient(network: string): AlgorandClient {
    // ClientAvmConfig is typed against @x402/avm's own algokit-utils version;
    // the runtime instance is API-compatible for the calls used here.
    if (this.config?.algorandClient) return this.config.algorandClient as unknown as AlgorandClient;
    if (this.config?.algodUrl) {
      return AlgorandClient.fromConfig({
        algodConfig: {
          server: this.config.algodUrl,
          token: this.config.algodToken ?? '',
        },
      });
    }
    return isTestnetCaip2(network) ? AlgorandClient.testNet() : AlgorandClient.mainNet();
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const { amount, payTo, network, asset } = requirements;
    const address = this.signer.address;
    const assetId = resolveAssetId(asset, network);
    const algorand = this.getAlgorandClient(network);
    const lookup = this.options.lookup ?? algodLookup(algorand);

    const holding = await lookup.getAssetHolding(address, assetId);
    const plan = planFunding({ holding, required: BigInt(amount) });
    if (plan.kind === 'direct') {
      return this.base.createPaymentPayload(x402Version, requirements);
    }

    const quote = await this.options.provider.quoteFixedOutput({
      network,
      assetOutId: assetId,
      amountOut: plan.shortfall,
      slippageBps: this.options.swap.slippageBps,
    });
    const swapTxns = await this.options.provider.buildSwapTransactions({
      network,
      sender: address,
      quote,
    });

    const composer = algorand.newGroup();
    const emptySigner = makeEmptyTransactionSigner();
    if (plan.needsOptIn) {
      composer.addAssetOptIn({ sender: address, assetId, signer: emptySigner });
    }
    composer.addAssetTransfer({
      sender: address,
      receiver: payTo,
      assetId,
      amount: BigInt(amount),
      note: `x402-payment-v${x402Version}-${Date.now()}`,
      signer: emptySigner,
    });
    const built = (await composer.build()).transactions.map((tws) => tws.txn);
    const paymentTxn = built[built.length - 1] as Transaction;
    const optInTxn = plan.needsOptIn ? (built[0] as Transaction) : undefined;

    const ordered = [...(optInTxn !== undefined ? [optInTxn] : []), ...swapTxns, paymentTxn];
    const grouped = assembleFundedGroup(ordered);

    // Affordability check against the transactions as actually built: the
    // real ALGO escrow (quote + provider slippage rounding) and the real
    // pooled fees. Not a spend policy — the wallet user approves each
    // transaction — just a fail-fast before any signing request goes out.
    const totalFees = grouped.reduce((sum, txn) => sum + (txn.fee ?? 0n), 0n);
    const algoBalance = await lookup.getAlgoBalance(address);
    const maxAmountIn = totalAlgoInput(swapTxns, address);
    assertSwapAffordable({
      maxAmountIn,
      algo: algoBalance,
      needsOptIn: plan.needsOptIn,
      totalFees,
    });
    this.options.onSwapFunded?.({
      provider: this.options.provider.name,
      assetId: assetId.toString(),
      shortfall: plan.shortfall.toString(),
      maxAlgoInput: maxAmountIn.toString(),
      optedIn: plan.needsOptIn,
    });

    const encodedTxns = grouped.map((txn) => encodeTransactionRaw(txn));
    const signed = await this.signer.signTransactions(
      encodedTxns,
      encodedTxns.map((_txn, i) => i),
    );
    const paymentGroup = signed.map((signedTxn, i) => {
      if (!signedTxn) {
        throw new X402SwapUnavailableError(
          `wallet did not return a signature for transaction ${i + 1} of ${encodedTxns.length}.`,
        );
      }
      return encodeTransaction(signedTxn);
    });

    return {
      x402Version,
      payload: {
        paymentGroup,
        paymentIndex: grouped.length - 1,
      },
    };
  }
}
