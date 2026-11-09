const gameSchema = {
  type: 'object',
  properties: {
    slug: { type: 'string', example: 'bloodtubies' },
    name: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string', enum: ['released', 'in_development'] },
    platforms: { type: 'object', description: 'Windows and Android availability, URL, and version.' },
  },
};

const updateSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    date: { type: 'string', format: 'date' },
    title: { type: 'string' },
    paragraphs: { type: 'array', items: { type: 'string' } },
    media: {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string', enum: ['image', 'video'] }, src: { type: 'string', format: 'uri' }, alt: { type: 'string' } } },
    },
  },
};

const devlogGameSchema = {
  ...gameSchema,
  properties: { ...gameSchema.properties, updates: { type: 'array', items: updateSchema } },
};

const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Monocross Studios Public API',
    version: '1.0.0',
    description: 'Read-only game catalog, development updates, and RSS feed. No API key required. Public JSON endpoints support cross-origin GET requests.',
  },
  servers: [{ url: 'https://monocross-studios.vercel.app' }],
  paths: {
    '/api/games': {
      get: {
        summary: 'List the studio game catalog',
        responses: {
          '200': {
            description: 'Game details and platform availability.',
            content: { 'application/json': { schema: { type: 'object', properties: { games: { type: 'array', items: gameSchema } } } } },
          },
        },
      },
    },
    '/api/devlog': {
      get: {
        summary: 'Get games and development updates',
        responses: {
          '200': {
            description: 'Public development log. Media links expire after one week.',
            content: { 'application/json': { schema: { type: 'object', properties: { games: { type: 'array', items: devlogGameSchema } } } } },
          },
        },
      },
    },
    '/api/site-config': {
      get: {
        summary: 'Public studio info: official links, games and service status',
        responses: { '200': { description: 'Studio links (Discord, TikTok), games and status.' } },
      },
    },
    '/api/serve': {
      post: {
        summary: 'Campaigns for one authorized site (used by embed.js)',
        description: 'Body (text/plain or JSON): site, token, path, lang, device. The calling domain must be on the site whitelist, otherwise 403.',
        responses: { '200': { description: 'Eligible campaigns, highest priority first.' }, '403': { description: 'Unknown site, wrong token or domain not allowed.' }, '429': { description: 'Rate limit reached.' } },
      },
    },
    '/api/events': {
      post: {
        summary: 'Count an impression, click or close (used by embed.js)',
        description: 'Body: site, token, campaign, type (impression, click or close).',
        responses: { '204': { description: 'Counted.' }, '403': { description: 'Not allowed.' }, '429': { description: 'Rate limit reached.' } },
      },
    },
    '/api/feed': {
      get: {
        summary: 'Subscribe to the RSS updates feed',
        responses: {
          '200': { description: 'RSS 2.0 feed.', content: { 'application/rss+xml': { schema: { type: 'string' } } } },
        },
      },
    },
  },
};

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end();
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return req.method === 'HEAD' ? res.status(200).end() : res.status(200).json(SPEC);
};
