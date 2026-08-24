import { registerJobHandler, triggerJob, getJob, listJobs, deleteJob, cancelJob, clearJobs, onJobLog, onJobStatus, onJobProgress, getPoolStatus, getJobParallelism, setJobParallelism, nudgeJobPool } from './jobs/jobManager.js';
import { downloadPendingJob } from './jobs/jobs/downloadPending.js';
import { downloadSingleJob } from './jobs/jobs/downloadSingle.js';
import { enrichSourceJob } from './jobs/jobs/enrichSource.js';
import { addSourceJob } from './jobs/jobs/addSource.js';
import { addVideoJob } from './jobs/jobs/addVideo.js';
import { quickDownloadJob } from './jobs/jobs/quickDownload.js';
import { listQueue, enqueueLink, dequeueLink, clearFailedLinks } from './services/queueService.js';
import { listVideos, getVideo, listAvailable, listChannels, listVideosByChannel, channelKey } from './services/videoService.js';
import { videoCategory, VIDEO_CATEGORY, PRESENCE, DOWNLOAD_STATE } from './catalog/catalogSchema.js';
import { syncSource } from './services/syncService.js';
import { listSources, addSource, removeSource } from './services/sourceService.js';
import { setVideoHidden, setVideoFavorite } from './services/decisionService.js';
import { prepareSingleVideoDownload, analyzeVideoDownload } from './services/singleVideoService.js';
import { getRawMetadata, refreshVideoMetadata } from './services/metadataService.js';
import { searchVideos } from './services/searchService.js';
import { reorganizeLibrary, deleteVideoFile, deleteVideoCompletely, removeVideoFromLibrary } from './services/libraryService.js';
import { syncChannelAvatars, getChannelAvatarMap } from './services/channelAvatarService.js';
import { createBackup, restoreBackup } from './services/backupService.js';
import { mergeLibrary } from './services/mergeService.js';
import { loadLibraryConfig, getPaths, getToolPaths, updateLibraryConfig, setVideosRoot, clearVideosRoot, getCookiesStatus, saveCookiesFile, deleteCookiesFile, expectedToolNames } from './config.js';
import { loadAppConfig, updateAppConfig, setAppId, getAppId, appConfigPath, appConfigDir } from './appConfig.js';
import { isLibrary, initLibrary, libraryRoot, currentLibrary, setLibraryOverride, NotALibraryError, toolsRoot, isPackagedInstall } from './library.js';
import { checkTools, reportToolsOnStartup, findJsRuntime, inPath, JS_RUNTIME_NAMES } from './preflight.js';
import { setupTools } from './services/toolsSetupService.js';
import { acquireDataLock, setLockRole } from './lock.js';
// M86 — la superficie che la CLI (tradotta 1:1 dal ramo Rust) consuma.
import { playVideo, videoFilePath, PLAYBACK_MODE } from './services/playbackService.js';
import {
  FILTER,
  STATE,
  filterLabel,
  stateLabel,
  durationLabel,
  libraryVideo,
  libraryVideos,
  listByFilter,
  countByFilter,
  matchesFilter,
  authors,
  byAuthor,
  missingFiles,
  retryVideo,
  searchLibrary
} from './services/libraryViewService.js';
import {
  QUALITY_LEVELS,
  QUALITY_PER_DOWNLOAD,
  QUALITY_ASK,
  QUALITY_BEST,
  getQuality,
  setQuality,
  qualityLabel,
  maxHeightOf,
  sameQuality
} from './quality.js';
import { onJobNote } from './jobs/jobManager.js';

// interruptible (M51): solo i due job di download vero e proprio (lunghi,
// pesanti su disco) — enrichSource/addSource scaricano solo metadati, pochi
// secondi, interromperli non è stato ritenuto utile.
registerJobHandler('downloadPending', downloadPendingJob, { interruptible: true });
registerJobHandler('downloadSingle', downloadSingleJob, { interruptible: true });
registerJobHandler('enrichSource', enrichSourceJob);
// Aggiunta "istantanea" dalla pagina Sorgenti (M39): l'intera operazione di
// aggiunta (playlist o singolo video) gira come un job in coda — mai il
// download del video, solo metadati. Vedi core/src/jobs/jobs/addSource.js e
// addVideo.js.
registerJobHandler('addSource', addSourceJob);
registerJobHandler('addVideo', addVideoJob);
// M85 — il link incollato nel Download rapido: risoluzione + download in un job
// solo, così ogni link occupa un posto del pool e `jobs.parallel` conta davvero.
// Interrompibile come gli altri due job di download vero.
registerJobHandler('quickDownload', quickDownloadJob, { interruptible: true });

export {
  // catalogo
  listVideos,
  getVideo,
  listAvailable,
  listChannels,
  listVideosByChannel,
  channelKey,
  // derivazione dei flag ortogonali (M25): la regola vive nel core, gli adapter
  // (server/CLI/web) la consumano invece di reimplementarla
  videoCategory,
  VIDEO_CATEGORY,
  PRESENCE,
  DOWNLOAD_STATE,
  // fonti (sourcelist)
  listSources,
  addSource,
  removeSource,
  // sincronizzazione
  syncSource,
  // stato: nascondere/mostrare un video (asse `hidden`)
  setVideoHidden,
  // stato: preferito (asse `favorite`, M43)
  setVideoFavorite,
  // job (download)
  triggerJob,
  getJob,
  listJobs,
  deleteJob,
  // interruzione manuale di un job running/queued (M51). Con il pool (M76)
  // diventa indispensabile: agisce su **un** job, non su tutti.
  cancelJob,
  // pool dei job (M76): quanti girano adesso, quanti in coda, il tetto attuale.
  // Un'interfaccia rilegge da qui invece di tenersi il conto: un evento si
  // consuma una volta sola, una fotografia si può richiedere ogni volta.
  getPoolStatus,
  getJobParallelism,
  setJobParallelism,
  // M86 — da chiamare dopo aver **alzato** jobs.parallel: senza, i job già in
  // coda aspetterebbero un evento che potrebbe non arrivare mai
  nudgeJobPool,
  // coda dei link non ancora risolti (M85): un link incollato non ha un id,
  // quindi non è un video — vive qui finché yt-dlp non lo risolve
  listQueue,
  enqueueLink,
  dequeueLink,
  clearFailedLinks,
  clearJobs,
  onJobLog,
  onJobStatus,
  onJobProgress,
  // M86 — quello che si sa di un job **mentre** gira (titolo appena risolto,
  // fase): serve a chi disegna una riga di avanzamento.
  onJobNote,
  // M86 — riproduzione con VLC (era `Library::play`)
  playVideo,
  videoFilePath,
  PLAYBACK_MODE,
  // M86 — viste della libreria come nella CLI Rust: filtri, autori, ricerca
  // esatta, file mancanti, ritorno in coda
  FILTER,
  STATE,
  filterLabel,
  stateLabel,
  durationLabel,
  libraryVideo,
  libraryVideos,
  listByFilter,
  countByFilter,
  matchesFilter,
  authors,
  byAuthor,
  missingFiles,
  retryVideo,
  searchLibrary,
  // M86 — qualità predefinita, «Chiedi ogni volta» compreso
  QUALITY_LEVELS,
  QUALITY_PER_DOWNLOAD,
  QUALITY_ASK,
  QUALITY_BEST,
  getQuality,
  setQuality,
  qualityLabel,
  maxHeightOf,
  sameQuality,
  // download one-off di un singolo video, senza passare da una fonte
  prepareSingleVideoDownload,
  // M55: analisi del ri-download di un video già in catalogo (scelta audio)
  analyzeVideoDownload,
  // metadati grezzi consolidati (data/metadata.json)
  getRawMetadata,
  // "Aggiorna metadati": ri-scarica metadati+copertina (ri-verifica i rimossi)
  refreshVideoMetadata,
  // ricerca fuzzy multi-campo
  searchVideos,
  // manutenzione archivio: riorganizzazione per creator (layout canonico)
  reorganizeLibrary,
  // cancella solo il file scaricato (M30), mantenendo la scheda in libreria
  deleteVideoFile,
  // cancellazione totale e irreversibile (punto 11): scheda+file+copertina+metadati
  deleteVideoCompletely,
  // M86 — «Togli dalla libreria»: la scheda esce, i file si cancellano solo se
  // richiesto e senza il gate "prima archivialo" (era `Library::remove`)
  removeVideoFromLibrary,
  // manutenzione: foto profilo dei canali (M14)
  syncChannelAvatars,
  getChannelAvatarMap,
  // backup/ripristino del catalogo in .zip (M36)
  createBackup,
  restoreBackup,
  // fusione di una libreria esterna dentro quella corrente: mai i video
  // fisici, solo metadati/copertine/avatar, il più completo vince
  mergeLibrary,
  // M96 — due configurazioni distinte:
  //   libreria     → solo `videosRoot`, dentro la libreria
  //   applicazione → tutto il resto, un file per applicazione (cli/web)
  // Vedi appConfig.js per la regola con cui si decide dove va un campo.
  loadLibraryConfig,
  updateLibraryConfig,
  loadAppConfig,
  updateAppConfig,
  // `setAppId` va chiamata a inizio processo, come setLockRole: decide QUALE
  // file di impostazioni si usa, quindi va prima di ogni lettura.
  setAppId,
  getAppId,
  appConfigPath,
  appConfigDir,
  // M98 — la libreria: si riconosce, si crea esplicitamente, e si sceglie con
  // la cartella corrente (o --library / ONDO_LIBRARY). Vedi core/src/library.js.
  isLibrary,
  initLibrary,
  libraryRoot,
  currentLibrary,
  setLibraryOverride,
  NotALibraryError,
  toolsRoot,
  isPackagedInstall,
  getPaths,
  getToolPaths,
  // prerequisiti esterni (yt-dlp/ffmpeg): controllo all'avvio di CLI e server,
  // con rimando a `npm run setup` invece di uno spawn ENOENT a metà download (M64)
  checkTools,
  reportToolsOnStartup,
  expectedToolNames,
  // M91 — scarica davvero yt-dlp/ffmpeg/ffprobe in tools/ (era scripts/setup.mjs):
  // riusata da quello script e dal sotto-comando `ondo setup` del pacchetto
  // standalone, dove "npm run setup" non è disponibile (installazione globale).
  setupTools,
  // M86 — il runtime JS di cui ha bisogno yt-dlp: si dice all'avvio, non a metà
  // del primo download
  findJsRuntime,
  inPath,
  JS_RUNTIME_NAMES,
  // lock consultivo su data/ (M80): si attiva solo per la durata di una
  // scrittura (M92), detto con un messaggio invece che lasciato alla memoria
  // dell'utente. `setLockRole` va chiamato una volta a inizio processo (chi
  // scrive nel messaggio d'errore a un altro processo).
  acquireDataLock,
  setLockRole,
  // impostazioni a runtime: posizione della cartella video dedicata, separata
  // da copertine/avatar (M38/M97, che vivono fisse dentro la libreria)
  setVideosRoot,
  clearVideosRoot,
  // cookie YouTube (core/cookies.txt): upload/cancellazione da Impostazioni
  getCookiesStatus,
  saveCookiesFile,
  deleteCookiesFile
};
