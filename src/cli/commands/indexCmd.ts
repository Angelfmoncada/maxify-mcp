import type { IndexSummary } from '../../engine/types.js';
import { booleanOption, rejectPositionals } from '../args.js';
import { visible } from '../text.js';
import { info, printResult, withEngine, type CommandSpec } from '../command.js';

const MAX_ERRORS_SHOWN = 10;

export function formatIndexSummary(root: string, summary: IndexSummary): string {
  const lines = [
    `Indexed ${root}`,
    `generation ${summary.generation}: ${summary.filesScanned} files scanned ` +
      `(${summary.added} added, ${summary.updated} updated, ${summary.removed} removed, ` +
      `${summary.renamed} renamed, ${summary.unchanged} unchanged, ${summary.skipped} skipped) ` +
      `in ${summary.durationMs} ms`,
  ];
  if (summary.errors.length > 0) {
    lines.push(`${summary.errors.length} file(s) had problems:`);
    for (const message of summary.errors.slice(0, MAX_ERRORS_SHOWN)) lines.push(`  - ${visible(message)}`);
    if (summary.errors.length > MAX_ERRORS_SHOWN) lines.push(`  ... and ${summary.errors.length - MAX_ERRORS_SHOWN} more`);
  }
  return lines.join('\n');
}

export const indexCommand: CommandSpec = {
  name: 'index',
  summary: 'Build or refresh the repository index.',
  usage: 'index [--full]',
  options: { full: { type: 'boolean' } },
  optionDocs: [{ flag: '--full', description: 'Ignore stored hashes and re-parse every file.' }],
  async run(call) {
    rejectPositionals(call.positionals);
    const full = booleanOption(call.values, 'full');
    return withEngine(call, false, async (engine, location) => {
      info(call, `indexing ${location.root}${full ? ' (full rebuild)' : ''}`);
      const summary = await engine.index(full ? { full: true } : undefined);
      return printResult(call, { text: formatIndexSummary(location.root, summary), meta: { ...summary } });
    });
  },
};
