#!/usr/bin/env python3
"""Package a reviewed main-history commit, never the runner's working files."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

RUNTIME_FILES = tuple(sorted((
    'calling-server.mjs', 'package.json', 'package-lock.json', 'public/workflow.mjs',
    'lib/calling-api.mjs', 'lib/calling-state.mjs', 'lib/case-draft.mjs',
    'lib/case-export.mjs', 'lib/case-service.mjs', 'lib/config.mjs',
    'lib/meta-api.mjs', 'lib/scenario.mjs', 'lib/transcription.mjs',
    'lib/whatsapp-webhook.mjs', 'public/agent/app.mjs',
    'public/agent/audio-capture.mjs', 'public/agent/case-desk.mjs',
    'public/agent/index.html', 'public/agent/pcm-capture-worklet.mjs',
    'public/agent/styles.css', 'public/agent/working-copy.mjs',
    'assets/meta-app-icon.svg', 'assets/fonts/NotoSans-Regular.ttf',
    'assets/fonts/OFL.txt', 'scripts/check-api.mjs', 'scripts/check-transcription.mjs',
)))
COMMIT_PATTERN = re.compile(r'[0-9a-f]{40}\Z')
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024


class ReleaseError(Exception):
    pass


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, timeout=30)
    if result.returncode:
        raise ReleaseError('GIT_VALIDATION_FAILED')
    return result.stdout


def resolve_commit(repo, requested, default_commit, main_ref='refs/remotes/origin/main'):
    commit = requested or default_commit
    if not COMMIT_PATTERN.fullmatch(commit or ''):
        raise ReleaseError('FULL_COMMIT_SHA_REQUIRED')
    if git(repo, 'cat-file', '-t', commit).strip() != b'commit':
        raise ReleaseError('COMMIT_REQUIRED')
    git(repo, 'merge-base', '--is-ancestor', commit, main_ref)
    return commit


def read_runtime(repo, commit):
    result = {}
    total = 0
    for path in RUNTIME_FILES:
        entry = git(repo, 'ls-tree', commit, '--', path).decode('utf8').strip()
        parts = entry.split('\t', 1)
        if len(parts) != 2 or parts[1] != path or not parts[0].startswith('100644 blob '):
            raise ReleaseError('RUNTIME_REGULAR_FILE_REQUIRED')
        size = int(git(repo, 'cat-file', '-s', f'{commit}:{path}'))
        total += size
        if size < 1 or size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise ReleaseError('RUNTIME_SIZE_LIMIT')
        data = git(repo, 'show', f'{commit}:{path}')
        if len(data) != size:
            raise ReleaseError('RUNTIME_SIZE_MISMATCH')
        result[path] = data
    return result


def package_release(repo, commit, output):
    files = read_runtime(repo, commit)
    manifest = {
        'schema': 1,
        'commit': commit,
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    files['release.json'] = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode('utf8')
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as packed:
                for name, data in sorted(files.items()):
                    item = tarfile.TarInfo(name)
                    item.mode = 0o644
                    item.size = len(data)
                    item.mtime = item.uid = item.gid = 0
                    packed.addfile(item, io.BytesIO(data))
    return {'schema': 1, 'commit': commit, 'digest': hashlib.sha256(output.read_bytes()).hexdigest(),
            'archive': str(output), 'bytes': output.stat().st_size, 'runtimeFiles': len(RUNTIME_FILES)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--commit', default='')
    parser.add_argument('--default-commit', required=True)
    parser.add_argument('--resolve-only', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        commit = resolve_commit(args.repo, args.commit, args.default_commit)
        if args.resolve_only:
            print(commit)
        else:
            if args.output is None:
                raise ReleaseError('OUTPUT_REQUIRED')
            print(json.dumps(package_release(args.repo, commit, args.output), sort_keys=True))
    except (ReleaseError, OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, 'RELEASE_PACKAGE_FAILED: commit, main ancestry and runtime files must validate.\n')


if __name__ == '__main__':
    main()
