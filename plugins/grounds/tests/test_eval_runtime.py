import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import grounds_eval_runtime as runtime

class UnifiedRuntimeTests(unittest.TestCase):
    def repository(self, root):
        repo = root / 'repo'; repo.mkdir()
        def git(*args): return subprocess.check_output(['git', '-C', str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()
        git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
        (repo / '.grounds/environments').mkdir(parents=True)
        (repo / '.grounds/environments/qa.yaml').write_text('fixture')
        (repo / 'Dockerfile').write_text('FROM python:3.12-alpine\n')
        git('add', '-f', '.'); git('commit', '-qm', 'fixed inputs')
        return {'workspace': str(repo), 'definition': 'qa', 'input_commit': 'sha1:' + git('rev-parse', 'HEAD'), 'branch': 'grounds/qa/fixture'}, git

    def test_unexpected_grader_or_dirty_tree_is_refused_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            task, git = self.repository(Path(temporary))
            self.assertEqual(len(runtime.validate_task_tree(task)['build_inputs']), 2)
            (Path(task['workspace']) / 'private-grader.txt').write_text('hidden')
            with self.assertRaisesRegex(ValueError, 'clean'): runtime.validate_task_tree(task)
            git('add', '.'); git('commit', '-qm', 'private grader')
            task['input_commit'] = 'sha1:' + git('rev-parse', 'HEAD')
            with self.assertRaisesRegex(ValueError, 'allowed runner'): runtime.validate_task_tree(task)

    def test_credential_references_cannot_import_host_paths_or_reserved_env(self):
        base = {'workspace':'/repo','definition':'qa','input_commit':'sha1:'+'a'*40,'branch':'grounds/qa/fixture'}
        for mapping in ({'TOKEN':'/Users/person/.secret'}, {'HOME':'/credentials/home'}, {'KEY':'/credentials/../secret'}):
            with self.assertRaisesRegex(ValueError, 'credential reference'):
                runtime.task_binding({**base, 'credential_env':mapping})
        self.assertEqual(runtime.task_binding({**base,'credential_env':{'KEY':'/credentials/key'}})['credential_env']['KEY'], '/credentials/key')

    def test_handoff_rejects_path_escape_and_symlink(self):
        for name, kind in (('../private', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary); source=root/'bad.tar.gz'
                with tarfile.open(source,'w:gz') as archive:
                    info=tarfile.TarInfo(name); info.type=kind; info.linkname='/etc/passwd'; archive.addfile(info)
                with self.assertRaisesRegex(ValueError,'unsafe'): runtime.unpack(source,root/'out')

    def test_unknown_run_preserves_receipt_without_down_or_relaunch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); task,_=self.repository(root)
            environment={'id':'fixed-env','backend':'docker','trust':'container','directory':str(root/'environment')}
            calls=[]
            def cli(*args):
                calls.append(args)
                if args[0]=='up': return {'environment':environment}
                if args[0]=='run': return {'run':{'id':'fixed-run','state':'running'}}
                self.fail('unknown run must not be cleaned')
            with patch.object(runtime,'cli',side_effect=cli):
                with self.assertRaisesRegex(ValueError,'retained'): runtime.execute(task,'capture',{}, {},root/'out',3)
                with self.assertRaisesRegex(ValueError,'already exists'): runtime.execute(task,'capture',{}, {},root/'out',3)
            self.assertEqual([c[0] for c in calls],['up','run'])
            self.assertEqual(json.loads((root/'out/environment-dispatch.json').read_text())['run']['id'],'fixed-run')
