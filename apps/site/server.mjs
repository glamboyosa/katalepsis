import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A small static server for local preview. The site itself is plain files in public/;
// /video/ serves the stage that renders the product video and is not part of the site.
const root = fileURLToPath(new URL("./public/", import.meta.url));
const videoRoot = fileURLToPath(new URL("./video/", import.meta.url));
const port = Number(process.env.PORT ?? 4321);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const [base, relative] = pathname.startsWith("/video/")
    ? [videoRoot, pathname.slice("/video".length)]
    : [root, pathname];
  const file = path.join(base, relative.endsWith("/") ? `${relative}index.html` : relative);
  if (!file.startsWith(base)) {
    response.writeHead(403).end();
    return;
  }
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile()) {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": types[path.extname(file)] ?? "application/octet-stream",
    "content-length": info.size,
  });
  createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`katalepsis site at http://127.0.0.1:${port}`);
});
