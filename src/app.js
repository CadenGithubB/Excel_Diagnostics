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
    const mem = info.files.find((f) => /(^|\/)excel_memory_timeline\.csv$/.test(f.path));
    $('[data-tab="memory"]').hidden = !mem;
    buildTree(''); renderOverview(); updatePins();
    showTab(info.total ? 'timeline' : 'files');
    $('#noRows').hidden = !!info.total;
    if (mem) loadMemory(mem);
    runQuery();
  }

  // ---------- tabs ----------
  function showTab(name) {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === name);
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
    drawHist(); renderFacets(); renderRange(); layout();
    if (selPos != null && r.anchorIndex != null && r.count) {
      selIndex = r.anchorExact ? r.anchorIndex : -1;
      setTop(r.anchorIndex - Math.floor(visibleRows() / 2));
    } else { selIndex = -1; setTop(0); }
  }
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
  const FACETS = [['sev', 'Severity', 'level'], ['group', 'Source', 'source'], ['tag', 'Tag', 'tag'], ['proc', 'Process', 'process'],
    ['sub', 'Subsystem / area', 'subsystem'], ['cat', 'Category', 'category'], ['lvl', 'Original level', 'level'], ['file', 'File', 'file']];
  const openFacets = new Set();                         // every group starts collapsed; a badge shows how many values are chosen
  function renderFacets() {
    let html = '';
    for (const [name, title, field] of FACETS) {
      const f = lastFacets[name];
      if (!f || !f.values.length) continue;
      const sel = S.facets[name] || { inc: [], exc: [] }, nSel = sel.inc.length + sel.exc.length;
      html += `<details data-f="${name}"${openFacets.has(name) ? ' open' : ''}><summary>${title}${nSel ? `<b>${nSel}</b>` : ''}</summary>`;
      for (const [v, n] of f.values) {
        const full = info.names[name][v] || '(none)', label = name === 'file' ? full.slice(full.lastIndexOf('/') + 1) : full;
        const cls = (sel.inc.includes(v) ? ' inc' : sel.exc.includes(v) ? ' exc' : '') + (name === 'sev' ? ` s${v}` : '');
        html += `<div class="fv${cls}" data-v="${v}" title="${esc(full)}&#10;Click to show only this. Click &minus; to hide it."><span class="lbl">${name === 'sev' ? '<i></i>' : ''}${esc(label)}</span>` +
          `<span class="n">${n < 0 ? '–' : fmtN(n)}</span><button class="x" aria-label="Hide ${esc(label)}">−</button></div>`;
      }
      if (f.all > f.values.length) html += `<div class="more">${fmtN(f.all - f.values.length)} more. Type <code>${field}:text</code> in the search box to match any of them.</div>`;
      html += '</details>';
    }
    $('#facets').innerHTML = html;
  }

  // ---------- histogram ----------
  function drawHist() {
    const h = view.hist, el = $('#hist'), W = el.clientWidth, H = 92, top = 14, bottom = 18, plotH = H - top - bottom;
    if (!h || !W) return;
    const nb = h.nb, bw = W / nb;
    let max = 0;
    for (let b = 0; b < nb; b++) max = Math.max(max, h.bins[b * 3] + h.bins[b * 3 + 1] + h.bins[b * 3 + 2]);
    const base = top + plotH;
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="Number of entries over time, by severity">`;
    s += `<line class="grid" x1="0" x2="${W}" y1="${top + 0.5}" y2="${top + 0.5}"/><text class="tick" x="2" y="${top - 4}">${max ? fmtN(max) + ' per bar' : 'No entries in this window'}</text>`;
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
    s += `<rect id="histHover" class="hov" y="${top}" height="${plotH}" width="${bw}" visibility="hidden"/><rect id="histBrush" class="brush" y="${top}" height="${plotH}" width="0" visibility="hidden"/></svg>`;
    el.innerHTML = s;
  }
  (function histEvents() {
    const el = $('#hist'), tip = $('#histTip');
    let down = null;
    const at = (e) => { const r = el.getBoundingClientRect(); return clamp(e.clientX - r.left, 0, r.width); };
    el.addEventListener('pointerdown', (e) => { if (!view.hist) return; down = at(e); el.setPointerCapture(e.pointerId); });
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
      for (const [n, cls, name] of [[er, 'be', 'errors and faults'], [wn, 'bw', 'warnings'], [o, 'bo', 'other entries']]) {
        const row = document.createElement('div');
        row.innerHTML = `<i class="${cls}"></i><b>${fmtN(n)}</b> ${name}`;
        tip.append(row);
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
  function renderRange() {
    const t0 = S.t0 != null ? S.t0 : info.t0, t1 = S.t1 != null ? S.t1 : info.t1;
    $('#tFrom').value = fmtTime(t0, false);
    $('#tTo').value = fmtTime(t1, false);
    $('#tzNote').textContent = `${tzLabel(t0)} · ${fmtSpan(t1 - t0)}`;
    $('#allTime').disabled = S.t0 == null && S.t1 == null;
    $('#zoomOut').disabled = S.t0 == null && S.t1 == null;
  }
  function setRange(t0, t1) {
    if (t0 != null && t1 != null && t1 <= t0) return;
    S.t0 = t0 != null && t0 <= info.t0 ? null : t0;
    S.t1 = t1 != null && t1 > info.t1 ? null : t1;
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
      const sev = info.lvlSev[r[3]], src = info.sources[r[2]];
      html += `<div class="r s${sev}${r[0] === selPos ? ' sel' : ''}" data-k="${k}">` +
        `<span class="c t">${pins.has(r[0]) ? '<b class="pin" title="Pinned">★</b>' : ''}${fmtTime(r[1])}</span>` +
        `<span class="c sv"><i></i>${SEV[sev]}</span>` +
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
      ['Severity', `<span class="sv s${sev}"><i></i>${SEV[sev]}</span>${N.lvl[r[3]] && N.lvl[r[3]] !== SEV[sev] ? ` <span class="dim">logged as ${esc(N.lvl[r[3]])}</span>` : ''}${filt('sev', sev)}`],
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
    el.innerHTML = `<div class="dbar">
        <button data-act="pin">${pins.has(pos) ? '★ Unpin' : '☆ Pin'}</button>
        <button data-act="context" ${filtersActive() ? '' : 'disabled'} title="Clear the filters but stay on this entry">Show in context</button>
        <span class="grp">Zoom to <button data-act="win" data-w="5000">±5 s</button><button data-act="win" data-w="60000">±1 min</button><button data-act="win" data-w="600000">±10 min</button></span>
        <button data-act="copy">Copy line</button>
        ${fileIdx >= 0 ? `<button data-act="file" data-i="${fileIdx}">${d.extra && d.extra.file ? 'Open report' : 'Open file'}</button>` : ''}
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
  }

  // ---------- files tab ----------
  function buildTree(filter) {
    const el = $('#tree'), f = filter.trim().toLowerCase();
    const link = (x, label) => `<a class="tf${x.src >= 0 && x.rows ? ' src' : ''}" data-i="${x.i}" title="${esc(x.path)}"><span>${esc(label)}</span><span class="n">${fmtBytes(x.size)}</span></a>`;
    if (f) {
      const hits = info.files.filter((x) => x.path.toLowerCase().includes(f));
      el.innerHTML = hits.slice(0, 500).map((x) => link(x, x.path)).join('') + (hits.length > 500 ? `<div class="more">${fmtN(hits.length - 500)} more matches</div>` : '') || '<div class="more">No files match.</div>';
      return;
    }
    const root = { dirs: new Map(), files: [], count: 0 };
    for (const x of info.files) {
      const parts = x.path.split('/');
      let node = root;
      node.count++;
      for (let i = 0; i < parts.length - 1; i++) { if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [], count: 0 }); node = node.dirs.get(parts[i]); node.count++; }
      node.files.push(x);
    }
    const html = (node, depth) => [...node.dirs].map(([name, d]) => `<details${depth < 1 && d.count <= 60 ? ' open' : ''}><summary>${esc(name)}<span class="n">${fmtN(d.count)}</span></summary><div class="kids">${html(d, depth + 1)}</div></details>`).join('') +
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
    for (const a of document.querySelectorAll('#tree a.on')) a.classList.remove('on');
    const a = $(`#tree a[data-i="${i}"]`);
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
    if (/\.md$/i.test(f.path)) body.innerHTML = `<div class="doc">${md(state.text)}</div>`;
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

  // ---------- small markdown renderer (summary.md, incident_context.md) ----------
  function md(src) {
    const lines = src.split(/\r?\n/), inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    let out = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const h = /^(#{1,6}) (.*)$/.exec(l);
      if (h) { out += `<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`; i++; continue; }
      if (l.startsWith('|')) {
        const rows = [];
        while (i < lines.length && lines[i].startsWith('|')) { if (!/^\|[\s:|-]+$/.test(lines[i])) rows.push(lines[i].replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim())); i++; }
        out += `<table><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        continue;
      }
      const li = /^\s*([-*]|\d+\.) (.*)$/.exec(l);
      if (li) {
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
        out += `<${tag}>`;
        for (let m; i < lines.length && (m = /^\s*([-*]|\d+\.) (.*)$/.exec(lines[i])); i++) out += `<li>${inline(m[2])}</li>`;
        out += `</${tag}>`;
        continue;
      }
      if (/^ {4}/.test(l)) { let code = ''; while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) code += lines[i++].slice(4) + '\n'; out += `<pre>${esc(code.trimEnd())}</pre>`; continue; }
      let para = '';
      while (i < lines.length && lines[i].trim() && !/^(#{1,6} |\||\s*([-*]|\d+\.) )/.test(lines[i])) para += lines[i++] + ' ';
      out += `<p>${inline(para.trim())}</p>`;
    }
    return out;
  }

  // ---------- overview tab ----------
  async function renderOverview() {
    const el = $('#overview'), gen = info;
    const src = info.sources.filter((s) => s.rows);
    let html = `<div class="tiles"><div><b>${fmtN(info.total)}</b><span>timeline entries</span></div><div><b>${fmtN(src.length)}</b><span>log sources</span></div>` +
      `<div><b>${fmtN(info.files.length)}</b><span>files in the bundle</span></div><div><b>${fmtBytes(info.files.reduce((a, f) => a + f.size, 0))}</b><span>unpacked</span></div></div>`;
    for (const n of info.notes) html += `<p class="note">${esc(n)}</p>`;
    html += `<h2>Sources on the timeline</h2><div class="tbl"><table><thead><tr><th>Source</th><th>File</th><th class="num">Entries</th><th>First entry</th><th>Last entry</th><th class="num">Size</th></tr></thead><tbody>` +
      src.map((s) => `<tr><td>${esc(s.group)}</td><td><a data-src="${s.id}" title="Show only this file on the timeline">${esc(s.path)}</a></td><td class="num">${fmtN(s.rows)}</td><td>${fmtTime(s.t0, false)}</td><td>${fmtTime(s.t1, false)}</td><td class="num">${fmtBytes(s.size)}</td></tr>`).join('') +
      `</tbody></table></div><p class="dim">Times are shown in ${tzMode === 'utc' ? 'UTC' : tzMode === 'bundle' ? "the Mac's own time zone" : "this computer's time zone"}.</p><div id="docs"></div>`;
    el.innerHTML = html;
    const docs = [['summary.md', 'Collector summary', true], ['case/incident_context.md', 'Incident context', true], ['reports/crash_summary.txt', 'Crash and hang report summary', true],
      ['unified_logs/collection_status.txt', 'Unified log collection status', true], ['office/versions.txt', 'Office versions', false], ['system/system_info.txt', 'System information', false], ['collection.log', 'Collection log', false]];
    for (const [path, title, open] of docs) {
      const f = info.files.find((x) => x.path === path);
      if (!f || !f.size) continue;
      const got = await call('fileChunk', { i: f.i, offset: 0, len: 256 << 10 });
      if (info !== gen) return;
      const text = new TextDecoder().decode(got.bytes), d = document.createElement('details');
      d.open = open;
      d.innerHTML = `<summary>${esc(title)} <span class="dim">${esc(path)}</span></summary><div class="doc">${/\.md$/.test(path) ? md(text) : `<pre>${esc(text)}</pre>`}</div>`;
      $('#docs').append(d);
    }
  }
  $('#overview').addEventListener('click', (e) => {
    if (e.target.dataset.src) { S.facets = { file: { inc: [+e.target.dataset.src], exc: [] } }; S.text = ''; $('#q').value = ''; S.t0 = S.t1 = null; showTab('timeline'); schedule(); }
  });

  // ---------- memory tab (watch / repro modes write excel_memory_timeline.csv) ----------
  let mem = null;
  async function loadMemory(f) {
    const gen = info, got = await call('fileChunk', { i: f.i, offset: 0, len: 16 << 20 });
    if (info !== gen) return;
    const lines = new TextDecoder().decode(got.bytes).split(/\r?\n/).filter(Boolean), head = lines[0].split(','), col = (n) => head.indexOf(n);
    const rows = lines.slice(1).map((l) => l.split(','));
    const num = (n) => rows.map((r) => (r[col(n)] === '' || r[col(n)] == null ? NaN : +r[col(n)]));
    mem = { file: f, t: rows.map((r) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(r[col('utc_time')] || ''); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; }),
      pid: rows.map((r) => r[col('excel_pid')] || ''), foot: num('excel_footprint_mb'), cmp: num('excel_compressed_mb'), cpu: num('excel_cpu_pct'),
      level: num('pressure_level'), free: num('free_mb'), comp: num('compressor_mb'), swap: num('swap_used_mb') };
    if (currentTab() === 'memory') drawMemory();
  }
  function drawMemory() {
    if (!mem) return;
    const el = $('#memory'), events = [], LV = { 1: 'normal', 2: 'warning', 4: 'critical' };
    for (let i = 1; i < mem.t.length; i++) {
      if (mem.pid[i] !== mem.pid[i - 1]) events.push([mem.t[i], !mem.pid[i] ? `Excel stopped running (was PID ${mem.pid[i - 1]}): quit, crash or force-quit` : !mem.pid[i - 1] ? `Excel started (PID ${mem.pid[i]})` : `Excel was relaunched (PID ${mem.pid[i - 1]} to ${mem.pid[i]})`]);
      if (mem.level[i] !== mem.level[i - 1] && mem.level[i] === mem.level[i]) events.push([mem.t[i], `Memory pressure changed to ${LV[mem.level[i]] || mem.level[i]}`]);
    }
    const peak = Math.max(...mem.foot.filter((v) => v === v), 0);
    el.innerHTML = `<p class="dim">${fmtN(mem.t.length)} samples from <a data-i="${mem.file.i}">${esc(mem.file.path)}</a> (opens as a table). Click a chart to jump to that moment on the timeline.</p>
      <div class="tiles"><div><b>${fmtN(peak)} MB</b><span>peak Excel footprint</span></div><div><b>${fmtN(events.filter((e) => /stopped|relaunched/.test(e[1])).length)}</b><span>times Excel stopped or restarted</span></div>
      <div><b>${LV[Math.max(...mem.level.filter((v) => v === v), 1)] || '?'}</b><span>highest memory pressure</span></div></div>
      <h2>Excel memory</h2><div class="chart" id="ch1"></div><h2>System memory</h2><div class="chart" id="ch2"></div>
      <h2>Events</h2>${events.length ? `<ul class="events">${events.map(([t, m]) => `<li><a data-t="${t}">${fmtTime(t, false)}</a> ${esc(m)}</li>`).join('')}</ul>` : '<p class="dim">Excel kept the same PID and memory pressure did not change.</p>'}`;
    lineChart($('#ch1'), mem.t, [{ name: 'Physical footprint', cls: 'c1', v: mem.foot }, { name: 'Compressed', cls: 'c2', v: mem.cmp }]);
    lineChart($('#ch2'), mem.t, [{ name: 'Free', cls: 'c1', v: mem.free }, { name: 'Held by the compressor', cls: 'c2', v: mem.comp }, { name: 'Swap used', cls: 'c3', v: mem.swap }]);
  }
  function lineChart(el, t, series) {
    const W = el.clientWidth || 800, H = 230, L = 56, R = 14, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
    const ok = t.map((v, i) => (v === v ? i : -1)).filter((i) => i >= 0);
    if (!ok.length) { el.textContent = 'No samples.'; return; }
    const t0 = t[ok[0]], t1 = Math.max(t[ok[ok.length - 1]], t0 + 1);
    let max = 1;
    for (const s of series) for (const v of s.v) if (v > max) max = v;
    const step = [1, 2, 2.5, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(max / 4))).find((x) => max / x <= 5) || max;
    const top = Math.ceil(max / step) * step, X = (v) => L + ((v - t0) / (t1 - t0)) * pw, Y = (v) => T + ph - (v / top) * ph;
    let s = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(series.map((x) => x.name).join(', '))} in megabytes over time">`;
    for (let v = 0; v <= top + 1e-9; v += step) s += `<line class="${v ? 'grid' : 'axis'}" x1="${L}" x2="${W - R}" y1="${Y(v) + 0.5}" y2="${Y(v) + 0.5}"/><text class="tick" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtN(v)}</text>`;
    const nt = clamp(Math.floor(pw / 150), 2, 8);
    for (let i = 0; i <= nt; i++) { const tv = t0 + ((t1 - t0) * i) / nt; s += `<text class="tick" x="${X(tv)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === nt ? 'end' : 'middle'}">${fmtTime(tv, false).slice(t1 - t0 > 36 * 3600e3 ? 5 : 11, 16)}</text>`; }
    for (const sr of series) {
      let d = '', pen = false;
      for (const i of ok) { const v = sr.v[i]; if (v !== v) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(t[i]).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }
      s += `<path class="ln ${sr.cls}" d="${d}"/>`;
    }
    s += `<line class="cross" y1="${T}" y2="${T + ph}" visibility="hidden"/>${series.map((sr) => `<circle class="dot ${sr.cls}" r="4" visibility="hidden"/>`).join('')}</svg>`;
    el.innerHTML = `<div class="legend">${series.map((sr) => `<span><i class="key ${sr.cls}"></i>${esc(sr.name)}</span>`).join('')}<span class="dim">MB</span></div>${s}<div class="tip" hidden></div>`;
    const svg = $('svg', el), tip = $('.tip', el), cross = $('.cross', el), dots = [...el.querySelectorAll('.dot')];
    const nearest = (e) => { const x = e.clientX - svg.getBoundingClientRect().left, tv = t0 + ((x - L) / pw) * (t1 - t0); let best = ok[0]; for (const i of ok) if (Math.abs(t[i] - tv) < Math.abs(t[best] - tv)) best = i; return best; };
    svg.addEventListener('pointermove', (e) => {
      const i = nearest(e), x = X(t[i]);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tt'; head.textContent = fmtTime(t[i], false);
      tip.append(head);
      series.forEach((sr, k) => {
        const v = sr.v[i], row = document.createElement('div'), key = document.createElement('i'), val = document.createElement('b');
        key.className = `key ${sr.cls}`; val.textContent = v === v ? `${fmtN(v)} MB` : 'no sample';
        row.append(key, val, ` ${sr.name}`);
        tip.append(row);
        dots[k].setAttribute('visibility', v === v ? 'visible' : 'hidden');
        if (v === v) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(v)); }
      });
      tip.hidden = false;
      tip.style.left = `${clamp(x + 14, 0, W - tip.offsetWidth - 4)}px`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
    svg.addEventListener('click', (e) => jumpTo(t[nearest(e)]));
  }
  async function jumpTo(t) {                            // open the timeline at a moment, widening the window if needed
    if ((S.t0 != null && t < S.t0) || (S.t1 != null && t > S.t1)) { S.t0 = S.t1 = null; await runQuery(); }
    showTab('timeline');
    const k = await call('seek', { t });
    setTop(k - 3);
    select(k, false);
  }
  $('#memory').addEventListener('click', (e) => { if (e.target.dataset.t) jumpTo(+e.target.dataset.t); else if (e.target.dataset.i) openFile(+e.target.dataset.i); });

  // ---------- wiring ----------
  $('#q').addEventListener('input', (e) => { S.text = e.target.value; schedule(250); });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.text = e.target.value; schedule(); vs.focus(); } });
  $('#caseSens').addEventListener('change', (e) => { S.cs = e.target.checked; schedule(); });
  $('#clear').addEventListener('click', clearFilters);
  $('#prevErr').addEventListener('click', () => nextSev(-1));
  $('#nextErr').addEventListener('click', () => nextSev(1));
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
      if (!names || !sel) continue;
      const ids = (list) => (Array.isArray(list) ? list : []).map((x) => names.indexOf(x)).filter((i) => i >= 0);
      const f = { inc: ids(sel.show), exc: ids(sel.hide) };
      if (f.inc.length || f.exc.length) S.facets[name] = f;
    }
    S.t0 = typeof v.from === 'number' ? v.from : null; S.t1 = typeof v.to === 'number' ? v.to : null;
    if (['bundle', 'utc', 'browser'].includes(v.timeZone)) { tzMode = v.timeZone; $('#tz').value = tzMode; renderOverview(); }
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
  $('#help').addEventListener('click', () => $('#helpDlg').showModal());
  $('#facets').addEventListener('click', (e) => {
    const fv = e.target.closest('.fv');
    if (!fv) return;
    toggleFacet(fv.closest('details').dataset.f, +fv.dataset.v, e.target.closest('.x') || e.altKey ? 'exc' : 'inc');
  });
  $('#facets').addEventListener('toggle', (e) => { const n = e.target.dataset && e.target.dataset.f; if (n) { if (e.target.open) openFacets.add(n); else openFacets.delete(n); } }, true);
  $('#facetToggle').addEventListener('click', () => $('#tab-timeline').classList.toggle('nofacets'));
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
    const t0 = S.t0 != null ? S.t0 : info.t0, t1 = S.t1 != null ? S.t1 : info.t1, half = (t1 - t0) / 2;
    setRange(t0 - half, t1 + half);
  });
  $('#tz').addEventListener('change', (e) => { tzMode = e.target.value; requestRender(); if (view.hist) drawHist(); renderRange(); renderOverview(); if (selPos != null && !$('#detail').hidden) showDetail(selPos); if (currentTab() === 'memory') drawMemory(); });
  document.querySelector('.tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
  $('#tree').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) openFile(+a.dataset.i); });
  $('#treeFilter').addEventListener('input', (e) => buildTree(e.target.value));
  const resized = new ResizeObserver(() => { if (!info || $('#app').hidden) return; if (currentTab() === 'timeline') { layout(); setTop(topRow); clearTimeout(drawHist.t); drawHist.t = setTimeout(() => { if (view.hist && Math.abs(clamp(Math.floor($('#hist').clientWidth / 8), 30, 240) - view.hist.nb) > 8) schedule(); else drawHist(); }, 150); } else if (currentTab() === 'memory') drawMemory(); });
  resized.observe(document.body);
  resized.observe($('#hist'));                          // its width also changes when the filter menu is shown or hidden

  document.addEventListener('keydown', (e) => {
    if (!info || $('#app').hidden || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]') || !$('#fileMenu .menulist').hidden) return;
    if (e.target.matches && e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (currentTab() !== 'timeline') return;
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
