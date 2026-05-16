import { describe, it, expect, afterEach } from "vitest";
import { loadEnv } from "./env.js";

const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const ALL = [...REQUIRED, "PUBLIC_URL", "PORT", "EMAIL_TRANSPORT", "RESEND_API_KEY", "EMAIL_FROM", "MAGIC_LINK_TTL_MIN"];
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
});
