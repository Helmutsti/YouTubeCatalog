import { channelKey, videoCategory } from '@catalog/core';

// video.localPath/thumbnail.localPath sono percorsi relativi a mediaRoot
// (possono includere sottocartelle per creator, vedi "Archivio canonico per
// creator" in documentazione.md). Qui si aggiunge l'URL pronto all'uso per il
// frontend, incapsulando dove vive il media server-side.
function encodeRelPath(relPath) {
  return relPath
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join('/');
}

export function toPublicVideo(video, channelAvatars = {}) {
  const key = channelKey(video);
  const avatar = key ? channelAvatars[key] : null;
  return {
    ...video,
    // Categoria derivata dai flag ortogonali (M25): calcolata nel core, così il
    // frontend mostra badge/chip/ordina senza reimplementare la regola. I flag
    // grezzi (presence/download/hidden/removedAt) restano comunque nell'oggetto.
    category: videoCategory(video),
    videoUrl: video.video?.localPath ? `/media/videos/${encodeRelPath(video.video.localPath)}` : null,
    thumbnailUrl: video.thumbnail?.localPath ? `/media/thumbnails/${encodeRelPath(video.thumbnail.localPath)}` : null,
    channel: {
      ...video.channel,
      avatarUrl: avatar?.localPath ? `/media/avatars/${encodeRelPath(avatar.localPath)}` : null
    }
  };
}
