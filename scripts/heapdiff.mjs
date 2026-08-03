/**
 * Aggregates two V8 heap snapshots by object type and reports what grew between them.
 *
 *   node scripts/heapdiff.mjs before.heapsnapshot after.heapsnapshot
 *
 * A snapshot's `nodes` array is flat: every node occupies `node_fields.length` consecutive integers, where
 * the name is an index into `strings`. Summing `self_size` per name and diffing two snapshots says which
 * kind of object is accumulating, which is the one thing a leak hunt actually needs to know.
 */
import { readFileSync } from 'node:fs';

function aggregate(path) {
	const snapshot = JSON.parse(readFileSync(path, 'utf8'));
	const fields = snapshot.snapshot.meta.node_fields;
	const types = snapshot.snapshot.meta.node_types[0];
	const stride = fields.length;
	const typeIndex = fields.indexOf('type');
	const nameIndex = fields.indexOf('name');
	const sizeIndex = fields.indexOf('self_size');

	const totals = new Map();
	for (let i = 0; i < snapshot.nodes.length; i += stride) {
		const type = types[snapshot.nodes[i + typeIndex]] ?? '?';
		const name = snapshot.strings[snapshot.nodes[i + nameIndex]] ?? '';
		const size = snapshot.nodes[i + sizeIndex] ?? 0;
		const key = `${type} ${name}`.slice(0, 90);
		const entry = totals.get(key) ?? { count: 0, size: 0 };
		entry.count++;
		entry.size += size;
		totals.set(key, entry);
	}
	return totals;
}

const [beforePath, afterPath] = process.argv.slice(2);
const before = aggregate(beforePath);
const after = aggregate(afterPath);

const rows = [];
for (const [key, entry] of after) {
	const was = before.get(key) ?? { count: 0, size: 0 };
	rows.push({
		key,
		dCount: entry.count - was.count,
		dSize: entry.size - was.size,
		count: entry.count
	});
}
rows.sort((a, b) => b.dSize - a.dSize);

const mb = (bytes) => (bytes / 1048576).toFixed(2).padStart(8);
console.log('\n  growth by object kind (top 22)\n');
console.log(`  ${'Δ MB'.padStart(8)} ${'Δ count'.padStart(9)} ${'now'.padStart(9)}  kind`);
for (const row of rows.slice(0, 22)) {
	if (row.dSize <= 0) break;
	console.log(
		`  ${mb(row.dSize)} ${String(row.dCount).padStart(9)} ${String(row.count).padStart(9)}  ${row.key}`
	);
}
console.log('');
