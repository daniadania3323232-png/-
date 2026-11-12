import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isAuthorized } from './auth.js';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { createContext, createMcpServer, type BridgeContext } from './server.js';

export interface RunningBridge {
  ctx: BridgeContext;
  port: number;
  url: string;
  close(): Promise<void>;
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export async function startBridge(config: Config, token: string, log: Logger): Promise<RunningBridge> {
  const ctx = await createContext(config, log);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, servers: ctx.pool.upstreams.map((u) => ({ name: u.name, state: u.state })) }));
      return;
    }
    if (url.pathname !== config.path) {
      jsonRpcError(res, 404, 'Not found');
      return;
    }
    if (!isAuthorized(req, token)) {
      log.warn(`unauthorized ${req.method} from ${req.socket.remoteAddress ?? '?'}`);
      jsonRpcError(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer realm="notion-mcp-bridge"' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no standalone SSE stream and no sessions to delete.
      jsonRpcError(res, 405, 'Method not allowed', { allow: 'POST' });
      return;
    }
    const mcp = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const bridge: RunningBridge = {
    ctx,
    port,
    url: `http://${config.host}:${port}${config.path}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await ctx.pool.close();
    },
  };
  return bridge;
}
