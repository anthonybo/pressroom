/**
 * One commit, opened.
 *
 * The height is a fixed budget rather than whatever the content wants, because this pane sits inside a
 * frame that must add up to the terminal's row count exactly. A commit body is arbitrarily long — this
 * workspace writes paragraphs into them — so the message gets at most half the pane and the file list gets
 * the rest.
 *
 * Counting what was cut is not the same as being able to read it. The first version printed "… 13 more lines"
 * and stopped there, and since every movement key in this view drives the file list, those thirteen lines
 * could not be reached by any means — the pane reported its own failure and offered no way out of it. The body
 * now scrolls, `m` gives it the whole pane, and the line that counts the remainder names the keys that reach
 * it.
 */
import { Text } from 'ink';
import type { ReactNode } from 'react';
import { fit, padStart, stamp, truncate, width as columnsOf } from '../format.ts';
import { Rule } from './Chrome.tsx';
import { accent, BAR, UI } from '../theme.ts';
import { commitBody, windowFor } from '../layout.ts';
import type { Commit, FileChange } from '../types.ts';

export function CommitView({
	commit,
	files,
	state,
	cursor,
	offset,
	bodyOffset,
	bodyFull,
	height,
	columns
}: {
	commit: Commit;
	files: FileChange[];
	state: 'loading' | 'ready' | 'error';
	cursor: number;
	offset: number;
	/** First body line on screen. Scrolled by the page keys; clamped by the caller. */
	bodyOffset: number;
	/** The message expanded over the file list, for a body too long to read half a pane at a time. */
	bodyFull: boolean;
	height: number;
	columns: number;
}) {
	const color = accent(commit.repo);
	const rows: ReactNode[] = [];
	const blank = (key: string) => <Text key={key}> </Text>;

	// Subject, on up to two lines — long subjects are common and cutting one at the first line loses the
	// half that says what actually changed.
	const subjectLines = wrap(commit.subject, Math.max(10, columns - 4)).slice(0, 2);
	subjectLines.forEach((line, index) => {
		rows.push(
			<Text key={`subject${index}`} wrap="truncate">
				<Text> </Text>
				<Text color={color}>{index === 0 ? BAR : ' '}</Text>
				<Text bold> {line}</Text>
			</Text>
		);
	});

	// Half the pane at most, so the file list is never squeezed out by a long message — unless the message has
	// been expanded on purpose, in which case it takes the lot.
	const bodyLines = commit.body ? commit.body.split('\n') : [];
	const { budget, maxOffset } = commitBody({ height, lines: bodyLines.length, full: bodyFull });
	const bodyStart = Math.min(Math.max(0, bodyOffset), maxOffset);
	const shown = bodyLines.slice(bodyStart, bodyStart + budget);

	if (shown.length) {
		rows.push(blank('bodygap'));
		shown.forEach((line, index) => {
			rows.push(
				<Text key={`body${index}`} color={UI.dim} wrap="truncate">
					{'   '}
					{truncate(line, Math.max(0, columns - 4))}
				</Text>
			);
		});
		/**
		 * What is off screen, in both directions, and how to reach it.
		 *
		 * The old note counted only what was below and said nothing about how to get there, so a message longer
		 * than the pane was simply unreadable and looked like it was meant to be. Naming the keys in the line
		 * that reports the problem is the whole fix; a legend two keystrokes away is not where anyone looks.
		 */
		const above = bodyStart;
		const below = bodyLines.length - (bodyStart + shown.length);
		if (above || below) {
			const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
			const where =
				above && below
					? `↑ ${lines(above)}  ·  ↓ ${lines(below)}`
					: below
						? `${lines(below)} below`
						: `${lines(above)} above`;
			rows.push(
				<Text key="bodymore" color={UI.dim} wrap="truncate">
					{'   '}
					{truncate(
						`… ${where}  ·  ⇞⇟ scroll  ·  ${bodyFull ? 'm shrinks' : 'm expands'}`,
						Math.max(0, columns - 4)
					)}
				</Text>
			);
		}
	}

	rows.push(blank('metagap'));
	rows.push(
		<Text key="meta" color={UI.dim} wrap="truncate">
			{'   '}
			{truncate(
				[
					`${commit.author} <${commit.email}>`,
					stamp(commit.committed),
					commit.short,
					commit.refs ? commit.refs : ''
				]
					.filter(Boolean)
					.join('  ·  '),
				Math.max(0, columns - 4)
			)}
		</Text>
	);
	if (commit.parents.length > 1) {
		rows.push(
			<Text key="parents" color={UI.dim} wrap="truncate">
				{`   merge of ${commit.parents.map((p) => p.slice(0, 7)).join(' + ')}`}
			</Text>
		);
	}

	// The file list takes whatever is left, minus its own rule.
	const listHeight = Math.max(0, height - rows.length - 1);
	const totals = files.reduce(
		(sum, file) => ({
			plus: sum.plus + (file.insertions ?? 0),
			minus: sum.minus + (file.deletions ?? 0)
		}),
		{ plus: 0, minus: 0 }
	);
	const note =
		state === 'loading'
			? 'reading…'
			: state === 'error'
				? 'unreadable'
				: `${files.length} file${files.length === 1 ? '' : 's'}  +${totals.plus} −${totals.minus}`;

	rows.push(<Rule key="filesrule" label="files" note={note} columns={columns} />);

	const start = windowFor(files.length, listHeight, cursor, offset);
	const visible = files.slice(start, start + listHeight);

	if (state === 'loading' && !files.length) {
		rows.push(
			<Text key="loading" color={UI.dim}>
				{'   reading the file list…'}
			</Text>
		);
	}

	visible.forEach((file, index) => {
		const absolute = start + index;
		rows.push(
			<FileRow
				key={`${file.path}:${absolute}`}
				file={file}
				selected={absolute === cursor}
				columns={columns}
			/>
		);
	});

	// Padded to the exact budget: a pane that returns fewer rows than it was given makes everything below
	// it move as the content changes.
	while (rows.length < height) rows.push(blank(`pad${rows.length}`));

	return <>{rows.slice(0, height)}</>;
}

const STATUS_COLOR: Record<string, string> = {
	A: UI.added,
	D: UI.removed,
	M: UI.hunk,
	R: UI.warn,
	C: UI.warn,
	T: UI.warn,
	U: UI.error
};

function FileRow({
	file,
	selected,
	columns
}: {
	file: FileChange;
	selected: boolean;
	columns: number;
}) {
	const stats = 12;
	const pathWidth = Math.max(8, columns - 6 - stats);
	// A rename is only comprehensible with both names, and the old one is what you are looking for.
	const label = file.from ? `${file.from} → ${file.path}` : file.path;

	return (
		<Text wrap="truncate" inverse={selected}>
			<Text color={UI.dim}>{selected ? '▸' : ' '}</Text>
			<Text color={STATUS_COLOR[file.status] ?? UI.dim} bold>
				{` ${file.status.padEnd(2)} `}
			</Text>
			<Text>{fit(label, pathWidth)}</Text>
			{file.insertions === null ? (
				<Text color={UI.dim}>{padStart('binary', stats)}</Text>
			) : (
				<Text>
					<Text color={UI.added}>
						{padStart(file.insertions ? `+${file.insertions}` : '', stats - 5)}
					</Text>
					<Text color={UI.removed}>{padStart(file.deletions ? `−${file.deletions}` : '', 5)}</Text>
				</Text>
			)}
		</Text>
	);
}

/** Word wrap to a column count, measuring width rather than counting characters. */
function wrap(text: string, max: number): string[] {
	if (max <= 0) return [text];
	const words = text.split(' ');
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (columnsOf(candidate) > max && line) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines;
}
