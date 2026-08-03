/**
 * Measures every color in the theme against a black and a white terminal, and fails when one is too faint to
 * read.
 *
 *   node scripts/contrast.mjs
 *
 * This exists because the first palette used chalk's `gray`, which is not a color at all — it is ANSI palette
 * slot 8, "bright black", whose actual value is whatever the terminal's theme decides. On a dark theme that is
 * a few percent off the background, and it was carrying the age, the sha, the branch, the author, every rule
 * and the whole footer: most of the screen, in the one color you cannot read.
 *
 * A terminal's background cannot be discovered from inside the process, so nothing here can be tuned to it.
 * Every color therefore has to clear a threshold against **both** ends, which is what rules out the obvious
 * fix of simply making everything lighter.
 */
import { UI, PALETTE } from '../src/theme.ts';

/** WCAG relative luminance. */
function luminance(hex) {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(hex, against) {
	const a = luminance(hex);
	const b = luminance(against);
	const [light, dark] = a > b ? [a, b] : [b, a];
	return (light + 0.05) / (dark + 0.05);
}

const BLACK = '#000000';
const WHITE = '#ffffff';

/**
 * Text you read gets the higher bar; chrome that only has to be *visible* — rules, separators — gets the
 * lower one. Both are below the 4.5 of WCAG AA on the light end on purpose: a single color cannot reach 4.5
 * against black and white at once, and these are dark-terminal-first with light kept legible.
 */
const THRESHOLDS = {
	/** Neutrals, which carry nearly all the text: held to both ends. */
	text: { onBlack: 6, onWhite: 2.5 },
	/**
	 * Hues. Dark-terminal-first, and only required to stay *discernible* on a light one. A single value cannot
	 * be vivid on black and legible on white at once, and holding the hues to the neutral standard produced a
	 * screen of washed-out mid-tones — the opposite of the complaint that prompted this. Safe because no hue
	 * carries meaning alone: the text beside it always says the same thing.
	 */
	accent: { onBlack: 6, onWhite: 1.7 },
	/** Chrome that only has to be visible: rules and their labels. */
	chrome: { onBlack: 3.5, onWhite: 2 }
};

/** Which tier each named color has to satisfy. */
const TIERS = {
	muted: 'text',
	dim: 'text',
	faint: 'chrome',
	rule: 'chrome',
	added: 'accent',
	removed: 'accent',
	hunk: 'accent',
	fresh: 'accent',
	warn: 'accent',
	error: 'accent',
	push: 'accent',
	live: 'accent'
};

let failures = 0;

function check(name, hex, tier) {
	const onBlack = ratio(hex, BLACK);
	const onWhite = ratio(hex, WHITE);
	const need = THRESHOLDS[tier];
	const ok = onBlack >= need.onBlack && onWhite >= need.onWhite;
	if (!ok) failures++;
	console.log(
		`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${hex}  on black ${onBlack.toFixed(2).padStart(5)}:1` +
			`  on white ${onWhite.toFixed(2).padStart(5)}:1   (${tier}: needs ${need.onBlack}/${need.onWhite})`
	);
}

console.log('\n  interface colors\n');
for (const [name, value] of Object.entries(UI)) {
	if (typeof value !== 'string' || !value.startsWith('#')) continue;
	check(name, value, TIERS[name] ?? 'chrome');
}

console.log('\n  repo accents — one per project, so every one has to be readable\n');
for (const [index, hex] of PALETTE.entries()) check(`accent ${index}`, hex, 'accent');

console.log(
	failures ? `\n  ${failures} color(s) too faint\n` : '\n  every color clears its threshold\n'
);
process.exit(failures ? 1 : 0);
