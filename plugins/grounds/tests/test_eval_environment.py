import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import grounds_eval_environment as env
import grounds_eval_capture as capture


def cleanup_tree(root):
    for path in [root,*root.rglob('*')]:
        if not path.is_symlink(): path.chmod(path.stat().st_mode|0o200)


class EnvironmentTests(unittest.TestCase):
    def test_preparation_contract_digest_matches_typescript_golden_vector(self):
        definition={'format':'grounds.eval-environment/v1','name':'x','task_kind':'qa','role':'answer','parameters':{'n':{'type':'number','required':True}},
                    'script':{'interpreter':'/bin/sh','content':'exit 0'},'execution':{'backend':'macos','timeout_seconds':60,'network_hosts':[]},
                    'access':{'read_roles':[],'kb':False,'writable_workspace':False},'skills':[{'name':'graphkb-cli','entrypoint':'SKILL.md'}]}
        self.assertEqual(env.preparation_contract_digest(definition,{'n':1.5}, {'name':'macos','version':'1','platform':'darwin'}),'sha256:460f7f16fbec2626bab5c51052662be1378b5c7918d117e2bff1e37039f4e02f')

    def test_git_credentials_are_exact_https_repositories_and_operator_local(self):
        from grounds_eval_prepare_proxy import load_git_credentials
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); secret = root/'secret'; config = root/'config'
            secret.write_text('GitLab token\nfixture-secret\n')
            entry = {'repository':'https://git.example.test/team/repo.git',
                     'token_file':str(secret),'token_line':2,
                     'source_identity':'git.example.test:2222/team/repo'}
            config.write_text(json.dumps([entry]))
            with patch.dict(os.environ, {'GROUNDS_PREPARE_GIT_CREDENTIALS':str(config)}):
                self.assertEqual(load_git_credentials(['git.example.test']),
                                 {entry['repository']:'fixture-secret'})
                aliases = {}
                load_git_credentials(['git.example.test'], aliases)
                self.assertEqual(aliases, {entry['source_identity']:entry['repository']})
                self.assertEqual(load_git_credentials([]), {})
                for url in ('http://git.example.test/team/repo.git',
                            'https://git.example.test/team/../repo.git',
                            'https://git.example.test/team/repo.git?token=bad'):
                    config.write_text(json.dumps([{**entry,'repository':url}]))
                    with self.assertRaises(ValueError): load_git_credentials(['git.example.test'])

    def test_git_proxy_restricts_endpoints_and_hides_upstream_errors(self):
        import http.client
        from unittest.mock import MagicMock
        from grounds_eval_prepare_proxy import PreparationProxy
        remote = 'https://git.example.test/team/repo.git'
        upstream = MagicMock(); response = upstream.getresponse.return_value
        response.status = 302
        with PreparationProxy(['git.example.test'], {remote:'fixture-secret'}) as proxy:
            with patch('grounds_eval_prepare_proxy.http.client.HTTPSConnection',return_value=upstream):
                for path, status in [('/0.git/git-receive-pack',403),
                                     ('/1.git/info/refs?service=git-upload-pack',403),
                                     ('/0.git/../api/v4/user',403),
                                     ('/0.git/info/refs?service=git-upload-pack',502)]:
                    connection=http.client.HTTPConnection('127.0.0.1',proxy.port,timeout=5)
                    connection.request('GET','http://grounds-git.invalid'+path)
                    reply=connection.getresponse()
                    self.assertEqual(reply.status,status)
                    self.assertNotIn(b'fixture-secret',reply.read());connection.close()
                self.assertEqual(upstream.request.call_count,1)
                args=upstream.request.call_args.args
                self.assertEqual(args[1],'/team/repo.git/info/refs?service=git-upload-pack')
                self.assertIn('Authorization',args[3])

    def test_manifest_rejects_symlinks_and_unmaterialized_lfs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'escape').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError,'file type'): env.manifest(root)
            (root/'escape').unlink(); (root/'pointer').write_text('version https://git-lfs.github.com/spec/v1\noid sha256:abc')
            with self.assertRaisesRegex(ValueError,'LFS'): env.manifest(root)

    def test_evidence_is_actual_file_content_and_cannot_escape_or_cross_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'code').mkdir(); (root/'doc').mkdir()
            (root/'code/a.go').write_text('first\nsecond\n'); (root/'doc/private').write_text('not exposed')
            materials=[{'id':'code','role':'code','path':'code'}]; tree=env.manifest(root)
            citations=[{'locator':'material-v1:code/a.go#L1-L1','content':'invented'},
                       {'locator':'material-v1:code/%2e%2e/doc/private#L1-L1'},
                       {'locator':'material-v1:doc/private#L1-L1'}]
            result=env.material_evidence(citations,root,materials,tree)
            self.assertEqual(result[0]['content'],'first\n'); self.assertIn('error',result[1]); self.assertIn('error',result[2])
            (root/'code/a.go').write_text('changed')
            with self.assertRaisesRegex(ValueError,'changed'): env.material_evidence(citations,root,materials,tree)

    def test_result_rejects_overlapping_roles_and_foreign_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'workspace/code/doc').mkdir(parents=True)
            r={'format':'grounds.environment-preparation-result/v1','attempt_id':'one','status':'success',
               'workspace':{'root':'workspace','materials':[{'id':'code','role':'code','path':'code'},{'id':'doc','role':'doc','path':'code/doc'}]},'tools':[],'sources':[]}
            with self.assertRaisesRegex(ValueError,'overlap'): env.validate_result(r,root,'one')
            with self.assertRaisesRegex(ValueError,'attempt'): env.validate_result(r,root,'two')

    def test_skill_bundle_is_enriched_as_a_complete_directory_and_staged_by_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); workspace=root/'workspace'; skill=workspace/'skills/graphkb-cli'
            (skill/'references').mkdir(parents=True);(skill/'scripts').mkdir();(skill/'assets').mkdir()
            (skill/'SKILL.md').write_text('---\nname: graphkb-cli\ndescription: Query the frozen graph.\n---\n\n# GraphKB\n')
            (skill/'references/query.md').write_text('query reference\n');(skill/'scripts/query.sh').write_text('#!/bin/sh\n');(skill/'scripts/query.sh').chmod(0o755);(skill/'assets/example.json').write_text('{}\n')
            result={'format':'grounds.environment-preparation-result/v1','attempt_id':'one','status':'success',
                    'workspace':{'root':'workspace','materials':[]},'tools':[],'sources':[],
                    'skills':[{'name':'graphkb-cli','root':'skills/graphkb-cli','entrypoint':'SKILL.md'}]}
            definition={**env.template('kb-only',[]),'skills':[{'name':'graphkb-cli','entrypoint':'SKILL.md'}]}
            env.validate_result(result,root,'one');env.enrich_skills(result,root,definition)
            receipt=result['skills'][0];self.assertEqual(receipt['file_count'],4);self.assertEqual(receipt['bundle_digest'],env.digest(env.manifest(skill)))
            prepared={'workspace':str(workspace),'skills':result['skills'],'required_skills':['graphkb-cli']}
            scratch=root/'scratch';scratch.mkdir();staged,skill_root=capture.stage_skills(prepared,scratch)
            self.assertEqual([x['name'] for x in staged],['graphkb-cli']);self.assertEqual(env.digest(env.manifest(skill_root/'graphkb-cli')),receipt['bundle_digest'])
            self.assertEqual((skill_root/'graphkb-cli/scripts/query.sh').stat().st_mode & 0o222,0)
            (skill/'references/query.md').chmod(0o644);(skill/'references/query.md').write_text('tampered\n')
            other=root/'other';other.mkdir()
            with self.assertRaisesRegex(ValueError,'digest'):capture.stage_skills(prepared,other)

    def test_skill_frontmatter_and_raw_script_receipt_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); skill=root/'workspace/skills/graphkb-cli';skill.mkdir(parents=True)
            (skill/'SKILL.md').write_text('---\nname: wrong\ndescription: mismatch\n---\n')
            result={'format':'grounds.environment-preparation-result/v1','attempt_id':'one','status':'success','workspace':{'root':'workspace','materials':[]},'tools':[],'sources':[],
                    'skills':[{'name':'graphkb-cli','root':'skills/graphkb-cli','entrypoint':'SKILL.md'}]}
            definition={**env.template('kb-only',[]),'skills':[{'name':'graphkb-cli','entrypoint':'SKILL.md'}]}
            env.validate_result(result,root,'one')
            with self.assertRaisesRegex(ValueError,'name/description'):env.enrich_skills(result,root,definition)
            result['skills'][0]['bundle_digest']=env.digest([])
            with self.assertRaisesRegex(ValueError,'fields'):env.validate_result(result,root,'one')

    def test_usage_aggregates_turns_without_turning_missing_into_zero(self):
        self.assertEqual(capture.normalized_usage([{'input_tokens':5,'output_tokens':2,'cached_input_tokens':3},{'input_tokens':8,'output_tokens':1,'cached_input_tokens':4}]),{'input_tokens':13,'output_tokens':3,'cached_input_tokens':7})
        self.assertIsNone(capture.normalized_usage([None])); self.assertIsNone(capture.normalized_usage([]))
        self.assertIsNone(capture.normalized_usage([{'input_tokens':True,'output_tokens':3}]))
        self.assertNotIn('cached_input_tokens',capture.normalized_usage([{'input_tokens':5,'output_tokens':2}]))

    def test_unified_preparation_refuses_unbound_host_and_historical_backend(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'explicit GROUNDS_EVAL_ENVIRONMENT_TASK'):
                env.prepare(env.template('grade', []), {}, root/'work', root/'evidence', 'a:1')
            legacy = env.template('grade', []); legacy['execution']['backend'] = 'macos'
            with self.assertRaisesRegex(ValueError, 'requires docker'):
                env.prepare(legacy, {}, root/'legacy', root/'legacy-evidence', 'a:2')

    def test_new_definitions_cannot_claim_retired_network_host_enforcement(self):
        with self.assertRaisesRegex(ValueError, 'network_hosts must be empty'):
            env.template('code', ['example.test'])
        self.assertEqual(env.template('grade', [])['execution']['backend'], 'docker')

    def test_interrupted_recovery_never_signals_unbound_worker_pid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); env.save(root/'process.json', {'pid':12345,'signature':'original','started_at':0})
            with patch.object(env, 'stop_group') as kill:
                with self.assertRaisesRegex(ValueError, 'ownership unknown'):
                    env.recover_interrupted(root/'work', root, 'a:1')
                kill.assert_not_called()

    def test_partial_turn_usage_is_unknown_and_raw_completed_turn_is_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            events=[{'type':'thread.started','thread_id':'fixture'}, {'type':'turn.completed','usage':{'input_tokens':10,'output_tokens':2}}, {'type':'turn.started'}, {'type':'turn.failed','error':{'message':'interrupted'}}]
            script='import json; [print(json.dumps(e)) for e in '+repr(events)+']'
            result=capture.capture([sys.executable,'-c',script],dict(os.environ),tmp,'',5)
            self.assertIsNone(result['usage'])
            self.assertIn('"input_tokens": 10',(Path(tmp)/'events.jsonl').read_text())

    def test_broker_enforces_kb_capability_even_with_a_valid_session_token(self):
        import urllib.request
        import urllib.error
        for grading,enabled,expected in [(False,False,403),(True,True,403),(False,True,200)]:
            with tempfile.TemporaryDirectory() as tmp,capture.Broker({'enable_kb':enabled},Path(tmp),grading) as broker:
                with patch.object(broker,'graphkb',return_value={'fixture':True}) as query:
                    request=urllib.request.Request('http://127.0.0.1:'+str(broker.port)+'/graphkb',data=b'["ontology"]',headers={'Authorization':'Bearer '+broker.token,'Content-Type':'application/json'})
                    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    try:
                        with opener.open(request,timeout=5) as response:status=response.status
                    except urllib.error.HTTPError as error:status=error.code;error.close()
                    self.assertEqual(status,expected)
                    self.assertEqual(query.call_count,1 if expected==200 else 0)

    def test_prepare_proxy_rejects_hosts_outside_allowlist(self):
        import http.client
        from grounds_eval_prepare_proxy import PreparationProxy
        with PreparationProxy(['127.0.0.1']) as proxy:
            connection=http.client.HTTPConnection('127.0.0.1',proxy.port,timeout=5)
            connection.request('GET','http://undeclared.invalid/resource')
            response=connection.getresponse();self.assertEqual(response.status,403);response.read();connection.close()

    def test_grader_output_requires_typed_judgment_and_supporting_evidence(self):
        self.assertFalse(capture.valid_grading_answer({'unexpected':'value'}))
        answer={'status':'completed','outcome':{'kind':'qa_decision','verdict':'pass'},'explanation':'checked','evidence':[]}
        self.assertFalse(capture.valid_grading_answer(answer))
        answer['evidence']=[{'kind':'observation','content':'saved evidence matches reference'}]
        self.assertTrue(capture.valid_grading_answer(answer))
        self.assertTrue(capture.valid_grading_answer({**answer,'outcome':{'kind':'inconclusive','reason':'missing evidence'},'evidence':[]}))


    def test_git_tree_checks_names_before_case_insensitive_checkout_can_hide_collisions(self):
        env.validate_git_tree(b'100644 blob abc\tcode/a.go\0' + b'100644 blob def\tcode/b.go\0')
        for data in [b'100644 blob a\tCode/a.go\0' + b'100644 blob b\tcode/b.go\0',
                     b'100644 blob a\tfile.go\0' + b'100644 blob b\tFILE.go\0',
                     b'160000 commit a\tsubmodule\0', b'120000 blob a\tlink\0']:
            with self.assertRaises(ValueError):env.validate_git_tree(data)
