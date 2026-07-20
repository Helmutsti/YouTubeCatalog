// Un solo posto per etichette/colori di stato, riusato da badge, chip di
// filtro e pillola di stato dei job — stessa terminologia della CLI
// (packages/cli/cli.js: STATUS_LABELS/REVIEW_STATUS_LABEL) per non avere due
// vocabolari diversi tra le due interfacce.
export const STATUS_ORDER = ['new', 'pending', 'downloading', 'downloaded', 'failed', 'excluded'];

export const STATUS_LABEL = {
  new: 'Nuovo',
  pending: 'In coda',
  downloading: 'In download',
  downloaded: 'Scaricato',
  failed: 'Fallito',
  excluded: 'Archiviato'
};

export const STATUS_LABEL_PLURAL = {
  new: 'Nuovi',
  pending: 'In coda',
  downloading: 'In download',
  downloaded: 'Scaricati',
  failed: 'Falliti',
  excluded: 'Archiviati'
};

export const STATUS_COLOR_VAR = {
  new: '--st-new',
  pending: '--st-pending',
  downloading: '--st-downloading',
  downloaded: '--st-downloaded',
  failed: '--st-failed',
  excluded: '--st-excluded'
};

export function statusColor(status) {
  return `var(${STATUS_COLOR_VAR[status] ?? '--faint'})`;
}
