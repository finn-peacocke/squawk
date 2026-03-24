// ── Constants ──────────────────────────────────────────────────────────────
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/calendar.events';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const STORAGE_KEY = 'squawk_config';

// ── State ──────────────────────────────────────────────────────────────────
let sources = [];
let addedIds = new Set();
let accessToken = null;
let sheetId = null;
let calYear, calMonth;
const now = new Date();
calYear = now.getFullYear();
calMonth = now.getMonth();

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const saved = loadConfig();
  if (saved.sheetUrl) document.getElementById('sheetUrlInput').value = saved.sheetUrl;
  if (saved.clientId) document.getElementById('clientIdInput').value = saved.clientId;
  renderCalendar();
});

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function saveConfig(clientId, sheetUrl) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ clientId, sheetUrl }));
}

// ── Auth ───────────────────────────────────────────────────────────────────
function startAuth() {
  const clientId = document.getElementById('clientIdInput').value.trim();
  const sheetUrl = document.getElementById('sheetUrlInput').value.trim();
  if (!clientId || !sheetUrl) { showToast('Please enter your Client ID and Sheet URL.'); return; }

  sheetId = extractSheetId(sheetUrl);
  if (!sheetId) { showToast('Could not parse Sheet ID from URL.'); return; }

  saveConfig(clientId, sheetUrl);

  const gsiScript = document.createElement('script');
  gsiScript.src = 'https://accounts.google.com/gsi/client';
  gsiScript.onload = () => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { showToast('Auth error: ' + resp.error); return; }
        accessToken = resp.access_token;
        onAuthenticated();
      }
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  };
  gsiScript.onerror = () => showToast('Failed to load Google auth library.');
  document.head.appendChild(gsiScript);
}

function onAuthenticated() {
  document.getElementById('connStatus').textContent = '✓ Google connected';
  document.getElementById('connStatus').className = 'conn-status connected';
  document.getElementById('authBtn').textContent = 'Reconnect';
  document.getElementById('syncBtn').disabled = false;
  document.getElementById('addAllBtn').disabled = false;
  showApp();
  loadSheet();
}

function showApp() {
  document.getElementById('setupPanel').classList.add('hidden');
  document.getElementById('appPanel').classList.remove('hidden');
}

function syncSheet() {
  if (sheetId && accessToken) loadSheet();
}

// ── Sheet ──────────────────────────────────────────────────────────────────
function extractSheetId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

async function loadSheet() {
  showToast('Loading sheet...');
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:Z500`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const data = await res.json();
    if (data.error) { showToast('Sheet error: ' + data.error.message); return; }
    parseSheetData(data.values || []);
    showToast(`Loaded ${sources.length} sources`);
    renderAll();
  } catch (e) {
    showToast('Failed to load sheet: ' + e.message);
  }
}

function parseSheetData(rows) {
  if (!rows.length) return;
  const headers = rows[0].map(h => (h || '').toLowerCase().trim());

  const col = (keywords) => headers.findIndex(h => keywords.some(k => h.includes(k)));
  const nameIdx    = col(['name', 'source', 'programme', 'program', 'organisation', 'organization']);
  const urlIdx     = col(['url', 'link', 'website', 'http']);
  const typeIdx    = col(['type', 'category']);
  const dateIdx    = col(['date', 'deadline', 'open', 'cohort', 'start', 'launch']);
  const notesIdx   = col(['note', 'description', 'detail', 'comment']);

  sources = rows.slice(1)
    .filter(r => r.some(c => c && c.trim()))
    .map((row, i) => {
      const name    = (nameIdx >= 0 ? row[nameIdx] : row[0]) || '';
      const url     = (urlIdx >= 0 ? row[urlIdx] : findUrl(row)) || '';
      const type    = typeIdx >= 0 ? normaliseType(row[typeIdx]) : guessType(name, url);
      const rawDate = (dateIdx >= 0 ? row[dateIdx] : '') || '';
      const notes   = (notesIdx >= 0 ? row[notesIdx] : '') || '';
      const parsedDate = parseDate(rawDate);
      const urgency = getUrgency(parsedDate);
      return { id: i, name: name.trim(), url: url.trim(), type, rawDate, parsedDate, notes: notes.trim(), urgency };
    })
    .filter(s => s.name);
}

function findUrl(row) {
  return row.find(c => c && (c.startsWith('http://') || c.startsWith('https://'))) || '';
}

function normaliseType(t) {
  if (!t) return 'other';
  t = t.toLowerCase();
  if (t.includes('accelerat')) return 'accelerator';
  if (t.includes('fellow')) return 'fellowship';
  if (t.includes('compet') || t.includes('award') || t.includes('prize') || t.includes('hack')) return 'competition';
  if (t.includes('grant') || t.includes('fund')) return 'grant';
  if (t.includes('event') || t.includes('summit') || t.includes('conf') || t.includes('demo day')) return 'event';
  if (t.includes('vc') || t.includes('venture') || t.includes('invest')) return 'vc';
  return 'other';
}

function guessType(name, url) {
  const txt = (name + url).toLowerCase();
  if (txt.includes('accelerat') || txt.includes('y combinator') || txt.includes('techstars') || txt.includes('bootcamp')) return 'accelerator';
  if (txt.includes('fellow')) return 'fellowship';
  if (txt.includes('compet') || txt.includes('award') || txt.includes('prize') || txt.includes('hackathon')) return 'competition';
  if (txt.includes('grant')) return 'grant';
  if (txt.includes('event') || txt.includes('summit') || txt.includes('conf') || txt.includes('demo day')) return 'event';
  if (txt.includes('vc') || txt.includes('venture') || txt.includes('fund')) return 'vc';
  return 'accelerator';
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function getUrgency(date) {
  if (!date) return 'unknown';
  const diff = Math.ceil((date - now) / 86400000);
  if (diff < 0) return 'past';
  if (diff <= 7) return 'urgent';
  if (diff <= 30) return 'soon';
  return 'ok';
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderAll() {
  updateStats();
  renderSources();
  renderCalendar();
}

function updateStats() {
  const active = sources.filter(s => s.urgency !== 'past');
  document.getElementById('statTotal').textContent  = active.length;
  document.getElementById('statUrgent').textContent = active.filter(s => s.urgency === 'urgent').length;
  document.getElementById('statSoon').textContent   = active.filter(s => s.urgency === 'soon').length;
  document.getElementById('statAdded').textContent  = addedIds.size;
}

function renderSources() {
  const search   = (document.getElementById('searchInput').value || '').toLowerCase();
  const typeF    = document.getElementById('filterType').value;
  const urgencyF = document.getElementById('filterUrgency').value;

  let filtered = sources.filter(s => s.urgency !== 'past');
  if (search)   filtered = filtered.filter(s => s.name.toLowerCase().includes(search) || s.url.toLowerCase().includes(search));
  if (typeF)    filtered = filtered.filter(s => s.type === typeF);
  if (urgencyF) filtered = filtered.filter(s => s.urgency === urgencyF);

  const urgencyOrder = { urgent: 0, soon: 1, unknown: 2, ok: 3 };
  filtered.sort((a, b) => (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3));

  const list = document.getElementById('sourceList');
  document.getElementById('listTitle').textContent = `${filtered.length} source${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No sources match your filters.</div>';
    return;
  }

  list.innerHTML = filtered.map(s => {
    const cardClass = addedIds.has(s.id) ? 'added' : s.urgency;
    const badgeClass = addedIds.has(s.id) ? 'added' : s.urgency;
    return `
    <div class="source-card ${cardClass}">
      <div class="source-icon">${typeEmoji(s.type)}</div>
      <div class="source-body">
        <div class="source-name">${esc(s.name)}</div>
        <div class="source-meta">
          ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${shortUrl(s.url)}</a>` : 'No URL'}
          ${s.rawDate ? ' · ' + esc(s.rawDate) : ''}
        </div>
        <div class="source-tags">
          <span class="tag type-${s.type}">${s.type}</span>
          ${s.notes ? `<span class="tag">${esc(s.notes.substring(0, 50))}</span>` : ''}
        </div>
      </div>
      <div class="source-actions">
        <span class="days-badge ${badgeClass}">${daysLabel(s)}</span>
        ${accessToken && !addedIds.has(s.id)
          ? `<button class="btn btn-sm" onclick="addToCalendar(${s.id})">+ Calendar</button>`
          : addedIds.has(s.id) ? '<span class="added-label">✓ Added</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

function typeEmoji(type) {
  return { accelerator: '🚀', fellowship: '🏛️', competition: '🏆', grant: '💰', event: '📅', vc: '💼', other: '📌' }[type] || '📌';
}

function daysLabel(s) {
  if (!s.parsedDate) return 'Date unknown';
  const diff = Math.ceil((s.parsedDate - now) / 86400000);
  if (diff < 0)  return 'Passed';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `In ${diff} days`;
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url.substring(0, 40); }
}

// ── Calendar ───────────────────────────────────────────────────────────────
function renderCalendar() {
  const grid = document.getElementById('calGrid');
  document.getElementById('calTitle').textContent = new Date(calYear, calMonth).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-day-label';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay     = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth  = new Date(calYear, calMonth + 1, 0).getDate();
  const prevMonthEnd = new Date(calYear, calMonth, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<div class="cal-date">${prevMonthEnd - firstDay + 1 + i}</div>`;
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cell      = document.createElement('div');
    const thisDate  = new Date(calYear, calMonth, d);
    const isToday   = thisDate.toDateString() === now.toDateString();
    cell.className  = 'cal-cell' + (isToday ? ' today' : '');
    cell.innerHTML  = `<div class="cal-date">${d}</div>`;

    const dayEvents = sources.filter(s => s.parsedDate && s.parsedDate.toDateString() === thisDate.toDateString());
    dayEvents.slice(0, 3).forEach(s => {
      const ev = document.createElement('div');
      ev.className = 'cal-event ' + (s.urgency === 'urgent' ? 'urgent' : s.urgency === 'soon' ? 'soon' : 'ok');
      ev.textContent = s.name;
      ev.title = s.name;
      cell.appendChild(ev);
    });
    if (dayEvents.length > 3) {
      const more = document.createElement('div');
      more.className = 'cal-more';
      more.textContent = `+${dayEvents.length - 3} more`;
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }

  const remaining = 42 - firstDay - daysInMonth;
  for (let i = 1; i <= remaining; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<div class="cal-date">${i}</div>`;
    grid.appendChild(cell);
  }
}

function prevMonth() { calMonth--; if (calMonth < 0)  { calMonth = 11; calYear--; } renderCalendar(); }
function nextMonth() { calMonth++; if (calMonth > 11) { calMonth = 0;  calYear++; } renderCalendar(); }

// ── Google Calendar ────────────────────────────────────────────────────────
async function addToCalendar(id) {
  if (!accessToken) { showToast('Connect Google first.'); return; }
  const s = sources.find(x => x.id === id);
  if (!s) return;

  const start = s.parsedDate || new Date(now.getTime() + 7 * 86400000);
  const end   = new Date(start.getTime() + 3600000);

  const event = {
    summary: `[Squawk] ${s.name}`,
    description: `Type: ${s.type}\nSource: ${s.url}\n${s.notes ? 'Notes: ' + s.notes : ''}`.trim(),
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 1440 },
        { method: 'email', minutes: 10080 }
      ]
    }
  };

  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const data = await res.json();
    if (data.id) {
      addedIds.add(id);
      showToast(`Added "${s.name}" to Calendar`);
      renderAll();
    } else {
      showToast('Calendar error: ' + (data.error?.message || 'Unknown error'));
    }
  } catch (e) {
    showToast('Calendar request failed: ' + e.message);
  }
}

async function addAllToCalendar() {
  const toAdd = sources.filter(s => !addedIds.has(s.id) && s.urgency !== 'past');
  showToast(`Adding ${toAdd.length} sources to Calendar...`);
  for (const s of toAdd) {
    await addToCalendar(s.id);
    await sleep(250);
  }
  showToast('All sources added to Calendar.');
}

// ── ICS Export ─────────────────────────────────────────────────────────────
function exportIcs() {
  const active = sources.filter(s => s.urgency !== 'past');
  if (!active.length) { showToast('No sources to export.'); return; }

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Squawk//Deal Flow Tracker//EN', 'CALSCALE:GREGORIAN'];

  active.forEach(s => {
    const start = s.parsedDate || new Date(now.getTime() + 7 * 86400000);
    const end   = new Date(start.getTime() + 3600000);
    const fmt   = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    lines.push(
      'BEGIN:VEVENT',
      `UID:squawk-${s.id}-${Date.now()}@squawk`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:[Squawk] ${s.name}`,
      `DESCRIPTION:Type: ${s.type}\\nURL: ${s.url}\\n${s.notes}`,
      'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', `DESCRIPTION:Reminder: ${s.name}`, 'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'squawk-deal-flow.ics';
  a.click();
  showToast(`Exported ${active.length} sources as .ics`);
}

// ── Demo ───────────────────────────────────────────────────────────────────
function loadDemo() {
  const future = (days) => new Date(now.getTime() + days * 86400000);
  sources = [
    { id: 0,  name: 'ConceptionX Cohort 8',          url: 'https://conceptionx.org',                                      type: 'accelerator',  rawDate: future(18).toDateString(),  parsedDate: future(18),  notes: 'Deep tech, university spinouts', urgency: 'soon' },
    { id: 1,  name: 'Activate Fellows Program',       url: 'https://activate.org',                                         type: 'fellowship',   rawDate: future(5).toDateString(),   parsedDate: future(5),   notes: 'Science entrepreneurs',          urgency: 'urgent' },
    { id: 2,  name: 'Entrepreneur First London',      url: 'https://www.joinef.com',                                       type: 'accelerator',  rawDate: future(35).toDateString(),  parsedDate: future(35),  notes: 'Pre-team, pre-idea',              urgency: 'ok' },
    { id: 3,  name: 'Innovate UK Smart Grants',       url: 'https://www.ukri.org/councils/innovate-uk/',                   type: 'grant',        rawDate: '',                         parsedDate: null,        notes: 'Rolling deadlines',               urgency: 'unknown' },
    { id: 4,  name: 'SFC MedTech Accelerator',        url: 'https://www.sfcollective.com',                                 type: 'accelerator',  rawDate: future(60).toDateString(),  parsedDate: future(60),  notes: 'MedTech focus',                   urgency: 'ok' },
    { id: 5,  name: 'UKRI Future Leaders Fellowships',url: 'https://www.ukri.org/apply-for-funding/future-leaders-fellowships/', type: 'fellowship', rawDate: future(28).toDateString(), parsedDate: future(28), notes: 'Academic spinouts',             urgency: 'soon' },
    { id: 6,  name: 'Startupbootcamp FinTech',        url: 'https://www.startupbootcamp.org',                              type: 'accelerator',  rawDate: future(6).toDateString(),   parsedDate: future(6),   notes: 'London-based',                    urgency: 'urgent' },
    { id: 7,  name: 'MIT Climate & Energy Prize',     url: 'https://cep.mit.edu',                                          type: 'competition',  rawDate: future(22).toDateString(),  parsedDate: future(22),  notes: '$100k+ prize',                    urgency: 'soon' },
    { id: 8,  name: 'Seedcamp',                       url: 'https://seedcamp.com',                                         type: 'vc',           rawDate: '',                         parsedDate: null,        notes: 'Rolling applications',            urgency: 'unknown' },
    { id: 9,  name: 'Hello Tomorrow Summit',          url: 'https://hellotomorrow.global',                                 type: 'event',        rawDate: future(90).toDateString(),  parsedDate: future(90),  notes: 'Deep tech, Paris',                urgency: 'ok' },
  ];

  document.getElementById('connStatus').textContent  = 'Demo mode';
  document.getElementById('connStatus').className    = 'conn-status demo';
  document.getElementById('exportIcsBtn').disabled   = false;
  showApp();
  renderAll();
  showToast('Demo data loaded — 10 sample sources');
}

// ── AI Agents ──────────────────────────────────────────────────────────────
async function callClaude(system, user, btnId, resultId) {
  const btn = document.getElementById(btnId);
  const result = document.getElementById(resultId);
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running...';
  result.style.display = 'none';

  try {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || 'No response received.';
    result.textContent = text;
    result.style.display = 'block';
  } catch (e) {
    result.textContent = 'Error: ' + e.message;
    result.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = origText;
}

function runParseAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }
  const sample = sources.slice(0, 20).map(s => `- ${s.name} | ${s.url || 'no url'} | ${s.rawDate || 'no date'}`).join('\n');
  callClaude(
    'You are a deal flow analyst for an early-stage investor. Analyse programme sources and provide estimated cohort windows, urgency, and key insights. Be concise and practical.',
    `Analyse these deal flow sources and for each provide: estimated next opening window, urgency level, and a 1-line insight on why it matters.\n\n${sample}`,
    'parseBtn', 'parseResult'
  );
}

function runDiscoverAgent() {
  const types = [...new Set(sources.map(s => s.type))].join(', ');
  const names = sources.slice(0, 8).map(s => s.name).join(', ');
  callClaude(
    'You are a startup ecosystem researcher specialising in early-stage deal flow for UK/EU investors. You have deep knowledge of accelerators, fellowships, competitions, and grants.',
    `I track these types of sources: ${types || 'accelerators, fellowships, competitions, grants'}.\nExamples I already track: ${names || 'various programmes'}.\n\nSuggest 10 high-quality deal flow sources I might be missing. For each: name, URL, type, typical cohort timing, and why it is valuable for early-stage deal flow. Prioritise UK/EU but include key global ones.`,
    'discoverBtn', 'discoverResult'
  );
}

function runDigestAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }
  const upcoming = sources
    .filter(s => s.urgency === 'urgent' || s.urgency === 'soon')
    .map(s => `- ${s.name} (${s.type}) — ${daysLabel(s)} — ${s.url}`)
    .join('\n');
  const total = sources.filter(s => s.urgency !== 'past').length;
  callClaude(
    'You are a VC analyst. Write concise, professional weekly deal flow digests for investment teams. Tone: clear, direct, no fluff.',
    `Write a weekly deal flow digest email. Total sources tracked: ${total}.\n\nUpcoming in the next 30 days:\n${upcoming || 'None with confirmed dates yet.'}\n\nInclude: subject line, brief intro, structured list of opportunities, and recommended actions for this week.`,
    'digestBtn', 'digestResult'
  );
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', ['dashboard', 'calendar', 'agent'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'calendar') renderCalendar();
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
