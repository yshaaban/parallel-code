import { onMount, onCleanup, createEffect } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { theme } from "../lib/theme";
import type { PtyOutput } from "../ipc/types";

interface TerminalViewProps {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onExit?: (code: number | null) => void;
  onData?: () => void;
  onPromptDetected?: (text: string) => void;
  fontSize?: number;
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: theme.terminal,
      allowProposedApi: true,
      scrollback: 5000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef);

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      const isMac = navigator.userAgent.includes("Mac");
      const isCopy = isMac
        ? e.metaKey && !e.shiftKey && e.key === "c"
        : e.ctrlKey && e.shiftKey && e.key === "C";
      const isPaste = isMac
        ? e.metaKey && !e.shiftKey && e.key === "v"
        : e.ctrlKey && e.shiftKey && e.key === "V";

      if (isCopy) {
        const sel = term!.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }

      if (isPaste) {
        navigator.clipboard.readText().then((text) => {
          if (text) invoke("write_to_agent", { agentId, data: text });
        });
        return false;
      }

      return true;
    });

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL2 not supported — DOM renderer used automatically
    }

    fitAddon.fit();

    const onOutput = new Channel<PtyOutput>();
    onOutput.onmessage = (msg) => {
      if (msg.type === "Data") {
        term!.write(new Uint8Array(msg.data));
        props.onData?.();
      } else if (msg.type === "Exit") {
        term!.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        props.onExit?.(msg.data);
      }
    };

    let inputBuffer = "";

    term.onData((data) => {
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === "\r") {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected!(trimmed);
            inputBuffer = "";
          } else if (ch === "\x7f") {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === "\x03" || ch === "\x15") {
            inputBuffer = "";
          } else if (ch === "\x1b") {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= " ") {
            inputBuffer += ch;
          }
        }
      }
      invoke("write_to_agent", { agentId, data });
    });

    term.onResize(({ cols, rows }) => {
      invoke("resize_agent", { agentId, cols, rows });
    });

    let resizeRAF: number | undefined;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRAF !== undefined) cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => {
        fitAddon!.fit();
        resizeRAF = undefined;
      });
    });
    resizeObserver.observe(containerRef);

    // Re-render when the terminal scrolls back into view (e.g. horizontal overflow)
    const intersectionObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        requestAnimationFrame(() => fitAddon!.fit());
      }
    });
    intersectionObserver.observe(containerRef);

    invoke("spawn_agent", {
      taskId: "default",
      agentId,
      command: props.command,
      args: props.args,
      cwd: props.cwd,
      env: props.env ?? {},
      cols: term.cols,
      rows: term.rows,
      onOutput,
    }).catch((err) => {
      term!.write(`\x1b[31mFailed to spawn: ${err}\x1b[0m\r\n`);
    });

    onCleanup(() => {
      if (resizeRAF !== undefined) cancelAnimationFrame(resizeRAF);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      invoke("kill_agent", { agentId });
      term!.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size == null || !term || !fitAddon) return;
    term.options.fontSize = size;
    fitAddon.fit();
  });

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", padding: "4px 0 0 4px" }}
    />
  );
}
