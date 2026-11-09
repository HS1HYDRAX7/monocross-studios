const { loadDevlog } = require('../lib/devlog');

const SITE = 'https://monocross-studios.vercel.app';

function setPublicHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function xml(value) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rssDate(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString();
}

function updateOrder(a, b) {
  return String(b.date || '').localeCompare(String(a.date || ''))
    || String(b.version || '').localeCompare(String(a.version || ''), undefined, { numeric: true });
}

module.exports = async function handler(req, res) {
  setPublicHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end();
  }

  try {
    const data = await loadDevlog();
    const items = data.games.flatMap(game => (game.updates || []).map(update => ({ game, update })))
      .sort((a, b) => updateOrder(a.update, b.update))
      .slice(0, 100)
      .map(({ game, update }) => {
        const title = `${game.name} ${update.version || ''}: ${update.title || 'Update'}`.trim();
        const description = (Array.isArray(update.paragraphs) ? update.paragraphs : [])
          .map(paragraph => String(paragraph || '')).join('\n\n');
        const guid = `${game.slug}:${update.id || update.version || update.date}`;
        const link = `${SITE}/#updates`;
        return `<item><title>${xml(title)}</title><link>${link}</link><guid isPermaLink="false">${xml(guid)}</guid><pubDate>${rssDate(update.date)}</pubDate><category>${xml(game.name)}</category><description>${xml(description)}</description></item>`;
      }).join('');

    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    if (req.method === 'HEAD') return res.status(200).end();
    const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Monocross Studios updates</title><link>${SITE}/#updates</link><description>Game development updates from Monocross Studios.</description><language>en-us</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}</channel></rss>`;
    return res.status(200).send(body);
  } catch (err) {
    console.error('[public-feed] Could not build RSS feed:', err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(502).json({ error: 'The updates feed is temporarily unavailable.' });
  }
};
