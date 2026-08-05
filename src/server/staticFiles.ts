import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function serveStatic(distRoot: string, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const requestedPath = path.resolve(distRoot, relative || "index.html");
  const insideDist = requestedPath === distRoot || requestedPath.startsWith(`${distRoot}${path.sep}`);
  const found = insideDist && existsSync(requestedPath) && statSync(requestedPath).isFile();
  if (!found && relative.startsWith("assets/")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const candidate = found ? requestedPath : path.join(distRoot, "index.html");
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(candidate)] ?? "application/octet-stream",
    "cache-control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  createReadStream(candidate).pipe(response);
}
