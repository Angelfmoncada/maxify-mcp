import { statSync } from 'node:fs';
import path from 'node:path';

const BIN_NAME = 'maxify';
/**
 * Characters allowed in a path that is embedded in a double-quoted shell word. An allow-list,
 * because the same text may be run by bash, PowerShell or cmd, whose quoting rules differ
 * (PowerShell treats typographic quotes as quotes; cmd expands %VAR% inside quotes).
 */
const SAFE_PATH = /^[\p{L}\p{N} _.\/:@+~()-]+$/u;

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

function candidateNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [BIN_NAME];
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0);
  return [BIN_NAME, ...extensions.map((ext) => `${BIN_NAME}${ext.toLowerCase()}`)];
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    // Not there (or not readable): not a usable launcher.
    return false;
  }
}

/** True when a `maxify` launcher (a file, not a directory) is reachable through PATH. */
export function isMaxifyOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const names = candidateNames(platform, env);
  return pathEntries(env).some((dir) => names.some((name) => isFile(path.join(dir, name))));
}

/**
 * Shell command the model should use to run the CLI: `maxify` when installed on
 * PATH, otherwise `node "<abs path>/dist/cli.js"` (forward slashes work in every shell).
 * The command ends up in text the model turns into a shell command, so a path with
 * anything outside a conservative allow-list is never embedded; the bare name is used
 * instead and the model falls back to maxify_compress {path}.
 */
export function resolveCliCommand(
  env: NodeJS.ProcessEnv,
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isMaxifyOnPath(env, platform)) return BIN_NAME;
  const portable = cliPath.split(path.sep).join('/');
  return SAFE_PATH.test(portable) ? `node "${portable}"` : BIN_NAME;
}
