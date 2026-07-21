import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical, Download, Archive, ArchiveRestore, User } from 'lucide-react';
import { StatusBadge } from './StatusBadge.jsx';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';
import { actionsFor } from '../lib/reviewActions.js';

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
  const key = channelKey(video);

  function act(kind) {
    setMenuOpen(false);
    onDecide(video.id, kind);
  }

  return (
    <div className={`card${video.hidden ? ' dimmed' : ''}${selected ? ' selected' : ''}`}>
      <Link to={`/videos/${video.id}`} className="thumb">
        {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : null}
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
        <StatusBadge category={video.category} />
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
                {actions.map((a) => {
                  const m = MENU[a.kind] ?? MENU.download;
                  const Icon = m.Icon;
                  return (
                    <button key={a.kind} className="menu-item" onClick={() => act(a.kind)}>
                      <Icon size={15} />{m.label}
                    </button>
                  );
                })}
                {key && (
                  <Link className="menu-item" to={`/channels/${encodeURIComponent(key)}`} onClick={() => setMenuOpen(false)}>
                    <User size={15} />Mostra profilo
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
