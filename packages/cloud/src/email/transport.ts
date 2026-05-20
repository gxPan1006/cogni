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
/** Verify-email (password registration) + password-reset share this shape. */
export interface LinkArgs { to: string; url: string; expiresInMinutes: number; }

export interface EmailTransport {
  sendMagicLink(args: SendArgs): Promise<void>;
  /** Confirm a new email+password registration before the account is created/merged. */
  sendVerifyEmail(args: LinkArgs): Promise<void>;
  /** Reset (or, for an already-registered email, recover) a password. */
  sendPasswordReset(args: LinkArgs): Promise<void>;
}

export class FakeTransport implements EmailTransport {
  public sent: SendArgs[] = [];
  public verifications: LinkArgs[] = [];
  public resets: LinkArgs[] = [];
  async sendMagicLink(args: SendArgs): Promise<void> { this.sent.push(args); }
  async sendVerifyEmail(args: LinkArgs): Promise<void> { this.verifications.push(args); }
  async sendPasswordReset(args: LinkArgs): Promise<void> { this.resets.push(args); }
}

export class ConsoleTransport implements EmailTransport {
  async sendMagicLink(args: SendArgs): Promise<void> {
    console.log(
      `[email/console] magic-link to=${args.to} url=${args.magicUrl} expiresInMinutes=${args.expiresInMinutes}`,
    );
  }
  async sendVerifyEmail(args: LinkArgs): Promise<void> {
    console.log(
      `[email/console] verify-email to=${args.to} url=${args.url} expiresInMinutes=${args.expiresInMinutes}`,
    );
  }
  async sendPasswordReset(args: LinkArgs): Promise<void> {
    console.log(
      `[email/console] password-reset to=${args.to} url=${args.url} expiresInMinutes=${args.expiresInMinutes}`,
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

  sendMagicLink(args: SendArgs): Promise<void> {
    return this.send(args.to, "登录 Cogni / Sign in to Cogni", buildMagicLinkPlainText(args));
  }
  sendVerifyEmail(args: LinkArgs): Promise<void> {
    return this.send(args.to, "确认注册 Cogni / Confirm your Cogni account", buildVerifyPlainText(args));
  }
  sendPasswordReset(args: LinkArgs): Promise<void> {
    return this.send(args.to, "重置 Cogni 密码 / Reset your Cogni password", buildResetPlainText(args));
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    const fetcher = this.opts.fetchImpl ?? fetch;
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.opts.from, to, subject, text }),
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

  sendMagicLink(args: SendArgs): Promise<void> {
    return this.send(args.to, "登录 Cogni / Sign in to Cogni", buildMagicLinkPlainText(args));
  }
  sendVerifyEmail(args: LinkArgs): Promise<void> {
    return this.send(args.to, "确认注册 Cogni / Confirm your Cogni account", buildVerifyPlainText(args));
  }
  sendPasswordReset(args: LinkArgs): Promise<void> {
    return this.send(args.to, "重置 Cogni 密码 / Reset your Cogni password", buildResetPlainText(args));
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
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
      await transporter.sendMail({ from: this.opts.from, to, subject, text });
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

function buildVerifyPlainText(args: LinkArgs): string {
  return [
    "你好,",
    "",
    "有人用这个邮箱注册了 Cogni 账号密码。点击下面的链接以确认并完成设置:",
    "",
    `    ${args.url}`,
    "",
    `如果不是你本人,请忽略这封邮件——在确认之前不会创建任何账号。链接 ${args.expiresInMinutes} 分钟内有效。`,
    "",
    "─────────────────",
    "",
    "Hi,",
    "",
    "Someone signed up for Cogni with this email and a password. Click to confirm and finish setup:",
    "",
    `    ${args.url}`,
    "",
    `If this wasn't you, ignore this email — no account is created until you confirm. The link expires in ${args.expiresInMinutes} minutes.`,
  ].join("\n");
}

function buildResetPlainText(args: LinkArgs): string {
  return [
    "你好,",
    "",
    "有人请求重置这个邮箱对应的 Cogni 密码。点击下面的链接以设置新密码:",
    "",
    `    ${args.url}`,
    "",
    `如果不是你本人,请忽略这封邮件,你的密码不会改变。链接 ${args.expiresInMinutes} 分钟内有效。`,
    "",
    "─────────────────",
    "",
    "Hi,",
    "",
    "Someone requested a Cogni password reset for this email. Click to set a new password:",
    "",
    `    ${args.url}`,
    "",
    `If this wasn't you, ignore this email and your password stays unchanged. The link expires in ${args.expiresInMinutes} minutes.`,
  ].join("\n");
}
