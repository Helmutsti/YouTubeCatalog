// Un solo posto per etichette/colori delle CATEGORIE derivate (M25). La
// categoria a una dimensione arriva già calcolata dal core (videoCategory,
// esposta dal server come `video.category`): qui si mappano solo etichette,
// colori e ordinamenti per le viste che mostrano un unico indicatore.
export const CATEGORY_ORDER = ['available', 'downloaded', 'downloading', 'failed', 'hidden', 'removed'];

// Ordine "quanto richiede attenzione ora" — usato dall'ordinamento "per stato"
// in Home/pagina canale (M19): prima i problemi/eventi, poi cosa aspetta
// un'azione, infine cosa è già a posto/archiviato.
export const CATEGORY_PRIORITY = ['failed', 'downloading', 'removed', 'available', 'downloaded', 'hidden'];

export const CATEGORY_LABEL = {
  available: 'Su YouTube',
  downloaded: 'Scaricato',
  downloading: 'In download',
  failed: 'Fallito',
  hidden: 'Nascosto',
  removed: 'Rimosso'
};

export const CATEGORY_LABEL_PLURAL = {
  available: 'Su YouTube',
  downloaded: 'Scaricati',
  downloading: 'In download',
  failed: 'Falliti',
  hidden: 'Nascosti',
  removed: 'Rimossi'
};

export const CATEGORY_COLOR_VAR = {
  available: '--st-available',
  downloaded: '--st-downloaded',
  downloading: '--st-downloading',
  failed: '--st-failed',
  hidden: '--st-excluded',
  removed: '--st-removed'
};

export function statusColor(category) {
  return `var(${CATEGORY_COLOR_VAR[category] ?? '--faint'})`;
}

// Stato mostrato dal badge (pallino) sulla copertina — INDIPENDENTE dal flag
// "nascosto" (quello lo comunica la pagina Archiviati + il b/n): riflette solo
// presenza su YouTube / stato di download. Uno scaricato è lo standard → nessun
// badge (null). Su YouTube = verde, rimosso = arancione, errore = rosso.
export function badgeState(video) {
  if (!video) return null;
  if (video.presence === 'removed') return 'removed';
  if (video.download === 'failed') return 'failed';
  if (video.download === 'downloading') return 'downloading';
  if (video.download === 'downloaded') return null;
  return 'available';
}

export const BADGE_LABEL = {
  available: 'Su YouTube',
  removed: 'Rimosso',
  failed: 'Errore download',
  downloading: 'In download'
};

export const BADGE_COLOR = {
  available: 'var(--st-available)',
  removed: 'var(--st-removed)',
  failed: 'var(--st-failed)',
  downloading: 'var(--st-downloading)'
};
