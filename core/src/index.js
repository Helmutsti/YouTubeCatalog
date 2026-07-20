import { registerJobHandler, triggerJob, getJob, listJobs, onJobLog, onJobStatus, onJobProgress } from './jobs/jobManager.js';
import { downloadPendingJob } from './jobs/jobs/downloadPending.js';
import { downloadSingleJob } from './jobs/jobs/downloadSingle.js';
import { listVideos, getVideo, listNew, listChannels, listVideosByChannel } from './services/videoService.js';
import { syncSource } from './services/syncService.js';
import { listSources, addSource, removeSource } from './services/sourceService.js';
import { decideVideo } from './services/decisionService.js';
import { playVideo } from './services/playbackService.js';
import { scanImportable, importLocalVideo } from './services/importService.js';
import { getRawMetadata } from './services/metadataService.js';
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
  // importazione di video già scaricati in precedenza (fuori da questo tool)
  scanImportable,
  importLocalVideo,
  // metadati grezzi consolidati (data/metadata.json)
  getRawMetadata,
  // config/introspezione
  loadConfig,
  getPaths
};
