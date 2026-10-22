import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { checkFrameworkUpdate, frameworkUpdatesEnabled } from "./watcher-checks";

const GIT = "git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false";

function sh(cmd: string, cwd: string): void {
	execSync(cmd, { cwd, stdio: "ignore" });
}

// A local install one commit behind its upstream, plus a second clone used
// to push further framework commits.
function setupRepos(): { local: string; pusher: string } {
	const root = mkdtempSync(path.join(tmpdir(), "fwupd-"));
	const bare = path.join(root, "up.git");
	const local = path.join(root, "local");
	const pusher = path.join(root, "pusher");
	sh(`git init -q --bare -b main "${bare}"`, root);
	sh(`git clone -q "${bare}" "${local}"`, root);
	sh(`${GIT} commit -q --allow-empty -m base`, local);
	sh(`git push -q origin HEAD:main`, local);
	sh(`git clone -q "${bare}" "${pusher}"`, root);
	return { local, pusher };
}

function pushCommit(pusher: string, msg: string): void {
	sh(`${GIT} commit -q --allow-empty -m "${msg}"`, pusher);
	sh(`git push -q origin HEAD:main`, pusher);
}

test("framework updates are off unless WATCHER_FRAMEWORK_UPDATES=on", () => {
	assert.equal(frameworkUpdatesEnabled({}), false);
	assert.equal(frameworkUpdatesEnabled({ WATCHER_FRAMEWORK_UPDATES: "" }), false);
	assert.equal(frameworkUpdatesEnabled({ WATCHER_FRAMEWORK_UPDATES: "off" }), false);
	assert.equal(frameworkUpdatesEnabled({ WATCHER_FRAMEWORK_UPDATES: "on" }), true);
	assert.equal(frameworkUpdatesEnabled({ WATCHER_FRAMEWORK_UPDATES: "ON" }), true);
});

test("a new framework commit raises no alert by default", () => {
	const { local, pusher } = setupRepos();
	pushCommit(pusher, "framework change");
	assert.equal(checkFrameworkUpdate({ repo: local, upstream: "origin/main", env: {} }), null);
});

test("when opted in, the alert key stays the same across new commits", () => {
	const { local, pusher } = setupRepos();
	const env = { WATCHER_FRAMEWORK_UPDATES: "on" };
	pushCommit(pusher, "first change");
	const a = checkFrameworkUpdate({ repo: local, upstream: "origin/main", env });
	assert.ok(a);
	assert.equal(a.key, "framework-update");
	assert.match(a.message, /1 framework update available/);
	pushCommit(pusher, "second change");
	const b = checkFrameworkUpdate({ repo: local, upstream: "origin/main", env });
	assert.ok(b);
	assert.equal(b.key, "framework-update");
	assert.notEqual(a.context?.target_sha, b.context?.target_sha);
});

test("opted in but up to date: no alert", () => {
	const { local } = setupRepos();
	assert.equal(
		checkFrameworkUpdate({ repo: local, upstream: "origin/main", env: { WATCHER_FRAMEWORK_UPDATES: "on" } }),
		null,
	);
});
