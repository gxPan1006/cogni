export type EmailTransportKind = "console" | "resend" | "smtp";

export interface SmtpConfig {
  host: string;
  port: number;
  /** true ⇔ implicit SSL (port 465); false ⇔ STARTTLS (port 587). */
  secure: boolean;
  user: string;
  pass: string;
  /** Optional SNI override; set when SMTP_HOST is a tunnel endpoint (see SmtpOpts). */
  tlsServername: string | null;
}

export interface Env {
  databaseUrl: string;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  port: number;
  emailTransport: EmailTransportKind;
  resendApiKey: string | null;       // required when emailTransport === "resend"
  smtp: SmtpConfig | null;           // required when emailTransport === "smtp"
  emailFrom: string;                 // required when emailTransport ∈ {resend, smtp}
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
  if (transportRaw !== "console" && transportRaw !== "resend" && transportRaw !== "smtp") {
    throw new Error(`Invalid EMAIL_TRANSPORT: "${transportRaw}" (must be "console", "resend", or "smtp")`);
  }
  const emailTransport = transportRaw as EmailTransportKind;

  const resendApiKey = process.env.RESEND_API_KEY ?? null;
  const emailFrom = process.env.EMAIL_FROM ?? "Cogni <login@example.invalid>";
  if (emailTransport === "resend" && !resendApiKey) {
    throw new Error('EMAIL_TRANSPORT="resend" requires RESEND_API_KEY');
  }

  let smtp: SmtpConfig | null = null;
  if (emailTransport === "smtp") {
    const host = process.env.SMTP_HOST;
    const portRaw = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    if (!host || !portRaw || !user || !pass) {
      throw new Error('EMAIL_TRANSPORT="smtp" requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD');
    }
    const smtpPort = Number(portRaw);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new Error(`Invalid SMTP_PORT: "${portRaw}" (must be an integer 1-65535)`);
    }
    // Convention: 465 = implicit SSL ("secure"); 587 = STARTTLS. SMTP_SECURE
    // overrides if explicitly set ("true"/"false").
    const secureOverride = process.env.SMTP_SECURE?.toLowerCase();
    const secure = secureOverride === "true" ? true
      : secureOverride === "false" ? false
      : smtpPort === 465;
    const tlsServername = process.env.SMTP_TLS_SERVERNAME ?? null;
    smtp = { host, port: smtpPort, secure, user, pass, tlsServername };
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
    smtp,
    emailFrom,
    magicLinkTtlMinutes,
  };
}
