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
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve("data");
const UPLOAD_DIR = path.resolve("uploads");

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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

// Helmet with NO HSTS and NO auto-upgrade
app.use(helmet({
  hsts: false, // no HSTS on HTTP
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      // CRUCIAL: disable auto-upgrade to HTTPS
      "upgrade-insecure-requests": null
    }
  }
}));

// Belt-and-suspenders: make sure no HSTS header slips in
app.use((_, res, next) => {
  res.removeHeader("Strict-Transport-Security");
  next();
});


app.use(morgan("dev"));
app.use(express.json({ limit: MAX_JSON_BYTES }));
app.use("/uploads", express.static(UPLOAD_DIR, { fallthrough: false }));
app.use("/public", express.static("public", { fallthrough: false }));

// ------------------------- Layout helpers -------------------------
function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}
function escapeAttr(s) { return escapeHtml(s).replaceAll("'","&#39;"); }

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
<header><h1>DeathLogger</h1><nav><a href="/">Home</a> | <a href="/api/deaths">API</a></nav></header>
<main>
${body}
</main>
</body>
</html>`;
}

function summaryCard(d) {
  const ts = d.at ? dayjs.unix(d.at).format("YYYY-MM-DD HH:mm:ss") : "unknown";
  return `<article>
    <h2><a href="/death/${d.id}">${escapeHtml(d.player||"Unknown")} @ ${escapeHtml(d.realm||"?")}</a></h2>
    <p>When: ${ts}</p>
    <p>Killer: ${escapeHtml(d.killer?.sourceName||"Unknown")}</p>
    ${d.screenshot ? `<img src="${escapeAttr(d.screenshot)}" style="max-width:300px;" />` : ""}
  </article>`;
}

// ------------------------- Routes -------------------------
app.get("/", (_req, res) => {
  const rows = readDB().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const cards = rows.map(summaryCard).join("\n");
  res.type("html").send(layout("Deaths", cards || "<p>No deaths yet</p>"));
});

app.get("/death/:id", (req, res) => {
  const id = req.params.id;
  const rows = readDB();
  const d = rows.find(r => r.id === id);
  if (!d) return res.status(404).send("Not found");
  res.type("html").send(layout("Death Detail", `<pre>${escapeHtml(JSON.stringify(d,null,2))}</pre>`));
});

app.get("/api/deaths", (_req, res) => {
  const rows = readDB().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  res.json(rows);
});

app.post("/upload", upload.single("screenshot"), express.text({ type: "text/plain", limit: MAX_JSON_BYTES }), async (req, res) => {
  try {
    let deathRaw = req.body.death;
    if (!deathRaw && typeof req.body === "string") deathRaw = req.body;
    if (!deathRaw) return res.status(400).json({ error: "missing_death_json" });

    let payload;
    try { payload = JSON.parse(deathRaw); }
    catch (e) { return res.status(400).json({ error: "bad_json", detail: String(e) }); }

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
          console.error("TGA convert failed:", err);
          publicPath = `/uploads/${path.basename(orig)}`;
        }
      } else {
        publicPath = `/uploads/${path.basename(orig)}`;
      }
    }

    const id = nanoid();
    const now = Math.floor(Date.now() / 1000);
    const record = { id, receivedAt: now, ...payload, at: payload.at || now, screenshot: publicPath };
    const rows = readDB(); rows.push(record); writeDB(rows);
    res.json({ ok: true, id });
  } catch (err) {
    console.error("upload error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ------------------------- Start -------------------------
app.listen(PORT, () => {
  console.log(`DeathLogger server running at http://localhost:${PORT}`);
});

