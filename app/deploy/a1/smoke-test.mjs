const tailnetHost = process.argv[2];
const appOrigin = process.argv[3] || `https://${tailnetHost}:8443`;
const testModel = process.argv.includes('--generate');
if (!tailnetHost || !/^[a-z0-9.-]+$/i.test(tailnetHost) || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(appOrigin)) {
  console.error('Usage: node smoke-test.mjs <tailnet-hostname> [https-app-origin]');
  process.exit(2);
}
const privateBase = `https://${tailnetHost}`;
const appBase = appOrigin;
const request = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${new URL(url).pathname}: ${response.status} ${body.error || ''}`);
  return { response, body };
};
let deviceId;
try {
  const { body: invite } = await request(`${privateBase}/dwh/api/admin/invites`, {
    method: 'POST', headers: { origin: privateBase, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'POC smoke test' }),
  });
  const { response: redeemed, body: registration } = await request(`${appBase}/api/auth/redeem`, {
    method: 'POST', headers: { origin: appBase, 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, label: 'POC smoke test' }),
  });
  deviceId = registration.device.id;
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const headers = { cookie };
  const { body: session } = await request(`${appBase}/api/auth/session`, { headers });
  const { body: status } = await request(`${appBase}/api/status`, { headers });
  const { body: search } = await request(`${appBase}/api/search?q=loan%20repayments&domain=lending`, { headers });
  const { body: check } = await request(`${appBase}/api/check`, {
    method: 'POST', headers: { ...headers, origin: appBase, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT loan_key FROM bank_dwh.fact_loan_repayment' }),
  });
  if (!session.authenticated || !status.elasticsearch.available || !search.tables.length || check.checks.statement !== 'passed') {
    throw new Error('One or more smoke checks failed');
  }
  console.log(JSON.stringify({ invite: 'redeemed', device: 'authenticated', elasticsearch: status.elasticsearch.status, retrieved_tables: search.tables.length, statement_check: check.checks.statement, model_configured: status.model_configured }));
  if (testModel) {
    const question = process.env.SMOKE_QUESTION || 'List customer keys from the customer dimension';
    const domain = process.env.SMOKE_DOMAIN || 'conformed';
    const response = await fetch(`${appBase}/api/generate`, {
      method: 'POST', headers: { ...headers, origin: appBase, 'content-type': 'application/json' },
      body: JSON.stringify({ question, domain }),
    });
    const result = await response.json();
    console.log(JSON.stringify({ model_http_status: response.status, draft_status: result.status, error: result.error || result.code || null, message: result.message || null, sql_characters: result.sql?.length || 0, clarification: result.clarification_question || null, tables: result.retrieved_tables?.map((table) => table.table_name) || [] }));
  }
} finally {
  if (deviceId) {
    await request(`${privateBase}/dwh/api/admin/devices/${deviceId}`, {
      method: 'DELETE', headers: { origin: privateBase },
    });
  }
}
