import { registerJobHandler, triggerJob, getJob, listJobs, onJobLog, onJobStatus, onJobProgress } from './jobs/jobManager.js';
import { downloadPendingJob } from './jobs/jobs/downloadPending.js';
import { downloadSingleJob } from './jobs/jobs/downloadSingle.js';
import { listVideos, getVideo, listNew, listChannels, listVideosByChannel } from './services/videoService.js';
import { syncSource } from './services/syncService.js';
import { listSources, addSource, removeSource } from './services/sourceService.js';
import { decideVideo } from './services/decisionService.js';
import { playVideo } from './services/playbackService.js';
import { prepareSingleVideoDownload } from './services/singleVideoService.js';
import { getRawMetadata } from './services/metadataService.js';
import { searchVideos } from './services/searchService.js';
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
  // config/introspezione
  loadConfig,
  getPaths
};
