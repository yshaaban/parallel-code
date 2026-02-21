# Phone Companion — Design Document

**Date:** 2026-02-21
**Branch:** task/review-my-agent-terminals-on-my-phone

## Overview

Add a browser-based companion UI that lets you monitor and interact with agent terminals from your phone. The Electron app starts an opt-in web server that serves a lightweight mobile SPA over WebSocket + HTTP. Connectivity via Tailscale.

## Requirements

- **Read + light interaction:** See terminal output, send simple commands, approve prompts, kill agents
- **Browser-based:** No native app — phone opens a URL
- **Tailscale networking:** Private mesh VPN, no public exposure
- **Opt-in:** Disabled by default, activated via "Connect Phone" button
- **List view + tap-to-expand:** Agent cards on home screen, fullscreen terminal detail on tap

## Architecture

```
┌─────────────────────────────────────┐
│         ELECTRON MAIN PROCESS       │
│                                     │
│  ┌─────────┐     ┌──────────────┐  │
│  │ PTY Pool │◄───►│ Web Server   │  │
│  │ (pty.ts) │     │ (Express/ws) │  │
│  └────┬─────┘     └──────┬───────┘  │
│       │                  │           │
│       ▼                  ▼           │
│  Electron IPC      WebSocket + HTTP  │
│  (desktop UI)      (mobile browser)  │
└─────────────────────────────────────┘
         │                  │
         ▼                  ▼
   Desktop window     Phone browser
   (existing)         (new companion)
```

- PTY pool is shared — both desktop and phone see the same sessions
- No changes to existing desktop IPC flow
- Web server is a parallel consumer of the PTY pool

## Web Server & API

### Server

- Lightweight HTTP + WebSocket server in Electron main process
- Binds to `0.0.0.0` on configurable port (default `7777`)
- Only starts when user clicks "Connect Phone"

### Auth

- On activation, generate a random token
- Display QR code encoding `http://<tailscale-ip>:7777?token=<token>`
- Token stored in phone's localStorage after first visit
- All requests validated via Bearer token or query param

### REST API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth` | POST | Validate token, return session cookie |
| `/api/agents` | GET | List all agents: status, task name, last output snippet |
| `/api/agents/:id` | GET | Single agent detail + recent output buffer |

### WebSocket Protocol

`ws://host:7777/ws?token=xxx`

```
// Server → Phone
{ "type": "output", "agentId": "abc", "data": "<base64>" }
{ "type": "status", "agentId": "abc", "status": "running" | "exited", "exitCode": 0 }
{ "type": "agents", "list": [...] }  // on connect + when agents change

// Phone → Server
{ "type": "input", "agentId": "abc", "data": "yes\n" }
{ "type": "resize", "agentId": "abc", "cols": 80, "rows": 24 }
{ "type": "kill", "agentId": "abc" }
```

### Output History

Server keeps a scrollback ring buffer (~64KB per agent) so the phone gets recent output immediately on connect.

## PTY Pool Integration

### Subscriber Pattern

Add output listeners to each PTY session alongside existing Electron IPC channel:

```typescript
interface PtySession {
  proc: IPty;
  channelId: string;              // existing desktop channel
  subscribers: Set<(data: string) => void>;  // new: web clients
  scrollback: RingBuffer;         // new: ~64KB history
  // ... existing fields
}
```

### Output Flow

```
PTY onData
  → batch buffer (existing)
  → flush:
      1. Electron IPC send (existing, unchanged)
      2. scrollback.write(data)
      3. subscribers.forEach(fn => fn(data))
```

### Input

Phone input calls existing `writeToAgent()` — no new code path.

### Lifecycle Events

Agent spawn/exit emits to WebSocket clients via event bus so phone list stays current.

### What Doesn't Change

- Desktop IPC flow
- Desktop backpressure
- PTY spawn/kill logic

## Mobile UI

SolidJS SPA served as static files from the web server.

### Agent List View (home screen)

```
┌─────────────────────────────┐
│  Parallel Code        ● 3/5 │  connected indicator, running/total
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ ● refactor-auth  running│ │  green dot = running
│ │ > Installing deps...    │ │  last line of output
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ ● add-tests     running │ │
│ │ > ✓ 14 tests passed     │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ ○ fix-css        exited │ │  grey dot = exited
│ │ > Exit code 0           │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

### Agent Detail View (tap to expand)

```
┌─────────────────────────────┐
│ ← Back     refactor-auth    │
├─────────────────────────────┤
│                             │
│  Terminal output area       │
│  (scrollable, xterm.js)     │
│  ANSI colors rendered       │
│                             │
├─────────────────────────────┤
│ [  Type command here...  ] ⏎│  input field + send button
│                             │
│ [y/n] [Enter] [Ctrl+C] [⌃D]│  quick-action buttons
└─────────────────────────────┘
```

### UI Features

- **Quick-action buttons** for common interactions (approve/deny, interrupt)
- **xterm.js** in detail view — same library as desktop, ANSI rendering in mobile browsers
- **Auto-scroll** with "scroll to bottom" FAB when reviewing history
- **Pull-to-refresh** on list view as fallback (WebSocket keeps it live)

## Feature Toggle & Connect Phone Flow

### Default State

Web server does not start. No port listening, zero overhead.

### Activation

1. User clicks **"Connect Phone"** button in sidebar (below "New Task")
2. Electron starts web server on port `7777`
3. Modal/popover shows:
   - QR code: `http://<tailscale-ip>:7777?token=<generated-token>`
   - Copyable URL text
   - "Disconnect" button
4. User scans QR on phone → browser opens → auto-authenticates via URL token
5. Sidebar button changes to **"Phone Connected"** with green indicator

### Deactivation

- Click "Disconnect" in modal, or click "Phone Connected" button
- Stops web server, drops WebSocket connections
- Button reverts to "Connect Phone"

### No Persistence

Server shuts down on disconnect or app quit. Fresh token each session. Nothing saved to disk.

### Store State

```typescript
remoteAccess: {
  enabled: boolean;
  token: string | null;
  port: number;
  connectedClients: number;
}
```

`connectedClients` count shown on button indicator.

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `electron/remote/server.ts` | HTTP + WebSocket server, auth middleware |
| `electron/remote/ring-buffer.ts` | Scrollback ring buffer for output history |
| `electron/remote/protocol.ts` | WebSocket message types and validation |
| `src/remote/` | Mobile SPA source (SolidJS) |
| `src/remote/App.tsx` | Mobile app root, routing (list ↔ detail) |
| `src/remote/AgentList.tsx` | Agent cards list view |
| `src/remote/AgentDetail.tsx` | Terminal detail view with xterm.js + input |
| `src/remote/auth.ts` | Token handling, localStorage |

### Modified Files

| File | Change |
|------|--------|
| `electron/ipc/pty.ts` | Add subscribers Set, scrollback RingBuffer, emit to subscribers on flush |
| `electron/main.ts` | Import remote server, start/stop on IPC command |
| `electron/ipc/register.ts` | Register start/stop remote server IPC handlers |
| `electron/preload.cjs` | Add remote server IPC channels to allowlist |
| `src/store/types.ts` | Add `remoteAccess` to AppStore |
| `src/store/core.ts` | Initialize remoteAccess state |
| `src/components/Sidebar.tsx` | Add "Connect Phone" button |
| `src/components/ConnectPhoneModal.tsx` | QR code + URL display modal (new component) |
| `vite.config.ts` | Add build entry for mobile SPA |
| `package.json` | Add dependencies: `ws`, `qrcode` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `ws` | WebSocket server (lightweight, no Express needed for WS) |
| `qrcode` | Generate QR code for the connection URL |

Note: HTTP serving uses Node.js built-in `http` module — no Express needed for the few REST endpoints.
