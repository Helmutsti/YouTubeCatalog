import express, { Router } from 'express';
import { loadConfig, getPaths, setVideosRoot, getCookiesStatus, saveCookiesFile, deleteCookiesFile } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const configRouter = Router();

// Sola lettura delle impostazioni rilevanti per la UI: cartella video (l'unica
// relocabile) e dove sono finite copertine/avatar (fisso, dentro data/media,
// solo informativo qui).
configRouter.get(
  '/config',
  asyncRoute(async (req, res) => {
    const cfg = loadConfig();
    const paths = getPaths();
    res.json({
      mediaRootResolved: paths.mediaRoot,
      videosRoot: cfg.videosRoot ?? null,
      videosDirResolved: paths.videosDir,
      cookies: getCookiesStatus()
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
