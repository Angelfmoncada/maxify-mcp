#!/usr/bin/env node
// Aggregates agent benchmark results (JSONL written by run.mjs). Reads files only; costs nothing.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, parseArgs } from './lib/args.mjs';
import { aggregateRecords, readRecords, renderAgentReport, resultFiles } from './lib/results.mjs';
import { RESULTS_DIR, errorMessage } from './lib/util.mjs';

const SCHEMA = {
  out: { type: 'string' },
  json: { type: 'boolean' },
  'fail-on-regression': { type: 'boolean' },
  help: { type: 'boolean' },
};

const USAGE = `Usage: node bench/agent/report.mjs [results.jsonl | results-dir ...] [--out report.md] [--json] [--fail-on-regression]

Default input: every *.jsonl in bench/results. Cold and warm runs are reported separately.
A condition that uses fewer tokens (or costs less) than native but solves fewer runs is flagged REGRESSION.
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
  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const inputs = parsed.positionals.length > 0 ? parsed.positionals.map((entry) => path.resolve(entry)) : [RESULTS_DIR];
  let files;
  let records;
  try {
    files = resultFiles(inputs);
    records = readRecords(files);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }
  if (records.length === 0) {
    process.stdout.write('No agent results found. Run: node bench/agent/run.mjs --dry-run, then add --confirm-spend.\n');
    return 0;
  }
  const aggregate = aggregateRecords(records);
  const text = parsed.values.json === true ? `${JSON.stringify(aggregate, null, 2)}\n` : renderAgentReport(aggregate, { sources: files.map((file) => path.relative(process.cwd(), file) || file) });
  if (parsed.values.out !== undefined) writeFileSync(path.resolve(parsed.values.out), text);
  process.stdout.write(text);
  return parsed.values['fail-on-regression'] === true && aggregate.hasRegression ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
