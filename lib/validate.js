const { GAMES } = require('./games');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const UPDATE_CODE = /^[A-Za-z0-9]{12}$/;
// Lookup key for an update. New updates use a 12-character code; older ones use their version.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isGame(slug) {
  return GAMES.some(game => game.slug === slug);
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new HttpError(400, `${label} may only use letters, numbers, dots, dashes and underscores`);
  }
  return value;
}

function extensionOf(name) {
  return name.slice(name.lastIndexOf('.')).toLowerCase();
}

function isUpdateId(value) {
  return typeof value === 'string' && UPDATE_CODE.test(value);
}

function safeId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new HttpError(400, 'Invalid update code');
  return value;
}

function safeMediaName(value) {
  if (typeof value !== 'string' || !SAFE_FILE.test(value)) throw new HttpError(400, 'Invalid file name');
  if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(extensionOf(value))) {
    throw new HttpError(400, 'Unsupported file type');
  }
  return value;
}


const CONTENT_TYPE_EXTENSIONS = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
};

function mediaContentTypeMatchesName(name, contentType) {
  if (typeof name !== 'string' || typeof contentType !== 'string') return false;
  return (CONTENT_TYPE_EXTENSIONS[contentType] || []).includes(extensionOf(name));
}

function mediaSignatureMatches(bytes, contentType) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (contentType === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (contentType === 'video/mp4') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (contentType === 'video/webm') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function mediaType(name) {
  return VIDEO_EXTENSIONS.includes(extensionOf(name)) ? 'video' : 'image';
}

function cleanText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${label} is required (max ${max} characters)`);
  return text;
}

module.exports = { HttpError, isGame, isUpdateId, safeId, safeSegment, safeMediaName, mediaType, mediaContentTypeMatchesName, mediaSignatureMatches, cleanText };
