import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { BASE_URL, CHROMIUM_BIN } from './constants.mjs';

const KEY_DEFS = {
  KeyW: { key: 'w', code: 'KeyW', text: 'w', vk: 87 },
  KeyA: { key: 'a', code: 'KeyA', text: 'a', vk: 65 },
  KeyS: { key: 's', code: 'KeyS', text: 's', vk: 83 },
  KeyD: { key: 'd', code: 'KeyD', text: 'd', vk: 68 },
  KeyJ: { key: 'j', code: 'KeyJ', text: 'j', vk: 74 },
  KeyK: { key: 'k', code: 'KeyK', text: 'k', vk: 75 },
  KeyQ: { key: 'q', code: 'KeyQ', text: 'q', vk: 81 },
  KeyE: { key: 'e', code: 'KeyE', text: 'e', vk: 69 },
  KeyR: { key: 'r', code: 'KeyR', text: 'r', vk: 82 },
  KeyF: { key: 'f', code: 'KeyF', text: 'f', vk: 70 },
  KeyC: { key: 'c', code: 'KeyC', text: 'c', vk: 67 },
  KeyV: { key: 'v', code: 'KeyV', text: 'v', vk: 86 },
  Space: { key: ' ', code: 'Space', text: ' ', vk: 32 },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', vk: 16, modifiers: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Digit1: { key: '1', code: 'Digit1', text: '1', vk: 49 },
  Digit2: { key: '2', code: 'Digit2', text: '2', vk: 50 },
  Digit3: { key: '3', code: 'Digit3', text: '3', vk: 51 },
};

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killProcessesUsingShmDir(shmDir) {
  if (!shmDir) return;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid || pid === process.ppid) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes(shmDir)) {
          process.kill(pid, 'SIGKILL');
        }
      } catch {}
    }
  } catch {}
}

class CDPConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message}`));
          } else {
            entry.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) {
          for (const fn of handlers) {
            try {
              fn(msg.params);
            } catch {}
          }
        }
      }
    });

    const handleClose = () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`CDP socket closed during ${entry.method}`));
      }
      this.pending.clear();
    };
    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleClose);
  }

  static connect(wsUrl, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to CDP WebSocket ${wsUrl}`));
      }, timeoutMs);
      timer.unref?.();

      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CDPConnection(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        (err) => {
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket error: ${err?.message || 'failed'}`));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 25000) {
    if (this.closed) {
      return Promise.reject(new Error(`CDP already closed before ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs}ms) on ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}

let sharedState = null;
let sharedInitPromise = null;
let activeUsers = 0;
let idleSocketTimer = null;

function scheduleIdleSocketDisconnect() {
  if (idleSocketTimer) {
    clearTimeout(idleSocketTimer);
    idleSocketTimer = null;
  }
  if (activeUsers > 0 || !sharedState) return;
  idleSocketTimer = setTimeout(() => {
    idleSocketTimer = null;
    if (activeUsers > 0 || !sharedState) return;
    if (sharedState.warmCaptureConn) {
      sharedState.warmCaptureConn.close();
      sharedState.warmCaptureConn = null;
    }
    if (sharedState.browserClient) {
      sharedState.browserClient.close();
      sharedState.browserClient = null;
    }
  }, 200);
  idleSocketTimer.unref();
}

async function acquireSharedBrowser() {
  activeUsers++;
  if (idleSocketTimer) {
    clearTimeout(idleSocketTimer);
    idleSocketTimer = null;
  }
  try {
    if (!sharedState || sharedState.proc.exitCode !== null) {
      if (!sharedInitPromise) {
        sharedInitPromise = startSharedBrowserProcess().finally(() => {
          sharedInitPromise = null;
        });
      }
      sharedState = await sharedInitPromise;
    }
    if (!sharedState.browserClient || sharedState.browserClient.closed) {
      sharedState.browserClient = await CDPConnection.connect(sharedState.wsDebuggerUrl);
    }
    return sharedState;
  } catch (err) {
    activeUsers = Math.max(0, activeUsers - 1);
    scheduleIdleSocketDisconnect();
    throw err;
  }
}

function releaseSharedBrowser() {
  activeUsers = Math.max(0, activeUsers - 1);
  scheduleIdleSocketDisconnect();
}

async function startSharedBrowserProcess() {
  const rand = crypto.randomBytes(6).toString('hex');
  const shmDir = `/dev/shm/e2e_cdp_${process.pid}_${rand}`;
  fs.mkdirSync(shmDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(shmDir, 0o700);

  const port = await findFreePort();
  // Includes all mandatory flags per PROJECT.md § Interface Contract 5
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
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,720',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${shmDir}`,
    'about:blank',
  ];

  const proc = spawn(CHROMIUM_BIN, args, {
    env: { ...process.env, TMPDIR: shmDir },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  proc.unref();

  const cleanupSync = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {}
    try {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    } catch {}
    killProcessesUsingShmDir(shmDir);
    try {
      if (fs.existsSync(shmDir)) fs.rmSync(shmDir, { recursive: true, force: true });
    } catch {}
  };
  process.once('exit', cleanupSync);
  process.once('SIGINT', () => {
    cleanupSync();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanupSync();
    process.exit(143);
  });

  let verInfo = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        verInfo = await r.json();
        if (verInfo?.webSocketDebuggerUrl) break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!verInfo?.webSocketDebuggerUrl) {
    cleanupSync();
    throw new Error('Failed to start shared headless Chromium CDP server');
  }

  const browserClient = await CDPConnection.connect(verInfo.webSocketDebuggerUrl);
  return {
    proc,
    port,
    shmDir,
    wsDebuggerUrl: verInfo.webSocketDebuggerUrl,
    browserClient,
    warmCaptureTargetId: null,
    warmCaptureConn: null,
    warmCapturePage: null,
    cleanupSync,
  };
}

export async function closeSharedBrowser() {
  if (idleSocketTimer) {
    clearTimeout(idleSocketTimer);
    idleSocketTimer = null;
  }
  if (!sharedState) return;
  const { proc, shmDir, browserClient, warmCaptureConn } = sharedState;
  sharedState = null;
  try {
    warmCaptureConn?.close();
  } catch {}
  try {
    browserClient?.close();
  } catch {}
  if (proc) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {}
    if (proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref?.();
          proc.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      } catch {}
    }
  }
  killProcessesUsingShmDir(shmDir);
  await new Promise((r) => setTimeout(r, 40));
  killProcessesUsingShmDir(shmDir);
  if (shmDir && fs.existsSync(shmDir)) {
    try {
      fs.rmSync(shmDir, { recursive: true, force: true });
    } catch {}
  }
}

function attachPageHelpers(pageConn, targetId) {
  const pageErrors = [];
  const consoleErrors = [];
  const httpErrors = [];
  const networkRequests = [];
  const heldCodes = new Set();

  pageConn.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(
      p.exceptionDetails?.exception?.description ||
        p.exceptionDetails?.text ||
        'Uncaught exception'
    );
  });
  pageConn.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      consoleErrors.push(
        (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      );
    }
  });
  pageConn.on('Network.requestWillBeSent', (p) => {
    if (p.request?.url) networkRequests.push(p.request.url);
  });
  pageConn.on('Network.responseReceived', (p) => {
    if (p.response?.status >= 400 && !p.response.url.includes('favicon.ico')) {
      httpErrors.push({ url: p.response.url, status: p.response.status });
    }
  });

  const page = {
    targetId,
    conn: pageConn,
    pageErrors,
    consoleErrors,
    httpErrors,
    networkRequests,
    heldCodes,
    clearLogs() {
      pageErrors.length = 0;
      consoleErrors.length = 0;
      httpErrors.length = 0;
      networkRequests.length = 0;
    },
    async setViewport(width, height, deviceScaleFactor = 1) {
      await pageConn.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    },
    async setBlockedURLs(urls) {
      await pageConn.send('Network.setBlockedURLs', { urls });
    },
    async goto(url, waitReadyMs = 5000) {
      const fullUrl = url.startsWith('http')
        ? url
        : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
      await pageConn.send('Page.navigate', { url: fullUrl });
      await page.waitFor(
        () => document.readyState === 'complete' || document.readyState === 'interactive',
        waitReadyMs,
        40
      );
      await pageConn.send('Page.bringToFront').catch(() => {});
    },
    async evaluate(exprOrFn, ...args) {
      const expression =
        typeof exprOrFn === 'function'
          ? `(${exprOrFn.toString()})(...${JSON.stringify(args)})`
          : exprOrFn;
      const res = await pageConn.send(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        25000
      );
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ||
            res.exceptionDetails.text ||
            'Runtime.evaluate error'
        );
      }
      return res.result?.value;
    },
    async waitFor(predicateFnOrExpr, timeoutMs = 2000, pollMs = 60) {
      const deadline = Date.now() + timeoutMs;
      let lastVal = null;
      let lastErr = null;
      while (Date.now() < deadline) {
        try {
          lastVal = await page.evaluate(predicateFnOrExpr);
          if (lastVal) return lastVal;
        } catch (err) {
          lastErr = err;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for condition (last=${JSON.stringify(lastVal)}${lastErr ? `, err=${lastErr.message}` : ''})`
      );
    },
    async keyDown(code) {
      const d = KEY_DEFS[code] || { key: code, code, vk: 0 };
      heldCodes.add(code);
      await pageConn.send('Page.bringToFront').catch(() => {});
      await pageConn.send('Input.dispatchKeyEvent', {
        type: d.text ? 'keyDown' : 'rawKeyDown',
        key: d.key,
        code: d.code,
        ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}),
        windowsVirtualKeyCode: d.vk,
        nativeVirtualKeyCode: d.vk,
        ...(d.modifiers ? { modifiers: d.modifiers } : {}),
      });
    },
    async keyUp(code) {
      const d = KEY_DEFS[code] || { key: code, code, vk: 0 };
      heldCodes.delete(code);
      await pageConn.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: d.key,
        code: d.code,
        windowsVirtualKeyCode: d.vk,
        nativeVirtualKeyCode: d.vk,
      });
    },
    async tapKey(code, holdMs = 25) {
      await page.keyDown(code);
      await new Promise((r) => setTimeout(r, holdMs));
      await page.keyUp(code);
    },
    async mouseClick(x = 240, y = 135, button = 'left') {
      await pageConn.send('Page.bringToFront').catch(() => {});
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 20));
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount: 1,
      });
    },
    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };

  return page;
}

async function createPageHandle(state, options = {}) {
  const { port, browserClient } = state;
  const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank' });
  await browserClient.send('Target.activateTarget', { targetId }).catch(() => {});
  const pageConn = await CDPConnection.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);

  await pageConn.send('Page.enable');
  await pageConn.send('Runtime.enable');
  await pageConn.send('Network.enable');
  await pageConn.send('Page.bringToFront').catch(() => {});
  await pageConn.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  if (Array.isArray(options.blockUrls) && options.blockUrls.length > 0) {
    await pageConn.send('Network.setBlockedURLs', { urls: options.blockUrls });
  }
  await pageConn.send('Emulation.setDeviceMetricsOverride', {
    width: options.width || 1120,
    height: options.height || 700,
    deviceScaleFactor: options.deviceScaleFactor || 1,
    mobile: false,
  });

  return attachPageHelpers(pageConn, targetId);
}

export async function withPage(initialUrl, fn, options = {}) {
  const state = await acquireSharedBrowser();
  let page = null;
  try {
    page = await createPageHandle(state, options);
    if (initialUrl) {
      await page.goto(initialUrl);
    }
    return await fn(page);
  } finally {
    if (page) {
      for (const code of [...page.heldCodes]) {
        try {
          await page.keyUp(code);
        } catch {}
      }
      page.conn.close();
      try {
        await state.browserClient?.send('Target.closeTarget', { targetId: page.targetId }, 3000);
      } catch {}
    }
    releaseSharedBrowser();
  }
}

export async function withCapturePage(fn) {
  const state = await acquireSharedBrowser();
  try {
    if (!state.warmCaptureTargetId) {
      const p = await createPageHandle(state, {
        width: 960,
        height: 540,
        blockUrls: ['*/src/main.js*'],
      });
      await p.goto('/');
      state.warmCaptureTargetId = p.targetId;
      state.warmCaptureConn = p.conn;
      state.warmCapturePage = p;
    } else if (!state.warmCaptureConn || state.warmCaptureConn.closed) {
      const pageConn = await CDPConnection.connect(
        `ws://127.0.0.1:${state.port}/devtools/page/${state.warmCaptureTargetId}`
      );
      await pageConn.send('Page.enable');
      await pageConn.send('Runtime.enable');
      await pageConn.send('Network.enable');
      state.warmCaptureConn = pageConn;
      state.warmCapturePage = attachPageHelpers(pageConn, state.warmCaptureTargetId);
    }
    state.warmCapturePage.clearLogs();
    return await fn(state.warmCapturePage);
  } finally {
    releaseSharedBrowser();
  }
}

export async function withWorkbenchPage(fn, options = {}) {
  return withPage(
    '/',
    async (page) => {
      const hasCanvas = await page
        .waitFor(() => Boolean(document.querySelector('#canvas-container canvas')), 2000, 50)
        .catch(() => false);
      if (!hasCanvas) {
        assert.fail('[F6-F9/F12] #canvas-container canvas did not mount within 2000ms on /');
      }
      const hasHandle = await page
        .waitFor(() => Boolean(window.__MOTION_STAGE__), 1800, 50)
        .catch(() => false);
      if (!hasHandle) {
        assert.fail('[F6-F9/F12] window.__MOTION_STAGE__ public contract is not yet exposed on /');
      }
      return await fn(page);
    },
    {
      width: options.width || 1120,
      height: options.height || 700,
      deviceScaleFactor: options.deviceScaleFactor || 1.5,
    }
  );
}

let resolvedCombatEntryUrl = null;

export async function withCombatArenaPage(fn, options = {}) {
  const initialEntry = resolvedCombatEntryUrl || '/?mode=combat';
  return withPage(
    initialEntry,
    async (page) => {
      let ready = await page
        .waitFor(
          () => Boolean(window.__COMBAT_ARENA__ && window.__COMBAT_ARENA__.getState()?.active),
          1600,
          50
        )
        .catch(() => false);

      if (ready && !resolvedCombatEntryUrl) {
        resolvedCombatEntryUrl = initialEntry;
      }

      if (!ready && initialEntry !== '/combat.html') {
        await page.goto('/combat.html', 2500).catch(() => {});
        ready = await page
          .waitFor(() => Boolean(window.__COMBAT_ARENA__?.getState()?.active), 1800, 50)
          .catch(() => false);
        if (ready) {
          resolvedCombatEntryUrl = '/combat.html';
        }
      }
      if (!ready) {
        assert.fail(
          '[F10-F12] window.__COMBAT_ARENA__ public contract is not yet active on /?mode=combat or /combat.html'
        );
      }
      return await fn(page);
    },
    {
      width: options.width || 480,
      height: options.height || 270,
      deviceScaleFactor: options.deviceScaleFactor || 1,
    }
  );
}
