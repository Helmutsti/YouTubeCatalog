import { Router } from 'express';
import { listSources, addSource, removeSource, syncSource } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const sourcesRouter = Router();

sourcesRouter.get('/sources', asyncRoute(async (req, res) => {
  res.json(await listSources());
}));

sourcesRouter.post('/sources', asyncRoute(async (req, res) => {
  res.json(await addSource(req.body?.url));
}));

sourcesRouter.delete('/sources/:id', asyncRoute(async (req, res) => {
  await removeSource(req.params.id);
  res.json({ ok: true });
}));

// body.sourceId assente/omesso => sincronizza tutte le fonti in sequenza,
// stesso comportamento di "Tutte le fonti" nel CLI.
sourcesRouter.post('/sync', asyncRoute(async (req, res) => {
  const { sourceId } = req.body ?? {};
  if (sourceId) {
    res.json({ [sourceId]: await syncSource(sourceId) });
    return;
  }

  const sources = await listSources();
  const results = {};
  for (const source of sources) {
    results[source.id] = await syncSource(source.id);
  }
  res.json(results);
}));
