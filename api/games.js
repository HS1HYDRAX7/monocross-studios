const { isAdmin } = require('../lib/auth');
const { loadDevlog, saveDevlog, logActivity } = require('../lib/devlog');
const { HttpError, isGame, cleanText } = require('../lib/validate');

const STATUSES = ['released', 'in_development'];

function cleanPlatform(input, label) {
  const source = input || {};
  const available = source.available === true;
  const url = String(source.url || '').trim();
  const version = String(source.version || '').trim();
  if (version.length > 30) throw new HttpError(400, `${label} version is too long`);
  if (url && !/^https:\/\/\S+$/.test(url)) throw new HttpError(400, `${label} link must start with https://`);
  if (available && !url) throw new HttpError(400, `${label} is marked as available but has no link`);
  return { available, url, version };
}

// Admin only: changes a game's status, description and download links.
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=60');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return res.status(200).end();
    try {
      const data = await loadDevlog();
      const games = data.games.map(game => ({
        slug: game.slug,
        name: game.name,
        description: game.description,
        status: game.status,
        platforms: {
          windows: { available: game.platforms.windows.available === true, url: game.platforms.windows.url || '', version: game.platforms.windows.version || '' },
          android: { available: game.platforms.android.available === true, url: game.platforms.android.url || '', version: game.platforms.android.version || '' },
        },
      }));
      return res.status(200).json({ games });
    } catch (err) {
      console.error('[public-games] Could not load game catalog:', err);
      return res.status(502).json({ error: 'The game catalog is temporarily unavailable.' });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS, POST');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const body = req.body || {};
    if (!isGame(body.slug)) throw new HttpError(400, 'Unknown game');
    if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
    const description = cleanText(body.description, 'Description', 200);
    const platforms = {
      windows: cleanPlatform(body.platforms && body.platforms.windows, 'Windows'),
      android: cleanPlatform(body.platforms && body.platforms.android, 'Android'),
    };

    const data = await loadDevlog();
    const entry = data.games.find(game => game.slug === body.slug);
    Object.assign(entry, { status: body.status, description, platforms });
    logActivity(data, 'game.updated', `${entry.name} (${body.status})`);
    await saveDevlog(data);
    return res.status(200).json(entry);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};
