import { MarkdownView, Notice, Platform, Plugin, TFile, requestUrl } from "obsidian";
import { DEFAULT_SETTINGS, GitHubSyncSettingTab, GitHubSyncSettings } from "./settings";
import { HttpFn, RestGitHubApi } from "./github";
import { ObsidianVaultIO } from "./vaultio";
import { IgnoreMatcher, buildIgnorePatterns } from "./ignore";
import { LocalChange, PullResult, PushResult, SyncEngine, SyncState, emptyState } from "./engine";
import { hasConflictMarkers } from "./merge";
import { tryDecodeText } from "./hash";
import { ChangesModal, CommitModal } from "./ui/CommitModal";
import { ConflictHost, ConflictListModal } from "./ui/ConflictModals";

type Trigger = "manual" | "auto";

const pad = (n: number) => String(n).padStart(2, "0");
const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const formatTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		contentType: req.headers["Content-Type"],
		throw: false,
	});
	return { status: res.status, text: res.text };
};

export default class GitHubSyncPlugin extends Plugin {
	settings!: GitHubSyncSettings;
	private state: SyncState | null = null;
	private running = false;
	private autoSyncHandle: number | null = null;
	private ribbonEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "GitHub: Sync", () => this.runSync("manual"));
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("ghsync-statusbar");
			this.statusEl.addEventListener("click", () => this.showChanges());
		}

		this.addCommand({ id: "sync", name: "Sync (pull + push)", icon: "refresh-cw", callback: () => this.runSync("manual") });
		this.addCommand({ id: "pull", name: "Pull", icon: "download", callback: () => this.runPull("manual") });
		this.addCommand({ id: "commit-push", name: "Commit & Push", icon: "upload", callback: () => this.commitAndPush() });
		this.addCommand({ id: "show-changes", name: "Show changes", icon: "list", callback: () => this.showChanges() });
		this.addCommand({ id: "resolve-conflicts", name: "Resolve conflicts", icon: "git-merge", callback: () => this.openConflicts() });
		this.addCommand({
			id: "mark-resolved",
			name: "Mark file as resolved",
			icon: "check",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const ok = !!file && !!this.state?.conflicts.some((c) => c.path === file.path);
				if (ok && !checking) this.markActiveResolved(file!);
				return ok;
			},
		});

		this.app.workspace.onLayoutReady(() => {
			if (!this.isConfigured()) return;
			if (this.settings.syncOnStartup) this.runSync("auto");
			else if (this.settings.pullOnStartup) this.runPull("auto");
		});
		this.scheduleAutoSync();
		this.updateStatus();
	}

	onunload(): void {
		if (this.autoSyncHandle !== null) window.clearInterval(this.autoSyncHandle);
	}

	// ---------- settings & state ----------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private get pluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	private get statePath(): string {
		return `${this.pluginDir}/sync-state.json`;
	}

	private get repoKey(): string {
		const s = this.settings;
		return `${s.owner}/${s.repo}@${s.branch}:${s.remoteFolder}`;
	}

	private async loadState(): Promise<SyncState> {
		if (this.state && this.state.repoKey === this.repoKey) return this.state;
		let loaded: SyncState | null = null;
		try {
			if (await this.app.vault.adapter.exists(this.statePath)) {
				loaded = JSON.parse(await this.app.vault.adapter.read(this.statePath));
			}
		} catch (e) {
			console.error("[github-sync] failed to read state", e);
		}
		this.state = loaded && loaded.repoKey === this.repoKey ? loaded : emptyState(this.repoKey);
		return this.state;
	}

	private saveState = async (s: SyncState): Promise<void> => {
		this.state = s;
		await this.app.vault.adapter.write(this.statePath, JSON.stringify(s));
		this.updateStatus();
	};

	async resetState(): Promise<void> {
		this.state = emptyState(this.repoKey);
		await this.saveState(this.state);
	}

	isConfigured(): boolean {
		const s = this.settings;
		return !!(s.token && s.owner && s.repo && s.branch);
	}

	makeApi(): RestGitHubApi {
		const s = this.settings;
		return new RestGitHubApi({ token: s.token, owner: s.owner, repo: s.repo, branch: s.branch }, obsidianHttp);
	}

	private async makeEngine(): Promise<SyncEngine> {
		const s = this.settings;
		const patterns = buildIgnorePatterns({
			configDir: this.app.vault.configDir,
			pluginDir: this.pluginDir,
			syncConfigDir: s.syncConfigDir,
			userPatterns: s.ignorePatterns.split("\n"),
		});
		const author = s.authorName && s.authorEmail ? { name: s.authorName, email: s.authorEmail } : undefined;
		return new SyncEngine(this.makeApi(), new ObsidianVaultIO(this.app), await this.loadState(), this.saveState, {
			remoteFolder: s.remoteFolder,
			ignore: new IgnoreMatcher(patterns),
			conflictMode: s.conflictMode,
			author,
		});
	}

	scheduleAutoSync(): void {
		if (this.autoSyncHandle !== null) window.clearInterval(this.autoSyncHandle);
		this.autoSyncHandle = null;
		const minutes = this.settings.autoSyncMinutes;
		if (minutes > 0) {
			this.autoSyncHandle = window.setInterval(() => this.runSync("auto"), minutes * 60_000);
			this.registerInterval(this.autoSyncHandle);
		}
	}

	private commitMessage(changes: LocalChange[], template = this.settings.commitTemplate): string {
		const device =
			this.settings.deviceName || (Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : "desktop");
		return template
			.replace(/{{date}}/g, `${formatDate(new Date())} ${formatTime(new Date())}`)
			.replace(/{{device}}/g, device)
			.replace(/{{count}}/g, String(changes.length));
	}

	// ---------- running operations ----------

	private async run<T>(label: string, trigger: Trigger, fn: (engine: SyncEngine, progress: Notice | null) => Promise<T>): Promise<T | null> {
		if (!this.isConfigured()) {
			if (trigger === "manual") new Notice("GitHub Sync: укажите токен, владельца и репозиторий в настройках.");
			return null;
		}
		if (this.running) {
			if (trigger === "manual") new Notice("GitHub Sync: синхронизация уже идёт…");
			return null;
		}
		this.running = true;
		this.ribbonEl?.addClass("ghsync-spinning");
		this.statusEl?.setText("GitHub: ⟳");
		const progress = trigger === "manual" ? new Notice(`GitHub: ${label}…`, 0) : null;
		try {
			const engine = await this.makeEngine();
			engine.onProgress = (m) => progress?.setMessage(`GitHub: ${m}`);
			return await fn(engine, progress);
		} catch (e) {
			console.error("[github-sync]", e);
			new Notice(`GitHub Sync — ошибка:\n${(e as Error).message}`, 10000);
			return null;
		} finally {
			progress?.hide();
			this.running = false;
			this.ribbonEl?.removeClass("ghsync-spinning");
			this.updateStatus();
		}
	}

	private report(trigger: Trigger, pull: PullResult | null, push: PushResult | null): void {
		const parts: string[] = [];
		if (pull) {
			const down = pull.downloaded.length + pull.deletedLocal.length;
			if (down) parts.push(`↓ ${down}`);
			if (pull.merged.length) parts.push(`слито ${pull.merged.length}`);
		}
		if (push) {
			const up = push.uploaded.length + push.deletedRemote.length;
			if (up) parts.push(`↑ ${up}`);
		} else if (pull && pull.pendingLocal) parts.push(`ждут push: ${pull.pendingLocal}`);
		if (pull?.skippedLarge.length) parts.push(`пропущено >50 МБ: ${pull.skippedLarge.length}`);

		const conflicts = pull?.conflicts.length ?? 0;
		if (conflicts) {
			const n = new Notice(`GitHub: конфликтов — ${conflicts}. Нажмите, чтобы разрешить.`, 15000);
			n.noticeEl.addEventListener("click", () => this.openConflicts());
			if (trigger === "manual" && this.settings.conflictMode === "modal") this.openConflicts();
		}
		if (parts.length) new Notice(`GitHub: ${parts.join(", ")}`);
		else if (trigger === "manual" && !conflicts) new Notice("GitHub: всё синхронизировано ✓");
	}

	async runPull(trigger: Trigger): Promise<void> {
		await this.run("pull", trigger, async (engine) => {
			const pull = await engine.pull();
			this.report(trigger, pull, null);
		});
	}

	async runSync(trigger: Trigger, message?: string): Promise<void> {
		if (trigger === "manual" && this.settings.askCommitMessage && message === undefined) {
			return this.commitAndPush();
		}
		await this.run("sync", trigger, async (engine) => {
			const { pull, push } = await engine.sync((changes) => message || this.commitMessage(changes));
			this.report(trigger, pull, push);
		});
	}

	/** Shows the pending changes with an editable commit message, then syncs. */
	async commitAndPush(): Promise<void> {
		const status = await this.run("проверка изменений", "manual", (engine) => engine.status());
		if (!status) return;
		if (status.conflicts.length) {
			new Notice("Сначала разрешите конфликты.");
			this.openConflicts();
			return;
		}
		if (!status.changes.length) {
			// Nothing local; still pull so the user gets remote changes.
			return this.runSync("manual", "");
		}
		new CommitModal(this.app, status.changes, this.commitMessage(status.changes), (message) => {
			if (message !== null) this.runSync("manual", message);
		}).open();
	}

	async showChanges(): Promise<void> {
		const status = await this.run("проверка изменений", "manual", (engine) => engine.status());
		if (!status) return;
		new ChangesModal(this.app, status.changes, status.conflicts, {
			push: () => this.commitAndPush(),
			resolve: () => this.openConflicts(),
		}).open();
	}

	// ---------- conflicts ----------

	private conflictHost(): ConflictHost {
		const withEngine = async <T>(fn: (e: SyncEngine) => Promise<T>): Promise<T> => fn(await this.makeEngine());
		return {
			conflicts: () => this.state?.conflicts ?? [],
			loadSides: (c) => withEngine((e) => e.loadConflictSides(c)),
			resolve: (path, content) => withEngine((e) => e.resolveConflict(path, content)),
			writeFile: (path, content) => new ObsidianVaultIO(this.app).write(path, content),
			writeMarkers: (path) => withEngine((e) => e.writeMarkers(path)),
			openFile: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			},
			afterResolve: () => {
				if (this.state && this.state.conflicts.length === 0) {
					const n = new Notice("Все конфликты разрешены. Нажмите, чтобы выполнить Commit & Push.", 10000);
					n.noticeEl.addEventListener("click", () => this.commitAndPush());
				}
			},
		};
	}

	async openConflicts(): Promise<void> {
		await this.loadState();
		if (!this.state?.conflicts.length) {
			new Notice("GitHub: конфликтов нет.");
			return;
		}
		new ConflictListModal(this.app, this.conflictHost()).open();
	}

	private async markActiveResolved(file: TFile): Promise<void> {
		// Make sure pending editor changes are on disk before reading.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file === file) await view.save();
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const text = tryDecodeText(bytes);
		if (text !== null && hasConflictMarkers(text)) {
			new Notice("В файле ещё остались маркеры <<<<<<< ======= >>>>>>>.");
			return;
		}
		try {
			const engine = await this.makeEngine();
			await engine.resolveConflict(file.path, bytes);
			new Notice(`Разрешено: ${file.path}`);
			this.conflictHost().afterResolve();
		} catch (e) {
			new Notice((e as Error).message, 8000);
		}
	}

	private updateStatus(): void {
		if (!this.statusEl || this.running) return;
		const s = this.state;
		if (!this.isConfigured()) this.statusEl.setText("GitHub: не настроен");
		else if (s?.conflicts.length) this.statusEl.setText(`GitHub: ⚠ ${s.conflicts.length} конфл.`);
		else if (s?.lastSync) this.statusEl.setText(`GitHub: ✓ ${formatTime(new Date(s.lastSync))}`);
		else this.statusEl.setText("GitHub: —");
	}
}
