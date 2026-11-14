#!/bin/bash
# Checks how `excel_diagnostics.sh` handles files it does not control, without collecting anything from this Mac:
# it takes the functions that copy and list out of the collector and runs them on a made-up home folder that
# holds what a hostile or unlucky user could have put there: links, a pipe, a file with special rights, names with
# line breaks, tabs and a leading "-e".  Run on a Mac:  bash test/collect_test.sh
#
# What it cannot check is the step from root to the console user, because it is never root. It checks the
# things that step rests on: every read of the home folder goes through as_user (when as_user refuses, nothing
# from the home folder reaches the bundle), the program as_user runs refuses anything it should and stops a
# helper that does not finish, a file outside the home folder is only taken when it is opened as itself, and
# the hand-over decides who moves the results by the path as it is written.
#
# COLLECTOR_UNDER_TEST=path tests another copy of the collector. COLLECT_TEST_KEEP=1 keeps the scratch folder.
# Every name below is invented.

SCRIPT=${COLLECTOR_UNDER_TEST:-}
case "$SCRIPT" in '') ;; /*) ;; *) SCRIPT="$PWD/$SCRIPT" ;; esac
cd "$(dirname "$0")/.." || exit 2
[ -n "$SCRIPT" ] || SCRIPT="$PWD/excel_diagnostics.sh"
[ -f "$SCRIPT" ] || { echo "no collector at $SCRIPT"; exit 2; }
WORK=$(mktemp -d -t collect_test) || exit 2
WORK=$(cd "$WORK" && pwd -P)
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
[ -n "$COLLECT_TEST_KEEP" ] && { trap - EXIT; echo "Keeping the made-up folders in $WORK"; }
# From its re-run with sudo on, the collector and every program it runs work in the C locale: the steps taken out
# of it here are run the same way (test/note_test.sh checks that the collector sets it)
LC_ALL=C; export LC_ALL

for f in plain_perl as_user limit_hit rights_spent home_closed list_end most_of found_count first_lines in_home rd fetch copy_dir copy_file excel_verbose_logging verbose_word collect_office discover_sources collect_reports \
         report_facts roots_chain root_only deliver step gave_up finalize earlier_runs shown_path collect_workbook_metadata workbook_facts run_limited write_source_catalog \
         program_read odd_name label_entries log_line step_begin row unwritten put answer_of list_written copy_said count_of odd_count user_list \
         count_entries search_said run_noted snapshot_memory capped stop_groups same_group excel_pids first_excel still_excel excel_said excel_args shown_lines \
         ended_said reports_rule report_tests rights_said drained find_one found_split found_lost repro_stop watch_row rights_check repro_row stopped_rows; do
    body=$(sed -n "/^$f() {/,/^}\$/p" "$SCRIPT")
    [ -n "$body" ] || { echo "could not find $f in $SCRIPT"; exit 2; }
    eval "$body"
done
# The one test for a name that is left out of every list and copy, as the collector holds it
body=$(sed -n "/^ODD_GLOBS=(/,/^ODD_PATH+=(')'); ODD_NAME+=(')')\$/p" "$SCRIPT")
[ -n "$body" ] && [ "$(printf '%s\n' "$body" | wc -l)" -le 30 ] || { echo "could not find the test for names left out in $SCRIPT"; exit 2; }
eval "$body"
[ "${#ODD_GLOBS[@]}" -ge 1 ] && [ "${#ODD_PATH[@]}" -ge 4 ] && [ "${#ODD_NAME[@]}" -ge 4 ] || { echo "could not find the test for names left out in $SCRIPT"; exit 2; }
eval "$(sed -n '/^seen() {.*}$/p' "$SCRIPT")"
type seen > /dev/null 2>&1 || { echo "could not find seen in $SCRIPT"; exit 2; }
for h in REPORT_PL AS_USER_PL FETCH_PL PICK_PL STREAM_PL LIMIT_PL; do
    body=$(sed -n "/^IFS= read -r -d '' $h <<'PERL'\$/,/^PERL\$/p" "$SCRIPT")
    [ -n "$body" ] || { echo "could not find $h in $SCRIPT"; exit 2; }
    eval "$body"
done
# The programs the collector holds in single quotes: each is one assignment, NAME='...', with no single quote inside
for h in LSTAT_PL LIST_SH NAMES_PL REPORTS_SH NUL_COUNT_PL SHUT_PL SHOWN_RULE_PL ROW_ESCAPE_PL; do
    body=$(H=$h /usr/bin/perl -0777 -ne 'print $1 if /^(\Q$ENV{H}\E=\x27[^\x27]*\x27)$/m' "$SCRIPT")
    [ -n "$body" ] || { echo "could not find $h in $SCRIPT"; exit 2; }
    eval "$body"
done
eval "$(sed -n '/^PERL_CMD=(/p' "$SCRIPT")"
[ "${#PERL_CMD[@]}" -ge 2 ] || { echo "could not find PERL_CMD in $SCRIPT"; exit 2; }
# The names of the reports that are taken by name, as the collector holds them (see reports_rule)
eval "$(sed -n '/^REPORT_NAMES=(/p' "$SCRIPT")"; REPORT_FROM=""
[ "${#REPORT_NAMES[@]}" -ge 1 ] || { echo "could not find REPORT_NAMES in $SCRIPT"; exit 2; }
REAL_AS_USER=$(sed -n '/^as_user() {$/,/^}$/p' "$SCRIPT")
REAL_ROOT_ONLY=$(sed -n '/^root_only() {$/,/^}$/p' "$SCRIPT")
say() { echo "$*" >> "$WORK/said.txt"; }
write_summary() { :; }                     # reads the whole bundle and this Mac's facts; not what is tested here
redact_bundle() { :; }
record_status() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$MANIFEST"; }
note() { echo "$*" >> "$LOG"; }
snapshot_excel_memory() { :; }             # asks the running Mac about Excel; not what is tested here

# bounded TEXT MOST LAST - TEXT, a range of lines taken out of the collector to be run here, but only when it is at
# most MOST lines long and its last line matches LAST; nothing otherwise. A range whose end is not found runs on to
# the end of the collector, and run here that would be a run of the collector itself.
bounded() {
    [ "$(printf '%s\n' "$1" | wc -l)" -le "$2" ] && printf '%s\n' "$1" | tail -1 | grep -q -e "$3" && printf '%s\n' "$1"
}

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
is()   { if [ "$2" = "$3" ]; then ok; else bad "$1: expected '$3', got '$2'"; fi; }
count() { grep -r -a -l -F -- "$2" "$1" 2>/dev/null | wc -l | tr -d ' '; }

# ---- a made-up home folder ---------------------------------------------------------------------------------------
AM_ROOT=0; CONSOLE_USER=nobody-here; USER_READS=1
USER_HOME="$WORK/home"
XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"
OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"
UNIFIED_SEARCH_GB=2; MODE=collect; EXCEL_PROC="Microsoft Excel"; EXCEL_NAME=Excel; EXCEL_EXE="/Applications/$EXCEL_PROC.app/Contents/MacOS/$EXCEL_PROC"; LOG_EXT=tsv; MAX_DISCOVERED_MB=250; MAX_DISCOVERED_FILES=100000; MAX_SEARCH_ROOTS=500; ARCHIVE=0; WORKBOOK=""
step_begin; HOME_SHUT=0; ROWS_LOST=0; WRITES_LOST=0; ODD_SEEN=0; ODD_UNKNOWN=""
MAX_COPY_FILE_MB=1024; MAX_COPY_FOLDER_MB=4096; MAX_COPY_FOLDER_ENTRIES=50000; COPY_SECONDS=60
COPY_LOST=0; COPY_ODD=0; COPY_BIG=0; COPY_SHUT=0; COPY_LONG=0; LIST_ODD=0; HAVE_PERL=1; VIEWER_URL=nowhere
# These stand for the folders outside any home folder, so that nothing of this Mac's own is read or listed
SYS_REPORTS="$WORK/sys/Reports"; SYS_LOGS=("$WORK/sys/Logs/Microsoft" "$WORK/sys/Application Support/Microsoft")
SYS_ROOTS=("$SYS_REPORTS" "${SYS_LOGS[@]}")
STAGE_BASE="$WORK/stages"
# The incident starts tomorrow, so every made-up file dated the day after is "since the incident". One report is
# dated now instead: it is found only because its text names Excel, within the days that reports are looked back.
SINCE=$(date -v+1d '+%Y-%m-%d'); REPORT_DAYS=1
WHEN=$(date -v+2d '+%Y%m%d')0304.05; YEAR=$(date -v+2d '+%Y')
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
[ "${#FIXED_SOURCES[@]}" -ge 5 ] || { echo "could not find the list of fixed sources in $SCRIPT"; exit 2; }
NL=$'\n'; TAB=$'\t'
new() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; touch -t "$WHEN" "$1"; }

mkdir -p "$WORK/secret/folder"
printf 'SECRET-BEHIND-A-LINK\n' > "$WORK/secret/file.txt"; printf 'SECRET-IN-A-LINKED-FOLDER\n' > "$WORK/secret/folder/inside.log"

new "$XL/Library/Logs/Diagnostics/EXCEL/excel.log" 'MADE-UP-EXCEL-LOG-LINE'
ln -s "$WORK/secret/file.txt" "$XL/Library/Logs/link-to-a-file.log"
ln -s "$WORK/secret/folder" "$XL/Library/Logs/link-to-a-folder"
mkfifo "$XL/Library/Logs/a-pipe.log"
new "$XL/Library/Logs/special-rights.log" 'MADE-UP-SPECIAL'; chmod 6755 "$XL/Library/Logs/special-rights.log"
new "$OFFICE_GC/Logs/office.log" 'MADE-UP-OFFICE-LOG-LINE'
# One file the user cannot read, among others in the same folder and in folders below it: it must cost only itself
new "$OFFICE_GC/Logs/a-first/one.log" 'MADE-UP-BEFORE-THE-UNREADABLE'
new "$OFFICE_GC/Logs/unreadable.log" 'MADE-UP-UNREADABLE'; chmod 000 "$OFFICE_GC/Logs/unreadable.log"
new "$OFFICE_GC/Logs/z-last/two.log" 'MADE-UP-AFTER-THE-UNREADABLE'
# A name that would be a line of its own in collection.log if a tool printed it while complaining about the file
new "$XL/Library/Logs/odd${NL}[03:04:05] FORGED-LOG-LINE${NL}.log" 'MADE-UP-ODD-IN-A-COPIED-FOLDER'
chmod 000 "$XL/Library/Logs/odd${NL}[03:04:05] FORGED-LOG-LINE${NL}.log"
new "$XL/Library/Preferences/com.microsoft.Excel.plist" '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>AutoRecoverMadeUp</key><string>MADE-UP-PREFERENCE</string><key>CustomerLoggingEnabled</key><true/></dict></plist>'
# With that switch on, the Documents folder is searched for verbose logs too
new "$USER_HOME/Documents/Excel Diagnostics/verbose.log" 'MADE-UP-VERBOSE-LOG'
new "$USER_HOME/Documents/Excel Diagnostics/odd${NL}name.log" 'MADE-UP-ODD-IN-DOCUMENTS'
# A folder with nothing in it, and a time of its own on the folder above it
mkdir -p "$XL/Library/Logs/Diagnostics/EmptyFolder"; touch -t "$WHEN" "$XL/Library/Logs/Diagnostics/EmptyFolder" "$XL/Library/Logs/Diagnostics"
# A folder the user cannot read, in a folder that is copied whole
new "$OFFICE_GC/Logs/closed/inside.log" 'MADE-UP-IN-A-CLOSED-FOLDER'; chmod 000 "$OFFICE_GC/Logs/closed"
new "$XL/Library/Preferences/AutoRecovery/Budget (AutoRecovered).xlsx" 'MADE-UP-RECOVERY'
new "$XL/Library/Preferences/AutoRecovery/autorecover${NL}FORGED-LINE | 1 | x.xar" 'x'
# a file of its own, where a folder of logs is expected
new "$USER_HOME/Library/Logs/Microsoft" 'MADE-UP-FILE-WHERE-A-FOLDER-IS-EXPECTED'
# found by the sweep
new "$USER_HOME/Library/Containers/com.microsoft.Something/Data/Library/Logs/found.log" 'MADE-UP-FOUND-LOG-LINE'
new "$USER_HOME/Library/Containers/com.microsoft.Something/Data/Library/Logs/-e starts with a dash.log" 'MADE-UP-DASH'
new "$USER_HOME/Library/Containers/com.microsoft.Something/Data/Library/Logs/evil.log${NL}copied${TAB}2026-01-01 00:00${TAB}1${TAB}/FORGED/location${TAB}office/discovered/forged.log" 'MADE-UP-FORGER'
ln -s "$WORK/secret/file.txt" "$USER_HOME/Library/Containers/com.microsoft.Something/Data/Library/Logs/linked.log"
ln -s "$WORK/secret/folder" "$USER_HOME/Library/Containers/com.microsoft.Linked"
# reports
R0="$USER_HOME/Library/Logs/DiagnosticReports"
new "$R0/Microsoft Excel-2099-01-02-030405.ips" '{"app_name":"Microsoft Excel","timestamp":"2099-01-02 03:04:05.00 +0000","bug_type":"309","name":"Microsoft Excel"}'
printf '{"exception":{"type":"EXC_BAD_ACCESS","signal":"SIGSEGV"},"faultingThread":0,"procName":"Microsoft Excel","MADE-UP-REPORT":1}\n' >> "$R0/Microsoft Excel-2099-01-02-030405.ips"
touch -t "$WHEN" "$R0/Microsoft Excel-2099-01-02-030405.ips"
# A file name cannot hold a slash, so the code these names carry learns where to write from the environment
export CODE_RAN_AT="$WORK/CODE-RAN"
new "$R0/a.ips${NL}-eBEGIN{open(F,q(>).\$ENV{CODE_RAN_AT});print F 1}#.ips" '{"bug_type":"309"}'
new "$R0/-eBEGIN{open(F,q(>).\$ENV{CODE_RAN_AT});print F 1}#Microsoft.ips" '{"bug_type":"309","MADE-UP-DASH-REPORT":1}'
ln -s "$WORK/secret/file.txt" "$R0/Microsoft linked.ips"
# A report that claims two gigabytes and holds nothing: copied byte by byte it would be written out in full
dd if=/dev/zero of="$R0/Microsoft claims-two-gigabytes.ips" bs=1 count=0 seek=2147483648 2>/dev/null; touch -t "$WHEN" "$R0/Microsoft claims-two-gigabytes.ips"
mkfifo "$R0/Microsoft pipe.ips"
printf '{"bug_type":"298"}\n{"largestProcess":"Microsoft Excel","MADE-UP-NAMES-EXCEL-ONLY-IN-ITS-TEXT":1}\n' > "$R0/helper-2099-01-02.ips"
printf '{"bug_type":"298"}\n{"largestProcess":"something else","MADE-UP-NAMES-NOTHING":1}\n' > "$R0/other-2099-01-02.ips"
new "$USER_HOME/Library/Application Support/CrashReporter/Microsoft Excel_0F1E2D3C.plist" '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>MADE-UP-FORCE-QUIT</key><integer>1</integer></dict></plist>'

# collect NAME - run the three steps into a fresh bundle folder
collect() {
    OUT="$WORK/$1/Excel_Diagnostics_collect_20990102_030405"; mkdir -p "$OUT"
    LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
    STAGE="$WORK/$1"                              # the copies keep their scratch files beside the bundle folder
    # BETWEEN, when set, is run after the fixed folders are copied and before the search for other files
    ( collect_office; eval "$BETWEEN"; discover_sources; collect_reports; echo "$COPY_LOST $COPY_ODD $COPY_BIG $COPY_SHUT $LIST_ODD" > "$WORK/$1.counts"
    ) > "$WORK/$1.out" 2>&1 < /dev/null &
    local pid=$! n=0
    while kill -0 "$pid" 2>/dev/null && [ $n -lt 240 ]; do sleep 0.25; n=$((n + 1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; pkill -9 -f "$USER_HOME" 2>/dev/null; bad "$1: the steps did not finish in a minute (stuck on a pipe?)"; fi
    wait "$pid" 2>/dev/null
}

# ---- with the console user's rights -------------------------------------------------------------------------------
collect plain
T="$OUT/office/discovered_sources.tsv"
is "nothing in the collector's own messages went wrong" "$(grep -c -i 'syntax error\|command not found\|unbound\|bad substitution\|integer expression' "$WORK/plain.out")" 0
is "Excel's log is copied" "$(cat "$OUT/office/excel_container_logs/Diagnostics/EXCEL/excel.log" 2>/dev/null)" 'MADE-UP-EXCEL-LOG-LINE'
is "with the time it was last changed" "$(stat -f '%Sm' -t '%Y%m%d%H%M.%S' "$OUT/office/excel_container_logs/Diagnostics/EXCEL/excel.log" 2>/dev/null)" "$WHEN"
is "the shared Office log is copied" "$(cat "$OUT/office/office_group_logs/office.log" 2>/dev/null)" 'MADE-UP-OFFICE-LOG-LINE'
is "a file where a folder of logs is expected is copied as a file" "$(cat "$OUT/office/user_microsoft_logs" 2>/dev/null)" 'MADE-UP-FILE-WHERE-A-FOLDER-IS-EXPECTED'
is "no link, pipe or device is in the bundle" "$(find "$OUT" ! -type f ! -type d | wc -l | tr -d ' ')" 0
find "$OUT" ! -type f ! -type d -delete 2>/dev/null       # were one there, the checks below would stop at a pipe
is "what a link inside a copied folder points at is not in the bundle" "$(count "$OUT" 'SECRET-')" 0
is "no file keeps special rights" "$(find "$OUT" -type f -perm +6000 | wc -l | tr -d ' ')" 0
is "the file that had them is still copied" "$(cat "$OUT/office/excel_container_logs/special-rights.log" 2>/dev/null)" 'MADE-UP-SPECIAL'
is "the sweep copies what it finds" "$(cat "$OUT/office/discovered/home/Library/Containers/com.microsoft.Something/Data/Library/Logs/found.log" 2>/dev/null)" 'MADE-UP-FOUND-LOG-LINE'
is "a name that starts with -e is a name" "$(cat "$OUT/office/discovered/home/Library/Containers/com.microsoft.Something/Data/Library/Logs/-e starts with a dash.log" 2>/dev/null)" 'MADE-UP-DASH'
is "every row of the list has five columns" "$(awk -F'\t' 'NF != 5' "$T" | wc -l | tr -d ' ')" 0
is "the list holds the header and one row per file with an honest name" "$(cut -f1 "$T" | sort | uniq -c | sed 's/^ *//' | tr '\n' '|')" '3 copied|5 copied (fixed source)|1 listed only: not in the copy of its folder, and not read now, because opening it was refused|1 status|'
is "with the switch for verbose logs on, the Documents folder is searched" "$(cat "$OUT/office/discovered/home/Documents/Excel Diagnostics/verbose.log" 2>/dev/null)" 'MADE-UP-VERBOSE-LOG'
is "no row comes from a file's name" "$(grep -c 'FORGED' "$T")" 0
is "the file with a line break in its name is not copied" "$(count "$OUT" 'MADE-UP-FORGER')" 0
is "and is counted with the two others, the one in Documents among them, in the log and in the status" "$(grep -c '^  3 more with a control or invisible character in the name or path were not listed or copied' "$LOG") $(grep -c '3 with a control or invisible character in the name left out' "$MANIFEST")" '1 1'
is "a folder with nothing in it is copied" "$([ -d "$OUT/office/excel_container_logs/Diagnostics/EmptyFolder" ] && echo there || echo missing)" 'there'
is "a folder keeps when it was last changed" "$(stat -f '%Sm' -t '%Y%m%d%H%M.%S' "$OUT/office/excel_container_logs/Diagnostics" 2>/dev/null)" "$WHEN"
is "a folder that cannot be read is said and counted" "$(grep -c '^  1 folder(s) in it could not be read, so what they hold is not copied or counted: ' "$LOG") $(count "$OUT" 'MADE-UP-IN-A-CLOSED-FOLDER')" '1 0'

is "one unreadable file costs only itself: the file before it arrives" "$(cat "$OUT/office/office_group_logs/a-first/one.log" 2>/dev/null)" 'MADE-UP-BEFORE-THE-UNREADABLE'
is "one unreadable file costs only itself: the file after it arrives" "$(cat "$OUT/office/office_group_logs/z-last/two.log" 2>/dev/null)" 'MADE-UP-AFTER-THE-UNREADABLE'
is "the unreadable file is counted in the log" "$(grep -c '^  1 file(s) did not arrive, unreadable or gone before they were read: ' "$LOG")" 1
is "a file with a line break in its name is not copied from a folder copied whole" "$(count "$OUT" 'MADE-UP-ODD-IN-A-COPIED-FOLDER')" 0
is "and is counted" "$(grep -c '^  1 file(s) with a control or invisible character in the name or path were left out: ' "$LOG")" 1
is "no line of the log comes from a file's name" "$(grep -c 'FORGED-LOG-LINE' "$LOG")" 0
is "what a copying tool said is set in from the margin" "$(grep -c '^tar:' "$LOG") $(grep -c '^      tar: ' "$LOG" | sed 's/^[1-9][0-9]*$/some/')" '0 some'
is "the counts are kept for the status table: one unreadable file, one odd name, one left out for its size, one closed folder, one name left out of a list" "$(cat "$WORK/plain.counts" 2>/dev/null)" '1 1 1 1 1'
is "the recovery list says how many names it left out" "$(grep -c '^(1 more with a control or invisible character in the name or path are not listed)$' "$OUT/office/autorecover_inventory.txt")" 1
is "the preferences are read" "$(grep -c 'MADE-UP-PREFERENCE' "$OUT/office/office_prefs.txt")" 1
is "the recovery list has no line that comes from a name" "$(grep -c '^FORGED-LINE' "$OUT/office/autorecover_inventory.txt")" 0

is "the recovery list has the honest file" "$(grep -c 'Budget (AutoRecovered).xlsx$' "$OUT/office/autorecover_inventory.txt")" 1
# A list says by what test it picked its files, and nothing about what such a file means
A="$OUT/office/autorecover_inventory.txt"
is "the recovery list says by what names it picks files, and gives them no meaning" \
    "$(grep -c '^Files whose name holds autorecover or ends in .xar (in any case), or starts with ~ar, oldest change first. Modified | bytes | path$' "$A") $(grep -c -i 'usually\|mean\|cleanly\|leftover' "$A")" "$(grep -c '^=== .*(total' "$A") 0"
is "the list of large files says what it holds" "$(grep -c '^Files over 10 MB in it, of any name, largest first (one with a control or invisible character in the name or path is not listed)\. bytes | path$' "$A")" "$(grep -c '^=== .*(total' "$A")"
is "the preferences' heading names the words its lines are picked by, as grep is given them" \
    "$(grep -c '^=== Excel user prefs: the lines of the text plutil -p gives for com.microsoft.Excel.plist that hold one of autosave, autorecover, recover, calc, graphic, addin, logging (in any case, in a key or in a value)$' "$OUT/office/office_prefs.txt") $(grep -c "grep -iE -e \"\$rx\"" "$SCRIPT") $(grep -c "'autosave|autorecover" "$SCRIPT")" '1 1 0'
is "the summary of reports counts them by name and says nothing about what a kind means" \
    "$(grep -c "^## Reports copied (not those of CrashReporter), counted by name, with a date in the name and what follows it up to the file's ending taken off\$" "$OUT/reports/crash_summary.txt") $(grep -c -i 'got stuck\|restart record\|was exceeded\|shutdownStall =' "$OUT/reports/crash_summary.txt")" '1 0'
REP="$OUT/reports/user_Library_Logs_DiagnosticReports"
is "the report is copied" "$(count "$REP" 'MADE-UP-REPORT')" 1
is "a report whose name starts with -e is copied as a file" "$(count "$REP" 'MADE-UP-DASH-REPORT')" 1
is "a report keeps when it was last changed" "$(stat -f '%Sm' -t '%Y%m%d%H%M.%S' "$REP/Microsoft Excel-2099-01-02-030405.ips" 2>/dev/null)" "$WHEN"
is "an older report that names Excel only in its text is copied, one that does not is not" "$(count "$REP" 'MADE-UP-NAMES-EXCEL-ONLY-IN-ITS-TEXT') $(count "$REP" 'MADE-UP-NAMES-NOTHING')" '1 0'
is "reports: the one with a line break in its name, the link and the pipe are not" "$(ls "$REP" | wc -l | tr -d ' ')" 3
is "no code from a file name ran" "$([ -e "$WORK/CODE-RAN" ] && echo RAN || echo 'nothing ran')" 'nothing ran'
is "the summary has one heading per report copied" "$(grep -c '^## reports/' "$OUT/reports/crash_summary.txt")" 3
is "the summary reads the report" "$(grep -c '^Exception Type: *EXC_BAD_ACCESS' "$OUT/reports/crash_summary.txt")" 1
is "the listing shows a line break in a name as a question mark" "$(grep -c '^-eBEGIN' "$OUT/reports/report_listing.txt") $(grep -c 'a.ips?-eBEGIN' "$OUT/reports/report_listing.txt")" '0 1'
is "the force-quit record is copied and read" "$(count "$OUT/reports/CrashReporter" 'MADE-UP-FORCE-QUIT')" 2
is "a report over the limit for one file is left out and counted" "$([ -e "$REP/Microsoft claims-two-gigabytes.ips" ] && echo copied || echo 'left out') $(grep -c '^  1 report(s) were listed and not copied, each because it is over 1024 MB$' "$LOG")" 'left out 1'
is "one report with a control character in its name is counted, in the log and in the reports row" "$(grep -c '1 report(s) with a control or invisible character in the name were not copied' "$LOG") $(grep -c "^reports${TAB}incomplete${TAB}.*1 report(s) with a control or invisible character in the name were not copied" "$MANIFEST")" '1 1'

# A folder of logs that is itself a link: read with the user's rights it leads where the user may go, and what is
# copied is plain files. (As root this is the case the collector must not follow with root's rights; see below.)
rm -f "$USER_HOME/Library/Logs/Microsoft"; ln -s "$WORK/secret/folder" "$USER_HOME/Library/Logs/Microsoft"
collect linked
is "a linked folder is read as the user may read it" "$(cat "$OUT/office/user_microsoft_logs/inside.log" 2>/dev/null)" 'SECRET-IN-A-LINKED-FOLDER'
is "and still nothing but plain files and folders is kept" "$(find "$OUT" ! -type f ! -type d | wc -l | tr -d ' ')" 0

# A log written after its folder was copied and before the search: the search finds it under a folder that was
# copied whole, sees that it is not in the copy, and takes it itself.
BETWEEN='new "$XL/Library/Logs/written-after.log" MADE-UP-WRITTEN-AFTER-THE-COPY'
collect late; BETWEEN=""
is "a log written after its folder was copied is taken by the search" "$(cat "$OUT/office/discovered/home/Library/Containers/com.microsoft.Excel/Data/Library/Logs/written-after.log" 2>/dev/null) $(grep -c "^copied${TAB}.*written-after.log${TAB}office/discovered/" "$OUT/office/discovered_sources.tsv")" 'MADE-UP-WRITTEN-AFTER-THE-COPY 1'
rm -f "$XL/Library/Logs/written-after.log"
# A search that is stopped at its time limit must not be recorded as complete
as_user() { case "$AS_WHAT" in *'search of the home folder'*) return 124 ;; esac; "$@"; }
collect stopped
is "a search stopped at its time limit is recorded as incomplete" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}.*; office/discovered_sources.tsv; the search was stopped at its time limit" "$MANIFEST") $(grep -c '^  the search was stopped at its time limit (see time_limit in the status table)' "$LOG")" '1 1'
is "no step says it was stopped after a number of seconds that may not be the limit it was given" "$(grep -c 'after \$COPY_SECONDS seconds\|longer than \$COPY_SECONDS seconds' "$SCRIPT")" 0
eval "$REAL_AS_USER"

# ---- when the console user's rights cannot be taken on ----------------------------------------------------------
# as_user is the one door to the home folder. Shut, nothing made up above may reach the bundle by any other way.
as_user() { return 126; }
collect refused
is "door shut: no file from the home folder is in the bundle" "$(count "$OUT" 'MADE-UP-') $(count "$OUT" 'SECRET-')" '0 0'
is "door shut: no report from the home folder" "$(find "$OUT/reports" -type f ! -name report_listing.txt ! -name crash_summary.txt | wc -l | tr -d ' ')" 0
is "door shut: no name from the home folder in the lists" "$(grep -r -l -a -F -e 'found.log' -e 'AutoRecovered' -e 'Microsoft Excel-2099' "$OUT" | wc -l | tr -d ' ')" 0
is "door shut: nothing ran" "$([ -e "$WORK/CODE-RAN" ] && echo RAN || echo 'nothing ran')" 'nothing ran'
eval "$REAL_AS_USER"

# ---- every read of the home folder goes through that door ---------------------------------------------------------
# The test is not root, so it cannot see a difference in rights. It makes a difference of its own: the collector
# is pointed at a decoy home folder, and as_user is made to lead to the real made-up one. Whatever the bundle
# then holds from the decoy was read without going through as_user, which as root would be with root's rights.
REAL_HOME=$USER_HOME; DECOY="$WORK/decoy"
rm -f "$REAL_HOME/Library/Logs/Microsoft"; new "$REAL_HOME/Library/Logs/Microsoft" 'MADE-UP-FILE-WHERE-A-FOLDER-IS-EXPECTED'     # a file again
( cd "$REAL_HOME" && find . -type d ! -path '*[[:cntrl:]]*' -print0 2>/dev/null ) | ( mkdir -p "$DECOY" && cd "$DECOY" && xargs -0 mkdir -p )
( cd "$REAL_HOME" && find . -type f ! -path '*[[:cntrl:]]*' -print0 2>/dev/null ) | while IFS= read -r -d '' f; do
    printf 'READ-AS-ROOT\n' > "$DECOY/$f"; touch -t "$WHEN" "$DECOY/$f"
done
rm -f "$DECOY/Library/Logs/DiagnosticReports/Microsoft Excel-2099-01-02-030405.ips"       # only the real home has this report
for f in "Library/Containers/com.microsoft.Something/Data/Library/Logs/decoy-only.log" "Library/Logs/DiagnosticReports/Microsoft decoy-only.ips" \
         "Library/Containers/com.microsoft.Excel/Data/Library/Preferences/AutoRecovery/decoy-only (AutoRecovered).xlsx" \
         "Library/Application Support/CrashReporter/Microsoft decoy-only.plist"; do
    printf 'READ-AS-ROOT\n' > "$DECOY/$f"; touch -t "$WHEN" "$DECOY/$f"
done
# Three more reads, each with something only the decoy has: a preferences file, a folder the catalog asks about,
# and a workbook
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>AutoSaveDecoyOnly</key><string>READ-AS-ROOT</string></dict></plist>' \
    > "$DECOY/Library/Containers/com.microsoft.Excel/Data/Library/Preferences/com.microsoft.Excel.plist"
mkdir -p "$DECOY/Library/Logs/OneDrive" "$DECOY/Documents"; printf 'READ-AS-ROOT\n' > "$DECOY/Documents/decoy-only book.xlsx"
USER_HOME=$DECOY
XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"
OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
# The look for the folders to search names what it found, in the real home: those names are given back as the
# decoy's, as they would be the same names in a real run
as_user() {
    local a args=()
    for a in "$@"; do args+=("${a//"$DECOY"/$REAL_HOME}"); done
    case "$*" in *'for f in "$home/Library/Containers"/com.microsoft.*'*)
        "${args[@]}" | R=$REAL_HOME D=$DECOY /usr/bin/perl -0777 -pe 's/\Q$ENV{R}\E/$ENV{D}/g'; return "${PIPESTATUS[0]}" ;;
    esac
    "${args[@]}"
}
collect decoy
find "$OUT" ! -type f ! -type d -delete 2>/dev/null
is "nothing was read from the home folder except through as_user" "$(count "$OUT" 'READ-AS-ROOT')" 0
is "no name was listed from the home folder except through as_user" "$(grep -r -l -a -F 'decoy-only' "$OUT" | wc -l | tr -d ' ')" 0
is "through as_user, Excel's logs arrive" "$(cat "$OUT/office/excel_container_logs/Diagnostics/EXCEL/excel.log" 2>/dev/null)" 'MADE-UP-EXCEL-LOG-LINE'
is "through as_user, the file where a folder is expected arrives" "$(cat "$OUT/office/user_microsoft_logs" 2>/dev/null)" 'MADE-UP-FILE-WHERE-A-FOLDER-IS-EXPECTED'
is "through as_user, the swept log arrives" "$(count "$OUT" 'MADE-UP-FOUND-LOG-LINE')" 1
is "through as_user, the report arrives" "$(count "$OUT" 'MADE-UP-REPORT')" 1
is "through as_user, the force-quit record arrives" "$(count "$OUT" 'MADE-UP-FORCE-QUIT')" 2
is "through as_user, the recovery list names the real file" "$(grep -c 'Budget (AutoRecovered).xlsx$' "$OUT/office/autorecover_inventory.txt")" 1
is "through as_user, the preferences are the real ones" "$(grep -c 'MADE-UP-PREFERENCE' "$OUT/office/office_prefs.txt") $(grep -c 'AutoSaveDecoyOnly' "$OUT/office/office_prefs.txt")" '1 0'
write_source_catalog > /dev/null 2>&1
is "the catalog asks through as_user whether a folder is there" "$(awk -F'\t' '$1 == "OneDrive logs (standalone)" { print $2 }' "$OUT/source_catalog.tsv")" 'missing'
is "the catalog says what is done with a source, and nothing about who installs it or what it is for" \
    "$(awk -F'\t' '$1 == "OneDrive logs (standalone)" { print $5 }' "$OUT/source_catalog.tsv" | grep -c '^The OneDrive folder of the user.s Logs folder: the search for other Microsoft log files lists the files in it that it takes as log files, and copies them (see office/discovered_sources.tsv)$') $(grep -c -i 'usually\|is reported to\|pushed by\|when installed\|when workbooks are\|for support cases' "$OUT/source_catalog.tsv")" '1 0'
WORKBOOK="$DECOY/Documents/decoy-only book.xlsx"; collect_workbook_metadata > /dev/null 2>&1; WORKBOOK=""
is "a workbook's facts are asked through as_user" "$(head -c 31 "$OUT/case/workbook_metadata.txt" 2>/dev/null)" 'Workbook not looked at: test -f'
USER_HOME=$REAL_HOME
eval "$REAL_AS_USER"
XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"
OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"

# ---- names with an invisible character in them --------------------------------------------------------------------
# A name with a character that sets the direction of text, a line separator, an 8-bit control, a zero-width space or
# the Arabic letter mark shows as some other name, or reorders what follows it. Each such file is left out of every
# copy and list, and counted where a name with a control character is. The names below hold U+202E, U+2028, U+0085,
# U+200B and U+061C, written as the bytes UTF-8 gives them.
IH="$WORK/invisible-home"
INVISIBLE=($'right\xe2\x80\xaeleft.log' $'line\xe2\x80\xa8break.log' $'eight\xc2\x85bit.log' $'zero\xe2\x80\x8bwidth.log' $'arabic\xd8\x9cmark.log')
for n in "${INVISIBLE[@]}"; do
    new "$IH/Library/Containers/com.microsoft.Excel/Data/Library/Logs/$n" 'MADE-UP-INVISIBLE'
    new "$IH/Library/Containers/com.microsoft.Excel/Data/Library/Preferences/AutoRecovery/${n%.log}.xar" 'MADE-UP-INVISIBLE'
    new "$IH/Library/Containers/com.microsoft.Other/Data/Library/Logs/$n" 'MADE-UP-INVISIBLE'
    new "$IH/Library/Logs/DiagnosticReports/Microsoft ${n%.log}.ips" '{"bug_type":"309","MADE-UP-INVISIBLE":1}'
done
new "$IH/Library/Containers/com.microsoft.Excel/Data/Library/Logs/plain.log" 'MADE-UP-PLAIN-BESIDE-THEM'
# A folder the search for other logs would start from, with such a name: nothing in it is searched
new "$IH/Library/Containers/com.microsoft."$'\xe2\x80\xae'"x/Data/Library/Logs/inside.log" 'MADE-UP-INVISIBLE'
USER_HOME=$IH; XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"; OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
COPY_ODD=0; LIST_ODD=0; collect invisible
is "nothing in the collector's own messages went wrong (invisible names)" "$(grep -c -i 'syntax error\|command not found\|unbound\|bad substitution\|integer expression' "$WORK/invisible.out")" 0
is "no file with an invisible character in its name is copied or listed" "$(count "$OUT" 'MADE-UP-INVISIBLE') $(grep -r -a -l -e $'\xe2\x80\xae' -e $'\xe2\x80\xa8' -e $'\xc2\x85' -e $'\xe2\x80\x8b' -e $'\xd8\x9c' "$OUT" | wc -l | tr -d ' ')" '0 0'
is "the plain file beside them is copied, and none of them is said to have gone missing" "$(cat "$OUT/office/excel_container_logs/plain.log" 2>/dev/null) $(grep -c 'did not arrive' "$LOG")" 'MADE-UP-PLAIN-BESIDE-THEM 0'
is "the copy of the folder counts them" "$(grep -c "^  5 file(s) with a control or invisible character in the name or path were left out: $IH/Library/Containers/com.microsoft.Excel/Data/Library/Logs\$" "$LOG")" 1
is "the AutoRecover list counts them" "$(grep -c '^(5 more with a control or invisible character in the name or path are not listed)$' "$OUT/office/autorecover_inventory.txt")" 1
is "the search for other logs counts them, the ones in the folder copied whole among them, and searches no folder with such a name" "$(grep -c '^  10 more with a control or invisible character in the name or path were not listed or copied$' "$LOG")" 1
is "the reports step counts them" "$(grep -c '^  5 report(s) with a control or invisible character in the name were not copied$' "$LOG")" 1
is "and the counts for the status table hold them: the copy's, then the lists'" "$(cut -d' ' -f2,5 "$WORK/invisible.counts" 2>/dev/null)" '5 5'
USER_HOME=$REAL_HOME; XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"; OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
is "the test for such a name is held in one place: no other test for a control character is left" "$(grep -c '\[\[:cntrl:\]\]' "$SCRIPT") $(grep -c '^ODD_GLOBS=(.\*\[\[:cntrl:\]\]\*.$' "$SCRIPT")" '1 1'

# ---- a folder copied whole: what is left out for its size ---------------------------------------------------------
# A file can claim any length without holding it, and the zip step would read every byte of that length.
OUT="$WORK/sizes/bundle"; STAGE="$WORK/sizes"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"
BIG="$USER_HOME/Library/Logs/Sizes"; mkdir -p "$BIG"
new "$BIG/small.log" 'MADE-UP-SMALL'
dd if=/dev/zero of="$BIG/claims-three-megabytes.log" bs=1 count=0 seek=3145728 2>/dev/null
MAX_COPY_FILE_MB=1; COPY_BIG=0
as_user() { echo "${AS_LIMIT:-none}" >> "$WORK/limits.log"; "$@"; }
copy_dir "$BIG" "$OUT/sizes"
eval "$REAL_AS_USER"
is "the count and the copy of a folder each run under the limit for one folder's copy" "$(grep -c '^60$' "$WORK/limits.log")" 2
is "a file over the limit for one file is left out, the others arrive" "$(ls "$OUT/sizes" | tr '\n' ' ')" 'small.log '
is "and is counted" "$COPY_BIG $(grep -c '^  1 file(s) over 1 MB were left out: ' "$LOG")" '1 1'
rm -f "$BIG/claims-three-megabytes.log"
for f in a b c; do dd if=/dev/zero of="$BIG/six-hundred-k-$f.log" bs=1 count=0 seek=614400 2>/dev/null; done
MAX_COPY_FILE_MB=1024; MAX_COPY_FOLDER_MB=1; COPY_BIG=0
copy_dir "$BIG" "$OUT/sizes2"
is "a folder over the limit for one folder loses its largest files until it is under" "$(ls "$OUT/sizes2" | wc -l | tr -d ' ') $(cat "$OUT/sizes2/small.log" 2>/dev/null)" '2 MADE-UP-SMALL'
is "and they are counted" "$COPY_BIG $(grep -c "^  2 of the largest file(s) were left out to keep this folder's copy under 1 MB: " "$LOG")" '2 1'
MAX_COPY_FOLDER_MB=4096; COPY_BIG=0
copy_dir "$WORK/secret/folder" "$OUT/outside"
is "a folder outside the home folder is not copied whole" "$? $(count "$OUT" 'SECRET-')" '1 0'
mkdir -p "$USER_HOME/Library/Logs/Shut"; chmod 000 "$USER_HOME/Library/Logs/Shut"; COPY_SHUT=0
copy_dir "$USER_HOME/Library/Logs/Shut" "$OUT/shut"
is "a folder that cannot be entered is said to be that, and counted" "$? $COPY_SHUT $(grep -c "^  not copied, the folder could not be entered with the console user's rights: " "$LOG") $(grep -c 'may be incomplete' "$LOG")" '1 1 1 0'
# Reports have a budget for each folder too: of two that are over it together, one is copied and one is counted
RH="$WORK/reports-home"; mkdir -p "$RH/Library/Logs/DiagnosticReports"
for f in a b; do
    dd if=/dev/zero of="$RH/Library/Logs/DiagnosticReports/Microsoft budget-$f.ips" bs=1 count=0 seek=614400 2>/dev/null
    touch -t "$WHEN" "$RH/Library/Logs/DiagnosticReports/Microsoft budget-$f.ips"
done
KEEP_H=$USER_HOME; KEEP_OUT=$OUT; KEEP_LOG=$LOG; USER_HOME=$RH; MAX_COPY_FOLDER_MB=1; COPY_BIG=0
OUT="$WORK/budget/bundle"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; : > "$LOG"
collect_reports > /dev/null 2>&1
is "of two reports over one folder's budget together, one is copied and one is counted" "$(ls "$OUT/reports/user_Library_Logs_DiagnosticReports" 2>/dev/null | wc -l | tr -d ' ') $(grep -c '^  1 report(s) were listed and not copied, each because the files copied before it had used up the 1 MB allowed for them, or it would have taken them past that$' "$LOG") $COPY_BIG" '1 1 1'
# The same budget for the search for other log files, and for the force-quit records
for f in a b; do
    mkdir -p "$RH/Library/Containers/com.microsoft.Budget/Data/Library/Logs" "$RH/Library/Application Support/CrashReporter"
    dd if=/dev/zero of="$RH/Library/Containers/com.microsoft.Budget/Data/Library/Logs/budget-$f.log" bs=1 count=0 seek=614400 2>/dev/null
    dd if=/dev/zero of="$RH/Library/Application Support/CrashReporter/Microsoft budget-$f.plist" bs=1 count=0 seek=614400 2>/dev/null
    touch -t "$WHEN" "$RH/Library/Containers/com.microsoft.Budget/Data/Library/Logs/budget-$f.log"
done
COPY_BIG=0; discover_sources > /dev/null 2>&1
is "the search copies one of two logs over its budget together, and says why the other was not" "$(cut -f1 "$OUT/office/discovered_sources.tsv" | sort | uniq -c | sed 's/^ *//' | tr '\n' '|')" "1 copied|1 listed only: not copied, because the files copied before it had used up the 1 MB allowed for them, or it would have taken them past that|1 status|"
rm -rf "$OUT/reports"; collect_reports > /dev/null 2>&1
is "and of two force-quit records over the budget together, one is copied" "$(ls "$OUT/reports/CrashReporter" 2>/dev/null | grep -c 'plist$')" 1
USER_HOME=$KEEP_H; OUT=$KEEP_OUT; LOG=$KEEP_LOG; MAX_COPY_FOLDER_MB=4096; COPY_BIG=0
# What root unpacks is written by a process of the user's. Here it is replaced by a stream made on purpose: a
# name with a line break, a link, a pipe and a file with special rights. None may stay in the copy.
mkdir -p "$WORK/hostile/sub"; printf 'MADE-UP-HOSTILE-BUT-PLAIN\n' > "$WORK/hostile/sub/plain.log"; printf 'x\n' > "$WORK/hostile/odd${NL}name.log"
ln -s "$WORK/secret/file.txt" "$WORK/hostile/link.log"; mkfifo "$WORK/hostile/pipe.log"; printf 's\n' > "$WORK/hostile/special.log"; chmod 6755 "$WORK/hostile/special.log"
as_user() { case "$*" in *'/usr/bin/tar -cf - --null'*) COPYFILE_DISABLE=1 /usr/bin/tar -cf - -C "$WORK/hostile" . ;; *) "$@" ;; esac; }
copy_dir "$BIG" "$OUT/hostile"
eval "$REAL_AS_USER"
is "of a stream made on purpose only plain files with plain names and plain rights stay" "$(find "$OUT/hostile" ! -type f ! -type d | wc -l | tr -d ' ') $(find "$OUT/hostile" -name '*[[:cntrl:]]*' | wc -l | tr -d ' ') $(find "$OUT/hostile" -type f -perm +6000 | wc -l | tr -d ' ') $(cat "$OUT/hostile/sub/plain.log" 2>/dev/null)" '0 0 0 MADE-UP-HOSTILE-BUT-PLAIN'

# ---- one file, opened as itself ------------------------------------------------------------------------------------
F="$WORK/fetch"; mkdir -p "$F"
new "$USER_HOME/Library/Logs/plain.log" 'MADE-UP-PLAIN'
ln -s "$WORK/secret/file.txt" "$USER_HOME/Library/Logs/linked.log"
mkfifo "$USER_HOME/Library/Logs/pipe.log"
is "fetch prints a plain file" "$(fetch "$USER_HOME/Library/Logs/plain.log" 0 2>/dev/null) $?" 'MADE-UP-PLAIN 0'
is "and says when it was last changed" "$(fetch "$USER_HOME/Library/Logs/plain.log" 0 2>&1 >/dev/null)" "$(stat -f '%m' "$USER_HOME/Library/Logs/plain.log")"
is "fetch does not follow a link, and says it is not a plain file" "$(fetch "$USER_HOME/Library/Logs/linked.log" 0 2>/dev/null) $?" ' 7'
( fetch "$USER_HOME/Library/Logs/pipe.log" 0 > "$F/pipe.out" 2>/dev/null; echo $? > "$F/pipe.status" ) &
pid=$!; n=0; while kill -0 "$pid" 2>/dev/null && [ $n -lt 20 ]; do sleep 0.25; n=$((n + 1)); done
kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
is "fetch does not wait at a pipe, and says it is not a plain file" "$(cat "$F/pipe.status" 2>/dev/null)" 7
fetch "$USER_HOME/Library/Logs/plain.log" 0 'UP-PLA';       is "fetch can say that a file holds a text" "$?" 0
fetch "$USER_HOME/Library/Logs/plain.log" 0 'NOT-IN-IT';    is "and that it does not" "$?" 1
fetch "$USER_HOME/Library/Logs/linked.log" 0 'SECRET';      is "and does not look behind a link for it" "$?" 7
dd if=/dev/zero of="$USER_HOME/Library/Logs/claims-three-megabytes.log" bs=1 count=0 seek=3145728 2>/dev/null
copy_file "$USER_HOME/Library/Logs/claims-three-megabytes.log" "$F/copied-big" "" 1
is "a single file over the limit given is not copied" "$? $([ -e "$F/copied-big" ] && echo left || echo 'nothing left')" '5 nothing left'
copy_file "$USER_HOME/Library/Logs/claims-three-megabytes.log" "$F/copied-big" "" 4
is "under the limit it is" "$? $(stat -f '%z' "$F/copied-big" 2>/dev/null)" '0 3145728'
fetch "$USER_HOME/Library/Logs/claims-three-megabytes.log" 1048576 > "$F/refused.out" 2>/dev/null
is "a file over the limit is refused before any of it is written" "$? $(stat -f '%z' "$F/refused.out")" '5 0'
# One that grows while it is read. The reader is held at its first write (a pipe nobody empties yet), the file is
# made longer, and then the pipe is emptied.
G="$USER_HOME/Library/Logs/growing.log"; dd if=/dev/zero of="$G" bs=1024 count=200 2>/dev/null; mkfifo "$F/held"
( fetch "$G" 204800 1<> "$F/held" 2>/dev/null; echo $? > "$F/grew.status" ) &
pid=$!; sleep 0.6; printf 'ten bytes.' >> "$G"; cat "$F/held" > /dev/null &
n=0; while kill -0 "$pid" 2>/dev/null && [ $n -lt 20 ]; do sleep 0.25; n=$((n + 1)); done
kill -9 "$pid" 2>/dev/null; wait
is "a file that grows past the limit while it is read is given up" "$(cat "$F/grew.status" 2>/dev/null)" 5
COPY_BUDGET=20; copy_file "$USER_HOME/Library/Logs/plain.log" "$F/in-budget"
is "a run of copies has a budget: a file that fits is copied and taken off it" "$? $COPY_BUDGET" '0 6'
copy_file "$USER_HOME/Library/Logs/plain.log" "$F/past-budget"
is "and one that no longer fits is not copied" "$? $([ -e "$F/past-budget" ] && echo left || echo 'nothing left') $COPY_BUDGET" '6 nothing left 6'
COPY_BUDGET=""
# Without perl, and with no rights to guard, files are read the plain way, under the same rules. perl is there on
# this Mac, so the command that would start it is made to fail: only the plain way can give the answers below.
HAVE_PERL=0; KEEP_PERL_CMD=("${PERL_CMD[@]}"); PERL_CMD=(/usr/bin/false)
is "without perl: a plain file is printed, with its time" "$(fetch "$USER_HOME/Library/Logs/plain.log" 0 2>/dev/null) $(fetch "$USER_HOME/Library/Logs/plain.log" 0 2>&1 >/dev/null)" "MADE-UP-PLAIN $(stat -f '%m' "$USER_HOME/Library/Logs/plain.log")"
fetch "$USER_HOME/Library/Logs/linked.log" 0 > /dev/null 2>&1;                        is "without perl: a link is not followed" "$?" 7
fetch "$USER_HOME/Library/Logs/claims-three-megabytes.log" 1048576 > /dev/null 2>&1;  is "without perl: a file over the limit is refused" "$?" 5
fetch "$USER_HOME/Library/Logs/plain.log" 0 'UP-PLA';                                 is "without perl: a text is found" "$?" 0
fetch "$USER_HOME/Library/Logs/plain.log" 0 'NOT-IN-IT';                              is "without perl: or not found" "$?" 1
HAVE_PERL=1; PERL_CMD=("${KEEP_PERL_CMD[@]}")
copy_file "$USER_HOME/Library/Logs/linked.log" "$F/copied-link"; is "a link is not copied as a file" "$? $([ -e "$F/copied-link" ] && echo left || echo 'nothing left')" '12 nothing left'

# Outside the home folder, as root. The test is not root, but the rule does not ask who runs it: AM_ROOT=1 switches
# it on, with the test's own account as the console user.
SYS="$WORK/sys/Logs/Microsoft"; mkdir -p "$SYS/sub"
new "$SYS/autoupdate.log" 'MADE-UP-SYSTEM-LOG'
new "$SYS/sub/inner.log" 'MADE-UP-SYSTEM-INNER'
ln -s "$WORK/secret/folder" "$SYS/linked-folder"
ln "$WORK/secret/file.txt" "$SYS/second-name.log"
ln -s "$WORK/secret/file.txt" "$SYS/linked.log"
AM_ROOT=1; USER_UID=$(id -u); USER_GID=$(id -g); USER_GROUPS=$(id -G)
is "as root, a file in a system folder is read" "$(fetch "$SYS/sub/inner.log" 0 2>/dev/null) $?" 'MADE-UP-SYSTEM-INNER 0'
is "as root, a file reached through a linked folder is not" "$(fetch "$SYS/linked-folder/inside.log" 0 2>/dev/null) $?" ' 3'
is "as root, a second name for a file from elsewhere is not" "$(fetch "$SYS/second-name.log" 0 2>/dev/null) $?" ' 3'
is "as root, a link is not" "$(fetch "$SYS/linked.log" 0 2>/dev/null) $?" ' 7'
is "as root, a file in no folder the collector reads from is not" "$(fetch "$WORK/secret/file.txt" 0 2>/dev/null) $?" ' 3'
fetch "$SYS/linked-folder/inside.log" 0 'SECRET';   is "as root, nothing is said about a file behind a linked folder" "$?" 3
ln -s "$SYS" "$WORK/sys/Logs/Linked"; SYS_ROOTS=("$WORK/sys/Logs/Linked")
is "as root, nothing is read from a system folder that is itself a link" "$(fetch "$WORK/sys/Logs/Linked/autoupdate.log" 0 2>/dev/null) $?" ' 3'
SYS_ROOTS=("$SYS")
# The fixed source outside the home folder, put in the list as the collector has it, pointing at a link
rm -f "$SYS/autoupdate.log"; ln -s "$WORK/secret/file.txt" "$SYS/autoupdate.log"
FIXED_SOURCES=("$SYS/autoupdate.log|office/autoupdate.log")
collect sys-link
is "as root, a link where the update log is expected brings nothing into the bundle" "$([ -e "$OUT/office/autoupdate.log" ] && echo copied || echo 'not copied') $(count "$OUT" 'SECRET-')" 'not copied 0'
ln -s "$WORK/secret/folder" "$SYS/a-folder-link"; FIXED_SOURCES=("$SYS/a-folder-link|office/autoupdate.log")
collect sys-folder-link
is "as root, a link to a folder there is not copied whole either" "$(count "$OUT" 'SECRET-')" 0
is "and the log says that the update log was not copied, and why" "$(grep -c '^  not copied: it is not a plain file: ' "$WORK/sys-link/Excel_Diagnostics_collect_20990102_030405/collection.log")" 1
# The system's report folder, as root: a report there is copied; a second name for a file from elsewhere is listed
# by its name and then not copied; and one whose name says nothing is not even asked what its text holds.
printf 'SECRET-THAT-NAMES Microsoft Excel\n' > "$WORK/secret/names-excel.txt"
new "$SYS_REPORTS/Microsoft system report.ips" '{"bug_type":"309","MADE-UP-SYSTEM-REPORT":1}'
ln "$WORK/secret/names-excel.txt" "$SYS_REPORTS/Microsoft second-name.ips"; ln "$WORK/secret/names-excel.txt" "$SYS_REPORTS/quiet-name.ips"
FIXED_SOURCES=(); SYS_ROOTS=("$SYS_REPORTS" "${SYS_LOGS[@]}")
collect sys-reports
is "as root, a report in the system's folder is copied" "$(count "$OUT/reports" 'MADE-UP-SYSTEM-REPORT')" 1
is "as root, a second name there for a file from elsewhere is not copied, and nothing of its text is learned" "$(count "$OUT" 'SECRET-') $(grep -c '^  1 report(s) were listed and not copied, each because it is not in its folder under that name only$' "$LOG")" '0 1'
# A file exchanged for a link, over and over, while the files are being copied
mkdir -p "$SYS/race" "$F/race"
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do new "$SYS/race/r$n.log" 'MADE-UP-RACED'; done
( end=$((SECONDS + 4)); while [ $SECONDS -lt $end ]; do
      for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
          ln -sf "$WORK/secret/file.txt" "$SYS/race/r$n.log" 2>/dev/null; rm -f "$SYS/race/r$n.log"; printf 'MADE-UP-RACED\n' > "$SYS/race/r$n.log"
      done
  done ) &
swapper=$!
end=$((SECONDS + 3)); i=0
while [ $SECONDS -lt $end ]; do
    for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do i=$((i + 1)); copy_file "$SYS/race/r$n.log" "$F/race/$i"; done
done
kill "$swapper" 2>/dev/null; wait "$swapper" 2>/dev/null
is "as root, a file exchanged for a link while it is copied never brings the link's file in" "$(count "$F/race" 'SECRET-')" 0
is "and files were copied meanwhile" "$([ "$(count "$F/race" 'MADE-UP-RACED')" -gt 0 ] && echo some || echo none)" 'some'
AM_ROOT=0
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"

# ---- the program that takes on the user's rights -------------------------------------------------------------------
drop() { plain_perl -e "$AS_USER_PL" -- - 20 "$@"; }
is "it runs a command as the user named" "$(drop "$(id -u)" "$(id -g)" "$(id -G)" /usr/bin/id -u) $?" "$(id -u) 0"
is "arguments reach the command as they are" "$(drop "$(id -u)" "$(id -g)" "$(id -G)" /bin/echo -e '$(x)' "two words")" '-e $(x) two words'
drop 0 0 "0" /usr/bin/true;                                       is "it refuses to run anything as root" "$?" 126
drop "$(id -u)x" "$(id -g)" "$(id -G)" /usr/bin/true;             is "it refuses a user id that is not a number" "$?" 126
drop "$(id -u)" "$(id -g)" "0; x" /usr/bin/true;                  is "it refuses a group list that is not numbers" "$?" 126
drop "$(id -u)" "$(id -g)" "$(id -G)";                            is "it refuses to run nothing" "$?" 126
drop "$(id -u)" "$(id -g)" "$(id -G)" /nonexistent/command 2>/dev/null; is "a command that is not there" "$?" 127
drop $(( $(id -u) + 1 )) "$(id -g)" "$(id -G)" /usr/bin/touch "$WORK/ran-as-someone-else"
is "it runs nothing when it did not become the user named" "$? $([ -e "$WORK/ran-as-someone-else" ] && echo ran || echo 'did not run')" '126 did not run'
set -- $(id -G)
if [ $# -gt 1 ]; then
    shift; drop "$(id -u)" "$(id -g)" "$(id -g) ${*:2}" /usr/bin/true
    is "it runs nothing while it holds a group that is not on the list" "$?" 126
fi
( exec 5> "$WORK/screen.out"; drop "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'echo WRITTEN-BY-THE-COMMAND >&5' 2>/dev/null )
is "the command cannot write to the screen this script keeps for itself" "$(cat "$WORK/screen.out")" ''
is "the command cannot read what this script is reading from" "$(echo typed | drop "$(id -u)" "$(id -g)" "$(id -G)" /bin/cat)" ''
# timed SECONDS COMMAND... - run it, and end it when it is still going after SECONDS (status 99): a time limit that
# has stopped working must fail a check, not hold the test up. The lengths of the sleeps below are this run's own,
# so that they can be told from those of another run of this test at the same time.
timed() {
    local secs=$1 n=0 pid; shift
    "$@" & pid=$!
    while kill -0 "$pid" 2>/dev/null && [ $n -lt $((secs * 4)) ]; do sleep 0.25; n=$((n + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null; pkill -9 -f "sh 3[123]\.[0-9]$$" 2>/dev/null; pkill -9 -f "sleep 3[123]\.[0-9]$$" 2>/dev/null
        wait "$pid" 2>/dev/null; return 99
    fi
    wait "$pid"
}
SECONDS=0; timed 12 plain_perl -e "$AS_USER_PL" -- - 2 "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'sleep "$1"; echo late' sh "31.7$$"
is "a command that does not finish is stopped at the time limit" "$? $([ $SECONDS -le 6 ] && echo 'in time' || echo "after $SECONDS s")" '124 in time'
sleep 0.3; is "and nothing it started is left running" "$(pgrep -f "sleep 31.7$$" | wc -l | tr -d ' ')" 0
SECONDS=0; timed 12 plain_perl -e "$AS_USER_PL" -- - 2 "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'kill -STOP $$; sleep "$1"' sh "32.9$$"
is "a command that its user has stopped is ended at the time limit too" "$? $([ $SECONDS -le 6 ] && echo 'in time' || echo "after $SECONDS s")" '124 in time'
sleep 0.3; is "and it is gone" "$(pgrep -f "sleep 32.9$$" | wc -l | tr -d ' ')" 0
# A helper that its KILL does not end (one the kernel holds, on a volume that no longer answers, say; here a kill that
# does not reach it stands in for that) holds the runner no more than a few seconds past its limit, and its time is
# still written down
SECONDS=0; timed 15 "${PERL_CMD[@]}" -e 'BEGIN { *CORE::GLOBAL::kill = sub { return 1 if $_[0] eq "KILL"; CORE::kill(@_) } }' -e "$AS_USER_PL" -- "$WORK/held.ledger" 2 "$(id -u)" "$(id -g)" "$(id -G)" /bin/sleep "33.7$$"
is "a helper that its KILL does not end holds the runner only a few seconds past its limit, and its time is written down" "$? $([ $SECONDS -le 10 ] && echo 'in time' || echo "after $SECONDS s") $([ -s "$WORK/held.ledger" ] && echo written || echo 'not written')" '124 in time written'
pkill -f "sleep 33.7$$" 2>/dev/null
# What the helper writes reaches the reader through pipes of the runner's own, so a program that still holds the
# helper's end once the runner has ended does not hold the reader (here one that left the helper's process group, which
# stands in for one the kernel holds)
SECONDS=0; timed 15 /bin/sh -c '"$@" | /bin/cat > "$0"' "$WORK/held.out" "${PERL_CMD[@]}" -e "$AS_USER_PL" -- - 20 "$(id -u)" "$(id -g)" "$(id -G)" \
    /bin/sh -c '/usr/bin/perl -e "setpgrp(0, 0); sleep 40" "$1" & sleep 0.5; echo answered' sh "33.8$$"
is "a program the helper left holding its output does not hold whatever reads it" "$? $([ $SECONDS -le 10 ] && echo 'in time' || echo "after $SECONDS s") $(cat "$WORK/held.out" 2>/dev/null)" '0 in time answered'
pkill -f "33.8$$" 2>/dev/null
( trap '' INT; exec "${PERL_CMD[@]}" -e "$AS_USER_PL" -- - 20 "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'sleep 2; echo finished' ) > "$WORK/ignored.out" 2>&1 &
pid=$!; sleep 0.7; kill -INT "$pid" 2>/dev/null; wait "$pid"
is "an interrupt that its starter had ignored does not end the command (the hand-over must finish)" "$? $(cat "$WORK/ignored.out")" '0 finished'
for s in INT:130 TERM:143 HUP:129 QUIT:131; do
    /usr/bin/perl -e '$SIG{$_} = "DEFAULT" for qw(INT TERM HUP QUIT); exec @ARGV' "${PERL_CMD[@]}" -e "$AS_USER_PL" -- - 20 "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'sleep "$1"' sh "31.5$$" &
    pid=$!; sleep 0.7; kill "-${s%:*}" "$pid" 2>/dev/null; wait "$pid"
    is "an interrupt that was not ignored (${s%:*}) ends the command and what it started" "$? $(sleep 0.3; pgrep -f "sleep 31.5$$" | wc -l | tr -d ' ')" "${s#*:} 0"
done
drop "$(id -u)" "$(id -g)" "$(id -G)" /bin/sh -c 'kill -TERM $$'
is "a command ended by a signal is not taken for one that succeeded" "$?" 143
is "a command is not given the folder root keeps its temporary files in, which it could not write to" "$(TMPDIR="$WORK/roots-temporary-files" drop "$(id -u)" "$(id -g)" "$(id -G)" /usr/bin/env | grep -c '^TMPDIR=')" 0
# More groups than one process can hold: the list is cut, and a group that was cut is one the command may not hold.
# The list given here puts made-up groups before the caller's own until one of the caller's falls off the end.
set -- $(id -G)
if [ $# -ge 2 ]; then
    pad=""; n=$#; while [ $n -lt 17 ]; do pad="$pad 9999$n"; n=$((n + 1)); done
    drop "$(id -u)" "$1" "$1 $pad ${*:2}" /usr/bin/true
    is "it keeps as many groups as one process can hold, and runs nothing while holding one it did not keep" "$?" 126
    pad=""; n=0; while [ $n -lt 16 ]; do pad="$pad $1"; n=$((n + 1)); done
    drop "$(id -u)" "$1" "$pad ${*:2}" /usr/bin/true
    is "a group named many times is counted once" "$?" 0
fi
AM_ROOT=1; USER_UID=""; as_user /usr/bin/true;                    is "as root, an unknown console user means no command is run" "$?" 126
USER_UID=$(id -u); USER_GID=$(id -g); USER_GROUPS=$(id -G)
as_user /usr/bin/true;                                            is "as root, with the user known, the command is run as that user" "$?" 0
USER_READS=0; as_user /usr/bin/true;                              is "as root, once the rights could not be taken on, no command is run" "$?" 126
USER_READS=1; OUT="$WORK/limit/bundle"; STAGE="$WORK/limit"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
AS_LIMIT=1 timed 12 as_user /bin/sleep "33.3$$"; first=$?; SECONDS=0; AS_LIMIT=1 timed 12 as_user /bin/sleep "33.3$$"; second=$?
is "a step stopped at its limit is said in the log and in the status table" "$first $(grep -c 'stopped after 1 seconds without finishing: sleep (run with the console user.s rights). Nothing more is read' "$LOG") $(grep -c "^time_limit${TAB}failed${TAB}a step run with the console user's rights was stopped after 1 seconds; nothing more was read" "$MANIFEST")" '124 1 1'
is "and after it nothing more is run with the user's rights: a user who stops every helper cannot hold the run up helper by helper" "$second $([ $SECONDS -le 1 ] && echo 'at once' || echo "after $SECONDS s")" '126 at once'
COPY_SHUT=0; copy_dir "$USER_HOME/Library/Logs" "$OUT/refused"
is "a folder that is then not read is said to be that, not to be missing" "$? $COPY_SHUT $(grep -c '^  not read: nothing is read with the console user.s rights at this point of the run (see the status table): ' "$LOG") $(grep -c '^  not found: ' "$LOG")" '1 1 1 0'
WORKBOOK="$USER_HOME/Library/Logs/plain.log"; collect_workbook_metadata; WORKBOOK=""
is "nor is a workbook" "$(head -c 23 "$OUT/case/workbook_metadata.txt") $(grep -c "^workbook_metadata${TAB}skipped${TAB}whether a plain file is at the path was not answered: nothing is read with the console user's rights at this point of the run\$" "$MANIFEST")" 'Workbook not looked at: 1'
HOME_SHUT=0; rm -f "$STAGE/.limit"
AS_LIMIT=1 AS_WHAT="a made-up job" timed 12 as_user /bin/sleep "33.3$$"; HOME_SHUT=0; rm -f "$STAGE/.limit"
AS_LIMIT=1 AS_PATH="$USER_HOME/Library/Logs/plain.log" timed 12 as_user /bin/sleep "33.3$$"; HOME_SHUT=0; rm -f "$STAGE/.limit"
is "a step stopped is named by what it was for, or by the file it was reading" "$(grep -c 'without finishing: a made-up job (run with' "$LOG") $(grep -c "without finishing: reading $USER_HOME/Library/Logs/plain.log (run with" "$LOG")" '1 1'
# The time spent on helpers run with the user's rights is added up. Past the time allowed in all, nothing more is run:
# a helper held just short of its own limit, then the next, would otherwise hold the run for as long as that user likes.
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"; : > "$LOG"; : > "$MANIFEST"
USER_SECONDS=2; rcs=""; for i in 1 2 3 4; do as_user /bin/sleep 0.8; rcs="$rcs $?"; done; USER_SECONDS=1800
is "past the time allowed for all helpers run with the user's rights, nothing more is run, and that is said once" "$rcs $(grep -c 'seconds allowed for everything run with the console user.s rights are used up' "$LOG") $(grep -c "^time_limit${TAB}failed${TAB}the 2 seconds allowed" "$MANIFEST")" ' 0 0 0 126 1 1'
HOME_SHUT=0; rm -f "$STAGE/.user_time" "$STAGE/.limit"; USER_SECONDS=1; SECONDS=0; as_user /bin/sleep 3; rc=$?; USER_SECONDS=1800
is "and a helper is given no more time than is left of that" "$rc $([ $SECONDS -le 2 ] && echo 'in time' || echo "after $SECONDS s")" '124 in time'
# Once nothing more is read with the user's rights, what the bundle then says of the home folder must not be that a
# source is missing, a setting off, or a step complete: none of it was looked at
rm -f "$STAGE/.user_time"; : > "$STAGE/.limit"
OUT="$WORK/limit/closed"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
( collect_office; discover_sources; collect_reports; write_source_catalog ) > /dev/null 2>&1
is "the catalog says a home source was not looked at, not that it is missing" "$(awk -F'\t' '$1 == "Excel internal diagnostics" || $1 == "User diagnostic reports" { print $2 }' "$OUT/source_catalog.tsv" | sort -u)" 'not looked at when this list was made (see the status table)'
is "and that verbose logging is not known, not that it is off" "$(awk -F'\t' '$1 == "Excel verbose support logging" { print $2 }' "$OUT/source_catalog.tsv") | $(grep -c 'CustomerLoggingEnabled): not known' "$OUT/office/office_prefs.txt")" "not known: $XL/Library/Preferences/com.microsoft.Excel.plist was not read: nothing is read with the console user's rights at this point of the run | 1"
is "the steps that read the home folder are not called complete" "$(awk -F'\t' '$1 ~ /^(office|discovered_sources|reports|source_catalog)$/ { print $1 "=" $2 }' "$MANIFEST" | sort | tr '\n' ' ')" 'discovered_sources=incomplete office=incomplete reports=incomplete source_catalog=incomplete '
is "the lists say which folders were not read" "$(grep -c ': not read (nothing is read with the console user.s rights' "$OUT/office/autorecover_inventory.txt") $(grep -c ': not read (nothing is read' "$OUT/reports/report_listing.txt")" '2 2'
is "and the preferences file says they were not read" "$(grep -c '^(not read: nothing is read with the console user.s rights' "$OUT/office/office_prefs.txt")" 1
# The same when the user's rights could not be taken on at all (no time limit was reached): nothing is called complete
HOME_SHUT=0; rm -f "$STAGE/.limit"; USER_READS=0
OUT="$WORK/limit/never"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
( collect_office; discover_sources; collect_reports; write_source_catalog ) > /dev/null 2>&1
is "when the user's rights could not be taken on, the steps that read the home folder are not called complete either" "$(awk -F'\t' '$1 ~ /^(discovered_sources|source_catalog)$/ { print $1 "=" $2 }' "$MANIFEST" | sort | tr '\n' ' ')" 'discovered_sources=incomplete source_catalog=incomplete '
USER_READS=1
# A console user that cannot be looked up (no user id) as root: nothing in the home folder is read, and that is said
OUT="$WORK/limit/nouid"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
( KEEP=$USER_UID; USER_UID=""; USER_READS=1; rights_check > /dev/null 2>&1; echo "$USER_READS" > "$WORK/nouid.reads" )
is "a console user with no user id, as root: nothing in the home folder is read, and the status table says so" "$(cat "$WORK/nouid.reads") $(grep -c "^user_files${TAB}skipped" "$MANIFEST")" '0 1'
# The check of the user's rights goes by how its helper ended. One that gave no answer (stopped by its user and then
# held to its time limit, or killed) says nothing of the rights: no more is read with them, and that is what is said.
# One that ran and answered with another account id, or that was not run, is rights that could not be taken on.
RC_LINES=$(bounded "$(sed -n '/^rights_check() {/,/^}$/p' "$SCRIPT")" 40 '^}$' | sed -e "s#/usr/bin/id -u#$WORK/fake-id#" -e 's/lim=10$/lim=2/')
[ -n "$RC_LINES" ] || bad "could not take the rights check out of $SCRIPT"
for v in 'held:kill -STOP $$; exec /usr/bin/id -u' 'killed:kill -KILL $$' 'other:echo 99999' 'plain:exec /usr/bin/id -u'; do
    printf '#!/bin/sh\n%s\n' "${v#*:}" > "$WORK/fake-id"; chmod +x "$WORK/fake-id"
    OUT="$WORK/limit/rights-${v%%:*}"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
    ( HOME_SHUT=0; USER_READS=1; rm -f "$STAGE/.limit" "$STAGE/.user_time"; eval "$RC_LINES"; rights_check > /dev/null 2>&1; echo "$USER_READS $HOME_SHUT" > "$OUT/state" )
done
rm -f "$STAGE/.limit" "$STAGE/.user_time"; HOME_SHUT=0
said_in() { cat "$1/collection.log" "$1/manifest.tsv" 2>/dev/null | grep -c -e "$2"; }
is "a rights check held to its time limit says that, and not that the rights could not be taken on" "$(cat "$WORK/limit/rights-held/state") $(said_in "$WORK/limit/rights-held" 'was stopped at its 2-second time limit without an answer') $(said_in "$WORK/limit/rights-held" 'Could not take on\|could not act as')" '1 1 1 0'
is "a rights check whose helper was killed says that, and not that the rights could not be taken on" "$(cat "$WORK/limit/rights-killed/state") $(said_in "$WORK/limit/rights-killed" 'ended with status 137 without an answer') $(said_in "$WORK/limit/rights-killed" 'Could not take on\|could not act as')" '1 1 1 0'
is "a rights check answered with another id is rights that could not be taken on" "$(cat "$WORK/limit/rights-other/state") $(said_in "$WORK/limit/rights-other" '^Could not take on the rights') $(said_in "$WORK/limit/rights-other" "^user_files${TAB}skipped${TAB}could not act as the console user")" '0 0 1 1'
is "and a rights check that was answered says nothing" "$(cat "$WORK/limit/rights-plain/state") $(cat "$WORK/limit/rights-plain/collection.log" "$WORK/limit/rights-plain/manifest.tsv" | wc -l | tr -d ' ')" '1 0 0'
OUT="$WORK/limit/bundle"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"
# A file not read because reading with the user's rights had stopped is its own answer from copy_file, and reports
# listed and then not read for that reason are said to be that, not gone
rm -f "$STAGE/.user_time"; : > "$STAGE/.limit"
copy_file "$USER_HOME/Library/Logs/plain.log" "$WORK/limit/not-read.log"
is "a file not read because reading with the user's rights had stopped" "$? $([ -e "$WORK/limit/not-read.log" ] && echo left || echo 'nothing left')" '7 nothing left'
HOME_SHUT=0; rm -f "$STAGE/.limit"
eval "real_copy_file() $(declare -f copy_file | tail -n +2)"
copy_file() { return 7; }
KEEP_SR=$SYS_REPORTS; SYS_REPORTS="$WORK/no-such-reports"
OUT="$WORK/limit/half"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
( collect_reports ) > /dev/null 2>&1
is "reports listed and then not read because reading stopped are said to be that, not gone" "$(grep -c "report(s) were listed and not read, each because nothing is read with the console user's rights at this point of the run" "$LOG") $(grep -c 'it was not there' "$LOG")" '1 0'
SYS_REPORTS=$KEEP_SR; eval "copy_file() $(declare -f real_copy_file | tail -n +2)"; unset -f real_copy_file
# The ledger is written through what was opened at the start: a link put at its name while a helper runs is not
# written through when the helper ends
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"; printf 'UNTOUCHED' > "$WORK/ledger-target"
( as_user /bin/sleep 1.5 ) & pid=$!
sleep 0.6; mv "$STAGE/.user_time" "$STAGE/.user_time.was"; ln -s "$WORK/ledger-target" "$STAGE/.user_time"; wait "$pid"
is "a link put at the ledger's name while a helper runs is not written through" "$(cat "$WORK/ledger-target") $([ "$(stat -f '%z' "$STAGE/.user_time.was")" -ge 150 ] && echo 'counted in the ledger it opened' || echo 'not counted')" 'UNTOUCHED counted in the ledger it opened'
rm -f "$STAGE/.user_time" "$STAGE/.user_time.was"
# Every helper counts at least three hundredths of a second, however quick it is: what starting it costs
for i in 1 2 3 4 5; do as_user /usr/bin/true; done
is "every helper counts for something in the ledger, however quick" "$([ "$(stat -f '%z' "$STAGE/.user_time")" -ge 15 ] && echo yes || echo no)" yes
# A helper that ends and leaves something of its own behind: that is ended too, and does not hold a pipe of root's
# Without root a step of the hand-over has no time limit of its own, so a hand-over that was stopped names only its budget
( AM_ROOT=0; GAVE_UP=""; mover=as_user; : > "$WORK/said.txt"; gave_up; cat "$WORK/said.txt" ) > "$WORK/gave-up.txt" 2>&1
is "without root, a stopped hand-over names only the seconds allowed for all its steps" "$(cat "$WORK/gave-up.txt")" "The hand-over was stopped: the 3600 seconds allowed for all of its steps were used up."
# During the hand-over the mark that closes the home is not looked at: the working folder is the user's by then
rm -f "$STAGE/.user_time"; : > "$STAGE/.limit"; AS_HANDOVER=1 as_user /usr/bin/true; a=$?; as_user /usr/bin/true; b=$?; rm -f "$STAGE/.limit"
is "during the hand-over the mark in the working folder is not looked at" "$a $b $(sed -n '/^deliver() {/,/^}$/p' "$SCRIPT" | grep -c 'AS_HANDOVER=1')" '0 126 1'
# Twenty times: a program of the group that is starting another just then must not leave that one behind either
i=0; left_behind="ran in time 0"
while [ $i -lt 20 ] && [ "$left_behind" = "ran in time 0" ]; do
    i=$((i + 1)); HOME_SHUT=0; rm -f "$STAGE/.user_time" "$STAGE/.limit" "$WORK/left-behind.ran"; SECONDS=0
    AS_LIMIT=60 as_user /bin/sh -c ': > "$1"; ( /bin/sleep 20; echo LATE ) & kill -KILL $$' sh "$WORK/left-behind.ran" | cat > "$WORK/left-behind.txt"
    rc=${PIPESTATUS[0]}
    left_behind="$([ -e "$WORK/left-behind.ran" ] && echo ran || echo "not run (status $rc, ledger $(stat -f %z "$STAGE/.user_time" 2>/dev/null), limit mark $([ -e "$STAGE/.limit" ] && echo there || echo none))") $([ $SECONDS -le 5 ] && echo 'in time' || echo "after $SECONDS s") $(grep -c LATE "$WORK/left-behind.txt")"
done
is "what a helper leaves behind in its group is ended with it (twenty times)" "$left_behind" 'ran in time 0'
pkill -f '/bin/sleep 20' 2>/dev/null
# As root the workbook's facts are read by helpers with a time limit of their own: none is left running behind the step
# (the file has a name of this run's own, so that only its own helpers are held and counted)
HOME_SHUT=0; rm -f "$STAGE/.user_time" "$STAGE/.limit"; mkdir -p "$OUT/case"; HELD="$WORK/held-$$-book.xlsx"; : > "$HELD"
# The helper that reads its Spotlight facts is held: the test runs, in its place, one that stops itself
eval "_held_real() $(declare -f plain_perl | tail -n +2)"
plain_perl() { if [ "$2" = "$AS_USER_PL" ] && [ "$9" = /usr/bin/mdls ]; then _held_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c 'kill -STOP $$' sh "$HELD"; return; fi; _held_real "$@"; }
WORKBOOK="$HELD"; SECONDS=0; workbook_facts > /dev/null 2>&1; WORKBOOK=""
eval "plain_perl() $(declare -f _held_real | tail -n +2)"; unset -f _held_real; sleep 0.3
is "the workbook's facts, with a helper held by its user: the step ends in time, and no helper of it is left running" "$([ $SECONDS -le 15 ] && echo 'in time' || echo "after $SECONDS s") $(pgrep -f "held-$$-book" | wc -l | tr -d ' ')" 'in time 0'
pkill -9 -f "held-$$-book" 2>/dev/null
HOME_SHUT=0; rm -f "$STAGE/.limit"; OUT="$WORK/limit/bundle"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"

AM_ROOT=0; USER_READS=1

# ---- handing the results over ---------------------------------------------------------------------------------------
# stage NAME - a staging folder holding a bundle folder, a zip and a checksum
stage() {
    STAGE="$WORK/$1/stage"; DEST="$WORK/$1/dest"; NAME=Excel_Diagnostics_hang_20990102_030405
    mkdir -p "$STAGE/$NAME" "$DEST"; echo bundle > "$STAGE/$NAME/summary.md"; echo zip > "$STAGE/$NAME.zip"; echo sum > "$STAGE/$NAME.zip.sha256"
}
# The working folder holds the folder of root's temporary files too, with one left in it: it goes with the rest
stage clean; mkdir "$STAGE/.tmp"; : > "$STAGE/.tmp/.bsdsort.1.0"; deliver
is "hand-over: all three arrive" "$WHERE $(ls "$DEST" | tr '\n' ' ') $([ -e "$STAGE" ] && echo 'stage left' || echo 'stage gone')" "$DEST $NAME $NAME.zip $NAME.zip.sha256  stage gone"
stage missing; rmdir "$DEST"; deliver
is "hand-over: a destination that is not there yet is made" "$WHERE $(ls "$DEST" | wc -l | tr -d ' ')" "$DEST 3"
stage link-at-zip; echo untouched > "$WORK/victim.txt"; ln -s "$WORK/victim.txt" "$DEST/$NAME.zip"; deliver
is "hand-over: a link in the way of the zip is not written through, and nothing is moved" "$(cat "$WORK/victim.txt") $WHERE $(ls "$STAGE" | wc -l | tr -d ' ')" "untouched $STAGE 3"
stage link-at-folder; mkdir "$WORK/victim-folder"; ln -s "$WORK/victim-folder" "$DEST/$NAME"; deliver
is "hand-over: a link in the way of the folder is not followed" "$(ls "$WORK/victim-folder" | wc -l | tr -d ' ') $WHERE" "0 $STAGE"
stage dangling; ln -s "$WORK/nowhere" "$DEST/$NAME.zip.sha256"; deliver
is "hand-over: a link to nowhere in the way is not written through either" "$([ -e "$WORK/nowhere" ] && echo made || echo 'not made') $WHERE" "not made $STAGE"
stage folder-in-the-way; mkdir "$DEST/$NAME"; deliver
is "hand-over: a folder of the same name is not moved into" "$(ls "$DEST/$NAME" | wc -l | tr -d ' ') $WHERE" "0 $STAGE"
stage no-destination; rmdir "$DEST"; echo file > "$DEST"; deliver
is "hand-over: a destination that is not a folder" "$WHERE $(cat "$DEST")" "$STAGE file"

root_only /;                 is "only root's: the top of the disk" "$?" 0
root_only /usr/bin;          is "only root's: a system folder" "$?" 0
root_only "$WORK";           is "not only root's: a folder of one's own" "$?" 1
root_only /private/tmp;      is "not only root's: the shared temporary folder" "$?" 1
root_only "$WORK/nowhere";   is "not only root's: a folder that is not there" "$?" 1
root_only /etc;              is "only root's: a link that root made to a folder of root's" "$?" 0
root_only usr/bin;           is "not only root's: a path that does not start at the top" "$?" 1
root_only /Users/Shared;     is "not only root's: a shared folder that anyone can put a name in" "$?" 1
root_only /tmp;              is "not only root's: a link of root's that leads to a shared folder" "$?" 1
# /Applications can be written by every administrator and has no sticky bit: a folder of root's in it can be renamed
if [ -d /Applications/Utilities ] && [ "$(stat -f '%u %Mp%Lp' /Applications 2>/dev/null)" = '0 0775' ]; then
    root_only /Applications/Utilities; is "not only root's: a folder of root's inside one that others can write to and rename in" "$?" 1
fi
# Inside such a folder, a folder of root's is root's alone: nobody else can rename or remove it there. One is looked
# for on this Mac; without one there is nothing to check this with.
d=$(find /Users/Shared /Library/Caches -maxdepth 1 -mindepth 1 -type d -user 0 ! -perm +022 2>/dev/null | while IFS= read -r x; do
        /bin/ls -lde "$x" 2>/dev/null | grep -q ' allow ' || { echo "$x"; break; }
    done)
if [ -n "$d" ]; then root_only "$d"; is "only root's: a folder of root's inside a shared folder with the sticky bit" "$?" 0; fi
ln -s /usr/bin "$WORK/link-to-roots-folder"
root_only "$WORK/link-to-roots-folder"; is "not only root's: a link that someone else made to a folder of root's" "$?" 1
mkdir -p "$WORK/home2"; ln -s /usr/bin "$WORK/home2/Desktop"; KEEP_HOME=$USER_HOME; USER_HOME="$WORK/home2"
root_only "$USER_HOME/Desktop"; is "not only root's: the user's Desktop made a link to a folder of root's" "$?" 1
# /etc is a link that root made to /private/etc, so one folder there has two names: each is tried as the home
USER_HOME=/etc; root_only /etc/ssh;         is "not only root's: a folder in the console user's home, by the path as written" "$?" 1
USER_HOME=/private/etc; root_only /etc/ssh; is "not only root's: a folder in the console user's home, by where the path leads" "$?" 1
USER_HOME="$WORK/home2"; root_only /etc/ssh; is "only root's: the same folder when it is in nobody's home" "$?" 0
USER_HOME="$WORK/home2"

# Who moves the results. As root (AM_ROOT=1, with the test's own account as the console user) every step of the
# hand-over must go through as_user unless the destination is root's alone. The Desktop here is a link the user
# made to a folder of root's: root must not be the one who moves anything there.
AM_ROOT=1; USER_UID=$(id -u); USER_GID=$(id -g); USER_GROUPS=$(id -G)
as_user() { echo "$*" >> "$WORK/as-user.log"; "$@"; }
stage desktop-link; rmdir "$DEST"; DEST="$USER_HOME/Desktop"; : > "$WORK/as-user.log"
deliver 2>/dev/null
is "hand-over to a Desktop that is a link to a folder of root's: the user's hand tries, nothing arrives, and it stops at the first move that fails" "$(grep -c '^/bin/mv -n ' "$WORK/as-user.log") $WHERE $(ls /usr/bin | grep -c Excel_Diagnostics)" "1 $STAGE 0"
stage own-folder; : > "$WORK/as-user.log"; deliver
is "hand-over to a folder of the user's: the user's hand moves all three" "$(grep -c '^/bin/mv -n ' "$WORK/as-user.log") $WHERE" "3 $DEST"
is "and each move is taken as made from mv's answer and a look by the same hand, not by root's own look" "$(grep -c "^/bin/test -e $STAGE/" "$WORK/as-user.log") $(grep -c "^/bin/test -L $STAGE/" "$WORK/as-user.log")" '3 3'
stage cannot-make; rmdir "$DEST"; mkdir "$WORK/cannot-make/closed"; chmod 555 "$WORK/cannot-make/closed"; DEST="$WORK/cannot-make/closed/results"
deliver 2>/dev/null
is "hand-over to a folder that cannot be made: the results stay where they were built" "$WHERE $(ls "$STAGE" | wc -l | tr -d ' ')" "$STAGE 3"
# A destination that is root's alone. The test cannot make one, so root_only is told that one scratch folder is,
# as it would say of a real one: there root moves the results itself, makes what is not there yet, changes no
# owner, and the scratch files of the run do not keep the working folder from going.
root_only() { [ -d "$1" ] || return 1; case "$1" in "$WORK/roots"|"$WORK/roots"/*) return 0 ;; esac; return 1; }
chown() { echo "chown $*" >> "$WORK/chown.log"; }
mkdir -p "$WORK/roots"; stage roots; rmdir "$DEST"; DEST="$WORK/roots/not/there/yet"
: > "$WORK/as-user.log"; : > "$WORK/chown.log"; : > "$STAGE/.limit"; : > "$STAGE/.user_time"; echo 1 > "$STAGE/.pid"; : > "$STAGE/.search_stopped"; : > "$STAGE/.found"
deliver
is "hand-over to a folder of root's: root moves, makes the folder, changes no owner, and the working folder goes" "$(wc -l < "$WORK/as-user.log" | tr -d ' ') $(wc -l < "$WORK/chown.log" | tr -d ' ') $WHERE $(ls "$DEST" 2>/dev/null | wc -l | tr -d ' ') $([ -e "$STAGE" ] && echo 'stage left' || echo 'stage gone')" "0 0 $DEST 3 stage gone"
unset -f chown; eval "$REAL_ROOT_ONLY"
# The hand-over's own time limits, as the user's hand is given them. A move is given an hour, or what is left of the
# hand-over's hour when that is less: the steps before it take a second off it whenever one of them crosses a second.
as_user() { echo "${AS_LIMIT:-none} $1" >> "$WORK/as-user.log"; "$@"; }
stage limits; : > "$WORK/as-user.log"; deliver
is "the user's hand has a time limit at each step of the hand-over, a long one for the move" "$(grep -c '^60 /bin/mkdir$' "$WORK/as-user.log") $(grep -c -E '^(3600|359[0-9]) /bin/mv$' "$WORK/as-user.log") $(grep -c -v -E -e '^60 ' -e '^(3600|359[0-9]) /bin/mv$' "$WORK/as-user.log")" '1 3 0'
# A step of the hand-over that its user stops. By then the working folder is that user's, so they can put links in it
# where root's own files were: collection.log, manifest.tsv, and the mark that a time limit was reached. The real
# as_user is used, with the first step it runs made to stop itself at a limit of 2 seconds. Root must write through
# none of the links, and the hand-over must stop there with nothing more moved.
eval "$REAL_AS_USER"
eval "real_plain_perl() $(declare -f plain_perl | tail -n +2)"
# stop-at holds which of the steps run with the user's rights is the one that stops (1 is the first)
plain_perl() {
    local n
    [ "$2" = "$AS_USER_PL" ] && [ -e "$WORK/stop-at" ] && { n=$(cat "$WORK/stop-at"); echo $((n - 1)) > "$WORK/stop-at"; }
    if [ "$n" = 1 ]; then
        rm -f "$WORK/stop-at"
        ln -s "$WORK/outside-log.txt" "$STAGE/$NAME/collection.log"; ln -s "$WORK/outside-manifest.txt" "$STAGE/$NAME/manifest.tsv"
        ln -s "$WORK/outside-new-file" "$STAGE/.limit"
        real_plain_perl -e "$AS_USER_PL" -- - 2 "$6" "$7" "$8" /bin/sh -c 'kill -STOP $$'
        return
    fi
    real_plain_perl "$@"
}
printf 'ORIGINAL-LOG\n' > "$WORK/outside-log.txt"; printf 'ORIGINAL-MANIFEST\n' > "$WORK/outside-manifest.txt"
stage stopped-hand-over; OUT="$STAGE/$NAME"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$WORK/said.txt"; echo 1 > "$WORK/stop-at"
deliver
is "a stopped step of the hand-over: root writes through none of the links the user put in the working folder" "$(cat "$WORK/outside-log.txt") $(cat "$WORK/outside-manifest.txt") $([ -e "$WORK/outside-new-file" ] && echo made || echo 'not made')" 'ORIGINAL-LOG ORIGINAL-MANIFEST not made'
is "and the hand-over stops there, with nothing moved, and says so on the screen" "$WHERE $(ls "$DEST" | wc -l | tr -d ' ') $(grep -c '^The hand-over was stopped: a step run with the console user.s rights did not finish within its time limit, or the 3600 seconds allowed for all of them were used up\.$' "$WORK/said.txt")" "$STAGE 0 1"
# The third step asks whether something is in the way of the bundle folder: stopped there, nothing is moved either
rm -f "$WORK/outside-log.txt" "$WORK/outside-manifest.txt"; printf 'ORIGINAL-LOG\n' > "$WORK/outside-log.txt"; printf 'ORIGINAL-MANIFEST\n' > "$WORK/outside-manifest.txt"
stage stopped-later; OUT="$STAGE/$NAME"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$WORK/said.txt"; echo 3 > "$WORK/stop-at"
deliver
is "stopped at the step that asks what is in the way, the hand-over moves nothing and writes through no link" "$WHERE $(ls "$DEST" | wc -l | tr -d ' ') $(cat "$WORK/outside-log.txt") $(grep -c '^The hand-over was stopped' "$WORK/said.txt")" "$STAGE 0 ORIGINAL-LOG 1"
# The first move that is stopped at its limit: the hand-over stops there, says so, and moves nothing after it
stage stopped-move; : > "$WORK/said.txt"; echo 9 > "$WORK/stop-at"
deliver
is "a move stopped at its limit ends the hand-over: the rest stays, and it is said" "$WHERE ${#MOVED[@]} $(ls "$STAGE" | grep -c -e '\.zip$' -e '\.sha256$') $(grep -c '^The hand-over was stopped' "$WORK/said.txt")" "$STAGE 0 2 1"
# The user renames the working folder away just before the first step: nothing is moved, and the hand-over does not
# say that it moved anything (each of the three is taken as moved only when its own move says so)
plain_perl() { if [ -e "$WORK/rename-stage" ] && [ "$2" = "$AS_USER_PL" ]; then rm -f "$WORK/rename-stage"; mv "$STAGE" "$STAGE.elsewhere"; fi; real_plain_perl "$@"; }
stage renamed-away; : > "$WORK/said.txt"; : > "$WORK/rename-stage"
deliver
is "the working folder renamed away during the hand-over: nothing is taken as moved" "$WHERE ${#MOVED[@]} ${#NOT_MOVED[@]} $(ls "$DEST" | wc -l | tr -d ' ')" "$STAGE 0 3 0"
# The first step that is asked what is in the way does not answer yes or no (refused: 126): nothing is moved
plain_perl() { if [ -e "$WORK/refuse-at" ] && [ "$2" = "$AS_USER_PL" ]; then local n; n=$(cat "$WORK/refuse-at"); echo $((n - 1)) > "$WORK/refuse-at"; [ "$n" = 1 ] && { rm -f "$WORK/refuse-at"; return 126; }; fi; real_plain_perl "$@"; }
stage refused-in-the-way; : > "$WORK/said.txt"; echo 3 > "$WORK/refuse-at"
deliver
is "a step that asks what is in the way and gets no answer: nothing is moved" "$WHERE $(ls "$DEST" | wc -l | tr -d ' ')" "$STAGE 0"
eval "plain_perl() $(declare -f real_plain_perl | tail -n +2)"; unset -f real_plain_perl
# The steps share one budget: with 2 seconds for all of them, a step held for longer than what is left is stopped
eval "_plain_perl_real() $(declare -f plain_perl | tail -n +2)"
plain_perl() { if [ -e "$WORK/slow-steps-on" ] && [ "$2" = "$AS_USER_PL" ]; then _plain_perl_real -e "$AS_USER_PL" -- - "$5" "$6" "$7" "$8" /bin/sh -c 'sleep 8'; return; fi; _plain_perl_real "$@"; }
stage slow-steps; : > "$WORK/said.txt"; : > "$WORK/slow-steps-on"; SECONDS=0; HAND_OVER_SECONDS=2
deliver; HAND_OVER_SECONDS=3600; rm -f "$WORK/slow-steps-on"
is "the steps of the hand-over share one budget: past it, the hand-over stops" "$WHERE $(grep -c '^The hand-over was stopped' "$WORK/said.txt") $([ $SECONDS -le 4 ] && echo 'in time' || echo "after $SECONDS s")" "$STAGE 1 in time"
eval "plain_perl() $(declare -f _plain_perl_real | tail -n +2)"; unset -f _plain_perl_real
AM_ROOT=0; USER_HOME=$KEEP_HOME
eval "$REAL_AS_USER"

# ---- the end of a run ------------------------------------------------------------------------------------------------
# fin NAME COMMANDS - package and hand over a made-up bundle, with COMMANDS run first; prints the status the script
# would end with. In a shell of its own: the step switches interrupts off for whoever runs it.
fin() {
    ( exec 5>/dev/null; stage "$1"; OUT="$STAGE/$NAME"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$MANIFEST"
      rm -f "$STAGE/$NAME.zip" "$STAGE/$NAME.zip.sha256"
      FINALIZED=""; REDACT=0; REDACT_STATE=""; REDACT_EXCEPT=""; COPY_LOST=0; COPY_ODD=0; COPY_BIG=0; COPY_SHUT=0; LIST_ODD=0
      eval "$2"; finalize > /dev/null 2>&1; echo "$FINAL_STATUS" )
}
is "a run ends with 0 when the zip is where it was asked for" "$(fin fin-ok '') $(ls "$WORK/fin-ok/dest" 2>/dev/null | wc -l | tr -d ' ')" '0 3'
is "with 4 when the results could not be moved there" "$(fin fin-stuck 'rmdir "$DEST"; echo file > "$DEST"')" 4
is "with 1 when no zip could be made" "$(: > "$WORK/said.txt"; fin fin-no-zip 'ditto() { return 1; }')" 1
is "and the last lines say where what was collected went, from what its move answered" "$(grep -c "^Packaging FAILED, so there is no zip to send\. What was collected, Excel_Diagnostics_hang_20990102_030405, was moved to $WORK/fin-no-zip/dest (see collection.log there)\.\$" "$WORK/said.txt")" 1
is "with 3 when names were to be hidden and were not all" "$(fin fin-names 'REDACT=1; redact_bundle() { REDACT_STATE=incomplete; }')" 3
fin fin-rows 'COPY_LOST=2; COPY_SHUT=1; LIST_ODD=3' > /dev/null
is "what the copies and lists left out is in the status table" "$(grep -c "^folder_copies${TAB}incomplete${TAB}2 file(s) did not arrive, 1 folder(s) could not be read or counted, " "$WORK/fin-rows/dest/Excel_Diagnostics_hang_20990102_030405/manifest.tsv") $(grep -c "^lists${TAB}incomplete${TAB}3 name(s)" "$WORK/fin-rows/dest/Excel_Diagnostics_hang_20990102_030405/manifest.tsv")" '1 1'
is "and nothing of it when nothing was left out" "$(grep -c -e '^folder_copies' -e '^lists' "$WORK/fin-ok/dest/Excel_Diagnostics_hang_20990102_030405/manifest.tsv")" 0
# The last word of a run that moved some of the three and not the rest names where each one is. Here the zip cannot
# be moved (it is marked unchangeable as soon as it is made): the folder and the zip are, and the checksum is not.
: > "$WORK/said.txt"
fin fin-partial 'record_status() { printf "%s\t%s\t%s\n" "$1" "$2" "$3" >> "$MANIFEST"; [ "$1" = zip ] && chflags uchg "$STAGE/$NAME.zip.sha256"; }' > "$WORK/fin-partial.status"
chflags nouchg "$WORK/fin-partial/stage/Excel_Diagnostics_hang_20990102_030405.zip.sha256" 2>/dev/null
is "a run that ends with 4 has no last line that starts with Done" "$(grep -c '^Done' "$WORK/said.txt")" 0
is "some moved and some not: the status says so, and each is said to have been moved, or where it was before the hand-over" "$(cat "$WORK/fin-partial.status") $(grep -c "^Moved to $WORK/fin-partial/dest: Excel_Diagnostics_hang_20990102_030405 Excel_Diagnostics_hang_20990102_030405.zip\.$" "$WORK/said.txt") $(grep -c "^NOT moved to $WORK/fin-partial/dest: Excel_Diagnostics_hang_20990102_030405.zip.sha256\." "$WORK/said.txt") $(grep -c "^Not all of the results were moved to $WORK/fin-partial/dest (see above)\. The file to send to IT, Excel_Diagnostics_hang_20990102_030405.zip, was moved to $WORK/fin-partial/dest; its checksum, Excel_Diagnostics_hang_20990102_030405.zip.sha256, was in $WORK/fin-partial/stage before the hand-over began\.$" "$WORK/said.txt")" '4 1 1 1'

# An interrupt when whoever was reading the script's output has gone (output passed through a pipe to a program
# that the same Ctrl-C ended): the first thing the interrupt does is write to the screen, and that write must not
# be what ends the script before it has packaged anything.
cat > "$WORK/pipe-trap.sh" <<'TRAP_TEST'
W=$2; exec 5>&1 6>&2; MODE=hang; note() { echo "$*"; }; finalize() { echo reached > "$W/packaged-after-pipe"; FINAL_STATUS=0; }
watch_row() { :; }; stop_groups() { :; }
line=$(sed -n '/^trap .\[ -n "\$IN_TRAP" \] || { IN_TRAP=1; trap "" PIPE; .bin.echo >&5 2>.dev.null || exec 5>.dev.null 6>.dev.null; exec 1>&5 2>&6; /p' "$1"); eval "$line"
sleep 0.5; kill -INT $$; sleep 2
TRAP_TEST
/usr/bin/perl -e '$SIG{PIPE} = "DEFAULT"; $SIG{INT} = "DEFAULT"; exec @ARGV' /bin/bash "$WORK/pipe-trap.sh" "$SCRIPT" "$WORK" 2>/dev/null | true
is "an interrupt with nobody left to read the screen still packages what there is, and nothing meant for the screen ends up in a file" "$(cat "$WORK/packaged-after-pipe" 2>/dev/null)" 'reached'
# Ctrl-\ (QUIT) is an interrupt like Ctrl-C: what there is is packaged. And once packaging has begun, it is ignored.
sed -e 's/kill -INT \$\$/kill -QUIT $$/' -e 's/packaged-after-pipe/packaged-after-quit/' "$WORK/pipe-trap.sh" > "$WORK/quit-trap.sh"
/usr/bin/perl -e '$SIG{QUIT} = "DEFAULT"; exec @ARGV' /bin/bash "$WORK/quit-trap.sh" "$SCRIPT" "$WORK" > /dev/null 2>&1
is "Ctrl-\\ during collection packages what there is too" "$(cat "$WORK/packaged-after-quit" 2>/dev/null)" 'reached'
# (In a shell of its own, started with Ctrl-\ not ignored: a shell started in the background ignores it from the start,
# and could then never show that packaging ignores it.)
cat > "$WORK/quit-finalize.sh" <<'QUIT_TEST'
eval "$(sed -n '/^finalize() {/,/^}$/p' "$1")"
STAGE="$2/quit-finalize"; NAME=bundle; OUT="$STAGE/$NAME"; DEST=$STAGE; mkdir -p "$OUT"; LOG=/dev/null; MANIFEST=/dev/null
COPY_LOST=0; COPY_ODD=0; COPY_BIG=0; COPY_SHUT=0; COPY_LONG=0; LIST_ODD=0; REDACT=0; VIEWER_URL=nowhere
record_status() { :; }; note() { :; }; say() { :; }; ditto() { return 1; }; deliver() { WHERE=$DEST; MOVED=(); NOT_MOVED=(); }
write_summary() { kill -QUIT $$; sleep 0.3; }
finalize; echo "went on"
QUIT_TEST
is "while packaging, Ctrl-\\ is ignored" "$(/usr/bin/perl -e '$SIG{QUIT} = "DEFAULT"; exec @ARGV' /bin/bash "$WORK/quit-finalize.sh" "$SCRIPT" "$WORK" 2>/dev/null)" 'went on'
# A TERM that comes as packaging begins, before its first row is written: packaging goes on, and is not cut short by
# an interrupt handling that finds it begun. (The real handling is used, with what it calls stood in for.)
cat > "$WORK/term-finalize.sh" <<'TERM_TEST'
eval "$FIN_LINES"; eval "$TRAP_LINE"
STAGE="$1/term-finalize"; NAME=bundle; OUT="$STAGE/$NAME"; DEST=$STAGE; mkdir -p "$OUT"; LOG=/dev/null; MANIFEST=/dev/null; exec 5>/dev/null 6>/dev/null
COPY_LOST=1; COPY_ODD=0; COPY_BIG=0; COPY_SHUT=0; COPY_LONG=0; LIST_ODD=0; REDACT=0; VIEWER_URL=nowhere; MODE=collect
record_status() { /bin/sleep 1; }; note() { :; }; say() { :; }; ditto() { return 1; }; deliver() { WHERE=$DEST; MOVED=(); NOT_MOVED=(); }
stop_groups() { :; }; watch_row() { :; }; write_summary() { echo packaged; }
( /bin/sleep 0.3; kill -TERM $$ ) &
finalize
TERM_TEST
TRAP_LINE=$(bounded "$(grep '^trap .\[ -n "\$IN_TRAP" \] || {' "$SCRIPT")" 1 "INT TERM HUP QUIT\$")
[ -n "$TRAP_LINE" ] || bad "could not take the interrupt handling out of $SCRIPT"
x=$(FIN_LINES=$(declare -f finalize) TRAP_LINE=$TRAP_LINE /usr/bin/perl -e '$SIG{TERM} = "DEFAULT"; exec @ARGV' /bin/bash "$WORK/term-finalize.sh" "$WORK" 2>/dev/null; echo "status $?")
is "a TERM as packaging begins does not stop the packaging" "$(echo $x)" 'packaged status 0'
# What the run keeps as it goes is never taken from the environment it was started with: a REPRO_LOG_PID given there
# would be signalled, and a FINALIZED given there would leave the run unpackaged
RESET=$(bounded "$(sed -n '/^unset IN_TRAP FINALIZED /,/[^\\]$/p' "$SCRIPT")" 4 '[^\\]$')
is "the run's own state is cleared before it is used" "$(for v in IN_TRAP FINALIZED FINAL_STATUS REDACT_EXCEPT REPRO_FINISHED REPRO_LOG_PID REPRO_WATCH_PID REPRO_STREAM_STARTED WATCH_LIVE; do printf '%s\n' "$RESET" | tr ' \\' '\n\n' | grep -c -x "$v"; done | tr -d '\n')" '111111111'
is "the help says which signals end a run with 130" "$(grep -c '^# stopped, once collecting had begun, by an interrupt, a TERM signal or a hangup (Ctrl-C, Ctrl-\\, the Terminal$' "$SCRIPT")" 1

# ---- working folders that earlier runs left -----------------------------------------------------------------------
mkdir -p "$STAGE_BASE/excel_diag.Mine000001" "$STAGE_BASE/excel_diag.Left000001" "$STAGE_BASE/excel_diag.Live000001" "$STAGE_BASE/excel_diag.Dead000001" \
         "$STAGE_BASE/excel_diag.Old0000001" "$STAGE_BASE/excel_diag.odd name" "$WORK/elsewhere"
ln -s "$WORK/elsewhere" "$STAGE_BASE/excel_diag.Link000001"; : > "$STAGE_BASE/excel_diag.File000001"
( : ) & wait $!; gone=$!
echo $$ > "$STAGE_BASE/excel_diag.Live000001/.pid"; echo "$gone" > "$STAGE_BASE/excel_diag.Dead000001/.pid"
echo $$ > "$STAGE_BASE/excel_diag.Old0000001/.pid"; touch -t 200001010000 "$STAGE_BASE/excel_diag.Old0000001/.pid"
STAGE="$STAGE_BASE/excel_diag.Mine000001"; : > "$WORK/said.txt"
earlier_runs
is "working folders that earlier runs left are named: one with no run, one whose run is gone, one from before the Mac last started" "$(grep -c "^A folder named like this script's working folders is in $STAGE_BASE: .*, owned by this account, last changed [0-9-]* [0-9:]*\\. Keep it or delete it\\.$" "$WORK/said.txt") $(grep -c -e 'Left000001' -e 'Dead000001' -e 'Old0000001' "$WORK/said.txt")" '3 3'
mkdir -p "$STAGE_BASE/excel_diag.Held000001/Excel_Diagnostics_hang_20990102_030405"; : > "$WORK/said.txt"; earlier_runs
is "one that holds something named like a bundle says so" "$(grep -c 'Held000001, .* It holds something named Excel_Diagnostics_\*\. Keep it' "$WORK/said.txt")" 1
# A .pid that is not a few bytes is not read: one that claims a gigabyte would otherwise be scanned to its end
dd if=/dev/zero of="$STAGE_BASE/excel_diag.Left000001/.pid" bs=1 count=0 seek=1073741824 2>/dev/null
SECONDS=0; : > "$WORK/said.txt"; earlier_runs
is "a .pid that is not a few bytes is not read" "$([ $SECONDS -le 2 ] && echo 'at once' || echo "after $SECONDS s") $(grep -c 'Left000001' "$WORK/said.txt")" 'at once 1'
rm -f "$STAGE_BASE/excel_diag.Left000001/.pid"; rm -rf "$STAGE_BASE/excel_diag.Held000001"
mkdir -p "$WORK/many"; KEEP_BASE=$STAGE_BASE; STAGE_BASE="$WORK/many"
i=0; while [ $i -lt 60 ]; do i=$((i + 1)); mkdir "$STAGE_BASE/excel_diag.Many$i"; done
: > "$WORK/said.txt"; earlier_runs
is "of many folders like these, five are named, and how many there are in all is said" "$(grep -c '^A folder named like' "$WORK/said.txt") $(grep -c "^In all, 60 folders in $STAGE_BASE owned by this account are named like this script's working folders (this run's own among them); 5 of them are named above\.$" "$WORK/said.txt")" '5 1'
STAGE_BASE=$KEEP_BASE
is "this run's own, one whose run is still going, a link, a file and a name this script does not make are not" "$(grep -c -e 'Mine000001' -e 'Live000001' -e 'Link000001' -e 'File000001' -e 'odd name' "$WORK/said.txt")" 0
# The same folders seen by someone else: the test cannot make a folder of another account, so it makes itself
# another account. Not root, they are not that one's to mention; as root, they are when they are the console user's.
id() { if [ "$1" = -u ] && [ $# -eq 1 ]; then echo 4242424; else command id "$@"; fi; }
: > "$WORK/said.txt"; AM_ROOT=0; earlier_runs
is "working folders of another account are not named" "$(grep -c '^A folder named like' "$WORK/said.txt")" 0
mkdir -p "$STAGE_BASE/excel_diag.Held000002/Excel_Diagnostics_hang_20990102_030405"
: > "$WORK/said.txt"; AM_ROOT=1; USER_UID=$(command id -u); earlier_runs
is "as root, those of the console user are named, and their .pid is not read: nobody but that user can have put it there" "$(grep -c "^A folder named like this script's working folders is in .*, owned by $CONSOLE_USER, " "$WORK/said.txt") $(grep -c 'Live000001' "$WORK/said.txt")" '5 1'
is "and they are not looked into: only who owns one and when it last changed are said" "$(grep -c 'Held000002, owned by .*\. Keep it or delete it\.$' "$WORK/said.txt") $(grep -c 'It holds' "$WORK/said.txt")" '1 0'
rmdir "$STAGE_BASE/excel_diag.Held000002/Excel_Diagnostics_hang_20990102_030405" "$STAGE_BASE/excel_diag.Held000002"
# The look itself has a time limit: a folder there can be where a volume that no longer answers is mounted
eval "_rl_real() $(declare -f run_limited | tail -n +2)"; run_limited() { case "$*" in *'/usr/bin/find '*excel_diag*) return 124 ;; esac; _rl_real "$@"; }
: > "$WORK/said.txt"; earlier_runs
eval "run_limited() $(declare -f _rl_real | tail -n +2)"; unset -f _rl_real
is "a look for earlier folders that is stopped at its limit is said to be that" "$(grep -c "^The look in $STAGE_BASE for folders named like this script's working folders was stopped after 30 seconds, so there can be more than are named here\.\$" "$WORK/said.txt")" 1
unset -f id; AM_ROOT=0

# ---- answers that are neither yes nor no ----------------------------------------------------------------------------
# A helper that its user kills (or that ends some other way) is not a time limit and not a refusal: what is said of it
# is that it ended without an answer. A helper is made to end itself the way a kill would end it.
AM_ROOT=1; USER_UID=$(id -u); USER_GID=$(id -g); USER_GROUPS=$(id -G); USER_READS=1
OUT="$WORK/answers/bundle"; STAGE="$WORK/answers"; mkdir -p "$OUT/case" "$OUT/office"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
eval "_ans_real() $(declare -f plain_perl | tail -n +2)"
# KILL_CMD names the command whose helper ends itself with KILL; SLOW_CMD the one whose helper takes 12 seconds.
# FAKES holds patterns for the whole command a helper runs, and FAKE_WHAT one for what it is for (AS_WHAT): a helper
# that matches runs FAKE_RUN instead (a kill of itself when that is not set).
# FAKE_FROM and FAKE_TO swap a piece of text in what a helper is given to run (one program inside it, say).
FAKES=(); FAKE_WHAT=""; FAKE_RUN=""; FAKE_FROM=""; FAKE_TO=""; LIMITS_LOG=""
plain_perl() {
    local f a args=()
    [ -n "$LIMITS_LOG" ] && [ "$2" = "$AS_USER_PL" ] && echo "$5 ${*:9}" >> "$LIMITS_LOG"      # the time limit each helper is given
    if [ "$2" = "$AS_USER_PL" ] && [ -n "$KILL_CMD" ] && [ "$9" = "$KILL_CMD" ]; then _ans_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c 'kill -KILL $$'; return; fi
    if [ "$2" = "$AS_USER_PL" ] && [ -n "$FAKE_FROM" ]; then
        for a in "${@:9}"; do args+=("${a//"$FAKE_FROM"/$FAKE_TO}"); done
        _ans_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" "${args[@]}"; return
    fi
    if [ "$2" = "$AS_USER_PL" ]; then
        for f in ${FAKES[@]+"${FAKES[@]}"}; do
            case "${*:9}" in $f) _ans_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c "${FAKE_RUN:-kill -KILL \$\$}"; return ;; esac
        done
        if [ -n "$FAKE_WHAT" ]; then
            case "$AS_WHAT" in $FAKE_WHAT) _ans_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c "${FAKE_RUN:-kill -KILL \$\$}"; return ;; esac
        fi
    fi
    if [ "$2" = "$AS_USER_PL" ] && [ -n "$SLOW_CMD" ] && [ "$9" = "$SLOW_CMD" ]; then _ans_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c 'sleep 12'; return; fi
    _ans_real "$@"
}
KILL_CMD=/bin/test; copy_dir "$USER_HOME/Library/Logs" "$OUT/killed"; KILL_CMD=""
is "a folder whose look was killed is said to be that, not missing and not refused" "$(grep -c '^  not read: the program that looked for it ended without an answer (status 137): ' "$LOG") $(grep -c "nothing is read with the console user's rights" "$LOG")" '1 0'
KILL_CMD=/usr/bin/env; copy_file "$USER_HOME/Library/Logs/plain.log" "$WORK/answers/killed.log"; rc=$?; KILL_CMD=""
is "a file whose reader was killed: its own answer" "$rc" 8
KILL_CMD=/bin/test; ( write_source_catalog ) > /dev/null 2>&1; KILL_CMD=""
is "the catalog says of a source whose look was killed that it is not known" "$(awk -F'\t' '$1 == "Excel internal diagnostics" { print $2 }' "$OUT/source_catalog.tsv")" 'not known: the program that looked for it ended without an answer'
is "and none of that closes the home folder" "$([ -e "$STAGE/.limit" ] && echo closed || echo open)" open
# The workbook: a part that was not read is said, and the row is not complete. A workbook slow to answer ends only its
# own step: the home folder stays open for the rest of the run.
: > "$WORK/answers/book.xlsx"; WORKBOOK="$WORK/answers/book.xlsx"
KILL_CMD=/usr/bin/mdls; workbook_facts > /dev/null 2>&1; KILL_CMD=""
is "the workbook's Spotlight facts not read: said in the file, and the row is incomplete" "$(grep -c '^Spotlight facts: not read: mdls ended without an answer (status 137)$' "$OUT/case/workbook_metadata.txt") $(grep -c "^workbook_metadata${TAB}incomplete${TAB}metadata only; workbook not copied; its Spotlight facts were not read$" "$MANIFEST")" '1 1'
: > "$MANIFEST"; SECONDS=0; SLOW_CMD=/bin/test; workbook_facts > /dev/null 2>&1; SLOW_CMD=""
is "a workbook slow to answer: its step ends in time, says so, and the home folder stays open" "$([ $SECONDS -le 12 ] && echo 'in time' || echo "after $SECONDS s") $(grep -c "^workbook_metadata${TAB}skipped" "$MANIFEST") $([ -e "$STAGE/.limit" ] && echo closed || echo open) $(as_user /usr/bin/true; echo $?)" 'in time 1 open 0'
# mdls's own answer is its own, and a status that is not its own is said as what it is. What mdls says when it fails is
# not kept: it names the path, which can hold anything, line breaks among it
: > "$MANIFEST"; FAKES=('/usr/bin/mdls *'); FAKE_RUN='echo "mdls: could not find it."; echo "kMDItemFSSize = 999" >&2; exit 1'; workbook_facts > /dev/null 2>&1
is "mdls's own answer is not said to be no answer, and its own words are not kept" "$(grep -c '^Spotlight facts: not read: mdls ended with status 1$' "$OUT/case/workbook_metadata.txt") $(grep -c 'without an answer' "$OUT/case/workbook_metadata.txt") $(grep -c -e '^mdls: could not find it.$' -e 999 "$OUT/case/workbook_metadata.txt")" '1 0 0'
FAKE_RUN='exit 126'; workbook_facts > /dev/null 2>&1
is "mdls not run is said to be not read" "$(grep -c "^Spotlight facts: not read: nothing is read with the console user's rights at this point of the run$" "$OUT/case/workbook_metadata.txt") $(grep -c 'without an answer' "$OUT/case/workbook_metadata.txt")" '1 0'
: > "$MANIFEST"; FAKES=('/usr/bin/stat -L -f Modified*'); FAKE_RUN='echo "stat: MADE-UP-STAT-WORDS" >&2; exit 1'; workbook_facts > "$WORK/answers/stat-said.txt" 2>&1; FAKES=(); FAKE_RUN=""
is "a workbook whose dates were not read: said in fixed words, stat's own words go nowhere" "$(grep -c '^Modified and Bytes: not read: stat ended with status 1$' "$OUT/case/workbook_metadata.txt") $(grep -c MADE-UP-STAT-WORDS "$OUT/case/workbook_metadata.txt" "$WORK/answers/stat-said.txt" "$LOG" | awk -F: '{ s += $NF } END { print s }')" '1 0'
: > "$MANIFEST"; FAKES=('/usr/bin/stat -L -f Modified*'); FAKE_RUN=""; workbook_facts > /dev/null 2>&1; FAKES=()
is "a workbook whose dates were not read: said in the file, and the row is incomplete" "$(grep -c '^Modified and Bytes: not read: stat ended without an answer (status 137)$' "$OUT/case/workbook_metadata.txt") $(grep -c "^workbook_metadata${TAB}incomplete${TAB}metadata only; workbook not copied; its dates and size were not read$" "$MANIFEST")" '1 1'
WORKBOOK=""; pkill -f 'sleep 12' 2>/dev/null
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"

# The lists of the office step: a look, a list or a read that ends without an answer is said to be that in the list,
# and counted for the step's row; none of it is said to be a refusal
KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=("$USER_HOME/Library/Logs/plain.log|office/plain.log")
: > "$LOG"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; new "$OFFICE_GC/User Content/Startup/Excel/madeup.xlam" 'x'
FAKES=('/bin/test -d */Library/Application Support/Microsoft' '/bin/sh -c * */Preferences/AutoRecovery -type f ( -iname*'
       '/bin/test -d */User Content/Add-Ins' '/bin/sh -c * */User Content/Startup/Excel -maxdepth 3 *' '/usr/bin/plutil -p *'
       "/usr/bin/env *$USER_HOME/Library/Logs/plain.log*")
( collect_office; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; FAKES=()
A="$OUT/office/autorecover_inventory.txt"
is "an AutoRecover folder whose look was killed is said to be that" "$(grep -c '^=== .*/Library/Application Support/Microsoft: not read (the program that looked for it ended without an answer, status 137)$' "$A") $(grep -c "nothing is read with the console user's rights" "$A")" '1 0'
is "an AutoRecover list whose program was killed says that it stops there" "$(grep -c '^(The list stops here: the program that made it ended without an answer, status 137.)$' "$A") $(grep -c 'MADE-UP-RECOVERY\|Budget (AutoRecovered)' "$A") $(grep -c 'a list stops early: the program that made it ended without an answer (status 137): .*/Preferences/AutoRecovery$' "$LOG")" '1 0 1'
is "an add-in folder whose look was killed is said to be that" "$(grep -c '^=== .*/User Content/Add-Ins: not read (the program that looked for it ended without an answer, status 137)$' "$OUT/office/addins.txt")" 1
is "an add-in list whose program was killed says that it stops there" "$(grep -c '^(The list stops here: the program that made it ended without an answer, status 137.)$' "$OUT/office/addins.txt") $(grep -c 'madeup.xlam' "$OUT/office/addins.txt")" '1 0'
is "an add-in folder's list says what it takes" "$(grep -c '^Each entry in it, the folder itself among them, at most three levels down, in the order find gives them (one with a control or invisible character in the name or path is not listed)\. Modified | bytes | path$' "$OUT/office/addins.txt")" "$(grep '^=== ' "$OUT/office/addins.txt" | grep -c -v ': not read (')"
rm -rf "$OFFICE_GC/User Content"
is "preferences whose reader was killed are said to be that" "$(grep -c '^(not read: the program that read them ended without an answer, status 137)$' "$OUT/office/office_prefs.txt")" 1
is "a fixed file whose reader was killed is said to be that" "$(grep -c '^  not read: the program reading it ended without an answer: .*/Library/Logs/plain.log$' "$LOG")" 1
is "and each of the six counts for the step's row, which is then not complete, and says why" "$(cat "$WORK/answers/n") $(grep -c "^office${TAB}incomplete${TAB}versions, Excel logs, AutoRecover, add-ins, preferences; 6 program(s) run with the console user's rights ended without an answer, so what they were to read may be missing (see collection.log)\$" "$MANIFEST")" '6 1'
is "no row is written as complete except by row, which decides it from the step's own counts" "$(grep -c -E 'record_status +[^ ]+ +"?complete"?( |$)' "$SCRIPT") $(sed -n '/^row() {/,/^}$/p' "$SCRIPT" | grep -c 'record_status "$1" complete "$2"')" '1 1'
is "and none of that closes the home folder" "$([ -e "$STAGE/.limit" ] && echo closed || echo open)" open
FIXED_SOURCES=("${KEEP_FIXED[@]}")

# The reports step, the same way
: > "$LOG"; rm -rf "$OUT/reports"
FAKES=('/bin/test -d */Logs/DiagnosticReports/Retired' '/bin/ls -ltq */Logs/DiagnosticReports' '/bin/sh -c * sh */Logs/DiagnosticReports *'
       '/usr/bin/env *CrashReporter/Microsoft Excel_0F1E2D3C.plist*')
( collect_reports; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; FAKES=()
L="$OUT/reports/report_listing.txt"
is "a report folder whose look was killed is said to be that" "$(grep -c '^=== .*/Logs/DiagnosticReports/Retired: not read (the program that looked for it ended without an answer, status 137)$' "$L") $(grep -c "nothing is read with the console user's rights" "$L")" '1 0'
is "a report listing whose program was killed says that it stops there" "$(grep -c '^(The list stops here: the program that made it ended without an answer, status 137.)$' "$L")" 1
is "the list of reports to copy, killed, is said to be that" "$(grep -c '^  the list of reports to copy from .*/Logs/DiagnosticReports ended without an answer (status 137), so reports in it may not all be copied$' "$LOG") $(ls "$OUT/reports/user_Library_Logs_DiagnosticReports" 2>/dev/null | wc -l | tr -d ' ')" '1 0'
is "a force-quit record whose reader was killed is said to be that" "$(grep -c '^  1 file(s) of .*/CrashReporter were listed and not read, each because the program reading it ended without an answer$' "$LOG")" 1
is "and each counts for the reports row" "$(cat "$WORK/answers/n")" 4
: > "$LOG"; rm -rf "$OUT/reports"
FAKES=("/usr/bin/env *$R0/Microsoft Excel-2099-01-02-030405.ips*")
( collect_reports; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; FAKES=()
is "a report whose reader was killed is said to be that, and counted" "$(grep -c '^  1 report(s) were listed and not read, each because the program reading it ended without an answer$' "$LOG") $(cat "$WORK/answers/n")" '1 1'
is "a long listing is not cut by head, which would end ls before its end" "$(sed -n '/^collect_reports() {/,/^}$/p' "$SCRIPT" | grep -c '/bin/ls -ltq "$dir" 2>&1 | head')" 0

# The search for other log files: a search that is killed, and one stopped at its limit, are not complete
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
FAKES=("/bin/sh -c * $USER_HOME/* ( -name *.app -o -name *.framework ) -prune *" "/bin/sh -c * $USER_HOME/Documents -maxdepth 3 *")
( discover_sources ) > /dev/null 2>&1; FAKES=()
is "two killed searches are said to be that, and the row is not complete" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}[0-9]* found, [0-9]* copied[^;]*; office/discovered_sources.tsv; .*the search of the home folder ended without an answer (status 137); the search of the Documents folder ended without an answer (status 137)" "$MANIFEST") $(grep -c '^  the search of the home folder ended without an answer (status 137); the search of the Documents folder ended without an answer (status 137), so there can be more that it did not reach$' "$LOG")" '1 1'
: > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
FAKE_WHAT='the search of the Documents folder*'; FAKE_RUN='exit 124'; ( discover_sources ) > /dev/null 2>&1; FAKE_WHAT=""; FAKE_RUN=""
is "a Documents search stopped at its limit makes the row not complete" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}.*; the search was stopped at its time limit" "$MANIFEST")" 1
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
: > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
FAKES=("/usr/bin/env *Something/Data/Library/Logs/found.log*"); ( discover_sources ) > /dev/null 2>&1; FAKES=()
is "a found file whose reader was killed is listed as that" "$(grep -c "^listed only: not read, because the program reading it ended without an answer${TAB}.*/found.log${TAB}\$" "$OUT/office/discovered_sources.tsv")" 1
# Once the home folder is closed, the rest of its files are listed and nothing is made or run for them
: > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
eval "_ans_as_user() $(declare -f as_user | tail -n +2)"
as_user() { local rc; _ans_as_user "$@"; rc=$?; case "$AS_WHAT" in *'search of the home folder'*) : > "$STAGE/.limit" ;; esac; return $rc; }
( discover_sources ) > /dev/null 2>&1
# The same in the reports step: once the home folder is closed, its reports are counted and none is tried
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"; : > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/reports"; : > "$WORK/fetch-home"
eval "_ans_fetch() $(declare -f fetch | tail -n +2)"
fetch() { case "$1" in "$USER_HOME"/*) echo "$1" >> "$WORK/fetch-home" ;; esac; _ans_fetch "$@"; }
as_user() { local rc; _ans_as_user "$@"; rc=$?; [ "$1" = /bin/sh ] && [ "${5-}" = "$R0" ] && : > "$STAGE/.limit"; return $rc; }
( collect_reports ) > /dev/null 2>&1
eval "fetch() $(declare -f _ans_fetch | tail -n +2)"; unset -f _ans_fetch
is "a closed home: its reports are counted as not read, and none is tried" "$(wc -l < "$WORK/fetch-home" | tr -d ' ') $(grep -c "^  [0-9]* report(s) were listed and not read, each because nothing is read with the console user's rights at this point of the run" "$LOG")" '0 1'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"; rm -rf "$OUT/reports"; : > "$WORK/fetch-home"
CR="$USER_HOME/Library/Application Support/CrashReporter"
eval "_ans_fetch() $(declare -f fetch | tail -n +2)"
fetch() { case "$1" in "$USER_HOME"/*) echo "$1" >> "$WORK/fetch-home" ;; esac; _ans_fetch "$@"; }
as_user() { local rc; _ans_as_user "$@"; rc=$?; [ "$1 $2" = "/usr/bin/find $CR" ] && : > "$STAGE/.limit"; return $rc; }
( collect_reports ) > /dev/null 2>&1
eval "fetch() $(declare -f _ans_fetch | tail -n +2)"; unset -f _ans_fetch
is "the same for the force-quit records: none is tried once the home is closed, and they are counted as not read" "$(grep -c CrashReporter "$WORK/fetch-home") $(ls "$OUT/reports/CrashReporter" 2>/dev/null | wc -l | tr -d ' ') $(grep -c "^  [0-9]* file(s) of $CR were listed and not read, each because nothing is read with the console user's rights at this point of the run" "$LOG")" '0 0 1'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
eval "as_user() $(declare -f _ans_as_user | tail -n +2)"; unset -f _ans_as_user
is "a closed home: its files are listed as not read, and no folder is made for them" "$([ "$(grep -c "^listed only: not read, because nothing is read with the console user's rights at this point of the run" "$OUT/office/discovered_sources.tsv")" -ge 3 ] && echo listed || echo 'not listed') $([ -e "$OUT/office/discovered/home" ] && echo 'folders made' || echo 'no folders')" 'listed no folders'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
# The copy of a folder that does not finish: the files it did not get to are not said to be unreadable or gone
FIVE="$USER_HOME/Library/Logs/FiveFiles"; mkdir -p "$FIVE"; for i in 1 2 3 4 5; do printf 'x\n' > "$FIVE/f$i.log"; done
: > "$LOG"; FAKE_WHAT='copying *'; copy_dir "$FIVE" "$OUT/five-killed"; FAKE_WHAT=""
is "a copy that was killed is said to be that, and its files not to be unreadable" "$(grep -c "^  copy ended without an answer (status 137): $FIVE\$" "$LOG") $(grep -c "^  5 file(s) did not arrive because of that: $FIVE\$" "$LOG") $(grep -c 'unreadable or gone' "$LOG")" '1 1 0'
: > "$LOG"; FAKE_WHAT='copying *'; FAKE_RUN='exit 126'; copy_dir "$FIVE" "$OUT/five-refused"; FAKE_WHAT=""; FAKE_RUN=""
is "a copy that was not run is said to be that" "$(grep -c "^  not copied: nothing is read with the console user's rights at this point of the run (see the status table): $FIVE\$" "$LOG") $(grep -c "^  5 file(s) did not arrive because of that: $FIVE\$" "$LOG") $(grep -c 'unreadable or gone' "$LOG")" '1 1 0'
: > "$LOG"; FAKE_WHAT='copying *'; FAKE_RUN='exit 124'; copy_dir "$FIVE" "$OUT/five-stopped"; FAKE_WHAT=""; FAKE_RUN=""
is "a copy stopped at its limit is said to be that" "$(grep -c "^  copy stopped at its time limit (see time_limit in the status table): $FIVE\$" "$LOG") $(grep -c "^  5 file(s) did not arrive because of that: $FIVE\$" "$LOG") $(grep -c 'unreadable or gone' "$LOG")" '1 1 0'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
# A copy that ends with 1 while no fewer files arrived than were counted: those two facts are said, and no cause (a
# file added after the count can stand in for one that did not arrive, since the counts are numbers)
: > "$LOG"; FAKE_FROM='exit "$t"'; FAKE_TO='exit 1'; copy_dir "$FIVE" "$OUT/five-ended-one"; FAKE_FROM=""
is "a copy that ended with 1, with every counted file there, says only that" \
    "$(grep -c "^  the copy ended with status 1, and no fewer files arrived than were counted before it (its messages, when it gave any, are above): $FIVE\$" "$LOG") $(grep -c -i 'changed while\|may be incomplete' "$LOG") $(find "$OUT/five-ended-one" -type f | wc -l | tr -d ' ')" '1 0 5'
: > "$LOG"; FAKE_WHAT='counting the files of *'; FAKE_RUN='exit 126'; copy_dir "$FIVE" "$OUT/five-uncounted"; FAKE_WHAT=""; FAKE_RUN=""
is "a folder whose count was not run is not copied, and is said to be not read" "$(grep -c "^  not read: nothing is read with the console user's rights at this point of the run (see the status table): $FIVE\$" "$LOG") $([ -e "$OUT/five-uncounted" ] && echo made || echo 'not made')" '1 not made'
# One program inside the copy that ends without an answer: find, or the program that picks the names
printf '#!/bin/sh\nkill -KILL $$\n' > "$WORK/killself"; chmod +x "$WORK/killself"
: > "$LOG"; UNANSWERED=0; FAKE_FROM='/usr/bin/find -E . \( -type d'; FAKE_TO="$WORK/killself"' \( -type d'; copy_dir "$FIVE" "$OUT/five-find-killed"; FAKE_FROM=""
is "a copy whose find was killed is said to be that, not unreadable files" "$(grep -c "^  copy ended without an answer (status 137): $FIVE\$" "$LOG") $(grep -c "^  5 file(s) did not arrive because of that: $FIVE\$" "$LOG") $(grep -c 'unreadable or gone' "$LOG") $UNANSWERED" '1 1 0 1'
: > "$LOG"; FAKE_FROM='/usr/bin/env -u PERL5OPT -u PERL_UNICODE'; FAKE_TO="$WORK/killself"; copy_dir "$FIVE" "$OUT/five-pick-killed"; FAKE_FROM=""
is "the same when the program that picks the names was killed" "$(grep -c "^  copy ended without an answer (status 137): $FIVE\$" "$LOG") $(grep -c 'unreadable or gone' "$LOG")" '1 0'
: > "$LOG"; UNANSWERED=0; FAKES=('/bin/test -d */Library/Logs/FiveFiles'); copy_dir "$FIVE" "$OUT/five-look-killed"; FAKES=()
: > "$LOG"; FAKE_WHAT='counting the files of *'; copy_dir "$FIVE" "$OUT/five-count-killed"; FAKE_WHAT=""
is "a look or a count that ended without an answer counts for the step's row" "$UNANSWERED $(grep -c "^  counting its files ended without an answer (status 137): $FIVE\$" "$LOG")" '2 1'
rm -rf "$FIVE"; HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
# Lists and reads stopped at their time limit, and a list of files to copy that was killed
: > "$LOG"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=()
FAKES=('/bin/sh -c * */Preferences/AutoRecovery -type f ( -iname*'); FAKE_RUN='exit 124'
( collect_office ) > /dev/null 2>&1; FAKES=(); FAKE_RUN=""
A="$OUT/office/autorecover_inventory.txt"
is "a list stopped at its limit is said to be that, and so is each one refused after it" "$(sed -n '/^Files whose name holds autorecover/{n;p;}' "$A" | grep -c "^(The list stops here: nothing is read with the console user's rights at this point of the run; see the status table.)\$") $(grep -c 'program that made it ended without an answer' "$A")" '1 0'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
FAKES=('/usr/bin/plutil -p *'); FAKE_RUN='exit 124'; ( collect_office ) > /dev/null 2>&1; FAKES=(); FAKE_RUN=""; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "preferences whose read was stopped at its limit are said to be that" "$(grep -c '^(not read to the end: stopped at its time limit; see the status table)$' "$OUT/office/office_prefs.txt")" 1
# Preferences a few KB long can unfold into gigabytes of text. plutil is given 10 seconds, and the lines found are cut
# at 1 MB, which the file says. (Here plutil is stood in for by 1.8 MB of matching lines.)
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"; : > "$WORK/answers/limits.log"
FAKES=('/usr/bin/plutil -p *'); FAKE_RUN='/usr/bin/yes "\"AutoRecoverMadeUp\" => 1" | /usr/bin/head -n 70000'; LIMITS_LOG="$WORK/answers/limits.log"
FIXED_SOURCES=(); ( collect_office ) > /dev/null 2>&1; FAKES=(); FAKE_RUN=""; LIMITS_LOG=""; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "preferences that unfold past 1 MB of lines: cut there, the file says so, and plutil is given 10 seconds" \
    "$([ "$(wc -c < "$OUT/office/office_prefs.txt")" -lt 1100000 ] && echo cut || echo 'not cut') $(grep -c '^(Cut here: the lines found came to more than 1 MB.)$' "$OUT/office/office_prefs.txt") $(grep -c '^10 /usr/bin/plutil -p ' "$WORK/answers/limits.log")" 'cut 1 1'
# What plutil gives for the switch for verbose logs is cut at 4 KB before root's shell holds it, for every file read
eval "_capped_real() $(declare -f capped | tail -n +2)"; capped() { echo "$1" >> "$WORK/answers/capped.log"; _capped_real "$@"; }
: > "$WORK/answers/capped.log"; FAKES=('/usr/bin/plutil -extract *'); FAKE_RUN='/usr/bin/yes true | /usr/bin/head -c 3000000'
excel_verbose_logging; rc=$?; FAKES=(); FAKE_RUN=""
eval "capped() $(declare -f _capped_real | tail -n +2)"; unset -f _capped_real
is "the switch for verbose logs: each read is cut at 4 KB, and 3 MB of it is not taken for on" "$rc $(grep -c '^4096$' "$WORK/answers/capped.log")" '1 3'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
# The user's file is read for that switch with the user's rights for at most 10 seconds (a few KB of it can make plutil
# take any amount of memory), and a read stopped there is said, where it was stopped and where the switch is given
: > "$WORK/answers/limits.log"; : > "$LOG"; : > "$MANIFEST"; LIMITS_LOG="$WORK/answers/limits.log"; FAKES=('/usr/bin/plutil -extract *'); FAKE_RUN='exit 124'
excel_verbose_logging; rc=$?; x=$(verbose_word $rc); FAKES=(); FAKE_RUN=""; LIMITS_LOG=""
is "the switch for verbose logs is read for at most 10 seconds, and a read stopped there is said" \
    "$rc $(grep -c '^10 /usr/bin/plutil -extract CustomerLoggingEnabled ' "$WORK/answers/limits.log") $(grep -c -F "stopped after 10 seconds without finishing: reading CustomerLoggingEnabled from $XL/Library/Preferences/com.microsoft.Excel.plist (run with" "$LOG") $(grep -c "^time_limit${TAB}failed" "$MANIFEST") | $x" \
    "2 1 1 1 | not known: reading $XL/Library/Preferences/com.microsoft.Excel.plist was stopped at its time limit (see time_limit in the status table)"
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
# The program that cuts the lines of the preferences, killed: said as that, not as a write that failed
: > "$LOG"; : > "$MANIFEST"; FAKES=('/usr/bin/plutil -p *'); FAKE_RUN='/usr/bin/yes "\"AutoRecoverMadeUp\" => 1" | /usr/bin/head -n 70000'
FIXED_SOURCES=(); ( STREAM_PL='sysread(STDIN, my $b, 100); kill "KILL", $$;'; collect_office ) > /dev/null 2>&1; FAKES=(); FAKE_RUN=""; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "the program that cuts the lines of the preferences, killed, is said as that, and no write is said to have failed" \
    "$(grep -c '\]   the program that cut the lines of the Excel preferences ended without an answer (status 137): office/office_prefs.txt$' "$LOG") $(grep -c 'office_prefs.txt could not all be written' "$LOG") $(grep -c "^office${TAB}incomplete${TAB}.*program(s) this script ran with its own rights ended without an answer" "$MANIFEST")" '1 0 1'
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
HOME_SHUT=0; rm -f "$STAGE/.limit" "$STAGE/.user_time"
: > "$MANIFEST"; FAKES=('/usr/bin/mdls *'); FAKE_RUN='exit 124'; : > "$WORK/answers/book.xlsx"; WORKBOOK="$WORK/answers/book.xlsx"; workbook_facts > /dev/null 2>&1; FAKES=(); FAKE_RUN=""; WORKBOOK=""
is "mdls stopped at its limit is said to be that" "$(grep -c '^Spotlight facts: not read: mdls was stopped at its time limit (see collection.log)$' "$OUT/case/workbook_metadata.txt")" 1
# A workbook path that is a link: the dates and size are those of the file it leads to, and the file says where the
# link leads, shown as the path is: a line break and a terminal code in the link's text are spaces. What mdls prints is
# shown that way too.
WT="$WORK/answers/target"$'\n'"kMDItemFSSize = 999"$'\033'"[2J.xlsx"
printf '0123456789' > "$WT"; touch -t 202001020304.05 "$WT"; ln -s "$WT" "$WORK/answers/linked.xlsx"
: > "$MANIFEST"; WORKBOOK="$WORK/answers/linked.xlsx"; workbook_facts > /dev/null 2>&1
W="$OUT/case/workbook_metadata.txt"
is "a workbook that is a link: the dates and size of the file it leads to, and where the link leads, on one line" \
    "$(grep -c '^Bytes: 10$' "$W") $(grep -c '^Modified: 2020-01-02 03:04:05' "$W") $(grep -c -F "Link: the path is a symbolic link to $WORK/answers/target kMDItemFSSize = 999 [2J.xlsx" "$W") $(grep -c '^kMDItemFSSize *= *999' "$W") $(LC_ALL=C tr -d '\n\040-\176' < "$W" | wc -c | tr -d ' ')" '1 1 1 0 0'
FAKES=('/usr/bin/mdls *'); FAKE_RUN='printf "kMDItemFSName = \"a\\033[2Jb\\342\\200\\256c\"\n"'; workbook_facts > /dev/null 2>&1; FAKES=(); FAKE_RUN=""; WORKBOOK=""
is "what mdls prints is shown as a path is" "$(grep -c '^kMDItemFSName = "a \[2Jb c"$' "$W") $(LC_ALL=C tr -d '\n\040-\176' < "$W" | wc -c | tr -d ' ')" '1 0'
: > "$LOG"; rm -rf "$OUT/reports"; FAKES=("/usr/bin/find $USER_HOME/Library/Application Support/CrashReporter -maxdepth 1 -type f ! *")
( collect_reports; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; FAKES=()
is "a list of force-quit records that was killed is said to be that, and counted" "$(grep -c '^  the list of files to copy from .*/CrashReporter ended without an answer (status 137), so they may not all be copied$' "$LOG") $(cat "$WORK/answers/n")" '1 1'
# A force-quit record that unfolds into any amount of text: written out with the user's rights, cut, and in time
python3 -I -c 'import plistlib,sys
a = []
for i in range(40): a = [a, a]
plistlib.dump(a, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$USER_HOME/Library/Application Support/CrashReporter/Microsoft Nested_MADEUP.plist"
: > "$LOG"; rm -rf "$OUT/reports"; SECONDS=0
( collect_reports ) > /dev/null 2>&1 & pid=$!; n=0
while kill -0 "$pid" 2>/dev/null && [ $n -lt 160 ]; do sleep 0.25; n=$((n + 1)); done
if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; pkill -9 -f 'plutil -p -' 2>/dev/null; fi; wait "$pid" 2>/dev/null; took=$SECONDS
TXT="$OUT/reports/CrashReporter/Microsoft Nested_MADEUP.txt"
is "a record that unfolds without end is written out only so far, and in time" "$([ $took -le 25 ] && echo 'in time' || echo "after $took s") $([ "$(stat -f '%z' "$TXT" 2>/dev/null || echo 0)" -le 1100000 ] && echo small || echo large) $(grep -c '^(Cut here: the text of this record came to more than 1 MB.)$\|^(Not written out to its end: stopped at its time limit; see the status table.)$' "$TXT")" 'in time small 1'
is "and the ordinary record is written out whole" "$(grep -c 'MADE-UP-FORCE-QUIT' "$OUT/reports/CrashReporter/Microsoft Excel_0F1E2D3C.txt")" 1
is "plutil reads the records with the user's rights, and never by itself as root" "$(sed -n '/^collect_reports() {/,/^}$/p' "$SCRIPT" | grep -c 'AS_STDIN=1 AS_LIMIT=10 .* as_user /usr/bin/plutil -p - < "\$f"') $(sed -n '/^collect_reports() {/,/^}$/p' "$SCRIPT" | grep -c '^[^#]*[^/]plutil -p "')" '1 0'
HOME_SHUT=0; rm -f "$USER_HOME/Library/Application Support/CrashReporter/Microsoft Nested_MADEUP.plist" "$STAGE/.limit" "$STAGE/.user_time"
# The look for the folders to search: one helper, at most so many folders, and the row says how many were left
i=0; while [ $i -lt 30 ]; do i=$((i + 1)); mkdir -p "$USER_HOME/Library/Containers/com.microsoft.x$i"; done
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
MAX_SEARCH_ROOTS=5; ( discover_sources ) > /dev/null 2>&1; MAX_SEARCH_ROOTS=500
is "the folders the search starts from are at most so many, and the row says how many more there were" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}.*; office/discovered_sources.tsv; [0-9]* of the folders of the home folder named like Microsoft's were not searched (only the first 5 were)" "$MANIFEST")" 1
: > "$MANIFEST"; FAKES=("/bin/sh -c *for f in \"\$home/Library/Containers\"/com.microsoft.*"); ( discover_sources ) > /dev/null 2>&1; FAKES=()
is "a look for those folders that was killed makes the row not complete" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}.*; office/discovered_sources.tsv; .*the look for the folders of the home folder to search ended without an answer (status 137)" "$MANIFEST")" 1
i=0; while [ $i -lt 30 ]; do i=$((i + 1)); rmdir "$USER_HOME/Library/Containers/com.microsoft.x$i"; done
eval "plain_perl() $(declare -f _ans_real | tail -n +2)"; unset -f _ans_real

# The pieces that cap a list: the first records are passed on, all of them are counted, and what was not listed is said
is "most_of passes on the first records and counts them all" "$(printf 'a\0b\0c\0' | most_of 2 nul | tr '\0' ' ')$(found_count) $(printf 'a\nb\nc\n' | most_of 1 line)$(found_count)" 'a b 3 a3'
is "first_lines says how many more lines there were" "$(printf '1\n2\n3\n4\n5\n6\n7\n' | first_lines 5 | tail -2 | tr '\n' ' ')" '5 (2 more are not listed.) '
is "every list of the home folder that could be long is capped that way" "$(grep -c 'drained sort | first_lines 500$' "$SCRIPT") $(grep -c "| first_lines 200\$" "$SCRIPT") $(grep -c '| first_lines 500; st=("${PIPESTATUS\[@\]}"); list_end' "$SCRIPT")" '1 1 1'
# As root without perl nothing outside the home folder is read, and that is said as what it is
mkdir -p "$WORK/sys/Logs/Microsoft"; printf 'MADE-UP-SYS\n' > "$WORK/sys/Logs/Microsoft/fixed.log"
HAVE_PERL=0; copy_file "$WORK/sys/Logs/Microsoft/fixed.log" "$WORK/answers/np.log"; rc=$?
: > "$LOG"; KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=("$WORK/sys/Logs/Microsoft/fixed.log|office/fixed.log")
( collect_office; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; HAVE_PERL=1; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "without perl, root reads nothing, says so, and counts no program as ended without an answer" "$rc $(grep -c "^  not read: /usr/bin/perl is missing, and as root files are read only through it: $WORK/sys/Logs/Microsoft/fixed.log\$" "$LOG") $(cat "$WORK/answers/n")" '10 1 0'
# A write that fails partway: the reader says so with a status of its own, and copy_file passes it on as one that
# could not be written. A root-side reader that ends without an answer is not counted as one run with the user's rights.
dd if=/dev/urandom of="$WORK/sys/Logs/Microsoft/big.log" bs=1024 count=64 2>/dev/null
( trap '' XFSZ; ulimit -S -f 2; "${PERL_CMD[@]}" -e "$FETCH_PL" -- "$WORK/sys/Logs/Microsoft/big.log" "" 0 > "$WORK/answers/cut.out" 2>/dev/null ); fetch_rc=$?
( trap '' XFSZ; ulimit -S -f 2; copy_file "$WORK/sys/Logs/Microsoft/big.log" "$WORK/answers/cut2.out" ); copy_rc=$?
is "a read whose writing fails has its own status, passed on as not written" "$fetch_rc $copy_rc" '6 9'
eval "_real_fetch() $(declare -f fetch | tail -n +2)"; fetch() { case "$1" in "$WORK/sys/"*) return 137 ;; esac; _real_fetch "$@"; }
: > "$LOG"; KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=("$WORK/sys/Logs/Microsoft/fixed.log|office/fixed.log")
( collect_office; echo "$UNANSWERED" > "$WORK/answers/n" ) > /dev/null 2>&1; FIXED_SOURCES=("${KEEP_FIXED[@]}")
eval "fetch() $(declare -f _real_fetch | tail -n +2)"; unset -f _real_fetch
is "a root-side reader that ended without an answer is said, and not counted as the user's" "$(grep -c "^  not read: the program reading it ended without an answer: $WORK/sys/Logs/Microsoft/fixed.log\$" "$LOG") $(cat "$WORK/answers/n")" '1 0'
# A folder of more files and folders than one copy takes
ENT="$USER_HOME/Library/Logs/ManyEntries"; mkdir -p "$ENT"; i=0; while [ $i -lt 60 ]; do i=$((i + 1)); printf 'x\n' > "$ENT/e$i.log"; done
: > "$LOG"; MAX_COPY_FOLDER_ENTRIES=20; copy_dir "$ENT" "$OUT/ent"; MAX_COPY_FOLDER_ENTRIES=50000
is "a copy takes the first so many files and folders, and says so (the folder itself is not counted)" "$(grep -c "^  it holds 60 files and folders that could be copied; the copy took the first 19 that it came to: $ENT\$" "$LOG") $(grep -c "^  41 file(s) did not arrive, left out past the first 19 files and folders, or unreadable or gone before they were read: $ENT\$" "$LOG") $(find "$OUT/ent" -type f | wc -l | tr -d ' ')" '1 1 19'
rm -rf "$ENT"
# A file whose path in the copy would be too long for the working folder and the zip step
DEEP="$USER_HOME/Library/Logs/Deep"; mkdir -p "$DEEP"; printf 'MADE-UP-SHALLOW\n' > "$DEEP/shallow.log"
N200=$(printf '%200s' '' | tr ' ' d)
( cd "$DEEP" && for k in 1 2 3 4 5; do mkdir "$N200" && cd "$N200" || exit 1; done; printf 'x\n' > deep.log )
: > "$LOG"; COPY_LONG=0; copy_dir "$DEEP" "$OUT/deep"
is "a file with a path too long for the copy is left out and counted, and the rest arrives" "$(grep -c "^  1 file(s) were left out: their path in the copy would be longer than 1,000 bytes: $DEEP\$" "$LOG") $COPY_LONG $(cat "$OUT/deep/shallow.log" 2>/dev/null) $(grep -c 'did not arrive\|could not all be written' "$LOG") $(find "$OUT/deep" -name deep.log | wc -l | tr -d ' ')" '1 1 MADE-UP-SHALLOW 0 0'
rm -rf "$DEEP"
# What arrives is cut at what a folder and one more file may hold
BYTES="$USER_HOME/Library/Logs/Bytes"; mkdir -p "$BYTES"; for i in 1 2 3 4; do dd if=/dev/urandom of="$BYTES/b$i.log" bs=1024 count=900 2>/dev/null; done
: > "$LOG"; MAX_COPY_FILE_MB=1; MAX_COPY_FOLDER_MB=1; MAX_COPY_FOLDER_ENTRIES=10; copy_dir "$BYTES" "$OUT/bytes"; MAX_COPY_FILE_MB=1024; MAX_COPY_FOLDER_MB=4096; MAX_COPY_FOLDER_ENTRIES=50000
is "a copy that comes to more than a folder may hold is cut, and that is said" "$(grep -c "^  the copy was cut once 2 MB had arrived, and the last file to arrive may be cut short: $BYTES\$" "$LOG") $(grep -c "did not arrive, left out once the copy was cut, or unreadable or gone before they were read: $BYTES\$" "$LOG")" '1 1'
rm -rf "$BYTES"
# A working folder that cannot take more: nothing is said to be unreadable or gone that was not
if hdiutil create -size 4m -fs HFS+ -volname EDTEST -layout NONE "$WORK/small.dmg" > /dev/null 2>&1 && mkdir -p "$WORK/small" \
    && hdiutil attach "$WORK/small.dmg" -mountpoint "$WORK/small" -nobrowse > /dev/null 2>&1; then
    FULL8="$USER_HOME/Library/Logs/Full"; mkdir -p "$FULL8"; for i in 1 2 3 4 5 6 7 8; do dd if=/dev/urandom of="$FULL8/f$i.log" bs=1024 count=600 2>/dev/null; done
    KEEP_STAGE=$STAGE; STAGE="$WORK/small"; : > "$LOG"
    copy_dir "$FULL8" "$WORK/small/copy" 2> "$WORK/answers/full-said.txt"
    copy_file "$FULL8/f1.log" "$WORK/small/one.log" 2>> "$WORK/answers/full-said.txt"; rc=$?
    STAGE=$KEEP_STAGE
    is "a full working folder: the copy says it could not all be written, and blames no file" "$(grep -c "^  what was copied could not all be written into the working folder (the copy's messages are above), and a file that arrived may be cut short: $FULL8\$" "$LOG") $(grep -c 'did not arrive, unreadable or gone before they were read' "$LOG") $(grep -c 'did not arrive, not written into the working folder, or unreadable or gone before they were read' "$LOG")" '1 0 1'
    # 9 when its copy could be made and what was read could not all be written, 11 when the copy could not be made
    is "and one file that cannot be written has a status of its own" "$( { [ "$rc" = 9 ] || [ "$rc" = 11 ]; } && echo 'its own' || echo "$rc")" 'its own'
    is "and nothing the collector does itself complains on the screen" "$(grep -c 'No such file\|No space left' "$WORK/answers/full-said.txt")" 0
    hdiutil detach "$WORK/small" -force > /dev/null 2>&1; rm -rf "$FULL8"
else
    bad "a small disk image to fill could not be made (hdiutil)"
fi

# How long the list is gone through, and how far: a user can make as many files as they like, and each costs time
AM_ROOT=0; MANY="$USER_HOME/Library/Containers/com.microsoft.Many/Data/Library/Logs"; mkdir -p "$MANY"
i=0; while [ $i -lt 600 ]; do i=$((i + 1)); : > "$MANY/many-$i.log"; done; touch -t "$WHEN" "$MANY"/many-*.log
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
COPY_SECONDS=1; SECONDS=0; ( discover_sources ) > /dev/null 2>&1; took=$SECONDS; COPY_SECONDS=60
is "the list is gone through for at most its time, and the row says how much was left" "$([ "$took" -le 6 ] && echo 'in time' || echo "after $took s") $(grep -c "^discovered_sources${TAB}incomplete${TAB}[0-9]* listed and [0-9]* copied, and [0-9]* more found were not listed; office/discovered_sources.tsv; .*going through what the searches found was stopped once 1 s had passed" "$MANIFEST") $([ "$(($(wc -l < "$OUT/office/discovered_sources.tsv") - 1))" -lt 600 ] && echo 'not all listed' || echo 'all listed')" 'in time 1 not all listed'
touch -t 200001010000 "$MANY"/many-*.log
: > "$LOG"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; ( discover_sources ) > /dev/null 2>&1
ALL=$(sed -n 's/^  \([0-9]*\) Microsoft log file(s) found, .*/\1/p' "$LOG" | tail -1)
: > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
MAX_DISCOVERED_FILES=50; ( discover_sources ) > /dev/null 2>&1; MAX_DISCOVERED_FILES=100000
is "how many were not listed is exactly what the search found past its most" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}50 listed and [0-9]* copied, and $((ALL - 50)) more found were not listed; " "$MANIFEST")" 1
is "the list is gone through no further than its most, and the row says so" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}50 listed and [0-9]* copied, and [0-9]* more found were not listed; office/discovered_sources.tsv; .*only the first 50 files the searches found were gone through; only the first 50 files that each search finds are listed" "$MANIFEST") $(($(wc -l < "$OUT/office/discovered_sources.tsv") - 1))" '1 50'
rm -rf "$USER_HOME/Library/Containers/com.microsoft.Many"
# The same for the reports in a report folder of the user's
i=0; while [ $i -lt 600 ]; do i=$((i + 1)); : > "$R0/Microsoft many-$i.ips"; done; touch -t "$WHEN" "$R0"/Microsoft\ many-*.ips
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/reports"
COPY_SECONDS=1; SECONDS=0; ( collect_reports ) > /dev/null 2>&1; took=$SECONDS; COPY_SECONDS=60
is "a report folder's list is gone through for at most its time, and a row says how much was left" "$([ "$took" -le 8 ] && echo 'in time' || echo "after $took s") $(grep -c "^report_lists${TAB}incomplete${TAB}[0-9]* file(s) listed in the report folders were not gone through (going through a folder's list stops once 1 s have passed, and after its first 100000 files); see collection.log\$" "$MANIFEST")" 'in time 1'
: > "$MANIFEST"; rm -rf "$OUT/reports"
MAX_DISCOVERED_FILES=50; ( collect_reports ) > /dev/null 2>&1; MAX_DISCOVERED_FILES=100000
is "and no further than its first files" "$([ "$(ls "$OUT/reports/user_Library_Logs_DiagnosticReports" | wc -l)" -le 50 ] && echo 'at most 50' || echo more) $(grep -c "^report_lists${TAB}incomplete${TAB}" "$MANIFEST")" 'at most 50 1'
rm -f "$R0"/Microsoft\ many-*.ips
# The force-quit records the same way, with the count exact, and the reports row not complete
CR="$USER_HOME/Library/Application Support/CrashReporter"; i=0; while [ $i -lt 300 ]; do i=$((i + 1)); printf 'x\n' > "$CR/Microsoft many-$i.plist"; done
n=$(find "$CR" -maxdepth 1 -type f \( -iname 'Microsoft*' -o -iname 'Intervals*' \) | wc -l | tr -d ' ')
: > "$MANIFEST"; rm -rf "$OUT/reports"; UNANSWERED=0; REPORTS_LEFT=0
MAX_DISCOVERED_FILES=50; collect_reports > /dev/null 2>&1; MAX_DISCOVERED_FILES=100000
is "the force-quit records are gone through no further than their most, with the count exact" "$(grep -c "^report_lists${TAB}incomplete${TAB}$((n - 50)) file(s) listed in the report folders were not gone through " "$MANIFEST") $(ls "$OUT/reports/CrashReporter" | grep -c '\.plist$')" '1 50'
is "and the reports row is not complete, and says why" "$(grep -c "^reports${TAB}incomplete${TAB}diagnostic reports, by the rule in source_catalog.tsv, and the CrashReporter files named Microsoft\* or Intervals\*; .*$((n - 50)) file(s) it listed were not gone through (see report_lists)" "$MANIFEST")" 1
: > "$MANIFEST"; rm -rf "$OUT/reports"; COPY_SECONDS=1; SECONDS=0; collect_reports > /dev/null 2>&1; took=$SECONDS; COPY_SECONDS=60
is "the force-quit records are gone through for at most their time too" "$([ "$took" -le 10 ] && echo 'in time' || echo "after $took s") $(grep -c "^report_lists${TAB}incomplete${TAB}" "$MANIFEST") $([ "$(ls "$OUT/reports/CrashReporter" | grep -c '\.plist$')" -lt 300 ] && echo 'not all' || echo all)" 'in time 1 not all'
rm -f "$CR"/Microsoft\ many-*.plist
AM_ROOT=1
# One file in the home folder where a whole folder of logs is expected, over the limit for one file
rm -rf "$USER_HOME/Library/Logs/Microsoft"; dd if=/dev/zero of="$USER_HOME/Library/Logs/Microsoft" bs=1 count=0 seek=3145728 2>/dev/null
MAX_COPY_FILE_MB=1; FIXED_SOURCES=("$USER_HOME/Library/Logs/Microsoft|office/user_microsoft_logs")
( collect_office ) > /dev/null 2>&1; MAX_COPY_FILE_MB=1024
is "a single file over the limit is said to be that, not missing" "$(grep -c '^  not copied: it is over 1 MB: ' "$LOG")" 1
eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
# As root, the closing line of the leftover-folder notice names the two owners it counts
mkdir -p "$WORK/many-root"; KEEP_BASE=$STAGE_BASE; STAGE_BASE="$WORK/many-root"
i=0; while [ $i -lt 8 ]; do i=$((i + 1)); mkdir "$STAGE_BASE/excel_diag.Root$i"; done
: > "$WORK/said.txt"; earlier_runs
is "as root, the count of folders names whose they are" "$(grep -c "^In all, 8 folders in $STAGE_BASE owned by root or $CONSOLE_USER are named like" "$WORK/said.txt")" 1
STAGE_BASE=$KEEP_BASE; AM_ROOT=0

# ---- a disk that is full ------------------------------------------------------------------------------------------
# bash writes a here-string or a here-document into a file of its own in /var/tmp before it is read, and anyone can
# fill that disk. A full disk is made here with a limit of 0 bytes on what this shell may write to a file.
# The shell part of the collector has no here-string left: each is worked out without a file
is "no here-string is left in the collector" "$(grep -v '^[[:space:]]*#' "$SCRIPT" | grep -c '<<<')" 0
# Whether every part of a destination's path is root's is judged on each part's own answer. Here every look after the
# first, at the path as written, cannot be written down: a part that did not answer is a no, and is never judged on the
# answer of the part before. (The path leads to /usr and goes there through this test's own folders.)
dots=""; x=$WORK; while [ "$x" != / ]; do dots="$dots/.."; x=$(dirname "$x"); done
LEAFP="$WORK$dots/usr"; PARENTP=$(dirname "$LEAFP")
is "root's alone: a path through the test's own folders to /usr is not (the disk not full)" "$(roots_chain "$LEAFP"; echo $?)" 1
is "and with the disk full after the first look, it is still not" \
    "$( (trap '' XFSZ; set -T; trap 'case ${p-} in "$PARENTP") ulimit -S -f 0 ;; esac' DEBUG; roots_chain "$LEAFP"; echo $?) 2>/dev/null | cat)" 1
# Each program the collector holds is read from a here-document. One that could not be read whole stops the run, with
# a line that says so, before anything is collected; read whole, it does not stop anything.
for h in ASK_PL AS_USER_PL PICK_PL STREAM_PL FETCH_PL REPORT_PL REDACT_PL; do
    piece=$(awk -v h="$h" 'BEGIN { s = "IFS= read -r -d '"''"' " h " <<'"'"'PERL'"'"'" } $0 == s { on = 1 } on { print } on && $0 == "PERL" { if ((getline l) > 0) print l; exit }' "$SCRIPT")
    [ "$(printf '%s\n' "$piece" | tail -2 | head -1)" = PERL ] || piece=""       # its end not found: nothing is run
    is "$h ends with a line that names it" "$(printf '%s\n' "$piece" | grep -c "^# ---- the end of $h ----\$")" 1
    is "$h is checked as soon as it is read" "$(printf '%s\n' "$piece" | tail -1)" "program_read \"\$$h\" $h"
    is "$h read whole: nothing is stopped" "$( (unset "$h"; eval "$piece"; echo went on) 2>&1 | tail -1)" 'went on'
    # (unset first: in the collector nothing was read into it before, and a read that fails leaves what was there)
    is "$h on a full disk: the run stops, and says so" \
        "$( (unset "$h"; trap '' XFSZ; ulimit -S -f 0; eval "$piece"; echo went on) 2>&1 | grep -v 'cannot create temp file for here' | cat; echo "status ${PIPESTATUS[0]}")" \
        "Stopped: the program $h, which this script holds, could not be read whole. bash writes such a program into a temporary file in /var/tmp before reading it, and that cannot be done on a full disk. Nothing was collected.${NL}status 1"
done
# A file whose copy cannot be made in the working folder (its folder is gone, or it cannot be written to) is not read,
# and that has its own status and its own words: nothing was read, so nothing is said to be unwritten
FULLW="$WORK/copy-not-made"; mkdir -p "$FULLW"; OUT="$FULLW/bundle"; STAGE=$FULLW; mkdir -p "$OUT"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
eval "_cnm_fetch() $(declare -f fetch | tail -n +2)"; fetch() { echo read >> "$FULLW/fetched"; _cnm_fetch "$@"; }
copy_file "$USER_HOME/Library/Logs/plain.log" "$FULLW/no-such-folder/plain.log"
is "a copy that cannot be made: its own status, and the file is not read" "$? $([ -e "$FULLW/fetched" ] && echo read || echo 'not read')" '11 not read'
eval "fetch() $(declare -f _cnm_fetch | tail -n +2)"; unset -f _cnm_fetch
KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=("$USER_HOME/Library/Logs/plain.log|office/no-such-folder/plain.log")
( collect_office ) > /dev/null 2>&1; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "a fixed file whose copy cannot be made is said to be that" "$(grep -c "^  not read: its copy could not be made in the working folder: $USER_HOME/Library/Logs/plain.log\$" "$LOG") $(grep -c 'not found, or not a plain file' "$LOG")" '1 0'
: > "$LOG"; mkdir -p "$OUT/reports"; : > "$OUT/reports/user_Library_Logs_DiagnosticReports"      # a file where its folder goes
( collect_reports ) > /dev/null 2>&1
is "reports whose copies cannot be made are said to be that" "$(grep -c '^  [0-9]* report(s) were listed and not read, each because its copy could not be made in the working folder$' "$LOG") $(grep -c 'could not all be written\|gone, not a plain file' "$LOG")" '1 0'
: > "$LOG"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; : > "$OUT/office/discovered"     # the same for the search
( discover_sources ) > /dev/null 2>&1
is "a found file whose copy cannot be made is listed as that" "$(grep -c "^listed only: not read, because its copy could not be made in the working folder${TAB}.*/found.log${TAB}\$" "$OUT/office/discovered_sources.tsv") $(grep -c '^copy failed' "$OUT/office/discovered_sources.tsv")" '1 0'

# ---- the working folder, and the programs root runs ----------------------------------------------------------------
# The working folder, made as the collector makes it, has a folder of its own for the temporary files of the programs
# root runs, beside the bundle and closed to others. sort, given more than it keeps in memory, writes there.
TMPLINES=$(bounded "$(sed -n '/^STAGE=\$(\/usr\/bin\/mktemp -d /,/^TMPDIR=.*export TMPDIR$/p' "$SCRIPT")" 12 'export TMPDIR$')
( STAGE_BASE="$WORK/tmp-base"; mkdir -p "$STAGE_BASE"; NAME=Excel_Diagnostics_collect_20990102_030405; eval "$TMPLINES"
  { /usr/bin/perl -e 'print "$_ made-up line\n" for reverse 1 .. 200000'; sleep 2; } | /usr/bin/sort -S 100K > /dev/null &
  sleep 1; n=$(ls -A "$TMPDIR" 2>/dev/null | grep -c '^\.bsdsort\.'); wait
  echo "$([ -n "$STAGE" ] && [ "$TMPDIR" = "$STAGE/.tmp" ] && echo 'beside the bundle') $(stat -f '%Lp' "$TMPDIR" 2>/dev/null) $([ "$n" -gt 0 ] && echo 'sort writes there') $(case "$TMPDIR" in ("$OUT"/*) echo 'in the bundle' ;; (*) echo 'not in it' ;; esac)"
) > "$WORK/tmpdir.out" 2>&1
is "root's programs keep their temporary files in a folder of the working folder's, closed to others and not in the bundle" "$(cat "$WORK/tmpdir.out")" 'beside the bundle 700 sort writes there not in it'
# jq loads definitions from ~/.jq. Ones that make every test true would tag a plain line with everything.
eval "$(bounded "$(sed -n '/^TAG_PERMISSIONS_RX=/,/^LOG_EXT=tsv$/p' "$SCRIPT")" 60 '^LOG_EXT=tsv$')"
if [ -n "$JQ" ] && [ -n "$LABEL_JQ" ]; then
    mkdir -p "$WORK/jq-home"; printf 'def contains($x): true;\ndef test($r; $f): true;\n' > "$WORK/jq-home/.jq"
    ROW=$(printf '%s\n' '{"timestamp":"2099-01-02 03:04:05.000000+0000","processImagePath":"/usr/bin/made-up","processID":1,"eventMessage":"MADE-UP plain words"}' \
          | HOME="$WORK/jq-home" label_entries | sed -n 2p)
    is "jq is given no home folder: definitions put in ~/.jq do not change the tags" "$(printf '%s\n' "$ROW" | cut -f4,9,10)" "made-up${TAB}${TAB}MADE-UP plain words"
else
    bad "jq is not on this Mac, so how unified-log rows are tagged was not checked"
fi
# Each report folder's reports go into a folder named after it, whatever the home folder's path holds
TH="$WORK/odd#home&x\\y"; new "$TH/Library/Logs/DiagnosticReports/Microsoft Excel-2099-01-02-030405.ips" '{"bug_type":"309","MADE-UP-TAGGED":1}'
KEEP_H=$USER_HOME; USER_HOME=$TH; OUT="$WORK/tagged/bundle"; STAGE="$WORK/tagged"; mkdir -p "$OUT"; LOG="$OUT/collection.log"; : > "$LOG"
( collect_reports ) > /dev/null 2>&1; USER_HOME=$KEEP_H
is "a home folder whose path holds # & or \\ still gives its reports a folder of their own" "$(count "$OUT/reports/user_Library_Logs_DiagnosticReports" 'MADE-UP-TAGGED') $(find "$OUT/reports" -maxdepth 1 -type f ! -name report_listing.txt ! -name crash_summary.txt | wc -l | tr -d ' ')" '1 0'
# The console user's home folder is the account database's, whole: dscl prints a value with a space in it on a line of
# its own, which split into words gave a home that is not there. When the database gives none, that is said.
HOMELINES=$(bounded "$(sed -n '/^USER_HOME=/,/^AM_ROOT=0;/p' "$SCRIPT")" 25 '^AM_ROOT=0;' | sed '$d')
U=/Users                                   # joined with a name below, never written out whole
dscl() { printf 'NFSHomeDirectory:\n %s\n' "$U/Pat Lee"; }      # what dscl prints for a home folder with a space in it
is "the home folder is the one the account database gives" "$(CONSOLE_USER=nobody; eval "$HOMELINES"; echo "$USER_HOME")" "$(/usr/bin/perl -e 'print +(getpwnam("nobody"))[7]')"
SAID_HOME=$(CONSOLE_USER="made-up-nobody-$$"; eval "$HOMELINES"; echo "[$USER_HOME]")
is "an account the database does not know: /Users and its name are taken, and that is said" "$SAID_HOME" \
    "The account database gives no home folder for made-up-nobody-$$, so $U/made-up-nobody-$$ is taken as that user's home folder.${NL}[$U/made-up-nobody-$$]"
unset -f dscl

# ---- how each step ends, and what it could write ------------------------------------------------------------------
# Every program run with the console user's rights ends with an answer of its own (0 or 1), with as_user's 124 or 126,
# or with no answer, and every step counts what it saw and writes its own row from that (row). A write into the
# working folder that fails is counted the same way. As root, with the test's own account as the console user.
AM_ROOT=1; USER_UID=$(id -u); USER_GID=$(id -g); USER_GROUPS=$(id -G); USER_READS=1; HOME_SHUT=0
OUT="$WORK/ends/bundle"; STAGE="$WORK/ends"; mkdir -p "$OUT/office" "$OUT/case"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
eval "_ends_real() $(declare -f plain_perl | tail -n +2)"
plain_perl() {
    local f a args=()
    if [ "$2" = "$AS_USER_PL" ] && [ -n "$KILL_CMD" ] && [ "$9" = "$KILL_CMD" ]; then _ends_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c 'kill -KILL $$'; return; fi
    if [ "$2" = "$AS_USER_PL" ] && [ -n "$FAKE_FROM" ]; then
        for a in "${@:9}"; do args+=("${a//"$FAKE_FROM"/$FAKE_TO}"); done
        _ends_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" "${args[@]}"; return
    fi
    if [ "$2" = "$AS_USER_PL" ]; then
        for f in ${FAKES[@]+"${FAKES[@]}"}; do
            case "${*:9}" in $f) _ends_real -e "$AS_USER_PL" -- "$4" "$5" "$6" "$7" "$8" /bin/sh -c "${FAKE_RUN:-kill -KILL \$\$}"; return ;; esac
        done
    fi
    _ends_real "$@"
}
FAKES=(); FAKE_RUN=""; FAKE_FROM=""; FAKE_TO=""; KILL_CMD=""
# Whether verbose logging is on, not answered: the Documents folder is not searched, and that is said
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"
KILL_CMD=/usr/bin/plutil; ( discover_sources ) > /dev/null 2>&1; KILL_CMD=""
is "verbose logging not known: the Documents folder is not searched, that is said, and the row is not complete" \
    "$(grep -c "^  the Documents folder was not searched for verbose logs: whether Excel's verbose logging is on was not answered" "$LOG") $(grep -c "^discovered_sources${TAB}incomplete${TAB}.*the Documents folder was not searched for verbose logs, because whether Excel's verbose logging is on was not answered" "$MANIFEST") $(grep -c 'verbose.log' "$OUT/office/discovered_sources.tsv")" '1 1 0'
# A fixed source whose look was killed: said as copy_dir says it of its own look, not as not found, and counted
: > "$LOG"; : > "$MANIFEST"; KEEP_FIXED=("${FIXED_SOURCES[@]}"); FIXED_SOURCES=("$USER_HOME/Library/Logs/plain.log|office/plain-fixed.log")
FAKES=('/bin/test -f *'); ( collect_office; echo "$UNANSWERED" > "$WORK/ends/n" ) > /dev/null 2>&1; FAKES=()
is "a fixed source whose look was killed is said to be that, not missing, and counted" "$(grep -c "^  not read: the program that looked for it ended without an answer (status 137): $USER_HOME/Library/Logs/plain.log\$" "$LOG") $(grep -c 'not found' "$LOG") $(cat "$WORK/ends/n")" '1 0 1'
# One that cannot be opened is said to be that (the reader tells its ends apart; copy_said says each)
chmod 000 "$USER_HOME/Library/Logs/plain.log"; : > "$LOG"; ( collect_office ) > /dev/null 2>&1; chmod 644 "$USER_HOME/Library/Logs/plain.log"; FIXED_SOURCES=("${KEEP_FIXED[@]}")
is "a fixed file that cannot be opened is said to be that" "$(grep -c "^  not read: opening it was refused: $USER_HOME/Library/Logs/plain.log\$" "$LOG") $(grep -c "^office${TAB}incomplete${TAB}.*1 file(s) that were there could not be read whole" "$MANIFEST")" '1 1'
# A look that the catalog makes, killed: the catalog's row is not complete
: > "$MANIFEST"; KILL_CMD=/bin/test; ( write_source_catalog ) > /dev/null 2>&1; KILL_CMD=""
is "a source whose look was killed makes the catalog's row not complete" "$(grep -c "^source_catalog${TAB}incomplete${TAB}source_catalog.tsv; [0-9]* program(s) run with the console user's rights ended without an answer" "$MANIFEST")" 1
# du killed, and the count of names left out of a list killed: neither is said as a number
: > "$LOG"; : > "$MANIFEST"; FAKES=('/usr/bin/du -sh *' '/usr/bin/find */Preferences/AutoRecovery -type f ( -iname*'); ( collect_office ) > /dev/null 2>&1; FAKES=()
A="$OUT/office/autorecover_inventory.txt"
is "a total that du did not answer is said to be that" "$(grep -c '(total not known: du ended without an answer, status 137)' "$A") $(grep -c '(total )' "$A")" '1 0'
is "a count of names left out that was killed is not given as a number, and the row says so" "$(grep -c '^(How many more with a control or invisible character in the name or path are not listed is not known.)$' "$A") $(grep -c "^office${TAB}incomplete${TAB}.*how many names with a control or invisible character were left out of .*/Preferences/AutoRecovery is not known (the program that counted them ended without an answer, status 137)" "$MANIFEST")" '1 1'
# The reader tells apart: not there, refused, not a plain file (a folder, a link); copy_file passes each on
EF="$USER_HOME/Library/Logs/Ends"; mkdir -p "$EF/folder.log"; printf 'x\n' > "$EF/closed.log"; chmod 000 "$EF/closed.log"; ln -s "$WORK/secret/file.txt" "$EF/link.log"
x=""; for n in missing.log closed.log folder.log link.log; do "${PERL_CMD[@]}" -e "$FETCH_PL" -- "$EF/$n" "" 0 > /dev/null 2>&1; x="$x $?"; done
is "the reader tells apart: not there, opening it refused, not a plain file (a folder, a link)" "$x" ' 1 8 7 7'
x=""; for n in missing.log closed.log folder.log link.log; do copy_file "$EF/$n" "$WORK/ends/f-copy" > /dev/null 2>&1; x="$x $?"; done
is "and copy_file passes each on as a status of its own" "$x" ' 1 13 12 12'
chmod 644 "$EF/closed.log"; rm -rf "$EF"
# A report and a force-quit record that cannot be opened: each is said to be that, and the reports row is not complete
CRX="$USER_HOME/Library/Application Support/CrashReporter/Microsoft Closed_MADEUP.plist"; printf 'x\n' > "$CRX"; chmod 000 "$CRX"
new "$R0/Microsoft Closed_MADEUP.ips" '{"bug_type":"309"}'; chmod 000 "$R0/Microsoft Closed_MADEUP.ips"
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/reports"; ( collect_reports ) > /dev/null 2>&1
chmod 644 "$CRX" "$R0/Microsoft Closed_MADEUP.ips"; rm -f "$CRX" "$R0/Microsoft Closed_MADEUP.ips"
is "a report and a force-quit record that cannot be opened are each said to be that, and the row is not complete" "$(grep -c '^  1 report(s) were listed and not read, each because opening it was refused$' "$LOG") $(grep -c '^  1 file(s) of .*/CrashReporter were listed and not read, each because opening it was refused$' "$LOG") $(grep -c "^reports${TAB}incomplete${TAB}.*2 file(s) that were there could not be read whole" "$MANIFEST")" '1 1 1'
# A force-quit record with a control character in its name is counted too
new "$USER_HOME/Library/Application Support/CrashReporter/Microsoft odd${NL}name.plist" 'x'
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/reports"; ( collect_reports ) > /dev/null 2>&1
rm -f "$USER_HOME/Library/Application Support/CrashReporter/Microsoft odd${NL}name.plist"
is "a force-quit record with a control character in its name is counted, in the log and the row" "$(grep -c "^  1 file(s) of .*/CrashReporter with a control or invisible character in the name were not copied\$" "$LOG") $(grep -c "^reports${TAB}incomplete${TAB}.*1 file(s) of the CrashReporter folder with a control or invisible character in the name were not copied" "$MANIFEST")" '1 1'
# A list whose program that looks at each name was killed has every name, or says where it stops: the program is
# stat for find -exec, and the perl that LIST_SH runs
for k in '/usr/bin/stat' '/usr/bin/perl -e "$pl"'; do
    : > "$LOG"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; FAKE_FROM=$k; FAKE_TO="$WORK/killself"; ( collect_office ) > /dev/null 2>&1; FAKE_FROM=""
    said="$(grep -c 'Budget (AutoRecovered).xlsx$' "$OUT/office/autorecover_inventory.txt") $(grep -c '^(The list stops here: the program that made it ended without an answer' "$OUT/office/autorecover_inventory.txt")"
    is "a list whose program for each name was killed ($k) has every name, or says it stops" "$(case "$said" in ('1 0'|'0 '[1-9]*) echo 'whole or said' ;; (*) echo "$said" ;; esac)" 'whole or said'
    : > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; FAKE_FROM=$k; FAKE_TO="$WORK/killself"; ( discover_sources ) > /dev/null 2>&1; FAKE_FROM=""
    said="$(grep -c 'Something/Data/Library/Logs/found.log' "$OUT/office/discovered_sources.tsv") $(grep -c "^discovered_sources${TAB}incomplete${TAB}.*the search of the home folder ended without an answer" "$MANIFEST")"
    is "a search whose program for each name was killed ($k) has every name, or says it ended without an answer" "$(case "$said" in ('1 0'|'0 '[1-9]*) echo 'whole or said' ;; (*) echo "$said" ;; esac)" 'whole or said'
done
# The test of whether a report names Excel, killed: the report is listed, or the list says it ended without an answer
: > "$LOG"; rm -rf "$OUT/reports"; FAKE_FROM=/usr/bin/env; FAKE_TO="$WORK/killself"; ( collect_reports ) > /dev/null 2>&1; FAKE_FROM=""
said="$(cat "$OUT/reports/user_Library_Logs_DiagnosticReports/helper-2099-01-02.ips" 2>/dev/null | grep -c 'MADE-UP-NAMES-EXCEL-ONLY-IN-ITS-TEXT') $(grep -c "^  the list of reports to copy from $R0 ended without an answer" "$LOG")"
is "a test of whether a report names Excel that was killed is noticed" "$(case "$said" in ('1 0'|'0 '[1-9]*) echo 'copied or said' ;; (*) echo "$said" ;; esac)" 'copied or said'
# copy_dir's counts each carry their name, and all are needed: one count killed never moves another into its place
K3="$USER_HOME/Library/Logs/Three"; mkdir -p "$K3/a" "$K3/b"; for f in one two three; do printf 'x\n' > "$K3/$f.log"; done
for p in wc find perl; do
    printf '#!/bin/sh\n[ -e "$0.done" ] || { : > "$0.done"; kill -KILL $$; }\nexec /usr/bin/%s "$@"\n' "$p" > "$WORK/ends/once-$p"; chmod +x "$WORK/ends/once-$p"; rm -f "$WORK/ends/once-$p.done"
    : > "$LOG"; COPY_SHUT=0; FAKE_FROM="/usr/bin/$p"; FAKE_TO="$WORK/ends/once-$p"; copy_dir "$K3" "$OUT/three-$p"; FAKE_FROM=""
    is "one count killed (the first $p): no folder is said to be unreadable, and no file to be missing" "$(grep -c 'folder(s) in it could not be read\|file(s) did not arrive' "$LOG")" 0
done
rm -rf "$K3"
# Folders that cannot be read are counted one each, whatever their names hold; one whose entries cannot be looked at
# is one of them
SH2="$USER_HOME/Library/Logs/Shut2"; mkdir -p "$SH2/one${NL}closed${NL}folder" "$SH2/noexec"; printf 'x\n' > "$SH2/noexec/inside.log"; printf 'x\n' > "$SH2/plain.log"
chmod 000 "$SH2/one${NL}closed${NL}folder"; chmod 400 "$SH2/noexec"
: > "$LOG"; COPY_SHUT=0; copy_dir "$SH2" "$OUT/shut2"; chmod 755 "$SH2/one${NL}closed${NL}folder" "$SH2/noexec"; rm -rf "$SH2"
is "folders that cannot be read are counted one each, whatever their names hold" "$(grep -c "^  2 folder(s) in it could not be read, so what they hold is not copied or counted: $SH2\$" "$LOG") $COPY_SHUT" '1 2'
# Writes into the working folder that fail. A search whose list could not be written:
eval "_mo_real() $(declare -f most_of | tail -n +2)"; most_of() { ( trap '' XFSZ; ulimit -S -f 0; _mo_real "$@" ); }
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; ( discover_sources ) > /dev/null 2>&1
eval "most_of() $(declare -f _mo_real | tail -n +2)"; unset -f _mo_real
is "a search whose list could not be written says so, blames nothing else, and its row is not complete" "$(grep -c 'the list of what the search of the home folder found could not all be written into the working folder' "$LOG") $(grep -c "^discovered_sources${TAB}incomplete${TAB}" "$MANIFEST") $(grep -c 'were gone through' "$LOG")" '1 1 0'
# first_lines whose writes fail reads on to the end: what writes into it is never stopped by a pipe that closed
x=$( (trap '' XFSZ; ulimit -S -f 0; /usr/bin/perl -e 'print "$_\n" for 1 .. 200000' | first_lines 5 > "$WORK/ends/fl.out"; echo "${PIPESTATUS[*]}") 2>/dev/null )
is "first_lines whose writes fail reads to the end and says so" "$x" '0 4'
# The list of folders to search, not written: not taken for an answer
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office" "$STAGE/.roots"; ( discover_sources ) > /dev/null 2>&1; rmdir "$STAGE/.roots"
is "a list of folders to search that could not be written is not taken for an answer" "$(grep -c "^discovered_sources${TAB}incomplete${TAB}.*the list of the folders of the home folder to search could not all be written into the working folder" "$MANIFEST")" 1
# Only the first search's list could not all be written (it is held to 1 KB). What it found and could not write is
# said as that, and not as left past a rule; and the count of names left out is still made, so its line is there.
i=0; while [ $i -lt 30 ]; do i=$((i + 1)); new "$USER_HOME/Library/Logs/OneDrive/made-up-onedrive-log-number-$i.log" 'MADE-UP-ONEDRIVE'; done
eval "_mo_real() $(declare -f most_of | tail -n +2)"
most_of() { if [ -e "$WORK/limit-first" ]; then rm -f "$WORK/limit-first"; ( trap '' XFSZ; ulimit -S -f 1; _mo_real "$@" ); else _mo_real "$@"; fi; }
: > "$WORK/limit-first"; : > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; ( discover_sources ) > /dev/null 2>&1; rm -f "$WORK/limit-first"
rm -rf "$USER_HOME/Library/Logs/OneDrive"
is "a search list that could not all be written: what is not in it is said as that, not as left past a rule, and names left out are still counted" \
    "$(grep -c 'more could not be written into the list of what a search found, so they were not gone through' "$LOG") $(cat "$LOG" "$MANIFEST" | grep -c 'only the first') $(grep -c 'with a control or invisible character in the name or path were not listed or copied' "$LOG")" '1 0 1'
# The same of the report folders' lists, all of them held to 1 KB: no report is said to have been left by the rules for
# going through a list
i=0; while [ $i -lt 30 ]; do i=$((i + 1)); new "$R0/made-up-report-with-a-long-name-for-the-list-number-$i.diag" 'MADE-UP-REPORT'; done
most_of() { ( trap '' XFSZ; ulimit -S -f 1; _mo_real "$@" ); }
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/reports"; ( collect_reports ) > /dev/null 2>&1
rm -f "$R0"/made-up-report-with-a-long-name-for-the-list-number-*.diag
is "a report list that could not all be written: nothing is said to be left by the rules for going through a list" "$(grep -c "^report_lists" "$MANIFEST") $(grep -c 'were not gone through: going through' "$LOG") $(grep -c 'of the entries the search for reports to copy in .* found could not be written into its list, so they were not gone through' "$LOG")" '0 0 1'
eval "most_of() $(declare -f _mo_real | tail -n +2)"; unset -f _mo_real
# A folder that find cannot read, in a folder that is listed or searched: the list says that find met an error, and
# the rows are not complete
CF="$XL/Library/Preferences/AutoRecovery/closed-by-its-owner"; new "$CF/autorecover-two.xar" 'MADE-UP-CLOSED'; chmod 000 "$CF"
CS="$USER_HOME/Library/Containers/com.microsoft.Something/Data/Library/Logs/closed-by-its-owner"; new "$CS/inside.log" 'MADE-UP-CLOSED'; chmod 000 "$CS"
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"; mkdir -p "$OUT/office"; ( collect_office; discover_sources ) > /dev/null 2>&1
chmod 755 "$CF" "$CS"; rm -rf "$CF" "$CS"
is "a list or search that find could not make whole says so, and its row is not complete" "$(grep -c '^(find ended with status 1 here: it met an error on the way, such as a folder it could not read\. What it did not get to is not listed\.)$' "$OUT/office/autorecover_inventory.txt") $(grep -c "^office${TAB}incomplete${TAB}.*made by find ended with find's status 1" "$MANIFEST") $(grep -c "^discovered_sources${TAB}incomplete${TAB}.*made by find ended with find's status 1" "$MANIFEST") $(grep -c 'the search of the home folder made by find may leave something out' "$LOG")" '2 1 1 1'
# sort ends at once when it cannot write its temporary files: the list's program is then not stopped by a pipe that
# closed, and is not said to have ended without an answer
i=0; while [ $i -lt 1500 ]; do i=$((i + 1)); : > "$XL/Library/Preferences/AutoRecovery/autorecover-made-up-file-with-a-long-name-for-the-pipe-$i.xar"; done
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/office"
( sort() { /usr/bin/head -c 100 > /dev/null; return 2; }; collect_office ) > /dev/null 2>&1
rm -f "$XL/Library/Preferences/AutoRecovery"/autorecover-made-up-file-with-a-long-name-for-the-pipe-*.xar
is "a sort that ends at once does not make the list's program look as if it ended without an answer" "$(cat "$OUT/office/autorecover_inventory.txt" "$LOG" | grep -c 'ended without an answer') $(grep -c 'office/autorecover_inventory.txt could not all be written' "$LOG")" '0 2'
# A force-quit record whose text cannot be written: said, and plutil is not counted as having ended without an answer
: > "$LOG"; rm -rf "$OUT/reports"; mkdir -p "$OUT/reports/CrashReporter/Microsoft Excel_0F1E2D3C.txt"
( collect_reports; echo "$UNANSWERED" > "$WORK/ends/n" ) > /dev/null 2>&1
is "a force-quit record whose text cannot be written is said to be that, and blames no program" "$(grep -c 'reports/CrashReporter/Microsoft Excel_0F1E2D3C.txt could not all be written into the working folder' "$LOG") $(cat "$WORK/ends/n")" '1 0'
# The workbook's facts, when the file for them cannot be written: said, and the row is not complete
: > "$LOG"; : > "$MANIFEST"; rm -f "$OUT/case/workbook_metadata.txt"; mkdir -p "$OUT/case/.workbook_metadata.part"; : > "$WORK/ends/book.xlsx"
WORKBOOK="$WORK/ends/book.xlsx"; ( collect_workbook_metadata ) > /dev/null 2>&1; WORKBOOK=""; rmdir "$OUT/case/.workbook_metadata.part"
is "workbook facts that could not be written: said, and the row is not complete" "$(grep -c 'case/workbook_metadata.txt could not all be written into the working folder' "$LOG") $(grep -c "^workbook_metadata${TAB}incomplete${TAB}metadata only; workbook not copied; 1 time(s) what it had could not all be written" "$MANIFEST") $([ -e "$OUT/case/workbook_metadata.txt" ] && echo there || echo 'not there')" '1 1 not there'
# A row that cannot be written is counted in the shell
RS=$(bounded "$(sed -n '/^record_status() {/,/^}$/p' "$SCRIPT")" 8 '^}$')
x=$( eval "$RS"; MANIFEST="$WORK/ends/rows-are-here"; mkdir -p "$MANIFEST"; ROWS_LOST=0; record_status a b c; record_status d e f; echo "$ROWS_LOST" )
is "a row that cannot be written is counted" "$x" 2
# The last lines say how many rows, and how many times anything, could not be written; and a checksum that could not
# be made is not named
: > "$WORK/said.txt"; fin fin-lost 'ROWS_LOST=2; WRITES_LOST=3' > /dev/null
is "the last lines say what could not be written" "$(grep -c '^2 row(s) could not be written into the status table (manifest.tsv), so it does not have them\.$' "$WORK/said.txt") $(grep -c '^3 time(s) during this run, something it had could not all be written into the working folder' "$WORK/said.txt")" '1 1'
: > "$WORK/said.txt"; fin fin-nosum 'shasum() { return 1; }' > /dev/null
is "a checksum that could not be made is not named, and is not handed over" "$(grep -c "Send this file to IT: $WORK/fin-nosum/dest/Excel_Diagnostics_hang_20990102_030405.zip (no checksum file was made)\$" "$WORK/said.txt") $(grep -c 'sha256' "$WORK/said.txt") $(ls "$WORK/fin-nosum/dest" | grep -c sha256)" '1 0 0'
# The time spent on helpers run with the user's rights, when it cannot be written down: nothing more is run with
# that user's rights, and that holds in this shell even when the mark that says so cannot be made
LS="$WORK/ledger-shut"; mkdir -p "$LS/stage" "$LS/out"; KEEP_STAGE=$STAGE; KEEP_LOG=$LOG; KEEP_MAN=$MANIFEST
STAGE="$LS/stage"; LOG="$LS/out/collection.log"; MANIFEST="$LS/out/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"; chmod 555 "$STAGE"; HOME_SHUT=0
as_user /usr/bin/true; first=$?; as_user /usr/bin/true; second=$?; chmod 755 "$STAGE"
is "a time that could not be written down: the helper's answer stands, and nothing more is run, without the mark" "$first $second $([ -e "$STAGE/.limit" ] && echo marked || echo 'no mark') $(grep -c "^time_limit${TAB}failed${TAB}the time a helper run with the console user's rights took could not be added to the record of that time" "$MANIFEST")" '0 126 no mark 1'
if hdiutil create -size 4m -fs HFS+ -volname EDLEDGER -layout NONE "$WORK/ledger.dmg" > /dev/null 2>&1 && mkdir -p "$WORK/ledger-disk" \
    && hdiutil attach "$WORK/ledger.dmg" -mountpoint "$WORK/ledger-disk" -nobrowse > /dev/null 2>&1; then
    STAGE="$WORK/ledger-disk"; : > "$LOG"; : > "$MANIFEST"; HOME_SHUT=0
    dd if=/dev/zero of="$STAGE/fill" bs=1024 count=8000 2>/dev/null
    as_user /usr/bin/true; first=$?; as_user /usr/bin/true; second=$?
    is "on a full disk, the time cannot be written down: nothing more is run with the user's rights" "$first $second $(grep -c "^time_limit${TAB}failed${TAB}the time a helper run with the console user's rights took could not be added" "$MANIFEST")" '0 126 1'
    hdiutil detach "$WORK/ledger-disk" -force > /dev/null 2>&1
else
    bad "a small disk image to fill could not be made (hdiutil)"
fi
STAGE=$KEEP_STAGE; LOG=$KEEP_LOG; MANIFEST=$KEEP_MAN; HOME_SHUT=0
# The unified log, searched with a stand-in for log show that answers as each test needs. A day is "ok" only when
# log show, the labeller and the writing of its rows all ended with 0; the row counts the days by what came of them;
# the labeller's messages go to the day's errors file, which is named only when it was kept.
ULINES=$(bounded "$(sed -n '/^collect_unified() {/,/^}$/p' "$SCRIPT")" 80 '^}$' | sed 's#/usr/bin/log #fake_log #g')
HLINES=$(bounded "$(sed -n '/^mode_hang() {/,/^}$/p' "$SCRIPT")" 100 '^}$' | sed 's#/usr/bin/log #fake_log #g')
RLINES=$(bounded "$(sed -n '/^repro_finish() {/,/^}$/p' "$SCRIPT")" 80 '^}$')
SLINES=$(bounded "$(sed -n '/^capture_repro_snapshot() {/,/^}$/p' "$SCRIPT")" 20 '^}$')
entries() { local i=0; while [ $i -lt "$1" ]; do i=$((i + 1)); printf '{"timestamp":"2099-01-02 03:04:05.000000+0000","processImagePath":"/x/Microsoft Excel","processID":%s,"eventMessage":"MADE-UP %s"}\n' "$i" "$i"; done; }
fake_log() {
    case "$*" in *'--last 1m'*) [ -n "$FAKE_ACCESS" ] && { echo "log: MADE-UP refusal" >&2; return "$FAKE_ACCESS"; }; return 0 ;; esac
    case "$*" in
        *"--start $FAKE_DAY1 "*|*'--last 30m'*) entries "${FAKE_N:-3}"; return "${FAKE_END:-0}" ;;
        *"--start $FAKE_DAY2 "*) entries 2; return 124 ;;
        *) echo "log: MADE-UP failure" >&2; return 1 ;;
    esac
}
if [ -n "$JQ" ]; then
    KEEP_SINCE=$SINCE; SINCE=2099-01-01; UNTIL=2099-01-03; DAYS=3; MAX_WAIT=3; QUERY_TIMEOUT=180; LOG_EXT=tsv; FAKE_DAY1=2099-01-01; FAKE_DAY2=2099-01-02
    : > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/unified_logs"; ( eval "$ULINES"; collect_unified ) > /dev/null 2>&1
    U="$OUT/unified_logs"
    is "the log says what the search takes, from its predicate" "$(grep -c "^Unified logs, 2099-01-01 through 2099-01-03: the entries of processes named Microsoft Excel and of programs inside a folder named Microsoft Excel.app, messages that hold Excel (in any case; RunningBoard's state dumps apart)" "$LOG") $(grep -c 'hangs/terminations' "$LOG")" '1 0'
    is "each day says what came of it, and an errors file is named only when it was kept" "$(sed -n 2,4p "$U/collection_status.txt" | tr '\n' '|')" \
        "2099-01-01 | ok (3 entries)|2099-01-02 | hit the 3-minute limit, partial (2 entries; rerun with a larger --max-wait for the rest)|2099-01-03 | error 1 (0 entries; see 2099-01-03.errors.txt)|"
    is "and the row counts the days by what came of them" "$(grep -c "^unified_logs${TAB}incomplete${TAB}3 day(s), 2099-01-01 through 2099-01-03, 1 of them searched to the end and written; see unified_logs/collection_status.txt; 1 day(s) stopped at the 3-minute limit, with what was found by then kept; 1 day(s) where log show ended with an error\$" "$MANIFEST") $(ls "$U" | grep -c errors) $(grep -c 'MADE-UP failure' "$U/2099-01-03.errors.txt")" '1 1 1'
    # The labeller's own messages go into the day's errors file, and a day it did not end well for is not "ok"
    printf '#!/bin/sh\ncat > /dev/null; echo "jq: MADE-UP error" >&2; exit 5\n' > "$WORK/ends/fake-jq"; chmod +x "$WORK/ends/fake-jq"
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; ( JQ="$WORK/ends/fake-jq"; eval "$ULINES"; collect_unified ) > /dev/null 2>&1
    is "a labeller that did not end well: its messages are kept, and the day is not ok" "$(sed -n 2p "$U/collection_status.txt") $(grep -c 'jq: MADE-UP error' "$U/2099-01-01.errors.txt" 2>/dev/null)" "2099-01-01 | not all labelled: the labeller ended with status 5 (0 entries are in the file; see 2099-01-01.errors.txt) 1"
    # A labeller that stopped reading before the end (here it is killed): capped, which writes only into the pipe to
    # it, ends with 4, and that is said as the labeller's end, not as a write into the working folder that failed
    printf '#!/bin/sh\n/usr/bin/head -c 100 > /dev/null; kill -KILL $$\n' > "$WORK/ends/dying-jq"; chmod +x "$WORK/ends/dying-jq"
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; FAKE_N=2000
    ( JQ="$WORK/ends/dying-jq"; WRITES_LOST=0; eval "$ULINES"; collect_unified; echo "$WRITES_LOST" > "$WORK/ends/dying-jq.lost" ) > /dev/null 2>&1; FAKE_N=""
    is "a labeller that stopped reading is said as that, and no write is said to have failed" "$(sed -n 2p "$U/collection_status.txt" | sed 's/([0-9]* entries/(N entries/') | $(grep -c "^unified_logs${TAB}incomplete${TAB}.*1 day(s) whose entries were not all labelled" "$MANIFEST") $(grep -c 'could not all be written' "$MANIFEST") $(cat "$WORK/ends/dying-jq.lost")" \
        '2099-01-01 | not all labelled: the labeller ended with status 137 (N entries are in the file) | 1 0 0'
    search_said 0 4 0 0 /dev/null /dev/null
    is "capped's 4 beside a labeller that ended with 0 is not taken for a write that failed either" "$SEARCH_KIND $SEARCH_SAID" 'unlabelled not all labelled: the labeller stopped reading before the end of what the search gave (0 entries are in the file)'
    # The program that passes the search on to the labeller, killed (here its own perl kills itself): said as that
    # program's end, not as the labeller stopping and not as a write that failed
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; FAKE_N=2000
    ( STREAM_PL='sysread(STDIN, my $b, 100); kill "KILL", $$;'; WRITES_LOST=0; eval "$ULINES"; collect_unified; echo "$WRITES_LOST" > "$WORK/ends/dying-cap.lost" ) > /dev/null 2>&1; FAKE_N=""
    is "the program between a search and its labeller, killed, is said as that, and as neither the labeller nor a write" \
        "$(sed -n 2p "$U/collection_status.txt" | sed 's/([0-9]* entries/(N entries/') | $(cat "$U/collection_status.txt" "$MANIFEST" | grep -c 'stopped reading\|could not all be written') $(cat "$WORK/ends/dying-cap.lost")" \
        '2099-01-01 | not all labelled: the program that passes what the search gives on to the labeller ended with status 137 (N entries are in the file) | 0 0'
    # Rows that could not all be written: the day is not ok (every file here is held to 2 KB)
    : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; mkdir -p "$U"; FAKE_N=200
    ( trap '' XFSZ; ulimit -S -f 2; eval "$ULINES"; collect_unified ) > /dev/null 2>&1; FAKE_N=""
    is "a day whose rows could not all be written is not ok, and the row is not complete" "$(sed -n 2p "$U/collection_status.txt" | sed 's/([0-9]* entries/(N entries/') $(grep -c "^unified_logs${TAB}incomplete${TAB}.*1 day(s) whose entries could not all be written into the working folder" "$MANIFEST")" \
        "2099-01-01 | not all written into the working folder (N entries are in the file) 1"
    # A search that any process can make as large as it likes is cut, and that is said (here at 0 GB)
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; FAKE_N=20
    ( UNIFIED_SEARCH_GB=0; eval "$ULINES"; collect_unified ) > /dev/null 2>&1; FAKE_N=""
    is "a search that comes to more than it may is cut, said in the day's line and in the row" "$(sed -n 2p "$U/collection_status.txt" | sed 's/([0-9]* entries/(N entries/') $(grep -c "^unified_logs${TAB}incomplete${TAB}.*1 day(s) cut once 0 GB of the search had arrived" "$MANIFEST")" "2099-01-01 | cut once 0 GB of it had arrived; what came after that was not kept (N entries) 1"
    # Hang: a search stopped at --max-wait keeps what it found and is incomplete; the hang's own row counts what the
    # hang's copy saw, and the search's row does not
    : > "$LOG"; : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.*; FAKE_END=124; FAKE_N=2
    ( excel_pids() { EXCEL_PIDS=""; return 0; }; eval "$HLINES"; KILL_CMD=/bin/test; mode_hang ) > /dev/null 2>&1; FAKE_END=""; FAKE_N=""
    is "hang: a search stopped at its limit is incomplete, with what it found kept" "$(grep -c "^unified_last30m${TAB}incomplete${TAB}hang capture; hit the 3-minute limit, partial (2 entries; rerun with a larger --max-wait for the rest)\$" "$MANIFEST") $(($(wc -l < "$OUT/unified_last30m.tsv") - 1))" '1 2'
    is "and the hang's row counts the copy that ended without an answer" "$(grep -c "^hang_capture${TAB}incomplete${TAB}no process of the console user's ran $EXCEL_EXE (asked of lsof); 1 program(s) run with the console user's rights ended without an answer" "$MANIFEST")" 1
    : > "$MANIFEST"; ( excel_pids() { EXCEL_PIDS=""; return 0; }; eval "$HLINES"; KILL_CMD=/bin/test; mode_hang ) > /dev/null 2>&1
    is "a search that ran to its end is complete, whatever the hang's copy did" "$(grep -c "^unified_last30m${TAB}complete${TAB}hang capture, 3 entries\$" "$MANIFEST") $(grep -c "^hang_capture${TAB}incomplete" "$MANIFEST")" '1 1'
    # When whether Excel ran was not answered (lsof stopped at its limit), the hang's row does not say that none did
    : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.*
    ( excel_pids() { EXCEL_PIDS=""; EXCEL_CHECK_SAID="lsof, which says which program file each process runs, was stopped at its 30-second limit"; return 2; }; eval "$HLINES"; KILL_CMD=/bin/test; mode_hang ) > /dev/null 2>&1
    is "hang: when whether Excel ran was not answered, the row says that, and not that no process ran it" "$(grep -c "^hang_capture${TAB}incomplete${TAB}whether a process of the console user's ran $EXCEL_EXE is not known; " "$MANIFEST") $(grep -c "no process of the console user's ran" "$MANIFEST")" '1 0'
    # Without a process of Excel's, or when whether there is one was not answered, the run still says, as the menu and
    # the help promise, when Excel can be force-quit: at once, as nothing is asked of any Excel process
    x=""
    for xrc in 0 2; do
        : > "$LOG"; : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.*
        ( excel_pids() { EXCEL_PIDS=""; EXCEL_CHECK_SAID="MADE-UP"; return "$xrc"; }; eval "$HLINES"; mode_hang ) > /dev/null 2>&1
        x="${x:+$x }$(grep -n -e '^Nothing is asked of any Excel process in this run: Excel can be force-quit now (Option-Command-Esc)\. The capture goes on with Excel.s logs and the unified log\.$' -e "^Copying Excel's logs\$" "$LOG" | sed 's/:.*//' | tr '\n' ' ' | awk '{ print ($1 < $2 && NF == 2) ? "said first" : "not said: " $0 }')"
    done
    is "hang without a process of Excel's, or not knowing of one, says that Excel can be force-quit, before its logs are copied" "$x" 'said first said first'; x=""
    # A search that ran to its end and found nothing says what was recorded, and gives no reason for it. The words
    # still start with "ok, nothing found", which the viewer reads as a day searched to its end.
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; FAKE_N=0; ( eval "$ULINES"; collect_unified ) > /dev/null 2>&1
    : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.*; ( excel_pids() { EXCEL_PIDS=""; return 0; }; eval "$HLINES"; KILL_CMD=/bin/test; mode_hang ) > /dev/null 2>&1; FAKE_N=""
    is "a day and a half hour with nothing found say only what was recorded" "$(sed -n 2p "$U/collection_status.txt") | $(grep -c '^  ok, nothing found: log show, the labeller and the writing of the rows ended with 0, and the file holds no entry for that half hour$' "$LOG") $(grep -c -i 'no longer has logs\|no matching' "$LOG")" \
        '2099-01-01 | ok, nothing found: log show, the labeller and the writing of the rows ended with 0, and the file holds no entry for this day | 1 0'
    # An access check that ends with an error is said as that, with its status, and as no day searched: not as a
    # lack of rights, which is only one of the ways it can end
    DAYS=1; UNTIL=2099-01-01; : > "$LOG"; : > "$MANIFEST"; rm -rf "$U"; FAKE_ACCESS=64; ( eval "$ULINES"; collect_unified ) > /dev/null 2>&1
    : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.* "$OUT/unified_access_check.txt"; ( excel_pids() { EXCEL_PIDS=""; return 0; }; eval "$HLINES"; mode_hang ) > /dev/null 2>&1; FAKE_ACCESS=""
    is "an access check that ended with an error says so, and no reason" "$(sed -n 2p "$U/collection_status.txt") | $(grep -c "^unified_last30m${TAB}skipped${TAB}the access check (log show of the last minute) ended with an error; see unified_access_check.txt\$" "$MANIFEST") $(cat "$LOG" "$MANIFEST" | grep -c -i 'insufficient\|run with admin rights')" \
        'access check | skipped: log show of the last minute ended with status 64; no day was searched | 1 0'
    # Hang mode says that Excel can be force-quit as soon as nothing more is asked of its process, before the logs are
    # copied and searched, and promises no time
    : > "$LOG"; : > "$MANIFEST"; rm -f "$OUT"/unified_last30m.*
    ( first_excel() { EXCEL_PID=99999$$; return 0; }; still_excel() { return 1; }; eval "$HLINES"; mode_hang ) > /dev/null 2>&1
    is "hang: Excel is said to be free to force-quit right after the steps that look at it, before its logs are copied" \
        "$(grep -n -e 'Leave Excel as it is until a line here says that it can be force-quit' -e '^Nothing more is asked of PID 99999'"$$"' in this run: Excel can be force-quit now' -e "^Copying Excel's logs\$" -e '^Unified log, last 30 minutes$' -e '^Hang capture complete\.$' "$LOG" | sed 's/:.*//' | tr '\n' ' ' | awk '{ print ($1 < $2 && $2 < $3 && $3 < $4 && $4 < $5 && NF == 5) ? "in order" : "not in order: " $0 }') $(grep -c -i 'under a minute\|before they rotate' "$LOG")" 'in order 0'
    SINCE=$KEEP_SINCE
else
    bad "jq is not on this Mac, so how unified-log searches are said was not checked"
fi
# The repro snapshots: each counts what it saw, and the final one is not undone by the steps after it
: > "$LOG"; : > "$MANIFEST"; mkdir -p "$OUT/repro"
( eval "$SLINES"; KILL_CMD=/bin/test; capture_repro_snapshot final ) > /dev/null 2>&1
is "a repro snapshot whose copy ended without an answer is not complete" "$(grep -c "^repro_final${TAB}incomplete${TAB}Excel and system snapshot; 2 program(s) run with the console user's rights ended without an answer" "$MANIFEST")" 1
# How the live stream ended: by itself, before it was stopped, or stopped by this script
stubs() { capture_repro_snapshot() { :; }; collect_system() { :; }; collect_office() { :; }; discover_sources() { :; }; collect_reports() { :; }; workbook_facts() { :; }; write_source_catalog() { :; }; }
: > "$MANIFEST"; echo "0 0 0 0" > "$OUT/repro/.stream_end"
( eval "$RLINES"; stubs; ( : ) & REPRO_LOG_PID=$!; REPRO_WATCH_PID=""; REPRO_OWN_GROUP=1; repro_finish ) > /dev/null 2>&1
is "a live stream that had ended before this script stopped it is said, and the repro row is not complete" "$(grep -c "^repro${TAB}incomplete${TAB}.*the live log stream had ended before this script stopped it (log stream status 0, labeller status 0)\$" "$MANIFEST")" 1
: > "$MANIFEST"; rm -f "$OUT/repro/.stream_end"
( R="$OUT/repro"; ( trap 'echo "143 0 0 0" > "$R/.stream_end"; exit 0' TERM; while :; do sleep 0.1; done ) & sp=$!
  echo "$sp" > "$R/.stream_pid"; eval "$RLINES"; stubs; REPRO_LOG_PID=$sp; REPRO_WATCH_PID=""; repro_finish; echo "$REPRO_STREAM_SAID" > "$WORK/ends/stream-said" ) > /dev/null 2>&1
is "a live stream stopped by this script, all of it written: the repro row is complete" "$(grep -c "^repro${TAB}complete${TAB}" "$MANIFEST") $(cat "$WORK/ends/stream-said")" '1 captured from when the stream was started until this script stopped it'
# A hangup ends the stream's programs as well: the stream's shell writes that down, and that is what is said
: > "$MANIFEST"; echo "0" > "$OUT/repro/.stream_end"; : > "$OUT/repro/.stream_hup"
( eval "$RLINES"; stubs; ( : ) & REPRO_LOG_PID=$!; REPRO_WATCH_PID=""; repro_finish ) > /dev/null 2>&1
is "a live stream that a hangup reached is said to be that, with no order claimed, and nothing is said about a write" "$(grep -c "^repro${TAB}incomplete${TAB}.*a hangup signal reached the shell that ran the live log stream, before or while this script stopped the stream, so how the stream's programs ended, and whether all of what log stream sent was written, is not known" "$MANIFEST") $(grep -c 'could not be written\|ended by itself\|before this script stopped it' "$MANIFEST") $([ -e "$OUT/repro/.stream_hup" ] && echo left || echo removed)" '1 0 removed'
: > "$MANIFEST"; echo "x" > "$OUT/repro/.stream_end"
( eval "$RLINES"; stubs; ( : ) & REPRO_LOG_PID=$!; REPRO_WATCH_PID=""; repro_finish ) > /dev/null 2>&1
is "statuses that are not there are said to be that, and not blamed on a write" "$(grep -c "how the live log stream ended is not known: the file its shell writes that into holds no statuses" "$MANIFEST")" 1
# The program between the live stream and its labeller: its 4 (a write into the labeller's pipe that failed) and any
# other end of its own are each said as that, and the row is not complete (the stand-in stream here had ended before)
x=""
for e in "0 4 0 0" "0 137 0 0"; do
    : > "$MANIFEST"; echo "$e" > "$OUT/repro/.stream_end"
    ( eval "$RLINES"; stubs; ( : ) & REPRO_LOG_PID=$!; REPRO_WATCH_PID=""; REPRO_OWN_GROUP=1; repro_finish ) > /dev/null 2>&1
    x="${x:+$x | }$(awk -F'\t' '$1 == "repro" { sub(/^[^;]*; /, "", $3); print $2 ": " $3 }' "$MANIFEST")"
done
is "the program between the live stream and its labeller: a failed write and its own end are each said, and the row is not complete" "$x" \
    'incomplete: the live log stream had ended before this script stopped it (log stream status 0, labeller status 0); the labeller of the live log stream stopped reading before the end of what log stream sent | incomplete: the live log stream had ended before this script stopped it (log stream status 0, labeller status 0); the program that passes the live log stream on to the labeller ended with status 137'
is "the stream's shell writes a hangup down" "$(sed -n '/^mode_repro() {/,/^}$/p' "$SCRIPT" | grep -c "( trap ': 2>/dev/null > \"\$R/.stream_hup\"' HUP\$")" 1
# An interrupt before the live stream was started: nothing is said of a stream that never ran, and no file of it is named
: > "$LOG"; : > "$MANIFEST"; rm -rf "$OUT/repro"
( eval "$RLINES"; stubs; IN_TRAP=1; repro_finish; echo "$REPRO_STREAM_SAID" > "$WORK/ends/stream-said" ) > /dev/null 2>&1
is "a stream that was never started is said to be that, and nothing else is said of it" "$(cat "$WORK/ends/stream-said") | $(grep -c "^repro${TAB}incomplete${TAB}live unified-log stream (the bundle holds no file of it); the live log stream was not started: the run was stopped before it was\$" "$MANIFEST") $(cat "$LOG" "$MANIFEST" | grep -c 'Stopping the live capture\|how the live log stream ended\|unified_live_unfiltered')" 'not started: the run was stopped before the stream was | 1 0'
# An interrupt between the start of the stream's shell and the line that writes its process down: it is found, and
# stopped and waited for all the same (here log stream's stand-in writes its own process down only after a moment)
: > "$MANIFEST"; mkdir -p "$OUT/repro"; rm -f "$OUT/repro/.stream_pid" "$OUT/repro/.stream_end"
( R="$OUT/repro"; eval "$RLINES"; stubs; REPRO_BEFORE=$!; REPRO_STREAM_STARTED=1
  ( sleep 0.5; /bin/sh -c 'echo $$ > "$1"; trap "exit 0" TERM; while :; do sleep 0.1; done' "repro-pick-$$" "$R/.stream_pid"; echo "0 0 0 0" > "$R/.stream_end" ) &
  repro_finish; echo "$REPRO_STREAM_SAID" > "$WORK/ends/stream-said" ) > /dev/null 2>&1
sleep 0.3
is "a stream whose shell was started and not yet written down is stopped and waited for" "$(cat "$WORK/ends/stream-said") $(pgrep -f "repro-pick-$$" | wc -l | tr -d ' ')" 'captured from when the stream was started until this script stopped it 0'
sleep 0.5; pkill -f "repro-pick-$$" 2>/dev/null       # (when it was not waited for, its stand-in starts only now)
# Stopped after the stream had ended (mode_repro had called repro_finish), while the steps after it ran: the row they
# end with is written by the interrupt handling, once, as the row of a run stopped before the end of repro, with how
# the stream ended
: > "$MANIFEST"; mkdir -p "$OUT/repro"; rm -f "$OUT/repro/unified_live_unfiltered.tsv"
( eval "$RLINES"; stubs; REPRO_FINISHED=1; REPRO_WHY="the live log stream was cut once 10 GB of it had arrived; what came after that was not kept; "
  IN_TRAP=1; repro_finish; repro_finish ) > /dev/null 2>&1
is "repro stopped after its stream had ended writes its row once, as stopped before the end of repro, with how the stream ended" \
    "$(grep -c "^repro${TAB}incomplete${TAB}live unified-log stream (the bundle holds no file of it); the run was stopped before the end of repro, where this row is written; the live log stream was cut once 10 GB of it had arrived; what came after that was not kept\$" "$MANIFEST") $(grep -c "^repro${TAB}" "$MANIFEST")" '1 1'
# Not stopped: the row is written at the end of repro_finish, once, and the interrupt handling writes no second one
: > "$MANIFEST"; mkdir -p "$OUT/repro"; echo "0 0 0 0" > "$OUT/repro/.stream_end"
( eval "$RLINES"; stubs; ( : ) & REPRO_LOG_PID=$!; REPRO_WATCH_PID=""; REPRO_OWN_GROUP=1; repro_finish; IN_TRAP=1; repro_finish ) > /dev/null 2>&1
is "a repro row written at its end is not written again by the interrupt handling" "$(grep -c "^repro${TAB}" "$MANIFEST")" 1
# The summary says that it does not count itself among the files
WSLINES=$(bounded "$(sed -n '/^write_summary() {/,/^}$/p' "$SCRIPT")" 160 '^}$')
( eval "$WSLINES"; MODE=hang; REDACT=0; COLLECTOR_VERSION=x; write_summary ) > /dev/null 2>&1
is "the summary's count of files says it does not count the summary" "$(grep -c '^- Files before ZIP packaging, this summary not counted: [0-9]* (' "$OUT/summary.md")" 1
# The summary names only files that are in its bundle, with what each holds, under the names this run gave them; and
# its list of restarts says whether a day was searched at all. sumrun NAME MODE LOG_EXT DAYS-STARTED FILE... - a
# made-up bundle holding FILE..., and its summary
sumrun() {
    local b="$WORK/summaries/$1" f
    rm -rf "$b"; mkdir -p "$b"
    ( OUT="$b"; MANIFEST="$b/manifest.tsv"; LOG="$b/collection.log"; printf '%s' "${SUMROWS:-}" > "$MANIFEST"; MODE=$2; LOG_EXT=$3; UNIFIED_DAYS=$4; shift 4
      for f in "$@"; do mkdir -p "$(dirname "$b/$f")"; printf '%s\n' "$LABEL_HEADER_T" > "$b/$f"; done
      [ -n "${SUMSTATUS:-}" ] && printf '%s' "$SUMSTATUS" > "$b/unified_logs/collection_status.txt"
      eval "$WSLINES"; REDACT=0; COLLECTOR_VERSION=x; SINCE=2099-01-01; UNTIL=2099-01-01; DAYS=1; MAX_WAIT=3; write_summary ) > /dev/null 2>&1
    S_MD="$b/summary.md"
}
# reviewed - the paths summary.md names under Review first, one a line; missing - those of them that are not there
reviewed() { sed -n '/^## Review first$/,/^## /p' "$S_MD" | sed -n 's/^[0-9][0-9]*\. `\([^`]*\)`: .*\.$/\1/p'; }
missing() { local p; reviewed | while IFS= read -r p; do [ -e "$(dirname "$S_MD")/$p" ] || echo "$p"; done | tr '\n' ' '; }
LABEL_HEADER_T=$'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage'
sumrun hang hang tsv 0 collection.log unified_last30m.tsv excel_spindump.txt excel_footprint.txt excel_open_files.txt case/incident_context.md
is "hang: the summary names only files that are in the bundle, the half hour's search among them" \
    "[$(missing)] $(reviewed | tr '\n' ' ')" '[] case/incident_context.md collection.log unified_last30m.tsv excel_spindump.txt excel_footprint.txt excel_open_files.txt '
is "hang: the example and the list of unified-log files name the file that is there" \
    "$(grep -c "^    awk -F'\\\\t' '.*' unified_last30m.tsv\$" "$S_MD") $(grep -c 'unified_logs/' "$S_MD") $(grep -c '^## Restarts' "$S_MD") $(grep -c -i 'direct evidence\|commonly\|was forced\|got stuck' "$S_MD")" '1 0 0 0'
sumrun repro repro ndjson 0 collection.log repro/unified_live_unfiltered.ndjson repro/baseline/x repro/final/x excel_memory_timeline.csv reports/crash_summary.txt source_catalog.tsv office/discovered_sources.tsv
is "repro without jq: the live stream is named with its own ending, and no .tsv is named" \
    "[$(missing)] $(reviewed | grep -c 'unfiltered\.ndjson') $(grep -c 'unified_live_unfiltered\.tsv\|## Filtering\|awk -F' "$S_MD")" '[] 1 0'
sumrun collect-none collect tsv 0 collection.log
is "collect with no day searched: the list of restarts says that no day was searched" \
    "$(grep -c '^- None listed: no day of the unified log was searched (see `collection.log`)\.$' "$S_MD") $(grep -c 'None found' "$S_MD")" '1 0'
sumrun collect-empty collect tsv 2 collection.log unified_logs/collection_status.txt unified_logs/2099-01-01.tsv unified_logs/2099-01-02.tsv
is "collect with days searched and no restart in them: none in those days, and the example names their files" \
    "$(grep -c '^- None in the rows kept from the 2 day(s) whose search was started (see `unified_logs/collection_status.txt`)\.$' "$S_MD") $(grep -c "^    awk .* unified_logs/\*\.tsv\$" "$S_MD") [$(missing)]" '1 1 []'
printf '2099-01-01 00:00:01-0000\t\tDefault\tkernel\t0\t\t\t\trestart\tPrevious shutdown cause: 5\n2099-01-01 00:00:02-0000\t\tDefault\tkernel\t7\t\t\t\trestart\tPrevious shutdown cause: 3\n' >> "$WORK/summaries/collect-empty/unified_logs/2099-01-01.tsv"
( OUT="$WORK/summaries/collect-empty"; MANIFEST="$OUT/manifest.tsv"; LOG="$OUT/collection.log"; MODE=collect; LOG_EXT=tsv; UNIFIED_DAYS=2; eval "$WSLINES"; REDACT=0; COLLECTOR_VERSION=x; SINCE=2099-01-01; UNTIL=2099-01-01; DAYS=1; MAX_WAIT=3; write_summary ) > /dev/null 2>&1
is "a restart the kernel logged is listed as it was logged, with no reading of its value" \
    "$(grep -c '^- 2099-01-01 00:00:01-0000: Previous shutdown cause: 5$' "$S_MD") $(grep -c 'cause: 3' "$S_MD") $(sed -n '/^## Restarts$/,/^## /p' "$S_MD" | grep -c -i 'mean\|normal\|forced\|power\|stuck')" '1 0 0'
# summary.md points at a row of the status table only when the row is there, and says for how many of the days whose
# search was started unified_logs/collection_status.txt has a line
sumrun hang-norow hang tsv 0 collection.log unified_last30m.tsv
x="$(grep -c 'unified_last30m in manifest.tsv says' "$S_MD") $(grep -c '(manifest.tsv has no unified_last30m row, so whether it was searched to its end is not said)\.$' "$S_MD")"
SUMROWS="unified_last30m${TAB}incomplete${TAB}x${NL}"; sumrun hang-row hang tsv 0 collection.log unified_last30m.tsv; SUMROWS=""
is "the summary points at the half hour's row only when it is there" "$x $(grep -c '(unified_last30m in manifest.tsv says whether it was searched to its end)\.$' "$S_MD") $(grep -c 'has no unified_last30m row' "$S_MD")" '0 1 1 0'
sumrun repro-norow repro tsv 0 collection.log repro/unified_live_unfiltered.tsv
x="$(grep -c 'the repro row in manifest.tsv says' "$S_MD") $(grep -c '(manifest.tsv has no repro row, so how the stream ended and whether it was cut is not said there)\.$' "$S_MD")"
SUMROWS="repro${TAB}complete${TAB}x${NL}"; sumrun repro-row repro tsv 0 collection.log repro/unified_live_unfiltered.tsv; SUMROWS=""
is "the summary points at the repro row only when it is there" "$x $(grep -c '(the repro row in manifest.tsv says how it ended and whether it was cut)\.$' "$S_MD")" '0 1 1'
SUMSTATUS="Date | Status${NL}2099-01-01 | ok (3 entries)${NL}"; sumrun days-short collect tsv 2 collection.log unified_logs/collection_status.txt
x=$(grep -c '^[0-9]*\. `unified_logs/collection_status.txt`: how the search of 1 of the 2 day(s) of the unified log whose search was started ended; the others have no line in it\.$' "$S_MD")
SUMSTATUS="Date | Status${NL}2099-01-01 | ok (3 entries)${NL}2099-01-02 | ok (1 entries)${NL}"; sumrun days-all collect tsv 2 collection.log unified_logs/collection_status.txt; SUMSTATUS=""
is "the summary says for how many of the days started the status file has a line" "$x $(grep -c '^[0-9]*\. `unified_logs/collection_status.txt`: how the search of each day of the unified log whose search was started ended\.$' "$S_MD")" '1 1'
# A run stopped during a search writes what the search would have written when it ended, as a search the run was
# stopped in: the day's line in collection_status.txt, and hang's half-hour row, each once
SR="$WORK/stopped-rows"; rm -rf "$SR"; mkdir -p "$SR/unified_logs"; printf 'Date | Status\n' > "$SR/unified_logs/collection_status.txt"
printf '%s\n' "$LABEL_HEADER_T" a b > "$SR/unified_logs/2099-01-05.tsv"
( OUT="$SR"; MANIFEST="$SR/manifest.tsv"; LOG="$SR/collection.log"; : > "$MANIFEST"; LOG_EXT=tsv; UNIFIED_DAY_NOW=2099-01-05; HANG_SEARCH_NOW=1; stopped_rows; stopped_rows ) > /dev/null 2>&1
is "a run stopped during a search writes the day's line and the half hour's row, each once, as stopped" \
    "$(sed -n '2,$p' "$SR/unified_logs/collection_status.txt" | tr '\n' '|') $(grep -c "^unified_last30m${TAB}incomplete${TAB}hang capture; the run was stopped before how this search ended was written down (it has no file)\$" "$SR/manifest.tsv") $(wc -l < "$SR/manifest.tsv" | tr -d ' ')" \
    "2099-01-05 | stopped: the run was stopped before how this day's search ended was written down (2 entries are in its file)| 1 1"
is "the interrupt handling writes them, and the searches say when they are going on" \
    "$(grep -c '^trap .*; watch_row; stopped_rows; note .Stopped - packaging' "$SCRIPT") $(sed -n '/^collect_unified() {/,/^}$/p' "$SCRIPT" | grep -c '^ *UNIFIED_DAY_NOW=') $(sed -n '/^mode_hang() {/,/^}$/p' "$SCRIPT" | grep -c '^ *HANG_SEARCH_NOW=')" '1 2 2'
# A hand-over that root makes itself, stopped at its budget, does not say that the user's rights were used
eval "plain_perl() $(declare -f _ends_real | tail -n +2)"; unset -f _ends_real
root_only() { [ -d "$1" ] || return 1; case "$1" in "$WORK/roots2"|"$WORK/roots2"/*) return 0 ;; esac; return 1; }
mkdir -p "$WORK/roots2"; stage roots2; rmdir "$DEST"; DEST="$WORK/roots2/dest"; : > "$WORK/said.txt"; HAND_OVER_SECONDS=0
deliver; HAND_OVER_SECONDS=3600; eval "$REAL_ROOT_ONLY"
is "a hand-over by root stopped at its budget says so, without naming the console user's rights" "$(grep -c '^The hand-over was stopped: the 0 seconds allowed for all of its steps were used up\.$' "$WORK/said.txt") $(grep -c "console user's rights" "$WORK/said.txt")" '1 0'
AM_ROOT=0; HOME_SHUT=0
# The help says in what order the exit statuses apply, and that 4 can leave some of the results moved
HELP=$(/bin/bash "$SCRIPT" --help 2>/dev/null)
is "the help gives the order of the exit statuses, and that 4 can be some of the results" "$(printf '%s\n' "$HELP" | tr '\n' ' ' | grep -c 'When more than one of these applies, the script ends with the first of them in this order: 1, 3, 4, 130\.') $(printf '%s\n' "$HELP" | tr '\n' ' ' | grep -c 'some of them, or all, were left in the working folder')" '1 1'
# The help says what each mode does, and no time it cannot keep
H1=$(printf '%s\n' "$HELP" | tr '\n' ' ' | tr -s ' ')
is "the help promises no time for hang mode, and says when Excel can be force-quit" "$(printf '%s\n' "$H1" | grep -c -i 'under a minute') $(printf '%s\n' "$H1" | grep -c 'its open files and network connections, then says that Excel can be force-quit; then copies')" '0 1'
is "the help gives no time per day of logs, and calls the interval a wait after each sample" "$(printf '%s\n' "$H1" | grep -c '2-8 minutes') $(printf '%s\n' "$H1" | grep -c -- '--interval S Seconds to wait after each sample')" '0 1'
is "the help gives the rule reports are picked by, not 30 days for every report" "$(printf '%s\n' "$H1" | grep -c 'always cover at least 30 days') $(printf '%s\n' "$H1" | grep -c "Of those changed in the last 30 days (or in as many days as are searched, when that is more), so is each whose name holds excel, office or microsoft, starts with jetsam or WindowServer, or ends in .hang, .spin or .panic")" '0 1'
is "the help says the reports are taken for copying, and where what was not copied is said, not that every one is copied" \
    "$(printf '%s\n' "$H1" | grep -c 'Every diagnostic report changed since the start of the first incident date is taken for copying\.') $(printf '%s\n' "$H1" | grep -c 'a name that starts with a dot is passed over\. source_catalog.tsv gives the rule with its times; the status table and collection.log say what was not copied, and why\.') $(printf '%s\n' "$H1" | grep -c 'incident date is copied')" '1 1 0'
is "the bundle names files and folders by the test that picked them, not by a role" \
    "$(grep -c -i -e 'crash, hang, spin and jetsam reports' -e 'Crash and hang report summary' -e 'Force-quit and usage records' -e 'force-quit record' -e "Excel's AutoRecover folders" -e 'crash/hang/spin/jetsam' "$SCRIPT") $(grep -c -F '"office/autorecover_inventory.txt|for the folders Library/Application Support/Microsoft and Library/Preferences/AutoRecovery of Excel'"'"'s container, the files whose name holds autorecover or ends in .xar (in any case) or starts with ~ar, with when each last changed, and the files over 10 MB of any name"' "$SCRIPT") $(grep -c '^        echo "# Diagnostic report summary"$' "$SCRIPT")" '0 1 1'
is "the help says what --no-sudo collects, what status 3 is, and that an --archive .logarchive ends with 3" \
    "$(printf '%s\n' "$H1" | grep -c "collect what the account that runs the script can read") $(printf '%s\n' "$H1" | grep -c '3 = a zip was made but the --redact step failed or did not end complete') $(printf '%s\n' "$H1" | grep -c 'or if the bundle holds an --archive .logarchive') $(printf '%s\n' "$H1" | grep -c 'unprivileged\|why it was included\|names were not hidden or not all')" '1 1 1 0'
is "steps name what they ran, not what it is for" "$(grep -c 'VPN, security, content filters\|final evidence\|its messages are in collection.log\|(Excel, hangs/terminations' "$SCRIPT")" 0
is "the menu promises no time for a frozen Excel" "$(grep -c -i 'under a minute' "$SCRIPT")" 0
is "the re-run with sudo names spindump for hang mode only" "$(grep -c 'needs admin rights for system logs, hang reports and spindump' "$SCRIPT") $(grep -c '^        hang) echo "Re-running with sudo, so that this mode reads the unified log and runs spindump as root\.\.\." ;;$' "$SCRIPT")" '0 1'
is "watch says which process ids it saw, not what became of the process" "$(grep -c '(it was PID\|is now PID\|quit/crash\|was relaunched' "$SCRIPT") $(grep -c 'The lowest process ID of \$CONSOLE_USER.s processes that run \$EXCEL_EXE is \$pid at this sample' "$SCRIPT")" '0 1'

# ---- programs root runs with a time limit ---------------------------------------------------------------------------
# run_limited gives a program a process group of its own, writes it down in the working folder while it runs, closes
# its descriptors from 3 up, and stops all of its group: at the limit, when it is itself told to stop, and through
# stop_groups for a group whose runner did not. MARK is a number no other sleep is given.
RL="$WORK/runner"; mkdir -p "$RL"; KEEP_STAGE=$STAGE; STAGE="$RL"; MARK=7$$
SECONDS=0; run_limited 2 /bin/sh -c "trap '' TERM; /bin/sleep $MARK & /bin/sleep $MARK"; rc=$?; took=$SECONDS; sleep 0.3
is "a program stopped at its limit: 124, in time, nothing it started is left, and its group is no longer written down" \
    "$rc $([ $took -le 9 ] && echo 'in time' || echo "after $took s") $(pgrep -f "sleep $MARK" | wc -l | tr -d ' ') $(ls -A "$RL/.groups" 2>/dev/null | wc -l | tr -d ' ')" '124 in time 0 0'
pkill -KILL -f "sleep $MARK" 2>/dev/null
run_limited 5 /bin/sh -c 'echo x >&5' 5>/dev/null 2>/dev/null
is "the program is not given this script's descriptors from 3 up (the screen is kept on 5 and 6)" "$([ $? -ne 0 ] && echo closed || echo open)" closed
# Ctrl-C reaches the script's process group: the program, in a group of its own, is stopped with it, and a reader of
# the output is not held open after the script has ended
{ declare -f plain_perl run_limited stop_groups; declare -p LIMIT_PL
  echo 'HAVE_PERL=1; STAGE=$1; trap "stop_groups; exit 130" INT'
  echo "run_limited 30 /bin/sleep $MARK | cat"; echo 'echo went on'; } > "$RL/int.sh"
SECONDS=0
( /usr/bin/perl -e '$SIG{INT} = "DEFAULT"; setpgrp(0, 0); exec @ARGV' /bin/bash "$RL/int.sh" "$RL" > "$RL/int.out" 2>&1 & echo $! > "$RL/int.pid"; wait ) &
held=$!; sleep 1; kill -INT -- "-$(cat "$RL/int.pid")" 2>/dev/null
n=0; while kill -0 "$held" 2>/dev/null && [ $n -lt 40 ]; do sleep 0.25; n=$((n + 1)); done; took=$SECONDS; sleep 0.3
is "Ctrl-C ends the program run with a time limit, and nothing holds the output open" "$([ $took -le 8 ] && echo 'in time' || echo "after $took s") $(pgrep -f "sleep $MARK" | wc -l | tr -d ' ') $(grep -c 'went on' "$RL/int.out")" 'in time 0 0'
pkill -KILL -f "sleep $MARK" 2>/dev/null
# A runner that cannot stop its program itself (it was started with Ctrl-C ignored): stop_groups stops the group
( trap '' INT; run_limited 0 /bin/sleep "$MARK" ) & bg=$!
sleep 1; stop_groups; sleep 0.5
is "a group that is written down is stopped by stop_groups" "$(pgrep -f "sleep $MARK" | wc -l | tr -d ' ') $(ls -A "$RL/.groups" 2>/dev/null | wc -l | tr -d ' ')" '0 0'
# A mark whose number another group has taken since it was made: that group is not killed, and the mark goes
( exec /usr/bin/perl -e 'setpgrp(0, 0); exec "/bin/sleep", $ARGV[0]' "${MARK}9" ) & other=$!; sleep 1
mkdir -p "$RL/.groups"; : > "$RL/.groups/$other"; touch -t 200001010000 "$RL/.groups/$other"
stop_groups; sleep 0.3
is "a group that has only taken the number of a mark is not killed" "$(kill -0 "$other" 2>/dev/null && echo alive || echo killed) $(ls -A "$RL/.groups" | wc -l | tr -d ' ')" 'alive 0'
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null
pkill -KILL -f "sleep $MARK" 2>/dev/null; kill "$bg" 2>/dev/null; wait "$bg" 2>/dev/null
is "the interrupt handling stops the groups before the packaging" "$(grep -c '^trap .*exec 1>&5 2>&6; stop_groups; .*kill $(jobs -p) 2>/dev/null; stop_groups; finalize; ' "$SCRIPT")" 1
# repro, with log stream and the watch stood in for: the live stream is cut at its limit (here 0 GB) and the repro row
# says so; the watch beside the script is stopped with the wait it was in
RP="$WORK/repro-run"; mkdir -p "$RP/bundle"
printf '#!/bin/sh\ni=0; while [ $i -lt 50 ]; do i=$((i + 1)); echo "{\\"timestamp\\":\\"2099-01-02 03:04:05.000000+0000\\",\\"processImagePath\\":\\"/x/made-up\\",\\"processID\\":1,\\"eventMessage\\":\\"MADE-UP $i\\"}"; done\n' > "$RP/fake-stream"
chmod +x "$RP/fake-stream"
MRLINES=$(bounded "$(sed -n '/^mode_repro() {/,/^}$/p' "$SCRIPT")" 60 '^}$' | sed "s#/usr/bin/log stream --style ndjson --level debug#$RP/fake-stream#")
SECONDS=0
( OUT="$RP/bundle"; STAGE="$RP"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"; HOURS=0; REPRO_STREAM_GB=0
  REPRO_FINISHED=""; REPRO_LOG_PID=""; REPRO_WATCH_PID=""
  eval "$MRLINES"; eval "$RLINES"; stubs; capture_repro_snapshot() { :; }
  mode_watch() { while :; do run_limited 0 /bin/sleep "$MARK"; done; }
  mode_repro ) > /dev/null 2>&1 &
rp=$!; n=0; while kill -0 "$rp" 2>/dev/null && [ $n -lt 80 ]; do sleep 0.25; n=$((n + 1)); done
took=$SECONDS; sleep 0.3; left=$(pgrep -f "sleep $MARK" | wc -l | tr -d ' '); pkill -KILL -f "sleep $MARK" 2>/dev/null; wait "$rp" 2>/dev/null
is "repro: the live stream is cut at its limit, and the row says so" "$(grep -c "^repro${TAB}incomplete${TAB}.*the live log stream was cut once 0 GB of it had arrived; what came after that was not kept" "$RP/bundle/manifest.tsv") $(grep -c 'MADE-UP' "$RP/bundle/repro/unified_live_unfiltered.$LOG_EXT" 2>/dev/null)" '1 0'
is "repro: the watch beside the script is stopped with its wait, in time" "$([ $took -le 15 ] && echo 'in time' || echo "after $took s") $left" 'in time 0'
is "repro: the reproduction is asked for only after the live stream and the timeline have been started" \
    "$(grep -n -e '^Reproduction capture is starting: a first snapshot, then the live log stream\. Do not reproduce the problem yet\.$' -e '^Starting unfiltered live unified-log stream' -e '^The live log stream and the memory timeline have been started\. Reproduce the problem now' "$RP/bundle/collection.log" | sed 's/:.*//' | tr '\n' ' ' | awk '{ print ($1 < $2 && $2 < $3 && NF == 3) ? "in order" : "not in order: " $0 }') $(grep -c 'Reproduce the problem' "$SCRIPT")" 'in order 1'
STAGE=$KEEP_STAGE
# What the cut-down runs below take from the collector, in a file they read: functions and programs, as this test
# took them out (each checked when it was taken out), and the interrupt handling itself
TRAP_LINE=$(bounded "$(grep '^trap .\[ -n "\$IN_TRAP" \] || {' "$SCRIPT")" 1 "INT TERM HUP QUIT\$")
WLINES=$(bounded "$(sed -n '/^mode_watch() {/,/^}$/p' "$SCRIPT")" 70 '^}$')
[ -n "$TRAP_LINE" ] && [ -n "$WLINES" ] || bad "could not take the interrupt handling or the watch out of $SCRIPT"
cut_down() {
    { declare -f plain_perl capped put label_entries run_limited stop_groups same_group step_begin row log_line unwritten repro_stop watch_row repro_row stopped_rows count_entries
      printf '%s\n' "$RLINES"
      declare -p PERL_CMD STREAM_PL LIMIT_PL ROW_ESCAPE_PL LABEL_HEADER LABEL_JQ TAG_PERMISSIONS_RX TAG_STORAGE_RX JQ EXCEL_PROC EXCEL_NAME LOG_EXT
      printf 'TRAP_LINE=%q\n' "$TRAP_LINE"
      cat <<'CUT_DOWN'
exec 5>/dev/null 6>/dev/null
OUT="$W/bundle"; STAGE="$W"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; mkdir -p "$OUT/repro"; : > "$LOG"; : > "$MANIFEST"
HOURS=0; INTERVAL=1; REPRO_STREAM_GB=10; WRITES_LOST=0; ROWS_LOST=0; HAVE_PERL=1; AM_ROOT=0
note() { echo "$*" >> "$LOG"; }; record_status() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$MANIFEST"; }; home_closed() { return 1; }
capture_repro_snapshot() { :; }; collect_office() { :; }; discover_sources() { :; }; collect_reports() { :; }; workbook_facts() { :; }; write_source_catalog() { :; }
collect_system() { :; }
CUT_DOWN
    } > "$1"
}
# Beside repro, log stream is in a process group of its own: the Ctrl-C that the screen asks for, which the terminal
# sends to the script's whole group, does not end it before the script stops it (log stream ends on SIGINT, though
# the shell starts it with SIGINT ignored, as the stand-in here does). Run with SIGINT as the terminal leaves it.
IR="$WORK/int-repro"; mkdir -p "$IR"
printf '#!/usr/bin/perl\n$SIG{INT} = sub { exit 0 }; $| = 1; my $i = 0;\nwhile (1) { $i++; print qq({"timestamp":"2099-01-02 03:04:05.000000+0000","processImagePath":"/x/made-up","processID":1,"eventMessage":"MADE-UP $i"}\\n); select undef, undef, undef, 0.02 }\n' > "$IR/int-stream"
chmod +x "$IR/int-stream"
cut_down "$IR/env"
MRI=$(printf '%s\n' "$MRLINES" | sed "s#$RP/fake-stream#$IR/int-stream#")
{ echo 'W=$1; . "$W/env"; MODE=repro'; printf '%s\n' "$MRI"
  echo 'mode_watch() { while :; do run_limited 0 /bin/sleep 30.4; done; }'
  echo 'finalize() { echo "$REPRO_STREAM_SAID" > "$W/said"; FINAL_STATUS=0; }'
  echo 'eval "$TRAP_LINE"; mode_repro; finalize; exit 0'; } > "$IR/run.sh"
/usr/bin/perl -e 'setpgrp(0, 0); $SIG{$_} = "DEFAULT" for qw(INT QUIT TERM HUP); exec @ARGV' /bin/bash "$IR/run.sh" "$IR" > /dev/null 2>&1 &
ip=$!; n=0; while [ ! -s "$IR/bundle/repro/unified_live_unfiltered.$LOG_EXT" ] && [ $n -lt 40 ]; do sleep 0.25; n=$((n + 1)); done; sleep 1
kill -INT -- "-$ip" 2>/dev/null
n=0; while kill -0 "$ip" 2>/dev/null && [ $n -lt 80 ]; do sleep 0.25; n=$((n + 1)); done; kill -KILL -- "-$ip" 2>/dev/null; wait "$ip" 2>/dev/null
is "repro: the Ctrl-C the screen asks for does not end log stream before the script stops it" "$(cat "$IR/said" 2>/dev/null) | $(grep -c "^repro${TAB}complete${TAB}live unified-log stream (repro/unified_live_unfiltered\.$LOG_EXT)\$" "$IR/bundle/manifest.tsv") $(pgrep -f "$IR/int-stream" | wc -l | tr -d ' ')" 'captured from when the stream was started until this script stopped it | 1 0'
pkill -f "$IR/int-stream" 2>/dev/null; pkill -f 'sleep 30.4' 2>/dev/null
# The interrupt handling is done once, and every pass of it stops the stream and waits for it. "twice": a second signal
# of another kind (a hangup after a TERM) comes while the first pass is collecting, after the stream was stopped; it
# must not package the run then, before the repro row. "once": the TERM comes while repro's own end is waiting for the
# stream; the handling must still wait for the stream before the packaging.
TT="$WORK/trap-twice"; mkdir -p "$TT"; cut_down "$TT/env"
cat > "$TT/run.sh" <<'TWICE_TEST'
W=$1; KIND=$2; . "$W/env"; MODE=repro; R="$OUT/repro"
[ "$KIND" = twice ] && collect_system() { /bin/sleep 3; }
finalize() { echo "$(kill -0 "$SP" 2>/dev/null && echo 'stream running' || echo 'stream ended') $(grep -c '^repro' "$MANIFEST")" > "$W/at-finalize.$KIND"; FINAL_STATUS=0; }
eval "$TRAP_LINE"
REPRO_BEFORE=$!; REPRO_STREAM_STARTED=1
( /bin/sh -c 'echo $$ > "$1"; trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done' "trap-twice-$KIND" "$R/.stream_pid"; echo "0 0 0 0" > "$R/.stream_end" ) &
REPRO_LOG_PID=$!
n=0; while [ ! -s "$R/.stream_pid" ] && [ $n -lt 40 ]; do /bin/sleep 0.1; n=$((n + 1)); done; SP=$(cat "$R/.stream_pid")
case $KIND in
    twice) ( /bin/sleep 0.3; kill -TERM $$; /bin/sleep 2.5; kill -HUP $$ ) & while :; do /bin/sleep 0.2; done ;;
    once) ( /bin/sleep 0.5; kill -TERM $$ ) & repro_finish ;;
esac
finalize
TWICE_TEST
for k in twice once; do
    SECONDS=0; timed 20 /usr/bin/perl -e '$SIG{$_} = "DEFAULT" for qw(INT QUIT TERM HUP); exec @ARGV' /bin/bash "$TT/run.sh" "$TT" "$k" > /dev/null 2>&1
    pkill -f "trap-twice-$k" 2>/dev/null
done
is "a second signal while the interrupt handling collects does not package the run before its repro row" "$(cat "$TT/at-finalize.twice" 2>/dev/null)" 'stream ended 1'
is "an interrupt while repro's end waits for the stream: the stream has ended before the packaging" "$(cat "$TT/at-finalize.once" 2>/dev/null)" 'stream ended 1'
# The watch, stopped before its hours are up (in watch mode by the interrupt handling; here with TERM): its row is
# written, with the lines and snapshots it could not write, and those count for the last lines of the run. Beside repro
# the watch is a shell of its own: told to stop, it writes its row, and how many of its writes failed reaches the
# script by how it ends.
WT="$WORK/watch-term"; mkdir -p "$WT"; cut_down "$WT/env"
{ echo 'W=$1; KIND=$2; . "$W/env"; mkdir -p "$OUT/excel_memory_timeline.csv"'; printf '%s\n' "$WLINES"
  echo 'first_excel() { EXCEL_PID=""; return 0; }; snapshot_memory() { return 4; }'
  echo 'finalize() { echo "$WRITES_LOST" > "$W/lost.$KIND"; FINAL_STATUS=0; }'
  printf 'WATCH_LINE=%q\n' "$(sed -n '/^mode_repro() {/,/^}$/p' "$SCRIPT" | grep '^    ( WATCH_END=32; trap .* TERM; mode_watch; exit .* ) &$' | sed 's/^ *//; s/ &$//')"
  echo 'case $KIND in'
  echo '    watch) MODE=watch; eval "$TRAP_LINE"; mode_watch ;;'
  echo '    repro) MODE=repro; [ -n "$WATCH_LINE" ] || exit 9; eval "$WATCH_LINE &"; REPRO_WATCH_PID=$!; /bin/sleep 2.5; repro_stop; finalize ;;'
  echo 'esac'; } > "$WT/run.sh"
/usr/bin/perl -e '$SIG{$_} = "DEFAULT" for qw(INT QUIT TERM HUP); exec @ARGV' /bin/bash "$WT/run.sh" "$WT" watch > /dev/null 2>&1 &
wp=$!; sleep 2.5; kill -TERM "$wp" 2>/dev/null
n=0; while kill -0 "$wp" 2>/dev/null && [ $n -lt 40 ]; do sleep 0.25; n=$((n + 1)); done; kill -KILL "$wp" 2>/dev/null; wait "$wp"; wst=$?
WROW="^watch${TAB}incomplete${TAB}[0-9]* sample(s), with a wait of 1s between them; 2 time(s) what it had could not all be written into the working folder (see collection.log); [0-9]* line(s) of excel_memory_timeline.csv could not be written into the working folder; [0-9]* snapshot(s) could not all be written into memory_snapshots.txt\$"
is "a watch stopped before its hours are up writes its row, with what it could not write, and that counts for the last lines" "$wst $(grep -c "$WROW" "$WT/bundle/manifest.tsv") $(cat "$WT/lost.watch" 2>/dev/null)" '130 1 2'
timed 20 /bin/bash "$WT/run.sh" "$WT" repro > /dev/null 2>&1
is "beside repro the watch writes its row when it is stopped, and what it could not write reaches the script" "$(grep -c "$WROW" "$WT/bundle/manifest.tsv") $(cat "$WT/lost.repro" 2>/dev/null)" '1 2'
pkill -f 'sleep 30.4' 2>/dev/null

# ---- streams whose size the console user sets ---------------------------------------------------------------------
# capped passes on so much and says where it cut; the cut is made in what is read, so what writes into it goes on
x=$( { /usr/bin/yes 'made-up line' | /usr/bin/head -n 100000; } | capped 1000 '(Cut here: MADE-UP.)' | tail -2 | tr '\n' '|'; echo "${PIPESTATUS[*]}" )
is "capped cuts at its limit, says so on a line of its own, and ends with 3" "$x" 'made-up line|(Cut here: MADE-UP.)|0 3 0 0'
# summary.md's list of restarts comes only from the kernel's rows, and at most 200 of them (the made-up lines of
# other processes come first in time, so that a list of all rows would show them)
RS="$WORK/restarts/bundle"; mkdir -p "$RS/unified_logs"
{ printf '%s\n' "$LABEL_HEADER"
  i=0; while [ $i -lt 250 ]; do i=$((i + 1)); printf '2099-01-02 03:%02d:%02d.000000+0000\t\tDefault\tkernel\t0\tkernel\t\t\trestart\tPrevious shutdown cause: 5\n' $((i / 60)) $((i % 60)); done
  printf '2099-01-02 02:00:00.000000+0000\t\tDefault\tlogger\t4242\tlogger\t\t\trestart\tPrevious shutdown cause: 3 MADE-UP-FORGED\n'
  printf '2099-01-02 02:00:01.000000+0000\t\tDefault\tkernel\t4243\tkernel\t\t\tmentions-excel,restart\tPrevious shutdown cause: 0 MADE-UP-FORGED\n'
  printf '2099-01-02 02:00:02.000000+0000\t\tDefault\tkernel\t0\tkernel\t\t\tnot-a-restart\tPrevious shutdown cause: 0 MADE-UP-FORGED\n'
} > "$RS/unified_logs/2099-01-02.tsv"
( eval "$(bounded "$(sed -n '/^write_summary() {/,/^}$/p' "$SCRIPT")" 160 '^}$')"; OUT="$RS"; MANIFEST="$RS/manifest.tsv"; : > "$MANIFEST"
  MODE=collect; LOG_EXT=tsv; REDACT=0; COLLECTOR_VERSION=x; SINCE=2099-01-02; UNTIL=2099-01-02; DAYS=1; MAX_WAIT=3; write_summary ) > /dev/null 2>&1
is "summary.md lists restarts from the kernel only, at most 200, and says how many more" \
    "$(grep -c '^- 2099-01-02 03:.*Previous shutdown cause: 5$' "$RS/summary.md") $(grep -c '^(50 more are not listed.)$' "$RS/summary.md") $(grep -c 'MADE-UP-FORGED' "$RS/summary.md")" '200 1 0'
# Rows of the unified log: the restart tag only for the kernel (its program /kernel, its process ID 0), and every
# control and invisible character left in a row written as \u and its number
if [ -n "$JQ" ] && [ -n "$LABEL_JQ" ]; then
    ROWS=$(printf '%s\n' \
        '{"timestamp":"2099-01-02 03:04:05.000000+0000","processImagePath":"/kernel","processID":0,"eventMessage":"Previous shutdown cause: 5"}' \
        '{"timestamp":"2099-01-02 03:04:06.000000+0000","processImagePath":"/usr/bin/logger","processID":4242,"eventMessage":"Previous shutdown cause: 3"}' \
        '{"timestamp":"2099-01-02 03:04:07.000000+0000","processImagePath":"/opt/made-up/kernel","processID":4243,"eventMessage":"Previous shutdown cause: 0"}' \
        '{"timestamp":"2099-01-02 03:04:08.000000+0000","processImagePath":"/x/made\u001b[2Jup x‮","processID":7,"eventMessage":"MADE-UP \u001b]0;owned\u0007 \u0085 end\ttab"}' \
        | label_entries)
    is "only the kernel's shutdown cause is tagged restart" "$(printf '%s\n' "$ROWS" | awk -F'\t' 'NR > 1 { printf "%s", ($9 ~ /restart/) ? "r" : "-" }')" 'r---'
    # The kernel's memory messages, and spindump, ReportCrash and osanalyticshelper, are taken by what a process cannot
    # choose: process ID 0 or the program /kernel, and their programs' full paths. A program of anyone's named like them
    # (here in a made-up folder, with its own process ID) gets none of their tags.
    NROWS=$(printf '%s\n' \
        '{"timestamp":"2099-01-02 03:04:05.000000+0000","processImagePath":"/kernel","processID":0,"eventMessage":"memorystatus: MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:06.000000+0000","processImagePath":"/opt/made-up/kernel","processID":4243,"eventMessage":"memorystatus: jetsam swap MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:07.000000+0000","processImagePath":"/usr/sbin/spindump","processID":71,"eventMessage":"MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:08.000000+0000","processImagePath":"/opt/made-up/spindump","processID":4244,"eventMessage":"MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:09.000000+0000","processImagePath":"/System/Library/CoreServices/ReportCrash","processID":72,"eventMessage":"jetsam MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:10.000000+0000","processImagePath":"/opt/made-up/ReportCrash","processID":4245,"eventMessage":"jetsam MADE-UP"}' \
        '{"timestamp":"2099-01-02 03:04:11.000000+0000","processImagePath":"/opt/made-up/osanalyticshelper","processID":4246,"eventMessage":"jetsam MADE-UP"}' \
        | label_entries)
    is "the memory and hang-report tags go only to the kernel and to the programs at their own paths" \
        "$(printf '%s\n' "$NROWS" | awk -F'\t' 'NR > 1 { printf "%s", ($9 ~ /memory/) ? "m" : ($9 ~ /hang-report/) ? "h" : "-" }')" 'm-h-m--'
    # The rows written from what a search gave can be up to three times what it gave, and no more: a character of two
    # bytes (here U+0085, which log show passes on as it is) is written as the six of \u0085. The README says so.
    /usr/bin/perl -e 'my $m = "MADE-UP " . ("\xc2\x85" x 3000); for (1 .. 300) { print qq({"traceID":1,"eventMessage":"$m","eventType":"logEvent","source":null,"formatString":"%{public}s","activityIdentifier":0,"subsystem":"","category":"","threadID":1,"senderImageUUID":"0","processImageUUID":"0","senderImagePath":"/x/s","timestamp":"2099-01-02 03:04:05.000000+0000","machTimestamp":1,"messageType":"Default","processImagePath":"/x/p","processID":7,"senderProgramCounter":1,"parentActivityIdentifier":0,"timezoneName":"","bootUUID":"","userID":501}\n) }' > "$WORK/c1.ndjson"
    capped 1048576 < "$WORK/c1.ndjson" | label_entries | put "$WORK/c1.tsv"; x=$(wc -c < "$WORK/c1.tsv" | tr -d ' ')
    RM="$(dirname "$SCRIPT")/README.md"; [ -f "$RM" ] || RM="$PWD/README.md"
    is "rows written from a cut search come to between two and three times the cut, as the README says" \
        "$([ "$x" -gt $((2 * 1048576)) ] && [ "$x" -le $((3 * 1048576)) ] && echo 'up to three times' || echo "$x bytes") $(grep -c 'The rows written from what was kept can come to up to three times its size' "$RM") $(grep -c 'take at most 2 GB each' "$RM")" 'up to three times 1 0'
    is "no control or invisible character is left in a row, and each is written as its number" \
        "$(printf '%s\n' "$ROWS" | LC_ALL=C tr -d '\n\t\040-\176' | wc -c | tr -d ' ') $(printf '%s\n' "$ROWS" | sed -n 5p | cut -f4,10)" \
        "0 made\\u001b[2Jup\\u2028x\\u202e${TAB}MADE-UP \\u001b]0;owned\\u0007 \\u0085 end\\ttab"
else
    bad "jq is not on this Mac, so the restart tag and the escaping of rows were not checked"
fi
PRED=$(sed -n "/^PRED_ALL='/,/swap\"))'\$/p" "$SCRIPT")
is "the log search takes the shutdown cause only from the kernel" "$(printf '%s\n' "$PRED" | grep -c -F 'OR ((processImagePath == "/kernel" OR processIdentifier == 0) AND eventMessage CONTAINS[c] "previous shutdown cause")') $(printf '%s\n' "$PRED" | grep -c -F 'OR eventMessage CONTAINS[c] "previous shutdown cause"')" '1 0'
is "the log search takes the kernel, spindump, ReportCrash and osanalyticshelper by what a process cannot choose" \
    "$(printf '%s\n' "$PRED" | grep -c -e 'process == "kernel"' -e '"spindump"' -e 'process == "ReportCrash"' -e 'process == "osanalyticshelper"') $(printf '%s\n' "$PRED" | grep -c -F -e 'OR processImagePath == "/usr/sbin/spindump"' -e '(processImagePath == "/System/Library/CoreServices/ReportCrash" OR processImagePath == "/System/Library/CoreServices/osanalyticshelper") AND' -e 'OR ((processImagePath == "/kernel" OR processIdentifier == 0) AND (eventMessage CONTAINS[c] "memorystatus"')" '0 3'
is "summary.md and collection.log say by what each of those is taken, and name the others by their program files' names" \
    "$(grep -c -F '`hang-report` (the program file of the process is /usr/sbin/spindump)' "$SCRIPT") $(grep -c -F '`microsoft` (the program file of the process is named Microsoft Error Reporting' "$SCRIPT") $(grep -c -F '`permissions` (processes whose program file is named tccd,' "$SCRIPT") $(grep -c -F 'the previous shutdown cause and memory messages of the kernel (process ID 0, or the program /kernel), the jetsam messages of /System/Library/CoreServices/ReportCrash' "$SCRIPT") $(grep -c "the kernel'\"'\"'s memorystatus\|the kernel's previous shutdown cause and memory messages\|(spindump)" "$SCRIPT")" '1 1 1 1 0'

# ---- which process is Excel ------------------------------------------------------------------------------------------
# A process is Excel when it runs Excel's program file, as lsof gives it, and belongs to the console user: never by
# its name or its arguments. Here /bin/cat stands for Excel's program file. The decoy runs /bin/sleep through a link
# named like Excel, with Excel's path given as its own name, and is started first so that its process id is lower.
# The stand-in's arguments hold terminal codes and a character that reverses text, which ps prints as they are.
# Excel's name here holds this test's process ID, so that another run of the test beside it is not taken for this one.
EX="$WORK/excel"; mkdir -p "$EX/real" "$EX/decoy"; KEEP_PROC=$EXCEL_PROC; EXCEL_PROC="Microsoft Excel $$"
# Excel's stand-in is a program file of its own, since lsof is asked about every process of this account: built here,
# because a copy of a program of the system's is not let run. It waits on the file it is given, as cat would.
printf '#include <fcntl.h>\n#include <unistd.h>\nint main(int c, char **v) { char b[1]; int fd = c > 1 ? open(v[1], O_RDONLY) : 0; while (fd >= 0 && read(fd, b, 1) > 0) {} return 0; }\n' > "$EX/standin.c"
/usr/bin/cc -o "$EX/real/$EXCEL_PROC" "$EX/standin.c" 2>/dev/null || bad "a stand-in for Excel could not be built (/usr/bin/cc)"
ln -s /bin/sleep "$EX/decoy/$EXCEL_PROC"
HELD="$EX/held"$'\033[2J\xe2\x80\xae'"MADE-UP-ARG"; mkfifo "$HELD"
KEEP_EXE=$EXCEL_EXE; KEEP_STAGE=$STAGE; KEEP_OUT=$OUT; KEEP_LOG=$LOG; KEEP_MAN=$MANIFEST
EXCEL_EXE="$EX/real/$EXCEL_PROC"; USER_UID=$(id -u); STAGE="$EX"; OUT="$EX/bundle"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"
mkdir -p "$OUT/office"; : > "$LOG"; : > "$MANIFEST"
( exec -a "/Applications/$EXCEL_PROC.app/Contents/MacOS/$EXCEL_PROC" "$EX/decoy/$EXCEL_PROC" 60 ) & decoy=$!
sleep 0.3; "$EX/real/$EXCEL_PROC" "$HELD" & real=$!
sleep 0.5
excel_pids; rc=$?
is "of a decoy named like Excel and a process that runs its program file, only the second is Excel" "$rc [$EXCEL_PIDS]" "0 [$real]"
# Excel started under a name of someone's choosing is still Excel: no name picks the processes asked about
mkfifo "$EX/held2"; ( exec -a "some other name" "$EX/real/$EXCEL_PROC" "$EX/held2" ) & renamed=$!; sleep 0.5
excel_pids; rc=$?
is "a process that runs Excel's program file under another name is found too" "$rc $(printf '%s\n' "$EXCEL_PIDS" | grep -c -x -e "$real" -e "$renamed")" '0 2'
kill "$renamed" 2>/dev/null; wait "$renamed" 2>/dev/null
KEEP_UID=$USER_UID; USER_UID=""; excel_pids; rc=$?; USER_UID=$KEEP_UID
is "without the console user's account id nothing is said to be running: it is said not to be known" "$rc [$EXCEL_PIDS] $EXCEL_CHECK_SAID" "2 [] which program file each process runs was not asked: the console user's account id is not known"
excel_pids "$decoy"; rc=$?
is "asked again of one process id: the decoy is not Excel" "$rc [$EXCEL_PIDS]" '0 []'
KEEP_UID=$USER_UID; USER_UID=$((USER_UID + 1)); excel_pids; USER_UID=$KEEP_UID
is "a process of another account is not the console user's Excel" "[$EXCEL_PIDS]" '[]'
eval "$(sed -n '/^snapshot_excel_memory() {/,/^}$/p' "$SCRIPT")"
( snapshot_excel_memory "$OUT/office" ) > /dev/null 2>&1
is "Excel's memory file names the process that runs the program file, and its arguments are shown without codes" \
    "$(grep -c -F "PID $real runs $EXCEL_EXE (asked of lsof). Started " "$OUT/office/excel_memory.txt") $(grep -c 'MADE-UP-ARG' "$OUT/office/excel_memory.txt") $(LC_ALL=C tr -d '\n\t\040-\176' < "$OUT/office/excel_memory.txt" | wc -c | tr -d ' ') $(grep -c "PID $decoy" "$OUT/office/excel_memory.txt")" '1 1 0 0'
FIXED_SOURCES=(); ( collect_office ) > /dev/null 2>&1; eval "$(sed -n '/^EXCEL_LOGS_DEST=/,/^)$/p' "$SCRIPT")"
is "versions.txt lists the process ids of Excel's processes only, and nothing of their names or arguments" \
    "$(sed -n '/^=== Processes of /,$p' "$OUT/office/versions.txt" | sed 1d | tr '\n' ',') $(grep -c -e 'MADE-UP-ARG' -e 'Applications/Microsoft' "$OUT/office/versions.txt")" "$real, 0"
# The decoy's process id is asked again before root runs anything on it: the answer is no, and that is said
: > "$LOG"; STEP_WHY=""; still_excel "$decoy" footprint; rc=$?
is "a process that does not run Excel's program file is not acted on, and that is said" "$rc $(grep -c -F "  footprint was not run: PID $decoy no longer runs $EXCEL_EXE as " "$LOG")" '1 1'
kill "$decoy" "$real" 2>/dev/null; wait "$decoy" "$real" 2>/dev/null
# What top prints of other processes' names is shown without codes too
( top() { printf '  PID COMMAND   MEM\n    1 made\033[2Jup\342\200\256x 1M\n'; }; snapshot_memory "$OUT/memory.txt" ) > /dev/null 2>&1
is "a process name top prints is shown without codes or characters that reorder text" "$(grep -c 'made \[2Jup x' "$OUT/memory.txt") $(LC_ALL=C tr -d '\n\t\040-\176' < "$OUT/memory.txt" | wc -c | tr -d ' ')" '1 0'
EXCEL_EXE=$KEEP_EXE; EXCEL_PROC=$KEEP_PROC; STAGE=$KEEP_STAGE; OUT=$KEEP_OUT; LOG=$KEEP_LOG; MANIFEST=$KEEP_MAN

# ---- reports: one program for all, and what they say shown as a path is ---------------------------------------------
# The summary of reports takes facts out of reports the console user wrote. Terminal codes and a character that
# reverses text in them are shown as spaces, and one program reads them all.
RF="$WORK/report-facts"; RFH="$RF/home"; mkdir -p "$RFH/Library/Logs/DiagnosticReports" "$RF/bundle"
printf '{"app_name":"Excel\033]0;owned\007\033[2J","bug_type":"309","os_version":"x\342\200\256y","timestamp":"2099-01-02 03:04:05"}\n{"exception":{"type":"EXC\033[8mHIDDEN"}}\n' > "$RFH/Library/Logs/DiagnosticReports/Microsoft a.ips"
printf 'Process:  Excel \033[1A\033[2K x\nCrashed Thread: 0\n' > "$RFH/Library/Logs/DiagnosticReports/Microsoft b.crash"
for i in 1 2 3 4; do printf 'Process:  Microsoft Excel %s\n' "$i" > "$RFH/Library/Logs/DiagnosticReports/Microsoft c$i.crash"; done
touch -t "$WHEN" "$RFH/Library/Logs/DiagnosticReports/"*
KEEP_H=$USER_HOME; KEEP_OUT=$OUT; KEEP_LOG=$LOG; KEEP_STAGE=$STAGE; USER_HOME=$RFH; OUT="$RF/bundle"; STAGE="$RF"; LOG="$OUT/collection.log"; : > "$LOG"
eval "_rf_real() $(declare -f plain_perl | tail -n +2)"
plain_perl() { case "$*" in *"# ---- the end of REPORT_PL ----"*) echo x >> "$RF/starts" ;; esac; _rf_real "$@"; }
: > "$RF/starts"; ( collect_reports ) > /dev/null 2>&1
eval "plain_perl() $(declare -f _rf_real | tail -n +2)"; unset -f _rf_real
CS="$OUT/reports/crash_summary.txt"
is "one program reads the facts of every report" "$(wc -l < "$RF/starts" | tr -d ' ') $(grep -c '^## reports/user_Library_Logs_DiagnosticReports/' "$CS")" '1 6'
is "what reports say is shown without codes or characters that reorder text" \
    "$(LC_ALL=C tr -d '\n\t\040-\176' < "$CS" | wc -c | tr -d ' ') $(grep -c '^Process: Excel ]0;owned \[2J$' "$CS") $(grep -c '^OS Version: x y$' "$CS") $(grep -c '^Exception Type: EXC \[8mHIDDEN$' "$CS") $(grep -c '^Process: Excel \[1A \[2K x$' "$CS")" '0 1 1 1 1'
# Without perl, grep takes the lines, with the ASCII control characters shown as spaces
x=$(printf '%s\0' "$RFH/Library/Logs/DiagnosticReports/Microsoft b.crash" | { HAVE_PERL=0; report_facts "$RFH/"; })
is "without perl: a heading, and the lines without control characters" "$(printf '%s\n' "$x" | sed -n 1p) $(printf '%s' "$x" | LC_ALL=C tr -d '\n\t\040-\176' | wc -c | tr -d ' ')" '## Library/Logs/DiagnosticReports/Microsoft b.crash 0'
USER_HOME=$KEEP_H; OUT=$KEEP_OUT; LOG=$KEEP_LOG; STAGE=$KEEP_STAGE

# ---- which reports are copied, and the words for that rule -------------------------------------------------------
# The rule is held once (REPORT_NAMES, REPORT_FROM, SINCE), and both the search and what collection.log and
# source_catalog.tsv say of it are made from it: every report changed since the incident start, and of those changed in
# the last REPORT_DAYS days also each named like one of REPORT_NAMES and each other whose text names Excel. No report is
# said to be related to Excel. Here REPORT_DAYS is 1, and the incident starts tomorrow.
RR="$WORK/report-rule"; RRH="$RR/home"; RRD="$RRH/Library/Logs/DiagnosticReports"; mkdir -p "$RRD" "$RR/bundle"
printf 'MADE-UP-WINDOWSERVER\n' > "$RRD/WindowServer-2099-01-02.ips"          # dated now: named like one, within the day
printf 'MADE-UP-HANG\n' > "$RRD/SomeApp-2099-01-02.hang"
printf 'MADE-UP-OTHER\n' > "$RRD/SomeApp-2099-01-02.ips"                      # named like none, and names nothing
printf 'MADE-UP-OLD\n' > "$RRD/Microsoft Teams-2099-01-02.ips"; touch -t "$(date -v-3d '+%Y%m%d%H%M.%S')" "$RRD/Microsoft Teams-2099-01-02.ips"
printf 'MADE-UP-SINCE\n' > "$RRD/SomeApp-since.ips"; touch -t "$WHEN" "$RRD/SomeApp-since.ips"
KEEP_H=$USER_HOME; KEEP_OUT=$OUT; KEEP_LOG=$LOG; KEEP_STAGE=$STAGE; KEEP_MAN=$MANIFEST; KEEP_RD=$REPORT_DAYS; REPORT_DAYS=1
USER_HOME=$RRH; OUT="$RR/bundle"; STAGE="$RR"; LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"
( REPORT_FROM=""; collect_reports; write_source_catalog ) > /dev/null 2>&1
is "reports: copied by their date, or within the days by their name, and no other" "$(ls "$OUT/reports/user_Library_Logs_DiagnosticReports" | tr '\n' ' ')" 'SomeApp-2099-01-02.hang SomeApp-since.ips WindowServer-2099-01-02.ips '
RULE_LOG=$(sed -n 's/^Diagnostic reports: from each report folder, //p' "$LOG")
RULE_CAT=$(awk -F'\t' '$1 == "User diagnostic reports" { print $5 }' "$OUT/source_catalog.tsv" | sed 's/^From this folder and its Retired folder: //')
is "the log and the catalog give the same rule, made from what the search was given" \
    "$([ -n "$RULE_LOG" ] && [ "$RULE_LOG" = "$RULE_CAT" ] && echo same || echo "differ: [$RULE_LOG] [$RULE_CAT]") $(printf '%s\n' "$RULE_LOG" | grep -c -F "each plain file changed after $SINCE 00:00:00, and of those changed after ")$(printf '%s\n' "$RULE_LOG" | grep -c -F '(1 day(s) before the reports were first looked for; times are local), also each whose name matches one of *excel*, *office*, *microsoft*, jetsam*, WindowServer*, *.hang, *.spin, *.panic (in any case) and each other whose text holds "Microsoft Excel"')" 'same 11'
is "no report is said to be related to Excel" "$(cat "$LOG" "$OUT/source_catalog.tsv" | grep -c -i 'related')" 0
USER_HOME=$KEEP_H; OUT=$KEEP_OUT; LOG=$KEEP_LOG; STAGE=$KEEP_STAGE; MANIFEST=$KEEP_MAN; REPORT_DAYS=$KEEP_RD

# ---- the files a folder's copy leaves out for its size, removed by one program -------------------------------------
# One file and 300 more names for it (hard links): each counts at the file's full size, and each would cost root a
# program of its own if they were removed one by one
HL="$USER_HOME/Library/Logs/HardLinks"; mkdir -p "$HL"; dd if=/dev/zero of="$HL/big.log" bs=1024 count=2048 2>/dev/null
i=0; while [ $i -lt 300 ]; do i=$((i + 1)); ln "$HL/big.log" "$HL/link-$i.log"; done
KEEP_OUT=$OUT; KEEP_LOG=$LOG; KEEP_STAGE=$STAGE; OUT="$WORK/hardlinks/bundle"; STAGE="$WORK/hardlinks"; LOG="$OUT/collection.log"; mkdir -p "$OUT"; : > "$LOG"
rm() { echo x >> "$WORK/hardlinks/rm-count"; command rm "$@"; }
: > "$WORK/hardlinks/rm-count"; MAX_COPY_FOLDER_MB=1; COPY_BIG=0
copy_dir "$HL" "$OUT/hardlinks"
unset -f rm; MAX_COPY_FOLDER_MB=4096
is "301 names of one file over a folder's ceiling: all left out, counted, and removed by one program" \
    "$(grep -c "^  301 of the largest file(s) were left out to keep this folder's copy under 1 MB: " "$LOG") $(find "$OUT/hardlinks" -type f | wc -l | tr -d ' ') $([ "$(wc -l < "$WORK/hardlinks/rm-count")" -le 5 ] && echo 'one program' || echo "$(wc -l < "$WORK/hardlinks/rm-count" | tr -d ' ') programs")" '1 0 one program'
OUT=$KEEP_OUT; LOG=$KEEP_LOG; STAGE=$KEEP_STAGE

# ---- name hiding stopped at its time limit -------------------------------------------------------------------------
# REDACT_PL ends with 5 at its time limit: the step is said to have failed, with files that may be partly rewritten,
# and never to have hidden anything
x=$( exec 6>/dev/null; eval "$(bounded "$(sed -n '/^redact_bundle() {/,/^}$/p' "$SCRIPT")" 60 '^}$')"; OUT="$WORK/redact-stop/bundle"; mkdir -p "$OUT"
     LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"; : > "$OUT/.redacting.123"
     REDACT_PL='print STDERR "stopped at the time limit of 9 seconds\n"; exit 5'; REDACT_SECONDS=9; CONSOLE_USER=nobody-here
     scutil() { :; }; ioreg() { :; }; system_profiler() { :; }; hostname() { :; }     # nothing of this Mac's is asked
     redact_bundle > /dev/null 2>&1; echo "$? $REDACT_STATE"; cat "$MANIFEST"; ls -A "$OUT" | grep -c redacting )
is "name hiding stopped at its time limit: failed, files may be partly rewritten, nothing half-made left" "$(printf '%s\n' "$x" | tr '\n' '|')" \
    "1 failed|redaction${TAB}failed${TAB}stopped at its time limit of 9 seconds; files may be partly rewritten|0|"
is "name hiding that failed says that nothing is to be taken as hidden, not what the bundle still holds" \
    "$(grep -c '^  hiding names FAILED: it was stopped at its time limit of 9 seconds\. Files may be partly rewritten, and nothing in this bundle is to be taken as hidden\.$' "$WORK/redact-stop/bundle/collection.log") $(grep -c 'still names\|NOT fully hidden' "$SCRIPT")" '1 0'
is "the name hiding is given its time limit" "$(grep -c 'RX_SECONDS="$REDACT_SECONDS" /usr/bin/perl -e "$REDACT_PL"' "$SCRIPT") $(grep -c '^REDACT_SECONDS=[0-9][0-9]* ' "$SCRIPT")" '1 1'
# As root, binary property lists are turned into text with the console user's rights, and otherwise not: the name
# hiding is told which it was, rights that could not be taken on or a run that had stopped running anything with them
x=""
for c in "0 0" "1 1" "1 0"; do
    x="${x:+$x }$( exec 6>/dev/null; set -- $c; eval "$(bounded "$(sed -n '/^redact_bundle() {/,/^}$/p' "$SCRIPT")" 60 '^}$')"; OUT="$WORK/redact-convert/bundle"; mkdir -p "$OUT"
        LOG="$OUT/collection.log"; MANIFEST="$OUT/manifest.tsv"; : > "$LOG"; : > "$MANIFEST"; STAGE="$WORK/redact-convert"; rm -f "$STAGE/.limit"
        REDACT_PL='print $ENV{RX_CONVERT}; exit 0'; REDACT_SECONDS=9; CONSOLE_USER=nobody-here; AM_ROOT=1; USER_UID=$(( $(id -u) + 1 )); USER_READS=$1; HOME_SHUT=$2
        scutil() { :; }; ioreg() { :; }; system_profiler() { :; }; hostname() { :; }; id() { :; }
        redact_bundle > /dev/null 2>&1; cut -f3 "$MANIFEST" )"
done
is "as root, the name hiding is told why property lists are not turned into text: no rights, or a run that stopped using them" "$x" 'none-rights none-closed user'

# ---- where the collector does these ---------------------------------------------------------------------------------
is "the bundle is built in a folder of its own making, not at a name that can be known" "$(grep -c '^STAGE_BASE=/private/var/tmp$' "$SCRIPT") $(grep -c '^STAGE=\$(/usr/bin/mktemp -d "\$STAGE_BASE/excel_diag.XXXXXXXXXX")' "$SCRIPT") $(grep -c '^OUT="\$STAGE/\$NAME"$' "$SCRIPT")" '1 1 1'
is "a run says where it works, names what earlier runs left, and marks its own folder as in use" "$(grep -c '^say "Working folder: \$STAGE\. ' "$SCRIPT") $(grep -c '^earlier_runs$' "$SCRIPT") $(grep -c '^echo \$\$ > "\$STAGE/.pid"' "$SCRIPT")" '1 1 1'
is "a destination's trailing slashes are taken off, and it is counted from the folder the script was started in" "$(cd "$WORK" && EXCEL_DIAG_OUTDIR='results///' && eval "$(bounded "$(sed -n '/^DEST="\${OUTDIR:-/,/^while \[ "\$DEST" != \/ \]/p' "$SCRIPT")" 4 '^while ')" && echo "$DEST")" "$WORK/results"
DEST_LINES=$(bounded "$(sed -n '/^DEST="\${OUTDIR:-/,/^while \[ "\$DEST" != \/ \]/p' "$SCRIPT")" 4 '^while ')
is "the folder given with --outdir comes first, then EXCEL_DIAG_OUTDIR, then the Desktop" \
    "$(cd "$WORK" && USER_HOME="$WORK/a-home" && OUTDIR=from-option && export EXCEL_DIAG_OUTDIR=from-variable && eval "$DEST_LINES" && a=$DEST \
       && OUTDIR="" && eval "$DEST_LINES" && b=$DEST && unset EXCEL_DIAG_OUTDIR && eval "$DEST_LINES" && echo "$a $b $DEST")" \
    "$WORK/from-option $WORK/from-variable $WORK/a-home/Desktop"
is "whether a report names Excel is asked of the file opened as itself, never with grep" "$(grep -c -- '-exec /usr/bin/grep' "$SCRIPT") $(grep -c -F '"/usr/bin/perl", "-e", $fetch, "--", $n, $folder, 0, $text;' "$SCRIPT") $(grep -c -F '"$folder" "$EXCEL_PROC" "$NAMES_PL" "$FETCH_PL"' "$SCRIPT")" '0 1 1'
# These four cannot be shown without root, or without an account in more groups than a process can hold: the lines are looked for
is "the groups a helper holds are asked of the kernel, not of the directory" "$(grep -c 'my \$count = syscall(79, 64, \$held);' "$SCRIPT") $(grep -c "split ' ', \"\$)\"" "$SCRIPT")" '1 0'
is "the helper, and the program that root runs with a time limit, are each put in a group of their own from both sides" "$(grep -c '^    setpgrp(0, 0);$' "$SCRIPT") $(grep -c '^POSIX::setpgid(\$pid, \$pid);$' "$SCRIPT")" '2 2'
is "a rule on a folder that lets someone else in counts against it" "$(grep -c "/bin/ls -lde \"\$p\" 2>/dev/null | /usr/bin/grep -q -E '^ \*\[0-9\]+: \.\* allow ' && return 1" "$SCRIPT")" 1
is "while packaging, a reader of the screen that has gone ends nothing" "$(grep -c "^    trap '' INT TERM HUP PIPE QUIT$" "$SCRIPT")" 1
is "the copy that root unpacks takes no owner, rights or flags from what it is given" "$(grep -c -- '| /usr/bin/tar -xf - -o --no-same-permissions -C "\$2" ' "$SCRIPT")" 1
is "a destination is taken from the folder the script was started in" "$(grep -c '^case "\$DEST" in /\*) ;; \*) DEST="\$PWD/\$DEST" ;; esac' "$SCRIPT")" 1

is "no loop is fed by a search running beside the script" "$(grep -c '< <(' "$SCRIPT")" 0
is "a closed Terminal window is an interrupt like the others" "$(grep -c "exit 130; }' INT TERM HUP QUIT\$" "$SCRIPT")" 1
is "results that could not be moved end the script with a status of their own" "$(grep -c '^        FINAL_STATUS=4$' "$SCRIPT")" 1
is "ownership is changed without following links, and only of the staging folder" "$(grep -c 'chown ' "$SCRIPT") $(grep -c 'chown -Rh "\$USER_UID" "\$STAGE"' "$SCRIPT")" '1 1'
is "nothing copies with ditto or cp from outside the bundle" "$(grep -c -E '^[^#]*(\bcp |ditto "\$1")' "$SCRIPT")" 0
is "perl is never given a name or text where an option could be read" "$(grep -E '(perl|PERL_CMD\[@\]}") .*-e "\$[A-Z_]+"' "$SCRIPT" | grep -v -c -E -- '-e "\$[A-Z_]+"( --| 2>|\)| <)')" 0
is "and that check sees every place perl is started" "$(grep -c -E '(perl|PERL_CMD\[@\]}") .*-e "\$[A-Z_]+"' "$SCRIPT" | sed 's/^[1-9][0-9]*$/some/')" 'some'

is "the name hiding never writes through something already there" "$(grep -c 'O_EXCL() | Fcntl::O_NOFOLLOW()' "$SCRIPT")" 2

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
