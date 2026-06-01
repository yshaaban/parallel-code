#!/usr/bin/env node
import fs from 'node:fs';

function printUsage() {
  console.error(
    [
      'Usage: coordinator-tool <tool-name> [payload-json]',
      '',
      'Requires PARALLEL_CODE_COORDINATOR_CREDENTIAL to point at a coordinator credential file.',
    ].join('\n'),
  );
}

function readCredential() {
  const credentialPath = process.env.PARALLEL_CODE_COORDINATOR_CREDENTIAL;
  if (!credentialPath) {
    throw new Error('PARALLEL_CODE_COORDINATOR_CREDENTIAL is not set');
  }

  const parsed = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.runId !== 'string' ||
    typeof parsed.taskId !== 'string' ||
    typeof parsed.token !== 'string' ||
    typeof parsed.toolCallUrl !== 'string'
  ) {
    throw new Error('Coordinator credential file is invalid or missing toolCallUrl');
  }

  return parsed;
}

function readPayload(rawPayload) {
  if (rawPayload === undefined) {
    return undefined;
  }

  const parsed = JSON.parse(rawPayload);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload-json must be a JSON object');
  }

  return parsed;
}

function createCallId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function main() {
  const [, , toolName, rawPayload] = process.argv;
  if (!toolName) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const credential = readCredential();
  const envelope = {
    callId: createCallId(),
    runId: credential.runId,
    taskId: credential.taskId,
    token: credential.token,
    toolName,
    ...(rawPayload !== undefined ? { payload: readPayload(rawPayload) } : {}),
  };

  const response = await fetch(credential.toolCallUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `Coordinator tool call failed with HTTP ${response.status}`);
  }

  process.stdout.write(`${JSON.stringify(body.result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
