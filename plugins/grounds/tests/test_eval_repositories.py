import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import grounds_eval_capture as capture
import grounds_eval_environment as env
import grounds_eval_repositories as repositories


class RepositoryMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='grounds-repositories-test-')).resolve()
        self.doc = self.repository('doc', {'guide.md': 'old documentation\n', '.gitignore': 'ignored\n'})
        self.code = self.repository('code', {'main.py': 'SOURCE_ONLY_CANARY\n'})

    def tearDown(self):
        for path in [self.root, *self.root.rglob('*')]:
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | 0o700)
        shutil.rmtree(self.root)

    def repository(self, name, files):
        path = self.root / name
        path.mkdir()
        def git(*args):
            return subprocess.check_output(['/usr/bin/git', '-C', str(path), *args], stderr=subprocess.PIPE)
        git('init', '-q', '-b', 'fixture')
        git('config', 'user.name', 'Fixture')
        git('config', 'user.email', 'fixture@example.test')
        for name, content in files.items():
            (path / name).write_text(content)
        git('add', '.')
        git('commit', '-qm', 'fixture')
        return path

    def freeze(self, name='snapshot', code=False, untracked=False):
        return repositories.snapshot(self.doc, [self.code] if code else [], self.root / name, untracked)

    def stage(self, frozen, mode='doc-only', target='staged'):
        root = self.root / target
        (root / 'workspace').mkdir(parents=True)
        with patch.dict(os.environ, {repositories.BINDING_ENV: frozen['bindings']}):
            repositories.stage(repositories.recipe(mode), env.read(frozen['parameters']), root)
        return root

    def test_dirty_working_tree_and_new_docs_are_bound_by_content_not_only_head(self):
        old = self.freeze('old')
        (self.doc / 'guide.md').write_text('corrected documentation\n')
        (self.doc / 'new.md').write_text('new document\n')
        (self.doc / 'ignored').write_text('not a material')
        new = self.freeze('new', untracked=True)
        self.assertNotEqual(old['snapshot'], new['snapshot'])
        staged = self.stage(new)
        self.assertEqual((staged / 'workspace/doc/guide.md').read_text(), 'corrected documentation\n')
        self.assertTrue((staged / 'workspace/doc/new.md').exists())
        self.assertFalse((staged / 'workspace/doc/ignored').exists())
        self.assertFalse((staged / 'workspace/doc/.git').exists())
        before = env.read(self.root / 'old/snapshot.json')['sources']
        after = env.read(self.root / 'new/snapshot.json')['sources']
        self.assertEqual(before[0]['revision'], after[0]['revision'])
        self.assertNotEqual(before[1]['revision'], after[1]['revision'])
        self.assertEqual((self.root / 'old/workspace/doc/guide.md').read_text(), 'old documentation\n')
        self.assertEqual((self.doc / 'new.md').read_text(), 'new document\n')

    def test_answer_staging_contains_only_docs_even_with_a_mixed_snapshot(self):
        frozen = self.freeze(code=True)
        staged = self.stage(frozen)
        self.assertEqual(sorted(p.name for p in (staged / 'workspace').iterdir()), ['doc'])
        receipt = env.read(staged / 'repository-input.json')
        self.assertEqual([m['role'] for m in receipt['workspace']['materials']], ['doc'])
        self.assertNotIn('code', [s['role'] for s in receipt['sources']])
        both = self.stage(frozen, 'doc-code', 'both')
        self.assertEqual((both / 'workspace/code-1/main.py').read_text(), 'SOURCE_ONLY_CANARY\n')

    def test_existing_output_and_source_overlap_are_refused(self):
        self.freeze()
        with self.assertRaises(FileExistsError):
            self.freeze()
        with self.assertRaisesRegex(ValueError, 'outside'):
            repositories.snapshot(self.doc, [], self.doc / 'output')
        with self.assertRaisesRegex(ValueError, 'overlap'):
            repositories.snapshot(self.doc, [self.doc], self.root / 'overlap')

    def test_untracked_documents_require_explicit_inclusion(self):
        (self.doc / 'new.md').write_text('not yet selected')
        (self.doc / '.env').write_text('fixture-secret')
        self.freeze()
        self.assertFalse((self.root / 'snapshot/workspace/doc/new.md').exists())
        self.freeze('included', untracked=True)
        self.assertFalse((self.root / 'included/workspace/doc/.env').exists())

    def test_missing_deleted_files_are_preserved_as_deletions(self):
        (self.doc / 'guide.md').unlink()
        self.freeze()
        self.assertFalse((self.root / 'snapshot/workspace/doc/guide.md').exists())

    def test_links_lfs_and_submodules_fail_closed(self):
        (self.doc / 'guide.md').unlink()
        (self.doc / 'guide.md').symlink_to(self.code / 'main.py')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.freeze('link')
        (self.doc / 'guide.md').unlink()
        (self.doc / 'guide.md').write_text('version https://git-lfs.github.com/spec/v1\noid fixture')
        with self.assertRaisesRegex(ValueError, 'LFS'):
            self.freeze('lfs')
        (self.doc / 'guide.md').write_text('normal')
        commit = repositories.git(self.code, 'rev-parse', 'HEAD').decode().strip()
        repositories.git(self.doc, 'update-index', '--add', '--cacheinfo', '160000,' + commit + ',nested')
        with self.assertRaisesRegex(ValueError, 'submodules'):
            self.freeze('submodule')

    def test_capture_rejects_a_file_changed_between_passes(self):
        original = repositories.read_file
        changed = False
        def mutate(root, name):
            nonlocal changed
            value = original(root, name)
            if name == 'guide.md' and not changed:
                changed = True
                (root / name).write_text('concurrent change')
            return value
        with patch.object(repositories, 'read_file', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'changed during capture'):
                self.freeze()
        self.assertFalse((self.root / 'snapshot/snapshot.json').exists())

    def test_git_path_aliases_are_rejected_before_filesystem_copy(self):
        blob = repositories.git(self.doc, 'rev-parse', 'HEAD:guide.md').decode().strip()
        repositories.git(self.doc, 'config', 'core.precomposeunicode', 'false')
        cases = [['GUIDE.md'], ['nested/one.md', 'NESTED/two.md'], ['caf\u00e9.md', 'cafe\u0301.md']]
        for index, aliases in enumerate(cases):
            with self.subTest(paths=aliases):
                for alias in aliases:
                    repositories.git(self.doc, 'update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + alias)
                with self.assertRaisesRegex(ValueError, 'path collision'):
                    self.freeze('collision-' + str(index))
                repositories.git(self.doc, 'update-index', '--force-remove', *aliases)

    def test_tampered_snapshot_is_not_reused(self):
        frozen = self.freeze()
        path = self.root / 'snapshot/workspace/doc/guide.md'
        path.chmod(0o600)
        path.write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'files changed'):
            self.stage(frozen)

    def test_digest_binding_and_capability_changes_fail_closed(self):
        frozen = self.freeze()
        root = self.root / 'staged'
        (root / 'workspace').mkdir(parents=True)
        definition = repositories.recipe('doc-only')
        parameters = env.read(frozen['parameters'])
        with patch.dict(os.environ, {repositories.BINDING_ENV: frozen['bindings']}):
            with self.assertRaisesRegex(ValueError, 'binding'):
                repositories.stage(definition, {repositories.PARAMETER: 'sha256:' + '0' * 64}, root)
            for field, value in [('kb', True), ('writable_workspace', True)]:
                altered = {**definition, 'access': {**definition['access'], field: value}}
                with self.assertRaisesRegex(ValueError, 'without KB'):
                    repositories.stage(altered, parameters, root)
            with self.assertRaisesRegex(ValueError, 'without KB'):
                repositories.stage({**definition, 'skills': [{'name': 'graphkb-cli', 'entrypoint': 'SKILL.md'}]}, parameters, root)
            with self.assertRaisesRegex(ValueError, 'required material'):
                repositories.stage(repositories.recipe('doc-code'), parameters, root)

    def test_templates_use_fixed_repository_materials_and_keep_kb_queries(self):
        self.assertEqual(env.template('doc-only', []), repositories.recipe('doc-only'))
        self.assertEqual(env.template('doc-code', [], 'repositories'), repositories.recipe('doc-code'))
        self.assertEqual(env.template('doc-code', []), repositories.recipe('doc-code'))
        self.assertIn('graphkb', env.template('kb-only', [])['script']['content'])
        self.assertFalse(env.template('doc-only', [])['access']['kb'])
        with self.assertRaisesRegex(ValueError, 'network_hosts'):
            env.template('doc-only', ['example.test'])
        with self.assertRaisesRegex(ValueError, 'requires repository'):
            env.template('doc-only', [], 'graphkb')

    def test_doc_only_fixed_staging_excludes_code_and_broker_refuses_kb(self):
        frozen = self.freeze(code=True)
        prepared = self.root/'prepared'; prepared.mkdir(); (prepared/'workspace').mkdir()
        with patch.dict(os.environ, {repositories.BINDING_ENV: frozen['bindings']}):
            repositories.stage(repositories.recipe('doc-only'), env.read(frozen['parameters']), prepared)
        self.assertFalse((prepared/'workspace/code-1').exists())
        self.assertTrue((prepared/'workspace/doc/guide.md').is_file())
        # The only reachable service (the model broker) also refuses GraphKB.
        with capture.Broker({'enable_kb': False, 'model': 'fixture'}, self.root, False) as broker:
            request = urllib.request.Request('http://127.0.0.1:' + str(broker.port) + '/graphkb',
                                             b'["ontology"]', {'Authorization': 'Bearer ' + broker.token})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(error.exception.code, 403)
            self.assertEqual(broker.tool_count, 0)

    def test_environment_validation_requires_explicit_unified_runtime_binding(self):
        frozen = self.freeze()
        parameters = env.read(frozen['parameters'])
        record = {'id':'fixture','version':1,'data':repositories.recipe('doc-only')}
        with patch.dict(os.environ, {repositories.BINDING_ENV: frozen['bindings']}, clear=True):
            with self.assertRaisesRegex(ValueError, 'explicit GROUNDS_EVAL_ENVIRONMENT_TASK'):
                env.validate_definition(record, parameters, {**parameters,'simulate_failure':True}, self.root/'validation')


if __name__ == '__main__':
    unittest.main()
