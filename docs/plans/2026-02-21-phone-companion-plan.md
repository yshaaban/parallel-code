# Phone Companion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an opt-in web server to the Electron app that serves a mobile-friendly SPA for monitoring and interacting with agent terminals from a phone browser.

**Architecture:** The Electron main process gains a WebSocket + HTTP server (Node.js `http` + `ws` library) that taps into the existing PTY session pool via a subscriber pattern. A separate SolidJS SPA is built for mobile and served as static files. Auth uses a single-use random token displayed as a QR code.

**Tech Stack:** Node.js `http` module, `ws` WebSocket library, `qrcode` for QR generation, SolidJS for mobile SPA, xterm.js for terminal rendering on phone.

**Design doc:** `docs/plans/2026-02-21-phone-companion-design.md`

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install ws, qrcode, and their types**

Run:
```bash
npm install ws qrcode && npm install -D @types/ws @types/qrcode
```

**Step 2: Verify installation**

Run: `npm ls ws qrcode`
Expected: Both packages listed without errors.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws and qrcode dependencies for phone companion"
```

---

## Task 2: Ring Buffer Utility

Pure utility with no dependencies on Electron. Stores the last ~64KB of terminal output per agent for replay when a phone connects mid-session.

**Files:**
- Create: `electron/remote/ring-buffer.ts`

**Step 1: Create ring buffer implementation**

```typescript
// electron/remote/ring-buffer.ts

/** Fixed-capacity ring buffer for terminal scrollback replay. */
export class RingBuffer {
  private buf: Buffer;
  private pos = 0;
  private full = false;

  constructor(private readonly capacity: number = 64 * 1024) {
    this.buf = Buffer.alloc(capacity);
  }

  /** Append data to the ring buffer. */
  write(data: Buffer): void {
    if (data.length >= this.capacity) {
      // Data larger than buffer — keep only the tail
      data.copy(this.buf, 0, data.length - this.capacity);
      this.pos = 0;
      this.full = true;
      return;
    }

    const spaceAtEnd = this.capacity - this.pos;
    if (data.length <= spaceAtEnd) {
      data.copy(this.buf, this.pos);
    } else {
      data.copy(this.buf, this.pos, 0, spaceAtEnd);
      data.copy(this.buf, 0, spaceAtEnd);
    }

    this.pos = (this.pos + data.length) % this.capacity;
    if (!this.full && this.pos < data.length) this.full = true;
  }

  /** Read all buffered data in chronological order. */
  read(): Buffer {
    if (!this.full) return this.buf.subarray(0, this.pos);
    return Buffer.concat([
      this.buf.subarray(this.pos),
      this.buf.subarray(0, this.pos),
    ]);
  }

  /** Return buffered data as a base64 string. */
  toBase64(): string {
    return this.read().toString("base64");
  }

  /** Number of bytes currently stored. */
  get length(): number {
    return this.full ? this.capacity : this.pos;
  }

  /** Reset the buffer. */
  clear(): void {
    this.pos = 0;
    this.full = false;
  }
}
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 3: Commit**

```bash
git add electron/remote/ring-buffer.ts
git commit -m "feat(remote): add ring buffer for terminal scrollback replay"
```

---

## Task 3: WebSocket Protocol Types

Shared type definitions for messages between the server and mobile client. These types are used by both the Electron backend and the mobile SPA.

**Files:**
- Create: `electron/remote/protocol.ts`

**Step 1: Create protocol types**

```typescript
// electron/remote/protocol.ts

/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: "running" | "exited";
  exitCode: number | null;
  lastLine: string;
}

// --- Server → Client messages ---

export interface OutputMessage {
  type: "output";
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: "status";
  agentId: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export interface AgentsMessage {
  type: "agents";
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: "scrollback";
  agentId: string;
  data: string; // base64
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage;

// --- Client → Server messages ---

export interface InputCommand {
  type: "input";
  agentId: string;
  data: string;
}

export interface ResizeCommand {
  type: "resize";
  agentId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: "kill";
  agentId: string;
}

export interface SubscribeCommand {
  type: "subscribe";
  agentId: string;
}

export interface UnsubscribeCommand {
  type: "unsubscribe";
  agentId: string;
}

export type ClientMessage =
  | InputCommand
  | ResizeCommand
  | KillCommand
  | SubscribeCommand
  | UnsubscribeCommand;

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== "string") return null;
    if (typeof msg.agentId !== "string") return null;

    switch (msg.type) {
      case "input":
        if (typeof msg.data !== "string") return null;
        return { type: "input", agentId: msg.agentId, data: msg.data };
      case "resize":
        if (typeof msg.cols !== "number" || typeof msg.rows !== "number") return null;
        return { type: "resize", agentId: msg.agentId, cols: msg.cols, rows: msg.rows };
      case "kill":
        return { type: "kill", agentId: msg.agentId };
      case "subscribe":
        return { type: "subscribe", agentId: msg.agentId };
      case "unsubscribe":
        return { type: "unsubscribe", agentId: msg.agentId };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 3: Commit**

```bash
git add electron/remote/protocol.ts
git commit -m "feat(remote): add WebSocket protocol types and validation"
```

---

## Task 4: PTY Subscriber Pattern

Modify the existing PTY pool to support multiple output consumers without changing the desktop IPC flow.

**Files:**
- Modify: `electron/ipc/pty.ts`

**Step 1: Add subscriber infrastructure to PtySession**

In `electron/ipc/pty.ts`, update the `PtySession` interface and add the subscriber/event bus:

```typescript
// Add import at top
import { RingBuffer } from "../remote/ring-buffer.js";

// Update PtySession interface to add:
//   subscribers: Set<(encoded: string) => void>;
//   scrollback: RingBuffer;

// Add after the sessions Map:
type PtyEventType = "spawn" | "exit";
type PtyEventListener = (agentId: string, data?: unknown) => void;
const eventListeners = new Map<PtyEventType, Set<PtyEventListener>>();

export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  if (!eventListeners.has(event)) eventListeners.set(event, new Set());
  eventListeners.get(event)!.add(listener);
  return () => { eventListeners.get(event)?.delete(listener); };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  eventListeners.get(event)?.forEach((fn) => fn(agentId, data));
}
```

**Step 2: Update spawnAgent to initialize subscribers and scrollback**

In the `spawnAgent` function, after creating the session object:

```typescript
// Add to session creation:
const session: PtySession = {
  proc,
  channelId,
  taskId: args.taskId,
  agentId: args.agentId,
  flushTimer: null,
  subscribers: new Set(),
  scrollback: new RingBuffer(),
};
```

At end of `spawnAgent`, after setting up `proc.onExit`, add:
```typescript
emitPtyEvent("spawn", args.agentId);
```

**Step 3: Update the flush function to write to scrollback + subscribers**

In the `flush` closure inside `spawnAgent`, after the existing `send()` call, add:

```typescript
// After: send({ type: "Data", data: encoded });
// Add:
session.scrollback.write(batch);
for (const sub of session.subscribers) {
  sub(encoded);
}
```

Note: `session.scrollback.write(batch)` writes the raw Buffer before base64 encoding. The subscribers receive the already-encoded base64 string (same as desktop).

**Step 4: Emit exit event in onExit handler**

In the `proc.onExit` callback, before `sessions.delete(args.agentId)`, add:

```typescript
emitPtyEvent("exit", args.agentId, { exitCode, signal });
```

**Step 5: Export subscriber helpers**

Add these exported functions at the bottom of the file:

```typescript
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

export function getAgentMeta(agentId: string): { taskId: string; agentId: string } | null {
  const s = sessions.get(agentId);
  return s ? { taskId: s.taskId, agentId: s.agentId } : null;
}
```

**Step 6: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 7: Verify desktop still works**

Run: `npm run dev`
Expected: App launches, terminals work as before.

**Step 8: Commit**

```bash
git add electron/ipc/pty.ts
git commit -m "feat(remote): add subscriber pattern and scrollback to PTY pool"
```

---

## Task 5: Remote Access Web Server

The HTTP + WebSocket server that serves the mobile SPA and handles real-time terminal streaming. Uses Node.js built-in `http` module and the `ws` library.

**Files:**
- Create: `electron/remote/server.ts`

**Step 1: Create the server module**

```typescript
// electron/remote/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";
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
  connectedClients: () => number;
}

/** Resolve the Tailscale IP, falling back to first non-internal IPv4. */
function getExternalIp(): string {
  const nets = networkInterfaces();
  // Prefer Tailscale interface (100.x.x.x range)
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("100.")) {
        return addr.address;
      }
    }
  }
  // Fallback to any non-internal IPv4
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

/** Build the agent list for the agents message. */
function buildAgentList(
  getTaskName: (taskId: string) => string,
  getAgentStatus: (agentId: string) => { status: "running" | "exited"; exitCode: number | null; lastLine: string },
): RemoteAgent[] {
  return getActiveAgentIds().map((agentId) => {
    const meta = getAgentMeta(agentId);
    if (!meta) return null;
    const info = getAgentStatus(agentId);
    return {
      agentId,
      taskId: meta.taskId,
      taskName: getTaskName(meta.taskId),
      status: info.status,
      exitCode: info.exitCode,
      lastLine: info.lastLine,
    };
  }).filter((a): a is RemoteAgent => a !== null);
}

export function startRemoteServer(opts: {
  port: number;
  staticDir: string;
  getTaskName: (taskId: string) => string;
  getAgentStatus: (agentId: string) => { status: "running" | "exited"; exitCode: number | null; lastLine: string };
}): RemoteServer {
  const token = randomBytes(24).toString("base64url");
  const ip = getExternalIp();

  function checkAuth(req: IncomingMessage): boolean {
    // Check Authorization header
    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}`) return true;
    // Check query param
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return url.searchParams.get("token") === token;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // --- API routes (require auth) ---
    if (url.pathname.startsWith("/api/")) {
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === "GET") {
        const agentId = agentMatch[1];
        const scrollback = getAgentScrollback(agentId);
        if (scrollback === null) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "agent not found" }));
          return;
        }
        const meta = getAgentMeta(agentId);
        const info = meta ? opts.getAgentStatus(agentId) : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agentId, scrollback, status: info?.status ?? "exited", exitCode: info?.exitCode ?? null }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // --- Static file serving for mobile SPA ---
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    // Prevent directory traversal
    if (filePath.includes("..")) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    const fullPath = join(opts.staticDir, filePath);
    if (!existsSync(fullPath)) {
      // SPA fallback — serve index.html for all non-file routes
      const indexPath = join(opts.staticDir, "index.html");
      if (existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(readFileSync(indexPath));
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(readFileSync(fullPath));
  });

  // --- WebSocket server ---
  const wss = new WebSocketServer({ server });

  // Track per-client subscriptions for cleanup
  const clientSubs = new WeakMap<WebSocket, Map<string, (data: string) => void>>();

  function broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  // Broadcast agent list when agents spawn/exit
  const unsubSpawn = onPtyEvent("spawn", () => {
    const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
    broadcast({ type: "agents", list });
  });

  const unsubExit = onPtyEvent("exit", (agentId, data) => {
    const { exitCode } = (data ?? {}) as { exitCode?: number };
    broadcast({ type: "status", agentId, status: "exited", exitCode: exitCode ?? null });
    // Then send updated list
    setTimeout(() => {
      const list = buildAgentList(opts.getTaskName, opts.getAgentStatus);
      broadcast({ type: "agents", list });
    }, 100);
  });

  wss.on("connection", (ws, req) => {
    // Auth check
    if (!checkAuth(req)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Send current agent list on connect
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
          if (subs?.has(msg.agentId)) break; // already subscribed

          // Send scrollback first
          const scrollback = getAgentScrollback(msg.agentId);
          if (scrollback) {
            ws.send(JSON.stringify({ type: "scrollback", agentId: msg.agentId, data: scrollback } satisfies ServerMessage));
          }

          // Subscribe to live output
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
      // Cleanup all subscriptions
      const subs = clientSubs.get(ws);
      if (subs) {
        for (const [agentId, cb] of subs) {
          unsubscribeFromAgent(agentId, cb);
        }
      }
    });
  });

  server.listen(opts.port, "0.0.0.0");

  const url = `http://${ip}:${opts.port}?token=${token}`;

  return {
    token,
    port: opts.port,
    url,
    connectedClients: () => wss.clients.size,
    stop: () => new Promise<void>((resolve) => {
      unsubSpawn();
      unsubExit();
      for (const client of wss.clients) client.close();
      wss.close();
      server.close(() => resolve());
    }),
  };
}
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 3: Commit**

```bash
git add electron/remote/server.ts
git commit -m "feat(remote): add HTTP + WebSocket server for phone companion"
```

---

## Task 6: IPC Channels and Registration

Wire the remote server start/stop into the Electron IPC system so the renderer can control it.

**Files:**
- Modify: `electron/ipc/channels.ts`
- Modify: `electron/preload.cjs`
- Modify: `electron/ipc/register.ts`
- Modify: `electron/main.ts`

**Step 1: Add IPC channel enums**

In `electron/ipc/channels.ts`, add to the `IPC` enum before the closing brace:

```typescript
  // Remote access
  StartRemoteServer = "start_remote_server",
  StopRemoteServer = "stop_remote_server",
  GetRemoteStatus = "get_remote_status",
```

**Step 2: Add channels to preload allowlist**

In `electron/preload.cjs`, add to `ALLOWED_CHANNELS`:

```javascript
  // Remote access
  "start_remote_server", "stop_remote_server", "get_remote_status",
```

**Step 3: Add IPC handlers in register.ts**

In `electron/ipc/register.ts`, add the import and handlers.

Add import at top:
```typescript
import { startRemoteServer } from "../remote/server.js";
```

Add inside `registerAllHandlers`, in a new "Remote access" section:

```typescript
  // --- Remote access ---
  let remoteServer: ReturnType<typeof startRemoteServer> | null = null;

  ipcMain.handle(IPC.StartRemoteServer, (_e, args: { port?: number }) => {
    if (remoteServer) return { url: remoteServer.url, token: remoteServer.token, port: remoteServer.port };

    const distRemote = path.join(__dirname, "..", "dist-remote");
    remoteServer = startRemoteServer({
      port: args.port ?? 7777,
      staticDir: distRemote,
      getTaskName: (taskId: string) => taskId, // Renderer will provide real names via protocol
      getAgentStatus: () => ({ status: "running" as const, exitCode: null, lastLine: "" }),
    });
    return { url: remoteServer.url, token: remoteServer.token, port: remoteServer.port };
  });

  ipcMain.handle(IPC.StopRemoteServer, async () => {
    if (remoteServer) {
      await remoteServer.stop();
      remoteServer = null;
    }
  });

  ipcMain.handle(IPC.GetRemoteStatus, () => {
    if (!remoteServer) return { enabled: false, connectedClients: 0 };
    return { enabled: true, connectedClients: remoteServer.connectedClients(), url: remoteServer.url, token: remoteServer.token, port: remoteServer.port };
  });
```

**Step 4: Stop remote server on app quit**

In `electron/main.ts`, update the `before-quit` handler to also stop the remote server. Actually, since the remote server reference is inside `registerAllHandlers`, we need a different approach. Add to `main.ts`:

Import `killAllAgents` is already there. The remote server will be cleaned up when `server.close()` is called during process exit. No change needed — Node.js will close the socket on exit.

**Step 5: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 6: Commit**

```bash
git add electron/ipc/channels.ts electron/preload.cjs electron/ipc/register.ts
git commit -m "feat(remote): wire remote server start/stop into IPC system"
```

---

## Task 7: Frontend Store State

Add `remoteAccess` state to the SolidJS store and create store actions.

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/core.ts`
- Create: `src/store/remote.ts`
- Modify: `src/store/store.ts`

**Step 1: Add RemoteAccess type to store types**

In `src/store/types.ts`, add the interface and the field to `AppStore`:

```typescript
export interface RemoteAccess {
  enabled: boolean;
  token: string | null;
  port: number;
  url: string | null;
  connectedClients: number;
}
```

Add to `AppStore` interface:
```typescript
  remoteAccess: RemoteAccess;
```

**Step 2: Initialize in core store**

In `src/store/core.ts`, add to the `createStore<AppStore>()` initial value:

```typescript
  remoteAccess: {
    enabled: false,
    token: null,
    port: 7777,
    url: null,
    connectedClients: 0,
  },
```

**Step 3: Create remote store module**

```typescript
// src/store/remote.ts

import { setStore } from "./core";
import { invoke } from "../lib/ipc";
import { IPC } from "../../electron/ipc/channels";

export async function startRemoteAccess(port?: number): Promise<{ url: string; token: string }> {
  const result = await invoke<{ url: string; token: string; port: number }>(
    IPC.StartRemoteServer,
    port ? { port } : {}
  );
  setStore("remoteAccess", {
    enabled: true,
    token: result.token,
    port: result.port,
    url: result.url,
    connectedClients: 0,
  });
  return result;
}

export async function stopRemoteAccess(): Promise<void> {
  await invoke(IPC.StopRemoteServer);
  setStore("remoteAccess", {
    enabled: false,
    token: null,
    port: 7777,
    url: null,
    connectedClients: 0,
  });
}

export async function refreshRemoteStatus(): Promise<void> {
  const result = await invoke<{
    enabled: boolean;
    connectedClients: number;
    url?: string;
    token?: string;
    port?: number;
  }>(IPC.GetRemoteStatus);

  if (result.enabled) {
    setStore("remoteAccess", {
      enabled: true,
      connectedClients: result.connectedClients,
      url: result.url ?? null,
      token: result.token ?? null,
      port: result.port ?? 7777,
    });
  } else {
    setStore("remoteAccess", "enabled", false);
    setStore("remoteAccess", "connectedClients", 0);
  }
}
```

**Step 4: Export from store barrel**

In `src/store/store.ts`, add:

```typescript
export { startRemoteAccess, stopRemoteAccess, refreshRemoteStatus } from "./remote";
```

**Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 6: Commit**

```bash
git add src/store/types.ts src/store/core.ts src/store/remote.ts src/store/store.ts
git commit -m "feat(remote): add remoteAccess state and actions to store"
```

---

## Task 8: Connect Phone Modal

Modal component that shows the QR code and connection URL when remote access is active.

**Files:**
- Create: `src/components/ConnectPhoneModal.tsx`

**Step 1: Create the modal component**

```tsx
// src/components/ConnectPhoneModal.tsx

import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { createFocusRestore } from "../lib/focus-restore";
import { store } from "../store/core";
import { startRemoteAccess, stopRemoteAccess, refreshRemoteStatus } from "../store/remote";
import { theme } from "../lib/theme";

interface ConnectPhoneModalProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectPhoneModal(props: ConnectPhoneModalProps) {
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;

  createFocusRestore(() => props.open);

  // Start server when modal opens, generate QR
  createEffect(() => {
    if (!props.open) return;

    requestAnimationFrame(() => dialogRef?.focus());

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));

    if (!store.remoteAccess.enabled) {
      setStarting(true);
      startRemoteAccess().then(async (result) => {
        setStarting(false);
        // Dynamic import qrcode to generate data URL
        try {
          const QRCode = await import("qrcode");
          const dataUrl = await QRCode.toDataURL(result.url, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          setQrDataUrl(dataUrl);
        } catch {
          // QR generation failed — URL is still shown as text
        }
      }).catch(() => {
        setStarting(false);
      });
    } else if (store.remoteAccess.url) {
      // Already running — generate QR from existing URL
      import("qrcode").then(async (QRCode) => {
        const dataUrl = await QRCode.toDataURL(store.remoteAccess.url!, {
          width: 256,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
        setQrDataUrl(dataUrl);
      }).catch(() => {});
    }

    // Poll connected clients count while modal is open
    const interval = setInterval(() => refreshRemoteStatus(), 3000);
    onCleanup(() => clearInterval(interval));
  });

  async function handleDisconnect() {
    await stopRemoteAccess();
    setQrDataUrl(null);
    props.onClose();
  }

  async function handleCopyUrl() {
    const url = store.remoteAccess.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }

  return (
    <Portal>
      <Show when={props.open}>
        <div
          style={{
            position: "fixed",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "rgba(0,0,0,0.55)",
            "z-index": "1000",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
        >
          <div
            ref={dialogRef}
            tabIndex={0}
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "14px",
              padding: "28px",
              width: "380px",
              display: "flex",
              "flex-direction": "column",
              "align-items": "center",
              gap: "20px",
              outline: "none",
              "box-shadow": "0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ margin: "0", "font-size": "16px", color: theme.fg, "font-weight": "600" }}>
              Connect Phone
            </h2>

            <Show when={starting()}>
              <div style={{ color: theme.fgMuted, "font-size": "13px" }}>
                Starting server...
              </div>
            </Show>

            <Show when={!starting() && store.remoteAccess.enabled}>
              {/* QR Code */}
              <Show when={qrDataUrl()}>
                <img
                  src={qrDataUrl()!}
                  alt="Connection QR code"
                  style={{ width: "200px", height: "200px", "border-radius": "8px" }}
                />
              </Show>

              {/* URL */}
              <div style={{
                width: "100%",
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                "border-radius": "8px",
                padding: "10px 12px",
                "font-size": "12px",
                "font-family": "'JetBrains Mono', monospace",
                color: theme.fg,
                "word-break": "break-all",
                "text-align": "center",
                cursor: "pointer",
              }}
                onClick={handleCopyUrl}
                title="Click to copy"
              >
                {store.remoteAccess.url}
              </div>

              <Show when={copied()}>
                <span style={{ "font-size": "12px", color: theme.success }}>Copied!</span>
              </Show>

              {/* Instructions */}
              <p style={{ "font-size": "12px", color: theme.fgMuted, "text-align": "center", margin: "0", "line-height": "1.5" }}>
                Scan the QR code with your phone camera, or copy the URL.
                Both devices must be on the same Tailscale network.
              </p>

              {/* Connected clients */}
              <div style={{
                "font-size": "12px",
                color: store.remoteAccess.connectedClients > 0 ? theme.success : theme.fgSubtle,
                display: "flex",
                "align-items": "center",
                gap: "6px",
              }}>
                <div style={{
                  width: "8px",
                  height: "8px",
                  "border-radius": "50%",
                  background: store.remoteAccess.connectedClients > 0 ? theme.success : theme.fgSubtle,
                }} />
                {store.remoteAccess.connectedClients > 0
                  ? `${store.remoteAccess.connectedClients} client(s) connected`
                  : "Waiting for connection..."}
              </div>

              {/* Disconnect button */}
              <button
                onClick={handleDisconnect}
                style={{
                  padding: "9px 20px",
                  background: theme.error,
                  border: "none",
                  "border-radius": "8px",
                  color: "#fff",
                  cursor: "pointer",
                  "font-size": "13px",
                  "font-weight": "500",
                  width: "100%",
                }}
              >
                Disconnect
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </Portal>
  );
}
```

**Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: No errors (qrcode types should resolve from @types/qrcode).

**Step 3: Commit**

```bash
git add src/components/ConnectPhoneModal.tsx
git commit -m "feat(remote): add ConnectPhoneModal with QR code display"
```

---

## Task 9: Connect Phone Button in Sidebar

Add the "Connect Phone" button to the sidebar, below "New Task".

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: Add imports and state**

At the top of `Sidebar.tsx`, add:

```typescript
import { ConnectPhoneModal } from "./ConnectPhoneModal";
```

Inside the `Sidebar` function, add a signal:

```typescript
const [showConnectPhone, setShowConnectPhone] = createSignal(false);
```

**Step 2: Add Connect Phone button**

In the sidebar JSX, after the "New Task" `</Show>` block (line ~437) and before the `{/* Tasks grouped by project */}` comment, add:

```tsx
      {/* Connect Phone button */}
      <Show when={store.projects.length > 0}>
        <button
          class="icon-btn"
          onClick={() => setShowConnectPhone(true)}
          style={{
            background: "transparent",
            border: `1px solid ${store.remoteAccess.enabled ? theme.success : theme.border}`,
            "border-radius": "8px",
            padding: "8px 14px",
            color: store.remoteAccess.enabled ? theme.success : theme.fgMuted,
            cursor: "pointer",
            "font-size": sf(12),
            "font-weight": "500",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            gap: "6px",
            width: "100%",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.5 1A1.5 1.5 0 003 2.5v11A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-11A1.5 1.5 0 0011.5 1h-7zM4.5 2h7a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5zM7 12.5a1 1 0 102 0 1 1 0 00-2 0z" />
          </svg>
          {store.remoteAccess.enabled
            ? `Phone Connected (${store.remoteAccess.connectedClients})`
            : "Connect Phone"}
        </button>
      </Show>
```

**Step 3: Add ConnectPhoneModal**

Before the closing `</div>` of the sidebar (before the resize handle), add alongside the other dialogs:

```tsx
      <ConnectPhoneModal
        open={showConnectPhone()}
        onClose={() => setShowConnectPhone(false)}
      />
```

**Step 4: Add store.remoteAccess import**

The `store` is already imported. Need to verify `store.remoteAccess` is accessible — it will be since we added it to `AppStore`.

**Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 6: Verify visually**

Run: `npm run dev`
Expected: "Connect Phone" button appears below "New Task" in sidebar.

**Step 7: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(remote): add Connect Phone button to sidebar"
```

---

## Task 10: Mobile SPA — Build Setup

Configure a separate Vite build for the mobile SPA that outputs to `dist-remote/`.

**Files:**
- Create: `src/remote/index.html`
- Create: `src/remote/index.tsx`
- Create: `src/remote/vite.config.ts`

**Step 1: Create the mobile entry HTML**

```html
<!-- src/remote/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <meta name="theme-color" content="#1e1e1e" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <title>Parallel Code</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body, #root { width: 100%; height: 100%; overflow: hidden; }
      body { background: #1e1e1e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./index.tsx" type="module"></script>
  </body>
</html>
```

**Step 2: Create the mobile entry point**

```tsx
// src/remote/index.tsx
import { render } from "solid-js/web";
import { App } from "./App";

render(() => <App />, document.getElementById("root") as HTMLElement);
```

**Step 3: Create the mobile Vite config**

```typescript
// src/remote/vite.config.ts
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "path";

export default defineConfig({
  base: "./",
  root: path.resolve(__dirname),
  plugins: [solid()],
  build: {
    outDir: path.resolve(__dirname, "../../dist-remote"),
    emptyOutDir: true,
  },
});
```

**Step 4: Add build script to package.json**

Add to `scripts` in `package.json`:

```json
"build:remote": "vite build --config src/remote/vite.config.ts"
```

Update `build` script to include remote:

```json
"build": "npm run build:frontend && npm run build:remote && npm run compile && electron-builder"
```

Also add `dist-remote/` to the `"files"` array in the `"build"` section of `package.json`:

```json
"files": [
  "dist/**/*",
  "dist-electron/**/*",
  "dist-remote/**/*",
  "electron/preload.cjs"
],
```

**Step 5: Add dist-remote to .gitignore (if .gitignore exists)**

Run: Check if .gitignore exists and add `dist-remote/` if not already present.

**Step 6: Commit**

```bash
git add src/remote/index.html src/remote/index.tsx src/remote/vite.config.ts package.json
git commit -m "feat(remote): add mobile SPA build configuration"
```

---

## Task 11: Mobile SPA — Auth Module

Handles token extraction from URL and storage in localStorage.

**Files:**
- Create: `src/remote/auth.ts`

**Step 1: Create auth module**

```typescript
// src/remote/auth.ts

const TOKEN_KEY = "parallel-code-token";

/** Extract token from URL query param and persist to localStorage. */
export function initAuth(): string | null {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");

  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    // Clean token from URL without reload
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.pathname);
    return urlToken;
  }

  return localStorage.getItem(TOKEN_KEY);
}

/** Get the stored token. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Build an authenticated URL for API requests. */
export function apiUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** Build headers with auth token. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
```

**Step 2: Commit**

```bash
git add src/remote/auth.ts
git commit -m "feat(remote): add mobile auth token handling"
```

---

## Task 12: Mobile SPA — WebSocket Client

Manages the WebSocket connection, auto-reconnect, and reactive state.

**Files:**
- Create: `src/remote/ws.ts`

**Step 1: Create the WebSocket client**

```typescript
// src/remote/ws.ts

import { createSignal } from "solid-js";
import { getToken } from "./auth";
import type { ServerMessage, RemoteAgent } from "../../electron/remote/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>("disconnected");

// Per-agent output listeners
type OutputListener = (data: string) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<OutputListener>>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export { agents, status };

export function connect(): void {
  if (ws) return;

  const token = getToken();
  if (!token) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?token=${token}`;

  setStatus("connecting");
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus("connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage;

    switch (msg.type) {
      case "agents":
        setAgents(msg.list);
        break;

      case "output": {
        const listeners = outputListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case "scrollback": {
        const listeners = scrollbackListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case "status":
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === msg.agentId
              ? { ...a, status: msg.status, exitCode: msg.exitCode }
              : a
          )
        );
        break;
    }
  };

  ws.onclose = () => {
    ws = null;
    setStatus("disconnected");
    // Auto-reconnect after 3 seconds
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
  setStatus("disconnected");
}

export function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function subscribeAgent(agentId: string): void {
  send({ type: "subscribe", agentId });
}

export function unsubscribeAgent(agentId: string): void {
  send({ type: "unsubscribe", agentId });
}

export function onOutput(agentId: string, fn: OutputListener): () => void {
  if (!outputListeners.has(agentId)) outputListeners.set(agentId, new Set());
  outputListeners.get(agentId)!.add(fn);
  return () => { outputListeners.get(agentId)?.delete(fn); };
}

export function onScrollback(agentId: string, fn: OutputListener): () => void {
  if (!scrollbackListeners.has(agentId)) scrollbackListeners.set(agentId, new Set());
  scrollbackListeners.get(agentId)!.add(fn);
  return () => { scrollbackListeners.get(agentId)?.delete(fn); };
}

export function sendInput(agentId: string, data: string): void {
  send({ type: "input", agentId, data });
}

export function sendKill(agentId: string): void {
  send({ type: "kill", agentId });
}
```

**Step 2: Commit**

```bash
git add src/remote/ws.ts
git commit -m "feat(remote): add mobile WebSocket client with auto-reconnect"
```

---

## Task 13: Mobile SPA — Agent List View

The home screen showing all agents as tappable cards.

**Files:**
- Create: `src/remote/AgentList.tsx`

**Step 1: Create the agent list component**

```tsx
// src/remote/AgentList.tsx

import { For, Show, createMemo } from "solid-js";
import { agents, status } from "./ws";
import type { RemoteAgent } from "../../electron/remote/protocol";

interface AgentListProps {
  onSelect: (agentId: string) => void;
}

export function AgentList(props: AgentListProps) {
  const running = createMemo(() => agents().filter((a) => a.status === "running").length);
  const total = createMemo(() => agents().length);

  return (
    <div style={{
      display: "flex",
      "flex-direction": "column",
      height: "100%",
      background: "#1e1e1e",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        padding: "16px 16px 12px",
        "border-bottom": "1px solid #333",
      }}>
        <span style={{ "font-size": "18px", "font-weight": "600", color: "#e0e0e0" }}>
          Parallel Code
        </span>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <div style={{
            width: "8px",
            height: "8px",
            "border-radius": "50%",
            background: status() === "connected" ? "#4ade80" : status() === "connecting" ? "#facc15" : "#ef4444",
          }} />
          <span style={{ "font-size": "13px", color: "#999" }}>
            {running()}/{total()}
          </span>
        </div>
      </div>

      {/* Agent cards */}
      <div style={{
        flex: "1",
        overflow: "auto",
        padding: "12px",
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        "-webkit-overflow-scrolling": "touch",
      }}>
        <Show when={agents().length === 0}>
          <div style={{
            "text-align": "center",
            color: "#666",
            "padding-top": "60px",
            "font-size": "14px",
          }}>
            <Show when={status() === "connected"} fallback={<span>Connecting...</span>}>
              <span>No active agents</span>
            </Show>
          </div>
        </Show>

        <For each={agents()}>
          {(agent: RemoteAgent) => (
            <div
              onClick={() => props.onSelect(agent.agentId)}
              style={{
                background: "#2a2a2a",
                border: "1px solid #333",
                "border-radius": "10px",
                padding: "14px 16px",
                cursor: "pointer",
                display: "flex",
                "flex-direction": "column",
                gap: "6px",
                "touch-action": "manipulation",
              }}
            >
              <div style={{
                display: "flex",
                "align-items": "center",
                "justify-content": "space-between",
              }}>
                <div style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                }}>
                  <div style={{
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    background: agent.status === "running" ? "#4ade80" : "#666",
                    "flex-shrink": "0",
                  }} />
                  <span style={{
                    "font-size": "14px",
                    "font-weight": "500",
                    color: "#e0e0e0",
                  }}>
                    {agent.taskName}
                  </span>
                </div>
                <span style={{
                  "font-size": "12px",
                  color: agent.status === "running" ? "#4ade80" : "#666",
                }}>
                  {agent.status}
                </span>
              </div>

              <Show when={agent.lastLine}>
                <div style={{
                  "font-size": "12px",
                  "font-family": "'JetBrains Mono', 'Courier New', monospace",
                  color: "#888",
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}>
                  &gt; {agent.lastLine}
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/remote/AgentList.tsx
git commit -m "feat(remote): add mobile agent list view"
```

---

## Task 14: Mobile SPA — Agent Detail View

Full-screen terminal view with xterm.js and input controls.

**Files:**
- Create: `src/remote/AgentDetail.tsx`

**Step 1: Create the agent detail component**

```tsx
// src/remote/AgentDetail.tsx

import { onMount, onCleanup, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  sendKill,
  agents,
} from "./ws";

// Base64 decode (same approach as desktop)
const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;
}

function b64decode(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64[b64.charCodeAt(i++)];
    const b = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

interface AgentDetailProps {
  agentId: string;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  const [inputText, setInputText] = createSignal("");
  const [atBottom, setAtBottom] = createSignal(true);

  const agentInfo = () => agents().find((a) => a.agentId === props.agentId);

  onMount(() => {
    if (!termContainer) return;

    term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      theme: { background: "#1e1e1e" },
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true, // We use our own input field
      convertEol: false,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    fitAddon.fit();

    // Track scroll position
    term.onScroll(() => {
      if (!term) return;
      const isBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      setAtBottom(isBottom);
    });

    // Subscribe to agent output
    const cleanupScrollback = onScrollback(props.agentId, (data) => {
      const bytes = b64decode(data);
      term?.write(bytes);
    });

    const cleanupOutput = onOutput(props.agentId, (data) => {
      const bytes = b64decode(data);
      term?.write(bytes);
    });

    subscribeAgent(props.agentId);

    // Handle resize
    const observer = new ResizeObserver(() => {
      fitAddon?.fit();
    });
    observer.observe(termContainer);

    onCleanup(() => {
      observer.disconnect();
      unsubscribeAgent(props.agentId);
      cleanupScrollback();
      cleanupOutput();
      term?.dispose();
    });
  });

  function handleSend() {
    const text = inputText();
    if (!text) return;
    sendInput(props.agentId, text + "\n");
    setInputText("");
  }

  function handleQuickAction(data: string) {
    sendInput(props.agentId, data);
  }

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  return (
    <div style={{
      display: "flex",
      "flex-direction": "column",
      height: "100%",
      background: "#1e1e1e",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        "align-items": "center",
        gap: "12px",
        padding: "12px 16px",
        "border-bottom": "1px solid #333",
        "flex-shrink": "0",
      }}>
        <button
          onClick={props.onBack}
          style={{
            background: "none",
            border: "none",
            color: "#4ade80",
            "font-size": "16px",
            cursor: "pointer",
            padding: "4px 8px",
            "touch-action": "manipulation",
          }}
        >
          &#8592; Back
        </button>
        <span style={{
          "font-size": "15px",
          "font-weight": "500",
          color: "#e0e0e0",
          flex: "1",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}>
          {agentInfo()?.taskName ?? props.agentId}
        </span>
        <div style={{
          width: "8px",
          height: "8px",
          "border-radius": "50%",
          background: agentInfo()?.status === "running" ? "#4ade80" : "#666",
        }} />
      </div>

      {/* Terminal */}
      <div
        ref={termContainer}
        style={{
          flex: "1",
          "min-height": "0",
          padding: "4px",
        }}
      />

      {/* Scroll to bottom FAB */}
      <Show when={!atBottom()}>
        <button
          onClick={scrollToBottom}
          style={{
            position: "absolute",
            bottom: "140px",
            right: "16px",
            width: "40px",
            height: "40px",
            "border-radius": "50%",
            background: "#333",
            border: "1px solid #555",
            color: "#e0e0e0",
            "font-size": "18px",
            cursor: "pointer",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "z-index": "10",
            "touch-action": "manipulation",
          }}
        >
          &#8595;
        </button>
      </Show>

      {/* Input area */}
      <div style={{
        "border-top": "1px solid #333",
        padding: "10px 12px",
        display: "flex",
        "flex-direction": "column",
        gap: "8px",
        "flex-shrink": "0",
        background: "#252525",
      }}>
        {/* Text input */}
        <div style={{
          display: "flex",
          gap: "8px",
        }}>
          <input
            type="text"
            value={inputText()}
            onInput={(e) => setInputText(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
            placeholder="Type command here..."
            style={{
              flex: "1",
              background: "#1e1e1e",
              border: "1px solid #444",
              "border-radius": "8px",
              padding: "10px 12px",
              color: "#e0e0e0",
              "font-size": "14px",
              "font-family": "'JetBrains Mono', 'Courier New', monospace",
              outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            style={{
              background: "#4ade80",
              border: "none",
              "border-radius": "8px",
              padding: "10px 16px",
              color: "#000",
              "font-weight": "600",
              "font-size": "14px",
              cursor: "pointer",
              "touch-action": "manipulation",
            }}
          >
            Send
          </button>
        </div>

        {/* Quick actions */}
        <div style={{
          display: "flex",
          gap: "6px",
          "flex-wrap": "wrap",
        }}>
          {[
            { label: "y", data: "y\n" },
            { label: "n", data: "n\n" },
            { label: "Enter", data: "\n" },
            { label: "Ctrl+C", data: "\x03" },
            { label: "Ctrl+D", data: "\x04" },
          ].map((action) => (
            <button
              onClick={() => handleQuickAction(action.data)}
              style={{
                background: "#333",
                border: "1px solid #444",
                "border-radius": "6px",
                padding: "6px 14px",
                color: "#ccc",
                "font-size": "12px",
                "font-family": "'JetBrains Mono', 'Courier New', monospace",
                cursor: "pointer",
                "touch-action": "manipulation",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/remote/AgentDetail.tsx
git commit -m "feat(remote): add mobile agent detail view with xterm.js"
```

---

## Task 15: Mobile SPA — App Root

Root component with routing between list and detail views, and auth initialization.

**Files:**
- Create: `src/remote/App.tsx`

**Step 1: Create the App component**

```tsx
// src/remote/App.tsx

import { createSignal, onMount, Show } from "solid-js";
import { initAuth, getToken } from "./auth";
import { connect, status } from "./ws";
import { AgentList } from "./AgentList";
import { AgentDetail } from "./AgentDetail";

export function App() {
  const [authed, setAuthed] = createSignal(false);
  const [selectedAgent, setSelectedAgent] = createSignal<string | null>(null);

  onMount(() => {
    const token = initAuth();
    if (token) {
      setAuthed(true);
      connect();
    }
  });

  return (
    <Show
      when={authed()}
      fallback={
        <div style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          height: "100%",
          color: "#999",
          "font-size": "16px",
          padding: "20px",
          "text-align": "center",
        }}>
          <div>
            <p style={{ "margin-bottom": "12px" }}>Not authenticated.</p>
            <p style={{ "font-size": "13px", color: "#666" }}>
              Scan the QR code from the Parallel Code desktop app to connect.
            </p>
          </div>
        </div>
      }
    >
      <Show
        when={selectedAgent()}
        fallback={<AgentList onSelect={(id) => setSelectedAgent(id)} />}
      >
        {(agentId) => (
          <AgentDetail agentId={agentId()} onBack={() => setSelectedAgent(null)} />
        )}
      </Show>
    </Show>
  );
}
```

**Step 2: Verify mobile SPA builds**

Run: `npm run build:remote`
Expected: Build succeeds, output in `dist-remote/`.

**Step 3: Commit**

```bash
git add src/remote/App.tsx
git commit -m "feat(remote): add mobile app root with auth and routing"
```

---

## Task 16: xterm.js CSS for Mobile SPA

The mobile SPA needs xterm.js CSS to render properly. Since it's a separate Vite build, it needs its own import.

**Files:**
- Modify: `src/remote/index.tsx`

**Step 1: Add xterm CSS import**

At the top of `src/remote/index.tsx`:

```typescript
import "@xterm/xterm/css/xterm.css";
```

**Step 2: Verify build still works**

Run: `npm run build:remote`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add src/remote/index.tsx
git commit -m "feat(remote): import xterm.js CSS in mobile SPA"
```

---

## Task 17: Integration — Wire Agent Status into Server

The server currently uses stub functions for `getTaskName` and `getAgentStatus`. Wire these to pull real data from the frontend store via IPC.

**Files:**
- Modify: `electron/ipc/register.ts`

**Step 1: Pass real callbacks to the server**

Replace the stub `getTaskName` and `getAgentStatus` in the `StartRemoteServer` handler with functions that query the renderer for data. Since the server runs in the main process and state is in the renderer, we need a different approach.

Actually, the PTY layer already has `getAgentMeta()` returning taskId. The task names are in the renderer. The simplest approach: store task names in the main process when tasks are created.

Alternative simpler approach: add a `taskNames` map in the `register.ts` scope that gets populated when `CreateTask` is called.

Update `register.ts`:

```typescript
// Inside registerAllHandlers, add at top:
const taskNames = new Map<string, string>();

// Update CreateTask handler to also store the name:
ipcMain.handle(IPC.CreateTask, (_e, args) => {
  validatePath(args.projectRoot, "projectRoot");
  const result = createTask(args.name, args.projectRoot, args.symlinkDirs, args.branchPrefix);
  // Store task name for remote access
  result.then((r: { id: string }) => taskNames.set(r.id, args.name)).catch(() => {});
  return result;
});

// And update the startRemoteServer call to use real callbacks:
getTaskName: (taskId: string) => taskNames.get(taskId) ?? taskId,
getAgentStatus: (agentId: string) => {
  // The PTY layer knows if agent is alive (it's in the sessions map)
  const meta = getAgentMeta(agentId);
  return {
    status: meta ? "running" as const : "exited" as const,
    exitCode: null,
    lastLine: "",
  };
},
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No errors.

**Step 3: Commit**

```bash
git add electron/ipc/register.ts
git commit -m "feat(remote): wire real task names and agent status into server"
```

---

## Task 18: End-to-End Verification

Verify the full flow works: desktop → start server → phone connects → sees agents → interacts.

**Step 1: Build everything**

Run:
```bash
npm run build:remote && npm run compile
```
Expected: Both succeed.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 3: Manual test**

Run: `npm run dev`

Test flow:
1. Open the app, create a project and task
2. Click "Connect Phone" in sidebar
3. Verify QR code and URL appear in modal
4. Open the URL in a browser (or phone browser on Tailscale)
5. Verify agent list shows
6. Tap an agent to see terminal output
7. Send a command via the input field
8. Use quick-action buttons (y, n, Ctrl+C)
9. Click "Disconnect" in desktop modal
10. Verify phone shows disconnected state

**Step 4: Commit**

```bash
git add -A
git commit -m "feat(remote): phone companion feature complete"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Install dependencies | package.json |
| 2 | Ring buffer utility | electron/remote/ring-buffer.ts |
| 3 | WebSocket protocol types | electron/remote/protocol.ts |
| 4 | PTY subscriber pattern | electron/ipc/pty.ts |
| 5 | Remote access web server | electron/remote/server.ts |
| 6 | IPC channels and registration | channels.ts, preload.cjs, register.ts |
| 7 | Frontend store state | types.ts, core.ts, remote.ts, store.ts |
| 8 | Connect Phone modal | ConnectPhoneModal.tsx |
| 9 | Connect Phone button | Sidebar.tsx |
| 10 | Mobile SPA build setup | src/remote/*, package.json |
| 11 | Mobile auth module | src/remote/auth.ts |
| 12 | Mobile WebSocket client | src/remote/ws.ts |
| 13 | Mobile agent list view | src/remote/AgentList.tsx |
| 14 | Mobile agent detail view | src/remote/AgentDetail.tsx |
| 15 | Mobile app root | src/remote/App.tsx |
| 16 | xterm.js CSS for mobile | src/remote/index.tsx |
| 17 | Wire agent status | register.ts |
| 18 | End-to-end verification | — |
