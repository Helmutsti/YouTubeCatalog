import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { getPaths, loadConfig } from '../config.js';
import { setMetadata } from '../catalog/metadataStore.js';
import { removeFromDownloadArchive } from '../services/libraryService.js';

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
//
// AGGIUNTA `web_embedded` (verificato su TDeUgkAGVXU, 2026-07-23): per certi
// video `default`/`android_vr` (e mweb/android/tv_embedded) esponevano SOLO fino
// a 360p, mentre `web/tv/ios/web_safari` fallivano del tutto — l'utente vedeva
// solo 360p pur essendo il video a 1080p su YouTube. Il client `web_embedded`
// espone i formati DASH pieni (1080p video-only + audio-only) senza PO Token:
// con esso incluso, il selettore torna a prendere 248+140 = 1080p. Anch'esso
// supplementare: aggiunge opzioni, non sostituisce nulla.
const PLAYER_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=default,android_vr,web_embedded'];

// yt-dlp segnala così un video reso privato dall'autore o comunque sparito per
// sempre da YouTube — verificato dal vivo su 3 varianti reali: "Private video.
// Sign in if you've been granted access...", "Video unavailable. This video is
// no longer available because the YouTube account associated with this video
// has been terminated.", "Video unavailable. It was removed following a
// copyright removal request by <titolare>". Tutte iniziano con "Private video"
// o "Video unavailable" — segnali DEFINITIVI, diversi da un errore di
// rete/server temporaneo — usati per marcare il video "Rimosso" subito invece
// di lasciarlo per sempre in limbo come "da scaricare" senza titolo/canale
// (bug reale trovato: solo "private video" era intercettato, i video con
// account terminato/rimozione per copyright restavano bloccati per sempre,
// ri-tentati a ogni sync senza mai avere successo né essere segnalati).
export function isVideoGoneError(err) {
  return /private video|video unavailable/i.test(err?.message ?? '');
}

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
    // Totale dichiarato da YouTube per la playlist (backlog #4): se differisce
    // dagli entries realmente enumerati, qualche video non è visibile in questa
    // estrazione (privato/rimosso/glitch). Può essere null se yt-dlp non lo espone.
    declaredCount: data.playlist_count ?? null,
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
    durationSeconds: info.duration ?? null,
    // M55: riepilogo dei formati disponibili in questa estrazione, per decidere
    // se serve chiedere all'utente la strategia audio (vedi summarizeFormats).
    formatsSummary: summarizeFormats(info)
  };
}

// M55 — Analizza i formati esposti da un'estrazione yt-dlp (`-J`) per capire se
// la "qualità piena" è ottenibile out-of-the-box o se serve una scelta.
// Contesto: YouTube a volte (gating PO-token, estrazione degradata) espone il
// video-only ad alta risoluzione ma NON una traccia audio-only da accoppiare;
// in quel caso `bv*+ba` non trova l'audio e si ripiega sul miglior formato
// COMBINATO (spesso 360p, format 18) — download silenziosamente basso.
export function summarizeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const hasV = (f) => f.vcodec && f.vcodec !== 'none';
  const hasA = (f) => f.acodec && f.acodec !== 'none';
  const maxHeight = (arr) => arr.reduce((m, f) => Math.max(m, f.height || 0), 0);

  const videoBearing = formats.filter(hasV);
  const audioOnly = formats.filter((f) => hasA(f) && !hasV(f));
  const combined = formats.filter((f) => hasV(f) && hasA(f));

  const maxVideoHeight = maxHeight(videoBearing);
  const maxCombinedHeight = maxHeight(combined);
  const hasAudioOnly = audioOnly.length > 0;

  // Risoluzioni scaricabili distinte (M56): altezze uniche dei formati con video,
  // dalla più alta alla più bassa — è la lista di scelta mostrata all'utente.
  const availableHeights = [...new Set(videoBearing.map((f) => f.height).filter(Boolean))]
    .sort((a, b) => b - a);

  return {
    maxVideoHeight,
    maxCombinedHeight,
    hasAudioOnly,
    availableHeights,
    // La miglior risoluzione (video-only) supera il miglior combinato E non c'è
    // audio-only da fondere: yt-dlp ripiegherebbe sul combinato basso. Serve
    // chiedere all'utente (Opzione A: combinato basso; Opzione B: video max +
    // audio del combinato, fuso via ffmpeg — yt-dlp non lo fa da sé).
    needsAudioChoice: !hasAudioOnly && maxVideoHeight > maxCombinedHeight
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

// M55 — Selettori per le strategie audio alternative (vedi summarizeFormats).
// M56: `maxHeight` è il tetto di risoluzione (scelto dall'utente per-download o
// da config), null = nessun cap.
// 'combined' (Opzione A): solo il miglior formato COMBINATO (audio+video già
// insieme), coerente ma a risoluzione più bassa.
function combinedSelector(maxHeight) {
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  return `b${h}[vcodec!*=av01]/b${h}/b`;
}
// 'merged' (Opzione B): il miglior flusso VIDEO-only, da fondere poi con l'audio
// via ffmpeg (yt-dlp non sa prendere l'audio da un combinato in un merge -f).
function videoOnlySelector(maxHeight) {
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  return `bv*${h}[vcodec!*=av01]/bv*${h}/bv*`;
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

function runYtdlp(paths, args, { onLog, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    // signal (M51, interruzione manuale): passato nativamente a spawn — Node
    // uccide il processo da sé quando viene abortito, senza bisogno di
    // gestire noi stessi l'invio del segnale al child.
    const proc = spawn(paths.ytdlpBinaryPath, args, { cwd: paths.projectRoot, signal });
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
export async function downloadVideo(videoId, url, { onLog = () => {}, onProgress = () => {}, signal, audioStrategy, maxHeight } = {}) {
  const paths = getPaths();
  const config = loadConfig();
  // M56: tetto di risoluzione effettivo = scelta per-download (se passata),
  // altrimenti il default globale di config. undefined ⇒ usa config; null da UI
  // ("massima") azzera il cap. Coalescing solo su undefined per rispettare null.
  const effectiveMaxHeight = maxHeight === undefined ? config.ytdlp.maxHeight : maxHeight;

  // M55 root-fix (bug "restart distruttivo"): una riga residua in
  // --download-archive faceva SALTARE il download a yt-dlp (esce ok, non scrive
  // l'.info.json) → "file mancanti" → il video finiva 'failed' pur avendo un
  // file su disco. Ogni download di un singolo video è una richiesta esplicita
  // di scaricare QUEL video: si toglie la sua riga d'archivio prima, così
  // yt-dlp ri-scarica davvero (l'archivio resta come ledger ridondante di
  // dedup per le sync di playlist, ma non blocca mai un download esplicito).
  removeFromDownloadArchive(paths, videoId);

  // M55 — Opzione B: video max + audio fuso via ffmpeg (yt-dlp da solo non sa
  // prendere l'audio da un formato combinato in un merge -f, verificato).
  if (audioStrategy === 'merged') {
    return downloadMergedVideoAudio(videoId, url, { onLog, onProgress, signal, paths, config, maxHeight: effectiveMaxHeight });
  }

  // 'combined' (Opzione A) → solo il miglior combinato; altrimenti il selettore
  // di default (video-only + audio-only, poi combinato). Entrambi cappati a
  // effectiveMaxHeight (scelta risoluzione M56).
  const formatSelector = audioStrategy === 'combined'
    ? combinedSelector(effectiveMaxHeight)
    : buildFormatSelector(config.ytdlp.format, effectiveMaxHeight);

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
      await runYtdlp(paths, buildDownloadArgs(paths, config, formatSelector, url, { useCookies: false }), { onLog, onProgress, signal });
    } catch (firstErr) {
      // Interruzione manuale (M51): mai il retry con i cookie — l'utente ha
      // chiesto di fermarsi, non di riprovare in un altro modo.
      if (signal?.aborted) throw firstErr;
      if (!paths.cookiesPath) throw firstErr;
      onLog('Primo tentativo (senza cookie) fallito, riprovo con i cookie (potrebbe essere un video privato/non listato)...');
      cleanupFailedDownloadArtifacts(paths, videoId);
      await runYtdlp(paths, buildDownloadArgs(paths, config, formatSelector, url, { useCookies: true }), { onLog, onProgress, signal });
    }

    return await finalizeDownload(paths, videoId);
  } catch (err) {
    cleanupFailedDownloadArtifacts(paths, videoId);
    // Messaggio leggibile invece del generico AbortError di Node — il resto
    // del trattamento (download:'failed', attempts++) resta invariato, per
    // scelta esplicita (M51): niente nuovo stato dedicato per l'interruzione.
    if (signal?.aborted) throw new Error('Download interrotto dall\'utente.');
    throw err;
  }
}

// Passi comuni post-download (normale e fuso): individua i file scritti da
// yt-dlp, legge l'.info.json, calcola size/sha, consolida i metadati grezzi e
// mappa i campi curati. Aggiunge la nota di qualità (M55, "segnala soltanto").
async function finalizeDownload(paths, videoId) {
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

  const fields = mapInfoJsonToVideoFields(info, { videoFile, thumbnailFile, sizeBytes, sha256, ytdlpVersion });
  fields.video.qualityNote = detectQualityNote(info);
  return fields;
}

// M55 "segnala soltanto": segnala un download a bassa risoluzione (≤360p).
// Su un servizio moderno come YouTube il 360p (tipicamente il format 18
// combinato) è quasi sempre un RIPIEGO — estrazione degradata / gating PO-token
// — non la qualità reale del video. Va segnalato SEMPRE, anche quando l'intera
// estrazione era degradata a 360p (caso reale: `maxVideoHeight` della stessa
// estrazione risultava 360, quindi il vecchio confronto "max > scaricato" non
// scattava mai e l'utente non veniva avvisato). `maxAvailableHeight` è noto solo
// se QUESTA estrazione esponeva formati più alti; altrimenti null = "non noto"
// (YouTube potrebbe averla limitata temporaneamente: riprovare più tardi).
function detectQualityNote(info) {
  const downloadedHeight = info.height || 0;
  if (!downloadedHeight || downloadedHeight > 360) return null;
  const { maxVideoHeight } = summarizeFormats(info);
  return {
    downloadedHeight,
    maxAvailableHeight: maxVideoHeight > downloadedHeight ? maxVideoHeight : null,
    at: new Date().toISOString()
  };
}

// M55 — Opzione B: scarica il miglior video-only e la miglior traccia audio in
// due passaggi, poi li fonde con ffmpeg. Serve perché in un'estrazione degradata
// (nessun audio-only, video-only alto + solo un combinato basso) yt-dlp da solo
// scarterebbe il combinato in un merge `-f`, lasciando video senza audio.
async function downloadMergedVideoAudio(videoId, url, { onLog, onProgress, signal, paths, config, maxHeight }) {
  const runWithCookieFallback = async (buildArgs) => {
    try {
      await runYtdlp(paths, buildArgs({ useCookies: false }), { onLog, onProgress, signal });
    } catch (firstErr) {
      if (signal?.aborted) throw firstErr;
      if (!paths.cookiesPath) throw firstErr;
      onLog('Primo tentativo (senza cookie) fallito, riprovo con i cookie...');
      cleanupFailedDownloadArtifacts(paths, videoId);
      await runYtdlp(paths, buildArgs({ useCookies: true }), { onLog, onProgress, signal });
    }
  };

  try {
    onLog('Strategia "fusione": scarico il flusso video alla massima risoluzione...');
    await runWithCookieFallback(({ useCookies }) =>
      buildDownloadArgs(paths, config, videoOnlySelector(maxHeight), url, { useCookies }));

    onLog('Scarico la migliore traccia audio disponibile...');
    const audioTemplate = path.join(paths.thumbnailsDir, `__mux_${videoId}_audio.%(ext)s`);
    await runWithCookieFallback(({ useCookies }) =>
      buildAudioOnlyArgs(paths, audioTemplate, url, { useCookies }));

    const { videoFile } = findDownloadedFiles(paths, videoId);
    if (!videoFile) throw new Error(`Flusso video non trovato dopo il download per ${videoId}`);
    const videoAbs = path.join(paths.videosDir, videoFile);
    const audioAbs = findTempAudioFile(paths, videoId);
    if (!audioAbs) throw new Error(`Traccia audio non trovata dopo il download per ${videoId}`);

    onLog('Fondo video e audio (ffmpeg)...');
    const mergedAbs = await muxVideoAudio(paths, videoAbs, audioAbs, signal);
    // Rimuove il video-only originale se il fuso ha nome/estensione diversi
    // (es. sorgente .webm → fuso .mp4) e la traccia audio temporanea.
    if (path.resolve(mergedAbs) !== path.resolve(videoAbs) && existsSync(videoAbs)) unlinkSync(videoAbs);
    if (existsSync(audioAbs)) unlinkSync(audioAbs);

    return await finalizeDownload(paths, videoId);
  } catch (err) {
    cleanupFailedDownloadArtifacts(paths, videoId);
    const leftover = findTempAudioFile(paths, videoId);
    if (leftover && existsSync(leftover)) unlinkSync(leftover);
    if (signal?.aborted) throw new Error('Download interrotto dall\'utente.');
    throw err;
  }
}

// Args per scaricare la sola miglior traccia audio (audio-only se c'è, altrimenti
// da un combinato) in un file temporaneo separato: niente info.json/thumbnail/
// archivio, che restano di competenza del download video-only principale.
function buildAudioOnlyArgs(paths, outTemplate, url, { useCookies }) {
  const args = [
    ...JS_RUNTIME_ARGS,
    ...PLAYER_CLIENT_ARGS,
    '-f', 'ba*/b',
    '--newline',
    '-o', outTemplate
  ];
  if (paths.ffmpegLocation) args.push('--ffmpeg-location', paths.ffmpegLocation);
  if (useCookies && paths.cookiesPath) args.push('--cookies', paths.cookiesPath);
  args.push(url);
  return args;
}

function findTempAudioFile(paths, videoId) {
  const prefix = `__mux_${videoId}_audio.`;
  if (!existsSync(paths.thumbnailsDir)) return null;
  const f = readdirSync(paths.thumbnailsDir).find((x) => x.startsWith(prefix));
  return f ? path.join(paths.thumbnailsDir, f) : null;
}

// Fonde video + audio in un mp4 (stream copy, nessuna ricodifica) mappando il
// video dal primo input e l'audio dal secondo. Ritorna il path assoluto del
// file fuso ("<base>.mp4" accanto al video-only).
//
// `signal` (M58): come runYtdlp, lo spawn riceve nativamente l'AbortSignal —
// senza, l'interruzione manuale (la "X") veniva IGNORATA durante questa fase di
// merge (unico spawn del pipeline di download che non lo propagava): ffmpeg
// finiva comunque e il job poteva chiudersi come "scaricato" nonostante l'abort.
// All'abort Node uccide ffmpeg ed emette 'error' (AbortError) → si rifiuta la
// promise, che risale al catch di downloadMergedVideoAudio (già gestisce
// signal?.aborted). Il file temporaneo di merge va ripulito anche in questo caso.
function muxVideoAudio(paths, videoAbs, audioAbs, signal) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(videoAbs);
    const base = path.basename(videoAbs, path.extname(videoAbs));
    const finalAbs = path.join(dir, `${base}.mp4`);
    const tmpAbs = path.join(dir, `${base}.__muxtmp.mp4`);
    const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffmpeg = paths.ffmpegLocation ? path.join(paths.ffmpegLocation, bin) : bin;
    const args = ['-y', '-i', videoAbs, '-i', audioAbs, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', tmpAbs];
    const proc = spawn(ffmpeg, args, { signal });
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = `${errTail}${d.toString()}`.slice(-1000); });
    proc.on('error', (err) => {
      // Sia l'abort (AbortError) sia un errore di avvio lasciano il tmp a metà.
      if (existsSync(tmpAbs)) { try { unlinkSync(tmpAbs); } catch { /* best-effort */ } }
      reject(err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        if (existsSync(tmpAbs)) unlinkSync(tmpAbs);
        return reject(new Error(`ffmpeg (fusione video+audio) terminato con codice ${code}: ${errTail.trim()}`));
      }
      if (existsSync(finalAbs) && path.resolve(finalAbs) !== path.resolve(videoAbs)) unlinkSync(finalAbs);
      renameSync(tmpAbs, finalAbs);
      resolve(finalAbs);
    });
  });
}
