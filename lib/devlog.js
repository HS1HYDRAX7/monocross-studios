const storage = require('./storage');
const { GAMES } = require('./games');

// The whole devlog lives in one file in the bucket: devlog.json
const FILE = 'devlog.json';
const EMPTY_PLATFORM = { available: false, url: '', version: '' };
const ACTIVITY_LIMIT = 200;

// Updates saved before update codes existed: their version is the key, and their files sit in updates/<game>/<version>/.
function normalizeUpdate(update, slug) {
  return {
    ...update,
    id: update.id || update.version,
    folder: update.folder || `updates/${slug}/${update.version}`,
  };
}

// Always returns every game in GAMES, in order, with defaults filled in for anything not saved yet.
async function loadDevlog() {
  const stored = (await storage.readJson(FILE)) || { games: [] };
  const games = GAMES.map(game => {
    const saved = stored.games.find(entry => entry.slug === game.slug) || {};
    const platforms = saved.platforms || {};
    return {
      slug: game.slug,
      name: game.name,
      description: saved.description || game.description,
      status: saved.status || game.status,
      platforms: {
        windows: { ...EMPTY_PLATFORM, ...(platforms.windows || {}) },
        android: { ...EMPTY_PLATFORM, ...(platforms.android || {}) },
      },
      updates: (saved.updates || []).map(update => normalizeUpdate(update, game.slug)),
    };
  });
  const activity = Array.isArray(stored.activity) ? stored.activity : [];
  return { games, activity };
}

// Records an admin action. Stored with the devlog, but only served to signed-in admins.
function logActivity(data, action, detail) {
  data.activity = [{ at: new Date().toISOString(), action, detail }, ...(data.activity || [])].slice(0, ACTIVITY_LIMIT);
}

async function saveDevlog(data) {
  await storage.uploadBytes(FILE, JSON.stringify(data, null, 2), 'application/json');
}

module.exports = { loadDevlog, saveDevlog, logActivity };
