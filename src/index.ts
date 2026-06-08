/**
 * כותרות — news-framing comparison for Israeli media.
 *
 * One Cloudflare Worker. D1 for storage, Workers AI (@cf/baai/bge-m3) for
 * embeddings, a 20-minute cron for ingestion. Headlines + subheadings only —
 * article bodies are never fetched or stored.
 */

import { XMLParser } from "fast-xml-parser";

/* ----------------------------------------------------------------------------
 * CONFIG — edit here
 * ------------------------------------------------------------------------- */

interface Feed {
  key: string;
  name: string;
  lean: string;
  url: string;
  headlineOnly?: boolean;
}

const FEEDS: Feed[] = [
  { key: "ynet",        name: "Ynet",           lean: "center",       url: "https://www.ynet.co.il/Integration/StoryRss2.xml" },
  { key: "walla",       name: "Walla",          lean: "center",       url: "https://rss.walla.co.il/feed/1?type=main" }, // non-commercial license
  { key: "mako",        name: "Mako/N12",       lean: "center",       url: "https://rcs.mako.co.il/rss/news-military.xml" }, // replace with general-news section
  { key: "maariv",      name: "Maariv",         lean: "center-right", url: "https://www.maariv.co.il/Rss/RssChadashot" },
  { key: "jpost",       name: "Jerusalem Post", lean: "center-right", url: "https://rss.jpost.com/rss/rssfeedsfrontpage.aspx" },
  { key: "themarker",   name: "TheMarker",      lean: "center-left",  url: "https://www.themarker.com/cmlink/1.145" },
  { key: "davar",       name: "Davar",          lean: "left",         url: "https://www.davar1.co.il/feed/" },
  { key: "zman",        name: "Zman Yisrael",   lean: "center-left",  url: "https://www.zman.co.il/feed/" },
  { key: "globes",      name: "Globes",         lean: "business",     url: "https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=2" },
  { key: "israelhayom", name: "Israel Hayom",   lean: "right",        url: "https://www.israelhayom.co.il/rss.xml", headlineOnly: true },
];

const CLUSTER_THRESHOLD = 0.78;
const ACTIVE_WINDOW_HOURS = 72;
const RETENTION_DAYS = 7;
const STORIES_WINDOW_HOURS = 48;

// Display order: in RTL the first entry renders on the visual right, so the
// political right sits on the right and the left on the left.
const LEAN_ORDER = ["right", "center-right", "center", "center-left", "left", "business"];

const LEAN_LABELS: Record<string, string> = {
  "right":        "ימין",
  "center-right": "מרכז־ימין",
  "center":       "מרכז",
  "center-left":  "מרכז־שמאל",
  "left":         "שמאל",
  "business":     "כלכלה",
};

const EMBED_MODEL = "@cf/baai/bge-m3";

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

interface Env {
  DB: D1Database;
  AI: { run: (model: string, input: unknown) => Promise<any> };
}

interface ActiveArticle {
  cluster_id: string;
  vec: number[];
}

/* ----------------------------------------------------------------------------
 * Text helpers
 * ------------------------------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", laquo: "«", raquo: "»",
  deg: "°", trade: "™", copy: "©", reg: "®", sect: "§", para: "¶",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (_m, n) => NAMED_ENTITIES[n] ?? `&${n};`);
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Strip HTML, decode entities twice (some feeds double-encode, e.g.
 * &amp;#8226;), strip any tags revealed by decoding (the leading <img> Maariv
 * and JPost put inside description), then collapse whitespace and trim.
 */
function clean(input: unknown): string {
  if (input === undefined || input === null) return "";
  let t = String(input);
  t = t.replace(/<[^>]*>/g, " ");
  t = decodeEntities(t);
  t = decodeEntities(t);
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ----------------------------------------------------------------------------
 * Vector helpers
 * ------------------------------------------------------------------------- */

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// Both vectors are L2-normalized, so dot product == cosine similarity.
function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  try {
    const resp = await env.AI.run(EMBED_MODEL, { text });
    const vec: number[] | undefined = resp?.data?.[0];
    if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
    return l2normalize(vec);
  } catch (err) {
    console.error("embed failed:", err);
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * RSS parsing
 * ------------------------------------------------------------------------- */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  // keep CDATA / text as strings
  parseTagValue: false,
});

interface RawItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  // fast-xml-parser may wrap mixed content; pull common shapes
  const obj = node as Record<string, unknown>;
  if (typeof obj["#text"] === "string") return obj["#text"];
  return "";
}

function parseFeed(xml: string): RawItem[] {
  let doc: any;
  try {
    doc = xmlParser.parse(xml);
  } catch {
    return [];
  }
  // RSS 2.0: rss.channel.item ; Atom fallback: feed.entry
  const channel = doc?.rss?.channel;
  const items = channel ? asArray(channel.item) : asArray(doc?.feed?.entry);
  const out: RawItem[] = [];
  for (const it of items) {
    const title = textOf(it?.title);
    let link = textOf(it?.link);
    // Atom <link href="...">
    if (!link && it?.link && typeof it.link === "object") link = String(it.link["@_href"] ?? "");
    const description = textOf(it?.description) || textOf(it?.summary);
    const pubDate = textOf(it?.pubDate) || textOf(it?.published) || textOf(it?.["dc:date"]);
    if (!link || !title) continue;
    out.push({ title, link, description, pubDate });
  }
  return out;
}

function parsePubDate(s: string | undefined): number {
  if (!s) return Math.floor(Date.now() / 1000);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return Math.floor(Date.now() / 1000);
  return Math.floor(t / 1000);
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};

/* ----------------------------------------------------------------------------
 * Scheduled handler — ingestion
 * ------------------------------------------------------------------------- */

async function ingest(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const activeCutoff = now - ACTIVE_WINDOW_HOURS * 3600;

  // Known ids (avoid re-processing). Bounded by retention window.
  const existing = new Set<string>();
  const idRows = await env.DB.prepare("SELECT id FROM articles").all<{ id: string }>();
  for (const r of idRows.results ?? []) existing.add(r.id);

  // Active articles for clustering (in-memory; grows as we insert).
  const active: ActiveArticle[] = [];
  const activeRows = await env.DB
    .prepare("SELECT cluster_id, embedding FROM articles WHERE published_at >= ?")
    .bind(activeCutoff)
    .all<{ cluster_id: string; embedding: string }>();
  for (const r of activeRows.results ?? []) {
    try {
      active.push({ cluster_id: r.cluster_id, vec: JSON.parse(r.embedding) });
    } catch {
      /* skip malformed */
    }
  }

  for (const feed of FEEDS) {
    let items: RawItem[] = [];
    try {
      const res = await fetch(feed.url, { headers: BROWSER_HEADERS });
      if (res.status !== 200) {
        console.warn(`feed ${feed.key}: status ${res.status}, skipping`);
        continue;
      }
      const body = await res.text();
      if (!body.trimStart().startsWith("<")) {
        console.warn(`feed ${feed.key}: body is not XML, skipping`);
        continue;
      }
      items = parseFeed(body);
    } catch (err) {
      console.warn(`feed ${feed.key}: fetch failed`, err);
      continue;
    }

    for (const raw of items) {
      const link = raw.link.trim();
      if (!link) continue;
      const id = await sha256Hex(link);
      if (existing.has(id)) continue;

      const title = clean(raw.title);
      const subheading = clean(raw.description);
      if (!title) continue;
      if (!subheading && !feed.headlineOnly) continue;

      const vec = await embed(env, `${title} ${subheading}`.trim());
      if (!vec) continue;

      // Cluster against active set.
      let bestSim = -1;
      let bestCluster: string | null = null;
      for (const a of active) {
        const sim = dot(vec, a.vec);
        if (sim > bestSim) {
          bestSim = sim;
          bestCluster = a.cluster_id;
        }
      }
      const clusterId =
        bestCluster && bestSim >= CLUSTER_THRESHOLD ? bestCluster : crypto.randomUUID();

      const publishedAt = parsePubDate(raw.pubDate);

      try {
        await env.DB
          .prepare(
            `INSERT INTO articles
               (id, source, lean, title, subheading, url, published_at, embedding, cluster_id, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            feed.name,
            feed.lean,
            title,
            subheading,
            link,
            publishedAt,
            JSON.stringify(vec),
            clusterId,
            now
          )
          .run();
      } catch (err) {
        console.warn(`insert failed for ${feed.key}:`, err);
        continue;
      }

      existing.add(id);
      // Only let it participate in clustering if it is within the active window.
      if (publishedAt >= activeCutoff) active.push({ cluster_id: clusterId, vec });
    }
  }

  // Retention cleanup.
  const retentionCutoff = now - RETENTION_DAYS * 86400;
  await env.DB.prepare("DELETE FROM articles WHERE published_at < ?").bind(retentionCutoff).run();
}

/* ----------------------------------------------------------------------------
 * Fetch handler — API + page
 * ------------------------------------------------------------------------- */

interface ApiArticle {
  source: string;
  lean: string;
  title: string;
  subheading: string;
  url: string;
  published_at: number;
}

interface ApiGroup {
  lean: string;
  lean_label: string;
  articles: ApiArticle[];
}

interface ApiStory {
  cluster_id: string;
  label: string;
  blindspot: boolean;
  groups: ApiGroup[];
}

async function getStories(env: Env): Promise<ApiStory[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - STORIES_WINDOW_HOURS * 3600;

  const rows = await env.DB
    .prepare(
      `SELECT source, lean, title, subheading, url, published_at, cluster_id
         FROM articles
        WHERE published_at >= ?
        ORDER BY published_at ASC`
    )
    .bind(cutoff)
    .all<{
      source: string;
      lean: string;
      title: string;
      subheading: string;
      url: string;
      published_at: number;
      cluster_id: string;
    }>();

  const clusters = new Map<string, ApiArticle[]>();
  for (const r of rows.results ?? []) {
    const arr = clusters.get(r.cluster_id) ?? [];
    arr.push({
      source: r.source,
      lean: r.lean,
      title: r.title,
      subheading: r.subheading,
      url: r.url,
      published_at: r.published_at,
    });
    clusters.set(r.cluster_id, arr);
  }

  const stories: Array<ApiStory & { _newest: number }> = [];
  for (const [clusterId, articles] of clusters) {
    if (articles.length < 2) continue; // hide single-article clusters

    // articles are in ascending published_at; earliest is first, label from it.
    const label = articles[0].title;
    const newest = articles[articles.length - 1].published_at;

    const distinctLeans = new Set(articles.map((a) => a.lean));
    const blindspot = distinctLeans.size === 1;

    const groups: ApiGroup[] = [];
    for (const lean of LEAN_ORDER) {
      const inLean = articles.filter((a) => a.lean === lean);
      if (inLean.length === 0) continue;
      inLean.sort((a, b) => b.published_at - a.published_at);
      groups.push({ lean, lean_label: LEAN_LABELS[lean] ?? lean, articles: inLean });
    }

    stories.push({ cluster_id: clusterId, label, blindspot, groups, _newest: newest });
  }

  stories.sort((a, b) => b._newest - a._newest);
  return stories.map(({ _newest, ...s }) => s);
}

/* ----------------------------------------------------------------------------
 * HTML page (self-contained; fetches /api/stories and renders)
 * ------------------------------------------------------------------------- */

const PAGE_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>כותרות</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1a1a1a;
    --muted: #767676;
    --faint: #9b9b9b;
    --line: #e6e6e6;
    --accent: #b08400;
    --bg: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Heebo", sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; }
  header { margin-bottom: 36px; }
  h1 { font-size: 40px; font-weight: 700; margin: 0; letter-spacing: -0.5px; }
  .subtitle { color: var(--muted); font-size: 15px; margin-top: 6px; }
  .story { padding: 24px 0; border-top: 1px solid var(--line); }
  .story:first-of-type { border-top: none; }
  .label { font-weight: 500; font-size: 19px; margin: 0 0 4px; }
  .badge {
    display: inline-block;
    font-size: 12px;
    color: var(--accent);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 9px;
    margin-bottom: 12px;
  }
  .groups {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    margin-top: 12px;
  }
  .group { flex: 1 1 220px; min-width: 0; }
  .lean-label { font-size: 12px; color: var(--faint); margin-bottom: 8px; font-weight: 500; }
  .article { margin-bottom: 14px; }
  .article:last-child { margin-bottom: 0; }
  .outlet { font-size: 12px; color: var(--muted); }
  .headline { display: block; font-weight: 500; font-size: 15px; color: var(--ink); text-decoration: none; }
  .headline:hover { color: var(--accent); }
  .sub { font-size: 14px; color: var(--muted); margin-top: 2px; }
  .status { color: var(--muted); padding: 24px 0; }
  @media (max-width: 560px) {
    .groups { flex-direction: column; gap: 16px; }
    h1 { font-size: 32px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>כותרות</h1>
    <div class="subtitle">איך אותו אירוע מסוקר על פני הקשת הפוליטית — כותרת ותת־כותרת בלבד.</div>
  </header>
  <main id="stories"><div class="status">טוען…</div></main>
</div>
<script>
(async function () {
  var root = document.getElementById("stories");
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  try {
    var res = await fetch("/api/stories");
    var stories = await res.json();
    root.innerHTML = "";
    if (!stories.length) {
      root.appendChild(el("div", "status", "אין סיפורים מרובי־מקורות כרגע. חזרו בעוד מספר דקות."));
      return;
    }
    stories.forEach(function (s) {
      var story = el("section", "story");
      story.appendChild(el("h2", "label", s.label));
      if (s.blindspot) story.appendChild(el("span", "badge", "נקודה עיוורת"));
      var groups = el("div", "groups");
      s.groups.forEach(function (g) {
        var grp = el("div", "group");
        grp.appendChild(el("div", "lean-label", g.lean_label));
        g.articles.forEach(function (a) {
          var art = el("div", "article");
          art.appendChild(el("div", "outlet", a.source));
          var link = el("a", "headline", a.title);
          link.href = a.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          art.appendChild(link);
          if (a.subheading) art.appendChild(el("div", "sub", a.subheading));
          grp.appendChild(art);
        });
        groups.appendChild(grp);
      });
      story.appendChild(groups);
      root.appendChild(story);
    });
  } catch (err) {
    root.innerHTML = "";
    root.appendChild(el("div", "status", "שגיאה בטעינת הנתונים."));
  }
})();
</script>
</body>
</html>`;

/* ----------------------------------------------------------------------------
 * Worker entry
 * ------------------------------------------------------------------------- */

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ingest(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/stories") {
      const stories = await getStories(env);
      return new Response(JSON.stringify(stories), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=60",
        },
      });
    }

    if (url.pathname === "/") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
