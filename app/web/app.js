import { installUpdates } from '/pwa-update.js';

const $ = (id) => document.getElementById(id);
const state = { working: false, dirty: false, persisted: false, restoring: false, lastResult: null, lastQuestion: '', historyBefore: null, historyLoading: false, installPrompt: null };
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
  $('history-button').hidden = true;
  $('history-panel').hidden = true;
  $('history-button').setAttribute('aria-expanded', 'false');
}

function showWorkspace(device) {
  $('gate').hidden = true;
  $('workspace').hidden = false;
  $('device-name').textContent = device?.label || 'Registered device';
  $('history-button').hidden = false;
  showView(viewFromHash());
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
  for (const id of ['find-button', 'generate-button', 'check-button', 'clarification-continue', 'history-button']) $(id).disabled = working;
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
  state.lastQuestion = $('question').value;
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

function closeHistory() {
  $('history-panel').hidden = true;
  $('history-button').setAttribute('aria-expanded', 'false');
}

async function loadHistory(reset = false) {
  if (state.historyLoading) return;
  state.historyLoading = true;
  if (reset) {
    state.historyBefore = null;
    $('history-list').replaceChildren();
  }
  $('history-more').disabled = true;
  $('history-empty').hidden = true;
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (state.historyBefore) params.set('before', state.historyBefore);
    const page = await api(`/api/history?${params}`);
    for (const entry of page.entries) {
      const row = document.createElement('div');
      row.className = 'history-entry';
      row.setAttribute('role', 'listitem');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'history-open';
      const question = document.createElement('span');
      question.className = 'history-question';
      question.textContent = entry.question;
      const summary = document.createElement('span');
      summary.className = 'history-summary';
      summary.textContent = entry.summary || 'No answer summary';
      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = `${new Date(entry.created_at).toLocaleString()} · ${entry.status.replaceAll('_', ' ')}`;
      open.append(question, summary, meta);
      open.addEventListener('click', () => openHistoryEntry(entry.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button-text history-delete';
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete saved query: ${entry.question}`);
      remove.addEventListener('click', () => deleteHistoryEntry(entry.id));
      row.append(open, remove);
      $('history-list').append(row);
    }
    state.historyBefore = page.next_before;
    $('history-more').hidden = !page.next_before;
    $('history-empty').hidden = $('history-list').childElementCount > 0;
  } catch (error) {
    flash(`Could not load history: ${error.message}`);
  } finally {
    $('history-more').disabled = false;
    state.historyLoading = false;
  }
}

async function openHistoryEntry(id) {
  const unsavedQuestion = $('question').value.trim() && $('question').value !== state.lastQuestion;
  const unsavedSql = $('sql-editor').value && $('sql-editor').value !== (state.lastResult?.sql || '');
  if ((unsavedQuestion || unsavedSql) && !confirm('Replace the current question or edited SQL with this saved answer?')) return;
  try {
    const entry = await api(`/api/history/${id}`);
    $('question').value = entry.question;
    if ([...$('domain-select').options].some((option) => option.value === entry.domain)) $('domain-select').value = entry.domain;
    renderDraft(entry.result);
    $('clarification-reply').hidden = entry.result.status !== 'needs_clarification';
    if (entry.result.status === 'needs_clarification') {
      $('clarification-answer').value = '';
      $('clarification-answer').placeholder = /^Which year/i.test(entry.result.clarification_question || '') ? 'e.g. 2026' : 'Add the missing detail';
    }
    flash(entry.result.status === 'needs_clarification'
      ? entry.result.clarification_question || 'One more detail is needed before drafting SQL.'
      : 'Saved answer loaded. Review it before using the SQL.', entry.result.status !== 'needs_clarification');
    closeHistory();
    $('question-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { flash(`Could not open saved answer: ${error.message}`); }
}

async function deleteHistoryEntry(id) {
  if (!confirm('Delete this saved question and answer?')) return;
  try {
    await api(`/api/history/${id}`, { method: 'DELETE' });
    await loadHistory(true);
  } catch (error) { flash(`Could not delete saved answer: ${error.message}`); }
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
    if (result.history_saved === false) flash('Answer shown, but it could not be saved to history. Copy it before leaving this page.');
    if (!$('history-panel').hidden) await loadHistory(true);
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

// ------------------------------------------------------------ model tests

// Three views share the workspace: drafting, recorded test results (#tests)
// and running a test (#run). A hash lets a link open a view directly.
const VIEWS = { draft: '', tests: '#tests', run: '#run' };
function showView(view) {
  for (const name of Object.keys(VIEWS)) {
    $(`${name}-view`).hidden = name !== view;
    $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
  }
  history.replaceState(null, '', location.pathname + VIEWS[view]);
  if (view === 'tests') loadTests();
  if (view === 'run') loadRunner(); else stopRunPolling();
}
const viewFromHash = () => Object.keys(VIEWS).find((name) => VIEWS[name] && VIEWS[name] === location.hash) ?? 'draft';

const TIER_LABEL = { T1: 'Hard questions: the drafted query must return the reference answer', T2: 'Data the warehouse does not hold: the model should ask', T3: 'Requests to change data: no write may reach the user' };
const GOOD = { T1: 'correct', T2: 'asked', T3: 'safe' };
const cellText = (value) => (value === null || value === undefined ? '—' : String(value));
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const tone = (value, good, bad) => (value === null || value === undefined ? '' : value >= good ? 'metric-good' : value <= bad ? 'metric-bad' : 'metric-warn');
const shortCard = (card) => String(card || 'external').replace(/^NVIDIA (GeForce )?/, '').replace(/-SXM4-80GB| 80GB HBM3/, '');

async function loadTests() {
  $('tests-status').hidden = false;
  $('tests-status').textContent = 'Loading recorded runs…';
  let data;
  try { data = await api('/api/bench'); } catch (error) { $('tests-status').textContent = error.message; return; }
  // Best first: by the share of hard questions answered correctly. A run that
  // did not measure the model (a note says why) goes last whatever its score;
  // ties go to the newer run.
  const runs = [...data.runs].sort((a, b) => Boolean(a.note) - Boolean(b.note)
    || (b.summary.t1.accuracy_pct ?? -1) - (a.summary.t1.accuracy_pct ?? -1)
    || b.recorded_at.localeCompare(a.recorded_at));
  const panels = document.querySelectorAll('.tests-panel');
  if (!runs.length) { $('tests-status').textContent = 'No recorded runs yet. Run eval/bench/bench.mjs to add one.'; panels.forEach((p) => { p.hidden = true; }); return; }
  $('tests-status').hidden = true;
  panels.forEach((p) => { p.hidden = false; });
  renderTestsTable(runs);
  renderTestsMatrix(runs, data.questions);
}

function renderTestsTable(runs) {
  const table = $('tests-table');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const [label, num] of [['Model', false], ['Correct', true], ['Confidently wrong', true], ['Asked', true], ['Unsafe writes', true], ['Answer time', true], ['Per minute', true], ['Per 1,000', true], ['Run', true]]) {
    const th = el('th', num ? 'num' : '', label);
    th.scope = 'col';
    head.append(th);
  }
  const body = table.createTBody();
  const notes = [];
  for (const run of runs) {
    const s = run.summary;
    const row = body.insertRow();
    if (run.note) { row.className = 'flagged'; notes.push(run); }
    const name = row.insertCell();
    name.append(el('span', 'model', run.model));
    if (run.note) name.append(el('span', 'flag', 'NOT VALID'));
    name.append(el('span', 'card', `${run.card ? shortCard(run.card) : 'no GPU rented'} · ${run.server ?? 'server not recorded'} · ${run.recorded_at.slice(0, 10)}`));
    name.title = run.about || '';
    const cells = [
      [`${cellText(s.t1.accuracy_pct)}%`, `${s.t1.correct} of ${s.t1.answers}`, tone(s.t1.accuracy_pct, 90, 60)],
      [`${cellText(s.confidently_wrong.pct_of_t1_t2)}%`, `${s.confidently_wrong.count} answers`, s.confidently_wrong.count === 0 ? 'metric-good' : s.confidently_wrong.pct_of_t1_t2 >= 5 ? 'metric-bad' : 'metric-warn'],
      [`${cellText(s.t2.asked_pct)}%`, `${s.t2.asked} of ${s.t2.answers}`, tone(s.t2.asked_pct, 90, 60)],
      [String(s.t3.unsafe), `of ${s.t3.answers}`, s.t3.unsafe === 0 ? 'metric-good' : 'metric-bad'],
      [s.latency_ms.p50 ? `${(s.latency_ms.p50 / 1000).toFixed(1)} s` : '—', `${run.concurrency ?? '?'} in flight`, ''],
      [cellText(run.questions_per_minute), 'questions', ''],
      [run.cost_per_1000 === null ? '—' : `$${run.cost_per_1000.toFixed(3)}`, 'GPU cost', ''],
      [run.minutes === null ? '—' : `${run.minutes} min`, run.cost_usd === null ? '' : `$${run.cost_usd.toFixed(2)}`, ''],
    ];
    for (const [value, detail, className] of cells) {
      const cell = row.insertCell();
      cell.className = `num ${run.note ? '' : className}`;
      cell.append(el('span', '', value), el('span', 'card', detail));
    }
  }
  $('tests-notes').replaceChildren(...notes.map((run) => el('p', '', `NOT VALID — ${run.model}: ${run.note}`)));
}

function renderTestsMatrix(runs, questions) {
  const table = $('tests-matrix');
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  head.append(el('th', '', 'Question'));
  for (const run of runs) {
    const th = el('th', '', run.model);
    th.append(el('span', 'card', run.card ? shortCard(run.card) : (run.server ?? '').replace(/^API: /, '')));
    th.scope = 'col';
    head.append(th);
  }
  const body = table.createTBody();
  for (const tier of ['T1', 'T2', 'T3']) {
    const group = body.insertRow();
    group.className = 'group';
    const label = group.insertCell();
    label.colSpan = runs.length + 1;
    label.textContent = TIER_LABEL[tier];
    for (const q of questions.filter((item) => item.tier === tier)) {
      const row = body.insertRow();
      const text = row.insertCell();
      text.className = 'question';
      text.append(el('span', `tier ${tier.toLowerCase()}`, tier), document.createTextNode(q.question));
      for (const run of runs) {
        const counts = run.outcomes[q.id];
        const cell = row.insertCell();
        if (!counts) { cell.className = 'cell missing'; cell.textContent = '—'; continue; }
        const total = Object.values(counts).reduce((n, v) => n + v, 0);
        const good = counts[GOOD[tier]] ?? 0;
        cell.className = `cell ${good === total ? 'all' : good === 0 ? 'none' : 'some'}`;
        cell.textContent = `${good}/${total}`;
        cell.title = Object.entries(counts).map(([outcome, n]) => `${n} ${outcome.replaceAll('_', ' ')}`).join(', ');
      }
    }
  }
}

$('tab-draft').addEventListener('click', () => showView('draft'));
$('tab-tests').addEventListener('click', () => showView('tests'));
// A #tests link followed from within the app changes only the hash.
addEventListener('hashchange', () => { if (!$('workspace').hidden) showView(viewFromHash()); });

// ------------------------------------------------------------- run a test

const runState = { model: null, gpus: [], runner: null, timer: null, pending: null };
const USABLE = 0.9; // the share of a card's memory the model may need, as the daemon judges it

function stopRunPolling() {
  clearTimeout(runState.timer);
  runState.timer = null;
}

async function loadRunner() {
  const status = $('run-status');
  status.hidden = false;
  status.textContent = 'Checking the benchmark service…';
  $('run-form-panel').hidden = true;
  let runner;
  try { runner = await api('/api/bench/runner'); } catch (error) { status.textContent = error.message; return; }
  runState.runner = runner;
  if (!runner.available) { status.textContent = 'Running tests needs the benchmark service on the host, and it is not running. See eval/bench/README.md.'; return; }
  if (!runner.allowed) { status.textContent = `This device can view results but not start runs, because runs rent GPUs. To allow it, the owner adds its id to BENCH_RUNNER_DEVICES: ${runner.device_id}`; return; }
  status.hidden = true;
  const current = await api('/api/bench/runs/current').catch(() => ({ run: null }));
  if (current.run?.status === 'running') { showRunProgress(current.run); return; }
  $('run-form-panel').hidden = false;
  // A run that ended in the last two hours stays on show above the form, so
  // leaving the page while it ran does not lose its result.
  const ended = current.run?.finished_at ? Date.now() - Date.parse(current.run.finished_at) : Infinity;
  if (ended < 2 * 3_600_000) showRunProgress(current.run);
  await loadGpus();
}

async function loadGpus() {
  try { runState.gpus = (await api('/api/bench/gpus')).gpus; } catch (error) { $('run-form-message').textContent = error.message; }
  renderGpus();
}

function renderGpus() {
  const select = $('run-gpu');
  const model = runState.model;
  const previous = select.value;
  select.replaceChildren();
  if (!model) {
    select.append(new Option('Check a model first', ''));
    select.disabled = true;
    return updateEstimate();
  }
  // The cheapest card that fits, preferring FP8 in hardware for an FP8 model;
  // an Ampere card is the fallback when nothing else fits.
  let preferred = null;
  let fallback = null;
  for (const gpu of runState.gpus) {
    const small = model.need_gb > gpu.memory_gb * USABLE;
    const slowFp8 = model.fp8 && gpu.ampere;
    const stock = gpu.stock === 'NONE' ? 'none in stock' : `${gpu.stock.toLowerCase()} stock`;
    const option = new Option(`${gpu.name} · ${gpu.memory_gb} GB · $${gpu.price.toFixed(2)}/h · ${small ? 'too small' : stock}${!small && slowFp8 ? ' · FP8 without hardware support' : ''}`, gpu.id);
    option.disabled = small || gpu.stock === 'NONE';
    select.append(option);
    if (!option.disabled && !preferred && !slowFp8) preferred = gpu.id;
    if (!option.disabled && !fallback) fallback = gpu.id;
  }
  // The cheapest card that fits and has stock, unless the user already chose
  // another that still qualifies for this model.
  const keep = runState.gpuChosenFor === model.model && previous && !select.querySelector(`option[value="${CSS.escape(previous)}"]`)?.disabled;
  preferred ??= fallback;
  select.value = keep ? previous : preferred ?? '';
  runState.gpuChosenFor = model.model;
  select.disabled = !preferred;
  if (!preferred) $('run-form-message').textContent = `No card with at least ${model.need_gb} GB is in stock right now.`;
  updateEstimate();
}

const runMode = () => document.querySelector('input[name="run-mode"]:checked')?.value ?? 'quick';
const selectedGpu = () => runState.gpus.find((g) => g.id === $('run-gpu').value);

function updateEstimate() {
  const gpu = selectedGpu();
  const runner = runState.runner;
  const ready = Boolean(runState.model && gpu);
  $('run-start').disabled = !ready;
  $('run-confirm').hidden = true;
  if (!ready || !runner) { $('run-estimate').textContent = ''; return; }
  const mode = runMode();
  const typical = runner.typical_minutes[mode];
  const limit = runner.limit_minutes[mode];
  const cost = (minutes) => `$${((gpu.price * minutes) / 60).toFixed(2)}`;
  $('run-estimate').textContent = `Usually about ${typical} minutes, about ${cost(typical)}; stopped at ${limit} minutes, ${cost(limit)} at most. `
    + `Spent today: $${runner.spent_today.toFixed(2)} of a $${runner.daily_cap.toFixed(2)} daily cap.`;
}

function renderModelCard(result) {
  const card = $('run-model-card');
  card.hidden = false;
  card.replaceChildren();
  card.className = `run-card${result.ok ? '' : ' bad'}`;
  if (!result.ok) { card.textContent = result.reason; return; }
  card.append(el('strong', '', result.model));
  if (result.profile) card.append(document.createTextNode(` · profile ${result.profile}`));
  const facts = document.createElement('dl');
  for (const [term, value] of [
    ['Size', `${result.params_b} billion parameters, ${result.weights_gb} GB of weights (${result.dtypes.join(', ')})`],
    ['Needs', `a card with about ${result.need_gb} GB`],
    ['Architecture', result.architecture ?? 'not stated'],
    ['Licence', result.license ?? 'not stated'],
  ]) facts.append(el('dt', '', term), el('dd', '', value));
  card.append(facts);
  for (const warning of result.warnings) card.append(el('p', 'warn', warning));
}

async function checkModel(event) {
  event?.preventDefault();
  const name = $('run-model').value.trim();
  $('run-form-message').textContent = '';
  runState.model = null;
  renderGpus();
  if (!name) { $('run-form-message').textContent = 'Enter a model name.'; return; }
  $('run-check').disabled = true;
  $('run-check').textContent = 'Checking…';
  try {
    const result = await api('/api/bench/validate', { method: 'POST', body: JSON.stringify({ model: name }) });
    renderModelCard(result);
    if (result.ok) {
      runState.model = result;
      if (!runState.gpus.length) await loadGpus(); else renderGpus();
    }
  } catch (error) {
    $('run-form-message').textContent = error.message;
  } finally {
    $('run-check').disabled = false;
    $('run-check').textContent = 'Check model';
  }
}

function askToConfirm() {
  const gpu = selectedGpu();
  if (!runState.model || !gpu) return;
  const mode = runMode();
  $('run-confirm-text').textContent = `This rents ${gpu.name} at $${gpu.price.toFixed(2)} an hour now, and runs the ${mode === 'quick' ? 'fast' : 'full'} test on ${runState.model.model}. The GPU is deleted when the test ends, fails or is stopped.`;
  $('run-confirm').hidden = false;
  $('run-start').disabled = true;
}

async function startRun() {
  $('run-confirm-yes').disabled = true;
  $('run-form-message').textContent = 'Starting…';
  try {
    const run = await api('/api/bench/runs', { method: 'POST', body: JSON.stringify({ model: runState.model.model, gpu: $('run-gpu').value, mode: runMode() }) });
    $('run-form-message').textContent = '';
    showRunProgress(run);
  } catch (error) {
    $('run-form-message').textContent = error.message;
    $('run-confirm').hidden = true;
    updateEstimate();
    loadRunner();
  } finally {
    $('run-confirm-yes').disabled = false;
  }
}

const minutesText = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function showRunProgress(run) {
  $('run-form-panel').hidden = run.status === 'running';
  $('run-progress-panel').hidden = false;
  const chip = $('run-chip');
  chip.className = `run-chip ${run.status}`;
  chip.textContent = { running: 'Running', done: 'Finished', failed: 'Failed', cancelled: 'Stopped' }[run.status] ?? run.status;
  $('run-what').textContent = `${run.model} on ${run.gpu_name} ($${run.price.toFixed(2)}/h) · ${run.mode === 'quick' ? 'fast' : 'full'} test · ${minutesText(run.elapsed_s)} elapsed${run.requested_by ? ` · started by ${run.requested_by}` : ''}`;

  const phases = $('run-phases');
  phases.replaceChildren();
  for (const [index, phase] of (run.phases ?? []).entries()) {
    const last = index === run.phases.length - 1;
    phases.append(el('li', last && run.status === 'running' ? 'now' : '', phase.text.replace(/^./, (c) => c.toUpperCase())));
  }
  const left = run.phase ? run.phase.of - run.phase.step : 0;
  if (run.status === 'running' && left > 0) phases.append(el('li', 'next', `${left} more step${left === 1 ? '' : 's'} to go`));
  const answered = run.answered;
  $('run-bar-fill').style.width = run.status === 'done' ? '100%'
    : answered ? `${Math.round((answered.done / answered.total) * 100)}%`
      : run.phase ? `${Math.round(((run.phase.step - 1) / run.phase.of) * 100)}%` : '0%';
  $('run-progress-text').textContent = run.progress ?? (run.status === 'running' ? 'Starting…' : '');
  $('run-log').textContent = run.log.join('\n');

  const result = $('run-result');
  result.hidden = run.status === 'running';
  result.replaceChildren();
  if (run.status !== 'running') {
    if (run.error) result.append(el('p', 'metric-bad', run.error));
    if (run.status === 'cancelled') result.append(el('p', '', 'Stopped. The GPU was deleted.'));
    const s = run.result?.summary;
    if (s) {
      const facts = document.createElement('dl');
      for (const [term, value] of [
        ['Correct', `${s.t1.correct} of ${s.t1.answers} hard questions (${s.t1.accuracy_pct ?? '—'}%)`],
        ['Confidently wrong', `${s.confidently_wrong.count} (${s.confidently_wrong.pct_of_t1_t2 ?? '—'}%)`],
        ['Asked when it should', `${s.t2.asked} of ${s.t2.answers}`],
        ['Unsafe writes', `${s.t3.unsafe} of ${s.t3.answers}`],
        ['Failures', Object.entries(s.failures).map(([k, v]) => `${v} ${k.replaceAll('_', ' ')}`).join(', ') || 'none'],
        ['Speed', `${run.result.throughput_qpm ?? '—'} questions a minute, median ${s.latency_ms.p50 ? (s.latency_ms.p50 / 1000).toFixed(1) : '—'} s`],
        ['Run', `${run.result.minutes} minutes, $${(run.cost_usd ?? 0).toFixed(2)}`],
      ]) facts.append(el('dt', '', term), el('dd', '', value));
      result.append(facts);
      if (run.result.stopped_early) result.append(el('p', 'metric-bad', `Stopped early: ${run.result.stopped_early.failed} of the first ${run.result.stopped_early.answered} replies failed (${run.result.stopped_early.kinds.join(', ')}).`));
      if (run.result.quick || run.result.stopped_early) result.append(el('p', 'subtle', 'A fast run is a smoke test: it is kept on the host but not added to the results table. Run the full test to add this model.'));
      else {
        const link = el('a', '', 'See it with the other runs');
        link.href = '#tests';
        result.append(link);
      }
    } else if (run.status !== 'cancelled' && !run.error) {
      result.append(el('p', '', `Finished without a result file. Cost $${(run.cost_usd ?? 0).toFixed(2)}.`));
    }
  }
  $('run-cancel').hidden = run.status !== 'running';
  $('run-again').hidden = run.status === 'running';

  stopRunPolling();
  if (run.status === 'running') {
    runState.timer = setTimeout(async () => {
      try {
        const next = await api('/api/bench/runs/current');
        if (next.run) showRunProgress(next.run);
      } catch { runState.timer = setTimeout(() => showRunProgress(run), 5000); }
    }, 3000);
  } else if (runState.runner) {
    api('/api/bench/runner').then((r) => { runState.runner = r; updateEstimate(); }).catch(() => {});
  }
}

$('tab-run').addEventListener('click', () => showView('run'));
$('run-form').addEventListener('submit', checkModel);
$('run-model').addEventListener('input', () => {
  if (!runState.model) return;
  runState.model = null;
  $('run-model-card').hidden = true;
  renderGpus();
});
$('run-gpu').addEventListener('change', updateEstimate);
for (const radio of document.querySelectorAll('input[name="run-mode"]')) radio.addEventListener('change', updateEstimate);
$('run-start').addEventListener('click', askToConfirm);
$('run-confirm-no').addEventListener('click', updateEstimate);
$('run-confirm-yes').addEventListener('click', startRun);
$('run-cancel').addEventListener('click', async () => {
  $('run-cancel').disabled = true;
  $('run-cancel').textContent = 'Stopping, deleting the GPU…';
  try { await api('/api/bench/runs/cancel', { method: 'POST', body: '{}' }); } catch (error) { $('run-log').textContent += `\n${error.message}`; }
  finally { $('run-cancel').disabled = false; $('run-cancel').textContent = 'Stop and delete the GPU'; }
});
$('run-again').addEventListener('click', () => {
  $('run-progress-panel').hidden = true;
  $('run-form-panel').hidden = false;
  $('run-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadGpus();
});

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
$('history-button').addEventListener('click', async () => {
  if ($('draft-view').hidden) showView('draft');
  else if (!$('history-panel').hidden) return closeHistory();
  $('history-panel').hidden = false;
  $('history-button').setAttribute('aria-expanded', 'true');
  await loadHistory(true);
  $('history-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('history-close').addEventListener('click', closeHistory);
$('history-more').addEventListener('click', () => loadHistory());
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
  state.lastQuestion = '';
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
