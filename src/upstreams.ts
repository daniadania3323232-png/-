import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ServerSpec } from './config.js';
import type { Logger } from './log.js';
import { resolveLauncher } from './presets.js';
import { VERSION } from './version.js';

export type UpstreamState = 'disconnected' | 'connecting' | 'connected' | 'failed';

/** One stdio MCP server (e.g. Roblox Studio) whose tools are re-exported with a name prefix. */
export class Upstream {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private cachedTools: Tool[] = [];
  private _state: UpstreamState = 'disconnected';
  private _lastError: string | null = null;

  constructor(
    readonly name: string,
    private readonly spec: ServerSpec,
    private readonly log: Logger,
  ) {}

  get state(): UpstreamState {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  prefixed(toolName: string): string {
    return `${this.name}_${toolName}`;
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<Client> {
    this._state = 'connecting';
    try {
      return await this.spawnAndConnect();
    } catch (err) {
      this._state = 'failed';
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async spawnAndConnect(): Promise<Client> {
    const launcher = resolveLauncher(this.name, this.spec);
    this.log.info(`starting ${launcher.command} ${launcher.args.join(' ')}`);
    const transport = new StdioClientTransport({
      command: launcher.command,
      args: launcher.args,
      env: { ...getDefaultEnvironment(), ...this.spec.env },
      cwd: this.spec.cwd,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log.debug(`stderr: ${text}`);
    });
    const client = new Client({ name: 'notion-mcp-bridge', version: VERSION });
    client.onclose = () => {
      this.log.warn('connection closed');
      this.client = null;
      this._state = 'disconnected';
    };
    client.onerror = (err) => {
      this.log.warn(`error: ${err.message}`);
    };
    await client.connect(transport);
    this.client = client;
    this._state = 'connected';
    this._lastError = null;
    const info = client.getServerVersion();
    this.log.info(`connected to ${info?.name ?? 'unknown'} ${info?.version ?? ''}`.trim());
    return client;
  }

  /** Lists upstream tools; falls back to the last known list if the server is unreachable. */
  async listTools(): Promise<Tool[]> {
    try {
      const client = await this.connect();
      const { tools } = await client.listTools();
      this.cachedTools = tools;
    } catch (err) {
      this.log.warn(`tools unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.cachedTools.map((tool) => ({
      ...tool,
      name: this.prefixed(tool.name),
      description: `[${this.name}] ${tool.description ?? ''}`.trim(),
    }));
  }

  async callTool(originalName: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const client = await this.connect();
    const result = await client.callTool({ name: originalName, arguments: args ?? {} }, undefined, {
      timeout: this.spec.timeoutMs,
      resetTimeoutOnProgress: true,
    });
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this._state = 'disconnected';
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }
}

export class UpstreamPool {
  readonly upstreams: Upstream[];
  private routes = new Map<string, { upstream: Upstream; originalName: string }>();

  constructor(servers: Record<string, ServerSpec>, log: Logger) {
    this.upstreams = Object.entries(servers)
      .filter(([, spec]) => spec.enabled)
      .map(([name, spec]) => new Upstream(name, spec, log.child(name)));
  }

  async listTools(): Promise<Tool[]> {
    const lists = await Promise.all(this.upstreams.map(async (u) => ({ u, tools: await u.listTools() })));
    const routes = new Map<string, { upstream: Upstream; originalName: string }>();
    const tools: Tool[] = [];
    for (const { u, tools: upstreamTools } of lists) {
      for (const tool of upstreamTools) {
        routes.set(tool.name, { upstream: u, originalName: tool.name.slice(u.name.length + 1) });
        tools.push(tool);
      }
    }
    this.routes = routes;
    return tools;
  }

  route(prefixedName: string): { upstream: Upstream; originalName: string } | null {
    const cached = this.routes.get(prefixedName);
    if (cached) return cached;
    // Tool may be called before tools/list was seen by this process.
    for (const u of this.upstreams) {
      if (prefixedName.startsWith(`${u.name}_`)) {
        return { upstream: u, originalName: prefixedName.slice(u.name.length + 1) };
      }
    }
    return null;
  }

  async close(): Promise<void> {
    await Promise.all(this.upstreams.map((u) => u.close()));
  }
}
