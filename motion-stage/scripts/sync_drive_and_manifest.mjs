#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_HIERARCHY_SHA256,
  CANONICAL_HIERARCHY_LINE_COUNT,
} from './lib/bvhSerializer.mjs';
import {
  DRIVE_FOLDER_02C_ID,
  CLIP_CATALOG_26,
} from './lib/manifestCatalog.mjs';
import {
  verifyEntireLibrary,
  queryDriveFolder02CJson,
  sha256Buffer,
  inspectCanonicalBVHText,
} from './lib/kinematicVerifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const BVH_ROOT = path.join(WORKSPACE_ROOT, 'bvh_library');
const TAIBAI_DIR = path.join(BVH_ROOT, 'C_taibai_extracted');
const MANIFEST_PATH = path.join(BVH_ROOT, 'MANIFEST.json');

export function syncTaibaiToDriveAndBuildManifest({ dryRunDrive = false, quiet = false } = {}) {
  // 1. Strictly verify all 26 local BVH files & raw provenance BEFORE any Drive 02/C mutation!
  const localCheck = verifyEntireLibrary({
    workspaceRoot: WORKSPACE_ROOT,
    checkManifest: false,
    checkDrive: false,
  });
  if (!localCheck.ok) {
    throw new Error(
      `Aborting Drive 02/C sync — local BVH verification failed:\n  ${localCheck.errors.join('\n  ')}`
    );
  }

  // 2. Query Drive 02/C (STRICTLY ONLY the 4 C_taibai_extracted/taibai_*.bvh files!)
  let existingItems = queryDriveFolder02CJson();
  const existingByName = new Map();
  for (const item of existingItems) {
    if (!existingByName.has(item.name)) {
      existingByName.set(item.name, item);
    }
  }

  const taibaiEntries = CLIP_CATALOG_26.filter((c) => c.folder === 'C_taibai_extracted');
  if (taibaiEntries.length !== 4) {
    throw new Error(`Expected exact 4 C_taibai_extracted entries, got ${taibaiEntries.length}`);
  }

  let shmSyncDir = null;
  try {
    if (!dryRunDrive) {
      shmSyncDir = fs.mkdtempSync('/dev/shm/ms_sync_drive_');
      fs.chmodSync(shmSyncDir, 0o700);

      for (const entry of taibaiEntries) {
        if (!entry.fileName.startsWith('taibai_')) {
          throw new Error(`Safety guard blocked non-Taibai upload to 02/C: ${entry.fileName}`);
        }
        const localPath = path.join(TAIBAI_DIR, entry.fileName);
        const localBuf = fs.readFileSync(localPath);
        const localSize = localBuf.length;
        const localSha256 = sha256Buffer(localBuf);
        const existing = existingByName.get(entry.fileName);

        if (!existing) {
          if (!quiet) {
            console.log(`[sync_drive] Uploading new ${entry.fileName} (${localSize} B) -> Drive 02/C...`);
          }
          execFileSync(
            'gdrive',
            ['mutate', 'upload', localPath, '--parent', DRIVE_FOLDER_02C_ID, '--mime-type', 'text/plain'],
            { stdio: quiet ? 'pipe' : 'inherit' }
          );
        } else {
          let remoteSha256 = null;
          if (Number(existing.size) === localSize) {
            const dlPath = path.join(shmSyncDir, entry.fileName);
            execFileSync('gdrive', ['readonly', 'download', existing.id, '--out', dlPath], {
              stdio: 'pipe',
            });
            remoteSha256 = sha256Buffer(fs.readFileSync(dlPath));
          }

          if (Number(existing.size) !== localSize || remoteSha256 !== localSha256) {
            if (!quiet) {
              console.log(
                `[sync_drive] Updating existing ${entry.fileName} in-place (id=${existing.id}, size ${existing.size}->${localSize} B, sha256 -> ${localSha256.slice(0, 12)})...`
              );
            }
            execFileSync(
              'gdrive',
              ['mutate', 'update', existing.id, localPath, '--mime-type', 'text/plain'],
              { stdio: quiet ? 'pipe' : 'inherit' }
            );
          } else if (!quiet) {
            console.log(
              `[sync_drive] ${entry.fileName} already SHA-256 bit-identical on Drive 02/C (id=${existing.id}, ${localSize} B).`
            );
          }
        }
      }
    }
  } finally {
    if (shmSyncDir) {
      try {
        fs.rmSync(shmSyncDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // 3. Re-query Drive 02/C to harvest exact driveFileIds and verify exact 4 files
  const postItems = queryDriveFolder02CJson();
  if (!dryRunDrive && postItems.length !== 4) {
    throw new Error(
      `Post-sync Drive 02/C expected exact 4 files, got ${postItems.length}: ${JSON.stringify(postItems)}`
    );
  }
  const driveIdByName = new Map(postItems.map((it) => [it.name, it]));

  // 4. Build /home/antigravity/bvh_library/MANIFEST.json (26 clips)
  const manifestClips = [];
  for (const cat of CLIP_CATALOG_26) {
    const diskPath = path.join(BVH_ROOT, cat.folder, cat.fileName);
    const buf = fs.readFileSync(diskPath);
    const text = buf.toString('utf8');
    const fk = inspectCanonicalBVHText(text, cat.fileName);
    if (!fk.ok) {
      throw new Error(`Invalid BVH during manifest generation: ${fk.errors.join('; ')}`);
    }

    let driveFileId = cat.driveFileId || null;
    if (cat.folder === 'C_taibai_extracted') {
      const dItem = driveIdByName.get(cat.fileName);
      if (!dryRunDrive && (!dItem || Number(dItem.size) !== buf.length)) {
        throw new Error(`Drive 02/C verification mismatch for ${cat.fileName}`);
      }
      driveFileId = dItem ? dItem.id : null;
    }

    manifestClips.push({
      id: cat.id,
      category: cat.category,
      label: cat.label,
      folder: cat.folder,
      fileName: cat.fileName,
      path: `/bvh_library/${cat.folder}/${cat.fileName}`,
      archetype: cat.archetype,
      direction: cat.direction,
      cyclic: cat.cyclic,
      hasWeapon: cat.hasWeapon,
      preserveRootMotion: cat.preserveRootMotion,
      frames: fk.frames,
      fps: fk.fps,
      durationSec: fk.durationSec,
      bytes: buf.length,
      sha256: sha256Buffer(buf),
      sourceProvenance: cat.sourceProvenance,
      sourceProvenanceDetail: cat.sourceProvenanceDetail,
      driveFileId,
    });
  }

  const manifestObj = {
    version: '1.0.0',
    standard: {
      skeleton: 'MotionStage-Humanoid-21Bone',
      jointCount: 21,
      channelCount: 66,
      units: 'cm',
      blenderImportScale: 0.01,
      rotationOrder: 'ZXY',
      upAxis: 'Y',
      forwardAxis: '+Z',
      hierarchyLineCount: CANONICAL_HIERARCHY_LINE_COUNT,
      hierarchySha256: CANONICAL_HIERARCHY_SHA256,
    },
    generatedAt: new Date().toISOString(),
    totalClips: manifestClips.length,
    counts: {
      B_cleaned_ready: manifestClips.filter((c) => c.folder === 'B_cleaned_ready').length,
      C_taibai_extracted: manifestClips.filter((c) => c.folder === 'C_taibai_extracted').length,
    },
    driveSync: {
      folderId: DRIVE_FOLDER_02C_ID,
      folderPath: '02_标准BVH骨骼动作资产库/C_AI视频提取成品_天刀太白招式BVH',
      syncedCount: postItems.length,
    },
    clips: manifestClips,
  };

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifestObj, null, 2)}\n`, 'utf8');
  if (!quiet) {
    console.log(`[sync_drive] Wrote ${MANIFEST_PATH} indexing ${manifestObj.totalClips} clips.`);
  }

  return { manifestObj, driveItems: postItems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const dryRunDrive = process.argv.includes('--dry-run-drive');
  try {
    syncTaibaiToDriveAndBuildManifest({ dryRunDrive });
    if (!dryRunDrive) {
      const fullRes = verifyEntireLibrary({
        workspaceRoot: WORKSPACE_ROOT,
        checkManifest: true,
        checkDrive: true,
      });
      if (!fullRes.ok) {
        console.error('[sync_drive] Post-sync verification failed:', fullRes.errors);
        process.exit(1);
      }
      console.log('[sync_drive] Full 6-category post-sync verification PASSED 100%.');
    }
  } catch (err) {
    console.error('[sync_drive] FATAL:', err);
    process.exit(1);
  }
}
