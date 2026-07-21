import { getVideo } from '@catalog/core';
import { toPublicVideo } from './publicVideo.js';

const MAX_THUMBNAILS = 4;

async function safeVideo(id) {
  try {
    const video = await getVideo(id);
    return { thumbnailUrl: toPublicVideo(video).thumbnailUrl, title: video.title ?? video.id };
  } catch {
    // Il video può essere sparito dal catalogo dopo che il job è girato
    // (caso limite, non impedisce di mostrare il resto dello storico).
    return null;
  }
}

// Arricchisce un job con le thumbnail dei video coinvolti e, per il download
// singolo, il titolo del video (M24: mostrato negli item dello storico).
// downloadSingle ha sempre un solo video (params.videoId, a costo zero);
// downloadPending processa un intero lotto — usa il campo `results` del summary
// per le prime MAX_THUMBNAILS scaricate con successo, più il conteggio dei
// rimanenti (nessun titolo singolo: sono più video, la UI mostra il label del
// tipo). I job più vecchi senza `results` restano senza thumbnail per i batch,
// coerente con "solo i job futuri" già scelto per pattern simili (M14/M20).
export async function toPublicJob(job) {
  if (job.type === 'downloadSingle' && job.params?.videoId) {
    const v = await safeVideo(job.params.videoId);
    return {
      ...job,
      thumbnails: v?.thumbnailUrl ? [v.thumbnailUrl] : [],
      thumbnailsMore: 0,
      title: v?.title ?? null
    };
  }

  if (job.type === 'downloadPending' && Array.isArray(job.summary?.results)) {
    const succeededIds = job.summary.results.filter((r) => r.status === 'downloaded').map((r) => r.id);
    const shownIds = succeededIds.slice(0, MAX_THUMBNAILS);
    const vids = await Promise.all(shownIds.map(safeVideo));
    return {
      ...job,
      thumbnails: vids.filter(Boolean).map((v) => v.thumbnailUrl).filter(Boolean),
      thumbnailsMore: Math.max(0, job.summary.total - shownIds.length),
      title: null
    };
  }

  return { ...job, thumbnails: [], thumbnailsMore: 0, title: null };
}

export async function toPublicJobs(jobs) {
  return Promise.all(jobs.map(toPublicJob));
}
