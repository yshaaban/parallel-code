import fs from 'fs';
import path from 'path';

import type { PendingTaskContentRootAdmission } from './terminal-root-authority.js';

export interface BoundedTaskTextFileRequest {
  admission: PendingTaskContentRootAdmission;
  allowedRoots: readonly string[];
  maxBytes: number;
  relativePath: string;
  acceptCanonicalPath?: (canonicalPath: string) => boolean;
}

export interface BoundedTaskTextFile {
  canonicalPath: string;
  content: string;
  relativePath: string;
}

interface StableFileIdentity {
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  type: bigint;
}

interface PreparedTaskFileRead {
  canonicalPath: string;
  canonicalRoot: string;
  canonicalAllowedRoots: string[];
  lexicalPath: string;
  normalizedRelativePath: string;
}

const FILE_TYPE_MASK = 0o170000n;
const READ_CHUNK_BYTES = 64 * 1024;

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function hasUsableIdentity(stats: fs.BigIntStats): boolean {
  return (
    stats.isFile() &&
    stats.dev !== 0n &&
    stats.ino !== 0n &&
    typeof stats.ctimeNs === 'bigint' &&
    typeof stats.birthtimeNs === 'bigint'
  );
}

function captureIdentity(stats: fs.BigIntStats): StableFileIdentity | null {
  if (!hasUsableIdentity(stats)) {
    return null;
  }
  return {
    birthtimeNs: stats.birthtimeNs,
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    type: stats.mode & FILE_TYPE_MASK,
  };
}

function identitiesMatch(identity: StableFileIdentity, stats: fs.BigIntStats): boolean {
  const candidate = captureIdentity(stats);
  return (
    candidate !== null &&
    candidate.birthtimeNs === identity.birthtimeNs &&
    candidate.ctimeNs === identity.ctimeNs &&
    candidate.dev === identity.dev &&
    candidate.ino === identity.ino &&
    candidate.type === identity.type
  );
}

function validateRequestShape(request: BoundedTaskTextFileRequest): string | null {
  if (
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes <= 0 ||
    request.relativePath.length === 0 ||
    request.relativePath.includes('\0') ||
    path.isAbsolute(request.relativePath) ||
    request.admission.root.includes('\0') ||
    !path.isAbsolute(request.admission.root) ||
    request.allowedRoots.length === 0
  ) {
    return null;
  }

  const lexicalRoot = path.resolve(request.admission.root);
  const lexicalPath = path.resolve(lexicalRoot, request.relativePath);
  return isStrictDescendant(lexicalRoot, lexicalPath) ? lexicalPath : null;
}

function prepareSync(request: BoundedTaskTextFileRequest): PreparedTaskFileRead | null {
  const lexicalPath = validateRequestShape(request);
  if (!lexicalPath) {
    return null;
  }

  const lexicalRoot = path.resolve(request.admission.root);
  const canonicalRoot = fs.realpathSync(lexicalRoot);
  const canonicalPath = fs.realpathSync(lexicalPath);
  if (!isStrictDescendant(canonicalRoot, canonicalPath)) {
    return null;
  }

  const canonicalAllowedRoots = request.allowedRoots.flatMap((allowedRoot) => {
    try {
      return [fs.realpathSync(path.resolve(allowedRoot))];
    } catch {
      return [];
    }
  });
  if (
    canonicalAllowedRoots.length === 0 ||
    !canonicalAllowedRoots.some((allowedRoot) => isStrictDescendant(allowedRoot, canonicalPath)) ||
    (request.acceptCanonicalPath && !request.acceptCanonicalPath(canonicalPath))
  ) {
    return null;
  }

  return {
    canonicalAllowedRoots,
    canonicalPath,
    canonicalRoot,
    lexicalPath,
    normalizedRelativePath: path.relative(lexicalRoot, lexicalPath),
  };
}

async function prepare(request: BoundedTaskTextFileRequest): Promise<PreparedTaskFileRead | null> {
  const lexicalPath = validateRequestShape(request);
  if (!lexicalPath) {
    return null;
  }

  const lexicalRoot = path.resolve(request.admission.root);
  const canonicalRoot = await fs.promises.realpath(lexicalRoot);
  const canonicalPath = await fs.promises.realpath(lexicalPath);
  if (!isStrictDescendant(canonicalRoot, canonicalPath)) {
    return null;
  }

  const canonicalAllowedRoots = (
    await Promise.all(
      request.allowedRoots.map(async (allowedRoot) => {
        try {
          return await fs.promises.realpath(path.resolve(allowedRoot));
        } catch {
          return null;
        }
      }),
    )
  ).filter((allowedRoot): allowedRoot is string => allowedRoot !== null);
  if (
    canonicalAllowedRoots.length === 0 ||
    !canonicalAllowedRoots.some((allowedRoot) => isStrictDescendant(allowedRoot, canonicalPath)) ||
    (request.acceptCanonicalPath && !request.acceptCanonicalPath(canonicalPath))
  ) {
    return null;
  }

  return {
    canonicalAllowedRoots,
    canonicalPath,
    canonicalRoot,
    lexicalPath,
    normalizedRelativePath: path.relative(lexicalRoot, lexicalPath),
  };
}

function verifyPostOpenPathSync(
  prepared: PreparedTaskFileRead,
  identity: StableFileIdentity,
): boolean {
  const postCanonicalPath = fs.realpathSync(prepared.lexicalPath);
  if (
    postCanonicalPath !== prepared.canonicalPath ||
    !isStrictDescendant(prepared.canonicalRoot, postCanonicalPath) ||
    !prepared.canonicalAllowedRoots.some((root) => isStrictDescendant(root, postCanonicalPath))
  ) {
    return false;
  }
  return identitiesMatch(identity, fs.statSync(postCanonicalPath, { bigint: true }));
}

async function verifyPostOpenPath(
  prepared: PreparedTaskFileRead,
  identity: StableFileIdentity,
): Promise<boolean> {
  const postCanonicalPath = await fs.promises.realpath(prepared.lexicalPath);
  if (
    postCanonicalPath !== prepared.canonicalPath ||
    !isStrictDescendant(prepared.canonicalRoot, postCanonicalPath) ||
    !prepared.canonicalAllowedRoots.some((root) => isStrictDescendant(root, postCanonicalPath))
  ) {
    return false;
  }
  return identitiesMatch(identity, await fs.promises.stat(postCanonicalPath, { bigint: true }));
}

function readDescriptorBoundedSync(fd: number, maxBytes: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return total > maxBytes ? null : Buffer.concat(chunks, total);
}

async function readDescriptorBounded(
  handle: fs.promises.FileHandle,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return total > maxBytes ? null : Buffer.concat(chunks, total);
}

function openFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
}

export function readBoundedTaskTextFileSync(
  request: BoundedTaskTextFileRequest,
): BoundedTaskTextFile | null {
  let fd: number | null = null;
  try {
    const prepared = prepareSync(request);
    if (!prepared) {
      return null;
    }
    const identity = captureIdentity(fs.statSync(prepared.canonicalPath, { bigint: true }));
    if (!identity) {
      return null;
    }

    fd = fs.openSync(prepared.canonicalPath, openFlags());
    if (
      !identitiesMatch(identity, fs.fstatSync(fd, { bigint: true })) ||
      !verifyPostOpenPathSync(prepared, identity) ||
      !request.admission.commitAfterDescriptorBind()
    ) {
      return null;
    }

    const content = readDescriptorBoundedSync(fd, request.maxBytes);
    return content
      ? {
          canonicalPath: prepared.canonicalPath,
          content: content.toString('utf8'),
          relativePath: prepared.normalizedRelativePath,
        }
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The read already fails closed; descriptor cleanup is best effort.
      }
    }
  }
}

export async function readBoundedTaskTextFile(
  request: BoundedTaskTextFileRequest,
): Promise<BoundedTaskTextFile | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const prepared = await prepare(request);
    if (!prepared) {
      return null;
    }
    const identity = captureIdentity(
      await fs.promises.stat(prepared.canonicalPath, { bigint: true }),
    );
    if (!identity) {
      return null;
    }

    handle = await fs.promises.open(prepared.canonicalPath, openFlags());
    if (
      !identitiesMatch(identity, await handle.stat({ bigint: true })) ||
      !(await verifyPostOpenPath(prepared, identity)) ||
      !request.admission.commitAfterDescriptorBind()
    ) {
      return null;
    }

    const content = await readDescriptorBounded(handle, request.maxBytes);
    return content
      ? {
          canonicalPath: prepared.canonicalPath,
          content: content.toString('utf8'),
          relativePath: prepared.normalizedRelativePath,
        }
      : null;
  } catch {
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}
