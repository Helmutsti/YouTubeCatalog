import { badgeState, BADGE_COLOR, BADGE_LABEL } from '../lib/status.js';

// Badge di stato come PALLINO colorato (M31): scaricato = standard → nessun
// badge; Su YouTube = verde, rimosso = arancione, errore = rosso, in download =
// accento. Sulla copertina (default) mostra solo il pallino (con tooltip);
// inline (liste/ricerca) mostra pallino + etichetta.
export function StatusBadge({ video, inline }) {
  const state = badgeState(video);
  if (!state) return null;
  const color = BADGE_COLOR[state];
  const label = BADGE_LABEL[state];

  const pulse = state === 'downloading' ? ' downloading' : '';

  if (inline) {
    return (
      <span className="badge-inline">
        <span className={`badge-dot-sm${pulse}`} style={{ background: color }}></span>
        {label}
      </span>
    );
  }
  return <span className={`badge-dot${pulse}`} style={{ background: color }} title={label}></span>;
}
