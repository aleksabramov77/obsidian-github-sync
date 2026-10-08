import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, SyncState, emptyState } from "../src/engine";
import { IgnoreMatcher, buildIgnorePatterns } from "../src/ignore";
import { utf8Encode } from "../src/hash";
import { FakeGitHub, FakeVault } from "./fakes";

const msg = () => "test commit";

function makeEngine(gh: FakeGitHub, vault: FakeVault, state: SyncState, opts: Partial<{ conflictMode: "modal" | "markers"; remoteFolder: string }> = {}) {
	const ignore = new IgnoreMatcher(
		buildIgnorePatterns({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/gs", syncConfigDir: true, userPatterns: [] }),
	);
	return new SyncEngine(gh, vault, state, async () => {}, {
		remoteFolder: opts.remoteFolder ?? "",
		ignore,
		conflictMode: opts.conflictMode ?? "modal",
	});
}

describe("SyncEngine", () => {
	let gh: FakeGitHub;
	let phone: FakeVault;
	let state: SyncState;

	beforeEach(() => {
		gh = new FakeGitHub();
		phone = new FakeVault();
		state = emptyState("k");
	});

	it("initialises an empty repository on first push", async () => {
		phone.set("a.md", "A");
		phone.set("dir/b.md", "B");
		phone.set(".obsidian/workspace.json", "{}");
		const { push } = await makeEngine(gh, phone, state).sync(msg);
		expect(push!.uploaded.sort()).toEqual(["a.md", "dir/b.md"]);
		expect(gh.files()).toEqual({ "a.md": "A", "dir/b.md": "B" });
		expect(state.baseCommit).toBe(gh.head);
	});

	it("clones a remote repo into an empty vault", async () => {
		await gh.commitFiles({ "x.md": "X", "folder/y.md": "Y", ".obsidian/workspace.json": "{}" });
		const { pull, push } = await makeEngine(gh, phone, state).sync(msg);
		expect(pull.downloaded.sort()).toEqual(["folder/y.md", "x.md"]);
		expect(push!.commit).toBeNull();
		expect(phone.snapshot()).toEqual({ "x.md": "X", "folder/y.md": "Y" });
	});

	it("pushes additions, modifications and deletions", async () => {
		await gh.commitFiles({ "keep.md": "1", "edit.md": "old", "del.md": "bye" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		phone.set("edit.md", "new");
		phone.set("new.md", "fresh");
		await phone.remove("del.md");
		const { push } = await engine.sync(msg);
		expect(push!.uploaded.sort()).toEqual(["edit.md", "new.md"]);
		expect(push!.deletedRemote).toEqual(["del.md"]);
		expect(gh.files()).toEqual({ "keep.md": "1", "edit.md": "new", "new.md": "fresh" });
		// Nothing left to do afterwards.
		const again = await engine.sync(msg);
		expect(again.push!.commit).toBeNull();
	});

	it("applies remote-only changes without touching local edits", async () => {
		await gh.commitFiles({ "a.md": "A", "b.md": "B", "c.md": "C" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "a.md": "A2", "c.md": null, "d.md": "D" });
		phone.set("b.md", "B-local");
		const { pull } = await engine.sync(msg);
		expect(pull.downloaded.sort()).toEqual(["a.md", "d.md"]);
		expect(pull.deletedLocal).toEqual(["c.md"]);
		expect(phone.snapshot()).toEqual({ "a.md": "A2", "b.md": "B-local", "d.md": "D" });
		expect(gh.files()).toEqual({ "a.md": "A2", "b.md": "B-local", "d.md": "D" });
	});

	it("auto-merges non-overlapping edits of the same file", async () => {
		await gh.commitFiles({ "n.md": "line1\nline2\nline3\nline4\nline5" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "n.md": "line1\nline2\nline3\nline4\nREMOTE5" });
		phone.set("n.md", "LOCAL1\nline2\nline3\nline4\nline5");
		const { pull, push } = await engine.sync(msg);
		expect(pull.merged).toEqual(["n.md"]);
		expect(pull.conflicts).toEqual([]);
		expect(phone.text("n.md")).toBe("LOCAL1\nline2\nline3\nline4\nREMOTE5");
		expect(gh.files()["n.md"]).toBe("LOCAL1\nline2\nline3\nline4\nREMOTE5");
		expect(push!.uploaded).toEqual(["n.md"]);
	});

	it("reports a conflict, blocks push, and pushes the resolution", async () => {
		await gh.commitFiles({ "n.md": "a\nb\nc" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "n.md": "a\nREMOTE\nc" });
		phone.set("n.md", "a\nLOCAL\nc");

		const first = await engine.sync(msg);
		expect(first.push).toBeNull();
		expect(first.pull.conflicts.map((c) => [c.path, c.type])).toEqual([["n.md", "both-modified"]]);
		expect(phone.text("n.md")).toBe("a\nLOCAL\nc"); // untouched in modal mode
		await expect(engine.push(msg)).rejects.toThrow(/конфликт/);

		// A second pull keeps reporting the same conflict.
		expect((await engine.pull()).conflicts).toHaveLength(1);

		await engine.resolveConflict("n.md", utf8Encode("a\nLOCAL\nREMOTE\nc"));
		const { push } = await engine.sync(msg);
		expect(push!.uploaded).toEqual(["n.md"]);
		expect(gh.files()["n.md"]).toBe("a\nLOCAL\nREMOTE\nc");
		expect(state.conflicts).toEqual([]);
	});

	it("writes conflict markers in markers mode and keeps them until resolved", async () => {
		await gh.commitFiles({ "n.md": "a\nb\nc" });
		const engine = makeEngine(gh, phone, state, { conflictMode: "markers" });
		await engine.sync(msg);
		await gh.commitFiles({ "n.md": "a\nREMOTE\nc" });
		phone.set("n.md", "a\nLOCAL\nc");
		await engine.sync(msg);
		const marked = phone.text("n.md")!;
		expect(marked).toContain("<<<<<<< ");
		expect(marked).toContain("LOCAL");
		expect(marked).toContain("REMOTE");
		expect(state.conflicts[0].markersWritten).toBe(true);

		// Another pull must not wrap the markers in new markers.
		await engine.pull();
		expect(phone.text("n.md")).toBe(marked);

		phone.set("n.md", "a\nfixed\nc");
		await engine.resolveConflict("n.md", utf8Encode("a\nfixed\nc"));
		await engine.sync(msg);
		expect(gh.files()["n.md"]).toBe("a\nfixed\nc");
	});

	it("handles delete-vs-modify conflicts", async () => {
		await gh.commitFiles({ "a.md": "A", "b.md": "B" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "a.md": "A-remote", "b.md": null });
		await phone.remove("a.md");
		phone.set("b.md", "B-local");
		const { pull } = await engine.sync(msg);
		const types = Object.fromEntries(pull.conflicts.map((c) => [c.path, c.type]));
		expect(types).toEqual({ "a.md": "deleted-local", "b.md": "deleted-remote" });

		const sides = await engine.loadConflictSides(pull.conflicts.find((c) => c.path === "a.md")!);
		await engine.resolveConflict("a.md", sides.remote!); // restore from GitHub
		await engine.resolveConflict("b.md", utf8Encode("B-local")); // keep mine
		await engine.sync(msg);
		expect(gh.files()).toEqual({ "a.md": "A-remote", "b.md": "B-local" });
		expect(phone.snapshot()).toEqual({ "a.md": "A-remote", "b.md": "B-local" });
	});

	it("resolves all conflicts by keeping both versions", async () => {
		await gh.commitFiles({ "n.md": "base", "gone-here.md": "G", "gone-there.md": "T" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "n.md": "remote", "gone-here.md": "G2", "gone-there.md": null });
		phone.set("n.md", "local");
		await phone.remove("gone-here.md");
		phone.set("gone-there.md", "T2");
		expect((await engine.pull()).conflicts).toHaveLength(3);

		const copies = await engine.resolveAllKeepBoth("iPhone conflict 2026-10-09");
		expect(copies).toEqual(["n (iPhone conflict 2026-10-09).md"]);
		expect(state.conflicts).toEqual([]);
		await engine.sync(msg);
		expect(gh.files()).toEqual({
			"n.md": "remote",
			"n (iPhone conflict 2026-10-09).md": "local",
			"gone-here.md": "G2",
			"gone-there.md": "T2",
		});
		expect(phone.snapshot()).toEqual(gh.files());
	});

	it("refuses to push when GitHub moved on since the last pull", async () => {
		await gh.commitFiles({ "a.md": "A" });
		const engine = makeEngine(gh, phone, state);
		await engine.sync(msg);
		await gh.commitFiles({ "z.md": "Z" });
		phone.set("a.md", "A2");
		await expect(engine.push(msg)).rejects.toThrow(/pull/);
		await engine.sync(msg);
		expect(gh.files()).toEqual({ "a.md": "A2", "z.md": "Z" });
	});

	it("syncs two devices through GitHub", async () => {
		const laptop = new FakeVault();
		const laptopState = emptyState("k");
		const e1 = makeEngine(gh, phone, state);
		const e2 = makeEngine(gh, laptop, laptopState);
		phone.set("from-phone.md", "P");
		await e1.sync(msg);
		await e2.sync(msg);
		laptop.set("from-laptop.md", "L");
		await e2.sync(msg);
		await e1.sync(msg);
		expect(phone.snapshot()).toEqual({ "from-phone.md": "P", "from-laptop.md": "L" });
		expect(laptop.snapshot()).toEqual(phone.snapshot());
	});

	it("maps the vault to a sub-folder of the repository", async () => {
		await gh.commitFiles({ "README.md": "repo readme", "vault/n.md": "N" });
		const engine = makeEngine(gh, phone, state, { remoteFolder: "vault" });
		await engine.sync(msg);
		expect(phone.snapshot()).toEqual({ "n.md": "N" });
		phone.set("m.md", "M");
		await engine.sync(msg);
		expect(gh.files()).toEqual({ "README.md": "repo readme", "vault/n.md": "N", "vault/m.md": "M" });
	});

	it("treats identical files as in sync after a state reset", async () => {
		await gh.commitFiles({ "same.md": "S", "diff.md": "remote" });
		phone.set("same.md", "S");
		phone.set("diff.md", "local");
		const { pull } = await makeEngine(gh, phone, state).sync(msg);
		expect(pull.downloaded).toEqual([]);
		expect(pull.conflicts.map((c) => c.path)).toEqual(["diff.md"]);
	});
});
