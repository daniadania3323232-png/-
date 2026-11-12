import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { createFilesystemTools, SafeFs } from './tools/filesystem.js';
import { createShellTools } from './tools/shell.js';
import { defineTool, errorResult, textResult, type BuiltinTool } from './tools/types.js';
import { createWebTools } from './tools/web.js';
import { UpstreamPool } from './upstreams.js';
import { VERSION } from './version.js';

export interface BridgeContext {
  config: Config;
  log: Logger;
  pool: UpstreamPool;
  builtins: Map<string, BuiltinTool>;
}

export async function createContext(config: Config, log: Logger): Promise<BridgeContext> {
  const pool = new UpstreamPool(config.servers, log.child('upstream'));
  const builtins = new Map<string, BuiltinTool>();
  const register = (tools: BuiltinTool[]) => {
    for (const t of tools) builtins.set(t.name, t);
  };

  if (config.filesystem.roots.length > 0) {
    const safe = new SafeFs(config.filesystem.roots, config.filesystem.ignore, config.filesystem.maxFileBytes);
    await safe.init();
    register(createFilesystemTools(config.filesystem, safe));
  } else {
    log.warn('filesystem.roots is empty — file tools are disabled');
  }
  if (config.web.enabled) register(createWebTools(config.web));
  register(createShellTools(config.shell, config.filesystem.roots[0] ?? process.cwd()));

  register([
    defineTool(
      'bridge_status',
      'Show which connected servers and capabilities this bridge currently exposes.',
      z.object({}),
      async () =>
        textResult(
          JSON.stringify(
            {
              version: VERSION,
              platform: process.platform,
              filesystemRoots: config.filesystem.roots,
              filesystemWrite: config.filesystem.allowWrite,
              web: config.web.enabled,
              shell: config.shell.enabled,
              servers: pool.upstreams.map((u) => ({ name: u.name, state: u.state, lastError: u.lastError })),
            },
            null,
            2,
          ),
        ),
    ),
  ]);

  return { config, log, pool, builtins };
}

/** Builds a fresh MCP server bound to the shared context (one per HTTP request in stateless mode). */
export function createMcpServer(ctx: BridgeContext): Server {
  const server = new Server({ name: 'notion-mcp-bridge', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const builtin: Tool[] = [...ctx.builtins.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool['inputSchema'],
    }));
    const upstream = await ctx.pool.listTools();
    return { tools: [...builtin, ...upstream] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    ctx.log.debug(`tool call ${name}`);
    try {
      const builtin = ctx.builtins.get(name);
      if (builtin) return await builtin.handler(args);
      const route = ctx.pool.route(name);
      if (route) return await route.upstream.callTool(route.originalName, args);
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`tool ${name} failed: ${message}`);
      return errorResult(message);
    }
  });

  return server;
}
