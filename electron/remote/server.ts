// electron/remote/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, createReadStream } from "fs";
import { join, resolve, relative, extname, isAbsolute } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, timingSafeEqual } from "crypto";
import { networkInterfaces } from "os";
import {
  writeToAgent,
  resizeAgent,
  killAgent,
  subscribeToAgent,
  unsubscribeFromAgent,
  getAgentScrollback,
  getActiveAgentIds,
  getAgentMeta,
  getAgentCols,
  onPtyEvent,
} from "../ipc/pty.js";
import {
  parseClientMessage,
  type ServerMessage,
  type RemoteAgent,
} from "./protocol.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface RemoteServer {
  stop: () => Promise<void>;
  token: string;
  port: number;
  url: string;
  tailscaleUrl: string | null;
  wifiUrl: string | null;
  connectedClients: () => number;
}

/** Detect available network IPs (WiFi and Tailscale). */
function getNetworkIps(): { wifi: string | null; tailscale: string | null } {
  const nets = networkInterfaces();
  let wifi: string | null = null;
  let tailscale: string | null = null;

  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("100.")) {
        tailscale ??= addr.address;
      } else if (!addr.address.startsWith("172.")) {
        wifi ??= addr.address;
      }
    }
  }

  return { wifi, tailscale };
}

/** Build the agent list, deduplicated by taskId (keeps latest agent per task). */
function buildAgentList(
  getTaskName: (taskId: string) => string,
  getAgentStatus: (agentId: string) => { status: "running" | "exited"; exitCode: number | null; lastLine: string },
): RemoteAgent[] {
  const byTask = new Map<string, RemoteAgent>();
  for (const agentId of getActiveAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta) continue;
    const info = getAgentStatus(agentId);
    const agent: RemoteAgent = {
      agentId,
      taskId: meta.taskId,
      taskName: getTaskName(meta.taskId),
      status: info.status,
      exitCode: info.exitCode,
      lastLine: info.lastLine,
    };
    // Prefer running agents over exited ones for the same task
    const existing = byTask.get(meta.taskId);
    if (!existing || (agent.status === "running" && existing.status !== "running")) {
      byTask.set(meta.taskId, agent);
    }
  }
  return Array.from(byTask.values());
}

export function startRemoteServer(opts: {
  port: number;
  staticDir: string;
  getTaskName: (taskId: string) => string;
  getAgentStatus: (agentId: string) => { status: "running" | "exited"; exitCode: number | null; lastLine: string };
}): RemoteServer {
  const token = randomBytes(24).toString("base64url");
  const ips = getNetworkIps();

  const tokenBuf = Buffer.from(token);

  function safeCompare(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const buf = Buffer.from(candidate);
    if (buf.length !== tokenBuf.length) return false;
    return timingSafeEqual(buf, tokenBuf);
  }

  function checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && safeCompare(auth.slice(7))) return true;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return safeCompare(url.searchParams.get("token"));
  }

  const SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // --- API routes (require auth) ---
    if (url.pathname.startsWith("/api/")) {
      if (!checkAuth(req)) {
        res.writeHead(401, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === "GET") {
        const agentId = agentMatch[1];
        const scrollback = getAgentScrollback(agentId);
        if (scrollback === null) {
          res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "agent not found" }));
          return;
        }
        const meta = getAgentMeta(agentId);
        const info = meta ? opts.getAgentStatus(agentId) : null;
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ agentId, scrollback, status: info?.status ?? "exited", exitCode: info?.exitCode ?? null }));
        return;
      }

      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // --- Static file serving for mobile SPA (async) ---
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = resolve(opts.staticDir, filePath.replace(/^\/+/, ""));
    const rel = relative(opts.staticDir, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end("Bad request");
      return;
    }

    const serveFile = (path: string, ct: string, cc: string) => {
      const stream = createReadStream(path);
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": ct, "Cache-Control": cc });
      stream.pipe(res);
      stream.on("error", () => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
    };

    if (!existsSync(fullPath)) {
      const indexPath = join(opts.staticDir, "index.html");
      if (existsSync(indexPath)) {
        serveFile(indexPath, "text/html", "no-cache");
        return;
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end("Not found");
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    serveFile(fullPath, contentType, cacheControl);
  });

  // --- WebSocket server ---
  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: (info, cb) => {
      if (wss.clients.size >= 10) {
        cb(false, 429, "Too many connections");
        return;
      }
      if (!checkAuth(info.req)) {
        cb(false, 401, "Unauthorized");
        return;
      }
      cb(true);
    },
  });

  const clientSubs = new WeakMap<WebSocket, Map<string, (data: string) => void>>();

  function broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  const unsubSpawn = onPtyEvent("spawn", () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: "agents", list });
  });

  const unsubListChanged = onPtyEvent("list-changed", () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: "agents", list });
  });

  const unsubExit = onPtyEvent("exit", (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    broadcast({ type: "status", agentId, status: "exited", exitCode: exitCode ?? null });
    // Clean stale subscription entries from all connected clients
    for (const client of wss.clients) {
      clientSubs.get(client)?.delete(agentId);
    }
    setTimeout(() => {
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
      broadcast({ type: "agents", list });
    }, 100);
  });

  wss.on("connection", (ws) => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    ws.send(JSON.stringify({ type: "agents", list } satisfies ServerMessage));

    clientSubs.set(ws, new Map());

    ws.on("message", (raw) => {
      const msg = parseClientMessage(String(raw));
      if (!msg) return;

      switch (msg.type) {
        case "input":
          try { writeToAgent(msg.agentId, msg.data); } catch { /* agent gone */ }
          break;

        case "resize":
          try { resizeAgent(msg.agentId, msg.cols, msg.rows); } catch { /* agent gone */ }
          break;

        case "kill":
          try { killAgent(msg.agentId); } catch { /* agent gone */ }
          break;

        case "subscribe": {
          const subs = clientSubs.get(ws);
          if (subs?.has(msg.agentId)) break;

          const scrollback = getAgentScrollback(msg.agentId);
          if (scrollback) {
            ws.send(JSON.stringify({ type: "scrollback", agentId: msg.agentId, data: scrollback, cols: getAgentCols(msg.agentId) } satisfies ServerMessage));
          }

          const cb = (encoded: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "output", agentId: msg.agentId, data: encoded } satisfies ServerMessage));
            }
          };
          if (subscribeToAgent(msg.agentId, cb)) {
            subs?.set(msg.agentId, cb);
          }
          break;
        }

        case "unsubscribe": {
          const subs = clientSubs.get(ws);
          const cb = subs?.get(msg.agentId);
          if (cb) {
            unsubscribeFromAgent(msg.agentId, cb);
            subs?.delete(msg.agentId);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      const subs = clientSubs.get(ws);
      if (subs) {
        for (const [agentId, cb] of subs) {
          unsubscribeFromAgent(agentId, cb);
        }
      }
    });
  });

  server.on("error", (err) => {
    console.error("[remote] Server error:", err.message);
  });
  server.listen(opts.port, "0.0.0.0");

  const primaryIp = ips.wifi ?? ips.tailscale ?? "127.0.0.1";
  const url = `http://${primaryIp}:${opts.port}?token=${token}`;
  const wifiUrl = ips.wifi ? `http://${ips.wifi}:${opts.port}?token=${token}` : null;
  const tailscaleUrl = ips.tailscale ? `http://${ips.tailscale}:${opts.port}?token=${token}` : null;

  return {
    token,
    port: opts.port,
    url,
    wifiUrl,
    tailscaleUrl,
    connectedClients: () => wss.clients.size,
    stop: () => new Promise<void>((resolve) => {
      unsubSpawn();
      unsubExit();
      unsubListChanged();
      for (const client of wss.clients) client.close();
      wss.close();
      server.close(() => resolve());
    }),
  };
}
