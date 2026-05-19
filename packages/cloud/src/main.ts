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
// owns the orchestrator and starts it now so the reconcile loop ticks.
const hostRpc = new HostRpcClient({ sendHostRpc, logger });
const projectDomain = new ProjectDomain({
  db, hostRpc, hostRouter: hosts, clients, chat, logger,
});
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
