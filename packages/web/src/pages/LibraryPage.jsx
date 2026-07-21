import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, X } from 'lucide-react';
import { listVideos, listSources, setHidden, triggerJob } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { StatusChips } from '../components/StatusChips.jsx';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { channelKey } from '../lib/format.js';

const SINGLE = '__single__'; // video aggiunti/scaricati singolarmente (source.sourceId null)

// Pagina "Libreria" (M28): la vista centrale sull'intero catalogo. Filtri per
// categoria (flag ortogonali M25) + creator + sorgente, ordinamento, azioni
// rapide per-video e selezione multipla per scaricare in blocco. Sostituisce il
// vecchio ciclo "Rivedi novità"/coda: "Novità" è solo il filtro "Su YouTube".
export function LibraryPage() {
  const [videos, setVideos] = useState(null);
  const [sources, setSources] = useState([]);
  const [category, setCategory] = useState(null);
  const [creator, setCreator] = useState('');
  const [source, setSource] = useState('');
  const [sort, setSort] = useState('addedAt');
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  function reload() {
    listVideos().then(setVideos).catch((e) => setError(e.message));
  }
  useEffect(reload, []);
  useEffect(() => { listSources().then(setSources).catch(() => {}); }, []);

  const counts = useMemo(() => {
    const acc = {};
    for (const v of videos ?? []) acc[v.category] = (acc[v.category] ?? 0) + 1;
    return acc;
  }, [videos]);

  const creatorOptions = useMemo(() => {
    const byKey = new Map();
    for (const v of videos ?? []) {
      const key = channelKey(v);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, v.channel?.name ?? key);
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it', { sensitivity: 'base' }));
  }, [videos]);

  const filtered = useMemo(() => {
    if (!videos) return [];
    let list = videos;
    if (category) list = list.filter((v) => v.category === category);
    if (creator) list = list.filter((v) => channelKey(v) === creator);
    if (source) list = list.filter((v) => (source === SINGLE ? !v.source?.sourceId : v.source?.sourceId === source));
    return sortVideos(list, sort);
  }, [videos, category, creator, source, sort]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Solo i video non ancora scaricati sono sensati per il download in blocco.
  const downloadableInView = useMemo(
    () => filtered.filter((v) => v.download !== 'downloaded' && v.download !== 'downloading'),
    [filtered]
  );

  function selectAllDownloadable() {
    setSelected(new Set(downloadableInView.map((v) => v.id)));
  }
  function clearSelection() { setSelected(new Set()); }

  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const { jobId } = await triggerJob('downloadSingle', { videoId: id });
        navigate(`/jobs?highlight=${jobId}`);
        return;
      }
      await setHidden(id, kind === 'hide');
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function downloadSelected() {
    const videoIds = [...selected].filter((id) =>
      downloadableInView.some((v) => v.id === id) || (videos ?? []).some((v) => v.id === id && v.download !== 'downloaded' && v.download !== 'downloading')
    );
    if (videoIds.length === 0) return;
    try {
      const { jobId } = await triggerJob('downloadPending', { videoIds });
      navigate(`/jobs?highlight=${jobId}`);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head"><h1>Libreria</h1></div>
      {error && <div className="notice error">{error}</div>}

      <StatusChips value={category} counts={counts} onChange={setCategory} />

      <div className="filter-bar">
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={creator} onChange={(e) => setCreator(e.target.value)} aria-label="Filtra per creator">
          <option value="">Tutti i creator</option>
          {creatorOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filtra per sorgente">
          <option value="">Tutte le sorgenti</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={SINGLE}>Singoli (senza sorgente)</option>
        </select>
        {downloadableInView.length > 0 && (
          <button className="btn" onClick={selectAllDownloadable}>Seleziona scaricabili ({downloadableInView.length})</button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="banner-cta">
          <div className="label"><b>{selected.size}</b> selezionati.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={clearSelection}><X size={14} />Deseleziona</button>
            <button className="btn btn-primary" onClick={downloadSelected}><Download size={14} />Scarica selezionati</button>
          </div>
        </div>
      )}

      {videos === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nessun video con questi filtri.</div>
      ) : (
        <div className="grid">
          {filtered.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              onDecide={handleAction}
              selected={selected.has(v.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}
    </>
  );
}
