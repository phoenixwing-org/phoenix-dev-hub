import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("./http-service.mjs", import.meta.url));
const port = Number(process.argv[2]);
let stopping = false;
let child;

function startChild() {
  child = spawn(process.execPath, [fixturePath, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("exit", () => {
    if (stopping) process.exit(0);
    process.stdout.write("watch-respawn\n");
    setTimeout(startChild, 40);
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  child?.kill("SIGTERM");
  setTimeout(() => process.exit(0), 800).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
startChild();
