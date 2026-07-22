import { CATEGORY_ORDER, CATEGORY_LABEL_PLURAL, statusColor } from '../lib/status.js';

// Chip di filtro con "Tutti" in cima. `options` (array di {value,label}) permette
// di personalizzare l'insieme di categorie mostrate (es. la Home usa solo
// "Da scaricare"/"Falliti"); di default mostra tutte le categorie. `extra`
// (M43): nodo React opzionale renderizzato come ultima chip nella stessa riga
// — per filtri ortogonali (es. "Preferiti") che non sono una categoria
// mutuamente esclusiva e quindi non passano da `value`/`onChange`.
export function StatusChips({ value, counts, onChange, options, extra }) {
  const opts = options ?? CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL_PLURAL[c] }));
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
  return (
    <div className="chips">
      <div className={`chip${value == null ? ' active' : ''}`} onClick={() => onChange(null)}>
        Tutti
        {total > 0 && <span className="count">{total}</span>}
      </div>
      {opts.map((o) => (
        <div
          key={o.value}
          className={`chip${value === o.value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          <span className="dot" style={{ background: statusColor(o.value) }}></span>
          {o.label}
          {counts?.[o.value] > 0 && <span className="count">{counts[o.value]}</span>}
        </div>
      ))}
      {extra}
    </div>
  );
}
