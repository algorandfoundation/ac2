/**
 * SDK wiring for the `ac2` channel's `ChannelMessageAdapterShape`,
 * live-preview / finalizer capabilities, and receive-ack policy. Built on
 * `openclaw/plugin-sdk/channel-outbound`.
 */

import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
  type ChannelMessageAdapter,
  type ChannelMessageAdapterShape,
  type ChannelMessageLiveCapability,
  type ChannelMessageReceiveAckPolicy,
  type LivePreviewFinalizerCapability,
  type LivePreviewFinalizerCapabilityMap,
  type MessageReceipt,
} from 'openclaw/plugin-sdk/channel-outbound';

export const AC2_CHANNEL_ID = 'ac2';

/** Durable send capabilities (`message.durable.final.capabilities`). */
export const AC2_DURABLE_FINAL_CAPABILITIES = {
  text: true,
  replyTo: false,
  thread: false,
  media: false,
  messageSendingHooks: false,
} as const;

/** Live-preview capabilities (`message.live.capabilities`). */
export const AC2_LIVE_CAPABILITIES: Partial<Record<ChannelMessageLiveCapability, boolean>> = {
  draftPreview: true,
  progressUpdates: true,
  nativeStreaming: true,
  previewFinalization: true,
  quietFinalization: true,
};

/** Live-preview finalizer capabilities (`message.live.finalizer.capabilities`). */
export const AC2_LIVE_FINALIZER_CAPABILITIES: LivePreviewFinalizerCapabilityMap = {
  finalEdit: true,
  normalFallback: true,
  discardPending: true,
  previewReceipt: true,
  retainOnAmbiguousFailure: true,
};

/** Receive ack policy (`message.receive.ack.policy`). */
export const AC2_DEFAULT_ACK_POLICY: ChannelMessageReceiveAckPolicy = 'after_receive_record';
export const AC2_SUPPORTED_ACK_POLICIES: readonly ChannelMessageReceiveAckPolicy[] = [
  'after_receive_record',
];

/** Build a `MessageReceipt` for one AC2 text send. */
export function buildAc2MessageReceipt(messageId: string, conversationId: string): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    kind: 'text',
    results: [{ channel: AC2_CHANNEL_ID, messageId, conversationId }],
  });
}

export { resolveMessageReceiptPrimaryId, listMessageReceiptPlatformIds };
export type {
  MessageReceipt,
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  LivePreviewFinalizerCapability,
};

/** Type-narrow wrapper around the SDK's `defineChannelMessageAdapter`. */
export function defineAc2MessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter {
  return defineChannelMessageAdapter(adapter) as ChannelMessageAdapter;
}

/** Run the SDK live-capability verifier against this adapter. */
export function verifyAc2LiveCapabilityProofs(
  adapter: Pick<ChannelMessageAdapterShape, 'live'>,
): Promise<
  Array<{ capability: ChannelMessageLiveCapability; status: 'verified' | 'not_declared' }>
> {
  return verifyChannelMessageLiveCapabilityAdapterProofs({
    adapterName: AC2_CHANNEL_ID,
    adapter,
    proofs: {
      draftPreview: () => {},
      progressUpdates: () => {},
      nativeStreaming: () => {},
      previewFinalization: () => {},
      quietFinalization: () => {},
    },
  });
}

/** Run the SDK live-finalizer verifier against this adapter. */
export function verifyAc2LiveFinalizerProofs(
  adapter: Pick<ChannelMessageAdapterShape, 'live'>,
): Promise<
  Array<{ capability: LivePreviewFinalizerCapability; status: 'verified' | 'not_declared' }>
> {
  return verifyChannelMessageLiveFinalizerProofs({
    adapterName: AC2_CHANNEL_ID,
    adapter,
    proofs: {
      finalEdit: () => {},
      normalFallback: () => {},
      discardPending: () => {},
      previewReceipt: () => {},
      retainOnAmbiguousFailure: () => {},
    },
  });
}

/** Run the SDK receive-ack-policy verifier against this adapter. */
export function verifyAc2ReceiveAckProofs(
  adapter: Pick<ChannelMessageAdapterShape, 'receive'>,
): Promise<Array<{ policy: ChannelMessageReceiveAckPolicy; status: 'verified' | 'not_declared' }>> {
  return verifyChannelMessageReceiveAckPolicyAdapterProofs({
    adapterName: AC2_CHANNEL_ID,
    adapter,
    proofs: {
      after_receive_record: () => {},
      after_agent_dispatch: () => {},
      after_durable_send: () => {},
      manual: () => {},
    },
  });
}
