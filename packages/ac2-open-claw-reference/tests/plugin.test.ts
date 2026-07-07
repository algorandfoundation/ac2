import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
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
import { Address } from '@algorandfoundation/algokit-utils/common';
import {
  bytesForSigning,
  decodeSignedTransaction,
  encodeTransactionRaw,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact';
import {
  signFlow,
  capabilitiesFlow,
  runAc2Channel,
  SessionManager,
  NoActiveSessionError,
  InMemoryChannelProvider,
  buildChannelObject,
  sessionManager,
  resolveAc2SessionConversation,
  resolveAc2OutboundSessionRoute,
  AC2_MEDIA_SOURCE_PARAMS,
  getToolPluginMetadata,
  pluginManifest as plugin,
  createAc2AvmSigner,
  X402_ALGORAND_SIGNING_SCHEMA,
  buildSignTool,
} from '../src/index.js';
import { describeX402Result } from '../src/tools/index.js';
import { publicKeyToDidKey } from '../src/identity/did.js';

/**
 * Stub controller DID used by the in-memory provider — the wallet's
 * `KeyResponse.from` is what the plugin locks in as `controllerDid`,
 * so this value flows through to every test that inspects the active
 * session.
 */
const STUB_CONTROLLER_DID = 'did:key:zStubController';
/** Stub identity public key returned in the bootstrap `KeyResponse`. */
const STUB_AGENT_PK = 'AgentIdentityPubKey';
const STUB_AGENT_DID = `did:key:${STUB_AGENT_PK}`;

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
          // material is the routing-restricted secret; tests don't need
          // it to be real — it just has to be a non-empty string per
          // the schema.
          material: 'stub-material',
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
 * Helper: boot the `ac2` channel in the background against a stub
 * provider and wait until it has registered an active session.
 * Returns the manager + a teardown that closes the channel cleanly.
 */
async function bootChannel(
  provider: InMemoryChannelProvider,
  extraContext: Partial<{
    receive: (text: string) => Promise<void>;
    onOutput: (handler: (text: string) => Promise<void>) => void;
  }> = {},
): Promise<{
  manager: SessionManager;
  done: Promise<void>;
  teardown: () => Promise<void>;
}> {
  const manager = new SessionManager();
  const abort = new AbortController();
  const done = runAc2Channel(
    { defaultTimeoutMs: 2_000 },
    { provider, renderQr: () => {}, manager },
    {
      signal: abort.signal,
      receive: extraContext.receive ?? (async () => {}),
      onOutput: extraContext.onOutput ?? (() => {}),
    },
  );
  for (let i = 0; i < 100 && !manager.getActive(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    manager,
    done,
    teardown: async () => {
      abort.abort();
      await done;
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

      const signer = createAc2AvmSigner({
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
        }),
      });

      expect(signer.address).toBe(sender.toString());
      const signed = await signer.signTransactions([unsignedTxn], [0]);
      expect(signed).toHaveLength(1);
      expect(signed[0]).toBeInstanceOf(Uint8Array);

      const decoded = decodeSignedTransaction(signed[0]!);
      expect(decoded.txn.txId()).toBe(txn.txId());
      expect(Buffer.from(decoded.sig ?? new Uint8Array()).toString('base64')).toBe(
        Buffer.from(signature).toString('base64'),
      );
      expect(observedRequest.body.schema).toBe(X402_ALGORAND_SIGNING_SCHEMA);
      expect(observedRequest.body.sig_hint).toBe('raw-ed25519');
      expect(observedRequest.body.key_type).toBe('account');
      expect(observedRequest.body.payload).toBe(expectedPayload);
      expect(observedRequest.body.payload).not.toBe(rawUnsignedPayload);
      expect(observedRequest.body.description).toContain('x402 exact payment');
      expect(observedRequest.body.description).toContain(receiver.toString());
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

      const signer = createAc2AvmSigner({
        config: { defaultTimeoutMs: 2_000 },
        deps: { manager },
      });

      expect(signer.address).toBe(sender.toString());
      const signed = await signer.signTransactions([encodeTransactionRaw(txn)], [0]);
      expect(signed[0]).toBeInstanceOf(Uint8Array);
      expect(observedRequest.body.description).toContain(`as ${sender.toString()}`);
      expect(observedRequest.body.description).toContain(`Sender: ${sender.toString()}`);
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

  describe('identity bootstrap', () => {
    it('derives agentDid + controllerDid from the wallet KeyResponse and only activates after bootstrap', async () => {
      let observedKeyRequest: KeyRequestMessage | undefined;
      const provider = new (class extends InMemoryChannelProvider {
        protected override onPairingPrepared(peerTransport: Ac2Transport): void {
          peerTransport.onMessage((msg) => {
            if (isKeyRequest(msg)) {
              observedKeyRequest = msg;
              replyToBootstrap(msg, peerTransport);
            }
          });
        }
      })();

      const { manager, teardown } = await bootChannel(provider);
      try {
        // Bootstrap KeyRequest must use the expected identity envelope.
        expect(observedKeyRequest).toBeDefined();
        expect(observedKeyRequest!.body.for_operation).toBe('ac2/identity');
        expect(observedKeyRequest!.body.key_type).toBe('ed25519');

        // Session is active and identity is wallet-derived, not hard-coded.
        const active = manager.getActive();
        expect(active).not.toBeNull();
        expect(active!.agentDid).toBe(STUB_AGENT_DID);
        expect(active!.controllerDid).toBe(STUB_CONTROLLER_DID);

        // capabilitiesFlow surfaces the wallet-derived DID.
        const caps = capabilitiesFlow({}, { manager });
        expect(caps.status).toBe('ok');
        expect(caps.agent.did).toBe(STUB_AGENT_DID);
        // The connected controller account is surfaced so the agent can
        // report who it is paired with (no hard-coded placeholder).
        expect(caps.session.controllerDid).toBe(STUB_CONTROLLER_DID);
      } finally {
        await teardown();
      }
    });

    it('keeps the channel open (no_active_session) and notifies the user when the wallet rejects the bootstrap KeyRequest', async () => {
      const peerRaw: string[] = [];
      const provider = new (class extends InMemoryChannelProvider {
        protected override onPairingPrepared(peerTransport: Ac2Transport): void {
          peerTransport.onMessage((msg) => {
            if (!isKeyRequest(msg)) return;
            peerTransport.send(
              JSON.stringify(
                buildKeyResponse({
                  request: msg,
                  from: STUB_CONTROLLER_DID,
                  body: {
                    status: 'rejected',
                    key_type: 'ed25519',
                    material: 'rejected',
                    public_key: 'rejected',
                    reason: 'user declined identity',
                  },
                }),
              ),
            );
          });
          // Capture the chat-surface notice the agent sends after a failed
          // bootstrap.
          peerTransport.onRawMessage?.((msg) => {
            peerRaw.push(msg);
          });
        }
      })();

      const manager = new SessionManager();
      const abort = new AbortController();
      const done = runAc2Channel(
        { defaultTimeoutMs: 2_000 },
        { provider, renderQr: () => {}, manager },
        {
          signal: abort.signal,
          receive: async () => {},
          onOutput: () => {},
        },
      );

      // Let the bootstrap round-trip + the no-identity notice flow.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // A rejected bootstrap is non-fatal: the session is never activated
      // (tools keep seeing `no_active_session`), but the channel stays open
      // so the user can still converse.
      expect(manager.getActive()).toBeNull();
      const caps = capabilitiesFlow({}, { manager });
      expect(caps.status).toBe('no_active_session');
      expect(caps.agent.did).toBeNull();

      // The user is told (over the chat surface) that an identity is needed.
      expect(peerRaw.some((m) => m.toLowerCase().includes('identity'))).toBe(true);

      // Aborting ends the still-open channel cleanly (it does not throw).
      abort.abort();
      await done;
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

  describe('chat surface on the ac2 channel', () => {
    it('round-trips raw chat messages while the channel is live', async () => {
      const receivedByController: string[] = [];
      const provider = new (class extends InMemoryChannelProvider {
        protected override onPairingPrepared(peerTransport: Ac2Transport): void {
          // Respond to the bootstrap KeyRequest so the session activates.
          peerTransport.onMessage((msg) => {
            if (isKeyRequest(msg)) replyToBootstrap(msg, peerTransport);
          });
          peerTransport.onRawMessage?.((msg) => {
            receivedByController.push(msg);
            peerTransport.send(`Echo: ${msg}`);
          });
        }
      })();

      const receivedByAgent: string[] = [];
      let outputHandler: ((text: string) => Promise<void>) | null = null;

      const { teardown } = await bootChannel(provider, {
        receive: async (text) => {
          receivedByAgent.push(text);
        },
        onOutput: (handler) => {
          outputHandler = handler;
        },
      });
      try {
        expect(outputHandler).not.toBeNull();
        await outputHandler!('Hello from Agent');
        // Give the in-memory transport a tick to deliver the echo.
        await new Promise((r) => setTimeout(r, 20));
        expect(receivedByController).toContain('Hello from Agent');
        expect(receivedByAgent).toContain('Echo: Hello from Agent');
      } finally {
        await teardown();
      }
    });
  });
});
