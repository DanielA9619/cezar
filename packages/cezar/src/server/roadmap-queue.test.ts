import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { saveQueueInput } from '../roadmap/queue.ts';
import { roadmapInputSchema } from '../roadmap/planner.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace roadmap queue API', () => {
  let home: string;
  let root: string;
  let store: RunStore;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-roadmap-api-home-'));
    root = mkdtempSync(join(tmpdir(), 'cez-roadmap-api-repo-'));
    vi.stubEnv('CEZ_HOME', home);
    await saveQueueInput(roadmapInputSchema.parse({
      allowedRepositories: [{ repo: 'fictional/atlas' }],
      roadmaps: [{ id: 'schema', repo: 'fictional/atlas', title: 'Schema', priority: 3, approval: 'approved', dependencies: [], blockers: [] }],
    }));
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => { store.flush(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  it('shows a planning preview and permits only a priority edit through this route family', async () => {
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const before = await apiRequest(app, '/api/v1/workspace/roadmap-queue');
    expect(before.status).toBe(200);
    expect(queueResponseSchema.parse(await before.json()).nextTaskId).toBe('schema');
    const changed = await apiRequest(app, '/api/v1/workspace/roadmap-queue/priority', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'schema', priority: 1 }),
    });
    expect(changed.status).toBe(200);
    expect(queueResponseSchema.parse(await changed.json()).rows[0]).toMatchObject({ priority: 1, executionEligible: false });
    const bad = await apiRequest(app, '/api/v1/workspace/roadmap-queue/priority', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'schema', priority: 0 }),
    });
    expect(bad.status).toBe(400);
    const grant = await apiRequest(app, '/api/v1/workspace/roadmap-queue/authorize', { method: 'POST' });
    expect(grant.status).toBe(404);
  });
});
