// Fusione di due librerie: una SORGENTE (cartella esterna data/, con la sua
// data/media/) dentro la libreria TARGET (quella del processo corrente). Non
// copia mai i video fisici — solo metadati (catalog.json/metadata.json),
// copertine (thumbnails) e avatar dei canali. In caso di conflitto sullo
// stesso video (stesso id) vince il dato più completo, campo per campo: lo
// stato locale (file fisico, download, presenza, curation utente) resta
// sempre quello del target, mai quello della sorgente.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config.js';
import { readCatalog, updateCatalog } from '../catalog/catalogStore.js';
import { readMetadata, setMetadata } from '../catalog/metadataStore.js';
import { resolveForeignPaths } from '../foreignLibrary.js';

// Campi descrittivi sovrascritti IN BLOCCO dalla sorgente quando il suo
// punteggio di completezza è strettamente maggiore di quello del target.
// Tutto il resto (id/webpageUrl/originalUrl/extractor/video/download/
// presence/removedAt/missCount/hidden/favorite/addedAt/attempts/error)
// descrive lo stato LOCALE del target (file fisico, download, presenza su
// YouTube, curation utente...) e non viene mai toccato: questa whitelist è
// l'unico punto da cui la sorgente può scrivere nel target. sources[]/
// enrichedAt/thumbnail hanno regole dedicate, fuori da questa lista.
const OVERWRITABLE_FIELDS = [
  'title', 'description', 'channel', 'uploadDate', 'releaseTimestamp', 'durationSeconds',
  'categories', 'tags', 'language', 'ageLimit', 'availability', 'license', 'isLive', 'wasLive',
  'statsAtDownload', 'resolution', 'thumbnails', 'chapters', 'subtitleLanguagesAvailable', 'playlistContext'
];

function completenessScore(video) {
  let score = 0;
  if (video.enrichedAt) score += 3;
  if (video.description) score += 1;
  if (video.uploadDate) score += 1;
  if (video.releaseTimestamp) score += 1;
  if (video.durationSeconds != null) score += 1;
  if (video.language) score += 1;
  if (video.categories?.length) score += 1;
  if (video.tags?.length) score += 1;
  if (video.chapters?.length) score += 1;
  if (video.resolution?.width) score += 1;
  if (video.statsAtDownload?.viewCount != null) score += 1;
  if (video.channel?.id) score += 1;
  return score;
}

function mergeSourceLabels(targetSources, sourceSources) {
  const merged = [...(targetSources ?? [])];
  for (const s of sourceSources ?? []) {
    if (!merged.some((m) => m.sourceId === s.sourceId)) merged.push(s);
  }
  return merged;
}

// Copia un'immagine (copertina/avatar) dalla sorgente al target per basename,
// se il file esiste davvero su disco (un localPath a catalogo non è garanzia
// che il file ci sia). In dryRun non copia nulla ma ritorna comunque true se
// il file sorgente esiste, per far contare al chiamante "quello che sarebbe
// successo" nel report.
function copyImageIfPresent(srcDir, destDir, filename, { copyFiles }) {
  if (!filename) return false;
  const src = path.join(srcDir, filename);
  if (!existsSync(src)) return false;
  if (copyFiles) copyFileSync(src, path.join(destDir, filename));
  return true;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Normalizza un video portato SOLO dalla sorgente: il file fisico non esiste
// sul target, quindi lo stato di download locale va azzerato. presence/
// removedAt/missCount restano quelli della sorgente (stato noto su YouTube,
// non stato locale). hidden/favorite sono etichette utente, portate col video.
function normalizeIncomingVideo(video) {
  return {
    ...video,
    download: 'none',
    video: {
      localPath: null, formatId: null, container: null, videoCodec: null,
      audioCodec: null, bitrateKbps: null, sizeBytes: null, sha256: null,
      downloadedAt: null, ytdlpVersion: null
    }
  };
}

// Fonde un video già presente in entrambe le librerie dentro `target`
// (mutato sul posto). Ritorna se qualcosa è cambiato e se una copertina è
// stata copiata (per il conteggio nel report).
function mergeExistingVideo(target, source, { thumbnailsSrcDir, thumbnailsDestDir, copyFiles }) {
  let changed = false;

  const mergedSources = mergeSourceLabels(target.sources, source.sources);
  if (mergedSources.length !== (target.sources ?? []).length) {
    target.sources = mergedSources;
    changed = true;
  }

  if (source.enrichedAt && (!target.enrichedAt || source.enrichedAt > target.enrichedAt)) {
    target.enrichedAt = source.enrichedAt;
    changed = true;
  }

  let thumbnailCopied = false;
  if (!target.thumbnail?.localPath && source.thumbnail?.localPath) {
    const ok = copyImageIfPresent(thumbnailsSrcDir, thumbnailsDestDir, source.thumbnail.localPath, { copyFiles });
    if (ok) {
      target.thumbnail = { ...source.thumbnail };
      thumbnailCopied = true;
      changed = true;
    }
  }

  if (completenessScore(source) > completenessScore(target)) {
    for (const field of OVERWRITABLE_FIELDS) target[field] = source[field];
    changed = true;
  }

  if (changed) target.updatedAt = new Date().toISOString();
  return { changed, thumbnailCopied };
}

/**
 * Fonde la libreria in `sourceRoot` dentro la libreria corrente. Non tocca mai
 * i video fisici. dryRun:true calcola il report senza
 * scrivere né copiare nulla.
 * @returns {object} report con i conteggi dell'operazione
 */
export async function mergeLibrary(sourceRoot, { dryRun = false } = {}) {
  const targetPaths = getPaths();
  const sPaths = resolveForeignPaths(sourceRoot);
  if (sPaths.root === targetPaths.projectRoot) {
    throw new Error('La libreria sorgente coincide con quella corrente.');
  }

  const sourceCatalog = JSON.parse(readFileSync(sPaths.catalogPath, 'utf-8'));
  const sourceMetadata = existsSync(sPaths.metadataPath)
    ? JSON.parse(readFileSync(sPaths.metadataPath, 'utf-8'))
    : {};

  const report = {
    sourceRoot: sPaths.root,
    dryRun,
    videos: { added: 0, updated: 0, unchanged: 0 },
    sources: { added: 0, updated: 0 },
    channelAvatars: { added: 0, updated: 0 },
    metadataEntriesAdded: 0,
    queueAdded: 0,
    thumbnailsCopied: 0,
    avatarsCopied: 0,
    safetyBackupPath: null
  };

  const copyFiles = !dryRun;

  function applyMerge(cat) {
    for (const [id, sourceVideo] of Object.entries(sourceCatalog.videos ?? {})) {
      const targetVideo = cat.videos[id];
      if (!targetVideo) {
        const incoming = normalizeIncomingVideo(sourceVideo);
        if (incoming.thumbnail?.localPath) {
          const ok = copyImageIfPresent(sPaths.thumbnailsDir, targetPaths.thumbnailsDir, incoming.thumbnail.localPath, { copyFiles });
          if (ok) {
            report.thumbnailsCopied += 1;
          } else {
            incoming.thumbnail = { sourceUrl: incoming.thumbnail.sourceUrl ?? null, localPath: null };
          }
        }
        cat.videos[id] = incoming;
        report.videos.added += 1;
        continue;
      }
      const { changed, thumbnailCopied } = mergeExistingVideo(targetVideo, sourceVideo, {
        thumbnailsSrcDir: sPaths.thumbnailsDir,
        thumbnailsDestDir: targetPaths.thumbnailsDir,
        copyFiles
      });
      if (thumbnailCopied) report.thumbnailsCopied += 1;
      if (changed) report.videos.updated += 1;
      else report.videos.unchanged += 1;
    }

    for (const [id, sourceSource] of Object.entries(sourceCatalog.sources ?? {})) {
      const targetSource = cat.sources[id];
      if (!targetSource) {
        cat.sources[id] = sourceSource;
        report.sources.added += 1;
        continue;
      }
      if ((sourceSource.lastCheckedAt ?? '') > (targetSource.lastCheckedAt ?? '')) {
        cat.sources[id] = { ...targetSource, ...sourceSource };
        report.sources.updated += 1;
      }
    }

    for (const [key, sourceAvatar] of Object.entries(sourceCatalog.channelAvatars ?? {})) {
      if (!sourceAvatar?.localPath) continue;
      const targetAvatar = cat.channelAvatars[key];
      const targetValid = targetAvatar?.localPath && !targetAvatar.error;
      if (targetValid) continue; // il target ha già un avatar buono: non si sostituisce
      const ok = copyImageIfPresent(sPaths.avatarsDir, targetPaths.avatarsDir, sourceAvatar.localPath, { copyFiles });
      if (!ok) continue;
      cat.channelAvatars[key] = { ...sourceAvatar };
      report.avatarsCopied += 1;
      if (targetAvatar) report.channelAvatars.updated += 1;
      else report.channelAvatars.added += 1;
    }

    const existingUrls = new Set((cat.queue ?? []).map((q) => q.url));
    for (const item of sourceCatalog.queue ?? []) {
      if (existingUrls.has(item.url)) continue;
      cat.queue.push(item);
      existingUrls.add(item.url);
      report.queueAdded += 1;
    }
  }

  if (dryRun) {
    const clone = structuredClone(await readCatalog());
    applyMerge(clone);
    for (const id of Object.keys(sourceMetadata)) {
      if (!(await readMetadata(id))) report.metadataEntriesAdded += 1;
    }
    return report;
  }

  // Copia di sicurezza del catalogo target prima di mutarlo: stesso principio
  // di restoreBackup (backupService.js), mai scrivere senza un modo per
  // tornare indietro.
  if (existsSync(targetPaths.catalogPath)) {
    const safetyPath = path.join(targetPaths.dataDir, `pre-merge-${timestamp()}.json`);
    copyFileSync(targetPaths.catalogPath, safetyPath);
    report.safetyBackupPath = safetyPath;
  }

  await updateCatalog((cat) => applyMerge(cat));

  // metadata.json: fill-gap via metadataStore (mai bypassato con fs diretto,
  // per non desincronizzare la sua cache in-memory).
  for (const [id, entry] of Object.entries(sourceMetadata)) {
    if (await readMetadata(id)) continue;
    await setMetadata(id, entry);
    report.metadataEntriesAdded += 1;
  }

  return report;
}
