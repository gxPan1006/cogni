import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { makeDb } from "./db/client.js";
import { makeAuth } from "./auth.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
// SP-3: project domain + its host-RPC transport binding. main.ts composes
// both alongside ChatDomain; createServer() (route mounting) is Track C.
import { ProjectDomain } from "./domains/project/index.js";
import { HostRpcClient } from "./domains/project/host-rpc.js";
import { sendHostRpc } from "./routes/host-ws.js";
import { createServer } from "./server.js";
import { ConsoleTransport, ResendTransport, SmtpTransport, type EmailTransport } from "./email/transport.js";
import { logger } from "@cogni/shared";

const env = loadEnv();
const db = makeDb(env.databaseUrl);
const auth = makeAuth({
  jwtSecret: env.jwtSecret,
  google: {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: `${env.publicUrl}/auth/google/callback`,
  },
});
const hosts = new HostRouter();
const clients = new ClientHub();
const chat = new ChatDomain(db, hosts, clients);
// SP-3: HostRpcClient wraps the transport-level sendHostRpc (exported from
// routes/host-ws.ts where the WS connection registry lives). ProjectDomain
// owns the reconcile orchestrator and starts it now so the loop ticks.
// Disposed on shutdown so in-flight RPCs drain and reconcile timers stop.
const hostRpc = new HostRpcClient({ sendHostRpc, logger });
const projectDomain = new ProjectDomain({
  db, hostRpc, hostRouter: hosts, clients, chat, logger,
});
// SP-3 needs-input bridge: when ChatDomain sees a runner emit
// AskUserQuestion on a project-task thread, route it through ProjectDomain
// so the task lifecycle pauses at `needs-input` and the user can reply in
// the drawer. Hook is set post-construction because ChatDomain is built
// before ProjectDomain (ProjectDomain depends on ChatDomain.handleClientSend).
chat.onRunnerAskingForInput = (threadId, q) =>
  projectDomain.handleAskUserQuestion(threadId, q);
projectDomain.start();

const emailTransport: EmailTransport =
  env.emailTransport === "resend"
    ? new ResendTransport({ apiKey: env.resendApiKey!, from: env.emailFrom })
  : env.emailTransport === "smtp"
    ? new SmtpTransport({
        host: env.smtp!.host,
        port: env.smtp!.port,
        secure: env.smtp!.secure,
        user: env.smtp!.user,
        pass: env.smtp!.pass,
        from: env.emailFrom,
        ...(env.smtp!.tlsServername ? { tlsServername: env.smtp!.tlsServername } : {}),
      })
    : new ConsoleTransport();

const { app, injectWebSocket } = createServer({
  db, auth, hosts, clients, chat, projectDomain,
  emailTransport,
  magicLinkTtlMinutes: env.magicLinkTtlMinutes,
  publicUrl: env.publicUrl,
  webUrl: env.webUrl,
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) =>
  logger.info({ port: info.port, emailTransport: env.emailTransport }, "cloud control plane listening"),
);
injectWebSocket(server);

// Graceful shutdown — drain project domain reconcile + in-flight host RPCs
// before the process exits. SIGTERM is what `serve` sees from Docker / k8s.
const shutdown = async (sig: string) => {
  logger.info({ sig }, "shutting down");
  try {
    await projectDomain.dispose();
  } catch (err) {
    logger.warn({ err: String(err) }, "projectDomain dispose failed");
  }
  server.close(() => process.exit(0));
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
