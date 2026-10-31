import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlaybookPath,
  ApplyGuard,
  buildCliArgs,
  buildCliHelpArgs,
  cliProcessTimeoutMs,
  MAX_STDOUT_CHARS,
  readImageContent,
  shapeCliResult,
} from '../src/cli.mjs';

test('buildCliArgs routes project/doc/window around a plain argv', () => {
  assert.deepEqual(
    buildCliArgs({ argv: ['pcb', 'dump', '--out', 'D:/b.json'], project: 'P', doc: 'PCB1', window: 'w1' }),
    ['--project', 'P', '--doc', 'PCB1', 'pcb', 'dump', '--out', 'D:/b.json', '--window', 'w1'],
  );
  // apply takes --doc as its own flag, after the playbook.
  assert.deepEqual(
    buildCliArgs({ argv: ['apply', 'p.json', '--dry-run'], project: 'P', doc: 'PCB1' }),
    ['--project', 'P', 'apply', 'p.json', '--dry-run', '--doc', 'PCB1'],
  );
});

test('buildCliArgs refuses self-management commands and routing flags in argv', () => {
  for (const argv of [['daemon', 'stop'], ['update'], ['debug', 'exec'], ['skill', 'update']]) {
    assert.throws(() => buildCliArgs({ argv }), /not available through MCP/);
  }
  assert.throws(() => buildCliArgs({ argv: ['pcb', 'drc', '--project', 'X'] }), /set by the tool input/);
  assert.throws(() => buildCliArgs({ argv: ['--project', 'X'] }), /command name/);
  assert.throws(() => buildCliArgs({ argv: [] }), /non-empty/);
  assert.doesNotThrow(() => buildCliArgs({ argv: ['daemon', 'health'] }));
});

test('applyPlaybookPath skips flag values', () => {
  assert.equal(applyPlaybookPath(['apply', '--var', 'A=1', 'x.json', '--dry-run']), 'x.json');
  assert.equal(applyPlaybookPath(['apply', '--dry-run', 'y.json']), 'y.json');
  assert.equal(applyPlaybookPath(['pcb', 'dump']), undefined);
});

test('ApplyGuard needs a passing dry-run of the same bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-apply-'));
  const file = join(dir, 'p.json');
  await writeFile(file, '{"steps":[1]}');
  const guard = new ApplyGuard();
  await assert.rejects(guard.check(['apply', file, '--yes']), /no passing --dry-run/);

  const failed = await guard.check(['apply', file, '--dry-run']);
  guard.record(failed, false);
  await assert.rejects(guard.check(['apply', file]), /no passing --dry-run/);

  const passed = await guard.check(['apply', file, '--dry-run']);
  guard.record(passed, true);
  assert.equal((await guard.check(['apply', file, '--yes'])).kind, 'write');

  await writeFile(file, '{"steps":[1,2]}');
  await assert.rejects(guard.check(['apply', file]), /no passing --dry-run/);

  // Relative playbook paths resolve against cwd.
  await writeFile(file, '{"steps":[3]}');
  guard.record(await guard.check(['apply', 'p.json', '--dry-run'], dir), true);
  assert.equal((await guard.check(['apply', file])).kind, 'write');
});

test('timeouts and help args', () => {
  assert.equal(cliProcessTimeoutMs({}), 300_000);
  assert.equal(cliProcessTimeoutMs({ timeoutSec: 600 }), 600_000);
  assert.equal(cliProcessTimeoutMs({ timeoutSec: 99_999 }), 1_800_000);
  assert.deepEqual(buildCliHelpArgs({ path: 'pcb layout', long: true }), ['cli-tree', '--prefix', 'pcb layout', '--long']);
  assert.deepEqual(buildCliHelpArgs({}), ['cli-tree']);
});

test('shapeCliResult truncates huge stdout and names the fix', () => {
  const big = 'x'.repeat(MAX_STDOUT_CHARS + 10);
  const shaped = shapeCliResult({ ok: true, result: big }, ['pcb', 'dump']);
  assert.equal(shaped.result.length, MAX_STDOUT_CHARS);
  assert.match(shaped.truncated.hint, /--out/);
  assert.equal(shaped.command, 'easyeda pcb dump');
  assert.equal(shapeCliResult({ ok: true, result: { a: 1 } }, ['x']).truncated, undefined);
});

test('readImageContent returns base64 image content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-img-'));
  const png = join(dir, 'a.png');
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const content = await readImageContent(png);
  assert.equal(content.type, 'image');
  assert.equal(content.mimeType, 'image/png');
  assert.equal(content.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  await assert.rejects(readImageContent(join(dir, 'a.txt')), /not an image/);

  const svg = join(dir, 'b.svg');
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5"><rect width="10" height="5" fill="red"/></svg>');
  const raster = await readImageContent(svg, { svgWidth: 40 });
  assert.equal(raster.mimeType, 'image/png');
  const bytes = Buffer.from(raster.data, 'base64');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 40); // IHDR width
});
