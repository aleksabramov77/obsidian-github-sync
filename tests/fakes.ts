import type { Author, GitHubApi, HeadInfo, RemoteEntry, TreeEntryInput } from "../src/github";
import { NonFastForwardError } from "../src/github";
import type { LocalFileInfo, VaultIO } from "../src/vaultio";
import { gitBlobSha, tryDecodeText, utf8Encode } from "../src/hash";

type Tree = Map<string, { sha: string; mode: string }>;

/** In-memory GitHub repository implementing the subset of the API the engine uses. */
export class FakeGitHub implements GitHubApi {
	blobs = new Map<string, Uint8Array>();
	trees = new Map<string, Tree>();
	commits = new Map<string, { tree: string; parents: string[]; message: string }>();
	head: string | null = null;
	repoHasCommits = false;
	private counter = 0;
	calls: string[] = [];

	private id(prefix: string): string {
		return `${prefix}${(++this.counter).toString(16).padStart(8, "0")}`;
	}

	async getHead(): Promise<HeadInfo> {
		if (!this.repoHasCommits) return { kind: "empty" };
		return this.head ? { kind: "ok", sha: this.head } : { kind: "missing" };
	}
	async getCommitTreeSha(commitSha: string): Promise<string> {
		return this.commits.get(commitSha)!.tree;
	}
	async getTree(treeSha: string): Promise<RemoteEntry[]> {
		return [...this.trees.get(treeSha)!].map(([path, e]) => ({ path, ...e }));
	}
	async getBlob(sha: string): Promise<Uint8Array> {
		this.calls.push(`getBlob ${sha}`);
		const b = this.blobs.get(sha);
		if (!b) throw new Error(`no blob ${sha}`);
		return b;
	}
	async createBlob(content: Uint8Array): Promise<string> {
		const sha = await gitBlobSha(content);
		this.blobs.set(sha, content);
		return sha;
	}
	async createTree(baseTree: string | null, entries: TreeEntryInput[]): Promise<string> {
		const tree: Tree = new Map(baseTree ? this.trees.get(baseTree) : []);
		for (const e of entries) {
			if (e.sha === null) tree.delete(e.path);
			else tree.set(e.path, { sha: e.sha, mode: e.mode });
		}
		const sha = this.id("tree");
		this.trees.set(sha, tree);
		return sha;
	}
	async createCommit(message: string, tree: string, parents: string[], _author?: Author): Promise<string> {
		const sha = this.id("commit");
		this.commits.set(sha, { tree, parents, message });
		return sha;
	}
	async updateRef(sha: string): Promise<void> {
		const parents = this.commits.get(sha)!.parents;
		if (!parents.includes(this.head!)) throw new NonFastForwardError();
		this.head = sha;
	}
	async createRef(sha: string): Promise<void> {
		this.head = sha;
	}
	async createFileInEmptyRepo(path: string, content: Uint8Array, message: string): Promise<string> {
		const blob = await this.createBlob(content);
		const tree = await this.createTree(null, [{ path, mode: "100644", sha: blob }]);
		const commit = await this.createCommit(message, tree, []);
		this.head = commit;
		this.repoHasCommits = true;
		return commit;
	}

	// --- helpers simulating commits made elsewhere (web UI / other device) ---
	async commitFiles(files: Record<string, string | null>, message = "remote edit"): Promise<string> {
		const entries: TreeEntryInput[] = [];
		for (const [path, text] of Object.entries(files)) {
			entries.push({ path, mode: "100644", sha: text === null ? null : await this.createBlob(utf8Encode(text)) });
		}
		const base = this.head ? this.commits.get(this.head)!.tree : null;
		const tree = await this.createTree(base, entries);
		const commit = await this.createCommit(message, tree, this.head ? [this.head] : []);
		this.head = commit;
		this.repoHasCommits = true;
		return commit;
	}

	files(): Record<string, string> {
		const out: Record<string, string> = {};
		if (!this.head) return out;
		for (const [path, e] of this.trees.get(this.commits.get(this.head)!.tree)!) {
			out[path] = tryDecodeText(this.blobs.get(e.sha)!) ?? "<binary>";
		}
		return out;
	}
}

export class FakeVault implements VaultIO {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	private clock = 1;

	set(path: string, content: string | Uint8Array): void {
		const data = typeof content === "string" ? utf8Encode(content) : content;
		this.files.set(path, { data, mtime: ++this.clock });
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? new TextDecoder().decode(f.data) : undefined;
	}
	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [p] of this.files) out[p] = this.text(p)!;
		return out;
	}

	async list(skipDir: (path: string) => boolean): Promise<LocalFileInfo[]> {
		return [...this.files]
			.filter(([p]) => {
				const parts = p.split("/");
				for (let i = 1; i < parts.length; i++) if (skipDir(parts.slice(0, i).join("/"))) return false;
				return true;
			})
			.map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.length }));
	}
	async read(path: string): Promise<Uint8Array> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data;
	}
	async write(path: string, data: Uint8Array): Promise<void> {
		this.set(path, data);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
}
