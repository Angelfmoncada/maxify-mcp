import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMaxifyOnPath, resolveCliCommand } from '../../src/cli/cliCommand.js';

describe('resolveCliCommand', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'maxify-path-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the bare command name when maxify is on PATH', () => {
    writeFileSync(path.join(dir, 'maxify'), '#!/bin/sh\n');
    expect(isMaxifyOnPath({ PATH: dir }, 'linux')).toBe(true);
    expect(resolveCliCommand({ PATH: dir }, '/opt/maxify/dist/cli.js', 'linux')).toBe('maxify');
  });

  it('finds the Windows launcher through PATHEXT', () => {
    writeFileSync(path.join(dir, 'maxify.cmd'), '@echo off\r\n');
    expect(isMaxifyOnPath({ PATH: dir, PATHEXT: '.COM;.EXE;.CMD' }, 'win32')).toBe(true);
    expect(isMaxifyOnPath({ Path: dir }, 'win32')).toBe(true);
  });

  it('falls back to running the entry script with node, using forward slashes', () => {
    const cliPath = ['C:', 'tools', 'maxify', 'dist', 'cli.js'].join(path.sep);
    expect(resolveCliCommand({ PATH: dir }, cliPath, 'linux')).toBe('node "C:/tools/maxify/dist/cli.js"');
  });

  it('quotes ordinary paths, including spaces and the letter r', () => {
    expect(resolveCliCommand({}, 'C:/Program Files/maxify/dist/cli.js', 'win32')).toBe(
      'node "C:/Program Files/maxify/dist/cli.js"',
    );
  });

  it.each([
    'C:/Users/Ángel Moncada/OneDrive/Escritorio/Maxify/dist/cli.js',
    '/home/user/.nvm/versions/node/v22.22.1/lib/node_modules/maxify-mcp/dist/cli.js',
    '/opt/my_tool-2/app (copy)/dist/cli.js',
    '/Users/me/dev@home/maxify+extras/~scratch/cli.js',
    'D:/\u4e2d\u6587/\u0440\u0443\u0441\u0441\u043a\u0438\u0439/cli.js',
  ])('quotes ordinary paths, including accents, spaces and other scripts: %s', (cliPath) => {
    expect(resolveCliCommand({}, cliPath, 'linux')).toBe(`node "${cliPath}"`);
  });

  it.each([
    '/opt/a$(id)/cli.js',
    '/opt/a"b/cli.js',
    '/opt/a`id`/cli.js',
    '/opt/a!b/cli.js',
    '/opt/a\nb/cli.js',
    '/opt/a\rb/cli.js',
    "/opt/it's/cli.js",
    '/opt/100%/cli.js',
    '/opt/%USERPROFILE%/cli.js',
    '/opt/a&b/cli.js',
    '/opt/a;b/cli.js',
    '/opt/a|b/cli.js',
    '/opt/a^b/cli.js',
    '/opt/a<b>/cli.js',
    '/opt/a\u201dcurly/cli.js',
    '/opt/a\u201ccurly/cli.js',
    '/opt/a\u201ecurly/cli.js',
    '/opt/a{b}/cli.js',
    '/opt/a*b/cli.js',
    '/opt/a#b/cli.js',
  ])('only embeds paths from a conservative allow-list, so no shell can reinterpret them: %j', (unsafe) => {
    expect(resolveCliCommand({}, unsafe, 'linux')).toBe('maxify');
  });

  it('does not take a directory named maxify on PATH for the launcher', () => {
    mkdirSync(path.join(dir, 'maxify'));
    expect(isMaxifyOnPath({ PATH: dir }, 'linux')).toBe(false);
  });

  it('copes with an empty or missing PATH', () => {
    expect(isMaxifyOnPath({}, 'linux')).toBe(false);
    expect(isMaxifyOnPath({ PATH: '' }, 'linux')).toBe(false);
    expect(resolveCliCommand({}, '/x/cli.js', 'linux')).toBe('node "/x/cli.js"');
  });
});
