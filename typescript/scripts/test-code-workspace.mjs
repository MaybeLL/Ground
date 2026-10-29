import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkerHome, workerEnvironment } from './test-environment.mjs';

// Public service/CLI acceptance assets. Everything writable belongs to this run.
const isolationDocker = process.argv.includes('--isolation-docker');
const lifecycleDocker = process.argv.includes('--lifecycle-docker');
const volumeFenceDocker = process.argv.includes('--volume-fence-docker');
const volumeDocker = process.argv.includes('--volume-docker');
const serviceSuite = process.argv.includes('--service-cleanup');
const serviceDocker = process.argv.includes('--service-docker');
const imageSuite = process.argv.includes('--image');
const imageDocker = process.argv.includes('--image-docker');
const runtimeDocker = process.argv.includes('--runtime-docker');
const environmentSuite = process.argv.includes('--environment');
const syncRegression = process.argv.includes('--sync-regression');
const sync = process.argv.includes('--sync');
const cleanup = process.argv.includes('--cleanup');
const candidateRegression = process.argv.includes('--candidate-regression');
const candidate = process.argv.includes('--candidate');
const executionCli = process.argv.includes('--execution-cli');
const executionCliDocker = process.argv.includes('--execution-cli-docker');
const client = process.argv.includes('--client');
const controller = process.argv.includes('--controller');
const channel = process.argv.includes('--channel');
const pausedGit = process.argv.includes('--paused-git');
const gitWrites = process.argv.includes('--git-writes');
const docker = process.argv.includes('--execution-docker');
const execution = process.argv.includes('--execution');
const regression = process.argv.includes('--regression');
const routes = process.argv.includes('--routes');
const devruns = process.argv.includes('--devruns');
const preflight = process.argv.includes('--preflight');
if ([isolationDocker, lifecycleDocker, volumeFenceDocker, volumeDocker, serviceSuite, serviceDocker, imageSuite, imageDocker, runtimeDocker, environmentSuite, syncRegression, sync, cleanup, candidateRegression, candidate, executionCli, executionCliDocker, client, controller, channel, regression, routes, devruns, preflight, execution, docker, gitWrites, pausedGit].filter(Boolean).length > 1 || process.argv.slice(2).some(arg => !['--isolation-docker', '--lifecycle-docker', '--volume-fence-docker', '--volume-docker', '--service-cleanup', '--service-docker', '--image', '--image-docker', '--runtime-docker', '--environment', '--sync-regression', '--sync', '--cleanup', '--candidate-regression', '--candidate', '--execution-cli', '--execution-cli-docker', '--client', '--controller', '--channel', '--paused-git', '--git-writes', '--regression', '--routes', '--devruns', '--preflight', '--execution', '--execution-docker'].includes(arg))) throw new Error('Choose one suite option, or omit options');
const home = createWorkerHome('code-workspace');
const environment = { ...workerEnvironment(home), GROUNDS_DATA_HOME: join(home, 'data'),
  GROUNDS_RUNTIME_HOME: join(home, 'runtime'), GROUNDS_ENV_TEST_ROOT: join(home, 'tmp'),
  XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') };
// This asset deliberately verifies SQLite, not a caller's optional database.
for (const key of Object.keys(environment)) if (key.startsWith('GROUNDS_TEST_MYSQL_') || key.startsWith('GROUNDS_TEST_POSTGRES_')) delete environment[key];
if (isolationDocker || lifecycleDocker || volumeFenceDocker || volumeDocker || serviceDocker || docker || executionCliDocker || runtimeDocker || imageDocker) {
  if (!environment.GROUNDS_CODE_DOCKER_IMAGE || !environment.DOCKER_HOST) throw new Error('Explicit local image ID and DOCKER_HOST are required');
  environment.GROUNDS_CODE_DOCKER_TEST = '1';
  environment.DOCKER_CONFIG = join(home, 'docker');
  delete environment.DOCKER_CONTEXT;
}
if (runtimeDocker && (!environment.GROUNDS_CODE_POSTGRES_IMAGE || !environment.GROUNDS_CODE_REPLACEMENT_IMAGE)) throw new Error('Explicit PostgreSQL and replacement execution image IDs are required');
if ((isolationDocker || lifecycleDocker || volumeFenceDocker || volumeDocker || serviceDocker) && !environment.GROUNDS_CODE_POSTGRES_IMAGE) throw new Error('Explicit PostgreSQL image ID is required');
const files = isolationDocker ? ['code-route-isolation-docker'] : lifecycleDocker ? ['code-workspace-lifecycle-docker', 'code-workspace-project-docker'] : volumeFenceDocker ? ['code-route-volume-fence-docker'] : volumeDocker ? ['code-route-volume-docker'] : serviceSuite ? ['code-route-service-cleanup'] : serviceDocker ? ['code-route-resource-cleanup-docker'] : imageSuite ? ['repository-image'] : imageDocker ? ['repository-image-docker'] : runtimeDocker ? ['code-route-runtime-docker', 'repository-environment-default-docker', 'code-route-resource-cleanup-docker'] : environmentSuite ? ['repository-environment', 'repository-environment-default'] : syncRegression ? ['devrun-sync-service', 'devrun-sync-store', 'sync-worktree', 'sync-merge', 'sync-files'] : sync ? ['code-route-sync'] : cleanup ? ['code-workspace-cleanup'] : candidateRegression ? ['candidate-archive-cli', 'dev-worktree-git-archive', 'development-branch', 'candidate-archive-schema'] : candidate ? ['code-route-candidate'] : executionCli ? ['code-route-cli'] : executionCliDocker ? ['code-route-cli-docker'] : client ? ['code-route-client'] : controller ? ['code-route-controller'] : channel ? ['code-route-channel'] : pausedGit ? ['code-route-paused-git'] : gitWrites ? ['code-route-git'] : docker ? ['code-route-execution-docker'] : execution ? ['code-route-execution'] : regression
  ? ['schema-contract', 'cli-contract', 'env-definition', 'development-branch', 'local-development-path', 'cli-workspace', 'env-route', 'env-route-run']
  : devruns ? ['code-workspace-devrun']
  : preflight ? ['preflight', 'preflight-boundaries', 'preflight-execution', 'preflight-regression', 'preflight-replay']
  : routes ? ['code-workspace-route', 'code-workspace-cli', 'env-route', 'env-route-run']
  : ['code-route-service-cleanup', 'repository-image', 'repository-environment', 'repository-environment-default', 'code-route-sync', 'code-workspace-cleanup', 'code-route-candidate', 'code-route-cli', 'code-route-client', 'code-route-controller', 'code-route-channel', 'code-route-paused-git', 'code-route-git', 'code-route-execution', 'code-workspace', 'code-workspace-preparation', 'code-workspace-route', 'code-workspace-devrun', 'code-workspace-cli'];
console.log(`Isolated ${regression ? 'compatibility' : routes ? 'route boundary' : 'code Workspace'} tests: ${home}`);
const pattern = process.env.GROUNDS_CODE_WORKSPACE_TEST_PATTERN;
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  ...(pattern ? ['--test-name-pattern', pattern] : []), ...files.map(name => `test/${name}.test.ts`)],
  { env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status === 0) rmSync(home, { recursive: true, force: true });
else {
  writeFileSync(join(home, 'test-output.txt'), `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`);
  console.error(`Failed run retained at ${home}`);
}
process.exitCode = result.status ?? 1;
