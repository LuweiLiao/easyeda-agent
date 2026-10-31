/**
 * pcb-pour-rebuild.ts — budget-aware, per-pour copper re-pour.
 *
 * Why it exists (2026-10-31, GD32H757_FCU): the old handler re-poured every
 * pour in one loop, swallowed per-pour errors and only answered at the end. A
 * full-board rebuild (~54 pours) in a throttled/background tab outlived the
 * CLI's 20 s default, the daemon reported "connector did not respond", and the
 * caller could not tell what had actually been re-poured — it slept and
 * guessed, and every retry queued another full rebuild behind the first.
 *
 * Now each pour is reported on its own, and before starting the next pour the
 * loop checks the time the caller actually granted (request-budget). When the
 * remaining budget cannot cover the slowest pour seen so far, it stops and
 * returns the untouched ids as `pending` — a partial answer that arrives,
 * instead of a complete one that is lost. Re-run with primitiveIds=pending.
 */

/** The slice of IPCB_PrimitivePour this module needs. */
export interface RebuildablePour {
	getState_PrimitiveId(): string;
	getState_Net(): string;
	getState_Layer(): number;
	/** Native: resolves to the poured primitive, or undefined when nothing was poured. */
	rebuildCopperRegion(): Promise<unknown>;
}

export interface PourRebuildOptions {
	/** Only these pours (exact primitiveIds). Unknown ids go to notFound. */
	primitiveIds?: Array<string>;
	/** Only pours on these nets. */
	nets?: Array<string>;
	/** Milliseconds the caller still grants, or undefined when unbounded. */
	remainingMs?: () => number | undefined;
	now?: () => number;
}

export interface PourRebuildRow {
	primitiveId: string;
	net: string;
	layer: number | null;
	rebuilt: boolean;
	ms: number;
	error?: string;
}

export interface PourRebuildReport {
	/** Pours selected for this call (all pours when unfiltered). */
	pours: number;
	rebuilt: number;
	failed: number;
	/** false when the budget ran out — see pending. */
	complete: boolean;
	results: Array<PourRebuildRow>;
	/** Selected pours not attempted because the budget ran out. */
	pending: Array<string>;
	/** Requested primitiveIds that matched no pour. */
	notFound: Array<string>;
	warnings: Array<string>;
}

/** Never start a pour with less than this left, whatever the history says. */
export const POUR_REBUILD_MIN_HEADROOM_MS = 3_000;
/** Headroom = slowest pour so far × this factor. */
export const POUR_REBUILD_SLOWEST_FACTOR = 1.5;

function safe<T>(read: () => T, fallback: T): T {
	try { return read(); }
	catch { return fallback; }
}

export async function runPourRebuild(all: ReadonlyArray<RebuildablePour>, options: PourRebuildOptions = {}): Promise<PourRebuildReport> {
	const now = options.now ?? Date.now;
	const ids = options.primitiveIds ? new Set(options.primitiveIds) : undefined;
	const nets = options.nets && options.nets.length > 0 ? new Set(options.nets) : undefined;
	const selected = all.filter((pour) => {
		if (ids && !ids.has(safe(() => pour.getState_PrimitiveId(), ''))) return false;
		if (nets && !nets.has(safe(() => pour.getState_Net(), ''))) return false;
		return true;
	});
	const seen = new Set(all.map(pour => safe(() => pour.getState_PrimitiveId(), '')));
	const notFound = options.primitiveIds?.filter(id => !seen.has(id)) ?? [];

	const results: Array<PourRebuildRow> = [];
	const pending: Array<string> = [];
	let slowest = 0;
	for (const [index, pour] of selected.entries()) {
		const primitiveId = safe(() => pour.getState_PrimitiveId(), '');
		// Always attempt the first pour so a tight budget still makes progress.
		const remaining = options.remainingMs?.();
		const headroom = Math.max(POUR_REBUILD_MIN_HEADROOM_MS, slowest * POUR_REBUILD_SLOWEST_FACTOR);
		if (index > 0 && remaining !== undefined && remaining < headroom) {
			pending.push(...selected.slice(index).map(p => safe(() => p.getState_PrimitiveId(), '')));
			break;
		}
		const row: PourRebuildRow = {
			primitiveId,
			net: safe(() => pour.getState_Net(), ''),
			layer: safe<number | null>(() => pour.getState_Layer(), null),
			rebuilt: false,
			ms: 0,
		};
		const started = now();
		try {
			row.rebuilt = Boolean(await pour.rebuildCopperRegion());
		}
		catch (err) {
			row.error = err instanceof Error ? err.message : String(err);
		}
		row.ms = now() - started;
		slowest = Math.max(slowest, row.ms);
		results.push(row);
	}

	const rebuilt = results.filter(r => r.rebuilt).length;
	const warnings: Array<string> = [];
	if (pending.length > 0) {
		warnings.push(`budget ran out after ${results.length}/${selected.length} pours; re-run with primitiveIds=pending (or a longer timeout) to finish`);
	}
	if (notFound.length > 0) warnings.push(`${notFound.length} requested primitiveId(s) matched no pour`);
	return {
		pours: selected.length,
		rebuilt,
		failed: results.length - rebuilt,
		complete: pending.length === 0,
		results,
		pending,
		notFound,
		warnings,
	};
}
