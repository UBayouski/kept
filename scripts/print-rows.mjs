// Prints query rows as a plain text table: no row numbers, no ids unless asked for.
export function printRows(rows) {
  if (!rows.length) {
    console.log('  (no rows)');
    return;
  }
  const columns = Object.keys(rows[0]);
  const text = (value) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const cells = rows.map((row) => columns.map((c) => text(row[c])));
  const width = columns.map((c, i) => Math.min(60, Math.max(c.length, ...cells.map((r) => r[i].length))));
  const line = (values) => `  ${values.map((v, i) => (v.length > width[i] ? `${v.slice(0, width[i] - 1)}…` : v.padEnd(width[i]))).join('  ')}`.trimEnd();
  console.log(line(columns));
  console.log(line(width.map((w) => '-'.repeat(w))));
  for (const row of cells) console.log(line(row));
}
