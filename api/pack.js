// The whole server in one file. Vercel rewrites /api/<route> to this function with ?route=<route>.
// Sections: validation, admin sessions, storage (DBByte, S3 API), the devlog store, and the routes.
const crypto = require('crypto');

const MB = 1024 * 1024;
const FILE = 'devlog.json';
const ACTIVITY_LIMIT = 200;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const SESSION_MS = WEEK_SECONDS * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const SERVER_UPLOAD_MAX = 4 * MB;
const JSON_MAX = 64 * 1024;
// Routes that may be cached and read without the admin cookie. Everything else is no-store.
const PUBLIC_ROUTES = new Set(['devlog', 'embed', 'studio']);

// Storage. Endpoint, region and bucket are not secrets, so they live here. Only the two keys come from Vercel.
const STORE = { endpoint: 's3.dbbyte.com', region: 'us-east-1', service: 's3', bucket: 'monocross-studios' };

// Built-in games, added to devlog.json once. After that the admin manages them.
const SEED_GAMES = [
  { slug: 'bloodtubies', name: 'Bloodtubies I', description: 'Horror game inspired by Slendytubbies 3.', status: 'released' },
  { slug: 'decadent', name: 'Decadent', description: 'Asymmetric horror inspired by Dead by Daylight.', status: 'in_development' },
];

// ---------- Validation ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DIGITS_12 = /^\d{12}$/;
const UPDATE_CODE = /^[A-Za-z0-9]{12}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const VIDEO_EXTENSIONS = ['.mp4', '.webm'];

const isGameId = value => typeof value === 'string' && DIGITS_12.test(value);

function requireGameId(value) {
  if (!isGameId(value)) throw new HttpError(400, 'Game ID must be 12 digits');
  return value;
}

function randomDigits(length) {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10).toString();
  return out;
}

const isUpdateId = value => typeof value === 'string' && UPDATE_CODE.test(value);

function safeId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new HttpError(400, 'Invalid update code');
  return value;
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new HttpError(400, `${label} may only use letters, numbers, dots, dashes and underscores`);
  }
  return value;
}

function safeMediaName(value) {
  if (typeof value !== 'string' || !SAFE_FILE.test(value)) throw new HttpError(400, 'Invalid file name');
  return value;
}

const extensionOf = name => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

function mediaType(name) {
  return VIDEO_EXTENSIONS.includes('.' + extensionOf(name)) ? 'video' : 'image';
}

// Control characters are removed. Text is always shown as plain text, never as HTML.
function cleanText(value, label, max, { required = true } = {}) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (required && !text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return text;
}

// Links are only accepted as https://. Anything else (javascript:, data:, http:) is refused.
function cleanUrl(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    throw new HttpError(400, `${label} must be a full https:// address`);
  }
  if (url.protocol !== 'https:' || url.href.length > 500) throw new HttpError(400, `${label} must be an https:// address`);
  return url.href;
}

function cleanDay(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${label} must be YYYY-MM-DD`);
  return value;
}

function cleanStatus(value) {
  if (value !== 'released' && value !== 'in_development') throw new HttpError(400, 'Status must be released or in_development');
  return value;
}

// Storage paths must stay inside the prefix the caller owns. Blocks "../" tricks.
const isOwnedPath = (path, prefix) =>
  typeof path === 'string' && path.startsWith(prefix) && !path.includes('..') && !path.includes('\\');

// ---------- Admin session ----------

const COOKIE = '__Host-mc_admin';

function envValue(name) {
  return (process.env[name] || '').trim();
}

// Names of missing settings. Logged on the server only, never shown to visitors.
function configError() {
  const missing = ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'].filter(name => !envValue(name));
  return missing.length ? 'Missing on the server: ' + missing.join(', ') : null;
}

function sign(payload) {
  return crypto.createHmac('sha256', envValue('ADMIN_SESSION_SECRET')).update(payload).digest('hex');
}

// Cookie value: "<expiry in ms>.<signature>". The signature covers the expiry, so it cannot be extended.
function issueToken() {
  const expires = Date.now() + SESSION_MS;
  return `${expires}.${sign(`admin|${expires}`)}`;
}

function validToken(value) {
  const [expires, signature] = String(value || '').split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(`admin|${expires}`));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

const auth = {
  isAdmin(req) {
    if (configError()) return false;
    return validToken(readCookie(req.headers.cookie, COOKIE));
  },
};

function checkPassword(password) {
  const expected = envValue('ADMIN_PASSWORD');
  if (!expected || typeof password !== 'string') return false;
  const given = Buffer.from(password.trim());
  const real = Buffer.from(expected);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

// Best-effort throttle per client. Each serverless instance keeps its own count.
const failures = new Map();

function clientKey(req) {
  // The client can send any X-Forwarded-For it likes, but the proxy appends the real address at the end.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
  return chain[chain.length - 1] || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function tooManyAttempts(req) {
  const record = failures.get(clientKey(req));
  return Boolean(record) && Date.now() - record.first < FAILURE_WINDOW_MS && record.count >= MAX_FAILURES;
}

function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const record = failures.get(key);
  if (!record || now - record.first >= FAILURE_WINDOW_MS) {
    if (failures.size > 1000) failures.clear();
    failures.set(key, { count: 1, first: now });
  } else {
    record.count += 1;
  }
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${issueToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function assertAdmin(req) {
  if (!auth.isAdmin(req)) throw new HttpError(401, 'Log in first');
}

// ---------- Storage (DBByte, S3-compatible, signed with AWS SigV4) ----------

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const encodePath = key => key.split('/').map(encodeRfc3986).join('/');
const requestPath = key => (key ? `/${STORE.bucket}/${encodePath(key)}` : `/${STORE.bucket}/`);

function canonicalQuery(params) {
  return Object.keys(params).sort().map(name => `${encodeRfc3986(name)}=${encodeRfc3986(String(params[name]))}`).join('&');
}

// AWS Signature Version 4, as a pure function, so it can be checked against AWS's published example.
function sigv4({ method, host, path, query = '', headers, payloadHash, accessKeyId, secret, amzDate }) {
  const lower = {};
  for (const name of Object.keys(headers)) lower[name.toLowerCase()] = headers[name];
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map(name => `${name}:${String(lower[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${STORE.region}/${STORE.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), STORE.region), STORE.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return { signature, signedHeaders, scope };
}

function credentials() {
  const accessKeyId = envValue('DBBYTE_ACCESS_KEY_ID');
  const secret = envValue('DBBYTE_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secret) throw new Error('Missing DBBYTE_ACCESS_KEY_ID or DBBYTE_SECRET_ACCESS_KEY in Vercel');
  return { accessKeyId, secret };
}

const amzDateNow = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

async function s3Request(method, key, { query = {}, body = null, contentType } = {}) {
  const { accessKeyId, secret } = credentials();
  const amzDate = amzDateNow();
  const payloadHash = sha256(body == null ? '' : body);
  const headers = { host: STORE.endpoint, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const qs = canonicalQuery(query);
  const path = requestPath(key);
  const { signature, signedHeaders, scope } = sigv4({ method, host: STORE.endpoint, path, query: qs, headers, payloadHash, accessKeyId, secret, amzDate });
  const sent = { ...headers };
  delete sent.host;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(`https://${STORE.endpoint}${path}${qs ? '?' + qs : ''}`, { method, headers: sent, body: body == null ? undefined : body });
}

// A link that works without credentials, for a limited time (downloads and direct browser uploads).
function presign(method, key, seconds) {
  const { accessKeyId, secret } = credentials();
  const amzDate = amzDateNow();
  const path = requestPath(key);
  const base = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${amzDate.slice(0, 8)}/${STORE.region}/${STORE.service}/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(seconds, WEEK_SECONDS)),
    'X-Amz-SignedHeaders': 'host',
  };
  const qs = canonicalQuery(base);
  const { signature } = sigv4({ method, host: STORE.endpoint, path, query: qs, headers: { host: STORE.endpoint }, payloadHash: 'UNSIGNED-PAYLOAD', accessKeyId, secret, amzDate });
  return `https://${STORE.endpoint}${path}?${qs}&X-Amz-Signature=${signature}`;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', json: 'application/json' };

function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : null;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return text;
  }
}

// Stored media can be a full link (older updates) or a plain path. Both become the path in the bucket.
function mediaPath(src) {
  const text = String(src || '');
  const marker = '/file/';
  const at = text.indexOf(marker);
  if (at === -1) return safeDecode(text);
  const rest = text.slice(at + marker.length);
  return safeDecode(rest.slice(rest.indexOf('/') + 1).split('?')[0]);
}

// Every storage operation the app uses. Tests can swap these out through module.exports.__storage.
const storage = {
  async uploadBytes(key, content, contentType = 'application/octet-stream') {
    const response = await s3Request('PUT', key, { body: content, contentType });
    if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
  },

  async readJson(key) {
    const response = await s3Request('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Could not read ${key} (${response.status})`);
    return response.json();
  },

  async listFiles(prefix) {
    const files = [];
    let token = null;
    do {
      const query = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const response = await s3Request('GET', '', { query });
      if (!response.ok) throw new Error(`Storage listing failed (${response.status})`);
      const xml = await response.text();
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const fileName = xmlTag(item, 'Key');
        const ext = fileName.split('.').pop().toLowerCase();
        files.push({
          fileName,
          contentLength: Number(xmlTag(item, 'Size') || 0),
          contentType: MIME[ext] || 'application/octet-stream',
          uploadTimestamp: Date.parse(xmlTag(item, 'LastModified') || '') || 0,
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlTag(xml, 'NextContinuationToken') : null;
    } while (token);
    return files;
  },

  async deleteFile(file) {
    const key = typeof file === 'string' ? file : file.fileName;
    const response = await s3Request('DELETE', key);
    if (!response.ok && response.status !== 404) throw new Error(`Storage delete failed (${response.status})`);
  },

  signedUrl(key) {
    return presign('GET', key, WEEK_SECONDS);
  },

  presignUpload(key) {
    return presign('PUT', key, HOUR_SECONDS);
  },

  mediaPath,
};

// ---------- Upload planner: where a file may go, what it may be, how large it may be ----------

const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const VIDEOS = { mp4: 'video/mp4', webm: 'video/webm' };
const PURPOSES = {
  update: { types: { ...IMAGES, ...VIDEOS }, maxBytes: 50 * MB },
  banner: { types: { ...IMAGES, ...VIDEOS }, maxBytes: 50 * MB },
  ad: { types: IMAGES, maxBytes: 10 * MB },
};

function plan(purpose = 'update', params = {}) {
  const rule = PURPOSES[purpose];
  if (!rule) throw new HttpError(400, 'Unknown upload purpose');
  const name = safeMediaName(params.name);
  const type = rule.types[extensionOf(name)];
  if (!type) throw new HttpError(415, 'This file type is not allowed for this upload');
  let key;
  if (purpose === 'update') {
    const game = requireGameId(params.game);
    safeSegment(params.version, 'Version');
    if (!isUpdateId(params.updateId)) throw new HttpError(400, 'Update code is missing or invalid');
    key = `updates/${game}/${params.version}/${params.updateId}/${name}`;
  } else if (purpose === 'banner') {
    key = `games/${requireGameId(params.game)}/media-${Date.now()}-${randomDigits(4)}.${extensionOf(name)}`;
  } else {
    key = `ads/${randomDigits(12)}-${name}`;
  }
  return { key, type, maxBytes: rule.maxBytes };
}

// ---------- The devlog: games, updates, ads and activity in one file in the bucket ----------

function seedId(slug) {
  const hash = crypto.createHash('sha256').update('game:' + slug).digest();
  return String(hash.readBigUInt64BE(0) % 1000000000000n).padStart(12, '0');
}

const EMPTY_PLATFORM = { available: false, url: '', version: '' };

// Updates saved before update codes existed: their version is the key, and their files sit in updates/<slug>/<version>/.
function normalizeUpdate(update, slug) {
  return { ...update, id: update.id || update.version, folder: update.folder || `updates/${slug}/${update.version}` };
}

function normalizeGame(saved) {
  const platforms = saved.platforms || {};
  const legacyMedia = saved.banner ? [{ ...saved.banner, alt: saved.name + ' banner' }] : [];
  return {
    id: saved.id,
    slug: saved.slug,
    name: saved.name,
    description: saved.description || '',
    status: saved.status === 'in_development' ? 'in_development' : 'released',
    platforms: {
      windows: { ...EMPTY_PLATFORM, ...(platforms.windows || {}) },
      android: { ...EMPTY_PLATFORM, ...(platforms.android || {}) },
    },
    banner: saved.banner || null,
    media: (Array.isArray(saved.media) ? saved.media : legacyMedia).slice(0, 20),
    release: saved.release && typeof saved.release === 'object' ? saved.release : { type: 'tba' },
    updates: (saved.updates || []).map(update => normalizeUpdate(update, saved.slug)),
    editions: Array.isArray(saved.editions) ? saved.editions : [],
    // Launcher fields always have the full shape, even when older saved data is missing some of them.
    launcher: { supported: false, platforms: [], minimumRequirements: '', installSizeMb: null, downloadSizeMb: null, manifestUrl: '', ...(saved.launcher && typeof saved.launcher === 'object' ? saved.launcher : {}) },
  };
}

async function loadDevlog() {
  const stored = (await storage.readJson(FILE)) || {};
  const games = (Array.isArray(stored.games) ? stored.games : []).map(game => normalizeGame({ ...game, id: game.id || seedId(game.slug) }));
  // Built-in games are added only once. After that, a game deleted in the admin stays deleted.
  if (!stored.seeded) {
    for (const seed of SEED_GAMES) {
      if (games.some(game => game.slug === seed.slug)) continue;
      games.push(normalizeGame({ id: seedId(seed.slug), slug: seed.slug, name: seed.name, description: seed.description, status: seed.status, banner: null, updates: [] }));
    }
  }
  return {
    seeded: true,
    games,
    ads: Array.isArray(stored.ads) ? stored.ads : [],
    popups: popupsOrDefault(stored.popups),
    team: teamOrDefault(stored.team),
    site: siteOrDefault(stored.site),
    activity: Array.isArray(stored.activity) ? stored.activity : [],
  };
}

async function saveDevlog(data) {
  const out = { seeded: true, games: data.games, ads: data.ads || [], popups: data.popups || DEFAULT_POPUPS, team: data.team || DEFAULT_TEAM, site: data.site || DEFAULT_SITE, activity: data.activity || [] };
  await storage.uploadBytes(FILE, JSON.stringify(out, null, 2), 'application/json');
}

function logActivity(data, action, detail) {
  data.activity = [{ at: new Date().toISOString(), action, detail }, ...(data.activity || [])].slice(0, ACTIVITY_LIMIT);
}

// ---------- Request helpers ----------

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed);
  return res.status(405).end();
}

// Reads the body once. Upload requests keep the raw bytes; everything else is parsed as JSON.
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'The request is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'The request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new HttpError(400, 'The request body is not valid JSON');
  }
}

const cleanDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  return value;
};

function cleanParagraphs(body) {
  const paragraphs = String(body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) throw new HttpError(400, 'Write at least one paragraph');
  if (paragraphs.join('\n\n').length > 20000) throw new HttpError(400, 'The text is too long');
  return paragraphs;
}

const NEWEST_FIRST = (a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true });

// ---------- Routes ----------

async function sessionRoute({ req, res, method, body }) {
  if (method === 'GET') {
    if (configError()) return res.status(503).json({ error: 'The admin panel is not configured yet.' });
    return res.status(200).json({ admin: auth.isAdmin(req) });
  }
  if (method === 'POST') {
    if (configError()) return res.status(503).json({ error: 'The admin panel is not configured yet.' });
    if (tooManyAttempts(req)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
    if (!checkPassword(body.password)) {
      recordFailure(req);
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }
    failures.delete(clientKey(req));
    setSessionCookie(res);
    return res.status(200).json({ admin: true });
  }
  if (method === 'DELETE') {
    clearSessionCookie(res);
    return res.status(200).json({ admin: false });
  }
  return methodNotAllowed(res, 'GET, POST, DELETE');
}

// Public: games, updates, banners and active ads. Only enabled ads inside their dates are sent.
async function devlogRoute({ res, method }) {
  if (method !== 'GET') return methodNotAllowed(res, 'GET');
  const data = await loadDevlog();
  const today = new Date().toISOString().slice(0, 10);
  const games = await Promise.all(data.games.map(async game => ({
    id: game.id,
    slug: game.slug,
    name: game.name,
    description: game.description,
    status: game.status,
    platforms: game.platforms,
    banner: game.banner ? { type: game.banner.type, src: storage.signedUrl(game.banner.path) } : null,
    media: await Promise.all((game.media || (game.banner ? [game.banner] : [])).map(async item => ({ ...item, alt: item.alt || game.name + ' artwork', posterPath: item.poster || '', poster: item.poster ? storage.signedUrl(item.poster) : '', src: storage.signedUrl(item.path) }))),
    release: game.release || { type: 'tba' },
    editions: game.editions || [],
    // The launch command belongs in the launcher manifest, so it is never part of the public data.
    launcher: game.launcher ? { ...game.launcher, launchCommand: undefined } : null,
    updates: await Promise.all(game.updates.map(async update => ({
      ...update,
      media: await Promise.all((update.media || []).map(async item => ({ ...item, src: storage.signedUrl(storage.mediaPath(item.src)) }))),
    }))),
  })));
  const ads = data.ads
    .filter(ad => ad.enabled && (!ad.starts || ad.starts <= today) && (!ad.ends || ad.ends >= today))
    .map(ad => {
      const base = { id: ad.id, kind: ad.kind, title: ad.title, link: ad.link, image: { type: 'image', src: storage.signedUrl(ad.image.path) } };
      return ad.kind === 'popup' ? { ...base, delaySeconds: ad.delaySeconds, frequency: ad.frequency } : { ...base, placement: ad.placement };
    });
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  return res.status(200).json({ games, ads, popups: data.popups, team: data.team, site: data.site });
}

// Admin: every file under updates/, with the update it belongs to.
async function mediaRoute({ req, res, method }) {
  if (method !== 'GET') return methodNotAllowed(res, 'GET');
  assertAdmin(req);
  const [files, data] = await Promise.all([storage.listFiles('updates/'), loadDevlog()]);
  const usedBy = new Map();
  for (const game of data.games) {
    for (const update of game.updates) {
      for (const path of new Set((update.media || []).map(item => storage.mediaPath(item.src)))) {
        usedBy.set(path, (usedBy.get(path) || 0) + 1);
      }
    }
  }
  const out = [];
  for (const file of files) {
    const parts = file.fileName.split('/');
    if (parts.length !== 5 && parts.length !== 4) continue;
    out.push({
      name: parts[parts.length - 1],
      path: file.fileName,
      game: parts[1],
      version: parts[2],
      code: parts.length === 5 ? parts[3] : null,
      size: file.contentLength,
      type: file.contentType,
      uploadedAt: file.uploadTimestamp,
      url: storage.signedUrl(file.fileName),
      usedBy: usedBy.get(file.fileName) || 0,
    });
  }
  return res.status(200).json({ files: out });
}

async function activityRoute({ req, res, method }) {
  if (method !== 'GET') return methodNotAllowed(res, 'GET');
  assertAdmin(req);
  const data = await loadDevlog();
  return res.status(200).json({ activity: data.activity });
}

// ----- Games -----

const slugify = name => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';

function uniqueSlug(games, name) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; games.some(g => g.slug === slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

function cleanPlatform(value, label) {
  const source = value || {};
  return {
    available: Boolean(source.available),
    url: cleanUrl(source.url, `${label} link`),
    version: cleanText(source.version, `${label} version`, 20, { required: false }),
  };
}

const BANNER_KINDS = { png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', mp4: 'video', webm: 'video' };

function cleanBanner(value, gameId) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Banner is invalid');
  if (!isOwnedPath(value.path, `games/${gameId}/`)) throw new HttpError(400, 'Banner must be uploaded for this game');
  const kind = BANNER_KINDS[extensionOf(value.path)];
  if (!kind) throw new HttpError(415, 'Banner must be a PNG, JPG, WEBP, GIF, MP4 or WEBM file');
  return { path: value.path, type: kind };
}

function cleanGameMedia(value, gameId) {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, 'Media must be a list of up to 20 items');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || !isOwnedPath(item.path, `games/${gameId}/`)) throw new HttpError(400, 'Every media item must be uploaded for this game');
    const type = BANNER_KINDS[extensionOf(item.path)];
    if (!type || (item.type && item.type !== type)) throw new HttpError(415, 'Media must be a PNG, JPG, WEBP, GIF, MP4 or WEBM file');
    const out = { path: item.path, type, alt: cleanText(item.alt, 'Alt text', 180, { required: false }) };
    if (item.poster) {
      if (!isOwnedPath(item.poster, `games/${gameId}/`) || !['png','jpg','jpeg','webp','gif'].includes(extensionOf(item.poster))) throw new HttpError(400, 'Video poster must be an uploaded image for this game');
      out.poster = item.poster;
    }
    return out;
  });
}

function cleanRelease(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Release details are invalid');
  const type = value.type || 'tba';
  if (!['confirmed', 'estimated', 'tba', 'custom'].includes(type)) throw new HttpError(400, 'Release type must be confirmed, estimated, tba or custom');
  if (type === 'tba') return { type: 'tba' };
  if (type === 'custom') return { type, label: cleanText(value.label, 'Release label', 80) };
  const validDate = input => {
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
    const parsed = new Date(input + 'T00:00:00Z');
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input;
  };
  if (type === 'confirmed') {
    if (!validDate(value.date)) throw new HttpError(400, 'Confirmed releases need a valid exact date');
    return { type, date: value.date };
  }
  if (value.date) {
    if (!validDate(value.date)) throw new HttpError(400, 'Estimated release date must be a valid exact date');
    return { type, date: value.date };
  }
  if (value.start || value.end) {
    if (!validDate(value.start) || !validDate(value.end) || value.end < value.start) throw new HttpError(400, 'Release window needs valid start and end dates');
    return { type, start: value.start, end: value.end };
  }
  const year = Number(value.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new HttpError(400, 'Estimated releases need a year between 2020 and 2100');
  if (value.quarter != null && value.quarter !== '') {
    const quarter = Number(value.quarter);
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new HttpError(400, 'Quarter must be between 1 and 4');
    return { type, quarter, year };
  }
  return { type, year };
}

async function gamesRoute({ req, res, method, query, body }) {
  assertAdmin(req);
  if (method === 'POST') {
    const data = await loadDevlog();
    const name = cleanText(body.name, 'Name', 80);
    let id = randomDigits(12);
    while (data.games.some(g => g.id === id)) id = randomDigits(12);
    const game = {
      id,
      slug: uniqueSlug(data.games, name),
      name,
      description: cleanText(body.description, 'Description', 300, { required: false }),
      status: cleanStatus(body.status || 'released'),
      platforms: { windows: cleanPlatform(body.platforms && body.platforms.windows, 'Windows'), android: cleanPlatform(body.platforms && body.platforms.android, 'Android') },
      banner: null,
      media: [],
      release: body.release !== undefined ? cleanRelease(body.release) : { type: 'tba' },
      editions: cleanEditions(body.editions),
      launcher: cleanLauncher(body.launcher),
      updates: [],
    };
    data.games.push(game);
    logActivity(data, 'game.created', `${game.name} (${game.id})`);
    await saveDevlog(data);
    return res.status(201).json(game);
  }
  if (method === 'PATCH') {
    const id = requireGameId(query.id);
    const data = await loadDevlog();
    const game = data.games.find(g => g.id === id);
    if (!game) throw new HttpError(404, 'Game not found');
    const obsoleteMedia = new Set();
    if (body.name !== undefined) game.name = cleanText(body.name, 'Name', 80);
    if (body.description !== undefined) game.description = cleanText(body.description, 'Description', 300, { required: false });
    if (body.status !== undefined) game.status = cleanStatus(body.status);
    if (body.release !== undefined) game.release = cleanRelease(body.release);
    if (body.editions !== undefined) game.editions = cleanEditions(body.editions);
    if (body.launcher !== undefined) game.launcher = cleanLauncher(body.launcher);
    if (body.platforms !== undefined) {
      game.platforms = { windows: cleanPlatform(body.platforms.windows, 'Windows'), android: cleanPlatform(body.platforms.android, 'Android') };
    }
    if (body.media !== undefined) {
      const previous = [...new Set([...(game.media || []).flatMap(item => [item.path, item.poster].filter(Boolean)), game.banner && game.banner.path].filter(Boolean))];
      game.media = cleanGameMedia(body.media, id);
      const primary = game.media[0] || null;
      game.banner = primary ? { path: primary.path, type: primary.type } : null;
      const retained = new Set(game.media.flatMap(item => [item.path, item.poster].filter(Boolean)));
      for (const path of previous) if (!retained.has(path)) obsoleteMedia.add(path);
    }
    if (body.banner !== undefined && body.media === undefined) {
      const previous = [...new Set([...(game.media || []).flatMap(item => [item.path, item.poster].filter(Boolean)), game.banner && game.banner.path].filter(Boolean))];
      game.banner = cleanBanner(body.banner, id);
      game.media = game.banner ? [{ ...game.banner, alt: game.name + ' banner' }] : [];
      const retained = new Set(game.media.map(item => item.path));
      for (const path of previous) if (!retained.has(path)) obsoleteMedia.add(path);
    }
    logActivity(data, 'game.updated', `${game.name} (${game.id})`);
    await saveDevlog(data);
    for (const path of obsoleteMedia) await storage.deleteFile(path);
    return res.status(200).json(game);
  }
  if (method === 'DELETE') {
    const id = requireGameId(query.id);
    const data = await loadDevlog();
    const game = data.games.find(g => g.id === id);
    if (!game) throw new HttpError(404, 'Game not found');
    data.games = data.games.filter(g => g.id !== id);
    logActivity(data, 'game.deleted', `${game.name} (${game.id}) with ${game.updates.length} update(s)`);
    await saveDevlog(data);
    let removed = 0;
    for (const prefix of [`games/${id}/`, ...game.updates.map(update => `${update.folder}/`)]) {
      for (const file of await storage.listFiles(prefix)) {
        await storage.deleteFile(file);
        removed += 1;
      }
    }
    return res.status(200).json({ deleted: removed });
  }
  return methodNotAllowed(res, 'POST, PATCH, DELETE');
}

// ----- Ads and popups -----

const PLACEMENTS = ['top', 'games'];
const FREQUENCIES = ['session', 'day'];
const AD_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function cleanAdImage(value) {
  if (!value || !isOwnedPath(value.path, 'ads/') || !AD_IMAGE_EXTENSIONS.includes(extensionOf(value.path))) {
    throw new HttpError(400, 'Ads need an image (PNG, JPG, WEBP or GIF) uploaded from the admin');
  }
  return { path: value.path, type: 'image' };
}

// An image file belongs to one ad only. Sharing it would let deleting one ad delete another's file.
function assertImageFree(ads, ad) {
  if (ads.some(other => other.id !== ad.id && other.image.path === ad.image.path)) {
    throw new HttpError(409, 'That image is already used by another ad');
  }
}

// Ads are images with a link, or popups with an image. There is no HTML input, so nothing can inject scripts.
function cleanAd(body, current) {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : (current ? current[key] : fallback));
  const kind = body.kind !== undefined ? body.kind : (current && current.kind);
  if (kind !== 'banner' && kind !== 'popup') throw new HttpError(400, 'Kind must be banner or popup');
  const ad = {
    kind,
    title: cleanText(pick('title'), 'Title', 120),
    link: cleanUrl(pick('link', ''), 'Link'),
    image: cleanAdImage(pick('image')),
    starts: cleanDay(pick('starts', null), 'Start date'),
    ends: cleanDay(pick('ends', null), 'End date'),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : (current ? current.enabled : true),
  };
  if (ad.starts && ad.ends && ad.ends < ad.starts) throw new HttpError(400, 'End date is before the start date');
  if (kind === 'banner') {
    const placement = pick('placement', 'games');
    if (!PLACEMENTS.includes(placement)) throw new HttpError(400, 'Placement must be top or games');
    ad.placement = placement;
  } else {
    const delay = Number(pick('delaySeconds', 3));
    if (!Number.isInteger(delay) || delay < 0 || delay > 120) throw new HttpError(400, 'Delay must be between 0 and 120 seconds');
    const frequency = pick('frequency', 'session');
    if (!FREQUENCIES.includes(frequency)) throw new HttpError(400, 'Frequency must be session or day');
    ad.delaySeconds = delay;
    ad.frequency = frequency;
  }
  return ad;
}

async function adsRoute({ req, res, method, query, body }) {
  assertAdmin(req);
  if (method === 'GET') {
    const data = await loadDevlog();
    return res.status(200).json({ ads: data.ads.map(ad => ({ ...ad, image: { ...ad.image, src: storage.signedUrl(ad.image.path) } })) });
  }
  if (method === 'POST') {
    const data = await loadDevlog();
    let id = randomDigits(12);
    while (data.ads.some(ad => ad.id === id)) id = randomDigits(12);
    const ad = { id, ...cleanAd(body) };
    assertImageFree(data.ads, ad);
    data.ads.push(ad);
    logActivity(data, 'ad.created', `${ad.kind}: ${ad.title} (${ad.id})`);
    await saveDevlog(data);
    return res.status(201).json(ad);
  }
  if (method === 'PATCH') {
    const id = query.id;
    const data = await loadDevlog();
    const index = data.ads.findIndex(ad => ad.id === id);
    if (index === -1) throw new HttpError(404, 'Ad not found');
    const current = data.ads[index];
    const next = { id, ...cleanAd({ ...body, kind: current.kind }, current) };
    assertImageFree(data.ads, next);
    if (next.image.path !== current.image.path) await storage.deleteFile(current.image.path);
    data.ads[index] = next;
    logActivity(data, 'ad.updated', `${next.kind}: ${next.title} (${next.id})`);
    await saveDevlog(data);
    return res.status(200).json(next);
  }
  if (method === 'DELETE') {
    const data = await loadDevlog();
    const ad = data.ads.find(item => item.id === query.id);
    if (!ad) throw new HttpError(404, 'Ad not found');
    data.ads = data.ads.filter(item => item.id !== ad.id);
    logActivity(data, 'ad.deleted', `${ad.kind}: ${ad.title} (${ad.id})`);
    await saveDevlog(data);
    await storage.deleteFile(ad.image.path);
    return res.status(200).json({ deleted: true });
  }
  return methodNotAllowed(res, 'GET, POST, PATCH, DELETE');
}

// ----- Updates (a version can hold many updates; each has its own 12-character code) -----

async function createUpdate(res, body) {
  const { game, version, id, title, date, media } = body;
  if (!isGameId(game)) throw new HttpError(400, 'Unknown game');
  safeSegment(version, 'Version');
  if (!isUpdateId(id)) throw new HttpError(400, 'Update code is missing or invalid');
  const cleanTitle = cleanText(title, 'Title', 120);
  const cleanDay = cleanDate(date);
  const paragraphs = cleanParagraphs(body.body);
  const files = Array.isArray(media) ? media : [];
  if (files.length > 30) throw new HttpError(400, 'Up to 30 files per update');
  const folder = `updates/${game}/${version}/${id}`;
  const items = files.map(file => {
    const name = safeMediaName(file && file.name);
    return { type: mediaType(name), src: `${folder}/${name}`, alt: cleanTitle };
  });
  const data = await loadDevlog();
  const entry = data.games.find(g => g.id === game);
  if (!entry) throw new HttpError(404, 'Game not found');
  if (entry.updates.some(u => u.id === id)) throw new HttpError(409, 'That update code is already used');
  const update = { id, version, folder, date: cleanDay, title: cleanTitle, paragraphs, media: items };
  entry.updates.push(update);
  entry.updates.sort(NEWEST_FIRST);
  logActivity(data, 'update.published', `${entry.name} ${version} (${id}): ${cleanTitle}`);
  await saveDevlog(data);
  return res.status(201).json(update);
}

async function editUpdate(res, query, changes) {
  if (!isGameId(query.game)) throw new HttpError(400, 'Unknown game');
  safeId(query.id);
  const data = await loadDevlog();
  const entry = data.games.find(g => g.id === query.game);
  if (!entry) throw new HttpError(404, 'Game not found');
  const update = entry.updates.find(u => u.id === query.id);
  if (!update) throw new HttpError(404, 'Update not found');
  if (changes.version !== undefined) update.version = safeSegment(changes.version, 'Version');
  if (changes.title !== undefined) update.title = cleanText(changes.title, 'Title', 120);
  if (changes.date !== undefined) update.date = cleanDate(changes.date);
  if (changes.body !== undefined) update.paragraphs = cleanParagraphs(changes.body);
  entry.updates.sort(NEWEST_FIRST);
  logActivity(data, 'update.edited', `${entry.name} ${update.version} (${update.id})`);
  await saveDevlog(data);
  return res.status(200).json(update);
}

async function deleteUpdate(res, query) {
  if (!isGameId(query.game)) throw new HttpError(400, 'Unknown game');
  safeId(query.id);
  const data = await loadDevlog();
  const entry = data.games.find(g => g.id === query.game);
  if (!entry) throw new HttpError(404, 'Game not found');
  const update = entry.updates.find(u => u.id === query.id);
  if (!update) throw new HttpError(404, 'Update not found');
  entry.updates = entry.updates.filter(u => u.id !== query.id);
  logActivity(data, 'update.deleted', `${entry.name} ${update.version} (${update.id})`);
  await saveDevlog(data);
  const files = await storage.listFiles(`${update.folder}/`);
  for (const file of files) await storage.deleteFile(file);
  return res.status(200).json({ deleted: files.length });
}

async function updatesRoute({ req, res, method, query, body }) {
  assertAdmin(req);
  if (method === 'POST') return createUpdate(res, body);
  if (method === 'PATCH') return editUpdate(res, query, body);
  if (method === 'DELETE') return deleteUpdate(res, query);
  return methodNotAllowed(res, 'POST, PATCH, DELETE');
}

// ----- Uploads -----

async function uploadUrlRoute({ req, res, method, body }) {
  if (method !== 'POST') return methodNotAllowed(res, 'POST');
  assertAdmin(req);
  const { key, type, maxBytes } = plan(body.purpose || 'update', body);
  return res.status(200).json({ uploadUrl: storage.presignUpload(key), method: 'PUT', fileName: key, contentType: type, maxBytes });
}

// Fallback for when the browser cannot reach storage directly (usually a CORS rule problem). The file passes through here.
async function uploadFileRoute({ req, res, method, query, rawBody }) {
  if (method !== 'POST') return methodNotAllowed(res, 'POST');
  assertAdmin(req);
  const { key, type, maxBytes } = plan(query.purpose || 'update', query);
  const declaredType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (declaredType !== type) throw new HttpError(415, 'The file type does not match its name');
  if (rawBody.length > Math.min(SERVER_UPLOAD_MAX, maxBytes)) {
    throw new HttpError(413, 'This file is too large for the server fallback (4 MB). Use the direct upload instead.');
  }
  if (!rawBody.length) throw new HttpError(400, 'The file is empty');
  await storage.uploadBytes(key, rawBody, type);
  return res.status(200).json({ ok: true, fileName: key });
}

// ----- Studio telemetry API -----
// GET /api/studio
// A compact, public, cacheable summary for the interactive site surface.
// It exposes only already-public devlog facts, never storage paths or admin data.
function publicMediaCount(game) {
  return Array.isArray(game.media) ? game.media.length : (game.banner ? 1 : 0);
}

async function studioRoute({ res, method }) {
  if (method !== 'GET') return methodNotAllowed(res, 'GET');
  const data = await loadDevlog();
  const games = data.games.map(game => ({
    slug: game.slug,
    name: game.name,
    status: game.status,
    release: game.release || { type: 'tba' },
    mediaCount: publicMediaCount(game),
    updateCount: game.updates.length,
  }));
  const updates = data.games.flatMap(game => game.updates.map(update => ({
    game: game.name,
    slug: game.slug,
    id: update.id,
    version: update.version,
    date: update.date,
    title: update.title,
  }))).sort((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true }));
  const releases = games.filter(game => game.release && game.release.type !== 'tba');
  const payload = {
    studio: 'Monocross Studios',
    schema: 'studio.v1',
    generatedAt: new Date().toISOString(),
    metrics: {
      games: games.length,
      inDevelopment: games.filter(game => game.status === 'in_development').length,
      updates: updates.length,
      media: games.reduce((sum, game) => sum + game.mediaCount, 0),
      releases: releases.length,
    },
    games,
    latestUpdate: updates[0] || null,
    nextRelease: releases[0] || null,
  };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ games, updates })).digest('hex').slice(0, 16);
  const etag = `"${fingerprint}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (res.req && res.req.headers && res.req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ ...payload, fingerprint });
}

// ----- Embed API: ad creatives for other websites -----
// GET /api/embed?kind=banner|popup&size=small|medium|big
// Returns the campaigns live today, then the released games that have an image and a download link.
// Public and read-only. The embed script (embed.js) draws the result; no HTML is ever sent.

const EMBED_KINDS = ['banner', 'popup'];
const EMBED_SIZES = ['small', 'medium', 'big'];
const EMBED_LIMIT = 20;

// Defense in depth: links are checked again when they leave the server, not only when they are saved.
function httpsOnly(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:' ? new URL(String(value)).href : '';
  } catch (err) {
    return '';
  }
}

const isAvailableGame = game => game.status === 'released' && Object.values(game.platforms).some(platform => platform.available && platform.url);

function gamePromo(game, kind) {
  const media = (game.media && game.media[0]) || game.banner;
  const platform = Object.values(game.platforms).find(item => item.available && item.url);
  if (!media || media.type !== 'image' || !platform) return null;
  return {
    id: `game-${game.id}`,
    kind,
    label: 'Available now',
    title: game.name,
    description: game.description || '',
    cta: 'Download',
    link: httpsOnly(platform.url),
    image: storage.signedUrl(media.path),
  };
}

async function embedRoute({ res, method, query }) {
  if (method !== 'GET') return methodNotAllowed(res, 'GET');
  const kind = String(query.kind || '');
  const size = String(query.size || 'medium');
  if (!EMBED_KINDS.includes(kind)) throw new HttpError(400, 'kind must be banner or popup');
  if (!EMBED_SIZES.includes(size)) throw new HttpError(400, 'size must be small, medium or big');
  const data = await loadDevlog();
  const today = new Date().toISOString().slice(0, 10);
  const campaigns = data.ads
    .filter(ad => ad.enabled && ad.kind === kind && (!ad.starts || ad.starts <= today) && (!ad.ends || ad.ends >= today))
    .map(ad => ({
      id: `ad-${ad.id}`,
      kind,
      label: 'Advertisement',
      title: ad.title,
      description: '',
      cta: 'Learn more',
      link: httpsOnly(ad.link),
      image: storage.signedUrl(ad.image.path),
      delaySeconds: ad.delaySeconds,
      frequency: ad.frequency,
    }));
  const promos = data.games.filter(isAvailableGame).map(game => gamePromo(game, kind)).filter(Boolean);
  const items = [...campaigns, ...promos].slice(0, EMBED_LIMIT);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ kind, size, items });
}

// ---------- Studio applications ----------
// These lists are the source of truth. The form loads them from GET /api/apply, and POST checks every answer against them.
const TERMS_VERSION = '2026-11-v1';
const APPLY_OPTIONS = {
  roles: [
    { group: 'Programming / Engineering', items: ['Gameplay Programmer', 'Generalist Programmer', 'Engine Programmer', 'Tools Programmer', 'Graphics Programmer', 'Network / Multiplayer Programmer', 'Backend Developer', 'Web Developer', 'Mobile Developer', 'Technical Programmer'] },
    { group: 'Art / 3D', items: ['3D Modeler', 'Character Artist', 'Environment Artist', 'Prop Artist', 'Hard-Surface Artist', 'Texture Artist', 'Material Artist', 'VFX Artist', 'Technical Artist', 'Concept Artist', '2D Artist', 'UI Artist'] },
    { group: 'Animation', items: ['Animator', '3D Animator', '2D Animator', 'Character Animator', 'Technical Animator', 'Rigging Artist'] },
    { group: 'Design', items: ['Game Designer', 'Level Designer', 'Systems Designer', 'UX Designer', 'UI Designer', 'Narrative Designer', 'Technical Designer'] },
    { group: 'Audio', items: ['Sound Designer', 'Music Composer', 'Audio Programmer', 'Voice / Dialogue Editor'] },
    { group: 'Production / Management', items: ['Producer', 'Project Manager', 'Community Manager', 'Social Media Manager', 'Marketing', 'QA Tester', 'QA Lead'] },
    { group: 'Other', items: ['Localization', 'Writer', 'Build / Release Manager', 'DevOps', 'Other / Custom Role'] },
  ],
  languages: [
    { group: null, items: ['🇧🇷 Português (Brasil) — Portuguese (Brazil)', '🇵🇹 Português (Portugal) — Portuguese (Portugal)', '🇪🇸 Español — Spanish', '🇺🇸 English'] },
  ],
  tools: [
    { group: 'Game engines', items: ['Godot Engine', 'Unity', 'Unreal Engine', 'GameMaker', 'Construct', 'RPG Maker', "Ren'Py", 'Defold'] },
    { group: '3D / Art', items: ['Blender', '3ds Max', 'Maya', 'Cinema 4D', 'ZBrush', 'Substance 3D Painter', 'Substance 3D Designer', 'Houdini', 'Marvelous Designer', 'Marmoset Toolbag'] },
    { group: '2D / Design', items: ['Photoshop', 'Illustrator', 'Krita', 'GIMP', 'Aseprite', 'Figma', 'Affinity Designer', 'Affinity Photo'] },
    { group: 'Programming / Development', items: ['Visual Studio', 'VS Code', 'JetBrains Rider', 'CLion', 'Git', 'GitHub', 'GitLab', 'Docker', 'Node.js', 'TypeScript', 'C', 'C++', 'C#', 'JavaScript', 'Python', 'Rust', 'Lua'] },
    { group: 'Audio', items: ['FL Studio', 'Ableton Live', 'Reaper', 'Audacity', 'FMOD', 'Wwise'] },
    { group: 'Other', items: ['Substance tools', 'Perforce', 'Jira', 'Trello', 'Notion', 'Discord', 'Other / Custom'] },
  ],
};
const optionSet = key => new Set(APPLY_OPTIONS[key].flatMap(group => group.items));
const APPLY_SETS = { roles: optionSet('roles'), languages: optionSet('languages'), tools: optionSet('tools') };
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function cleanChoices(value, key, label, { min = 0, max = 30 } = {}) {
  if (value != null && !Array.isArray(value)) throw new HttpError(400, `${label} must be a list`);
  const picked = [...new Set(value || [])];
  if (picked.length < min) throw new HttpError(400, `Pick at least ${min} in ${label.toLowerCase()}`);
  if (picked.length > max) throw new HttpError(400, `Pick up to ${max} in ${label.toLowerCase()}`);
  if (picked.some(item => typeof item !== 'string' || !APPLY_SETS[key].has(item))) throw new HttpError(400, `${label} has an unknown option`);
  return picked;
}

function cleanApplication(body) {
  // Honeypot: the field is hidden from people, so only bots fill it in.
  if (body.website) throw new HttpError(400, 'Invalid submission');
  const email = cleanText(body.email, 'Email', 120).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Email must be a valid address');
  // The acceptance is checked here, not only in the browser. It must match the terms version this server publishes.
  const terms = body.terms || {};
  if (terms.accepted !== true || terms.version !== TERMS_VERSION) throw new HttpError(400, 'Accept the current application terms to submit');
  return {
    name: cleanText(body.name, 'Name', 80),
    email,
    roles: cleanChoices(body.roles, 'roles', 'Roles', { min: 1, max: 8 }),
    languages: cleanChoices(body.languages, 'languages', 'Languages', { min: 1, max: 4 }),
    tools: cleanChoices(body.tools, 'tools', 'Tools', { max: 40 }),
    otherTools: cleanText(body.otherTools, 'Other tools', 120, { required: false }),
    portfolio: cleanUrl(body.portfolio, 'Portfolio'),
    experience: cleanText(body.experience, 'Experience', 1500, { required: false }),
    availability: cleanText(body.availability, 'Availability', 200),
    notes: cleanText(body.notes, 'Notes', 1000, { required: false }),
    terms: { version: TERMS_VERSION, accepted: true, acceptedAt: new Date().toISOString() },
  };
}

// Applications are stored in the private bucket. They are never listed or signed for the public site.
async function applyRoute({ req, res, method, body }) {
  if (method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return res.status(200).json({ termsVersion: TERMS_VERSION, options: APPLY_OPTIONS });
  }
  if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  if (!applyAllowed(req)) throw new HttpError(429, 'Too many applications. Try again in a few minutes.');
  const application = cleanApplication(body || {});
  const id = randomDigits(12);
  const record = { id, submittedAt: new Date().toISOString(), ...application };
  await storage.uploadBytes(`applications/${id}.json`, JSON.stringify(record, null, 2), 'application/json');
  return res.status(201).json({ ok: true, id });
}

// ---------- Editions, launcher data, applications (admin) ----------
const EDITION_LIMIT = 5;
const LAUNCHER_PLATFORMS = ['pc-native', 'pc-compatibility', 'android', 'ios', 'web', 'other'];

// An edition is one selectable option on a game card, such as Story Mode or Multiplayer.
// Its id comes from its name, so it stays the same across saves.
function cleanEditions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Editions must be a list');
  if (value.length > EDITION_LIMIT) throw new HttpError(400, `A game can have up to ${EDITION_LIMIT} editions`);
  const ids = new Set();
  return value.map(item => {
    const source = item && typeof item === 'object' ? item : {};
    const label = cleanText(source.label, 'Edition name', 60);
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'edition';
    if (ids.has(id)) throw new HttpError(400, 'Edition names must be different');
    ids.add(id);
    return {
      id,
      label,
      description: cleanText(source.description, 'Edition description', 200, { required: false }),
      cta: cleanText(source.cta, 'Button label', 30, { required: false }) || 'Download',
      url: cleanUrl(source.url, `${label} link`),
    };
  });
}

// Launcher-ready metadata. The future launcher reads these fields. Nothing here changes the public page.
function cleanLauncher(value) {
  const source = value && typeof value === 'object' ? value : {};
  const platforms = source.platforms == null ? [] : source.platforms;
  if (!Array.isArray(platforms) || platforms.some(item => !LAUNCHER_PLATFORMS.includes(item))) {
    throw new HttpError(400, 'Launcher platforms must come from the allowed list');
  }
  const megabytes = (input, label) => {
    if (input == null || input === '') return null;
    const number = Number(input);
    if (!Number.isInteger(number) || number < 0 || number > 500000) throw new HttpError(400, `${label} must be a whole number of MB`);
    return number;
  };
  return {
    supported: Boolean(source.supported),
    platforms: [...new Set(platforms)],
    minimumRequirements: cleanText(source.minimumRequirements, 'Minimum requirements', 300, { required: false }),
    installSizeMb: megabytes(source.installSizeMb, 'Install size'),
    downloadSizeMb: megabytes(source.downloadSizeMb, 'Download size'),
    manifestUrl: cleanUrl(source.manifestUrl, 'Manifest link'),
  };
}

// Applications: up to 5 submissions per client every 10 minutes. Best effort, like the sign-in limit.
const APPLY_WINDOW_MS = 10 * 60 * 1000;
const APPLY_MAX = 5;
const applyAttempts = new Map();
function applyAllowed(req) {
  const key = clientKey(req);
  const now = Date.now();
  const recent = (applyAttempts.get(key) || []).filter(time => now - time < APPLY_WINDOW_MS);
  const allowed = recent.length < APPLY_MAX;
  if (allowed) recent.push(now);
  applyAttempts.set(key, recent);
  if (applyAttempts.size > 5000) applyAttempts.clear();
  return allowed;
}

// Admin only: the newest 100 applications, and deleting one by its 12-digit id.
async function applicationsRoute({ req, res, method, query }) {
  assertAdmin(req);
  if (method === 'GET') {
    const files = (await storage.listFiles('applications/')).filter(file => file.fileName.endsWith('.json'));
    files.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp);
    const records = await Promise.all(files.slice(0, 100).map(file => storage.readJson(file.fileName)));
    return res.status(200).json({ applications: records.filter(Boolean), total: files.length });
  }
  if (method === 'DELETE') {
    const id = String(query.id || '');
    if (!DIGITS_12.test(id)) throw new HttpError(400, 'Application ID must be 12 digits');
    await storage.deleteFile(`applications/${id}.json`);
    return res.status(200).json({ deleted: id });
  }
  return methodNotAllowed(res, 'GET, DELETE');
}

// ---------- Home popups (admin sets timing, the site runs the queue) ----------
const POPUP_FREQUENCIES = ['session', 'day'];
const DEFAULT_POPUPS = {
  gapSeconds: 8,
  social: { enabled: true, delaySeconds: 4, frequency: 'day' },
  apply: { enabled: true, delaySeconds: 0, frequency: 'day' },
};
function popupsOrDefault(saved) {
  const source = saved && typeof saved === 'object' ? saved : {};
  return {
    gapSeconds: Number.isInteger(source.gapSeconds) ? source.gapSeconds : DEFAULT_POPUPS.gapSeconds,
    social: { ...DEFAULT_POPUPS.social, ...(source.social || {}) },
    apply: { ...DEFAULT_POPUPS.apply, ...(source.apply || {}) },
  };
}
function cleanPopupStep(value, label) {
  const source = value && typeof value === 'object' ? value : {};
  if (typeof source.enabled !== 'boolean') throw new HttpError(400, `${label}: enabled must be true or false`);
  const delay = Number(source.delaySeconds);
  if (!Number.isInteger(delay) || delay < 0 || delay > 120) throw new HttpError(400, `${label}: the wait must be 0 to 120 seconds`);
  if (!POPUP_FREQUENCIES.includes(source.frequency)) throw new HttpError(400, `${label}: frequency must be once per visit or once per day`);
  return { enabled: source.enabled, delaySeconds: delay, frequency: source.frequency };
}
function cleanPopups(body) {
  const gap = Number(body.gapSeconds);
  if (!Number.isInteger(gap) || gap < 0 || gap > 60) throw new HttpError(400, 'The gap must be 0 to 60 seconds');
  return { gapSeconds: gap, social: cleanPopupStep(body.social, 'Discord and TikTok'), apply: cleanPopupStep(body.apply, 'Application') };
}
// Admin only: saves the timing of the Discord/TikTok and application popups and the gap between popups.
async function popupsRoute({ req, res, method, body }) {
  assertAdmin(req);
  if (method !== 'PATCH') return methodNotAllowed(res, 'PATCH');
  const data = await loadDevlog();
  data.popups = cleanPopups(body || {});
  logActivity(data, 'popups.updated', `gap ${data.popups.gapSeconds}s`);
  await saveDevlog(data);
  return res.status(200).json(data.popups);
}

// ---------- Team and site text (admin edits, the home page shows) ----------
const TEAM_LIMIT = 24;
const DEFAULT_SITE = {
  heroLine1: 'Mono', heroLine2: 'cross',
  heroLead: 'Fast, raw games made by a small team of five. Built for the edge.',
  discordUrl: 'https://discord.gg/kGgzurahuG', tiktokUrl: 'https://www.tiktok.com/@monocross_studios',
  footerTagline: 'Independent game studio. Fast, raw games, built for the edge.',
};
const DEFAULT_TEAM = [
  { id: 'ranger', name: 'Ranger', role: 'Owner · Voice Actor', description: 'Sets the direction, keeps things moving and voices the games.' },
  { id: 'tiago', name: 'Tiago', role: 'Co-Owner', description: 'Shares decisions and day-to-day planning.' },
  { id: 'deky', name: 'Deky', role: 'Programmer', description: 'Turns ideas into working systems.' },
  { id: 'matt', name: 'Matt', role: 'Designer & Tester', description: 'Designs it, tests it, makes it right.' },
  { id: 'averypngz', name: 'averypngz', role: 'Artist', description: 'Draws the art behind our games.' },
];
const teamOrDefault = saved => (Array.isArray(saved) ? saved : DEFAULT_TEAM);
const siteOrDefault = saved => ({ ...DEFAULT_SITE, ...(saved && typeof saved === 'object' ? saved : {}) });
const MEMBER_ID = /^[a-z0-9-]{2,24}$/;

function cleanMember(value, id) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    id,
    name: cleanText(source.name, 'Name', 60),
    role: cleanText(source.role, 'Role', 80, { required: false }),
    description: cleanText(source.description, 'Description', 240, { required: false }),
  };
}
function newMemberId(team) {
  let id;
  do { id = 'm' + randomDigits(8); } while (team.some(member => member.id === id));
  return id;
}
function cleanSite(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    heroLine1: cleanText(source.heroLine1, 'First hero line', 20),
    heroLine2: cleanText(source.heroLine2, 'Second hero line', 20),
    heroLead: cleanText(source.heroLead, 'Hero text', 160),
    discordUrl: cleanUrl(source.discordUrl, 'Discord link'),
    tiktokUrl: cleanUrl(source.tiktokUrl, 'TikTok link'),
    footerTagline: cleanText(source.footerTagline, 'Footer text', 160),
  };
}

// Admin only. POST adds a member, PATCH ?id= edits one, DELETE ?id= removes one, PUT {order} reorders.
async function teamRoute({ req, res, method, body, query }) {
  assertAdmin(req);
  const data = await loadDevlog();
  const team = data.team;
  if (method === 'POST') {
    if (team.length >= TEAM_LIMIT) throw new HttpError(400, `The team can have up to ${TEAM_LIMIT} members`);
    const member = cleanMember(body, newMemberId(team));
    team.push(member);
  } else if (method === 'PATCH') {
    const index = team.findIndex(member => member.id === String(query.id || ''));
    if (index === -1) throw new HttpError(404, 'Member not found');
    team[index] = cleanMember(body, team[index].id);
  } else if (method === 'DELETE') {
    const index = team.findIndex(member => member.id === String(query.id || ''));
    if (index === -1) throw new HttpError(404, 'Member not found');
    team.splice(index, 1);
  } else if (method === 'PUT') {
    const order = Array.isArray(body && body.order) ? body.order : null;
    if (!order || order.length !== team.length || new Set(order).size !== team.length || order.some(id => !team.some(m => m.id === id))) {
      throw new HttpError(400, 'The new order must list every member once');
    }
    data.team = order.map(id => team.find(member => member.id === id));
  } else {
    return methodNotAllowed(res, 'POST, PATCH, DELETE, PUT');
  }
  logActivity(data, 'team.updated', method);
  await saveDevlog(data);
  return res.status(200).json({ team: data.team });
}

// Admin only: the hero text, the Discord and TikTok links, and the footer text.
async function siteRoute({ req, res, method, body }) {
  assertAdmin(req);
  if (method !== 'PATCH') return methodNotAllowed(res, 'PATCH');
  const data = await loadDevlog();
  data.site = cleanSite(body);
  logActivity(data, 'site.updated', 'site text');
  await saveDevlog(data);
  return res.status(200).json(data.site);
}

const ROUTES = {
  session: sessionRoute,
  devlog: devlogRoute,
  embed: embedRoute,
  studio: studioRoute,
  apply: applyRoute,
  applications: applicationsRoute,
  popups: popupsRoute,
  team: teamRoute,
  site: siteRoute,
  media: mediaRoute,
  activity: activityRoute,
  games: gamesRoute,
  ads: adsRoute,
  updates: updatesRoute,
  'upload-url': uploadUrlRoute,
  'upload-file': uploadFileRoute,
};

async function handler(req, res) {
  const route = String((req.query && req.query.route) || '');
  const run = ROUTES[route];
  if (!run) return res.status(404).json({ error: 'Not found' });
  if (!PUBLIC_ROUTES.has(route)) res.setHeader('Cache-Control', 'no-store');
  try {
    const isUpload = route === 'upload-file';
    const buffer = await readBody(req, isUpload ? SERVER_UPLOAD_MAX + 1 : JSON_MAX);
    const body = isUpload ? {} : parseJson(buffer);
    return await run({ req, res, method: req.method, query: req.query || {}, body, rawBody: buffer });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Something went wrong' });
  }
}

module.exports = handler;
// Vercel must not parse bodies: the handler reads them itself (raw bytes for uploads, JSON otherwise).
module.exports.config = { api: { bodyParser: false } };
// Used by the tests to swap in a fake bucket and admin check.
module.exports.__storage = storage;
module.exports.__auth = auth;
module.exports.__sigv4 = sigv4;
