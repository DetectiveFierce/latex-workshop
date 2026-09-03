#!/bin/sh
set -eu

deploy_root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
compose_file=$deploy_root/current/infra/compose/self-hosted.yml
env_file=$deploy_root/.env
stage_dir=$deploy_root/runtime/backup-stage
backup_root=${LATEX_WORKSHOP_BACKUP_ROOT:-/home/mind-palace/docker/syncthing/data/landing_zone/Backups/latex-workshop}
lock_file=$deploy_root/runtime/backup.lock
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
partial=$backup_root/.latex-workshop-$timestamp.tar.gz.partial
archive=$backup_root/latex-workshop-$timestamp.tar.gz
stopped=false

mkdir -p "$stage_dir" "$backup_root" "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -n 9 || {
  echo 'A LaTeX Workshop backup is already running.' >&2
  exit 1
}

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

cleanup() {
  if [ "$stopped" = true ]; then
    compose up -d api language-service compile-worker >/dev/null 2>&1 || true
    compose restart web >/dev/null 2>&1 || true
  fi
  rm -rf "$stage_dir"/*
  rm -f "$partial"
}
trap cleanup EXIT HUP INT TERM

rm -rf "$stage_dir"/*
compose stop api language-service compile-worker
stopped=true

compose exec -T postgres pg_dump \
  --username "$(sed -n 's/^POSTGRES_USER=//p' "$env_file")" \
  --dbname "$(sed -n 's/^POSTGRES_DB=//p' "$env_file")" \
  --format custom >"$stage_dir/postgres.dump"
compose run --rm -T --no-deps minio-backup </dev/null

compose up -d api language-service compile-worker
compose restart web
stopped=false

compose images --format json >"$stage_dir/images.json"
printf 'created_utc=%s\nrelease_dir=%s\ncompose_file=%s\n' \
  "$timestamp" "$(readlink -f "$deploy_root/current")" "$compose_file" >"$stage_dir/manifest.txt"
(
  cd "$stage_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
)
tar -C "$stage_dir" -czf "$partial" .
mv "$partial" "$archive"
find "$backup_root" -maxdepth 1 -type f -name 'latex-workshop-*.tar.gz' -mtime +14 -delete
printf 'Backup completed: %s\n' "$archive"
