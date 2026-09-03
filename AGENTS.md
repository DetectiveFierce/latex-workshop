# Agent guide

This file is the operating contract for automated contributors. Read it before changing the
repository. Product behavior and setup live in `README.md`; operational and trust-boundary detail
lives in `docs/operations.md`, `docs/self-hosting.md`, and `docs/security.md`.

## Non-negotiable invariants

- Treat every API, WebSocket, archive, environment, storage, and browser-persistence value as
  untrusted. Parse it at the boundary; keep the interior strongly typed.
- Resolve projects through owner membership. Missing and unauthorized resources deliberately have
  the same `404` behavior.
- Keep text writes compare-and-swap. A compilation consumes an immutable checkpoint, never mutable
  head files. A failed build must not replace the last successful PDF.
- Keep object keys tenant-scoped and archive paths relative. Compilation remains networkless,
  capability-free, non-root, resource-limited, and time-limited.
- History and migrations are forward-only. Restoration creates new state; it does not rewrite old
  state.
- Do not add sharing, teams, comments, billing, templates, or Git features as incidental work. Those
  product omissions are intentional.

## Where code belongs

| Change                                     | Primary location                         | Notes                                                                             |
| ------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Request/response shape or shared invariant | `packages/contracts/src`                 | Define the Zod schema first and infer the TypeScript type from it.                |
| Runtime configuration                      | `packages/config/src`                    | Parse once at startup; services receive `AppConfig`, not raw environment strings. |
| Tables or migrations                       | `packages/db/src`, `packages/db/drizzle` | Never edit an applied migration. Generate a new forward migration.                |
| Object storage                             | `packages/storage/src`                   | Keep provider details behind `ObjectStorage`.                                     |
| Authorization/domain operation             | `apps/api/src/lib`                       | Routes should validate, authorize, call domain code, and serialize.               |
| HTTP endpoint                              | `apps/api/src/routes`                    | Register by bounded feature; do not bypass `requireUser`/`requireProject`.        |
| Compile execution/log parsing              | `apps/compile-worker/src`                | Keep the runner interface independent of Docker where practical.                  |
| LSP process/framing                        | `apps/language-service/src`              | One isolated temporary workspace per authenticated project session.               |
| Browser data access                        | `apps/web/src/lib`                       | Validate persisted and network data before components consume it.                 |
| Editor/PDF integration                     | `apps/web/src/features`                  | Keep protocol and coordinate helpers testable without rendering React.            |
| Route composition                          | `apps/web/src/routes`                    | Extract reusable or state-free behavior before route files grow further.          |
| Reusable visual primitives/tokens          | `packages/ui`, `apps/web/src/components` | Preserve the Hate of Nature tokens and accessible interaction semantics.          |

`DashboardPage.tsx` and `WorkspacePage.tsx` are legacy composition hotspots. Avoid adding more
unrelated helpers or dialogs to them. New state-free logic goes in `lib`/`features`; substantial new
UI sections get a colocated component module.

## Implementation preferences

- Prefer discriminated unions, exhaustive switches, schema inference, and type guards over casts.
  Do not introduce `any` or a non-null assertion to silence a boundary problem.
- Make illegal states unrepresentable when they are internal. At external boundaries, return a
  controlled client error or ignore a malformed optional cache/message; do not let parsing failures
  become uncaught process or event-handler errors.
- Keep functions small enough to test directly. Extract parsers, normalizers, and state transitions
  from framework callbacks.
- Preserve ESM conventions: type-only imports use `import type`, and relative TypeScript imports use
  the emitted `.js` suffix.
- Prefer explicit byte/count/time limits for attacker-influenced loops, buffers, queues, and
  decompression. Check declared sizes and enforce actual streamed sizes.
- Comments explain a constraint or a surprising choice, not syntax. Names should carry routine
  intent.
- Do not duplicate contracts in apps. If multiple processes need a shape, export it from
  `@latex-workshop/contracts`.

## Verification

Run the narrowest affected test while iterating, then run the release gate before handoff:

```bash
pnpm check
pnpm security:audit
```

`pnpm check` performs formatting, lint, strict typechecking, unit/property tests, and production
builds through one Turbo invocation so shared dependency builds are reused. Tests are deterministic:
seed fuzz/property loops explicitly and include the seed in source. A fixed bug needs a regression
test at the lowest boundary that reproduces it. Packages without meaningful tests do not declare a
placeholder test script.

Database work additionally requires `pnpm db:migrate` against a disposable database. Browser flows
require the Compose stack and `pnpm test:e2e`; see `README.md` for browser selection. Deployment
changes should at least pass `bash -n infra/self-host/*.sh` and `docker compose config --quiet` when
Docker is available.

## Deployment discipline

- `pnpm deploy:fast` is for iteration: it intentionally skips local checks and backup.
- `pnpm deploy:production` runs the dependency audit and release gate, takes a pre-migration backup,
  builds versioned images, verifies the transfer digest, migrates once, health-checks, and activates.
- Keep independent local checks, image builds, and stopped-writer backup readers parallel. Do not
  parallelize activation, migration, application startup, or external health verification.
- Keep release activation reversible until a migration starts. Never add destructive cleanup before
  health checks prove the new release is active.
- Pin container bases by digest and JavaScript dependencies through `pnpm-lock.yaml`. Explain and
  narrowly scope overrides; remove them once the upstream dependency graph no longer needs them.
