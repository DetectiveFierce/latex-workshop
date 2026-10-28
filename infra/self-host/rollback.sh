#!/usr/bin/env bash
set -Eeuo pipefail
host=${LATEX_DEPLOY_HOST:-mind-palace}
root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
release=''
dry_run=false
while (($#)); do
  case $1 in
    --host) host=${2:?}; shift 2 ;;
    --deploy-root) root=${2:?}; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) echo 'Usage: rollback.sh RELEASE_ID [--host HOST] [--deploy-root PATH] [--dry-run]'; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) [[ -z $release ]] || { echo 'Specify one release ID.' >&2; exit 2; }; release=$1; shift ;;
  esac
done
# SSH reconstructs remote command arguments through a shell. Restrict destination
# values before using them in SSH commands or rsync's remote-path syntax.
[[ $host =~ ^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$ ]] || { echo 'Unsupported SSH host.' >&2; exit 2; }
[[ $root =~ ^/[A-Za-z0-9_./-]+$ && $root != / && $root != */../* && $root != */.. && $root != */./* && $root != */. ]] || {
  echo 'Deployment root must be an absolute path without spaces, shell characters, or traversal.' >&2
  exit 2
}

[[ $release =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && $release != . && $release != .. ]] || { echo 'A valid release ID is required.' >&2; exit 2; }
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
{
  cat "$script_dir/release-state.sh"
  cat <<'REMOTE'
set -Eeuo pipefail
root=$1
id=$2
dry_run=$3
[[ $root == /* && $root != / && -f $root/.env && -d $root/runtime ]] || { echo 'Invalid deployment root.' >&2; exit 1; }
exec 9>"$root/runtime/deploy.lock"
flock -n 9 || { echo 'Another deployment or rollback is running.' >&2; exit 1; }
current=$(readlink -f "$root/current")
target="$root/releases/$id"
[[ -f $target/infra/compose/self-hosted.yml ]] || { echo 'Target release is missing.' >&2; exit 1; }
[[ $(release_schema_digest "$current") == "$(release_schema_digest "$target")" ]] || {
  echo 'Rollback refused: database migration histories differ. Use a forward fix or a separately verified data restoration.' >&2
  exit 1
}
state="$root/runtime/release-state/$id"
[[ -f $state/images.env && -f $state/services.yml && -s $state/services.txt ]] || { echo 'Target has no saved runtime image state.' >&2; exit 1; }
while IFS= read -r image; do docker image inspect "$image" >/dev/null; done < <(sed -n 's/.*image: "\(sha256:[a-f0-9]*\)"/\1/p' "$state/services.yml")
while IFS= read -r image; do docker image inspect "${image#*=}" >/dev/null; done <"$state/images.env"
release_tunnel_validate "$state"
if [[ $dry_run == true ]]; then
  echo "Rollback target $id has matching migration history and all saved images are present."
  exit 0
fi
release_state_capture "$root" "$current"
rollback_failed() {
  status=$?
  trap - EXIT
  if [[ $status != 0 ]]; then
    echo 'Rollback failed; restoring the previous runtime images.' >&2
    release_state_activate "$root" "$current" || echo 'Restoration failed; inspect container health.' >&2
  fi
  exit "$status"
}
trap rollback_failed EXIT
release_state_activate "$root" "$target"
ca=/home/mind-palace/services/mind-palace-platform/trust/mind-palace-root.crt
curl --fail --silent --show-error --retry 6 --retry-delay 2 --cacert "$ca" \
  --resolve mind-palace:8443:127.0.0.1 https://mind-palace:8443/latex-workshop/health/live >/dev/null
trap - EXIT
echo "Rolled back to $id; database and object storage were retained."
REMOTE
} | ssh -o BatchMode=yes "$host" bash -s -- "$root" "$release" "$dry_run"
