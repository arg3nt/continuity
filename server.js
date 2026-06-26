import { readFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "3099", 10);
const DIR = import.meta.dir;

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

/**
 * Serve a static file from the continuity directory.
 * Returns null if not found.
 */
function serveStatic(pathname) {
  // Map / to /index.html
  if (pathname === "/") pathname = "/index.html";

  const ext = pathname.split(".").pop();
  const mime = MIME[ext];
  if (!mime) return null;

  try {
    const body = readFileSync(join(DIR, pathname));
    return new Response(body, { headers: { "Content-Type": mime } });
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
