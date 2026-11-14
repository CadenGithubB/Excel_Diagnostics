// The memory command takes memory files by where they are.
//
// In a collector's bundle the memory files are the ones at the places the collector writes them, and a JetsamEvent
// report is macOS's record only where the collector copies the system's report folder. A file of the same name in a
// folder that was copied from the Mac (Excel's logs, the user's own report folder) can hold anything, and the memory
// command must not list it among them. Files given without the collector's manifest have no places, so every file
// of those names is listed, as before. The page has the same rule; test/viewer_md_test.mjs pins it there.
import * as path from 'node:path';
import { describe, it, assert, cli, emptyDir } from '../harness.mjs';
import { put } from '../made-up.mjs';

async function bundle(withManifest) {
  const b = path.join(await emptyDir('memory-place'), 'Excel_Diagnostics_hang_20260310_120000');
  if (withManifest) { await put(b, 'manifest.tsv', 'component\tstatus\tdetails\n'); await put(b, 'bundle_info.tsv', 'mode\thang\n'); }
  await put(b, 'system_memory.txt', 'PhysMem: 8G used\n');
  await put(b, 'excel_container_logs/memory.txt', 'PhysMem: 99G PLANTED\n');
  await put(b, 'excel_container_logs/excel_footprint.txt', 'PLANTED footprint\n');
  await put(b, 'reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090000.ips', '{"bug_type":"298"}\n{"largestProcess":"own"}\n');
  await put(b, 'reports/user_Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090100.ips', '{"bug_type":"298"}\n{"largestProcess":"PLANTED"}\n');
  return b;
}

describe('text command line: memory files are taken by where they are', () => {
  it("in a collector's bundle, only those at the collector's own places are listed", async () => {
    const r = await cli([await bundle(true), 'memory']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  system_memory.txt\n'), r.stdout);
    assert.ok(r.stdout.includes('  reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090000.ips\n'), r.stdout);
    assert.ok(!r.stdout.includes('excel_container_logs/'), r.stdout);
    assert.ok(!r.stdout.includes('user_Library_Logs_DiagnosticReports'), r.stdout);
  });
  it('without the manifest there are no places, and every file of those names is listed', async () => {
    const r = await cli([await bundle(false), 'memory']);
    assert.equal(r.code, 0, r.stderr);
    for (const p of ['system_memory.txt', 'excel_container_logs/memory.txt', 'excel_container_logs/excel_footprint.txt',
      'reports/user_Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090100.ips']) assert.ok(r.stdout.includes(`  ${p}\n`), `${p}\n${r.stdout}`);
  });
});
