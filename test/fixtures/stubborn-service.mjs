import { createServer } from "node:http";

const port = Number(process.argv[2]);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, service: "stubborn", version: "1.0.0" }));
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`stubborn-ready:${port}\n`));
process.on("SIGTERM", () => process.stderr.write("stubborn-ignored-sigterm\n"));
process.on("SIGINT", () => process.stderr.write("stubborn-ignored-sigint\n"));
