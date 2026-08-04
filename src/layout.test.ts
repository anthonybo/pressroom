/**
 * Column arithmetic and windowing.
 *
 * The assertion that matters in every one of these is that the total comes to *at most* the terminal width,
 * and that the panes come to *exactly* the terminal height. One column too many wraps a row, and a wrapped
 * row makes ink redraw the next frame in the wrong place — the display walks down the screen and does not
 * recover. One row too many scrolls the header off the top.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitBody, feedColumns, layoutWidth, splitRows, windowFor } from './layout.ts';

const WIDTHS = [40, 60, 72, 80, 96, 100, 116, 120, 140, 180, 240];

test('a feed row never exceeds the terminal width, at any width', () => {
	for (const total of WIDTHS) {
		for (const showAuthor of [false, true]) {
			for (const repoWidth of [6, 10, 14, 16, 30]) {
				const columns = feedColumns(total, { repoWidth, showAuthor });
				assert.ok(
					layoutWidth(columns) <= total,
					`${total} cols, repoWidth ${repoWidth}, authors ${showAuthor}: layout came to ${layoutWidth(columns)}`
				);
			}
		}
	}
});

test('the subject keeps a usable share of the row', () => {
	// At 80 columns the subject is what you are reading; the optional columns must not crowd it out.
	const columns = feedColumns(80, { repoWidth: 14, showAuthor: false });
	assert.ok(columns.subject >= 16, `subject was ${columns.subject}`);
	assert.equal(columns.stats > 0, true);
});

test('optional columns appear as the terminal gets wider, and not before', () => {
	const narrow = feedColumns(50, { repoWidth: 14, showAuthor: true });
	assert.equal(narrow.stats, 0, 'no room for stats at 50 columns');
	assert.equal(narrow.branch, 0);
	assert.equal(narrow.author, 0);

	const medium = feedColumns(96, { repoWidth: 14, showAuthor: true });
	assert.ok(medium.stats > 0);
	assert.ok(
		medium.author > 0,
		'the author column arrives once there are several authors and room for it'
	);

	const wide = feedColumns(160, { repoWidth: 14, showAuthor: true });
	assert.ok(wide.branch > 0, 'the branch column is the last to arrive');
});

test('the author column is not drawn when every commit has the same author', () => {
	const columns = feedColumns(160, { repoWidth: 14, showAuthor: false });
	assert.equal(columns.author, 0);
	// The space it would have taken goes to the subject instead.
	const withAuthors = feedColumns(160, { repoWidth: 14, showAuthor: true });
	assert.ok(columns.subject > withAuthors.subject);
});

test('a very narrow terminal still produces a drawable row', () => {
	const columns = feedColumns(24, { repoWidth: 14, showAuthor: false });
	assert.ok(layoutWidth(columns) <= 24);
	assert.ok(columns.subject >= 0);
});

test('panes plus chrome add up to exactly the terminal height', () => {
	for (const rows of [10, 16, 24, 30, 40, 50, 60, 120]) {
		for (const panelOpen of [false, true]) {
			for (const repoCount of [1, 4, 8, 28]) {
				const split = splitRows(rows, { repoCount, panelOpen });
				assert.equal(
					split.panel + split.feed + split.chrome,
					rows,
					`${rows} rows, panel ${panelOpen}, ${repoCount} repos`
				);
				assert.ok(split.feed >= 1, 'the feed always gets at least one row');
			}
		}
	}
});

test('the panel never takes so much height that the feed is squeezed out', () => {
	const split = splitRows(16, { repoCount: 28, panelOpen: true });
	assert.ok(split.feed >= 4, `feed had ${split.feed} rows`);
	assert.ok(split.panel <= 8);
});

test('the window keeps the cursor visible', () => {
	// Cursor at the top: no scroll.
	assert.equal(windowFor(100, 10, 0, 0), 0);
	// Cursor below the fold: the window follows, keeping a margin of context beneath it.
	const offset = windowFor(100, 10, 12, 0);
	assert.ok(offset > 0);
	assert.ok(12 >= offset && 12 < offset + 10, 'the cursor must be inside the window');
	// Cursor at the very end: pinned to the last page, never past it.
	assert.equal(windowFor(100, 10, 99, 0), 90);
});

test('the window does not move while the cursor stays inside it', () => {
	const first = windowFor(100, 20, 30, 20);
	// Moving one row within the window must not shift it, or the whole list would scroll under the cursor.
	assert.equal(windowFor(100, 20, 31, first), first);
});

test('a list shorter than the window starts at the top', () => {
	assert.equal(windowFor(3, 20, 2, 0), 0);
	assert.equal(windowFor(0, 20, 0, 5), 0);
});

test('an offset left over from a longer list is clamped', () => {
	// The feed shrinks when a filter is typed; a stale offset must not leave the window past the end.
	assert.equal(windowFor(12, 10, 0, 90), 0);
	assert.ok(windowFor(12, 10, 11, 90) <= 2);
});

/**
 * The commit body's scroll geometry.
 *
 * The bug these exist for is a body that cannot be read: the pane counted the lines it was cutting and no key
 * reached them. So the assertion that matters is **every line is reachable** — not that the arithmetic looks
 * plausible, but that paging from the top actually lands on the last line.
 */
test('a body that fits has nothing to scroll', () => {
	const body = commitBody({ height: 40, lines: 6, full: false });
	assert.ok(body.budget >= 6);
	assert.equal(body.maxOffset, 0);
});

test('a long body reports exactly what is off screen', () => {
	const body = commitBody({ height: 40, lines: 60, full: false });
	// Half the pane, less the subject, the two gaps and the author line.
	assert.equal(body.budget, 16);
	assert.equal(body.maxOffset, 44);
	// The last page must end on the last line, never past it.
	assert.equal(body.maxOffset + body.budget, 60);
});

test('paging reaches the last line of any body, at any terminal height', () => {
	for (const height of [10, 24, 40, 52, 120]) {
		for (const lines of [1, 7, 20, 61, 400]) {
			for (const full of [false, true]) {
				const body = commitBody({ height, lines, full });
				const seen = new Set<number>();
				let offset = 0;
				// Walk the pages the key handler would produce, and record every line each one shows.
				for (let step = 0; step <= lines + 2; step++) {
					for (let line = offset; line < Math.min(lines, offset + body.budget); line++)
						seen.add(line);
					if (offset >= body.maxOffset) break;
					offset = Math.min(body.maxOffset, offset + body.page);
				}
				assert.equal(
					seen.size,
					lines,
					`height ${height}, ${lines} lines, full ${full}: ${lines - seen.size} unreachable`
				);
			}
		}
	}
});

test('expanding the message shows strictly more of it', () => {
	const half = commitBody({ height: 40, lines: 60, full: false });
	const whole = commitBody({ height: 40, lines: 60, full: true });
	assert.ok(whole.budget > half.budget);
	// And it cannot leave the body scrolled past its own end, which is what a stale offset would do.
	assert.ok(whole.maxOffset < half.maxOffset);
});

test('a pane too short to hold anything still yields a usable page', () => {
	// Never a zero or negative page: the key handler adds it to an offset and a zero would hang the scroll.
	for (const height of [1, 2, 3, 6, 7]) {
		const body = commitBody({ height, lines: 80, full: true });
		assert.ok(body.page >= 1, `height ${height} produced page ${body.page}`);
		assert.ok(body.budget >= 1);
	}
});
