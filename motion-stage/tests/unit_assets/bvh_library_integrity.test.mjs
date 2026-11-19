import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANONICAL_HIERARCHY_SHA256,
  CANONICAL_HIERARCHY_BYTE_LENGTH,
  CANONICAL_HIERARCHY_LINE_COUNT,
  buildCanonicalHierarchy,
} from '../../scripts/lib/bvhSerializer.mjs';
import {
  IMMUTABLE_B_CLEANED_01_06,
  IMMUTABLE_A_RAW_BASELINE,
  REFERENCE_VIDEOS_SPEC,
  CLIP_CATALOG_26,
} from '../../scripts/lib/manifestCatalog.mjs';
import {
  sha256Buffer,
  sha256File,
  inspectCanonicalBVHText,
} from '../../scripts/lib/kinematicVerifier.mjs';

const WORKSPACE_ROOT = '/home/antigravity';
const BVH_ROOT = path.join(WORKSPACE_ROOT, 'bvh_library');
const RAW_DIR = path.join(BVH_ROOT, 'A_raw_mocap');
const CLEAN_DIR = path.join(BVH_ROOT, 'B_cleaned_ready');
const TAIBAI_DIR = path.join(BVH_ROOT, 'C_taibai_extracted');
const VIDEO_DIR = path.join(WORKSPACE_ROOT, 'reference_videos');

test('Canonical 21-bone HIERARCHY builder matches byte-for-byte SHA-256 standard', () => {
  const { lines, jointOrder, hierarchyText } = buildCanonicalHierarchy();
  assert.equal(jointOrder.length, 21);
  assert.equal(lines.length, CANONICAL_HIERARCHY_LINE_COUNT);
  assert.equal(Buffer.byteLength(hierarchyText, 'utf8'), CANONICAL_HIERARCHY_BYTE_LENGTH);
  assert.equal(sha256Buffer(Buffer.from(hierarchyText, 'utf8')), CANONICAL_HIERARCHY_SHA256);
});

test('Category A: Immutable B_cleaned_ready 01..06 and A_raw_mocap baselines are untouched', () => {
  for (const item of IMMUTABLE_B_CLEANED_01_06) {
    const fp = path.join(CLEAN_DIR, item.fileName);
    assert.ok(fs.existsSync(fp), `Missing ${item.fileName}`);
    const buf = fs.readFileSync(fp);
    assert.equal(buf.length, item.bytes, `Byte mismatch on ${item.fileName}`);
    assert.equal(sha256Buffer(buf), item.sha256, `SHA-256 mismatch on ${item.fileName}`);
  }

  for (const item of IMMUTABLE_A_RAW_BASELINE) {
    const fp = path.join(RAW_DIR, item.fileName);
    assert.ok(fs.existsSync(fp), `Missing ${item.fileName}`);
    const buf = fs.readFileSync(fp);
    assert.equal(buf.length, item.bytes, `Byte mismatch on ${item.fileName}`);
    assert.equal(sha256Buffer(buf), item.sha256, `SHA-256 mismatch on ${item.fileName}`);
  }
});

test('Category D: All 6 reference videos (including 01 1080p and 05 2012 master) match Drive hashes', () => {
  for (const v of REFERENCE_VIDEOS_SPEC) {
    const fp = path.join(VIDEO_DIR, v.fileName);
    assert.ok(fs.existsSync(fp), `Missing reference video ${v.fileName}`);
    assert.equal(fs.statSync(fp).size, v.bytes, `Size mismatch on ${v.fileName}`);
    assert.equal(sha256File(fp), v.sha256, `SHA-256 mismatch on ${v.fileName}`);
  }
});

test('Category B & D: Exact 22+4 BVH inventory, canonical 66-channel format, and 120fps CMU provenance', () => {
  const bFiles = fs.readdirSync(CLEAN_DIR).filter((f) => f.endsWith('.bvh')).sort();
  const cFiles = fs.readdirSync(TAIBAI_DIR).filter((f) => f.endsWith('.bvh')).sort();
  assert.equal(bFiles.length, 22, 'Expected exact 22 .bvh files in B_cleaned_ready');
  assert.equal(cFiles.length, 4, 'Expected exact 4 .bvh files in C_taibai_extracted');

  const rawFiles = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.bvh'));
  for (const rf of rawFiles) {
    assert.ok(!/24_01|87_02|124_/.test(rf), `Forbidden CMU trial present: ${rf}`);
  }

  for (const entry of CLIP_CATALOG_26) {
    const fp = path.join(BVH_ROOT, entry.folder, entry.fileName);
    assert.ok(fs.existsSync(fp), `Missing ${entry.folder}/${entry.fileName}`);
    const text = fs.readFileSync(fp, 'utf8');
    const parsed = inspectCanonicalBVHText(text, entry.fileName);
    assert.equal(parsed.ok, true, `Structural BVH failure on ${entry.fileName}: ${parsed.errors.join('; ')}`);
    assert.equal(parsed.fps, 60, `Expected 60fps on ${entry.fileName}`);
    assert.ok(parsed.activeJointCount >= 6, `Static/dummy pose detected on ${entry.fileName}`);

    assert.equal(typeof entry.sourceProvenance, 'string', `Expected string sourceProvenance on ${entry.id}`);
    assert.ok(entry.sourceProvenance.length > 10, `sourceProvenance too short on ${entry.id}`);
    assert.equal(typeof entry.sourceProvenanceDetail, 'object', `Missing sourceProvenanceDetail on ${entry.id}`);

    if (entry.folder === 'C_taibai_extracted') {
      const prefix = entry.fileName.split('_').slice(0, 2).join('_');
      assert.ok(
        entry.label.startsWith(prefix),
        `Expected Taibai label "${entry.label}" to start with "${prefix}"`
      );
    }

    if (
      entry.sourceProvenanceDetail.type === 'optical_mocap_cmu' &&
      !entry.sourceProvenanceDetail.rawAsset.endsWith('cmu_87_01_tornado_kick.bvh')
    ) {
      const rawPath = path.join(WORKSPACE_ROOT, entry.sourceProvenanceDetail.rawAsset);
      assert.ok(fs.existsSync(rawPath), `Missing CMU provenance file ${rawPath}`);
      assert.ok(fs.statSync(rawPath).size > 10240, `CMU provenance file too small: ${rawPath}`);
      const head = fs.readFileSync(rawPath, 'utf8').slice(0, 12288);
      assert.match(head, /Frame Time:\s*0?\.008333/, `Expected 120fps CMU source for ${rawPath}`);
    }
  }
});
