const { isAdmin } = require('../lib/auth');
const { loadDevlog } = require('../lib/devlog');
const storage = require('../lib/storage');

// Public: the website reads the devlog through this endpoint.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    const data = await loadDevlog();
    // Media links are signed here, so the bucket can stay private.
    const games = await Promise.all(data.games.map(async game => ({
      ...game,
      updates: await Promise.all(game.updates.map(async update => ({
        ...update,
        media: await Promise.all((update.media || []).map(async item => ({
          ...item,
          src: storage.signedUrl(storage.mediaPath(item.src)),
        }))),
      }))),
    })));
    // Short edge cache: a deleted or edited update must disappear within seconds, not minutes.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5, must-revalidate');
    return res.status(200).json({ games });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: isAdmin(req) ? err.message : 'Could not load updates' });
  }
};
