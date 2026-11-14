#!/bin/bash
# Checks what `excel_diagnostics.sh` records about an incident, without collecting anything: the line given with
# --note or typed at the question, and the workbook named with --workbook. It runs the top of the collector as it
# is (the options, the questions, and what is handed to the sudo re-run), on a terminal of its own where the
# questions need one, and takes the functions that write the files out of the collector to run them in a scratch
# folder. Run on a Mac:  bash test/note_test.sh
#
# COLLECTOR_UNDER_TEST=path tests another copy of the collector (a relative path is taken from where you are).
# NOTE_TEST_KEEP=1 keeps the scratch folder.
#
# Every name and address below is invented. Home folder paths are put together from parts so that this file
# holds no path that looks like a real person's.

SCRIPT=${COLLECTOR_UNDER_TEST:-}
case "$SCRIPT" in '') ;; /*) ;; *) SCRIPT="$PWD/$SCRIPT" ;; esac
cd "$(dirname "$0")/.." || exit 2
[ -n "$SCRIPT" ] || SCRIPT="$PWD/excel_diagnostics.sh"
[ -f "$SCRIPT" ] || { echo "no collector at $SCRIPT"; exit 2; }
WORK=$(mktemp -d -t note_test) || exit 2
trap 'rm -rf "$WORK"' EXIT
[ -n "$NOTE_TEST_KEEP" ] && { trap - EXIT; echo "Keeping the made-up bundles in $WORK"; }       # to look at them afterwards

AM_ROOT=0                                  # the test is never root: as_user then runs a command as it is
for f in plain_perl as_user clean_note prepare_note shown_path write_incident_context collect_workbook_metadata workbook_facts run_limited \
         put step_begin row unwritten log_line shown_lines ended_said rights_said; do

    body=$(sed -n "/^$f() {\$/,/^}\$/p" "$SCRIPT")
    [ -n "$body" ] || { echo "could not find $f in $SCRIPT"; exit 2; }
    eval "$body"
done
# The rule shown_path and shown_lines show text by, held in single quotes as one assignment, and the program
# run_limited runs a program with
body=$(/usr/bin/perl -0777 -ne 'print $1 if /^(SHOWN_RULE_PL=\x27[^\x27]*\x27)$/m' "$SCRIPT")
[ -n "$body" ] || { echo "could not find SHOWN_RULE_PL in $SCRIPT"; exit 2; }
eval "$body"
body=$(sed -n "/^IFS= read -r -d '' LIMIT_PL <<'PERL'\$/,/^PERL\$/p" "$SCRIPT")
[ -n "$body" ] || { echo "could not find LIMIT_PL in $SCRIPT"; exit 2; }
eval "$body"
REAL_CLEAN_NOTE=$(sed -n '/^clean_note() {$/,/^}$/p' "$SCRIPT")
REAL_RUN_LIMITED=$(sed -n '/^run_limited() {$/,/^}$/p' "$SCRIPT")
record_status() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$MANIFEST"; }
note() { echo "$*" >> "$OUT/collection.log"; }
HAVE_PERL=1; step_begin                    # the files are written by put, and each step's row comes from its counts

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
is()   { if [ "$2" = "$3" ]; then ok; else bad "$1: expected '$3', got '$2'"; fi; }
has()  { if grep -a -F -q -- "$2" "$1" 2>/dev/null; then ok; else bad "$3: '$2' should be in $(basename "$1")"; fi; }
lacks() { if grep -a -F -q -i -- "$2" "$1" 2>/dev/null; then bad "$3: '$2' should not be in $(basename "$1")"; else ok; fi; }
# cleaned WHAT INPUT EXPECTED [STATUS] - what clean_note keeps of INPUT, and the status it ends with
cleaned() {
    local out rc
    out=$(clean_note "$2"); rc=$?
    is "$1" "$out" "$3"
    is "$1: status" "$rc" "${4:-0}"
}
repeat() { /usr/bin/perl -e 'print $ARGV[0] x $ARGV[1]' "$1" "$2"; }
u() { /usr/bin/perl -e 'binmode(STDOUT, ":utf8"); print map { chr hex } @ARGV' "$@"; }      # u 202e ... - those characters

# ---- what is kept of a line that was typed -----------------------------------------------------------------------
E=$'\xc3\xa9'                              # an e with an acute accent, two bytes
cleaned "an ordinary line" 'Excel closed when I sorted column C' 'Excel closed when I sorted column C'
cleaned "quotes and a backslash stay" "it's \"quoted\" C:\\temp" "it's \"quoted\" C:\\temp"
cleaned "markup is kept as typed, not acted on" '`ls` $(date) **bold** <b>x</b> # | - 1.' '`ls` $(date) **bold** <b>x</b> # | - 1.'
cleaned "spaces at the ends, tabs and line breaks" $'  two\tparts \n and\r\na break  ' 'two parts and a break'
cleaned "what an arrow key or a colour leaves behind" $'up\033[A and \033[1;31mred\033[0m' 'up and red'
cleaned "forward delete, page up and a function key" $'del\033[3~ete pa\033[5~ge f\033[15~ive' 'delete page five'
cleaned "arrow and function keys in their other form" $'help\033OP up\033OA' 'help up'
cleaned "an escape and an O before an accent take no byte of it" "caf$E "$'\033O'"${E}t$E" "caf$E O${E}t$E"
cleaned "an escape character on its own becomes a space" $'a\033b\007c' 'a b c'
cleaned "characters that reorder or hide text" $'ab\xe2\x80\xaecd\xe2\x80\xac e\xe2\x80\x8bf \xef\xbb\xbfg' 'abcd ef g'
cleaned "the other characters that reorder or hide text" $'a\xc2\xadb\xe2\x81\xa6c\xe2\x81\xa9d\xef\xbf\xb9e\xf3\xa0\x81\x81f\xe2\x81\xa0g\xe1\xa0\x8eh' 'abcdefgh'
cleaned "a no-break space, a line separator and a paragraph separator" $'a\xc2\xa0b\xe2\x80\xa8c\xe2\x80\xa9d' 'a b c d'
cleaned "control characters above the plain ones" $'a\xc2\x85b\xc2\x9bc' 'a b c'
cleaned "accents and other scripts stay" "caf$E "$'\xe6\x97\xa5\xe6\x9c\xac \xf0\x9f\x93\x88' "caf$E "$'\xe6\x97\xa5\xe6\x9c\xac \xf0\x9f\x93\x88'
cleaned "the joiner inside an emoji stays" $'\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x92\xbb at work' $'\xf0\x9f\x91\xa9\xe2\x80\x8d\xf0\x9f\x92\xbb at work'
cleaned "the non-joiner that Persian spelling needs stays" $'\xd9\x85\xdb\x8c\xe2\x80\x8c\xd8\xae\xd9\x88\xd8\xa7\xd9\x87\xd9\x85' $'\xd9\x85\xdb\x8c\xe2\x80\x8c\xd8\xae\xd9\x88\xd8\xa7\xd9\x87\xd9\x85'
cleaned "a direction mark is taken out" $'abc\xe2\x80\x8e def' 'abc def'
cleaned "a replacement character that was typed stays" $'cells show \xef\xbf\xbd\xef\xbf\xbd here' $'cells show \xef\xbf\xbd\xef\xbf\xbd here'
cleaned "bytes that are not UTF-8 become a space, and the accents beside them stay" "caf$E bad"$'\xff\xfe''bytes caf'$'\xe9'' end' "caf$E bad bytes caf end"
cleaned "a key code is still removed when another byte is not UTF-8" $'caf\xe9 closd\033[De' 'caf closde'
cleaned "nothing typed" '' ''
cleaned "only spaces and tabs" $' \t  ' ''
cleaned "only characters that do not show" $'\xe2\x80\x8b\xe2\x80\x8e\033[0m' ''
cleaned "only joiners and direction marks" $'\xe2\x80\x8d \xe2\x80\x8c\xe2\x80\x8f' ''
# Characters that draw nothing and have a use inside words of some language stay where they are. A text made only
# of them, and of spaces of any width, is no text.
cleaned "only fillers" "$(u 3164 3164 3164)" ''
cleaned "only characters that draw nothing, of every kind" "$(u 2800 115f 1160 e0100 34f ffa0 3000 2003 17b4 1d173 fe0f 200d) $(u 200a 202f 205f)" ''
cleaned "the characters that choose the form of a letter stay" "ok$(u e0100 e0148 e0169)" "ok$(u e0100 e0148 e0169)"
cleaned "a filler, an empty braille cell and an old Korean filler inside a text stay" "a$(u 3164)b $(u 2800)c $(u 115f 1160)d" "a$(u 3164)b $(u 2800)c $(u 115f 1160)d"
cleaned "one letter among characters that draw nothing is a text" "$(u 3164 3164)x$(u 3164)" "$(u 3164 3164)x$(u 3164)"
cleaned "a mark that goes onto a letter shows by itself" "$(u 301)" "$(u 301)"
cleaned "a beginning in which nothing shows is no text, and is not called a beginning" "$(repeat "$(u 200c)" 450) $(repeat x 60)" ''
cleaned "a beginning in which one letter shows is kept" "y$(repeat "$(u 200c)" 450) $(repeat x 60)" "y$(repeat "$(u 200c)" 450)" 7
cleaned "500 characters are kept whole" "$(repeat x 500)" "$(repeat x 500)"
cleaned "501 characters with no space are cut to 500" "$(repeat x 501)" "$(repeat x 500)" 7
cleaned "the cut counts characters, not bytes" "x$(repeat "$E" 600)" "x$(repeat "$E" 499)" 7
cleaned "a cut that would fall inside a word drops that word" "$(repeat x 494) jordanv saw it happen" "$(repeat x 494)" 7
cleaned "a cut that would fall inside an address drops it" "$(repeat x 480) jordan.vale@example.org saw it" "$(repeat x 480)" 7
cleaned "a word of up to 60 characters at the cut is dropped" "$(repeat x 460) $(repeat y 100)" "$(repeat x 460)" 7
cleaned "a longer one is cut through" "$(repeat x 430) $(repeat y 100)" "$(repeat x 430) $(repeat y 69)" 7
cleaned "a cut at the end of a word keeps the word" "$(repeat 'ab ' 166)ab cd" "$(repeat 'ab ' 166)ab" 7
cleaned "a cut straight after a space drops the space" "$(repeat x 499) yy" "$(repeat x 499)" 7
cleaned "spaces that are removed do not count towards the 500" "$(repeat 'ab  ' 200)" "$(repeat 'ab ' 166)ab" 7
cleaned "what was cut is not cut again" "$(clean_note "$(repeat 'word ' 150)")" "$(repeat 'word ' 99)word"
# Settings a person may have made for their own perl do not change what is kept
is "perl settings in the environment are not used" "$(PERL_UNICODE=SDA PERL5OPT=-CS PERLIO=:utf8 clean_note "caf$E closed")" "caf$E closed"

# ---- prepare_note: the line and what is known about it -----------------------------------------------------------
NOTE=$'  Excel  closed\n when I sorted  '; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "prepare: the line" "$NOTE" 'Excel closed when I sorted'
is "prepare: not cut, perl ran" "$NOTE_CUT $NOTE_PLAIN" '0 0'
NOTE="$(repeat 'word ' 150)"; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "prepare: a long line is cut and marked" "${#NOTE} $NOTE_CUT $NOTE_PLAIN" '499 1 0'
prepare_note
is "prepare: doing it again changes nothing" "${#NOTE} $NOTE_CUT $NOTE_PLAIN" '499 1 0'
NOTE=""; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "prepare: nothing given" "[$NOTE] $NOTE_CUT $NOTE_PLAIN" '[] 0 0'
NOTE="$(repeat "$(u 200c)" 450) $(repeat x 60)"; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "prepare: a long text with nothing that shows in its beginning is no text, and is not marked as cut" "[$NOTE] $NOTE_CUT $NOTE_PLAIN" '[] 0 0'
NOTE="$(u 3164 2800)"; NOTE_CUT=1; NOTE_PLAIN=0; prepare_note
is "prepare: no text is left, so nothing is said about its length" "[$NOTE] $NOTE_CUT" '[] 0'
NOTE='plain already'; NOTE_CUT=0; NOTE_PLAIN=0; NOTE_CUT_TOLD=1; NOTE_PLAIN_TOLD=1; prepare_note
is "prepare: what an earlier run passed on is kept as told, and not taken as found here" "[$NOTE] $NOTE_CUT $NOTE_PLAIN $NOTE_CUT_TOLD $NOTE_PLAIN_TOLD" '[plain already] 0 0 1 1'
# The file then says only plain ASCII characters are kept: so that is what is kept, whoever said it
NOTE="caf$E  closed $(u 202e)x"; NOTE_CUT=0; NOTE_PLAIN=0; NOTE_PLAIN_TOLD=1; prepare_note
is "prepare: told the line is plain, only its plain characters are kept" "[$NOTE] $NOTE_CUT $NOTE_PLAIN $NOTE_PLAIN_TOLD" '[caf closed x] 0 0 1'
NOTE_CUT_TOLD=0; NOTE_PLAIN_TOLD=0
# perl cannot be run: the plain characters are kept, counted and cut by the shell
clean_note() { return 127; }
NOTE="  caf$E closed"$'\033[A\n twice  '; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "no perl: the plain characters, on one line" "[$NOTE] $NOTE_CUT $NOTE_PLAIN" '[caf closed [A twice] 0 1'
NOTE="$(repeat 'word ' 150)"; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "no perl: cut at 500" "${#NOTE} $NOTE_CUT $NOTE_PLAIN" '499 1 1'
NOTE=$' \t '; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "no perl: only spaces is nothing" "[$NOTE]" '[]'
clean_note() { return 1; }
NOTE='perl stopped with an error'; NOTE_CUT=0; NOTE_PLAIN=0; prepare_note
is "perl failed: the line is kept all the same" "[$NOTE] $NOTE_PLAIN" '[perl stopped with an error] 1'
eval "$REAL_CLEAN_NOTE"

# ---- what is written into the bundle -----------------------------------------------------------------------------
# context NAME - a fresh made-up bundle folder; sets OUT, MANIFEST, MD and clears what a run would have set
context() {
    OUT="$WORK/$1"; mkdir -p "$OUT"; MANIFEST="$OUT/manifest.tsv"; : > "$MANIFEST"; MD="$OUT/case/incident_context.md"
    NOTE=""; WORKBOOK=""; NOTE_CUT=0; NOTE_PLAIN=0; NOTE_LATE=0; NOTE_OVER=0; REDACT=0
    NOTE_CUT_TOLD=0; NOTE_PLAIN_TOLD=0; NOTE_LATE_TOLD=0; NOTE_OVER_TOLD=0; P_LOCALE=en_US.UTF-8
}
# the file, with the one line that changes from run to run made the same
written() { sed 's/^- Collector started: 20[0-9-]* [0-9:]* [A-Z0-9+-]*$/- Collector started: WHEN/' "$MD" 2>/dev/null; }
files() { ( cd "$OUT" && find . -type f | sort | tr '\n' ' ' ); }
HEADING='## What happened, as typed by whoever ran the collector'
TYPED='This is what was typed, put on one line. Each run of line breaks, tabs, plain spaces and no-break spaces became one space, and spaces at the ends were taken off. Control characters and bytes that are not UTF-8 text became a space or were left out. Complete key codes (what arrow and function keys send) were taken out. So were the characters on a fixed list in the collector: those that mark, embed, override or isolate the direction of text, and soft hyphen, zero-width space, word joiner, byte-order mark, tag characters and a few more that draw nothing. Any other character that draws nothing was left as it was.'
SHELLKEPT='This is what was typed, as far as the shell could keep it: perl could not be run or failed on this Mac, so only the plain ASCII characters are here, on one line. Everything else became a space or was left out, and every run of spaces became one space.'
CHECKED='The collector checked it against nothing it collected.'
LATE='More input arrived right after the Return that ended it. That input was not kept.'
OVER='More than 8,000 bytes of text arrived at the question, the most it keeps, and what did not fit was not kept. The text may have been edited after that.'
LONGER='It was longer than 500 characters, so only its beginning is here.'
ESCAPES="(a backslash and the character after it became that character, a backslash before a line break went with it, and a backslash with nothing after it stayed)"
ENDS="spaces, tabs, line breaks, carriage returns, vertical tabs, form feeds and straight quote marks at its two ends, which is how Terminal writes the path of a dragged file. The workbook was not copied."
PATHLINE="This is the path that was given, with each of these in it shown as one space: control characters, line and paragraph separators, and the characters on a fixed list in the collector (those that mark, embed, override or isolate the direction of text, and soft hyphen, zero-width space, word joiner, byte-order mark, tag characters and a few more that draw nothing). Any other character that draws nothing, and any byte that is not UTF-8 text, is as it was given. A path typed or dragged at the collector's question is given as the bytes that arrived there, except codes that start with Esc (what arrow and function keys send), NUL bytes, what did not fit in the 8,000 bytes the question keeps, and the keys that end, edit or interrupt an answer wherever they were taken as keys and not as part of a paste. Its backslash escapes were then taken off $ESCAPES, and so were $ENDS"
PATHPLAIN="This is the path that was given, with each ASCII control character in it shown as one space. perl could not be run or failed on this Mac, so nothing else in it was changed: other control characters, and characters that reorder text or draw nothing, are as they were given. A path typed or dragged at the collector's question first had its backslash escapes taken off $ESCAPES, and then $ENDS"
HIDING='Hiding names (--redact) was asked for. Where that step ran, it rewrote what is set off above like any other text, so it can differ from what was given: summary.md says whether the step ran, and redaction.txt what it replaced.'

context nothing; write_incident_context; workbook_facts
is "nothing given: no file at all" "$(files)" './manifest.tsv '
is "nothing given: no status row" "$(wc -l < "$MANIFEST" | tr -d ' ')" 0

context blank; NOTE=$' \t\xe2\x80\x8b '; prepare_note; write_incident_context
is "a note with nothing visible in it: no file at all" "$(files)" './manifest.tsv '
context fillers; NOTE="$(u 3164 3164 3164)"; prepare_note; write_incident_context
is "a note of fillers only: no file at all" "$(files)" './manifest.tsv '
context hiddenstart; NOTE="$(repeat "$(u 200c)" 450) $(repeat x 60)"; prepare_note; write_incident_context
is "a long note with nothing that shows in its beginning: no file at all" "$(files)" './manifest.tsv '

context note; NOTE='Excel closed when I sorted column C'; prepare_note; write_incident_context; workbook_facts
is "note: the whole file" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    Excel closed when I sorted column C\n\n%s\n%s' "$HEADING" "$TYPED" "$CHECKED")"
is "note: its status row" "$(cat "$MANIFEST")" "$(printf 'incident_context\tcomplete\t--note text')"
is "note: the files" "$(files)" './case/incident_context.md ./manifest.tsv '

context markup; NOTE=$'# Heading\n| a | b |\n- item\n1. one `code` **bold** <script>x</script>'; prepare_note; write_incident_context
is "markup: the whole file, the note on one line" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    # Heading | a | b | - item 1. one `code` **bold** <script>x</script>\n\n%s\n%s' "$HEADING" "$TYPED" "$CHECKED")"

context long; NOTE="$(repeat 'word ' 150)"; prepare_note; write_incident_context
is "long: the whole file" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    %s\n\n%s\nIt was longer than 500 characters, so only its beginning is here.\n%s' "$HEADING" "$(repeat 'word ' 99)word" "$TYPED" "$CHECKED")"

# More arrived at the question than the reader keeps, and some of it was taken back before Return: the file says what
# is known, and does not call a short note the beginning of something longer
context over; NOTE='It crashed when saving'; NOTE_OVER=1; prepare_note; write_incident_context
is "more than 8,000 bytes arrived at the question: the whole file says so, and calls the note no beginning" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    It crashed when saving\n\n%s\n%s\n%s' "$HEADING" "$TYPED" "$OVER" "$CHECKED")"
context overlong; NOTE="$(repeat 'word ' 150)"; NOTE_OVER=1; NOTE_LATE=1; prepare_note; write_incident_context
is "more than 8,000 bytes, a line over 500 characters and input after Return: each is said once" "$(written | sed -n '9,$p')" "$(printf '%s\n%s\n%s\n%s\n%s' "$TYPED" "$OVER" "$LONGER" "$LATE" "$CHECKED")"
context overnothing; NOTE=$' \t '; NOTE_OVER=1; prepare_note; write_incident_context
is "more than 8,000 bytes of nothing that is kept: no file, and nothing is said about it" "$(files) $NOTE_OVER" './manifest.tsv  0'

context late; NOTE='it froze when I sorted'; NOTE_LATE=1; prepare_note; write_incident_context
is "input dropped after the Return that ended the note: the whole file says so" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    it froze when I sorted\n\n%s\n%s\n%s' "$HEADING" "$TYPED" "$LATE" "$CHECKED")"
context latenothing; NOTE=$' \t'; NOTE_LATE=1; prepare_note; write_incident_context
is "input dropped after an empty note: no file, and nothing is said about it" "$(files) $NOTE_LATE" './manifest.tsv  0'

# What this run was told by an option is said as the option it was started with, and never as what happened: anyone
# who starts the collector can give the options. (The run without sudo gives them to its run with sudo.)
TOLD_OVER="This run was started with --note-over, the option by which the collector's run without sudo passes on that more than 8,000 bytes of text arrived at its question, the most it keeps, that what did not fit was not kept, and that the text may have been edited after that."
TOLD_CUT="This run was started with --note-cut, the option by which the collector's run without sudo passes on that the line was longer than 500 characters and that only its beginning was kept."
TOLD_LATE="This run was started with --note-late, the option by which the collector's run without sudo passes on that more input arrived at its question right after the Return that ended the line, and that it was not kept."
TOLD_PLAIN="This is what was typed, with only its plain ASCII characters kept, on one line. Everything else became a space or was left out, and every run of spaces became one space. This run was started with --note-plain, the option by which the collector's run without sudo passes on that perl could not be run or failed there and that it kept only these characters."
context told; NOTE='Excel froze'; NOTE_CUT_TOLD=1; NOTE_OVER_TOLD=1; NOTE_LATE_TOLD=1; prepare_note; write_incident_context
is "told by the three options: the file says the run was started with them, and nothing about what they stand for" "$(written | sed -n '9,$p')" "$(printf '%s\n%s\n%s\n%s\n%s' "$TYPED" "$TOLD_OVER" "$TOLD_CUT" "$TOLD_LATE" "$CHECKED")"
lacks "$MD" "$OVER" "a sentence that more than 8,000 bytes arrived, which this run did not see"
lacks "$MD" "$LONGER" "a sentence that the line was longer than 500 characters, which it is not"
lacks "$MD" "$LATE" "a sentence that more input arrived, which this run did not see"
context toldplain; NOTE="caf$E closed"; NOTE_PLAIN_TOLD=1; prepare_note; write_incident_context
is "told by --note-plain while perl runs: the plain characters, and the option, and nothing said about perl here" "$(written | sed -n '7,$p')" "$(printf '    caf closed\n\n%s\n%s' "$TOLD_PLAIN" "$CHECKED")"
# Found here and told: what this run found is said as a fact, once
context toldandseen; NOTE="$(repeat 'word ' 150)"; NOTE_CUT_TOLD=1; prepare_note; write_incident_context
is "a line this run cut itself, though it was told too: said as a fact, once" "$(grep -c -F -x "$LONGER" "$MD") $(grep -c -F -- '--note-cut' "$MD")" '1 0'
# Where the locale does not name UTF-8, the file says that characters beyond ASCII were read as UTF-8
LOCALE_LINE='The locale this run was started in does not name UTF-8. The characters beyond ASCII in the line were read as UTF-8, and may not be the characters that were typed.'
context localec; P_LOCALE=C; NOTE="caf$E closed"; prepare_note; write_incident_context
is "a line with an accent, in a locale that names no UTF-8: the file says how it was read" "$(written | sed -n '9,$p')" "$(printf '%s\n%s\n%s' "$TYPED" "$LOCALE_LINE" "$CHECKED")"
context localeeuc; P_LOCALE=ko_KR.eucKR; NOTE=$'\xbf\xa2\xbc\xbf \xc3\xe6\xb5\xb9 \xc5\xb0'; prepare_note; write_incident_context
has "$MD" "$LOCALE_LINE" "how a line in another encoding was read"
context localeascii; P_LOCALE=""; NOTE='plain words'; prepare_note; write_incident_context
lacks "$MD" "does not name UTF-8" "a sentence about the locale for a line that is all ASCII"
context localeutf8; P_LOCALE=ja_JP.UTF-8; NOTE="caf$E closed"; prepare_note; write_incident_context
lacks "$MD" "does not name UTF-8" "a sentence about the locale where it names UTF-8"

context accents; NOTE="x$(repeat "$E" 600)"; prepare_note; write_incident_context
is "accents cut at 500: still valid UTF-8" "$(/usr/bin/perl -e 'local $/; my $s = <>; exit(utf8::decode($s) ? 0 : 1)' "$MD" && echo valid || echo broken)" valid
is "accents cut at 500: one x and 499 of them" "$(grep '^    ' "$MD" | LC_ALL=C tr -d ' \n' | wc -c | tr -d ' ')" 999

context hiding; NOTE='It froze on save'; REDACT=1; prepare_note; write_incident_context
is "with --redact: the file says names were to be hidden, and where to see whether they were" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    It froze on save\n\n%s\n%s\n\n%s' "$HEADING" "$TYPED" "$CHECKED" "$HIDING")"

clean_note() { return 127; }
context plain; NOTE="caf$E closed"; prepare_note; write_incident_context
is "no perl: the file says what was kept, and claims nothing more" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n%s\n\n    caf closed\n\n%s\n%s' "$HEADING" "$SHELLKEPT" "$CHECKED")"
eval "$REAL_CLEAN_NOTE"

BOOK="$WORK/Made Up  1. **Budget**.xlsx"; printf 'not a real workbook' > "$BOOK"
context workbook; WORKBOOK="$BOOK"; write_incident_context; workbook_facts
is "workbook: the whole file, the path as given" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n## Workbook named when the collector was run\n\n    %s\n\n%s' "$BOOK" "$PATHLINE")"
is "workbook: its status rows" "$(cat "$MANIFEST")" "$(printf 'incident_context\tcomplete\t--workbook path\nworkbook_metadata\tcomplete\tmetadata only; workbook not copied')"
is "workbook: the files, and no copy of the workbook among them" "$(files)" './case/incident_context.md ./case/workbook_metadata.txt ./manifest.tsv '
is "workbook: its contents are in no file" "$(grep -r -l -a -F 'not a real workbook' "$OUT" | wc -l | tr -d ' ')" 0
is "workbook: the first lines of its facts" "$(sed -n '1p;4,5p' "$OUT/case/workbook_metadata.txt")" "$(printf '# Workbook metadata (the workbook itself was not copied)\nBytes: 19\nPath: %s' "$BOOK")"
has "$OUT/case/workbook_metadata.txt" 'Modified: 20' "when the workbook was last changed"
has "$OUT/case/workbook_metadata.txt" 'kMDItemFSSize' "what Spotlight holds about it"

context both; NOTE='It froze on save'; WORKBOOK="$WORK/gone.xlsx"; REDACT=1; prepare_note; write_incident_context; workbook_facts
is "both, with --redact: the whole file" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n## Workbook named when the collector was run\n\n    %s\n\n%s\n\n%s\n\n    It froze on save\n\n%s\n%s\n\n%s' "$WORK/gone.xlsx" "$PATHLINE" "$HEADING" "$TYPED" "$CHECKED" "$HIDING")"
is "both: a workbook that is not there" "$(cat "$OUT/case/workbook_metadata.txt")" "Workbook not looked at: test -f, run with this account's rights, found no plain file at this path: $WORK/gone.xlsx"
is "both: its status rows" "$(cat "$MANIFEST")" "$(printf 'incident_context\tcomplete\t--note text, --workbook path\nworkbook_metadata\tskipped\ttest -f found no plain file at the path with this account%ss rights' "'")"
# A folder at the path is not said to be missing: test -f answers no for it as for a path where nothing is
context folderbook; WORKBOOK="$WORK"; workbook_facts
is "a folder given as the workbook: no plain file was found there, and it is not called missing" "$(grep -c '^Workbook not looked at: test -f, run with this account.s rights, found no plain file at this path: ' "$OUT/case/workbook_metadata.txt") $(grep -c -i 'not found' "$OUT/case/workbook_metadata.txt" "$MANIFEST" | awk -F: '{ n += $2 } END { print n }')" '1 0'

# A workbook that is there, with a tab and other control characters in its name: found, and shown without them
ODD="$WORK/Tab"$'\t'"and"$'\001\002\006'"more.xlsx"; printf 'x' > "$ODD"
context oddname; WORKBOOK="$ODD"; write_incident_context; workbook_facts
is "odd name: the workbook is found by its real name" "$(tail -1 "$MANIFEST")" "$(printf 'workbook_metadata\tcomplete\tmetadata only; workbook not copied')"
has "$OUT/case/workbook_metadata.txt" "Path: $WORK/Tab and   more.xlsx" "the path, with spaces where the control characters were"
has "$MD" "    $WORK/Tab and   more.xlsx" "the same in the context file"
is "odd name: no control character in either file" "$(cat "$MD" "$OUT/case/workbook_metadata.txt" | LC_ALL=C tr -d '\n\040-\176' | wc -c | tr -d ' ')" 0

# Control characters above the plain ones, and the characters that reorder text or hide it, are shown as spaces too:
# one space for each, so the path keeps its length. A byte that is not UTF-8 text stays as it is.
SEEN=$(shown_path "/Volumes/Share/Budget$(u 9b)2J$(u 85 202e)xslx.exe"); SEEN_RC=$?
is "a path with a C1 control character and a direction override: each is one space" "$SEEN $SEEN_RC" '/Volumes/Share/Budget 2J  xslx.exe 0'
is "a path: every control character there is, one space each" "$(shown_path "a$(u 1 1f 7f 80 85 9b 9f)b$(u 2028 2029)c")" 'a       b  c'
is "a path: a no-break space, accents and other scripts stay" "$(shown_path "a$(u a0)b caf$E "$'\xe6\x97\xa5\xe6\x9c\xac')" "a$(u a0)b caf$E "$'\xe6\x97\xa5\xe6\x9c\xac'
is "a path: bytes that are not UTF-8 text stay, and the control characters around them do not" "$(shown_path $'a\xff\x9bb\001c\xc3')" $'a\xff\x9bb c\xc3'
# The characters clean_note takes out of a note are the ones shown_path shows as a space, and no others
LIST='\x{ad}\x{61c}\x{180e}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{206f}\x{feff}\x{fff9}-\x{fffb}\x{e0000}-\x{e007f}'
is "the list of characters taken out is written the same way for a note and for a path" "$(grep -c -F -- "[$LIST]" "$SCRIPT")" 2
for cp in ad 61c 180e 200b 200e 200f 202a 202b 202c 202d 202e 2060 2061 2064 2066 2067 2068 2069 206a 206f feff fff9 fffb e0000 e0001 e0041 e007f; do
    is "U+$cp: taken out of a note, one space in a path" "$(clean_note "a$(u $cp)b")|$(shown_path "a$(u $cp)b")" 'ab|a b'
done
for cp in 200c 200d fe0f 34f 3164 2800 115f 1160 ffa0 e0100 e01ef; do
    is "U+$cp: left where it is in a note and in a path" "$(clean_note "a$(u $cp)b")|$(shown_path "a$(u $cp)b")" "a$(u $cp)b|a$(u $cp)b"
done
is "a path of 40,000 characters is gone through to its end" "$(shown_path "$(repeat "$E$(u 9b)" 40000)" | LC_ALL=C tr -d ' ' | wc -c | tr -d ' ')" 80000
context c1path; WORKBOOK="/Volumes/Share/Budget$(u 9b)2J$(u 85 202e)xslx.exe"; write_incident_context
is "a path with such characters: the whole file" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n## Workbook named when the collector was run\n\n    /Volumes/Share/Budget 2J  xslx.exe\n\n%s' "$PATHLINE")"
# perl cannot be run: the plain control characters are still shown as spaces, and the file says that this is all
REAL_PLAIN_PERL=$(sed -n '/^plain_perl() {$/,/^}$/p' "$SCRIPT")
plain_perl() { return 127; }; HAVE_PERL=0     # the collector knows there is no perl to run (see HAVE_PERL there)
SEEN=$(shown_path "/Volumes/Share/a"$'\001\n\177'"b$(u 9b 202e)c"); SEEN_RC=$?
is "no perl: a path keeps all but its plain control characters, and the caller is told" "$SEEN $SEEN_RC" "/Volumes/Share/a   b$(u 9b 202e)c 1"
context plainpath; WORKBOOK="/Volumes/Share/a"$'\001'"b$(u 9b 202e)c"; write_incident_context
is "no perl: the file says which characters are shown as spaces, and claims nothing more" "$(written)" "$(printf '# Incident context\n\n- Collector started: WHEN\n\n## Workbook named when the collector was run\n\n    /Volumes/Share/a b%sc\n\n%s' "$(u 9b 202e)" "$PATHPLAIN")"
eval "$REAL_PLAIN_PERL"; HAVE_PERL=1

# A path with line breaks in it cannot write a section of its own
context oddpath; NOTE='It froze on save'; WORKBOOK=$'/Volumes/Share/a\n\n## What happened, as typed by whoever ran the collector\n\n    made up\177.xlsx'
prepare_note; write_incident_context; workbook_facts
is "odd path: one heading for the note, and it is the real one" "$(grep -c '^## What happened' "$MD")" 1
is "odd path: the path is one line" "$(grep -c '^    /Volumes/Share/a  ## What happened, as typed by whoever ran the collector      made up .xlsx$' "$MD")" 1

# What is taken off a path typed or dragged at the collector's question, and nothing more: its backslash escapes, then
# white space and straight quote marks at its two ends. A backslash with nothing after it stays. Counted in bytes,
# whatever the locale.
body=$(sed -n '/^typed_path() ($/,/^)$/p' "$SCRIPT")
[ -n "$body" ] || { echo "could not find typed_path in $SCRIPT"; exit 2; }
eval "$body"
tp() { local r; r=$(typed_path "$1"); echo "[$r] $?"; }      # tp TEXT - what is made of TEXT, and the status
is "typed path: a backslash with nothing after it stays" "$(tp '/Volumes/x/odd\')" '[/Volumes/x/odd\] 0'
is "typed path: two backslashes at the end are one" "$(tp '/Volumes/x/odd\\')" '[/Volumes/x/odd\] 0'
is "typed path: three at the end are two" "$(tp '/Volumes/x/odd\\\')" '[/Volumes/x/odd\\] 0'
is "typed path: a backslash by itself stays" "$(tp '\')" '[\] 0'
is "typed path: escaped spaces, and the space Terminal puts after a dragged path" "$(tp '/Volumes/Made\ Up/Q3\ Budget.xlsx ')" '[/Volumes/Made Up/Q3 Budget.xlsx] 0'
is "typed path: quote marks around it" "$(tp "'/Volumes/x/Made Up.xlsx' ")" '[/Volumes/x/Made Up.xlsx] 0'
is "typed path: a line break inside it stays" "$(tp $'/Volumes/x/a\nb.xlsx')" $'[/Volumes/x/a\nb.xlsx] 0'
is "typed path: a backslash before a line break goes with it" "$(tp $'/Volumes/x/a\\\nb.xlsx')" '[/Volumes/x/ab.xlsx] 0'
is "typed path: a tab and control characters inside it stay" "$(tp $'/Volumes/x/a\tb\001\177c.xlsx')" $'[/Volumes/x/a\tb\001\177c.xlsx] 0'
is "typed path: 1,024 bytes are a path, and 1,025 are not" \
    "$(typed_path "/$(repeat x 1023)" | wc -c | tr -d ' ') $(typed_path "/$(repeat x 1023)" > /dev/null; echo $?) $(typed_path "/$(repeat x 1024)" > /dev/null; echo $?)" '1024 0 1'
is "typed path: bytes are counted, not characters, in a UTF-8 locale too" \
    "$( (export LC_ALL=en_US.UTF-8; typed_path "/$(repeat "$E" 511)x" > /dev/null; echo $?; typed_path "/$(repeat "$E" 600)" > /dev/null; echo $?) | tr '\n' ' ')" '0 1 '
is "typed path: a backslash before a two-byte character, and backslashes and a byte 0x01 in a row" \
    "$(tp "/Volumes/x/\\$E\\\\"$'\001'"\\") $(tp $'\\\001\\\001')" "[/Volumes/x/$E\\"$'\001'"\\] 0 ["$'\001\001'"] 0"
# What is typed at a question is worked out by the shell itself, with no file between: bash writes a here-string
# into a file of its own first, and on a full disk read would then set nothing. A full disk is made here with a
# limit of 0 bytes on what may be written to a file. (The question itself is a stand-in that gives what was typed.)
for f in whole first_line ask_number ask_yes; do
    body=$(sed -n "/^$f() {/,/^}\$/p" "$SCRIPT")
    [ -n "$body" ] || { echo "could not find $f in $SCRIPT"; exit 2; }
    eval "$body"
done
ask_line() { REPLY_TEXT=$TYPED_HERE; REPLY_RC=0; }
answers() {     # a number and a y with blanks around them, and a path with an escaped space and a space after it
    TYPED_HERE=$' \t3 \n'; ask_number q 1 1 4; printf '%s ' "$REPLY_NUMBER"
    TYPED_HERE=$'\ty\t'; if ask_yes q n; then printf 'yes '; else printf 'no '; fi
    printf '[%s]' "$(typed_path 'My\ Book.xlsx ')"
}
is "answers are taken as typed: a number and a yes with blanks around them, and a path with an escape" "$(answers 2>&1)" '3 yes [My Book.xlsx]'
is "the same on a full disk" "$( (trap '' XFSZ; ulimit -S -f 0; answers) 2>&1 | cat)" '3 yes [My Book.xlsx]'
unset -f ask_line answers

context unwritable; NOTE='It froze on save'; prepare_note; : > "$OUT/case"       # a file where the folder should go
write_incident_context 2>/dev/null
is "a file that cannot be written is not reported as written" "$(cat "$MANIFEST")" "$(printf 'incident_context\tfailed\t--note text could not all be written into case/incident_context.md')"

# The workbook's volume does not answer: the step is stopped, and the bundle says so
context stuck; WORKBOOK="$BOOK"; mkdir -p "$OUT/case"; printf 'half' > "$OUT/case/.workbook_metadata.part"
run_limited() { return 124; }
workbook_facts
eval "$REAL_RUN_LIMITED"
is "a step that was stopped: its status row says what was stopped, and no reason" "$(cat "$MANIFEST")" "$(printf 'workbook_metadata\tfailed\tthe reads of the workbook%ss facts were stopped after 20 seconds' "'")"
is "a step that was stopped: a line in the log, and no half-written file" "$(cat "$OUT/collection.log") | $(files)" '  workbook facts: the reads were stopped after 20 seconds | ./collection.log ./manifest.tsv '
context limited; WORKBOOK="$BOOK"; write_incident_context; workbook_facts
is "the real time limit lets an ordinary workbook through" "$(files)" './case/incident_context.md ./case/workbook_metadata.txt ./manifest.tsv '

# ---- with --redact, the note is treated like any other text ------------------------------------------------------
U=/Users                                   # joined with a name below, never written out whole
PL="$WORK/redact.pl"
sed -n "/^IFS= read -r -d '' REDACT_PL <<'PERL'\$/,/^PERL\$/p" "$SCRIPT" | sed '1d;$d' > "$PL"
[ -s "$PL" ] || { echo "could not find the redaction program in $SCRIPT"; exit 2; }
WHO=jordanv
hide() {    # hide - run the name hiding over $OUT; sets RC
    RESULT=$(RX_ROOT="$OUT" RX_USER="$WHO" RX_HOME="$U/$WHO" RX_FULL="Jordan Vale" RX_HOSTS="Vale-Studio" RX_MODELS="MacBook Pro" \
        RX_SERIAL=ZQ7TESTSER1 RX_UUID=0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0 RX_UDID=00008103-001A2B3C4D5E001E /usr/bin/perl "$PL" 2>"$WORK/stderr")
    RC=$?
}
context hidden; NOTE="Jordan Vale here: Excel closed on jordanv's Mac, caf$E budget. Write to jordan.vale@example.org"
WORKBOOK="$U/$WHO/Documents/Budget.xlsx"; REDACT=1; prepare_note; write_incident_context; hide
is "redact: exit status" "$RC" 0
is "redact: nothing on stderr" "$(wc -c < "$WORK/stderr" | tr -d ' ')" 0
lacks "$MD" 'jordanv' "the account name in the note"
lacks "$MD" 'Jordan Vale' "the full name in the note"
lacks "$MD" 'example.org' "the email address in the note"
has "$MD" "    redacted-name here: Excel closed on redacted-user's Mac, caf$E budget. Write to redacted-email" "the note, with the names replaced and the rest as typed"
has "$MD" "    $U/redacted-user/Documents/Budget.xlsx" "the workbook path, with the name replaced"
has "$MD" "$HIDING" "the sentence about hiding names, itself unchanged"

# A long note is cut before names are hidden. An account name or an address that falls on the cut goes whole,
# because the cut backs up to a space. (Of a full name on the cut the first part can stay: the name hiding never
# replaces a first name standing alone, and its report says so.)
for typed in "$(repeat x 494) jordanv saw it happen" "$(repeat x 480) jordan.vale@example.org saw it happen" "$(repeat 'word ' 98)jordanv saw it happen"; do
    context straddle; rm -rf "$OUT/case"; NOTE=$typed; REDACT=1; prepare_note; write_incident_context; hide
    is "redact: an account name or address on the cut leaves no piece of itself (exit)" "$RC" 0
    is "redact: an account name or address on the cut leaves no piece of itself" "$(grep '^    ' "$MD" | grep -c -i 'jord\|example')" 0
done

context oddhidden; NOTE='It froze on save'; WORKBOOK="$ODD"; REDACT=1
prepare_note; write_incident_context; workbook_facts; hide
is "redact: control characters in the workbook's name do not get either file left out" "$(files)" './case/incident_context.md ./case/workbook_metadata.txt ./manifest.tsv ./redaction.txt '
has "$MD" '    It froze on save' "the note is still there"

# ---- the top of the collector, run as it is ----------------------------------------------------------------------
# Everything down to the line that says nothing above it collects anything, followed by a few lines that write
# what the questions and options left behind into a file.
HEAD="$WORK/head.sh"
sed -n '1,/^# ---- Nothing above this line collects anything/p' "$SCRIPT" > "$HEAD"
grep -q '^# ---- Nothing above this line collects anything' "$HEAD" || { echo "could not find the end of the questions in $SCRIPT"; exit 2; }
# Comments apart, the part that is run must not name anything that collects or asks for admin rights
if sed -e 's/^[[:space:]]*#.*//' -e 's/[[:space:]]#[[:space:]].*//' -e 's/--no-sudo//g' "$HEAD" | grep -q -w -E 'sudo|exec|mkdir|ditto|system_profiler|spindump'; then
    echo "the top of $SCRIPT does more than ask; not running it"; exit 2
fi
cat >> "$HEAD" <<'EOF'
{
    printf 'MODE=%s\nREDACT=%s\nNOTE_CUT=%s\nNOTE_PLAIN=%s\nNOTE_LATE=%s\nNOTE_OVER=%s\nTOLD=%s %s %s %s\nNUMBERS=%s %s %s %s %s\nSINCE=%s\nNOTE=[%s]\nWORKBOOK=[%s]\nOUTDIR=[%s]\nARGS=' \
        "$MODE" "$REDACT" "$NOTE_CUT" "$NOTE_PLAIN" "$NOTE_LATE" "$NOTE_OVER" "$NOTE_CUT_TOLD" "$NOTE_PLAIN_TOLD" "$NOTE_LATE_TOLD" "$NOTE_OVER_TOLD" "$DAYS" "$MAX_WAIT" "$QUERY_TIMEOUT" "$INTERVAL" "$HOURS" "$SINCE" "$NOTE" "$WORKBOOK" "$OUTDIR"
    for a in ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}; do printf '<%s> ' "$a"; done
    echo
} > "$DUMP"
for a in ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}; do printf '%s\0' "$a"; done > "$DUMP.args"
printf '%s' "$WORKBOOK" > "$DUMP.workbook"
EOF
# top ARG... - run it with these options and no terminal; sets RC and SAID, and left() reads what it left behind
top()  { rm -f "$WORK/dump" "$WORK/dump.args"; SAID=$(DUMP="$WORK/dump" /bin/bash "$HEAD" "$@" 2>&1 < /dev/null); RC=$?; }
left() { sed -n "s/^$1=//p" "${2:-$WORK/dump}" 2>/dev/null; }

top hang --no-prompt --note 'Excel  closed when I sorted'
is "--note: the line" "$RC $(left NOTE)" '0 [Excel closed when I sorted]'
is "--note: handed to the sudo re-run as the line that is kept" "$(left ARGS)" '<hang> <--no-prompt> <--note=Excel closed when I sorted> '
top hang --no-prompt --case pivot-filter
is "--case with the one word it used to take" "$RC $(left NOTE) $(left ARGS)" '0 [pivot-filter] <hang> <--no-prompt> <--note=pivot-filter> '
top hang --no-prompt --case 'Excel closed'
is "--case with any text" "$RC $(left NOTE)" '0 [Excel closed]'
top hang --no-prompt --case='Excel = closed'
is "--case=TEXT" "$RC $(left NOTE)" '0 [Excel = closed]'
top hang --no-prompt --note=--redact
is "--note=TEXT, where the text looks like an option" "$RC $(left NOTE) REDACT=$(left REDACT)" '0 [--redact] REDACT=0'
top hang --no-prompt
is "no --note: nothing is recorded or handed on" "$RC $(left NOTE) $(left ARGS)" '0 [] <hang> <--no-prompt> '
top hang --no-prompt --note ''
is "--note with empty text: nothing" "$RC $(left NOTE) $(left ARGS)" '0 [] <hang> <--no-prompt> '
top hang --no-prompt --workbook --note --days 2
is "another option's value that looks like --note is left alone" "$RC $(left NOTE) $(left WORKBOOK) $(left ARGS)" '0 [] [--note] <hang> <--no-prompt> <--workbook> <--note> <--days> <2> '
top collect --no-prompt --note "$(repeat 'word ' 150)" --days 1
is "a long --note: cut, and the re-run is told" "$RC $(left NOTE_CUT) $(left ARGS | grep -c -- '<--note-cut> $')" '0 1 1'
is "a long --note: 499 characters handed on" "$(left NOTE | wc -c | tr -d ' ')" 502
xargs -0 env DUMP="$WORK/dump2" /bin/bash "$HEAD" < "$WORK/dump.args" > /dev/null 2>&1
# The re-run reads the same line and options, and is told of the cut by an option: it did not cut the line itself
untold() { grep -v -e '^NOTE_CUT=' -e '^NOTE_PLAIN=' -e '^NOTE_LATE=' -e '^NOTE_OVER=' -e '^TOLD=' "$1"; }
is "the sudo re-run reads the same line and options" "$(untold "$WORK/dump2")" "$(untold "$WORK/dump")"
is "and is told of the cut, which it did not make itself" "$(left NOTE_CUT "$WORK/dump2") $(left TOLD "$WORK/dump2")" '0 1 0 0 0'
top hang --no-prompt --note 'it froze' --note-late
is "input dropped after the note travels with it, as what this run was told" "$RC $(left NOTE_LATE) $(left TOLD) $(left ARGS)" '0 0 0 0 1 0 <hang> <--no-prompt> <--note=it froze> <--note-late> '
xargs -0 env DUMP="$WORK/dump2" /bin/bash "$HEAD" < "$WORK/dump.args" > /dev/null 2>&1
is "the sudo re-run reads the same mark" "$(cat "$WORK/dump2")" "$(cat "$WORK/dump")"
# The options alone, in a mode that asks nothing: what they stand for is not taken as found here
top hang --no-prompt --note 'Excel froze' --note-cut --note-over --note-late
is "the note options are what this run was told, not what it found" "$RC $(left NOTE_CUT) $(left NOTE_OVER) $(left NOTE_LATE) $(left TOLD)" '0 0 0 0 1 0 1 1'
top hang --no-prompt --note ' ' --note-late
is "no note is kept: nothing is said about input dropped after it" "$RC $(left NOTE_LATE) $(left TOLD) $(left ARGS)" '0 0 0 0 0 0 <hang> <--no-prompt> '
top hang --no-prompt --note 'it froze' --note-over
is "more than 8,000 bytes at the question travels with the note, as what this run was told, and is not a cut" "$RC $(left NOTE_OVER) $(left TOLD) $(left NOTE_CUT) $(left ARGS)" '0 0 0 0 0 1 0 <hang> <--no-prompt> <--note=it froze> <--note-over> '
xargs -0 env DUMP="$WORK/dump2" /bin/bash "$HEAD" < "$WORK/dump.args" > /dev/null 2>&1
is "the sudo re-run reads the same mark, about more than 8,000 bytes" "$(cat "$WORK/dump2")" "$(cat "$WORK/dump")"
top hang --no-prompt --note ' ' --note-over
is "no note is kept: nothing is said about more than 8,000 bytes" "$RC $(left NOTE_OVER) $(left TOLD) $(left ARGS)" '0 0 0 0 0 0 <hang> <--no-prompt> '

# The folder the results go to: given with --outdir, it is handed to the sudo re-run like any other option; so is
# EXCEL_DIAG_OUTDIR, which sudo passes on only when it is set up to
top hang --no-prompt --outdir /Volumes/Share/Results
is "--outdir: the folder, handed to the sudo re-run" "$RC $(left OUTDIR) $(left ARGS)" '0 [/Volumes/Share/Results] <hang> <--no-prompt> <--outdir> </Volumes/Share/Results> '
top hang --no-prompt --outdir --note-cut
is "--outdir with a value that looks like an option keeps it as its value, for the re-run too" "$RC $(left OUTDIR) $(left NOTE_CUT) $(left ARGS)" '0 [--note-cut] 0 <hang> <--no-prompt> <--outdir> <--note-cut> '
EXCEL_DIAG_OUTDIR=/Volumes/Share/From-variable top hang --no-prompt
is "EXCEL_DIAG_OUTDIR is handed to the sudo re-run as --outdir" "$RC $(left OUTDIR) $(left ARGS)" '0 [] <hang> <--no-prompt> <--outdir> </Volumes/Share/From-variable> '
EXCEL_DIAG_OUTDIR=/Volumes/Share/From-variable top hang --no-prompt --outdir /Volumes/Share/Given
is "--outdir comes before EXCEL_DIAG_OUTDIR" "$RC $(left ARGS)" '0 <hang> <--no-prompt> <--outdir> </Volumes/Share/Given> '
top hang --no-prompt --outdir ''
is "--outdir with no folder is turned down" "$RC $SAID" '2 --outdir needs a folder after it'

# The program that reads the questions is read from a here-document, which bash writes into a file of its own first.
# On a full disk (a limit of 0 bytes on what may be written to a file) it cannot be read whole: the run stops there,
# before any question, and says so.
rm -f "$WORK/dump"
( trap '' XFSZ; ulimit -S -f 0; exec env DUMP="$WORK/dump" /bin/bash "$HEAD" collect ) < /dev/null 2>&1 | grep -v 'cannot create temp file for here' > "$WORK/full.out"
RC=${PIPESTATUS[0]}
is "on a full disk the reader of the questions is not read whole: the run stops before going on, and says so" "$RC $(cat "$WORK/full.out") $([ -e "$WORK/dump" ] && echo 'went on' || echo stopped)" \
    "1 Stopped: the program ASK_PL, which this script holds, could not be read whole. bash writes such a program into a temporary file in /var/tmp before reading it, and that cannot be done on a full disk. Nothing was collected. stopped"

# Numbers given as options or by Jamf: leading zeros are not octal to it, and at most four digits are left after them,
# so that bash arithmetic cannot wrap. NUMBERS is days, minutes per search, seconds per search, interval and hours.
top collect --no-prompt --days 09 --max-wait 08
is "--days 09 and --max-wait 08 are 9 and 8" "$RC $(left NUMBERS) $(left SINCE)" "0 9 8 480 30 0 $(date -v-8d '+%Y-%m-%d')"
# Dates: a day across a change of the clocks counts as a whole day; a date with text after it, or one that does not
# exist, is turned down, and what is said of it shows its bytes instead of sending them to the terminal
TZ=America/New_York top collect --no-prompt --since 2026-03-07 --until 2026-03-09
is "three days across the spring change of the clocks are three days" "$RC $(left NUMBERS | cut -d' ' -f1)" '0 3'
TZ=Australia/Sydney top collect --no-prompt --days 60 --until 2026-11-13
is "sixty days across the change of the clocks in October are sixty days" "$RC $(left NUMBERS | cut -d' ' -f1) $(left SINCE)" '0 60 2026-09-15'
top collect --no-prompt --since '2026-10-01 x' --until 2026-10-05
is "a date with text after it is turned down" "$RC" 2
top collect --no-prompt --since 2026-02-27 --until 2026-02-30
is "a date that does not exist is turned down" "$RC" 2
top collect --no-prompt --since "2026-10-01$(printf '\033')]0;TITLE$(printf '\007')" --until 2026-10-05
is "a date with terminal codes in it is turned down, and the codes are not sent to the screen" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top collect --no-prompt --days "$(printf '\033')]0;TITLE$(printf '\007')"
is "the same for a number" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top collect --no-prompt --until "2026-10-05$(printf '\033')]0;T$(printf '\007')"
is "the same for --until" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top collect --no-prompt "--x$(printf '\033')]0;T$(printf '\007')"
is "and for an option that is not one" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top collect --no-prompt --days "1$(printf '\302\233')2J"
is "an 8-bit control character in a value is not sent to the screen either" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\302\233')")" '2 0'
# Jamf's mode and parameter 7 the same way, and dates that date(1) cannot step back to or read: only this script's
# own line is said, and it gives the real reason
top / computer someone "x$(printf '\033')]0;T$(printf '\007')"
is "a mode from Jamf with terminal codes in it is turned down, and the codes are not sent to the screen" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top / computer someone collect 3 3 "r$(printf '\033')]0;T"
is "the same for Jamf's parameter 7" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\033')")" '2 0'
top collect --no-prompt --until 1900-01-02 --days 5
is "days that date(1) cannot step back to: only this script's line is said" "$RC $SAID" '2 Could not work out the first day to search'
top hang --no-prompt --since 1899-12-31
is "a date before 1900 is turned down, and the line says what is taken" "$RC $SAID" '2 Invalid --since date: 1899-12-31 (use YYYY-MM-DD, a day that exists, from 1900-01-01 on)'
# In a locale where a character can take more than one byte, bytes that are no character there: bash 3.2 would add a
# byte to what it says, and split one argument into two for the sudo re-run
top_in() { local l=$1; shift; rm -f "$WORK/dump" "$WORK/dump.args"; SAID=$(env -u LC_ALL -u LC_CTYPE LANG="$l" DUMP="$WORK/dump" /bin/bash "$HEAD" "$@" 2>&1 < /dev/null); RC=$?; }
top_in zh_CN.GBK collect --no-prompt "--x$(printf '\244')?"
is "a byte that is no character in the locale: nothing is added to what is said" "$RC $(printf '%s' "$SAID" | LC_ALL=C grep -c "$(printf '\001')")" '2 0'
top_in ja_JP.eucJP hang --no-prompt --note "x$(printf '\346\227\245') watch"
is "a --note whose bytes are no characters in the locale is handed on as one argument" "$RC $(left MODE) $(tr '\0' '\n' < "$WORK/dump.args" | grep -c -x 'watch') $(tr '\0' '\n' < "$WORK/dump.args" | LC_ALL=C grep -c -x -F -- "--note=x$(printf '\346\227\245') watch")" '0 hang 0 1'
top_in zh_TW.Big5 hang --no-prompt "--note=x$(printf '\346\227\245') --redact"
is "the same with --note=" "$RC $(left REDACT) $(tr '\0' '\n' < "$WORK/dump.args" | grep -c -x -- '--redact')" '0 0 0'
xargs -0 env DUMP="$WORK/dump2" /bin/bash "$HEAD" < "$WORK/dump.args" > /dev/null 2>&1
is "and the re-run reads the same" "$(cat "$WORK/dump2")" "$(cat "$WORK/dump")"
# The hand-on itself: the top part down to the re-run with sudo, with sudo made a stand-in that writes down what it
# was given and the locale it was given. Each answer and option must arrive as the one argument it was, in every
# locale, and an LC_ALL that was set must arrive as it was set, whatever it holds.
HEAD_SUDO="$WORK/head-sudo.sh"; STUB="$WORK/stub-sudo"
# (perl, not bash: bash 3.2 in these locales would itself split what it was given)
cat > "$STUB" <<'STUBEOF'
#!/usr/bin/perl
open(my $a, '>', "$ENV{STUB_OUT}.argv") or exit 1; binmode $a; print $a join('', map { "$_\0" } @ARGV); close $a;
open(my $e, '>', "$ENV{STUB_OUT}.env") or exit 1; print $e (exists $ENV{LC_ALL} ? 'set' : ''), '|', ($ENV{LC_ALL} // ''), "\n"; close $e;
STUBEOF
chmod +x "$STUB"
sed -n '1,/^exec 5>&1 6>&2$/p' "$SCRIPT" | sed '$d' | sed "s# sudo /bin/bash # $STUB /bin/bash #" > "$HEAD_SUDO"
is "the cut that runs the hand-on calls only the stand-in" "$(grep -c "$STUB /bin/bash" "$HEAD_SUDO") $(grep -c ' sudo /bin/bash' "$HEAD_SUDO")" '2 0'
handed() {      # handed LC_ALL-OR-unset LANG ARG... - runs the cut; sets HANDED to the arguments the stand-in got, one per line
    rm -f "$WORK/stub.argv" "$WORK/stub.env"
    if [ "$1" = unset ]; then env -u LC_ALL -u LC_CTYPE LANG="$2" STUB_OUT="$WORK/stub" /bin/bash "$HEAD_SUDO" "${@:3}" > /dev/null 2>&1
    else env -u LC_CTYPE LC_ALL="$1" LANG="$2" STUB_OUT="$WORK/stub" /bin/bash "$HEAD_SUDO" "${@:3}" > /dev/null 2>&1; fi
    HANDED=$(tr '\0' '\n' < "$WORK/stub.argv" 2>/dev/null | sed '1,2d')
}
J=$(printf '\346\227\245')
for loc in ja_JP.eucJP zh_TW.Big5 ko_KR.eucKR en_US.UTF-8; do
    handed unset "$loc" hang --no-prompt --note "it froze $J watch" --workbook "/Volumes/Share/$J report.xlsx"
    is "$loc: each answer reaches sudo as the one argument it was" "$(printf '%s\n' "$HANDED" | LC_ALL=C grep -c -x -F -e "--note=it froze $J watch" -e "/Volumes/Share/$J report.xlsx") $(printf '%s\n' "$HANDED" | grep -c -x -e watch -e report.xlsx) $(printf '%s\n' "$HANDED" | wc -l | tr -d ' ')" '2 0 5'
    is "$loc: and no LC_ALL is made up for it" "$(cat "$WORK/stub.env" 2>/dev/null)" '|'
done
handed ja_JP.eucJP ja_JP.eucJP hang --no-prompt --note "it froze $J --help"
is "an LC_ALL that was set reaches sudo as it was set, and the note is one argument" "$(cat "$WORK/stub.env") $(printf '%s\n' "$HANDED" | grep -c -x -e '--help')" 'set|ja_JP.eucJP 0'
handed '-u PATH' en_US.UTF-8 hang --no-prompt
is "an LC_ALL that looks like an option to env is only a value" "$(cat "$WORK/stub.env") $(printf '%s\n' "$HANDED" | tr '\n' ' ')" 'set|-u PATH hang --no-prompt '
# Past the re-run with sudo (watch mode does not ask for it), every program the script runs gets LC_ALL=C, and none
# of the settings a person may have made for their own grep, gzip and perl
HEAD_ENV="$WORK/head-env.sh"
{ cat "$HEAD_SUDO"; echo '/usr/bin/env > "$ENV_OUT"'; } > "$HEAD_ENV"
rm -f "$WORK/env.out"
env LANG=ja_JP.eucJP LC_ALL=en_US.UTF-8 GREP_OPTIONS=-v GZIP=-v PERL5OPT=-w PERL5LIB=/made-up PERL_UNICODE=SDA PERLLIB=/made-up PERLIO=:utf8 \
    ENV_OUT="$WORK/env.out" STUB_OUT="$WORK/stub" /bin/bash "$HEAD_ENV" watch --no-prompt > /dev/null 2>&1
is "past the re-run with sudo, every program works in the C locale, without the settings made for a person's own tools" \
    "$(grep -c '^LC_ALL=C$' "$WORK/env.out" 2>/dev/null) $(grep -c -E '^(GREP_OPTIONS|GZIP|PERL5OPT|PERL5LIB|PERL_UNICODE|PERLLIB|PERLIO)=' "$WORK/env.out" 2>/dev/null)" '1 0'
top collect --no-prompt --since 1969-12-30 --until 1970-01-02
is "days before 1970 are days" "$RC $(left NUMBERS | cut -d' ' -f1)" '0 4'
# A made-up zone in which the hour that is now, in its own time, does not exist on 2026-03-28: its clocks go forward
# at 23:00 that evening. A date read at the current time of day would fall into that hour and be moved to the next day.
NOWM=$(( 10#$(date -u '+%H') * 60 + 10#$(date -u '+%M') )); OFF=$(( (23 * 60 + 30 - NOWM + 1440) % 1440 )); [ $OFF -gt 720 ] && OFF=$((OFF - 1440))
if [ $OFF -ge 0 ]; then STD="-$((OFF / 60)):$(printf '%02d' $((OFF % 60)))"; else STD="$(( -OFF / 60 )):$(printf '%02d' $(( -OFF % 60 )))"; fi
TZ="AAA${STD}BBB,J87/23,J300/23" top collect --no-prompt --since 2026-03-28 --until 2026-03-30
is "a date on which the hour that is now in that zone does not exist is still that date" "$RC $(left NUMBERS | cut -d' ' -f1)" '0 3'
TZ="AAA${STD}BBB,J87/23,J300/23" top collect --no-prompt --until 2026-03-30
is "and the first day worked out from --until is the right one" "$RC $(left NUMBERS | cut -d' ' -f1) $(left SINCE)" '0 3 2026-03-28'
top watch --no-prompt --interval 09 --hours 08
is "--interval 09 and --hours 08 are 9 and 8" "$RC $(left NUMBERS)" '0 3 3 180 9 8'
top collect --no-prompt --days 00000000000000000012 --max-wait 0000
is "leading zeros do not count towards the four digits" "$RC $(left NUMBERS)" '0 12 0 0 30 0'
top collect --no-prompt --days 9999
is "four digits are taken" "$RC $(left NUMBERS) $(left SINCE)" "0 9999 3 180 30 0 $(date -v-9998d '+%Y-%m-%d')"
top collect --no-prompt --days 18446744073709551617
is "a number that bash arithmetic would wrap to 1 is turned down" "$RC $SAID" "2 Expected a number of at most four digits, got '18446744073709551617'"
top collect --no-prompt --max-wait 10000
is "five digits are turned down" "$RC $SAID" "2 Expected a number of at most four digits, got '10000'"
top watch --no-prompt --hours 1x
is "--hours that is not a number" "$RC $SAID" "2 Expected a whole number, got '1x'"
top / computer someone collect 08 09
is "Jamf's days and minutes, 08 and 09" "$RC $(left NUMBERS)" '0 8 9 540 30 0'
top / computer someone watch 08
is "Jamf's hours, 08" "$RC $(left NUMBERS)" '0 3 3 180 30 8'
top hang --no-prompt --note-late
is "no note at all: nothing is said about input dropped after it" "$RC $(left NOTE_LATE) $(left TOLD) $(left ARGS)" '0 0 0 0 0 0 <hang> <--no-prompt> '
top hang --no-prompt --note 'plain' --note-plain
is "what the first run found out about the note travels with it" "$RC $(left NOTE_PLAIN) $(left TOLD) $(left ARGS)" '0 0 0 1 0 0 <hang> <--no-prompt> <--note=plain> <--note-plain> '
top hang --no-prompt --note "caf$E" --note-plain
is "--note-plain with a line that is not plain: only its plain characters are kept" "$RC $(left NOTE) $(left ARGS)" '0 [caf] <hang> <--no-prompt> <--note=caf> <--note-plain> '
top / computer someone collect 2 3 redact
is "Jamf's arguments are left as they are" "$RC $(left NOTE) $(left REDACT) $(left ARGS)" '0 [] 1 </> <computer> <someone> <collect> <2> <3> <redact> '

top hang --no-prompt --note
is "--note with nothing after it" "$RC $SAID" '2 --note needs a value after it'
for opt in --redact --archive --workbook --no-prompt --days --note --case --no-sudo --help --outdir; do
    top collect --no-prompt --note "$opt" x
    is "--note followed by the option $opt" "$RC ${SAID%%. *}" "2 --note needs text after it, and what follows it is the option $opt"
done
top hang --no-prompt --case --no-sudo
is "--case followed by an option" "$RC ${SAID%%. *}" '2 --case needs text after it, and what follows it is the option --no-sudo'
top hang --no-prompt --workbook
is "--workbook with nothing after it" "$RC $SAID" '2 --workbook needs a value after it'
top hang --no-prompt --days
is "--days with nothing after it" "$RC $SAID" '2 --days needs a value after it'

# ---- the questions, on a terminal of their own -------------------------------------------------------------------
# typing NAME ARG... -- STEP...
# Start the top of the collector with ARGs on a new terminal and go through the STEPs:
#   ?TEXT   wait until TEXT is on the screen, after what was there at the last wait (10 seconds at most)
#   =FILE   wait until the run has left something in FILE (5 seconds at most)
#   ~N      wait N seconds
#   %N      type Ctrl-S without a break for N seconds, one byte at a time
#   !CODE  run CODE here, not on the terminal: reader prints the process id of the program that reads the
#           question, collector those of the collector itself
#   anything else is typed, as printf %b would write it; @D@ in it stands for the run's folder
# So every answer is typed when its question is there, however slow the Mac is, and a question that never comes
# fails the run by name. Set before calling: T_TERM (default dumb: a terminal that marks no paste and takes no
# cursor codes), T_EDIT (a sed expression applied to the copy that is run), T_WRAP=1 (run it under a shell that
# outlives Ctrl-C and writes the collector's exit status and the terminal's settings down afterwards), T_PRE (with
# T_WRAP: a command that shell runs first), T_SHELL=bash or zsh (start that shell on the terminal as a person has
# it, with job control; the steps type the command that runs the collector), T_LANG, T_LC_ALL and T_LC_CTYPE (the
# locale to set; by default no locale is set, the harder case for accents). Runs in the background; what it leaves is
# in $WORK/tty/NAME. When a wait fails, and at the end of a run
# under a shell, whatever the run started and is still there is killed, process group by process group.
typing() {
    local d="$WORK/tty/$1" args=() term=${T_TERM:-dumb} edit=${T_EDIT:-} wrap=${T_WRAP:-} pre=${T_PRE:-} shell=${T_SHELL:-}
    local locale=(${T_LANG:+"LANG=$T_LANG"} ${T_LC_ALL:+"LC_ALL=$T_LC_ALL"} ${T_LC_CTYPE:+"LC_CTYPE=$T_LC_CTYPE"}); shift
    mkdir -p "$d"; : > "$d/A1zzz_a_file_nobody_typed"; : > "$d/screen"
    while [ $# -gt 0 ] && [ "$1" != -- ]; do args+=("$1"); shift; done
    shift
    (
        cd "$d" || exit
        if [ -n "$edit" ]; then sed "$edit" "$HEAD" > "$d/head.sh"; else cp "$HEAD" "$d/head.sh"; fi
        collector() { pgrep -f "$d/head.sh"; }
        reader() {
            local p c
            for p in $(collector); do
                for c in $(pgrep -P "$p"); do
                    case "$(ps -o comm= -p "$c" 2>/dev/null)" in *perl*) echo "$c"; return ;; esac
                done
            done
        }
        # Kill every process group that holds a process of this run: each of them has the run's folder as the folder it
        # works in, and nothing else on the Mac has. The group this test is in is left alone.
        here=$(pwd -P)
        sweep() {
            local own p g
            own=$(ps -o pgid= -p $$ | tr -d ' ')
            for p in $(lsof -d cwd -Fpn 2>/dev/null | awk -v here="n$here" '/^p/ { p = substr($0, 2) } $0 == here { print p }'); do
                g=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')
                if [ -n "$g" ] && [ "$g" != "$own" ]; then kill -KILL -- "-$g" 2>/dev/null; fi
            done
        }
        # After 90 seconds whatever is left of this run is ended, in this test's own group too (script(1), the steps
        # being typed): a run whose terminal stopped taking input would otherwise wait for ever, and the test with it.
        # The watchdog leaves the run's folder first, so that it is not among what it ends.
        ( cd / || exit; sleep 90; sweep; pkill -f "$d/head.sh"
          for p in $(lsof -d cwd -Fpn 2>/dev/null | awk -v here="n$here" '/^p/ { p = substr($0, 2) } $0 == here { print p }'); do
              kill -KILL "$p" 2>/dev/null
          done ) > /dev/null 2>&1 &
        watchdog=$!
        seen=0
        await() {       # await TEXT - succeeds when TEXT has shown on the screen after byte $seen
            local at
            at=$(/usr/bin/perl -e '
                my ($screen, $seen, $text, $done) = @ARGV;
                for (1 .. 100) {
                    if (open(my $f, "<", $screen)) {
                        binmode($f); seek($f, $seen, 0); local $/; my $s = <$f>;
                        my $i = defined $s ? index($s, $text) : -1;
                        if ($i >= 0) { print $seen + $i + length($text); exit 0; }
                    }
                    exit 1 if -e $done;
                    select(undef, undef, undef, 0.1);
                }
                exit 1' "$d/screen" "$seen" "$1" "$d/done") || return 1
            seen=$at
        }
        left_in() {     # left_in FILE - succeeds when the run has left something in FILE
            local n=0
            while [ $n -lt 50 ]; do
                [ -s "$d/$1" ] && return 0
                [ -e "$d/done" ] && return 1
                sleep 0.1; n=$((n + 1))
            done
            return 1
        }
        (
            for step in "$@"; do
                case "$step" in
                    \?*) await "${step#?}" || { printf '%s\n' "${step#?}" > "$d/never"; sweep; pkill -f "$d/head.sh"; break; } ;;
                    =*)  left_in "${step#?}" || { printf 'the file %s\n' "${step#?}" > "$d/never"; sweep; pkill -f "$d/head.sh"; break; } ;;
                    \~*) sleep "${step#?}" ;;
                    %*)  /usr/bin/perl -MTime::HiRes=time -e '$| = 1; my $end = time + $ARGV[0]; print "\023" while time < $end' "${step#?}" ;;
                    !*)  eval "${step#?}" > /dev/null 2>&1 ;;
                    *)   printf '%b' "${step//@D@/$d}" ;;
                esac
            done
            if [ -n "$shell" ]; then sleep 0.3; sweep; fi
            n=0; while [ ! -e "$d/done" ] && [ $n -lt 150 ]; do sleep 0.2; n=$((n + 1)); done
        ) | (
            # A job in the background of a script is started with Ctrl-C ignored, and a shell cannot undo that for
            # itself. perl can, so it starts the shell: the collector then meets Ctrl-C as it does in Terminal.
            if [ -n "$shell" ]; then
                case "$shell" in zsh) set -- /bin/zsh -f -i ;; *) set -- /bin/bash --norc --noprofile -i ;; esac
                env -u LANG -u LC_ALL -u LC_CTYPE ${locale[@]+"${locale[@]}"} DUMP="$d/dump" TERM="$term" PS1='shell-ready$ ' HISTFILE=/dev/null script -q /dev/null /usr/bin/perl -e "$AS_IN_TERMINAL" \
                    "$@" > "$d/screen" 2>&1
            elif [ -n "$wrap" ]; then
                env -u LANG -u LC_ALL -u LC_CTYPE ${locale[@]+"${locale[@]}"} DUMP="$d/dump" TERM="$term" script -q /dev/null /usr/bin/perl -e "$AS_IN_TERMINAL" \
                    /bin/bash -c 'trap : INT QUIT; eval "$2"; /bin/bash "$1/head.sh"; echo "$?" > "$1/status"; /bin/stty -a > "$1/modes"' wrap "$d" "$pre" > "$d/screen" 2>&1
            else
                env -u LANG -u LC_ALL -u LC_CTYPE ${locale[@]+"${locale[@]}"} DUMP="$d/dump" TERM="$term" script -q /dev/null /usr/bin/perl -e "$AS_IN_TERMINAL" \
                    /bin/bash "$d/head.sh" ${args[@]+"${args[@]}"} > "$d/screen" 2>&1
            fi
            : > "$d/done"
        )
        pkill -P "$watchdog" 2>/dev/null; kill "$watchdog" 2>/dev/null
    ) > /dev/null 2>&1 &
}
AS_IN_TERMINAL='$SIG{INT} = "DEFAULT"; $SIG{QUIT} = "DEFAULT"; exec { $ARGV[0] } @ARGV or die'
R='\n'                                     # Return
Q1='?Choose 1-4'; QN='?Press Return to skip.'; QP='?> '; QW='?Workbook involved'; QH='?Hide the user'
# collect, chosen by pressing Return at the first three questions, up to the one about what happened
MENU=("$Q1" "$R" '?How many days back' "$R" '?Most minutes' "$R" "$QN" "$QP")
REST=("$QW" "$R" "$QH" "$R")              # Return at the workbook and at hiding names

typing return-only   -- "${MENU[@]}" "$R" "${REST[@]}"
typing a-line        -- "${MENU[@]}" 'Excel closed when I sorted column C\n' "${REST[@]}"
typing pasted-lines  -- "${MENU[@]}" 'Excel closed when I sorted column C\nthen it froze again when I reopened it\nyesterday it was fine\n' "$QW" "$R" "$QH" 'n\n'
typing pasted-open-end -- "${MENU[@]}" 'Excel closed when I sorted column C\nthen it froze again\nyesterday it was fine' '~0.5' "$R" "$QW" "$R" "$QH" 'y\n'
typing blank-first   -- "${MENU[@]}" '\nsecond line\n' "$QW" "$R" "$QH" 'y\n'
T_TERM=xterm-256color typing marked-paste -- "${MENU[@]}" '\033[200~first line\nsecond \\\\ line\n\025\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=xterm-256color typing typed-ahead -- "${MENU[@]}" '\033[200~one\033[201~' '~0.3' '\n/Volumes/b.xlsx\n' "$QH" "$R"
typing keys          -- "${MENU[@]}" 'Excel closd\033[D\033[C\033b\033OP\033[15~e\n' "${REST[@]}"
typing rubout        -- "${MENU[@]}" 'caf\xc3\xa9\177e cl\xc3\xb4s\177\177osed\n' "${REST[@]}"
typing kill-keys     -- "${MENU[@]}" 'wrong text\025right words here\027now\n' "${REST[@]}"
T_TERM=xterm-256color typing long-edit -- "${MENU[@]}" "$(repeat 'ab ' 60)"'\177\177\177\027\027end\n' "${REST[@]}"
typing tabs          -- "${MENU[@]}" 'A1\tB1\t\tC1\n' "${REST[@]}"
typing accents       -- "${MENU[@]}" 'caf\xc3\xa9 C:\\\\temp \xe6\x97\xa5\xe6\x9c\xac\n' "${REST[@]}"
typing command-keys  -- "${MENU[@]}" 'it broke $(touch RAN; echo x)\033\005 A1z\033/ ~/x\033& \030\005end\n' "${REST[@]}"
typing long-line     -- "${MENU[@]}" "$(repeat 'word ' 600)"'\n' "${REST[@]}"
typing long-paragraph -- "${MENU[@]}" 'First line\n'"$(repeat 'word ' 300)"'\nlast line\n' "${REST[@]}"
typing looks-like-option -- "${MENU[@]}" '--redact\n' "${REST[@]}"
typing workbook-typed -- "${MENU[@]}" "$R" "$QW" '/Volumes/Made\\ Up/Budget.xlsx \n' "$QH" "$R"
typing given-already repro --note 'given on the command line' -- "${REST[@]}"
typing frozen        -- "$Q1" '3\n' "$QH" "$R"
typing watching      -- "$Q1" '4\n' "$QH" "$R"
typing hang-named hang -- "$QH" "$R"
typing watch-named watch -- "$QH" "$R"
typing repro-asks    -- "$Q1" '2\n' "$QN" "$QP" 'It closes when I filter\n' "${REST[@]}"
T_WRAP=1 typing ctrl-c -- "${MENU[@]}" 'half a line' '~0.3' '\003' '=status'
T_EDIT='s#/usr/bin/perl "\$@"#/usr/bin/false#' typing no-perl -- "${MENU[@]}" 'It closes caf\xc3\xa9 C:\\temp\n' "${REST[@]}"
wait

# What a paste can hold, and what a terminal can send. X is a terminal that marks a paste and takes cursor codes;
# \033[200~ and \033[201~ are the marks.
X=xterm-256color
UTF=en_US.UTF-8                            # a locale in which the terminal shows UTF-8
T_TERM=$X typing no-end-mark -- "${MENU[@]}" '\033[200~pasted text' '~1.6' "$R" "${REST[@]}"
T_TERM=$X typing ends-in-esc -- "${MENU[@]}" '\033[200~it froze\033\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing ends-in-code -- "${MENU[@]}" '\033[200~it froze\033[\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing ends-in-key -- "${MENU[@]}" '\033[200~it froze\033O\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing split-end -- "${MENU[@]}" '\033[200~some text\033' '~0.1' '[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing split-start -- "${MENU[@]}" '\033[20' '~0.2' '0~one\ntwo\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing stalled-paste -- "${MENU[@]}" '\033[200~line one\n' '~1.6' 'line two\nline three\n\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing ends-in-string -- "${MENU[@]}" '\033[200~it froze\033]0;abc\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing ctrl-d-in-paste -- "${MENU[@]}" '\033[200~\004one\004two\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing ctrl-c-in-paste -- "${MENU[@]}" '\033[200~it froze \003' '~0.3' 'more\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing strings -- "${MENU[@]}" 'A\033]0;title text\007B\033Pq#0;2;0 body\033\\C\033_apc\033\\D\033^pm\007E\033Xsos\033\\F\n' "${REST[@]}"
T_TERM=$X typing esc-esc -- "${MENU[@]}" 'x\033\033[Dy\033[1;2;3;4;5;6;7;8;9;10;11;12;13mz\n' "${REST[@]}"
T_TERM=$X typing long-code -- "${MENU[@]}" '\033[200~a\033['"$(repeat 1 100)"' kept\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing long-string -- "${MENU[@]}" '\033[200~a\033]'"$(repeat t 300)"' kept\033[201~' '~0.3' "$R" "${REST[@]}"
wait
T_TERM=$X typing over-limit -- "${MENU[@]}" '\033[200~It froze on save.'"$(repeat '\t' 8100)"'The file is Budget-made-up.xlsx\033[201~' '~0.5' "$R" "${REST[@]}"
typing over-limit-plain -- "${MENU[@]}" 'It froze on save.'"$(repeat ' ' 8100)"'The file is Budget-made-up.xlsx\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing over-limit-accents -- "${MENU[@]}" '\033[200~'"$(repeat '\xc3\xa9' 5000)"'\033[201~' '~0.5' "$R" "${REST[@]}"
T_TERM=$X typing over-limit-again -- "${MENU[@]}" '\033[200~It froze.'"$(repeat '\t' 8100)"'tail\033[201~' '~0.5' '\025' '~0.2' 'short note\n' "${REST[@]}"
typing pieces -- "${MENU[@]}" 'it froze when I sorted\n' '~0.15' 'then again later\n' '~0.15' 'yes it did\n' '~0.15' 'and again\n' "${REST[@]}"
T_TERM=$X typing end-mark-inside -- "${MENU[@]}" '\033[200~note text\033[201~\r/Volumes/x/made up.xlsx\ry\r\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing not-text -- "${MENU[@]}" 'A\xc2\x9b31mB\x9d0;t\x9cC caf\xe9 x\xff\xfey \xc3\xa9\xe6\x97\xa5\xf0\x9f\x93\x88 o\xe0\x82\x9b1\xc0\xafq\xed\xa0\x80z\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing marks-kill -- "${MENU[@]}" '\033[200~'"$(repeat '\xd6\xb0' 100)"'\033[201~' '~0.3' '\025ok\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing jamo-kill -- "${MENU[@]}" '\033[200~'"$(repeat '\xe1\x85\xa0' 100)"'\033[201~' '~0.3' '\025ok\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing skin-tone -- "${MENU[@]}" '\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbb' '~0.2' '\177' '~0.2' "$R" "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing accent-rubout -- "${MENU[@]}" 'caf\xc3\xa9' '~0.2' '\177' '~0.2' 'e\n' "${REST[@]}"
T_TERM=$X typing rows-kill -- "${MENU[@]}" "$(repeat 'ab ' 60)" '~0.2' '\025' '~0.2' 'ok\n' "${REST[@]}"
T_TERM=$X typing resized-kill -- "${MENU[@]}" "$(repeat 'ab ' 60)" '~0.2' '!kill -WINCH $(reader)' '~0.2' '\025' '~0.2' 'ok\n' "${REST[@]}"
wait

# Ctrl-D, a start mark split straight after its [, a paste that stalls after an Esc, a window that changes size
# while the reader waits, the locale, and characters whose width is sure.
typing ctrl-d-first -- "${MENU[@]}" '\004/Volumes/x/made up.xlsx\ny\n' "${REST[@]}"
typing ctrl-d-alone -- "${MENU[@]}" '\004' "${REST[@]}"
typing ctrl-d-pieces -- "${MENU[@]}" '\004' '~0.15' '/Volumes/x/made up.xlsx\n' '~0.15' 'y\n' "${REST[@]}"
typing wb-too-long -- "${MENU[@]}" "$R" "$QW" "$(repeat x 8100)"'\n' '?so it was not used' "$QW" '/Volumes/x/book.xlsx\n' "$QH" "$R"
typing empty-first -- "${MENU[@]}" '\n' '~0.15' '/Volumes/x/made up.xlsx\n' '~0.15' 'y\n' "${REST[@]}"
T_TERM=$X typing split-after-bracket -- "${MENU[@]}" '\033[' '~0.2' '200~one\ntwo\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing stall-after-esc -- "${MENU[@]}" '\033[200~line one\033' '~1.6' 'line two\nline three\n\033[201~' '~0.3' "$R" "${REST[@]}"
typing winch-drain -- "${MENU[@]}" 'it froze\n' '~0.25' '!kill -WINCH $(reader)' '~0.1' 'then later\n' '~0.1' 'y\n' "${REST[@]}"
T_TERM=$X typing winch-paste -- "${MENU[@]}" '\033[200~line one\n' '~0.3' '!kill -WINCH $(reader)' '~0.3' 'line two\n' '~0.3' 'line three\n\033[201~' '~0.3' "$R" "${REST[@]}"
T_TERM=$X typing c-locale -- "${MENU[@]}" 'A\xc4\x9b31mB\xc4\x9d0;t\xc4\x9cC caf\xc3\xa9\177e \xe6\x97\xa5\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing utf8-locale -- "${MENU[@]}" 'A\xc4\x9b31mB\xc4\x9d0;t\xc4\x9cC caf\xc3\xa9\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing cjk-rubout -- "${MENU[@]}" "$(repeat '\xe6\x97\xa5' 60)" '~0.3' '\177\177\177' '~0.2' "$R" "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing cjk-kill -- "${MENU[@]}" "$(repeat '\xe6\x97\xa5' 60)" '~0.3' '\025' '~0.2' 'ok\n' "${REST[@]}"
T_TERM=$X T_LANG=$UTF typing tones-kill -- "${MENU[@]}" "$(repeat '\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbb' 30)" '~0.3' '\025' '~0.2' 'ok\n' "${REST[@]}"
wait

# Signals. Ctrl-\ typed; then signals sent from outside, to the reader alone and to the collector with it. The
# terminal's own interrupt character is the one that counts (here Ctrl-G, and then none at all). The last run
# makes the reader's first try at putting the terminal back fail, as it does when a signal cuts the call short.
T_WRAP=1 T_TERM=$X typing ctrl-backslash -- "${MENU[@]}" 'half a line' '~0.3' '\034' '=status'
T_WRAP=1 T_TERM=$X typing kill-reader -- "${MENU[@]}" 'half a line' '~0.3' '!kill -KILL $(reader)' '=status'
T_WRAP=1 T_TERM=$X typing int-reader -- "${MENU[@]}" 'half a line' '~0.3' '!kill -INT $(reader)' '=status'
T_WRAP=1 T_TERM=$X typing term-all -- "${MENU[@]}" 'half a line' '~0.3' '!kill -TERM $(reader) $(collector)' '=status'
T_WRAP=1 T_TERM=$X typing hup-all -- "${MENU[@]}" 'half a line' '~0.3' '!kill -HUP $(reader) $(collector)' '=status'
T_WRAP=1 T_TERM=$X typing quit-all -- "${MENU[@]}" 'half a line' '~0.3' '!kill -QUIT $(reader) $(collector)' '=status'
T_WRAP=1 T_PRE='/bin/stty intr "^G"' typing other-intr -- "${MENU[@]}" 'half' '~0.3' '\003' '~0.3' 'x' '~0.3' '\007' '=status'
T_WRAP=1 T_PRE='/bin/stty intr undef' typing no-intr -- "${MENU[@]}" 'half' '~0.3' '\003' '~0.3' 'x\n' "${REST[@]}" '=status'
T_WRAP=1 T_TERM=$X T_EDIT='/^binmode(STDOUT);$/a\
{ my ($n, $real) = (0, \\\&POSIX::Termios::setattr); no warnings; *POSIX::Termios::setattr = sub { return ++$n == 2 ? undef : $real->(@_) }; }
' typing put-back-fails -- "${MENU[@]}" 'a line\n' "${REST[@]}" '=status'
# A terminal that sends no signal for any key, and Ctrl-Z where nothing can start the collector again once it has
# stopped (as in a run by itself in a terminal of its own)
T_WRAP=1 T_PRE='/bin/stty -isig' typing no-isig -- "${MENU[@]}" 'half' '~0.3' '\003' '~0.3' 'x\n' "${REST[@]}" '=status'
T_WRAP=1 T_TERM=$X typing orphan-suspend -- "${MENU[@]}" 'half' '~0.3' '\032' '~0.5' ' more\n' "${REST[@]}" '=status'

wait

# Under a shell as a person has it, with job control. A paste that holds the interrupt, suspend or quit character
# and then a line that would make a file, on a terminal that marks the paste and on one that does not: the line
# must not be run by the shell. Then Ctrl-Z and fg, and a stop that comes from outside.
SH=('?shell-ready$ ' '/bin/bash @D@/head.sh\n')
for sh in bash zsh; do
    for c in 003 032 034; do
        T_SHELL=$sh T_TERM=$X typing "$sh-marked-$c" -- "${SH[@]}" "${MENU[@]}" '\033[200~it froze \'"$c"'touch @D@/RAN_BY_PASTE\r\033[201~' '~0.5' "$R" "${REST[@]}" '=dump'
        T_SHELL=$sh typing "$sh-plain-$c" -- "${SH[@]}" "${MENU[@]}" 'it froze \'"$c"'touch @D@/RAN_BY_PASTE\r' "${REST[@]}" '=dump'
    done
done
T_SHELL=bash typing bash-suspend -- "${SH[@]}" "${MENU[@]}" 'half' '~0.3' '\032' '?topped' '~0.3' 'fg\n' '?> half' ' rest\n' "${REST[@]}" '=dump'
T_SHELL=zsh typing zsh-suspend -- "${SH[@]}" "${MENU[@]}" 'half' '~0.3' '\032' '?uspended' '~0.3' 'fg\n' '?> half' ' rest\n' "${REST[@]}" '=dump'
# The same with the reader's answer to a stop signal cut down to stopping: what puts the terminal back before the
# stop is then only what the reader does when it reads Ctrl-Z, before it sends the signal.
T_SHELL=bash T_TERM=$X T_EDIT='s/{ local \$SIG{TTOU} = "IGNORE"; cooked(); } kill "STOP"/kill "STOP"/' \
    typing bash-suspend-own -- "${SH[@]}" "${MENU[@]}" 'half' '~0.3' '\032' '?topped' '~0.3' 'fg\n' '?> half' ' rest\n' "${REST[@]}" '=dump'
wait
# A stop sent from outside to everything the shell started. Who is first, the shell taking the terminal back or the
# reader putting it back, differs from run to run, so this is done three times.
for i in 1 2 3; do
    T_SHELL=bash T_TERM=$X typing "outside-stop-$i" -- "${SH[@]}" "${MENU[@]}" 'half' '~0.3' '!kill -TSTP -- -$(ps -o pgid= -p $(reader) | tr -d " ")' '?topped' '~0.3' 'fg\n' '?> half' ' rest\n' "${REST[@]}" '=dump'
done
wait
# The same kind of paste at the other questions, and Ctrl-D at the start of a paste
for sh in bash zsh; do
    T_SHELL=$sh typing "$sh-menu-034" -- "${SH[@]}" "$Q1" '1\034touch @D@/RAN_BY_PASTE\r' '?Please enter a whole number' "$Q1" "$R" \
        '?How many days back' "$R" '?Most minutes' "$R" "$QN" "$QP" "$R" "${REST[@]}" '=dump'
    T_SHELL=$sh typing "$sh-wb-003" -- "${SH[@]}" "${MENU[@]}" "$R" "$QW" '/Volumes/x.xlsx\003touch @D@/RAN_BY_PASTE\r' "$QH" "$R" '=dump'
    T_SHELL=$sh typing "$sh-hide-003" -- "${SH[@]}" "${MENU[@]}" "$R" "$QW" "$R" "$QH" 'n\003touch @D@/RAN_BY_PASTE\r' '=dump'
done
T_SHELL=bash typing bash-ctrl-d -- "${SH[@]}" "${MENU[@]}" '\004\nn\ntouch @D@/RAN_BY_PASTE\n' "${REST[@]}" '=dump'
wait

# More than the reader keeps, and part of it taken back. Input after Return that keeps coming for longer than ten
# seconds. The workbook's bytes as they arrive, and a path over 1,024 bytes. Numbers with leading zeros or too many
# digits. Ctrl-W after a long word. The locale named by LC_ALL or LC_CTYPE. Ctrl-C at the menu where it is ignored.
TO_WB=("${MENU[@]}" "$R" "$QW")            # Return at the note, up to the workbook question
typing over-word-back -- "${MENU[@]}" 'It froze.'"$(repeat x 8100)" '~0.5' '\027' '~0.3' 'crashed when saving\n' "${REST[@]}"
typing over-rubout -- "${MENU[@]}" 'It froze.'"$(repeat ' ' 8100)"'end' '~0.5' '\177' '~0.3' "$R" "${REST[@]}"
typing over-late -- "${MENU[@]}" 'It froze.'"$(repeat ' ' 8100)"'end\n' '~0.15' 'more\n' "${REST[@]}"
typing wb-word-back -- "${TO_WB[@]}" '/Volumes/x/my '"$(repeat y 8100)" '~0.5' '\027' '~0.3' 'book.xlsx\n' "$QH" "$R"
typing wb-over-late -- "${TO_WB[@]}" "$(repeat x 8100)"'\n' '~0.15' 'y\n' '?so it was not used' "$QW" "$R" "$QH" "$R"
typing wb-1025 -- "${TO_WB[@]}" "/$(repeat x 1024)"'\n' '?so it was not used' "$QW" "/$(repeat x 1023)"'\n' "$QH" "$R"
T_TERM=$X typing wb-raw-marked -- "${TO_WB[@]}" '\033[200~/Volumes/Share/Q3\\\tBudget\001v2.xlsx \033[201~' '~0.3' "$R" "$QH" "$R"
typing wb-raw-plain -- "${TO_WB[@]}" '/Volumes/Share/Q3\\\tBudget\001v2.xlsx \n' "$QH" "$R"
T_TERM=$X T_LANG=$UTF typing wb-c1 -- "${TO_WB[@]}" '/Volumes/x/caf\xe9 \xc2\x85Q\x85.xlsx\n' "$QH" "$R"
typing wb-rubout -- "${TO_WB[@]}" '/Volumes/x/caf\xe9\177\xc3\xa9\177e \x1b[D\177\n' "$QH" "$R"
mkdir -p "$WORK/tty/wb-real" && : > "$WORK/tty/wb-real/Q3"$'\t'"Budget"$'\001'"v2.xlsx"
T_TERM=$X typing wb-real -- "${TO_WB[@]}" '\033[200~@D@/Q3\\\tBudget\001v2.xlsx \033[201~' '~0.3' "$R" "$QH" "$R"
typing word-back -- "${TO_WB[@]}" '\027  \027abc\027abc  def \027X a b  \027Z\n' "$QH" "$R"
typing word-back-fast -- "${MENU[@]}" "$(repeat x 7990) $(repeat 'y\027' 30)"'\n' "${REST[@]}"
typing numbers -- "$Q1" "$R" '?How many days back' '18446744073709551617\n' '?from 1 to 60' '?How many days back' '08\n' \
    '?Most minutes' '00012345\n' '?at most four digits' '?Most minutes' '09\n' "$QN" "$QP" "$R" "${REST[@]}"
DRIP=('it froze\n' '~0.2'); i=0
while [ $i -lt 40 ]; do i=$((i + 1)); DRIP+=("more text $i\n" '~0.3'); done
typing drain-long -- "${MENU[@]}" "${DRIP[@]}" '/Volumes/x/late.xlsx\n' "$QW" "$R" "$QH" "$R"
T_TERM=$X T_LANG=$UTF T_LC_ALL=C typing lc-all-c -- "${MENU[@]}" 'A\xc4\x9b31mB caf\xc3\xa9\n' "${REST[@]}"
T_TERM=$X T_LC_CTYPE=UTF-8 typing lc-ctype-utf8 -- "${MENU[@]}" 'A\xc4\x9b31mB caf\xc3\xa9\n' "${REST[@]}"
T_WRAP=1 T_PRE="trap '' INT" typing int-ignored -- "$Q1" '~0.3' '\003' "$Q1" '2\n' "$QN" "$QP" 'it froze\n' "${REST[@]}" '=status'
wait
# A line break inside a workbook path, in a marked paste (the name of a real file) and in an unmarked one. A path of
# two-byte characters over 1,024 bytes in a UTF-8 locale. A real file whose name ends in a backslash, typed.
mkdir -p "$WORK/tty/wb-lf-marked" && : > "$WORK/tty/wb-lf-marked/a"$'\n'"b.xlsx"
T_TERM=$X typing wb-lf-marked -- "${TO_WB[@]}" '\033[200~@D@/a\nb.xlsx\033[201~' '~0.3' "$R" "$QH" "$R"
typing wb-lf-plain -- "${TO_WB[@]}" '/Volumes/x/a\nb.xlsx\n' "$QH" "$R"
T_LANG=$UTF typing wb-1025-utf8 -- "${TO_WB[@]}" "/$(repeat '\xc3\xa9' 600)"'\n' '?so it was not used' "$QW" "/$(repeat '\xc3\xa9' 511)x"'\n' "$QH" "$R"
mkdir -p "$WORK/tty/wb-backslash-end" && : > "$WORK/tty/wb-backslash-end/odd\\"
typing wb-backslash-end -- "${TO_WB[@]}" '@D@/odd\\\n' "$QH" "$R"
# A name that ends in a control character after a space, pasted as Finder's Copy as Pathname gives it (spaces not
# escaped), beside a decoy without that character: the path is the first. A carriage return and Ctrl-S and Ctrl-Q in
# a pasted path arrive as themselves. A backslash before a line break at the end of a paste goes with it.
mkdir -p "$WORK/tty/wb-decoy" && : > "$WORK/tty/wb-decoy/Q3 Budget.xlsx"$'\001' && printf 'decoy' > "$WORK/tty/wb-decoy/Q3 Budget.xlsx"
T_TERM=$X typing wb-decoy -- "${TO_WB[@]}" '\033[200~@D@/Q3 Budget.xlsx\001\033[201~' '~0.3' "$R" "$QH" "$R"
T_TERM=$X typing wb-cr -- "${TO_WB[@]}" '\033[200~/Volumes/x/a\rb\023c\021d.xlsx\033[201~' '~0.3' "$R" "$QH" "$R"
# The line that says how many days are searched, with --days 0 and with --since: it gives the days the search uses
typing days-zero --days 00000 -- "$Q1" "$R" '?Most minutes' "$R" "$QN" "$QP" "$R" "${REST[@]}"
typing days-until --until 2026-11-01 -- "$Q1" "$R" '?How many days back from 2026-11-01 should the log search go (2026-11-01 counts as 1)?' "$R" '?Most minutes' "$R" "$QN" "$QP" "$R" "${REST[@]}"
T_TERM=$X T_LANG=zh_CN.GB18030 typing mark-gb -- "${MENU[@]}" 'Excel \xe4\xba\x86\n' "${REST[@]}"
T_TERM=$X T_LANG=ja_JP.SJIS typing mark-sjis -- "${TO_WB[@]}" '/Volumes/x/caf\xc3\x83\n' "$QH" "$R"
typing days-since --since 2026-10-01 --until 2026-10-05 -- "$Q1" "$R" '?Most minutes' "$R" "$QN" "$QP" "$R" "${REST[@]}"
T_WRAP=1 T_PRE='/bin/stty -ixany' typing ixoff-before -- '\023' "${MENU[@]}" 'ok\n' "${REST[@]}" '=status'
T_WRAP=1 T_PRE='/bin/stty -ixany' typing ixoff-paste -- "${MENU[@]}" 'it froze \023'"$(repeat a 6000)"'\n' "${REST[@]}" '=status'
# Ctrl-S sent without a break while the first question starts, then a long line taken back: output is not left stopped
T_WRAP=1 T_PRE='/bin/stty -ixany' typing ixoff-stream -- '?Excel diagnostics' '%0.6' "$(repeat x 6000)" '\025' '1\021\n' '?How many days back' "$R" '?Most minutes' "$R" "$QN" "$QP" 'ok\n' "${REST[@]}" '=status'
# The same, made sure of: the reader is held for a second just before it tells the terminal to stop acting on Ctrl-S
# (it leaves a mark when it gets there), and a Ctrl-S is sent then. Output that it stopped must be started again by
# that question: its prompt must show before anything more is typed.
T_WRAP=1 T_PRE='/bin/stty -ixany' T_EDIT='s#^    \(\$raw = 1 if defined \$term->setattr(\$fd, &POSIX::TCSANOW);\)#    if (open(my $m, ">", "PAUSED")) { print $m 1; close $m; select(undef, undef, undef, 1) } \1#' \
    typing ixoff-window -- '=PAUSED' '\023' "$Q1" "$(repeat x 6000)" '\025' '1\021\n' '?How many days back' "$R" '?Most minutes' "$R" "$QN" "$QP" 'ok\n' "${REST[@]}" '=status'
# UTF-8 typed in a locale where those bytes are no characters: each answer is handed on as one argument
T_TERM=$X T_LANG=ja_JP.eucJP typing euc-note -- "${MENU[@]}" 'it froze \xe6\x97\xa5 --help\n' "${REST[@]}"
T_TERM=$X T_LANG=ko_KR.eucKR typing euc-wb -- "${TO_WB[@]}" '/Volumes/Share/\xe6\x97\xa5 report.xlsx\n' "$QH" "$R"
T_TERM=$X T_WRAP=1 T_PRE='/bin/stty inlcr igncr' typing wb-inlcr -- "${TO_WB[@]}" '\033[200~/Volumes/x/a\rb\nc.xlsx\033[201~' '~0.3' "$R" "$QH" "$R" '=status'
T_TERM=$X typing wb-bs-lf -- "${TO_WB[@]}" '\033[200~/Volumes/x/odd\\\n\033[201~' '~0.3' "$R" "$QH" "$R"
wait
T="$WORK/tty"
for n in return-only a-line pasted-lines pasted-open-end blank-first marked-paste typed-ahead keys rubout kill-keys long-edit tabs accents command-keys \
         long-line long-paragraph looks-like-option workbook-typed given-already frozen watching hang-named watch-named repro-asks no-perl \
         no-end-mark ends-in-esc ends-in-code ends-in-key ends-in-string split-end split-start stalled-paste ctrl-d-in-paste ctrl-c-in-paste strings esc-esc \
         long-code long-string accent-rubout \
         over-limit over-limit-plain over-limit-accents over-limit-again pieces end-mark-inside not-text marks-kill jamo-kill skin-tone rows-kill resized-kill \
         no-intr put-back-fails bash-suspend zsh-suspend bash-suspend-own outside-stop-1 outside-stop-2 outside-stop-3 \
         bash-marked-003 bash-marked-032 bash-marked-034 bash-plain-003 bash-plain-032 bash-plain-034 \
         zsh-marked-003 zsh-marked-032 zsh-marked-034 zsh-plain-003 zsh-plain-032 zsh-plain-034 \
         ctrl-d-first ctrl-d-alone ctrl-d-pieces wb-too-long empty-first split-after-bracket stall-after-esc winch-drain winch-paste c-locale utf8-locale \
         cjk-rubout cjk-kill tones-kill no-isig orphan-suspend bash-menu-034 bash-wb-003 bash-hide-003 zsh-menu-034 zsh-wb-003 \
         zsh-hide-003 bash-ctrl-d; do
    [ -s "$T/$n/dump" ] || bad "terminal run '$n' did not finish$([ -s "$T/$n/never" ] && echo ": it never showed '$(cat "$T/$n/never")'")"
done
asked() { tr -d '\r' < "$T/$1/screen" | grep -c 'What happened, in a few words? What you type is saved in the results. Press Return to skip.'; }
tl()    { left "$2" "$T/$1/dump"; }       # tl RUN NAME - what that run left in NAME

is "Return at every question: nothing about the incident, and nothing handed on" "$(tl return-only MODE) $(tl return-only NOTE) $(tl return-only WORKBOOK) $(tl return-only REDACT) $(tl return-only ARGS)" \
    'collect [] [] 0 <collect> <--days> <3> <--max-wait> <3> <--no-prompt> '
is "Return at every question: the question was asked" "$(asked return-only)" 1
is "a typed line" "$(tl a-line NOTE) $(tl a-line ARGS)" \
    '[Excel closed when I sorted column C] <collect> <--days> <3> <--max-wait> <3> <--no-prompt> <--note=Excel closed when I sorted column C> '
is "pasted lines are one note, and answer no other question" "$(tl pasted-lines NOTE) $(tl pasted-lines WORKBOOK) $(tl pasted-lines REDACT)" \
    '[Excel closed when I sorted column C then it froze again when I reopened it yesterday it was fine] [] 0'
is "a paste whose last line has no line end is one note too" "$(tl pasted-open-end NOTE) $(tl pasted-open-end WORKBOOK) $(tl pasted-open-end REDACT)" \
    '[Excel closed when I sorted column C then it froze again yesterday it was fine] [] 1'
is "a paste that starts with an empty line" "$(tl blank-first NOTE) $(tl blank-first WORKBOOK) $(tl blank-first REDACT)" '[second line] [] 1'
is "a paste the terminal marks: its line breaks, a backslash and a control character in it" "$(tl marked-paste NOTE) $(tl marked-paste WORKBOOK)" '[first line second \\ line] []'
is "what is typed straight after Return goes to the next question" "$(tl typed-ahead NOTE) $(tl typed-ahead WORKBOOK)" '[one] [/Volumes/b.xlsx]'
is "arrow, Option and function keys leave nothing in the line" "$(tl keys NOTE)" '[Excel closde]'
is "Backspace takes a whole accented letter, with no locale set" "$(tl rubout NOTE)" '[cafe closed]'
is "Ctrl-U and Ctrl-W take back the line and a word" "$(tl kill-keys NOTE)" '[right words now]'
is "taking back across the edge of the screen" "$(tl long-edit NOTE)" "[$(repeat 'ab ' 57)end]"
is "a tab is a space, and completes no file name" "$(tl tabs NOTE) $(grep -c 'nobody_typed' "$T/tabs/dump" "$T/tabs/screen" | tr '\n' ' ')" "[A1 B1 C1] $T/tabs/dump:0 $T/tabs/screen:0 "
is "accents and a backslash arrive as typed" "$(tl accents NOTE)" "[caf$E C:\\\\temp "$'\xe6\x97\xa5\xe6\x9c\xac]'
is "keys that a shell's line editor would act on are not text, and run nothing" "$(tl command-keys NOTE) $([ -e "$T/command-keys/RAN" ] && echo RAN || echo 'nothing ran')" \
    '[it broke $(touch RAN; echo x) A1z ~/x end] nothing ran'
is "a line of 3,000 bytes is taken whole, then cut and marked" "$(tl long-line NOTE | wc -c | tr -d ' ') $(tl long-line NOTE_CUT) $(tl long-line WORKBOOK)" '502 1 []'
is "a pasted paragraph of 1,500 bytes is part of the note" "$(tl long-paragraph NOTE | cut -c1-22) $(tl long-paragraph NOTE_CUT) $(tl long-paragraph WORKBOOK)" '[First line word word  1 []'
is "a typed line that looks like an option is a line" "$(tl looks-like-option NOTE) $(tl looks-like-option REDACT) $(tl looks-like-option ARGS | grep -c -- '<--note=--redact> $')" '[--redact] 0 1'
is "a workbook dragged in: its path, and no note made up for it" "$(tl workbook-typed NOTE) $(tl workbook-typed WORKBOOK) $(tl workbook-typed ARGS)" \
    '[] [/Volumes/Made Up/Budget.xlsx] <collect> <--days> <3> <--max-wait> <3> <--workbook> </Volumes/Made Up/Budget.xlsx> <--no-prompt> '
is "--note already given: not asked again" "$(asked given-already) $(tl given-already NOTE)" '0 [given on the command line]'
is "a frozen Excel, chosen at the menu: not asked, nothing recorded" "$(asked frozen) $(tl frozen MODE) $(tl frozen NOTE)" '0 hang []'
is "monitoring, chosen at the menu: not asked, nothing recorded" "$(asked watching) $(tl watching MODE) $(tl watching NOTE)" '0 watch []'
is "a frozen Excel, named on the command line: not asked" "$(asked hang-named) $(tl hang-named MODE) $(tl hang-named NOTE) $(tl hang-named ARGS)" '0 hang [] <hang> <--no-prompt> '
is "monitoring, named on the command line: not asked" "$(asked watch-named) $(tl watch-named MODE) $(tl watch-named NOTE)" '0 watch []'
is "a reproduction asks too" "$(asked repro-asks) $(tl repro-asks MODE) $(tl repro-asks NOTE)" '1 repro [It closes when I filter]'
# ended RUN - the collector's exit status in that run, and what the run waited for and never saw (nothing, when
# all went as it should). modes RUN - the terminal's settings after it.
ended() { echo "$(cat "$T/$1/status" 2>/dev/null) $(cat "$T/$1/never" 2>/dev/null)"; }
modes() { tr ' ' '\n' < "$T/$1/modes" 2>/dev/null | grep -x -e icanon -e -icanon -e isig -e -isig -e echo -e -echo -e iexten -e -iexten \
    -e icrnl -e -icrnl -e ixon -e -ixon -e ixany -e -ixany | tr '\n' ' '; }
AS_FOUND='icanon isig iexten echo icrnl ixon ixany '
is "Ctrl-C at the question stops the collector: its exit status is there within 5 seconds" "$(ended ctrl-c)" '130 '
is "Ctrl-C at the question: the collector did not go on" "$([ -e "$T/ctrl-c/dump" ] && echo 'went on' || echo stopped)" stopped
is "Ctrl-C at the question leaves the terminal as it was" "$(modes ctrl-c)" "$AS_FOUND"
is "without perl: a plain line is read with its backslash, and marked as plain" "$(tl no-perl NOTE) $(tl no-perl NOTE_PLAIN) $(tl no-perl ARGS | grep -c -F -- '<--note=It closes caf C:\temp> <--note-plain> ')" '[It closes caf C:\temp] 1 1'

# ---- what the reader writes to the screen ------------------------------------------------------------------------
# echoed RUN - every byte the screen got from the question about what happened to the next question, which is what
# the reader wrote: the terminal echoes nothing by itself while the question is open. The ON that the next
# question's reader starts with is left out. A byte that is not a plain character is written \xNN. ON and OFF are
# what asks a terminal to mark a paste and to stop; NL is the line end.
echoed() {
    /usr/bin/perl -e 'local $/; open(my $f, "<", $ARGV[0]) or exit; binmode($f); my $s = <$f>;
        $s =~ /Press Return to skip\.\r\n(.*?)(?:\e\[\?2004h)?(?:Workbook involved|\z)/s or exit;
        my $e = $1; $e =~ s/([^\x20-\x7e]|\\)/sprintf("\\x%02x", ord $1)/ge; print $e' "$T/$1/screen"
}
ON='\x1b[?2004h'; OFF='\x1b[?2004l'; NL='\x0d\x0d\x0a'
is "a typed line is shown as typed, and nothing else is" "$(echoed a-line)" "> Excel closed when I sorted column C$NL"
is "keys a line editor would act on: nothing of them is shown" "$(echoed command-keys)" '> it broke $(touch RAN; echo x) A1z ~/x end'"$NL"
is "arrow, Option and function keys: nothing of them is shown" "$(echoed keys)" "> Excel closde$NL"
is "a marked paste: its line breaks are shown as spaces, its control character is not shown, and marking is switched off after" \
    "$(echoed marked-paste)" "$ON> first line second "'\x5c\x5c'" line $OFF$NL"
is "control characters above the plain ones and bytes that are not UTF-8 (a character in more bytes than it takes, half of a pair) are not shown or kept; whole characters are" \
    "$(echoed not-text) $(tl not-text NOTE)" "$ON> A31mB0;tC caf xy "'\xc3\xa9\xe6\x97\xa5\xf0\x9f\x93\x88'" o1qz$OFF$NL [A31mB0;tC caf xy $E"$'\xe6\x97\xa5\xf0\x9f\x93\x88 o1qz]'
# Where the locale is not one of UTF-8, a character that is not plain ASCII is shown as one "?" and kept as it is.
# The bytes after C4 here would be control characters on a terminal that shows one byte as one character.
is "no UTF-8 locale: each character that is not plain ASCII is shown as ?, and kept" "$(echoed c-locale) $(tl c-locale NOTE)" \
    "$ON> A?31mB?0;t?C caf?"'\x08 \x08'"e ?$OFF$NL [A"$'\xc4\x9b31mB\xc4\x9d0;t\xc4\x9cC cafe \xe6\x97\xa5]'
is "a UTF-8 locale: the same characters are shown as they are" "$(echoed utf8-locale) $(tl utf8-locale NOTE)" \
    "$ON> A"'\xc4\x9b31mB\xc4\x9d0;t\xc4\x9cC caf\xc3\xa9'"$OFF$NL [A"$'\xc4\x9b31mB\xc4\x9d0;t\xc4\x9cC caf\xc3\xa9]'

# ---- a paste that does not end as it should ----------------------------------------------------------------------
is "a paste with no end mark is over after a second: Return then ends the text" "$(tl no-end-mark NOTE)" '[pasted text]'
is "a paste whose text ends in Esc: its end mark is still seen" "$(tl ends-in-esc NOTE) $(echoed ends-in-esc)" "[it froze] $ON> it froze$OFF$NL"
is "a paste whose text ends in the start of a key code" "$(tl ends-in-code NOTE) $(tl ends-in-key NOTE)" '[it froze] [it froze]'
is "an end mark that arrives in two pieces" "$(tl split-end NOTE) $(echoed split-end)" "[some text] $ON> some text$OFF$NL"
is "a start mark that arrives in two pieces: no piece of it is text, and what follows is a paste" "$(tl split-start NOTE) $(echoed split-start)" "[one two] $ON> one two$OFF$NL"
is "a marked paste that stalls: its later lines are still the note and answer no other question" \
    "$(tl stalled-paste NOTE) $(tl stalled-paste WORKBOOK) $(tl stalled-paste REDACT)" '[line one line two line three] [] 0'
is "a paste whose text ends in the start of a string" "$(tl ends-in-string NOTE)" '[it froze]'
is "Ctrl-D inside a paste does not end the text, at its start or later" "$(tl ctrl-d-in-paste NOTE) $(tl ctrl-d-in-paste WORKBOOK)" '[onetwo] []'
is "Ctrl-C inside a marked paste is dropped, also when the paste pauses after it" "$(tl ctrl-c-in-paste NOTE)" '[it froze more]'
is "strings a terminal sends (title, device, application, private, start of string) are not text" "$(tl strings NOTE) $(echoed strings)" "[ABCDEF] $ON> ABCDEF$OFF$NL"
is "Esc before a key code, and a key code with 13 numbers, leave nothing" "$(tl esc-esc NOTE)" '[xyz]'
is "a key code that does not end is given up after 64 bytes" "$(tl long-code NOTE)" "[a$(repeat 1 36) kept]"
is "a string that does not end is given up after 256 bytes" "$(tl long-string NOTE)" "[a$(repeat t 44) kept]"

# ---- more than the reader keeps ----------------------------------------------------------------------------------
is "a paste over 8,000 bytes that is short once on one line: marked as more than the question keeps, and not as cut" "$(tl over-limit NOTE) $(tl over-limit NOTE_OVER) $(tl over-limit NOTE_CUT) $(tl over-limit ARGS | grep -c -- '<--note-over> $')" '[It froze on save.] 1 0 1'
is "over 8,000 bytes: 8,000 are shown, then one bell" "$(echoed over-limit | LC_ALL=C tr -d ' ') $(echoed over-limit | LC_ALL=C tr -c -d ' ' | wc -c | tr -d ' ')" "$ON>Itfrozeonsave."'\x07'"$OFF$NL 7987"
is "the same typed on a terminal that marks nothing" "$(tl over-limit-plain NOTE) $(tl over-limit-plain NOTE_OVER) $(tl over-limit-plain NOTE_CUT)" '[It froze on save.] 1 0'
is "every byte of a character counts towards the 8,000" "$(echoed over-limit-accents | grep -o -F '\xc3\xa9' | wc -l | tr -d ' ') $(echoed over-limit-accents | grep -o -F '\x07' | wc -l | tr -d ' ') $(tl over-limit-accents NOTE_OVER) $(tl over-limit-accents NOTE_CUT)" '4000 1 1 1'
is "everything taken back after that, and a short line typed: the line, and nothing said about what was dropped" "$(tl over-limit-again NOTE) $(tl over-limit-again NOTE_OVER) $(tl over-limit-again NOTE_CUT)" '[short note] 0 0'

# ---- a paste that arrives in pieces ------------------------------------------------------------------------------
is "pieces of a paste that come after Return answer no other question" "$(tl pieces NOTE) $(tl pieces WORKBOOK) $(tl pieces REDACT)" '[it froze when I sorted] [] 0'
is "pieces of a paste that come after Return: that is known, and handed to the sudo re-run" "$(tl pieces NOTE_LATE) $(tl pieces ARGS | grep -c -- '<--note-late> $')" '1 1'
is "an empty Return with pieces after it: they answer no other question" "$(tl empty-first NOTE) $(tl empty-first WORKBOOK) $(tl empty-first REDACT) $(tl empty-first NOTE_LATE)" '[] [] 0 0'
case "$(echoed empty-first)" in *"More input arrived right after Return. It was not used."*) ok ;; *) bad "an empty Return with pieces after it: the screen should say they were not used, got '$(echoed empty-first)'" ;; esac
is "Ctrl-D with more input straight behind it is part of a paste" "$(tl ctrl-d-first NOTE) $(tl ctrl-d-first WORKBOOK) $(tl ctrl-d-first REDACT)" '[/Volumes/x/made up.xlsx y] [] 0'
is "Ctrl-D by itself at an empty question ends it" "$(tl ctrl-d-alone NOTE) $(tl ctrl-d-alone MODE)" '[] collect'
is "more than 8,000 bytes at the workbook question: not used, and asked again" "$(tl wb-too-long WORKBOOK) $(tl wb-too-long ARGS | grep -c -- '<--workbook> </Volumes/x/book.xlsx>')" '[/Volumes/x/book.xlsx] 1'
is "Ctrl-D by itself with pieces after it: they answer no other question" "$(tl ctrl-d-pieces NOTE) $(tl ctrl-d-pieces WORKBOOK) $(tl ctrl-d-pieces REDACT)" '[] [] 0'
is "a start mark split straight after its [: no piece of it is text" "$(tl split-after-bracket NOTE) $(echoed split-after-bracket)" "[one two] $ON> one two$OFF$NL"
is "a marked paste that stalls after an Esc: its later lines are still the note" "$(tl stall-after-esc NOTE) $(tl stall-after-esc WORKBOOK) $(tl stall-after-esc REDACT)" '[line oneline two line three] [] 0'
is "the window changes size while pieces after Return are dropped: they still answer no other question" "$(tl winch-drain NOTE) $(tl winch-drain WORKBOOK) $(tl winch-drain REDACT)" '[it froze] [] 0'
is "the window changes size while a marked paste pauses: the paste goes on" "$(tl winch-paste NOTE) $(tl winch-paste WORKBOOK) $(tl winch-paste REDACT)" '[line one line two line three] [] 0'
is "pieces of a paste that come after Return: the screen says they were not used" "$(echoed pieces)" "> it froze when I sorted${NL}More input arrived right after Return. It was not used.$NL"
is "an end mark inside what was pasted does not end the paste" "$(tl end-mark-inside NOTE) $(tl end-mark-inside WORKBOOK) $(tl end-mark-inside REDACT)" '[note text /Volumes/x/made up.xlsx y] [] 0'

# ---- taking text back, and where the cursor goes -----------------------------------------------------------------
is "100 marks that take no column, then Ctrl-U: the text is written again where it is" "$(echoed marks-kill)" "$ON> $(repeat '\xd6\xb0' 100)"'\x0d\x1b[J> ok'"$OFF$NL"
is "100 characters whose width is not certain, then Ctrl-U: a new line, and the cursor never goes up" "$(echoed jamo-kill)" "$ON> $(repeat '\xe1\x85\xa0' 100)${NL}> ok$OFF$NL"
is "Backspace after an emoji with a skin tone takes the tone, and the emoji is written again" "$(echoed skin-tone) $(tl skin-tone NOTE)" "$ON> "'\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbb\x0d\x1b[J> \xf0\x9f\x91\x8d'"$OFF$NL "$'[\xf0\x9f\x91\x8d]'
is "Backspace after an accented letter on a terminal that takes cursor codes: the text is written again" "$(echoed accent-rubout) $(tl accent-rubout NOTE)" "$ON> caf"'\xc3\xa9\x0d\x1b[J> cafe'"$OFF$NL [cafe]"
is "three rows of plain letters, then Ctrl-U: up the two rows they filled, no further" "$(echoed rows-kill)" "$ON> $(repeat 'ab ' 60)"'\x0d\x1b[2A\x1b[J> ok'"$OFF$NL"
is "the same after the window changed size: a new line, and the cursor does not go up" "$(echoed resized-kill)" "$ON> $(repeat 'ab ' 60)${NL}> ok$OFF$NL"
J60=$(repeat '\xe6\x97\xa5' 60)
is "Backspace in two rows of characters that are sure to be two columns wide: each is rubbed out where it stands" "$(echoed cjk-rubout) $(tl cjk-rubout NOTE | wc -c | tr -d ' ')" \
    "$ON> $J60$(repeat '\x08\x08  \x08\x08' 3)$OFF$NL 174"
is "the same, then Ctrl-U: up the one row they filled" "$(echoed cjk-kill)" "$ON> $J60"'\x0d\x1b[1A\x1b[J> ok'"$OFF$NL"
is "30 emoji with skin tones, then Ctrl-U: a tone takes no column, so the text is written again where it is" "$(echoed tones-kill)" \
    "$ON> $(repeat '\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbb' 30)"'\x0d\x1b[J> ok'"$OFF$NL"
is "the cursor goes up in those runs where rows of characters whose width is sure were taken back, and in no other" \
    "$(cd "$T" && LC_ALL=C grep -a -l $'\033\\[[0-9]*A' */screen | tr '\n' ' ')" 'cjk-kill/screen over-limit-again/screen rows-kill/screen '

# ---- signals -----------------------------------------------------------------------------------------------------
is "Ctrl-\\ at the question stops the collector and leaves the terminal as it was" "$(ended ctrl-backslash)|$(modes ctrl-backslash)" "131 |$AS_FOUND"
is "the reader killed outright: the collector puts the terminal back, then stops the same way" "$(ended kill-reader)|$(modes kill-reader)" "137 |$AS_FOUND"
case "$(echoed kill-reader)" in "$ON> half a line$OFF"*) ok ;; *) bad "the reader killed outright: marking a paste should be switched off after it, got '$(echoed kill-reader)'" ;; esac
is "an interrupt sent to the reader alone stops the collector too" "$(ended int-reader)|$(modes int-reader)|$([ -e "$T/int-reader/dump" ] && echo 'went on' || echo stopped)" "130 |$AS_FOUND|stopped"
is "SIGTERM to the reader and the collector: the reader puts the terminal back" "$(ended term-all)|$(modes term-all)" "143 |$AS_FOUND"
is "SIGHUP to both" "$(ended hup-all)|$(modes hup-all)" "129 |$AS_FOUND"
is "SIGQUIT to both" "$(ended quit-all)|$(modes quit-all)" "131 |$AS_FOUND"
case "$(echoed other-intr)" in '> halfx'*) ok ;; *) bad "a terminal whose interrupt character is Ctrl-G: Ctrl-C should do nothing, got '$(echoed other-intr)'" ;; esac
is "a terminal whose interrupt character is Ctrl-G: Ctrl-G stops the collector" "$(ended other-intr)|$(modes other-intr)" "130 |$AS_FOUND"
is "a terminal with no interrupt character: Ctrl-C is not text and stops nothing" "$(ended no-intr)|$(tl no-intr NOTE)" '0 |[halfx]'
is "a terminal that sends no signal for any key: Ctrl-C is not text and stops nothing" "$(ended no-isig)|$(tl no-isig NOTE)" '0 |[halfx]'
is "Ctrl-Z where nothing could start the collector again: it does not stop, and the text goes on" "$(ended orphan-suspend)|$(tl orphan-suspend NOTE)" '0 |[half more]'
is "the same: the terminal is put back, then taken again and the text written on a new line" "$(echoed orphan-suspend)" "$ON> half$OFF$ON$NL> half more$OFF$NL"
is "putting the terminal back failed the first time: that run was made with the failure put in" "$(grep -c 'POSIX::Termios::setattr = sub' "$T/put-back-fails/head.sh")" 1
is "putting the terminal back failed the first time: it is done at the end" "$(ended put-back-fails)|$(modes put-back-fails)|$(tl put-back-fails NOTE)" "0 |$AS_FOUND|[a line]"

# ---- under a shell with job control ------------------------------------------------------------------------------
for sh in bash zsh; do
    for c in 003 032 034; do
        for kind in marked plain; do
            n="$sh-$kind-$c"
            is "$sh, a $kind paste holding \\$c and a line that would make a file: the line is text, and no file is made" \
                "$(tl "$n" NOTE) $([ -e "$T/$n/RAN_BY_PASTE" ] && echo 'the line was run' || echo 'nothing ran')" "[it froze touch $T/$n/RAN_BY_PASTE] nothing ran"
        done
    done
done
is "bash: Ctrl-Z at the question, then fg: the text goes on where it was" "$(tl bash-suspend NOTE) $(cat "$T/bash-suspend/never" 2>/dev/null)" '[half rest] '
is "zsh: Ctrl-Z at the question, then fg" "$(tl zsh-suspend NOTE) $(cat "$T/zsh-suspend/never" 2>/dev/null)" '[half rest] '
case "$(echoed bash-suspend-own)" in "$ON> half$OFF"*'Stopped'*'shell-ready$ fg'*) ok ;; *) bad "Ctrl-Z at the question: the terminal should be put back before the stop signal is sent, got '$(echoed bash-suspend-own | cut -c1-200)'" ;; esac
is "Ctrl-Z at the question: that run was made with the cut-down reader, and went on after fg" "$(cmp -s "$HEAD" "$T/bash-suspend-own/head.sh" && echo 'not edited' || echo edited) $(tl bash-suspend-own NOTE)" 'edited [half rest]'
OFF_WHILE_STOPPED=0
for i in 1 2 3; do
    is "a stop sent from outside, then fg: the text goes on where it was ($i)" "$(tl "outside-stop-$i" NOTE) $(cat "$T/outside-stop-$i/never" 2>/dev/null)" '[half rest] '
    case "$(echoed "outside-stop-$i")" in "$ON> half"*"$OFF"*'shell-ready$ fg'*) OFF_WHILE_STOPPED=$((OFF_WHILE_STOPPED + 1)) ;; esac
done
# In a run where the shell stopped the reader before it had its turn, the reader could do nothing. Not in all three.
if [ "$OFF_WHILE_STOPPED" -ge 1 ]; then ok; else bad "a stop sent from outside: marking a paste should be switched off while stopped, in at least one run of three"; fi
for sh in bash zsh; do
    n="$sh-menu-034"
    is "$sh, a paste holding \\034 and a line that would make a file at the menu: no file is made" "$(tl "$n" MODE) $([ -e "$T/$n/RAN_BY_PASTE" ] && echo 'the line was run' || echo 'nothing ran')" 'collect nothing ran'
    n="$sh-wb-003"
    is "$sh, the same with \\003 at the workbook question: the line is part of the path, and so is the \\003, as it came" "$(tl "$n" WORKBOOK) $([ -e "$T/$n/RAN_BY_PASTE" ] && echo 'the line was run' || echo 'nothing ran')" "[/Volumes/x.xlsx"$'\003'"touch $T/$n/RAN_BY_PASTE] nothing ran"
    n="$sh-hide-003"
    is "$sh, the same at the question about hiding names" "$(tl "$n" REDACT) $([ -e "$T/$n/RAN_BY_PASTE" ] && echo 'the line was run' || echo 'nothing ran')" '0 nothing ran'
done
is "bash, a paste that starts with Ctrl-D: the rest is the note, and no line of it is run" "$(tl bash-ctrl-d NOTE) $(tl bash-ctrl-d WORKBOOK) $([ -e "$T/bash-ctrl-d/RAN_BY_PASTE" ] && echo 'the line was run' || echo 'nothing ran')" \
    "[n touch $T/bash-ctrl-d/RAN_BY_PASTE] [] nothing ran"

# ---- more than the reader keeps, then edited ---------------------------------------------------------------------
for n in over-word-back over-rubout over-late wb-word-back wb-over-late wb-1025 wb-raw-marked wb-raw-plain wb-c1 wb-rubout wb-real \
         word-back word-back-fast numbers drain-long lc-all-c lc-ctype-utf8 int-ignored wb-lf-marked wb-lf-plain wb-1025-utf8 wb-backslash-end wb-decoy wb-cr wb-bs-lf days-zero days-since days-until mark-gb mark-sjis ixoff-before ixoff-paste wb-inlcr ixoff-stream ixoff-window euc-note euc-wb; do
    [ -s "$T/$n/dump" ] || bad "terminal run '$n' did not finish$([ -s "$T/$n/never" ] && echo ": it never showed '$(cat "$T/$n/never")'")"
done
wb() { LC_ALL=C sed -n 's/^WORKBOOK=//p' "$T/$1/dump" 2>/dev/null; }      # the workbook a run left, byte for byte
# what the reader wrote after the workbook question, up to the end of the line, written as echoed() writes it
wbechoed() {
    /usr/bin/perl -e 'local $/; open(my $f, "<", $ARGV[0]) or exit; binmode($f); my $s = <$f>;
        $s =~ /it is not copied\): (.*?\r\r\n)/s or exit;
        my $e = $1; $e =~ s/([^\x20-\x7e]|\\)/sprintf("\\x%02x", ord $1)/ge; print $e' "$T/$1/screen"
}
is "more than 8,000 bytes, then the long word taken back and the rest typed: that line, marked as more than was kept and not as cut" \
    "$(tl over-word-back NOTE) $(tl over-word-back NOTE_OVER) $(tl over-word-back NOTE_CUT) $(tl over-word-back ARGS | grep -c -- '<--note=It crashed when saving> <--note-over> $')" \
    '[It crashed when saving] 1 0 1'
is "more than 8,000 bytes, then one Backspace: what was dropped is still known" "$(tl over-rubout NOTE) $(tl over-rubout NOTE_OVER) $(tl over-rubout NOTE_CUT)" '[It froze.] 1 0'
is "more than 8,000 bytes and a piece after Return: both are known, and handed on" \
    "$(tl over-late NOTE) $(tl over-late NOTE_OVER) $(tl over-late NOTE_LATE) $(tl over-late ARGS | grep -c -- '<--note-late> <--note-over> $')" '[It froze.] 1 1 1'
is "more than 8,000 bytes at the workbook question, then a word taken back: the short path that is left is used" \
    "$(wb wb-word-back) $(tr -d '\r' < "$T/wb-word-back/screen" | grep -c 'so it was not used')" '[/Volumes/x/my book.xlsx] 0'
is "more than 8,000 bytes at the workbook question and a piece after Return: not used, and asked again" \
    "$(wb wb-over-late) $(tl wb-over-late NOTE_OVER) $(tl wb-over-late ARGS | grep -c -- '--workbook')" '[] 0 0'
is "a path of 1,025 bytes is not used; one of 1,024 is" "$(wb wb-1025 | LC_ALL=C tr -d '[]\n' | wc -c | tr -d ' ')" 1024

# ---- the workbook question keeps the bytes that arrive -----------------------------------------------------------
RAWPATH='/Volumes/Share/Q3'$'\t''Budget'$'\001''v2.xlsx'
is "a dragged path with an escaped tab and a control character, in a marked paste: kept as it came, less the escape and the space after it" "$(wb wb-raw-marked)" "[$RAWPATH]"
is "the same, typed on a terminal that marks nothing" "$(wb wb-raw-plain)" "[$RAWPATH]"
is "the same: handed to the sudo re-run as it came" "$(tr '\0' '\n' < "$T/wb-raw-plain/dump.args" | LC_ALL=C grep -c -x -F -- "$RAWPATH")" 1
is "the same: each of those bytes is shown as one ?, and no control character reaches the screen" "$(wbechoed wb-raw-marked)" '/Volumes/Share/Q3\x5c?Budget?v2.xlsx '"$OFF$NL"
is "a first byte with no character after it, a control character above the plain ones and a byte that belongs to no character are kept, and each is shown as one ?" \
    "$(wb wb-c1) $(wbechoed wb-c1)" "[/Volumes/x/caf"$'\xe9'" "$'\xc2\x85'"Q"$'\x85'".xlsx] /Volumes/x/caf? ?Q?.xlsx$OFF$NL"
is "Backspace in a path takes a whole character, or one byte that is not one; an arrow key is nothing" "$(wb wb-rubout)" '[/Volumes/x/cafe]'
REAL=$(wb wb-real); REAL=${REAL#\[}; REAL=${REAL%\]}
is "a real workbook with a tab and a control character in its name, dragged in: the path is its name" "$REAL" "$T/wb-real/Q3"$'\t'"Budget"$'\001'"v2.xlsx"
context realbook; WORKBOOK=$REAL; write_incident_context; workbook_facts
is "the same: its facts are found" "$(tail -1 "$MANIFEST")" "$(printf 'workbook_metadata\tcomplete\tmetadata only; workbook not copied')"
has "$MD" "    $T/wb-real/Q3 Budget v2.xlsx" "the path in the context file, each control character in it shown as one space"
# wbbytes RUN - every byte of the workbook a run left; wbarg RUN - every byte of what follows --workbook in what is
# handed to the sudo re-run. Each written in brackets, as echoed() writes it.
wbbytes() {
    /usr/bin/perl -e 'local $/; open(my $f, "<", $ARGV[0]) or exit; binmode($f); my $s = <$f>; $s = "" unless defined $s;
        $s =~ s/([^\x20-\x7e]|\\)/sprintf("\\x%02x", ord $1)/ge; print "[$s]"' "$T/$1/dump.workbook"
}
wbarg() {
    /usr/bin/perl -e 'local $/; open(my $f, "<", $ARGV[0]) or exit; binmode($f); my $all = <$f>; my @a = split /\0/, defined $all ? $all : "";
        for my $i (0 .. $#a - 1) { next unless $a[$i] eq "--workbook"; my $s = $a[$i + 1];
            $s =~ s/([^\x20-\x7e]|\\)/sprintf("\\x%02x", ord $1)/ge; print "[$s]"; }' "$T/$1/dump.args"
}
is "a line break inside a path, in an unmarked paste: kept as it came" "$(wbbytes wb-lf-plain) $(wbarg wb-lf-plain)" '[/Volumes/x/a\x0ab.xlsx] [/Volumes/x/a\x0ab.xlsx]'
is "the same: it is shown as one ?" "$(wbechoed wb-lf-plain)" "/Volumes/x/a?b.xlsx$NL"
is "a line break inside the path of a real file, in a marked paste: kept as it came" "$(wbbytes wb-lf-marked) $(wbarg wb-lf-marked)" \
    "[$T/wb-lf-marked/a\\x0ab.xlsx] [$T/wb-lf-marked/a\\x0ab.xlsx]"
context realbook-lf; WORKBOOK=$(cat "$T/wb-lf-marked/dump.workbook"); write_incident_context; workbook_facts
is "the same: its facts are found" "$(tail -1 "$MANIFEST")" "$(printf 'workbook_metadata\tcomplete\tmetadata only; workbook not copied')"
is "a path of 600 two-byte characters in a UTF-8 locale is over 1,024 bytes: not used, and asked again; one of 1,024 bytes is used" \
    "$(tr -d '\r' < "$T/wb-1025-utf8/screen" | grep -c 'so it was not used') $(wc -c < "$T/wb-1025-utf8/dump.workbook" | tr -d ' ') $(wbarg wb-1025-utf8 | wc -c | tr -d ' ')" \
    "1 1024 $((2 + 1 + 511 * 8 + 1))"
is "a real file whose name ends in a backslash, typed: the backslash stays" "$(wbbytes wb-backslash-end) $(wbarg wb-backslash-end)" \
    "[$T/wb-backslash-end/odd\\x5c] [$T/wb-backslash-end/odd\\x5c]"
context realbook-bs; WORKBOOK=$(cat "$T/wb-backslash-end/dump.workbook"); write_incident_context; workbook_facts
is "the same: its facts are found" "$(tail -1 "$MANIFEST")" "$(printf 'workbook_metadata\tcomplete\tmetadata only; workbook not copied')"
is "a name that ends in a control character after a space, pasted with its spaces as they are: the path keeps that character" "$(wbbytes wb-decoy)" "[$T/wb-decoy/Q3 Budget.xlsx\\x01]"
context decoy; WORKBOOK=$(cat "$T/wb-decoy/dump.workbook"); write_incident_context; workbook_facts
is "the same: the facts are those of that file, not of the decoy beside it" "$(grep -c '^Bytes: 0$' "$OUT/case/workbook_metadata.txt") $(grep -c '^Bytes: 5$' "$OUT/case/workbook_metadata.txt")" '1 0'
is "--days 0 is one day, and the line about the search says so" "$(tr -d '\r' < "$T/days-zero/screen" | grep -c "^Collecting 1 day(s) of logs, $(date '+%Y-%m-%d') through $(date '+%Y-%m-%d'), at most 3 minute(s) per day (up to 3 minutes)\\.$")" 1
is "--until: the days question counts back from it, and the line about the search gives those days" "$(tr -d '\r' < "$T/days-until/screen" | grep -c '^Collecting 3 day(s) of logs, 2026-10-30 through 2026-11-01, ')" 1
is "the reader's end mark is taken off in a locale where it joins the byte before it: a note" "$(tl mark-gb NOTE | LC_ALL=C od -An -tx1 | tr -d ' \n')" "$(printf '[Excel \xe4\xba\x86]\n' | LC_ALL=C od -An -tx1 | tr -d ' \n')"
is "the same: a workbook path" "$(wbbytes mark-sjis)" '[/Volumes/x/caf\xc3\x83]'
is "--since: the line about the search gives the days from that date" "$(tr -d '\r' < "$T/days-since/screen" | grep -c '^Collecting 5 day(s) of logs, 2026-10-01 through 2026-10-05, at most 3 minute(s) per day (up to 15 minutes)\.$')" 1
is "Ctrl-S before the first question, on a terminal without ixany: the questions still show, and the run finishes" "$(tl ixoff-before NOTE) $(ended ixoff-before)" '[ok] 0 '
is "Ctrl-S sent without a break while the first question starts, on a terminal without ixany: the questions still show" "$(tl ixoff-stream NOTE) $(ended ixoff-stream)" '[ok] 0 '
is "a Ctrl-S just before the terminal stops acting on it: that run was made with the pause put in, and the questions still show" "$(grep -c 'PAUSED' "$T/ixoff-window/head.sh") $(tl ixoff-window NOTE) $(ended ixoff-window)" '1 [ok] 0 '
is "a note typed in a locale where its bytes are no characters is handed on as one argument" "$(tr '\0' '\n' < "$T/euc-note/dump.args" | grep -c -x -- '--help') $(tr '\0' '\n' < "$T/euc-note/dump.args" | LC_ALL=C grep -c -x -F -- "--note=it froze $(printf '\346\227\245') --help")" '0 1'
is "the same: a workbook path" "$(tr '\0' '\n' < "$T/euc-wb/dump.args" | LC_ALL=C grep -c -x -F -- "/Volumes/Share/$(printf '\346\227\245') report.xlsx") $(tr '\0' '\n' < "$T/euc-wb/dump.args" | grep -c -x 'report.xlsx')" '1 0'
is "Ctrl-S at a question with a long paste behind it, on a terminal without ixany: the question still ends" "$(tl ixoff-paste NOTE | cut -c1-10) $(ended ixoff-paste)" '[it froze  0 '
is "a terminal that changes carriage returns and line breaks on their way in: a pasted path keeps them as they were" "$(wbbytes wb-inlcr)" '[/Volumes/x/a\x0db\x0ac.xlsx]'
is "a carriage return, Ctrl-S and Ctrl-Q in a pasted path arrive as themselves" "$(wbbytes wb-cr)" '[/Volumes/x/a\x0db\x13c\x11d.xlsx]'
is "a backslash before a line break at the end of a paste goes with it" "$(wbbytes wb-bs-lf)" '[/Volumes/x/odd]'
# Digits are digits 0 to 9 only, whatever the locale: in some, other characters sort between 0 and 9
eval "$(sed -n '/^whole() {$/,/^}$/p' "$SCRIPT")"
for loc in ja_JP.UTF-8 en_US.UTF-8; do
    for c in '\xef\xbc\x93' '\xe2\x86\x85' '\xd9\xa3'; do
        ch=$(printf "$c"); r=$(LC_ALL=$loc /bin/bash -c "$(declare -f whole); whole \"\$1\"; echo \" \$?\"" sh "$ch")
        is "a digit of another script, or a character that sorts among the digits, is not a number ($loc, $c)" "$r" ' 1'
    done
done

# ---- Ctrl-W, numbers, the drain, the locale, a signal that is ignored ----------------------------------------------
is "Ctrl-W at an empty answer, after spaces only, after one word, and after words with spaces between and after them" "$(wb word-back)" '[abc  X a Z]'
is "Ctrl-W 30 times after a word of 7,990 bytes is quick: the run finished, with the long word" "$(tl word-back-fast NOTE | wc -c | tr -d ' ') $(tl word-back-fast NOTE_CUT)" '503 1'
is "numbers: 20 digits are out of range, 08 is 8, more than four digits are turned down, 09 is 9" "$(tl numbers ARGS) $(tl numbers NUMBERS)" \
    '<collect> <--days> <8> <--max-wait> <9> <--no-prompt>  8 9 540 30 0'
is "numbers: what is said about the search uses them as numbers" "$(tr -d '\r' < "$T/numbers/screen" | grep -c '^Collecting 8 day(s) of logs, [0-9-]* through [0-9-]*, at most 9 minute(s) per day (up to 72 minutes)\.$')" 1
is "input after Return that keeps coming for more than ten seconds: all of it is dropped, and it answers no other question" \
    "$(tl drain-long NOTE) $(tl drain-long NOTE_LATE) $(wb drain-long) $(tl drain-long REDACT)" '[it froze] 1 [] 0'
is "the same: the screen says so once" "$(tr -d '\r' < "$T/drain-long/screen" | grep -c 'More input arrived right after Return. It was not used.')" 1
case "$(echoed ctrl-d-pieces)" in *"More input arrived right after Ctrl-D. It was not used."*) ok ;; *) bad "Ctrl-D with pieces after it: the screen should name Ctrl-D, got '$(echoed ctrl-d-pieces)'" ;; esac
is "LC_ALL=C over a UTF-8 LANG: each character that is not plain ASCII is shown as ?, and kept" "$(echoed lc-all-c) $(tl lc-all-c NOTE)" \
    "$ON> A?31mB caf?$OFF$NL [A"$'\xc4\x9b31mB caf\xc3\xa9]'
is "LC_CTYPE of UTF-8 and no LANG: the characters are shown as they are" "$(echoed lc-ctype-utf8) $(tl lc-ctype-utf8 NOTE)" \
    "$ON> A"'\xc4\x9b31mB caf\xc3\xa9'"$OFF$NL [A"$'\xc4\x9b31mB caf\xc3\xa9]'
is "Ctrl-C at the menu where the collector ignores it: the menu is asked again, and its answer counts" "$(ended int-ignored)|$(tl int-ignored MODE) $(tl int-ignored NOTE)" '0 |repro [it froze]'
# Every process of a run works in that run's folder
is "no run left anything running" "$(lsof -d cwd -Fpn 2>/dev/null | grep -c -F -- "n$(cd "$T" && pwd -P)/")" 0

# ---- where the collector calls these -----------------------------------------------------------------------------
# The functions above were called by this test. These look at the collector for the calls a real run makes.
body() { sed -n "/^$1() {\$/,/^}\$/p" "$SCRIPT"; }
TAIL=$(sed -n '/^write_bundle_info$/,$p' "$SCRIPT")
is "every mode writes the context first" "$(printf '%s\n' "$TAIL" | sed -n '1,4p' | tr '\n' '|')" 'write_bundle_info|write_incident_context||case "$MODE" in|'
is "the note is prepared once, before the sudo re-run" "$(grep -n -E '^prepare_note$|exec sudo ' "$SCRIPT" | sed -E 's/^[0-9]+: *//; s/ .*//' | tr '\n' ' ')" 'prepare_note exec '
is "collect gathers the workbook's facts, first" "$(body mode_collect | sed -n '3p' | grep -c '^    workbook_facts ')" 1
is "a frozen Excel gathers them after what cannot wait and before the log search" \
    "$(body mode_hang | grep -n 'spindump "\$pid"\|Copying Excel.s logs\|^    workbook_facts \|Unified log, last 30 minutes' | sed -E 's/^[0-9]+: *//; s/^(run_limited 120 spindump|note "Copying|workbook_facts|note "Unified).*/\1/' | tr '\n' '|')" \
    'run_limited 120 spindump|note "Copying|workbook_facts|note "Unified|'
is "a reproduction gathers them when it ends" "$(body repro_finish | grep -c '^    workbook_facts ')" 1
is "monitoring gathers them" "$(printf '%s\n' "$TAIL" | grep -c '^    watch)   workbook_facts; mode_watch ;;$')" 1
is "the facts are only gathered under a time limit: as root each read has its own, otherwise the step has one" "$(grep -c 'collect_workbook_metadata' "$SCRIPT") $(body workbook_facts | grep -c -e '^    run_limited 20 collect_workbook_metadata$' -e '^        AS_LIMIT=10 AS_KEEP_OPEN=1 AS_WHAT=.* collect_workbook_metadata$')" '3 2'
is "nothing else writes into the case folder" "$(grep -c '/case' "$SCRIPT")" 3
is "Excel's processes are taken by the program file they run, as lsof gives it, never by their arguments" "$(grep -c 'lsof -a "\${which\[@\]}" -d txt -Fpun' "$SCRIPT") $(grep -c 'pgrep' "$SCRIPT")" '1 0'
is "the question is not read by a shell's line editor" "$(grep -c 'read -e\|INPUTRC\|bind ' "$SCRIPT")" 0

# ---- what the collector says about itself ------------------------------------------------------------------------
is "the collector names no PivotTable" "$(grep -c -i 'pivot' "$SCRIPT")" 0
is "no yes-or-no question about what happened" "$(grep -c 'ask_yes' "$SCRIPT")" 2
HELP=$(/bin/bash "$SCRIPT" --help)
is "--help ends with status 0" "$?" 0
case "$HELP" in *'--note TEXT    What happened, in the words of whoever runs this'*) ok ;; *) bad "--help should describe --note" ;; esac
case "$HELP" in *'--case is the old name of this option'*) ok ;; *) bad "--help should say --case is the old name" ;; esac
case "$HELP" in *'hang and watch do not ask'*) ok ;; *) bad "--help should say which modes ask" ;; esac
is "every mode's usage line takes --note" "$(printf '%s\n' "$HELP" | grep -c '^  .*excel_diagnostics.sh .*\[--note TEXT\] \[--workbook PATH\]')" 4

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
