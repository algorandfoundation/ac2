import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildKeyResponse,
  buildSigningRejected,
  buildSigningResponse,
  type BuildSigningRequestArgs,
} from '@algorandfoundation/ac2-sdk/protocol';
import {
  isKeyRequest,
  isSigningRequest,
  type AC2BaseMessage as Ac2Message,
  type AC2KeyRequest as KeyRequestMessage,
  type AC2SigningRequest as SigningRequestMessage,
} from '@algorandfoundation/ac2-sdk/schema';
import type { Ac2Transport } from '@algorandfoundation/ac2-sdk/transport';
import { Ac2Client } from '@algorandfoundation/ac2-sdk';
import { Address } from '@algorandfoundation/algokit-utils/common';
import {
  bytesForSigning,
  decodeSignedTransaction,
  encodeTransactionRaw,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signFlow,
  capabilitiesFlow,
  SessionManager,
  NoActiveSessionError,
  buildChannelObject,
  sessionManager,
  resolveAc2SessionConversation,
  resolveAc2OutboundSessionRoute,
  buildAc2SessionKey,
  AC2_MEDIA_SOURCE_PARAMS,
  getToolPluginMetadata,
  pluginManifest as plugin,
  createAc2AvmSigner,
  X402_ALGORAND_SIGNING_SCHEMA,
  buildSignTool,
  buildAc2Command,
} from '../src/index.js';
import { describeX402Result } from '../src/tools/index.js';
import {
  resolveCapabilities,
  capabilitiesFromDaemon,
  signViaDaemon,
  resolveSign,
} from '../src/session/flows.js';
import { publicKeyToDidKey } from '@algorandfoundation/ac2-cli/identity';
import { InMemoryChannelProvider } from '@algorandfoundation/ac2-sdk/providers/in-memory';
import { runDaemon, type RunningDaemon } from '@algorandfoundation/ac2-cli';
import { connectControl } from '@algorandfoundation/ac2-cli/control';

/**
 * Stub controller DID used by the in-memory provider — the wallet's
 * `KeyResponse.from` is what the plugin locks in as `controllerDid`,
 * so this value flows through to every test that inspects the active
 * session.
 */
const STUB_CONTROLLER_DID = 'did:key:zStubController';
/**
 * A real Ed25519 keypair the fake wallet grants as the agent identity. The
 * daemon-backed tests run a real daemon whose keystore hard-fails the session
 * when the granted material cannot be imported/persisted, so it must be
 * genuine 32-byte material exactly as a wallet sends it.
 */
const AGENT_KEY = ((): { material: string; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    material: Buffer.from(pkcs8.subarray(pkcs8.length - 32)).toString('base64'),
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'),
  };
})();
/** Identity public key returned in the bootstrap `KeyResponse` (base64). */
const STUB_AGENT_PK = AGENT_KEY.publicKey;
/** Canonical `did:key:z…` the daemon derives from `STUB_AGENT_PK`. */
const STUB_AGENT_DID = publicKeyToDidKey(Buffer.from(AGENT_KEY.publicKey, 'base64'));

/**
 * Standard bootstrap reply: every test channel needs to answer the
 * agent's first `KeyRequest` (for_operation: 'ac2/identity') so the
 * plugin can derive the agent's DID and activate the session.
 */
function replyToBootstrap(req: KeyRequestMessage, peer: { send: (s: string) => void }): void {
  peer.send(
    JSON.stringify(
      buildKeyResponse({
        request: req,
        from: STUB_CONTROLLER_DID,
        body: {
          status: 'approved',
          key_type: 'ed25519',
          material: AGENT_KEY.material,
          public_key: STUB_AGENT_PK,
        },
      }),
    ),
  );
}

/**
 * Stub `Ac2ChannelProvider` where each `startPairing` synchronously wires
 * a Controller behaviour to the peer transport before `connect()` runs.
 */
function makeClient(
  reply: (req: Ac2Message, peer: { send: (s: string) => void }) => void,
): InMemoryChannelProvider {
  return new (class extends InMemoryChannelProvider {
    protected override onPairingPrepared(peerTransport: Ac2Transport): void {
      peerTransport.onMessage((msg) => {
        if (isKeyRequest(msg)) {
          replyToBootstrap(msg, peerTransport);
          return;
        }
        if (isSigningRequest(msg)) reply(msg, peerTransport);
      });
    }
  })();
}

/**
 * Helper: pair a stub provider, wrap the agent end in an `Ac2Client` and
 * register it as the active session.
 *
 * This deliberately does NOT go through any plugin-owned connection
 * runtime — the plugin no longer owns wallet connections (the AC2 daemon
 * does, see `buildAc2Command`). These signing tests only need a live
 * request/response transport plus an active session, which is exactly
 * what the daemon hands the plugin in production via
 * `sessionManager.setActive({ transport, client, ... })`.
 */
async function bootChannel(provider: InMemoryChannelProvider): Promise<{
  manager: SessionManager;
  teardown: () => Promise<void>;
}> {
  const manager = new SessionManager();
  const { connect } = await provider.startPairing({ timeoutMs: 2_000 });
  const paired = await connect();
  const client = new Ac2Client(paired.transport);
  manager.setActive({
    transport: paired.transport,
    client,
    controllerDid: STUB_CONTROLLER_DID,
    agentDid: STUB_AGENT_DID,
    identityGranted: true,
  });
  return {
    manager,
    teardown: async () => {
      manager.clearActive();
      await paired.close();
    },
  };
}

describe('ac2 plugin', () => {
  it('exposes the expected plugin manifest shape', () => {
    // The manifest is a genuine SDK `defineToolPlugin` entry; its catalog is
    // re-read through the supported `getToolPluginMetadata` accessor.
    const metadata = getToolPluginMetadata(plugin);
    expect(metadata?.id).toBe('ac2');
    const names = (metadata?.tools ?? []).map((t) => t.name);
    expect(names).toContain('ac2_sign');
    expect(names).toContain('ac2_capabilities');
    expect(names).toContain('ac2_x402_fetch');
  });

  it('exposes the ac2 channel via the channel object', () => {
    // The `ac2` channel is registered separately (the SDK tool-plugin contract
    // has no `channels` factory); its identity comes from `buildChannelObject`.
    const channel = buildChannelObject() as unknown as { id?: string };
    expect(channel.id).toBe('ac2');
  });

  describe('SessionManager invariant', () => {
    it('ac2_sign rejects with no_active_session when no channel is connected', async () => {
      const manager = new SessionManager();
      expect(manager.getActive()).toBeNull();
      await expect(
        signFlow(
          {
            description: 'should fail — no channel',
            payload_base64: Buffer.from('x').toString('base64'),
          },
          {},
          { manager },
        ),
      ).rejects.toBeInstanceOf(NoActiveSessionError);
    });

    it('capabilitiesFlow reports no_active_session before pairing', () => {
      const manager = new SessionManager();
      const caps = capabilitiesFlow({}, { manager });
      expect(caps.status).toBe('no_active_session');
      expect(caps.session.connected).toBe(false);
      expect(caps.session.walletAddress).toBeNull();
    });

    it('an active-but-identity-less session locks signing and reports no DID', async () => {
      // Mirrors the no-identity flow: the channel is active for conversation
      // (so the agent can explain why it needs an identity), but no identity was
      // granted, so `ac2_sign` must reject and `ac2_capabilities` must report
      // `agent.did: null` even though the session is connected.
      const manager = new SessionManager();
      manager.setActive({
        transport: {} as never,
        client: {} as never,
        controllerDid: 'did:key:zController',
        agentDid: 'did:ac2:agent',
        identityGranted: false,
      });

      const outcome = await signFlow(
        {
          description: 'should be locked — no identity granted',
          payload_base64: Buffer.from('x').toString('base64'),
        },
        {},
        { manager },
      );
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.reason).toBe('no_identity');

      const caps = capabilitiesFlow({}, { manager });
      expect(caps.status).toBe('ok');
      expect(caps.session.connected).toBe(true);
      expect(caps.agent.did).toBeNull();
    });
  });

  describe('daemon-backed capabilities detection', () => {
    /**
     * The daemon — not this process — owns the wallet connection now, so
     * `ac2_capabilities` must ask it over the control socket. A tool running in
     * the agent/gateway process has no local pairing session, yet a wallet can
     * be fully connected; a fake control client stands in for the daemon here.
     */
    function fakeConnect(config: {
      reachable?: boolean;
      state?: 'connected' | 'idle' | 'connecting';
      requestId?: string | null;
      controllerDid?: string | null;
      walletAddress?: string | null;
      locked?: boolean;
      connections?: Array<{ requestId: string; agentDid: string | null }>;
    }): () => Promise<any> {
      return async () => {
        if (config.reachable === false) return undefined;
        return {
          async request(method: string) {
            if (method === 'daemon.status') {
              return {
                connection: {
                  state: config.state ?? 'connected',
                  requestId: config.requestId ?? null,
                  controllerDid: config.controllerDid ?? null,
                  walletAddress: config.walletAddress ?? null,
                  origin: 'https://example.test',
                  locked: config.locked ?? false,
                },
              };
            }
            if (method === 'connections.list') {
              return { connections: config.connections ?? [] };
            }
            throw new Error(`unexpected control method ${method}`);
          },
          close() {},
        };
      };
    }

    it('returns null when the daemon is unreachable (caller falls back)', async () => {
      const caps = await capabilitiesFromDaemon({}, { connect: fakeConnect({ reachable: false }) });
      expect(caps).toBeNull();
    });

    it('reports no_active_session when the daemon is idle (no wallet linked)', async () => {
      const caps = await capabilitiesFromDaemon({}, { connect: fakeConnect({ state: 'idle' }) });
      expect(caps?.status).toBe('no_active_session');
      expect(caps?.session.connected).toBe(false);
    });

    it('reports connected with agent/controller/wallet from the daemon', async () => {
      const caps = await capabilitiesFromDaemon(
        {},
        {
          connect: fakeConnect({
            state: 'connected',
            requestId: 'req-1',
            controllerDid: 'did:key:zController',
            walletAddress: 'WALLETADDR',
            connections: [{ requestId: 'req-1', agentDid: 'did:key:zAgent' }],
          }),
        },
      );
      expect(caps?.status).toBe('ok');
      expect(caps?.session.connected).toBe(true);
      expect(caps?.session.controllerDid).toBe('did:key:zController');
      expect(caps?.session.walletAddress).toBe('WALLETADDR');
      expect(caps?.agent.did).toBe('did:key:zAgent');
    });

    it('reports agent.did null for a locked (refused) connection', async () => {
      const caps = await capabilitiesFromDaemon(
        {},
        {
          connect: fakeConnect({
            state: 'connected',
            requestId: 'req-1',
            controllerDid: 'did:key:zOther',
            locked: true,
            connections: [{ requestId: 'req-1', agentDid: 'did:key:zAgent' }],
          }),
        },
      );
      expect(caps?.status).toBe('ok');
      expect(caps?.session.connected).toBe(true);
      expect(caps?.agent.did).toBeNull();
    });

    it('resolveCapabilities prefers a live local session over the daemon', async () => {
      const manager = new SessionManager();
      manager.setActive({
        transport: {} as never,
        client: {} as never,
        controllerDid: 'did:key:zLocalController',
        agentDid: 'did:key:zLocalAgent',
        identityGranted: true,
      });
      // The daemon reports a DIFFERENT controller; the local session must win.
      const caps = await resolveCapabilities(
        {},
        {
          manager,
          connect: fakeConnect({ state: 'connected', controllerDid: 'did:key:zDaemonController' }),
        },
      );
      expect(caps.status).toBe('ok');
      expect(caps.session.controllerDid).toBe('did:key:zLocalController');
    });

    it('resolveCapabilities falls back to the daemon when no local session', async () => {
      const manager = new SessionManager();
      const caps = await resolveCapabilities(
        {},
        {
          manager,
          connect: fakeConnect({
            state: 'connected',
            requestId: 'req-9',
            controllerDid: 'did:key:zDaemonController',
            connections: [{ requestId: 'req-9', agentDid: 'did:key:zDaemonAgent' }],
          }),
        },
      );
      expect(caps.status).toBe('ok');
      expect(caps.session.controllerDid).toBe('did:key:zDaemonController');
      expect(caps.agent.did).toBe('did:key:zDaemonAgent');
    });

    it('resolveCapabilities reports no_active_session when local and daemon are both idle', async () => {
      const manager = new SessionManager();
      const caps = await resolveCapabilities(
        {},
        { manager, connect: fakeConnect({ state: 'idle' }) },
      );
      expect(caps.status).toBe('no_active_session');
    });
  });

  describe('daemon-backed signing (agent.request passthrough)', () => {
    /**
     * The daemon owns the wallet connection and is the only party that can
     * complete a signing round-trip, so `ac2_sign` must broker through it when
     * this process has no local pairing session. Signing now rides the generic
     * verb-agnostic `agent.request` passthrough: the plugin builds the
     * `ac2/SigningRequest` frame and interprets the relayed reply. A fake
     * control client stands in for the daemon's `agent.request` (no real
     * socket/wallet).
     */
    function fakeSignConnect(config: {
      reachable?: boolean;
      result?: unknown;
      throwCode?: string;
      onParams?: (params: unknown) => void;
    }): () => Promise<any> {
      return async () => {
        if (config.reachable === false) return undefined;
        return {
          async request(method: string, params: unknown) {
            if (method === 'agent.request') {
              config.onParams?.(params);
              if (config.throwCode) {
                throw Object.assign(new Error(config.throwCode), { code: config.throwCode });
              }
              return config.result;
            }
            throw new Error(`unexpected control method ${method}`);
          },
          close() {},
        };
      };
    }

    /** Build a relayed `ac2/SigningResponse` `agent.request` result. */
    function signedResponse(body: Record<string, unknown>, thid = 'req-1') {
      return {
        status: 'response',
        message: {
          type: 'ac2/SigningResponse',
          from: STUB_CONTROLLER_DID,
          to: [STUB_AGENT_DID],
          thid,
          body,
        },
      };
    }

    it('returns null when the daemon is unreachable (caller falls back)', async () => {
      const result = await signViaDaemon(
        { description: 'x', payload_base64: 'eA==' },
        {},
        { connect: fakeSignConnect({ reachable: false }) },
      );
      expect(result).toBeNull();
    });

    it('builds a SigningRequest frame and interprets the relayed SigningResponse', async () => {
      let seen: any;
      const result = await signViaDaemon(
        {
          description: 'Sign this',
          payload_base64: Buffer.from('hello').toString('base64'),
          schema: 'test/schema',
          sig_hint: 'raw-ed25519',
        },
        { defaultTimeoutMs: 5000 },
        {
          connect: fakeSignConnect({
            result: signedResponse(
              { signature: 'c2ln', public_key: 'cGs=', address: 'ADDR', key_type: 'account' },
              'req-1',
            ),
            onParams: (p) => (seen = p),
          }),
        },
      );
      expect(result).toEqual({
        status: 'signed',
        signature: 'c2ln',
        public_key: 'cGs=',
        address: 'ADDR',
        key_type: 'account',
        thid: 'req-1',
      });
      // The plugin builds a verb-tagged AC2 request frame and declares the
      // settling response types; it never fills from/to (the daemon does).
      expect(seen.type).toBe('ac2/SigningRequest');
      expect(seen.responseTypes).toEqual(['ac2/SigningResponse', 'ac2/SigningRejected']);
      expect(seen.timeoutMs).toBe(5000);
      expect(seen.body).toMatchObject({
        description: 'Sign this',
        encoding: 'base64',
        payload: Buffer.from('hello').toString('base64'),
        schema: 'test/schema',
        sig_hint: 'raw-ed25519',
      });
      expect(seen.body.from).toBeUndefined();
      expect(seen.body.to).toBeUndefined();
    });

    it('interprets a relayed SigningRejected as a rejection', async () => {
      const result = await signViaDaemon(
        { description: 'x', payload_base64: 'eA==' },
        {},
        {
          connect: fakeSignConnect({
            result: {
              status: 'response',
              message: {
                type: 'ac2/SigningRejected',
                from: STUB_CONTROLLER_DID,
                to: [STUB_AGENT_DID],
                thid: 'req-2',
                body: { reason: 'user_declined' },
              },
            },
          }),
        },
      );
      expect(result).toEqual({ status: 'rejected', reason: 'user_declined', thid: 'req-2' });
    });

    it('maps a daemon-side unavailable gate to a rejection with that reason', async () => {
      const result = await signViaDaemon(
        { description: 'x', payload_base64: 'eA==' },
        {},
        { connect: fakeSignConnect({ result: { status: 'unavailable', reason: 'no_identity' } }) },
      );
      expect(result).toEqual({ status: 'rejected', reason: 'no_identity' });
    });

    it('resolveSign prefers a live local session over the daemon', async () => {
      const manager = new SessionManager();
      let daemonCalled = false;
      manager.setActive({
        transport: {} as never,
        client: {
          requestSignature: async (args: BuildSigningRequestArgs) => ({
            kind: 'signed',
            message: {
              id: 'r',
              type: 'SigningResponse',
              from: args.to,
              to: args.from,
              thid: 't',
              created_time: 1,
              body: {
                signature: Buffer.from('localsig').toString('base64'),
                public_key: Buffer.from('pk').toString('base64'),
              },
            },
          }),
        } as never,
        controllerDid: STUB_CONTROLLER_DID,
        agentDid: STUB_AGENT_DID,
        identityGranted: true,
      });

      const result = await resolveSign(
        { description: 'x', payload_base64: Buffer.from('y').toString('base64') },
        {},
        {
          manager,
          connect: fakeSignConnect({
            result: { status: 'signed', signature: 'daemon', public_key: 'pk', thid: 't' },
            onParams: () => (daemonCalled = true),
          }),
        },
      );
      expect(result.status).toBe('signed');
      if (result.status === 'signed') {
        expect(result.signature).toBe(Buffer.from('localsig').toString('base64'));
      }
      expect(daemonCalled).toBe(false);
    });

    it('resolveSign falls back to the daemon when no local session', async () => {
      const manager = new SessionManager();
      const result = await resolveSign(
        { description: 'x', payload_base64: Buffer.from('y').toString('base64') },
        {},
        {
          manager,
          connect: fakeSignConnect({ result: signedResponse({ signature: 'daemonsig', public_key: 'pk' }, 't') }),
        },
      );
      expect(result).toEqual({ status: 'signed', signature: 'daemonsig', public_key: 'pk', thid: 't' });
    });

    it('resolveSign throws NoActiveSessionError when local and daemon are both unavailable', async () => {
      const manager = new SessionManager();
      await expect(
        resolveSign(
          { description: 'x', payload_base64: Buffer.from('y').toString('base64') },
          {},
          { manager, connect: fakeSignConnect({ reachable: false }) },
        ),
      ).rejects.toMatchObject({ code: 'no_active_session' });
    });
  });

  describe('signFlow through an active channel', () => {
    it('renders the signature details in the OpenClaw tool content', async () => {
      sessionManager.setActive({
        transport: {} as never,
        client: {
          requestSignature: async (args: BuildSigningRequestArgs) => ({
            kind: 'signed',
            message: {
              id: 'response-1',
              type: 'SigningResponse',
              from: args.to,
              to: args.from,
              thid: 'request-1',
              created_time: 1,
              body: {
                signature: Buffer.from('sig').toString('base64'),
                public_key: Buffer.from('pk').toString('base64'),
                address: 'ADDR',
                key_type: 'account',
              },
            },
          }),
        } as never,
        controllerDid: STUB_CONTROLLER_DID,
        agentDid: STUB_AGENT_DID,
        identityGranted: true,
      });

      try {
        const tool = buildSignTool() as unknown as {
          execute: (
            id: string,
            params: Record<string, unknown>,
          ) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
        };
        const result = await tool.execute('tool-call-1', {
          description: 'Sign test payload',
          payload_base64: Buffer.from('hello').toString('base64'),
        });

        expect(result.content[0]?.text).toContain('Signed payload:');
        expect(result.content[0]?.text).toContain('"status": "signed"');
        expect(result.content[0]?.text).toContain('"signature": "c2ln"');
        expect(result.content[0]?.text).toContain('"public_key": "cGs="');
        expect(result.details).toMatchObject({
          status: 'signed',
          signature: Buffer.from('sig').toString('base64'),
          public_key: Buffer.from('pk').toString('base64'),
        });
      } finally {
        sessionManager.clearActive();
      }
    });

    it('round-trips a SigningRequest/Response across the channel session', async () => {
      let observedSchema: string | undefined;
      const provider = makeClient((req, peer) => {
        observedSchema = (req as SigningRequestMessage).body.schema;
        peer.send(
          JSON.stringify(
            buildSigningResponse({
              request: req,
              body: {
                signature: Buffer.from('sig').toString('base64'),
                public_key: Buffer.from('pk').toString('base64'),
                key_type: 'account',
              },
            }),
          ),
        );
      });

      const { manager, teardown } = await bootChannel(provider);
      try {
        expect(manager.getActive()).not.toBeNull();
        const outcome = await signFlow(
          {
            description: 'Sign test payload',
            payload_base64: Buffer.from('hello').toString('base64'),
            schema: 'test/schema',
            sig_hint: 'raw-ed25519',
          },
          { defaultTimeoutMs: 2_000 },
          { manager },
        );
        expect(outcome.status).toBe('signed');
        if (outcome.status === 'signed') {
          expect(outcome.signature).toBe(Buffer.from('sig').toString('base64'));
          expect(outcome.public_key).toBe(Buffer.from('pk').toString('base64'));
          expect(outcome.key_type).toBe('account');
        }
        expect(observedSchema).toBe('test/schema');
      } finally {
        await teardown();
      }

      // After teardown, the manager is cleared and signing rejects again.
      expect(manager.getActive()).toBeNull();
    });

    it('threads thid so the response binds to the original request', async () => {
      let observedRequestId: string | undefined;
      const provider = makeClient((req, peer) => {
        observedRequestId = req.id;
        peer.send(
          JSON.stringify(
            buildSigningResponse({
              request: req,
              body: { signature: 'AAAA', public_key: 'AAAA' },
            }),
          ),
        );
      });

      const { manager, teardown } = await bootChannel(provider);
      try {
        const outcome = await signFlow(
          { description: 'Bound request', payload_base64: 'AAAA' },
          { defaultTimeoutMs: 2_000 },
          { manager },
        );
        expect(outcome.status).toBe('signed');
        if (outcome.status === 'signed') {
          expect(outcome.thid).toBe(observedRequestId);
        }
      } finally {
        await teardown();
      }
    });

    it('surfaces SigningRejected outcomes as { status: "rejected" }', async () => {
      const provider = makeClient((req, peer) => {
        peer.send(JSON.stringify(buildSigningRejected({ request: req, reason: 'User declined' })));
      });

      const { manager, teardown } = await bootChannel(provider);
      try {
        const outcome = await signFlow(
          {
            description: 'Rejected request',
            payload_base64: Buffer.from('x').toString('base64'),
          },
          { defaultTimeoutMs: 2_000 },
          { manager },
        );
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBe('User declined');
        }
      } finally {
        await teardown();
      }
    });
  });

  describe('x402 Algorand signing adapter', () => {
    it('wraps wallet-approved Ed25519 signatures into signed Algorand transactions', async () => {
      const sender = new Address(new Uint8Array(32).fill(1));
      const receiver = new Address(new Uint8Array(32).fill(2));
      const txn = new Transaction({
        type: TransactionType.AssetTransfer,
        sender,
        fee: 1_000n,
        firstValid: 1n,
        lastValid: 1_000n,
        genesisHash: new Uint8Array(32).fill(3),
        genesisId: 'testnet-v1.0',
        assetTransfer: {
          assetId: 10_458_941n,
          amount: 123n,
          receiver,
        },
      });
      const unsignedTxn = encodeTransactionRaw(txn);
      const expectedPayload = Buffer.from(bytesForSigning.transaction(txn)).toString('base64');
      const rawUnsignedPayload = Buffer.from(unsignedTxn).toString('base64');
      const signature = new Uint8Array(64).fill(7);
      let observedRequest: any;

      const manager = new SessionManager();
      manager.setActive({
        transport: {} as never,
        client: {
          requestSignature: async (args: any) => {
            observedRequest = args;
            return {
              kind: 'response',
              message: {
                thid: 'x402-thread',
                body: {
                  signature: Buffer.from(signature).toString('base64'),
                  public_key: Buffer.from(sender.publicKey).toString('base64'),
                  address: sender.toString(),
                  key_type: 'account',
                },
              },
            };
          },
        } as never,
        controllerDid: publicKeyToDidKey(sender.publicKey),
        agentDid: STUB_AGENT_DID,
      });

      const signer = await createAc2AvmSigner({
        config: { defaultTimeoutMs: 2_000 },
        deps: { manager },
        getPaymentContext: () => ({
          requirements: {
            scheme: 'exact',
            network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
            asset: '10458941',
            amount: '123',
            payTo: receiver.toString(),
            maxTimeoutSeconds: 60,
            extra: {},
          },
          resource: {
            description: 'Weather data',
            url: 'https://example.x402.goplausible.xyz/avm/weather',
            mimeType: 'application/json',
          },
        }),
      });

      expect(signer.address).toBe(sender.toString());
      expect(capabilitiesFlow({}, { manager }).session.walletAddress).toBe(sender.toString());
      const signed = await signer.signTransactions([unsignedTxn], [0]);
      expect(signed).toHaveLength(1);
      expect(signed[0]).toBeInstanceOf(Uint8Array);

      const decoded = decodeSignedTransaction(signed[0]!);
      expect(decoded.txn.txId()).toBe(txn.txId());
      expect(decoded.txn.sender.toString()).toBe(sender.toString());
      expect(decoded.txn.genesisId).toBe('testnet-v1.0');
      expect(Buffer.from(decoded.txn.genesisHash ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(txn.genesisHash ?? new Uint8Array()).toString('base64'),
      );
      expect(decoded.txn.assetTransfer?.assetId).toBe(10_458_941n);
      expect(decoded.txn.assetTransfer?.amount).toBe(123n);
      expect(decoded.txn.assetTransfer?.receiver.toString()).toBe(receiver.toString());
      expect(Buffer.from(decoded.sig ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(signature).toString('base64'),
      );
      expect(observedRequest.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
      expect(observedRequest.body.sig_hint).toBe('transaction-algorand');
      expect(observedRequest.body.key_type).toBe('account');
      expect(observedRequest.body.payload).toBe(expectedPayload);
      expect(observedRequest.body.payload).not.toBe(rawUnsignedPayload);
      expect(observedRequest.body.description).toContain('Approve x402 payment for Weather data.');
      expect(observedRequest.body.description).toContain(
        'Resource: https://example.x402.goplausible.xyz/avm/weather · application/json',
      );
      expect(observedRequest.body.description).not.toContain(receiver.toString());
    });

    it('uses the linked AC2 wallet address as the x402 payment sender', async () => {
      const sender = new Address(new Uint8Array(32).fill(4));
      const receiver = new Address(new Uint8Array(32).fill(5));
      const txn = new Transaction({
        type: TransactionType.AssetTransfer,
        sender,
        fee: 1_000n,
        firstValid: 1n,
        lastValid: 1_000n,
        genesisHash: new Uint8Array(32).fill(3),
        genesisId: 'testnet-v1.0',
        assetTransfer: {
          assetId: 10_458_941n,
          amount: 1_000n,
          receiver,
        },
      });
      const signature = new Uint8Array(64).fill(8);
      let observedRequest: any;

      const manager = new SessionManager();
      manager.setActive({
        transport: {} as never,
        client: {
          requestSignature: async (args: any) => {
            observedRequest = args;
            return {
              kind: 'response',
              message: {
                thid: 'x402-wallet-address-thread',
                body: {
                  signature: Buffer.from(signature).toString('base64'),
                  public_key: Buffer.from(sender.publicKey).toString('base64'),
                  address: sender.toString(),
                  key_type: 'account',
                },
              },
            };
          },
        } as never,
        controllerDid: STUB_CONTROLLER_DID,
        walletAddress: sender.toString(),
        agentDid: STUB_AGENT_DID,
      });

      const signer = await createAc2AvmSigner({
        config: { defaultTimeoutMs: 2_000 },
        deps: { manager },
      });

      expect(signer.address).toBe(sender.toString());
      expect(capabilitiesFlow({}, { manager }).session.walletAddress).toBe(sender.toString());
      const signed = await signer.signTransactions([encodeTransactionRaw(txn)], [0]);
      expect(signed[0]).toBeInstanceOf(Uint8Array);
      const decoded = decodeSignedTransaction(signed[0]!);
      expect(decoded.txn.sender.toString()).toBe(sender.toString());
      expect(decoded.txn.genesisId).toBe('testnet-v1.0');
      expect(Buffer.from(decoded.txn.genesisHash ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(txn.genesisHash ?? new Uint8Array()).toString('base64'),
      );
      expect(decoded.txn.assetTransfer?.assetId).toBe(10_458_941n);
      expect(decoded.txn.assetTransfer?.amount).toBe(1_000n);
      expect(decoded.txn.assetTransfer?.receiver.toString()).toBe(receiver.toString());
      expect(Buffer.from(decoded.sig ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(signature).toString('base64'),
      );
      expect(observedRequest.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
      expect(observedRequest.body.sig_hint).toBe('transaction-algorand');
    });
  });

  /**
   * The x402 signer must work with NO in-process pairing session at all — the
   * situation in the agent/gateway process where tools actually execute, since
   * the daemon owns the wallet connection. Both halves are exercised: the payer
   * address comes from the daemon's connection facts, and each signature is
   * brokered through its generic `agent.request` passthrough.
   */
  describe('daemon-backed x402 signing', () => {
    /** Fake control client answering the status/connections + `agent.request` calls. */
    function fakeX402Connect(config: {
      reachable?: boolean;
      controllerDid?: string | null;
      walletAddress?: string | null;
      signature?: Uint8Array;
      publicKey?: Uint8Array;
      address?: string;
      rejectReason?: string;
      onParams?: (params: unknown) => void;
    }): () => Promise<any> {
      return async () => {
        if (config.reachable === false) return undefined;
        return {
          async request(method: string, params: unknown) {
            if (method === 'daemon.status') {
              return {
                connection: {
                  state: 'connected',
                  requestId: 'req-x402',
                  controllerDid: config.controllerDid ?? null,
                  walletAddress: config.walletAddress ?? null,
                  origin: 'https://example.test',
                  locked: false,
                },
              };
            }
            if (method === 'connections.list') {
              return { connections: [{ requestId: 'req-x402', agentDid: STUB_AGENT_DID }] };
            }
            if (method === 'agent.request') {
              config.onParams?.(params);
              if (config.rejectReason !== undefined) {
                return {
                  status: 'response',
                  message: {
                    type: 'ac2/SigningRejected',
                    from: config.controllerDid ?? STUB_CONTROLLER_DID,
                    to: [STUB_AGENT_DID],
                    thid: 'req-x402',
                    body: { reason: config.rejectReason },
                  },
                };
              }
              return {
                status: 'response',
                message: {
                  type: 'ac2/SigningResponse',
                  from: config.controllerDid ?? STUB_CONTROLLER_DID,
                  to: [STUB_AGENT_DID],
                  thid: 'req-x402',
                  body: {
                    signature: Buffer.from(config.signature ?? new Uint8Array(64).fill(9)).toString(
                      'base64',
                    ),
                    public_key: Buffer.from(config.publicKey ?? new Uint8Array(32)).toString(
                      'base64',
                    ),
                    ...(config.address !== undefined ? { address: config.address } : {}),
                    key_type: 'account',
                  },
                },
              };
            }
            throw new Error(`unexpected control method ${method}`);
          },
          close() {},
        };
      };
    }

    function buildTransferTxn(sender: Address, receiver: Address): Transaction {
      return new Transaction({
        type: TransactionType.AssetTransfer,
        sender,
        fee: 1_000n,
        firstValid: 1n,
        lastValid: 1_000n,
        genesisHash: new Uint8Array(32).fill(3),
        genesisId: 'testnet-v1.0',
        assetTransfer: { assetId: 10_458_941n, amount: 55n, receiver },
      });
    }

    it('signs a payment through the daemon with no local session', async () => {
      const sender = new Address(new Uint8Array(32).fill(11));
      const receiver = new Address(new Uint8Array(32).fill(12));
      const txn = buildTransferTxn(sender, receiver);
      const signature = new Uint8Array(64).fill(8);
      let seen: any;

      const signer = await createAc2AvmSigner({
        config: { defaultTimeoutMs: 2_000 },
        deps: {
          manager: new SessionManager(),
          connect: fakeX402Connect({
            controllerDid: publicKeyToDidKey(sender.publicKey),
            walletAddress: sender.toString(),
            signature,
            publicKey: sender.publicKey,
            address: sender.toString(),
            onParams: (p) => (seen = p),
          }),
        },
      });

      expect(signer.address).toBe(sender.toString());
      const signed = await signer.signTransactions([encodeTransactionRaw(txn)], [0]);
      const decoded = decodeSignedTransaction(signed[0]!);
      expect(decoded.txn.txId()).toBe(txn.txId());
      expect(Buffer.from(decoded.sig ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(signature).toString('base64'),
      );
      // The daemon received a proper AC2 signing request for the x402 bytes.
      expect(seen.type).toBe('ac2/SigningRequest');
      expect(seen.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
      expect(seen.body.sig_hint).toBe('transaction-algorand');
      expect(seen.body.payload).toBe(
        Buffer.from(bytesForSigning.transaction(txn)).toString('base64'),
      );
    });

    it('derives the payer address from the controller DID when the daemon reports none', async () => {
      const sender = new Address(new Uint8Array(32).fill(13));
      const signer = await createAc2AvmSigner({
        config: {},
        deps: {
          manager: new SessionManager(),
          connect: fakeX402Connect({
            controllerDid: publicKeyToDidKey(sender.publicKey),
            walletAddress: null,
          }),
        },
      });
      expect(signer.address).toBe(sender.toString());
    });

    it('surfaces a wallet decline as an x402 signing rejection', async () => {
      const sender = new Address(new Uint8Array(32).fill(14));
      const receiver = new Address(new Uint8Array(32).fill(15));
      const signer = await createAc2AvmSigner({
        config: {},
        deps: {
          manager: new SessionManager(),
          connect: fakeX402Connect({
            controllerDid: publicKeyToDidKey(sender.publicKey),
            walletAddress: sender.toString(),
            rejectReason: 'User declined',
          }),
        },
      });
      await expect(
        signer.signTransactions([encodeTransactionRaw(buildTransferTxn(sender, receiver))], [0]),
      ).rejects.toThrow(/User declined/);
    });

    it('rejects with no_active_session when neither a local session nor the daemon is available', async () => {
      await expect(
        createAc2AvmSigner({
          config: {},
          deps: { manager: new SessionManager(), connect: fakeX402Connect({ reachable: false }) },
        }),
      ).rejects.toBeInstanceOf(NoActiveSessionError);
    });
  });

  describe('x402 fetch tool response rendering', () => {
    it('includes successful JSON response bodies in visible tool content', () => {
      const text = describeX402Result({
        status: 'paid',
        url: 'https://example.test/weather',
        http: {
          status: 200,
          ok: true,
          statusText: 'OK',
          contentType: 'application/json',
        },
        bodyText: '{"temperature":72}',
        bodyJson: { temperature: 72 },
      });

      expect(text).toContain('x402 fetch succeeded with HTTP 200');
      expect(text).toContain('Response body');
      expect(text).toContain('"temperature": 72');
    });

    it('includes successful text response bodies in visible tool content', () => {
      const text = describeX402Result({
        status: 'paid',
        url: 'https://example.test/plain',
        http: {
          status: 200,
          ok: true,
          statusText: 'OK',
          contentType: 'text/plain',
        },
        bodyText: 'paid response body',
      });

      expect(text).toContain('```text');
      expect(text).toContain('paid response body');
    });
  });

  /**
   * The `pair` command no longer owns the wallet connection itself — it talks
   * to the standalone AC2 daemon over its control socket (see
   * `src/cli/ac2-command.ts`). These tests run a REAL daemon in-process
   * (mirroring `packages/ac2-cli/tests/broker.test.ts`) with the in-memory
   * channel provider standing in for the wallet, and drive the plugin's
   * `pair` command against it exactly as `openclaw ac2 pair` would.
   */
  describe('daemon-backed pair command', () => {
    /** In-memory keychain/metadata seams so the daemon never touches the OS keychain. */
    function createMemoryKeystoreOptions(stateDir: string): {
      keyring: { get: (a: string) => string | null; set: (a: string, s: string) => void; delete: (a: string) => boolean };
      metadata: { read: () => Uint8Array | null; write: (b: Uint8Array) => void; remove: () => void };
      migrateLegacy: false;
      stateDir: string;
    } {
      const entries = new Map<string, string>();
      let bytes: Uint8Array | null = null;
      return {
        keyring: {
          get: (a) => entries.get(a) ?? null,
          set: (a, s) => {
            entries.set(a, s);
          },
          delete: (a) => entries.delete(a),
        },
        metadata: {
          read: () => bytes,
          write: (b) => {
            bytes = b;
          },
          remove: () => {
            bytes = null;
          },
        },
        migrateLegacy: false,
        stateDir,
      };
    }

    /** Fake wallet: answers the bootstrap `KeyRequest` and records raw frames. */
    class FakeWalletProvider extends InMemoryChannelProvider {
      received: string[] = [];
      peerTransport: Ac2Transport | undefined;

      protected override onPairingPrepared(peerTransport: Ac2Transport): void {
        this.peerTransport = peerTransport;
        peerTransport.onMessage((msg) => {
          if (isKeyRequest(msg)) replyToBootstrap(msg, peerTransport);
        });
        peerTransport.onRawMessage?.((payload) => {
          this.received.push(payload);
        });
      }
    }

    /**
     * Wraps {@link FakeWalletProvider} to also report a `peer.wallet` account on
     * the paired channel — the daemon's controller-binding decision (`reuse` vs
     * `locked`) only fires when the live link names an account, so a locked
     * connection cannot be produced without it (mirrors `ac2-cli`'s broker test).
     */
    class ControllerWalletProvider extends FakeWalletProvider {
      constructor(
        private readonly walletAccount: string,
        opts: { origin?: string; requestId?: string },
      ) {
        super(opts);
      }

      override async startPairing(opts: Record<string, unknown> = {}): Promise<
        Awaited<ReturnType<InMemoryChannelProvider['startPairing']>>
      > {
        const handle = await super.startPairing(opts);
        return {
          ...handle,
          connect: async () => {
            const paired = await handle.connect();
            return { ...paired, peer: { wallet: this.walletAccount } };
          },
        };
      }
    }

    /** Build a minimal host `api` double sufficient to run `buildAc2Command(api).handler('pair')`. */
    function makeDaemonTestApi(): { api: any } {
      const api = {
        config: {},
        pluginConfig: { defaultTimeoutMs: 2_000 },
        logger: { info(): void {}, warn(): void {}, error(): void {} },
      };
      return { api };
    }

    async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    let homeDir: string;
    let stateDir: string;
    let previousHome: string | undefined;
    let previousStateDir: string | undefined;
    let previousSocket: string | undefined;
    let daemon: RunningDaemon | undefined;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'ac2-plugin-daemon-home-'));
      stateDir = await mkdtemp(join(tmpdir(), 'ac2-plugin-daemon-state-'));
      previousHome = process.env['AC2_HOME'];
      previousStateDir = process.env['AC2_STATE_DIR'];
      previousSocket = process.env['AC2_DAEMON_SOCKET'];
      process.env['AC2_HOME'] = homeDir;
      process.env['AC2_STATE_DIR'] = stateDir;
      process.env['AC2_DAEMON_SOCKET'] = join(homeDir, 'ac2d.sock');
      // `connectAgentSession` auto-starts the daemon when `daemonProcessStatus`
      // reports it isn't running (a pidfile check). This daemon is started
      // in-process below (no pidfile of its own), so a pidfile pointing at
      // THIS test process (trivially alive) is seeded to skip the spawn path
      // — the plugin then talks to the real in-process daemon over the socket
      // exactly as it would over a genuinely detached one.
      await writeFile(join(homeDir, 'ac2d.pid'), `${process.pid}\n`, 'utf8');
    });

    afterEach(async () => {
      sessionManager.clearActive();
      if (daemon) await daemon.stop();
      daemon = undefined;
      if (previousHome === undefined) delete process.env['AC2_HOME'];
      else process.env['AC2_HOME'] = previousHome;
      if (previousStateDir === undefined) delete process.env['AC2_STATE_DIR'];
      else process.env['AC2_STATE_DIR'] = previousStateDir;
      if (previousSocket === undefined) delete process.env['AC2_DAEMON_SOCKET'];
      else process.env['AC2_DAEMON_SOCKET'] = previousSocket;
      // `pair` sets AC2_RUNTIME as a side effect (see `ac2-command.ts`); this
      // in-process daemon never reads it (it's constructed with explicit
      // options, not env), but leaving it set would leak into later tests.
      delete process.env['AC2_RUNTIME'];
      await rm(homeDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    });

    it('pairs through the daemon: renders the QR, activates with the daemon-issued identity, sends outbound, then clears on disconnect', async () => {
      let wallet: FakeWalletProvider;
      daemon = await runDaemon({
        socketPath: process.env['AC2_DAEMON_SOCKET']!,
        keystore: createMemoryKeystoreOptions(stateDir) as never,
        handleSignals: false,
        hostKeystore: false,
        log: () => {},
        providerFactory: (requestId) => {
          wallet = new FakeWalletProvider({
            origin: 'https://debug.liquidauth.com',
            ...(requestId ? { requestId } : {}),
          });
          return wallet;
        },
      });

      const { api } = makeDaemonTestApi();
      const command = buildAc2Command(api) as {
        handler: (ctx: { args?: string }) => Promise<{ text: string; keepAlive?: boolean }>;
      };

      const result = await command.handler({ args: 'pair' });
      // QR rendered (as the plain-text pairing invitation, `qrcode-terminal`'s
      // ASCII rendering plus the raw pairing URL).
      expect(result.keepAlive).toBe(true);
      expect(result.text).toContain('AC2 Pairing Invitation');
      expect(result.text).toContain('Pairing URL:');

      // Session becomes active with the identity the DAEMON granted (from the
      // wallet's `KeyResponse`) — this plugin process never ran a bootstrap
      // itself.
      await waitFor(() => sessionManager.getActive() !== null);
      const active = sessionManager.getActive()!;
      expect(active.agentDid).toBe(STUB_AGENT_DID);
      expect(active.controllerDid).toBe(STUB_CONTROLLER_DID);
      expect(active.identityGranted).toBe(true);
      expect(active.locked).toBe(false);

      // NOTE: an inbound wallet message is no longer routed to an agent by this
      // plugin at all — the daemon's `message.inbound` delivery goes exclusively
      // to its active `openclaw-gateway` runtime adapter (see `daemon/run.ts`'s
      // `emitEvent`), never back out over this control-socket client. There is
      // therefore nothing left to assert here about inbound routing.

      // An outbound send over the active session's transport reaches the wallet.
      active.transport.send('hello from the agent');
      await waitFor(() => wallet!.received.includes('hello from the agent'));

      // A disconnect clears the active session; the daemon (not this plugin)
      // owns reconnect, so the command just waits for the next connection.
      // The clear is observed through a spy rather than by polling
      // `getActive() === null`, because the in-memory provider re-pairs and
      // re-connects *immediately* — the daemon's reconnect would race the poll
      // and re-activate the session before it could ever be seen as cleared.
      const originalClear = sessionManager.clearActive.bind(sessionManager);
      let cleared = 0;
      (sessionManager as unknown as { clearActive: () => void }).clearActive = () => {
        cleared += 1;
        originalClear();
      };
      try {
        wallet!.peerTransport!.close();
        await waitFor(() => cleared > 0);
      } finally {
        (sessionManager as unknown as { clearActive: () => void }).clearActive = originalClear;
      }
    });

    /**
     * `pair` run against a daemon that ALREADY has a linked wallet: the
     * `connection.connected` event fired before this process existed, so the
     * command must report the live session — with the invitation the daemon
     * keeps armed, because `pair` is exactly the command an operator uses to get
     * a code — and then EXIT (no `keepAlive`): there is no pairing to wait for,
     * and the daemon owns the connection without this process.
     */
    it('reports the live session and exits early when a wallet is already connected', async () => {
      let wallet: FakeWalletProvider;
      daemon = await runDaemon({
        socketPath: process.env['AC2_DAEMON_SOCKET']!,
        keystore: createMemoryKeystoreOptions(stateDir) as never,
        handleSignals: false,
        hostKeystore: false,
        log: () => {},
        providerFactory: (requestId) => {
          wallet = new FakeWalletProvider({
            origin: 'https://debug.liquidauth.com',
            ...(requestId ? { requestId } : {}),
          });
          return wallet;
        },
      });

      // Bring a wallet up through a SEPARATE control client (registered under a
      // different agent id so the plugin's own `openclaw` registration below is
      // not refused with `agent_taken`), then disconnect it — mimicking a prior
      // `pair` shell that has since exited while the daemon kept the session.
      const driver = await connectControl({
        path: process.env['AC2_DAEMON_SOCKET']!,
        timeoutMs: 2_000,
      });
      await driver.request('agent.hello', { agent: 'driver' });
      await driver.request('pair.start', {});
      const deadline = Date.now() + 3_000;
      for (;;) {
        const status = await driver.request('daemon.status', {});
        if (status.connection.state === 'connected') break;
        if (Date.now() > deadline) throw new Error('wallet did not connect in time');
        await new Promise((r) => setTimeout(r, 10));
      }
      driver.close();

      const { api } = makeDaemonTestApi();
      const command = buildAc2Command(api) as {
        handler: (ctx: {
          args?: string;
        }) => Promise<{ text: string; keepAlive?: boolean }>;
      };
      const result = await command.handler({ args: 'pair' });

      expect(result.text).toContain('already has an active wallet connection');
      expect(result.text).toContain(`Controller DID: ${STUB_CONTROLLER_DID}`);
      // The armed invitation is rendered even though nothing is "waiting".
      expect(result.text).toContain('AC2 Pairing Invitation');
      expect(result.text).toContain('Pairing URL:');
      expect(result.text).toContain('Nothing to do');
      // Exits early: the shell must not hold open (and must not print the
      // "Waiting for controller to pair..." banner).
      expect(result.keepAlive).toBeUndefined();

      // No local session is adopted — it would die with this process anyway.
      expect(sessionManager.getActive()).toBeNull();
    });

    it('a locked connection (different wallet already registered) produces the notice', async () => {
      const BOUND_CONTROLLER_DID = 'did:key:zBoundController';
      let wallet: ControllerWalletProvider;
      daemon = await runDaemon({
        socketPath: process.env['AC2_DAEMON_SOCKET']!,
        keystore: createMemoryKeystoreOptions(stateDir) as never,
        handleSignals: false,
        hostKeystore: false,
        log: () => {},
        providerFactory: (requestId) => {
          // Connects as `zOtherWallet`, i.e. NOT the bound controller below.
          wallet = new ControllerWalletProvider('zOtherWallet', {
            origin: 'https://debug.liquidauth.com',
            ...(requestId ? { requestId } : {}),
          });
          return wallet;
        },
      });
      // Pre-bind the agent to a DIFFERENT controller than the one that will
      // connect below, so the daemon refuses the takeover (`locked: true`).
      const { saveAc2State } = await import('@algorandfoundation/ac2-cli/identity');
      saveAc2State({
        identity: {
          agentDid: 'did:key:zBoundAgent',
          controllerDid: BOUND_CONTROLLER_DID,
          publicKey: 'unused',
        },
      });

      const { api } = makeDaemonTestApi();
      const command = buildAc2Command(api) as {
        handler: (ctx: { args?: string }) => Promise<{ text: string; keepAlive?: boolean }>;
      };
      await command.handler({ args: 'pair' });

      await waitFor(() => sessionManager.getActive() !== null);
      const active = sessionManager.getActive()!;
      expect(active.locked).toBe(true);
      expect(active.identityGranted).toBe(false);

      // The wallet is told it isn't registered (a `notice` control frame).
      await waitFor(() => wallet!.received.some((m) => m.includes('"code":"controller_locked"')));
    });
  });

  describe('heartbeat typing (OpenClaw channel-plugin hook)', () => {
    const STX = '\u0002';

    /** Minimal active session whose transport captures outbound frames. */
    function activateSpySession(): { sent: string[]; restore: () => void } {
      const sent: string[] = [];
      const transport = {
        isOpen: true,
        send: (payload: string) => {
          sent.push(payload);
        },
      } as unknown as Ac2Transport;
      const previous = sessionManager.getActive();
      sessionManager.setActive({
        transport,
        client: {} as never,
        controllerDid: STUB_CONTROLLER_DID,
        agentDid: STUB_AGENT_DID,
      });
      return {
        sent,
        restore: () => {
          if (previous) sessionManager.setActive(previous);
          else sessionManager.clearActive();
        },
      };
    }

    it('exposes heartbeat.sendTyping / heartbeat.clearTyping', () => {
      const channel = buildChannelObject() as {
        heartbeat?: { sendTyping?: unknown; clearTyping?: unknown };
      };
      expect(typeof channel.heartbeat?.sendTyping).toBe('function');
      expect(typeof channel.heartbeat?.clearTyping).toBe('function');
    });

    it('sendTyping emits a `typing` preview frame and clearTyping emits a `discard`', () => {
      const { sent, restore } = activateSpySession();
      try {
        const channel = buildChannelObject() as {
          heartbeat: {
            sendTyping: (t?: unknown) => void;
            clearTyping: (t?: unknown) => void;
          };
        };
        channel.heartbeat.sendTyping();
        channel.heartbeat.clearTyping();
        expect(sent).toHaveLength(2);
        expect(sent[0]!.startsWith(STX)).toBe(true);
        // Heartbeat typing rides the finalizer-driven live-preview protocol:
        // a `preview` (phase `typing`) draft, cleared by a `discard`. Both are
        // scoped to the active conversation thread (`default` with no thread).
        expect(JSON.parse(sent[0]!.slice(1))).toEqual({
          t: 'preview',
          thid: 'default',
          phase: 'typing',
        });
        expect(JSON.parse(sent[1]!.slice(1))).toEqual({ t: 'discard', thid: 'default' });
      } finally {
        restore();
      }
    });

    it('no-ops when no session is active', () => {
      const previous = sessionManager.getActive();
      sessionManager.clearActive();
      try {
        const channel = buildChannelObject() as {
          heartbeat: { sendTyping: (t?: unknown) => void };
        };
        expect(() => channel.heartbeat.sendTyping()).not.toThrow();
      } finally {
        if (previous) sessionManager.setActive(previous);
      }
    });

    it('ignores a target pointed at a different peer', () => {
      const { sent, restore } = activateSpySession();
      try {
        const channel = buildChannelObject() as {
          heartbeat: { sendTyping: (t?: unknown) => void };
        };
        channel.heartbeat.sendTyping({ to: { conversationId: 'did:key:zSomeoneElse' } });
        expect(sent).toHaveLength(0);
      } finally {
        restore();
      }
    });
  });

  describe('session grammar (messaging.resolveSessionConversation)', () => {
    it('exposes messaging.resolveSessionConversation on the channel object', () => {
      const channel = buildChannelObject() as {
        messaging?: { resolveSessionConversation?: unknown };
      };
      expect(typeof channel.messaging?.resolveSessionConversation).toBe('function');
    });

    it('maps a threaded id to base conversation + thread + ordered parents', () => {
      const did = 'did:key:zStubController';
      const result = resolveAc2SessionConversation(`${did}:thread-7`);
      expect(result.baseConversationId).toBe(did);
      expect(result.threadId).toBe('thread-7');
      // Narrowest (threaded) → broadest (base connection).
      expect(result.parentConversationCandidates).toEqual([`${did}:thread-7`, did]);
    });

    it('treats a bare DID (no thread) as the base conversation', () => {
      const did = 'did:key:zStubController';
      const result = resolveAc2SessionConversation(did);
      expect(result.baseConversationId).toBe(did);
      expect(result.threadId).toBeUndefined();
      expect(result.parentConversationCandidates).toEqual([did]);
    });

    it('collapses the `default` thread to the base conversation', () => {
      const did = 'did:key:zStubController';
      const result = resolveAc2SessionConversation(`${did}:default`);
      expect(result.baseConversationId).toBe(did);
      expect(result.threadId).toBeUndefined();
      expect(result.parentConversationCandidates).toEqual([did]);
    });

    it('tolerates a leading `ac2:` channel prefix on the raw id', () => {
      const did = 'did:key:zStubController';
      const result = resolveAc2SessionConversation(`ac2:${did}:thread-7`);
      expect(result.baseConversationId).toBe(did);
      expect(result.threadId).toBe('thread-7');
    });
  });

  describe('outbound routing (messaging.resolveOutboundSessionRoute)', () => {
    it('exposes messaging.resolveOutboundSessionRoute on the channel object', () => {
      const channel = buildChannelObject() as {
        messaging?: { resolveOutboundSessionRoute?: unknown };
      };
      expect(typeof channel.messaging?.resolveOutboundSessionRoute).toBe('function');
    });

    it('routes a bare DID target to the base session key (default thread)', () => {
      const did = 'did:key:zStubController';
      const route = resolveAc2OutboundSessionRoute({ target: did, from: 'did:key:zAgent' });
      expect(route.to).toBe(did);
      expect(route.sessionKey).toBe(`ac2:${did}`);
      expect(route.baseSessionKey).toBe(`ac2:${did}`);
      expect(route.threadId).toBeUndefined();
      expect(route.peer).toEqual({ kind: 'direct', id: did });
      expect(route.chatType).toBe('direct');
      expect(route.from).toBe('did:key:zAgent');
    });

    it('suffixes the session key with an explicit threadId', () => {
      const did = 'did:key:zStubController';
      const route = resolveAc2OutboundSessionRoute({
        target: did,
        from: 'did:key:zAgent',
        threadId: 'thread-7',
      });
      expect(route.sessionKey).toBe(`ac2:${did}:thread-7`);
      expect(route.baseSessionKey).toBe(`ac2:${did}`);
      expect(route.threadId).toBe('thread-7');
    });

    it('honors a thid encoded in the target and collapses the default thread', () => {
      const did = 'did:key:zStubController';
      expect(
        resolveAc2OutboundSessionRoute({ target: `${did}:thread-9`, from: 'a' }).sessionKey,
      ).toBe(`ac2:${did}:thread-9`);
      expect(
        resolveAc2OutboundSessionRoute({ target: `${did}:default`, from: 'a' }).sessionKey,
      ).toBe(`ac2:${did}`);
    });
  });

  describe('canonical session key (buildAc2SessionKey)', () => {
    const did = 'did:key:zStubController';

    it('collapses the default thread (and empty/undefined) to the bare base key', () => {
      expect(buildAc2SessionKey(did)).toBe(`ac2:${did}`);
      expect(buildAc2SessionKey(did, 'default')).toBe(`ac2:${did}`);
      expect(buildAc2SessionKey(did, '')).toBe(`ac2:${did}`);
    });

    it('suffixes an explicit (non-default) thread', () => {
      expect(buildAc2SessionKey(did, 'thread-7')).toBe(`ac2:${did}:thread-7`);
    });

    it('matches the outbound route for the same controller + thread', () => {
      expect(buildAc2SessionKey(did)).toBe(
        resolveAc2OutboundSessionRoute({ target: did, from: 'did:key:zAgent' }).sessionKey,
      );
      expect(buildAc2SessionKey(did, 'thread-7')).toBe(
        resolveAc2OutboundSessionRoute({ target: did, from: 'did:key:zAgent', threadId: 'thread-7' })
          .sessionKey,
      );
    });
  });

  describe('message adapter (OpenClaw channel-outbound contract)', () => {
    /** Minimal active session whose transport captures outbound frames. */
    function activate(): { sent: string[]; restore: () => void } {
      const sent: string[] = [];
      const transport = {
        isOpen: true,
        send: (payload: string) => {
          sent.push(payload);
        },
      } as unknown as Ac2Transport;
      const previous = sessionManager.getActive();
      sessionManager.setActive({
        transport,
        client: {} as never,
        controllerDid: STUB_CONTROLLER_DID,
        agentDid: STUB_AGENT_DID,
      });
      return {
        sent,
        restore: () => {
          if (previous) sessionManager.setActive(previous);
          else sessionManager.clearActive();
        },
      };
    }

    it('declares a text-only durableFinal capability set', () => {
      const channel = buildChannelObject() as {
        message?: { id?: string; durableFinal?: { capabilities?: Record<string, boolean> } };
      };
      expect(channel.message?.id).toBe('ac2');
      const caps = channel.message?.durableFinal?.capabilities;
      expect(caps?.text).toBe(true);
      // The DataChannel preserves none of these at the transport level.
      expect(caps?.replyTo).toBe(false);
      expect(caps?.thread).toBe(false);
      expect(caps?.media).toBe(false);
    });

    it('declares the full live-preview + finalizer lifecycle it owns', () => {
      const channel = buildChannelObject() as {
        message?: {
          live?: {
            capabilities?: Record<string, boolean>;
            finalizer?: { capabilities?: Record<string, boolean> };
          };
        };
      };
      const live = channel.message?.live?.capabilities;
      expect(live?.draftPreview).toBe(true);
      expect(live?.progressUpdates).toBe(true);
      expect(live?.nativeStreaming).toBe(true);
      // The agent now drives finalize explicitly (preview → finalize / discard),
      // so it owns in-place finalization.
      expect(live?.previewFinalization).toBe(true);
      expect(live?.quietFinalization).toBe(true);
      // Finalizer capabilities backing the explicit `finalize` / `discard`.
      const fin = channel.message?.live?.finalizer?.capabilities;
      expect(fin?.finalEdit).toBe(true);
      expect(fin?.discardPending).toBe(true);
      expect(fin?.previewReceipt).toBe(true);
      expect(fin?.normalFallback).toBe(true);
      expect(fin?.retainOnAmbiguousFailure).toBe(true);
    });

    it('declares an after_receive_record receive-ack policy', () => {
      const channel = buildChannelObject() as unknown as {
        message?: {
          receive?: { defaultAckPolicy?: string; supportedAckPolicies?: readonly string[] };
        };
      };
      // AC2 acks the moment it records the inbound message (the first
      // `preview` frame), which is the SDK's `after_receive_record` timing.
      expect(channel.message?.receive?.defaultAckPolicy).toBe('after_receive_record');
      expect(channel.message?.receive?.supportedAckPolicies).toContain('after_receive_record');
    });

    it('exposes media-source params via describeMessageTool as an action-keyed map', () => {
      const channel = buildChannelObject() as {
        describeMessageTool?: (descriptor?: unknown) => {
          mediaSourceParams?: Record<string, readonly string[]>;
        };
      };
      expect(typeof channel.describeMessageTool).toBe('function');
      const described = channel.describeMessageTool?.();
      const params = described?.mediaSourceParams;
      // Action-keyed map form (not a flat array) so each action only owns its
      // own media args.
      expect(params).toBeTypeOf('object');
      expect(Array.isArray(params)).toBe(false);
      expect(params).toBe(AC2_MEDIA_SOURCE_PARAMS);
      // Each declared action lists its own media param names.
      expect(params?.['send']).toEqual(['mediaUrl', 'mediaPath']);
      expect(params?.['share-artifact']).toEqual(['artifactUrl', 'artifactPath']);
      expect(params?.['share-qr']).toEqual(['qrUrl', 'qrPath']);
      // A plain `send` must not inherit another action's image params.
      expect(params?.['send']).not.toContain('qrUrl');
    });

    it('send.text delivers over the active transport and returns a MessageReceipt', async () => {
      const { sent, restore } = activate();
      try {
        const channel = buildChannelObject() as unknown as {
          message: {
            send: {
              text: (a: { to: string; text: string }) => Promise<{
                receipt: { primaryPlatformMessageId?: string; platformMessageIds: string[] };
              }>;
            };
          };
        };
        const { receipt } = await channel.message.send.text({
          to: STUB_CONTROLLER_DID,
          text: 'hello adapter',
        });
        expect(sent).toEqual(['hello adapter']);
        // Genuine SDK `MessageReceipt`: a primary id plus the platform id list.
        expect(typeof receipt.primaryPlatformMessageId).toBe('string');
        expect(receipt.platformMessageIds).toEqual([receipt.primaryPlatformMessageId]);
      } finally {
        restore();
      }
    });

    it('send.text rejects a conversationId that is not the active peer', async () => {
      const { restore } = activate();
      try {
        const channel = buildChannelObject() as unknown as {
          message: {
            send: { text: (a: { to: string; text: string }) => Promise<unknown> };
          };
        };
        await expect(
          channel.message.send.text({
            to: 'did:key:zSomeoneElse',
            text: 'nope',
          }),
        ).rejects.toThrow();
      } finally {
        restore();
      }
    });
  });

  // The old "chat surface on the ac2 channel" round-trip test lived here; it
  // exercised the embedded `runAc2Channel` chat wiring directly. Inbound chat
  // is no longer routed by this plugin at all — the daemon's `openclaw-gateway`
  // adapter owns the whole run/reply lifecycle now (see `ac2-command.ts`'s
  // `AC2_RUNTIME` commitment) — so there is no in-process round trip left to
  // cover here. The `daemon-backed pair command` suite above still covers
  // pairing/activation/outbound delivery/disconnect against a real daemon.
});
