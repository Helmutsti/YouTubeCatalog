import { Router } from 'express';
import { loadConfig, getPaths, setMediaRoot } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const configRouter = Router();

// Sola lettura delle impostazioni rilevanti per la UI (M37): il percorso media
// così com'è in config (`mediaRoot`) e quello risolto in assoluto.
configRouter.get(
  '/config',
  asyncRoute(async (req, res) => {
    res.json({
      mediaRoot: loadConfig().mediaRoot,
      mediaRootResolved: getPaths().mediaRoot
    });
  })
);

// Imposta la posizione della cartella media (solo ripuntamento, nessuno
// spostamento di file). Richiede il riavvio del server per avere effetto.
configRouter.post(
  '/config/media-root',
  asyncRoute(async (req, res) => {
    res.json(setMediaRoot(req.body?.path));
  })
);
