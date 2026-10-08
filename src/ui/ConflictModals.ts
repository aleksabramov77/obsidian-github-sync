import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { Conflict } from "../engine";
import { tryDecodeText, utf8Encode } from "../hash";
import { MergeChunk, MergeResult, hasConflictMarkers, parseConflictMarkers, renderMerge, threeWayMerge } from "../merge";

export interface ConflictHost {
	conflicts(): Conflict[];
	loadSides(c: Conflict): Promise<{ local?: Uint8Array; remote?: Uint8Array; base?: Uint8Array }>;
	resolve(path: string, content: Uint8Array | null): Promise<void>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	writeMarkers(path: string): Promise<void>;
	openFile(path: string): Promise<void>;
	/** Called after every resolution; e.g. offers to push when nothing is left. */
	afterResolve(): void;
}

const TYPE_LABEL: Record<Conflict["type"], string> = {
	"both-modified": "Изменён и здесь, и на GitHub",
	"deleted-local": "Удалён здесь, изменён на GitHub",
	"deleted-remote": "Изменён здесь, удалён на GitHub",
};

function conflictCopyPath(path: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	return `${stem} (GitHub conflict ${date})${ext}`;
}

export class ConflictListModal extends Modal {
	constructor(
		app: App,
		private host: ConflictHost,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("ghsync-modal");
		const conflicts = this.host.conflicts();
		this.setTitle(`Конфликты: ${conflicts.length}`);
		if (!conflicts.length) {
			contentEl.createDiv({ cls: "ghsync-muted", text: "Все конфликты разрешены 🎉" });
			return;
		}
		contentEl.createDiv({
			cls: "ghsync-muted",
			text: "Нажмите на файл, чтобы выбрать, какую версию оставить. Push станет доступен после разрешения всех конфликтов.",
		});
		for (const c of conflicts) {
			const row = contentEl.createDiv({ cls: "ghsync-conflict-item" });
			row.createDiv({ cls: "ghsync-conflict-path", text: c.path });
			row.createDiv({
				cls: "ghsync-muted",
				text: TYPE_LABEL[c.type] + (c.binary ? " · бинарный" : "") + (c.markersWritten ? " · маркеры в файле" : ""),
			});
			row.addEventListener("click", () => {
				new ConflictResolverModal(this.app, this.host, c, () => this.render()).open();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConflictResolverModal extends Modal {
	private resolutions: (string[] | null)[] = [];
	private merge: MergeResult | null = null;
	private busy = false;

	constructor(
		app: App,
		private host: ConflictHost,
		private conflict: Conflict,
		private onDone: () => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("ghsync-modal", "ghsync-resolver");
		this.setTitle(this.conflict.path);
		this.contentEl.createDiv({ cls: "ghsync-muted", text: "Загрузка версий…" });
		try {
			const sides = await this.host.loadSides(this.conflict);
			this.render(sides);
		} catch (e) {
			this.contentEl.empty();
			this.contentEl.createDiv({ cls: "ghsync-error", text: (e as Error).message });
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone();
	}

	private async finish(content: Uint8Array | null, extra?: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			if (extra) await extra();
			await this.host.resolve(this.conflict.path, content);
			new Notice(`Разрешено: ${this.conflict.path}`);
			this.close();
			this.host.afterResolve();
		} catch (e) {
			new Notice(`Ошибка: ${(e as Error).message}`, 8000);
		} finally {
			this.busy = false;
		}
	}

	private render(sides: { local?: Uint8Array; remote?: Uint8Array; base?: Uint8Array }): void {
		const { contentEl } = this;
		contentEl.empty();
		const c = this.conflict;
		contentEl.createDiv({ cls: "ghsync-muted", text: TYPE_LABEL[c.type] });

		const localText = sides.local ? tryDecodeText(sides.local) : null;
		const remoteText = sides.remote ? tryDecodeText(sides.remote) : null;
		const isText = c.type === "both-modified" && !c.binary && localText !== null && remoteText !== null;

		if (!isText) {
			this.renderWholeFileChoice(sides, localText, remoteText);
			return;
		}

		if (c.markersWritten && hasConflictMarkers(localText!)) {
			this.merge = parseConflictMarkers(localText!);
		} else {
			const baseText = sides.base ? tryDecodeText(sides.base) ?? "" : "";
			this.merge = threeWayMerge(localText!, baseText, remoteText!);
		}
		this.resolutions = this.merge.chunks.filter((ch) => ch.kind === "conflict").map(() => null);

		// File-level shortcuts.
		const top = new Setting(contentEl).setClass("ghsync-toolbar");
		top.addButton((b) =>
			b.setButtonText("Всё моё").onClick(() => this.finish(sides.local!)),
		);
		top.addButton((b) =>
			b.setButtonText("Всё с GitHub").onClick(() => this.finish(sides.remote!)),
		);
		top.addButton((b) =>
			b.setButtonText("Маркеры в редакторе").onClick(async () => {
				try {
					await this.host.writeMarkers(c.path);
					this.close();
					await this.host.openFile(c.path);
					new Notice("Исправьте блоки <<<<<<< ======= >>>>>>> и выполните команду «Mark file as resolved».", 10000);
				} catch (e) {
					new Notice((e as Error).message, 8000);
				}
			}),
		);

		if (this.merge.conflictCount === 0) {
			contentEl.createDiv({ text: "Изменения не пересекаются и сливаются автоматически." });
		} else {
			contentEl.createDiv({
				cls: "ghsync-muted",
				text: `Фрагментов с конфликтом: ${this.merge.conflictCount}. Остальные изменения уже объединены.`,
			});
		}

		const body = contentEl.createDiv({ cls: "ghsync-chunks" });
		const cards: HTMLElement[] = [];
		let saveBtn: ButtonComponent | null = null;
		const updateSave = () => {
			const left = this.resolutions.filter((r) => r === null).length;
			saveBtn?.setButtonText(left ? `Осталось: ${left}` : "Сохранить результат").setDisabled(left > 0);
			if (left) saveBtn?.buttonEl.removeClass("mod-cta");
			else saveBtn?.buttonEl.addClass("mod-cta");
		};

		let ci = 0;
		for (const chunk of this.merge.chunks) {
			if (chunk.kind === "ok") this.renderOkChunk(body, chunk.lines);
			else {
				const idx = ci++;
				cards.push(
					this.renderConflictChunk(body, chunk, idx, this.merge.conflictCount, () => {
						updateSave();
						const next = this.resolutions.findIndex((r) => r === null);
						if (next !== -1) cards[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
					}),
				);
			}
		}

		const footer = new Setting(contentEl).setClass("ghsync-footer");
		footer.addButton((b) => b.setButtonText("Позже").onClick(() => this.close()));
		footer.addButton((b) => {
			saveBtn = b;
			b.onClick(() => {
				if (this.resolutions.some((r) => r === null)) return;
				this.finish(utf8Encode(renderMerge(this.merge!.chunks, this.resolutions)));
			});
		});
		updateSave();
	}

	private renderOkChunk(parent: HTMLElement, lines: string[]): void {
		if (!lines.length || (lines.length === 1 && lines[0] === "")) return;
		const CONTEXT = 3;
		const details = parent.createEl("details", { cls: "ghsync-ok-chunk" });
		const preview =
			lines.length <= CONTEXT * 2
				? lines.join("\n")
				: [...lines.slice(0, CONTEXT), "…", ...lines.slice(-CONTEXT)].join("\n");
		details.createEl("summary", { text: `Без конфликта · ${lines.length} стр.` });
		details.createEl("pre", { cls: "ghsync-pre ghsync-pre-ok", text: lines.join("\n") });
		parent.createEl("pre", { cls: "ghsync-pre ghsync-pre-ok ghsync-ok-preview", text: preview });
		details.addEventListener("toggle", () => {
			details.nextElementSibling?.toggleClass("ghsync-hidden", details.open);
		});
	}

	private renderConflictChunk(
		parent: HTMLElement,
		chunk: Extract<MergeChunk, { kind: "conflict" }>,
		idx: number,
		total: number,
		onChange: () => void,
	): HTMLElement {
		const card = parent.createDiv({ cls: "ghsync-conflict-card" });
		const header = card.createDiv({ cls: "ghsync-conflict-header" });
		header.createSpan({ text: `Конфликт ${idx + 1}/${total}` });
		const status = header.createSpan({ cls: "ghsync-status", text: "не решён" });

		card.createDiv({ cls: "ghsync-side-label ghsync-side-local", text: "Моё (это устройство)" });
		card.createEl("pre", { cls: "ghsync-pre ghsync-pre-local", text: chunk.local.join("\n") || "(пусто)" });
		card.createDiv({ cls: "ghsync-side-label ghsync-side-remote", text: "GitHub" });
		card.createEl("pre", { cls: "ghsync-pre ghsync-pre-remote", text: chunk.remote.join("\n") || "(пусто)" });

		const editor = card.createEl("textarea", { cls: "ghsync-result ghsync-hidden" });
		const set = (lines: string[] | null) => {
			this.resolutions[idx] = lines;
			if (lines) {
				editor.value = lines.join("\n");
				editor.removeClass("ghsync-hidden");
				editor.rows = Math.min(12, Math.max(3, lines.length + 1));
				status.setText("решён");
				card.addClass("is-resolved");
			} else {
				status.setText("не решён");
				card.removeClass("is-resolved");
			}
			onChange();
		};
		editor.addEventListener("input", () => {
			this.resolutions[idx] = editor.value.split("\n");
		});

		const buttons = card.createDiv({ cls: "ghsync-choice-buttons" });
		const choice = (label: string, lines: () => string[]) => {
			const btn = buttons.createEl("button", { text: label });
			btn.addEventListener("click", () => set(lines()));
		};
		choice("Моё", () => [...chunk.local]);
		choice("GitHub", () => [...chunk.remote]);
		choice("Оба (моё ↑)", () => [...chunk.local, ...chunk.remote]);
		choice("Оба (GitHub ↑)", () => [...chunk.remote, ...chunk.local]);
		choice("Править", () => this.resolutions[idx] ?? [...chunk.local]);
		return card;
	}

	private renderWholeFileChoice(
		sides: { local?: Uint8Array; remote?: Uint8Array },
		localText: string | null,
		remoteText: string | null,
	): void {
		const { contentEl } = this;
		const c = this.conflict;
		const preview = (label: string, cls: string, bytes?: Uint8Array, text?: string | null) => {
			contentEl.createDiv({ cls: `ghsync-side-label ${cls}`, text: label });
			let body: string;
			if (!bytes) body = "(файл удалён)";
			else if (text === null || text === undefined) body = `(бинарный файл, ${bytes.length} байт)`;
			else body = text.length > 4000 ? text.slice(0, 4000) + "\n…" : text;
			contentEl.createEl("pre", { cls: "ghsync-pre", text: body });
		};
		preview("Моё (это устройство)", "ghsync-side-local", sides.local, localText);
		preview("GitHub", "ghsync-side-remote", sides.remote, remoteText);

		const actions = new Setting(contentEl).setClass("ghsync-footer");
		if (c.type === "deleted-local") {
			actions.addButton((b) => b.setButtonText("Удалить").onClick(() => this.finish(null)));
			actions.addButton((b) =>
				b.setButtonText("Восстановить с GitHub").setCta().onClick(() => this.finish(sides.remote!)),
			);
		} else if (c.type === "deleted-remote") {
			actions.addButton((b) => b.setButtonText("Удалить (как на GitHub)").onClick(() => this.finish(null)));
			actions.addButton((b) => b.setButtonText("Оставить мой файл").setCta().onClick(() => this.finish(sides.local!)));
		} else {
			actions.addButton((b) => b.setButtonText("Оставить моё").onClick(() => this.finish(sides.local!)));
			actions.addButton((b) => b.setButtonText("Взять с GitHub").onClick(() => this.finish(sides.remote!)));
			actions.addButton((b) =>
				b
					.setButtonText("Сохранить обе")
					.setCta()
					.onClick(() =>
						this.finish(sides.local!, () => this.host.writeFile(conflictCopyPath(c.path), sides.remote!)),
					),
			);
		}
	}
}
