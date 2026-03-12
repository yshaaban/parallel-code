import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { startBrowserServer } from './browser-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const distRemoteDir = path.resolve(__dirname, '..', '..', 'dist-remote');
const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const token = process.env.AUTH_TOKEN || randomBytes(24).toString('base64url');
const userDataPath =
  process.env.PARALLEL_CODE_USER_DATA_DIR ?? path.resolve(__dirname, '..', '..', '.server-data');

startBrowserServer({
  distDir,
  distRemoteDir,
  port,
  simulateJitterMs: Number(process.env.SIMULATE_JITTER_MS) || 0,
  simulateLatencyMs: Number(process.env.SIMULATE_LATENCY_MS) || 0,
  simulatePacketLoss: Number(process.env.SIMULATE_PACKET_LOSS) || 0,
  token,
  userDataPath,
});
