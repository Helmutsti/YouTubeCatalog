import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { CatalogPage } from './pages/CatalogPage.jsx';
import { VideoDetailPage } from './pages/VideoDetailPage.jsx';
import { SearchPage } from './pages/SearchPage.jsx';
import { ChannelPage } from './pages/ChannelPage.jsx';
import { SourcesPage } from './pages/SourcesPage.jsx';
import { JobsPage } from './pages/JobsPage.jsx';
import { ArchivedPage } from './pages/ArchivedPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<CatalogPage />} />
        <Route path="/videos/:id" element={<VideoDetailPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/channels/:key" element={<ChannelPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/archived" element={<ArchivedPage />} />
      </Route>
    </Routes>
  );
}
