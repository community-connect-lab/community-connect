#!/usr/bin/env python3
"""Trusted root deployment helper; uploaded code runs only as the app user.

Usage: community-connect-deploy COMMIT40 SHA256
Credentials, service configuration and Caddy configuration remain on the host.
The busy probe refuses all owned desks, including idle Ready desks. Operators
must disconnect and save work before deployment; the external probe cannot make
the application's in-memory readiness check atomic with stopping the service.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid

APP = Path('/opt/community-connect/app')
RELEASES = Path('/opt/community-connect/releases')
STATE = Path('/var/lib/community-connect-deploy')
NODE = Path('/opt/community-connect/node/bin/node')
NPM = Path('/opt/community-connect/node/bin/npm')
BACKEND_ENV = Path('/etc/community-connect/backend.env')
SERVICE = 'community-connect'
LEGACY = RELEASES / 'legacy-before-github'
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_CONTENT_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
RUNTIME_FILES = frozenset({
    'assets/fonts/NotoSans-Regular.ttf', 'assets/fonts/OFL.txt',
    'assets/meta-app-icon.svg', 'calling-server.mjs', 'lib/calling-api.mjs',
    'lib/calling-state.mjs', 'lib/case-draft.mjs', 'lib/case-export.mjs',
    'lib/case-service.mjs', 'lib/config.mjs', 'lib/meta-api.mjs',
    'lib/scenario.mjs', 'lib/transcription.mjs', 'lib/whatsapp-webhook.mjs',
    'package-lock.json', 'package.json', 'public/agent/app.mjs',
    'public/agent/audio-capture.mjs', 'public/agent/case-desk.mjs',
    'public/agent/index.html', 'public/agent/pcm-capture-worklet.mjs',
    'public/agent/styles.css', 'public/agent/working-copy.mjs',
    'public/workflow.mjs', 'scripts/check-api.mjs', 'scripts/check-transcription.mjs',
})


class DeployError(Exception):
    """Only fixed diagnostic identifiers may be printed."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise DeployError(code)


def log(status: str, **metadata: str) -> None:
    print(json.dumps({'status': status, **metadata}, sort_keys=True), flush=True)


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def incoming_archive(commit: str) -> Path:
    # aws:downloadContent treats a nonexistent destinationPath as a filename.
    # Keep that filename explicit and identical to the SSM document contract.
    return STATE / 'incoming' / f'{commit}.tar.gz'


def validate_archive(path: Path, commit: str, digest: str) -> tuple[dict, dict[str, bytes]]:
    """Validate every byte/path before creating any release files."""
    require(bool(re.fullmatch(r'[a-f0-9]{40}', commit)), 'INVALID_COMMIT')
    require(bool(re.fullmatch(r'[a-f0-9]{64}', digest)), 'INVALID_DIGEST')
    require(path.is_file() and not path.is_symlink(), 'ARCHIVE_NOT_REGULAR')
    require(path.stat().st_size <= MAX_ARCHIVE_BYTES, 'ARCHIVE_TOO_LARGE')
    require(digest_bytes(path.read_bytes()) == digest, 'ARCHIVE_DIGEST_MISMATCH')
    expected = RUNTIME_FILES | {'release.json'}
    contents: dict[str, bytes] = {}
    total = 0
    try:
        with tarfile.open(path, mode='r:gz') as archive:
            for member in archive:
                require(member.name in expected and member.name not in contents, 'ARCHIVE_PATH_INVALID')
                require(member.isreg() and not member.issparse(), 'ARCHIVE_TYPE_INVALID')
                require(0 <= member.size <= MAX_FILE_BYTES, 'ARCHIVE_FILE_TOO_LARGE')
                total += member.size
                require(total <= MAX_CONTENT_BYTES, 'ARCHIVE_CONTENT_TOO_LARGE')
                source = archive.extractfile(member)
                require(source is not None, 'ARCHIVE_FILE_UNREADABLE')
                data = source.read(member.size + 1)
                require(len(data) == member.size, 'ARCHIVE_SIZE_INVALID')
                contents[member.name] = data
        require(set(contents) == expected, 'ARCHIVE_FILE_SET_INVALID')
        require(len(contents['release.json']) <= 65536, 'MANIFEST_TOO_LARGE')
        manifest = json.loads(contents['release.json'].decode('utf-8'))
        require(isinstance(manifest, dict) and set(manifest) == {'schema', 'commit', 'files'}, 'MANIFEST_INVALID')
        require(type(manifest['schema']) is int and manifest['schema'] == 1 and manifest['commit'] == commit, 'MANIFEST_COMMIT_INVALID')
        require(isinstance(manifest['files'], dict) and set(manifest['files']) == RUNTIME_FILES, 'MANIFEST_FILES_INVALID')
        for name, expected_digest in manifest['files'].items():
            require(isinstance(expected_digest, str) and bool(re.fullmatch(r'[a-f0-9]{64}', expected_digest)), 'MANIFEST_HASH_INVALID')
            require(digest_bytes(contents[name]) == expected_digest, 'FILE_DIGEST_MISMATCH')
        return manifest, contents
    except DeployError:
        raise
    except (tarfile.TarError, OSError, ValueError, KeyError, UnicodeError):
        raise DeployError('ARCHIVE_INVALID') from None


def capture(command: list[str], *, cwd: Path | None = None, timeout: int = 30) -> str:
    """Discard child diagnostics so provider/npm content cannot enter SSM logs."""
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env={'PATH': '/opt/community-connect/node/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
                               start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            process.communicate()
        raise
    require(process.returncode == 0, 'HOST_COMMAND_FAILED')
    require(len(output) <= 2 * 1024 * 1024, 'HOST_OUTPUT_TOO_LARGE')
    return output.decode('utf-8', errors='strict').strip()


def service_active() -> bool:
    result = subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', SERVICE],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    return result.returncode == 0


def refuse_owned_desk() -> None:
    if not service_active():
        return  # A stopped process cannot retain a live in-memory call.
    # Native Node parses the existing private .env; neither token nor state is
    # returned to Python/SSM. A fresh ID cannot claim or renew the operator desk.
    probe = r'''
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
try {
 const key=parseEnv(readFileSync('/etc/community-connect/backend.env','utf8')).AGENT_ACCESS_TOKEN;
 if(typeof key!=='string'||key.length<32) process.exit(2);
 const response=await fetch('http://127.0.0.1:10000/agent/api/state',{redirect:'manual',headers:{Authorization:`Bearer ${key}`,'X-Agent-ID':`deployment-${randomUUID()}`},signal:AbortSignal.timeout(5000)});
 if(response.status!==200) process.exit(2);
 const text=await response.text(); if(text.length>65536) process.exit(2);
 const state=JSON.parse(text);
 if(state.busy!==false||state.ready!==false||state.call!==null) process.exit(3);
 console.log('DESK_UNOWNED');
} catch { process.exit(2); }
'''
    try:
        require(capture([str(NODE), '--input-type=module', '-e', probe], timeout=8) == 'DESK_UNOWNED', 'DESK_CHECK_FAILED')
    except (DeployError, subprocess.TimeoutExpired):
        raise DeployError('DESK_BUSY_OR_UNVERIFIED_DISCONNECT_AND_SAVE_WORK') from None


def prepare_release(contents: dict[str, bytes], manifest: dict, commit: str, uid: int, gid: int) -> Path:
    target = RELEASES / commit
    if target.exists() or target.is_symlink():
        require(target.is_dir() and not target.is_symlink() and target.stat().st_uid == 0, 'EXISTING_RELEASE_UNSAFE')
        verify_release_files(target, manifest)
        require((target / 'node_modules').is_dir(), 'EXISTING_RELEASE_INCOMPLETE')
        return target
    stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=RELEASES))
    try:
        for name, data in contents.items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(data)
            destination.chmod(0o644)
        for directory, folders, files in os.walk(stage):
            os.chown(directory, uid, gid)
            os.chmod(directory, 0o755)
            for name in files:
                os.chown(Path(directory) / name, uid, gid, follow_symlinks=False)
        capture(['/usr/sbin/runuser', '-u', 'community-connect', '--', str(NPM), 'ci',
                 '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=stage, timeout=300)
        verify_release_files(stage, manifest)
        # Seal published code after npm has run unprivileged. Do not follow npm's
        # .bin symlinks while changing ownership or permissions.
        for directory, folders, files in os.walk(stage, followlinks=False):
            os.chown(directory, 0, gid)
            os.chmod(directory, 0o755)
            for name in folders + files:
                path = Path(directory) / name
                os.chown(path, 0, gid, follow_symlinks=False)
                if not path.is_symlink():
                    path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o022)
        stage.rename(target)
        return target
    finally:
        if stage.exists():
            require(stage.parent == RELEASES and stage.name.startswith('.stage-'), 'STAGE_CLEANUP_REFUSED')
            shutil.rmtree(stage)


def verify_release_files(target: Path, manifest: dict) -> None:
    require(not (target / 'release.json').is_symlink(), 'RELEASE_MARKER_INVALID')
    require(json.loads((target / 'release.json').read_text(encoding='utf-8')) == manifest, 'RELEASE_MARKER_INVALID')
    for name, digest in manifest['files'].items():
        path = target / name
        require(path.is_file() and not path.is_symlink() and digest_bytes(path.read_bytes()) == digest, 'INSTALLED_FILE_DIGEST_MISMATCH')


def previous_target() -> tuple[Path, bool]:
    if APP.is_symlink():
        target = APP.resolve(strict=True)
        require(target.parent == RELEASES and target.is_dir() and not target.is_symlink(), 'APP_LINK_UNSAFE')
        require(target == LEGACY or bool(re.fullmatch(r'[a-f0-9]{40}', target.name)), 'APP_LINK_UNSAFE')
        return target, False
    require(APP.is_dir() and not LEGACY.exists() and not LEGACY.is_symlink(), 'LEGACY_APP_UNSAFE')
    return LEGACY, True


def atomic_link(target: Path) -> None:
    temporary = APP.parent / f'.app-link-{uuid.uuid4().hex}'
    try:
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, APP)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def local_body(path: str, limit: int = 1024 * 1024) -> bytes:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open('http://127.0.0.1:10000' + path, timeout=3) as response:
        require(response.status == 200, 'HEALTH_HTTP_FAILED')
        body = response.read(limit + 1)
        require(len(body) <= limit, 'HEALTH_BODY_TOO_LARGE')
        return body


def check_health(target: Path, manifest: dict | None) -> None:
    last_error = None
    for attempt in range(20):
        try:
            require(service_active(), 'SERVICE_NOT_ACTIVE')
            health = json.loads(local_body('/health', 4096))
            require(health.get('status') == 'ok' and health.get('service') == 'community-connect-calling'
                    and health.get('callHandling') == 'agent_gateway', 'HEALTH_IDENTITY_INVALID')
            pid = capture(['/usr/bin/systemctl', 'show', '--property=MainPID', '--value', SERVICE], timeout=5)
            require(bool(re.fullmatch(r'[1-9][0-9]*', pid)), 'SERVICE_PID_INVALID')
            require(Path(f'/proc/{pid}/cwd').resolve(strict=True) == target.resolve(strict=True), 'RUNNING_RELEASE_INVALID')
            if manifest is not None:
                verify_release_files(target, manifest)
                for endpoint, filename in [('/agent', 'public/agent/index.html'),
                                           ('/agent/app.mjs', 'public/agent/app.mjs'),
                                           ('/agent/case-desk.mjs', 'public/agent/case-desk.mjs')]:
                    require(digest_bytes(local_body(endpoint)) == manifest['files'][filename], 'SERVED_ASSET_DIGEST_MISMATCH')
            return
        except Exception as error:
            last_error = error
            if attempt < 19:
                time.sleep(0.5)
    raise DeployError('POST_RESTART_HEALTH_FAILED') from last_error


def write_state(data: dict) -> None:
    temporary = STATE / f'.state-{uuid.uuid4().hex}'
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(data, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, STATE / 'current.json')
    finally:
        if temporary.exists():
            temporary.unlink()


def activate_release(target: Path, manifest: dict, prior: Path, is_legacy: bool,
                     commit: str, digest: str, prior_manifest: dict | None) -> None:
    switched = False
    stop_attempted = False
    try:
        # A timed-out stop might already have stopped the worker: recovery must
        # cover the attempt, not only a successful CLI response.
        stop_attempted = True
        capture(['/usr/bin/systemctl', 'stop', SERVICE], timeout=20)
        if is_legacy:
            APP.rename(LEGACY)
        atomic_link(target)
        switched = True
        capture(['/usr/bin/systemctl', 'start', SERVICE], timeout=20)
        check_health(target, manifest)
        write_state({'schema': 1, 'commit': commit, 'digest': digest,
                     'current': str(target), 'previous': str(prior), 'verified': True})
        log('DEPLOYMENT_SUCCEEDED', commit=commit)
    except BaseException:
        if stop_attempted:
            try:
                capture(['/usr/bin/systemctl', 'stop', SERVICE], timeout=20)
                if switched or (is_legacy and LEGACY.exists() and not APP.exists()):
                    atomic_link(prior)
                capture(['/usr/bin/systemctl', 'start', SERVICE], timeout=20)
                restored = prior if switched or APP.is_symlink() else APP
                check_health(restored, prior_manifest)
                write_state({'schema': 1, 'commit': prior_manifest['commit'] if prior_manifest else 'legacy',
                             'current': str(restored), 'verified': True, 'rolledBackFrom': commit})
                log('DEPLOYMENT_ROLLED_BACK', commit=commit)
            except BaseException:
                raise DeployError('DEPLOYMENT_FAILED_ROLLBACK_UNCONFIRMED') from None
        raise DeployError('DEPLOYMENT_FAILED_PREVIOUS_RELEASE_RESTORED' if stop_attempted else 'DEPLOYMENT_FAILED_BEFORE_SWITCH') from None


def deploy(commit: str, digest: str) -> None:
    import fcntl
    import pwd
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(bool(re.fullmatch(r'[a-f0-9]{40}', commit)) and bool(re.fullmatch(r'[a-f0-9]{64}', digest)), 'ARGUMENTS_INVALID')
    require(STATE.is_dir() and RELEASES.is_dir(), 'HELPER_NOT_INSTALLED')
    require(STATE.stat().st_uid == 0 and RELEASES.stat().st_uid == 0, 'HOST_DIRECTORY_UNSAFE')
    with (STATE / 'deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError('ANOTHER_DEPLOYMENT_IS_RUNNING') from None
        work = Path(tempfile.mkdtemp(prefix='work-', dir=STATE))
        try:
            # Copy before hashing: later SSM downloads cannot mutate this snapshot.
            incoming = incoming_archive(commit)
            require(incoming.parent.is_dir() and not incoming.parent.is_symlink()
                    and incoming.parent.stat().st_uid == 0, 'INCOMING_DIRECTORY_UNSAFE')
            descriptor = os.open(incoming, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as source, (work / 'app.tar.gz').open('xb') as output:
                source_info = os.fstat(source.fileno())
                require(stat.S_ISREG(source_info.st_mode) and source_info.st_uid == 0, 'ARCHIVE_NOT_REGULAR')
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    require(size <= MAX_ARCHIVE_BYTES, 'ARCHIVE_TOO_LARGE')
                    output.write(chunk)
            manifest, contents = validate_archive(work / 'app.tar.gz', commit, digest)
            refuse_owned_desk()
            account = pwd.getpwnam('community-connect')
            target = prepare_release(contents, manifest, commit, account.pw_uid, account.pw_gid)
            prior, is_legacy = previous_target()
            if not is_legacy and prior == target:
                check_health(target, manifest)
                log('ALREADY_DEPLOYED', commit=commit)
                return
            refuse_owned_desk()
            prior_manifest = None if is_legacy or prior == LEGACY else json.loads((prior / 'release.json').read_text(encoding='utf-8'))
            activate_release(target, manifest, prior, is_legacy, commit, digest, prior_manifest)
        finally:
            require(work.parent == STATE and work.name.startswith('work-'), 'WORK_CLEANUP_REFUSED')
            shutil.rmtree(work)


def main() -> int:
    if len(sys.argv) != 3:
        log('ARGUMENTS_INVALID')
        return 2
    # A normal SSM cancellation enters rollback if the switch has started.
    def interrupted(_number, _frame):
        raise DeployError('DEPLOYMENT_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        deploy(sys.argv[1], sys.argv[2])
        return 0
    except DeployError as error:
        log(str(error))
    except BaseException as error:
        log('DEPLOYMENT_FAILED_WITHOUT_PRIVATE_DIAGNOSTICS', errorType=type(error).__name__)
    return 1


if __name__ == '__main__':
    sys.exit(main())
