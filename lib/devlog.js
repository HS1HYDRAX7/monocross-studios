const b2 = require('./b2');
const { GAMES } = require('./games');

// The whole devlog lives in one file in the bucket: devlog.json
const FILE = 'devlog.json';
const EMPTY_PLATFORM = { available: false, url: '', version: '' };

// Always returns every game in GAMES, in order, with defaults filled in for anything not saved yet.
async function loadDevlog() {
  const stored = (await b2.readJson(FILE)) || { games: [] };
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
      updates: saved.updates || [],
    };
  });
  return { games };
}

async function saveDevlog(data) {
  await b2.uploadBytes(FILE, JSON.stringify(data, null, 2), 'application/json', {
    'X-Bz-Info-b2-cache-control': 'no-cache',
  });
}

module.exports = { loadDevlog, saveDevlog };
