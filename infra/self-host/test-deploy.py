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


if __name__ == '__main__':
    unittest.main()
