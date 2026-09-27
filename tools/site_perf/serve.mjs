// Static server for site/ that behaves like Cloudflare Pages for measurement purposes:
// brotli for text types (Cloudflare serves br to browsers that ask), ETags with 304s,
// and the headers from site/_headers (Cache-Control: no-cache). Python's http.server
// sends everything uncompressed, which overstates transfer sizes about 3-4x.
//   node tools/site_perf/serve.mjs [port] [root]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const port = Number(process.argv[2] || 8767);
const root = path.resolve(process.argv[3] || "site");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".txt": "text/plain",
};
const COMPRESS = /^(text\/|application\/json|image\/svg|model\/gltf)/;
const cache = new Map();

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  const buf = fs.readFileSync(file);
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  const etag = '"' + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"';
  const headers = { "Content-Type": type, "Cache-Control": "no-cache", ETag: etag };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
  let body = buf;
  if (COMPRESS.test(type) && /\bbr\b/.test(req.headers["accept-encoding"] || "")) {
    const key = file + etag;
    if (!cache.has(key)) cache.set(key, zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
    body = cache.get(key);
    headers["Content-Encoding"] = "br";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(body);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
