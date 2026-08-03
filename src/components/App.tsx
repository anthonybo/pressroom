/**
 * The frame, the keyboard, and which view is on screen.
 *
 * Two decisions shape most of this file.
 *
 * **The selection is a commit, not a row number.** The list is being appended to at the top while you read
 * it. Holding an index means that the moment a commit lands in any of twenty-eight repos, the cursor is
 * pointing at a different commit than it was a second ago — and if you press enter at the wrong moment you
 * open something you were not looking at. Holding the identity of the selected commit and finding its row
 * each render costs nothing and cannot do that. When no commit is held, the cursor tracks the top of the
 * list, so the default behavior is to follow the newest arrival.
 *
 * **Every view renders exactly as many rows as the terminal has.** Ink redraws by moving the cursor up over
 * what it printed last time, so a frame one line taller than the terminal scrolls the top away and the next
 * frame is drawn in the wrong place. Each pane is handed a row budget and pads itself to fill it.
 */
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Engine, Snapshot } from '../engine.ts';
import { clock, fit } from '../format.ts';
import { feedColumns, splitRows, windowFor } from '../layout.ts';
import {
	deployStatePerRepo,
	filterItems,
	isItemFresh,
	isUnread,
	keyOf,
	resolveCursor,
	timeline,
	typicalRunMs,
	unreadAbove,
	unreadCount
} from '../store.ts';
import { UI } from '../theme.ts';
import type { Deploy, FileChange, Run, Scope, View } from '../types.ts';
import { copy } from '../clipboard.ts';
import { Footer, Header, Rule } from './Chrome.tsx';
import { DeployRow, FeedEmpty, FeedRow, PushRow, RepoRow, RunRow } from './Feed.tsx';
import { CommitView } from './CommitView.tsx';
import { DiffView } from './DiffView.tsx';
import { useNow, useTerminalSize } from './hooks.ts';

const SCOPES: Scope[] = ['branches', 'head', 'all'];

type LoadState = 'loading' | 'ready' | 'error';

export function App({ engine, root }: { engine: Engine; root: string }) {
	const { columns, rows } = useTerminalSize();
	const now = useNow();
	const { exit } = useApp();

	const [snapshot, setSnapshot] = useState<Snapshot>(() => engine.snapshot());
	useEffect(() => engine.subscribe(setSnapshot), [engine]);

	const [view, setView] = useState<View>({ kind: 'feed' });
	const [panelOpen, setPanelOpen] = useState(true);
	const [filter, setFilter] = useState('');
	const [filtering, setFiltering] = useState(false);
	const [bell, setBell] = useState(false);
	const [flash, setFlash] = useState<string | null>(null);

	const [selected, setSelected] = useState<string | null>(null);
	/**
	 * Whether the cursor tracks the newest row, or stays where it was put.
	 *
	 * A state of its own rather than "the cursor happens to be at row zero", because those are different things
	 * and conflating them was a bug: sitting on the top row meant arrivals took the cursor with them. Starts on,
	 * so left alone the dashboard behaves like a live feed; any movement key turns it off and the cursor stops
	 * moving on its own.
	 */
	const [following, setFollowing] = useState(true);
	/**
	 * When the cursor left the newest row, or null while it is following the top.
	 *
	 * Everything that arrives after this stays marked until the cursor returns to the top — which is the whole
	 * point: the twelve-second freshness flash is right while you are watching and useless if you walk away.
	 */
	const [markAt, setMarkAt] = useState<number | null>(null);
	const [feedOffset, setFeedOffset] = useState(0);
	const [fileCursor, setFileCursor] = useState(0);
	const [fileOffset, setFileOffset] = useState(0);
	const [diffOffset, setDiffOffset] = useState(0);

	const [files, setFiles] = useState<FileChange[]>([]);
	const [filesState, setFilesState] = useState<LoadState>('loading');
	const [diff, setDiff] = useState<string[]>([]);
	const [diffState, setDiffState] = useState<LoadState>('loading');

	// ------------------------------------------------------------------------------------------------
	// The list, and where the cursor is in it
	// ------------------------------------------------------------------------------------------------

	const list = useMemo(
		() =>
			filterItems(
				timeline(snapshot.feed, snapshot.pushes, snapshot.runs, snapshot.deploys),
				filter
			),
		[snapshot.feed, snapshot.pushes, snapshot.runs, snapshot.deploys, filter]
	);
	const lastIndex = useRef(0);

	const cursor = useMemo(
		() => resolveCursor(list, { following, selected, lastIndex: lastIndex.current }),
		[list, following, selected]
	);

	useEffect(() => {
		lastIndex.current = cursor;
	}, [cursor]);

	const moveTo = (next: number) => {
		if (!list.length) return;
		const clamped = Math.max(0, Math.min(list.length - 1, next));
		lastIndex.current = clamped;
		const target = list[clamped];
		setSelected(target ? keyOf(target) : null);

		// Any movement means the cursor is yours now: it stops following, and arrivals start being marked so
		// that whatever lands while you are reading — or away — is still identifiable when you look up.
		setFollowing(false);
		setMarkAt((held) => held ?? Date.now());
	};

	// ------------------------------------------------------------------------------------------------
	// Arrivals: the bell, and keeping the fresh highlight ticking
	// ------------------------------------------------------------------------------------------------

	const lastBell = useRef(0);
	useEffect(
		() =>
			engine.onArrivals(() => {
				if (!bell) return;
				// Rate limited, because a rebase of twenty commits arrives as twenty arrivals and a terminal
				// asked to ring twenty times in a second is unpleasant enough to make you turn it off.
				const at = Date.now();
				if (at - lastBell.current < 2000) return;
				lastBell.current = at;
				process.stdout.write('\u0007');
			}),
		[engine, bell]
	);

	/**
	 * Deploys failing to load is reported once, not silently.
	 *
	 * With no note, a logged-out `gh` looks exactly like a workspace where nobody has deployed anything —
	 * and the fix (`gh auth login`) is not one you would think to try. Shown once per distinct reason, so a
	 * flapping connection does not take over the footer.
	 */
	const reportedGithub = useRef<string | null>(null);
	useEffect(() => {
		const error = snapshot.githubError;
		if (!error || reportedGithub.current === error) return;
		reportedGithub.current = error;
		setFlash(`workflow runs unavailable — ${error}`);
	}, [snapshot.githubError]);

	const reportedCloudflare = useRef<string | null>(null);
	useEffect(() => {
		const error = snapshot.cloudflareError;
		if (!error || reportedCloudflare.current === error) return;
		reportedCloudflare.current = error;
		setFlash(`Cloudflare deploys unavailable — ${error}`);
	}, [snapshot.cloudflareError]);

	/**
	 * Say so when the watched set changes.
	 *
	 * New repos appear here constantly, and a dashboard that quietly grows by one row gives you no way to tell
	 * whether it noticed the client repo you just created or is simply not looking.
	 */
	useEffect(
		() =>
			engine.onRepos(({ added, removed }) => {
				const names = [...added, ...removed].map((repo) => repo.label);
				const verb =
					added.length && removed.length ? 'repos changed' : added.length ? 'now watching' : 'gone';
				setFlash(
					`${verb} ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`
				);
			}),
		[engine]
	);

	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(null), 2000);
		return () => clearTimeout(timer);
	}, [flash]);

	// ------------------------------------------------------------------------------------------------
	// Detail loading
	// ------------------------------------------------------------------------------------------------

	const detail =
		view.kind === 'commit' || view.kind === 'diff' ? { repo: view.repo, sha: view.sha } : null;

	useEffect(() => {
		if (!detail) return;
		let alive = true;
		setFilesState('loading');
		engine
			.files(detail.repo, detail.sha)
			.then((result) => {
				if (!alive) return;
				setFiles(result);
				setFilesState('ready');
			})
			.catch(() => alive && setFilesState('error'));
		return () => {
			alive = false;
		};
	}, [engine, detail?.repo, detail?.sha]);

	const path = view.kind === 'diff' ? view.path : null;

	useEffect(() => {
		if (!detail || !path) return;
		let alive = true;
		setDiffState('loading');
		engine
			.diff(detail.repo, detail.sha, path)
			.then((lines) => {
				if (!alive) return;
				setDiff(lines);
				setDiffState('ready');
			})
			.catch(() => alive && setDiffState('error'));
		return () => {
			alive = false;
		};
	}, [engine, detail?.repo, detail?.sha, path]);

	// ------------------------------------------------------------------------------------------------
	// Layout
	// ------------------------------------------------------------------------------------------------

	const repoWidth = useMemo(
		() => Math.min(16, Math.max(6, ...snapshot.repos.map((repo) => repo.label.length))),
		[snapshot.repos]
	);
	/**
	 * Whether the author column is worth twelve columns.
	 *
	 * "More than one distinct author" is the obvious test and it is useless here: across twenty-eight repos
	 * going back years there is always some commit authored under an old git config or through a web UI, so
	 * the column would be permanently on and permanently repeating one name. What matters is whether the
	 * authorship is actually *mixed* — so the column appears only when no single person wrote almost all of
	 * what is on the feed.
	 */
	const showAuthor = useMemo(() => {
		if (snapshot.feed.length < 2) return false;
		const counts = new Map<string, number>();
		for (const commit of snapshot.feed)
			counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
		if (counts.size < 2) return false;
		return Math.max(...counts.values()) / snapshot.feed.length < 0.9;
	}, [snapshot.feed]);

	const columnPlan = feedColumns(columns, { repoWidth, showAuthor });
	const split = splitRows(rows, { repoCount: snapshot.repos.length, panelOpen });

	/**
	 * The newest run and the newest Cloudflare deploy per repo, for the panel's two glyph columns.
	 *
	 * Both are needed and neither substitutes for the other: `app` has no workflows at all, so a panel
	 * looking only at Actions runs left it blank while the feed said "app went live" — and a panel looking
	 * only at whichever was newer hid every pass-or-fail, because the deploy a workflow performs always lands
	 * after the run that performed it.
	 */
	const deployStates = useMemo(
		() => deployStatePerRepo(snapshot.runs, snapshot.deploys),
		[snapshot.runs, snapshot.deploys]
	);

	const ranked = useMemo(() => {
		return [...snapshot.repos].sort((a, b) => {
			const at = snapshot.lastCommitMs.get(a.label) ?? 0;
			const bt = snapshot.lastCommitMs.get(b.label) ?? 0;
			return bt - at || a.label.localeCompare(b.label);
		});
	}, [snapshot.repos, snapshot.lastCommitMs]);

	const feedStart = windowFor(list.length, split.feed, cursor, feedOffset);
	useEffect(() => {
		if (feedStart !== feedOffset) setFeedOffset(feedStart);
	}, [feedStart, feedOffset]);

	const unread = unreadCount(list, markAt);
	const above = unreadAbove(list, markAt, feedStart);
	// Only counts as "just arrived" while the cursor is following; once parked, the persistent mark takes over.
	const fresh = markAt === null ? list.filter((item) => isItemFresh(item, now)).length : 0;

	// ------------------------------------------------------------------------------------------------
	// Keys
	// ------------------------------------------------------------------------------------------------

	const openCommit = () => {
		const item = list[cursor];
		if (!item) return;

		if (item.kind === 'deploy') {
			// Cloudflare's record carries no commit sha, so there is nothing honest to open here.
			setFlash('a Cloudflare deploy has no commit attached — y copies its version id');
			return;
		}

		if (item.kind !== 'commit') {
			// Neither a push nor a deploy has anything of its own to show, so both open the commit they refer
			// to. That commit is only loadable if it is in the feed, which for anything recent it is.
			const target = item.kind === 'push' ? item.push : item.run;
			const landed = snapshot.feed.find(
				(commit) => commit.repo === target.repo && commit.sha === target.sha
			);
			if (!landed) {
				setFlash('that commit is outside the loaded history');
				return;
			}
			setFiles([]);
			setFileCursor(0);
			setFileOffset(0);
			setView({ kind: 'commit', repo: landed.repo, sha: landed.sha });
			return;
		}

		setFiles([]);
		setFileCursor(0);
		setFileOffset(0);
		setView({ kind: 'commit', repo: item.commit.repo, sha: item.commit.sha });
	};

	const openDiff = () => {
		if (view.kind !== 'commit') return;
		const file = files[fileCursor];
		if (!file) return;
		setDiff([]);
		setDiffOffset(0);
		setView({ kind: 'diff', repo: view.repo, sha: view.sha, path: file.path });
	};

	const yank = () => {
		const item = list[cursor];

		// What is worth copying differs by row. On a **workflow run** it is the URL — a failed run is something
		// you go and look at, and the link is what you need. On a **Cloudflare deploy** there is no sha and no
		// page to open, so it is the version id. Everywhere else it is the sha.
		const target =
			view.kind === 'commit' || view.kind === 'diff'
				? { text: view.sha, label: view.sha.slice(0, 12) }
				: item?.kind === 'run'
					? { text: item.run.url, label: 'the run link' }
					: item?.kind === 'deploy'
						? {
								text: item.deploy.versionId,
								label: 'version ' + item.deploy.versionId.slice(0, 8)
							}
						: item?.kind === 'push'
							? { text: item.push.sha, label: item.push.short }
							: item?.kind === 'commit'
								? { text: item.commit.sha, label: item.commit.short }
								: null;

		if (!target?.text) return;
		copy(target.text)
			.then(() => setFlash(`copied ${target.label}`))
			.catch(() => setFlash('could not reach the clipboard'));
	};

	useInput((input, key) => {
		// Filter entry swallows everything: a `p` typed into a search box must not pause the feed.
		if (filtering) {
			if (key.escape) {
				setFiltering(false);
				setFilter('');
			} else if (key.return) {
				setFiltering(false);
			} else if (key.backspace || key.delete) {
				setFilter((current) => current.slice(0, -1));
			} else if (input && !key.ctrl && !key.meta) {
				setFilter((current) => current + input);
			}
			return;
		}

		if (input === 'q' || (key.ctrl && input === 'c')) {
			exit();
			return;
		}
		if (input === '?') {
			setView((current) => (current.kind === 'help' ? { kind: 'feed' } : { kind: 'help' }));
			return;
		}
		if (view.kind === 'help') {
			setView({ kind: 'feed' });
			return;
		}

		// Always available.
		if (input === 'p') {
			engine.setPaused(!snapshot.paused);
			return;
		}
		if (input === 'b') {
			setBell((current) => {
				setFlash(current ? 'bell off' : 'bell on');
				return !current;
			});
			return;
		}
		if (input === 'y') {
			yank();
			return;
		}
		if (input === 'R') {
			engine.refreshAll();
			setFlash('refreshing every repo');
			return;
		}
		if (input === 'a') {
			const next = SCOPES[(SCOPES.indexOf(snapshot.scope) + 1) % SCOPES.length] ?? 'branches';
			engine.setScope(next);
			setFlash(
				`following ${next === 'head' ? 'the checked-out branch' : next === 'all' ? 'all refs, remotes included' : 'local branches'}`
			);
			return;
		}

		if (view.kind === 'diff') {
			const page = Math.max(1, split.feed - 2);
			if (key.escape || key.leftArrow || input === 'h') {
				setView({ kind: 'commit', repo: view.repo, sha: view.sha });
			} else if (key.downArrow || input === 'j')
				setDiffOffset((o) => Math.min(diff.length - 1, o + 1));
			else if (key.upArrow || input === 'k') setDiffOffset((o) => Math.max(0, o - 1));
			else if (key.pageDown || (key.ctrl && input === 'd'))
				setDiffOffset((o) => Math.min(Math.max(0, diff.length - 1), o + page));
			else if (key.pageUp || (key.ctrl && input === 'u'))
				setDiffOffset((o) => Math.max(0, o - page));
			else if (input === 'g') setDiffOffset(0);
			else if (input === 'G') setDiffOffset(Math.max(0, diff.length - 1));
			return;
		}

		if (view.kind === 'commit') {
			if (key.escape || key.leftArrow || input === 'h') {
				setView({ kind: 'feed' });
			} else if (key.return || key.rightArrow || input === 'l') openDiff();
			else if (key.downArrow || input === 'j')
				setFileCursor((c) => Math.min(Math.max(0, files.length - 1), c + 1));
			else if (key.upArrow || input === 'k') setFileCursor((c) => Math.max(0, c - 1));
			else if (input === 'g') setFileCursor(0);
			else if (input === 'G') setFileCursor(Math.max(0, files.length - 1));
			return;
		}

		// The feed.
		const page = Math.max(1, split.feed - 2);
		if (key.downArrow || input === 'j') moveTo(cursor + 1);
		else if (key.upArrow || input === 'k') moveTo(cursor - 1);
		else if (key.pageDown || (key.ctrl && input === 'd')) moveTo(cursor + page);
		else if (key.pageUp || (key.ctrl && input === 'u')) moveTo(cursor - page);
		else if (input === 'g') {
			// Back to following the newest, which is also what marks the new rows read: going to look at them is
			// the only thing that should.
			setSelected(null);
			lastIndex.current = 0;
			setFollowing(true);
			setMarkAt(null);
		} else if (input === 'G') moveTo(list.length - 1);
		else if (key.return || key.rightArrow || input === 'l') openCommit();
		else if (input === '/') setFiltering(true);
		else if (key.escape && filter) setFilter('');
		else if (input === 'r') setPanelOpen((open) => !open);
	});

	// ------------------------------------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------------------------------------

	const header = (
		<Header
			root={root}
			repoCount={snapshot.repos.length}
			commitCount={snapshot.feed.length}
			pushCount={snapshot.pushes.length}
			runCount={snapshot.runs.length}
			liveCount={snapshot.deploys.length}
			arrived={snapshot.arrived}
			paused={snapshot.paused}
			scope={snapshot.scope}
			loading={snapshot.repos.length - snapshot.loaded}
			local={snapshot.local}
			time={clock(new Date(now))}
			columns={columns}
		/>
	);

	const jumpHint: [string, string][] = unread ? [['g', `${unread} new — jump`]] : [];
	const footer = flash ? (
		<Text color={UI.fresh} wrap="truncate">
			{fit(` ${flash}`, columns)}
		</Text>
	) : filtering ? (
		<Text wrap="truncate">
			<Text color={UI.fresh}>{' filter: '}</Text>
			<Text bold>{filter}</Text>
			<Text color={UI.dim}>{'▏  enter to keep  ·  esc to clear'}</Text>
		</Text>
	) : (
		<Footer
			hints={[...jumpHint, ...hintsFor(view.kind, snapshot.paused, bell)]}
			columns={columns}
		/>
	);

	if (view.kind === 'help') {
		return (
			<Box flexDirection="column" width={columns}>
				{header}
				<Rule label="keys" columns={columns} />
				<Help height={Math.max(1, rows - 3)} columns={columns} />
				{footer}
			</Box>
		);
	}

	if (view.kind === 'diff') {
		return (
			<Box flexDirection="column" width={columns}>
				{header}
				<Rule
					label={view.path}
					note={`${view.repo} ${view.sha.slice(0, 7)}  ·  ${diff.length} lines`}
					columns={columns}
				/>
				<DiffView
					lines={diff}
					state={diffState}
					offset={diffOffset}
					height={Math.max(1, rows - 3)}
					columns={columns}
				/>
				{footer}
			</Box>
		);
	}

	if (view.kind === 'commit') {
		const commit = snapshot.feed.find((c) => c.repo === view.repo && c.sha === view.sha);
		return (
			<Box flexDirection="column" width={columns}>
				{header}
				<Rule label="commit" note={view.repo} columns={columns} />
				{commit ? (
					<CommitView
						commit={commit}
						files={files}
						state={filesState}
						cursor={fileCursor}
						offset={fileOffset}
						height={Math.max(1, rows - 3)}
						columns={columns}
					/>
				) : (
					// The commit was rewritten out of history while it was open — an amend or a reset in
					// another window. Saying so is better than an empty pane or a crash.
					<Gone height={Math.max(1, rows - 3)} />
				)}
				{footer}
			</Box>
		);
	}

	const visible = list.slice(feedStart, feedStart + split.feed);
	const feedRows = [];
	if (!list.length) {
		feedRows.push(
			<FeedEmpty
				key="empty"
				columns={columns}
				message={
					snapshot.loaded < snapshot.repos.length
						? 'reading the repos…'
						: filter
							? `nothing matches "${filter}"`
							: 'no commits found'
				}
			/>
		);
	}
	visible.forEach((item, index) => {
		const selected = feedStart + index === cursor;
		feedRows.push(
			item.kind === 'deploy' ? (
				<DeployRow
					key={keyOf(item)}
					deploy={item.deploy}
					columns={columnPlan}
					selected={selected}
					now={now}
					fresh={isItemFresh(item, now) || isUnread(item, markAt)}
				/>
			) : item.kind === 'run' ? (
				<RunRow
					key={keyOf(item)}
					run={item.run}
					columns={columnPlan}
					selected={selected}
					now={now}
					fresh={isItemFresh(item, now) || isUnread(item, markAt)}
					typicalMs={typicalRunMs(snapshot.runs, item.run.repo, item.run.workflow)}
				/>
			) : item.kind === 'push' ? (
				<PushRow
					key={keyOf(item)}
					push={item.push}
					columns={columnPlan}
					selected={selected}
					now={now}
					fresh={isItemFresh(item, now) || isUnread(item, markAt)}
				/>
			) : (
				<FeedRow
					key={keyOf(item)}
					commit={item.commit}
					columns={columnPlan}
					selected={selected}
					now={now}
					branch={refLabel(item.commit.refs)}
					fresh={isItemFresh(item, now) || isUnread(item, markAt)}
				/>
			)
		);
	});
	while (feedRows.length < split.feed) feedRows.push(<Text key={`pad${feedRows.length}`}> </Text>);

	return (
		<Box flexDirection="column" width={columns}>
			{header}
			{panelOpen && (
				<Rule
					label="repos"
					note={`${split.panel} of ${snapshot.repos.length} by last commit`}
					columns={columns}
				/>
			)}
			{panelOpen &&
				ranked
					.slice(0, split.panel)
					.map((repo) => (
						<RepoRow
							key={repo.label}
							label={repo.label}
							status={snapshot.statuses.get(repo.label)}
							error={snapshot.errors.get(repo.label)}
							lastCommitMs={snapshot.lastCommitMs.get(repo.label)}
							deployState={deployStates.get(repo.label)}
							now={now}
							columns={columns}
							labelWidth={repoWidth}
						/>
					))}
			<Rule
				label="commits"
				note={[
					filter ? `filter "${filter}"` : '',
					`${list.length}`,
					fresh ? `${fresh} just arrived` : '',
					// Where they are matters as much as how many: on screen you just read them, above it you
					// press g. Without this the new rows are simply gone from view with nothing to say so.
					unread ? (above ? `↑ ${above} new above` : `${unread} new`) : '',
					following ? 'following' : ''
				]
					.filter(Boolean)
					.join('  ·  ')}
				columns={columns}
			/>
			{feedRows.slice(0, split.feed)}
			{footer}
		</Box>
	);
}

/**
 * `%D` gives every ref pointing at a commit — `HEAD -> dev, origin/dev, tag: v2`. The local branch is the
 * useful one, so it wins; a commit that is only a remote tip still shows something rather than nothing.
 */
function refLabel(refs: string): string {
	if (!refs) return '';
	const names = refs
		.split(', ')
		.map((name) => name.replace('HEAD -> ', '').trim())
		.filter(Boolean);
	const local = names.filter(
		(name) => !name.startsWith('origin/') && name !== 'HEAD' && !name.startsWith('tag: ')
	);
	const tags = names
		.filter((name) => name.startsWith('tag: '))
		.map((name) => name.replace('tag: ', ''));
	const chosen = local.length ? local : tags.length ? tags : names;
	return chosen.join(',');
}

function hintsFor(kind: View['kind'], paused: boolean, bell: boolean): [string, string][] {
	if (kind === 'diff') {
		return [
			['↑↓', 'scroll'],
			['gG', 'ends'],
			['esc', 'back'],
			['y', 'copy sha'],
			['?', 'keys'],
			['q', 'quit']
		];
	}
	if (kind === 'commit') {
		return [
			['↑↓', 'files'],
			['⏎', 'diff'],
			['esc', 'back'],
			['y', 'copy sha'],
			['?', 'keys'],
			['q', 'quit']
		];
	}
	return [
		['↑↓', 'move'],
		['⏎', 'open'],
		['/', 'filter'],
		['r', 'repos'],
		['p', paused ? 'resume' : 'pause'],
		['b', bell ? 'bell on' : 'bell off'],
		['?', 'keys'],
		['q', 'quit']
	];
}

function Gone({ height }: { height: number }) {
	const rows = [
		<Text key="gone" color={UI.warn}>
			{'   this commit is no longer in the repository — amended, rebased or reset'}
		</Text>
	];
	while (rows.length < height) rows.push(<Text key={`pad${rows.length}`}> </Text>);
	return <>{rows.slice(0, height)}</>;
}

function Help({ height, columns }: { height: number; columns: number }) {
	const sections: [string, [string, string][]][] = [
		[
			'moving',
			[
				['↑ ↓  j k', 'move the cursor'],
				['pgup pgdn', 'a page at a time — in the feed and the diff'],
				['^d ^u', 'the same, for keyboards without page keys'],
				['g', 'follow the newest commit again — and mark what arrived as read'],
				['↑↓', 'any movement stops following, and the cursor then stays where you put it'],
				['G', 'jump to the oldest loaded commit'],
				['⏎ → l', 'open the commit, then a file'],
				['esc ← h', 'back out of a commit or a diff']
			]
		],
		[
			'the feed',
			[
				['/', 'filter on repo, subject, author, sha, branch or hostname'],
				['esc', 'in the feed, clears the filter'],
				['r', 'show or hide the repo panel'],
				['a', 'cycle scope: local branches → checked-out branch → all refs'],
				['p', 'pause — stops reading, so nothing moves while you read'],
				['R', 'rescan for new repos, and read every one now'],
				['b', 'ring the terminal bell on a new commit'],
				['y', 'copy the sha — the run link on ✔✖◔, the version id on ☁ (macOS)'],
				['q  ^c', 'quit'],
				['', "runs come from `gh`, deploys from each project's own `wrangler`"]
			]
		],
		[
			'reading the rows',
			[
				['▌', "the repo's color, so one project is one stripe down the screen"],
				['✦', 'new: arrived in the last few seconds, or since the cursor left the top'],
				['⇧', 'a push — which branch, to which remote, and how many commits'],
				['✔ ✖ ◔', 'a workflow run: succeeded, failed, still running'],
				['☁', 'a Cloudflare deploy — the hostname that went live'],
				['↺', 'a rollback'],
				[
					'✔ ☁',
					'in the repo panel: the workflow passed, and the site is live — two separate facts'
				],
				['↑3', 'three commits not yet pushed — undeployed, on this laptop only'],
				['●2', 'two tracked files changed but not committed'],
				['?1', 'one untracked file — git has never seen it'],
				['⑂', 'a merge commit']
			]
		]
	];

	const rows = [];
	for (const [title, items] of sections) {
		rows.push(
			<Text key={title} color={UI.dim}>
				{`  ${title}`}
			</Text>
		);
		for (const [keys, description] of items) {
			rows.push(
				<Text key={title + keys} wrap="truncate">
					<Text bold>{fit(`    ${keys}`, 16)}</Text>
					<Text color={UI.dim}>{fit(description, Math.max(0, columns - 17))}</Text>
				</Text>
			);
		}
		rows.push(<Text key={`${title}gap`}> </Text>);
	}
	while (rows.length < height) rows.push(<Text key={`pad${rows.length}`}> </Text>);
	return <>{rows.slice(0, height)}</>;
}
