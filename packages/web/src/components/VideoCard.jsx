import { Link } from 'react-router-dom';
import { Download, EyeOff, Eye } from 'lucide-react';
import { StatusBadge } from './StatusBadge.jsx';
import { formatDuration, videoDisplayDate, channelKey, channelInitial } from '../lib/format.js';
import { actionsFor } from '../lib/reviewActions.js';

const ICONS = { download: Download, hide: EyeOff, unhide: Eye };

export function VideoCard({ video, onDecide }) {
  const dur = formatDuration(video.durationSeconds);
  const date = videoDisplayDate(video);
  const actions = actionsFor(video);
  const key = channelKey(video);

  return (
    <div className={`card${video.hidden ? ' dimmed' : ''}`}>
      <Link to={`/videos/${video.id}`} className="thumb">
        {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : null}
        <StatusBadge category={video.category} />
        {dur && <div className="dur">{dur}</div>}
        {actions.length > 0 && (
          <div className="card-actions">
            {actions.map((a) => {
              const Icon = ICONS[a.kind] ?? Download;
              return (
                <button
                  key={a.kind}
                  className="btn small"
                  title={a.label}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDecide(video.id, a.kind);
                  }}
                >
                  <Icon size={13} />
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
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
        <div>
          <div className="card-meta">{video.channel?.name ?? 'Creator sconosciuto'}</div>
          {date && <div className="card-meta">{date}</div>}
        </div>
      </div>
    </div>
  );
}
