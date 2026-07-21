import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { getPaths, loadConfig } from '../config.js';
import { setMetadata } from '../catalog/metadataStore.js';

// YouTube richiede un runtime JavaScript per decifrare le firme dei formati
// video: senza, alcuni download falliscono con HTTP 403 a metà (verificato).
// Node è già una dipendenza del progetto, quindi lo usiamo come runtime.
const JS_RUNTIME_ARGS = ['--js-runtimes', 'node'];

// Alcuni video vengono assegnati da YouTube a un esperimento che richiede un
// "PO Token" per i client normali (web/ios/tv): senza, i loro formati falliscono
// con HTTP 403 in modo sistematico e ripetibile (verificato con --verbose: "PO
// Token Providers: none" + "Detected experiment to bind GVS PO Token..."). Il
// client "android_vr" non è soggetto a questo esperimento. Aggiunto come client
// supplementare (non sostitutivo: "default" resta incluso) così i video non
// interessati dall'esperimento continuano a usare i client abituali, e quelli
// che lo sono trovano comunque formati funzionanti senza bisogno di un PO Token.
const PLAYER_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=default,android_vr'];

let cachedVersion = null;

export async function getYtdlpVersion() {
  if (cachedVersion) return cachedVersion;
  const { ytdlpBinaryPath } = getPaths();
  cachedVersion = await new Promise((resolve, reject) => {
    const proc = spawn(ytdlpBinaryPath, ['--version']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`yt-dlp --version terminato con codice ${code}`));
    });
  });
  return cachedVersion;
}

export async function getPlaylistEntries(playlistUrl) {
  const { ytdlpBinaryPath } = getPaths();
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(ytdlpBinaryPath, [...JS_RUNTIME_ARGS, ...PLAYER_CLIENT_ARGS, '--flat-playlist', '-J', playlistUrl]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp (enumerazione playlist) terminato con codice ${code}: ${err.slice(-500)}`));
    });
  });

  const data = JSON.parse(stdout);
  const entries = data.entries ?? [];
  return {
    title: data.title ?? null,
    entries: entries.map((entry, index) => ({
      id: entry.id,
      title: entry.title ?? null,
      channelName: entry.channel ?? entry.uploader ?? null,
      durationSeconds: entry.duration ?? null,
      playlistIndex: index + 1
    }))
  };
}

// Risolve id/titolo/canale/extractor di un singolo video da un URL qualunque,
// senza scaricare nulla: usata dal download one-off per supportare qualunque
// sito che yt-dlp sa gestire (YouTube, Rumble, ecc.), non solo YouTube. Gli
// extractor-args specifici di YouTube (JS_RUNTIME_ARGS/PLAYER_CLIENT_ARGS) sono
// innocui sugli altri siti: yt-dlp li ignora silenziosamente se l'extractor in
// uso non è "youtube".
export async function resolveVideoInfo(url) {
  const paths = getPaths();
  const args = [...JS_RUNTIME_ARGS, ...PLAYER_CLIENT_ARGS, '--skip-download', '-J'];
  if (paths.cookiesPath) args.push('--cookies', paths.cookiesPath);
  args.push(url);

  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(paths.ytdlpBinaryPath, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp (risoluzione video) terminato con codice ${code}: ${err.slice(-500)}`));
    });
  });

  const info = JSON.parse(stdout);
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    throw new Error('Questo link punta a una playlist/canale, non a un singolo video — usa "Gestisci fonti" per una playlist.');
  }

  return {
    id: info.id,
    title: info.title ?? null,
    extractor: info.extractor ?? null,
    webpageUrl: info.webpage_url ?? url,
    channelName: info.channel ?? info.uploader ?? null,
    durationSeconds: info.duration ?? null
  };
}

// Arricchimento metadati (M26): estrae i metadati COMPLETI di un singolo video
// SENZA scaricarlo (--skip-download) e ne cacha la copertina in
// media/thumbnails/<id>.jpg. Così, appena aggiunta una fonte, la libreria si
// popola di schede ricche (descrizione, tag, canale, capitoli, copertina) senza
// dover scaricare i video; e un video poi "rimosso" (M27) conserva comunque la
// sua copertina anche quando l'URL YouTube muore. Ritorna i campi curati mappati
// (compreso `thumbnail`); il chiamante scarta l'oggetto `video` (nessun file
// scaricato) e fonde il resto nella entry di catalogo.
export async function fetchVideoMetadata(videoId, url, { onLog = () => {} } = {}) {
  const paths = getPaths();
  const args = [
    ...JS_RUNTIME_ARGS,
    ...PLAYER_CLIENT_ARGS,
    '--skip-download',
    '--write-info-json',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    // info.json e thumbnail finiscono entrambi in media/thumbnails/<id>.*; il
    // sidecar .info.json viene poi consolidato in data/metadata.json e cancellato.
    '-o', path.join(paths.thumbnailsDir, '%(id)s.%(ext)s')
  ];
  if (paths.ffmpegLocation) args.push('--ffmpeg-location', paths.ffmpegLocation);
  // I cookie qui sono innocui: l'estrazione dei soli metadati non scarica i byte
  // del video dalla CDN (dove il mix cookie+android_vr darebbe 403), quindi si
  // includono se presenti, come in resolveVideoInfo.
  if (paths.cookiesPath) args.push('--cookies', paths.cookiesPath);
  args.push(url);

  await runYtdlp(paths, args, { onLog, onProgress: () => {} });

  const infoPath = path.join(paths.thumbnailsDir, `${videoId}.info.json`);
  if (!existsSync(infoPath)) {
    throw new Error(`Metadati non trovati dopo l'estrazione per ${videoId}`);
  }
  const info = JSON.parse(readFileSync(infoPath, 'utf-8'));

  // Pulisce eventuali thumbnail intermedie (es. .webp prima della conversione a
  // jpg) per non lasciare orfani accanto alla copertina definitiva.
  if (existsSync(paths.thumbnailsDir)) {
    for (const f of readdirSync(paths.thumbnailsDir)) {
      if (f.startsWith(`${videoId}.`) && !f.endsWith('.jpg') && !f.endsWith('.info.json')) {
        unlinkSync(path.join(paths.thumbnailsDir, f));
      }
    }
  }
  const thumbnailFile = existsSync(path.join(paths.thumbnailsDir, `${videoId}.jpg`)) ? `${videoId}.jpg` : null;

  const fields = mapInfoJsonToVideoFields(info, { videoFile: null, thumbnailFile, sizeBytes: null, sha256: null, ytdlpVersion: null });
  await consolidateMetadata(videoId, info, infoPath);
  return fields;
}

// Risolve la foto profilo di un canale interrogando l'URL del canale stesso
// (M14): i metadati per-video (mapInfoJsonToVideoFields) non contengono
// alcun campo avatar (verificato su data/metadata.json reale), quindi serve
// un'interrogazione dedicata. --playlist-items 0 evita di enumerare i video
// del canale, economico come getPlaylistEntries.
export async function resolveChannelAvatar(channelUrl) {
  const paths = getPaths();
  const args = [...JS_RUNTIME_ARGS, '--playlist-items', '0', '-J'];
  if (paths.cookiesPath) args.push('--cookies', paths.cookiesPath);
  args.push(channelUrl);

  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(paths.ytdlpBinaryPath, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`yt-dlp (risoluzione avatar canale) terminato con codice ${code}: ${err.slice(-500)}`));
    });
  });

  const data = JSON.parse(stdout);
  return { avatarUrl: pickAvatarUrl(data) };
}

// L'avatar del canale non ha una chiave dedicata: vive dentro l'array
// "thumbnails" (condiviso con l'immagine banner) taggato con id
// "avatar_uncropped" — verificato empiricamente contro un canale reale
// (yt-dlp 2026.07.04). Fallback difensivo su un id che contiene "avatar" per
// eventuali variazioni future, poi sulla thumbnail quadrata più grande
// (l'avatar è sempre 1:1, a differenza del banner che è molto più largo che
// alto) per non restare senza nulla se yt-dlp cambiasse convenzione di id.
function pickAvatarUrl(data) {
  const thumbs = Array.isArray(data.thumbnails) ? data.thumbnails : [];
  const uncropped = thumbs.find((t) => t.id === 'avatar_uncropped');
  if (uncropped) return uncropped.url;
  const avatarLike = thumbs.find((t) => /avatar/i.test(t.id ?? ''));
  if (avatarLike) return avatarLike.url;
  const square = thumbs
    .filter((t) => t.width && t.height && t.width === t.height)
    .sort((a, b) => b.width - a.width)[0];
  return square?.url ?? null;
}

function buildFormatSelector(format, maxHeight) {
  if (!maxHeight) return format;
  // L'esclusione AV1 è un workaround specifico di YouTube (vedi PLAYER_CLIENT_ARGS
  // sopra); su altri siti (es. Rumble) può escludere l'unico formato disponibile,
  // quindi l'ultimo fallback ("b[height<=N]") non la applica.
  return `bv*[height<=${maxHeight}][vcodec!*=av01]+ba/b[height<=${maxHeight}][vcodec!*=av01]/b[height<=${maxHeight}]`;
}

function parseProgressPercent(line) {
  const match = line.match(/\[download\]\s+([\d.]+)%/);
  return match ? parseFloat(match[1]) : null;
}

export function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Elenca ricorsivamente tutti i file sotto dir (path assoluti).
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// I video ora vivono in sottocartelle per creator con nome "<Titolo> [<id>].<ext>"
// (vedi buildDownloadArgs): non basta più un match piatto per prefisso id. Si
// cerca ricorsivamente il file il cui basename contiene il marker "[<id>]" —
// l'id è univoco, quindi il match è robusto qualunque sia la sanitizzazione del
// titolo/creator fatta da yt-dlp. videoFile/infoFile sono ritornati come
// percorso RELATIVO a videosDir (separatori normalizzati a "/"), così finiscono
// direttamente in video.localPath; la thumbnail resta piatta per id.
function findDownloadedFiles(paths, videoId) {
  const marker = `[${videoId}]`;
  const videoDirFiles = existsSync(paths.videosDir) ? walkFiles(paths.videosDir) : [];
  const matching = videoDirFiles.filter((f) => path.basename(f).includes(marker));
  const videoAbs = matching.find((f) => /\.(mp4|mkv|webm)$/i.test(f)) ?? null;
  const infoAbs = matching.find((f) => f.endsWith('.info.json')) ?? null;

  const toRel = (abs) => (abs ? path.relative(paths.videosDir, abs).split(path.sep).join('/') : null);

  const thumbDirFiles = existsSync(paths.thumbnailsDir)
    ? readdirSync(paths.thumbnailsDir).filter((f) => f.startsWith(`${videoId}.`))
    : [];
  const thumbnailFile = thumbDirFiles.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f)) ?? null;

  return { videoFile: toRel(videoAbs), infoFile: toRel(infoAbs), thumbnailFile };
}

function isoDateFromYyyymmdd(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Salva il metadato grezzo in data/metadata.json (unica fonte, non più sparso
// accanto a ogni video) e cancella il sidecar .info.json scritto da yt-dlp.
async function consolidateMetadata(videoId, info, infoFilePath) {
  await setMetadata(videoId, info);
  if (existsSync(infoFilePath)) unlinkSync(infoFilePath);
}

// Se il download fallisce (es. HTTP 403), yt-dlp può comunque aver già scritto
// .info.json e/o la thumbnail prima dell'errore: senza pulizia restano orfani
// (non referenziati da nessuna entry "downloaded" nel catalogo, invisibili in
// "Guarda", ma occupano spazio). Il file .part del video viene invece
// deliberatamente preservato: yt-dlp lo userà per riprendere il download dal
// punto in cui si era fermato al prossimo tentativo, invece di ripartire da zero.
function cleanupFailedDownloadArtifacts(paths, videoId) {
  const marker = `[${videoId}]`;
  const videoDirFiles = existsSync(paths.videosDir) ? walkFiles(paths.videosDir) : [];
  for (const full of videoDirFiles) {
    const base = path.basename(full);
    if (!base.includes(marker)) continue;
    if (base.endsWith('.part') || /\.(mp4|mkv|webm)$/i.test(base)) continue;
    unlinkSync(full);
  }
  if (existsSync(paths.thumbnailsDir)) {
    for (const f of readdirSync(paths.thumbnailsDir).filter((f) => f.startsWith(`${videoId}.`))) {
      unlinkSync(path.join(paths.thumbnailsDir, f));
    }
  }
}

export function mapInfoJsonToVideoFields(info, { videoFile, thumbnailFile, sizeBytes, sha256, ytdlpVersion }) {
  const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;

  return {
    title: info.title ?? null,
    description: info.description ?? null,
    webpageUrl: info.webpage_url ?? null,
    originalUrl: info.original_url ?? info.webpage_url ?? null,
    extractor: info.extractor ?? null,
    channel: {
      id: info.channel_id ?? null,
      name: info.channel ?? info.uploader ?? null,
      url: info.channel_url ?? null,
      uploaderId: info.uploader_id ?? null,
      uploaderUrl: info.uploader_url ?? null,
      subscriberCountAtDownload: info.channel_follower_count ?? null
    },
    uploadDate: isoDateFromYyyymmdd(info.upload_date),
    releaseTimestamp: info.release_timestamp ? new Date(info.release_timestamp * 1000).toISOString() : null,
    durationSeconds: info.duration ?? null,
    categories: info.categories ?? [],
    tags: info.tags ?? [],
    language: info.language ?? null,
    ageLimit: info.age_limit ?? null,
    availability: info.availability ?? null,
    license: info.license ?? null,
    isLive: Boolean(info.is_live),
    wasLive: Boolean(info.was_live),
    statsAtDownload: {
      viewCount: info.view_count ?? null,
      likeCount: info.like_count ?? null,
      commentCount: info.comment_count ?? null,
      averageRating: info.average_rating ?? null
    },
    resolution: {
      width: info.width ?? null,
      height: info.height ?? null,
      fps: info.fps ?? null,
      dynamicRange: info.dynamic_range ?? null
    },
    thumbnails: Array.isArray(info.thumbnails)
      ? info.thumbnails.map((t) => ({ url: t.url, width: t.width ?? null, height: t.height ?? null }))
      : [],
    thumbnail: {
      sourceUrl: info.thumbnail ?? null,
      localPath: thumbnailFile
    },
    chapters: Array.isArray(info.chapters)
      ? info.chapters.map((c) => ({ title: c.title ?? null, startSeconds: c.start_time ?? null, endSeconds: c.end_time ?? null }))
      : [],
    subtitleLanguagesAvailable: Object.keys(info.subtitles ?? {}),
    video: {
      localPath: videoFile,
      formatId: info.format_id ?? null,
      container: videoFile ? path.extname(videoFile).replace('.', '') : null,
      videoCodec: requested?.vcodec ?? info.vcodec ?? null,
      audioCodec: requested?.acodec ?? info.acodec ?? null,
      bitrateKbps: info.tbr ?? null,
      sizeBytes,
      sha256,
      downloadedAt: new Date().toISOString(),
      ytdlpVersion
    }
  };
}

function buildDownloadArgs(paths, config, formatSelector, url, { useCookies }) {
  const args = [
    ...JS_RUNTIME_ARGS,
    ...PLAYER_CLIENT_ARGS,
    '-f', formatSelector,
    '--merge-output-format', config.ytdlp.mergeOutputFormat,
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--write-info-json',
    '--newline',
    // Archivio canonico per creator, nome leggibile con id finale (come il
    // default di yt-dlp): media/videos/<Creator>/<Titolo> [<id>].<ext>. yt-dlp
    // sanifica da solo i caratteri non validi per Windows e crea le sottocartelle.
    // Il fallback "|Sconosciuto" copre i (rari) casi senza channel/uploader.
    // L'.info.json segue automaticamente questo stesso template.
    '-o', path.join(paths.videosDir, '%(channel,uploader|Sconosciuto)s', '%(title)s [%(id)s].%(ext)s'),
    // Le thumbnail restano piatte per id (interne, non sfogliate dall'utente).
    '-o', `thumbnail:${path.join(paths.thumbnailsDir, '%(id)s.%(ext)s')}`,
    '--download-archive', paths.downloadArchivePath
  ];
  if (paths.ffmpegLocation) args.push('--ffmpeg-location', paths.ffmpegLocation);
  if (useCookies && paths.cookiesPath) {
    args.push('--cookies', paths.cookiesPath);
  }
  args.push(url);
  return args;
}

function runYtdlp(paths, args, { onLog, onProgress }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(paths.ytdlpBinaryPath, args, { cwd: paths.projectRoot });
    const rlOut = readline.createInterface({ input: proc.stdout });
    const rlErr = readline.createInterface({ input: proc.stderr });
    let stderrTail = '';

    rlOut.on('line', (line) => {
      onLog(line);
      const pct = parseProgressPercent(line);
      if (pct !== null) onProgress(pct);
    });
    rlErr.on('line', (line) => {
      onLog(line);
      stderrTail = `${stderrTail}\n${line}`.slice(-1000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp terminato con codice ${code}: ${stderrTail.trim()}`));
    });
  });
}

// videoId è l'id già risolto (da yt-dlp stesso, tramite resolveVideoInfo() o
// l'enumerazione playlist) usato solo per ritrovare i file scritti da yt-dlp
// dopo il download (-o "%(id)s.%(ext)s" produce sempre lo stesso id). url è il
// link da cui scaricare per davvero — qualunque sito supportato da yt-dlp, non
// solo YouTube.
export async function downloadVideo(videoId, url, { onLog = () => {}, onProgress = () => {} } = {}) {
  const paths = getPaths();
  const config = loadConfig();
  const formatSelector = buildFormatSelector(config.ytdlp.format, config.ytdlp.maxHeight);

  try {
    // Prima senza cookie: per contenuti pubblici (il caso comune) è più
    // affidabile — inviare i cookie del browser insieme al client "android_vr"
    // usato per bypassare l'esperimento PO Token usato da YouTube genera in
    // pratica un mix sospetto (sessione desktop + identità client mobile) che
    // YouTube rifiuta sistematicamente con HTTP 403 sulla CDN video, anche se
    // le fasi di estrazione metadati precedenti vanno a buon fine (verificato).
    // Se il primo tentativo fallisce e sono configurati dei cookie, si ritenta
    // con quelli: restano necessari per i video privati/non listati del
    // proprio account, lo scopo originale di core/cookies.txt.
    try {
      await runYtdlp(paths, buildDownloadArgs(paths, config, formatSelector, url, { useCookies: false }), { onLog, onProgress });
    } catch (firstErr) {
      if (!paths.cookiesPath) throw firstErr;
      onLog('Primo tentativo (senza cookie) fallito, riprovo con i cookie (potrebbe essere un video privato/non listato)...');
      cleanupFailedDownloadArtifacts(paths, videoId);
      await runYtdlp(paths, buildDownloadArgs(paths, config, formatSelector, url, { useCookies: true }), { onLog, onProgress });
    }

    const { videoFile, infoFile, thumbnailFile } = findDownloadedFiles(paths, videoId);
    if (!videoFile || !infoFile) {
      throw new Error(`Download completato ma file mancanti per ${videoId} (video: ${videoFile}, info.json: ${infoFile})`);
    }

    const infoPath = path.join(paths.videosDir, infoFile);
    const info = JSON.parse(readFileSync(infoPath, 'utf-8'));
    const sizeBytes = statSync(path.join(paths.videosDir, videoFile)).size;
    const sha256 = await hashFileSha256(path.join(paths.videosDir, videoFile));
    const ytdlpVersion = await getYtdlpVersion();

    await consolidateMetadata(videoId, info, infoPath);

    return mapInfoJsonToVideoFields(info, { videoFile, thumbnailFile, sizeBytes, sha256, ytdlpVersion });
  } catch (err) {
    cleanupFailedDownloadArtifacts(paths, videoId);
    throw err;
  }
}
