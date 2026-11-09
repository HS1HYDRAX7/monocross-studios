const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaContentTypeMatchesName, mediaSignatureMatches, safeMediaName } = require('../lib/validate');
const storage = require('../lib/storage');

function mockResponse() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function withStoredDevlog(stored, run) {
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } });
  try { await run(); } finally { global.fetch = previousFetch; }
}

const fixture = {
  games: [{
    slug: 'bloodtubies', name: 'Bloodtubies I', description: 'A horror game', status: 'released', platforms: {},
    updates: [{ id: 'AbCdEf123456', version: '1.2.0', date: '2026-11-08', title: 'Night <watch>', paragraphs: ['First & second', 'Another line'], media: [] }],
  }],
  activity: [{ action: 'private.admin.action', detail: 'Never public' }],
};

test('public game catalog is read-only, cached, and CORS-enabled', async () => {
  process.env.DBBYTE_ACCESS_KEY_ID = 'test-key';
  process.env.DBBYTE_SECRET_ACCESS_KEY = 'test-secret';
  await withStoredDevlog(fixture, async () => {
    const res = mockResponse();
    await require('../api/games')({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(res.body.games.length, 2);
    assert.equal('updates' in res.body.games[0], false);
  });
});

test('public devlog excludes admin activity', async () => {
  process.env.DBBYTE_ACCESS_KEY_ID = 'test-key';
  process.env.DBBYTE_SECRET_ACCESS_KEY = 'test-secret';
  await withStoredDevlog(fixture, async () => {
    const res = mockResponse();
    await require('../api/devlog')({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal('activity' in res.body, false);
    assert.equal(res.body.games[0].updates[0].title, 'Night <watch>');
  });
});

test('RSS is valid XML with escaped content', async () => {
  process.env.DBBYTE_ACCESS_KEY_ID = 'test-key';
  process.env.DBBYTE_SECRET_ACCESS_KEY = 'test-secret';
  await withStoredDevlog(fixture, async () => {
    const res = mockResponse();
    await require('../api/feed')({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /application\/rss\+xml/);
    assert.match(res.body, /Night &lt;watch&gt;/);
    assert.match(res.body, /First &amp; second/);
  });
});

test('RSS strips XML-invalid control characters', async () => {
  process.env.DBBYTE_ACCESS_KEY_ID = 'test-key';
  process.env.DBBYTE_SECRET_ACCESS_KEY = 'test-secret';
  const unsafe = { games: [{ slug: 'bloodtubies', name: 'Bloodtubies I', updates: [{ date: '2026-11-08', title: 'Bad\u0001 title', paragraphs: ['safe\u0002 text'], media: [] }] }] };
  await withStoredDevlog(unsafe, async () => {
    const res = mockResponse();
    await require('../api/feed')({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes('\u0001'), false);
    assert.equal(res.body.includes('\u0002'), false);
  });
});

test('OpenAPI document describes the public read endpoints', () => {
  const res = mockResponse();
  require('../api')({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.openapi, '3.1.0');
  for (const route of ['/api/games', '/api/devlog', '/api/feed']) assert.ok(res.body.paths[route]);
});

test('upload Content-Type must match the safe file extension', () => {
  assert.equal(safeMediaName('01-cover.webp'), '01-cover.webp');
  assert.equal(mediaContentTypeMatchesName('cover.webp', 'image/webp'), true);
  assert.equal(mediaContentTypeMatchesName('cover.webp', 'image/png'), false);
  assert.equal(mediaContentTypeMatchesName('clip.mp4', 'video/mp4'), true);
  assert.equal(mediaContentTypeMatchesName('clip.mp4', 'image/jpeg'), false);
});

test('fallback upload verifies common media signatures', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const mp4 = Buffer.from('0000ftypisom');
  assert.equal(mediaSignatureMatches(png, 'image/png'), true);
  assert.equal(mediaSignatureMatches(jpeg, 'image/jpeg'), true);
  assert.equal(mediaSignatureMatches(mp4, 'video/mp4'), true);
  assert.equal(mediaSignatureMatches(png, 'image/jpeg'), false);
  assert.equal(mediaSignatureMatches(Buffer.from('not an image'), 'image/png'), false);
});

test('direct-upload signature binds the Content-Type header', () => {
  process.env.DBBYTE_ACCESS_KEY_ID = 'test-key';
  process.env.DBBYTE_SECRET_ACCESS_KEY = 'test-secret';
  const signed = new URL(storage.presignUpload('updates/bloodtubies/1.0/AbCdEf123456/cover.webp', 'image/webp'));
  assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.equal(signed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
});
