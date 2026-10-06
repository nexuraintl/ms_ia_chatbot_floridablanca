import { readFile } from "node:fs/promises";

const assets = {
  "/admin/chats/": ["./admin/chats.html", "text/html; charset=utf-8"],
  "/admin/chats/app.js": ["./admin/chats.js", "text/javascript; charset=utf-8"],
  "/admin/chats/app.css": ["./admin/chats.css", "text/css; charset=utf-8"]
};
export const serveConversationAdminPanel = async (req, res) => {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
  const route = req.url.split("?")[0];
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { ...headers, Allow: "GET, HEAD" }); res.end(); return 405;
  }
  if (route === "/admin/chats") {
    // Relativa a la URL publica para conservar el prefijo recortado por un gateway.
    res.writeHead(302, { ...headers, Location: "chats/" }); res.end(); return 302;
  }
  const asset = assets[route];
  if (!asset) { res.writeHead(404, headers); res.end(); return 404; }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    res.writeHead(200, { ...headers, "Content-Type": asset[1], "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    return 200;
  } catch { res.writeHead(503, headers); res.end(); return 503; }
};
