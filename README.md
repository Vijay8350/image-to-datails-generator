# Meesho Listing Generator

Turns a product photo into a **Meesho-compliant catalog listing** (title, description, keywords,
attributes). Two models, split by capability:

- **Gemini** (`gemini-3.5-flash`) reads the image → extracts factual fields.
- **DeepSeek** (`deepseek-v4-flash`) writes the copy → compliant title/description/keywords/attributes.

Both API keys live **only** on the backend. The browser talks solely to this server.

## Architecture

```
Browser ─upload photo→ /api/extract ─→ Gemini (vision)   ─→ extracted fields JSON
        ─fields+cat──→ /api/generate ─→ DeepSeek (text)  ─→ listing JSON
                       /api/rules     ─→ Meesho rules + attribute sets (feeds client validators)
```

- `server.js` — Express proxy: CORS locked to `FRONTEND_ORIGIN`, per-IP rate limiting, in-memory
  image upload (never hits disk), central error handler that never leaks keys.
- `src/config.js` — **all version pins and limits as swappable constants** (models, `TITLE_MAX`,
  `DESC_MAX`, retry policy).
- `src/meesho.js` — single source of truth for compliance: mandatory/optional attributes per
  category, the rejectable checklist, and validators (mirrored client-side via `/api/rules`).
- `src/prompts.js` — Gemini `responseSchema` + instruction; DeepSeek system checklist + user prompt
  with an example JSON shape (required for DeepSeek JSON mode).
- `src/gemini.js` / `src/deepseek.js` — the two model clients (retry/backoff via `src/http.js`).
- `public/` — the single-page UI: photo upload, extracted vs generated fields, per-field character
  counters, live client-side validators, and copy-to-clipboard.

## Setup

Requires **Node ≥ 18.17** (uses the global `fetch`).

```bash
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY and DEEPSEEK_API_KEY
npm start                 # http://localhost:3000
```

`npm run dev` runs with `--watch` for auto-restart.

The UI works without keys (you can browse the flow), but `/api/extract` and `/api/generate` need
valid keys to return real results. The health badge (top-right) shows whether both keys are detected.

## Multi-photo modes

Upload one or many photos. With 2+ photos you choose how they are treated:

- **One product (`combine`, default)** — photos are different angles of the *same* item
  (Meesho wants Front / Zoomed In / Table top). All images go into a **single** Gemini call and
  are consolidated into **one** listing, with per-image QC so you can see which shot fails
  Meesho's image rules. Total upload is capped by `MAX_COMBINED_BYTES` to stay under Gemini's
  per-request ceiling.
- **Different products (`batch`)** — each photo is its own product. One Gemini call per photo at
  `BATCH_CONCURRENCY` parallelism (bounded so we don't self-429), producing **one listing per
  photo**. A single bad photo fails only its own item; the rest of the batch still completes.

API shapes:

```
POST /api/extract   multipart: images[] (or legacy `image`), mode=combine|batch
  combine -> { mode, image_count, fields, warnings, items:[...] }
  batch   -> { mode, count, succeeded, items:[{index, filename, ok, fields|error}] }

POST /api/generate
  single -> { fields, category }              -> { listing, category, validation, ... }
  batch  -> { items:[{fields, category}] }    -> { mode, count, succeeded, items:[...] }
```

## Deployment (Ubuntu + nginx + pm2)

Deployed behind an existing nginx site as a sub-path, e.g. `https://ship.apanjob.com/meesho/`.

```bash
# on the server
cd ~/image-to-datails-generator
npm ci --omit=dev
cp .env.example .env       # fill in real keys, set FRONTEND_ORIGIN to the public origin
pm2 start server.js --name meesho-listing
pm2 save
```

nginx location block (added to the existing site, proxying to the app on :3000):

```nginx
location /meesho/ {
    proxy_pass http://127.0.0.1:3000/;   # trailing slash strips the /meesho prefix
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20M;            # product photos
    proxy_read_timeout 180s;             # Gemini vision calls can be slow
}
location = /meesho { return 301 /meesho/; }
```

**Sub-path note:** the frontend resolves API calls relative to the page directory
(`API_BASE` in `public/app.js`), so it works both at the domain root and under `/meesho/`.
Never hard-code absolute `/api/...` URLs in frontend code — they would escape the sub-path.

Redeploy after changes: `git pull && npm ci --omit=dev && pm2 restart meesho-listing`

## Important constraints (from the research report — read `CLAUDE.md`)

- **Never send the image to DeepSeek** — the deployed V4 models are text-only.
- **Never call either API from browser JS** — keys stay server-side.
- Meesho's character limits are **undocumented**; `TITLE_MAX=100` and `DESC_MAX=1400` are defensive
  working values, hard-truncated server-side and shown as counters client-side. EAN/UPC (13) is the
  one documented cap.
- Mandatory vs optional attributes are **category-dependent** — the attribute set is pulled per
  selected category, not assumed fixed.
- **Re-verify DeepSeek model names before 2026-07-24 15:59 UTC** — the legacy `deepseek-chat` /
  `deepseek-reasoner` aliases retire then. Update `src/config.js` if model strings change.
