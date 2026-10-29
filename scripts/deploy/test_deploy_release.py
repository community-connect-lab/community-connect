"""Offline archive and rollback checks: no host services, credentials or APIs."""
from contextlib import ExitStack
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('deploy_release', SCRIPTS/'deploy-release.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
COMMIT = 'a' * 40
DIGEST = 'b' * 64


class ArchiveChecks(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='.offline-test-', dir=SCRIPTS))
        self.files = {name: ('fixture: ' + name + '\n').encode() for name in helper.RUNTIME_FILES}

    def tearDown(self):
        resolved = self.root.resolve()
        self.assertEqual(resolved.parent, SCRIPTS.resolve())
        self.assertTrue(resolved.name.startswith('.offline-test-'))
        shutil.rmtree(resolved)

    def archive(self, *, changed=None, omitted=None, extra=None, duplicate=None,
                special=None, manifest_update=None):
        manifest = {'schema': 1, 'commit': COMMIT,
                    'files': {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}}
        if manifest_update:
            manifest_update(manifest)
        entries = {**self.files, 'release.json': json.dumps(manifest).encode()}
        if changed:
            entries.update(changed)
        if omitted:
            entries.pop(omitted)
        if extra:
            entries.update(extra)
        path = self.root/'app.tar.gz'
        with tarfile.open(path, 'w:gz') as packed:
            for name, data in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                if special and name == special[0]:
                    info.type = special[1]; info.linkname = '/etc/community-connect/backend.env'; info.size = 0
                packed.addfile(info, io.BytesIO(data) if info.isreg() else None)
            if duplicate:
                data = entries[duplicate]
                info = tarfile.TarInfo(duplicate); info.size = len(data)
                packed.addfile(info, io.BytesIO(data))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_valid_exact_runtime_and_manifest(self):
        path, digest = self.archive()
        manifest, contents = helper.validate_archive(path, COMMIT, digest)
        self.assertEqual(set(contents), helper.RUNTIME_FILES | {'release.json'})
        self.assertEqual(set(manifest['files']), helper.RUNTIME_FILES)
        self.assertEqual(len(manifest['files']), 26)

    def test_digest_mismatch_rejected_before_tar_processing(self):
        path, _ = self.archive()
        with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_DIGEST_MISMATCH'):
            helper.validate_archive(path, COMMIT, '0' * 64)

    def test_all_member_hashes_required(self):
        path, digest = self.archive(changed={'calling-server.mjs': b'changed after manifest'})
        with self.assertRaisesRegex(helper.DeployError, 'FILE_DIGEST_MISMATCH'):
            helper.validate_archive(path, COMMIT, digest)

    def test_missing_file_rejected(self):
        path, digest = self.archive(omitted='lib/config.mjs')
        with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_FILE_SET_INVALID'):
            helper.validate_archive(path, COMMIT, digest)

    def test_extra_and_traversal_names_rejected(self):
        for name in ['.env', '../escape', '/etc/backend.env', './calling-server.mjs', 'lib\\config.mjs']:
            with self.subTest(name=name):
                path, digest = self.archive(extra={name: b'not permitted'})
                with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_PATH_INVALID'):
                    helper.validate_archive(path, COMMIT, digest)

    def test_duplicate_member_rejected(self):
        path, digest = self.archive(duplicate='calling-server.mjs')
        with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_PATH_INVALID'):
            helper.validate_archive(path, COMMIT, digest)

    def test_links_and_devices_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                path, digest = self.archive(special=('calling-server.mjs', kind))
                with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_TYPE_INVALID'):
                    helper.validate_archive(path, COMMIT, digest)

    def test_manifest_wrong_commit_and_file_set_rejected(self):
        for change in [lambda data: data.update(commit='c' * 40),
                       lambda data: data['files'].update({'.env': 'd' * 64})]:
            path, digest = self.archive(manifest_update=change)
            with self.assertRaises(helper.DeployError):
                helper.validate_archive(path, COMMIT, digest)

    def test_declared_file_size_bounded(self):
        path, digest = self.archive(changed={'calling-server.mjs': b'x' * (helper.MAX_FILE_BYTES + 1)})
        with self.assertRaisesRegex(helper.DeployError, 'ARCHIVE_FILE_TOO_LARGE'):
            helper.validate_archive(path, COMMIT, digest)


class ActivationChecks(unittest.TestCase):
    def run_activation(self, health_fail=False, stop_fail=False, rollback_fail=False):
        app = MagicMock()
        app.is_symlink.return_value = True
        target, previous = Path('/release/new'), Path('/release/prior')
        manifest = {'commit': COMMIT}
        prior_manifest = {'commit': 'c' * 40}
        with ExitStack() as stack:
            stack.enter_context(patch.object(helper, 'APP', app))
            command = stack.enter_context(patch.object(helper, 'capture', return_value=''))
            links = stack.enter_context(patch.object(helper, 'atomic_link'))
            health = stack.enter_context(patch.object(helper, 'check_health'))
            state = stack.enter_context(patch.object(helper, 'write_state'))
            stack.enter_context(patch.object(helper, 'log'))
            if stop_fail:
                command.side_effect = [helper.DeployError('timeout'), '', '']
            if health_fail:
                health.side_effect = [helper.DeployError('bad release'),
                                      helper.DeployError('old release bad') if rollback_fail else None]
            if health_fail or stop_fail:
                expected = 'ROLLBACK_UNCONFIRMED' if rollback_fail else 'PREVIOUS_RELEASE_RESTORED'
                with self.assertRaisesRegex(helper.DeployError, expected):
                    helper.activate_release(target, manifest, previous, False, COMMIT, DIGEST, prior_manifest)
                self.assertEqual(state.call_count, 0 if rollback_fail else 1)
                if not rollback_fail:
                    self.assertEqual(state.call_args.args[0]['commit'], 'c' * 40)
            else:
                helper.activate_release(target, manifest, previous, False, COMMIT, DIGEST, prior_manifest)
                self.assertEqual(state.call_args.args[0]['commit'], COMMIT)
                self.assertEqual(links.call_args.args, (target,))
            return command.call_args_list, links.call_args_list, health.call_args_list

    def test_success_switches_once_and_verifies(self):
        commands, links, health = self.run_activation()
        self.assertEqual(len(links), 1)
        self.assertEqual([call.args[0][1] for call in commands], ['stop', 'start'])
        self.assertEqual(len(health), 1)

    def test_failed_health_restores_previous_link_and_rechecks(self):
        commands, links, health = self.run_activation(health_fail=True)
        self.assertEqual([call.args[0] for call in links], [Path('/release/new'), Path('/release/prior')])
        self.assertEqual([call.args[0][1] for call in commands], ['stop', 'start', 'stop', 'start'])
        self.assertEqual(len(health), 2)

    def test_uncertain_stop_attempt_restarts_previous_worker(self):
        commands, links, health = self.run_activation(stop_fail=True)
        self.assertEqual(len(links), 0)
        self.assertEqual([call.args[0][1] for call in commands], ['stop', 'stop', 'start'])
        self.assertEqual(len(health), 1)

    def test_failed_rollback_is_reported_unconfirmed(self):
        self.run_activation(health_fail=True, rollback_fail=True)

    def test_first_deployment_preserves_legacy_directory(self):
        app = MagicMock()
        legacy, target = Path('/release/legacy'), Path('/release/new')
        with patch.object(helper, 'APP', app), patch.object(helper, 'LEGACY', legacy), \
                patch.object(helper, 'capture'), patch.object(helper, 'atomic_link') as links, \
                patch.object(helper, 'check_health'), patch.object(helper, 'write_state'), patch.object(helper, 'log'):
            helper.activate_release(target, {'commit': COMMIT}, legacy, True, COMMIT, DIGEST, None)
            app.rename.assert_called_once_with(legacy)
            links.assert_called_once_with(target)

    def test_failed_first_link_restores_preserved_legacy(self):
        app, legacy = MagicMock(), MagicMock()
        app.exists.return_value = False
        app.is_symlink.return_value = True
        legacy.exists.return_value = True
        target, prior = Path('/release/new'), Path('/release/legacy')
        with patch.object(helper, 'APP', app), patch.object(helper, 'LEGACY', legacy), \
                patch.object(helper, 'capture'), patch.object(helper, 'atomic_link') as links, \
                patch.object(helper, 'check_health') as health, patch.object(helper, 'write_state'), patch.object(helper, 'log'):
            links.side_effect = [OSError('simulated link failure'), None]
            with self.assertRaisesRegex(helper.DeployError, 'PREVIOUS_RELEASE_RESTORED'):
                helper.activate_release(target, {'commit': COMMIT}, prior, True, COMMIT, DIGEST, None)
            self.assertEqual([call.args[0] for call in links.call_args_list], [target, prior])
            health.assert_called_once_with(prior, None)

    def test_failed_legacy_rename_restarts_original_directory(self):
        app, legacy = MagicMock(), MagicMock()
        app.rename.side_effect = OSError('simulated rename failure')
        app.exists.return_value = True
        app.is_symlink.return_value = False
        legacy.exists.return_value = False
        with patch.object(helper, 'APP', app), patch.object(helper, 'LEGACY', legacy), \
                patch.object(helper, 'capture'), patch.object(helper, 'atomic_link') as links, \
                patch.object(helper, 'check_health') as health, patch.object(helper, 'write_state'), patch.object(helper, 'log'):
            with self.assertRaisesRegex(helper.DeployError, 'PREVIOUS_RELEASE_RESTORED'):
                helper.activate_release(Path('/release/new'), {'commit': COMMIT}, Path('/release/legacy'), True, COMMIT, DIGEST, None)
            links.assert_not_called()
            health.assert_called_once_with(app, None)


class DeskGateChecks(unittest.TestCase):
    def test_owned_or_unverified_desk_fails_closed(self):
        with patch.object(helper, 'service_active', return_value=True), \
                patch.object(helper, 'capture', side_effect=helper.DeployError('private error')):
            with self.assertRaisesRegex(helper.DeployError, 'DESK_BUSY_OR_UNVERIFIED'):
                helper.refuse_owned_desk()

    def test_stopped_process_skips_desk_request(self):
        with patch.object(helper, 'service_active', return_value=False), patch.object(helper, 'capture') as commands:
            helper.refuse_owned_desk()
            commands.assert_not_called()


class SsmDocumentChecks(unittest.TestCase):
    def test_shared_failure_controls_are_plugin_inputs(self):
        # AWS Command document plugin reference, "Shared inputs", schema 2.2
        # JSON example places onFailure inside inputs, not beside action/name.
        # https://docs.aws.amazon.com/systems-manager/latest/userguide/documents-command-ssm-plugin-reference.html
        document = json.loads((SCRIPTS/'ssm-document.json').read_text(encoding='utf-8'))
        self.assertEqual(document['schemaVersion'], '2.2')
        self.assertEqual(set(document), {'schemaVersion', 'description', 'parameters', 'mainSteps'})
        self.assertEqual(set(document['parameters']), {'Commit', 'Digest'})
        self.assertEqual([step['name'] for step in document['mainSteps']], ['DownloadRelease', 'DeployVerifiedRelease'])
        for step in document['mainSteps']:
            self.assertEqual(set(step), {'action', 'name', 'precondition', 'inputs'})
            self.assertEqual(step['inputs']['onFailure'], 'exit')
            self.assertEqual(step['precondition'], {'StringEquals': ['platformType', 'Linux']})
        download = document['mainSteps'][0]['inputs']
        self.assertEqual(download['sourceType'], 'S3')
        self.assertEqual(json.loads(download['sourceInfo']), {'path': 'https://community-connect-deploy-814462560346-eu-west-2.s3.eu-west-2.amazonaws.com/releases/{{ Commit }}/app.tar.gz'})


if __name__ == '__main__':
    unittest.main()
