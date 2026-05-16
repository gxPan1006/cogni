export type EmailTransportKind = "console" | "resend";

export interface Env {
  databaseUrl: string;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  port: number;
  emailTransport: EmailTransportKind;
  resendApiKey: string | null;       // required when emailTransport === "resend"
  emailFrom: string;                 // required when emailTransport === "resend"
  magicLinkTtlMinutes: number;       // default 15
}

export function loadEnv(): Env {
  const get = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
  };

  const portRaw = process.env.PORT ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${portRaw}" (must be an integer 1-65535)`);
  }

  const transportRaw = (process.env.EMAIL_TRANSPORT ?? "console").toLowerCase();
  if (transportRaw !== "console" && transportRaw !== "resend") {
    throw new Error(`Invalid EMAIL_TRANSPORT: "${transportRaw}" (must be "console" or "resend")`);
  }
  const emailTransport = transportRaw as EmailTransportKind;

  const resendApiKey = process.env.RESEND_API_KEY ?? null;
  const emailFrom = process.env.EMAIL_FROM ?? "Cogni <login@example.invalid>";
  if (emailTransport === "resend" && !resendApiKey) {
    throw new Error('EMAIL_TRANSPORT="resend" requires RESEND_API_KEY');
  }

  const ttlRaw = process.env.MAGIC_LINK_TTL_MIN ?? "15";
  const magicLinkTtlMinutes = Number(ttlRaw);
  if (!Number.isInteger(magicLinkTtlMinutes) || magicLinkTtlMinutes < 1 || magicLinkTtlMinutes > 60) {
    throw new Error(`Invalid MAGIC_LINK_TTL_MIN: "${ttlRaw}" (1-60)`);
  }

  return {
    databaseUrl: get("DATABASE_URL"),
    jwtSecret: get("JWT_SECRET"),
    googleClientId: get("GOOGLE_CLIENT_ID"),
    googleClientSecret: get("GOOGLE_CLIENT_SECRET"),
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
    port,
    emailTransport,
    resendApiKey,
    emailFrom,
    magicLinkTtlMinutes,
  };
}
