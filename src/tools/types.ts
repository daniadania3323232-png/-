import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<CallToolResult>;
}

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>) => Promise<CallToolResult>,
): BuiltinTool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    handler: async (args) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return errorResult(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
      return run(parsed.data);
    },
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
