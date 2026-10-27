import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_DIR, REPO_ROOT, loadTasks } from './helpers/agent-modules.js';

/**
 * Runs bench/agent/verify-tasks.mjs for every agent task: the hidden test must FAIL after setup only
 * and PASS after setup + solution, with the visible suite behaving as the task declares. No Claude involved.
 */
const script = path.join(AGENT_DIR, 'verify-tasks.mjs');

function verify(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 240_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const { loadAgentTasks } = await loadTasks();
const tasks = loadAgentTasks();

describe('agent task verification (both ways)', () => {
  it('verifies the untouched fixture on its own', () => {
    const result = verify(['--task', tasks[0]?.id ?? '', '--json']);
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; ok: boolean }>;
    expect(parsed[0]).toMatchObject({ id: '(baseline fixture)', ok: true });
  }, 240_000);

  for (const task of tasks) {
    it.concurrent(`${task.id}: hidden test fails after setup only and passes after setup + solution`, () => {
      const result = verify(['--task', task.id, '--skip-baseline']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`PASS  ${task.id}`);
      if (task.category !== 'question') {
        expect(result.stdout).toContain('hidden test fails after setup only');
        expect(result.stdout).toContain('hidden test passes after setup + solution');
        expect(result.stdout).toContain(task.expect.visibleFailsAfterSetup ? 'visible suite fails after setup' : 'visible suite still passes after setup');
      } else {
        expect(result.stdout).toContain('reference answer satisfies the rubric');
        expect(result.stdout).toContain('wrong answer is rejected by the rubric');
      }
    }, 240_000);
  }

  it('fails loudly for an unknown task', () => {
    const result = verify(['--task', 'no-such-task']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown agent task');
  });
});
