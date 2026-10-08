import { App, TFile, TFolder, normalizePath } from "obsidian";

export interface LocalFileInfo {
	path: string;
	mtime: number;
	size: number;
}

/** File system access used by the sync engine (faked in tests). */
export interface VaultIO {
	/** Lists every file in the vault, including hidden ones. `skipDir` prunes whole folders. */
	list(skipDir: (path: string) => boolean): Promise<LocalFileInfo[]>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, data: Uint8Array): Promise<void>;
	/** Removes a file (moved to the local .trash where possible). */
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

function isHidden(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export class ObsidianVaultIO implements VaultIO {
	constructor(private app: App) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	async list(skipDir: (path: string) => boolean): Promise<LocalFileInfo[]> {
		const out: LocalFileInfo[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = await this.adapter.list(dir === "" ? "/" : dir);
			for (const raw of listing.files) {
				const path = normalizePath(raw);
				const indexed = this.app.vault.getAbstractFileByPath(path);
				if (indexed instanceof TFile) {
					out.push({ path, mtime: indexed.stat.mtime, size: indexed.stat.size });
				} else {
					const st = await this.adapter.stat(path);
					if (st && st.type === "file") out.push({ path, mtime: st.mtime, size: st.size });
				}
			}
			for (const raw of listing.folders) {
				const path = normalizePath(raw);
				if (path === "/" || path === "" || skipDir(path)) continue;
				await walk(path);
			}
		};
		await walk("");
		return out;
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.adapter.readBinary(path));
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder || (await this.adapter.exists(folder))) return;
		await this.ensureFolder(parentOf(folder));
		try {
			if (isHidden(folder)) await this.adapter.mkdir(folder);
			else await this.app.vault.createFolder(folder);
		} catch (e) {
			if (!(await this.adapter.exists(folder))) throw e;
		}
	}

	async write(path: string, data: Uint8Array): Promise<void> {
		await this.ensureFolder(parentOf(path));
		const buf = toArrayBuffer(data);
		if (!isHidden(path)) {
			// Go through the Vault API so Obsidian's index, editors and links update.
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, buf);
				return;
			}
			if (!existing) {
				await this.app.vault.createBinary(path, buf);
				return;
			}
		}
		await this.adapter.writeBinary(path, buf);
	}

	async remove(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.vault.trash(file, false);
		else if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
		await this.removeEmptyParents(parentOf(path));
	}

	private async removeEmptyParents(folder: string): Promise<void> {
		while (folder) {
			if (!(await this.adapter.exists(folder))) {
				folder = parentOf(folder);
				continue;
			}
			const listing = await this.adapter.list(folder);
			if (listing.files.length || listing.folders.length) return;
			const f = this.app.vault.getAbstractFileByPath(folder);
			if (f instanceof TFolder) await this.app.vault.delete(f, true);
			else await this.adapter.rmdir(folder, false);
			folder = parentOf(folder);
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(path);
	}
}
