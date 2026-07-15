/// <reference types="vitest/globals" />

import { createSigningRequest } from '../src/protocol';
import {
  createInMemoryTransportPair,
  rtcDataChannelTransport,
  type RtcDataChannelLike,
} from '../src/transport';

class TestDataChannel implements RtcDataChannelLike {
  readonly label = 'ac2-v1';
  readyState: RtcDataChannelLike['readyState'] = 'connecting';
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 'closed';
    this.onclose?.({});
  }
}

const message = createSigningRequest(
  {
    id: 'request-1',
    from: 'did:key:agent',
    to: ['did:key:controller'],
    created_time: 1,
  },
  { description: 'test', encoding: 'base64', payload: 'dGVzdA==' },
);

describe('rtcDataChannelTransport subscribers', () => {
  it('fans out every inbound and lifecycle event', () => {
    const channel = new TestDataChannel();
    const transport = rtcDataChannelTransport(channel);
    const seen: string[] = [];

    transport.onMessage(() => seen.push('message-1'));
    transport.onMessage(() => seen.push('message-2'));
    transport.onRawMessage?.(() => seen.push('raw-1'));
    transport.onRawMessage?.(() => seen.push('raw-2'));
    transport.onBinaryMessage?.(() => seen.push('binary-1'));
    transport.onBinaryMessage?.(() => seen.push('binary-2'));
    transport.onError(() => seen.push('error-1'));
    transport.onError(() => seen.push('error-2'));
    transport.onOpen(() => seen.push('open-1'));
    transport.onOpen(() => seen.push('open-2'));
    transport.onClose(() => seen.push('close-1'));
    transport.onClose(() => seen.push('close-2'));

    channel.onmessage?.({ data: JSON.stringify(message) });
    channel.onmessage?.({ data: 'chat' });
    channel.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    channel.onerror?.(new Error('boom'));
    channel.readyState = 'open';
    channel.onopen?.({});
    channel.close();

    expect(seen).toEqual([
      'message-1',
      'message-2',
      'raw-1',
      'raw-2',
      'binary-1',
      'binary-2',
      'error-1',
      'error-2',
      'open-1',
      'open-2',
      'close-1',
      'close-2',
    ]);
  });

  it('immediately notifies late open and close subscribers', () => {
    const channel = new TestDataChannel();
    channel.readyState = 'open';
    const transport = rtcDataChannelTransport(channel);
    let opened = 0;
    let closed = 0;

    transport.onOpen(() => opened++);
    channel.close();
    transport.onClose(() => closed++);

    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it('returns idempotent disposers that stop every event category', () => {
    const channel = new TestDataChannel();
    const transport = rtcDataChannelTransport(channel);
    const seen: string[] = [];
    const subscriptions = [
      transport.onMessage(() => seen.push('message')),
      transport.onRawMessage(() => seen.push('raw')),
      transport.onBinaryMessage(() => seen.push('binary')),
      transport.onError(() => seen.push('error')),
      transport.onOpen(() => seen.push('open')),
      transport.onClose(() => seen.push('close')),
    ];

    for (const subscription of subscriptions) {
      expect(subscription).toBeTypeOf('function');
      subscription();
      subscription();
    }

    channel.onmessage?.({ data: JSON.stringify(message) });
    channel.onmessage?.({ data: 'chat' });
    channel.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    channel.onerror?.(new Error('boom'));
    channel.readyState = 'open';
    channel.onopen?.({});
    channel.close();

    expect(seen).toEqual([]);
  });
});

describe('in-memory transport subscribers', () => {
  it('fans out message, raw, binary, error, open, and close events', async () => {
    const [sender, receiver] = createInMemoryTransportPair();
    const seen: string[] = [];

    receiver.onMessage(() => seen.push('message-1'));
    receiver.onMessage(() => seen.push('message-2'));
    receiver.onRawMessage?.(() => seen.push('raw-1'));
    receiver.onRawMessage?.(() => seen.push('raw-2'));
    receiver.onBinaryMessage?.(() => seen.push('binary-1'));
    receiver.onBinaryMessage?.(() => seen.push('binary-2'));
    receiver.onError(() => seen.push('error-1'));
    receiver.onError(() => seen.push('error-2'));
    receiver.onOpen(() => seen.push('open-1'));
    receiver.onOpen(() => seen.push('open-2'));
    receiver.onClose(() => seen.push('close-1'));
    receiver.onClose(() => seen.push('close-2'));

    sender.send(JSON.stringify(message));
    sender.send('chat');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const internals = receiver as unknown as {
      _deliver(payload: ArrayBuffer): void;
      _error(error: Error): void;
    };
    internals._deliver(new Uint8Array([1, 2, 3]).buffer);
    internals._error(new Error('boom'));
    receiver.close();

    expect(seen).toEqual([
      'open-1',
      'open-2',
      'message-1',
      'message-2',
      'raw-1',
      'raw-2',
      'binary-1',
      'binary-2',
      'error-1',
      'error-2',
      'close-1',
      'close-2',
    ]);
  });

  it('returns idempotent disposers that stop delivery', async () => {
    const [sender, receiver] = createInMemoryTransportPair();
    const seen: string[] = [];
    const subscriptions = [
      receiver.onMessage(() => seen.push('message')),
      receiver.onRawMessage(() => seen.push('raw')),
      receiver.onBinaryMessage(() => seen.push('binary')),
      receiver.onError(() => seen.push('error')),
      receiver.onOpen(() => seen.push('open')),
      receiver.onClose(() => seen.push('close')),
    ];

    // onOpen fires immediately for the already-open in-memory transport.
    expect(seen).toEqual(['open']);
    seen.length = 0;
    for (const subscription of subscriptions) {
      expect(subscription).toBeTypeOf('function');
      subscription();
      subscription();
    }

    sender.send(JSON.stringify(message));
    sender.send('chat');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const internals = receiver as unknown as {
      _deliver(payload: ArrayBuffer): void;
      _error(error: Error): void;
    };
    internals._deliver(new Uint8Array([1, 2, 3]).buffer);
    internals._error(new Error('boom'));
    receiver.close();

    expect(seen).toEqual([]);
  });
});
