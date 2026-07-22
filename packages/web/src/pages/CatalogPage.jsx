import { useEffect, useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import { listVideos, listSources, setHidden, setFavorite, deleteVideo, triggerJob, refreshMetadata } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { StatusChips } from '../components/StatusChips.jsx';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { channelKey } from '../lib/format.js';
import { startDownload } from '../lib/downloadActions.js';
import { showToast } from '../lib/toast.js';

const SINGLE = '__single__';
// Chip della Home: sottoinsieme mirato (gli archiviati vivono in "Archiviati").
const HOME_CHIPS = [
  { value: 'available', label: 'Da scaricare' },
  { value: 'failed', label: 'Falliti' }
];

export function CatalogPage() {
  const [videos, setVideos] = useState(null);
  const [sources, setSources] = useState([]);
  const [category, setCategory] = useState(null);
  const [sort, setSort] = useState('uploadDate');
  const [creator, setCreator] = useState('');
  const [source, setSource] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [error, setError] = useState(null);
  const { requestHide, modal } = useHideWithPrompt({ onDone: reload, onError: setError });
  useTitle('Home');

  function reload() {
    listVideos().then(setVideos).catch((e) => setError(e.message));
  }
  useEffect(reload, []);
  useEffect(() => { listSources().then(setSources).catch(() => {}); }, []);

  // La Home mostra la libreria ATTIVA: esclude gli archiviati (nascosti), che
  // vivono nella pagina "Archiviati".
  const visible = useMemo(() => (videos ?? []).filter((v) => !v.hidden), [videos]);

  const counts = useMemo(() => {
    const acc = {};
    for (const v of visible) acc[v.category] = (acc[v.category] ?? 0) + 1;
    // "Da scaricare" include anche i video in download (restano visibili lì
    // finché non finiscono, invece di sparire per poi ricomparire altrove).
    acc.available = (acc.available ?? 0) + (acc.downloading ?? 0);
    return acc;
  }, [visible]);

  const channelOptions = useMemo(() => {
    const byKey = new Map();
    for (const v of visible) {
      const key = channelKey(v);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, v.channel?.name ?? key);
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], 'it', { sensitivity: 'base' }));
  }, [visible]);

  const favoriteCount = useMemo(() => visible.filter((v) => v.favorite).length, [visible]);

  const filtered = useMemo(() => {
    let list = visible;
    // "Da scaricare" (available) resta valida anche per i video in download:
    // ci restano finché non finiscono (successo o fallimento), invece di
    // sparire subito all'avvio per poi ricomparire in un'altra categoria.
    if (category) {
      list = list.filter((v) => v.category === category || (category === 'available' && v.category === 'downloading'));
    }
    if (creator) list = list.filter((v) => channelKey(v) === creator);
    if (source) list = list.filter((v) => (source === SINGLE ? !v.sources?.length : v.sources?.some((s) => s.sourceId === source)));
    if (favoriteOnly) list = list.filter((v) => v.favorite);
    return sortVideos(list, sort);
  }, [visible, category, creator, source, favoriteOnly, sort]);

  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const title = visible.find((v) => v.id === id)?.title;
        await startDownload(id, { triggerJob, onSettled: reload, title });
        return;
      }
      if (kind === 'hide') {
        requestHide(visible.find((v) => v.id === id));
        return;
      }
      if (kind === 'metadata') {
        await refreshMetadata(id);
        reload();
        return;
      }
      if (kind === 'favorite' || kind === 'unfavorite') {
        await setFavorite(id, kind === 'favorite');
        reload();
        return;
      }
      if (kind === 'deletevideo') {
        await deleteVideo(id);
        showToast('Video cancellato definitivamente.', 'success');
        reload();
        return;
      }
      await setHidden(id, false); // unhide
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Home</h1>
      </div>
      {error && <div className="notice error">{error}</div>}
      <StatusChips
        value={category}
        counts={counts}
        onChange={setCategory}
        options={HOME_CHIPS}
        extra={
          <div className={`chip${favoriteOnly ? ' active' : ''}`} onClick={() => setFavoriteOnly((f) => !f)}>
            <Star size={12} fill={favoriteOnly ? 'currentColor' : 'none'} />
            Preferiti
            {favoriteCount > 0 && <span className="count">{favoriteCount}</span>}
          </div>
        }
      />
      <div className="filter-bar">
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={creator} onChange={(e) => setCreator(e.target.value)} aria-label="Filtra per creator">
          <option value="">Tutti i creator</option>
          {channelOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filtra per sorgente">
          <option value="">Tutte le sorgenti</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={SINGLE}>Singoli (senza sorgente)</option>
        </select>
      </div>
      {videos === null ? (
        <div className="empty-state"><span className="spinner"></span></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">Nessun video con questi filtri.</div>
      ) : (
        <div className="grid">
          {filtered.map((v) => (
            <VideoCard key={v.id} video={v} onDecide={handleAction} />
          ))}
        </div>
      )}
      {modal}
    </>
  );
}
