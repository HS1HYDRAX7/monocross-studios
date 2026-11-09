# Monocross Studios

Static website with a small admin panel at `/admin`. Hosted on Vercel. Devlog data and update media are stored in DBByte (S3-compatible object storage).

## Structure

```
index.html              the website
admin/index.html        admin panel (/admin)
api/                    Vercel functions: public catalog, devlog, RSS/OpenAPI, admin and uploads
lib/                    server code: storage (DBByte), devlog, auth, validation, games list
assets/bloodtubies/     icons and covers used by the site
vercel.json             output directory and the /admin rewrite
```

## Public API

The read-only endpoints are public, require no API key, and allow cross-origin GET requests:

- `GET /api` — OpenAPI 3.1 document describing the public endpoints.
- `GET /api/games` — game catalog, status, descriptions, and platform availability.
- `GET /api/devlog` — catalog plus development updates and temporary media URLs.
- `GET /api/feed` — RSS 2.0 feed for update readers and aggregators.

The media URLs in the devlog expire after one week. Use the RSS feed for subscriptions; use `/api/devlog` when you need current media links.

## Environment variables

Set these in Vercel: Project → Settings → Environment Variables.

| Name | Value |
| --- | --- |
| `DBBYTE_ACCESS_KEY_ID` | DBByte access key ID |
| `DBBYTE_SECRET_ACCESS_KEY` | DBByte secret access key |
| `ADMIN_PASSWORD` | Password for the admin panel |
| `ADMIN_SESSION_SECRET` | Long random text used to sign the admin session |

The endpoint (`s3.dbbyte.com`), region and bucket name (`monocross-studios`) are set in `lib/storage.js`. They are not secrets.

Remove the old Backblaze variables (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_ID`, `B2_BUCKET_NAME`) once the switch is done.

Also remove any Build Command left over in the Vercel settings. This project no longer has a build step.

## Storage setup

1. Create the bucket `monocross-studios` in DBByte.
2. Keep the bucket private. The server signs each media link for one week, so files stay hidden from anyone without a link from the devlog.
3. Images under 4 MB work even without a CORS rule, because they fall back to `/api/upload-file`, which checks the file signature before storing it. Videos and larger files upload straight from the browser; their one-hour signed URL binds the declared `Content-Type`. The bucket still needs a CORS rule that allows `PUT` from `https://monocross-studios.vercel.app` (and `http://localhost:3000` if you test locally).

## Publishing an update

1. Open `/admin` and log in.
2. Pick the game, write the version (for example `0.0.2`), the date, the title and the text. Separate paragraphs with a blank line.
3. Select images or videos. They are published in the order you select them.
4. Click Publish. The files go straight to storage, then the update is added to `devlog.json`.

Deleting an update in the panel removes it from the devlog and deletes its files in the bucket.

## Notes

- Media links expire after a week. The website and admin get fresh links every time they read the devlog, so nothing needs to be done when a link expires.
- If an upload finishes but saving fails, the files stay in `updates/<game>/<version>/`. Delete them in the DBByte dashboard before trying again with the same version.
- To add a game, add it to `lib/games.js` and to the `GAMES` list at the top of `admin/index.html`.
- Admin sessions last 7 days. Changing `ADMIN_SESSION_SECRET` signs everyone out immediately.
- Sign-in is limited to 10 failed attempts per client every 15 minutes (best effort; each server instance counts separately).

## Tests

Run the dependency-free API and upload checks with `node --test tests/*.test.js`. These cover public response boundaries, RSS escaping, OpenAPI routes, upload type/signature validation, and signed upload headers.


## Campaigns, popups and ads (v14)

The official site shows the Discord and TikTok popups through its own API, and partner sites can show ads with one script tag. Manage everything at `/admin/ads`. Full docs: `docs/API-AND-EMBED.md`. Test list: `docs/TEST-CHECKLIST.md`. Example partner page: `examples/external-site.html`. Run the tests with `node --test tests/*.test.js`.
