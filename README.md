# AFFiNE Inbox Clipper (Firefox)

Clips web pages into **one AFFiNE sidebar folder, your Inbox**, so they stay out of the notes you've already sorted. A clip is short by default: a link card, a source line, your note, a summary, the intro, and the page's section outline. A full-article mode is there when you need it.

An unofficial, community-made clipper (not affiliated with AFFiNE / Toeverything). Works in Firefox 140+ and Firefox-based browsers (LibreWolf, Zen, Floorp, Waterfox, Mullvad Browser).

## What a clip looks like (Key info mode)

```
How Sourdough Works                         ← title (site-name suffix removed)
[ link card: title · description · image ]
Source: Bread Lab · by Jane Baker · published 2026-09-30 · ~6 min read · clipped 2026-10-19
Why I saved this: <your note>
### Summary        – the page's own description
### Intro          – first 1–6 real paragraphs (default 2), trimmed
### Key sections   – the article's H2/H3 outline as bullets (or key sentences if it has no headings)
### Highlights     – whatever you had selected, as quotes
────────
Read the original → https://…
```

Other modes in the popup:

| Mode | Saves |
|---|---|
| Key info | Everything above (default) |
| Snippet | Link card, source line, note, one quoted excerpt |
| Selection | Link card, source line, note, your selected text as quotes |
| Full article | Link card, source line, note, then the whole reader-mode article (headings, lists, quotes, code, links kept; ads/nav stripped; images become links) |

## Install

**Try it now (until the browser restarts):** `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → pick `manifest.json` inside the `dist` folder (or the `.xpi`).

**Keep it installed:** Firefox release only keeps signed add-ons. Two options:
1. Sign it for free as a private (unlisted) add-on: make API keys at addons.mozilla.org → *Developer Hub* → *Manage API Keys*, then run
   `npx web-ext sign -s dist --channel unlisted --api-key=… --api-secret=…` and install the signed `.xpi` it downloads. Not published anywhere.
2. In LibreWolf, Firefox Developer Edition, Nightly or ESR: set `xpinstall.signatures.required` to `false` in `about:config`, then drag the `.xpi` onto the browser.

## Set up

1. Sign in to AFFiNE in a normal tab (the clipper uses that login; no passwords or tokens are stored).
2. The settings page opens on install (or right-click the toolbar icon → *Manage Extension* → *Preferences*).
3. Server URL: `https://app.affine.pro` for AFFiNE Cloud. When you move to self-hosted, change it to your server (for example `https://affine.yourdomain.com`) and click **Connect** again.
4. Pick the workspace and your **Inbox** folder (or click *Create folder*). Save.

## Using it

- Toolbar button / **Alt+Shift+C**: popup with title, mode, note and tags.
- **Alt+Shift+A**: quick clip with your defaults (uses Selection mode if text is selected).
- Right-click → *Clip page / selection / link to AFFiNE Inbox* (shows a notification when done).

The new doc appears in the Inbox folder and in *All docs*. From there you can drag it into another folder, link it from a project page with `@`/`[[`, or copy blocks out of it.

## How it works

AFFiNE stores docs as Yjs CRDTs and has no "create page" REST endpoint, so the clipper talks to the server the same way the AFFiNE web app does:

1. GraphQL (`/graphql`, with your session cookie) to check the login, detect the server version and list workspaces.
2. Socket.IO realtime connection → `space:join` the workspace.
3. Builds the page as a Yjs doc (page → surface + note → paragraph/list/bookmark/code blocks) and pushes it with `space:push-doc-update`.
4. Adds the page to the workspace's page list (title, dates, tags) and records you as the creator.
5. Adds a `doc` link node under your Inbox folder in the `db$<workspace>$folders` table, the same record the sidebar creates when you drag a doc into a folder.

The protocol details follow the open-source [affine-mcp-server](https://github.com/DAWNCR0W/affine-mcp-server), which is tested against AFFiNE 0.26–0.27.

## Troubleshooting

- **"Not signed in"**: open the server URL in a tab, sign in, then click Connect again. Strict cookie settings for that site, or a container tab, can hide the login from the extension.
- **"Could not open workspace" / version errors**: the clipper sends your server's own version as its client version. If the server rejects it, check that the server URL is the AFFiNE root (not `/workspace/...`).
- **Saved but "not filed"**: the Inbox folder was deleted or renamed in another workspace. Pick it again in settings.
- **Page can't be read** (about:, addons.mozilla.org, PDFs in the built-in viewer): the clip falls back to title + link.

## Develop

```
npm install
npm run build     # bundles src/ + static/ into dist/
npm test          # extraction + doc-building + mock-server round trip
npm start         # launches Firefox with the add-on loaded
npm run package   # zips dist/ for signing
```

Source layout: `src/affine/client.js` (AFFiNE GraphQL/socket client), `src/affine/blocks.js` (Yjs page builder), `src/content/extract.js` (in-page extraction with Mozilla Readability), `src/compose.js` (what goes in a clip), `src/background.js`, `src/popup.js`, `src/options.js`.

## License

MIT. AFFiNE is a trademark of Toeverything; this project is not affiliated with them.
