import { CATEGORY_LABEL, statusColor } from '../lib/status.js';

// Mostra la categoria derivata di un video (M25). inline=true per un uso a
// flusso normale (liste, righe) invece che come angolo sovrapposto a una
// thumbnail (che richiede un genitore position:relative).
export function StatusBadge({ category, inline }) {
  if (!category) return null;
  return (
    <div className={inline ? 'badge-inline' : 'badge'} style={{ background: statusColor(category) }}>
      {CATEGORY_LABEL[category] ?? category}
    </div>
  );
}
