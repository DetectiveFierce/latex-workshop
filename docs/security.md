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

## AI agent authorization boundary

The MCP service is disabled unless `AGENT_MCP_ENABLED=true`. In production its resource URL must be
HTTPS. Better Auth validates bearer-token signature, issuer, audience/resource, expiry, scopes, and
DPoP when present on every request. OAuth consent and token scopes are necessary but not sufficient:
each tool also joins the authenticated user and client to a current, owner-only project grant.
Removing a grant therefore takes effect immediately without waiting for token expiry.

Agent input is an untrusted boundary independent of browser quotas. Reads are byte-paged, and
proposals cap editable files at 2 MiB, total proposed text at 10 MiB, changed entries at 100, and
frozen hunks at 2,000. Only valid UTF-8 source files and source-only folder subtrees are mutable.
Normalized paths, case collisions, ancestry cycles, base hashes, proposal revisions, and
idempotency keys are checked before mutation. Redis events contain IDs only; browsers always
refetch durable, schema-validated state.

An agent never updates accepted `entries` while drafting. Proposal objects use tenant-scoped keys,
and proposal compilation consumes an immutable checkpoint in the same networkless runner as an
accepted build. Review applies only exact frozen hunks against the expected accepted projection;
drift becomes an isolated conflict rather than a fuzzy merge. Connection, grant, proposal,
decision, conflict, and compilation activity is recorded without source content in audit details.
User feedback may cause the same client to revise a proposal in `reviewing`: the CAS-bound write
atomically discards the obsolete frozen hunks and decisions, clears the stale compile reference,
and returns the proposal to `draft`. The revised state must be compiled and frozen again before the
owner can accept it. Resolved and rejected proposals remain immutable.

Compiled-page image requests identify an exact authorized proposal job and accept at most three
unique, bounded page numbers. The queue carries only the compile job database ID; an expiring Redis
record holds the opaque render request parameters. Ghostscript runs on the worker in a separate
non-root container with no network, a read-only root filesystem, no capabilities, bounded
CPU/memory/process/tmpfs resources, a hard timeout, and capped PDF/image sizes. Only validated PNG
outputs are returned, under tenant- and job-scoped object keys.

Rotate `AUTH_SECRET`, database, S3, SMTP, and Redis credentials with a managed secret store. Terminate TLS before all public traffic, set trusted proxy hops precisely, deny public S3 bucket access, and scan both Node and TeX images continuously. Run the cross-account endpoint suite on every authorization or schema change.
