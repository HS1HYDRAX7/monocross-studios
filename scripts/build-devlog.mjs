// Embeds the devlog into index.html, built from the update folders:
//   assets/<game>/updates/<version>/update.txt  (plus images and videos in the same folder)
// Run with: npm run build   (or: node scripts/build-devlog.mjs)
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = join(ROOT, 'index.html');
const START = '<!-- devlog-data:start -->';
const END = '<!-- devlog-data:end -->';

// Games shown in the devlog, in tab order. Each slug is a folder under assets/.
const GAMES = [
  { slug: 'bloodtubies', name: 'Bloodtubies I' },
  { slug: 'decadent', name: 'Decadent' },
];

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm'];

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// update.txt: "key: value" lines, then a line with ---, then the body.
// Body paragraphs are separated by blank lines.
function parseUpdate(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const separator = lines.indexOf('---');
  const header = separator === -1 ? lines : lines.slice(0, separator);
  const body = separator === -1 ? [] : lines.slice(separator + 1);

  const meta = {};
  for (const line of header) {
    const match = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (match) meta[match[1].toLowerCase()] = match[2].trim();
  }

  const paragraphs = body
    .join('\n')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  return { meta, paragraphs };
}

async function readUpdates(slug) {
  const updatesDir = join(ROOT, 'assets', slug, 'updates');
  if (!(await isDirectory(updatesDir))) return [];

  const versions = (await readdir(updatesDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  const updates = [];
  for (const version of versions) {
    const folder = join(updatesDir, version);
    const files = (await readdir(folder)).sort();
    const textFile = files.find(name => name.toLowerCase() === 'update.txt');
    if (!textFile) {
      console.warn(`Skipped ${slug}/${version}: no update.txt`);
      continue;
    }

    const { meta, paragraphs } = parseUpdate(await readFile(join(folder, textFile), 'utf8'));
    if (!meta.date) console.warn(`${slug}/${version}: missing "date:" in update.txt`);

    // An image with the same name as a video (clip.mp4 + clip.png) is that video's poster.
    const videoNames = new Set(
      files
        .filter(f => VIDEO_EXTENSIONS.includes(extname(f).toLowerCase()))
        .map(f => basename(f, extname(f)))
    );

    const media = [];
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      const src = `assets/${slug}/updates/${version}/${file}`;

      if (IMAGE_EXTENSIONS.includes(ext)) {
        if (videoNames.has(basename(file, extname(file)))) continue;
        media.push({ type: 'image', src, alt: meta.title || '' });
      } else if (VIDEO_EXTENSIONS.includes(ext)) {
        const posterFile = files.find(
          f => IMAGE_EXTENSIONS.includes(extname(f).toLowerCase()) && basename(f, extname(f)) === basename(file, ext)
        );
        media.push({
          type: 'video',
          src,
          poster: posterFile ? `assets/${slug}/updates/${version}/${posterFile}` : undefined,
        });
      }
    }

    updates.push({
      version,
      date: meta.date || '',
      title: meta.title || version,
      paragraphs,
      media,
    });
  }

  // Newest first; versions break ties.
  updates.sort(
    (a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true })
  );
  return updates;
}

const games = [];
for (const game of GAMES) {
  games.push({ slug: game.slug, name: game.name, updates: await readUpdates(game.slug) });
}

const page = await readFile(PAGE, 'utf8');
const from = page.indexOf(START);
const to = page.indexOf(END);
if (from === -1 || to === -1) throw new Error(`index.html needs the ${START} and ${END} markers`);

// Escape "<" so the JSON can never close the script tag early.
const json = JSON.stringify({ games }, null, 2).replace(/</g, '\\u003c');
const block = `${START}\n<script type="application/json" id="devlog-data">\n${json}\n</script>\n${END}`;
await writeFile(PAGE, page.slice(0, from) + block + page.slice(to + END.length));

console.log('index.html updated with the devlog:', games.map(g => `${g.name} (${g.updates.length})`).join(', '));
