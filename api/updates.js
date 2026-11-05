const { isAdmin } = require('../lib/auth');
const b2 = require('../lib/b2');
const { loadDevlog, saveDevlog } = require('../lib/devlog');
const { HttpError, isGame, safeSegment, safeMediaName, mediaType, cleanText } = require('../lib/validate');

async function createUpdate(req, res) {
  const { game, version, title, date, body, media } = req.body || {};
  if (!isGame(game)) throw new HttpError(400, 'Unknown game');
  safeSegment(version, 'Version');
  const cleanTitle = cleanText(title, 'Title', 120);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');

  const paragraphs = String(body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) throw new HttpError(400, 'Write at least one paragraph');
  if (paragraphs.join('\n\n').length > 20000) throw new HttpError(400, 'The text is too long');

  const files = Array.isArray(media) ? media : [];
  if (files.length > 30) throw new HttpError(400, 'Up to 30 files per update');

  const items = [];
  for (const file of files) {
    const name = safeMediaName(file && file.name);
    items.push({
      type: mediaType(name),
      src: await b2.publicUrl(`updates/${game}/${version}/${name}`),
      alt: cleanTitle,
    });
  }

  const data = await loadDevlog();
  const entry = data.games.find(g => g.slug === game);
  if (entry.updates.some(u => u.version === version)) throw new HttpError(409, 'That version already exists');

  const update = { version, date, title: cleanTitle, paragraphs, media: items };
  entry.updates.push(update);
  entry.updates.sort((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true }));
  await saveDevlog(data);
  return res.status(201).json(update);
}

async function deleteUpdate(req, res) {
  const { game, version } = req.query || {};
  if (!isGame(game)) throw new HttpError(400, 'Unknown game');
  safeSegment(version, 'Version');

  const data = await loadDevlog();
  const entry = data.games.find(g => g.slug === game);
  const remaining = entry.updates.filter(u => u.version !== version);
  if (remaining.length === entry.updates.length) throw new HttpError(404, 'Update not found');

  entry.updates = remaining;
  await saveDevlog(data);

  const files = await b2.listFiles(`updates/${game}/${version}/`);
  for (const file of files) await b2.deleteFile(file);
  return res.status(200).json({ deleted: files.length });
}

// Admin only: create or delete an update.
module.exports = async function handler(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });
  try {
    if (req.method === 'POST') return await createUpdate(req, res);
    if (req.method === 'DELETE') return await deleteUpdate(req, res);
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).end();
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong' });
  }
};
