# Operations

## Deployment model

Build `Dockerfile.services` once and run its API, worker, and language-service commands independently. Build `apps/web/Dockerfile` for the static web tier and `infra/texlive/Dockerfile` for compilation. `infra/compose/production.yml` is an external-services deployment example; a real ingress should terminate TLS and route `/api/v1/projects/:projectId/lsp` WebSocket upgrades to the language service, other `/api` requests to the API, and application routes to the web tier. The bundled nginx image already applies this split.

Required durable dependencies are PostgreSQL, Redis, an S3-compatible bucket with versioning/lifecycle policy, and SMTP. Redis is queue coordination rather than the source of record; PostgreSQL compile records and immutable S3 checkpoints allow failed work to be diagnosed or resubmitted.

Run the migration task exactly once before deploying new application replicas:

```bash
docker compose -f infra/compose/production.yml run --rm migrate
docker compose -f infra/compose/production.yml up -d
```

The migration container invokes the bundled `tsx` loader directly, so applying migrations does
not require package-manager downloads or outbound network access at runtime.

All application containers handle `SIGTERM` and close listeners, workers, Redis connections, and database pools. Drain API traffic before termination and give workers at least the configured compile timeout plus 15 seconds.

## Health and metrics

- API liveness: `GET /health/live`
- API readiness: `GET /health/ready` checks PostgreSQL, Redis, and the object bucket.
- API metrics: `GET /metrics` exposes Prometheus queue gauges.
- Language service: `GET /health/live` and `GET /health/ready`
- Worker health is the BullMQ worker heartbeat plus the `compile_jobs` state-age alert.

Alert on readiness failures, growing waiting queues, builds stuck beyond `COMPILE_TIMEOUT_MS + 30s`, repeated infrastructure retry failures, bucket errors, and less than 15% free PostgreSQL or object-storage capacity.

## Backup and restore

Back up PostgreSQL and object storage as one recovery set. PostgreSQL contains manifests and object keys; restoring only one side produces incomplete projects.

1. Pause writes or take a database snapshot with a known timestamp/LSN.
2. Snapshot the S3 bucket with object versions retained from at least the same timestamp.
3. Store schema migrations and the deployed image digests with the backup metadata.
4. Restore into an isolated environment, run only migrations newer than the snapshot, and verify a sample of current files, checkpoints, PDFs, and SyncTeX artifacts.
5. Run cross-account probes before reopening traffic.

For logical PostgreSQL backups, use custom format (`pg_dump -Fc`) and test `pg_restore --list` plus a full restoration quarterly. Enable bucket versioning and protect backup credentials separately from application credentials. Redis AOF can reduce queue disruption but is not a substitute for PostgreSQL/S3 backups.

## Scaling and maintenance

API replicas are stateless. Language-service replicas need WebSocket affinity for the lifetime of a session but no project affinity after reconnect. Compile workers scale horizontally; PostgreSQL and per-project guards enforce one active build per project, while BullMQ applies the user and worker limits.

Only workers should reach the container runtime. Prefer a rootless, socket-proxied Docker daemon on a dedicated worker node or implement the existing `CompilationRunner` interface against Kubernetes Jobs. Keep TeX nodes on a network policy with no egress and never colocate them with databases or credentials they do not need.

The API maintenance leader uses a Redis lease to create five-minute dirty checkpoints and purge expired trash, history, job records, old versions, and unreferenced blobs. S3 lifecycle rules should be a safety net with a longer window than application retention, not an independent early delete.

## Release and rollback

Before release, require formatting, lint, typecheck, unit/integration tests, production builds, migration validation, container builds, real three-engine fixture compiles, browser E2E, license review, and an isolation probe. Database migrations are forward-only. Roll back application images only when they remain compatible with the migrated schema; otherwise deploy a corrective migration and forward fix.
