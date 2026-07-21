import { NavLink } from 'react-router-dom';
import { Home, Rss, Plus, ListChecks, Search } from 'lucide-react';

export function MobileNav() {
  const cls = ({ isActive }) => (isActive ? 'active' : '');
  return (
    <nav className="mobile-nav">
      <NavLink to="/" end className={cls}><Home size={17} />Home</NavLink>
      <NavLink to="/sources" className={cls}><Rss size={17} />Sorgenti</NavLink>
      <NavLink to="/sources" className="plus"><Plus size={20} /></NavLink>
      <NavLink to="/jobs" className={cls}><ListChecks size={17} />Job</NavLink>
      <NavLink to="/search" className={cls}><Search size={17} />Cerca</NavLink>
    </nav>
  );
}
