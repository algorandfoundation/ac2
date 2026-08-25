/** x402 integration helpers for the AC2 OpenClaw reference plugin. */

export {
  decodeTransactionGroupPayload,
  encodeTransactionGroupPayload,
  X402_ALGORAND_GROUP_SIGNING_SCHEMA,
  X402_ALGORAND_SIGNING_SCHEMA,
  X402ControllerAddressError,
  X402SigningRejectedError,
  classifyX402SigningError,
  controllerDidToAlgorandAddress,
  createAc2AvmSigner,
  type Ac2AvmSignerOptions,
  type X402PaymentContext,
} from './ac2-avm-signer.js';
export {
  normalizeX402FetchParams,
  x402FetchFlow,
  type X402FetchParams,
  type X402FetchResult,
  type X402PaymentSelection,
} from './fetch-flow.js';
export {
  assertSwapAffordable,
  planFunding,
  X402SwapInsufficientAlgoError,
  X402SwapUnavailableError,
  type AlgoBalanceInfo,
  type AssetHoldingInfo,
  type ChainLookup,
  type FundingPlan,
  type SwapFundingInfo,
  type SwapFundingOptions,
  type SwapProvider,
  type SwapQuoteResult,
} from './swap.js';
export {
  SwapFundingExactAvmScheme,
  type SwapFundingSchemeOptions,
} from './swap-scheme.js';
export { TinymanSwapProvider, type TinymanSwapProviderOptions } from './tinyman.js';
