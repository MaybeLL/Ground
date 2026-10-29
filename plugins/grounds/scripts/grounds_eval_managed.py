"""Glue for environment ledger events and the external QA coordinator."""
from pathlib import Path
import shutil
import time
import grounds_eval_environment as env


class ManagedCoordinator:
    def __init__(self, journal, experiment, retry=False):
        self.journal = journal; self.experiment = experiment; self.retry = retry
        self.preparation_journal = journal
        if journal.state.get('shared_root'):
            from grounds_eval_run import Journal
            self.preparation_journal = Journal(Path(journal.state['shared_root']))
        self.bindings = experiment['data']['environment']; self.prepared = {}; self.retried = set()

    def submit(self, key, kind, data, files_root, previous=None, journal=None):
        journal = journal or self.journal
        path = journal.root / (key + '.input.json')
        if not path.exists(): env.save(path, data)
        elif env.read(path) != data: raise ValueError('environment recovery input changed: ' + key)
        args = ['eval', kind, 'submit']
        if previous: args += [previous['id'], '--expected-version', str(previous['version'])]
        args += ['--file', str(path), '--files', str(files_root)]
        return journal.call(key, args, True)

    def preparation(self, role):
        if role in self.prepared: return self.prepared[role]
        journal = self.preparation_journal
        def submit(*args): return self.submit(*args,journal=journal)
        current_binding = self.bindings[role]
        owner = journal.cli(['eval','experiment','show',journal.state['experiment']])
        binding = owner['data']['environment'][role]; ref = binding['environment']
        definition = journal.cli(['eval', 'environment', 'show', ref['id'], '--version', str(ref['version'])])['data']
        if env.digest(definition) != ref['digest']: raise ValueError('environment definition changed')
        draft = {'format': 'grounds.environment-preparation/v1', 'environment': ref, 'parameters': binding['parameters'],
                 'adapter': env.ADAPTER, 'experiment_ids': journal.state.get('plan_experiments',[self.experiment['id']]), 'owner': str(journal.root),
                 'attempt': 1, 'state': 'registered', 'duration_ms': 0, 'files': [],
                 'preparation_contract_digest': env.preparation_contract_digest(definition,binding['parameters'])}
        registered = submit(role + '-preparation-register', 'preparation', draft, journal.root)
        record = journal.cli(['eval', 'preparation', 'show', registered['id']])
        if record['data']['state'] == 'failed' and self.retry and role not in self.retried:
            self.retried.add(role)
            draft = dict(record['data'], attempt=record['data']['attempt']+1, state='registered', files=[], duration_ms=0)
            draft.pop('result', None); draft.pop('manifest_digest', None)
            record = submit(role+'-retry-'+str(draft['attempt']), 'preparation', draft, journal.root, record)
        attempt = record['data']['attempt']; key = role + '-prepare-' + str(attempt)
        work = journal.root / (key + '-workspace'); evidence = journal.root / (key + '-evidence')
        outcome_path = journal.root / (key + '-outcome.json'); marker = journal.root / (key + '-started.json')
        if record['data']['state'] == 'registered':
            if outcome_path.exists(): outcome = env.read(outcome_path)
            elif marker.exists():
                if not self.retry: raise ValueError('preparation interrupted; use retry-prepare for explicit recovery')
                outcome = env.recover_interrupted(work,evidence,f"{record['id']}:{attempt}")
                env.save(outcome_path,outcome)
            else:
                env.save(marker, {'attempt_id': f"{record['id']}:{attempt}", 'started_at': time.time()})
                outcome = env.prepare(definition, binding['parameters'], work, evidence, f"{record['id']}:{attempt}")
                env.save(outcome_path, outcome)
            result = outcome['result']; draft = dict(record['data'], state=result['status'], result=result,
                                                    duration_ms=outcome['duration_ms'], files=outcome['files'])
            if result['status'] == 'success': draft['manifest_digest'] = next(f['digest'] for f in outcome['files'] if f['name']=='workspace-manifest.json')
            record = submit(key+'-complete', 'preparation', draft, evidence, record)
        if record['data']['state'] == 'failed' and self.retry and role not in self.retried:
            # Failure was first persisted; a fresh attempt gets a new managed directory.
            self.retried.add(role)
            self.retry = False
            try:
                draft = dict(record['data'], attempt=attempt+1, state='registered', files=[], duration_ms=0)
                draft.pop('result',None); draft.pop('manifest_digest',None)
                submit(role+'-retry-'+str(attempt+1),'preparation',draft,journal.root,record)
                return self.preparation(role)
            finally: self.retry = True
        if record['data']['state'] != 'success': raise ValueError('environment preparation failed; inspect record and use retry-prepare explicitly')
        result = record['data']['result']; workspace = env.inside(work, result['workspace']['root'])
        tree = env.read(evidence / 'workspace-manifest.json')
        if env.digest((evidence / 'workspace-manifest.json').read_bytes()) != record['data']['manifest_digest'] or env.manifest(workspace) != tree: raise ValueError('prepared workspace missing or changed')
        definition=journal.cli(['eval','environment','show',current_binding['environment']['id'],'--version',str(current_binding['environment']['version'])])['data']
        if not set(definition['access']['read_roles']).issubset({m['role'] for m in result['workspace']['materials']}): raise ValueError('shared workspace lacks required materials')
        declared={s['name'] for s in definition.get('skills',[])}; prepared={s['name'] for s in result.get('skills',[])}
        if declared != prepared: raise ValueError('shared workspace has incompatible prepared Skills')
        value = {'record': record, 'definition': definition, 'workspace': str(workspace), 'manifest': tree,
                 'materials': [m for m in result['workspace']['materials'] if m['role'] in definition['access']['read_roles']],
                 'skills': result.get('skills',[]), 'work': work}
        self.prepared[role] = value; return value

    def session(self, key, packet, grading, config):
        role = 'grade' if grading else 'answer'; binding = self.bindings[role]; prepared = self.preparation(role)
        # Runtime paths and credential references are host bindings. Semantic settings are frozen.
        host_keys = {'codex_command', 'codex_home', 'api_key_env', 'graphkb_command', 'environment_task'}
        actual = {k:v for k,v in config.items() if k not in host_keys}
        if actual != binding['execution_config']: raise ValueError('capture configuration differs from frozen experiment configuration')
        required=actual.get('required_skills',[])
        if not isinstance(required,list) or len(required)>32 or any(not isinstance(name,str) or not env.SKILL_NAME.fullmatch(name) for name in required) or len(set(required))!=len(required): raise ValueError('invalid required_skills')
        if grading and required: raise ValueError('grading cannot load tested Skills')
        if not set(required).issubset({s['name'] for s in prepared['definition'].get('skills',[])}): raise ValueError('required Skill is not declared by the environment')
        if not set(required).issubset({s['name'] for s in prepared['skills']}): raise ValueError('required Skill is not present in the preparation receipt')
        if actual.get('enable_kb', True) != prepared['definition']['access']['kb'] and not grading: raise ValueError('KB capability differs from environment')
        if not grading and prepared['definition']['access']['kb']:
            for name in ('kb','kb_server'):
                if config.get(name) != binding['parameters'].get(name): raise ValueError('KB runtime target differs from prepared source: '+name)
        payload = env.read(packet); run_id = payload.get('run_id')
        if grading:
            # Grade packet carries execution ID; coordinator records the owning run explicitly.
            run_id = self.current_run
            expected=env.read(self.journal.root/(key+'-context.receipt.json'))
            if env.digest(payload)!=env.digest(expected): raise ValueError('grading packet changed after ledger export')
        instance = {'format':'grounds.environment-instance/v1','run_id':run_id,'role':role,'environment':binding['environment'],
                    'preparation_id':prepared['record']['id'],'state':'registered','attempt':0,
                    'input_digest':payload['context_digest'] if grading else env.digest(payload),
                    'validity':'pending','release':'pending','duration_ms':0,'files':[]}
        if grading: instance['execution_id']=payload['execution_id']
        record = self.submit(key+'-instance-register','instance',instance,self.journal.root)
        record = self.submit(key+'-instance-preparing','instance',dict(record['data'],state='preparing',attempt=1),self.journal.root,record)
        started = time.monotonic()
        def ready(policy,out):
            nonlocal record
            (out/'policy.txt').write_text(policy)
            files=env.evidence_files(out,['instance-manifest.json','policy.txt'])
            draft=dict(record['data'],state='ready',policy_digest=env.digest(policy.encode()),manifest_digest=files[0]['digest'],files=files,duration_ms=int((time.monotonic()-started)*1000))
            record=self.submit(key+'-instance-ready','instance',draft,out,record)
        def launch():
            nonlocal record
            # Evidence directory is passed by ready; recover it from this callback state.
            record=self.submit(key+'-instance-launch','instance',dict(record['data'],state='launch_intent'),ready.directory,record)
        base_ready=ready
        def ready_wrapper(policy,out):
            ready.directory=out
            base_ready(policy,out)
        def collected(result,limitations,out):
            nonlocal record
            names=['instance-manifest.json','policy.txt']+(['final-skills-manifest.json'] if (out/'final-skills-manifest.json').exists() else [])
            files=env.evidence_files(out,names)
            draft=dict(record['data'],state='collected',files=files,**({'session_id':result['session_id']} if result['session_id'] != 'unavailable' else {}),validity='invalid' if limitations else 'valid')
            if limitations: draft['reason']='; '.join(limitations)
            record=self.submit(key+'-instance-collected','instance',draft,out,record)
            reference={'instance':{'id':record['id'],'version':record['version']},'preparation':{'id':prepared['record']['id'],'version':prepared['record']['version']}}
            # The unified environment has returned a successful release receipt before collection.
            self.last_instance=(key,record,out)
            return reference
        return {**prepared,'required_skills':required,'ready':ready_wrapper,'launch':launch,'collected':collected}

    def release_session(self):
        if not hasattr(self,'last_instance'): return
        key,record,out=self.last_instance
        self.submit(key+'-instance-release','instance',dict(record['data'],release='released'),out,record)
        del self.last_instance

    def mark_model_unknown(self,key,out):
        receipt=self.journal.root/(key+'-instance-register.receipt.json')
        if not receipt.exists():return
        registered=env.read(receipt)
        record=self.journal.cli(['eval','instance','show',registered['id']])
        if record['data']['state'] not in ('launch_intent','running'):return
        self.submit(key+'-instance-unknown','instance',dict(record['data'],state='unknown',validity='unknown',reason='No final capture acknowledgement; do not automatically relaunch'),out,record)

    def recover_session_release(self, key, out):
        evidence = out/('grading-evidence.json' if (out/'grading-evidence.json').exists() else 'artifact.json')
        if not evidence.exists(): return
        reference=env.read(evidence).get('environment')
        if not reference: return
        record=self.journal.cli(['eval','instance','show',reference['instance']['id']])
        if record['data']['release']=='released': return
        self.last_instance=(key,record,out)
        self.release_session()

    def cleanup(self):
        journal=self.preparation_journal
        # Called only when the whole selected execution plan has completed.
        for role in self.bindings:
            receipt=journal.root/(role+'-preparation-register.receipt.json')
            if not receipt.exists(): continue
            record=env.read(receipt); latest=journal.cli(['eval','preparation','show',record['id']])
            record=latest
            if latest['data']['state']=='released': continue
            consumers=journal.cli(['eval','instance','list'])
            if any(i['data']['preparation_id']==record['id'] and i['data']['release']!='released' for i in consumers):
                raise ValueError('shared workspace still has live or uncertain consumers')
            for attempt in range(1,record['data']['attempt']+1):
                work=journal.root/(role+'-prepare-'+str(attempt)+'-workspace')
                if work.is_symlink(): raise ValueError('managed preparation root was replaced with a link')
                if work.exists():
                    for path in [work,*work.rglob('*')]:
                        if not path.is_symlink(): path.chmod(path.stat().st_mode|0o200)
                    shutil.rmtree(work)
            evidence=journal.root/(role+'-prepare-'+str(record['data']['attempt'])+'-evidence')
            self.submit(role+'-preparation-release','preparation',dict(latest['data'],state='released'),evidence,latest,journal=journal)
