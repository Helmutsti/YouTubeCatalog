import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { createNewVideoStub, DOWNLOAD_STATE } from '../catalog/catalogSchema.js';
import { resolveVideoInfo } from '../ytdlp/ytdlpWrapper.js';

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Un id YouTube nudo (senza URL) resta comodo da incollare ed è l'unico caso
// in cui possiamo costruire noi l'URL senza ambiguità. Per qualunque altro
// input serve un URL vero e proprio: id di altri siti (es. Rumble) non hanno
// un formato prevedibile, li risolve yt-dlp stesso.
function normalizeToUrl(input) {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  if (YOUTUBE_ID_PATTERN.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

// Aggiunge un singolo video da un link, senza passare da una fonte
// (sourcelist/sync di playlist). Accetta qualunque sito supportato da yt-dlp
// (YouTube, Rumble, ecc.) — l'id/titolo/canale vengono risolti da yt-dlp
// stesso, non indovinati con un regex specifico di YouTube.
//
// opts.download (default true): se true il video va scaricato subito (il
// chiamante, ricevuto action === 'download', lancia il job 'downloadSingle');
// se false il video viene solo AGGIUNTO alla libreria (stub present/none,
// nessun job) — è il caso "Download immediato" NON spuntato di M29, reso
// possibile dal modello a flag (un video può esistere "presente ma non
// scaricato"). Non crea mai una fonte: nessuna sync enumererà mai questo id.
export async function prepareSingleVideoDownload(input, { download = true } = {}) {
  const url = normalizeToUrl(input);
  if (!url) {
    throw new Error('URL non riconosciuto: incolla un link (YouTube, Rumble o un altro sito supportato da yt-dlp) oppure un id YouTube di 11 caratteri.');
  }

  const info = await resolveVideoInfo(url);
  if (!info.id) {
    throw new Error('yt-dlp non è riuscito a determinare un id per questo video.');
  }

  const catalog = await readCatalog();
  const existing = catalog.videos[info.id];

  if (existing) {
    if (existing.download === DOWNLOAD_STATE.DOWNLOADED) {
      return { videoId: info.id, action: 'already-downloaded', title: existing.title };
    }
    if (existing.download === DOWNLOAD_STATE.DOWNLOADING) {
      return { videoId: info.id, action: 'already-downloading', title: existing.title };
    }
    // Già in libreria ma non scaricato: se richiesto, si scarica direttamente
    // (niente più "vai a Rivedi novità" — quel ciclo non esiste più); altrimenti
    // è già presente e non c'è nulla da aggiungere.
    return { videoId: info.id, action: download ? 'download' : 'already-present', title: existing.title };
  }

  await updateCatalog((cat) => {
    if (cat.videos[info.id]) return;
    const stub = createNewVideoStub({
      id: info.id,
      title: info.title,
      channelName: info.channelName,
      durationSeconds: info.durationSeconds,
      webpageUrl: info.webpageUrl,
      originalUrl: url,
      extractor: info.extractor
    });
    // Mai legato a una fonte (sources: [] già di default senza sourceId): nessuna
    // sync di playlist enumererà mai questo id.
    cat.videos[info.id] = stub;
  });

  return { videoId: info.id, action: download ? 'download' : 'added', title: info.title };
}
