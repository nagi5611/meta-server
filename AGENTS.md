# AGENTS.md

## Cursor Cloud specific instructions

This repo (`meta-server`) is a multiplayer 3D "metaverse": a Node.js/Express + Socket.io + mediasoup
backend (`server.js`) plus a Three.js client under `public/`. Dependencies install with `npm install`
(native modules `mediasoup`, `better-sqlite3`, and `sharp` compile/download during install; the VM
toolchain already satisfies them). Persistence is embedded SQLite (no external DB/service). Test, build,
and run commands live in `package.json` scripts — refer to those rather than duplicating them here.

### Services
- Backend (Express + Socket.io + mediasoup): `node server.js`, port `3000` (serves `/api`, `/admin`,
  `/socket.io`, static assets; spawns mediasoup workers on startup).
- Vite dev server: port `3001`, proxies `/api`, `/socket.io`, `/admin`, `/js`, etc. to `:3000`.
- `npm run dev` runs both concurrently (backend via nodemon, then Vite).

### Required env var to start the backend (non-obvious)
The server refuses to start without storage-path env vars (`config/storage-paths.js` throws
`Missing required env var: META_MODELS_DIR`). The simple option is a single base dir via
`META_SRC_DIRECTORY` (the server creates `data/`, `db/`, `models/`, `env/`, ... under it).
`server.js` loads `dotenv/config`, so a gitignored `.env` works.

IMPORTANT: point `META_SRC_DIRECTORY` at a dir OUTSIDE the repo (this project unusually *tracks*
`db/*.db`, so pointing it at the repo root dirties tracked files and litters the root with runtime
dirs). The committed `.cursor/environment.json` `dev` terminal defaults it to `$HOME/.meta-runtime`.
No secrets are required for dev; everything else has safe defaults.

### Full 3D world page requires a build (dev-server caveat)
`vite.config.js` proxies `/js/*` to the backend, so under `npm run dev` the main app entry
`/js/main.js` is served raw and its bare `import ... from 'three'` fails in the browser with
"Failed to resolve module specifier 'three'" — the 3D world page does NOT render under plain
`npm run dev`. The Three.js world is meant to be served bundled. To run the full 3D app, build and
serve via the backend in production mode:
`npm run build` then
`NODE_ENV=production HOST=127.0.0.1 SOCKET_AUTH_SECRET=<>=16 chars> ADMIN_PASSWORD=<>=16 chars> SOCKET_CORS_ORIGINS=http://localhost:3000 node server.js`
(the backend serves `dist/` only when `NODE_ENV=production` AND `dist/index.html` exists; with
`HOST=0.0.0.0` you must also set `ALLOW_LAN_BIND=1`). The login / admin / student / teacher / qr-ar
pages use CDN import maps and work under `npm run dev`.

### Entering the world (core flow)
New users are redirected to `/login/`. Setting a custom guest display name is refused unless
`GEMINI_API_KEY` is set (name moderation), so to enter as a guest leave the nickname field EMPTY and
submit — the server assigns a `GuestNNNN` name, connects the socket, and loads the world.

### WebGL / GPU limitation (headless rendering)
The VM has no GPU. Chrome needs SwiftShader for WebGL
(`--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader --ignore-gpu-blocklist`), and even
then CPU software rendering of the continuously-animating scene is too slow to reliably screenshot via
CDP or headless one-shot mode. The managed computer-use Chrome has WebGL disabled entirely (the 3D
canvas shows black while the rest of the app UI/HUD works). Prefer console-log / API / automated-test
evidence for the 3D client rather than screenshots of the rendered scene.

### Optional integrations (off by default, safe to ignore in dev)
Gemini (`GEMINI_API_KEY`), Cloudflare TURN (`CLOUDFLARE_TURN_*`), AWS S3/CloudFront (prod-only,
`USE_S3_MODELS=1`), and `MEDIASOUP_ANNOUNCED_IP` (needed only for real WebRTC over LAN).
