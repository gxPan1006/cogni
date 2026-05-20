# @cogni/runner-host

The desktop-side daemon. Registers with the cloud via `~/.cogni/host.json`,
manages runner adapters (Claude Code, Codex), and answers cloud→host RPCs
(git worktree ops, fs-browse, thread-title generation). See the repo root
`CLAUDE.md` for where it sits in the SP-1 → SP-3 architecture.

## Local setup

```sh
# 1. Build (the daemon runs from dist/, not src/)
pnpm --filter @cogni/runner-host build

# 2. Register the host once from the desktop app ("Add a new computer"),
#    which writes ~/.cogni/host.json with { hostId, registrationToken, cloudUrl }.

# 3a. Run in the foreground for quick local testing:
pnpm --filter @cogni/runner-host start     # node dist/main.js

# 3b. OR install as a launchd LaunchAgent so it survives reboot + crash:
pnpm --filter @cogni/runner-host install:launchd
```

### launchd persistence (macOS)

`nohup node dist/main.js &` dies on logout/reboot and never restarts after a
crash — the cloud then marks the host offline and project task dispatch
stalls. `install:launchd` writes `~/Library/LaunchAgents/com.cogni.runner-host.plist`
with `KeepAlive` (auto-restart on crash) + `RunAtLoad` (start on login), and
a `PATH` that covers `git` + the adapter CLIs (`claude`, `codex`) since
launchd hands processes a minimal environment.

```sh
# status
launchctl print gui/$(id -u)/com.cogni.runner-host | grep state
# logs
tail -f ~/.cogni/runner-host.log
# remove
pnpm --filter @cogni/runner-host uninstall:launchd
```

After editing runner-host source, rebuild (`pnpm --filter @cogni/runner-host build`)
then `pnpm --filter @cogni/runner-host install:launchd` again — it boots out the
old instance and kickstarts the new one.
