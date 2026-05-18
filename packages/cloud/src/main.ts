import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { makeDb } from "./db/client.js";
import { makeAuth } from "./auth.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
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
  emailTransport,
  magicLinkTtlMinutes: env.magicLinkTtlMinutes,
  publicUrl: env.publicUrl,
  webUrl: env.webUrl,
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) =>
  logger.info({ port: info.port, emailTransport: env.emailTransport }, "cloud control plane listening"),
);
injectWebSocket(server);
