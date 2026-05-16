/**
 * Cloud-side abstraction for sending the magic-link email.
 *
 * SP-1 supplies three implementations:
 *   - FakeTransport: in-memory; tests assert on `sent[]`.
 *   - ConsoleTransport: prints the link to stdout. The dev-mode default —
 *     no API key needed, no real email sent, copy-paste the link to test.
 *   - ResendTransport: production. POSTs to Resend's REST API.
 *
 * `main.ts` picks the implementation from EMAIL_TRANSPORT env (Task 8 in
 * the C-phase plan — Phase C of fanout integration).
 */
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
