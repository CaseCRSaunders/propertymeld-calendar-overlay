// ==UserScript==
// @name         Property Meld Calendar - show started/completed jobs
// @namespace    https://stewartpm.ca/
// @version      0.2.1
// @description  Property Meld's calendar drops a job once it is started/completed early. This redraws those appointments as clickable blocks that open the meld.
// @match        https://app.propertymeld.com/*
// @homepageURL  https://github.com/CaseCRSaunders/propertymeld-calendar-overlay
// @updateURL    https://raw.githubusercontent.com/CaseCRSaunders/propertymeld-calendar-overlay/main/meld-calendar-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/CaseCRSaunders/propertymeld-calendar-overlay/main/meld-calendar-overlay.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CANCELLED = new Set(['MANAGER_CANCELED', 'TENANT_CANCELED']);
  const DEFAULT_ROW_PX = 75; // one hour; re-read from the grid when possible
  const REFRESH_MS = 2 * 60 * 1000;
  const LAYER_ATTR = 'data-mco';

  // Property Meld is a single-page app: moving to the calendar from another page
  // is not a page load, so this script runs on every PM page and only acts once
  // the URL is the calendar. ROOT is re-derived from the URL on each pass.
  let ROOT = '';
  const calendarRoot = () => {
    const m = location.pathname.match(/^\/(\d+)\/m\/(\d+)\/calendar\//);
    return m ? `/${m[1]}/m/${m[2]}` : null;
  };

  const STATUS_STYLE = {
    COMPLETED: { bg: '#e3f4e8', bd: '#2e8b57', label: 'Completed' },
    PENDING_COMPLETION: { bg: '#e3eefb', bd: '#1f6fbf', label: 'Started' },
    DEFAULT: { bg: '#f1f1f1', bd: '#777', label: '' },
  };

  let cache = { key: '', at: 0, items: [] };
  let hiddenCount = 0;
  let enabled = true;
  let busy = false;

  // ---- grid discovery -----------------------------------------------------

  // Column line names look like `[day-2026-09-28--agent-57580 day-2026-09-28-start]`
  // when technicians are selected, or `[day-2026-09-28-start]` with none.
  function columnLines(grid) {
    const cols = getComputedStyle(grid).gridTemplateColumns;
    return [...cols.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1].split(/\s+/));
  }

  function findGrid() {
    for (const el of document.querySelectorAll('.eui-yScroll')) {
      if (el.children.length > 20 && getComputedStyle(el).display === 'grid') {
        if (columnLines(el).some((n) => /^day-\d{4}-\d{2}-\d{2}/.test(n))) return el;
      }
    }
    return null;
  }

  // Returns { days: ['2026-09-28', ...], cols: Map<'day|agentId' | 'day|*', lineName> }
  function gridModel(grid) {
    const names = columnLines(grid);
    const days = new Set();
    const cols = new Map();
    for (const n of names) {
      let m = n.match(/^day-(\d{4}-\d{2}-\d{2})--agent-(\d+)$/);
      if (m) { days.add(m[1]); cols.set(`${m[1]}|${m[2]}`, n); continue; }
      m = n.match(/^day-(\d{4}-\d{2}-\d{2})-start$/);
      if (m) { days.add(m[1]); if (![...names].some((x) => x.startsWith(`day-${m[1]}--`))) cols.set(`${m[1]}|*`, n); continue; }
      m = n.match(/^day-(\d{4}-\d{2}-\d{2})--/); // vendor or other column types: range only
      if (m) days.add(m[1]);
    }
    return { days: [...days].sort(), cols };
  }

  function rowPx(grid) {
    const rows = getComputedStyle(grid).gridTemplateRows;
    const m = rows.match(/\[hour-12am\]\s*([\d.]+)px/);
    return m ? parseFloat(m[1]) : DEFAULT_ROW_PX;
  }

  const hourLine = (h) => `hour-${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  const dayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---- data ---------------------------------------------------------------

  async function getJson(path) {
    const r = await fetch(ROOT + path, { credentials: 'include' });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  }

  async function fetchAll(path) {
    const out = [];
    let url = path;
    for (let i = 0; i < 10 && url; i++) {
      const j = await getJson(url);
      out.push(...(j.results || []));
      url = j.next ? j.next.replace(/^https?:\/\/[^/]+/, '').replace(ROOT, '') : null;
    }
    return out;
  }

  // Statuses the page's own URL filter lets through. PM draws an event only if
  // the feed returned it AND its meld status passes this filter.
  function urlStatusFilter() {
    const p = new URLSearchParams(location.search);
    const vals = [...p.getAll('status[]'), ...p.getAll('status')];
    const set = new Set(vals.flatMap((v) => v.split(',')).filter(Boolean));
    return set.size ? set : null;
  }

  async function loadItems(days) {
    const start = new Date(`${days[0]}T00:00:00`);
    const end = new Date(`${days[days.length - 1]}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const gte = encodeURIComponent(start.toISOString());
    const lte = encodeURIComponent(end.toISOString());
    const filter = urlStatusFilter();
    const key = `${gte}|${lte}|${filter ? [...filter].sort() : ''}`;
    if (cache.key === key && Date.now() - cache.at < REFRESH_MS) return cache.items;

    const [melds, feed] = await Promise.all([
      fetchAll(`/api/melds/?limit=100&scheduled__gte=${gte}&scheduled__lte=${lte}`),
      getJson(`/api/management-events/?dtstart__gte=${gte}&dtend__lt=${lte}`).catch(() => []),
    ]);
    const inFeed = new Set((Array.isArray(feed) ? feed : feed.results || []).map((e) => e.id));

    const items = [];
    for (const m of melds) {
      if (CANCELLED.has(m.status) || m.is_active === false) continue;
      const passesFilter = !filter || filter.has(m.status);
      for (const a of m.managementappointment || []) {
        const seg = a.availability_segment;
        const ev = seg && seg.event;
        if (!ev || seg.expired) continue;
        if (passesFilter && inFeed.has(ev.id)) continue; // PM already draws this one
        items.push({
          id: m.id,
          ref: m.reference_id,
          title: m.brief_description || 'Meld',
          status: m.status,
          where: addressOf(m),
          agents: (m.in_house_servicers || []).map((s) => s.agent && s.agent.id).filter(Boolean),
          who: (m.in_house_servicers || [])
            .map((s) => s.agent && s.agent.first_name)
            .filter(Boolean)
            .join(', '),
          start: new Date(ev.dtstart),
          end: new Date(ev.dtend),
        });
      }
    }
    cache = { key, at: Date.now(), items };
    return items;
  }

  function addressOf(m) {
    const a = m.unit_address || m.prop_address;
    if (typeof a === 'string') return a;
    const u = m.unit && m.unit.display_address;
    if (u && u.line_1) return u.line_1;
    return '';
  }

  // ---- rendering ----------------------------------------------------------

  function layout(placements) {
    // Side-by-side lanes for overlapping blocks sharing a column.
    const byCol = new Map();
    for (const p of placements) {
      if (!byCol.has(p.col)) byCol.set(p.col, []);
      byCol.get(p.col).push(p);
    }
    for (const list of byCol.values()) {
      list.sort((a, b) => a.it.start - b.it.start);
      let cluster = [], clusterEnd = 0;
      const flush = () => {
        const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
        cluster.forEach((c) => (c.lanes = lanes));
        cluster = [];
      };
      const laneEnds = [];
      for (const p of list) {
        if (cluster.length && p.it.start >= clusterEnd) { flush(); laneEnds.length = 0; }
        let lane = laneEnds.findIndex((t) => t <= p.it.start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = p.it.end;
        p.lane = lane;
        cluster.push(p);
        clusterEnd = Math.max(clusterEnd, +p.it.end);
      }
      if (cluster.length) flush();
    }
  }

  // An item lands in its technician's column for that day; with no technician
  // columns showing it lands in the plain day column.
  function place(items, model) {
    const out = [];
    for (const it of items) {
      const day = dayKey(it.start);
      const direct = it.agents.map((id) => model.cols.get(`${day}|${id}`)).filter(Boolean);
      const cols = direct.length ? direct : [model.cols.get(`${day}|*`)].filter(Boolean);
      for (const col of cols) out.push({ it, col });
    }
    return out;
  }

  function render(grid, items, model) {
    grid.querySelectorAll(`[${LAYER_ATTR}]`).forEach((n) => n.remove());
    const px = rowPx(grid) / 60; // px per minute
    const placements = place(items, model);
    layout(placements);
    hiddenCount = new Set(placements.map((p) => p.it.id + '|' + p.it.start)).size;

    if (enabled) {
      for (const { it, col, lane, lanes } of placements) {
        const st = STATUS_STYLE[it.status] || STATUS_STYLE.DEFAULT;
        const mins = it.start.getHours() * 60 + it.start.getMinutes();
        const dur = Math.max(30, (it.end - it.start) / 60000);
        const a = document.createElement('a');
        a.setAttribute(LAYER_ATTR, '1');
        a.href = `${ROOT}/meld/${it.id}/summary/`;
        a.title = `${it.ref} - ${it.title}\n${st.label}${it.who ? ' - ' + it.who : ''}\n${it.where}`;
        const hh = it.start.getHours();
        Object.assign(a.style, {
          gridColumn: `${col} / span 1`,
          gridRowStart: hourLine(hh),
          alignSelf: 'start',
          justifySelf: 'start',
          marginTop: `${(mins - hh * 60) * px}px`,
          height: `${dur * px - 2}px`,
          width: `calc(${100 / lanes}% - 4px)`,
          marginLeft: `calc(${(100 / lanes) * lane}% + 2px)`,
          boxSizing: 'border-box',
          zIndex: 5,
          overflow: 'hidden',
          padding: '2px 5px',
          fontSize: '12px',
          lineHeight: '1.25',
          color: '#1b1b1b',
          textDecoration: 'none',
          background: st.bg,
          border: `1px dashed ${st.bd}`,
          borderLeft: `4px solid ${st.bd}`,
          borderRadius: '3px',
          cursor: 'pointer',
        });
        const t = document.createElement('div');
        t.style.fontWeight = '700';
        t.style.whiteSpace = 'nowrap';
        t.style.overflow = 'hidden';
        t.style.textOverflow = 'ellipsis';
        t.textContent = `${it.status === 'COMPLETED' ? '✓ ' : '▶ '}${it.title}`;
        const s = document.createElement('div');
        s.style.whiteSpace = 'nowrap';
        s.style.overflow = 'hidden';
        s.style.textOverflow = 'ellipsis';
        s.textContent = [it.where, it.who].filter(Boolean).join(' · ');
        a.append(t, s);
        grid.appendChild(a);
      }
    }
    updatePill();
  }

  function updatePill(msg) {
    let pill = document.getElementById('mco-pill');
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'mco-pill';
      Object.assign(pill.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999,
        padding: '6px 12px', borderRadius: '16px', border: '1px solid #1f6fbf',
        background: '#fff', color: '#1f6fbf', font: '600 12px system-ui, sans-serif',
        cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
      });
      pill.addEventListener('click', () => { enabled = !enabled; tick(true); });
      document.body.appendChild(pill);
    }
    pill.textContent = msg || (enabled
      ? `Overlay: ${hiddenCount} hidden job${hiddenCount === 1 ? '' : 's'} shown`
      : 'Overlay off');
  }

  // ---- lifecycle ----------------------------------------------------------

  async function tick(force) {
    if (busy) return;
    const root = calendarRoot();
    if (!root) {
      const pill = document.getElementById('mco-pill');
      if (pill) pill.remove();
      return;
    }
    ROOT = root;
    const grid = findGrid();
    if (!grid) {
      updatePill('Overlay: use Week or multi-day view');
      return;
    }
    const model = gridModel(grid);
    if (!model.days.length) return;
    const present = grid.querySelector(`[${LAYER_ATTR}]`);
    const sig = [...model.cols.values()].join() + location.search + enabled;
    if (!force && grid.getAttribute('data-mco-sig') === sig && (present || hiddenCount === 0)) return;
    busy = true;
    try {
      const items = await loadItems(model.days);
      render(grid, items, model);
      grid.setAttribute('data-mco-sig', sig);
    } catch (e) {
      console.warn('[meld-calendar-overlay]', e);
      updatePill('Overlay: error (see console)');
    } finally {
      busy = false;
    }
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => tick(false), 300);
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => tick(true), REFRESH_MS);
  tick(false);
})();
