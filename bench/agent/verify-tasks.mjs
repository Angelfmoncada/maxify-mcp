#!/usr/bin/env node
// Verifies every agent task both ways without calling Claude: hidden test FAILS after setup only,
// PASSES after setup + solution. Free to run; uses temporary git workspaces.
import { UsageError, parseArgs } from './lib/args.mjs';
import { loadAgentTasks } from './lib/tasks.mjs';
import { AGENT_TASKS_DIR, errorMessage } from './lib/util.mjs';
import { verifyBaseline, verifyTask } from './lib/verify.mjs';

const SCHEMA = {
  task: { type: 'list' },
  'skip-baseline': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
};

const USAGE = `Usage: node bench/agent/verify-tasks.mjs [--task id[,id]] [--skip-baseline] [--json]

For each task: hidden test must fail after setup only and pass after setup + solution.
The untouched fixture must also pass its own visible suite (skip with --skip-baseline).
Exit code 0 only when everything verified.
`;

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SCHEMA);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  const o = parsed.values;
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let tasks;
  try {
    tasks = loadAgentTasks(AGENT_TASKS_DIR, o.task);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  const results = [];
  if (o['skip-baseline'] !== true) results.push(verifyBaseline());
  for (const task of tasks) results.push(verifyTask(task));

  if (o.json === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id}\n`);
      for (const entry of result.steps) process.stdout.write(`      ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}\n`);
    }
    const failed = results.filter((result) => !result.ok);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} verified${failed.length > 0 ? `; failing: ${failed.map((result) => result.id).join(', ')}` : ''}\n`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
