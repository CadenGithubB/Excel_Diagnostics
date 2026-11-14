#!/bin/bash
# excel_diagnostics.sh - collect evidence for Microsoft Excel slowdowns, hangs and crashes on macOS.
#
# Modes
#   collect  (default) Excel logs, diagnostic reports, unified logs, sleep/wake history,
#            memory state, Excel memory footprint, AutoRecover inventory (with dates), add-ins, prefs,
#            plus a search of Microsoft's folders in the home folder and in /Library for other log files
#            (office/discovered_sources.tsv). source_catalog.tsv says where each source was looked for, how
#            its lines are laid out, and by what rule the reports were picked.
#   hang     Run WHILE Excel is frozen, before force-quitting it. Takes a spindump of Excel (sample when not
#            root), its memory footprint and its open files and network connections, then says that Excel
#            can be force-quit; then copies Excel's logs and searches the last 30 minutes of the unified log.
#   repro    Takes a first snapshot, starts a live, unfiltered macOS log stream and an Excel memory
#            timeline, and then says when to reproduce the problem; press Ctrl-C here after it happened.
#            It then takes a last snapshot and gathers everything collect does, except the past days'
#            unified logs and --archive, before zipping.
#   watch    Records Excel's memory/CPU and system memory pressure to a CSV, one sample after each wait of
#            --interval seconds, until stopped with Ctrl-C (or --hours elapses). Logs when the process ID of
#            Excel changes. Excel is the console user's process that runs
#            /Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel (the lowest process ID, when
#            more than one does).
#
# Usage
#   sudo ./excel_diagnostics.sh [collect] [--days N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--note TEXT] [--workbook PATH] [--archive] [--redact]
#   sudo ./excel_diagnostics.sh hang [--note TEXT] [--workbook PATH] [--redact]
#   sudo ./excel_diagnostics.sh repro [--note TEXT] [--workbook PATH] [--interval SECONDS] [--hours H] [--redact]
#   ./excel_diagnostics.sh watch [--note TEXT] [--workbook PATH] [--interval SECONDS] [--hours H] [--redact]
#
#   Easiest: run  sudo bash excel_diagnostics.sh  in Terminal with no options. It asks what to do, how
#   many days back to search, how long to wait, and so on. Options given on the command line are not
#   asked again; --no-prompt asks nothing (Jamf never asks).
#
#   --no-prompt    Don't ask questions; use the options given and the defaults.
#   --days N       Days of unified logs to include (collect; default 3). Each day's search is stopped after
#                  --max-wait minutes.
#                  A number given to any option may have leading zeros and at most four digits after them.
#   --max-wait M   Most minutes to spend on each day's log search (collect) or hang's 30-minute search
#                  (default 3; 0 = no limit). A search that hits the limit keeps what it found so far.
#   --since DATE   First incident date to include (YYYY-MM-DD, from 1900-01-01 on; default: --days days up
#                  to --until).
#   --until DATE   Last incident date to include (YYYY-MM-DD, from 1900-01-01 on; default is today).
#                  Every diagnostic report changed since the start of the first incident date is taken for
#                  copying. Of those changed in the last 30 days (or in as many days as are searched, when that is
#                  more), so is each whose name holds excel, office or microsoft, starts with jetsam or
#                  WindowServer, or ends in .hang, .spin or .panic, and each other whose text holds "Microsoft
#                  Excel"; a name that starts with a dot is passed over. source_catalog.tsv gives the rule with its
#                  times; the status table and collection.log say what was not copied, and why. The sleep/wake
#                  history and the Microsoft install history are taken from the day that many days back on.
#   --note TEXT    What happened, in the words of whoever runs this, for example --note "Excel closed when I
#                  sorted column C". Kept in case/incident_context.md as one line of at most 500 characters:
#                  runs of line breaks, tabs and spaces become one space, control characters become a space
#                  or are left out, key codes and the characters on a fixed list (those that reorder text,
#                  and a few that draw nothing) are taken out, and a longer text keeps only its beginning.
#                  It is checked against nothing, and --redact treats it like any other text.
#                  collect and repro ask for it when run from Terminal; hang and watch do not ask. Without
#                  it, nothing about what happened is recorded. The line is also part of the command line
#                  when it is given with this option, and when the script, started without sudo, runs itself
#                  again with sudo; macOS records a sudo command line in its own log, which a bundle can
#                  include. --case is the old name of this option: what follows it is kept the same way.
#   --workbook P   Workbook involved in the incident; records metadata only, never copies the workbook.
#   --archive      Also save an unfiltered .logarchive from the incident start through collection (can be very large)
#   --redact       Hide the console user's account name and full name, this Mac's name, serial number and
#                  hardware UUID, and email addresses, in every text file of the bundle. Files that are not
#                  plain text (OneDrive's own logs, for example) cannot be checked, so they are left out.
#                  redaction.txt in the bundle says what was replaced, any name left as it is, what was left
#                  out and what is not hidden: file and folder names, network addresses, and any --archive
#                  .logarchive. The script ends with status 3 if the step failed (it is stopped after an hour),
#                  if the check found one of them again, if something in the bundle could not be read or
#                  rewritten, or if the bundle holds an --archive .logarchive. A name left alone on purpose (an
#                  account called admin, a Mac named after its model) ends with status 0 and is named in the
#                  result line.
#   --interval S   Seconds to wait after each sample (watch and repro; default 30, at least 5). Taking a
#                  sample takes time of its own, so samples are further apart than this.
#   --hours H      Stop watching or repro capture after H hours (default: run until Ctrl-C)
#   --outdir DIR   The folder the results are moved to at the end (default: the console user's Desktop). A path
#                  that does not start with / is taken from the folder the script was started in.
#   --no-sudo      Don't re-run with sudo; collect what the account that runs the script can read
#
# Jamf Pro: run as a policy script. Parameter 4 = mode, parameter 5 = days (collect) or hours (watch),
# parameter 6 = max wait in minutes, parameter 7 = redact to hide names (see --redact).
# Every bundle starts with bundle_info.tsv: the collector's version, the mode, when it ran, and the macOS,
# Mac model and Excel versions.
# EXCEL_DIAG_OUTDIR names the folder too, when --outdir is not given. A variable set before sudo reaches the
# script only when sudo is set up to pass it on; --outdir always does, and the script, started without sudo, hands
# EXCEL_DIAG_OUTDIR to its own run with sudo as --outdir. The bundle is built in a working folder of the script's
# own under /private/var/tmp and moved to where it is wanted at the very end; a run that is cut off leaves what it
# had collected in that working folder, and says where that is when it starts.
#
# Exit status: 0 = a zip was made and is where it was asked for; 1 = no zip could be made; 3 = a zip was made
# but the --redact step failed or did not end complete (see --redact); 4 = the results could not all be moved to where
# they were asked for: some of them, or all, were left in the working folder (the last lines say which); 130 =
# stopped, once collecting had begun, by an interrupt, a TERM signal or a hangup (Ctrl-C, Ctrl-\, the Terminal
# window closing); what was collected so far is still packaged. When more than one of these applies, the script
# ends with the first of them in this order: 1, 3, 4, 130.
#
# collect, hang and repro, started without sudo, run themselves again with sudo (unless --no-sudo is given): as
# root, collect and repro read the unified log and /Library/Logs/DiagnosticReports, and hang reads the unified log
# and runs spindump. watch does not.
# The results (a folder, its .zip and the zip's checksum) go to the console user's Desktop, or to the folder
# --outdir names.
# Excel's own logs are timestamped in UTC; unified-log .tsv files carry a utc_time column to match.
# Unified-log .tsv files have one entry per row, with level and tags columns; summary.md says what each tag is
# given to.

MODE=collect
DAYS=3
ARCHIVE=0
INTERVAL=30
HOURS=0
NO_SUDO=0
SINCE=""
UNTIL=""
SAY_DAYS=""                                # 1 = say how many days are searched, once that is worked out
REDACT=0
NOTE=""                                    # what happened, as typed by whoever runs this; empty = nothing recorded
# What this run itself found out about the note:
NOTE_CUT=0                                 # 1 = it was longer than 500 characters and only its beginning is kept
NOTE_PLAIN=0                               # 1 = perl could not be run or failed, so only its plain ASCII characters are kept
NOTE_LATE=0                                # 1 = input that arrived straight after the Return that ended the typed note was not kept
NOTE_OVER=0                                # 1 = more arrived at the question about what happened than the 8,000 bytes it keeps
# And what it was told by an option (--note-cut, --note-plain, --note-late, --note-over), which this script's run
# without sudo gives its run with sudo. Anyone who starts the script can give them too, so what is written about the
# note says that the run was started with the option, and not that what it stands for happened.
NOTE_CUT_TOLD=0; NOTE_PLAIN_TOLD=0; NOTE_LATE_TOLD=0; NOTE_OVER_TOLD=0
WORKBOOK=""
OUTDIR=""                                  # --outdir; empty = EXCEL_DIAG_OUTDIR, or the console user's Desktop
MAX_WAIT=3                                 # minutes per unified-log search; 0 = no limit
DAYS_SET=0
WAIT_SET=0
MODE_SET=0
PROMPT=1
JAMF=0
MAX_DISCOVERED_MB=250                     # larger discovered log files are listed but not copied
MAX_DISCOVERED_FILES=100000               # the most files of the search for other log files that are gone through
MAX_SEARCH_ROOTS=500                      # the most folders of the home folder that the search for other log files starts from
MAX_COPY_FILE_MB=1024                     # in a log folder copied whole, a larger file is left out and counted
MAX_COPY_FOLDER_MB=4096                   # and the largest files of a folder past this in all are left out and counted
MAX_COPY_FOLDER_ENTRIES=50000             # the most files and folders one folder's copy takes; the rest are left out and counted
COPY_SECONDS=900                          # the longest one folder's copy may take
USER_SECONDS=1800                         # the most time all helpers run with the console user's rights may take together
HAND_OVER_SECONDS=3600                    # the most time the steps of the hand-over may take together
REPRO_STREAM_GB=10                        # repro's live log stream is cut once this many GB of it have arrived
UNIFIED_SEARCH_GB=2                       # and each unified-log search (one day, or hang's half hour) once this many have
REDACT_SECONDS=3600                       # the longest the name hiding (--redact) may take
unset AS_LEDGER AS_LIMIT AS_WHAT AS_PATH AS_KEEP_OPEN AS_STDIN AS_HANDOVER   # set only by this script, for one step at a time

EXCEL_PROC=${EXCEL_PROCESS_NAME:-"Microsoft Excel"}   # override only for testing
EXCEL_NAME=${EXCEL_PROC#Microsoft }        # "Excel": also matches "Microsoft Excel" and com.microsoft.Excel
# The program file of Microsoft Excel where it is installed. A process is taken for Excel only when it runs this
# file (see excel_pids): its name and its arguments are whatever whoever started it chose.
EXCEL_EXE="/Applications/$EXCEL_PROC.app/Contents/MacOS/$EXCEL_PROC"
VIEWER_URL="https://cadengithubb.github.io/Excel_Diagnostics/"   # in-browser viewer for the collected bundle

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
# seen TEXT - TEXT as it can be said on the screen: each control character in it, and each byte from 0x80 to 0x9f
# (an 8-bit control, part of one, or part of a character of more than one byte, which is then shown broken), is
# shown as ?
seen() { printf '%s' "$1" | LC_ALL=C tr '\000-\037\177-\237' '?'; }

# This shell works on bytes (the C locale). In a locale where a character can take more than one byte, bash 3.2
# splits a quoted word at a byte that is no character there ("${a[@]}" can give two words for one), and puts a byte
# 0x01 into what $(...) gives back: typed text could become an extra argument of the re-run with sudo. The locale
# of whoever runs this is kept in P_LOCALE for the reader of the questions. Until the re-run with sudo, LC_ALL is set
# for this shell alone: the programs it runs get the locale they would have had, without an LC_ALL that was set,
# which the re-run with sudo is given back. After that point LC_ALL=C is exported (see there).
P_LOCALE=${LC_ALL:-${LC_CTYPE:-${LANG:-}}}
P_LC_ALL=${LC_ALL-}; P_LC_ALL_SET=${LC_ALL+1}
unset LC_ALL; LC_ALL=C

ORIG_ARGS=("$@")
if [ "$1" = "/" ] && [ $# -ge 3 ]; then    # Jamf passes mount point, computer name, username first
    JAMF=1
    MODE=${4:-collect}
    case "$MODE" in
        collect) DAYS=${5:-$DAYS} ;;
        watch)   HOURS=${5:-$HOURS} ;;
    esac
    MAX_WAIT=${6:-$MAX_WAIT}
    case "$7" in
        '') ;;
        [Rr][Ee][Dd][Aa][Cc][Tt]|--redact) REDACT=1 ;;
        *) echo "Unknown value for parameter 7: $(seen "$7") (use redact to hide names, or leave it empty)" >&2; exit 2 ;;
    esac
    set --
fi
while [ $# -gt 0 ]; do
    case "$1" in --days|--since|--max-wait|--until|--note|--case|--workbook|--interval|--hours|--outdir)
        # Without this, an option with nothing after it would take the next option as its value
        [ $# -ge 2 ] || { echo "$1 needs a value after it" >&2; exit 2; } ;;
    esac
    case "$1" in
        collect|hang|repro|watch) MODE=$1; MODE_SET=1 ;;
        --no-prompt) PROMPT=0 ;;
        --days)     DAYS=$2; DAYS_SET=1; shift ;;
        --since)    SINCE=$2; DAYS_SET=1; shift ;;
        --max-wait) MAX_WAIT=$2; WAIT_SET=1; shift ;;
        --until)    UNTIL=$2; shift ;;
        --archive)  ARCHIVE=1 ;;
        --redact)   REDACT=1 ;;
        --note|--case)                      # --case: the old name, which took one fixed word; it is kept like any text
            case "$2" in --no-prompt|--days|--since|--max-wait|--until|--archive|--redact|--note|--case|--workbook|--interval|--hours|--outdir|--no-sudo|--help|-h)
                echo "$1 needs text after it, and what follows it is the option $2. To record that word itself, write $1=$2" >&2; exit 2 ;;
            esac
            NOTE=$2; shift ;;
        --note=*|--case=*) NOTE=${1#*=} ;;
        --note-cut) NOTE_CUT_TOLD=1 ;;      # these four are for this script's own re-run with sudo: what the
        --note-plain) NOTE_PLAIN_TOLD=1 ;;  # first run found out about the note while reading it and making it
        --note-late) NOTE_LATE_TOLD=1 ;;    # into one line (see NOTE_CUT_TOLD)
        --note-over) NOTE_OVER_TOLD=1 ;;
        --workbook) WORKBOOK=$2; shift ;;
        --interval) INTERVAL=$2; shift ;;
        --hours)    HOURS=$2; shift ;;
        --outdir)   [ -n "$2" ] || { echo "--outdir needs a folder after it" >&2; exit 2; }
                    OUTDIR=$2; shift ;;
        --no-sudo)  NO_SUDO=1 ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "Unknown argument: $(seen "$1")" >&2; usage >&2; exit 2 ;;
    esac
    shift
done
case "$MODE" in collect|hang|repro|watch) ;; *) echo "Unknown mode: $(seen "$MODE")" >&2; exit 2 ;; esac

# whole TEXT - TEXT as a number without its leading zeros, which bash would read as octal (08 is no number to it). Fails
# when TEXT is not made of digits, and when more than four are left: bash arithmetic wraps past its range without a
# word, and no number here needs more.
whole() {
    # The digits are listed: a range such as 0-9 is matched by the locale's order, where other digits fall within it
    local n=${1#"${1%%[!0]*}"}
    case "$1" in ''|*[!0123456789]*) return 1 ;; esac
    case "$n" in ?????*) return 2 ;; esac
    echo "${n:-0}"
}
# Numbers given as options, or by Jamf, are checked before anything uses them, the questions included
for n in "$DAYS" "$INTERVAL" "$HOURS" "$MAX_WAIT"; do
    whole "$n" > /dev/null
    case $? in
        1) echo "Expected a whole number, got '$(seen "$n")'" >&2; exit 2 ;;
        2) echo "Expected a number of at most four digits, got '$(seen "$n")'" >&2; exit 2 ;;
    esac
done
DAYS=$(whole "$DAYS"); INTERVAL=$(whole "$INTERVAL"); HOURS=$(whole "$HOURS"); MAX_WAIT=$(whole "$MAX_WAIT")
# A date is taken only when it is exactly YYYY-MM-DD and a day that exists: date(1) by itself takes text after a
# date, and turns 2026-02-30 into 2026-03-02, without a word. date(1) here takes no year before 1900.
valid_date() {
    case "$1" in [0123456789][0123456789][0123456789][0123456789]-[0123456789][0123456789]-[0123456789][0123456789]) ;; *) return 1 ;; esac
    [ "$(TZ=UTC0 date -j -f '%Y-%m-%d %H:%M:%S' "$1 12:00:00" '+%Y-%m-%d' 2>/dev/null)" = "$1" ]
}
if [ -n "$SINCE" ] && ! valid_date "$SINCE"; then echo "Invalid --since date: $(seen "$SINCE") (use YYYY-MM-DD, a day that exists, from 1900-01-01 on)" >&2; exit 2; fi
if [ -n "$UNTIL" ] && ! valid_date "$UNTIL"; then echo "Invalid --until date: $(seen "$UNTIL") (use YYYY-MM-DD, a day that exists, from 1900-01-01 on)" >&2; exit 2; fi

# Every question is read by ask_line, below, so that what arrives at each of them is dealt with in the same way.
# first_line TEXT - TEXT up to its first line break, without the spaces and tabs at its two ends, in ANSWER. It is
# what read gave from a here-string, worked out here instead: bash writes a here-string into a file of its own
# first, and where it cannot (a full disk) read sets nothing and the answer before it would stay.
first_line() {
    local blanks=$' \t'
    ANSWER=${1%%$'\n'*}
    ANSWER=${ANSWER#"${ANSWER%%[!$blanks]*}"}
    ANSWER=${ANSWER%"${ANSWER##*[!$blanks]}"}
}
ask_number() {      # ask_number QUESTION DEFAULT [MIN MAX] - read a whole number from the terminal into REPLY_NUMBER
    local answer n
    while :; do
        ask_line "$1 [$2]: " || continue          # a signal that this script ignores: asked again
        first_line "$REPLY_TEXT"
        answer=${ANSWER:-$2}
        n=$(whole "$answer")
        case $? in
            1) echo "  Please enter a whole number." >&2 ;;
            *) if [ -n "$3" ] && { [ -z "$n" ] || [ "$n" -lt "$3" ] || [ "$n" -gt "$4" ]; }; then
                   echo "  Please enter a number from $3 to $4." >&2
               elif [ -z "$n" ]; then
                   echo "  Please enter a number of at most four digits." >&2
               else
                   REPLY_NUMBER=$n; return
               fi ;;
        esac
    done
}
ask_yes() {         # ask_yes QUESTION DEFAULT(y|n) - succeed on yes
    local answer
    while :; do
        ask_line "$1 [$([ "$2" = y ] && echo Y/n || echo y/N)]: " || continue
        first_line "$REPLY_TEXT"; answer=$ANSWER
        case "${answer:-$2}" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) echo "  Please answer y or n." >&2 ;; esac
    done
}
# perl, without the settings a person may have made for their own perl (which can change how it reads bytes).
plain_perl() {
    LC_ALL=C /usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO /usr/bin/perl "$@"
}

# Reads free text from the terminal for one question and prints it. Arguments: the prompt, the locale of whoever
# runs this, and "path" for the question that asks for a path. The terminal is taken out of line mode and is told not
# to act on its interrupt, quit and suspend characters (Ctrl-C, Ctrl-\ and Ctrl-Z, unless it is set up otherwise)
# while the question is open. So the terminal sets no length for a line, and every byte that arrives comes here and
# is either text or dropped. Return ends the text, and so does Ctrl-D when there is none. A paste is taken whole, its
# line breaks and tabs as spaces. Terminals that mark a paste say where it starts and ends: between the marks every
# control character is dropped, those three and Ctrl-D among them, and a paste whose end mark has not come is over
# after a second in which nothing arrived. Elsewhere a line break, Ctrl-D or one of those three with more input
# arriving straight behind it counts as part of a paste. When no paste was marked, what arrives after the Return or
# Ctrl-D that ends the text, until half a second passes with nothing, is dropped, however long that goes on, with a
# line on the screen that says so. One of the three typed by itself does what it does anywhere else, after the
# terminal has been put back. Backspace, Ctrl-W and Ctrl-U take back a character, a word, everything. Keys that send
# codes (arrows, function keys) do nothing, and a string that a terminal sends about itself is skipped. Only whole
# characters that are valid UTF-8 are kept, and no control character is. They are shown as they are when the locale
# is one of UTF-8, and otherwise each character that is not plain ASCII is shown as one "?".
# For a path the bytes are kept as they arrived, whatever they are, but no NUL: line breaks and tabs stay what they
# are, a control character that is part of a paste is kept, and so are other control characters and bytes that are
# not UTF-8 text. Keys, codes and strings are dealt with as above. On the screen each of those bytes, and each control
# character above the plain ones, is shown as one "?".
# Status 4 means the terminal could not be used this way; the caller then reads a plain line. Status 7 means that since
# the text was last empty more arrived than the limit, and what did not fit was dropped; the text may have been edited
# after that. Status 8 means input that arrived after the end of the text was dropped, and 9 means both.
#
# program_read TEXT NAME - stops the run unless TEXT, the program NAME just read from a here-document, arrived whole.
# bash writes a here-document into a temporary file in /var/tmp and reads it back from there. Where it cannot write
# that file (a full disk), the variable is left empty or holds only a beginning, and perl would run that without a
# word: an empty program does nothing and ends with status 0. The last line of each program names it, so one that
# did not arrive whole is told apart.
program_read() {
    case $1 in *"# ---- the end of $2 ----"*) return 0 ;; esac
    echo "Stopped: the program $2, which this script holds, could not be read whole. bash writes such a program into a temporary file in /var/tmp before reading it, and that cannot be done on a full disk. Nothing was collected." >&2
    exit 1
}
IFS= read -r -d '' ASK_PL <<'PERL'
use strict; use warnings; use POSIX ();
binmode(STDOUT);
open(my $tty, "+<", "/dev/tty") or exit 4;
binmode($tty);
my $fd = fileno($tty);
my $term = POSIX::Termios->new;
defined $term->getattr($fd) or exit 4;
my ($lflag, $iflag, $vmin, $vtime, $raw) = ($term->getlflag, $term->getiflag, $term->getcc(&POSIX::VMIN), $term->getcc(&POSIX::VTIME), 0);
my $ansi = defined $ENV{TERM} && $ENV{TERM} !~ /^(?:|dumb|unknown)$/;       # a terminal that takes cursor codes
my $prompt = defined $ARGV[0] ? $ARGV[0] : "> ";
my $utf8 = defined $ARGV[1] && $ARGV[1] =~ /UTF-?8/i;  # the terminal is said to show UTF-8
my $path = defined $ARGV[2] && $ARGV[2] eq "path";     # the bytes of the answer are kept as they arrive
my ($cols, $resized) = (80, 0);
my ($text, $full, $dropped, $pasting, $marked, $part, @held) = ("", 0, 0, 0, 0, "");
my $limit = 8000;       # bytes kept: several times what a 500-character note needs. More is read and dropped.
my $lapse = 1;          # seconds with no input after which a paste whose end mark has not come is over
my $longest = 64;       # bytes of a key code that are read before it is given up
my $string = 256;       # bytes of a string sent by a terminal (a window title, for one) that are skipped
# One whole character of more than one byte, as UTF-8 allows it
my $multi = qr/[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}/;
my $whole = qr/\A(?:$multi)\z/;
# The characters this terminal takes as interrupt, quit and suspend, and the signal each of them sends. While
# the question is open the terminal passes them on like any other byte (see raw), and what is done is decided here.
my %signal;
if ($lflag & &POSIX::ISIG) {
    for my $k ([&POSIX::VINTR, 3, "INT"], [&POSIX::VQUIT, 28, "QUIT"], [&POSIX::VSUSP, 26, "TSTP"]) {
        my $c = $term->getcc($k->[0]);
        $c = $k->[1] unless $c;                          # the settings do not say: the usual one
        $signal{$c} = $k->[2] if $c < 32 || $c == 127;   # a terminal set to have none has none here either
    }
}

sub out {
    my $s = $_[0];
    while (length $s) {
        my $n = syswrite($tty, $s);
        if (!defined $n) { next if $!{EINTR}; return; }
        substr($s, 0, $n) = "";
    }
}
sub width {             # how many columns the terminal has now
    $cols = `/bin/stty size < /dev/tty 2> /dev/null` =~ /^\d+ (\d+)/ ? $1 : 0;
    $cols = 80 if $cols < 20;
    $resized = 0;
}
sub raw {
    $term->setlflag($lflag & ~(&POSIX::ICANON | &POSIX::ECHO | &POSIX::IEXTEN | &POSIX::ISIG));
    # and no byte is changed or taken on its way in: a carriage return stays one, and Ctrl-S and Ctrl-Q arrive as
    # bytes (kept in a workbook path, dropped like other control characters elsewhere). Left to the terminal, a
    # Ctrl-S would stop what the reader writes, and with a long paste behind it the question would never end.
    # Whatever a Ctrl-S stopped is started again once the terminal no longer acts on one, so a Ctrl-S that came
    # before that moment is undone too.
    $term->setiflag($iflag & ~(&POSIX::ICRNL | &POSIX::INLCR | &POSIX::IGNCR | &POSIX::IXON));
    $term->setcc(&POSIX::VMIN, 1); $term->setcc(&POSIX::VTIME, 0);
    $raw = 1 if defined $term->setattr($fd, &POSIX::TCSANOW);
    POSIX::tcflow($fd, &POSIX::TCOON);
    out("\e[?2004h") if $raw && $ansi;                  # ask the terminal to mark the start and end of a paste
}
sub cooked {            # put the terminal back as it was found. It counts as put back only when that was done.
    return unless $raw;
    out("\e[?2004l") if $ansi;
    $term->setlflag($lflag); $term->setiflag($iflag); $term->setcc(&POSIX::VMIN, $vmin); $term->setcc(&POSIX::VTIME, $vtime);
    $raw = 0 if defined $term->setattr($fd, &POSIX::TCSANOW);
}
sub waiting {           # waiting(SECONDS): a byte is there, or arrives within SECONDS
    return 1 if @held;
    while (1) {
        my $r = ""; vec($r, $fd, 1) = 1;
        my $n = select($r, undef, undef, $_[0]);
        next if $n < 0 && $!{EINTR};
        return $n > 0;
    }
}
sub byte {              # the next byte; undef when the terminal has gone. One at a time, so that nothing typed
    return shift @held if @held;        # after the Return that ends the text is taken away from the question
    while (1) {                         # that follows.
        my $n = sysread($tty, my $b, 1);
        next if !defined $n && $!{EINTR};
        return $n ? $b : undef;
    }
}
sub shown {             # shown(TEXT): TEXT as it is shown on this terminal
    my $s = $_[0];
    if ($path) {        # a path can hold any byte: only plain characters and whole ones that are not control characters
        $s =~ s/([\x20-\x7e]+)|($multi)|[\x00-\xff]/my ($p, $c) = ($1, $2);
            defined $p ? $p : defined $c && $utf8 && $c !~ m{\A\xc2[\x80-\x9f]\z} ? $c : "?"/ge;
        return $s;
    }
    $s =~ s/[\xc0-\xff][\x80-\xbf]*/?/g unless $utf8;
    return $s;
}
# size(CHARACTER): about how many columns it takes on the screen, and whether that is so on every terminal. Marks
# that go onto another character, characters that only steer how others are drawn and skin tones take none. A
# plain ASCII character is sure to take one, and the kana, ideographs, Hangul syllables and full-width forms that
# every terminal draws two columns wide are sure to take two.
sub size {
    my $c = $_[0]; my $o = ord $c;
    return (1, 1) if $o < 0x7f;
    return (0, 0) if $c =~ /[\p{Mn}\p{Me}\p{Cf}\x{1f3fb}-\x{1f3ff}]/;
    return (2, 1) if ($o >= 0x3000 && $o <= 0x3029) || ($o >= 0x3030 && $o <= 0x303e) || ($o >= 0x3041 && $o <= 0x3096)
        || ($o >= 0x309b && $o <= 0x30ff) || ($o >= 0x3400 && $o <= 0x4db5) || ($o >= 0x4e00 && $o <= 0x9fa5)
        || ($o >= 0xac00 && $o <= 0xd7a3) || ($o >= 0xf900 && $o <= 0xfa2d) || ($o >= 0xff01 && $o <= 0xff60)
        || ($o >= 0xffe0 && $o <= 0xffe6) || ($o >= 0x20000 && $o <= 0x2a6d6);
    return (($o >= 0x1100 && ($o <= 0x115f || ($o >= 0x2e80 && $o <= 0xa4cf) || ($o >= 0xac00 && $o <= 0xd7a3)
        || ($o >= 0xf900 && $o <= 0xfaff) || ($o >= 0xfe30 && $o <= 0xfe6f) || ($o >= 0xff00 && $o <= 0xff60)
        || ($o >= 0xffe0 && $o <= 0xffe6) || ($o >= 0x1f300 && $o <= 0x1faff) || ($o >= 0x20000 && $o <= 0x3fffd))) ? 2 : 1, 0);
}
sub certain {           # certain(TEXT): every character of it, as it is shown, takes columns that are sure
    my $s = shown($_[0]); utf8::decode($s);
    for my $c (split //, $s) { return 0 unless (size($c))[1]; }
    return 1;
}
# place(TEXT, SURE): the row, counted from the first row of the prompt, and the column of the cursor after the
# prompt and TEXT are written. A character that does not fit at the end of a row goes to the next one. With SURE
# a character whose width is not sure counts as none, which gives the fewest rows the text can take.
sub place {
    my $s = $prompt . shown($_[0]); utf8::decode($s);
    my ($row, $col) = (0, 0);
    for my $c (split //, $s) {
        my ($w, $sure) = size($c);
        next unless $w && ($sure || !$_[1]);
        if ($col + $w > $cols) { $row++; $col = 0; }
        $col += $w;
    }
    return ($row, $col);
}
# redraw(SHOWN): write the text again. SHOWN is what is on the screen after the prompt, when that is known. The
# cursor goes up only as many rows as the characters of SHOWN whose width is sure are sure to have filled, so never
# above the first row of the prompt. Where the others may have filled more rows than that, or the window has
# changed size, the text is written on a new line.
sub redraw {
    if ($ansi && defined $_[0] && !$resized) {
        my ($above) = place($_[0], 0); my ($sure) = place($_[0], 1);
        if ($above == $sure) { out("\r" . ($sure ? "\e[${sure}A" : "") . "\e[J" . $prompt . shown($text)); return; }
    }
    width() if $resized || !defined $_[0];
    out("\r\n" . $prompt . shown($text));
}
sub add {               # add(CHARACTER): keep it and show it. Once the limit is reached, what follows is dropped.
    if ($full || length($text) + length($_[0]) > $limit) {
        out("\a") unless $full;
        ($full, $dropped) = (1, 1);
        return;
    }
    $text .= $_[0]; out(shown($_[0]));
}
sub unfinished {        # a character left unfinished: dropped, or for a path kept as the bytes it has
    add($part) if $path && length $part;
    $part = "";
}
sub char {              # char(BYTE): a byte of text. A character of more than one byte is held until it is whole.
    my $b = $_[0];
    if (ord($b) < 0x80) { add($b); return; }
    if (ord($b) >= 0xc0) { unfinished(); $part = $b; }  # a first byte
    elsif (length $part) { $part .= $b; }
    else { add($b) if $path; return; }                  # a byte that belongs to no character
    my $first = ord $part;
    return if length($part) < ($first >= 0xf0 ? 4 : $first >= 0xe0 ? 3 : 2);
    my $c = $part; $part = "";
    # Not U+0080 to U+009F, which are control characters, except in a path
    add($c) if $path || ($c =~ $whole && $c !~ /\A\xc2[\x80-\x9f]\z/);
}
sub last_char {         # how many bytes the last character of the text has: a whole one of UTF-8, or else one byte
    for my $n (4, 3, 2) { return $n if length($text) >= $n && substr($text, -$n) =~ $whole; }
    return length($text) ? 1 : 0;
}
sub word_start {        # where the last word of the text starts: words are parted by spaces, and those after it go too
    my $end = length $text;
    $end-- while $end && substr($text, $end - 1, 1) eq " ";
    return $end ? rindex($text, " ", $end - 1) + 1 : 0;
}
sub take_back {         # take_back(KEEP): keep only the first KEEP bytes of the text, and show that
    my $before = $text;
    return unless $_[0] < length $text;
    $text = substr($text, 0, $_[0]);
    $full = 0;
    $dropped = 0 unless length $text;                   # everything was taken back: what comes now is a new text
    my ($row, $col) = place($before, 0); my ($left, $at) = place($text, 0);
    my $n = $col - $at;
    # Within one row of the screen the characters are rubbed out where they stand. On a terminal that takes cursor
    # codes that is done only for characters whose width is sure. Otherwise, and where the text has reached the
    # edge of a row or another row is taken back, everything is written again.
    if ($left == $row && $n > 0 && $col < $cols && (!$ansi || certain(substr($before, length $text)))) {
        out(("\b" x $n) . (" " x $n) . ("\b" x $n));
    }
    else { redraw($before); }
}
# follows(LONGER): more of a key code, a string or a paste mark is there. A key sends its code at once. Inside a
# paste, and with LONGER true, the rest is given until a paste would lapse.
sub follows {
    return 1 if waiting($pasting || $_[0] ? $lapse : 0.05);
    ($pasting, $marked) = (0, 0) if $pasting;
    return 0;
}
# escape(): what comes after an Esc: a key that sends a code, the mark at either end of a paste, or a string from
# the terminal. None of it is text. An Esc inside it starts it again. False when the terminal has gone.
sub escape {
    ESC: while (1) {
        return 1 unless follows();                      # the Esc key by itself
        my $n = byte();
        return 0 unless defined $n;
        next ESC if $n eq "\e";
        if ($n eq "[") {
            my $code = "";
            while (1) {
                # No key code stops right after the [ or after 2, 20 or 200: that is the start of the mark that
                # starts a paste
                return 1 if length($code) >= $longest || !follows($code =~ /\A(?:20?0?)?\z/);
                my $c = byte();
                return 0 unless defined $c;
                # A byte that is not part of a code is taken as usual, and an Esc among them starts a new one
                if ($c !~ /[\x20-\x7e]/) { unshift @held, $c; return 1; }
                $code .= $c;
                last if $c =~ /[\x40-\x7e]/;
            }
            if ($code eq "200~") { ($pasting, $marked) = (1, 1); }
            # An end mark with more input straight behind it was part of what was pasted
            elsif ($code eq "201~" && $pasting && !waiting(0.1)) { $pasting = 0; }
        }
        elsif ($n eq "O") {
            return 1 unless follows();
            my $c = byte();
            return 0 unless defined $c;
            unshift @held, $c if $c !~ /[\x20-\x7e]/;
        }
        elsif ($n =~ /[\]PX^_]/) {                       # a string, up to a bell or Esc \
            my $seen = 0;
            while (1) {
                return 1 if ++$seen > $string || !follows();
                my $c = byte();
                return 0 unless defined $c;
                return 1 if $c eq "\a";
                next unless $c eq "\e";
                return 1 unless follows();
                my $d = byte();
                return 0 unless defined $d;
                return 1 if $d eq "\\";
                unshift @held, $d;
                next ESC;
            }
        }
        return 1;                                        # Esc and one more byte (Option with a key) is not text either
    }
}

for my $s (qw(INT TERM HUP QUIT)) {
    $SIG{$s} = sub { cooked(); out("\r\n"); $SIG{$s} = "DEFAULT"; kill $s, $$; sleep 1; exit 1; };
}
# A stop that comes from outside can find the terminal already taken back by the shell. Putting it back from
# there would stop this program in the middle of doing so, so for that moment it is done without being stopped.
$SIG{TSTP} = sub { { local $SIG{TTOU} = "IGNORE"; cooked(); } kill "STOP", $$; };
$SIG{CONT} = sub { raw(); redraw(undef); };
$SIG{WINCH} = sub { $resized = 1; };
END { cooked(); }

raw();
exit 4 unless $raw;
width();
out($prompt);
my ($ended, $late) = ("", 0);
# other(BYTE): a control character that is not acted on here: dropped, and kept in a path (but not NUL)
sub other { add($_[0]) if $path && ord $_[0]; }
while (1) {
    ($pasting, $marked) = (0, 0) if $pasting && !waiting($lapse);      # a paste that was never ended
    my $b = byte();
    last unless defined $b;
    my $o = ord $b;
    unfinished() if $o < 0x80;
    if ($o == 27) { last unless escape(); next; }
    if ($o == 10 || $o == 13) {
        if ($pasting || (!$marked && waiting(0.1))) { $path ? other($b) : add(" "); next; }   # inside a paste
        $ended = "Return"; last;
    }
    if ($o == 9) { add($path ? $b : " "); }
    elsif ($o >= 32 && $o != 127) { char($b); }
    elsif ($pasting) { other($b); }                      # a control character in a paste
    elsif ($signal{$o}) {
        if (waiting(0.1)) { other($b); next; }           # more input straight behind it: part of a paste
        cooked();                                        # typed by itself: first, while the terminal is still ours
        # then to everything the terminal would have sent it to. A stop is met here as anywhere else in the
        # group: where nothing could start the group again it is not carried out, and the question goes on.
        { local $SIG{TSTP} = "DEFAULT"; kill $signal{$o}, 0; }
        if (!$raw) { raw(); redraw(undef); }
    }
    elsif ($o == 127 || $o == 8) { take_back(length($text) - last_char()); }
    elsif ($o == 23) { take_back(word_start()); }
    elsif ($o == 21) { take_back(0); }
    elsif ($o == 4) {                                   # Ctrl-D ends the text when there is none
        if (waiting(0.1)) { other($b); next; }           # more input straight behind it: part of a paste
        if (!length $text) { $ended = "Ctrl-D"; last; }
    }
    else { other($b); }                                  # another control character: not a key here
}
unfinished();
# A paste that a terminal did not mark can arrive in pieces. What comes in straight after the Return or Ctrl-D that
# ended the text, whether there is text or not, is such a piece, and it is read and dropped here so that it answers
# no later question. However long the pieces go on coming: a paste ends, and one cut short would answer the next.
if ($ended && !$marked) {
    while (waiting(0.5)) { last unless defined byte(); $late = 1; }
}
cooked();
out("\r\n");
out("More input arrived right after $ended. It was not used.\r\n") if $late;
print $text, "|";                                   # the mark ask_line takes off: $(...) would drop line breaks at the end
exit($late ? ($dropped ? 9 : 8) : ($dropped ? 7 : 0));
# ---- the end of ASK_PL ----
PERL
program_read "$ASK_PL" ASK_PL

# drop_mark - take the reader's end mark off REPLY_TEXT, as a byte: in some locales (Shift JIS, GBK, EUC) the byte
# before it and the mark would be read as one character, and the mark would stay
drop_mark() { local LC_ALL=C; REPLY_TEXT=${REPLY_TEXT%|}; }
# ask_line PROMPT [path] - read one answer from the terminal into REPLY_TEXT, and set REPLY_RC to the reader's status
# (0, 7, 8 or 9: see above). With "path" the bytes of the answer are kept as they arrive. Fails when the reader was
# stopped by a signal; this script is then sent the same signal.
ask_line() {
    local saved
    saved=$( { /bin/stty -g < /dev/tty; } 2> /dev/null )
    REPLY_TEXT=$(plain_perl -e "$ASK_PL" -- "$1" "$P_LOCALE" "${2:-}" 2> /dev/null); REPLY_RC=$?
    case $REPLY_RC in 0|7|8|9) drop_mark; return 0 ;; esac
    REPLY_TEXT=""
    # The reader did not end by itself. Whatever stopped it may have left it no time to put the terminal back, so
    # that is done here, before anything else: the settings as they were, and no more marks around a paste.
    [ -n "$saved" ] && { /bin/stty "$saved" < /dev/tty; } 2> /dev/null
    case "${TERM:-}" in ''|dumb|unknown) ;; *) { printf '\033[?2004l' > /dev/tty; } 2> /dev/null ;; esac
    if [ $REPLY_RC -gt 128 ]; then              # the reader was stopped by a signal (Ctrl-C): so is this script,
        kill -$((REPLY_RC - 128)) $$ 2> /dev/null   # unless it was started in a way that ignores that signal
        return 1
    fi
    REPLY_RC=0
    read -r -p "$1" REPLY_TEXT < /dev/tty || REPLY_TEXT=""      # no perl, or no terminal it can use: a plain line
}
# ask_text - read free text from the terminal into REPLY_TEXT. Sets NOTE_OVER when more arrived than the reader keeps
# (what did not fit was dropped, and the text may have been edited since), and NOTE_LATE when input that arrived after
# the Return that ended it was dropped.
ask_text() {
    ask_line "> " || return 0
    case $REPLY_RC in 7|9) NOTE_OVER=1 ;; esac
    case $REPLY_RC in 8|9) NOTE_LATE=1 ;; esac
}
# typed_path TEXT - the path in an answer to the workbook question: its backslash escapes taken off (a backslash and
# the character after it become that character, a backslash before a line break goes with it, and a backslash with
# nothing after it stays), then white space and straight quote marks taken off both ends, and nothing else. That is
# how Terminal writes the path of a file dragged into its window. Bytes, whatever the locale. Fails when what is left
# is longer than any path can be.
typed_path() (
    LC_ALL=C; IFS=$' \t\n'
    ends=$' \t\n\v\f\r\'"'
    p=$1; out=""
    # The escapes are taken off here, one backslash at a time from the left. read without -r would do it, but only
    # from a here-string, which bash writes into a file of its own first: on a full disk it cannot, read then sets
    # nothing, and the escapes would stay.
    while :; do
        case $p in *\\*) ;; *) out=$out$p; break ;; esac
        before=${p%%\\*}
        out=$out$before; p=${p:${#before}+1}
        case $p in
            '') out=$out\\; break ;;                    # a backslash with nothing after it stays
            $'\n'*) p=${p:1} ;;                         # a backslash before a line break goes with it
            *) out=$out${p:0:1}; p=${p:1} ;;            # a backslash and the character after it become that character
        esac
    done
    p=${out#"${out%%[!$ends]*}"}
    p=${p%"${p##*[!$ends]}"}
    printf '%s' "$p"
    [ ${#p} -le 1024 ]          # PATH_MAX on macOS
)

# What was given for --note, made fit to keep in a text file: one line of at most 500 characters, without control
# characters, key codes or the characters on the list below, which reorder text or draw nothing. Letters, accents,
# other scripts and emoji stay as they are, with the characters that join them or choose their form. A text made
# only of characters that draw nothing is kept as no text at all. Ends with status 7 when the text was longer and
# only its beginning is kept.
clean_note() {
    printf '%s' "$1" | plain_perl -e '
        use Encode ();
        binmode(STDIN); binmode(STDOUT);
        local $/; my $s = <STDIN>; $s = "" unless defined $s;
        $s =~ s/\e(?:\[[0-?]*[ -\/]*[\@-~]|O[ -~])//g;      # the codes that arrow and function keys send
        $s = Encode::decode("UTF-8", $s, sub { " " });      # a byte that is not UTF-8 text becomes a space
        $s =~ s/[\x{ad}\x{61c}\x{180e}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{206f}\x{feff}\x{fff9}-\x{fffb}\x{e0000}-\x{e007f}]//g;
        $s =~ s/[\x00-\x20\x7f-\x{a0}\x{2028}\x{2029}]+/ /g;
        $s =~ s/\A //; $s =~ s/ \z//;
        # Something that shows: not a space of any width, an empty braille cell, or a character that is there to
        # be ignored when text is drawn (joiners, direction marks, fillers, the characters that choose a form)
        my $shows = qr/[^ \x{2000}-\x{200a}\x{202f}\x{205f}\x{2800}\x{3000}\p{Default_Ignorable_Code_Point}]/;
        $s = "" unless $s =~ $shows;
        my $cut = length($s) > 500 ? 1 : 0;
        if ($cut) {
            my $next = substr($s, 500, 1);
            $s = substr($s, 0, 500);
            $s =~ s/ [^ ]{0,60}\z// if $next ne " ";         # not through a word, where a space is near
            $s =~ s/ \z//;
            ($s, $cut) = ("", 0) unless $s =~ $shows;        # nothing that shows is left of the beginning
        }
        utf8::encode($s); print $s; exit($cut ? 7 : 0)'
}

# Turns what was given for --note into the line that is kept. Done once, before anything else sees the text.
prepare_note() {
    local text rc
    [ -n "$NOTE" ] || { NOTE_CUT=0; NOTE_LATE=0; NOTE_OVER=0; NOTE_CUT_TOLD=0; NOTE_LATE_TOLD=0; NOTE_OVER_TOLD=0; return 0; }
    text=$(clean_note "$NOTE"); rc=$?
    case $rc in
        0) ;;
        7) NOTE_CUT=1 ;;
        *) text=$NOTE; NOTE_PLAIN=1 ;;          # perl could not be run, or failed
    esac
    # Without perl only the plain ASCII characters are kept, which the shell can count by itself. The same is done
    # when this run is told so (--note-plain): the file written about the note then says what was kept, and that the
    # run was started with that option.
    if [ "$NOTE_PLAIN" -eq 1 ] || [ "$NOTE_PLAIN_TOLD" -eq 1 ]; then
        text=$(printf '%s' "$text" | LC_ALL=C tr -c '\040-\176' ' ' | LC_ALL=C tr -s ' ')
        text=${text# }; text=${text% }
        if [ ${#text} -gt 500 ]; then text=${text:0:500}; text=${text% }; NOTE_CUT=1; fi
    fi
    NOTE=$text
    # nothing is kept, so nothing is said about it
    [ -n "$NOTE" ] || { NOTE_CUT=0; NOTE_LATE=0; NOTE_OVER=0; NOTE_CUT_TOLD=0; NOTE_LATE_TOLD=0; NOTE_OVER_TOLD=0; }
}

# Run from Terminal without options, ask for everything up front; options already given are not asked
# again. The answers are passed on as options to the sudo re-run, which then asks nothing.
if [ "$PROMPT" -eq 1 ] && [ "$JAMF" -eq 0 ] && [ -t 0 ]; then
    echo
    echo "Excel diagnostics. Press Return to accept the answer in [brackets]."
    echo
    if [ "$MODE_SET" -eq 0 ]; then
        echo "What do you want to do?"
        echo "  1) Collect logs after a crash or slowdown that already happened"
        echo "  2) Capture while the user reproduces the problem (start now, press Ctrl-C after it happens)"
        echo "  3) Excel is frozen right now (do this before force-quitting it; the run says when Excel can be force-quit)"
        echo "  4) Monitor Excel's memory over time"
        ask_number "Choose 1-4" 1 1 4
        case $REPLY_NUMBER in 1) MODE=collect ;; 2) MODE=repro ;; 3) MODE=hang ;; 4) MODE=watch ;; esac
        ORIG_ARGS+=("$MODE")
    fi
    if [ "$MODE" = collect ] && [ "$DAYS_SET" -eq 0 ]; then
        if [ -n "$UNTIL" ]; then
            ask_number "How many days back from $UNTIL should the log search go ($UNTIL counts as 1)?" "$DAYS" 1 60; DAYS=$REPLY_NUMBER
        else
            ask_number "How many days back should the log search go (today counts as 1)?" "$DAYS" 1 60; DAYS=$REPLY_NUMBER
        fi
        ORIG_ARGS+=(--days "$DAYS")
    fi
    if [ "$MODE" = collect ] && [ "$WAIT_SET" -eq 0 ]; then
        ask_number "Most minutes to spend searching each day's logs (0 = no limit)?" "$MAX_WAIT"; MAX_WAIT=$REPLY_NUMBER
        ORIG_ARGS+=(--max-wait "$MAX_WAIT")
    fi
    if [ "$MODE" = collect ] || [ "$MODE" = repro ]; then
        if [ -z "$NOTE" ]; then
            # Return alone records nothing
            echo "What happened, in a few words? What you type is saved in the results. Press Return to skip."
            ask_text; NOTE=$REPLY_TEXT
        fi
        if [ -z "$WORKBOOK" ]; then
            # Decided by what the answer comes to, not by what the reader dropped: what is left after an edit is
            # what was chosen
            while :; do
                ask_line "Workbook involved (drag it into this window, or press Return to skip; it is not copied): " path || continue
                WORKBOOK=$(typed_path "$REPLY_TEXT") && break
                WORKBOOK=""
                echo "  That is longer than a path can be, so it was not used." >&2
            done
            [ -n "$WORKBOOK" ] && ORIG_ARGS+=(--workbook "$WORKBOOK")
        fi
    fi
    if [ "$REDACT" -eq 0 ]; then
        echo "The results name this Mac and its user. Hiding those also leaves out files that are not plain text"
        echo "(OneDrive's own logs, for example), which cannot then be got back from this run. The names of files"
        echo "and folders stay visible either way."
        if ask_yes "Hide the user's name, this Mac's name and serial number, and email addresses?" n; then
            REDACT=1; ORIG_ARGS+=(--redact)
        fi
    fi
    echo
    case "$MODE" in
        collect) SAY_DAYS=1 ;;           # said below, once the days are worked out from the dates
        # The reproduction is asked for only once the live log stream has been started (see mode_repro), which is
        # after the re-run with sudo and a first snapshot
        repro)   echo "The capture says when to reproduce the problem. Wait for that line." ;;
    esac
    ORIG_ARGS+=(--no-prompt)
fi

[ "$DAYS" -ge 1 ] || DAYS=1
[ "$INTERVAL" -ge 5 ] || INTERVAL=5
QUERY_TIMEOUT=$((MAX_WAIT * 60))           # seconds per unified-log search; 0 = no limit
[ -n "$UNTIL" ] || UNTIL=$(date '+%Y-%m-%d')
if [ -z "$SINCE" ]; then
    SINCE=$(TZ=UTC0 date -j -v-"$((DAYS - 1))"d -f '%Y-%m-%d %H:%M:%S' "$UNTIL 12:00:00" '+%Y-%m-%d' 2>/dev/null)   # the days up to --until, counted in UTC
fi
# The days are counted between midnights in UTC: in local time a day across a change of the clocks is an hour short
SINCE_EPOCH=$(TZ=UTC0 date -j -f '%Y-%m-%d %H:%M:%S' "$SINCE 00:00:00" '+%s' 2>/dev/null)
UNTIL_EPOCH=$(TZ=UTC0 date -j -f '%Y-%m-%d %H:%M:%S' "$UNTIL 00:00:00" '+%s' 2>/dev/null)
case "$SINCE_EPOCH" in ''|*[!0123456789-]*) echo "Could not work out the first day to search" >&2; exit 2 ;; esac
case "$UNTIL_EPOCH" in ''|*[!0123456789-]*) echo "Could not work out the last day to search" >&2; exit 2 ;; esac
if [ "$SINCE_EPOCH" -gt "$UNTIL_EPOCH" ]; then echo "--since must be on or before --until" >&2; exit 2; fi
DAYS=$(( (UNTIL_EPOCH - SINCE_EPOCH) / 86400 + 1 ))
[ -n "$SAY_DAYS" ] && echo "Collecting $DAYS day(s) of logs, $SINCE through $UNTIL, $([ "$MAX_WAIT" -eq 0 ] && echo "no time limit" || echo "at most $MAX_WAIT minute(s) per day (up to $((DAYS * MAX_WAIT)) minutes)")."
REPORT_DAYS=30                             # report files and sleep/wake history are cheap; keep a month
[ "$DAYS" -gt "$REPORT_DAYS" ] && REPORT_DAYS=$DAYS

# The note is made into the line that is kept before anything else is done with it, and the arguments for the
# sudo re-run are rebuilt to carry that line and not what was typed. Jamf's arguments are positions and stay.
prepare_note
if [ "$JAMF" -eq 0 ]; then
    kept=(); after=""
    for a in ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}; do
        case "$after" in
            value) kept+=("$a"); after=""; continue ;;      # another option's value, whatever it looks like
            note)  after=""; continue ;;                     # what followed --note or --case
        esac
        case "$a" in
            --days|--since|--max-wait|--until|--workbook|--interval|--hours|--outdir) kept+=("$a"); after=value ;;
            --note|--case) after=note ;;
            --note=*|--case=*|--note-cut|--note-plain|--note-late|--note-over) ;;
            *) kept+=("$a") ;;
        esac
    done
    ORIG_ARGS=(${kept[@]+"${kept[@]}"})
    # EXCEL_DIAG_OUTDIR is handed on as --outdir: sudo passes a variable on only when it is set up to
    [ -z "$OUTDIR" ] && [ -n "${EXCEL_DIAG_OUTDIR:-}" ] && ORIG_ARGS+=(--outdir "$EXCEL_DIAG_OUTDIR")
    [ -n "$NOTE" ] && ORIG_ARGS+=("--note=$NOTE")
    # What this run found out, or was told, about the note is handed on, each as the option that stands for it
    [ $((NOTE_CUT + NOTE_CUT_TOLD)) -gt 0 ] && ORIG_ARGS+=(--note-cut)
    [ $((NOTE_PLAIN + NOTE_PLAIN_TOLD)) -gt 0 ] && ORIG_ARGS+=(--note-plain)
    [ $((NOTE_LATE + NOTE_LATE_TOLD)) -gt 0 ] && ORIG_ARGS+=(--note-late)
    [ $((NOTE_OVER + NOTE_OVER_TOLD)) -gt 0 ] && ORIG_ARGS+=(--note-over)
fi

# ---- Nothing above this line collects anything or asks for admin rights; test/note_test.sh runs it as it is ----
if [ "$MODE" != watch ] && [ "$(id -u)" -ne 0 ] && [ "$NO_SUDO" -eq 0 ]; then
    case "$MODE" in
        hang) echo "Re-running with sudo, so that this mode reads the unified log and runs spindump as root..." ;;
        *)    echo "Re-running with sudo, so that this mode reads the unified log and /Library/Logs/DiagnosticReports as root..." ;;
    esac
    echo "(Ctrl-C to cancel, or add --no-sudo to collect only what this account can read.)"
    # The arguments are put together here, in this shell's C locale, and not by a shell in another locale
    if [ -n "$P_LC_ALL_SET" ]; then
        exec /usr/bin/env "LC_ALL=$P_LC_ALL" sudo /bin/bash "$0" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
    fi
    exec sudo /bin/bash "$0" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi
# From here every program this script runs works on bytes (the C locale), as under Jamf. In some locales sort, sed and
# tr stop at a byte that is no character there, without a word, and a list or a count would come out short; and a
# pattern for a name would mean one thing to one program and another to the next. The questions were asked above in
# the locale of whoever runs this, and the re-run with sudo was given that locale. The settings a person may have
# made for their own tools are not used either: grep takes options from GREP_OPTIONS, gzip from GZIP, and perl
# (shasum is a perl program) options and code from PERL5OPT and PERL5LIB.
LC_ALL=C; export LC_ALL
unset GREP_OPTIONS GZIP PERL5OPT PERL_UNICODE PERL5LIB PERLLIB PERLIO

# The screen, kept on two spare descriptors: an interrupt can arrive while output is being written into a bundle
# file, and what is said after that must still reach the person. The name hiding reports its progress there too.
exec 5>&1 6>&2

# Work on behalf of whoever is logged in at the console, even when run via sudo or Jamf.
CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null)
case "$CONSOLE_USER" in ""|root|loginwindow|_mbsetupuser) CONSOLE_USER=${SUDO_USER:-$(id -un)} ;; esac
# The home folder as the account database gives it, whole (a path can hold spaces), for network accounts too. When it
# gives none, or no folder is there, /Users/NAME is taken instead, and that is said.
USER_HOME=$(plain_perl -e 'my @pw = getpwnam($ARGV[0]); print $pw[7] if @pw && defined $pw[7]' -- "$CONSOLE_USER" 2>/dev/null)
if [ -z "$USER_HOME" ]; then
    echo "The account database gives no home folder for $(seen "$CONSOLE_USER"), so /Users/$(seen "$CONSOLE_USER") is taken as that user's home folder."
    USER_HOME="/Users/$CONSOLE_USER"
elif [ ! -d "$USER_HOME" ]; then
    echo "No folder is at $(seen "$USER_HOME"), the home folder the account database gives for $(seen "$CONSOLE_USER"), so /Users/$(seen "$CONSOLE_USER") is taken as that user's home folder."
    USER_HOME="/Users/$CONSOLE_USER"
fi

# Everything in the console user's home is read with that user's rights, never with root's. That user decides what
# is in their home: a link put where a log folder is expected would otherwise make root fetch a file the user
# cannot read, into a bundle that is then handed to them.
AM_ROOT=0; [ "$(id -u)" -eq 0 ] && AM_ROOT=1
USER_UID=$(id -u "$CONSOLE_USER" 2>/dev/null)
USER_GID=$(id -g "$CONSOLE_USER" 2>/dev/null)
USER_GROUPS=$(id -G "$CONSOLE_USER" 2>/dev/null)
USER_READS=1                               # 0 = this script is root and could not take on that user's rights
HOME_SHUT=0                                # 1 = nothing more is read with that user's rights (see as_user)
IFS= read -r -d '' AS_USER_PL <<'PERL'
# Runs a command with the rights of one user and no more, and for no longer than it is given:
#   LEDGER SECONDS USER-ID GROUP-ID "GROUP-IDS" COMMAND ARGUMENT...
# The command gets a process group of its own. When the time is up, when this program is told to stop, and when the
# command has ended, everything left in that group is killed: a helper that runs as the user can be stopped by that
# user, and nothing it started may hold root up (a program of the group that is left could keep a pipe of root's
# open). Each wait for the command to end after it was killed lasts 5 seconds at most: one held in the kernel (by a
# volume that no longer answers, say) is left, and this program ends all the same. So that whatever reads what the
# command writes does not wait for such a one either, its output and its error stream, where this program was given a
# pipe for them, are pipes of this program's own, which it passes on: what root reads ends when this program ends.
# What has come by 5 seconds after the command ended is passed on. A pipe that this program cannot write into any
# more (what read it went away) is closed on the command's side too, as it would have been without this program
# between. The time the command took is then added to LEDGER (a file in the working folder, "-" for none), one byte
# for each hundredth of a second, and three more for what starting this program and the script's own look at the
# LEDGER cost: the script adds up the time it has spent on that user's helpers by its size. The command reads
# nothing (its input is /dev/null), unless AS_STDIN is set: then it reads what this program was given to read.
use strict; use POSIX (); use Fcntl (); use Time::HiRes ();
my ($ledger, $limit, $uid, $gid, $groups, @cmd) = @ARGV;
exit 126 unless @cmd && defined $ledger && $limit =~ /^\d+$/ && $uid =~ /^\d+$/ && $gid =~ /^\d+$/ && $groups =~ /^[\d ]*$/ && $uid > 0;
my $began = Time::HiRes::time();
# The ledger is opened now, while the working folder is still this script's alone, and written later through what
# was opened: never by its name at the end, when whatever stands at that name may be someone else's
my $l;
if ($ledger ne '-') { sysopen($l, $ledger, Fcntl::O_WRONLY() | Fcntl::O_APPEND() | Fcntl::O_CREAT() | Fcntl::O_NOFOLLOW(), 0600) or undef $l; }
my $spent = sub {
    return unless $l;
    syswrite($l, '.' x (int((Time::HiRes::time() - $began) * 100) + 3));
};
my %seen = ($gid => 1);
my @want = ($gid, grep { !$seen{$_}++ } split ' ', $groups);
splice @want, 16 if @want > 16;                     # as many as one process can hold; the others are done without
# The pipes of this program's own, for its output (1) and its error stream (2) where each of those is a pipe or a socket:
# a file, the terminal or /dev/null is the command's to write into itself, and nobody waits for its end
my %relay;
for my $fd (1, 2) {
    my $h = $fd == 1 ? \*STDOUT : \*STDERR;
    next unless -p $h || -S $h;
    pipe(my $r, my $w) or exit 126;
    $relay{$fd} = [$r, $w, $h];
}
my $pid = fork();
exit 126 unless defined $pid;
if (!$pid) {
    setpgrp(0, 0);
    open STDIN, '<', '/dev/null' unless $ENV{AS_STDIN};
    delete $ENV{AS_STDIN};
    for my $fd (keys %relay) { defined POSIX::dup2(fileno $relay{$fd}[1], $fd) or POSIX::_exit(126); }
    $) = "$gid @want";                              # that user's groups, set while still root
    POSIX::setgid($gid); POSIX::setuid($uid);       # as root these set the real, effective and saved ids at once
    POSIX::_exit(126) unless $< == $uid && $> == $uid && $( + 0 == $gid && $) + 0 == $gid;
    POSIX::_exit(126) if defined POSIX::setuid(0);  # there must be no way back to root
    # And no group of root's may be left: setting them can fail. The kernel is asked what this process holds (79
    # is getgroups). perl's own list is no use here: it comes from the directory service, which names every group
    # of the user, held by this process or not, and says nothing of what the process does hold.
    my %mine = map { $_ => 1 } @want;
    my $held = "\0" x 256;
    my $count = syscall(79, 64, $held);
    POSIX::_exit(126) if $count < 0;
    for my $g (unpack "L$count", $held) { POSIX::_exit(126) unless $mine{$g}; }
    my @pw = getpwuid($uid);
    if (@pw) { $ENV{HOME} = $pw[7]; $ENV{USER} = $ENV{LOGNAME} = $pw[0]; }
    # TMPDIR names a folder of root's (see where it is set), which the command could not write to
    delete @ENV{qw(SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND TMPDIR)};
    chdir "/";
    POSIX::close($_) for 3 .. 255;                  # the screen, which this script keeps on two spare descriptors, is not the command's
    exec { $cmd[0] } @cmd;
    POSIX::_exit(127);
}
POSIX::setpgid($pid, $pid);
# A write into a pipe whose reader went away fails here, and is not this program's end (set only now: the command
# must not start with it ignored)
$SIG{PIPE} = 'IGNORE';
my %from;                                           # descriptor of the read end => [read end, where it goes]
for my $fd (keys %relay) { close $relay{$fd}[1]; binmode $relay{$fd}[0]; binmode $relay{$fd}[2]; $from{fileno $relay{$fd}[0]} = [$relay{$fd}[0], $relay{$fd}[2]]; }
# pass(SECONDS): waits that long at most for what the command writes, and passes on what has come. A pipe the command
# and its group have all closed is closed here, and so is one whose passing on failed.
my $pass = sub {
    my $in = '';
    vec($in, $_, 1) = 1 for keys %from;
    my $ready = select(my $out = $in, undef, undef, $_[0]);
    return if $ready <= 0;
    for my $fd (keys %from) {
        next unless vec($out, $fd, 1);
        my ($r, $to) = @{$from{$fd}};
        my $n = sysread($r, my $buf, 1 << 16);
        next if !defined $n && $!{EINTR};
        my $at = 0;
        while ($n && $at < $n) {
            my $w = syswrite($to, $buf, $n - $at, $at);
            if (!defined $w) { next if $!{EINTR}; last }
            $at += $w;
        }
        if (!$n || $at < $n) { close $r; delete $from{$fd}; }
    }
};
my ($status, $reaped) = (0, 0);
# reap(BLOCK): whether the command has ended; with BLOCK, waits for that
my $reap = sub {
    my $r = waitpid($pid, $_[0] ? 0 : POSIX::WNOHANG());
    if ($r == $pid) { ($status, $reaped) = ($?, 1) }
    elsif ($r < 0 && !$!{EINTR}) { ($status, $reaped) = (125 << 8, 1) }
    return $reaped;
};
# Kills what is left in the command's group, again until nothing is: a program of the group that was starting
# another just then would otherwise leave that one behind. A second at most.
my $sweep = sub { for (1 .. 40) { last unless kill 0, -$pid; kill 'KILL', -$pid; Time::HiRes::sleep(0.025); } };
my $stop = sub {
    my $code = shift;
    $SIG{$_} = 'IGNORE' for qw(ALRM INT TERM HUP QUIT);
    kill 'KILL', -$pid; kill 'KILL', $pid;
    my $until = Time::HiRes::time() + 5;
    until ($reap->(0)) { last if Time::HiRes::time() >= $until; Time::HiRes::sleep(0.05); }
    $sweep->(); $spent->();
    exit $code;
};
$SIG{ALRM} = sub { $stop->(124) };
# An interrupt ends the command too, unless whoever started this program had it ignored (the hand-over at the end).
# Ctrl-\ (QUIT) among them: the command is in a group of its own, which the terminal does not reach.
my %code = (INT => 130, TERM => 143, HUP => 129, QUIT => 131);
for my $s (keys %code) { $SIG{$s} = sub { $stop->($code{$s}) } unless ($SIG{$s} || '') eq 'IGNORE'; }
alarm $limit if $limit > 0;
until ($reaped) { if (%from) { $pass->(0.25); $reap->(0); } else { $reap->(1); } }
alarm 0;
$sweep->();                                         # whatever the command left behind in its group
# What it wrote is passed on until its pipes end, which they do at once once its group is gone: 5 seconds at most
my $until = Time::HiRes::time() + 5;
while (%from) { my $left = $until - Time::HiRes::time(); last if $left <= 0; $pass->($left); }
$spent->();
exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
# ---- the end of AS_USER_PL ----
PERL
program_read "$AS_USER_PL" AS_USER_PL
# as_user COMMAND ARGUMENT... - run it as the console user when this script is root, for at most AS_LIMIT seconds
as_user() {
    local rc
    if [ "$AM_ROOT" -eq 0 ]; then "$@"; return; fi
    case "$USER_UID" in 0) "$@"; return ;; ''|*[!0123456789]*) return 126 ;; esac
    [ "$USER_READS" -eq 1 ] || return 126
    # Once one step run with the user's rights has been stopped at its time limit, none is run any more: that user
    # can stop every helper of theirs, and the number of helpers is theirs to choose (one per file they put there).
    # The mark is a file in the working folder, which only this script can write to, so that a step run in a
    # subshell ($(...), <(...)) sees it too, and HOME_SHUT in this shell, which holds even when the file could not
    # be made (a full disk). The hand-over clears both and handles its own time limits, and the mark is not looked
    # at during it (AS_HANDOVER): by then the working folder is the user's, and root's shell would follow whatever
    # they put at that name, or wait on it.
    [ "${HOME_SHUT:-0}" -eq 1 ] && return 126
    [ -z "${AS_HANDOVER-}" ] && [ -n "$STAGE" ] && [ -e "$STAGE/.limit" ] && return 126
    # A limit for each helper is not enough by itself: one held just short of it, then the next, and so on, would
    # still hold the run for as long as that user likes. So the time spent on that user's helpers in all is kept in
    # a ledger (see AS_USER_PL), and once it reaches USER_SECONDS nothing more is run with that user's rights. The
    # hand-over keeps its own count (AS_LEDGER is empty there).
    local ledger="-" limit=${AS_LIMIT:-300} used left grown
    if [ -n "$STAGE" ] && [ "${AS_LEDGER-x}" = x ]; then
        ledger="$STAGE/.user_time"
        used=$(/usr/bin/stat -f '%z' "$ledger" 2>/dev/null || echo 0)
        case "$used" in ''|*[!0123456789]*) used=0 ;; esac
        left=$(( ${USER_SECONDS:-1800} - used / 100 ))
        if [ "$left" -le 0 ]; then rights_spent; return 126; fi
        [ "$limit" -eq 0 ] || [ "$limit" -gt "$left" ] && limit=$left
    fi
    plain_perl -e "$AS_USER_PL" -- "$ledger" "$limit" "$USER_UID" "$USER_GID" "$USER_GROUPS" "$@"; rc=$?
    # What was stopped is said by what it was for (AS_WHAT), or by the one file it was reading (AS_PATH)
    if [ $rc -eq 124 ]; then
        if [ -n "$AS_WHAT" ]; then limit_hit "$limit" "$AS_WHAT"
        elif [ -n "$AS_PATH" ]; then limit_hit "$limit" "reading $(shown_path "$AS_PATH")"
        else limit_hit "$limit" "${1##*/}"; fi
    fi
    # Every helper adds to the ledger. One that did not (the disk is full, or the ledger could not be opened) leaves
    # the ledger unable to say how much time is left, so the time allowed is then taken as used up.
    if [ "$ledger" != - ]; then
        grown=$(/usr/bin/stat -f '%z' "$ledger" 2>/dev/null || echo 0)
        case "$grown" in ''|*[!0123456789]*) grown=0 ;; esac
        [ "$grown" -gt "$used" ] || rights_spent unrecorded
    fi
    return $rc
}
# A step that was stopped at its time limit is said in collection.log and in the status table, and from then on
# nothing more is run with the console user's rights (see as_user). It writes nothing when LOG or MANIFEST is
# empty: the hand-over empties them, because by then the bundle folder belongs to that user.
limit_hit() {
    [ -n "$LOG" ] && [ -n "$MANIFEST" ] && [ -n "$STAGE" ] || return 0
    # A step that may be slow for reasons of its own (a workbook on a volume that no longer answers) ends only itself
    if [ -n "$AS_KEEP_OPEN" ]; then
        echo "[$(date '+%H:%M:%S')]   stopped after $1 seconds without finishing: $2 (run with the console user's rights)." >> "$LOG"
        return 0
    fi
    log_line "  stopped after $1 seconds without finishing: $2 (run with the console user's rights). Nothing more is read with that user's rights in this run."
    if [ "${HOME_SHUT:-0}" -ne 1 ] && [ ! -e "$STAGE/.limit" ]; then
        HOME_SHUT=1
        : 2>/dev/null > "$STAGE/.limit"
        record_status "time_limit" "failed" "a step run with the console user's rights was stopped after $1 seconds; nothing more was read with that user's rights after it; see collection.log"
    fi
    HOME_SHUT=1
}
# The time allowed for everything run with the console user's rights is used up, or (with "unrecorded") the time a
# helper took could not be added to the ledger, so what is left of it is not known: said once, like a time limit
rights_spent() {
    [ -n "$LOG" ] && [ -n "$MANIFEST" ] && [ -n "$STAGE" ] || return 0
    [ "${HOME_SHUT:-0}" -eq 1 ] && return 0
    HOME_SHUT=1
    [ -e "$STAGE/.limit" ] && return 0
    : 2>/dev/null > "$STAGE/.limit"
    if [ "${1:-}" = unrecorded ]; then
        log_line "  the time a helper run with the console user's rights took could not be added to the record of that time in the working folder, so the ${USER_SECONDS:-1800} seconds allowed for all of them are taken as used up. Nothing more is read with that user's rights in this run."
        record_status "time_limit" "failed" "the time a helper run with the console user's rights took could not be added to the record of that time in the working folder, so the ${USER_SECONDS:-1800} seconds allowed for all of them were taken as used up; nothing more was read with that user's rights after that; see collection.log"
        return 0
    fi
    log_line "  the ${USER_SECONDS:-1800} seconds allowed for everything run with the console user's rights are used up. Nothing more is read with that user's rights in this run."
    record_status "time_limit" "failed" "the ${USER_SECONDS:-1800} seconds allowed for everything run with the console user's rights were used up; nothing more was read with that user's rights after that; see collection.log"
}
# Whether this run still reads with the console user's rights. A step that wrote down what it found in that
# user's home says "incomplete" when it may have been refused some of it.
home_closed() { [ "$AM_ROOT" -eq 1 ] && { [ "$USER_READS" -eq 0 ] || [ "${HOME_SHUT:-0}" -eq 1 ] || { [ -n "$STAGE" ] && [ -e "$STAGE/.limit" ]; }; }; }
# log_line TEXT - TEXT as a line of collection.log, with the time, and not on the screen: for the steps whose own
# output is a file of the bundle. A line that cannot be written is dropped: bash would otherwise keep it, and write it
# out with whatever this shell writes next.
log_line() {
    echo "[$(date '+%H:%M:%S')] $1" 2>/dev/null >> "$LOG" || echo > /dev/null
}

# How a step went is counted while it runs, and its row in the status table is decided from those counts (see row).
# step_begin sets them to 0, at the start of each step:
#   UNANSWERED      programs run with the console user's rights that ended without an answer
#   OWN_UNANSWERED  programs this script ran with its own rights that ended without an answer
#   UNREAD          files that were there and could not be read whole (see copy_said)
#   UNWRITTEN       things that could not all be written into the working folder (see unwritten)
#   REPORTS_LEFT    files the reports step listed and did not go through
#   UNWALKED        lists, searches and counts made by find that find ended with 1 (see find_one)
#   STEP_WHY        anything else that leaves the step without all it was to collect, in words, each ended with "; "
step_begin() {
    UNANSWERED=0; OWN_UNANSWERED=0; UNREAD=0; UNWRITTEN=0; REPORTS_LEFT=0; UNWALKED=0; STEP_WHY=""
}
# row NAME DETAILS [home] - the row of the step that just ran: complete only when none of those counts counted
# anything, and otherwise incomplete, with why. With "home" the step read the console user's home folder, and a
# home folder that is no longer read makes it incomplete too.
row() {
    local why=""
    [ "${3:-}" = home ] && home_closed && why="; reading with the console user's rights was stopped, so what is in that user's home may be missing (see time_limit or user_files)"
    [ "${UNANSWERED:-0}" -gt 0 ] && why="$why; $UNANSWERED program(s) run with the console user's rights ended without an answer, so what they were to read may be missing (see collection.log)"
    [ "${OWN_UNANSWERED:-0}" -gt 0 ] && why="$why; $OWN_UNANSWERED program(s) this script ran with its own rights ended without an answer, so what they were to read may be missing (see collection.log)"
    [ "${UNREAD:-0}" -gt 0 ] && why="$why; $UNREAD file(s) that were there could not be read whole (see collection.log)"
    [ "${UNWRITTEN:-0}" -gt 0 ] && why="$why; $UNWRITTEN time(s) what it had could not all be written into the working folder (see collection.log)"
    [ "${REPORTS_LEFT:-0}" -gt 0 ] && why="$why; $REPORTS_LEFT file(s) it listed were not gone through (see report_lists)"
    [ "${UNWALKED:-0}" -gt 0 ] && why="$why; $UNWALKED list(s), search(es) or count(s) made by find ended with find's status 1, which it gives when it meets an error on the way, so they may leave something out (see collection.log)"
    [ -n "${STEP_WHY:-}" ] && why="$why; ${STEP_WHY%; }"
    if [ -n "$why" ]; then record_status "$1" incomplete "$2$why"; else record_status "$1" complete "$2"; fi
}
# unwritten WHAT - WHAT could not all be written into the working folder (a full disk, say): said in collection.log
# and on the screen, and counted for the step's row and for the last lines of the run, which say it whatever else
# could not be written by then
unwritten() {
    UNWRITTEN=$((${UNWRITTEN:-0} + 1)); WRITES_LOST=$((${WRITES_LOST:-0} + 1))
    log_line "  $1 could not all be written into the working folder"
    echo "[$(date '+%H:%M:%S')]   $1 could not all be written into the working folder" 2>/dev/null >&5
    return 0
}
# put FILE [append] - writes what it reads into FILE, made or emptied first (or added to, with "append"). When FILE
# cannot be opened or written to, it reads on to the end without writing, so that what writes into it is never
# stopped by a pipe that closed, and ends with status 4.
put() {
    if [ "$HAVE_PERL" -eq 1 ]; then
        plain_perl -e 'use Fcntl (); my ($f, $how) = @ARGV; binmode STDIN;
            my $bad = sysopen(my $o, $f, Fcntl::O_WRONLY() | Fcntl::O_CREAT() | Fcntl::O_NOFOLLOW()
                | ($how eq "append" ? Fcntl::O_APPEND() : Fcntl::O_TRUNC()), 0644) ? 0 : 1;
            my ($buf, $n);
            while ($n = sysread(STDIN, $buf, 1 << 20)) {
                next if $bad;
                my $at = 0;
                while ($at < $n) { my $w = syswrite($o, $buf, $n - $at, $at); unless (defined $w) { $bad = 1; last } $at += $w }
            }
            $bad = 1 unless defined $n;
            if ($o) { close $o or $bad = 1 }
            exit($bad ? 4 : 0)' -- "$1" "${2:-}"
        return
    fi
    if [ "${2:-}" = append ]; then cat >> "$1"; else cat > "$1"; fi 2>/dev/null && return 0
    cat > /dev/null; return 4
}
# most_of N SEP [FILE [append]] - passes on the first N records of what it reads (SEP: line or nul) into FILE (made or
# emptied first, or added to), or out when no FILE is given, and reads the rest without passing it on, so that what
# writes them is not stopped by a pipe that closed; then writes how many records there were in all into the working
# folder (found_count reads it). Ends with status 4 when what it was to write could not all be written, the count
# among it. Without perl it passes everything on.
most_of() {
    rm -f "$STAGE/.found_count"
    if [ "$HAVE_PERL" -eq 0 ]; then
        if [ -n "${3:-}" ]; then put "$3" "${4:-}"; else cat; fi
        return
    fi
    plain_perl -e 'use Fcntl (); my ($most, $sep, $count, $file, $how) = @ARGV; $/ = $sep eq "nul" ? "\0" : "\n"; binmode STDIN;
        my ($out, $bad);
        if (length $file) {
            sysopen($out, $file, Fcntl::O_WRONLY() | Fcntl::O_CREAT() | Fcntl::O_NOFOLLOW() | ($how eq "append" ? Fcntl::O_APPEND() : Fcntl::O_TRUNC()), 0600) or $bad = 1;
        } else { $SIG{PIPE} = "IGNORE"; open($out, ">&", \*STDOUT) or $bad = 1 }
        binmode $out unless $bad;
        my $n = 0; while (<STDIN>) { next if ++$n > $most || $bad; print {$out} $_ or $bad = 1 }
        unless ($bad) { close $out or $bad = 1 }
        if (open(my $f, ">", $count)) { print {$f} "$n\n" or $bad = 1; close $f or $bad = 1 } else { $bad = 1 }
        exit($bad ? 4 : 0)' -- "$1" "$2" "$STAGE/.found_count" "${3:-}" "${4:-}"
}
# found_count [FALLBACK] - how many records most_of read last, or FALLBACK (0 when not given) when that is not known
found_count() {
    local n
    n=$(cat "$STAGE/.found_count" 2>/dev/null); rm -f "$STAGE/.found_count"
    case "$n" in ''|*[!0123456789]*) n=${1-0} ;; esac
    echo "$n"
}
# found_split STATUS FILE SEP MOST - after most_of MOST SEP FILE ended with STATUS, how what it read went, from FILE and
# from its count: FOUND_IN, the whole records FILE holds (each ended with SEP; one cut off partway is not counted, and
# the loops that read FILE do not read it either); FOUND_PAST, those it read past its first MOST, which it does not
# pass on; FOUND_LOST, those of its first MOST that FILE does not hold, because they could not be written there, or
# empty when how many it read is not known (its count could not be written either). What most_of said it wrote is not
# taken: a write that it saw succeed can still be lost when the file is closed.
found_split() {
    local all
    if [ "$3" = nul ]; then FOUND_IN=$(LC_ALL=C tr -cd '\0' < "$2" 2>/dev/null | wc -c); else FOUND_IN=$(wc -l < "$2" 2>/dev/null); fi
    FOUND_IN=${FOUND_IN//[[:space:]]/}
    case "$FOUND_IN" in ''|*[!0123456789]*) FOUND_IN=0 ;; esac
    all=$(found_count "")
    FOUND_PAST=0; FOUND_LOST=0
    if [ -z "$all" ]; then
        # Without perl, most_of passes everything on and counts nothing
        [ "$1" -eq 0 ] || FOUND_LOST=""
        return 0
    fi
    [ "$all" -gt "$4" ] && { FOUND_PAST=$((all - $4)); all=$4; }
    [ "$all" -gt "$FOUND_IN" ] && FOUND_LOST=$((all - FOUND_IN))
    return 0
}
# found_lost WHAT - says in collection.log which of what WHAT found, as found_split counted it, is not in its list
found_lost() {
    if [ -z "$FOUND_LOST" ]; then
        log_line "  how many entries $1 found is not known: its list could not all be written into the working folder, and neither could how many it found, so what is not in the list was not gone through"
    elif [ "$FOUND_LOST" -gt 0 ]; then
        log_line "  $FOUND_LOST of the entries $1 found could not be written into its list, so they were not gone through"
    fi
    return 0
}
# first_lines N - the first N lines of what it reads, then a line that says how many more there were. It reads to
# the end whatever happens to its writes, so that what writes into it is never stopped by a pipe that closed, and
# ends with status 4 when what it was to write could not all be written.
first_lines() {
    if [ "$HAVE_PERL" -eq 1 ]; then
        plain_perl -e '$SIG{PIPE} = "IGNORE"; my $m = shift; my ($n, $bad) = (0, 0); binmode STDIN; binmode STDOUT;
            while (<STDIN>) { next if ++$n > $m || $bad; print or $bad = 1 }
            if ($n > $m && !$bad) { printf "(%d more are not listed.)\n", $n - $m or $bad = 1 }
            close STDOUT or $bad = 1;
            exit($bad ? 4 : 0)' -- "$1"
        return
    fi
    local rc
    LC_ALL=C awk -v m="$1" 'NR <= m { print; next } END { if (NR > m) printf "(%d more are not listed.)\n", NR - m }'; rc=$?
    cat > /dev/null                 # what awk did not read, when a write ended it
    [ $rc -eq 0 ] || return 4
}
# drained COMMAND... - runs COMMAND, a program that reads what comes in, then reads what it left to the end without
# passing it on, so that what writes into it is never stopped by a pipe that closed: sort, for one, ends at once when it
# cannot write its temporary files. Ends with COMMAND's status.
drained() {
    local rc
    "$@"; rc=$?
    cat > /dev/null
    return $rc
}
in_home() {
    case "$1" in "$USER_HOME"|"$USER_HOME"/*) return 0 ;; esac
    return 1
}
# rights_said - whose rights as_user runs a program with, in words: the console user's as root, and otherwise this
# account's own, which need not be the console user's
rights_said() {
    if [ "$AM_ROOT" -eq 1 ]; then echo "the console user's rights"; else echo "this account's rights"; fi
}
# rd PATH COMMAND ARGUMENT... - run it, as the console user when PATH is in that user's home
rd() {
    local p=$1; shift
    if in_home "$p"; then as_user "$@"; else "$@"; fi
}
# answer_of STATUS WHERE [WHAT] - how a program that rd or as_user ran on WHERE ended. 0 and 1 are the program's own
# answers. 124 and 126 are as_user's: stopped at a time limit, or not run, when nothing more is read with the console
# user's rights (said in the status table). Anything else is no answer (the program killed, say): counted for the
# step's row (UNANSWERED for a program run with the console user's rights, OWN_UNANSWERED for one of this script's)
# and, with WHAT, said in collection.log as "WHAT ended without an answer". Ends with 0, 1 or 2 for those three.
answer_of() {
    case $1 in
        0|1) return 0 ;;
        124|126)
            # a stop at a time limit closes the home folder, in this shell too, even when the mark could not be made
            [ "$1" -eq 124 ] && [ -z "$AS_KEEP_OPEN" ] && [ "$AM_ROOT" -eq 1 ] && in_home "$2" && HOME_SHUT=1
            return 1 ;;
    esac
    if in_home "$2"; then UNANSWERED=$((${UNANSWERED:-0} + 1)); else OWN_UNANSWERED=$((${OWN_UNANSWERED:-0} + 1)); fi
    [ -n "${3:-}" ] && log_line "  $3 ended without an answer (status $1): $2"
    return 2
}
# list_end STATUS WHERE [find] - the line that ends a list, in WHERE, when the program that made it did not get to its
# end. Its own statuses 0 and 1 are answers: see answer_of. With "find", the list was made by find, whose 1 says that
# it met an error on the way (see find_one), and that is said too.
list_end() {
    answer_of "$1" "$2" "a list stops early: the program that made it"
    case $? in
        0) [ "${3:-}" = find ] && find_one "$1" "$2" "a list" \
               && echo "(find ended with status 1 here: it met an error on the way, such as a folder it could not read. What it did not get to is not listed.)" ;;
        1) echo "(The list stops here: nothing is read with the console user's rights at this point of the run; see the status table.)" ;;
        2) echo "(The list stops here: the program that made it ended without an answer, status $1.)" ;;
    esac
    return 0
}
# find_one STATUS WHERE WHAT - after a list, search or count of WHERE that find made (or that ends with find's status):
# find ends with 1 when it met an error on the way (a folder it could not read, an entry that was gone before it was
# looked at, a path too long), and then what it gave leaves out what it did not get to. That is counted for the step's
# row (UNWALKED) and said in collection.log, with WHAT. Succeeds for 1 only.
find_one() {
    [ "$1" = 1 ] || return 1
    UNWALKED=$((${UNWALKED:-0} + 1))
    log_line "  $3 made by find may leave something out: find ended with status 1, which it does when it meets an error on the way (a folder it could not read, say): $2"
    return 0
}
# list_written FIRST-LINES-STATUS SORT-STATUS WHAT - counts a list that could not all be written into the working folder
list_written() {
    [ "${1:-0}" -eq 0 ] && [ "${2:-0}" -eq 0 ] && return 0
    unwritten "$3"
}

# The folders outside any home folder that files are copied from. Root is not always the only one who may write
# there (macOS lets every administrator write to its report folder), so a file is taken from them only when it is
# opened as itself: see FETCH_PL.
SYS_REPORTS=/Library/Logs/DiagnosticReports
SYS_LOGS=(/Library/Logs/Microsoft "/Library/Application Support/Microsoft")
SYS_ROOTS=("$SYS_REPORTS" "${SYS_LOGS[@]}")
PERL_CMD=(/usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO LC_ALL=C /usr/bin/perl)
HAVE_PERL=1; [ -x /usr/bin/perl ] || HAVE_PERL=0
# A name that is left out of every list and every copy, and counted where it is left out. A name with a control
# character in it (a line break, a tab) could pass for a line of its own wherever names are listed. One with an
# invisible character could show as some other name: a line or paragraph separator, a character that sets the
# direction of text (an embedding, override or isolate, and the three direction marks), and the zero-width and other
# characters that draw nothing which shown_path shows as a space. Each pattern is one character, or a set of them,
# as the bytes UTF-8 writes it with, so that what it matches does not depend on a locale: every program here works
# in the C locale, and so do the helpers run with the console user's rights. The same patterns serve as find's tests,
# on the whole path (ODD_PATH) or on the last part of it (ODD_NAME), for the shell's own case (odd_name), and for the
# helpers' own sh, which are given them as arguments.
ODD_GLOBS=('*[[:cntrl:]]*'
    $'*\xc2[\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b\x8c\x8d\x8e\x8f\x90\x91\x92\x93\x94\x95\x96\x97\x98\x99\x9a\x9b\x9c\x9d\x9e\x9f\xad]*'
    $'*\xd8\x9c*' $'*\xe1\xa0\x8e*'
    $'*\xe2\x80[\x8b\x8e\x8f\xa8\xa9\xaa\xab\xac\xad\xae]*'
    $'*\xe2\x81[\xa0\xa1\xa2\xa3\xa4\xa6\xa7\xa8\xa9\xaa\xab\xac\xad\xae\xaf]*'
    $'*\xef\xbb\xbf*' $'*\xef\xbf[\xb9\xba\xbb]*' $'*\xf3\xa0[\x80\x81]*')
#   U+0000-001F and U+007F; U+0080-009F and U+00AD; U+061C; U+180E; U+200B, U+200E, U+200F and U+2028-202E;
#   U+2060-2064 and U+2066-206F; U+FEFF; U+FFF9-FFFB; U+E0000-E007F
ODD_PATH=('('); ODD_NAME=('(')
for g in "${ODD_GLOBS[@]}"; do
    [ ${#ODD_PATH[@]} -gt 1 ] && { ODD_PATH+=(-o); ODD_NAME+=(-o); }
    ODD_PATH+=(-path "$g"); ODD_NAME+=(-name "$g")
done
ODD_PATH+=(')'); ODD_NAME+=(')')
# odd_name NAME - succeeds when NAME holds one of those characters
odd_name() {
    local g
    for g in "${ODD_GLOBS[@]}"; do case $1 in $g) return 0 ;; esac; done
    return 1
}
# Passes on the first N names of a list of names that each end in a NUL byte, and reads the rest without passing
# them on, so that what writes the list is not stopped by a pipe that closed:  N
IFS= read -r -d '' PICK_PL <<'PERL'
$/ = "\0"; my $n = 0; my $most = shift;
while (<STDIN>) { print if ++$n <= $most }
exit 0;
# ---- the end of PICK_PL ----
PERL
program_read "$PICK_PL" PICK_PL
# The programs below are held in single quotes, not in here-documents: bash writes a here-document into a file first.
#
# The rule for text that is written into the bundle as it was found (a path, a line of a report or of a program's
# output), as a perl sub given to perl with the program that uses it (before it or after it: the sub sets nothing
# when it is run): shown_text(BYTES) is BYTES with each control character, each line or paragraph separator and each
# character that clean_note takes out of a note made one space, so that it stays one line and nothing in it reorders
# or hides what follows. Text that is valid UTF-8 is looked at character by character; a byte that is not stays as
# it is. shown_path and shown_lines use it, and so does REPORT_PL.
SHOWN_RULE_PL='sub shown_text {
    my $s = shift; $s = "" unless defined $s;
    my $u = qr/[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}/;
    $s =~ s{((?:$u)+)}{
        my $t = $1; utf8::decode($t);
        $t =~ s/[\x00-\x1f\x7f-\x{9f}\x{2028}\x{2029}]/ /g;
        $t =~ s/[\x{ad}\x{61c}\x{180e}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{206f}\x{feff}\x{fff9}-\x{fffb}\x{e0000}-\x{e007f}]/ /g;
        utf8::encode($t); $t }ge;
    return $s;
}'
#
# Writes a line about each name it reads (each ended with a NUL byte), from lstat, as FORMAT says: %z the size, %m when
# it last changed (in seconds), %Sm that time in local time as TIME-FORMAT gives it, %N the name, %t a tab. A name that
# is gone by then is passed over, as stat passes over it.  FORMAT TIME-FORMAT
LSTAT_PL='use strict; use POSIX ();
my ($fmt, $tf) = @ARGV; local $/ = "\0"; binmode STDIN; binmode STDOUT;
while (my $n = <STDIN>) {
    chomp $n;
    my @st = lstat $n or next;
    my %v = (z => $st[7], m => $st[9], Sm => POSIX::strftime($tf, localtime $st[9]), N => $n, t => "\t");
    (my $line = $fmt) =~ s/%(Sm|[zmNt])/$v{$1}/g;
    print $line, "\n";
}
exit 0;'
# A list made with the console user's rights: find names what it finds, each name ended with a NUL byte, and LSTAT_PL
# writes a line about each. Each program's own end is kept, as in copy_dir's copy: find's 0 and 1 are its answers (1
# when a folder in it cannot be read), and a program that did not end by itself makes the list end as no answer, with
# 125 or the signal's status. (With find -exec stat, a stat that was killed made find end with 1.)
#   LSTAT-PROGRAM FORMAT TIME-FORMAT FIND-ARGUMENT...
LIST_SH='LC_ALL=C; export LC_ALL
pl=$1; fmt=$2; tf=$3; shift 3
exec 3>&1
s=$( { { /usr/bin/find "$@" -print0 2>/dev/null; echo "f$?" >&4; } \
    | { /usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO /usr/bin/perl -e "$pl" -- "$fmt" "$tf"; echo "p$?" >&4; } >&3; } 4>&1 )
f=; p=
for x in $s; do case $x in f*) f=${x#f} ;; p*) p=${x#p} ;; esac; done
for v in "$f" "$p"; do
    case $v in 0|1) ;; 12[789]|1[3456789][0123456789]|2[012345][0123456789]) exit "$v" ;; *) exit 125 ;; esac
done
[ "$p" = 0 ] || exit 125
exit "$f"'
# user_list WHERE FORMAT TIME-FORMAT FIND-ARGUMENT... - a line about each path find names (see LIST_SH), made with the
# console user's rights when WHERE is in that user's home. Ends with find's status, or as no answer (see answer_of).
user_list() {
    local w=$1; shift
    rd "$w" /bin/sh -c "$LIST_SH" sh "$LSTAT_PL" "$@"
}
# Passes on each name it reads (each ended with a NUL byte) whose file holds TEXT. That is asked of FETCH_PL, run as a
# program of its own for each name and given FOLDER, as fetch runs it. Reads to the end, and ends with 2 when one of
# those programs did not end by itself, 0 otherwise.  FOLDER TEXT FETCH-PROGRAM
NAMES_PL='use strict; use POSIX ();
my ($folder, $text, $fetch) = @ARGV; local $/ = "\0"; binmode STDIN; binmode STDOUT; my $lost = 0;
while (my $n = <STDIN>) {
    chomp $n;
    my $pid = fork();
    unless (defined $pid) { $lost = 1; next }
    unless ($pid) {
        exec "/usr/bin/env", "-u", "PERL5OPT", "-u", "PERL_UNICODE", "-u", "PERL5LIB", "-u", "PERLLIB", "-u", "PERLIO", "LC_ALL=C",
            "/usr/bin/perl", "-e", $fetch, "--", $n, $folder, 0, $text;
        POSIX::_exit(127);
    }
    waitpid $pid, 0;
    if ($? == 0) { print $n, "\0" }
    elsif (($? & 127) || ($? >> 8) >= 125) { $lost = 1 }
}
exit($lost ? 2 : 0);'
# Which reports of a report folder are copied. The rule is held once, in the variables below, and both the search
# (REPORTS_SH, given its tests by report_tests) and the words for it in collection.log and source_catalog.tsv
# (reports_rule) are made from them: every plain file changed after the start of SINCE, and of those changed after
# REPORT_FROM (REPORT_DAYS days before the reports are first looked for), also each whose name matches one of
# REPORT_NAMES, in any case, and each other whose text holds EXCEL_PROC. A name that starts with a dot is passed over,
# and one with a control or invisible character is left out and counted.
REPORT_NAMES=('*excel*' '*office*' '*microsoft*' 'jetsam*' 'WindowServer*' '*.hang' '*.spin' '*.panic')
REPORT_FROM=""
# reports_rule - sets REPORT_FROM, once, and REPORTS_RULE, the rule in words
reports_rule() {
    local p names=""
    [ -n "$REPORT_FROM" ] || REPORT_FROM=$(date -v-"$REPORT_DAYS"d '+%Y-%m-%d %H:%M:%S')
    for p in "${REPORT_NAMES[@]}"; do names="${names:+$names, }$p"; done
    REPORTS_RULE="each plain file changed after $SINCE 00:00:00, and of those changed after $REPORT_FROM ($REPORT_DAYS day(s) before the reports were first looked for; times are local), also each whose name matches one of $names (in any case) and each other whose text holds \"$EXCEL_PROC\"; a name that starts with a dot is passed over, and one with a control or invisible character is left out and counted"
}
# report_tests - TAKEN and TESTED: find's tests for the reports taken for their date or their name, and for the others
# of the last REPORT_DAYS days, whose text is looked at (see NAMES_PL)
report_tests() {
    local p named=('(')
    reports_rule
    for p in "${REPORT_NAMES[@]}"; do [ ${#named[@]} -gt 1 ] && named+=(-o); named+=(-iname "$p"); done
    named+=(')')
    TAKEN=('(' -newermt "$SINCE 00:00:00" -o -newermt "$REPORT_FROM" "${named[@]}" ')' '!' "${ODD_NAME[@]}")
    TESTED=('!' -newermt "$SINCE 00:00:00" -newermt "$REPORT_FROM" '!' "${named[@]}" '!' "${ODD_NAME[@]}")
}
# The reports of one folder to copy, each name ended with a NUL byte: what find names with the first N tests (TAKEN),
# and of what it names with the rest (TESTED), each whose text holds TEXT (see NAMES_PL; with find -exec, a test that
# was killed would have been taken as no). Each find is given its own tests in a subshell of its own, which keeps only
# those of the arguments. Each program's own end is kept, as in LIST_SH.
#   FOLDER FOLDER-FOR-FETCH TEXT NAMES-PROGRAM FETCH-PROGRAM N TAKEN... TESTED...
REPORTS_SH='LC_ALL=C; export LC_ALL
dir=$1; folder=$2; text=$3; names=$4; fetch=$5; n=$6; shift 6
exec 3>&1
s=$( { { ( i=0; for a do i=$((i + 1)); [ "$i" -le "$n" ] && set -- "$@" "$a"; done; shift "$i"
           exec /usr/bin/find "$dir" -maxdepth 1 -type f ! -name ".*" "$@" -print0 ) 2>/dev/null; echo "a$?" >&4; } >&3
       { ( i=0; for a do i=$((i + 1)); [ "$i" -gt "$n" ] && set -- "$@" "$a"; done; shift "$i"
           exec /usr/bin/find "$dir" -maxdepth 1 -type f ! -name ".*" "$@" -print0 ) 2>/dev/null; echo "b$?" >&4; } \
           | { /usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO /usr/bin/perl -e "$names" -- "$folder" "$text" "$fetch"; echo "p$?" >&4; } >&3; } 4>&1 )
a=; b=; p=
for x in $s; do case $x in a*) a=${x#a} ;; b*) b=${x#b} ;; p*) p=${x#p} ;; esac; done
for v in "$a" "$b" "$p"; do
    case $v in 0|1) ;; 12[789]|1[3456789][0123456789]|2[012345][0123456789]) exit "$v" ;; *) exit 125 ;; esac
done
[ "$p" = 0 ] || exit 125
[ "$a" = 0 ] && [ "$b" = 0 ] || exit 1
exit 0'
# For copy_dir's count: how many names it reads (each ended with a NUL byte), as nCOUNT
NUL_COUNT_PL='binmode STDIN; local $/ = "\0"; my $n = 0; $n++ while <STDIN>; print "n$n\n"; exit 0;'
# For copy_dir's count: how many of the folders it is given (each name ended with a NUL byte) cannot be read, that is
# cannot be opened, or have an entry that cannot be looked at; as nCOUNT. Each folder is counted once, whatever its
# name holds.
SHUT_PL='use strict; binmode STDIN; local $/ = "\0"; my $n = 0;
while (my $d = <STDIN>) {
    chomp $d;
    my $h;
    unless (opendir $h, $d) { $n++; next }
    for my $e (readdir $h) {
        next if $e eq "." || $e eq ".." || lstat "$d/$e";
        if ($!{EACCES} || $!{EPERM}) { $n++; last }
    }
    closedir $h;
}
print "n$n\n"; exit 0;'
# Passes on at most MOST bytes of what it reads, and reads the rest without passing it on:  MOST
# Status: 0 = all passed on; 3 = cut at MOST; 4 = what it was to pass on could not all be written.
IFS= read -r -d '' STREAM_PL <<'PERL'
use strict;
$SIG{PIPE} = 'IGNORE';
my $most = shift; my ($sent, $cut, $broken, $buf, $n) = (0, 0, 0);
binmode STDIN; binmode STDOUT;
while ($n = sysread(STDIN, $buf, 1 << 20)) {
    next if $cut || $broken;
    if ($sent + $n > $most) { $n = $most - $sent; $cut = 1; }
    my $o = 0;
    while ($o < $n) { my $w = syswrite(STDOUT, $buf, $n - $o, $o); unless (defined $w) { $broken = 1; last; } $o += $w; }
    $sent += $o;
}
exit($broken ? 4 : $cut ? 3 : 0);
# ---- the end of STREAM_PL ----
PERL
program_read "$STREAM_PL" STREAM_PL
# capped MOST [LINE] - passes on at most MOST bytes of what it reads (STREAM_PL), and reads the rest without passing
# it on, so that what writes into it is never stopped by a pipe that closed. Every stream whose size the console user
# can set goes through it before it reaches the working folder. With LINE, what it passed on is ended, when it was
# cut, by LINE on a line of its own, which says where it was cut. Ends with 3 when it cut what it read, with 4 when
# what it was to pass on could not all be written, with 0 otherwise, and, when its own program ended some other way
# (killed, or not found), with that program's status: 4 is only ever a write that failed. Without perl, awk passes on
# whole lines while they fit (in the C locale it counts bytes); a write of its that fails ends it with SIGPIPE's
# status, or with 2 when SIGPIPE is ignored.
capped() {
    local rc
    if [ "$HAVE_PERL" -eq 1 ]; then
        plain_perl -e "$STREAM_PL" -- "$1"; rc=$?
    else
        LC_ALL=C awk -v m="$1" '{ n += length($0) + 1; if (n > m) { cut = 1; next } print } END { exit cut ? 3 : 0 }'; rc=$?
        cat > /dev/null
        case $rc in 2|141) rc=4 ;; esac
    fi
    [ $rc -eq 3 ] && [ -n "${2:-}" ] && { printf '\n%s\n' "$2" 2>/dev/null || { echo > /dev/null; rc=4; }; }
    return $rc
}
IFS= read -r -d '' LIMIT_PL <<'PERL'
# Runs a program for no longer than it is given, as AS_USER_PL does, but with this script's own rights:
#   GROUPS SECONDS COMMAND ARGUMENT...          (SECONDS 0: no limit; GROUPS empty: nothing is written down)
# The program gets a process group of its own, which is written down as a file named after it in the folder GROUPS
# (in the working folder) while it runs: the interrupt handling of the script stops every group written down there
# (stop_groups), also one whose runner could not stop it itself. When the time is up, the group is told to stop
# (TERM) and is killed 5 seconds later; so it is when this program is told to stop. When the program has ended, what
# is left in its group is killed. Each wait for the program to end, after TERM and after KILL, lasts 5 seconds at
# most: one held in the kernel (by a volume that no longer answers, say) is left, and this program ends all the
# same. Whatever reads what that program writes then waits for it, so a caller who must not wait has it write into a
# file. The program's descriptors from 3 up are closed: the screen, which the script keeps on two spare ones, is not
# the program's to hold open.
# Status: the program's own; 124 when it was stopped at its time limit; 126 when it could not be started; 127 when
# it was not found; 128 and the signal's number when it, or this program, was stopped by a signal.
use strict; use POSIX (); use Time::HiRes ();
my ($groups, $limit, @cmd) = @ARGV;
exit 126 unless @cmd && defined $limit && $limit =~ /^\d+$/;
my $pid = fork();
exit 126 unless defined $pid;
if (!$pid) {
    setpgrp(0, 0);
    POSIX::close($_) for 3 .. 255;
    exec { $cmd[0] } @cmd;
    POSIX::_exit(127);
}
POSIX::setpgid($pid, $pid);
my $mark;
if (defined $groups && length $groups) {
    mkdir $groups, 0700;
    $mark = "$groups/$pid";
    if (open my $m, '>', $mark) { close $m } else { undef $mark }
}
my ($status, $reaped) = (0, 0);
# reap(SECONDS): waits that long at most for the program to end, without blocking
my $reap = sub {
    my $until = Time::HiRes::time() + $_[0];
    while (!$reaped) {
        my $r = waitpid($pid, POSIX::WNOHANG());
        if ($r == $pid) { ($status, $reaped) = ($?, 1); last }
        if ($r < 0) { $reaped = 1; last }
        last if Time::HiRes::time() >= $until;
        Time::HiRes::sleep(0.05);
    }
    return $reaped;
};
# Kills what is left in the group, again until nothing is: a second at most. The mark goes once the group has.
my $done = sub {
    for (1 .. 40) { last unless kill 0, -$pid; kill 'KILL', -$pid; Time::HiRes::sleep(0.025); }
    unlink $mark if $mark && !kill(0, -$pid);
    exit $_[0];
};
my $stop = sub {
    my $code = shift;
    $SIG{$_} = 'IGNORE' for qw(ALRM INT TERM HUP QUIT);
    kill 'TERM', -$pid;
    $reap->(5) or do { kill 'KILL', -$pid; $reap->(5) };
    $done->($code);
};
$SIG{ALRM} = sub { $stop->(124) };
# An interrupt stops the program too, unless whoever started this one had it ignored (the packaging at the end):
# the program is in a group of its own, which the terminal does not reach
my %code = (INT => 130, TERM => 143, HUP => 129, QUIT => 131);
for my $s (keys %code) { $SIG{$s} = sub { $stop->($code{$s}) } unless ($SIG{$s} || '') eq 'IGNORE'; }
alarm $limit if $limit > 0;
while (!$reaped) {
    my $r = waitpid($pid, 0);
    if ($r == $pid) { ($status, $reaped) = ($?, 1) }
    elsif ($r < 0 && !$!{EINTR}) { ($status, $reaped) = (126 << 8, 1) }
}
alarm 0;
$done->(($status & 127) ? 128 + ($status & 127) : $status >> 8);
# ---- the end of LIMIT_PL ----
PERL
program_read "$LIMIT_PL" LIMIT_PL
# run_limited SECONDS COMMAND... - run COMMAND, a program, with LIMIT_PL: stopped after SECONDS (0 = no limit), in a
# process group of its own that the interrupt handling stops too. Ends with COMMAND's status, or 124 when it was
# stopped at the limit. A shell function cannot be handed to another program: it is run in a subshell of this shell,
# which a watcher stops (workbook_facts does that when the script is not root). So is a program when perl is missing.
run_limited() {
    local secs=$1 start=$SECONDS; shift
    if [ "${HAVE_PERL:-1}" -eq 1 ] && ! declare -F "$1" > /dev/null; then
        plain_perl -e "$LIMIT_PL" -- "${STAGE:+$STAGE/.groups}" "$secs" "$@"
        return
    fi
    if [ "$secs" -eq 0 ]; then "$@"; return; fi     # 0 = no limit
    "$@" &
    local pid=$!
    # Detached from stdout so a pipe reading CMD's output closes as soon as CMD ends
    ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 5; kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    local watcher=$!
    wait "$pid"
    local rc=$?
    # The watcher is usually still in its 5-second grace sleep after a timeout, so judge by elapsed time
    if [ $((SECONDS - start)) -ge "$secs" ] && { [ $rc -eq 143 ] || [ $rc -eq 137 ]; }; then
        rc=124
    fi
    pkill -P "$watcher" 2>/dev/null
    kill "$watcher" 2>/dev/null
    wait "$watcher" 2>/dev/null
    return $rc
}
# stop_groups - kills every process group that LIMIT_PL has written down and not taken away: a program started for a
# step that was cut off must not go on past the packaging, holding the screen open or writing into the bundle
stop_groups() {
    local g
    [ -n "$STAGE" ] && [ -d "$STAGE/.groups" ] || return 0
    for g in "$STAGE/.groups"/*; do
        g=${g##*/}
        case "$g" in ''|*[!0123456789]*) continue ;; esac
        same_group "$g" "$STAGE/.groups/$g" && kill -KILL -- "-$g" 2>/dev/null
        rm -f "$STAGE/.groups/$g"
    done
    return 0
}
# same_group GROUP MARK - whether GROUP is still the group the runner wrote MARK for. A mark stays only when a program
# of its group outlived the runner, and once the last of them has ended, another group can be given the same number:
# so a group counts as the same only while one of its programs started no later than the mark was made (every
# program of a group that took the number afterwards started later). The times are whole seconds, so a second is
# allowed for. Without perl, the group counts as the same (then this script is not root, and kills only its own).
same_group() {
    [ "$HAVE_PERL" -eq 1 ] || return 0
    /bin/ps -axo pgid=,etime= 2>/dev/null | plain_perl -e '
        my ($g, $mark) = @ARGV;
        my $made = (stat $mark)[9]; exit 1 unless defined $made;
        my $now = time;
        while (<STDIN>) {
            my ($pg, $et) = split;
            next unless defined $et && $pg eq $g;
            my ($d, $h, $m, $s) = $et =~ /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/ or next;
            my $start = $now - ((($d // 0) * 24 + ($h // 0)) * 60 + $m) * 60 - $s;
            exit 0 if $start <= $made + 1;
        }
        exit 1' -- "$1" "$2"
}
IFS= read -r -d '' FETCH_PL <<'PERL'
# Prints one plain file, and on the error stream the time it was last changed:  PATH FOLDER MOST-BYTES [TEXT]
# A file longer than MOST-BYTES is not printed (0 = any length): a file can claim any length without holding it,
# and every byte of that length would be written out. With TEXT nothing is printed: the status says whether the
# file holds TEXT.
# The file is opened once, without following a link in the last part of its path and without waiting (a pipe would
# wait for a writer that never comes), and everything is then asked of the open file, so nothing can be exchanged
# between the look and the read. With FOLDER the open file must also lie in that folder by the name the system
# itself has for it, and have no second name: a link in the middle of the path, or a second name given to some
# other file, would otherwise bring in a file that whoever planted it may not read.
# Status: 0 = printed (or TEXT found); 1 = not there (no such file, or a part of its path is no folder), or TEXT not
# found; 3 = not in FOLDER as itself; 4 = it could not be opened or not all read, for another reason; 5 = longer than
# MOST-BYTES; 6 = what was read could not all be written; 7 = not a plain file (a link, a folder, a pipe or a device);
# 8 = opening it was refused.
use strict; use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK F_GETFL F_SETFL S_ISREG); use Errno ();
my ($path, $folder, $most, $text) = @ARGV;
exit 2 unless defined $path && length $path && defined $most && $most =~ /^\d+$/;
# ELOOP, with O_NOFOLLOW: the name is a link
sysopen(my $h, $path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    or exit($!{ENOENT} || $!{ENOTDIR} ? 1 : $!{ELOOP} ? 7 : $!{EACCES} || $!{EPERM} ? 8 : 4);
my @st = stat($h) or exit 4;
exit 7 unless S_ISREG($st[2]);
if (defined $folder && length $folder) {
    my $name = sub { my $p = "\0" x 1024; fcntl($_[0], 50, $p) or return undef; $p =~ s/\0.*//s; $p };     # 50 is F_GETPATH
    exit 3 unless $st[3] == 1;
    sysopen(my $d, $folder, O_RDONLY | O_NOFOLLOW) or exit 3;
    my ($in, $me) = ($name->($d), $name->($h));
    exit 3 unless defined $in && defined $me && length $in && index($me, "$in/") == 0;
}
my $flags = fcntl($h, F_GETFL, 0);
fcntl($h, F_SETFL, $flags & ~O_NONBLOCK) if $flags;
binmode $h; binmode STDOUT;
my ($buf, $n);
if (defined $text) {
    my ($seen, $tail) = (0, '');
    while ($seen < (64 << 20) && ($n = sysread($h, $buf, 1 << 20))) {
        exit 0 if index($tail . $buf, $text) >= 0;
        $tail = length($buf) > length($text) ? substr($buf, -length($text)) : $buf; $seen += $n;
    }
    exit 1;
}
exit 5 if $most > 0 && $st[7] > $most;
print STDERR "$st[9]\n";
my $sent = 0;
while ($n = sysread($h, $buf, 1 << 20)) {
    $sent += $n;
    exit 5 if $most > 0 && $sent > $most;           # it grew while it was read
    my $o = 0;
    while ($o < $n) { my $w = syswrite(STDOUT, $buf, $n - $o, $o); exit 6 unless defined $w; $o += $w; }
}
exit(defined $n ? 0 : 4);
# ---- the end of FETCH_PL ----
PERL
program_read "$FETCH_PL" FETCH_PL
# fetch PATH MOST-BYTES [TEXT] - print one plain file of at most so many bytes (0 = any length), or with TEXT
# succeed when it holds TEXT. A file in the console user's home is read with that user's rights. One outside it is
# read by root only from the folders in SYS_ROOTS, and only when it lies there as itself. Its statuses are FETCH_PL's,
# and as_user's when the console user's rights were used; read the plain way (no perl, not root), 9 is a read or a
# write that failed (cat does not say which).
fetch() {
    local p=$1 most=$2 r folder=""
    if [ "$HAVE_PERL" -eq 0 ] && [ "$AM_ROOT" -eq 0 ]; then         # no perl, and no rights to guard: the plain way
        [ -e "$p" ] || [ -L "$p" ] || return 1
        [ -f "$p" ] && [ ! -L "$p" ] || return 7
        [ -r "$p" ] || return 8
        if [ $# -gt 2 ]; then /usr/bin/grep -q -a -F -e "$3" -- "$p"; return; fi
        [ "$most" -eq 0 ] || [ "$(/usr/bin/stat -f '%z' "$p" 2>/dev/null || echo 0)" -le "$most" ] || return 5
        /usr/bin/stat -f '%m' "$p" >&2
        /bin/cat -- "$p" || return 9          # cat says nothing of whether the read or the write failed
        return
    fi
    if in_home "$p"; then AS_PATH=$p as_user "${PERL_CMD[@]}" -e "$FETCH_PL" -- "$p" "" "${@:2}"; return; fi
    if [ "$AM_ROOT" -eq 1 ]; then
        for r in "${SYS_ROOTS[@]}"; do
            case "$p" in "$r"/*) folder=$r; break ;; esac
        done
        [ -n "$folder" ] || return 3
    fi
    "${PERL_CMD[@]}" -e "$FETCH_PL" -- "$p" "$folder" "${@:2}"
}
XL="$USER_HOME/Library/Containers/com.microsoft.Excel/Data"
OFFICE_GC="$USER_HOME/Library/Group Containers/UBF8T346G9.Office"

# Microsoft log locations copied in full: source|path in the bundle. In repro, the final snapshot
# already holds Excel's own and the shared Office logs, so they point there instead.
EXCEL_LOGS_DEST=office/excel_container_logs
OFFICE_LOGS_DEST=office/office_group_logs
if [ "$MODE" = repro ]; then
    EXCEL_LOGS_DEST=repro/final/excel_container_logs
    OFFICE_LOGS_DEST=repro/final/office_group_logs
fi
FIXED_SOURCES=(
    "$XL/Library/Logs|$EXCEL_LOGS_DEST"
    "$OFFICE_GC/Logs|$OFFICE_LOGS_DEST"
    "$USER_HOME/Library/Logs/Microsoft|office/user_microsoft_logs"
    "$USER_HOME/Library/Containers/com.microsoft.OneDrive-mac/Data/Library/Logs|office/onedrive_container_logs"
    "$USER_HOME/Library/Containers/com.microsoft.errorreporting/Data/Library/Logs|office/error_reporting_logs"
    "${SYS_LOGS[0]}/autoupdate.log|office/autoupdate.log"
)

# The bundle is built in a folder that only this script can write to, under a name nobody can know beforehand.
# The Desktop belongs to the console user: built there, a folder or a link put in the way under the name to come
# would have root write, and change the owner of, files of that user's choosing. The finished results are moved
# to where they are wanted at the very end (see deliver). The working folder is under /private/var/tmp, which a
# restart does not empty: a run that the Mac going down cuts off leaves what it had collected there.
STAMP=$(date '+%Y%m%d_%H%M%S')
NAME="Excel_Diagnostics_${MODE}_$STAMP"
DEST="${OUTDIR:-${EXCEL_DIAG_OUTDIR:-$USER_HOME/Desktop}}"
case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac      # taken from the folder the script was started in
while [ "$DEST" != / ] && [ "${DEST%/}" != "$DEST" ]; do DEST=${DEST%/}; done
STAGE_BASE=/private/var/tmp
STAGE=$(/usr/bin/mktemp -d "$STAGE_BASE/excel_diag.XXXXXXXXXX") || { echo "Could not make a working folder in $STAGE_BASE." >&2; exit 1; }
OUT="$STAGE/$NAME"
mkdir "$OUT" || { echo "Could not make a working folder in $STAGE." >&2; exit 1; }
# The temporary files of the programs this script runs (sort's, when what it sorts is long) go into a folder of the
# working folder's, beside the bundle and never in it. Where they would go otherwise, /var/tmp, anyone can write, and
# sort writes through a link put at the name it is about to use. The helpers run with the console user's rights are
# not given it (see AS_USER_PL).
mkdir -m 0700 "$STAGE/.tmp" || { echo "Could not make a working folder in $STAGE." >&2; exit 1; }
TMPDIR="$STAGE/.tmp"; export TMPDIR
echo $$ > "$STAGE/.pid"                                  # tells a later run that this one is still going
COPY_LOST=0; COPY_ODD=0; COPY_BIG=0; COPY_SHUT=0; COPY_LONG=0; LIST_ODD=0     # what the copies and lists left out, for the status table
step_begin          # the counts of the step running now (see row)
ROWS_LOST=0         # rows of the status table that could not be written (see record_status)
WRITES_LOST=0       # times something could not all be written into the working folder (see unwritten)
# This run's own state, set as it goes: never taken from the environment the script was started with
unset IN_TRAP FINALIZED FINAL_STATUS COPY_BUDGET REDACT_STATE REDACT_EXCEPT WATCH_LIVE WATCH_END WATCH_W0 WATCH_R0 REPRO_FINISHED REPRO_LOG_PID \
    REPRO_WATCH_PID REPRO_STREAM_SAID REPRO_STREAM_STARTED REPRO_WATCH_STARTED REPRO_BEFORE REPRO_SEEN REPRO_ENDED_FIRST REPRO_SENT REPRO_SAID \
    REPRO_STREAM_DONE REPRO_WATCH_END REPRO_OWN_GROUP REPRO_WHY REPRO_ROW_DONE UNIFIED_DAY_NOW HANG_SEARCH_NOW
LOG="$OUT/collection.log"
MANIFEST="$OUT/manifest.tsv"
printf 'component\tstatus\tdetails\n' 2>/dev/null > "$MANIFEST" || { echo > /dev/null; ROWS_LOST=$((ROWS_LOST + 1)); }

# Everything Excel and its bundled helpers log; any process's message that names Excel (launchd exit
# reasons, sandbox and privacy denials, RunningBoard, WindowServer, file providers); what the processes whose
# program file is named like Microsoft's crash reporting and update programs log; spindump's entries; why the Mac
# last shut down, as the kernel logs it at each startup; the kernel's memory messages, and the jetsam messages of
# ReportCrash and osanalyticshelper; and any process failing a write because the disk is full. The kernel is taken
# only as process ID 0, whose program is /kernel, and spindump, ReportCrash and osanalyticshelper only by their
# program files' full paths: any process can be named like them and log the same words. RunningBoard's
# whole-system state dumps are left out: they name every running app and were a third of a day's output.
PRED_ALL='process == "'"$EXCEL_PROC"'"
 OR processImagePath CONTAINS "/'"$EXCEL_PROC"'.app/"
 OR (eventMessage CONTAINS[c] "'"$EXCEL_NAME"'" AND NOT (process == "runningboardd" AND eventType == stateEvent))
 OR process IN {"Microsoft Error Reporting", "Microsoft AutoUpdate", "Microsoft Update Assistant"}
 OR processImagePath == "/usr/sbin/spindump"
 OR ((processImagePath == "/kernel" OR processIdentifier == 0) AND eventMessage CONTAINS[c] "previous shutdown cause")
 OR eventMessage CONTAINS[c] "No space left on device"
 OR ((processImagePath == "/System/Library/CoreServices/ReportCrash" OR processImagePath == "/System/Library/CoreServices/osanalyticshelper") AND eventMessage CONTAINS[c] "jetsam")
 OR ((processImagePath == "/kernel" OR processIdentifier == 0) AND (eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "compressor" OR eventMessage CONTAINS[c] "swap"))'

# Unified-log entries are written one per row, tab-separated, with these columns. tags says why an
# entry is relevant, mirroring PRED_ALL; line breaks and tabs inside a message appear as \n and \t.
#
# Two tags describe what a message says instead of who logged it. permissions: sandbox and privacy (TCC)
# refusals, missing entitlements, "not permitted", "denied". storage: a full disk, an exceeded quota, I/O
# errors, a read-only volume. Both look for refusals and failures, not the bare words, which are mostly
# noise ("storage" is cookie stores and telemetry names). The viewer applies the same two patterns to
# every log in a bundle, so keep them in step with CONTENT_TAGS in src/core.js.
TAG_PERMISSIONS_RX='kTCCService|\bdeny\(|denied\b|\bforbidden\b|not permitted|not authori[sz]ed|unauthori[sz]ed|(unsatisfied|missing|requires|have|without) entitlement|\bEPERM\b|\bEACCES\b|NSCocoaErrorDomain Code=(257|513)\b'
TAG_STORAGE_RX='no space left|\bENOSPC\b|(disk|volume|device) (is |was )?(almost |nearly )?full|\b(out of|low on|not enough|insufficient|low) (disk |free |storage )?space|quota exceeded|input/output error|\bI/O error|read-only file ?system|NSCocoaErrorDomain Code=(640|642)\b|NSPOSIXErrorDomain Code=(5|28|30|69)\b|0x800[37]0070\b'
LABEL_HEADER=$'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage'
# jq compiles a regex every time it is used, which tripled labeling time when both patterns ran on every
# entry. A plain substring check picks the few entries worth testing first, so every alternative in the
# patterns above needs a (lowercase) piece in the matching list below.
LABEL_JQ='def basename: split("/") | last;
def has_any($pieces): . as $s | any($pieces[]; . as $w | $s | contains($w));
def utc: (capture("^(?<t>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})(?<f>[.][0-9]+)?(?<s>[+-])(?<h>[0-9]{2})(?<m>[0-9]{2})$")
    | ((.t | strptime("%Y-%m-%d %H:%M:%S") | mktime) - (if .s == "-" then -1 else 1 end) * ((.h | tonumber) * 3600 + (.m | tonumber) * 60))
        as $e | ($e | strftime("%Y-%m-%d %H:%M:%S")) + (.f // "")) // "";
fromjson? | select(type == "object" and has("timestamp"))    # log show ends with a {"count":...} summary
| (.processImagePath // "" | basename) as $p
| (.eventMessage // "") as $m
| ($m | ascii_downcase) as $l
| [ if $p == $proc then "excel" else empty end,
    if $p != $proc and (.processImagePath // "" | contains("/" + $proc + ".app/")) then "excel-helper" else empty end,
    if $p == "Microsoft Error Reporting" or $p == "Microsoft AutoUpdate" or $p == "Microsoft Update Assistant" then "microsoft" else empty end,
    if .processImagePath == "/usr/sbin/spindump" then "hang-report" else empty end,
    if $p != $proc and ($l | contains($name | ascii_downcase)) then "mentions-excel" else empty end,
    if ((.processImagePath == "/kernel" or .processID == 0) and ($m | test("memorystatus|jetsam|compressor|swap"; "i")))
       or ((.processImagePath == "/System/Library/CoreServices/ReportCrash" or .processImagePath == "/System/Library/CoreServices/osanalyticshelper")
           and ($m | test("jetsam"; "i"))) then "memory" else empty end,
    if (.processImagePath == "/kernel" or .processID == 0) and ($l | contains("previous shutdown cause")) then "restart" else empty end,
    if $p == "tccd" or .subsystem == "com.apple.TCC"
       or (($l | has_any(["ktccservice", "deny(", "denied", "forbidden", "permitted", "authori", "entitlement", "eperm", "eacces", "errordomain code="]))
           and ($m | test($perm; "i"))) then "permissions" else empty end,
    if ($l | has_any(["space", "enospc", " full", "quota exceeded", "output error", "i/o error", "read-only file", "errordomain code=", "0070"]))
       and ($m | test($stor; "i")) then "storage" else empty end,
    if .eventType == "lossEvent" then "logs-dropped" else empty end
  ] as $tags
| [ .timestamp // "", (.timestamp // "" | utc), .messageType // .eventType // "", $p, (.processID // "" | tostring),
    (.senderImagePath // "" | basename), .subsystem // "", .category // "", ($tags | join(",")), $m ]
| @tsv'
JQ=$(command -v jq)                        # built into macOS 15 and later
LOG_EXT=tsv
[ -n "$JQ" ] || LOG_EXT=ndjson             # without jq, keep log's own JSON lines (same fields, unlabeled)

note() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
say() { echo "[$(date '+%H:%M:%S')] $*"; }  # to the screen only, not collection.log
# A row that cannot be written (a full disk) is counted in this shell, and the last lines of the run say how many
# there were: the table cannot say it of itself. bash would keep what it could not write and write it out with
# whatever this shell writes next, so that is dropped.
record_status() {
    printf '%s\t%s\t%s\n' "$1" "$2" "${3//$'\t'/ }" 2>/dev/null >> "$MANIFEST" && return 0
    echo > /dev/null
    ROWS_LOST=$((${ROWS_LOST:-0} + 1))
    return 1
}
# As root, make sure the console user's rights can be taken on before anything depends on it: a helper run with them
# must answer with that user's account id. If they cannot be taken on, nothing in that user's home is read at all
# (USER_READS): reading it as root is the thing to avoid. An account that cannot be looked up (no user id) counts the
# same. A helper that gives no answer (stopped at its time limit, or ended by a signal: it runs as that user, who can
# stop it) says nothing about the rights; nothing more is run with them then either (HOME_SHUT), and that is said as
# what it was. The helper has a short time limit of its own: id answers at once, and the working folder has not been
# named on the screen yet.
rights_check() {
    local got rc lim=10
    [ "$AM_ROOT" -eq 1 ] && [ "$USER_UID" != 0 ] || return 0
    case "$USER_UID" in
        ''|*[!0123456789]*)
            USER_READS=0
            note "Could not take on the rights of $CONSOLE_USER: no account id was found for that name, so nothing in that user's home folder is read."
            record_status "user_files" "skipped" "could not act as the console user: no account id was found for that name; nothing in the home folder was read"
            return 0 ;;
    esac
    got=$(AS_LIMIT=$lim AS_KEEP_OPEN="" AS_WHAT="the check that a helper runs with the console user's rights" as_user /usr/bin/id -u 2>/dev/null); rc=$?
    [ $rc -eq 0 ] && [ "$got" = "$USER_UID" ] && return 0
    case $rc in
        0|126)
            USER_READS=0
            if [ $rc -eq 0 ]; then note "Could not take on the rights of $CONSOLE_USER: a helper run with them did not answer with that user's account id, so nothing in that user's home folder is read."
            else note "Could not take on the rights of $CONSOLE_USER: the program that runs helpers with them did not run one (status 126), so nothing in that user's home folder is read."; fi
            record_status "user_files" "skipped" "could not act as the console user; nothing in the home folder was read" ;;
        *)
            HOME_SHUT=1
            if [ $rc -eq 124 ]; then note "The helper that checks the rights of $CONSOLE_USER, run with them, was stopped at its $lim-second time limit without an answer, so nothing in that user's home folder is read."
            else note "The helper that checks the rights of $CONSOLE_USER, run with them, ended with status $rc without an answer, so nothing in that user's home folder is read."; fi
            record_status "user_files" "skipped" "the helper that checks the console user's rights, run with them, ended without an answer (status $rc); nothing in the home folder was read" ;;
    esac
    return 0
}
rights_check
# Says which working folders earlier runs left behind, because nothing else would ever mention them: a run that
# was cut off, or one whose results could not be moved (that folder is the console user's by then). Only a plain
# folder under a name this script makes, owned by whoever runs this or by the console user. One whose run is
# still going is passed over: its .pid names a process that is there and that started after the Mac did.
earlier_runs() {
    local me boot owner when f who pid made held shown=0 over=0 total users st
    me=$(id -u)
    boot=$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*{ sec = \([0-9][0-9]*\).*/\1/p')
    users=(-user "$me")
    [ "$AM_ROOT" -eq 1 ] && [ -n "$USER_UID" ] && users=('(' -user "$me" -o -user "$USER_UID" ')')
    # One find and one stat for the lot, written into the working folder first, and only the first 50 are looked at:
    # anyone can make folders there, as many as they like, and this runs before anything is collected. The look has
    # a time limit (see run_limited): a folder there can be where a volume that no longer answers is mounted. Its
    # list goes into a file, not a pipe, so that nothing waits on a find that the kernel holds past its limit.
    run_limited 30 /usr/bin/find "$STAGE_BASE" -mindepth 1 -maxdepth 1 -type d -name 'excel_diag.*' ! -name 'excel_diag.*[!A-Za-z0-9]*' \
        "${users[@]}" -exec /usr/bin/stat -f '%u%t%Sm%t%N' -t '%Y-%m-%d %H:%M' {} + 2>/dev/null > "$STAGE/.earlier_all"
    st=$?
    most_of 50 line "$STAGE/.earlier" < "$STAGE/.earlier_all"
    rm -f "$STAGE/.earlier_all"
    total=$(found_count 0)
    while IFS=$'\t' read -r owner when f; do
        [ -n "$f" ] && [ "$f" != "$STAGE" ] || continue
        held=""
        if [ "$owner" = "$me" ]; then
            who="this account"
            [ "$owner" = 0 ] && who=root
            # Whether its run is still going is asked only of a folder of whoever runs this: nobody else can have
            # put the .pid there. It is read only when it is a plain file of a few bytes.
            pid=""; made=0
            if [ -f "$f/.pid" ] && [ ! -L "$f/.pid" ] && [ "$(/usr/bin/stat -f '%z' "$f/.pid" 2>/dev/null || echo 99)" -le 20 ]; then
                IFS= read -r -n 20 pid < "$f/.pid" 2>/dev/null
                made=$(/usr/bin/stat -f '%m' "$f/.pid" 2>/dev/null)
            fi
            case "$pid" in ''|*[!0123456789]*) ;; *) [ "${made:-0}" -ge "${boot:-0}" ] && kill -0 "$pid" 2>/dev/null && continue ;; esac
            # And only such a folder is looked into, for something named like a bundle. Anyone can make a folder of
            # that name there.
            set -- "$f"/Excel_Diagnostics_*
            { [ -e "$1" ] || [ -L "$1" ]; } && held=" It holds something named Excel_Diagnostics_*."
        else
            # Results that could not be handed over are left as the console user's; so is anything that user made. Such
            # a folder is not looked into: only its owner and when it last changed are said.
            who=$CONSOLE_USER
        fi
        [ "$shown" -ge 5 ] && { over=$((over + 1)); continue; }
        shown=$((shown + 1))
        say "A folder named like this script's working folders is in $STAGE_BASE: $f, owned by $who, last changed $when.$held Keep it or delete it."
    done < "$STAGE/.earlier"
    rm -f "$STAGE/.earlier"
    if [ "$st" -eq 124 ]; then
        say "The look in $STAGE_BASE for folders named like this script's working folders was stopped after 30 seconds, so there can be more than are named here."
    elif [ "$over" -gt 0 ] || [ "$total" -gt 50 ]; then
        say "In all, $total folders in $STAGE_BASE owned by $([ "$AM_ROOT" -eq 1 ] && [ -n "$USER_UID" ] && echo "root or $CONSOLE_USER" || echo "this account") are named like this script's working folders (this run's own among them); $shown of them are named above."
    fi
    return 0
}
# Where the work is done, said before anything is collected: a run that is cut off has its results there.
say "Working folder: $STAGE. The results are moved to $DEST at the end; a run that is cut off leaves what it collected in the working folder."
earlier_runs
# Tells the viewer that the tags column of the .tsv files already carries permissions and storage, so it
# does not have to work them out again. Without jq the raw JSON lines have no tags and the viewer does it.
[ "$LOG_EXT" = tsv ] && row "unified_log_tags" "excel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, permissions, storage, logs-dropped"

# Each control character left in a row of jq's, and each character that shown_path shows as a space (and the three
# direction marks), written as \u and four hexadecimal digits (\U and eight past U+FFFF): jq's @tsv writes only tabs,
# line breaks, carriage returns and backslashes that way, and a field (the program path of a process, a message) can
# hold any character. The tabs and line breaks left are the ones that part the columns and the rows. Reads to the
# end whatever happens to its writes; ends with 4 when what it was to write could not all be written.
ROW_ESCAPE_PL='$| = 1; $SIG{PIPE} = "IGNORE"; binmode STDIN; binmode STDOUT; my $bad = 0;
while (my $l = <STDIN>) {
    if ($l =~ /[\x00-\x08\x0b-\x1f\x7f-\xff]/) {
        my $u = $l;
        if (utf8::decode($u)) {
            $u =~ s/([\x00-\x08\x0b-\x1f\x7f-\x{9f}\x{ad}\x{61c}\x{180e}\x{200b}\x{200e}\x{200f}\x{2028}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{206f}\x{feff}\x{fff9}-\x{fffb}\x{e0000}-\x{e007f}])/my $o = ord $1; $o > 0xffff ? sprintf("\\U%08x", $o) : sprintf("\\u%04x", $o)/ge;
            utf8::encode($u); $l = $u;
        } else {
            $l =~ s/([\x00-\x08\x0b-\x1f\x7f])/sprintf("\\u%04x", ord $1)/ge;
        }
    }
    next if $bad;
    print $l or $bad = 1;
}
exit($bad ? 4 : 0);'
# label_entries - log --style ndjson on stdin -> labeled .tsv rows (or the JSON lines unchanged without jq), each control
# character in them escaped (ROW_ESCAPE_PL). Ends with jq's status, or that of what escapes them when jq's is 0, or 4
# when the header could not be written (what it read is then read on, and not written).
label_entries() {
    local st
    if [ -n "$JQ" ]; then
        printf '%s\n' "$LABEL_HEADER" 2>/dev/null || { echo > /dev/null; cat > /dev/null; return 4; }
        # jq loads definitions from ~/.jq in the home folder it is given, and they would take the place of its own
        # (contains, test): it is given a folder that is always empty
        if [ "$HAVE_PERL" -eq 1 ]; then
            HOME=/var/empty "$JQ" --unbuffered -R -r --arg proc "$EXCEL_PROC" --arg name "$EXCEL_NAME" \
                --arg perm "$TAG_PERMISSIONS_RX" --arg stor "$TAG_STORAGE_RX" "$LABEL_JQ" | plain_perl -e "$ROW_ESCAPE_PL" --
            st=("${PIPESTATUS[@]}")
            [ "${st[0]}" -eq 0 ] || return "${st[0]}"
            return "${st[1]}"
        fi
        HOME=/var/empty "$JQ" --unbuffered -R -r --arg proc "$EXCEL_PROC" --arg name "$EXCEL_NAME" \
            --arg perm "$TAG_PERMISSIONS_RX" --arg stor "$TAG_STORAGE_RX" "$LABEL_JQ"
    else
        cat
    fi
}

count_entries() {   # count_entries FILE - log entries in a labeled .tsv or raw .ndjson file
    local n
    n=$(wc -l < "$1" 2>/dev/null | tr -d ' ')
    [ "$LOG_EXT" = tsv ] && [ "${n:-0}" -gt 0 ] && n=$((n - 1))
    echo "${n:-0}"
}
# search_said LOG-STATUS CUT-STATUS LABELLER-STATUS WRITER-STATUS FILE ERRORS-FILE [WHEN] - what one unified-log search
# came to (WHEN is the time it searched, "this day" when not given), from the statuses of log show (124: stopped at the
# --max-wait limit), of capped (3: cut at UNIFIED_SEARCH_GB), of label_entries, and of put, which wrote FILE. Any
# process can add entries that the search takes, as many as it likes, so what arrives is cut. Sets SEARCH_KIND (ok,
# unwritten, unlabelled, cut, limit or error) and SEARCH_SAID, the words for it. The entries in FILE are
# given only with words that say what came of the search, and ERRORS-FILE is named only when it was kept. Only a
# search that ran to its end and was all written has words that start with "ok": the viewer takes a day whose words
# start so as searched to its end. Only put writes into the working folder. capped writes into the pipe to the
# labeller, so its 4, which only a write that failed gives, says that the labeller stopped reading before the end;
# label_entries' own 4 says the same of put, which reads what it writes. Neither is a write into the working folder
# that failed. Any other status of capped's but 0 and 3 is its own program's end (killed, say), which is said as that.
search_said() {
    local n see=""
    n=$(count_entries "$5")
    [ -s "$6" ] && see="; see ${6##*/}"
    if [ "$4" -ne 0 ]; then SEARCH_KIND=unwritten; SEARCH_SAID="not all written into the working folder ($n entries are in the file$see)"
    elif [ "$3" -ne 0 ]; then SEARCH_KIND=unlabelled; SEARCH_SAID="not all labelled: the labeller ended with status $3 ($n entries are in the file$see)"
    elif [ "$2" -eq 4 ]; then SEARCH_KIND=unlabelled; SEARCH_SAID="not all labelled: the labeller stopped reading before the end of what the search gave ($n entries are in the file$see)"
    elif [ "$2" -ne 0 ] && [ "$2" -ne 3 ]; then SEARCH_KIND=unlabelled; SEARCH_SAID="not all labelled: the program that passes what the search gives on to the labeller ended with status $2 ($n entries are in the file$see)"
    elif [ "$2" -eq 3 ]; then SEARCH_KIND=cut; SEARCH_SAID="cut once $UNIFIED_SEARCH_GB GB of it had arrived; what came after that was not kept ($n entries$see)"
    elif [ "$1" -eq 124 ]; then SEARCH_KIND=limit; SEARCH_SAID="hit the $MAX_WAIT-minute limit, partial ($n entries; rerun with a larger --max-wait for the rest$see)"
    elif [ "$1" -ne 0 ]; then SEARCH_KIND=error; SEARCH_SAID="error $1 ($n entries$see)"
    elif [ "$n" -eq 0 ]; then SEARCH_KIND=ok; SEARCH_SAID="ok, nothing found: log show, the labeller and the writing of the rows ended with 0, and the file holds no entry for ${7:-this day}"
    else SEARCH_KIND=ok; SEARCH_SAID="ok ($n entries)"; fi
}

# copy_dir SRC DEST - copy a folder of the console user's home, read with that user's rights. The files are named
# to tar one by one, so that a file that cannot be read costs that file and not the rest of the folder. Only plain
# files are taken: a link, a pipe or a device in the copy would be followed or opened by a later step. Left out,
# and counted in collection.log and the status table: a file with a control or invisible character in its name or
# path (see ODD_GLOBS), a file whose path in the copy would be longer than
# the working folder and the zip step can take, a file over MAX_COPY_FILE_MB, the files and folders past the first
# MAX_COPY_FOLDER_ENTRIES that the copy comes to (each one costs root time when the bundle is zipped and handed
# over), and the largest files of a folder whose copy comes to more than MAX_COPY_FOLDER_MB (a file can claim any
# length without holding it, and the zip step would read every byte of that length). What arrives is cut once it
# comes to more than a folder and one more file may hold, so that the working folder cannot be filled first.
copy_dir() {
    local st counts crc want odd big shut got f lost=0 cut=0 entries long many=0 lrc why most n deep c
    local msgs="$STAGE/.copy_messages" list="$STAGE/.copy_list"
    if ! in_home "$1"; then note "  not copied, it is outside the home folder: $1"; return 1; fi
    # test answers 0 or 1; anything else (refused, stopped at a time limit, killed) is no answer
    as_user /bin/test -d "$1"; crc=$?
    answer_of $crc "$1"
    case $? in
        0) [ $crc -eq 0 ] || { note "  not found: $1"; return 1; } ;;
        1) note "  not read: nothing is read with the console user's rights at this point of the run (see the status table): $1"; COPY_SHUT=$((COPY_SHUT + 1)); return 1 ;;
        *) note "  not read: the program that looked for it ended without an answer (status $crc): $1"; COPY_SHUT=$((COPY_SHUT + 1)); return 1 ;;
    esac
    # A path in the copy may be at most 1,000 bytes long (macOS takes 1,023): a relative path of the folder's that
    # matches this is longer, and is left out (find -regex matches whole paths). find -E takes no count above 255,
    # so the count is made of parts.
    n=$((1002 - ${#2})); [ "$n" -gt 2 ] || n=3; deep=""
    while [ "$n" -gt 200 ]; do deep="$deep.{200}"; n=$((n - 200)); done
    deep="$deep.{$n}.*"
    # What there is to copy, counted first, each count with a name of its own: plain files that will be asked for (a),
    # names left out (b), files left out for their size (c), folders that cannot be read (d: counted by SHUT_PL, one
    # for each, whatever its name holds), the files and folders that will be named, this folder among them (e), and
    # the files left out for the length of their path (l). Each count keeps the ends of its own programs, as the copy
    # does: one that did not end by itself gives no count, and the helper then ends as no answer. The count and the
    # copy are given the same test for a name that is left out (ODD_PATH), after their other arguments.
    counts=$(AS_LIMIT=$COPY_SECONDS AS_WHAT="counting the files of $1" as_user /bin/sh -c '
        LC_ALL=C; export LC_ALL
        cd "$1" || exit 3
        mb=$2; deep=$3; nul=$4; shut=$5; shift 5
        end=0
        one() {         # one NAME PROGRAM FIND-ARGUMENT... - NAME=the count PROGRAM makes of what find names
            k=$1; prog=$2; shift 2
            r=$( { { /usr/bin/find "$@" -print0 2>/dev/null; echo "f$?" >&4; } \
                | { /usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO /usr/bin/perl -e "$prog"; echo "c$?" >&4; }; } 4>&1 )
            f=; c=; v=
            for x in $r; do case $x in f*) f=${x#f} ;; c*) c=${x#c} ;; n*) v=${x#n} ;; esac; done
            for y in "$f" "$c"; do
                case $y in 0|1) ;; 12[789]|1[3456789][0123456789]|2[012345][0123456789]) end=$y; return ;; *) end=125; return ;; esac
            done
            [ "$c" = 0 ] || { end=125; return; }
            case $v in ""|*[!0123456789]*) end=125; return ;; esac
            echo "$k=$v"
        }
        one a "$nul" -E . -type f ! "$@" ! -regex "$deep" ! -size +"$mb"M
        one b "$nul" . -type f "$@"
        one c "$nul" -E . -type f ! "$@" ! -regex "$deep" -size +"$mb"M
        one d "$shut" . -type d
        one e "$nul" -E . \( -type d -o -type f ! -size +"$mb"M \) ! "$@" ! -regex "$deep"
        one l "$nul" -E . -type f ! "$@" -regex "$deep"
        exit "$end"' sh "$1" "$MAX_COPY_FILE_MB" "$deep" "$NUL_COUNT_PL" "$SHUT_PL" "${ODD_PATH[@]}" 2>/dev/null); crc=$?
    if [ $crc -eq 3 ]; then
        note "  not copied, the folder could not be entered with the console user's rights: $1"
        COPY_SHUT=$((COPY_SHUT + 1)); return 1
    fi
    answer_of $crc "$1"
    case $? in
        1) if [ $crc -eq 124 ]; then note "  not copied, counting its files was stopped at its time limit (see time_limit in the status table): $1"
           else note "  not read: nothing is read with the console user's rights at this point of the run (see the status table): $1"; fi
           COPY_SHUT=$((COPY_SHUT + 1)); return 1 ;;
        2) note "  counting its files ended without an answer (status $crc): $1"; counts="" ;;
    esac
    mkdir -p "$2"
    : > "$msgs"
    # Folders are named to tar too, each by itself: an empty one arrives, and each keeps when it was last changed.
    # Inside, each program's own end is kept (none of them is the last of the shell's), and one that did not end
    # by itself makes the copy end as no answer: 125, or the signal's status. What reaches root's tar goes through
    # STREAM_PL, which cuts it at what a folder and one more file may hold.
    most=$(( (MAX_COPY_FOLDER_MB + MAX_COPY_FILE_MB) * 1048576 + MAX_COPY_FOLDER_ENTRIES * 2048 ))
    AS_LIMIT=$COPY_SECONDS AS_WHAT="copying $1" as_user /bin/sh -c '
        LC_ALL=C; export LC_ALL
        cd "$1" || exit 1
        mb=$2; deep=$3; entries=$4; pick=$5; shift 5
        exec 3>&1
        s=$( { { /usr/bin/find -E . \( -type d -o -type f ! -size +"$mb"M \) ! "$@" ! -regex "$deep" -print0; echo "f$?" >&4; } \
            | { /usr/bin/env -u PERL5OPT -u PERL_UNICODE -u PERL5LIB -u PERLLIB -u PERLIO /usr/bin/perl -e "$pick" -- "$entries"; echo "p$?" >&4; } \
            | COPYFILE_DISABLE=1 /usr/bin/tar -cf - --null -n -T - >&3; echo "t$?" >&4; } 4>&1 )
        f=; p=; t=
        for x in $s; do case $x in f*) f=${x#f} ;; p*) p=${x#p} ;; t*) t=${x#t} ;; esac; done
        for v in "$f" "$p" "$t"; do
            case $v in 0|1) ;; 12[789]|1[3456789][0123456789]|2[012345][0123456789]) exit "$v" ;; *) exit 125 ;; esac
        done
        exit "$t"' sh "$1" "$MAX_COPY_FILE_MB" "$deep" "$MAX_COPY_FOLDER_ENTRIES" "$PICK_PL" "${ODD_PATH[@]}" 2>>"$msgs" \
        | { if [ "$HAVE_PERL" -eq 1 ]; then plain_perl -e "$STREAM_PL" -- "$most"; else cat; fi; } \
        | /usr/bin/tar -xf - -o --no-same-permissions -C "$2" 2>>"$msgs"
    st=("${PIPESTATUS[@]}")
    find "$2" ! -type f ! -type d -delete 2>/dev/null
    find "$2" -depth "${ODD_NAME[@]}" -exec rm -rf -- {} + 2>/dev/null      # none is sent; this is the second lock
    find "$2" -type f -exec chmod 0644 {} + 2>/dev/null
    find "$2" -type d -exec chmod 0755 {} + 2>/dev/null
    # The folder's ceiling: the largest files go first, until what is left is under it
    find "$2" -type f -exec /usr/bin/stat -f '%z%t%N' {} + 2>/dev/null | sort -rn \
        | awk -F'\t' -v cap="$MAX_COPY_FOLDER_MB" '{ size[NR] = $1; name[NR] = substr($0, length($1) + 2); total += $1 }
            END { for (i = 1; i <= NR && total > cap * 1048576; i++) { print name[i]; total -= size[i] } }' 2>/dev/null > "$list"
    lrc=$?
    # Removed by one program, not one for each: the user can give a file as many more names (hard links) as they
    # like, each of which counts at the file's full size, and each would cost root a program of its own. No name in
    # the list holds a line break: those were removed above.
    if [ -f "$list" ]; then
        if [ "$HAVE_PERL" -eq 1 ]; then
            cut=$(plain_perl -e 'my $n = 0; while (my $f = <STDIN>) { chomp $f; $n++ if length $f && unlink $f } print $n' < "$list" 2>/dev/null)
            case "$cut" in ''|*[!0123456789]*) cut=0 ;; esac
        else
            LC_ALL=C tr '\n' '\0' < "$list" | xargs -0 rm -f -- 2>/dev/null
            while IFS= read -r f; do [ -n "$f" ] && [ ! -e "$f" ] && [ ! -L "$f" ] && cut=$((cut + 1)); done < "$list"
        fi
    fi
    rm -f "$list"
    got=$(find "$2" -type f | wc -l | tr -d ' ')
    # Each count by its name. All six are needed: when one is missing, or is not a number, none of them is known.
    want=""; odd=""; big=""; shut=""; entries=""; long=""
    for c in $counts; do
        case $c in a=*) want=${c#a=} ;; b=*) odd=${c#b=} ;; c=*) big=${c#c=} ;; d=*) shut=${c#d=} ;; e=*) entries=${c#e=} ;; l=*) long=${c#l=} ;; esac
    done
    for c in "$want" "$odd" "$big" "$shut" "$entries" "$long"; do case $c in ''|*[!0123456789]*) want="" ;; esac; done
    [ -n "$want" ] || { odd=0; big=0; shut=0; entries=0; long=0; }
    [ "$entries" -gt "$MAX_COPY_FOLDER_ENTRIES" ] && many=1
    [ -n "$want" ] && [ $((want - got - cut)) -gt 0 ] && lost=$((want - got - cut))
    # What the two tars said, set in from the margin: a line of it must not pass for a line of the collector's
    if [ -s "$msgs" ]; then LC_ALL=C tr '\000-\011\013-\037\177' ' ' < "$msgs" | sed 's/^/      /' | head -n 20 >> "$LOG"; fi
    rm -f "$msgs"
    # The copy's own statuses are 0 and 1 (tar ends with 1 when a file cannot be read); anything else means that the
    # copy did not finish, and the files it did not get to are said to be missing for that reason
    case "${st[0]}" in
        0|1)
            why="unreadable or gone before they were read"
            # (the count and the copy take the folder itself as the first of them, and it is not said)
            [ "$many" -eq 1 ] && { note "  it holds $((entries - 1)) files and folders that could be copied; the copy took the first $((MAX_COPY_FOLDER_ENTRIES - 1)) that it came to: $1"
                                   why="left out past the first $((MAX_COPY_FOLDER_ENTRIES - 1)) files and folders, or $why"; }
            if [ "${st[1]}" -eq 3 ]; then
                note "  the copy was cut once $((most / 1048576)) MB had arrived, and the last file to arrive may be cut short: $1"
                why="left out once the copy was cut, or $why"
            elif [ "${st[1]}" -ne 0 ] || [ "${st[2]}" -ne 0 ]; then
                note "  what was copied could not all be written into the working folder (the copy's messages are above), and a file that arrived may be cut short: $1"
                UNWRITTEN=$((UNWRITTEN + 1)); WRITES_LOST=$((WRITES_LOST + 1))
                why="not written into the working folder, or $why"
            fi
            if [ -z "$want" ]; then note "  the files could not be counted, so how many did not arrive is not known: $1"
            # The counts are numbers, not names: a file added after the count can stand in for one that did not arrive
            elif [ "$lost" -eq 0 ] && [ "$shut" -eq 0 ] && [ "${st[0]}" -ne 0 ]; then note "  the copy ended with status ${st[0]}, and no fewer files arrived than were counted before it (its messages, when it gave any, are above): $1"; fi
            [ "$lost" -gt 0 ] && note "  $lost file(s) did not arrive, $why: $1" ;;
        *)
            answer_of "${st[0]}" "$1"
            case "${st[0]}" in
                124) note "  copy stopped at its time limit (see time_limit in the status table): $1" ;;
                126) note "  not copied: nothing is read with the console user's rights at this point of the run (see the status table): $1" ;;
                125) note "  copy ended without an answer: $1" ;;
                *) note "  copy ended without an answer (status ${st[0]}): $1" ;;
            esac
            if [ -z "$want" ]; then note "  the files could not be counted, so how many did not arrive is not known: $1"
            elif [ "$lost" -gt 0 ]; then note "  $lost file(s) did not arrive because of that: $1"; fi ;;
    esac
    [ "$lrc" -ne 0 ] && { note "  whether this folder's copy is under $MAX_COPY_FOLDER_MB MB was not checked: the list of its files could not be written into the working folder: $1"
                          UNWRITTEN=$((UNWRITTEN + 1)); WRITES_LOST=$((WRITES_LOST + 1)); }
    [ "$shut" -gt 0 ] && note "  $shut folder(s) in it could not be read, so what they hold is not copied or counted: $1"
    [ "$odd" -gt 0 ] && note "  $odd file(s) with a control or invisible character in the name or path were left out: $1"
    [ "$long" -gt 0 ] && note "  $long file(s) were left out: their path in the copy would be longer than 1,000 bytes: $1"
    [ "$big" -gt 0 ] && note "  $big file(s) over $MAX_COPY_FILE_MB MB were left out: $1"
    [ "$cut" -gt 0 ] && note "  $cut of the largest file(s) were left out to keep this folder's copy under $MAX_COPY_FOLDER_MB MB: $1"
    [ -z "$want" ] && shut=$((shut + 1))
    COPY_LOST=$((COPY_LOST + lost)); COPY_ODD=$((COPY_ODD + odd)); COPY_BIG=$((COPY_BIG + big + cut)); COPY_SHUT=$((COPY_SHUT + shut)); COPY_LONG=$((COPY_LONG + long))
    return 0
}
# copy_file SRC DEST [MODIFIED-SECONDS] [MOST-MB] - copy one plain file, keeping when it was last changed. Read as
# fetch reads. A file over MOST-MB (MAX_COPY_FILE_MB when not given) is not copied: status 5. While COPY_BUDGET
# is set, it is the bytes that a run of copies may still take in all; each copy is taken off it, and a file that
# no longer fits is not copied: status 6. A file that was not read because reading with the console user's rights
# was refused or stopped at a time limit is status 7; one whose reader ended without an answer (killed, say) is
# status 8. One that was read and could not all be written into DEST (a full disk) is status 9. As root without
# perl nothing is read, since root reads only through FETCH_PL: status 10. One whose copy could not be made at DEST
# (its folder cannot be written to, or the name is too long), before anything was read, is status 11. The reader's
# own answers: not there, 1; not in its folder as itself, 3; not opened, or not all read, 4; not a plain file, 12;
# opening it refused, 13; read the plain way (no perl) and the read or the write failed, 14. copy_said says each in
# words.
copy_file() {
    local when=$3 most=$(( ${4:-$MAX_COPY_FILE_MB} * 1048576 )) why=5 got rc
    if [ -n "$COPY_BUDGET" ] && [ "$COPY_BUDGET" -lt "$most" ]; then most=$COPY_BUDGET; why=6; fi
    [ "$most" -gt 0 ] || return 6
    [ "$AM_ROOT" -eq 1 ] && [ "$HAVE_PERL" -eq 0 ] && return 10
    { : > "$2"; } 2> /dev/null || return 11
    got=$(fetch "$1" "$most" 2>&1 > "$2"); rc=$?
    if [ $rc -ne 0 ]; then
        rm -f "$2"
        case $rc in
            1|3|4) return $rc ;;
            2) return 4 ;;
            5) return $why ;;
            6) return 9 ;;
            7) return 12 ;;
            8) return 13 ;;
            9) return 14 ;;
            124|126) return 7 ;;
            *) return 8 ;;
        esac
    fi
    [ -n "$COPY_BUDGET" ] && COPY_BUDGET=$((COPY_BUDGET - $(/usr/bin/stat -f '%z' "$2" 2>/dev/null || echo 0)))
    case "$when" in ''|*[!0123456789]*) when=$got ;; esac
    case "$when" in ''|*[!0123456789]*) ;; *) touch -t "$(date -r "$when" '+%Y%m%d%H%M.%S')" "$2" 2>/dev/null ;; esac
    return 0
}
# copy_said STATUS PATH [MB] - what copy_file's STATUS says of the file at PATH, in two parts: SAID_DONE ("not copied"
# or "not read") and SAID_WHY, both empty when it was copied (status 0, which is also what copy_said ends with). MB is
# the most the file could hold, when that was not MAX_COPY_FILE_MB. Every caller of copy_file says why in these words.
# A file that was there and was not taken for a reason other than one of this script's own rules counts for the
# step's row: not read whole (UNREAD), its reader ended without an answer (UNANSWERED when it was run with the console
# user's rights, OWN_UNANSWERED otherwise), or not written into the working folder (UNWRITTEN).
copy_said() {
    SAID_DONE="not copied"; SAID_WHY=""
    case $1 in
        0) SAID_DONE=""; return 0 ;;
        1) SAID_WHY="it was not there when it was opened" ;;
        3) SAID_WHY="it is not in its folder under that name only" ;;
        4) SAID_WHY="it could not be opened, or not all read"; UNREAD=$((UNREAD + 1)) ;;
        5) SAID_WHY="it is over ${3:-$MAX_COPY_FILE_MB} MB" ;;
        6) SAID_WHY="the files copied before it had used up the $MAX_COPY_FOLDER_MB MB allowed for them, or it would have taken them past that" ;;
        7) SAID_DONE="not read"; SAID_WHY="nothing is read with the console user's rights at this point of the run (see the status table)" ;;
        8) SAID_DONE="not read"; SAID_WHY="the program reading it ended without an answer"
           if in_home "$2"; then UNANSWERED=$((UNANSWERED + 1)); else OWN_UNANSWERED=$((OWN_UNANSWERED + 1)); fi ;;
        9) SAID_WHY="what was read could not all be written into the working folder"; UNWRITTEN=$((UNWRITTEN + 1)); WRITES_LOST=$((WRITES_LOST + 1)) ;;
        10) SAID_DONE="not read"; SAID_WHY="/usr/bin/perl is missing, and as root files are read only through it"; UNREAD=$((UNREAD + 1)) ;;
        11) SAID_DONE="not read"; SAID_WHY="its copy could not be made in the working folder"; UNWRITTEN=$((UNWRITTEN + 1)); WRITES_LOST=$((WRITES_LOST + 1)) ;;
        12) SAID_WHY="it is not a plain file" ;;
        13) SAID_DONE="not read"; SAID_WHY="opening it was refused"; UNREAD=$((UNREAD + 1)) ;;
        14) SAID_WHY="reading it, or writing what was read, failed"; UNREAD=$((UNREAD + 1)) ;;
        *) SAID_WHY="copying it ended with status $1"; UNREAD=$((UNREAD + 1)) ;;
    esac
    return 1
}
# count_of WHERE FIND-ARGUMENT... - how many paths find names, in COUNTED (empty when that is not known), with the
# console user's rights when WHERE is in that user's home. Ends with find's status as rd gave it (see answer_of), or
# with 125 when what counted its names did not end by itself.
count_of() {
    local w=$1 n; shift
    COUNTED=""
    n=$(rd "$w" /usr/bin/find "$@" -print0 2>/dev/null | LC_ALL=C tr -cd '\0' | wc -c
        s=("${PIPESTATUS[@]}"); [ "${s[1]}" -eq 0 ] && [ "${s[2]}" -eq 0 ] || exit 125; exit "${s[0]}")
    local rc=$?
    n=${n//[[:space:]]/}
    case "$n" in ''|*[!0123456789]*) ;; *) COUNTED=$n ;; esac
    [ $rc -eq 125 ] && COUNTED=""
    return $rc
}
# odd_count WHERE WHAT FIND-ARGUMENT... - count_of the paths that hold a control or invisible character (the find
# arguments end with ODD_PATH or ODD_NAME): added to ODD_SEEN, or, when how many is not known, said in ODD_UNKNOWN, of
# WHAT (each ended with "; "). The caller sets both before its first count. Ends with 0 when the count is known.
odd_count() {
    local w=$1 what=$2 rc why; shift 2
    count_of "$w" "$@"; rc=$?
    if [ $rc -eq 125 ]; then why="the count did not end"
    else
        answer_of $rc "$w" "the count of names with a control or invisible character"
        case $? in
            0) find_one $rc "$w" "the count of names with a control or invisible character"
               if [ -n "$COUNTED" ]; then ODD_SEEN=$((ODD_SEEN + COUNTED)); return 0; fi
               why="the count did not end" ;;
            1) why="nothing is read with the console user's rights at this point of the run" ;;
            *) why="the program that counted them ended without an answer, status $rc" ;;
        esac
    fi
    ODD_UNKNOWN="${ODD_UNKNOWN}how many names with a control or invisible character were left out of $what is not known ($why); "
    return 1
}

# excel_pids [PID] - EXCEL_PIDS: the process ids of the console user's processes that run EXCEL_EXE, lowest first, one
# a line; with PID, that one only, when it is one of them (asked again right before root acts on it: a process id can
# be taken by another process once the first has ended). lsof is asked about every process of the console user's, and
# a process is taken by the program file it runs, as lsof gives it (the first name it lists for the process's program
# text), and by its owner as lsof gives it: never by its name or its arguments, which are whatever whoever started it
# chose. Ends with 0 when lsof was asked and answered, and with 2 when it was not asked or did not answer (stopped at
# its limit, or ended some other way); EXCEL_CHECK_SAID then says that in words.
excel_pids() {
    local which rc
    EXCEL_PIDS=""; EXCEL_CHECK_SAID=""
    case "$USER_UID" in ''|*[!0123456789]*) EXCEL_CHECK_SAID="which program file each process runs was not asked: the console user's account id is not known"; return 2 ;; esac
    if [ "$HAVE_PERL" -eq 0 ]; then EXCEL_CHECK_SAID="which program file each process runs was not asked: /usr/bin/perl is missing"; return 2; fi
    # Not root, lsof sees only the files of this account's own processes
    if [ "$AM_ROOT" -eq 0 ] && [ "$USER_UID" != "$(id -u)" ]; then
        EXCEL_CHECK_SAID="which program file each process runs was not asked: this script is not root, and the console user is another account"; return 2
    fi
    # Without PID every process of the console user's is asked about: no name is taken to pick the candidates, since
    # a process's name is whatever whoever started it chose
    if [ -n "${1:-}" ]; then
        case "$1" in *[!0123456789]*) return 0 ;; esac
        which=(-p "$1")
    else
        which=(-u "$USER_UID")
    fi
    EXCEL_PIDS=$(run_limited 30 /usr/sbin/lsof -a "${which[@]}" -d txt -Fpun 2>/dev/null | plain_perl -e '
        my ($exe, $uid) = @ARGV; my ($p, $u, $first, %out);
        while (<STDIN>) {
            chomp;
            if (/^p(\d+)$/) { ($p, $u, $first) = ($1, undef, 1); next }
            if (/^u(\d+)$/) { $u = $1; next }
            next unless /^n(.*)$/s && $first && defined $p;
            $first = 0;
            $out{$p} = 1 if $1 eq $exe && defined $u && $u eq $uid;
        }
        print "$_\n" for sort { $a <=> $b } keys %out;' -- "$EXCEL_EXE" "$USER_UID"; exit "${PIPESTATUS[0]}")
    rc=$?
    # lsof answers 0, or 1 when one of the processes asked about is gone
    case $rc in
        0|1) return 0 ;;
        124) EXCEL_CHECK_SAID="lsof, which says which program file each process runs, was stopped at its 30-second limit" ;;
        *) EXCEL_CHECK_SAID="lsof, which says which program file each process runs, ended with status $rc" ;;
    esac
    EXCEL_PIDS=""
    return 2
}
# excel_said - the words for the processes excel_pids looks for
excel_said() { echo "a process of $CONSOLE_USER's that runs $EXCEL_EXE"; }
# first_excel - EXCEL_PID: the lowest of excel_pids, or empty; ends with excel_pids's status
first_excel() {
    local rc
    excel_pids; rc=$?
    EXCEL_PID=${EXCEL_PIDS%%$'\n'*}
    return $rc
}
# still_excel PID WHAT - asks again, right before WHAT is run on PID as root, whether PID runs EXCEL_EXE as the console
# user. When it does not, or that is not answered, says so and that WHAT was not run (for the step's row too), and fails.
still_excel() {
    if excel_pids "$1"; then
        [ "$EXCEL_PIDS" = "$1" ] && return 0
        note "  $2 was not run: PID $1 no longer runs $EXCEL_EXE as $CONSOLE_USER (asked of lsof)"
        STEP_WHY="${STEP_WHY}$2 was not run: PID $1 no longer ran $EXCEL_EXE as the console user; "
    else
        note "  $2 was not run: whether PID $1 still runs $EXCEL_EXE was not answered ($EXCEL_CHECK_SAID)"
        STEP_WHY="${STEP_WHY}$2 was not run: whether PID $1 still ran $EXCEL_EXE was not answered; "
    fi
    return 1
}
to_mb() {       # top-style size (512K, 2464M, 1.2G, 0B, with optional +/-) -> whole MB
    echo "$1" | awk '{ v = $1; sub(/[+-]$/, "", v); u = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
        if (u == "G") n *= 1024; else if (u == "T") n *= 1048576; else if (u == "K") n /= 1024
        else if (u == "B") n /= 1048576; else if (u != "M") n = v + 0
        printf "%.0f", n }'
}

snapshot_memory() {     # snapshot_memory FILE - append system-wide memory state; fails when it could not all be written
    {
        echo "=== $(date) / $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
        echo "Memory pressure level (1=normal 2=warning 4=critical): $(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
        echo "Swap: $(sysctl -n vm.swapusage 2>/dev/null)"
        # A process's name is whatever the file it runs is named: shown as shown_path shows a path
        echo "--- top processes by memory (MEM = physical footprint, CMPRS = compressed)"
        top -l 1 -o mem -n 25 -stats pid,command,mem,cmprs,cpu,threads 2>/dev/null | shown_lines
        echo "--- vm_stat"; vm_stat
        echo "--- memory_pressure"; memory_pressure 2>/dev/null
        echo
    } 2>&1 | put "$1" append
}

# excel_args PID - the arguments PID was started with, as ps gives them: whoever started it chose them, so they are cut
# at 4 KB and shown as shown_path shows a path
excel_args() { ps -o args= -p "$1" 2>/dev/null | capped 4096 "(Cut here: the arguments came to more than 4 KB.)" | shown_lines; }

snapshot_excel_memory() {   # snapshot_excel_memory DIR - Excel's footprint right now
    local pid rc st where=${1#"$OUT"/}
    first_excel; rc=$?; pid=$EXCEL_PID
    if [ -z "$pid" ]; then
        if [ "$rc" -eq 0 ]; then
            echo "No process of $CONSOLE_USER's ran $EXCEL_EXE at $(date) (asked of lsof)." | put "$1/excel_memory.txt" || unwritten "$where/excel_memory.txt"
        else
            echo "Whether $(excel_said) was running at $(date) is not known: $EXCEL_CHECK_SAID." | put "$1/excel_memory.txt" || unwritten "$where/excel_memory.txt"
            STEP_WHY="${STEP_WHY}whether Excel was running is not known: $EXCEL_CHECK_SAID; "
        fi
        return
    fi
    {
        echo "PID $pid runs $EXCEL_EXE (asked of lsof). Started $(ps -o lstart= -p "$pid")"
        ps -o pid,etime,%cpu,rss,vsz,stat -p "$pid"
        echo "Arguments, as ps gives them:"
        excel_args "$pid"
        echo "--- top (MEM = physical footprint)"
        top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,purg,threads,state 2>/dev/null | tail -2
    } 2>&1 | put "$1/excel_memory.txt" || unwritten "$where/excel_memory.txt"
    still_excel "$pid" footprint || return
    run_limited 120 footprint -p "$pid" 2>&1 | put "$1/excel_footprint.txt"
    st=("${PIPESTATUS[@]}")
    [ "${st[1]}" -eq 0 ] || unwritten "$where/excel_footprint.txt"
    case ${st[0]} in
        0) ;;
        124) note "  footprint was stopped at its 120-second limit (see $where/excel_footprint.txt)"; STEP_WHY="${STEP_WHY}footprint was stopped at its 120-second limit; " ;;
        *) note "  footprint ended with status ${st[0]} (see $where/excel_footprint.txt)"; STEP_WHY="${STEP_WHY}footprint ended with status ${st[0]}; " ;;
    esac
}

collect_system() {
    local S="$OUT/system" since st
    step_begin
    mkdir -p "$S"
    note "System information"
    {
        echo "=== Collected ==="
        date; date -u
        echo "Mode: $MODE  Days: $DAYS  Ran as: $(id -un)  Console user: $CONSOLE_USER"
        echo; echo "=== macOS ==="; sw_vers
        echo; echo "=== Hardware ==="; system_profiler SPHardwareDataType 2>/dev/null
        echo "=== Uptime / load ==="; uptime
        echo; echo "=== Disk ==="; df -h / /System/Volumes/Data
    } 2>&1 | put "$S/system_info.txt" || unwritten "system/system_info.txt"
    snapshot_memory "$S/memory.txt" || unwritten "system/memory.txt"

    note "Sleep/wake history"
    since=$(date -v-"$REPORT_DAYS"d '+%Y-%m-%d')
    pmset -g log 2>/dev/null \
        | awk -v s="$since" '$1 >= s && ($4 == "Sleep" || $4 == "Wake" || $4 == "DarkWake" || $4 == "Start" || $4 == "Shutdown" || $4 == "Restart")' \
        | put "$S/sleep_wake.txt" || unwritten "system/sleep_wake.txt"
    pmset -g assertions 2>&1 | put "$S/power_assertions.txt" || unwritten "system/power_assertions.txt"

    note "Microsoft install history"
    { cat /var/log/install.log; gzcat /var/log/install.log.*.gz; } 2>/dev/null \
        | awk -v s="$since" '$1 ~ /^20[0-9][0-9]-/ && $1 >= s' | grep -i -E 'microsoft|excel|office' | sort \
        | put "$S/install_history_microsoft.txt"
    st=("${PIPESTATUS[@]}")
    # sort ends with status 2 when the files it sorts with cannot be written (they are in the working folder)
    [ "${st[3]}" -eq 0 ] && [ "${st[4]}" -eq 0 ] || unwritten "system/install_history_microsoft.txt"

    note "Network and security agents"
    {
        echo "=== System extensions (systemextensionsctl list) ==="; systemextensionsctl list
        echo; echo "=== Proxy configuration ==="; scutil --proxy
        echo; echo "=== Network state ==="; scutil --nwi
    } 2>&1 | put "$S/network_security.txt" || unwritten "system/network_security.txt"
    row system "system, memory, sleep/wake, network state"
}

# excel_verbose_logging - 0 when Excel's CustomerLoggingEnabled support logging is on (managed or user), 1 when it
# is not, 2 when that is not known: a preferences file was not read (see answer_of, which counts it for the step).
# VERBOSE_UNREAD says why, for verbose_word. The user's file is read with that user's rights for at most 10 seconds,
# as when it is written out as text: a few KB of it can make plutil take any amount of memory and time. A read
# stopped there is said in collection.log and in the status table (see limit_hit).
excel_verbose_logging() {
    local f v rc unknown=0
    VERBOSE_UNREAD=""
    for f in "/Library/Managed Preferences/com.microsoft.Excel.plist" \
             "/Library/Managed Preferences/$CONSOLE_USER/com.microsoft.Excel.plist" \
             "$XL/Library/Preferences/com.microsoft.Excel.plist"; do
        # What plutil prints is cut at 4 KB: the value is the file's to set, and only true or 1 is looked for
        v=$(AS_LIMIT=10 AS_WHAT="reading CustomerLoggingEnabled from $f" rd "$f" /usr/bin/plutil -extract CustomerLoggingEnabled raw -o - "$f" 2>/dev/null \
            | capped 4096; exit "${PIPESTATUS[0]}"); rc=$?
        answer_of $rc "$f" "the program that read CustomerLoggingEnabled" || {
            unknown=1
            case $rc in
                124) VERBOSE_UNREAD="${VERBOSE_UNREAD:+$VERBOSE_UNREAD; }reading $f was stopped at its time limit (see time_limit in the status table)" ;;
                126) VERBOSE_UNREAD="${VERBOSE_UNREAD:+$VERBOSE_UNREAD; }$f was not read: nothing is read with the console user's rights at this point of the run" ;;
                *) VERBOSE_UNREAD="${VERBOSE_UNREAD:+$VERBOSE_UNREAD; }the program that read $f ended without an answer (status $rc)" ;;
            esac
            continue
        }
        [ "$v" = true ] || [ "$v" = 1 ] && return 0
    done
    [ "$unknown" -eq 1 ] && return 2
    return 1
}
# verbose_word STATUS - excel_verbose_logging's STATUS in words
verbose_word() {
    case $1 in
        0) echo on ;;
        1) echo off ;;
        *) if [ -n "$VERBOSE_UNREAD" ]; then echo "not known: $VERBOSE_UNREAD"; else echo "not known (a preferences file it can be set in was not read)"; fi ;;
    esac
}

collect_office() {
    local D="$OUT/office" app p f d entry rc isfile vrc total st began
    step_begin
    mkdir -p "$D"
    note "Office versions, Excel memory, Excel logs"
    {
        for app in "Microsoft Excel" "Microsoft Word" "Microsoft PowerPoint" "Microsoft Outlook" "Microsoft Teams" "OneDrive"; do
            p="/Applications/$app.app/Contents/Info.plist"
            [ -f "$p" ] && echo "$app: $(defaults read "$p" CFBundleShortVersionString 2>/dev/null) ($(defaults read "$p" CFBundleVersion 2>/dev/null))"
        done
        # Only the process ids: what a process is named and the arguments it was started with are whoever started it's to choose
        echo; echo "=== Processes of $CONSOLE_USER's that run $EXCEL_EXE (asked of lsof), by process id ==="
        if excel_pids; then
            if [ -n "$EXCEL_PIDS" ]; then printf '%s\n' "$EXCEL_PIDS" | first_lines 50; else echo "(none)"; fi
        else
            echo "(Not known: $EXCEL_CHECK_SAID.)"
        fi
    } 2>&1 | put "$D/versions.txt" || unwritten "office/versions.txt"
    snapshot_excel_memory "$D"

    for entry in "${FIXED_SOURCES[@]}"; do
        [ -e "$OUT/${entry#*|}" ] && continue       # already copied (repro's final snapshot)
        p=${entry%%|*}
        # Outside the home folder only a single file is ever taken, and fetch decides whether it is one. In it, what
        # is a file is copied as a file, and anything else as a folder. test answers 0 or 1; anything else is no
        # answer, and is said as copy_dir says it of its own look.
        isfile=1
        if in_home "$p"; then
            as_user /bin/test -f "$p"; rc=$?
            answer_of $rc "$p"
            case $? in
                0) [ $rc -eq 0 ] || isfile=0 ;;
                1) note "  not read: nothing is read with the console user's rights at this point of the run (see the status table): $p"; continue ;;
                *) note "  not read: the program that looked for it ended without an answer (status $rc): $p"; continue ;;
            esac
        fi
        if [ "$isfile" -eq 1 ]; then
            copy_file "$p" "$OUT/${entry#*|}"
            copy_said $? "$p" || note "  $SAID_DONE: $SAID_WHY: $p"
        else
            copy_dir "$p" "$OUT/${entry#*|}"
        fi
    done

    # The lists below are written into their files by this shell, so that what they count stays counted here. Each
    # list made by a program is checked for whether it could all be written (list_written), and a file that could not
    # be made is noticed by its block not having begun.
    ODD_SEEN=0; ODD_UNKNOWN=""
    note "AutoRecover inventory"
    # The files the list takes, by name: the list and the count of names it leaves out use this one test, and the list
    # says in words what it is
    local ar=( '(' -iname '*autorecover*' -o -iname '*.xar' -o -name '~ar*' ')' )
    began=0
    {
        began=1
        # A path with a control or invisible character in it (see ODD_GLOBS) is left out of these lists: it could pass
        # for a line of its own, or for some other name
        for d in "$XL/Library/Application Support/Microsoft" "$XL/Library/Preferences/AutoRecovery"; do
            rd "$d" /bin/test -d "$d"; rc=$?
            answer_of $rc "$d" "not read: the program that looked for it"
            case $? in
                0) [ $rc -eq 0 ] || continue ;;
                1) echo "=== $d: not read (nothing is read with the console user's rights at this point of the run)"; echo; continue ;;
                *) echo "=== $d: not read (the program that looked for it ended without an answer, status $rc)"; echo; continue ;;
            esac
            # du ends with 1 when a folder in it cannot be read, and then gives the total of the rest
            total=$(rd "$d" /usr/bin/du -sh "$d" 2>/dev/null | cut -f1; exit "${PIPESTATUS[0]}"); rc=$?
            answer_of $rc "$d" "du, which gives its total size,"
            case $? in
                0) if [ -z "$total" ]; then total="total not known: du gave none"
                   elif [ $rc -eq 0 ]; then total="total $total"
                   else total="total of what could be read: $total"; fi ;;
                1) total="total not known: nothing is read with the console user's rights at this point of the run" ;;
                *) total="total not known: du ended without an answer, status $rc" ;;
            esac
            echo "=== $d  ($total)"
            # What the list holds, said by the test that picks it: no more, and nothing about what such a file means
            echo "Files whose name holds autorecover or ends in .xar (in any case), or starts with ~ar, oldest change first. Modified | bytes | path"
            # sort, as first_lines, is followed by a read to the end (drained): when it cannot write its temporary
            # files it ends at once, and the list's program must not then be stopped by a pipe that closed
            user_list "$d" '%Sm | %z | %N' '%Y-%m-%d %H:%M' "$d" -type f "${ar[@]}" ! "${ODD_PATH[@]}" 2>/dev/null \
                | drained sort | first_lines 500
            st=("${PIPESTATUS[@]}"); list_end "${st[0]}" "$d" find; list_written "${st[2]}" "${st[1]}" "office/autorecover_inventory.txt"
            if odd_count "$d" "$d" "$d" -type f "${ar[@]}" "${ODD_PATH[@]}"; then
                [ "$COUNTED" -gt 0 ] && echo "($COUNTED more with a control or invisible character in the name or path are not listed)"
            else
                echo "(How many more with a control or invisible character in the name or path are not listed is not known.)"
            fi
            echo; echo "Files over 10 MB in it, of any name, largest first (one with a control or invisible character in the name or path is not listed). bytes | path"
            user_list "$d" '%z | %N' '%Y' "$d" -type f -size +10M ! "${ODD_PATH[@]}" 2>/dev/null | drained sort -rn | first_lines 20
            st=("${PIPESTATUS[@]}"); list_end "${st[0]}" "$d" find; list_written "${st[2]}" "${st[1]}" "office/autorecover_inventory.txt"
            echo
        done
    } > "$D/autorecover_inventory.txt"
    [ "$began" -eq 1 ] || unwritten "office/autorecover_inventory.txt"

    note "Add-ins and preferences"
    began=0
    {
        began=1
        for d in "$OFFICE_GC/User Content.localized/Startup.localized/Excel" \
                 "$OFFICE_GC/User Content.localized/Add-Ins.localized" \
                 "$OFFICE_GC/User Content/Startup/Excel" "$OFFICE_GC/User Content/Add-Ins" \
                 "$XL/Documents/wef"; do
            rd "$d" /bin/test -d "$d"; rc=$?
            answer_of $rc "$d" "not read: the program that looked for it"
            case $? in
                0) [ $rc -eq 0 ] || continue ;;
                1) echo "=== $d: not read (nothing is read with the console user's rights at this point of the run)"; echo; continue ;;
                *) echo "=== $d: not read (the program that looked for it ended without an answer, status $rc)"; echo; continue ;;
            esac
            echo "=== $d"
            echo "Each entry in it, the folder itself among them, at most three levels down, in the order find gives them (one with a control or invisible character in the name or path is not listed). Modified | bytes | path"
            # first_lines and not head: head would stop the list's program before its end, and that would look like no answer
            user_list "$d" '%Sm | %z | %N' '%Y-%m-%d' "$d" -maxdepth 3 ! "${ODD_PATH[@]}" 2>/dev/null | first_lines 200
            st=("${PIPESTATUS[@]}"); list_end "${st[0]}" "$d" find; list_written "${st[1]}" 0 "office/addins.txt"
            if odd_count "$d" "$d" "$d" -maxdepth 3 "${ODD_PATH[@]}"; then
                [ "$COUNTED" -gt 0 ] && echo "($COUNTED more with a control or invisible character in the name or path are not listed)"
            else
                echo "(How many more with a control or invisible character in the name or path are not listed is not known.)"
            fi
            echo
        done
    } > "$D/addins.txt"
    [ "$began" -eq 1 ] || unwritten "office/addins.txt"
    LIST_ODD=$((LIST_ODD + ODD_SEEN))
    [ "$ODD_SEEN" -gt 0 ] && note "  $ODD_SEEN name(s) with a control or invisible character were left out of the AutoRecover and add-in lists"
    [ -n "$ODD_UNKNOWN" ] && { note "  ${ODD_UNKNOWN%; }"; STEP_WHY="$STEP_WHY$ODD_UNKNOWN"; }
    excel_verbose_logging; vrc=$?
    began=0
    {
        began=1
        for f in "/Library/Managed Preferences"/com.microsoft.*.plist "/Library/Managed Preferences/$CONSOLE_USER"/com.microsoft.*.plist; do
            [ -f "$f" ] && { echo "=== $f"; plutil -p "$f"; echo; }
        done
        echo "=== Excel verbose support logging (CustomerLoggingEnabled): $(verbose_word $vrc)"
        echo
        # The heading names the words the lines are picked by, from the same list as grep is given: a word can be in
        # a key or in a value
        local w words="" rx=""
        for w in autosave autorecover recover calc graphic addin logging; do words="${words:+$words, }$w"; rx="${rx:+$rx|}$w"; done
        echo "=== Excel user prefs: the lines of the text plutil -p gives for com.microsoft.Excel.plist that hold one of $words (in any case, in a key or in a value)"
        # The file is the console user's, and a few KB of it can unfold into any amount of text: plutil opens it
        # with that user's rights (handed the path, never a file root opened: root would follow a link put there),
        # for at most 10 seconds, and the lines found are cut at 1 MB. Past the cut plutil goes on until its limit,
        # which then stops reading with that user's rights (see as_user), and the lines below say both.
        AS_LIMIT=10 AS_WHAT="writing out the Excel preferences as text" as_user /usr/bin/plutil -p "$XL/Library/Preferences/com.microsoft.Excel.plist" 2>/dev/null \
            | grep -iE -e "$rx" | capped 1048576 "(Cut here: the lines found came to more than 1 MB.)"
        st=("${PIPESTATUS[@]}"); rc=${st[0]}
        answer_of $rc "$XL/Library/Preferences/com.microsoft.Excel.plist" "the program that read the Excel preferences"
        case $? in
            1) if [ $rc -eq 124 ]; then echo "(not read to the end: stopped at its time limit; see the status table)"
               else echo "(not read: nothing is read with the console user's rights at this point of the run)"; fi ;;
            2) echo "(not read: the program that read them ended without an answer, status $rc)" ;;
        esac
        # capped ends with 4 when what it passed on could not all be written, and with its own program's status when
        # that ended some other way; grep answers 0 or 1, and writes into capped, which reads to the end. Both are this
        # script's own programs.
        case ${st[2]} in
            0|3) answer_of "${st[1]}" office/office_prefs.txt "the program that picked the lines of the Excel preferences" ;;
            4) unwritten "office/office_prefs.txt" ;;
            *) answer_of "${st[2]}" office/office_prefs.txt "the program that cut the lines of the Excel preferences" ;;
        esac
    } > "$D/office_prefs.txt" 2>&1
    [ "$began" -eq 1 ] || unwritten "office/office_prefs.txt"
    row office "versions, Excel logs, AutoRecover, add-ins, preferences" home
}

# Inventory every log-like Microsoft file on the Mac, not just the fixed locations, so an unexpected
# source still shows up. Files changed since $SINCE are copied to office/discovered/ under their
# original path ("home" is the user's home folder). Files under FIXED_SOURCES are already copied.
discover_sources() {
    local T="$OUT/office/discovered_sources.tsv" home_roots=() sys_roots=() f entry status dest bytes mepoch modified copied=0 listed=0 since fixed stopped=0 found
    local rc ended="" lines=0 left=0 deadline why="" all=0 roots_left=0 vrc st rows_lost=0 details found
    local n_in=0 past=0 lost=0 unknown="" parts=""
    step_begin
    # What counts as a log-like file. Paths with a control or invisible character in them (see ODD_GLOBS) are left out
    # and counted: one could pass for a row of its own in the list, for some other name, or for an option to a command.
    local logs=( '(' -name '*.app' -o -name '*.framework' ')' -prune -o -type f
        '(' -iname '*.log' -o -iname '*.log.*' -o -iname '*.ips' -o -iname '*.crash' -o -iname '*.diag'
            -o -iname '*.dmp' -o -iname '*.mdmp' -o -iname '*.etl' -o -iname '*.odl*' -o -iname '*.aodl'
            -o -ipath '*/logs/*' -o -ipath '*/diagnostics/*' -o -ipath '*merp*' ')' )
    local docs=( -maxdepth 3 -type f '(' -iname '*.log' -o -iname '*.log.*' ')' '(' -ipath '*diagnostic*' -o -ipath '*microsoft*' -o -ipath '*excel*' ')' )
    # Each search names what it finds, and a line is written about each (see user_list): its size, when it last
    # changed in seconds and as a date, and its path, with tabs between
    local line=( '!' "${ODD_PATH[@]}" ) form='%z%t%m%t%Sm%t%N' tf='%Y-%m-%d %H:%M'
    mkdir -p "$OUT/office"
    note "Searching for other Microsoft log files"
    # The folders of the home folder that the search starts from are found by one helper with the console user's
    # rights: how many there are is that user's to choose, and each one would cost a helper of its own. It names
    # at most MAX_SEARCH_ROOTS of them, each ended with a NUL byte, and then how many folders it found in all. After
    # the home folder and that number it is given the patterns of a name that is left out (ODD_GLOBS).
    AS_LIMIT=$COPY_SECONDS AS_WHAT="the look for the folders of the home folder to search for other log files" as_user /bin/sh -c '
        LC_ALL=C; export LC_ALL
        home=$1; most=$2; shift 2
        n=0
        for f in "$home/Library/Containers"/com.microsoft.* "$home/Library/Containers"/UBF8T346G9.* \
                 "$home/Library/Group Containers"/UBF8T346G9.* \
                 "$home/Library/Logs"/Microsoft* "$home/Library/Logs"/OneDrive* "$home/Library/Logs/Company Portal" \
                 "$home/Library/Application Support"/Microsoft* "$home/Library/Application Support/OneDrive"; do
            for g in "$@"; do case $f in $g) continue 2 ;; esac; done
            [ -d "$f" ] || continue
            n=$((n + 1))
            [ "$n" -le "$most" ] && printf "%s\0" "$f"
        done
        printf "#%s\0" "$n"' sh "$USER_HOME" "$MAX_SEARCH_ROOTS" "${ODD_GLOBS[@]}" 2>/dev/null > "$STAGE/.roots"
    rc=$?
    # The helper ends with what its last printf answered: 1 is a list that could not all be written into the working
    # folder (or a file for it that could not be made), and not an answer
    case $rc in
        0) ;;
        1) unwritten "the list of the folders of the home folder to search"
           ended="the list of the folders of the home folder to search could not all be written into the working folder" ;;
        *) answer_of $rc "$USER_HOME"
           case $? in
               1) [ $rc -eq 124 ] && stopped=1 ;;
               2) ended="the look for the folders of the home folder to search ended without an answer (status $rc)" ;;
           esac ;;
    esac
    while IFS= read -r -d '' f; do
        case "$f" in '#'*) all=${f#\#}; case "$all" in ''|*[!0123456789]*) all=0 ;; esac; continue ;; esac
        odd_name "$f" && continue
        case "$f" in "$USER_HOME"/*) [ ${#home_roots[@]} -lt "$MAX_SEARCH_ROOTS" ] && home_roots+=("$f") ;; esac
    done < "$STAGE/.roots"
    rm -f "$STAGE/.roots"
    [ "$all" -gt "$MAX_SEARCH_ROOTS" ] && roots_left=$((all - MAX_SEARCH_ROOTS))
    for f in ${SYS_LOGS[@]+"${SYS_LOGS[@]}"}; do
        odd_name "$f" && continue
        [ -d "$f" ] && sys_roots+=("$f")
    done
    since=$(date -j -f '%Y-%m-%d %H:%M:%S' "$SINCE 00:00:00" '+%s')
    printf 'status\tmodified\tbytes\toriginal_location\tcaptured_as\n' 2>/dev/null > "$T" || { echo > /dev/null; rows_lost=1; }
    # The searches are made first, each into a file of its own in the working folder, and the list is read from
    # those files. Read straight from a search that runs beside this shell (<(...)), the search would go on by itself
    # after Ctrl-C (bash starts it with Ctrl-C ignored), past the hand-over, and could write into a folder that is no
    # longer this script's alone. A file of its own for each: the last line of one that could not all be written can
    # be cut off partway, and is then not read, rather than read together with the first line of the next.
    rm -f "$STAGE/.found1" "$STAGE/.found2" "$STAGE/.found3"
    # searched N WHAT - after search N, of WHAT: what found_split makes of it is added to the counts
    searched() {
        found_split "${st[1]}" "$STAGE/.found$1" line "$MAX_DISCOVERED_FILES"
        [ "${st[1]}" -eq 0 ] || unwritten "the list of what $2 found"
        n_in=$((n_in + FOUND_IN)); past=$((past + FOUND_PAST))
        if [ -n "$FOUND_LOST" ]; then lost=$((lost + FOUND_LOST)); else unknown="${unknown:+$unknown and }$2"; fi
        find_one "$rc" "$3" "$2"
    }
    # find's own statuses are 0 and 1 (1 when it met an error on the way: see find_one); see answer_of
    if [ ${#home_roots[@]} -gt 0 ]; then
        AS_LIMIT=$COPY_SECONDS AS_WHAT="the search of the home folder for other log files" user_list "${home_roots[0]}" "$form" "$tf" \
            "${home_roots[@]}" "${logs[@]}" "${line[@]}" 2>/dev/null | most_of "$MAX_DISCOVERED_FILES" line "$STAGE/.found1"
        st=("${PIPESTATUS[@]}"); rc=${st[0]}
        searched 1 "the search of the home folder" "$USER_HOME"
        answer_of $rc "$USER_HOME"
        case $? in
            1) [ $rc -eq 124 ] && stopped=1 ;;
            2) ended="${ended:+$ended; }the search of the home folder ended without an answer (status $rc)" ;;
        esac
    fi
    if [ ${#sys_roots[@]} -gt 0 ]; then
        user_list "${sys_roots[0]}" "$form" "$tf" "${sys_roots[@]}" "${logs[@]}" "${line[@]}" 2>/dev/null | most_of "$MAX_DISCOVERED_FILES" line "$STAGE/.found2"
        st=("${PIPESTATUS[@]}"); rc=${st[0]}
        searched 2 "the search of the system's Microsoft folders" "${sys_roots[0]}"
        answer_of $rc "${sys_roots[0]}" || ended="${ended:+$ended; }the search of the system's Microsoft folders ended without an answer (status $rc)"
    fi
    # CustomerLoggingEnabled writes verbose logs to the Documents folder; it is looked in only when that is on. When
    # whether it is on was not answered, the Documents folder is not searched, and that is said.
    excel_verbose_logging; vrc=$?
    case $vrc in
        0) AS_LIMIT=$COPY_SECONDS AS_WHAT="the search of the Documents folder for verbose logs" user_list "$USER_HOME/Documents" "$form" "$tf" \
               "$USER_HOME/Documents" "${docs[@]}" "${line[@]}" 2>/dev/null | most_of "$MAX_DISCOVERED_FILES" line "$STAGE/.found3"
           st=("${PIPESTATUS[@]}"); rc=${st[0]}
           searched 3 "the search of the Documents folder" "$USER_HOME/Documents"
           answer_of $rc "$USER_HOME/Documents"
           case $? in
               1) [ $rc -eq 124 ] && stopped=1 ;;
               2) ended="${ended:+$ended; }the search of the Documents folder ended without an answer (status $rc)" ;;
           esac ;;
        1) ;;
        *) note "  the Documents folder was not searched for verbose logs: whether Excel's verbose logging is on was not answered (see collection.log)"
           STEP_WHY="${STEP_WHY}the Documents folder was not searched for verbose logs, because whether Excel's verbose logging is on was not answered; " ;;
    esac
    COPY_BUDGET=$((MAX_COPY_FOLDER_MB * 1048576))
    # How many files there are is the console user's to choose, and each one costs time: the lists are gone through
    # for at most COPY_SECONDS, and no further than their first MAX_DISCOVERED_FILES files
    deadline=$((SECONDS + COPY_SECONDS))
    shopt -s nocasematch
    for found in "$STAGE/.found1" "$STAGE/.found2" "$STAGE/.found3"; do
      [ -f "$found" ] || continue
      while IFS=$'\t' read -r bytes mepoch modified f; do
        if [ "$listed" -ge "$MAX_DISCOVERED_FILES" ] || [ "$SECONDS" -ge "$deadline" ]; then
            if [ "$listed" -ge "$MAX_DISCOVERED_FILES" ]; then why="only the first $MAX_DISCOVERED_FILES files the searches found were gone through"
            else why="going through what the searches found was stopped once $COPY_SECONDS s had passed"; fi
            break 2
        fi
        lines=$((lines + 1))
        [ -n "$f" ] || continue
        status=""; dest=""; fixed=0
        for entry in "${FIXED_SOURCES[@]}"; do
            case "$f" in "${entry%%|*}"|"${entry%%|*}"/*)
                status="copied (fixed source)"; dest="${entry#*|}${f#"${entry%%|*}"}"; break ;;
            esac
        done
        # That is said only of a file that did arrive. One that is not in its folder's copy (unreadable then, left
        # out there, or written since) is tried again here, whatever its date: the folder's copy takes every date.
        if [ -n "$status" ] && [ ! -f "$OUT/$dest" ]; then status=""; dest=""; fixed=1; fi
        if [ -z "$status" ] && [ "$fixed" -eq 0 ]; then
            case "$f" in
                */com.microsoft.Word/*|*/com.microsoft.Powerpoint/*|*/com.microsoft.Outlook/*|*/com.microsoft.onenote.mac/*|\
                */com.microsoft.teams*|*/Microsoft/Teams/*|*/com.microsoft.edgemac*|*/Microsoft?Edge*|*/com.microsoft.rdc*)
                    status="listed only: another app's log" ;;
            esac
        fi
        case "$bytes$mepoch" in ''|*[!0123456789]*) bytes=0; mepoch=0 ;; esac
        if [ -z "$status" ] && [ "$fixed" -eq 0 ] && [ "$mepoch" -le "$since" ]; then status="listed only: last changed before $SINCE"; fi
        if [ -z "$status" ] && [ "$bytes" -gt $((MAX_DISCOVERED_MB * 1048576)) ]; then status="listed only: over $MAX_DISCOVERED_MB MB"; fi
        # Once nothing more is read with the console user's rights, that user's files are listed and nothing is
        # tried for them: no folder is made for them, and no program is started
        if [ -z "$status" ] && home_closed && in_home "$f"; then
            copy_said 7 "$f"; status="listed only: $SAID_DONE, because $SAID_WHY"
        fi
        if [ -z "$status" ]; then
            case "$f" in "$USER_HOME"/*) dest="office/discovered/home${f#"$USER_HOME"}" ;; *) dest="office/discovered$f" ;; esac
            rc=11       # the folder for its copy could not be made: as copy_file says of a copy it could not make
            mkdir -p "$OUT/$(dirname "$dest")" 2>/dev/null && { copy_file "$f" "$OUT/$dest" "$mepoch" "$MAX_DISCOVERED_MB"; rc=$?; }
            if copy_said $rc "$f" "$MAX_DISCOVERED_MB"; then status=copied; copied=$((copied + 1))
            elif [ "$fixed" -eq 1 ]; then status="listed only: not in the copy of its folder, and $SAID_DONE now, because $SAID_WHY"; dest=""
            else status="listed only: $SAID_DONE, because $SAID_WHY"; dest=""; fi
        fi
        listed=$((listed + 1))
        printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$modified" "$bytes" "$f" "$dest" 2>/dev/null >> "$T" || { echo > /dev/null; rows_lost=$((rows_lost + 1)); }
      done < "$found"
    done
    rm -f "$STAGE/.found1" "$STAGE/.found2" "$STAGE/.found3"
    shopt -u nocasematch
    COPY_BUDGET=""
    # What was not listed, each part by why: in the lists and not gone through (why), past the first
    # MAX_DISCOVERED_FILES of a search (past), not written into a list (lost), and not known (unknown)
    left=$((n_in - lines)); [ "$left" -lt 0 ] && left=0
    [ "$left" -gt 0 ] && parts="$left more in the lists of what the searches found were not gone through: $why"
    [ "$past" -gt 0 ] && parts="${parts:+$parts; }$past more were not listed: only the first $MAX_DISCOVERED_FILES files that each search finds are listed"
    [ "$lost" -gt 0 ] && parts="${parts:+$parts; }$lost more could not be written into the list of what a search found, so they were not gone through"
    [ -n "$unknown" ] && parts="${parts:+$parts; }how many more $unknown found is not known: its list could not all be written into the working folder, and neither could how many it found"
    [ "$rows_lost" -gt 0 ] && unwritten "$rows_lost row(s) of office/discovered_sources.tsv"
    ODD_SEEN=0; ODD_UNKNOWN=""
    # A search that was stopped, or whose list was cut or not gone through to its end, is not made again for the
    # count: it would be stopped again, or take as long. One whose list could not all be written is.
    if [ "$stopped" -eq 0 ] && [ "$left" -eq 0 ] && [ "$past" -eq 0 ]; then
        [ ${#home_roots[@]} -gt 0 ] && AS_LIMIT=$COPY_SECONDS odd_count "${home_roots[0]}" "what the search of the home folder found" "${home_roots[@]}" "${logs[@]}" "${ODD_PATH[@]}"
        [ ${#sys_roots[@]} -gt 0 ] && odd_count "${sys_roots[0]}" "what the search of the system's Microsoft folders found" "${sys_roots[@]}" "${logs[@]}" "${ODD_PATH[@]}"
        [ "$vrc" -eq 0 ] && AS_LIMIT=$COPY_SECONDS odd_count "$USER_HOME/Documents" "what the search of the Documents folder found" "$USER_HOME/Documents" "${docs[@]}" "${ODD_PATH[@]}"
    fi
    if [ -n "$parts" ]; then
        note "  $listed Microsoft log file(s) listed, $copied copied to office/discovered (see office/discovered_sources.tsv); $parts"
    else
        note "  $listed Microsoft log file(s) found, $copied copied to office/discovered (see office/discovered_sources.tsv)"
    fi
    [ "$ODD_SEEN" -gt 0 ] && note "  $ODD_SEEN more with a control or invisible character in the name or path were not listed or copied"
    [ -n "$ODD_UNKNOWN" ] && note "  ${ODD_UNKNOWN%; }"
    [ "$stopped" -eq 1 ] && note "  the search was stopped at its time limit (see time_limit in the status table), so there can be more that it did not reach"
    [ -n "$ended" ] && note "  $ended, so there can be more that it did not reach"
    [ "$roots_left" -gt 0 ] && note "  the search started from the first $MAX_SEARCH_ROOTS folders of the home folder named like Microsoft's; $roots_left more were not searched"
    # The row: what was found, then why there can be more
    [ "$stopped" -eq 1 ] && STEP_WHY="${STEP_WHY}the search was stopped at its time limit; "
    [ -n "$ended" ] && STEP_WHY="${STEP_WHY}$ended; "
    [ "$roots_left" -gt 0 ] && STEP_WHY="${STEP_WHY}$roots_left of the folders of the home folder named like Microsoft's were not searched (only the first $MAX_SEARCH_ROOTS were); "
    [ "$left" -gt 0 ] && STEP_WHY="${STEP_WHY}$why; "
    [ "$past" -gt 0 ] && STEP_WHY="${STEP_WHY}only the first $MAX_DISCOVERED_FILES files that each search finds are listed; "
    STEP_WHY="$STEP_WHY$ODD_UNKNOWN"
    if [ -n "$unknown" ]; then details="$listed listed and $copied copied, and how many more were found is not known"
    elif [ $((left + past + lost)) -gt 0 ]; then details="$listed listed and $copied copied, and $((left + past + lost)) more found were not listed"
    else details="$listed found, $copied copied"; fi
    [ "$ODD_SEEN" -gt 0 ] && details="$details, $ODD_SEEN with a control or invisible character in the name left out"
    row discovered_sources "$details; office/discovered_sources.tsv" home
}
write_source_catalog() {
    local C="$OUT/source_catalog.tsv" vrc began=0 lost=0 ulabel ustate udest uformat found
    step_begin
    # Each line is written by this shell, into the file the block below has open, so that what the looks count stays
    # counted here. A line that could not be written is counted; bash would otherwise keep it, and write it out with
    # whatever this shell writes next.
    line_out() { printf '%s\t%s\t%s\t%s\t%s\n' "$@" 2>/dev/null || { echo > /dev/null; lost=1; }; }
    catalog_line() {
        local label=$1 path=$2 destination=$3 details=$4 state=missing rc
        rd "$path" /bin/test -e "$path"; rc=$?
        answer_of $rc "$path" "the program that looked for it, for source_catalog.tsv,"
        case $? in
            0) [ $rc -eq 0 ] && state=found ;;
            1) state="not looked at when this list was made (see the status table)" ;;
            *) state="not known: the program that looked for it ended without an answer" ;;
        esac
        line_out "$label" "$state" "$destination" "$path" "$details"
    }
    excel_verbose_logging; vrc=$?
    {
    began=1
    line_out source availability captured_as original_location line_format_or_purpose
    # Each line says where a source was looked for and what the collector does with it, from the same variables as
    # the step that does it: nothing about what the source is for, or what it means
    reports_rule
    found="the search for other Microsoft log files lists the files in it that it takes as log files, and copies them (see office/discovered_sources.tsv)"
    catalog_line "Excel internal diagnostics" "$XL/Library/Logs" "$EXCEL_LOGS_DEST" "Excel's Logs folder in its container, copied when it is there (collection.log says what was left out). Its tabular lines: Timestamp, Process, TID, Area, Category, EventID, Level, Message, Correlation"
    line_out "Excel verbose support logging" "$(verbose_word $vrc)" "office/discovered/home/Documents (when on)" "CustomerLoggingEnabled in com.microsoft.Excel" "The CustomerLoggingEnabled setting of com.microsoft.Excel, from the managed preferences and the user's; when it is on, the Documents folder is searched for log files (see office/discovered_sources.tsv)"
    catalog_line "Shared Office logs" "$OFFICE_GC/Logs" "$OFFICE_LOGS_DEST" "The Logs folder of Office's group container, copied when it is there (collection.log says what was left out)"
    catalog_line "User Microsoft logs" "$USER_HOME/Library/Logs/Microsoft" "office/user_microsoft_logs" "The Microsoft folder of the user's Logs folder, copied when it is there (collection.log says what was left out)"
    catalog_line "OneDrive logs (App Store)" "$USER_HOME/Library/Containers/com.microsoft.OneDrive-mac/Data/Library/Logs" "office/onedrive_container_logs" "The Logs folder of the OneDrive container, copied when it is there (collection.log says what was left out)"
    catalog_line "OneDrive logs (standalone)" "$USER_HOME/Library/Logs/OneDrive" "office/discovered/home/Library/Logs/OneDrive" "The OneDrive folder of the user's Logs folder: $found"
    catalog_line "Microsoft error reporting" "$USER_HOME/Library/Containers/com.microsoft.errorreporting/Data/Library/Logs" "office/error_reporting_logs" "The Logs folder of the Microsoft Error Reporting container, copied when it is there (collection.log says what was left out)"
    catalog_line "Microsoft crash archive" "$USER_HOME/Library/Group Containers/UBF8T346G9.ms" "office/discovered/home/Library/Group Containers/UBF8T346G9.ms" "A group container of Microsoft's: $found"
    catalog_line "Microsoft system logs" "/Library/Logs/Microsoft" "office/autoupdate.log, office/discovered/Library/Logs/Microsoft" "autoupdate.log is copied when it is there, and $found"
    catalog_line "Install history" "/var/log/install.log" "system/install_history_microsoft.txt" "The lines of install.log and of its older gzipped copies dated from the day $REPORT_DAYS days before this ran on that hold microsoft, excel or office (in any case)"
    line_out "Other Microsoft log files" "see office/discovered_sources.tsv" "office/discovered/" "Microsoft containers, group containers, Logs and Application Support folders" "Each file the search took as a log file, with where it was copied or why not (no more than the first $MAX_DISCOVERED_FILES files each search found are gone through)"
    catalog_line "User diagnostic reports" "$USER_HOME/Library/Logs/DiagnosticReports" "reports/user_Library_Logs_DiagnosticReports, reports/user_Library_Logs_DiagnosticReports_Retired" "From this folder and its Retired folder: $REPORTS_RULE"
    catalog_line "System diagnostic reports" "/Library/Logs/DiagnosticReports" "reports/Library_Logs_DiagnosticReports, reports/Library_Logs_DiagnosticReports_Retired" "From this folder and its Retired folder: $REPORTS_RULE"
    catalog_line "CrashReporter files named Microsoft* or Intervals*" "$USER_HOME/Library/Application Support/CrashReporter" "reports/CrashReporter" "The files in it whose name starts with Microsoft or Intervals (in any case); the first 100 copied whose name starts with Microsoft and ends in .plist are also written out as text"
    ulabel="Filtered unified logs"; ustate="see unified_logs/collection_status.txt"; udest="unified_logs/YYYY-MM-DD.$LOG_EXT"
    uformat="One entry per row, tab-separated with a header: local_time, utc_time (lines up with Excel's own logs), level (Default/Info/Debug/Error/Fault or event type), process, pid, sender (library that logged it), subsystem, category, tags (excel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, permissions, storage, logs-dropped; empty when none apply), message (line breaks as \\n)"
    if [ "$MODE" = repro ]; then
        ulabel="Live unified-log stream, all processes"; ustate=${REPRO_STREAM_SAID:-"see repro in manifest.tsv"}; udest="repro/unified_live_unfiltered.$LOG_EXT"
    fi
    [ "$LOG_EXT" = tsv ] || uformat="One JSON object per line from log --style ndjson (jq was not available to label them)"
    line_out "$ulabel" "$ustate" "$udest" "macOS unified log" "$uformat"
    if [ "$ARCHIVE" -eq 1 ]; then
        line_out "Unfiltered unified-log archive" "requested" "unified_logs/system_logs_from_${SINCE}.logarchive" "macOS unified log store" "All-process Apple logarchive; open with Console or log show"
    fi
    } > "$C"
    [ "$began" -eq 1 ] && [ "$lost" -eq 0 ] || unwritten "source_catalog.tsv"
    row source_catalog "source_catalog.tsv" home
}

# The header facts of reports, as each report records them. It reads the paths of the reports, each ended with a NUL
# byte, and writes for each a heading, "## " and the path without PREFIX, then a line for each fact, then an empty
# line. A .ips report is a line of JSON and then a JSON or text body; the older kinds are text with "Name: value"
# lines. Nothing is read into them. Each fact and heading is written as shown_text makes it (see SHOWN_RULE_PL, which
# goes before this program), so each stays one line and nothing in it reorders or hides what follows: the console
# user writes reports too, and a process names itself.  PREFIX
IFS= read -r -d '' REPORT_PL <<'PERL'
use strict; use warnings;
my $prefix = shift; $prefix = '' unless defined $prefix;
binmode STDIN; binmode STDOUT;
sub facts {
    my $f = shift;
    open my $h, '<:raw', $f or return '(This report could not be opened.)';
    my $t; defined read($h, $t, 8 << 20) or return '(This report could not be read.)';
    close $h;
    my @out;
    my $say = sub { my ($k, $v) = @_; return unless defined $v && length $v; $v =~ s/\\([\/"\\])/$1/g; $v = shown_text($v); $v =~ s/\s+/ /g; push @out, "$k: $v" };
    my $str = sub { my ($text, $key) = @_; defined $text && $text =~ /"\Q$key\E"\s*:\s*"((?:[^"\\]|\\.)*)"/ ? $1 : undef };
    my $num = sub { my ($text, $key) = @_; defined $text && $text =~ /"\Q$key\E"\s*:\s*(-?\d+)/ ? $1 : undef };
    my $obj = sub { my ($text, $key) = @_; $text =~ /"\Q$key\E"\s*:\s*\{([^{}]*)\}/ ? $1 : undef };
    if ($t =~ /^(\{[^\n]*\})\r?\n(.*)\z/s) {
        my ($head, $body) = ($1, $2);
        my $ver = $str->($head, 'app_version'); my $build = $str->($head, 'build_version'); my $type = $str->($head, 'bug_type');
        $say->('Report type', defined $type ? "bug type $type" : undef);
        $say->('Process', $str->($head, 'app_name') // $str->($head, 'name'));
        $say->('Version', defined $ver ? $ver . (defined $build && length $build ? " ($build)" : '') : undef);
        $say->('Date/Time', $str->($head, 'timestamp'));
        $say->('OS Version', $str->($head, 'os_version'));
        if ($body =~ /^\s*\{/) {
            my $ex = $obj->($body, 'exception'); my $term = $obj->($body, 'termination');
            my $kind = $str->($ex, 'type'); my $sig = $str->($ex, 'signal'); my $space = $str->($term, 'namespace'); my $code = $num->($term, 'code');
            $say->('Exception Type', defined $kind ? $kind . (defined $sig ? " ($sig)" : '') : undef);
            $say->('Exception Subtype', $str->($ex, 'subtype'));
            $say->('Termination', $str->($term, 'indicator') // (defined $space ? "namespace $space" . (defined $code ? ", code $code" : '') : undef));
            # Only a crash report calls this thread crashed; other reports of the same shape just name it
            $say->(defined $type && ($type eq '309' || $type eq '109') ? 'Crashed Thread' : 'Faulting Thread', $num->($body, 'faultingThread'));
            $say->('Largest process', $str->($body, 'largestProcess'));
            $t = '';
        } else { $t = $body }
    }
    my %seen;           # the first of each: a hang or resource report goes on to list other processes under the same names
    for my $line (split /\r?\n/, substr($t, 0, 65536)) {
        next unless $line =~ m{^(Process|Command|Path|Identifier|Version|Date/Time|OS Version|Event|Action taken|Duration|Exception Type|Exception Codes|Termination Reason|Crashed Thread):\s+\S};
        next if $seen{$1}++;
        push @out, join ' ', split ' ', shown_text($line);
    }
    return @out;
}
local $/ = "\0";
while (my $f = <STDIN>) {
    chomp $f;
    my $name = substr($f, 0, length $prefix) eq $prefix ? substr($f, length $prefix) : $f;
    my @facts = eval { local $/ = "\n"; facts($f) };
    @facts = ('(The facts of this report could not be read.)') if $@;
    print '## ', shown_text($name), "\n", map({ "$_\n" } @facts), "\n";
}
exit 0;
# ---- the end of REPORT_PL ----
PERL
program_read "$REPORT_PL" REPORT_PL
# report_facts PREFIX - the facts of each report whose path it reads (see REPORT_PL), each under a heading with its
# path without PREFIX. One program for all of them: the console user can put as many reports in their folder as they
# like, and a program started for each would cost root that much time. Without perl, grep gives the lines of the older
# kinds, with only the ASCII control characters in them shown as spaces (as shown_path does without perl).
report_facts() {
    local f
    if [ "$HAVE_PERL" -eq 1 ]; then
        # "--" ends perl's options: a path is never read as one
        plain_perl -e "$SHOWN_RULE_PL" -e "$REPORT_PL" -- "$1" 2>/dev/null
        return
    fi
    while IFS= read -r -d '' f; do
        echo "## ${f#"$1"}"
        grep -a -i -E '^(Process|Command|Path|Identifier|Version|Date/Time|OS Version|Event|Duration|Exception Type|Exception Codes|Termination Reason|Crashed Thread):' -- "$f" 2>/dev/null \
            | head -14 | LC_ALL=C tr '\001-\011\013-\037\177' ' '
        echo
    done
}

collect_reports() {
    local R="$OUT/reports" dir tag f n rc lrc cls total i deadline left=0 big=0 folder st began lost=0 foot
    local said_n=() said_w=()
    step_begin
    mkdir -p "$R"
    ODD_SEEN=0; ODD_UNKNOWN=""
    report_tests
    note "Diagnostic reports: from each report folder, $REPORTS_RULE"
    for dir in "$SYS_REPORTS" "$SYS_REPORTS/Retired" \
               "$USER_HOME/Library/Logs/DiagnosticReports" "$USER_HOME/Library/Logs/DiagnosticReports/Retired"; do
        rd "$dir" /bin/test -d "$dir"; rc=$?
        answer_of $rc "$dir"
        case $? in
            0) [ $rc -eq 0 ] || continue ;;
            1) echo "=== $dir: not read (nothing is read with the console user's rights at this point of the run)" 2>/dev/null >> "$R/report_listing.txt" \
                   || { echo > /dev/null; lost=1; }
               continue ;;
            *) echo "=== $dir: not read (the program that looked for it ended without an answer, status $rc)" 2>/dev/null >> "$R/report_listing.txt" \
                   || { echo > /dev/null; lost=1; }
               note "  not read: the program that looked for it ended without an answer (status $rc): $dir"; continue ;;
        esac
        # The folder its reports are copied into, named after where they came from. Worked out by the shell itself:
        # the home folder's path comes from the account database, and written into a sed program it would be read
        # as part of the program. Without a name of its own, a folder's reports could land among another folder's.
        case "$dir" in "$USER_HOME"/*) tag=user${dir#"$USER_HOME"} ;; *) tag=${dir#/} ;; esac
        tag=${tag//\//_}
        case "$tag" in ''|.|..) note "  not read: no folder could be named for its reports: $dir"; continue ;; esac
        # -q: a character in a name that does not print is shown as "?", so that a name cannot pass for a line.
        # first_lines and not head: head would stop ls before its end, and that would look like no answer.
        began=0; st=(0 0)
        { began=1; echo "=== $dir (newest first)"; rd "$dir" /bin/ls -ltq "$dir" 2>&1 | first_lines 500; st=("${PIPESTATUS[@]}"); list_end "${st[0]}" "$dir"; echo; } >> "$R/report_listing.txt"
        [ "$began" -eq 1 ] && [ "${st[1]}" -eq 0 ] || lost=1
        mkdir -p "$R/$tag"
        # The reports are picked by the rule held in REPORT_NAMES and REPORT_FROM (see reports_rule). A report with a
        # control or invisible character in its name (see ODD_GLOBS) is left out and counted: every later step takes
        # one name to be one line.
        # Whether a report names Excel is asked with the same care as the copy takes (see FETCH_PL): the file is
        # opened as itself or not at all, by root only when it lies in this folder under no other name. The list is
        # made by REPORTS_SH, which keeps the end of each program it runs.
        folder=""
        [ "$AM_ROOT" -eq 1 ] && ! in_home "$dir" && folder=$dir
        COPY_BUDGET=$((MAX_COPY_FOLDER_MB * 1048576))     # for this folder's reports
        # listed into a file first, for the reason given in discover_sources
        rd "$dir" /bin/sh -c "$REPORTS_SH" sh "$dir" "$folder" "$EXCEL_PROC" "$NAMES_PL" "$FETCH_PL" "${#TAKEN[@]}" "${TAKEN[@]}" "${TESTED[@]}" 2>/dev/null \
            | most_of "$MAX_DISCOVERED_FILES" nul "$STAGE/.found"
        st=("${PIPESTATUS[@]}"); lrc=${st[0]}
        [ "${st[1]}" -eq 0 ] || unwritten "the list of reports to copy from $dir"
        found_split "${st[1]}" "$STAGE/.found" nul "$MAX_DISCOVERED_FILES"
        # How many files a folder holds is the console user's to choose for their own: each folder's list is gone
        # through for at most COPY_SECONDS and no further than MAX_DISCOVERED_FILES, and once nothing more is read
        # with that user's rights, the rest of theirs are counted and nothing is tried for them
        deadline=$((SECONDS + COPY_SECONDS)); i=0
        while IFS= read -r -d '' f; do
            [ "$i" -ge "$MAX_DISCOVERED_FILES" ] || [ "$SECONDS" -ge "$deadline" ] && break
            i=$((i + 1))
            if home_closed && in_home "$f"; then rc=7; else copy_file "$f" "$R/$tag/${f##*/}"; rc=$?; fi
            copy_said $rc "$f" || { said_n[$rc]=$(( ${said_n[$rc]:-0} + 1 )); said_w[$rc]="$SAID_DONE, each because $SAID_WHY"; }
            case $rc in 5|6) big=$((big + 1)) ;; esac
        done < "$STAGE/.found"
        rm -f "$STAGE/.found"
        # Not gone through: in the list and not reached, and past its first MAX_DISCOVERED_FILES. What could not be
        # written into the list is said apart: it was not left by those two rules.
        left=$((left + FOUND_IN - i + FOUND_PAST))
        found_lost "the search for reports to copy in $dir"
        # find's own statuses are 0 and 1 (1 when it met an error on the way: see find_one); 124 and 126 close the
        # home and are said in the status table
        answer_of $lrc "$dir"
        [ $? -eq 2 ] && note "  the list of reports to copy from $dir ended without an answer (status $lrc), so reports in it may not all be copied"
        find_one "$lrc" "$dir" "the list of reports to copy"
        odd_count "$dir" "$dir" "$dir" -maxdepth 1 -type f "${ODD_NAME[@]}"
    done
    note "  copied $(find "$R" -type f ! -name report_listing.txt | wc -l | tr -d ' ') report(s)"
    if [ "$ODD_SEEN" -gt 0 ]; then
        note "  $ODD_SEEN report(s) with a control or invisible character in the name were not copied"
        STEP_WHY="${STEP_WHY}$ODD_SEEN report(s) with a control or invisible character in the name were not copied; "
    fi
    for rc in ${said_n[@]+"${!said_n[@]}"}; do note "  ${said_n[$rc]} report(s) were listed and ${said_w[$rc]}"; done
    COPY_BIG=$((COPY_BIG + big)); big=0

    # The files of the CrashReporter folder whose name starts with Microsoft or Intervals
    mkdir -p "$R/CrashReporter"
    dir="$USER_HOME/Library/Application Support/CrashReporter"
    said_n=(); said_w=()
    COPY_BUDGET=$((MAX_COPY_FOLDER_MB * 1048576))
    rd "$dir" /usr/bin/find "$dir" -maxdepth 1 -type f ! "${ODD_NAME[@]}" \
        \( -iname 'Microsoft*' -o -iname 'Intervals*' \) -print0 2>/dev/null | most_of "$MAX_DISCOVERED_FILES" nul "$STAGE/.found"
    st=("${PIPESTATUS[@]}"); lrc=${st[0]}
    [ "${st[1]}" -eq 0 ] || unwritten "the list of files to copy from $dir"
    found_split "${st[1]}" "$STAGE/.found" nul "$MAX_DISCOVERED_FILES"
    deadline=$((SECONDS + COPY_SECONDS)); i=0
    while IFS= read -r -d '' f; do
        [ "$i" -ge "$MAX_DISCOVERED_FILES" ] || [ "$SECONDS" -ge "$deadline" ] && break
        i=$((i + 1))
        if home_closed; then rc=7; else copy_file "$f" "$R/CrashReporter/${f##*/}"; rc=$?; fi     # the folder is in the home folder
        copy_said $rc "$f" || { said_n[$rc]=$(( ${said_n[$rc]:-0} + 1 )); said_w[$rc]="$SAID_DONE, each because $SAID_WHY"; }
        case $rc in 5|6) big=$((big + 1)) ;; esac
    done < "$STAGE/.found"
    rm -f "$STAGE/.found"
    left=$((left + FOUND_IN - i + FOUND_PAST))
    found_lost "the search for files to copy in $dir"
    for rc in ${said_n[@]+"${!said_n[@]}"}; do note "  ${said_n[$rc]} file(s) of $dir were listed and ${said_w[$rc]}"; done
    COPY_BIG=$((COPY_BIG + big))
    answer_of $lrc "$dir"
    [ $? -eq 2 ] && note "  the list of files to copy from $dir ended without an answer (status $lrc), so they may not all be copied"
    find_one "$lrc" "$dir" "the list of files to copy"
    n=$ODD_SEEN
    odd_count "$dir" "$dir" "$dir" -maxdepth 1 -type f \( -iname 'Microsoft*' -o -iname 'Intervals*' \) "${ODD_NAME[@]}"
    n=$((ODD_SEEN - n))
    if [ "$n" -gt 0 ]; then
        note "  $n file(s) of $dir with a control or invisible character in the name were not copied"
        STEP_WHY="${STEP_WHY}$n file(s) of the CrashReporter folder with a control or invisible character in the name were not copied; "
    fi
    [ -n "$ODD_UNKNOWN" ] && { note "  ${ODD_UNKNOWN%; }"; STEP_WHY="$STEP_WHY$ODD_UNKNOWN"; }
    COPY_BUDGET=""
    REPORTS_LEFT=$left
    if [ "$left" -gt 0 ]; then
        note "  $left file(s) listed in the report folders were not gone through: going through a folder's list stops once $COPY_SECONDS s have passed, and after its first $MAX_DISCOVERED_FILES files"
        record_status "report_lists" "incomplete" "$left file(s) listed in the report folders were not gone through (going through a folder's list stops once $COPY_SECONDS s have passed, and after its first $MAX_DISCOVERED_FILES files); see collection.log"
    fi
    # Each CrashReporter file named Microsoft*.plist is also written out as text. It is the console user's own file,
    # which can unfold into any amount of text: plutil reads it with that user's rights (handed the copy to read), for
    # at most 10 seconds and 1 MB of text each, and only the first 100 files are written out. The text goes through
    # STREAM_PL, which cuts it, to put, which reads on when it cannot write, so that plutil is never stopped by a pipe
    # that closed.
    n=0
    for f in "$R/CrashReporter"/Microsoft*.plist; do
        [ -f "$f" ] || continue
        n=$((n + 1)); [ "$n" -le 100 ] || continue
        AS_STDIN=1 AS_LIMIT=10 AS_WHAT="writing $(shown_path "${f#"$OUT"/}") as text" as_user /usr/bin/plutil -p - < "$f" 2>&1 \
            | { if [ "$HAVE_PERL" -eq 1 ]; then plain_perl -e "$STREAM_PL" -- 1048576; else head -c 1048576; fi; } | put "${f%.plist}.txt"
        st=("${PIPESTATUS[@]}")
        # plutil read the console user's own record: it counts as one of that user's programs
        answer_of "${st[0]}" "$dir/${f##*/}"; cls=$?
        foot=""
        [ "${st[1]}" -eq 3 ] && foot="(Cut here: the text of this record came to more than 1 MB.)"
        case $cls in
            1) if [ "${st[0]}" -eq 124 ]; then foot="${foot:+$foot$'\n'}(Not written out to its end: stopped at its time limit; see the status table.)"
               else foot="${foot:+$foot$'\n'}(Not written out: nothing is run with the console user's rights at this point of the run; see the status table.)"; fi ;;
            2) foot="${foot:+$foot$'\n'}(Not written out to its end: the program that wrote it ended without an answer, status ${st[0]}.)" ;;
        esac
        [ -n "$foot" ] && { printf '%s\n' "$foot" | put "${f%.plist}.txt" append || st[2]=4; }
        # STREAM_PL ends with 4 when what it passed on could not all be written
        [ "${st[1]}" -ne 4 ] && [ "${st[2]}" -eq 0 ] || { foot=${f%.plist}.txt; unwritten "${foot#"$OUT"/}"; }
    done
    [ "$n" -gt 100 ] && note "  $((n - 100)) CrashReporter file(s) named Microsoft*.plist were copied and not also written out as text: only the first 100 are"
    [ "$lost" -eq 1 ] && unwritten "reports/report_listing.txt"

    note "Diagnostic report summary"
    {
        echo "# Diagnostic report summary"
        echo "Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo
        # Counted by name only: what a kind of report stands for is not said here
        echo "## Reports copied (not those of CrashReporter), counted by name, with a date in the name and what follows it up to the file's ending taken off"
        find "$R" -type f ! -name report_listing.txt ! -name crash_summary.txt ! -path '*/CrashReporter/*' -print | sed -E 's#.*/##; s/[-_]20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].*\././; s/[-_]20[0-9][0-9]-.*//' \
            | sort | uniq -c | sort -rn
        echo
        # A path with a control or invisible character is passed over: none is copied with one in its name, and this
        # is the second lock
        find "$R" -type f \( -iname '*.ips' -o -iname '*.crash' -o -iname '*.hang' -o -iname '*.spin' -o -iname '*.diag' -o -iname '*.panic' \) \
            ! "${ODD_PATH[@]}" -print0 | sort -z | report_facts "$OUT/"
    } 2>&1 | put "$R/crash_summary.txt" || unwritten "reports/crash_summary.txt"
    row reports "diagnostic reports, by the rule in source_catalog.tsv, and the CrashReporter files named Microsoft* or Intervals*" home
}

# A path as it is written into a text file: control characters in it are shown as spaces.
shown_path() {
    # Each control character in the path, each line or paragraph separator and each character that clean_note takes
    # out of a note is shown as one space: the path stays one line, and nothing in it reorders or hides what
    # follows. Ends with status 1 when perl could not be run or failed; then only the ASCII control characters are.
    local shown
    if shown=$( { printf '%s' "$1" | plain_perl -e '
        binmode(STDIN); binmode(STDOUT);
        local $/; my $s = <STDIN>;
        print shown_text($s); exit 0;' -e "$SHOWN_RULE_PL" --; } 2> /dev/null ); then
        printf '%s' "$shown"
        return 0
    fi
    printf '%s' "$1" | LC_ALL=C tr '\001-\037\177' ' '
    return 1
}
# shown_lines - what it reads, each line of it as shown_path shows a path (see SHOWN_RULE_PL), for what a program
# prints about something the console user chose. Reads to the end whatever happens to its writes, and ends with
# status 4 when what it was to write could not all be written. Without perl only the ASCII control characters are
# shown as spaces.
shown_lines() {
    if [ "$HAVE_PERL" -eq 1 ]; then
        plain_perl -e '$SIG{PIPE} = "IGNORE"; binmode STDIN; binmode STDOUT; my $bad = 0;
            while (my $l = <STDIN>) { my $nl = $l =~ s/\n\z// ? "\n" : ""; next if $bad; print shown_text($l), $nl or $bad = 1 }
            close STDOUT or $bad = 1;
            exit($bad ? 4 : 0);' -e "$SHOWN_RULE_PL" --
        return
    fi
    LC_ALL=C tr '\001-\011\013-\037\177' ' '
}

# What whoever ran this gave it about the incident: the --note line and the --workbook path. Written at the start
# of every mode, so that a run that is stopped keeps it. Nothing is written when neither was given.
write_incident_context() {
    local C="$OUT/case" what="" shown shown_rc rc
    [ -n "$NOTE" ] || [ -n "$WORKBOOK" ] || return 0
    step_begin
    mkdir -p "$C"
    {
        echo "# Incident context"
        echo
        echo "- Collector started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        if [ -n "$WORKBOOK" ]; then
            echo
            echo "## Workbook named when the collector was run"
            echo
            shown=$(shown_path "$WORKBOOK"); shown_rc=$?
            printf '    %s\n' "$shown"
            echo
            if [ "$shown_rc" -eq 0 ]; then
                echo "This is the path that was given, with each of these in it shown as one space: control characters, line and paragraph separators, and the characters on a fixed list in the collector (those that mark, embed, override or isolate the direction of text, and soft hyphen, zero-width space, word joiner, byte-order mark, tag characters and a few more that draw nothing). Any other character that draws nothing, and any byte that is not UTF-8 text, is as it was given. A path typed or dragged at the collector's question is given as the bytes that arrived there, except codes that start with Esc (what arrow and function keys send), NUL bytes, what did not fit in the 8,000 bytes the question keeps, and the keys that end, edit or interrupt an answer wherever they were taken as keys and not as part of a paste. Its backslash escapes were then taken off (a backslash and the character after it became that character, a backslash before a line break went with it, and a backslash with nothing after it stayed), and so were spaces, tabs, line breaks, carriage returns, vertical tabs, form feeds and straight quote marks at its two ends, which is how Terminal writes the path of a dragged file. The workbook was not copied."
            else
                echo "This is the path that was given, with each ASCII control character in it shown as one space. perl could not be run or failed on this Mac, so nothing else in it was changed: other control characters, and characters that reorder text or draw nothing, are as they were given. A path typed or dragged at the collector's question first had its backslash escapes taken off (a backslash and the character after it became that character, a backslash before a line break went with it, and a backslash with nothing after it stayed), and then spaces, tabs, line breaks, carriage returns, vertical tabs, form feeds and straight quote marks at its two ends, which is how Terminal writes the path of a dragged file. The workbook was not copied."
            fi
        fi
        if [ -n "$NOTE" ]; then
            echo
            echo "## What happened, as typed by whoever ran the collector"
            echo
            printf '    %s\n' "$NOTE"
            echo
            if [ "$NOTE_PLAIN" -eq 1 ]; then
                echo "This is what was typed, as far as the shell could keep it: perl could not be run or failed on this Mac, so only the plain ASCII characters are here, on one line. Everything else became a space or was left out, and every run of spaces became one space."
            elif [ "${NOTE_PLAIN_TOLD:-0}" -eq 1 ]; then
                echo "This is what was typed, with only its plain ASCII characters kept, on one line. Everything else became a space or was left out, and every run of spaces became one space. This run was started with --note-plain, the option by which the collector's run without sudo passes on that perl could not be run or failed there and that it kept only these characters."
            else
                echo "This is what was typed, put on one line. Each run of line breaks, tabs, plain spaces and no-break spaces became one space, and spaces at the ends were taken off. Control characters and bytes that are not UTF-8 text became a space or were left out. Complete key codes (what arrow and function keys send) were taken out. So were the characters on a fixed list in the collector: those that mark, embed, override or isolate the direction of text, and soft hyphen, zero-width space, word joiner, byte-order mark, tag characters and a few more that draw nothing. Any other character that draws nothing was left as it was."
            fi
            # Characters beyond ASCII are read as UTF-8 whatever the locale (see ASK_PL and clean_note): where the
            # locale does not name UTF-8 (the test ASK_PL makes), the bytes that arrived may have been meant as another
            # encoding. The locale's own name is not written: it is text whoever runs this chose, and this file is
            # Markdown, which the viewer draws.
            if [ -n "$(printf '%s' "$NOTE" | LC_ALL=C tr -d '\000-\177')" ]; then
                case "${P_LOCALE:-}" in *[Uu][Tt][Ff]8*|*[Uu][Tt][Ff]-8*) ;; *)
                    echo "The locale this run was started in does not name UTF-8. The characters beyond ASCII in the line were read as UTF-8, and may not be the characters that were typed." ;;
                esac
            fi
            # What this run saw itself is said as a fact; what it was told by an option is said as that option
            if [ "${NOTE_OVER:-0}" -eq 1 ]; then echo "More than 8,000 bytes of text arrived at the question, the most it keeps, and what did not fit was not kept. The text may have been edited after that."
            elif [ "${NOTE_OVER_TOLD:-0}" -eq 1 ]; then echo "This run was started with --note-over, the option by which the collector's run without sudo passes on that more than 8,000 bytes of text arrived at its question, the most it keeps, that what did not fit was not kept, and that the text may have been edited after that."; fi
            if [ "${NOTE_CUT:-0}" -eq 1 ]; then echo "It was longer than 500 characters, so only its beginning is here."
            elif [ "${NOTE_CUT_TOLD:-0}" -eq 1 ]; then echo "This run was started with --note-cut, the option by which the collector's run without sudo passes on that the line was longer than 500 characters and that only its beginning was kept."; fi
            if [ "${NOTE_LATE:-0}" -eq 1 ]; then echo "More input arrived right after the Return that ended it. That input was not kept."
            elif [ "${NOTE_LATE_TOLD:-0}" -eq 1 ]; then echo "This run was started with --note-late, the option by which the collector's run without sudo passes on that more input arrived at its question right after the Return that ended the line, and that it was not kept."; fi
            echo "The collector checked it against nothing it collected."
        fi
        if [ "${REDACT:-0}" -eq 1 ]; then
            echo
            echo "Hiding names (--redact) was asked for. Where that step ran, it rewrote what is set off above like any other text, so it can differ from what was given: summary.md says whether the step ran, and redaction.txt what it replaced."
        fi
    } 2> /dev/null | put "$C/incident_context.md"; rc=$?
    [ -n "$NOTE" ] && what="--note text"
    [ -n "$WORKBOOK" ] && what="${what:+$what, }--workbook path"
    if [ $rc -eq 0 ]; then
        row "incident_context" "$what"
    else
        WRITES_LOST=$((WRITES_LOST + 1))
        record_status "incident_context" "failed" "$what could not all be written into case/incident_context.md"
    fi
}

# Facts about the workbook named with --workbook: its size and dates, never its contents. Written under another
# name and moved into place when whole, so that a step that was stopped leaves no file that looks finished.
# ended_said PROGRAM STATUS - how PROGRAM, run with the console user's rights by as_user, ended without an answer, in
# fixed words: its own messages are not kept
ended_said() {
    case $2 in
        124) echo "$1 was stopped at its time limit (see collection.log)" ;;
        126) echo "nothing is read with the console user's rights at this point of the run" ;;
        *) if [ "$2" -ge 127 ]; then echo "$1 ended without an answer (status $2)"; else echo "$1 ended with status $2"; fi ;;
    esac
}
collect_workbook_metadata() {
    local C="$OUT/case" shown wb rc missing mrc facts spot link target
    [ -n "$WORKBOOK" ] || return 0
    step_begin
    shown=$(shown_path "$WORKBOOK")
    case "$WORKBOOK" in /*) wb=$WORKBOOK ;; *) wb="$PWD/$WORKBOOK" ;; esac     # a full path cannot pass for an option
    mkdir -p "$C"
    # Read with the console user's rights: the facts of a file that user cannot see are not theirs to be given
    # test answers 0 or 1; anything else (refused, stopped at a time limit, killed) is no answer
    as_user /bin/test -f "$wb"; rc=$?
    if [ $rc -eq 0 ]; then
        # Each part says when it was not read, and the status row then says the facts are not all there. The facts
        # are read first and the file is written after, whole, by put: a fact that could not be written is not then
        # said to be one that was not read. It is written under another name and moved into place when whole.
        # stat -L gives the facts of the file the path leads to, as mdls does. A program that did not answer is said in
        # fixed words, with its status: its own message names the path, which can hold anything, line breaks among it.
        missing=""
        facts=$(as_user /usr/bin/stat -L -f 'Modified: %Sm%nBytes: %z' -t '%Y-%m-%d %H:%M:%S %Z' "$wb" 2>/dev/null); rc=$?
        [ $rc -eq 0 ] || { facts="Modified and Bytes: not read: $(ended_said stat $rc)"; missing="its dates and size"; }
        # Whether the path itself is a symbolic link, and where the link says it leads, shown as the path is
        link=""
        as_user /bin/test -L "$wb"; rc=$?
        case $rc in
            0) target=$(as_user /usr/bin/readlink -n "$wb" 2>/dev/null; rc=$?; echo x; exit $rc); rc=$?
               if [ $rc -eq 0 ]; then link="Link: the path is a symbolic link to $(shown_path "${target%x}")"
               else link="Link: the path is a symbolic link; where it leads was not read: $(ended_said readlink $rc)"; missing="${missing:+$missing and }where the link leads"; fi ;;
            1) ;;
            *) link="Link: whether the path is a symbolic link was not read: $(ended_said test $rc)"; missing="${missing:+$missing and }whether it is a link" ;;
        esac
        # mdls's output, each line as shown_path shows a path. It looks the path up again, by itself.
        spot=$(as_user /usr/bin/mdls -name kMDItemContentType -name kMDItemFSName -name kMDItemFSSize -name kMDItemFSCreationDate -name kMDItemFSContentChangeDate "$wb" 2>/dev/null \
                | shown_lines; exit "${PIPESTATUS[0]}"); mrc=$?
        [ "$mrc" -eq 0 ] || { spot="Spotlight facts: not read: $(ended_said mdls $mrc)"; missing="${missing:+$missing and }its Spotlight facts"; }
        [ -n "$link" ] && link="$link"$'\n'
        if printf '%s\n\n%s\nPath: %s\n%s\n%s\n%s\n' "# Workbook metadata (the workbook itself was not copied)" "$facts" "$shown" "$link" "$spot" \
            "The dates and size are from stat, and the Spotlight facts from mdls: each looked the path up by itself." | put "$C/.workbook_metadata.part" \
            && mv -f "$C/.workbook_metadata.part" "$C/workbook_metadata.txt" 2>/dev/null; then :
        else
            rm -f "$C/.workbook_metadata.part"; unwritten "case/workbook_metadata.txt"
        fi
        [ -n "$missing" ] && STEP_WHY="${STEP_WHY}$missing were not read; "
        row "workbook_metadata" "metadata only; workbook not copied"
    elif [ $rc -ne 1 ]; then
        echo "Workbook not looked at: whether a plain file is at this path was not answered ($(ended_said test $rc)): $shown" | put "$C/workbook_metadata.txt" \
            || unwritten "case/workbook_metadata.txt"
        record_status "workbook_metadata" "skipped" "whether a plain file is at the path was not answered: $(ended_said test $rc)"
    else
        # test -f answers no for a path where nothing is, for one that is not a plain file, and for one it cannot
        # reach (a folder on the way that cannot be searched, say): which of them is not known
        echo "Workbook not looked at: test -f, run with $(rights_said), found no plain file at this path: $shown" | put "$C/workbook_metadata.txt" \
            || unwritten "case/workbook_metadata.txt"
        record_status "workbook_metadata" "skipped" "test -f found no plain file at the path with $(rights_said)"
    fi
}

# The same with a time limit: a workbook on a volume that no longer answers must not hold the run up, and that it
# did not answer is itself something this run saw.
workbook_facts() {
    [ -n "$WORKBOOK" ] || return 0
    # As root each read of it is a helper of its own with a time limit (as_user), which ends that helper and the
    # program that ran it. run_limited would end only this shell's copy of the step, and leave them running.
    if [ "$AM_ROOT" -eq 1 ] && [ "$USER_UID" != 0 ]; then
        AS_LIMIT=10 AS_KEEP_OPEN=1 AS_WHAT="reading the workbook's facts" collect_workbook_metadata
        return 0
    fi
    run_limited 20 collect_workbook_metadata

    if [ $? -eq 124 ]; then
        rm -f "$OUT/case/.workbook_metadata.part"
        # The 20 seconds are for all of its reads together (test, stat, readlink, mdls): which one was being read is
        # not known here
        record_status "workbook_metadata" "failed" "the reads of the workbook's facts were stopped after 20 seconds"
        note "  workbook facts: the reads were stopped after 20 seconds"
    fi
}

collect_unified() {
    local U="$OUT/unified_logs" i day next st ok=0 cut=0 limit=0 failed=0 unlabelled=0 unwritten_days=0 lost=0
    step_begin
    UNIFIED_DAYS=0          # the days whose search was started, for summary.md
    mkdir -p "$U"
    # What the search takes is said by the predicate's own parts (PRED_ALL)
    note "Unified logs, $SINCE through $UNTIL: the entries of processes named $EXCEL_PROC and of programs inside a folder named $EXCEL_PROC.app, messages that hold $EXCEL_NAME (in any case; RunningBoard's state dumps apart), the entries of /usr/sbin/spindump and of processes named Microsoft Error Reporting, Microsoft AutoUpdate or Microsoft Update Assistant, the previous shutdown cause and memory messages of the kernel (process ID 0, or the program /kernel), the jetsam messages of /System/Library/CoreServices/ReportCrash and /System/Library/CoreServices/osanalyticshelper, and messages that hold No space left on device"
    # The access check is a search of the last minute: when it ends with an error, no day is searched
    /usr/bin/log show --last 1m --predicate 'process == "kernel"' > /dev/null 2> "$U/access_check.txt"; st=$?
    if [ $st -ne 0 ]; then
        note "  the access check (log show of the last minute) ended with status $st: $(head -1 "$U/access_check.txt")"
        [ "$AM_ROOT" -eq 0 ] && note "  this run is not root (with sudo, or under Jamf, the script runs as root)"
        echo "Date | Status" > "$U/collection_status.txt"
        echo "access check | skipped: log show of the last minute ended with status $st; no day was searched" >> "$U/collection_status.txt"
        record_status "unified_logs" "skipped" "the access check (log show of the last minute) ended with status $st, so no day was searched; see unified_logs/access_check.txt"
        return
    fi
    rm -f "$U/access_check.txt"
    echo "Date | Status" 2>/dev/null > "$U/collection_status.txt" || { echo > /dev/null; lost=1; }
    i=0
    while [ $i -lt "$DAYS" ]; do
        day=$(date -j -v+"$i"d -f '%Y-%m-%d' "$SINCE" '+%Y-%m-%d')
        next=$(date -j -v+1d -f '%Y-%m-%d' "$day" '+%Y-%m-%d')
        note "  $day: collecting ($([ "$MAX_WAIT" -eq 0 ] && echo "no time limit" || echo "up to $MAX_WAIT min"))"
        # log show's messages and the labeller's go into the day's errors file; the rows are written by put, which
        # reads on when they cannot be written, so that log show is never stopped by a pipe that closed
        : 2>/dev/null > "$U/$day.errors.txt"
        UNIFIED_DAYS=$((UNIFIED_DAYS + 1))
        # The day being searched, for the interrupt handling (see stopped_rows): set until its line is written
        UNIFIED_DAY_NOW=$day
        run_limited "$QUERY_TIMEOUT" /usr/bin/log show --start "$day 00:00:00" --end "$next 00:00:00" \
            --style ndjson --info --debug --predicate "$PRED_ALL" 2>> "$U/$day.errors.txt" | capped $((UNIFIED_SEARCH_GB * 1073741824)) \
            | label_entries 2>> "$U/$day.errors.txt" | put "$U/$day.$LOG_EXT"
        st=("${PIPESTATUS[@]}")
        [ -s "$U/$day.errors.txt" ] || rm -f "$U/$day.errors.txt"
        search_said "${st[0]}" "${st[1]}" "${st[2]}" "${st[3]}" "$U/$day.$LOG_EXT" "$U/$day.errors.txt"
        case $SEARCH_KIND in
            ok) ok=$((ok + 1)) ;;
            cut) cut=$((cut + 1)) ;;
            limit) limit=$((limit + 1)) ;;
            error) failed=$((failed + 1)) ;;
            unlabelled) unlabelled=$((unlabelled + 1)) ;;
            unwritten) unwritten_days=$((unwritten_days + 1)); WRITES_LOST=$((WRITES_LOST + 1)) ;;
        esac
        UNIFIED_DAY_NOW=""
        echo "$day | $SEARCH_SAID" 2>/dev/null >> "$U/collection_status.txt" || { echo > /dev/null; lost=1; }
        note "  $day: $SEARCH_SAID"
        i=$((i + 1))
    done
    [ "$lost" -eq 1 ] && unwritten "unified_logs/collection_status.txt"
    # The days are counted by what came of them
    [ "$cut" -gt 0 ] && STEP_WHY="${STEP_WHY}$cut day(s) cut once $UNIFIED_SEARCH_GB GB of the search had arrived; "
    [ "$limit" -gt 0 ] && STEP_WHY="${STEP_WHY}$limit day(s) stopped at the $MAX_WAIT-minute limit, with what was found by then kept; "
    [ "$failed" -gt 0 ] && STEP_WHY="${STEP_WHY}$failed day(s) where log show ended with an error; "
    [ "$unlabelled" -gt 0 ] && STEP_WHY="${STEP_WHY}$unlabelled day(s) whose entries were not all labelled; "
    [ "$unwritten_days" -gt 0 ] && STEP_WHY="${STEP_WHY}$unwritten_days day(s) whose entries could not all be written into the working folder; "
    row unified_logs "$DAYS day(s), $SINCE through $UNTIL, $ok of them searched to the end and written; see unified_logs/collection_status.txt"
    if [ "$ARCHIVE" -eq 1 ]; then
        note "Unfiltered unified-log archive from $SINCE through now (this can take several minutes and be very large)"
        step_begin
        if /usr/bin/log collect --start "$SINCE 00:00:00" --output "$U/system_logs_from_${SINCE}.logarchive" >> "$LOG" 2>&1; then
            row "log_archive" "unfiltered, from $SINCE through collection"
        else
            note "  log collect failed (see collection.log)"
            record_status "log_archive" "failed" "see collection.log"
        fi
    fi
}

mode_collect() {
    note "Excel diagnostics: collect ($SINCE through $UNTIL) for user $CONSOLE_USER"
    workbook_facts                                 # first, so that a run that is stopped has them
    # Each step begins its own counts and writes its own row (see row)
    collect_system
    collect_office
    discover_sources
    collect_reports
    collect_unified
    write_source_catalog
}

# run_noted SECONDS WHAT FILE COMMAND... - run COMMAND with run_limited, its output (and its messages) written into
# FILE in the bundle by put; how it ended is said, and counted for the step's row, when it did not end with 0
run_noted() {
    local secs=$1 what=$2 file=$3 st; shift 3
    run_limited "$secs" "$@" 2>&1 | put "$OUT/$file"
    st=("${PIPESTATUS[@]}")
    [ "${st[1]}" -eq 0 ] || unwritten "$file"
    case ${st[0]} in
        0) ;;
        124) note "  $what was stopped at its $secs-second limit (see $file)"; STEP_WHY="${STEP_WHY}$what was stopped at its $secs-second limit; " ;;
        *) note "  $what ended with status ${st[0]} (see $file)"; STEP_WHY="${STEP_WHY}$what ended with status ${st[0]}; " ;;
    esac
}

mode_hang() {
    local pid rc st keep xrc
    step_begin
    note "Excel diagnostics: hang capture at $(date) / $(date -u '+%H:%M:%S UTC')"
    # xrc keeps how the look for Excel ended, for the row at the end: rc is used again below
    first_excel; xrc=$?; rc=$xrc; pid=$EXCEL_PID
    if [ -z "$pid" ]; then
        if [ "$rc" -eq 0 ]; then
            note "No process of $CONSOLE_USER's runs $EXCEL_EXE (asked of lsof): no spindump or sample, footprint or list of open files of one is made."
        else
            note "Whether $(excel_said) is running is not known ($EXCEL_CHECK_SAID): no spindump or sample, footprint or list of open files of one is made."
            STEP_WHY="${STEP_WHY}whether Excel was running is not known: $EXCEL_CHECK_SAID; "
        fi
        # The line the menu and the help promise, here too: nothing is asked of any process as Excel's from here on
        note "Nothing is asked of any Excel process in this run: Excel can be force-quit now (Option-Command-Esc). The capture goes on with Excel's logs and the unified log."
    else
        note "PID $pid runs $EXCEL_EXE (asked of lsof). Leave Excel as it is until a line here says that it can be force-quit."
        {
            echo "PID $pid runs $EXCEL_EXE (asked of lsof)."
            ps -o pid,etime,%cpu,rss,stat -p "$pid"
            echo "Arguments, as ps gives them:"
            excel_args "$pid"
            echo "--- top (MEM = physical footprint)"
            top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,threads,state 2>/dev/null | tail -2
        } 2>&1 | put "$OUT/excel_state.txt" || unwritten "excel_state.txt"
    fi
    snapshot_memory "$OUT/system_memory.txt" || unwritten "system_memory.txt"

    # Each of these is run on PID only after it was asked again whether PID still runs Excel as the console user
    if [ -n "$pid" ]; then
        if [ "$(id -u)" -eq 0 ]; then
            if still_excel "$pid" spindump; then
                note "Spindump of PID $pid, sampling for 10 seconds"
                run_limited 120 spindump "$pid" 10 10 -o "$OUT/excel_spindump.txt" -timelimit 100 >> "$LOG" 2>&1; rc=$?
                case $rc in
                    0) ;;
                    124) note "  spindump was stopped at its 120-second limit"; STEP_WHY="${STEP_WHY}spindump was stopped at its 120-second limit; " ;;
                    *) note "  spindump ended with status $rc (what it printed is in collection.log)"; STEP_WHY="${STEP_WHY}spindump ended with status $rc; " ;;
                esac
            fi
        elif still_excel "$pid" sample; then
            note "Not running as root; using sample instead of spindump on PID $pid, sampling for 10 seconds"
            run_limited 60 sample "$pid" 10 -file "$OUT/excel_sample.txt" >> "$LOG" 2>&1; rc=$?
            case $rc in
                0) ;;
                124) note "  sample was stopped at its 60-second limit"; STEP_WHY="${STEP_WHY}sample was stopped at its 60-second limit; " ;;
                *) note "  sample ended with status $rc (what it printed is in collection.log)"; STEP_WHY="${STEP_WHY}sample ended with status $rc; " ;;
            esac
        fi
        note "Memory footprint, open files and connections of PID $pid"
        still_excel "$pid" footprint && run_noted 60 footprint excel_footprint.txt footprint -p "$pid"
        still_excel "$pid" lsof && run_noted 30 lsof excel_open_files.txt lsof -n -P -p "$pid"
        # Said as soon as nothing more is asked of the process: what follows reads files and logs only
        note "Nothing more is asked of PID $pid in this run: Excel can be force-quit now (Option-Command-Esc). The capture goes on with Excel's logs and the unified log."
    fi

    note "Copying Excel's logs"
    copy_dir "$XL/Library/Logs" "$OUT/excel_container_logs"
    # The two steps below have rows of their own: what this one has counted so far is kept aside
    keep=("$UNANSWERED" "$OWN_UNANSWERED" "$UNREAD" "$UNWRITTEN" "$STEP_WHY" "$UNWALKED")
    workbook_facts                                 # after what cannot wait, before the search that can take minutes
    note "Unified log, last 30 minutes"
    # This row is decided by this search alone: the viewer takes "unified_last30m complete" to mean that the half
    # hour before the capture was searched
    step_begin
    if /usr/bin/log show --last 1m --predicate 'process == "kernel"' > /dev/null 2> "$OUT/unified_access_check.txt"; then
        rm -f "$OUT/unified_access_check.txt"
        : 2>/dev/null > "$OUT/unified_last30m.errors.txt"
        # Set until the search's row is written, for the interrupt handling (see stopped_rows)
        HANG_SEARCH_NOW=1
        run_limited "$QUERY_TIMEOUT" /usr/bin/log show --last 30m --style ndjson --info --debug --predicate "$PRED_ALL" \
            2>> "$OUT/unified_last30m.errors.txt" | capped $((UNIFIED_SEARCH_GB * 1073741824)) \
            | label_entries 2>> "$OUT/unified_last30m.errors.txt" | put "$OUT/unified_last30m.$LOG_EXT"
        st=("${PIPESTATUS[@]}")
        [ -s "$OUT/unified_last30m.errors.txt" ] || rm -f "$OUT/unified_last30m.errors.txt"
        search_said "${st[0]}" "${st[1]}" "${st[2]}" "${st[3]}" "$OUT/unified_last30m.$LOG_EXT" "$OUT/unified_last30m.errors.txt" "that half hour"
        note "  $SEARCH_SAID"
        HANG_SEARCH_NOW=""
        if [ "$SEARCH_KIND" = ok ]; then
            row "unified_last30m" "hang capture, $(count_entries "$OUT/unified_last30m.$LOG_EXT") entries"
        else
            [ "$SEARCH_KIND" = unwritten ] && WRITES_LOST=$((WRITES_LOST + 1))
            STEP_WHY="$SEARCH_SAID; "
            row "unified_last30m" "hang capture"
        fi
    else
        note "  unified log skipped: the access check (log show of the last minute) ended with an error: $(head -1 "$OUT/unified_access_check.txt")"
        record_status "unified_last30m" "skipped" "the access check (log show of the last minute) ended with an error; see unified_access_check.txt"
    fi
    UNANSWERED=${keep[0]}; OWN_UNANSWERED=${keep[1]}; UNREAD=${keep[2]}; UNWRITTEN=${keep[3]}; STEP_WHY=${keep[4]}; UNWALKED=${keep[5]}
    { pmset -g assertions; echo; scutil --nwi; } 2>&1 | put "$OUT/power_network.txt" || unwritten "power_network.txt"
    note "Hang capture complete."
    if [ -n "$pid" ]; then
        row "hang_capture" "PID $pid, which ran $EXCEL_EXE" home
    elif [ "$xrc" -eq 0 ]; then
        row "hang_capture" "no process of the console user's ran $EXCEL_EXE (asked of lsof)" home
    else
        row "hang_capture" "whether a process of the console user's ran $EXCEL_EXE is not known" home
    fi
}

capture_repro_snapshot() {
    local label=$1 D="$OUT/repro/$1" pid
    step_begin
    mkdir -p "$D"
    snapshot_memory "$D/system_memory.txt" || unwritten "repro/$label/system_memory.txt"
    snapshot_excel_memory "$D"
    copy_dir "$XL/Library/Logs" "$D/excel_container_logs"
    copy_dir "$OFFICE_GC/Logs" "$D/office_group_logs"
    first_excel; pid=$EXCEL_PID
    [ -n "$pid" ] && still_excel "$pid" lsof && run_noted 30 lsof "repro/$label/excel_open_files.txt" lsof -n -P -p "$pid"
    row "repro_$label" "Excel and system snapshot" home
}

# repro_stop - stops the live log stream and the watch beside the script, and waits until both have ended. It is
# called every time repro_finish is (the interrupt handling calls that too, also while repro_finish is running), and
# does only what is left: an interrupt can come at any point, and neither may be left running. A shell that was
# started and not yet written down when the interrupt came is the last one started ($!). How the stream stood before
# anything was sent to it is looked at once: its shell writes its statuses when it ends.
repro_stop() {
    local R="$OUT/repro" n=0 d
    if [ -n "$REPRO_WATCH_STARTED" ] && [ -z "$REPRO_WATCH_PID" ] && [ "$!" != "$REPRO_LOG_PID" ]; then REPRO_WATCH_PID=$!; fi
    if [ -n "$REPRO_STREAM_STARTED" ] && [ -z "$REPRO_LOG_PID" ] && [ "$!" != "$REPRO_BEFORE" ]; then REPRO_LOG_PID=$!; fi
    if [ -z "$REPRO_SEEN" ]; then
        REPRO_SEEN=1
        [ -s "$R/.stream_end" ] && REPRO_ENDED_FIRST=1
    fi
    # log stream itself is told to stop, once; the labeller then finishes the rows it has and ends. When there is no
    # such process any more, it had ended before it was told.
    if [ -n "$REPRO_LOG_PID" ] && [ -z "$REPRO_SENT" ] && [ -s "$R/.stream_pid" ]; then
        REPRO_SENT=1
        kill "$(cat "$R/.stream_pid")" 2>/dev/null || REPRO_ENDED_FIRST=1
    fi
    if [ -z "$REPRO_SAID" ] && [ -n "$REPRO_LOG_PID$REPRO_WATCH_PID" ]; then
        REPRO_SAID=1
        note "Stopping the live capture; then the last snapshot, and what collect gathers apart from past days' unified logs"
    fi
    # The watch ends at its next step (its TERM trap), and ends with how many of its writes failed (see watch_row).
    # What it is running then, its wait or a look at Excel, is in a process group of its own (see run_limited), which
    # is stopped here, again until the watch has ended: a group can be written down a moment after a look.
    if [ -n "$REPRO_WATCH_PID" ] && [ -z "$REPRO_WATCH_END" ]; then
        kill -TERM "$REPRO_WATCH_PID" 2>/dev/null
        while kill -0 "$REPRO_WATCH_PID" 2>/dev/null; do stop_groups; /bin/sleep 0.2; done
        wait "$REPRO_WATCH_PID" 2>/dev/null; REPRO_WATCH_END=$?
        stop_groups
        case "$REPRO_WATCH_END" in
            3[2-9]) d=$((REPRO_WATCH_END - 32)); WRITES_LOST=$((WRITES_LOST + d % 4)); ROWS_LOST=$((ROWS_LOST + d / 4)) ;;
        esac
    fi
    # The stream, until its shell has ended. log stream may not have been started yet when this began, or its process
    # not yet written down; when that cannot be written down at all, what the stream's shell started is told to stop.
    if [ -n "$REPRO_LOG_PID" ] && [ -z "$REPRO_STREAM_DONE" ]; then
        while kill -0 "$REPRO_LOG_PID" 2>/dev/null; do
            if [ -z "$REPRO_SENT" ] && [ -s "$R/.stream_pid" ]; then REPRO_SENT=1; kill "$(cat "$R/.stream_pid")" 2>/dev/null || REPRO_ENDED_FIRST=1
            elif [ -z "$REPRO_SENT" ] && [ "$n" -ge 10 ]; then pkill -TERM -P "$REPRO_LOG_PID" 2>/dev/null; fi
            n=$((n + 1)); /bin/sleep 0.1
        done
        wait "$REPRO_LOG_PID" 2>/dev/null
        REPRO_STREAM_DONE=1
    fi
    return 0
}

repro_finish() {
    local R="$OUT/repro" st why="" lost=0 hup
    repro_stop
    if [ -n "$REPRO_FINISHED" ]; then
        # The interrupt handling, while the steps below ran or before the row was written (repro_finish was called by
        # mode_repro when the stream had ended or its hours were up): the row is written now, as that of a run stopped
        # before the end of repro
        [ -n "$IN_TRAP" ] && repro_row "the run was stopped before the end of repro, where this row is written; $REPRO_WHY"
        return 0
    fi
    # How the stream ended: log stream, the cut at REPRO_STREAM_GB, the labeller, and the writing of its rows, each
    # by its status. The files are removed only once that has been worked out: an interrupt before then works it out
    # again from them.
    st=$(cat "$R/.stream_end" 2>/dev/null)
    hup=0; [ -e "$R/.stream_hup" ] && hup=1
    set -f; set -- $st; set +f
    case "${1-}${2-}${3-}${4-}" in ''|*[!0123456789]*) set -- ;; esac
    if [ -z "$REPRO_LOG_PID" ] && [ -n "$IN_TRAP" ]; then
        why="the live log stream was not started: the run was stopped before it was"
        REPRO_STREAM_SAID="not started: the run was stopped before the stream was"
    elif [ -z "$REPRO_LOG_PID" ]; then
        why="the live log stream was not started"
        REPRO_STREAM_SAID="not started"
    elif [ "$hup" -eq 1 ]; then
        # The stream's shell writes that down only after its programs have ended, so when the hangup came, before this
        # script stopped the stream or while it did, is not known
        why="a hangup signal reached the shell that ran the live log stream, before or while this script stopped the stream, so how the stream's programs ended, and whether all of what log stream sent was written, is not known"
        REPRO_STREAM_SAID="captured during the reproduction until a hangup signal reached the stream (see repro in manifest.tsv)"
    elif [ $# -ne 4 ]; then
        why="how the live log stream ended is not known: the file its shell writes that into holds no statuses"
        REPRO_STREAM_SAID="captured during the reproduction; how the stream ended is not known (see repro in manifest.tsv)"
    else
        if [ -n "$REPRO_ENDED_FIRST" ]; then
            why="the live log stream had ended before this script stopped it (log stream status $1, labeller status $3)"
            # Without perl, log stream runs in this script's process group, which the terminal's Ctrl-C reaches
            [ -z "$REPRO_OWN_GROUP" ] && why="$why; log stream ran where the terminal's Ctrl-C reaches it, because perl, which starts it apart, is missing"
        fi
        # capped: 3 is the cut, 4 a write into the labeller's pipe that failed, and any other but 0 its own program's end
        case $2 in
            0) ;;
            3) why="${why:+$why; }the live log stream was cut once $REPRO_STREAM_GB GB of it had arrived; what came after that was not kept" ;;
            4) [ "$3" -eq 0 ] && why="${why:+$why; }the labeller of the live log stream stopped reading before the end of what log stream sent" ;;
            *) why="${why:+$why; }the program that passes the live log stream on to the labeller ended with status $2" ;;
        esac
        [ "$3" -ne 0 ] && [ -z "$REPRO_ENDED_FIRST" ] && why="${why:+$why; }the labeller of the live log stream ended with status $3"
        [ "$4" -ne 0 ] && { lost=1; why="${why:+$why; }the live log stream's rows could not all be written into the working folder"; }
        if [ -z "$why" ]; then REPRO_STREAM_SAID="captured from when the stream was started until this script stopped it"
        elif [ -n "$REPRO_ENDED_FIRST" ]; then REPRO_STREAM_SAID="captured from when the stream was started until it ended, before this script stopped it (see repro in manifest.tsv)"
        else REPRO_STREAM_SAID="captured during the reproduction, not all of it (see repro in manifest.tsv)"; fi
    fi
    REPRO_WHY=${why:+$why; }
    REPRO_FINISHED=1
    rm -f "$R/.stream_pid" "$R/.stream_end" "$R/.stream_hup"
    [ -s "$R/unified_live_errors.txt" ] || rm -f "$R/unified_live_errors.txt"
    [ -n "$why" ] && note "  $why"
    [ "$lost" -eq 1 ] && WRITES_LOST=$((WRITES_LOST + 1))
    capture_repro_snapshot final
    # Everything collect gathers except past days' unified logs, which the live stream replaces. This
    # also picks up crash reports and Microsoft error-reporting files the crash just wrote. Each step writes its row.
    collect_system
    collect_office
    discover_sources
    collect_reports
    workbook_facts                                 # here, after the reproduction, and not at the start
    write_source_catalog
    repro_row "$REPRO_WHY"
}
# repro_row WHY - the repro row, written once, with WHY (each part ended with "; ") as why it is not complete. The
# stream's file is named only when it is there.
repro_row() {
    local details
    [ -z "$REPRO_ROW_DONE" ] || return 0
    REPRO_ROW_DONE=1
    step_begin
    STEP_WHY=$1
    if [ -f "$OUT/repro/unified_live_unfiltered.$LOG_EXT" ]; then details="live unified-log stream (repro/unified_live_unfiltered.$LOG_EXT)"
    else details="live unified-log stream (the bundle holds no file of it)"; fi
    row "repro" "$details"
}

mode_repro() {
    local R="$OUT/repro" end=0
    mkdir -p "$R"
    # The person is asked to reproduce the problem only once the live stream has been started: what happens before
    # that is not in the stream
    note "Reproduction capture is starting: a first snapshot, then the live log stream. Do not reproduce the problem yet."
    capture_repro_snapshot baseline
    note "Starting unfiltered live unified-log stream at debug level"
    # The stream runs beside this shell, in a shell of its own, which writes down how each of its programs ended
    # when it ends: log stream, capped, the labeller, and put, which writes the rows and reads on when it cannot.
    # Any process can add entries to the stream, as many as it likes: capped cuts it once REPRO_STREAM_GB GB of it
    # have arrived, before it is labelled, and the repro row says so.
    # log stream is started in a process group of its own (perl's setpgrp), which the terminal's signals do not
    # reach: it ends on SIGINT even though the shell starts it with SIGINT ignored, so the Ctrl-C that ends the
    # reproduction would end it before this script stops it. Its group is not written down for stop_groups, which
    # the interrupt handling runs before repro_finish: repro_stop stops log stream itself.
    # A hangup (the Terminal window closing, say) still reaches the stream's shell and its other programs, which are
    # in this script's group: the stream's shell writes that down, so that how it ended is not taken for anything
    # else. The statuses it writes afterwards are then not its programs' (the trap ran in between).
    : 2>/dev/null > "$R/unified_live_errors.txt"
    local apart=()
    [ "$HAVE_PERL" -eq 1 ] && { apart=("${PERL_CMD[@]}" -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127' --); REPRO_OWN_GROUP=1; }
    # Set before the shell is started: an interrupt can come between the start and the line after it (see repro_stop)
    REPRO_BEFORE=$!; REPRO_STREAM_STARTED=1
    ( trap ': 2>/dev/null > "$R/.stream_hup"' HUP
      ${apart[@]+"${apart[@]}"} /bin/sh -c 'echo $$ > "$1"; exec /usr/bin/log stream --style ndjson --level debug' sh "$R/.stream_pid" 2>> "$R/unified_live_errors.txt" \
          | capped $((REPRO_STREAM_GB * 1073741824)) | label_entries 2>> "$R/unified_live_errors.txt" | put "$R/unified_live_unfiltered.$LOG_EXT"
      echo "${PIPESTATUS[*]}" > "$R/.stream_end" ) &
    REPRO_LOG_PID=$!; [ "$REPRO_LOG_PID" = "$REPRO_BEFORE" ] && REPRO_LOG_PID=""      # not started: $! is as it was
    # The watch ends at its next step when it is told to (repro_stop), with its row written (see watch_row)
    REPRO_WATCH_STARTED=1
    ( WATCH_END=32; trap 'watch_row; exit "$WATCH_END"' TERM; mode_watch; exit "$WATCH_END" ) &
    REPRO_WATCH_PID=$!
    note "The live log stream and the memory timeline have been started. Reproduce the problem now, wait 30 seconds after it happens, then press Ctrl-C here."
    [ "$HOURS" -gt 0 ] && end=$(( $(date +%s) + HOURS * 3600 ))
    while kill -0 "$REPRO_LOG_PID" 2>/dev/null; do
        [ "$end" -gt 0 ] && [ "$(date +%s)" -ge "$end" ] && break
        sleep 2
    done
    repro_finish
}

mode_watch() {
    local csv="$OUT/excel_memory_timeline.csv" end=0 w_n=0 last_pid="" last_level="" pid row cpu mem cmp th level free cmpr swap now w_lost=0 w_snaps=0
    local known w_unknown=0 seen=0
    step_begin
    # The row is written by watch_row, once: after the loop, or when the watch is stopped
    WATCH_W0=$WRITES_LOST; WATCH_R0=$ROWS_LOST; WATCH_LIVE=1
    # A line that cannot be written is counted, and dropped: bash would otherwise keep it, and write it out with
    # whatever this shell writes next. The first one is said at once, and how many there were in the watch row.
    echo "local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb" 2>/dev/null > "$csv" \
        || { echo > /dev/null; w_lost=$((w_lost + 1)); unwritten "excel_memory_timeline.csv"; }
    local pagemb
    pagemb=$(vm_stat | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) print $i / 1048576 }')
    [ "$HOURS" -gt 0 ] && end=$(( $(date +%s) + HOURS * 3600 ))
    note "Excel diagnostics: watch, with a wait of ${INTERVAL}s between samples$([ "$HOURS" -gt 0 ] && echo ", for $HOURS hour(s)"). Press Ctrl-C to stop."
    note "Timeline: $csv"
    while :; do
        # Excel is a process of the console user's that runs EXCEL_EXE (see excel_pids). When that is not answered,
        # the row has no process id, and no change is said.
        known=1; first_excel || { known=0; w_unknown=$((w_unknown + 1)); note "Whether $(excel_said) is running is not known at this sample ($EXCEL_CHECK_SAID)"; }
        pid=$EXCEL_PID
        cpu=""; mem=""; cmp=""; th=""
        if [ -n "$pid" ]; then
            row=$(top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,threads 2>/dev/null | tail -1)
            set -- $row
            if [ "$1" = "$pid" ]; then cpu=$2; mem=$(to_mb "$3"); cmp=$(to_mb "$4"); th=${5%%/*}; fi
        fi
        if [ "$known" -eq 1 ] && [ "$pid" != "$last_pid" ] && [ "$seen" -gt 0 ]; then
            # The lowest process id is the one followed: a change says which ids were seen, not what became of them
            if [ -z "$pid" ]; then note "No process of $CONSOLE_USER's runs $EXCEL_EXE at this sample; PID $last_pid did at the last sample before at which this was answered (asked of lsof)"
            elif [ -z "$last_pid" ]; then note "PID $pid runs $EXCEL_EXE as $CONSOLE_USER; none did at the last sample before at which this was answered (asked of lsof)"
            else note "The lowest process ID of $CONSOLE_USER's processes that run $EXCEL_EXE is $pid at this sample, and was $last_pid at the last sample before at which this was answered (asked of lsof)"; fi
        fi
        level=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
        free=$(vm_stat | awk -v p="$pagemb" '/^Pages free/ { gsub(/\./, "", $3); printf "%.0f", $3 * p }')
        cmpr=$(vm_stat | awk -v p="$pagemb" '/occupied by compressor/ { gsub(/\./, "", $5); printf "%.0f", $5 * p }')
        swap=$(to_mb "$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}')")
        now=$(date +%s)
        echo "$(date -r "$now" '+%Y-%m-%d %H:%M:%S'),$(date -u -r "$now" '+%Y-%m-%d %H:%M:%S'),$pid,$cpu,$mem,$cmp,$th,$level,$free,$cmpr,$swap" 2>/dev/null >> "$csv" \
            || { echo > /dev/null; w_lost=$((w_lost + 1)); [ "$w_lost" -eq 1 ] && unwritten "excel_memory_timeline.csv"; }
        # Full process snapshot at the first sample, whenever the pressure level changes, and at every
        # (600 / INTERVAL + 1)th sample after the first
        if [ "$level" != "$last_level" ] || [ $((w_n % (600 / INTERVAL + 1))) -eq 0 ]; then
            [ -n "$last_level" ] && [ "$level" != "$last_level" ] && note "Memory pressure level $last_level -> $level"
            snapshot_memory "$OUT/memory_snapshots.txt" || { w_snaps=$((w_snaps + 1)); [ "$w_snaps" -eq 1 ] && unwritten "memory_snapshots.txt"; }
        fi
        [ "$known" -eq 1 ] && { last_pid=$pid; seen=$((seen + 1)); }
        last_level=$level; w_n=$((w_n + 1))
        [ "$end" -gt 0 ] && [ "$(date +%s)" -ge "$end" ] && break
        # The wait is a program in a process group of its own (see run_limited), so that what stops the watch stops
        # it too: in repro the watch runs beside the script, and its wait would hold the screen open after the end
        run_limited 0 /bin/sleep "$INTERVAL"
    done
    watch_row
}
# watch_row - the watch's row, from mode_watch's counts, written once: at the end of its loop, or when the watch is
# stopped (by Ctrl-C and the like in watch mode, by repro_stop beside repro), from the interrupt handling, which runs
# inside mode_watch and so sees its counts. Nothing is done before mode_watch has begun. Sets WATCH_END, for a watch
# that runs beside repro in a shell of its own, whose counts the script does not see: 32, and how many times something
# could not all be written into the working folder, and 4 more when the row could not be written either.
watch_row() {
    [ -n "$WATCH_LIVE" ] || return 0
    local w=$((WRITES_LOST - WATCH_W0))
    [ "$w" -gt 3 ] && w=3
    WATCH_LIVE=""
    WATCH_END=$((32 + w))
    [ "$w_lost" -gt 0 ] && STEP_WHY="${STEP_WHY}$w_lost line(s) of excel_memory_timeline.csv could not be written into the working folder; "
    [ "$w_snaps" -gt 0 ] && STEP_WHY="${STEP_WHY}$w_snaps snapshot(s) could not all be written into memory_snapshots.txt; "
    [ "$w_unknown" -gt 0 ] && STEP_WHY="${STEP_WHY}at $w_unknown sample(s) whether Excel was running is not known (see collection.log); "
    row "watch" "$w_n sample(s), with a wait of ${INTERVAL}s between them"
    [ "$ROWS_LOST" -gt "$WATCH_R0" ] && WATCH_END=$((WATCH_END + 4))
    return 0
}
# stopped_rows - for the interrupt handling: what a search that was going on when the run was stopped would have
# written when it ended is written as that. The day of collect being searched gets its line in
# unified_logs/collection_status.txt, and hang's half hour its row, each saying that the run was stopped before how
# the search ended was written down, and how many entries its file holds.
stopped_rows() {
    local f n
    if [ -n "$UNIFIED_DAY_NOW" ]; then
        f="$OUT/unified_logs/$UNIFIED_DAY_NOW.$LOG_EXT"
        if [ -e "$f" ]; then n="$(count_entries "$f") entries are in its file"; else n="it has no file"; fi
        echo "$UNIFIED_DAY_NOW | stopped: the run was stopped before how this day's search ended was written down ($n)" 2>/dev/null >> "$OUT/unified_logs/collection_status.txt" \
            || { echo > /dev/null; unwritten "unified_logs/collection_status.txt"; }
        UNIFIED_DAY_NOW=""
    fi
    if [ -n "$HANG_SEARCH_NOW" ]; then
        HANG_SEARCH_NOW=""
        f="$OUT/unified_last30m.$LOG_EXT"
        if [ -e "$f" ]; then n="$(count_entries "$f") entries are in its file"; else n="it has no file"; fi
        record_status "unified_last30m" "incomplete" "hang capture; the run was stopped before how this search ended was written down ($n)"
    fi
    return 0
}

# --redact. The program below rewrites every plain-text file in the bundle, whatever its extension (crash
# reports and JSON logs included), replacing:
#   the console user's account name and home folder name, and any home folder name under /Users
#   the user's full name, however its parts are joined or ordered (Pat Lee, Lee, Pat, pat.lee)
#   this Mac's computer name and host names
#   its serial number, hardware UUID, provisioning UDID and the per-Mac keys in crash reports
#   email addresses, and the user part of a share or URL (smb://name@server/)
# A file that is not plain text cannot be rewritten or checked, so it is left out of the bundle, as is a
# symbolic link (its target is a path). A binary property list is first converted to text. Files and folders
# whose own names hold one of these are renamed. Every text file that remains is then read again, and
# redaction.txt records what was replaced, what was left as it is, what was left out and what was found again.
# Two kinds of name are left alone on purpose, and the result says so: an account name that only says what
# kind of account it is (admin, user), outside paths, and a computer name that is only its model name.
# It does not hide file or folder names, network addresses, or anything inside an Apple .logarchive.
# Exit status: 0 = done and the check found nothing; 3 = something remains or could not be handled; 5 = it was
# stopped at its time limit (RX_SECONDS); anything else = it stopped (on a full disk, for one). After 5 or any other
# status the bundle must not be taken as having names hidden: files may be partly rewritten.
IFS= read -r -d '' REDACT_PL <<'PERL'
use strict; use warnings;
use File::Find (); use Encode (); use Unicode::Normalize (); use Fcntl (); use POSIX (); use Time::HiRes ();


my $root = $ENV{RX_ROOT} // '';
$root =~ s{/+$}{};
die "redact: no bundle folder\n" unless length $root && -d $root;
my $report = "$root/redaction.txt";
# The whole step has a time limit (RX_SECONDS, none when not given). When it is reached the program ends there, with
# status 5, whatever it was doing: some files may have been rewritten by then and others not, and redaction.txt may
# not have been written. The collector then takes the bundle as having nothing hidden.
my $limit = $ENV{RX_SECONDS} // 0;
if ($limit =~ /^\d+$/ && $limit > 0) {
    $SIG{ALRM} = sub { print STDERR "stopped at the time limit of $limit seconds\n"; POSIX::_exit(5) };
    alarm $limit;
}

# A word may start after anything that is not a letter or digit, and also straight after an escape: the collector
# writes a line break inside a message as \n, JSON writes a curly apostrophe as \u2019, and URLs write a space as %20.
my $ESC = '(?:(?<=\\\\[nrtbf])|(?<=\\\\u[0-9A-Fa-f]{4})|(?<=%[0-9A-Fa-f]{2}))';
my $B0  = "(?:(?<![A-Za-z0-9])|$ESC)";
my $B1  = '(?![A-Za-z0-9])';
my $SL  = '(?:\\\\*/|%2[Ff])';                     # a slash as plain text, escaped once or twice for JSON (\/, \\/), or in a URL (%2F)
# What may sit between the parts of a name: a space, punctuation, a JSON or URL escape
my $GAP = '(?:%[0-9A-Fa-f]{2}|\\\\u[0-9A-Fa-f]{4}|\\\\.|[\xc2-\xf4][\x80-\xbf]{1,3}|[^A-Za-z0-9\x80-\xff\n])';
my $TOKENS = 'redacted-email redacted-user redacted-name redacted-computer redacted-serial redacted-hardware-uuid redacted-provisioning-udid redacted-device-key';
# Names that say what kind of account or computer this is and not whose, and words that are everywhere in paths.
# One of these is not replaced as a word: doing so would rewrite the logs without hiding anyone.
my %GENERIC = map { $_ => 1 } qw(admin administrator systemadministrator user users guest test tester root shared staff student
    teacher owner support helpdesk it office excel microsoft apple public local localhost home work default
    temp demo mac macuser macbook macbookpro macbookair imac macmini macstudio macpro mini studio server
    desktop laptop workstation computer pc library applications system volumes documents downloads private
    network finder);
# Endings that make something@name.ext a file or a label, not an address. None of them is a domain ending.
my %NOTMAIL = map { $_ => 1 } qw(xlsx xlsm xls xlsb xltx xlam xla csv txt pdf png jpg jpeg gif tiff heic plist log docx doc
    pptx ppt dylib framework bundle json xml html htm tmp bak ips crash diag sqlite icns nib strings lproj pkg dmg);
# Folders the collector itself makes. They keep their names whatever this Mac or its user is called: the viewer
# finds things by them.
my %OWN = map { $_ => 1 } qw(office reports system unified_logs case repro baseline final discovered home CrashReporter
    Library Library_Logs_DiagnosticReports Library_Logs_DiagnosticReports_Retired user_Library_Logs_DiagnosticReports
    user_Library_Logs_DiagnosticReports_Retired excel_container_logs office_group_logs user_microsoft_logs
    onedrive_container_logs error_reporting_logs Diagnostics EXCEL Logs Containers Documents);

sub chars {         # bytes -> characters
    my $b = shift;
    return $b if utf8::is_utf8($b);                 # characters already (a name part being looked at again)
    my $c = eval { Encode::decode('UTF-8', my $copy = $b, Encode::FB_CROAK) };
    defined $c ? $c : Encode::decode('ISO-8859-1', $b);
}
sub bytes { Encode::encode('UTF-8', shift) }
sub norm { my $c = lc chars(shift); $c =~ s/[^\p{L}\p{N}]+//g; bytes($c) }
sub generic { my $k = norm(shift); $k =~ s/\d+$//; !length $k || $GENERIC{$k} }      # an account such as admin2 is still admin
sub parts { grep { length } split /[^\p{L}\p{N}]+/, chars(shift) }
sub tok {           # one part of a name -> a pattern for every way its letters are likely to be written
    my $t = shift; my %v;
    my ($nfc, $nfd) = (Unicode::Normalize::NFC($t), Unicode::Normalize::NFD($t));
    for my $form ($nfc, $nfd) { $v{ bytes($_) } = 1 for $form, lc $form, uc $form, ucfirst lc $form }
    if ($t =~ /[^\x00-\x7f]/) {                     # accented letters: also without the accents, and as JSON and URLs escape them
        (my $plain = $nfd) =~ s/\p{Mn}+//g;
        $v{ bytes($plain) } = 1;
        for my $c ($nfc, lc $nfc, uc $nfc) {
            $v{ join '', map { ord($_) < 128 ? $_ : sprintf('\\u%04x', ord $_) } split //, $c } = 1;
            $v{ join '', map { ord($_) < 128 ? $_ : join('', map { sprintf '%%%02X', ord } split //, bytes($_)) } split //, $c } = 1;
        }
    }
    my @v = map { quotemeta } sort { length $b <=> length $a } keys %v;
    @v > 1 ? '(?:' . join('|', @v) . ')' : $v[0];
}
sub flex { my $min = shift; join "$GAP\{$min,3}", map { tok($_) } @_ }       # the parts of a name, with $min to 3 separators between them
sub need { my $t = shift; defined $t && $t =~ /^[\x21-\x7e]+$/ ? lc $t : undef }

# A rule is a pattern, what replaces it, text a line must hold for the pattern to be tried (to save time), and
# sometimes a test that a match has to pass
my (@rules, @notes, @except);
sub rule {
    my ($kind, $re, $to, @need) = @_;
    my $ok = @need && ref $need[-1] eq 'CODE' ? pop @need : undef;
    push @rules, { kind => $kind, re => $re, to => $to, ok => $ok, need => (@need && !grep { !defined } @need) ? [@need] : undef };
}

# Where an address or a name before an @ may start: where a run of the characters it is made of starts, after
# anything that cannot be part of one, but not on the letter of an escape (the n of \n); straight after an escape \n
# or \u2019, whose letters are of that kind; and straight after a word this program puts in, where that word starts
# such a run. Never in the middle of a run, after a %XX in it: a match tried from each of those would read the rest
# of the run again, and a run of them would take time that grows with the square of its length (a few lines of
# "%41%41..." would hold the step for hours). A match from where the run starts takes in all of it, so an address
# with %XX in it is replaced whole, however long it is.
my $A0 = "(?:(?<![A-Za-z0-9._%+\\-])(?!(?<=\\\\)(?:[nrtbf]|u[0-9A-Fa-f]{4}))|(?<=\\\\[nrtbf])|(?<=\\\\u[0-9A-Fa-f]{4})|"
    . join('|', map { "(?<=(?<![A-Za-z0-9._%+\\-])$_)" } split ' ', $TOKENS) . ')';
# The user part of a share or URL (smb://name@server/, //name:password@server/, name@server:path), leaving the server alone
rule('user', qr{//\K(?!redacted-)[^/@\s]+(?=@[A-Za-z0-9.\-]+[/:])}, 'redacted-user', '@');
rule('user', qr{$A0\K(?!redacted-)[A-Za-z0-9._%+\-]+(?=@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+:[A-Za-z0-9_\x7e/.])}, 'redacted-user', '@');
# Email addresses next, so that an account name inside one does not leave its domain behind. Not an address: a name
# that ends like a file (Budget@2026.xlsx, icon@2x.png, node@20.plist). A number after the @ does not rule one out.
rule('email', qr{$A0(?!redacted-)[A-Za-z0-9._%+\-]+(?:@|%40)[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9\-]|\.[A-Za-z0-9]|:[A-Za-z0-9_\x7e/.])},
    'redacted-email', '@', '%40', sub { my ($ext) = $_[0] =~ /\.([A-Za-z]+)$/; !$NOTMAIL{ lc $ext } });

my $user = $ENV{RX_USER} // '';
my $home = $ENV{RX_HOME} // '';
$home =~ s{/+$}{};

# The full name: its parts in order, and in any other order or with a middle part missing: "Pat Lee", "Lee, Pat",
# "pat.lee", "Pat de Lee" and "Pat Lee". Run together with nothing between ("patlee") only in their own order, and
# only when that makes six letters or more: "Ken To" must not take the word token. It goes before the computer
# name, so that a Mac named after a first name does not take half of it.
my @fn = parts($ENV{RX_FULL} // '');
if (@fn >= 2 && grep { !generic($_) } @fn) {
    my %p = (flex(length(join '', @fn) >= 6 ? 0 : 1, @fn) => 1);
    for my $k (1 .. $#fn) {
        $p{ flex(1, @fn[$k .. $#fn], @fn[0 .. $k - 1]) } = 1; $p{ flex(1, $fn[0], @fn[$k .. $#fn]) } = 1; $p{ flex(1, @fn[$k .. $#fn], $fn[0]) } = 1;
        next if length($fn[$k]) < 3;                 # the first name with any one other part, either way round
        $p{ flex(1, $fn[0], $fn[$k]) } = 1; $p{ flex(1, $fn[$k], $fn[0]) } = 1;
    }
    my $alt = join '|', sort { length $b <=> length $a } keys %p;
    rule('name', qr/$B0(?:$alt)$B1/i, 'redacted-name', (grep { !defined need($_) } @fn) ? undef : need($fn[0]));
} elsif (@fn == 1 && length($fn[0]) >= 4 && !generic($fn[0]) && norm($fn[0]) ne norm($user) && $TOKENS !~ /$B0@{[ tok($fn[0]) ]}$B1/i) {
    rule('name', qr/$B0@{[ tok($fn[0]) ]}$B1/i, 'redacted-name', need($fn[0]));
} elsif (@fn) {
    push @except, 'the full name was left as it is (it is made of common words, or is very short)' unless @fn == 1 && norm($fn[0]) eq norm($user);
} else {
    push @except, 'the full name is not known, so it was not looked for';
}

# This Mac's names, longest first. One that is only its model name, or another common word, also appears wherever
# the model is named, so it is left as it is and the report says so.
my %model = map { $_ => 1 } grep { length } map { (norm($_), norm((split /,/)[0])) } split /\n/, $ENV{RX_MODELS} // '';
my (%host, $hosts);
for my $h (sort { length $b <=> length $a } split /\n/, $ENV{RX_HOSTS} // '') {
    my @t = parts($h);
    next unless @t;
    $hosts++;
    my $k = norm($h); my $p = flex(0, @t);
    if (length($k) < 4 || $GENERIC{$k} || $model{$k} || $TOKENS =~ /$B0$p$B1/i) { $host{''}++; next }
    next if $host{ lc join "\0", @t }++;
    my $model = $k =~ /^(?:i?mac|xserve)/ ? '(?!,\d)' : '';       # a name like Mac14 is not taken from a model identifier (Mac14,7)
    rule('computer', qr/$B0$p$B1$model/i, 'redacted-computer', need($t[0]));
}
push @except, (keys %host == 1 ? "this Mac's name was" : "one of this Mac's names was") . ' left as it is (it is its model name, a common word or very short)' if $host{''};
push @except, "this Mac's name is not known, so it was not looked for" unless $hosts;

# The account name and the home folder's own name. A name of six letters or more is replaced wherever a word
# starts with it (patlee, patlee2, patleeBackup, userPatlee), but not from the middle of a longer word (porter in
# Reporter). A name of three to five letters is replaced only where it stands as a word of its own, which also takes
# ordinary uses of that word when the name is one (will, max): the report says so. A name that only says what kind
# of account it is (admin, user, guest), or is shorter than three letters, is replaced only as a folder name in a path.
my %names = map { $_ => 1 } grep { length } $user, ($home =~ m{([^/]+)$});
my $pathonly = 0;
for my $n (sort { length $b <=> length $a } keys %names) {
    my @t = parts($n);
    next unless @t;
    my $q = @t > 1 ? flex(0, @t) : quotemeta $n;
    rule('user', qr{Managed Preferences${SL}\K(?i:$q)(?![A-Za-z0-9])}, 'redacted-user', 'managed preferences');
    my $long = length(norm($n)) >= 6;
    # A name that is part of one of the replacement words themselves would be found again inside them
    if (generic($n) || length(norm($n)) < 3 || ($long ? $TOKENS =~ /$q/i : $TOKENS =~ /$B0$q$B1/i)) { $pathonly++; next }
    if ($long) { rule('user', qr/(?:(?<![A-Za-z])|$ESC|(?<=[a-z])(?=[A-Z]))(?i:$q)/, 'redacted-user', need($t[0])) }
    elsif (@t > 1) { rule('user', qr/$B0$q$B1/i, 'redacted-user', need($t[0])) }
    else {
        rule('user', qr/$B0$q$B1/i, 'redacted-user', need($n));
        push @notes, 'The account name is short, so every separate use of that word was replaced, whether or not it meant the account.';
    }
}
push @except, 'the account name only says what kind of account it is, or is very short, so it was replaced only as the folder name straight after /Users/ or Managed Preferences/' if $pathonly;
push @except, 'the account name is not known, so it was not looked for' unless length $user;

# Any home folder name under /Users, however the slashes are written, and this user's home folder if it is elsewhere.
# The name ends at a plain space: taking the next word too would swallow whatever follows a path that ends at a home
# folder. So the rest of another account's folder name, when it has a space written plainly, is left (and said so).
rule('user', qr{${SL}(?i:Users)${SL}\K(?!(?:(?i:Shared)|redacted-[a-z\-]+)(?![A-Za-z0-9]))(?:[^/\\\s"\x27<>|:;,)\]\}%&]|%20|\\ )+}, 'redacted-user', 'users');
if ($home =~ m{^(/.+)/([^/]+)$} && $home !~ m{^/Users/[^/]+$}) {
    my ($dir, $base) = ($1, $2);
    my @d = grep { length } split m{/}, $dir;
    my $p = join $SL, map { quotemeta } @d;
    rule('user', qr{${SL}$p${SL}\K\Q$base\E(?![A-Za-z0-9])}i, 'redacted-user', need($d[0])) unless generic($base) && generic($user);
}

(my $serial = $ENV{RX_SERIAL} // '') =~ s/\s+//g;
if (length($serial) >= 6) { rule('serial', qr/$B0\Q$serial\E$B1/i, 'redacted-serial', lc $serial) } else { push @except, 'the serial number is not known, so it was replaced only where a line is labelled as holding it' }
rule('serial', qr/Serial Number(?: \(system\))?:[ \t]*\K(?!redacted-)[A-Za-z0-9]{6,}/, 'redacted-serial', 'serial number');
rule('serial', qr/IOPlatformSerialNumber"?[ \t]*[=:][ \t]*"?\K(?!redacted-)[A-Za-z0-9]{6,}/, 'redacted-serial', 'ioplatformserialnumber');
for my $id (['RX_UUID', 'hardware-uuid', 'hardware UUID'], ['RX_UDID', 'provisioning-udid']) {
    (my $v = $ENV{ $id->[0] } // '') =~ s/\s+//g;
    if (length($v) >= 12) { rule('hardware', qr/\Q$v\E/i, "redacted-$id->[1]", lc $v) }
    elsif ($id->[2]) { push @except, "the $id->[2] is not known, so it was replaced only where a line is labelled as holding it" }
}
rule('hardware', qr/Hardware UUID:[ \t]*\K[0-9A-Fa-f\-]{8,}/, 'redacted-hardware-uuid', 'hardware uuid');
rule('hardware', qr/IOPlatformUUID"?[ \t]*[=:][ \t]*"?\K[0-9A-Fa-f\-]{8,}/, 'redacted-hardware-uuid', 'ioplatformuuid');
rule('hardware', qr/Provisioning UDID:[ \t]*\K[0-9A-Fa-f\-]{8,}/, 'redacted-provisioning-udid', 'provisioning udid');
# Two keys in crash reports that are the same in every report from one Mac
rule('hardware', qr/"crashReporterKey"[ \t]*:[ \t]*"\K(?!redacted-)[^"]+/, 'redacted-device-key', 'crashreporterkey');
rule('hardware', qr/"deviceIdentifierForVendor"[ \t]*:[ \t]*"\K(?!redacted-)[^"]+/, 'redacted-device-key', 'deviceidentifierforvendor');
rule('hardware', qr/(?:Anonymous UUID|Crash Reporter Key):[ \t]*\K[0-9A-Fa-f\-]{8,}/, 'redacted-device-key', 'anonymous uuid', 'crash reporter key');

our %count;
sub scrub {         # scrub(TEXT, COUNT_ONLY): replace in place, or only count; returns how many
    my $n = 0; my $lc;
    for my $r (@rules) {
        if ($r->{need}) { $lc //= lc $_[0]; next unless grep { index($lc, $_) >= 0 } @{ $r->{need} } }
        my $c = 0;
        if ($_[1]) { if ($r->{ok}) { while ($_[0] =~ /($r->{re})/g) { $c++ if $r->{ok}->($1) } } else { $c = () = $_[0] =~ /$r->{re}/g } }
        elsif ($r->{ok}) { $_[0] =~ s/($r->{re})/ $r->{ok}->($1) ? do { $c++; $r->{to} } : $1 /ge }
        else { $c = ($_[0] =~ s/$r->{re}/$r->{to}/g) || 0 }
        next unless $c;
        undef $lc unless $_[1];
        $count{ $r->{kind} } += $c; $n += $c;
    }
    $n;
}
sub shown { my $p = substr($_[0], length($root) + 1); { local %count; scrub($p) } $p }    # a path fit to print
sub commas { my $n = reverse shift; $n =~ s/(\d{3})(?=\d)/$1,/g; scalar reverse $n }

my (@files, @links, @archives, @problems, @unread, @leave, %out, @outlist, $outn, $outbytes, $read, $changed, $renamed, $converted);
$_ = 0 for $outn, $outbytes, $read, $changed, $renamed, $converted;
my %warned;
$SIG{__WARN__} = sub {                              # anything perl only warns about (a folder it cannot open) counts as a problem
    (my $m = shift) =~ s/ at \S+ line \d+.*//s;
    $m =~ s/\Q$root\E\/?//g; $m =~ s/\s+$//; { local %count; scrub($m) }
    return if $warned{$m}++;
    push @problems, $m;
    push @unread, "$1 (a folder that could not be opened)" if $m =~ /^Can't opendir\((.*?)\)/;
};
# On a large bundle this takes minutes. Say so now and then, on the screen and not in the result: fd 3, when the
# collector has opened it.
my ($tick, $done, $all, $doing, $screen) = (time, 0, 0, 'hiding names');
open($screen, '>&=', 3) or undef $screen if $ENV{RX_PROGRESS};
sub progress {
    return unless $screen && time - $tick >= 15;
    $tick = time;
    syswrite $screen, sprintf("  still %s: %.0f of %.0f MB read\n", $doing, $done / 1048576, $all / 1048576);
}

sub kind {          # text, binary, utf16, bplist, empty or unreadable, judged from the first 256 KB
    my $f = shift;
    return 'empty' if -z $f;
    open my $h, '<:raw', $f or return 'unreadable';
    read $h, my $buf, 262144; close $h;
    return 'bplist' if $buf =~ /^bplist00/;
    return 'utf16' if $buf =~ /^(?:\xff\xfe|\xfe\xff)/ || $buf =~ /^(?:[^\0]\0){8}|^(?:\0[^\0]){8}/;
    $buf =~ s/\0{16,}//g;                           # a log given its full size in advance is text followed by a long run of zero bytes
    return 'text' unless length $buf;               # zero bytes all the way: the rewrite reads on in case text follows
    my $nul = ($buf =~ tr/\0//); my $ctl = ($buf =~ tr/\x01-\x08\x0e-\x1a\x1c-\x1f//);
    ($nul <= 4 || $nul <= length($buf) / 200) && $ctl <= length($buf) / 100 ? 'text' : 'binary';
}

File::Find::find({ no_chdir => 1, wanted => sub {
    if (-l $_) { push @links, $_; return }
    if (-d _) { if (/\.logarchive$/) { push @archives, $_; $File::Find::prune = 1 } return }
    push @files, $_ if -f _ && $_ ne $report;
} }, $root);

sub leave_out {     # remove a file that cannot be rewritten, and remember where it was
    my ($f, $why, $bytes) = @_;
    my $p = shown($f);
    if (!unlink $f) { push @problems, "$p ($why) could not be removed: $!"; return }
    my ($ext) = $p =~ m{(\.[A-Za-z0-9]+)$}; my @d = split m{/}, $p; pop @d;
    my $where = join('/', grep { defined } @d[0 .. 1]) || '(top folder)';
    $out{$why}{$where}{n}++; $out{$why}{$where}{ext}{ lc($ext // 'no extension') }++;
    push @outlist, $p;
    $outn++; $outbytes += $bytes // 0;
}
sub stop {          # nothing more can be written: leave what is there alone and say so
    print STDERR "$_[0]\n";
    exit 4;
}
sub rewrite {
    my $f = shift; my @st = stat $f; my ($dir) = $f =~ m{^(.*)/}; my $tmp = "$dir/.redacting.$$"; my $n = 0;
    open my $in, '<:raw', $f or do { push @problems, shown($f) . ": cannot be read: $!"; push @leave, [$f, 'could not be read', $st[7]]; return };
    # A copy that cannot be written (on a full disk, for one) must not cost the original: stop the whole pass
    sysopen(my $o, $tmp, Fcntl::O_WRONLY() | Fcntl::O_CREAT() | Fcntl::O_EXCL() | Fcntl::O_NOFOLLOW(), 0600) or stop('cannot write beside ' . shown($f) . ": $!");
    binmode $o;
    while (defined(my $line = <$in>)) {
        $done += length $line; progress();
        $n += scrub($line);
        print {$o} $line or do { my $e = "$!"; close $o; unlink $tmp; stop('cannot write a rewritten copy of ' . shown($f) . ": $e") };
    }
    close $in;
    close $o or do { my $e = "$!"; unlink $tmp; stop('cannot write a rewritten copy of ' . shown($f) . ": $e") };
    $read++;
    if (!$n) { unlink $tmp; return }
    rename $tmp, $f or do { my $e = "$!"; unlink $tmp; stop('cannot replace ' . shown($f) . ": $e") };
    chmod $st[2] & 07777, $f; utime $st[8], $st[9], $f; $changed++;
}

# A binary property list is turned into text by plutil before it is rewritten. One that came from the console user
# can unfold into any amount of text, and as root it is read only with that user's rights (RX_CONVERT=user: it is
# handed the file), or not at all: none-rights when those rights could not be taken on, none-closed (or none) when the
# run had stopped running anything with them; otherwise (self) as this program runs. Each one gets at most 5 seconds and
# 16 MB of text, and all of them together 120 seconds and 256 MB. plutil builds the whole text in memory before it
# writes any of it, so the time is what holds its memory down. plutil writes into a pipe, and this program writes
# what arrives into the copy and counts it: past 16 MB it closes the pipe, which ends plutil, and a write of its own
# that fails stops the whole pass, as one in rewrite does, before anything is left out.
# Returns nothing when it was turned into text, or why it was not, from how plutil ended: at the time limit (the
# alarm's signal as this program runs, as_user's 124 with the user's rights), past the size, not run with the user's
# rights (126), plutil's own status (it could not read the file as a property list), or any other end (no answer).
my ($conv_time, $conv_bytes, $mode) = (0, 0, $ENV{RX_CONVERT} // 'self');
sub to_text {
    my $f = shift;
    return "a binary property list, not turned into text: that is done only with the console user's rights, which could not be taken on in this run (see user_files in manifest.tsv)" if $mode eq 'none-rights';
    return "a binary property list, not turned into text: that is done only with the console user's rights, and this run had stopped running anything with them (see time_limit or user_files in manifest.tsv)" if $mode =~ /^none/;
    return 'a binary property list, not turned into text: turning them into text had taken 120 seconds or 256 MB in all' if $conv_time >= 120 || $conv_bytes >= (256 << 20);
    my @st = stat $f; my ($dir) = $f =~ m{^(.*)/}; my $tmp = "$dir/.redacting.$$";
    open(my $in, '<:raw', $f) or return 'could not be read';
    sysopen(my $o, $tmp, Fcntl::O_WRONLY() | Fcntl::O_CREAT() | Fcntl::O_EXCL() | Fcntl::O_NOFOLLOW(), 0600) or stop('cannot write beside ' . shown($f) . ": $!");
    pipe(my $r, my $w) or do { my $e = "$!"; close $o; unlink $tmp; stop('cannot make a pipe to turn ' . shown($f) . " into text: $e") };
    my $began = Time::HiRes::time();
    my $pid = fork();
    if (defined $pid && !$pid) {
        close $r;
        open(STDIN, '<&', $in) or POSIX::_exit(127); open(STDOUT, '>&', $w) or POSIX::_exit(127); open STDERR, '>', '/dev/null';
        my @run = ('/usr/bin/plutil', '-convert', 'xml1', '-o', '-', '-');
        if ($mode eq 'user') {
            $ENV{AS_STDIN} = 1;
            exec '/usr/bin/env', '-u', 'PERL5OPT', '-u', 'PERL_UNICODE', '-u', 'PERL5LIB', '-u', 'PERLLIB', '-u', 'PERLIO', 'LC_ALL=C',
                '/usr/bin/perl', '-e', $ENV{RX_AS_PL}, '--', '-', 5, $ENV{RX_AS_UID}, $ENV{RX_AS_GID}, $ENV{RX_AS_GROUPS}, @run;
        } else {
            alarm 5; exec @run;
        }
        POSIX::_exit(127);
    }
    close $w;
    unless (defined $pid) { close $r; close $o; unlink $tmp; return 'a binary property list, not turned into text: plutil could not be started' }
    my ($got, $cut, $bad, $buf, $n) = (0, 0, '');
    while ($n = sysread($r, $buf, 1 << 20)) {
        if ($got + $n > (16 << 20)) { $cut = 1; last }
        my $at = 0;
        while ($at < $n) { my $wn = syswrite($o, $buf, $n - $at, $at); unless (defined $wn) { $bad = "$!"; last } $at += $wn }
        last if length $bad;
        $got += $n;
    }
    close $r;
    waitpid $pid, 0; my $end = $?;
    close $in;
    $conv_time += Time::HiRes::time() - $began; $conv_bytes += $got;
    if (length $bad) { close $o; unlink $tmp; stop('cannot write a text copy of ' . shown($f) . ": $bad") }
    close $o or do { my $e = "$!"; unlink $tmp; stop('cannot write a text copy of ' . shown($f) . ": $e") };
    my ($sig, $code, $why) = ($end & 127, $end >> 8, '');
    if ($cut || $sig == 25 || ($mode eq 'user' && $code == 153)) { $why = 'a binary property list whose text came to more than 16 MB, so it was not turned into text' }
    elsif (($mode ne 'user' && $sig == 14) || ($mode eq 'user' && $code == 124)) { $why = 'a binary property list that plutil did not turn into text within 5 seconds' }
    elsif ($mode eq 'user' && $code == 126) { $why = "a binary property list, not turned into text: the console user's rights could not be used for it" }
    elsif ($sig || ($mode eq 'user' && $code >= 127)) { $why = 'a binary property list that plutil did not turn into text: plutil ended without an answer (status ' . ($sig ? 128 + $sig : $code) . ')' }
    elsif ($code) { $why = 'a file that starts like a binary property list, which plutil could not read as one' }
    elsif (!$got) { $why = 'a binary property list that plutil gave no text for' }
    if (length $why) { unlink $tmp; return $why }
    rename $tmp, $f or do { my $e = "$!"; unlink $tmp; stop('cannot replace ' . shown($f) . ": $e") };
    chmod $st[2] & 07777, $f; utime $st[8], $st[9], $f;
    return '';
}

# Nothing is removed until every rewrite has been written: if one cannot be (see stop), the bundle is left whole.
$all += (-s $_) // 0 for @files;
for my $f (@files) {
    my $size = -s $f; my $k = kind($f); my $why = 'not plain text';
    if ($k eq 'bplist') {       # a binary property list becomes a text one, or is left out for why it did not
        $why = to_text($f);
        $k = $why eq '' ? 'text' : 'binary';
        $converted++ if $why eq '';
    }
    if ($k eq 'text' && $size <= 64 << 20 && open my $h, '<:raw', $f) {     # a property list, converted or not, whose encoded data cannot be read
        read $h, my $head, 512; my $plist = $head =~ /^\s*(?:<\?xml|<!DOCTYPE plist|<plist)/;
        if ($plist) { local $/; my $rest = <$h>; $k = 'data' if ($head . ($rest // '')) =~ /<data>/ }
        close $h;
    }
    if ($k eq 'text') { rewrite($f) } else { $done += $size // 0 }
    if    ($k eq 'binary') { push @leave, [$f, $why, $size] }
    elsif ($k eq 'utf16')  { push @leave, [$f, 'text in UTF-16, which this does not rewrite', $size] }
    elsif ($k eq 'data')   { push @leave, [$f, 'a property list holding encoded data', $size] }
    elsif ($k ne 'text' && $k ne 'empty') { push @problems, shown($f) . ': cannot be read'; push @leave, [$f, 'could not be read', $size] }
}
leave_out($_, 'a symbolic link, whose target is a path', 0) for @links;
leave_out(@$_) for @leave;

# Names of files and folders, deepest first, and folders that leaving files out has emptied.
# A name is not made longer when a path in the bundle would then be longer than MAXPATH, the 1,000 bytes the copy lets
# a path have (see copy_dir): the zip step cannot take a path much longer (ditto fails from 1,021 bytes), and the check
# below cannot look at one longer than 1,023. Such a name is left as it is and listed as a problem, so the result is
# not complete. The longest path under each folder (%below, from the folder's own name on, without it) is counted from
# its entries as they come, each with the name it was given, the number a taken name gets among it: finddepth comes to
# every entry before the folder it is in.
my (%next, %below);
my $MAXPATH = 1000;
sub blen { my $s = shift; utf8::is_utf8($s) ? length(Encode::encode('UTF-8', $s)) : length($s) }     # bytes
File::Find::finddepth({ no_chdir => 1, wanted => sub {
    return if $_ eq $root;
    my ($dir, $base) = m{^(.*)/([^/]+)$} or return;
    my $deep = delete($below{$_}) // 0;
    my $name = $base;
    RENAME: {
        last RENAME if m{\.logarchive/};
        my $folder = -d $_ && !-l $_;
        return if $folder && $outn && rmdir $_;
        last RENAME if $folder && $OWN{$base};
        my $new = $base;
        { local %count; last RENAME unless scrub($new) }
        my ($stem, $ext) = $new =~ /^(.*?)((?:\.[A-Za-z0-9]{1,12})?)$/s;
        # A name that is taken gets the next number free, counted on from the last one given to that name in that folder:
        # counted from 2 each time, a folder of many names that hide to the same one would take time that grows with the
        # square of their number. A number is still looked at before it is given: a name may be there already.
        my $to = "$dir/$new";
        if (-e $to || -l $to) {
            my $k = join "\0", $dir, $stem, $ext; my $i = $next{$k} // 1;
            $to = "$dir/$stem-" . ++$i . $ext while -e $to || -l $to;
            $next{$k} = $i;
        }
        my ($given) = $to =~ m{([^/]+)$};
        if (blen($given) > blen($base) && blen($to) + $deep > $MAXPATH) {
            push @problems, shown($_) . ': not renamed: with the name it would be given, a path in the bundle would be longer than 1,000 bytes';
            last RENAME;
        }
        if (rename $_, $to) { $renamed++; $name = $given } else { push @problems, shown($_) . ": cannot be renamed: $!" }
    }
    my $len = 1 + blen($name) + $deep;
    $below{$dir} = $len if $len > ($below{$dir} // 0);
} }, $root);

# Read every text file that is left once more, looking for the same things
my ($remain, @where) = (0);
($doing, $done, $all) = ('reading it all again to check', 0, 0);
{
    local %count;
    File::Find::find({ no_chdir => 1, wanted => sub {
        return if $_ eq $root || $_ eq $report;
        # An entry that cannot be looked at (its path too long, say) is not passed over: it is one not checked
        unless (lstat $_) { my $e = "$!"; push @unread, shown($_) . " (could not be looked at: $e)"; return }
        my ($folder, $link, $file) = (-d _, -l _, -f _);
        if ($folder && /\.logarchive$/) { $File::Find::prune = 1; return }
        my ($base) = m{([^/]+)$}; my $hits = $folder && $OWN{$base} ? 0 : scrub($base, 1);
        if ($link) { push @unread, shown($_) . ' (a symbolic link)' }
        elsif ($file) {
            my $k = kind($_);
            if ($k eq 'text') { if (open my $h, '<:raw', $_) { $all += -s $_; while (defined(my $line = <$h>)) { $done += length $line; progress(); $hits += scrub($line, 1) } close $h } else { push @unread, shown($_) } }
            elsif ($k eq 'unreadable') { push @unread, shown($_) . ' (could not be opened)' }
            elsif ($k ne 'empty') { push @unread, shown($_) . ' (not plain text)' }
        }
        if ($hits) { $remain += $hits; push @where, shown($_) }
    } }, $root);
}

my $total = 0; $total += $_ for values %count;
my @why;
push @why, 'an Apple .logarchive is in the bundle and was not changed' if @archives;
push @why, commas($remain) . ' of the things replaced were found again afterwards' if $remain;
push @why, scalar(@unread) . ' file(s) left in the bundle could not be read or checked' if @unread;
push @why, scalar(@problems) . ' problem(s), listed at the end' if @problems;
my @r = ('Redaction report', '================', '',
    'Written by excel_diagnostics.sh --redact. It says what was replaced in this bundle, what was left as it is,',
    'what was left out, and what is not hidden.', '',
    @why ? 'Result: NOT complete: ' . join('; ', @why) . '.' : 'Result: complete' . (@except ? ', with the exceptions listed below.' : '.'), '',
    'Replaced in every plain-text file, crash reports and JSON logs included:');
for my $row (['user', 'account name and home folder names', 'redacted-user'], ['name', 'full name', 'redacted-name'],
             ['computer', "this Mac's name and host names", 'redacted-computer'], ['serial', 'serial number', 'redacted-serial'],
             ['hardware', 'hardware UUID, provisioning UDID, and the per-Mac keys in crash reports', 'redacted-hardware-uuid and similar'],
             ['email', 'email addresses', 'redacted-email']) {
    push @r, sprintf('  %9s  %s, shown as %s', commas($count{ $row->[0] } // 0), $row->[1], $row->[2]);
}
push @r, '', sprintf('Text files read: %s. Changed: %s. Files or folders renamed because their own names held one of these: %s.',
    commas($read), commas($changed), commas($renamed));
{ my %said; push @r, grep { !$said{$_}++ } @notes }
push @r, '', 'Left as it is, or not looked for:', map { "  - $_" } @except if @except;
push @r, '';
if ($outn) {
    push @r, sprintf('Left out: %s file(s), %.1f MB. A file that is not plain text cannot be rewritten or checked, so it is', commas($outn), $outbytes / 1048576),
        'not in this bundle. Collect again without --redact to include them. Where the bundle has inventories',
        '(office/discovered_sources.tsv, source_catalog.tsv, collection.log), they were written before this and may still list them.';
    for my $why (sort keys %out) {
        push @r, "  $why:";
        for my $w (sort keys %{ $out{$why} }) {
            my $e = $out{$why}{$w}{ext};
            push @r, sprintf('  %9s  %s  (%s)', commas($out{$why}{$w}{n}), $w, join(' ', sort { $e->{$b} <=> $e->{$a} || $a cmp $b } keys %$e));
        }
    }
    push @r, '  Each one:', map { "    $_" } sort @outlist;
} elsif (!@problems) {
    push @r, 'Left out: nothing. Every file ' . (@archives ? 'outside the .logarchive' : 'in the bundle') . ' was plain text'
        . ($converted ? ', or a binary property list that was turned into text (' . commas($converted) . ')' : '') . '.';
}
push @r, '', 'Not hidden:',
    '  - the names of files and folders, which include document names and can include company or cloud account names',
    '  - network addresses, and the names of other computers, servers and printers',
    "  - other people's names, except the names of their home folders under /Users",
    '  - a name written in a form this could not predict: a nickname, initials, a first name or family name on its own,',
    '    a middle initial put in, or the parts of the full name run together in another order or into fewer than six letters',
    "  - what follows a plain space in another account's home folder name (a home folder named Pat Lee keeps the word Lee)",
    '  - an address that has a file ending straight after it (name@example.com.txt), which is taken for a file name',
    '  - text held in another encoding inside a file, such as UTF-16 or base64';
push @r, '  - an Apple .logarchive, which cannot be rewritten. This bundle has one, unchanged and unread: ' . join(', ', map { shown($_) } @archives) if @archives;
push @r, '', 'Check: every text file left in the bundle' . (@archives ? ', outside the .logarchive,' : '') . ' was read again after rewriting, looking for the same things that were',
    'replaced. ' . ($remain ? 'Found again ' . commas($remain) . ' time(s), in:' : 'Found again: none.');
push @r, map { "  $_" } @where if $remain;
push @r, 'It looks for the forms listed above and no others, so it cannot show that a name is absent in some other form.';
push @r, '', 'Could not be read, so not checked:', map { "  $_" } @unread if @unread;
push @r, '', 'Problems:', map { "  $_" } @problems if @problems;
my $wrote = 0;
if (open my $fh, '>:raw', $report) { $wrote = print({$fh} join("\n", @r), "\n") && close($fh) }
push @problems, 'redaction.txt could not be written' unless $wrote;

print commas($total), ' replacement(s) in ', commas($changed), ' of ', commas($read), ' text file(s); ',
    ($outn ? commas($outn) . ' file(s) left out' : 'no file left out'),
    ($renamed ? '; ' . commas($renamed) . ' renamed' : ''),
    (@archives ? '; the .logarchive is unchanged' : ''),
    ($remain ? '; ' . commas($remain) . ' found again after rewriting' : '; check found none left'),
    (@unread ? '; ' . scalar(@unread) . ' file(s) could not be checked' : ''),
    (@problems ? '; ' . scalar(@problems) . ' problem(s)' : ''),
    (@except ? '; ' . join('; ', @except) : ''), "; see redaction.txt\n";
exit(($remain || @problems || @archives || @unread) ? 3 : 0);
# ---- the end of REDACT_PL ----
PERL
program_read "$REDACT_PL" REDACT_PL

COLLECTOR_VERSION=1.5.0
# What made this bundle, and on what. Written before anything else, so that an interrupted run has it too, as one
# "name<TAB>value" per line. The viewer shows these on its Overview tab. It holds no name and no serial number.
write_bundle_info() {
    local hw p="/Applications/$EXCEL_PROC.app/Contents/Info.plist"
    hw=$(system_profiler SPHardwareDataType 2>/dev/null)
    {
        printf 'collector_version\t%s\n' "$COLLECTOR_VERSION"
        printf 'mode\t%s\n' "$MODE"
        printf 'started_local\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
        printf 'started_utc\t%s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')"
        printf 'macos_version\t%s\n' "$(sw_vers -productVersion 2>/dev/null)"
        printf 'macos_build\t%s\n' "$(sw_vers -buildVersion 2>/dev/null)"
        printf 'model_name\t%s\n' "$(printf '%s\n' "$hw" | awk -F': ' '/Model Name/ { print $2; exit }')"
        printf 'model_identifier\t%s\n' "$(printf '%s\n' "$hw" | awk -F': ' '/Model Identifier/ { print $2; exit }')"
        printf 'chip\t%s\n' "$(printf '%s\n' "$hw" | awk -F': ' '/Chip|Processor Name/ { print $2; exit }')"
        printf 'memory\t%s\n' "$(printf '%s\n' "$hw" | awk -F': ' '/^ *Memory/ { print $2; exit }')"
        if [ -f "$p" ]; then
            printf 'excel_version\t%s\n' "$(defaults read "$p" CFBundleShortVersionString 2>/dev/null)"
            printf 'excel_build\t%s\n' "$(defaults read "$p" CFBundleVersion 2>/dev/null)"
        else
            printf 'excel_version\t%s\n' "not found in /Applications"
        fi
        # yes when a process of the console user's runs EXCEL_EXE (see excel_pids), and empty when that was not answered
        if first_excel; then printf 'excel_running\t%s\n' "$([ -n "$EXCEL_PID" ] && echo yes || echo no)"; else printf 'excel_running\t\n'; fi
        printf 'log_format\t%s\n' "$LOG_EXT"
    } 2>/dev/null > "$OUT/bundle_info.tsv"
}

redact_bundle() {
    local hosts serial uuid udid models full result rc errors msg convert
    note "Hiding the user's name, this Mac's name and serial number, and email addresses (minutes on a large bundle; it says how far it has got)"
    REDACT_STATE=failed
    if [ ! -x /usr/bin/perl ]; then
        note "  cannot do it: /usr/bin/perl is missing. NOTHING in this bundle has been hidden."
        record_status "redaction" "failed" "perl not found; nothing was hidden"
        return 1
    fi
    hosts=$( { scutil --get ComputerName; scutil --get LocalHostName; scutil --get HostName; hostname; hostname -s; } 2>/dev/null )
    serial=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/"IOPlatformSerialNumber"/ { print $4 }')
    uuid=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/"IOPlatformUUID"/ { print $4 }')
    models=$(system_profiler SPHardwareDataType 2>/dev/null)
    udid=$(printf '%s\n' "$models" | awk -F': ' '/Provisioning UDID/ { print $2 }')
    models=$(printf '%s\n' "$models" | awk -F': ' '/Model Name|Model Identifier/ { print $2 }')
    full=""
    [ "$CONSOLE_USER" = root ] || full=$(id -F "$CONSOLE_USER" 2>/dev/null)     # root's is "System Administrator", which names nobody
    # Its messages go to a file outside the bundle: collection.log is one of the files being rewritten
    errors=$(mktemp -t excel_diag_redact) || errors=/dev/null
    # Binary property lists are turned into text with the console user's rights when root runs this; without them,
    # they are not turned into text at all, and redaction.txt says which it was: rights that could not be taken on
    # (USER_READS), or a run that had stopped running anything with them (see home_closed)
    convert=self
    if [ "$AM_ROOT" -eq 1 ] && [ "$USER_UID" != 0 ]; then
        if [ "$USER_READS" -ne 1 ]; then convert=none-rights
        elif home_closed; then convert=none-closed
        else convert=user; fi
    fi
    result=$(RX_ROOT="$OUT" RX_USER="$CONSOLE_USER" RX_HOME="$USER_HOME" RX_FULL="$full" RX_HOSTS="$hosts" RX_MODELS="$models" \
        RX_SERIAL="$serial" RX_UUID="$uuid" RX_UDID="$udid" RX_PROGRESS=1 RX_CONVERT="$convert" RX_AS_PL="$AS_USER_PL" \
        RX_AS_UID="$USER_UID" RX_AS_GID="$USER_GID" RX_AS_GROUPS="$USER_GROUPS" RX_SECONDS="$REDACT_SECONDS" /usr/bin/perl -e "$REDACT_PL" 2>"$errors" 3>&6)
    rc=$?
    if [ -s "$errors" ]; then       # written after the check, so the bundle's path (it holds the account name) is taken out first
        msg=$(tr '\n' ' ' < "$errors"); msg=${msg//"$OUT"/(bundle)}
        echo "redaction messages (exit $rc): ${msg:0:600}" >> "$LOG"
    fi
    [ "$errors" = /dev/null ] || rm -f "$errors"
    case $rc in
        0) REDACT_STATE=complete
           case "$result" in *"left as it is"*|*"not looked for"*|*"replaced only"*) REDACT_EXCEPT=1 ;; esac
           note "  $result" ;;
        3) REDACT_STATE=incomplete
           note "  NOT everything could be hidden: $result" ;;
        *) find "$OUT" -name '.redacting.*' -type f -delete 2>/dev/null
           if [ $rc -eq 5 ]; then
               # REDACT_PL's own time limit: no file is said to be hidden, whatever was rewritten by then
               note "  hiding names FAILED: it was stopped at its time limit of $REDACT_SECONDS seconds. Files may be partly rewritten, and nothing in this bundle is to be taken as hidden."
               result="stopped at its time limit of $REDACT_SECONDS seconds; files may be partly rewritten"
           else
               note "  hiding names FAILED (exit $rc). Files may be partly rewritten, and nothing in this bundle is to be taken as hidden."
               result="stopped with exit $rc; files may be partly rewritten"
           fi ;;
    esac
    record_status "redaction" "$REDACT_STATE" "${result:-no result}"
    [ "$REDACT_STATE" = complete ]
}

write_summary() {
    local summary="$OUT/summary.md" count size shown_user="$CONSOLE_USER" restarts e i=0 f see ex tsv=() shown=""
    local said30 saidrepro saiddays days_in
    step_begin
    # What points at a row of manifest.tsv, or at how each day's search ended, says so only when that is there: a run
    # that was stopped, or a row that could not be written, leaves it out
    if grep -q "^unified_last30m"$'\t' "$MANIFEST" 2>/dev/null; then said30=" (unified_last30m in manifest.tsv says whether it was searched to its end)"
    else said30=" (manifest.tsv has no unified_last30m row, so whether it was searched to its end is not said)"; fi
    if grep -q "^repro"$'\t' "$MANIFEST" 2>/dev/null; then saidrepro=" (the repro row in manifest.tsv says how it ended and whether it was cut)"
    else saidrepro=" (manifest.tsv has no repro row, so how the stream ended and whether it was cut is not said there)"; fi
    days_in=$(grep -c '^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] | ' "$OUT/unified_logs/collection_status.txt" 2>/dev/null)
    case "$days_in" in ''|*[!0123456789]*) days_in=0 ;; esac
    if [ "${UNIFIED_DAYS:-0}" -gt 0 ] && [ "$days_in" -ge "${UNIFIED_DAYS:-0}" ]; then saiddays="how the search of each day of the unified log whose search was started ended"
    elif [ "${UNIFIED_DAYS:-0}" -gt 0 ]; then saiddays="how the search of $days_in of the ${UNIFIED_DAYS} day(s) of the unified log whose search was started ended; the others have no line in it"
    elif grep -q '^access check | ' "$OUT/unified_logs/collection_status.txt" 2>/dev/null; then saiddays="how the access check of the unified log ended, and that no day was searched"
    else saiddays="no line for a day: no day's search of the unified log was started"; fi
    case "$REDACT:$REDACT_STATE" in 1:complete|1:incomplete) shown_user=redacted-user ;; esac
    count=$(find "$OUT" -type f | wc -l | tr -d ' ')
    size=$(du -sh "$OUT" 2>/dev/null | awk '{print $1}')
    # What a reader may want to look at first, as (path in the bundle, what it holds). A line is written only for a
    # path that is in this bundle, so the list fits the mode and what this run could collect, and it says what each
    # holds, not what that means.
    local review=(
        "case/incident_context.md|what was given with --note and --workbook, as it was kept"
        "collection.log|what each step did, and what it noted: what was not read, was refused, was stopped at a time limit, was left out or could not be written"
        "unified_logs/collection_status.txt|$saiddays"
        "unified_last30m.$LOG_EXT|the unified-log entries of the 30 minutes before that search that its predicate takes, as far as they were kept$said30"
        "repro/unified_live_unfiltered.$LOG_EXT|the entries of the live unified-log stream that were kept$saidrepro"
        "excel_memory_timeline.csv|one row for each sample of Excel's memory and CPU and of the Mac's memory"
        "repro/baseline|the snapshot taken before the live stream was started"
        "repro/final|the snapshot taken after it was stopped"
        "excel_spindump.txt|spindump's report on the process that collection.log names as running Excel's program file"
        "excel_sample.txt|sample's report on that process"
        "excel_footprint.txt|footprint's figures for that process"
        "excel_open_files.txt|lsof's list of the files that process had open"
        "reports/crash_summary.txt|the facts each report copied gives in its header"
        "reports|the diagnostic reports copied, picked by the rule source_catalog.tsv gives"
        "office/autorecover_inventory.txt|for the folders Library/Application Support/Microsoft and Library/Preferences/AutoRecovery of Excel's container, the files whose name holds autorecover or ends in .xar (in any case) or starts with ~ar, with when each last changed, and the files over 10 MB of any name"
        "office/excel_memory.txt|the process that ran Excel's program file when this file was written, and its memory; or that there was none, or that this was not answered"
        "source_catalog.tsv|where each source was looked for, whether it was there, and where it is in the bundle"
        "office/discovered_sources.tsv|each other Microsoft log file the search found, and whether it was copied"
    )
    # The unified-log .tsv files that are here, for the section about filtering them
    if [ "$LOG_EXT" = tsv ]; then
        for f in "$OUT"/unified_logs/*.tsv; do [ -e "$f" ] && { tsv+=('unified_logs/*.tsv'); break; }; done
        [ -e "$OUT/unified_last30m.tsv" ] && tsv+=(unified_last30m.tsv)
        [ -e "$OUT/repro/unified_live_unfiltered.tsv" ] && tsv+=(repro/unified_live_unfiltered.tsv)
    fi
    {
        echo "# Excel diagnostics summary"
        echo
        echo "- Collected: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "- Collector version: $COLLECTOR_VERSION"
        echo "- Console user: $shown_user"
        echo "- Mode: $MODE"
        [ "$MODE" = collect ] && echo "- Incident window: $SINCE through $UNTIL ($DAYS day(s))"
        [ "$MODE" = collect ] || [ "$MODE" = hang ] && echo "- Max wait per log search: $([ "$MAX_WAIT" -eq 0 ] && echo "no limit" || echo "$MAX_WAIT minute(s)")"
        echo "- Files before ZIP packaging, this summary not counted: $count ($size)"
        case "$REDACT:$REDACT_STATE" in
            0:*)          echo '- Hiding names (`--redact`): not asked for' ;;
            1:complete)   echo '- Hiding names (`--redact`): done. `redaction.txt` lists what was replaced, any name left as it is, what was left out and what is not hidden.' ;;
            1:incomplete) echo '- Hiding names (`--redact`): NOT COMPLETE. Read `redaction.txt` before sharing this bundle.' ;;
            *)            echo '- Hiding names (`--redact`): FAILED. Nothing in this bundle should be taken as hidden.' ;;
        esac
        echo
        echo "## Collection status"
        echo
        echo '| Component | Status | Details |'
        echo '| --- | --- | --- |'
        tail -n +2 "$MANIFEST" | while IFS=$'\t' read -r component status details; do
            echo "| $component | $status | $details |"
        done
        echo
        echo "## Review first"
        echo
        for e in "${review[@]}"; do
            [ -e "$OUT/${e%%|*}" ] || continue
            i=$((i + 1)); echo "$i. \`${e%%|*}\`: ${e#*|}."
        done
        echo
        echo '## Searching these logs'
        echo
        echo "Open $VIEWER_URL and drop this folder or its .zip on the page. It puts the entries of the logs it reads into one timeline that can be searched and filtered. The page works entirely in the browser: nothing is uploaded."
        if [ "$MODE" = collect ] && [ "$LOG_EXT" = tsv ]; then
            echo
            echo '## Restarts'
            echo
            echo 'Each row of `unified_logs/*.tsv` whose process is kernel, with process ID 0, and whose message holds the words "previous shutdown cause" (in any case), as it was logged; at most 200 are listed.'
            echo
            # Only the kernel's rows: the tag is given only to them (see LABEL_JQ), and the process and its id are
            # looked at again here. When there are none, the list says whether any day was searched at all.
            restarts=$(awk -F'\t' '$4 == "kernel" && $5 == "0" && ("," $9 ",") ~ /,restart,/ { print "- " $1 ": " $10 }' "$OUT"/unified_logs/*.tsv 2>/dev/null | sort | first_lines 200)
            see=unified_logs/collection_status.txt; [ -e "$OUT/$see" ] || see=collection.log
            if [ -n "$restarts" ]; then printf '%s\n' "$restarts"
            elif [ "${UNIFIED_DAYS:-0}" -gt 0 ]; then echo "- None in the rows kept from the ${UNIFIED_DAYS} day(s) whose search was started (see \`$see\`)."
            else echo "- None listed: no day of the unified log was searched (see \`$see\`)."; fi
        fi
        if [ ${#tsv[@]} -gt 0 ]; then
            for f in "${tsv[@]}"; do shown="${shown:+$shown, }\`$f\`"; done
            echo
            echo '## Filtering unified logs'
            echo
            echo "The unified-log \`.tsv\` files here ($shown) have one entry per row and open as columns in Numbers or Excel."
            echo 'Filter on `level` (Error, Fault) and on `tags`: `excel` (the program file of the process is named Microsoft Excel), `excel-helper` (another program file inside a folder named Microsoft Excel.app), `microsoft` (the program file of the process is named Microsoft Error Reporting, Microsoft AutoUpdate or Microsoft Update Assistant), `hang-report` (the program file of the process is /usr/sbin/spindump), `mentions-excel` (another process, whose message holds "excel" in any case), `memory` (the memorystatus, jetsam, compressor and swap messages of the kernel, process ID 0 or the program /kernel, and the jetsam messages of /System/Library/CoreServices/ReportCrash and /System/Library/CoreServices/osanalyticshelper), `restart` (the kernel'"'"'s "previous shutdown cause" line), `permissions` (processes whose program file is named tccd, the subsystem com.apple.TCC, and messages of refusals such as "denied", "not permitted" and missing entitlements), `storage` (messages of a full disk or volume, an exceeded quota, I/O errors or a read-only file system), `logs-dropped` (the marks the log leaves where it dropped entries).'
            echo 'Use `utc_time` to line entries up with Excel'"'"'s own logs, which are in UTC. From Terminal, for example:'
            echo
            ex="    awk -F'\\t' '\$3 == \"Error\" || \$3 == \"Fault\" || \$9 ~ /excel/' ${tsv[0]}"
            printf '%s\n' "$ex"
        fi
        echo
        echo 'A bundle can name the Mac and its user: the account name and full name, the computer name, serial number and hardware identifiers, email addresses, network addresses, and the names of files and folders. `--redact` replaces those it finds, except network addresses and the names of files and folders, in every plain-text file, and leaves out files that are not plain text. `redaction.txt` says what it did, including any name it left as it is. Nothing inside an Apple .logarchive is changed.'
    } | put "$summary" || unwritten "summary.md"
    row "summary" "summary.md"
}

# Sets FINAL_STATUS, which the script ends with: 0 = a zip was made (and, with --redact, the step ended complete)
# and is where it was asked for; 1 = no zip; 3 = a zip was made but the --redact step failed or did not end
# complete; 4 = the results could not all be moved to where they were asked for (some of them may have been).
# When more than one applies, it is the first of them in this order: 1, 3, 4. (An interrupt's 130 comes after all
# three: see the trap.)
# This order is the one the help and the README give, and the one Jamf policies have seen.
finalize() {
    # From here Ctrl-C and Ctrl-\ are ignored, by this script and by what it runs, and so are a TERM signal and the
    # Terminal window being closed: an interrupt halfway through hiding names or packaging would leave a folder that
    # looks finished and is not. The last lines say what state the results are in. This comes first: an interrupt
    # that came once FINALIZED was set would find finalize done, and nothing would be packaged.
    trap '' INT TERM HUP PIPE QUIT
    [ -n "$FINALIZED" ] && return
    FINALIZED=1
    [ $((COPY_LOST + COPY_ODD + COPY_BIG + COPY_SHUT + COPY_LONG)) -gt 0 ] && record_status "folder_copies" "incomplete" "$COPY_LOST file(s) did not arrive, $COPY_SHUT folder(s) could not be read or counted, $COPY_ODD file(s) left out for a control or invisible character in the name, $COPY_BIG left out for their size, $COPY_LONG left out for the length of their path; see collection.log"
    [ "$LIST_ODD" -gt 0 ] && record_status "lists" "incomplete" "$LIST_ODD name(s) with a control or invisible character left out of office/autorecover_inventory.txt and office/addins.txt"
    local zipped=0 summed=0 errors msg st sum_said f
    {
        printf 'collected_local\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
        printf 'collected_utc\t%s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')"
    } 2>/dev/null >> "$OUT/bundle_info.tsv"
    [ "$REDACT" -eq 1 ] && redact_bundle
    write_summary
    note "Packaging results"
    errors=$(mktemp -t excel_diag_zip) || errors=/dev/null
    if [ "$REDACT" -eq 1 ]; then
        # Extended attributes and resource forks are never read by the name hiding, so they stay out of the zip
        ditto -c -k --norsrc --noextattr --noqtn --noacl --keepParent "$OUT" "$OUT.zip" 2>"$errors" && zipped=1
    else
        ditto -c -k --sequesterRsrc --keepParent "$OUT" "$OUT.zip" 2>"$errors" && zipped=1
    fi
    if [ -s "$errors" ]; then       # ditto names the path, and so the account name, in what it prints
        msg=$(tr '\n' ' ' < "$errors"); msg=${msg//"$OUT"/(bundle)}
        echo "packaging messages: ${msg:0:600}" >> "$LOG"
    fi
    [ "$errors" = /dev/null ] || rm -f "$errors"
    if [ "$zipped" -eq 1 ]; then
        # The file name alone, not its path: the path holds the account name, and this way `shasum -c` works anywhere.
        # The checksum file is named on the screen only when it was written whole.
        step_begin
        ( cd "$STAGE" && shasum -a 256 "$NAME.zip" ) 2>/dev/null | put "$OUT.zip.sha256"
        st=("${PIPESTATUS[@]}")
        if [ "${st[0]}" -eq 0 ] && [ "${st[1]}" -eq 0 ] && [ -s "$OUT.zip.sha256" ]; then summed=1
        else
            rm -f "$OUT.zip.sha256"
            if [ "${st[0]}" -ne 0 ]; then note "  the checksum of the zip could not be made (shasum ended with status ${st[0]}), so there is no checksum file"
            else note "  the checksum of the zip could not be written into the working folder, so there is no checksum file"; WRITES_LOST=$((WRITES_LOST + 1)); fi
            STEP_WHY="there is no checksum file: it could not be made or written; "
        fi
        row "zip" "$NAME.zip"
    else
        rm -f "$OUT.zip"
        note "  ZIP packaging failed (see collection.log)"
        record_status "zip" "failed" "see collection.log"
    fi
    # Nothing more is written into the bundle from here: it is handed over, and what follows goes to the screen.
    deliver
    FINAL_STATUS=0
    # Where each of the three is, as far as the hand-over knows: moved, or where it was before
    FOLDER_AT=$WHERE; ZIP_AT=$WHERE; SUM_AT=$WHERE
    if [ "$WHERE" != "$DEST" ]; then
        FINAL_STATUS=4
        # Said from what each move answered, not from a look afterwards: by then the user may have moved them again
        if [ ${#MOVED[@]} -gt 0 ]; then
            say "Moved to $DEST: ${MOVED[*]}."
            say "NOT moved to $DEST: ${NOT_MOVED[*]}. Before the hand-over began, these were in $STAGE."
            for f in "${MOVED[@]}"; do
                case "$f" in "$NAME") FOLDER_AT=$DEST ;; "$NAME.zip") ZIP_AT=$DEST ;; "$NAME.zip.sha256") SUM_AT=$DEST ;; esac
            done
        else
            say "The results could NOT be moved to $DEST. Before the hand-over began, they were in $STAGE."
        fi
    fi
    # What could not be written is said on the screen (fd 5), which does not depend on the disk that failed: the
    # status table cannot say that a row of its own is missing
    [ "${ROWS_LOST:-0}" -gt 0 ] && say "$ROWS_LOST row(s) could not be written into the status table (manifest.tsv), so it does not have them." >&5
    [ "${WRITES_LOST:-0}" -gt 0 ] && say "$WRITES_LOST time(s) during this run, something it had could not all be written into the working folder (collection.log names each, where it could be written)." >&5
    # Where each one went, from what each move answered and from where it was before the hand-over began; nothing is
    # said of where it is now, because the console user can move it, in a working folder that is theirs by then
    where_said() { if [ "$1" = "$DEST" ]; then echo "was moved to $DEST"; else echo "was in $STAGE before the hand-over began"; fi; }
    if [ "$zipped" -eq 1 ]; then
        say "To search the logs, drop the zip on $VIEWER_URL (it reads them in the browser; nothing is uploaded)."
    else
        FINAL_STATUS=1
        say "Packaging FAILED, so there is no zip to send. What was collected, $NAME, $(where_said "$FOLDER_AT") (see collection.log there)."
    fi
    case "$REDACT:$REDACT_STATE" in
        0:*|1:complete)
            if [ "$zipped" -eq 1 ] && [ "$FINAL_STATUS" -eq 0 ]; then
                sum_said=" (no checksum file was made)"
                [ "$summed" -eq 1 ] && sum_said=" (SHA-256: $DEST/$NAME.zip.sha256)"
                say "Done${REDACT_EXCEPT:+, with a name left as it is or not looked for (redaction.txt in the zip says which)}. Send this file to IT: $DEST/$NAME.zip$sum_said"
            elif [ "$zipped" -eq 1 ]; then
                sum_said="; no checksum file was made"
                [ "$summed" -eq 1 ] && sum_said="; its checksum, $NAME.zip.sha256, $(where_said "$SUM_AT")"
                say "Not all of the results were moved to $DEST (see above)${REDACT_EXCEPT:+; a name was left as it is or not looked for (redaction.txt in the zip says which)}. The file to send to IT, $NAME.zip, $(where_said "$ZIP_AT")$sum_said."
            fi ;;
        1:incomplete)   [ "$zipped" -eq 1 ] && FINAL_STATUS=3
                        say "Hiding names is NOT complete. Read redaction.txt in $NAME, which $(where_said "$FOLDER_AT"), before sending this to anyone." ;;

        *)              [ "$zipped" -eq 1 ] && FINAL_STATUS=3
                        say "Hiding names FAILED, so nothing in what was collected is to be taken as hidden." ;;
    esac
    return 0
}

# Succeeds when every part of a path, taken as it is written, belongs to root, and nobody else can change what a
# part is. The folder asked about must be closed to everyone but root: anyone who could write there could put a
# name in it. A folder above it may be open to others only when it has the sticky bit (the shared folders have):
# there nobody can rename or remove what belongs to someone else, so a part that is root's stays what it is.
# A link among the parts counts only when root made it; where it leads is judged by root_only, not here.
roots_chain() {
    local p=$1 st owner mode kind leaf=1
    while :; do
        # Each part is judged on its own answer, and a part without all three facts is a no. (Not read from a
        # here-string: bash writes one into a file first, and where it cannot, read sets nothing and the part above
        # would be judged on the answer of the part before.)
        owner=""; mode=""; kind=""
        st=$(/usr/bin/stat -f '%u %Mp%Lp %HT' "$p" 2>/dev/null) || return 1
        case "$st" in *' '*' '?*) ;; *) return 1 ;; esac
        owner=${st%% *}; st=${st#* }; mode=${st%% *}; kind=${st#* }
        [ -n "$owner" ] && [ -n "$mode" ] && [ -n "$kind" ] || return 1
        [ "$owner" = 0 ] || return 1
        case "$kind" in
            Directory*)
                case "$mode" in
                    '') return 1 ;;
                    *[2367]?|*[2367])
                        [ "$leaf" -eq 0 ] || return 1
                        case "$mode" in [1357]???) ;; *) return 1 ;; esac ;;
                esac
                # a rule on the folder that lets someone else in is not looked into: it is taken as a no
                /bin/ls -lde "$p" 2>/dev/null | /usr/bin/grep -q -E '^ *[0-9]+: .* allow ' && return 1 ;;
            Symbolic*) ;;
            *) return 1 ;;
        esac
        [ "$p" = / ] && return 0
        p=$(dirname "$p"); leaf=0
    done
}
# Succeeds when a folder is one that nobody but root can have put anything into, or put in place of: it is not in
# the console user's home, and both the path as it is written and the place it leads to pass roots_chain. The
# path as written matters: a link that the user made to a folder of root's leads to one, and is not one.
root_only() {
    local real
    case "$1" in /*) ;; *) return 1 ;; esac
    in_home "$1" && return 1
    [ -d "$1" ] || return 1
    roots_chain "$1" || return 1
    real=$(cd "$1" 2>/dev/null && pwd -P) || return 1
    in_home "$real" && return 1
    roots_chain "$real"
}

# Hands the finished folder, zip and checksum over. Until here they were in a folder only this script could write
# to. They become the console user's, and are moved to where they are wanted by that user's own hand: whatever
# has been put in the way there (a link, a folder of the same name), root follows none of it. The one place root
# moves them itself is a destination that passes root_only, where nothing can have been put in the way; there
# they stay root's, because a file of the user's in a folder of root's is something the user could rewrite. A
# destination that is not there yet is made by root when the nearest folder above it that is there passes
# root_only, and by the user otherwise. Sets WHERE.
deliver() {
    # The user's hand has a time limit here too, or that user could hold root up for good by stopping it; the move
    # has a long one, because to another disk it is a copy. The first step that is stopped at its limit ends the
    # hand-over, and what was not moved stays in the working folder. Once the working folder is the user's, root
    # writes nothing more into it: LOG and MANIFEST are emptied here, so that a time limit is said on the screen only.
    # Its steps share one budget of HAND_OVER_SECONDS, counted here, as well as a limit each: a step held just short
    # of its own limit, then the next, could otherwise still hold the run.
    local f up rc stop=0 made=() mover=as_user AS_LIMIT=60 AS_WHAT="handing the results over" LOG="" MANIFEST="" AS_LEDGER="" HOME_SHUT=0 AS_HANDOVER=1
    local left=${HAND_OVER_SECONDS:-3600} t0
    WHERE=$STAGE; MOVED=(); NOT_MOVED=(); GAVE_UP=""
    rm -f "$STAGE/.limit" "$STAGE/.copy_messages" "$STAGE/.copy_list" "$STAGE/.search_stopped" "$STAGE/.pid" "$STAGE/.user_time" "$STAGE/.found" \
        "$STAGE/.found1" "$STAGE/.found2" "$STAGE/.found3" "$STAGE/.found_count" "$STAGE/.roots" "$STAGE/.earlier" "$STAGE/.earlier_all"
    # The programs' temporary files go nowhere from here: their folder is removed while the working folder is still
    # root's alone, and nothing more is written into what may become the console user's. So is the list of the
    # process groups that run_limited gave its programs (see stop_groups), which by now are all gone.
    [ -n "$STAGE" ] && rm -rf "$STAGE/.tmp" "$STAGE/.groups"; unset TMPDIR
    # What there is to move, looked at while the working folder is still root's alone
    for f in "$NAME" "$NAME.zip" "$NAME.zip.sha256"; do [ -e "$STAGE/$f" ] && made+=("$f"); done
    if [ "$AM_ROOT" -eq 1 ] && [ "${USER_UID:-0}" != 0 ]; then
        up=$DEST
        while [ ! -e "$up" ] && [ ! -L "$up" ] && [ "$up" != / ]; do up=$(dirname "$up"); done
        if root_only "$up"; then
            /bin/mkdir -p "$DEST" 2>/dev/null
            root_only "$DEST" && mover=""
        fi
        if [ -n "$mover" ]; then
            case "$USER_UID" in ''|*[!0123456789]*) return 0 ;; esac
            chown -Rh "$USER_UID" "$STAGE" 2>/dev/null
        fi
    fi
    NOT_MOVED=("${made[@]}")
    step /bin/mkdir -p "$DEST" 2>/dev/null; rc=$?
    [ $rc -eq 124 ] && return 0
    step /bin/test -d "$DEST"; rc=$?
    [ $rc -eq 0 ] || return 0
    # All three or none: if anything is already there under one of the names, link or not, nothing is moved. An
    # answer other than yes or no (a step stopped, or refused) moves nothing either.
    for f in "$NAME" "$NAME.zip" "$NAME.zip.sha256"; do
        step /bin/test -e "$DEST/$f"; rc=$?
        [ $rc -eq 1 ] && { step /bin/test -L "$DEST/$f"; rc=$?; }
        [ $rc -eq 1 ] || return 0
    done
    # Each one is moved only when the one before it was: at the first that is not, the hand-over stops, so that
    # what is said afterwards (moved, and not moved) comes from what each move answered. A move counts when mv
    # answered 0 and a step, by the same hand, then answers that nothing is left under that name in the working
    # folder (mv -n answers 0 when it moved nothing). Root does not look there itself: once the working folder is the
    # console user's, what stands under a name in it is that user's to choose, a link to a volume that does not answer
    # among it, and only a step has a time limit.
    NOT_MOVED=()
    for f in "${made[@]}"; do
        if [ "$stop" -eq 0 ]; then
            AS_LIMIT=3600 step /bin/mv -n "$STAGE/$f" "$DEST/$f" 2>/dev/null; rc=$?     # -n: never onto something already there
            if [ $rc -eq 0 ]; then
                step /bin/test -e "$STAGE/$f"; rc=$?
                [ $rc -eq 1 ] && { step /bin/test -L "$STAGE/$f"; rc=$?; }
                if [ $rc -eq 1 ]; then MOVED+=("$f"); continue; fi
            fi
            stop=1
        fi
        NOT_MOVED+=("$f")
    done
    if [ ${#NOT_MOVED[@]} -eq 0 ]; then rmdir "$STAGE" 2>/dev/null; WHERE=$DEST; fi
}
# step COMMAND... - one step of the hand-over, with the user's hand (or root's, see deliver), within what is left of
# the hand-over's budget. A step stopped at its time limit is said on the screen; its status is 124.
step() {
    local lim=${AS_LIMIT:-60} rc t0=$SECONDS
    [ "$left" -gt 0 ] || { gave_up; return 124; }
    [ "$lim" -gt "$left" ] && lim=$left
    AS_LIMIT=$lim $mover "$@"; rc=$?
    left=$(( left - (SECONDS - t0) ))
    [ $rc -eq 124 ] && gave_up
    return $rc
}
# Said by who moves (mover, in deliver): root's own steps have no time limit of their own, only the hand-over's
gave_up() {
    [ -n "$GAVE_UP" ] && return 0
    GAVE_UP=1
    # Only steps run as root for another user have a time limit of their own: without root, or with the console user
    # being root, as_user runs the step directly
    if [ -n "${mover-}" ] && [ "$AM_ROOT" -eq 1 ] && [ "$USER_UID" != 0 ]; then
        say "The hand-over was stopped: a step run with the console user's rights did not finish within its time limit, or the ${HAND_OVER_SECONDS:-3600} seconds allowed for all of them were used up."
    else
        say "The hand-over was stopped: the ${HAND_OVER_SECONDS:-3600} seconds allowed for all of its steps were used up."
    fi
}

# An interrupt during collection (Ctrl-C, Ctrl-\, the Terminal window closed, a TERM signal): finish up with what there
# is. The status is finalize's when that is not 0 (no zip, names not hidden, or results not all moved), otherwise the
# usual 130 for a run that was stopped. The process groups that programs run with run_limited were given, and that are
# still there, are killed first (stop_groups), and again before the packaging: the terminal's Ctrl-C does not reach
# them. repro's stream and watch are stopped and waited for (repro_finish), the watch's row is written (watch_row), and
# so is what a search that was going on would have written when it ended, as a search the run was stopped in
# (stopped_rows). The handling is done once: a second signal of another kind while it runs (Ctrl-C, then the window closed) runs this
# again, inside it, and that does nothing; the first one goes on to the end. (A return would not do: in bash 3.2 it
# would return from the function the first one was in.) Signals are not ignored here: what the handling runs must
# still stop at an interrupt (see LIMIT_PL), until finalize ignores them.
# Whoever was reading the screen may be gone by now: the output was passed through a pipe to a program that the
# same Ctrl-C ended, or the Terminal window was closed. A write there must not end the script (PIPE is ignored),
# and must not be left waiting in this shell to come out in the next file it writes: so the first line is
# written by a program of its own, and when that fails everything meant for the screen goes nowhere.
trap '[ -n "$IN_TRAP" ] || { IN_TRAP=1; trap "" PIPE; /bin/echo >&5 2>/dev/null || exec 5>/dev/null 6>/dev/null; exec 1>&5 2>&6; stop_groups; [ "$MODE" = repro ] && repro_finish; watch_row; stopped_rows; note "Stopped - packaging what was collected so far."; kill $(jobs -p) 2>/dev/null; stop_groups; finalize; [ "${FINAL_STATUS:-0}" -ne 0 ] && exit "$FINAL_STATUS"; exit 130; }' INT TERM HUP QUIT


write_bundle_info
write_incident_context

case "$MODE" in
    collect) mode_collect ;;
    hang)    mode_hang ;;
    repro)   mode_repro ;;
    watch)   workbook_facts; mode_watch ;;
esac
finalize
exit "${FINAL_STATUS:-0}"
