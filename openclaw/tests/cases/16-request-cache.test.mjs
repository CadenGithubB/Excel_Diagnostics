// Request mode: the folder zips are unpacked into.
//
// What this pins: an unpacked copy of a zip is removed once its zip is gone or was replaced, and so is a part-made
// folder left by a run that was stopped while unpacking; a copy whose zip is as it was stays; and nothing the
// program did not make is touched, in the cache folder or anywhere else.
//
// Why it matters to a small model: the model never sees this folder, but it meets what happens when nobody
// clears it. Every tool call the plugin stops for taking too long can leave a part-made copy as large as the
// bundle, and every replaced bundle leaves a whole one. A host whose disk fills that way stops answering every
// call, and all the model can do with that is tell the human that the tools do not answer.
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { describe, it, assert, request, sampleBundlesDir, emptyDir, cleanup, SAMPLE_ID } from '../harness.mjs';

const DITTO = '/usr/bin/ditto';                           // what the collector zips a bundle with; macOS only
const NO_DITTO = existsSync(DITTO) ? undefined : 'ditto is a macOS program and is not on this machine';
const zip = (folder, to) => new Promise((resolve, reject) => execFile(DITTO, ['-c', '-k', '--keepParent', folder, to], (err) => (err ? reject(err) : resolve())));
const names = async (dir) => (await fs.readdir(dir)).sort();

// A folder shaped like an unpacked copy: one file of the bundle, and the marker that names the zip it came from.
async function unpacked(cache, name, zipPath) {
  await fs.mkdir(path.join(cache, name, 'system'), { recursive: true });
  await fs.writeFile(path.join(cache, name, 'system', 'memory.txt'), 'a file of the bundle\n');
  if (zipPath !== null) await fs.writeFile(path.join(cache, name, '.unpacked'), `${zipPath}\n`);
}
// The name the program gives the unpacked copy of this zip as it is now.
async function nameFor(zipPath) {
  const st = await fs.stat(zipPath);
  return `${path.basename(zipPath).replace(/\.zip$/i, '')}-${st.size}-${Math.floor(st.mtimeMs)}`;
}
async function summary(bundlesDir, cacheDir) {
  const r = await request({ format: 1, op: 'summary', bundlesDir, cacheDir, params: {} });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true, r.stdout.slice(0, 300));
  return r;
}

describe('request mode: unpacked copies nobody can use are removed', () => {
  it('a copy whose zip is gone or was replaced goes, and one whose zip is as it was stays', async () => {
    const cache = await emptyDir('cache'), zips = await emptyDir('zips');
    const kept = path.join(zips, 'Kept_bundle.zip'), replaced = path.join(zips, 'Replaced_bundle.zip');
    await fs.writeFile(kept, 'stands in for a zip that is still there\n');
    await fs.writeFile(replaced, 'stands in for a zip that was copied in again\n');
    await unpacked(cache, await nameFor(kept), kept);
    await unpacked(cache, 'Replaced_bundle-7-1700000000000', replaced);
    await unpacked(cache, 'Gone_bundle-12-1700000000000', path.join(zips, 'Gone_bundle.zip'));
    await unpacked(cache, 'Unnamed-1-1', '');
    await summary(await sampleBundlesDir(), cache);
    assert.deepEqual(await names(cache), [await nameFor(kept)]);
    assert.deepEqual(await names(path.join(cache, await nameFor(kept))), ['.unpacked', 'system'], 'the copy that stays is whole');
    assert.deepEqual(await names(zips), ['Kept_bundle.zip', 'Replaced_bundle.zip'], 'no zip is touched');
  });

  it('a part-made folder goes once it is old; a new one may still be being written and stays', async () => {
    const cache = await emptyDir('cache');
    await unpacked(cache, 'Stopped_bundle-9-1700000000000.part-4242', '/nowhere/Stopped_bundle.zip');
    await unpacked(cache, 'Stopped_earlier-9-1700000000000.part-17', null);
    await unpacked(cache, 'Running_bundle-9-1700000000000.part-4343', null);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of ['Stopped_bundle-9-1700000000000.part-4242', 'Stopped_earlier-9-1700000000000.part-17']) await fs.utimes(path.join(cache, name), old, old);
    await summary(await sampleBundlesDir(), cache);
    assert.deepEqual(await names(cache), ['Running_bundle-9-1700000000000.part-4343']);
  });

  it('what the program did not make is left as it is, and no link is followed', async () => {
    const cache = await emptyDir('cache'), elsewhere = await emptyDir('elsewhere');
    await unpacked(cache, 'No_marker-5-5', null);
    await fs.writeFile(path.join(cache, 'a-file.txt'), 'kept\n');
    await fs.writeFile(path.join(cache, 'Looks_unpacked-1-1.part-9'), 'a file, not a folder\n');
    await unpacked(elsewhere, 'Outside-3-3', '/nowhere/Outside.zip');
    await fs.symlink(path.join(elsewhere, 'Outside-3-3'), path.join(cache, 'Linked-3-3'));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(path.join(cache, 'Looks_unpacked-1-1.part-9'), old, old);
    const bundles = await sampleBundlesDir(), before = await names(path.join(bundles, SAMPLE_ID));
    await summary(bundles, cache);
    assert.deepEqual(await names(cache), ['Linked-3-3', 'Looks_unpacked-1-1.part-9', 'No_marker-5-5', 'a-file.txt']);
    assert.deepEqual(await names(path.join(elsewhere, 'Outside-3-3')), ['.unpacked', 'system'], 'the folder a link points at is not emptied');
    assert.deepEqual(await names(bundles), [SAMPLE_ID]);
    assert.deepEqual(await names(path.join(bundles, SAMPLE_ID)), before, 'nothing in the bundles folder changes');
  });

  it('a cache folder that does not exist yet is not an error', async () => {
    const cache = path.join(await emptyDir('cache'), 'not', 'made', 'yet');
    await summary(await sampleBundlesDir(), cache);
    assert.equal(existsSync(cache), false, 'and it is not made until a zip has to be unpacked');
  });

  it('a zip that is replaced is unpacked again, and the copy of the old one goes', { skip: NO_DITTO }, async () => {
    const dir = await emptyDir('bundles'), cache = await emptyDir('cache'), file = path.join(dir, `${SAMPLE_ID}.zip`);
    await zip(path.join(await sampleBundlesDir(), SAMPLE_ID), file);
    const first = await summary(dir, cache), firstName = await nameFor(file);
    assert.match(first.stderr, /Unpacking/);
    assert.deepEqual(await names(cache), [firstName]);
    const later = new Date(Date.now() + 60 * 1000);
    await fs.utimes(file, later, later);                    // the same zip copied in again has a new date
    const second = await summary(dir, cache);
    assert.match(second.stderr, /Unpacking/, 'the replaced zip is read, not the copy of the old one');
    assert.deepEqual(await names(cache), [await nameFor(file)]);
    assert.notEqual(await nameFor(file), firstName);
    await fs.rm(file);
    await summary(await sampleBundlesDir(), cache);
    assert.deepEqual(await names(cache), [], 'once the zip is removed, its copy goes on the next request');
  });

  it('cleanup', async () => { await cleanup(); });
});
