const { isAdmin } = require('../lib/auth');
const b2 = require('../lib/b2');
const { HttpError, isGame, safeSegment, safeMediaName } = require('../lib/validate');

// Fallback for when the browser cannot reach Backblaze directly (usually a CORS rule problem).
// The file passes through this function, so it must stay small: Vercel limits request bodies to about 4.5 MB.
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];
const TOO_LARGE = 'This file is too large for the server fallback (4 MB). Fix the storage CORS rule to upload larger files.';

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BYTES) throw new HttpError(413, TOO_LARGE);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpError(413, TOO_LARGE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Admin only. Receives one raw file, e.g. POST /api/upload-file?game=bloodtubies&version=0.0.4&name=01-chase.png
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const { game, version, name } = req.query || {};
    if (!isGame(game)) throw new HttpError(400, 'Unknown game');
    safeSegment(version, 'Version');
    safeMediaName(name);

    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!ALLOWED_TYPES.includes(type)) throw new HttpError(415, 'Unsupported file type');

    const body = await readBody(req);
    if (!body.length) throw new HttpError(400, 'The file is empty');

    await b2.uploadBytes(`updates/${game}/${version}/${name}`, body, type);
    return res.status(200).json({ ok: true, name });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'The file could not be stored' });
  }
};

// Vercel must not parse the body: the file is read as raw bytes above.
module.exports.config = { api: { bodyParser: false } };
