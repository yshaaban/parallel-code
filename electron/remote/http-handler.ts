import { existsSync, createReadStream } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { extname, isAbsolute, join, relative, resolve } from 'path';
import type { RemoteAgent, RemoteAgentStatus } from './protocol.js';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

export interface RemoteAgentDetail {
  exitCode: number | null;
  scrollback: string;
  status: RemoteAgentStatus;
}

export interface CreateRemoteHttpHandlerOptions {
  checkAuth: (req: IncomingMessage) => boolean;
  getAgentDetail: (agentId: string) => RemoteAgentDetail | null;
  getAgentList: () => RemoteAgent[];
  staticDir: string;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStaticFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  cacheControl: string,
): void {
  const stream = createReadStream(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
  });
  stream.pipe(res);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
}

export function createRemoteHttpHandler(
  options: CreateRemoteHttpHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      if (!options.checkAuth(req)) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (url.pathname === '/api/agents' && req.method === 'GET') {
        writeJson(res, 200, options.getAgentList());
        return;
      }

      const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && req.method === 'GET') {
        const agentId = agentMatch[1];
        if (!agentId) {
          writeJson(res, 404, { error: 'agent not found' });
          return;
        }

        const detail = options.getAgentDetail(agentId);
        if (!detail) {
          writeJson(res, 404, { error: 'agent not found' });
          return;
        }

        writeJson(res, 200, {
          agentId,
          exitCode: detail.exitCode,
          scrollback: detail.scrollback,
          status: detail.status,
        });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
      return;
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = resolve(options.staticDir, requestPath.replace(/^\/+/, ''));
    const relativePath = relative(options.staticDir, fullPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end('Bad request');
      return;
    }

    if (!existsSync(fullPath)) {
      const indexPath = join(options.staticDir, 'index.html');
      if (existsSync(indexPath)) {
        serveStaticFile(res, indexPath, 'text/html', 'no-cache');
        return;
      }

      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
      return;
    }

    const extension = extname(fullPath);
    const contentType = MIME[extension] ?? 'application/octet-stream';
    const cacheControl = extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    serveStaticFile(res, fullPath, contentType, cacheControl);
  };
}
