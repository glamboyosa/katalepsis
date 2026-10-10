import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4173);
const page = await readFile(new URL("./public/index.html", import.meta.url));

createServer((request, response) => {
  if (request.url === "/" || request.url?.startsWith("/?")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}).listen(port, "127.0.0.1", () => {
  console.log(`Demo signup form at http://127.0.0.1:${port}`);
});
