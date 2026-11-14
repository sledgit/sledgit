// sledgit-mcp [--http <port>]: stdio by default; --http serves Streamable HTTP on 127.0.0.1.
import { serveHttp, serveStdio } from "./server.js";

const args = process.argv.slice(2);
const i = args.indexOf("--http");
if (i >= 0) {
  const raw = args[i + 1] ?? "";
  if (!/^\d{2,5}$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    console.error("--http needs a port from 1024 to 65535");
    process.exit(2);
  }
  serveHttp(Number(raw));
} else if (args.length) {
  console.error("usage: sledgit-mcp [--http <port>]");
  process.exit(2);
} else {
  await serveStdio();
}
