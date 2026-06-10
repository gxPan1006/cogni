# Open-Source Cogni Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the private `gxPan1006/cogni` repo from internal engineering shape to a publication-ready open-source project (MIT, scrubbed of personal infra, with standard community files and a marketing-ready README), all delivered as a single reviewable PR against `main`.

**Architecture:** Single feature branch `chore/open-source` off `main`. Seven modules of changes executed sequentially with verification at each step: license metadata → file untracking → personal-infra scrub → community files → README rewrite → screenshot capture (delegated to Codex) → maintainer cutover checklist. No code logic changes — only docs, configs, comments, defaults.

**Tech Stack:** git, pnpm (10.33.0), Node 22, the existing TypeScript monorepo, `codex-handoff` skill for screenshots.

**Spec:** [`docs/superpowers/specs/2026-05-25-open-source-cogni-design.md`](../specs/2026-05-25-open-source-cogni-design.md)

---

## Task 0: Prep workspace

**Files:**
- Stash: working-tree WIP (10 modified files in apps/desktop, apps/web, packages/*)
- Create branch: `chore/open-source` off `main`
- Add to git: `CLAUDE.md` (root), `docs/superpowers/specs/2026-05-25-open-source-cogni-design.md`

- [ ] **Step 1: Confirm we're on main with the expected HEAD**

Run: `git rev-parse --abbrev-ref HEAD && git log -1 --oneline main`
Expected: `main` and a SHA matching `172e1bf fix(ui): render task description newlines + cap description height` (or newer if user has committed since).

- [ ] **Step 2: Stash existing WIP (tracked changes only)**

Run: `git stash push -m "pre-open-source WIP (task detail, ProjectFiles, etc.)"`
Expected: "Saved working directory and index state ...". Untracked files (`docs/superpowers/specs/...`, `CLAUDE.md`, `.scratch/`, `docs/task-card-style-options.html`, `packages/ui/src/components/project/ProjectFiles.tsx`, `project-files.css`) remain in working tree.

- [ ] **Step 3: Create and switch to the work branch**

Run: `git checkout -b chore/open-source`
Expected: "Switched to a new branch 'chore/open-source'".

- [ ] **Step 4: Commit the spec doc + project CLAUDE.md**

```bash
git add docs/superpowers/specs/2026-05-25-open-source-cogni-design.md CLAUDE.md
git commit -m "docs: open-source-cogni design spec + project CLAUDE.md

Spec for opensourcing the repo (LICENSE, scrubs, README rewrite, community
files). CLAUDE.md added to track for the public repo — AI-friendly signal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Verify: `git log -1 --name-status` shows both files added.

---

## Task 1: License metadata (Module 1)

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (root), `apps/desktop/package.json`, `apps/web/package.json`, `packages/cloud/package.json`, `packages/contract/package.json`, `packages/runner-host/package.json`, `packages/shared/package.json`, `packages/ui/package.json`

- [ ] **Step 1: Create the LICENSE file**

Create `LICENSE` with this exact content:

```
MIT License

Copyright (c) 2026 Guoxun Pan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Add `"license": "MIT"` to each package.json**

For each of the 8 files below, add a `"license": "MIT"` line after the `"name"` (or `"private"`) key. They keep their `"private": true` — we're not publishing to npm.

```
package.json
apps/desktop/package.json
apps/web/package.json
packages/cloud/package.json
packages/contract/package.json
packages/runner-host/package.json
packages/shared/package.json
packages/ui/package.json
```

- [ ] **Step 3: Verify package.json files are still valid JSON**

Run: `for f in package.json apps/*/package.json packages/*/package.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" && echo "✓ $f"; done`
Expected: 8 ✓ lines, no parse errors.

- [ ] **Step 4: Run typecheck to make sure nothing broke**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add LICENSE package.json apps/*/package.json packages/*/package.json
git commit -m "chore: add MIT LICENSE + license field in all package.json

Copyright (c) 2026 Guoxun Pan. Packages remain private:true since we
don't publish to npm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Untrack internal engineering notes (Module 2a)

**Files:**
- Remove from tracking (kept on disk): 10 files/dirs listed below
- Modify: `.gitignore` (append untracked block)

- [ ] **Step 1: Append the untracked-but-local block to .gitignore**

Add this block at the end of `.gitignore`:

```gitignore
# Internal engineering notes — kept on the maintainer's machine but not
# checked into the public repo. (Previously tracked; untracked at
# open-sourcing time. Stay out of pull requests.)
MEMORY.md
HANDOFF-NOTES.md
tbd.md
docs/integration-log.md
docs/sp3-design-brief.md
docs/SP-2-E2E-VERIFICATION.md
docs/SP-2-OPS-MANUAL.md
docs/SP1-functional-test-plan.md
docs/DEPLOYMENT.md
docs/deploy/
docs/task-card-style-options.html
.scratch/
LAUNCH.md
```

- [ ] **Step 2: `git rm --cached` each tracked file**

Run:
```bash
git rm --cached \
  MEMORY.md \
  HANDOFF-NOTES.md \
  tbd.md \
  docs/integration-log.md \
  docs/sp3-design-brief.md \
  docs/SP-2-E2E-VERIFICATION.md \
  docs/SP-2-OPS-MANUAL.md \
  docs/SP1-functional-test-plan.md \
  docs/DEPLOYMENT.md
git rm -r --cached docs/deploy
```
Expected: each line prints "rm '...'". Files remain on disk.

- [ ] **Step 3: Verify the files are still on disk but untracked**

Run: `ls MEMORY.md HANDOFF-NOTES.md tbd.md docs/integration-log.md docs/DEPLOYMENT.md && git ls-files | grep -E "MEMORY|HANDOFF-NOTES|tbd|integration-log|SP-2-OPS|SP-2-E2E|SP1-functional|docs/DEPLOYMENT|docs/deploy"`
Expected: `ls` lists all files; `git ls-files | grep ...` outputs nothing.

- [ ] **Step 4: Verify .gitignore is keeping them ignored**

Run: `git status --short | grep -E "MEMORY|HANDOFF-NOTES|tbd"`
Expected: empty (gitignore filters them out of status).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: untrack internal engineering notes

MEMORY.md, HANDOFF-NOTES.md, tbd.md, and the ad-hoc docs/integration-log,
sp3-design-brief, SP-2/SP1 verification + ops docs, DEPLOYMENT.md, and the
docs/deploy/ scripts are maintainer-private. Keep on disk but stop tracking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Drop personal slash commands + add commands README (Module 2d)

**Files:**
- Delete: `.claude/commands/ship.md`, `.claude/commands/ship-web.md`
- Create: `.claude/commands/README.md`

- [ ] **Step 1: Delete the personal deployment slash commands**

Run: `git rm .claude/commands/ship.md .claude/commands/ship-web.md`
Expected: "rm '.claude/commands/ship.md'" + "rm '.claude/commands/ship-web.md'".

- [ ] **Step 2: Create `.claude/commands/README.md`**

```markdown
# Claude Code slash commands

This directory holds project-scoped slash commands that load automatically
when you open this repo in [Claude Code](https://claude.ai/code).

Each `*.md` file in this directory becomes a `/command-name` you can invoke
from the Claude Code prompt. The file content is the prompt template Claude
follows when you run the command.

See the [Claude Code docs](https://docs.claude.com/en/docs/claude-code/slash-commands)
for the full format.

## Contributing a command

Useful general-purpose commands are welcome. Skip commands that hardcode
personal deployment paths, internal infra, or one-off workflows — those
belong in your own `~/.claude/commands/` instead.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/
git commit -m "chore: drop personal /ship + /ship-web; add commands README

/ship and /ship-web hardcoded the maintainer's prod deployment paths and
domain. Removed. Added a README explaining what .claude/commands/ is so
the dir doesn't look mysterious to first-time readers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Scrub personal infra in code defaults + mock data (Module 3 part 1)

**Files:**
- Modify: `packages/cloud/src/env.ts`, `packages/ui/src/components/SettingsPage.tsx`, `apps/desktop/src/Artifacts.tsx`, `apps/desktop/.env.production`, `apps/web/.env.production`

These are *behavior-affecting* defaults — they leak the maintainer's prod URL into a cloned-and-built copy of the project.

- [ ] **Step 1: Fix the cloud env.ts defaults**

In `packages/cloud/src/env.ts`:

Replace line 107:
```ts
          subject: process.env.VAPID_SUBJECT ?? "mailto:admin@ai-cognit.com",
```
with:
```ts
          subject: process.env.VAPID_SUBJECT ?? "mailto:admin@your-cogni-cloud.example.com",
```

Replace line 117:
```ts
    webUrl: process.env.WEB_URL ?? "https://chat.ai-cognit.com",
```
with:
```ts
    webUrl: process.env.WEB_URL ?? "https://chat.your-cogni-cloud.example.com",
```

(Line numbers may shift slightly — find by string match.)

- [ ] **Step 2: Fix the desktop Settings page "Cloud" field**

In `packages/ui/src/components/SettingsPage.tsx` around line 574, replace:
```tsx
            <dt>Cloud</dt><dd>cloud.ai-cognit.com</dd>
```
with code that reads the cloud URL from the build-time env (preferred) or shows a generic placeholder:
```tsx
            <dt>Cloud</dt><dd>{import.meta.env.VITE_CLOUD_URL ?? "(not configured)"}</dd>
```

Note: verify `import.meta.env.VITE_CLOUD_URL` is already used elsewhere in this file or other components — if so, just match the existing pattern. Otherwise fall back to a hardcoded `<dd>(see VITE_CLOUD_URL)</dd>`.

- [ ] **Step 3: Fix the mock artifacts data**

In `apps/desktop/src/Artifacts.tsx` around line 27, replace:
```ts
  { id: "a-008", kind: "shell",      title: "pnpm dev recipe for prod-cognit",  thread: "Deployment recipe",         when: "Sun",     size: "14 lines",           pinned: false },
```
with:
```ts
  { id: "a-008", kind: "shell",      title: "pnpm dev recipe for staging",      thread: "Deployment recipe",         when: "Sun",     size: "14 lines",           pinned: false },
```

- [ ] **Step 4: Fix `apps/desktop/.env.production`**

Replace the entire file with:
```
# Production build target for the desktop app — points at YOUR cogni cloud
# deployment. Override before building a release.
VITE_CLOUD_URL=https://your-cogni-cloud.example.com
```

- [ ] **Step 5: Fix `apps/web/.env.production`**

Replace the entire file with:
```
# Production build target for the web SPA — points at YOUR cogni cloud
# deployment. Override before building a release.
VITE_CLOUD_URL=https://your-cogni-cloud.example.com
```

- [ ] **Step 6: Build to make sure nothing broke**

Run: `pnpm build`
Expected: pass (all packages build).

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/env.ts packages/ui/src/components/SettingsPage.tsx \
        apps/desktop/src/Artifacts.tsx apps/desktop/.env.production \
        apps/web/.env.production
git commit -m "chore: scrub maintainer prod URL from code defaults + env

env.ts webUrl + VAPID subject defaults now point at the placeholder
your-cogni-cloud.example.com instead of chat.ai-cognit.com /
admin@ai-cognit.com. Desktop Settings page reads VITE_CLOUD_URL instead
of hardcoding the prod URL. Mock artifact label uses 'staging' instead
of 'prod-cognit'. .env.production files in apps/* now hold the generic
placeholder (you override at build time).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Scrub personal infra in docs + comments (Module 3 part 2)

**Files:**
- Modify: `docs/RUNNING.md`, `packages/cloud/.env.example`, `packages/cloud/src/server.ts`, `packages/cloud/src/email/transport.ts`, `packages/cloud/src/routes/auth.ts`, `apps/web/src/api.ts`, `apps/web/vite.config.ts`
- Optionally modify: `docs/superpowers/plans/2026-05-18-cogni-sp2-accounts-sync-web.md`, `docs/superpowers/plans/2026-05-20-default-project-folder.md`, `docs/superpowers/plans/2026-05-20-workspace-chat-orchestrator.md`

These hits are in **comments / docs / example configs**. They don't change behavior but read as "maintainer's personal infra" to outside readers.

- [ ] **Step 1: Scrub `docs/RUNNING.md`**

Read the file end-to-end first. Replace any mention of:
- `ai-cognit.com` / `cloud.ai-cognit.com` / `chat.ai-cognit.com` → `your-cogni-cloud.example.com` (or just remove the line if it's a "in our prod we do X" aside)
- `prod-cognit` (an SSH host alias) → remove the sentence/section that mentions it; users will have their own deploy story
- `spacemail` → `your-mail-provider.example.com` or rephrase the example

If a section is purely "how the maintainer specifically deploys", consider deleting that section entirely. RUNNING.md should be "how a contributor sets up dev"; deployment is out of scope for it.

- [ ] **Step 2: Scrub `packages/cloud/.env.example`**

Replace lines 14-15:
```
# - `smtp`:   classic SMTP via nodemailer. Required env: SMTP_HOST, SMTP_PORT,
#             SMTP_USER, SMTP_PASSWORD, EMAIL_FROM. Use when you already have
#             a mailbox at spacemail / postmark / aws-ses-smtp / etc.
```
with:
```
# - `smtp`:   classic SMTP via nodemailer. Required env: SMTP_HOST, SMTP_PORT,
#             SMTP_USER, SMTP_PASSWORD, EMAIL_FROM. Use when you already have
#             a mailbox at postmark / aws-ses-smtp / your own SMTP provider.
```

Replace lines 43-45:
```
# Contact URI per the Web Push spec (mailto: or https:). Defaults to
# mailto:admin@ai-cognit.com.
# VAPID_SUBJECT=mailto:admin@ai-cognit.com
```
with:
```
# Contact URI per the Web Push spec (mailto: or https:). Defaults to
# mailto:admin@your-cogni-cloud.example.com.
# VAPID_SUBJECT=mailto:admin@your-cogni-cloud.example.com
```

- [ ] **Step 3: Scrub `packages/cloud/src/server.ts`**

Around lines 59 and 71, replace any `chat.ai-cognit.com` mention in comments with `chat.your-cogni-cloud.example.com` (or the generic phrase "your production web SPA host"). These are comments, not behavior.

- [ ] **Step 4: Scrub `packages/cloud/src/email/transport.ts`**

Around lines 10 and 98, replace:
- `spacemail / postmark / aws-ses-smtp` → `postmark / aws-ses-smtp / your own SMTP provider`
- `"Cogni <us@ai-cognit.com>"` (in a code comment) → `"Cogni <us@your-domain.example.com>"`

- [ ] **Step 5: Scrub `packages/cloud/src/routes/auth.ts`**

Around line 85, comment mentions `chat.ai-cognit.com/chat` — change to `chat.your-cogni-cloud.example.com/chat` or rephrase to "the web SPA's `/chat` URL".

- [ ] **Step 6: Scrub `apps/web/src/api.ts`**

Around line 14, comment mentions `cloud.ai-cognit.com` — change to `your-cogni-cloud.example.com` or rephrase generically.

- [ ] **Step 7: Scrub `apps/web/vite.config.ts`**

Around line 7, comment mentions `chat.ai-cognit.com` — change to `chat.your-cogni-cloud.example.com` or rephrase to "your production web origin".

- [ ] **Step 8: Decide on `docs/superpowers/plans/*` files**

These three plans mention `ai-cognit.com` in historical context. Two options:
- **A (recommended):** Leave them. They're historical design documents and the maintainer's prod URL appearing as a one-off example doesn't read as embarrassing — it reads as "this project was actually shipped." The grep verification in Task 10 explicitly excludes `docs/superpowers/`.
- **B:** Sed-replace `ai-cognit.com` → `your-cogni-cloud.example.com` across these plan files.

Default: **option A** (leave them). Skip this step. Note the choice in commit message.

- [ ] **Step 9: Re-grep to verify**

Run:
```bash
grep -rE "ai-cognit|prod-cognit|spacemail" . \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir="docs/superpowers"
```
Expected: empty output (or matches only in untracked maintainer notes like `tbd.md`, which is OK because those are gitignored now).

If anything is left, fix it.

- [ ] **Step 10: Run tests to confirm nothing regressed**

Run: `pnpm test`
Expected: same pass count as on main. (Some tests like `env.test.ts` reference `ai-cognit.com` in assertions — if so, update assertions to match the new placeholder.)

If `env.test.ts` fails: edit its assertions to match the new defaults. Re-run tests.

- [ ] **Step 11: Commit**

```bash
git add -u
git commit -m "chore: scrub personal infra references from docs + comments

Replace ai-cognit.com / prod-cognit / spacemail with generic placeholders
(your-cogni-cloud.example.com, postmark, etc.) in:
- docs/RUNNING.md
- packages/cloud/.env.example + server.ts + env.ts + email/transport.ts +
  routes/auth.ts
- apps/web/src/api.ts + vite.config.ts

docs/superpowers/plans/*.md left unmodified — historical design docs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Community files — CONTRIBUTING / CODE_OF_CONDUCT / SECURITY (Module 5 part 1)

**Files:**
- Create: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```markdown
# Contributing to Cogni

Thanks for your interest! This is an early-stage project and we welcome
bug reports, feature ideas, and code contributions of any size.

## Quick links

- **Local dev setup:** see [`docs/RUNNING.md`](docs/RUNNING.md). It covers
  Neon Postgres, Google OAuth, and the build steps end-to-end.
- **Architecture overview:** see the README's "How it works" section and
  the design docs in [`docs/superpowers/specs/`](docs/superpowers/specs/).
- **Project status / roadmap:** the README has the high-level cut; design
  docs are the deep cut.

## Reporting a bug

Open an issue with the **bug report** template. Include:
- What you expected to happen and what actually happened.
- Steps to reproduce.
- Your environment (OS, Node version, browser if it's web-side).
- Any relevant log output. Logs live at `~/.cogni/runner-host.log` on the
  desktop side and in your cloud server's stdout.

## Suggesting a feature

Open an issue with the **feature request** template. Briefly describe the
problem you're trying to solve before describing the feature — solutions
without problems tend to get bikeshedded.

## Sending a pull request

1. Fork the repo and create a topic branch off `main`.
2. Run the dev environment locally and confirm your change works.
3. Run the test + lint + typecheck gates before pushing:
   ```sh
   pnpm test
   pnpm lint
   pnpm typecheck
   ```
4. Match the existing code style. The codebase has hard rules — see
   [`CLAUDE.md`](CLAUDE.md) for the conventions document (it's written for
   AI assistants but reads fine to humans).
5. Open a PR against `main`. Fill out the PR template.

CI matches the local gates. PRs need a green check to merge.

## Tooling pins

The CI workflow pins specific versions; reproduce these locally to avoid
"works on my machine" mismatches:

- Node **22.x**
- pnpm **10.33.0** (via corepack: `corepack enable && corepack prepare pnpm@10.33.0 --activate`)

## Code of Conduct

Participation in this project is governed by the
[Contributor Covenant](CODE_OF_CONDUCT.md).
```

- [ ] **Step 2: Create `CODE_OF_CONDUCT.md`**

Use the Contributor Covenant v2.1 unmodified. The full text is at:
https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md

Copy it verbatim. Then update the contact line near the bottom to:
> Instances of abusive, harassing, or otherwise unacceptable behavior may be
> reported to the community leaders responsible for enforcement at
> **[an issue on this repo](https://github.com/gxPan1006/cogni/issues)** or
> by emailing the repo owner (see the GitHub profile of @gxPan1006).

(Reason for not using a direct email: we want to avoid putting the
maintainer's email in the public repo before they've decided on a contact
address.)

- [ ] **Step 3: Create `SECURITY.md`**

```markdown
# Security Policy

## Reporting a vulnerability

If you find a security issue in Cogni, please **do not open a public
GitHub issue**. Instead:

- Use GitHub's [private vulnerability reporting](https://github.com/gxPan1006/cogni/security/advisories/new)
  on this repo, or
- Email the repo owner directly (see the GitHub profile of @gxPan1006).

Please include:
- A description of the vulnerability and the affected component
  (cloud / desktop / runner-host).
- Steps to reproduce or a minimal proof-of-concept.
- Your assessment of the impact.

We aim to acknowledge reports within 5 business days. Once a fix is
prepared, we will coordinate disclosure with you.

## Supported versions

Cogni is pre-1.0 and ships off `main`. Only the latest commit on `main`
is considered supported. Pin to a tag if you need stability.
```

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
git commit -m "docs: add CONTRIBUTING + CODE_OF_CONDUCT + SECURITY

Standard OSS community files. CONTRIBUTING points at docs/RUNNING.md for
dev setup, calls out the Node 22 + pnpm 10.33.0 pins, and lists the
test/lint/typecheck gates. CODE_OF_CONDUCT is unmodified Contributor
Covenant 2.1. SECURITY points at GitHub private vulnerability reporting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Issue + PR templates (Module 5 part 2)

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Create `.github/ISSUE_TEMPLATE/bug_report.yml`**

```yaml
name: Bug report
description: Something doesn't work as expected
labels: ["bug", "needs-triage"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to file a bug. Please fill out the
        fields below — it makes the bug 10× faster to triage.
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: What did you expect, and what actually happened?
      placeholder: I clicked X and expected Y, but Z happened instead.
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. Open the desktop app
        2. Click ...
        3. ...
    validations:
      required: true
  - type: dropdown
    id: component
    attributes:
      label: Which component is affected?
      multiple: true
      options:
        - cloud (Hono server, DB)
        - desktop app (Tauri)
        - web app
        - runner-host daemon
        - shared packages (contract / ui)
        - docs
        - not sure
    validations:
      required: true
  - type: input
    id: env
    attributes:
      label: Environment
      description: OS, Node version, browser if applicable.
      placeholder: "macOS 15.5, Node 22.14, Chrome 138"
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant logs
      description: |
        Paste any error messages or log output. The runner-host log is at
        `~/.cogni/runner-host.log`; the cloud server logs to stdout.
      render: shell
```

- [ ] **Step 2: Create `.github/ISSUE_TEMPLATE/feature_request.yml`**

```yaml
name: Feature request
description: Suggest a new feature or improvement
labels: ["enhancement", "needs-triage"]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem are you trying to solve?
      description: Describe the pain point or use case before the solution.
      placeholder: When I do X, I have to manually do Y every time, which ...
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
      description: How would you like Cogni to solve this?
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives you've considered
      description: Other approaches you thought about. Helps us pick the best fit.
  - type: textarea
    id: context
    attributes:
      label: Additional context
      description: Screenshots, links, anything else.
```

- [ ] **Step 3: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
## What this PR does

<!-- One paragraph summary. -->

## Why

<!-- The problem this solves or feature this adds. Link any related issue. -->

## How I tested it

<!-- Local steps you ran. Did `pnpm test` / `pnpm lint` / `pnpm typecheck` pass? Did you exercise the change in the running app? -->

## Notes for reviewers

<!-- Anything reviewers should pay attention to — tricky tradeoffs, deliberate scope cuts, etc. Skip if nothing. -->
```

- [ ] **Step 4: Verify the YAML parses**

Run: `node -e "const yaml=require('js-yaml'); for (const f of ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml']) { yaml.load(require('fs').readFileSync(f, 'utf-8')); console.log('✓', f); }"`
Expected: 2 ✓ lines.

If `js-yaml` is not installed, skip this step — GitHub will surface YAML errors when the template loads in the UI. Spot-check the YAML visually instead.

- [ ] **Step 5: Commit**

```bash
git add .github/
git commit -m "docs: add bug + feature issue templates and PR template

GitHub Forms-format issue templates so contributors get guided through
the right info. PR template prompts for what/why/how-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Capture screenshots via codex-handoff (Module 6)

**Files:**
- Create: `docs/screenshots/login.png`, `docs/screenshots/chat.png`, `docs/screenshots/kanban.png`, `docs/screenshots/task-detail.png`

**Note:** This task delegates to the Codex CLI via the `codex-handoff` skill. Codex has Computer Use and can drive the desktop app to capture the UI. Run this task before Task 9 so the README rewrite can reference the screenshot filenames.

- [ ] **Step 1: Start the dev stack (in two background terminals)**

Run (background): `pnpm --filter @cogni/cloud dev`
Wait for: "Cloud server listening on :8787"

Run (background): `pnpm --filter desktop tauri dev`
Wait for: the Tauri webview window to open.

If the dev stack doesn't come up cleanly (Neon DB not configured, missing env, etc.), pause this task and ask the maintainer to start the stack manually, then come back.

- [ ] **Step 2: Use the codex-handoff skill to dispatch screenshot capture**

Invoke the `codex-handoff` skill with this brief:

> Drive the running Cogni desktop app (Tauri webview, should already be open
> on the maintainer's screen) and capture these 4 screenshots, saving them
> to `/Users/guoxunpan/code/cogni/docs/screenshots/`:
>
> 1. `login.png` — the login screen (initial state before signing in).
> 2. `chat.png` — a chat thread with at least one assistant message
>    visible. If no chats exist, create a new chat and send "hello cogni"
>    to seed one, then wait for the response.
> 3. `kanban.png` — a project's kanban board view. If no projects exist,
>    create a project called "Demo" with one task in each of (planning,
>    running, done) columns, then capture.
> 4. `task-detail.png` — a task detail drawer open over the kanban (click
>    one of the demo tasks).
>
> Use Cmd+Shift+4 + Space for window-scoped capture if Codex can drive
> macOS shortcuts, or its native browser screenshot if it can't reach the
> Tauri window directly (in which case substitute the web app at
> http://localhost:5173 — same UI).
>
> If you hit a CAPTCHA / Google OAuth wall / can't log in, bail and report
> which step blocked you. The maintainer will capture manually.

- [ ] **Step 3: Verify the screenshots landed**

Run: `ls -la docs/screenshots/`
Expected: 4 PNG files, each > 50KB (sanity-check they're real screenshots, not 1-byte placeholders).

If Codex bailed, escalate to the maintainer: ask them to capture 4 screenshots manually and save to `docs/screenshots/` with the listed filenames, then resume.

- [ ] **Step 4: (Optional) Crop and compress**

If screenshots are very large (each > 1 MB), run them through a quick compress. macOS built-in: `sips -s formatOptions normal -s format png docs/screenshots/*.png`. Or skip — GitHub serves PNGs fine even at a few MB each.

- [ ] **Step 5: Commit**

```bash
git add docs/screenshots/
git commit -m "docs: add README screenshots (login, chat, kanban, task detail)

Captured against local dev stack. Referenced from README in Task 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: README rewrite (Module 4)

**Files:**
- Modify: `README.md` (full replacement)

- [ ] **Step 1: Replace the entire README with the new content**

Overwrite `README.md` with:

````markdown
<p align="center">
  <img src="docs/screenshots/chat.png" alt="Cogni desktop chat" width="800">
</p>

<h1 align="center">Cogni</h1>

<p align="center">
  <strong>Claude Code, but with a brain in the cloud.</strong><br>
  Open-source AI workspace — your laptop runs the agents, your devices stay in sync.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href=".github/workflows/ci.yml"><img src="https://github.com/gxPan1006/cogni/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/gxPan1006/cogni/stargazers"><img src="https://img.shields.io/github/stars/gxPan1006/cogni?style=social" alt="GitHub stars"></a>
</p>

---

## What it does

- 🧠 **Multi-device sync** — chat from web, desktop, or mobile. The agent
  keeps running on your laptop while you switch screens.
- 🛠 **Agent orchestration** — projects, tasks, and a kanban board built on
  top of [Claude Code](https://claude.ai/code). A pluggable runner
  abstraction lets other agent CLIs slot in.
- 🔒 **Self-host** — heavy lifting happens on your own machine. The cloud
  control plane is a small Node + Postgres service you can host on Neon,
  Vercel, Fly, or a $5 VPS.

<p align="center">
  <img src="docs/screenshots/kanban.png" alt="Project kanban board" width="400">
  <img src="docs/screenshots/task-detail.png" alt="Task detail view" width="400">
</p>

## Quick start

You'll need [Node 22+](https://nodejs.org), [pnpm
10.33+](https://pnpm.io/installation), a [Neon](https://neon.tech) Postgres
URL, and a Google OAuth client (for sign-in).

```sh
# 1. Clone and install
git clone https://github.com/gxPan1006/cogni.git
cd cogni
corepack enable && corepack prepare pnpm@10.33.0 --activate
pnpm install

# 2. Configure the cloud
cp packages/cloud/.env.example packages/cloud/.env
# Edit .env — fill in DATABASE_URL (Neon), JWT_SECRET, GOOGLE_CLIENT_ID/SECRET

pnpm build
pnpm --filter @cogni/cloud exec drizzle-kit push  # apply schema to Neon

# 3. Run it
pnpm --filter @cogni/cloud dev       # cloud control plane on :8787
pnpm --filter desktop tauri dev      # desktop app — sign in, then chat
```

Full setup (including the Google OAuth redirect URI, optional magic-link
email transport, and PWA push notifications) is in
[`docs/RUNNING.md`](docs/RUNNING.md).

## How it works

```
┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│  Web / Desktop /    │      │   Cloud control     │      │   Runner Host       │
│  Mobile chat UI     │◄────►│   plane             │◄────►│   (your laptop)     │
│                     │  WS  │  (Hono + Neon)      │  WS  │                     │
│  (Tauri, Vite SPA)  │      │                     │      │   ↓                 │
└─────────────────────┘      └─────────────────────┘      │   Claude Code       │
                                                          │   (or other CLI)    │
                                                          └─────────────────────┘
```

The **cloud** owns accounts, projects, and message history. It does not
have an API key for any LLM — it routes work to the **Runner Host**, a
small daemon that registers itself with the cloud over WebSocket and runs
on your own machine. The runner host launches Claude Code (or any other
adapted agent CLI) inside a git worktree of your choosing.

This split means:
- **Your code never leaves your laptop.** The cloud only sees the chat
  messages you send.
- **Multi-device works for free.** Cloud is the source of truth; any
  device you sign in on sees the same conversations and projects.
- **You can swap the agent.** The runner abstraction is `RunnerAdapter` in
  [`packages/contract`](packages/contract/src). Today's adapters are
  Claude Code and an experimental Codex one.

Full design rationale lives in
[`docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md`](docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md).

## Tech stack

TypeScript end to end. **Cloud:** Hono on Node 22, Neon Postgres,
drizzle-orm, WebSockets via `@hono/node-ws`. **Desktop:** Tauri 2 + React
19. **Web:** React 19 + Vite, deployed as a SPA. **Monorepo:** pnpm
workspaces.

## Project status

- ✅ SP-1 (spine) — cloud + runner-host + desktop chat loop.
- ✅ SP-2 (accounts + multi-device sync + web client).
- ✅ SP-3 (project domain — projects, tasks, kanban, orchestrator).
- 🚧 SP-4 (polish + Windows support).

This is pre-1.0 and ships off `main`. Breaking changes will land in
named "SP-N" sub-projects with design docs in `docs/superpowers/specs/`.

## Contributing

We welcome bug reports, feature ideas, and PRs. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to set up dev and the local
test/lint/typecheck gates.

The codebase has hard rules (TypeScript strict mode, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, the runner abstraction boundary, the cloud↔host
protocol contract). [`CLAUDE.md`](CLAUDE.md) documents them — it's written
for AI assistants but reads cleanly for humans too.

## License

MIT — see [`LICENSE`](LICENSE).
````

- [ ] **Step 2: Verify all referenced files exist**

Run:
```bash
for f in LICENSE CONTRIBUTING.md CLAUDE.md docs/RUNNING.md \
         docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md \
         docs/screenshots/login.png docs/screenshots/chat.png \
         docs/screenshots/kanban.png docs/screenshots/task-detail.png \
         packages/cloud/.env.example packages/contract/src; do
  test -e "$f" && echo "✓ $f" || echo "✗ MISSING: $f"
done
```
Expected: all ✓.

If any ✗, either the path is wrong in the README or the file genuinely doesn't exist — fix whichever side is wrong.

- [ ] **Step 3: Preview the README locally**

Open `README.md` in a markdown previewer (VS Code: Cmd+Shift+V, or just visually scan). Verify:
- Screenshots show up (or have alt text).
- ASCII architecture diagram is aligned.
- No broken `[label](path)` links.
- No `gxPan1006/cogni` URLs are stale — they should all point to the actual repo path.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for open-source launch

Replace the internal engineering-log README with a marketing-ready one:
hero screenshot, MIT/CI/stars badges, 3-bullet value prop, quick start,
architecture diagram (ASCII), tech stack, project status, contributing
pointer.

No mention of the maintainer's hosted prod URL — strictly self-host
positioning per the open-source design spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Final verification gates

**Files:** none modified — read-only verification.

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: pass.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Tests**

Run: `pnpm test`
Expected: pass (same pass count as on `main`).

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: pass.

- [ ] **Step 5: Personal-infra grep gate**

Run:
```bash
grep -rE "ai-cognit|prod-cognit|spacemail" . \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir="docs/superpowers"
```
Expected: empty output. (Specs and historical plans under `docs/superpowers/` are allowed to mention the historical domain name.)

- [ ] **Step 6: Untracked-notes gate**

Run: `git ls-files | grep -E "^(MEMORY|HANDOFF-NOTES|tbd)\.md$|^docs/(integration-log|sp3-design-brief|SP-2|SP1|DEPLOYMENT)|^docs/deploy/"`
Expected: empty.

- [ ] **Step 7: LICENSE presence gate**

Run: `test -f LICENSE && grep -q "MIT License" LICENSE && echo "✓ LICENSE present" || echo "✗ LICENSE missing or wrong"`
Expected: ✓.

- [ ] **Step 8: License metadata gate**

Run: `for f in package.json apps/*/package.json packages/*/package.json; do grep -q '"license": "MIT"' "$f" && echo "✓ $f" || echo "✗ $f missing license"; done`
Expected: 8 ✓ lines.

- [ ] **Step 9: Community files gate**

Run: `for f in CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml; do test -f "$f" && echo "✓ $f" || echo "✗ $f"; done`
Expected: 6 ✓ lines.

- [ ] **Step 10: If any gate fails, fix it now, before pushing**

Don't push a branch that fails its own verification.

---

## Task 11: Push branch + open PR (Module 7 prep)

**Files:** none modified — git ops only.

- [ ] **Step 1: Sanity check the branch is rebased / up to date with main**

Run: `git fetch origin && git log main..chore/open-source --oneline | wc -l`
Expected: a positive number (= the number of commits this work added; ~9 if one per task).

- [ ] **Step 2: Push the branch**

Run: `git push -u origin chore/open-source`
Expected: branch pushes successfully.

- [ ] **Step 3: Open the PR via gh CLI**

```bash
gh pr create --base main --head chore/open-source \
  --title "chore: prepare cogni for open-source launch" \
  --body "$(cat <<'EOF'
Turn the private `gxPan1006/cogni` repo into a publication-ready
open-source project.

## What changed

- **License:** MIT, with `"license": "MIT"` on root + all workspace
  package.json files.
- **Personal infra scrubbed:** code defaults, comments, mock data, and
  `.env.production` no longer reference `cloud.ai-cognit.com` /
  `prod-cognit` / `spacemail`. The maintainer's hosted deployment
  is unaffected (it sets its own env at deploy time); fresh clones now
  point at `your-cogni-cloud.example.com` placeholders.
- **Internal notes untracked:** MEMORY.md, HANDOFF-NOTES.md, tbd.md,
  ad-hoc integration / verification / deployment docs — `git rm --cached`
  and `.gitignore`d. Kept on the maintainer's disk.
- **Personal slash commands dropped:** `.claude/commands/ship*.md`
  removed; a brief README explains what the dir is.
- **Community files added:** CONTRIBUTING / CODE_OF_CONDUCT / SECURITY,
  issue + PR templates.
- **README rewritten:** marketing-ready, hero screenshot, 3-bullet value
  prop, quick start, architecture diagram, project status.
- **Screenshots captured:** `docs/screenshots/{login,chat,kanban,task-detail}.png`
  via the codex-handoff workflow.

## Spec + plan

- Design: [docs/superpowers/specs/2026-05-25-open-source-cogni-design.md](docs/superpowers/specs/2026-05-25-open-source-cogni-design.md)
- Plan: [docs/superpowers/plans/2026-05-25-open-source-cogni.md](docs/superpowers/plans/2026-05-25-open-source-cogni.md)

## Verification

- `pnpm build && pnpm typecheck && pnpm test && pnpm lint` — all pass.
- `grep -rE "ai-cognit|prod-cognit|spacemail" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=docs/superpowers` — empty.
- `git ls-files | grep -E "^(MEMORY|HANDOFF-NOTES|tbd)\.md$"` — empty.

## After merge

The maintainer flips the repo to Public via GitHub Settings. See
`LAUNCH.md` (local, untracked) for the cutover checklist.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 4: Print the PR URL for the maintainer**

Print the PR URL conspicuously so the maintainer can click it.

---

## Task 12: Maintainer cutover checklist (Module 7)

**Files:**
- Create: `LAUNCH.md` (locally, **not committed** — `.gitignore`d in Task 2)

This task is not part of the PR. It produces a local-only checklist file the maintainer can follow after merging.

- [ ] **Step 1: Write `LAUNCH.md` to the repo root (local-only)**

```markdown
# Cogni open-source launch checklist

This file is gitignored. Do **not** commit it — it's a private launch
playbook.

## Pre-launch (do these before flipping to public)

- [ ] Merge the `chore/open-source` PR into `main`.
- [ ] Verify the merged commit on `main` looks correct on github.com.
- [ ] If there are stale branches on the remote that look unprofessional
      to outsiders, delete them: `feat/task-comment-cards`, any other
      half-baked feature branches. Dependabot branches are fine — they
      regenerate.

## Flip to public

- [ ] Go to https://github.com/gxPan1006/cogni/settings.
- [ ] Scroll to **Danger Zone → Change repository visibility**.
- [ ] Click **Change visibility → Make public**.
- [ ] Confirm with the repo name.

## Settings tab — repo metadata

- [ ] In **About** (top right of the repo home page):
  - Description: `Claude Code, but with a brain in the cloud — open-source AI workspace that runs agents on your laptop and syncs across devices.`
  - Website: leave blank (or your personal site).
  - Topics: `ai-agent`, `claude-code`, `agent-orchestrator`, `tauri`,
            `typescript`, `monorepo`, `local-first`, `self-hosted`,
            `react`, `hono`.
  - Check ☑ "Releases" off, "Packages" off until you have a release.

- [ ] Settings → General → Default branch: change from `sp1-followups` to
      `main` (click the swap icon next to "Default branch").
- [ ] Settings → General → Features:
  - ☑ Issues (on)
  - ☑ Discussions (consider — turn on if you have time to moderate)
  - ☐ Wiki (off — README + docs/ is enough)
  - ☐ Projects (off — kanban is in the app, not on GitHub)
- [ ] Settings → Branches → Add branch protection on `main`:
  - Require status checks (the CI workflow).
  - Require PR before merging (optional — relax if you're the only committer).

## Cleanup

- [ ] Delete the merged `chore/open-source` branch on origin if GitHub
      didn't auto-delete it.
- [ ] Delete stale remote branches you don't want public:
  ```sh
  git push origin --delete feat/task-comment-cards
  # ... any others
  ```

## Announce (optional, ride the wave)

- [ ] Tweet / X post — keep it short, link the repo, attach the chat
      screenshot.
- [ ] Hacker News "Show HN: Cogni — open-source AI workspace that runs
      agents on your laptop" — Tuesday-Thursday morning ET tends to land best.
- [ ] r/LocalLLaMA — emphasize the "your code never leaves your laptop"
      angle there.
- [ ] If you have a personal blog, write up the "why I built this" post
      and link it from the repo description.

## Post-launch ops (first week)

- [ ] Watch the Issues tab daily; triage labels.
- [ ] If a PR comes in from a stranger, thank them in the comment
      regardless of whether you merge.
- [ ] Resist the urge to keep polishing — the repo is "out" now, ship
      improvements through PRs like everyone else.
```

- [ ] **Step 2: Confirm LAUNCH.md is gitignored**

Run: `git check-ignore LAUNCH.md`
Expected: prints `LAUNCH.md` (= it's ignored).

- [ ] **Step 3: Tell the maintainer the launch checklist is ready**

Print a one-liner: "Open-source-ization PR is up. Local `LAUNCH.md` has the manual cutover steps. Read it before flipping to public on GitHub."

---

## Done. Restore WIP (post-merge, off-plan)

After the maintainer merges and decides everything is settled:

```bash
git checkout main
git pull
git stash pop
```

This restores the pre-existing WIP from Task 0 Step 2 onto a clean `main`.

If `stash pop` has conflicts (some of your scrub edits touched the same
files as the WIP), resolve them by hand — favor keeping the WIP's
behavioral changes and the scrub's text replacements.
