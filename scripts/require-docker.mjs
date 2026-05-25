import { spawnSync } from 'node:child_process';

const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
  stdio: 'pipe',
  timeout: 5_000,
});

if (result.error) {
  console.error(`Docker is required but unavailable: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  const message = result.stderr.trim() || result.stdout.trim() || 'Docker daemon is unavailable';
  console.error(`Docker is required but unavailable: ${message}`);
  process.exit(result.status ?? 1);
}
