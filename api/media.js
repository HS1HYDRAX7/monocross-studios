const { isAdmin } = require('../lib/auth');
const storage = require('../lib/storage');
const { loadDevlog } = require('../lib/devlog');

const MEDIA_PREFIX = 'updates/';

// Admin only. Lists stored media and how many updates use each file.
// Files are never deleted from here, so an update cannot lose its media by accident.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const [files, data] = await Promise.all([storage.listFiles(MEDIA_PREFIX), loadDevlog()]);
    const updates = data.games.flatMap(game => game.updates);
    const items = [];
    for (const file of files) {
      // Expected paths: updates/<game>/<version>/<update code>/<file name>, or older: updates/<game>/<version>/<file name>
      const parts = file.fileName.split('/');
      if (parts.length !== 5 && parts.length !== 4) continue;
      const code = parts.length === 5 ? parts[3] : null;
      const name = parts[parts.length - 1];
      const usedBy = updates.filter(update =>
        (update.media || []).some(item => storage.mediaPath(item.src) === file.fileName)).length;
      items.push({
        name,
        path: file.fileName,
        game: parts[1],
        version: parts[2],
        code,
        size: file.contentLength,
        type: file.contentType,
        uploadedAt: file.uploadTimestamp,
        url: storage.signedUrl(file.fileName),
        usedBy,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ files: items });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not load media. Check the storage settings and try again.' });
  }
};
