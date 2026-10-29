"""QA adapter for the public Grounds environment lifecycle.

Only fixed role inputs cross into Docker. Credentials must already be granted
by the host runtime; this adapter never registers grants or copies host secrets.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ADAPTER = {'name': 'grounds-env', 'version': '1', 'platform': 'docker'}
LIMIT = 16 * 1024 * 1024


def task_binding(value=None):
    if value is None:
        path = os.environ.get('GROUNDS_EVAL_ENVIRONMENT_TASK')
        if not path: raise ValueError('explicit GROUNDS_EVAL_ENVIRONMENT_TASK binding is required; trusted host cannot enforce evaluation material isolation')
        value = json.loads(Path(path).read_text())
    required = {'workspace', 'definition', 'input_commit', 'branch'}
    allowed = required | {'dev_run', 'credential_env', 'build_inputs'}
    if not isinstance(value, dict) or required - set(value) or set(value) - allowed:
        raise ValueError('environment_task requires workspace, definition, input_commit and branch')
    if any(not isinstance(value[k], str) or not value[k] for k in required): raise ValueError('invalid environment_task binding')
    if not Path(value['workspace']).is_absolute(): raise ValueError('environment_task workspace must be absolute')
    mapping = value.get('credential_env', {})
    if not isinstance(mapping, dict): raise ValueError('credential_env must map variable names to granted private file paths')
    for name, path in mapping.items():
        if not name.replace('_', '').isalnum() or name in ('HOME', 'PATH', 'CODEX_HOME') or not isinstance(path, str) or not path.startswith('/credentials/') or '..' in Path(path).parts:
            raise ValueError('invalid private credential reference')
    return dict(value)


def validate_task_tree(binding):
    """The QA runner repository may expose only explicitly bound build inputs.

    Role materials are separately checked and delivered as fixed inputs. A full
    development clone containing other tasks or Graders is refused, never cut
    down or rewritten by the environment.
    """
    root = Path(binding['workspace'])
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *args], text=True).strip()
    commit = binding['input_commit'].removeprefix('sha1:')
    if git('rev-parse', 'HEAD') != commit or git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('evaluation task repository must be clean at the explicitly bound commit')
    allowed = binding.get('build_inputs', ['.grounds/environments/' + binding['definition'] + '.yaml', 'Dockerfile'])
    if not isinstance(allowed, list) or not allowed or any(not isinstance(p, str) or Path(p).is_absolute() or '..' in Path(p).parts for p in allowed):
        raise ValueError('build_inputs must explicitly name non-sensitive runner recipe files')
    declared = '.grounds/environments/' + binding['definition'] + '.yaml'
    actual = set(git('ls-tree', '-r', '--name-only', commit).splitlines())
    if declared not in allowed or actual != set(allowed):
        raise ValueError('QA task tree differs from the allowed runner build inputs; prepare a role-scoped task repository, do not expose a development clone')
    for name in actual:
        mode = git('ls-tree', commit, '--', name).split()[0]
        if mode not in ('100644', '100755'): raise ValueError('runner input must be a regular file')
    return {'commit': commit, 'build_inputs': sorted(actual)}


def cli(*args):
    command = [os.environ.get('GROUNDS_BIN') or shutil.which('grounds') or 'grounds', 'env', *args, '--json']
    result = subprocess.run(command, text=True, capture_output=True)
    try: envelope = json.loads(result.stdout)
    except ValueError: raise ValueError('environment CLI returned no structured receipt; preserve operation and inspect runtime') from None
    if result.returncode or not envelope.get('ok'): raise ValueError('environment operation failed: ' + json.dumps(envelope.get('error', {}), ensure_ascii=False))
    return envelope['data']


def pack(root, target):
    total = 0
    with tarfile.open(target, 'w:gz') as archive:
        for path in sorted(Path(root).rglob('*')):
            if path.is_symlink() or not (path.is_file() or path.is_dir()): raise ValueError('task input contains a link or special file')
            if path.is_file():
                total += path.stat().st_size
                if total > LIMIT: raise ValueError('explicit evaluation inputs exceed the 16 MiB environment handoff limit')
            archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
    if Path(target).stat().st_size > LIMIT: raise ValueError('evaluation handoff exceeds environment limit')


def unpack(source, root):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    total = 0; names = set()
    with tarfile.open(source, 'r:gz') as archive:
        for entry in archive.getmembers():
            path = Path(entry.name)
            if path.is_absolute() or '..' in path.parts or entry.name in names or not (entry.isfile() or entry.isdir()):
                raise ValueError('unsafe evaluation handoff member')
            names.add(entry.name); total += entry.size
            if total > LIMIT: raise ValueError('evaluation handoff exceeds limit')
            target = root / path
            if entry.isdir(): target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as stream: target.write_bytes(stream.read())
                target.chmod(0o700 if entry.mode & 0o111 else 0o600)


def execute(binding, operation, request, assets, destination, timeout, requires_network=False, before_run=None):
    binding = task_binding(binding); scope = validate_task_tree(binding); destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Persist dispatch inputs before launching. Existing receipts never re-run a model.
    receipt = destination / 'environment-dispatch.json'
    if receipt.exists(): raise ValueError('environment dispatch already exists; inspect retained receipt, do not automatically relaunch')
    work = destination / 'runtime-input'; work.mkdir(mode=0o700)
    scripts = work / 'scripts'; scripts.mkdir()
    for source in Path(__file__).parent.glob('grounds_eval_*.py'): shutil.copyfile(source, scripts / source.name)
    for name, source in assets.items():
        if Path(name).is_absolute() or '..' in Path(name).parts: raise ValueError('invalid input asset name')
        source = Path(source); target = work / 'assets' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir(): shutil.copytree(source, target, symlinks=True)
        else: shutil.copyfile(source, target, follow_symlinks=False)
    (work / 'request.json').write_text(json.dumps({'operation': operation, 'request': request, 'credential_env': binding.get('credential_env', {})}))
    bundle = destination / 'task-input.tar.gz'; pack(work, bundle)
    fixed = destination / 'fixed-inputs.json'; fixed.write_text(json.dumps([{'name': 'eval-task.tar.gz', 'path': str(bundle.resolve())}]))
    args = ['up', '--workspace', binding['workspace'], '--definition', binding['definition'], '--input-commit', binding['input_commit'], '--branch', binding['branch'], '--material-scope', 'blind', '--fixed-inputs-file', str(fixed.resolve())]
    if binding.get('dev_run'): args += ['--dev-run', binding['dev_run']]
    prepared = cli(*args)['environment']
    receipt.write_text(json.dumps({'binding': binding, 'environment': prepared, 'state': 'prepared'}))
    if prepared['backend'] != 'docker' or prepared.get('trust') != 'container': raise ValueError('evaluation requires Docker; prepared environment retained')
    if before_run: before_run(prepared)
    bootstrap = "import sys,tarfile,pathlib; p=pathlib.Path('/tmp/grounds-eval-task'); p.mkdir(); a=tarfile.open('/inputs/eval-task.tar.gz'); members=a.getmembers(); assert all(not m.name.startswith('/') and '..' not in pathlib.Path(m.name).parts and (m.isfile() or m.isdir()) for m in members); assert sum(m.size for m in members)<=16777216; a.extractall(p, members=members); sys.path.insert(0,str(p/'scripts')); import grounds_eval_runtime as r; r.worker(p)"
    argv = destination / 'argv.json'; argv.write_text(json.dumps(['python3', '-c', bootstrap]))
    receipt.write_text(json.dumps({'binding': binding, 'environment': prepared, 'state': 'launch_intent'}))
    run = cli('run', prepared['id'], '--argv-file', str(argv.resolve()), '--timeout-seconds', str(max(1, int(timeout))), '--artifact', 'eval-result.tar.gz', *(['--requires-network'] if requires_network else []))['run']
    receipt.write_text(json.dumps({'binding': binding, 'environment': prepared, 'run': run, 'state': 'executed'}))
    if run['state'] != 'succeeded': raise ValueError('evaluation task did not succeed; environment and inputs retained: ' + prepared['id'])
    released = cli('down', prepared['id'])
    final = released.get('environment', prepared)
    directory = final.get('directory') or prepared.get('directory')
    if not directory: raise ValueError('environment receipt has no artifact directory; inspect retained runtime receipt')
    artifact = Path(directory) / 'artifacts' / 'eval-result.tar.gz'
    unpack(artifact, destination / 'result')
    receipt.write_text(json.dumps({'binding': binding, 'environment': final, 'run': run, 'state': 'released', 'artifact': str(artifact)}))
    result = json.loads((destination / 'result' / 'result.json').read_text())
    if result.get('error'): raise ValueError('evaluation worker failed: ' + result['error'])
    return destination / 'result', result


def worker(root):
    if not Path('/.dockerenv').exists(): raise ValueError('evaluation worker requires the unified Docker task')
    payload = json.loads((root / 'request.json').read_text()); request = payload['request']
    for name, path in payload.get('credential_env', {}).items(): os.environ[name] = Path(path).read_text().strip()
    output = Path('/tmp/grounds-eval-result'); output.mkdir()
    try:
        if payload['operation'] == 'preflight':
            import grounds_eval_capture as capture
            value = capture.preflight(output / 'preflight')
        elif payload['operation'] == 'prepare':
            import grounds_eval_environment as environment
            staged = root / 'assets' / 'staged'
            if staged.exists(): os.environ['GROUNDS_EVAL_STAGED_INPUT'] = str(staged)
            value = environment._prepare_in_task(request['definition'], request['parameters'], output / 'workspace-root', output / 'evidence', request['attempt_id'])
            value['root'] = 'workspace-root'
        elif payload['operation'] == 'capture':
            import grounds_eval_capture as capture
            config = request['config']; config.pop('environment_task', None)
            (root / 'config.json').write_text(json.dumps(config))
            environment = request.get('environment')
            if environment:
                environment['workspace'] = str(root / 'assets' / 'materials')
                environment['ready'] = lambda *_: None
                environment['launch'] = lambda: None
                environment['collected'] = lambda *_: {}
            value = capture._run_in_task(root / 'config.json', root / 'assets' / 'packet.json', output / 'capture', request['grading'], environment=environment)
        else: raise ValueError('unknown evaluation task operation')
    except Exception as error: value = {'error': type(error).__name__ + ': ' + str(error)}
    (output / 'result.json').write_text(json.dumps(value))
    pack(output, Path(os.environ.get('GROUNDS_OUTPUT_DIRECTORY', '/output')) / 'eval-result.tar.gz')
