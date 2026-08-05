import { createServer } from "node:http";

const port = Number(process.argv[2]);
const keys = process.argv.slice(3);
if (!Number.isInteger(port) || port <= 0) throw new Error("invalid port");

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(Object.fromEntries(
    keys.map((key) => [key, process.env[key] ?? null]),
  )));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`environment-ready:${port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
