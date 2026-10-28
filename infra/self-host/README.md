# Deployment and recovery

Run from the repository root:

```sh
pnpm deploy:production
pnpm deploy:fast -- --dry-run
pnpm deploy:rollback RELEASE_ID --dry-run
pnpm deploy:rollback RELEASE_ID
```

The scripts resolve their checkout from their own location, so moving the checkout does not change
the remote destination. Override it with `--host` / `--deploy-root` or `LATEX_DEPLOY_HOST` /
`LATEX_WORKSHOP_ROOT`. Production deployment runs the full release gate and a pre-migration backup;
fast deployment skips those checks and backup. A dry run validates and previews transfer.

Before activation, the deployment records the active service images and the separate service, web,
and TeX image settings under `runtime/release-state/RELEASE_ID` on the host. This preserves a web-only
hotfix and gateway images independently. In legacy hosted-tunnel mode, the same private snapshot
also records the separate tunnel container image and its configuration files, including its private
`.env`. Recovery restores and health-checks that exact tunnel image. Public-gateway mode leaves the
legacy tunnel unchanged. Keep `runtime/release-state` private and outside source control.
Activation failures restore that exact state before migration, or after migration when the current
and candidate migration histories are identical. Failures after a changed migration starts require
a forward fix or verified data recovery.
The deployment retains source releases and image tags; remove obsolete targets only after deciding
which recovery points to keep.

Rollback requires a previously captured target, all its local images, and an identical database
migration history. The first deployment with these scripts captures the existing active release
before changing it. Rollback starts the saved images, preserves current non-image configuration and
live data, and checks container health and the HTTPS route. If rollback fails, it attempts to restore
the runtime that was active when rollback began. A migration history difference requires a forward
fix or a separately verified database/object-storage restoration; this command never restores data.

Daily backups use `backup.sh` and default to the active synced directory
`/home/mind-palace/data/landing-zone/Backups/latex-workshop`; set `LATEX_WORKSHOP_BACKUP_ROOT` to override
it. Backup staging and archives use private permissions. Existing archives at the older
`/home/mind-palace/docker/syncthing/data/landing_zone/Backups/latex-workshop` remain available.

Local recovery regression checks:

```sh
bash -n infra/self-host/*.sh
python3 infra/self-host/test-deploy.py
```
