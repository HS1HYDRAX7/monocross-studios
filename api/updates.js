const { isAdmin } = require('../lib/auth');
const storage = require('../lib/storage');
const { loadDevlog, saveDevlog, logActivity } = require('../lib/devlog');
const { HttpError, isGame, isUpdateId, safeId, safeSegment, safeMediaName, mediaType, cleanText } = require('../lib/validate');

// Newest first: by date, then by version.
const NEWEST_FIRST = (a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true });

function cleanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  return value;
}

function cleanParagraphs(body) {
  const paragraphs = String(body || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) throw new HttpError(400, 'Write at least one paragraph');
  if (paragraphs.join('\n\n').length > 20000) throw new HttpError(400, 'The text is too long');
  return paragraphs;
}

// A version can hold many updates. Each update is identified by its own 12-character code.
async function createUpdate(req, res) {
  const { game, version, id, title, date, body, media } = req.body || {};
  if (!isGame(game)) throw new HttpError(400, 'Unknown game');
  safeSegment(version, 'Version');
  if (!isUpdateId(id)) throw new HttpError(400, 'Update code is missing or invalid');
  const cleanTitle = cleanText(title, 'Title', 120);
  const cleanDay = cleanDate(date);
  const paragraphs = cleanParagraphs(body);

  const files = Array.isArray(media) ? media : [];
  if (files.length > 30) throw new HttpError(400, 'Up to 30 files per update');
  const folder = `updates/${game}/${version}/${id}`;
  const items = files.map(file => {
    const name = safeMediaName(file && file.name);
    return { type: mediaType(name), src: `${folder}/${name}`, alt: cleanTitle };
  });

  const data = await loadDevlog();
  const entry = data.games.find(g => g.slug === game);
  if (entry.updates.some(u => u.id === id)) throw new HttpError(409, 'That update code is already used');

  const update = { id, version, folder, date: cleanDay, title: cleanTitle, paragraphs, media: items };
  entry.updates.push(update);
  entry.updates.sort(NEWEST_FIRST);
  logActivity(data, 'update.published', `${entry.name} ${version} (${id}): ${cleanTitle}`);
  await saveDevlog(data);
  return res.status(201).json(update);
}

// Edits any of: version, title, date, body. Files stay where they were uploaded.
async function editUpdate(req, res) {
  const { game, id } = req.query || {};
  if (!isGame(game)) throw new HttpError(400, 'Unknown game');
  safeId(id);
  const changes = req.body || {};

  const data = await loadDevlog();
  const entry = data.games.find(g => g.slug === game);
  const update = entry.updates.find(u => u.id === id);
  if (!update) throw new HttpError(404, 'Update not found');

  if (changes.version !== undefined) update.version = safeSegment(changes.version, 'Version');
  if (changes.title !== undefined) update.title = cleanText(changes.title, 'Title', 120);
  if (changes.date !== undefined) update.date = cleanDate(changes.date);
  if (changes.body !== undefined) update.paragraphs = cleanParagraphs(changes.body);

  entry.updates.sort(NEWEST_FIRST);
  logActivity(data, 'update.edited', `${entry.name} ${update.version} (${update.id})`);
  await saveDevlog(data);
  return res.status(200).json(update);
}

// Removes one update and only its own files, so other updates in the same version are untouched.
async function deleteUpdate(req, res) {
  const { game, id } = req.query || {};
  if (!isGame(game)) throw new HttpError(400, 'Unknown game');
  safeId(id);

  const data = await loadDevlog();
  const entry = data.games.find(g => g.slug === game);
  const update = entry.updates.find(u => u.id === id);
  if (!update) throw new HttpError(404, 'Update not found');

  entry.updates = entry.updates.filter(u => u.id !== id);
  logActivity(data, 'update.deleted', `${entry.name} ${update.version} (${update.id})`);
  await saveDevlog(data);

  const files = await storage.listFiles(`${update.folder}/`);
  for (const file of files) await storage.deleteFile(file);
  return res.status(200).json({ deleted: files.length });
}

// Admin only: create, edit or delete an update.
module.exports = async function handler(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });
  try {
    if (req.method === 'POST') return await createUpdate(req, res);
    if (req.method === 'PATCH') return await editUpdate(req, res);
    if (req.method === 'DELETE') return await deleteUpdate(req, res);
    res.setHeader('Allow', 'POST, PATCH, DELETE');
    return res.status(405).end();
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  }
};
