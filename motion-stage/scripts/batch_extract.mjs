#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processExtractedVideoSequence } from './lib/videoPoseSolver.mjs';
import { serializeFramesToBVH } from './lib/bvhSerializer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOTION_STAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(MOTION_STAGE_ROOT, '..');
const NODE_MODULES_DIR = path.join(MOTION_STAGE_ROOT, 'node_modules');
const CHUNKS_DIR = path.join(MOTION_STAGE_ROOT, 'public', 'mediapipe', 'chunks');
const REF_VIDEOS_DIR = path.join(WORKSPACE_ROOT, 'reference_videos');
const DEFAULT_OUT_DIR = path.join(WORKSPACE_ROOT, 'bvh_library', 'C_taibai_extracted');
const HUMANOID_RIG_FILE = path.join(MOTION_STAGE_ROOT, 'src', 'rig', 'HumanoidRig.js');

export const DEFAULT_TAIBAI_JOBS = [
  {
    id: 'taibai_01b',
    videoFile: '01b_天刀官网_太白崖顶拔剑定势_全身镜头.mp4',
    outFile: 'taibai_01b_崖顶横剑定势_cleaned.bvh',
    nativeFps: 24,
    nativeFrames: 24,
    target60Frames: 60,
    cyclic: true,
    stabilizeInPlace: true,
    preserveRootMotion: false,
    allowAerial: false,
    filterRadius24: 3,
    contactHeightThresh: 0.175,
    forceBothFeetGrounded: true,
    hasWeapon: true,
  },
  {
    id: 'taibai_02',
    videoFile: '02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4',
    outFile: 'taibai_02_无痕剑意_独立提膝云剑_cleaned.bvh',
    nativeFps: 24,
    nativeFrames: 75,
    target60Frames: 188,
    cyclic: false,
    stabilizeInPlace: false,
    preserveRootMotion: true,
    allowAerial: false,
    extraYawDeg: -18,
    filterRadius24: 3,
    contactHeightThresh: 0.165,
    contactVelThresh: 1.25,
    hasWeapon: true,
  },
  {
    id: 'taibai_03',
    videoFile: '03_太白雨落云飞_北京武术队_快剑五连斩单人实拍_720p.mp4',
    outFile: 'taibai_03_雨落云飞_快剑五连斩_cleaned.bvh',
    nativeFps: 24,
    nativeFrames: 123,
    target60Frames: 308,
    cyclic: false,
    stabilizeInPlace: false,
    preserveRootMotion: true,
    allowAerial: false,
    extraYawDeg: 38,
    filterRadius24: 2,
    contactHeightThresh: 0.155,
    hasWeapon: true,
  },
  {
    id: 'taibai_04',
    videoFile: '04_太白飞燕逐月_全国冠军王曦_腾空旋风跌叉单人裁剪.mp4',
    outFile: 'taibai_04_飞燕逐月_腾空旋风跌叉_cleaned.bvh',
    nativeFps: 24,
    nativeFrames: 43,
    target60Frames: 108,
    cyclic: false,
    stabilizeInPlace: false,
    preserveRootMotion: true,
    allowAerial: true,
    filterRadius24: 2,
    contactHeightThresh: 0.155,
    hasWeapon: true,
  },
];

const EXTRACT_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MotionStage Headless Batch Extractor</title>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/": "/node_modules/three/",
      "three/addons/": "/node_modules/three/examples/jsm/",
      "@mediapipe/tasks-vision": "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs",
      "@mediapipe/tasks-vision/vision_wasm_module_internal.js": "/node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.js"
    }
  }
  </script>
</head>
<body>
  <script type="module" src="/extractor.mjs"></script>
</body>
</html>
`;

const EXTRACTOR_MJS = `import { PoseLandmarker } from '@mediapipe/tasks-vision';
import ModuleFactory from '@mediapipe/tasks-vision/vision_wasm_module_internal.js';

let cachedAssetsPromise = null;
let lastVideoTimestampMs = 0;

async function fetchChunkedBinary(baseUrl, entry) {
  const out = new Uint8Array(entry.totalBytes);
  const CHUNK_SIZE = 2 * 1024 * 1024;
  for (let i = 0; i < entry.parts.length; i++) {
    const resp = await fetch(baseUrl + entry.parts[i], { cache: 'no-store' });
    if (!resp.ok) {
      throw new Error('Failed to fetch chunk ' + entry.parts[i] + ': HTTP ' + resp.status);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    out.set(buf, i * CHUNK_SIZE);
  }
  return out;
}

async function ensureCompiledAssets() {
  if (!cachedAssetsPromise) {
    cachedAssetsPromise = (async () => {
      const mResp = await fetch('/mediapipe/chunks/manifest.json', { cache: 'no-store' });
      if (!mResp.ok) throw new Error('Failed to load chunks manifest: HTTP ' + mResp.status);
      const manifest = await mResp.json();
      const [wasmBytes, modelBytes] = await Promise.all([
        fetchChunkedBinary('/mediapipe/chunks/', manifest.wasm),
        fetchChunkedBinary('/mediapipe/chunks/', manifest.model),
      ]);
      const compiledWasm = await WebAssembly.compile(wasmBytes);
      return {
        compiledWasm,
        modelBytes,
        wasmTotalBytes: wasmBytes.byteLength,
        modelTotalBytes: modelBytes.byteLength,
      };
    })();
  }
  return cachedAssetsPromise;
}

async function createCpuVideoLandmarker(compiledWasm, modelBytes) {
  // Mandatory before EVERY createFromOptions call because vision_bundle.mjs wipes both globals
  globalThis.ModuleFactory = ModuleFactory;
  globalThis.Module = {
    instantiateWasm(imports, successCallback) {
      WebAssembly.instantiate(compiledWasm, imports).then((instance) => successCallback(instance));
      return {};
    },
  };
  return PoseLandmarker.createFromOptions(
    { wasmLoaderPath: '', wasmBinaryPath: '' },
    {
      baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    }
  );
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onErr);
    };
    const onReady = () => {
      cleanup();
      resolve(video);
    };
    const onErr = () => {
      cleanup();
      reject(new Error('Video decode failed for ' + url + ' (code=' + (video.error?.code || 'unknown') + ')'));
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onErr);
    video.src = url;
    video.load();
  });
}

async function seekVideo(video, targetSec) {
  if (Math.abs(video.currentTime - targetSec) < 0.0015 && video.readyState >= 2) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    video.addEventListener('seeked', finish);
    video.currentTime = targetSec;
  });
}

async function extractVideoLandmarks({ videoUrl, nativeFrames, nativeFps = 24, trimInSec = 0, trimOutSec = null }) {
  const t0 = performance.now();
  const { compiledWasm, modelBytes, wasmTotalBytes, modelTotalBytes } = await ensureCompiledAssets();
  const landmarker = await createCpuVideoLandmarker(compiledWasm, modelBytes);
  const video = await loadVideo(videoUrl);

  try {
    const duration = video.duration;
    const startSec = Math.max(0, Number(trimInSec) || 0);
    const endSec = trimOutSec !== null && trimOutSec !== undefined
      ? Math.min(duration, Number(trimOutSec))
      : duration;
    const spanSec = Math.max(1 / nativeFps, endSec - startSec);
    const frameCount = nativeFrames || Math.max(2, Math.round(spanSec * nativeFps));

    const scale = Math.min(1, 480 / Math.max(1, video.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(64, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(64, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const clipBaseMs = Math.max(Math.round(performance.now()) + 1000, lastVideoTimestampMs + 1000);
    const detections = [];
    let detectedCount = 0;

    for (let i = 0; i < frameCount; i++) {
      const sampleSec = Math.min(
        Math.max(0, endSec - 0.004),
        startSec + (i + 0.25) / nativeFps
      );
      await seekVideo(video, sampleSec);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const relMs = Math.round((sampleSec - startSec) * 1000);
      const tsMs = Math.max(lastVideoTimestampMs + 1, clipBaseMs + relMs);
      lastVideoTimestampMs = tsMs;

      const res = landmarker.detectForVideo(canvas, tsMs);
      if (res.worldLandmarks && res.worldLandmarks.length > 0 && res.worldLandmarks[0].length >= 33) {
        detectedCount++;
        const worldLm = res.worldLandmarks[0].map((p) => ({
          x: +p.x.toFixed(6),
          y: +p.y.toFixed(6),
          z: +p.z.toFixed(6),
        }));
        const normLm = res.landmarks && res.landmarks[0]
          ? res.landmarks[0].map((p) => ({
              x: +p.x.toFixed(6),
              y: +p.y.toFixed(6),
              z: +p.z.toFixed(6),
            }))
          : null;
        detections.push({ worldLm, normLm });
      } else {
        detections.push(null);
      }
    }

    return {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      duration,
      frameCount,
      detectedCount,
      wasmTotalBytes,
      modelTotalBytes,
      elapsedMs: Math.round(performance.now() - t0),
      detections,
    };
  } finally {
    try {
      landmarker.close();
    } catch {}
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {}
  }
}

window.__BATCH_EXTRACTOR__ = {
  ready: true,
  ensureCompiledAssets,
  extractVideoLandmarks,
};
`;

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function safeResolveUnder(baseDir, relPath) {
  const cleanRel = relPath.replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleanRel);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}

function serveStaticFileWithRange(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' ? total - 1 : m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(total),
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function startEphemeralAssetServer(extraVideoDirs = []) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad URI');
      return;
    }

    if (pathname === '/extract.html') {
      const buf = Buffer.from(EXTRACT_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(buf.length) });
      res.end(buf);
      return;
    }

    if (pathname === '/extractor.mjs') {
      const buf = Buffer.from(EXTRACTOR_MJS, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(buf.length),
      });
      res.end(buf);
      return;
    }

    if (pathname === '/src/rig/HumanoidRig.js') {
      serveStaticFileWithRange(req, res, HUMANOID_RIG_FILE);
      return;
    }

    if (pathname.startsWith('/node_modules/')) {
      const fp = safeResolveUnder(NODE_MODULES_DIR, pathname.slice('/node_modules/'.length));
      if (!fp) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveStaticFileWithRange(req, res, fp);
      return;
    }

    if (pathname.startsWith('/mediapipe/chunks/')) {
      const fp = safeResolveUnder(CHUNKS_DIR, pathname.slice('/mediapipe/chunks/'.length));
      if (!fp) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveStaticFileWithRange(req, res, fp);
      return;
    }

    if (pathname.startsWith('/reference_videos/')) {
      const rel = pathname.slice('/reference_videos/'.length);
      for (const dir of [REF_VIDEOS_DIR, ...extraVideoDirs]) {
        const fp = safeResolveUnder(dir, rel);
        if (fp && fs.existsSync(fp)) {
          serveStaticFileWithRange(req, res, fp);
          return;
        }
      }
      res.writeHead(404);
      res.end('Video not found');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];

    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (ev) => reject(new Error(`CDP WebSocket error: ${ev.message || 'failed'}`)));
    });

    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      } else if (msg.method) {
        for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
          const waiter = this.eventWaiters[i];
          if (waiter.method === msg.method) {
            this.eventWaiters.splice(i, 1);
            waiter.resolve(msg.params);
          }
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.eventWaiters.indexOf(waiter);
        if (idx >= 0) this.eventWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launchEphemeralChromium(userDataDir, runDir, onSpawn = null) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader-webgl',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];

  const proc = spawn('/usr/lib/chromium/chromium', args, {
    env: { ...process.env, TMPDIR: runDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (typeof onSpawn === 'function') {
    onSpawn(proc);
  }

  const cdpPort = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const pollTimer = setInterval(() => {
      if (fs.existsSync(activePortFile)) {
        const lines = fs.readFileSync(activePortFile, 'utf8').trim().split('\n');
        const p = Number(lines[0]);
        if (Number.isFinite(p) && p > 0) {
          cleanup();
          resolve(p);
        }
      }
    }, 80);

    const timeoutTimer = setTimeout(() => {
      cleanup();
      try {
        proc.kill('SIGKILL');
      } catch {}
      reject(new Error(`Chromium failed to expose DevTools port. Stderr:\n${stderrBuf}`));
    }, 15000);

    const onData = (chunk) => {
      stderrBuf += chunk.toString();
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderrBuf);
      if (m) {
        cleanup();
        resolve(Number(m[1]));
      }
    };

    const onExit = (code, sig) => {
      cleanup();
      reject(new Error(`Chromium exited prematurely (code=${code}, sig=${sig}). Stderr:\n${stderrBuf}`));
    };

    const cleanup = () => {
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
    };

    proc.stderr.on('data', onData);
    proc.once('exit', onExit);
  });

  let pageWsUrl = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (resp.ok) {
        const targets = await resp.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }

  if (!pageWsUrl) {
    proc.kill('SIGKILL');
    throw new Error('Could not find Chromium page WebSocket target');
  }

  return { proc, cdpPort, pageWsUrl };
}

export async function runBatchExtract({
  jobs = DEFAULT_TAIBAI_JOBS,
  outDir = DEFAULT_OUT_DIR,
  quiet = false,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const runDir = fs.mkdtempSync('/dev/shm/ms_batch_');
  fs.chmodSync(runDir, 0o700);
  const userDataDir = path.join(runDir, 'profile');
  fs.mkdirSync(userDataDir, { mode: 0o700 });

  let cleanedUp = false;
  let chromeProc = null;
  let cdp = null;
  let assetServer = null;

  const cleanupAll = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (cdp) cdp.close();
    if (chromeProc && chromeProc.exitCode === null) {
      chromeProc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            chromeProc.kill('SIGKILL');
          } catch {}
          resolve();
        }, 1500);
        chromeProc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (assetServer) {
      await assetServer.close();
    }
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}
  };

  const onSig = () => {
    cleanupAll().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  const results = [];
  const tStartAll = performance.now();

  try {
    const extraDirs = jobs
      .map((j) => (j.videoPath ? path.dirname(path.resolve(j.videoPath)) : null))
      .filter(Boolean);
    assetServer = await startEphemeralAssetServer(extraDirs);
    const launched = await launchEphemeralChromium(userDataDir, runDir, (p) => {
      chromeProc = p;
    });
    chromeProc = launched.proc;

    cdp = new CDPClient(launched.pageWsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const loadFired = cdp.waitForEvent('Page.loadEventFired', 20000);
    await cdp.send('Page.navigate', { url: `${assetServer.origin}/extract.html` });
    await loadFired;

    // Wait for ES module initialization
    for (let i = 0; i < 60; i++) {
      const chk = await cdp.send('Runtime.evaluate', {
        expression: 'Boolean(window.__BATCH_EXTRACTOR__ && window.__BATCH_EXTRACTOR__.ready)',
        returnByValue: true,
      });
      if (chk.result?.value === true) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    for (const job of jobs) {
      const videoName = job.videoPath ? path.basename(job.videoPath) : job.videoFile;
      const localVideoPath = job.videoPath
        ? path.resolve(job.videoPath)
        : path.join(REF_VIDEOS_DIR, job.videoFile);
      if (!fs.existsSync(localVideoPath)) {
        throw new Error(`Missing source video on disk: ${localVideoPath}`);
      }

      const videoUrl = `${assetServer.origin}/reference_videos/${encodeURIComponent(videoName)}`;
      if (!quiet) {
        console.log(`[batch_extract] Extracting ${job.id} from ${videoName}...`);
      }

      const evalExpr = `window.__BATCH_EXTRACTOR__.extractVideoLandmarks(${JSON.stringify({
        videoUrl,
        nativeFrames: job.nativeFrames || null,
        nativeFps: job.nativeFps || 24,
        trimInSec: job.trimInSec ?? 0,
        trimOutSec: job.trimOutSec ?? null,
      })})`;

      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: evalExpr,
        awaitPromise: true,
        returnByValue: true,
      });

      if (evalRes.exceptionDetails) {
        throw new Error(
          `Browser extraction exception on ${job.id}: ${
            evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text
          }`
        );
      }

      const payload = evalRes.result?.value;
      if (!payload || !Array.isArray(payload.detections)) {
        throw new Error(`Invalid extraction payload returned for ${job.id}`);
      }

      const target60Frames = job.target60Frames || Math.max(2, Math.round(payload.duration * 60));
      const frames60 = processExtractedVideoSequence(payload.detections, {
        ...job,
        target60Frames,
      });

      const bvhText = serializeFramesToBVH(frames60, 60);
      const outPath = path.join(outDir, job.outFile);
      fs.writeFileSync(outPath, bvhText, 'utf8');

      const summary = {
        id: job.id,
        videoFile: videoName,
        outPath,
        outFile: job.outFile,
        videoResolution: `${payload.videoWidth}x${payload.videoHeight}`,
        videoDurationSec: +payload.duration.toFixed(4),
        nativeFrames: payload.frameCount,
        detectedFrames: payload.detectedCount,
        outputFrames60: frames60.length,
        outputDurationSec: +(frames60.length / 60).toFixed(3),
        bytes: Buffer.byteLength(bvhText, 'utf8'),
        elapsedMs: payload.elapsedMs,
      };
      results.push(summary);

      if (!quiet) {
        console.log(
          `  -> Wrote ${job.outFile} | detected ${summary.detectedFrames}/${summary.nativeFrames} @24fps -> ${summary.outputFrames60}f @60fps (${summary.outputDurationSec}s, ${summary.bytes} B) in ${(summary.elapsedMs / 1000).toFixed(2)}s`
        );
      }
    }
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    await cleanupAll();
  }

  if (!quiet) {
    const totalSec = ((performance.now() - tStartAll) / 1000).toFixed(2);
    console.log(`[batch_extract] Completed ${results.length} clips in ${totalSec}s (ephemeral /dev/shm cleaned).`);
  }

  return results;
}

function parseCliArgs(argv) {
  const opts = { manifestPath: null, onlyId: null, outDir: DEFAULT_OUT_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--manifest' && argv[i + 1]) {
      opts.manifestPath = path.resolve(argv[++i]);
    } else if (arg === '--only' && argv[i + 1]) {
      opts.onlyId = argv[++i];
    } else if (arg === '--out-dir' && argv[i + 1]) {
      opts.outDir = path.resolve(argv[++i]);
    }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(
      'Usage: node scripts/batch_extract.mjs [--manifest <jobs.json>] [--only <id>] [--out-dir <dir>]'
    );
    process.exit(0);
  }
  let jobs = DEFAULT_TAIBAI_JOBS;
  if (cli.manifestPath) {
    const parsed = JSON.parse(fs.readFileSync(cli.manifestPath, 'utf8'));
    jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
  }
  if (cli.onlyId) {
    jobs = jobs.filter((j) => j.id === cli.onlyId || j.outFile.includes(cli.onlyId));
    if (jobs.length === 0) {
      console.error(`No matching job found for --only ${cli.onlyId}`);
      process.exit(1);
    }
  }

  runBatchExtract({ jobs, outDir: cli.outDir }).catch((err) => {
    console.error('[batch_extract] FATAL:', err);
    process.exit(1);
  });
}
