import { createServer } from "node:http";

const port = Number(process.argv[2]);
const recover = process.argv[3] === "recover";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture-ready:${port}\n`);
  process.stderr.write("src/plugin.ts(1,1): error TS2416: Property is not assignable.\n");
  process.stderr.write("Found 1 error. Watching for file changes.\n");
  if (recover) {
    // 同一流内保持编译失败与恢复成功的严格顺序，避免 Windows 双管道到达顺序不确定。
    setTimeout(() => process.stderr.write("Found 0 errors. Watching for file changes.\n"), 250);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
