import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const BVH_LIB_DIR = path.resolve(WORKSPACE_ROOT, 'bvh_library');
const REF_VIDEOS_DIR = path.resolve(WORKSPACE_ROOT, 'reference_videos');
const PUBLIC_WEBM_DIR = path.resolve(__dirname, 'public/demo/webm');
const TMP_WEBM_CACHE_DIR = '/tmp/wuxia_video_webm_cache';
const PUBLIC_SPRITES_DIR = path.resolve(__dirname, 'public/demo/sprites');
const TMP_SPRITES_CACHE_DIR = '/tmp/wuxia_video_sprites_cache';

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
  const bvhMemCache = new Map();

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

    if (ext === '.bvh') {
      let entry = bvhMemCache.get(fullPath);
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== total) {
        const raw = fs.readFileSync(fullPath);
        const gzip = zlib.gzipSync(raw, { level: 1 });
        entry = { mtimeMs: stat.mtimeMs, size: total, raw, gzip };
        bvhMemCache.set(fullPath, entry);
      }
      res.setHeader('Vary', 'Accept-Encoding');
      const acceptsGzip =
        req.method === 'GET' && /\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''));
      res.statusCode = 200;
      if (acceptsGzip) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(entry.gzip.length));
        res.end(entry.gzip);
        return;
      }
      res.setHeader('Content-Length', String(entry.raw.length));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(entry.raw);
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

function serveBinaryFileWithRange(req, res, fullPath, contentType) {
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

  const total = stat.size;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');

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
}

function findReferenceVideoByKey(key) {
  if (!fs.existsSync(REF_VIDEOS_DIR)) return null;
  const prefix = `${key}_`;
  const files = fs.readdirSync(REF_VIDEOS_DIR);
  const match = files.find((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.mp4'));
  return match ? path.join(REF_VIDEOS_DIR, match) : null;
}

export function createCompatVideoMiddleware() {
  const inFlight = new Map();

  function ensureTranscodedWebm(key, srcMp4Path) {
    const outPath = path.join(TMP_WEBM_CACHE_DIR, `${key}.webm`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
      return Promise.resolve(outPath);
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const job = new Promise((resolve, reject) => {
      fs.mkdirSync(TMP_WEBM_CACHE_DIR, { recursive: true });
      const tmpPath = `${outPath}.part.${process.pid}.${Date.now()}.webm`;
      const maxWidth = key === '05' ? 640 : 960;
      const args = [
        '-y',
        '-v',
        'error',
        '-i',
        srcMp4Path,
        '-vf',
        `scale='min(${maxWidth},iw)':-2`,
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '33',
        '-b:v',
        '0',
        '-deadline',
        'realtime',
        '-cpu-used',
        '6',
        '-row-mt',
        '1',
        '-g',
        '24',
        '-an',
        tmpPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
      proc.on('error', (err) => {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {}
        reject(err);
      });
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1024) {
          fs.renameSync(tmpPath, outPath);
          resolve(outPath);
        } else {
          try {
            fs.rmSync(tmpPath, { force: true });
          } catch {}
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    }).finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, job);
    return job;
  }

  const inFlightSprites = new Map();

  function ensureSpriteSheet(key, srcMp4Path) {
    const outJpg = path.join(TMP_SPRITES_CACHE_DIR, `${key}.jpg`);
    const outJson = path.join(TMP_SPRITES_CACHE_DIR, `${key}.json`);
    if (fs.existsSync(outJpg) && fs.existsSync(outJson) && fs.statSync(outJpg).size > 1024) {
      return Promise.resolve({ jpgPath: outJpg, jsonPath: outJson });
    }
    if (inFlightSprites.has(key)) return inFlightSprites.get(key);

    const job = new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(TMP_SPRITES_CACHE_DIR, { recursive: true });
        const durStr = execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', srcMp4Path],
          { encoding: 'utf8' }
        ).trim();
        const fullDur = Math.max(0.2, Number.parseFloat(durStr) || 3.0);
        const startSec = key === '05' ? 26.72 : 0;
        const clipDur = key === '05' ? Math.min(5.05, Math.max(1.0, fullDur - startSec)) : fullDur;
        const fps = 12;
        const cols = 8;
        const tileW = 384;
        const tileH = 216;
        const frameCount = Math.max(1, Math.min(96, Math.round(clipDur * fps)));
        const rows = Math.ceil(frameCount / cols);
        const tmpJpg = `${outJpg}.part.${process.pid}.${Date.now()}.jpg`;
        const vf = `fps=${fps},scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=0x090b0f,tile=${cols}x${rows}`;
        const args = ['-y', '-v', 'error'];
        if (startSec > 0) args.push('-ss', startSec.toFixed(3), '-t', clipDur.toFixed(3));
        args.push('-i', srcMp4Path, '-frames:v', '1', '-vf', vf, '-q:v', '5', tmpJpg);

        const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
        proc.on('error', (err) => {
          try {
            fs.rmSync(tmpJpg, { force: true });
          } catch {}
          reject(err);
        });
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(tmpJpg) && fs.statSync(tmpJpg).size > 1024) {
            fs.renameSync(tmpJpg, outJpg);
            fs.writeFileSync(
              outJson,
              JSON.stringify({
                key,
                fps,
                frameCount,
                cols,
                rows,
                tileW,
                tileH,
                startSec: +startSec.toFixed(3),
                duration: +clipDur.toFixed(3),
                fullDuration: +fullDur.toFixed(3),
              }),
              'utf8'
            );
            resolve({ jpgPath: outJpg, jsonPath: outJson });
          } else {
            try {
              fs.rmSync(tmpJpg, { force: true });
            } catch {}
            reject(new Error(`ffmpeg sprite exited with code ${code}`));
          }
        });
      } catch (err) {
        reject(err);
      }
    }).finally(() => {
      inFlightSprites.delete(key);
    });

    inFlightSprites.set(key, job);
    return job;
  }

  return (req, res, next) => {
    if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const rawPathname = req.url.split('?')[0].split('#')[0];
    const m = /^\/video_compat\/([0-9a-zA-Z_-]+)\.(webm|mp4|jpg|json)$/.exec(rawPathname);
    if (!m) return next();

    const key = m[1];
    const ext = m[2];
    const srcMp4 = findReferenceVideoByKey(key);

    if (ext === 'jpg' || ext === 'json') {
      const mime = ext === 'jpg' ? 'image/jpeg' : 'application/json; charset=utf-8';
      const bundled = path.join(PUBLIC_SPRITES_DIR, `${key}.${ext}`);
      if (fs.existsSync(bundled) && fs.statSync(bundled).size > 32) {
        serveBinaryFileWithRange(req, res, bundled, mime);
        return;
      }
      const cached = path.join(TMP_SPRITES_CACHE_DIR, `${key}.${ext}`);
      if (fs.existsSync(cached) && fs.statSync(cached).size > 32) {
        serveBinaryFileWithRange(req, res, cached, mime);
        return;
      }
      if (!srcMp4) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }
      ensureSpriteSheet(key, srcMp4)
        .then(({ jpgPath, jsonPath }) => {
          if (!res.writableEnded) {
            serveBinaryFileWithRange(req, res, ext === 'jpg' ? jpgPath : jsonPath, mime);
          }
        })
        .catch(() => {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Sprite generation failed');
          }
        });
      return;
    }

    if (ext === 'mp4') {
      if (!srcMp4) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }
      serveBinaryFileWithRange(req, res, srcMp4, 'video/mp4');
      return;
    }

    // ext === 'webm': check bundled CC public/demo/webm first, then /tmp cache, then on-demand ffmpeg
    const bundledWebm = path.join(PUBLIC_WEBM_DIR, `${key}.webm`);
    if (fs.existsSync(bundledWebm) && fs.statSync(bundledWebm).size > 1024) {
      serveBinaryFileWithRange(req, res, bundledWebm, 'video/webm');
      return;
    }
    const cachedWebm = path.join(TMP_WEBM_CACHE_DIR, `${key}.webm`);
    if (fs.existsSync(cachedWebm) && fs.statSync(cachedWebm).size > 1024) {
      serveBinaryFileWithRange(req, res, cachedWebm, 'video/webm');
      return;
    }
    if (!srcMp4) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    ensureTranscodedWebm(key, srcMp4)
      .then((webmPath) => {
        if (!res.writableEnded) {
          serveBinaryFileWithRange(req, res, webmPath, 'video/webm');
        }
      })
      .catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('WebM transcode failed');
        }
      });
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
      server.middlewares.use(createCompatVideoMiddleware());
      server.middlewares.use(createStaticRangeMiddleware(mounts));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createCompatVideoMiddleware());
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
