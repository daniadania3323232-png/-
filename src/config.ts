import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';

const ServerSpecSchema = z.object({
  enabled: z.boolean().default(true),
  // Platform-specific launcher resolved at startup; "command" is ignored when a preset is set.
  preset: z.enum(['roblox-studio']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  // Per-call timeout; Roblox generation jobs can take minutes.
  timeoutMs: z.number().int().positive().default(300_000),
});

export const ConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  path: z.string().regex(/^\//).default('/mcp'),
  auth: z
    .object({
      // Empty string (unset ${MCP_BRIDGE_TOKEN}) means "generate one at startup".
      token: z
        .string()
        .optional()
        .transform((t) => (t ? t : undefined)),
    })
    .prefault({}),
  filesystem: z
    .object({
      roots: z.array(z.string()).default([]),
      allowWrite: z.boolean().default(false),
      maxFileBytes: z.number().int().positive().default(2_000_000),
      ignore: z.array(z.string()).default(['node_modules', '.git', 'dist', '.cache']),
    })
    .prefault({}),
  web: z
    .object({
      enabled: z.boolean().default(true),
      allowPrivateNetwork: z.boolean().default(false),
      maxChars: z.number().int().positive().default(60_000),
      timeoutMs: z.number().int().positive().default(20_000),
    })
    .prefault({}),
  shell: z
    .object({
      enabled: z.boolean().default(false),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().default(60_000),
      maxOutputChars: z.number().int().positive().default(40_000),
    })
    .prefault({}),
  servers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), ServerSpecSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerSpec = z.infer<typeof ServerSpecSchema>;

/** Replaces ${VAR} in every string with process.env.VAR (empty string when unset). */
function substituteEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

export function parseConfig(raw: unknown): Config {
  const substituted = substituteEnv(raw);
  const result = ConfigSchema.safeParse(substituted);
  if (!result.success) {
    throw new Error(`Invalid config: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file, or null when defaults were used. */
  source: string | null;
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const candidates = [explicitPath, process.env.MCP_BRIDGE_CONFIG, path.resolve('bridge.config.json')].filter(
    (p): p is string => Boolean(p),
  );
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (!fs.existsSync(abs)) {
      if (candidate === explicitPath) throw new Error(`Config file not found: ${abs}`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    const config = parseConfig(applyEnvOverrides(raw));
    return { config, source: abs };
  }
  return { config: parseConfig(applyEnvOverrides({})), source: null };
}

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const auth = { ...((raw.auth as Record<string, unknown> | undefined) ?? {}) };
  if (process.env.MCP_BRIDGE_TOKEN) auth.token = process.env.MCP_BRIDGE_TOKEN;
  out.auth = auth;
  if (process.env.MCP_BRIDGE_PORT) out.port = Number(process.env.MCP_BRIDGE_PORT);
  if (process.env.MCP_BRIDGE_HOST) out.host = process.env.MCP_BRIDGE_HOST;
  return out;
}
