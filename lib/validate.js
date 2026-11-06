const { GAMES } = require('./games');

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
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

function safeMediaName(value) {
  if (typeof value !== 'string' || !SAFE_FILE.test(value)) throw new HttpError(400, 'Invalid file name');
  if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(extensionOf(value))) {
    throw new HttpError(400, 'Unsupported file type');
  }
  return value;
}

function mediaType(name) {
  return VIDEO_EXTENSIONS.includes(extensionOf(name)) ? 'video' : 'image';
}

function cleanText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${label} is required (max ${max} characters)`);
  return text;
}

module.exports = { HttpError, isGame, safeSegment, safeMediaName, mediaType, cleanText };
