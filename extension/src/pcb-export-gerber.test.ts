import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcbExportGerber, MAX_GERBER_BYTES } from './pcb-export-gerber';

function host(options: { drift?: boolean; missing?: boolean; empty?: boolean; oversized?: boolean; throws?: boolean; noApi?: boolean; sch?: boolean } = {}) {
	let calls = 0, reads = 0;
	const args: unknown[][] = [];
	(globalThis as any).EDMT_EditorDocumentType = { PCB: 3, SCHEMATIC_PAGE: 1 };
	(globalThis as any).eda = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid:'p' }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: options.drift && ++reads > 1 ? 'other' : 'b', documentType: options.sch ? 1 : 3, tabId:'t' }) },
		sys_LoadingAndProgressBar: { destroyProgressBar: () => {}, destroyLoading: () => {} },
		pcb_ManufactureData: options.noApi ? {} : { getGerberFile: async (...a: unknown[]) => {
			calls++; args.push(a);
			if (options.throws) throw new Error('host refused');
			if (options.missing) return undefined;
			if (options.oversized) return { size: MAX_GERBER_BYTES+1 };
			return new File([options.empty ? '' : 'PK-real-host-bytes'], 'Gerber_PCB.zip', { type: 'application/zip' });
		} },
	};
	return { calls: () => calls, args };
}

test('Gerber export uses host one-click defaults and preserves the official bytes', async () => {
	const h = host();
	const res = await pcbExportGerber({});
	assert.equal(h.calls(), 1);
	assert.deepEqual(h.args[0], ['gerber']);
	assert.equal(res.artifacts?.[0].kind, 'pcb_gerber');
	assert.equal(res.artifacts?.[0].fileName, 'Gerber_PCB.zip');
	assert.equal(Buffer.from(res.artifacts![0].inlineBase64!, 'base64').toString(), 'PK-real-host-bytes');
	assert.equal(res.result?.artifactId, res.artifacts?.[0].id);
	assert.equal(res.result?.options, 'host-one-click-defaults');
});

test('Gerber export passes a caller basename and rejects unknown options or paths', async () => {
	const h = host();
	await pcbExportGerber({ fileName: 'FCU' });
	assert.deepEqual(h.args[0], ['FCU']);
	for (const payload of [{ unit: 'inch' }, { fileName: '../x' }, { fileName: '' }, { fileName: 3 }]) {
		host(); await assert.rejects(pcbExportGerber(payload as any));
	}
});

test('Gerber export refuses non-PCB, drift, missing API and bad host files', async () => {
	for (const opts of [{ sch:true }, { drift:true }, { noApi:true }, { missing:true }, { empty:true }, { oversized:true }, { throws:true }]) {
		host(opts); await assert.rejects(pcbExportGerber({}));
	}
});
