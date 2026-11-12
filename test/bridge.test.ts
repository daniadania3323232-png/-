import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig } from '../src/config.js';
import { startBridge, type RunningBridge } from '../src/http.js';
import { silentLogger } from '../src/log.js';
import { htmlToText, isPrivateHost } from '../src/tools/web.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-123';

describe('notion-mcp-bridge', () => {
  let bridge: RunningBridge;
  let root: string;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'Main.lua'), 'print("hello")\nlocal x = 1\n');
    await fs.writeFile(path.join(root, 'notes.txt'), 'secret word: pineapple\n');
    const config = parseConfig({
      port: 0,
      filesystem: { roots: [root], allowWrite: true },
      web: { enabled: true },
      shell: { enabled: true },
      servers: {
        fake: { command: process.execPath, args: ['--import', 'tsx', path.join(here, 'fake-upstream.ts')] },
      },
    });
    bridge = await startBridge(config, TOKEN, silentLogger);
  });

  after(async () => {
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(token = TOKEN): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  it('rejects requests without a valid token', async () => {
    const res = await fetch(bridge.url, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    await assert.rejects(connect('wrong'));
  });

  it('serves /health without auth', async () => {
    const res = await fetch(bridge.url.replace('/mcp', '/health'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('lists builtin and prefixed upstream tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ['fs_list', 'fs_read', 'fs_search', 'fs_write', 'web_fetch', 'shell_run', 'bridge_status', 'fake_echo']) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(',')}`);
    }
    await client.close();
  });

  it('proxies tool calls to the upstream stdio server', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'fake_echo', arguments: { message: 'hi', studio_id: 's1' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'echo(s1): hi' }]);
    await client.close();
  });

  it('reads, lists, searches and writes files inside roots', async () => {
    const client = await connect();
    const read = await client.callTool({ name: 'fs_read', arguments: { path: path.join(root, 'src', 'Main.lua') } });
    assert.match(text(read), /print\("hello"\)/);

    const ranged = await client.callTool({ name: 'fs_read', arguments: { path: 'src/Main.lua', offset: 2, limit: 1 } });
    assert.match(text(ranged), /^2: local x = 1/);

    const list = await client.callTool({ name: 'fs_list', arguments: { path: root, depth: 2 } });
    assert.match(text(list), /src\/\n {2}Main\.lua/);

    const search = await client.callTool({ name: 'fs_search', arguments: { contentPattern: 'pineapple' } });
    assert.match(text(search), /notes\.txt:1: secret word: pineapple/);

    const write = await client.callTool({ name: 'fs_write', arguments: { path: 'out/new.txt', content: 'abc' } });
    assert.equal(write.isError, undefined);
    assert.equal(await fs.readFile(path.join(root, 'out', 'new.txt'), 'utf8'), 'abc');
    await client.close();
  });

  it('refuses paths outside the allowed roots', async () => {
    const client = await connect();
    const outside = path.join(os.tmpdir(), 'bridge-outside-file.txt');
    await fs.writeFile(outside, 'nope');
    try {
      const result = await client.callTool({ name: 'fs_read', arguments: { path: outside } });
      assert.equal(result.isError, true);
      assert.match(text(result), /Access denied/);
      const traversal = await client.callTool({ name: 'fs_read', arguments: { path: path.join(root, '..', path.basename(outside)) } });
      assert.equal(traversal.isError, true);
    } finally {
      await fs.rm(outside, { force: true });
      await client.close();
    }
  });

  it('runs shell commands when enabled', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'shell_run', arguments: { command: 'echo bridge-ok' } });
    assert.match(text(result), /bridge-ok/);
    assert.match(text(result), /exit code 0/);
    await client.close();
  });

  it('blocks private hosts for web_fetch', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1:1/' } });
    assert.equal(result.isError, true);
    await client.close();
  });

  it('reports status', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'bridge_status', arguments: {} });
    const status = JSON.parse(text(result)) as { servers: { name: string; state: string }[] };
    assert.deepEqual(status.servers, [{ name: 'fake', state: 'connected', lastError: null }]);
    await client.close();
  });
});

describe('helpers', () => {
  it('detects private hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '::1', 'printer.local']) {
      assert.equal(isPrivateHost(h), true, h);
    }
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2606:4700::1']) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });

  it('strips html', () => {
    const out = htmlToText('<html><head><title>T</title><script>x()</script></head><body><p>Hello &amp; bye</p><div>next</div></body></html>');
    assert.equal(out, '# T\n\nHello & bye\nnext');
  });
});

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}
