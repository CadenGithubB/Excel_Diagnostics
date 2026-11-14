#!/bin/bash
# Checks what `excel_diagnostics.sh --redact` does, without collecting anything: it takes the redaction
# program out of the collector, runs it over made-up bundles with made-up names, and looks at what is left.
# Run on a Mac:  bash test/redact_test.sh
#
# Every name, serial number and address below is invented. Home folder paths are put together from parts
# so that this file holds no path that looks like a real person's.

# COLLECTOR_UNDER_TEST=path tests another copy of the collector (a relative path is taken from where you are).
SCRIPT=${COLLECTOR_UNDER_TEST:-}
case "$SCRIPT" in '') ;; /*) ;; *) SCRIPT="$PWD/$SCRIPT" ;; esac
cd "$(dirname "$0")/.." || exit 2
[ -n "$SCRIPT" ] || SCRIPT="$PWD/excel_diagnostics.sh"
[ -f "$SCRIPT" ] || { echo "no collector at $SCRIPT"; exit 2; }
WORK=$(mktemp -d -t redact_test) || exit 2
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
[ -n "$REDACT_TEST_KEEP" ] && { trap - EXIT; echo "Keeping the made-up bundles in $WORK"; }     # to look at them afterwards
PL="$WORK/redact.pl"
sed -n "/^IFS= read -r -d '' REDACT_PL <<'PERL'\$/,/^PERL\$/p" "$SCRIPT" | sed '1d;$d' > "$PL"
[ -s "$PL" ] || { echo "could not find the redaction program in $SCRIPT"; exit 2; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }
is()   { if [ "$2" = "$3" ]; then ok; else bad "$1: expected '$3', got '$2'"; fi; }
count() { grep -r -i -a -F -c -- "$2" "$1" 2>/dev/null | awk -F: '{ s += $NF } END { print s + 0 }'; }
# gone DIR NEEDLE WHAT - NEEDLE must not appear, in any case, in any file's text or in any name
gone() {
    is "$3 in file contents" "$(count "$1" "$2")" 0
    is "$3 in file names" "$(find "$1" | grep -i -F -c -- "$2")" 0
}
has()  { if grep -r -a -F -q -- "$2" "$1"; then ok; else bad "$3: '$2' should still be there"; fi; }
said() { case "$OUTPUT" in *"$1"*) ok ;; *) bad "$2: the result line should say '$1', it says: $OUTPUT" ;; esac; }
run()  { # run DIR -> sets RC and OUTPUT; identity comes from the variables set by the caller
    OUTPUT=$(RX_ROOT="$1" RX_USER="$WHO" RX_HOME="$HOMEDIR" RX_FULL="$FULL" RX_HOSTS="$HOSTS" RX_MODELS="$MODELS" \
        RX_SERIAL="$SERIAL" RX_UUID="$UUID" RX_UDID="$UDID" /usr/bin/perl "$PL" 2>"$WORK/stderr")
    RC=$?
    [ -s "$WORK/stderr" ] && [ -z "$EXPECT_STDERR" ] && bad "the program wrote to stderr: $(head -3 "$WORK/stderr")"
}

U=/Users                                   # joined with a name below, never written out whole
APOS=$'\xe2\x80\x99'                       # the curly apostrophe macOS puts in "Someone's MacBook Pro"
MODELS="MacBook Pro"$'\n'"MacBookPro18,3"
SERIAL=ZQ7TESTSER1; UUID=0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0; UDID=00008103-001A2B3C4D5E001E

# make_bundle DIR - a small bundle shaped like the collector's, naming $WHO, $FULL, $COMPUTER and the rest
make_bundle() {
    local B=$1 H="$U/$WHO" row
    row() { printf '2026-03-10 09:00:%02d.000000-0400\t2026-03-10 13:00:%02d.000000\tDefault\tMicrosoft Excel\t4121\tAppKit\t\t\texcel\t%s\n' "$1" "$1" "$2"; }
    mkdir -p "$B/system" "$B/unified_logs" "$B/office/onedrive_container_logs" "$B/office/excel_container_logs" \
        "$B/reports/user_Library_Logs_DiagnosticReports" "$B/reports/CrashReporter"
    {
        echo "Mode: collect  Days: 3  Ran as: root  Console user: $WHO"
        echo "      Model Name: MacBook Pro"
        echo "      Model Identifier: MacBookPro18,3"
        echo "      Serial Number (system): $SERIAL"
        echo "      Hardware UUID: $UUID"
        echo "      Provisioning UDID: $UDID"
    } > "$B/system/system_info.txt"
    {
        echo "[10:00:00] Excel diagnostics: collect (2026-03-08 through 2026-03-10) for user $WHO"
        echo "[10:00:01]   not found: $HOMEDIR/Library/Logs/Microsoft"
    } > "$B/collection.log"
    {
        printf 'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage\n'
        row 0 "Opened $H/Documents/Plan.xlsx for $FULL"
        row 1 "Signed in as $MAIL on $COMPUTER"
        row 2 "host $LOCALHOST.local, serial $SERIAL, maximum, $U/Shared/Fonts, $U/$OTHER/Desktop"
        row 3 "UPPER $(printf '%s' "$WHO" | tr a-z A-Z), reversed $REVERSED, joined $JOINED, uuid $(printf '%s' "$UUID" | tr A-F a-f)"
        # a line break or tab inside a message is written as \n or \t, so a name can follow one directly
        row 4 "Session:\\n$WHO\\n$FULL\\t$LOCALHOST\\n$SERIAL"
        # what is not an address: files and labels with an @ in them
        row 5 "icon@2x.png Budget@2026.xlsx report@final.xlsx node@20.plist"
        # the user part of a share goes, the server stays; a real address at a number-named domain goes whole
        row 6 "smb://netuser@fileserver.corp.example.net/Finance and netuser@git.example.net:team/repo.git and someone@163.example"
        # JSON inside a message arrives with its slashes escaped twice
        row 7 "request {\"path\":\"\\\\/Users\\\\/$OTHER\\\\/Library\\\\/x\"}"
        row 8 "${WHO}Backup ${WHO}2 ${WHO}_old user$(printf '%s' "$WHO" | cut -c1 | tr a-z A-Z)$(printf '%s' "$WHO" | cut -c2-)"
        # an address straight after an escaped line break or tab must not take the escape's letter with it
        row 9 "To:\\nsomeone@mail.example.org\\tcc: other@mail.example.org and smb://netuser:s3cret@fileserver.corp.example.net/Finance"
        # a path that ends at a home folder, with more words after it
        row 10 "cp $U/$OTHER dest/dir and $U/Shared dest/dir"
    } > "$B/unified_logs/2026-03-10.tsv"
    # Without jq the collector keeps log's own JSON lines: slashes and the apostrophe arrive escaped
    {
        printf '{"timestamp":"2026-03-10 09:00:00.000000-0400","processImagePath":"\\/Applications\\/Microsoft Excel.app","eventMessage":"read \\/Users\\/%s\\/Library\\/x on %s"}\n' "$WHO" "$(printf '%s' "$COMPUTER" | sed "s/$APOS/\\\\u2019/")"
        printf '{"timestamp":"2026-03-10 09:00:01.000000-0400","eventMessage":"file:///Users/%s/My%%20Docs and %%2FUsers%%2F%s%%2FDesktop and %s"}\n' "$WHO" "$WHO" "$(printf '%s' "$MAIL" | sed 's/@/%40/')"
    } > "$B/unified_logs/2026-03-11.ndjson"
    {
        printf '{"app_name":"Microsoft Excel","timestamp":"2026-03-10 10:35:00.00 -0400","bug_type":"309","os_version":"macOS 15.7 (24G1)"}\n'
        printf '{\n  "crashReporterKey" : "ABCDEF01-2345-6789-ABCD-EF0123456789",\n  "storeInfo" : {"deviceIdentifierForVendor":"FEDCBA98-7654-3210-FEDC-BA9876543210","thirdParty":true},\n  "procPath" : "\\/Applications\\/Microsoft Excel.app",\n  "usedImages" : [ { "path" : "\\/Users\\/%s\\/Library\\/Addins\\/tool.dylib" } ],\n  "userID" : 501\n}\n' "$WHO"
    } > "$B/reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips"
    echo "Command: Microsoft Excel   Path: $H/tool" > "$B/reports/user_Library_Logs_DiagnosticReports/Microsoft Excel_2026-03-10-103500_$LOCALHOST.cpu_resource.diag"
    echo "-rw-------  1 $WHO  staff  1234 Mar 10 10:35 Microsoft Excel_2026-03-10-103500_$LOCALHOST.cpu_resource.diag" > "$B/reports/report_listing.txt"
    echo "=== /Library/Managed Preferences/$WHO/com.microsoft.Excel.plist" > "$B/office/office_prefs.txt"
    printf 'EBFGONED\0\0\0\1\2\3\4\5 %s\0\0\0\0' "$H" > "$B/office/onedrive_container_logs/SyncEngine-2026-03-10.odlgz"
    head -c 4096 /dev/zero > "$B/office/excel_container_logs/AllZero.log"
    # a log given its full size in advance: text, then zero bytes
    { echo "03/10/2026 13:00:00.000 opened $H/Documents/Plan.xlsx"; head -c 300000 /dev/zero; } > "$B/office/excel_container_logs/Padded.log"
    printf '\0\0\0\1Bud1\0\0\0\0' > "$B/office/.DS_Store"
    printf '\xff\xfeh\0o\0m\0e\0' > "$B/office/utf16.log"
    : > "$B/unified_logs/2026-03-09.errors.txt"
    printf '\033[31mred\033[0m %s\n' "$H/colour" > "$B/office/coloured.log"
    ln -s "$H/Library/Logs" "$B/office/link_to_logs"
    plist() { printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>path</key><string>%s/Library/x</string>%s</dict></plist>\n' "$H" "$2" > "$1"; plutil -convert binary1 "$1"; }
    plist "$B/reports/CrashReporter/Microsoft Excel_$UUID.plist" ''
    plist "$B/reports/CrashReporter/Intervals_$UUID.plist" '<key>bookmark</key><data>Ym9va21hcms=</data>'
    printf '{\n  "ForceQuitDate" => 2026-03-10 08:50:00 -0400\n}\n' > "$B/reports/CrashReporter/Microsoft Excel_$UUID.txt"
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>bookmark</key><data>Ym9va21hcms=</data></dict></plist>\n' > "$B/office/already_text.plist"
}

echo "1. An ordinary account: every form of the names is replaced, the rest is left alone"
WHO=rowanq; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="Quimby, Rowan"; JOINED="rowan.quimby"
COMPUTER="Rowan${APOS}s MacBook Pro"; LOCALHOST="Rowans-MacBook-Pro"; OTHER=tamsinv
HOSTS="$COMPUTER"$'\n'"$LOCALHOST"$'\n'"rowans-macbook-pro.corp.example.net"$'\n'"rowans-macbook-pro"
MAIL="$WHO@mail.example.org"
B="$WORK/one"; make_bundle "$B"; rows_before=$(awk -F'\t' '{ print NF }' "$B/unified_logs/2026-03-10.tsv" | sort -u | tr '\n' ' ')
run "$B"
is "exit status" "$RC" 0
said "check found none left" "the check"
gone "$B" "$WHO" "account name"
gone "$B" "quimby" "family name"
gone "$B" "Rowans-MacBook" "host name"
gone "$B" "Rowan${APOS}s" "computer name"
gone "$B" 'Rowan’s' "computer name as JSON writes it"
gone "$B" "$SERIAL" "serial number"
gone "$B" "$UUID" "hardware UUID"
gone "$B" "$UDID" "provisioning UDID"
gone "$B" "example.org" "email domain"
gone "$B" "163.example" "an address at a domain that starts with a number"
gone "$B" "netuser" "the user part of a share and of a name@server:path"
gone "$B" "$OTHER" "another account's home folder name"
gone "$B" "ABCDEF01-2345" "crash reporter key"
gone "$B" "FEDCBA98-7654" "the vendor's device key"
has "$B" "icon@2x.png Budget@2026.xlsx report@final.xlsx node@20.plist" "file names with an @ in them"
has "$B" "smb://redacted-user@fileserver.corp.example.net/Finance" "the server of a share"
has "$B" "redacted-user@git.example.net:team/repo.git" "the server of a name@server:path"
has "$B" "maximum" "ordinary words"
has "$B" "$U/Shared/Fonts" "the shared folder"
has "$B" "Model Name: MacBook Pro" "the model name"
has "$B" "Model Identifier: MacBookPro18,3" "the model identifier"
has "$B" "$U/redacted-user/Documents/Plan.xlsx" "the rest of a path"
has "$B" 'Session:\nredacted-user\nredacted-name\tredacted-computer\nredacted-serial' "names straight after an escaped line break or tab"
has "$B" 'redacted-userBackup redacted-user2 redacted-user_old userredacted-user' "a long account name at the start of a longer word"
has "$B" "Console user: redacted-user" "the console user line"
has "$B" "Managed Preferences/redacted-user/" "the managed preferences path"
has "$B" 'Serial Number (system): redacted-serial' "the serial number line"
is "tab-separated columns unchanged" "$(awk -F'\t' '{ print NF }' "$B/unified_logs/2026-03-10.tsv" | sort -u | tr '\n' ' ')" "$rows_before"
is "timestamps unchanged" "$(cut -f1 "$B/unified_logs/2026-03-10.tsv" | grep -c '^2026-03-10 09:00:[01][0-9]\.000000-0400$')" 11
has "$B" 'To:\nredacted-email\tcc: redacted-email and smb://redacted-user@fileserver.corp.example.net/Finance' "an address after an escape keeps the escape, and a share with a password keeps its server"
gone "$B" "s3cret" "the password in a share address"
has "$B" "cp $U/redacted-user dest/dir and $U/Shared dest/dir" "the words after a path that ends at a home folder"
ips="$B/reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips"
is "crash report is still valid JSON" "$(/usr/bin/perl -MJSON::PP -e 'local $/; my @l = split /\n/, <STDIN>, 2; decode_json($_) for @l; print "valid"' < "$ips" 2>&1)" valid
is "JSON log lines are still valid" "$(/usr/bin/perl -MJSON::PP -ne 'decode_json($_); END { print "valid" }' "$B/unified_logs/2026-03-11.ndjson" 2>&1)" valid
is "binary file left out" "$([ -e "$B/office/onedrive_container_logs/SyncEngine-2026-03-10.odlgz" ] && echo there || echo gone)" gone
is "the folder it emptied is gone too" "$([ -d "$B/office/onedrive_container_logs" ] && echo there || echo gone)" gone
is ".DS_Store left out" "$([ -e "$B/office/.DS_Store" ] && echo there || echo gone)" gone
is "symbolic link left out" "$([ -L "$B/office/link_to_logs" ] && echo there || echo gone)" gone
is "UTF-16 text left out" "$([ -e "$B/office/utf16.log" ] && echo there || echo gone)" gone
is "a file of zero bytes only is kept" "$([ -e "$B/office/excel_container_logs/AllZero.log" ] && echo there || echo gone)" there
is "a log that is text and then zero bytes is kept and rewritten" "$(grep -a -c "redacted-user/Documents/Plan.xlsx" "$B/office/excel_container_logs/Padded.log")" 1
is "and keeps its length" "$(wc -c < "$B/office/excel_container_logs/Padded.log" | tr -d ' ')" "$(( $(printf '03/10/2026 13:00:00.000 opened %s/redacted-user/Documents/Plan.xlsx\n' "$U" | wc -c) + 300000 ))"
is "empty file kept" "$([ -e "$B/unified_logs/2026-03-09.errors.txt" ] && echo there || echo gone)" there
is "log with colour codes kept" "$(grep -c 'redacted-user/colour' "$B/office/coloured.log")" 1
is "report renamed, date and kind kept" "$(ls "$B/reports/user_Library_Logs_DiagnosticReports" | grep -c '^Microsoft Excel_2026-03-10-103500_redacted-computer\.cpu_resource\.diag$')" 1
is "property list is text and still valid" "$(plutil -lint -s "$B/reports/CrashReporter/Microsoft Excel_redacted-hardware-uuid.plist" && head -c 5 "$B/reports/CrashReporter/Microsoft Excel_redacted-hardware-uuid.plist")" '<?xml'
is "property list holding encoded data left out" "$(ls "$B/reports/CrashReporter" | grep -c Intervals)" 0
is "and so is one that was text to begin with" "$([ -e "$B/office/already_text.plist" ] && echo there || echo gone)" gone
is "the collector's own folders keep their names" "$(cd "$B" && ls -d office reports/CrashReporter reports/user_Library_Logs_DiagnosticReports system unified_logs 2>/dev/null | wc -l | tr -d ' ')" 5
has "$B/redaction.txt" "Result: complete." "the report's first line"
has "$B/redaction.txt" "Left out: 6 file(s)" "the report counts what was left out"
has "$B/redaction.txt" "    office/onedrive_container_logs/SyncEngine-2026-03-10.odlgz" "the report names each file left out"
has "$B/redaction.txt" "Found again: none." "the report states the check"
if command -v deno >/dev/null 2>&1; then    # the viewer's engine still reads the force-quit record by its app
    cat > "$WORK/engine.mjs" <<'EOF'
const Core = new Function(await Deno.readTextFile(Deno.args[0]) + '\nreturn Core;')();
const inputs = [], walk = async (dir, rel) => { for await (const e of Deno.readDir(dir)) { if (e.isDirectory) await walk(`${dir}/${e.name}`, `${rel}${e.name}/`); else inputs.push({ path: `b/${rel}${e.name}`, blob: new Blob([await Deno.readFile(`${dir}/${e.name}`)]) }); } };
await walk(Deno.args[1], '');
const info = await new Core.Dataset().load(inputs, () => {});
console.log(info.reports.filter((r) => r.kind === 'Force quit').map((r) => r.proc).join(',') + '|' + info.total);
EOF
    is "the viewer still names the app of a force-quit record, and reads every entry" "$(deno run --allow-read "$WORK/engine.mjs" src/core.js "$B" 2>&1)" "Microsoft Excel|16"
fi

echo "2. Running it again changes nothing"
cp -R "$B" "$WORK/again"; rm -f "$WORK/again/redaction.txt"; before=$(cd "$WORK/again" && find . -type f -exec shasum {} + | sort | shasum)
run "$WORK/again"
is "exit status" "$RC" 0
case "$OUTPUT" in "0 replacement(s)"*) ok ;; *) bad "second run replaced something: $OUTPUT" ;; esac
rm -f "$WORK/again/redaction.txt"
is "files identical" "$(cd "$WORK/again" && find . -type f -exec shasum {} + | sort | shasum)" "$before"

echo "3. A three-letter account name is replaced as a whole word, and the report says what that means"
WHO=max; HOMEDIR="$U/$WHO"; FULL="Max Okonkwo-Reyes"; REVERSED="Okonkwo-Reyes, Max"; JOINED="Max Okonkwo"
COMPUTER="FIN-LT-0423"; LOCALHOST="FIN-LT-0423"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/three"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "maximum" "a longer word that starts with the name"
has "$B" "for user redacted-user" "the name on its own"
gone "$B" "FIN-LT-0423" "asset-tag computer name"
gone "$B" "okonkwo" "family name, in the family-name-first form and without its second half"
gone "$B" "reyes" "second half of the family name"
is "the name as a word is gone" "$(grep -r -i -a -E -c '(^|[^A-Za-z0-9])max([^A-Za-z0-9]|$)' "$B" | awk -F: '{ s += $NF } END { print s + 0 }')" 0
has "$B/redaction.txt" "every separate use of that word was replaced" "the report's note about a short name"

echo "4. An account named for its kind is replaced only inside paths, a model-named Mac is left, and the result says so"
WHO=admin; HOMEDIR="$U/$WHO"; FULL="Local Admin"; REVERSED="Admin, Local"; JOINED="local admin"
COMPUTER="MacBook Pro"; LOCALHOST="MacBook-Pro"; HOSTS="$COMPUTER"$'\n'"$LOCALHOST"; MAIL="it@mail.example.org"
B="$WORK/four"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "for user admin" "the word admin outside a path"
has "$B" "for Local Admin" "a full name made of common words"
has "$B" "Model Name: MacBook Pro" "a computer named after its model"
said "this Mac's name was left as it is" "the model-named Mac"
said "the account name only says what kind of account it is" "the account name"
said "the full name was left as it is" "the full name"
has "$B/redaction.txt" "Result: complete, with the exceptions listed below." "the report's first line"
is "no home folder named admin left" "$(grep -r -a -c "$U/admin" "$B" | awk -F: '{ s += $NF } END { print s + 0 }')" 0

echo "5. A Mac named with a common word and a number is not a model name"
WHO=rowanq; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="x"
COMPUTER="LAPTOP-0423"; LOCALHOST="LAPTOP-0423"; HOSTS="$COMPUTER"$'\n'"laptop-0423.corp.example.net"; MAIL="$WHO@mail.example.org"
B="$WORK/five"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
gone "$B" "LAPTOP-0423" "asset-tag computer name"

echo "6. An accented name is found however it is spelled"
WHO=jnunez; HOMEDIR="$U/$WHO"; FULL=$'Jos\xc3\xa9 N\xc3\xba\xc3\xb1ez'; REVERSED=$'Nu\xcc\x81n\xcc\x83ez, Jose\xcc\x81'
JOINED=$'JOS\xc3\x89 N\xc3\x9a\xc3\x91EZ and Jose Nunez and jose_nunez and Jos\\u00e9 N\\u00fa\\u00f1ez and Jos%C3%A9%20N%C3%BA%C3%B1ez'
COMPUTER="Studio-7"; LOCALHOST="Studio-7"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/six"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
gone "$B" $'N\xc3\xba\xc3\xb1ez' "composed spelling"
gone "$B" $'Nu\xcc\x81n\xcc\x83ez' "decomposed spelling"
gone "$B" $'N\xc3\x9a\xc3\x91EZ' "capitals"
gone "$B" "nunez" "unaccented spelling"
gone "$B" 'Nú' "JSON-escaped spelling"
gone "$B" 'N%C3%BA' "URL-escaped spelling"

echo "7. A full name whose parts run together into an ordinary word does not take that word"
WHO=kento7; HOMEDIR="$U/$WHO"; FULL="Ken To"; REVERSED="To, Ken"; JOINED="auth token refreshed, token_type=bearer"
COMPUTER="Tower-9"; LOCALHOST="Tower-9"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/seven"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "auth token refreshed, token_type=bearer" "the word token"
has "$B" "for redacted-name" "the name in its own order"
has "$B" "reversed redacted-name" "the name family-name-first"

echo "8. A long account name is not taken from the middle of a longer word"
WHO=porter; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="Reporter exporter CrashReporter supporter"
COMPUTER="Tower-9"; LOCALHOST="Tower-9"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/eight"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "Reporter exporter CrashReporter supporter" "longer words that hold the name"
is "the CrashReporter folder keeps its name" "$([ -d "$B/reports/CrashReporter" ] && echo there || echo gone)" there
has "$B" "for user redacted-user" "the name on its own"

echo "9. A home folder outside /Users, and another account's folder with a space in its name (hidden up to the space)"
WHO=tv; HOMEDIR="/Volumes/Homes/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="$U/Orla Finch/Desktop/a.xlsx and file://$U/Orla%20Finch/b.xlsx"
COMPUTER="Tower-9"; LOCALHOST="Tower-9"; HOSTS="$COMPUTER"; MAIL="rq@mail.example.org"
B="$WORK/nine"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "not found: /Volumes/Homes/redacted-user/Library/Logs/Microsoft" "the home folder where it is"
has "$B" "$U/redacted-user Finch/Desktop/a.xlsx and file://$U/redacted-user/b.xlsx" "another account's folder: whole when its space is escaped, cut at a plain space"
has "$B/redaction.txt" "what follows a plain space in another account's home folder name" "the report names that limit"

echo "9a. A full name in letters outside Western Europe is handled like any other"
WHO=lnowak; HOMEDIR="$U/$WHO"; FULL=$'\xc5\x81ukasz Nowak'; REVERSED=$'NOWAK \xc5\x81ukasz'; JOINED=$'\xd0\x98\xd0\xb2\xd0\xb0\xd0\xbd'
COMPUTER="Tower-9"; LOCALHOST="Tower-9"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/ninea"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
gone "$B" "Nowak" "family name"
gone "$B" $'\xc5\x81ukasz' "given name"

echo "9b. A short account name that sits inside one of the replacement words is still replaced as a word"
WHO=ted; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="x"
B="$WORK/nineb"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "for user redacted-user" "the name on its own"
is "the replacement words are not rewritten" "$(grep -r -a -c 'redacredacted' "$B" | awk -F: '{ s += $NF } END { print s + 0 }')" 0

echo "9c. An account name in two parts is found at the start of a longer word too"
WHO=pat.lee; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="pat.leeBackup and pat_lee2"
B="$WORK/ninec"; make_bundle "$B"; run "$B"
is "exit status" "$RC" 0
has "$B" "joined redacted-userBackup and redacted-user2" "the name joined to more letters"

echo "10. A .logarchive is left alone, and that makes the result incomplete"
WHO=rowanq; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; REVERSED="x"; JOINED="x"; COMPUTER="Tower-9"; LOCALHOST="Tower-9"; HOSTS="$COMPUTER"; MAIL="$WHO@mail.example.org"
B="$WORK/ten"; make_bundle "$B"; mkdir -p "$B/unified_logs/system_logs_from_2026-03-08.logarchive"
echo "$WHO was here" > "$B/unified_logs/system_logs_from_2026-03-08.logarchive/Info.txt"
run "$B"
is "exit status" "$RC" 3
is "archive untouched" "$(cat "$B/unified_logs/system_logs_from_2026-03-08.logarchive/Info.txt")" "$WHO was here"
has "$B/redaction.txt" "Result: NOT complete: an Apple .logarchive is in the bundle and was not changed." "the report's first line"

echo "11. With nothing known about the Mac, paths and email addresses are still handled, and the result says what was not looked for"
B="$WORK/eleven"; make_bundle "$B"
saved=$WHO; WHO=""; HOMEDIR=""; FULL=""; HOSTS=""; s2=$SERIAL; u2=$UUID; d2=$UDID; SERIAL=""; UUID=""; UDID=""
run "$B"; WHO=$saved; SERIAL=$s2; UUID=$u2; UDID=$d2
is "exit status" "$RC" 0
is "no home folder name left" "$(grep -r -a -c "$U/$WHO" "$B" | awk -F: '{ s += $NF } END { print s + 0 }')" 0
gone "$B" "example.org" "email domain"
has "$B" 'Serial Number (system): redacted-serial' "a serial number on a line labelled as holding it"
said "the full name is not known, so it was not looked for" "the full name"
said "this Mac's name is not known" "the computer name"
has "$B/redaction.txt" "Left as it is, or not looked for:" "the report's list of exceptions"

echo "12. When a rewritten copy cannot be written, nothing is deleted and the run stops"
B="$WORK/twelve"; HOMEDIR="$U/$WHO"; HOSTS="$COMPUTER"; make_bundle "$B"; chmod 555 "$B/system"
EXPECT_STDERR=1 run "$B"; chmod 755 "$B/system"
is "exit status" "$RC" 4
is "the file that could not be rewritten is still there, as it was" "$(grep -c "Console user: $WHO" "$B/system/system_info.txt")" 1
is "files that would have been left out are still there too" "$([ -e "$B/office/onedrive_container_logs/SyncEngine-2026-03-10.odlgz" ] && [ -L "$B/office/link_to_logs" ] && [ -e "$B/office/.DS_Store" ] && echo there || echo gone)" there
is "it says why, without the bundle's own path" "$(grep -c "cannot write beside system/system_info.txt" "$WORK/stderr")" 1
is "no half-written copy is left" "$(find "$B" -name '.redacting.*' | wc -l | tr -d ' ')" 0

echo "13. A folder that cannot be opened makes the result incomplete"
B="$WORK/thirteen"; make_bundle "$B"; mkdir "$B/office/locked"; echo "$WHO" > "$B/office/locked/x.txt"; chmod 000 "$B/office/locked"
run "$B"; chmod 755 "$B/office/locked"
is "exit status" "$RC" 3
has "$B/redaction.txt" "Result: NOT complete:" "the report's first line"
has "$B/redaction.txt" "Problems:" "the report's list of problems"

echo "14. A binary property list that unfolds into any amount of text is left out in time"
B="$WORK/fourteen"; make_bundle "$B"
python3 -I -c 'import plistlib,sys
a = []
for i in range(40): a = [a, a]
plistlib.dump(a, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Nested.plist"
python3 -I -c 'import plistlib,sys; plistlib.dump({"Owner": sys.argv[2]}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Plain.plist" "$WHO"
SECONDS=0; run "$B"; took=$SECONDS
is "it ends in time" "$([ $took -le 20 ] && echo 'in time' || echo "after $took s")" 'in time'
has "$B/redaction.txt" "a binary property list that plutil did not turn into text within 5 seconds" "the report says why it was left out: the time"
is "it is left out, and the plain one is turned into text and rewritten" "$([ -e "$B/reports/CrashReporter/Microsoft Nested.plist" ] && echo kept || echo 'left out') $(grep -c '<plist' "$B/reports/CrashReporter/Microsoft Plain.plist" 2>/dev/null) $(count "$B/reports/CrashReporter/Microsoft Plain.plist" "$WHO")" 'left out 1 0'
is "nothing half-made is left" "$(find "$B" -name '.redacting.*' | wc -l | tr -d ' ')" 0
# One that unfolds quickly into more text than a converted list may hold (86 MB in about two seconds): left out for its size
B="$WORK/fourteen-b"; make_bundle "$B"
python3 -I -c 'import plistlib,sys
a = []
for i in range(20): a = [a, a]
plistlib.dump(a, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Wide.plist"
run "$B"
is "a list that unfolds past the size is left out, not kept as text, and the report says it was the size" "$([ -e "$B/reports/CrashReporter/Microsoft Wide.plist" ] && echo kept || echo 'left out') $(find "$B" -name '.redacting.*' | wc -l | tr -d ' ') $(grep -c 'a binary property list whose text came to more than 16 MB, so it was not turned into text' "$B/redaction.txt")" 'left out 0 1'
# One that unfolds into 24 MB, more than the 16 MB a converted list may hold (counted by the program itself, as it
# writes what plutil gives it)
B="$WORK/fourteen-c"; make_bundle "$B"
python3 -I -c 'import plistlib,sys
plistlib.dump({"Owner": ["x" * 24000] * 1000}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Mid.plist"
run "$B"
# plutil builds the whole text in memory before writing any of it: each conversion is given 5 seconds, as root and
# with the console user's rights (that second way needs root, so the line is looked for)
is "each conversion is given at most 5 seconds" "$(grep -c '^            alarm 5; exec @run;$' "$PL") $(grep -c "'--', '-', 5, \$ENV{RX_AS_UID}" "$PL")" '1 1'
is "a list that unfolds into 24 MB is left out for its size" "$([ -e "$B/reports/CrashReporter/Microsoft Mid.plist" ] && echo kept || echo 'left out') $(grep -c 'a binary property list whose text came to more than 16 MB, so it was not turned into text' "$B/redaction.txt")" 'left out 1'
# How plutil ended is told apart. A file that only starts like a binary property list: plutil's own answer
B="$WORK/fourteen-d"; make_bundle "$B"; printf 'bplist00 MADE-UP and nothing more\n' > "$B/reports/CrashReporter/Microsoft Fake.plist"
run "$B"
is "a file that only starts like a binary property list is left out, as one plutil could not read" "$([ -e "$B/reports/CrashReporter/Microsoft Fake.plist" ] && echo kept || echo 'left out') $(grep -c 'a file that starts like a binary property list, which plutil could not read as one' "$B/redaction.txt") $(grep -c 'within 5 seconds' "$B/redaction.txt")" 'left out 1 0'
# With the console user's rights (here the test's own account): the time limit is that of the program that takes on
# the rights, the size is counted as before, and rights that cannot be taken on are said to be that
ASPL=$(sed -n "/^IFS= read -r -d '' AS_USER_PL <<'PERL'\$/,/^PERL\$/p" "$SCRIPT" | sed '1d;$d')
[ -n "$ASPL" ] || { echo "could not find AS_USER_PL in $SCRIPT"; exit 2; }
B="$WORK/fourteen-e"; make_bundle "$B"
python3 -I -c 'import plistlib,sys
a = []
for i in range(40): a = [a, a]
plistlib.dump(a, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Nested.plist"
python3 -I -c 'import plistlib,sys
plistlib.dump({"Owner": ["x" * 24000] * 1000}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Mid.plist"
SECONDS=0; RX_CONVERT=user RX_AS_PL=$ASPL RX_AS_UID=$(id -u) RX_AS_GID=$(id -g) RX_AS_GROUPS="$(id -G)" run "$B"; took=$SECONDS
is "with the user's rights: in time, the time and the size each said, and the plain one turned into text" "$([ $took -le 25 ] && echo 'in time' || echo "after $took s") $(grep -c 'did not turn into text within 5 seconds' "$B/redaction.txt") $(grep -c 'whose text came to more than 16 MB' "$B/redaction.txt") $(grep -c '<plist' "$B/reports/CrashReporter/Microsoft Excel_redacted-hardware-uuid.plist" 2>/dev/null)" 'in time 1 1 1'
B="$WORK/fourteen-f"; make_bundle "$B"
RX_CONVERT=user RX_AS_PL=$ASPL RX_AS_UID=$(( $(id -u) + 1 )) RX_AS_GID=$(id -g) RX_AS_GROUPS="$(id -G)" run "$B"
is "rights that could not be taken on are said to be that" "$(grep -c "a binary property list, not turned into text: the console user's rights could not be used for it" "$B/redaction.txt") $(grep -c 'within 5 seconds\|could not read as one' "$B/redaction.txt")" '1 0'
# A text copy that cannot be written (here every file is held to 64 KB, and this list unfolds into more): the whole
# pass stops, as when a rewritten copy cannot be written, and nothing is left out or deleted
B="$WORK/fourteen-g"; mkdir -p "$B/reports/CrashReporter"; printf 'MADE-UP small text\n' > "$B/a.txt"
python3 -I -c 'import plistlib,sys
plistlib.dump({"Owner": ["x" * 1000] * 200}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Big.plist"
( trap '' XFSZ; ulimit -S -f 64; EXPECT_STDERR=1 run "$B"; echo "$RC" > "$WORK/fourteen-g.rc" )
is "a text copy that cannot be written stops the pass, and the list is still there" "$(cat "$WORK/fourteen-g.rc") $([ -e "$B/reports/CrashReporter/Microsoft Big.plist" ] && echo kept || echo gone) $(grep -c 'cannot write a text copy of reports/CrashReporter/Microsoft Big.plist' "$WORK/stderr") $(find "$B" -name '.redacting.*' | wc -l | tr -d ' ')" '4 kept 1 0'

echo "15. Without the console user's rights, binary property lists are not turned into text as root"
B="$WORK/fifteen"; make_bundle "$B"
python3 -I -c 'import plistlib,sys; plistlib.dump({"Owner": sys.argv[2]}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Plain.plist" "$WHO"
RX_CONVERT=none-rights run "$B"
has "$B/redaction.txt" "a binary property list, not turned into text: that is done only with the console user's rights, which could not be taken on in this run (see user_files in manifest.tsv)" "the report says why it was left out"
is "it is left out" "$([ -e "$B/reports/CrashReporter/Microsoft Plain.plist" ] && echo kept || echo 'left out')" 'left out'
# When the run had stopped running anything with those rights (a helper stopped at its time limit, say), that is
# what is said: not that the rights could not be taken on
B="$WORK/fifteen-b"; make_bundle "$B"
python3 -I -c 'import plistlib,sys; plistlib.dump({"Owner": sys.argv[2]}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Plain.plist" "$WHO"
RX_CONVERT=none-closed run "$B"
is "a run that had stopped using the user's rights says that, and not that they could not be taken on" \
    "$(grep -c "a binary property list, not turned into text: that is done only with the console user's rights, and this run had stopped running anything with them (see time_limit or user_files in manifest.tsv)" "$B/redaction.txt") $(grep -c 'could not be taken on\|could not be used' "$B/redaction.txt")" '1 0'

echo "16. Address-like runs take time in step with their length, and a long address is replaced whole"
# A run of "%41" with an @ that leads to no address: a match tried from each %41 would read the rest of the run again
# (four lines of 30,000 took over a minute that way). Each tail makes the address rules try something else.
B="$WORK/sixteen"; make_bundle "$B"
/usr/bin/perl -e 'for my $t ("@ x", "@ .ab", "\@a.b.c.d:", "\@a.b!") { print "run ", "%41" x 30000, "$t\n" }' > "$B/office/runs.log"
LONGLOCAL="session_$(printf 'x%.0s' $(seq 1 60)).pat.lee@example.com"; LONGID="id=$(printf 'x%.0s' $(seq 1 70))@example.com"
HEADED="q=$(printf '%%61%.0s' $(seq 1 30))%40example.com"
printf '%s\n' "$LONGLOCAL" "$LONGID" "$HEADED" 'x\npat@example.com and %20pat@example.com' > "$B/office/addresses.log"
SECONDS=0; run "$B"; took=$SECONDS
is "lines of 90 KB of address-like text take seconds at most" "$([ $took -le 5 ] && echo 'in time' || echo "after $took s")" 'in time'
is "an address with a long first part is replaced whole, and so is one written with %XX" "$(cat "$B/office/addresses.log" | tr '\n' '|')" 'redacted-email|id=redacted-email|q=redacted-email|x\nredacted-email and redacted-email|'
is "exit status" "$RC" 0

echo "17. Many files whose names hide to the same name are renamed in time"
B="$WORK/seventeen"; make_bundle "$B"; mkdir -p "$B/office/many"
/usr/bin/perl -e 'for (1 .. 4000) { open my $f, ">", "$ARGV[0]/$_\@made-up.example.com_a.txt" or die; close $f }' "$B/office/many"
# a name the numbering comes to is already there: it is passed over, not written over
printf 'MADE-UP already there\n' > "$B/office/many/redacted-email_a-7.txt"
SECONDS=0; run "$B"; took=$SECONDS
is "4,000 names that hide to one are renamed in seconds" "$([ $took -le 8 ] && echo 'in time' || echo "after $took s")" 'in time'
is "each has a name of its own, and the name that was there keeps its file" "$(ls "$B/office/many" | grep -c '^redacted-email_a') $(ls "$B/office/many" | sort | uniq -d | wc -l | tr -d ' ') $(cat "$B/office/many/redacted-email_a-7.txt")" '4001 0 MADE-UP already there'

echo "18. The step has a time limit, and ends with a status of its own when it is reached"
# The list below takes plutil its 5 seconds; the time allowed for the whole step is 1 second
B="$WORK/eighteen"; make_bundle "$B"
python3 -I -c 'import plistlib,sys
a = []
for i in range(40): a = [a, a]
plistlib.dump(a, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft Nested.plist"
SECONDS=0; RX_SECONDS=1 EXPECT_STDERR=1 run "$B"; took=$SECONDS
is "stopped at its time limit: status 5, in time, and it says so" "$RC $([ $took -le 3 ] && echo 'in time' || echo "after $took s") $(grep -c '^stopped at the time limit of 1 seconds$' "$WORK/stderr")" '5 in time 1'

echo "19. A name is not made longer when a path in the bundle would then be longer than 1,000 bytes"
# deep ROOT FOLDER FILE LENGTH - makes ROOT/x.../FOLDER/FILE, whose path is LENGTH bytes long, filled in with folders
# of x's, and puts a line of made-up text in it
deep() {
    /usr/bin/perl -e 'my ($root, $name, $file, $total) = @ARGV; my $left = $total - length($root) - 1 - length($name) - 1 - length($file); my $p = $root;
        while ($left > 0) { my $n = $left - 1; $n = 200 if $n > 200; $n-- if $left - ($n + 1) == 1; $p .= "/" . ("x" x $n); $left -= $n + 1 }
        die "no room\n" if $left < 0; $p .= "/$name"; system("/bin/mkdir", "-p", $p) == 0 or die; open my $f, ">", "$p/$file" or die "$!\n"; print {$f} "MADE-UP deep text\n"; close $f;
        print length("$p/$file"), "\n"' -- "$@"
}
longest() { find "$1" | LC_ALL=C awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }'; }
# The account name, three times in one folder's name, takes 21 bytes more once it is hidden (rowanq, redacted-user)
WHO=rowanq; HOMEDIR="$U/$WHO"; FULL="Rowan Quimby"; HOSTS=""; G="${WHO}_${WHO}_${WHO}"
# 1,021 bytes once renamed: a path the check can still read and the zip step cannot take
B="$WORK/nineteen-a"; mkdir -p "$B"; deep "$B" "$G" "a.txt" 1000 > /dev/null; run "$B"
is "a rename that would make a path of 1,021 bytes is not made, is listed, and the result is not complete" \
    "$RC $(longest "$B") $(grep -c "^  .*: not renamed: with the name it would be given, a path in the bundle would be longer than 1,000 bytes\$" "$B/redaction.txt") $(grep -c '^Result: NOT complete' "$B/redaction.txt") $(find "$B" -name "$G" | wc -l | tr -d ' ')" '3 1000 1 1 1'
# 1,035 bytes once renamed: a path the check could not even look at
B="$WORK/nineteen-b"; mkdir -p "$B"; deep "$B" "${G}_${WHO}_${WHO}" "a.txt" 1000 > /dev/null; run "$B"
is "nor one that would make a path of 1,035 bytes" "$RC $(longest "$B") $(grep -c 'not renamed: with the name it would be given' "$B/redaction.txt")" '3 1000 1'
# Exactly 1,000 bytes once renamed: made
B="$WORK/nineteen-c"; mkdir -p "$B"; deep "$B" "$G" "a.txt" 979 > /dev/null; run "$B"
is "a rename that leaves the longest path at 1,000 bytes is made" "$RC $(longest "$B") $(grep -c 'not renamed' "$B/redaction.txt") $(find "$B" -name "$G" | wc -l | tr -d ' ')" '0 1000 0 0'
# A name that is taken gets a number, and the number counts: 999 bytes renamed, 1,001 with its "-2"
B="$WORK/nineteen-d"; mkdir -p "$B"; deep "$B" "$G" "a.txt" 978 > /dev/null
d=$(dirname "$(find "$B" -name a.txt | head -1)"); mkdir "$(dirname "$d")/redacted-user_redacted-user_redacted-user"; run "$B"
is "the number a taken name gets is counted in the path's length" "$RC $(find "$B" -name a.txt | LC_ALL=C awk '{ print length($0) }') $(grep -c 'not renamed: with the name it would be given' "$B/redaction.txt")" '3 978 1'
# A folder above, renamed after what is in it: the paths below it are counted
B="$WORK/nineteen-e"; mkdir -p "$B/$G"; deep "$B/$G" "plain" "a.txt" 990 > /dev/null; run "$B"
is "a folder is not renamed when a path below it would then be too long" "$RC $(longest "$B") $(grep -c 'not renamed' "$B/redaction.txt") $([ -d "$B/$G" ] && echo kept || echo renamed)" '3 990 1 kept'

echo "20. An entry the check cannot look at is listed as not checked, and the result is not complete"
# A file whose path is longer than the 1,023 bytes a path can have: it can be made from inside its folder only
B="$WORK/twenty"; mkdir -p "$B"; deep "$B" "plain" "a.txt" 1000 > /dev/null
/usr/bin/perl -e 'chdir $ARGV[0] or die "$!\n"; open my $f, ">", "MADE-UP-" . ("y" x 60) . ".txt" or die "$!\n"; print {$f} "MADE-UP far\n"; close $f' "$(dirname "$(find "$B" -name a.txt | head -1)")"
run "$B"
is "a file past the length a path can have is listed as not checked, and the result is not complete" \
    "$RC $(grep -c '^Result: NOT complete: .*1 file(s) left in the bundle could not be read or checked' "$B/redaction.txt") $(grep -c '(could not be looked at: File name too long)$' "$B/redaction.txt") $(grep -c 'Found again: none\.' "$B/redaction.txt")" '3 1 1 1'

echo "21. A bundle with nothing left out says how many binary property lists were turned into text"
B="$WORK/twentyone"; mkdir -p "$B/reports/CrashReporter"; printf 'MADE-UP plain\n' > "$B/a.txt"
python3 -I -c 'import plistlib,sys; plistlib.dump({"Owner": "MADE-UP"}, open(sys.argv[1], "wb"), fmt=plistlib.FMT_BINARY)' "$B/reports/CrashReporter/Microsoft One.plist"
run "$B"
is "nothing left out: every file was text, or a binary property list turned into text, and how many" \
    "$(grep -c '^Left out: nothing\. Every file in the bundle was plain text, or a binary property list that was turned into text (1)\.$' "$B/redaction.txt") $(head -c 5 "$B/reports/CrashReporter/Microsoft One.plist")" '1 <?xml'
B="$WORK/twentyone-b"; mkdir -p "$B"; printf 'MADE-UP plain\n' > "$B/a.txt"; run "$B"
is "and with none, that every file was text" "$(grep -c '^Left out: nothing\. Every file in the bundle was plain text\.$' "$B/redaction.txt")" 1

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
