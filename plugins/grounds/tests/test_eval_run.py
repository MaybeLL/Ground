import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import grounds_eval_run as coordinator


class CoordinatorTests(unittest.TestCase):
    def journal(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        coordinator.atomic_json(root / 'state.json', {
            'experiment': 'e', 'deadline': time.time() + 300,
            'answer_config': {'timeout_seconds': 100},
            'grader_config': {'timeout_seconds': 100},
        })
        return coordinator.Journal(root)

    def test_finished_capture_is_reused_after_submission_failure(self):
        journal = self.journal()
        def capture_run(config, packet, out, grading, deadline=None):
            out.mkdir()
            coordinator.atomic_json(out / 'status.json', {'success': True, 'limitations': []})
        with patch.object(coordinator.capture, 'run', side_effect=capture_run) as run:
            first = journal.model('answer', journal.root / 'public.json', False)
            second = coordinator.Journal(journal.root).model('answer', journal.root / 'public.json', False)
        self.assertEqual(first, second)
        self.assertEqual(run.call_count, 1)

    def test_ambiguous_launch_cannot_automatically_repeat(self):
        journal = self.journal()
        coordinator.atomic_json(journal.root / 'answer.launch.json', {'started': True})
        with patch.object(coordinator.capture, 'run') as run:
            with self.assertRaisesRegex(coordinator.Paused, 'may have started'):
                journal.model('answer', journal.root / 'public.json', False)
        run.assert_not_called()

    def test_lost_receipt_reuses_same_operation_id(self):
        journal = self.journal()
        operations = []
        actual_save = coordinator.atomic_json
        def fail_receipt(path, value):
            if path.name == 'submit.receipt.json':
                raise OSError('simulated lost acknowledgement')
            actual_save(path, value)
        def cli(args, operation):
            operations.append(operation)
            return {'id': 'same-server-record'}
        with patch.object(journal, 'cli', side_effect=cli):
            with patch.object(coordinator, 'atomic_json', side_effect=fail_receipt):
                with self.assertRaises(OSError):
                    journal.call('submit', ['eval', 'artifact', 'submit'], True)
            result = journal.call('submit', ['eval', 'artifact', 'submit'], True)
        self.assertEqual(result['id'], 'same-server-record')
        self.assertEqual(len(operations), 2)
        self.assertEqual(operations[0], operations[1])
        self.assertTrue(operations[0])

    def test_changed_recovery_command_is_rejected(self):
        journal = self.journal()
        with patch.object(journal, 'cli', return_value={'id': 'record'}):
            journal.call('submit', ['original'], True)
            with self.assertRaisesRegex(coordinator.Paused, 'differs'):
                journal.call('submit', ['changed'], True)

    def test_changed_file_after_lost_receipt_is_rejected(self):
        journal = self.journal()
        source = journal.root / 'submission.json'
        source.write_text('{"answer":"original"}')
        with patch.object(journal, 'cli', side_effect=coordinator.Paused('connection lost')):
            with self.assertRaises(coordinator.Paused):
                journal.call('submit', ['eval', 'artifact', 'submit', '--file', str(source)], True)
        source.write_text('{"answer":"modified"}')
        with patch.object(journal, 'cli') as cli:
            with self.assertRaisesRegex(coordinator.Paused, 'differs'):
                journal.call('submit', ['eval', 'artifact', 'submit', '--file', str(source)], True)
        cli.assert_not_called()

    def test_resume_keeps_original_deadline(self):
        journal = self.journal()
        journal.state['deadline'] = time.time() - 1
        with patch.object(coordinator.capture, 'run') as run:
            with self.assertRaisesRegex(coordinator.Paused, 'budget exhausted'):
                journal.model('answer', journal.root / 'public.json', False)
        run.assert_not_called()

    def test_completed_journal_does_not_contact_cli_or_model(self):
        journal = self.journal()
        coordinator.atomic_json(journal.root / 'result.json', {'status': 'completed', 'report': 'report'})
        with patch.object(journal, 'cli') as cli, patch.object(coordinator.capture, 'run') as run:
            self.assertEqual(journal.execute()['status'], 'completed')
        cli.assert_not_called()
        run.assert_not_called()


    def test_managed_ambiguous_launch_records_unknown_and_never_repeats(self):
        from unittest.mock import MagicMock
        journal=self.journal();journal.managed=MagicMock()
        coordinator.atomic_json(journal.root/'answer.launch.json',{'started':True})
        with patch.object(coordinator.capture,'run') as run:
            with self.assertRaisesRegex(coordinator.Paused,'may have started'):
                journal.model('answer',journal.root/'public.json',False)
        run.assert_not_called()
        journal.managed.mark_model_unknown.assert_called_once_with('answer',journal.root/'answer')


if __name__ == '__main__':
    unittest.main()
