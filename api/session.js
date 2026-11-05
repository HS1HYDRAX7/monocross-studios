const { isAdmin, checkPassword, setSessionCookie, clearSessionCookie, configError } = require('../lib/auth');

// Vercel parses JSON bodies, but accept a raw string too in case the content type is missing.
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch (err) {
    return {};
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const problem = configError();
    if (problem) return res.status(500).json({ error: problem });
    return res.status(200).json({ admin: isAdmin(req) });
  }
  if (req.method === 'POST') {
    const problem = configError();
    if (problem) return res.status(500).json({ error: problem });
    const { password } = readBody(req);
    if (!checkPassword(password)) return res.status(401).json({ error: 'Wrong password' });
    setSessionCookie(res);
    return res.status(200).json({ admin: true });
  }
  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    return res.status(200).json({ admin: false });
  }
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
};
