import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { listVideosByChannel, setHidden, setFavorite, deleteVideo } from '../api/client.js';
import { VideoCard } from '../components/VideoCard.jsx';
import { useHideWithPrompt } from '../hooks/useHideWithPrompt.jsx';
import { useTitle } from '../hooks/useTitle.js';
import { SORT_OPTIONS, sortVideos } from '../lib/sort.js';
import { startDownload } from '../lib/downloadActions.js';
import { showToast } from '../lib/toast.js';

// Pagina del creator: TUTTI i suoi video (scaricati e non), non solo gli
// scaricati — così un creator appena aggiunto mostra subito i suoi video
// "disponibili". Esclude solo i nascosti (visibili unicamente in Libreria).
// Le card sono le stesse VideoCard della Home (stesso cablaggio di handler),
// menu ⋮ incluso — niente più card semplificata propria (bug fix).
export function ChannelPage() {
  const { key } = useParams();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('uploadDate');
  const { requestHide, modal } = useHideWithPrompt({ onDone: reload, onError: setError });

  function reload() {
    listVideosByChannel(key).then(setVideos).catch((e) => setError(e.message));
  }

  useEffect(() => {
    setVideos(null);
    reload();
  }, [key]);

  const sorted = useMemo(
    () => (videos ? sortVideos(videos.filter((v) => !v.hidden), sort) : []),
    [videos, sort]
  );

  useTitle(videos?.[0]?.channel?.name ?? decodeURIComponent(key));

  // Stesso cablaggio di handler della Home/Archiviati (CatalogPage/ArchivedPage):
  // VideoCard richiede un unico onDecide che smista in base al `kind` d'azione.
  async function handleAction(id, kind) {
    try {
      if (kind === 'download') {
        const title = sorted.find((v) => v.id === id)?.title;
        await startDownload(id, { onSettled: reload, title });
        return;
      }
      if (kind === 'hide') {
        requestHide(sorted.find((v) => v.id === id));
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

  if (error) return <div className="notice error">{error}</div>;
  if (!videos) return <div className="empty-state"><span className="spinner"></span></div>;

  const name = videos[0]?.channel?.name ?? decodeURIComponent(key);
  const avatarUrl = videos[0]?.channel?.avatarUrl ?? null;

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={14} />Home</Link>
      <div className="chan-head" style={{ marginTop: 16 }}>
        <div className="chan-avatar">
          {avatarUrl ? <img className="avatar-photo" src={avatarUrl} alt="" /> : name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="chan-name">{name}</div>
          <div className="chan-count">{sorted.length} video</div>
        </div>
      </div>
      {sorted.length > 0 && (
        <div className="filter-bar">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordina per">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="empty-state">Nessun video per questo creator.</div>
      ) : (
        <div className="grid">
          {sorted.map((v) => (
            <VideoCard key={v.id} video={v} onDecide={handleAction} />
          ))}
        </div>
      )}
      {modal}
    </>
  );
}
