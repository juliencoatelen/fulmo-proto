// Serveur statique minimal pour les tests (aucune dépendance).
// Imite GitHub Pages : « /app » sert app.html, « / » sert index.html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
};

async function find(path) {
  const candidates = path.endsWith("/") ? [path + "index.html"] : [path, path + ".html", path + "/index.html"];
  for (const c of candidates) {
    try { if ((await stat(c)).isFile()) return c; } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = join(root, normalize(decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  const file = await find(path);
  if (!file) {
    res.writeHead(404, { "content-type": types[".html"] }).end(await readFile(join(root, "404.html")).catch(() => "404"));
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(await readFile(file));
}).listen(port, () => console.log(`http://localhost:${port}`));
