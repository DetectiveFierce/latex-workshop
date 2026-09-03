# Self-hosting on a Tailscale node

`infra/compose/self-hosted.yml` runs the complete application on one Docker host. Only the web,
S3 upload, and Mailpit UI ports bind to host loopback. Tailscale Serve is expected to terminate
TLS and proxy those ports to the tailnet.

## Host layout

- Releases: `/home/mind-palace/services/latex-workshop/releases/<release-id>`
- Active release: `/home/mind-palace/services/latex-workshop/current`
- Secrets: `/home/mind-palace/services/latex-workshop/.env` (mode `0600`)
- Compile scratch: `/home/mind-palace/services/latex-workshop/runtime/compile-tmp`
- Backup staging: `/home/mind-palace/services/latex-workshop/runtime/backup-stage`

After transferring a release, run `infra/self-host/initialize-host.sh <release-id>` from that
release. On first deployment it generates independent secrets, creates the runtime directories,
records the host Docker socket group, activates the release, and validates Compose. On later
deployments it preserves secrets and only advances the three image tags. The compile scratch
directory is mounted at the same absolute path inside the worker and owned by UID/GID
`10001:10001`.

## Release

Use the fast path while iterating on the live development site:

```bash
pnpm deploy:fast
```

It skips the local quality suite, backup, TeX Live build, and builder-cache pruning. The application
and web images build concurrently, and the active TeX Live image is reused. It still stages a
checksummed, versioned release, runs migrations, waits for service health, verifies the deployed
image tags, and checks the Tailscale HTTPS endpoint.

Both application Dockerfiles install dependencies from workspace manifests before copying source,
so ordinary code-only releases reuse the dependency layer. The services image builds only API,
worker, language-service, and their shared-package dependency graph; the web app is built once in
its own image.

Use the guarded path for a production release:

```bash
pnpm deploy:production
```

It runs the dependency audit, release gate, Playwright suite, and remote preflight concurrently;
builds all three immutable images concurrently; and creates a consistent backup of the live
PostgreSQL database and object bucket immediately before activation and migration. The database and
object snapshots run in parallel while writers are stopped, reducing the read-only window. A single
source manifest both names the release and verifies the transfer, and Compose's health wait is the
authoritative internal health check. Old releases are retained as before, while builder-cache
pruning happens asynchronously after a successful production activation.

`pnpm deploy:mind-palace` remains an alias for this production path. Add `-- --dry-run` to either
command to preview the transfer. If the local E2E stack is intentionally unavailable,
`-- --skip-e2e` bypasses Playwright. The SSH host and remote root can be overridden with
`LATEX_DEPLOY_HOST` and `LATEX_WORKSHOP_ROOT`.

The pipeline automatically restores the previous release if activation fails before migrations
start. It deliberately does not roll application images backward after a migration begins because
database migrations are forward-only; a failure at that stage requires inspection and a forward
fix.

For a manual recovery or to understand the underlying operations, use the steps below.

From the active release directory:

```bash
compose='docker compose --env-file /home/mind-palace/services/latex-workshop/.env -f infra/compose/self-hosted.yml'
$compose config --quiet
$compose build migrate web texlive-image
$compose up -d postgres redis minio mailpit minio-init
$compose run --rm migrate
$compose up -d
```

Configure Tailscale without resetting unrelated Serve routes:

```bash
tailscale serve --https=443 --bg http://127.0.0.1:8088
tailscale serve --https=8443 --bg http://127.0.0.1:9000
tailscale serve --https=10000 --bg http://127.0.0.1:8025
tailscale serve status
```

Do not use Funnel. The expected origins must be full HTTPS `*.ts.net` URLs; the S3 public endpoint
uses port `8443` so browser-direct signed uploads do not create mixed-content failures.

## Backup and restore

Run `infra/self-host/backup.sh` daily. It briefly drains the three write-producing application
services, captures PostgreSQL and the current object bucket as one recovery set, resumes the app,
and atomically publishes a compressed archive to the Syncthing-managed backup directory.

For a restore drill, unpack an archive outside the live directories, validate `SHA256SUMS`, restore
`postgres.dump` into a fresh PostgreSQL volume with `pg_restore`, mirror `objects/` into a fresh
MinIO bucket, then start an isolated Compose project on different loopback ports. Do not overwrite
the live volumes during a drill.
