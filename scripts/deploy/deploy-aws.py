#!/usr/bin/env python3
"""Send one controlled SSM deployment, then verify the exact public UI bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import ssl
import subprocess
import tarfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

PACKAGE = runpy.run_path(str(Path(__file__).with_name('package-release.py')))
RUNTIME_FILES = PACKAGE['RUNTIME_FILES']
COMMIT_PATTERN = PACKAGE['COMMIT_PATTERN']
BUCKET = 'community-connect-deploy-814462560346-eu-west-2'
REGION = 'eu-west-2'
DOCUMENT = 'CommunityConnectDeploy'
PUBLIC_ORIGIN = 'https://community-connect-16-61-223-171.sslip.io'
COMMAND_PATTERN = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z')
NODE_PATTERN = re.compile(r'(?:mi-[0-9a-f]{17}|i-(?:[0-9a-f]{8}|[0-9a-f]{17}))\Z')
TERMINAL = {'Success', 'Cancelled', 'TimedOut', 'Failed'}
PENDING = {'Pending', 'InProgress', 'Delayed', 'Cancelling'}
PLUGINS = ('DownloadRelease', 'DeployVerifiedRelease')


class DeploymentError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class AwsError(DeploymentError):
    pass


class AwsCLI:
    def __init__(self, region):
        self.region = region

    def __call__(self, *args):
        try:
            result = subprocess.run(
                ['aws', '--region', self.region, '--no-cli-pager', *args, '--output', 'json'],
                capture_output=True, timeout=45, env={**os.environ, 'AWS_MAX_ATTEMPTS': '2'},
            )
        except (OSError, subprocess.SubprocessError):
            raise AwsError('AWS_REQUEST_UNCERTAIN') from None
        if result.returncode:
            # Never print AWS stderr or SSM stdout; either can contain host data.
            if b'InvocationDoesNotExist' in result.stderr:
                raise AwsError('INVOCATION_NOT_YET_VISIBLE')
            if b'PreconditionFailed' in result.stderr:
                raise AwsError('RELEASE_ALREADY_EXISTS')
            raise AwsError('AWS_REQUEST_FAILED')
        if len(result.stdout) > 1024 * 1024:
            raise AwsError('AWS_RESPONSE_LIMIT')
        try:
            payload = json.loads(result.stdout or b'{}')
            if not isinstance(payload, dict):
                raise ValueError('envelope')
            return payload
        except (ValueError, UnicodeError):
            raise AwsError('AWS_RESPONSE_INVALID') from None


def verify_archive(archive, commit):
    if not COMMIT_PATTERN.fullmatch(commit or ''):
        raise DeploymentError('COMMIT_INVALID')
    archive = Path(archive).resolve()
    if archive.stat().st_size > 8 * 1024 * 1024:
        raise DeploymentError('ARCHIVE_SIZE_LIMIT')
    files = {}
    total = 0
    with tarfile.open(archive, 'r:gz') as packed:
        for member in packed:
            if (len(files) >= 27 or member.name in files or not member.isfile()
                    or member.name not in {*RUNTIME_FILES, 'release.json'}
                    or member.size < 1 or member.size > 2 * 1024 * 1024):
                raise DeploymentError('ARCHIVE_ENTRY_INVALID')
            total += member.size
            if total > 8 * 1024 * 1024:
                raise DeploymentError('ARCHIVE_SIZE_LIMIT')
            files[member.name] = packed.extractfile(member).read(member.size + 1)
            if len(files[member.name]) != member.size:
                raise DeploymentError('ARCHIVE_ENTRY_INVALID')
    if set(files) != {*RUNTIME_FILES, 'release.json'}:
        raise DeploymentError('ARCHIVE_FILE_SET_INVALID')
    manifest = json.loads(files.pop('release.json'))
    if (not isinstance(manifest, dict) or set(manifest) != {'schema', 'commit', 'files'}
            or type(manifest['schema']) is not int or manifest['schema'] != 1
            or manifest['commit'] != commit or not isinstance(manifest['files'], dict)
            or set(manifest['files']) != set(RUNTIME_FILES)):
        raise DeploymentError('RELEASE_MANIFEST_INVALID')
    if any(hashlib.sha256(data).hexdigest() != manifest['files'][name] for name, data in files.items()):
        raise DeploymentError('RELEASE_CONTENT_INVALID')
    return manifest, hashlib.sha256(archive.read_bytes()).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_public(manifest):
    opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))

    def read(path, limit):
        request = Request(PUBLIC_ORIGIN + path, headers={'Cache-Control': 'no-cache', 'User-Agent': 'CommunityConnectDeploymentCheck/1'})
        try:
            with opener.open(request, timeout=20) as response:
                if response.status != 200 or response.geturl() != request.full_url:
                    raise DeploymentError('PUBLIC_HTTP_FAILED')
                body = response.read(limit + 1)
                if len(body) > limit:
                    raise DeploymentError('PUBLIC_RESPONSE_LIMIT')
                return body
        except (HTTPError, URLError, TimeoutError, OSError):
            raise DeploymentError('PUBLIC_HTTPS_FAILED') from None

    health = json.loads(read('/health', 4096))
    if not isinstance(health, dict) or health.get('status') != 'ok' or health.get('service') != 'community-connect-calling' or health.get('callHandling') != 'agent_gateway':
        raise DeploymentError('PUBLIC_HEALTH_IDENTITY_FAILED')
    for path, source in (('/agent', 'public/agent/index.html'), ('/agent/case-desk.mjs', 'public/agent/case-desk.mjs')):
        if hashlib.sha256(read(path, 2 * 1024 * 1024)).hexdigest() != manifest['files'][source]:
            raise DeploymentError('PUBLIC_UI_HASH_MISMATCH')


class Deployment:
    def __init__(self, archive, commit, instance_id, report, *, bucket=BUCKET, region=REGION,
                 aws=None, clock=time.monotonic, sleep=time.sleep, public_check=verify_public, deadline=900):
        if (bucket != BUCKET or region != REGION or not NODE_PATTERN.fullmatch(instance_id or '')
                or not COMMIT_PATTERN.fullmatch(commit or '')):
            raise DeploymentError('DEPLOYMENT_TARGET_INVALID')
        self.archive, self.commit, self.instance_id = Path(archive).resolve(), commit, instance_id
        self.bucket, self.region = bucket, region
        self.aws, self.clock, self.sleep = aws or AwsCLI(region), clock, sleep
        self.public_check, self.deadline = public_check, deadline
        self.report_path = Path(report).resolve()
        self.report = {'schema': 1, 'commit': commit, 'origin': PUBLIC_ORIGIN, 'result': 'PREPARING',
                       'commandId': None, 'ssmStatus': None, 'ssmPlugin': None,
                       'pluginStatus': {}, 'sendAttempted': False}

    def save(self):
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        self.report_path.write_text(json.dumps(self.report, sort_keys=True, indent=2) + '\n', encoding='utf8')

    def upload(self, digest):
        key = f'releases/{self.commit}/app.tar.gz'
        try:
            self.aws('s3api', 'put-object', '--bucket', self.bucket, '--key', key,
                     '--body', str(self.archive), '--server-side-encryption', 'AES256',
                     '--metadata', f'sha256={digest},commit={self.commit}', '--if-none-match', '*')
        except AwsError as error:
            if error.code != 'RELEASE_ALREADY_EXISTS':
                raise
            existing = self.aws('s3api', 'head-object', '--bucket', self.bucket, '--key', key)
            if (existing.get('Metadata', {}).get('sha256') != digest
                    or existing.get('Metadata', {}).get('commit') != self.commit
                    or existing.get('ContentLength') != self.archive.stat().st_size):
                raise DeploymentError('EXISTING_RELEASE_DIFFERS')

    def wait_for_command(self):
        stop_at = self.clock() + self.deadline
        for plugin in PLUGINS:
            self.report['ssmPlugin'] = plugin
            self.save()
            while self.clock() < stop_at:
                try:
                    invocation = self.aws('ssm', 'get-command-invocation', '--command-id', self.report['commandId'],
                                          '--instance-id', self.instance_id, '--plugin-name', plugin)
                except AwsError as error:
                    if error.code == 'INVOCATION_NOT_YET_VISIBLE':
                        self.sleep(5)
                        continue
                    raise DeploymentError('COMMAND_STATUS_UNCERTAIN') from None
                status = invocation.get('Status')
                if (invocation.get('CommandId') != self.report['commandId'] or invocation.get('InstanceId') != self.instance_id
                        or invocation.get('DocumentName') != DOCUMENT or invocation.get('PluginName') != plugin
                        or status not in TERMINAL | PENDING):
                    raise DeploymentError('COMMAND_STATUS_INVALID')
                if self.report['pluginStatus'].get(plugin) != status:
                    self.report['pluginStatus'][plugin] = status
                    self.report['ssmStatus'] = status
                    self.save()
                if status in TERMINAL:
                    if status != 'Success' or invocation.get('ResponseCode') != 0:
                        raise DeploymentError('REMOTE_DOWNLOAD_FAILED' if plugin == 'DownloadRelease' else 'REMOTE_DEPLOYMENT_FAILED')
                    break
                self.sleep(5)
            else:
                # This role intentionally cannot cancel unrelated project commands.
                # The command may continue; keep its ID and require reinspection.
                raise DeploymentError('COMMAND_TIMED_OUT_REINSPECT_BEFORE_RETRY')

    def run(self):
        try:
            manifest, digest = verify_archive(self.archive, self.commit)
            self.report['digest'] = digest
            self.save()
            self.upload(digest)
            self.report['sendAttempted'] = True
            self.report['result'] = 'COMMAND_REQUEST_ATTEMPTED'
            self.save()
            try:
                result = self.aws('ssm', 'send-command', '--document-name', DOCUMENT,
                                  '--instance-ids', self.instance_id, '--timeout-seconds', '60',
                                  '--parameters', json.dumps({'Commit': [self.commit], 'Digest': [digest]}),
                                  '--comment', f'Community Connect {self.commit}', '--max-concurrency', '1', '--max-errors', '0')
            except AwsError:
                raise DeploymentError('SEND_UNCERTAIN_NO_COMMAND_ID') from None
            command = result.get('Command', {}).get('CommandId')
            if not COMMAND_PATTERN.fullmatch(command or ''):
                raise DeploymentError('SEND_UNCERTAIN_NO_COMMAND_ID')
            self.report['commandId'] = command
            print(f'DEPLOY_COMMAND_ID {command}', flush=True)
            self.report['result'] = 'COMMAND_SUBMITTED'
            self.save()
            self.wait_for_command()
            self.public_check(manifest)
            self.report['result'] = 'DEPLOYED_AND_PUBLIC_UI_VERIFIED'
            self.save()
            return self.report
        except (DeploymentError, OSError, ValueError, tarfile.TarError) as error:
            self.report['result'] = 'FAILED_REINSPECT_BEFORE_RETRY' if self.report['sendAttempted'] else 'FAILED_BEFORE_COMMAND'
            self.report['failureCode'] = error.code if isinstance(error, DeploymentError) else 'LOCAL_VALIDATION_OR_REPORT_FAILED'
            try:
                self.save()
            except OSError:
                pass
            raise DeploymentError(self.report['failureCode']) from None


def write_summary(report):
    summary_path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not summary_path:
        return
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    run_url = f'https://github.com/{repository}/actions/runs/{run_id}' if repository == 'community-connect-lab/community-connect' and run_id.isdigit() else '(local run)'
    text = ('## AWS deployment\n\n'
            f"- Result: `{report['result']}`\n"
            f"- Commit: `{report['commit']}`\n"
            f'- Run: {run_url}\n'
            f"- SSM command: `{report.get('commandId') or 'not returned'}`\n"
            f"- SSM status: `{report.get('ssmStatus') or 'not observed'}`\n"
            f"- Download step: `{report.get('pluginStatus', {}).get('DownloadRelease', 'not observed')}`\n"
            f"- Deploy step: `{report.get('pluginStatus', {}).get('DeployVerifiedRelease', 'not observed')}`\n"
            f'- Agent: {PUBLIC_ORIGIN}/agent\n'
            '- Scope: service and exact public UI verification; no live Meta request or call.\n')
    if report['result'] != 'DEPLOYED_AND_PUBLIC_UI_VERIFIED':
        text += '- Inspect the saved SSM command before retrying. A timed-out command may still be running.\n'
    with Path(summary_path).open('a', encoding='utf8') as stream:
        stream.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--instance-id', required=True)
    parser.add_argument('--bucket', default=BUCKET)
    parser.add_argument('--region', default=REGION)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    deployment = None
    try:
        deployment = Deployment(args.archive, args.commit, args.instance_id, args.report, bucket=args.bucket, region=args.region)
        deployment.run()
        print('DEPLOY_SUCCESS: exact commit UI verified over public HTTPS.')
    except (DeploymentError, OSError, ValueError) as error:
        code = error.code if isinstance(error, DeploymentError) else 'LOCAL_VALIDATION_FAILED'
        print(f'DEPLOY_FAILED {code}')
        if deployment and deployment.report['commandId']:
            print(f"DEPLOY_COMMAND_ID {deployment.report['commandId']}")
        raise SystemExit(1) from None
    finally:
        if deployment:
            try:
                write_summary(deployment.report)
            except OSError:
                print('DEPLOY_SUMMARY_WRITE_FAILED')


if __name__ == '__main__':
    main()
