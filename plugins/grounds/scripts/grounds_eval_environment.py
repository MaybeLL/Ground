#!/usr/bin/env python3
"""Deterministic environment preparation and file evidence; never starts an Agent."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import unicodedata
from urllib.parse import unquote

ADAPTER = {'name': 'grounds-env', 'version': '1', 'platform': 'docker'}
LIMIT = 32 * 1024 * 1024
SKILL_NAME = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')


def canonical(value):
    def normalize(v):
        if isinstance(v, float) and v.is_integer(): return int(v)
        if isinstance(v, dict): return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list): return [normalize(x) for x in v]
        return v
    return json.dumps(normalize(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


def save(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.pending')
    with temporary.open('w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, path)
    directory=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)


def read(path):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out: raise ValueError('duplicate JSON key')
            out[key] = value
        return out
    return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid JSON number')))


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value or any(x in ('', '.', '..') for x in value.split('/')) or value.startswith('/'):
        raise ValueError('unsafe relative path')
    return value


def inside(root, relative_path):
    root = Path(root).resolve(); path = root / relative(relative_path)
    for parent in [path, *path.parents]:
        if parent == root: break
        if parent.is_symlink(): raise ValueError('symlink not supported')
    if not path.resolve().is_relative_to(root): raise ValueError('path outside managed root')
    return path


def manifest(root):
    root = Path(root).resolve(); entries = []; names = set()
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix(); folded = unicodedata.normalize('NFC', name).casefold()
        if folded in names: raise ValueError('case or Unicode path collision')
        names.add(folded); mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)): raise ValueError('unsupported file type: ' + name)
        entry = {'path': name, 'kind': 'directory' if path.is_dir() else 'file', 'executable': bool(mode & 0o111)}
        if path.is_file():
            data = path.read_bytes()
            if data.startswith(b'version https://git-lfs.github.com/spec/v1'): raise ValueError('Git LFS is not supported')
            entry.update(size=len(data), digest=digest(data))
        entries.append(entry)
    return entries


def evidence_files(root, names):
    result = []
    for name in names:
        path = inside(root, name)
        if not path.is_file() or path.stat().st_size > LIMIT: raise ValueError('invalid evidence file')
        result.append({'name': name, 'size': path.stat().st_size, 'digest': digest(path.read_bytes())})
    return result


def fields(value, required, optional=()):
    if not isinstance(value,dict) or set(value)-set(required)-set(optional) or set(required)-set(value): raise ValueError('invalid result fields')


def nonempty(value):
    if not isinstance(value,str) or not value.strip() or len(value.encode())>65536: raise ValueError('invalid result text')
    return value


def preparation_contract_digest(definition, parameters, adapter=ADAPTER):
    return digest({'script': definition['script'], 'execution': definition['execution'],
                   'parameters': parameters, 'access': definition['access'],
                   'skills': definition.get('skills', []), 'adapter': adapter})


def skill_frontmatter(path, expected_name):
    try: text = Path(path).read_text(encoding='utf-8')
    except UnicodeError as error: raise ValueError('SKILL.md must be UTF-8') from error
    lines = text.splitlines()
    if len(lines) < 4 or lines[0] != '---': raise ValueError('SKILL.md requires YAML frontmatter')
    try: end = lines.index('---', 1)
    except ValueError as error: raise ValueError('SKILL.md frontmatter is not closed') from error
    values = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith('#'): continue
        match = re.fullmatch(r'([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*', line)
        if not match: raise ValueError('SKILL.md frontmatter requires scalar fields')
        key, value = match.groups()
        if key in values: raise ValueError('SKILL.md frontmatter has duplicate fields')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"): value = value[1:-1]
        values[key] = value
    if values.get('name') != expected_name or not values.get('description', '').strip():
        raise ValueError('SKILL.md name/description does not match the declared Skill')


def enrich_skills(result, root, definition):
    declared = definition.get('skills', [])
    raw = result.get('skills', [])
    expected = [(s['name'], s['entrypoint']) for s in declared]
    actual = [(s['name'], s['entrypoint']) for s in raw]
    if sorted(expected) != sorted(actual): raise ValueError('prepared skills do not match environment definition')
    workspace = inside(root, result['workspace']['root']); material_roots = [inside(workspace, m['path']) for m in result['workspace']['materials']]
    skill_roots = []; enriched = []
    for item in raw:
        name = item['name']; skill = inside(workspace, item['root'])
        if not SKILL_NAME.fullmatch(name) or Path(item['root']).name != name or not skill.is_dir(): raise ValueError('invalid Skill identity or root')
        if any(skill.is_relative_to(other) or other.is_relative_to(skill) for other in [*material_roots, *skill_roots]): raise ValueError('Skill and material roots overlap')
        entrypoint = inside(skill, item['entrypoint'])
        if not entrypoint.is_file(): raise ValueError('Skill entrypoint missing')
        skill_frontmatter(entrypoint, name)
        tree = manifest(skill); files = [entry for entry in tree if entry['kind'] == 'file']; total = sum(entry['size'] for entry in files)
        if len(files) > 1000 or total > LIMIT: raise ValueError('Skill bundle exceeds limits')
        skill_roots.append(skill); enriched.append({**item, 'bundle_digest': digest(tree), 'file_count': len(files), 'total_bytes': total})
    if declared: result['skills'] = enriched
    else: result.pop('skills', None)
    return result


def validate_result(result, root, attempt_id):
    if not isinstance(result, dict) or result.get('format') != 'grounds.environment-preparation-result/v1' or result.get('attempt_id') != attempt_id:
        raise ValueError('result does not bind this preparation attempt')
    if result.get('status') == 'failed':
        error = result.get('error', {})
        fields(error,('stage','message'),('details',))
        for value in error.values():nonempty(value)
        if not all(isinstance(error.get(k), str) and error[k].strip() for k in ('stage', 'message')): raise ValueError('failure requires stage and message')
        if set(result) != {'format', 'attempt_id', 'status', 'error'}: raise ValueError('unexpected failure fields')
        return
    if result.get('status') != 'success' or set(result) not in ({'format', 'attempt_id', 'status', 'workspace', 'tools', 'sources'}, {'format', 'attempt_id', 'status', 'workspace', 'tools', 'sources', 'skills'}): raise ValueError('invalid success result')
    workspace = result['workspace']; fields(workspace,('root','materials')); folder = inside(root, workspace['root'])
    for name,items in [('materials',workspace['materials']),('tools',result['tools']),('sources',result['sources'])]:
        if not isinstance(items,list) or len(items)>1000: raise ValueError('invalid '+name)
    if not folder.is_dir(): raise ValueError('workspace missing')
    ids = set(); roots = []
    for item in workspace['materials']:
        fields(item,('id','role','path'));nonempty(item['id'])
        if item['role'] not in ('code', 'doc', 'fixture') or item['id'] in ids: raise ValueError('invalid material identity')
        ids.add(item['id'])
        material = inside(folder, item['path'])
        if not material.is_dir(): raise ValueError('material directory missing')
        if any((material.is_relative_to(other) or other.is_relative_to(material)) and item['role'] != role for other,role in roots): raise ValueError('material roles overlap')
        roots.append((material,item['role']))
    for tool in result['tools']:
        fields(tool,('name','version','entry'))
        for value in tool.values(): nonempty(value)
        if tool['entry'].startswith('backend:'):
            if tool['entry'] not in ('backend:sh', 'backend:git', 'backend:curl', 'backend:python3'): raise ValueError('unknown backend tool')
        elif not inside(root, tool['entry']).is_file(): raise ValueError('tool missing')
        if not tool['name'] or not tool['version']: raise ValueError('tool identity missing')
    for source in result['sources']:
        fields(source,('kind','identity','revision','role'),('branch',))
        for value in source.values(): nonempty(value)
        if source.get('kind') not in ('git', 'kb', 'file') or not all(source.get(k) for k in ('identity', 'revision', 'role')): raise ValueError('source identity missing')
    if 'skills' in result:
        if not isinstance(result['skills'], list) or len(result['skills']) > 32: raise ValueError('invalid skills')
        names = set()
        for skill in result['skills']:
            fields(skill, ('name', 'root', 'entrypoint'))
            if not isinstance(skill['name'], str) or not SKILL_NAME.fullmatch(skill['name']) or skill['name'] in names: raise ValueError('invalid Skill name')
            names.add(skill['name']); relative(skill['root'])
            if skill['entrypoint'] != 'SKILL.md': raise ValueError('unsupported Skill entrypoint')


def stop_group(pid):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass


def process_signature(pid):
    return subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True, timeout=5).stdout.strip()


def recover_interrupted(root, evidence, attempt_id):
    """Recover only the recorded unified runtime; never signal a container PID on the host."""
    import grounds_eval_runtime as runtime
    evidence = Path(evidence); receipt = evidence / 'runtime' / 'environment-dispatch.json'
    if not receipt.exists(): raise ValueError('preparation launch ownership unknown; preserve journal and inspect runtime')
    previous = read(receipt); environment_id = previous['environment']['id']
    if previous.get('run', {}).get('id'): runtime.cli('cancel', previous['run']['id'])
    current = runtime.cli('reconcile', environment_id)['environment']
    if current.get('cleanup', {}).get('state') == 'blocked': raise ValueError('preparation termination or handoff unknown; scene retained')
    result = {'format':'grounds.environment-preparation-result/v1','attempt_id':attempt_id,'status':'failed',
              'error':{'stage':'interrupted','message':'Original environment retained after explicit reconciliation; inspect before a separately authorized retry'}}
    save(evidence/'result.json',result);save(evidence/'observation.json',{'origin':'supervisor','adapter':ADAPTER,'environment_id':environment_id,'recovered':True})
    return {'result':result,'duration_ms':0,'files':evidence_files(evidence, ['result.json','observation.json']),'root':str(root)}


def run_script(command, env, root, evidence, timeout):
    started = time.monotonic(); selector = selectors.DefaultSelector(); failure = None
    with (evidence / 'prepare.stdout.txt').open('wb') as stdout, (evidence / 'prepare.stderr.txt').open('wb') as stderr:
        proc = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        killed = False
        selector.register(proc.stdout, selectors.EVENT_READ, stdout); selector.register(proc.stderr, selectors.EVENT_READ, stderr)
        try:
            save(evidence/'process.json',{'pid':proc.pid,'signature':process_signature(proc.pid),'started_at':time.time()})
            while selector.get_map():
                if not killed and time.monotonic() - started > timeout:
                    failure = 'preparation timeout'; stop_group(proc.pid); killed = True
                for key, _ in selector.select(.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data: selector.unregister(key.fileobj); continue
                    if key.data.tell() + len(data) > LIMIT:
                        failure = 'preparation log budget exceeded'; stop_group(proc.pid); killed = True
                    else: key.data.write(data)
            code = proc.wait(timeout=5)
        finally:
            # A successful parent must not leave a child changing the prepared files.
            try:
                stop_group(proc.pid); proc.wait(timeout=5)
            finally:
                proc.stdout.close(); proc.stderr.close(); selector.close()
                for f in (stdout, stderr): f.flush(); os.fsync(f.fileno())
    return code, failure, int((time.monotonic() - started) * 1000)


def prepare(definition, parameters, root, evidence, attempt_id):
    """Coordinate a fixed preparation task through the same env API as development."""
    import grounds_eval_runtime as runtime
    root, evidence = Path(root).resolve(), Path(evidence).resolve()
    if definition['execution']['backend'] != 'docker' or definition['execution'].get('network_hosts'):
        raise ValueError('new evaluation execution requires docker and network_hosts: []; old macOS records remain historical')
    if root.exists() or evidence.exists(): raise ValueError('preparation destinations already exist; recover the original receipt')
    evidence.mkdir(mode=0o700)
    assets = {}
    from grounds_eval_repositories import is_recipe, stage
    if is_recipe(definition):
        staged = evidence / 'staged'; staged.mkdir(); (staged / 'workspace').mkdir()
        stage(definition, parameters, staged)
        sources = read(staged / 'repository-input.json')['sources']
        if len({s['identity'] for s in sources if s['kind'] == 'git'}) > 1:
            raise ValueError('one evaluation task supports one repository; use approved query tools for additional context')
        assets['staged'] = staged
    result_root, outcome = runtime.execute(None, 'prepare', {'definition': definition, 'parameters': parameters, 'attempt_id': attempt_id}, assets, evidence / 'runtime', definition['execution']['timeout_seconds'] + 30)
    shutil.copytree(result_root / 'workspace-root', root)
    for source in (result_root / 'evidence').iterdir():
        if source.is_file(): shutil.copyfile(source, evidence / source.name)
    outcome['root'] = str(root)
    return outcome


def _prepare_in_task(definition, parameters, root, evidence, attempt_id):
    root, evidence = Path(root).resolve(), Path(evidence).resolve()
    if evidence.is_relative_to(root) or root.is_relative_to(evidence): raise ValueError('evidence must be outside preparation root')
    root.mkdir(mode=0o700); evidence.mkdir(mode=0o700)
    started = time.monotonic(); result = None; code = None; origin = 'supervisor'
    try:
        if definition['task_kind'] != 'qa' or definition['execution']['backend'] != 'docker' or definition['access']['writable_workspace']: raise ValueError('unsupported environment')
        skills = definition.get('skills', [])
        if not isinstance(skills, list) or len(skills) > 32 or (definition['role'] == 'grade' and skills): raise ValueError('invalid environment skills')
        names = set()
        for skill in skills:
            fields(skill, ('name', 'entrypoint'))
            if not isinstance(skill['name'], str) or not SKILL_NAME.fullmatch(skill['name']) or skill['name'] in names or skill['entrypoint'] != 'SKILL.md': raise ValueError('invalid environment Skill declaration')
            names.add(skill['name'])
        specs = definition['parameters']
        for key, value in parameters.items():
            kind = 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int, float)) else 'string' if isinstance(value, str) else 'invalid'
            if key not in specs or specs[key]['type'] != kind: raise ValueError('unexpected parameter or type: ' + key)
        if any(p['required'] and k not in parameters for k, p in specs.items()): raise ValueError('required parameter missing')
        (root / 'workspace').mkdir(); (root / 'tools').mkdir(); (root / 'home').mkdir()
        from grounds_eval_repositories import is_recipe, stage
        if is_recipe(definition):
            staged = os.environ.get('GROUNDS_EVAL_STAGED_INPUT')
            if not staged: raise ValueError('fixed repository input is missing')
            shutil.copytree(Path(staged) / 'workspace', root / 'workspace', dirs_exist_ok=True)
            shutil.copyfile(Path(staged) / 'repository-input.json', root / 'repository-input.json')
        save(root / 'input.json', {'attempt_id': attempt_id, 'parameters': parameters, 'result_path': str(root / 'result.json'), 'workspace': str(root / 'workspace')})
        script = root / 'prepare.script'; script.write_text(definition['script']['content'])
        interpreter = definition['script']['interpreter']
        hosts=definition['execution']['network_hosts']
        if any(not isinstance(h,str) or not re.fullmatch(r'[A-Za-z0-9.-]+',h) for h in hosts): raise ValueError('network_hosts must contain DNS names')
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(root / 'home'), 'TMPDIR': str(root / 'home'),
               'GROUNDS_ENV_INPUT': str(root / 'input.json'), 'GROUNDS_ENV_RESULT': str(root / 'result.json'),
               'GROUNDS_ENV_ATTEMPT': attempt_id, 'GROUNDS_ENV_ROOT': str(root), 'GROUNDS_ENV_HELPER': str(Path(__file__).resolve())}
        if hosts: raise ValueError('network_hosts is a retired restriction; new unified environments require an empty list')
        code, failure, _ = run_script([interpreter, str(script)], env, root, evidence, definition['execution']['timeout_seconds'])
        if failure: raise ValueError(failure)
        path = root / 'result.json'
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 2 * 1024 * 1024: raise ValueError('missing or oversized preparation result')
        result = read(path); validate_result(result, root, attempt_id); origin = 'script'
        if failure or (code != 0 and result['status'] == 'success'): raise ValueError(failure or 'success result conflicts with nonzero exit')
        if result['status'] == 'success':
            result = enrich_skills(result, root, definition)
            workspace = inside(root, result['workspace']['root']); tree = manifest(workspace)
            required = set(definition['access']['read_roles'])
            if not required.issubset({m['role'] for m in result['workspace']['materials']}): raise ValueError('required material missing')
            # Preserve metadata without trusting script-supplied hashes.
            save(evidence / 'workspace-manifest.json', tree)
            for path in [*workspace.rglob('*'), workspace]: path.chmod(path.stat().st_mode & ~0o222)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        if result is not None: save(evidence / 'script-result.json', result)
        origin = 'supervisor'; result = {'format': 'grounds.environment-preparation-result/v1', 'attempt_id': attempt_id, 'status': 'failed', 'error': {'stage': 'execution', 'message': str(error)[:8192] or type(error).__name__}}
    save(evidence / 'result.json', result)
    save(evidence / 'observation.json', {'origin': origin, 'exit_code': code, 'observed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'adapter': ADAPTER})
    return {'result': result, 'duration_ms': int((time.monotonic()-started)*1000), 'files': evidence_files(evidence, sorted(p.name for p in evidence.iterdir() if p.is_file())), 'root': str(root)}


def material_evidence(citations, workspace, materials, expected_manifest):
    if manifest(workspace) != expected_manifest: raise ValueError('workspace changed since preparation')
    known = {m['id']: m for m in materials}; output = []
    for citation in citations:
        locator = citation.get('locator', '')
        if not locator.startswith('material-v1:'): continue
        try:
            match = re.fullmatch(r'material-v1:([^/]+)/(.+)#L([1-9][0-9]*)-L([1-9][0-9]*)', locator)
            if not match: raise ValueError('invalid material locator')
            identity, name, start, end = match.groups(); start, end = int(start), int(end)
            if end < start or end-start+1 > 200: raise ValueError('citation line limit')
            material = known[identity]; path = inside(inside(workspace, material['path']), unquote(name))
            lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
            if end > len(lines): raise ValueError('citation outside file')
            text = ''.join(lines[start-1:end])
            if len(text.encode()) > 32768: raise ValueError('citation byte limit')
            output.append({'locator': locator, 'content': text, 'digest': digest(text.encode()), 'file_digest': digest(path.read_bytes())})
        except (ValueError, KeyError, UnicodeError, OSError) as error:
            output.append({'locator': locator, 'error': str(error)})
    return output


def validate_git_tree(data):
    # Inspect Git's tree before trusting checkout: case-insensitive filesystems may
    # silently collapse distinct tracked names into one on-disk file.
    known={}
    for row in data.split(b'\0'):
        if not row:continue
        metadata,raw_path=row.split(b'\t',1);mode=metadata.split(b' ',1)[0]
        if mode in (b'120000',b'160000'):raise ValueError('Git symlinks and submodules are not supported')
        name=relative(raw_path.decode('utf-8'))
        parts=name.split('/')
        for count in range(1,len(parts)+1):
            path='/'.join(parts[:count]);folded=unicodedata.normalize('NFC',path).casefold()
            if folded in known and known[folded]!=path:raise ValueError('Git tree contains case or Unicode path collisions')
            known[folded]=path


def graphkb_prepare():
    """Bind a read-only KB endpoint; repository bytes require fixed snapshots."""
    from urllib.parse import urlsplit
    request = read(os.environ['GROUNDS_ENV_INPUT']); parameters = request['parameters']
    attempt = request['attempt_id']
    try:
        server = parameters['kb_server'].rstrip('/'); url = urlsplit(server)
        if url.scheme not in ('https', 'http') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('KB server must be a credential-free HTTP endpoint')
        if parameters.get('simulate_failure'): raise ValueError('controlled source binding failure')
        if parameters.get('materials'): raise ValueError('repository downloads are unsupported; bind a single fixed role-scoped repository snapshot')
        result={'format':'grounds.environment-preparation-result/v1','attempt_id':attempt,'status':'success',
                'workspace':{'root':'workspace','materials':[]},'tools':[],
                'sources':[{'kind':'kb','identity':server+'#'+parameters['kb'],'revision':'unavailable','role':'knowledge'}]}
    except Exception as error:
        result={'format':'grounds.environment-preparation-result/v1','attempt_id':attempt,'status':'failed',
                'error':{'stage':'bind_source','message':str(error)[:8192] or type(error).__name__}}
    save(request['result_path'],result)
    return 0 if result['status']=='success' else 1


def validate_definition(record, parameters, failure_parameters, out):
    import grounds_eval_capture as capture
    out=Path(out).resolve(); out.mkdir(mode=0o700)
    definition=record['data']; reference={'id':record['id'],'version':record['version'],'digest':digest(definition)}
    import grounds_eval_runtime as runtime
    isolation, _ = runtime.execute(None, 'preflight', {}, {}, out/'isolation-runtime', 30)
    (out/'isolation').mkdir()
    shutil.copyfile(isolation/'preflight'/'preflight.json', out/'isolation'/'preflight.json')
    success=prepare(definition,parameters,out/'success-root',out/'success-evidence','validation-success')
    failure=prepare(definition,failure_parameters,out/'failure-root',out/'failure-evidence','validation-failure')
    # Validate both result branches; malformed and foreign-attempt outputs must fail closed.
    protocol=True
    for invalid in [{}, {'format':'grounds.environment-preparation-result/v1','attempt_id':'wrong','status':'failed','error':{'stage':'x','message':'x'}}]:
        try: validate_result(invalid,out/'success-root','validation-success'); protocol=False
        except (ValueError,KeyError,TypeError): pass
    probes = {
        'missing': 'exit 0',
        'nonzero': '/bin/echo "not JSON" > "$GROUNDS_ENV_RESULT"; exit 9',
        'timeout': '/bin/sleep 3',
        'conflict': template('grade',[])['script']['content'].replace('exec /usr/bin/python3','/usr/bin/python3')+'\nexit 9',
    }
    for label,script in probes.items():
        probe = {**definition, 'script':{'interpreter':'/bin/sh','content':script},
                 'execution':{**definition['execution'],'timeout_seconds':1,'network_hosts':[]}}
        checked=prepare(probe,parameters,out/(label+'-root'),out/(label+'-evidence'),'protocol-'+label)
        protocol = protocol and checked['result']['status']=='failed'
    names=[]
    for label in ('success','failure','missing','nonzero','timeout','conflict'):
        for source in sorted((out/(label+'-evidence')).iterdir()):
            if source.is_file():
                name=label+'-'+source.name; shutil.copyfile(source,out/name); names.append(name)
    shutil.copyfile(out/'isolation'/'preflight.json',out/'isolation.json'); names.append('isolation.json')
    checks={'success':success['result']['status']=='success','failure':failure['result']['status']=='failed' and read(out/'failure-evidence'/'observation.json')['origin']=='script', 'protocol':protocol,'isolation':True}
    result={'format':'grounds.environment-validation/v1','environment':reference,'adapter':ADAPTER,'parameters':parameters,'checks':checks,'files':evidence_files(out,names)}
    save(out/'validation.json',result)
    for label in ('success','failure','missing','nonzero','timeout','conflict'):
        work=out/(label+'-root')
        if work.exists():
            for path in [work,*work.rglob('*')]:
                if not path.is_symlink(): path.chmod(path.stat().st_mode|0o200)
            shutil.rmtree(work)
    return result


def template(mode, hosts, source=None):
    if hosts: raise ValueError('network_hosts must be empty for unified environments; select runtime network policy explicitly')
    source = source or ('repositories' if mode in ('doc-only', 'doc-code', 'code') else 'graphkb')
    if source == 'repositories':
        from grounds_eval_repositories import recipe
        if hosts: raise ValueError('repository snapshots require no download hosts')
        if mode not in ('doc-only', 'doc-code', 'code'): raise ValueError('unsupported repository mode')
        return recipe(mode)
    if mode in ('doc-only', 'doc-code', 'code', 'kb-code'): raise ValueError('local material mode requires repository snapshots; GraphKB download recipes are unsupported')
    grade = mode == 'grade'
    roles = {'code':['code'],'doc-code':['doc','code'],'kb-code':['code'],'kb-only':[],'grade':[]}[mode]
    script = 'exec /usr/bin/python3 "$GROUNDS_ENV_HELPER" graphkb' if not grade else """exec /usr/bin/python3 - <<'PYCODE'
import json, os
p=json.load(open(os.environ['GROUNDS_ENV_INPUT']))
r={'format':'grounds.environment-preparation-result/v1','attempt_id':p['attempt_id']}
if p['parameters'].get('simulate_failure'):
    r.update(status='failed',error={'stage':'fixture','message':'controlled failure'})
else:
    r.update(status='success',workspace={'root':'workspace','materials':[]},tools=[],sources=[])
with open(p['result_path'],'w') as f: json.dump(r,f)
PYCODE"""
    parameters={'simulate_failure':{'type':'boolean','required':False}}
    if not grade:
        parameters.update({k:{'type':'string','required':k!='materials'} for k in ('kb','kb_server','materials')})
    return {'format':'grounds.eval-environment/v1','name':mode,'task_kind':'qa','role':'grade' if grade else 'answer',
            'parameters':parameters,'script':{'interpreter':'/bin/sh','content':script},
            'execution':{'backend':'docker','timeout_seconds':600,'network_hosts':hosts},
            'access':{'read_roles':roles,'kb':mode in ('kb-code','kb-only'),'writable_workspace':False}}


def main():
    if len(sys.argv)>1 and sys.argv[1]=='template':
        parser=argparse.ArgumentParser(description='Create an editable QA environment definition')
        parser.add_argument('--mode',required=True,choices=['code','doc-only','doc-code','kb-code','kb-only','grade'])
        parser.add_argument('--source',choices=['graphkb','repositories'],help='defaults to repositories for doc-only, graphkb for existing modes')
        parser.add_argument('--host',action='append',default=[])
        args=parser.parse_args(sys.argv[2:]); print(json.dumps(template(args.mode,args.host,args.source),ensure_ascii=False,indent=2)); return 0
    if len(sys.argv)>1 and sys.argv[1]=='graphkb': return graphkb_prepare()
    if len(sys.argv)>1 and sys.argv[1]=='repositories':
        from grounds_eval_repositories import prepare_result
        return prepare_result()
    if len(sys.argv)>1 and sys.argv[1]=='validate':
        parser=argparse.ArgumentParser(description='Validate a published environment using isolated success and failure inputs')
        for key in ('definition','parameters','failure-parameters','out'): parser.add_argument('--'+key,required=True)
        args=parser.parse_args(sys.argv[2:]); result=validate_definition(read(args.definition),read(args.parameters),read(args.failure_parameters),args.out)
        print(json.dumps(result)); return 0 if all(result['checks'].values()) else 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--definition', required=True); parser.add_argument('--parameters', required=True)
    parser.add_argument('--root', required=True); parser.add_argument('--evidence', required=True); parser.add_argument('--attempt-id', required=True)
    args = parser.parse_args()
    result = prepare(read(args.definition), read(args.parameters), args.root, args.evidence, args.attempt_id)
    print(json.dumps(result, ensure_ascii=False)); return 0 if result['result']['status'] == 'success' else 1


if __name__ == '__main__': raise SystemExit(main())
