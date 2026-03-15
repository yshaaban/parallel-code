# Parallel Code

Electron desktop app + standalone Node.js server — SolidJS frontend, Node.js backend. Published for **macOS, Linux, and WSL2**.

## Stack

- **Frontend:** SolidJS, TypeScript (strict), Vite
- **Backend:** Node.js (Electron or standalone Express server, node-pty)
- **Package manager:** npm
- **Tests:** Vitest (95 tests across 9 suites)

## Commands

- `npm run dev` — start Electron app in dev mode
- `npm run server` — build everything and start standalone server (port 3000)
- `npm run dev:server` — server dev mode with hot reload (concurrently builds frontend, remote app, server)
- `npm run build` — build production Electron app
- `npm run build:remote` — build remote mobile app to `dist-remote/`
- `npm run build:server` — compile server TypeScript to `dist-server/`
- `npm run typecheck` — run TypeScript type checking
- `npm test` — run test suite

## Project Structure

- `src/` — SolidJS frontend (components, store, IPC, lib)
- `src/lib/` — frontend utilities (IPC wrappers, window management, drag, zoom, WebGL pool, latency measurement)
- `src/remote/` — remote mobile app (SolidJS SPA, built separately to `dist-remote/`)
- `src/store/` — app state management
- `electron/` — Electron main process (IPC handlers, preload)
- `electron/ipc/` — backend IPC handlers (pty, git, tasks, persistence)
- `electron/remote/` — remote server protocol (ring buffer, message types, server)
- `server/` — standalone Express server for browser mode

## Dual-Mode Architecture

The app runs in two modes sharing the same frontend codebase:

1. **Electron mode** — native desktop app, IPC via Electron contextBridge
2. **Server mode** — Express + WebSocket server (`server/main.ts`), serves desktop UI at `/` and mobile UI at `/remote`; browser frontend uses HTTP/WebSocket IPC transport (`src/lib/ipc.ts`)

## Conventions

- Functional components only (SolidJS signals/stores, no classes)
- Electron IPC for all frontend-backend communication (browser mode uses HTTP/WebSocket equivalent)
- IPC channel names defined in `electron/ipc/channels.ts` (shared enum)
- `strict: true` TypeScript, no `any`
- Remote app uses inline styles with CSS custom properties defined in `src/remote/index.html`
- Tests colocated with source files (`.test.ts` suffix)

## Architecture Guardrails

Read these before moving code across layers or adding new runtime state:

- `docs/ARCHITECTURAL-PRINCIPLES.md`
- `docs/UPSTREAM-DIVERGENCE.md`
- `docs/ARCHITECTURE.md`
- `AGENTS.md`

In short:

- backend owns real external state
- renderer owns presentation and workflow orchestration
- transport is not business logic
- restore must use exact identity
- UI components should consume state, not invent durable truth

## Upstream Sync Rule

For non-trivial upstream ports, follow `AGENTS.md` and keep `docs/UPSTREAM-DIVERGENCE.md` current.

Do not port upstream work by file shape when this repo's ownership model differs.
