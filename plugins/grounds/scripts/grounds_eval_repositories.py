#!/usr/bin/env python3
"""Freeze explicit local Git repositories for the existing read-only QA adapter.

This helper prepares bytes, not questions, Agents, experiments or knowledge edits.
Host paths live in a private binding file; the experiment binds a content digest.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import subprocess
import unicodedata

import grounds_eval_environment as env

FORMAT = 'grounds.repository-snapshot/v1'
PARAMETER = 'repository_snapshot'
BINDING_ENV = 'GROUNDS_PREPARE_REPOSITORIES'
SCRIPT = 'exec /usr/bin/python3 "$GROUNDS_ENV_HELPER" repositories'
MAX_FILES = 50000
MAX_BYTES = 256 * 1024 * 1024
OMIT = {'.git', '.grounds', '.patchledger', '.codex', '.agents', '__pycache__', 'node_modules'}


def git(root, *args):
    return subprocess.check_output(
        ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(root), *args],
        env={**{k: v for k, v in os.environ.items() if not k.startswith('GIT_')},
             'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'},
        stderr=subprocess.PIPE, timeout=30,
    )


def inventory(root, include_untracked):
    if Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() != root:
        raise ValueError('repository path must be its Git root')
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', head):
        raise ValueError('repository needs an existing HEAD')
    index = git(root, 'ls-files', '--stage', '-z')
    if any(record.startswith(b'160000 ') for record in index.split(b'\0')):
        raise ValueError('submodules are not supported')
    args = ['ls-files', '--cached', '-z']
    if include_untracked:
        args += ['--others', '--exclude-standard']
    paths = []
    names = {}
    for name in sorted(set(git(root, *args).decode('utf-8').split('\0')) - {''}):
        env.relative(name)
        parts = Path(name).parts
        if set(parts) & OMIT or any(p == '.env' or p.startswith('.env.') for p in parts):
            continue
        if name == '.gitmodules':
            raise ValueError('submodules are not supported')
        # Check index spelling before copying: case-insensitive filesystems can
        # otherwise collapse distinct Git paths before a manifest can see them.
        for length in range(1, len(parts) + 1):
            component = '/'.join(parts[:length])
            folded = unicodedata.normalize('NFC', component).casefold()
            if folded in names and names[folded] != component:
                raise ValueError('case or Unicode path collision')
            names[folded] = component
        # Tracked deletions are part of the current working tree snapshot.
        path = env.inside(root, name)
        if path.exists():
            paths.append(name)
    if len(paths) > MAX_FILES:
        raise ValueError('repository file count exceeds limit')
    return head, paths


def read_file(root, name):
    """Open every component without following links, including during a race."""
    env.relative(name)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(name).parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file = os.open(Path(name).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        with os.fdopen(file, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > env.LIMIT:
                raise ValueError('unsupported or oversized repository file: ' + name)
            data = stream.read(env.LIMIT + 1)
            after = os.fstat(stream.fileno())
            if len(data) > env.LIMIT or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('repository file changed during capture: ' + name)
            if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
                raise ValueError('Git LFS pointers are not supported')
            return data, bool(before.st_mode & 0o111)
    finally:
        os.close(descriptor)


def checked_manifest(root):
    """Bound snapshot reads before hashing; reject aliases and special files."""
    count = total = 0
    for path in root.rglob('*'):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ValueError('snapshot contains an unsupported file type')
        count += 1
        size = path.stat().st_size
        total += size
        if size > env.LIMIT or count > MAX_FILES or total > MAX_BYTES:
            raise ValueError('snapshot exceeds material limits')
    return env.manifest(root)


def snapshot(doc_repo, code_repos, out, include_untracked=False):
    roots = [('doc', 'doc', Path(doc_repo).resolve())]
    roots += [('code-' + str(i + 1), 'code', Path(path).resolve()) for i, path in enumerate(code_repos)]
    for i, (_, _, root) in enumerate(roots):
        if any(root.is_relative_to(other) or other.is_relative_to(root) for _, _, other in roots[:i]):
            raise ValueError('repository roots must not overlap')
    out = Path(out).resolve()
    if any(out.is_relative_to(root) or root.is_relative_to(out) for _, _, root in roots):
        raise ValueError('snapshot output must be outside source repositories')
    out.mkdir(mode=0o700)
    workspace = out / 'workspace'
    workspace.mkdir(mode=0o700)
    materials = []
    sources = []
    observations = []
    total = count = 0
    for identity, role, root in roots:
        before = inventory(root, include_untracked)
        destination = workspace / identity
        destination.mkdir()
        captured = {}
        for name in before[1]:
            data, executable = read_file(root, name)
            total += len(data)
            count += 1
            if count > MAX_FILES or total > MAX_BYTES:
                raise ValueError('snapshot exceeds material limits')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o555 if executable else 0o444)
            captured[name] = (env.digest(data), executable)
        materials.append({'id': identity, 'role': role, 'path': identity})
        sources.extend([
            {'kind': 'git', 'identity': 'local:' + identity, 'revision': before[0], 'role': role},
            {'kind': 'file', 'identity': 'working-tree:' + identity, 'revision': env.digest(checked_manifest(destination)), 'role': role},
        ])
        observations.append((root, before, captured))
    # Detect edits across the whole capture, not just while reading one file.
    for root, before, captured in observations:
        if inventory(root, include_untracked) != before:
            raise ValueError('repository HEAD or file set changed during capture')
        for name, expected in captured.items():
            data, executable = read_file(root, name)
            if (env.digest(data), executable) != expected:
                raise ValueError('repository content changed during capture: ' + name)
    record = {'format': FORMAT, 'materials': materials, 'sources': sources, 'manifest': checked_manifest(workspace)}
    identity = env.digest(record)
    env.save(out / 'snapshot.json', record)
    env.save(out / 'parameters.json', {PARAMETER: identity})
    env.save(out / 'bindings.json', {identity: str(out)})
    for path in [*out.rglob('*'), out]:
        path.chmod(path.stat().st_mode & ~0o222)
    return {'snapshot': identity, 'parameters': str(out / 'parameters.json'), 'bindings': str(out / 'bindings.json')}


def recipe(mode):
    roles = {'doc-only': ['doc'], 'doc-code': ['doc', 'code'], 'code': ['code']}[mode]
    return {
        'format': 'grounds.eval-environment/v1', 'name': 'repositories-' + mode,
        'task_kind': 'qa', 'role': 'answer',
        'parameters': {PARAMETER: {'type': 'string', 'required': True}, 'simulate_failure': {'type': 'boolean', 'required': False}},
        'script': {'interpreter': '/bin/sh', 'content': SCRIPT},
        'execution': {'backend': 'docker', 'timeout_seconds': 60, 'network_hosts': []},
        'access': {'read_roles': roles, 'kb': False, 'writable_workspace': False},
    }


def is_recipe(definition):
    return definition.get('script') == {'interpreter': '/bin/sh', 'content': SCRIPT}


def stage(definition, parameters, root):
    """Supervisor-only input staging; source paths never reach the child process."""
    access = definition['access']
    roles = set(access['read_roles'])
    if access['kb'] or access['writable_workspace'] or definition.get('skills') or definition['role'] != 'answer' or roles - {'doc', 'code'} or not roles or definition['execution']['network_hosts']:
        raise ValueError('repository recipe requires read-only local materials without KB, Skills or network')
    identity = parameters[PARAMETER]
    if not isinstance(identity, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', identity):
        raise ValueError('repository_snapshot must be a content digest')
    binding = os.environ.get(BINDING_ENV)
    if not binding:
        raise ValueError(BINDING_ENV + ' must name the private snapshot binding file')
    bindings = env.read(binding)
    if not isinstance(bindings, dict):
        raise ValueError('snapshot bindings must be an object')
    path = bindings.get(identity)
    if not isinstance(path, str) or not Path(path).is_absolute() or Path(path).is_symlink():
        raise ValueError('snapshot digest has no valid local binding')
    source = Path(path).resolve()
    record_path = env.inside(source, 'snapshot.json')
    if record_path.stat().st_size > env.LIMIT:
        raise ValueError('oversized snapshot record')
    record = env.read(record_path)
    env.fields(record, ('format', 'materials', 'sources', 'manifest'))
    if record['format'] != FORMAT or env.digest(record) != identity:
        raise ValueError('repository snapshot digest mismatch')
    workspace = env.inside(source, 'workspace')
    if checked_manifest(workspace) != record['manifest']:
        raise ValueError('repository snapshot files changed')
    # Validate the material contract using the existing environment validator.
    result = {'format': 'grounds.environment-preparation-result/v1', 'attempt_id': 'snapshot', 'status': 'success',
              'workspace': {'root': 'workspace', 'materials': record['materials']}, 'tools': [], 'sources': record['sources']}
    env.validate_result(result, source, 'snapshot')
    selected = [m for m in record['materials'] if m['role'] in roles]
    if {m['role'] for m in selected} != roles:
        raise ValueError('snapshot lacks a required material role')
    # Each material must be a distinct top-level directory; metadata stays outside it.
    if any(m['id'] != m['path'] or '/' in m['path'] for m in record['materials']):
        raise ValueError('snapshot materials must have distinct top-level paths')
    for material in selected:
        prefix = material['path'] + '/'
        destination = root / 'workspace' / material['path']
        destination.mkdir()
        for entry in record['manifest']:
            if not entry['path'].startswith(prefix):
                continue
            target = env.inside(root / 'workspace', entry['path'])
            if entry['kind'] == 'directory':
                target.mkdir(parents=True, exist_ok=True)
                continue
            data, executable = read_file(workspace, entry['path'])
            if len(data) != entry['size'] or env.digest(data) != entry['digest'] or executable != entry['executable']:
                raise ValueError('repository snapshot changed during staging')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o555 if executable else 0o444)
    result['workspace']['materials'] = selected
    result['sources'] = [s for s in record['sources'] if s['role'] in roles]
    result['sources'].append({'kind': 'file', 'identity': 'repository-snapshot', 'revision': identity, 'role': 'materials'})
    env.save(root / 'repository-input.json', result)


def prepare_result():
    request = env.read(os.environ['GROUNDS_ENV_INPUT'])
    if request['parameters'].get('simulate_failure'):
        result = {'format': 'grounds.environment-preparation-result/v1', 'attempt_id': request['attempt_id'],
                  'status': 'failed', 'error': {'stage': 'repository_fixture', 'message': 'controlled repository preparation failure'}}
    else:
        result = env.read(Path(os.environ['GROUNDS_ENV_ROOT']) / 'repository-input.json')
        result['attempt_id'] = request['attempt_id']
    env.save(request['result_path'], result)
    return 0 if result['status'] == 'success' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doc-repo', required=True)
    parser.add_argument('--code-repo', action='append', default=[])
    parser.add_argument('--include-untracked', action='store_true', help='include non-ignored untracked files, including new documents')
    parser.add_argument('--out', required=True, help='new private directory outside the repositories')
    args = parser.parse_args()
    import json
    print(json.dumps(snapshot(args.doc_repo, args.code_repo, args.out, args.include_untracked), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
