import { getVideo } from '@catalog/core';
import { toPublicVideo } from './publicVideo.js';

const MAX_THUMBNAILS = 4;

async function safeThumbUrl(id) {
  try {
    const video = await getVideo(id);
    return toPublicVideo(video).thumbnailUrl;
  } catch {
    // Il video può essere sparito dal catalogo dopo che il job è girato
    // (caso limite, non impedisce di mostrare il resto dello storico).
    return null;
  }
}

// Arricchisce un job con le thumbnail dei video coinvolti, per lo storico
// (M20). downloadSingle ha sempre un solo video (params.videoId, a costo
// zero); downloadPending processa un intero lotto — usa il campo `results`
// del summary (aggiunto in core/src/jobs/jobs/downloadPending.js) per le
// prime MAX_THUMBNAILS scaricate con successo, più il conteggio dei
// rimanenti. I job più vecchi di questa modifica non hanno `results`: niente
// thumbnail per loro, coerente con "solo i job futuri" già scelto per M14.
export async function toPublicJob(job) {
  if (job.type === 'downloadSingle' && job.params?.videoId) {
    const thumbnailUrl = await safeThumbUrl(job.params.videoId);
    return { ...job, thumbnails: thumbnailUrl ? [thumbnailUrl] : [], thumbnailsMore: 0 };
  }

  if (job.type === 'downloadPending' && Array.isArray(job.summary?.results)) {
    const succeededIds = job.summary.results.filter((r) => r.status === 'downloaded').map((r) => r.id);
    const shownIds = succeededIds.slice(0, MAX_THUMBNAILS);
    const thumbs = await Promise.all(shownIds.map(safeThumbUrl));
    return {
      ...job,
      thumbnails: thumbs.filter(Boolean),
      thumbnailsMore: Math.max(0, job.summary.total - shownIds.length)
    };
  }

  return { ...job, thumbnails: [], thumbnailsMore: 0 };
}

export async function toPublicJobs(jobs) {
  return Promise.all(jobs.map(toPublicJob));
}
