import { existsSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { listChannels, listVideosByChannel } from './videoService.js';
import { sanitizeName } from './libraryService.js';
import { resolveChannelAvatar } from '../ytdlp/ytdlpWrapper.js';

const EXT_BY_CONTENT_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Scarica l'immagine dell'avatar via fetch nativo (non un'altra chiamata
// yt-dlp: l'URL risolto è una semplice immagine HTTPS). Se il nome file
// cambia rispetto al precedente (es. estensione diversa su un refresh
// forzato), rimuove il vecchio file per non lasciare orfani in media/avatars/.
async function downloadAvatarImage(avatarUrl, avatarsDir, baseName, previousLocalPath) {
  const res = await fetch(avatarUrl);
  if (!res.ok) throw new Error(`Download foto profilo fallito: HTTP ${res.status}`);
  const contentType = res.headers.get('content-type')?.split(';')[0].trim();
  const ext = EXT_BY_CONTENT_TYPE[contentType] ?? 'jpg';
  const filename = `${baseName}.${ext}`;

  if (previousLocalPath && previousLocalPath !== filename) {
    const stale = path.join(avatarsDir, previousLocalPath);
    if (existsSync(stale)) unlinkSync(stale);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(avatarsDir, filename), buf);
  return filename;
}

// Legge la mappa { channelKey: record } così com'è nel catalogo — usata dal
// server per arricchire le risposte HTTP senza toccare catalogStore
// direttamente (stesso principio di ogni altro accesso al catalogo).
export async function getChannelAvatarMap() {
  const catalog = await readCatalog();
  return catalog.channelAvatars;
}

// Sincronizza le foto profilo dei canali con almeno un video scaricato.
// force:false (default) salta i canali già a posto (idempotente, stesso
// ruolo di "alreadyOk" in reorganizeLibrary); force:true li ri-scarica tutti
// — copre il caso in cui un creator cambi la propria foto. Un fallimento su
// un singolo canale non interrompe il batch, coerente con la tolleranza ai
// fallimenti già usata altrove nel progetto (es. downloadPendingJob).
export async function syncChannelAvatars({ force = false } = {}) {
  const paths = getPaths();
  const channels = await listChannels({ status: 'downloaded' });

  let fetchedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const errors = [];

  for (const channel of channels) {
    const catalog = await readCatalog();
    const existing = catalog.channelAvatars[channel.key];

    if (!force && existing?.localPath && !existing.error) {
      skippedCount += 1;
      continue;
    }

    try {
      // listChannels() non porta l'URL del canale: lo si recupera dal primo
      // video scaricato di quel canale, che ha sempre channel.url/uploaderUrl.
      const [sample] = await listVideosByChannel(channel.key, { status: 'downloaded' });
      const channelUrl = sample?.channel?.url ?? sample?.channel?.uploaderUrl ?? null;
      if (!channelUrl) throw new Error('Nessun URL canale disponibile tra i video scaricati');

      const { avatarUrl } = await resolveChannelAvatar(channelUrl);
      if (!avatarUrl) throw new Error('Nessuna foto profilo trovata per questo canale');

      const baseName = sanitizeName(channel.key, 'channel');
      const filename = await downloadAvatarImage(avatarUrl, paths.avatarsDir, baseName, existing?.localPath);

      await updateCatalog((cat) => {
        cat.channelAvatars[channel.key] = {
          channelKey: channel.key,
          sourceUrl: avatarUrl,
          localPath: filename,
          fetchedAt: new Date().toISOString(),
          error: null
        };
      });
      fetchedCount += 1;
    } catch (err) {
      await updateCatalog((cat) => {
        cat.channelAvatars[channel.key] = {
          channelKey: channel.key,
          sourceUrl: existing?.sourceUrl ?? null,
          localPath: existing?.localPath ?? null,
          fetchedAt: new Date().toISOString(),
          error: err.message
        };
      });
      failedCount += 1;
      errors.push({ key: channel.key, name: channel.name, error: err.message });
    }
  }

  return { channelsConsidered: channels.length, fetchedCount, skippedCount, failedCount, errors };
}
