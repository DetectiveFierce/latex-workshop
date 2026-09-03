#!/bin/sh
set -eu

personal_drive=/home/mind-palace/personal-drive/docker-compose.yml
dockhand=/home/mind-palace/dockhand/docker-compose.yml

if grep -q 'TS_AUTHKEY=' "$personal_drive"; then
  sed -i '/^[[:space:]]*- TS_AUTHKEY=/d' "$personal_drive"
fi

if grep -q -- '- "3000:3000"' "$dockhand"; then
  sed -i 's/- "3000:3000"/- "127.0.0.1:3000:3000"/' "$dockhand"
fi

docker compose -f "$personal_drive" config --quiet
docker compose -f "$dockhand" config --quiet

docker compose -f "$personal_drive" up -d --force-recreate tailscale filebrowser
docker compose -f "$dockhand" up -d --force-recreate dockhand

printf '%s\n' \
  'Removed the persisted auth key from personal-drive Compose.' \
  'Rebound Dockhand to host loopback and recreated both stacks.' \
  'Revoke the old key in the Tailscale admin console if it is still active.'
