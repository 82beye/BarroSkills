import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardServer, readIntelSummary } from '../tools/board/server.js';

const FIXTURE = {
  schema_version: 1,
  date: '2026-08-13',
  generated_at: '2026-08-13T05:22:41.118Z',
  channel_count: 6,
  degraded: null,
  content_gaps: [
    { term: '국채 경매', gap_score: 2.1, comp_df: 2, comp_views: 900000, own_tf: 0,
      evidence: [{ videoId: 'abc', channel: '슈카월드', views: 500000 }] },
  ],
  outliers: [
    { videoId: 'xyz', title: '대박 영상', channel: '소수몽키', multiple: 4.2,
      views: 412000, thumbnail: 'https://i.ytimg.com/x.jpg', length_bucket: 'mid' },
  ],
  blue_ocean_keywords: [{ keyword: '세레브라스', score: 0.83, competition: 0.17 }],
  patterns: {
    title_features: [{ feature: 'has_bracket', lift: 1.63, direction: 'positive', n_with: 55, n_without: 153 }],
    length: { recommendation: 'xlong' },
    upload_hour_kst: { best_hours: [9, 17, 6] },
    slot_alignment: { 'us-close': { our_publish_kst: 8, verdict: 'shift_candidate' } },
  },
  channel_summary: [
    { id: 'syukaworld', name: '슈카월드', subscribers: 3720000, subscriber_delta_7d: null,
      uploads_7d: 7, median_vpd_30d: 32100 },
  ],
};

// async 콜백을 반드시 await 한다 — 동기 finally 로 지우면 HTTP 테스트가
// 요청을 보내기도 전에 픽스처 디렉토리가 사라진다.
async function withIntelDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bt-intel-'));
  try {
    writeFileSync(join(dir, 'analysis-2026-08-13.json'), JSON.stringify(FIXTURE));
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withServer(intelRoot, fn) {
  const { server, token } = createBoardServer({ intelRoot, port: 8999 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, token);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('readIntelSummary rejects path traversal in the date parameter', async () => {
  await withIntelDir((dir) => {
    assert.throws(() => readIntelSummary(dir, '../../../etc/passwd'), /INVALID_DATE|올바르지/);
    assert.throws(() => readIntelSummary(dir, '2026-08-13/../../x'), /INVALID_DATE|올바르지/);
    assert.throws(() => readIntelSummary(dir, 'latest'), /INVALID_DATE|올바르지/);
  });
});

test('readIntelSummary returns available:false instead of throwing when absent', async () => {
  await withIntelDir((dir) => {
    const r = readIntelSummary(dir, '1999-01-01');
    assert.equal(r.available, false);
    assert.ok(r.reason);
  });
});

test('readIntelSummary picks the newest analysis when no date is given', async () => {
  await withIntelDir((dir) => {
    writeFileSync(join(dir, 'analysis-2026-08-01.json'), JSON.stringify({ ...FIXTURE, date: '2026-08-01' }));
    assert.equal(readIntelSummary(dir, null).date, '2026-08-13');
  });
});

test('readIntelSummary projects only the fields the panel renders', async () => {
  await withIntelDir((dir) => {
    const r = readIntelSummary(dir, '2026-08-13');
    assert.equal(r.available, true);
    assert.equal(r.channel_count, 6);
    assert.equal(r.content_gaps[0].term, '국채 경매');
    assert.equal(r.outliers[0].multiple, 4.2);
    assert.equal(r.blue_ocean[0].keyword, '세레브라스');
    assert.equal(r.length_recommendation, 'xlong');
    assert.deepEqual(r.best_hours, [9, 17, 6]);
    assert.equal(r.title_features[0].feature, 'has_bracket');
    // 원본 전체를 흘려보내지 않는다
    assert.equal(r.schema_version, undefined);
    assert.equal(r.related_terms, undefined);
  });
});

test('GET /api/intel/competitors serves the summary without a mutation token', async () => {
  await withIntelDir(async (dir) => {
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/intel/competitors?date=2026-08-13`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.available, true);
      assert.equal(body.channels[0].name, '슈카월드');
    });
  });
});

test('GET /api/intel/competitors rejects a malformed date with 400', async () => {
  await withIntelDir(async (dir) => {
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/intel/competitors?date=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'INVALID_DATE');
    });
  });
});

test('GET /api/intel/competitors stays 200 when the analysis is missing', async () => {
  await withIntelDir(async (dir) => {
    await withServer(dir, async (base) => {
      const res = await fetch(`${base}/api/intel/competitors?date=1999-01-01`);
      assert.equal(res.status, 200, 'a not-yet-collected day is not an error');
      assert.equal((await res.json()).available, false);
    });
  });
});
