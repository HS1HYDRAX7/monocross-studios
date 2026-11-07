const { isAdmin } = require('../lib/auth');
const storage = require('../lib/storage');
const { HttpError, isGame, safeSegment, safeMediaName } = require('../lib/validate');

// Admin only. Gives the browser a one-time upload link, so large videos go straight to storage
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

    const fileName = `updates/${game}/${version}/${name}`;
    return res.status(200).json({ uploadUrl: storage.presignUpload(fileName), method: 'PUT', fileName });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload could not be prepared' });
  }
};
