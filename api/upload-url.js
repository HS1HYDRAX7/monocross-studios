const { isAdmin } = require('../lib/auth');
const b2 = require('../lib/b2');
const { HttpError, isGame, safeSegment, safeMediaName } = require('../lib/validate');

// Admin only. Gives the browser a one-time upload URL, so large videos go straight to Backblaze
// and never pass through the Vercel function (which has a small request size limit).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const { game, version, name } = req.body || {};
    if (!isGame(game)) throw new HttpError(400, 'Unknown game');
    safeSegment(version, 'Version');
    safeMediaName(name);

    const target = await b2.getUploadUrl();
    return res.status(200).json({ ...target, fileName: `updates/${game}/${version}/${name}` });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload could not be prepared' });
  }
};
