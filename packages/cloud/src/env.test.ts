import { describe, it, expect, afterEach } from "vitest";
import { loadEnv } from "./env.js";

const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const ALL = [...REQUIRED, "PUBLIC_URL", "WEB_URL", "PORT", "EMAIL_TRANSPORT", "RESEND_API_KEY", "EMAIL_FROM", "MAGIC_LINK_TTL_MIN",
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_SECURE"];
const saved: Record<string, string | undefined> = {};
for (const k of ALL) saved[k] = process.env[k];

function setRequired() {
  for (const k of REQUIRED) process.env[k] = `val-${k}`;
}
afterEach(() => {
  for (const k of ALL) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEnv", () => {
  it("throws when a required var is missing", () => {
    for (const k of ALL) delete process.env[k];
    expect(() => loadEnv()).toThrow(/Missing env var/);
  });
  it("defaults PUBLIC_URL and PORT when unset", () => {
    setRequired();
    delete process.env.PUBLIC_URL;
    delete process.env.PORT;
    const env = loadEnv();
    expect(env.publicUrl).toBe("http://localhost:8787");
    expect(env.port).toBe(8787);
  });
  it("reads WEB_URL when set, else falls back to the placeholder default", () => {
    setRequired();
    process.env.WEB_URL = "https://chat.example.com";
    expect(loadEnv().webUrl).toBe("https://chat.example.com");
    delete process.env.WEB_URL;
    expect(loadEnv().webUrl).toBe("https://chat.your-cogni-cloud.example.com");
  });
  it("throws on a non-numeric PORT", () => {
    setRequired();
    process.env.PORT = "not-a-number";
    expect(() => loadEnv()).toThrow(/Invalid PORT/);
  });
  it("accepts a valid custom PORT", () => {
    setRequired();
    process.env.PORT = "3000";
    expect(loadEnv().port).toBe(3000);
  });
  it("defaults emailTransport to console and ttl to 15", () => {
    setRequired();
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.MAGIC_LINK_TTL_MIN;
    const env = loadEnv();
    expect(env.emailTransport).toBe("console");
    expect(env.magicLinkTtlMinutes).toBe(15);
    expect(env.resendApiKey).toBeNull();
  });
  it("requires RESEND_API_KEY when EMAIL_TRANSPORT=resend", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "resend";
    delete process.env.RESEND_API_KEY;
    expect(() => loadEnv()).toThrow(/RESEND_API_KEY/);
  });
  it("rejects an invalid EMAIL_TRANSPORT value", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "sendgrid";
    expect(() => loadEnv()).toThrow(/Invalid EMAIL_TRANSPORT/);
  });
  it("rejects out-of-range MAGIC_LINK_TTL_MIN", () => {
    setRequired();
    process.env.MAGIC_LINK_TTL_MIN = "120";
    expect(() => loadEnv()).toThrow(/MAGIC_LINK_TTL_MIN/);
  });

  it("requires SMTP_HOST/PORT/USER/PASSWORD when EMAIL_TRANSPORT=smtp", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "smtp";
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    expect(() => loadEnv()).toThrow(/SMTP_HOST.*SMTP_PORT.*SMTP_USER.*SMTP_PASSWORD/);
  });

  it("parses an SMTP config with default secure=true on port 465", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "mail.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASSWORD = "secret";
    delete process.env.SMTP_SECURE;
    const env = loadEnv();
    expect(env.emailTransport).toBe("smtp");
    expect(env.smtp).toEqual({
      host: "mail.example.com",
      port: 465,
      secure: true,
      user: "u@example.com",
      pass: "secret",
      tlsServername: null,
    });
  });

  it("picks up SMTP_TLS_SERVERNAME when present (SSH-tunnel pattern)", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1465";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SMTP_TLS_SERVERNAME = "mail.example.com";
    const env = loadEnv();
    expect(env.smtp?.tlsServername).toBe("mail.example.com");
  });

  it("parses an SMTP config with default secure=false on port 587 (STARTTLS)", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "mail.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASSWORD = "secret";
    delete process.env.SMTP_SECURE;
    const env = loadEnv();
    expect(env.smtp?.secure).toBe(false);
  });

  it("SMTP_SECURE=true overrides the port-based default", () => {
    setRequired();
    process.env.EMAIL_TRANSPORT = "smtp";
    process.env.SMTP_HOST = "mail.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "u@example.com";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SMTP_SECURE = "true";
    const env = loadEnv();
    expect(env.smtp?.secure).toBe(true);
  });
});
