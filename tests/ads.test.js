const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../lib/storage');
const ads = require('../lib/ads');
const handler = require('../api/ads');

// In-memory stand-in for the bucket.
const files = {};
storage.readJson = async key => (files[key] ? JSON.parse(files[key]) : null);
storage.uploadBytes = async (key, body) => { files[key] = body; };

function res() {
  return { headers: {}, statusCode: 200, body: undefined,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; }, end() { return this; } };
}
function req(op, body, origin, extra = {}) {
  return { method: 'POST', query: { op }, headers: { origin, 'x-forwarded-for': extra.ip || '1.1.1.1' }, body: JSON.stringify(body) };
}
const OWN = 'https://monocross-studios.vercel.app';

test('official site gets the Discord and TikTok popups with the exact links', async () => {
  const r = res();
  await handler(req('serve', { site: 'monocross', token: 'pk_monocross_site', path: '/', lang: 'en', device: 'desktop' }, OWN), r);
  assert.equal(r.statusCode, 200);
  const urls = Object.fromEntries(r.body.campaigns.map(c => [c.id, c.url]));
  assert.equal(urls['official-discord'], 'https://discord.gg/kGgzurahuG');
  assert.equal(urls['official-tiktok'], 'https://www.tiktok.com/@monocross_studios');
  assert.equal(r.body.campaigns.find(c => c.id === 'official-tiktok').handle, '@monocross_studios');
  assert.equal(r.headers['Access-Control-Allow-Origin'], OWN);
});

test('wrong token, wrong domain or unknown site are denied without CORS', async () => {
  for (const [body, origin] of [
    [{ site: 'monocross', token: 'nope' }, OWN],
    [{ site: 'monocross', token: 'pk_monocross_site' }, 'https://evil.example'],
    [{ site: 'ghost', token: 'x' }, OWN],
    [{ site: 'monocross', token: 'pk_monocross_site' }, ''],
  ]) {
    const r = res();
    await handler(req('serve', body, origin, { ip: '2.2.2.' + Math.random() }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
  }
});

test('external site: whitelist, token and campaign assignment control what it receives', async () => {
  const site = ads.cleanSite({ id: 'partner', name: 'Partner', domains: ['partner.example', '*.blog.example'], allow_kinds: ['ad'] });
  const campaign = ads.cleanCampaign({ id: 'summer-ad', title: 'Play now', cta: 'Play', url: 'https://example.com/x', placement: 'inline', size: 'medium', active: true, sites: ['partner'] });
  files['ads.json'] = JSON.stringify({ sites: [site], campaigns: [campaign] });
  // loadConfig caches for 30 s, so force a fresh read
  await ads.saveConfig({ sites: [site], campaigns: [campaign] });

  let r = res();
  await handler(req('serve', { site: 'partner', token: site.token, lang: 'en', device: 'mobile', path: '/a' }, 'https://partner.example'), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.campaigns.map(c => c.id), ['summer-ad']); // not the Studio popups: not assigned and kind not allowed

  r = res();
  await handler(req('serve', { site: 'partner', token: site.token }, 'https://x.blog.example'), r);
  assert.equal(r.statusCode, 200);

  r = res();
  await handler(req('serve', { site: 'partner', token: site.token }, 'https://blog.example'), r);
  assert.equal(r.statusCode, 403); // *.blog.example does not cover the bare domain

  r = res();
  await handler(req('serve', { site: 'partner', token: site.token }, 'https://partner.example.evil.com'), r);
  assert.equal(r.statusCode, 403);
});

test('events are counted and validated', async () => {
  let r = res();
  await handler(req('events', { site: 'monocross', token: 'pk_monocross_site', campaign: 'official-discord', type: 'click' }, OWN), r);
  assert.equal(r.statusCode, 204);
  r = res();
  await handler(req('events', { site: 'monocross', token: 'pk_monocross_site', campaign: 'official-discord', type: 'hack' }, OWN), r);
  assert.equal(r.statusCode, 400);
  r = res();
  await handler(req('events', { site: 'monocross', token: 'pk_monocross_site', campaign: 'missing', type: 'click' }, OWN), r);
  assert.equal(r.statusCode, 400);
  const totals = await ads.loadStats();
  assert.equal(totals['official-discord'].click, 1);
});

test('rate limit stops floods', async () => {
  let last;
  for (let i = 0; i < 70; i++) {
    last = res();
    await handler(req('serve', { site: 'monocross', token: 'pk_monocross_site' }, OWN, { ip: '9.9.9.9' }), last);
  }
  assert.equal(last.statusCode, 429);
});

test('campaign validation blocks unsafe links and markup, and locks official links', () => {
  const base = { id: 'x1', title: 'T', cta: 'Go', url: 'https://ok.example', active: true };
  assert.throws(() => ads.cleanCampaign({ ...base, url: 'javascript:alert(1)' }), /https/);
  assert.throws(() => ads.cleanCampaign({ ...base, url: 'http://ok.example' }), /https/);
  assert.throws(() => ads.cleanCampaign({ ...base, image: 'data:image/png;base64,AAA' }), /https/);
  assert.equal(ads.cleanCampaign({ ...base, title: '<img src=x onerror=alert(1)>Hi' }).title.includes('<'), false);
  assert.equal(ads.cleanCampaign({ ...base, template: 'discord', url: 'https://evil.example' }).url, 'https://discord.gg/kGgzurahuG');
  assert.equal(ads.cleanCampaign({ ...base, template: 'tiktok', url: 'https://evil.example' }).url, 'https://www.tiktok.com/@monocross_studios');
});

test('schedule, targeting and activation are respected', () => {
  const site = { id: 'monocross', allow_kinds: ['institutional', 'ad'] };
  const ctx = { lang: 'en', device: 'desktop', path: '/' };
  const c = ads.DEFAULT_CAMPAIGNS[0];
  assert.equal(ads.eligible(c, site, ctx), true);
  assert.equal(ads.eligible({ ...c, active: false }, site, ctx), false);
  assert.equal(ads.eligible({ ...c, end: '2000-01-01T00:00:00.000Z' }, site, ctx), false);
  assert.equal(ads.eligible({ ...c, targeting: { languages: ['pt'], devices: [], paths: [] } }, site, ctx), false);
  assert.equal(ads.eligible({ ...c, targeting: { languages: [], devices: ['mobile'], paths: [] } }, site, ctx), false);
});

test('admin routes require login', async () => {
  const r = res();
  await handler({ method: 'GET', query: { op: 'admin' }, headers: {} }, r);
  assert.equal(r.statusCode, 401);
});
