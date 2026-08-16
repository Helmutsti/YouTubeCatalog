import express, { Router } from 'express';
import {
  loadConfig, getPaths, setVideosRoot, getCookiesStatus, saveCookiesFile, deleteCookiesFile,
  getQuality, setQuality, qualityLabel, sameQuality, QUALITY_LEVELS
} from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const configRouter = Router();

// Sola lettura delle impostazioni rilevanti per la UI: cartella video (l'unica
// relocabile), dove sono finite copertine/avatar (fisso, dentro data/media,
// solo informativo qui), e la qualità predefinita di download (stesso menu
// della CLI — QUALITY_LEVELS è la fonte unica, il web non lo reimplementa).
configRouter.get(
  '/config',
  asyncRoute(async (req, res) => {
    const cfg = loadConfig();
    const paths = getPaths();
    const quality = getQuality();
    res.json({
      mediaRootResolved: paths.mediaRoot,
      videosRoot: cfg.videosRoot ?? null,
      videosDirResolved: paths.videosDir,
      cookies: getCookiesStatus(),
      quality,
      qualityLevels: QUALITY_LEVELS.map((q) => ({
        kind: q.kind,
        height: q.height,
        label: qualityLabel(q),
        current: sameQuality(q, quality)
      }))
    });
  })
);

// Cookie YouTube (core/cookies.txt): corpo grezzo del file .txt esportato dal
// browser (stesso pattern del ripristino backup — middleware raw a livello di
// route). Nessun riavvio richiesto: il prossimo comando yt-dlp lo vede subito.
configRouter.post(
  '/config/cookies',
  express.text({ type: () => true, limit: '5mb' }),
  asyncRoute(async (req, res) => {
    res.json(saveCookiesFile(req.body));
  })
);

configRouter.delete(
  '/config/cookies',
  asyncRoute(async (req, res) => {
    res.json(deleteCookiesFile());
  })
);

// Imposta la posizione della cartella dei video (separata da copertine/avatar).
configRouter.post(
  '/config/videos-root',
  asyncRoute(async (req, res) => {
    res.json(setVideosRoot(req.body?.path));
  })
);

// Qualità predefinita dei download (vale per i futuri, non tocca quelli già
// scaricati). Il body è uno dei { kind, height } di QUALITY_LEVELS, così come
// li ha ricevuti da GET /config — nessuna logica di parsing qui, la valida
// setQuality (core/src/quality.js).
configRouter.post(
  '/config/quality',
  asyncRoute(async (req, res) => {
    const { kind, height } = req.body ?? {};
    res.json(setQuality({ kind, height: height ?? null }));
  })
);
