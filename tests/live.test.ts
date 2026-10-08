import { describe, expect, it } from "vitest";
import { HttpFn, RestGitHubApi } from "../src/github";

// Optional check against the real GitHub API:
//   LIVE_GITHUB_TOKEN=… LIVE_GITHUB_REPO=owner/repo npm test
const token = process.env.LIVE_GITHUB_TOKEN;
const [owner, repo] = (process.env.LIVE_GITHUB_REPO ?? "/").split("/");

const http: HttpFn = async (r) => {
	const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
	return { status: res.status, text: await res.text() };
};

describe.skipIf(!token)("live GitHub API", () => {
	it("checks access and reads the branch head", async () => {
		const api = new RestGitHubApi({ token: token!, owner, repo, branch: "main" }, http);
		const info = await api.checkAccess();
		expect(info.fullName.toLowerCase()).toBe(`${owner}/${repo}`.toLowerCase());
		expect((await api.getHead()).kind).toBe("ok");
	});

	it("explains a 404 instead of failing silently", async () => {
		const api = new RestGitHubApi({ token: token!, owner, repo: "definitely-missing-repo-xyz", branch: "main" }, http);
		await expect(api.checkAccess()).rejects.toThrow(/404/);
	});
});
