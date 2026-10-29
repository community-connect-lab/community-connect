"""Offline checks for release provenance, archive boundaries and uncertain deploys."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load('release_package', DEPLOY / 'package-release.py')
client = load('release_client', DEPLOY / 'deploy-aws.py')
COMMIT = 'a' * 40
COMMAND = '12345678-1234-1234-1234-123456789abc'
INSTANCE = 'mi-0123456789abcdef0'
FIXTURES = {name: f'public fixture: {name}\n'.encode() for name in package.RUNTIME_FILES}


def fixture_git(repo, *args):
    if args[0] == 'ls-tree':
        path = args[-1]
        return f'100644 blob {"b" * 40}\t{path}\n'.encode()
    if args[:2] == ('cat-file', '-s'):
        return str(len(FIXTURES[args[2].split(':', 1)[1]])).encode()
    if args[0] == 'show':
        return FIXTURES[args[1].split(':', 1)[1]]
    if args[:2] == ('cat-file', '-t'):
        return b'commit\n'
    if args[0] == 'merge-base':
        return b''
    raise AssertionError('Unexpected Git read')


def build_fixture(root):
    archive = root / 'app.tar.gz'
    with patch.object(package, 'git', fixture_git):
        package.package_release(root, COMMIT, archive)
    return archive


class FakeAWS:
    def __init__(self, states=('Success',), send_error=False, existing=None, download_states=('Success',)):
        self.states = {'DownloadRelease': list(download_states), 'DeployVerifiedRelease': list(states)}
        self.calls = []
        self.send_error = send_error
        self.existing = existing

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ('s3api', 'put-object'):
            if self.existing is not None:
                raise client.AwsError('RELEASE_ALREADY_EXISTS')
            return {}
        if args[:2] == ('s3api', 'head-object'):
            return self.existing
        if args[:2] == ('ssm', 'send-command'):
            if self.send_error:
                raise client.AwsError('AWS_REQUEST_UNCERTAIN')
            return {'Command': {'CommandId': COMMAND}}
        if args[:2] == ('ssm', 'get-command-invocation'):
            if '--plugin-name' not in args:
                raise AssertionError('Multi-step document requires an explicit plugin name')
            plugin = args[args.index('--plugin-name') + 1]
            states = self.states[plugin]
            status = states.pop(0) if len(states) > 1 else states[0]
            if status == 'NOT_VISIBLE':
                raise client.AwsError('INVOCATION_NOT_YET_VISIBLE')
            return {'CommandId': COMMAND, 'InstanceId': INSTANCE, 'DocumentName': client.DOCUMENT, 'PluginName': plugin,
                    'Status': status, 'ResponseCode': 0 if status == 'Success' else -1,
                    'StandardOutputContent': 'SYNTHETIC_PRIVATE_STDOUT_SENTINEL',
                    'StandardErrorContent': 'SYNTHETIC_PRIVATE_STDERR_SENTINEL'}
        if args[:2] == ('ssm', 'cancel-command'):
            return {}
        raise AssertionError('Unexpected AWS operation')


class Clock:
    def __init__(self):
        self.value = 0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class ReleaseTests(unittest.TestCase):
    def test_archive_is_deterministic_and_excludes_working_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('SYNTHETIC_PRIVATE_ENV_SENTINEL')
            archive = build_fixture(root)
            first = archive.read_bytes()
            build_fixture(root)
            self.assertEqual(archive.read_bytes(), first)
            manifest, _ = client.verify_archive(archive, COMMIT)
            self.assertEqual(set(manifest['files']), set(package.RUNTIME_FILES))
            with tarfile.open(archive) as packed:
                self.assertEqual(len(packed.getmembers()), 27)
                self.assertNotIn('.env', packed.getnames())
                self.assertEqual(packed.extractfile('calling-server.mjs').read(), FIXTURES['calling-server.mjs'])

    def test_symlink_runtime_entry_is_rejected(self):
        def symlink(repo, *args):
            if args[0] == 'ls-tree':
                return f'120000 blob {"b" * 40}\t{args[-1]}\n'.encode()
            return fixture_git(repo, *args)
        with tempfile.TemporaryDirectory() as directory, patch.object(package, 'git', symlink):
            with self.assertRaises(package.ReleaseError):
                package.package_release(Path(directory), COMMIT, Path(directory) / 'app.tar.gz')

    def test_non_main_history_commit_and_ref_expressions_are_rejected(self):
        def divergent(repo, *args):
            if args[0] == 'merge-base':
                raise package.ReleaseError('GIT_VALIDATION_FAILED')
            return fixture_git(repo, *args)
        with patch.object(package, 'git', divergent):
            with self.assertRaises(package.ReleaseError):
                package.resolve_commit(Path('.'), COMMIT, COMMIT)
        with self.assertRaises(package.ReleaseError):
            package.resolve_commit(Path('.'), 'main~1', COMMIT)

    def test_changed_archive_bytes_fail_manifest_before_any_aws_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = build_fixture(root)
            with tarfile.open(archive) as packed:
                data = {member.name: packed.extractfile(member).read() for member in packed}
            data['calling-server.mjs'] += b'changed\n'
            with tarfile.open(archive, 'w:gz') as packed:
                for name, contents in data.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(contents)
                    packed.addfile(member, io.BytesIO(contents))
            aws = FakeAWS()
            deployment = client.Deployment(archive, COMMIT, INSTANCE, root / 'report.json', aws=aws)
            with self.assertRaises(client.DeploymentError):
                deployment.run()
            self.assertEqual(aws.calls, [])
            self.assertEqual(deployment.report['result'], 'FAILED_BEFORE_COMMAND')


class DeploymentLifecycleTests(unittest.TestCase):
    def deployment(self, root, aws, **options):
        return client.Deployment(build_fixture(root), COMMIT, INSTANCE, root / 'report.json', aws=aws, **options)

    def test_success_waits_for_ssm_then_checks_manifest_and_never_prints_remote_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root, clock, aws = Path(directory), Clock(), FakeAWS(('NOT_VISIBLE', 'InProgress', 'Success'))
            checked = []
            deployment = self.deployment(root, aws, clock=clock.now, sleep=clock.sleep, public_check=checked.append)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                report = deployment.run()
            self.assertEqual(report['result'], 'DEPLOYED_AND_PUBLIC_UI_VERIFIED')
            self.assertEqual(report['commandId'], COMMAND)
            self.assertEqual(len(checked), 1)
            self.assertEqual(report['pluginStatus'], {'DownloadRelease': 'Success', 'DeployVerifiedRelease': 'Success'})
            self.assertEqual(checked[0]['commit'], COMMIT)
            sent = next(call for call in aws.calls if call[:2] == ('ssm', 'send-command'))
            parameters = json.loads(sent[sent.index('--parameters') + 1])
            self.assertEqual(set(parameters), {'Commit', 'Digest'})
            self.assertEqual(parameters['Commit'], [COMMIT])
            self.assertNotIn('SYNTHETIC_PRIVATE', output.getvalue() + (root / 'report.json').read_text())

    def test_uncertain_send_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            aws = FakeAWS(send_error=True)
            deployment = self.deployment(Path(directory), aws)
            with self.assertRaisesRegex(client.DeploymentError, 'SEND_UNCERTAIN_NO_COMMAND_ID'):
                deployment.run()
            self.assertEqual(sum(call[:2] == ('ssm', 'send-command') for call in aws.calls), 1)
            self.assertFalse(any(call[:2] == ('ssm', 'get-command-invocation') for call in aws.calls))
            self.assertTrue(deployment.report['sendAttempted'])
            self.assertIsNone(deployment.report['commandId'])

    def test_failed_remote_deployment_cannot_claim_public_success(self):
        with tempfile.TemporaryDirectory() as directory:
            checked = []
            deployment = self.deployment(Path(directory), FakeAWS(('Failed',)), public_check=checked.append)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(client.DeploymentError):
                deployment.run()
            self.assertEqual(checked, [])
            self.assertEqual(deployment.report['ssmStatus'], 'Failed')
            self.assertEqual(deployment.report['commandId'], COMMAND)

    def test_download_failure_stops_before_deploy_poll_or_public_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            checked, aws = [], FakeAWS(download_states=('Failed',))
            deployment = self.deployment(Path(directory), aws, public_check=checked.append)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(client.DeploymentError, 'REMOTE_DOWNLOAD_FAILED'):
                deployment.run()
            self.assertEqual(checked, [])
            polls = [call for call in aws.calls if call[:2] == ('ssm', 'get-command-invocation')]
            self.assertEqual(len(polls), 1)
            self.assertEqual(polls[0][polls[0].index('--plugin-name') + 1], 'DownloadRelease')

    def test_timeout_preserves_command_id_without_cancellation_or_second_send(self):
        with tempfile.TemporaryDirectory() as directory:
            clock, aws = Clock(), FakeAWS(('InProgress',))
            deployment = self.deployment(Path(directory), aws, clock=clock.now, sleep=clock.sleep, deadline=5)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(client.DeploymentError, 'REINSPECT_BEFORE_RETRY'):
                deployment.run()
            self.assertEqual(sum(call[:2] == ('ssm', 'send-command') for call in aws.calls), 1)
            self.assertEqual(sum(call[:2] == ('ssm', 'cancel-command') for call in aws.calls), 0)
            self.assertEqual(deployment.report['commandId'], COMMAND)
            self.assertEqual(deployment.report['pluginStatus']['DownloadRelease'], 'Success')
            self.assertEqual(deployment.report['pluginStatus']['DeployVerifiedRelease'], 'InProgress')

    def test_download_and_deploy_share_one_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            clock, aws = Clock(), FakeAWS(('InProgress',), download_states=('InProgress', 'Success'))
            deployment = self.deployment(Path(directory), aws, clock=clock.now, sleep=clock.sleep, deadline=10)
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(client.DeploymentError, 'REINSPECT_BEFORE_RETRY'):
                deployment.run()
            self.assertEqual(clock.value, 10)
            self.assertEqual(deployment.report['pluginStatus']['DownloadRelease'], 'Success')

    def test_existing_release_with_different_bytes_cannot_be_overwritten_or_deployed(self):
        with tempfile.TemporaryDirectory() as directory:
            aws = FakeAWS(existing={'ContentLength': 1, 'Metadata': {'sha256': 'f' * 64, 'commit': COMMIT}})
            deployment = self.deployment(Path(directory), aws)
            with self.assertRaisesRegex(client.DeploymentError, 'EXISTING_RELEASE_DIFFERS'):
                deployment.run()
            self.assertFalse(any(call[:2] == ('ssm', 'send-command') for call in aws.calls))


if __name__ == '__main__':
    unittest.main()
