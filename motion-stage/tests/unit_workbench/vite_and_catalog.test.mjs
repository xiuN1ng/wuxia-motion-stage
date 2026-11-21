import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';

import { createStaticRangeMiddleware } from '../../vite.config.js';
import {
  STATIC_ASSET_CATALOG,
  mergeManifestWithCatalog,
  findAssetInCatalog,
  populateAssetSelectElement,
  resolveMotionProvenance,
} from '../../src/ui/AssetLibraryCatalog.js';

const BVH_LIB_DIR = '/home/antigravity/bvh_library';
const REF_VIDEOS_DIR = '/home/antigravity/reference_videos';

function runMiddlewareRequest(middleware, { method = 'GET', url, headers = {} }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const resHeaders = new Map();
    let nextCalled = false;

    const req = {
      method,
      url,
      headers,
      on() {},
    };

    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (k, v) => resHeaders.set(k.toLowerCase(), String(v));
    res.getHeader = (k) => resHeaders.get(k.toLowerCase());
    const origEnd = res.end.bind(res);
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      origEnd(() => {
        resolve({
          statusCode: res.statusCode,
          headers: Object.fromEntries(resHeaders.entries()),
          body: Buffer.concat(chunks),
          nextCalled,
        });
      });
    };

    res.on('finish', () => {
      resolve({
        statusCode: res.statusCode,
        headers: Object.fromEntries(resHeaders.entries()),
        body: Buffer.concat(chunks),
        nextCalled,
      });
    });
    res.on('error', reject);

    middleware(req, res, () => {
      nextCalled = true;
      resolve({
        statusCode: null,
        headers: {},
        body: Buffer.alloc(0),
        nextCalled: true,
      });
    });
  });
}

test('Contract 4: vite.config.js static range middleware serves 200, 206 Partial Content, 416, 404, and 403', async () => {
  const mw = createStaticRangeMiddleware([
    ['/bvh_library/', BVH_LIB_DIR],
    ['/reference_videos/', REF_VIDEOS_DIR],
  ]);

  // 1. Unrelated path delegates to next()
  const passThrough = await runMiddlewareRequest(mw, { url: '/src/main.js' });
  assert.equal(passThrough.nextCalled, true);

  // 2. UTF-8 Chinese BVH file returns 200 OK with HIERARCHY content
  const bvhUrl = encodeURI('/bvh_library/B_cleaned_ready/01_wuxia_idle_待机呼吸_cleaned.bvh');
  const fullBvh = await runMiddlewareRequest(mw, { url: bvhUrl });
  assert.equal(fullBvh.statusCode, 200);
  assert.equal(fullBvh.headers['accept-ranges'], 'bytes');
  assert.ok(fullBvh.body.toString('utf8').startsWith('HIERARCHY'));

  // 3. Video HTTP 206 Partial Content Range: bytes=0-1023
  const videoUrl = encodeURI(
    '/reference_videos/02_太白无痕剑意_世界冠军李昕豫_独立提膝云剑_720p.mp4'
  );
  const rangeRes = await runMiddlewareRequest(mw, {
    url: videoUrl,
    headers: { range: 'bytes=0-1023' },
  });
  assert.equal(rangeRes.statusCode, 206);
  assert.equal(rangeRes.headers['content-type'], 'video/mp4');
  assert.equal(rangeRes.headers['content-length'], '1024');
  assert.match(rangeRes.headers['content-range'], /^bytes 0-1023\/\d+$/);
  assert.equal(rangeRes.body.length, 1024);

  // 4. Suffix range bytes=-256
  const suffixRes = await runMiddlewareRequest(mw, {
    url: videoUrl,
    headers: { range: 'bytes=-256' },
  });
  assert.equal(suffixRes.statusCode, 206);
  assert.equal(suffixRes.body.length, 256);

  // 5. Invalid range -> 416 Range Not Satisfiable
  const invalidRange = await runMiddlewareRequest(mw, {
    url: videoUrl,
    headers: { range: 'bytes=999999999-9999999999' },
  });
  assert.equal(invalidRange.statusCode, 416);

  // 6. Missing file inside /bvh_library/ MUST return explicit 404 (never SPA fallback nextCalled)
  const missing = await runMiddlewareRequest(mw, {
    url: '/bvh_library/C_taibai_extracted/__nonexistent_test__.bvh',
  });
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.statusCode, 404);

  // 7. Path traversal ../ and %2e%2e%2f MUST return 403 Forbidden
  const trav1 = await runMiddlewareRequest(mw, {
    url: '/bvh_library/../motion-stage/package.json',
  });
  assert.equal(trav1.statusCode, 403);

  const trav2 = await runMiddlewareRequest(mw, {
    url: '/reference_videos/%2e%2e%2fmotion-stage%2fpackage.json',
  });
  assert.equal(trav2.statusCode, 403);
  void path;
});

test('F9 & Contract 2: AssetLibraryCatalog covers presets, clear demos, 01b-09 videos, B_cleaned_ready 01-15, and C_taibai_extracted', () => {
  const presets = STATIC_ASSET_CATALOG.filter((x) => x.category === 'presets');
  const clearDemos = STATIC_ASSET_CATALOG.filter((x) => x.category === 'clear_demos');
  const videos = STATIC_ASSET_CATALOG.filter((x) => x.category === 'videos');
  const bCleaned = STATIC_ASSET_CATALOG.filter((x) => x.category === 'b_cleaned');
  const cTaibai = STATIC_ASSET_CATALOG.filter((x) => x.category === 'c_taibai');

  assert.equal(presets.length, 4);
  assert.equal(clearDemos.length, 4);
  assert.equal(videos.length, 9);
  assert.equal(bCleaned.length, 22); // 01..06 (6) + 07 8-way (8) + 08..15 (8) = 22!
  assert.equal(cTaibai.length, 4);

  // Verify clear demo BVH entries carry synchronized reference video URLs
  for (const item of clearDemos) {
    assert.ok(item.path?.startsWith('/demo/clear_captures/'));
    assert.ok(item.sourceVideoUrl?.startsWith('/reference_videos/'));
  }

  // Verify video:05 has pre-configured fast-sword Wushu slice [26.72, 31.77]
  const v05 = findAssetInCatalog(STATIC_ASSET_CATALOG, 'video:05');
  assert.ok(v05);
  assert.equal(v05.defaultTrimIn, 26.72);
  assert.equal(v05.defaultTrimOut, 31.77);

  // Verify C_taibai_extracted entries carry fallbackVideoUrl
  for (const item of cTaibai) {
    assert.ok(item.fallbackVideoUrl?.startsWith('/reference_videos/'));
  }

  // Merge MANIFEST.json (both object.clips and array forms) without duplicating existing paths
  const merged = mergeManifestWithCatalog({
    clips: [
      {
        id: 'taibai_03_雨落云飞_快剑五连斩_cleaned',
        category: 'C_taibai_extracted',
        path: 'C_taibai_extracted/taibai_03_雨落云飞_快剑五连斩_cleaned.bvh',
        frames: 123,
        fps: 24,
        cyclic: false,
        hasWeapon: true,
      },
      {
        id: '99_custom_bonus',
        category: 'B_cleaned_ready',
        label: '99 额外测试招式',
        path: '/bvh_library/B_cleaned_ready/99_custom_bonus.bvh',
        frames: 60,
        fps: 60,
        cyclic: false,
      },
    ],
  });

  assert.equal(merged.length, STATIC_ASSET_CATALOG.length + 1);
  const t03 = findAssetInCatalog(merged, 'c_bvh:taibai_03');
  assert.equal(t03.frames, 123);
  assert.equal(t03.manifestVerified, true);

  // Test DOM select population via minimal mock element
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        value: '',
        label: '',
        textContent: '',
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };
  try {
    const mockSelect = {
      value: '',
      children: [],
      set innerHTML(_v) {
        this.children = [];
      },
      appendChild(c) {
        this.children.push(c);
      },
    };
    populateAssetSelectElement(mockSelect, merged, 'c_bvh:taibai_03');
    // 1 placeholder + 5 optgroups
    assert.equal(mockSelect.children.length, 6);
    assert.equal(mockSelect.value, 'c_bvh:taibai_03');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Motion provenance classifier distinguishes AI video extraction vs open-source mocap (MakeHuman & CMU)', () => {
  for (const item of STATIC_ASSET_CATALOG) {
    const prov = resolveMotionProvenance({
      clipKey: item.presetKey || item.id,
      clipId: item.id,
      clipName: item.label,
      path: item.path || '',
      category: item.category,
      kind: item.kind,
    });
    if (item.category === 'c_taibai' || item.category === 'videos' || item.category === 'clear_demos') {
      assert.equal(prov.originGroup, 'ai_extracted', `${item.id} should be ai_extracted`);
      assert.equal(prov.tagShort, 'AI提取');
    } else {
      assert.equal(prov.originGroup, 'open_mocap', `${item.id} should be open_mocap`);
      assert.ok(prov.tagShort === '开源·CMU' || prov.tagShort === '开源·MH', `Unexpected tag ${prov.tagShort}`);
    }
  }

  assert.equal(resolveMotionProvenance({ clipId: 'taibai_02' }).originGroup, 'ai_extracted');
  assert.equal(resolveMotionProvenance({ clipId: 'clear_bvh:06_roundhouse_kick' }).originGroup, 'ai_extracted');
  assert.equal(resolveMotionProvenance({ clipId: 'combo_1' }).tagShort, '开源·MH');
  assert.equal(resolveMotionProvenance({ clipId: '07_strafe_F' }).tagShort, '开源·CMU');
  assert.equal(resolveMotionProvenance({ originKind: 'video_capture', clipName: 'demo.mp4' }).originGroup, 'ai_extracted');
  assert.equal(resolveMotionProvenance({ originKind: 'bvh_upload', clipName: 'custom.bvh' }).originGroup, 'custom_bvh');
});

