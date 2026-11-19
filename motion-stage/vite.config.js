import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const BVH_LIB_DIR = path.resolve(WORKSPACE_ROOT, 'bvh_library');
const REF_VIDEOS_DIR = path.resolve(WORKSPACE_ROOT, 'reference_videos');

const MIME_BY_EXT = {
  '.bvh': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticRangeMiddleware(mounts) {
  return (req, res, next) => {
    if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return next();
    }

    const rawPathname = req.url.split('?')[0].split('#')[0];
    if (rawPathname.startsWith('/.') || rawPathname.includes('..')) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Forbidden');
      return;
    }
    const matched = mounts.find(
      ([prefix]) => rawPathname === prefix.slice(0, -1) || rawPathname.startsWith(prefix)
    );
    if (!matched) return next();

    const [prefix, rootDir] = matched;
    let relDecoded;
    try {
      const sliced = rawPathname.startsWith(prefix) ? rawPathname.slice(prefix.length) : '';
      relDecoded = decodeURIComponent(sliced);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Bad Request: malformed URI');
      return;
    }

    if (relDecoded.includes('\0')) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Bad Request');
      return;
    }

    // Strip leading slashes so path.resolve never escapes rootDir via '//etc/...'
    const safeRel = relDecoded.replace(/^\/+/, '');
    const resolvedRoot = path.resolve(rootDir);
    const fullPath = path.resolve(resolvedRoot, safeRel);

    if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    if (!stat.isFile()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
    const total = stat.size;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', ext === '.bvh' ? 'public, max-age=300' : 'no-cache');

    const rangeHeader = req.headers?.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (!m || total === 0 || (m[1] === '' && m[2] === '')) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return;
      }

      let start;
      let end;
      if (m[1] === '') {
        const suffixLen = Number.parseInt(m[2], 10);
        start = Math.max(0, total - suffixLen);
        end = total - 1;
      } else {
        start = Number.parseInt(m[1], 10);
        end = m[2] !== '' ? Math.min(total - 1, Number.parseInt(m[2], 10)) : total - 1;
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= total) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return;
      }

      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(fullPath, { start, end });
      req.on?.('close', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) res.statusCode = 500;
        res.destroy?.();
      });
      stream.pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', String(total));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(fullPath);
    req.on?.('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.destroy?.();
    });
    stream.pipe(res);
  };
}

export function wuxiaWorkspaceAssetsPlugin() {
  let resolvedConfig = null;
  const mounts = [
    ['/bvh_library/', BVH_LIB_DIR],
    ['/reference_videos/', REF_VIDEOS_DIR],
  ];

  return {
    name: 'wuxia-workspace-assets',
    config() {
      const input = {
        index: path.resolve(__dirname, 'index.html'),
      };
      const combatHtml = path.resolve(__dirname, 'combat.html');
      if (fs.existsSync(combatHtml)) {
        input.combat = combatHtml;
      }
      return {
        build: {
          rollupOptions: { input },
        },
      };
    },
    configResolved(cfg) {
      resolvedConfig = cfg;
    },
    configureServer(server) {
      server.middlewares.use(createStaticRangeMiddleware(mounts));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createStaticRangeMiddleware(mounts));
    },
    closeBundle() {
      if (!resolvedConfig || resolvedConfig.command !== 'build') return;
      if (!fs.existsSync(BVH_LIB_DIR)) return;
      const outDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      const destBvhDir = path.resolve(outDir, 'bvh_library');
      fs.cpSync(BVH_LIB_DIR, destBvhDir, { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [wuxiaWorkspaceAssetsPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    fs: {
      allow: ['..', WORKSPACE_ROOT],
    },
  },
});
