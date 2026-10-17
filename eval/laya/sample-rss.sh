#!/bin/sh
# Usage: eval/laya/sample-rss.sh <pid> > eval/laya/runs/rss-<label>.txt
while kill -0 "$1" 2>/dev/null; do
	printf '%s %s\n' "$(date +%s)" "$(ps -o rss= -p "$1" | tr -d ' ')"
	sleep 1
done
