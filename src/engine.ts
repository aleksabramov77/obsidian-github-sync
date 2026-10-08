import type { Author, GitHubApi, RemoteEntry, TreeEntryInput } from "./github";
import type { VaultIO } from "./vaultio";
import { gitBlobSha, tryDecodeText, utf8Encode } from "./hash";
import { IgnoreMatcher } from "./ignore";
import { renderMerge, threeWayMerge } from "./merge";

export const MAX_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_MODE = "100644";

export type ConflictType =
	/** Both sides changed the file differently (or both created it). */
	| "both-modified"
	/** Deleted on this device, changed on GitHub. */
	| "deleted-local"
	/** Changed on this device, deleted on GitHub. */
	| "deleted-remote";

export interface Conflict {
	path: string;
	type: ConflictType;
	baseSha?: string;
	remoteSha?: string;
	binary: boolean;
	/** The local file currently contains <<<<<<< markers written by the plugin. */
	markersWritten?: boolean;
}

export interface SyncState {
	version: 1;
	/** owner/repo@branch:subfolder — state is discarded when it changes. */
	repoKey: string;
	baseCommit: string | null;
	/** path → blob sha both sides agreed on at the last sync. */
	baseFiles: Record<string, string>;
	modes: Record<string, string>;
	hashCache: Record<string, { mtime: number; size: number; sha: string }>;
	conflicts: Conflict[];
	lastSync?: number;
}

export function emptyState(repoKey: string): SyncState {
	return { version: 1, repoKey, baseCommit: null, baseFiles: {}, modes: {}, hashCache: {}, conflicts: [] };
}

export interface EngineOptions {
	/** Folder inside the repository that maps to the vault root ("" = repo root). */
	remoteFolder: string;
	ignore: IgnoreMatcher;
	conflictMode: "modal" | "markers";
	author?: Author;
}

export interface PullResult {
	downloaded: string[];
	deletedLocal: string[];
	merged: string[];
	conflicts: Conflict[];
	pendingLocal: number;
	skippedLarge: string[];
}

export interface PushResult {
	uploaded: string[];
	deletedRemote: string[];
	commit: string | null;
}

export interface LocalChange {
	path: string;
	kind: "added" | "modified" | "deleted";
}

export class SyncError extends Error {}

interface LocalSnapshot {
	files: Map<string, string>;
	skippedLarge: string[];
}

interface RemoteSnapshot {
	head: string | null;
	empty: boolean;
	treeSha: string | null;
	files: Map<string, RemoteEntry>;
}

/** `dir/note.md` → `dir/note (<label>).md`, adding a counter if that name is taken. */
export async function conflictCopyPath(
	path: string,
	label: string,
	exists: (p: string) => Promise<boolean>,
): Promise<string> {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	let candidate = `${stem} (${label})${ext}`;
	for (let i = 2; await exists(candidate); i++) candidate = `${stem} (${label} ${i})${ext}`;
	return candidate;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

export class SyncEngine {
	onProgress: (message: string) => void = () => {};

	constructor(
		private gh: GitHubApi,
		private io: VaultIO,
		public state: SyncState,
		private saveState: (s: SyncState) => Promise<void>,
		private opts: EngineOptions,
	) {}

	private get prefix(): string {
		const f = this.opts.remoteFolder.replace(/^\/+|\/+$/g, "");
		return f ? f + "/" : "";
	}

	private isIgnored(path: string): boolean {
		return this.opts.ignore.ignores(path);
	}

	// ---------- snapshots ----------

	async scanLocal(): Promise<LocalSnapshot> {
		this.onProgress("Сканирование файлов…");
		const infos = await this.io.list((dir) => this.isIgnored(dir + "/"));
		const files = new Map<string, string>();
		const skippedLarge: string[] = [];
		const newCache: SyncState["hashCache"] = {};
		for (const info of infos) {
			if (this.isIgnored(info.path)) continue;
			if (info.size > MAX_FILE_SIZE) {
				skippedLarge.push(info.path);
				continue;
			}
			const cached = this.state.hashCache[info.path];
			let sha: string;
			if (cached && cached.mtime === info.mtime && cached.size === info.size) sha = cached.sha;
			else sha = await gitBlobSha(await this.io.read(info.path));
			newCache[info.path] = { mtime: info.mtime, size: info.size, sha };
			files.set(info.path, sha);
		}
		this.state.hashCache = newCache;
		return { files, skippedLarge };
	}

	async scanRemote(): Promise<RemoteSnapshot> {
		this.onProgress("Чтение GitHub…");
		const head = await this.gh.getHead();
		const files = new Map<string, RemoteEntry>();
		if (head.kind !== "ok") return { head: null, empty: head.kind === "empty", treeSha: null, files };
		const treeSha = await this.gh.getCommitTreeSha(head.sha);
		const prefix = this.prefix;
		for (const e of await this.gh.getTree(treeSha)) {
			if (prefix && !e.path.startsWith(prefix)) continue;
			const path = e.path.slice(prefix.length);
			if (!path || this.isIgnored(path)) continue;
			files.set(path, { ...e, path });
		}
		return { head: head.sha, empty: false, treeSha, files };
	}

	/** Base entries that are not ignored (ignored paths are dropped from the base). */
	private effectiveBase(): Map<string, string> {
		const base = new Map<string, string>();
		for (const [p, sha] of Object.entries(this.state.baseFiles)) {
			if (!this.isIgnored(p)) base.set(p, sha);
		}
		return base;
	}

	localChanges(local: Map<string, string>): LocalChange[] {
		const base = this.effectiveBase();
		const out: LocalChange[] = [];
		for (const [p, sha] of local) {
			const b = base.get(p);
			if (b === undefined) out.push({ path: p, kind: "added" });
			else if (b !== sha) out.push({ path: p, kind: "modified" });
		}
		for (const p of base.keys()) if (!local.has(p)) out.push({ path: p, kind: "deleted" });
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	async status(): Promise<{ changes: LocalChange[]; conflicts: Conflict[] }> {
		const local = await this.scanLocal();
		await this.saveState(this.state);
		return { changes: this.localChanges(local.files), conflicts: this.state.conflicts };
	}

	// ---------- pull ----------

	async pull(): Promise<PullResult> {
		const remote = await this.scanRemote();
		const local = await this.scanLocal();
		const base = this.effectiveBase();
		const result: PullResult = {
			downloaded: [],
			deletedLocal: [],
			merged: [],
			conflicts: [],
			pendingLocal: 0,
			skippedLarge: local.skippedLarge,
		};
		if (!remote.head) {
			// Nothing on GitHub yet: everything local is a pending change.
			result.pendingLocal = this.localChanges(local.files).length;
			await this.saveState(this.state);
			return result;
		}

		const prevConflicts = new Map(this.state.conflicts.map((c) => [c.path, c]));
		const newBase: Record<string, string> = {};
		const conflicts: Conflict[] = [];
		const toDownload: RemoteEntry[] = [];
		const toDelete: string[] = [];
		const toMerge: { path: string; b?: string; r: RemoteEntry }[] = [];

		const paths = new Set<string>([...base.keys(), ...local.files.keys(), ...remote.files.keys()]);
		for (const p of paths) {
			if (local.skippedLarge.includes(p)) {
				const b = base.get(p);
				if (b) newBase[p] = b;
				continue;
			}
			const b = base.get(p);
			const l = local.files.get(p);
			const rEntry = remote.files.get(p);
			const r = rEntry?.sha;
			if (rEntry) this.state.modes[p] = rEntry.mode;

			if (l === r) {
				if (r) newBase[p] = r;
			} else if (l === b) {
				// Only GitHub changed.
				if (rEntry) toDownload.push(rEntry);
				else toDelete.push(p);
			} else if (r === b) {
				// Only this device changed — will be pushed.
				if (b) newBase[p] = b;
				result.pendingLocal++;
			} else {
				// Both changed.
				if (b) newBase[p] = b;
				const prev = prevConflicts.get(p);
				if (prev?.markersWritten && prev.remoteSha === r) {
					conflicts.push(prev);
				} else if (l !== undefined && rEntry) {
					toMerge.push({ path: p, b, r: rEntry });
				} else {
					conflicts.push({
						path: p,
						type: l === undefined ? "deleted-local" : "deleted-remote",
						baseSha: b,
						remoteSha: r,
						binary: false,
					});
				}
			}
		}

		const total = toDownload.length + toDelete.length + toMerge.length;
		let done = 0;
		const tick = () => this.onProgress(`Pull: ${++done}/${total}`);

		await mapLimit(toDownload, 4, async (e) => {
			const data = await this.gh.getBlob(e.sha);
			await this.io.write(e.path, data);
			newBase[e.path] = e.sha;
			result.downloaded.push(e.path);
			tick();
		});
		for (const p of toDelete) {
			await this.io.remove(p);
			delete this.state.modes[p];
			result.deletedLocal.push(p);
			tick();
		}
		for (const m of toMerge) {
			const outcome = await this.tryMerge(m.path, m.b, m.r, prevConflicts.get(m.path));
			if (outcome.merged) {
				newBase[m.path] = m.r.sha;
				result.merged.push(m.path);
				result.pendingLocal++;
			} else conflicts.push(outcome.conflict);
			tick();
		}

		this.state.baseFiles = newBase;
		this.state.baseCommit = remote.head;
		this.state.conflicts = conflicts;
		this.state.lastSync = Date.now();
		result.conflicts = conflicts;
		await this.saveState(this.state);
		return result;
	}

	private async tryMerge(
		path: string,
		baseSha: string | undefined,
		remote: RemoteEntry,
		prev: Conflict | undefined,
	): Promise<{ merged: true } | { merged: false; conflict: Conflict }> {
		const conflict: Conflict = { path, type: "both-modified", baseSha, remoteSha: remote.sha, binary: false };
		const [localBytes, remoteBytes, baseBytes] = await Promise.all([
			this.io.read(path),
			this.gh.getBlob(remote.sha),
			baseSha ? this.gh.getBlob(baseSha) : Promise.resolve(new Uint8Array()),
		]);
		const localText = tryDecodeText(localBytes);
		const remoteText = tryDecodeText(remoteBytes);
		const baseText = tryDecodeText(baseBytes);
		if (localText === null || remoteText === null || baseText === null) {
			return { merged: false, conflict: { ...conflict, binary: true } };
		}
		// The local file still has markers from an earlier round: leave it alone,
		// the user resolves it against the new remote version.
		if (prev?.markersWritten) return { merged: false, conflict };

		const merge = threeWayMerge(localText, baseText, remoteText);
		if (merge.conflictCount === 0) {
			await this.io.write(path, utf8Encode(renderMerge(merge.chunks)));
			return { merged: true };
		}
		if (this.opts.conflictMode === "markers") {
			await this.io.write(path, utf8Encode(renderMerge(merge.chunks)));
			return { merged: false, conflict: { ...conflict, markersWritten: true } };
		}
		return { merged: false, conflict };
	}

	// ---------- conflict resolution ----------

	async loadConflictSides(c: Conflict): Promise<{ local?: Uint8Array; remote?: Uint8Array; base?: Uint8Array }> {
		const [local, remote, base] = await Promise.all([
			(await this.io.exists(c.path)) ? this.io.read(c.path) : Promise.resolve(undefined),
			c.remoteSha ? this.gh.getBlob(c.remoteSha) : Promise.resolve(undefined),
			c.baseSha ? this.gh.getBlob(c.baseSha) : Promise.resolve(undefined),
		]);
		return { local, remote, base };
	}

	/**
	 * Applies the user's resolution locally and marks the conflict as resolved:
	 * the remote version becomes the new base, so the result is pushed as a local change.
	 * `content === null` means the file should not exist.
	 */
	async resolveConflict(path: string, content: Uint8Array | null): Promise<void> {
		const c = this.state.conflicts.find((x) => x.path === path);
		if (!c) throw new SyncError(`Нет конфликта для ${path}`);
		if (content === null) {
			if (await this.io.exists(path)) await this.io.remove(path);
		} else {
			await this.io.write(path, content);
		}
		if (c.remoteSha) this.state.baseFiles[path] = c.remoteSha;
		else delete this.state.baseFiles[path];
		this.state.conflicts = this.state.conflicts.filter((x) => x.path !== path);
		await this.saveState(this.state);
	}

	/**
	 * Resolves every conflict without losing anything: the GitHub version stays at the
	 * original path and this device's version is saved next to it as a copy.
	 * Deletions are undone in favour of the side that still has the file.
	 * Returns the paths of the created copies.
	 */
	async resolveAllKeepBoth(copyLabel: string): Promise<string[]> {
		const copies: string[] = [];
		for (const c of [...this.state.conflicts]) {
			this.onProgress(`Конфликты: ${c.path}`);
			const sides = await this.loadConflictSides(c);
			if (sides.local && sides.remote) {
				const path = await conflictCopyPath(c.path, copyLabel, (p) => this.io.exists(p));
				await this.io.write(path, sides.local);
				copies.push(path);
				await this.resolveConflict(c.path, sides.remote);
			} else {
				await this.resolveConflict(c.path, sides.local ?? sides.remote ?? null);
			}
		}
		return copies;
	}

	/** Writes conflict markers for a text conflict so it can be fixed in the editor. */
	async writeMarkers(path: string): Promise<void> {
		const c = this.state.conflicts.find((x) => x.path === path);
		if (!c || c.type !== "both-modified" || c.binary) throw new SyncError("Маркеры возможны только для текстовых файлов");
		const sides = await this.loadConflictSides(c);
		const dec = (b?: Uint8Array) => (b ? tryDecodeText(b) ?? "" : "");
		const merge = threeWayMerge(dec(sides.local), dec(sides.base), dec(sides.remote));
		await this.io.write(path, utf8Encode(renderMerge(merge.chunks)));
		c.markersWritten = true;
		await this.saveState(this.state);
	}

	// ---------- push ----------

	async push(messageFor: (changes: LocalChange[]) => string): Promise<PushResult> {
		if (this.state.conflicts.length) {
			throw new SyncError(`Сначала разрешите конфликты (${this.state.conflicts.length}).`);
		}
		const head = await this.gh.getHead();
		const headSha = head.kind === "ok" ? head.sha : null;
		if (headSha !== this.state.baseCommit) {
			throw new SyncError("На GitHub есть новые изменения — сначала нужен pull.");
		}
		const local = await this.scanLocal();
		const changes = this.localChanges(local.files);
		const result: PushResult = { uploaded: [], deletedRemote: [], commit: null };
		if (!changes.length) {
			await this.saveState(this.state);
			return result;
		}

		const message = messageFor(changes);
		const upserts = changes.filter((c) => c.kind !== "deleted");
		const deletions = changes.filter((c) => c.kind === "deleted");
		const prefix = this.prefix;
		let parent = headSha;
		let pending = upserts;

		if (head.kind === "empty") {
			if (!upserts.length) return result;
			// An empty repo rejects Git Data API writes; seed it with one file via the Contents API.
			const first = upserts[0];
			this.onProgress("Инициализация репозитория…");
			parent = await this.gh.createFileInEmptyRepo(
				prefix + first.path,
				await this.io.read(first.path),
				message,
				this.opts.author,
			);
			this.state.baseFiles[first.path] = local.files.get(first.path)!;
			result.uploaded.push(first.path);
			pending = upserts.slice(1);
			if (!pending.length) {
				this.state.baseCommit = parent;
				result.commit = parent;
				await this.saveState(this.state);
				return result;
			}
		}

		let done = 0;
		const blobs = await mapLimit(pending, 4, async (c) => {
			const sha = await this.gh.createBlob(await this.io.read(c.path));
			this.onProgress(`Push: ${++done}/${pending.length}`);
			return { path: c.path, sha };
		});

		const entries: TreeEntryInput[] = blobs.map((b) => ({
			path: prefix + b.path,
			mode: this.state.modes[b.path] ?? DEFAULT_MODE,
			sha: b.sha,
		}));
		if (parent) {
			for (const d of deletions) entries.push({ path: prefix + d.path, mode: DEFAULT_MODE, sha: null });
		}

		this.onProgress("Создание коммита…");
		const baseTree = parent ? await this.gh.getCommitTreeSha(parent) : null;
		const tree = await this.gh.createTree(baseTree, entries);
		const commit = await this.gh.createCommit(message, tree, parent ? [parent] : [], this.opts.author);
		if (head.kind === "missing") await this.gh.createRef(commit);
		else await this.gh.updateRef(commit);

		for (const b of blobs) {
			this.state.baseFiles[b.path] = local.files.get(b.path)!;
			result.uploaded.push(b.path);
		}
		for (const d of deletions) {
			delete this.state.baseFiles[d.path];
			result.deletedRemote.push(d.path);
		}
		this.state.baseCommit = commit;
		this.state.lastSync = Date.now();
		result.commit = commit;
		await this.saveState(this.state);
		return result;
	}

	/** Pull, then push if there is something to push and no conflicts remain. */
	async sync(messageFor: (changes: LocalChange[]) => string): Promise<{ pull: PullResult; push: PushResult | null }> {
		const pull = await this.pull();
		if (pull.conflicts.length) return { pull, push: null };
		const push = await this.push(messageFor);
		return { pull, push };
	}
}
