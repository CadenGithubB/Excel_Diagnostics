// deno run --allow-read test/engine_test.mjs      or      node test/engine_test.mjs
//
// Checks what the engine in src/core.js works out against answers worked out by hand. The bundle below is small
// enough to read: eighteen entries from six kinds of source, every one made up. Each check names what it is about
// and prints what it wanted and what it got when the two differ. test/core_test.js is the other tool: it prints what
// the engine makes of any bundle you give it, and checks the content tags.
// The second half is about bundles that come from someone else: the ways a bundle can be handed over, files in
// copied folders that try to pass for the collector's or the system's own, and files made to be slow to read.

const here = new URL('../src/core.js', import.meta.url);
const source = typeof Deno !== 'undefined' ? await Deno.readTextFile(here) : await (await import('node:fs/promises')).readFile(here, 'utf8');
const Core = new Function(source + '\nreturn Core;')();

let passed = 0, failed = 0;
function is(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  console.log(`FAIL ${what}\n  wanted ${JSON.stringify(want)}\n  got    ${JSON.stringify(got)}`);
}
const has = (what, text, piece) => is(what, String(text).includes(piece) ? piece : String(text), piece);

// ---------- the made-up bundle ----------
const TOP = 'Excel_Diagnostics_collect_20260310_120000/';
const UNIFIED = [
  'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage',
  '2026-03-10 09:00:00.000000-0400\t2026-03-10 13:00:00.000000\tDefault\tMicrosoft Excel\t4121\tAppKit\tcom.apple.AppKit\tWindow\texcel\tOpened Budget.xlsx',
  '2026-03-10 09:00:01.250000-0400\t2026-03-10 13:00:01.250000\tError\tMicrosoft Excel\t4121\tmso\tcom.microsoft.office\tsave\texcel,storage\tSave failed: No space left on device\\nsecond line\\twith tab',
  '2026-03-10 09:00:02.000000-0400\t2026-03-10 13:00:02.000000\tFault\tkernel\t0\tkernel\t\t\tmemory\tmemorystatus: killing Microsoft Excel',
  '2026-03-10 09:00:03.000000-0400\t2026-03-10 13:00:03.000000\tInfo\trunningboardd\t164\tRunningBoard\tcom.apple.runningboard\tprocess\tmentions-excel\tAssertion for Microsoft Excel',
  '2026-03-10 09:00:04.000000-0400\t2026-03-10 13:00:04.000000\tDebug\tMicrosoft Excel\t4121\tCoreFoundation\tcom.apple.defaults\tUser Defaults\texcel\tfound no value for key Pivot',
  '2026-03-10 09:00:05.123456-0400\t2026-03-10 13:00:05.123456\tDefault\tMicrosoft Excel\t4307\tAppKit\tcom.apple.AppKit\tWindow\texcel\tpivot table refreshed',
].join('\n') + '\n';
const EXCEL = [                                         // Excel's own log: UTC, CRLF line ends, the process ID in hex
  'Timestamp\tProcess\tTID\tArea\tCategory\tEventID\tLevel\tMessage\tCorrelation',
  '03/10/2026 13:00:00.500\tEXCEL (0x1019)\t0x1\tMicrosoft Excel\tXLS PivotTable\tabc12\tMedium\tPivotCache::Refresh {"Records":10}\t',
  '03/10/2026 13:00:02.500\tEXCEL (0x1019)\t0x2\tMicrosoft Excel\tMSO AutoRecover\tabc13\tUnexpected\tAutoRecover failed\t',
  '03/10/2026 13:00:06.000\tEXCEL (0x10D3)\t0x1\tMicrosoft Excel\tIdentity\tabc14\tMonitorable\tToken refresh slow\t',
].join('\r\n') + '\r\n';
const FILES = {
  'manifest.tsv': 'component\tstatus\tdetails\nunified_log_tags\tcomplete\texcel, mentions-excel, memory, permissions, storage\n',
  'unified_logs/2026-03-10.tsv': UNIFIED,
  'office/excel_container_logs/Diagnostics/EXCEL/Primary1.log': EXCEL,
  // local time with no offset: placed using the offset the unified log gives
  'office/autoupdate.log': '2026-03-10 09:00:10 [Microsoft Update Assistant] <Info> Checking for updates\n2026-03-10 09:00:20 [Microsoft Update Assistant] <Warning> Manifest error: -1100\n',
  'system/sleep_wake.txt': '2026-03-10 08:59:00 -0400 Wake                \tWake from Deep Idle\t\n2026-03-10 09:30:00 -0400 Sleep               \tEntering Sleep state\t\n',
  'system/install_history_microsoft.txt': '2026-03-09 08:00:00-04 mac installd[123]: PackageKit: Installed "Microsoft Excel" (16.114)\n',
  'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-090130.ips':
    '{"app_name":"Microsoft Excel","timestamp":"2026-03-10 09:01:30.00 -0400","app_version":"16.114","bug_type":"309","os_version":"macOS 15.7 (24G1)"}\n{\n  "exception" : {"type":"EXC_BAD_ACCESS","signal":"SIGSEGV"},\n  "faultingThread" : 0\n}\n',
  'reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090100.ips':
    '{"bug_type":"298","timestamp":"2026-03-10 09:01:00.00 -0400","os_version":"macOS 15.7 (24G1)"}\n{"largestProcess":"Microsoft Excel"}\n',
  // no date inside, so the time comes from the file name, which is in the Mac's local time
  'reports/Library_Logs_DiagnosticReports/Microsoft Excel_2026-03-10-085500_Host.cpu_resource.diag': 'Event:            cpu usage\nAction taken:     none\n',
  'reports/CrashReporter/Microsoft Excel_0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.txt': '{\n  "ForceQuitDate" => 2026-03-10 08:50:00 -0400\n}\n',
};
const folder = () => Object.entries(FILES).map(([path, text]) => ({ path: TOP + path, blob: new Blob([text]) }));
const at = (h, m, s, day = 10) => Date.UTC(2026, 2, day, h, m, s);
const ORDER = [                                         // the eighteen entries in time order: UTC time, source, level, process, PID
  ['2026-03-09 12:00:00.000000', 'install', '', 'installd', 123],
  ['2026-03-10 12:50:00.000000', 'report', 'Force quit', 'Microsoft Excel', 0],
  ['2026-03-10 12:55:00.000000', 'report', 'Diag', 'Microsoft Excel', 0],
  ['2026-03-10 12:59:00.000000', 'power', 'Default', 'powerd', 0],
  ['2026-03-10 13:00:00.000000', 'unified', 'Default', 'Microsoft Excel', 4121],
  ['2026-03-10 13:00:00.500000', 'excel', 'Medium', 'Microsoft Excel', 4121],
  ['2026-03-10 13:00:01.250000', 'unified', 'Error', 'Microsoft Excel', 4121],
  ['2026-03-10 13:00:02.000000', 'unified', 'Fault', 'kernel', 0],
  ['2026-03-10 13:00:02.500000', 'excel', 'Unexpected', 'Microsoft Excel', 4121],
  ['2026-03-10 13:00:03.000000', 'unified', 'Info', 'runningboardd', 164],
  ['2026-03-10 13:00:04.000000', 'unified', 'Debug', 'Microsoft Excel', 4121],
  ['2026-03-10 13:00:05.123456', 'unified', 'Default', 'Microsoft Excel', 4307],
  ['2026-03-10 13:00:06.000000', 'excel', 'Monitorable', 'Microsoft Excel', 4307],
  ['2026-03-10 13:00:10.000000', 'autoupdate', 'Info', 'Microsoft Update Assistant', 0],
  ['2026-03-10 13:00:20.000000', 'autoupdate', 'Warning', 'Microsoft Update Assistant', 0],
  ['2026-03-10 13:01:00.000000', 'report', 'Jetsam', 'JetsamEvent', 0],
  ['2026-03-10 13:01:30.000000', 'report', 'Crash', 'Microsoft Excel', 0],
  ['2026-03-10 13:30:00.000000', 'power', 'Default', 'powerd', 0],
];

// ---------- a small zip writer, so the zip reader can be checked against the same bundle ----------
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) { let c = (crc ^ bytes[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
async function deflate(bytes) {
  const cs = new CompressionStream('deflate-raw'), w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function makeZip(files) {                         // [{path, bytes, packed}] -> Blob
  const parts = [], dir = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.path), data = f.packed ? await deflate(f.bytes) : f.bytes, crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30)), central = new DataView(new ArrayBuffer(46));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, f.packed ? 8 : 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, f.bytes.length, true); local.setUint16(26, name.length, true);
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(10, f.packed ? 8 : 0, true);
    central.setUint32(16, crc, true); central.setUint32(20, data.length, true); central.setUint32(24, f.bytes.length, true); central.setUint16(28, name.length, true); central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    dir.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, dir.reduce((a, x) => a + x.length, 0), true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...dir, new Uint8Array(end.buffer)]);
}

// ---------- loading ----------
const quiet = () => {};
const ds = new Core.Dataset();
const info = await ds.load(folder(), quiet);
const names = (kind, ids) => ids.map((v) => info.names[kind][v]);

is('bundle name is the top folder', info.name, TOP.slice(0, -1));
is('entries on the timeline', info.total, 18);
is('every file is listed', info.files.length, Object.keys(FILES).length);
is('first and last time', [Core.stamp(info.t0, 0), Core.stamp(info.t1, 0)], ['2026-03-09 12:00:00', '2026-03-10 13:30:00']);
is("the Mac's UTC offset, read from the logs", info.zone.map((z) => z[1]), [-240]);
is('sources, by kind, with their entry counts',
  info.sources.map((s) => [s.kind, s.rows]).sort(), [['autoupdate', 2], ['install', 1], ['office', 3], ['power', 2], ['report', 4], ['unified', 6]]);
is('source groups in display order', info.names.group, ['macOS unified log', 'Excel diagnostics', 'Crash and hang reports', 'Microsoft AutoUpdate', 'Install history', 'Sleep / wake']);
is('the period the macOS and Excel logs cover, with a minute either side', info.focus, [at(13, 0, 0) - 60000, at(13, 0, 6) + 60000]);
is('reports, by time', info.reports.map((r) => [Core.stamp(r.t, 0), r.kind, r.proc]).sort(), [
  ['2026-03-10 12:50:00', 'Force quit', 'Microsoft Excel'], ['2026-03-10 12:55:00', 'Diag', 'Microsoft Excel'],
  ['2026-03-10 13:01:00', 'Jetsam', 'JetsamEvent'], ['2026-03-10 13:01:30', 'Crash', 'Microsoft Excel']]);
const excelSource = info.sources.find((s) => s.kind === 'office');
is('one Excel log, named for the app in its path', [excelSource.group, excelSource.short], ['Excel diagnostics', 'excel']);

// ---------- the merged timeline ----------
const all = await ds.query({ bins: 6 }, quiet);
is('a search for nothing shows everything', [all.count, all.total], [18, 18]);
const rows = await ds.rows(0, 50);
is('entries in time order: time, source, level, process, PID',
  rows.map((r) => [Core.stamp(r[1], 6), info.sources[r[2]].short, info.names.lvl[r[3]], info.names.proc[r[4]], r[5]]), ORDER);
is('how each level is counted', rows.map((r) => Core.SEV[info.lvlSev[r[3]]]),
  ['Info', 'Error', 'Warning', 'Notice', 'Notice', 'Info', 'Error', 'Fault', 'Error', 'Info', 'Debug', 'Notice', 'Warning', 'Info', 'Warning', 'Error', 'Fault', 'Notice']);
is('tags on the unified log entries', rows.filter((r) => info.sources[r[2]].kind === 'unified').map((r) => info.names.tag.filter((_, b) => (r[8] >> b) & 1).join(',')),
  ['excel', 'excel,storage', 'memory', 'mentions-excel', 'excel', 'excel']);
is('escaped line break and tab in a message are restored', rows[6][9], 'Save failed: No space left on device\nsecond line\twith tab');
is('subsystem and category', [info.names.sub[rows[6][6]], info.names.cat[rows[6][7]]], ['com.microsoft.office', 'save']);
is('the Excel log message, without its other columns', rows[5][9], 'PivotCache::Refresh {"Records":10}');
is('the area and category of an Excel log entry', [info.names.sub[rows[5][6]], info.names.cat[rows[5][7]]], ['Microsoft Excel', 'XLS PivotTable']);
is('sleep and wake kind is the category', [info.names.cat[rows[3][7]], info.names.cat[rows[17][7]]], ['Wake', 'Sleep']);
has('a crash report entry names its file', rows[16][9], 'Crash: Microsoft Excel-2026-03-10-090130.ips');
has('and says what its header records', rows[16][9], 'bug type 309; version 16.114; macOS 15.7 (24G1)');
has('a resource report says what its header records', rows[2][9], 'Event: cpu usage; Action taken: none');
is('chart bins hold every entry once', all.hist.bins.reduce((a, n) => a + n, 0), 18);
is('chart bins by severity: other, warnings, errors and faults',
  [0, 1, 2].map((k) => all.hist.bins.filter((_, i) => i % 3 === k).reduce((a, n) => a + n, 0)), [9, 3, 6]);

const detail = await ds.row(rows[11][0]);
is('details: the time as the Mac wrote it, and the sender', [detail.extra['Local time'], detail.extra.Sender], ['2026-03-10 09:00:05.123456-0400', 'AppKit']);
const xdetail = await ds.row(rows[5][0]);
is('details of an Excel log entry', [xdetail.extra['Thread (TID)'], xdetail.extra['Event ID']], ['0x1', 'abc12']);
is('details of a report entry point at its file', (await ds.row(rows[16][0])).extra.file, 'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-090130.ips');

// ---------- one report, laid out ----------
const crash = await ds.report('reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-090130.ips');
is('crash report: kind, process and time', [crash.kind, crash.proc, Core.stamp(crash.t, 0)], ['Crash', 'Microsoft Excel', '2026-03-10 13:01:30']);
is('crash report: the facts it records, in order', crash.facts, [['Report time', '2026-03-10 09:01:30.00 -0400'], ['Report type', 'bug type 309'], ['App', 'Microsoft Excel version 16.114'],
  ['macOS', 'macOS 15.7 (24G1)'], ['Exception type', 'EXC_BAD_ACCESS (SIGSEGV)']]);
is('crash report: what goes on the timeline', crash.what.join('; '), 'bug type 309; version 16.114; macOS 15.7 (24G1); EXC_BAD_ACCESS (SIGSEGV)');
is('crash report: no thread is singled out when the report lists none', crash.stack, null);
const diag = await ds.report('reports/Library_Logs_DiagnosticReports/Microsoft Excel_2026-03-10-085500_Host.cpu_resource.diag');
is('resource report: kind and the header lines it has', [diag.kind, diag.facts], ['Diag', [['Event', 'cpu usage'], ['Action taken', 'none']]]);
is('a force-quit record has nothing to lay out', (await ds.report('reports/CrashReporter/Microsoft Excel_0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.txt')).facts, []);
const full = [                                          // a crash report with everything the reader looks for
  '{"app_name":"Microsoft Excel","timestamp":"2026-03-10 09:01:30.00 -0400","app_version":"16.114","build_version":"16.114.26030814","bug_type":"309","os_version":"macOS 15.7 (24G1)"}',
  JSON.stringify({ procName: 'Microsoft Excel', pid: 4121, procPath: '/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel', translated: false, cpuType: 'ARM-64',
    parentProc: 'launchd', parentPid: 1, bundleInfo: { CFBundleShortVersionString: '16.114', CFBundleVersion: '16.114.26030814', CFBundleIdentifier: 'com.microsoft.Excel' },
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x18', codes: '0x1, 0x18' }, termination: { namespace: 'SIGNAL', code: 11, indicator: 'Segmentation fault: 11', byProc: 'exc handler', byPid: 4121 },
    faultingThread: 1, threads: [{ id: 1, frames: [{ imageIndex: 1, symbol: 'mach_msg', symbolLocation: 8 }] }, { id: 2, name: 'worker', triggered: true, frames: [{ imageIndex: 0, imageOffset: 4660 }, { imageIndex: 1, symbol: 'start_wqthread', symbolLocation: 8, sourceFile: 'thread.c', sourceLine: 12 }] }],
    usedImages: [{ name: 'Microsoft Excel', path: '/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel', arch: 'arm64', CFBundleShortVersionString: '16.114' }, { path: '/usr/lib/system/libsystem_kernel.dylib', arch: 'arm64e' }] }, null, 2),
].join('\n') + '\n';
const fs = new Core.Dataset(), finfo = await fs.load([{ path: 'r/reports/Microsoft Excel-2026-03-10-090130.ips', blob: new Blob([full]) }], quiet);
const fr = await fs.report('reports/Microsoft Excel-2026-03-10-090130.ips');
const factOf = (label) => (fr.facts.find((f) => f[0] === label) || [])[1];
is('full crash report: process, version, Rosetta, parent', ['Process', 'Version', 'Running under Rosetta', 'Parent process'].map(factOf), ['Microsoft Excel [4121]', '16.114 (16.114.26030814)', 'no', 'launchd [1]']);
is('full crash report: exception and termination', ['Exception type', 'Exception subtype', 'Exception codes', 'Termination', 'Terminated by'].map(factOf),
  ['EXC_BAD_ACCESS (SIGSEGV)', 'KERN_INVALID_ADDRESS at 0x18', '0x1, 0x18', 'namespace SIGNAL, code 11, Segmentation fault: 11', 'exc handler [4121]']);
is('full crash report: the thread it marks as crashed', factOf('Thread marked as crashed'), '1, "worker"');
is('full crash report: that thread\'s frames, with image names from the report\'s own list', fr.stack.frames,
  [{ image: 'Microsoft Excel', symbol: '', offset: '+ 4660', source: '' }, { image: 'libsystem_kernel.dylib', symbol: 'start_wqthread', offset: '+ 8', source: 'thread.c:12' }]);
is('full crash report: images', fr.images.map((im) => [im.name, im.version]), [['Microsoft Excel', '16.114'], ['libsystem_kernel.dylib', '']]);
is('full crash report: its timeline line can be searched for the frames', finfo.reports[0].what,
  'bug type 309; version 16.114; macOS 15.7 (24G1); EXC_BAD_ACCESS (SIGSEGV); KERN_INVALID_ADDRESS at 0x18; Segmentation fault: 11; thread 1: Microsoft Excel < start_wqthread');
is('and a search finds it', (await fs.query({ bins: 6, text: 'start_wqthread' }, quiet)).count, 1);
const spin = 'Date/Time:        2026-03-10 09:02:00.000 -0400\nCommand:          Microsoft Excel\nPath:             /Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel\nEvent:            hang\nDuration:         3.50s\nSteps:            35 (100ms sampling interval)\n\n' +
  'Heaviest stack for the main thread of the target process:\n  35  start + 1 (dyld + 100) [0x1]\n    35  NSApplicationMain + 800 (AppKit + 200) [0x2]\n\nProcess:          Microsoft Excel [4121]\n';
const hs = new Core.Dataset();
await hs.load([{ path: 'h/excel_spindump.txt', blob: new Blob([spin]) }], quiet);
const hr = await hs.report('excel_spindump.txt');
is('the collector\'s own spindump is a report: kind, process, time', [hr.kind, hr.proc, Core.stamp(hr.t, 0)], ['Spindump', 'Microsoft Excel', '2026-03-10 13:02:00']);
is('spindump: the stack block it leads with, as written', [hr.stack.title, hr.stack.lines], ['Heaviest stack for the main thread of the target process', ['  35  start + 1 (dyld + 100) [0x1]', '    35  NSApplicationMain + 800 (AppKit + 200) [0x2]']]);
is('spindump: what goes on the timeline, with the last lines of its stack so they can be searched for', hr.what.join('; '),
  'Event: hang; Duration: 3.50s; Heaviest stack for the main thread of the target process: 35 start + 1 (dyld + 100) [0x1] | 35 NSApplicationMain + 800 (AppKit + 200) [0x2]');
await hs.query({ bins: 6 }, quiet);
is('and a search for a function in that stack finds the report', (await hs.query({ bins: 6, text: 'NSApplicationMain' }, quiet)).count, 1);

// reports in shapes the reader has to survive
const shape = async (name, text, cap) => {
  const d = new Core.Dataset(), inf = await d.load([{ path: `s/reports/${name}`, blob: new Blob([text]) }], quiet);
  return { inf, rep: cap ? await d.readReport(d.entries[0], cap) : await d.report(`reports/${name}`), d };
};
const head309 = '{"app_name":"Microsoft Excel","timestamp":"2026-03-10 09:01:30.00 -0400","bug_type":"309"}\n';
const big = await shape('Microsoft Excel-2026-03-10-090130.ips', head309 + JSON.stringify({ exception: { type: 'EXC_CRASH' }, faultingThread: 0, pad: 'x'.repeat(20000), threads: [{ frames: [{ imageIndex: 0, symbol: 'deepFrame' }] }], usedImages: [{ name: 'Tool' }] }) + '\n');
is('a report longer than the first 8 KB is still read whole', [big.rep.read === big.rep.size, big.rep.stack.frames[0].symbol, big.inf.reports[0].what.includes('thread 0: deepFrame')], [true, 'deepFrame', true]);
const tooBig = await shape('Microsoft Excel-2026-03-10-090131.ips', head309 + JSON.stringify({ exception: { type: 'EXC_CRASH' }, pad: 'x'.repeat(20000) }) + '\n', 4096);
is('a JSON body that could not be read whole is marked as header only, and none of it is guessed at', [tooBig.rep.headerOnly, tooBig.rep.stack, tooBig.rep.facts.map((x) => x[0])], [true, null, ['Report time', 'Report type', 'App']]);
const flagged = await shape('Microsoft Excel-2026-03-10-090132.ips', head309 + JSON.stringify({ threads: [{ frames: [{ symbol: 'idle' }] }, { triggered: true, frames: [{ symbol: 'marked' }] }] }) + '\n');
is('with no faultingThread, the thread flagged as triggered is the one shown', [flagged.rep.stack.title, flagged.rep.stack.frames[0].symbol], ['Thread 1, the one the report marks as crashed', 'marked']);
const both = await shape('Microsoft Excel-2026-03-10-090133.ips', head309 + JSON.stringify({ faultingThread: 0, threads: [{ frames: [{ symbol: 'named' }] }, { triggered: true, frames: [{ symbol: 'flagged' }] }] }) + '\n');
is('faultingThread decides when it and the flag disagree', both.rep.stack.frames[0].symbol, 'named');
const notCrash = await shape('Tool-2026-03-10-090134.ips', '{"app_name":"Tool","timestamp":"2026-03-10 09:01:34.00 -0400","bug_type":"385"}\n' + JSON.stringify({ faultingThread: 0, threads: [{ frames: [{ symbol: 'f' }] }] }) + '\n');
is('a report that is not a crash report is not said to have a crashed thread', [notCrash.rep.kind, notCrash.rep.stack.title, notCrash.rep.facts.find((x) => /Thread/.test(x[0]))[0]], ['Report', 'Thread 0, the one the report names', 'Thread the report names']);
const odd = await shape('Microsoft Excel-2026-03-10-090135.ips', head309 + JSON.stringify({ exception: 'EXC_BAD_ACCESS', faultingThread: 0, threads: [{ frames: [null, 7, { imageIndex: 99, symbol: 5 }] }, null], usedImages: [null, { path: 12 }] }) + '\n');
is('a report with nulls and wrong types among its frames and images still opens', [odd.inf.total, odd.rep.stack.frames.length, odd.rep.images.length], [1, 3, 2]);
const junk = await shape('Microsoft Excel-2026-03-10-090136.ips', '{not json at all\n\u0000\u0001\u0002');
is('a file that is not a report is still listed, under the name its file gives', [junk.inf.total, junk.inf.reports[0].kind, junk.inf.reports[0].proc], [1, 'Report', 'Microsoft Excel']);
const old = await shape('Microsoft Excel_2026-03-10-090137_Host.crash', 'Process:               Microsoft Excel [4121]\nPath:                  /Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel\nDate/Time:             2026-03-10 09:01:37.000 -0400\nOS Version:            macOS 12.7 (21H1)\nCrashed Thread:        0  Dispatch queue: com.apple.main-thread\nException Type:        EXC_BAD_ACCESS (SIGSEGV)\n\nThread 0 Crashed:: Dispatch queue: com.apple.main-thread\n0   Microsoft Excel   0x0000000104a3c1f0 PivotFilterApply + 532\n1   Microsoft Excel   0x0000000104a3b9d4 PivotTableUpdate + 96\n\nThread 1:\n0   libsystem_kernel.dylib   0x1 mach_msg_trap + 8\n');
is('an old text crash report: kind, process, time and the thread block it leads with', [old.rep.kind, old.rep.proc, Core.stamp(old.rep.t, 0), old.rep.stack.lines.length], ['Crash', 'Microsoft Excel', '2026-03-10 13:01:37', 2]);
is('and its timeline line carries the exception and the first lines of that thread', old.inf.reports[0].what,
  'Exception Type: EXC_BAD_ACCESS (SIGSEGV); Crashed Thread: 0 Dispatch queue: com.apple.main-thread; Thread 0 Crashed:: Dispatch queue: com.apple.main-thread: 0 Microsoft Excel 0x0000000104a3c1f0 PivotFilterApply + 532 | 1 Microsoft Excel 0x0000000104a3b9d4 PivotTableUpdate + 96');

// ---------- facts about the Mac and the collection ----------
const facts = Object.fromEntries((await ds.facts()).map((f) => [f.label, [f.value, f.path]]));
is('facts: a bundle with no summary says only what it has', facts, { 'Collector mode': ['collect', ''], 'Collector version': ['not recorded in this bundle (collectors before 1.5.0 did not write it)', ''], 'Names hidden': ['not asked for', 'manifest.tsv'] });
const sysinfo = '=== Collected ===\nTue Mar 10 12:00:00 EDT 2026\nTue Mar 10 16:00:00 UTC 2026\nMode: collect  Days: 3  Ran as: root  Console user: redacted-user\n\n=== macOS ===\nProductName:\t\tmacOS\nProductVersion:\t\t15.7\nBuildVersion:\t\t24G1\n\n' +
  '=== Hardware ===\nHardware:\n\n    Hardware Overview:\n\n      Model Name: MacBook Pro\n      Model Identifier: MacBookPro18,3\n      Chip: Apple M1 Pro\n      Total Number of Cores: 10 (8 performance and 2 efficiency)\n      Memory: 16 GB\n' +
  '=== Uptime / load ===\n12:00  up 3 days,  2:10, 2 users, load averages: 2.10 2.05 1.98\n\n=== Disk ===\nFilesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on\n/dev/disk3s1s1   460Gi    10Gi   120Gi     8%    453k  1.3G    0%   /\n/dev/disk3s5     460Gi   320Gi   120Gi    73%    2.1M  1.3G    0%   /System/Volumes/Data\n';
const sysFiles = { 'manifest.tsv': 'component\tstatus\tdetails\nredaction\tcomplete\t12 replacement(s) in 3 of 9 text file(s)\n', 'summary.md': '# Excel diagnostics summary\n\n- Collected: 2026-03-10 12:00:00 EDT\n- Mode: collect\n- Incident window: 2026-03-08 through 2026-03-10 (3 day(s))\n',
  'system/system_info.txt': sysinfo, 'office/versions.txt': 'Microsoft Excel: 16.114 (16.114.26030814)\nMicrosoft Word: 16.114 (16.114.26030814)\nOneDrive: 26.035 (26035.0221)\n' };
const ys = new Core.Dataset();
await ys.load(Object.entries(sysFiles).map(([path, text]) => ({ path: 'y/' + path, blob: new Blob([text]) })).concat({ path: 'y/unified_logs/a.tsv', blob: new Blob([UNIFIED]) }), quiet);
is('facts: read from the files an older collector wrote', (await ys.facts()).map((f) => [f.label, f.value]), [
  ['Collected', '2026-03-10 12:00:00 EDT'], ['Collector mode', 'collect'], ['Log search window', '2026-03-08 through 2026-03-10 (3 day(s))'],
  ['Collector version', 'not recorded in this bundle (collectors before 1.5.0 did not write it)'], ['Redaction, as the collector recorded it', 'complete: 12 replacement(s) in 3 of 9 text file(s)'],
  ['macOS', '15.7 (24G1)'], ['Mac', 'MacBook Pro (MacBookPro18,3)'], ['Processor', 'Apple M1 Pro, 10 cores (8 performance and 2 efficiency)'], ['Memory installed', '16 GB'],
  ['Startup disk', '120Gi available of 460Gi, 73% of capacity in use (/System/Volumes/Data)'], ['Uptime when collected', '3 days, 2:10'], ['Load averages when collected', '2.10 2.05 1.98 (over 1, 5 and 15 minutes)'],
  ['Excel', '16.114 (16.114.26030814)'], ['Other Office apps', 'Word 16.114 (16.114.26030814), OneDrive 26.035 (26035.0221)']]);

// ---------- events and coverage for the chart ----------
const marks = await ds.marks();
is('marks: each report, each Excel process, and install activity, in time order', marks.marks.map((m) => [Core.stamp(m.t, 0), m.kind, m.text]), [
  ['2026-03-09 12:00:00', 'install', 'Install history: 1 line that mentions Microsoft, Excel or Office'],
  ['2026-03-10 12:50:00', 'report', 'Force quit recorded: Microsoft Excel'], ['2026-03-10 12:55:00', 'report', 'Diag report: Microsoft Excel'],
  ['2026-03-10 13:00:00', 'excel', 'First entry from Microsoft Excel with process ID 4121'], ['2026-03-10 13:00:05', 'excel', 'First entry from Microsoft Excel with process ID 4307'],
  ['2026-03-10 13:01:00', 'report', 'Jetsam report: JetsamEvent'], ['2026-03-10 13:01:30', 'report', 'Crash report: Microsoft Excel']]);
is('marks: without a status file, the macOS log covers from its first entry to its last', marks.cover.unified.map((c) => c.map((t) => Core.stamp(t, 0))), [['2026-03-10 13:00:00', '2026-03-10 13:00:05']]);
is("marks: Excel's own logs cover from their first entry to their last", marks.cover.office.map((c) => c.map((t) => Core.stamp(t, 0))), [['2026-03-10 13:00:00', '2026-03-10 13:00:06']]);
is('marks: no sleep is recorded with a length, so none is drawn', marks.asleep, []);
const cover = async (status, sleep, oneDay) => {
  const d = new Core.Dataset();
  const inf = await d.load([{ path: 'c/unified_logs/2026-03-09.tsv', blob: new Blob([UNIFIED.replace(/2026-03-10 09:/g, '2026-03-09 21:').replace(/2026-03-10 13:/g, '2026-03-10 01:')]) },
    ...(oneDay ? [] : [{ path: 'c/unified_logs/2026-03-10.tsv', blob: new Blob([UNIFIED]) }]),
    { path: 'c/unified_logs/collection_status.txt', blob: new Blob([status]) }, { path: 'c/system/sleep_wake.txt', blob: new Blob([sleep]) },
    { path: 'c/summary.md', blob: new Blob(['- Collected: 2026-03-10 12:00:00 EDT\n']) }], quiet);
  const m = await d.marks();
  await d.query({ bins: 6, text: 'source:power' }, quiet);
  return { unified: m.cover.unified.map((c) => c.map((t) => Core.stamp(t, 0))), asleep: m.asleep.map((c) => c.map((t) => Core.stamp(t, 0))), kinds: m.marks.map((x) => x.kind).join(' '),
    categories: (await d.rows(0, 10)).map((r) => inf.names.cat[r[7]]) };
};
const sleeps = "2026-03-10 02:00:00 -0400 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using AC (Charge:100%) 3600 secs  \n" +
  '2026-03-10 02:00:02 -0400 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=1034]\n2026-03-10 03:00:00 -0400 Wake                \tWake from Normal Sleep [CDNVA] : due to UserActivity Using AC (Charge:100%)           \n' +
  '2026-03-10 08:00:00 -0400 Restart             \tRestart\n';
const done = await cover('Date | Status\n2026-03-09 | ok (6 entries)\n2026-03-10 | ok (6 entries)\n', sleeps);
is('coverage: a day whose search finished is covered to the moment of collection, and from its start when earlier entries exist',
  done.unified, [['2026-03-10 01:00:00', '2026-03-10 16:00:00']]);
is('coverage: a sleep is drawn for as long as its own line says', done.asleep, [['2026-03-10 06:00:00', '2026-03-10 07:00:00']]);
is('a list of wake requests is its own kind of line, not a wake', done.categories, ['Sleep', 'Wake Requests', 'Wake', 'Restart']);
is('every report knows its own row on the timeline', info.reports.map((r) => rows[r.pos][9].split(':')[0]).sort(), ['Crash', 'Diag', 'Force quit', 'Jetsam']);
const nothing = await cover('Date | Status\n2026-03-09 | ok (6 entries)\n2026-03-10 | ok, nothing found (no matching entries, or macOS no longer has logs for this day)\n', sleeps, true);
is('coverage: a day searched to the end with nothing found is covered, when an earlier day has entries', nothing.unified, [['2026-03-10 01:00:00', '2026-03-10 16:00:00']]);
const none = new Core.Dataset();
await none.load([{ path: 'n/unified_logs/collection_status.txt', blob: new Blob(['Date | Status\naccess check | skipped: insufficient access\n']) }, { path: 'n/office/excel_container_logs/Diagnostics/EXCEL/Primary1.log', blob: new Blob([EXCEL]) }], quiet);
const noneMarks = await none.marks();
is('a collector bundle with no macOS log at all says the log was looked for and covers nothing', [noneMarks.searched, noneMarks.cover.unified], [true, []]);
const loose = new Core.Dataset();
await loose.load([{ path: 'Primary1.log', blob: new Blob([EXCEL]) }], quiet);
is('loose log files, with no sign of a collector, do not claim that', (await loose.marks()).searched, false);
const hang = new Core.Dataset();
await hang.load([{ path: 'g/unified_last30m.tsv', blob: new Blob([UNIFIED]) }, { path: 'g/manifest.tsv', blob: new Blob(['component\tstatus\tdetails\nunified_last30m\tcomplete\thang capture, 6 entries\n']) },
  { path: 'g/bundle_info.tsv', blob: new Blob(['collector_version\t1.5.0\nmode\thang\ncollected_utc\t2026-03-10 13:10:00\n']) }], quiet);
is('a hang capture covers the half hour before it, not just its first entry to its last', (await hang.marks()).cover.unified.map((c) => c.map((t) => Core.stamp(t, 0))), [['2026-03-10 12:40:00', '2026-03-10 13:10:00']]);
is('all time runs on to the moment of collection, so its mark can be seen', [Core.stamp(hang.info([]).end, 0), Core.stamp((await hang.query({ bins: 6 }, quiet)).hist.t1 - 1, 0)], ['2026-03-10 13:10:00', '2026-03-10 13:10:00']);
const zoneless = new Core.Dataset();
await zoneless.load([{ path: 'z/office/excel_container_logs/Diagnostics/EXCEL/Primary1.log', blob: new Blob([EXCEL]) }, { path: 'z/summary.md', blob: new Blob(['- Collected: 2026-03-10 12:00:00 EDT\n']) }], quiet);
is('a collection time with no offset is left off the chart when no log gives the zone of the Mac', (await zoneless.marks()).marks.filter((m) => m.kind === 'collected').length, 0);

// the built-in sample has everything a current collector writes
const sampleSet = new Core.Dataset();
await sampleSet.load(Core.sampleBundle(1), quiet);
is('sample: facts come from bundle_info.tsv where it has them', (await sampleSet.facts()).filter((x) => x.path === 'bundle_info.tsv').map((x) => [x.label, x.value]), [
  ['Collected', '2026-03-10 12:03:40 EDT (2026-03-10 16:03:40 UTC)'], ['Collector mode', 'collect'], ['Collector version', '1.5.0'], ['macOS', '15.7.8 (24G824)'], ['Mac', 'MacBook Pro (MacBookPro18,1)'],
  ['Processor', 'Apple M1 Pro'], ['Memory installed', '16 GB'], ['Excel', '16.114 (16.114.26030814)']]);
const sampleMarks = await sampleSet.marks();
is('sample: marks', sampleMarks.marks.map((m) => [Core.stamp(m.t, 0), m.kind]), [['2026-03-10 13:00:00', 'excel'], ['2026-03-10 14:32:30', 'report'], ['2026-03-10 14:35:00', 'report'], ['2026-03-10 14:35:00', 'excel'], ['2026-03-10 16:03:40', 'collected']]);
is('sample: the macOS log covers its day up to the collection, and one sleep is recorded with its length',
  [sampleMarks.cover.unified.map((c) => c.map((t) => Core.stamp(t, 0))), sampleMarks.asleep.map((c) => c.map((t) => Core.stamp(t, 0)))], [[['2026-03-10 13:00:00', '2026-03-10 16:03:40']], [['2026-03-10 15:50:00', '2026-03-10 15:59:00']]]);
is('coverage: each Excel process once, a restart, and the collection are marked', done.kinds, 'excel excel power collected');
const cut = await cover('Date | Status\n2026-03-09 | ok (6 entries)\n2026-03-10 | hit the 3-minute limit, partial (6 entries; rerun with a larger --max-wait for the rest)\n', sleeps);
is('coverage: a day cut short is covered only as far as its entries go', cut.unified, [['2026-03-10 01:00:00', '2026-03-10 04:00:00'], ['2026-03-10 13:00:00', '2026-03-10 13:00:05']]);

// ---------- moving around the list ----------
is('seek: first entry at or after a time', ds.seek(at(13, 0, 2)), 7);
is('seek past the end stops on the last entry', ds.seek(at(23, 0, 0)), 17);
is('next error or fault after the first entry', ds.findSev(0, 1, 4), 1);
is('next fault after that', ds.findSev(1, 1, 5), 7);
is('previous error or fault before the last entry', ds.findSev(17, -1, 4), 16);
is('none after the last', ds.findSev(17, 1, 4), -1);
is('entries tagged memory over time', ds.tagTimes('memory', 10).total, 1);

// ---------- searching ----------
const count = async (q) => (await ds.query({ bins: 6, ...q }, quiet)).count;
is('a word, anywhere on the line, capitals ignored', await count({ text: 'pivot' }), 3);
is('the same word with Match case', await count({ text: 'Pivot', cs: true }), 2);
is('a phrase', await count({ text: '"pivot table"' }), 1);
is('two words: both must be there', await count({ text: 'pivot refresh' }), 2);
is('a regular expression', await count({ text: '/memorystatus|jetsam/' }), 2);
is('a regular expression with its own i flag, under Match case', await count({ text: '/PIVOT/i', cs: true }), 3);
is('leaving a word out (the jetsam report names Excel as its largest process, so it goes too)', await count({ text: '-excel' }), 4);
is('process:', await count({ text: 'process:excel' }), 10);
is('level: matches the logged level or what it is counted as', await count({ text: 'level:error' }), 4);
is('level:fault does not match Default', await count({ text: 'level:fault' }), 2);
is('pid: in decimal', await count({ text: 'pid:4121' }), 5);
is('pid: in hex', await count({ text: 'pid:0x10d3' }), 2);
is('tag:', await count({ text: 'tag:memory' }), 1);
is('tag: matches part of a tag name', await count({ text: 'tag:excel' }), 5);
is('source: by kind', await count({ text: 'source:autoupdate' }), 2);
is('source: by file path', [await count({ text: 'source:autoupdate.log' }), await count({ text: 'source:unified_logs' })], [2, 6]);
is('source: matches the group name too', await count({ text: 'source:"crash and hang"' }), 4);
is('a field left out, with another kept', await count({ text: '-tag:excel process:excel' }), 6);
is('subsystem: and category:', [await count({ text: 'subsystem:runningboard' }), await count({ text: 'category:window' })], [1, 2]);
is('a time window ends just before its end time', await count({ t0: at(13, 0, 0), t1: at(13, 0, 6) }), 8);
is('a word inside a time window', await count({ text: 'pivot', t0: at(13, 0, 4), t1: at(13, 0, 6) }), 2);
is('only these entries (pins)', await count({ only: [0, 4] }), 2);
is('pins outside the time window are not shown', await count({ only: [0, 4], t0: at(13, 0, 0) }), 1);

const unifiedGroup = info.names.group.indexOf('macOS unified log');
const picked = await ds.query({ bins: 6, facets: { group: { inc: [unifiedGroup] } } }, quiet);
is('choosing one source', picked.count, 6);
is('the other sources still show what choosing them would give',
  Object.fromEntries(picked.facets.group.values.map(([v, n]) => [info.names.group[v], n])),
  { 'macOS unified log': 6, 'Excel diagnostics': 3, 'Crash and hang reports': 4, 'Microsoft AutoUpdate': 2, 'Install history': 1, 'Sleep / wake': 2 });
is('hiding one source', await count({ facets: { group: { exc: [unifiedGroup] } } }), 12);
is('errors and faults by severity', await count({ facets: { sev: { inc: [4, 5] } } }), 6);
const memoryTag = info.names.tag.indexOf('memory'), storageTag = info.names.tag.indexOf('storage');
is('choosing two tags shows entries with either', await count({ facets: { tag: { inc: [memoryTag, storageTag] } } }), 2);
is('a filter and a word together', await count({ text: 'pivot', facets: { group: { inc: [unifiedGroup] } } }), 2);
is('levels as the logs name them', names('lvl', (await ds.query({ bins: 6 }, quiet)).facets.lvl.values.map(([v]) => v)).sort(),
  ['', 'Crash', 'Debug', 'Default', 'Diag', 'Error', 'Fault', 'Force quit', 'Info', 'Jetsam', 'Medium', 'Monitorable', 'Unexpected', 'Warning']);

// ---------- what the engine says about search text that looks like a slip ----------
const said = async (text) => (await ds.query({ bins: 6, text }, quiet)).notes.map((n) => n.text).join(' | ');
has('a misspelt field name is noticed', await said('proces:excel'), 'Did you mean process:excel?');
has('a field with a space after the colon', await said('level: error'), 'for example level:error');
has('a tag that names nothing here', await said('tag:zzz'), 'no tag in this bundle contains "zzz"');
has('and the tags that entries here carry are listed', await said('tag:zzz'), 'The tags here are excel, storage, memory, mentions-excel.');
has('a process that names nothing here', await said('process:zzzz'), 'no process in this bundle contains "zzzz"');
is('that note says which list of names it is about', (await ds.query({ bins: 6, text: 'process:zzzz' }, quiet)).notes[0].field, 'process');
has('pid: with no number', await said('pid:abc'), 'pid: needs a number');
has('a quotation mark never closed', await said('"budget file'), 'is never closed');
has('a regular expression with no closing slash', await said('/pivot'), 'needs a closing slash');
const broken = await ds.query({ bins: 6, text: '/(/' }, quiet);
has('a regular expression that does not compile', broken.notes.map((n) => n.text).join(' '), 'is not a valid regular expression');
has('and the same thing as an error', broken.err, 'Invalid regular expression');
is('an ordinary search gets no note', await said('pivot table'), '');
is('a field that names something gets no note', await said('process:excel level:error'), '');

// ---------- counting without disturbing what is shown ----------
await ds.query({ bins: 6, text: 'pivot' }, quiet);
is('a dry count returns only the number', await ds.query({ dry: true }, quiet), { count: 18 });
is('and leaves the list as it was', (await ds.rows(0, 50)).length, 3);

// ---------- export ----------
await ds.query({ bins: 6 }, quiet);
const tsv = (await (await ds.exportTsv(quiet)).text()).split('\n');
is('export: a header, one line per entry, and a final line end', [tsv.length, tsv[tsv.length - 1]], [20, '']);
is('export header', tsv[0], 'utc_time\tseverity\tlevel\tsource\tprocess\tpid\tsubsystem\tcategory\ttags\tmessage');
is('export keeps the recorded time to the microsecond', tsv[12],
  '2026-03-10 13:00:05.123456\tNotice\tDefault\tunified_logs/2026-03-10.tsv\tMicrosoft Excel\t4307\tcom.apple.AppKit\tWindow\texcel\tpivot table refreshed');
is('export writes a line break and a tab inside a message as \\n and \\t', tsv[7].split('\t').pop(), 'Save failed: No space left on device\\nsecond line\\twith tab');
is('export of chosen entries only', (await (await ds.exportTsv(quiet, [7, 16])).text()).split('\n').map((l) => l.split('\t')[2]), ['level', 'Fault', 'Crash', undefined]);
is('every exported time matches the list', tsv.slice(1, 19).map((l) => l.split('\t')[0]), ORDER.map((r) => r[0]));

// ---------- the same bundle as a zip, part stored and part compressed ----------
const enc = new TextEncoder();
const zip = await makeZip(Object.entries(FILES).map(([path, text], i) => ({ path: TOP + path, bytes: enc.encode(text), packed: i % 2 === 0 })));
const zs = new Core.Dataset(), zinfo = await zs.load([{ path: 'from_a_colleague.zip', blob: zip }], quiet);
is('zip: the bundle is named after its top folder', zinfo.name, TOP.slice(0, -1));
is('zip: same entries', zinfo.total, 18);
await zs.query({ bins: 6 }, quiet);
is('zip: the export is identical to the folder', (await (await zs.exportTsv(quiet)).text()) === tsv.join('\n'), true);
is('zip: a word search reads the unpacked text', (await zs.query({ bins: 6, text: 'pivot' }, quiet)).count, 3);
is('zip: a file can be read back whole', new TextDecoder().decode((await zs.fileChunk(zinfo.files.find((f) => f.path === 'office/autoupdate.log').i, 0, 1 << 20)).bytes), FILES['office/autoupdate.log']);
let zipError = '';
try { await new Core.Dataset().load([{ path: 'broken.zip', blob: new Blob(['this is not a zip']) }], quiet); } catch (e) { zipError = e.message; }
has('a file that is not a zip is refused in words', zipError, 'does not look like a zip file');

// ---------- a zip that is one of the bundle's own files is listed, not opened ----------
const withZip = folder().concat({ path: TOP + 'office/old_logs.zip', blob: new Blob(['not a bundle']), loose: true });
const ls = new Core.Dataset(), linfo = await ls.load(withZip, quiet);
is('loose zip: the bundle around it still loads', linfo.total, 18);
is('loose zip: it is in the file list', linfo.files.some((f) => f.path === 'office/old_logs.zip'), true);

// ---------- unified log lines kept as JSON (a collector without jq) ----------
const ndjson = [
  '{"timestamp":"2026-03-10 09:00:00.000000-0400","messageType":"Error","processImagePath":"/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel","processID":4121,"subsystem":"com.microsoft.office","category":"save","eventMessage":"Save failed","senderImagePath":"/usr/lib/libmso.dylib"}',
  '{"timestamp":"2026-03-10 09:00:01.000000-0400","messageType":"Default","processImagePath":"/kernel","processID":0,"eventMessage":"memorystatus: jetsam for Microsoft Excel","eventType":"logEvent"}',
  '{"count":2,"finished":1}',
].join('\n') + '\n';
const js = new Core.Dataset(), jinfo = await js.load([{ path: 'b/unified_logs/2026-03-10.ndjson', blob: new Blob([ndjson]) }], quiet);
await js.query({ bins: 6 }, quiet);
const jrows = await js.rows(0, 10);
is('JSON lines: the closing summary line is not an entry', jinfo.total, 2);
is('JSON lines: time, level, process, PID', jrows.map((r) => [Core.stamp(r[1], 0), jinfo.names.lvl[r[3]], jinfo.names.proc[r[4]], r[5]]),
  [['2026-03-10 13:00:00', 'Error', 'Microsoft Excel', 4121], ['2026-03-10 13:00:01', 'Default', 'kernel', 0]]);
is('JSON lines: tags are worked out from process and message', jrows.map((r) => jinfo.names.tag.filter((_, b) => (r[8] >> b) & 1).sort().join(',')), ['excel', 'memory,mentions-excel']);
is('JSON lines: the message is shown, not the JSON', jrows[0][9], 'Save failed');
// Why the Mac last shut down is taken only from the kernel: any process can log the same words
const shutdowns = [
  '{"timestamp":"2026-03-10 09:00:00.000000-0400","messageType":"Default","processImagePath":"/kernel","processID":0,"eventMessage":"Previous shutdown cause: 5"}',
  '{"timestamp":"2026-03-10 09:00:01.000000-0400","messageType":"Default","processImagePath":"/usr/bin/logger","processID":4242,"eventMessage":"Previous shutdown cause: 3"}',
  '{"timestamp":"2026-03-10 09:00:02.000000-0400","messageType":"Default","processImagePath":"/opt/made-up/kernel","processID":4243,"eventMessage":"Previous shutdown cause: 0"}',
].join('\n') + '\n';
const sd = new Core.Dataset(), sdinfo = await sd.load([{ path: 'b/unified_logs/2026-03-10.ndjson', blob: new Blob([shutdowns]) }], quiet);
await sd.query({ bins: 6 }, quiet);
is('JSON lines: a shutdown cause is a restart only from the kernel, not from a process that logs the words or is named kernel',
  (await sd.rows(0, 10)).map((r) => sdinfo.names.tag.filter((_, b) => (r[8] >> b) & 1).includes('restart')), [true, false, false]);
// So are the kernel's memory messages, and spindump, ReportCrash and osanalyticshelper by their programs' full paths: a
// program anyone can name like them gets none of their tags
const named = [
  ['/kernel', 0, 'memorystatus: made-up'], ['/opt/made-up/kernel', 4243, 'memorystatus: jetsam swap made-up'],
  ['/usr/sbin/spindump', 71, 'made-up'], ['/opt/made-up/spindump', 4244, 'made-up'],
  ['/System/Library/CoreServices/ReportCrash', 72, 'jetsam made-up'], ['/opt/made-up/ReportCrash', 4245, 'jetsam made-up'],
  ['/System/Library/CoreServices/osanalyticshelper', 73, 'jetsam made-up'], ['/opt/made-up/osanalyticshelper', 4246, 'jetsam made-up'],
].map(([path, pid, msg], i) => JSON.stringify({ timestamp: `2026-03-10 09:00:0${i}.000000-0400`, messageType: 'Default', processImagePath: path, processID: pid, eventMessage: msg })).join('\n') + '\n';
const nm = new Core.Dataset(), nminfo = await nm.load([{ path: 'b/unified_logs/2026-03-10.ndjson', blob: new Blob([named]) }], quiet);
await nm.query({ bins: 6 }, quiet);
is('JSON lines: the memory and hang-report tags go only to the kernel and to the programs at their own paths',
  (await nm.rows(0, 20)).map((r) => nminfo.names.tag.filter((_, b) => (r[8] >> b) & 1).filter((t) => t === 'memory' || t === 'hang-report').join(',')),
  ['memory', '', 'hang-report', '', 'memory', '', 'memory', '']);

// ---------- a clock change inside the logs ----------
const dst = 'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage\n' +
  '2026-03-08 01:59:59.000000-0500\t2026-03-08 06:59:59.000000\tDefault\tkernel\t0\tkernel\t\t\t\tbefore the clocks change\n' +
  '2026-03-08 03:00:01.000000-0400\t2026-03-08 07:00:01.000000\tDefault\tkernel\t0\tkernel\t\t\t\tafter the clocks change\n';
const cinfo = await new Core.Dataset().load([{ path: 'c/unified_logs/2026-03-08.tsv', blob: new Blob([dst]) }], quiet);
is('clock change: both offsets are kept, with when each began', cinfo.zone.map((z) => [Core.stamp(z[0], 0), z[1]]), [['2026-03-08 06:59:59', -300], ['2026-03-08 07:00:01', -240]]);
has('clock change: the bundle says so', cinfo.notes.join(' '), "The Mac's clock changed UTC offset");

// ---------- writing times ----------
is('a time to the millisecond', Core.stamp(at(13, 0, 5) + 123.456), '2026-03-10 13:00:05.123');
is('a time to the second', Core.stamp(at(13, 0, 5) + 999.9, 0), '2026-03-10 13:00:05');
let drift = 0;
for (let i = 0; i < 1000; i++) {                        // every microsecond value read from text is written back unchanged
  const text = `2026-03-10 13:00:05.${String((i * 7919 + 13) % 1000000).padStart(6, '0')}`;
  if (Core.stamp(Core.isoAt(text, 0), 6) !== text) drift++;
}
is('microsecond times that change between reading and writing', drift, 0);
is('rounding up carries into the next second', Core.stamp(at(13, 0, 5) + 999.9999996, 6), '2026-03-10 13:00:06.000000');
is('offsets as the logs write them, in minutes east of UTC', ['-0500', '+05:30', '-05'].map(Core.offStr), [-300, 330, -300]);

// ---------- the built-in sample ----------
const ss = new Core.Dataset(), sinfo = await ss.load(Core.sampleBundle(1), quiet);
is('sample: entries add up across its sources', sinfo.sources.reduce((a, s) => a + s.rows, 0), sinfo.total);
is('sample: entry counts by source kind', Object.fromEntries(sinfo.sources.map((s) => [s.kind, s.rows])), { autoupdate: 40, office: 8943, power: 2, unified: 23874, report: 2 });
is('sample: its two reports', sinfo.reports.map((r) => [Core.stamp(r.t, 0), r.kind]), [['2026-03-10 14:32:30', 'Jetsam'], ['2026-03-10 14:35:00', 'Crash']]);
is('sample: a word search', (await ss.query({ bins: 6, text: 'pivot' }, quiet)).count, 3839);

// ---------- a bundle comes from someone else: files that try to pass for something they are not ----------
const variant = (changes) => Object.entries({ ...FILES, ...changes }).map(([path, text]) => ({ path: TOP + path, blob: typeof text === 'string' ? new Blob([text]) : text }));
const opened = async (inputs) => { const d = new Core.Dataset(); return [d, await d.load(inputs, quiet)]; };
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return [Date.now() - t, r]; };
const HEADER = 'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage\n';

// a zip lying in a folder the collector copied is one of the bundle's files, not the bundle
const inner = await makeZip([{ path: 'Excel_Diagnostics_collect_20200101_000000/manifest.tsv', bytes: enc.encode('component\tstatus\tdetails\n'), packed: false }]);
let [pd, pinfo] = await opened(variant({ 'office/excel_container_logs/old/archive.zip': inner }));
is('a zip among the files is listed, and the bundle is still the bundle', [pinfo.name, pinfo.total, pinfo.files.some((f) => f.path === 'office/excel_container_logs/old/archive.zip')], [TOP.slice(0, -1), 18, true]);
[pd, pinfo] = await opened(variant({ 'a.zip': inner, 'b/c.zip': inner }));
is('two zips among the files are two files', [pinfo.total, pinfo.files.filter((f) => /\.zip$/.test(f.path)).length], [18, 2]);
[pd, pinfo] = await opened([{ path: 'x/from_a_colleague.zip', blob: zip }, { path: 'x/from_a_colleague.zip.sha256', blob: new Blob(['abc  from_a_colleague.zip\n']) }, { path: 'x/.DS_Store', blob: new Blob(['x']) }]);
is('a zip with its checksum beside it is opened', pinfo.total, 18);
let twoZips = '';
try { await opened([{ path: 'a.zip', blob: zip }, { path: 'b.zip', blob: zip }]); } catch (e) { twoZips = e.message; }
has('two zips and nothing else are refused in words', twoZips, 'one bundle at a time');

// in a collector's bundle the place decides what a file may be
const lookalike = HEADER + '2026-03-10 09:00:30.000000+1400\t2026-03-09 19:00:30.000000\tFault\tkernel\t0\tkernel\t\t\tmemory\tPLANTED kernel line\n';
const wakes = '2026-03-10 09:00:40 +1400 Wake                \tPLANTED wake\t\n2026-03-10 09:00:41 +1400 Sleep               \tPLANTED sleep 5 secs\n';
[pd, pinfo] = await opened(variant({ 'office/excel_container_logs/notes.log': lookalike, 'office/discovered/home/Library/Logs/state.log': wakes }));
const kindAt = Object.fromEntries(pinfo.sources.map((s) => [s.path, [s.kind, s.group]]));
is('a file that looks like the macOS log, in a copied folder, is an ordinary log under its own name', kindAt['office/excel_container_logs/notes.log'], ['text', 'Other logs']);
is('so is one that looks like the sleep and wake history', kindAt['office/discovered/home/Library/Logs/state.log'], ['text', 'Other logs']);
is('the collector\'s own files keep their kinds', [kindAt['unified_logs/2026-03-10.tsv'][0], kindAt['system/sleep_wake.txt'][0], kindAt['system/install_history_microsoft.txt'][0]], ['unified', 'power', 'install']);
is('the Mac\'s time zone is not learned from a planted file', [...new Set(pd.zone.map((z) => z[1]))], [-240]);
is('its lines are on the timeline all the same', pinfo.total, 21);
is('its tags column is not believed', (await pd.query({ bins: 6, text: 'PLANTED', facets: { tag: { inc: [pinfo.names.tag.indexOf('memory')] } } }, quiet)).count, 0);
const [, aloneInfo] = await opened([{ path: 'notes.log', blob: new Blob([lookalike]) }]);
is('the same file opened by itself is read for what it looks like', aloneInfo.sources.map((s) => s.kind), ['unified']);

// one odd line does not stop a bundle from opening
[pd, pinfo] = await opened(variant({ 'unified_logs/2026-03-11.ndjson': '{"timestamp":"2026-03-10 09:00:50.000000-0400","processImagePath":5,"eventMessage":{"a":1},"messageType":7,"subsystem":[1],"category":2,"processID":"x","senderImagePath":7}\n' }));
await pd.query({ bins: 6 }, quiet);
const oddRow = (await pd.rows(0, 50)).find((r) => r[9] === '{"a":1}');
is('a line of JSON with numbers and lists where names are expected is read as written', [pinfo.total, oddRow !== undefined], [19, true]);
is('and so are its details', oddRow && (await pd.row(oddRow[0])).extra.Sender, '7');

// one report is one row, whatever its names hold
const forged = '{"app_name":"Microsoft Excel\\n2026-03-10 13:00:00.000\\tCrash\\tkernel\\treports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090100.ips\\tFORGED","timestamp":"2026-03-10 09:01:40.00 -0400","bug_type":"309"}\n{}\n';
[pd, pinfo] = await opened(variant({ 'reports/user_Library_Logs_DiagnosticReports/Forged-2026-03-10-090140.ips': forged }));
is('a report whose process name holds a line break and tabs adds one row, its own', [pinfo.reports.length - info.reports.length, pinfo.total, pinfo.reports.every((r) => r.pos !== undefined)], [1, 19, true]);
is('and that row is tied to the report that made it', pinfo.reports.filter((r) => /Forged/.test(r.path)).map((r) => pd.g.R[r.pos] === pinfo.reports.indexOf(r)), [true]);

// small files made to be slow are not slow
let ms;
[ms] = await timed(async () => (await opened(variant({ 'system/sleep_wake.txt': FILES['system/sleep_wake.txt'] + '2026-03-10 10:00:00 -0400 Sleep               \t' + '9'.repeat(80000) + '\n' })))[0].marks());
is('a Sleep line with a long run of digits: the marks come at once', ms < 2000, true);
[ms] = await timed(async () => (await opened(variant({ 'system/system_info.txt': '\n'.repeat(300000) + 'x'.repeat(100000) + ' up ' + ','.repeat(50000) + '\n' })))[0].facts());
is('a system_info.txt made of line ends: the facts come at once', ms < 2000, true);
[ms] = await timed(async () => opened(variant({ 'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel_2026-03-10-090137_Host.crash': 'Command:  Microsoft' + ' '.repeat(60000) + 'Excel\nDate/Time:  2026-03-10 09:01:37.000 -0400\n' })));
is('a text report with a long run of spaces in its command: the bundle opens at once', ms < 2000, true);
[ms] = await timed(async () => opened(variant({ 'unified_logs/2026-03-12.tsv': HEADER + '1\n'.repeat(1000000) })));
is('a log of a million short lines without tabs: the bundle opens at once', ms < 6000, true);
[pd, pinfo] = await opened(variant({ 'unified_logs/2026-03-10.tsv': HEADER + '2026-03-10 09:00:04.000000-0400\t2026-03-10 13:00:04.000000\tDefault\tMicrosoft Excel\t4121\tAppKit\t\t\texcel\ta' + '\r'.repeat(300000) + 'b\n' }));
await pd.query({ bins: 6 }, quiet);
[ms] = await timed(async () => pd.row((await pd.rows(0, 50)).find((r) => r[4] === pinfo.names.proc.indexOf('Microsoft Excel') && pinfo.names.file[r[2]] === 'unified_logs/2026-03-10.tsv')[0]));
is('an entry holding a long run of carriage returns: its details come at once', ms < 2000, true);

// the export: one entry is one row, and no cell is a formula
[pd, pinfo] = await opened([{ path: 'x.tsv', blob: new Blob([HEADER + '2026-03-10 09:00:04.000000-0400\t2026-03-10 13:00:04.000000\t=level\t=cmd|x\t1\tAppKit\t@sub\t+cat\t\t-[NSApplication run] a\rb\n']) }]);
await pd.query({ bins: 6 }, quiet);
is('a field that a spreadsheet would run gets an apostrophe, and a carriage return is written out',
  (await (await pd.exportTsv(quiet)).text()).split('\n')[1].split('\t').filter((c) => /^'/.test(c) || /\\r/.test(c)),
  ["'=level", "'=cmd|x", "'@sub", "'+cat", "'-[NSApplication run] a\\rb"]);

// ---------- the folder, its zip and the zip's checksum: however they are given, the folder is the bundle ----------
const HANG = 'Excel_Diagnostics_hang_20260310_120000';
const HANG_FILES = {
  'manifest.tsv': 'component\tstatus\tdetails\nunified_last30m\tcomplete\thang capture, 6 entries\n',
  'bundle_info.tsv': 'collector_version\t1.5.0\nmode\thang\ncollected_utc\t2026-03-10 13:10:00\nmacos_version\t15.7\nmodel_name\tMacBook Pro\n',
  'unified_last30m.tsv': UNIFIED,
  'excel_spindump.txt': spin,                              // the collector's own capture, where hang mode writes it
  'excel_container_logs/notes.log': lookalike,            // lying in the folder the collector copied
};
const hangIn = (prefix) => Object.entries(HANG_FILES).map(([path, text]) => ({ path: prefix + path, blob: new Blob([text]) }));
const hangZip = (prefix, more = []) => makeZip(Object.entries(HANG_FILES).map(([path, text]) => ({ path: prefix + path, bytes: enc.encode(text), packed: true })).concat(more));
const hangZipped = await hangZip(HANG + '/'), sum = () => new Blob(['0123abcd  ' + HANG + '.zip\n']);
const asGiven = async (inputs) => {
  const [d, inf] = await opened(inputs);
  return [{ name: inf.name, zone: [...new Set(inf.zone.map((z) => z[1]))], planted: (inf.sources.find((s) => s.path === 'excel_container_logs/notes.log') || {}).kind,
    facts: (await d.facts()).map((f) => f.label), collected: Core.stamp(d.collected, 0), reports: inf.reports.map((r) => [r.kind, r.path]), files: inf.files.length }, inf.notes];
};
const RIGHT = { name: HANG, zone: [-240], planted: 'text', facts: ['Collected', 'Collector mode', 'Collector version', 'Names hidden', 'macOS', 'Mac'], collected: '2026-03-10 13:10:00',
  reports: [['Spindump', 'excel_spindump.txt']], files: Object.keys(HANG_FILES).length };
const BESIDE2 = ['This bundle was read from its folder. 1 .zip file and 1 checksum file that came with it were not opened and are not among the files shown.'];
const BESIDE1 = ['This bundle was read from its folder. 1 .zip file that came with it was not opened and is not among the files shown.'];
const zipFile = (prefix = '') => ({ path: `${prefix}${HANG}.zip`, blob: hangZipped }), sumFile = (prefix = '') => ({ path: `${prefix}${HANG}.zip.sha256`, blob: sum() });
for (const [what, inputs, notes] of [
  ['the folder alone', hangIn(HANG + '/'), []],
  ['the zip alone', [zipFile()], []],
  ['the zip and its checksum', [zipFile(), sumFile()], []],
  ['the zip and its checksum, the checksum named in capitals', [zipFile(), { path: `${HANG}.zip.sha256`.toUpperCase(), blob: sum() }], []],
  ['the folder, the zip and the checksum', [...hangIn(HANG + '/'), zipFile(), sumFile()], BESIDE2],
  ['the zip, the checksum and the folder, in that order', [zipFile(), sumFile(), ...hangIn(HANG + '/')], BESIDE2],
  ['the folder and the zip', [...hangIn(HANG + '/'), zipFile()], BESIDE1],
  ['the folder, the zip and the checksum, their endings in capitals', [...hangIn(HANG + '/'), { path: `${HANG}.ZIP`, blob: hangZipped }, { path: `${HANG}.ZIP.SHA256`, blob: sum() }], BESIDE2],
  ['a folder that holds the three', [...hangIn(`Desktop/${HANG}/`), zipFile('Desktop/'), sumFile('Desktop/'), { path: 'Desktop/.DS_Store', blob: new Blob(['x']) }], BESIDE2],
  // macOS puts an empty .localized in Desktop, Documents and Downloads, and a folder with an icon of its own holds "Icon\r"
  ['a folder that holds the three and macOS\'s .localized', [...hangIn(`Desktop/${HANG}/`), zipFile('Desktop/'), sumFile('Desktop/'), { path: 'Desktop/.localized', blob: new Blob([]) }], BESIDE2],
  ['a folder that holds the three and a folder icon', [...hangIn(`Log files/${HANG}/`), zipFile('Log files/'), sumFile('Log files/'), { path: 'Log files/Icon\r', blob: new Blob([]) }], BESIDE2],
  ['a folder that holds the three, every file marked as one of its own (as a request does)', [...hangIn(`Desktop/${HANG}/`), zipFile('Desktop/'), sumFile('Desktop/')].map((f) => ({ ...f, loose: true })), BESIDE2],
  ['a folder that holds only the bundle folder', hangIn(`Desktop/${HANG}/`), []],
  ['the bundle folder inside a folder of the same name', hangIn(`${HANG}/${HANG}/`), []],
  ['a zip whose top folder holds the bundle folder', [{ path: 'sent.zip', blob: await hangZip(`sent/${HANG}/`) }], []],
  ['a zip made of a folder that holds the three', [{ path: 'sent.zip', blob: await hangZip(`sent/${HANG}/`, [{ path: `sent/${HANG}.zip`, bytes: enc.encode('PK'), packed: false }, { path: `sent/${HANG}.zip.sha256`, bytes: enc.encode('0123abcd\n'), packed: false }]) }], BESIDE2],
  // Finder's Compress, and the collector's own fallback (ditto --sequesterRsrc), add a __MACOSX folder beside the bundle's
  ['a zip with the __MACOSX folder macOS adds', [{ path: `${HANG}.zip`, blob: await hangZip(HANG + '/', [{ path: `__MACOSX/${HANG}/._summary.md`, bytes: enc.encode('x'), packed: false }, { path: `__MACOSX/${HANG}/excel_container_logs/._notes.log`, bytes: enc.encode('x'), packed: false }]) }], []],
  ['a zip whose top folder holds the bundle folder, with the __MACOSX folder macOS adds', [{ path: 'sent.zip', blob: await hangZip(`sent/${HANG}/`, [{ path: `__MACOSX/sent/${HANG}/._summary.md`, bytes: enc.encode('x'), packed: false }]) }], []],
]) {
  const [got, said] = await asGiven(inputs);
  is(`${what}: the bundle is the folder, and place decides in it`, got, RIGHT);
  is(`${what}: what is said about files set aside`, said, notes);
}
// a bundle that has bundle_info.tsv and no manifest.tsv is found the same way
const infoOnly = (prefix) => hangIn(prefix).filter((f) => !f.path.endsWith('/manifest.tsv'));
const [infoAlone] = await asGiven(infoOnly(HANG + '/'));
is('a bundle with bundle_info.tsv and no manifest, its folder alone: the bundle is the folder, and place decides in it', [infoAlone.name, infoAlone.zone, infoAlone.planted, infoAlone.collected], [HANG, [-240], 'text', '2026-03-10 13:10:00']);
for (const [what, inputs] of [
  ['the folder, the zip and the checksum', [...infoOnly(HANG + '/'), zipFile(), sumFile()]],
  ['a folder that holds the three', [...infoOnly(`Desktop/${HANG}/`), zipFile('Desktop/'), sumFile('Desktop/')]],
]) is(`a bundle with bundle_info.tsv and no manifest, given as ${what}: read as its folder alone is`, await asGiven(inputs), [infoAlone, BESIDE2]);
// How far in a bundle's folder is looked for: inside at most six folders that hold nothing else
const nest = (n) => Array.from({ length: n }, (_, i) => `f${i}/`).join('');
let [deep] = await asGiven(hangIn(`${nest(6)}${HANG}/`));
is('a bundle folder inside six folders that hold nothing else is found', [deep.name, deep.zone, deep.planted], [HANG, [-240], 'text']);
[deep] = await asGiven(hangIn(`${nest(7)}${HANG}/`));
is('inside seven it is not looked for, and the files are shown as they were given', [deep.name, deep.files, deep.facts], ['f0', Object.keys(HANG_FILES).length, []]);
// what is not stepped into: a folder with other files beside the bundle folder is shown as the files it holds
let [besideOther] = await asGiven([...hangIn(`Desktop/${HANG}/`), { path: 'Desktop/notes.txt', blob: new Blob(['x']) }]);
is('a folder that holds the bundle folder and some other file is not taken for the bundle', [besideOther.name, besideOther.files], ['Desktop', Object.keys(HANG_FILES).length + 1]);
[besideOther] = await asGiven([...hangIn('a/'), ...hangIn('b/')]);
is('two bundle folders side by side: neither is taken for the bundle', [besideOther.name, besideOther.files], ['Log files', 2 * Object.keys(HANG_FILES).length]);
// a planted folder deeper in cannot become the bundle: the folder with the collector's manifest at its top is found first
[besideOther] = await asGiven([...hangIn(HANG + '/'), ...hangIn(`${HANG}/excel_container_logs/inner/`)]);
is('a folder with a manifest of its own inside a copied folder stays a folder of the bundle', [besideOther.name, besideOther.planted, besideOther.reports], [HANG, 'text', [['Spindump', 'excel_spindump.txt']]]);

// ---------- in a collector's bundle the place decides for reports too ----------
const jetsam = (largest) => `{"bug_type":"298","timestamp":"2026-03-10 09:06:00.00 -0400","os_version":"macOS 15.7 (24G1)"}\n{"largestProcess":"${largest}"}\n`;
[pd, pinfo] = await opened([...hangIn(HANG + '/'),
  { path: `${HANG}/excel_container_logs/excel_spindump.txt`, blob: new Blob([spin.replace('3.50s', '99.00s')]) }, { path: `${HANG}/excel_container_logs/excel_sample.txt`, blob: new Blob([spin]) },
  { path: `${HANG}/excel_container_logs/JetsamEvent-2026-03-10-090600.ips`, blob: new Blob([jetsam('PLANTED largest')]) },
  { path: `${HANG}/excel_container_logs/Kernel-2026-03-10-090700.panic`, blob: new Blob(['{"bug_type":"210","timestamp":"2026-03-10 09:07:00.00 -0400"}\n{}\n']) }]);
is('the collector\'s own spindump, at the top of its bundle, is the one capture listed', pinfo.reports.filter((r) => r.kind === 'Spindump' || r.kind === 'Sample').map((r) => [r.kind, r.proc, r.path, Core.stamp(r.t, 0)]),
  [['Spindump', 'Microsoft Excel', 'excel_spindump.txt', '2026-03-10 13:02:00']]);
is('and it is laid out as a capture', [(await pd.report('excel_spindump.txt')).kind, (await pd.report('excel_spindump.txt')).stack.lines.length], ['Spindump', 2]);
is('files of the capture\'s names in a copied folder are ordinary files', ['excel_container_logs/excel_spindump.txt', 'excel_container_logs/excel_sample.txt'].map((p) => [pd.isReport(p), pinfo.files.some((f) => f.path === p)]), [[false, true], [false, true]]);
is('a jetsam report and a panic report in a copied folder are listed as reports of no particular kind', pinfo.reports.filter((r) => /^excel_container_logs\//.test(r.path)).map((r) => [r.kind, r.path.split('/').pop()]).sort(),
  [['Report', 'JetsamEvent-2026-03-10-090600.ips'], ['Report', 'Kernel-2026-03-10-090700.panic']]);
is('so the marks on the chart do not call them jetsam or panic', (await pd.marks()).marks.filter((m) => m.kind === 'report').map((m) => m.text), ['Spindump report: Microsoft Excel', 'Report: JetsamEvent', 'Report: Kernel']);
is('opened one at a time, they say the same', [(await pd.report('excel_container_logs/JetsamEvent-2026-03-10-090600.ips')).kind, (await pd.report('excel_container_logs/Kernel-2026-03-10-090700.panic')).kind], ['Report', 'Report']);
[pd, pinfo] = await opened(variant({ 'reports/Library_Logs_DiagnosticReports_Retired/JetsamEvent-2026-03-10-090600.ips': jetsam('Microsoft Excel'), 'reports/user_Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090601.ips': jetsam('PLANTED'),
  'office/excel_container_logs/JetsamEvent-2026-03-10-090602.ips': jetsam('PLANTED'), 'reports/Library_Logs_DiagnosticReports/deeper/JetsamEvent-2026-03-10-090603.ips': jetsam('PLANTED'),
  'office/discovered/home/Library/Logs/Microsoft/Microsoft Excel-2026-03-10-090604.ips': head309 + '{}\n', 'office/excel_container_logs/excel_spindump.txt': spin,
  // the names of the collector's report folders, inside a copied folder, are only names
  'office/excel_container_logs/reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-090605.ips': jetsam('PLANTED'),
  'office/excel_container_logs/reports/Library_Logs_DiagnosticReports/Kernel-2026-03-10-090606.panic': '{"bug_type":"210","timestamp":"2026-03-10 09:06:06.00 -0400"}\n{}\n',
  'reports/Library_Logs_DiagnosticReports/Kernel-2026-03-10-090607.panic': '{"bug_type":"210","timestamp":"2026-03-10 09:06:07.00 -0400"}\n{}\n' }));
is('jetsam reports keep their kind only where the collector puts the system\'s own reports', Object.fromEntries(pinfo.reports.filter((r) => /JetsamEvent/.test(r.path)).map((r) => [r.path.replace(/JetsamEvent.*/, ''), r.kind])),
  { 'office/excel_container_logs/': 'Report', 'office/excel_container_logs/reports/Library_Logs_DiagnosticReports/': 'Report', 'reports/Library_Logs_DiagnosticReports/': 'Jetsam',
    'reports/Library_Logs_DiagnosticReports/deeper/': 'Report', 'reports/Library_Logs_DiagnosticReports_Retired/': 'Jetsam', 'reports/user_Library_Logs_DiagnosticReports/': 'Report' });
is('and so do panic reports', Object.fromEntries(pinfo.reports.filter((r) => /\.panic$/.test(r.path)).map((r) => [r.path.replace(/Kernel.*/, ''), r.kind])),
  { 'office/excel_container_logs/reports/Library_Logs_DiagnosticReports/': 'Report', 'reports/Library_Logs_DiagnosticReports/': 'Panic' });
is('a crash report the collector found elsewhere on the Mac is still a crash report', pinfo.reports.filter((r) => /^office\/discovered\//.test(r.path)).map((r) => r.kind), ['Crash']);
is('and a file named like the capture is not a report in a bundle that has none', pinfo.reports.some((r) => /spindump/.test(r.path)), false);
const [, looseJet] = await opened([{ path: 'JetsamEvent-2026-03-10-090600.ips', blob: new Blob([jetsam('Microsoft Excel')]) }]);
is('the same jetsam report opened by itself is read for what it says it is', looseJet.reports.map((r) => r.kind), ['Jetsam']);

// ---------- more places, and other ways in ----------
[pd, pinfo] = await opened(variant({ 'office/excel_container_logs/install.log': '2026-03-10 09:00:42+14 mac installd[1]: PLANTED install\n', 'office/excel_container_logs/unified_logs/2026-03-10.tsv': lookalike }));
const kindAt2 = Object.fromEntries(pinfo.sources.map((s) => [s.path, s.kind]));
is('a file that looks like the install history, in a copied folder, is an ordinary log', kindAt2['office/excel_container_logs/install.log'], 'text');
is('so is a macOS log look-alike in a folder named unified_logs inside a copied folder', kindAt2['office/excel_container_logs/unified_logs/2026-03-10.tsv'], 'text');
is('neither teaches the time zone, and the install marks are the collector\'s own', [[...new Set(pd.zone.map((z) => z[1]))], (await pd.marks()).marks.filter((m) => m.kind === 'install').length], [[-240], 1]);
[pd, pinfo] = await opened(Object.entries({ ...FILES, 'bundle_info.tsv': 'collector_version\t1.5.0\nmode\tcollect\n', 'office/excel_container_logs/notes.log': lookalike }).filter(([path]) => path !== 'manifest.tsv').map(([path, text]) => ({ path: TOP + path, blob: new Blob([text]) })));
is('a bundle with bundle_info.tsv and no manifest is a collector\'s bundle all the same', [pinfo.sources.find((s) => s.path === 'office/excel_container_logs/notes.log').kind, [...new Set(pd.zone.map((z) => z[1]))]], ['text', [-240]]);

// one report is one row, whatever its header or its own path holds
const forgedRow = '\\n2026-03-10 13:00:00.000\\tCrash\\tkernel\\treports/x.ips\\tFORGED';
[pd, pinfo] = await opened(variant({ 'reports/user_Library_Logs_DiagnosticReports/Tool-2026-03-10-090141.ips': `{"app_name":"Tool","timestamp":"2026-03-10 09:01:41.00 -0400","bug_type":"309","os_version":"macOS 15${forgedRow}"}\n{}\n`,
  ['reports/user_Library_Logs_DiagnosticReports/Odd' + forgedRow.replace(/\\n/g, '\n').replace(/\\t/g, '\t') + '-2026-03-10-090142.ips']: '{"app_name":"Tool","timestamp":"2026-03-10 09:01:42.00 -0400","bug_type":"309"}\n{}\n' }));
await pd.query({ bins: 6 }, quiet);
is('a report whose macOS version, or whose own path, holds a line break and tabs adds one row each', [pinfo.reports.length - info.reports.length, pinfo.total, pinfo.reports.every((r) => r.pos !== undefined)], [2, 20, true]);
is('and no row is made from what follows the line break', (await pd.rows(0, 50)).filter((r) => pinfo.names.proc[r[4]] === 'kernel' && pinfo.names.lvl[r[3]] === 'Crash').length, 0);

// a header line of a text report gives a value only when the value is on that line
const emptyKey = await shape('Microsoft Excel_2026-03-10-090138_Host.crash', 'Process:               Microsoft Excel [4121]\nEvent:\nDuration:              3.50s\nDate/Time:             2026-03-10 09:01:38.000 -0400\n');
is('a header line with nothing after its colon has no value: the next line is not taken for it', [emptyKey.rep.facts.find((f) => f[0] === 'Event'), emptyKey.rep.facts.find((f) => f[0] === 'Duration')], [undefined, ['Duration', '3.50s']]);

// more small files made to be slow
[pd] = await opened(variant({ 'system/system_info.txt': ' up , 1'.repeat(18500) + '\n' }));
[ms] = await timed(async () => pd.facts());
is('a system_info.txt that is one long line of "up , 1": the facts come at once', ms < 1000, true);
const longSleep = '2026-03-10 10:00:00 -0400 Sleep               \t';
[pd] = await opened(variant({ 'system/sleep_wake.txt': FILES['system/sleep_wake.txt'] + (longSleep + '9'.repeat(399 - longSleep.length) + '\n').repeat(20000) }));
[ms] = await timed(async () => pd.marks());
is('eight megabytes of Sleep lines just under the length that is read: the marks come at once', ms < 1500, true);
[pd] = await opened(variant({ 'system/sleep_wake.txt': FILES['system/sleep_wake.txt'] + longSleep + 'x'.repeat(1000) + ' 5 secs\n' + longSleep.replace('10:00', '11:00') + 'an ordinary line 7 secs   \n' }));
is('a Sleep line far longer than any real one is not read for a length; one of ordinary length is, with spaces after it', (await pd.marks()).asleep.map(([a, b]) => [Core.stamp(a, 0), (b - a) / 1000]), [['2026-03-10 15:00:00', 7]]);

// ---------- very many small logs ----------
// A copied folder can hold any number of files. Each of these has one line, and their times are shuffled, so that
// every row of the merged timeline comes from a different file than the one before it.
const MANY = 66000, many = variant({});
for (let i = 0; i < MANY; i++) {
  const sec = (i * 7919) % 3600;
  many.push({ path: `${TOP}office/excel_container_logs/n${String(i).padStart(6, '0')}.log`, blob: new Blob([`2026-03-10 0${8 + Math.floor(sec / 1800)}:${String(Math.floor(sec / 60) % 30).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')} planted ${i}\n`]) });
}
let roomAhead = -1;
const manySet = new Core.Dataset();
const [manyMs, manyInfo] = await timed(async () => manySet.load(many, (p) => { if (p.phase === 'Indexing' && roomAhead < 0) roomAhead = manySet.sources[manySet.sources.length - 1].off.length; }));
is(`${MANY} one-line logs beside the collector's own: every line is on the timeline`, manyInfo.total, 18 + MANY);
is('and they open in seconds, not minutes', manyMs < 30000, true);
is('no room for rows is set aside for a file before it is read', roomAhead, 0);
const lastSource = manyInfo.sources.find((s) => s.path === 'unified_logs/2026-03-10.tsv');
is('the macOS log is a file numbered past 65,535 here', lastSource.id > 65535, true);
const fromUnified = await manySet.query({ bins: 6, text: 'source:unified_logs' }, quiet);
is('its entries are still found under its own name', fromUnified.count, 6);
is('and are shown with its name, its group and their own text', (await manySet.rows(0, 10)).map((r) => [manyInfo.names.file[r[2]], manyInfo.sources[r[2]].group, r[9].slice(0, 12)]).slice(0, 2),
  [['unified_logs/2026-03-10.tsv', 'macOS unified log', 'Opened Budge'], ['unified_logs/2026-03-10.tsv', 'macOS unified log', 'Save failed:']]);
is('the count beside each group is its own', Object.fromEntries((await manySet.query({ bins: 6 }, quiet)).facets.group.values.map(([v, n]) => [manyInfo.names.group[v], n]))['macOS unified log'], 6);
// Excel-format logs in each app folder of the copied Diagnostics folder are a group of their own, so a copied folder
// can give more groups than sixteen bits count. Every entry is still counted, and found, under its own group.
{
  const FOLDERS = 66000, groupsIn = variant({});
  for (let i = 0; i < FOLDERS; i++) {
    const sec = (i * 7919) % 3600, two = (n) => String(n).padStart(2, '0');
    groupsIn.push({ path: `${TOP}office/excel_container_logs/Diagnostics/g${String(i).padStart(6, '0')}/a.log`,
      blob: new Blob([`03/10/2026 12:${two(Math.floor(sec / 60))}:${two(sec % 60)}.000\tEXCEL (0x1)\t0x1\tMicrosoft Excel\tPlanted\tp1\tMedium\tplanted ${i}\t\r\n`]) });
  }
  const groupSet = new Core.Dataset();
  const [groupMs, groupInfo] = await timed(async () => groupSet.load(groupsIn, quiet));
  const G = groupInfo.names.group, inGroup = async (name) => (await groupSet.query({ bins: 6, facets: { group: { inc: [G.indexOf(name)] } } }, quiet)).count;
  is(`${FOLDERS} app folders of Excel-format logs: one group each, beside the bundle's own six`, [G.length, groupInfo.total], [FOLDERS + 6, 18 + FOLDERS]);
  is('and they open in seconds', groupMs < 12000, true);
  const own = ['macOS unified log', 'Excel diagnostics', 'Crash and hang reports', 'Microsoft AutoUpdate', 'Install history', 'Sleep / wake'];
  const picked = [];
  for (const g of [...own, 'G065999 diagnostics']) picked.push(await inGroup(g));
  is('picking a group shows its own entries: each of the bundle\'s own groups, and the last planted folder', picked, [6, 3, 4, 2, 1, 2, 1]);
  is('the last planted folder\'s one entry is its own', (await groupSet.rows(0, 5)).map((r) => [groupInfo.names.file[r[2]], r[9]]), [['office/excel_container_logs/Diagnostics/g065999/a.log', 'planted 65999']]);
  const counted = Object.fromEntries((await groupSet.query({ bins: 6 }, quiet)).facets.group.values.map(([v, n]) => [G[v], n]));
  is('the count beside the first groups listed is their own', [counted['macOS unified log'], counted['Excel diagnostics'], counted['G000000 diagnostics']], [6, 3, 1]);
}
// the order of the merged timeline: by time, and among entries of the same time by file, then as each file has them
const tie = (lines) => lines.map((l) => `2026-03-10 09:00:0${l[0]} ${l.slice(1)}\n`).join('');
const [td, tinfo] = await opened([{ path: 't/b.log', blob: new Blob([tie(['1b1', '1b2', '3b3'])]) }, { path: 't/a.log', blob: new Blob([tie(['1a1', '2a2', '3a3'])]) }, { path: 't/c.log', blob: new Blob([tie(['0c0', '3c3', '1c-late'])]) }]);
await td.query({ bins: 6 }, quiet);
is('entries of the same second come in the order of their files, and a file\'s own late line is put in its place', (await td.rows(0, 20)).map((r) => r[9]), ['c0', 'a1', 'b1', 'b2', 'c-late', 'a2', 'a3', 'b3', 'c3']);

// ---------- one odd line does not stop a bundle from opening, whichever field is odd ----------
[pd, pinfo] = await opened(variant({ 'unified_logs/2026-03-11.ndjson': '{"timestamp":"2026-03-10 09:00:51.000000-0400","eventMessage":"odd pid","processID":{"valueOf":1,"toString":1}}\n{"timestamp":"2026-03-10 09:00:52.000000-0400","eventMessage":"pid as text","processID":"4121"}\n' }));
await pd.query({ bins: 6, text: 'source:2026-03-11' }, quiet);
is('a process ID that is not a number is read as written, or as none', [pinfo.total, (await pd.rows(0, 5)).map((r) => [r[9], r[5]]), pinfo.notes], [20, [['odd pid', 0], ['pid as text', 4121]], []]);
[pd, pinfo] = await opened(variant({ 'unified_logs/2026-03-11.ndjson': '{"timestamp":"2026-03-10 09:00:53.000000-0400","eventMessage":' + '['.repeat(30000) + ']'.repeat(30000) + '}\n' }));
is('a line nested deeper than can be written back out is shown, or left out and counted', pinfo.total + (pinfo.notes.some((n) => /^1 line in this bundle's logs could not be read/.test(n)) ? 1 : 0), 19);
// Whatever a parser trips on in a line, that line is left out and counted. No such field is known today, so one is made here.
const tripped = new Core.Dataset(), procId = tripped.dict.proc.id;
tripped.dict.proc.id = function (name) { if (name === 'TRIPS') throw new Error('made up'); return procId.call(this, name); };
const trippedInfo = await tripped.load(variant({ 'unified_logs/2026-03-10.tsv': UNIFIED + UNIFIED.split('\n').slice(1, 3).join('\n').replace(/Microsoft Excel\t4121/g, 'TRIPS\t1') + '\n' }), quiet);
is('lines a parser cannot get through are left out, the rest of the file is read', [trippedInfo.total, trippedInfo.sources.find((s) => s.kind === 'unified').rows], [18, 6]);
is('and the bundle says how many, naming no file', trippedInfo.notes, ["2 lines in this bundle's logs could not be read as entries and are not on the timeline."]);
// Running out of room for rows is not a line that could not be read: it stops the load, as it always did. Here the
// second time this one file's rows need more room (900 of them), there is none.
const RealFloat64Array = globalThis.Float64Array;
let noRoom = '';
globalThis.Float64Array = class extends RealFloat64Array { constructor(...args) { if (args[0] === 900) throw new RangeError('made up: no room'); super(...args); } };
try { await new Core.Dataset().load([{ path: 'big.log', blob: new Blob(['2026-03-10 09:00:00 a line of this made-up log\n'.repeat(1914)]) }], quiet); noRoom = 'the load went on'; } catch (e) { noRoom = e.message; } finally { globalThis.Float64Array = RealFloat64Array; }
is('no room left for more rows stops the load and is said as that', noRoom, 'made up: no room');

// ---------- the export, read back the way a spreadsheet reads it ----------
// A cell that begins with a quotation mark is read on to the mark that closes it, across tabs and line ends.
function readBack(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, fresh = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c !== '"') cell += c; else if (text[i + 1] === '"') { cell += c; i++; } else quoted = false; continue; }
    if (fresh && c === '"') { quoted = true; fresh = false; continue; }
    fresh = false;
    if (c === '\t' || c === '\n') { row.push(cell); cell = ''; fresh = true; if (c === '\n') { rows.push(row); row = []; } } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const entry = (sec, proc, msg) => `2026-03-10 09:00:0${sec}.000000-0400\t2026-03-10 13:00:0${sec}.000000\tDefault\t${proc}\t1\tAppKit\t\t\t\t${msg}\n`;
[pd, pinfo] = await opened([{ path: 'q.tsv', blob: new Blob([HEADER + entry(1, 'Microsoft Excel', '"opens a quotation') + entry(2, '"quoted', 'second') + entry(3, 'kernel', 'third') + entry(4, 'kernel', 'closes it" and goes on') + entry(5, 'kernel', 'fifth')]) }]);
await pd.query({ bins: 6 }, quiet);
const backRows = readBack(await (await pd.exportTsv(quiet)).text());
is('an export with a message and a process that begin with a quotation mark reads back as one row for each entry', [backRows.length, backRows.every((r) => r.length === 10)], [6, true]);
is('and those two cells are written with an apostrophe in front', [backRows[1][9], backRows[2][4]], ["'\"opens a quotation", "'\"quoted"]);
is('the reader used here does read a quoted cell across line ends', readBack('a\t"b\nc"\td\ne\n'), [['a', 'b\nc', 'd'], ['e']]);

// ---------- how many members a zip may list ----------
// The command-line tool gives readZip the number of members it will take; a zip that lists more is refused there,
// before an object is made for each of what can be millions of tiny records.
{
  const four = await makeZip(['a.log', 'b.log', 'c/', 'c/d.log'].map((p) => ({ path: p, bytes: new TextEncoder().encode(p.endsWith('/') ? '' : 'x\n') })));
  is('a zip is read whole when no number is given', (await Core.readZip(four)).map((e) => e.path), ['a.log', 'b.log', 'c/d.log']);
  is('and when the number given is as many as it lists, folders counted', (await Core.readZip(four, 4)).length, 3);
  let why = '';
  try { await Core.readZip(four, 3); } catch (err) { why = `${err.tooMany === true}: ${err.message}`; }
  is('one more than that, and it is refused, with a mark that a damaged zip does not carry', why, 'true: This zip lists more than 3 members.');
}
// A zip whose last record says it has more extra field than it holds: reading it fails, and that failure must not
// pass for the member limit (the command-line tool would call a damaged zip of a few hundred bytes too large)
{
  const bytes = new Uint8Array(await (await makeZip(['a.log', 'b.log'].map((p) => ({ path: p, bytes: new TextEncoder().encode('x\n') })))).arrayBuffer());
  const dv = new DataView(bytes.buffer);
  let last = -1;
  for (let i = 0; i + 4 <= bytes.length; i++) if (dv.getUint32(i, true) === 0x02014b50) last = i;
  dv.setUint16(last + 30, 8, true);
  let err = null;
  try { await Core.readZip(new Blob([bytes]), 1000); } catch (e) { err = e; }
  is('a damaged zip is refused as damaged, without the mark of the member limit', [!!err, !!(err && err.tooMany)], [true, false]);
}
// Sizes a zip only claims: two thousand one-line logs, each said to unpack to 4 GB. Room for rows was once sized
// from that claim, which held the page's worker for half a minute on a zip of a few hundred kilobytes.
{
  const files = Array.from({ length: 2000 }, (_, i) => ({ path: `Excel_Diagnostics_hang_20260310_120000/logs/l${i}.log`, bytes: new TextEncoder().encode(`2026-03-10 09:00:${String(i % 60).padStart(2, '0')} error line ${i}\n`) }));
  const bytes = new Uint8Array(await (await makeZip(files)).arrayBuffer());
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i + 46 <= bytes.length; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 0xFFFFFFFE, true);
  const t0 = performance.now();
  const lying = new Core.Dataset(), linfo = await lying.load([{ path: 'lying.zip', blob: new Blob([bytes]) }], quiet);
  const took = performance.now() - t0;
  is('a zip whose members claim 4 GB each opens without sizing room from the claim', [linfo.total, took < 5000 ? 'in time' : `${Math.round(took)} ms`], [2000, 'in time']);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) (typeof Deno !== 'undefined' ? Deno.exit : process.exit)(1);

