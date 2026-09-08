# LaTeX Workshop

LaTeX Workshop is a private, single-owner browser workspace for editing, compiling, previewing, and versioning LaTeX projects. It ships a Monaco editor backed by isolated TexLab sessions, hardened TeX Live compilation, a PDF.js viewer with SyncTeX, immutable history, safe ZIP transfer, and the Hate of Nature design system.

The product intentionally has no sharing, teams, comments, billing, or Git controls. Membership and runner boundaries are already isolated so those capabilities can be added without weakening tenant authorization or rewriting compilation.

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

## Private AI agent access

The optional Streamable HTTP MCP endpoint lets an OAuth-authenticated agent read selected projects
and create reviewable proposals without writing accepted source directly. It is disabled by default.
For a local test, set `AGENT_MCP_ENABLED=true` and connect an MCP client to
`http://localhost:3001/api/mcp`. Hosted clients require a public HTTPS URL, so expose the web/API
ingress through a secure tunnel and set `AGENT_MCP_RESOURCE_URL` to its exact `/api/mcp` URL.

The OAuth consent screen asks the owner to choose projects. Active connections and grants can be
changed or revoked under Account settings → Agent access. Agents can read source, build an isolated
proposal, request a hardened proposal compile, and freeze it for review. The workspace shows live
draft changes and a distinct proposal PDF; agents can request bounded images of specific compiled
pages for visual inspection, and accepted hunks become normal versioned edits.

Account settings also exposes the canonical remote MCP URL. Add that same URL to each Codex, Pi, or
Grok installation; each device authorizes once and stores its own rotating refresh credential. The
server supplies current instructions, tool descriptions, and the editing-guide resource at runtime,
so workflow updates do not need to be copied into every harness configuration.

Dynamic client registration is off by default. Enable `AGENT_MCP_DCR_ENABLED=true` only for older
clients that cannot use client ID metadata documents. Keep the configured read/write limits in
place, route all `/.well-known/*` paths to the API, and do not expose an HTTP production resource
URL. See [self-hosting](docs/self-hosting.md) and [security](docs/security.md) for ingress and trust
boundary details.

### How an agent edits a project

In an MCP-connected conversation, **LaTeX Workshop project** means a project hosted on the Mind
Palace site—not a local checkout and not the similarly named VS Code extension. The server publishes
this identity in its initialization instructions and provides the `edit_latex_workshop_project`
prompt plus the `mind-palace://latex-workshop/agent-editing-guide` resource for clients that expose
MCP prompts and resources.

The endpoint serves both the current MCP transport and the stateless 2025 compatibility protocol
negotiated by Codex. Keep both paths enabled when upgrading the MCP SDK; rejecting legacy protocol
handshakes prevents Codex from discovering any of the project tools.

Agents can create and rename projects without a separate confirmation step. `create_project` can
start from the standard blank document or the accepted source of any granted project, and it can
mark the result as a personal template. The project metadata is created immediately, but every byte
of seeded source is returned as a frozen review proposal; the new project contains only empty file
skeletons until the owner accepts those hunks. `rename_project` changes only the displayed project
name and takes effect immediately.

The MCP instructions enforce a scope distinction: projects and templates are top-level Library
items, while proposal file/structure tools operate only inside one project. A request to “create a
template” must use `create_project` with `isTemplate=true`; it must never be implemented by adding a
`.tex` file to the referenced source project. If a new item needs customized placeholders, the
agent edits the proposal returned by `create_project`, not the project supplied as
`sourceProjectId`. `list_projects` and `get_project_tree` repeat this rule in their results so it is
present at the point where the agent chooses its write tool.

`finish_proposal` automatically compiles the frozen review revision and keeps the MCP request open
for the bounded compile window. Its response includes the complete compile job, so the agent sees
warnings and errors as soon as they are available without a polling loop. `create_project` does the
same for its initial content proposal. `compile_proposal` remains available for explicit draft
preflight and also waits for its result; `get_proposal_compile` is the recovery path for interrupted
or unusually long requests.

For a normal request such as “Edit the LaTeX Workshop project _Research Notes_ and add the missing
citation,” the agent lists granted projects, matches the name, inspects the tree, and reads the
relevant accepted source. It then starts an isolated proposal and writes complete resulting files
with the accepted hashes as drift guards. Each write uses the revision returned by the previous
proposal operation.

For output-affecting edits, the agent requests a proposal compile and polls its status. Failed jobs
return diagnostics and a bounded log so the agent can revise and recompile. Finally,
`finish_proposal` freezes deterministic hunks. A `reviewing` result means the work is ready in the
Mind Palace editor; the accepted project is unchanged until the owner accepts those hunks. A
`needs_rebase` result tells the agent to reread the named conflicts, update the draft against the
new hashes, compile again, and resubmit.

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

## Project templates

Projects can be marked as live personal templates from their actions menu or Project settings.
Templates are edited like ordinary projects but appear only in the library's Templates view. New
projects copy the selected template's current persisted files, compiler, main document, and
auto-compile setting; the result is independent and is not itself a template.

The first Templates request provisions an editable **Aidan Template** from
[`DetectiveFierce/tex-template`](https://github.com/DetectiveFierce/tex-template) at commit
`ec40af3ef128d3950050e39d5a257aa6d8ff9aed`. A seed receipt prevents the starter from being
recreated after it is unmarked or deleted. The original seeded project is excluded from account
project-count and byte quotas, while per-file and per-project limits still apply; projects created
from it use normal quotas. The bundled `.latexmkrc` and `build.sh` remain editable source files, but
web compilation always uses the hardened `latexmk -norc` runner and never executes project scripts.

See [operations](docs/operations.md) for deployment, migrations, backup, recovery, and scaling, and [security](docs/security.md) for trust boundaries and hardening.
Automated contributors should also read [AGENTS.md](AGENTS.md) for code-placement rules, invariants,
implementation preferences, and the required verification gate.
