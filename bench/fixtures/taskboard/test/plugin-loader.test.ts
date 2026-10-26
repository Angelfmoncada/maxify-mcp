import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/server/config.ts';
import { loadPlugin, loadPlugins } from '../src/server/plugins/loader.ts';
import { TaskEventBus } from '../src/server/tasks/events.ts';
import { createLogger } from '../src/server/util/logger.ts';
import { makeTask } from './helpers/factories.ts';

describe('loadPlugin', () => {
  it('loads a built-in plugin by name', async () => {
    const plugin = await loadPlugin('audit-log');
    assert.equal(plugin.name, 'audit-log');
    assert.equal(typeof plugin.setup, 'function');
  });

  it('rejects names that could escape the builtin folder', async () => {
    await assert.rejects(loadPlugin('../config'), /Invalid plugin name/);
    await assert.rejects(loadPlugin('Audit_Log'), /Invalid plugin name/);
  });

  it('fails for a plugin that does not exist', async () => {
    await assert.rejects(loadPlugin('does-not-exist'));
  });
});

describe('loadPlugins', () => {
  it('wires the plugin to the event bus and tears it down again', async () => {
    const lines: string[] = [];
    const events = new TaskEventBus();
    const context = {
      events,
      logger: createLogger('info', (line) => lines.push(line)),
      config: loadConfig({ NODE_ENV: 'test' }),
    };
    const teardowns = await loadPlugins(['audit-log'], context);
    assert.equal(teardowns.length, 1);

    events.publish({ type: 'task.created', actorId: 'user_1', task: makeTask({ id: 'task_9' }) });
    assert.ok(lines.some((line) => line.includes('"message":"audit"') && line.includes('task_9')));

    teardowns[0]?.();
    const before = lines.length;
    events.publish({ type: 'task.deleted', actorId: 'user_1', task: makeTask() });
    assert.equal(lines.length, before);
  });
});
