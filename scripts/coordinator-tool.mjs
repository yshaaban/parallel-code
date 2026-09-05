#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import https from 'node:https';
import { URL } from 'node:url';

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
    typeof parsed.toolCallUrl !== 'string' ||
    (parsed.toolCallTlsCertificate !== undefined &&
      typeof parsed.toolCallTlsCertificate !== 'string')
  ) {
    throw new Error('Coordinator credential file is invalid or missing toolCallUrl');
  }

  return parsed;
}

function postJsonWithTlsCertificate(urlValue, certificate, body) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:') {
    throw new Error('Coordinator TLS certificate may only be used with an HTTPS tool-call URL');
  }

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        ca: certificate,
        // The URL is deliberately loopback while the configured certificate
        // commonly names the externally reachable host. Trust is anchored to
        // that exact configured certificate instead of the loopback hostname.
        checkServerIdentity: () => undefined,
        headers: {
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      (response) => {
        const chunks = [];
        let byteLength = 0;
        response.on('data', (chunk) => {
          byteLength += chunk.length;
          if (byteLength > 1024 * 1024) {
            request.destroy(new Error('Coordinator tool response exceeded 1 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // The caller reports the HTTP status when the body is not JSON.
          }
          resolve({ body: parsed, status: response.statusCode ?? 0 });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
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

  let responseStatus;
  let responseBody;
  try {
    const requestBody = JSON.stringify(envelope);
    if (credential.toolCallTlsCertificate) {
      const response = await postJsonWithTlsCertificate(
        credential.toolCallUrl,
        credential.toolCallTlsCertificate,
        requestBody,
      );
      responseStatus = response.status;
      responseBody = response.body;
    } else {
      const response = await fetch(credential.toolCallUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      responseStatus = response.status;
      responseBody = await response.json().catch(() => null);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Coordinator tool fetch failed for ${credential.toolCallUrl}: ${message}`);
  }
  if (responseStatus < 200 || responseStatus >= 300) {
    throw new Error(
      responseBody?.error ?? `Coordinator tool call failed with HTTP ${responseStatus}`,
    );
  }

  process.stdout.write(`${JSON.stringify(responseBody?.result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
