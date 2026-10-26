#!/usr/bin/env node
import { installWarningFilter, log } from './core/log.js';

// The filter must be in place before anything loads node:sqlite, hence the dynamic import below.
installWarningFilter();

// A reader that closes early (for example `| head`) must not crash the CLI with EPIPE. Any other
// stdout failure is reported, not thrown: a throw here would skip the other stdout listeners
// (`serve` closes its engine in one) and kill the process without cleanup.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') log.error(`stdout: ${error.message}`);
});

const { main } = await import('./cli/main.js');
process.exitCode = await main(process.argv.slice(2));
