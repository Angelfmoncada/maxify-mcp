/**
 * Diagnostics always go to stderr. stdout is reserved for MCP JSON-RPC in
 * `maxify serve` and for command output in the CLI.
 */
const debugEnabled = (): boolean => process.env.MAXIFY_DEBUG === '1';

function write(level: string, message: string): void {
  process.stderr.write(`[maxify] ${level}${message}\n`);
}

export const log = {
  info(message: string): void {
    if (process.env.MAXIFY_QUIET === '1') return;
    write('', message);
  },
  warn(message: string): void {
    write('warn: ', message);
  },
  error(message: string): void {
    write('error: ', message);
  },
  debug(message: string): void {
    if (debugEnabled()) write('debug: ', message);
  },
};

let warningFilterInstalled = false;

/**
 * node:sqlite prints an ExperimentalWarning on first load. Install a filter
 * that drops only that warning and forwards every other warning to stderr.
 * Call before the first `node:sqlite` load (the store loads it lazily).
 */
export function installWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
    write('warn: ', `${warning.name}: ${warning.message}`);
  });
}
