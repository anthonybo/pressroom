/**
 * The commit feed — the screen this program exists to draw.
 *
 * Each row is a single `<Text>` with styled spans inside it, not a flexbox of `<Box>`es. Ink lays Boxes out
 * with a full flexbox implementation, and a row assembled that way can come out a column wider than
 * intended once a subject contains an emoji; the row then wraps, and every frame after it is drawn one line
 * further down the screen than the last. Building each cell to an exact measured width with `fit` and
 * concatenating means the row is the width the arithmetic says it is.
 */
import { Text } from 'ink';
import { age, duration, fit, pad, padStart } from '../format.ts';
import type { FeedColumns } from '../layout.ts';
import { accent, BAR, UI } from '../theme.ts';
import { type DeployState } from '../store.ts';
import { isActive } from '../github.ts';
import type { Commit, Deploy, Push, RepoStatus, Run } from '../types.ts';

/**
 * A push.
 *
 * It reuses the commit row's column widths so the two kinds line up down the screen, but the branch goes in
 * the **subject** rather than the branch column — the branch is the whole point of a push row, and the branch
 * column is the first thing dropped on a narrow terminal. "pushed main → origin" is legible at every width.
 */
export function PushRow({
	push,
	columns,
	selected,
	now,
	fresh
}: {
	push: Push;
	columns: FeedColumns;
	selected: boolean;
	now: number;
	fresh: boolean;
}) {
	const color = accent(push.repo);
	const carried =
		push.count === null ? '' : `  ·  ${push.count} commit${push.count === 1 ? '' : 's'}`;
	const subject = `pushed ${push.branch} → ${push.remote}${push.forced ? '  ·  forced' : ''}${carried}`;

	return (
		<Text wrap="truncate" inverse={selected}>
			<Text color={fresh ? UI.fresh : UI.push}>{selected ? '▸' : '⇧'}</Text>
			<Text color={color}>{BAR}</Text>
			<Text> </Text>
			<Text color={fresh ? UI.fresh : UI.dim} bold={fresh}>
				{fit(age(now, push.at), columns.age)}
			</Text>
			<Text> </Text>
			<Text color={color}>{fit(push.repo, columns.repo)}</Text>
			{columns.branch > 0 && <Text>{` ${' '.repeat(columns.branch)}`}</Text>}
			<Text color={UI.dim}> {pad(push.sha.slice(0, columns.sha), columns.sha)}</Text>
			<Text color={UI.push} bold={fresh}>
				{' '}
				{fit(subject, columns.subject)}
			</Text>
			{columns.stats > 0 && <Text>{' '.repeat(columns.stats + 1)}</Text>}
			{columns.author > 0 && <Text>{' '.repeat(columns.author + 1)}</Text>}
		</Text>
	);
}

export function FeedRow({
	commit,
	columns,
	selected,
	now,
	branch,
	fresh
}: {
	commit: Commit;
	columns: FeedColumns;
	selected: boolean;
	now: number;
	branch?: string;
	fresh: boolean;
}) {
	const color = accent(commit.repo);

	// The gutter carries three separate facts in three columns: where the cursor is, which repo this is,
	// and whether it just arrived. The `✦` matters on a terminal with no color, where the bar is only a
	// shape and bold is the only other signal available.
	const marker = selected ? '▸' : fresh ? '✦' : ' ';

	return (
		<Text wrap="truncate" inverse={selected}>
			<Text color={fresh ? UI.fresh : UI.dim}>{marker}</Text>
			<Text color={color}>{BAR}</Text>
			<Text> </Text>
			<Text color={fresh ? UI.fresh : UI.dim} bold={fresh}>
				{fit(age(now, commit.committed), columns.age)}
			</Text>
			<Text> </Text>
			<Text color={color}>{fit(commit.repo, columns.repo)}</Text>
			{columns.branch > 0 && <Text color={UI.dim}> {fit(branch ?? '', columns.branch)}</Text>}
			<Text color={UI.dim}>
				{' '}
				{/* Sliced from the full sha rather than truncated, so a narrowed column still holds a prefix
				    git will accept — `fit` would turn `690119b` into `690…`, which is no use to anyone. */}
				{pad(commit.sha.slice(0, columns.sha), columns.sha)}
			</Text>
			<Text bold={fresh}> {fit(subjectOf(commit), columns.subject)}</Text>
			{columns.stats > 0 && <Stats commit={commit} width={columns.stats} />}
			{columns.author > 0 && <Text color={UI.dim}> {fit(commit.author, columns.author)}</Text>}
		</Text>
	);
}

/**
 * Merges get a marker instead of a line count. `--shortstat` reports nothing for a merge commit, so the
 * columns would otherwise read as a commit that changed nothing at all.
 */
function subjectOf(commit: Commit): string {
	return commit.parents.length > 1 ? `⑂ ${commit.subject}` : commit.subject;
}

function Stats({ commit, width: total }: { commit: Commit; width: number }) {
	if (commit.parents.length > 1) {
		return <Text color={UI.dim}> {fit('merge', total)}</Text>;
	}
	// Five columns for insertions, four for deletions, right-aligned so the numbers form two columns down
	// the screen rather than drifting with their own length.
	const plus = commit.insertions ? `+${commit.insertions}` : '';
	const minus = commit.deletions ? `−${commit.deletions}` : '';
	const plusWidth = Math.max(0, total - 5);

	return (
		<Text>
			{' '}
			<Text color={UI.added}>{padStart(plus, plusWidth)}</Text>
			<Text color={UI.removed}>{padStart(minus, 5)}</Text>
		</Text>
	);
}

/** Shown in place of the list while the first reads are still running, and when a filter matches nothing. */
export function FeedEmpty({ message, columns }: { message: string; columns: number }) {
	return (
		<Text color={UI.dim} wrap="truncate">
			{fit(`   ${message}`, columns)}
		</Text>
	);
}

/**
 * One repo in the panel above the feed.
 *
 * `↑3` is the number that earns its place. Every repo on this account deploys by pushing a branch, so three
 * commits ahead of the upstream is three commits of work that exist on this laptop and nowhere else — the
 * single most useful thing a glance at the dashboard can tell you.
 */
export function RepoRow({
	label,
	status,
	error,
	lastCommitMs,
	deployState,
	now,
	columns,
	labelWidth
}: {
	label: string;
	status: RepoStatus | undefined;
	error: string | undefined;
	lastCommitMs: number | undefined;
	/** The repo's newest workflow run and newest Cloudflare deploy — both, shown side by side. */
	deployState: DeployState | undefined;
	now: number;
	columns: number;
	labelWidth: number;
}) {
	const color = accent(label);
	const branchWidth = columns >= 76 ? 18 : 0;
	/**
	 * Two glyphs, two facts, side by side: did the pipeline pass, and is it live.
	 *
	 * One column cannot carry both. A workflow run has an outcome and a Cloudflare deployment does not, and a
	 * repo can easily be green-and-live, red-and-live (the failure came after), or live-with-no-pipeline at all
	 * — which is `app`, deployed by hand and with no workflows to have an opinion about it.
	 */
	const ci = deployState?.run ? runLook(deployState.run) : null;
	const live = deployState?.deploy ? deployLook(deployState.deploy) : null;

	if (error) {
		return (
			<Text wrap="truncate">
				<Text> </Text>
				<Text color={color}>{BAR}</Text>
				<Text> {fit(label, labelWidth)} </Text>
				<Text color={UI.error}>{fit(error, Math.max(0, columns - labelWidth - 4))}</Text>
			</Text>
		);
	}

	const ahead = status?.ahead ?? 0;
	const behind = status?.behind ?? 0;
	const dirty = status?.changed ?? 0;
	const untracked = status?.untracked ?? 0;

	const sync = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ');
	// Space-separated. Run together, `●2?1` reads as one cryptic token rather than two counts — which is
	// exactly how it was read the first time someone looked at it.
	const work = [dirty ? `●${dirty}` : '', untracked ? `?${untracked}` : '']
		.filter(Boolean)
		.join(' ');
	const when = lastCommitMs ? age(now, new Date(lastCommitMs).toISOString()) : '';

	return (
		<Text wrap="truncate">
			<Text> </Text>
			<Text color={color}>{BAR}</Text>
			<Text> </Text>
			<Text color={color}>{fit(label, labelWidth)}</Text>
			{branchWidth > 0 && <Text color={UI.dim}> {fit(status?.branch ?? '', branchWidth)}</Text>}
			<Text color={ahead ? UI.warn : UI.dim} bold={ahead > 0}>
				{' '}
				{fit(sync, 7)}
			</Text>
			<Text color={dirty ? UI.warn : UI.dim}>{fit(work, 8)}</Text>
			<Text color={ci?.color ?? UI.dim}>{fit(ci?.glyph ?? '', 2)}</Text>
			<Text color={live?.color ?? UI.dim}>{fit(live?.glyph ?? '', 2)}</Text>
			<Text color={UI.dim}>{padStart(when, 5)}</Text>
			{!status?.upstream && !status?.unborn && <Text color={UI.faint}>{'  no upstream'}</Text>}
		</Text>
	);
}

/**
 * How a workflow run's state reads at a glance: a glyph, a color, and a phrase.
 *
 * The glyph carries the state on its own so the row still says what happened through `cat`, on a
 * sixteen-color terminal, or with `NO_COLOR` set — where the red would be gone and red is the entire point of
 * a failed deploy.
 */
export function runLook(
	run: Run,
	options: { now?: number; typicalMs?: number | null } = {}
): { glyph: string; color: string; outcome: string } {
	if (isActive(run)) {
		const started = Date.parse(run.startedAt);
		const elapsed =
			options.now && Number.isFinite(started) ? Math.max(0, options.now - started) : null;
		const typical = options.typicalMs ?? null;
		const verb = run.status === 'queued' ? 'queued' : 'running';

		// Overdue needs both tests. A run twice as long as a fifteen-second one is still only thirty seconds,
		// which is noise; a full extra minute on top of double is a run worth looking at.
		const overdue =
			elapsed !== null && typical !== null && elapsed > typical * 2 && elapsed > typical + 60_000;

		const parts = [elapsed === null ? verb : `${verb} ${duration(elapsed)}`];
		if (typical !== null)
			parts.push(overdue ? `over the usual ${duration(typical)}` : `usually ${duration(typical)}`);

		return {
			// Still a clock, not a cross: it is late, not failed, and those must not look the same.
			glyph: '◔',
			color: overdue ? UI.error : UI.warn,
			outcome: parts.join('  ·  ')
		};
	}
	const took = run.durationMs === null ? '' : ` in ${duration(run.durationMs)}`;
	switch (run.conclusion) {
		case 'success':
			return { glyph: '✔', color: UI.added, outcome: `ok${took}` };
		case 'failure':
			return { glyph: '✖', color: UI.error, outcome: `failed${took}` };
		case 'timed_out':
			return { glyph: '✖', color: UI.error, outcome: `timed out${took}` };
		case 'cancelled':
			return { glyph: '⊘', color: UI.dim, outcome: 'cancelled' };
		case 'skipped':
			return { glyph: '⊘', color: UI.dim, outcome: 'skipped' };
		default:
			return { glyph: '·', color: UI.dim, outcome: run.conclusion ?? run.status };
	}
}

/**
 * A deploy.
 *
 * Same columns as a commit row, and the branch goes in the subject for the same reason it does on a push row:
 * which branch deployed is the point, and the branch column is the first thing a narrow terminal gives up.
 */
/**
 * What a run row calls itself: normally the workflow and the branch, but the run's own name when it has one.
 *
 * GitHub exposes `workflow_dispatch` inputs **nowhere** on a run — there is no `inputs` field on the API
 * object and the title defaults to the workflow name — so a provisioning run that created a site for one
 * client is indistinguishable from one that created a site for another. The only channel from a dispatch to
 * anything downstream is the workflow's own `run-name:`, which arrives here as the title. When a workflow
 * sets it, this shows it.
 *
 * Gated on the event, because for a **push** the title is the commit subject — already on the commit row
 * directly below, so showing it here would duplicate a line and lose `Deploy dev`, which is the part that
 * says where the deploy went. The branch is kept either way, since a dispatched deploy on `dev` and one on
 * `main` land on different hostnames.
 */
export function subjectOfRun(run: Run): string {
	const named = run.event !== 'push' && run.title && run.title !== run.workflow;
	return `${named ? run.title : run.workflow} ${run.branch}`;
}

export function RunRow({
	run,
	columns,
	selected,
	now,
	fresh,
	typicalMs
}: {
	run: Run;
	columns: FeedColumns;
	selected: boolean;
	now: number;
	fresh: boolean;
	/** Median duration of this workflow's recent successful runs, when there is one to compare against. */
	typicalMs?: number | null;
}) {
	const look = runLook(run, { now, typicalMs });
	const color = accent(run.repo);

	const subject = `${subjectOfRun(run)}  ·  ${look.outcome}`;

	return (
		<Text wrap="truncate" inverse={selected}>
			<Text color={fresh ? UI.fresh : look.color} bold={fresh}>
				{selected ? '▸' : look.glyph}
			</Text>
			<Text color={color}>{BAR}</Text>
			<Text> </Text>
			<Text color={fresh ? UI.fresh : UI.dim} bold={fresh}>
				{fit(age(now, run.startedAt), columns.age)}
			</Text>
			<Text> </Text>
			<Text color={color}>{fit(run.repo, columns.repo)}</Text>
			{columns.branch > 0 && <Text>{` ${' '.repeat(columns.branch)}`}</Text>}
			<Text color={UI.dim}> {pad(run.sha.slice(0, columns.sha), columns.sha)}</Text>
			<Text color={look.color} bold={fresh}>
				{' '}
				{fit(subject, columns.subject)}
			</Text>
			{columns.stats > 0 && <Text>{' '.repeat(columns.stats + 1)}</Text>}
			{columns.author > 0 && <Text>{' '.repeat(columns.author + 1)}</Text>}
		</Text>
	);
}

/**
 * A Cloudflare deploy's glyph and color, shared by the feed row and the repo panel so the two never disagree
 * about what a deploy looks like.
 *
 * There is no success or failure here: a failed deploy never becomes a deployment at all, so unlike a workflow
 * run this has no outcome to report — only that it happened, and whether it was a rollback.
 */
export function deployLook(deploy: Deploy): { glyph: string; color: string } {
	const rollback = /rollback/i.test(deploy.triggeredBy);
	return { glyph: rollback ? '↺' : '☁', color: rollback ? UI.warn : UI.live };
}

/**
 * A Cloudflare deploy.
 *
 * The Worker name is shown rather than assumed from the repo, because they differ — `example.dev` deploys
 * `example-dev`, and `demo` deploys `web-demo`. `source` is included because "deployed from the dashboard"
 * and "deployed by wrangler on this laptop" are worth telling apart at a glance.
 */
export function DeployRow({
	deploy,
	columns,
	selected,
	now,
	fresh
}: {
	deploy: Deploy;
	columns: FeedColumns;
	selected: boolean;
	now: number;
	fresh: boolean;
}) {
	const color = accent(deploy.repo);
	const rollback = /rollback/i.test(deploy.triggeredBy);
	const verb = rollback ? 'rolled back' : 'went live';
	// The hostname, not the Worker name: "staging.example.dev went live" and "example.dev went live" are the
	// distinction that matters, and the Worker names behind them — `example-dev-staging` and `example-dev` —
	// are confusingly close to each other. The Worker name is the fallback when a config declares no routes.
	const where = deploy.hostname ?? deploy.worker;
	const subject = `${where} ${verb}  ·  ${deploy.source}`;

	return (
		<Text wrap="truncate" inverse={selected}>
			<Text color={fresh ? UI.fresh : rollback ? UI.warn : UI.live} bold={fresh}>
				{selected ? '▸' : rollback ? '↺' : '☁'}
			</Text>
			<Text color={color}>{BAR}</Text>
			<Text> </Text>
			<Text color={fresh ? UI.fresh : UI.dim} bold={fresh}>
				{fit(age(now, deploy.at), columns.age)}
			</Text>
			<Text> </Text>
			<Text color={color}>{fit(deploy.repo, columns.repo)}</Text>
			{columns.branch > 0 && <Text>{` ${' '.repeat(columns.branch)}`}</Text>}
			{/*
			 * The sha column is left empty on purpose. A Cloudflare deployment has no commit sha, and the
			 * version id it does have is a UUID whose first seven characters — `f72cef9` — are
			 * indistinguishable from a short git sha. Printing it there invites you to run `git show` on
			 * something git has never heard of. `y` copies the version id instead.
			 */}
			<Text>{` ${' '.repeat(columns.sha)}`}</Text>
			<Text color={rollback ? UI.warn : UI.live} bold={fresh}>
				{' '}
				{fit(subject, columns.subject)}
			</Text>
			{columns.stats > 0 && <Text>{' '.repeat(columns.stats + 1)}</Text>}
			{columns.author > 0 && <Text>{' '.repeat(columns.author + 1)}</Text>}
		</Text>
	);
}
