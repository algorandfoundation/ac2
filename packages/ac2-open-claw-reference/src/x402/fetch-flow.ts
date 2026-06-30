/** Paid HTTP fetch flow for x402 exact payments on Algorand. */

import { Buffer } from 'node:buffer';

import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  isAlgorandNetwork,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402/avm';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import {
  wrapFetchWithPayment,
  x402Client,
  x402HTTPClient,
  type PaymentPolicy,
  type PaymentRequired,
  type PaymentRequirements,
  type SelectPaymentRequirements,
} from '@x402/fetch';
import type { PaymentPayload, ResourceInfo, SettleResponse } from '@x402/core/types';
import type { Network } from '@x402/core/types';

import type { PluginConfig, ToolContext } from '../session/contracts.js';
import type { SignDeps } from '../session/flows.js';
import { NoActiveSessionError } from '../session/manager.js';
import {
  classifyX402SigningError,
  createAc2AvmSigner,
  type X402PaymentContext,
} from './ac2-avm-signer.js';

const DEFAULT_MAX_AMOUNT_ATOMIC = '1000000';
const DEFAULT_ALLOWED_NETWORKS = [ALGORAND_TESTNET_CAIP2, ALGORAND_MAINNET_CAIP2] as const;
const DEFAULT_ALLOWED_ASSETS = [USDC_TESTNET_ASA_ID, USDC_MAINNET_ASA_ID, 'USDC'] as const;
const RESPONSE_BODY_LIMIT_BYTES = 128 * 1024;

export interface X402FetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  body_base64?: string;
  max_amount_atomic?: string;
  allowed_networks?: string[];
  allowed_assets?: string[];
  allowed_pay_to?: string[];
  network_preferences?: string[];
  include_response_body?: boolean;
}

export interface X402PaymentSelection {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly resource?: ResourceInfo;
}

export type X402FetchResult =
  | {
      status: 'paid' | 'http_error';
      url: string;
      http: {
        status: number;
        ok: boolean;
        statusText: string;
        contentType?: string;
      };
      selectedPayment?: X402PaymentSelection;
      paymentPayload?: PaymentPayload;
      settlement?: SettleResponse;
      bodyText?: string;
      bodyJson?: unknown;
    }
  | {
      status: 'payment_required';
      url: string;
      paymentRequired?: PaymentRequired;
      reason: string;
    }
  | {
      status: 'rejected';
      url: string;
      reason: string;
    }
  | {
      status: 'error';
      url: string;
      error: string;
    };

interface PolicyOptions {
  readonly maxAmountAtomic: bigint;
  readonly allowedNetworks: ReadonlySet<string>;
  readonly allowedAssets: ReadonlySet<string>;
  readonly allowedPayTo?: ReadonlySet<string>;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function configStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

function resolveAllowedNetworks(params: X402FetchParams, config: PluginConfig): string[] {
  return uniqueStrings(
    params.allowed_networks ??
      config.x402AllowedNetworks ??
      (DEFAULT_ALLOWED_NETWORKS as readonly string[]),
  );
}

function resolveAllowedAssets(params: X402FetchParams, config: PluginConfig): string[] {
  return uniqueStrings(
    params.allowed_assets ?? config.x402AllowedAssets ?? (DEFAULT_ALLOWED_ASSETS as readonly string[]),
  );
}

function resolveAllowedPayTo(params: X402FetchParams, config: PluginConfig): string[] | undefined {
  const values = params.allowed_pay_to ?? config.x402AllowedPayTo;
  return values ? uniqueStrings(values) : undefined;
}

function resolveMaxAmount(params: X402FetchParams, config: PluginConfig): bigint {
  const raw = params.max_amount_atomic ?? config.x402MaxAmountAtomic ?? DEFAULT_MAX_AMOUNT_ATOMIC;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`max_amount_atomic must be an unsigned integer string, got ${JSON.stringify(raw)}.`);
  }
  return BigInt(raw);
}

function buildPaymentPolicy(options: PolicyOptions): PaymentPolicy {
  return (_version, requirements) =>
    requirements.filter((req) => {
      if (req.scheme !== 'exact') return false;
      if (!isAlgorandNetwork(req.network)) return false;
      if (!options.allowedNetworks.has(req.network)) return false;
      if (!options.allowedAssets.has(req.asset)) return false;
      try {
        if (BigInt(req.amount) > options.maxAmountAtomic) return false;
      } catch {
        return false;
      }
      if (options.allowedPayTo && !options.allowedPayTo.has(req.payTo)) return false;
      return true;
    });
}

function buildSelector(preferences: readonly string[]): SelectPaymentRequirements {
  const preferred = uniqueStrings(preferences);
  return (_version, requirements) => {
    for (const network of preferred) {
      const match = requirements.find((req) => req.network === network);
      if (match) return match;
    }
    return requirements[0] as PaymentRequirements;
  };
}

function createRequestInit(params: X402FetchParams, context: ToolContext): RequestInit {
  if (params.body !== undefined && params.body_base64 !== undefined) {
    throw new Error('Pass either body or body_base64, not both.');
  }

  const method = (params.method ?? (params.body || params.body_base64 ? 'POST' : 'GET')).toUpperCase();
  const init: RequestInit = { method };
  if (params.headers !== undefined) init.headers = params.headers;
  if (context.signal !== undefined) init.signal = context.signal;
  if (params.body !== undefined) {
    init.body = params.body;
  } else if (params.body_base64 !== undefined) {
    init.body = Buffer.from(params.body_base64, 'base64');
  }
  return init;
}

function selectedPaymentFromContext(
  x402Version: number,
  requirements: PaymentRequirements,
  resource?: ResourceInfo,
): X402PaymentSelection {
  return {
    x402Version,
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
    ...(resource !== undefined ? { resource } : {}),
  };
}

function parseSettleResponse(httpClient: x402HTTPClient, response: Response): SettleResponse | undefined {
  try {
    return httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch {
    return undefined;
  }
}

async function readResponseBody(
  response: Response,
  includeBody: boolean,
): Promise<{ bodyText?: string; bodyJson?: unknown }> {
  if (!includeBody) return {};
  const cloned = response.clone();
  const bytes = new Uint8Array(await cloned.arrayBuffer());
  const limited = bytes.subarray(0, RESPONSE_BODY_LIMIT_BYTES);
  const suffix = bytes.length > RESPONSE_BODY_LIMIT_BYTES ? '\n[truncated]' : '';
  const bodyText = Buffer.from(limited).toString('utf8') + suffix;
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.toLowerCase().includes('json') && bodyText.length > 0 && !suffix) {
    try {
      return { bodyText, bodyJson: JSON.parse(bodyText) };
    } catch {
      return { bodyText };
    }
  }
  return { bodyText };
}

function isPaymentRequiredResponse(response: Response): boolean {
  return response.status === 402;
}

function paymentRequiredFromResponse(
  httpClient: x402HTTPClient,
  response: Response,
  bodyJson: unknown,
): PaymentRequired | undefined {
  try {
    return httpClient.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      bodyJson,
    );
  } catch {
    return undefined;
  }
}

export async function x402FetchFlow(
  params: X402FetchParams,
  config: PluginConfig,
  deps: SignDeps = {},
  context: ToolContext = {},
): Promise<X402FetchResult> {
  context.signal?.throwIfAborted();
  const url = params.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'error', url, error: 'url must be an absolute HTTP(S) URL.' };
  }

  let paymentContext: X402PaymentContext = {};
  let selectedPayment: X402PaymentSelection | undefined;
  let paymentPayload: PaymentPayload | undefined;

  try {
    const signer = createAc2AvmSigner({
      config,
      deps,
      context,
      getPaymentContext: () => paymentContext,
    });

    const allowedNetworks = resolveAllowedNetworks(params, config);
    const allowedAssets = resolveAllowedAssets(params, config);
    const allowedPayTo = resolveAllowedPayTo(params, config);
    const maxAmountAtomic = resolveMaxAmount(params, config);
    const networkPreferences = uniqueStrings(
      params.network_preferences ?? config.x402NetworkPreferences ?? allowedNetworks,
    );

    const client = new x402Client(buildSelector(networkPreferences));
    const schemeConfig: ConstructorParameters<typeof ExactAvmScheme>[1] = {
      ...(config.x402AlgodUrl !== undefined ? { algodUrl: config.x402AlgodUrl } : {}),
      ...(config.x402AlgodToken !== undefined ? { algodToken: config.x402AlgodToken } : {}),
    };
    for (const network of allowedNetworks) {
      client.register(network as Network, new ExactAvmScheme(signer, schemeConfig));
    }

    client.registerPolicy(
      buildPaymentPolicy({
        maxAmountAtomic,
        allowedNetworks: new Set(allowedNetworks),
        allowedAssets: new Set(allowedAssets),
        ...(allowedPayTo !== undefined ? { allowedPayTo: new Set(allowedPayTo) } : {}),
      }),
    );
    client.onBeforePaymentCreation(async (ctx) => {
      paymentContext = {
        requirements: ctx.selectedRequirements,
        resource: ctx.paymentRequired.resource,
      };
      selectedPayment = selectedPaymentFromContext(
        ctx.paymentRequired.x402Version,
        ctx.selectedRequirements,
        ctx.paymentRequired.resource,
      );
    });
    client.onAfterPaymentCreation(async (ctx) => {
      paymentPayload = ctx.paymentPayload;
    });

    const httpClient = new x402HTTPClient(client);
    const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, httpClient);
    const response = await fetchWithPayment(url, createRequestInit(params, context));
    const includeBody = params.include_response_body !== false;
    const body = await readResponseBody(response, includeBody);

    if (isPaymentRequiredResponse(response)) {
      const paymentRequired = paymentRequiredFromResponse(httpClient, response, body.bodyJson);
      return {
        status: 'payment_required',
        url,
        ...(paymentRequired !== undefined ? { paymentRequired } : {}),
        reason: 'The resource still returned 402 after x402 payment negotiation.',
      };
    }

    const settlement = parseSettleResponse(httpClient, response);
    return {
      status: response.ok ? 'paid' : 'http_error',
      url,
      http: {
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        ...(response.headers.get('content-type') !== null
          ? { contentType: response.headers.get('content-type') as string }
          : {}),
      },
      ...(selectedPayment !== undefined ? { selectedPayment } : {}),
      ...(paymentPayload !== undefined ? { paymentPayload } : {}),
      ...(settlement !== undefined ? { settlement } : {}),
      ...body,
    };
  } catch (err) {
    if (err instanceof NoActiveSessionError) {
      return { status: 'rejected', url, reason: err.code };
    }
    const classified = classifyX402SigningError(err);
    if (classified.status === 'rejected') {
      return { status: 'rejected', url, reason: classified.reason };
    }
    return { status: 'error', url, error: classified.reason };
  }
}

export function normalizeX402FetchParams(params: Record<string, unknown>): X402FetchParams {
  const out: X402FetchParams = { url: String(params.url ?? '') };
  if (typeof params.method === 'string') out.method = params.method;
  if (params.headers !== null && typeof params.headers === 'object' && !Array.isArray(params.headers)) {
    out.headers = params.headers as Record<string, string>;
  }
  if (typeof params.body === 'string') out.body = params.body;
  if (typeof params.body_base64 === 'string') out.body_base64 = params.body_base64;
  if (typeof params.max_amount_atomic === 'string') {
    out.max_amount_atomic = params.max_amount_atomic;
  }
  const allowedNetworks = configStringArray(params.allowed_networks);
  if (allowedNetworks !== undefined) out.allowed_networks = allowedNetworks;
  const allowedAssets = configStringArray(params.allowed_assets);
  if (allowedAssets !== undefined) out.allowed_assets = allowedAssets;
  const allowedPayTo = configStringArray(params.allowed_pay_to);
  if (allowedPayTo !== undefined) out.allowed_pay_to = allowedPayTo;
  const networkPreferences = configStringArray(params.network_preferences);
  if (networkPreferences !== undefined) out.network_preferences = networkPreferences;
  if (typeof params.include_response_body === 'boolean') {
    out.include_response_body = params.include_response_body;
  }
  return out;
}
