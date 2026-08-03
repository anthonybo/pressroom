/**
 * One commit, opened.
 *
 * The height is a fixed budget rather than whatever the content wants, because this pane sits inside a
 * frame that must add up to the terminal's row count exactly. A commit body is arbitrarily long — this
 * workspace writes paragraphs into them — so the message gets at most half the pane and the file list gets
 * the rest, with what was cut counted rather than silently dropped.
 */
import { Text } from 'ink';
import type { ReactNode } from 'react';
import { fit, padStart, stamp, truncate, width as columnsOf } from '../format.ts';
import { Rule } from './Chrome.tsx';
import { accent, BAR, UI } from '../theme.ts';
import { windowFor } from '../layout.ts';
import type { Commit, FileChange } from '../types.ts';

export function CommitView({
	commit,
	files,
	state,
	cursor,
	offset,
	height,
	columns
}: {
	commit: Commit;
	files: FileChange[];
	state: 'loading' | 'ready' | 'error';
	cursor: number;
	offset: number;
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

	// Half the pane at most, so the file list is never squeezed out by a long message.
	const bodyBudget = Math.max(0, Math.floor(height / 2) - 4);
	const bodyLines = commit.body ? commit.body.split('\n') : [];
	const shown = bodyLines.slice(0, bodyBudget);

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
		if (bodyLines.length > shown.length) {
			rows.push(
				<Text key="bodymore" color={UI.dim} wrap="truncate">
					{`   … ${bodyLines.length - shown.length} more lines`}
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
