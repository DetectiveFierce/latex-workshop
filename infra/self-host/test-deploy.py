#!/usr/bin/env python3
"""Verify activation staging and rollback guards without a live host."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).parent


class DeploymentRecovery(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        for name in ('bin', 'runtime/compile-tmp', 'runtime/backup-stage', 'releases/old/infra/compose', 'releases/new/infra/compose'):
            (root / name).mkdir(parents=True)
        for release in ('old', 'new'):
            (root / f'releases/{release}/infra/compose/self-hosted.yml').write_text('services: {}\n')
        (root / 'current').symlink_to(root / 'releases/old')
        (root / '.env').write_text('SERVICE_IMAGE=services:old\nWEB_IMAGE=web:favicon\nTEXLIVE_IMAGE=tex:old\nBACKUP_UID=1\nBACKUP_GID=1\nADDITIONAL_TRUSTED_ORIGINS=https://example.test\n')
        stat = root / 'bin/stat'
        stat.write_text('#!/bin/sh\nprintf "10001:10001\\n"\n')
        stat.chmod(0o755)
        return root

    def test_invalid_compose_keeps_active_release_and_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            original = (root / '.env').read_text()
            docker = root / 'bin/docker'
            docker.write_text('#!/bin/sh\nexit 17\n')
            docker.chmod(0o755)
            env = dict(os.environ, LATEX_WORKSHOP_ROOT=str(root), PATH=f'{root}/bin:{os.environ["PATH"]}')
            result = subprocess.run(['sh', str(SCRIPTS / 'initialize-host.sh'), 'new'], capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / '.env').read_text(), original)
            self.assertEqual((root / 'current').resolve(), root / 'releases/old')

    def test_rollback_refuses_different_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            for release in ('old', 'new'):
                migration = root / f'releases/{release}/packages/db/drizzle/0001.sql'
                migration.parent.mkdir(parents=True)
                migration.write_text(f'-- {release}\n')
            ssh = root / 'bin/ssh'
            ssh.write_text('#!/usr/bin/env bash\nshift 3\nexec "$@"\n')
            ssh.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}/bin:{os.environ["PATH"]}')
            result = subprocess.run(['bash', str(SCRIPTS / 'rollback.sh'), 'new', '--deploy-root', str(root), '--dry-run'], capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('migration histories differ', result.stderr)
            self.assertEqual((root / 'current').resolve(), root / 'releases/old')

    def test_restore_uses_saved_independent_images_and_preserves_other_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            state = root / 'runtime/release-state/new'
            state.mkdir(parents=True)
            (state / 'images.env').write_text('SERVICE_IMAGE=services:new\nWEB_IMAGE=web:favicon\nTEXLIVE_IMAGE=tex:old\n')
            (state / 'services.yml').write_text('services:\n  web:\n    image: "sha256:' + 'a' * 64 + '"\n')
            (state / 'services.txt').write_text('web\n')
            docker = root / 'bin/docker'
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >>"$TEST_LOG"\nexit 0\n')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}/bin:{os.environ["PATH"]}', TEST_LOG=str(root / 'docker.log'))
            result = subprocess.run(['bash', '-c', 'source "$1"; release_state_activate "$2" "$2/releases/new"', '--', str(SCRIPTS / 'release-state.sh'), str(root)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / 'current').resolve(), root / 'releases/new')
            self.assertIn('WEB_IMAGE=web:favicon', (root / '.env').read_text())
            self.assertIn('ADDITIONAL_TRUSTED_ORIGINS=https://example.test', (root / '.env').read_text())
            self.assertIn('services.yml up -d --no-build --pull never --wait', (root / 'docker.log').read_text())


    def test_legacy_tunnel_snapshot_restores_files_and_exact_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            tunnel = root / 'external-tunnel'
            tunnel.mkdir()
            state = root / 'runtime/release-state/old'
            state.mkdir(parents=True)
            files = ('.env', 'compose.yml', 'compose.private.yml', 'Dockerfile', 'health.sh')
            for file in files:
                (tunnel / file).write_text('original ' + file + '\n')
            with (root / '.env').open('a') as handle:
                handle.write('AGENT_MCP_TUNNEL_KEY=' + 'a' * 64 + '\n')
            docker = root / 'bin/docker'
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >>"$TEST_LOG"\ncase "$1" in\ninspect) printf "sha256:' + 'b' * 64 + '\\n" ;;\ncompose) case "$*" in *"ps -q tunnel-client") echo tunnel-container ;; esac ;;\nesac\n')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}/bin:{os.environ["PATH"]}', TEST_LOG=str(root / 'docker.log'), LATEX_WORKSHOP_TUNNEL_ROOT=str(tunnel))
            command = 'set -e; source "$1"; release_tunnel_capture "$2" "$3"; for file in .env compose.yml compose.private.yml Dockerfile health.sh; do printf changed >"$4/$file"; done; release_tunnel_activate "$3"'
            result = subprocess.run(['bash', '-c', command, '--', str(SCRIPTS / 'release-state.sh'), str(root), str(state), str(tunnel)], capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            for file in files:
                self.assertEqual((tunnel / file).read_text(), 'original ' + file + '\n')
            self.assertEqual((state / 'tunnel/.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual((tunnel / '.env').stat().st_mode & 0o777, 0o600)
            self.assertIn('sha256:' + 'b' * 64, (state / 'tunnel/images.yml').read_text())
            log = (root / 'docker.log').read_text()
            self.assertIn('--project-directory ' + str(tunnel), log)
            self.assertIn('up -d --no-build --pull never --wait', log)
            self.assertIn('exec -T tunnel-client workshop-tunnel-health', log)

    def test_public_gateway_snapshot_leaves_legacy_tunnel_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            with (root / '.env').open('a') as handle:
                handle.write('PUBLIC_MCP_GATEWAY_ENABLED=true\nAGENT_MCP_TUNNEL_KEY=' + 'a' * 64 + '\n')
            result = subprocess.run(['bash', '-c', 'source "$1"; release_tunnel_capture "$2" "$2/state"', '--', str(SCRIPTS / 'release-state.sh'), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / 'state/tunnel').exists())

    def test_transfer_and_source_digest_exclude_the_same_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            destination = root / 'destination'
            source.mkdir()
            destination.mkdir()
            for name in ('src/app.ts', 'public/icon.svg', '.env', '.env.local', '.env.example', 'nested/.env', 'nested/.env.production', 'nested/.env.example', 'infra/openai-mcp-tunnel/secrets/private.key', '.git/HEAD', 'nested/.git', 'coverage/result.txt', 'nested/coverage/result.txt', 'nested/node_modules/cache.js', 'nested/dist/app.js', 'nested/data/private.txt', 'nested/tmp/cache.txt', 'nested/.turbo/cache.txt', 'nested/test-results/result.txt', 'nested/playwright-report/report.html', 'src/file.tsbuildinfo'):
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('fixture\n')
            script = (Path(__file__).parent / 'deploy.sh').read_text()
            options = 'rsync_options=(' + script.split('rsync_options=(', 1)[1].split('\n)', 1)[0] + '\n)'
            function = 'write_source_manifest() {' + script.split('write_source_manifest() {', 1)[1].split('\n}\n', 1)[0] + '\n}'
            command = options + '\n' + function + '\nwrite_source_manifest "$1/manifest"\nrsync "${rsync_options[@]}" ./ "$1/destination/"\n(cd "$1/destination" && sha256sum --check --strict "$1/manifest")'
            result = subprocess.run(['bash', '-e', '-c', command, '--', str(root)], cwd=source, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((destination / '.env').exists())
            self.assertFalse((destination / 'nested/.env').exists())
            self.assertFalse((destination / '.env.local').exists())
            self.assertFalse((destination / 'nested/.env.production').exists())
            self.assertFalse((destination / 'infra/openai-mcp-tunnel/secrets/private.key').exists())
            self.assertTrue((destination / '.env.example').is_file())
            self.assertTrue((destination / 'nested/.env.example').is_file())
            self.assertTrue((destination / 'public/icon.svg').is_file())

    def test_shell_characters_in_remote_root_are_rejected(self):
        script = Path(__file__).parent / 'deploy.sh'
        result = subprocess.run(['bash', str(script), '--fast', '--dry-run', '--deploy-root', '/tmp/root;echo injected'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Deployment root must be', result.stderr)


    def check_failure_after_migration(self, unchanged):
        with tempfile.TemporaryDirectory() as directory:
            script = (SCRIPTS / 'deploy.sh').read_text()
            trap = 'rollback_on_failure() {' + script.split('rollback_on_failure() {', 1)[1].split('trap rollback_on_failure EXIT', 1)[0] + 'trap rollback_on_failure EXIT\n'
            root = Path(directory)
            setup = 'set -Eeuo pipefail\nactivated=true\nmigration_started=true\nschema_unchanged=' + str(unchanged).lower() + '\nprevious_release=/releases/previous\ndeploy_root="$1"\nrelease_state_activate() { printf restored >"$deploy_root/restored"; }\n'
            result = subprocess.run(['bash', '-c', setup + trap + '\nexit 23\n', '--', str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 23)
            self.assertEqual((root / 'restored').exists(), unchanged)
            if unchanged:
                self.assertIn('Previous runtime restored', result.stderr)
            else:
                self.assertIn('migration histories differ', result.stderr)

    def test_health_failure_after_unchanged_migration_restores_images(self):
        self.check_failure_after_migration(True)

    def test_changed_migration_failure_requires_data_or_forward_recovery(self):
        self.check_failure_after_migration(False)

    def test_success_releases_lock_without_background_cleanup(self):
        script = (SCRIPTS / 'deploy.sh').read_text()
        success = script.split('release_state_capture "$deploy_root" "$release_dir"', 1)[1]
        self.assertNotIn('nohup ', success)
        self.assertNotIn('docker builder prune', success)


if __name__ == '__main__':
    unittest.main()
