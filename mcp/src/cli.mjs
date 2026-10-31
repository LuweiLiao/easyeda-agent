// Generic CLI tool for the MCP adapter.
//
// The typed-action tools cover one action per call. Batch writes (apply),
// whole-board reads (pcb dump --out), rendering (pcb layout render,
// sch export-image), doc reload and the offline planners are CLI composites
// with no typed action, so agents fell back to shelling out — with quoting
// errors and no structured result. This module runs any of them as an argv
// array (no shell), keeps the guards that matter, and can hand a rendered
// image straight back to the model so a layout is looked at, not just read.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

/** Commands that manage the agent itself, not the design. */
const BLOCKED = [
  ['daemon', 'start'], ['daemon', 'stop'], ['daemon', 'restart'],
  ['update'], ['skill', 'update'], ['debug'], ['completion'],
];
/** Routing flags owned by the tool inputs (project/doc/window). */
const ROUTING_FLAGS = new Set(['--project', '--host', '--ports']);
/** apply flags that consume the next token. */
const APPLY_VALUE_FLAGS = new Set(['--doc', '--from', '--journal', '--step-delay', '--to', '--var', '--window']);

export const DEFAULT_CLI_TIMEOUT_SEC = 300;
export const MAX_CLI_TIMEOUT_SEC = 1800;
export const MAX_STDOUT_CHARS = 200_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string')) {
    throw new Error('argv must be a non-empty array of strings, e.g. ["pcb", "dump", "--out", "D:/x/board.json"]');
  }
  if (argv[0].startsWith('-')) throw new Error('argv[0] must be a command name, not a flag; pass project/doc/window as tool inputs');
  for (const blocked of BLOCKED) {
    if (blocked.every((part, i) => argv[i] === part)) {
      throw new Error(`"${blocked.join(' ')}" manages easyeda-agent itself and is not available through MCP`);
    }
  }
  for (const a of argv) {
    const name = a.split('=')[0];
    if (ROUTING_FLAGS.has(name)) throw new Error(`${name} is set by the tool input, not in argv`);
  }
}

export function buildCliArgs(input) {
  validateArgv(input.argv);
  const args = [];
  if (input.project) args.push('--project', input.project);
  if (input.doc && input.argv[0] !== 'apply') args.push('--doc', input.doc);
  args.push(...input.argv);
  if (input.window && !input.argv.some(a => a === '--window' || a.startsWith('--window='))) {
    args.push('--window', input.window);
  }
  if (input.doc && input.argv[0] === 'apply' && !input.argv.some(a => a === '--doc' || a.startsWith('--doc='))) {
    args.push('--doc', input.doc);
  }
  return args;
}

export function cliProcessTimeoutMs(input = {}) {
  const sec = Number.isInteger(input.timeoutSec) && input.timeoutSec > 0
    ? Math.min(input.timeoutSec, MAX_CLI_TIMEOUT_SEC)
    : DEFAULT_CLI_TIMEOUT_SEC;
  return sec * 1000;
}

/** The playbook path of an `apply` argv, or undefined. */
export function applyPlaybookPath(argv) {
  if (argv[0] !== 'apply') return undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (APPLY_VALUE_FLAGS.has(a)) { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/**
 * `apply` must be dry-run first, on the same playbook bytes, in this server
 * session. A real write that skips the preflight is refused with the command
 * to run instead.
 */
export class ApplyGuard {
  constructor() { this.passed = new Set(); }

  static async fingerprint(path) {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async check(argv, cwd) {
    const given = applyPlaybookPath(argv);
    if (!given) return { kind: 'none' };
    const path = resolvePath(given, cwd);
    const dryRun = argv.includes('--dry-run');
    let hash;
    try { hash = await ApplyGuard.fingerprint(path); }
    catch (err) { throw new Error(`cannot read playbook ${path}: ${err.message}`); }
    if (dryRun) return { kind: 'dry-run', hash };
    if (!this.passed.has(hash)) {
      throw new Error(`apply ${path} has no passing --dry-run of these exact bytes in this session. Run argv ["apply", "${path}", "--dry-run"] first; any edit to the playbook needs a new dry-run.`);
    }
    return { kind: 'write', hash };
  }

  record(check, ok) {
    if (check.kind === 'dry-run' && ok) this.passed.add(check.hash);
  }
}

export function shapeCliResult(execution, args) {
  const shaped = { ...execution, command: ['easyeda', ...args].join(' ') };
  const raw = execution.ok ? execution.result : execution.error?.stdout;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  if (text.length > MAX_STDOUT_CHARS) {
    const head = text.slice(0, MAX_STDOUT_CHARS);
    if (execution.ok) shaped.result = head; else shaped.error = { ...execution.error, stdout: head };
    shaped.truncated = { totalChars: text.length, keptChars: MAX_STDOUT_CHARS, hint: 'write large output to a file (e.g. --out <path>) and read the file' };
  }
  return shaped;
}

/** Resolve a path the way the CLI child (run in `cwd`) will see it. */
export function resolvePath(path, cwd) {
  return isAbsolute(path) || !cwd ? path : resolve(cwd, path);
}

/** Pixel width an SVG render is rasterized to before it is returned. */
export const SVG_RASTER_WIDTH = 1600;

async function rasterizeSvg(path, width) {
  let Resvg;
  try { ({ Resvg } = await import('@resvg/resvg-js')); }
  catch (err) { throw new Error(`SVG needs @resvg/resvg-js (npm install in mcp/): ${err.message}`); }
  const svg = await readFile(path, 'utf8');
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
    font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
  }).render().asPng();
  return Buffer.from(png);
}

export async function readImageContent(path, { svgWidth = SVG_RASTER_WIDTH } = {}) {
  if (extname(path).toLowerCase() === '.svg') {
    // PCB/schematic renders are SVG; image content must be a raster format.
    const png = await rasterizeSvg(path, svgWidth);
    if (png.length > MAX_IMAGE_BYTES) throw new Error(`rasterized ${path} is ${png.length} bytes; lower svgWidth`);
    return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  }
  const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`not an image file: ${path}`);
  const info = await stat(path);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`image ${path} is ${info.size} bytes (> ${MAX_IMAGE_BYTES}); render a smaller region or lower --scale`);
  }
  const data = (await readFile(path)).toString('base64');
  return { type: 'image', data, mimeType };
}

export function buildCliHelpArgs(input = {}) {
  const args = ['cli-tree'];
  const prefix = Array.isArray(input.path) ? input.path.join(' ') : (input.path || '');
  if (prefix.trim()) args.push('--prefix', prefix.trim());
  if (input.long) args.push('--long');
  return args;
}
