import fs from "fs";
import path from "path";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import { nanoid } from "nanoid";
import dayjs from "dayjs";
import tga2png from "tga2png";

// ------------------------- Config -------------------------
const PORT = process.env.PORT || 80;
const DATA_DIR = path.resolve("data");
const UPLOAD_DIR = path.resolve("uploads");

// Max sizes
const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// ------------------------- Bootstrap -------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "deaths.json");
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeDB(rows) {
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2), "utf8");
}

// ------------------------- Upload handling -------------------------
function getSafeExtFromMime(mime) {
  switch ((mime || "").toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/png":  return ".png";
    case "image/webp": return ".webp";
    case "image/tga":
    case "image/x-tga": return ".tga";
    default: return "";
  }
}
function extFromOriginalName(name) {
  const ext = path.extname(name || "").toLowerCase();
  return [".jpg",".jpeg",".png",".webp",".tga"].includes(ext) ? ext : "";
}
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = nanoid();
    const byMime = getSafeExtFromMime(file.mimetype);
    const byName = extFromOriginalName(file.originalname);
    const ext = byName || byMime || ".bin";
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, fields: 10, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();
    const okMime = ["image/jpeg","image/png","image/webp","image/tga","image/x-tga","application/octet-stream"].includes(mime);
    const okExt = [".jpg",".jpeg",".png",".webp",".tga"].includes(extFromOriginalName(file.originalname));
    if (okMime || okExt) return cb(null, true);
    cb(new Error("Unsupported image type (allowing jpg/png/webp/tga)"));
  },
});

// ------------------------- App -------------------------
const app = express();
app.disable("x-powered-by");

// Helmet with NO HSTS and NO upgrade-insecure-requests
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // DO NOT set 'upgrade-insecure-requests'
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "object-src": ["'none'"]
    }
  }
}));

// In case a proxy in front added it earlier, strip the header anyway:
app.use((_, res, next) => {
  res.removeHeader("Strict-Transport-Security");
  next();
});

// ------------------------- WoW-ish helpers -------------------------
const CLASS_COLORS = {
  WARRIOR:"#C79C6E", PALADIN:"#F58CBA", HUNTER:"#ABD473", ROGUE:"#FFF569", PRIEST:"#FFFFFF",
  DEATHKNIGHT:"#C41E3A", SHAMAN:"#0070DE", MAGE:"#40C7EB", WARLOCK:"#8788EE", MONK:"#00FF96",
  DRUID:"#FF7D0A", DEMONHUNTER:"#A330C9", EVOKER:"#33937F"
};

function classBadge(cls, lvl) {
  const color = CLASS_COLORS[(cls || "").toUpperCase()] || "#E8C170";
  const safeClass = escapeHtml(cls || "?");
  const safeLvl = lvl != null ? escapeHtml(String(lvl)) : "?";
  return `<span class="wow-badge" style="--class-color:${color}">${safeClass} <span class="lvl">Lv ${safeLvl}</span></span>`;
}

function coinSVG(fill) {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="${fill}" stroke="#000" stroke-opacity=".35"/></svg>`;
}
const ICON_G = coinSVG("#C79C00");
const ICON_S = coinSVG("#A0A5B5");
const ICON_C = coinSVG("#B87333");

function moneyString(d) {
  if (typeof d.moneyCopper === "number") {
    const g = Math.floor(d.moneyCopper / 10000);
    const s = Math.floor((d.moneyCopper % 10000) / 100);
    const c = d.moneyCopper % 100;
    return `<span class="coins">${g}${ICON_G} ${s}${ICON_S} ${c}${ICON_C}</span>`;
  }
  const g = d.moneyGold ?? 0, s = d.moneySilver ?? 0, c = d.moneyCopperOnly ?? 0;
  return `<span class="coins">${g}${ICON_G} ${s}${ICON_S} ${c}${ICON_C}</span>`;
}

function coordStr(d) {
  const x = d.location?.x, y = d.location?.y;
  if (typeof x === "number" && typeof y === "number") return ` — (${x.toFixed(2)}, ${y.toFixed(2)})`;
  return "";
}

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function escapeAttr(s) { return escapeHtml(s).replaceAll("'","&#39;"); }

// ---- Item helpers (parse WoW item hyperlink like: |cffa335ee|Hitem:...|h[Name]|h|r) ----
const QUALITY_COLORS = { 0:"#9d9d9d", 1:"#ffffff", 2:"#1eff00", 3:"#0070dd", 4:"#a335ee", 5:"#ff8000", 6:"#e6cc80" };
function itemNameFromLink(link){ if(!link||typeof link!=="string")return null; const m=link.match(/\|h\[(.*?)\]\|h/); return m?m[1]:null; }
function itemColorFromLink(link){ if(!link||typeof link!=="string")return null; const m=link.match(/\|c([0-9a-fA-F]{8})/); if(!m)return null; return "#"+m[1].slice(2).toLowerCase(); }

// ------------------------- Views (WoW-styled) -------------------------
function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/public/style.css" />
</head>
<body>
<header class="wow-header">
  <div class="crest">
    <span class="crest-ring"></span>
    <span class="crest-gem"></span>
  </div>
  <div class="title">
    <h1>DeathLogger</h1>
    <p class="subtitle">Chronicle of Untimely Ends</p>
  </div>
  <nav class="nav">
    <a href="/">Home</a>
    <a href="/api/deaths">API</a>
  </nav>
</header>
<main class="wow-main">
${body}
</main>
<footer class="wow-footer">
  <p>© ${new Date().getFullYear()} DeathLogger — For Azeroth!</p>
</footer>
</body>
</html>`;
}

function summaryCard(d) {
  const ts = d.at ? dayjs.unix(d.at).format("YYYY-MM-DD HH:mm:ss") : "unknown";
  const title = `${escapeHtml(d.player || "Unknown")} @ ${escapeHtml(d.realm || "?")}`;
  const where = d.location?.zone ? `${d.location.zone}${d.location.subzone ? " — " + d.location.subzone : ""}` : "Unknown";
  const killer = d.killer?.sourceName ? `${d.killer.sourceName}${d.killer.detail ? " (" + d.killer.detail + ")" : ""}` : "Unknown";
  const cls = classBadge(d.class, d.level);
  const money = moneyString(d);

  return `<article class="parchment card">
    <div class="card-left">
      <h2><a class="wow-link" href="/death/${d.id}">${title}</a></h2>
      <p><span class="label">When:</span> ${ts}</p>
      <p><span class="label">Where:</span> ${escapeHtml(where)}</p>
      <p><span class="label">Killer:</span> ${escapeHtml(killer)}</p>
      <p><span class="label">Adventurer:</span> ${cls}</p>
      <p><span class="label">Money:</span> ${money}</p>
    </div>
    <div class="card-right">
      ${d.screenshot ? `<img class="shot" src="${escapeAttr(d.screenshot)}" alt="screenshot" />` : `<div class="shot placeholder">No Screenshot</div>`}
    </div>
  </article>`;
}

// ---- Bags (names only; no icons) ----
function renderBags(bags) {
  if (!Array.isArray(bags) || bags.length === 0) {
    return `<section class="parchment bags"><h3>Bags</h3><p class="bags-empty">No bag data.</p></section>`;
  }

  const bagCards = bags.map((bag) => {
    const slots = Array.isArray(bag.slots) ? bag.slots : [];
    const items = slots.map((it) => {
      const name = itemNameFromLink(it.hyperlink) || (it.itemID ? `Item #${it.itemID}` : "Unknown Item");
      const color = itemColorFromLink(it.hyperlink) || QUALITY_COLORS[it.quality ?? 1] || "#ffffff";
      const count = (typeof it.stackCount === "number" && it.stackCount > 1) ? ` × ${it.stackCount}` : "";
      return `<div class="bag-item" style="--q:${escapeAttr(color)}">
        <span class="bullet"></span>
        <span class="iname" ${it.hyperlink ? `title="${escapeAttr(it.hyperlink)}"` : ""} style="color:${escapeAttr(color)}">${escapeHtml(name)}</span>
        <span class="count">${escapeHtml(count)}</span>
      </div>`;
    }).join("") || `<div class="bag-empty">— Empty —</div>`;

    const bagLabel = (bag.bagID === 0) ? "Backpack" : `Bag ${bag.bagID}`;
    return `<div class="bag">
      <div class="bag-title">${escapeHtml(bagLabel)}</div>
      <div class="bag-grid">${items}</div>
    </div>`;
  }).join("");

  return `<section class="parchment bags">
    <h3>Bags</h3>
    <div class="bags-wrap">${bagCards}</div>
  </section>`;
}

function detailView(d) {
  const ts = d.at ? dayjs.unix(d.at).format("YYYY-MM-DD HH:mm:ss") : "unknown";
  const cls = classBadge(d.class, d.level);
  const money = moneyString(d);
  const bagSection = renderBags(d.bags);

  return `<section class="parchment detail">
    <div class="decor top"></div>
    <h2>${escapeHtml(d.player || "Unknown")} <span class="realm">@ ${escapeHtml(d.realm || "?")}</span></h2>
    <div class="meta">
      <div><span class="label">When:</span> ${ts}</div>
      <div><span class="label">Adventurer:</span> ${cls}</div>
      <div><span class="label">Location:</span> ${escapeHtml(d.location?.zone || "Unknown")}${d.location?.subzone ? " — " + escapeHtml(d.location.subzone) : ""}${coordStr(d)}</div>
      <div><span class="label">Killer:</span> ${escapeHtml(d.killer?.sourceName || "Unknown")}${d.killer?.detail ? " (" + escapeHtml(d.killer.detail) + ")" : ""}</div>
      <div><span class="label">Money:</span> ${money}</div>
    </div>

    ${d.screenshot ? `<figure class="figure"><img class="full" src="${escapeAttr(d.screenshot)}" alt="screenshot" /></figure>` : ""}

    ${bagSection}

    <details class="raw">
      <summary>Show Raw Chronicle (JSON)</summary>
      <pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre>
    </details>
    <div class="decor bottom"></div>
  </section>`;
}

// ------------------------- Routes -------------------------
app.get("/", (_req, res) => {
  const rows = readDB().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const cards = rows.map(summaryCard).join("\n");
  res.type("html").send(layout("Deaths", `
    <section class="grid">
      ${cards || "<p class='parchment empty'>No deaths yet. The chronicles await…</p>"}
    </section>
  `));
});

app.get("/death/:id", (req, res) => {
  const id = req.params.id;
  const rows = readDB();
  const d = rows.find(r => r.id === id);
  if (!d) return res.status(404).type("html").send(layout("Not found", "<p class='parchment empty'>Death not found.</p>"));
  res.type("html").send(layout("Death Detail", detailView(d)));
});

app.get("/api/deaths", (_req, res) => {
  const rows = readDB().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  res.json(rows);
});

app.get("/api/deaths/:id", (req, res) => {
  const id = req.params.id;
  const rows = readDB();
  const d = rows.find(r => r.id === id);
  if (!d) return res.status(404).json({ error: "not_found" });
  res.json(d);
});

// Upload endpoint
app.post("/upload", upload.single("screenshot"), express.text({ type: "text/plain", limit: MAX_JSON_BYTES }), async (req, res) => {
  try {
    let deathRaw = req.body.death;
    if (!deathRaw && typeof req.body === "string") deathRaw = req.body;
    if (!deathRaw) return res.status(400).json({ error: "missing_death_json" });

    let payload;
    try { payload = JSON.parse(deathRaw); }
    catch (e) { return res.status(400).json({ error: "bad_json", detail: String(e) }); }

    // If screenshot is .tga, convert to .png and replace path
    let publicPath = null;
    if (req.file) {
      const orig = req.file.path;
      const ext = path.extname(orig).toLowerCase();
      if (ext === ".tga") {
        try {
          const tgaBuf = fs.readFileSync(orig);
          const pngBuf = tga2png(tgaBuf);
          const dest = path.join(UPLOAD_DIR, `${path.basename(orig, ext)}.png`);
          fs.writeFileSync(dest, pngBuf);
          fs.unlinkSync(orig);
          publicPath = `/uploads/${path.basename(dest)}`;
        } catch (err) {
          console.error("TGA convert failed, keeping original:", err);
          publicPath = `/uploads/${path.basename(orig)}`;
        }
      } else {
        publicPath = `/uploads/${path.basename(orig)}`;
      }
    }

    const id = nanoid();
    const now = Math.floor(Date.now() / 1000);
    const record = {
      id,
      receivedAt: now,
      ...payload,
      at: typeof payload.at === "number" ? payload.at : now,
      player: payload.player || "Unknown",
      realm: payload.realm || "Unknown",
      screenshot: publicPath,
    };

    const rows = readDB();
    rows.push(record);
    writeDB(rows);
    res.json({ ok: true, id });
  } catch (err) {
    console.error("upload error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ------------------------- Start -------------------------
app.listen(PORT, () => {
  console.log(`DeathLogger server running at http://localhost:${PORT}`);
  console.log(`Tip: In WoW, set JPEG screenshots with: /console screenshotFormat jpg`);
});


