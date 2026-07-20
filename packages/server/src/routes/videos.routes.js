import { Router } from 'express';
import {
  listVideos,
  getVideo,
  listNew,
  listChannels,
  listVideosByChannel,
  decideVideo,
  playVideo,
  searchVideos,
  getRawMetadata,
  prepareSingleVideoDownload,
  triggerJob
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicVideo } from '../lib/publicVideo.js';

export const videosRouter = Router();

videosRouter.get('/videos', asyncRoute(async (req, res) => {
  const videos = await listVideos({ status: req.query.status || undefined });
  res.json(videos.map(toPublicVideo));
}));

videosRouter.get('/videos/new', asyncRoute(async (req, res) => {
  const videos = await listNew();
  res.json(videos.map(toPublicVideo));
}));

// Download one-off di un singolo video (M8): risolve/crea lo stub e, se c'è
// da scaricare, mette subito in coda il job — stesso orchestrazione di
// "Scarica video singolo" nel CLI. Route separata da /videos/:id perché non
// opera su un id già noto al client, ma su un URL incollato.
videosRouter.post('/videos/download-single', asyncRoute(async (req, res) => {
  const result = await prepareSingleVideoDownload(req.body?.url);
  if (result.action === 'download') {
    const { jobId } = triggerJob('downloadSingle', { videoId: result.videoId });
    res.json({ ...result, jobId });
    return;
  }
  res.json(result);
}));

videosRouter.get('/search', asyncRoute(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const results = await searchVideos(req.query.q, { limit });
  res.json(results.map(toPublicVideo));
}));

videosRouter.get('/channels', asyncRoute(async (req, res) => {
  const channels = await listChannels({ status: req.query.status || undefined });
  res.json(channels);
}));

videosRouter.get('/channels/:key/videos', asyncRoute(async (req, res) => {
  const videos = await listVideosByChannel(req.params.key, { status: req.query.status || undefined });
  res.json(videos.map(toPublicVideo));
}));

videosRouter.get('/videos/:id', asyncRoute(async (req, res) => {
  const video = await getVideo(req.params.id);
  res.json(toPublicVideo(video));
}));

videosRouter.get('/videos/:id/metadata', asyncRoute(async (req, res) => {
  const raw = await getRawMetadata(req.params.id);
  res.json(raw ?? null);
}));

videosRouter.post('/videos/:id/decision', asyncRoute(async (req, res) => {
  const video = await decideVideo(req.params.id, req.body?.decision);
  res.json(toPublicVideo(video));
}));

// Lancia VLC lato server (stesso comportamento del CLI). Ha senso solo
// perché server e browser girano sulla stessa macchina locale single-user;
// il player nativo <video> del web resta il modo primario di guardare.
videosRouter.post('/videos/:id/play', asyncRoute(async (req, res) => {
  const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
  await playVideo(req.params.id, { mode });
  res.json({ ok: true });
}));
