import { CATEGORY_ORDER, CATEGORY_LABEL_PLURAL, statusColor } from '../lib/status.js';

// Chip di filtro per categoria derivata (M25), con "Tutti" in cima. Le categorie
// sostituiscono il vecchio asse di stato lineare: Su YouTube / Scaricati /
// In download / Falliti / Nascosti / Rimossi.
export function StatusChips({ value, counts, onChange }) {
  return (
    <div className="chips">
      <div className={`chip${value == null ? ' active' : ''}`} onClick={() => onChange(null)}>
        Tutti
      </div>
      {CATEGORY_ORDER.map((category) => (
        <div
          key={category}
          className={`chip${value === category ? ' active' : ''}`}
          onClick={() => onChange(category)}
        >
          <span className="dot" style={{ background: statusColor(category) }}></span>
          {CATEGORY_LABEL_PLURAL[category]}
          {counts?.[category] > 0 && <span className="count">{counts[category]}</span>}
        </div>
      ))}
    </div>
  );
}
