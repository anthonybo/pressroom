/**
 * How wide each column is, and which rows are on screen.
 *
 * Both calculations are here, as pure functions over numbers, for the same reason the git parsers are:
 * these are the two things that break silently. A column layout that assumes eighty columns produces a
 * feed that wraps every row into two on a narrow terminal — and because ink redraws by moving the cursor
 * up by the number of lines it thinks it printed, a single wrapped row makes every subsequent frame land
 * one line lower than the last and the display walks down the screen. Windowing has the same failure: draw
 * more rows than the terminal has and the top of the frame scrolls out of reach, taking the header with it.
 *
 * So nothing renders without asking these two functions first, and both are covered by tests that assert
 * the arithmetic adds up to exactly the available width.
 */

/** Widths in columns. Zero means the column is not drawn at this terminal size. */
export type FeedColumns = {
	/** Cursor plus the repo's color bar plus a space. */
	gutter: number;
	age: number;
	repo: number;
	branch: number;
	sha: number;
	subject: number;
	stats: number;
	author: number;
};

const GUTTER = 3;
const AGE = 4;
const SHA = 7;
const STATS = 10;
const AUTHOR = 12;
const BRANCH = 15;

/** Below this a subject is too short to tell you anything, so a column has to give way instead. */
const SUBJECT_MIN = 16;

/** One space between every pair of drawn columns. */
const GAP = 1;

/**
 * Columns are added in order of how much they earn their space. Age, repo, sha and subject are the row;
 * stats, author and branch are added only once there is room, and the subject takes whatever is left.
 *
 * `showAuthor` is decided by the caller rather than assumed, because on a single-developer account every row
 * holds the same name and twelve columns of "owner" repeated down the screen is twelve columns spent on
 * nothing.
 */
export function feedColumns(
	total: number,
	options: { repoWidth: number; showAuthor: boolean }
): FeedColumns {
	const columns: FeedColumns = {
		gutter: GUTTER,
		age: AGE,
		repo: Math.max(6, Math.min(16, options.repoWidth)),
		branch: 0,
		sha: SHA,
		subject: 0,
		stats: 0,
		author: 0
	};

	/**
	 * The four columns that are always drawn can themselves be wider than a narrow terminal: a sixteen-column
	 * repo name plus an age, a sha and their gaps is thirty-one columns before the subject gets any. So they
	 * shrink, in order of what can be given up — a repo name truncates and is still recognizable, a sha stays
	 * a valid prefix at four characters, and an age is already three or four.
	 *
	 * They shrink rather than disappear, because a column that vanishes would also have to take its
	 * separator with it, and a row assembled from optional separators is a row whose width depends on which
	 * branch of which condition ran.
	 */
	while (layoutWidth(columns) > total) {
		if (columns.repo > 4) columns.repo -= 1;
		else if (columns.sha > 4) columns.sha -= 1;
		else if (columns.age > 3) columns.age -= 1;
		// Below about twenty columns there is nothing left to give. The row is drawn with `wrap="truncate"`,
		// so ink cuts it at the terminal's edge rather than wrapping it onto a second line.
		else break;
	}

	/** What a new column could occupy: everything unspent, less the gap the column would need. */
	const room = () => total - layoutWidth(columns) - GAP;

	if (room() >= SUBJECT_MIN + STATS) columns.stats = STATS;
	if (options.showAuthor && room() >= SUBJECT_MIN + AUTHOR) columns.author = AUTHOR;
	// The branch is last and asks for the most headroom: it is the least often needed of the three.
	if (room() >= SUBJECT_MIN + BRANCH + 12) columns.branch = BRANCH;

	columns.subject = Math.max(0, room());
	return columns;
}

/** Total width a layout will occupy — must never exceed the terminal, and the tests check that. */
export function layoutWidth(columns: FeedColumns): number {
	const drawn = [
		columns.age,
		columns.repo,
		columns.branch,
		columns.sha,
		columns.subject,
		columns.stats,
		columns.author
	].filter((w) => w > 0);
	return (
		columns.gutter + drawn.reduce((sum, w) => sum + w, 0) + Math.max(0, drawn.length - 1) * GAP
	);
}

/**
 * Which row the visible window starts at.
 *
 * Keeps a margin of context around the cursor so that moving down does not pin the selection to the last
 * line, and stays put when the cursor is already comfortably inside the window — the previous offset is an
 * input, not something recomputed from scratch, so a list that is being appended to at the top does not
 * jump every time it grows.
 */
export function windowFor(
	total: number,
	viewport: number,
	cursor: number,
	previous: number
): number {
	if (viewport <= 0 || total <= viewport) return 0;

	const margin = Math.min(2, Math.floor(viewport / 4));
	const maxOffset = total - viewport;
	let offset = Math.min(Math.max(0, previous), maxOffset);

	if (cursor < offset + margin) offset = cursor - margin;
	else if (cursor > offset + viewport - 1 - margin) offset = cursor - viewport + 1 + margin;

	return Math.min(Math.max(0, offset), maxOffset);
}

/**
 * How much of a commit message is on screen, and how far it can be scrolled.
 *
 * The commit pane holds two things that both want the height: the message and the file list. A commit body
 * here is routinely thirty or forty lines — a paragraph explaining what was measured — and the file list of
 * the same commit can be eighteen entries, so neither can be given the pane outright.
 *
 * So the message gets half by default and can be scrolled through, and `m` gives it everything at the cost of
 * the file list. The arithmetic is here rather than in the component because the component is not the only
 * thing that needs it: the key handler has to clamp the scroll offset against the same numbers the renderer
 * uses, and two copies of this formula would drift into a message that scrolls one line past its own end.
 */
export function commitBody(options: {
	/** The pane's height in rows, chrome already subtracted. */
	height: number;
	/** How many lines the body has. */
	lines: number;
	/** Whether the message has been expanded over the file list. */
	full: boolean;
}): { budget: number; maxOffset: number; page: number } {
	// Reserved either way: up to two subject lines, the gap above the body, the gap below it, and the author
	// and date line. Expanded, the position indicator takes one more.
	const budget = options.full
		? Math.max(1, options.height - 6)
		: Math.max(0, Math.floor(options.height / 2) - 4);
	return {
		budget,
		maxOffset: Math.max(0, options.lines - budget),
		// One line of overlap, so a paragraph split across two pages still reads as continuous.
		page: Math.max(1, budget - 1)
	};
}

/**
 * Splits the terminal's rows between the repo panel and the feed.
 *
 * Thirty repos cannot all be listed above a feed on a forty-row terminal, and a panel that consumes the
 * screen defeats the point. The panel gets a bounded share of what is left after the chrome, ranked by
 * recency so the rows it does show are the repos being worked on; `r` hides it entirely when the feed wants
 * the height.
 */
export function splitRows(
	rows: number,
	options: { repoCount: number; panelOpen: boolean }
): { panel: number; feed: number; chrome: number } {
	// Header, feed rule, footer — plus the panel's own rule when the panel is open. This has to match what
	// the component tree actually draws, so `panel + feed + chrome === rows` exactly; the test asserts it.
	const chrome = options.panelOpen ? 4 : 3;
	const usable = Math.max(1, rows - chrome);

	if (!options.panelOpen) return { panel: 0, feed: usable, chrome };

	// At most a third of the usable height, at most eight repos, and never so much that the feed is left
	// with fewer than four rows.
	const wanted = Math.min(options.repoCount, 8, Math.floor(usable / 3));
	const panel = Math.max(0, Math.min(wanted, Math.max(0, usable - 4)));
	return { panel, feed: usable - panel, chrome };
}
