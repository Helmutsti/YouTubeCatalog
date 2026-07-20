export const VIDEO_STATUS = Object.freeze({
  NEW: 'new',
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed',
  EXCLUDED: 'excluded'
});

export function createEmptyCatalog() {
  return {
    version: 1,
    videos: {},
    sources: {},
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
    status: VIDEO_STATUS.NEW,
    source: { sourceId: sourceId ?? null, type: 'playlist' },
    addedAt: now,
    updatedAt: now,
    decidedAt: null,
    attempts: 0,
    error: null
  };
}
