/* ==========================================================================
   Valheim Server Console — front-end
   --------------------------------------------------------------------------
   Every API endpoint, request payload and safety check from the previous UI
   is preserved (see the "API" comments on each section). What changed is the
   presentation layer: routing, dialogs instead of alert/confirm/prompt,
   toasts, skeletons, sortable/filterable tables, charts and an activity feed.
   ========================================================================== */

'use strict';

/* ==========================================================================
   1. Small utilities
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;

function icon(name, cls = '') {
  return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable — non-fatal */
    }
  },
};

// fetch + JSON with a real error on non-2xx (the server answers { error } on 500s).
async function api(url, opts) {
  const r = await fetch(url, opts);
  let data;
  try {
    data = await r.json();
  } catch (e) {
    throw new Error(`${r.status} ${r.statusText || 'Invalid response'}`);
  }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  if (opts && opts.method && opts.method !== 'GET' && typeof refreshPending === 'function') setTimeout(refreshPending, 1200);
  return data;
}

// ---- Login plumbing ----
// Every state-changing request carries X-VGUI (the server rejects it otherwise
// — CSRF defence), and a 401 anywhere means the session ended, so go to the
// login page. Applies to every fetch() in this file, including the streaming ones.
(function installAuthFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    init = init || {};
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const sameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(location.origin);
    if (sameOrigin && method !== 'GET' && method !== 'HEAD') {
      const h = new Headers(init.headers || {});
      h.set('X-VGUI', '1');
      init = { ...init, headers: h };
    }
    const r = await orig(input, init);
    if (sameOrigin && r.status === 401 && !location.pathname.endsWith('/login.html')) location.href = '/login.html';
    return r;
  };
})();

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    /* leave anyway */
  }
  location.href = '/login.html';
}

// Live streams (EventSource) can't see a 401, so check the session now and then.
async function checkSession() {
  try {
    const r = await fetch('/api/auth/status');
    const d = await r.json();
    if (d && d.authenticated === false) location.href = '/login.html';
  } catch (e) {
    /* server unreachable — the normal status pill already shows that */
  }
}
setInterval(checkSession, 60 * 1000);

function pluralize(n, word, plural) {
  return `${n} ${n === 1 ? word : plural || word + 's'}`;
}

function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  const days = Math.round(diff / 86400000);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// systemd prints e.g. "Sun 2026-09-20 10:04:11 UTC". Best-effort parse.
function parseSystemdTime(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([A-Za-z]+|[+-]\d{2,4})?/);
  if (!m) return null;
  const tz = (m[3] || '').toUpperCase();
  let t;
  if (tz === 'UTC' || tz === 'GMT' || tz === 'Z') t = Date.parse(`${m[1]}T${m[2]}Z`);
  else if (/^[+-]\d{2}$/.test(tz)) t = Date.parse(`${m[1]}T${m[2]}${tz}:00`);
  else if (/^[+-]\d{4}$/.test(tz)) t = Date.parse(`${m[1]}T${m[2]}${tz.slice(0, 3)}:${tz.slice(3)}`);
  else t = Date.parse(`${m[1]}T${m[2]}`);
  return isNaN(t) ? null : t;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function setBtnLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', !!loading);
  btn.disabled = !!loading;
  btn.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function emptyState({ iconName = 'inbox', title, text = '', action = '', error = false, small = false }) {
  return `<div class="empty${error ? ' error' : ''}${small ? ' sm' : ''}">
    <div class="empty-icon">${icon(error ? 'alert' : iconName)}</div>
    <div class="empty-title">${esc(title)}</div>
    ${text ? `<div class="empty-text">${text}</div>` : ''}
    ${action}
  </div>`;
}

function skeletonRows(n, cols) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<tr class="sk-row">${Array.from({ length: cols }, (_, c) =>
      `<td><span class="skeleton ${c === 1 ? 'w-60' : c === 0 ? '' : 'w-40'}" style="${c === 0 ? 'width:15px' : ''}"></span></td>`
    ).join('')}</tr>`;
  }
  return html;
}

function skeletonLis(n) {
  return Array.from({ length: n }, () =>
    `<li class="sk-li"><span class="skeleton" style="width:30px;height:30px;border-radius:8px"></span><div class="row-main"><span class="skeleton w-40"></span><span class="skeleton sm w-60" style="margin-top:6px"></span></div></li>`
  ).join('');
}

/* ==========================================================================
   2. UI primitives: toasts, tooltip, dialog, menu, console chrome
   ========================================================================== */

// ---- Toasts ----
const TOAST_ICONS = { success: 'check-circle', error: 'x-circle', warn: 'alert', info: 'info' };
function toast(type, title, message = '', ms) {
  const duration = ms || (type === 'error' ? 7000 : 4000);
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(TOAST_ICONS[type] || 'info')}
    <div class="toast-body"><div class="toast-title">${esc(title)}</div>${message ? `<div class="toast-msg">${esc(message)}</div>` : ''}</div>
    <button class="icon-btn sm toast-close" aria-label="Dismiss">${icon('x')}</button>
    <span class="toast-progress" style="animation-duration:${duration}ms"></span>`;
  const close = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').onclick = close;
  let timer = setTimeout(close, duration);
  el.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    el.querySelector('.toast-progress').style.animationPlayState = 'paused';
  });
  el.addEventListener('mouseleave', () => {
    timer = setTimeout(close, 1800);
  });
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
}

// ---- Tooltip (any element with data-tip) ----
(() => {
  const el = $('tooltip');
  let timer = null;
  let current = null;
  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    const side = target.getAttribute('data-tip-side');
    // Sidebar tips only matter when the sidebar is collapsed to icons.
    if (side === 'right' && !document.documentElement.classList.contains('sb-collapsed')) return;
    el.textContent = text;
    el.classList.add('show');
    const r = target.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    let x;
    let y;
    if (side === 'right') {
      x = r.right + 10;
      y = r.top + r.height / 2 - tr.height / 2;
    } else {
      x = r.left + r.width / 2 - tr.width / 2;
      y = r.top - tr.height - 8;
      if (y < 8) y = r.bottom + 8;
    }
    x = Math.max(8, Math.min(x, window.innerWidth - tr.width - 8));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
  function hide() {
    clearTimeout(timer);
    current = null;
    el.classList.remove('show');
  }
  function onEnter(e) {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || t === current) return;
    clearTimeout(timer);
    current = t;
    timer = setTimeout(() => show(t), e.type === 'focusin' ? 0 : 350);
  }
  function onLeave(e) {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t === current && !t.contains(e.relatedTarget)) hide();
  }
  document.addEventListener('mouseover', onEnter);
  document.addEventListener('mouseout', onLeave);
  document.addEventListener('focusin', onEnter);
  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide);
  window.addEventListener('scroll', hide, true);
  return { hide };
})();

// ---- Generic dialog: replaces alert/confirm/prompt with accessible modals ----
// opts: { title, tone: 'info'|'warn'|'danger', iconName, html, input: {label, placeholder, match, help},
//         actions: [{ key, label, variant, needsMatch }], cancelLabel, collect(bodyEl) -> value|{error} }
// Resolves { key, value, input } or null on cancel.
let dialogResolve = null;
let dialogReturnFocus = null;
function dialog(opts) {
  const overlay = $('dialog-overlay');
  const body = $('dialog-body');
  const foot = $('dialog-foot');
  const tone = opts.tone || 'info';
  const iconName = opts.iconName || (tone === 'danger' ? 'alert' : tone === 'warn' ? 'alert' : 'info');
  $('dialog-title').textContent = opts.title || '';
  const ic = $('dialog-icon');
  ic.className = `dialog-icon ${tone}`;
  ic.innerHTML = opts.noIcon ? '' : icon(iconName);

  body.innerHTML = opts.html || '';
  let inputEl = null;
  if (opts.input) {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-input-wrap field';
    wrap.innerHTML = `<label class="field-label" for="dialog-input">${opts.input.label}</label>
      <input type="text" id="dialog-input" autocomplete="off" spellcheck="false" placeholder="${esc(opts.input.placeholder || '')}">
      ${opts.input.help ? `<div class="dialog-help">${opts.input.help}</div>` : ''}`;
    body.appendChild(wrap);
    inputEl = wrap.querySelector('input');
  }
  const errEl = document.createElement('div');
  errEl.className = 'dialog-error hidden';
  body.appendChild(errEl);

  foot.innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = opts.cancelLabel || 'Cancel';
  cancelBtn.setAttribute('data-dialog-cancel', '');
  foot.appendChild(cancelBtn);

  const actionBtns = (opts.actions || [{ key: 'confirm', label: 'Confirm', variant: 'btn-primary' }]).map((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.variant || 'btn-primary'}`;
    b.innerHTML = a.label;
    b.dataset.key = a.key;
    if (a.needsMatch) b.disabled = true;
    b.onclick = () => finish(a.key);
    foot.appendChild(b);
    return { b, a };
  });

  if (inputEl) {
    inputEl.addEventListener('input', () => {
      actionBtns.forEach(({ b, a }) => {
        if (a.needsMatch) b.disabled = inputEl.value.trim() !== opts.input.match;
      });
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const primary = actionBtns.slice().reverse().find(({ b }) => !b.disabled);
        if (primary) finish(primary.a.key);
      }
    });
  }

  function finish(key) {
    let value = null;
    if (key && opts.collect) {
      value = opts.collect(body, key);
      if (value && value.error) {
        errEl.textContent = value.error;
        errEl.classList.remove('hidden');
        return;
      }
    }
    close({ key, value, input: inputEl ? inputEl.value.trim() : null });
  }

  function close(result) {
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey, true);
    const r = dialogResolve;
    dialogResolve = null;
    if (dialogReturnFocus && dialogReturnFocus.focus) dialogReturnFocus.focus();
    if (r) r(result);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Tab') trapFocus(e, overlay);
  }

  qsa('[data-dialog-cancel]', overlay).forEach((b) => (b.onclick = () => close(null)));
  overlay.onclick = (e) => {
    if (e.target === overlay) close(null);
  };

  if (dialogResolve) dialogResolve(null);
  dialogReturnFocus = document.activeElement;
  overlay.classList.remove('hidden');
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    const focusTarget = inputEl || qs('input, select', body) || actionBtns[actionBtns.length - 1]?.b;
    if (focusTarget) focusTarget.focus();
  }, 30);
  return new Promise((resolve) => (dialogResolve = resolve));
}

async function confirmDialog({ title, html, confirmLabel = 'Confirm', tone = 'info', variant }) {
  const res = await dialog({
    title,
    html,
    tone,
    actions: [{ key: 'confirm', label: confirmLabel, variant: variant || (tone === 'danger' ? 'btn-danger' : tone === 'warn' ? 'btn-warn' : 'btn-primary') }],
  });
  return !!(res && res.key === 'confirm');
}

function trapFocus(e, root) {
  const f = qsa('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', root).filter(
    (el) => el.offsetParent !== null
  );
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---- Context menu ----
const menu = (() => {
  const el = $('menu');
  let anchor = null;
  function close() {
    el.classList.add('hidden');
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    anchor = null;
  }
  function open(btn, items) {
    if (anchor === btn) return close();
    close();
    anchor = btn;
    btn.setAttribute('aria-expanded', 'true');
    el.innerHTML = '';
    items.forEach((it) => {
      if (it === 'sep') {
        el.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
        return;
      }
      if (it.label && it.header) {
        el.insertAdjacentHTML('beforeend', `<div class="menu-label">${esc(it.label)}</div>`);
        return;
      }
      const b = document.createElement('button');
      b.className = `menu-item ${it.tone || ''}`;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `${icon(it.icon || 'chevron-right')}<span>${esc(it.label)}</span>`;
      if (it.tip) b.setAttribute('data-tip', it.tip);
      b.onclick = () => {
        close();
        it.onClick();
      };
      el.appendChild(b);
    });
    el.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const mr = el.getBoundingClientRect();
    let x = r.right - mr.width;
    let y = r.bottom + 4;
    if (y + mr.height > window.innerHeight - 8) y = r.top - mr.height - 4;
    el.style.left = Math.max(8, x) + 'px';
    el.style.top = Math.max(8, y) + 'px';
    const first = el.querySelector('.menu-item');
    if (first) first.focus();
  }
  document.addEventListener('mousedown', (e) => {
    if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (el.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      const a = anchor;
      close();
      if (a) a.focus();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = qsa('.menu-item', el);
      const i = items.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[n].focus();
    }
  });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  return { open, close };
})();

// ---- Console chrome (state badge + copy/clear) ----
function consoleWrapOf(pre) {
  return pre && pre.closest('[data-console]');
}
function setConsoleState(pre, state, label) {
  const wrap = consoleWrapOf(pre);
  if (!wrap) return;
  const el = wrap.querySelector('.console-state');
  const labels = { running: 'Running', success: 'Completed', error: 'Failed', idle: '' };
  el.className = `console-state ${state || ''}`;
  el.textContent = label != null ? label : labels[state] || '';
}
function initConsoles() {
  qsa('[data-console]').forEach((wrap) => {
    const pre = wrap.querySelector('pre');
    const tools = wrap.querySelector('.console-tools');
    if (!tools || !pre) return;
    tools.innerHTML = `<button class="icon-btn" data-tip="Copy output" aria-label="Copy output">${icon('copy')}</button><button class="icon-btn" data-tip="Clear" aria-label="Clear output">${icon('x')}</button>`;
    const [copyBtn, clearBtn] = tools.querySelectorAll('button');
    copyBtn.onclick = async () => {
      if (!pre.textContent) return toast('info', 'Nothing to copy');
      (await copyText(pre.textContent)) ? toast('success', 'Output copied') : toast('error', 'Copy failed');
    };
    clearBtn.onclick = () => {
      pre.textContent = '';
      setConsoleState(pre, 'idle');
    };
  });
}

// Detect outcome of a finished stream from its text.
function outcomeOf(text) {
  return /\[error\]|exit code [1-9]|\berror:/i.test(text) ? 'error' : 'success';
}

/* ==========================================================================
   3. Activity timeline (client-side, persisted per browser)
   ========================================================================== */

const TL_ICONS = { good: 'check', warn: 'alert', bad: 'x', info: 'info', accent: 'activity' };
let timeline = store.get('vg.timeline', []);

function recordEvent(tone, title, detail = '', iconName) {
  timeline.unshift({ t: Date.now(), tone, title, detail, icon: iconName || TL_ICONS[tone] || 'activity' });
  if (timeline.length > 60) timeline.length = 60;
  store.set('vg.timeline', timeline);
  renderTimeline();
}

function renderTimeline() {
  const el = $('timeline');
  if (!el) return;
  if (!timeline.length) {
    el.innerHTML = `<li>${emptyState({ iconName: 'activity', title: 'No activity yet', text: 'Server actions, state changes, player joins and mod changes will appear here.', small: true })}</li>`;
    return;
  }
  el.innerHTML = timeline
    .map(
      (ev) => `<li class="tl-item">
        <span class="tl-icon ${ev.tone}">${icon(ev.icon)}</span>
        <div class="tl-body"><div class="tl-title">${esc(ev.title)}</div>${ev.detail ? `<div class="tl-detail" title="${esc(ev.detail)}">${esc(ev.detail)}</div>` : ''}</div>
        <time class="tl-time" datetime="${new Date(ev.t).toISOString()}" title="${esc(new Date(ev.t).toLocaleString())}">${timeAgo(ev.t)}</time>
      </li>`
    )
    .join('');
}

async function clearTimeline() {
  if (!timeline.length) return;
  timeline = [];
  store.set('vg.timeline', timeline);
  renderTimeline();
  toast('info', 'Activity cleared');
}

/* ==========================================================================
   4. Navigation: router, sidebar, theme, command palette, shortcuts
   ========================================================================== */

const PAGES = {
  dashboard: 'Dashboard',
  worlds: 'Worlds',
  mods: 'Mods',
  backups: 'Backups',
  updates: 'Updates',
  logs: 'Logs',
  setup: 'Setup',
  settings: 'Settings',
  configs: 'Mod configs',
  'pz-dashboard': 'Dashboard',
  'pz-mods': 'Mods',
  'pz-backups': 'Backups',
  'pz-updates': 'Updates',
  'pz-logs': 'Logs',
};
const PZ_PAGES = new Set(['pz-dashboard', 'pz-mods', 'pz-backups', 'pz-updates', 'pz-logs']);
const pageVisited = {};
let currentPage = null;

/* ---- Game switch (Valheim / Project Zomboid — two servers, one GUI) ---- */
// What the Valheim side calls itself: plain "Valheim" until the server's world exists, then the
// world's name (see applyBrand). Declared up here because the game switch below reads it.
let valheimBrand = 'Valheim';
let activeGame = store.get('vg.activeGame', 'valheim') === 'zomboid' ? 'zomboid' : 'valheim';

// Swaps sidebar/brand chrome and starts/stops each game's own polling. Does
// NOT navigate — that's setActiveGame()'s job (the button click path) vs.
// this being called from showPage() too (the deep-link/hashchange path,
// where we're already mid-navigation and must not recurse into it).
function applyGameChrome(game) {
  activeGame = game;
  store.set('vg.activeGame', game);
  document.body.dataset.game = game;
  qsa('.game-switch-btn').forEach((b) => {
    const on = b.dataset.game === game;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('sb-brand-sub').textContent = game === 'zomboid' ? 'Project Zomboid · Dedicated' : 'Valheim · Dedicated';
  $('crumb-root').textContent = game === 'zomboid' ? 'Project Zomboid' : valheimBrand;
  // Never run two games' live streams / pollers at once.
  stopPlayersLive();
  stopLogsLive();
  stopPzPolling();
  stopPzLogsLive();
  if (game === 'zomboid') {
    startPzPolling();
  } else {
    startPlayersLive();
  }
}

function setActiveGame(game) {
  if (game === activeGame) return;
  applyGameChrome(game);
  navigate(game === 'zomboid' ? 'pz-dashboard' : 'dashboard');
}

function showPage(page, { focus = false } = {}) {
  if (!PAGES[page]) page = activeGame === 'zomboid' ? 'pz-dashboard' : 'dashboard';
  // A deep link / bookmark into the other game's page switches the toggle
  // to match, instead of silently showing the wrong game's chrome.
  const wantsZomboid = PZ_PAGES.has(page);
  if (wantsZomboid !== (activeGame === 'zomboid')) applyGameChrome(wantsZomboid ? 'zomboid' : 'valheim');
  currentPage = page;
  qsa('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + page));
  qsa('.sb-item[data-page]').forEach((a) => {
    const on = a.dataset.page === page;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('crumb-page').textContent = PAGES[page];
  document.title = `${PAGES[page]} · ${activeGame === 'zomboid' ? 'Project Zomboid' : valheimBrand}`;
  document.documentElement.classList.remove('sb-open');
  if (focus) $('content').focus({ preventScroll: true });
  window.scrollTo({ top: 0 });

  // Lazy first-visit loads (read-only endpoints only).
  if (!pageVisited[page]) {
    pageVisited[page] = true;
    if (page === 'mods') loadInstalledMods();
    if (page === 'backups') {
      listBackups();
      loadBackupSchedule();
    }
    if (page === 'updates') loadUpdateSchedule();
    if (page === 'settings') {
      loadSettings();
      loadModifiers();
      loadLists();
    }
    if (page === 'configs') loadConfigList();
    if (page === 'pz-backups') pzListBackups();
    if (page === 'pz-mods') pzLoadMods();
  }
  if (page === 'worlds') loadWorlds();
  if (page === 'dashboard') renderUsageChart();
  if (page === 'pz-dashboard') pzRenderUsageChart();
}

function navigate(page) {
  if (location.hash !== '#' + page) location.hash = page;
  else showPage(page);
}

window.addEventListener('hashchange', () => showPage(location.hash.slice(1), { focus: true }));

function toggleSidebar() {
  if (window.matchMedia('(max-width: 768px)').matches) {
    document.documentElement.classList.toggle('sb-open');
    return;
  }
  const collapsed = document.documentElement.classList.toggle('sb-collapsed');
  store.set('vg.sidebar', collapsed ? 'collapsed' : 'expanded');
  try {
    localStorage.setItem('vg.sidebar', collapsed ? 'collapsed' : 'expanded');
  } catch (e) {}
  $('sidebar-collapse').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  $('sidebar-collapse').setAttribute('data-tip', collapsed ? 'Expand sidebar  [' : 'Collapse sidebar  [');
  setTimeout(renderUsageChart, 200);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('vg.theme', next);
  } catch (e) {}
  renderUsageChart();
  drawSparklines();
}

$('sidebar-collapse').onclick = toggleSidebar;
$('sidebar-open').onclick = toggleSidebar;
$('sb-scrim').onclick = () => document.documentElement.classList.remove('sb-open');
$('theme-toggle').onclick = toggleTheme;
$('pending-indicator').onclick = () => {
  navigate('mods');
  setTimeout(() => {
    const log = $('action-log');
    log.scrollIntoView({ behavior: 'smooth', block: 'start' });
    log.querySelector('.card').classList.add('flash');
    setTimeout(() => log.querySelector('.card').classList.remove('flash'), 1300);
  }, 60);
};

// ---- Command palette ----
const COMMANDS = [
  ...Object.entries(PAGES).map(([k, v]) => ({
    group: 'Go to',
    label: v,
    icon: { dashboard: 'grid', worlds: 'server', mods: 'puzzle', backups: 'archive', updates: 'download-cloud', logs: 'terminal', setup: 'wrench' }[k],
    run: () => navigate(k),
  })),
  { group: 'Go to', label: 'Browse & install mods', icon: 'search', run: () => { navigate('mods'); showModsTab('browse'); setTimeout(() => $('mod-search-input').focus(), 50); } },
  { group: 'Go to', label: 'Mod requirements', icon: 'list', run: () => { navigate('mods'); showModsTab('requirements'); } },
  { group: 'Go to', label: 'Generate profile codes', icon: 'key', run: () => { navigate('mods'); showModsTab('codes'); } },
  { group: 'Server', label: 'Start server', icon: 'play', run: () => serverAction('start') },
  { group: 'Server', label: 'Stop server', icon: 'stop', run: () => serverAction('stop') },
  { group: 'Server', label: 'Copy connect address', icon: 'copy', run: () => copyConnect() },
  { group: 'Server', label: 'Refresh status', icon: 'refresh', run: () => refreshAll() },
  { group: 'Operations', label: 'Run backup now', icon: 'archive', run: () => { navigate('backups'); runBackup(); } },
  { group: 'Operations', label: 'Check for server update', icon: 'download-cloud', run: () => { navigate('updates'); checkUpdate(); } },
  { group: 'Operations', label: 'Refresh installed mods', icon: 'refresh', run: () => { navigate('mods'); showModsTab('installed'); loadInstalledMods(); } },
  { group: 'Operations', label: 'Stream live logs', icon: 'terminal', run: () => { navigate('logs'); if (!liveSource) toggleLive(); } },
  { group: 'Operations', label: 'Notify Discord of pending changes', icon: 'send', run: () => sendDiscordSummary() },
  { group: 'Preferences', label: 'Toggle theme', icon: 'moon', run: () => toggleTheme() },
  { group: 'Account', label: 'Sign out', icon: 'power', run: () => logout() },
  { group: 'Preferences', label: 'Toggle sidebar', icon: 'sidebar', run: () => toggleSidebar() },
];
let cmdkIndex = 0;
let cmdkFiltered = [];

function openCmdk() {
  $('cmdk').classList.remove('hidden');
  $('cmdk-input').value = '';
  renderCmdk();
  $('cmdk-input').focus();
}
function closeCmdk() {
  $('cmdk').classList.add('hidden');
}
function renderCmdk() {
  const q = $('cmdk-input').value.trim().toLowerCase();
  cmdkFiltered = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  cmdkIndex = Math.min(cmdkIndex, Math.max(0, cmdkFiltered.length - 1));
  if (!q) cmdkIndex = Math.min(cmdkIndex, cmdkFiltered.length - 1);
  const list = $('cmdk-list');
  if (!cmdkFiltered.length) {
    list.innerHTML = `<li class="cmdk-empty">No matching commands</li>`;
    return;
  }
  let html = '';
  let lastGroup = null;
  cmdkFiltered.forEach((c, i) => {
    if (c.group !== lastGroup) {
      html += `<li class="cmdk-group" role="presentation">${esc(c.group)}</li>`;
      lastGroup = c.group;
    }
    html += `<li class="cmdk-item${i === cmdkIndex ? ' active' : ''}" role="option" data-i="${i}" aria-selected="${i === cmdkIndex}">${icon(c.icon)}<span>${esc(c.label)}</span>${i === cmdkIndex ? '<span class="cmdk-hint">↵</span>' : ''}</li>`;
  });
  list.innerHTML = html;
  const active = list.querySelector('.cmdk-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function runCmdk(i) {
  const c = cmdkFiltered[i];
  if (!c) return;
  closeCmdk();
  c.run();
}
$('cmdk-open').onclick = openCmdk;
$('cmdk-input').addEventListener('input', () => {
  cmdkIndex = 0;
  renderCmdk();
});
$('cmdk-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdkIndex = (cmdkIndex + 1) % Math.max(1, cmdkFiltered.length);
    renderCmdk();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdkIndex = (cmdkIndex - 1 + cmdkFiltered.length) % Math.max(1, cmdkFiltered.length);
    renderCmdk();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runCmdk(cmdkIndex);
  } else if (e.key === 'Escape') closeCmdk();
});
$('cmdk-list').addEventListener('click', (e) => {
  const li = e.target.closest('.cmdk-item');
  if (li) runCmdk(+li.dataset.i);
});
$('cmdk').addEventListener('mousedown', (e) => {
  if (e.target.id === 'cmdk') closeCmdk();
});

// ---- Global keyboard shortcuts ----
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('cmdk').classList.contains('hidden') ? openCmdk() : closeCmdk();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('dialog-overlay').classList.contains('hidden') || !$('mod-prompt-overlay').classList.contains('hidden')) return;
  if (e.key === '[') {
    e.preventDefault();
    toggleSidebar();
  } else if (e.key === '/') {
    const target = { mods: 'mod-filter-input', logs: 'log-filter', backups: 'backup-filter' }[currentPage];
    if (target) {
      e.preventDefault();
      if (currentPage === 'mods' && currentModsTab === 'browse') $('mod-search-input').focus();
      else {
        if (currentPage === 'mods') showModsTab('installed');
        $(target).focus();
      }
    }
  }
});

/* ==========================================================================
   5. Dashboard — status, info, resources, players
   ========================================================================== */

// ---- Server info card (API: GET /api/info) ----
let lastInfo = null;

function applyBrand(brand) {
  valheimBrand = brand || 'Valheim';
  const nameEl = $('sb-brand-name');
  if (nameEl) nameEl.textContent = valheimBrand;
  if (typeof activeGame === 'undefined' || activeGame !== 'zomboid') {
    $('crumb-root').textContent = valheimBrand;
    if (typeof currentPage !== 'undefined' && typeof PAGES !== 'undefined' && PAGES[currentPage]) document.title = `${PAGES[currentPage]} · ${valheimBrand}`;
  }
}

async function loadInfo() {
  try {
    const r = await api('/api/info');
    lastInfo = r;
    applyBrand(r.brand);
    const worldText = r.worldName ? (r.worldReady ? r.worldName : `${r.worldName} (created on first start)`) : '—';
    $('info-world').textContent = worldText;
    $('head-world').textContent = r.worldName ? (r.worldReady ? r.worldName : `${r.worldName} · not created yet`) : '—';
    $('info-modcount').textContent = r.modCount ?? '—';
    $('info-connect').textContent = r.connectHost ? `${r.connectHost}:${r.connectPort}` : `<your VPS public IP>:${r.connectPort}`;
  } catch (e) {
    // non-fatal, dashboard still works without it
    if (!lastInfo) {
      $('info-world').textContent = '—';
      $('info-modcount').textContent = '—';
    }
  }
}

async function copyConnect() {
  if (!lastInfo) return toast('warn', 'Connect address not loaded yet');
  if (!lastInfo.connectHost) return toast('warn', 'No public address known', 'Set "publicHost" in config.json to your VPS public IP.');
  const str = `${lastInfo.connectHost}:${lastInfo.connectPort}`;
  (await copyText(str)) ? toast('success', 'Connect address copied', str) : toast('error', 'Copy failed');
}

// ---- Status (API: GET /api/status) ----
let lastStatus = null;
let statusSinceTs = null;
let statusLoadedOnce = false;

async function refreshStatus() {
  const pill = $('status-pill');
  const portPill = $('port-pill');
  const text = $('status-text');
  const since = $('status-since');
  if (!statusLoadedOnce) {
    pill.textContent = 'checking…';
    pill.className = 'pill unknown';
    portPill.textContent = 'checking…';
    portPill.className = 'pill unknown';
  }
  try {
    const r = await api('/api/status');
    statusLoadedOnce = true;
    text.textContent = r.state;
    statusSinceTs = parseSystemdTime(r.since);
    since.textContent = r.since ? `· since ${r.since}` : '';
    pill.textContent = r.state;
    pill.className = 'pill ' + (r.state === 'active' ? 'active' : r.state === 'activating' || r.state === 'deactivating' ? 'warn' : 'inactive');

    let portState;
    if (r.portOpen) {
      portPill.textContent = 'open';
      portPill.className = 'pill active';
      portState = 'open';
    } else if (r.state === 'active') {
      // Instance running but the game port isn't listening — exactly the
      // confusing state this whole check exists to catch.
      portPill.textContent = 'not open';
      portPill.className = 'pill warn';
      portState = 'not open';
    } else {
      portPill.textContent = 'closed';
      portPill.className = 'pill inactive';
      portState = 'closed';
    }

    // Timeline: record transitions (not the first observation).
    if (lastStatus) {
      if (lastStatus.state !== r.state) {
        const tone = r.state === 'active' ? 'good' : r.state === 'failed' ? 'bad' : 'warn';
        recordEvent(tone, `Service is now ${r.state}`, `was ${lastStatus.state}`, r.state === 'active' ? 'play' : 'power');
      }
      if (lastStatus.portOpen !== r.portOpen) {
        recordEvent(r.portOpen ? 'good' : 'warn', r.portOpen ? 'Server accepting connections' : 'Game port stopped listening', `UDP ${r.port}`, 'globe');
      }
    }
    lastStatus = r;
    renderHealth(r, portState);
    $('info-state').innerHTML = `<span class="pill ${pill.className.split(' ')[1]}">${esc(r.state)}</span>`;
    $('info-port').innerHTML = `<span class="mono">UDP ${esc(r.port)}</span> · ${esc(portState)}`;
    updateUptime();
  } catch (e) {
    pill.textContent = 'error';
    pill.className = 'pill inactive';
    text.textContent = e.message;
    portPill.textContent = 'error';
    portPill.className = 'pill inactive';
    $('kpi-health').innerHTML = `<span class="kpi-health bad" style="display:flex;align-items:center;gap:10px"><span class="kpi-health-dot"></span><span>Unreachable</span></span>`;
    $('kpi-health-foot').textContent = e.message;
    $('kpi-health-foot').title = e.message;
  }
}

function renderHealth(r, portState) {
  let tone;
  let label;
  if (r.state === 'active' && r.portOpen) {
    tone = 'good';
    label = 'Online';
  } else if (r.state === 'active') {
    tone = 'warn';
    label = 'Starting';
  } else if (r.state === 'activating') {
    tone = 'warn';
    label = 'Activating';
  } else if (r.state === 'failed') {
    tone = 'bad';
    label = 'Failed';
  } else {
    tone = 'bad';
    label = 'Offline';
  }
  $('kpi-health').innerHTML = `<span class="kpi-health ${tone}" style="display:flex;align-items:center;gap:10px"><span class="kpi-health-dot"></span><span>${label}</span></span>`;
  const foot = r.state === 'active' && !r.portOpen ? `Instance running · port ${r.port} not listening yet` : `Port ${r.port} ${portState}`;
  $('kpi-health-foot').textContent = foot;
  $('kpi-health-foot').title = foot;
}

function updateUptime() {
  const el = $('info-uptime');
  if (!lastStatus || lastStatus.state !== 'active') {
    el.textContent = '—';
    return;
  }
  const up = statusSinceTs ? Date.now() - statusSinceTs : -1;
  el.textContent = up >= 0 ? fmtDuration(up) : '—';
  if (lastStatus.portOpen && up >= 0) {
    $('kpi-health-foot').textContent = `Up ${fmtDuration(Date.now() - statusSinceTs)} · port ${lastStatus.port} open`;
  }
}

// ---- Server control (API: POST /api/server/:action) ----
async function serverAction(action) {
  if (action === 'stop') {
    let saveNote = '';
    const h = await api('/api/save-health').catch(() => lastSaveHealth);
    if (h && h.running && h.lastSaveTs) {
      saveNote =
        `<p class="muted">Stopping saves the world first. Last autosave: <strong>${esc(timeAgo(h.lastSaveTs))}</strong>.` +
        (h.state === 'late' || h.state === 'stale'
          ? ' <strong>That is longer than the autosave interval</strong> — wait until the status shows <em>inactive</em> before starting again, so the save can finish.'
          : '') +
        '</p>';
    } else if (h && h.running) {
      saveNote = '<p class="muted">Stopping saves the world first. Wait until the status shows <em>inactive</em> before starting again.</p>';
    }
    const ok = await confirmDialog({
      title: worldsCache && worldsCache.length > 1 ? `Stop ${valheimBrand}?` : 'Stop the Valheim server?',
      html: '<p>Players online will be disconnected and the world will be unavailable until you start it again.</p>' + saveNote,
      confirmLabel: 'Stop server',
      tone: 'danger',
    });
    if (!ok) return;
  }
  if (currentPage !== 'dashboard') navigate('dashboard');
  const out = $('dashboard-output');
  const btns = qsa('#tab-dashboard .page-actions [onclick^="serverAction"]');
  const btn = btns.find((b) => b.getAttribute('onclick').includes(`'${action}'`));
  btns.forEach((b) => (b.disabled = true));
  setBtnLoading(btn, true);
  out.textContent = `Running ${action}...`;
  setConsoleState(out, 'running');
  try {
    const r = await api(`/api/server/${action}`, { method: 'POST' });
    out.textContent = (r.stdout || '') + (r.stderr || '') || `${action} sent.`;
    const failed = r.code && r.code !== 0;
    setConsoleState(out, failed ? 'error' : 'success');
    if (failed) toast('error', `Server ${action} failed`, (r.stderr || '').trim().slice(0, 200));
    else toast('success', `Server ${action} sent`, 'Status will refresh in a moment.');
    recordEvent(failed ? 'bad' : 'accent', `Server ${action} ${failed ? 'failed' : 'requested'}`, 'from this dashboard', { start: 'play', stop: 'stop' }[action]);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
    setConsoleState(out, 'error');
    toast('error', `Server ${action} failed`, e.message);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    setBtnLoading(btn, false);
  }
  setTimeout(refreshStatus, 1500);
  setTimeout(refreshStatus, 6000);
}

function refreshAll() {
  refreshStatus();
  loadSaveHealth();
  loadInfo();
  pollStats();
  loadPlayers();
}

// ---- World save health (API: GET /api/save-health) ----
let lastSaveHealth = null;

async function loadSaveHealth() {
  if (!$('kpi-save')) return;
  try {
    const r = await api('/api/save-health');
    lastSaveHealth = r;
    renderSaveHealth(r);
  } catch (e) {
    if (!lastSaveHealth) {
      $('kpi-save').innerHTML = '<span class="muted">—</span>';
      $('kpi-save-foot').textContent = e.message;
    }
  }
}

function renderSaveHealth(r) {
  const val = $('kpi-save');
  const foot = $('kpi-save-foot');
  if (!val || !foot) return;
  const ago = r.lastSaveTs ? timeAgo(r.lastSaveTs) : 'never';
  const everyMin = Math.round((r.intervalSec || 1800) / 60);
  let tone;
  let label;
  let note;
  if (r.state === 'stopped') {
    tone = 'warn';
    label = 'Server stopped';
    note = r.lastSaveTs ? `Last save ${ago}` : 'No save files found';
  } else if (r.state === 'unknown') {
    tone = 'warn';
    label = 'No save found';
    note = 'The world is created the first time the server starts (check paths.worldDir if it already ran)';
  } else if (r.state === 'waiting') {
    const left = Math.max(0, (r.intervalSec || 1800) - Math.floor((Date.now() - (r.serverStartTs || Date.now())) / 1000));
    tone = 'good';
    label = 'Waiting for autosave';
    note = `First autosave in about ${Math.max(1, Math.round(left / 60))} min · every ${everyMin} min`;
  } else if (r.state === 'ok') {
    tone = 'good';
    label = ago;
    note = `Autosave every ${everyMin} min`;
  } else if (r.state === 'late') {
    tone = 'warn';
    label = ago;
    note = `Later than expected (autosave every ${everyMin} min)`;
  } else {
    tone = 'bad';
    label = ago;
    note = 'Not saving — progress is only in memory until it does';
  }
  val.innerHTML = `<span class="kpi-health ${tone}" style="display:flex;align-items:center;gap:10px"><span class="kpi-health-dot"></span><span>${esc(label)}</span></span>`;
  foot.textContent = note;
  foot.title = r.lastSaveTs ? `${note} · ${new Date(r.lastSaveTs).toLocaleString()}` : note;
}

// ---- Resource usage (API: GET /api/system/stats) ----
const statHistory = store.get('vg.stats', []).filter((p) => Date.now() - p.t < 15 * 60 * 1000);
const CHART_WINDOW = 15 * 60 * 1000;

function toneFor(p) {
  return p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'good';
}

async function pollStats() {
  try {
    const r = await api('/api/system/stats');
    $('stat-cpu').innerHTML = `${r.cpuPercent}<span class="unit">%</span>`;
    $('stat-cpu-sub').textContent = `${r.cores} cores · load ${(r.loadAvg || []).map((n) => n.toFixed(2)).join(' / ')}`;
    if (!r.valheimRunning) {
      $('stat-valheim-cpu').textContent = '—';
      $('stat-valheim-cpu-sub').textContent = 'Not running';
    } else if (r.valheimCpuPercent == null) {
      $('stat-valheim-cpu').textContent = '…';
      $('stat-valheim-cpu-sub').textContent = 'Warming up (needs a second poll)';
    } else {
      $('stat-valheim-cpu').innerHTML = `${r.valheimCpuPercent}<span class="unit">%</span>`;
      $('stat-valheim-cpu-sub').textContent = `PID ${r.valheimPid} · % of one core`;
    }
    $('stat-mem').innerHTML = `${r.memPercent ?? '—'}<span class="unit">%</span>`;
    $('stat-mem-sub').textContent = `${(r.memUsedMB / 1024).toFixed(1)} / ${(r.memTotalMB / 1024).toFixed(1)} GB`;
    $('stat-disk').innerHTML = `${r.diskPercent ?? '—'}<span class="unit">%</span>`;
    $('stat-disk-sub').textContent = `${r.diskUsed} of ${r.diskTotal} used`;
    const bar = $('stat-disk-bar');
    bar.style.width = (r.diskPercent || 0) + '%';
    bar.className = 'meter-fill ' + toneFor(r.diskPercent || 0);

    renderHostDetails(r);
    statHistory.push({ t: Date.now(), cpu: r.cpuPercent, mem: r.memPercent, valheimCpu: r.valheimCpuPercent });
    while (statHistory.length && Date.now() - statHistory[0].t > CHART_WINDOW) statHistory.shift();
    store.set('vg.stats', statHistory);
    drawSparklines();
    renderUsageChart();
  } catch (e) {
    // non-fatal
    if (!statHistory.length) {
      ['stat-cpu', 'stat-valheim-cpu', 'stat-mem', 'stat-disk'].forEach((id) => ($(id).textContent = '—'));
      $('stat-cpu-sub').textContent = 'Stats unavailable';
    }
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawSparkline(svg, points, color) {
  if (!svg) return;
  const W = 200;
  const H = 36;
  if (points.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const n = points.length;
  const xy = points.map((p, i) => [(i / (n - 1)) * W, H - 2 - (Math.min(100, Math.max(0, p)) / 100) * (H - 4)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  svg.innerHTML = `<path class="spark-area" d="${d}L${W},${H}L0,${H}Z" fill="${color}"/><path class="spark-line" d="${d}" stroke="${color}"/>`;
}

function drawSparklines() {
  const last = statHistory.slice(-40);
  drawSparkline($('chart-cpu'), last.map((p) => p.cpu), cssVar('--series-cpu'));
  drawSparkline($('chart-valheim-cpu'), last.map((p) => p.valheimCpu), cssVar('--series-valheim'));
  drawSparkline($('chart-mem'), last.map((p) => p.mem), cssVar('--series-mem'));
}

let chartHoverIndex = null;
function renderUsageChart() {
  const svg = $('usage-chart');
  const wrap = $('usage-chart-wrap');
  if (!svg || !wrap || !wrap.offsetWidth) return;
  const pts = statHistory.filter((p) => p.cpu != null);
  $('usage-chart-empty').classList.toggle('hidden', pts.length >= 2);
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const m = { l: 34, r: 8, t: 8, b: 22 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const now = pts.length ? pts[pts.length - 1].t : Date.now();
  const t0 = Math.min(now - 60 * 1000, pts.length ? Math.max(pts[0].t, now - CHART_WINDOW) : now - CHART_WINDOW);
  const x = (t) => m.l + ((t - t0) / Math.max(1, now - t0)) * iw;
  const y = (v) => m.t + ih - (Math.min(100, Math.max(0, v)) / 100) * ih;

  let g = `<defs><linearGradient id="grad-cpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${cssVar('--series-cpu')}" stop-opacity=".22"/><stop offset="1" stop-color="${cssVar('--series-cpu')}" stop-opacity="0"/></linearGradient></defs>`;
  g += '<g class="grid">';
  [0, 25, 50, 75, 100].forEach((v) => {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 3.5}" text-anchor="end">${v}%</text>`;
  });
  g += '</g><g class="xaxis">';
  if (pts.length >= 2) {
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((now - t0) * i) / ticks;
      const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
      const label = now - t0 < 10 * 60 * 1000 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : fmtClock(t);
      g += `<text x="${x(t)}" y="${H - 5}" text-anchor="${anchor}">${i === ticks ? 'now' : label}</text>`;
    }
  }
  g += '</g>';

  if (pts.length >= 2) {
    const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const cpuD = line('cpu');
    g += `<path class="area cpu" d="${cpuD}L${x(pts[pts.length - 1].t)},${y(0)}L${x(pts[0].t)},${y(0)}Z"/>`;
    g += `<path class="line cpu" d="${cpuD}"/>`;
    const valheimPts = pts.filter((p) => p.valheimCpu != null);
    if (valheimPts.length >= 2) {
      const valheimD = valheimPts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.valheimCpu).toFixed(1)}`).join('');
      g += `<path class="line valheim" d="${valheimD}"/>`;
    }
    g += `<path class="line mem" d="${line('mem')}"/>`;
    if (chartHoverIndex != null && pts[chartHoverIndex]) {
      const p = pts[chartHoverIndex];
      g += `<line class="crosshair" x1="${x(p.t)}" x2="${x(p.t)}" y1="${m.t}" y2="${m.t + ih}"/>`;
      g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.cpu)}" r="4.5" fill="${cssVar('--series-cpu')}"/>`;
      if (p.valheimCpu != null) {
        g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.valheimCpu)}" r="4.5" fill="${cssVar('--series-valheim')}"/>`;
      }
      g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.mem)}" r="4.5" fill="${cssVar('--series-mem')}"/>`;
    }
    g += `<rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" id="usage-chart-hit"/>`;
  }
  svg.innerHTML = g;

  const hit = $('usage-chart-hit');
  const tip = $('usage-chart-tip');
  if (!hit) return;
  hit.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(x(p.t) - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== chartHoverIndex) {
      chartHoverIndex = best;
      renderUsageChart();
    }
    const p = pts[best];
    tip.innerHTML = `<div class="tip-time">${new Date(p.t).toLocaleTimeString()}</div>
      <div class="tip-row"><span class="swatch s-cpu"></span>CPU (VPS)<b>${p.cpu}%</b></div>
      ${p.valheimCpu != null ? `<div class="tip-row"><span class="swatch s-valheim"></span>CPU (Valheim)<b>${p.valheimCpu}%</b></div>` : ''}
      <div class="tip-row"><span class="swatch s-mem"></span>Memory<b>${p.mem}%</b></div>`;
    tip.classList.remove('hidden');
    const px = x(p.t);
    const tw = tip.offsetWidth;
    tip.style.left = (px + 14 + tw > W ? px - tw - 14 : px + 14) + 'px';
  };
  hit.onmouseleave = () => {
    chartHoverIndex = null;
    tip.classList.add('hidden');
    renderUsageChart();
  };
}
if (window.ResizeObserver) new ResizeObserver(() => renderUsageChart()).observe($('usage-chart-wrap'));

// ---- Players (API: GET /api/players, SSE /api/players/live) ----
const AVATAR_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767', '#008300'];
const playerSince = {};
let lastPlayerSet = null;
let initialPlayersRender = true;

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function renderPlayers(players, details) {
  const list = $('players-list');
  players = players || [];
  const knownSince = {};
  (details || []).forEach((d) => {
    if (d && d.name) knownSince[d.name] = d.since || null;
  });
  const now = Date.now();
  const set = new Set(players);
  if (lastPlayerSet) {
    players.forEach((p) => {
      if (!lastPlayerSet.has(p)) recordEvent('good', `${p} joined`, 'detected from log activity', 'users');
    });
    lastPlayerSet.forEach((p) => {
      if (!set.has(p)) recordEvent('info', `${p} left`, '', 'users');
    });
  }
  players.forEach((p) => {
    if (p in knownSince) playerSince[p] = knownSince[p];
    else if (!(p in playerSince)) playerSince[p] = lastPlayerSet && lastPlayerSet.size !== undefined && !initialPlayersRender ? now : null;
  });
  Object.keys(playerSince).forEach((p) => {
    if (!set.has(p)) delete playerSince[p];
  });
  lastPlayerSet = set;
  initialPlayersRender = false;

  $('players-count').textContent = players.length;
  $('kpi-players').innerHTML = `${players.length}`;
  $('kpi-players-foot').textContent = players.length ? players.slice(0, 3).join(', ') + (players.length > 3 ? ` +${players.length - 3}` : '') : 'Nobody online';

  if (!players.length) {
    list.innerHTML = `<li style="display:block;padding:0">${emptyState({ iconName: 'users', title: 'No one online', text: 'Or none detected in recent log activity.', small: true })}</li>`;
    return;
  }
  list.innerHTML = players
    .map(
      (name) => `<li><span class="avatar" style="--c:${avatarColor(name)}">${esc(name.slice(0, 2).toUpperCase())}</span>
        <span class="player-name">${esc(name)}</span>
        <span class="player-since" data-tip="${playerSince[name] ? 'Online since ' + new Date(playerSince[name]).toLocaleTimeString() : 'Joined before this page started watching'}">${playerSince[name] ? fmtDuration(now - playerSince[name]) : ''}</span>
        <span class="online-dot" aria-label="online"></span></li>`
    )
    .join('');
}

async function loadPlayers() {
  const list = $('players-list');
  if (!lastPlayerSet) list.innerHTML = skeletonLis(2);
  try {
    const r = await api('/api/players');
    renderPlayers(r.players);
  } catch (e) {
    list.innerHTML = `<li style="display:block;padding:0">${emptyState({ title: 'Could not load players', text: esc(e.message), error: true, small: true })}</li>`;
  }
}

let playersLiveSource = null;

function startPlayersLive() {
  if (playersLiveSource || activeGame === 'zomboid') return;
  playersLiveSource = new EventSource('/api/players/live');
  playersLiveSource.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      renderPlayers(d.players, d.details);
    } catch (err) {
      // ignore malformed frame
    }
  };
  playersLiveSource.onerror = () => {
    if (playersLiveSource) {
      playersLiveSource.close();
      playersLiveSource = null;
    }
    // Reconnect after a short delay rather than leaving the panel stale forever
    // — but not if the game switch has since moved to Zomboid.
    if (activeGame !== 'zomboid') setTimeout(startPlayersLive, 5000);
  };
}

function stopPlayersLive() {
  if (playersLiveSource) {
    playersLiveSource.close();
    playersLiveSource = null;
  }
}

/* ==========================================================================
   6. Streaming helpers (SSE + chunked POST)
   ========================================================================== */

// SSE stream into a <pre>. Resolves with the exit code string (or null).
function streamToConsole(url, el, onDone) {
  el.textContent = '';
  setConsoleState(el, 'running');
  return new Promise((resolve) => {
    const es = new EventSource(url);
    let finished = false;
    es.onmessage = (e) => {
      el.textContent += e.data + '\n';
      el.scrollTop = el.scrollHeight;
    };
    es.addEventListener('done', (e) => {
      const code = e.data;
      finished = true;
      el.textContent += `[finished — exit code ${code}${code === '0' ? ', no output means the command ran successfully with nothing new to report' : ''}]\n`;
      el.scrollTop = el.scrollHeight;
      es.close();
      setConsoleState(el, code === '0' ? 'success' : 'error', code === '0' ? 'Completed' : `Exit ${code}`);
      if (onDone) onDone();
      resolve(code);
    });
    es.onerror = () => {
      if (finished) return;
      el.textContent += '[stream closed]\n';
      es.close();
      setConsoleState(el, 'error', 'Stream closed');
      if (onDone) onDone();
      resolve(null);
    };
  });
}

// Shared helper: POST to url, stream the plain-text response into outEl as
// it arrives. Used by every mod action (install/update/remove/categorize)
// and their bulk equivalents.
async function streamPost(url, body, outEl) {
  setConsoleState(outEl, 'running');
  let full = '';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      outEl.textContent += chunk;
      outEl.scrollTop = outEl.scrollHeight;
    }
    if (!r.ok && !full.includes('[error]')) {
      full += `\n[error] HTTP ${r.status}\n`;
      outEl.textContent += `\n[error] HTTP ${r.status}\n`;
    }
  } catch (e) {
    full += `\n[error] ${e.message}\n`;
    outEl.textContent += `\n[error] ${e.message}\n`;
  }
  setConsoleState(outEl, outcomeOf(full));
  return full;
}

/* ==========================================================================
   7. Mods
   ========================================================================== */

function sourceLabel(s) {
  return s === 'hexium' ? 'Hexium' : 'Thunderstore';
}
function sourceBadge(s) {
  return `<span class="source-badge ${esc(s)}">${sourceLabel(s)}</span>`;
}

// ---- Mods sub-tabs ----
let currentModsTab = 'installed';
let requirementsLoaded = false;
function showModsTab(tab) {
  currentModsTab = tab;
  qsa('.subtab').forEach((b) => {
    const on = b.dataset.subtab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  qsa('.subpanel').forEach((p) => p.classList.toggle('active', p.id === 'sub-' + tab));
  if (tab === 'requirements' && !requirementsLoaded) loadRequirements();
  if (tab === 'browse') renderSearchEmpty();
}
qsa('.subtab').forEach((b) => (b.onclick = () => showModsTab(b.dataset.subtab)));

function refreshModsPage() {
  loadInstalledMods();
  loadDisabledMods();
  if (requirementsLoaded) loadRequirements();
}

// ---- Pending changes → one consolidated Discord message (API: POST /api/mods/notify-summary) ----
// Every successful install/update/remove/categorize gets logged here instead
// of notifying Discord immediately. Nothing is sent until the person clicks
// "Notify Discord" — one consolidated message for however many changes piled
// up in between, instead of a message per action.
const pendingChanges = [];
const CHANGE_META = {
  install: { label: 'Installed', tone: 'good', icon: 'plus' },
  update: { label: 'Updated', tone: 'good', icon: 'arrow-up-circle' },
  remove: { label: 'Removed', tone: 'bad', icon: 'trash' },
  disable: { label: 'Disabled', tone: 'warn', icon: 'pause' },
  enable: { label: 'Re-enabled', tone: 'good', icon: 'play' },
  codes: { label: 'Generated', tone: 'accent', icon: 'key' },
};

function logChange(type, name, extra) {
  pendingChanges.push({ type, name, ...extra });
  renderPendingChanges();
  const meta = CHANGE_META[type] || { label: type, tone: 'info', icon: 'activity' };
  const detail = [extra && extra.version ? `v${extra.version}` : '', extra && extra.source ? sourceLabel(extra.source) : ''].filter(Boolean).join(' · ');
  recordEvent(meta.tone === 'bad' ? 'warn' : meta.tone, `${meta.label} ${name}`, detail, meta.icon);
  toast('success', `${meta.label} ${name}`, detail ? `${detail} — queued for Discord summary` : 'Queued for Discord summary');
}

function renderPendingChanges() {
  const n = pendingChanges.length;
  const countEl = $('pending-changes-count');
  const btn = $('notify-discord-btn');
  countEl.textContent = n ? `${pluralize(n, 'pending change')} for Discord` : 'No pending changes';
  btn.disabled = n === 0;
  const badge = $('pending-badge');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  $('pending-list').innerHTML = pendingChanges
    .map((c) => {
      const meta = CHANGE_META[c.type] || { label: c.type, tone: 'info' };
      return `<li><span class="badge ${meta.tone === 'accent' ? 'accent' : meta.tone}">${esc(meta.label)}</span><span class="pl-name">${esc(c.name)}</span>${c.version ? `<span class="ver">v${esc(c.version)}</span>` : ''}</li>`;
    })
    .join('');
}

async function sendDiscordSummary() {
  if (!pendingChanges.length) return toast('info', 'Nothing to send', 'No pending changes yet.');
  const btn = $('notify-discord-btn');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/mods/notify-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: pendingChanges }),
    });

    if (r.ok) {
      const n = pendingChanges.length;
      pendingChanges.length = 0;
      renderPendingChanges();
      toast('success', 'Discord notified', `Sent a summary of ${pluralize(n, 'change')}.`);
      recordEvent('accent', 'Discord summary sent', pluralize(n, 'change'), 'send');
    } else {
      // Real failure — pendingChanges is deliberately NOT cleared, so the
      // person can just retry once the webhook issue is fixed.
      toast('error', 'Discord notification failed', (r.error || 'unknown error') + ' — your changes are still queued; nothing was lost.');
    }
  } catch (e) {
    toast('error', 'Failed to send', e.message + ' — changes are still queued.');
  } finally {
    setBtnLoading(btn, false);
    btn.disabled = pendingChanges.length === 0;
  }
}

// ---- Installed mods (API: GET /api/mods/installed, GET /api/mods/all-entries) ----
const STATUS_LABELS = {
  required: { label: 'Required', color: 'var(--cat-required)' },
  adminOnly: { label: 'Admin-only', color: 'var(--cat-admin)' },
  serverOnly: { label: 'Server-only', color: 'var(--cat-server)' },
  optional: { label: 'Optional', color: 'var(--cat-optional)' },
  unknown: { label: 'Unlisted', color: 'var(--cat-unknown)' },
};
const STATUS_ORDER = ['required', 'adminOnly', 'serverOnly', 'optional', 'unknown'];
const BUCKET_OPTIONS = [
  ['required', 'Required'],
  ['optional', 'Optional'],
  ['admin', 'Admin-only'],
  ['server', 'Server-only'],
];
const statusToBucketValue = { required: 'required', optional: 'optional', adminOnly: 'admin', serverOnly: 'server' };
const bucketLabel = Object.fromEntries(BUCKET_OPTIONS);

let lastInstalledMods = [];
// Every known Mods.yaml entry (all four buckets), used to populate the
// "Link to existing entry" picker on an Unlisted mod row.
let allModEntries = [];
const selectedMods = new Set();
// Remembers which category sections are expanded across re-renders.
const groupOpenState = { required: true, adminOnly: true, serverOnly: true, optional: true, unknown: true };
let modFilter = 'all';
let modSort = { key: 'name', dir: 1 };

// Two-phase load so the list appears fast:
//   1. Instantly: the last full result cached in this browser (if any).
//   2. ~1 s: GET /api/mods/installed?updates=0 — folders + categories only,
//      no network-bound update check. Rendered right away.
//   3. Then: GET /api/mods/installed (full) — fills in update badges.
let updatesPending = false;
let modsLoadSeq = 0;

function carryOverUpdates(fresh, previous) {
  // While the full check runs, keep the previous update info for mods whose
  // installed version hasn't changed, so badges don't flicker away.
  const prev = new Map(previous.map((m) => [m.name, m]));
  return fresh.map((m) => {
    const old = prev.get(m.name);
    if (!m.update && old && old.update && old.currentVersion === m.currentVersion && !m.ignoreUpdates) return { ...m, update: old.update };
    return m;
  });
}

async function loadInstalledMods() {
  const seq = ++modsLoadSeq;
  const tbody = $('installed-mods-groups');
  if (!lastInstalledMods.length) {
    const cached = store.get('vg.mods', null);
    if (cached && Array.isArray(cached.mods) && cached.mods.length) {
      lastInstalledMods = cached.mods;
      updatesPending = true;
      renderInstalledMods();
      updateModKpis();
    } else tbody.innerHTML = skeletonRows(8, 6);
  } else $('mods-table').style.opacity = '0.6';
  const refreshBtn = qs('#tab-mods .page-actions .btn-secondary');
  setBtnLoading(refreshBtn, true);

  // Phase 2 — fast list.
  try {
    const [r, entriesR] = await Promise.all([
      api('/api/mods/installed?updates=0'),
      api('/api/mods/all-entries').catch(() => ({ entries: [] })), // best-effort — the Link picker just won't populate if this fails
    ]);
    if (seq !== modsLoadSeq) return;
    allModEntries = entriesR.entries || [];
    selectedMods.clear();
    lastInstalledMods = carryOverUpdates(r.mods || [], lastInstalledMods);
    updatesPending = true;
    if (r.enforcerRead === false && lastInstalledMods.length) {
      toast('warn', 'Mods.yaml not readable', 'Categories show as Unlisted until ValheimEnforcer has written Mods.yaml.');
    }
    renderInstalledMods();
    updateModKpis();
  } catch (e) {
    if (seq !== modsLoadSeq) return;
    updatesPending = false;
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${emptyState({
      title: 'Could not load installed mods',
      text: esc(e.message),
      error: true,
      action: '<button class="btn btn-secondary btn-sm" onclick="loadInstalledMods()">Try again</button>',
    })}</td></tr>`;
    toast('error', 'Failed to load mods', e.message);
    $('mods-table').style.opacity = '';
    setBtnLoading(refreshBtn, false);
    return;
  }
  $('mods-table').style.opacity = '';
  setBtnLoading(refreshBtn, false);

  // Phase 3 — update check (slow part), filled in when ready.
  try {
    const full = await api('/api/mods/installed');
    if (seq !== modsLoadSeq) return;
    lastInstalledMods = full.mods || [];
    store.set('vg.mods', { t: Date.now(), mods: lastInstalledMods });
  } catch (e) {
    if (seq !== modsLoadSeq) return;
    toast('warn', 'Update check failed', e.message);
  }
  updatesPending = false;
  renderInstalledMods();
  updateModKpis();
}

function updateModKpis() {
  const updates = lastInstalledMods.filter((m) => m.update && m.update.updateAvailable).length;
  const unlisted = lastInstalledMods.filter((m) => (m.status || 'unknown') === 'unknown').length;
  $('mk-installed').textContent = lastInstalledMods.length;
  $('mk-updates').innerHTML = updatesPending
    ? `${updates || ''} <span class="badge"><span class="spinner xs"></span>checking…</span>`
    : updates
    ? `${updates} <span class="badge good">${icon('arrow-up')}available</span>`
    : '0';
  $('mk-unlisted').textContent = unlisted;
  const sb = $('sb-updates-count');
  sb.textContent = updates;
  sb.classList.toggle('hidden', !updates);
}

async function linkFolderToEntry(folderName, guid) {
  const out = $('mods-output');
  out.textContent = `Linking ${folderName} to ${guid}...\n`;
  const result = await streamPost('/api/mods/pin-folder', { guid, folderName }, out);
  toastFromResult(result, `Linked ${folderName}`, `Linking ${folderName} failed`);
  loadInstalledMods();
}

async function setIgnoreUpdates(name, ignore) {
  const out = $('mods-output');
  out.textContent = `${ignore ? 'Ignoring' : 'Re-enabling'} update checks for ${name}...\n`;
  const result = await streamPost('/api/mods/ignore-updates', { query: name, ignore }, out);
  toastFromResult(result, ignore ? `Ignoring updates for ${name}` : `Update checks re-enabled for ${name}`, 'Request failed');
  loadInstalledMods();
}

function toastFromResult(result, okTitle, failTitle) {
  if (outcomeOf(result) === 'error') toast('error', failTitle, 'See the action log for details.');
  else toast('success', okTitle);
}

function visibleMods() {
  const filterText = ($('mod-filter-input').value || '').toLowerCase();
  const updatesOnly = $('mod-updates-only').checked;
  return lastInstalledMods.filter(
    (m) =>
      m.name.toLowerCase().includes(filterText) &&
      (modFilter === 'all' || (m.status || 'unknown') === modFilter) &&
      (!updatesOnly || (m.update && m.update.updateAvailable))
  );
}

function setModFilter(key) {
  modFilter = key;
  if (currentPage !== 'mods') navigate('mods');
  showModsTab('installed');
  renderInstalledMods();
}
function setUpdatesOnly(on) {
  $('mod-updates-only').checked = on;
  setModFilter('all');
}

function renderCategoryChips() {
  const counts = { all: lastInstalledMods.length };
  STATUS_ORDER.forEach((k) => (counts[k] = lastInstalledMods.filter((m) => (m.status || 'unknown') === k).length));
  const chips = [['all', 'All', null], ...STATUS_ORDER.filter((k) => counts[k]).map((k) => [k, STATUS_LABELS[k].label, STATUS_LABELS[k].color])];
  $('mod-category-chips').innerHTML = chips
    .map(
      ([k, label, color]) =>
        `<button class="chip${modFilter === k ? ' active' : ''}" data-filter="${k}" aria-pressed="${modFilter === k}">${color ? `<span class="chip-dot" style="--c:${color}"></span>` : ''}${label}<span class="chip-n">${counts[k]}</span></button>`
    )
    .join('');
  qsa('#mod-category-chips .chip').forEach((c) => (c.onclick = () => setModFilter(c.dataset.filter)));
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  status: (a, b) => STATUS_ORDER.indexOf(a.status || 'unknown') - STATUS_ORDER.indexOf(b.status || 'unknown') || a.name.localeCompare(b.name),
  version: (a, b) => String(a.currentVersion || '').localeCompare(String(b.currentVersion || ''), undefined, { numeric: true }) || a.name.localeCompare(b.name),
  update: (a, b) => {
    const au = a.update && a.update.updateAvailable ? 1 : 0;
    const bu = b.update && b.update.updateAvailable ? 1 : 0;
    return bu - au || a.name.localeCompare(b.name);
  },
};

qsa('.th-sort').forEach((b) => {
  b.onclick = () => {
    const key = b.dataset.sort;
    modSort = { key, dir: modSort.key === key ? -modSort.dir : 1 };
    renderInstalledMods();
  };
});

function renderInstalledMods() {
  const tbody = $('installed-mods-groups');
  const countEl = $('installed-mods-count');
  renderCategoryChips();
  const mods = visibleMods();
  countEl.textContent = !lastInstalledMods.length ? '' : mods.length === lastInstalledMods.length ? lastInstalledMods.length : `${mods.length}/${lastInstalledMods.length}`;

  qsa('.th-sort').forEach((b) => {
    const on = b.dataset.sort === modSort.key;
    b.classList.toggle('sorted', on);
    b.querySelector('use').setAttribute('href', on ? (modSort.dir === 1 ? '#i-arrow-down' : '#i-arrow-up') : '#i-chevrons-up-down');
    b.closest('th').setAttribute('aria-sort', on ? (modSort.dir === 1 ? 'ascending' : 'descending') : 'none');
  });

  const sorter = SORTERS[modSort.key] || SORTERS.name;
  mods.sort((a, b) => sorter(a, b) * modSort.dir);

  tbody.innerHTML = '';
  if (!lastInstalledMods.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${emptyState({
      iconName: 'package',
      title: 'No mods found',
      text: 'Nothing in the plugins folder — check <code>paths.pluginsDir</code> in config.json, or add your first mod.',
      action: `<button class="btn btn-primary btn-sm" onclick="showModsTab('browse')">${icon('plus')}Browse mods</button>`,
    })}</td></tr>`;
    updateBulkBar();
    return;
  }
  if (!mods.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">${emptyState({
      iconName: 'filter',
      title: 'No mods match these filters',
      action: '<button class="btn btn-secondary btn-sm" onclick="clearModFilters()">Clear filters</button>',
    })}</td></tr>`;
    updateBulkBar();
    return;
  }

  const grouped = $('mod-group-toggle').checked && modSort.key !== 'status';
  $('mods-table').classList.toggle('grouped', grouped);
  const frag = document.createDocumentFragment();
  if (grouped) {
    STATUS_ORDER.forEach((statusKey) => {
      const group = mods.filter((m) => (m.status || 'unknown') === statusKey);
      if (!group.length) return;
      const st = STATUS_LABELS[statusKey];
      const head = document.createElement('tr');
      head.className = 'group-row' + (groupOpenState[statusKey] ? '' : ' collapsed');
      head.tabIndex = 0;
      head.setAttribute('aria-expanded', groupOpenState[statusKey]);
      head.innerHTML = `<td colspan="6"><div class="group-label">${icon('chevron-down', 'chev')}<span class="badge cat" style="--c:${st.color}">${st.label}</span><span class="n">${group.length}</span></div></td>`;
      const toggle = () => {
        groupOpenState[statusKey] = !groupOpenState[statusKey];
        renderInstalledMods();
      };
      head.onclick = toggle;
      head.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      };
      frag.appendChild(head);
      if (groupOpenState[statusKey]) group.forEach((mod) => frag.appendChild(buildModRow(mod)));
    });
  } else {
    mods.forEach((mod) => frag.appendChild(buildModRow(mod)));
  }
  tbody.appendChild(frag);
  updateBulkBar();
}

function clearModFilters() {
  $('mod-filter-input').value = '';
  $('mod-updates-only').checked = false;
  modFilter = 'all';
  renderInstalledMods();
}

function buildModRow(mod) {
  const st = STATUS_LABELS[mod.status] || STATUS_LABELS.unknown;
  const tr = document.createElement('tr');
  if (selectedMods.has(mod.name)) tr.classList.add('selected');

  // Update cell — same three states as before, plus an explicit "up to date".
  let updateHtml = '<span class="muted">—</span>';
  if (mod.ignoreUpdates) {
    // Update checks are skipped server-side for this mod — a quiet note so
    // it's clear this is deliberate, not the mod simply being current.
    updateHtml = `<span class="badge" data-tip="Update checks are skipped for this mod">${icon('eye-off')}Ignored</span>`;
  } else if (mod.update && mod.update.updateAvailable) {
    // installedFromRecord means this is checked against the EXACT source this
    // mod was actually installed/updated from last, not a name-based guess.
    const tip = mod.update.installedFromRecord
      ? "Matched via this mod's own install/update record — the exact source it was actually downloaded from, not a name-based guess."
      : `Best name-based match on ${sourceLabel(mod.update.source)} (${mod.update.namespace}-${mod.update.packageName})`;
    updateHtml = `<span class="update-badge" data-tip="${esc(tip)}">${icon('arrow-up-circle')}v${esc(mod.update.latestVersion)}</span>${sourceBadge(mod.update.source)}${mod.update.installedFromRecord ? `<span class="badge info" data-tip="${esc(tip)}">${icon('check')}verified</span>` : ''}`;
  } else if (mod.update && mod.update.versionRegression) {
    // The "latest available" match came back LOWER than what's already
    // running — almost always a different, unrelated package.
    updateHtml = `<span class="badge warn" data-tip="${esc(
      `Matched ${mod.update.namespace}-${mod.update.packageName} v${mod.update.latestVersion} on ${sourceLabel(mod.update.source)}, which is LOWER than the installed v${mod.currentVersion} — likely the wrong package, not a real update. Verify manually or check via generate-codes.py's hash verification.`
    )}">${icon('alert')}Unverifiable match</span>`;
  } else if (updatesPending && mod.currentVersion && !mod.update) {
    updateHtml = `<span class="muted" style="display:inline-flex;align-items:center;gap:6px"><span class="spinner xs"></span>Checking…</span>`;
  } else if (mod.update) {
    updateHtml = `<span class="muted" style="display:inline-flex;align-items:center;gap:5px">${icon('check')}Up to date</span>`;
  } else if (mod.currentVersion) {
    updateHtml = '<span class="muted">Up to date</span>';
  }

  const pendingBucket = pendingCategorization[mod.name];
  const pinnedAs = mod.pins && (mod.pins.thunderstore || mod.pins.hexium);
  const pinnedSource = mod.pins && mod.pins.thunderstore ? 'thunderstore' : 'hexium';
  tr.innerHTML = `
    <td class="col-check"></td>
    <td class="col-name"><div class="mod-cell"><span class="mod-name">${esc(mod.name)}</span>${
      pendingBucket ? `<span class="mod-sub"><span class="badge warn">${icon('clock')}Pending: ${esc(bucketLabel[pendingBucket] || pendingBucket)}</span></span>` : ''
    }${
      pinnedAs ? `<span class="mod-sub"><span class="badge" data-tip="Package identity pinned — see the ⋯ menu to change or unpin. The version isn't frozen; it always tracks Mods.yaml.">${icon('link')}Pinned: ${esc(pinnedAs)} (${sourceLabel(pinnedSource)})</span></span>` : ''
    }</div></td>
    <td class="col-cat"><span class="badge cat" style="--c:${st.color}" ${mod.reason ? `data-tip="${esc(mod.reason)}"` : ''}>${st.label}</span></td>
    <td class="col-version"><span class="ver">${mod.currentVersion ? 'v' + esc(mod.currentVersion) : '—'}</span></td>
    <td><div class="update-cell">${updateHtml}</div></td>
    <td class="col-actions"><div class="row-actions"></div></td>`;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'mod-select-checkbox';
  checkbox.checked = selectedMods.has(mod.name);
  checkbox.setAttribute('aria-label', `Select ${mod.name}`);
  checkbox.onchange = () => {
    if (checkbox.checked) selectedMods.add(mod.name);
    else selectedMods.delete(mod.name);
    tr.classList.toggle('selected', checkbox.checked);
    updateBulkBar();
  };
  tr.querySelector('.col-check').appendChild(checkbox);

  const actions = tr.querySelector('.row-actions');

  if (pendingBucket) {
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-warn btn-xs';
    applyBtn.textContent = `Apply: ${bucketLabel[pendingBucket] || pendingBucket}`;
    applyBtn.setAttribute('data-tip', 'Move this mod into the category you chose at install time (after a restart has let ValheimEnforcer detect it)');
    applyBtn.onclick = () => applyCategorization(mod.name, pendingBucket);
    actions.appendChild(applyBtn);
  }

  if (mod.update && mod.update.updateAvailable) {
    const upBtn = document.createElement('button');
    upBtn.className = 'btn btn-good-soft btn-xs';
    upBtn.innerHTML = `${icon('arrow-up-circle')}Update`;
    upBtn.setAttribute('data-tip', 'Opens a prompt to confirm the source, author, and version before updating');
    upBtn.onclick = () => openUpdatePromptForMod(mod);
    actions.appendChild(upBtn);
  }

  // Category editor: select + save button that appears only when changed.
  const editor = document.createElement('span');
  editor.className = 'cat-editor';
  const catSelect = document.createElement('select');
  catSelect.className = 'select xs';
  catSelect.setAttribute('aria-label', `Category for ${mod.name}`);
  catSelect.setAttribute('data-tip', 'Recategorize this mod in Mods.yaml');
  BUCKET_OPTIONS.forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    catSelect.appendChild(opt);
  });
  const current = statusToBucketValue[mod.status];
  if (current) catSelect.value = current;
  else {
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Set category…';
    ph.disabled = true;
    catSelect.prepend(ph);
    catSelect.value = '';
  }
  const setBtn = document.createElement('button');
  setBtn.className = 'btn btn-primary btn-xs save';
  setBtn.innerHTML = `${icon('check')}Set`;
  setBtn.onclick = () => applyCategorization(mod.name, catSelect.value);
  catSelect.onchange = () => editor.classList.toggle('dirty', !!catSelect.value && catSelect.value !== current);
  editor.appendChild(catSelect);
  editor.appendChild(setBtn);
  actions.appendChild(editor);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'icon-btn sm';
  moreBtn.innerHTML = icon('more');
  moreBtn.setAttribute('aria-label', `More actions for ${mod.name}`);
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('data-tip', 'More actions');
  moreBtn.onclick = () => {
    const items = [
      { label: 'Manual update…', icon: 'wrench', onClick: () => manualUpdateMod(mod) },
    ];
    // Only meaningful once ValheimEnforcer actually has an entry for this mod.
    if (mod.status !== 'unknown') {
      items.push(
        mod.ignoreUpdates
          ? { label: 'Un-ignore updates', icon: 'eye', onClick: () => setIgnoreUpdates(mod.name, false) }
          : { label: 'Ignore updates', icon: 'eye-off', onClick: () => setIgnoreUpdates(mod.name, true) }
      );
    }
    // Unlisted can mean "already listed under a different GUID/name" — link
    // the folder onto the real existing entry instead of creating a duplicate.
    if (mod.status === 'unknown' && allModEntries.length) {
      items.push({ label: 'Link to existing entry…', icon: 'link', onClick: () => openLinkPicker(mod) });
    }
    // Pinning needs a real Mods.yaml entry (guid) to attach the override
    // to — same gating as Ignore updates above.
    if (mod.status !== 'unknown' && mod.guid) {
      items.push({ label: pinnedAs ? 'Change pinned package…' : 'Pin package identity…', icon: 'link', onClick: () => openPinPackageDialog(mod) });
      if (pinnedAs) {
        items.push({ label: 'Unpin package identity', icon: 'eye-off', onClick: () => unpinPackage(mod, pinnedSource) });
      }
    }
    items.push('sep');
    items.push({ label: 'Disable', icon: 'pause', tone: 'warn', onClick: () => disableMod(mod.name, mod.status, mod.reason) });
    items.push({ label: 'Remove', icon: 'trash', tone: 'danger', onClick: () => removeMod(mod.name, mod.status, mod.reason) });
    menu.open(moreBtn, items);
  };
  actions.appendChild(moreBtn);
  return tr;
}

async function openLinkPicker(mod) {
  let chosen = null;
  const listHtml = allModEntries
    .map(
      (entry, i) =>
        `<li data-i="${i}" role="option"><span>${esc(entry.name)}</span><span class="pk-meta">${esc(entry.bucket)}${entry.folderName ? ` · pinned: ${esc(entry.folderName)}` : ''}</span></li>`
    )
    .join('');
  const pending = dialog({
    title: `Link ${mod.name}`,
    tone: 'info',
    iconName: 'link',
    html: `<p>If this mod is already listed in Mods.yaml under a different name/GUID, pin this installed folder to that entry instead of creating a new one.</p>
      <div class="input-icon" style="margin-top:12px">${icon('search')}<input type="search" id="link-filter" placeholder="Filter entries…"></div>
      <ul class="pick-list" id="link-list" role="listbox">${listHtml}</ul>`,
    actions: [{ key: 'link', label: `${icon('link')}Link`, variant: 'btn-primary' }],
    collect: () => (chosen == null ? { error: 'Pick an entry first.' } : allModEntries[chosen].guid),
  });
  const list = $('link-list');
  list.onclick = (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    qsa('li', list).forEach((x) => x.classList.remove('sel'));
    li.classList.add('sel');
    chosen = +li.dataset.i;
  };
  $('link-filter').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    qsa('li', list).forEach((li) => (li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none'));
  };
  const res = await pending;
  if (res && res.key === 'link' && res.value) linkFolderToEntry(mod.name, res.value);
}

function toggleSelectAll(checked) {
  const visible = visibleMods();
  selectedMods.clear();
  if (checked) visible.forEach((m) => selectedMods.add(m.name));
  qsa('#installed-mods-groups .mod-select-checkbox').forEach((cb) => {
    cb.checked = checked;
    cb.closest('tr').classList.toggle('selected', checked);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('bulk-actions-bar');
  const countEl = $('bulk-selected-count');
  if (!bar) return;
  const n = selectedMods.size;
  countEl.textContent = n === 0 ? 'No mods selected' : `${pluralize(n, 'mod')} selected`;
  bar.classList.toggle('has-selection', n > 0);
  bar.querySelectorAll('button, select').forEach((el) => {
    if (el.id !== 'bulk-select-all') el.disabled = n === 0;
  });
  const all = $('bulk-select-all');
  const visible = visibleMods().length;
  all.checked = n > 0 && n >= visible;
  all.indeterminate = n > 0 && n < visible;
}

async function bulkUpdateSelected() {
  const out = $('mods-output');
  const targets = lastInstalledMods.filter((m) => selectedMods.has(m.name) && m.update && m.update.updateAvailable);
  const skipped = lastInstalledMods.filter((m) => selectedMods.has(m.name) && !(m.update && m.update.updateAvailable));
  if (!targets.length) {
    out.textContent = 'None of the selected mods have an update available.\n';
    toast('info', 'No updates in selection', 'None of the selected mods have an update available.');
    return;
  }

  // Bulk = one confirmation covering everything, rather than a full
  // source/author/version prompt per mod. Each mod uses its best-matched
  // source/version — for anything else, use that mod's individual Update.
  const ok = await confirmDialog({
    title: `Update ${pluralize(targets.length, 'mod')}?`,
    tone: 'info',
    html: `<p>Each mod uses its best-matched source, author and version:</p>
      <ul class="dialog-list">${targets
        .map((m) => `<li><strong>${esc(m.name)}</strong> <span class="mono">v${esc(m.currentVersion)} → v${esc(m.update.latestVersion)}</span> <span class="muted">${sourceLabel(m.update.source)}, ${esc(m.update.namespace)}</span></li>`)
        .join('')}</ul>
      ${skipped.length ? `<p class="muted">${pluralize(skipped.length, 'selected mod')} without an update will be skipped.</p>` : ''}
      <p class="muted">For a specific source, author, or version on any one mod, cancel and use its individual Update button instead.</p>`,
    confirmLabel: `Update ${targets.length}`,
  });
  if (!ok) return;

  out.textContent = `Updating ${targets.length} mod(s)...\n`;
  if (skipped.length) out.textContent += `Skipping (no update available): ${skipped.map((m) => m.name).join(', ')}\n`;
  for (const mod of targets) {
    out.textContent += `\n--- ${mod.name} → v${mod.update.latestVersion} (${sourceLabel(mod.update.source)}) ---\n`;
    const result = await streamPost(
      '/api/mods/install',
      {
        namespace: mod.update.namespace,
        name: mod.name,
        packageName: mod.update.packageName,
        version: mod.update.latestVersion,
        source: mod.update.source,
      },
      out
    );
    if (result.includes(`INSTALLED ${mod.name} ${mod.update.latestVersion}`)) {
      logChange('update', mod.name, { version: mod.update.latestVersion, source: mod.update.source });
    } else if (!result.includes('[error]')) {
      out.textContent += '\n[finished — no success marker seen; check the output above for what happened]\n';
    } else toast('error', `Update failed: ${mod.name}`, 'See the action log.');
  }
  loadInstalledMods();
}

async function bulkRemoveSelected() {
  const targets = lastInstalledMods.filter((m) => selectedMods.has(m.name));
  if (!targets.length) return;
  const blocked = targets.filter((m) => m.status === 'required' || m.status === 'adminOnly');
  const safe = targets.filter((m) => m.status !== 'required' && m.status !== 'adminOnly');

  let forceBlocked = false;
  if (!blocked.length) {
    const ok = await confirmDialog({
      title: `Remove ${pluralize(targets.length, 'mod')}?`,
      tone: 'danger',
      html: `<ul class="dialog-list">${targets.map((m) => `<li>${esc(m.name)}</li>`).join('')}</ul><p>The server should be stopped first.</p>`,
      confirmLabel: `Remove ${targets.length}`,
    });
    if (!ok) return;
  } else {
    const res = await dialog({
      title: `Remove ${pluralize(targets.length, 'mod')}?`,
      tone: 'danger',
      html: `<p>The server should be stopped first.</p>
        <p><strong>${pluralize(blocked.length, 'selected mod')} ${blocked.length === 1 ? 'is' : 'are'} Required/Admin-only in ValheimEnforcer:</strong></p>
        <ul class="dialog-list">${blocked.map((m) => `<li>${esc(m.name)}</li>`).join('')}</ul>
        <p>Removing these will lock players (or you) out until Mods.yaml is updated too.</p>`,
      input: { label: 'Type <code>FORCE</code> to also remove the protected mods', placeholder: 'FORCE', match: 'FORCE' },
      actions: [
        ...(safe.length ? [{ key: 'safe', label: `Remove ${safe.length} unprotected only`, variant: 'btn-secondary' }] : []),
        { key: 'force', label: `Remove all ${targets.length}`, variant: 'btn-danger', needsMatch: true },
      ],
    });
    if (!res) return;
    forceBlocked = res.key === 'force';
  }

  const out = $('mods-output');
  out.textContent = `Removing ${safe.length + (forceBlocked ? blocked.length : 0)} mod(s)...\n`;
  if (blocked.length && !forceBlocked) {
    out.textContent += `Skipping blocked mods: ${blocked.map((m) => m.name).join(', ')}\n`;
  }
  for (const mod of safe) {
    out.textContent += `\n--- ${mod.name} ---\n`;
    const result = await streamPost('/api/mods/remove', { name: mod.name, force: false }, out);
    if (result.includes(`REMOVED ${mod.name}`)) logChange('remove', mod.name);
  }
  if (forceBlocked) {
    for (const mod of blocked) {
      out.textContent += `\n--- ${mod.name} (forced) ---\n`;
      const result = await streamPost('/api/mods/remove', { name: mod.name, force: true }, out);
      if (result.includes(`REMOVED ${mod.name}`)) logChange('remove', mod.name);
    }
  }
  loadInstalledMods();
}

async function bulkSetCategory() {
  const bucket = $('bulk-category-select').value;
  const targets = lastInstalledMods.filter((m) => selectedMods.has(m.name));
  if (!targets.length) return;
  const out = $('mods-output');
  out.textContent = `Setting ${targets.length} mod(s) to ${bucket}...\n`;
  let failed = 0;
  for (const mod of targets) {
    out.textContent += `\n--- ${mod.name} ---\n`;
    const result = await streamPost('/api/mods/categorize', { query: mod.name, bucket }, out);
    if (outcomeOf(result) === 'error') failed++;
    delete pendingCategorization[mod.name];
  }
  failed
    ? toast('warn', `Categorized with ${pluralize(failed, 'error')}`, 'See the action log.')
    : toast('success', `Set ${pluralize(targets.length, 'mod')} to ${bucketLabel[bucket]}`);
  recordEvent('info', `Recategorized ${pluralize(targets.length, 'mod')}`, `→ ${bucketLabel[bucket]}`, 'layers');
  loadInstalledMods();
}

// ---- Install / update prompt modal (source + author + version, every time) ----
// Opens the Source/Author/Version prompt for an installed mod's update,
// pre-filled from the best-matched candidate (mod.update.candidates).
async function openUpdatePromptForMod(mod) {
  const out = $('mods-output');
  const candidates = (mod.update && mod.update.candidates) || (mod.update ? [mod.update] : []);
  if (!candidates.length) {
    toast('warn', `No update found for ${mod.name}`, 'Not found on Hexium or Thunderstore. Use Manual update if you know the exact source/package/version.');
    return;
  }
  const sourcesAvailable = { thunderstore: null, hexium: null };
  candidates.forEach((c) => {
    sourcesAvailable[c.source] = { namespace: c.namespace, name: c.packageName, namespaces: [c.namespace] };
  });
  const defaultSource = mod.update.source;
  const defaultCandidate = candidates.find((c) => c.source === defaultSource) || candidates[0];

  const flagged = candidates.filter((c) => c.ambiguous || c.versionRegression);
  const warningHtml = flagged.length
    ? flagged
        .map((c) =>
          c.versionRegression
            ? `⚠ ${sourceLabel(c.source)} match (${esc(c.namespace)}-${esc(c.packageName)}) is LOWER than the installed version — likely the wrong package. Verify before confirming.`
            : `⚠ ${sourceLabel(c.source)} name match is ambiguous (multiple authors publish "${esc(mod.name)}") — double check the author below is correct.`
        )
        .join('<br>')
    : null;

  showModPrompt({
    title: `Update ${mod.name}`,
    subtitle: `Currently installed: v${mod.currentVersion || '?'}`,
    confirmLabel: 'Update',
    sourcesAvailable,
    defaultSource,
    defaultVersion: defaultCandidate ? defaultCandidate.latestVersion : null,
    showCategory: false,
    warningHtml,
    onConfirm: async ({ source, namespace, name, version }) => {
      out.textContent = `Updating ${mod.name} to v${version} from ${sourceLabel(source)} (${namespace})...\n`;
      const result = await streamPost('/api/mods/install', { namespace, name: mod.name, packageName: name, version, source }, out);
      if (result.includes(`INSTALLED ${mod.name} ${version}`)) {
        logChange('update', mod.name, { version, source });
      } else if (!result.includes('[error]')) {
        out.textContent += '\n[finished — no success marker seen; check the output above for what happened]\n';
        toast('warn', `Update of ${mod.name} finished without confirmation`, 'Check the action log.');
      } else toast('error', `Update failed: ${mod.name}`, 'See the action log.');
      loadInstalledMods();
    },
  });
}

// Manual override — exact Source/Owner/PackageName/Version into the mod's
// existing folder, for when the auto-detected match is wrong.
async function manualUpdateMod(mod) {
  const res = await dialog({
    title: `Manual update · ${mod.name}`,
    tone: 'warn',
    iconName: 'wrench',
    html: `<p>Specify exactly what to install into this mod's folder — use this when the auto-detected match is wrong or missing (mismatched owner, wrong source, or a version that doesn't make sense). Find the values on the mod's Thunderstore or Hexium page.</p>
      <div class="modal-row" style="margin-top:14px"><label for="mu-paste">Paste <span class="mono">Source/Owner/PackageName/Version</span> (optional)</label>
        <input type="text" id="mu-paste" placeholder="thunderstore/Grantapher/ValheimPlus_Grantapher_Temporary/10.1.2" spellcheck="false"></div>
      <div class="modal-grid">
        <div class="modal-row"><label for="mu-source">Source</label><select id="mu-source" class="select"><option value="thunderstore">Thunderstore</option><option value="hexium">Hexium</option></select></div>
        <div class="modal-row"><label for="mu-owner">Owner</label><input type="text" id="mu-owner" placeholder="e.g. Smoothbrain" spellcheck="false"></div>
        <div class="modal-row"><label for="mu-pkg">Package name</label><input type="text" id="mu-pkg" placeholder="e.g. Network" spellcheck="false"></div>
        <div class="modal-row"><label for="mu-ver">Version</label><input type="text" id="mu-ver" placeholder="e.g. 1.1.1" spellcheck="false"></div>
      </div>`,
    actions: [{ key: 'install', label: 'Install', variant: 'btn-warn' }],
    collect: (body) => {
      const source = body.querySelector('#mu-source').value.toLowerCase();
      const namespace = body.querySelector('#mu-owner').value.trim();
      const packageName = body.querySelector('#mu-pkg').value.trim();
      const version = body.querySelector('#mu-ver').value.trim();
      if (!namespace || !packageName || !version || !['thunderstore', 'hexium'].includes(source)) {
        return { error: 'All four parts are required — Source must be "thunderstore" or "hexium".' };
      }
      return { source, namespace, packageName, version };
    },
  });
  // (paste handler is wired below via event delegation)
  if (!res || res.key !== 'install') return;
  const { source, namespace, packageName, version } = res.value;
  const out = $('mods-output');
  out.textContent = `Manually installing ${namespace}-${packageName} v${version} from ${sourceLabel(source)} into ${mod.name}...\n`;
  const result = await streamPost('/api/mods/install', { namespace, name: mod.name, packageName, version, source }, out);
  if (result.includes(`INSTALLED ${mod.name} ${version}`)) {
    logChange('update', mod.name, { version, source });
  } else if (!result.includes('[error]')) {
    out.textContent += '\n[finished — no success marker seen; check the output above for what happened]\n';
  } else toast('error', `Manual update failed: ${mod.name}`, 'See the action log.');
  loadInstalledMods();
}
// Split a pasted "source/owner/package/version" string into the four fields.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'mu-paste') return;
  const parts = e.target.value.split('/').map((s) => s.trim());
  if (parts.length !== 4) return;
  const src = parts[0].toLowerCase();
  if (['thunderstore', 'hexium'].includes(src)) $('mu-source').value = src;
  $('mu-owner').value = parts[1];
  $('mu-pkg').value = parts[2];
  $('mu-ver').value = parts[3];
});

async function openPinPackageDialog(mod) {
  const existingSource = mod.pins && mod.pins.thunderstore ? 'thunderstore' : (mod.pins && mod.pins.hexium ? 'hexium' : null);
  const existing = existingSource ? mod.pins[existingSource] : null;
  const [exOwner, exName] = existing ? parseDependencyStringForPrefill(existing) : [null, null];
  const res = await dialog({
    title: `Pin package identity · ${mod.name}`,
    tone: 'info',
    iconName: 'link',
    html: `<p>Pin exactly which Thunderstore/Hexium package this folder is, for cases where automatic matching gets it wrong. This only settles <em>which package</em> it is — the version is never frozen: profile codes always use whatever version is currently recorded in Mods.yaml for this mod.</p>
      <div class="modal-row" style="margin-top:14px"><label for="pp-paste">Paste <span class="mono">Source/Owner/PackageName</span> (optional)</label>
        <input type="text" id="pp-paste" placeholder="thunderstore/Grantapher/ValheimPlus_Grantapher_Temporary" spellcheck="false"></div>
      <div class="modal-grid">
        <div class="modal-row"><label for="pp-source">Source</label><select id="pp-source" class="select"><option value="thunderstore">Thunderstore</option><option value="hexium">Hexium</option></select></div>
        <div class="modal-row"><label for="pp-owner">Owner</label><input type="text" id="pp-owner" placeholder="e.g. Smoothbrain" spellcheck="false" value="${esc(exOwner || '')}"></div>
        <div class="modal-row"><label for="pp-pkg">Package name</label><input type="text" id="pp-pkg" placeholder="e.g. Network" spellcheck="false" value="${esc(exName || '')}"></div>
      </div>`,
    actions: [{ key: 'pin', label: 'Pin', variant: 'btn-primary' }],
    collect: (body) => {
      const source = body.querySelector('#pp-source').value.toLowerCase();
      const owner = body.querySelector('#pp-owner').value.trim();
      const packageName = body.querySelector('#pp-pkg').value.trim();
      if (!owner || !packageName || !['thunderstore', 'hexium'].includes(source)) {
        return { error: 'Owner, package name and a valid source are required.' };
      }
      return { source, owner, packageName };
    },
  });
  if (!res || res.key !== 'pin') return;
  const { source, owner, packageName } = res.value;
  if (!mod.guid) { toast('error', 'Cannot pin', 'This mod has no Mods.yaml entry (guid) to pin against.'); return; }
  const out = $('mods-output');
  out.textContent = `Pinning ${mod.name} to ${owner}-${packageName} on ${sourceLabel(source)}...\n`;
  // The pin string carries a version for the sidecar's record-keeping, but
  // generate-codes.py deliberately ignores it and always resolves against
  // Mods.yaml's live recorded version instead — so any placeholder works.
  const version = mod.currentVersion || '0.0.0';
  const result = await streamPost('/api/mods/pin-package', { guid: mod.guid, source, owner, packageName, version }, out);
  toastFromResult(result, `Pinned ${mod.name} to ${owner}-${packageName}`, `Pinning ${mod.name} failed`);
  loadInstalledMods();
}
// Split a pasted "source/owner/package" string into the three fields.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'pp-paste') return;
  const parts = e.target.value.split('/').map((s) => s.trim());
  if (parts.length < 3) return;
  const src = parts[0].toLowerCase();
  if (['thunderstore', 'hexium'].includes(src)) $('pp-source').value = src;
  $('pp-owner').value = parts[1];
  $('pp-pkg').value = parts.slice(2).join('/');
});

// Best-effort split of a stored "Owner-PackageName-Version" pin string for
// pre-filling the dialog when re-pinning/changing an existing pin.
function parseDependencyStringForPrefill(pinString) {
  const parts = String(pinString || '').split('-');
  if (parts.length < 2) return [null, null];
  if (parts.length >= 3 && /^\d+(\.\d+){1,3}$/.test(parts[parts.length - 1])) parts.pop();
  const owner = parts[0];
  const name = parts.slice(1).join('-');
  return [owner, name];
}

async function unpinPackage(mod, source) {
  if (
    !(await confirmDialog({
      title: `Unpin ${mod.name}?`,
      tone: 'warn',
      html: `<p>Removes the pinned ${sourceLabel(source)} package identity for <strong>${esc(mod.name)}</strong>. It falls back to automatic folder/hash matching.</p>`,
      confirmLabel: 'Unpin',
    }))
  ) {
    return;
  }
  const out = $('mods-output');
  out.textContent = `Unpinning ${mod.name}...\n`;
  const result = await streamPost('/api/mods/unpin-package', { guid: mod.guid, source }, out);
  toastFromResult(result, `Unpinned ${mod.name}`, `Unpinning ${mod.name} failed`);
  loadInstalledMods();
}

async function protectedDialog(verb, name, status, reason, consequence) {
  const res = await dialog({
    title: `${verb} protected mod?`,
    tone: 'danger',
    html: `<p><strong>${esc(name)}</strong> is <span class="badge cat" style="--c:${STATUS_LABELS[status].color}">${status === 'required' ? 'REQUIRED' : 'ADMIN-ONLY'}</span> in ValheimEnforcer.</p>
      ${reason ? `<p class="muted">${esc(reason)}</p>` : ''}<p>${consequence}</p>`,
    input: { label: `Type <code>FORCE</code> to ${verb.toLowerCase()} it anyway`, placeholder: 'FORCE', match: 'FORCE' },
    actions: [{ key: 'force', label: `${verb} anyway`, variant: 'btn-danger', needsMatch: true }],
  });
  return !!(res && res.key === 'force');
}

async function removeMod(name, status, reason) {
  const blocked = status === 'required' || status === 'adminOnly';
  if (blocked) {
    if (!(await protectedDialog('Remove', name, status, reason, "Removing it will lock players out until it's also removed from Mods.yaml."))) return;
  } else if (
    !(await confirmDialog({
      title: `Remove ${name}?`,
      tone: 'danger',
      html: '<p>The mod folder is deleted from BepInEx/plugins. The server should be stopped first.</p>',
      confirmLabel: 'Remove',
    }))
  ) {
    return;
  }
  const out = $('mods-output');
  out.textContent = `Removing ${name}...`;
  const result = await streamPost('/api/mods/remove', { name, force: blocked }, out);
  if (result.includes(`REMOVED ${name}`)) logChange('remove', name);
  else toast('error', `Could not remove ${name}`, 'See the action log.');
  loadInstalledMods();
}

async function disableMod(name, status, reason) {
  const blocked = status === 'required' || status === 'adminOnly';
  if (blocked) {
    if (!(await protectedDialog('Disable', name, status, reason, 'Disabling stops the server running it — other mods that depend on it may break.'))) return;
  } else if (
    !(await confirmDialog({
      title: `Disable ${name}?`,
      tone: 'warn',
      html: '<p>Moves it out of BepInEx/plugins so the server stops loading it. Its files are kept, not deleted. The server should be stopped first.</p>',
      confirmLabel: 'Disable',
    }))
  ) {
    return;
  }
  const out = $('mods-output');
  out.textContent = `Disabling ${name}...`;
  const result = await streamPost('/api/mods/disable', { name, force: blocked }, out);
  if (result.includes(`DISABLED ${name}`)) logChange('disable', name);
  else toast('error', `Could not disable ${name}`, 'See the action log.');
  loadInstalledMods();
  loadDisabledMods();
}

// ---- Disabled mods (API: GET /api/mods/disabled, POST /api/mods/enable) ----
async function loadDisabledMods() {
  const list = $('disabled-mods-list');
  list.innerHTML = skeletonLis(3);
  try {
    const r = await api('/api/mods/disabled');
    const mods = r.mods || [];
    $('mk-disabled').textContent = mods.length;
    $('disabled-mods-count').textContent = mods.length || '';
    if (!mods.length) {
      list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'pause', title: 'No disabled mods', text: 'Disable a mod from its ⋯ menu to stop running it without deleting it.' })}</li>`;
      return;
    }
    list.innerHTML = '';
    mods.forEach((name) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="row-icon">${icon('pause')}</span><div class="row-main"><div class="row-title"><span class="mod-name">${esc(name)}</span><span class="badge">Disabled</span></div></div>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-sm';
      btn.innerHTML = `${icon('play')}Re-enable`;
      btn.onclick = () => enableMod(name, btn);
      li.appendChild(btn);
      list.appendChild(li);
    });
  } catch (e) {
    $('mk-disabled').textContent = '—';
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Could not load disabled mods', text: esc(e.message), error: true, action: '<button class="btn btn-secondary btn-sm" onclick="loadDisabledMods()">Try again</button>' })}</li>`;
  }
}

async function enableMod(name, btn) {
  const out = $('mods-output');
  setBtnLoading(btn, true);
  out.textContent = `Re-enabling ${name}...`;
  const result = await streamPost('/api/mods/enable', { name }, out);
  if (result.includes(`ENABLED ${name}`)) logChange('enable', name);
  else toast('error', `Could not re-enable ${name}`, 'See the action log.');
  loadInstalledMods();
  loadDisabledMods();
}

// ---- Search (API: GET /api/mods/search) ----
let hasSearched = false;
function renderSearchEmpty() {
  if (hasSearched) return;
  $('mod-search-results').innerHTML = `<li class="empty-li">${emptyState({
    iconName: 'search',
    title: 'Search Thunderstore and Hexium',
    text: 'Find a mod by name, then confirm the exact source, author and version before anything downloads.',
  })}</li>`;
}

async function searchMods() {
  const q = $('mod-search-input').value.trim();
  const source = $('mod-search-source').value;
  const list = $('mod-search-results');
  const btn = qs('#sub-browse button[type="submit"]');
  hasSearched = true;
  list.innerHTML = skeletonLis(5);
  setBtnLoading(btn, true);
  try {
    const r = await api(`/api/mods/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`);
    if (r.error) throw new Error(r.error);
    list.innerHTML = '';
    if (!r.results.length) {
      list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'search', title: `No results${q ? ` for “${esc(q)}”` : ''}`, text: 'Deprecated packages are never shown. Try a shorter or different name.' })}</li>`;
      return;
    }
    const installed = new Set(lastInstalledMods.map((m) => m.name.toLowerCase()));
    r.results.forEach((mod) => {
      const li = document.createElement('li');
      const isInstalled = installed.has(String(mod.name).toLowerCase());
      li.innerHTML = `<span class="row-icon">${icon('package')}</span>
        <div class="row-main">
          <div class="row-title"><span class="mod-name">${esc(mod.name)}</span>${sourceBadge(mod.source)}<span class="ver">v${esc(mod.version)}</span>${isInstalled ? `<span class="badge good">${icon('check')}Installed</span>` : ''}</div>
          <div class="row-desc">by ${esc(mod.namespace)}${mod.description ? ` — ${esc(mod.description)}` : ''}</div>
        </div>
        <div class="row-side"></div>`;
      const side = li.querySelector('.row-side');
      const catSelect = document.createElement('select');
      catSelect.className = 'select sm';
      catSelect.setAttribute('data-tip', 'Category to apply after the next restart');
      catSelect.setAttribute('aria-label', 'Category');
      BUCKET_OPTIONS.forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        catSelect.appendChild(opt);
      });
      side.appendChild(catSelect);

      const btn2 = document.createElement('button');
      btn2.className = 'btn btn-primary btn-sm';
      btn2.innerHTML = `${icon('download')}Install`;
      btn2.onclick = async () => {
        setBtnLoading(btn2, true);
        await openInstallPromptFromSearch(mod, catSelect.value);
        setBtnLoading(btn2, false);
      };
      side.appendChild(btn2);
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Search failed', text: esc(e.message), error: true })}</li>`;
  } finally {
    setBtnLoading(btn, false);
  }
}

let modPromptConfig = null;

function closeModPrompt() {
  $('mod-prompt-overlay').classList.add('hidden');
  document.removeEventListener('keydown', modPromptKeys, true);
  modPromptConfig = null;
}
function modPromptKeys(e) {
  if (e.key === 'Escape' && $('dialog-overlay').classList.contains('hidden')) {
    e.stopPropagation();
    closeModPrompt();
  } else if (e.key === 'Tab') trapFocus(e, $('mod-prompt-overlay'));
}
$('mod-prompt-overlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'mod-prompt-overlay') closeModPrompt();
});

async function populateModPromptVersionsForAuthor() {
  const source = document.querySelector('input[name="mod-prompt-source"]:checked')?.value;
  const namespace = $('mod-prompt-author').value;
  const versionSelect = $('mod-prompt-version');
  if (!source || !namespace || !modPromptConfig) return;
  const info = modPromptConfig.sourcesAvailable[source];
  if (!info) return;
  versionSelect.innerHTML = '<option>Loading versions…</option>';
  versionSelect.disabled = true;
  try {
    const r = await api(
      `/api/mods/package-versions?source=${encodeURIComponent(source)}&namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(info.name)}`
    );
    const versions = r.versions || [];
    versionSelect.innerHTML = '';
    if (!versions.length) {
      versionSelect.innerHTML = '<option value="">(no versions found)</option>';
      return;
    }
    versions.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = v.version + (i === 0 ? '  (latest)' : '');
      versionSelect.appendChild(opt);
    });
    if (modPromptConfig && modPromptConfig.defaultVersion && versions.some((v) => v.version === modPromptConfig.defaultVersion)) {
      versionSelect.value = modPromptConfig.defaultVersion;
    }
  } catch (e) {
    versionSelect.innerHTML = '<option value="">(failed to load versions)</option>';
  } finally {
    versionSelect.disabled = false;
  }
}

function populateModPromptAuthors() {
  const source = document.querySelector('input[name="mod-prompt-source"]:checked')?.value;
  const authorSelect = $('mod-prompt-author');
  qsa('#mod-prompt-source-options label').forEach((l) => l.classList.toggle('checked', l.querySelector('input').checked));
  authorSelect.innerHTML = '';
  if (!source || !modPromptConfig) return;
  const info = modPromptConfig.sourcesAvailable[source];
  if (!info) {
    authorSelect.innerHTML = '<option value="">(not available on this source)</option>';
    $('mod-prompt-version').innerHTML = '';
    return;
  }
  (info.namespaces && info.namespaces.length ? info.namespaces : [info.namespace]).forEach((ns) => {
    const opt = document.createElement('option');
    opt.value = ns;
    opt.textContent = ns;
    authorSelect.appendChild(opt);
  });
  authorSelect.value = info.namespace;
  populateModPromptVersionsForAuthor();
}
$('mod-prompt-author').addEventListener('change', populateModPromptVersionsForAuthor);

// Shows the Install/Update modal. cfg = { title, subtitle, sourcesAvailable:
// {thunderstore: {namespace, name, namespaces?}|null, hexium: {...}|null},
// defaultSource, defaultVersion, showCategory, defaultCategory, warningHtml,
// onConfirm({source, namespace, name, version, category}) }.
function showModPrompt(cfg) {
  modPromptConfig = cfg;
  $('mod-prompt-title').textContent = cfg.title;
  $('mod-prompt-subtitle').textContent = cfg.subtitle || '';
  $('mod-prompt-confirm-btn').textContent = cfg.confirmLabel || 'Confirm';

  const sourceOptionsEl = $('mod-prompt-source-options');
  sourceOptionsEl.innerHTML = '';
  ['thunderstore', 'hexium'].forEach((s) => {
    const available = !!cfg.sourcesAvailable[s];
    const label = document.createElement('label');
    if (!available) {
      label.classList.add('disabled');
      label.setAttribute('data-tip', `Not available on ${sourceLabel(s)}`);
    }
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mod-prompt-source';
    input.value = s;
    input.disabled = !available;
    input.checked = s === cfg.defaultSource;
    input.addEventListener('change', populateModPromptAuthors);
    input.addEventListener('focus', () => label.classList.add('focus'));
    input.addEventListener('blur', () => label.classList.remove('focus'));
    label.appendChild(input);
    label.appendChild(document.createTextNode(sourceLabel(s)));
    sourceOptionsEl.appendChild(label);
  });

  const catRow = $('mod-prompt-category-row');
  catRow.style.display = cfg.showCategory ? '' : 'none';
  if (cfg.showCategory) $('mod-prompt-category').value = cfg.defaultCategory || 'required';

  const warnEl = $('mod-prompt-warning');
  if (cfg.warningHtml) {
    warnEl.innerHTML = cfg.warningHtml;
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }

  $('mod-prompt-overlay').classList.remove('hidden');
  document.addEventListener('keydown', modPromptKeys, true);
  populateModPromptAuthors();
  setTimeout(() => $('mod-prompt-confirm-btn').focus(), 30);
}

async function confirmModPrompt() {
  if (!modPromptConfig) return;
  const source = document.querySelector('input[name="mod-prompt-source"]:checked')?.value;
  const namespace = $('mod-prompt-author').value;
  const version = $('mod-prompt-version').value;
  const category = modPromptConfig.showCategory ? $('mod-prompt-category').value : null;
  if (!source || !namespace || !version) {
    toast('warn', 'Incomplete selection', 'Pick a source, author, and version before confirming.');
    return;
  }
  const cfg = modPromptConfig;
  const info = cfg.sourcesAvailable[source];
  // Close first so the streaming output in the action log is visible.
  closeModPrompt();
  await cfg.onConfirm({ source, namespace, name: info.name, version, category });
}

// Opens the Source/Author/Version prompt for a fresh install from a search
// result. Looks up every source that has a name match for this mod
// (API: GET /api/mods/package-sources) so switching Hexium <-> Thunderstore
// is available from the start.
async function openInstallPromptFromSearch(mod, category) {
  const out = $('mods-output');
  const sourcesAvailable = { thunderstore: null, hexium: null };
  try {
    const r = await api(`/api/mods/package-sources?name=${encodeURIComponent(mod.name)}`);
    ['thunderstore', 'hexium'].forEach((s) => {
      const candidates = r[s] || [];
      if (!candidates.length) return;
      const exact = candidates.find((c) => c.namespace === mod.namespace) || candidates[0];
      sourcesAvailable[s] = { namespace: exact.namespace, name: exact.name, namespaces: candidates.map((c) => c.namespace) };
    });
  } catch (e) {
    // Best-effort — fall back to just the source this search result came from.
  }
  if (!sourcesAvailable[mod.source]) {
    sourcesAvailable[mod.source] = { namespace: mod.namespace, name: mod.name, namespaces: [mod.namespace] };
  }

  showModPrompt({
    title: `Install ${mod.name}`,
    subtitle: mod.description || '',
    confirmLabel: 'Install',
    sourcesAvailable,
    defaultSource: mod.source,
    defaultVersion: mod.version,
    showCategory: true,
    defaultCategory: category || 'required',
    warningHtml: null,
    onConfirm: async ({ source, namespace, name, version, category }) => {
      const missing = await checkMissingDependencies({ namespace, name, version, source });
      if (missing.length) {
        const ok = await confirmDialog({
          title: 'Missing dependencies',
          tone: 'warn',
          html: `<p><strong>${esc(mod.name)}</strong> depends on mod(s) that aren't currently installed:</p>
            <ul class="dialog-list">${missing.map((d) => `<li class="mono">${esc(d.owner)}-${esc(d.name)} (v${esc(d.version)})</li>`).join('')}</ul>
            <p>It likely won't work correctly without them.</p>`,
          confirmLabel: 'Install anyway',
        });
        if (!ok) return;
      }
      if (currentModsTab !== 'browse') showModsTab('browse');
      // Fresh installs get the full "Owner-PackageName-Version" folder name
      // (Thunderstore/Gale's own convention, e.g.
      // "denikson-BepInExPack_Valheim-5.4.2350") instead of the bare package
      // name — keeps different versions distinguishable on disk. Updates
      // deliberately keep reusing the mod's EXISTING folder name instead (see
      // the /api/mods/install comment in server.js) — this only applies to a
      // brand new install, never to updating something already installed.
      const folderName = `${namespace}-${name}-${version}`;
      out.textContent = `Installing ${mod.name} v${version} from ${sourceLabel(source)} (${namespace}) into ${folderName}...\n`;
      const result = await streamPost('/api/mods/install', { namespace, name: folderName, packageName: name, version, source }, out);
      if (result.includes(`INSTALLED ${folderName} ${version}`)) {
        logChange('install', folderName, { version, source });
      } else if (!result.includes('[error]')) {
        out.textContent += '\n[finished — no success marker seen; check the output above for what happened]\n';
      } else toast('error', `Install failed: ${mod.name}`, 'See the action log.');
      if (category && category !== 'required') {
        pendingCategorization[folderName] = category;
        out.textContent +=
          `\nInstalled. ValheimEnforcer needs the server stopped and started again to detect it and record its hash — ` +
          `after stopping and starting the server, come back here and click "Apply: ${category}" next to it in Installed Mods.\n`;
        toast('info', 'Stop/start needed to categorize', `After stopping and starting the server, click “Apply: ${bucketLabel[category]}” next to ${folderName}.`, 8000);
      }
      loadInstalledMods();
    },
  });
}

// Mods tagged here at install time but not yet "required" show an Apply
// button in the installed list once they exist there. Same-session only.
const pendingCategorization = {};

// API: GET /api/mods/dependencies
async function checkMissingDependencies(mod) {
  try {
    const r = await api(
      `/api/mods/dependencies?namespace=${encodeURIComponent(mod.namespace)}&name=${encodeURIComponent(mod.name)}&version=${encodeURIComponent(mod.version)}&source=${encodeURIComponent(mod.source || 'thunderstore')}`
    );
    return (r.dependencies || []).filter((d) => !d.installed);
  } catch (e) {
    return []; // fail open — a broken check shouldn't block installing
  }
}

// API: POST /api/mods/categorize
async function applyCategorization(name, bucket) {
  if (!bucket) return;
  const out = $('mods-output');
  out.textContent = `Setting ${name} to ${bucket}...\n`;
  const result = await streamPost('/api/mods/categorize', { query: name, bucket }, out);
  delete pendingCategorization[name];
  toastFromResult(result, `${name} → ${bucketLabel[bucket] || bucket}`, `Could not recategorize ${name}`);
  if (outcomeOf(result) !== 'error') recordEvent('info', `Recategorized ${name}`, `→ ${bucketLabel[bucket] || bucket}`, 'layers');
  loadInstalledMods();
}

// ---- Profile codes (API: SSE /api/mods/generate-codes) ----
async function generateCodes() {
  const mode = $('generate-codes-mode').value;
  const dryRun = $('generate-codes-dry-run-check').checked;
  const out = $('generate-codes-output');
  const btn = $('generate-codes-btn');
  const results = $('generated-codes');
  results.innerHTML = '';
  setBtnLoading(btn, true);
  await streamToConsole(`/api/mods/generate-codes?mode=${encodeURIComponent(mode)}&dryRun=${dryRun}`, out, () => {
    // generate-codes.py prints PLAYER_CODE=.../ADMIN_CODE=... only on a real
    // (non-dry-run) upload. Each code is logged (with its value) into the
    // Discord summary, like installs/updates/removes.
    const codeLines = out.textContent.match(/^(PLAYER|ADMIN)_CODE=\S+/gm) || [];
    codeLines.forEach((line) => {
      const eq = line.indexOf('=');
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      const kind = key === 'PLAYER_CODE' ? 'Player code' : 'Admin code';
      logChange('codes', kind, { code: value });
      const card = document.createElement('div');
      card.className = 'code-card';
      card.innerHTML = `<span class="code-kind">${kind}</span><code>${esc(value)}</code>`;
      const cb = document.createElement('button');
      cb.className = 'btn btn-secondary btn-sm';
      cb.innerHTML = `${icon('copy')}Copy`;
      cb.onclick = async () => ((await copyText(value)) ? toast('success', `${kind} copied`) : toast('error', 'Copy failed'));
      card.appendChild(cb);
      results.appendChild(card);
    });
    if (!codeLines.length && dryRun) toast('info', 'Dry run finished', 'Preview only — nothing was uploaded.');
  });
  setBtnLoading(btn, false);
}

// ---- Requirements (API: GET /api/mods/requirements) ----
let lastRequirements = null;

async function loadRequirements() {
  const el = $('requirements-output');
  requirementsLoaded = true;
  el.innerHTML = `<div class="req-grid"><div class="req-col"><ul class="row-list">${skeletonLis(4)}</ul></div><div class="req-col"><ul class="row-list">${skeletonLis(4)}</ul></div></div>`;
  try {
    const r = await api('/api/mods/requirements');
    lastRequirements = r;
    const section = (title, mods, color) => {
      const items = mods.length
        ? mods
            .map((m) => {
              const nameHtml = m.link
                ? `<a href="${esc(m.link)}" target="_blank" rel="noopener" class="mod-name">${esc(m.name)}</a>`
                : `<span class="mod-name">${esc(m.name)}</span>`;
              const galeHtml = m.galeLink
                ? `<a href="${esc(m.galeLink)}" class="gale-link" data-tip="Opens Gale and installs this exact mod + version">${icon('download')}Gale</a>`
                : '';
              return `<li><div class="row-main"><div class="row-title">${nameHtml}${m.source ? sourceBadge(m.source) : ''}</div></div><span class="ver">v${esc(m.version)}</span>${galeHtml}</li>`;
            })
            .join('')
        : `<li class="empty-li">${emptyState({ iconName: 'list', title: `No ${title.toLowerCase()} mods`, small: true })}</li>`;
      return `<div class="req-col"><div class="req-col-head"><span class="badge cat" style="--c:${color}">${title}</span><span class="muted">${mods.length}</span></div><ul class="row-list">${items}</ul></div>`;
    };
    el.innerHTML = `<div class="req-grid">${section('Required', r.required, 'var(--cat-required)')}${section('Optional', r.optional, 'var(--cat-optional)')}</div>`;
  } catch (e) {
    el.innerHTML = emptyState({ title: 'Could not load requirements', text: esc(e.message), error: true, action: '<button class="btn btn-secondary btn-sm" onclick="loadRequirements()">Try again</button>' });
  }
}

async function copyRequirements() {
  if (!lastRequirements) return toast('warn', 'Requirements not loaded yet');
  const line = (m) => `- ${m.name} v${m.version}${m.link ? ` (${m.link})` : ''}${m.galeLink ? ` [Gale: ${m.galeLink}]` : ''}`;
  const text =
    `Required mods:\n${lastRequirements.required.map(line).join('\n') || '(none)'}\n\n` +
    `Optional mods:\n${lastRequirements.optional.map(line).join('\n') || '(none)'}`;
  (await copyText(text)) ? toast('success', 'Requirements copied', 'Ready to paste into Discord.') : toast('error', 'Copy failed');
}

/* ==========================================================================
   8. Backups (API: SSE /api/backup/run, GET /api/backup/list, POST /api/backup/restore)
   ========================================================================== */

let lastBackups = null;
let backupSortDesc = true;

function parseBackupDate(name) {
  const m = name.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[T_\-. ]?(\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?)?/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  return isNaN(t) || +m[1] < 2000 ? null : t;
}

async function runBackup() {
  const out = $('backup-output');
  const btn = $('run-backup-btn');
  setBtnLoading(btn, true);
  const code = await streamToConsole('/api/backup/run', out, listBackups);
  setBtnLoading(btn, false);
  if (code === '0') {
    toast('success', 'Backup complete');
    recordEvent('good', 'Backup completed', '', 'archive');
  } else {
    toast('error', 'Backup failed', code ? `Exit code ${code}` : 'Stream closed early');
    recordEvent('bad', 'Backup failed', code ? `exit ${code}` : '', 'archive');
  }
}

async function listBackups() {
  const list = $('backup-files-list');
  if (!lastBackups) list.innerHTML = skeletonLis(5);
  try {
    const r = await api('/api/backup/list');
    lastBackups = r.files || [];
    renderBackups();
  } catch (e) {
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Could not list backups', text: esc(e.message), error: true, action: '<button class="btn btn-secondary btn-sm" onclick="listBackups()">Try again</button>' })}</li>`;
  }
}

function toggleBackupSort() {
  backupSortDesc = !backupSortDesc;
  $('backup-sort-btn').innerHTML = `${icon(backupSortDesc ? 'arrow-down' : 'arrow-up')}${backupSortDesc ? 'Newest first' : 'Oldest first'}`;
  renderBackups();
}

function renderBackups() {
  const list = $('backup-files-list');
  if (!lastBackups) return;
  const files = lastBackups.map((f) => ({ f, t: parseBackupDate(f) }));
  const dated = files.filter((x) => x.t).sort((a, b) => b.t - a.t);
  $('bk-total').textContent = files.length;
  $('bk-latest').textContent = dated.length ? `${timeAgo(dated[0].t)} · ${new Date(dated[0].t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : files.length ? '—' : 'None yet';

  if (!files.length) {
    list.innerHTML = `<li class="empty-li">${emptyState({
      iconName: 'archive',
      title: 'No backups found',
      text: 'Run your first backup, or check <code>backupDir</code> in config.json.',
      action: `<button class="btn btn-primary btn-sm" onclick="runBackup()">${icon('archive')}Run backup now</button>`,
    })}</li>`;
    return;
  }
  const q = ($('backup-filter').value || '').toLowerCase();
  const shown = files
    .filter((x) => x.f.toLowerCase().includes(q))
    .sort((a, b) => ((a.t && b.t ? a.t - b.t : a.f.localeCompare(b.f)) * (backupSortDesc ? -1 : 1)));
  if (!shown.length) {
    list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'filter', title: 'No backups match', small: true })}</li>`;
    return;
  }
  list.innerHTML = '';
  shown.forEach(({ f, t }, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="row-icon">${icon('archive')}</span>
      <div class="row-main"><div class="row-title"><span class="mod-name mono" style="font-size:12.5px">${esc(f)}</span>${i === 0 && backupSortDesc && !q ? '<span class="badge good">Latest</span>' : ''}</div>
      <div class="row-desc bk-date">${t ? `${new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${timeAgo(t)}` : 'Date unknown'}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-warn btn-sm';
    btn.innerHTML = `${icon('rotate')}Restore`;
    btn.onclick = () => restoreBackup(f);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function restoreBackup(file) {
  const res = await dialog({
    title: 'Restore this backup?',
    tone: 'danger',
    html: `<p class="mono" style="color:var(--text);word-break:break-all">${esc(file)}</p>
      <p>This <strong>stops the server</strong>, saves a safety copy of the current world (<code>PRE-RESTORE-…</code>, shown in this list so you can undo), replaces the world with this backup, then starts the server again. Only the world is restored — mods and their configs stay as they are.</p>`,
    input: { label: 'Type <code>RESTORE</code> to confirm', placeholder: 'RESTORE', match: 'RESTORE' },
    actions: [{ key: 'restore', label: 'Restore backup', variant: 'btn-danger', needsMatch: true }],
  });
  if (!res || res.key !== 'restore') return;
  const out = $('backup-output');
  out.textContent = `Restoring ${file}...\n`;
  setConsoleState(out, 'running');
  recordEvent('warn', 'Backup restore started', file, 'rotate');
  let full = '';
  try {
    const r = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      out.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    }
    const state = outcomeOf(full);
    setConsoleState(out, state);
    state === 'error' ? toast('error', 'Restore reported errors', 'Check the output.') : toast('success', 'Restore finished', file);
  } catch (e) {
    out.textContent += `\n[error] ${e.message}\n`;
    setConsoleState(out, 'error');
    toast('error', 'Restore failed', e.message);
  }
  setTimeout(refreshStatus, 1500);
}

/* ---- Scheduled backups (API: GET/POST /api/backup/schedule) ---- */

let lastSchedule = null;

async function loadBackupSchedule() {
  if (!$('bk-sched-enabled')) return;
  try {
    const r = await api('/api/backup/schedule');
    const first = !lastSchedule;
    lastSchedule = r;
    renderBackupSchedule(r, first);
  } catch (e) {
    $('bk-sched-sub').textContent = e.message;
  }
}

function renderBackupSchedule(r, fillForm) {
  if (fillForm) {
    $('bk-sched-enabled').checked = !!r.enabled;
    $('bk-sched-interval').value = String(r.intervalHours);
    $('bk-sched-empty').checked = r.onlyWhenEmpty !== false;
  }
  $('bk-sched-sub').textContent = r.enabled
    ? `On · ${r.description || `every ${r.intervalHours} h`}, runs on the VPS (VPS clock)${r.onlyWhenEmpty ? ' · only when nobody is online' : ''}`
    : 'Off — backups only run when you press "Run backup now".';
  const last = $('bk-sched-last');
  if (!r.lastRun) {
    last.textContent = '';
  } else {
    const tone = r.lastRun.ok === true ? 'good' : r.lastRun.ok === false ? 'bad' : 'warn';
    last.innerHTML = `<span class="badge ${tone}">${r.lastRun.ok === true ? 'OK' : r.lastRun.ok === false ? 'Failed' : 'Skipped'}</span> ${esc(timeAgo(r.lastRun.ts))} — ${esc(r.lastRun.message)}`;
  }
}

async function saveBackupSchedule() {
  const btn = $('bk-sched-save');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/backup/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: $('bk-sched-enabled').checked,
        intervalHours: Number($('bk-sched-interval').value),
        onlyWhenEmpty: $('bk-sched-empty').checked,
      }),
    });
    lastSchedule = r;
    renderBackupSchedule(r, true);
    toast('success', r.enabled ? 'Backup cron job installed on the VPS' : 'Scheduled backups turned off (cron job removed)');
    recordEvent('accent', r.enabled ? `Scheduled backups every ${r.intervalHours} h` : 'Scheduled backups turned off', '', 'archive');
  } catch (e) {
    toast('error', 'Could not save the schedule', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}


/* ---- Automatic server-update check (cron on the VPS; API: /api/update/schedule) ---- */

let lastUpdSchedule = null;

async function loadUpdateSchedule() {
  if (!$('upd-sched-enabled')) return;
  try {
    const r = await api('/api/update/schedule');
    const first = !lastUpdSchedule;
    lastUpdSchedule = r;
    renderUpdateSchedule(r, first);
  } catch (e) {
    $('upd-sched-sub').textContent = e.message;
  }
}

function renderUpdateSchedule(r, fillForm) {
  if (fillForm) {
    $('upd-sched-enabled').checked = !!r.enabled;
    $('upd-sched-interval').value = String(r.intervalHours);
  }
  $('upd-sched-sub').textContent = r.enabled ? `On · ${r.description || `every ${r.intervalHours} h`}, runs on the VPS (VPS clock)` : 'Off — updates are only checked when you press "Check now".';
  const last = $('upd-sched-last');
  if (!r.lastRun) last.textContent = '';
  else {
    const tone = r.lastRun.state === 'update' ? 'warn' : r.lastRun.ok ? 'good' : 'bad';
    const label = r.lastRun.state === 'update' ? 'Update available' : r.lastRun.ok ? 'Checked' : 'Failed';
    last.innerHTML = `<span class="badge ${tone}">${label}</span> ${esc(timeAgo(r.lastRun.ts))} — ${esc(r.lastRun.message)}`;
  }
}

async function saveUpdateSchedule() {
  const btn = $('upd-sched-save');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/update/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('upd-sched-enabled').checked, intervalHours: Number($('upd-sched-interval').value) }),
    });
    lastUpdSchedule = r;
    renderUpdateSchedule(r, true);
    toast('success', r.enabled ? 'Update check scheduled on the VPS' : 'Automatic update checks turned off');
  } catch (e) {
    toast('error', 'Could not save', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---- Server settings (API: GET/POST /api/settings) ---- */

let settingsLoaded = null;

async function loadSettings() {
  const form = $('set-form');
  if (!form) return;
  try {
    const r = await api('/api/settings');
    settingsLoaded = r;
    $('set-sub').textContent = `Editing ${r.writeTo}`;
    $('set-warn').innerHTML = r.passwordWarning ? `<span class="badge warn">Weak password</span> ${esc(r.passwordWarning)}` : '';
    form.innerHTML = Object.entries(r.settings).filter(([, d]) => !d.hidden).map(([k, d]) => {
      const type = d.type === 'password' ? 'password' : 'text';
      const unused = d.usedByStartParameters === false ? `<span class="card-note" style="color:var(--warn,#c80)">Your start parameters don’t reference this setting — editing it will have no effect until they do.</span>` : '';
      const fromDefault = d.source === 'LGSM default' ? `<span class="card-note">Currently the LGSM default. Saving writes an override to the config (the default file is never edited).</span>` : '';
      const missing = d.value === null ? `<span class="card-note">Not set in the config yet (the game default applies). Saving adds it.</span>` : '';
      return `<label style="display:flex;flex-direction:column;gap:4px"><span>${esc(d.label)}</span>
        <input class="input" data-key="${esc(k)}" type="${type}" value="${esc(d.value == null ? '' : d.value)}" autocomplete="${d.type === 'password' ? 'new-password' : 'off'}" spellcheck="false">
        <span class="card-note">${esc(d.hint || '')}</span>${fromDefault}${missing}${unused}</label>`;
    }).join('');
    $('set-note').textContent = '';
  } catch (e) {
    $('set-sub').textContent = e.message;
  }
}

async function saveSettings(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (!settingsLoaded) return;
  const values = {};
  qsa('#set-form input[data-key]').forEach((inp) => {
    const k = inp.dataset.key;
    const orig = settingsLoaded.settings[k].value;
    if (inp.value.trim() !== (orig == null ? '' : orig) && inp.value.trim() !== '') values[k] = inp.value.trim();
  });
  if (!Object.keys(values).length) return toast('info', 'Nothing changed');
  const btn = $('set-save');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    toast('success', 'Settings saved', r.note);
    $('set-note').textContent = r.note || '';
    await loadSettings();
    $('set-note').textContent = r.note || '';
  } catch (e) {
    toast('error', 'Could not save settings', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---- Admin / ban / permitted lists (API: /api/lists) ---- */

let listsState = null;
const LIST_TITLES = { admin: 'Admins', banned: 'Banned', permitted: 'Whitelist' };

async function loadLists() {
  const wrap = $('lists-wrap');
  if (!wrap) return;
  try {
    listsState = await api('/api/lists');
    renderLists();
  } catch (e) {
    wrap.innerHTML = `<p class="card-note">${esc(e.message)}</p>`;
  }
}

function renderLists() {
  const wrap = $('lists-wrap');
  wrap.innerHTML = Object.keys(LIST_TITLES).map((k) => {
    const rows = listsState.lists[k] || [];
    return `<div data-list="${k}">
      <h3 style="margin:0 0 8px">${LIST_TITLES[k]} <span class="card-note">(${rows.length})</span></h3>
      <ul style="list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:4px">${rows.map((e, i) => `<li style="display:flex;gap:8px;align-items:center"><code>${esc(e.id)}</code><span class="card-note" style="flex:1">${esc(e.note)}</span><button class="btn btn-secondary btn-sm" onclick="removeListEntry('${k}',${i})" aria-label="Remove">Remove</button></li>`).join('') || '<li class="card-note">Empty</li>'}</ul>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><input class="input" id="list-id-${k}" placeholder="SteamID64" inputmode="numeric" maxlength="17" style="flex:1 1 100%;min-width:0"><input class="input" id="list-note-${k}" placeholder="Name (optional)" style="flex:1 1 120px;min-width:0"><button class="btn btn-primary btn-sm" onclick="addListEntry('${k}')">Add</button></div>
    </div>`;
  }).join('');
}

async function saveList(which, entries) {
  try {
    const r = await api('/api/lists/' + which, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
    toast('success', `${LIST_TITLES[which]} saved`, r.note);
    listsState.lists[which] = entries;
    renderLists();
  } catch (e) {
    toast('error', 'Could not save the list', e.message);
  }
}

function addListEntry(which) {
  const id = $('list-id-' + which).value.trim();
  const note = $('list-note-' + which).value.trim();
  if (!/^\d{17}$/.test(id)) return toast('error', 'Not a SteamID64', 'It must be exactly 17 digits (find it on steamid.io).');
  const cur = listsState.lists[which] || [];
  if (cur.some((e) => e.id === id)) return toast('info', 'Already in the list');
  saveList(which, [...cur, { id, note }]);
}

async function removeListEntry(which, i) {
  const cur = listsState.lists[which] || [];
  const e = cur[i];
  if (!e) return;
  const ok = await confirmDialog({ title: `Remove from ${LIST_TITLES[which].toLowerCase()}?`, html: `<code>${esc(e.id)}</code> ${esc(e.note)}`, confirmLabel: 'Remove', tone: 'warn' });
  if (!ok) return;
  saveList(which, cur.filter((_, j) => j !== i));
}


/* ---- Host details (extra fields of /api/system/stats) ---- */

function renderHostDetails(r) {
  if (!$('stat-steal')) return;
  const pct = (v) => (v == null ? '…' : `${v.toFixed(1)}<span class="unit">%</span>`);
  $('stat-steal').innerHTML = pct(r.cpuStealPercent);
  const steal = r.cpuStealPercent;
  $('stat-steal-sub').textContent = steal == null ? 'Needs a second poll' : steal >= 5 ? 'High — the host is oversold; expect lag' : steal >= 1 ? 'Some contention from other tenants' : 'None — the VPS gets its full CPU';
  $('stat-iowait').innerHTML = pct(r.cpuIowaitPercent);
  $('stat-vmem').textContent = r.valheimMemMB == null ? '—' : r.valheimMemMB >= 1024 ? `${(r.valheimMemMB / 1024).toFixed(1)} GB` : `${r.valheimMemMB} MB`;
  $('stat-swap').textContent = r.swapTotalMB ? `${r.swapUsedMB} MB` : 'No swap';
  $('stat-swap-sub').textContent = r.swapTotalMB ? `of ${r.swapTotalMB} MB${r.swapUsedMB > r.swapTotalMB * 0.5 ? ' — memory is tight' : ''}` : '';
  $('stat-bkdir').textContent = r.backupDirMB == null ? '…' : r.backupDirMB >= 1024 ? `${(r.backupDirMB / 1024).toFixed(1)} GB` : `${r.backupDirMB} MB`;
}

/* ---- Restart-required banner (API: GET /api/pending-changes) ---- */

async function refreshPending() {
  const box = $('pending-banner');
  if (!box) return;
  try {
    const r = await api('/api/pending-changes');
    if (!r.required) return box.classList.add('hidden');
    const uniq = [...new Set(r.changes.map((c) => c.label))];
    $('pending-banner-text').textContent = uniq.slice(0, 6).join(' · ') + (uniq.length > 6 ? ` · +${uniq.length - 6} more` : '');
    box.classList.remove('hidden');
  } catch (e) {
    /* leave as is */
  }
}
setInterval(() => { if (activeGame !== 'zomboid') refreshPending(); }, 15000);
setTimeout(refreshPending, 1500);

/* ---- World modifiers (API: GET/POST /api/modifiers) ---- */

let wmState = null;
const WM_LABELS = { combat: 'Combat difficulty', deathpenalty: 'Death penalty', resources: 'Resource rate', raids: 'Raids', portals: 'Portals' };
const WM_KEY_LABELS = { nobuildcost: 'No build cost', playerevents: 'Player-based events', passivemobs: 'Passive mobs', nomap: 'No map' };

async function loadModifiers() {
  const wrap = $('wm-wrap');
  if (!wrap) return;
  try {
    const r = await api('/api/modifiers');
    wmState = r;
    const sel = (id, label, opts, cur) => `<label style="display:flex;flex-direction:column;gap:4px"><span>${esc(label)}</span><select id="${id}"><option value="">Default</option>${opts.map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    wrap.innerHTML = sel('wm-preset', 'Preset', r.options.presets, r.preset) +
      Object.entries(r.options.modifiers).map(([k, opts]) => sel('wm-mod-' + k, WM_LABELS[k] || k, opts, r.modifiers[k])).join('');
    $('wm-keys').innerHTML = r.options.keys.map((k) => `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="wm-key-${k}"${r.keys.includes(k) ? ' checked' : ''}> ${esc(WM_KEY_LABELS[k] || k)}</label>`).join('');
    $('wm-warn').innerHTML = r.extra ? `<span class="badge warn">Other options kept</span> ${esc(r.extra)}` : '';
    wrap.querySelectorAll('select').forEach((s) => s.addEventListener('change', previewModifiers));
    $('wm-keys').querySelectorAll('input').forEach((s) => s.addEventListener('change', previewModifiers));
    previewModifiers();
  } catch (e) {
    $('wm-sub').textContent = e.message;
  }
}

function collectModifiers() {
  const modifiers = {};
  Object.keys(wmState.options.modifiers).forEach((k) => { const v = $('wm-mod-' + k).value; if (v) modifiers[k] = v; });
  return {
    preset: $('wm-preset').value,
    modifiers,
    keys: wmState.options.keys.filter((k) => $('wm-key-' + k).checked),
    extra: wmState.extra || '',
  };
}

function previewModifiers() {
  if (!wmState) return;
  const c = collectModifiers();
  const parts = [];
  if (c.preset) parts.push(`-preset ${c.preset}`);
  Object.entries(c.modifiers).forEach(([k, v]) => parts.push(`-modifier ${k} ${v}`));
  c.keys.forEach((k) => parts.push(`-setkey ${k}`));
  if (c.extra) parts.push(c.extra);
  $('wm-preview').textContent = parts.length ? parts.join(' ') : 'Launch options: none (normal rules)';
}

async function saveModifiers() {
  if (!wmState) return;
  const btn = $('wm-save');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/modifiers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectModifiers()) });
    toast(r.applied ? 'success' : 'info', r.applied ? 'World modifiers saved' : 'Nothing changed', r.note);
    await loadModifiers();
  } catch (e) {
    toast('error', 'Could not save modifiers', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---- Mod config editor (API: /api/configs) ---- */

let cfgState = null; // { name, entries, edits: Map("section\u0000key" -> value) }

async function loadConfigList() {
  const sel = $('cfg-file');
  if (!sel) return;
  try {
    const r = await api('/api/configs');
    sel.innerHTML = r.files.length
      ? r.files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)} (${Math.max(1, Math.round(f.size / 1024))} KB)</option>`).join('')
      : '<option value="">No config files found</option>';
    $('cfg-note').textContent = r.files.length ? `${r.files.length} config files in ${r.dir}` : `Nothing found in ${r.dir}`;
    if (r.files.length) loadConfigFile();
  } catch (e) {
    $('cfg-note').textContent = e.message;
  }
}

async function loadConfigFile() {
  const name = $('cfg-file').value;
  if (!name) return;
  if (cfgState && cfgState.edits.size && !(await confirmDialog({ title: 'Discard unsaved edits?', html: 'You have unsaved changes in the current file.', confirmLabel: 'Discard', tone: 'warn' }))) {
    $('cfg-file').value = cfgState.name;
    return;
  }
  $('cfg-entries').innerHTML = '<div class="spinner"></div>';
  try {
    const r = await api('/api/configs/file?name=' + encodeURIComponent(name));
    cfgState = { name, entries: r.entries, edits: new Map() };
    renderConfigEntries();
  } catch (e) {
    cfgState = null;
    $('cfg-entries').innerHTML = `<p class="card-note">${esc(e.message)}</p>`;
  }
}

const cfgKey = (e) => e.section + '\u0000' + e.key;

function cfgInputHtml(e, idx, val) {
  const t = (e.type || '').toLowerCase();
  const id = `cfg-in-${idx}`;
  if (t === 'boolean') return `<input type="checkbox" id="${id}" data-idx="${idx}"${/^true$/i.test(val) ? ' checked' : ''}>`;
  const flags = /flags/i.test(e.description || '');
  if (e.acceptable && !flags && e.acceptable.length <= 40) {
    const opts = e.acceptable.some((a) => a.toLowerCase() === String(val).toLowerCase()) ? e.acceptable : [val, ...e.acceptable];
    return `<select id="${id}" data-idx="${idx}">${opts.map((o) => `<option value="${esc(o)}"${o.toLowerCase() === String(val).toLowerCase() ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  return `<input class="input" type="text" id="${id}" data-idx="${idx}" value="${esc(val)}" spellcheck="false" style="min-width:0;width:100%">`;
}

function renderConfigEntries() {
  const box = $('cfg-entries');
  if (!cfgState) return;
  const q = ($('cfg-filter').value || '').trim().toLowerCase();
  const rows = [];
  let lastSection = null;
  cfgState.entries.forEach((e, idx) => {
    if (q && !(`${e.section} ${e.key} ${e.description}`.toLowerCase().includes(q))) return;
    if (e.section !== lastSection) { rows.push(`<h3 style="margin:16px 0 6px">${esc(e.section || '(no section)')}</h3>`); lastSection = e.section; }
    const edited = cfgState.edits.has(cfgKey(e));
    const val = edited ? cfgState.edits.get(cfgKey(e)) : e.value;
    const meta = [e.type, e.range, e.default !== '' ? `default: ${e.default}` : ''].filter(Boolean).join(' · ');
    rows.push(`<div style="display:grid;grid-template-columns:minmax(160px,1fr) minmax(160px,1fr);gap:8px 16px;padding:8px 0;border-bottom:1px solid var(--border)${edited ? ';background:var(--warn-soft)' : ''}">
      <div><div><strong>${esc(e.key)}</strong>${edited ? ' <span class="badge warn">edited</span>' : ''}</div><div class="card-note" style="white-space:pre-wrap">${esc(e.description)}</div><div class="card-note">${esc(meta)}</div></div>
      <div style="display:flex;align-items:center">${cfgInputHtml(e, idx, val)}</div></div>`);
  });
  box.innerHTML = rows.join('') || '<p class="card-note">No matching settings.</p>';
  box.querySelectorAll('[data-idx]').forEach((el) => {
    const handler = () => onConfigEdit(Number(el.dataset.idx), el);
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
  });
  updateCfgSave();
}

function onConfigEdit(idx, el) {
  const e = cfgState.entries[idx];
  const val = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
  if (val === e.value || (el.type === 'checkbox' && val.toLowerCase() === String(e.value).toLowerCase())) cfgState.edits.delete(cfgKey(e));
  else cfgState.edits.set(cfgKey(e), val);
  updateCfgSave();
}

function updateCfgSave() {
  const n = cfgState ? cfgState.edits.size : 0;
  const btn = $('cfg-save');
  btn.disabled = !n;
  btn.textContent = n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save changes';
}

async function saveConfigFile() {
  if (!cfgState || !cfgState.edits.size) return;
  const changes = [...cfgState.edits].map(([k, value]) => { const [section, key] = k.split('\u0000'); return { section, key, value }; });
  const ok = await confirmDialog({ title: `Save ${changes.length} change${changes.length === 1 ? '' : 's'} to ${cfgState.name}?`, html: `<ul style="margin:0;padding-left:18px">${changes.slice(0, 12).map((c) => `<li><code>${esc(c.key)}</code> → <code>${esc(c.value)}</code></li>`).join('')}</ul>A backup copy of the file is made first. Changes apply after Stop → Start.`, confirmLabel: 'Save' });
  if (!ok) return;
  const btn = $('cfg-save');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/configs/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cfgState.name, changes }) });
    toast('success', 'Config saved', r.note);
    const name = cfgState.name;
    cfgState.edits.clear();
    const fresh = await api('/api/configs/file?name=' + encodeURIComponent(name));
    cfgState = { name, entries: fresh.entries, edits: new Map() };
    renderConfigEntries();
  } catch (e) {
    toast('error', 'Could not save', e.message);
  } finally {
    setBtnLoading(btn, false);
    updateCfgSave();
  }
}

/* ==========================================================================
   9. Server updates (API: SSE /api/update/check, SSE /api/update/apply)
   ========================================================================== */

async function checkUpdate() {
  const btn = qs('#tab-updates .action-card:not(.warn) .btn');
  setBtnLoading(btn, true);
  const code = await streamToConsole('/api/update/check', $('update-output'));
  setBtnLoading(btn, false);
  code === '0' ? toast('success', 'Update check finished', 'See the output for the result.') : toast('warn', 'Update check did not finish cleanly');
  recordEvent('info', 'Checked for server update', code === '0' ? '' : `exit ${code}`, 'download-cloud');
}

async function applyUpdate() {
  const ok = await confirmDialog({
    title: 'Apply the server update now?',
    tone: 'warn',
    html: '<p>Make sure your mods are compatible with the new server build first — BepInEx plugins frequently break across Valheim updates.</p><p class="muted">Tip: run a backup before updating.</p>',
    confirmLabel: 'Apply update',
  });
  if (!ok) return;
  const btn = qs('#tab-updates .action-card.warn .btn');
  setBtnLoading(btn, true);
  recordEvent('warn', 'Server update started', '', 'download-cloud');
  const code = await streamToConsole('/api/update/apply', $('update-output'));
  setBtnLoading(btn, false);
  if (code === '0') {
    toast('success', 'Server update applied');
    recordEvent('good', 'Server update applied', '', 'download-cloud');
  } else {
    toast('error', 'Server update failed', code ? `Exit code ${code}` : 'Stream closed early');
    recordEvent('bad', 'Server update failed', code ? `exit ${code}` : '', 'download-cloud');
  }
}

/* ==========================================================================
   10. Logs (API: GET /api/logs/journal, GET /api/logs/tail, SSE /api/logs/live)
   ========================================================================== */

const LOG_MAX_LINES = 5000;
let logFollow = true;
let logLevel = 'all';
let logLineCount = 0;

function classifyLine(text) {
  if (/^\[(stream closed|live stream stopped)\]$/.test(text.trim())) return 'meta';
  if (/\b(error|exception|fatal|failed|failure|crash(ed)?)\b/i.test(text)) return 'error';
  if (/\bwarn(ing)?\b/i.test(text)) return 'warn';
  return '';
}

function lineMatches(el) {
  const q = ($('log-filter').value || '').toLowerCase();
  const lvl = el.dataset.level;
  const levelOk = logLevel === 'all' || (logLevel === 'error' ? lvl === 'error' : lvl === 'warn' || lvl === 'error');
  return levelOk && (!q || el.textContent.toLowerCase().includes(q));
}

function appendLogLines(lines) {
  const view = $('logs-output');
  const emptyEl = view.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();
  const frag = document.createDocumentFragment();
  lines.forEach((text) => {
    const span = document.createElement('span');
    const lvl = classifyLine(text);
    span.className = 'ln' + (lvl ? ' ' + lvl : '');
    span.dataset.level = lvl;
    span.textContent = text;
    if (!lineMatches(span)) span.classList.add('hide');
    frag.appendChild(span);
  });
  view.appendChild(frag);
  logLineCount += lines.length;
  while (logLineCount > LOG_MAX_LINES && view.firstChild) {
    view.firstChild.remove();
    logLineCount--;
  }
  $('log-line-count').textContent = `${logLineCount.toLocaleString()} lines`;
  if (logFollow) view.scrollTop = view.scrollHeight;
}

function setLogStatus(state, text) {
  $('log-status').className = 'log-status ' + (state || '');
  $('log-status-text').textContent = text;
}

function renderLogEmpty() {
  $('logs-output').innerHTML = `<div class="log-empty"><div class="empty-icon">${icon('terminal')}</div><div class="empty-title">No logs loaded</div><div class="empty-text">Load a snapshot of recent lines, or go live to stream new lines as they're written.</div></div>`;
  logLineCount = 0;
  $('log-line-count').textContent = '0 lines';
}

function clearLogs() {
  renderLogEmpty();
  if (!liveSource) setLogStatus('', 'Idle');
}

async function loadLogs() {
  const source = $('log-source').value;
  const lines = $('log-lines').value;
  const out = $('logs-output');
  const btn = qs('#tab-logs [onclick="loadLogs()"]');
  const endpoint = source === 'journal' ? '/api/logs/journal' : '/api/logs/tail';
  setBtnLoading(btn, true);
  setLogStatus('', 'Loading snapshot…');
  try {
    const r = await fetch(`${endpoint}?lines=${lines}`).then((r) => r.json());
    const text = r.text || r.error || '(empty)';
    if (liveSource) toggleLive();
    out.innerHTML = '';
    logLineCount = 0;
    appendLogLines(text.replace(/\n$/, '').split('\n'));
    setLogStatus(r.error ? 'error' : '', `${r.error ? 'Error' : 'Snapshot'} · ${source === 'journal' ? 'LGSM console log' : 'LogOutput.log'} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setLogStatus('error', 'Failed: ' + e.message);
    toast('error', 'Could not load logs', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}

let liveSource = null;

function stopLogsLive() {
  if (liveSource) {
    liveSource.close();
    liveSource = null;
    setLiveButton(false);
  }
}

function setLiveButton(live) {
  const btn = $('live-toggle');
  btn.innerHTML = live ? `${icon('stop')}Stop live` : `${icon('play')}Go live`;
  btn.className = live ? 'btn btn-danger-soft' : 'btn btn-primary';
  $('sb-live-dot').classList.toggle('hidden', !live);
}

function toggleLive() {
  if (liveSource) {
    liveSource.close();
    liveSource = null;
    setLiveButton(false);
    appendLogLines(['[live stream stopped]']);
    setLogStatus('', 'Stopped');
    return;
  }
  const source = $('log-source').value;
  $('logs-output').innerHTML = '';
  logLineCount = 0;
  appendLogLines([]);
  liveSource = new EventSource(`/api/logs/live?source=${source}`);
  setLogStatus('live', `Live · ${source === 'journal' ? 'LGSM console log' : 'LogOutput.log'}`);
  liveSource.onmessage = (e) => appendLogLines([e.data]);
  liveSource.onerror = () => {
    appendLogLines(['[stream closed]']);
    if (liveSource) liveSource.close();
    liveSource = null;
    setLiveButton(false);
    setLogStatus('error', 'Stream closed');
  };
  setLiveButton(true);
}

function applyLogFilter() {
  qsa('#logs-output .ln').forEach((el) => el.classList.toggle('hide', !lineMatches(el)));
}
qsa('#log-level-chips .chip').forEach((c) => {
  c.onclick = () => {
    logLevel = c.dataset.level;
    qsa('#log-level-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
    applyLogFilter();
  };
});
function toggleLogWrap() {
  const on = $('logs-output').classList.toggle('wrap');
  $('log-wrap-btn').setAttribute('aria-pressed', on);
}
function toggleLogFollow() {
  logFollow = !logFollow;
  $('log-follow-btn').setAttribute('aria-pressed', logFollow);
  $('log-follow-btn').classList.toggle('active', logFollow);
  if (logFollow) $('logs-output').scrollTop = $('logs-output').scrollHeight;
}
function visibleLogText() {
  return qsa('#logs-output .ln:not(.hide)').map((el) => el.textContent).join('\n');
}
async function copyLogs() {
  const t = visibleLogText();
  if (!t) return toast('info', 'Nothing to copy');
  (await copyText(t)) ? toast('success', 'Log lines copied') : toast('error', 'Copy failed');
}
function downloadLogs() {
  const t = visibleLogText();
  if (!t) return toast('info', 'Nothing to download');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }));
  a.download = `${$('log-source').value === 'journal' ? 'journal' : 'LogOutput'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Pause auto-follow when the user scrolls up; resume at the bottom.
$('logs-output').addEventListener('scroll', (e) => {
  const v = e.target;
  const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 24;
  if (logFollow !== atBottom && (liveSource || !atBottom)) {
    logFollow = atBottom;
    $('log-follow-btn').setAttribute('aria-pressed', logFollow);
    $('log-follow-btn').classList.toggle('active', logFollow);
  }
});

/* ==========================================================================
   10b. Worlds (API: /api/instances)
   A world is a separate server instance. Which one every other tab acts on is the
   vg_instance cookie (set by the sidebar switcher); the Worlds page can also act on any
   world directly with ?instance=<id>.
   ========================================================================== */
let worldsCache = null; // [{ id, label, main, state, port, ... }]
let currentWorldId = 'main';
let worldsTimer = null;

const worldTitle = (w) => (w.main ? (w.worldReady ? w.world : w.label) : w.label);
const worldQ = (id) => `?instance=${encodeURIComponent(id)}`;

async function loadWorldList() {
  try {
    const r = await api('/api/instances');
    worldsCache = r.instances;
    currentWorldId = r.current;
    renderWorldSwitch();
    return r;
  } catch (e) {
    return null;
  }
}

function renderWorldSwitch() {
  const sw = $('world-switch');
  if (!sw || !worldsCache) return;
  const many = worldsCache.length > 1;
  sw.classList.toggle('hidden', !many);
  $('world-select').innerHTML = worldsCache
    .map((w) => `<option value="${esc(w.id)}"${w.id === currentWorldId ? ' selected' : ''}>${esc(worldTitle(w))}${w.state === 'active' ? ' · running' : ''}</option>`)
    .join('');
  const cnt = $('sb-worlds-count');
  if (cnt) {
    const running = worldsCache.filter((w) => w.state === 'active').length;
    cnt.textContent = running;
    cnt.className = 'sb-count' + (many ? '' : ' hidden');
    cnt.setAttribute('data-tip', `${running} of ${worldsCache.length} worlds running`);
  }
}

async function switchWorld(id) {
  try {
    await api('/api/instances/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    location.reload(); // every tab re-reads for the chosen world
  } catch (e) {
    toast('error', 'Could not switch world', e.message);
    renderWorldSwitch();
  }
}

async function manageWorld(id, page) {
  try {
    await api('/api/instances/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    location.hash = page || 'dashboard';
    location.reload();
  } catch (e) {
    toast('error', 'Could not open this world', e.message);
  }
}

function renderWorldCard(w) {
  if (w.error) return `<div class="world-card"><div class="world-card-head"><div><h3>${esc(w.label || w.id)}</h3><div class="world-sub">${esc(w.error)}</div></div></div></div>`;
  const running = w.state === 'active';
  const pill = !w.installed ? '<span class="pill unknown plain">not set up</span>' : running ? '<span class="pill active">running</span>' : '<span class="pill inactive">stopped</span>';
  const portText = w.portExplicit || w.main ? `${w.port}` : w.plannedPort ? `${w.plannedPort} <span class="muted">(planned, saved in Setup step 3)</span>` : '<span class="muted">not set</span>';
  const worldText = w.worldReady ? esc(w.world) : `${esc(w.world && w.world !== 'vhserver' ? w.world : '—')} <span class="muted">${w.installed ? '(created on first start)' : ''}</span>`;
  const needsSetup = !w.installed || !w.worldReady;
  const btns = [];
  btns.push(`<button class="btn btn-primary btn-sm" onclick="manageWorld('${esc(w.id)}')">Manage</button>`);
  if (w.installed) {
    btns.push(running
      ? `<button class="btn btn-danger-soft btn-sm" onclick="worldAction('${esc(w.id)}','stop')">Stop</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="worldAction('${esc(w.id)}','start')">Start</button>`);
  }
  if (needsSetup) btns.push(`<button class="btn btn-secondary btn-sm" onclick="manageWorld('${esc(w.id)}','setup')">${w.installed ? 'Finish setup' : 'Set up'}</button>`);
  if (!w.main) {
    btns.push(`<button class="btn btn-ghost btn-sm" onclick="renameWorld('${esc(w.id)}')">Rename</button>`);
    btns.push(`<button class="btn btn-ghost btn-sm" onclick="removeWorld('${esc(w.id)}')">Remove</button>`);
  }
  return `<div class="world-card${w.id === currentWorldId ? ' current' : ''}">
    <div class="world-card-head">
      <div><h3>${esc(worldTitle(w))}</h3><div class="world-sub">${w.main ? 'Main world' : esc(w.label)}${w.serverName ? ' · ' + esc(w.serverName) : ''}${w.id === currentWorldId ? ' · <strong>selected</strong>' : ''}</div></div>
      ${pill}
    </div>
    <dl class="world-meta">
      <dt>World</dt><dd>${worldText}</dd>
      <dt>Game port</dt><dd>${portText}</dd>
      <dt>Game account</dt><dd><code>${esc(w.lgsmUser)}</code></dd>
    </dl>
    <div class="world-actions">${btns.join('')}</div>
  </div>`;
}

async function loadWorlds() {
  const grid = $('worlds-grid');
  if (!grid) return;
  if (!worldsCache) grid.innerHTML = '<div class="world-card"><span class="skeleton w-60"></span><span class="skeleton w-80"></span></div>';
  const r = await loadWorldList();
  if (!r) {
    grid.innerHTML = emptyState({ title: 'Could not load worlds', text: 'Check the connection and try again.', error: true, small: true, action: '<button class="btn btn-secondary btn-sm" onclick="loadWorlds()">Try again</button>' });
    return;
  }
  grid.innerHTML = r.instances.map(renderWorldCard).join('');
}

async function worldAction(id, action) {
  const w = (worldsCache || []).find((x) => x.id === id);
  const name = w ? worldTitle(w) : id;
  if (action === 'stop') {
    const ok = await confirmDialog({
      title: `Stop ${name}?`,
      html: '<p>Players in this world will be disconnected. The world is saved first. Other worlds keep running.</p>',
      confirmLabel: 'Stop world',
      tone: 'danger',
    });
    if (!ok) return;
  }
  toast('info', `${action === 'start' ? 'Starting' : 'Stopping'} ${name}…`, 'This can take a minute.');
  try {
    const r = await api(`/api/server/${action}${worldQ(id)}`, { method: 'POST' });
    const failed = r.code && r.code !== 0;
    if (failed) toast('error', `${name}: ${action} failed`, (r.stderr || r.stdout || '').trim().slice(0, 200));
    else toast('success', `${name}: ${action} sent`, 'Status refreshes in a moment.');
    recordEvent(failed ? 'bad' : 'accent', `${name}: ${action} ${failed ? 'failed' : 'requested'}`, 'from the Worlds page', { start: 'play', stop: 'stop' }[action]);
  } catch (e) {
    toast('error', `${name}: ${action} failed`, e.message);
  }
  loadWorlds();
  setTimeout(loadWorlds, 8000);
  setTimeout(refreshStatus, 1500);
}

async function openAddWorld() {
  const res = await dialog({
    title: 'Add a world',
    tone: 'info',
    iconName: 'server',
    html: '<p>Creates a separate server for the new world: its own game account, files, mods, backups and game port. After adding it you set it up with the same 8 steps as the first server (about 2 GB of disk for the game files).</p>',
    input: { label: 'World name', placeholder: 'e.g. Hardcore Run', help: '1-30 letters, digits, spaces, . _ -  (this is just the label in the GUI; the in-game world name is chosen in Setup step 3)' },
    actions: [{ key: 'create', label: 'Add world', variant: 'btn-primary' }],
  });
  if (!res || res.key !== 'create') return;
  try {
    const r = await api('/api/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: res.input }) });
    toast('success', 'World added', `Game port ${r.instance.plannedPort} is reserved for it. Opening Setup…`);
    recordEvent('good', `Added world ${r.instance.label}`, `port ${r.instance.plannedPort}`, 'server');
    await manageWorld(r.instance.id, 'setup');
  } catch (e) {
    toast('error', 'Could not add the world', e.message);
  }
}

async function renameWorld(id) {
  const w = (worldsCache || []).find((x) => x.id === id);
  const res = await dialog({
    title: 'Rename world',
    tone: 'info',
    iconName: 'info',
    html: '<p>Changes the label used in this GUI only. The in-game world name is not touched.</p>',
    input: { label: 'New name', placeholder: w ? w.label : '' },
    actions: [{ key: 'rename', label: 'Rename', variant: 'btn-primary' }],
  });
  if (!res || res.key !== 'rename' || !res.input) return;
  try {
    await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: res.input }) });
    toast('success', 'Renamed');
    loadWorlds();
  } catch (e) {
    toast('error', 'Could not rename', e.message);
  }
}

async function removeWorld(id) {
  const w = (worldsCache || []).find((x) => x.id === id);
  if (!w) return;
  if (w.state === 'active') return toast('warn', 'Stop this world first', 'A running world cannot be removed.');
  let pv = null;
  try {
    pv = await api(`/api/instances/${encodeURIComponent(id)}/uninstall-preview`);
  } catch (e) {
    /* the dialog still works without the size preview */
  }
  const size = pv && pv.userExists ? `${pv.sizeMB >= 1024 ? (pv.sizeMB / 1024).toFixed(1) + ' GB' : pv.sizeMB + ' MB'} on disk, ${pv.saves} world save${pv.saves === 1 ? '' : 's'}, ${pv.backups} backup file${pv.backups === 1 ? '' : 's'}` : null;
  const res = await dialog({
    title: `Remove ${worldTitle(w)}?`,
    tone: 'danger',
    html:
      `<p><strong>Remove from GUI only</strong> keeps everything on the VPS: the game account <code>${esc(w.lgsmUser)}</code>, its files and its backups.</p>` +
      `<p><strong>Delete everything</strong> uninstalls the world from the VPS: it stops any leftover processes, removes the scheduled jobs, and deletes the game account <code>${esc(w.lgsmUser)}</code> with its home folder (game files, mods, saves and backups)${size ? ` &mdash; ${esc(size)}` : ''}. <strong>This cannot be undone.</strong> <em>Delete, keep a copy</em> first copies the world saves and backups to <code>/var/lib/valheim-removed-worlds/</code> on the VPS.</p>` +
      `<p>The other worlds are not touched.</p>`,
    input: { label: 'To enable the delete buttons, type <code>DELETE</code>', placeholder: 'DELETE', match: 'DELETE' },
    actions: [
      { key: 'forget', label: 'Remove from GUI only', variant: 'btn-ghost' },
      { key: 'keep', label: 'Delete, keep a copy', variant: 'btn-warn', needsMatch: true },
      { key: 'purge', label: 'Delete everything', variant: 'btn-danger', needsMatch: true },
    ],
  });
  if (!res || !res.key) return;
  const mode = res.key;
  const q = mode === 'purge' ? '?purge=1' : mode === 'keep' ? '?purge=1&keep=1' : '';
  try {
    if (mode !== 'forget') toast('info', 'Uninstalling…', 'Deleting the world from the VPS can take a minute.');
    const r = await api(`/api/instances/${encodeURIComponent(id)}${q}`, { method: 'DELETE' });
    toast('success', mode === 'forget' ? 'World removed' : 'World uninstalled', r.note || '');
    recordEvent('accent', `${mode === 'forget' ? 'Removed' : 'Uninstalled'} world ${worldTitle(w)}`, mode === 'forget' ? 'from the GUI' : 'deleted from the VPS', 'server');
    if (id === currentWorldId) {
      await api('/api/instances/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'main' }) });
      location.reload();
      return;
    }
    loadWorlds();
  } catch (e) {
    toast('error', 'Could not remove the world', e.message);
  }
}

// Keep the Worlds page fresh while it is open.
setInterval(() => {
  if (currentPage === 'worlds' && !document.hidden) loadWorlds();
}, 10000);

/* ==========================================================================
   11. Setup (API: /api/setup/*)
   ========================================================================== */

// Step 3 is done once a password is set, and (for an extra world) its own game port is saved.
function identityOk(r) {
  return !!(r.identity && r.identity.passwordSet && ((r.instance && r.instance.main) || r.identity.portSet));
}
let lastSetupStatus = null;

// Each check reads one field of /api/setup/status. `ok(r)` says whether it is done.
const SETUP_CHECKS = [
  { label: 'Game account + LinuxGSM', ok: (r) => r.lgsmUser && r.lgsmInstalled, hint: 'Step 1' },
  { label: 'Valheim server files', ok: (r) => r.dedicatedServer, hint: 'Step 2' },
  { label: 'Name, world, password and port', ok: (r) => identityOk(r), hint: 'Step 3' },
  { label: 'BepInEx files', ok: (r) => r.bepinexCore && r.bepinexLauncher, hint: 'Step 4' },
  { label: 'common.cfg → BepInEx', ok: (r) => r.doorstopWired, hint: 'Step 5' },
  { label: 'ValheimEnforcer plugin', ok: (r) => r.enforcerPlugin, hint: 'Step 6' },
  { label: 'Jotunn (Enforcer needs it)', ok: (r) => r.jotunnPlugin, hint: 'Step 6' },
  { label: 'Helper scripts', ok: (r) => r.ruamel && Object.values(r.helpers || {}).every(Boolean), hint: 'Step 7' },
  { label: 'Server running', ok: (r) => r.serverState === 'active', hint: 'Step 8' },
  { label: 'Game port open', ok: (r) => !!r.portOpen, hint: 'Step 8 — can take a few minutes after the first start' },
  { label: 'World created', ok: (r) => !!(r.identity && r.identity.worldCreated), hint: 'Step 8' },
  { label: 'BepInEx loaded', ok: (r) => r.bepinexLoaded, hint: 'Step 8 — needs steps 4 and 5 before the start' },
  { label: 'ValheimEnforcer loaded', ok: (r) => r.enforcerLoaded, hint: 'Step 8 — needs step 6 before the start' },
  { label: 'Mods.yaml present', ok: (r) => r.enforcerConfig, hint: 'Step 8 — written by ValheimEnforcer on its first run' },
];
const STEP_REQUIREMENTS = {
  'step-1': (r) => r.lgsmUser && r.lgsmInstalled,
  'step-2': (r) => r.dedicatedServer,
  'step-3': (r) => identityOk(r),
  'step-4': (r) => r.bepinexCore && r.bepinexLauncher,
  'step-5': (r) => r.doorstopWired,
  'step-6': (r) => r.enforcerPlugin && r.jotunnPlugin,
  'step-7': (r) => r.ruamel && Object.values(r.helpers || {}).every(Boolean),
  'step-8': (r) => r.serverState === 'active' && !!r.portOpen && !!(r.identity && r.identity.worldCreated) && r.bepinexLoaded && r.enforcerLoaded && r.enforcerConfig,
};
let setupIdentityLoaded = false;
let setupPollTimers = [];

async function loadSetupStatus() {
  const grid = $('setup-status-grid');
  if (!grid.children.length) {
    grid.innerHTML = SETUP_CHECKS.map(() => '<div class="check-item"><span class="skeleton" style="width:22px;height:22px;border-radius:50%"></span><span class="skeleton w-60"></span></div>').join('');
  }
  try {
    const [r, live] = await Promise.all([api('/api/setup/status'), api('/api/status').catch(() => ({}))]);
    if (r.error) throw new Error(r.error);
    r.portOpen = !!live.portOpen;
    grid.innerHTML = SETUP_CHECKS.map((c) => {
      const done = !!c.ok(r);
      return `<div class="check-item ${done ? 'yes' : 'no'}" data-tip="${esc(c.hint)}"><span class="ci-icon">${icon(done ? 'check' : 'x')}</span><div><div class="ci-label">${esc(c.label)}</div><div class="ci-state">${done ? 'Done' : 'Not yet'}</div></div></div>`;
    }).join('');
    const done = SETUP_CHECKS.filter((c) => c.ok(r)).length;
    $('setup-progress-text').textContent = `${done} of ${SETUP_CHECKS.length} complete`;
    $('setup-progress-bar').style.width = `${(done / SETUP_CHECKS.length) * 100}%`;

    let stepsLeft = 0;
    Object.entries(STEP_REQUIREMENTS).forEach(([id, fn]) => {
      const isDone = !!fn(r);
      if (!isDone) stepsLeft++;
      $(id).classList.toggle('done', isDone);
      const num = $(id).querySelector('.step-num');
      num.innerHTML = isDone ? icon('check') : id.slice(-1);
      $(id).querySelector('[data-step-state]').innerHTML = isDone ? '<span class="badge good">Done</span>' : '<span class="badge">Pending</span>';
    });
    const sb = $('sb-setup-count');
    sb.textContent = stepsLeft;
    sb.className = 'sb-count warn' + (stepsLeft ? '' : ' hidden');
    sb.setAttribute('data-tip', `${pluralize(stepsLeft, 'setup step')} remaining`);

    lastSetupStatus = r;
    const chip = $('setup-world-chip');
    if (chip) {
      const many = worldsCache && worldsCache.length > 1;
      chip.classList.toggle('hidden', !many);
      if (many) chip.innerHTML = `Setting up: <strong>${esc((r.instance && r.instance.label) || 'Main world')}</strong> <span class="muted">(game account ${esc(worldsCache.find((w) => w.id === r.instance.id)?.lgsmUser || '')}) — change world in the sidebar</span>`;
    }

    if (!r.identity && r.plannedPort && $('setup-port') && !$('setup-port').value) $('setup-port').value = r.plannedPort;
    // Fill the name/world fields once from what the server currently has (never overwrite typing).
    if (r.identity && !setupIdentityLoaded) {
      setupIdentityLoaded = true;
      $('setup-port').value = r.identity.portSet ? r.identity.port : r.identity.plannedPort || (r.instance && r.instance.main ? r.identity.port : '');
      if (r.identity.serverName && r.identity.serverName !== 'LinuxGSM') $('setup-servername').value = r.identity.serverName;
      $('setup-worldname').value = r.identity.worldName || '';
      $('setup-password').placeholder = r.identity.passwordSet ? 'leave empty to keep the current password' : 'required';
    }

    // Restart notice (step 8) and the overall banner.
    const note = $('setup-restart-note');
    if (r.needsRestart) {
      note.innerHTML = '<strong>Restart needed.</strong> The server was started before the last change to <code>common.cfg</code> or the plugins folder. Press Stop on the Dashboard, wait until it shows <em>inactive</em>, then press Start here.';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
    const banner = $('setup-banner');
    if (stepsLeft === 0 && !r.needsRestart) {
      banner.innerHTML = `<div class="callout good sm" style="margin-top:12px"><strong>The server is up and modded.</strong> Players join at <code>${esc((lastInfo && lastInfo.connectHost ? `${lastInfo.connectHost}:${lastInfo.connectPort}` : `<your VPS public IP>:${(lastInfo && lastInfo.connectPort) || 2456}`))}</code>. Make sure UDP ${(r.identity && r.identity.port) || 2456}-${((r.identity && r.identity.port) || 2456) + 2} is open in your firewall. Next: set up Backups and the Updates check from their tabs, then add mods from the Mods tab.</div>`;
    } else if (r.serverState === 'active' && !r.portOpen && !(r.identity && r.identity.worldCreated)) {
      banner.innerHTML = '<div class="callout info sm" style="margin-top:12px">The server process is running and still starting up — the first start creates the world and can take a few minutes. This list refreshes by itself.</div>';
    } else {
      banner.innerHTML = '';
    }
    return r;
  } catch (e) {
    grid.innerHTML = `<div class="check-note">${emptyState({ title: 'Could not check setup status', text: esc(e.message), error: true, small: true, action: '<button class="btn btn-secondary btn-sm" onclick="loadSetupStatus()">Try again</button>' })}</div>`;
    $('setup-progress-text').textContent = '—';
  }
}

async function runSetupStep(btnSelector, url, out, label) {
  const btn = qs(btnSelector);
  setBtnLoading(btn, true);
  const code = await streamToConsole(url, out, loadSetupStatus);
  setBtnLoading(btn, false);
  code === '0' ? toast('success', `${label} finished`) : toast('error', `${label} failed`, code ? `Exit code ${code}` : 'Stream closed early');
  recordEvent(code === '0' ? 'good' : 'bad', `Setup: ${label}`, code === '0' ? 'completed' : `exit ${code}`, 'wrench');
  return code;
}

function runSetupPrepare() {
  runSetupStep('#step-1 .step-head .btn', '/api/setup/prepare', $('setup-prepare-output'), 'LinuxGSM install');
}

function runSetupInstallServer() {
  runSetupStep('#step-2 .step-head .btn', '/api/setup/install-server', $('setup-server-output'), 'Valheim server install');
}

// Step 3 — writes servername / worldname / serverpassword through the same endpoint the Settings page uses.
async function runSetupIdentity() {
  const msg = $('setup-identity-msg');
  const btn = $('setup-identity-btn');
  const values = {};
  const name = $('setup-servername').value.trim();
  const world = $('setup-worldname').value.trim();
  const pw = $('setup-password').value;
  if (name) values.servername = name;
  if (world) values.worldname = world;
  if (pw) values.serverpassword = pw;
  const portVal = $('setup-port').value.trim();
  if (portVal) {
    const isMain = !lastSetupStatus || !lastSetupStatus.instance || lastSetupStatus.instance.main;
    // The main world already runs on LinuxGSM's default port; only write it when it changes. An extra world always saves its own.
    if (!isMain || (lastSetupStatus && lastSetupStatus.identity && portVal !== String(lastSetupStatus.identity.port))) values.port = portVal;
  } else if (lastSetupStatus && lastSetupStatus.instance && !lastSetupStatus.instance.main && !(lastSetupStatus.identity && lastSetupStatus.identity.portSet)) {
    msg.innerHTML = '<div class="callout bad sm" style="margin-top:10px">Enter a game port for this world (each world needs its own).</div>';
    return;
  }
  if (!Object.keys(values).length) {
    msg.innerHTML = '<div class="callout bad sm" style="margin-top:10px">Fill in at least one field.</div>';
    return;
  }
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    if (r.error) throw new Error(r.error);
    msg.innerHTML = `<div class="callout good sm" style="margin-top:10px">${esc(r.applied ? 'Saved.' : r.note || 'No changes.')} They take effect on the next start.</div>`;
    $('setup-password').value = '';
    setupIdentityLoaded = false;
    toast('success', 'Server settings saved');
    recordEvent('good', 'Setup: server name / world / password saved', '', 'wrench');
  } catch (e) {
    msg.innerHTML = `<div class="callout bad sm" style="margin-top:10px">${esc(e.message)}</div>`;
    toast('error', 'Could not save', e.message);
  } finally {
    setBtnLoading(btn, false);
    loadSetupStatus();
  }
}

function runSetupInstallBepinex() {
  runSetupStep('#step-4 .step-head .btn', '/api/setup/install-bepinex', $('setup-bepinex-output'), 'BepInEx install');
}

function runSetupInstallHelpers() {
  runSetupStep('#step-7 .step-head .btn', '/api/setup/install-helpers', $('setup-helpers-output'), 'Helper scripts install');
}

// Step 8 — starts the server (same call as the Dashboard's Start) and then re-reads the checklist
// at intervals, since the first start takes minutes (world generation) and the log fills in as it goes.
async function runSetupStart() {
  const out = $('setup-start-output');
  const btn = $('setup-start-btn');
  setupPollTimers.forEach(clearTimeout);
  setupPollTimers = [];
  out.textContent = 'Starting the server…\n';
  setConsoleState(out, 'running');
  setBtnLoading(btn, true);
  try {
    const r = await api('/api/server/start', { method: 'POST' });
    out.textContent += (r.stdout || '') + (r.stderr || '');
    const failed = r.code && r.code !== 0;
    setConsoleState(out, failed ? 'error' : 'success');
    if (failed) toast('error', 'Server start failed', (r.stderr || r.stdout || '').trim().slice(0, 200));
    else {
      out.textContent += '\nStart command sent. The checklist above refreshes by itself for the next few minutes.\n';
      toast('success', 'Server start sent', 'The first start can take a few minutes.');
      [5, 20, 45, 90, 150, 240].forEach((s) => setupPollTimers.push(setTimeout(loadSetupStatus, s * 1000)));
    }
    recordEvent(failed ? 'bad' : 'accent', `Setup: server start ${failed ? 'failed' : 'requested'}`, '', 'play');
  } catch (e) {
    out.textContent += `\n[error] ${e.message}\n`;
    setConsoleState(out, 'error');
    toast('error', 'Server start failed', e.message);
  } finally {
    setBtnLoading(btn, false);
    loadSetupStatus();
  }
}

let setupSystemdPreviewResult = null;

// Note: still named "Systemd" (functions, element ids, API paths) purely to
// keep the diff against the pre-rebuild version small — there's no systemd
// involved anymore. What this now previews/applies is the BepInEx doorstop
// block in LGSM's common.cfg (server.js's computeDoorstopChange).
async function runSetupSystemdPreview() {
  const diffEl = $('setup-systemd-diff');
  const applyBtn = $('setup-systemd-apply-btn');
  const previewBtn = qs('#step-5 [onclick="runSetupSystemdPreview()"]');
  diffEl.innerHTML = '<div class="setup-diff"><span class="skeleton w-80"></span><br><span class="skeleton w-60"></span></div>';
  applyBtn.disabled = true;
  setBtnLoading(previewBtn, true);
  try {
    const r = await api('/api/setup/systemd-preview');
    if (r.error) throw new Error(r.error);
    setupSystemdPreviewResult = r;
    if (r.alreadyWired) {
      diffEl.innerHTML = `<div class="callout good sm">Already wired to BepInEx in common.cfg — nothing to apply.</div>`;
      applyBtn.disabled = true;
    } else {
      diffEl.innerHTML = `<div class="setup-diff"><span class="diff-new">+ ${escapeHtml(r.proposedBlock).replace(/\n/g, '<br>+ ')}</span></div><div class="callout info sm" style="margin-top:10px">These lines will be appended to the end of common.cfg — nothing existing is changed.</div>`;
      applyBtn.disabled = false;
      applyBtn.removeAttribute('data-tip');
    }
  } catch (e) {
    diffEl.innerHTML = `<div class="callout bad sm" style="margin-top:12px">Error: ${esc(e.message)}</div>`;
  } finally {
    setBtnLoading(previewBtn, false);
  }
}

async function runSetupSystemdApply() {
  if (!setupSystemdPreviewResult || setupSystemdPreviewResult.alreadyWired) return;
  const ok = await confirmDialog({
    title: 'Append this block to common.cfg?',
    tone: 'warn',
    html: `<div class="setup-diff"><span class="diff-new">+ ${escapeHtml(setupSystemdPreviewResult.proposedBlock).replace(/\n/g, '<br>+ ')}</span></div>
      <p style="margin-top:12px">common.cfg is backed up first. The service is <strong>not</strong> restarted — use Stop, then Start on the Dashboard afterward, since the new env vars only take effect on the next start.</p>`,
    confirmLabel: 'Apply change',
  });
  if (!ok) return;
  const applyBtn = $('setup-systemd-apply-btn');
  const diffEl = $('setup-systemd-diff');
  setBtnLoading(applyBtn, true);
  try {
    const r = await api('/api/setup/systemd-apply', { method: 'POST' });
    if (r.error) {
      diffEl.insertAdjacentHTML('beforeend', `<div class="callout bad sm">Error: ${esc(r.error)}</div>`);
      toast('error', 'common.cfg change failed', r.error);
    } else if (r.applied) {
      diffEl.insertAdjacentHTML(
        'beforeend',
        `<div class="callout good sm">Applied. Backup saved to <code>${escapeHtml(r.backupPath)}</code>. Use Stop, then Start on the Dashboard to pick it up.</div>`
      );
      toast('success', 'common.cfg updated', 'Use Stop, then Start on the Dashboard.');
      recordEvent('good', 'common.cfg pointed at BepInEx', r.backupPath ? `backup: ${r.backupPath}` : '', 'wrench');
    } else {
      diffEl.insertAdjacentHTML('beforeend', `<div class="callout info sm">${escapeHtml(r.note || 'No change needed.')}</div>`);
    }
  } catch (e) {
    diffEl.insertAdjacentHTML('beforeend', `<div class="callout bad sm">Error: ${esc(e.message)}</div>`);
    toast('error', 'common.cfg change failed', e.message);
  } finally {
    setBtnLoading(applyBtn, false);
    applyBtn.disabled = true;
    loadSetupStatus();
  }
}

async function runSetupInstallEnforcer() {
  const out = $('setup-enforcer-output');
  const btn = qs('#step-6 .step-head .btn');
  setBtnLoading(btn, true);
  try {
    const st = await api('/api/setup/status');
    out.textContent = 'Looking up the current ValheimEnforcer version and what it depends on…\n';
    setConsoleState(out, 'running');
    let pkg;
    try {
      pkg = await api('/api/setup/enforcer-version');
      if (pkg.error) throw new Error(pkg.error);
    } catch (e) {
      out.textContent += `[error] ${e.message}\n`;
      setConsoleState(out, 'error');
      toast('error', 'Could not look up ValheimEnforcer', e.message);
      return;
    }
    // Enforcer will not load without its dependencies (Jotunn), so install any that are missing first.
    const deps = (pkg.dependencies || []).filter((d) => !d.installed);
    const unresolved = deps.filter((d) => d.missing);
    if (unresolved.length) {
      out.textContent += `[error] could not find ${unresolved.map((d) => `${d.owner}-${d.name}`).join(', ')} on Thunderstore or Hexium right now — Enforcer needs it, so nothing was installed.\n`;
      setConsoleState(out, 'error');
      toast('error', 'A ValheimEnforcer dependency could not be found');
      return;
    }
    for (const d of deps) {
      const depFolder = `${d.owner}-${d.name}-${d.version}`;
      out.textContent += `Installing dependency ${d.owner}-${d.name} v${d.version} from ${sourceLabel(d.source)}...\n`;
      const r = await streamPost('/api/mods/install', { namespace: d.owner, name: depFolder, packageName: d.name, version: d.version, source: d.source }, out);
      if (r.includes(`INSTALLED ${depFolder} ${d.version}`)) {
        logChange('install', depFolder, { version: d.version, source: d.source });
      } else {
        out.textContent += `\n[error] dependency ${d.name} did not install — stopping so Enforcer is not left half-set-up.\n`;
        setConsoleState(out, 'error');
        toast('error', `Could not install ${d.name}`);
        return;
      }
    }
    // Two copies of the plugin would both load and fight each other, so never install over an existing one.
    if (st.enforcerPlugin) {
      out.textContent += deps.length
        ? '\nValheimEnforcer was already installed; its missing dependencies are in place now. Restart the server to load it.\n'
        : 'ValheimEnforcer and its dependencies are already installed — nothing to do. Update them from the Mods tab.\n';
      setConsoleState(out, 'success');
      toast(deps.length ? 'success' : 'info', deps.length ? 'Dependencies installed — restart the server' : 'ValheimEnforcer is already installed');
      return;
    }
    // Same "Owner-PackageName-Version" folder name the Mods tab gives every fresh install.
    const folderName = `${pkg.owner}-${pkg.name}-${pkg.version}`;
    out.textContent += `Installing ${pkg.owner}-${pkg.name} v${pkg.version} from ${sourceLabel(pkg.source)} into ${folderName}...\n`;
    const result = await streamPost('/api/mods/install', { namespace: pkg.owner, name: folderName, packageName: pkg.name, version: pkg.version, source: pkg.source }, out);
    if (result.includes(`INSTALLED ${folderName} ${pkg.version}`)) {
      logChange('install', folderName, { version: pkg.version, source: pkg.source });
      out.textContent += '\nInstalled. Mods.yaml appears on the first start (step 8).\n';
    } else if (!result.includes('[error]')) {
      out.textContent += '\n[finished — no success marker seen; check the output above for what happened]\n';
    } else toast('error', 'ValheimEnforcer install failed');
  } catch (e) {
    out.textContent += `[error] ${e.message}\n`;
    setConsoleState(out, 'error');
    toast('error', 'ValheimEnforcer install failed', e.message);
  } finally {
    setBtnLoading(btn, false);
    loadSetupStatus();
  }
}

/* ==========================================================================
   11b. Project Zomboid — a second game, same GUI shell (API: /api/pz/*)
   No Mods or Setup tab here on purpose (see the game switch). Every function
   below mirrors its Valheim counterpart one-for-one, just against pz- ids
   and endpoints, so the two stay easy to compare.
   ========================================================================== */

let pzPollTimer = null;
let pzPlayersTimer = null;

function startPzPolling() {
  if (pzPollTimer) return;
  pzRefreshAll();
  pzPollTimer = setInterval(pzPollStats, 10000);
  pzPlayersTimer = setInterval(pzLoadPlayers, 10000);
}

function stopPzPolling() {
  if (pzPollTimer) {
    clearInterval(pzPollTimer);
    pzPollTimer = null;
  }
  if (pzPlayersTimer) {
    clearInterval(pzPlayersTimer);
    pzPlayersTimer = null;
  }
}

/* ---- Status / info / server actions ---- */
let pzLastStatus = null;
let pzStatusSinceTs = null;

async function pzRefreshStatus() {
  try {
    const r = await api('/api/pz/status');
    pzLastStatus = r;
    const healthy = r.state === 'active' && r.portOpen;
    $('pz-kpi-health').innerHTML = healthy
      ? `<span class="kpi-health good"><span class="kpi-health-dot"></span><span>Healthy</span></span>`
      : r.state === 'active'
        ? `<span class="kpi-health warn"><span class="kpi-health-dot"></span><span>Starting…</span></span>`
        : `<span class="kpi-health bad"><span class="kpi-health-dot"></span><span>Stopped</span></span>`;
    $('pz-status-text').textContent = r.state === 'active' ? (r.portOpen ? 'Online' : 'Starting up') : 'Offline';
    pzStatusSinceTs = r.since ? new Date(r.since).getTime() : null;
    $('pz-status-since').textContent = '';
    pzUpdateUptime();
  } catch (e) {
    $('pz-kpi-health').innerHTML = `<span class="kpi-health bad"><span class="kpi-health-dot"></span><span>Unknown</span></span>`;
    $('pz-status-text').textContent = 'Could not reach the server';
  }
}

function pzUpdateUptime() {
  const up = pzStatusSinceTs ? Date.now() - pzStatusSinceTs : -1;
  const el = $('pz-info-uptime');
  if (el) el.textContent = up >= 0 ? fmtDuration(up) : '—';
  // Always resolve the KPI foot text once a status has come back — it used
  // to only get set when uptime was known, which left the skeleton in place
  // forever whenever systemd didn't report ActiveEnterTimestamp (a stopped
  // service, or right after a restart).
  if (!pzLastStatus) return;
  if (pzLastStatus.portOpen) {
    $('pz-kpi-health-foot').textContent = up >= 0 ? `Up ${fmtDuration(up)} · port ${pzLastStatus.port} open` : `Port ${pzLastStatus.port} open`;
  } else {
    $('pz-kpi-health-foot').textContent = pzLastStatus.state === 'active' ? 'Waiting for port to open…' : 'Server is not running';
  }
}

async function pzLoadInfo() {
  try {
    const r = await api('/api/pz/status');
    $('pz-info-connect').textContent = `${r.connectHost || '—'}:${r.port}`;
    $('pz-info-state').textContent = r.state || '—';
    $('pz-info-port').textContent = r.port;
  } catch (e) {
    // non-fatal — status polling already surfaces the failure
  }
}

function pzCopyConnect() {
  const text = $('pz-info-connect').textContent;
  navigator.clipboard?.writeText(text).then(
    () => toast('success', 'Copied', text),
    () => toast('error', 'Could not copy')
  );
}

async function pzServerAction(action) {
  if (action !== 'start') {
    const ok = await confirmDialog({
      title: `${action === 'stop' ? 'Stop' : 'Restart'} the Zomboid server?`,
      html:
        action === 'stop'
          ? '<p>Players online will be disconnected. SIGINT gives it a chance to save first.</p>'
          : '<p>Players online will be disconnected while the server restarts.</p>',
      confirmLabel: action === 'stop' ? 'Stop server' : 'Restart server',
      tone: action === 'stop' ? 'danger' : 'warn',
    });
    if (!ok) return;
  }
  if (currentPage !== 'pz-dashboard') navigate('pz-dashboard');
  try {
    const r = await api(`/api/pz/server/${action}`, { method: 'POST' });
    const failed = r.code && r.code !== 0;
    if (failed) toast('error', `Server ${action} failed`, (r.stderr || '').trim().slice(0, 200));
    else toast('success', `Server ${action} sent`, 'Status will refresh in a moment.');
  } catch (e) {
    toast('error', `Server ${action} failed`, e.message);
  }
  setTimeout(pzRefreshStatus, 1500);
  setTimeout(pzRefreshStatus, 6000);
}

function pzRefreshAll() {
  pzRefreshStatus();
  pzLoadInfo();
  pzPollStats();
  pzLoadPlayers();
}

/* ---- Resource usage (API: GET /api/pz/system/stats) ---- */
const pzStatHistory = store.get('vg.pzStats', []).filter((p) => Date.now() - p.t < 15 * 60 * 1000);

async function pzPollStats() {
  try {
    const r = await api('/api/pz/system/stats');
    $('pz-stat-cpu').innerHTML = `${r.cpuPercent}<span class="unit">%</span>`;
    $('pz-stat-cpu-sub').textContent = `${r.cores} cores · load ${(r.loadAvg || []).map((n) => n.toFixed(2)).join(' / ')}`;
    if (!r.pzRunning) {
      $('pz-stat-proc-cpu').textContent = '—';
      $('pz-stat-proc-cpu-sub').textContent = 'Not running';
    } else if (r.pzCpuPercent == null) {
      $('pz-stat-proc-cpu').textContent = '…';
      $('pz-stat-proc-cpu-sub').textContent = 'Warming up (needs a second poll)';
    } else {
      $('pz-stat-proc-cpu').innerHTML = `${r.pzCpuPercent}<span class="unit">%</span>`;
      $('pz-stat-proc-cpu-sub').textContent = `PID ${r.pzPid} · % of one core`;
    }
    $('pz-stat-mem').innerHTML = `${r.memPercent ?? '—'}<span class="unit">%</span>`;
    $('pz-stat-mem-sub').textContent = `${(r.memUsedMB / 1024).toFixed(1)} / ${(r.memTotalMB / 1024).toFixed(1)} GB`;
    $('pz-stat-disk').innerHTML = `${r.diskPercent ?? '—'}<span class="unit">%</span>`;
    $('pz-stat-disk-sub').textContent = `${r.diskUsed} of ${r.diskTotal} used`;
    const bar = $('pz-stat-disk-bar');
    bar.style.width = (r.diskPercent || 0) + '%';
    bar.className = 'meter-fill ' + toneFor(r.diskPercent || 0);

    pzStatHistory.push({ t: Date.now(), cpu: r.cpuPercent, mem: r.memPercent, valheimCpu: r.pzCpuPercent });
    while (pzStatHistory.length && Date.now() - pzStatHistory[0].t > CHART_WINDOW) pzStatHistory.shift();
    store.set('vg.pzStats', pzStatHistory);
    pzDrawSparklines();
    pzRenderUsageChart();
  } catch (e) {
    if (!pzStatHistory.length) {
      ['pz-stat-cpu', 'pz-stat-proc-cpu', 'pz-stat-mem', 'pz-stat-disk'].forEach((id) => ($(id).textContent = '—'));
      $('pz-stat-cpu-sub').textContent = 'Stats unavailable';
    }
  }
}

function pzDrawSparklines() {
  const last = pzStatHistory.slice(-40);
  drawSparkline($('pz-chart-cpu'), last.map((p) => p.cpu), cssVar('--series-cpu'));
  drawSparkline($('pz-chart-proc-cpu'), last.map((p) => p.valheimCpu), cssVar('--series-valheim'));
  drawSparkline($('pz-chart-mem'), last.map((p) => p.mem), cssVar('--series-mem'));
}

let pzChartHoverIndex = null;
function pzRenderUsageChart() {
  const svg = $('pz-usage-chart');
  const wrap = $('pz-usage-chart-wrap');
  if (!svg || !wrap || !wrap.offsetWidth) return;
  const pts = pzStatHistory.filter((p) => p.cpu != null);
  $('pz-usage-chart-empty').classList.toggle('hidden', pts.length >= 2);
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const m = { l: 34, r: 8, t: 8, b: 22 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const now = pts.length ? pts[pts.length - 1].t : Date.now();
  const t0 = Math.min(now - 60 * 1000, pts.length ? Math.max(pts[0].t, now - CHART_WINDOW) : now - CHART_WINDOW);
  const x = (t) => m.l + ((t - t0) / Math.max(1, now - t0)) * iw;
  const y = (v) => m.t + ih - (Math.min(100, Math.max(0, v)) / 100) * ih;

  let g = `<defs><linearGradient id="pz-grad-cpu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${cssVar('--series-cpu')}" stop-opacity=".22"/><stop offset="1" stop-color="${cssVar('--series-cpu')}" stop-opacity="0"/></linearGradient></defs>`;
  g += '<g class="grid">';
  [0, 25, 50, 75, 100].forEach((v) => {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 3.5}" text-anchor="end">${v}%</text>`;
  });
  g += '</g><g class="xaxis">';
  if (pts.length >= 2) {
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((now - t0) * i) / ticks;
      const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
      const label = now - t0 < 10 * 60 * 1000 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : fmtClock(t);
      g += `<text x="${x(t)}" y="${H - 5}" text-anchor="${anchor}">${i === ticks ? 'now' : label}</text>`;
    }
  }
  g += '</g>';

  if (pts.length >= 2) {
    const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const cpuD = line('cpu');
    g += `<path class="area cpu" d="${cpuD}L${x(pts[pts.length - 1].t)},${y(0)}L${x(pts[0].t)},${y(0)}Z" fill="url(#pz-grad-cpu)"/>`;
    g += `<path class="line cpu" d="${cpuD}"/>`;
    const procPts = pts.filter((p) => p.valheimCpu != null);
    if (procPts.length >= 2) {
      const procD = procPts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.valheimCpu).toFixed(1)}`).join('');
      g += `<path class="line valheim" d="${procD}"/>`;
    }
    g += `<path class="line mem" d="${line('mem')}"/>`;
    if (pzChartHoverIndex != null && pts[pzChartHoverIndex]) {
      const p = pts[pzChartHoverIndex];
      g += `<line class="crosshair" x1="${x(p.t)}" x2="${x(p.t)}" y1="${m.t}" y2="${m.t + ih}"/>`;
      g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.cpu)}" r="4.5" fill="${cssVar('--series-cpu')}"/>`;
      if (p.valheimCpu != null) g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.valheimCpu)}" r="4.5" fill="${cssVar('--series-valheim')}"/>`;
      g += `<circle class="hover-dot" cx="${x(p.t)}" cy="${y(p.mem)}" r="4.5" fill="${cssVar('--series-mem')}"/>`;
    }
    g += `<rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" id="pz-usage-chart-hit"/>`;
  }
  svg.innerHTML = g;

  const hit = $('pz-usage-chart-hit');
  const tip = $('pz-usage-chart-tip');
  if (!hit) return;
  hit.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(x(p.t) - mx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== pzChartHoverIndex) {
      pzChartHoverIndex = best;
      pzRenderUsageChart();
    }
    const p = pts[best];
    tip.innerHTML = `<div class="tip-time">${new Date(p.t).toLocaleTimeString()}</div>
      <div class="tip-row"><span class="swatch s-cpu"></span>CPU (VPS)<b>${p.cpu}%</b></div>
      ${p.valheimCpu != null ? `<div class="tip-row"><span class="swatch s-valheim"></span>CPU (Zomboid)<b>${p.valheimCpu}%</b></div>` : ''}
      <div class="tip-row"><span class="swatch s-mem"></span>Memory<b>${p.mem}%</b></div>`;
    tip.classList.remove('hidden');
    const px = x(p.t);
    const tw = tip.offsetWidth;
    tip.style.left = (px + 14 + tw > W ? px - tw - 14 : px + 14) + 'px';
  };
  hit.onmouseleave = () => {
    pzChartHoverIndex = null;
    tip.classList.add('hidden');
    pzRenderUsageChart();
  };
}
if (window.ResizeObserver && $('pz-usage-chart-wrap')) new ResizeObserver(() => pzRenderUsageChart()).observe($('pz-usage-chart-wrap'));

/* ---- Players (API: GET /api/pz/players, via RCON) ---- */
async function pzLoadPlayers() {
  const list = $('pz-players-list');
  try {
    const r = await api('/api/pz/players');
    const players = r.players || [];
    $('pz-players-count').textContent = players.length;
    // Also resolves the Dashboard KPI tile — nothing else in the app was
    // writing to pz-kpi-players/-foot, so it sat on its skeleton forever.
    $('pz-kpi-players').textContent = players.length;
    $('pz-kpi-players-foot').textContent = players.length
      ? players.slice(0, 3).join(', ') + (players.length > 3 ? ` +${players.length - 3}` : '')
      : r.error
        ? 'RCON unreachable'
        : 'Nobody online';
    if (!players.length) {
      list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'users', title: r.error ? 'Could not reach RCON' : 'No players online', text: r.error ? esc(r.error) : '', small: true })}</li>`;
      return;
    }
    list.innerHTML = players
      .map(
        (name) =>
          `<li><span class="player-avatar" style="background:${avatarColor(name)}">${esc(name.slice(0, 1).toUpperCase())}</span><div class="row-main"><div class="row-title">${esc(name)}</div></div></li>`
      )
      .join('');
  } catch (e) {
    $('pz-kpi-players').textContent = '—';
    $('pz-kpi-players-foot').textContent = 'Could not load';
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Could not load players', text: esc(e.message), error: true })}</li>`;
  }
}

/* ---- RCON ---- */
async function pzRunRcon(command) {
  const out = $('pz-rcon-output');
  out.textContent += (out.textContent ? '\n' : '') + `> ${command}\n`;
  setConsoleState(out, 'running');
  try {
    const r = await api('/api/pz/rcon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    out.textContent += (r.output || '(no output)') + '\n';
    setConsoleState(out, r.ok ? 'success' : 'error');
    out.scrollTop = out.scrollHeight;
    if (command === 'players') pzLoadPlayers();
  } catch (e) {
    out.textContent += `[error] ${e.message}\n`;
    setConsoleState(out, 'error');
  }
}

function pzRunRconInput() {
  const input = $('pz-rcon-input');
  const command = input.value.trim();
  if (!command) return;
  input.value = '';
  pzRunRcon(command);
}

async function pzBroadcast() {
  const res = await dialog({
    title: 'Broadcast a message',
    html: '<p>Sent to every connected player via RCON <code>servermsg</code>.</p>',
    input: { label: 'Message', placeholder: 'Server restarting in 5 minutes' },
    actions: [{ key: 'send', label: 'Send', variant: 'btn-primary' }],
  });
  if (!res || res.key !== 'send' || !res.value) return;
  pzRunRcon(`servermsg "${res.value.replace(/"/g, "'")}"`);
}

async function pzQuit() {
  const ok = await confirmDialog({
    title: 'Gracefully quit the server?',
    tone: 'warn',
    html: '<p>Sends RCON <code>quit</code> — the server saves and shuts down cleanly. Prefer this (or the Stop button, which uses the same SIGINT path) over killing the process.</p>',
    confirmLabel: 'Send quit',
  });
  if (!ok) return;
  pzRunRcon('quit');
}

/* ---- Backups (API: GET /api/pz/backup/run|list, POST /api/pz/backup/restore) ---- */
let pzLastBackups = null;
let pzBackupSortDesc = true;

async function pzRunBackup() {
  const out = $('pz-backup-output');
  const btn = $('pz-run-backup-btn');
  setBtnLoading(btn, true);
  const code = await streamToConsole('/api/pz/backup/run', out, pzListBackups);
  setBtnLoading(btn, false);
  if (code === '0') toast('success', 'Backup complete');
  else toast('error', 'Backup failed', code ? `Exit code ${code}` : 'Stream closed early');
}

async function pzListBackups() {
  const list = $('pz-backup-files-list');
  if (!pzLastBackups) list.innerHTML = skeletonLis(5);
  try {
    const r = await api('/api/pz/backup/list');
    pzLastBackups = r.files || [];
    pzRenderBackups();
  } catch (e) {
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Could not list backups', text: esc(e.message), error: true, action: '<button class="btn btn-secondary btn-sm" onclick="pzListBackups()">Try again</button>' })}</li>`;
  }
}

function pzToggleBackupSort() {
  pzBackupSortDesc = !pzBackupSortDesc;
  $('pz-backup-sort-btn').innerHTML = `${icon(pzBackupSortDesc ? 'arrow-down' : 'arrow-up')}${pzBackupSortDesc ? 'Newest first' : 'Oldest first'}`;
  pzRenderBackups();
}

function pzRenderBackups() {
  const list = $('pz-backup-files-list');
  if (!pzLastBackups) return;
  const files = pzLastBackups.map((f) => ({ f, t: parseBackupDate(f) }));
  const dated = files.filter((x) => x.t).sort((a, b) => b.t - a.t);
  $('pz-bk-total').textContent = files.length;
  $('pz-bk-latest').textContent = dated.length ? `${timeAgo(dated[0].t)} · ${new Date(dated[0].t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : files.length ? '—' : 'None yet';

  if (!files.length) {
    list.innerHTML = `<li class="empty-li">${emptyState({
      iconName: 'archive',
      title: 'No backups found',
      text: 'Run your first backup, or check <code>zomboid.backupDir</code> in config.json.',
      action: `<button class="btn btn-primary btn-sm" onclick="pzRunBackup()">${icon('archive')}Run backup now</button>`,
    })}</li>`;
    return;
  }
  const q = ($('pz-backup-filter').value || '').toLowerCase();
  const shown = files
    .filter((x) => x.f.toLowerCase().includes(q))
    .sort((a, b) => ((a.t && b.t ? a.t - b.t : a.f.localeCompare(b.f)) * (pzBackupSortDesc ? -1 : 1)));
  if (!shown.length) {
    list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'filter', title: 'No backups match', small: true })}</li>`;
    return;
  }
  list.innerHTML = '';
  shown.forEach(({ f, t }, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="row-icon">${icon('archive')}</span>
      <div class="row-main"><div class="row-title"><span class="mod-name mono" style="font-size:12.5px">${esc(f)}</span>${i === 0 && pzBackupSortDesc && !q ? '<span class="badge good">Latest</span>' : ''}</div>
      <div class="row-desc bk-date">${t ? `${new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${timeAgo(t)}` : 'Date unknown'}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-warn btn-sm';
    btn.innerHTML = `${icon('rotate')}Restore`;
    btn.onclick = () => pzRestoreBackup(f);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function pzRestoreBackup(file) {
  const res = await dialog({
    title: 'Restore this backup?',
    tone: 'danger',
    html: `<p class="mono" style="color:var(--text);word-break:break-all">${esc(file)}</p>
      <p>This <strong>stops the server</strong>, overwrites the current Saves + Server config with this backup, then starts it back up.</p>`,
    input: { label: 'Type <code>RESTORE</code> to confirm', placeholder: 'RESTORE', match: 'RESTORE' },
    actions: [{ key: 'restore', label: 'Restore backup', variant: 'btn-danger', needsMatch: true }],
  });
  if (!res || res.key !== 'restore') return;
  const out = $('pz-backup-output');
  out.textContent = `Restoring ${file}...\n`;
  setConsoleState(out, 'running');
  let full = '';
  try {
    const r = await fetch('/api/pz/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      out.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    }
    const state = outcomeOf(full);
    setConsoleState(out, state);
    state === 'error' ? toast('error', 'Restore reported errors', 'Check the output.') : toast('success', 'Restore finished', file);
  } catch (e) {
    out.textContent += `\n[error] ${e.message}\n`;
    setConsoleState(out, 'error');
    toast('error', 'Restore failed', e.message);
  }
  setTimeout(pzRefreshStatus, 1500);
}

/* ---- Updates (API: SSE /api/pz/update/apply) ---- */
async function pzApplyUpdate() {
  const ok = await confirmDialog({
    title: 'Check & apply the Zomboid update now?',
    tone: 'warn',
    html: '<p>Stops the server, re-validates via SteamCMD, starts it back up. Check your Workshop mods\' pages after a major build update.</p>',
    confirmLabel: 'Check & apply',
  });
  if (!ok) return;
  const btn = qs('#tab-pz-updates .action-card .btn');
  setBtnLoading(btn, true);
  const code = await streamToConsole('/api/pz/update/apply', $('pz-update-output'));
  setBtnLoading(btn, false);
  if (code === '0') toast('success', 'Update applied');
  else toast('error', 'Update failed', code ? `Exit code ${code}` : 'Stream closed early');
}

/* ---- Mods (API: GET /api/pz/mods/list, POST /api/pz/mods/detect,
   POST /api/pz/mods/add, POST /api/pz/mods/remove, POST /api/pz/mods/reorder) ---- */

// Mirrors the server's own extraction so a bad paste is caught before the
// request even goes out. Accepts a bare numeric ID or a workshop page URL
// (sharedfiles or the older /workshop/ path both use ?id=).
function pzExtractWorkshopId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

let pzModsEntries = []; // last /api/pz/mods/list result — reused by reorder so it doesn't need a re-fetch just to know current order

function pzToggleManualMod() {
  const form = $('pz-mod-manual-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) $('pz-mod-manual-workshop').focus();
}

async function pzDetectMod() {
  const input = $('pz-mod-input').value.trim();
  const out = $('pz-mod-detect-result');
  const btn = $('pz-mod-detect-btn');
  if (!pzExtractWorkshopId(input)) {
    out.classList.remove('hidden');
    out.innerHTML = emptyState({ iconName: 'alert', title: "Couldn't find a Workshop ID", text: 'Paste the numeric ID, or the full workshop page URL.', error: true, small: true });
    return;
  }
  setBtnLoading(btn, true);
  out.classList.remove('hidden');
  out.innerHTML = `<div class="muted">Downloading via SteamCMD and checking mod.info — this can take a moment…</div>`;
  try {
    const r = await api('/api/pz/mods/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!r.mods || !r.mods.length) {
      out.innerHTML = emptyState({
        iconName: 'alert',
        title: 'No mod.info found',
        text: r.error || "That Workshop item downloaded but nothing under it looked like a Zomboid mod — double-check the ID, or add it manually below.",
        error: true,
        small: true,
      });
      return;
    }
    const defaultName = r.mods.map((m) => m.name).filter(Boolean).join(', ');
    out.innerHTML = `
      <div class="card-note" style="margin:0 0 8px;">Found ${pluralize(r.mods.length, 'mod')} in Workshop item ${esc(r.workshopId)} — uncheck any you don't want:</div>
      <ul class="row-list" id="pz-mod-detect-picks">
        ${r.mods
          .map(
            (m) => `<li>
              <input type="checkbox" checked data-mod-id="${esc(m.id)}" data-mod-name="${esc(m.name || '')}" aria-label="Include ${esc(m.name || m.id)}">
              <div class="row-main"><div class="row-title"><span class="mod-name">${esc(m.name || m.id)}</span><span class="badge mono">${esc(m.id)}</span></div></div>
            </li>`
          )
          .join('')}
      </ul>
      <form class="toolbar" style="padding:10px 0 0;border:0;" onsubmit="event.preventDefault(); pzConfirmAddMod('${esc(r.workshopId)}');">
        <input id="pz-mod-detect-name" type="text" class="grow" placeholder="Name (optional)" value="${esc(defaultName)}" aria-label="Mod name">
        <button class="btn btn-primary btn-sm" type="submit"><svg class="i"><use href="#i-plus"/></svg>Add to server</button>
      </form>`;
  } catch (e) {
    out.innerHTML = emptyState({ title: 'Detect failed', text: e.message, error: true, small: true });
  } finally {
    setBtnLoading(btn, false);
  }
}

async function pzConfirmAddMod(workshopId) {
  const picks = qsa('#pz-mod-detect-picks input[type="checkbox"]:checked').map((el) => ({ id: el.dataset.modId, name: el.dataset.modName }));
  if (!picks.length) return toast('info', 'Nothing selected', 'Check at least one mod to add it.');
  const name = ($('pz-mod-detect-name').value || '').trim();
  await pzSubmitAddMod(workshopId, picks, name);
}

async function pzAddModManual() {
  const workshopId = pzExtractWorkshopId($('pz-mod-manual-workshop').value);
  const modIds = ($('pz-mod-manual-modids').value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const name = ($('pz-mod-manual-name').value || '').trim();
  if (!workshopId) return toast('error', 'Missing Workshop ID', 'Paste the numeric ID or the workshop page URL.');
  if (!modIds.length) return toast('error', 'Missing Mod ID', "Paste the mod's internal Mod ID — from its Workshop page, or the PZ Mod ID Grabber tool.");
  const ok = await pzSubmitAddMod(workshopId, modIds.map((id) => ({ id, name: '' })), name);
  if (ok) {
    $('pz-mod-manual-workshop').value = '';
    $('pz-mod-manual-modids').value = '';
    $('pz-mod-manual-name').value = '';
    $('pz-mod-manual-form').classList.add('hidden');
  }
}

async function pzSubmitAddMod(workshopId, mods, name) {
  try {
    await api('/api/pz/mods/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workshopId, mods, name }),
    });
    toast('success', 'Mod added', 'Restart the server from the Dashboard to apply it.');
    $('pz-mod-input').value = '';
    $('pz-mod-detect-result').classList.add('hidden');
    $('pz-mod-detect-result').innerHTML = '';
    pzLoadMods();
    return true;
  } catch (e) {
    toast('error', 'Could not add mod', e.message);
    return false;
  }
}

function pzRenderModRow(entry, index, total) {
  const li = document.createElement('li');
  li.innerHTML = `
    <span class="row-icon">${icon('package')}</span>
    <div class="row-main">
      <div class="row-title">
        <span class="mod-name">${esc(entry.name)}</span>
        ${entry.unrecorded ? '<span class="badge warn" data-tip="In servertest.ini but not recorded here — added before this page existed, or by hand">Unrecorded</span>' : ''}
      </div>
      <div class="row-desc">Workshop <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${esc(entry.workshopId)}" target="_blank" rel="noopener">${esc(entry.workshopId)}</a> · Mod ID${entry.modIds.length === 1 ? '' : 's'}: ${entry.modIds.length ? entry.modIds.map((m) => `<code>${esc(m)}</code>`).join(', ') : '<span class="muted">none recorded</span>'}</div>
    </div>
    <div class="row-actions">
      <button class="icon-btn sm" data-tip="Move up" ${index === 0 ? 'disabled' : ''} onclick="pzMoveMod('${esc(entry.workshopId)}', -1)"><svg class="i"><use href="#i-arrow-up"/></svg></button>
      <button class="icon-btn sm" data-tip="Move down" ${index === total - 1 ? 'disabled' : ''} onclick="pzMoveMod('${esc(entry.workshopId)}', 1)"><svg class="i"><use href="#i-arrow-down"/></svg></button>
      <button class="btn btn-danger-soft btn-sm" onclick="pzRemoveMod('${esc(entry.workshopId)}', '${esc(entry.name).replace(/'/g, "\\'")}')"><svg class="i"><use href="#i-trash"/></svg>Remove</button>
    </div>`;
  return li;
}

async function pzLoadMods() {
  const list = $('pz-mods-list');
  const unmanagedEl = $('pz-mods-unmanaged');
  list.innerHTML = skeletonLis(3);
  unmanagedEl.classList.add('hidden');
  try {
    const r = await api('/api/pz/mods/list');
    pzModsEntries = r.entries || [];
    if (!pzModsEntries.length) {
      list.innerHTML = `<li class="empty-li">${emptyState({ iconName: 'package', title: 'No mods configured', text: 'Add one above — paste a Workshop URL or ID.' })}</li>`;
    } else {
      list.innerHTML = '';
      pzModsEntries.forEach((entry, i) => list.appendChild(pzRenderModRow(entry, i, pzModsEntries.length)));
    }
    if (r.unmanagedModIds && r.unmanagedModIds.length) {
      unmanagedEl.classList.remove('hidden');
      unmanagedEl.innerHTML = `<div class="card-note">Also in <code>Mods=</code> but not tied to a Workshop item above (added before this page existed, or by hand): ${r.unmanagedModIds.map((id) => `<code>${esc(id)}</code>`).join(', ')}</div>`;
    }
  } catch (e) {
    list.innerHTML = `<li class="empty-li">${emptyState({ title: 'Could not load mods', text: e.message, error: true, action: '<button class="btn btn-secondary btn-sm" onclick="pzLoadMods()">Try again</button>' })}</li>`;
  }
}

async function pzRemoveMod(workshopId, name) {
  const ok = await confirmDialog({
    title: `Remove ${name || 'this mod'}?`,
    html: '<p>Removed from WorkshopItems=/Mods= in servertest.ini. Takes effect on the next server restart.</p>',
    confirmLabel: 'Remove',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    await api('/api/pz/mods/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workshopId }),
    });
    toast('success', 'Mod removed', 'Restart the server from the Dashboard to apply it.');
    pzLoadMods();
  } catch (e) {
    toast('error', 'Could not remove mod', e.message);
  }
}

async function pzMoveMod(workshopId, dir) {
  const ids = pzModsEntries.map((e) => e.workshopId);
  const i = ids.indexOf(String(workshopId));
  const j = i + dir;
  if (i === -1 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api('/api/pz/mods/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids }),
    });
    pzLoadMods();
  } catch (e) {
    toast('error', 'Could not reorder mods', e.message);
  }
}

/* ---- Logs (API: GET /api/pz/logs/journal, GET /api/pz/logs/tail, SSE /api/pz/logs/live) ---- */
let pzLogLineCount = 0;
let pzLogFollow = true;
let pzLogLevel = 'all';

function pzSetLogStatus(state, text) {
  const dot = qs('#pz-log-status .log-status-dot');
  dot.className = 'log-status-dot' + (state ? ` ${state}` : '');
  $('pz-log-status-text').textContent = text;
}

function pzLineMatches(el) {
  const q = ($('pz-log-filter').value || '').toLowerCase();
  const lvl = el.dataset.level;
  const levelOk = pzLogLevel === 'all' || (pzLogLevel === 'error' ? lvl === 'error' : lvl === 'warn' || lvl === 'error');
  return levelOk && (!q || el.textContent.toLowerCase().includes(q));
}

function pzAppendLogLines(lines) {
  const view = $('pz-logs-output');
  const emptyEl = view.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();
  const frag = document.createDocumentFragment();
  lines.forEach((text) => {
    const span = document.createElement('span');
    const lvl = classifyLine(text);
    span.className = 'ln' + (lvl ? ' ' + lvl : '');
    span.dataset.level = lvl;
    span.textContent = text;
    if (!pzLineMatches(span)) span.classList.add('hide');
    frag.appendChild(span);
  });
  view.appendChild(frag);
  pzLogLineCount += lines.length;
  while (pzLogLineCount > LOG_MAX_LINES && view.firstChild) {
    view.firstChild.remove();
    pzLogLineCount--;
  }
  $('pz-log-line-count').textContent = `${pzLogLineCount.toLocaleString()} lines`;
  if (pzLogFollow) view.scrollTop = view.scrollHeight;
}

function pzApplyLogFilter() {
  qsa('#pz-logs-output .ln').forEach((el) => el.classList.toggle('hide', !pzLineMatches(el)));
}
qsa('#pz-log-level-chips .chip').forEach((c) => {
  c.onclick = () => {
    pzLogLevel = c.dataset.level;
    qsa('#pz-log-level-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
    pzApplyLogFilter();
  };
});
function pzToggleLogWrap() {
  const on = $('pz-logs-output').classList.toggle('wrap');
  $('pz-log-wrap-btn').setAttribute('aria-pressed', on);
}
function pzToggleLogFollow() {
  pzLogFollow = !pzLogFollow;
  $('pz-log-follow-btn').setAttribute('aria-pressed', pzLogFollow);
  $('pz-log-follow-btn').classList.toggle('active', pzLogFollow);
  if (pzLogFollow) $('pz-logs-output').scrollTop = $('pz-logs-output').scrollHeight;
}
function pzVisibleLogText() {
  return qsa('#pz-logs-output .ln:not(.hide)').map((el) => el.textContent).join('\n');
}
function pzDownloadLogs() {
  const t = pzVisibleLogText();
  if (!t) return toast('info', 'Nothing to download');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }));
  a.download = `${$('pz-log-source').value === 'journal' ? 'journal' : 'server-console'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function pzLoadLogs() {
  const source = $('pz-log-source').value;
  const lines = $('pz-log-lines').value;
  const out = $('pz-logs-output');
  const btn = qs('#tab-pz-logs [onclick="pzLoadLogs()"]');
  const endpoint = source === 'journal' ? '/api/pz/logs/journal' : '/api/pz/logs/tail';
  setBtnLoading(btn, true);
  pzSetLogStatus('', 'Loading snapshot…');
  try {
    const r = await fetch(`${endpoint}?lines=${lines}`).then((r) => r.json());
    const text = r.text || r.error || '(empty)';
    if (pzLiveSource) pzToggleLive();
    out.innerHTML = '';
    pzLogLineCount = 0;
    pzAppendLogLines(text.replace(/\n$/, '').split('\n'));
    pzSetLogStatus(r.error ? 'error' : '', `${r.error ? 'Error' : 'Snapshot'} · ${source === 'journal' ? 'systemd journal' : 'server-console.txt'} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    pzSetLogStatus('error', 'Failed: ' + e.message);
    toast('error', 'Could not load logs', e.message);
  } finally {
    setBtnLoading(btn, false);
  }
}

function pzSetLiveButton(live) {
  const btn = $('pz-live-toggle');
  btn.innerHTML = live ? `${icon('stop')}Stop live` : `${icon('play')}Go live`;
  btn.className = live ? 'btn btn-danger-soft' : 'btn btn-primary';
  $('pz-sb-live-dot').classList.toggle('hidden', !live);
}

let pzLiveSource = null;

function stopPzLogsLive() {
  if (pzLiveSource) {
    pzLiveSource.close();
    pzLiveSource = null;
    pzSetLiveButton(false);
  }
}

function pzToggleLive() {
  if (pzLiveSource) {
    stopPzLogsLive();
    pzAppendLogLines(['[live stream stopped]']);
    pzSetLogStatus('', 'Stopped');
    return;
  }
  const source = $('pz-log-source').value;
  $('pz-logs-output').innerHTML = '';
  pzLogLineCount = 0;
  pzAppendLogLines([]);
  pzLiveSource = new EventSource(`/api/pz/logs/live?source=${source}`);
  pzSetLogStatus('live', `Live · ${source === 'journal' ? 'systemd journal' : 'server-console.txt'}`);
  pzLiveSource.onmessage = (e) => pzAppendLogLines([e.data]);
  pzLiveSource.onerror = () => {
    pzAppendLogLines(['[stream closed]']);
    if (pzLiveSource) pzLiveSource.close();
    pzLiveSource = null;
    pzSetLiveButton(false);
    pzSetLogStatus('error', 'Stream closed');
  };
  pzSetLiveButton(true);
}

function pzCopyLogs() {
  const text = qsa('#pz-logs-output .ln:not(.hide)').map((el) => el.textContent).join('\n');
  navigator.clipboard?.writeText(text).then(() => toast('success', 'Copied', `${text.split('\n').length} lines`), () => toast('error', 'Could not copy'));
}

function pzClearLogs() {
  $('pz-logs-output').innerHTML = '';
  pzLogLineCount = 0;
  $('pz-log-line-count').textContent = '0 lines';
}
// Pause auto-follow when the user scrolls up; resume at the bottom. Same
// behavior as the Valheim log view's listener.
$('pz-logs-output').addEventListener('scroll', (e) => {
  const v = e.target;
  const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 24;
  if (pzLogFollow !== atBottom && (pzLiveSource || !atBottom)) {
    pzLogFollow = atBottom;
    $('pz-log-follow-btn').setAttribute('aria-pressed', pzLogFollow);
    $('pz-log-follow-btn').classList.toggle('active', pzLogFollow);
  }
});

/* ==========================================================================
   12. Init
   ========================================================================== */

initConsoles();
renderTimeline();
renderPendingChanges();
renderLogEmpty();
drawSparklines();
// Restore last-used game's chrome (sidebar/brand/pollers) before the first
// showPage(), so a reload that lands on activeGame === 'zomboid' doesn't
// briefly show Valheim's sidebar or kick off Valheim's pollers.
applyGameChrome(activeGame);
loadWorldList();
showPage(location.hash.slice(1) || (activeGame === 'zomboid' ? 'pz-dashboard' : 'dashboard'));
if (document.documentElement.classList.contains('sb-collapsed')) $('sidebar-collapse').setAttribute('data-tip', 'Expand sidebar  [');

if (activeGame === 'zomboid') {
  // applyGameChrome() already called startPzPolling(), which does its own
  // initial pzRefreshAll() — nothing else to kick off here (PZ has no
  // mods/setup modules).
} else {
  refreshStatus();
  loadSaveHealth();
  loadInfo();
  pollStats();
  loadPlayers();
  startPlayersLive();
  loadSetupStatus();
  loadDisabledMods();
}
// Valheim's own pollers — guarded so they're inert while Project Zomboid is
// the active game (PZ has its own interval timers, started/stopped by
// applyGameChrome() via startPzPolling()/stopPzPolling()).
setInterval(() => { if (activeGame !== 'zomboid') refreshStatus(); }, 15000);
setInterval(() => { if (activeGame !== 'zomboid') loadInfo(); }, 20000);
setInterval(() => { if (activeGame !== 'zomboid') loadSaveHealth(); }, 30000);
setInterval(() => { if (activeGame !== 'zomboid') pollStats(); }, 10000);
setInterval(updateUptime, 1000 * 30);
setInterval(renderTimeline, 1000 * 30);
// Keep the "online for" durations ticking.
setInterval(() => {
  if (activeGame !== 'zomboid' && lastPlayerSet && lastPlayerSet.size) renderPlayers([...lastPlayerSet]);
}, 1000 * 30);
