import { base64ToBytes, bytesToBase64 } from "./hash";

export interface RemoteEntry {
	path: string;
	sha: string;
	mode: string;
	size?: number;
}

export type HeadInfo =
	| { kind: "ok"; sha: string }
	/** Repository exists but has no commits at all. */
	| { kind: "empty" }
	/** Repository has commits but the configured branch does not exist. */
	| { kind: "missing" };

export interface TreeEntryInput {
	path: string;
	mode: string;
	/** null deletes the path from the base tree. */
	sha: string | null;
}

export interface Author {
	name: string;
	email: string;
}

/** The subset of the GitHub API the sync engine needs (faked in tests). */
export interface GitHubApi {
	getHead(): Promise<HeadInfo>;
	getCommitTreeSha(commitSha: string): Promise<string>;
	getTree(treeSha: string): Promise<RemoteEntry[]>;
	getBlob(sha: string): Promise<Uint8Array>;
	createBlob(content: Uint8Array): Promise<string>;
	createTree(baseTree: string | null, entries: TreeEntryInput[]): Promise<string>;
	createCommit(message: string, tree: string, parents: string[], author?: Author): Promise<string>;
	/** Fast-forward the branch. Throws NonFastForwardError if the branch moved. */
	updateRef(sha: string): Promise<void>;
	createRef(sha: string): Promise<void>;
	/** Contents API: the only way to create the very first commit in an empty repo. */
	createFileInEmptyRepo(path: string, content: Uint8Array, message: string, author?: Author): Promise<string>;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

export class NonFastForwardError extends Error {
	constructor() {
		super("Удалённая ветка изменилась во время push. Запустите Sync ещё раз.");
		this.name = "NonFastForwardError";
	}
}

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface RepoConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export class RestGitHubApi implements GitHubApi {
	private base: string;

	constructor(
		private cfg: RepoConfig,
		private http: HttpFn,
	) {
		this.base = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
		const res = await this.http({
			url: path.startsWith("https://") ? path : this.base + path,
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.cfg.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"Cache-Control": "no-cache",
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		let data: any = null;
		if (res.text) {
			try {
				data = JSON.parse(res.text);
			} catch {
				data = res.text;
			}
		}
		return { status: res.status, data };
	}

	private fail(what: string, status: number, data: any): never {
		const msg = (data && typeof data === "object" && data.message) || String(data ?? "");
		let hint = "";
		if (status === 401) hint = " (проверьте токен)";
		else if (status === 403) hint = " (нет прав или превышен лимит запросов)";
		else if (status === 404) hint = " (репозиторий не найден или нет доступа)";
		throw new GitHubError(`GitHub: ${what} — ${status} ${msg}${hint}`, status);
	}

	/** Login of the account the token belongs to. */
	async tokenOwner(): Promise<string> {
		const { status, data } = await this.call<any>("GET", `https://api.github.com/user?t=${Date.now()}`);
		if (status === 401) {
			throw new GitHubError("Токен недействителен (401). Скопируйте его заново целиком — он начинается с github_pat_.", 401);
		}
		if (status !== 200) this.fail("проверка токена", status, data);
		return data.login;
	}

	async checkAccess(): Promise<{
		fullName: string;
		private: boolean;
		canPush: boolean;
		defaultBranch: string;
		tokenOwner: string;
	}> {
		const login = await this.tokenOwner();
		// Cache-busting query param: an earlier 404 must not be served from the HTTP cache.
		const { status, data } = await this.call<any>("GET", `?t=${Date.now()}`);
		if (status === 404) {
			const repo = `${this.cfg.owner}/${this.cfg.repo}`;
			const why =
				login.toLowerCase() !== this.cfg.owner.toLowerCase()
					? `Токен создан под аккаунтом «${login}», а репозиторий принадлежит «${this.cfg.owner}». Создайте токен, войдя на GitHub как ${this.cfg.owner}.`
					: `Токен аккаунта «${login}» не видит ${repo}. Проверьте название репозитория и в настройках токена: Repository access → Only select repositories → ${this.cfg.repo}.`;
			throw new GitHubError(`GitHub: 404 для ${repo}. ${why}`, 404);
		}
		if (status !== 200) this.fail("доступ к репозиторию", status, data);
		return {
			tokenOwner: login,
			fullName: data.full_name,
			private: data.private,
			canPush: !!data.permissions?.push,
			defaultBranch: data.default_branch,
		};
	}

	async getHead(): Promise<HeadInfo> {
		// Cache-busting query param: mobile HTTP stacks may cache GETs.
		const { status, data } = await this.call<any>(
			"GET",
			`/git/ref/heads/${encodePath(this.cfg.branch)}?t=${Date.now()}`,
		);
		if (status === 200) return { kind: "ok", sha: data.object.sha };
		if (status === 409) return { kind: "empty" };
		if (status === 404) {
			// Distinguish "no such branch" from "no such repo".
			const repo = await this.call<any>("GET", `?t=${Date.now()}`);
			if (repo.status === 200) return { kind: "missing" };
			this.fail("доступ к репозиторию", repo.status, repo.data);
		}
		this.fail("чтение ветки", status, data);
	}

	async getCommitTreeSha(commitSha: string): Promise<string> {
		const { status, data } = await this.call<any>("GET", `/git/commits/${commitSha}`);
		if (status !== 200) this.fail("чтение коммита", status, data);
		return data.tree.sha;
	}

	async getTree(treeSha: string): Promise<RemoteEntry[]> {
		const { status, data } = await this.call<any>("GET", `/git/trees/${treeSha}?recursive=1`);
		if (status !== 200) this.fail("чтение дерева файлов", status, data);
		if (data.truncated) {
			throw new GitHubError("GitHub вернул усечённое дерево (слишком много файлов в репозитории).", 0);
		}
		return (data.tree as any[])
			.filter((e) => e.type === "blob" && e.mode !== "120000")
			.map((e) => ({ path: e.path, sha: e.sha, mode: e.mode, size: e.size }));
	}

	async getBlob(sha: string): Promise<Uint8Array> {
		const { status, data } = await this.call<any>("GET", `/git/blobs/${sha}`);
		if (status !== 200) this.fail("скачивание файла", status, data);
		if (data.encoding === "base64") return base64ToBytes(data.content);
		return new TextEncoder().encode(data.content);
	}

	async createBlob(content: Uint8Array): Promise<string> {
		const { status, data } = await this.call<any>("POST", "/git/blobs", {
			content: bytesToBase64(content),
			encoding: "base64",
		});
		if (status !== 201) this.fail("загрузка файла", status, data);
		return data.sha;
	}

	async createTree(baseTree: string | null, entries: TreeEntryInput[]): Promise<string> {
		const body: any = {
			tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
		};
		if (baseTree) body.base_tree = baseTree;
		const { status, data } = await this.call<any>("POST", "/git/trees", body);
		if (status !== 201) this.fail("создание дерева", status, data);
		return data.sha;
	}

	async createCommit(message: string, tree: string, parents: string[], author?: Author): Promise<string> {
		const body: any = { message, tree, parents };
		if (author) body.author = { name: author.name, email: author.email, date: new Date().toISOString() };
		const { status, data } = await this.call<any>("POST", "/git/commits", body);
		if (status !== 201) this.fail("создание коммита", status, data);
		return data.sha;
	}

	async updateRef(sha: string): Promise<void> {
		const { status, data } = await this.call<any>("PATCH", `/git/refs/heads/${encodePath(this.cfg.branch)}`, {
			sha,
			force: false,
		});
		if (status === 200) return;
		if (status === 422 || status === 409) throw new NonFastForwardError();
		this.fail("обновление ветки", status, data);
	}

	async createRef(sha: string): Promise<void> {
		const { status, data } = await this.call<any>("POST", "/git/refs", {
			ref: `refs/heads/${this.cfg.branch}`,
			sha,
		});
		if (status === 201) return;
		if (status === 422) throw new NonFastForwardError();
		this.fail("создание ветки", status, data);
	}

	async createFileInEmptyRepo(path: string, content: Uint8Array, message: string, author?: Author): Promise<string> {
		const body: any = { message, content: bytesToBase64(content), branch: this.cfg.branch };
		if (author) body.committer = { name: author.name, email: author.email };
		const { status, data } = await this.call<any>("PUT", `/contents/${encodePath(path)}`, body);
		if (status !== 201 && status !== 200) this.fail("инициализация репозитория", status, data);
		return data.commit.sha;
	}
}
