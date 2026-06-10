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
