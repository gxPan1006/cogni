# Open-source Cogni — design spec

**Date:** 2026-05-25
**Topic:** Take the current private `gxPan1006/cogni` repo and turn it into a
standard, publication-ready open-source project. Goal is "ride the wave" —
maximize GitHub star momentum without burning future commercialization options.

## Why this spec exists

Open-sourcing is a one-way door: once the repo is public, license, README
copy, and git history are durable. Without an upfront design we tend to bolt
on the easy parts (`LICENSE`, README header) and forget the load-bearing ones
(domain scrubbing, branch hygiene, slash-command leak surface). This spec
locks the boundaries so implementation can fan out cleanly.

## Decisions (from brainstorming)

1. **License:** MIT.
2. **Repo identity:** stay on `gxPan1006/cogni`. The same private repo gets
   flipped to public — keep history, keep URL, keep prior commit "depth" as
   social proof.
3. **Positioning hook:** all three angles in README ("Claude Code in the
   cloud", "self-hosted AI workspace", "open-source agent orchestrator") —
   refine later based on which one social channels react to.
4. **Internal docs:** selectively clean. Useful spec/plan docs stay (project
   "depth" signal); ad-hoc engineering notes get `git rm --cached`'d but kept
   on local disk for the maintainer.
5. **Hosted demo:** the maintainer keeps running `cloud.ai-cognit.com` for
   personal use, but **the OSS repo does not advertise or default to it.**
   `.env.production` defaults must point at a generic placeholder.
6. **Visuals:** delegate screenshot capture to the Codex CLI (Computer Use)
   against a freshly-started local dev stack.

## Scope (what this spec covers)

The work splits into 7 modules. Each maps to a section of the implementation
plan and is independently verifiable.

### Module 1 — License + package metadata

- Add root `LICENSE` (MIT, "Copyright (c) 2026 Guoxun Pan").
- Add `"license": "MIT"` to root `package.json` and every
  `packages/*/package.json` / `apps/*/package.json`.
- Keep `"private": true` on every workspace package — we are not publishing
  to npm and don't want accidental publishes.

### Module 2 — Repository content cleanup

**2a. Untrack internal engineering notes (keep on local disk):**
Use `git rm --cached <file>` then add to `.gitignore`. Files:

- `MEMORY.md`
- `HANDOFF-NOTES.md`
- `tbd.md`
- `docs/integration-log.md`
- `docs/sp3-design-brief.md`
- `docs/SP-2-E2E-VERIFICATION.md`
- `docs/SP-2-OPS-MANUAL.md`
- `docs/SP1-functional-test-plan.md`
- `docs/DEPLOYMENT.md`
- `docs/deploy/` (entire dir — maintainer's deploy scripts)

**2b. Keep as "project depth" signal:**

- `docs/superpowers/specs/*` — design docs from SP-1 → SP-3. These are
  Cogni's differentiated asset and read well to engineers.
- `docs/superpowers/plans/*` — implementation plans, ditto.
- `docs/RUNNING.md` — keep, but rewrite to remove personal infra references
  (see Module 3).
- `CLAUDE.md` (root) — keep. AI-friendly repos signal modernity in 2026.
- `.github/workflows/ci.yml` — keep as-is.

**2c. Branch hygiene on origin:**

- Change GitHub default branch from `sp1-followups` → `main`.
- Delete `origin/feat/task-comment-cards` (incomplete WIP).
- Leave dependabot branches alone — they regenerate on next scan.
- Local-only branches (`claude/*`, `sp4-sidecar-binary`,
  `feat/file-upload`, `feat/default-project-folder`) are not pushed.

**2d. Slash-command cleanup in `.claude/commands/`:**

- Delete personal deployment commands: `/ship`, `/ship-web` (contain
  hardcoded production paths / domain assumptions).
- Keep generic ones: `/verify`, `/test`, `/simplify`, etc.
- Add a brief `.claude/commands/README.md` explaining what this dir is and
  pointing at Claude Code docs.

### Module 3 — Production / personal-infra scrubbing

Search the whole tree and replace personal identifiers:

- `apps/desktop/.env.production` and `apps/web/.env.production`:
  `https://cloud.ai-cognit.com` → `https://your-cogni-cloud.example.com`.
  Add a comment in each file explaining "this is the production-build target;
  override before deploying your own instance."
- Grep for and review every match of: `ai-cognit.com`, `prod-cognit`,
  `spacemail`, `gxPan1006`, the maintainer's personal email patterns. Each
  match is either replaced with a generic example (`your-mail-provider.com`,
  `you@example.com`) or deleted if it was in a comment recording a personal
  one-off workaround.
- `.env.example` files: verify they have no real secrets, only placeholders.

Verification: `grep -rE "ai-cognit|prod-cognit|spacemail" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs/superpowers/specs` returns zero hits (specs may legitimately reference the historical name as design-time context).

### Module 4 — README rewrite

Replace the current engineering-log-style README. New structure:

```
[Hero image — desktop app screenshot from Module 6]

# Cogni

> One-line elevator pitch — "Claude Code, but with a brain in the cloud."

> Second line — "Open-source AI workspace where your laptop runs the
> agents and your devices stay in sync."

[Badges: MIT license · CI status · GitHub stars (auto-updates)]

## What it does
- 🧠 Multi-device sync — chat from web, desktop, or mobile; agents keep
  running on your laptop while you switch screens.
- 🛠 Agent orchestration — projects, tasks, kanban. Built on top of Claude
  Code today; runner abstraction lets other agent CLIs slot in.
- 🔒 Self-host — the heavy work happens on your own machine. Cloud control
  plane is a small Node + Postgres service you can host anywhere (Neon,
  Vercel, Fly, a VPS).

[Demo GIF — optional, can ship without]

## Quick start

3-step quickstart pointing at `docs/RUNNING.md` for full setup.

## How it works

Short architecture overview + a mermaid diagram showing
cloud control plane ↔ Runner Host daemon ↔ local Claude Code.
Link to `docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md`
for the full design.

## Tech stack

TypeScript end-to-end · Hono + Neon + drizzle on the cloud · Tauri 2 +
React 19 on desktop · React 19 + Vite on web · pnpm monorepo.

## Project status

SP-1 (spine) and SP-2 (accounts/sync) complete. SP-3 (project domain) done.
SP-4 (polish + Windows) in progress. Contributions welcome on:
[list of help-wanted areas].

## Contributing

→ CONTRIBUTING.md

## License

MIT
```

Constraints on copy:

- No mention of `cloud.ai-cognit.com` or any hosted demo URL.
- No "try it now" CTA pointing at maintainer-operated infra.
- First-person plural ("we") only when describing the project / community,
  never when describing the maintainer's business.

### Module 5 — Standard community files

Generate to GitHub's recommended templates:

- `CONTRIBUTING.md` — "fork → branch → PR" flow, links to `docs/RUNNING.md`
  for dev setup, mentions the test command (`pnpm test`) and the lint
  command (`pnpm lint`). Note the `pnpm@10.33.0` + Node 22 pinning so PRs
  match CI.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1, unmodified except for
  the contact email placeholder.
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` —
  minimal, no labyrinthine questionnaires.
- `.github/PULL_REQUEST_TEMPLATE.md` — short: what changed, why, how it
  was tested.
- `SECURITY.md` — "please email <address> rather than filing a public
  issue for security reports."
- **No** `FUNDING.yml` — premature monetization signal hurts community
  trust in week 1.

### Module 6 — Visual asset capture (delegated)

After all code changes are in place locally:

1. Spin up the cloud + desktop dev stack on the maintainer's machine.
2. Use the `codex-handoff` skill to dispatch Codex CLI (which has Computer
   Use) to drive the desktop app and capture 3-4 screenshots:
   - **A.** Login screen (clean, branded — for README hero).
   - **B.** Main chat thread with a streaming Claude Code response visible
     (shows the "live agent" feel).
   - **C.** Project kanban board with a few tasks in different columns
     (shows the orchestration angle).
   - **D.** Task detail drawer open on a real task (shows the depth).
3. Save into `docs/screenshots/`, commit, reference from README.

Fallback: if Codex bails (login wall, CAPTCHA, app not running), escalate
to the maintainer to capture manually.

### Module 7 — Cutover steps (maintainer-executed)

The flip-to-public step requires GitHub UI access, which the agent cannot
perform. After everything in Modules 1-6 is merged to `main`, the
maintainer:

1. Review the open-source-cogni PR diff end-to-end → merge.
2. GitHub repo Settings → "Change visibility" → Public.
3. Set repo Description, Website (leave blank for now), and Topics:
   suggested `ai-agent`, `claude-code`, `agent-orchestrator`, `tauri`,
   `typescript`, `monorepo`, `local-first`, `self-hosted`.
4. Optionally enable Discussions for community Q&A.
5. Optionally post a launch thread on X / Hacker News / r/LocalLLaMA.

The implementation plan should produce a short `LAUNCH.md` checklist in the
repo root documenting steps 2-5 for the maintainer to follow at flip time.
`LAUNCH.md` is itself listed in `.gitignore`'s untracked-but-local set
(it's an internal launch playbook, not user-facing content).

## Implementation order

Strict order so verification at each step is meaningful:

1. **Module 1** (LICENSE + package.json) — smallest, isolated.
2. **Module 2a/2b/2d** (untrack notes, drop personal slash commands) — file
   moves only, no code changes.
3. **Module 3** (scrub personal identifiers) — must finish before README
   rewrite refers to anything.
4. **Module 4** (README rewrite) — depends on 3 (no stale URLs) and on 6's
   screenshot filenames if those land first.
5. **Module 5** (community files) — independent, can interleave.
6. **Module 6** (screenshots) — runs in parallel with 4/5 via codex-handoff
   on the maintainer's machine.
7. **Module 2c** (branch hygiene on origin) — last, because it changes the
   default branch and we want all PR work landing on it.
8. **Module 7** (cutover) — maintainer-driven, post-merge.

## Out of scope

Explicitly NOT in this spec:

- Renaming the project / package. "Cogni" stays.
- Migrating to an org. Personal account `gxPan1006/cogni` is fine for now.
- Logo design — skipped per the brainstorming decision.
- Demo GIF — skipped initially, can be added in a follow-up.
- npm publication of any `@cogni/*` package.
- Translating README into Chinese (a `README.zh.md` companion may be a
  follow-up if the project gets traction in the Chinese AI community).
- Security audit of the existing codebase. We do a `grep` sweep but no
  formal review. CVE disclosure process is set up via `SECURITY.md`.

## Verification

A "done" definition for the implementation:

- `pnpm build && pnpm typecheck && pnpm test` all pass on the work branch.
- `grep -rE "ai-cognit|prod-cognit|spacemail" . --exclude-dir=node_modules
  --exclude-dir=.git --exclude-dir=docs/superpowers/specs` is empty.
- `git ls-files | grep -E "MEMORY\.md|HANDOFF-NOTES\.md|tbd\.md"` is empty.
- README renders correctly on GitHub (preview before merging) — hero image
  loads, badges render, no broken internal links.
- LICENSE file is present at repo root and `package.json` declares MIT.
- All standard community files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, the two issue templates, the PR template) exist and pass
  a quick eyeball review for obvious typos.
