# Parallel Code

A desktop app for running multiple AI coding agents side by side, each in their own isolated git worktree.

<!-- TODO: Add screenshot or demo GIF here -->
<!-- ![Parallel Code screenshot](docs/screenshot.png) -->

---

Parallel Code lets you dispatch tasks to AI coding agents — Claude Code, Codex CLI, or Gemini CLI — and watch them work simultaneously. Each task gets its own git branch and worktree, so agents never step on each other's code. When a task is done, merge it back to main with one click.

## Features

- Run Claude Code, Codex CLI, and Gemini CLI in parallel
- Each task gets an isolated git branch and worktree — no conflicts
- Tiled panel layout with drag-to-reorder
- Built-in diff viewer and changed files list per task
- Merge to main or push to remote from the UI
- Shell terminals per task, scoped to the worktree
- Direct mode for working on the main branch without isolation
- Six themes — Minimal, Graphite, Classic, Indigo, Ember, Glacier
- Keyboard-driven — navigate everything without touching the mouse
- State persists across restarts
- Cross-platform (macOS, Linux)

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- At least one AI coding CLI installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

### Install & Run

```sh
git clone https://github.com/your-username/parallel-code.git
cd parallel-code
npm install
npm run tauri:dev
```

## How It Works

When you create a task, Parallel Code:

1. Creates a new git branch from your main branch
2. Sets up a [git worktree](https://git-scm.com/docs/git-worktree) so the agent works in a separate directory
3. Symlinks `node_modules` and other gitignored directories into the worktree
4. Spawns the AI agent in that worktree

This means you can have five agents working on five different features at the same time, all from the same repo, with zero conflicts. When you're happy with the result, merge the branch back to main from the sidebar.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New task |
| `Ctrl+Enter` | Send prompt |
| `Alt+Arrows` | Navigate panels |
| `Ctrl+Shift+M` | Merge task to main |
| `Ctrl+Shift+P` | Push to remote |
| `Ctrl+Shift+T` | New shell terminal |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+/` | All shortcuts |

## Built With

[Tauri v2](https://v2.tauri.app/) · [SolidJS](https://www.solidjs.com/) · [Rust](https://www.rust-lang.org/) · [xterm.js](https://xtermjs.org/)

## License

MIT
