const crypto = require('crypto');

const COOKIE = 'mc_admin';

// The session cookie is an HMAC of a fixed string, signed with ADMIN_SESSION_SECRET.
function sessionToken() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('Missing environment variable ADMIN_SESSION_SECRET');
  return crypto.createHmac('sha256', secret).update('admin-session').digest('hex');
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function isAdmin(req) {
  const given = Buffer.from(readCookie(req.headers.cookie, COOKIE));
  const expected = Buffer.from(sessionToken());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function checkPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof password !== 'string') return false;
  const given = Buffer.from(password);
  const real = Buffer.from(expected);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

module.exports = { isAdmin, checkPassword, setSessionCookie, clearSessionCookie };
