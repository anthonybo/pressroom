/**
 * Discovery, against the shape this account actually has: some repos as direct children of the root, and a
 * grouping folder that is not itself a repo holding several more.
 *
 * The nested case is the one worth a test. A scan that only looks at the root's children finds the flat
 * repos and misses everything inside the grouping folder, and the failure is invisible — the dashboard comes
 * up, lists repos, and simply never mentions the ten projects being worked on most.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { discover, resolveGitDir } from './discover.ts';

const root = mkdtempSync(join(tmpdir(), 'pressroom-discover-'));

after(() => rmSync(root, { recursive: true, force: true }));

function makeRepo(path: string) {
	mkdirSync(path, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
	return path;
}

// A flat repo, a grouping folder with two repos in it, a repo three levels down, a plain directory, and a
// directory that must never be entered.
makeRepo(join(root, 'one-project'));
makeRepo(join(root, 'group', 'overlay'));
makeRepo(join(root, 'group', 'gallery'));
makeRepo(join(root, 'a', 'b', 'deep'));
mkdirSync(join(root, 'notes'), { recursive: true });
writeFileSync(join(root, 'notes', 'todo.md'), '# nothing here\n');
makeRepo(join(root, 'one-project', 'node_modules', 'some-package'));

test('finds repos nested inside a grouping folder, not just the root children', () => {
	const found = discover(root)
		.map((repo) => repo.label)
		.sort();

	// Sorted, so the assertion does not depend on the order the walk happens to return.
	assert.deepEqual(found, ['deep', 'gallery', 'one-project', 'overlay']);
});

test('stops at a repo boundary, so a vendored checkout inside node_modules is ignored', () => {
	const found = discover(root);
	assert.equal(
		found.some((repo) => repo.path.includes('node_modules')),
		false
	);
});

test('respects the depth limit', () => {
	// `a/b/deep` is three levels down and needs a depth of at least 3 to be reached.
	const shallow = discover(root, 2).map((repo) => repo.label);
	assert.equal(shallow.includes('deep'), false);
	assert.equal(shallow.includes('overlay'), true);
});

test('records a path relative to the scan root, for display', () => {
	const nested = discover(root).find((repo) => repo.label === 'gallery');
	assert.equal(nested?.relPath, join('group', 'gallery'));
});

test('labels collide-safely when two repos share a basename', () => {
	const collision = mkdtempSync(join(tmpdir(), 'pressroom-collide-'));
	try {
		makeRepo(join(collision, 'one', 'demo'));
		makeRepo(join(collision, 'two', 'demo'));
		makeRepo(join(collision, 'unique'));

		const labels = discover(collision)
			.map((repo) => repo.label)
			.sort();
		assert.deepEqual(labels, ['one/demo', 'two/demo', 'unique']);
	} finally {
		rmSync(collision, { recursive: true, force: true });
	}
});

test('resolveGitDir follows the gitdir file a linked worktree uses', () => {
	// Deliberately not `one-project`: that one has a repo inside its `node_modules` for the test above, and
	// `git add .` refuses to stage a directory that is itself a checkout.
	const main = makeRepo(join(root, 'worktree-host'));
	writeFileSync(join(main, 'file.txt'), 'one\n');
	execFileSync('git', ['add', 'file.txt'], { cwd: main });
	execFileSync(
		'git',
		['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first'],
		{ cwd: main }
	);

	const tree = join(root, 'worktrees', 'feature');
	execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', tree], { cwd: main });

	const resolved = resolveGitDir(tree);
	assert.ok(resolved, 'a worktree checkout has a .git file, not a directory');
	// The refs for a worktree live in the main repo, which is why both paths are tracked and watched.
	assert.ok(resolved.gitDir.includes('worktrees'));
	assert.notEqual(resolved.commonDir, resolved.gitDir);
});
