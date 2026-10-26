import type { CommandSpec } from '../command.js';
import { benchCommand } from './bench.js';
import { compressCommand } from './compress.js';
import { doctorCommand } from './doctor.js';
import { impactCommand } from './impact.js';
import { indexCommand } from './indexCmd.js';
import { initCommand } from './init.js';
import { memoryCommand } from './memory.js';
import { queryCommand } from './query.js';
import { serveCommand } from './serve.js';
import { sourceCommand } from './source.js';
import { statsCommand } from './stats.js';

/** Commands in the order shown by `maxify --help`. */
export const COMMANDS: readonly CommandSpec[] = [
  initCommand,
  indexCommand,
  serveCommand,
  queryCommand,
  sourceCommand,
  impactCommand,
  compressCommand,
  memoryCommand,
  benchCommand,
  statsCommand,
  doctorCommand,
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
