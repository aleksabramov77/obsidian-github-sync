import { diff3Merge } from "node-diff3";

export type MergeChunk =
	| { kind: "ok"; lines: string[] }
	| { kind: "conflict"; local: string[]; base: string[]; remote: string[] };

export interface MergeResult {
	chunks: MergeChunk[];
	conflictCount: number;
}

export const MARKER_LOCAL = "<<<<<<< local (this device)";
export const MARKER_SEP = "=======";
export const MARKER_REMOTE = ">>>>>>> remote (GitHub)";

/** Line-based three-way merge (local vs base vs remote). */
export function threeWayMerge(local: string, base: string, remote: string): MergeResult {
	const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
		excludeFalseConflicts: true,
	});
	const chunks: MergeChunk[] = [];
	let conflictCount = 0;
	for (const r of regions) {
		if (r.ok) {
			const last = chunks[chunks.length - 1];
			if (last && last.kind === "ok") last.lines.push(...r.ok);
			else chunks.push({ kind: "ok", lines: [...r.ok] });
		} else if (r.conflict) {
			conflictCount++;
			chunks.push({
				kind: "conflict",
				local: r.conflict.a,
				base: r.conflict.o,
				remote: r.conflict.b,
			});
		}
	}
	return { chunks, conflictCount };
}

/**
 * Join chunks into text. `resolutions[i]` replaces the i-th conflict chunk;
 * a missing/null resolution is written with git-style conflict markers.
 */
export function renderMerge(chunks: MergeChunk[], resolutions: (string[] | null)[] = []): string {
	const out: string[] = [];
	let ci = 0;
	for (const c of chunks) {
		if (c.kind === "ok") {
			out.push(...c.lines);
			continue;
		}
		const res = resolutions[ci++];
		if (res) out.push(...res);
		else out.push(MARKER_LOCAL, ...c.local, MARKER_SEP, ...c.remote, MARKER_REMOTE);
	}
	return out.join("\n");
}

export function hasConflictMarkers(text: string): boolean {
	return /^<<<<<<< /m.test(text) && /^=======$/m.test(text) && /^>>>>>>> /m.test(text);
}

/** Parses a file containing git-style conflict markers back into chunks (base is unknown). */
export function parseConflictMarkers(text: string): MergeResult {
	const chunks: MergeChunk[] = [];
	let conflictCount = 0;
	let ok: string[] = [];
	let local: string[] | null = null;
	let remote: string[] | null = null;
	for (const line of text.split("\n")) {
		if (local === null && line.startsWith("<<<<<<< ")) {
			if (ok.length) chunks.push({ kind: "ok", lines: ok });
			ok = [];
			local = [];
		} else if (local !== null && remote === null && line === MARKER_SEP) {
			remote = [];
		} else if (local !== null && remote !== null && line.startsWith(">>>>>>> ")) {
			chunks.push({ kind: "conflict", local, base: [], remote });
			conflictCount++;
			local = remote = null;
		} else if (remote !== null) remote.push(line);
		else if (local !== null) local.push(line);
		else ok.push(line);
	}
	// Unterminated block: keep it as plain text.
	if (local !== null) {
		ok.push(MARKER_LOCAL, ...local);
		if (remote !== null) ok.push(MARKER_SEP, ...remote);
	}
	if (ok.length || !chunks.length) chunks.push({ kind: "ok", lines: ok });
	return { chunks, conflictCount };
}
