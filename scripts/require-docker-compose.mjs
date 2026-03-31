import { spawnSync } from 'child_process';

function checkDockerCommand(args, description) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 5_000,
  });

  if (result.error || result.status !== 0) {
    const reason =
      result.error?.message ??
      `exit code ${typeof result.status === 'number' ? result.status : 'unknown'}`;
    console.error(`Docker integration gate requires ${description}: ${reason}`);
    process.exit(1);
  }
}

checkDockerCommand(['version'], 'Docker');
checkDockerCommand(['compose', 'version'], 'Docker Compose');
