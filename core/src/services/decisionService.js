import { updateCatalog } from '../catalog/catalogStore.js';
import { VIDEO_STATUS } from '../catalog/catalogSchema.js';

// Stati che fanno parte del ciclo di revisione delle "novità": una decisione può
// muoversi liberamente tra questi, in qualunque direzione (compreso tornare
// indietro), ma non tocca video attualmente in download o già scaricati.
// "failed" è incluso: un video fallito deve poter essere rivisto/riprovato/
// archiviato manualmente, non solo tramite il retry automatico di "Scarica in coda".
const REVIEWABLE_STATES = new Set([VIDEO_STATUS.NEW, VIDEO_STATUS.PENDING, VIDEO_STATUS.EXCLUDED, VIDEO_STATUS.FAILED]);

const DECISION_TO_STATUS = {
  download: VIDEO_STATUS.PENDING,
  exclude: VIDEO_STATUS.EXCLUDED,
  undecided: VIDEO_STATUS.NEW
};

export async function decideVideo(id, decision) {
  const targetStatus = DECISION_TO_STATUS[decision];
  if (!targetStatus) {
    throw new Error(`Decisione non valida: "${decision}" (atteso "download", "exclude" o "undecided")`);
  }

  return updateCatalog((catalog) => {
    const video = catalog.videos[id];
    if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);
    if (!REVIEWABLE_STATES.has(video.status)) {
      throw new Error(`Impossibile cambiare decisione per "${id}": stato attuale "${video.status}" non fa parte della revisione novità`);
    }
    const now = new Date().toISOString();
    const wasFailed = video.status === VIDEO_STATUS.FAILED;
    video.status = targetStatus;
    video.updatedAt = now;
    video.decidedAt = targetStatus === VIDEO_STATUS.NEW ? null : now;
    // Una decisione manuale su un video fallito è un "ricomincia da capo": il
    // vecchio errore/conteggio tentativi non deve più bloccare o confondere i
    // tentativi futuri (altrimenti "Scarica in coda" lo scarterebbe di nuovo
    // se il limite di tentativi automatici era già stato raggiunto).
    if (wasFailed) {
      video.attempts = 0;
      video.error = null;
    }
    return video;
  });
}
