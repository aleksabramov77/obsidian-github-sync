// Minimal gitignore-like matcher.
// Supported: `*` (within a segment), `**` (any depth), `?`, trailing `/` (directory),
// leading `/` (anchored to root), `!` negation. Patterns without `/` match at any depth.

interface Rule {
	re: RegExp;
	negate: boolean;
}

function globToRegex(glob: string): RegExp {
	let anchored = false;
	let dirOnly = false;
	let g = glob;
	if (g.startsWith("/")) {
		anchored = true;
		g = g.slice(1);
	}
	if (g.endsWith("/")) {
		dirOnly = true;
		g = g.slice(0, -1);
	}
	if (g.includes("/")) anchored = true;

	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*") {
			if (g[i + 1] === "*") {
				// `**/` → any number of directories, `**` at end → anything
				if (g[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	const prefix = anchored ? "^" : "^(?:.*/)?";
	// A matching directory excludes everything below it; a file pattern matches itself
	// (or, if it names a directory, everything inside it).
	const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
	return new RegExp(prefix + re + suffix);
}

export class IgnoreMatcher {
	private rules: Rule[] = [];

	constructor(patterns: string[]) {
		for (const raw of patterns) {
			const p = raw.trim();
			if (!p || p.startsWith("#")) continue;
			const negate = p.startsWith("!");
			this.rules.push({ re: globToRegex(negate ? p.slice(1) : p), negate });
		}
	}

	ignores(path: string): boolean {
		let ignored = false;
		for (const r of this.rules) {
			if (r.re.test(path)) ignored = !r.negate;
		}
		return ignored;
	}
}

export interface IgnoreOptions {
	configDir: string;
	pluginDir: string;
	syncConfigDir: boolean;
	userPatterns: string[];
}

/** User patterns followed by rules that always apply (they win because they come last). */
export function buildIgnorePatterns(opts: IgnoreOptions): string[] {
	const cfg = opts.configDir.replace(/\/$/, "");
	const patterns = [
		".git/",
		".trash/",
		".DS_Store",
		"Thumbs.db",
		`/${cfg}/workspace.json`,
		`/${cfg}/workspace-mobile.json`,
		`/${cfg}/workspaces.json`,
		`/${cfg}/cache`,
	];
	if (!opts.syncConfigDir) patterns.push(`/${cfg}/`);
	// Per-device state and the token never leave the device.
	patterns.push(`/${opts.pluginDir}/data.json`, `/${opts.pluginDir}/sync-state.json`);
	return [...opts.userPatterns, ...patterns];
}
