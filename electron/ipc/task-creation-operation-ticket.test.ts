import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  TASK_CREATION_TICKET_TTL_MS,
  createTaskCreationAuthEpoch,
  isTaskCreationOperationCapability,
  type TaskCreationOperationId,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import {
  TaskCreationTicketIssuerCapacityError,
  TaskCreationTicketRateLimitError,
  createTaskCreationAuthenticationSessionGeneration,
  createTaskCreationOperationTicketIssuer,
} from './task-creation-operation-ticket.js';

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function context(
  overrides: Partial<TaskCreationTicketAuthenticationContext> = {},
): TaskCreationTicketAuthenticationContext {
  return {
    authEpoch: createTaskCreationAuthEpoch(7),
    authenticationSessionGeneration: bytes(16, 0x33),
    workspacePrincipalId: 'workspace:user-1',
    ...overrides,
  };
}

function decodeFields(ticket: string): Uint8Array[] {
  const [payloadSegment] = ticket.split('.');
  const payload = Buffer.from(payloadSegment ?? '', 'base64url');
  const fields: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    const byteLength = payload.readUInt32BE(offset);
    offset += 4;
    fields.push(Uint8Array.from(payload.subarray(offset, offset + byteLength)));
    offset += byteLength;
  }
  return fields;
}

function asUtf8(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}

describe('task-creation operation ticket issuer', () => {
  it('generates the operation ID and MAC-binds the exact nine length-prefixed fields', async () => {
    const now = 1_725_000_000_000;
    const randomValues = [bytes(16, 0x11), bytes(32, 0x22)];
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 0x44),
      now: () => now,
      randomBytes: (length) => {
        const next = randomValues.shift();
        if (!next || next.byteLength !== length) throw new Error('Unexpected random request');
        return next;
      },
      secret: bytes(32, 0x55),
    });

    const issued = await issuer.issue(context());
    const fields = decodeFields(issued.operationTicket);

    expect(issued.operationId).toBe(Buffer.from(bytes(16, 0x11)).toString('base64url'));
    expect(issued.operationId).toHaveLength(22);
    expect(issued.expiresAt - issued.issuedAt).toBe(TASK_CREATION_TICKET_TTL_MS);
    expect(issued.operationTicket.split('.')).toHaveLength(2);
    expect(fields).toHaveLength(9);
    expect(fields.slice(0, 7).map(asUtf8)).toEqual([
      '1',
      'task-creation-ticket',
      'workspace:user-1',
      issued.operationId,
      String(now),
      String(now + TASK_CREATION_TICKET_TTL_MS),
      '7',
    ]);
    expect(fields[7]).toEqual(bytes(16, 0x33));
    expect(fields[8]).toEqual(bytes(32, 0x44));
    expect(
      issuer.verify({
        authentication: context(),
        operationId: issued.operationId,
        operationTicket: issued.operationTicket,
      }),
    ).toMatchObject({ kind: 'valid' });
  });

  it('preserves tickets only for the exact authentication session generation and auth epoch', async () => {
    let now = 1_000;
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      now: () => now,
      randomBytes: () => bytes(16, 2),
      secret: bytes(32, 3),
    });
    const authentication = context();
    const issued = await issuer.issue(authentication);
    const verify = (current: TaskCreationTicketAuthenticationContext) =>
      issuer.verify({
        authentication: current,
        operationId: issued.operationId,
        operationTicket: issued.operationTicket,
      });

    // Routine cookie/CSRF rotation does not alter this owner-provided context.
    expect(verify({ ...authentication })).toMatchObject({ kind: 'valid' });
    expect(verify({ ...authentication, authenticationSessionGeneration: bytes(16, 4) })).toEqual({
      kind: 'invalid',
    });
    expect(verify({ ...authentication, authEpoch: createTaskCreationAuthEpoch(8) })).toEqual({
      kind: 'invalid',
    });
    expect(verify({ ...authentication, workspacePrincipalId: 'workspace:user-2' })).toEqual({
      kind: 'invalid',
    });

    now = issued.expiresAt;
    expect(verify(authentication)).toEqual({ kind: 'expired' });
  });

  it('fails closed on an invalid clock and rejects imprecise numeric auth epochs', async () => {
    let now = 1_000;
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      now: () => now,
      randomBytes: () => bytes(16, 2),
      secret: bytes(32, 3),
    });
    const issued = await issuer.issue(context());
    now = Number.NaN;

    expect(
      issuer.verify({
        authentication: context(),
        operationId: issued.operationId,
        operationTicket: issued.operationTicket,
      }),
    ).toEqual({ kind: 'invalid' });
    expect(() => createTaskCreationAuthEpoch(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-negative safe integer/u,
    );
  });

  it('invalidates every unused ticket after issuer restart', async () => {
    const shared = {
      now: () => 5_000,
      randomBytes: () => bytes(16, 7),
      secret: bytes(32, 8),
    };
    const beforeRestart = createTaskCreationOperationTicketIssuer({
      ...shared,
      bootEpoch: bytes(32, 9),
    });
    const issued = await beforeRestart.issue(context());
    const afterRestart = createTaskCreationOperationTicketIssuer({
      ...shared,
      bootEpoch: bytes(32, 10),
    });

    expect(
      afterRestart.verify({
        authentication: context(),
        operationId: issued.operationId,
        operationTicket: issued.operationTicket,
      }),
    ).toEqual({ kind: 'invalid' });
  });

  it.each([
    (ticket: string) => `${ticket}=`,
    (ticket: string) => `.${ticket}`,
    (ticket: string) => `${ticket}.extra`,
    (ticket: string) => ticket.replace(/^[^.]/u, '*'),
    (ticket: string) => `${ticket}${'a'.repeat(1_025)}`,
  ])('rejects malformed or noncanonical ticket encoding', async (mutate) => {
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      now: () => 1_000,
      randomBytes: () => bytes(16, 2),
      secret: bytes(32, 3),
    });
    const issued = await issuer.issue(context());

    expect(
      issuer.verify({
        authentication: context(),
        operationId: issued.operationId,
        operationTicket: mutate(issued.operationTicket),
      }),
    ).toEqual({ kind: 'invalid' });
  });

  it('collision-checks issued and durable IDs and fails closed after four samples', async () => {
    const collisionCheck = vi.fn(async () => true);
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      isOperationIdInUse: collisionCheck,
      now: () => 1_000,
      randomBytes: () => bytes(16, 2),
      secret: bytes(32, 3),
    });

    await expect(issuer.issue(context())).rejects.toBeInstanceOf(
      TaskCreationTicketIssuerCapacityError,
    );
    expect(collisionCheck).toHaveBeenCalledTimes(4);
  });

  it('enforces issuance bursts before allocating another operation ID', async () => {
    let randomCalls = 0;
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      now: () => 1_000,
      randomBytes: (length) => {
        randomCalls += 1;
        return bytes(length, randomCalls);
      },
      secret: bytes(32, 3),
    });
    await Promise.all(Array.from({ length: 4 }, () => issuer.issue(context())));
    const callsBeforeRejection = randomCalls;

    await expect(issuer.issue(context())).rejects.toBeInstanceOf(TaskCreationTicketRateLimitError);
    expect(randomCalls).toBe(callsBeforeRejection);
  });

  it('signs a stable backend-owned operation id for trusted local replay', () => {
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      now: () => 1_000,
      randomBytes: () => {
        throw new Error('Trusted local signing must not allocate another operation ID');
      },
      secret: bytes(32, 3),
    });
    const operationId = Buffer.from(bytes(16, 9)).toString('base64url') as TaskCreationOperationId;

    const issued = issuer.issueTrustedLocal(context(), operationId);

    expect(issued.operationId).toBe(operationId);
    expect(
      issuer.verify({
        authentication: context(),
        operationId,
        operationTicket: issued.operationTicket,
      }),
    ).toMatchObject({ kind: 'valid' });
    expect(issuer.issueTrustedLocal(context(), operationId).operationId).toBe(operationId);
  });

  it('creates exact 256-bit capabilities and persists only their one-way hash', () => {
    const issuer = createTaskCreationOperationTicketIssuer({
      bootEpoch: bytes(32, 1),
      randomBytes: (length) => bytes(length, 0xab),
      secret: bytes(32, 3),
    });

    const capability = issuer.createOperationCapability();
    expect(isTaskCreationOperationCapability(capability)).toBe(true);
    expect(capability).toHaveLength(43);
    expect(issuer.hashOperationCapability(capability)).toBe(
      createHash('sha256').update(Buffer.from(capability, 'base64url')).digest('hex'),
    );
    expect(JSON.stringify(issuer)).not.toContain(capability);
    expect(Object.keys(issuer).sort()).toEqual([
      'createOperationCapability',
      'hashOperationCapability',
      'issue',
      'issueTrustedLocal',
      'verify',
    ]);
  });

  it('allocates exact authentication-session generations without persistence state', () => {
    expect(createTaskCreationAuthenticationSessionGeneration(() => bytes(16, 6))).toEqual(
      bytes(16, 6),
    );
    expect(() => createTaskCreationAuthenticationSessionGeneration(() => bytes(15, 6))).toThrow(
      'exactly 16 bytes',
    );
  });
});
