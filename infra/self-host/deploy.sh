#!/usr/bin/env bash
set -Eeuo pipefail

target_host=${LATEX_DEPLOY_HOST:-mind-palace}
deploy_root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
release_id=''
deployment_mode=production
with_e2e=true
dry_run=false

usage() {
  cat <<'EOF'
Usage: infra/self-host/deploy.sh (--fast | --production) [options]

Build, transfer, activate, migrate, and verify a versioned LaTeX Workshop release.

Options:
  --fast               Skip local checks and the backup; reuse the active TeX image
  --production         Run all local checks and back up live data before activation (default)
  --host HOST          SSH host (default: mind-palace)
  --deploy-root PATH   Remote deployment root
  --release-id ID      Use an explicit release identifier
  --with-e2e           Run Playwright in production mode (default)
  --skip-e2e           Skip Playwright in production mode
  --dry-run            Validate and show the rsync transfer without changing the host
  -h, --help           Show this help

Environment overrides:
  LATEX_DEPLOY_HOST, LATEX_WORKSHOP_ROOT
EOF
}

while (($#)); do
  case $1 in
    --)
      shift
      ;;
    --host)
      target_host=${2:?--host requires a value}
      shift 2
      ;;
    --deploy-root)
      deploy_root=${2:?--deploy-root requires a value}
      shift 2
      ;;
    --release-id)
      release_id=${2:?--release-id requires a value}
      shift 2
      ;;
    --fast)
      deployment_mode=fast
      shift
      ;;
    --production)
      deployment_mode=production
      shift
      ;;
    --with-e2e)
      with_e2e=true
      shift
      ;;
    --skip-e2e)
      with_e2e=false
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in ssh rsync sha256sum pnpm; do
  command -v "$command_name" >/dev/null || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

if [[ -n $release_id && ! $release_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "Release ID contains unsupported characters: $release_id" >&2
  exit 2
fi

write_source_manifest() {
  local destination=$1
  find . -type f \
    ! -path './.git' \
    ! -path './.git/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/.turbo/*' \
    ! -path '*/dist/*' \
    ! -path './test-results/*' \
    ! -path './playwright-report/*' \
    ! -path './coverage/*' \
    ! -path './data/*' \
    ! -path './tmp/*' \
    ! -name '.env' \
    ! -name '*.tsbuildinfo' \
    ! -name 'SHA256SUMS' \
    -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum >"$destination"
}

task_pids=()
task_names=()
start_local_task() {
  local name=$1
  shift
  echo "Starting $name..."
  "$@" &
  task_pids+=("$!")
  task_names+=("$name")
}

wait_for_local_tasks() {
  local failed=false
  local index
  for index in "${!task_pids[@]}"; do
    if wait "${task_pids[$index]}"; then
      echo "Completed ${task_names[$index]}"
    else
      echo "Failed ${task_names[$index]}" >&2
      failed=true
    fi
  done
  task_pids=()
  task_names=()
  [[ $failed == false ]]
}

echo "Target:  $target_host:$deploy_root"
echo "Mode:    $deployment_mode"

ssh -o BatchMode=yes "$target_host" bash -s -- "$deploy_root" <<'REMOTE_PREFLIGHT' &
set -Eeuo pipefail
deploy_root=$1
for command_name in docker curl flock sha256sum; do
  command -v "$command_name" >/dev/null || {
    echo "Required remote command is missing: $command_name" >&2
    exit 1
  }
done
docker compose version >/dev/null
test -d "$deploy_root/releases"
test -f "$deploy_root/.env"
REMOTE_PREFLIGHT
task_pids+=("$!")
task_names+=('remote preflight')

if [[ $deployment_mode == production ]]; then
  echo 'Running independent local release checks in parallel...'
  start_local_task 'dependency audit' pnpm security:audit
  start_local_task 'release gate' pnpm check
  if [[ $with_e2e == true ]]; then
    start_local_task 'browser end-to-end tests' pnpm test:e2e
  fi
fi
wait_for_local_tasks

manifest_dir=$(mktemp -d)
source_manifest=$manifest_dir/SHA256SUMS
incoming_created=false
incoming_dir=''
cleanup_local() {
  rm -rf -- "$manifest_dir"
  if [[ $incoming_created == true ]]; then
    ssh "$target_host" rm -rf -- "$incoming_dir" >/dev/null 2>&1 || true
  fi
}
trap cleanup_local EXIT

write_source_manifest "$source_manifest"
source_digest=$(sha256sum "$source_manifest" | cut -c1-12)
if [[ -z $release_id ]]; then
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$source_digest"
fi
if [[ ! $release_id =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "Release ID contains unsupported characters: $release_id" >&2
  exit 2
fi
echo "Release: $release_id (source $source_digest)"

incoming_dir="$deploy_root/releases/.incoming-$release_id"
release_dir="$deploy_root/releases/$release_id"
rsync_options=(
  --archive
  --delete
  --exclude .git
  --exclude node_modules
  --exclude dist
  --exclude .turbo
  --exclude test-results
  --exclude playwright-report
  --exclude coverage
  --exclude .env
  --exclude '*.tsbuildinfo'
  --exclude SHA256SUMS
  --exclude data
  --exclude tmp
)

if [[ $dry_run == true ]]; then
  echo 'Dry run: files that would be transferred:'
  rsync "${rsync_options[@]}" --dry-run --itemize-changes ./ "$target_host:$incoming_dir/"
  echo 'A generated SHA256SUMS manifest would be transferred and verified.'
  exit 0
fi

ssh "$target_host" install -d -m 755 "$incoming_dir"
incoming_created=true
rsync "${rsync_options[@]}" ./ "$target_host:$incoming_dir/"
rsync --archive "$source_manifest" "$target_host:$incoming_dir/SHA256SUMS"

ssh "$target_host" bash -s -- "$incoming_dir" <<'REMOTE_DIGEST'
set -Eeuo pipefail
cd "$1"
sha256sum --check --strict SHA256SUMS >/dev/null
REMOTE_DIGEST

ssh "$target_host" bash -s -- \
  "$deploy_root" "$incoming_dir" "$release_dir" "$release_id" "$deployment_mode" <<'REMOTE_DEPLOY'
set -Eeuo pipefail
deploy_root=$1
incoming_dir=$2
release_dir=$3
release_id=$4
deployment_mode=$5
env_file=$deploy_root/.env
lock_file=$deploy_root/runtime/deploy.lock

mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -n 9 || {
  echo 'Another LaTeX Workshop deployment is already running.' >&2
  exit 1
}

if [[ -e $release_dir ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 1
fi
mv "$incoming_dir" "$release_dir"

if [[ $deployment_mode == production ]]; then
  texlive_image="latex-workshop-texlive:$release_id"
else
  texlive_image=$(sed -n 's/^TEXLIVE_IMAGE=//p' "$env_file" | tail -1)
  if [[ -z $texlive_image ]] || ! docker image inspect "$texlive_image" >/dev/null 2>&1; then
    echo 'Fast deployment needs an existing TeX image; run pnpm deploy:production first.' >&2
    exit 1
  fi
  echo "Reusing TeX image $texlive_image"
fi

build_log_dir=$deploy_root/runtime/build-logs/$release_id
build_pids=()
build_names=()
mkdir -p "$build_log_dir"

start_image_build() {
  local name=$1
  shift
  echo "Starting $name image build..."
  "$@" >"$build_log_dir/$name.log" 2>&1 &
  build_pids+=("$!")
  build_names+=("$name")
}

cleanup_image_builds() {
  local pid
  for pid in "${build_pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  rm -rf -- "$build_log_dir"
}
trap cleanup_image_builds EXIT

start_image_build services docker build --file "$release_dir/Dockerfile.services" \
  --target runtime --tag "latex-workshop-services:$release_id" "$release_dir"
start_image_build web docker build --file "$release_dir/apps/web/Dockerfile" \
  --tag "latex-workshop-web:$release_id" "$release_dir"
if [[ $deployment_mode == production ]]; then
  start_image_build texlive docker build --file "$release_dir/infra/texlive/Dockerfile" \
    --tag "$texlive_image" "$release_dir"
fi
if grep -Eq '^AGENT_MCP_TUNNEL_KEY=[a-f0-9]{64}$' "$env_file" &&
  ! grep -qx 'PUBLIC_MCP_GATEWAY_ENABLED=true' "$env_file"; then
  start_image_build openai-tunnel env TUNNEL_IMAGE_TAG="$release_id" docker compose \
    --env-file /home/mind-palace/services/openai-mcp-tunnel/.env \
    -f "$release_dir/infra/openai-mcp-tunnel/compose.yml" build tunnel-client
fi

build_failed=false
for index in "${!build_pids[@]}"; do
  if wait "${build_pids[$index]}"; then
    echo "Completed ${build_names[$index]} image build"
  else
    echo "Failed ${build_names[$index]} image build:" >&2
    cat "$build_log_dir/${build_names[$index]}.log" >&2
    build_failed=true
  fi
done
build_pids=()
[[ $build_failed == false ]]
rm -rf -- "$build_log_dir"
trap - EXIT

if [[ $deployment_mode == production ]]; then
  current_release=$(readlink -f "$deploy_root/current" 2>/dev/null || true)
  if [[ -n $current_release ]]; then
    echo 'Backing up the live database and object storage before migration...'
    LATEX_WORKSHOP_ROOT="$deploy_root" "$current_release/infra/self-host/backup.sh" </dev/null
  else
    echo 'No active release exists yet; skipping the pre-deployment backup.'
  fi
fi

previous_release=$(readlink -f "$deploy_root/current" 2>/dev/null || true)
previous_texlive_image=$(sed -n 's/^TEXLIVE_IMAGE=//p' "$env_file" | tail -1)
activated=false
migration_started=false

rollback_before_migration() {
  if [[ $activated == true && $migration_started == false && -n $previous_release ]]; then
    previous_id=${previous_release##*/}
    echo "Deployment failed before migration; restoring release $previous_id" >&2
    "$previous_release/infra/self-host/initialize-host.sh" \
      "$previous_id" "$previous_texlive_image"
  fi
}
trap rollback_before_migration ERR

"$release_dir/infra/self-host/initialize-host.sh" "$release_id" "$texlive_image"
activated=true
compose=(docker compose --env-file "$env_file" -f "$deploy_root/current/infra/compose/self-hosted.yml")
"${compose[@]}" config --quiet </dev/null
"${compose[@]}" up -d postgres redis minio mailpit minio-init </dev/null
migration_started=true
"${compose[@]}" run --rm -T --interactive=false migrate </dev/null
application_services=(api language-service compile-worker web)
if grep -Eq '^AGENT_MCP_TAILNET_KEY=[a-f0-9]{64}$' "$env_file"; then
  application_services+=(tailnet-mcp)
fi
if grep -qx 'PUBLIC_MCP_GATEWAY_ENABLED=true' "$env_file"; then
  application_services+=(public-mcp)
fi
"${compose[@]}" up -d --wait --wait-timeout 180 "${application_services[@]}" </dev/null

for service in "${application_services[@]}"; do
  container_id=$("${compose[@]}" ps -q "$service" </dev/null)
  image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
  if [[ $service == web || $service == tailnet-mcp || $service == public-mcp ]]; then
    expected_image="latex-workshop-web:$release_id"
  else
    expected_image="latex-workshop-services:$release_id"
  fi
  if [[ $image != "$expected_image" ]]; then
    echo "Service $service is running $image instead of $expected_image" >&2
    exit 1
  fi
done

ca=/home/mind-palace/services/mind-palace-platform/trust/mind-palace-root.crt
curl --fail --silent --show-error --retry 6 --retry-delay 2 --cacert "$ca" \
  --resolve mind-palace:8443:127.0.0.1 \
  https://mind-palace:8443/latex-workshop/health/live >/dev/null

if [[ " ${application_services[*]} " == *' tailnet-mcp '* ]]; then
  # Add a dedicated identity-aware listener; never reset the existing Serve routes.
  curl --fail --silent --show-error http://127.0.0.1:8089/health/live >/dev/null
  tailscale serve --https=9443 --bg http://127.0.0.1:8089 </dev/null
  tailnet_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  curl --fail --silent --show-error --retry 3 "https://$tailnet_name:9443/health/live" >/dev/null
fi
if grep -qx 'PUBLIC_MCP_GATEWAY_ENABLED=true' "$env_file"; then
  curl --fail --silent --show-error http://127.0.0.1:8090/health/live >/dev/null
  tailscale funnel --https=10000 --bg http://127.0.0.1:8090 </dev/null
  public_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
  curl --fail --silent --show-error --retry 3 "https://$public_name:10000/health/live" >/dev/null
  # Keep the old transport recoverable while the new connection is verified in ChatGPT.
elif grep -Eq '^AGENT_MCP_TUNNEL_KEY=[a-f0-9]{64}$' "$env_file"; then
  tunnel_root=/home/mind-palace/services/openai-mcp-tunnel
  test -s "$deploy_root/runtime/tunnel-mcp-key"
  install -m 644 "$release_dir/infra/openai-mcp-tunnel/Dockerfile" "$tunnel_root/Dockerfile"
  install -m 644 "$release_dir/infra/openai-mcp-tunnel/health.sh" "$tunnel_root/health.sh"
  install -m 644 "$release_dir/infra/openai-mcp-tunnel/compose.yml" "$tunnel_root/compose.yml"
  install -m 644 "$release_dir/infra/openai-mcp-tunnel/compose.private.yml" "$tunnel_root/compose.private.yml"
  tunnel_env_next=$(mktemp "$tunnel_root/.env.XXXXXX")
  sed '/^TUNNEL_IMAGE_TAG=/d' "$tunnel_root/.env" >"$tunnel_env_next"
  printf 'TUNNEL_IMAGE_TAG=%s\n' "$release_id" >>"$tunnel_env_next"
  chmod 600 "$tunnel_env_next"
  mv "$tunnel_env_next" "$tunnel_root/.env"
  docker compose -f "$tunnel_root/compose.yml" -f "$tunnel_root/compose.private.yml" \
    --env-file "$tunnel_root/.env" up -d --wait --wait-timeout 120 </dev/null
  # Some Compose versions return from --wait before this standalone service is
  # healthy. Verify actual connectivity before release cleanup or success.
  if ! docker compose -f "$tunnel_root/compose.yml" -f "$tunnel_root/compose.private.yml" \
    --env-file "$tunnel_root/.env" exec -T tunnel-client workshop-tunnel-health; then
    echo 'Workshop is active, but hosted MCP connectivity failed verification; previous releases are retained.' >&2
    exit 1
  fi
fi

trap - ERR
"${compose[@]}" rm -f minio-init texlive-image </dev/null

current_release=$(readlink -f "$deploy_root/current")
active_texlive_image=$(sed -n 's/^TEXLIVE_IMAGE=//p' "$env_file" | tail -1)
previous_release=$(find "$deploy_root/releases" -mindepth 1 -maxdepth 1 -type d \
  ! -name '.incoming-*' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2- | \
  grep -Fxv "$current_release" | head -1 || true)
while IFS= read -r old_release; do
  [[ $old_release == "$current_release" || $old_release == "$previous_release" ]] && continue
  old_id=${old_release##*/}
  docker image rm "latex-workshop-web:$old_id" "latex-workshop-services:$old_id" \
    "latex-workshop-openai-tunnel:$old_id" \
    2>/dev/null || true
  if [[ $active_texlive_image != "latex-workshop-texlive:$old_id" ]]; then
    docker image rm "latex-workshop-texlive:$old_id" 2>/dev/null || true
  fi
  rm -rf -- "$old_release"
done < <(find "$deploy_root/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.incoming-*' -print)

if [[ $deployment_mode == production ]]; then
  nohup docker builder prune --force --filter until=168h >/dev/null 2>&1 </dev/null &
fi
echo "Activated release $release_id"
REMOTE_DEPLOY

echo "Deployment complete: $release_id"
