const { isAdmin, checkPassword, setSessionCookie, clearSessionCookie } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ admin: isAdmin(req) });
  }
  if (req.method === 'POST') {
    const password = req.body && req.body.password;
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
