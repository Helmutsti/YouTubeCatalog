import { CATEGORY_ORDER, CATEGORY_LABEL_PLURAL, statusColor } from '../lib/status.js';

// Chip di filtro con "Tutti" in cima. `options` (array di {value,label}) permette
// di personalizzare l'insieme di categorie mostrate (es. la Home usa solo
// "Da scaricare"/"Falliti"); di default mostra tutte le categorie.
export function StatusChips({ value, counts, onChange, options }) {
  const opts = options ?? CATEGORY_ORDER.map((c) => ({ value: c, label: CATEGORY_LABEL_PLURAL[c] }));
  return (
    <div className="chips">
      <div className={`chip${value == null ? ' active' : ''}`} onClick={() => onChange(null)}>
        Tutti
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
    </div>
  );
}
