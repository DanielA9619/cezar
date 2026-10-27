import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { realFixtureFiles } from '../dist/roadmap/real-fixture.js';
import { REAL_QUEUE_TASK, REAL_QUEUE_WORKFLOW } from '../dist/roadmap/real-workflow.js';
import { mergeWriteWorkspaceConfig } from '../dist/workspace/config.js';
import { readQueueState, updateQueue } from '../dist/roadmap/queue.js';

// Adds a NEW fixture to an isolated enrolled home; preserves the credential and all claims.
const home = process.argv[2];
if (!home || !isAbsolute(home)) throw new Error('Usage: node prepare-guarded-queue.mjs <isolated-enrolled-home>');
process.env.CEZ_HOME = home;
const previous = await readQueueState();
if (!previous.ownerAuthenticator) throw new Error('Use the existing isolated Windows Hello enrolled home');
const root = join(resolve(home), 'roadmap/disposable/finite-sum');
await mkdir(root);
await mkdir(join(root, '.ai/cezar'), { recursive: true });
for (const [name, content] of Object.entries(realFixtureFiles)) await writeFile(join(root, name), content);
await writeFile(join(root, '.ai/cezar/config.json'), JSON.stringify({ reviewGate: true }));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
git('add', '.');
git('-c', 'user.name=Cezar Disposable Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Disposable finite sum baseline');
const now = new Date().toISOString();
await mergeWriteWorkspaceConfig(config => {
  if (config.projects.some(project => project.id === 'finite-sum')) throw new Error('Project already exists');
  config.resources.maxParallel = 1;
  config.resources.autoResumeOnUsageLimit = false;
  config.projects.push({ id: 'finite-sum', root, name: 'Disposable finite sum', source: 'local', addedAt: now, lastOpenedAt: now });
});
const input = { allowedRepositories: [{ repo: 'local/finite-sum', projectId: 'finite-sum' }], roadmaps: [
  { id: 'finite-sum-one', repo: 'local/finite-sum', title: REAL_QUEUE_TASK, priority: 1, approval: 'approved',
    preferredRunner: 'claude', workflow: REAL_QUEUE_WORKFLOW, dependencies: [], blockers: [] },
], githubIssues: [], runningTaskIds: [], completedTaskIds: [] };
await writeFile(join(home, 'finite-sum-planning.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
await updateQueue(state => {
  if (state.input.roadmaps.some(task => task.id === 'finite-sum-one')) throw new Error('Task already exists');
  state.input.allowedRepositories.push(...input.allowedRepositories);
  state.input.roadmaps.push(...input.roadmaps);
});
console.log(JSON.stringify({ home, root, taskId: 'finite-sum-one', authorized: false, dispatched: false }));
