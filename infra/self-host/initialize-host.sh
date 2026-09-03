#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <release-id> [texlive-image]" >&2
  exit 2
fi

release_id=$1
texlive_image=${2:-latex-workshop-texlive:$release_id}
deploy_root=${LATEX_WORKSHOP_ROOT:-/home/mind-palace/services/latex-workshop}
release_dir=$deploy_root/releases/$release_id
env_file=$deploy_root/.env
compile_dir=$deploy_root/runtime/compile-tmp
backup_stage=$deploy_root/runtime/backup-stage

if [ ! -f "$release_dir/infra/compose/self-hosted.yml" ]; then
  echo "Release is missing self-hosted.yml: $release_dir" >&2
  exit 1
fi

mkdir -p "$compile_dir" "$backup_stage"
if [ "$(stat -c '%u:%g' "$compile_dir")" != '10001:10001' ]; then
  docker run --rm -v "$compile_dir:/work" busybox:latest chown 10001:10001 /work
fi

if [ ! -f "$env_file" ]; then
  umask 077
  postgres_password=$(openssl rand -hex 32)
  minio_root_password=$(openssl rand -hex 32)
  s3_access_key=latex-$(openssl rand -hex 8)
  s3_secret_key=$(openssl rand -hex 32)
  auth_secret=$(openssl rand -hex 32)
  docker_gid=$(stat -c %g /var/run/docker.sock)

  {
    printf '%s\n' \
      'WEB_ORIGIN=https://mind-palace.tail7e24aa.ts.net' \
      'API_ORIGIN=https://mind-palace.tail7e24aa.ts.net' \
      'S3_PUBLIC_ENDPOINT=https://mind-palace.tail7e24aa.ts.net:8443' \
      'SMTP_FROM=LaTeX Workshop <noreply@latex-workshop.local>' \
      'POSTGRES_USER=latex' \
      "POSTGRES_PASSWORD=$postgres_password" \
      'POSTGRES_DB=latex_workshop' \
      'MINIO_ROOT_USER=minio-root' \
      "MINIO_ROOT_PASSWORD=$minio_root_password" \
      "S3_ACCESS_KEY=$s3_access_key" \
      "S3_SECRET_KEY=$s3_secret_key" \
      "AUTH_SECRET=$auth_secret" \
      "DOCKER_GID=$docker_gid" \
      "BACKUP_UID=$(id -u)" \
      "BACKUP_GID=$(id -g)" \
      "COMPILE_WORK_DIR=$compile_dir" \
      "BACKUP_STAGE_DIR=$backup_stage"
  } >"$env_file"
  chmod 600 "$env_file"
fi

grep -q '^BACKUP_UID=' "$env_file" || printf 'BACKUP_UID=%s\n' "$(id -u)" >>"$env_file"
grep -q '^BACKUP_GID=' "$env_file" || printf 'BACKUP_GID=%s\n' "$(id -g)" >>"$env_file"

tmp_env=$deploy_root/.env.next
sed \
  -e '/^SERVICE_IMAGE=/d' \
  -e '/^WEB_IMAGE=/d' \
  -e '/^TEXLIVE_IMAGE=/d' \
  "$env_file" >"$tmp_env"
printf '%s\n' \
  "SERVICE_IMAGE=latex-workshop-services:$release_id" \
  "WEB_IMAGE=latex-workshop-web:$release_id" \
  "TEXLIVE_IMAGE=$texlive_image" >>"$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" "$env_file"

ln -sfn "$release_dir" "$deploy_root/current"
docker compose \
  --env-file "$env_file" \
  -f "$deploy_root/current/infra/compose/self-hosted.yml" \
  config --quiet

printf 'Activated release %s\n' "$release_id"
