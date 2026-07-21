// Modello di stato a flag ORTOGONALI (M25). L'unico `status` lineare di prima
// (new/pending/downloading/downloaded/failed/excluded) non sapeva esprimere
// stati che coesistono (un video può essere insieme "presente su YouTube" e
// "scaricato"; "nascosto" è indipendente dall'essere scaricato). Ora ogni
// dimensione vive su un asse separato:
//
//   presence: presenza su YouTube, aggiornata dalle sync
//   download: stato lato server (l'ex pipeline di download)
//   hidden:   "nascosto" (sostituisce l'ex 'excluded')
//
// I flag utente-visibili sono tutti DERIVATI da questi assi (vedi videoCategory).
export const PRESENCE = Object.freeze({ PRESENT: 'present', REMOVED: 'removed' });
export const DOWNLOAD_STATE = Object.freeze({
  NONE: 'none',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed'
});

// Categoria derivata a UNA dimensione, per le viste/badge/ordinamenti che
// mostrano un solo indicatore per video. È l'unico punto in cui gli assi
// ortogonali vengono collassati in una singola etichetta — così CLI e web
// (adapter) non reimplementano la regola. Priorità: "rimosso" e gli stati di
// download attivi/falliti sono più salienti; "nascosto" prima di "scaricato"
// così un video archiviato resta archiviato anche se ha un file su disco.
export const VIDEO_CATEGORY = Object.freeze({
  REMOVED: 'removed',
  DOWNLOADING: 'downloading',
  FAILED: 'failed',
  HIDDEN: 'hidden',
  DOWNLOADED: 'downloaded',
  AVAILABLE: 'available'
});

export function videoCategory(video) {
  if (video.presence === PRESENCE.REMOVED) return VIDEO_CATEGORY.REMOVED;
  if (video.download === DOWNLOAD_STATE.DOWNLOADING) return VIDEO_CATEGORY.DOWNLOADING;
  if (video.download === DOWNLOAD_STATE.FAILED) return VIDEO_CATEGORY.FAILED;
  if (video.hidden) return VIDEO_CATEGORY.HIDDEN;
  if (video.download === DOWNLOAD_STATE.DOWNLOADED) return VIDEO_CATEGORY.DOWNLOADED;
  return VIDEO_CATEGORY.AVAILABLE;
}

export function isDownloaded(video) {
  return video.download === DOWNLOAD_STATE.DOWNLOADED;
}

export function createEmptyCatalog() {
  return {
    version: 1,
    videos: {},
    sources: {},
    channelAvatars: {},
    meta: { lastUpdated: new Date().toISOString() }
  };
}

export function createNewVideoStub({
  id,
  title,
  channelName,
  durationSeconds,
  playlistIndex,
  playlistId,
  playlistTitle,
  sourceId,
  // Le fonti/playlist sono YouTube-only (v1), da cui i default qui sotto. Il
  // download singolo one-off (qualunque sito supportato da yt-dlp, es. Rumble)
  // passa questi tre esplicitamente, risolti da yt-dlp stesso.
  webpageUrl,
  originalUrl = null,
  extractor = 'youtube'
}) {
  const now = new Date().toISOString();
  return {
    id,
    title: title ?? null,
    description: null,
    webpageUrl: webpageUrl ?? `https://www.youtube.com/watch?v=${id}`,
    originalUrl,
    extractor,
    channel: {
      id: null,
      name: channelName ?? null,
      url: null,
      uploaderId: null,
      uploaderUrl: null,
      subscriberCountAtDownload: null
    },
    uploadDate: null,
    releaseTimestamp: null,
    durationSeconds: durationSeconds ?? null,
    categories: [],
    tags: [],
    language: null,
    ageLimit: null,
    availability: null,
    license: null,
    isLive: false,
    wasLive: false,
    statsAtDownload: { viewCount: null, likeCount: null, commentCount: null, averageRating: null },
    resolution: { width: null, height: null, fps: null, dynamicRange: null },
    thumbnails: [],
    thumbnail: { sourceUrl: null, localPath: null },
    chapters: [],
    subtitleLanguagesAvailable: [],
    playlistContext: { playlistId: playlistId ?? null, playlistTitle: playlistTitle ?? null, playlistIndex: playlistIndex ?? null },
    video: {
      localPath: null,
      formatId: null,
      container: null,
      videoCodec: null,
      audioCodec: null,
      bitrateKbps: null,
      sizeBytes: null,
      sha256: null,
      downloadedAt: null,
      ytdlpVersion: null
    },
    // Flag ortogonali (M25)
    presence: PRESENCE.PRESENT,
    removedAt: null,
    download: DOWNLOAD_STATE.NONE,
    hidden: false,
    source: { sourceId: sourceId ?? null, type: 'playlist' },
    addedAt: now,
    updatedAt: now,
    attempts: 0,
    error: null
  };
}

// Migrazione (M25) del vecchio modello a `status` singolo verso i flag
// ortogonali. Idempotente: se un video ha già i nuovi campi e non ha più
// `status`, non fa nulla. Ritorna true se ha modificato il video.
const LEGACY_STATUS_TO_FLAGS = {
  downloaded:  { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.DOWNLOADED,  hidden: false },
  new:         { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE,        hidden: false },
  pending:     { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE,        hidden: false },
  excluded:    { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE,        hidden: true },
  failed:      { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.FAILED,      hidden: false },
  // downloading interrotto → riportato a "none" (equivalente alla vecchia
  // reconciliation downloading→pending: un download a metà va rifatto da zero).
  downloading: { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE,        hidden: false }
};

export function migrateVideoToFlags(video) {
  if (!('status' in video) && 'download' in video) return false; // già migrato

  const legacy = video.status;
  const mapped = LEGACY_STATUS_TO_FLAGS[legacy] ?? { presence: PRESENCE.PRESENT, download: DOWNLOAD_STATE.NONE, hidden: false };

  video.presence = video.presence ?? mapped.presence;
  video.removedAt = video.removedAt ?? null;
  video.download = video.download ?? mapped.download;
  video.hidden = video.hidden ?? mapped.hidden;

  delete video.status;
  delete video.decidedAt; // legato al vecchio ciclo di decisione (new/pending/excluded)
  return true;
}
