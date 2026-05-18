/**
 * @vitest-environment node
 *
 * The point of these tests is to lock in the lifetime contract: switching the
 * set of subscribed threads must NOT churn the underlying WebSocket. Earlier
 * useThreadStream tore down the socket on every threadId change, which made
 * the "重连中" pill flash on every sidebar click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudToClient } from "@cogni/contract";
import { createWsClient } from "./ws-client.js";

// Minimal hand-rolled WebSocket stub. Mirrors only the surface ws-client uses.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("send() on non-open socket");
    }
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── helpers driven by tests ────────────────────────────────────────────
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(frame: CloudToClient) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  fireServerClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  parsedSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

let originalWebSocket: typeof globalThis.WebSocket | undefined;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = originalWebSocket;
});

describe("createWsClient — multiplexed connection lifetime", () => {
  it("does not open a second WebSocket when subscriptions change", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    const unsubA = client.subscribeThread({
      threadId: "tA", getLastSeq: () => 0, onFrame: handlerA,
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();
    expect(client.isConnected()).toBe(true);

    unsubA();
    client.subscribeThread({
      threadId: "tB", getLastSeq: () => 0, onFrame: handlerB,
    });

    // Same socket — switching threads must NOT trigger a reconnect.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.isConnected()).toBe(true);

    // Subscribe/unsubscribe frames flowed over the same socket.
    expect(sock.parsedSent()).toEqual([
      { t: "subscribe-thread", threadId: "tA", lastSeq: 0 },
      { t: "unsubscribe-thread", threadId: "tA" },
      { t: "subscribe-thread", threadId: "tB", lastSeq: 0 },
    ]);
    client.close();
  });

  it("routes per-thread frames to the matching subscriber only", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    client.subscribeThread({ threadId: "tA", getLastSeq: () => 0, onFrame: handlerA });
    client.subscribeThread({ threadId: "tB", getLastSeq: () => 0, onFrame: handlerB });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage({ t: "event", threadId: "tA", seq: 1, event: { type: "text", text: "hi" } });
    sock.fireMessage({ t: "host-fallback-prompt", threadId: "tB", pendingMessageId: "p1",
      preferred: { id: "h1", name: "Home", lastSeenAgoMs: 1 },
      alternatives: [{ id: "h2", name: "Work", lastSeenAgoMs: 1 }] });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0]![0]).toMatchObject({ t: "event", threadId: "tA" });
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB.mock.calls[0]![0]).toMatchObject({ t: "host-fallback-prompt", threadId: "tB" });
    client.close();
  });

  it("fans user-wide frames out to every active subscriber", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    client.subscribeThread({ threadId: "tA", getLastSeq: () => 0, onFrame: handlerA });
    client.subscribeThread({ threadId: "tB", getLastSeq: () => 0, onFrame: handlerB });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage({ t: "host-status", online: false });
    expect(handlerA).toHaveBeenCalledWith({ t: "host-status", online: false });
    expect(handlerB).toHaveBeenCalledWith({ t: "host-status", online: false });
    client.close();
  });

  it("re-emits subscribe-thread with latest lastSeq on reconnect", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    let seqA = 5;
    const handlerA = vi.fn();
    client.subscribeThread({
      threadId: "tA",
      getLastSeq: () => seqA,
      onFrame: handlerA,
    });
    const sock1 = FakeWebSocket.instances[0]!;
    sock1.fireOpen();
    // First subscribe sent with the initial seq.
    expect(sock1.parsedSent()[0]).toEqual({ t: "subscribe-thread", threadId: "tA", lastSeq: 5 });

    // Receive an event, advance seq.
    seqA = 42;
    sock1.fireServerClose();
    expect(client.isConnected()).toBe(false);

    // The reconnect timer fires; a fresh FakeWebSocket appears.
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const sock2 = FakeWebSocket.instances[1]!;
    sock2.fireOpen();
    expect(client.isConnected()).toBe(true);
    // The reconnect resubscribes with the latest seq, not the initial one.
    expect(sock2.parsedSent()).toEqual([
      { t: "subscribe-thread", threadId: "tA", lastSeq: 42 },
    ]);
    client.close();
  });

  it("connection listeners observe the actual open/close edges only", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const seen: boolean[] = [];
    client.onConnectionChange((c) => seen.push(c));

    client.subscribeThread({ threadId: "tA", getLastSeq: () => 0, onFrame: () => {} });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    // Switching subscriptions must not toggle connected.
    client.subscribeThread({ threadId: "tB", getLastSeq: () => 0, onFrame: () => {} });
    client.subscribeThread({ threadId: "tC", getLastSeq: () => 0, onFrame: () => {} });

    expect(seen).toEqual([true]);

    sock.fireServerClose();
    expect(seen).toEqual([true, false]);
    client.close();
  });

  it("close() stops the reconnect loop", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    client.subscribeThread({ threadId: "tA", getLastSeq: () => 0, onFrame: () => {} });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();
    client.close();
    sock.fireServerClose();
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no new socket spawned
  });
});
