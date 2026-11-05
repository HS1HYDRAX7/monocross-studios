# Monocross Studios

Static website for Monocross Studios. Open `index.html` in a browser, or deploy the folder to Vercel.

## Structure

```
index.html                  the website
devlog.json                 generated from the update folders (run npm run build)
package.json                npm scripts
scripts/
  build-devlog.mjs          builds devlog.json
assets/
  bloodtubies/
    icons/                  game icons (one is picked at random on each visit)
    covers/                 artwork for the slideshow and the hero
    updates/
      0.0.1/                one folder per update, named by version
        update.txt
        01-key-art.png
  decadent/
    updates/
      0.0.1/
        update.txt
```

## Adding an update

1. Create a folder in `assets/<game>/updates/` named after the version, for example `0.0.2`.
2. Add an `update.txt` file:

```
title: New boss and fixes
date: 2026-11-20
---
First paragraph of the update.

Second paragraph. Blank lines separate paragraphs.
```

3. Add images or videos to the same folder. They appear in filename order, so use prefixes like `01-`, `02-`. Supported formats: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.mp4`, `.webm`. A video can have a poster image with the same name (`clip.mp4` and `clip.png`).
4. Run `npm run build`, then commit the updated `devlog.json` together with the new folder.

On Vercel, the build command is `npm run build`, so `devlog.json` is regenerated on every deploy. Keep videos under 100 MB, because GitHub rejects larger files.

## Games

Games shown in the devlog are listed in `GAMES` at the top of `scripts/build-devlog.mjs`. Each slug must match a folder under `assets/`.
