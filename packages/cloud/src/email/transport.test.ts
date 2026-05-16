import { describe, it, expect, vi } from "vitest";
import { FakeTransport, ConsoleTransport, ResendTransport, SmtpTransport } from "./transport.js";
import type { Transporter } from "nodemailer";

describe("FakeTransport", () => {
  it("records sent magic links instead of sending them", async () => {
    const t = new FakeTransport();
    await t.sendMagicLink({ to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 });
    await t.sendMagicLink({ to: "b@x.com", magicUrl: "cogni://auth?magic=yyy", expiresInMinutes: 15 });
    expect(t.sent).toEqual([
      { to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 },
      { to: "b@x.com", magicUrl: "cogni://auth?magic=yyy", expiresInMinutes: 15 },
    ]);
  });
});

describe("ConsoleTransport", () => {
  it("writes the magic URL to stdout so the dev can copy/paste it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const t = new ConsoleTransport();
      await t.sendMagicLink({ to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 });
      const printed = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("a@x.com");
      expect(printed).toContain("cogni://auth?magic=xxx");
      expect(printed).toContain("15");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ResendTransport", () => {
  const baseArgs = { to: "a@x.com", magicUrl: "cogni://auth?magic=tok", expiresInMinutes: 15 };

  it("POSTs to api.resend.com with Bearer auth and the magic URL in the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
    const t = new ResendTransport({ apiKey: "re_test_key", from: "Cogni <login@cogni.example>", fetchImpl: fetchMock });

    await t.sendMagicLink(baseArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body.from).toBe("Cogni <login@cogni.example>");
    expect(body.to).toBe("a@x.com");
    expect(body.text).toContain("cogni://auth?magic=tok");
    expect(body.text).toContain("15");
  });

  it("throws when Resend returns non-2xx (caller decides what to do)", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limit", { status: 429 }));
    const t = new ResendTransport({ apiKey: "k", from: "f", fetchImpl: fetchMock });
    await expect(t.sendMagicLink(baseArgs)).rejects.toThrow(/429/);
  });
});

describe("SmtpTransport", () => {
  const baseArgs = { to: "a@x.com", magicUrl: "cogni://auth?magic=tok", expiresInMinutes: 15 };

  it("calls transporter.sendMail with from/to/subject/text (text contains the URL)", async () => {
    const sendMail = vi.fn(async () => ({ accepted: ["a@x.com"], messageId: "<m1>" }));
    const fakeTransporter = { sendMail } as unknown as Transporter;
    const t = new SmtpTransport({
      host: "mail.example.com", port: 465, secure: true,
      user: "u", pass: "p",
      from: "Cogni <login@example.com>",
      transporter: fakeTransporter,
    });

    await t.sendMagicLink(baseArgs);

    expect(sendMail).toHaveBeenCalledOnce();
    const sent = sendMail.mock.calls[0]![0];
    expect(sent.from).toBe("Cogni <login@example.com>");
    expect(sent.to).toBe("a@x.com");
    expect(sent.subject).toMatch(/Sign in to Cogni/);
    expect(sent.text).toContain("cogni://auth?magic=tok");
    expect(sent.text).toContain("15");
  });

  it("propagates SMTP errors so the caller's catch block logs them", async () => {
    const sendMail = vi.fn(async () => { throw new Error("550 mailbox unavailable"); });
    const fakeTransporter = { sendMail } as unknown as Transporter;
    const t = new SmtpTransport({
      host: "x", port: 465, secure: true,
      user: "u", pass: "p", from: "f",
      transporter: fakeTransporter,
    });
    await expect(t.sendMagicLink(baseArgs)).rejects.toThrow(/550/);
  });
});
