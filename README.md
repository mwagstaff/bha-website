# Beckenham & Bromley Historical Association — website POC

A modern, mobile-friendly rebuild of beckenham-historical-association.org (Node.js + Express + EJS).

```bash
npm install
npm run dev     # http://localhost:3000 (auto-restarts on change)
```

## Editing content

**Events** are edited on the website itself at **`/edit-content`** (username and password; nothing on the public site links there, and the old `/admin` and `/event-editing` addresses are plain 404s). Each event is a card showing exactly how it will look on the site; **Edit** opens its fields (date picker, time, type, title, speaker, intro, location, description, note) with a live preview, and there's **+ Add an event**, **Duplicate** and **Delete** (with an in-page confirmation). Nothing is published until **Save changes**; **Undo all changes** discards everything since the last save.
Saves are atomic and refuse to overwrite someone else's newer save.

**Formatting:** Description and Note have a small toolbar (bold, italic, underline, link, remove link). It's stored in the events file as a tiny subset of HTML (`<b> <i> <u> <a href> <br>`), and is passed through an allowlist ([`lib/richtext.js`](lib/richtext.js), using `sanitize-html`) both when saving and when showing it on the site, so nothing else can reach the public pages. Pasted text arrives plain. The calendar feed gets a plain-text version.

**Where content is kept** ([`lib/storage.js`](lib/storage.js)): with `BHA_STORAGE=file` (the default; live, for now) the events, page text and version history are files in the data folder, as described below. With `BHA_STORAGE=mongo` (the preview) they're in MongoDB at `MONGODB_URI_BHA` (database `bha`): one `content` document each for the events (stored as structured fields) and the page text, a `history` collection with the same 7-day/10-version rules, and an `enquiries` collection recording every form submission and whether its email went, so none is lost if Plunk fails. A save only goes through if nobody else saved since the editor was opened. The first time Mongo is used, the data folder's files and their history are copied in; after that the files are ignored. The public pages never wait for Mongo: they're drawn from a copy in memory, refreshed after every save and every minute, so if Mongo is down the site keeps showing the last copy (or, straight after a restart, the copy in `content/live/`), and `/healthcheck` reports `"database": "unreachable"`. The site's Mongo user (`bha_service`, read/write on `bha` only) is set up on both servers by [`scripts/mongo-user.zsh`](scripts/mongo-user.zsh); mini requires logins, sky doesn't (yet).

**Version history** (`/edit-content/history`): every save keeps a timestamped copy in the backups folder (`$BHA_BACKUP_DIR`, default `$BHA_DATA_DIR/backups`; on mini `~/.local/share/bha-website/backups`). Versions from the last 7 days are kept, and the newest 10 are always kept however old. Each version can be compared with what's live ([`lib/diff.js`](lib/diff.js)): events that would be added back or removed are shown in full, and changed events show each differing field side by side with the changed words highlighted. Events are matched by date and title, then by date alone (single-event days only) or title alone, so a renamed or moved event shows as one change. Any version can be put back; putting one back always saves an automatic backup of the live version first, so a restore can itself be undone. File names record when and why each version was made (`…--saved--…`, `…--before-restore--…`, `…--restored--from-…`).

The cards are saved into a plain-text file, `$BHA_DATA_DIR/events.txt` (locally `var/events.txt`; on mini `~/.local/share/bha-website/events.txt`), kept outside the deployed code so deploys never overwrite edits.
[`content/events.txt`](content/events.txt) is only the starting copy, used when no live file exists yet.

The parser ([`lib/events.js`](lib/events.js)) is deliberately forgiving, in case the file is ever edited by hand: it accepts lots of date and time styles, any capitalisation, one-letter typos in labels, and a forgotten colon or blank line.
Anything it can't understand is left off the site (never breaking the page) and appears in the editor under **Needs a look**, showing the text as typed so it can be fixed or deleted.

**Calendar subscription:** `/events.ics` is a live iCalendar feed of the same events (Europe/London times; lectures default to Christ Church Hall). The Events page has one-tap subscribe buttons for Apple Calendar (`webcal://`), Google Calendar and Outlook, plus a copyable address and a download. Subscribed calendars refresh by themselves (the feed asks for every 12 hours; Google decides its own schedule, often slower).

**Page text** is edited at **`/edit-content/pages`**: taglines, introductions, the Events info boxes, membership and bulletin wording, the postal address, the Links list, contact names, roles and email addresses (the Events booking contact and the three Contact Us cards), where each form is sent, and travel directions. The sections and their original wording are defined in [`lib/pages.js`](lib/pages.js) (each has a page, label, hint, kind and default). Values are saved to `$BHA_DATA_DIR/pages.json` and checked one by one when read, so a damaged or missing value falls back to its default rather than breaking a page; with no file at all, the site shows the original wording. The editor previews the real page (rendered by the server with the unsaved text, scripts removed) and has its own 7-day version history (`$BHA_BACKUP_DIR/pages`), with the original wording kept as the first version.

The Branch Membership Form PDF is [`public/files/branch-membership-form-2026-27.pdf`](public/files/branch-membership-form-2026-27.pdf) (the old `/membershipA.pdf` address redirects to it); for a new year, add the new PDF to `public/files/`, point the link in Page text → Membership at it, and update `MEMBERSHIP_FORM` in `lib/pages.js` (the default link and the redirect).

The layout, photos, menu, headings and buttons stay in the templates; venue details, the map and images are in [`data/site.js`](data/site.js).

### Editor login

The editor is locked unless both `BHA_EDITOR_USERNAME` and `BHA_EDITOR_PASSWORD` (8+ characters) are set. Usernames are matched ignoring capitals and spaces; passwords exactly. Changing either logs everyone out; logins otherwise last 30 days, renewed on each visit. Five wrong attempts lock that address out for 15 minutes. The login cookie is only sent to `/edit-content` pages.

- **Locally:** put `BHA_EDITOR_USERNAME=...` and `BHA_EDITOR_PASSWORD=...` in `.env.local` (git-ignored, never deployed); `npm run dev` loads it.
- **On mini:** create Bitwarden login items named `BHA_EDITOR_USERNAME` and `BHA_EDITOR_PASSWORD` in the deploy folder, each with its value in the Password field and a custom field `Apps` containing `bha-website` (no other custom fields: the deploy uses the first non-`Apps` custom field ahead of the Password field). Then deploy with Bitwarden: `~/dev/server-tooling/deploy/node_project.zsh bha bw`.

```bash
npm test        # parser, editor/login and saving tests, plus a check of the real events file
```

## Structure

- `server.js` — routes (same six pages as the old site; old `*.php` URLs 301-redirect to the new ones)
- `routes/admin.js`, `lib/auth.js` — the events editor and its login
- `lib/storage.js` — where content is kept (files or Mongo), the import into Mongo and the in-memory copy for the public pages
- `lib/events.js` — events parsing, display helpers and saving
- `lib/ical.js` — the calendar feed
- `lib/richtext.js` — formatting allowlist; `lib/history.js` — version history and retention
- `lib/pages.js` — editable page text: sections, defaults, checking and comparison
- `public/js/pages-editor.js` — the Page text editor
- `public/js/rich-editor.js` — the formatting toolbar
- `views/` — EJS templates and shared partials (header, hero, footer, enquiry form, event card)
- `public/css/site.css` — all styling (light and dark themes)
- `public/js/site.js` — mobile menu, event filters, form validation
- `public/js/editor.js` — the card editor (live previews, add/duplicate/delete, save, unsaved-changes warning)
- `public/images/` — public-domain historic photographs of Beckenham from Wikimedia Commons

## Deployment

| | Address | Host | Deploy |
|---|---|---|---|
| Live | https://bha.skynolimit.dev (test address), then https://beckenham-historical-association.org | sky (port 3050, user systemd `com.bha-website.web`) | `npm run deploy:live` |
| Preview | https://bha-preview.skynolimit.dev | mini (port 3050, launchd `com.bha-website.web`) | `npm run deploy:preview` |

Both deploy commands first run `npm run pull-content` (below), then `~/dev/server-tooling/deploy/node_project.zsh bha-live bw` or `… bha bw`; Bitwarden asks for the master password.

**Content edited on the website is never overwritten by a deploy:** it lives in Mongo or in the data folder, outside the deployed code (`/var/` is excluded from the copy). To keep it in git too, [`scripts/pull-content.zsh`](scripts/pull-content.zsh) (`npm run pull-content`) runs [`scripts/export-content.js`](scripts/export-content.js) on the server (which reads from files or Mongo, whichever the site uses) and writes the live site's events and page text as `events.txt` and `pages.json` into [`content/live/`](content/live) and commits just those files ("Content from the live site, …"), doing nothing if they haven't changed. `npm run pull-content -- preview` copies the preview's into `content/preview/` instead, and `--no-commit` stages without committing. The repository is public, so where the forms are sent (the private page-text settings) is left out of the copy. Nothing goes the other way: the website stays the place content is edited, and `content/events.txt` is still only the starting copy for a new site.

Saved page text always wins over the defaults in `lib/pages.js` (after the first save, `pages.json` holds every section), so changing a default's wording in code doesn't change a site that has saved page text. Edit it on the site instead, or, for something like a moved link, upgrade the saved value when it's read (see `upgradeSaved`).

Traffic flows Cloudflare → sky's `api-skynolimit` tunnel → sky's Caddy → the live site on sky, or over Tailscale to the preview on mini.
Routing lives in `server-tooling/caddy/setup-caddy-cloudflare-tunnel.zsh`; deploy config (`bha-website` and `bha-website-live`) in `server-tooling/deploy/config/node_projects.json`.

**On sky the site is kept small:** it runs on its own pinned Node 24 (`~/.local/share/bha-website/runtime/node24`), with a 48 MB heap cap (`NODE_OPTIONS`) and systemd `MemoryHigh=96M` / `MemoryMax=128M`. It uses about 70–80 MB. Live data is in `~/.local/share/bha-website` on sky, separate from the preview's.

**Caching:** public pages and `/events.ics` send `s-maxage=300`, and a Cloudflare Cache Rule (in both the `skynolimit.dev` and `beckenham-historical-association.org` zones) makes them cacheable, so edits appear within 5 minutes. Browsers always revalidate pages (the rule respects the origin's browser TTL). `/edit-content` and `/healthcheck` are never cached.

**Enquiry emails** (Membership enquiry and Bulletin "Register your interest") go through Plunk (`lib/enquiry.js`), from `BHA_EMAIL_FROM`, with the enquirer as reply-to. Where each form is sent is set in **Page text** on that form's page (not shown on the site). Until changed there, membership enquiries go to `BHA_ENQUIRY_TO` (Ann) and bulletin requests to `BHA_BULLETIN_TO` (John); both are set in the live project's `static_env`, and `PLUNK_SECRET_KEY` comes from Bitwarden. Without all three (as on the preview), enquiries are only logged. A hidden honeypot field drops most bot submissions.

**DNS:** the domain is registered at Network Solutions (Register.com) with Cloudflare's nameservers. [`deploy/cloudflare-zone.txt`](deploy/cloudflare-zone.txt) mirrors the Cloudflare zone: apex and www go to the tunnel, and the MX, SPF and `mail` records keep Ann's Network Solutions mailbox (ann.wagstaff@beckenham-historical-association.org) working. Don't replace them with "no mail" records while that mailbox is in use.
