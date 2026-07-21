import { registerJobHandler, triggerJob, getJob, listJobs, deleteJob, clearJobs, onJobLog, onJobStatus, onJobProgress } from './jobs/jobManager.js';
import { downloadPendingJob } from './jobs/jobs/downloadPending.js';
import { downloadSingleJob } from './jobs/jobs/downloadSingle.js';
import { listVideos, getVideo, listNew, listChannels, listVideosByChannel, channelKey } from './services/videoService.js';
import { syncSource } from './services/syncService.js';
import { listSources, addSource, removeSource } from './services/sourceService.js';
import { decideVideo } from './services/decisionService.js';
import { playVideo } from './services/playbackService.js';
import { prepareSingleVideoDownload } from './services/singleVideoService.js';
import { getRawMetadata } from './services/metadataService.js';
import { searchVideos } from './services/searchService.js';
import { reorganizeLibrary } from './services/libraryService.js';
import { syncChannelAvatars, getChannelAvatarMap } from './services/channelAvatarService.js';
import { loadConfig, getPaths } from './config.js';

registerJobHandler('downloadPending', downloadPendingJob);
registerJobHandler('downloadSingle', downloadSingleJob);

export {
  // catalogo
  listVideos,
  getVideo,
  listNew,
  listChannels,
  listVideosByChannel,
  channelKey,
  // fonti (sourcelist)
  listSources,
  addSource,
  removeSource,
  // sincronizzazione e decisioni
  syncSource,
  decideVideo,
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
  // ricerca fuzzy multi-campo
  searchVideos,
  // manutenzione archivio: riorganizzazione per creator (layout canonico)
  reorganizeLibrary,
  // manutenzione: foto profilo dei canali (M14)
  syncChannelAvatars,
  getChannelAvatarMap,
  // config/introspezione
  loadConfig,
  getPaths
};
