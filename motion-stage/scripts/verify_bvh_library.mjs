#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEntireLibrary } from './lib/kinematicVerifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  return {
    localOnly: argv.includes('--local-only'),
    skipDrive: argv.includes('--skip-drive') || argv.includes('--local-only'),
    skipManifest: argv.includes('--skip-manifest') || argv.includes('--local-only'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = parseArgs(process.argv.slice(2));
  const res = verifyEntireLibrary({
    workspaceRoot: WORKSPACE_ROOT,
    checkManifest: !args.skipManifest,
    checkDrive: !args.skipDrive,
  });

  if (args.verbose || !res.ok) {
    console.log('=== BVH Library Kinematic & Structural Summary ===');
    for (const r of res.clipReports) {
      console.log(
        `  [${r.folder}] ${r.fileName.padEnd(46)} | ${String(r.frames).padStart(3)}f @${r.fps}fps | maxJ=${r.maxLocalJointStepDeg.toFixed(1)}° | maxKnee=${r.maxKneeStepDeg.toFixed(1)}° | tipStep=${r.maxSwordTipStepCm.toFixed(1)}cm | torso=${r.minSwordTorsoDistCm.toFixed(1)}cm | head=${r.minSwordNeckHeadDistCm.toFixed(1)}cm | minHipY=${r.minHipsYCm.toFixed(1)}cm | slip=${r.interiorStanceRmsSlipCmS.toFixed(4)}cm/s`
      );
    }
  }

  if (!res.ok) {
    console.error(`\n[verify_bvh_library] FAILED with ${res.errors.length} error(s):`);
    for (const err of res.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `[verify_bvh_library] PASS: All ${res.clipReports.length} BVH files, raw provenance assets, reference videos${
      args.skipManifest ? '' : ', MANIFEST.json'
    }${args.skipDrive ? '' : ', and Google Drive 02/C (4 files)'} passed 100% of assertions.`
  );
}
