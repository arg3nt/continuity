import { readFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "3099", 10);
const DIR = import.meta.dir;

// Explicit allowlist of servable files. The request path is only ever used as
// a key into this map, never as a filesystem path, so there is no traversal
// surface: anything not listed here is a 404.
const ROUTES = {
  "/": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", mime: "text/css; charset=utf-8" },
  "/client.js": { file: "client.js", mime: "text/javascript; charset=utf-8" },
};

/**
 * Serve one of the known static files. Returns null if the path is not in the
 * allowlist or the file can't be read.
 */
function serveStatic(pathname) {
  const route = ROUTES[pathname];
  if (!route) return null;

  try {
    const body = readFileSync(join(DIR, route.file));
    return new Response(body, { headers: { "Content-Type": route.mime } });
  } catch {
    return null;
  }
}

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req);
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Static files
    const res = serveStatic(url.pathname);
    if (res) return res;

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log(`[ws] connected  ${new Date().toISOString()}`);
    },
    message(ws, message) {
      // Echo the message back as-is
      ws.send(message);
    },
    close(ws, code, reason) {
      console.log(
        `[ws] disconnected ${new Date().toISOString()} code=${code} reason=${reason}`
      );
    },
  },
});

console.log(`Continuity server listening on http://localhost:${server.port}`);

// Graceful shutdown: stop accepting connections and exit cleanly when the
// container runtime (e.g. Kubernetes) sends SIGTERM, or on Ctrl-C (SIGINT).
function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, stopping server`);
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
