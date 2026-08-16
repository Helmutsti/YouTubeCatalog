// Risoluzione dei percorsi di una libreria ESTERNA (data/+media/ di un'altra
// installazione), usata dal merge (mergeService.js). A differenza di
// getPaths() (config.js) è sola lettura e parametrizzata su un root
// arbitrario: niente cache di processo, niente mkdirSync — la cartella
// sorgente non va mai toccata, solo letta.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function resolveForeignPaths(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const dataDir = path.join(root, 'data');
  const catalogPath = path.join(dataDir, 'catalog.json');
  if (!existsSync(catalogPath)) {
    throw new Error(`Cartella sorgente non valida: manca data/catalog.json in ${root}`);
  }
  const metadataPath = path.join(dataDir, 'metadata.json');
  const configPath = path.join(dataDir, 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
  // `mediaRoot` esplicito in config.json = libreria da prima del cambio a
  // data/media fisso (retrocompatibile); altrimenti si assume il layout
  // attuale, dove le copertine/avatar vivono dentro data/media.
  const mediaRoot = config.mediaRoot
    ? path.resolve(root, config.mediaRoot)
    : path.join(dataDir, 'media');
  return {
    root,
    catalogPath,
    metadataPath,
    thumbnailsDir: path.join(mediaRoot, 'thumbnails'),
    avatarsDir: path.join(mediaRoot, 'avatars')
  };
}
