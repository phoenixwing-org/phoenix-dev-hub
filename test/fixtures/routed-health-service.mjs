import { createServer } from "node:http";

const port = Number(process.argv[2]);
const server = createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "root route is not defined" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`routed-ready:${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
