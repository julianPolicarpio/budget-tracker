#!/bin/sh
# Usage: eval/laya/sample-rss.sh <pid> > eval/laya/runs/rss-<label>.txt
[ -n "$1" ] || { echo "usage: $0 <pid>" >&2; exit 1; }
while kill -0 "$1" 2>/dev/null; do
	printf '%s %s\n' "$(date +%s)" "$(ps -o rss= -p "$1" | tr -d ' ')"
	sleep 1
done
