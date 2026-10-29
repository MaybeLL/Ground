import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from types import SimpleNamespace
import threading

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
capture = load('grounds_eval_capture')
converter = load('grounds_eval_import')

class CaptureTests(unittest.TestCase):
    def test_answer_contract_records_claim_source_diagnostics_without_erasing_answer(self):
        claim = 'GetInstalmentInfoList 的契约位于 credit_risk_credit.proto'
        valid, answer, coverage, limitations = capture.validate_answer_contract({
            'answer': claim,
            'citations': [{
                'claim': claim,
                'content': 'credit_risk_credit.proto declares GetInstalmentInfoList.',
                'locator': 'material-v1:doc/credit-application-lifecycle.md#L21-L21',
            }],
        })
        self.assertTrue(valid)
        self.assertEqual(answer['citations'], [{'content': 'credit_risk_credit.proto declares GetInstalmentInfoList.', 'locator': 'material-v1:doc/credit-application-lifecycle.md#L21-L21'}])
        self.assertEqual(coverage[0]['claim'], claim)
        self.assertEqual(limitations, [])

        valid, answer, _, limitations = capture.validate_answer_contract({
            'answer': claim,
            'citations': [{
                'claim': claim,
                'content': 'func (h *Handler) GetInstalmentInfoList() {}',
                'locator': 'material-v1:code/handler.go#L64-L64',
            }],
        })
        self.assertTrue(valid)
        self.assertEqual(answer, {
            'answer': claim,
            'citations': [{
                'content': 'func (h *Handler) GetInstalmentInfoList() {}',
                'locator': 'material-v1:code/handler.go#L64-L64',
            }],
        })
        self.assertIn('citation 1 does not directly support claim anchors: credit_risk_credit.proto', limitations)

    def test_answer_contract_records_unmapped_claim_without_erasing_answer(self):
        valid, answer, _, limitations = capture.validate_answer_contract({
            'answer': 'Only this sentence is in the answer.',
            'citations': [{
                'claim': 'A different sentence.',
                'content': 'A different sentence.',
                'locator': 'material-v1:doc/evidence.md#L1-L1',
            }],
        })
        self.assertTrue(valid)
        self.assertEqual(answer['answer'], 'Only this sentence is in the answer.')
        self.assertIn('citation 1 claim is not an exact substring of the answer', limitations)

    def test_answer_contract_allows_empty_citations(self):
        valid, answer, coverage, diagnostics = capture.validate_answer_contract({
            'answer': 'A concise answer without presentation citations.',
            'citations': [],
        })
        self.assertTrue(valid)
        self.assertEqual(answer, {
            'answer': 'A concise answer without presentation citations.',
            'citations': [],
        })
        self.assertEqual(coverage, [])
        self.assertEqual(diagnostics, [])

    def native_fixture(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'\xcf\xfa\xed\xfe' + b'fixture')
        path.chmod(0o700)
        return path

    def test_runtime_resolves_native_and_npm_without_exposing_install_prefix(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(capture.platform, 'machine', return_value='arm64'):
            root = Path(directory).resolve()
            standalone = self.native_fixture(root / 'standalone/bin/codex')
            (root / 'standalone/codex-package.json').write_text('{}')
            self.assertEqual(capture.resolve_codex_runtime(str(standalone)), (str(standalone), str(root / 'standalone')))
            package = root / 'node_modules/@openai/codex'
            (package / 'bin').mkdir(parents=True)
            launcher = package / 'bin/codex.js'
            launcher.write_text('#!/usr/bin/env node')
            (package / 'package.json').write_text('{"name":"@openai/codex"}')
            runtime = root / 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin'
            binary = self.native_fixture(runtime / 'bin/codex')
            self.assertEqual(capture.resolve_codex_runtime(str(launcher)), (str(binary), str(runtime)))
            binary.unlink()
            legacy = self.native_fixture(package / 'vendor/aarch64-apple-darwin/codex/codex')
            self.assertEqual(capture.resolve_codex_runtime(str(launcher)), (str(legacy), str(legacy.parent.parent)))
            legacy.unlink()
            with self.assertRaisesRegex(ValueError, 'optional dependency'):
                capture.resolve_codex_runtime(str(launcher))
            with self.assertRaisesRegex(ValueError, 'absolute'):
                capture.resolve_codex_runtime('codex')

    def test_tool_budget_has_explicit_preserved_marker(self):
        broker = object.__new__(capture.Broker)
        broker.lock = threading.Lock(); broker.closing = False
        broker.tool_count = 1; broker.config = {'max_tool_calls': 1}; broker.failures = []
        with self.assertRaisesRegex(ValueError, 'budget exhausted'):
            broker.graphkb(['ontology'])
        self.assertEqual(broker.failures, ['tool_call_budget_exhausted'])

    def test_grading_run_emits_recoverable_raw_evidence_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {'auth_mode': 'codex-login', 'model': 'm', 'timeout_seconds': 1, 'codex_command': sys.executable, 'codex_version': 'fixture'}
            (root / 'config.json').write_text(json.dumps(config))
            (root / 'context.json').write_text(json.dumps({'execution_id': 'exec', 'context_digest': 'digest', 'artifact': {'files': []}}))
            def fake_capture(command, env, out, prompt, timeout):
                result = {'session_id': 'session', 'started_at': '2026-01-01T00:00:00Z', 'finished_at': '2026-01-01T00:00:01Z', 'exit_code': 0, 'terminal': True, 'usage': None, 'limitations': [], 'final': json.dumps({'status': 'completed', 'outcome': {'kind': 'qa_decision', 'verdict': 'pass'}, 'explanation': 'ok', 'evidence': [{'kind':'observation','content':'saved answer matches the reference'}]})}
                (out / 'events.jsonl').write_text('raw fixture')
                (out / 'stderr.txt').write_text('')
                capture.save(out / 'capture.json', result)
                return result
            broker = MagicMock(token='ephemeral', port=12345, failures=[], revisions=set())
            broker.__enter__.return_value = broker
            with patch.object(capture, 'Broker', return_value=broker), patch.object(capture.platform, 'system', return_value='Darwin'), patch.object(capture, 'model_credentials', return_value=('', {})), patch.object(capture, 'preflight'), patch.object(capture, 'resolve_codex_runtime', return_value=('/fixture/codex', '/fixture/codex')), patch.object(capture.subprocess, 'run', return_value=SimpleNamespace(stdout='fixture')), patch.object(capture, 'capture', side_effect=fake_capture):
                capture._run_in_task(root / 'config.json', root / 'context.json', root / 'out', grading=True)
            manifest = json.loads((root / 'out/grading-evidence.json').read_text())
            self.assertEqual(manifest['execution_id'], 'exec')
            self.assertEqual(manifest['execution']['session_id'], 'session')
            self.assertEqual(manifest['capture']['coverage'], 'complete')
            self.assertEqual({entry['name'] for entry in manifest['files']}, {'events.jsonl', 'stderr.txt', 'capture.json', 'prompt.txt'})
            for entry in manifest['files']:
                data = (root / 'out' / entry['name']).read_bytes()
                self.assertEqual(entry['digest'], capture.digest(data))
                self.assertEqual(entry['size'], len(data))

    def test_unavailable_usage_is_omitted_from_import_metadata(self):
        metadata = capture.observed_metadata('codex-cli test', None, set(), {'usage': None}, {'model': 'm', 'auth_mode': 'codex-login'})
        self.assertNotIn('usage', metadata)
        self.assertNotIn('graphkb_version', metadata)
        self.assertEqual(metadata['auth_mode'], 'codex-login')
        self.assertEqual(metadata['requested_model'], 'm')
        self.assertNotIn('model', metadata)
        observed = capture.observed_metadata('test', '1', {'r'}, {'usage': {'input_tokens': 0}}, {'model': 'm'})
        self.assertEqual(observed['usage']['input_tokens'], 0)

    def test_interrupted_turn_does_not_promote_progress_to_answer(self):
        events = [{'type': 'thread.started', 'thread_id': 't'}, {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'I will inspect the task'}}, {'type': 'turn.failed', 'error': {'message': 'at capacity'}}]
        result, out = self.execute('import json; events=' + repr(events) + '; [print(json.dumps(e)) for e in events]')
        self.assertIsNone(result['final'])
        self.assertFalse(result['terminal'])
        self.assertIn('I will inspect the task', (out / 'events.jsonl').read_text())
    def test_codex_login_credentials_stay_at_fixed_service(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'private-token', 'account_id': 'account'}}))
            url, headers = capture.model_credentials({'auth_mode': 'codex-login', 'codex_home': directory})
            self.assertEqual(url, 'https://chatgpt.com/backend-api/codex/responses')
            self.assertEqual(headers['Authorization'], 'Bearer private-token')
            settings = capture.codex_settings('m', 12345)
            self.assertNotIn('private-token', settings)
            self.assertNotIn(directory, settings)
            Path(directory, 'auth.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'existing ChatGPT'):
                capture.model_credentials({'auth_mode': 'codex-login', 'codex_home': directory})

    def test_graphkb_forces_json_and_refuses_profile_override(self):
        with tempfile.TemporaryDirectory() as directory:
            broker = object.__new__(capture.Broker)
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                broker.graphkb(['get', 'x', '--profile', 'private'])

    def execute(self, code, timeout=5):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        out = Path(temporary.name)
        result = capture.capture([sys.executable, '-c', code], dict(os.environ), out, '', timeout)
        return result, out
    def test_observable_events_and_raw_bytes_are_preserved(self):
        events = [{'type':'thread.started','thread_id':'thread-1'}, {'type':'item.completed','item':{'type':'agent_message','text':'{"answer":"done","citations":[]}'}}, {'type':'turn.completed','usage':{'input_tokens':20,'output_tokens':5}}]
        code = 'import json; events=' + repr(events) + '; [print(json.dumps(e),flush=True) for e in events]'
        result, out = self.execute(code)
        self.assertEqual(result['session_id'], 'thread-1'); self.assertTrue(result['terminal']); self.assertEqual(result['limitations'], [])
        self.assertEqual(result['usage']['input_tokens'], 20)
        self.assertEqual([json.loads(line) for line in (out / 'events.jsonl').read_text().splitlines()], events)
    def test_unknown_events_and_missing_terminal_are_not_complete(self):
        result, out = self.execute('print(\'{"type":"future.event"}\'); print("broken")')
        self.assertIn('missing turn.completed', result['limitations']); self.assertIn('invalid JSONL event', result['limitations'])
        self.assertIn('unknown event: future.event', result['limitations']); self.assertTrue((out / 'capture.json').exists())
    def test_timeout_preserves_partial_evidence_without_retry(self):
        result, out = self.execute('import time; print(\'{"type":"turn.started"}\',flush=True); time.sleep(10)', .2)
        self.assertNotEqual(result['exit_code'], 0); self.assertIn('execution timeout', result['limitations'])
        self.assertIn('turn.started', (out / 'events.jsonl').read_text())
    def test_model_broker_does_not_enable_hosted_search_or_remote_media(self):
        self.assertTrue(capture.model_request_allowed({'model': 'm', 'tools': [{'type': 'function'}]}, 'm'))
        self.assertFalse(capture.model_request_allowed({'model': 'other'}, 'm'))
        self.assertFalse(capture.model_request_allowed({'model': 'm', 'tools': [{'type': 'web_search'}]}, 'm'))
        self.assertFalse(capture.model_request_allowed({'model': 'm', 'input': [{'type': 'input_image', 'image_url': 'https://private-source'}]}, 'm'))
        self.assertFalse(capture.model_request_allowed({'model': 'm', 'input': [{'type': 'input_file', 'file_url': 'https://private-source'}]}, 'm'))
        self.assertTrue(capture.model_request_allowed({'model': 'm', 'input': [{'type': 'input_image', 'image_url': 'data:image/png;base64,AA=='}]}, 'm'))
    def test_deadline_is_rechecked_after_preparation(self):
        with patch.object(capture.time, 'time', return_value=100):
            self.assertEqual(capture.remaining_timeout(60, 105), 5)
            self.assertEqual(capture.remaining_timeout(2, 105), 2)
            self.assertEqual(capture.remaining_timeout(60), 60)
        with patch.object(capture.time, 'time', return_value=106):
            with self.assertRaisesRegex(ValueError, 'before model launch'):
                capture.remaining_timeout(60, 105)

    def test_early_exit_preserves_broken_pipe_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            result = capture.capture([sys.executable, '-c', 'import sys; print("early failure", file=sys.stderr); sys.exit(3)'], dict(os.environ), directory, 'x' * (1024 * 1024), 5)
            self.assertEqual(result['exit_code'], 3)
            self.assertIn('process exited before accepting prompt', result['limitations'])
            self.assertIn('early failure', Path(directory, 'stderr.txt').read_text())
            self.assertEqual(json.loads(Path(directory, 'capture.json').read_text()), result)
            self.assertIsNone(result['final'])

    def test_launch_failure_is_preserved_as_execution_error(self):
        with tempfile.TemporaryDirectory() as directory:
            result = capture.capture(['/nonexistent/grounds-fixture'], dict(os.environ), directory, '', 1)
            self.assertEqual(result['exit_code'], 127)
            self.assertIn('process launch failed', result['limitations'][0])
            self.assertTrue((Path(directory) / 'capture.json').exists())
    def test_completed_directory_cannot_be_overwritten(self):
        result, out = self.execute('print(\'{"type":"turn.completed"}\')')
        with self.assertRaises(FileExistsError): capture.save(out / 'capture.json', {})
    def test_real_codex_failure_fixture_is_an_error_not_an_answer(self):
        raw = (Path(__file__).parent / 'fixtures/codex-0.154.0-local-transport-failure.jsonl').read_text()
        result, _ = self.execute('import sys; sys.stdout.write(' + repr(raw) + ')')
        self.assertNotEqual(result['session_id'], 'unavailable')
        self.assertIn('turn.failed', result['limitations'])
        self.assertFalse(result['terminal']); self.assertIsNone(result['final'])
    def test_converter_preserves_full_private_source_and_excludes_retrieval(self):
        row = {key: '[]' if key in converter.ARRAYS else '' for key in converter.COLUMNS}
        row.update(id='q1', collection='business-qa', applicable_evaluations='["qa"]', enabled='true', question='Question', expected_answer='Private reference', required_points='["Point"]', forbidden_claims='["Forbidden"]', reference='["source:line"]', source_records='[{"id":"legacy"}]')
        retrieval = {**row, 'id':'r1', 'applicable_evaluations':'["retrieval"]', 'collection':'retrieval'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'samples.csv'
            with path.open('w') as f:
                writer = csv.DictWriter(f, fieldnames=sorted(row)); writer.writeheader(); writer.writerows([row, retrieval])
            drafts = converter.convert(path, 'repo', 'revision'); self.assertEqual(len(drafts), 1)
            qa = drafts[0]; self.assertEqual(qa['reference_answer'], row['expected_answer']); self.assertEqual(qa['source']['record']['source_records'], [{'id':'legacy'}]); self.assertEqual(qa['forbidden_claims'], ['Forbidden'])
            self.assertNotIn('Private reference', qa['instructions']); self.assertEqual(converter.convert(path, 'repo', 'revision'), drafts)
    def test_converter_rejects_unknown_columns_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.csv'; path.write_text('unknown\nx\n')
            with self.assertRaises(ValueError): converter.convert(path, 'repo', 'rev')

if __name__ == '__main__': unittest.main()
