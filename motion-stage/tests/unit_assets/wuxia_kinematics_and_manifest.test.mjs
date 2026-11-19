import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLIP_CATALOG_26 } from '../../scripts/lib/manifestCatalog.mjs';
import {
  inspectCanonicalBVHText,
  verifyClipKinematics,
  verifyEntireLibrary,
} from '../../scripts/lib/kinematicVerifier.mjs';

const WORKSPACE_ROOT = '/home/antigravity';
const BVH_ROOT = path.join(WORKSPACE_ROOT, 'bvh_library');

test('Category C: All 26 BVH clips pass Forward Kinematics, 1-frame rotational/3D continuity, and Head/Neck/Torso clearance gates', () => {
  for (const entry of CLIP_CATALOG_26) {
    const fp = path.join(BVH_ROOT, entry.folder, entry.fileName);
    const text = fs.readFileSync(fp, 'utf8');
    const fk = inspectCanonicalBVHText(text, entry.fileName);
    assert.equal(fk.ok, true, fk.errors.join('; '));
    const kinErrors = verifyClipKinematics(entry, fk);
    assert.deepEqual(kinErrors, [], `Kinematic assertion failure on ${entry.fileName}: ${kinErrors.join('; ')}`);

    const isLegacy = /^0[1-6]_/.test(entry.fileName);
    if (!isLegacy) {
      assert.ok(fk.maxKneeStepDeg <= 45.0, `${entry.id} maxKneeStepDeg=${fk.maxKneeStepDeg.toFixed(2)}°`);
      const maxLocalCap = entry.id === 'taibai_01b_idle_combat' ? 18.0 : 50.0;
      assert.ok(
        fk.maxLocalJointStepDeg <= maxLocalCap,
        `${entry.id} maxLocalJointStepDeg=${fk.maxLocalJointStepDeg.toFixed(2)}° (${fk.maxLocalJointStepInfo})`
      );
      if (!entry.cyclic) {
        assert.ok(fk.endJointStepDeg <= 25.0, `${entry.id} endJointStepDeg=${fk.endJointStepDeg.toFixed(2)}°`);
        assert.ok(fk.endHipsStepCm <= 10.0, `${entry.id} endHipsStepCm=${fk.endHipsStepCm.toFixed(2)}cm`);
      }
      assert.ok(fk.maxKneeStep3DCm <= 26.0, `${entry.id} maxKneeStep3DCm=${fk.maxKneeStep3DCm.toFixed(2)}cm`);
      const maxTipCap = entry.id === 'taibai_01b_idle_combat' ? 18.0 : 70.0;
      assert.ok(fk.maxSwordTipStepCm <= maxTipCap, `${entry.id} maxSwordTipStepCm=${fk.maxSwordTipStepCm.toFixed(2)}cm`);
      assert.ok(fk.minSwordNeckHeadDistCm >= 20.0, `${entry.id} minSwordNeckHeadDistCm=${fk.minSwordNeckHeadDistCm.toFixed(2)}cm`);
      assert.ok(fk.minSwordTorsoDistCm >= 22.0, `${entry.id} minSwordTorsoDistCm=${fk.minSwordTorsoDistCm.toFixed(2)}cm`);
    }
    if (entry.id === 'taibai_03_yuluo') {
      assert.ok(fk.minHipsYCm >= 50.0, `taibai_03 minHipsYCm=${fk.minHipsYCm.toFixed(2)}cm < 50.0cm`);
    }
  }
});

test('Category E & F: MANIFEST.json (string sourceProvenance) and Google Drive 02/C (live SHA-256) match all 26 local clips 100%', () => {
  const full = verifyEntireLibrary({
    workspaceRoot: WORKSPACE_ROOT,
    checkManifest: true,
    checkDrive: true,
  });
  assert.equal(full.ok, true, `Library/Manifest/Drive verification errors:\n${full.errors.join('\n')}`);
  assert.equal(full.clipReports.length, 26);
  assert.equal(full.driveItems.length, 4);

  const manifest = JSON.parse(fs.readFileSync(path.join(BVH_ROOT, 'MANIFEST.json'), 'utf8'));
  for (const clip of manifest.clips) {
    assert.equal(typeof clip.sourceProvenance, 'string');
    assert.ok(clip.sourceProvenance.length > 10);
    assert.equal(typeof clip.sourceProvenanceDetail, 'object');
  }
});
