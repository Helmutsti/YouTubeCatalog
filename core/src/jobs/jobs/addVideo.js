import { readCatalog, updateCatalog } from '../../catalog/catalogStore.js';
import { prepareSingleVideoDownload } from '../../services/singleVideoService.js';
import { fetchVideoMetadata, isPrivateVideoError } from '../../ytdlp/ytdlpWrapper.js';
import { syncChannelAvatars } from '../../services/channelAvatarService.js';
import { markVideoRemoved } from '../../services/metadataService.js';

const ACTION_LABEL = {
  'already-downloaded': 'era già scaricato',
  'already-downloading': 'è già in download',
  'already-present': 'è già in libreria'
};

// Aggiunta "istantanea" di un singolo video dalla pagina Sorgenti: come
// addSourceJob, l'intera operazione gira come UN SOLO job in coda (risoluzione
// yt-dlp + stub + metadati completi + copertina). Non scarica MAI il video —
// per quello esiste già l'azione "Scarica video" sulla scheda, separata.
export async function addVideoJob({ url }, { log, progress }) {
  if (!url) throw new Error('addVideo richiede il parametro "url"');

  log('Risoluzione video…');
  const result = await prepareSingleVideoDownload(url, { download: false });
  progress(30);

  if (result.action !== 'added') {
    log(`"${result.title ?? result.videoId}" ${ACTION_LABEL[result.action] ?? result.action}.`);
    progress(100);
    return result;
  }

  log(`"${result.title ?? result.videoId}" aggiunto. Recupero metadati completi…`);
  try {
    const catalog = await readCatalog();
    const webpageUrl = catalog.videos[result.videoId]?.webpageUrl;
    const fields = await fetchVideoMetadata(result.videoId, webpageUrl, { onLog: log });
    const { video: _ignore, ...meta } = fields;
    await updateCatalog((cat) => {
      const current = cat.videos[result.videoId];
      if (!current) return; // rimosso nel frattempo
      Object.assign(current, meta, {
        enrichedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    log(`✔ Metadati completi salvati.`);
  } catch (err) {
    if (isPrivateVideoError(err)) {
      await markVideoRemoved(result.videoId);
      log(`⊘ Video privato — segnato come "Rimosso".`);
    } else {
      // Il video resta comunque in libreria con i metadati leggeri già presenti:
      // un fallimento qui non deve far fallire l'intera aggiunta.
      log(`✘ Metadati completi non recuperati: ${err.message}`);
    }
  }

  // Un video singolo può introdurre un creator mai visto prima nel catalogo
  // (bug corretto: prima solo enrichSourceJob, cioè le playlist, scaricava la
  // foto profilo automaticamente — un video aggiunto da solo lasciava il
  // creator senza foto). force:false salta chi ce l'ha già: economico anche
  // se il creator esisteva già.
  try {
    const a = await syncChannelAvatars({ force: false });
    if (a.fetchedCount) log(`Foto profilo creator scaricata (${a.fetchedCount}).`);
  } catch (err) {
    log(`Foto profilo creator non aggiornata: ${err.message}`);
  }

  progress(100);
  return result;
}
