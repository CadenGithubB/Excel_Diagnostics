// Request mode: which bundle a call is about.
//
// The model never sees a folder of this machine, so it cannot name a bundle by path: it leaves "bundle" out, or
// sends an id, often a part of one or one it half remembers. Each of those has to end in one of two ways: the
// bundle that was meant, with a note when the id was completed for it, or a refusal that lists the ids there are.
// It must never end in a file outside the bundles folder, or in a path the model then tries to open with other
// tools. A zip dropped in the folder by a person has to work as it is.
import { promises as fs, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, assert, request, sampleBundlesDir, emptyDir, cleanup, SAMPLE_ID } from '../harness.mjs';

const COLLECT = 'Excel_Diagnostics_collect_20260101_000000', HANG = 'Excel_Diagnostics_hang_20260202_000000', WATCH = 'Excel_Diagnostics_watch_20260303_000000';
const DITTO = '/usr/bin/ditto';                           // what the collector zips a bundle with; macOS only
const NO_DITTO = existsSync(DITTO) ? undefined : 'ditto is a macOS program and is not on this machine';

let cacheDir = null, threeDir = null;
// One request against a bundles folder. Returns the document with what went to standard error beside it.
async function ask(bundlesDir, op, params = {}, extra = {}) {
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir, cacheDir, params, ...extra });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', `standard output is not a JSON document: ${r.stdout.slice(0, 200)}`);
  assert.equal(r.stdout, `${JSON.stringify(r.json)}\n`, 'standard output holds the document, a line break and nothing else');
  for (const dir of [bundlesDir, extra.cacheDir ?? cacheDir, os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(dir), `a path of this machine is in the output: ${dir}`);
  return Object.assign(r.json, { stderr: r.stderr });
}
const doc = (d) => { const { stderr, ...rest } = d; return rest; };
// A bundle folder needs only a file to be listed. `when` is its modification time, which is what orders bundles.
async function bundle(dir, id, when, files = { 'notes.txt': `notes of ${id}\n` }) {
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(dir, id, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, text);
  }
  await fs.mkdir(path.join(dir, id), { recursive: true });
  const t = new Date(when);
  await fs.utimes(path.join(dir, id), t, t);
}
function three() {
  threeDir ??= (async () => {
    const dir = await emptyDir('bundles');
    await bundle(dir, HANG, '2026-02-02T00:00:00Z');
    await bundle(dir, WATCH, '2026-03-03T00:00:00Z');
    await bundle(dir, COLLECT, '2026-01-01T00:00:00Z');
    await bundle(dir, '.hidden_bundle', '2026-09-09T00:00:00Z');
    await fs.writeFile(path.join(dir, 'readme.txt'), 'not a bundle\n');
    await fs.writeFile(path.join(dir, '.DS_Store'), 'x');
    return dir;
  })();
  return threeDir;
}
async function tree(dir) {                                // every path under a folder, to show that nothing was added
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) out.push(e.name, ...(e.isDirectory() ? (await tree(path.join(dir, e.name))).map((p) => `${e.name}/${p}`) : []));
  return out.sort();
}
const zip = (folder, to) => new Promise((resolve, reject) => execFile(DITTO, ['-c', '-k', '--keepParent', folder, to], (err) => (err ? reject(err) : resolve())));
const NONE_HINT = 'Ask the human to copy an Excel_Diagnostics_....zip file, or the unzipped folder, into the Excel diagnostics bundles folder on the OpenClaw host. Do not call these tools again until the human says that is done.';
const NOT_AN_ID = 'A bundle id is a name with no slash, no backslash and no "..", and it does not start with a dot. Copy an id from availableBundles in excel_diag_summary results, or leave bundle out for the newest bundle.';

describe('request mode: choosing the bundle', () => {
  it('with no bundle named, the newest is used, and summary lists the ids newest first', async () => {
    const d = await ask(await three(), 'summary');
    assert.equal(d.ok, true);
    assert.equal(d.bundle, WATCH);
    assert.equal(d.receipt.bundle, WATCH);
    assert.equal(d.receipt.collectorMode, 'watch');
    assert.deepEqual(d.receipt.availableBundles, [WATCH, HANG, COLLECT], 'names starting with a dot and plain files are not bundles');
    assert.equal(d.receipt.bundles, 3);
    assert.equal(d.receipt.entries, 0);
    assert.deepEqual(d.notes, ['No file in this bundle is a log with timestamps this tool recognises, so it has no timeline entries.']);
    assert.equal(d.next, 'excel_diag_files {} lists the 1 file in this bundle. If this answers the question, reply now.');
  });

  it('an id is matched whole, whatever its capitals', async () => {
    const dir = await three();
    const [exact, capitals] = await Promise.all([ask(dir, 'read_file', { bundle: HANG, path: 'notes.txt' }), ask(dir, 'summary', { bundle: COLLECT.toUpperCase() })]);
    assert.equal(exact.bundle, HANG);
    assert.equal(exact.text, `notes of ${HANG}`);
    assert.deepEqual(exact.notes, []);
    assert.equal(capitals.bundle, COLLECT);
    assert.deepEqual(capitals.notes.filter((n) => n.startsWith('bundle ')), [], 'the same id in other capitals needs no note');
    assert.equal(capitals.receipt.collectorMode, 'collect');
  });

  it('part of one id is completed, a note says to what, and the calls in next use the whole id', async () => {
    const d = await ask(await three(), 'files', { bundle: 'hang' });
    assert.equal(d.bundle, HANG);
    assert.deepEqual(d.notes, [`bundle "hang" was read as ${HANG}.`]);
    assert.equal(d.next, `excel_diag_read_file {path: "notes.txt", bundle: "${HANG}"} reads the first file listed. If this answers the question, reply now.`);
  });

  it('part of several ids is refused with the ids it could be', async () => {
    const d = await ask(await three(), 'summary', { bundle: 'Excel_Diagnostics' });
    assert.deepEqual(doc(d), { ok: false, error: 'bundle matches more than one bundle', field: 'bundle', hint: '"Excel_Diagnostics" is part of 3 bundle ids. Send one of the candidates, whole, as bundle.', candidates: [WATCH, HANG, COLLECT] });
  });

  it('an id that is nowhere is refused with the ids there are, and no bundle is opened in its place', async () => {
    const d = await ask(await three(), 'search', { bundle: 'Excel_Diagnostics_repro_20260404_000000', query: 'pivot' });
    assert.deepEqual(doc(d), { ok: false, error: 'no such bundle', field: 'bundle',
      hint: `No bundle id is or contains "Excel_Diagnostics_repro_20260404_000000". The bundles here, newest first: ${WATCH}, ${HANG}, ${COLLECT}. Send one of these ids as bundle, or leave bundle out for the newest; do not guess an id.` });
  });

  it('a name shaped like a path, or starting with a dot, is refused before any folder is looked at', async () => {
    const dir = await three();
    await bundle(path.dirname(dir), `${path.basename(dir)}-outside`, '2026-05-05T00:00:00Z');      // a real folder beside the bundles folder
    try {
      for (const name of ['../x', `../${path.basename(dir)}-outside`, 'a/b', 'a\\b', '..', `${HANG}/..`, `${HANG}/notes.txt`, '.hidden_bundle', '/etc', 'C:\\Users']) {
        const d = await ask(dir, 'summary', { bundle: name });
        assert.deepEqual(doc(d), { ok: false, error: 'bundle is not a bundle id', field: 'bundle', hint: NOT_AN_ID }, name);
      }
    } finally { await fs.rm(path.join(path.dirname(dir), `${path.basename(dir)}-outside`), { recursive: true, force: true }); }
  });

  it('with no bundles at all, every operation says so and says what the human has to do', async () => {
    const empty = await emptyDir('bundles'), onlyOthers = await emptyDir('bundles');
    await fs.writeFile(path.join(onlyOthers, 'notes.txt'), 'not a bundle\n');
    await bundle(onlyOthers, '.hidden_bundle', '2026-01-01T00:00:00Z');
    const answers = await Promise.all([ask(empty, 'summary'), ask(empty, 'search', { query: 'pivot', bundle: 'anything' }), ask(path.join(empty, 'not-made-yet'), 'files'), ask(onlyOthers, 'show', { id: 1 })]);
    for (const d of answers) assert.deepEqual(doc(d), { ok: false, error: 'no bundles are available', hint: NONE_HINT });
  });

  it('more ids than fit in a hint are counted, not all listed', async () => {
    const dir = await emptyDir('bundles');
    for (let i = 1; i <= 12; i++) await bundle(dir, `Batch_${String(i).padStart(2, '0')}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00Z`);
    const [summary, many, none] = await Promise.all([ask(dir, 'summary'), ask(dir, 'summary', { bundle: 'batch' }), ask(dir, 'summary', { bundle: 'other' })]);
    assert.equal(summary.bundle, 'Batch_12');
    assert.equal(summary.receipt.bundles, 12);
    assert.deepEqual(summary.receipt.availableBundles, ['Batch_12', 'Batch_11', 'Batch_10', 'Batch_09', 'Batch_08', 'Batch_07', 'Batch_06', 'Batch_05', 'Batch_04', 'Batch_03']);
    assert.equal(many.candidates.length, 10);
    assert.equal(many.hint, '"batch" is part of 12 bundle ids. Send one of the candidates, whole, as bundle.');
    assert.match(none.hint, /newest first: Batch_12, Batch_11, .*Batch_03, and 2 more\. Send one of these ids/);
  });

  it('an id with spaces and quotation marks is an id like any other', async () => {
    const dir = await emptyDir('bundles'), id = 'Finance Mac "old" bundle';
    await bundle(dir, id, '2026-01-01T00:00:00Z');
    const d = await ask(dir, 'files', { bundle: id });
    assert.equal(d.bundle, id);
    assert.equal(d.next, `excel_diag_read_file {path: "notes.txt", bundle: ${JSON.stringify(id)}} reads the first file listed. If this answers the question, reply now.`);
  });

  it('an empty bundle folder is refused, with the other bundles to use', async () => {
    const dir = await emptyDir('bundles');
    await bundle(dir, 'Full_one', '2026-01-01T00:00:00Z');
    await bundle(dir, 'Empty_one', '2026-02-02T00:00:00Z', {});
    const d = await ask(dir, 'summary');
    assert.deepEqual(doc(d), { ok: false, error: 'the bundle is empty', field: 'bundle', hint: 'Bundle Empty_one holds no files. Other bundles here: Full_one. Send one of them as bundle.' });
  });

  it('a bundles folder that is not a folder is reported as such, without its path', async () => {
    const dir = await emptyDir('bundles'), file = path.join(dir, 'bundles');
    await fs.writeFile(file, 'a file where the folder should be\n');
    const d = await ask(file, 'summary');
    assert.equal(d.ok, false);
    assert.equal(d.error, 'the bundles folder cannot be read');
    assert.match(d.hint, /^The Excel diagnostics bundles folder on the OpenClaw host could not be read \(ENOTDIR\)\. Tell the human/);
  });
});

describe('request mode: a zip is a bundle', () => {
  it('a zip made the way the collector makes one is unpacked under cacheDir and searched', { skip: NO_DITTO }, async () => {
    const dir = await emptyDir('bundles'), cache = await emptyDir('cache');
    await zip(path.join(await sampleBundlesDir(), SAMPLE_ID), path.join(dir, `${SAMPLE_ID}.zip`));
    const before = await tree(dir);
    const first = await ask(dir, 'summary', {}, { cacheDir: cache });
    assert.equal(first.ok, true);
    assert.equal(first.bundle, SAMPLE_ID, 'the id is the file name without .zip');
    assert.equal(first.receipt.entries, 32861);
    assert.equal(first.receipt.files, 15);
    assert.deepEqual(first.receipt.availableBundles, [SAMPLE_ID]);
    assert.match(first.stderr, /Unpacking Excel_Diagnostics_sample\.zip/, 'progress goes to standard error');
    assert.deepEqual(await tree(dir), before, 'nothing is written in the bundles folder');
    const unpacked = (await fs.readdir(cache)).filter((n) => n.startsWith(SAMPLE_ID));
    assert.equal(unpacked.length, 1, 'the zip is unpacked once, under cacheDir');
    const second = await ask(dir, 'search', { query: 'pivot', limit: 1 }, { cacheDir: cache });
    assert.equal(second.receipt.matched, 3838);
    assert.ok(!second.stderr.includes('Unpacking'), 'a later request reads what was unpacked');
    const text = await ask(dir, 'read_file', { path: 'summary.md', limit: 1, bundle: 'sample' }, { cacheDir: cache });
    assert.equal(text.text, '# Excel diagnostics summary');
    assert.deepEqual(text.notes, [`bundle "sample" was read as ${SAMPLE_ID}.`]);
  });

  it('two requests that unpack the same zip at once both get the whole bundle', { skip: NO_DITTO }, async () => {
    const dir = await emptyDir('bundles'), cache = await emptyDir('cache');
    await zip(path.join(await sampleBundlesDir(), SAMPLE_ID), path.join(dir, `${SAMPLE_ID}.zip`));
    const answers = await Promise.all([ask(dir, 'summary', {}, { cacheDir: cache }), ask(dir, 'count', {}, { cacheDir: cache }), ask(dir, 'files', {}, { cacheDir: cache })]);
    assert.equal(answers[0].receipt.entries, 32861);
    assert.equal(answers[1].receipt.matched, 32861);
    assert.equal(answers[2].receipt.files, 15);
    assert.deepEqual((await fs.readdir(cache)).filter((n) => n.includes('.part-')), [], 'no half-unpacked folder is left behind');
  });

  it('a zip and a folder with the same id are one bundle, and the folder is the one read', { skip: NO_DITTO }, async () => {
    const dir = await emptyDir('bundles'), cache = await emptyDir('cache');
    await zip(path.join(await sampleBundlesDir(), SAMPLE_ID), path.join(dir, `${SAMPLE_ID}.zip`));
    await bundle(dir, SAMPLE_ID, '2026-01-01T00:00:00Z');
    await bundle(dir, 'Another', '2025-01-01T00:00:00Z');
    const d = await ask(dir, 'summary', { bundle: SAMPLE_ID }, { cacheDir: cache });
    assert.equal(d.receipt.bundles, 2);
    assert.deepEqual(d.receipt.availableBundles, [SAMPLE_ID, 'Another']);
    assert.equal(d.receipt.files, 1, 'the folder holds one file; the zip holds fifteen');
    assert.equal(d.receipt.entries, 0);
    assert.ok(!d.stderr.includes('Unpacking'));
    assert.deepEqual(await fs.readdir(cache), [], 'with a folder to read there is nothing to unpack');
  });

  it('a zip among the files of a bundle is one of its files, not the bundle', async () => {
    const dir = await emptyDir('bundles');
    await bundle(dir, 'One_inside', '2026-02-02T00:00:00Z', { 'notes.txt': 'notes\n', 'old/archive.zip': 'an archive somebody left in the folder\n' });
    await bundle(dir, 'Two_inside', '2026-01-01T00:00:00Z', { 'notes.txt': 'notes\n', 'old/a.zip': 'one\n', 'old/b.zip': 'two\n' });
    const [one, two] = await Promise.all([ask(dir, 'files', { bundle: 'One_inside' }), ask(dir, 'files', { bundle: 'Two_inside' })]);
    assert.equal(one.ok, true, JSON.stringify(doc(one)));
    assert.equal(one.receipt.files, 2);
    assert.match(one.text, /\s-\s+old\/archive\.zip$/m);
    assert.equal(two.ok, true, JSON.stringify(doc(two)));
    assert.equal(two.receipt.files, 3);
  });

  it('a file named .zip that is not a zip is refused as a bundle that cannot be opened', async () => {
    const dir = await emptyDir('bundles');
    await fs.writeFile(path.join(dir, 'Broken_bundle.ZIP'), 'this is not a zip file at all\n'.repeat(20));
    await bundle(dir, 'Older_good_one', '2020-01-01T00:00:00Z');
    const d = await ask(dir, 'summary');
    assert.equal(d.ok, false);
    assert.equal(d.error, 'the bundle could not be opened');
    assert.equal(d.field, 'bundle');
    assert.equal(d.hint, 'Bundle Broken_bundle could not be read as a zip file: This does not look like a zip file (no end-of-central-directory record). Tell the human that. Other bundles here: Older_good_one. Send one of them as bundle.');
    assert.ok(!/may be|damaged|because/.test(d.hint), 'what went wrong is passed on; why is not guessed at');
    const other = await ask(dir, 'files', { bundle: 'Older_good_one' });
    assert.equal(other.ok, true, 'the other bundle is still usable');
  });

  it('cleanup', async () => { await cleanup(); });
});
