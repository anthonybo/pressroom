/**
 * Color.
 *
 * A cross-repo feed is unreadable without it: twenty rows of near-identical text where the only thing that
 * matters is which project each belongs to. So every repo gets a hue, carried by a solid bar in the left
 * gutter, and scanning for "what is happening in one-project" becomes looking for one color rather than reading
 * twenty names.
 *
 * **Everything here is an explicit value, not a palette slot.** The first version used chalk's `gray` for all
 * secondary text, and `gray` is not a color — it is ANSI slot 8, "bright black", and its actual value is
 * whatever the terminal's theme decides. On a dark theme that is a few percent off the background, and it was
 * carrying the age, the sha, the branch, the author, every rule and the whole footer: most of the screen, in
 * the one color you cannot read. Naming the value takes that decision away from the theme.
 *
 * A terminal's background cannot be discovered from inside the process, so nothing here can be tuned to it.
 * The neutrals are therefore held to a threshold against black *and* white, since they carry nearly all of the
 * text; the hues are dark-terminal-first and merely kept discernible on a light one. The reasoning for that
 * split is recorded beside the values.
 *
 * With twenty-nine repos against ten hues, collisions are certain; the repo's name is printed beside its bar on
 * every row precisely so the color never has to carry the meaning alone.
 *
 * `npm run check:contrast` measures all of it against both backgrounds and fails on anything too faint.
 */

/** Assigned by hash, not by position, so a repo keeps its color when another one is added beside it. */
export const PALETTE = [
	'#6f92ff', // blue
	'#d0894f', // copper
	'#79ab88', // sage
	'#d4696a', // brick
	'#b892d6', // violet
	'#57bcd0', // teal
	'#c8a53a', // gold
	'#d98cb4', // rose
	'#7fc9a6', // mint
	'#9aa5bb' // slate
];

/**
 * The sixteen-color fallback, named rather than converted. Left to itself, chalk narrows each hex to the
 * nearest of sixteen and lands several of the ten on the same value, which is worse than a smaller set used
 * deliberately.
 */
const BASIC = [
	'blue',
	'yellow',
	'green',
	'red',
	'magenta',
	'cyan',
	'yellow',
	'magenta',
	'green',
	'white'
];

/**
 * True color or 256 colors, from the two variables that report it. When neither says so — a pipe, a CI log,
 * `NO_COLOR` — chalk emits nothing at all, and every marker in the UI still carries its meaning as text.
 */
const RICH =
	/^(truecolor|24bit)$/.test(process.env.COLORTERM ?? '') ||
	/256|direct/.test(process.env.TERM ?? '');

/** FNV-1a. Small, stable, and dependent only on the name. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function accent(label: string): string {
	const index = hash(label) % PALETTE.length;
	return (RICH ? PALETTE[index] : BASIC[index]) ?? 'white';
}

/**
 * Two tiers of quiet, because "dim" was being asked to do two different jobs.
 *
 * `muted` is for text that is secondary but still **read**: the age, the sha, the branch, the author, a commit
 * body. `faint` is for chrome that only has to be *visible* — the rules and their labels — and can sit lower.
 * Collapsing them into one value meant either unreadable text or rules loud enough to compete with it.
 */
const MUTED = '#9aa2ad';
const FAINT = '#6e7681';

/**
 * The neutrals above are the only colors held to a genuinely dual-background standard, because they carry
 * almost all of the text. The hues below are tuned for a dark terminal and merely kept *discernible* on a
 * light one — a single value cannot be vivid on black and legible on white at once, and forcing every color
 * into the narrow band where both hold true produced a screen of washed-out mid-tones, which is the opposite
 * of the problem being solved. Nothing depends on a hue alone: `+42`, `✔`, `pushed` and `went live` all say
 * in text what the color says in passing.
 */

/** On sixteen colors there is no scale to speak of: `white` is the readable one, `gray` the quiet one. */
export const UI = RICH
	? ({
			rule: FAINT,
			faint: FAINT,
			/** Secondary text. Every existing use of the old single "dim" lands here, which is the fix. */
			dim: MUTED,
			muted: MUTED,
			/**
			 * No color at all, deliberately.
			 *
			 * The brightest tier is the one that cannot be named: a near-white that reads well on black is
			 * invisible on white — measured at 1.22:1 — and the reverse is equally true. Leaving it undefined
			 * hands the decision to the terminal's own foreground, which is correct on every background by
			 * definition. Weight carries the emphasis instead.
			 */
			label: undefined,
			added: '#5fc27e',
			removed: '#ff6b6b',
			hunk: '#57bcd0',
			fresh: '#f0b429',
			/** Pushes. Distinct from a commit's plain subject, so the two kinds of row read apart at a glance. */
			push: '#5ecfd6',
			/** Cloudflare deploys — the row that means the site itself changed. */
			live: '#c98bdb',
			warn: '#e0a72e',
			error: '#ff6b6b'
		} as const)
	: ({
			rule: 'gray',
			faint: 'gray',
			dim: 'white',
			muted: 'white',
			label: undefined,
			added: 'green',
			removed: 'red',
			hunk: 'cyan',
			fresh: 'yellowBright',
			push: 'cyan',
			live: 'magenta',
			warn: 'yellow',
			error: 'red'
		} as const);

/** The solid block that carries a repo's color in the gutter. */
export const BAR = '▌';
