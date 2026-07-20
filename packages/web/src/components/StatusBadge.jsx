import { STATUS_LABEL, statusColor } from '../lib/status.js';

// inline=true per un uso a flusso normale (liste, righe) invece che come
// angolo sovrapposto a una thumbnail (che richiede un genitore position:relative).
export function StatusBadge({ status, inline }) {
  if (!status) return null;
  return (
    <div className={inline ? 'badge-inline' : 'badge'} style={{ background: statusColor(status) }}>
      {STATUS_LABEL[status] ?? status}
    </div>
  );
}
