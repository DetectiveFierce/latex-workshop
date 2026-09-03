# LaTeX Workshop

LaTeX Workshop is a private, single-owner browser workspace for editing, compiling, previewing, and versioning LaTeX projects. It ships a Monaco editor backed by isolated TexLab sessions, hardened TeX Live compilation, a PDF.js viewer with SyncTeX, immutable history, safe ZIP transfer, and the Hate of Nature design system.

The product intentionally has no sharing, teams, comments, templates, billing, or Git controls. Membership and runner boundaries are already isolated so those capabilities can be added without weakening tenant authorization or rewriting compilation.

## Quick start

Requirements: Node.js 24 LTS, pnpm 10.15, Docker with Compose, and at least 6 GiB of free memory for the complete TeX image.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres redis minio mailpit
docker compose build texlive-image
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173`. Verification and password-reset mail appears in Mailpit at `http://localhost:8025`. MinIO administration is at `http://localhost:9001`, and the generated API reference is at `http://localhost:3001/api/docs`.

To run every component in containers instead:

```bash
docker compose up --build
```

The compile worker launches short-lived TeX containers through the Docker socket. Every build has no network, a read-only root filesystem, no capabilities, a non-root UID, fixed CPU/memory/process/output limits, and a hard timeout. Do not expose the Docker daemon over TCP.

## Repository map

| Area                    | Responsibility                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web`              | React/Vite UI, Monaco models and recovery drafts, PDF.js, command palette, history, and responsive panes |
| `apps/api`              | Fastify REST/SSE API, Better Auth, membership authorization, quotas, transfer, history, and retention    |
| `apps/compile-worker`   | BullMQ consumer, immutable checkpoint materialization, hardened TeX runner, artifacts, diagnostics       |
| `apps/language-service` | Authenticated WebSocket gateway and one isolated, idle-reaped TexLab workspace per project               |
| `packages/contracts`    | Shared Zod schemas, event types, path rules, and OpenAPI 3.1 document                                    |
| `packages/db`           | Drizzle schema and forward-only PostgreSQL migrations                                                    |
| `packages/storage`      | Tenant-keyed S3-compatible object operations and signed upload support                                   |
| `packages/ui`           | Canonical Hate of Nature tokens used by CSS, Monaco, PDF chrome, and diagnostics                         |
| `packages/config`       | Validated runtime configuration shared by every service                                                  |

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

For live deployment, use `pnpm deploy:fast` during development iteration and
`pnpm deploy:production` for the fully checked release path with a pre-migration backup. See
[self-hosting](docs/self-hosting.md) for the exact behavior and options.

The E2E suite expects the stack above to be running. Set `E2E_ALL_BROWSERS=true` after installing Playwright's Firefox and WebKit runtimes to exercise all engines plus the emulated iPad workflow, or set `E2E_IPAD=true` to run Chromium and iPad WebKit only. It creates a unique account, consumes its Mailpit verification message, edits and reloads a Monaco document, performs a real compile, checks the PDF viewer, and runs serious/critical axe checks.

## Runtime invariants

- Every project lookup is resolved through an owner membership; missing and unauthorized resources both return `404`.
- Text saves are compare-and-swap updates. Browser recovery drafts stay in IndexedDB until the server acknowledges the exact revision.
- Compile queues contain only identifiers. A compilation always consumes an immutable checkpoint, never mutable head files.
- Object keys are tenant-scoped, PDF delivery is authorized and range-capable, and binary uploads use short-lived signed requests plus authenticated finalize.
- A failed build never removes the last successful PDF. The preview is marked stale while the new diagnostics and log remain visible.
- Restoration appends a new head checkpoint; history is never rewritten.

See [operations](docs/operations.md) for deployment, migrations, backup, recovery, and scaling, and [security](docs/security.md) for trust boundaries and hardening.
