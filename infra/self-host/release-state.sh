#!/usr/bin/env bash
# Sourced by deployment and rollback while holding runtime/deploy.lock.
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
    up -d --no-build --pull never --wait --wait-timeout 180 "${services[@]}"
}

release_schema_digest() {
  (
    cd "$1"
    find packages/db/drizzle -type f \( -name '*.sql' -o -name '_journal.json' \) -print0 |
      LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
  )
}
