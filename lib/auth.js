const crypto = require('crypto');

const COOKIE = 'mc_admin';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

// Values pasted into Vercel can carry stray spaces or line breaks, so trim them.
function envValue(name) {
  return (process.env[name] || '').trim();
}

// Names of missing server settings. Logged on the server only, never shown to visitors.
function configError() {
  const missing = ['ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'].filter(name => !envValue(name));
  return missing.length ? 'Missing on the server: ' + missing.join(', ') : null;
}

function sign(payload) {
  return crypto.createHmac('sha256', envValue('ADMIN_SESSION_SECRET')).update(payload).digest('hex');
}

// Cookie value: "<expiry in ms>.<signature>". The signature covers the expiry, so it cannot be extended.
function issueToken() {
  const expires = Date.now() + SESSION_MS;
  return `${expires}.${sign(`admin|${expires}`)}`;
}

function validToken(value) {
  const [expires, signature] = String(value || '').split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(`admin|${expires}`));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
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
  return validToken(readCookie(req.headers.cookie, COOKIE));
}

function checkPassword(password) {
  const expected = envValue('ADMIN_PASSWORD');
  if (!expected || typeof password !== 'string') return false;
  const given = Buffer.from(password.trim());
  const real = Buffer.from(expected);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

// Best-effort throttle per client. Each serverless instance keeps its own count, so treat it as a brake, not a lock.
const failures = new Map();

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function tooManyAttempts(req) {
  const record = failures.get(clientKey(req));
  return Boolean(record) && Date.now() - record.first < FAILURE_WINDOW_MS && record.count >= MAX_FAILURES;
}

function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const record = failures.get(key);
  if (!record || now - record.first >= FAILURE_WINDOW_MS) {
    if (failures.size > 1000) failures.clear();
    failures.set(key, { count: 1, first: now });
  } else {
    record.count += 1;
  }
}

function clearFailures(req) {
  failures.delete(clientKey(req));
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${issueToken()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

module.exports = {
  configError, isAdmin, checkPassword, setSessionCookie, clearSessionCookie,
  tooManyAttempts, recordFailure, clearFailures,
};
