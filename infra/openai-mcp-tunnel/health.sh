#!/bin/sh
set -eu

base_url=${1:-http://127.0.0.1:18080}
curl --fail --silent --show-error --noproxy '*' --max-time 2 "$base_url/readyz" >/dev/null || exit 1
metrics=$(curl --fail --silent --show-error --noproxy '*' --max-time 2 \
  --max-filesize 1048576 "$base_url/metrics") || exit 1

# Local readiness is independent of OpenAI connectivity. A historical success
# must also expire when the control plane stops responding after startup.
printf '%s\n' "$metrics" | awk -v now="$(date +%s)" '
  /^commands_poll_last_successful_timestamp_seconds(\{[^}]*\})?[[:space:]]/ {
    if (NF == 2 && $2 ~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/) {
      age = now - $2
      if ($2 > 0 && age >= -5 && age <= 90) connected = 1
    }
  }
  END { exit connected ? 0 : 1 }
'
