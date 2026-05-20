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

  it("fans host-status / host-meta out to the LIST subscriber (sidebar host count)", () => {
    // Regression: the web Shell only subscribes via subscribeList to keep its
    // sidebar (threads + host count) live. host-status / host-meta are
    // user-wide signals it needs, but the dispatcher used to fan them only to
    // thread / project / task subs — so the host online count never updated
    // after the first HTTP fetch (HOSTS 0/1 stuck).
    const client = createWsClient(() => "ws://test/api/ws");
    const listHandler = vi.fn();
    client.subscribeList({ onFrame: listHandler });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage({ t: "host-status", online: true });
    sock.fireMessage({
      t: "host-meta", hostId: "h1", name: "Mac", status: "online", lastSeen: "2026-05-20T00:00:00Z",
    });
    expect(listHandler).toHaveBeenCalledWith({ t: "host-status", online: true });
    expect(listHandler).toHaveBeenCalledWith({
      t: "host-meta", hostId: "h1", name: "Mac", status: "online", lastSeen: "2026-05-20T00:00:00Z",
    });
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

describe("createWsClient — SP-3 project / task channels", () => {
  // Minimal fixture rows; only the fields the dispatcher routes on are real
  // (id / projectId). Cast through `as any` to satisfy the wide ProjectTask /
  // Project schemas without inlining every nullable field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeTask = (id: string, projectId: string): any => ({ id, projectId, ref: id, title: id, description: null, state: "queued", priority: 3, labels: [], orderIndex: "1", hostId: null, adapter: null, worktreePath: null, branchName: null, executionThreadId: null, retries: 0, maxRetries: 3, needsInputWhat: null, createdAt: "", updatedAt: "", startedAt: null, completedAt: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeProject = (id: string): any => ({ id, tenantId: "t", userId: "u", name: id, description: null, repoPath: "/r", defaultHostId: "h", threadId: null, mergePolicy: "require-review", testCommand: null, concurrencyLimit: 2, systemPrompt: null, archivedAt: null, createdAt: "", updatedAt: "" });

  it("subscribe-projects: emits frame once, fans out, unsub on last detach", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    const unsubA = client.subscribeProjects({ onFrame: handlerA });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();
    // Second listener on same channel must NOT trigger a second subscribe-projects.
    const unsubB = client.subscribeProjects({ onFrame: handlerB });

    expect(sock.parsedSent()).toEqual([{ t: "subscribe-projects" }]);

    sock.fireMessage({ t: "project-event", kind: "created", project: fakeProject("p1") });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    // Detaching one listener must not emit unsubscribe-projects yet.
    unsubA();
    expect(sock.parsedSent()).toEqual([{ t: "subscribe-projects" }]);

    // Detaching the last listener emits unsubscribe-projects.
    unsubB();
    expect(sock.parsedSent()).toEqual([
      { t: "subscribe-projects" },
      { t: "unsubscribe-projects" },
    ]);
    client.close();
  });

  it("subscribe-project routes task-event by projectId", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handlerP1 = vi.fn();
    const handlerP2 = vi.fn();
    client.subscribeProject({ projectId: "p1", onFrame: handlerP1 });
    client.subscribeProject({ projectId: "p2", onFrame: handlerP2 });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage({ t: "task-event", kind: "created", task: fakeTask("T1", "p1") });
    sock.fireMessage({ t: "task-event", kind: "state-changed", task: fakeTask("T2", "p2") });

    expect(handlerP1).toHaveBeenCalledTimes(1);
    expect(handlerP1.mock.calls[0]![0]).toMatchObject({ t: "task-event", task: { id: "T1" } });
    expect(handlerP2).toHaveBeenCalledTimes(1);
    expect(handlerP2.mock.calls[0]![0]).toMatchObject({ t: "task-event", task: { id: "T2" } });
    client.close();
  });

  it("subscribe-task: filters by taskId and unsub frames travel exactly once", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    const handler = vi.fn();
    const unsub = client.subscribeTask({ taskId: "T9", onFrame: handler });
    const sock = FakeWebSocket.instances[0]!;
    sock.fireOpen();

    sock.fireMessage({ t: "task-event", kind: "updated", task: fakeTask("T9", "pX") });
    sock.fireMessage({ t: "task-event", kind: "updated", task: fakeTask("T8", "pX") });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    expect(sock.parsedSent()).toEqual([
      { t: "subscribe-task", taskId: "T9" },
      { t: "unsubscribe-task", taskId: "T9" },
    ]);
    client.close();
  });

  it("re-emits SP-3 subscriptions on reconnect", () => {
    const client = createWsClient(() => "ws://test/api/ws");
    client.subscribeProjects({ onFrame: () => {} });
    client.subscribeProject({ projectId: "pA", onFrame: () => {} });
    client.subscribeTask({ taskId: "T1", onFrame: () => {} });
    const sock1 = FakeWebSocket.instances[0]!;
    sock1.fireOpen();
    expect(sock1.parsedSent()).toEqual([
      { t: "subscribe-projects" },
      { t: "subscribe-project", projectId: "pA" },
      { t: "subscribe-task", taskId: "T1" },
    ]);

    sock1.fireServerClose();
    vi.advanceTimersByTime(1_000);
    const sock2 = FakeWebSocket.instances[1]!;
    sock2.fireOpen();
    expect(sock2.parsedSent()).toEqual([
      { t: "subscribe-projects" },
      { t: "subscribe-project", projectId: "pA" },
      { t: "subscribe-task", taskId: "T1" },
    ]);
    client.close();
  });
});
