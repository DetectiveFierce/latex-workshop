#!/usr/bin/env bash
# Sourced by deployment and rollback while holding runtime/deploy.lock.
# The optional hosted tunnel is a separate Compose project with mutable files.
# Keep its credentials only in the private runtime snapshot, never in a release.
release_tunnel_capture() {
  local root=$1 state=$2 tunnel_root container image file
  tunnel_root=${LATEX_WORKSHOP_TUNNEL_ROOT:-/home/mind-palace/services/openai-mcp-tunnel}
  grep -qx 'PUBLIC_MCP_GATEWAY_ENABLED=true' "$root/.env" && return 0
  grep -Eq '^AGENT_MCP_TUNNEL_KEY=[a-f0-9]{64}$' "$root/.env" || return 0
  [[ -f $tunnel_root/.env && -f $tunnel_root/compose.yml && -f $tunnel_root/compose.private.yml ]] || {
    echo 'Legacy tunnel configuration is missing; cannot capture rollback state.' >&2
    return 1
  }
  container=$(docker compose --env-file "$tunnel_root/.env" -f "$tunnel_root/compose.yml" -f "$tunnel_root/compose.private.yml" ps -q tunnel-client) || return 1
  [[ -n $container ]] || { echo 'Legacy tunnel is not running; cannot capture rollback state.' >&2; return 1; }
  image=$(docker inspect --format '{{.Image}}' "$container") || return 1
  [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  install -d -m 700 "$state/tunnel"
  for file in .env compose.yml compose.private.yml Dockerfile health.sh; do
    [[ -f $tunnel_root/$file ]] || { echo "Legacy tunnel file is missing: $file" >&2; return 1; }
    install -m 600 "$tunnel_root/$file" "$state/tunnel/$file" || return 1
  done
  printf 'services:\n  tunnel-client:\n    image: "%s"\n' "$image" >"$state/tunnel/images.yml"
  chmod 600 "$state/tunnel/images.yml"
}

release_tunnel_validate() {
  local state=$1 tunnel_root file image
  [[ -d $state/tunnel ]] || return 0
  tunnel_root=${LATEX_WORKSHOP_TUNNEL_ROOT:-/home/mind-palace/services/openai-mcp-tunnel}
  image=$(sed -n 's/.*image: "\(sha256:[a-f0-9]*\)"/\1/p' "$state/tunnel/images.yml")
  [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] && docker image inspect "$image" >/dev/null || return 1
  docker compose --project-directory "$tunnel_root" --env-file "$state/tunnel/.env" -f "$state/tunnel/compose.yml" -f "$state/tunnel/compose.private.yml" -f "$state/tunnel/images.yml" config --quiet || return 1
  for file in .env compose.yml compose.private.yml Dockerfile health.sh; do
    [[ -f $state/tunnel/$file ]] || return 1
  done
}

release_tunnel_activate() {
  local state=$1 tunnel_root file mode
  [[ -d $state/tunnel ]] || return 0
  release_tunnel_validate "$state" || return 1
  tunnel_root=${LATEX_WORKSHOP_TUNNEL_ROOT:-/home/mind-palace/services/openai-mcp-tunnel}
  for file in compose.yml compose.private.yml Dockerfile health.sh .env; do
    mode=644
    [[ $file != .env ]] || mode=600
    install -m "$mode" "$state/tunnel/$file" "$tunnel_root/$file" || return 1
  done
  docker compose --env-file "$tunnel_root/.env" -f "$tunnel_root/compose.yml" -f "$tunnel_root/compose.private.yml" -f "$state/tunnel/images.yml" \
    up -d --no-build --pull never --wait --wait-timeout 120 || return 1
  docker compose --env-file "$tunnel_root/.env" -f "$tunnel_root/compose.yml" -f "$tunnel_root/compose.private.yml" -f "$state/tunnel/images.yml" \
    exec -T tunnel-client workshop-tunnel-health
}

release_state_capture() {
  local root=$1 release=$2 state tmp service container image
  state="$root/runtime/release-state/${release##*/}"
  install -d -m 700 "$state"
  tmp=$(mktemp -d "$state/.capture.XXXXXX")
  sed -n '/^SERVICE_IMAGE=/p; /^WEB_IMAGE=/p; /^TEXLIVE_IMAGE=/p' "$root/.env" >"$tmp/images.env"
  printf 'services:\n' >"$tmp/services.yml"
  : >"$tmp/services.txt"
  for service in api language-service compile-worker web tailnet-mcp public-mcp public-mcp-tailscale; do
    container=$(docker compose --env-file "$root/.env" -f "$release/infra/compose/self-hosted.yml" ps -q "$service")
    [[ -n $container ]] || continue
    image=$(docker inspect --format '{{.Image}}' "$container")
    [[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid image ID for $service" >&2; return 1; }
    printf '  %s:\n    image: "%s"\n' "$service" "$image" >>"$tmp/services.yml"
    printf '%s\n' "$service" >>"$tmp/services.txt"
  done
  [[ -s $tmp/services.txt ]] || { echo 'No active application services to snapshot.' >&2; return 1; }
  chmod 600 "$tmp/"*
  mv "$tmp/images.env" "$tmp/services.yml" "$tmp/services.txt" "$state/"
  rmdir "$tmp"
  rm -rf -- "$state/tunnel"
  release_tunnel_capture "$root" "$state"
}

release_state_activate() {
  local root=$1 release=$2 state tmp image service
  state="$root/runtime/release-state/${release##*/}"
  [[ -f $state/images.env && -s $state/services.txt && -f $state/services.yml ]] || {
    echo "No saved runtime image state for ${release##*/}; rollback requires a captured release." >&2
    return 1
  }
  while IFS= read -r image; do
    docker image inspect "$image" >/dev/null || return 1
  done < <(sed -n 's/.*image: "\(sha256:[a-f0-9]*\)"/\1/p' "$state/services.yml")
  while IFS= read -r image; do
    docker image inspect "${image#*=}" >/dev/null || return 1
  done <"$state/images.env"
  [[ $(wc -l <"$state/images.env") -eq 3 ]] &&
    grep -Eq '^SERVICE_IMAGE=.+$' "$state/images.env" &&
    grep -Eq '^WEB_IMAGE=.+$' "$state/images.env" &&
    grep -Eq '^TEXLIVE_IMAGE=.+$' "$state/images.env" || {
      echo 'Saved image environment is incomplete.' >&2
      return 1
    }
  release_tunnel_validate "$state" || return 1
  tmp=$(mktemp "$root/.env.rollback.XXXXXX") || return 1
  sed '/^SERVICE_IMAGE=/d; /^WEB_IMAGE=/d; /^TEXLIVE_IMAGE=/d' "$root/.env" >"$tmp"
  cat "$state/images.env" >>"$tmp"
  chmod 600 "$tmp"
  if ! docker compose --env-file "$tmp" -f "$release/infra/compose/self-hosted.yml" -f "$state/services.yml" config --quiet; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$root/.env" || return 1
  ln -s "$release" "$root/.current-rollback-$$" || return 1
  mv -Tf "$root/.current-rollback-$$" "$root/current" || return 1
  local services=()
  while IFS= read -r service; do services+=("$service"); done <"$state/services.txt"
  docker compose --env-file "$root/.env" -f "$release/infra/compose/self-hosted.yml" -f "$state/services.yml" \
    up -d --no-build --pull never --wait --wait-timeout 180 "${services[@]}" || return 1
  release_tunnel_activate "$state"
}

release_schema_digest() {
  (
    cd "$1"
    find packages/db/drizzle -type f \( -name '*.sql' -o -name '_journal.json' \) -print0 |
      LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
  )
}
