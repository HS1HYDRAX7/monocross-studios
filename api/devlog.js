const { loadDevlog } = require('../lib/devlog');
const storage = require('../lib/storage');

function setPublicHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, stale-while-revalidate=15');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Public, read-only API. Only the documented fields are exposed; admin activity stays private.
module.exports = async function handler(req, res) {
  setPublicHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end();
  }
  if (req.method === 'HEAD') return res.status(200).end();

  try {
    const data = await loadDevlog();
    const games = await Promise.all(data.games.map(async game => ({
      slug: game.slug,
      name: game.name,
      description: game.description,
      status: game.status,
      platforms: {
        windows: { available: game.platforms.windows.available === true, url: game.platforms.windows.url || '', version: game.platforms.windows.version || '' },
        android: { available: game.platforms.android.available === true, url: game.platforms.android.url || '', version: game.platforms.android.version || '' },
      },
      updates: await Promise.all((game.updates || []).map(async update => ({
        id: update.id,
        version: update.version,
        date: update.date,
        title: update.title,
        paragraphs: Array.isArray(update.paragraphs) ? update.paragraphs : [],
        media: await Promise.all((update.media || []).filter(item => item && item.src).map(async item => ({
          type: item.type === 'video' ? 'video' : 'image',
          src: storage.signedUrl(storage.mediaPath(item.src)),
          alt: String(item.alt || update.title || ''),
        }))),
      }))),
    })));
    return res.status(200).json({ games });
  } catch (err) {
    console.error('[public-devlog] Could not load updates:', err);
    return res.status(502).json({ error: 'Could not load updates.' });
  }
};
