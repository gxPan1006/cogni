# Security Policy

## Supported versions

Cogni is an early-stage project under active development. Security fixes are
applied to the latest commit on the `main` branch only. There are no
long-lived release branches yet.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately using GitHub's private vulnerability reporting:

- <https://github.com/gxPan1006/cogni/security/advisories/new>

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (proof-of-concept if possible).
- The affected component (cloud control plane, runner-host daemon, desktop app,
  or web client) and commit/version if known.

We will acknowledge your report as soon as possible, work with you to
understand and validate the issue, and keep you informed as we develop a fix.
We ask that you give us a reasonable opportunity to address the issue before any
public disclosure.

## Scope notes

Cogni's security model spans a cloud control plane and a desktop-side runner
host that executes agents on the user's own machine. When reporting, it helps
to note which trust boundary is affected — for example, cloud↔host WebSocket
auth, host-RPC handling, OAuth / magic-link flows, or local runner sandboxing.
