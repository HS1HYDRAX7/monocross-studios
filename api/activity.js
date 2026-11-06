const { isAdmin } = require('../lib/auth');
const { loadDevlog } = require('../lib/devlog');

// Admin only. The public devlog endpoint never includes this data.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Log in first' });

  try {
    const data = await loadDevlog();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ activity: data.activity.slice(0, 50) });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not load activity. Try again in a moment.' });
  }
};
