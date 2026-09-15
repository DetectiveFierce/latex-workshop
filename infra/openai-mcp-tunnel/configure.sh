#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

tunnel_id=${1:-}
if [[ ! $tunnel_id =~ ^tunnel_[A-Za-z0-9_-]{16,}$ ]]; then
  echo 'Usage: ./configure.sh tunnel_YOUR_TUNNEL_ID' >&2
  exit 2
fi

if [[ ! -t 0 ]]; then
  echo 'Run this command from an interactive terminal so the runtime key is never passed as an argument.' >&2
  exit 2
fi

read -r -s -p 'OpenAI project API key for the tunnel client: ' runtime_key
printf '\n'
if ((${#runtime_key} < 20)); then
  echo 'The runtime API key is unexpectedly short.' >&2
  exit 2
fi

caddy_root=/home/mind-palace/data/caddy/caddy/pki/authorities/local/root.crt
private_mcp_url=https://mind-palace.tail7e24aa.ts.net/latex-workshop/api/mcp
if [[ ! -r $caddy_root ]]; then
  echo "Caddy root certificate is not readable: $caddy_root" >&2
  exit 1
fi

umask 077
mkdir -p secrets
key_tmp=$(mktemp ./secrets/.control-plane-api-key.XXXXXX)
env_tmp=$(mktemp ./.env.XXXXXX)
cleanup() {
  rm -f -- "$key_tmp" "$env_tmp"
}
trap cleanup EXIT

printf '%s' "$runtime_key" >"$key_tmp"
unset runtime_key
printf '%s\n' \
  "OPENAI_TUNNEL_ID=$tunnel_id" \
  "PRIVATE_MCP_URL=$private_mcp_url" \
  "CADDY_ROOT_CA_PATH=$caddy_root" \
  "TUNNEL_RUNTIME_UID=$(id -u)" \
  "TUNNEL_RUNTIME_GID=$(id -g)" >"$env_tmp"

mv -f -- "$key_tmp" ./secrets/control-plane-api-key
mv -f -- "$env_tmp" ./.env
trap - EXIT

docker compose config --quiet
docker compose build --pull
docker compose up --detach

container_id=$(docker compose ps --quiet tunnel-client)
if [[ -z $container_id ]]; then
  echo 'Tunnel container was not created.' >&2
  exit 1
fi

for _ in $(seq 1 30); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
  case $health in
    healthy)
      docker compose ps
      echo 'LaTeX Workshop Secure MCP Tunnel is healthy.'
      echo "Set AGENT_MCP_RESOURCE_URL in the LaTeX Workshop deployment to:"
      echo "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/$tunnel_id"
      exit 0
      ;;
    unhealthy)
      break
      ;;
  esac
  sleep 2
done

docker compose ps
docker compose logs --tail=100 tunnel-client >&2
echo 'Tunnel did not become healthy. Verify the tunnel ID, runtime-key permissions, and workspace association.' >&2
exit 1
