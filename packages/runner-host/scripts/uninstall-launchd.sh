#!/usr/bin/env bash
#
# Remove the cogni runner-host LaunchAgent. macOS only.
#
# Usage:
#   pnpm --filter @cogni/runner-host uninstall:launchd
set -euo pipefail

LABEL="com.cogni.runner-host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "✓ booted out $LABEL" || echo "· $LABEL was not loaded"
if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "✓ removed $PLIST"
else
  echo "· $PLIST not present"
fi
