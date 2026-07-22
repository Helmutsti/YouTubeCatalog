import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical, Download, Archive, ArchiveRestore, User, FileDown, Star, StarOff, Trash2 } from 'lucide-react';
import { StatusBadge } from './StatusBadge.jsx';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';
import { actionsFor } from '../lib/reviewActions.js';
import { confirmDialog } from '../lib/dialog.js';
import { useActiveDownloadJobId } from '../lib/downloadTracker.js';
import { useJobStream } from '../hooks/useJobStream.js';

// Voci del menu ⋮ per tipo di azione (kind da actionsFor). Etichette/icone in
// stile YouTube; "hide"→Archivia, "unhide"→Ripristina (contestuale allo stato).
const MENU = {
  download: { label: 'Scarica video', Icon: Download },
  hide: { label: 'Archivia', Icon: Archive },
  unhide: { label: 'Ripristina', Icon: ArchiveRestore }
};

export function VideoCard({ video, onDecide, selected, onToggleSelect }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);
  const actions = actionsFor(video);
  const downloading = video.download === 'downloading';
  // Non ancora in libreria: copertina blur+B/N (sulla sola immagine, mai su
  // bordo/overlay). Esclude "downloading", che ha già il proprio trattamento
  // dedicato qui sotto (blur più forte + anello di progresso) — sommare
  // anche questo li farebbe scontrare.
  const notDownloaded = video.download !== 'downloaded' && !downloading;
  // jobId noto solo se il download è stato avviato da questa stessa sessione
  // (vedi lib/downloadTracker.js): se assente (pagina ricaricata a metà
  // download, o avviato altrove) niente percentuale reale, il cerchio ricade
  // su un'animazione indeterminata.
  const activeJobId = useActiveDownloadJobId(video.id);
  const { progress } = useJobStream(downloading ? activeJobId : null);
  // Archivia/Ripristina va in fondo al menu, separato dalle altre azioni.
  const archiveAction = actions.find((a) => a.kind === 'hide' || a.kind === 'unhide');
  const otherActions = actions.filter((a) => a.kind !== 'hide' && a.kind !== 'unhide');
  const key = channelKey(video);

  async function act(kind) {
    setMenuOpen(false);
    if (kind === 'deletevideo') {
      // Cancellazione totale e irreversibile (punto 11): conferma esplicita,
      // stesso modale usato per gli altri confirm dell'app.
      const ok = await confirmDialog({
        title: 'Cancellare definitivamente il video?',
        message: `Azione irreversibile: file, copertina e scheda di "${video.title ?? video.id}" verranno cancellati per sempre. Se il video appartiene ancora a una fonte, la prossima sincronizzazione potrebbe reinserirlo in libreria.`,
        confirmLabel: 'Cancella per sempre',
        danger: true
      });
      if (!ok) return;
    }
    onDecide(video.id, kind);
  }

  return (
    <div className={`card${video.hidden ? ' dimmed' : ''}${selected ? ' selected' : ''}`}>
      <Link to={`/videos/${video.id}`} className={`thumb${downloading ? ' downloading' : ''}${notDownloaded ? ' not-downloaded' : ''}`}>
        {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : null}
        {downloading && (
          <div className="dl-overlay">
            <svg className="dl-ring" viewBox="0 0 36 36">
              <circle className="dl-ring-track" cx="18" cy="18" r="15.9155" />
              <circle
                className={`dl-ring-fill${progress == null ? ' indeterminate' : ''}`}
                cx="18" cy="18" r="15.9155"
                style={progress != null ? { strokeDashoffset: 100 - progress } : undefined}
              />
            </svg>
            <Download size={16} className="dl-icon" />
          </div>
        )}
        {onToggleSelect && (
          <input
            type="checkbox"
            className="card-select"
            checked={!!selected}
            title="Seleziona"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(video.id); }}
          />
        )}
        <StatusBadge video={video} />
        {video.favorite && (
          <div className="fav-star" title="Preferito">
            <Star size={14} fill="currentColor" />
          </div>
        )}
        {dur && <div className="dur">{dur}</div>}
      </Link>
      <Link to={`/videos/${video.id}`} className="card-title">
        {video.title ?? video.id}
      </Link>
      <div className="card-info">
        {key ? (
          <Link to={`/channels/${encodeURIComponent(key)}`} className="avatar">
            {video.channel?.avatarUrl ? <img className="avatar-photo" src={video.channel.avatarUrl} alt="" /> : channelInitial(video)}
          </Link>
        ) : (
          <div className="avatar">
            {video.channel?.avatarUrl ? <img className="avatar-photo" src={video.channel.avatarUrl} alt="" /> : channelInitial(video)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-meta">{video.channel?.name ?? 'Creator sconosciuto'}</div>
          {date && <div className="card-meta">{date}</div>}
        </div>

        <div className="card-menu">
          <button
            className="kebab"
            aria-label="Azioni"
            title="Azioni"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen((o) => !o); }}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={(e) => { e.preventDefault(); setMenuOpen(false); }}></div>
              <div className="menu-list" onClick={(e) => e.stopPropagation()}>
                {otherActions.map((a) => {
                  const m = MENU[a.kind] ?? MENU.download;
                  const Icon = m.Icon;
                  return (
                    <button key={a.kind} className="menu-item" onClick={() => act(a.kind)}>
                      <Icon size={15} />{m.label}
                    </button>
                  );
                })}
                {/* Preferito (M43): toggle indipendente, ammesso in qualunque stato */}
                <button className="menu-item" onClick={() => act(video.favorite ? 'unfavorite' : 'favorite')}>
                  {video.favorite ? <StarOff size={15} /> : <Star size={15} />}
                  {video.favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}
                </button>
                {/* Aggiorna metadati: anche sui rimossi (ri-verifica) */}
                <button className="menu-item" onClick={() => act('metadata')}>
                  <FileDown size={15} />Aggiorna metadati
                </button>
                {key && (
                  <Link className="menu-item" to={`/channels/${encodeURIComponent(key)}`} onClick={() => setMenuOpen(false)}>
                    <User size={15} />Mostra profilo
                  </Link>
                )}
                {/* Archivia/Ripristina: in fondo al menu, sempre rosso solo per "Archivia" */}
                {archiveAction && (
                  <button
                    className={`menu-item${archiveAction.kind === 'hide' ? ' danger' : ''}`}
                    onClick={() => act(archiveAction.kind)}
                  >
                    {archiveAction.kind === 'hide' ? <Archive size={15} /> : <ArchiveRestore size={15} />}
                    {MENU[archiveAction.kind].label}
                  </button>
                )}
                {/* Cancella definitivamente (punto 11): solo sui video già
                    archiviati — gate a due passi, applicato anche lato core. */}
                {video.hidden && (
                  <button className="menu-item danger" onClick={() => act('deletevideo')}>
                    <Trash2 size={15} />Cancella
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
