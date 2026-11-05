const { loadDevlog } = require('../lib/devlog');

// Public: the website reads the devlog through this endpoint.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    const data = await loadDevlog();
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not load updates' });
  }
};
