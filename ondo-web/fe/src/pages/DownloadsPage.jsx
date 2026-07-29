import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { downloadSingle, listJobs, listQueue, getConfig, removeFromQueue } from '../api/client.js';
import { useTitle } from '../hooks/useTitle.js';
import { showToast } from '../lib/toast.js';
import { radioDialog } from '../lib/dialog.js';
import { apiUrl } from '../lib/apiBase.js';

// Prende il posto di «Sorgenti»: le fonti (playlist da sincronizzare) non esistono
// più nel core, ma incollare un link e guardare i download è il cuore della web app —
// è l'equivalente della console «Download rapido» della CLI.
//
// I download in corso arrivano dal flusso SSE `/api/events`, quindi le barre si
// muovono senza interrogare il server: ogni evento porta il numero del job.
//
// I job vivono per la durata del processo del server: non c'è nessuno storico su
// disco, e la sezione «conclusi» lo dice invece di far finta.

const LIVELLI = [null, 2160, 1440, 1080, 720, 480, 360];

function Barra({ percent }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="progress-bar" style={{ width: 180, flex: 'none' }} aria-label={`${p.toFixed(0)}%`}>
      <div style={{ width: `${p}%` }} />
    </div>
  );
}

function statoDi(job) {
  if (job.error) return { testo: job.error, errore: true };
  if (job.done) return { testo: 'fatto, in libreria', errore: false };
  if (!job.phase) return { testo: 'in coda', errore: false };
  return { testo: job.phase, errore: false };
}

function Riga({ children }) {
  return (
    <div
      className="job-hist-row"
      style={{ padding: '12px 16px', gap: 12, alignItems: 'center', minHeight: 0, borderTop: '1px solid var(--border)' }}
    >
      {children}
    </div>
  );
}

export function DownloadsPage() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [queue, setQueue] = useState([]);
  const [error, setError] = useState(null);
  useTitle('Download');

  function reload() {
    listJobs().then((r) => setJobs(r.jobs)).catch((e) => setError(e.message));
    listQueue().then(setQueue).catch(() => {});
  }

  useEffect(() => {
    reload();
    // Un solo flusso per tutti i job: si aggiorna la riga che l'evento riguarda, e
    // quando un job si chiude si rilegge la coda (il link l'ha lasciata).
    const source = new EventSource(apiUrl('/api/events'));
    source.onmessage = (e) => {
      let update;
      try {
        update = JSON.parse(e.data);
      } catch {
        return;
      }
      const ev = update.event ?? {};
      if (ev.event === 'log') return; // il rumore di yt-dlp non serve qui
      setJobs((prev) => {
        const i = prev.findIndex((j) => j.job === update.job);
        const agg = { ...(i >= 0 ? prev[i] : { job: update.job, url: update.url, title: '', percent: null, phase: null, done: false, error: null }) };
        if (ev.event === 'phase') {
          agg.phase = ev.phase;
          agg.percent = null;
        }
        if (ev.event === 'progress') agg.percent = ev.percent;
        if (ev.event === 'resolved') agg.title = `${ev.author} — ${ev.title}`;
        if (ev.event === 'done') {
          agg.done = true;
          agg.percent = 100;
        }
        if (ev.event === 'error') agg.error = ev.message;
        const next = i >= 0 ? [...prev] : [...prev, agg];
        if (i >= 0) next[i] = agg;
        return next;
      });
      if (ev.event === 'done' || ev.event === 'error') {
        listQueue().then(setQueue).catch(() => {});
      }
    };
    return () => source.close();
  }, []);

  async function accoda(url) {
    setBusy(true);
    setError(null);
    try {
      // La risoluzione si chiede solo se le impostazioni dicono «chiedi ogni volta».
      let maxHeight;
      const cfg = await getConfig();
      if (cfg.quality === 'ask') {
        const scelta = await radioDialog({
          title: 'Scegli la risoluzione',
          message: 'A quale risoluzione scaricare?',
          options: LIVELLI.map((h) => ({ value: h ?? 'best', label: h ? `${h}p (o la migliore sotto)` : 'Massima' })),
          defaultValue: 'best',
          confirmLabel: 'Scarica'
        });
        if (scelta == null) return;
        maxHeight = scelta === 'best' ? null : scelta;
      }
      await downloadSingle(url, { maxHeight });
      setInput('');
      showToast('Link accodato.', 'success');
      reload();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function togli(url) {
    try {
      await removeFromQueue(url);
      reload();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  const attivi = jobs.filter((j) => !j.done && !j.error);
  const conclusi = [...jobs].filter((j) => j.done || j.error).reverse();
  const inAttesa = queue.filter((q) => !q.error);
  const falliti = queue.filter((q) => q.error);

  return (
    <>
      <div className="page-head"><h1>Download</h1></div>

      <div className="add-panel">
        <div className="add-eyebrow">Incolla un link</div>
        <form
          className="add-row"
          onSubmit={(e) => {
            e.preventDefault();
            const url = input.trim();
            if (url) accoda(url);
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="Link del video"
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
            <Plus size={15} /> Scarica
          </button>
        </form>
        <div className="add-hint">
          Funziona con qualunque sito che yt-dlp sappia gestire. Un link di playlist o di canale
          viene rifiutato: il core scarica video singoli.
        </div>
      </div>

      {error && <div className="notice error" style={{ marginBottom: 24 }}>{error}</div>}

      <div className="job-hist">
        <div className="add-eyebrow" style={{ padding: '16px 16px 0' }}>In corso ({attivi.length})</div>
        {attivi.length === 0 ? (
          <div style={{ padding: '12px 16px 16px', color: 'var(--faint)', fontSize: 12.5 }}>Niente in corso.</div>
        ) : (
          attivi.map((j) => {
            const s = statoDi(j);
            return (
              <Riga key={j.job}>
                <div className="job-hist-title" style={{ flex: 1 }}>{j.title || j.url}</div>
                <div className="job-hist-more">{s.testo}</div>
                {j.phase === 'download' && <Barra percent={j.percent} />}
              </Riga>
            );
          })
        )}
      </div>

      {inAttesa.length > 0 && (
        <div className="job-hist" style={{ marginTop: 24 }}>
          <div className="add-eyebrow" style={{ padding: '16px 16px 0' }}>Link in attesa ({inAttesa.length})</div>
          {inAttesa.map((q) => (
            <Riga key={q.url}>
              <div className="job-hist-title" style={{ flex: 1 }}>{q.url}</div>
              <button className="icon-btn" title="Togli dalla coda" onClick={() => togli(q.url)}>
                <Trash2 size={14} />
              </button>
            </Riga>
          ))}
        </div>
      )}

      {falliti.length > 0 && (
        <div className="job-hist" style={{ marginTop: 24 }}>
          <div className="add-eyebrow" style={{ padding: '16px 16px 0' }}>Link falliti ({falliti.length})</div>
          {falliti.map((q) => (
            <Riga key={q.url}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="job-hist-title">{q.url}</div>
                <div className="job-hist-more" style={{ color: 'var(--danger)' }}>{q.error}</div>
              </div>
              <button className="icon-btn" title="Riprova" onClick={() => accoda(q.url)}>
                <RotateCcw size={14} />
              </button>
              <button className="icon-btn" title="Togli dalla coda" onClick={() => togli(q.url)}>
                <Trash2 size={14} />
              </button>
            </Riga>
          ))}
        </div>
      )}

      {conclusi.length > 0 && (
        <div className="job-hist" style={{ marginTop: 24 }}>
          <div className="add-eyebrow" style={{ padding: '16px 16px 0' }}>
            Conclusi in questa sessione ({conclusi.length})
          </div>
          {conclusi.map((j) => {
            const s = statoDi(j);
            return (
              <Riga key={j.job}>
                <div className="job-hist-title" style={{ flex: 1 }}>{j.title || j.url}</div>
                <div className="job-hist-more" style={{ color: s.errore ? 'var(--danger)' : undefined }}>{s.testo}</div>
              </Riga>
            );
          })}
        </div>
      )}
    </>
  );
}
