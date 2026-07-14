import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only endpoint: POST a data-URL to /__shot?name=foo and it lands in
// shots/foo.jpg. Used by headless playtest tooling (window.__alterro.shot()).
function shotEndpoint(): Plugin {
  return {
    name: 'alterro-shot-endpoint',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const m = /^data:image\/(?:png|jpeg);base64,(.+)$/.exec(body);
          if (!m) {
            res.statusCode = 400;
            res.end('expected image data URL');
            return;
          }
          const url = new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost');
          const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '');
          const dir = path.join(server.config.root, 'shots');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.jpg`), Buffer.from(m[1], 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [shotEndpoint()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
