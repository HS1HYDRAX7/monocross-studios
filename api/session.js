const {
  isAdmin, checkPassword, setSessionCookie, clearSessionCookie,
  configError, tooManyAttempts, recordFailure, clearFailures,
} = require('../lib/auth');

// Vercel parses JSON bodies, but accept a raw string too in case the content type is missing.
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch (err) {
    return {};
  }
}

// Visitors get a generic message. The specific setting that is missing goes to the server log only.
function notConfigured() {
  console.error('[admin] ' + configError());
  return 'The admin panel is not configured yet.';
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (configError()) return res.status(503).json({ error: notConfigured() });
    return res.status(200).json({ admin: isAdmin(req) });
  }

  if (req.method === 'POST') {
    if (configError()) return res.status(503).json({ error: notConfigured() });
    if (tooManyAttempts(req)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
    }
    const { password } = readBody(req);
    if (!checkPassword(password)) {
      recordFailure(req);
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }
    clearFailures(req);
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
