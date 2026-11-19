#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { BASE_URL, MOTION_STAGE_ROOT } from './helpers/constants.mjs';
import { closeSharedBrowser } from './helpers/browser_cdp.mjs';
import { cleanupEphemeralViteBuild } from './helpers/contract_loader.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIER_ORDER = ['1', '2', '3', '4'];

const TIER_FILES = {
  '1': [
    path.join(__dirname, 'tier1', 'f01_f04_assets_sync.test.mjs'),
    path.join(__dirname, 'tier1', 'f05_f09_workbench.test.mjs'),
    path.join(__dirname, 'tier1', 'f10_f12_combat_git.test.mjs'),
  ],
  '2': [
    path.join(__dirname, 'tier2', 'f01_f04_assets_edge.test.mjs'),
    path.join(__dirname, 'tier2', 'f05_f09_workbench_edge.test.mjs'),
    path.join(__dirname, 'tier2', 'f10_f12_combat_git_edge.test.mjs'),
  ],
  '3': [path.join(__dirname, 'tier3', 'cross_feature_matrix.test.mjs')],
  '4': [path.join(__dirname, 'tier4', 'user_journeys.test.mjs')],
};

const FEATURE_ORDER = [
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
];

const VALID_FEATURES = new Set(FEATURE_ORDER);

function printUsageAndExit(msg, code = 1) {
  if (msg) {
    console.error(`[run_e2e] ERROR: ${msg}`);
  }
  console.error(
    'Usage: node /home/antigravity/tests/e2e/run_e2e.mjs [--tier 1|2|3|4|all] [--feature F1[,F2...]] [--grep <substr>]'
  );
  process.exit(code);
}

function parseCliArgs(argv) {
  let tier = 'all';
  const features = [];
  let grep = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(null, 0);
    } else if (arg === '--tier' || arg.startsWith('--tier=')) {
      const val = arg.includes('=') ? arg.slice('--tier='.length) : argv[++i];
      if (!val || !['1', '2', '3', '4', 'all'].includes(val)) {
        printUsageAndExit(`Invalid --tier value "${val || ''}". Expected 1, 2, 3, 4, or all.`);
      }
      tier = val;
    } else if (arg === '--feature' || arg.startsWith('--feature=')) {
      const val = arg.includes('=') ? arg.slice('--feature='.length) : argv[++i];
      if (!val) {
        printUsageAndExit('Missing value for --feature.');
      }
      for (const f of val.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
        if (!VALID_FEATURES.has(f)) {
          printUsageAndExit(`Invalid feature "${f}". Expected one of F1..F12.`);
        }
        features.push(f);
      }
    } else if (arg === '--grep' || arg.startsWith('--grep=')) {
      const val = arg.includes('=') ? arg.slice('--grep='.length) : argv[++i];
      if (!val) {
        printUsageAndExit('Missing value for --grep.');
      }
      grep = val;
    } else {
      printUsageAndExit(`Unknown CLI flag "${arg}".`);
    }
  }

  return { tier, features, grep };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTierFromEvent(ev) {
  const m = typeof ev.name === 'string' && ev.name.match(/\[T([1-4])\]/i);
  if (m) return m[1];
  const fm = typeof ev.file === 'string' && ev.file.match(/[\\/]tier([1-4])[\\/]/i);
  if (fm) return fm[1];
  return null;
}

function parseFeaturesFromEvent(ev) {
  if (typeof ev.name !== 'string') return [];
  const matches = ev.name.matchAll(/\[(F(?:1[0-2]|[1-9]))\]/gi);
  const out = new Set();
  for (const m of matches) {
    const f = m[1].toUpperCase();
    if (VALID_FEATURES.has(f)) out.add(f);
  }
  return [...out];
}

function createStatsBucket() {
  return { pass: 0, fail: 0, skip: 0 };
}

function formatRow(cols, widths) {
  return cols.map((c, idx) => String(c).padEnd(widths[idx])).join(' | ');
}

function printSummaryTables(tierStats, featureStats) {
  console.log('\n[MotionStage E2E] PER-TIER SUMMARY:');
  const tierWidths = [8, 8, 6, 6, 6, 8];
  const tierHeader = formatRow(['TIER', 'EXECUTED', 'PASS', 'FAIL', 'SKIP', 'STATUS'], tierWidths);
  const tierSep = tierWidths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(`  ${tierHeader}`);
  console.log(`  ${tierSep}`);
  for (const t of TIER_ORDER) {
    const b = tierStats.get(t);
    const exec = b.pass + b.fail + b.skip;
    const status = exec === 0 ? 'N/A' : b.fail === 0 && b.skip === 0 ? 'PASS' : 'FAIL';
    console.log(
      `  ${formatRow([`Tier ${t}`, exec, b.pass, b.fail, b.skip, status], tierWidths)}`
    );
  }

  console.log('\n[MotionStage E2E] PER-FEATURE SUMMARY (F1-F12, incl. multi-feature T3/T4 tags):');
  const featWidths = [8, 8, 6, 6, 6, 8];
  const featHeader = formatRow(['FEATURE', 'EXECUTED', 'PASS', 'FAIL', 'SKIP', 'STATUS'], featWidths);
  const featSep = featWidths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(`  ${featHeader}`);
  console.log(`  ${featSep}`);
  for (const f of FEATURE_ORDER) {
    const b = featureStats.get(f);
    const exec = b.pass + b.fail + b.skip;
    const status = exec === 0 ? 'N/A' : b.fail === 0 && b.skip === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${formatRow([f, exec, b.pass, b.fail, b.skip, status], featWidths)}`);
  }
  console.log('');
}

async function ensureViteDevServer() {
  try {
    const r = await fetch(BASE_URL);
    if (r.ok || r.status < 500) return null;
  } catch {}

  const u = new URL(BASE_URL);
  const port = u.port || '5173';
  const viteBin = path.join(MOTION_STAGE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const proc = spawn(process.execPath, [viteBin, '--host', u.hostname, '--port', port], {
    cwd: MOTION_STAGE_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE_URL);
      if (r.ok) return proc;
    } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  try {
    proc.kill('SIGKILL');
  } catch {}
  throw new Error(`Failed to reach or start Vite dev server at ${BASE_URL}`);
}

async function main() {
  process.exitCode = 1;
  const { tier, features, grep } = parseCliArgs(process.argv.slice(2));
  const files =
    tier === 'all'
      ? [...TIER_FILES['1'], ...TIER_FILES['2'], ...TIER_FILES['3'], ...TIER_FILES['4']]
      : [...TIER_FILES[tier]];

  for (const f of files) {
    if (!fs.existsSync(f)) {
      printUsageAndExit(`Missing test file on disk: ${f}`, 1);
    }
  }

  let testNamePatterns = undefined;
  if (features.length > 0 && grep) {
    const featAlt = features.map((f) => `\\[${escapeRegex(f)}\\]`).join('|');
    testNamePatterns = [new RegExp(`(?=.*(?:${featAlt}))(?=.*${escapeRegex(grep)})`, 'i')];
  } else if (features.length > 0) {
    const featAlt = features.map((f) => `\\[${escapeRegex(f)}\\]`).join('|');
    testNamePatterns = [new RegExp(`(?:${featAlt})`)];
  } else if (grep) {
    testNamePatterns = [new RegExp(escapeRegex(grep), 'i')];
  }

  const startedAt = Date.now();
  console.log('================================================================================');
  console.log(
    `[MotionStage E2E] Tier: ${tier} | Features: ${features.length ? features.join(',') : 'ALL'} | Grep: ${grep || 'NONE'}`
  );
  console.log(`[MotionStage E2E] Executing ${files.length} test file(s)...`);
  console.log('================================================================================');

  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  let topLevelErrors = 0;
  const failures = [];
  const tierStats = new Map(TIER_ORDER.map((t) => [t, createStatsBucket()]));
  const featureStats = new Map(FEATURE_ORDER.map((f) => [f, createStatsBucket()]));
  let spawnedViteProc = null;

  const recordOutcome = (ev, outcomeKey) => {
    const t = parseTierFromEvent(ev);
    if (t && tierStats.has(t)) {
      tierStats.get(t)[outcomeKey]++;
    }
    for (const f of parseFeaturesFromEvent(ev)) {
      featureStats.get(f)[outcomeKey]++;
    }
  };

  try {
    spawnedViteProc = await ensureViteDevServer();

    const stream = run({
      files,
      concurrency: false,
      isolation: 'none',
      timeout: 60000,
      ...(testNamePatterns ? { testNamePatterns } : {}),
    });

    stream.on('test:pass', (ev) => {
      if (ev.details?.type === 'suite' || ev.name.endsWith('.test.mjs')) return;
      if (ev.skip || ev.todo) {
        totalSkip++;
        recordOutcome(ev, 'skip');
        console.log(`  SKIP  ${ev.name}`);
        return;
      }
      totalPass++;
      recordOutcome(ev, 'pass');
      const ms = typeof ev.details?.duration_ms === 'number' ? `${ev.details.duration_ms.toFixed(1)}ms` : '';
      console.log(`  PASS  ${ev.name} (${ms})`);
    });

    stream.on('test:fail', (ev) => {
      // Ignore node:test suite rollup events so child leaf failures are never misclassified as CRASH
      if (ev.details?.type === 'suite') return;

      const errObj = ev.details?.error;
      const errMsg = errObj?.cause?.message || errObj?.message || String(errObj || 'Unknown test failure');
      const isFileLoadCrash =
        ev.details?.type !== 'suite' &&
        ev.nesting === 0 &&
        !/\[T[1-4]\]/i.test(ev.name || '');

      if (isFileLoadCrash) {
        topLevelErrors++;
        failures.push({ name: `[FILE CRASH] ${ev.name}`, error: errObj, message: errMsg });
        console.error(`  CRASH ${ev.name}: ${errMsg}`);
        return;
      }

      if (ev.skip || ev.todo) {
        totalSkip++;
        recordOutcome(ev, 'skip');
        console.log(`  SKIP  ${ev.name}`);
        return;
      }

      totalFail++;
      recordOutcome(ev, 'fail');
      failures.push({ name: ev.name, error: errObj, message: errMsg });
      console.error(`  FAIL  ${ev.name} -> ${errMsg.split('\n')[0]}`);
    });

    stream.on('test:Error', (err) => {
      topLevelErrors++;
      failures.push({ name: '[RUNNER STREAM ERROR]', error: err, message: String(err?.message || err) });
    });

    // Consume all test events
    // eslint-disable-next-line no-unused-vars
    for await (const _ of stream) {
      // drained
    }
  } catch (err) {
    topLevelErrors++;
    failures.push({ name: '[UNCAUGHT RUNNER EXCEPTION]', error: err, message: String(err?.message || err) });
  } finally {
    await closeSharedBrowser();
    cleanupEphemeralViteBuild();
    if (spawnedViteProc && spawnedViteProc.exitCode === null) {
      try {
        spawnedViteProc.kill('SIGKILL');
      } catch {}
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
  const totalExecuted = totalPass + totalFail + totalSkip;

  console.log('--------------------------------------------------------------------------------');
  if (failures.length > 0) {
    console.error(`[MotionStage E2E] FAILURE DETAILS (${failures.length}):`);
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i];
      console.error(`\n[${i + 1}] ${f.name}`);
      const stack = f.error?.cause?.stack || f.error?.stack || f.message;
      console.error(
        String(stack)
          .split('\n')
          .slice(0, 8)
          .map((l) => `    ${l}`)
          .join('\n')
      );
    }
    console.log('--------------------------------------------------------------------------------');
  }

  printSummaryTables(tierStats, featureStats);

  console.log(
    `[MotionStage E2E] TOTAL EXECUTED=${totalExecuted} | PASS=${totalPass} | FAIL=${totalFail} | SKIP=${totalSkip} | CRASH=${topLevelErrors} | TIME=${elapsedSec}s`
  );

  const ok =
    totalExecuted > 0 &&
    totalFail === 0 &&
    totalSkip === 0 &&
    topLevelErrors === 0;

  process.exit(ok ? 0 : 1);
}

main();
