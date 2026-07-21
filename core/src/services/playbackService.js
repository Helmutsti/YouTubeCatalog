import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getPaths } from '../config.js';
import { getVideo } from './videoService.js';
import { DOWNLOAD_STATE } from '../catalog/catalogSchema.js';

export async function playVideo(id, { mode = 'video' } = {}) {
  const video = await getVideo(id);
  if (video.download !== DOWNLOAD_STATE.DOWNLOADED || !video.video?.localPath) {
    throw new Error(`Il video "${id}" non è ancora stato scaricato (stato download: "${video.download}")`);
  }

  const paths = getPaths();
  const filePath = path.join(paths.videosDir, video.video.localPath);
  if (!existsSync(filePath)) {
    throw new Error(`File video mancante su disco: ${filePath}`);
  }
  if (!existsSync(paths.vlcPath)) {
    throw new Error(`VLC non trovato in "${paths.vlcPath}": imposta playback.vlcPath in data/config.json`);
  }

  const args = mode === 'audio' ? ['--no-video', filePath] : [filePath];
  const child = spawn(paths.vlcPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
}
