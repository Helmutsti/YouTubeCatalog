import { registerJobHandler, triggerJob, getJob, listJobs, deleteJob, clearJobs, onJobLog, onJobStatus, onJobProgress } from './jobs/jobManager.js';
import { downloadPendingJob } from './jobs/jobs/downloadPending.js';
import { downloadSingleJob } from './jobs/jobs/downloadSingle.js';
import { enrichSourceJob } from './jobs/jobs/enrichSource.js';
import { listVideos, getVideo, listAvailable, listChannels, listVideosByChannel, channelKey } from './services/videoService.js';
import { videoCategory, VIDEO_CATEGORY, PRESENCE, DOWNLOAD_STATE } from './catalog/catalogSchema.js';
import { syncSource } from './services/syncService.js';
import { listSources, addSource, removeSource } from './services/sourceService.js';
import { setVideoHidden } from './services/decisionService.js';
import { playVideo } from './services/playbackService.js';
import { prepareSingleVideoDownload } from './services/singleVideoService.js';
import { getRawMetadata, refreshVideoMetadata } from './services/metadataService.js';
import { searchVideos } from './services/searchService.js';
import { reorganizeLibrary, deleteVideoFile } from './services/libraryService.js';
import { syncChannelAvatars, getChannelAvatarMap } from './services/channelAvatarService.js';
import { createBackup, restoreBackup } from './services/backupService.js';
import { loadConfig, getPaths, updateConfig, setMediaRoot, setVideosRoot } from './config.js';

registerJobHandler('downloadPending', downloadPendingJob);
registerJobHandler('downloadSingle', downloadSingleJob);
registerJobHandler('enrichSource', enrichSourceJob);

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
  // job (download)
  triggerJob,
  getJob,
  listJobs,
  deleteJob,
  clearJobs,
  onJobLog,
  onJobStatus,
  onJobProgress,
  // riproduzione
  playVideo,
  // download one-off di un singolo video, senza passare da una fonte
  prepareSingleVideoDownload,
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
  // manutenzione: foto profilo dei canali (M14)
  syncChannelAvatars,
  getChannelAvatarMap,
  // backup/ripristino del catalogo in .zip (M36)
  createBackup,
  restoreBackup,
  // config/introspezione
  loadConfig,
  getPaths,
  // impostazioni a runtime: scrittura config + posizione cartella media (M37)
  // e cartella video dedicata separata da copertine/avatar (M38)
  updateConfig,
  setMediaRoot,
  setVideosRoot
};
