import { NavLink } from 'react-router-dom';
import { Home, Rss, Plus, Archive, Search } from 'lucide-react';

// "Job" rimossa insieme alla pagina omonima (M40): la Cronologia vera vive in
// fondo a Sorgenti. Sostituita con "Archiviati" per rispecchiare la sidebar
// desktop (Home · Sorgenti · Archiviati · Impostazioni).
export function MobileNav() {
  const cls = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <nav className="mobile-nav">
      <NavLink to="/" end className={cls}><Home size={17} />Home</NavLink>
      <NavLink to="/sources" className={cls}><Rss size={17} />Sorgenti</NavLink>
      <NavLink to="/sources" className="plus"><Plus size={20} /></NavLink>
      <NavLink to="/archived" className={cls}><Archive size={17} />Archiviati</NavLink>
      <NavLink to="/search" className={cls}><Search size={17} />Cerca</NavLink>
    </nav>
  );
}
