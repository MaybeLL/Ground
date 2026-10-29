"""Real Docker QA fixture; no online model or user credentials.
Run: python3 plugins/grounds/tests/eval_docker_fixture.py --out NEW_DIRECTORY --grounds /absolute/grounds
"""
import sys,os,json,subprocess,shutil,argparse
node=shutil.which('node')
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',required=True);parser.add_argument('--grounds',required=True);args=parser.parse_args()
root=Path(args.out).resolve();root.mkdir(mode=0o700)
repo=root/'runner';(repo/'.grounds/environments').mkdir(parents=True,exist_ok=True)
(repo/'.grounds/environments/qa.yaml').write_text('''format: grounds.environment-definition/v1
name: qa
backend: docker
repositories:
  - name: runner
    path: .
requirements:
  network: allowed
base:
  image:
    dockerfile: Dockerfile
    context: .
tools: [python3, git]
''')
(repo/'Dockerfile').write_text('FROM node:22-bookworm\nENV GROUNDS_FIXTURE_TOKEN=public-test-token-not-a-credential\nCOPY agent.py /usr/local/bin/fixture-agent\nRUN chmod 755 /usr/local/bin/fixture-agent\n')
(repo/'agent.py').write_text('''#!/usr/bin/python3
import json,sys,subprocess,pathlib
if '--version' in sys.argv: print('grounds-fixture-agent 1'); sys.exit(0)
prompt=sys.stdin.read()
assert pathlib.Path('/.dockerenv').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
value=subprocess.check_output(['/bin/sh','-c','printf tool-child-inside-docker'],text=True)
answer={'answer':value,'citations':[]}
for event in [{'type':'thread.started','thread_id':'docker-fixture'},{'type':'item.completed','item':{'type':'command_execution','command':'/bin/sh -c printf','aggregated_output':value,'exit_code':0,'status':'completed'}},{'type':'item.completed','item':{'type':'agent_message','text':json.dumps(answer)}},{'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}]: print(json.dumps(event),flush=True)
''')
for argv in [('init',),('add','.'),('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Fixed evaluation runner')]:subprocess.run(['git','-C',str(repo),*argv],check=True,capture_output=True)
sha=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
binding={'workspace':str(repo),'definition':'qa','input_commit':'sha1:'+sha,'branch':'grounds/eval-fixture/round','build_inputs':['.grounds/environments/qa.yaml','Dockerfile','agent.py']}
(root/'task.json').write_text(json.dumps(binding));os.environ['GROUNDS_EVAL_ENVIRONMENT_TASK']=str(root/'task.json');os.environ['GROUNDS_RUNTIME_HOME']=str(root/'runtime');os.environ['PATH']=os.environ['PATH']
workspace=Path(__file__).resolve().parents[3];os.environ['GROUNDS_BIN']=str(Path(args.grounds).resolve())
sys.path.insert(0,str(workspace/'plugins/grounds/scripts'))
import grounds_eval_environment as env,grounds_eval_capture as capture
outcome=env.prepare(env.template('grade',[]),{},root/'prepared',root/'prepare-evidence','fixture-attempt');print('PREPARE',json.dumps(outcome),flush=True)
config={'model':'fixture','timeout_seconds':30,'codex_command':'/usr/local/bin/fixture-agent','codex_version':'grounds-fixture-agent 1','model_base_url':'https://fixture.invalid','api_key_env':'GROUNDS_FIXTURE_TOKEN','enable_kb':False,'environment_task':binding}
(root/'config.json').write_text(json.dumps(config));(root/'packet.json').write_text(json.dumps({'run_id':'fixture-run','qa':{'question':'Return the child tool output'}}))
print('CAPTURE',json.dumps(capture.run(root/'config.json',root/'packet.json',root/'capture')),flush=True)
artifact=json.loads((root/'capture/artifact.json').read_text());assert artifact['answer']=='tool-child-inside-docker';assert artifact['capture']['coverage']=='complete';print('PASS full Docker prepare, fixture Agent, child tool, evidence, cleanup; no online model used',flush=True)
