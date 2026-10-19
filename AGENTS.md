# monitor-canvas

A dashboard for a Raspberry Pi. It reads go-server's `/monitor` endpoints and draws them. There is no build step. The page is `index.html` and `main.js` only, plus uPlot from a CDN. `readme.md` says what it shows.

## The live checkout is production

nginx aliases `/monitor-canvas/index.html` and `/monitor-canvas/main.js` straight to this directory (`/etc/nginx/snippets/pi-lan.conf`). Saving either file on master changes the LAN dashboard at once. Work on a branch or a worktree.

Any new file the page loads needs a new nginx `location` as well. Keep page code in those two files.

## Map of `main.js`

Sections are marked `// ---------- name ----------`.

| Section | What it holds | DOM it owns |
|---|---|---|
| small helpers | `storageGet`, `storageSet`, `el`, `css`, formatters, `statusBadge`, `getJSON` | none |
| theme | `applyTheme`, the toggle | `#theme` |
| tiles | `tiles.update(sample, host)` | `#tiles` |
| charts | `charts.render`, `rebuild`, `loading`, `appendLive`, `withGaps`, `CHARTS` | `#charts` |
| logs | `logs.open`, `logs.update`, `LOG_GROUPS`; one `EventSource` per tab | `dialog#logs` and the `logs*` ids inside it |
| services | `renderServices`, `loadEvents` | `#services`, `#svcSummary`, `#events` |
| storage | `loadStorage` | `#storage` |
| range & history | `state.range`, `selectRange`, `loadHistory` | `#ranges`, `#tierNote` |
| live stream | `connect`, the `/monitor/stream` handler | `#conn`, `#host`, `#ports` |

## Conventions

- Build DOM with `el()`. Put every server-supplied string in through `text` or `textContent`, never `innerHTML`. Names come from pm2, Docker and systemd. The one `innerHTML` is the fixed `ICONS` markup.
- Colours are CSS custom properties in `:root`. Redefine each one that changes in dark mode in both dark blocks, the `prefers-color-scheme` media query and `:root[data-theme="dark"]`. A new token goes in all three.
- CDN scripts and stylesheets are pinned to a version and carry an SRI `integrity` hash. To recompute one: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`, then write `sha384-<output>`.
- Touch localStorage only through `storageGet` and `storageSet`. They survive private mode.

## The API contract

It lives in go-server's `monitor` package (`/home/alexis/Projects/go-server/monitor/`). When it changes, update `dev/mock.mjs` in the same change.

## Verify

- `npm run dev` serves the page and a mock API with synthetic data on port 8090. It covers the rare branches: down services, a log that ends with `gone`, a gap in history.
- `npm run check` loads the page in headless Chromium and asserts what renders. Run it before every commit. It needs `/usr/bin/chromium` (or `CHROME=<path>`) and internet for uPlot. Screenshots land in `dev/out/`. Read them.
- `npm run check -- --api http://localhost:8080` runs the same check against the real go-server on the Pi.
- A change to rendering adds or updates an assertion in `dev/check.mjs`.
