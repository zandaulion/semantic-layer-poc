import { installUpdates } from '/pwa-update.js';

const $ = (id) => document.getElementById(id);
const state = { working: false, dirty: false, persisted: false, restoring: false, lastResult: null, installPrompt: null };
const DRAFT_KEY = 'banking-poc:workspace-v1';
const fields = ['statement', 'tables', 'syntax', 'columns', 'business', 'execution'];
const names = { statement: 'Read-only shape', tables: 'Table references', syntax: 'SQL syntax', columns: 'Column references', business: 'Business meaning', execution: 'Execution' };

function flash(message, good = false) {
  const node = $('flash');
  node.textContent = message;
  node.classList.toggle('good', good);
  node.hidden = !message;
}

function saveWorkspace() {
  if (state.restoring) return;
  try {
    const draft = {
      question: $('question').value,
      sql: $('sql-editor').value,
      domain: $('domain-select').value,
      result: state.lastResult,
    };
    if (draft.question || draft.sql) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
    state.persisted = true;
  } catch {
    state.persisted = false;
  }
}

function restoreWorkspace() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (!draft || typeof draft !== 'object') return;
    state.restoring = true;
    $('question').value = String(draft.question || '').slice(0, 1000);
    if ([...$('domain-select').options].some((option) => option.value === draft.domain)) $('domain-select').value = draft.domain;
    if (draft.result && typeof draft.result.status === 'string') {
      renderDraft(draft.result);
      if (draft.result.status === 'needs_clarification') {
        $('clarification-answer').placeholder = /^Which year/i.test(draft.result.clarification_question || '') ? 'e.g. 2026' : 'Add the missing detail';
        $('clarification-reply').hidden = false;
        flash(draft.result.clarification_question || 'One more detail is needed before drafting SQL.');
      }
    }
    $('sql-editor').value = String(draft.sql || '').slice(0, 20_000);
    $('sql-length').textContent = `${$('sql-editor').value.length} characters`;
    state.dirty = Boolean($('sql-editor').value);
    if (state.dirty && $('sql-editor').value !== (draft.result?.sql || '')) {
      renderChecks();
      resultStatus('Restored edited draft · check again', 'warn');
    }
  } catch {
    state.persisted = false;
  } finally {
    state.restoring = false;
  }
  saveWorkspace();
}

function showGate(message = '') {
  $('workspace').hidden = true;
  $('gate').hidden = false;
  $('gate-message').textContent = message;
}

function showWorkspace(device) {
  $('gate').hidden = true;
  $('workspace').hidden = false;
  $('device-name').textContent = device?.label || 'Registered device';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 401) {
    showGate('This device is no longer registered. Enter a new invite code.');
    throw new Error('This device is no longer registered.');
  }
  if (!response.ok) throw new Error(payload.message || payload.error?.replaceAll('_', ' ') || `Request failed (${response.status})`);
  return payload;
}

function setWorking(working) {
  state.working = working;
  for (const id of ['find-button', 'generate-button', 'check-button', 'clarification-continue']) $(id).disabled = working;
  $('generate-button').textContent = working ? 'Working…' : 'Generate draft ↗';
}

function renderContext(tables = []) {
  const list = $('context-list');
  list.replaceChildren();
  $('context-empty').hidden = tables.length > 0;
  for (const table of tables) {
    const item = document.createElement('div');
    item.className = 'context-item';
    const name = document.createElement('div');
    name.className = 'context-name';
    name.textContent = `bank_dwh.${table.table_name}`;
    const detail = document.createElement('div');
    detail.className = 'context-detail';
    detail.textContent = `${table.domain_id || 'banking'} · ${table.table_type || 'table'} · ${table.grain || ''}`;
    item.append(name, detail);
    list.append(item);
  }
}

function renderChecks(checks) {
  const list = $('checks-list');
  list.replaceChildren();
  if (!checks) {
    const empty = document.createElement('span');
    empty.className = 'empty-copy';
    empty.textContent = 'Generate or check a draft to see findings.';
    list.append(empty);
    return;
  }
  for (const field of fields) {
    if (!checks[field]) continue;
    const row = document.createElement('div');
    row.className = 'check-row';
    const label = document.createElement('span');
    label.textContent = names[field];
    const value = document.createElement('strong');
    value.className = `check-value ${checks[field] === 'failed' ? 'bad' : checks[field] === 'passed' ? '' : 'warn'}`;
    value.textContent = checks[field].replaceAll('_', ' ');
    row.append(label, value);
    list.append(row);
  }
  if (checks.findings?.length) {
    const findings = document.createElement('ul');
    findings.className = 'check-findings';
    for (const finding of checks.findings) {
      const li = document.createElement('li');
      li.textContent = finding;
      findings.append(li);
    }
    list.append(findings);
  }
}

function resultStatus(message, tone = 'neutral') {
  $('result-status').textContent = message;
  $('result-status').className = `result-status ${tone}`;
}

function renderDraft(result) {
  state.lastResult = result;
  $('sql-editor').value = result.sql || '';
  $('sql-length').textContent = `${$('sql-editor').value.length} characters`;
  state.dirty = Boolean(result.sql);
  $('interpretation').textContent = result.interpretation || 'No interpretation supplied.';
  const assumptions = $('assumptions');
  assumptions.replaceChildren();
  for (const assumption of result.assumptions || []) {
    const li = document.createElement('li');
    li.textContent = assumption;
    assumptions.append(li);
  }
  $('clarification').hidden = !result.clarification_question;
  $('clarification').textContent = result.clarification_question || '';
  $('sources').textContent = result.sources?.length ? `Sources: ${result.sources.join(', ')}` : '';
  renderContext(result.retrieved_tables || []);
  renderChecks(result.checks);
  const statuses = {
    draft: ['Draft ready for review', 'good'],
    needs_revision: ['Draft needs revision', 'warn'],
    needs_clarification: ['Clarification needed', 'warn'],
    unsupported: ['Request unsupported by this catalog', 'warn'],
  };
  resultStatus(...(statuses[result.status] || ['No draft returned', 'warn']));
  saveWorkspace();
}

async function loadMetadata() {
  const [status, domainResult] = await Promise.all([api('/api/status'), api('/api/domains')]);
  $('elastic-status').textContent = status.elasticsearch.available ? `Online · ${status.elasticsearch.status}` : 'Unavailable';
  $('elastic-status').classList.toggle('bad', !status.elasticsearch.available);
  $('model-status').textContent = status.model_configured ? 'Configured' : 'Needs API key';
  $('model-status').classList.toggle('bad', !status.model_configured);
  const select = $('domain-select');
  select.replaceChildren(new Option('All banking domains', 'all'));
  for (const domain of domainResult.domains || []) select.add(new Option(domain.replaceAll('_', ' '), domain));
}

async function findTables() {
  const question = $('question').value.trim();
  if (question.length < 2) return flash('Enter a question with at least two characters.');
  flash('');
  setWorking(true);
  try {
    const params = new URLSearchParams({ q: question, domain: $('domain-select').value });
    const result = await api(`/api/search?${params}`);
    renderContext(result.tables);
    flash(result.tables.length ? `Found ${result.tables.length} candidate tables. Review their grain before generating SQL.` : 'No matching tables found.', true);
  } catch (error) { flash(error.message); }
  finally { setWorking(false); }
}

async function generate() {
  const question = $('question').value.trim();
  if (question.length < 5) return flash('Describe the query in at least five characters.');
  flash('');
  $('clarification-reply').hidden = true;
  saveWorkspace();
  setWorking(true);
  resultStatus('Retrieving metadata and drafting…');
  try {
    const result = await api('/api/generate', {
      method: 'POST', body: JSON.stringify({ question, domain: $('domain-select').value, previous_sql: $('sql-editor').value }),
    });
    renderDraft(result);
    if (result.status === 'draft') {
      flash('SQL draft ready. Review the SQL and assumptions before using it.', true);
      $('draft-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (result.status === 'needs_revision') {
      flash('The model returned SQL, but a basic check needs review. See the draft and checks below.');
      $('draft-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (result.status === 'needs_clarification') {
      flash(result.clarification_question || 'One more detail is needed before drafting SQL.');
      $('clarification-answer').value = '';
      $('clarification-answer').placeholder = /^Which year/i.test(result.clarification_question || '') ? 'e.g. 2026' : 'Add the missing detail';
      $('clarification-reply').hidden = false;
    } else if (result.status === 'unsupported') {
      flash(result.interpretation || 'The synthetic catalog does not support this request.');
    } else {
      flash('No SQL draft was returned. Try a more specific question.');
    }
  } catch (error) {
    resultStatus('Draft unavailable', 'bad');
    flash(error.message);
  } finally { setWorking(false); }
}

async function checkDraft() {
  const sql = $('sql-editor').value;
  if (!sql.trim()) return flash('Enter or generate SQL before checking it.');
  flash('');
  setWorking(true);
  try {
    const result = await api('/api/check', { method: 'POST', body: JSON.stringify({ sql }) });
    renderChecks(result.checks);
    resultStatus(result.checks.statement === 'passed' ? 'Basic checks completed' : 'Review required', result.checks.statement === 'passed' ? 'good' : 'warn');
    flash('These checks do not verify syntax, columns, business meaning, or execution.', true);
  } catch (error) { flash(error.message); }
  finally { setWorking(false); }
}

function updateNetwork() {
  $('network-indicator').classList.toggle('offline', !navigator.onLine);
  $('network-indicator').lastChild.textContent = navigator.onLine ? 'Online' : 'Offline';
  if (!navigator.onLine) flash('You are offline. Cached app shell may open, but search and drafting require the server.');
}

async function boot() {
  const invite = new URL(location.href).searchParams.get('invite');
  if (invite) {
    history.replaceState(null, '', location.pathname + location.hash);
    $('invite-code').value = invite;
  }
  updateNetwork();
  addEventListener('online', updateNetwork);
  addEventListener('offline', updateNetwork);
  installUpdates({ appName: 'Bank DWH Studio', isBusy: () => state.working || ((state.dirty || Boolean($('question').value.trim())) && !state.persisted) });
  try {
    const session = await api('/api/auth/session');
    if (session.authenticated) { showWorkspace(session.device); await loadMetadata(); restoreWorkspace(); }
    else showGate(invite ? 'Invite code ready. Activate this device to continue.' : '');
  } catch (error) { showGate('Cannot reach the server. Reconnect and reload this page.'); }
}

$('invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $('gate-message').textContent = 'Activating…';
  try {
    const result = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: $('invite-code').value, label: $('device-label').value }) });
    $('invite-code').value = '';
    showWorkspace(result.device);
    await loadMetadata();
    restoreWorkspace();
  } catch (error) { $('gate-message').textContent = error.message; }
  finally { button.disabled = false; }
});
$('find-button').addEventListener('click', findTables);
$('generate-button').addEventListener('click', generate);
$('clarification-reply').addEventListener('submit', (event) => {
  event.preventDefault();
  const answer = $('clarification-answer').value.trim();
  if (!answer) return;
  $('question').value += /^\d{4}$/.test(answer) ? ` ${answer}` : `\nClarification: ${answer}`;
  saveWorkspace();
  generate();
});
$('check-button').addEventListener('click', checkDraft);
$('copy-button').addEventListener('click', async () => {
  const sql = $('sql-editor').value;
  if (!sql.trim()) return flash('There is no SQL to copy.');
  try { await navigator.clipboard.writeText(sql); flash('SQL copied to clipboard.', true); }
  catch { flash('Clipboard access failed. Select the SQL and copy it manually.'); }
});
$('clear-button').addEventListener('click', () => {
  $('question').value = '';
  $('sql-editor').value = '';
  $('sql-length').textContent = '0 characters';
  $('interpretation').textContent = 'Interpretation and assumptions will appear here.';
  $('assumptions').replaceChildren();
  $('sources').textContent = '';
  $('clarification').hidden = true;
  $('clarification-reply').hidden = true;
  state.lastResult = null;
  renderContext();
  renderChecks();
  resultStatus('Waiting for a question');
  flash('');
  state.dirty = false;
  saveWorkspace();
});
$('question').addEventListener('input', saveWorkspace);
$('domain-select').addEventListener('change', saveWorkspace);
$('sql-editor').addEventListener('input', () => {
  state.dirty = Boolean($('sql-editor').value);
  $('sql-length').textContent = `${$('sql-editor').value.length} characters`;
  renderChecks();
  resultStatus('Edited draft · check again', 'warn');
  saveWorkspace();
});
for (const button of document.querySelectorAll('.sample-question')) button.addEventListener('click', () => {
  $('question').value = button.dataset.question;
  $('domain-select').value = button.dataset.domain || 'all';
  saveWorkspace();
  $('question').focus();
});
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  $('install-button').hidden = false;
});
$('install-button').addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  $('install-button').hidden = true;
});
boot();
