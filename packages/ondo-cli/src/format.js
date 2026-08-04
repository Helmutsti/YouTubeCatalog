// Colori ANSI a mano, come packages/cli/ui.js: niente dipendenza in più per
// poche sequenze di escape, e si spengono da sole quando l'output non è un
// terminale (rediretto, pipe). Non si importa ui.js direttamente: al caricamento
// installa un decoder di tasti su stdin pensato per i menu interattivi, un
// effetto collaterale che una CLI a sotto-comandi non deve avere.
const COLORED = process.stdout.isTTY;
const ESC = String.fromCharCode(27);
const wrap = (open) => (text) => (COLORED ? `${ESC}[${open}m${text}${ESC}[0m` : String(text));

export const style = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36)
};

/** Tabella semplice a colonne allineate, per output leggibile da terminale. */
export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log(style.dim('(nessun risultato)'));
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => String(col.value(row) ?? '').length))
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(style.bold(line(columns.map((c) => c.header))));
  for (const row of rows) {
    console.log(line(columns.map((c) => c.value(row) ?? '')));
  }
}
