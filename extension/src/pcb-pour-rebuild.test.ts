import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAction } from './actions';
import { POUR_REBUILD_MIN_HEADROOM_MS, runPourRebuild, type RebuildablePour } from './pcb-pour-rebuild';
import { ActionError, ErrorCodes } from './protocol';

// rebuildCopperRegion resolves to the poured primitive (truthy) or undefined.
function pour(id: string, net: string, behaviour: { ms?: number; result?: unknown; error?: string } = {}, clock?: { t: number }): RebuildablePour & { calls: number } {
	const p = {
		calls: 0,
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_Layer: () => 1,
		rebuildCopperRegion: async () => {
			p.calls++;
			if (clock) clock.t += behaviour.ms ?? 0;
			if (behaviour.error) throw new Error(behaviour.error);
			return 'result' in behaviour ? behaviour.result : { poured: id };
		},
	};
	return p;
}

test('reports every pour and keeps per-pour failures', async () => {
	const pours = [pour('a', 'GND'), pour('b', 'GND', { error: 'engine busy' }), pour('c', '+3V3', { result: undefined })];
	const report = await runPourRebuild(pours);
	assert.equal(report.pours, 3);
	assert.equal(report.rebuilt, 1);
	assert.equal(report.failed, 2);
	assert.equal(report.complete, true);
	assert.deepEqual(report.pending, []);
	assert.equal(report.results[1].error, 'engine busy');
	assert.equal(report.results[2].rebuilt, false);
});

test('filters by nets and primitiveIds and names unknown ids', async () => {
	const pours = [pour('a', 'GND'), pour('b', '+3V3'), pour('c', 'GND')];
	const report = await runPourRebuild(pours, { nets: ['GND'], primitiveIds: ['c', 'zz'] });
	assert.deepEqual(report.results.map(r => r.primitiveId), ['c']);
	assert.deepEqual(report.notFound, ['zz']);
	assert.equal(pours[0].calls, 0);
	assert.equal(pours[1].calls, 0);
});

test('stops before the budget runs out and returns pending ids', async () => {
	const clock = { t: 0 };
	const deadline = 10_000;
	const pours = ['a', 'b', 'c', 'd'].map(id => pour(id, 'GND', { ms: 4_000 }, clock));
	const report = await runPourRebuild(pours, { now: () => clock.t, remainingMs: () => deadline - clock.t });
	// a: 0→4000 (6000 left ≥ 6000 headroom) b: →8000 (2000 left) stop.
	assert.deepEqual(report.results.map(r => r.primitiveId), ['a', 'b']);
	assert.deepEqual(report.pending, ['c', 'd']);
	assert.equal(report.complete, false);
	assert.equal(pours[2].calls, 0);
	assert.match(report.warnings[0], /primitiveIds=pending/);
});

test('always attempts the first pour even with no budget left', async () => {
	const pours = [pour('a', 'GND'), pour('b', 'GND')];
	const report = await runPourRebuild(pours, { remainingMs: () => POUR_REBUILD_MIN_HEADROOM_MS - 1 });
	assert.deepEqual(report.results.map(r => r.primitiveId), ['a']);
	assert.deepEqual(report.pending, ['b']);
});

function withHost(visibility: string, run: () => Promise<void>) {
	const globals = globalThis as any;
	const previous = { eda: globals.eda, window: globals.window };
	let drcCalls = 0;
	globals.window = { document: { visibilityState: visibility } };
	globals.eda = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'p' }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'd', documentType: 3 }) },
		pcb_Drc: { check: async () => { drcCalls++; return []; } },
		pcb_PrimitivePour: { getAll: async () => [pour('a', 'GND')] },
	};
	return run().finally(() => {
		globals.eda = previous.eda;
		if (previous.window === undefined) delete globals.window; else globals.window = previous.window;
	}).then(() => drcCalls);
}

test('pcb.drc.check refuses a hidden page unless allowHidden', async () => {
	const calls = await withHost('hidden', async () => {
		await assert.rejects(runAction('pcb.drc.check', {}),
			(e: unknown) => e instanceof ActionError && e.code === ErrorCodes.PRECONDITION_REFUSED && /foreground/.test(e.message));
		await runAction('pcb.drc.check', { allowHidden: true });
	});
	assert.equal(calls, 1);
});

test('pcb.pour.rebuild warns on a hidden page but still runs', async () => {
	await withHost('hidden', async () => {
		const { result }: any = await runAction('pcb.pour.rebuild', {});
		assert.equal(result.rebuilt, 1);
		assert.equal(result.pageVisibility, 'hidden');
		assert.ok(result.warnings.some((w: string) => /hidden/.test(w)));
	});
});
