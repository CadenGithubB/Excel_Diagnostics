#!/bin/bash
# excel_diagnostics.sh - collect evidence for Microsoft Excel slowdowns, hangs and crashes on macOS.
#
# Modes
#   collect  (default) Excel logs, crash/hang/spin/jetsam reports, unified logs, sleep/wake history,
#            memory state, Excel memory footprint, AutoRecover inventory (with dates), add-ins, prefs,
#            plus a sweep for every other Microsoft log file on the Mac (office/discovered_sources.tsv).
#            source_catalog.tsv says where each source came from and how its lines are laid out.
#   hang     Run WHILE Excel is frozen, before force-quitting it. Spindumps Excel, snapshots its memory,
#            open files and network connections, and copies its logs before they rotate. Under a minute.
#   repro    Start a live, unfiltered macOS log stream and Excel memory timeline. Have the user reproduce
#            the issue, then press Ctrl-C here; it then gathers everything collect does (except past days'
#            unified logs, which the live stream replaces) before zipping. One run is all a crash needs.
#   watch    Records Excel's memory/CPU and system memory pressure to a CSV every N seconds until
#            stopped with Ctrl-C (or --hours elapses). Logs when Excel's PID changes (quit/crash/restart).
#
# Usage
#   sudo ./excel_diagnostics.sh [collect] [--days N] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--case pivot-filter] [--workbook PATH] [--archive] [--redact]
#   sudo ./excel_diagnostics.sh hang
#   sudo ./excel_diagnostics.sh repro [--case pivot-filter] [--workbook PATH] [--interval SECONDS] [--hours H]
#   ./excel_diagnostics.sh watch [--interval SECONDS] [--hours H]
#
#   Easiest: run  sudo bash excel_diagnostics.sh  in Terminal with no options. It asks what to do, how
#   many days back to search, how long to wait, and so on. Options given on the command line are not
#   asked again; --no-prompt asks nothing (Jamf never asks).
#
#   --no-prompt    Don't ask questions; use the options given and the defaults.
#   --days N       Days of unified logs to include (collect; default 3, roughly 2-8 minutes per day).
#   --max-wait M   Most minutes to spend on each day's log search (collect) or hang's 30-minute search
#                  (default 3; 0 = no limit). A search that hits the limit keeps what it found so far.
#   --since DATE   First incident date to include (YYYY-MM-DD; default is derived from --days).
#   --until DATE   Last incident date to include (YYYY-MM-DD; default is today).
#                  Crash/hang/jetsam reports and sleep/wake history always cover at least 30 days.
#   --case NAME    Incident type. Use pivot-filter for a crash while filtering a PivotTable.
#   --workbook P   Workbook involved in the incident; records metadata only, never copies the workbook.
#   --archive      Also save an unfiltered .logarchive from the incident start through collection (can be very large)
#   --redact       Replace local user paths and email addresses in text reports before packaging.
#   --interval S   Seconds between samples (watch and repro; default 30)
#   --hours H      Stop watching or repro capture after H hours (default: run until Ctrl-C)
#   --no-sudo      Don't re-run with sudo; collect what an unprivileged user can read
#
# Jamf Pro: run as a policy script. Parameter 4 = mode, parameter 5 = days (collect) or hours (watch),
# parameter 6 = max wait in minutes.
# Set EXCEL_DIAG_OUTDIR to write somewhere other than the console user's Desktop.
#
# collect and hang need root for unified logs, /Library/Logs/DiagnosticReports and spindump; the
# previous collection failed on all of these. Output goes to the console user's Desktop as a .zip.
# Excel's own logs are timestamped in UTC; unified-log .tsv files carry a utc_time column to match.
# Unified-log .tsv files have one entry per row, with level and tags (why it was included) columns.

MODE=collect
DAYS=3
ARCHIVE=0
INTERVAL=30
HOURS=0
NO_SUDO=0
SINCE=""
UNTIL=""
REDACT=0
CASE_NAME=""
WORKBOOK=""
MAX_WAIT=3                                 # minutes per unified-log search; 0 = no limit
DAYS_SET=0
WAIT_SET=0
MODE_SET=0
PROMPT=1
JAMF=0
MAX_DISCOVERED_MB=250                     # larger discovered log files are listed but not copied
EXCEL_PROC=${EXCEL_PROCESS_NAME:-"Microsoft Excel"}   # override only for testing
EXCEL_NAME=${EXCEL_PROC#Microsoft }        # "Excel": also matches "Microsoft Excel" and com.microsoft.Excel

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

ORIG_ARGS=("$@")
if [ "$1" = "/" ] && [ $# -ge 3 ]; then    # Jamf passes mount point, computer name, username first
    JAMF=1
    MODE=${4:-collect}
    case "$MODE" in
        collect) DAYS=${5:-$DAYS} ;;
        watch)   HOURS=${5:-$HOURS} ;;
    esac
    MAX_WAIT=${6:-$MAX_WAIT}
    set --
fi
while [ $# -gt 0 ]; do
    case "$1" in
        collect|hang|repro|watch) MODE=$1; MODE_SET=1 ;;
        --no-prompt) PROMPT=0 ;;
        --days)     DAYS=$2; DAYS_SET=1; shift ;;
        --since)    SINCE=$2; DAYS_SET=1; shift ;;
        --max-wait) MAX_WAIT=$2; WAIT_SET=1; shift ;;
        --until)    UNTIL=$2; shift ;;
        --archive)  ARCHIVE=1 ;;
        --redact)   REDACT=1 ;;
        --case)     CASE_NAME=$2; shift ;;
        --workbook) WORKBOOK=$2; shift ;;
        --interval) INTERVAL=$2; shift ;;
        --hours)    HOURS=$2; shift ;;
        --no-sudo)  NO_SUDO=1 ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done
case "$MODE" in collect|hang|repro|watch) ;; *) echo "Unknown mode: $MODE" >&2; exit 2 ;; esac

ask_number() {      # ask_number QUESTION DEFAULT [MIN MAX] - read a whole number from the terminal
    local answer
    while :; do
        read -r -p "$1 [$2]: " answer < /dev/tty || answer=""
        answer=${answer:-$2}
        case "$answer" in
            ''|*[!0-9]*) echo "  Please enter a whole number." >&2 ;;
            *) if [ -n "$3" ] && { [ "$answer" -lt "$3" ] || [ "$answer" -gt "$4" ]; }; then
                   echo "  Please enter a number from $3 to $4." >&2
               else
                   echo "$answer"; return
               fi ;;
        esac
    done
}
ask_yes() {         # ask_yes QUESTION DEFAULT(y|n) - succeed on yes
    local answer
    while :; do
        read -r -p "$1 [$([ "$2" = y ] && echo Y/n || echo y/N)]: " answer < /dev/tty || answer=""
        case "${answer:-$2}" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) echo "  Please answer y or n." >&2 ;; esac
    done
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
        echo "  3) Excel is frozen right now (quick capture, under a minute; do this before force-quitting)"
        echo "  4) Monitor Excel's memory over time"
        case $(ask_number "Choose 1-4" 1 1 4) in 1) MODE=collect ;; 2) MODE=repro ;; 3) MODE=hang ;; 4) MODE=watch ;; esac
        ORIG_ARGS+=("$MODE")
    fi
    if [ "$MODE" = collect ] && [ "$DAYS_SET" -eq 0 ]; then
        DAYS=$(ask_number "How many days back should the log search go (today counts as 1)?" "$DAYS" 1 60)
        ORIG_ARGS+=(--days "$DAYS")
    fi
    if [ "$MODE" = collect ] && [ "$WAIT_SET" -eq 0 ]; then
        MAX_WAIT=$(ask_number "Most minutes to spend searching each day's logs (0 = no limit)?" "$MAX_WAIT")
        ORIG_ARGS+=(--max-wait "$MAX_WAIT")
    fi
    if [ "$MODE" = collect ] || [ "$MODE" = repro ]; then
        if [ -z "$CASE_NAME" ] && ask_yes "Is this the crash when filtering a PivotTable?" y; then
            CASE_NAME=pivot-filter; ORIG_ARGS+=(--case "$CASE_NAME")
        fi
        if [ -z "$WORKBOOK" ]; then
            # Plain read so a file dragged into Terminal (spaces escaped with \) becomes a usable path
            read -p "Workbook involved (drag it into this window, or press Return to skip; it is not copied): " WORKBOOK < /dev/tty
            WORKBOOK=$(printf '%s' "$WORKBOOK" | sed "s/^[[:space:]'\"]*//; s/[[:space:]'\"]*$//")
            [ -n "$WORKBOOK" ] && ORIG_ARGS+=(--workbook "$WORKBOOK")
        fi
    fi
    if [ "$MODE" != watch ] && [ "$REDACT" -eq 0 ] && ask_yes "Hide user names, file paths and email addresses in the results?" n; then
        REDACT=1; ORIG_ARGS+=(--redact)
    fi
    echo
    case "$MODE" in
        collect) echo "Collecting $DAYS day(s) of logs, $([ "$MAX_WAIT" -eq 0 ] && echo "no time limit" || echo "at most $MAX_WAIT minute(s) per day (up to $((DAYS * MAX_WAIT)) minutes)")." ;;
        repro)   echo "Starting capture. Reproduce the problem, wait 30 seconds after it happens, then press Ctrl-C here." ;;
    esac
    ORIG_ARGS+=(--no-prompt)
fi

for n in "$DAYS" "$INTERVAL" "$HOURS" "$MAX_WAIT"; do
    case "$n" in ''|*[!0-9]*) echo "Expected a whole number, got '$n'" >&2; exit 2 ;; esac
done
[ "$DAYS" -ge 1 ] || DAYS=1
[ "$INTERVAL" -ge 5 ] || INTERVAL=5
QUERY_TIMEOUT=$((MAX_WAIT * 60))           # seconds per unified-log search; 0 = no limit
valid_date() { date -j -f '%Y-%m-%d' "$1" '+%Y-%m-%d' >/dev/null 2>&1; }
if [ -n "$SINCE" ] && ! valid_date "$SINCE"; then echo "Invalid --since date: $SINCE (use YYYY-MM-DD)" >&2; exit 2; fi
if [ -n "$UNTIL" ] && ! valid_date "$UNTIL"; then echo "Invalid --until date: $UNTIL (use YYYY-MM-DD)" >&2; exit 2; fi
[ -n "$UNTIL" ] || UNTIL=$(date '+%Y-%m-%d')
if [ -z "$SINCE" ]; then
    SINCE=$(date -v-"$((DAYS - 1))"d '+%Y-%m-%d')
fi
SINCE_EPOCH=$(date -j -f '%Y-%m-%d' "$SINCE" '+%s')
UNTIL_EPOCH=$(date -j -f '%Y-%m-%d' "$UNTIL" '+%s')
if [ "$SINCE_EPOCH" -gt "$UNTIL_EPOCH" ]; then echo "--since must be on or before --until" >&2; exit 2; fi
DAYS=$(( (UNTIL_EPOCH - SINCE_EPOCH) / 86400 + 1 ))
if [ -n "$CASE_NAME" ] && [ "$CASE_NAME" != "pivot-filter" ]; then
    echo "Unsupported --case '$CASE_NAME'. Supported case: pivot-filter" >&2
    exit 2
fi
REPORT_DAYS=30                             # report files and sleep/wake history are cheap; keep a month
[ "$DAYS" -gt "$REPORT_DAYS" ] && REPORT_DAYS=$DAYS

if [ "$MODE" != watch ] && [ "$(id -u)" -ne 0 ] && [ "$NO_SUDO" -eq 0 ]; then
    echo "This mode needs admin rights for system logs, hang reports and spindump. Re-running with sudo..."
    echo "(Ctrl-C to cancel, or add --no-sudo to collect only what this account can read.)"
    exec sudo /bin/bash "$0" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

# Work on behalf of whoever is logged in at the console, even when run via sudo or Jamf.
CONSOLE_USER=$(stat -f%Su /dev/console 2>/dev/null)
case "$CONSOLE_USER" in ""|root|loginwindow|_mbsetupuser) CONSOLE_USER=${SUDO_USER:-$(id -un)} ;; esac
USER_HOME=$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -d "$USER_HOME" ] || USER_HOME="/Users/$CONSOLE_USER"

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
    "/Library/Logs/Microsoft/autoupdate.log|office/autoupdate.log"
)

STAMP=$(date '+%Y%m%d_%H%M%S')
OUT="${EXCEL_DIAG_OUTDIR:-$USER_HOME/Desktop}/Excel_Diagnostics_${MODE}_$STAMP"
mkdir -p "$OUT" 2>/dev/null || { OUT="/tmp/Excel_Diagnostics_${MODE}_$STAMP"; mkdir -p "$OUT"; }
LOG="$OUT/collection.log"
MANIFEST="$OUT/manifest.tsv"
printf 'component\tstatus\tdetails\n' > "$MANIFEST"

# Everything Excel and its bundled helpers log; any process's message that names Excel (launchd exit
# reasons, sandbox and privacy denials, RunningBoard, WindowServer, file providers); Microsoft crash
# reporting and updates; why the Mac last shut down, logged at each startup; and system memory pressure. RunningBoard's whole-system state dumps are left
# out: they name every running app and were a third of a day's output.
PRED_ALL='process == "'"$EXCEL_PROC"'"
 OR processImagePath CONTAINS "/'"$EXCEL_PROC"'.app/"
 OR (eventMessage CONTAINS[c] "'"$EXCEL_NAME"'" AND NOT (process == "runningboardd" AND eventType == stateEvent))
 OR process IN {"spindump", "Microsoft Error Reporting", "Microsoft AutoUpdate", "Microsoft Update Assistant"}
 OR eventMessage CONTAINS[c] "previous shutdown cause"
 OR ((process == "ReportCrash" OR process == "osanalyticshelper") AND eventMessage CONTAINS[c] "jetsam")
 OR (process == "kernel" AND (eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "jetsam" OR eventMessage CONTAINS[c] "compressor" OR eventMessage CONTAINS[c] "swap"))'

# Unified-log entries are written one per row, tab-separated, with these columns. tags says why an
# entry is relevant, mirroring PRED_ALL; line breaks and tabs inside a message appear as \n and \t.
LABEL_HEADER=$'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage'
LABEL_JQ='def basename: split("/") | last;
def utc: (capture("^(?<t>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})(?<f>[.][0-9]+)?(?<s>[+-])(?<h>[0-9]{2})(?<m>[0-9]{2})$")
    | ((.t | strptime("%Y-%m-%d %H:%M:%S") | mktime) - (if .s == "-" then -1 else 1 end) * ((.h | tonumber) * 3600 + (.m | tonumber) * 60))
        as $e | ($e | strftime("%Y-%m-%d %H:%M:%S")) + (.f // "")) // "";
fromjson? | select(type == "object" and has("timestamp"))    # log show ends with a {"count":...} summary
| (.processImagePath // "" | basename) as $p
| (.eventMessage // "") as $m
| [ if $p == $proc then "excel" else empty end,
    if $p != $proc and (.processImagePath // "" | contains("/" + $proc + ".app/")) then "excel-helper" else empty end,
    if $p == "Microsoft Error Reporting" or $p == "Microsoft AutoUpdate" or $p == "Microsoft Update Assistant" then "microsoft" else empty end,
    if $p == "spindump" then "hang-report" else empty end,
    if $p != $proc and ($m | ascii_downcase | contains($name | ascii_downcase)) then "mentions-excel" else empty end,
    if ($p == "kernel" and ($m | test("memorystatus|jetsam|compressor|swap"; "i")))
       or (($p == "ReportCrash" or $p == "osanalyticshelper") and ($m | test("jetsam"; "i"))) then "memory" else empty end,
    if ($m | ascii_downcase | contains("previous shutdown cause")) then "restart" else empty end,
    if .eventType == "lossEvent" then "logs-dropped" else empty end
  ] as $tags
| [ .timestamp // "", (.timestamp // "" | utc), .messageType // .eventType // "", $p, (.processID // "" | tostring),
    (.senderImagePath // "" | basename), .subsystem // "", .category // "", ($tags | join(",")), $m ]
| @tsv'
JQ=$(command -v jq)                        # built into macOS 15 and later
LOG_EXT=tsv
[ -n "$JQ" ] || LOG_EXT=ndjson             # without jq, keep log's own JSON lines (same fields, unlabeled)

note() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
record_status() { printf '%s\t%s\t%s\n' "$1" "$2" "${3//$'\t'/ }" >> "$MANIFEST"; }

# run_limited SECONDS CMD... - run CMD, stop it after SECONDS. Returns CMD's status, or 124 on timeout.
run_limited() {
    local secs=$1 start=$SECONDS; shift
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

label_entries() {   # log --style ndjson on stdin -> labeled .tsv rows (or the JSON lines unchanged without jq)
    if [ -n "$JQ" ]; then
        printf '%s\n' "$LABEL_HEADER"
        "$JQ" --unbuffered -R -r --arg proc "$EXCEL_PROC" --arg name "$EXCEL_NAME" "$LABEL_JQ"
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

copy_dir() {    # copy_dir SRC DEST
    if [ ! -d "$1" ]; then note "  not found: $1"; return 1; fi
    mkdir -p "$2"
    ditto "$1" "$2" 2>>"$LOG" || note "  copy incomplete (permissions?): $1"
}

excel_pid() { pgrep -x "$EXCEL_PROC" | head -1; }

to_mb() {       # top-style size (512K, 2464M, 1.2G, 0B, with optional +/-) -> whole MB
    echo "$1" | awk '{ v = $1; sub(/[+-]$/, "", v); u = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
        if (u == "G") n *= 1024; else if (u == "T") n *= 1048576; else if (u == "K") n /= 1024
        else if (u == "B") n /= 1048576; else if (u != "M") n = v + 0
        printf "%.0f", n }'
}

snapshot_memory() {     # snapshot_memory FILE - append system-wide memory state
    {
        echo "=== $(date) / $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
        echo "Memory pressure level (1=normal 2=warning 4=critical): $(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
        echo "Swap: $(sysctl -n vm.swapusage 2>/dev/null)"
        echo "--- top processes by memory (MEM = physical footprint, CMPRS = compressed)"
        top -l 1 -o mem -n 25 -stats pid,command,mem,cmprs,cpu,threads 2>/dev/null
        echo "--- vm_stat"; vm_stat
        echo "--- memory_pressure"; memory_pressure 2>/dev/null
        echo
    } >> "$1" 2>&1
}

snapshot_excel_memory() {   # snapshot_excel_memory DIR - Excel's footprint right now
    local pid
    pid=$(excel_pid)
    if [ -z "$pid" ]; then
        echo "$EXCEL_PROC not running at $(date)" > "$1/excel_memory.txt"
        return
    fi
    {
        echo "PID $pid, started $(ps -o lstart= -p "$pid")"
        ps -o pid,etime,%cpu,rss,vsz,stat,command -p "$pid"
        echo "--- top (MEM = physical footprint)"
        top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,purg,threads,state 2>/dev/null | tail -2
    } > "$1/excel_memory.txt" 2>&1
    run_limited 120 footprint -p "$pid" > "$1/excel_footprint.txt" 2>&1 \
        || note "  footprint failed or timed out (see excel_footprint.txt)"
}

collect_system() {
    local S="$OUT/system"
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
    } > "$S/system_info.txt" 2>&1
    snapshot_memory "$S/memory.txt"

    note "Sleep/wake history"
    local since
    since=$(date -v-"$REPORT_DAYS"d '+%Y-%m-%d')
    pmset -g log 2>/dev/null \
        | awk -v s="$since" '$1 >= s && ($4 == "Sleep" || $4 == "Wake" || $4 == "DarkWake" || $4 == "Start" || $4 == "Shutdown" || $4 == "Restart")' \
        > "$S/sleep_wake.txt"
    pmset -g assertions > "$S/power_assertions.txt" 2>&1

    note "Microsoft install history"
    { cat /var/log/install.log; gzcat /var/log/install.log.*.gz; } 2>/dev/null \
        | awk -v s="$since" '$1 ~ /^20[0-9][0-9]-/ && $1 >= s' | grep -i -E 'microsoft|excel|office' | sort \
        > "$S/install_history_microsoft.txt"

    note "Network and security agents"
    {
        echo "=== System extensions (VPN, security, content filters) ==="; systemextensionsctl list
        echo; echo "=== Proxy configuration ==="; scutil --proxy
        echo; echo "=== Network state ==="; scutil --nwi
    } > "$S/network_security.txt" 2>&1
}

excel_verbose_logging() {    # true when Excel's CustomerLoggingEnabled support logging is on (managed or user)
    local f v
    for f in "/Library/Managed Preferences/com.microsoft.Excel.plist" \
             "/Library/Managed Preferences/$CONSOLE_USER/com.microsoft.Excel.plist" \
             "$XL/Library/Preferences/com.microsoft.Excel.plist"; do
        v=$(plutil -extract CustomerLoggingEnabled raw -o - "$f" 2>/dev/null)
        [ "$v" = true ] || [ "$v" = 1 ] && return 0
    done
    return 1
}

collect_office() {
    local D="$OUT/office" app p f d entry
    mkdir -p "$D"
    note "Office versions, Excel memory, Excel logs"
    {
        for app in "Microsoft Excel" "Microsoft Word" "Microsoft PowerPoint" "Microsoft Outlook" "Microsoft Teams" "OneDrive"; do
            p="/Applications/$app.app/Contents/Info.plist"
            [ -f "$p" ] && echo "$app: $(defaults read "$p" CFBundleShortVersionString 2>/dev/null) ($(defaults read "$p" CFBundleVersion 2>/dev/null))"
        done
        echo; echo "=== Excel processes ==="; pgrep -lf "$EXCEL_PROC"
    } > "$D/versions.txt" 2>&1
    snapshot_excel_memory "$D"

    for entry in "${FIXED_SOURCES[@]}"; do
        [ -e "$OUT/${entry#*|}" ] && continue       # already copied (repro's final snapshot)
        if [ -f "${entry%%|*}" ]; then
            cp -p "${entry%%|*}" "$OUT/${entry#*|}" 2>>"$LOG"
        else
            copy_dir "${entry%%|*}" "$OUT/${entry#*|}"
        fi
    done

    note "AutoRecover inventory"
    {
        for d in "$XL/Library/Application Support/Microsoft" "$XL/Library/Preferences/AutoRecovery"; do
            [ -d "$d" ] || continue
            echo "=== $d  (total $(du -sh "$d" 2>/dev/null | cut -f1))"
            echo "Leftover recovery files usually mean Excel did not close cleanly. Modified | bytes | path"
            find "$d" -type f \( -iname '*autorecover*' -o -name '~ar*' -o -iname '*.xar' \) \
                -exec stat -f '%Sm | %z | %N' -t '%Y-%m-%d %H:%M' {} + 2>/dev/null | sort
            echo; echo "Largest files:"
            find "$d" -type f -size +10M -exec stat -f '%z | %N' {} + 2>/dev/null | sort -rn | head -20
            echo
        done
    } > "$D/autorecover_inventory.txt"

    note "Add-ins and preferences"
    {
        for d in "$OFFICE_GC/User Content.localized/Startup.localized/Excel" \
                 "$OFFICE_GC/User Content.localized/Add-Ins.localized" \
                 "$OFFICE_GC/User Content/Startup/Excel" "$OFFICE_GC/User Content/Add-Ins" \
                 "$XL/Documents/wef"; do
            [ -d "$d" ] && { echo "=== $d"; find "$d" -maxdepth 3 -exec stat -f '%Sm | %z | %N' -t '%Y-%m-%d' {} + 2>/dev/null | head -200; echo; }
        done
    } > "$D/addins.txt"
    {
        for f in "/Library/Managed Preferences"/com.microsoft.*.plist "/Library/Managed Preferences/$CONSOLE_USER"/com.microsoft.*.plist; do
            [ -f "$f" ] && { echo "=== $f"; plutil -p "$f"; echo; }
        done
        echo "=== Excel verbose support logging (CustomerLoggingEnabled): $(excel_verbose_logging && echo on || echo off)"
        echo
        echo "=== Excel user prefs (AutoSave / AutoRecover / calculation / logging related keys only)"
        plutil -p "$XL/Library/Preferences/com.microsoft.Excel.plist" 2>/dev/null | grep -iE 'autosave|autorecover|recover|calc|graphic|addin|logging'
    } > "$D/office_prefs.txt" 2>&1
}

# Inventory every log-like Microsoft file on the Mac, not just the fixed locations, so an unexpected
# source still shows up. Files changed since $SINCE are copied to office/discovered/ under their
# original path ("home" is the user's home folder). Files under FIXED_SOURCES are already copied.
discover_sources() {
    local T="$OUT/office/discovered_sources.tsv" ref="$OUT/.since_ref" roots=() f entry status dest bytes copied=0 listed=0
    mkdir -p "$OUT/office"
    note "Searching for other Microsoft log files"
    for f in "$USER_HOME/Library/Containers"/com.microsoft.* "$USER_HOME/Library/Containers"/UBF8T346G9.* \
             "$USER_HOME/Library/Group Containers"/UBF8T346G9.* \
             "$USER_HOME/Library/Logs"/Microsoft* "$USER_HOME/Library/Logs"/OneDrive* "$USER_HOME/Library/Logs/Company Portal" \
             "$USER_HOME/Library/Application Support"/Microsoft* "$USER_HOME/Library/Application Support/OneDrive" \
             /Library/Logs/Microsoft "/Library/Application Support/Microsoft"; do
        [ -d "$f" ] && roots+=("$f")
    done
    touch -t "$(date -j -f '%Y-%m-%d' "$SINCE" '+%Y%m%d0000')" "$ref"
    printf 'status\tmodified\tbytes\toriginal_location\tcaptured_as\n' > "$T"
    shopt -s nocasematch
    while IFS= read -r -d '' f; do
        status=""; dest=""
        for entry in "${FIXED_SOURCES[@]}"; do
            case "$f" in "${entry%%|*}"|"${entry%%|*}"/*)
                status="copied (fixed source)"; dest="${entry#*|}${f#"${entry%%|*}"}"; break ;;
            esac
        done
        bytes=$(stat -f %z "$f" 2>/dev/null)
        if [ -z "$status" ]; then
            case "$f" in
                */com.microsoft.Word/*|*/com.microsoft.Powerpoint/*|*/com.microsoft.Outlook/*|*/com.microsoft.onenote.mac/*|\
                */com.microsoft.teams*|*/Microsoft/Teams/*|*/com.microsoft.edgemac*|*/Microsoft?Edge*|*/com.microsoft.rdc*)
                    status="listed only: another app's log" ;;
            esac
        fi
        if [ -z "$status" ] && [ ! "$f" -nt "$ref" ]; then status="listed only: last changed before $SINCE"; fi
        if [ -z "$status" ] && [ "${bytes:-0}" -gt $((MAX_DISCOVERED_MB * 1048576)) ]; then status="listed only: over $MAX_DISCOVERED_MB MB"; fi
        if [ -z "$status" ]; then
            case "$f" in "$USER_HOME"/*) dest="office/discovered/home${f#"$USER_HOME"}" ;; *) dest="office/discovered$f" ;; esac
            if mkdir -p "$OUT/$(dirname "$dest")" && cp -p "$f" "$OUT/$dest" 2>>"$LOG"; then
                status=copied; copied=$((copied + 1))
            else
                status="copy failed"; dest=""
            fi
        fi
        listed=$((listed + 1))
        printf '%s\t%s\t%s\t%s\t%s\n' "$status" "$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f" 2>/dev/null)" "$bytes" "$f" "$dest" >> "$T"
    done < <(
        [ ${#roots[@]} -gt 0 ] && find "${roots[@]}" \( -name '*.app' -o -name '*.framework' \) -prune -o -type f \
            \( -iname '*.log' -o -iname '*.log.*' -o -iname '*.ips' -o -iname '*.crash' -o -iname '*.diag' \
               -o -iname '*.dmp' -o -iname '*.mdmp' -o -iname '*.etl' -o -iname '*.odl*' -o -iname '*.aodl' \
               -o -ipath '*/logs/*' -o -ipath '*/diagnostics/*' -o -ipath '*merp*' \) -print0 2>/dev/null
        # CustomerLoggingEnabled writes verbose logs to the Documents folder; only look there when it is on
        excel_verbose_logging && find "$USER_HOME/Documents" -maxdepth 3 -type f \( -iname '*.log' -o -iname '*.log.*' \) \
            \( -ipath '*diagnostic*' -o -ipath '*microsoft*' -o -ipath '*excel*' \) -print0 2>/dev/null
    )
    shopt -u nocasematch
    rm -f "$ref"
    note "  $listed Microsoft log file(s) found, $copied copied to office/discovered (see office/discovered_sources.tsv)"
    record_status "discovered_sources" "complete" "$listed found, $copied copied; office/discovered_sources.tsv"
}

write_source_catalog() {
    local C="$OUT/source_catalog.tsv"
    catalog_line() {
        local label=$1 path=$2 destination=$3 details=$4 state=missing
        [ -e "$path" ] && state=found
        printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$state" "$destination" "$path" "$details" >> "$C"
    }
    printf 'source\tavailability\tcaptured_as\toriginal_location\tline_format_or_purpose\n' > "$C"
    catalog_line "Excel internal diagnostics" "$XL/Library/Logs" "$EXCEL_LOGS_DEST" "Tabular lines: Timestamp, Process, TID, Area, Category, EventID, Level, Message, Correlation. Files roll over at 20 MB; on the affected Mac they held about one day"
    printf '%s\t%s\t%s\t%s\t%s\n' "Excel verbose support logging" "$(excel_verbose_logging && echo on || echo off)" "office/discovered/home/Documents (when on)" "CustomerLoggingEnabled in com.microsoft.Excel" "Microsoft's verbose logging switch for support cases; writes extra diagnostic logs to the Documents folder" >> "$C"
    catalog_line "Shared Office logs" "$OFFICE_GC/Logs" "$OFFICE_LOGS_DEST" "Shared Office component diagnostics"
    catalog_line "User Microsoft logs" "$USER_HOME/Library/Logs/Microsoft" "office/user_microsoft_logs" "Per-user Microsoft application and support logs"
    catalog_line "OneDrive logs (App Store)" "$USER_HOME/Library/Containers/com.microsoft.OneDrive-mac/Data/Library/Logs" "office/onedrive_container_logs" "File-open, save, and sync context when workbooks are cloud-backed"
    catalog_line "OneDrive logs (standalone)" "$USER_HOME/Library/Logs/OneDrive" "office/discovered/home/Library/Logs/OneDrive" "Same, for the standalone OneDrive installer usually deployed by IT"
    catalog_line "Microsoft error reporting" "$USER_HOME/Library/Containers/com.microsoft.errorreporting/Data/Library/Logs" "office/error_reporting_logs" "Office error-reporting diagnostics"
    catalog_line "Microsoft crash archive" "$USER_HOME/Library/Group Containers/UBF8T346G9.ms" "office/discovered/home/Library/Group Containers/UBF8T346G9.ms" "Where Microsoft Error Reporting is reported to keep Office crash reports (MerpArchive, MerpTempItems), separate from macOS crash reports"
    catalog_line "Microsoft system logs" "/Library/Logs/Microsoft" "office/autoupdate.log, office/discovered/Library/Logs/Microsoft" "Microsoft AutoUpdate, and Defender and Intune when installed"
    catalog_line "Install history" "/var/log/install.log" "system/install_history_microsoft.txt" "Microsoft package installs, including updates pushed by Jamf or Intune"
    printf '%s\t%s\t%s\t%s\t%s\n' "Other Microsoft log files" "see office/discovered_sources.tsv" "office/discovered/" "Microsoft containers, group containers, Logs and Application Support folders" "Every log-like file found, with where it was copied or why not" >> "$C"
    catalog_line "User diagnostic reports" "$USER_HOME/Library/Logs/DiagnosticReports" "reports/user_Library_Logs_DiagnosticReports" "Every macOS diagnostic report since the incident start (crashes, hangs, shutdown stalls, resets, resource limits), plus Excel-related ones from the last 30 days"
    catalog_line "System diagnostic reports" "/Library/Logs/DiagnosticReports" "reports/Library_Logs_DiagnosticReports" "Every macOS diagnostic report since the incident start (crashes, hangs, jetsam, shutdown stalls, resets, panics, resource limits), plus Excel-related ones from the last 30 days"
    catalog_line "Force-quit and usage records" "$USER_HOME/Library/Application Support/CrashReporter" "reports/CrashReporter" "Per-app crash and force-quit timestamps"
    local ulabel="Filtered unified logs" ustate="see unified_logs/collection_status.txt" udest="unified_logs/YYYY-MM-DD.$LOG_EXT"
    local uformat="One entry per row, tab-separated with a header: local_time, utc_time (lines up with Excel's own logs), level (Default/Info/Debug/Error/Fault or event type), process, pid, sender (library that logged it), subsystem, category, tags (excel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, logs-dropped; empty when none apply), message (line breaks as \\n)"
    if [ "$MODE" = repro ]; then
        ulabel="Live unified-log stream, all processes"; ustate="captured during the reproduction"; udest="repro/unified_live_unfiltered.$LOG_EXT"
    fi
    [ "$LOG_EXT" = tsv ] || uformat="One JSON object per line from log --style ndjson (jq was not available to label them)"
    printf '%s\t%s\t%s\t%s\t%s\n' "$ulabel" "$ustate" "$udest" "macOS unified log" "$uformat" >> "$C"
    if [ "$ARCHIVE" -eq 1 ]; then
        printf '%s\t%s\t%s\t%s\t%s\n' "Unfiltered unified-log archive" "requested" "unified_logs/system_logs_from_${SINCE}.logarchive" "macOS unified log store" "All-process Apple logarchive; open with Console or log show" >> "$C"
    fi
    record_status "source_catalog" "complete" "source_catalog.tsv"
}

collect_reports() {
    local R="$OUT/reports" ref="$OUT/.reports_since" dir tag f
    mkdir -p "$R"
    touch -t "$(date -j -f '%Y-%m-%d' "$SINCE" '+%Y%m%d0000')" "$ref"
    note "Every macOS diagnostic report since $SINCE, and Excel-related ones from the last $REPORT_DAYS days"
    for dir in /Library/Logs/DiagnosticReports /Library/Logs/DiagnosticReports/Retired \
               "$USER_HOME/Library/Logs/DiagnosticReports" "$USER_HOME/Library/Logs/DiagnosticReports/Retired"; do
        [ -d "$dir" ] || continue
        tag=$(echo "$dir" | sed "s#^$USER_HOME#user#; s#^/##; s#/#_#g")
        { echo "=== $dir (newest first)"; ls -lt "$dir" 2>&1 | head -500; echo; } >> "$R/report_listing.txt"
        mkdir -p "$R/$tag"
        # Everything since the incident start (shutdown stalls, resets, panics, security-agent resource
        # reports...). Before that, by name, plus any other report that names Excel (e.g. a WebKit add-in
        # host or file provider it was using)
        find "$dir" -maxdepth 1 -type f ! -name '.*' \( -newer "$ref" -o \( -mtime -"$REPORT_DAYS" \
            \( -iname '*excel*' -o -iname '*office*' -o -iname '*microsoft*' -o -iname 'jetsam*' -o -iname '*.hang' \
               -o -iname '*.spin' -o -iname '*.panic' -o -iname 'WindowServer*' -o -exec grep -q -a -F "$EXCEL_PROC" {} \; \) \) \) \
            -exec cp -p {} "$R/$tag/" \; 2>>"$LOG"
    done
    rm -f "$ref"
    note "  copied $(find "$R" -type f ! -name report_listing.txt | wc -l | tr -d ' ') report(s)"

    # Force-quit timestamps and per-app usage records
    mkdir -p "$R/CrashReporter"
    find "$USER_HOME/Library/Application Support/CrashReporter" -maxdepth 1 -type f \
        \( -iname 'Microsoft*' -o -iname 'Intervals*' \) -exec cp -p {} "$R/CrashReporter/" \; 2>>"$LOG"
    for f in "$R/CrashReporter"/Microsoft*.plist; do
        [ -f "$f" ] && plutil -p "$f" > "${f%.plist}.txt" 2>&1
    done

    note "Crash and hang report summary"
    {
        echo "# Crash and hang report summary"
        echo "Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo
        echo "## Reports copied, by kind (shutdownStall = a shutdown or restart got stuck; ResetCounter = a restart record; .diag = a resource limit was exceeded)"
        find "$R" -type f ! -name report_listing.txt ! -name crash_summary.txt ! -path '*/CrashReporter/*' -print | sed -E 's#.*/##; s/[-_]20[0-9][0-9]-[0-9][0-9]-[0-9][0-9].*\././; s/[-_]20[0-9][0-9]-.*//' \
            | sort | uniq -c | sort -rn
        echo
        find "$R" -type f \( -iname '*.ips' -o -iname '*.crash' -o -iname '*.hang' -o -iname '*.spin' \) -print \
            | sort | while IFS= read -r f; do
                echo "## $f"
                grep -a -i -m 1 -E '^(Process|Path|Identifier|Version|Exception Type|Termination Reason|Crashed Thread|Date/Time|OS Version|Model Identifier):' "$f"
                grep -a -o -E '"(procName|bundleID|exception|termination|timestamp)"[[:space:]]*:[[:space:]]*("[^"]*"|[0-9]+)' "$f" | head -10
                echo
            done
    } > "$R/crash_summary.txt" 2>&1
}

collect_case_context() {
    local C="$OUT/case"
    [ -n "$CASE_NAME" ] || [ -n "$WORKBOOK" ] || return
    mkdir -p "$C"
    {
        echo "# Incident context"
        echo
        echo "- Collected: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        [ -n "$CASE_NAME" ] && echo "- Case: $CASE_NAME"
        [ -n "$WORKBOOK" ] && echo "- Workbook provided: $WORKBOOK"
        echo
        if [ "$CASE_NAME" = "pivot-filter" ]; then
            echo "## Reported behavior"
            echo
            echo "Excel crashes when a user filters within a PivotTable."
            echo
            echo "## Best next capture"
            echo
            echo 'If Excel freezes before it closes, run: sudo ./excel_diagnostics.sh hang --case pivot-filter'
            echo 'To capture the crash as it happens, run: sudo ./excel_diagnostics.sh repro --case pivot-filter, reproduce it, wait 30 seconds, then press Ctrl-C'
            echo 'After an immediate crash, run: sudo ./excel_diagnostics.sh collect --case pivot-filter --since YYYY-MM-DD --until YYYY-MM-DD'
            echo "The workbook is not copied by this collector."
        fi
    } > "$C/incident_context.md"

    if [ -n "$WORKBOOK" ]; then
        if [ -f "$WORKBOOK" ]; then
            {
                echo "# Workbook metadata (the workbook itself was not copied)"
                echo
                stat -f 'Modified: %Sm%nBytes: %z%nPath: %N' -t '%Y-%m-%d %H:%M:%S %Z' "$WORKBOOK"
                echo
                mdls -name kMDItemContentType -name kMDItemFSName -name kMDItemFSSize -name kMDItemFSCreationDate -name kMDItemFSContentChangeDate "$WORKBOOK" 2>&1
            } > "$C/workbook_metadata.txt"
            record_status "workbook_metadata" "complete" "metadata only; workbook not copied"
        else
            echo "Workbook not found: $WORKBOOK" > "$C/workbook_metadata.txt"
            record_status "workbook_metadata" "skipped" "path not found"
        fi
    fi

    record_status "incident_context" "complete" "${CASE_NAME:-general incident context}"
}

collect_unified() {
    local U="$OUT/unified_logs" i day next rc lines status
    mkdir -p "$U"
    note "Unified logs (Excel, hangs/terminations, memory pressure), $SINCE through $UNTIL"
    if ! /usr/bin/log show --last 1m --predicate 'process == "kernel"' > /dev/null 2> "$U/access_check.txt"; then
        note "  cannot read unified logs: $(head -1 "$U/access_check.txt")"
        note "  run with admin rights (sudo or Jamf) to include them"
        echo "Date | Status" > "$U/collection_status.txt"
        echo "access check | skipped: insufficient access" >> "$U/collection_status.txt"
        record_status "unified_logs" "skipped" "insufficient access; see unified_logs/access_check.txt"
        return
    fi
    rm -f "$U/access_check.txt"
    echo "Date | Status" > "$U/collection_status.txt"
    i=0
    while [ $i -lt "$DAYS" ]; do
        day=$(date -j -v+"$i"d -f '%Y-%m-%d' "$SINCE" '+%Y-%m-%d')
        next=$(date -j -v+1d -f '%Y-%m-%d' "$day" '+%Y-%m-%d')
        note "  $day: collecting ($([ "$MAX_WAIT" -eq 0 ] && echo "no time limit" || echo "up to $MAX_WAIT min"))"
        run_limited "$QUERY_TIMEOUT" /usr/bin/log show --start "$day 00:00:00" --end "$next 00:00:00" \
            --style ndjson --info --debug --predicate "$PRED_ALL" 2> "$U/$day.errors.txt" | label_entries > "$U/$day.$LOG_EXT"
        rc=${PIPESTATUS[0]}
        [ -s "$U/$day.errors.txt" ] || rm -f "$U/$day.errors.txt"
        lines=$(count_entries "$U/$day.$LOG_EXT")
        case $rc in
            0)   if [ "$lines" -eq 0 ]; then
                     status="ok, nothing found (no matching entries, or macOS no longer has logs for this day)"
                 else
                     status="ok ($lines entries)"
                 fi ;;
            124) status="hit the $MAX_WAIT-minute limit, partial ($lines entries; rerun with a larger --max-wait for the rest)" ;;
            *)   status="error $rc ($lines entries; see $day.errors.txt)" ;;
        esac
        echo "$day | $status" >> "$U/collection_status.txt"
        note "  $day: $status"
        i=$((i + 1))
    done
    record_status "unified_logs" "complete" "$DAYS day(s), $SINCE through $UNTIL"
    if [ "$ARCHIVE" -eq 1 ]; then
        note "Unfiltered unified-log archive from $SINCE through now (this can take several minutes and be very large)"
        if /usr/bin/log collect --start "$SINCE 00:00:00" --output "$U/system_logs_from_${SINCE}.logarchive" >> "$LOG" 2>&1; then
            record_status "log_archive" "complete" "unfiltered, from $SINCE through collection"
        else
            note "  log collect failed (see collection.log)"
            record_status "log_archive" "failed" "see collection.log"
        fi
    fi
}

mode_collect() {
    note "Excel diagnostics: collect ($SINCE through $UNTIL) for user $CONSOLE_USER"
    collect_system
    record_status "system" "complete" "system, memory, sleep/wake, network state"
    collect_office
    record_status "office" "complete" "versions, Excel logs, AutoRecover, add-ins, preferences"
    discover_sources
    collect_reports
    record_status "reports" "complete" "crash, hang, spin and jetsam reports"
    collect_case_context
    collect_unified
    write_source_catalog
}

mode_hang() {
    local pid
    pid=$(excel_pid)
    note "Excel diagnostics: hang capture at $(date) / $(date -u '+%H:%M:%S UTC')"
    if [ -z "$pid" ]; then
        note "$EXCEL_PROC is not running - capturing system state only."
    else
        note "Leave Excel frozen until this finishes (under a minute), then force-quit it if needed."
        {
            ps -o pid,etime,%cpu,rss,stat,command -p "$pid"
            echo "--- top (MEM = physical footprint)"
            top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,threads,state 2>/dev/null | tail -2
        } > "$OUT/excel_state.txt" 2>&1
    fi
    snapshot_memory "$OUT/system_memory.txt"

    if [ -n "$pid" ]; then
        if [ "$(id -u)" -eq 0 ]; then
            note "Spindump of Excel (10 seconds)"
            run_limited 120 spindump "$pid" 10 10 -o "$OUT/excel_spindump.txt" -timelimit 100 >> "$LOG" 2>&1 \
                || note "  spindump failed or timed out"
        else
            note "Not running as root; using sample instead of spindump (10 seconds)"
            run_limited 60 sample "$pid" 10 -file "$OUT/excel_sample.txt" >> "$LOG" 2>&1 \
                || note "  sample failed or timed out"
        fi
        note "Excel memory footprint, open files and connections"
        run_limited 60 footprint -p "$pid" > "$OUT/excel_footprint.txt" 2>&1
        run_limited 30 lsof -n -P -p "$pid" > "$OUT/excel_open_files.txt" 2>&1
    fi

    note "Copying Excel logs before they rotate"
    copy_dir "$XL/Library/Logs" "$OUT/excel_container_logs"
    note "Unified log, last 30 minutes"
    if /usr/bin/log show --last 1m --predicate 'process == "kernel"' > /dev/null 2> "$OUT/unified_access_check.txt"; then
        rm -f "$OUT/unified_access_check.txt"
        run_limited "$QUERY_TIMEOUT" /usr/bin/log show --last 30m --style ndjson --info --debug --predicate "$PRED_ALL" \
            2> "$OUT/unified_last30m.errors.txt" | label_entries > "$OUT/unified_last30m.$LOG_EXT"
        if [ "${PIPESTATUS[0]}" -eq 0 ]; then
            rm -f "$OUT/unified_last30m.errors.txt"
            record_status "unified_last30m" "complete" "hang capture, $(count_entries "$OUT/unified_last30m.$LOG_EXT") entries"
        else
            record_status "unified_last30m" "failed" "see unified_last30m.errors.txt"
        fi
    else
        note "  unified log skipped: $(head -1 "$OUT/unified_access_check.txt")"
        record_status "unified_last30m" "skipped" "insufficient access; see unified_access_check.txt"
    fi
    { pmset -g assertions; echo; scutil --nwi; } > "$OUT/power_network.txt" 2>&1
    if [ -n "$pid" ]; then
        note "Hang capture complete. Excel can be force-quit now (Option-Command-Esc)."
    else
        note "Capture complete."
    fi
    record_status "hang_capture" "complete" "Excel PID ${pid:-not-running}"
}

capture_repro_snapshot() {
    local label=$1 D="$OUT/repro/$1" pid
    mkdir -p "$D"
    snapshot_memory "$D/system_memory.txt"
    snapshot_excel_memory "$D"
    copy_dir "$XL/Library/Logs" "$D/excel_container_logs"
    copy_dir "$OFFICE_GC/Logs" "$D/office_group_logs"
    pid=$(excel_pid)
    if [ -n "$pid" ]; then
        run_limited 30 lsof -n -P -p "$pid" > "$D/excel_open_files.txt" 2>&1
    fi
    record_status "repro_$label" "complete" "Excel and system snapshot"
}

repro_finish() {
    [ -n "$REPRO_FINISHED" ] && return
    REPRO_FINISHED=1
    note "Stopping live capture and collecting final evidence"
    # Stop log stream itself; the labeler then finishes the rows it has and exits
    if [ -s "$OUT/repro/.stream_pid" ]; then
        kill "$(cat "$OUT/repro/.stream_pid")" 2>/dev/null
    elif [ -n "$REPRO_LOG_PID" ]; then
        kill "$REPRO_LOG_PID" 2>/dev/null
    fi
    [ -n "$REPRO_WATCH_PID" ] && kill "$REPRO_WATCH_PID" 2>/dev/null
    [ -n "$REPRO_LOG_PID" ] && wait "$REPRO_LOG_PID" 2>/dev/null
    [ -n "$REPRO_WATCH_PID" ] && wait "$REPRO_WATCH_PID" 2>/dev/null
    rm -f "$OUT/repro/.stream_pid"
    [ -s "$OUT/repro/unified_live_errors.txt" ] || rm -f "$OUT/repro/unified_live_errors.txt"
    capture_repro_snapshot final
    # Everything collect gathers except past days' unified logs, which the live stream replaces. This
    # also picks up crash reports and Microsoft error-reporting files the crash just wrote.
    collect_system
    record_status "system" "complete" "system, memory, sleep/wake, network state"
    collect_office
    record_status "office" "complete" "versions, Excel logs, AutoRecover, add-ins, preferences"
    discover_sources
    collect_reports
    record_status "reports" "complete" "crash, hang, spin and jetsam reports"
    collect_case_context
    write_source_catalog
    record_status "repro" "complete" "live stream stopped and final evidence captured"
}

mode_repro() {
    local R="$OUT/repro" end=0
    mkdir -p "$R"
    note "Reproduction capture is starting. Ask the user to reproduce the problem, then press Ctrl-C here."
    capture_repro_snapshot baseline
    note "Starting unfiltered live unified-log stream at debug level"
    /bin/sh -c 'echo $$ > "$1"; exec /usr/bin/log stream --style ndjson --level debug' sh "$R/.stream_pid" \
        2> "$R/unified_live_errors.txt" | label_entries > "$R/unified_live_unfiltered.$LOG_EXT" &
    REPRO_LOG_PID=$!
    ( trap - INT TERM; mode_watch ) &
    REPRO_WATCH_PID=$!
    [ "$HOURS" -gt 0 ] && end=$(( $(date +%s) + HOURS * 3600 ))
    while kill -0 "$REPRO_LOG_PID" 2>/dev/null; do
        [ "$end" -gt 0 ] && [ "$(date +%s)" -ge "$end" ] && break
        sleep 2
    done
    repro_finish
}

mode_watch() {
    local csv="$OUT/excel_memory_timeline.csv" end=0 n=0 last_pid="" last_level="" pid row cpu mem cmp th level free cmpr swap now
    echo "local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb" > "$csv"
    local pagemb
    pagemb=$(vm_stat | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) print $i / 1048576 }')
    [ "$HOURS" -gt 0 ] && end=$(( $(date +%s) + HOURS * 3600 ))
    note "Excel diagnostics: watch every ${INTERVAL}s$([ "$HOURS" -gt 0 ] && echo " for $HOURS hour(s)"). Press Ctrl-C to stop."
    note "Timeline: $csv"
    while :; do
        pid=$(excel_pid)
        cpu=""; mem=""; cmp=""; th=""
        if [ -n "$pid" ]; then
            row=$(top -l 2 -s 1 -pid "$pid" -stats pid,cpu,mem,cmprs,threads 2>/dev/null | tail -1)
            set -- $row
            if [ "$1" = "$pid" ]; then cpu=$2; mem=$(to_mb "$3"); cmp=$(to_mb "$4"); th=${5%%/*}; fi
        fi
        if [ "$pid" != "$last_pid" ] && [ $n -gt 0 ]; then
            if [ -z "$pid" ]; then note "Excel stopped running (PID $last_pid) - quit, crash or force-quit"
            elif [ -z "$last_pid" ]; then note "Excel started (PID $pid)"
            else note "Excel PID changed $last_pid -> $pid (Excel quit/crashed and was relaunched)"; fi
        fi
        level=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
        free=$(vm_stat | awk -v p="$pagemb" '/^Pages free/ { gsub(/\./, "", $3); printf "%.0f", $3 * p }')
        cmpr=$(vm_stat | awk -v p="$pagemb" '/occupied by compressor/ { gsub(/\./, "", $5); printf "%.0f", $5 * p }')
        swap=$(to_mb "$(sysctl -n vm.swapusage 2>/dev/null | awk '{print $6}')")
        now=$(date +%s)
        echo "$(date -r "$now" '+%Y-%m-%d %H:%M:%S'),$(date -u -r "$now" '+%Y-%m-%d %H:%M:%S'),$pid,$cpu,$mem,$cmp,$th,$level,$free,$cmpr,$swap" >> "$csv"
        # Full process snapshot whenever pressure changes, and every ~10 minutes
        if [ "$level" != "$last_level" ] || [ $((n % (600 / INTERVAL + 1))) -eq 0 ]; then
            [ -n "$last_level" ] && [ "$level" != "$last_level" ] && note "Memory pressure level $last_level -> $level"
            snapshot_memory "$OUT/memory_snapshots.txt"
        fi
        last_pid=$pid; last_level=$level; n=$((n + 1))
        [ "$end" -gt 0 ] && [ "$(date +%s)" -ge "$end" ] && break
        sleep "$INTERVAL"
    done
    record_status "watch" "complete" "$n sample(s), interval ${INTERVAL}s"
}

redact_bundle() {
    local f
    note "Redacting local user paths and email addresses in text reports"
    while IFS= read -r -d '' f; do
        if file -b "$f" 2>/dev/null | grep -qi 'text'; then
            /usr/bin/perl -i -pe 's#/Users/[^/\s]+#/Users/<redacted>#g; s/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/<redacted-email>/g' "$f" 2>>"$LOG"
        fi
    done < <(find "$OUT" -type f -not -path '*.logarchive/*' -print0)
    record_status "redaction" "complete" "local user paths and email addresses in text reports; logarchives unchanged"
}

write_summary() {
    local summary="$OUT/summary.md" count size
    count=$(find "$OUT" -type f | wc -l | tr -d ' ')
    size=$(du -sh "$OUT" 2>/dev/null | awk '{print $1}')
    {
        echo "# Excel diagnostics summary"
        echo
        echo "- Collected: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "- Console user: $CONSOLE_USER"
        echo "- Mode: $MODE"
        [ "$MODE" = collect ] && echo "- Incident window: $SINCE through $UNTIL ($DAYS day(s))"
        [ "$MODE" = collect ] || [ "$MODE" = hang ] && echo "- Max wait per log search: $([ "$MAX_WAIT" -eq 0 ] && echo "no limit" || echo "$MAX_WAIT minute(s)")"
        echo "- Files before ZIP packaging: $count ($size)"
        echo "- Redaction: $([ "$REDACT" -eq 1 ] && echo enabled || echo disabled)"
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
        echo '1. `collection.log` for failures, permissions, and timeouts.'
        if [ "$MODE" = repro ]; then
            echo '2. `repro/unified_live_unfiltered.tsv` for the system log during the reproduction, `excel_memory_timeline.csv` for Excel'"'"'s memory, and `repro/baseline` vs `repro/final` for before and after.'
        else
            echo '2. `unified_logs/collection_status.txt` for the log-query result for each date.'
        fi
        echo '3. `reports/`, `office/autorecover_inventory.txt`, and `office/excel_memory.txt` for direct evidence of crashes, recovery, and memory pressure.'
        echo '4. `source_catalog.tsv` for where each source came from, and `office/discovered_sources.tsv` for every other Microsoft log file found.'
        if [ "$MODE" = collect ] && [ "$LOG_EXT" = tsv ]; then
            echo
            echo '## Restarts'
            echo
            echo 'Why the Mac last shut down, as logged at each startup. 5 is commonly reported to mean a normal shutdown or restart; other values (for example 3, power button held, or 0, power lost) mean it was forced. `reports/` also has a `shutdown_stall` report for each shutdown that got stuck.'
            echo
            awk -F'\t' '$9 ~ /restart/ { print "- " $1 ": " $10 }' "$OUT"/unified_logs/*.tsv 2>/dev/null | sort | grep . || echo '- None found in the search window.'
        fi
        if [ "$LOG_EXT" = tsv ]; then
            echo
            echo '## Filtering unified logs'
            echo
            echo 'Unified-log `.tsv` files (`unified_logs/`, `unified_last30m.tsv`, `repro/unified_live_unfiltered.tsv`) have one entry per row and open as columns in Numbers or Excel.'
            echo 'Filter on `level` (Error, Fault) and `tags`: `excel` (Excel itself), `excel-helper`, `microsoft` (error reporting, AutoUpdate), `hang-report`, `mentions-excel` (another process naming Excel), `memory`, `restart` (why the Mac last shut down), `logs-dropped`.'
            echo 'Use `utc_time` to line entries up with Excel'"'"'s own logs, which are in UTC. From Terminal, for example:'
            echo
            echo '    awk -F'"'"'\t'"'"' '"'"'$3 == "Error" || $3 == "Fault" || $9 ~ /excel/'"'"' unified_logs/*.tsv'
        fi
        echo
        echo 'The archive contains diagnostic metadata such as usernames, file paths, and service identifiers. `--redact` removes local user paths and email addresses from text reports, but leaves any Apple .logarchive unchanged so it remains readable.'
    } > "$summary"
    record_status "summary" "complete" "summary.md"
}

finalize() {
    [ -n "$FINALIZED" ] && return
    FINALIZED=1
    [ "$REDACT" -eq 1 ] && redact_bundle
    write_summary
    note "Packaging results"
    if ditto -c -k --sequesterRsrc --keepParent "$OUT" "$OUT.zip" 2>>"$LOG"; then
        shasum -a 256 "$OUT.zip" > "$OUT.zip.sha256"
        record_status "zip" "complete" "$(basename "$OUT.zip")"
    else
        note "  ZIP packaging failed (see collection.log)"
        record_status "zip" "failed" "see collection.log"
    fi
    if [ "$(id -u)" -eq 0 ] && [ "$CONSOLE_USER" != root ]; then
        chown -R "$CONSOLE_USER" "$OUT" "$OUT.zip" "$OUT.zip.sha256" 2>/dev/null
    fi
    note "Done. Send this file to IT: $OUT.zip (SHA-256: $OUT.zip.sha256)"
}

trap 'echo; [ "$MODE" = repro ] && repro_finish; note "Stopped - packaging what was collected so far."; kill $(jobs -p) 2>/dev/null; finalize; exit 130' INT TERM

case "$MODE" in
    collect) mode_collect ;;
    hang)    mode_hang ;;
    repro)   mode_repro ;;
    watch)   mode_watch ;;
esac
finalize
