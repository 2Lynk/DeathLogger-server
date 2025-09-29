// server.js — DeathLogger mini site (HTML pages + API)
// Node 18+ (ESM). Run with: node server.js
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { createReadStream, existsSync } from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- paths
const DATA_DIR = path.join(__dirname, "data");
const SHOTS_DIR = path.join(DATA_DIR, "screens");
const PUBLIC_DIR = path.join(__dirname, "public");

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(SHOTS_DIR, { recursive: true });
await fs.mkdir(PUBLIC_DIR, { recursive: true });

// --- security headers (CSP allows inline CSS, no https upgrade)
app.use(
  helmet({
    hsts: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        // critical: don't auto-upgrade to https on an http server
        "upgrade-insecure-requests": null,
      },
    },
  })
);

// logs
app.use(morgan("dev"));

// static
app.use("/public", express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));
app.use("/screens", express.static(SHOTS_DIR, { etag: true, maxAge: "7d" }));

// ---------- small HTML helpers ----------
const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/public/style.css"/>
</head>
<body class="wow">
<header class="wow-header">
  <div class="crest"><span class="crest-ring"></span><span class="crest-gem"></span></div>
  <div class="title"><h1>DeathLogger</h1><p class="subtitle">Chronicle of Untimely Ends</p></div>
  <nav class="nav">
    <a href="/">Home</a>
    <a href="/api/deaths">API</a>
  </nav>
</header>
<main class="wow-main">${body}</main>
<footer class="wow-footer"><p>© ${new Date().getFullYear()} DeathLogger — For Azeroth!</p></footer>
</body>
</html>`;

const deathCard = (d) => {
  const p = d.player ?? "Unknown";
  const r = d.realm ?? "Unknown";
  const cls = d.class ?? "";
  const lvl = d.level ?? "";
  const when = new Date((d.at ?? 0) * 1000).toLocaleString();
  const inst = (d.instance?.instanceName ?? "") || "";
  const loc = d.location
    ? `${d.location.zone ?? ""}${d.location.subzone ? " — " + d.location.subzone : ""} (${fmtCoord(d.location)})`
    : "";
  const killer = fmtKiller(d.killer);

  const money = fmtMoney(d);

  return `
<article class="card parchment">
  <header class="card-header">
    <h2><a href="/death/${d.id}">${escapeHtml(p)}-${escapeHtml(r)}</a></h2>
    <div class="meta">
      <span>${when}</span>
      ${inst ? `<span>${escapeHtml(inst)}</span>` : ""}
      ${loc ? `<span>${escapeHtml(loc)}</span>` : ""}
      ${cls || lvl ? `<span>${escapeHtml([cls, lvl && "Lv. " + lvl].filter(Boolean).join(" · "))}</span>` : ""}
    </div>
  </header>
  <section class="card-body">
    <p><strong>Slain by:</strong> ${escapeHtml(killer)}</p>
    ${money ? `<p><strong>Money:</strong> ${money}</p>` : ""}
    ${d.screenshot ? `<a class="screenshot-link" href="${d.screenshot}" target="_blank">View screenshot</a>` : ""}
  </section>
</article>`;
};

const deathDetail = (d) => {
  const base = deathCard(d);
  const eq = fmtEquipped(d.equipped);
  const bags = fmtBags(d.bags);
  return `
${base}
<section class="grid">
  <div class="card parchment">
    <h3>Equipped</h3>
    ${eq || "<p class='muted'>No equipment recorded.</p>"}
  </div>
  <div class="card parchment">
    <h3>Bags</h3>
    ${bags || "<p class='muted'>No bag contents recorded.</p>"}
  </div>
</section>`;
};

const profilePage = (slug, deaths) => {
  const [player, realm] = slug.split("@");
  const list = deaths.map(deathCard).join("");
  const totals = tallyTotals(deaths);
  return `
<section class="card parchment">
  <h2>Profile: ${escapeHtml(player)} - ${escapeHtml(realm)}</h2>
  <p><strong>Total deaths:</strong> ${deaths.length}</p>
  ${totals.gold !== null ? `<p><strong>Total gold lost (recorded entries):</strong> ${totals.gold}</p>` : ""}
</section>
<section class="grid">
  ${list || "<p class='parchment empty'>No deaths yet for this character.</p>"}
</section>`;
};

// ---------- formatters ----------
function fmtMoney(d) {
  // prefer moneyGold/Silver/Copper, fallback to moneyCopperOnly
  if (d.moneyGold != null || d.moneySilver != null || d.moneyCopper != null) {
    const g = d.moneyGold ?? 0;
    const s = d.moneySilver ?? 0;
    const c = d.moneyCopper ?? 0;
    return `${g}g ${s}s ${c}c`;
  }
  if (d.moneyCopperOnly != null) {
    const total = d.moneyCopperOnly;
    const g = Math.floor(total / 10000);
    const s = Math.floor((total % 10000) / 100);
    const c = total % 100;
    return `${g}g ${s}s ${c}c`;
  }
  return "";
}
function fmtCoord(loc = {}) {
  if (typeof loc.x === "number" && typeof loc.y === "number") {
    return `${loc.x.toFixed(2)}, ${loc.y.toFixed(2)}`;
  }
  return "";
}
function fmtKiller(k) {
  if (!k) return "Unknown";
  const who = k.sourceName || "Unknown";
  const via = k.spellName || k.detail || k.subevent || "Unknown";
  return `${who} (${via})`;
}
function fmtEquipped(eq) {
  if (!Array.isArray(eq) || eq.length === 0) return "";
  const items = eq
    .map((it) => it?.hyperlink)
    .filter(Boolean)
    .map(readableItemLink)
    .map((name, i) => `<li>${escapeHtml(name)}</li>`)
    .join("");
  return `<ul class="list">${items}</ul>`;
}
function fmtBags(bags) {
  if (!Array.isArray(bags) || bags.length === 0) return "";
  const out = [];
  for (const bag of bags) {
    const slots = Array.isArray(bag?.slots) ? bag.slots : [];
    const lis = slots
      .map((s) => {
        const name = readableItemLink(s?.hyperlink) || `Item ${s?.itemID ?? ""}`;
        const count = s?.stackCount ?? 1;
        return `<li>${escapeHtml(name)}${count > 1 ? ` x${count}` : ""}</li>`;
      })
      .join("");
    out.push(`<div class="bag"><h4>Bag ${bag?.bagID ?? ""}</h4><ul class="list">${lis || "<li class='muted'>Empty</li>"}</ul></div>`);
  }
  return `<div class="bags">${out.join("")}</div>`;
}
function readableItemLink(link) {
  // link looks like |cffffffff|Hitem:117::::::::1:::::::::|h[Tough Jerky]|h|r
  if (!link || typeof link !== "string") return "";
  const m = link.match(/\|h\[(.*?)\]\|h/);
  return m ? m[1] : link;
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugFor(d) {
  const p = d.player ?? "Unknown";
  const r = d.realm ?? "Unknown";
  return `${p}@${r}`;
}
function tallyTotals(deaths) {
  // just sum moneyCopperOnly when present
  let sum = 0;
  let count = 0;
  for (const d of deaths) {
    if (typeof d.moneyCopperOnly === "number") {
      sum += d.moneyCopperOnly;
      count++;
    }
  }
  if (count === 0) return { gold: null };
  const g = Math.floor(sum / 10000);
  const s = Math.floor((sum % 10000) / 100);
  const c = sum % 100;
  return { gold: `${g}g ${s}s ${c}c` };
}

// ---------- storage ----------
const DEATHS_JSON = path.join(DATA_DIR, "deaths.json");

async function loadDeaths() {
  if (!existsSync(DEATHS_JSON)) return [];
  const buf = await fs.readFile(DEATHS_JSON, "utf8");
  try {
    const arr = JSON.parse(buf);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function saveDeaths(arr) {
  await fs.writeFile(DEATHS_JSON, JSON.stringify(arr, null, 2));
}

// ---------- upload endpoint ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Allow jpg/png/webp only
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    if (!ok) return cb(new Error("Unsupported image type (jpg/png/webp only)"));
    cb(null, true);
  },
});

app.post("/upload", upload.single("screenshot"), express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const deathRaw = req.body?.death;
    if (!deathRaw) return res.status(400).json({ error: "Missing death payload" });
    const death = JSON.parse(deathRaw);

    // ID & filename
    const id = crypto.randomUUID();
    death.id = id;

    // Save screenshot if provided
    if (req.file) {
      const ext = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
      const name = `${id}.${ext}`;
      const out = path.join(SHOTS_DIR, name);
      await fs.writeFile(out, req.file.buffer);
      death.screenshot = `/screens/${name}`;
    }

    // Persist
    const all = await loadDeaths();
    all.unshift(death);
    await saveDeaths(all);

    res.json({ ok: true, id, screenshot: death.screenshot ?? null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// ---------- HTML pages ----------

// Home: latest deaths
app.get("/", async (_req, res) => {
  const deaths = await loadDeaths();
  const body =
    deaths.length === 0
      ? `<section class='grid'><p class='parchment empty'>No deaths yet. The chronicles await…</p></section>`
      : `<section class="grid">${deaths.slice(0, 50).map(deathCard).join("")}</section>`;
  res.type("html").send(layout("Deaths", body));
});

// Death detail page (HTML)
app.get("/death/:id", async (req, res) => {
  const deaths = await loadDeaths();
  const d = deaths.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).type("html").send(layout("Not found", `<p class='parchment'>Death not found.</p>`));
  const body = deathDetail(d);
  res.type("html").send(layout(`Death of ${escapeHtml(d.player ?? "Unknown")}`, body));
});

// Player profile (HTML)
app.get("/player/:slug", async (req, res) => {
  const deaths = await loadDeaths();
  const mine = deaths.filter((d) => slugFor(d) === req.params.slug);
  if (mine.length === 0) {
    return res
      .status(404)
      .type("html")
      .send(layout("Profile not found", `<p class='parchment'>No records for ${escapeHtml(req.params.slug)}.</p>`));
  }
  res.type("html").send(layout(`Profile ${escapeHtml(req.params.slug)}`, profilePage(req.params.slug, mine)));
});

// ---------- JSON APIs (kept for tooling) ----------
app.get("/api/deaths", async (_req, res) => {
  const deaths = await loadDeaths();
  res.json(deaths);
});
app.get("/api/death/:id", async (req, res) => {
  const deaths = await loadDeaths();
  const d = deaths.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "not_found" });
  res.json(d);
});

// ---------- favicon (optional nice-to-have) ----------
app.get("/favicon.ico", (_req, res) => {
  const ico = path.join(PUBLIC_DIR, "favicon.ico");
  if (existsSync(ico)) return createReadStream(ico).pipe(res);
  res.status(204).end();
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`DeathLogger site on http://0.0.0.0:${PORT}`);
});
