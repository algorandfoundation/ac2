/**
 * Regression coverage for the CAIP-2 network-id mismatch that made every paid
 * fetch fail live with
 * `No network/scheme registered for x402 version: 2 which comply with the
 * payment requirements`.
 *
 * The endpoint (`https://example.x402.goplausible.xyz/avm/weather`) advertises
 * Algorand testnet with the FULL 44-character base64 genesis hash, while
 * `@x402/avm` >= 2.18 canonicalises the same chain to a 32-character CAIP-2
 * reference. The x402 client matches registered schemes by string, so nothing
 * matched and the offer was rejected before a payment was ever built.
 */
import { Buffer } from 'node:buffer';

import { describe, expect, it, afterEach } from 'vitest';

import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from '@x402/avm';

import {
  normalizeX402Network,
  x402FetchFlow,
} from '../src/x402/fetch-flow.js';
import { SessionManager } from '../src/session/manager.js';

/** The exact network string the live resource advertises (full genesis hash). */
const ADVERTISED_TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
const URL = 'https://example.x402.goplausible.xyz/avm/weather';

/** The verbatim 402 body shape the live resource returns. */
function paymentRequiredBody(network: string, asset = '10458941'): unknown {
  return {
    x402Version: 2,
    error: 'payment required',
    resource: { url: URL, mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: '1000',
        asset,
        payTo: 'MPY54CLPH2OKEGC6S5N2LDAFDNO5BVNV532NBZ5VD6GOND3STPNXZYXOFE',
        maxTimeoutSeconds: 300,
        extra: { name: 'USDC', decimals: 6 },
      },
    ],
  };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('normalizeX402Network', () => {
  it('collapses the long and truncated spellings of one chain', () => {
    expect(normalizeX402Network(ADVERTISED_TESTNET)).toBe(
      normalizeX402Network(ALGORAND_TESTNET_CAIP2),
    );
  });

  it('leaves an already-canonical id untouched', () => {
    expect(normalizeX402Network(ALGORAND_TESTNET_CAIP2)).toBe(ALGORAND_TESTNET_CAIP2);
    expect(normalizeX402Network('eip155:1')).toBe('eip155:1');
  });

  it('passes through a value with no CAIP-2 separator', () => {
    expect(normalizeX402Network('algorand')).toBe('algorand');
  });
});

describe('x402 fetch network matching', () => {
  /**
   * Drive the flow far enough to prove requirement SELECTION succeeded. The
   * daemon lookup is stubbed to report a connected wallet, and algod is pointed
   * at an unroutable port so payment CONSTRUCTION fails — which is fine: the
   * assertion is that we no longer fail at the network-matching stage.
   */
  async function runAgainstOffer(
    network: string,
    options: { asset?: string; allowedNetworks?: string[] } = {},
  ) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'payment required' }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          // x402 v2 carries the offer in a base64 header; only v1 offers were
          // read out of the JSON body.
          'payment-required': Buffer.from(
            JSON.stringify(paymentRequiredBody(network, options.asset)),
            'utf8',
          ).toString('base64'),
        },
      })) as typeof globalThis.fetch;

    return await x402FetchFlow(
      {
        url: URL,
        ...(options.allowedNetworks ? { allowed_networks: options.allowedNetworks } : {}),
      },
      { x402AlgodUrl: 'http://127.0.0.1:1', defaultTimeoutMs: 1_000 },
      {
        manager: new SessionManager(),
        connect: async () => ({
          async request(method: string) {
            if (method === 'daemon.status') {
              return {
                connection: {
                  state: 'connected',
                  requestId: 'req-x402',
                  controllerDid: 'did:key:zStubController',
                  walletAddress: 'MPY54CLPH2OKEGC6S5N2LDAFDNO5BVNV532NBZ5VD6GOND3STPNXZYXOFE',
                  origin: 'https://example.test',
                  locked: false,
                },
              };
            }
            if (method === 'connections.list') {
              return { connections: [{ requestId: 'req-x402', agentDid: 'did:key:zStubAgent' }] };
            }
            throw new Error(`unexpected control method ${method}`);
          },
          close() {},
        }),
      } as never,
    );
  }

  /** The offer was matched iff we got past both the client and our policy. */
  function passedNetworkGate(result: unknown): boolean {
    const text = JSON.stringify(result);
    return (
      !text.includes('No network/scheme registered') &&
      !text.includes('filtered out by policies') &&
      !text.includes('Invalid payment required response')
    );
  }

  it('accepts an offer that uses the untruncated genesis-hash network id', async () => {
    expect(passedNetworkGate(await runAgainstOffer(ADVERTISED_TESTNET))).toBe(true);
  });

  it('still accepts the canonical (truncated) network id', async () => {
    expect(passedNetworkGate(await runAgainstOffer(ALGORAND_TESTNET_CAIP2))).toBe(true);
  });

  it('accepts mainnet when mainnet is allowed', async () => {
    expect(
      passedNetworkGate(
        await runAgainstOffer(ALGORAND_MAINNET_CAIP2, {
          asset: '31566704',
          allowedNetworks: [ALGORAND_MAINNET_CAIP2],
        }),
      ),
    ).toBe(true);
  });

  it('still refuses a chain the allowlist does not cover', async () => {
    // Same mainnet offer, testnet-only allowlist: the wildcard registration
    // widened only the SPELLING of an allowed chain, never the set of chains
    // we are willing to pay on.
    const result = await runAgainstOffer(ALGORAND_MAINNET_CAIP2, {
      asset: '31566704',
      allowedNetworks: [ALGORAND_TESTNET_CAIP2],
    });
    expect(passedNetworkGate(result)).toBe(false);
    expect((result as { status: string }).status).toBe('error');
  });
});
