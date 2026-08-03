/**
 * The parsers, against the shapes git actually emits.
 *
 * These cover the cases that would otherwise be found by noticing something wrong on screen weeks later: a
 * merge commit reported as changing nothing, a rename that swallows the entry after it, an unborn branch
 * read as a detached HEAD. Every fixture here is the real output format, separators included.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLog, parseNameStatus, parseNumstat, parseShortstat, parseStatus } from './git.ts';

const F = '\u001f';
const R = '\u001e';

/** Builds a log record the way `--format` plus `--shortstat` does: fields, then the stat on its own line. */
function record(fields: string[], shortstat = '') {
	return R + fields.join(F) + F + (shortstat ? `\n\n${shortstat}\n` : '\n');
}

test('parseLog reads a single commit with its stats', () => {
	const stdout = record(
		[
			'690119baf4c1e8d9a0b7c6d5e4f3a2b1c0d9e8f7',
			'690119b',
			'a-committer',
			'committer@example.com',
			'2026-07-29T15:56:12-07:00',
			'2026-07-29T15:56:12-07:00',
			'HEAD -> main, origin/main',
			'3f5ca94aaaa',
			'Let the link row decide validity',
			''
		],
		' 3 files changed, 42 insertions(+), 12 deletions(-)'
	);

	const [commit] = parseLog(stdout);
	assert.ok(commit);
	assert.equal(commit.short, '690119b');
	assert.equal(commit.author, 'a-committer');
	assert.equal(commit.subject, 'Let the link row decide validity');
	assert.equal(commit.refs, 'HEAD -> main, origin/main');
	assert.deepEqual(commit.parents, ['3f5ca94aaaa']);
	assert.equal(commit.files, 3);
	assert.equal(commit.insertions, 42);
	assert.equal(commit.deletions, 12);
});

test('parseLog keeps a multi-line body intact and separate from the stat line', () => {
	const body = 'First paragraph.\n\nSecond paragraph, which mentions 9 insertions(+) in prose.';
	const stdout = record(
		[
			'a'.repeat(40),
			'aaaaaaa',
			'a',
			'a@b',
			'2026-07-29T10:00:00Z',
			'2026-07-29T10:00:00Z',
			'',
			'',
			'Subject',
			body
		],
		' 1 file changed, 5 insertions(+)'
	);

	const [commit] = parseLog(stdout);
	assert.ok(commit);
	assert.equal(commit.subject, 'Subject');
	assert.equal(commit.body, body);
	// The prose in the body must not be mistaken for the shortstat.
	assert.equal(commit.insertions, 5);
	assert.equal(commit.deletions, 0);
	assert.equal(commit.files, 1);
});

test('parseLog handles a merge, where git prints no shortstat at all', () => {
	const stdout = record([
		'b'.repeat(40),
		'bbbbbbb',
		'a-committer',
		'a@b',
		'2026-07-29T10:00:00Z',
		'2026-07-29T10:00:00Z',
		'',
		'1111111 2222222',
		"Merge branch 'dev'",
		''
	]);

	const [commit] = parseLog(stdout);
	assert.ok(commit);
	assert.equal(commit.parents.length, 2);
	assert.equal(commit.files, 0);
	assert.equal(commit.insertions, 0);
});

test('parseLog reads several commits in one pass', () => {
	const one = record(
		[
			'1'.repeat(40),
			'1111111',
			'a',
			'a@b',
			'2026-07-29T10:00:00Z',
			'2026-07-29T10:00:00Z',
			'',
			'',
			'One',
			''
		],
		' 1 file changed, 1 insertion(+)'
	);
	const two = record(
		[
			'2'.repeat(40),
			'2222222',
			'a',
			'a@b',
			'2026-07-28T10:00:00Z',
			'2026-07-28T10:00:00Z',
			'',
			'',
			'Two',
			''
		],
		' 2 files changed, 4 deletions(-)'
	);

	const commits = parseLog(one + two);
	assert.equal(commits.length, 2);
	assert.equal(commits[0]?.subject, 'One');
	assert.equal(commits[1]?.deletions, 4);
	// "1 insertion(+)" is singular in git's output and must still be read.
	assert.equal(commits[0]?.insertions, 1);
});

test('parseLog strips escape sequences out of a subject', () => {
	// A commit subject is arbitrary text. Left alone, this one would clear the screen when drawn.
	const nasty = '\u001b[2JCleared\u001b[31m red';
	const stdout = record([
		'c'.repeat(40),
		'ccccccc',
		'a',
		'a@b',
		'2026-07-29T10:00:00Z',
		'2026-07-29T10:00:00Z',
		'',
		'',
		nasty,
		''
	]);

	const [commit] = parseLog(stdout);
	assert.equal(commit?.subject, 'Cleared red');
});

test('parseShortstat reads each clause independently', () => {
	assert.deepEqual(parseShortstat(' 1 file changed, 2 insertions(+)'), {
		files: 1,
		insertions: 2,
		deletions: 0
	});
	assert.deepEqual(parseShortstat(' 4 files changed, 9 deletions(-)'), {
		files: 4,
		insertions: 0,
		deletions: 9
	});
	assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});

test('parseStatus reads branch, upstream and ahead/behind', () => {
	const stdout = [
		'# branch.oid 690119baf4c1',
		'# branch.head responsive-pass',
		'# branch.upstream origin/responsive-pass',
		'# branch.ab +3 -1',
		'1 .M N... 100644 100644 100644 aaa bbb src/pages/index.astro',
		'1 M. N... 100644 100644 100644 aaa bbb src/styles.css',
		'1 MM N... 100644 100644 100644 aaa bbb both.ts',
		'? untracked.txt',
		'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts',
		''
	].join('\0');

	const status = parseStatus(stdout);
	assert.equal(status.branch, 'responsive-pass');
	assert.equal(status.upstream, 'origin/responsive-pass');
	assert.equal(status.ahead, 3);
	assert.equal(status.behind, 1);
	// `.M` is unstaged, `M.` is staged, `MM` is both.
	assert.equal(status.staged, 2);
	assert.equal(status.unstaged, 2);
	// Three tracked files changed, not four: the `MM` file appears in both halves and must be counted once.
	// Summing the halves is what made the panel report one file as two changes.
	assert.equal(status.changed, 4, 'three modified files plus one unmerged');
	assert.equal(status.untracked, 1);
	assert.equal(status.conflicted, 1);
	assert.equal(status.unborn, false);
});

test('parseStatus does not read a rename target as another status line', () => {
	// `2 ` entries carry the original path in the next NUL-separated chunk. Counting that chunk as a line
	// would inflate every count in a commit that renamed a file.
	const stdout = [
		'# branch.head main',
		'2 R. N... 100644 100644 100644 aaa bbb R100 new/path.ts',
		'old/path.ts',
		''
	].join('\0');

	const status = parseStatus(stdout);
	assert.equal(status.staged, 1);
	assert.equal(status.unstaged, 0);
	assert.equal(status.untracked, 0);
});

test('parseStatus recognizes an unborn branch and a detached HEAD', () => {
	const unborn = parseStatus(['# branch.oid (initial)', '# branch.head main', ''].join('\0'));
	assert.equal(unborn.unborn, true);
	assert.equal(unborn.upstream, null);

	const detached = parseStatus(['# branch.oid abc123', '# branch.head (detached)', ''].join('\0'));
	assert.equal(detached.branch, 'detached');
});

test('parseNumstat reads counts, binaries and renames', () => {
	const stdout = [
		'30\t8\tsrc/pages/index.astro',
		'-\t-\tpublic/hero.jpg',
		'4\t2\t',
		'old/name.ts',
		'new/name.ts',
		''
	].join('\0');

	const parsed = parseNumstat(stdout);
	assert.deepEqual(parsed.get('src/pages/index.astro'), { insertions: 30, deletions: 8 });
	// A binary file's counts are unknown, not zero.
	assert.deepEqual(parsed.get('public/hero.jpg'), { insertions: null, deletions: null });
	assert.deepEqual(parsed.get('new/name.ts'), { insertions: 4, deletions: 2, from: 'old/name.ts' });
	assert.equal(parsed.size, 3);
});

test('parseNameStatus reads plain entries and renames', () => {
	const stdout = [
		'M',
		'src/a.ts',
		'A',
		'src/b.ts',
		'R100',
		'old.ts',
		'new.ts',
		'D',
		'gone.ts',
		''
	].join('\0');

	const parsed = parseNameStatus(stdout);
	assert.equal(parsed.get('src/a.ts'), 'M');
	assert.equal(parsed.get('src/b.ts'), 'A');
	assert.equal(parsed.get('new.ts'), 'R');
	assert.equal(parsed.get('gone.ts'), 'D');
	assert.equal(parsed.has('old.ts'), false);
});

test('a file that is staged and then modified again counts as one changed file', () => {
	// `MM` means staged changes plus further unstaged changes to the same file. It appears in both halves of
	// the status, so `staged + unstaged` reports two changed files where there is one — which is what made the
	// repo panel show `●2` for a single edited file.
	const stdout = [
		'# branch.head main',
		'1 MM N... 100644 100644 100644 aaa bbb one-file.ts',
		''
	].join('\0');

	const status = parseStatus(stdout);
	assert.equal(status.staged, 1);
	assert.equal(status.unstaged, 1);
	assert.equal(status.changed, 1, 'one file, however many halves of the status mention it');
});

test('the changed count matches the real shape of these repos', () => {
	// Verbatim from the four site repos: two files modified but not staged, plus an untracked directory.
	const stdout = [
		'# branch.oid abc123',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +0 -0',
		'1 .M N... 100644 100644 100644 aaa aaa .github/workflows/deploy.yml',
		'1 .M N... 100644 100644 100644 bbb bbb package.json',
		'? .githooks/',
		''
	].join('\0');

	const status = parseStatus(stdout);
	// Which the panel draws as `●2 ?1`.
	assert.equal(status.changed, 2);
	assert.equal(status.untracked, 1);
	assert.equal(status.ahead, 0);
});
