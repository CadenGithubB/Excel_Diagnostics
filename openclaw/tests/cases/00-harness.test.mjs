// The harness itself: the sample bundle must be written whole, or every other case tests the wrong thing.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it, assert, sampleBundlesDir, SAMPLE_ID, cli, cleanup } from '../harness.mjs';

describe('harness', () => {
  it('writes the sample bundle to disk', async () => {
    const dir = await sampleBundlesDir();
    const names = await fs.readdir(dir);
    assert.deepEqual(names, [SAMPLE_ID]);
    assert.ok((await fs.stat(path.join(dir, SAMPLE_ID, 'summary.md'))).size > 0);
  });
  it('the text command line reads that folder', async () => {
    const dir = await sampleBundlesDir();
    const r = await cli([path.join(dir, SAMPLE_ID), 'summary']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Entries on the timeline: 32,861/);
  });
  it('cleanup', async () => { await cleanup(); });
});
