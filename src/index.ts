#!/usr/bin/env node
import { generateToken } from './auth.js';
import { loadConfig } from './config.js';
import { startBridge } from './http.js';
import { createLogger } from './log.js';
import { VERSION } from './version.js';

function parseArgs(argv: string[]): { config?: string; verbose: boolean; help: boolean } {
  const out: { config?: string; verbose: boolean; help: boolean } = { verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') out.config = argv[++i];
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`notion-mcp-bridge ${VERSION}
Usage: notion-mcp-bridge [--config bridge.config.json] [--verbose]
Env:   MCP_BRIDGE_TOKEN, MCP_BRIDGE_PORT, MCP_BRIDGE_HOST, MCP_BRIDGE_CONFIG`);
    return;
  }
  const log = createLogger(args.verbose);
  const { config, source } = loadConfig(args.config);
  log.info(`config: ${source ?? 'defaults (no bridge.config.json found)'}`);

  let token = config.auth.token;
  if (!token) {
    token = generateToken();
    log.warn('no auth token configured — generated a one-time token (set MCP_BRIDGE_TOKEN or auth.token to keep it stable)');
  }

  const bridge = await startBridge(config, token, log);
  log.info(`listening on ${bridge.url}`);
  log.info(`health:    http://${config.host}:${bridge.port}/health`);
  log.info(`auth:      Authorization: Bearer ${token}`);
  if (Object.keys(config.servers).length === 0) log.warn('no upstream servers configured');

  // Connect upstreams now so Studio errors surface at startup instead of on first tool call.
  const names = [...bridge.ctx.builtins.keys(), ...(await bridge.ctx.pool.listTools()).map((t) => t.name)];
  log.info(`tools (${names.length}): ${names.join(', ')}`);
  log.info('expose this port with a tunnel (npm run tunnel:cloudflare) and add the https URL in Notion');

  const shutdown = async () => {
    log.info('shutting down');
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
