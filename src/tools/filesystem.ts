import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { Config } from '../config.js';
import { defineTool, errorResult, textResult, type BuiltinTool } from './types.js';

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const normalize = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

export class SafeFs {
  private realRoots: string[] = [];

  constructor(
    readonly roots: string[],
    private readonly ignore: string[],
    private readonly maxFileBytes: number,
  ) {}

  async init(): Promise<void> {
    this.realRoots = await Promise.all(
      this.roots.map(async (r) => {
        const abs = path.resolve(r);
        try {
          return await fs.realpath(abs);
        } catch {
          throw new Error(`filesystem.roots: directory not found: ${abs}`);
        }
      }),
    );
  }

  isIgnored(name: string): boolean {
    return this.ignore.includes(name);
  }

  /** Resolves symlinks and rejects anything outside the configured roots. */
  async resolve(input: string, { mustExist = true } = {}): Promise<string> {
    const abs = path.resolve(input);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      if (mustExist) throw new Error(`Path not found: ${abs}`);
      // Resolve through the nearest existing ancestor so new nested paths are still contained.
      const missing: string[] = [];
      let cursor = abs;
      while (true) {
        try {
          real = path.join(await fs.realpath(cursor), ...missing);
          break;
        } catch {
          const parent = path.dirname(cursor);
          if (parent === cursor) throw new Error(`Path not found: ${abs}`);
          missing.unshift(path.basename(cursor));
          cursor = parent;
        }
      }
    }
    const n = normalize(real);
    const inside = this.realRoots.some((root) => {
      const r = normalize(root);
      return n === r || n.startsWith(r + path.sep);
    });
    if (!inside) throw new Error(`Access denied: ${abs} is outside allowed roots (${this.roots.join(', ')})`);
    return real;
  }

  async readText(real: string): Promise<{ kind: 'text'; text: string } | { kind: 'binary'; bytes: number }> {
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new Error(`Not a file: ${real}`);
    if (stat.size > this.maxFileBytes) throw new Error(`File too large (${stat.size} bytes, limit ${this.maxFileBytes})`);
    const buf = await fs.readFile(real);
    if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', bytes: buf.length };
    return { kind: 'text', text: buf.toString('utf8') };
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function createFilesystemTools(cfg: Config['filesystem'], safe: SafeFs): BuiltinTool[] {
  const tools: BuiltinTool[] = [];

  tools.push(
    defineTool(
      'fs_list',
      `List files and folders inside an allowed directory. Allowed roots: ${cfg.roots.join(', ')}`,
      z.object({
        path: z.string().describe('Absolute path of a directory (or relative to the first root)'),
        depth: z.number().int().min(1).max(5).default(1).describe('How many levels deep to list'),
      }),
      async ({ path: p, depth }) => {
        const real = await safe.resolve(path.resolve(cfg.roots[0] ?? '', p));
        const lines: string[] = [];
        let count = 0;
        const walk = async (dir: string, level: number) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const e of entries) {
            if (safe.isIgnored(e.name)) continue;
            if (++count > 2000) {
              lines.push('… (truncated at 2000 entries)');
              return;
            }
            const full = path.join(dir, e.name);
            const indent = '  '.repeat(level);
            if (e.isDirectory()) {
              lines.push(`${indent}${e.name}/`);
              if (level + 1 < depth) await walk(full, level + 1);
            } else {
              const size = e.isFile() ? (await fs.stat(full).catch(() => null))?.size : undefined;
              lines.push(`${indent}${e.name}${size !== undefined ? ` (${size} B)` : ''}`);
            }
          }
        };
        await walk(real, 0);
        return textResult(`${real}\n${lines.join('\n') || '(empty)'}`);
      },
    ),
  );

  tools.push(
    defineTool(
      'fs_read',
      'Read a text file (optionally a line range) or an image from an allowed directory.',
      z.object({
        path: z.string().describe('Absolute file path (or relative to the first root)'),
        offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
        limit: z.number().int().min(1).optional().describe('Maximum number of lines to return'),
      }),
      async ({ path: p, offset, limit }) => {
        const real = await safe.resolve(path.resolve(cfg.roots[0] ?? '', p));
        const mime = IMAGE_TYPES[path.extname(real).toLowerCase()];
        if (mime) {
          const stat = await fs.stat(real);
          if (stat.size > cfg.maxFileBytes) return errorResult(`Image too large (${stat.size} bytes)`);
          const data = (await fs.readFile(real)).toString('base64');
          return { content: [{ type: 'image', data, mimeType: mime }] };
        }
        const file = await safe.readText(real);
        if (file.kind === 'binary') return errorResult(`${real} is a binary file (${file.bytes} bytes)`);
        if (offset === undefined && limit === undefined) return textResult(file.text);
        const lines = file.text.split(/\r?\n/);
        const start = (offset ?? 1) - 1;
        const slice = lines.slice(start, limit === undefined ? undefined : start + limit);
        const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
        return textResult(`${numbered}\n(${lines.length} lines total)`);
      },
    ),
  );

  tools.push(
    defineTool(
      'fs_search',
      'Search files by name pattern and/or text content inside an allowed directory.',
      z.object({
        path: z.string().optional().describe('Directory to search (defaults to the first root)'),
        namePattern: z.string().optional().describe('Glob for file names, e.g. *.lua or Main*'),
        contentPattern: z.string().optional().describe('Case-insensitive text or regular expression to find inside files'),
        maxResults: z.number().int().min(1).max(500).default(100),
      }),
      async ({ path: p, namePattern, contentPattern, maxResults }) => {
        if (!namePattern && !contentPattern) return errorResult('Provide namePattern and/or contentPattern');
        const real = await safe.resolve(p ? path.resolve(cfg.roots[0] ?? '', p) : (cfg.roots[0] ?? ''));
        const nameRe = namePattern ? globToRegex(namePattern) : null;
        let contentRe: RegExp | null = null;
        if (contentPattern) {
          try {
            contentRe = new RegExp(contentPattern, 'i');
          } catch {
            contentRe = new RegExp(contentPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          }
        }
        const results: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          if (results.length >= maxResults) return;
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            if (results.length >= maxResults) return;
            if (safe.isIgnored(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
              await walk(full);
              continue;
            }
            if (!e.isFile()) continue;
            if (nameRe && !nameRe.test(e.name)) continue;
            if (!contentRe) {
              results.push(full);
              continue;
            }
            const stat = await fs.stat(full).catch(() => null);
            if (!stat || stat.size > cfg.maxFileBytes) continue;
            const buf = await fs.readFile(full).catch(() => null);
            if (!buf || buf.subarray(0, 8192).includes(0)) continue;
            const lines = buf.toString('utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const line = lines[i] ?? '';
              if (contentRe.test(line)) results.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          }
        };
        await walk(real);
        return textResult(results.length ? results.join('\n') : 'No matches');
      },
    ),
  );

  if (cfg.allowWrite) {
    tools.push(
      defineTool(
        'fs_write',
        'Create or overwrite a text file inside an allowed directory (parent folders are created).',
        z.object({
          path: z.string().describe('Absolute file path (or relative to the first root)'),
          content: z.string(),
          append: z.boolean().default(false),
        }),
        async ({ path: p, content, append }) => {
          const real = await safe.resolve(path.resolve(cfg.roots[0] ?? '', p), { mustExist: false });
          await fs.mkdir(path.dirname(real), { recursive: true });
          if (append) await fs.appendFile(real, content, 'utf8');
          else await fs.writeFile(real, content, 'utf8');
          return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${real}`);
        },
      ),
    );
  }

  return tools;
}
