// Risoluzione dei percorsi di una libreria ESTERNA (data/+media/ di un'altra
// installazione), usata dal merge (mergeService.js). A differenza di
// getPaths() (config.js) è sola lettura e parametrizzata su un root
// arbitrario: niente cache di processo, niente mkdirSync — la cartella
// sorgente non va mai toccata, solo letta.
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveForeignPaths(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const dataDir = path.join(root, 'data');
  // M97 — stesso layout della libreria locale: il catalogo è data/libreria.json,
  // copertine e avatar sono in cima alla libreria (non più dentro data/media).
  const catalogPath = path.join(dataDir, 'libreria.json');
  if (!existsSync(catalogPath)) {
    throw new Error(`Cartella sorgente non valida: manca data/libreria.json in ${root}`);
  }
  return {
    root,
    catalogPath,
    metadataPath: path.join(dataDir, 'metadata.json'),
    thumbnailsDir: path.join(root, 'thumbnails'),
    avatarsDir: path.join(root, 'avatars')
  };
}
