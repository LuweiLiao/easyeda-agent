import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = process.env.EASYEDA_MCP_SERVER || path.join(packageDir, 'src', 'server.mjs');

test('stdio MCP initializes, lists tools, and invokes offline discovery', async () => {
  assert.ok(process.env.EASYEDA_BIN, 'EASYEDA_BIN must point to the local CLI for integration tests');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: packageDir,
    env: { ...process.env, EASYEDA_BIN: process.env.EASYEDA_BIN },
  });
  const client = new Client({ name: 'easyeda-agent-mcp-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 15);
    assert.ok(listed.tools.some((tool) => tool.name === 'easyeda_pcb'));
    for (const name of ['easyeda_cli', 'easyeda_cli_help', 'easyeda_image']) {
      assert.ok(listed.tools.some((tool) => tool.name === name), name);
    }

    const help = await client.callTool({ name: 'easyeda_cli_help', arguments: { path: 'pcb dump' } });
    assert.equal(help.isError, false);
    assert.ok(help.structuredContent.commands.some((c) => c.path.join(' ') === 'pcb dump'));

    const offline = await client.callTool({ name: 'easyeda_cli', arguments: { argv: ['version'] } });
    assert.equal(offline.isError, false);
    assert.match(offline.content[0].text, /easyeda-agent/);

    const blocked = await client.callTool({ name: 'easyeda_cli', arguments: { argv: ['daemon', 'stop'] } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /not available through MCP/);
    assert.ok(!listed.tools.some((tool) => tool.name === 'easyeda_debug'));

    assert.ok(listed.tools.some((tool) => tool.name === 'easyeda_project_transfer'));
    const rejectedOpen = await client.callTool({ name: 'easyeda_project_transfer', arguments: { operation: 'open', window: 'w', projectUuid: 'p' } });
    assert.equal(rejectedOpen.isError, true);
    assert.match(rejectedOpen.content[0].text, /acknowledge/);

    const allActions = await client.callTool({
      name: 'easyeda_actions',
      arguments: {},
    });
    assert.equal(allActions.isError, false);
    assert.ok(!allActions.structuredContent.actions.some((action) => action.domain === 'debug'));
    for (const name of ['project.open', 'project.export']) assert.ok(allActions.structuredContent.actions.some(action => action.name === name));

    const discovered = await client.callTool({
      name: 'easyeda_actions',
      arguments: { domain: 'schematic', search: 'check', mutates: false },
    });
    assert.equal(discovered.isError, false);
    assert.ok(Array.isArray(discovered.structuredContent.actions));
    assert.ok(discovered.structuredContent.actions.some((action) => action.name === 'schematic.check'));

    const rejectedMutation = await client.callTool({
      name: 'easyeda_schematic',
      arguments: { action: 'schematic.page.create', payload: { name: 'Unsafe' } },
    });
    assert.equal(rejectedMutation.isError, true);
    assert.match(rejectedMutation.content[0].text, /requires both project and doc/);

    for (const routing of [{}, { window: 'home-window', doc: 'tab_page1' }, { window: 'home-window', project: 'Future project' }]) {
      const rejectedCreate = await client.callTool({
        name: 'easyeda_project',
        arguments: { action: 'project.create', payload: { friendlyName: 'Must not be created' }, ...routing },
      });
      assert.equal(rejectedCreate.isError, true);
      assert.match(rejectedCreate.content[0].text, /requires an explicit window|does not accept project or doc/);
    }

    const blocks = await client.callTool({
      name: 'easyeda_blocks',
      arguments: { operation: 'search', query: 'led' },
    });
    assert.equal(blocks.isError, false);
  }
  finally {
    await client.close();
  }
});
