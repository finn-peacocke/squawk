// ── Constants ──────────────────────────────────────────────────────────────
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/calendar.events';
const STORAGE_KEY = 'squawk_config';

// ── State ──────────────────────────────────────────────────────────────────
let sources = [];
let addedIds = new Set();
let accessToken = null;
let sheetId = null;
let anthropicKey = null;
let calYear, calMonth;
const now = new Date();
calYear = now.getFullYear();
calMonth = now.getMonth();

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const saved = loadConfig();
  if (saved.sheetUrl) document.getElementById('sheetUrlInput').value = saved.sheetUrl;
  if (saved.clientId) document.getElementById('clientIdInput').value = saved.clientId;
  if (saved.anthropicKey) {
    document.getElementById('anthropicKeyInput').value = saved.anthropicKey;
    anthropicKey = saved.anthropicKey;
  }
  renderCalendar();
});

// ── Config persistence ─────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function saveConfig(clientId, sheetUrl, apiKey) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ clientId, sheetUrl, anthropicKey: apiKey }));
}

// ── Auth ───────────────────────────────────────────────────────────────────
function startAuth() {
  const clientId = document.getElementById('clientIdInput').value.trim();
  const sheetUrl = document.getElementById('sheetUrlInput').value.trim();
  const apiKey   = document.getElementById('anthropicKeyInput').value.trim();

  if (!clientId || !sheetUrl) { showToast('Please enter your Client ID and Sheet URL.'); return; }

  sheetId = extractSheetId(sheetUrl);
  if (!sheetId) { showToast('Could not parse Sheet ID from URL.'); return; }

  anthropicKey = apiKey;
  saveConfig(clientId, sheetUrl, apiKey);

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
  document.getElementById('apiKeyBtn').style.display = '';
  document.getElementById('syncBtn').disabled = false;
  document.getElementById('addAllBtn').disabled = false;
  showApp();
  loadAllSheets();
}

function promptApiKey() {
  const key = prompt('Enter your Anthropic API key (sk-ant-...):', anthropicKey || '');
  if (key === null) return;
  anthropicKey = key.trim();
  const saved = loadConfig();
  saveConfig(saved.clientId || '', saved.sheetUrl || '', anthropicKey);
  showToast(anthropicKey ? 'API key saved.' : 'API key cleared.');
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
    const metaRes = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '?fields=sheets.properties',
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const meta = await metaRes.json();
    if (meta.error) { showToast('Sheets API error: ' + meta.error.message); return; }

    const sheets = meta.sheets || [];
    if (!sheets.length) { showToast('No tabs found in spreadsheet.'); return; }
    showToast('Found ' + sheets.length + ' tabs — loading...');

    // batchGet all tabs in one request using single-quoted names (handles spaces/accents)
    const ranges = sheets.map(function(sh) {
      return "'" + sh.properties.title.replace(/'/g, "\\'") + "'!A1:Z500";
    });
    const rangeParams = ranges.map(function(r) { return 'ranges=' + encodeURIComponent(r); }).join('&');

    const batchRes = await fetch(
      'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values:batchGet?' + rangeParams,
      { headers: { Authorization: 'Bearer ' + accessToken } }
    );
    const batchData = await batchRes.json();
    if (batchData.error) { showToast('Batch load error: ' + batchData.error.message); return; }

    var id = 0;
    (batchData.valueRanges || []).forEach(function(vr, i) {
      var tabName = sheets[i].properties.title;
      var rows = vr.values || [];
      if (rows.length < 2) return;
      var parsed = parseTab(rows, tabName);
      parsed.forEach(function(s) { s.id = id++; sources.push(s); });
    });

    showToast('Loaded ' + sources.length + ' sources across ' + sheets.length + ' tabs');
    renderAll();

  } catch (e) {
    showToast('Failed to load sheets: ' + e.message);
  }
}

// ── Per-tab parser ─────────────────────────────────────────────────────────
function parseTab(rows, tabName) {
  var isEventsTab = tabName.toLowerCase().includes('event');
  return isEventsTab ? parseEventsTab(rows, tabName) : parseStandardTab(rows, tabName);
}

// Standard tabs: Col A = Name, Col B = Link
function parseStandardTab(rows, tabName) {
  var headers = rows[0].map(function(h) { return (h || '').toLowerCase().trim(); });

  var nameIdx = headers.findIndex(function(h) {
    return h.includes('name') || h.includes('source') || h.includes('programme') || h.includes('program') || h.includes('organisation');
  });
  if (nameIdx < 0) nameIdx = 0;

  var urlIdx = headers.findIndex(function(h) {
    return h.includes('link') || h.includes('url') || h.includes('website') || h.includes('http');
  });
  if (urlIdx < 0) urlIdx = 1;

  var dateIdx = headers.findIndex(function(h) {
    return h.includes('date') || h.includes('deadline') || h.includes('cohort') || h.includes('open') || h.includes('launch');
  });

  var notesIdx = headers.findIndex(function(h) {
    return h.includes('note') || h.includes('description') || h.includes('detail') || h.includes('focus') || h.includes('priority');
  });

  var tabType = guessTypeFromTab(tabName);

  return rows.slice(1)
    .filter(function(r) { return r[nameIdx] && (r[nameIdx] || '').trim(); })
    .map(function(row) {
      var name     = (row[nameIdx] || '').trim();
      var url      = (row[urlIdx] || findUrl(row) || '').trim();
      var rawDate  = dateIdx >= 0 ? (row[dateIdx] || '').trim() : '';
      var notes    = notesIdx >= 0 ? (row[notesIdx] || '').trim() : '';
      var type     = guessType(name, url, tabType);
      var parsedDate = parseDate(rawDate);
      var urgency  = getUrgency(parsedDate);
      return { name: name, url: url, type: type, rawDate: rawDate, parsedDate: parsedDate, notes: notes, urgency: urgency, tab: tabName };
    });
}

// Events tab: Col A=Start Date, Col B=End Date, Col C=Event Name, Col D=Location, Col E=Focus, Col F=Priority
function parseEventsTab(rows, tabName) {
  return rows.slice(1)
    .filter(function(r) { return r[2] && (r[2] || '').trim(); })
    .map(function(row) {
      var rawDate    = (row[0] || '').trim();
      var rawEndDate = (row[1] || '').trim();
      var name       = (row[2] || '').trim();
      var location   = (row[3] || '').trim();
      var focus      = (row[4] || '').trim();
      var priority   = (row[5] || '').trim();
      var parsedDate = parseDate(rawDate);
      // Advance past recurring event dates to next annual occurrence
      if (parsedDate && parsedDate < now) {
        parsedDate = advanceRecurringDate(parsedDate);
      }
      var urgency = getUrgency(parsedDate);
      var notes   = [location, focus, priority].filter(Boolean).join(' · ');
      return { name: name, url: '', type: 'event', rawDate: rawDate, rawEndDate: rawEndDate, parsedDate: parsedDate, notes: notes, urgency: urgency, tab: tabName, recurring: true };
    });
}

function guessTypeFromTab(tabName) {
  var t = tabName.toLowerCase();
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
  var txt = (name + url).toLowerCase();
  if (txt.includes('accelerat') || txt.includes('techstars') || txt.includes('bootcamp') || txt.includes('y combinator')) return 'accelerator';
  if (txt.includes('fellow')) return 'fellowship';
  if (txt.includes('compet') || txt.includes('award') || txt.includes('prize') || txt.includes('hackathon')) return 'competition';
  if (txt.includes('grant') || txt.includes('fund') || txt.includes('innovate uk')) return 'grant';
  if (txt.includes('event') || txt.includes('summit') || txt.includes('conf') || txt.includes('demo day')) return 'event';
  if (txt.includes('vc') || txt.includes('venture')) return 'vc';
  return 'accelerator';
}

function findUrl(row) {
  return row.find(function(c) { return c && (c.startsWith('http://') || c.startsWith('https://')); }) || '';
}

function parseDate(str) {
  if (!str) return null;
  var cleaned = str.trim();
  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  var dmy = cleaned.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    var year = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
    var d = new Date(year + '-' + dmy[2].padStart(2, '0') + '-' + dmy[1].padStart(2, '0'));
    if (!isNaN(d.getTime())) return d;
  }
  var d2 = new Date(cleaned);
  return isNaN(d2.getTime()) ? null : d2;
}

// Advance a past date to its next annual occurrence
function advanceRecurringDate(date) {
  if (!date) return null;
  var d = new Date(date);
  // Keep adding a year until it's in the future
  while (d < now) {
    d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

function getUrgency(date) {
  if (!date) return 'unknown';
  var diff = Math.ceil((date - now) / 86400000);
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
  var active = sources.filter(function(s) { return s.urgency !== 'past'; });
  document.getElementById('statTotal').textContent  = active.length;
  document.getElementById('statUrgent').textContent = active.filter(function(s) { return s.urgency === 'urgent'; }).length;
  document.getElementById('statSoon').textContent   = active.filter(function(s) { return s.urgency === 'soon'; }).length;
  document.getElementById('statAdded').textContent  = addedIds.size;
}

function renderSources() {
  var search   = (document.getElementById('searchInput').value || '').toLowerCase();
  var typeF    = document.getElementById('filterType').value;
  var urgencyF = document.getElementById('filterUrgency').value;

  var filtered = sources.filter(function(s) { return s.urgency !== 'past'; });
  if (search) {
    filtered = filtered.filter(function(s) {
      return s.name.toLowerCase().includes(search) ||
             (s.url || '').toLowerCase().includes(search) ||
             (s.tab || '').toLowerCase().includes(search);
    });
  }
  if (typeF)    filtered = filtered.filter(function(s) { return s.type === typeF; });
  if (urgencyF) filtered = filtered.filter(function(s) { return s.urgency === urgencyF; });

  var urgencyOrder = { urgent: 0, soon: 1, unknown: 2, ok: 3 };
  filtered.sort(function(a, b) { return (urgencyOrder[a.urgency] || 3) - (urgencyOrder[b.urgency] || 3); });

  var list = document.getElementById('sourceList');
  document.getElementById('listTitle').textContent = filtered.length + ' source' + (filtered.length !== 1 ? 's' : '');

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No sources match your filters.</div>';
    return;
  }

  list.innerHTML = filtered.map(function(s) {
    var cardClass  = addedIds.has(s.id) ? 'added' : s.urgency;
    var badgeClass = addedIds.has(s.id) ? 'added' : s.urgency;
    return '<div class="source-card ' + cardClass + '">' +
      '<div class="source-icon">' + typeEmoji(s.type) + '</div>' +
      '<div class="source-body">' +
        '<div class="source-name">' + esc(s.name) + '</div>' +
        '<div class="source-meta">' +
          (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + shortUrl(s.url) + '</a>' : '') +
          (s.url && s.tab ? ' · ' : '') +
          (s.tab ? '<span style="color:#bbb">' + esc(s.tab) + '</span>' : '') +
          (s.rawDate ? ' · ' + esc(s.rawDate) : '') +
        '</div>' +
        '<div class="source-tags">' +
          '<span class="tag type-' + s.type + '">' + s.type + '</span>' +
          (s.notes ? '<span class="tag">' + esc(s.notes.substring(0, 60)) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="source-actions">' +
        '<span class="days-badge ' + badgeClass + '">' + daysLabel(s) + '</span>' +
        (accessToken && !addedIds.has(s.id)
          ? '<button class="btn btn-sm" onclick="addToCalendar(' + s.id + ')">+ Calendar</button>'
          : addedIds.has(s.id) ? '<span class="added-label">✓ Added</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function typeEmoji(type) {
  var map = { accelerator: '🚀', fellowship: '🏛️', competition: '🏆', grant: '💰', event: '📅', vc: '💼', other: '📌' };
  return map[type] || '📌';
}

function daysLabel(s) {
  if (!s.parsedDate) return 'Date unknown';
  var diff = Math.ceil((s.parsedDate - now) / 86400000);
  if (diff < 0)   return 'Passed';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return 'In ' + diff + ' days';
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch(e) { return url.substring(0, 40); }
}

// ── Calendar ───────────────────────────────────────────────────────────────
function renderCalendar() {
  var grid = document.getElementById('calGrid');
  document.getElementById('calTitle').textContent = new Date(calYear, calMonth).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function(d) {
    var el = document.createElement('div');
    el.className = 'cal-day-label';
    el.textContent = d;
    grid.appendChild(el);
  });

  var firstDay     = new Date(calYear, calMonth, 1).getDay();
  var daysInMonth  = new Date(calYear, calMonth + 1, 0).getDate();
  var prevMonthEnd = new Date(calYear, calMonth, 0).getDate();

  for (var i = 0; i < firstDay; i++) {
    var cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = '<div class="cal-date">' + (prevMonthEnd - firstDay + 1 + i) + '</div>';
    grid.appendChild(cell);
  }

  for (var d = 1; d <= daysInMonth; d++) {
    var cell     = document.createElement('div');
    var thisDate = new Date(calYear, calMonth, d);
    var isToday  = thisDate.toDateString() === now.toDateString();
    cell.className = 'cal-cell' + (isToday ? ' today' : '');
    cell.innerHTML = '<div class="cal-date">' + d + '</div>';

    var dayEvents = sources.filter(function(s) {
      return s.parsedDate && s.parsedDate.toDateString() === thisDate.toDateString();
    });
    dayEvents.slice(0, 3).forEach(function(s) {
      var ev = document.createElement('div');
      var evClass = s.urgency === 'urgent' ? 'urgent' : s.urgency === 'soon' ? 'soon' : 'ok';
      ev.className = 'cal-event ' + evClass;
      ev.textContent = s.name;
      ev.title = s.name + (s.tab ? ' (' + s.tab + ')' : '');
      cell.appendChild(ev);
    });
    if (dayEvents.length > 3) {
      var more = document.createElement('div');
      more.className = 'cal-more';
      more.textContent = '+' + (dayEvents.length - 3) + ' more';
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }

  var remaining = 42 - firstDay - daysInMonth;
  for (var j = 1; j <= remaining; j++) {
    var cell2 = document.createElement('div');
    cell2.className = 'cal-cell other-month';
    cell2.innerHTML = '<div class="cal-date">' + j + '</div>';
    grid.appendChild(cell2);
  }
}

function prevMonth() { calMonth--; if (calMonth < 0)  { calMonth = 11; calYear--; } renderCalendar(); }
function nextMonth() { calMonth++; if (calMonth > 11) { calMonth = 0;  calYear++; } renderCalendar(); }

// ── Google Calendar ────────────────────────────────────────────────────────
async function addToCalendar(id) {
  if (!accessToken) { showToast('Connect Google first.'); return; }
  var s = sources.find(function(x) { return x.id === id; });
  if (!s) return;

  var start = s.parsedDate || new Date(now.getTime() + 7 * 86400000);
  var end   = s.rawEndDate ? (parseDate(s.rawEndDate) || new Date(start.getTime() + 3600000)) : new Date(start.getTime() + 3600000);

  var event = {
    summary: '[Squawk] ' + s.name,
    description: ['Type: ' + s.type, 'Tab: ' + (s.tab || ''), s.url ? 'URL: ' + s.url : '', s.notes ? 'Notes: ' + s.notes : ''].filter(Boolean).join('\n'),
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
    var res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    var data = await res.json();
    if (data.id) {
      addedIds.add(id);
      showToast('Added "' + s.name + '" to Calendar');
      renderAll();
    } else {
      showToast('Calendar error: ' + (data.error ? data.error.message : 'Unknown error'));
    }
  } catch (e) {
    showToast('Calendar request failed: ' + e.message);
  }
}

async function addAllToCalendar() {
  var toAdd = sources.filter(function(s) { return !addedIds.has(s.id) && s.urgency !== 'past'; });
  showToast('Adding ' + toAdd.length + ' sources to Calendar...');
  for (var i = 0; i < toAdd.length; i++) {
    await addToCalendar(toAdd[i].id);
    await sleep(300);
  }
  showToast('All sources added to Calendar.');
}

// ── ICS Export ─────────────────────────────────────────────────────────────
function exportIcs() {
  var active = sources.filter(function(s) { return s.urgency !== 'past'; });
  if (!active.length) { showToast('No sources to export.'); return; }

  var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Squawk//Deal Flow Tracker//EN', 'CALSCALE:GREGORIAN'];

  active.forEach(function(s) {
    var start = s.parsedDate || new Date(now.getTime() + 7 * 86400000);
    var end   = s.rawEndDate ? (parseDate(s.rawEndDate) || new Date(start.getTime() + 3600000)) : new Date(start.getTime() + 3600000);
    var fmt   = function(d) { return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'; };
    lines.push(
      'BEGIN:VEVENT',
      'UID:squawk-' + s.id + '-' + Date.now() + '@squawk',
      'DTSTART:' + fmt(start),
      'DTEND:' + fmt(end),
      'SUMMARY:[Squawk] ' + s.name,
      'DESCRIPTION:Type: ' + s.type + '\\nTab: ' + (s.tab || '') + '\\nURL: ' + (s.url || '') + '\\n' + (s.notes || ''),
      'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder: ' + s.name, 'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'squawk-deal-flow.ics';
  a.click();
  showToast('Exported ' + active.length + ' sources as .ics');
}

// ── Demo ───────────────────────────────────────────────────────────────────
function loadDemo() {
  var future = function(days) { return new Date(now.getTime() + days * 86400000); };
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
    { id: 9, name: 'Web Summit Lisbon',                url: 'https://websummit.com',           type: 'event',       rawDate: future(90).toDateString(), parsedDate: future(90), notes: 'Lisbon · Tech · High',            urgency: 'ok',      tab: 'Events' }
  ];
  document.getElementById('connStatus').textContent = 'Demo mode';
  document.getElementById('connStatus').className   = 'conn-status demo';
  showApp();
  renderAll();
  showToast('Demo data loaded — 10 sources across 4 tabs');
}

// ── AI Agents ──────────────────────────────────────────────────────────────
function getApiKey() {
  // Read from all possible sources — variable, input field, or localStorage
  if (anthropicKey) return anthropicKey;
  var inputEl = document.getElementById('anthropicKeyInput');
  if (inputEl && inputEl.value.trim()) {
    anthropicKey = inputEl.value.trim();
    return anthropicKey;
  }
  var saved = loadConfig();
  if (saved.anthropicKey) {
    anthropicKey = saved.anthropicKey;
    return anthropicKey;
  }
  return null;
}

async function callClaude(system, user, btnId, resultId) {
  var btn      = document.getElementById(btnId);
  var result   = document.getElementById(resultId);
  var origText = btn.textContent;
  btn.disabled    = true;
  btn.textContent = 'Running...';
  result.style.display = 'none';

  var key = getApiKey();
  if (!key) {
    result.textContent = 'Please enter your Anthropic API key on the setup screen, or click "API Key" in the header.';
    result.style.display = 'block';
    btn.disabled    = false;
    btn.textContent = origText;
    return;
  }

  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-api-key': key
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: system,
        messages: [{ role: 'user', content: user }]
      })
    });

    var data = await res.json();
    if (data.error) throw new Error(data.error.message);
    result.textContent = data.content && data.content[0] ? data.content[0].text : 'No response received.';
    result.style.display = 'block';

  } catch (e) {
    result.textContent = 'Error: ' + e.message;
    result.style.display = 'block';
  }

  btn.disabled    = false;
  btn.textContent = origText;
}

async function runParseAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }

  var btn = document.getElementById('parseBtn');
  var resultEl = document.getElementById('parseResult');
  btn.disabled = true;
  btn.textContent = 'Enriching...';
  resultEl.style.display = 'none';

  var key = anthropicKey
    || (document.getElementById('anthropicKeyInput') ? document.getElementById('anthropicKeyInput').value.trim() : '')
    || (loadConfig().anthropicKey || '');

  if (!key) {
    resultEl.textContent = 'Please enter your Anthropic API key.';
    resultEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Run agent';
    return;
  }

  // Process in batches of 15 to stay within token limits
  var active = sources.filter(function(s) { return s.urgency !== 'past'; });
  var batch = active.slice(0, 20);

  var systemPrompt = 'You are a deal flow analyst for GForce Ventures, a global pre-seed/seed investor focused on Energy Technologies, DeepTech, Materials AI, SpaceTech, Robotics, and Energy-efficient compute. Today is ' + now.toDateString() + '.\n\nYour job is to find the NEXT KEY DATE for each programme — application open, application deadline, cohort start, demo day, or event date. Use your training knowledge of these specific programmes. For recurring annual programmes, estimate the next occurrence based on historical patterns.\n\nReturn ONLY a valid JSON array. No prose, no markdown.\n\nFormat:\n[\n  {\n    "name": "exact name as given",\n    "next_date": "YYYY-MM-DD or null if truly unknown",\n    "date_label": "e.g. Applications open / Deadline / Event date / Cohort start",\n    "confidence": "high|medium|estimate",\n    "attendees": "for events only: typical attendees/speakers, else null",\n    "insight": "one sharp sentence on deal flow value for GForce"\n  }\n]';

  var sample = batch.map(function(s) {
    return s.name + ' | ' + s.type + ' | ' + (s.url || 'no url') + ' | current date: ' + (s.rawDate || 'none') + ' | tab: ' + (s.tab || '');
  }).join('\n');

  var userPrompt = 'Enrich these ' + batch.length + ' deal flow sources with next key dates and insights. Today: ' + now.toDateString() + '\n\n' + sample;

  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-api-key': key
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: '[' }
        ]
      })
    });

    var data = await res.json();
    if (data.error) throw new Error(data.error.message);
    var text = '[' + (data.content && data.content[0] ? data.content[0].text : '');

    // Extract JSON array
    var jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON returned by agent');
    var enrichments = JSON.parse(jsonMatch[0]);

    // Write enrichments back into sources
    var updated = 0;
    enrichments.forEach(function(e) {
      if (!e.name || !e.next_date) return;
      // Match by name (case-insensitive, trimmed)
      var source = sources.find(function(s) {
        return s.name.trim().toLowerCase() === e.name.trim().toLowerCase();
      });
      if (!source) return;
      var parsed = parseDate(e.next_date);
      if (!parsed) return;
      source.parsedDate = parsed;
      source.rawDate    = e.date_label ? e.date_label + ': ' + e.next_date : e.next_date;
      source.urgency    = getUrgency(parsed);
      if (e.insight)    source.notes = e.insight + (e.attendees ? ' · ' + e.attendees : '');
      if (e.attendees)  source.attendees = e.attendees;
      updated++;
    });

    // Re-render dashboard and calendar with new dates
    renderAll();
    showToast('Enriched ' + updated + ' sources with dates');

    // Show summary in result box
    var summary = enrichments.map(function(e) {
      var conf = e.confidence === 'high' ? '✓' : e.confidence === 'medium' ? '~' : '?';
      return conf + ' ' + e.name + ': ' + (e.next_date || 'unknown') + (e.date_label ? ' (' + e.date_label + ')' : '');
    }).join('\n');
    resultEl.textContent = 'Updated ' + updated + ' of ' + batch.length + ' sources with dates.

' + summary;
    resultEl.style.display = 'block';

  } catch(e) {
    resultEl.textContent = 'Error: ' + e.message;
    resultEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Run agent';
}

// ── Discovery feedback loop ───────────────────────────────────────────────
var DECISIONS_KEY = 'squawk_decisions';

function getDecisions() {
  try { return JSON.parse(localStorage.getItem(DECISIONS_KEY)) || { accepted: {}, rejected: {} }; } catch { return { accepted: {}, rejected: {} }; }
}

function saveDecision(name, decision) {
  var d = getDecisions();
  if (decision === 'accept') { d.accepted[name] = Date.now(); delete d.rejected[name]; }
  else { d.rejected[name] = Date.now(); delete d.accepted[name]; }
  localStorage.setItem(DECISIONS_KEY, JSON.stringify(d));
}

function clearRejected() {
  var d = getDecisions();
  d.rejected = {};
  localStorage.setItem(DECISIONS_KEY, JSON.stringify(d));
  showToast('Rejected list cleared — sources will reappear next time.');
}

async function runDiscoverAgent() {
  var btn = document.getElementById('discoverBtn');
  var resultEl = document.getElementById('discoverResult');
  var cardsEl = document.getElementById('discoverCards');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  cardsEl.innerHTML = '';
  resultEl.style.display = 'none';

  var decisions = getDecisions();
  var rejectedNames = Object.keys(decisions.rejected);
  var acceptedNames = Object.keys(decisions.accepted);
  var existingNames = sources.map(function(s) { return s.name; });
  var allKnown = existingNames.concat(acceptedNames).concat(rejectedNames);

  var key = anthropicKey
    || (document.getElementById('anthropicKeyInput') ? document.getElementById('anthropicKeyInput').value.trim() : '')
    || (loadConfig().anthropicKey || '');

  if (!key) {
    resultEl.textContent = 'Please enter your Anthropic API key on the setup screen.';
    resultEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Find new sources';
    return;
  }

  var systemPrompt = `You are a deal flow sourcing agent for GForce Ventures, a global pre-seed and seed investor.

GFORCE INVESTMENT FOCUS:
- Stage: Pre-seed and Seed
- Sectors: Energy Technologies, DeepTech, Materials AI, SpaceTech, Robotics, Energy-efficient compute
- Geography: GLOBAL (not just UK/EU)
- Check size: €250k–€500k
- Love: Strong technical founders from Tier 1 universities (Oxford, Cambridge, Stanford, ETH Zurich), early paying customers or high-quality pilots, fast TRL progression
- Pass on: No-tech, no climate tech, pre-idea with no MVP, commodity markets with no tech differentiation, green premium businesses

Your job is to suggest deal flow sources (accelerators, fellowships, competitions, grants, events, VC networks) that would surface pre-seed/seed companies matching GForce's thesis globally.

IMPORTANT: Respond ONLY with a valid JSON array, no preamble, no markdown, no explanation outside the JSON.
Format:
[
  {
    "name": "Programme Name",
    "url": "https://...",
    "type": "accelerator|fellowship|competition|grant|event|vc",
    "timing": "e.g. Applications open March–April annually",
    "why": "One sentence on why this surfaces GForce-relevant deal flow",
    "region": "e.g. Global / US / EU / Asia"
  }
]`;

  var userPrompt = 'Suggest 10 high-quality deal flow sources for GForce Ventures that we are NOT already tracking.\n\nAlready tracked or reviewed (do not suggest these):\n' + allKnown.slice(0, 40).join(', ') + '\n\nReturn only the JSON array.';

  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-api-key': key
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: '[' }
        ]
      })
    });

    var data = await res.json();
    if (data.error) throw new Error(data.error.message);
    var text = data.content && data.content[0] ? data.content[0].text : '';

    // Parse JSON — strip markdown fences and extract JSON array robustly
    // Prepend '[' since we used it as assistant prefill
    var cleaned = ('[' + text).replace(/```json|```/g, '').trim();
    // Avoid double '[['
    if (cleaned.startsWith('[[')) cleaned = cleaned.slice(1);

    // If the model returned prose instead of JSON, extract the JSON array from within it
    var jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Fallback: parse markdown into card objects
      var suggestions = parseMarkdownSuggestions(cleaned);
    } else {
      var suggestions = JSON.parse(jsonMatch[0]);
    }

    // Filter out any already rejected ones (safety net)
    suggestions = suggestions.filter(function(s) { return !decisions.rejected[s.name]; });

    if (!suggestions.length) {
      resultEl.textContent = 'No new suggestions found — try clearing the rejected list.';
      resultEl.style.display = 'block';
    } else {
      renderSuggestionCards(suggestions, cardsEl);
    }

  } catch (e) {
    resultEl.textContent = 'Error: ' + e.message;
    resultEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Find new sources';
}

// Fallback: parse markdown-formatted suggestions into card objects
function parseMarkdownSuggestions(text) {
  var suggestions = [];
  var blocks = text.split(/(?=##\s|\*\*\d+\.|\n\d+\.\s)/);
  blocks.forEach(function(block) {
    block = block.trim();
    if (!block) return;
    var lines = block.split('\n');
    var nameLine = lines[0].replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^\d+\.\s*/, '').trim();
    if (!nameLine || nameLine.length < 3) return;
    var urlMatch = block.match(/https?:\/\/[^\s)\]]+/);
    var url = urlMatch ? urlMatch[0].replace(/[.,)]+$/, '') : '';
    var typeMatch = block.match(/[Tt]ype[:\s]+([^\n-]+)/);
    var type = 'accelerator';
    if (typeMatch) {
      var t = typeMatch[1].toLowerCase();
      if (t.includes('fellow')) type = 'fellowship';
      else if (t.includes('compet') || t.includes('prize')) type = 'competition';
      else if (t.includes('grant')) type = 'grant';
      else if (t.includes('event') || t.includes('summit')) type = 'event';
      else if (t.includes('vc') || t.includes('venture')) type = 'vc';
    }
    var timingMatch = block.match(/[Tt]iming[:\s]+([^\n-]+)/);
    var timing = timingMatch ? timingMatch[1].replace(/\*\*/g, '').trim() : '';
    var whyMatch = block.match(/[Ww]hy[^:]*:[:\s]+([^\n]+)/);
    var why = whyMatch ? whyMatch[1].replace(/\*\*/g, '').trim() : lines[lines.length - 1].replace(/\*\*/g, '').trim();
    suggestions.push({ name: nameLine, url: url, type: type, timing: timing, why: why, region: 'Global' });
  });
  return suggestions;
}

function renderSuggestionCards(suggestions, container) {
  container.innerHTML = '';
  suggestions.forEach(function(s) {
    var card = document.createElement('div');
    card.className = 'suggestion-card';
    card.id = 'scard-' + encodeURIComponent(s.name);
    card.innerHTML =
      '<div class="suggestion-body">' +
        '<div class="suggestion-name">' + esc(s.name) + ' <span style="font-size:11px;color:#aaa;font-weight:400">' + esc(s.region || '') + '</span></div>' +
        '<div class="suggestion-meta">' +
          (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + shortUrl(s.url) + '</a> · ' : '') +
          '<span class="tag type-' + esc(s.type) + '" style="font-size:11px;padding:1px 7px;border-radius:20px;">' + esc(s.type) + '</span>' +
          (s.timing ? ' · ' + esc(s.timing) : '') +
        '</div>' +
        '<div class="suggestion-reason">' + esc(s.why) + '</div>' +
        '<div class="suggestion-actions">' +
          '<button class="btn btn-sm btn-accept" onclick="acceptSuggestion(' + JSON.stringify(s).replace(/"/g, '&quot;') + ')">✓ Add to dashboard</button>' +
          '<button class="btn btn-sm btn-reject" onclick="rejectSuggestion(' + JSON.stringify(s.name).replace(/"/g, '&quot;') + ')">✗ Not relevant</button>' +
        '</div>' +
      '</div>';
    container.appendChild(card);
  });
}

function acceptSuggestion(s) {
  saveDecision(s.name, 'accept');
  // Add to live sources list
  var newSource = {
    id: sources.length + Date.now(),
    name: s.name,
    url: s.url || '',
    type: s.type || 'other',
    rawDate: '',
    parsedDate: null,
    notes: s.why || '',
    urgency: 'unknown',
    tab: 'Discovered'
  };
  sources.push(newSource);
  renderAll();
  showToast('Added "' + s.name + '" to dashboard');
  // Mark card as accepted
  var card = document.getElementById('scard-' + encodeURIComponent(s.name));
  if (card) {
    card.classList.add('accepted');
    card.querySelector('.suggestion-actions').innerHTML = '<span style="font-size:12px;color:#1a7a45;font-weight:500">✓ Added to dashboard</span>';
  }
}

function rejectSuggestion(name) {
  saveDecision(name, 'reject');
  var card = document.getElementById('scard-' + encodeURIComponent(name));
  if (card) {
    card.style.transition = 'opacity 0.3s';
    card.style.opacity = '0';
    setTimeout(function() { card.style.display = 'none'; }, 300);
  }
  showToast('Dismissed — won\'t appear again');
}

function runDigestAgent() {
  if (!sources.length) { showToast('Load your sheet first.'); return; }
  var upcoming = sources
    .filter(function(s) { return s.urgency === 'urgent' || s.urgency === 'soon'; })
    .map(function(s) { return '- ' + s.name + ' (' + s.type + ', ' + (s.tab || '') + ') — ' + daysLabel(s) + (s.url ? ' — ' + s.url : ''); })
    .join('\n');
  var total = sources.filter(function(s) { return s.urgency !== 'past'; }).length;
  callClaude(
    'You are a VC analyst. Write concise, professional weekly deal flow digest emails. Tone: clear, direct, no fluff.',
    'Write a weekly deal flow digest. Total tracked: ' + total + '.\n\nUpcoming (next 30 days):\n' + (upcoming || 'None with confirmed dates.') + '\n\nInclude: subject line, brief intro, structured list grouped by urgency, recommended actions this week.',
    'digestBtn', 'digestResult'
  );
}

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(name) {
  var tabs = ['dashboard', 'calendar', 'agent'];
  document.querySelectorAll('.tab').forEach(function(t, i) {
    t.classList.toggle('active', tabs[i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'calendar') renderCalendar();
}

// ── Toast ──────────────────────────────────────────────────────────────────
var toastTimer;
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.classList.add('hidden'); }, 3500);
}

// ── Utils ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
