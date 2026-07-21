import { CATEGORY_PRIORITY } from './status.js';

// uploadDate è "YYYYMMDD" (formato yt-dlp) o già ISO — stessa normalizzazione
// usata in format.js per la data mostrata in card/dettaglio.
function toIso(value) {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

export const SORT_OPTIONS = [
  { value: 'addedAt', label: 'Data aggiunta (più recenti)' },
  { value: 'uploadDate', label: 'Data pubblicazione (più recenti)' },
  { value: 'duration', label: 'Durata (più lunghi prima)' },
  { value: 'title', label: 'Titolo (A-Z)' },
  { value: 'status', label: 'Stato (falliti in cima)' }
];

// Tutto client-side: i video sono già interamente caricati in una volta sola
// da listVideos()/listVideosByChannel() (vedi PIANO.md), quindi ordinare è
// solo un .sort() su un array già in memoria — nessuna chiamata di rete.
export function sortVideos(videos, criterion) {
  const list = [...videos];
  switch (criterion) {
    case 'uploadDate':
      return list.sort((a, b) => (toIso(b.uploadDate) || '').localeCompare(toIso(a.uploadDate) || ''));
    case 'duration':
      return list.sort((a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1));
    case 'title':
      return list.sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id, 'it', { sensitivity: 'base' }));
    case 'status':
      return list.sort((a, b) => CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category));
    case 'addedAt':
    default:
      return list.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  }
}
