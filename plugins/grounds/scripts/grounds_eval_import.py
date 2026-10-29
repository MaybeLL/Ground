#!/usr/bin/env python3
"""Convert business-qa CSV into Grounds QA contracts; preview by default.
Only --apply writes to the explicitly supplied Grounds configuration. Changed
records require --update; complete original rows remain private source metadata.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

COLUMNS = set('id applicable_evaluations collection category scenario split question query_form kind types snapshot retrieval_expectation expected_targets forbidden_targets expected_answer required_points forbidden_claims reference reason distractors enabled source_records'.split())
ARRAYS = set('applicable_evaluations types expected_targets forbidden_targets required_points forbidden_claims reference distractors source_records'.split())
RUBRIC = ('Assess the answer against required_points and forbidden_claims. Pass: all required points are correct and no forbidden claim. Partial: substantively correct but incomplete. Fail: central answer is wrong or asserts a forbidden claim. Inconclusive: frozen evidence cannot resolve the dimension. Check citations against the captured source content; do not look up live sources. Explain the relevant missing points or contradictions; reference_answer is a reference, not independent verification of business truth.')

def convert(path, repository, revision):
    with open(path, newline='', encoding='utf-8-sig') as stream:
        reader = csv.DictReader(stream)
        if set(reader.fieldnames or []) != COLUMNS or len(reader.fieldnames or []) != len(COLUMNS): raise ValueError('CSV columns differ from the supported source contract')
        rows = list(reader)
    seen = set(); drafts = []
    for raw in rows:
        if not raw['id'] or None in raw: raise ValueError('invalid source row')
        if raw['id'] in seen: raise ValueError('duplicate source ID: ' + raw['id'])
        seen.add(raw['id'])
        row = {k: json.loads(v) if k in ARRAYS else v for k, v in raw.items()}
        if any(not isinstance(row[k], list) for k in ARRAYS): raise ValueError('array annotation expected')
        if row['collection'] != 'business-qa' or 'qa' not in row['applicable_evaluations']: continue
        if row['enabled'] not in ('true', 'false'): raise ValueError('invalid enabled value')
        if row['enabled'] != 'true': continue
        if not row['question'] or not row['required_points']: raise ValueError('question and rubric annotations are required')
        encoded = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        drafts.append({'format': 'grounds.eval-qa/v1', 'name': row['id'], 'question': row['question'], 'instructions': 'Answer the question. Include supporting quoted content and source locators when available; state uncertainty when evidence is insufficient.', 'rubric': RUBRIC, **({'reference_answer': row['expected_answer']} if row['expected_answer'] else {}), 'required_points': row['required_points'], 'forbidden_claims': row['forbidden_claims'], 'references': row['reference'], 'source': {'identity': repository + ':business-qa:' + row['id'], 'repository': repository, 'revision': revision, 'path': 'evals/samples.csv', 'digest': 'sha256:' + hashlib.sha256(encoded).hexdigest(), 'record': row}})
    return drafts

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--csv', required=True); p.add_argument('--repository', required=True); p.add_argument('--revision', required=True)
    p.add_argument('--out', required=True); p.add_argument('--grounds-command', default='grounds'); p.add_argument('--config')
    p.add_argument('--apply', action='store_true'); p.add_argument('--update', action='store_true')
    args = p.parse_args(); out = Path(args.out); out.mkdir(mode=0o700)
    drafts = convert(args.csv, args.repository, args.revision)
    if not drafts: raise ValueError('no enabled business QA tasks')
    (out / 'import-manifest.json').write_text(json.dumps({'source_file_sha256': 'sha256:' + hashlib.sha256(Path(args.csv).read_bytes()).hexdigest(), 'repository': args.repository, 'revision': args.revision, 'records': [{'identity': d['source']['identity'], 'record_digest': d['source']['digest']} for d in drafts]}, indent=2) + '\n')
    def invoke(command, write=False):
        call = [args.grounds_command, '--config', args.config, '--json', *command]
        if write: call += ['--operation-id', str(uuid7()), '--agent-id', 'qa-import', '--agent-name', 'QA import coordinator']
        response = subprocess.run(call, text=True, capture_output=True)
        value = json.loads(response.stdout)
        if response.returncode or not value.get('ok'): raise RuntimeError(json.dumps(value))
        return value['data']['payload']
    if args.apply and not args.config: raise ValueError('--apply requires an explicit --config')
    existing = invoke(['eval', 'qa', 'list']) if args.config else []
    by_source = {r['data']['source']['identity']: r for r in existing}
    changes = []
    for index, draft in enumerate(drafts):
        path = out / ('qa-%03d.json' % index); path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + '\n'); path.chmod(0o600)
        old = by_source.get(draft['source']['identity'])
        state = 'new' if old is None else 'unchanged' if old['data'] == draft else 'changed'
        changes.append({'name': draft['name'], 'state': state, 'file': str(path.resolve()), 'previous': old, 'next': draft})
    (out / 'diff.json').write_text(json.dumps(changes, ensure_ascii=False, indent=2) + '\n')
    if args.apply and any(c['state'] == 'changed' for c in changes) and not args.update: raise ValueError('changed content requires --update; review diff.json')
    records = []
    if args.apply:
        for c in changes:
            if c['state'] == 'unchanged': records.append(c['previous']); continue
            command = ['eval', 'qa', 'publish']
            if c['previous']: command += [c['previous']['id'], '--expected-version', str(c['previous']['version'])]
            command += ['--file', c['file']]
            record = invoke(command, True); records.append(record)
            # Persist progress after each successful write; rerunning compares source identity.
            (out / 'records.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
        (out / 'records.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'count': len(drafts), 'applied': args.apply, 'changes': {s: sum(c['state'] == s for c in changes) for s in ('new', 'changed', 'unchanged')}, 'out': str(out.resolve())}))

def uuid7():
    import time
    value = (int(time.time() * 1000) << 80) | (7 << 76) | (int.from_bytes(__import__('os').urandom(2), 'big') & 0xfff) << 64 | (2 << 62) | (int.from_bytes(__import__('os').urandom(8), 'big') & ((1 << 62) - 1))
    return uuid.UUID(int=value)

if __name__ == '__main__': main()
