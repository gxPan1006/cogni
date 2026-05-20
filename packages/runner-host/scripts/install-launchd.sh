#!/usr/bin/env bash
#
# Install the cogni runner-host as a launchd LaunchAgent so it survives
# logout / reboot / crash. macOS only.
#
# Why: the runner-host is a long-lived daemon that the cloud dispatches
# project tasks to. Running it via `nohup node dist/main.js &` dies on
# reboot and never restarts after a crash — the cloud then marks the host
# offline and every project's task dispatch stalls. launchd with KeepAlive
# re-launches it automatically.
#
# Usage:
#   pnpm --filter @cogni/runner-host build      # produce dist/ first
#   pnpm --filter @cogni/runner-host install:launchd
#
# Reads host credentials from ~/.cogni/host.json (written during host
# registration), so no token plumbing here.
set -euo pipefail

LABEL="com.cogni.runner-host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Resolve the runner-host package dir from this script's location (scripts/..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
DIST_MAIN="$RUNNER_DIR/dist/main.js"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node not found on PATH. Install Node 22+ and retry." >&2
  exit 1
fi
if [ ! -f "$DIST_MAIN" ]; then
  echo "✗ $DIST_MAIN missing. Build first:" >&2
  echo "    pnpm --filter @cogni/runner-host build" >&2
  exit 1
fi
if [ ! -f "$HOME/.cogni/host.json" ]; then
  echo "✗ ~/.cogni/host.json missing. Register this host from the desktop app first." >&2
  exit 1
fi

# launchd hands the process a minimal PATH. The runner spawns git + the
# adapter CLIs (claude, codex), so we set a PATH that covers Homebrew, the
# system dirs, and ~/.local/bin (claude lives there). Derived from the dirs
# of the tools we can find now, plus the usual suspects, deduped.
declare -a PATH_DIRS=("/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin" "/usr/sbin" "/sbin" "$HOME/.local/bin")
for tool in git claude codex; do
  p="$(command -v "$tool" 2>/dev/null || true)"
  [ -n "$p" ] && PATH_DIRS+=("$(dirname "$p")")
done
# Dedupe preserving order.
RUNNER_PATH="$(printf '%s\n' "${PATH_DIRS[@]}" | awk '!seen[$0]++' | paste -sd: -)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.cogni"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIST_MAIN</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$RUNNER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$RUNNER_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.cogni/runner-host.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.cogni/runner-host.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

echo "✓ wrote $PLIST"

# Reload: bootout any existing instance (ignore failure if not loaded), then
# bootstrap the new plist into the per-user GUI domain.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "✓ loaded $LABEL into $DOMAIN"
echo ""
echo "  status:   launchctl print $DOMAIN/$LABEL | grep state"
echo "  logs:     tail -f ~/.cogni/runner-host.log"
echo "  stop:     pnpm --filter @cogni/runner-host uninstall:launchd"
