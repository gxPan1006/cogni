import { describe, it, expect, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { makeTestDb } from "./db/test-db.js";
import { findOrCreateUserByEmail } from "./db/users.js";
import { createThread, getThreadDetail, appendMessage } from "./db/threads.js";
import { createHost } from "./db/hosts.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
import { FakeTransport } from "./email/transport.js";
import { makeAuth } from "./auth.js";
import { createServer } from "./server.js";

/**
 * A non-dropping message reader: attaches a persistent `message` listener up
 * front, buffers every frame, and hands them out one at a time via `next()`.
 * The server fans messages out faster than a re-attached `ws.once()` could
 * keep up, so a buffer (not a fresh listener per read) is required to avoid a
 * listener-attach race that silently drops frames.
 */
function reader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(String(d));
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    next(): Promise<any> {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((res) => waiters.push(res));
    },
  };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
});

describe("cloud server e2e (headless spine)", () => {
  it("client send → host dispatch → events back → persisted assistant message", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const hostReg = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Mac" });
    const auth = makeAuth({
      jwtSecret: "test-secret-test-secret-test-sec",
      google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
    });
    // SP-2: every JWT carries an auth_session id; create one for this test.
    const { createAuthSession } = await import("./db/auth-sessions.js");
    const session = await createAuthSession(db, {
      userId: user.id,
      deviceName: "test e2e",
    });
    const jwt = await auth.issueToken({
      userId: user.id, tenantId: user.tenantId, sessionId: session.id,
    });

    const hosts = new HostRouter();
    const clients = new ClientHub();
    const chat = new ChatDomain(db, hosts, clients);
    const { app, injectWebSocket } = createServer({
      db,
      auth,
      hosts,
      clients,
      chat,
      emailTransport: new FakeTransport(),
      magicLinkTtlMinutes: 15,
      publicUrl: "http://localhost",
      webUrl: "https://chat.ai-cognit.com",
    });
    // `serve()` calls `server.listen()` and returns synchronously — the TCP
    // socket isn't bound yet. Reading `server.address()` immediately can race
    // against the actual listen, and under full-suite CPU pressure (other
    // workers running pglite/WASM) the gap is wide enough that the WS connect
    // below races to a not-yet-listening port → ECONNREFUSED 127.0.0.1:<port>.
    // Wait on the listening callback to get the bound address, eliminating the
    // race. Also pin to `127.0.0.1` so the WS client doesn't fall through the
    // localhost dual-stack resolver (::1 + 127.0.0.1) which masks errors as
    // ECONNRESET on the IPv6 leg.
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    injectWebSocket(server);
    stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const port = (server.address() as { port: number }).port;

    // fake Runner Host connects + registers
    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/host/ws?token=${hostReg.registrationToken}`);
    const host = reader(hostWs);
    await new Promise((r) => hostWs.once("open", r));
    hostWs.send(
      JSON.stringify({
        t: "register",
        hostId: hostReg.hostId,
        capabilities: ["streaming"],
        adapters: ["claude-code"],
        version: "0.0.0",
      }),
    );
    expect((await host.next()).t).toBe("registered");

    // fake UI client connects + subscribes
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${jwt}`);
    const client = reader(clientWs);
    await new Promise((r) => clientWs.once("open", r));
    clientWs.send(JSON.stringify({ t: "subscribe", threadId: thread.id }));
    expect(await client.next()).toMatchObject({ t: "host-status", online: true });

    // client sends a message → host receives a dispatch
    clientWs.send(JSON.stringify({ t: "send", threadId: thread.id, text: "hi" }));
    const dispatch = await host.next();
    expect(dispatch).toMatchObject({
      t: "dispatch",
      threadId: thread.id,
      message: "hi",
      runnerSessionId: null,
    });

    // host streams a turn back
    const sid = dispatch.sessionId;
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "session-id", id: "claude-1" } }));
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "text", text: "hello" } }));
    hostWs.send(JSON.stringify({ t: "event", sessionId: sid, event: { type: "done" } }));

    // client receives the user message echo, the events, and the assistant message
    const received: any[] = [];
    for (let i = 0; i < 5; i++) received.push(await client.next());
    const types = received.map((m) => `${m.t}:${m.event?.type ?? m.role ?? ""}`);
    expect(types).toContain("message:user");
    expect(types).toContain("event:session-id");
    expect(types).toContain("event:done");
    expect(types).toContain("message:assistant");

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello",
    ]);

    hostWs.close();
    clientWs.close();
    // Drain the HTTP server, then close the db. The WS onClose handlers fire
    // asynchronously and may still touch the db after this — that's caught and
    // warn-logged by host-ws's onClose, harmless test-teardown noise.
    await stop?.();
    stop = undefined;
    await close();
  });

  // C: a cold subscribe-thread (lastSeq 0) seeds the message history over the
  // WS itself, so the client doesn't need a separate (cold, ~1s) HTTP getThread.
  it("subscribe-thread (cold) replays message history as a thread-snapshot", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "snap@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await appendMessage(db, { threadId: thread.id, role: "user", content: "first" });
    await appendMessage(db, { threadId: thread.id, role: "assistant", content: "reply" });

    const auth = makeAuth({
      jwtSecret: "test-secret-test-secret-test-sec",
      google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
    });
    const { createAuthSession } = await import("./db/auth-sessions.js");
    const session = await createAuthSession(db, { userId: user.id, deviceName: "test snap" });
    const jwt = await auth.issueToken({
      userId: user.id, tenantId: user.tenantId, sessionId: session.id,
    });

    const hosts = new HostRouter();
    const clients = new ClientHub();
    const chat = new ChatDomain(db, hosts, clients);
    const { app, injectWebSocket } = createServer({
      db, auth, hosts, clients, chat,
      emailTransport: new FakeTransport(),
      magicLinkTtlMinutes: 15,
      publicUrl: "http://localhost",
      webUrl: "https://chat.ai-cognit.com",
    });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    injectWebSocket(server);
    stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const port = (server.address() as { port: number }).port;

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${jwt}`);
    const client = reader(clientWs);
    await new Promise((r) => clientWs.once("open", r));
    clientWs.send(JSON.stringify({ t: "subscribe-thread", threadId: thread.id }));

    // The snapshot must arrive (before catchup-complete) carrying both messages
    // in the same MessageView shape the HTTP getThread returns.
    const snap = await client.next();
    expect(snap).toMatchObject({ t: "thread-snapshot", threadId: thread.id });
    expect(snap.messages.map((m: any) => `${m.role}:${m.content}`)).toEqual([
      "user:first",
      "assistant:reply",
    ]);
    expect(await client.next()).toMatchObject({ t: "catchup-complete", threadId: thread.id });

    clientWs.close();
    await stop?.();
    stop = undefined;
    await close();
  });

  // Heartbeat: the client pings to keep the (proxied) socket warm; the cloud
  // must answer with a pong so the client can tell the connection is alive.
  it("answers a client ping with a pong", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "ping@x.com");
    const auth = makeAuth({
      jwtSecret: "test-secret-test-secret-test-sec",
      google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
    });
    const { createAuthSession } = await import("./db/auth-sessions.js");
    const session = await createAuthSession(db, { userId: user.id, deviceName: "ping" });
    const jwt = await auth.issueToken({
      userId: user.id, tenantId: user.tenantId, sessionId: session.id,
    });
    const hosts = new HostRouter();
    const clients = new ClientHub();
    const chat = new ChatDomain(db, hosts, clients);
    const { app, injectWebSocket } = createServer({
      db, auth, hosts, clients, chat,
      emailTransport: new FakeTransport(),
      magicLinkTtlMinutes: 15,
      publicUrl: "http://localhost",
      webUrl: "https://chat.ai-cognit.com",
    });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    injectWebSocket(server);
    stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const port = (server.address() as { port: number }).port;

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${jwt}`);
    const client = reader(clientWs);
    await new Promise((r) => clientWs.once("open", r));
    clientWs.send(JSON.stringify({ t: "ping" }));
    expect(await client.next()).toMatchObject({ t: "pong" });

    clientWs.close();
    await stop?.();
    stop = undefined;
    await close();
  });
});
