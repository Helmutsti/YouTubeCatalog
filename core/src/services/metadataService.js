import { readMetadata } from '../catalog/metadataStore.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { fetchVideoMetadata } from '../ytdlp/ytdlpWrapper.js';
import { PRESENCE } from '../catalog/catalogSchema.js';

export async function getRawMetadata(id) {
  return readMetadata(id);
}

// "Aggiorna metadati" (M31): ri-scarica i metadati completi + la copertina di un
// singolo video. Funziona anche sui RIMOSSI, come ri-verifica: se il video è di
// nuovo raggiungibile viene ripristinato (presence → present); se resta
// irraggiungibile ed era già "removed", non si tocca nulla (stato confermato).
// Se fallisce su un video NON rimosso, l'errore viene propagato (problema reale).
export async function refreshVideoMetadata(id) {
  const catalog = await readCatalog();
  const video = catalog.videos[id];
  if (!video) throw new Error(`Video non trovato nel catalogo: ${id}`);

  try {
    const fields = await fetchVideoMetadata(id, video.webpageUrl);
    const { video: _ignore, ...meta } = fields;
    return await updateCatalog((cat) => {
      const cur = cat.videos[id];
      if (!cur) return null;
      Object.assign(cur, meta, { enrichedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (cur.presence === PRESENCE.REMOVED) {
        cur.presence = PRESENCE.PRESENT;
        cur.removedAt = null;
        cur.missCount = 0;
      }
      return cur;
    });
  } catch (err) {
    if (video.presence === PRESENCE.REMOVED) {
      return video; // stato "rimosso" confermato: nessuna modifica
    }
    throw err;
  }
}
