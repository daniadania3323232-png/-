// Minimal stdio MCP server used by the integration test as a stand-in for Roblox Studio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({ name: 'fake-studio', version: '0.0.1' });
server.registerTool(
  'echo',
  {
    description: 'Echoes the message back',
    inputSchema: { message: z.string(), studio_id: z.string().optional() },
  },
  async ({ message, studio_id }) => ({ content: [{ type: 'text', text: `echo(${studio_id ?? '-'}): ${message}` }] }),
);
await server.connect(new StdioServerTransport());
