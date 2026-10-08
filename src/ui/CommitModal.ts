import { App, Modal, Setting } from "obsidian";
import type { Conflict, LocalChange } from "../engine";

const KIND_LABEL: Record<LocalChange["kind"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
};

export function renderChangeList(el: HTMLElement, changes: LocalChange[], limit = 200): void {
	const list = el.createDiv({ cls: "ghsync-change-list" });
	for (const c of changes.slice(0, limit)) {
		const row = list.createDiv({ cls: "ghsync-change-row" });
		row.createSpan({ cls: `ghsync-badge ghsync-badge-${c.kind}`, text: KIND_LABEL[c.kind] });
		row.createSpan({ cls: "ghsync-change-path", text: c.path });
	}
	if (changes.length > limit) list.createDiv({ cls: "ghsync-muted", text: `…и ещё ${changes.length - limit}` });
}

/** Shows local changes and asks for a commit message. Resolves with the message or null. */
export class CommitModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private changes: LocalChange[],
		private defaultMessage: string,
		private onSubmit: (message: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("ghsync-modal");
		this.setTitle(`Commit & Push — ${this.changes.length} изм.`);
		renderChangeList(contentEl, this.changes);

		let message = this.defaultMessage;
		const area = contentEl.createEl("textarea", { cls: "ghsync-commit-message" });
		area.value = message;
		area.rows = 3;
		area.addEventListener("input", () => (message = area.value));

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Commit & Push")
					.setCta()
					.onClick(() => {
						this.resolved = true;
						this.close();
						this.onSubmit(message.trim() || this.defaultMessage);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onSubmit(null);
	}
}

/** Read-only overview: local changes waiting for push + unresolved conflicts. */
export class ChangesModal extends Modal {
	constructor(
		app: App,
		private changes: LocalChange[],
		private conflicts: Conflict[],
		private actions: { push: () => void; resolve: () => void },
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("ghsync-modal");
		this.setTitle("Изменения");
		if (this.conflicts.length) {
			contentEl.createEl("h4", { text: `Конфликты: ${this.conflicts.length}` });
			for (const c of this.conflicts) contentEl.createDiv({ cls: "ghsync-change-row ghsync-conflict-row", text: c.path });
			new Setting(contentEl).addButton((b) =>
				b
					.setButtonText("Разрешить конфликты")
					.setCta()
					.onClick(() => {
						this.close();
						this.actions.resolve();
					}),
			);
		}
		contentEl.createEl("h4", { text: `Ожидают push: ${this.changes.length}` });
		if (!this.changes.length) contentEl.createDiv({ cls: "ghsync-muted", text: "Локальных изменений нет." });
		else {
			renderChangeList(contentEl, this.changes);
			if (!this.conflicts.length) {
				new Setting(contentEl).addButton((b) =>
					b
						.setButtonText("Commit & Push")
						.setCta()
						.onClick(() => {
							this.close();
							this.actions.push();
						}),
				);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
