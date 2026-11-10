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
