import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitHubSyncPlugin from "./main";

export interface GitHubSyncSettings {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	remoteFolder: string;
	authorName: string;
	authorEmail: string;
	deviceName: string;
	commitTemplate: string;
	askCommitMessage: boolean;
	pullOnStartup: boolean;
	syncOnStartup: boolean;
	autoSyncMinutes: number;
	syncConfigDir: boolean;
	ignorePatterns: string;
	conflictMode: "modal" | "markers";
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
	token: "",
	owner: "",
	repo: "",
	branch: "main",
	remoteFolder: "",
	authorName: "",
	authorEmail: "",
	deviceName: "",
	commitTemplate: "vault backup: {{date}} ({{device}})",
	askCommitMessage: false,
	pullOnStartup: true,
	syncOnStartup: false,
	autoSyncMinutes: 0,
	syncConfigDir: true,
	ignorePatterns: "",
	conflictMode: "modal",
};

export class GitHubSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: GitHubSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Репозиторий").setHeading();

		new Setting(containerEl)
			.setName("GitHub token")
			.setDesc("Fine-grained personal access token с правом Contents: Read and write для этого репозитория.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("github_pat_…")
					.setValue(s.token)
					.onChange(async (v) => {
						// Pasting on iOS can bring along spaces or line breaks.
						s.token = v.replace(/\s+/g, "");
						await save();
					});
			});

		new Setting(containerEl)
			.setName("Владелец")
			.setDesc("Пользователь или организация на GitHub.")
			.addText((t) =>
				t.setValue(s.owner).onChange(async (v) => {
					s.owner = v.trim();
					await save();
				}),
			);

		new Setting(containerEl).setName("Репозиторий").addText((t) =>
			t.setValue(s.repo).onChange(async (v) => {
				s.repo = v.trim().replace(/\.git$/, "");
				await save();
			}),
		);

		new Setting(containerEl).setName("Ветка").addText((t) =>
			t.setValue(s.branch).onChange(async (v) => {
				s.branch = v.trim() || "main";
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("Папка в репозитории")
			.setDesc("Необязательно. Хранилище синхронизируется с этой папкой репозитория, а не с его корнем.")
			.addText((t) =>
				t.setPlaceholder("vault").setValue(s.remoteFolder).onChange(async (v) => {
					s.remoteFolder = v.trim().replace(/^\/+|\/+$/g, "");
					await save();
				}),
			);

		new Setting(containerEl).setName("Проверить подключение").addButton((b) =>
			b.setButtonText("Проверить").onClick(async () => {
				try {
					const info = await this.plugin.makeApi().checkAccess();
					new Notice(
						`✅ ${info.fullName}${info.private ? " (private)" : ""}\n` +
							`Токен: ${info.tokenOwner}\n` +
							(info.canPush ? "Запись разрешена." : "⚠️ Нет прав на запись!") +
							`\nВетка по умолчанию: ${info.defaultBranch}`,
						8000,
					);
				} catch (e) {
					new Notice(`❌ ${(e as Error).message}`, 10000);
				}
			}),
		);

		new Setting(containerEl).setName("Коммиты").setHeading();

		new Setting(containerEl).setName("Имя автора").setDesc("Пусто — владелец токена.").addText((t) =>
			t.setValue(s.authorName).onChange(async (v) => {
				s.authorName = v.trim();
				await save();
			}),
		);
		new Setting(containerEl).setName("Email автора").addText((t) =>
			t.setValue(s.authorEmail).onChange(async (v) => {
				s.authorEmail = v.trim();
				await save();
			}),
		);
		new Setting(containerEl)
			.setName("Имя устройства")
			.setDesc("Подставляется в {{device}}.")
			.addText((t) =>
				t.setPlaceholder("iPhone").setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim();
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Шаблон сообщения коммита")
			.setDesc("Переменные: {{date}}, {{device}}, {{count}}.")
			.addText((t) =>
				t.setValue(s.commitTemplate).onChange(async (v) => {
					s.commitTemplate = v || DEFAULT_SETTINGS.commitTemplate;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Спрашивать сообщение при ручном Sync")
			.setDesc("Команда «Commit & Push» спрашивает всегда; автосинхронизация — никогда.")
			.addToggle((t) =>
				t.setValue(s.askCommitMessage).onChange(async (v) => {
					s.askCommitMessage = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Автоматическая синхронизация").setHeading();

		new Setting(containerEl).setName("Pull при запуске").addToggle((t) =>
			t.setValue(s.pullOnStartup).onChange(async (v) => {
				s.pullOnStartup = v;
				await save();
			}),
		);
		new Setting(containerEl)
			.setName("Полный Sync при запуске")
			.setDesc("Pull и затем push локальных изменений.")
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Sync по таймеру (минуты)")
			.setDesc("0 — выключено.")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
					const n = Math.max(0, Math.floor(Number(v) || 0));
					s.autoSyncMinutes = n;
					await save();
					this.plugin.scheduleAutoSync();
				});
			});

		new Setting(containerEl).setName("Файлы и конфликты").setHeading();

		new Setting(containerEl)
			.setName(`Синхронизировать ${this.app.vault.configDir}`)
			.setDesc("Настройки, плагины, темы. workspace*.json, кэш и токен этого плагина не синхронизируются никогда.")
			.addToggle((t) =>
				t.setValue(s.syncConfigDir).onChange(async (v) => {
					s.syncConfigDir = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Игнорировать")
			.setDesc("По одному шаблону в строке, синтаксис как в .gitignore (*, **, папка/, !исключение).")
			.addTextArea((t) => {
				t.inputEl.rows = 5;
				t.setPlaceholder("Attachments/large/\n*.mp4").setValue(s.ignorePatterns).onChange(async (v) => {
					s.ignorePatterns = v;
					await save();
				});
			});
		new Setting(containerEl)
			.setName("Конфликты по умолчанию")
			.setDesc("Окно — выбор по фрагментам. Маркеры — <<<<<<< ======= >>>>>>> прямо в заметке.")
			.addDropdown((d) =>
				d
					.addOption("modal", "Окно разрешения")
					.addOption("markers", "Маркеры в файле")
					.setValue(s.conflictMode)
					.onChange(async (v) => {
						s.conflictMode = v as GitHubSyncSettings["conflictMode"];
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Сбросить состояние синхронизации")
			.setDesc(
				"Забыть, какие версии файлов считались общими. Следующий Pull сравнит всё заново: совпадающие файлы не тронет, различающиеся станут конфликтами.",
			)
			.addButton((b) =>
				b
					.setButtonText("Сбросить")
					.setWarning()
					.onClick(async () => {
						await this.plugin.resetState();
						new Notice("Состояние синхронизации сброшено.");
					}),
			);
	}
}
