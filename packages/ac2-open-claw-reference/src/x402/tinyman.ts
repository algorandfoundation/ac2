/**
 * Tinyman v2 swap provider for x402 swap funding.
 *
 * Quotes and builds fixed-output ALGO -> asset swaps against the Tinyman v2
 * AMM. Fixed-output means the swap delivers exactly the shortfall of the
 * payment asset; excess ALGO input (slippage headroom) is refunded by the pool
 * contract inside the same group. Transactions are converted from algosdk
 * (the Tinyman SDK's dependency) to algokit-utils `Transaction` objects and
 * returned ungrouped so the swap scheme can regroup them with the opt-in and
 * payment transactions.
 */

import {
  poolUtils,
  Swap,
  SwapQuoteType,
  SwapType,
  type SignerTransaction,
  type SupportedNetwork,
  type SwapQuote as TinymanSwapQuote,
  type V2PoolInfo,
} from '@tinymanorg/tinyman-js-sdk';
import { Algodv2, encodeUnsignedTransaction } from 'algosdk';
import {
  decodeTransaction,
  Transaction as AlgokitTransaction,
} from '@algorandfoundation/algokit-utils/transact';

import {
  isTestnetCaip2,
  X402SwapUnavailableError,
  type SwapProvider,
  type SwapQuoteResult,
} from './swap.js';

const ALGO_ASSET_ID = 0;
const ALGO_DECIMALS = 6;
const BPS_DENOMINATOR = 10_000n;
/**
 * Tinyman rejects swaps where either leg is below ceil(1/0.003) = 334 atomic
 * units (`LowSwapAmountError`: the 0.3% pool fee would round to zero; the SDK
 * does not export the constant). Payments can legitimately be smaller — the
 * weather demo charges 1000 µUSDC (~125 µALGO of input) — so the requested
 * output is rounded up front to a floor that clears both legs, computed from
 * the pool reserves; the surplus stays in the wallet. Each quote call is a
 * network round trip (the SDK consults Tinyman's router API), so the floor is
 * computed locally and the doubling retry below is only a fallback for a
 * stale-reserves miss or a changed threshold. 2^20 bounds the growth at ~1M×.
 */
const MIN_SWAP_LEG = 334n;
const MAX_LOW_AMOUNT_DOUBLINGS = 20;

/**
 * Smallest fixed-output amount that keeps both swap legs above Tinyman's
 * minimum: the output itself, and the ALGO input implied by the pool price
 * (reserves ratio) with a 10% margin for fees and rounding.
 */
function minimumViableOutput(pool: V2PoolInfo, assetOutId: bigint): bigint {
  const outIsAsset1 = pool.asset1ID === Number(assetOutId);
  const outReserve = outIsAsset1 ? pool.asset1Reserves : pool.asset2Reserves;
  const algoReserve = outIsAsset1 ? pool.asset2Reserves : pool.asset1Reserves;
  let floor = MIN_SWAP_LEG;
  if (outReserve !== undefined && algoReserve !== undefined && algoReserve > 0n) {
    const fromInputLeg = (MIN_SWAP_LEG * outReserve * 11n) / (algoReserve * 10n) + 1n;
    if (fromInputLeg > floor) floor = fromInputLeg;
  }
  return floor;
}

function isLowSwapAmountError(err: unknown): boolean {
  return (
    (err as { type?: string } | undefined)?.type === 'LowSwapAmountError' ||
    (err instanceof Error && /swap amount is too low/i.test(err.message))
  );
}

/** Per-network Algod overrides; unset networks fall back to AlgoNode. */
export interface TinymanSwapProviderOptions {
  readonly testnet?: { readonly algodUrl?: string; readonly algodToken?: string };
  readonly mainnet?: { readonly algodUrl?: string; readonly algodToken?: string };
}

function defaultAlgodUrl(network: SupportedNetwork): string {
  return `https://${network}-api.algonode.cloud`;
}

function toTinymanNetwork(caip2Network: string): SupportedNetwork {
  return isTestnetCaip2(caip2Network) ? 'testnet' : 'mainnet';
}

/** Worst-case input escrowed for a fixed-output swap: quote plus slippage, rounded up. */
function withSlippage(amountIn: bigint, slippageBps: number): bigint {
  const slip = (amountIn * BigInt(slippageBps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  return amountIn + slip;
}

function quoteAmounts(quote: TinymanSwapQuote): { amountIn: bigint; amountOut: bigint } {
  if (quote.type === SwapQuoteType.Direct) {
    return {
      amountIn: quote.data.quote.assetInAmount,
      amountOut: quote.data.quote.assetOutAmount,
    };
  }
  return {
    amountIn: BigInt(quote.data.input_amount),
    amountOut: BigInt(quote.data.output_amount),
  };
}

export class TinymanSwapProvider implements SwapProvider {
  readonly name = 'tinyman-v2';

  constructor(private readonly options: TinymanSwapProviderOptions = {}) {}

  private getClient(network: SupportedNetwork): Algodv2 {
    const overrides = this.options[network];
    return new Algodv2(
      overrides?.algodToken ?? '',
      overrides?.algodUrl ?? defaultAlgodUrl(network),
    );
  }

  private async getAssetDecimals(client: Algodv2, assetId: bigint): Promise<number> {
    if (assetId === BigInt(ALGO_ASSET_ID)) return ALGO_DECIMALS;
    try {
      const asset = await client.getAssetByID(Number(assetId)).do();
      const decimals = asset.params?.decimals;
      if (decimals === undefined) {
        throw new Error('asset params missing decimals');
      }
      return Number(decimals);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new X402SwapUnavailableError(`unable to look up asset ${assetId}: ${msg}`);
    }
  }

  async quoteFixedOutput(args: {
    network: string;
    assetOutId: bigint;
    amountOut: bigint;
    slippageBps: number;
  }): Promise<SwapQuoteResult> {
    const { assetOutId, amountOut, slippageBps } = args;
    if (assetOutId === BigInt(ALGO_ASSET_ID)) {
      throw new X402SwapUnavailableError('cannot swap ALGO for ALGO.');
    }
    const network = toTinymanNetwork(args.network);
    const client = this.getClient(network);
    const decimals = await this.getAssetDecimals(client, assetOutId);

    let quote: TinymanSwapQuote;
    try {
      const pool = await poolUtils.v2.getPoolInfo({
        client,
        network,
        asset1ID: Number(assetOutId),
        asset2ID: ALGO_ASSET_ID,
      });
      if (!poolUtils.isPoolReady(pool)) {
        throw new Error(`no ready Tinyman v2 ALGO pool for asset ${assetOutId} on ${network}.`);
      }
      const outputFloor = minimumViableOutput(pool, assetOutId);
      let effectiveAmountOut = amountOut > outputFloor ? amountOut : outputFloor;
      for (let attempt = 0; ; attempt++) {
        try {
          quote = await Swap.v2.getFixedOutputSwapQuote({
            amount: effectiveAmountOut,
            assetIn: { id: ALGO_ASSET_ID, decimals: ALGO_DECIMALS },
            assetOut: { id: Number(assetOutId), decimals },
            pool,
            network,
            slippage: slippageBps / Number(BPS_DENOMINATOR),
          });
          break;
        } catch (err) {
          if (!isLowSwapAmountError(err) || attempt >= MAX_LOW_AMOUNT_DOUBLINGS) throw err;
          effectiveAmountOut *= 2n;
        }
      }
    } catch (err) {
      if (err instanceof X402SwapUnavailableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new X402SwapUnavailableError(
        `Tinyman quote for ${amountOut} of asset ${assetOutId} failed: ${msg}`,
      );
    }

    const amounts = quoteAmounts(quote);
    return {
      provider: this.name,
      assetInId: BigInt(ALGO_ASSET_ID),
      assetOutId,
      amountOut: amounts.amountOut,
      amountIn: amounts.amountIn,
      maxAmountIn: withSlippage(amounts.amountIn, slippageBps),
      raw: { quote, slippageBps },
    };
  }

  async buildSwapTransactions(args: {
    network: string;
    sender: string;
    quote: SwapQuoteResult;
  }): Promise<AlgokitTransaction[]> {
    const { sender } = args;
    const raw = args.quote.raw as { quote: TinymanSwapQuote; slippageBps: number } | undefined;
    if (raw?.quote === undefined) {
      throw new X402SwapUnavailableError('quote is missing the Tinyman payload; re-quote first.');
    }
    const network = toTinymanNetwork(args.network);
    const client = this.getClient(network);

    let txGroup: SignerTransaction[];
    try {
      txGroup = await Swap.v2.generateTxns({
        client,
        network,
        quote: raw.quote,
        swapType: SwapType.FixedOutput,
        slippage: raw.slippageBps / Number(BPS_DENOMINATOR),
        initiatorAddr: sender,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new X402SwapUnavailableError(`Tinyman swap transaction build failed: ${msg}`);
    }

    return txGroup.map(({ txn, signers }, index) => {
      const txnSender = txn.sender.toString();
      if (txnSender !== sender) {
        throw new X402SwapUnavailableError(
          `Tinyman swap transaction ${index + 1} has sender ${txnSender}; expected the paying wallet ${sender}.`,
        );
      }
      if (signers !== undefined && !signers.includes(sender)) {
        throw new X402SwapUnavailableError(
          `Tinyman swap transaction ${index + 1} requires signers ${JSON.stringify(signers)}; ` +
            `only the paying wallet can sign x402 group transactions.`,
        );
      }
      const { group: _group, ...params } = decodeTransaction(encodeUnsignedTransaction(txn));
      return new AlgokitTransaction(params);
    });
  }
}
