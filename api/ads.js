// One function for everything campaign related (Vercel Hobby allows 12 functions, so routes share this file).
// Public routes (see vercel.json rewrites):
//   POST /api/serve        campaigns for one authorized site
//   POST /api/events       impression, click and close counts
//   GET  /api/site-config  public studio info (links, games, status)
// Admin routes:
//   GET/POST /api/admin/ads, GET /api/activity
const { isAdmin } = require('../lib/auth');
const { loadDevlog } = require('../lib/devlog');
const { GAMES, HttpError } = require('../lib/validate');
const ads = require('../lib/ads');

function fail(res, err) {
  if (!(err instanceof HttpError)) console.error('[ads]', err);
  const status = err.status || 500;
  return res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
}

async function serve(req, res) {
  const origin = ads.callerOrigin(req);
  if (req.method === 'OPTIONS') { ads.applyCors(req, res, origin); return res.status(204).end(); }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).end(); }
  try {
    const body = ads.readBody(req);
    if (ads.rateLimited(`serve|${ads.clientIp(req)}|${body.site}`, 60)) throw new HttpError(429, 'Too many requests');
    const { site, origin: allowed } = await ads.authorize(req, body.site, body.token);
    ads.applyCors(req, res, allowed);
    const lang = String(body.lang || 'en').slice(0, 2).toLowerCase();
    const device = ['mobile', 'tablet', 'desktop'].includes(body.device) ? body.device : 'desktop';
    const path = String(body.path || '/').slice(0, 200);
    const campaigns = await ads.campaignsFor(site, { lang, device, path: path.startsWith('/') ? path : '/' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ v: 1, ttl: 300, campaigns });
  } catch (err) {
    if (err.status === 403) ads.applyCors(req, res, ''); // no CORS header for denied callers
    return fail(res, err);
  }
}

async function events(req, res) {
  const origin = ads.callerOrigin(req);
  if (req.method === 'OPTIONS') { ads.applyCors(req, res, origin); return res.status(204).end(); }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).end(); }
  try {
    const body = ads.readBody(req);
    if (ads.rateLimited(`events|${ads.clientIp(req)}|${body.site}`, 120)) throw new HttpError(429, 'Too many requests');
    const { site, origin: allowed } = await ads.authorize(req, body.site, body.token);
    ads.applyCors(req, res, allowed);
    if (!ads.EVENT_TYPES.includes(body.type)) throw new HttpError(400, 'Unknown event');
    const config = await ads.loadConfig();
    const campaign = config.campaigns.find(c => c.id === body.campaign);
    if (!campaign || !(campaign.sites || []).includes(site.id)) throw new HttpError(400, 'Unknown campaign');
    ads.record(campaign.id, site.id, body.type);
    await ads.flushStats();
    return res.status(204).end();
  } catch (err) {
    return fail(res, err);
  }
}

async function siteConfig(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD, OPTIONS'); return res.status(405).end(); }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  let games = GAMES.map(g => ({ slug: g.slug, name: g.name, description: g.description, status: g.status }));
  let degraded = false;
  try {
    const data = await loadDevlog();
    games = data.games.map(g => ({ slug: g.slug, name: g.name, description: g.description, status: g.status }));
  } catch (err) {
    degraded = true;
    console.error('[site-config] using default games', err);
  }
  return res.status(200).json({
    studio: {
      name: 'Monocross Studios',
      tagline: 'Fast, raw games made by a small team.',
      links: { discord: ads.OFFICIAL.discord.url, tiktok: ads.OFFICIAL.tiktok.url, tiktok_handle: ads.OFFICIAL.tiktok.handle },
    },
    games,
    status: { ok: true, degraded },
  });
}

function mask(site) {
  return { ...site };
}

// Admin only: recent admin actions (never part of the public devlog).
async function activity(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });
  try {
    const data = await loadDevlog();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ activity: data.activity.slice(0, 50) });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not load activity. Try again in a moment.' });
  }
}

async function admin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });
  try {
    if (req.method === 'GET') {
      const [config, stats] = await Promise.all([ads.loadConfig(), ads.loadStats()]);
      return res.status(200).json({ sites: [ads.ownSite(), ...config.sites].map(mask), campaigns: config.campaigns, stats, official: ads.OFFICIAL });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).end(); }
    const body = ads.readBody(req);
    const config = await ads.loadConfig();
    const copy = { sites: [...config.sites], campaigns: config.campaigns.map(c => ({ ...c })) };
    const siteIndex = id => copy.sites.findIndex(s => s.id === id);
    const campIndex = id => copy.campaigns.findIndex(c => c.id === id);
    let result = {};

    switch (body.action) {
      case 'site.save': {
        const i = siteIndex(String(body.site && body.site.id || '').toLowerCase());
        const site = ads.cleanSite(body.site, i >= 0 ? copy.sites[i] : null);
        if (i >= 0) copy.sites[i] = site; else copy.sites.push(site);
        result = { site };
        break;
      }
      case 'site.rotate': {
        const i = siteIndex(body.id);
        if (i < 0) throw new HttpError(404, 'Unknown site');
        copy.sites[i] = { ...copy.sites[i], token: ads.newToken() };
        result = { site: copy.sites[i] };
        break;
      }
      case 'site.delete': {
        if (siteIndex(body.id) < 0) throw new HttpError(404, 'Unknown site');
        copy.sites.splice(siteIndex(body.id), 1);
        copy.campaigns.forEach(c => { c.sites = (c.sites || []).filter(s => s !== body.id); });
        break;
      }
      case 'campaign.save': {
        const campaign = ads.cleanCampaign(body.campaign);
        const known = new Set([ads.OWN_SITE_ID, ...copy.sites.map(s => s.id)]);
        campaign.sites = campaign.sites.filter(s => known.has(s));
        const i = campIndex(campaign.id);
        if (i >= 0) copy.campaigns[i] = campaign; else copy.campaigns.push(campaign);
        result = { campaign };
        break;
      }
      case 'campaign.toggle': {
        const i = campIndex(body.id);
        if (i < 0) throw new HttpError(404, 'Unknown campaign');
        copy.campaigns[i].active = body.active === true;
        break;
      }
      case 'campaign.delete': {
        if (campIndex(body.id) < 0) throw new HttpError(404, 'Unknown campaign');
        // Official campaigns come back as defaults, so deleting them just turns them off.
        const def = ads.DEFAULT_CAMPAIGNS.some(c => c.id === body.id);
        if (def) copy.campaigns[campIndex(body.id)].active = false; else copy.campaigns.splice(campIndex(body.id), 1);
        break;
      }
      default:
        throw new HttpError(400, 'Unknown action');
    }
    await ads.saveConfig(copy);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const op = String((req.query && req.query.op) || '');
  if (op === 'serve') return serve(req, res);
  if (op === 'events') return events(req, res);
  if (op === 'site-config') return siteConfig(req, res);
  if (op === 'admin') return admin(req, res);
  if (op === 'activity') return activity(req, res);
  return res.status(404).json({ error: 'Not found' });
};
