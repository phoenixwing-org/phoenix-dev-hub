import { createServer } from "node:http";

const port = Number(process.argv[2]);
const statusCode = Number(process.argv[3] ?? 200);
const server = createServer((_request, response) => {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture-ready:${port}\n`);
});

function shutdown() {
  process.stderr.write("fixture-stopping\n");
  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
