#!/bin/bash
# {{AGENT_NAME}} cron wrapper
# Install: crontab -e → add:
#   {{CRON_EXPRESSION}} /path/to/ginnie-agents/agents/{{AGENT_NAME_LOWER}}/cron.sh

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$AGENT_DIR/logs"
mkdir -p "$LOG_DIR"

# Lock file to prevent overlapping runs
LOCKFILE="$AGENT_DIR/.{{AGENT_NAME_LOWER}}.lock"
if [ -f "$LOCKFILE" ]; then
    PID=$(cat "$LOCKFILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "[$(date)] {{AGENT_NAME}} is already running (PID $PID), skipping." >> "$LOG_DIR/cron.log"
        exit 0
    fi
fi
echo $$ > "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT

echo "[$(date)] Cron trigger — starting daily run" >> "$LOG_DIR/cron.log"
"$AGENT_DIR/run.sh" "{{DEFAULT_DAILY_MESSAGE}}" >> "$LOG_DIR/cron.log" 2>&1
echo "[$(date)] Cron run complete" >> "$LOG_DIR/cron.log"
