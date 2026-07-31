import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Il server (@catalog/server) gira separatamente su :3001 (data/config.json,
// default). In dev, Vite inoltra /api e /media lì così il frontend può usare
// sempre path relativi — stesso codice, in dev o in un'eventuale build servita
// dallo stesso host in futuro.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/media': 'http://localhost:3001'
    }
  }
});
