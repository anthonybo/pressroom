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
import { feedColumns, layoutWidth, splitRows, windowFor } from './layout.ts';

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
