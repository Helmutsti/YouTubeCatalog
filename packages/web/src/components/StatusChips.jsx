import { STATUS_ORDER, STATUS_LABEL_PLURAL, statusColor } from '../lib/status.js';

// Ricalca esattamente STATUS_LABELS della vista "Catalogo" nel CLI, incluso
// "Tutti" in cima: è lo stesso asse di navigazione, solo come chip invece
// che come select a frecce.
export function StatusChips({ value, counts, onChange }) {
  return (
    <div className="chips">
      <div className={`chip${value == null ? ' active' : ''}`} onClick={() => onChange(null)}>
        Tutti
      </div>
      {STATUS_ORDER.map((status) => (
        <div
          key={status}
          className={`chip${value === status ? ' active' : ''}`}
          onClick={() => onChange(status)}
        >
          <span className="dot" style={{ background: statusColor(status) }}></span>
          {STATUS_LABEL_PLURAL[status]}
          {counts?.[status] > 0 && <span className="count">{counts[status]}</span>}
        </div>
      ))}
    </div>
  );
}
