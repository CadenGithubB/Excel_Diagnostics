// The text command line is not part of this plugin, but request mode is built from its helpers, so a change made
// for request mode can change what a person at a terminal sees. These specs hold a few commands to the exact text
// they printed before request mode existed: the table of entries, the notes, the recount when nothing matches,
// the Next lists. They also pin the two things request mode added to the text side: one line of help, and that
// "request" never prints the text commands' output.
//
// It matters to the model only indirectly, and that is the point: its tools must not be improved by quietly
// breaking the tool people use by hand.
import { describe, it, assert, cli, request, cleanup } from '../harness.mjs';

// The commands a Next list offers begin with how this tool was started, which differs between Node and Deno and
// with the folder the tests run from. Everything else is compared character for character.
const normal = (s) => s.replace(/(?:node|deno run -A) (?:'[^']*excel_diagnostics_cli\.mjs'|\S*excel_diagnostics_cli\.mjs)/g, 'CLI');

const EXPECTED = [
  { title: 'search prints matching entries as a table, then a Next list',
    args: ['sample', 'search', '--min-severity', 'error', '--limit', '5'],
    stdout: [
      'Search: every entry',
      'Severity: Error and above',
      '1,060 of 32,861 entries match. Showing 1 to 5, oldest first. Times are in the logged Mac\'s time zone, UTC-04:00 (add --utc for UTC).',
      '',
      '  ID  TIME                     LEVEL       SOURCE   PROCESS[PID]           MESSAGE',
      ' 139  2026-03-10 09:00:50.400  Unexpected  excel    Microsoft Excel[4121]  TelemetryEvent::Log {"Activity":"Paint","Result":"Failed","Value":434}',
      ' 311  2026-03-10 09:01:52.956  Error       unified  Microsoft Excel[4121]  CTFontManagerRegisterFontsForURL failed for font Calibri.ttf: already registered',
      ' 346  2026-03-10 09:02:06.000  Unexpected  excel    Microsoft Excel[4121]  TelemetryEvent::Log {"Activity":"Paint","Result":"Failed","Value":440}',
      '1186  2026-03-10 09:07:11.593  Error       unified  Microsoft Excel[4121]  CTFontManagerRegisterFontsForURL failed for font Calibri.ttf: already registered',
      '1813  2026-03-10 09:10:58.805  Error       unified  Microsoft Excel[4121]  CTFontManagerRegisterFontsForURL failed for font Aptos.ttf: already registered',
      '',
      'Next:',
      '  The next 5 of the 1,055 not shown:  CLI sample search --min-severity error --limit 5 --offset 5',
      '  The newest matches instead:         CLI sample search --min-severity error --limit 5 --last',
      '  One entry in full:                  CLI sample show 139',
      '  What was logged around it:          CLI sample context 139',
      '  Which processes these are from:     CLI sample count --min-severity error --by process',
      '  When they were logged:              CLI sample histogram --min-severity error',
      '  All 1,060 to a file:                CLI sample export --min-severity error --out matches.tsv',
      '',
    ].join('\n') },
  { title: 'a search that matches nothing says which condition ruled the entries out',
    args: ['sample', 'search', 'proces:excel', 'pivot', '--from', '2026-03-10', '09:00', '--to', '2026-03-10', '09:01'],
    stdout: [
      'Search: proces:excel pivot',
      'Time window: from 2026-03-10 09:00:00.000 to 2026-03-10 09:01:00.000',
      '0 of 32,861 entries match.',
      'Note: "proces:" is not a field, so "proces:excel" was searched for as plain text. Did you mean process:excel? The fields are process:, level:, pid:, subsystem:, category:, tag: and source:',
      'How many entries match when one condition is taken away and the rest are kept:',
      '  without the time window (from 2026-03-10 09:00:00.000 to 2026-03-10 09:01:00.000): 0',
      '  without the search term proces:excel: 13',
      '  without the search term pivot: 0',
      '',
      'Next:',
      '  See what the bundle holds:  CLI sample summary',
      '  How searching works:        CLI sample help search',
      '',
    ].join('\n') },
  { title: 'count --by lists values with their share',
    args: ['sample', 'count', '--by', 'level', '--min-severity', 'warning'],
    stdout: [
      'Search: every entry',
      'Severity: Warning and above',
      '1,295 of 32,861 entries match.',
      '',
      'By level (the logs\' own level names):',
      '        1,019   78.7%  Error',
      '          232   17.9%  Monitorable',
      '           38    2.9%  Unexpected',
      '            3    0.2%  Warning',
      '            1    0.1%  Fault',
      '            1    0.1%  Jetsam',
      '            1    0.1%  Crash',
      '',
      'Next:',
      '  The entries behind one line:  CLI sample search level:Error --min-severity warning',
      '',
    ].join('\n') },
  { title: 'histogram prints an interval per line, with bars',
    args: ['sample', 'histogram', 'tag:memory', '--bins', '12'],
    stdout: [
      'Search: tag:memory',
      '2,856 of 32,861 entries match.',
      '12 intervals of 15 min each, from 2026-03-10 09:00:01 to 2026-03-10 11:59:51. Times are in the logged Mac\'s time zone, UTC-04:00 (add --utc for UTC).',
      'ERRORS counts errors and faults.',
      '',
      'INTERVAL STARTS        ENTRIES    ERRORS  WARNINGS',
      '2026-03-10 09:00:01        240         0         0  ##################',
      '2026-03-10 09:15:00        185         0         0  ##############',
      '2026-03-10 09:30:00        182         0         0  ##############',
      '2026-03-10 09:44:59        207         0         0  ################',
      '2026-03-10 09:59:58        230         0         0  ##################',
      '2026-03-10 10:14:57        241         0         0  ##################',
      '2026-03-10 10:29:56        522         0         0  ########################################',
      '2026-03-10 10:44:55        198         0         0  ###############',
      '2026-03-10 10:59:54        228         0         0  #################',
      '2026-03-10 11:14:53        214         0         0  ################',
      '2026-03-10 11:29:52        192         0         0  ###############',
      '2026-03-10 11:44:51        217         0         0  #################',
      '',
      'Next:',
      '  The entries in the fullest interval:  CLI sample search tag:memory --from \'2026-03-10 10:29:56\' --to \'2026-03-10 10:44:55\'',
      '  Finer intervals over that stretch:    CLI sample histogram tag:memory --from \'2026-03-10 10:29:56\' --to \'2026-03-10 10:44:55\'',
      '',
    ].join('\n') },
  { title: 'context marks the entry it was asked about',
    args: ['sample', 'context', '139', '--before', '3', '--after', '3'],
    stdout: [
      'Entries 136 to 142: everything logged around entry 139, from every source, with no filter. Entry 139 is marked with >.',
      'Times are in the logged Mac\'s time zone, UTC-04:00 (add --utc for UTC).',
      '',
      '  ID  TIME                     LEVEL       SOURCE   PROCESS[PID]            MESSAGE',
      ' 136  2026-03-10 09:00:49.200  Medium      excel    Microsoft Excel[4121]   TelemetryEvent::Log {"Activity":"Paint","Result":"Ok","Value":213}',
      ' 137  2026-03-10 09:00:49.547  Default     unified  filecoordinationd[388]  Claim 3e47d6d granted in server for Microsoft Excel: Regional Sales Pivot.xlsx',
      ' 138  2026-03-10 09:00:49.966  Info        unified  UserEventAgent[101]     Captured event for com.microsoft.Excel: appIsActive=true',
      '>139  2026-03-10 09:00:50.400  Unexpected  excel    Microsoft Excel[4121]   TelemetryEvent::Log {"Activity":"Paint","Result":"Failed","Value":434}',
      ' 140  2026-03-10 09:00:50.448  Info        unified  UserEventAgent[101]     Captured event for com.microsoft.Excel: appIsActive=true',
      ' 141  2026-03-10 09:00:50.852  Debug       unified  Microsoft Excel[4121]   found no value for key NSWindowTabbingShoudShowTabBarKey in CFPrefsSource',
      ' 142  2026-03-10 09:00:51.346  Default     unified  filecoordinationd[388]  Claim 245448e granted in server for Microsoft Excel: Headcount Plan.xlsx',
      '',
      'Next:',
      '  More either side:             CLI sample context 139 --before 12 --after 12',
      '  By time instead of by count:  CLI sample context 139 --window 30s',
      '  Only some of what is around:  CLI sample search WORDS --around 139 --window 1m   (WORDS can be process:NAME, level:error and so on)',
      '  One entry in full:            CLI sample show 139',
      '',
    ].join('\n') },
  { title: 'reports lists the report files',
    args: ['sample', 'reports'],
    stdout: [
      '2 reports in this bundle, oldest first. Times are in the logged Mac\'s time zone, UTC-04:00 (add --utc for UTC).',
      'Each is one file that macOS or Excel wrote when the thing happened; KIND is taken from the file.',
      '',
      'TIME                 KIND    PROCESS          FILE',
      '2026-03-10 10:32:30  Jetsam  JetsamEvent      reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-103230.ips',
      '2026-03-10 10:35:00  Crash   Microsoft Excel  reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips',
      '',
      'Next (shown for the newest report):',
      '  Read the report:                     CLI sample cat \'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips\'',
      '  What the logs say around that time:  CLI sample context \'2026-03-10 10:35:00\' --window 1m',
      '  Errors in the five minutes before:   CLI sample search --min-severity error --from \'2026-03-10 10:30:00\' --to \'2026-03-10 10:35:01\'',
      '',
    ].join('\n') },
  { title: 'cat prints lines of a file',
    args: ['sample', 'cat', 'summary.md', '--lines', '1-5'],
    stdout: [
      'File: summary.md (935 B)',
      'Lines 1 to 5 of 23:',
      '',
      '# Excel diagnostics summary',
      '',
      'This is made-up sample data that ships with the viewer. It tells one story: Excel\'s memory climbs for an hour and a half, a PivotTable filter pushes it over the limit, and Excel crashes at 2026-03-10 10:35:00 local time and is relaunched.',
      '',
      '- Collected: 2026-03-10 12:03:40 EDT',
      '',
      'Next:',
      '  The next lines:              CLI sample cat summary.md --lines 6-23',
      '  Only lines containing text:  CLI sample cat summary.md --grep TEXT',
      '',
    ].join('\n') },
  { title: 'memory prints the figures of the memory timeline',
    args: ['sample', 'memory'],
    stdout: [
      'What this bundle recorded about memory. The figures are as the collector and macOS wrote them; nothing here is interpreted.',
      '',
      'Samples over time, one row per sample (watch and repro modes):',
      '     27.5 KB  excel_memory_timeline.csv',
      '',
      'Snapshots of system memory and the processes using the most:',
      '      1.2 KB  system/memory.txt',
      '',
      'Excel\'s memory at collection time, and its breakdown by kind:',
      '      1.2 KB  office/excel_footprint.txt',
      '',
      'JetsamEvent reports, which macOS writes when it ends processes to free memory:',
      '      1.8 KB  reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-103230.ips',
      '',
      'excel_memory_timeline.csv: 360 samples, from 2026-03-10 09:00:00 to 2026-03-10 11:59:30 (the Mac\'s local time, as written in the file)',
      '  excel_footprint_mb: lowest 644 MB at 2026-03-10 10:35:00, highest 6,241 MB at 2026-03-10 10:34:30, last 1,067 MB',
      '  excel_cpu_pct: lowest 0.1% at 2026-03-10 11:50:30, highest 92.3% at 2026-03-10 10:30:30, last 24.2%',
      '  excel_threads: lowest 40 at 2026-03-10 09:09:00, highest 51 at 2026-03-10 09:02:00, last 43',
      '  free_mb: lowest 525 MB at 2026-03-10 10:34:30, highest 5,200 MB at 2026-03-10 09:00:00, last 4,200 MB',
      '  swap_used_mb: lowest 0 MB at 2026-03-10 09:00:00, highest 3,859 MB at 2026-03-10 10:34:30, last 1,200 MB',
      '  pressure_level values seen: 1 (normal), 2 (warning), 4 (critical)',
      '  Excel process IDs seen: 4121, 4307',
      '',
      'Log entries tagged memory (kernel memory-pressure and jetsam messages): 2,856',
      '',
      'Next:',
      '  Print one of those files:     CLI sample cat excel_memory_timeline.csv',
      '  The memory entries:           CLI sample search tag:memory',
      '  When they were logged:        CLI sample histogram tag:memory',
      '  Every report, with its time:  CLI sample reports',
      '',
    ].join('\n') },
];

describe('text command line: unchanged by request mode', () => {
  for (const { title, args, stdout } of EXPECTED) {
    it(`${args.slice(1).join(' ')}: ${title}`, async () => {
      const r = await cli(args);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.equal(normal(r.stdout), stdout);
    });
  }

  it('a command that is not understood still goes to standard error with exit status 2', async () => {
    const r = await cli(['sample', 'show', '99999']);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.equal(normal(r.stderr), [
      'There is no entry 99999. IDs in this bundle run from 0 to 32,860.',
      '',
      'For the list of commands: CLI help',
      '',
    ].join('\n'));
  });

  it('help gained one line, about request mode, and nothing else changed in it', async () => {
    const r = await cli(['help']);
    assert.equal(r.code, 0);
    const lines = normal(r.stdout).split('\n'), added = 'For programs: "CLI request" reads one JSON request from standard input and prints one JSON document in answer.';
    assert.equal(lines.filter((l) => l === added).length, 1);
    assert.deepEqual(lines.filter((l) => l !== added).slice(0, 3), ['Excel diagnostics, command-line tool 1.0', '', 'Searches a bundle made by excel_diagnostics.sh (the collector for Excel slowdowns, hangs and crashes on macOS)']);
    assert.equal(lines.length, 37, 'one line more than before');
    assert.ok(lines.indexOf(added) === lines.findIndex((l) => l.startsWith('Exit status:')) + 1, 'it sits with the other notes for callers');
  });

  it('"request" prints one JSON document and none of the text commands\' output', async () => {
    const r = await request({ format: 1, op: 'summary', allowSample: true, params: { bundle: 'sample' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1, 'one line');
    assert.equal(r.json.ok, true);
    assert.ok(!r.stdout.includes('Next:') && !r.stdout.includes('Bundle: '), 'nothing the text summary prints');
  });

  it('cleanup', async () => { await cleanup(); });
});
