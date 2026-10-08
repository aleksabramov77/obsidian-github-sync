import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { base64ToBytes, bytesToBase64, gitBlobSha, tryDecodeText, utf8Encode } from "../src/hash";
import { IgnoreMatcher, buildIgnorePatterns } from "../src/ignore";
import { hasConflictMarkers, parseConflictMarkers, renderMerge, threeWayMerge } from "../src/merge";

describe("hash", () => {
	it("matches `git hash-object`", async () => {
		const text = "# Привет\nhello world\n";
		const expected = execFileSync("git", ["hash-object", "--stdin"], { input: text }).toString().trim();
		expect(await gitBlobSha(utf8Encode(text))).toBe(expected);
		expect(await gitBlobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	it("base64 round-trips arbitrary bytes", () => {
		for (const len of [0, 1, 2, 3, 4, 255, 1000]) {
			const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
			const b64 = bytesToBase64(bytes);
			expect(b64).toBe(Buffer.from(bytes).toString("base64"));
			expect([...base64ToBytes(b64)]).toEqual([...bytes]);
			// GitHub wraps base64 content with newlines.
			expect([...base64ToBytes(b64.replace(/(.{60})/g, "$1\n"))]).toEqual([...bytes]);
		}
	});

	it("detects binary content", () => {
		expect(tryDecodeText(utf8Encode("текст"))).toBe("текст");
		expect(tryDecodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBeNull();
		expect(tryDecodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
	});
});

describe("ignore", () => {
	const m = new IgnoreMatcher(
		buildIgnorePatterns({
			configDir: ".obsidian",
			pluginDir: ".obsidian/plugins/github-sync-mobile",
			syncConfigDir: true,
			userPatterns: ["*.mp4", "Private/", "!Private/ok.md"],
		}),
	);

	it("applies built-in rules", () => {
		expect(m.ignores(".obsidian/workspace.json")).toBe(true);
		expect(m.ignores(".obsidian/workspace-mobile.json")).toBe(true);
		expect(m.ignores(".obsidian/plugins/github-sync-mobile/data.json")).toBe(true);
		expect(m.ignores(".obsidian/plugins/github-sync-mobile/main.js")).toBe(false);
		expect(m.ignores(".obsidian/app.json")).toBe(false);
		expect(m.ignores(".trash/old.md")).toBe(true);
		expect(m.ignores("notes/.DS_Store")).toBe(true);
		expect(m.ignores(".git/")).toBe(true);
	});

	it("applies user patterns", () => {
		expect(m.ignores("video/clip.mp4")).toBe(true);
		expect(m.ignores("Private/secret.md")).toBe(true);
		expect(m.ignores("Private/ok.md")).toBe(false);
		expect(m.ignores("Public/Private.md")).toBe(false);
	});

	it("can exclude the config dir entirely", () => {
		const off = new IgnoreMatcher(
			buildIgnorePatterns({ configDir: ".obsidian", pluginDir: ".obsidian/plugins/x", syncConfigDir: false, userPatterns: [] }),
		);
		expect(off.ignores(".obsidian/app.json")).toBe(true);
		expect(off.ignores(".obsidian/")).toBe(true);
		expect(off.ignores("note.md")).toBe(false);
	});
});

describe("merge", () => {
	const base = "a\nb\nc\nd\ne";

	it("merges non-overlapping edits", () => {
		const r = threeWayMerge("A\nb\nc\nd\ne", base, "a\nb\nc\nd\nE");
		expect(r.conflictCount).toBe(0);
		expect(renderMerge(r.chunks)).toBe("A\nb\nc\nd\nE");
	});

	it("reports overlapping edits and renders resolutions/markers", () => {
		const r = threeWayMerge("a\nLOCAL\nc\nd\ne", base, "a\nREMOTE\nc\nd\ne");
		expect(r.conflictCount).toBe(1);
		expect(renderMerge(r.chunks, [["LOCAL", "REMOTE"]])).toBe("a\nLOCAL\nREMOTE\nc\nd\ne");
		const marked = renderMerge(r.chunks);
		expect(hasConflictMarkers(marked)).toBe(true);
		const parsed = parseConflictMarkers(marked);
		expect(parsed.conflictCount).toBe(1);
		expect(renderMerge(parsed.chunks, [["REMOTE"]])).toBe("a\nREMOTE\nc\nd\ne");
	});

	it("treats identical edits as no conflict", () => {
		const r = threeWayMerge("a\nX\nc\nd\ne", base, "a\nX\nc\nd\ne");
		expect(r.conflictCount).toBe(0);
	});
});
