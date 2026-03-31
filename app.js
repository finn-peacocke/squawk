// ── Constants ──────────────────────────────────────────────────────────────
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/calendar.events';
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
  loadAllSheets();
}

function showApp() {
  document.getElementById('setupPanel').classList.add('hidden');
  document.getElementById('appPanel').classList.remove('hidden');
}

function syncSheet() {
  if (sheetId && accessToken) loadAllSheets();
}

function extractSheetId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// ── Multi-sheet loader ─────────────────────────────────────────────────────
async function loadAllSheets() {
  showToast('Loading all sheet tabs...');
  sources = [];

  try {
    // Step 1: get metadata to discover all tab names
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const meta = await metaRes.json();
    if (meta.error) { showToast('Sheets API error: ' + meta.error.message); return; }

    const sheets = meta.sheets || [];
    if (!sheets.length) { showToast('No tabs found in spreadsheet.'); return; }
    showToast(`Found ${sheets.length} tabs — loading...`);

    // Step 2: batchGet all tabs in one request using single-quoted names
    // Single quotes handle spaces, accents, and special chars safely
    const ranges = sheets.map(sh => "'" + sh.properties.title.replace(/'/g, "\\'") + "'!A1:Z500");
    const rangeParams = ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&');

    const batchRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${rangeParams}`,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const batchData = await batchRes.json();
    if (batchData.error) { showToast('Batch load error: ' + batchData.error.message); return; }

    // Step 3: parse each tab
    let id = 0;
    (batchData.valueRanges || []).forEach((vr, i) => {
      const tabName = sheets[i].properties.title;
      const rows = vr.values || [];
      if (rows.length < 2) return;
      const parsed = parseTab(rows, tabName);
      parsed.forEach(s => { s.id = id++; sources.push(s); });
    });

    showToast(`Loaded ${sources.length} sources across ${sheets.length} tabs`);
    renderAll();

  } catch (e) {
    showToast('Failed to load sheets: ' + e.message);
  }
}

// ── Per-tab parser ─────────────────────────────────────────────────────────
function parseTab(rows, tabName) {
  const isEventsTab = tabName.toLowerCase().includes('event');
  return isEventsTab ? parseEventsTab(rows, tabName) : parseStandardTab(rows, tabName);
}

// Standard tabs: Col A = Name, Col B = Link (+ any extra columns)
function parseStandardTab(rows, tabName) {
  const headers = rows[0].map(h => (h || '').toLowerCase().trim());

  const nameIdx  = Math.max(0, headers.findIndex(h => h.includes('name') || h.includes('source') || h.includes('programme') || h.includes('program') || h.includes('organisation')));
  const urlIdx   = headers.findIndex(h => h.includes('link') || h.includes('url') || h.includes('website') || h.includes('http'));
  const dateIdx  = headers.findIndex(h => h.includes('date') || h.includes('deadline') || h.includes('cohort') || h.includes('open') || h.includes('launch'));
  const notesIdx = headers.findIndex(h => h.includes('note') || h.includes('description') || h.includes('detail') || h.includes('focus') || h.includes('priority'));

  // Default: name=col0, link=col1 if not found in headers
  const resolvedUrlIdx = urlIdx >= 0 ? urlIdx : 1;

  const tabType = guessTypeFromTab(tabName);

  return rows.slice(1)
    .filter(r => r[nameIdx] && (r[nameIdx] || '').trim())
    .map(row => {
      const name       = (row[nameIdx] || '').trim();
      const url        = (row[resolvedUrlIdx] || findUrl(row) || '').trim();
      const rawDate    = dateIdx >= 0 ? (row[dateIdx] || '').trim() : '';
      const notes      = notesIdx >= 0 ? (row[notesIdx] || '').trim() : '';
      const type       = guessType(name, url, tabType);
      const parsedDate = parseDate(rawDate);
      const urgency    = getUrgency(parsedDate);
      return { name, url, type, rawDate, parsedDate, notes, urgency, tab: tabName };
    });
}

// Events tab: Col A=Start Date, Col B=End Date, Col C=Event Name,
//             Col D=Location, Col E=Focus, Col F=Priority
function parseEventsTab(rows, tabName) {
  return rows.slice(1)
    .filter(r => r[2] && (r[2] || '').trim())
    .map(row => {
      const rawDate    = (row[0] || '').trim();
      const rawEndDate = (row[1] || '').trim();
      const name       = (row[2] || '').trim();
      const location   = (row[3] || '').trim();
      const focus      = (row[4] || '').trim();
      const priority   = (row[5] || '').trim();
      const parsedDate = parseDate(rawDate);
      const urgency    = getUrgency(parsedDate);
      const notes      = [location, focus, priority].filter(Boolean).join(' · ');
      return { name, url: '', type: 'event', rawDate, rawEndDate, parsedDate, notes, urgency, tab: tabName };
    });
}

function guessTypeFromTab(tabName) {
  const t = tabName.toLowerCase();
  if (t.includes('accelerat')) return 'accelerator';
  if (t.includes('fellow')) return 'fellowship';
  if (t.includes('compet') || t.includes('award') || t.includes('prize') || t.includes('hack')) return 'competition';
  if (t.includes('grant') || t.includes('fund')) return 'grant';
  if (t.includes('event')) return 'event';
  if (t.includes('vc') || t.includes('venture') || t.includes('invest')) return 'vc';
  return null;
}

function guessType(name, url, tabType) {
  if (tabType) return tabType;
  const txt = (name + url).toLowerCase();
  if (txt.includes('accelerat') || txt.includes('techstars') || txt.includes('bootcamp') || txt.includes('y combinator')) return 'accelerator';
  if (txt.includes('fellow')) return 'fellowship';
  if (txt.includes('compet') || txt.includes('award') || txt.includes('prize') || txt.includes('hackathon')) return 'competition';
  if (txt.includes('grant') || txt.includes('fund') || txt.includes('innovate uk')) return 'grant';
  if (txt.includes('event') || txt.includes('summit') || txt.includes('conf') || txt.includes('demo day')) return 'event';
  if (txt.includes('vc') || txt.includes('venture')) return 'vc';
  return 'accelerator';
}

function findUrl(row) {
  return row.find(c => c && (c.startsWith('http://') || c.startsWith('https://'))) || '';
}

function parseDate(str) {
  if (!str) return null;
  const cleaned = str.trim();
  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmy = cleaned.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
    const d = new Date(`${year}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function getUrgency(date) {
  if (!date) return 'unknown';
  const diff = Math.ceil((date - now) / 86400000);
  if (diff < 0)   return 'past';
  if (diff <= 7)  return 'urgent';
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
  if (search)   filtered = filtered.filter(s =>
    s.name.toLowerCase().includes(search) ||
    (s.url || '').toLowerCase().includes(search) ||
    (s.tab || '').toLowerCase().includes(search)
  );
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
    const cardClass  = addedIds.has(s.id) ? 'added' : s.urgency;
    const badgeClass = addedIds.has(s.id) ? 'added' : s.urgency;
    return `
    <div class="source-card ${cardClass}">
      <div class="source-icon">${typeEmoji(s.type)}</div>
      <div class="source-body">
        <div class="source-name">${esc(s.name)}</div>
        <div class="source-meta">
          ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${shortUrl(s.url)}</a>` : ''}
          ${s.url && s.tab ? ' · ' : ''}
          ${s.tab ? `<span style="color:#bbb">${esc(s.tab)}</span>` : ''}
          ${s.rawDate ? ' · ' + esc(s.rawDate) : ''}
        </div>
        <div class="source-tags">
          <span class="tag type-${s.type}">${s.type}</span>
          ${s.notes ? `<span class="tag">${esc(s.notes.substring(0, 60))}</span>` : ''}
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
  if (diff < 0)   return 'Passed';
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
    const cell     = document.createElement('div');
    const thisDate = new Date(calYear, calMonth, d);
    const isToday  = thisDate.toDateString() === now.toDateString();
    cell.className = 'cal-cell' + (isToday ? ' today' : '');
    cell.innerHTML = `<div class="cal-date">${d}</div>`;

    const dayEvents = sources.filter(s => s.parsedDate && s.parsedDate.toDateString() === thisDate.toDateString());
    dayEvents.slice(0, 3).forEach(s => {
      const ev = document.createElement('div');
      ev.className = 'cal-event ' + (s.urgency === 'urgent' ? 'urgent' : s.urgency === 'soon' ? 'soon' : 'ok');
      ev.textContent = s.name;
      ev.title = s.name + (s.tab ? ' (' + s.tab + ')' : '');
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
  const end   = s.rawEndDate ? (parseDate(s.rawEndDate) || new Date(start.getTime() + 3600000)) : new Date(start.getTime() + 3600000);

  const event = {
    summary: `[Squawk] ${s.name}`,
    description: [`Type: ${s.type}`, `Tab: ${s.tab || ''}`, s.url ? `URL: ${s.url}` : '', s.notes ? `Notes: ${s.notes}` : ''].filter(Boolean).join('\n'),
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
    await sleep(300);
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
    const end   = s.rawEndDate ? (parseDate(s.rawEndDate) || new Date(start.getTime() + 3600000)) : new Date(start.getTime() + 3600000);
    const fmt   = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    lines.push(
      'BEGIN:VEVENT',
      `UID:squawk-${s.id}-${Date.now()}@squawk`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:[Squawk] ${s.name}`,
      `DESCRIPTION:Type: ${s.type}\\nTab: ${s.tab || ''}\\nURL: ${s.url || ''}\\n${s.notes || ''}`,
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
    { id: 0, name: 'ConceptionX Cohort 8',            url: 'https://conceptionx.org',         type: 'accelerator', rawDate: future(18).toDateString(), parsedDate: future(18), notes: 'Deep tech, university spinouts', urgency: 'soon',    tab: 'UK' },
    { id: 1, name: 'Activate Fellows Program',         url: 'https://activate.org',            type: 'fellowship',  rawDate: future(5).toDateString(),  parsedDate: future(5),  notes: 'Science entrepreneurs',          urgency: 'urgent',  tab: 'US' },
    { id: 2, name: 'Entrepreneur First London',        url: 'https://www.joinef.com',          type: 'accelerator', rawDate: future(35).toDateString(), parsedDate: future(35), notes: 'Pre-team, pre-idea',              urgency: 'ok',      tab: 'UK' },
    { id: 3, name: 'Innovate UK Smart Grants',         url: 'https://www.ukri.org',            type: 'grant',       rawDate: '',                        parsedDate: null,       notes: 'Rolling deadlines',               urgency: 'unknown', tab: 'UK' },
    { id: 4, name: 'Hello Tomorrow Summit',            url: 'https://hellotomorrow.global',    type: 'event',       rawDate: future(45).toDateString(), parsedDate: future(45), notes: 'Paris · Deep tech · High',        urgency: 'ok',      tab: 'Events' },
    { id: 5, name: 'UKRI Future Leaders Fellowships',  url: 'https://www.ukri.org',            type: 'fellowship',  rawDate: future(28).toDateString(), parsedDate: future(28), notes: 'Academic spinouts',               urgency: 'soon',    tab: 'UK' },
    { id: 6, name: 'Startupbootcamp FinTech',          url: 'https://startupbootcamp.org',     type: 'accelerator', rawDate: future(6).toDateString(),  parsedDate: future(6),  notes: 'London-based',                    urgency: 'urgent',  tab: 'EU' },
    { id: 7, name: 'MIT Climate & Energy Prize',       url: 'https://cep.mit.edu',             type: 'competition', rawDate: future(22).toDateString(), parsedDate: future(22), notes: '$100k+ prize',                    urgency: 'soon',    tab: 'US' },
    { id: 8, name: 'Seedcamp',                         url: 'https://seedcamp.com',            type: 'vc',          rawDate: '',                        parsedDate: null,       notes: 'Rolling applications',            urgency: 'unknown', tab: 'EU' },
    { id: 9, name: 'Web Summit Lisbon',                url: 'https://websummit.com',           type: 'event',       rawDate: future(90).toDateString(), parsedDate: future(90), notes: 'Lisbon · Tech · High',            urgency: 'ok',      tab: 'Events' },
  ];
  document.getElementById('connStatus').textContent = 'Demo mode';
  document.getElementById('connStatus').className   = 'conn-status demo';
  showApp();
  renderAll();
  showToast('Demo data loaded — 10 sources across 4 tabs');
}

// ── AI Agents ──────────────────────────────────────────────────────────────
async function callClaude(system, user, btnId, resultId) {
  const btn      = document.getElementById(btnId);
  const result   = document.getElementById(resultId);
  const origText = btn.textContent;
  btn.disabled    = true;
  btn.textContent = 'Running...';
  result.style.display = 'none';

  try {
    // Direct call with the browser-access header — works from a proper https origin like GitHub Pages
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    result.textContent = data.content?.[0]?.text || 'No response received.';
    result.style.display = 'block';

  } catch (e) {
    result.textContent = 'Could not reach AI — this feature requires an Anthropic API key.\n\nError: ' + e.message;
    result.style.display = 'block';
  }

  btn.disabled    = false;
  btn.textContent = origText;
}

function runParseAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }
  const sample = sources.slice(0, 25)
    .map(s => `- ${s.name} | tab: ${s.tab || 'unknown'} | url: ${s.url || 'none'} | date: ${s.rawDate || 'none'}`)
    .join('\n');
  callClaude(
    'You are a deal flow analyst for an early-stage investor. Analyse programme sources and provide estimated cohort windows, urgency, and key insights. Be concise and practical.',
    `Analyse these deal flow sources. For each provide: estimated next opening window (month/year), urgency (urgent/soon/later), and a 1-line insight on why it matters.\n\n${sample}`,
    'parseBtn', 'parseResult'
  );
}

function runDiscoverAgent() {
  const tabs  = [...new Set(sources.map(s => s.tab).filter(Boolean))].join(', ');
  const names = sources.slice(0, 10).map(s => s.name).join(', ');
  callClaude(
    'You are a startup ecosystem researcher specialising in early-stage deal flow for UK/EU investors. You have deep knowledge of accelerators, fellowships, competitions, and grants.',
    `I track deal flow across: ${tabs || 'UK, EU, US'}.\nExamples already tracked: ${names || 'various'}.\n\nSuggest 10 high-quality sources I might be missing. For each: name, URL, type, typical cohort timing, and why it is valuable. Prioritise UK/EU but include key global ones.`,
    'discoverBtn', 'discoverResult'
  );
}

function runDigestAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }
  const upcoming = sources
    .filter(s => s.urgency === 'urgent' || s.urgency === 'soon')
    .map(s => `- ${s.name} (${s.type}, ${s.tab || ''}) — ${daysLabel(s)}${s.url ? ' — ' + s.url : ''}`)
    .join('\n');
  const total = sources.filter(s => s.urgency !== 'past').length;
  callClaude(
    'You are a VC analyst. Write concise, professional weekly deal flow digest emails. Tone: clear, direct, no fluff.',
    `Write a weekly deal flow digest. Total tracked: ${total}.\n\nUpcoming (next 30 days):\n${upcoming || 'None with confirmed dates.'}\n\nInclude: subject line, brief intro, structured list grouped by urgency, recommended actions this week.`,
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
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
