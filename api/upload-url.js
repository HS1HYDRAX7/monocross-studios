const { isAdmin } = require('../lib/auth');
const storage = require('../lib/storage');
const { HttpError, isGame, isUpdateId, safeSegment, safeMediaName, mediaContentTypeMatchesName } = require('../lib/validate');

// Admin only. Gives the browser a one-time upload link, so large videos go straight to storage
// and never pass through the Vercel function (which has a small request size limit).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const { game, version, updateId, name, contentType } = req.body || {};
    if (!isGame(game)) throw new HttpError(400, 'Unknown game');
    safeSegment(version, 'Version');
    if (!isUpdateId(updateId)) throw new HttpError(400, 'Update code is missing or invalid');
    safeMediaName(name);
    if (!mediaContentTypeMatchesName(name, contentType)) throw new HttpError(415, 'File extension and content type do not match');

    const fileName = `updates/${game}/${version}/${updateId}/${name}`;
    return res.status(200).json({ uploadUrl: storage.presignUpload(fileName, contentType), method: 'PUT', fileName, headers: { 'Content-Type': contentType } });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'Upload could not be prepared' });
  }
};
