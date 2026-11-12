import { spawn } from 'node:child_process';
import { z } from 'zod/v4';
import type { Config } from '../config.js';
import { defineTool, textResult, type BuiltinTool } from './types.js';

export function createShellTools(cfg: Config['shell'], defaultCwd: string): BuiltinTool[] {
  if (!cfg.enabled) return [];
  return [
    defineTool(
      'shell_run',
      `Run a shell command on this computer and return its output. Working directory defaults to ${cfg.cwd ?? defaultCwd}.`,
      z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(cfg.timeoutMs).default(cfg.timeoutMs),
      }),
      async ({ command, cwd, timeoutMs }) => {
        const result = await new Promise<{ code: number | null; signal: string | null; out: string; timedOut: boolean }>(
          (resolve) => {
            const child = spawn(command, { shell: true, cwd: cwd ?? cfg.cwd ?? defaultCwd, windowsHide: true });
            let out = '';
            let timedOut = false;
            const cap = (chunk: Buffer) => {
              if (out.length < cfg.maxOutputChars) out += chunk.toString();
            };
            child.stdout.on('data', cap);
            child.stderr.on('data', cap);
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeoutMs);
            child.on('error', (err) => {
              clearTimeout(timer);
              resolve({ code: null, signal: null, out: `${out}\n${err.message}`, timedOut });
            });
            child.on('close', (code, signal) => {
              clearTimeout(timer);
              resolve({ code, signal, out, timedOut });
            });
          },
        );
        const trimmed = result.out.length > cfg.maxOutputChars ? `${result.out.slice(0, cfg.maxOutputChars)}\n… (truncated)` : result.out;
        const status = result.timedOut ? `timed out after ${timeoutMs} ms` : `exit code ${result.code ?? result.signal}`;
        return { ...textResult(`$ ${command}\n${trimmed}\n[${status}]`), isError: result.timedOut || result.code !== 0 };
      },
    ),
  ];
}
