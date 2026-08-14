/**
 * Swap funding for x402 payments.
 *
 * When the paying wallet lacks the required ASA (not opted in, or balance below
 * the requested amount), the payment can still settle atomically by prepending
 * an asset opt-in and a DEX swap (ALGO -> asset) to the same transaction group
 * as the x402 payment. The facilitator only pins the transaction at
 * `paymentIndex` and simulates the whole group, so extra wallet-signed
 * transactions are accepted.
 */

import type { Transaction } from '@algorandfoundation/algokit-utils/transact';

/** Raise in the wallet's minimum balance requirement caused by an asset opt-in. */
export const ASSET_OPT_IN_MBR = 100_000n;

const ALGORAND_TESTNET_GENESIS_PREFIX = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe';

/**
 * TestNet check tolerant of both CAIP-2 spellings: the 32-char truncated form
 * (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`) and the full 44-char genesis
 * hash some resources and older `@x402/avm` builds advertise. `@x402/avm`'s
 * own `isTestnetNetwork` is an exact compare against one spelling only.
 */
export function isTestnetCaip2(network: string): boolean {
  return network.includes(ALGORAND_TESTNET_GENESIS_PREFIX);
}

/**
 * Effective swap-funding settings resolved from tool params + plugin config.
 * Swap funding is not gated by any toggle or spend ceiling: every transaction
 * in the group is individually acknowledged and signed by the wallet user,
 * and that approval is the guardrail.
 */
export interface SwapFundingOptions {
  /** Slippage tolerance in basis points (100 = 1%). */
  readonly slippageBps: number;
}

export interface AssetHoldingInfo {
  readonly optedIn: boolean;
  readonly balance: bigint;
}

export interface AlgoBalanceInfo {
  /** Total microAlgos held. */
  readonly balance: bigint;
  /** Current minimum balance requirement in microAlgos. */
  readonly minBalance: bigint;
}

/** Chain reads the swap scheme needs; injectable for tests. */
export interface ChainLookup {
  getAssetHolding(address: string, assetId: bigint): Promise<AssetHoldingInfo>;
  getAlgoBalance(address: string): Promise<AlgoBalanceInfo>;
}

/** Provider-agnostic fixed-output quote (buy exactly `amountOut` of the asset). */
export interface SwapQuoteResult {
  readonly provider: string;
  /** Input asset id; 0 = ALGO. */
  readonly assetInId: bigint;
  readonly assetOutId: bigint;
  /** Exact output amount the swap delivers. */
  readonly amountOut: bigint;
  /** Quoted input amount before slippage. */
  readonly amountIn: bigint;
  /** Worst-case input amount actually escrowed (quote + slippage). */
  readonly maxAmountIn: bigint;
  /** Provider-specific quote payload reused by buildSwapTransactions. */
  readonly raw?: unknown;
}

/** DEX integration surface. Implementations must return ungrouped transactions. */
export interface SwapProvider {
  readonly name: string;
  quoteFixedOutput(args: {
    /** CAIP-2 Algorand network from the payment requirements. */
    network: string;
    assetOutId: bigint;
    amountOut: bigint;
    slippageBps: number;
  }): Promise<SwapQuoteResult>;
  /**
   * Build the swap transactions for a previously obtained quote. Every
   * transaction must have `sender` and be ungrouped (group id unset) so the
   * caller can regroup them with the opt-in and payment transactions.
   */
  buildSwapTransactions(args: {
    network: string;
    sender: string;
    quote: SwapQuoteResult;
  }): Promise<Transaction[]>;
}

export class X402SwapUnavailableError extends Error {
  readonly code = 'x402_swap_unavailable' as const;
  constructor(detail: string) {
    super(`x402 swap funding unavailable: ${detail}`);
    this.name = 'X402SwapUnavailableError';
  }
}

export class X402SwapInsufficientAlgoError extends Error {
  readonly code = 'x402_swap_insufficient_algo' as const;
  constructor(detail: string) {
    super(`x402 swap funding cannot be covered by the wallet: ${detail}`);
    this.name = 'X402SwapInsufficientAlgoError';
  }
}

export type FundingPlan =
  | { readonly kind: 'direct' }
  | { readonly kind: 'swap'; readonly needsOptIn: boolean; readonly shortfall: bigint };

/** What a swap-funded payment did, for surfacing in tool results. */
export interface SwapFundingInfo {
  readonly provider: string;
  readonly assetId: string;
  /** Asset atomic units the swap delivered (the wallet's shortfall). */
  readonly shortfall: string;
  /** Worst-case microAlgos escrowed as swap input (unused input is refunded). */
  readonly maxAlgoInput: string;
  /** Whether an asset opt-in was included in the group. */
  readonly optedIn: boolean;
}

/**
 * Decide how to fund the payment. Returns `direct` when the wallet already
 * holds enough of the asset; otherwise a swap plan for the shortfall.
 */
export function planFunding(args: {
  holding: AssetHoldingInfo;
  required: bigint;
}): FundingPlan {
  const { holding, required } = args;
  if (holding.optedIn && holding.balance >= required) {
    return { kind: 'direct' };
  }
  return {
    kind: 'swap',
    needsOptIn: !holding.optedIn,
    shortfall: required - holding.balance,
  };
}

/**
 * Pre-flight affordability check, not a spend policy: if the wallet cannot
 * cover the worst-case swap input plus fees and the opt-in MBR bump, the
 * group is guaranteed to fail facilitator simulation — error out before
 * asking the user to sign anything.
 */
export function assertSwapAffordable(args: {
  /** Worst-case microAlgos escrowed as swap input (from the built transactions). */
  maxAmountIn: bigint;
  algo: AlgoBalanceInfo;
  needsOptIn: boolean;
  totalFees: bigint;
}): void {
  const { maxAmountIn, algo, needsOptIn, totalFees } = args;
  const mbrBump = needsOptIn ? ASSET_OPT_IN_MBR : 0n;
  const spendable = algo.balance - algo.minBalance - mbrBump - totalFees;
  if (spendable < maxAmountIn) {
    throw new X402SwapInsufficientAlgoError(
      `wallet has ${spendable > 0n ? spendable : 0n} spendable microAlgos after the minimum ` +
        `balance requirement, fees (${totalFees}), and opt-in reserve (${mbrBump}), but the ` +
        `swap needs up to ${maxAmountIn}.`,
    );
  }
}

/** Validate and normalize a slippage setting expressed in basis points. */
export function normalizeSlippageBps(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 5_000) {
    throw new X402SwapUnavailableError(
      `slippage must be an integer between 0 and 5000 basis points, got ${value}.`,
    );
  }
  return value;
}
