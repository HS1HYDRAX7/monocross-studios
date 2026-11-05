const b2 = require('./b2');
const { GAMES } = require('./games');

// The whole devlog lives in one file in the bucket: devlog.json
const FILE = 'devlog.json';

// Always returns every game in GAMES, in order, even if the file has no entry for one of them yet.
async function loadDevlog() {
  const stored = (await b2.readJson(FILE)) || { games: [] };
  const games = GAMES.map(game => {
    const found = stored.games.find(entry => entry.slug === game.slug);
    return found || { slug: game.slug, name: game.name, updates: [] };
  });
  return { games };
}

async function saveDevlog(data) {
  await b2.uploadBytes(FILE, JSON.stringify(data, null, 2), 'application/json', {
    'X-Bz-Info-b2-cache-control': 'no-cache',
  });
}

module.exports = { loadDevlog, saveDevlog };
