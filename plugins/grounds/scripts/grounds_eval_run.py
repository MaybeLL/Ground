#!/usr/bin/env python3
"""Coordinate native QA through an installed Grounds CLI and durable local journal.

Resume submits existing captures; it never repeats a launched model session.
Use a new journal and --rerun-of for an explicitly requested new attempt.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import grounds_agent
import grounds_eval_capture as capture


def read(path: Path) -> Any:
    return json.loads(path.read_text())


def atomic_json(path: Path, value: Any) -> None:
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Paused(RuntimeError):
    pass


class Journal:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.state = read(self.root / 'state.json')

    def cli(self, args: list[str], operation: str | None = None) -> Any:
        config = Path(self.state['ledger_config'])
        if hashlib.sha256(config.read_bytes()).hexdigest() != self.state['ledger_config_sha256']:
            raise Paused('Ledger configuration changed; restore the original configuration before resume')
        command = [self.state['grounds_command'], '--config', str(config), '--json', *args]
        if operation:
            command += ['--operation-id', operation, '--agent-id', self.state['agent_id'],
                        '--agent-name', self.state['agent_name']]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        try:
            envelope = json.loads(result.stdout)
        except ValueError:
            raise Paused('Grounds returned no JSON envelope; model captures remain in the journal') from None
        if result.returncode or not envelope.get('ok'):
            raise Paused('Grounds command failed: ' + json.dumps(envelope.get('error', {}), ensure_ascii=False))
        return envelope['data']['payload']

    def call(self, key: str, args: list[str], write: bool = False) -> Any:
        request_path = self.root / (key + '.request.json')
        receipt_path = self.root / (key + '.receipt.json')
        input_hashes = {str(Path(args[i + 1]).resolve()): hashlib.sha256(Path(args[i + 1]).read_bytes()).hexdigest()
                        for i, value in enumerate(args[:-1]) if value == '--file'}
        if request_path.exists():
            request = read(request_path)
            if request['args'] != args or request['write'] != write or request.get('input_hashes', {}) != input_hashes:
                raise Paused('Recovery command differs from frozen request: ' + key)
        else:
            request = {'args': args, 'write': write, 'operation_id': grounds_agent.new_uuid7(), 'input_hashes': input_hashes}
            atomic_json(request_path, request)
        if receipt_path.exists():
            return read(receipt_path)
        value = self.cli(args, request['operation_id'] if write else None)
        atomic_json(receipt_path, value)
        return value

    def model(self, key: str, packet: Path, grading: bool) -> tuple[Path, dict[str, Any]]:
        output = self.root / key
        marker = self.root / (key + '.launch.json')
        status_path = output / 'status.json'
        if status_path.exists():
            if getattr(self,'managed',None): self.managed.recover_session_release(key,output)
            return output, read(status_path)
        if marker.exists() or output.exists():
            if getattr(self,'managed',None): self.managed.mark_model_unknown(key,output)
            raise Paused('Capture may have started and has no final status: ' + key +
                         '. Preserve evidence; explicitly stop the run and create a new attempt')
        remaining = int(self.state['deadline'] - time.time())
        if remaining <= 0:
            raise Paused('Round time budget exhausted; resume cannot reset the budget')
        config = dict(self.state['grader_config' if grading else 'answer_config'])
        if not getattr(self, 'managed', None): config['timeout_seconds'] = min(config['timeout_seconds'], remaining)
        config_path = self.root / (key + '.config.json')
        atomic_json(config_path, config)
        managed = getattr(self, 'managed', None)
        context = managed.session(key, packet, grading, config) if managed else None
        # Durable intent BEFORE process launch: ambiguity must not trigger a paid replay.
        atomic_json(marker, {'started_at': capture.now(), 'packet': str(packet),
                             'capture_helper_sha256': hashlib.sha256(Path(capture.__file__).read_bytes()).hexdigest()})
        try:
            capture.run(str(config_path), str(packet), output, grading, deadline=self.state['deadline'], **({'environment': context} if context else {}))
            if managed: managed.release_session()
        except Exception as error:
            atomic_json(self.root / (key + '.error.json'), {'error_type': type(error).__name__})
            if managed:
                try: managed.mark_model_unknown(key,output)
                except Exception: pass  # Local launch/error journals remain the recovery authority.
            raise Paused('Capture did not finalize: ' + key + '; inspect local evidence and launch marker') from error
        return output, read(status_path)

    def grading_packet(self, key: str, run_id: str, grader_id: str, artifact_id: str) -> Path:
        packet = self.call(key + '-context', ['eval', 'grader', 'context', '--eval-run', run_id,
                                             '--grader', grader_id], True)
        target = self.root / (key + '-packet')
        if not target.exists():
            # The CLI export is read-only. A partial staging export can be safely
            # abandoned; only a complete directory is renamed into the ready path.
            with tempfile.TemporaryDirectory(prefix='packet-', dir=self.root) as temporary:
                staging = Path(temporary) / 'export'
                self.cli(['eval', 'artifact', 'export', artifact_id, '--out', str(staging)])
                atomic_json(staging / 'context.json', packet)
                os.rename(staging, target)
        return target / 'context.json'

    def report(self) -> Path:
        directory = self.root / ('report-' + grounds_agent.new_uuid7())
        self.cli(['eval', 'experiment', 'report', self.state['experiment'], '--out', str(directory)])
        return directory

    def execute(self, retry_prepare=False) -> dict[str, Any]:
        result_path = self.root / 'result.json'
        if result_path.exists() and read(result_path)['status'] == 'completed':
            return read(result_path)
        if (self.root / 'blocked.json').exists():
            raise Paused(read(self.root / 'blocked.json')['reason'])
        experiment = self.call('experiment', ['eval', 'experiment', 'show', self.state['experiment']])
        self.managed = None
        if experiment['data'].get('environment'):
            from grounds_eval_managed import ManagedCoordinator
            self.managed = ManagedCoordinator(self, experiment, retry_prepare)
        snapshot = self.call('snapshot', ['eval', 'snapshot', 'show', experiment['data']['snapshot_id']])
        tasks = snapshot['data']['tasks']
        if self.state.get('task'):
            tasks = [task for task in tasks if task['id'] == self.state['task']]
        if not tasks or any(task.get('kind') != 'qa' for task in tasks):
            raise Paused('Select a nonempty native QA task set')
        for task in tasks:
            key = task['id']
            args = ['eval', 'run', 'start', '--experiment', self.state['experiment'], '--task', key]
            for field, flag in (('rerun_of', '--rerun-of'), ('artifact', '--artifact')):
                if self.state.get(field):
                    args += [flag, self.state[field]]
            run = self.call(key + '-run', args, True)
            if self.managed: self.managed.current_run = run['id']
            if self.state.get('artifact'):
                artifact = self.call(key + '-artifact', ['eval', 'artifact', 'show', self.state['artifact']])
            else:
                packet = self.call(key + '-public', ['eval', 'run', 'context', run['id']])
                public_path = self.root / (key + '-public.json')
                if not public_path.exists():
                    atomic_json(public_path, packet)
                output, status = self.model(key + '-answer', public_path, False)
                artifact = self.call(key + '-artifact', ['eval', 'artifact', 'submit', '--file',
                                                       str(output / 'artifact.json'), '--files', str(output)], True)
                if not status['success'] or status.get('blocked') or status['limitations']:
                    return self.stop(key, run['id'], 'Answer execution/capture blocker: ' + str(status['limitations']))
            for index, grader in enumerate(task['graders']):
                grade_key = key + '-grade-' + str(index)
                packet_path = self.grading_packet(grade_key, run['id'], grader['id'], artifact['id'])
                output, status = self.model(grade_key, packet_path, True)
                self.call(grade_key + '-evidence', ['eval', 'grader', 'evidence-submit', '--file',
                          str(output / 'grading-evidence.json'), '--files', str(output)], True)
                self.call(grade_key + '-submission', ['eval', 'grader', 'submit', '--file',
                                                     str(output / 'submission.json')], True)
                if not status['success'] or status.get('blocked') or status['limitations']:
                    return self.stop(key, run['id'], 'Grading execution/capture blocker: ' + str(status['limitations']))
            self.call(key + '-finish', ['eval', 'run', 'finish', run['id']], True)
        if self.managed and not self.state.get('shared_root'): self.managed.cleanup()
        result = {'status': 'completed', 'experiment': self.state['experiment'], 'report': str(self.report())}
        atomic_json(result_path, result)
        return result

    def stop(self, key: str, run_id: str, reason: str) -> dict[str, Any]:
        self.call(key + '-stop', ['eval', 'run', 'stop', run_id, '--reason', reason], True)
        result = {'status': 'blocked', 'run_id': run_id, 'reason': reason, 'report': str(self.report())}
        atomic_json(self.root / 'blocked.json', result)
        atomic_json(self.root / 'result.json', result)
        return result


def start(args: argparse.Namespace) -> None:
    cli = shutil.which(args.grounds_command)
    if not cli:
        raise ValueError('Grounds CLI not found: ' + args.grounds_command)
    if args.budget_seconds <= 0 or args.budget_seconds > 86400:
        raise ValueError('budget-seconds must be 1..86400')
    if (args.rerun_of or args.artifact) and not args.task:
        raise ValueError('--rerun-of and --artifact require a single --task')
    config = Path(args.ledger_config).resolve()
    answer, grader = read(Path(args.answer_config)), read(Path(args.grader_config))
    for settings in (answer, grader):
        if not isinstance(settings.get('timeout_seconds'), int) or settings['timeout_seconds'] <= 0:
            raise ValueError('Each capture configuration requires positive timeout_seconds')
    root = Path(args.out).resolve()
    root.mkdir(mode=0o700)
    atomic_json(root / 'state.json', {'format': 'grounds.eval-coordinator/v1',
                'grounds_command': str(Path(cli).absolute()), 'ledger_config': str(config),
                'ledger_config_sha256': hashlib.sha256(config.read_bytes()).hexdigest(),
                'experiment': args.experiment, 'task': args.task, 'rerun_of': args.rerun_of,
                'artifact': args.artifact, 'answer_config': answer, 'grader_config': grader,
                'agent_id': args.agent_id, 'agent_name': args.agent_name,
                'deadline': time.time() + args.budget_seconds})


def start_plan(args):
    entries=read(Path(args.file))
    if not isinstance(entries,list) or not entries or len(entries)>100: raise ValueError('plan must contain 1..100 experiment entries')
    if len({e['experiment'] for e in entries})!=len(entries): raise ValueError('plan contains duplicate experiments')
    root=Path(args.out).resolve(); root.mkdir(mode=0o700)
    deadline=time.time()+args.budget_seconds; states=[]
    for index,entry in enumerate(entries):
        if set(entry)-{'experiment','answer_config','grader_config','task','artifact','rerun_of'}: raise ValueError('unknown plan entry field')
        values=vars(args).copy(); values.update(entry)
        values.update(out=str(root/('experiment-'+str(index))),task=entry.get('task'),artifact=entry.get('artifact'),rerun_of=entry.get('rerun_of'))
        start(argparse.Namespace(**values))
        state=read(Path(values['out'])/'state.json');state.update(deadline=deadline,shared_root=str(root))
        atomic_json(Path(values['out'])/'state.json',state);states.append(state)
    owner={**states[0],'plan_experiments':[e['experiment'] for e in entries], 'plan_children':['experiment-'+str(i) for i in range(len(entries))]}
    owner.pop('shared_root',None);atomic_json(root/'state.json',owner)


def execute_plan(root,retry=False):
    owner=Journal(root);results=[]
    for name in owner.state['plan_children']:
        journal=Journal(root/name)
        with (journal.root/'coordinator.lock').open('a') as lock:
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise Paused('Another coordinator owns a plan consumer') from None
            result=journal.execute(retry_prepare=retry);results.append(result)
            if result['status']!='completed':return {'status':'blocked','experiments':results}
    from grounds_eval_managed import ManagedCoordinator
    experiment=owner.cli(['eval','experiment','show',owner.state['experiment']])
    ManagedCoordinator(owner,experiment).cleanup()
    result={'status':'completed','experiments':results};atomic_json(root/'result.json',result);return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    new = commands.add_parser('start')
    new.add_argument('--grounds-command', default='grounds')
    for name in ('ledger-config', 'experiment', 'answer-config', 'grader-config', 'budget-seconds', 'out'):
        new.add_argument('--' + name, required=True, type=int if name == 'budget-seconds' else str)
    new.add_argument('--task'); new.add_argument('--rerun-of'); new.add_argument('--artifact')
    new.add_argument('--agent-id', default='qa-coordinator'); new.add_argument('--agent-name', default='QA coordinator')
    plan=commands.add_parser('start-plan',help='Run compatible experiments with one shared preparation owner')
    plan.add_argument('--file',required=True,help='JSON array of experiment / answer_config / grader_config entries')
    plan.add_argument('--grounds-command',default='grounds')
    plan.add_argument('--ledger-config',required=True);plan.add_argument('--out',required=True)
    plan.add_argument('--budget-seconds',required=True,type=int)
    plan.add_argument('--agent-id',default='qa-coordinator');plan.add_argument('--agent-name',default='QA coordinator')
    for name in ('resume', 'retry-prepare', 'status'):
        commands.add_parser(name).add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'start':
            start(args)
        if args.command == 'start-plan': start_plan(args)
        root = Path(args.out).resolve()
        with (root / 'coordinator.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Paused('Another coordinator owns this journal') from None
            journal = Journal(root)
            if journal.state.get('shared_root'): raise Paused('Resume the shared plan owner: '+journal.state['shared_root'])
            if args.command == 'status':
                value = read(root / 'result.json') if (root / 'result.json').exists() else {'status': 'incomplete', 'journal': str(root)}
            else:
                value = execute_plan(root,retry=args.command=='retry-prepare') if journal.state.get('plan_children') else journal.execute(retry_prepare=args.command == 'retry-prepare')
            print(json.dumps(value, ensure_ascii=False))
            return 0 if value['status'] == 'completed' else 1
    except (OSError, ValueError, Paused, subprocess.TimeoutExpired) as error:
        print(json.dumps({'status': 'paused', 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
