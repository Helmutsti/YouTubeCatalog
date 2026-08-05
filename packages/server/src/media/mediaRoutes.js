import express from 'express';
import { getPaths } from '@catalog/core';

// express.static (pacchetto "send" sotto il cofano) supporta già Range
// requests/ETag out of the box — necessario per il seek nel player <video>.
export function mountMediaRoutes(app) {
  const paths = getPaths();
  app.use('/media/videos', express.static(paths.videosDir));
  app.use('/media/thumbnails', express.static(paths.thumbnailsDir));
  app.use('/media/avatars', express.static(paths.avatarsDir));
}
