import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { makeDb } from "./db/client.js";
import { makeAuth } from "./auth.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
import { ProjectDomain } from "./domains/project/index.js";
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
// SP-3: project domain orchestrator. Reconcile loop + host RPC bridge live
// inside it; constructor wiring matches Track B's class signature. Disposed
// on shutdown so in-flight RPCs drain and reconcile timers stop.
const projectDomain = new ProjectDomain({ db, hosts, clients });

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
  db, auth, hosts, clients, chat,
  projectDomain,
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
