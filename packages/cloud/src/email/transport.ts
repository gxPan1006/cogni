/**
 * Cloud-side abstraction for sending the magic-link email.
 *
 * SP-1 supplies four implementations:
 *   - FakeTransport: in-memory; tests assert on `sent[]`.
 *   - ConsoleTransport: prints the link to stdout. The dev-mode default —
 *     no API key needed, no real email sent, copy-paste the link to test.
 *   - ResendTransport: REST-API path; POSTs to api.resend.com.
 *   - SmtpTransport: classic SMTP via nodemailer. Used when the operator
 *     already has an SMTP mailbox (e.g. spacemail / postmark / aws-ses-smtp)
 *     and doesn't want to add Resend as a dependency.
 *
 * `main.ts` picks the implementation from EMAIL_TRANSPORT env.
 */
import nodemailer, { type Transporter } from "nodemailer";

export interface SendArgs { to: string; magicUrl: string; expiresInMinutes: number; }

export interface EmailTransport {
  sendMagicLink(args: SendArgs): Promise<void>;
}

export class FakeTransport implements EmailTransport {
  public sent: SendArgs[] = [];
  async sendMagicLink(args: SendArgs): Promise<void> { this.sent.push(args); }
}

export class ConsoleTransport implements EmailTransport {
  async sendMagicLink(args: SendArgs): Promise<void> {
    console.log(
      `[email/console] would send to=${args.to} url=${args.magicUrl} expiresInMinutes=${args.expiresInMinutes}`,
    );
  }
}

export interface ResendOpts {
  apiKey: string;
  from: string;                                  // e.g. "Cogni <login@cogni.example>"
  fetchImpl?: typeof fetch;                       // injectable for tests
}

export class ResendTransport implements EmailTransport {
  constructor(private opts: ResendOpts) {}

  async sendMagicLink(args: SendArgs): Promise<void> {
    const text = buildMagicLinkPlainText(args);
    const fetcher = this.opts.fetchImpl ?? fetch;
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: args.to,
        subject: "登录 Cogni / Sign in to Cogni",
        text,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}

export interface SmtpOpts {
  host: string;
  port: number;
  /** true for implicit SSL (port 465); false for STARTTLS (port 587). */
  secure: boolean;
  user: string;
  pass: string;
  /** e.g. `"Cogni <us@ai-cognit.com>"` — must match the SMTP account / verified sender. */
  from: string;
  /**
   * Optional SNI override. Use when `host` is a tunnel endpoint
   * (e.g. `localhost` via `ssh -L`) but the real server's TLS cert is for a
   * different name. nodemailer otherwise sends the connected hostname as SNI,
   * which causes the cert validation to fail with HOSTNAME_MISMATCH.
   */
  tlsServername?: string;
  /** Injectable for tests; default builds nodemailer.createTransport(...) from host/port/etc. */
  transporter?: Transporter;
}

export class SmtpTransport implements EmailTransport {
  constructor(private readonly opts: SmtpOpts) {}

  async sendMagicLink(args: SendArgs): Promise<void> {
    // Build a fresh transporter per send. nodemailer's default `pool: false`
    // would short-lived-connection per sendMail anyway, but we observed that a
    // long-lived `nodemailer.createTransport` instance, when its first call sits
    // idle for a while behind an SSH tunnel, has its internal socket state get
    // confused and subsequent sendMail() hangs until socketTimeout. Creating
    // the transporter inside the handler matches the standalone-script pattern
    // that proved reliable (see probe in docs/integration-log notes).
    const transporter = this.opts.transporter ?? nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: { user: this.opts.user, pass: this.opts.pass },
      // Generous timeouts: SSH-tunnel paths add per-hop latency, and the default
      // 10s greetingTimeout can spuriously fire even when the server's 220 line
      // is on its way. 60s lets slow transports succeed; real failures still
      // surface within a minute.
      connectionTimeout: 60_000,
      greetingTimeout: 60_000,
      socketTimeout: 60_000,
      ...(this.opts.tlsServername ? { tls: { servername: this.opts.tlsServername } } : {}),
    });
    try {
      const text = buildMagicLinkPlainText(args);
      await transporter.sendMail({
        from: this.opts.from,
        to: args.to,
        subject: "登录 Cogni / Sign in to Cogni",
        text,
      });
    } finally {
      // Only close transporters we built ourselves; injected ones (tests) are
      // owned by the caller.
      if (!this.opts.transporter) transporter.close();
    }
  }
}

function buildMagicLinkPlainText(args: SendArgs): string {
  return [
    "你好,",
    "",
    "有人请求用这个邮箱登录 Cogni。点击下面的链接以登录:",
    "",
    `    ${args.magicUrl}`,
    "",
    `如果不是你本人,请忽略这封邮件。链接 ${args.expiresInMinutes} 分钟内有效。`,
    "",
    "─────────────────",
    "",
    "Hi,",
    "",
    "Someone requested a Cogni login for this email. Click the link to sign in:",
    "",
    `    ${args.magicUrl}`,
    "",
    `If this wasn't you, ignore this email. The link expires in ${args.expiresInMinutes} minutes.`,
  ].join("\n");
}
