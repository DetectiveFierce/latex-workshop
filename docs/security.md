# Security model

## Trust boundaries

Browsers are untrusted. The API authenticates secure cookie sessions, applies strict origin/CORS and CSRF checks through Better Auth, validates every payload, and resolves all project resources through centralized owner membership. Object keys, SSE subscriptions, compilation jobs, checkpoints, and language sessions inherit that same tenant decision.

LaTeX source and uploaded binaries are hostile input. ZIP imports reject absolute paths, traversal, symlinks, duplicate or case-conflicting names, excessive entries, oversized files/projects, and decompression expansion abuse before committing a project. Filenames are normalized and constrained independently of archive validation.

## Compilation boundary

Queue payloads contain only database IDs. Workers materialize immutable manifests into a new temporary directory and remove it in `finally` on every outcome. The pinned TeX container runs non-root with no network, read-only root, a single writable mount, no capabilities, `no-new-privileges`, process/CPU/memory/tmpfs limits, and a hard timeout. `latexmk` ignores user configuration, shell escape is explicitly disabled for all three engines, and only the PDF, compressed SyncTeX, bounded normalized log, and diagnostics are retained.

Access to the container daemon is equivalent to host authority. Restrict it to dedicated worker nodes and a rootless or policy-enforcing proxy. API and language-service instances must never mount that socket.

## Application controls

- Authentication and global request rate limits, verified email, revocable sessions, password reset/change, and confirmed deletion.
- Secure headers and CSP with no object embedding, no foreign frames, and only declared connection origins.
- Request, multipart, file, project, user, and job quotas enforced before durable changes.
- Compare-and-swap text versions prevent silent multi-tab overwrites; the client retains both versions for explicit resolution.
- Authorized range delivery avoids public artifact URLs. Signed uploads expire quickly and require authenticated finalize.
- Structured logging redacts cookies and authorization data. Audit records cover imports, restores, deletion, and quota-affecting operations.
- Unauthorized and nonexistent tenant resources share the same `404` behavior to limit enumeration.

Rotate `AUTH_SECRET`, database, S3, SMTP, and Redis credentials with a managed secret store. Terminate TLS before all public traffic, set trusted proxy hops precisely, deny public S3 bucket access, and scan both Node and TeX images continuously. Run the cross-account endpoint suite on every authorization or schema change.
