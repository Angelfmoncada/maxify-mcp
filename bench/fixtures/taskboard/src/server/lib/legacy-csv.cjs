'use strict';

/**
 * CSV helpers. Kept as CommonJS because the nightly reporting script
 * (scripts/nightly-report.cjs on the ops box) loads this file with require().
 */

/** Quotes a cell when it contains a delimiter, a quote or a line break. */
function escapeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/** Joins rows with CRLF line endings, as required by RFC 4180. */
function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { escapeCell, toCsv };
