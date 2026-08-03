/**
 * Header, section rules and footer — everything that frames the content.
 *
 * The rules do real work here rather than decoration: with a repo panel above a feed above a detail pane,
 * a labelled rule is what tells you which list you are looking at and how much of it there is. Each one
 * carries a count on the right, so `── commits ─── 312 ─ 3 new ──` answers "is anything happening" without
 * reading a single row.
 */
import { Text } from 'ink';
import { UI } from '../theme.ts';
import { truncate, width } from '../format.ts';

/** A horizontal rule with an optional label on the left and a note on the right. */
export function Rule({ label, note, columns }: { label?: string; note?: string; columns: number }) {
	const left = label ? `── ${label} ` : '';
	const right = note ? ` ${note} ──` : '';
	const fill = Math.max(0, columns - width(left) - width(right));

	return (
		<Text color={UI.faint} wrap="truncate">
			{left}
			{'─'.repeat(fill)}
			{right}
		</Text>
	);
}

/**
 * The title bar. Left side says what is being watched, right side says whether it is still live — a
 * dashboard that has quietly stopped updating looks identical to one where nothing is happening, so the
 * clock ticking is the proof that it has not.
 */
export function Header({
	root,
	repoCount,
	commitCount,
	pushCount,
	runCount,
	liveCount,
	arrived,
	paused,
	scope,
	loading,
	local,
	time,
	columns
}: {
	root: string;
	repoCount: number;
	commitCount: number;
	pushCount: number;
	runCount: number;
	liveCount: number;
	arrived: number;
	paused: boolean;
	scope: string;
	loading: number;
	local: boolean;
	time: string;
	columns: number;
}) {
	const plural = (count: number, word: string, suffix = 's') =>
		`${count} ${word}${count === 1 ? '' : suffix}`;
	const parts = [plural(repoCount, 'repo'), plural(commitCount, 'commit')];
	if (pushCount > 0) parts.push(plural(pushCount, 'push', 'es'));
	if (runCount > 0) parts.push(plural(runCount, 'run'));
	if (liveCount > 0) parts.push(plural(liveCount, 'deploy'));
	if (loading > 0) parts.push(`reading ${loading}…`);
	if (arrived > 0) parts.push(`${arrived} new`);
	if (scope !== 'branches') parts.push(`scope:${scope}`);
	// Stated, because a `--local` session looks exactly like one where nothing has ever been deployed.
	if (local) parts.push('local only');

	const left = ` pressroom  ${root}  ·  ${parts.join('  ·  ')}`;
	const right = paused ? `paused  ${time} ` : `live  ${time} `;
	const fill = Math.max(1, columns - width(left) - width(right));

	return (
		<Text wrap="truncate">
			<Text bold>{truncate(left, Math.max(0, columns - width(right) - 1))}</Text>
			<Text>{' '.repeat(fill)}</Text>
			<Text color={paused ? UI.warn : UI.dim}>{right}</Text>
		</Text>
	);
}

/** The key hints. Contextual, because a diff pane and a feed do not take the same keys. */
export function Footer({ hints, columns }: { hints: [string, string][]; columns: number }) {
	return (
		<Text wrap="truncate">
			{hints.map(([key, label], index) => (
				<Text key={key + label}>
					{index === 0 ? ' ' : '  '}
					<Text bold color={UI.label}>
						{key}
					</Text>
					<Text color={UI.dim}>{` ${label}`}</Text>
				</Text>
			))}
			<Text>{' '.repeat(Math.max(0, columns - hintsWidth(hints)))}</Text>
		</Text>
	);
}

function hintsWidth(hints: [string, string][]): number {
	return hints.reduce(
		(sum, [key, label], index) => sum + (index === 0 ? 1 : 2) + width(key) + 1 + width(label),
		0
	);
}
