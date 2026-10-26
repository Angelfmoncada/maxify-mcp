import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MaxifyError } from '../../src/core/errors.js';
import { COMMANDS } from '../../src/cli/commands/registry.js';
import { createHarness, createTempProject, type TempProject } from './helpers.js';

describe('maxify (dispatch)', () => {
  let project: TempProject;
  beforeEach(() => {
    project = createTempProject();
  });
  afterEach(() => {
    project.cleanup();
  });

  const harness = (options: Parameters<typeof createHarness>[0] = {}): ReturnType<typeof createHarness> =>
    createHarness({ cwd: project.dir, ...options });

  describe('help and version', () => {
    it('lists every command when run without arguments', async () => {
      const h = harness();
      expect(await h.run()).toBe(0);
      expect(h.stderr()).toBe('');
      for (const command of COMMANDS) expect(h.stdout()).toContain(command.name);
      expect(h.stdout()).toContain('Exit codes: 0 ok, 1 error');
      expect(COMMANDS.map((command) => command.name)).toEqual([
        'init',
        'index',
        'serve',
        'query',
        'source',
        'impact',
        'compress',
        'memory',
        'bench',
        'stats',
        'doctor',
      ]);
    });

    it.each([['--help'], ['-h'], ['help']])('prints the general help for %s', async (flag) => {
      const h = harness();
      expect(await h.run(flag)).toBe(0);
      expect(h.stdout()).toContain('Usage: maxify [global options] <command> [options]');
      expect(h.stdout()).toContain('maxify 1.2.3');
    });

    it('documents every global option', async () => {
      const h = harness();
      await h.run('--help');
      for (const flag of ['--root', '--state-dir', '--config', '--quiet', '--json', '--help', '--version']) {
        expect(h.stdout()).toContain(flag);
      }
    });

    it.each(COMMANDS.map((command) => command.name))('prints help for "%s --help" and "help %s"', async (name) => {
      const direct = harness();
      expect(await direct.run(name, '--help')).toBe(0);
      expect(direct.stdout()).toContain(`Usage: maxify ${name}`);
      expect(direct.opened).toHaveLength(0);
      const viaHelp = harness();
      expect(await viaHelp.run('help', name)).toBe(0);
      expect(viaHelp.stdout()).toBe(direct.stdout());
    });

    it('does not run the command when --help is present', async () => {
      const h = harness();
      expect(await h.run('query', 'something', '--help')).toBe(0);
      expect(h.fake.calls).toHaveLength(0);
    });

    it.each([['--version'], ['-v']])('prints only the version for %s', async (flag) => {
      const h = harness();
      expect(await h.run(flag)).toBe(0);
      expect(h.stdout()).toBe('1.2.3\n');
    });

    it('prints the version even after a command name', async () => {
      const h = harness();
      expect(await h.run('doctor', '--version')).toBe(0);
      expect(h.stdout()).toBe('1.2.3\n');
    });

    it('rejects help for an unknown command', async () => {
      const h = harness();
      expect(await h.run('help', 'frobnicate')).toBe(2);
      expect(h.stderr()).toContain('unknown command "frobnicate"');
    });
  });

  describe('usage errors (exit code 2)', () => {
    it('rejects an unknown command', async () => {
      const h = harness();
      expect(await h.run('frobnicate')).toBe(2);
      expect(h.stderr()).toContain('maxify: unknown command "frobnicate"');
      expect(h.stderr()).toContain('Run "maxify --help"');
      expect(h.stdout()).toBe('');
    });

    it('requires a command when only options are given', async () => {
      const h = harness();
      expect(await h.run('--json')).toBe(2);
      expect(h.stderr()).toContain('missing command');
    });

    it('points at the command help when a command is misused', async () => {
      const h = harness();
      expect(await h.run('query')).toBe(2);
      expect(h.stderr()).toContain('missing task');
      expect(h.stderr()).toContain('Run "maxify query --help"');
    });

    it('rejects options that belong to another command', async () => {
      const h = harness();
      expect(await h.run('index', '--budget', '500')).toBe(2);
      expect(h.stderr()).toContain("Unknown option '--budget'");
    });

    it('rejects stray positional arguments', async () => {
      const h = harness();
      expect(await h.run('index', 'extra')).toBe(2);
      expect(h.stderr()).toContain('unexpected argument "extra"');
    });
  });

  describe('failures (exit code 1)', () => {
    it('prints a MaxifyError message without a stack trace', async () => {
      const h = harness({
        engine: {
          context: async () => {
            throw new MaxifyError('NOT_FOUND', 'No such file.');
          },
        },
      });
      expect(await h.run('query', 'x')).toBe(1);
      expect(h.stderr()).toBe('maxify: No such file.\n');
    });

    it('prints unexpected errors briefly, and the stack only with MAXIFY_DEBUG=1', async () => {
      const failing = {
        context: async () => {
          throw new TypeError('kaput');
        },
      };
      const quiet = harness({ engine: failing });
      expect(await quiet.run('query', 'x')).toBe(1);
      expect(quiet.stderr()).toBe('maxify: kaput\n');
      const debug = harness({ engine: failing, env: { MAXIFY_DEBUG: '1' } });
      expect(await debug.run('query', 'x')).toBe(1);
      expect(debug.stderr()).toContain('TypeError: kaput');
      expect(debug.stderr()).toContain('at ');
    });

    it('survives non-Error throws', async () => {
      const h = harness({
        deps: {
          openEngine: async () => {
            throw 'plain string';
          },
        },
      });
      expect(await h.run('query', 'x')).toBe(1);
      expect(h.stderr()).toBe('maxify: plain string\n');
    });

    it('reports an engine that cannot be opened', async () => {
      const h = harness({
        deps: {
          openEngine: async () => {
            throw new Error('openEngine is not implemented yet');
          },
        },
      });
      expect(await h.run('query', 'x')).toBe(1);
      expect(h.stderr()).toContain('openEngine is not implemented yet');
    });

    it('does not let a failing engine.close hide the result', async () => {
      const h = harness({
        engine: {
          close: () => {
            throw new Error('locked');
          },
        },
      });
      expect(await h.run('query', 'x')).toBe(0);
      expect(h.stdout()).toBe('context ok\n');
    });
  });

  describe('global options', () => {
    it('--quiet silences progress lines', async () => {
      const loud = harness();
      await loud.run('index');
      expect(loud.stderr()).toContain('indexing');
      const quiet = harness();
      await quiet.run('index', '--quiet');
      expect(quiet.stderr()).toBe('');
      expect(quiet.deps.env.MAXIFY_QUIET).toBe('1');
    });

    it('accepts global options before or after the command', async () => {
      const before = harness();
      await before.run('--json', 'stats');
      const after = harness();
      await after.run('stats', '--json');
      expect(JSON.parse(before.stdout())).toEqual(JSON.parse(after.stdout()));
    });

    it('passes --state-dir and --config to the engine as absolute paths', async () => {
      const h = harness();
      await h.run('query', 'x', '--state-dir', 'state/here', '--config', 'cfg.json');
      expect(h.opened[0]).toMatchObject({
        stateDir: path.join(project.dir, 'state', 'here'),
        configPath: path.join(project.dir, 'cfg.json'),
      });
    });
  });
});
