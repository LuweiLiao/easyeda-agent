/// <reference types="@jlceda/pro-api-types" />
import { armDeadline } from './deadlines';
import { readResponseContext, mutationContextError } from './eda-context';
import { ActionError, ErrorCodes, type ActionResult } from './protocol';
import { blobToBase64, newArtifactId } from './util';

export const MAX_GERBER_BYTES = 20 * 1024 * 1024;
export const GERBER_EXPORT_TIMEOUT_MS = 150_000;

/**
 * Export the active PCB's fabrication package through official beta
 * getGerberFile. Only the file name is passed, so the host applies its
 * one-click defaults (mm, 4:5, layers actually used + drill layers, JLC
 * objects) — the same package the editor's 一键导出 would hand the fab.
 * The returned file (normally a ZIP) is preserved byte for byte; the CLI
 * checks its contents. Read-only: no save, no DRC, no design change.
 */
export async function pcbExportGerber(payload: Record<string, unknown>): Promise<ActionResult> {
	if (Object.keys(payload).some(k => k !== 'fileName')) throw new ActionError(ErrorCodes.MISSING_PAYLOAD_FIELD, 'Unknown Gerber export option.');
	const fileName = payload.fileName ?? 'gerber';
	if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 128 || /[\\/\x00-\x1f]/.test(fileName)) {
		throw new ActionError(ErrorCodes.MISSING_PAYLOAD_FIELD, 'fileName must be a basename.');
	}
	const before = await readResponseContext();
	if (before.documentType !== 'pcb' || !before.projectUuid || !before.documentUuid) {
		throw new ActionError(ErrorCodes.INVALID_STATE, 'Activate the target PCB before exporting Gerber.');
	}
	if (typeof eda.pcb_ManufactureData?.getGerberFile !== 'function') {
		throw new ActionError(ErrorCodes.EDA_API_UNAVAILABLE, 'This host does not expose pcb_ManufactureData.getGerberFile.');
	}
	let file: File | undefined;
	try {
		file = await new Promise<File | undefined>((resolve, reject) => {
			const handle = armDeadline(GERBER_EXPORT_TIMEOUT_MS, () => reject(new ActionError(ErrorCodes.EDA_CALL_FAILED,
				`Gerber export did not settle within ${GERBER_EXPORT_TIMEOUT_MS}ms. Nothing was written; retry once the editor is idle.`)));
			eda.pcb_ManufactureData.getGerberFile(fileName).then(
				(v) => { handle.cancel(); resolve(v); },
				(e) => { handle.cancel(); reject(e); },
			);
		});
	}
	catch (err) {
		if (err instanceof ActionError) throw err;
		throw new ActionError(ErrorCodes.EDA_CALL_FAILED, `Official Gerber export failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	finally {
		// ManufactureData exports leak their progress toast (see schematic export).
		setTimeout(() => {
			try { eda.sys_LoadingAndProgressBar.destroyProgressBar(); } catch { /* best-effort */ }
			try { eda.sys_LoadingAndProgressBar.destroyLoading(); } catch { /* best-effort */ }
		}, 400);
	}
	if (!file || !file.size) throw new ActionError(ErrorCodes.EDA_CALL_FAILED, 'Official Gerber export returned no file. Check that the PCB has a board outline and placed parts.');
	if (file.size > MAX_GERBER_BYTES) throw new ActionError(ErrorCodes.EDA_CALL_FAILED, `Official Gerber export is ${file.size} bytes, exceeding the 20 MiB transport limit.`, JSON.stringify({ size: file.size, limit: MAX_GERBER_BYTES }));
	const drift = mutationContextError(before, await readResponseContext());
	if (drift) throw new ActionError(ErrorCodes.INVALID_STATE, `Gerber export target changed: ${drift}. No artifact accepted.`);
	const id = newArtifactId();
	return { result: { artifactId: id, fileName: file.name || fileName, size: file.size, exportContext: before, options: 'host-one-click-defaults' },
		artifacts: [{ id, kind: 'pcb_gerber', fileName: file.name || fileName,
			mimeType: file.type || 'application/zip', inlineBase64: await blobToBase64(file) }],
		warnings: ['The package is what the fab receives; this export does not prove it is correct. Check it independently of EasyEDA.'] };
}
