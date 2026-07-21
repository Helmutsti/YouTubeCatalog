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
  triggerJob,
  syncChannelAvatars,
  getChannelAvatarMap
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';
import { toPublicVideo } from '../lib/publicVideo.js';

export const videosRouter = Router();

videosRouter.get('/videos', asyncRoute(async (req, res) => {
  const [videos, avatars] = await Promise.all([
    listVideos({ status: req.query.status || undefined }),
    getChannelAvatarMap()
  ]);
  res.json(videos.map((v) => toPublicVideo(v, avatars)));
}));

videosRouter.get('/videos/new', asyncRoute(async (req, res) => {
  const [videos, avatars] = await Promise.all([listNew(), getChannelAvatarMap()]);
  res.json(videos.map((v) => toPublicVideo(v, avatars)));
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
  const [results, avatars] = await Promise.all([searchVideos(req.query.q, { limit }), getChannelAvatarMap()]);
  res.json(results.map((v) => toPublicVideo(v, avatars)));
}));

videosRouter.get('/channels', asyncRoute(async (req, res) => {
  const [channels, avatars] = await Promise.all([
    listChannels({ status: req.query.status || undefined }),
    getChannelAvatarMap()
  ]);
  res.json(channels.map((c) => ({
    ...c,
    avatarUrl: avatars[c.key]?.localPath ? `/media/avatars/${encodeURIComponent(avatars[c.key].localPath)}` : null
  })));
}));

// Manutenzione: ri-sincronizza le foto profilo dei canali (M14). Non in
// library.routes.js (specifico per operazioni a rischio reale sui file
// video su disco, da cui il suo dryRun) — questa è "tira dati freschi da
// YouTube", stessa famiglia concettuale di POST /api/sync.
videosRouter.post('/channels/avatars/sync', asyncRoute(async (req, res) => {
  const force = req.body?.force === true;
  res.json(await syncChannelAvatars({ force }));
}));

videosRouter.get('/channels/:key/videos', asyncRoute(async (req, res) => {
  const [videos, avatars] = await Promise.all([
    listVideosByChannel(req.params.key, { status: req.query.status || undefined }),
    getChannelAvatarMap()
  ]);
  res.json(videos.map((v) => toPublicVideo(v, avatars)));
}));

videosRouter.get('/videos/:id', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([getVideo(req.params.id), getChannelAvatarMap()]);
  res.json(toPublicVideo(video, avatars));
}));

videosRouter.get('/videos/:id/metadata', asyncRoute(async (req, res) => {
  const raw = await getRawMetadata(req.params.id);
  res.json(raw ?? null);
}));

videosRouter.post('/videos/:id/decision', asyncRoute(async (req, res) => {
  const [video, avatars] = await Promise.all([decideVideo(req.params.id, req.body?.decision), getChannelAvatarMap()]);
  res.json(toPublicVideo(video, avatars));
}));

// Lancia VLC lato server (stesso comportamento del CLI). Ha senso solo
// perché server e browser girano sulla stessa macchina locale single-user;
// il player nativo <video> del web resta il modo primario di guardare.
videosRouter.post('/videos/:id/play', asyncRoute(async (req, res) => {
  const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
  await playVideo(req.params.id, { mode });
  res.json({ ok: true });
}));
