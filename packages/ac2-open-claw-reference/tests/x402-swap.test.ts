import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { Address } from '@algorandfoundation/algokit-utils/common';
import {
  decodeSignedTransaction,
  decodeTransaction,
  encodeSignedTransaction,
  OnApplicationComplete,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import type { ClientAvmSigner } from '@x402/avm';
import type { PaymentRequirements } from '@x402/core/types';

import {
  assertSwapAffordable,
  normalizeSlippageBps,
  planFunding,
  X402SwapInsufficientAlgoError,
  X402SwapUnavailableError,
  type ChainLookup,
  type SwapFundingOptions,
  type SwapProvider,
  type SwapQuoteResult,
} from '../src/x402/swap.js';
import {
  assembleFundedGroup,
  SwapFundingExactAvmScheme,
  totalAlgoInput,
} from '../src/x402/swap-scheme.js';
import { normalizeX402FetchParams, resolveAlgodConfig } from '../src/x402/fetch-flow.js';

const SENDER = new Address(new Uint8Array(32).fill(1));
const RECEIVER = new Address(new Uint8Array(32).fill(2));
const POOL = new Address(new Uint8Array(32).fill(7));
const GENESIS_HASH = new Uint8Array(32).fill(3);
const TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe';
const USDC_TESTNET = 10458941n;

function baseTxnFields() {
  return {
    sender: SENDER,
    fee: 1_000n,
    firstValid: 1n,
    lastValid: 1_000n,
    genesisHash: GENESIS_HASH,
  };
}

function paymentTxn(amount: bigint, receiver: Address = POOL): Transaction {
  return new Transaction({
    ...baseTxnFields(),
    type: TransactionType.Payment,
    payment: { receiver, amount },
  });
}

function appCallTxn(appId: bigint): Transaction {
  return new Transaction({
    ...baseTxnFields(),
    fee: 2_000n,
    type: TransactionType.AppCall,
    appCall: { appId, onComplete: OnApplicationComplete.NoOp },
  });
}

function assetTransferTxn(assetId: bigint, amount: bigint, receiver: Address): Transaction {
  return new Transaction({
    ...baseTxnFields(),
    type: TransactionType.AssetTransfer,
    assetTransfer: { assetId, amount, receiver },
  });
}

const defaultSwapOptions: SwapFundingOptions = {
  slippageBps: 100,
};

describe('planFunding', () => {
  it('funds directly when the wallet holds enough of the asset', () => {
    const plan = planFunding({
      holding: { optedIn: true, balance: 2_000_000n },
      required: 1_000_000n,
    });
    expect(plan).toEqual({ kind: 'direct' });
  });

  it('plans an opt-in and full-amount swap when not opted in', () => {
    const plan = planFunding({
      holding: { optedIn: false, balance: 0n },
      required: 1_000_000n,
    });
    expect(plan).toEqual({ kind: 'swap', needsOptIn: true, shortfall: 1_000_000n });
  });

  it('swaps only the shortfall when partially funded', () => {
    const plan = planFunding({
      holding: { optedIn: true, balance: 750_000n },
      required: 1_000_000n,
    });
    expect(plan).toEqual({ kind: 'swap', needsOptIn: false, shortfall: 250_000n });
  });
});

describe('assertSwapAffordable', () => {
  const algo = { balance: 20_000_000n, minBalance: 100_000n };

  it('passes when the swap fits the spendable balance', () => {
    expect(() =>
      assertSwapAffordable({
        maxAmountIn: 5_000_000n,
        algo,
        needsOptIn: true,
        totalFees: 5_000n,
      }),
    ).not.toThrow();
  });

  it('has no spend ceiling — a large swap passes if the wallet can cover it', () => {
    expect(() =>
      assertSwapAffordable({
        maxAmountIn: 19_000_000n,
        algo,
        needsOptIn: false,
        totalFees: 5_000n,
      }),
    ).not.toThrow();
  });

  it('rejects when spendable ALGO after MBR, fees, and opt-in reserve is short', () => {
    expect(() =>
      assertSwapAffordable({
        maxAmountIn: 5_000_000n,
        algo: { balance: 5_200_000n, minBalance: 100_000n },
        needsOptIn: true,
        totalFees: 5_000n,
      }),
    ).toThrow(X402SwapInsufficientAlgoError);
  });
});

describe('normalizeSlippageBps', () => {
  it('accepts sane values and rejects nonsense', () => {
    expect(normalizeSlippageBps(100)).toBe(100);
    expect(normalizeSlippageBps(0)).toBe(0);
    expect(() => normalizeSlippageBps(-1)).toThrow(X402SwapUnavailableError);
    expect(() => normalizeSlippageBps(5_001)).toThrow(X402SwapUnavailableError);
    expect(() => normalizeSlippageBps(1.5)).toThrow(X402SwapUnavailableError);
  });
});

describe('totalAlgoInput', () => {
  it('sums only ALGO payments sent by the wallet', () => {
    const txns = [
      paymentTxn(3_000_000n),
      appCallTxn(148_607_000n),
      assetTransferTxn(USDC_TESTNET, 1_000_000n, RECEIVER),
    ];
    expect(totalAlgoInput(txns, SENDER.toString())).toBe(3_000_000n);
    expect(totalAlgoInput(txns, RECEIVER.toString())).toBe(0n);
  });
});

describe('assembleFundedGroup', () => {
  it('strips prior group ids, preserves order, and assigns one shared group', () => {
    const preGrouped = new Transaction({
      ...baseTxnFields(),
      type: TransactionType.Payment,
      payment: { receiver: POOL, amount: 3_000_000n },
      group: new Uint8Array(32).fill(9),
    });
    const txns = [
      assetTransferTxn(USDC_TESTNET, 0n, SENDER),
      preGrouped,
      appCallTxn(148_607_000n),
      assetTransferTxn(USDC_TESTNET, 1_000_000n, RECEIVER),
    ];
    const grouped = assembleFundedGroup(txns);

    expect(grouped).toHaveLength(4);
    const groupId = grouped[0]?.group;
    expect(groupId).toBeInstanceOf(Uint8Array);
    expect(groupId).toHaveLength(32);
    expect(Buffer.from(groupId as Uint8Array).equals(Buffer.from(new Uint8Array(32).fill(9)))).toBe(
      false,
    );
    for (const txn of grouped) {
      expect(Buffer.from(txn.group as Uint8Array).equals(Buffer.from(groupId as Uint8Array))).toBe(
        true,
      );
    }
    expect(grouped[0]?.assetTransfer?.amount ?? 0n).toBe(0n);
    expect(grouped[1]?.payment?.amount).toBe(3_000_000n);
    expect(grouped[2]?.appCall?.appId).toBe(148_607_000n);
    expect(grouped[3]?.assetTransfer?.receiver.toString()).toBe(RECEIVER.toString());
  });

  it('rejects groups above the protocol maximum of 16', () => {
    const txns = Array.from({ length: 17 }, () => paymentTxn(1n));
    expect(() => assembleFundedGroup(txns)).toThrow(X402SwapUnavailableError);
  });
});

describe('SwapFundingExactAvmScheme', () => {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: TESTNET_CAIP2 as PaymentRequirements['network'],
    asset: USDC_TESTNET.toString(),
    amount: '1000000',
    payTo: RECEIVER.toString(),
    maxTimeoutSeconds: 60,
    extra: {},
  };

  function fakeSigner(signedIndexes: number[] = []): ClientAvmSigner {
    return {
      address: SENDER.toString(),
      async signTransactions(txns: Uint8Array[], indexesToSign?: number[]) {
        signedIndexes.push(...(indexesToSign ?? txns.map((_t, i) => i)));
        return txns.map((bytes, i) => {
          if (indexesToSign !== undefined && !indexesToSign.includes(i)) return null;
          return encodeSignedTransaction({
            txn: decodeTransaction(bytes),
            sig: new Uint8Array(64).fill(i + 1),
          });
        });
      },
    } as unknown as ClientAvmSigner;
  }

  function fundedLookup(): ChainLookup {
    return {
      getAssetHolding: async () => ({ optedIn: true, balance: 5_000_000n }),
      getAlgoBalance: async () => ({ balance: 50_000_000n, minBalance: 100_000n }),
    };
  }

  function unfundedLookup(): ChainLookup {
    return {
      getAssetHolding: async () => ({ optedIn: false, balance: 0n }),
      getAlgoBalance: async () => ({ balance: 50_000_000n, minBalance: 100_000n }),
    };
  }

  function fakeProvider(swapTxns: Transaction[], calls: string[] = []): SwapProvider {
    return {
      name: 'fake-dex',
      async quoteFixedOutput(args) {
        calls.push(`quote:${args.amountOut}`);
        const quote: SwapQuoteResult = {
          provider: 'fake-dex',
          assetInId: 0n,
          assetOutId: args.assetOutId,
          amountOut: args.amountOut,
          amountIn: 2_970_000n,
          maxAmountIn: 3_000_000n,
          raw: { marker: true },
        };
        return quote;
      },
      async buildSwapTransactions(args) {
        calls.push(`build:${args.sender}`);
        return swapTxns;
      },
    };
  }

  it('delegates to the base scheme when the wallet is already funded', async () => {
    const providerCalls: string[] = [];
    const marker = { x402Version: 2, payload: { paymentGroup: ['base'], paymentIndex: 0 } };
    const scheme = new SwapFundingExactAvmScheme(fakeSigner(), undefined, {
      provider: fakeProvider([], providerCalls),
      swap: defaultSwapOptions,
      lookup: fundedLookup(),
      baseScheme: { createPaymentPayload: async () => marker },
    });

    const result = await scheme.createPaymentPayload(2, requirements);
    expect(result).toBe(marker);
    expect(providerCalls).toEqual([]);
  });

  it('builds an opt-in + swap + payment group with paymentIndex last', async () => {
    const providerCalls: string[] = [];
    const signedIndexes: number[] = [];
    const swapFundingEvents: unknown[] = [];
    const swapTxns = [paymentTxn(3_000_000n), appCallTxn(148_607_000n)];
    const optIn = assetTransferTxn(USDC_TESTNET, 0n, SENDER);
    const payment = assetTransferTxn(USDC_TESTNET, 1_000_000n, RECEIVER);

    const fakeComposer = {
      adds: [] as string[],
      addAssetOptIn(_params: unknown) {
        this.adds.push('optin');
        return this;
      },
      addAssetTransfer(_params: unknown) {
        this.adds.push('transfer');
        return this;
      },
      async build() {
        const txns = [...(this.adds.includes('optin') ? [optIn] : []), payment];
        return { transactions: txns.map((txn) => ({ txn })) };
      },
    };
    const fakeAlgorand = { newGroup: () => fakeComposer };

    const scheme = new SwapFundingExactAvmScheme(
      fakeSigner(signedIndexes),
      { algorandClient: fakeAlgorand as never },
      {
        provider: fakeProvider(swapTxns, providerCalls),
        swap: defaultSwapOptions,
        lookup: unfundedLookup(),
        onSwapFunded: (info) => swapFundingEvents.push(info),
        baseScheme: {
          createPaymentPayload: async () => {
            throw new Error('base scheme must not be called');
          },
        },
      },
    );

    const result = await scheme.createPaymentPayload(2, requirements);
    const payload = result.payload as { paymentGroup: string[]; paymentIndex: number };

    expect(providerCalls).toEqual([`quote:${1_000_000n}`, `build:${SENDER.toString()}`]);
    expect(payload.paymentGroup).toHaveLength(4);
    expect(payload.paymentIndex).toBe(3);
    expect(signedIndexes).toEqual([0, 1, 2, 3]);
    expect(swapFundingEvents).toEqual([
      {
        provider: 'fake-dex',
        assetId: USDC_TESTNET.toString(),
        shortfall: '1000000',
        maxAlgoInput: '3000000',
        optedIn: true,
      },
    ]);

    const decoded = payload.paymentGroup.map((b64) =>
      decodeSignedTransaction(new Uint8Array(Buffer.from(b64, 'base64'))),
    );
    // Order: opt-in, swap input payment, swap app call, x402 payment.
    expect(decoded[0]?.txn.assetTransfer?.amount ?? 0n).toBe(0n);
    expect(decoded[0]?.txn.assetTransfer?.receiver.toString()).toBe(SENDER.toString());
    expect(decoded[1]?.txn.payment?.amount).toBe(3_000_000n);
    expect(decoded[2]?.txn.appCall?.appId).toBe(148_607_000n);
    const paymentDecoded = decoded[3]?.txn;
    expect(paymentDecoded?.assetTransfer?.assetId).toBe(USDC_TESTNET);
    expect(paymentDecoded?.assetTransfer?.amount).toBe(1_000_000n);
    expect(paymentDecoded?.assetTransfer?.receiver.toString()).toBe(RECEIVER.toString());
    // Every transaction is signed and shares one group id.
    const groupId = decoded[0]?.txn.group;
    for (const stxn of decoded) {
      expect(stxn.sig).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(stxn.txn.group as Uint8Array)).toEqual(
        Buffer.from(groupId as Uint8Array),
      );
    }
  });

  it('rejects before signing when the wallet cannot cover the actual escrowed input', async () => {
    const swapTxns = [paymentTxn(60_000_000n), appCallTxn(148_607_000n)];
    const optIn = assetTransferTxn(USDC_TESTNET, 0n, SENDER);
    const payment = assetTransferTxn(USDC_TESTNET, 1_000_000n, RECEIVER);
    const fakeAlgorand = {
      newGroup: () => ({
        addAssetOptIn() {
          return this;
        },
        addAssetTransfer() {
          return this;
        },
        async build() {
          return { transactions: [{ txn: optIn }, { txn: payment }] };
        },
      }),
    };

    const scheme = new SwapFundingExactAvmScheme(
      fakeSigner(),
      { algorandClient: fakeAlgorand as never },
      {
        provider: fakeProvider(swapTxns),
        swap: defaultSwapOptions,
        lookup: unfundedLookup(), // 50 ALGO balance < 60 ALGO escrow
      },
    );

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      X402SwapInsufficientAlgoError,
    );
  });
});

describe('normalizeX402FetchParams swap params', () => {
  it('passes through swap params and drops malformed ones', () => {
    const params = normalizeX402FetchParams({
      url: 'https://example.com',
      swap_slippage_bps: 50,
    });
    expect(params.swap_slippage_bps).toBe(50);

    const dropped = normalizeX402FetchParams({
      url: 'https://example.com',
      swap_slippage_bps: '50',
    });
    expect(dropped.swap_slippage_bps).toBeUndefined();
  });
});

describe('resolveAlgodConfig', () => {
  const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';

  it('scopes network-specific overrides to their own network', () => {
    const config = {
      x402TestnetAlgodUrl: 'https://my-testnet-node',
      x402TestnetAlgodToken: 'ttok',
    };
    expect(resolveAlgodConfig(TESTNET_CAIP2, config)).toEqual({
      algodUrl: 'https://my-testnet-node',
      algodToken: 'ttok',
    });
    // MainNet must NOT inherit the testnet override.
    expect(resolveAlgodConfig(MAINNET_CAIP2, config)).toEqual({});
  });

  it('applies scoped overrides over the legacy global keys, per network', () => {
    const config = {
      x402AlgodUrl: 'https://global-node',
      x402MainnetAlgodUrl: 'https://my-mainnet-node',
    };
    expect(resolveAlgodConfig(MAINNET_CAIP2, config)).toEqual({
      algodUrl: 'https://my-mainnet-node',
    });
    expect(resolveAlgodConfig(TESTNET_CAIP2, config)).toEqual({
      algodUrl: 'https://global-node',
    });
  });

  it('accepts the full-genesis-hash CAIP-2 spelling', () => {
    const config = { x402TestnetAlgodUrl: 'https://my-testnet-node' };
    expect(
      resolveAlgodConfig('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', config),
    ).toEqual({ algodUrl: 'https://my-testnet-node' });
  });
});
