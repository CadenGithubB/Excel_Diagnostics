// ---------- main ----------
async function main(argv) {
  const names = [...Object.keys(COMMANDS), 'clean', 'help'];
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return help('');
  if (argv[0] === '--version') return say(`excel_diagnostics_cli ${VERSION}`);
  if (argv[0] === 'help') return help(argv[1]);
  if (argv[0] === 'clean') return clean();
  bundleArg = argv[0];
  let command = argv[1] === undefined ? 'summary' : argv[1], rest = argv.slice(2);
  if (command.startsWith('--')) {
    if (command === '--help') return help('');
    if (command === '--utc') { rest = argv.slice(1); command = 'summary'; }
    else throw new Usage(`A command comes before the options: ${run(`COMMAND ${command}`)}. Commands: ${names.join(', ')}.`);
  }
  if (command === 'help') return help(rest[0]);
  if (command === 'clean') return clean();
  if (!COMMANDS[command]) {
    const guess = closest(command, names);
    if (names.includes(argv[0])) throw new Usage(`The bundle comes first, then the command: ${RUNTIME} ${shq(SCRIPT)} BUNDLE ${argv[0]} ...  ("${argv[0]}" was read as the bundle and "${command}" as the command.)`);
    throw new Usage(`"${command}" is not a command.${guess ? ` Did you mean "${guess}"?` : ''} Commands: ${names.join(', ')}.\nTo search for words, put "search" before them: ${run(`search ${shq(command)}`)}`);
  }
  if (rest.includes('--help')) return help(command);
  const { o, pos } = parseArgs(command, rest);
  if (names.includes(argv[0]) && !fs.existsSync(argv[0])) throw new Usage(`The bundle comes first, then the command: ${RUNTIME} ${shq(SCRIPT)} BUNDLE ${argv[0]} ...  BUNDLE is the path to the zip or folder, or the word sample.`);
  await open(bundleArg);
  utc = !!o.utc;
  if (!info.total && !['summary', 'files', 'cat', 'reports', 'memory'].includes(command)) {
    say(`"${command}" works on timeline entries, and this bundle has none: no file in it is a log with timestamps this tool recognises.`);
    say(); say('Next:'); say(`  List the files:   ${run('files')}`); say(`  Print one:        ${run('cat PATH')}`);
    return;
  }
  await COMMANDS[command](o, pos);
}

// "request" in the bundle's place is request mode: it answers on standard output with one JSON document and nothing
// else, so none of what follows for the text commands (which print what they said, as text) may run.
if (process.argv[2] === 'request') {
  await answerRequest();
} else {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Usage) {
      say(err.message);
      say(); say(`For the list of commands: ${RUNTIME} ${shq(SCRIPT)} help`);
      process.exitCode = 2;
    } else {
      say(`Could not finish: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  // line the commands of each "Next:" list up under one another
  for (let i = 0; i < lines.length; i++) {
    if (!/^Next( \(.*\))?:$/.test(lines[i])) continue;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) { const m = /^  (.*?):\s{2,}((?:node|deno run -A) .*)$/.exec(lines[j]); if (!m) break; block.push([j, m[1], m[2]]); }
    const w = block.reduce((a, x) => Math.max(a, x[1].length), 0);
    for (const [j, label, command] of block) lines[j] = `  ${(label + ':').padEnd(w + 1)}  ${command}`;
  }
  const text = lines.join('\n') + '\n';
  if (process.exitCode) process.stderr.write(text); else process.stdout.write(text);
}
if (lastFd) fs.closeSync(lastFd.fd);
