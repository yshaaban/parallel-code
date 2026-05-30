import type express from 'express';

const LATENCY_LAB_PATH = '/latency';
const LATENCY_PING_PATH = '/api/diagnostics/latency-ping';
const CACHE_CONTROL_NO_STORE = 'no-store, max-age=0';
const DEFAULT_PAYLOAD_BYTES = 0;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface RegisterBrowserLatencyDiagnosticsRoutesOptions {
  app: express.Express;
  authGatePath: string;
  isAuthorizedRequest: (req: express.Request) => boolean;
}

function parseBoundedInteger(
  value: unknown,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  if (typeof value !== 'string') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.min(maxValue, Math.max(minValue, parsed));
}

function getRequestPath(req: express.Request, fallbackPath: string): string {
  const path = req.originalUrl || req.url || fallbackPath;
  return path.startsWith('/') && !path.startsWith('//') ? path : fallbackPath;
}

function redirectToAuthGate(
  req: express.Request,
  res: express.Response,
  authGatePath: string,
): void {
  const nextPath = encodeURIComponent(getRequestPath(req, LATENCY_LAB_PATH));
  res.redirect(`${authGatePath}?next=${nextPath}`);
}

function sendNoStoreJson(res: express.Response, body: unknown): void {
  res.setHeader('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.json(body);
}

function createLatencyLabHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Parallel Code Latency Lab</title>
    <meta http-equiv="Cache-Control" content="no-store" />
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #111318;
        color: #eef0f4;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #111318;
      }
      main {
        box-sizing: border-box;
        width: min(1120px, 100%);
        margin: 0 auto;
        padding: 28px;
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        letter-spacing: 0;
      }
      .subtitle {
        margin: 8px 0 0;
        color: #abb1bd;
        font-size: 13px;
        line-height: 1.5;
      }
      .controls,
      .grid,
      .log {
        border: 1px solid #2a2f3a;
        border-radius: 8px;
        background: #171a21;
      }
      .controls {
        display: grid;
        grid-template-columns: repeat(4, minmax(120px, 1fr)) auto auto;
        gap: 10px;
        padding: 14px;
        margin-bottom: 14px;
      }
      label {
        display: grid;
        gap: 5px;
        color: #aeb5c2;
        font-size: 11px;
        text-transform: uppercase;
      }
      input {
        height: 34px;
        box-sizing: border-box;
        border: 1px solid #343a46;
        border-radius: 6px;
        padding: 7px 9px;
        background: #10131a;
        color: #eef0f4;
        font: inherit;
        font-size: 13px;
      }
      button {
        align-self: end;
        height: 34px;
        border: 1px solid #3b4352;
        border-radius: 6px;
        padding: 0 13px;
        background: #232936;
        color: #eef0f4;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      button.primary {
        border-color: #4d7cff;
        background: #315fd8;
      }
      button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0;
        overflow: hidden;
      }
      .card {
        min-width: 0;
        padding: 16px;
        border-right: 1px solid #2a2f3a;
      }
      .card:last-child {
        border-right: 0;
      }
      .name {
        color: #aeb5c2;
        font-size: 12px;
        text-transform: uppercase;
      }
      .metric {
        margin-top: 8px;
        font-size: 26px;
        font-weight: 650;
        font-variant-numeric: tabular-nums;
      }
      .details {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 7px 12px;
        margin-top: 14px;
        color: #c9ced8;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .status {
        min-height: 18px;
        margin: 12px 0;
        color: #aeb5c2;
        font-size: 13px;
      }
      .log {
        height: 220px;
        overflow: auto;
        padding: 12px;
        color: #d6d9df;
        font: 12px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
      }
      .build {
        color: #aeb5c2;
        font: 12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        text-align: right;
      }
      @media (max-width: 800px) {
        main {
          padding: 18px;
        }
        header,
        .controls {
          display: grid;
          grid-template-columns: 1fr;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        .card {
          border-right: 0;
          border-bottom: 1px solid #2a2f3a;
        }
        .card:last-child {
          border-bottom: 0;
        }
        .build {
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Parallel Code Latency Lab</h1>
          <p class="subtitle">Measures same-origin HTTP ping, real browser IPC, and websocket ping/pong from this browser to the current server.</p>
        </div>
        <div class="build" id="build">Loading build metadata...</div>
      </header>

      <section class="controls" aria-label="Benchmark controls">
        <label>
          Samples
          <input id="samples" type="number" min="1" max="1000" step="1" value="80" />
        </label>
        <label>
          Interval ms
          <input id="interval" type="number" min="0" max="5000" step="10" value="250" />
        </label>
        <label>
          Payload bytes
          <input id="payload" type="number" min="0" max="65536" step="128" value="0" />
        </label>
        <label>
          URL
          <input id="shareUrl" readonly />
        </label>
        <button id="start" class="primary" type="button">Start</button>
        <button id="stop" type="button" disabled>Stop</button>
      </section>

      <div class="status" id="status">Idle.</div>

      <section class="grid" aria-label="Latency results">
        <article class="card">
          <div class="name">HTTP ping endpoint</div>
          <div class="metric" id="httpMetric">n/a</div>
          <div class="details" id="httpDetails"></div>
        </article>
        <article class="card">
          <div class="name">HTTP IPC diagnostics</div>
          <div class="metric" id="ipcMetric">n/a</div>
          <div class="details" id="ipcDetails"></div>
        </article>
        <article class="card">
          <div class="name">WebSocket ping/pong</div>
          <div class="metric" id="wsMetric">n/a</div>
          <div class="details" id="wsDetails"></div>
        </article>
      </section>

      <pre class="log" id="log" aria-label="Sample log"></pre>
    </main>

    <script>
      const params = new URLSearchParams(window.location.search);
      const controls = {
        samples: document.getElementById('samples'),
        interval: document.getElementById('interval'),
        payload: document.getElementById('payload'),
        shareUrl: document.getElementById('shareUrl'),
        start: document.getElementById('start'),
        stop: document.getElementById('stop'),
        status: document.getElementById('status'),
        log: document.getElementById('log'),
        build: document.getElementById('build'),
      };
      const panels = {
        http: {
          metric: document.getElementById('httpMetric'),
          details: document.getElementById('httpDetails'),
        },
        ipc: {
          metric: document.getElementById('ipcMetric'),
          details: document.getElementById('ipcDetails'),
        },
        ws: {
          metric: document.getElementById('wsMetric'),
          details: document.getElementById('wsDetails'),
        },
      };
      const state = {
        running: false,
        samples: {
          http: [],
          ipc: [],
          ws: [],
        },
      };

      function readNumber(control, fallback, min, max) {
        const value = Number.parseInt(control.value, 10);
        if (!Number.isFinite(value)) {
          return fallback;
        }
        return Math.min(max, Math.max(min, value));
      }

      function formatMs(value) {
        if (!Number.isFinite(value)) {
          return 'n/a';
        }
        return value.toFixed(1) + ' ms';
      }

      function summarize(values) {
        if (values.length === 0) {
          return null;
        }
        const sorted = values.slice().sort((left, right) => left - right);
        function pick(fraction) {
          return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
        }
        return {
          count: sorted.length,
          min: sorted[0],
          p50: pick(0.5),
          p95: pick(0.95),
          max: sorted[sorted.length - 1],
        };
      }

      function renderPanel(key) {
        const summary = summarize(state.samples[key]);
        const panel = panels[key];
        if (!summary) {
          panel.metric.textContent = 'n/a';
          panel.details.textContent = '';
          return;
        }
        panel.metric.textContent = formatMs(summary.p50);
        panel.details.innerHTML =
          '<div>count</div><div>' + summary.count + '</div>' +
          '<div>min</div><div>' + formatMs(summary.min) + '</div>' +
          '<div>p95</div><div>' + formatMs(summary.p95) + '</div>' +
          '<div>max</div><div>' + formatMs(summary.max) + '</div>';
      }

      function log(message) {
        const timestamp = new Date().toISOString().slice(11, 23);
        controls.log.textContent += '[' + timestamp + '] ' + message + '\\n';
        controls.log.scrollTop = controls.log.scrollHeight;
      }

      function updateShareUrl() {
        const url = new URL(window.location.href);
        url.searchParams.set('samples', controls.samples.value);
        url.searchParams.set('interval', controls.interval.value);
        url.searchParams.set('bytes', controls.payload.value);
        url.searchParams.set('autorun', '1');
        url.searchParams.delete('token');
        controls.shareUrl.value = url.toString();
      }

      async function timedFetch(path, options) {
        const startedAt = performance.now();
        const response = await fetch(path, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...options,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || 'request failed with ' + response.status);
        }
        return {
          elapsedMs: performance.now() - startedAt,
          payload,
        };
      }

      async function sampleHttpPing(index, payloadBytes) {
        const path =
          '/api/diagnostics/latency-ping?sample=' +
          index +
          '&bytes=' +
          payloadBytes +
          '&cacheBust=' +
          Date.now();
        const result = await timedFetch(path);
        state.samples.http.push(result.elapsedMs);
        renderPanel('http');
        return result.elapsedMs;
      }

      async function sampleHttpIpc() {
        const result = await timedFetch('/api/ipc/get_backend_runtime_diagnostics', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        state.samples.ipc.push(result.elapsedMs);
        renderPanel('ipc');
        return result.elapsedMs;
      }

      function createWebSocketProbe() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = new URL(protocol + '//' + window.location.host + '/ws');
        url.searchParams.set('clientId', 'latency-lab-' + Math.random().toString(36).slice(2));
        url.searchParams.set('lastSeq', '-1');
        const socket = new WebSocket(url.toString());
        const pending = [];
        socket.addEventListener('message', (event) => {
          let message;
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.type !== 'pong') {
            return;
          }
          const next = pending.shift();
          if (next) {
            next();
          }
        });
        return {
          waitForOpen() {
            return new Promise((resolve, reject) => {
              socket.addEventListener('open', resolve, { once: true });
              socket.addEventListener('error', () => reject(new Error('websocket failed to open')), {
                once: true,
              });
            });
          },
          ping() {
            const startedAt = performance.now();
            return new Promise((resolve, reject) => {
              let complete;
              const timeout = window.setTimeout(() => {
                const index = pending.indexOf(complete);
                if (index >= 0) {
                  pending.splice(index, 1);
                }
                reject(new Error('websocket pong timeout'));
              }, 5000);
              complete = () => {
                window.clearTimeout(timeout);
                const elapsedMs = performance.now() - startedAt;
                state.samples.ws.push(elapsedMs);
                renderPanel('ws');
                resolve(elapsedMs);
              };
              pending.push(complete);
              socket.send(JSON.stringify({ type: 'ping' }));
            });
          },
          close() {
            socket.close();
          },
        };
      }

      async function loadBuildMetadata() {
        try {
          const result = await timedFetch('/build-metadata.json?cacheBust=' + Date.now());
          const metadata = result.payload;
          const commit = metadata.buildCommit || 'unknown';
          const dirty = metadata.buildDirty ? ' dirty' : '';
          controls.build.textContent =
            'Build ' + (metadata.appVersion || 'dev') + ' / ' + commit + dirty + ' / ' + (metadata.buildStamp || 'unknown');
        } catch (error) {
          controls.build.textContent = 'Build metadata unavailable';
        }
      }

      async function runBenchmark() {
        if (state.running) {
          return;
        }
        state.running = true;
        controls.start.disabled = true;
        controls.stop.disabled = false;
        state.samples.http = [];
        state.samples.ipc = [];
        state.samples.ws = [];
        renderPanel('http');
        renderPanel('ipc');
        renderPanel('ws');
        controls.log.textContent = '';
        updateShareUrl();

        const sampleCount = readNumber(controls.samples, 80, 1, 1000);
        const intervalMs = readNumber(controls.interval, 250, 0, 5000);
        const payloadBytes = readNumber(controls.payload, 0, 0, 65536);
        const websocket = createWebSocketProbe();
        controls.status.textContent = 'Opening websocket...';
        try {
          await websocket.waitForOpen();
          log('websocket connected');
          for (let index = 0; index < sampleCount && state.running; index += 1) {
            controls.status.textContent = 'Running sample ' + (index + 1) + ' of ' + sampleCount + '...';
            const httpMs = await sampleHttpPing(index, payloadBytes);
            const ipcMs = await sampleHttpIpc();
            const wsMs = await websocket.ping();
            log(
              'sample=' +
                (index + 1) +
                ' http=' +
                formatMs(httpMs) +
                ' ipc=' +
                formatMs(ipcMs) +
                ' ws=' +
                formatMs(wsMs),
            );
            if (intervalMs > 0 && index + 1 < sampleCount) {
              await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
            }
          }
          controls.status.textContent = state.running ? 'Complete.' : 'Stopped.';
        } catch (error) {
          controls.status.textContent = error instanceof Error ? error.message : String(error);
          log('error: ' + controls.status.textContent);
        } finally {
          websocket.close();
          state.running = false;
          controls.start.disabled = false;
          controls.stop.disabled = true;
        }
      }

      controls.start.addEventListener('click', () => {
        void runBenchmark();
      });
      controls.stop.addEventListener('click', () => {
        state.running = false;
      });
      for (const control of [controls.samples, controls.interval, controls.payload]) {
        control.addEventListener('input', updateShareUrl);
      }

      controls.samples.value = params.get('samples') || controls.samples.value;
      controls.interval.value = params.get('interval') || controls.interval.value;
      controls.payload.value = params.get('bytes') || controls.payload.value;
      updateShareUrl();
      void loadBuildMetadata();
      if (params.get('autorun') === '1') {
        window.setTimeout(() => {
          void runBenchmark();
        }, 250);
      }
    </script>
  </body>
</html>`;
}

export function registerBrowserLatencyDiagnosticsRoutes(
  options: RegisterBrowserLatencyDiagnosticsRoutesOptions,
): void {
  options.app.get(LATENCY_PING_PATH, (req, res) => {
    if (!options.isAuthorizedRequest(req)) {
      sendNoStoreJson(res.status(401), { error: 'unauthorized' });
      return;
    }

    const serverReceivedAtMs = Date.now();
    const payloadBytes = parseBoundedInteger(
      typeof req.query.bytes === 'string' ? req.query.bytes : undefined,
      DEFAULT_PAYLOAD_BYTES,
      0,
      MAX_PAYLOAD_BYTES,
    );
    const payload = payloadBytes > 0 ? 'x'.repeat(payloadBytes) : '';
    sendNoStoreJson(res, {
      kind: 'latency-pong',
      nonce: typeof req.query.nonce === 'string' ? req.query.nonce : null,
      payload,
      payloadBytes,
      serverReceivedAtMs,
      serverSentAtMs: Date.now(),
    });
  });

  options.app.get(LATENCY_LAB_PATH, (req, res) => {
    if (!options.isAuthorizedRequest(req)) {
      redirectToAuthGate(req, res, options.authGatePath);
      return;
    }

    res
      .status(200)
      .setHeader('Cache-Control', CACHE_CONTROL_NO_STORE)
      .type('html')
      .send(createLatencyLabHtml());
  });
}
