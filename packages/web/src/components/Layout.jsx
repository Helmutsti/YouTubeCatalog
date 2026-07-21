import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Home, Rss, Search, Archive } from 'lucide-react';
import { listChannels } from '../api/client.js';
import { MobileNav } from './MobileNav.jsx';

export function Layout() {
  const [channels, setChannels] = useState([]);
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQ);
  const location = useLocation();
  const navigate = useNavigate();

  // Rifetch a ogni cambio pagina: dataset piccolo (canali distinti tra i
  // video scaricati), costo trascurabile, evita una sidebar disallineata
  // dopo una sync/decisione presa in un'altra pagina.
  useEffect(() => {
    listChannels().then(setChannels).catch(() => {});
  }, [location.pathname]);

  // Unica barra di ricerca (punto 10): sincronizzata con la query attiva
  // dell'URL — su /search?q=… mostra il termine cercato, altrove si svuota.
  // Scatta solo al cambio di `q`, non a ogni tasto, quindi non disturba la
  // digitazione (la ricerca parte solo su Invio, vedi submitSearch).
  useEffect(() => setQuery(urlQ), [urlQ]);

  function submitSearch(e) {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  const navCls = ({ isActive }) => `side-item${isActive ? ' active' : ''}`;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="logo"><img src="/ondo-logo.svg" alt="Ondo" /></Link>
        <form className="search-box" onSubmit={submitSearch}>
          <Search size={16} />
          <input
            placeholder="Cerca video, creator, argomenti"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      </header>
      <div className="body-area">
        <nav className="sidebar">
          <NavLink to="/" end className={navCls}><Home size={16} />Home</NavLink>
          <NavLink to="/sources" className={navCls}><Rss size={16} />Sorgenti</NavLink>
          <NavLink to="/archived" className={navCls}><Archive size={16} />Archiviati</NavLink>
          <div className="side-div"></div>
          <div className="side-sec">Creator</div>
          {channels.length === 0 && <div className="side-empty">Nessun creator ancora</div>}
          {channels.map((c) => (
            <NavLink key={c.key} to={`/channels/${encodeURIComponent(c.key)}`} className={navCls}>
              <span className="avatar">
                {c.avatarUrl ? <img className="avatar-photo" src={c.avatarUrl} alt="" /> : (c.name?.charAt(0)?.toUpperCase() ?? '?')}
              </span>
              {c.name}
            </NavLink>
          ))}
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
