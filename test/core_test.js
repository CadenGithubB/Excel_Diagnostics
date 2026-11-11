// deno run --allow-read test/core_test.js [bundle.zip | bundle-folder]
// Loads src/core.js outside the browser and checks indexing and search against a bundle (default: the built-in sample).
const src = await Deno.readTextFile(new URL('../src/core.js', import.meta.url));
const Core = new Function(src + '\nreturn Core;')();
class DiskBlob {                                        // just enough of Blob, read from disk on demand like a browser File
  constructor(path, start = 0, end = Deno.statSync(path).size) { this.path = path; this.start = start; this.size = end - start; }
  slice(a = 0, b = this.size) {
    a = Math.max(0, Math.min(this.size, a)); b = Math.max(a, Math.min(this.size, b));
    return new DiskBlob(this.path, this.start + a, this.start + b);
  }
  async arrayBuffer() {
    const f = await Deno.open(this.path), buf = new Uint8Array(this.size);
    try {
      await f.seek(this.start, Deno.SeekMode.Start);
      for (let n = 0; n < buf.length;) { const r = await f.read(buf.subarray(n)); if (r === null) break; n += r; }
    } finally { f.close(); }
    return buf.buffer;
  }
  stream() {
    let pos = 0;
    return new ReadableStream({ pull: async (c) => {
      if (pos >= this.size) return c.close();
      const n = Math.min(1 << 20, this.size - pos);
      c.enqueue(new Uint8Array(await this.slice(pos, pos + n).arrayBuffer()));
      pos += n;
    } });
  }
}
const arg = Deno.args[0];
let inputs;
if (!arg) inputs = Core.sampleBundle(Number(Deno.args[1] || 1));
else if (arg.endsWith('.zip')) inputs = [{ path: arg.split('/').pop(), blob: new DiskBlob(arg) }];
else {
  inputs = [];
  const root = arg.replace(/\/$/, ''), top = root.split('/').pop();
  const walk = async (dir, rel) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(`${dir}/${e.name}`, `${rel}${e.name}/`);
      else inputs.push({ path: `${top}/${rel}${e.name}`, blob: new DiskBlob(`${dir}/${e.name}`) });
    }
  };
  await walk(root, '');
}
const ds = new Core.Dataset();
let t = performance.now();
const info = await ds.load(inputs, () => {});
console.log(`loaded "${info.name}": ${info.files.length} files, ${info.total} rows in ${(performance.now() - t | 0)} ms`);
console.log(`range ${Core.stamp(info.t0)} .. ${Core.stamp(info.t1)} UTC; zone samples ${JSON.stringify(info.zone.map(([a, b]) => [Core.stamp(a, 0), b]))}`);
for (const s of info.sources) console.log(`  ${String(s.rows).padStart(8)}  ${s.kind.padEnd(10)} ${Core.stamp(s.t0, 0)} .. ${Core.stamp(s.t1, 0)}  ${s.path}`);
for (const n of info.notes) console.log('note:', n);
const show = async (label, q) => {
  t = performance.now();
  const r = await ds.query({ bins: 60, ...q }, () => {});
  const f = (name) => r.facets[name].values.slice(0, 8).map(([v, c]) => `${info.names[name][v] || '(none)'}=${c}`).join(', ');
  console.log(`\n[${label}] ${r.count} of ${r.total} in ${(performance.now() - t | 0)} ms${r.err ? ' ERR ' + r.err : ''}`);
  console.log(`  sev: ${f('sev')}\n  group: ${f('group')}\n  tag: ${f('tag')}\n  proc: ${f('proc')}`);
  return r;
};
await show('everything', {});
await show('errors and faults', { facets: { sev: { inc: [4, 5] } } });
await show('text: pivot', { text: 'pivot' });
await show('text: pivot (cached, + source facet)', { text: 'pivot', facets: { group: { inc: [0] } } });
await show('regex + exclusion', { text: '/memorystatus|jetsam/ -runningboardd' });
await show('field terms', { text: 'process:excel level:error -tag:memory' });
const r = await show('phrase, match case', { text: '"PivotTable"', cs: true });
const rows = await ds.rows(0, 3);
for (const x of rows) console.log('  row', Core.stamp(x[1]), info.names.lvl[x[3]], info.names.proc[x[4]], x[5], '|', String(x[9]).slice(0, 110));
if (r.count) { const d = await ds.row(rows[0][0]); console.log('  detail extra:', JSON.stringify(d.extra).slice(0, 200)); }
console.log('  next error from 0:', ds.findSev(0, 1, 4), ' seek(mid):', ds.seek((info.t0 + info.t1) / 2));
const blob = await ds.exportTsv(() => {});
console.log('  export bytes:', blob.size, JSON.stringify((await blob.slice(0, 160).text())));

// Content tags: each phrase must be found by the fast candidate scan and given the right tag, and look-alikes must not be.
{
  const cases = [
    ['permissions', 'kernel', 'Sandbox: Microsoft Excel(4121) deny(1) file-read-data /Volumes/Finance/Budget.xlsx'],
    ['permissions', 'tccd', 'AUTHREQ_SUBJECT: msgID=1.2, subject=com.microsoft.Excel,'],
    ['permissions', 'Microsoft Excel', 'access check for kTCCServiceSystemPolicyDesktopFolder'],
    ['permissions', 'launchd', 'posix_spawn failed with errno 13 - Permission denied'],
    ['permissions', 'OneDrive', 'request failed: {"code":"accessDenied"}'],
    ['permissions', 'OneDrive', 'HTTP 403 Forbidden'],
    ['permissions', 'Microsoft Excel', 'open(/x/y) - Operation not permitted'],
    ['permissions', 'Microsoft Excel', 'client is not authorized to read the folder'],
    ['permissions', 'OneDrive', 'HTTP 401 Unauthorized'],
    ['permissions', 'taskgated-helper', 'com.microsoft.Excel: Unsatisfied entitlements: com.apple.security.application-groups'],
    ['permissions', 'Microsoft Excel', 'target is not running or doesn\'t have entitlement com.apple.runningboard.assertions.webkit'],
    ['permissions', 'Microsoft Excel', 'open failed: EPERM'], ['permissions', 'Microsoft Excel', 'open failed: EACCES'],
    ['permissions', 'Microsoft Excel', 'Error Domain=NSCocoaErrorDomain Code=513 "You don\'t have permission to save the file"'],
    ['storage', 'Microsoft Excel', 'write failed: No space left on device'], ['storage', 'Microsoft Excel', 'write failed: ENOSPC'],
    ['storage', 'kernel', 'the startup disk is almost full'], ['storage', 'kernel', 'Volume full, cannot extend file'],
    ['storage', 'Microsoft Excel', 'The volume "Macintosh HD" is out of space'], ['storage', 'Microsoft Excel', 'not enough disk space to save'],
    ['storage', 'Microsoft Excel', 'insufficient free space for AutoRecover'], ['storage', 'diskspaced', 'low disk space warning'],
    ['storage', 'OneDrive', 'upload rejected: quota exceeded'], ['storage', 'kernel', 'disk3s1: Input/output error'],
    ['storage', 'kernel', 'apfs_vnop_write: I/O error'], ['storage', 'Microsoft Excel', 'save failed: Read-only file system'],
    ['storage', 'Microsoft Excel', 'Error Domain=NSCocoaErrorDomain Code=640 "out of room"'], ['storage', 'Microsoft Excel', 'Error Domain=NSPOSIXErrorDomain Code=28'],
    ['storage', 'Microsoft Excel', 'SaveWorkbook failed {"HRESULT":"0x80070070"}'],
    ['', 'Microsoft Update Assistant', 'Initializing NSHTTPCookieStorage singleton'], ['', 'kernel', 'Event Sendup Failed : no space for data'],
    ['', 'Microsoft Excel', 'Task <A1>.<5> finished successfully in the full screen namespace'], ['', 'kernel', 'memorystatus: Denying dirty-tracking opt-in'],
    ['', 'Microsoft Excel', 'SendEvent {"EventName":"Office.Extensibility.AddinSpecialPermissionHookInstall"}'], ['', 'Microsoft Excel', 'allow space between columns'],
    ['', 'Microsoft Excel', 'ModelList::GetModelForIdentity {"Entitlement":"Subscription"}'], ['', 'Microsoft Excel', 'Error Domain=NSCocoaErrorDomain Code=4 "No such file"'],
  ];
  const pad = (n) => String(n).padStart(2, '0');
  const lines = ['local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage'];
  cases.forEach(([, proc, msg], i) => lines.push(`2026-03-10 09:00:${pad(i)}.000000-0400\t2026-03-10 13:00:${pad(i)}.000000\tDefault\t${proc}\t1\t${proc}\t\t\t\t${msg}`));
  const d2 = new Core.Dataset();
  const inf = await d2.load([{ path: 'tagcheck/unified_logs/a.tsv', blob: new Blob([lines.join('\n') + '\n']) }], () => {});
  await d2.query({ bins: 10 }, () => {});
  const got = await d2.rows(0, cases.length);
  let bad = 0;
  got.forEach((r, i) => {
    const tags = inf.names.tag.filter((_, b) => r[8] >> b & 1).join(',');
    if (tags !== cases[i][0]) { bad++; console.log(`  TAG MISMATCH: wanted "${cases[i][0]}", got "${tags}" for: ${cases[i][2]}`); }
  });
  console.log(`\ncontent tags: ${cases.length - bad} of ${cases.length} phrases tagged as expected`);
  if (bad || got.length !== cases.length) Deno.exit(1);
}
