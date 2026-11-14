'use strict';
/* Excel diagnostics log viewer - user interface. All heavy work happens in the worker (core.js). */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtN = (n) => Number(n).toLocaleString('en-US');
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const z2 = (n, w = 2) => String(n).padStart(w, '0');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const SEV = ['Debug', 'Info', 'Notice', 'Warning', 'Error', 'Fault'];

  // ---------- worker plumbing ----------
  let worker = null, seq = 0;
  const pending = new Map();
  async function sweepTemp() {                           // delete unpacked-zip folders left by sessions that have ended
    try {
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) {
        if (!name.startsWith('xldiag-')) continue;
        await navigator.locks.request(name, { ifAvailable: true }, async (lock) => { if (lock) await root.removeEntry(name, { recursive: true }); });
      }
    } catch (e) { /* no private file system here (file:// pages, older browsers): nothing to clean */ }
  }
  sweepTemp();
  function boot() {
    if (worker) { worker.terminate(); setTimeout(sweepTemp, 600); }
    for (const p of pending.values()) p.rej(new Error('superseded'));
    pending.clear();
    worker = new Worker(URL.createObjectURL(new Blob([$('#core-src').textContent], { type: 'text/javascript' })));
    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d.progress) return onProgress(d.progress);
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.error) p.rej(new Error(d.error)); else p.res(d.result);
    };
    worker.onerror = (e) => fail(e.message || 'The background worker stopped unexpectedly.');
  }
  const call = (op, args) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ id, op, args }); });

  // ---------- state ----------
  let info = null, tzMode = 'bundle';
  const S = { text: '', cs: false, facets: {}, t0: null, t1: null, pinnedOnly: false };
  let view = { count: 0, total: 0, hl: [], hist: null }, lastFacets = null;
  let pages = new Map(), topRow = 0, selPos = null, selIndex = -1, qGen = 0, qTimer = 0;
  const pins = new Map();

  // ---------- time ----------
  function offsetAt(t) {                                // minutes east of UTC for display
    if (tzMode === 'utc') return 0;
    if (tzMode === 'browser' || !info || !info.zone.length) return -new Date(t).getTimezoneOffset();
    const z = info.zone;
    let lo = 0, hi = z.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (z[m][0] <= t) lo = m + 1; else hi = m; }
    return z[Math.max(0, lo - 1)][1];
  }
  function fmtTime(t, ms = true) {
    if (t !== t) return '';
    const d = new Date(Math.floor(t) + offsetAt(t) * 60000);
    return `${d.getUTCFullYear()}-${z2(d.getUTCMonth() + 1)}-${z2(d.getUTCDate())} ${z2(d.getUTCHours())}:${z2(d.getUTCMinutes())}:${z2(d.getUTCSeconds())}${ms ? '.' + z2(d.getUTCMilliseconds(), 3) : ''}`;
  }
  function tzLabel(t) {
    const om = offsetAt(t), a = Math.abs(om);
    return om === 0 && tzMode === 'utc' ? 'UTC' : `UTC${om < 0 ? '-' : '+'}${z2((a / 60) | 0)}:${z2(a % 60)}`;
  }
  const fmtOff = (om) => { const a = Math.abs(om); return `UTC${om < 0 ? '-' : '+'}${z2((a / 60) | 0)}:${z2(a % 60)}`; };
  let tzFell = false;                                   // the logs gave no zone, so "bundle" fell back to "browser"
  function tzOptions() {                                // name each choice by whose clock it is, with the offset it means for this bundle
    const sel = $('#tz'), has = info.zone.length > 0;
    const span = [info.t0, info.t1].filter((t) => t === t);
    if (!span.length) span.push(Date.now());
    const mine = [...new Set(span.map((t) => -new Date(t).getTimezoneOffset()))].map(fmtOff).join(' and ');
    const theirs = [...new Set(info.zone.map((z) => z[1]))].map(fmtOff).join(' and ');
    const o = sel.options;
    o[0].textContent = has ? `the logged Mac's time zone (${theirs})` : "the logged Mac's time zone (not in these logs)";
    o[0].disabled = !has;
    o[2].textContent = `my time zone (${mine})`;
    if (!has && tzMode === 'bundle') { tzMode = 'browser'; tzFell = true; }
    else if (has && tzFell) { tzMode = 'bundle'; tzFell = false; }
    sel.value = tzMode;
    sel.title = has
      ? 'How times are displayed. The logged Mac is the one the bundle was collected on; its zone is read from its macOS log.'
      : "How times are displayed. These logs do not record the logged Mac's time zone, so times are in yours or in UTC.";
  }
  function parseTime(str) {                             // "YYYY-MM-DD HH:MM[:SS]" in the display zone -> UTC ms
    const m = /^\s*(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?)?\s*$/.exec(str);
    if (!m) return NaN;
    const naive = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0, +(m[7] || '0').padEnd(3, '0'));
    return naive - offsetAt(naive - offsetAt(naive) * 60000) * 60000;
  }
  const fmtSpan = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 120e3 ? `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)} s` : ms < 7200e3 ? `${Math.round(ms / 60e3)} min` : ms < 172800e3 ? `${(ms / 3600e3).toFixed(1)} h` : `${(ms / 86400e3).toFixed(1)} days`);

  // ---------- loading ----------
  function onProgress(p) {
    if (p.search) {
      const bar = $('#searchbar');
      bar.hidden = false;
      bar.firstElementChild.style.width = `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%`;
      $('#count').textContent = `${p.phase}… ${p.total ? Math.round((p.done / p.total) * 100) : 0}%`;
      return;
    }
    $('#progText').textContent = p.phase + (p.label ? `: ${p.label}` : '');
    $('#progBar').style.width = `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%`;
    // a zip written without zip64 understates members over 4 GB, so the total can be passed
    $('#progNum').textContent = !p.total ? '' : p.done > p.total ? fmtBytes(p.done) : `${fmtBytes(p.done)} of ${fmtBytes(p.total)}`;
  }
  function fail(msg) {
    $('#progress').hidden = true;
    $('#landing').hidden = false;
    $('#app').hidden = true;
    const el = $('#loadError');
    el.textContent = msg;
    el.hidden = false;
  }
  async function start(inputs, sample) {
    if (!sample && !inputs.length) return;
    boot();
    $('#loadError').hidden = true;
    $('#landing').hidden = true;
    $('#app').hidden = true;
    $('#progress').hidden = false;
    onProgress({ phase: 'Opening' });
    try { info = await call('load', sample ? { sample: true } : { inputs }); } catch (e) {
      if (e.message === 'superseded') return;
      worker.terminate(); worker = null;                  // also releases anything it had unpacked
      setTimeout(sweepTemp, 600);
      fail(e.message);
      return;
    }
    $('#progress').hidden = true;
    $('#app').hidden = false;
    init();
  }
  function init() {
    Object.assign(S, { text: '', cs: false, facets: {}, t0: info.focus ? info.focus[0] : null, t1: info.focus ? info.focus[1] : null, pinnedOnly: false });
    pins.clear(); selPos = null; selIndex = -1; topRow = 0;
    pages.clear(); view.count = 0;                      // rows from the bundle before this one must not be drawn with this one's names
    lastTokens = []; putNotes([]);
    tzOptions();
    $('#q').value = ''; $('#caseSens').checked = false;
    $('#bundleName').textContent = info.name;
    document.title = `${info.name} - Excel diagnostics viewer`;
    $('#detail').hidden = true;
    openState = null;
    $('#fileview').innerHTML = '<p class="dim">Choose a file. Files marked with a dot are on the timeline.</p>';
    $('#treeFilter').value = '';
    const banner = $('#banner');
    banner.hidden = !info.focus;
    if (info.focus) $('#bannerText').textContent = `Showing the period covered by the macOS and Excel logs. Everything in the bundle runs from ${fmtTime(info.t0, false).slice(0, 10)} to ${fmtTime(info.t1, false).slice(0, 10)}.`;
    mem = null; memDrawn = '';
    chartMarks = null; drawKey();
    { const gen = info; call('marks').then((m) => { if (info !== gen) return; chartMarks = m; drawKey(); if (view.hist && currentTab() === 'timeline') { drawHist(); layout(); setTop(topRow); } }).catch(() => {}); }
    const memTab = hasMemory();
    $('[data-tab="memory"]').hidden = !memTab;
    repOpen = null; repData = null;
    $('[data-tab="reports"]').hidden = !info.reports.length;
    buildReports();
    buildTree(''); renderOverview(); updatePins();
    showTab(info.total ? 'timeline' : 'files');
    $('#noRows').hidden = !!info.total;
    if (memTab) loadMemory();
    sideShown();
    runQuery();
  }

  // ---------- tabs ----------
  function showTab(name) {
    for (const b of document.querySelectorAll('.tabs button')) { b.classList.toggle('on', b.dataset.tab === name); if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    for (const s of document.querySelectorAll('#app > section')) s.hidden = s.id !== `tab-${name}`;
    if (name === 'timeline') { layout(); setTop(topRow); if (view.hist) drawHist(); }
    if (name === 'memory') drawMemory();
  }
  const currentTab = () => ($('.tabs button.on') || {}).dataset?.tab;

  // ---------- query ----------
  const schedule = (ms = 0) => { clearTimeout(qTimer); qTimer = setTimeout(runQuery, ms); };
  async function runQuery() {
    if (!info) return;
    const gen = ++qGen;
    const bins = clamp(Math.floor(($('#hist').clientWidth || 900) / 8), 30, 240);
    $('#tab-timeline').classList.add('busy');
    let r;
    try {
      r = await call('query', { text: S.text, cs: S.cs, facets: S.facets, t0: S.t0, t1: S.t1, bins, anchor: selPos,
        only: S.pinnedOnly ? [...pins.keys()].sort((a, b) => a - b) : null });
    } catch (e) {
      if (e.message !== 'superseded' && gen === qGen) {
        $('#count').textContent = e.message; $('#count').classList.add('err');
        $('#tab-timeline').classList.remove('busy'); $('#searchbar').hidden = true;
      }
      return;
    }
    if (gen !== qGen) return;
    $('#tab-timeline').classList.remove('busy');
    $('#searchbar').hidden = true;
    view = { count: r.count, total: r.total, hist: r.hist, hl: r.hl.map((h) => { try { return new RegExp(h.src, 'g' + h.flags); } catch (e) { return null; } }).filter(Boolean) };
    pages = new Map();
    lastFacets = r.facets;
    const c = $('#count');
    c.classList.toggle('err', !!r.err);
    c.textContent = r.err || `${fmtN(r.count)} of ${fmtN(r.total)} entries`;
    c.title = `Search took ${r.ms} ms`;
    $('#clear').disabled = !filtersActive();
    lastTokens = r.tokens || [];
    const said = noteLines(r);
    putNotes(said);
    drawHist(); renderFacets(); renderRange(); layout();
    if (selPos != null && r.anchorIndex != null && r.count) {
      selIndex = r.anchorExact ? r.anchorIndex : -1;
      setTop(r.anchorIndex - Math.floor(visibleRows() / 2));
    } else { selIndex = -1; setTop(0); }
    if (!r.count && info.total) whyNothing(gen, said);
  }

  // ---------- what the search text and the filters are doing, in words ----------
  // The engine explains search text that looks like a slip (a misspelt field, a value that names nothing in this
  // bundle, an unclosed quotation mark). When nothing matches, the search is also counted again with one condition
  // taken away at a time, so the page can say what each one is holding back.
  let lastTokens = [];
  const NOTE_LIST = { level: 'Severity', process: 'Process', subsystem: 'Subsystem / area', category: 'Category', source: 'Source' };
  function noteLines(r) {
    const lines = [];
    for (const n of r.notes || []) {
      if (n.soft && r.count) continue;                  // the text may be exactly what was meant
      lines.push(esc(n.text) + (NOTE_LIST[n.field] ? ` The ${NOTE_LIST[n.field]} list under Filters shows the names in this bundle.` : ''));
    }
    return lines;
  }
  function putNotes(lines) {
    const el = $('#qnotes'), html = lines.map((l) => `<p>${l}</p>`).join('');
    if (el.innerHTML === html && el.hidden === !lines.length) return;
    el.innerHTML = html;
    el.hidden = !lines.length;
  }
  async function whyNothing(gen, lines) {
    const base = { text: S.text, cs: S.cs, facets: S.facets, t0: S.t0, t1: S.t1, only: S.pinnedOnly ? [...pins.keys()].sort((a, b) => a - b) : null, dry: true };
    // words: the search has text to look for in the logs, not only field:value terms, which are answered from the index
    const tries = [], words = lastTokens.some((t) => !/^-?(?:level|lvl|sev|severity|process|proc|pid|subsystem|sub|area|category|cat|tag|source|src|file):/i.test(t));
    // A recount that still has words to look for reads the logs again wherever the search has not been yet. On a
    // bundle over 400 MB that is left out, and the page says so instead of going quiet for a minute.
    const light = info.sources.reduce((a, s) => a + s.size, 0) <= 400 << 20, reads = (t) => (words && !light ? null : t);
    let skipped = false;
    const add = (t) => { if (t) tries.push(t); else skipped = true; };
    if (S.t0 != null || S.t1 != null) add(reads({ q: { t0: null, t1: null }, say: 'in all time, outside the window shown', act: 'alltime', label: 'Show all time' }));
    if (Object.values(S.facets).some((f) => f.inc.length || f.exc.length)) add(reads({ q: { facets: {} }, say: 'without the choices in the Filters list', act: 'nofacets', label: 'Clear those choices' }));
    if (S.pinnedOnly) tries.push({ q: { only: null }, say: 'among entries that are not pinned as well', act: 'unpinned', label: 'Show unpinned entries too' });
    if (S.cs && words) add(reads({ q: { cs: false }, say: 'when capitals are ignored', act: 'nocase', label: 'Turn off Match case' }));
    const each = light && lastTokens.length > 1 && lastTokens.length <= 6;      // each search term taken away in turn
    if (each) lastTokens.forEach((tok, k) => tries.push({ q: { text: lastTokens.filter((_, i) => i !== k).join(' ') }, say: `without <code>${esc(tok)}</code>`, act: 'drop', k, label: 'Remove it' }));
    else if (S.text.trim() && tries.length + (skipped ? 1 : 0)) tries.push({ q: { text: '' }, say: 'without the search text', act: 'notext', label: 'Clear the search text' });     // no log is read for this one
    if (!tries.length) {
      if (S.text.trim() && !lines.length) { lines.push('No entry in this bundle matches that. A word is looked for anywhere in an entry, and capitals are ignored unless Match case is on.'); putNotes(lines); layout(); setTop(topRow); }
      return;
    }
    const got = [];
    for (const t of tries) {
      let res;
      try { res = await call('query', { ...base, ...t.q }); } catch (e) { return; }
      if (gen !== qGen) return;
      got.push(`${fmtN(res.count)} ${res.count === 1 ? 'entry matches' : 'entries match'} ${t.say}.${res.count ? ` <button data-act="${t.act}"${t.k !== undefined ? ` data-k="${t.k}"` : ''}>${t.label}</button>` : ''}`);
      if (!res.count) t.none = true;
    }
    const out = lines.concat(got);
    if (skipped) out.push('This bundle is large, so the search was not run again without the time window, the filters or Match case: that would read all of its logs once more.');
    else if (tries.length > 1 && tries.every((t) => t.none)) out.push('Taking away any one of these still leaves nothing, so more than one of them is ruling entries out.');
    putNotes(out); layout(); setTop(topRow);
  }
  $('#qnotes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.act) {
      case 'alltime': S.t0 = S.t1 = null; $('#banner').hidden = true; break;
      case 'nofacets': S.facets = {}; break;
      case 'unpinned': S.pinnedOnly = false; updatePins(); break;
      case 'nocase': S.cs = false; $('#caseSens').checked = false; break;
      case 'drop': S.text = lastTokens.filter((_, i) => i !== +b.dataset.k).join(' '); $('#q').value = S.text; break;
      case 'notext': S.text = ''; $('#q').value = ''; break;
      default: return;
    }
    $('#q').focus();                                    // the button is about to go: keep the keyboard somewhere
    schedule();
  });
  const filtersActive = () => !!(S.text.trim() || S.pinnedOnly || Object.values(S.facets).some((f) => f.inc.length || f.exc.length));
  function clearFilters() {
    S.text = ''; S.facets = {}; S.pinnedOnly = false;
    $('#q').value = '';
    updatePins();
    schedule();
  }
  function toggleFacet(name, v, mode) {
    const f = S.facets[name] || (S.facets[name] = { inc: [], exc: [] }), other = mode === 'inc' ? 'exc' : 'inc';
    f[other] = f[other].filter((x) => x !== v);
    const i = f[mode].indexOf(v);
    if (i >= 0) f[mode].splice(i, 1); else f[mode].push(v);
    schedule();
  }

  // ---------- facets ----------
  // Severity is one list: the six severities, and under each the levels the logs themselves use (macOS says Default
  // and Fault, Excel says Medium, Monitorable and Unexpected). Choosing a severity chooses all of its levels.
  const FACETS = [['lvl', 'Severity', 'level'], ['group', 'Source', 'source'], ['tag', 'Tag', 'tag'], ['proc', 'Process', 'process'],
    ['sub', 'Subsystem / area', 'subsystem'], ['cat', 'Category', 'category'], ['file', 'File', 'file']];
  const openFacets = new Set();                         // every group starts collapsed; a badge shows how many values are chosen
  const levelsOf = (sev) => info.lvlSev.reduce((ids, sv, v) => (sv === sev ? ids.concat(v) : ids), []);
  const sameWord = (a, b) => a.toLowerCase() === b.toLowerCase();
  function toggleSeverity(sev, mode) {
    const f = S.facets.lvl || (S.facets.lvl = { inc: [], exc: [] }), other = mode === 'inc' ? 'exc' : 'inc', ids = levelsOf(sev);
    const all = ids.every((v) => f[mode].includes(v));
    f[other] = f[other].filter((v) => !ids.includes(v));
    f[mode] = all ? f[mode].filter((v) => !ids.includes(v)) : [...new Set(f[mode].concat(ids))];
    schedule();
  }
  // Each value is two buttons, so both work from the keyboard: the name shows only that value, and the minus hides it.
  const facetRow = (cls, attr, title, label, n, dot) => `<div class="fv${cls}" ${attr} title="${title}&#10;Click to show only this. Click &minus; to hide it.">` +
    `<button class="pick" aria-pressed="${/ inc\b/.test(cls)}" aria-label="Show only ${esc(label)}${n < 0 ? '' : `, ${fmtN(n)} ${n === 1 ? 'entry' : 'entries'}`}"><span class="lbl">${dot ? '<i></i>' : ''}${esc(label)}</span>` +
    `<span class="n">${n < 0 ? '–' : fmtN(n)}</span></button><button class="x" aria-pressed="${/ exc\b/.test(cls)}" aria-label="Hide ${esc(label)}">−</button></div>`;
  function severityRows(f, sel) {
    const count = new Map(f.values), picked = (v) => sel.inc.includes(v) || sel.exc.includes(v);
    let html = '', chosen = 0;
    for (let sev = SEV.length - 1; sev >= 0; sev--) {
      const ids = levelsOf(sev);
      const inc = ids.length > 0 && ids.every((v) => sel.inc.includes(v)), exc = ids.length > 0 && ids.every((v) => sel.exc.includes(v));
      const shown = ids.filter((v) => count.get(v) > 0 || count.get(v) < 0 || (!inc && !exc && picked(v))).sort((x, y) => (count.get(y) || 0) - (count.get(x) || 0));
      const total = ids.some((v) => count.get(v) < 0) ? -1 : ids.reduce((sum, v) => sum + (count.get(v) || 0), 0);
      chosen += inc || exc ? 1 : ids.filter(picked).length;
      html += facetRow(` s${sev}${inc ? ' inc' : exc ? ' exc' : ''}`, `data-sev="${sev}"`, `${SEV[sev]}: every level counted as ${SEV[sev]}`, SEV[sev], total, true);
      if (shown.length > 1 || (shown.length === 1 && !sameWord(info.names.lvl[shown[0]] || '', SEV[sev]))) {
        for (const v of shown) {
          const name = info.names.lvl[v] || '(no level given)';
          html += facetRow(` sub${sel.inc.includes(v) ? ' inc' : sel.exc.includes(v) ? ' exc' : ''}`, `data-v="${v}"`, `Logged as ${esc(name)}, counted as ${SEV[sev]}`, name, count.get(v) || 0, false);
        }
      }
    }
    return { html, chosen };
  }
  function renderFacets() {
    // The list is redrawn after every search. Whatever in it had keyboard focus is found again afterwards, so
    // choosing a value with the keyboard does not throw the focus back to the top of the page.
    const act = document.activeElement, row = act && act.closest ? act.closest('#facets .fv') : null, group = act && act.closest ? act.closest('#facets details') : null;
    const keep = group ? { f: group.dataset.f, row: row ? (row.dataset.sev !== undefined ? `[data-sev="${row.dataset.sev}"]` : `[data-v="${row.dataset.v}"]`) : null, x: act.classList.contains('x') } : null;
    let html = '';
    for (const [name, title, field] of FACETS) {
      const f = lastFacets[name];
      if (!f || !f.values.length) continue;
      const sel = S.facets[name] || { inc: [], exc: [] };
      let body = '', nSel = sel.inc.length + sel.exc.length;
      if (name === 'lvl') ({ html: body, chosen: nSel } = severityRows(f, sel));
      else {
        for (const [v, n] of f.values) {
          const full = info.names[name][v] || '(none)', label = name === 'file' ? full.slice(full.lastIndexOf('/') + 1) : full;
          body += facetRow(sel.inc.includes(v) ? ' inc' : sel.exc.includes(v) ? ' exc' : '', `data-v="${v}"`, esc(full), label, n, false);
        }
        if (f.all > f.values.length) body += `<div class="more">${fmtN(f.all - f.values.length)} more. Type <code>${field}:text</code> in the search box to match any of them.</div>`;
      }
      html += `<details data-f="${name}"${openFacets.has(name) ? ' open' : ''}><summary>${title}${nSel ? `<b>${nSel}</b>` : ''}</summary>${body}</details>`;
    }
    $('#facets').innerHTML = html;
    if (keep) {                                         // the value itself if it is still listed, otherwise its group's heading
      const d = $(`#facets details[data-f="${keep.f}"]`);
      const el = d && ((keep.row && d.querySelector(`.fv${keep.row} ${keep.x ? '.x' : '.pick'}`)) || d.querySelector('summary'));
      if (el) el.focus({ preventScroll: true });
    }
  }

  // ---------- histogram ----------
  // Besides the bars, the chart carries what the bundle records about the same stretch of time (see marks() in
  // core.js): a row of marks above the bars for reports, Excel processes, restarts, installs and the collection; thin
  // lanes under them for what the macOS log and Excel's own logs cover and for when the Mac was asleep; and hatching
  // over any stretch the bundle has no macOS log for, so that it is not read as a quiet one.
  let chartMarks = null;
  const GLYPH = {                                       // kind -> [what the key calls it, drawing at (x, 7)]
    report: ['report (crash, hang, jetsam and others)', (x) => `<path class="g rep" d="M${x - 4.5},3h9l-4.5,8z"/>`],
    excel: ['first entry from an Excel process', (x) => `<circle class="g run" cx="${x}" cy="7" r="3.5"/>`],
    power: ['start, restart or shutdown', (x) => `<rect class="g pow" x="${x - 3.5}" y="3.5" width="7" height="7"/>`],
    install: ['install history', (x) => `<path class="g ins" d="M${x},2.5l4.5,4.5l-4.5,4.5l-4.5,-4.5z"/>`],
    collected: ['bundle collected', (x) => `<path class="g col" d="M${x - 4},7h8M${x},3v8"/>`],
  };
  const LANES = [['cu', 'macOS log in the bundle', (m) => m.cover.unified], ['co', "Excel's own logs", (m) => m.cover.office], ['ca', 'asleep, for as long as each sleep is recorded to have lasted', (m) => m.asleep]];
  function spanGaps(spans, a, b) {                      // the parts of [a, b] that no span covers
    const out = [];
    let at = a;
    for (const [s0, s1] of spans) { if (s1 <= at) continue; if (s0 >= b) break; if (s0 > at) out.push([at, s0]); at = Math.max(at, s1); }
    if (at < b) out.push([at, b]);
    return out;
  }
  function drawKey() {
    const m = chartMarks, el = $('#histKey');
    if (!m) { el.hidden = true; return; }
    const kinds = new Set(m.marks.map((x) => x.kind)), items = [];
    for (const k of Object.keys(GLYPH)) if (kinds.has(k)) items.push(`<span><svg width="12" height="14" aria-hidden="true">${GLYPH[k][1](6)}</svg>${GLYPH[k][0]}</span>`);
    for (const [cls, label, get] of LANES) if (get(m).length) items.push(`<span><svg width="14" height="14" aria-hidden="true"><rect class="lane ${cls}" x="0" y="5" width="14" height="4"/></svg>${label}</span>`);
    if (m.cover.unified.length || m.searched) items.push(`<span><svg width="14" height="14" aria-hidden="true"><rect x="0" y="1" width="14" height="12" fill="url(#nolog)"/></svg>${m.cover.unified.length ? 'no macOS log in the bundle for this time' : 'this bundle has no macOS log entries at all'}</span>`);
    el.innerHTML = items.join('');
    el.hidden = !items.length;
  }
  function drawHist() {
    const h = view.hist, el = $('#hist'), W = el.clientWidth, H = el.clientHeight || 168, cm = chartMarks;
    if (!h || !W) return;
    const lanes = cm ? LANES.filter((l) => l[2](cm).length) : [];
    const top = cm && cm.marks.length ? 16 : 6, bottom = 18 + (lanes.length ? lanes.length * 6 + 3 : 0), plotH = H - top - bottom;
    const nb = h.nb, bw = W / nb, tSpan = Math.max(1, h.t1 - h.t0), X = (t) => clamp(((t - h.t0) / tSpan) * W, 0, W);
    let max = 0;
    for (let b = 0; b < nb; b++) max = Math.max(max, h.bins[b * 3] + h.bins[b * 3 + 1] + h.bins[b * 3 + 2]);
    const base = top + plotH;
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Number of entries over time, by severity${cm && cm.marks.length ? `, with ${cm.marks.filter((m) => m.t >= h.t0 && m.t <= h.t1).length} recorded events marked` : ''}">` +
      '<defs><pattern id="nolog" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="7"/></pattern></defs>';
    if (cm && (cm.cover.unified.length || cm.searched)) for (const [a, b] of spanGaps(cm.cover.unified, h.t0, h.t1)) if (X(b) - X(a) >= 1) s += `<rect class="nolog" x="${X(a).toFixed(1)}" y="${top}" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${plotH}" fill="url(#nolog)"/>`;
    if (!max) s += `<text class="tick" x="${W / 2}" y="${top + plotH / 2}" text-anchor="middle">No entries in this window</text>`;
    const w = Math.max(1, bw - 2);
    for (let b = 0; b < nb && max; b++) {
      const parts = [[h.bins[b * 3], 'o'], [h.bins[b * 3 + 1], 'w'], [h.bins[b * 3 + 2], 'e']].filter((p) => p[0]);
      if (!parts.length) continue;
      const hs = parts.map((p) => Math.max(3, (p[0] / max) * plotH));
      let over = hs.reduce((a, v) => a + v, 0) - plotH;      // the 3px minimum can overshoot; take it back from the tallest segment
      if (over > 0) hs[hs.indexOf(Math.max(...hs))] -= over;
      const x = b * bw + 1;
      let y = base;
      parts.forEach((p, i) => {
        const hh = hs[i], last = i === parts.length - 1, gap = i ? 2 : 0;
        y -= hh;
        const ht = Math.max(1, hh - gap);
        if (last) { const r = Math.min(3, w / 2, ht); s += `<path class="b${p[1]}" d="M${x},${y + ht}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + ht}Z"/>`; }
        else s += `<rect class="b${p[1]}" x="${x}" y="${y}" width="${w}" height="${ht}"/>`;
      });
    }
    s += `<line class="axis" x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}"/>`;
    const span = h.t1 - h.t0, nt = clamp(Math.floor(W / 170), 2, 8);
    for (let i = 0; i <= nt; i++) {
      const t = h.t0 + (span * i) / nt, full = fmtTime(t, false);
      const label = span > 36 * 3600e3 ? full.slice(5, 16) : span > 20 * 60e3 ? (i === 0 ? full.slice(5, 16) : full.slice(11, 16)) : full.slice(11, 19);
      s += `<text class="tick" x="${clamp((W * i) / nt, 2, W - 2)}" y="${H - 4}" text-anchor="${i === 0 ? 'start' : i === nt ? 'end' : 'middle'}">${label}</text>`;
    }
    lanes.forEach(([cls, , get], k) => {
      for (const [a, b] of get(cm)) if (b > h.t0 && a < h.t1) s += `<rect class="lane ${cls}" x="${X(a).toFixed(1)}" y="${base + 3 + k * 6}" width="${Math.max(1.5, X(b) - X(a)).toFixed(1)}" height="4"/>`;
    });
    if (cm) {
      // Where marks crowd, one of each kind is drawn for every few pixels: none of a stretch goes unmarked, and the
      // tooltip there still lists each one.
      const rank = { report: 0, collected: 1, power: 2, excel: 3, install: 4 }, taken = new Set();
      const seen = cm.marks.filter((m) => m.t >= h.t0 && m.t <= h.t1).sort((a, b) => rank[a.kind] - rank[b.kind])
        .filter((m) => { const spot = `${m.kind}:${Math.round(X(m.t) / 4)}`; if (taken.has(spot)) return false; taken.add(spot); return true; });
      for (const m of seen.reverse()) {                   // reports are drawn last, on top
        const x = +clamp(X(m.t), 5, W - 5).toFixed(1);
        if (m.kind === 'report' || m.kind === 'collected') s += `<line class="gline ${m.kind === 'collected' ? 'col' : ''}" x1="${x}" x2="${x}" y1="12" y2="${base}"/>`;
        s += GLYPH[m.kind][1](x);
      }
    }
    s += `<rect id="histHover" class="hov" y="${top}" height="${plotH}" width="${bw}" visibility="hidden"/><rect id="histBrush" class="brush" y="${top}" height="${plotH}" width="0" visibility="hidden"/></svg>`;
    el.innerHTML = s;
  }
  (function histEvents() {
    const el = $('#hist'), tip = $('#histTip');
    let down = null;
    const at = (e) => { const r = el.getBoundingClientRect(); return clamp(e.clientX - r.left, 0, r.width); };
    el.addEventListener('pointerdown', (e) => { if (!view.hist || e.button !== 0 || e.ctrlKey) return; down = at(e); el.setPointerCapture(e.pointerId); });
    el.addEventListener('contextmenu', (e) => {         // right-click: twice the time span, keeping the moment under the pointer in place
      e.preventDefault();
      const h = view.hist;
      if (!h) return;
      if (S.t0 == null && S.t1 == null) { flash('Already showing all time'); return; }
      const tc = h.t0 + ((h.t1 - h.t0) * at(e)) / el.clientWidth;
      setRange(tc - (tc - h.t0) * 2, tc + (h.t1 - tc) * 2);
    });
    el.addEventListener('pointermove', (e) => {
      const h = view.hist;
      if (!h) return;
      const x = at(e), W = el.clientWidth, bw = W / h.nb, b = clamp(Math.floor(x / bw), 0, h.nb - 1);
      const brush = $('#histBrush'), hov = $('#histHover');
      if (down != null && Math.abs(x - down) > 3) {
        brush.setAttribute('x', Math.min(x, down)); brush.setAttribute('width', Math.abs(x - down)); brush.setAttribute('visibility', 'visible');
        hov.setAttribute('visibility', 'hidden');
        tip.hidden = true;
        return;
      }
      hov.setAttribute('x', b * bw); hov.setAttribute('visibility', 'visible');
      const t = h.t0 + ((h.t1 - h.t0) * b) / h.nb, t2 = h.t0 + ((h.t1 - h.t0) * (b + 1)) / h.nb;
      const o = h.bins[b * 3], wn = h.bins[b * 3 + 1], er = h.bins[b * 3 + 2];
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tt';
      head.textContent = `${fmtTime(t, false)} to ${fmtTime(t2, false).slice(11)}`;
      tip.append(head);
      for (const [n, cls, name, one] of [[er, 'be', 'errors and faults', 'error or fault'], [wn, 'bw', 'warnings', 'warning'], [o, 'bo', 'other entries', 'other entry']]) {
        const row = document.createElement('div');
        row.innerHTML = `<i class="${cls}"></i><b>${fmtN(n)}</b> ${n === 1 ? one : name}`;
        tip.append(row);
      }
      if (chartMarks) {                                 // what the bundle records in or beside this bar
        const pad = ((h.t1 - h.t0) / W) * 5, say = (text) => { const row = document.createElement('div'); row.textContent = text; tip.append(row); };
        const near = chartMarks.marks.filter((m) => m.t >= t - pad && m.t < t2 + pad);
        for (const m of near.slice(0, 6)) say(`${fmtTime(m.t, false).slice(span0(h) ? 5 : 11)}  ${m.text}`);
        if (near.length > 6) say(`and ${fmtN(near.length - 6)} more`);
        const part = (spans) => { const gaps = spanGaps(spans, t, t2), miss = gaps.reduce((a, g) => a + g[1] - g[0], 0); return miss >= t2 - t ? 'none' : miss > 0 ? 'part' : 'all'; };
        if (!chartMarks.cover.unified.length && chartMarks.searched) say('The bundle has no macOS log entries at all');
        else if (chartMarks.cover.unified.length && part(chartMarks.cover.unified) !== 'all') say(`The bundle has no macOS log for ${part(chartMarks.cover.unified) === 'none' ? 'this time' : 'part of this time'}`);
        if (chartMarks.cover.office.length && part(chartMarks.cover.office) !== 'all') say(`Excel's own logs in the bundle do not cover ${part(chartMarks.cover.office) === 'none' ? 'this time' : 'part of this time'}`);
        if (chartMarks.asleep.length && part(chartMarks.asleep) !== 'none') say(`Asleep for ${part(chartMarks.asleep) === 'all' ? 'all' : 'part'} of this time, as the sleep and wake history records it`);
      }
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      tip.style.left = `${clamp(x + 14, 0, r.width - tip.offsetWidth - 4)}px`;
    });
    const end = (e) => {
      const h = view.hist;
      tip.hidden = true;
      if ($('#histHover')) $('#histHover').setAttribute('visibility', 'hidden');
      if (down == null || !h || e.type === 'pointerleave') { if (e.type !== 'pointerleave') down = null; return; }
      const x = at(e), W = el.clientWidth, a = Math.min(x, down), b = Math.max(x, down);
      down = null;
      if (b - a > 3) {                                   // drag: zoom to the selection
        S.t0 = h.t0 + ((h.t1 - h.t0) * a) / W; S.t1 = h.t0 + ((h.t1 - h.t0) * b) / W;
        schedule();
      } else if (view.count) {                           // click: scroll the table to that time
        call('seek', { t: h.t0 + ((h.t1 - h.t0) * x) / W }).then((k) => setTop(k - 2));
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointerleave', end);
  })();
  const span0 = (h) => h.t1 - h.t0 > 20 * 3600e3;       // a window of most of a day or more: times in a tooltip need their date
  function renderRange() {
    const t0 = S.t0 != null ? S.t0 : info.t0, t1 = S.t1 != null ? S.t1 : info.end;
    $('#tFrom').value = fmtTime(t0, false);
    $('#tTo').value = fmtTime(t1, false);
    $('#tzNote').textContent = `${tzLabel(t0)} · ${fmtSpan(t1 - t0)}`;
    $('#allTime').disabled = S.t0 == null && S.t1 == null;
    $('#zoomOut').disabled = S.t0 == null && S.t1 == null;
  }
  function setRange(t0, t1) {
    if (t0 != null && t1 != null && t1 <= t0) return;
    S.t0 = t0 != null && t0 <= info.t0 ? null : t0;
    S.t1 = t1 != null && t1 > info.end ? null : t1;
    schedule();
  }

  // ---------- virtual table ----------
  const ROW = 22, PAGE = 200, MAXPX = 6e6;
  const vs = $('#vs'), rowsEl = $('#rows'), spacer = $('#spacer');
  let expected = -1, rafPending = false;
  const visibleRows = () => Math.max(1, Math.floor(vs.clientHeight / ROW));
  const maxTop = () => Math.max(0, view.count - visibleRows());
  function layout() {
    rowsEl.style.height = `${vs.clientHeight}px`;
    spacer.style.height = `${Math.max(0, Math.min(view.count * ROW, MAXPX) - vs.clientHeight)}px`;
  }
  function setTop(r, fromScroll) {
    topRow = clamp(r, 0, maxTop());
    if (!fromScroll) {
      const range = vs.scrollHeight - vs.clientHeight;
      expected = maxTop() ? Math.round((topRow / maxTop()) * range) : 0;
      vs.scrollTop = expected;
    }
    requestRender();
  }
  vs.addEventListener('scroll', () => {                 // scrollbar drags; wheel input is handled below
    if (Math.abs(vs.scrollTop - expected) <= 1) return;
    const range = vs.scrollHeight - vs.clientHeight;
    expected = vs.scrollTop;
    topRow = range > 0 ? (vs.scrollTop / range) * maxTop() : 0;
    requestRender();
  });
  vs.addEventListener('wheel', (e) => {                 // millions of rows do not fit in a scrollable element, so scroll by rows
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    setTop(topRow + (e.deltaMode === 1 ? e.deltaY * 3 : e.deltaY / ROW));
  }, { passive: false });
  function requestRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); } }
  function fetchPage(p) {
    const pg = { rows: null, promise: null };
    pages.set(p, pg);
    pg.promise = call('rows', { start: p * PAGE, count: PAGE }).then((rows) => {
      pg.rows = rows;
      if (pages.size > 40) { const here = Math.floor(topRow / PAGE); for (const k of [...pages.keys()]) if (Math.abs(k - here) > 4) pages.delete(k); }
      if (pages.get(p) === pg) requestRender();
    }).catch(() => { pg.rows = []; });
    return pg;
  }
  function rowAt(k) { const p = Math.floor(k / PAGE), pg = pages.get(p) || fetchPage(p); return pg.rows ? pg.rows[k - p * PAGE] : null; }
  async function rowReady(k) { const p = Math.floor(k / PAGE), pg = pages.get(p) || fetchPage(p); await pg.promise; return pg.rows[k - p * PAGE]; }
  const oneLine = (s) => (s.length > 700 ? s.slice(0, 700) + '…' : s).replace(/\s*\n\s*/g, ' ⏎ ');
  function mark(text) {                                 // escape, highlighting what the search terms matched
    if (!view.hl.length) return esc(text);
    const spans = [];
    for (const re of view.hl) {
      re.lastIndex = 0;
      for (let m, guard = 0; (m = re.exec(text)) && guard < 300; guard++) { if (!m[0].length) { re.lastIndex++; continue; } spans.push([m.index, m.index + m[0].length]); }
    }
    if (!spans.length) return esc(text);
    spans.sort((a, b) => a[0] - b[0]);
    let out = '', p = 0;
    for (const [a, b] of spans) { if (b <= p) continue; const st = Math.max(a, p); out += esc(text.slice(p, st)) + '<mark>' + esc(text.slice(st, b)) + '</mark>'; p = b; }
    return out + esc(text.slice(p));
  }
  function render() {
    if (!info) return;
    const first = Math.floor(topRow), n = Math.min(visibleRows() + 1, view.count - first);
    let html = '';
    for (let k = first; k < first + n; k++) {
      const r = rowAt(k);
      if (!r) { html += `<div class="r ph" data-k="${k}"><span class="c t">…</span></div>`; continue; }
      const sev = info.lvlSev[r[3]], src = info.sources[r[2]], lv = info.names.lvl[r[3]] || SEV[sev];
      html += `<div class="r s${sev}${r[0] === selPos ? ' sel' : ''}" data-k="${k}">` +
        `<span class="c t">${pins.has(r[0]) ? '<b class="pin" title="Pinned">★</b>' : ''}${fmtTime(r[1])}</span>` +
        `<span class="c sv"${sameWord(lv, SEV[sev]) ? '' : ` title="Logged as ${esc(lv)}, counted as ${SEV[sev]}"`}><i></i>${esc(lv)}</span>` +
        `<span class="c so" title="${esc(src.path)}">${esc(src.short)}</span>` +
        `<span class="c p">${esc(info.names.proc[r[4]])}${r[5] ? `<u>${r[5]}</u>` : ''}</span>` +
        `<span class="c m">${mark(oneLine(r[9]))}</span></div>`;
    }
    rowsEl.innerHTML = html;
    $('#empty').hidden = view.count > 0 || !info.total;
  }
  rowsEl.addEventListener('click', (e) => { const el = e.target.closest('.r'); if (el) select(+el.dataset.k, true); });
  async function select(k, open) {
    if (k < 0 || k >= view.count) return;
    selIndex = k;
    if (k < Math.floor(topRow)) setTop(k); else if (k > Math.floor(topRow) + visibleRows() - 2) setTop(k - visibleRows() + 2);
    const r = await rowReady(k);
    if (selIndex !== k || !r) return;
    selPos = r[0];
    requestRender();
    if (open || !$('#detail').hidden) showDetail(r[0]);
  }
  const moveSel = (d) => select(clamp((selIndex >= 0 ? selIndex : Math.floor(topRow) - (d > 0 ? 1 : 0)) + d, 0, view.count - 1), false);
  async function nextSev(dir) {
    const from = selIndex >= 0 ? selIndex : Math.floor(topRow) - (dir > 0 ? 1 : 0);
    const k = await call('findSev', { from, dir, min: 4 });
    if (k < 0) return flash(dir > 0 ? 'No later errors in these results' : 'No earlier errors in these results');
    await select(k, false);
    setTop(k - Math.floor(visibleRows() / 3));
  }
  function flash(msg) { const el = $('#flash'); el.textContent = msg; el.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 2200); }

  // ---------- detail panel ----------
  async function showDetail(pos) {
    let d;
    try { d = await call('row', { pos }); } catch (e) { return; }
    if (selPos !== pos) return;
    const r = d.row, sev = info.lvlSev[r[3]], src = info.sources[r[2]], N = info.names, el = $('#detail');
    const filt = (name, v) => `<span class="fb"><button data-f="${name}" data-v="${v}" data-m="inc" title="Show only this">+</button><button data-f="${name}" data-v="${v}" data-m="exc" title="Hide this">−</button></span>`;
    const rows = [
      ['Time', `${esc(fmtTime(r[1]))} <span class="dim">${tzLabel(r[1])}${tzMode !== 'utc' ? ` · ${new Date(Math.floor(r[1])).toISOString().replace('T', ' ').replace('Z', '')} UTC` : ''}</span>`],
      ['Severity', `<span class="sv s${sev}"><i></i>${esc(N.lvl[r[3]] || SEV[sev])}</span>${N.lvl[r[3]] && !sameWord(N.lvl[r[3]], SEV[sev]) ? ` <span class="dim">counted as ${SEV[sev]}</span>` : ''}${filt('lvl', r[3])}`],
      ['Source', `${esc(src.group)} <span class="dim">${esc(src.path)}</span>${filt('file', r[2])}`],
      N.proc[r[4]] && ['Process', `${esc(N.proc[r[4]])}${filt('proc', r[4])}`],
      r[5] && ['PID', `${r[5]} <span class="fb"><button data-pid="${r[5]}" title="Add pid:${r[5]} to the search">+</button></span>`],
      N.sub[r[6]] && ['Subsystem / area', `${esc(N.sub[r[6]])}${filt('sub', r[6])}`],
      N.cat[r[7]] && ['Category', `${esc(N.cat[r[7]])}${filt('cat', r[7])}`],
      r[8] && ['Tags', N.tag.map((t, b) => ((r[8] >> b) & 1 ? `${esc(t)}${filt('tag', b)}` : '')).filter(Boolean).join(' ')],
      ...Object.entries(d.extra || {}).filter(([k, v]) => v && k !== 'file').map(([k, v]) => [k, esc(v)]),
    ].filter(Boolean);
    let json = '';
    const msg = r[9], brace = msg.indexOf('{');
    if (brace >= 0 && msg.length < 400000) { try { const o = JSON.parse(msg.slice(brace)); if (o && typeof o === 'object') json = JSON.stringify(o, null, 2); } catch (e) { /* not JSON */ } }
    const fileIdx = d.extra && d.extra.file ? info.files.findIndex((f) => f.path === d.extra.file) : src.virtual ? -1 : info.files.findIndex((f) => f.path === src.path);
    const repIdx = d.extra && d.extra.file ? info.reports.findIndex((x) => x.path === d.extra.file) : -1;
    el.innerHTML = `<div class="dbar">
        <button data-act="pin">${pins.has(pos) ? '★ Unpin' : '☆ Pin'}</button>
        <button data-act="context" ${filtersActive() ? '' : 'disabled'} title="Clear the filters but stay on this entry">Show in context</button>
        <span class="grp">Zoom to <button data-act="win" data-w="5000">±5 s</button><button data-act="win" data-w="60000">±1 min</button><button data-act="win" data-w="600000">±10 min</button></span>
        <button data-act="copy">Copy line</button>
        ${repIdx >= 0 ? `<button data-act="report" data-p="${repIdx}">Open report</button>` : fileIdx >= 0 ? `<button data-act="file" data-i="${fileIdx}">Open file</button>` : ''}
        <span class="spacer"></span><button data-act="close" aria-label="Close details">✕</button></div>
      <div class="dbody"><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="dmsg"><pre>${mark(json ? msg.slice(0, brace) : msg)}</pre>${json ? `<pre class="json">${mark(json)}</pre>` : ''}${r[10] ? '<p class="dim">This entry is longer than 2 MB; the rest is not shown.</p>' : ''}</div></div>`;
    el.hidden = false;
    el._row = d;
    layout(); setTop(topRow);
    if (selIndex >= 0 && selIndex > Math.floor(topRow) + visibleRows() - 2) setTop(selIndex - visibleRows() + 2);
  }
  $('#detail').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = $('#detail')._row, pos = d.row[0], t = d.row[1];
    if (b.dataset.f) return toggleFacet(b.dataset.f, +b.dataset.v, b.dataset.m);
    if (b.dataset.pid) { addTerm(`pid:${b.dataset.pid}`); return; }
    switch (b.dataset.act) {
      case 'pin': togglePin(d.row); showDetail(pos); break;
      case 'context': clearFilters(); break;
      case 'win': setRange(t - +b.dataset.w, t + +b.dataset.w); break;
      case 'copy': navigator.clipboard.writeText(d.raw).then(() => flash('Copied'), () => flash('Copy was blocked by the browser')); break;
      case 'file': openFile(+b.dataset.i); break;
      case 'report': openReport(+b.dataset.p); break;
      case 'close': closeDetail(); break;
    }
  });
  function closeDetail() { $('#detail').hidden = true; layout(); setTop(topRow); }
  function addTerm(term) { const q = $('#q'); q.value = (q.value.trim() + ' ' + term).trim(); S.text = q.value; schedule(); }
  function togglePin(row) { if (pins.has(row[0])) pins.delete(row[0]); else pins.set(row[0], row); updatePins(); requestRender(); if (S.pinnedOnly) schedule(); }
  function updatePins() {
    const b = $('#pinnedOnly');
    if (!pins.size) S.pinnedOnly = false;
    b.textContent = `★ Pinned (${pins.size})`;
    b.disabled = !pins.size;
    b.classList.toggle('on', S.pinnedOnly);
    b.setAttribute('aria-pressed', String(S.pinnedOnly));
  }

  // ---------- files tab ----------
  function buildTree(filter) {
    const el = $('#tree'), f = filter.trim().toLowerCase();
    const link = (x, label) => `<button class="tf${x.src >= 0 && x.rows ? ' src' : ''}${openState && openState.i === x.i ? ' on' : ''}" data-i="${x.i}" title="${esc(x.path)}${x.src >= 0 && x.rows ? '&#10;On the timeline' : ''}"><span>${esc(label)}</span><span class="n">${fmtBytes(x.size)}</span></button>`;
    if (f) {
      const hits = info.files.filter((x) => x.path.toLowerCase().includes(f));
      el.innerHTML = hits.slice(0, 500).map((x) => link(x, x.path)).join('') + (hits.length > 500 ? `<div class="more">${fmtN(hits.length - 500)} more matches</div>` : '') || '<div class="more">No files match.</div>';
      return;
    }
    const root = { dirs: new Map(), files: [], count: 0 };
    for (const x of info.files) {
      let parts = x.path.split('/');
      if (parts.length > 41) parts = [...parts.slice(0, 40), parts.slice(40).join('/')];     // folders nested past any real depth are shown as one
      let node = root;
      node.count++;
      for (let i = 0; i < parts.length - 1; i++) { if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [], count: 0 }); node = node.dirs.get(parts[i]); node.count++; }
      node.files.push(x);
    }
    const html = (node, depth) => [...node.dirs].map(([name, d]) => `<details${depth < 1 && d.count <= 60 ? ' open' : ''}><summary>${esc(name)}<span class="cnt" title="${fmtN(d.count)} ${d.count === 1 ? 'file' : 'files'} in this folder">(${fmtN(d.count)})</span></summary><div class="kids">${html(d, depth + 1)}</div></details>`).join('') +
      node.files.map((x) => link(x, x.path.slice(x.path.lastIndexOf('/') + 1))).join('');
    el.innerHTML = html(root, 0);
  }
  const isBinary = (b) => { const n = Math.min(b.length, 4096); let odd = 0; for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0) return true; if (c < 9 || (c > 13 && c < 32)) odd++; } return odd > n / 10; };
  function hexDump(b) {
    let out = '';
    for (let o = 0; o < b.length; o += 16) {
      const row = b.subarray(o, o + 16);
      out += `${o.toString(16).padStart(6, '0')}  ${[...row].map((c) => c.toString(16).padStart(2, '0')).join(' ').padEnd(48)}  ${[...row].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')}\n`;
    }
    return out;
  }
  function tableHtml(text, sep) {
    const lines = text.split(/\r?\n/).filter(Boolean), head = lines[0].split(sep);
    return `<table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${lines.slice(1, 3001).map((l) => `<tr>${l.split(sep).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` +
      (lines.length > 3001 ? `<p class="dim">Showing the first 3,000 of ${fmtN(lines.length - 1)} rows.</p>` : '');
  }
  let openState = null;
  async function openFile(i) {
    const f = info.files[i], el = $('#fileview');
    showTab('files');
    for (const a of document.querySelectorAll('#tree .tf.on')) a.classList.remove('on');
    const a = $(`#tree .tf[data-i="${i}"]`);
    if (a) {
      a.classList.add('on');
      for (let p = a.parentElement; p && p.id !== 'tree'; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
      a.scrollIntoView({ block: 'nearest' });
    }
    const table = /\.(tsv|csv)$/i.test(f.path) && f.src < 0 && f.size <= 4 << 20;
    el.innerHTML = `<div class="fhead"><h2>${esc(f.path)}</h2><span class="dim">${fmtBytes(f.size)}</span>` +
      (f.src >= 0 ? `<button data-src="${f.src}">Show its ${fmtN(f.rows)} entries on the timeline</button>` : '') +
      `<span class="spacer"></span><input id="lineFilter" type="search" placeholder="Filter lines" aria-label="Filter lines" hidden></div><div id="fbody" class="fbody"><p class="dim">Loading…</p></div>`;
    const state = openState = { i, text: '', loaded: 0, size: f.size };
    const got = await call('fileChunk', { i, offset: 0, len: table ? 4 << 20 : 512 << 10 });
    if (openState !== state) return;
    const bytes = new Uint8Array(got.bytes), body = $('#fbody');
    state.size = got.size; state.loaded = bytes.length;
    if (!bytes.length) { body.innerHTML = '<p class="dim">This file is empty.</p>'; return; }
    if (isBinary(bytes)) {
      const odl = /\.(odl|odlgz|odlsent|aodl)$/i.test(f.path);
      body.innerHTML = `<p class="dim">${odl ? 'OneDrive sync logs are stored in an obfuscated binary format that only Microsoft can decode.' : 'This is a binary file.'} First ${fmtN(Math.min(2048, bytes.length))} bytes:</p><pre>${esc(hexDump(bytes.subarray(0, 2048)))}</pre>`;
      return;
    }
    state.text = new TextDecoder().decode(bytes);
    if (/\.md$/i.test(f.path)) body.innerHTML = `<div class="doc">${f.path === 'case/incident_context.md' ? contextHeading(state.text).lead : ''}${mdOrPlain(state.text)}</div>`;
    else if (table) body.innerHTML = `<div class="tbl">${tableHtml(state.text, /\.csv$/i.test(f.path) ? ',' : '\t')}</div>`;
    else { $('#lineFilter').hidden = false; renderText(); }
  }
  function renderText() {
    const st = openState, body = $('#fbody'), f = ($('#lineFilter').value || '').toLowerCase();
    const text = f ? st.text.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') : st.text;
    body.innerHTML = `<pre>${esc(text)}</pre>` + (st.loaded < st.size ? `<p><button id="more">Load the next ${fmtBytes(Math.min(2 << 20, st.size - st.loaded))}</button> <span class="dim">${fmtBytes(st.loaded)} of ${fmtBytes(st.size)} shown</span></p>` : '');
  }
  $('#fileview').addEventListener('click', async (e) => {
    if (e.target.dataset.src) { S.facets = { file: { inc: [+e.target.dataset.src], exc: [] } }; S.text = ''; $('#q').value = ''; S.t0 = S.t1 = null; showTab('timeline'); schedule(); return; }
    if (e.target.id === 'more') {
      const st = openState, got = await call('fileChunk', { i: st.i, offset: st.loaded, len: 2 << 20 });
      if (openState !== st) return;
      st.text += new TextDecoder().decode(got.bytes); st.loaded += got.bytes.byteLength;
      renderText();
    }
  });
  $('#fileview').addEventListener('input', (e) => { if (e.target.id === 'lineFilter') renderText(); });

  // ---------- reports tab ----------
  // The crash, hang and other diagnostic reports in the bundle, and each one laid out as it was recorded: the facts in
  // its header, the stack the report itself singles out, and the images it lists. The page adds nothing to them.
  let repOpen = null, repData = null;
  const kindSev = (kind) => { const v = info.names.lvl.indexOf(kind); return v >= 0 ? info.lvlSev[v] : 1; };
  function buildReports() {
    const list = info.reports.map((r, i) => ({ ...r, i })).sort((a, b) => a.t - b.t), kinds = new Map();
    for (const r of list) kinds.set(r.kind, (kinds.get(r.kind) || 0) + 1);
    $('#repcount').textContent = `${fmtN(list.length)} ${list.length === 1 ? 'report' : 'reports'} in this bundle: ${[...kinds].map(([k, n]) => `${fmtN(n)} ${k}`).join(', ')}. Oldest first.`;
    $('#replist').innerHTML = list.map((r) => `<button class="rep s${kindSev(r.kind)}${repOpen === r.path ? ' on' : ''}" data-p="${r.i}" title="${esc(r.path)}">` +
      `<span class="t">${fmtTime(r.t, false)}</span><span class="sv"><i></i>${esc(r.kind)}</span><span class="p">${esc(r.proc)}</span><span class="w">${esc(r.what || r.path.slice(r.path.lastIndexOf('/') + 1))}</span></button>`).join('');
    if (!repOpen) $('#repview').innerHTML = '<p class="dim">Choose a report on the left. Each one is also an entry on the timeline, at the time it records.</p>';
  }
  function imageRows() {
    const f = (($('#imgFilter') || {}).value || '').toLowerCase(), all = repData.images, hits = f ? all.filter((im) => `${im.name}\n${im.path}\n${im.id}`.toLowerCase().includes(f)) : all;
    $('#imgTable').innerHTML = `<p class="dim">${f ? `${fmtN(hits.length)} of ${fmtN(all.length)} match.` : `${fmtN(all.length)} images, in the order the report lists them.`}</p>` +
      `<div class="tbl"><table><thead><tr><th>Image</th><th>Version</th><th>Path</th></tr></thead><tbody>${hits.slice(0, 600).map((im) => `<tr><td>${esc(im.name)}</td><td>${esc(im.version)}</td><td>${esc(im.path)}</td></tr>`).join('')}</tbody></table></div>` +
      (hits.length > 600 ? `<p class="dim">Showing the first 600. Filter to narrow them down.</p>` : '');
  }
  async function openReport(i, stay) {                  // stay: redraw it where it is, without switching to the Reports tab
    const r = info.reports[i], el = $('#repview'), gen = info;
    if (!r) return;
    repOpen = r.path; repData = null;
    if (!stay) showTab('reports');
    for (const b of document.querySelectorAll('#replist .rep')) b.classList.toggle('on', +b.dataset.p === i);
    el.innerHTML = '<p class="dim">Reading the report…</p>';
    let d;
    try { d = await call('report', { path: r.path }); } catch (e) { if (info === gen && repOpen === r.path) el.innerHTML = `<p class="dim">This report could not be read: ${esc(e.message)}</p>`; return; }
    if (info !== gen || repOpen !== r.path) return;
    repData = d;
    const file = info.files.find((f) => f.path === r.path), pos = `data-p="${i}"`;
    let h = `<div class="fhead"><h2>${esc(r.kind)}: ${esc(r.proc)}</h2><span class="dim">${fmtTime(r.t, false)} ${tzLabel(r.t)}</span><span class="spacer"></span>` +
      `<button data-act="time" ${pos}>Show on the timeline</button>${file ? `<button data-act="raw" data-i="${file.i}">Open the file</button>` : ''}</div>` +
      `<p class="dim">${esc(r.path)}${file ? ` · ${fmtBytes(file.size)}` : ''}. Laid out as the report records it; nothing here is added or interpreted.</p>`;
    if (d.headerOnly) h += `<p class="note">This report is ${fmtBytes(d.size)}, more than this page reads of one report, so only its first line is laid out below. Open the file for the rest.</p>`;
    else if (d.read < d.size) h += `<p class="note">Only the first ${fmtBytes(d.read)} of this report were read, so parts of it may be missing below. Open the file for the rest.</p>`;
    if (d.facts.length) h += `<div class="tbl"><table class="kv"><tbody>${d.facts.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>`;
    if (r.kind === 'Jetsam') {                          // the Memory tab lays out the newest five, as it says there
      const newest = info.reports.filter((x) => x.kind === 'Jetsam').sort((a, b) => b.t - a.t).slice(0, 5).includes(r);
      h += newest ? `<p>The processes this report lists, with the memory each held, are on the <button class="link" data-act="memory">Memory tab</button>.</p>`
        : '<p>The processes this report lists, with the memory each held, are in the file itself. The Memory tab lays out only the five newest jetsam reports.</p>';
    }
    if (d.stack && d.stack.frames) {
      h += `<h3>${esc(d.stack.title)}</h3><div class="tbl"><table class="frames"><thead><tr><th>#</th><th>Image</th><th>Symbol or offset</th><th>Source</th></tr></thead><tbody>` +
        d.stack.frames.map((f, n) => `<tr><td>${n}</td><td>${esc(f.image)}</td><td>${esc([f.symbol, f.offset].filter(Boolean).join(' '))}</td><td>${esc(f.source)}</td></tr>`).join('') + '</tbody></table></div>';
    } else if (d.stack) h += `<h3>${esc(d.stack.title)}</h3><pre>${esc(d.stack.lines.join('\n'))}</pre>`;
    if (d.stack && d.stack.more) h += `<p class="dim">${fmtN(d.stack.more)} more ${d.stack.frames ? 'frames' : 'lines'} are in the file.</p>`;
    if (d.images.length) h += `<details class="block"><summary>Images listed in the report <span class="dim">${fmtN(d.images.length)}</span></summary><input id="imgFilter" type="search" placeholder="Filter by name, path or identifier" aria-label="Filter images"><div id="imgTable"></div></details>`;
    if (!d.facts.length && !d.stack) h += '<p class="dim">This file has no header this page knows how to lay out. Open the file to read it as it is.</p>';
    el.innerHTML = h;
    el.scrollTop = 0;
    if (d.images.length) imageRows();
  }
  async function showReportEntry(r) {                   // the report's own entry on the timeline, not merely the first one at its time
    if (r.pos == null) return jumpTo(r.t);
    if ((S.t0 != null && r.t < S.t0) || (S.t1 != null && r.t > S.t1)) { S.t0 = S.t1 = null; $('#banner').hidden = true; }
    selPos = r.pos;
    showTab('timeline');
    await runQuery();                                   // lands on it, or beside it if the search or the filters leave it out
    if (selIndex < 0) flash('The search or the filters leave this report\'s entry out; the list is at the entries around its time');
    else showDetail(r.pos);
  }
  $('#replist').addEventListener('click', (e) => { const b = e.target.closest('.rep'); if (b) openReport(+b.dataset.p); });
  $('#repview').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'time') showReportEntry(info.reports[+b.dataset.p]);
    else if (b.dataset.act === 'raw') openFile(+b.dataset.i);
    else if (b.dataset.act === 'memory') showTab('memory');
  });
  $('#repview').addEventListener('input', (e) => { if (e.target.id === 'imgFilter') imageRows(); });

  // ---------- small markdown renderer (summary.md, incident_context.md) ----------
  function md(src) {
    const lines = src.split(/\r?\n/), inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    let out = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const h = /^(#{1,6}) (.*)$/s.exec(l);
      if (h) { out += `<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`; i++; continue; }
      if (l.startsWith('|')) {
        const rows = [];
        while (i < lines.length && lines[i].startsWith('|')) { if (!/^\|[\s:|-]+$/.test(lines[i])) rows.push(lines[i].replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim())); i++; }
        if (!rows.length) continue;                         // a table that is only its ruling line
        out += `<table><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        continue;
      }
      // Before lists: a line indented by four spaces is shown as it was written, even when it starts like a list item
      if (/^ {4}/.test(l)) { let code = ''; while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) code += lines[i++].slice(4) + '\n'; out += `<pre>${esc(code.trimEnd())}</pre>`; continue; }
      const li = /^ {0,3}([-*]|\d+\.) (.*)$/s.exec(l);
      if (li) {
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
        out += `<${tag}>`;
        for (let m; i < lines.length && (m = /^ {0,3}([-*]|\d+\.) (.*)$/s.exec(lines[i])); i++) out += `<li>${inline(m[2])}</li>`;
        out += `</${tag}>`;
        continue;
      }
      let para = lines[i++] + ' ';                      // whatever this line is, it is used up here: the loop always moves on
      while (i < lines.length && lines[i].trim() && !/^(#{1,6} |\|| {0,3}([-*]|\d+\.) | {4})/.test(lines[i])) para += lines[i++] + ' ';
      out += `<p>${inline(para.trim())}</p>`;
    }
    return out;
  }
  // Which collector wrote case/incident_context.md. Before 1.5.0 the collector put its own sentences there; from
  // 1.5.0 the file holds only what whoever ran it gave. Told apart by what the file holds, not by the bundle, and
  // line by line as md() reads it, so that nothing inside a typed line or a path can pass for a line of its own.
  const mdOrPlain = (text) => { try { return md(text); } catch (err) { return `<pre>${esc(text)}</pre>`; } };
  function contextKind(text) {
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => /^- Case: /.test(l) || /^## (Reported behavior|Best next capture)\s*$/.test(l))) return 'old';
    return lines.some((l) => /^- Collector started: /.test(l)) ? 'given' : 'other';
  }
  // The title for that file and, for one from an older collector, the paragraph shown above it. Used wherever the
  // file is drawn, so that the older collector's own sentences are never shown without it.
  function contextHeading(text) {
    const kind = contextKind(text);
    if (kind === 'given') return { name: 'Incident context, as given when the collector was run', lead: '' };
    if (kind !== 'old') return { name: 'Incident context', lead: '' };
    return { name: 'Incident context, from an older collector',
      lead: '<p class="note">The "Case" line and the sentences under "Reported behavior" and "Best next capture" in this file are the collector\'s own wording. ' +
        'Collectors before 1.5.0 wrote them when the question "Is this the crash when filtering a PivotTable?" was answered yes, which pressing Return also did, ' +
        'or when <code>--case pivot-filter</code> was given. Nobody typed those sentences.</p>' };
  }

  // ---------- overview tab ----------
  let overviewRun = 0;                                  // a redraw that starts while another is still reading files replaces it
  async function renderOverview() {
    const el = $('#overview'), gen = info, run = ++overviewRun;
    let facts = [];
    try { facts = await call('facts'); } catch (e) { /* the page is drawn without them */ }
    if (info !== gen || run !== overviewRun) return;
    const src = info.sources.filter((s) => s.rows);
    let html = `<div class="tiles"><div><b>${fmtN(info.total)}</b><span>timeline entries</span></div><div><b>${fmtN(src.length)}</b><span>log sources</span></div>` +
      `<div><b>${fmtN(info.files.length)}</b><span>files in the bundle</span></div><div><b>${fmtBytes(info.files.reduce((a, f) => a + f.size, 0))}</b><span>unpacked</span></div></div>`;
    for (const n of info.notes) html += `<p class="note">${esc(n)}</p>`;
    if (facts.length) {
      const fileLink = (p) => { const f = p && info.files.find((x) => x.path === p); return f ? `<button class="link" data-i="${f.i}" title="Open this file">${esc(p)}</button>` : ''; };
      html += `<h2>This Mac and this collection</h2><p class="dim">As the bundle records them. The last column is the file each line was read from.</p><div class="tbl"><table class="kv"><tbody>` +
        facts.map((f) => `<tr><th scope="row">${esc(f.label)}</th><td>${esc(f.value)}</td><td>${fileLink(f.path)}</td></tr>`).join('') + '</tbody></table></div>';
    }
    html += `<h2>Sources on the timeline</h2><div class="tbl"><table><thead><tr><th>Source</th><th>File</th><th class="num">Entries</th><th>First entry</th><th>Last entry</th><th class="num">Size</th></tr></thead><tbody>` +
      src.map((s) => `<tr><td>${esc(s.group)}</td><td><button class="link" data-src="${s.id}" title="Show only this file on the timeline">${esc(s.path)}</button></td><td class="num">${fmtN(s.rows)}</td><td>${fmtTime(s.t0, false)}</td><td>${fmtTime(s.t1, false)}</td><td class="num">${fmtBytes(s.size)}</td></tr>`).join('') +
      `</tbody></table></div><p class="dim">Times are shown in ${tzMode === 'utc' ? 'UTC' : tzMode === 'bundle' ? "the logged Mac's time zone" : 'your time zone'}.</p><div id="docs"></div>`;
    el.innerHTML = html;
    const docs = [['case/incident_context.md', 'Incident context', true], ['summary.md', 'Collector summary', true], ['reports/crash_summary.txt', 'Diagnostic report summary', true],
      ['unified_logs/collection_status.txt', 'Unified log collection status', true], ['office/versions.txt', 'Office versions', false], ['system/system_info.txt', 'System information', false], ['collection.log', 'Collection log', false]];
    for (const [path, title, open] of docs) {
      const f = info.files.find((x) => x.path === path);
      if (!f || !f.size) continue;
      const got = await call('fileChunk', { i: f.i, offset: 0, len: 256 << 10 });
      if (info !== gen || run !== overviewRun) return;
      const text = new TextDecoder().decode(got.bytes), d = document.createElement('details');
      const { name, lead } = path === 'case/incident_context.md' ? contextHeading(text) : { name: title, lead: '' };
      d.open = open;
      d.innerHTML = `<summary>${esc(name)} <span class="dim">${esc(path)}</span></summary><div class="doc">${lead}${/\.md$/.test(path) ? mdOrPlain(text) : `<pre>${esc(text)}</pre>`}</div>`;
      $('#docs').append(d);
    }
  }
  $('#overview').addEventListener('click', (e) => {
    if (e.target.dataset.i) { openFile(+e.target.dataset.i); return; }
    if (e.target.dataset.src) { S.facets = { file: { inc: [+e.target.dataset.src], exc: [] } }; S.text = ''; $('#q').value = ''; S.t0 = S.t1 = null; showTab('timeline'); schedule(); }
  });

  // ---------- memory ----------
  // Everything the bundle holds about memory, laid out as it was recorded. This page reports figures and marks when
  // things happened; it draws no conclusions, so the person reading can make their own.
  let mem = null, memDrawn = '';
  const PRESSURE = { 1: 'normal', 2: 'warning', 4: 'critical' };
  const toMB = (v) => { const m = /^([\d.]+)\s*([BKMGT])/i.exec(String(v).trim()); return m ? +m[1] * { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[m[2].toUpperCase()] : NaN; };
  const fmtMB = (v) => (v !== v ? '' : v >= 10 ? `${fmtN(Math.round(v))} MB` : `${v.toFixed(1)} MB`);
  // In a collector's bundle the memory files are the ones at the places the collector writes them. A file of the
  // same name in a folder that was copied from the Mac is not one of them: such a folder can hold anything.
  const MEM_PLACE = /^(?:system\/(?:memory|system_info)\.txt|(?:repro\/[^/]+\/)?(?:system_memory|excel_footprint)\.txt|office\/excel_footprint\.txt|memory_snapshots\.txt|excel_memory_timeline\.csv)$/;
  const memFiles = (rx) => {
    const own = info.files.some((f) => f.path === 'manifest.tsv' || f.path === 'bundle_info.tsv');
    return info.files.filter((f) => f.size && rx.test(f.path) && (!own || MEM_PLACE.test(f.path)));
  };
  // The largest of a list, or FLOOR. Not Math.max(...list): with a few hundred thousand items that call fails.
  const maxOf = (list, floor) => list.reduce((a, v) => (v > a ? v : a), floor);
  const hasMemory = () => memFiles(/(^|\/)(excel_memory_timeline\.csv|memory\.txt|system_memory\.txt|memory_snapshots\.txt|excel_footprint\.txt)$/).length > 0 ||
    info.reports.some((r) => r.kind === 'Jetsam') || info.names.tag.includes('memory');
  const readText = async (f, cap) => new TextDecoder().decode((await call('fileChunk', { i: f.i, offset: 0, len: Math.min(f.size, cap) })).bytes);

  function parseTimeline(file, text) {                  // excel_memory_timeline.csv from watch and repro modes
    const lines = text.split(/\r?\n/).filter(Boolean), head = lines[0].split(','), rows = lines.slice(1).map((l) => l.split(','));
    // Each column's number is worked out once, not for every row: the heading line can name any number of columns
    const at = new Map();
    head.forEach((n, i) => { if (!at.has(n)) at.set(n, i); });
    const col = (n) => (at.has(n) ? at.get(n) : -1), num = (n) => { const k = col(n); return rows.map((r) => (r[k] === '' || r[k] == null ? NaN : +r[k])); };
    const timeAt = col('utc_time'), pidAt = col('excel_pid');
    return { file, t: rows.map((r) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(r[timeAt] || ''); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; }),
      pid: rows.map((r) => r[pidAt] || ''), foot: num('excel_footprint_mb'), cmp: num('excel_compressed_mb'), cpu: num('excel_cpu_pct'), threads: num('excel_threads'),
      level: num('pressure_level'), free: num('free_mb'), comp: num('compressor_mb'), swap: num('swap_used_mb') };
  }
  function parseSnapshots(file, text) {                 // each "=== local / UTC ===" block the collector wrote with snapshot_memory
    const out = [], parts = text.split(/^=== .*?\/ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC ===$/m);
    for (let k = 1; k + 1 < parts.length; k += 2) {
      const body = parts[k + 1], t = Date.parse(parts[k].replace(' ', 'T') + 'Z'), procs = [];
      const table = /^PID\s+COMMAND.*$/m.exec(body);
      if (table) {
        for (const line of body.slice(table.index + table[0].length).split('\n').slice(1)) {
          // PID, a name that may hold spaces, two sizes, a number, a count. Read word by word: one pattern with
          // several open-ended parts side by side takes minutes on a line that is mostly spaces.
          const w = line.length > 600 ? [] : line.trim().split(/[ \t]+/), size = /^\d[\d.]*[BKMGT][+-]?$/;
          let k = /^\d+$/.test(w[0] || '') ? 2 : w.length;
          while (k + 3 < w.length && !(size.test(w[k]) && size.test(w[k + 1]) && /^[\d.]+$/.test(w[k + 2]) && /^\d+/.test(w[k + 3]))) k++;
          if (k + 3 >= w.length) { if (procs.length) break; continue; }
          procs.push({ pid: +w[0], name: w.slice(1, k).join(' '), mb: toMB(w[k]), cmp: toMB(w[k + 1]) });
        }
      }
      out.push({ file, t, level: +((/^Memory pressure level[^:\n]*:[ \t]*(\d+)/m.exec(body) || [])[1] || NaN), swap: toMB((/^Swap:.*?used = ([\d.]+[BKMGT])/m.exec(body) || [0, ''])[1]),
        phys: (/^PhysMem:[ \t]*(.*)$/m.exec(body) || [0, ''])[1].trim(), ram: +((/^The system has (\d+) \(/m.exec(body) || [])[1] || NaN) / 1048576, procs });
    }
    return out;
  }
  function parseFootprint(file, text) {                 // `footprint -p` for Excel: its memory by kind
    let head = null;
    const rows = [];
    for (const line of text.split('\n')) {                // lines of ordinary length only: these patterns are slow on a very long one
      if (line.length > 400) continue;
      if (!head) head = /^(.+?) \[(\d+)\]:.*?Footprint:[ \t]*([\d.]+ ?[KMGT]?B)/.exec(line);
      const m = /^[ \t]*([\d.]+ ?[KMGT]?B)[ \t]+([\d.]+ ?[KMGT]?B)[ \t]+([\d.]+ ?[KMGT]?B)[ \t]+(\d+)[ \t]+(\S.*)$/.exec(line);
      if (m && m[5].trimEnd() !== 'TOTAL') rows.push({ name: m[5].trimEnd(), mb: toMB(m[1]), clean: toMB(m[2]), regions: +m[4] });
    }
    return head && rows.length ? { file, proc: head[1], pid: +head[2], total: toMB(head[3]), rows: rows.sort((a, b) => b.mb - a.mb) } : null;
  }
  function parseJetsam(file, report, text) {            // a JetsamEvent report: macOS's own record of ending processes to free memory
    try {
      const j = JSON.parse(text.slice(text.indexOf('\n') + 1)), ms = j.memoryStatus || {}, page = ms.pageSize || 16384, mb = (pages) => (pages * page) / 1048576, pages = ms.memoryPages || {};
      const procs = (j.processes || []).map((p) => ({ name: p.name || '?', pid: p.pid, mb: mb(p.rpages || 0), max: mb(p.lifetimeMax || 0), reason: p.reason || '' })).sort((a, b) => b.mb - a.mb);
      return { file, t: report.t, largest: j.largestProcess || '', free: 'free' in pages ? mb(pages.free) : NaN, comp: 'compressorSize' in ms ? mb(ms.compressorSize) : NaN, procs };
    } catch (e) { return null; }
  }
  async function loadMemory() {
    const gen = info, m = { csv: null, snaps: [], foots: [], jets: [], jetCount: 0, ram: NaN, act: null };
    try {
      const csv = memFiles(/(^|\/)excel_memory_timeline\.csv$/)[0];
      if (csv) m.csv = parseTimeline(csv, await readText(csv, 16 << 20));
      for (const f of memFiles(/(^|\/)(memory|system_memory|memory_snapshots)\.txt$/)) m.snaps.push(...parseSnapshots(f, await readText(f, 8 << 20)));
      m.snaps.sort((a, b) => b.t - a.t);
      for (const f of memFiles(/(^|\/)excel_footprint\.txt$/)) { const p = parseFootprint(f, await readText(f, 1 << 20)); if (p) m.foots.push(p); }
      const jets = info.reports.filter((r) => r.kind === 'Jetsam').sort((a, b) => b.t - a.t);
      m.jetCount = jets.length;
      for (const r of jets.slice(0, 5)) {
        const f = info.files.find((x) => x.path === r.path), j = f && parseJetsam(f, r, await readText(f, 8 << 20));
        if (j) m.jets.push(j);
      }
      const sys = memFiles(/(^|\/)system_info\.txt$/)[0];
      if (sys) m.ram = +((/^[ \t]*Memory:[ \t]*([\d.]+)[ \t]*GB/m.exec(await readText(sys, 1 << 20)) || [])[1] || NaN) * 1024;
      if (m.ram !== m.ram) m.ram = (m.snaps.find((s) => s.ram === s.ram) || { ram: NaN }).ram;
      if (info.names.tag.includes('memory')) m.act = await call('tagTimes', { tag: 'memory', bins: 120 });
    } catch (e) { if (info !== gen) return; m.error = e.message || String(e); }
    if (info !== gen) return;
    mem = m; memDrawn = '';
    if (currentTab() === 'memory') drawMemory();
  }

  const barTable = (cols, rows, max) => `<div class="scrollx"><table class="bars"><thead><tr>${cols.map((c, i) => `<th${i > 1 ? ' class="num"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr${r.strong ? ' class="strong"' : ''}><td>${esc(r.name)}</td><td class="mb"><i style="width:calc((100% - 84px) * ${max ? clamp(r.mb / max, 0, 1).toFixed(3) : 0})"></i><span>${fmtMB(r.mb)}</span></td>${r.rest.map((x) => `<td class="num">${esc(x)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>';
  const moreRows = (n, html) => (n > 0 ? `<details class="rest"><summary>${fmtN(n)} more</summary>${html}</details>` : '');
  const isExcel = (name) => /excel/i.test(name);

  // A timeline file can record a change on every one of its lines. The list under the charts shows this many of
  // them and says how many more there are; the charts draw one mark of each kind for every few pixels (see lineChart).
  const EVENTS_LISTED = 200;
  function memoryEvents(c) {                            // what happened during the timeline: Excel's PID changing, pressure changing, reports written
    const ev = [], ok = c.t.filter((v) => v === v), t0 = ok[0], t1 = ok[ok.length - 1], bands = [];
    for (let i = 1; i < c.t.length; i++) {
      // Only what the timeline recorded: the Excel PID column at this sample and at the one before. Why it changed is not
      // recorded, so nothing is said about that.
      if (c.pid[i] !== c.pid[i - 1]) ev.push({ t: c.t[i], kind: 'run', changed: !!c.pid[i - 1], text: !c.pid[i] ? `No Excel PID at this sample; it was ${c.pid[i - 1]} at the sample before` : !c.pid[i - 1] ? `Excel PID ${c.pid[i]} at this sample; none at the sample before` : `Excel PID ${c.pid[i]} at this sample; it was ${c.pid[i - 1]} at the sample before` });
      if (c.level[i] !== c.level[i - 1] && c.level[i] === c.level[i]) ev.push({ t: c.t[i], kind: 'level', text: `Memory pressure changed to ${PRESSURE[c.level[i]] || c.level[i]}` });
    }
    for (let i = 0; i < c.t.length; i++) {              // spans at warning or critical, for shading
      const lv = c.level[i];
      if (lv !== 2 && lv !== 4) continue;
      let j = i;
      while (j + 1 < c.t.length && c.level[j + 1] === lv) j++;
      bands.push({ t0: c.t[i], t1: j + 1 < c.t.length ? c.t[j + 1] : c.t[j], level: lv });
      i = j;
    }
    for (const r of info.reports) {
      if (r.t < t0 || r.t > t1) continue;
      if (r.kind === 'Jetsam' || r.kind === 'Panic' || (/^(Crash|Hang|Spin|Force quit)$/.test(r.kind) && isExcel(r.proc))) ev.push({ t: r.t, kind: 'report', text: r.kind === 'Jetsam' ? 'Jetsam report' : `${r.kind} report: ${r.proc}`, path: r.path });
    }
    return { ev: ev.sort((a, b) => a.t - b.t), bands, t0, t1 };
  }

  function drawMemory() {
    const el = $('#memory');
    if (!mem) { el.innerHTML = '<p class="dim">Reading the memory files…</p>'; return; }
    const key = `${tzMode}|${info.name}`;
    const c = mem.csv, E = c ? memoryEvents(c) : null;
    if (memDrawn !== key) { try {
      memDrawn = key;
      const fileLink = (f) => `<button class="link" data-i="${f.i}">${esc(f.path)}</button>`, when = (t) => `<button class="link" data-t="${t}" title="Open the timeline at this moment">${fmtTime(t, false)}</button>`;
      const tiles = [];
      if (mem.ram === mem.ram) tiles.push([`${fmtN(Math.round(mem.ram / 1024))} GB`, 'memory installed']);
      if (c) {
        tiles.push([fmtMB(maxOf(c.foot.filter((v) => v === v), 0)), 'highest Excel footprint sampled']);
        tiles.push([PRESSURE[maxOf(c.level.filter((v) => v === v), 1)] || '?', 'highest memory pressure sampled']);
        tiles.push([fmtN(E.ev.filter((e) => e.kind === 'run' && e.changed).length), 'times the Excel PID went away or changed between samples']);
      }
      const snap = mem.snaps[0], foot = mem.foots[0];
      if (!c && foot) tiles.push([fmtMB(foot.total), 'Excel footprint when collected']);
      if (!c && snap && snap.level === snap.level) tiles.push([PRESSURE[snap.level] || String(snap.level), 'memory pressure when collected']);
      if (!c && snap && snap.swap === snap.swap) tiles.push([fmtMB(snap.swap), 'swap in use when collected']);
      if (mem.jetCount) tiles.push([fmtN(mem.jetCount), mem.jetCount === 1 ? 'jetsam report' : 'jetsam reports']);
      if (mem.act && mem.act.total) tiles.push([fmtN(mem.act.total), 'log entries tagged memory']);
      let h = `<p class="dim">What this bundle recorded about memory. The figures are shown as the collector and macOS wrote them; nothing here is interpreted.</p>` +
        (mem.error ? `<p class="dim">Some of it could not be read: ${esc(mem.error)}</p>` : '') +
        `<div class="tiles">${tiles.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>`;
      if (c) {
        h += `<h2>Sampled over time</h2><p class="dim">${fmtN(c.t.length)} samples from ${fileLink(c.file)}. Drag across a chart to open that span on the timeline, or click to jump to a moment.</p>
          <div class="chartkey"><span><i class="mk run"></i>Excel started or stopped</span><span><i class="mk rep"></i>crash, hang or jetsam report</span><span><i class="bd w"></i>memory pressure: warning</span><span><i class="bd c"></i>critical</span></div>
          <h3>Excel memory</h3><div class="chart" id="ch1"></div><h3>System memory</h3><div class="chart" id="ch2"></div>
          <h3>Excel CPU</h3><div class="chart" id="ch3"></div><h3>Excel threads</h3><div class="chart" id="ch4"></div>
          <h3>Events in this period</h3>${E.ev.length ? `<ul class="events">${E.ev.slice(0, EVENTS_LISTED).map((e) => `<li>${when(e.t)} ${esc(e.text)}</li>`).join('')}${E.ev.length > EVENTS_LISTED ? `<li class="dim">${fmtN(E.ev.length - EVENTS_LISTED)} more events in this period are not listed here.</li>` : ''}</ul>` : '<p class="dim">Excel kept the same PID, memory pressure did not change, and no crash, hang or jetsam report falls in this period.</p>'}`;
      }
      if (mem.act && mem.act.total) {
        h += `<h2>Memory entries in the logs</h2><p class="dim">${fmtN(mem.act.total)} entries tagged <code>memory</code>: the memory-pressure, compressor, swap and jetsam messages of the kernel, and the jetsam messages of ReportCrash and osanalyticshelper. The chart shows how many were logged over time. <button class="link" data-act="memtag">Show them on the timeline</button></p><div class="chart" id="ch5"></div>`;
      }
      if (mem.snaps.length) {
        h += `<h2>Memory snapshots</h2><p class="dim">The state of the whole Mac at the moments the collector took a snapshot: the processes using the most memory, as <code>top</code> listed them.</p>`;
        mem.snaps.slice(0, 6).forEach((s, k) => {
          const max = maxOf(s.procs.map((p) => p.mb), 1), rows = s.procs.map((p) => ({ name: p.name, mb: p.mb, strong: isExcel(p.name), rest: [fmtMB(p.cmp), p.pid] }));
          const facts = [s.level === s.level && `Memory pressure: ${PRESSURE[s.level] || s.level}`, s.swap === s.swap && `Swap in use: ${fmtMB(s.swap)}`, s.phys && `Physical memory: ${s.phys}`].filter(Boolean);
          h += `<details class="block"${k ? '' : ' open'}><summary>${fmtTime(s.t, false)} <span class="dim">${esc(s.file.path)}</span></summary><p>${facts.map(esc).join(' · ')} · ${when(s.t)} on the timeline · ${fileLink(s.file)}</p>` +
            (rows.length ? barTable(['Process', 'Memory', 'Compressed', 'PID'], rows.slice(0, 12), max) + moreRows(rows.length - 12, barTable(['Process', 'Memory', 'Compressed', 'PID'], rows.slice(12), max)) : '<p class="dim">No process list in this snapshot.</p>') + '</details>';
        });
        if (mem.snaps.length > 6) h += `<p class="dim">${fmtN(mem.snaps.length - 6)} earlier snapshots are in the files listed above.</p>`;
      }
      if (mem.foots.length) {
        h += `<h2>Excel's memory by kind</h2><p class="dim">How Excel's footprint divided up when the collector ran <code>footprint</code> on it. MALLOC rows are memory the app allocated itself; IOSurface, CoreAnimation and CG rows are graphics.</p>`;
        for (const f of mem.foots) {
          const max = maxOf(f.rows.map((r) => r.mb), 1), rows = f.rows.map((r) => ({ name: r.name, mb: r.mb, rest: [fmtN(r.regions)] }));
          h += `<p><b>${esc(f.proc)}</b> (PID ${f.pid}): ${fmtMB(f.total)} footprint · ${fileLink(f.file)}</p>` + barTable(['Kind', 'Memory', 'Regions'], rows.slice(0, 12), max) + moreRows(rows.length - 12, barTable(['Kind', 'Memory', 'Regions'], rows.slice(12), max));
        }
      }
      if (mem.jetCount) {
        h += `<h2>Jetsam reports</h2><p class="dim">macOS writes a JetsamEvent report when it ends processes to free memory. Each lists every process and its memory at that moment. Where macOS wrote a reason against a process, it is shown.</p>`;
        for (const j of mem.jets) {
          const max = maxOf(j.procs.map((p) => p.mb), 1), named = j.procs.filter((p) => p.reason);
          const row = (p) => ({ name: p.name, mb: p.mb, strong: isExcel(p.name), rest: [fmtMB(p.max), p.reason] });
          const facts = [j.largest && `Largest process, as recorded: ${j.largest}`, j.free === j.free && `Free: ${fmtMB(j.free)}`, j.comp === j.comp && `Held by the compressor: ${fmtMB(j.comp)}`, `${fmtN(j.procs.length)} processes listed`].filter(Boolean);
          h += `<details class="block" open><summary>${fmtTime(j.t, false)} <span class="dim">${esc(j.file.path.slice(j.file.path.lastIndexOf('/') + 1))}</span></summary><p>${facts.map(esc).join(' · ')} · ${when(j.t)} on the timeline · ${fileLink(j.file)}</p>` +
            (named.length ? `<h4>Processes with a recorded reason</h4>${barTable(['Process', 'Memory', 'Lifetime peak', 'Reason'], named.slice(0, 20).map(row), max)}${named.length > 20 ? `<p class="dim">${fmtN(named.length - 20)} more in the report.</p>` : ''}` : '<p class="dim">No process in this report has a recorded reason.</p>') +
            `<h4>Largest processes</h4>${barTable(['Process', 'Memory', 'Lifetime peak', 'Reason'], j.procs.slice(0, 10).map(row), max)}</details>`;
        }
        if (mem.jetCount > mem.jets.length) h += `<p class="dim">${fmtN(mem.jetCount - mem.jets.length)} more jetsam reports are on the timeline (search <code>Jetsam</code>) and under Files.</p>`;
      }
      el.innerHTML = h;
    } catch (err) {
      // What could not be drawn is said, and nothing from before is left standing under this bundle's name
      memDrawn = '';
      el.innerHTML = `<p class="note">The memory figures of this bundle could not be drawn (${esc(err && err.message ? err.message : String(err))}). The files themselves are on the Files tab.</p>`;
      return;
    }
    }
    if (c) {
      const o = { t0: E.t0, t1: E.t1, marks: E.ev.filter((e) => e.kind !== 'level'), bands: E.bands };
      lineChart($('#ch1'), c.t, [{ name: 'Physical footprint', cls: 'c1', v: c.foot }, { name: 'Compressed', cls: 'c2', v: c.cmp }], { ...o, unit: 'MB' });
      lineChart($('#ch2'), c.t, [{ name: 'Free', cls: 'c1', v: c.free }, { name: 'Held by the compressor', cls: 'c2', v: c.comp }, { name: 'Swap used', cls: 'c3', v: c.swap }], { ...o, unit: 'MB' });
      lineChart($('#ch3'), c.t, [{ name: 'Excel CPU', cls: 'c1', v: c.cpu }], { ...o, unit: '%', h: 150 });
      lineChart($('#ch4'), c.t, [{ name: 'Excel threads', cls: 'c1', v: c.threads }], { ...o, unit: 'threads', h: 150 });
    }
    if (mem.act && mem.act.total && $('#ch5')) countChart($('#ch5'), mem.act);
  }

  // Shared pointer handling for the memory charts: hover reports a time, a drag opens that span on the timeline, a click jumps to a moment.
  function chartPointer(el, svg, L, pw, t0, t1, onHover, snap) {
    const brush = $('.brush', svg), timeAt = (x) => t0 + (clamp(x - L, 0, pw) / pw) * (t1 - t0), xOf = (e) => e.clientX - svg.getBoundingClientRect().left;
    let down = null;
    svg.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; down = xOf(e); svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => {
      const x = xOf(e);
      if (down != null && Math.abs(x - down) > 4) {
        const a = clamp(Math.min(x, down), L, L + pw), b = clamp(Math.max(x, down), L, L + pw);
        brush.setAttribute('x', a); brush.setAttribute('width', b - a); brush.setAttribute('visibility', 'visible');
      }
      onHover(timeAt(x), x);
    });
    svg.addEventListener('pointerup', (e) => {
      const x = xOf(e), was = down;
      down = null; brush.setAttribute('visibility', 'hidden');
      if (was == null) return;
      if (Math.abs(x - was) > 4) openRange(timeAt(Math.min(x, was)), timeAt(Math.max(x, was))); else jumpTo(snap ? snap(timeAt(x)) : timeAt(x));
    });
    svg.addEventListener('pointerleave', () => onHover(null));
  }
  function openRange(a, b) {                            // show a span of time on the timeline
    if (!(b - a >= 1)) return;
    S.t0 = a; S.t1 = b;
    $('#banner').hidden = true;
    showTab('timeline');
    schedule();
  }
  const tipRow = (tip, cls, strong, text) => { const row = document.createElement('div'), key = document.createElement('i'), val = document.createElement('b'); key.className = cls; val.textContent = strong; row.append(key, val, ` ${text}`); tip.append(row); };
  const tipHead = (tip, text) => { tip.replaceChildren(); const head = document.createElement('div'); head.className = 'tt'; head.textContent = text; tip.append(head); };

  function lineChart(el, t, series, o) {
    const W = el.clientWidth || 800, H = o.h || 230, L = 56, R = 14, T = 12, B = 24, pw = W - L - R, ph = H - T - B;
    const ok = t.map((v, i) => (v === v ? i : -1)).filter((i) => i >= 0);
    if (!ok.length) { el.textContent = 'No samples.'; return; }
    const t0 = o.t0, t1 = Math.max(o.t1, t0 + 1);
    let max = 1;
    for (const s of series) for (const v of s.v) if (v > max) max = v;
    const step = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(max / 4))).find((x) => max / x <= 5) || max;
    const top = Math.ceil(max / step) * step, X = (v) => L + ((v - t0) / (t1 - t0)) * pw, Y = (v) => T + ph - (v / top) * ph;
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(series.map((x) => x.name).join(', '))} over time, in ${esc(o.unit)}">`;
    // Where spans of memory pressure or marks crowd, the chart draws no more than fits: spans of one level that touch
    // or overlap on screen are drawn as one, and one mark of each kind is drawn for every few pixels, as on the main
    // chart. No stretch goes unshaded or unmarked, and the tooltip there lists the first few marks and counts the rest.
    for (const level of [2, 4]) {
      const spans = o.bands.filter((b) => b.level === level).map((b) => { const a = clamp(X(b.t0), L, L + pw); return [a, Math.max(a + 1, clamp(X(b.t1), L, L + pw))]; })
        .filter((sp) => sp[0] === sp[0] && sp[1] === sp[1]).sort((p, q) => p[0] - q[0]);
      for (let i = 0; i < spans.length;) {
        let j = i, end = spans[i][1];
        while (j + 1 < spans.length && spans[j + 1][0] <= end) end = Math.max(end, spans[++j][1]);
        s += `<rect class="band ${level === 4 ? 'c' : 'w'}" x="${spans[i][0].toFixed(1)}" y="${T}" width="${(end - spans[i][0]).toFixed(1)}" height="${ph}"/>`;
        i = j + 1;
      }
    }
    for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="${v ? 'grid' : 'axis'}" x1="${L}" x2="${W - R}" y1="${Y(v) + 0.5}" y2="${Y(v) + 0.5}"/><text class="tick" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    const nt = clamp(Math.floor(pw / 150), 2, 8);
    for (let i = 0; i <= nt; i++) { const tv = t0 + ((t1 - t0) * i) / nt; s += `<text class="tick" x="${X(tv)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nt ? 'end' : 'middle'}">${fmtTime(tv, false).slice(t1 - t0 > 36 * 3600e3 ? 5 : 11, 16)}</text>`; }
    const taken = new Set();
    for (const m of o.marks) {
      if (!(m.t >= t0 && m.t <= t1)) continue;
      const cls = m.kind === 'report' ? 'rep' : 'run', at = X(m.t), x = at.toFixed(1), spot = `${cls}:${Math.round(at / 4)}`;
      if (taken.has(spot)) continue;
      taken.add(spot);
      s += `<g class="mark ${cls}"><line x1="${x}" x2="${x}" y1="${T}" y2="${T + ph}"/><path d="M${x - 4},${T - 7}h8l-4,7z"/></g>`;
    }
    for (const sr of series) {
      let d = '', pen = false;
      for (const i of ok) { const v = sr.v[i]; if (v !== v) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(t[i]).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }
      s += `<path class="ln ${sr.cls}" d="${d}"/>`;
    }
    s += `<line class="cross" y1="${T}" y2="${T + ph}" visibility="hidden"/>${series.map((sr) => `<circle class="dot ${sr.cls}" r="4" visibility="hidden"/>`).join('')}<rect class="brush" y="${T}" height="${ph}" width="0" visibility="hidden"/></svg>`;
    el.innerHTML = (series.length > 1 ? `<div class="legend">${series.map((sr) => `<span><i class="key ${sr.cls}"></i>${esc(sr.name)}</span>`).join('')}<span class="dim">${esc(o.unit)}</span></div>` : '') + `${s}<div class="tip" hidden></div>`;
    const svg = $('svg', el), tip = $('.tip', el), cross = $('.cross', el), dots = [...el.querySelectorAll('.dot')];
    const nearest = (tv) => { let best = ok[0]; for (const i of ok) if (Math.abs(t[i] - tv) < Math.abs(t[best] - tv)) best = i; return best; };
    const unit = (v) => (o.unit === 'MB' ? `${fmtN(v)} MB` : o.unit === '%' ? `${v}%` : fmtN(v));
    chartPointer(el, svg, L, pw, t0, t1, (tv) => {
      if (tv == null) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); return; }
      const i = nearest(tv), x = X(t[i]);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tipHead(tip, fmtTime(t[i], false));
      series.forEach((sr, k) => {
        const v = sr.v[i];
        tipRow(tip, `key ${sr.cls}`, v === v ? unit(v) : 'no sample', sr.name);
        dots[k].setAttribute('visibility', v === v ? 'visible' : 'hidden');
        if (v === v) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(v)); }
      });
      const near = ((t1 - t0) / pw) * 7;                // events within a few pixels of the pointer
      const close = o.marks.filter((m) => Math.abs(m.t - tv) <= near);
      for (const m of close.slice(0, 6)) tipRow(tip, `mk ${m.kind === 'report' ? 'rep' : 'run'}`, fmtTime(m.t, false).slice(11), m.text);
      if (close.length > 6) { const row = document.createElement('div'); row.textContent = `and ${fmtN(close.length - 6)} more`; tip.append(row); }
      for (const level of [2, 4]) if (o.bands.some((b) => b.level === level && tv >= b.t0 && tv <= b.t1)) tipRow(tip, `bd ${level === 4 ? 'c' : 'w'}`, PRESSURE[level], 'memory pressure');
      tip.hidden = false;
      tip.style.left = `${clamp(x + 14, 0, W - tip.offsetWidth - 4)}px`;
    }, (tv) => t[nearest(tv)]);
  }
  function countChart(el, a) {                          // how many entries were logged in each slice of time
    const W = el.clientWidth || 800, H = 150, L = 56, R = 14, T = 12, B = 24, pw = W - L - R, ph = H - T - B, bw = pw / a.nb;
    const max = maxOf(a.bins, 1), step = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(Math.max(max, 4) / 4))).find((x) => max / x <= 5) || max;
    const top = Math.max(1, Math.ceil(max / step) * step), Y = (v) => T + ph - (v / top) * ph;
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Number of log entries tagged memory over time">`;
    for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="${v ? 'grid' : 'axis'}" x1="${L}" x2="${W - R}" y1="${Y(v) + 0.5}" y2="${Y(v) + 0.5}"/><text class="tick" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    const nt = clamp(Math.floor(pw / 150), 2, 8), span = a.t1 - a.t0;
    for (let i = 0; i <= nt; i++) { const tv = a.t0 + (span * i) / nt; s += `<text class="tick" x="${L + (pw * i) / nt}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nt ? 'end' : 'middle'}">${fmtTime(tv, false).slice(span > 36 * 3600e3 ? 5 : 11, 16)}</text>`; }
    const w = Math.max(1, bw - (bw > 4 ? 2 : 0));
    a.bins.forEach((n, b) => { if (!n) return; const hh = Math.max(2, (n / top) * ph), r = Math.min(3, w / 2, hh), x = L + b * bw, y = T + ph - hh; s += `<path class="cbar" d="M${x.toFixed(1)},${y + hh}V${y + r}q0,${-r} ${r},${-r}h${(w - 2 * r).toFixed(1)}q${r},0 ${r},${r}V${y + hh}Z"/>`; });
    s += `<rect class="hov" y="${T}" height="${ph}" width="${bw}" visibility="hidden"/><rect class="brush" y="${T}" height="${ph}" width="0" visibility="hidden"/></svg>`;
    el.innerHTML = `${s}<div class="tip" hidden></div>`;
    const svg = $('svg', el), tip = $('.tip', el), hov = $('.hov', el);
    chartPointer(el, svg, L, pw, a.t0, a.t1, (tv, x) => {
      if (tv == null) { tip.hidden = true; hov.setAttribute('visibility', 'hidden'); return; }
      const b = clamp(Math.floor(((tv - a.t0) / span) * a.nb), 0, a.nb - 1);
      hov.setAttribute('x', L + b * bw); hov.setAttribute('visibility', 'visible');
      tipHead(tip, `${fmtTime(a.t0 + (span * b) / a.nb, false)} to ${fmtTime(a.t0 + (span * (b + 1)) / a.nb, false).slice(11)}`);
      tipRow(tip, 'key c1', fmtN(a.bins[b]), a.bins[b] === 1 ? 'entry tagged memory' : 'entries tagged memory');
      tip.hidden = false;
      tip.style.left = `${clamp(x + 14, 0, W - tip.offsetWidth - 4)}px`;
    });
  }
  async function jumpTo(t) {                            // open the timeline at a moment, widening the window if needed
    if ((S.t0 != null && t < S.t0) || (S.t1 != null && t > S.t1)) { S.t0 = S.t1 = null; $('#banner').hidden = true; await runQuery(); }
    showTab('timeline');
    const k = await call('seek', { t });
    setTop(k - 3);
    select(k, false);
  }
  $('#memory').addEventListener('click', (e) => {
    const d = e.target.dataset;
    if (d.t) jumpTo(+d.t);
    else if (d.i) openFile(+d.i);
    else if (d.act === 'memtag') { S.facets.tag = { inc: [info.names.tag.indexOf('memory')], exc: [] }; showTab('timeline'); schedule(); }
  });

  // ---------- wiring ----------
  $('#q').addEventListener('input', (e) => { S.text = e.target.value; schedule(250); });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.text = e.target.value; schedule(); vs.focus(); } });
  $('#caseSens').addEventListener('change', (e) => { S.cs = e.target.checked; schedule(); });
  $('#clear').addEventListener('click', clearFilters);
  $('#prevErr').addEventListener('click', (e) => { if (e.detail > 0) vs.focus({ preventScroll: true }); nextSev(-1); });
  $('#nextErr').addEventListener('click', (e) => { if (e.detail > 0) vs.focus({ preventScroll: true }); nextSev(1); });
  $('#pinnedOnly').addEventListener('click', () => { S.pinnedOnly = !S.pinnedOnly; updatePins(); schedule(); });
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async function exportEntries(positions) {             // the entries shown, or just the given ones (pins)
    const n = positions ? positions.length : view.count;
    if (!n) return flash('Nothing to export');
    try {
      download(await call('exportTsv', { positions }), `${info.name}_${positions ? 'pinned' : 'filtered'}.tsv`);
      flash(`Exported ${fmtN(n)} entries`);
    } catch (e) { if (e.message !== 'superseded') flash(e.message); }
    $('#searchbar').hidden = true;
    $('#count').textContent = `${fmtN(view.count)} of ${fmtN(view.total)} entries`;
  }
  $('#export').addEventListener('click', () => exportEntries(null));

  // ---------- File menu ----------
  function saveView() {                                 // search, filters, window and pins; no log text
    const named = (name, ids) => ids.map((i) => info.names[name][i]);
    const v = { app: 'excel-diagnostics-viewer', version: 1, saved: new Date().toISOString(), bundle: info.name, total: info.total,
      text: S.text, matchCase: S.cs, timeZone: tzMode, from: S.t0, to: S.t1,
      filters: Object.fromEntries(Object.entries(S.facets).filter(([, f]) => f.inc.length || f.exc.length).map(([n, f]) => [n, { show: named(n, f.inc), hide: named(n, f.exc) }])),
      pins: [...pins.keys()].sort((a, b) => a - b), pinnedOnly: S.pinnedOnly, selected: selPos };
    download(new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' }), `${info.name}.view.json`);
    flash('View saved');
  }
  function applyView(v) {
    if (!v || v.app !== 'excel-diagnostics-viewer') return flash('That file is not a saved view');
    const same = v.bundle === info.name && v.total === info.total;      // pins point at entries by position, so only for the same bundle
    S.text = String(v.text || ''); S.cs = !!v.matchCase;
    $('#q').value = S.text; $('#caseSens').checked = S.cs;
    S.facets = {};
    for (const [name, sel] of Object.entries(v.filters || {})) {
      const names = info.names[name];
      if (!names || !sel || name === 'sev') continue;
      const ids = (list) => (Array.isArray(list) ? list : []).map((x) => names.indexOf(x)).filter((i) => i >= 0);
      const f = { inc: ids(sel.show), exc: ids(sel.hide) };
      if (f.inc.length || f.exc.length) S.facets[name] = f;
    }
    const old = v.filters && v.filters.sev;               // a view saved when Severity and the logs' own levels were separate lists
    if (old) {
      const ids = (list) => (Array.isArray(list) ? list : []).flatMap((x) => levelsOf(SEV.indexOf(x)));
      const f = S.facets.lvl || (S.facets.lvl = { inc: [], exc: [] });
      f.inc = [...new Set(f.inc.concat(ids(old.show)))]; f.exc = [...new Set(f.exc.concat(ids(old.hide)))];
    }
    S.t0 = typeof v.from === 'number' ? v.from : null; S.t1 = typeof v.to === 'number' ? v.to : null;
    if (['bundle', 'utc', 'browser'].includes(v.timeZone)) { tzMode = v.timeZone; tzFell = false; tzOptions(); redrawTimes(); }
    pins.clear();
    if (same && Array.isArray(v.pins)) for (const p of v.pins) if (Number.isInteger(p) && p >= 0 && p < info.total) pins.set(p, true);
    S.pinnedOnly = !!v.pinnedOnly && pins.size > 0;
    selPos = same && Number.isInteger(v.selected) ? v.selected : null;
    updatePins();
    $('#banner').hidden = true; $('#detail').hidden = true;
    showTab('timeline');
    schedule();
    flash(same ? 'View loaded' : `View loaded without its pins: it was saved from ${v.bundle}`);
  }
  $('#pickView').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { applyView(JSON.parse(await f.text())); } catch (err) { flash('That file is not a saved view'); }
  });
  function closeBundle() {
    if (worker) worker.terminate();
    worker = null; info = null;
    setTimeout(sweepTemp, 600);
    $('#app').hidden = true; $('#landing').hidden = false;
    document.title = 'Excel diagnostics viewer';
  }
  const fileBtn = $('#fileBtn'), menuList = $('#fileMenu .menulist');
  const menuItem = (cmd) => $(`[data-cmd="${cmd}"]`, menuList);
  function showMenu(open) {
    if (open) {                                         // say what each item would act on right now
      const openFileShown = currentTab() === 'files' && openState ? info.files[openState.i] : null;
      menuItem('export').disabled = !view.count;
      menuItem('export').lastElementChild.textContent = `${fmtN(view.count)} as .tsv`;
      menuItem('exportPins').disabled = !pins.size;
      menuItem('exportPins').lastElementChild.textContent = pins.size ? `${fmtN(pins.size)} as .tsv` : 'none pinned';
      menuItem('saveFile').disabled = !openFileShown;
      menuItem('saveFile').lastElementChild.textContent = openFileShown ? openFileShown.path.slice(openFileShown.path.lastIndexOf('/') + 1) : 'open one under Files';
    }
    menuList.hidden = !open;
    fileBtn.setAttribute('aria-expanded', String(open));
    if (open) menuList.querySelector('button:not(:disabled)').focus();
  }
  fileBtn.addEventListener('click', () => showMenu(menuList.hidden));
  document.addEventListener('pointerdown', (e) => { if (!menuList.hidden && !e.target.closest('#fileMenu')) showMenu(false); });
  menuList.addEventListener('keydown', (e) => {
    const items = [...menuList.querySelectorAll('button:not(:disabled)')], at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { showMenu(false); fileBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
  });
  menuList.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    showMenu(false);
    switch (b.dataset.cmd) {
      case 'open': $('#pickFiles').click(); break;
      case 'openDir': $('#pickDir').click(); break;
      case 'sample': start(null, true); break;
      case 'saveView': saveView(); break;
      case 'loadView': $('#pickView').click(); break;
      case 'export': exportEntries(null); break;
      case 'exportPins': exportEntries([...pins.keys()].sort((x, y) => x - y)); break;
      case 'saveFile': {
        const f = info.files[openState.i];
        try { download(await call('fileBlob', { i: f.i }), f.path.slice(f.path.lastIndexOf('/') + 1)); } catch (err) { flash(err.message); }
        break;
      }
      case 'script': showScript(); break;
      case 'cli': showCli(); break;
      case 'close': closeBundle(); break;
    }
  });

  // ---------- the collector script: the page carries a copy, so this works offline and asks no server ----------
  const scriptSource = () => $('#collector-src').textContent;
  const downloadScript = () => download(new Blob([scriptSource()], { type: 'text/x-shellscript' }), 'excel_diagnostics.sh');
  function showScript() {
    const pre = $('#scriptText');
    if (!pre.firstChild) {
      const t = scriptSource();
      pre.textContent = t;
      $('#scriptMeta').textContent = `${fmtN(t.split('\n').length - 1)} lines, ${Math.round(t.length / 1024)} KB`;
    }
    $('#scriptDlg').showModal();
    pre.scrollTop = 0;
  }
  const blip = (b, text) => {                           // a flash would sit behind the dialog, so the button answers instead
    if (!b.dataset.label) b.dataset.label = b.textContent;
    b.textContent = text;
    clearTimeout(b.t); b.t = setTimeout(() => { b.textContent = b.dataset.label; }, 1600);
  };
  $('#btnScript').addEventListener('click', () => { downloadScript(); flash('Downloading excel_diagnostics.sh'); });
  $('#btnScriptView').addEventListener('click', showScript);
  $('#scriptSave').addEventListener('click', (e) => { downloadScript(); blip(e.currentTarget, 'Saved'); });
  $('#scriptCopy').addEventListener('click', (e) => {
    const b = e.currentTarget;
    (navigator.clipboard ? navigator.clipboard.writeText(scriptSource()) : Promise.reject()).then(() => blip(b, 'Copied'), () => blip(b, 'Blocked'));
  });
  $('#scriptClose').addEventListener('click', () => $('#scriptDlg').close());

  // ---------- the command-line tool: the engine this page already holds, between the tool's own two ends ----------
  const cliSource = () => $('#cli-head-src').textContent + $('#core-src').textContent.replace(/^\n/, '') + $('#cli-src').textContent;
  const downloadCli = () => download(new Blob([cliSource()], { type: 'text/javascript' }), 'excel_diagnostics_cli.mjs');
  function showCli() {
    const t = cliSource();
    $('#cliMeta').textContent = `one file, ${Math.round(new Blob([t]).size / 1024)} KB`;
    $('#cliDlg').showModal();
  }
  $('#btnCli').addEventListener('click', () => { downloadCli(); flash('Downloading excel_diagnostics_cli.mjs'); });
  $('#btnCliView').addEventListener('click', showCli);
  $('#cliSave').addEventListener('click', (e) => { downloadCli(); blip(e.currentTarget, 'Saved'); });
  $('#cliCopy').addEventListener('click', (e) => {
    const b = e.currentTarget;
    (navigator.clipboard ? navigator.clipboard.writeText($('#cliCurl').textContent) : Promise.reject()).then(() => blip(b, 'Copied'), () => blip(b, 'Blocked'));
  });
  $('#cliClose').addEventListener('click', () => $('#cliDlg').close());
  $('#help').addEventListener('click', () => $('#helpDlg').showModal());
  $('#facets').addEventListener('click', (e) => {
    const fv = e.target.closest('.fv');
    if (!fv) return;
    const mode = e.target.closest('.x') || e.altKey ? 'exc' : 'inc';
    // A click made with the mouse (detail > 0) hands the keyboard back to the list, so that Enter then opens the
    // selected entry as it always did; one made with the keyboard stays where it is.
    if (e.detail > 0) vs.focus({ preventScroll: true });
    if (fv.dataset.sev !== undefined) toggleSeverity(+fv.dataset.sev, mode); else toggleFacet(fv.closest('details').dataset.f, +fv.dataset.v, mode);
  });
  $('#facets').addEventListener('toggle', (e) => { const n = e.target.dataset && e.target.dataset.f; if (n) { if (e.target.open) openFacets.add(n); else openFacets.delete(n); } }, true);
  function toggleSide() {                               // show or hide the filter list; in a narrow window it opens over the entries
    $('#tab-timeline').classList.toggle('nofacets');
    const shown = sideShown();
    if (shown && matchMedia('(max-width: 820px)').matches) $('#sideClose').focus(); else if (!shown) $('#facetToggle').focus();
  }
  function sideShown() { const shown = getComputedStyle($('#side')).display !== 'none'; $('#facetToggle').setAttribute('aria-expanded', String(shown)); return shown; }
  $('#facetToggle').addEventListener('click', toggleSide);
  $('#sideClose').addEventListener('click', toggleSide);
  for (const id of ['tFrom', 'tTo']) {
    $('#' + id).addEventListener('change', () => {
      const a = parseTime($('#tFrom').value), b = parseTime($('#tTo').value);
      if (a !== a || b !== b || b <= a) { flash('Use YYYY-MM-DD HH:MM:SS, with the start before the end'); renderRange(); return; }
      setRange(a, b);
    });
  }
  $('#allTime').addEventListener('click', () => { S.t0 = S.t1 = null; $('#banner').hidden = true; schedule(); });
  $('#bannerAll').addEventListener('click', () => { S.t0 = S.t1 = null; $('#banner').hidden = true; schedule(); });
  $('#bannerClose').addEventListener('click', () => { $('#banner').hidden = true; layout(); setTop(topRow); });
  $('#zoomOut').addEventListener('click', () => {
    const t0 = S.t0 != null ? S.t0 : info.t0, t1 = S.t1 != null ? S.t1 : info.end, half = (t1 - t0) / 2;
    setRange(t0 - half, t1 + half);
  });
  function redrawTimes() {                              // everything on the page that shows a time
    requestRender(); if (view.hist) drawHist(); renderRange(); renderOverview();
    if (selPos != null && !$('#detail').hidden) showDetail(selPos);
    if (currentTab() === 'memory') drawMemory();
    buildReports(); if (repOpen) openReport(info.reports.findIndex((r) => r.path === repOpen), true);
  }
  $('#tz').addEventListener('change', (e) => { tzMode = e.target.value; tzFell = false; redrawTimes(); });
  document.querySelector('.tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
  $('#tree').addEventListener('click', (e) => { const a = e.target.closest('.tf'); if (a) openFile(+a.dataset.i); });
  $('#treeFilter').addEventListener('input', (e) => buildTree(e.target.value));
  const resized = new ResizeObserver(() => { if (!info || $('#app').hidden) return; if (currentTab() === 'timeline') { sideShown(); layout(); setTop(topRow); clearTimeout(drawHist.t); drawHist.t = setTimeout(() => { if (view.hist && Math.abs(clamp(Math.floor($('#hist').clientWidth / 8), 30, 240) - view.hist.nb) > 8) schedule(); else drawHist(); }, 150); } else if (currentTab() === 'memory') drawMemory(); });
  resized.observe(document.body);
  resized.observe($('#hist'));                          // its width also changes when the filter menu is shown or hidden

  document.addEventListener('keydown', (e) => {
    if (!info || $('#app').hidden || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]') || !$('#fileMenu .menulist').hidden) return;
    if (e.target.matches && e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (currentTab() !== 'timeline') return;
    // Enter on a button, a link or a group heading belongs to that control, not to the list
    if (e.key === 'Enter' && e.target.closest && e.target.closest('button, summary, a[href]')) return;
    if (e.key === 'Escape' && $('#tab-timeline').classList.contains('nofacets') && e.target.closest && e.target.closest('#side')) { toggleSide(); return; }
    const page = visibleRows() - 1;
    const keys = { '/': () => $('#q').focus(), ArrowDown: () => moveSel(1), j: () => moveSel(1), ArrowUp: () => moveSel(-1), k: () => moveSel(-1), PageDown: () => moveSel(page), PageUp: () => moveSel(-page),
      Home: () => select(0, false), End: () => select(view.count - 1, false), Enter: () => { if (selPos != null) showDetail(selPos); }, Escape: closeDetail,
      e: () => nextSev(1), E: () => nextSev(-1), p: () => { const d = $('#detail')._row; if (selPos != null && d && d.row[0] === selPos) { togglePin(d.row); if (!$('#detail').hidden) showDetail(selPos); } else if (selIndex >= 0) rowReady(selIndex).then(togglePin); },
      c: () => { if (filtersActive()) clearFilters(); } };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  // ---------- opening bundles ----------
  async function fromDrop(dt) {
    const entries = [...dt.items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...dt.files].map((f) => ({ path: f.name, blob: f }));
    const out = [];
    const walk = async (en, prefix) => {
      if (en.isFile) out.push({ path: prefix + en.name, blob: await new Promise((res, rej) => en.file(res, rej)) });
      else {
        const rd = en.createReader();
        for (;;) { const batch = await new Promise((res, rej) => rd.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c, `${prefix}${en.name}/`); }
      }
    };
    for (const en of entries) await walk(en, '');
    return out;
  }
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('drag'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drag'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('drag');
    try { start(await fromDrop(e.dataTransfer)); } catch (err) { fail(`Could not read what was dropped: ${err.message || err}`); }
  });
  const picked = (e) => { start([...e.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }))); e.target.value = ''; };
  $('#pickFiles').addEventListener('change', picked);
  $('#pickDir').addEventListener('change', picked);
  $('#btnFiles').addEventListener('click', () => $('#pickFiles').click());
  $('#btnDir').addEventListener('click', () => $('#pickDir').click());
  $('#btnSample').addEventListener('click', () => start(null, true));
  window.logViewer = { load: (inputs) => start(inputs), sample: () => start(null, true), state: () => ({ S, view, info, selPos, selIndex, topRow }) };
})();
