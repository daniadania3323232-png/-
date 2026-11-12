import net from 'node:net';
import { z } from 'zod/v4';
import type { Config } from '../config.js';
import { defineTool, errorResult, textResult, type BuiltinTool } from './types.js';

/** Literal-address check only; DNS names resolving to private ranges are not detected. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const family = net.isIP(h);
  if (family === 4) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  }
  return false;
}

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutBlocks);
  const text = withoutBlocks
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  const title = titleMatch?.[1]?.trim();
  return title ? `# ${title}\n\n${text}` : text;
}

export function createWebTools(cfg: Config['web']): BuiltinTool[] {
  return [
    defineTool(
      'web_fetch',
      'Fetch a public http(s) URL and return its content as plain text (HTML is stripped, JSON is pretty-printed).',
      z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(100).max(cfg.maxChars).default(cfg.maxChars),
      }),
      async ({ url, maxChars }) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return errorResult('Only http and https URLs are allowed');
        if (!cfg.allowPrivateNetwork && isPrivateHost(parsed.hostname)) {
          return errorResult('Requests to local/private network addresses are disabled (web.allowPrivateNetwork)');
        }
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(cfg.timeoutMs),
          headers: { 'user-agent': 'notion-mcp-bridge/0.1 (+https://github.com)', accept: 'text/html,application/json,text/*;q=0.9,*/*;q=0.5' },
        });
        const type = res.headers.get('content-type') ?? '';
        const body = await res.text();
        let text: string;
        if (type.includes('html')) text = htmlToText(body);
        else if (type.includes('json')) {
          try {
            text = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            text = body;
          }
        } else text = body;
        const truncated = text.length > maxChars;
        const out = truncated ? `${text.slice(0, maxChars)}\n… (truncated, ${text.length} chars total)` : text;
        return textResult(`HTTP ${res.status} ${res.url}\nContent-Type: ${type}\n\n${out}`);
      },
    ),
  ];
}
