import { onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { PtyOutput } from "../ipc/types";

interface TerminalViewProps {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onExit?: (code: number | null) => void;
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;

  onMount(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef);

    // Try WebGL, fall back silently
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not supported, canvas renderer is fine
    }

    fitAddon.fit();

    const onOutput = new Channel<PtyOutput>();
    onOutput.onmessage = (msg) => {
      if (msg.type === "Data") {
        term.write(new Uint8Array(msg.data));
      } else if (msg.type === "Exit") {
        term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        props.onExit?.(msg.data);
      }
    };

    // Send keystrokes to PTY
    term.onData((data) => {
      invoke("write_to_agent", { agentId: props.agentId, data });
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      invoke("resize_agent", { agentId: props.agentId, cols, rows });
    });

    // Observe container size changes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef);

    // Spawn the PTY process
    invoke("spawn_agent", {
      taskId: "default",
      agentId: props.agentId,
      command: props.command,
      args: props.args,
      cwd: props.cwd,
      env: props.env ?? {},
      cols: term.cols,
      rows: term.rows,
      onOutput,
    }).catch((err) => {
      term.write(`\x1b[31mFailed to spawn: ${err}\x1b[0m\r\n`);
    });

    onCleanup(() => {
      resizeObserver.disconnect();
      invoke("kill_agent", { agentId: props.agentId });
      term.dispose();
    });
  });

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    />
  );
}
