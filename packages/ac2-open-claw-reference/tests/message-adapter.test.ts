import { describe, expect, it } from 'vitest';

import { buildChannelObject } from '../src/index.js';
import {
  buildAc2MessageReceipt,
  defineAc2MessageAdapter,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
  verifyAc2LiveCapabilityProofs,
  verifyAc2LiveFinalizerProofs,
  verifyAc2ReceiveAckProofs,
  AC2_DEFAULT_ACK_POLICY,
  AC2_LIVE_CAPABILITIES,
  type ChannelMessageAdapterShape,
} from '../src/channel/message-adapter.js';

/**
 * Contract tests for the SDK-backed message adapter. These exercise the
 * genuine `openclaw/plugin-sdk/channel-outbound` factories + verifiers (the
 * package is a devDependency), so they prove the AC2 declarations are valid
 * against the real adapter contract rather than against hand-rolled stand-ins.
 */
describe('ac2 message adapter (SDK-backed)', () => {
  it('defineChannelMessageAdapter wrapping preserves the AC2 declaration', () => {
    const adapter = defineAc2MessageAdapter({
      id: 'ac2',
      durableFinal: { capabilities: { text: true } },
      live: { capabilities: { ...AC2_LIVE_CAPABILITIES } },
      receive: {
        defaultAckPolicy: AC2_DEFAULT_ACK_POLICY,
        supportedAckPolicies: [AC2_DEFAULT_ACK_POLICY],
      },
    }) as { id?: string; receive?: { defaultAckPolicy?: string } };
    expect(adapter.id).toBe('ac2');
    // The factory defaults receive to manual only when omitted; ours is kept.
    expect(adapter.receive?.defaultAckPolicy).toBe('after_receive_record');
  });

  it('buildAc2MessageReceipt produces a MessageReceipt the SDK id helpers read', () => {
    const receipt = buildAc2MessageReceipt('ac2-123', 'did:key:zController');
    const primary = resolveMessageReceiptPrimaryId(receipt);
    const ids = listMessageReceiptPlatformIds(receipt);
    expect(primary).toBe('ac2-123');
    expect(ids).toEqual(['ac2-123']);
  });

  it('verifyChannelMessageLiveCapabilityAdapterProofs verifies the declared live caps', async () => {
    const channel = buildChannelObject() as { message: ChannelMessageAdapterShape };
    const results = await verifyAc2LiveCapabilityProofs(channel.message);
    const byCap = new Map(results.map((r) => [r.capability, r.status]));
    // Declared (true) capabilities must come back verified…
    expect(byCap.get('draftPreview')).toBe('verified');
    expect(byCap.get('progressUpdates')).toBe('verified');
    expect(byCap.get('nativeStreaming')).toBe('verified');
    // The agent now drives finalize explicitly, so these are declared too.
    expect(byCap.get('previewFinalization')).toBe('verified');
    expect(byCap.get('quietFinalization')).toBe('verified');
  });

  it('verifyChannelMessageLiveFinalizerProofs verifies the declared finalizer caps', async () => {
    const channel = buildChannelObject() as { message: ChannelMessageAdapterShape };
    const results = await verifyAc2LiveFinalizerProofs(channel.message);
    const byCap = new Map(results.map((r) => [r.capability, r.status]));
    // Every finalizer capability backing the explicit `finalize` / `discard`
    // protocol must verify against the genuine SDK verifier.
    expect(byCap.get('finalEdit')).toBe('verified');
    expect(byCap.get('normalFallback')).toBe('verified');
    expect(byCap.get('discardPending')).toBe('verified');
    expect(byCap.get('previewReceipt')).toBe('verified');
    expect(byCap.get('retainOnAmbiguousFailure')).toBe('verified');
  });

  it('verifyChannelMessageReceiveAckPolicyAdapterProofs verifies the declared ack policy', async () => {
    const channel = buildChannelObject() as { message: ChannelMessageAdapterShape };
    const results = await verifyAc2ReceiveAckProofs(channel.message);
    const byPolicy = new Map(results.map((r) => [r.policy, r.status]));
    expect(byPolicy.get('after_receive_record')).toBe('verified');
    // Policies we do not support must not be reported as verified.
    expect(byPolicy.get('manual')).toBe('not_declared');
    expect(byPolicy.get('after_agent_dispatch')).toBe('not_declared');
  });
});
