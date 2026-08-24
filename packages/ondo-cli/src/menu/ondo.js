// M86 — l'adattatore fra la CLI (tradotta 1:1 dal ramo Rust) e `@catalog/core`.
//
// Perché esiste: i moduli della CLI Rust chiamavano `Library` e `Downloader`, due
// oggetti con metodi **sincroni** e uno stato in memoria. Questo core è a
// funzioni asincrone su `data/catalog.json`. Tradurre riga per riga sparpagliando
// `await` dentro i menu avrebbe reso i sei file irriconoscibili rispetto
// all'originale — e quindi impossibili da confrontare quando qualcosa diverge.
//
// Qui invece la forma dell'originale resta: `lib.list(filter)` è sincrona perché
// lavora su una **fotografia** del catalogo, ripresa da `refresh()` a ogni giro di
// menu — che è esattamente ciò che faceva la `Library` di Rust, che teneva il
// catalogo in memoria e lo rileggeva solo quando lo mutava. Le mutazioni, quelle,
// restano asincrone: sono le uniche righe dove i due sorgenti differiscono.
//
// Il `Downloader` è il pool di job del core visto come il pool di sentinel del
// ramo Rust: `pushWith` accoda, `statuses()` restituisce la fotografia di tutti i
// job di questa sessione. Come là, **non c'è stato da perdere** uscendo da una
// schermata: lo stato sta dove sanno le cose (il core), non nella schermata.

import path from 'node:path';

import * as core from '@catalog/core';

export const FILTER = core.FILTER;
export const STATE = core.STATE;

export class Library {
  constructor() {
    this.videos = [];
    this.links = [];
  }

  /** Riprende la fotografia. Da chiamare a ogni ridisegno (è `App.pump`). */
  async refresh() {
    this.videos = await core.libraryVideos();
    this.links = await core.listQueue();
  }

  // ── Lettura (sincrona, sulla fotografia) ──────────────────────────────────

  len() {
    return this.videos.length;
  }

  list(filter) {
    return core.listByFilter(this.videos, filter);
  }

  count(filter) {
    return core.countByFilter(this.videos, filter);
  }

  get(id) {
    return this.videos.find((v) => v.id === id) ?? null;
  }

  authors() {
    return core.authors(this.videos);
  }

  byAuthor(author) {
    return core.byAuthor(this.videos, author);
  }

  search(query) {
    return core.searchLibrary(this.videos, query);
  }

  /** I link incollati ma non ancora diventati video. */
  queue() {
    return this.links;
  }

  filePath(video) {
    return path.resolve(core.getPaths().videosDir, video.file || '');
  }

  /**
   * I percorsi e le scelte, nella forma del `Config` Rust. Ricalcolato a ogni
   * chiamata: dopo un cambio dalle impostazioni non deve restare indietro.
   */
  config() {
    // M95 — non serve più leggere loadConfig() qui: tutto ciò che si mostra è
    // un percorso RISOLTO da getPaths o una scelta esposta dal core.
    const paths = core.getPaths();
    const names = core.expectedToolNames();
    // ffmpeg/ffprobe: `ffmpegLocation` è già la risoluzione fatta dal core
    // (config → tools/); se è null resta il PATH di sistema, che qui si cerca
    // davvero, così ogni percorso mostrato è controllabile con un `existsSync`.
    const resolveTool = (name, file) =>
      paths.ffmpegLocation ? path.join(paths.ffmpegLocation, file) : (core.inPath(name) ?? file);

    return {
      root: paths.libraryRoot,
      videos: paths.videosDir,
      covers: paths.thumbnailsDir,
      metadata: paths.metadataPath,
      ytdlp: paths.ytdlpBinaryPath,
      ffmpeg: resolveTool('ffmpeg', names.ffmpeg),
      ffprobe: resolveTool('ffprobe', names.ffprobe),
      // M95 — cercato dal core (PATH + posizioni standard), non più un campo di
      // configurazione: null se VLC non è installato.
      vlc: paths.vlcPath,
      cookies: paths.cookiesPath,
      quality: core.getQuality(),
      parallel: core.getJobParallelism()
    };
  }

  async missingFiles() {
    return core.missingFiles();
  }

  // ── Scrittura (asincrona: le uniche righe diverse dall'originale) ──────────

  async play(id, mode) {
    return core.playVideo(id, { mode });
  }

  async setFavorite(id, favorite) {
    return core.setVideoFavorite(id, favorite);
  }

  async setArchived(id, archived) {
    return core.setVideoHidden(id, archived);
  }

  async remove(id, deleteFiles) {
    return core.removeVideoFromLibrary(id, { deleteFiles });
  }

  async enqueue(url) {
    return core.enqueueLink(url);
  }

  async dequeue(url) {
    return core.dequeueLink(url);
  }

  /** Rimette in coda un video; ritorna l'URL da dare al pool (o `null`). */
  async retry(id) {
    return core.retryVideo(id);
  }

  async setQuality(quality) {
    return core.setQuality(quality);
  }

}

/**
 * Il pool, nella forma del `Downloader` Rust.
 *
 * Il numero di job che `pushWith` restituisce è **nostro**, progressivo come
 * là: gli id del core sono UUID, che in una riga di schermata non dicono niente.
 */
export class Downloader {
  #library;
  #number = new Map();
  #next = 1;
  #percent = new Map();
  #unsubscribe = [];

  constructor(library) {
    this.#library = library;
  }

  /**
   * Accoda un link con un tetto di risoluzione deciso per **questo** download
   * (`null` = la migliore disponibile).
   */
  pushWith(url, maxHeight = null) {
    const { jobId } = core.triggerJob('quickDownload', { url, maxHeight });
    this.#number.set(jobId, this.#next);
    this.#next += 1;
    // L'avanzamento è solo un evento: il core non lo persiste (una percentuale
    // che cambia dieci volte al secondo non ha senso su disco), quindi lo si
    // tiene qui. La *nota* invece resta sul record del job, e si rilegge.
    this.#unsubscribe.push(core.onJobProgress(jobId, (pct) => this.#percent.set(jobId, pct)));
    return this.#number.get(jobId);
  }

  /** Lo stato di tutti i job di questa sessione, dal primo all'ultimo. */
  statuses() {
    return core
      .listJobs(500)
      .filter((job) => this.#number.has(job.id))
      .map((job) => this.#status(job))
      .sort((a, b) => a.job - b.job);
  }

  #status(job) {
    const note = job.note ?? {};
    const percent = this.#percent.get(job.id) ?? null;
    const started = job.status !== 'queued';

    // Le fasi dell'originale: risoluzione → metadati → download. Il passaggio a
    // "download" lo segna la prima percentuale che arriva da yt-dlp, non un
    // evento a sé: è l'unico momento in cui si sa che il file ha cominciato a
    // scendere.
    let phase = null;
    if (started) {
      if (note.phase === 'metadata') phase = percent === null ? 'metadata' : 'video';
      else phase = note.phase ?? 'resolve';
    }

    const videoId = note.videoId ?? job.summary?.videoId ?? null;
    const video = videoId ? this.#library.get(videoId) : null;
    const title = video
      ? `${video.author} — ${video.title}`
      : (note.title ?? job.summary?.title ?? '');

    return {
      job: this.#number.get(job.id),
      jobId: job.id,
      url: job.params?.url ?? '',
      id: videoId,
      title,
      phase,
      percent,
      started,
      done: job.status === 'success',
      error: job.error?.message ?? null,
      maxHeight: job.params?.maxHeight ?? null,
      active: job.status === 'queued' || job.status === 'running'
    };
  }

  inFlight() {
    return core.getPoolStatus().running;
  }

  queued() {
    return core.getPoolStatus().queued;
  }

  busy() {
    const pool = core.getPoolStatus();
    return pool.running > 0 || pool.queued > 0;
  }

  parallel() {
    return core.getJobParallelism();
  }

  /**
   * Cambia il parallelismo a caldo. Alzarlo fa partire subito i job che
   * aspettavano; abbassarlo non interrompe niente — quelli in corso finiscono,
   * semplicemente non vengono rimpiazzati.
   */
  setParallel(quanti) {
    core.setJobParallelism(quanti);
  }

  /** Interrompe i job di questa sessione ancora in movimento. */
  interruptAll() {
    let fermati = 0;
    for (const status of this.statuses()) {
      if (!status.active) continue;
      try {
        core.cancelJob(status.jobId);
        fermati += 1;
      } catch {
        // Un job che nel frattempo è finito da sé non è un errore da mostrare.
      }
    }
    return fermati;
  }

  dispose() {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }
}
