import { Router } from 'express';
import { listSources, addSource, removeSource, syncSource, triggerJob } from '@catalog/core';
import { asyncRoute } from '../lib/asyncRoute.js';

export const sourcesRouter = Router();

sourcesRouter.get('/sources', asyncRoute(async (req, res) => {
  res.json(await listSources());
}));

// Ingest a due fasi (M26): addSource popola subito i metadati leggeri
// (flat-playlist, istantaneo), poi si lancia il job enrichSource che arricchisce
// i metadati completi + copertine in background. Il jobId torna al client, che
// mostra la barra di avanzamento fino a fine arricchimento.
sourcesRouter.post('/sources', asyncRoute(async (req, res) => {
  const result = await addSource(req.body?.url);
  if (!result.alreadyExists) {
    const { jobId } = triggerJob('enrichSource', { sourceId: result.sourceId });
    res.json({ ...result, jobId });
    return;
  }
  res.json(result);
}));

sourcesRouter.delete('/sources/:id', asyncRoute(async (req, res) => {
  await removeSource(req.params.id);
  res.json({ ok: true });
}));

// body.sourceId assente/omesso => sincronizza tutte le fonti in sequenza,
// stesso comportamento di "Tutte le fonti" nel CLI. Fase 1 (flat) sincrona,
// poi si lancia enrichSource (fase 2) e si torna il jobId per la barra.
sourcesRouter.post('/sync', asyncRoute(async (req, res) => {
  const { sourceId } = req.body ?? {};
  const results = {};
  if (sourceId) {
    results[sourceId] = await syncSource(sourceId);
  } else {
    for (const source of await listSources()) {
      results[source.id] = await syncSource(source.id);
    }
  }
  // enrichSource senza sourceId arricchisce tutti i video ancora da arricchire
  // (copre sia "una fonte" sia "tutte"): idempotente, salta i già arricchiti.
  const { jobId } = triggerJob('enrichSource', sourceId ? { sourceId } : {});
  res.json({ results, jobId });
}));
