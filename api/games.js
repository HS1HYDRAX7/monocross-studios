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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
