# כותרות

A minimal news-framing comparison app for Israeli media. It ingests RSS feeds,
clusters articles about the same event, and shows how outlets across the
political spectrum framed each story — using **only the headline and
subheading**. Article bodies are never fetched or stored.

Hebrew, RTL. One Cloudflare Worker (TypeScript), D1 for storage, Workers AI
(`@cf/baai/bge-m3`) for multilingual embeddings, and a cron trigger every 20
minutes for ingestion.

## How it works

- **Ingestion (cron, every 20 min):** fetch each feed with browser headers,
  parse items, clean title + subheading (strip HTML, decode entities twice,
  collapse whitespace), embed `title + subheading` with bge-m3, L2-normalize,
  and cluster by cosine similarity (`>= 0.78` joins an existing cluster within
  the last 72h, otherwise a new cluster). Rows older than 7 days are deleted.
- **API (`GET /api/stories`):** clusters from the last 48h that have **≥ 2
  articles**, grouped by political lean in spectrum order, with a `blindspot`
  flag when every article shares one lean.
- **Page (`GET /`):** one self-contained RTL HTML page that fetches the API and
  renders the stories.

## Configuration

Everything is at the top of `src/index.ts`: `FEEDS`, `CLUSTER_THRESHOLD`,
`ACTIVE_WINDOW_HOURS`, `RETENTION_DAYS`, and `LEAN_ORDER`.

## Setup & deploy

```bash
# 1. Install dependencies
npm install

# 2. Create the D1 database (copy the printed database_id into wrangler.toml)
npx wrangler d1 create kotarot

# 3. Apply the schema (remote D1)
npx wrangler d1 execute kotarot --remote --file=./schema.sql

# 4. Deploy the Worker (this also registers the cron trigger)
npx wrangler deploy
```

After deploying, paste the `database_id` printed in step 2 into the
`[[d1_databases]]` block of `wrangler.toml` (replacing
`REPLACE_WITH_DATABASE_ID`) before step 4.

To trigger ingestion immediately instead of waiting for the cron:

```bash
# Local schema, if you want to test against a local D1 first:
npx wrangler d1 execute kotarot --local --file=./schema.sql
npx wrangler dev --test-scheduled
# then hit http://localhost:8787/__scheduled to run the cron handler
```

## Notes

- `mako` and the Walla feed key may need swapping to a general-news section URL
  for broader coverage; the defaults follow the spec.
- No Vectorize, no external services, no frontend framework, no auth.
