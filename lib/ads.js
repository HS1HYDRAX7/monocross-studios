// Popup and ad campaigns: storage, validation, origin checks, rate limits and eligibility.
// Server code only. Campaign text is never treated as HTML: the embed renders it with textContent.
const crypto = require('crypto');
const storage = require('./storage');
const { HttpError } = require('./validate');

const CONFIG_FILE = 'ads.json';
const STATS_FILE = 'ads-stats.json';

// Official channels. The Discord and TikTok campaigns can only ever point here.
const OFFICIAL = {
  discord: { url: 'https://discord.gg/kGgzurahuG' },
  tiktok: { url: 'https://www.tiktok.com/@monocross_studios', handle: '@monocross_studios' },
};

const OWN_SITE_ID = 'monocross';
const OWN_SITE_TOKEN = 'pk_monocross_site';
const KINDS = ['institutional', 'ad'];
const TEMPLATES = ['discord', 'tiktok', 'promo'];
const PLACEMENTS = ['modal', 'corner', 'banner', 'inline'];
const SIZES = ['small', 'medium', 'large'];
const DEVICES = ['mobile', 'tablet', 'desktop'];
const EVENT_TYPES = ['impression', 'click', 'close'];
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

const DEFAULT_CAMPAIGNS = [
  {
    id: 'official-discord', kind: 'institutional', template: 'discord', placement: 'corner', size: 'medium',
    title: 'Join the Monocross Discord',
    body: 'Talk to the team, get updates first and tell us what to fix next.',
    cta: 'Join the server', url: OFFICIAL.discord.url, handle: '', image: '',
    active: true, priority: 90, start: '', end: '',
    frequency: { delay_ms: 8000, scroll_pct: 0, session_cap: 1, dismiss_days: 7, click_days: 90 },
    targeting: { languages: [], devices: [], paths: [] }, sites: [OWN_SITE_ID],
  },
  {
    id: 'official-tiktok', kind: 'institutional', template: 'tiktok', placement: 'corner', size: 'medium',
    title: 'Follow us on TikTok',
    body: 'Dev clips and sneak peeks at @monocross_studios.',
    cta: 'Open TikTok', url: OFFICIAL.tiktok.url, handle: OFFICIAL.tiktok.handle, image: '',
    active: true, priority: 80, start: '', end: '',
    frequency: { delay_ms: 20000, scroll_pct: 40, session_cap: 1, dismiss_days: 7, click_days: 90 },
    targeting: { languages: [], devices: [], paths: [] }, sites: [OWN_SITE_ID],
  },
];

// ---------- Validation helpers ----------

function text(value, label, max, { required = false } = {}) {
  const out = String(value == null ? '' : value).replace(/[-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !out) throw new HttpError(400, `${label} is required`);
  if (out.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return out;
}

// Only https links. A site-relative /assets/ path is allowed for images (the embed resolves it against the API host).
function link(value, label, { allowAssetPath = false } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (raw.length > 300) throw new HttpError(400, `${label} is too long`);
  if (allowAssetPath && /^\/assets\/[A-Za-z0-9/_.-]+$/.test(raw) && !raw.includes('..')) return raw;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new HttpError(400, `${label} must be a full https:// link`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HttpError(400, `${label} must be a full https:// link`);
  return parsed.toString();
}

function pick(value, list, label, fallback) {
  const v = value == null || value === '' ? fallback : value;
  if (!list.includes(v)) throw new HttpError(400, `${label} must be one of: ${list.join(', ')}`);
  return v;
}

function int(value, label, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${label} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function list(value, allowed, label) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => String(v).trim().toLowerCase()).filter(Boolean))].slice(0, 20).map(v => {
    if (allowed && !allowed.includes(v)) throw new HttpError(400, `${label}: "${v}" is not allowed`);
    return v;
  });
}

function dateOrEmpty(value, label) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${label} is not a valid date`);
  return d.toISOString();
}

function cleanCampaign(input) {
  const c = input || {};
  const id = String(c.id || '').trim().toLowerCase();
  if (!ID.test(id)) throw new HttpError(400, 'Campaign id: 2 to 40 characters, lowercase letters, numbers and dashes');
  const template = pick(c.template, TEMPLATES, 'Template', 'promo');
  const official = OFFICIAL[template];
  const kind = official ? 'institutional' : pick(c.kind, KINDS, 'Kind', 'ad');
  const f = c.frequency || {};
  const t = c.targeting || {};
  const out = {
    id, kind, template,
    placement: pick(c.placement, PLACEMENTS, 'Placement', 'corner'),
    size: pick(c.size, SIZES, 'Size', 'medium'),
    title: text(c.title, 'Title', 60, { required: true }),
    body: text(c.body, 'Text', 160),
    cta: text(c.cta, 'Button label', 24, { required: true }),
    url: official ? official.url : link(c.url, 'Link'),
    handle: official && official.handle ? official.handle : text(c.handle, 'Handle', 40),
    image: link(c.image, 'Image', { allowAssetPath: true }),
    active: c.active === true,
    priority: int(c.priority, 'Priority', 0, 100, 50),
    start: dateOrEmpty(c.start, 'Start'),
    end: dateOrEmpty(c.end, 'End'),
    frequency: {
      delay_ms: int(f.delay_ms, 'Delay', 0, 120000, 8000),
      scroll_pct: int(f.scroll_pct, 'Scroll', 0, 100, 0),
      session_cap: int(f.session_cap, 'Per session', 1, 5, 1),
      dismiss_days: int(f.dismiss_days, 'Days hidden after close', 1, 365, 7),
      click_days: int(f.click_days, 'Days hidden after click', 1, 365, 90),
    },
    targeting: {
      languages: list(t.languages, null, 'Languages').filter(v => /^[a-z]{2}$/.test(v)),
      devices: list(t.devices, DEVICES, 'Devices'),
      paths: list(t.paths, null, 'Paths').filter(v => /^\/[a-z0-9/_.-]{0,80}$/.test(v)),
    },
    sites: list(c.sites, null, 'Sites').filter(v => ID.test(v)),
  };
  if (out.kind === 'ad' && !out.url) throw new HttpError(400, 'An ad needs a link');
  if (out.start && out.end && out.end <= out.start) throw new HttpError(400, 'End must be after start');
  return out;
}

function cleanSite(input, existing) {
  const s = input || {};
  const id = String((existing && existing.id) || s.id || '').trim().toLowerCase();
  if (!ID.test(id)) throw new HttpError(400, 'Site id: 2 to 40 characters, lowercase letters, numbers and dashes');
  if (id === OWN_SITE_ID && !existing) throw new HttpError(400, 'That id is reserved');
  const domains = list(s.domains, null, 'Domains').map(d => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  for (const d of domains) {
    if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(d) && d !== 'localhost') throw new HttpError(400, `"${d}" is not a valid domain`);
  }
  if (!domains.length) throw new HttpError(400, 'Add at least one allowed domain');
  return {
    id,
    name: text(s.name, 'Name', 60, { required: true }),
    token: (existing && existing.token) || newToken(),
    domains,
    enabled: s.enabled !== false,
    allow_kinds: list(s.allow_kinds, KINDS, 'Allowed kinds').length ? list(s.allow_kinds, KINDS, 'Allowed kinds') : ['institutional', 'ad'],
    created: (existing && existing.created) || new Date().toISOString(),
  };
}

function newToken() {
  return 'pk_' + crypto.randomBytes(16).toString('hex');
}

// ---------- Storage ----------

let configCache = null;
async function loadConfig() {
  if (configCache && Date.now() - configCache.at < 30000) return configCache.value;
  const value = await readConfig();
  configCache = { at: Date.now(), value };
  return value;
}

async function readConfig() {
  const stored = (await storage.readJson(CONFIG_FILE)) || {};
  const storedCampaigns = Array.isArray(stored.campaigns) ? stored.campaigns : [];
  const ids = new Set(storedCampaigns.map(c => c.id));
  const campaigns = [...storedCampaigns, ...DEFAULT_CAMPAIGNS.filter(c => !ids.has(c.id))];
  const sites = Array.isArray(stored.sites) ? stored.sites : [];
  return { sites, campaigns };
}

async function saveConfig(config) {
  configCache = null;
  await storage.uploadBytes(CONFIG_FILE, JSON.stringify({ sites: config.sites, campaigns: config.campaigns }, null, 2), 'application/json');
}

// Built-in site for monocross-studios itself. Extra domains come from the SITE_ORIGINS variable (comma separated).
function ownSite() {
  const extra = String(process.env.SITE_ORIGINS || '').split(',').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  const domains = ['monocross-studios.vercel.app', ...extra];
  if (process.env.ALLOW_LOCALHOST === '1') domains.push('localhost');
  return { id: OWN_SITE_ID, name: 'Monocross Studios (official site)', token: OWN_SITE_TOKEN, domains, enabled: true, allow_kinds: KINDS, builtin: true };
}

// ---------- Origin, token and rate limit ----------

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function domainAllowed(host, domains) {
  if (!host) return false;
  return domains.some(d => (d.startsWith('*.') ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d));
}

// Origin of the calling page. Same-origin requests may omit Origin, so Referer is the fallback.
function callerOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return origin;
  const referer = req.headers.referer;
  if (referer) { try { return new URL(referer).origin; } catch { /* ignore */ } }
  return '';
}

function tokenEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Returns the site when id, token and calling domain all match. Throws 403 otherwise, with one generic message.
async function authorize(req, siteId, token) {
  const origin = callerOrigin(req);
  const id = String(siteId || '').toLowerCase();
  let site = id === OWN_SITE_ID ? ownSite() : null;
  if (!site) {
    const config = await loadConfig();
    site = config.sites.find(s => s.id === id) || null;
  }
  const ok = site && site.enabled && tokenEqual(site.token, token) && domainAllowed(hostOf(origin), site.domains);
  if (!ok) throw new HttpError(403, 'This site is not allowed to show campaigns');
  return { site, origin };
}

function applyCors(req, res, origin) {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

const buckets = new Map();
function rateLimited(key, max, windowMs = 60000) {
  const now = Date.now();
  if (buckets.size > 5000) buckets.clear();
  const b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { buckets.set(key, { start: now, count: 1 }); return false; }
  b.count += 1;
  return b.count > max;
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Body can arrive as an object (JSON) or a string (text/plain, used to avoid CORS preflights).
function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try { return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : String(b || '{}')); } catch { throw new HttpError(400, 'Invalid request body'); }
}

// ---------- Eligibility ----------

function eligible(campaign, site, ctx, now = Date.now()) {
  if (!campaign.active) return false;
  if (!(campaign.sites || []).includes(site.id)) return false;
  if (!(site.allow_kinds || KINDS).includes(campaign.kind)) return false;
  if (campaign.start && now < Date.parse(campaign.start)) return false;
  if (campaign.end && now > Date.parse(campaign.end)) return false;
  const t = campaign.targeting || {};
  if (t.languages && t.languages.length && !t.languages.includes(ctx.lang)) return false;
  if (t.devices && t.devices.length && !t.devices.includes(ctx.device)) return false;
  if (t.paths && t.paths.length && !t.paths.some(p => ctx.path.startsWith(p))) return false;
  return true;
}

function publicShape(c) {
  return {
    id: c.id, kind: c.kind, template: c.template, placement: c.placement, size: c.size,
    title: c.title, body: c.body, cta: c.cta, url: c.url, handle: c.handle || '', image: c.image || '',
    priority: c.priority, frequency: c.frequency,
  };
}

async function campaignsFor(site, ctx) {
  const config = await loadConfig();
  return config.campaigns.filter(c => eligible(c, site, ctx)).sort((a, b) => b.priority - a.priority).slice(0, 5).map(publicShape);
}

// ---------- Stats ----------
// Counts are buffered in memory and written in batches. A function instance that is frozen can lose a few counts.

let pending = {};
let pendingCount = 0;
let lastFlush = 0;

function record(campaign, siteId, type, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const key = `${campaign}|${siteId}|${day}|${type}`;
  pending[key] = (pending[key] || 0) + 1;
  pendingCount += 1;
}

async function flushStats(force = false) {
  if (!pendingCount) return;
  if (!force && pendingCount < 10 && Date.now() - lastFlush < 20000) return;
  const batch = pending;
  pending = {};
  pendingCount = 0;
  lastFlush = Date.now();
  try {
    const stored = (await storage.readJson(STATS_FILE)) || { days: {} };
    for (const [key, n] of Object.entries(batch)) {
      const [campaign, site, day, type] = key.split('|');
      const d = (stored.days[day] = stored.days[day] || {});
      const k = `${campaign}|${site}`;
      d[k] = d[k] || { impression: 0, click: 0, close: 0 };
      d[k][type] += n;
    }
    const keep = Object.keys(stored.days).sort().slice(-90);
    stored.days = Object.fromEntries(keep.map(k => [k, stored.days[k]]));
    await storage.uploadBytes(STATS_FILE, JSON.stringify(stored), 'application/json');
  } catch (err) {
    console.error('[ads] could not save stats', err);
  }
}

async function loadStats() {
  await flushStats(true);
  const stored = (await storage.readJson(STATS_FILE)) || { days: {} };
  const totals = {};
  for (const day of Object.values(stored.days)) {
    for (const [k, v] of Object.entries(day)) {
      const [campaign, site] = k.split('|');
      const t = (totals[campaign] = totals[campaign] || { impression: 0, click: 0, close: 0, sites: {} });
      t.impression += v.impression; t.click += v.click; t.close += v.close;
      const s = (t.sites[site] = t.sites[site] || { impression: 0, click: 0, close: 0 });
      s.impression += v.impression; s.click += v.click; s.close += v.close;
    }
  }
  return totals;
}

module.exports = {
  OFFICIAL, OWN_SITE_ID, OWN_SITE_TOKEN, KINDS, TEMPLATES, PLACEMENTS, SIZES, EVENT_TYPES, DEFAULT_CAMPAIGNS,
  cleanCampaign, cleanSite, newToken, loadConfig, saveConfig, ownSite, hostOf, domainAllowed, callerOrigin,
  authorize, applyCors, rateLimited, clientIp, readBody, eligible, campaignsFor, record, flushStats, loadStats, link,
};
