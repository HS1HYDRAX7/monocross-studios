const crypto = require('crypto');

const COOKIE = 'mc_admin';

// Values pasted into Vercel can carry stray spaces or line breaks, so trim them.
function envValue(name) {
  return (process.env[name] || '').trim();
}

// Lists every required variable that the server cannot see. Only names are reported, never values.
const REQUIRED = ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'];

function configError() {
  const missing = REQUIRED.filter(name => !envValue(name));
  return missing.length ? 'Missing on the server: ' + missing.join(', ') : null;
}

// The session cookie is an HMAC of a fixed string, signed with ADMIN_SESSION_SECRET.
function sessionToken() {
  return crypto.createHmac('sha256', envValue('ADMIN_SESSION_SECRET')).update('admin-session').digest('hex');
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function isAdmin(req) {
  if (configError()) return false;
  const given = Buffer.from(readCookie(req.headers.cookie, COOKIE));
  const expected = Buffer.from(sessionToken());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function checkPassword(password) {
  const expected = envValue('ADMIN_PASSWORD');
  if (!expected || typeof password !== 'string') return false;
  const given = Buffer.from(password.trim());
  const real = Buffer.from(expected);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

module.exports = { configError, isAdmin, checkPassword, setSessionCookie, clearSessionCookie };
