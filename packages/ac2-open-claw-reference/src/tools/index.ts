/** Tool builders for `api.registerTool(...)`. Schemas/descriptions come from `./manifest.js`. */

import type { AnyAgentTool } from 'openclaw/plugin-sdk';

import { getActiveApi, resolveConfig, textResult } from '../runtime.js';
import pluginManifest from './manifest.js';
import { getToolPluginMetadata } from '../session/contracts.js';
import { NoActiveSessionError } from '../session/manager.js';
import { capabilitiesFlow, signFlow, type SignParams } from '../session/flows.js';
import type { SigningRequestBody } from '@algorandfoundation/ac2-sdk/schema';
import { normalizeX402FetchParams, x402FetchFlow } from '../x402/fetch-flow.js';

function manifestTools(): ReadonlyArray<{
  name: string;
  parameters: unknown;
  description: string;
}> {
  return getToolPluginMetadata(pluginManifest)?.tools ?? [];
}

function findToolParametersSchema(toolName: string): unknown {
  for (const t of manifestTools()) {
    if (t.name === toolName) return t.parameters;
  }
  return { type: 'object', properties: {}, additionalProperties: false };
}

function findToolDescription(toolName: string): string {
  for (const t of manifestTools()) {
    if (t.name === toolName) return t.description;
  }
  return '';
}

export function buildSignTool(): AnyAgentTool {
  const tool = {
    name: 'ac2_sign',
    label: 'AC2 · Sign',
    description: findToolDescription('ac2_sign'),
    parameters: findToolParametersSchema('ac2_sign'),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details: unknown;
    }> {
      const config = resolveConfig(getActiveApi() || ({} as any));
      const signParams: SignParams = {
        description: String(params.description ?? ''),
        payload_base64: String(params.payload_base64 ?? ''),
        ...(typeof params.schema === 'string' ? { schema: params.schema } : {}),
        ...(typeof params.sig_hint === 'string'
          ? { sig_hint: params.sig_hint as SigningRequestBody['sig_hint'] }
          : {}),
        ...(typeof params.display_hint === 'string'
          ? {
              display_hint: params.display_hint as SigningRequestBody['display_hint'],
            }
          : {}),
        ...(typeof params.key_type === 'string'
          ? { key_type: params.key_type as SigningRequestBody['key_type'] }
          : {}),
        ...(typeof params.expires_in_seconds === 'number'
          ? { expires_in_seconds: params.expires_in_seconds }
          : {}),
      };
      try {
        const result = await signFlow(signParams, config);
        if (result.status === 'rejected') {
          return {
            content: [textResult(`Signing rejected: ${result.reason}`)],
            details: result,
          };
        }
        return {
          content: [textResult('Signed.')],
          details: result,
        };
      } catch (err) {
        if (err instanceof NoActiveSessionError) {
          const details = { status: 'rejected', reason: err.code };
          return {
            content: [
              textResult(
                'Signing rejected: no active AC2 channel session — open `/ac2` and pair your controller first.',
              ),
            ],
            details,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [textResult(`Sign error: ${msg}`)],
          details: { status: 'error', error: msg },
        };
      }
    },
  };
  return tool as unknown as AnyAgentTool;
}

function describeX402Result(result: Awaited<ReturnType<typeof x402FetchFlow>>): string {
  if (result.status === 'paid') {
    const payment = result.selectedPayment
      ? ` Paid ${result.selectedPayment.amount} of ${result.selectedPayment.asset} on ${result.selectedPayment.network}.`
      : '';
    return `x402 fetch succeeded with HTTP ${result.http.status}.${payment}`;
  }
  if (result.status === 'http_error') {
    return `x402 fetch completed with HTTP ${result.http.status} ${result.http.statusText}.`;
  }
  if (result.status === 'payment_required') {
    return `x402 fetch still requires payment: ${result.reason}`;
  }
  if (result.status === 'rejected') {
    return `x402 payment rejected: ${result.reason}`;
  }
  if (result.status === 'error') {
    return `x402 fetch error: ${result.error}`;
  }
  return 'x402 fetch completed.';
}

export function buildX402FetchTool(): AnyAgentTool {
  const tool = {
    name: 'ac2_x402_fetch',
    label: 'AC2 · x402 Fetch',
    description: findToolDescription('ac2_x402_fetch'),
    parameters: findToolParametersSchema('ac2_x402_fetch'),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details: unknown;
    }> {
      const config = resolveConfig(getActiveApi() || ({} as any));
      const fetchParams = normalizeX402FetchParams(params);
      try {
        const result = await x402FetchFlow(fetchParams, config);
        return {
          content: [textResult(describeX402Result(result))],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [textResult(`x402 fetch error: ${msg}`)],
          details: { status: 'error', error: msg },
        };
      }
    },
  };
  return tool as unknown as AnyAgentTool;
}

export function buildCapabilitiesTool(): AnyAgentTool {
  const tool = {
    name: 'ac2_capabilities',
    label: 'AC2 · Capabilities',
    description: findToolDescription('ac2_capabilities'),
    parameters: findToolParametersSchema('ac2_capabilities'),
    async execute(): Promise<{
      content: Array<{ type: 'text'; text: string }>;
      details: unknown;
    }> {
      const config = resolveConfig(getActiveApi() || ({} as any));
      const result = capabilitiesFlow(config);
      const headline =
        result.status === 'ok'
          ? 'AC2 session is connected.'
          : 'AC2 session is not connected — pair via `/ac2`.';
      const body = JSON.stringify(result, null, 2);
      return {
        content: [textResult(`${headline}\n\`\`\`json\n${body}\n\`\`\``)],
        details: result,
      };
    },
  };
  return tool as unknown as AnyAgentTool;
}
