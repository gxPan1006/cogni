# User Profile Editing (Avatar + Display Name)

**Date:** 2026-05-21
**Status:** Approved (brainstorm) → ready for implementation plan

## Goal

Let users edit their **display name** and **avatar** from Settings → Account.
Today neither exists as real data: the "name" is derived client-side from the
email local-part (`email.split("@")[0]`), and the "avatar" is just the first
letter rendered in a colored circle. The Settings → Account page already has a
**"Rename" button that is hard-disabled** — this is the feature's anchor.

## Decisions (locked during brainstorming)

1. **Avatar is an uploaded image file**, cropped + compressed **on the client**,
   stored **in the database** (no object storage — the repo has none, and a
   ~tens-of-KB avatar does not justify standing up S3/R2).
2. **Interactive cropper** (drag to pan, scroll/pinch to zoom), **hand-rolled,
   zero-dependency** (`<AvatarCropper>` using pointer events + canvas). No
   third-party crop library (avoids React 19 peer-dep friction; keeps the unit
   self-contained and testable).
3. **No changes to Google OAuth.** We do NOT add the `profile` scope. Defaults
   stay as they are (email-prefix name, first-letter avatar). Only manual
   editing is in scope.

## Non-goals

- Object storage / S3 / R2 / blob infra.
- Pulling name/picture from Google or any IdP.
- Avatars for any entity other than the signed-in user (no project/task/runner
  avatars).
- Animated avatars, multiple images, image galleries.

## Data model

`packages/cloud/src/db/schema.ts` — add two nullable columns to `users`:

```ts
name: text("name"),     // null → client falls back to email local-part
avatar: text("avatar"), // data URL "data:image/webp;base64,…"; null → letter circle
```

**Why `text` data URL, not `bytea` + mime:** the client produces a data URL
after crop+compress and renders it directly via `<img src={avatar}>`. Storing
the data URL avoids a separate mime column and encode/decode on both ends. A
crop-compressed 256px webp is well under the size cap, which Postgres `text`
holds trivially.

Migration: new script under `packages/cloud/src/scripts/`, mirroring
`migrate-2026-05-20-password-auth.ts` (`ALTER TABLE users ADD COLUMN …`).
Existing rows get NULLs — behavior is unchanged for them until they edit.

## Backend API

New file `packages/cloud/src/routes/profile.ts`, registered in
`packages/cloud/src/server.ts` **after** `registerIdentitiesRoutes` so it
inherits the existing Bearer `/api/*` auth middleware (`routes/client.ts`).
This finally lands the long-noted-missing `/api/me`.

- **`GET /api/me`** → `{ email: string; name: string | null; avatar: string | null }`
  - Reads the `users` row for `claims.userId`.
- **`PATCH /api/me`** → body `{ name?: string | null; avatar?: string | null }`
  - **name:** `trim()`; valid length **1–50** chars. Empty string or `null`
    clears `name` to NULL (→ email-prefix fallback). Reject > 50 with 400.
  - **avatar:** must match `data:image/(png|jpeg|webp);base64,<payload>`;
    decoded byte length **≤ 256 KB** (server-side guard against bypassing the
    client). `null` clears the avatar. Reject bad mime / oversize with 400.
  - Only the keys present in the body are updated (partial patch).

DB helpers in `packages/cloud/src/db/users.ts`, mirroring `setUserPassword`:
- `getUserProfile(db, userId): { email, name, avatar } | undefined`
- `setUserProfile(db, userId, fields: { name?: string | null; avatar?: string | null })`

Shared request/response types: add a small `userProfile` / `updateProfile` zod
schema to `@cogni/contract` so `ApiClient` and the route share types (follow
how existing HTTP DTO types are shared; if identities define theirs inline,
match that — keep it consistent, don't introduce a new pattern).

## Client data flow

Today `apps/web/src/App.tsx` and `apps/desktop/src/Shell.tsx` build the `user`
object by decoding the JWT and splitting the email. Change:

- New hook **`useMe()`** in `packages/ui/src/hooks/` (parallel to
  `useIdentities`): on mount, `GET /api/me`; exposes
  `{ profile, loading, refresh, updateProfile }`.
- The `user` object becomes `{ email, name, avatar }`:
  - `name` = profile.name ?? `email.split("@")[0]`
  - `avatar` = profile.avatar ?? null (component renders letter fallback)
- **First paint** uses the JWT-derived email (no flicker / no blank); when
  `/api/me` resolves it overrides with the real name/avatar.

**User-visible behavior:** right after login the sidebar/account show the
email-prefix name + letter circle instantly; a moment later they swap — with no
visible reload — to whatever the user has saved.

## Edit UI (Settings → Account, `AccountPage`)

Activate the currently-disabled **"Rename"** button:

- **Rename:** clicking it turns the name row into an inline text input with
  Save / Cancel. On save → `PATCH /api/me` → `useMe` refresh → sidebar + account
  update.
- **Avatar:** the avatar area becomes clickable → file picker → selected image
  opens the **`<AvatarCropper>`** modal:
  - square crop frame; drag to pan, scroll / pinch to zoom within bounds;
  - on confirm: render the cropped region to a 256×256 canvas, export
    `toDataURL("image/webp", quality)` (fallback `image/jpeg` if webp export
    unsupported), `PATCH /api/me`.
  - a **"Remove avatar"** action sets avatar to `null` (back to letter circle).
- **Shared `<Avatar>` component** (`packages/ui/src/components/`): renders
  `<img>` when avatar present, else the colored first-letter circle. Used by
  both `Sidebar.tsx` (footer) and `AccountPage`, so the fallback logic lives in
  one place.

**User-visible behavior (per surface):**
- *Sidebar footer:* avatar circle now shows the uploaded image (or letter); name
  reflects the edited name.
- *Settings → Account:* big avatar is clickable (hover affordance), "Rename"
  works inline, "Remove avatar" appears when an avatar is set.
- *Empty / loading / error states:* while `/api/me` loads → letter + email
  prefix; upload too large or wrong type → inline error in the cropper modal,
  nothing saved; PATCH failure → error toast/inline message, prior value kept.

i18n: add the new strings to `packages/ui/src/i18n/locales/{en,zh}/` (the
existing `settings.account.*` namespace already holds the disabled-rename
title).

## Testing

- **cloud:** `packages/cloud/src/routes/profile.test.ts` (pglite, mirroring
  `identities.test.ts` / `password.test.ts`):
  - `GET /api/me` returns email + nulls for a fresh user;
  - `PATCH` name happy path + length>50 rejected + empty clears to null;
  - `PATCH` avatar happy path + bad mime rejected + oversize (>256KB) rejected
    + `null` clears;
  - auth required (401 without Bearer).
- **contract:** schema validation tests if zod schemas are added.
- **UI:** crop math (image → 256² canvas region) is the riskiest pure logic —
  unit-test the crop/export helper in isolation if it's extractable.

## Open items for implementer

- Confirm how existing HTTP DTOs share types between `ApiClient` and routes, and
  match it (inline vs `@cogni/contract`).
- Decide webp-vs-jpeg export default by checking canvas support at runtime;
  jpeg is the safe fallback.
