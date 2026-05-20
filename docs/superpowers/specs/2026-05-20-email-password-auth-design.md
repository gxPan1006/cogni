# Email + Password Auth — Design

**Date:** 2026-05-20
**Status:** Approved, implementing
**Builds on:** [`2026-05-16-email-magic-link-auth-design.md`](2026-05-16-email-magic-link-auth-design.md)

## Goal

Add traditional email + password login/registration as a third auth method
alongside Google OAuth and email magic-link. The account identifier **is the
email** — there is no separate username. Password credentials live on the same
email-keyed user as every other method, so a user who signed up with Google can
later add a password and it attaches to the *same* account.

## Decisions

1. **账号 = 邮箱.** Password auth is email + password. No username column. The
   email is the single identity key, exactly as today.
2. **Merge requires proven email ownership ("验证后合并").** A password
   credential only attaches to an existing account *after* email ownership is
   proven, to prevent account takeover (someone setting a password on a
   stranger's Google-linked email). Ownership is proven by a verification-email
   round-trip — the same primitive magic-link already uses.
3. **Approach B — traditional standalone signup.** Familiar
   register → verify-email → login UX, plus password reset. Chosen over the
   leaner "set password behind an already-verified session" approach for UX
   familiarity. Same security outcome.
4. **Web is the target.** Desktop's `cogni://` deep-link callback is a
   follow-up, not in scope here.

## Data model

- **`users.passwordHash`** — new nullable `text` column. Encoded
  `scrypt$<saltBase64>$<hashBase64>` using Node's built-in `crypto.scrypt`
  (N=16384, r=8, p=1, 64-byte key). Zero new dependencies. Constant-time
  compare via `crypto.timingSafeEqual`.
- **`user_identities`** gains `kind:'password'` rows (`sub` = lowercased
  email), so `listIdentitiesForUser` continues to reflect which login methods a
  user has. The `kind` doc comment in `schema.ts` is updated to include
  `'password'`.
- Schema applied via `drizzle-kit push` (project convention; no migration
  files).

## Password hashing module

New `packages/cloud/src/auth/password.ts`:
- `hashPassword(plain): Promise<string>` → encoded string.
- `verifyPassword(plain, encoded): Promise<boolean>` → timing-safe.
- Unit-tested in isolation.

## Public endpoints

New `registerPasswordRoutes(app, deps)` in
`packages/cloud/src/routes/password.ts`, called from `server.ts` next to
`registerEmailRoutes`. All paths are under `/auth/password/*` and the existing
`/auth/*` CORS already covers them. Validation is inline zod, matching the
`routes/email.ts` convention. A pending-token `InMemoryTokenStore` (10–30 min
TTL, single-use) holds register/reset tokens; a `setInterval(...).unref()`
sweep mirrors the magic-link registrar.

| Method & path | Body | Behavior |
| --- | --- | --- |
| `POST /auth/password/register` | `{email, password, origin?}` | Validate (email format; password 8–200 chars). If the email already has a password identity → send an "account exists, log in or reset" email and **stop**. Otherwise hash the password, stash `{email, passwordHash}` in the token store, send a **verification email** with a link to `${origin}/auth/password/callback?token=…`. Rate-limited per-email (1/min, 5/hr) and per-IP (3/min, 20/hr). **Always returns `{ok:true}`** (anti-enumeration). |
| `POST /auth/password/verify` | `{token}` | Redeem token (single-use). Email is now proven → `findOrLinkUser({kind:'password', sub:email, email})` create-or-**merges** into the existing email-keyed user. Write `users.passwordHash` and upsert the `password` identity. Create an `auth_session`, return `{token: jwt}`. |
| `POST /auth/password/login` | `{email, password}` | Look up user by email; require a `passwordHash`; `verifyPassword`. On success create session + return JWT. Any failure → generic `401 invalid credentials`. Rate-limited per-email/IP. |
| `POST /auth/password/reset/request` | `{email, origin?}` | If the user exists and has a password, send a **reset email** linking to `${origin}/auth/password/reset?token=…`. Rate-limited. **Always `{ok:true}`**. |
| `POST /auth/password/reset/confirm` | `{token, password}` | Redeem token, validate new password, overwrite `passwordHash`, create session + return JWT. |

## Email transport

Extend the `EmailTransport` interface in
`packages/cloud/src/email/transport.ts` with:
- `sendVerifyEmail({to, verifyUrl, expiresInMinutes})`
- `sendPasswordReset({to, resetUrl, expiresInMinutes})`

Implemented across `FakeTransport` (records calls for tests),
`ConsoleTransport` (prints URL), `ResendTransport`, `SmtpTransport`. Bilingual
zh/en plaintext bodies built like `buildMagicLinkPlainText`.

## DB helpers

- `db/users.ts`: add `findUserByEmail(db, email)` (read-only, lowercased) and
  `setUserPassword(db, userId, hash)`.
- Reuse `upsertIdentity`, `createAuthSession`, `auth.issueToken`,
  `findOrLinkUser` unchanged.

## Client (web + shared UI)

- **`packages/ui/src/components/Login.tsx`** — add a password field and a mode
  toggle: **登录 / 注册 / 忘记密码**, plus the existing Google + magic-link
  options. New handler props: `onPasswordLogin(email, password)`,
  `onPasswordRegister(email, password)`, `onPasswordResetRequest(email)`.
  Reflect sending / sent / error states like the current magic-link UI.
- **`packages/ui/src/transport/api.ts`** — add `passwordLogin`,
  `passwordRegister`, `passwordVerify`, `passwordResetRequest`,
  `passwordResetConfirm`.
- **`apps/web/src/AuthCallback.tsx` + `App.tsx`** — routes
  `/auth/password/callback?token=` (POSTs `verify`, then `acceptToken`) and
  `/auth/password/reset?token=` (small set-new-password page → `reset/confirm`
  → `acceptToken`), mirroring `EmailAuthCallback`.
- **`apps/web/src/useAuth-web.ts`** — wire the handlers; `acceptToken` the
  returned JWT.

## Testing (pglite, `*.test.ts`)

- `auth/password.test.ts` — hash → verify round-trip; wrong password fails;
  encoded format stable.
- `routes/password.test.ts`:
  - register → verify creates a brand-new user with `passwordHash` + password
    identity.
  - register → verify on an email that already has a **Google** user → **one**
    user, two identities (`google` + `password`), `passwordHash` set (merge).
  - login success returns a usable JWT; wrong password → 401; unknown email →
    401.
  - register on an email that already has a password → no token stashed, no
    overwrite, still `{ok:true}` (anti-enumeration), and `sendVerifyEmail` is
    *not* called for it.
  - reset request → confirm overwrites the hash; old password no longer works.

## Out of scope

- Desktop `cogni://` password callback (follow-up).
- Password strength meter / breach check, 2FA, "remember me" beyond the
  existing 30-day JWT.
- Moving the in-memory token store to Redis (tracked separately as the SP-2+1
  multi-node concern).
