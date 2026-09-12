#!/bin/sh
# Install (or reinstall) the launchd agent that keeps Split running.
#
#   sh launchd/install.sh          install and start
#   sh launchd/install.sh --remove stop and remove
#
# Nothing here needs sudo: a LaunchAgent is per-user, which is the right scope
# for a single-user app bound to loopback.
set -e

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.julian.split
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "$1" = "--remove" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	rm -f "$TARGET"
	echo "removed $LABEL"
	exit 0
fi

[ -f "$PROJECT/build/index.js" ] || { echo "build/ is missing — run: npm run build"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/data"
sed "s|__PROJECT__|$PROJECT|g" "$PROJECT/launchd/$LABEL.plist" > "$TARGET"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl enable "gui/$(id -u)/$LABEL"

echo "installed $LABEL → $TARGET"
echo "logs: $PROJECT/data/serve.log"
