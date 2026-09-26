/**
 * Builds a PostgreSQL copy of the fixture warehouse, with data, so a drafted
 * query can be run and its result compared with a reference answer.
 *
 * The data is generated, deterministically, from the catalog: every table and
 * column exists, so any draft that the SQL checker accepts also executes. Only
 * the facts the benchmark asks about are populated; the rest are empty.
 *
 * Two rules keep the answers mechanical rather than a matter of interpretation:
 *
 * - Alternative spellings of one measure agree. A wire transfer's `amount`,
 *   `original_amount` and `settlement_amount` hold the same value, and a fact's
 *   `currency_code` matches the currency its `currency_key` points to. A draft
 *   that picks either is right, so the comparison tests the join, the filter
 *   and the period, not a coin toss between synonyms.
 * - Traps are deliberate. Some customers have a superseded dimension version,
 *   so counting rows instead of current records gives a wrong total; daily
 *   snapshots hold three dates a month, so summing a month instead of reading
 *   its last day gives a wrong balance.
 *
 *   node eval/bench/seed.mjs --out FILE
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(here, '..', '..', '..', 'banking-poc', 'catalog.json');

// A fixed seed: the reference answers are computed from this data, so it must
// come out the same on every machine and every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20260926);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const chance = (p) => random() < p;
const money = (low, high) => Math.round((low + (high - low) * random() ** 2) * 100) / 100;
const weighted = (pairs) => {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of pairs) if ((roll -= weight) < 0) return value;
  return pairs.at(-1)[0];
};

// ---------------------------------------------------------------- calendar

const FIRST = Date.UTC(2024, 0, 1);
const LAST = Date.UTC(2025, 11, 31);
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateKey = (ms) => Number(iso(ms).replaceAll('-', ''));
const days = [];
for (let ms = FIRST; ms <= LAST; ms += DAY) days.push(ms);
const monthEnd = (ms) => new Date(ms + DAY).getUTCDate() === 1;
// Snapshot facts hold the 1st, the 15th and the last day of each month: enough
// that a month's rows sum to three times its closing position.
const snapshotDays = days.filter((ms) => [1, 15].includes(new Date(ms).getUTCDate()) || monthEnd(ms));
const randomDay = () => pick(days);
const timestamp = (ms) => new Date(ms + between(7, 19) * 3_600_000 + between(0, 3599) * 1000).toISOString();

// ------------------------------------------------------------ vocabularies

const CURRENCIES = [
  ['EUR', 'Euro', 1], ['USD', 'US Dollar', 1.08], ['RON', 'Romanian Leu', 4.97],
  ['GBP', 'Pound Sterling', 0.85], ['CHF', 'Swiss Franc', 0.95], ['HUF', 'Hungarian Forint', 390],
];
const CHANNELS = [
  ['BRANCH', 'Branch'], ['ONLINE', 'Internet Banking'], ['MOBILE', 'Mobile App'],
  ['ATM', 'ATM'], ['PHONE', 'Call Centre'],
];
const BRANCHES = [
  ['Bucuresti', 'BUC', 'Bucuresti Unirii'], ['Bucuresti', 'BUC', 'Bucuresti Victoriei'],
  ['Bucuresti', 'BUC', 'Bucuresti Pipera'], ['Cluj-Napoca', 'NV', 'Cluj-Napoca Central'],
  ['Oradea', 'NV', 'Oradea Centru'], ['Iasi', 'NE', 'Iasi Copou'], ['Suceava', 'NE', 'Suceava Centru'],
  ['Timisoara', 'V', 'Timisoara Bastion'], ['Arad', 'V', 'Arad Centru'], ['Constanta', 'SE', 'Constanta Port'],
  ['Brasov', 'C', 'Brasov Livada'], ['Sibiu', 'C', 'Sibiu Piata Mare'], ['Craiova', 'SV', 'Craiova Centru'],
];
const SEGMENTS = [['RETAIL', 70], ['AFFLUENT', 12], ['SME', 13], ['CORPORATE', 5]];
const MERCHANT_CATEGORIES = [
  ['5411', 'Grocery stores'], ['5812', 'Restaurants'], ['5541', 'Fuel stations'], ['5732', 'Electronics'],
  ['4111', 'Local transport'], ['7011', 'Hotels'], ['5912', 'Pharmacies'], ['5691', 'Clothing'],
];
const COMPLAINT_CATEGORIES = [
  'Fees and charges', 'Card services', 'Loans', 'Digital banking', 'Branch service', 'Payments',
];
const LOAN_PRODUCTS = [
  ['MORTGAGE', 'Mortgage'], ['PERSONAL', 'Personal loan'], ['AUTO', 'Car loan'],
  ['SME_WC', 'SME working capital'], ['CREDIT_LINE', 'Credit line'],
];
const PRODUCTS = [
  ['CURRENT', 'Current account'], ['SAVINGS', 'Savings account'], ['TERM_DEPOSIT', 'Term deposit'],
  ['CREDIT_CARD', 'Credit card'], ['MORTGAGE', 'Mortgage'], ['PERSONAL_LOAN', 'Personal loan'],
];
const CARD_PRODUCTS = ['Classic Debit', 'Gold Credit', 'Platinum Credit', 'Business Card'];
const JURISDICTIONS = [
  ['RO', 'Romania'], ['HU', 'Hungary'], ['BG', 'Bulgaria'], ['DE', 'Germany'], ['CY', 'Cyprus'], ['AE', 'United Arab Emirates'],
];
const CITIES = ['Bucuresti', 'Cluj-Napoca', 'Iasi', 'Timisoara', 'Constanta', 'Brasov', 'Craiova', 'Oradea', 'Sibiu', 'Arad'];

// Members per dimension. Anything not listed gets eight.
const SIZES = {
  dim_customer: 600, dim_account: 900, dim_household: 300, dim_party: 300, dim_employee: 40,
  dim_merchant: 80, dim_terminal: 60, dim_security: 40, dim_portfolio: 30,
};

// ---------------------------------------------------------------- columns

// A value for a column no rule below claims: plausible for its type and name,
// but never something a question depends on.
function genericValue(column, context) {
  const name = column.column_name;
  const type = column.data_type;
  if (type === 'BOOLEAN') return chance(0.2);
  if (type === 'DATE') return iso(context.dayMs ?? randomDay());
  if (type === 'TIMESTAMPTZ') return timestamp(context.dayMs ?? randomDay());
  if (type.startsWith('NUMERIC(14')) return Math.round(random() * 1e6) / 1e8;
  if (type.startsWith('NUMERIC')) return money(0, 5000);
  if (type === 'BIGINT') {
    if (name.endsWith('_date_key')) return dateKey(context.dayMs ?? randomDay());
    if (name.endsWith('_count') || name.endsWith('_number') || name.endsWith('_level')) return between(0, 12);
    return between(1, 1000);
  }
  if (name.endsWith('_hash')) return createHash('sha1').update(`${name}${random()}`).digest('hex').slice(0, 24);
  if (name.endsWith('_id') || name.endsWith('_reference') || name === 'payment_reference') return `${name.slice(0, 3).toUpperCase()}-${between(100000, 999999)}`;
  if (name.endsWith('_status_code')) return weighted([['ACTIVE', 80], ['INACTIVE', 12], ['CLOSED', 8]]);
  if (name === 'currency_code' || name.endsWith('_currency_code')) return 'EUR';
  if (name === 'country_code' || name.endsWith('_country_code')) return pick(['RO', 'RO', 'RO', 'HU', 'DE']);
  if (name === 'city_name') return pick(CITIES);
  if (name.endsWith('_code')) return `${name.replace(/_code$/, '').split('_').map((w) => w[0]).join('').toUpperCase()}_${pick(['A', 'B', 'C'])}`;
  if (name.endsWith('_name')) return `${name.replace(/_name$/, '').replaceAll('_', ' ')} ${between(1, 50)}`;
  return `${name.replaceAll('_', ' ')} ${between(1, 99)}`;
}

// ------------------------------------------------------------- dimensions

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const tables = Object.fromEntries(catalog.tables.map((t) => [t.table_name, t]));
const rows = {};          // table -> array of row objects
const currentKeys = {};   // dimension -> keys of current versions

function dimensionRows(table) {
  const name = table.table_name;
  const entity = name.replace(/^dim_/, '');
  const key = `${entity}_key`;
  const out = [];
  const specific = (i) => {
    switch (name) {
      case 'dim_currency': {
        const [code, label] = CURRENCIES[i];
        return { business_code: code, display_name: label, iso_alpha_code: code, currency_name: label, country_code: code.slice(0, 2) };
      }
      case 'dim_channel': {
        const [code, label] = CHANNELS[i];
        return { business_code: code, display_name: label, channel_type_code: code };
      }
      case 'dim_branch': {
        const [city, region, label] = BRANCHES[i];
        return { business_code: `BR${String(i + 1).padStart(3, '0')}`, display_name: label, city_name: city, region_code: region, country_code: 'RO' };
      }
      case 'dim_customer': return {
        customer_segment_code: weighted(SEGMENTS), residence_country_code: weighted([['RO', 85], ['HU', 5], ['DE', 5], ['IT', 5]]),
        city_name: pick(CITIES), customer_since_date: iso(Date.UTC(between(2005, 2025), between(0, 11), between(1, 28))),
      };
      case 'dim_account': return {
        account_type_code: weighted([['CURRENT', 45], ['SAVINGS', 25], ['TERM_DEPOSIT', 10], ['LOAN', 12], ['CARD', 8]]),
        opened_date: iso(Date.UTC(between(2018, 2025), between(0, 11), between(1, 28))),
        currency_code: weighted([['RON', 60], ['EUR', 30], ['USD', 10]]),
      };
      case 'dim_merchant_category': {
        const [code, label] = MERCHANT_CATEGORIES[i];
        return { business_code: code, display_name: label, merchant_category_code: code };
      }
      case 'dim_merchant': {
        const [code] = pick(MERCHANT_CATEGORIES);
        return { merchant_category_code: code, merchant_display_name: `Merchant ${i + 1}`, display_name: `Merchant ${i + 1}` };
      }
      case 'dim_complaint_category': return { business_code: `CC${i + 1}`, display_name: COMPLAINT_CATEGORIES[i] };
      case 'dim_loan_product': {
        const [code, label] = LOAN_PRODUCTS[i];
        return { business_code: code, display_name: label, product_category_code: code };
      }
      case 'dim_product': {
        const [code, label] = PRODUCTS[i];
        return { business_code: code, display_name: label, product_category_code: code };
      }
      case 'dim_card_product': return { business_code: `CP${i + 1}`, display_name: CARD_PRODUCTS[i] };
      case 'dim_jurisdiction': {
        const [code, label] = JURISDICTIONS[i];
        return { business_code: code, display_name: label, jurisdiction_code: code, country_code: code };
      }
      default: return {};
    }
  };
  const count = {
    dim_currency: CURRENCIES.length, dim_channel: CHANNELS.length, dim_branch: BRANCHES.length,
    dim_merchant_category: MERCHANT_CATEGORIES.length, dim_complaint_category: COMPLAINT_CATEGORIES.length,
    dim_loan_product: LOAN_PRODUCTS.length, dim_product: PRODUCTS.length, dim_card_product: CARD_PRODUCTS.length,
    dim_jurisdiction: JURISDICTIONS.length,
  }[name] ?? SIZES[name] ?? 8;
  let next = 1;
  for (let i = 0; i < count; i++) {
    const member = specific(i);
    const businessId = `${entity.toUpperCase().slice(0, 4)}-${String(i + 1).padStart(5, '0')}`;
    // One customer in ten has a superseded version: counting rows rather than
    // current records overstates the customer base by that much.
    const versions = name === 'dim_customer' && i % 10 === 3 ? 2 : 1;
    for (let v = 1; v <= versions; v++) {
      const current = v === versions;
      const row = {};
      for (const column of table.columns) row[column.column_name] = genericValue(column, {});
      Object.assign(row, {
        [key]: next++, business_id: businessId, business_code: member.business_code ?? businessId,
        display_name: member.display_name ?? `${entity.replaceAll('_', ' ')} ${i + 1}`,
        effective_from_date: current ? '2024-01-01' : '2019-01-01',
        effective_to_date: current ? null : '2023-12-31',
        // Only customers and accounts have inactive members. A draft that adds
        // an unrequested is_active filter to a product or channel lookup should
        // not be punished by chance for a harmless habit.
        is_current: current, is_active: current && (['dim_customer', 'dim_account'].includes(name) ? chance(0.93) : true), version_number: v,
        ...member,
        // A superseded version carries a different segment, so a query that
        // forgets is_current also counts some customers in the wrong segment.
        ...(!current && name === 'dim_customer' ? { customer_segment_code: 'RETAIL' } : {}),
      });
      out.push(row);
    }
  }
  return out;
}

function calendarRows() {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // A calendar from 2023 to 2026 so that a draft reaching for last year or next
  // year still finds dates, and the facts only in 2024-2025.
  const out = [];
  for (let ms = Date.UTC(2023, 0, 1); ms <= Date.UTC(2026, 11, 31); ms += DAY) {
    const d = new Date(ms);
    const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1; const dow = d.getUTCDay();
    const start = Date.UTC(y, 0, 1);
    const quarter = Math.ceil(m / 3);
    const weekend = dow === 0 || dow === 6;
    out.push({
      date_key: dateKey(ms), calendar_date: iso(ms), day_of_week_number: dow === 0 ? 7 : dow, day_of_week_name: names[dow],
      day_of_month_number: d.getUTCDate(), day_of_year_number: Math.round((ms - start) / DAY) + 1,
      week_of_year_number: Math.ceil((Math.round((ms - start) / DAY) + 1) / 7), iso_week_number: Math.ceil((Math.round((ms - start) / DAY) + 1) / 7),
      month_number: m, month_name: months[m - 1], month_short_name: months[m - 1].slice(0, 3), quarter_number: quarter,
      quarter_name: `Q${quarter}`, calendar_year_number: y, calendar_year_month_code: `${y}-${String(m).padStart(2, '0')}`,
      fiscal_year_number: y, fiscal_quarter_number: quarter, fiscal_month_number: m, fiscal_week_number: Math.ceil((Math.round((ms - start) / DAY) + 1) / 7),
      is_weekend: weekend, is_business_day: !weekend, is_month_end: monthEnd(ms), is_quarter_end: monthEnd(ms) && m % 3 === 0,
      is_year_end: m === 12 && d.getUTCDate() === 31, is_public_holiday: false, holiday_name: null,
      prior_business_date_key: dateKey(ms - DAY), next_business_date_key: dateKey(ms + DAY),
      prior_date_key: dateKey(ms - DAY), next_date_key: dateKey(ms + DAY),
      month_start_date: iso(Date.UTC(y, m - 1, 1)), quarter_start_date: iso(Date.UTC(y, (quarter - 1) * 3, 1)),
    });
  }
  return out;
}

for (const table of catalog.tables.filter((t) => t.table_type === 'dimension')) {
  const name = table.table_name;
  if (name === 'dim_time') { rows[name] = []; continue; }
  rows[name] = name === 'dim_date' ? calendarRows() : dimensionRows(table);
  const key = table.columns.find((c) => c.is_primary_key).column_name;
  currentKeys[name] = rows[name].filter((r) => r.is_current !== false).map((r) => r[key]);
}

// ------------------------------------------------------------------ facts

const memberOf = (dimension, keyValue) => rows[dimension].find((r) => r[`${dimension.replace(/^dim_/, '')}_key`] === keyValue);
const currencyCode = (keyValue) => memberOf('dim_currency', keyValue).iso_alpha_code;
// Wire transfers and card spend lean towards some customers, so a top-N list
// has clear winners instead of ties.
const customerWeights = currentKeys.dim_customer.map((k) => [k, 1 + (k % 17 === 0 ? 12 : 0) + (k % 5 === 0 ? 2 : 0)]);
const someCustomer = () => weighted(customerWeights);
const AMOUNT_SYNONYMS = ['amount', 'original_amount', 'settlement_amount', 'base_amount', 'local_amount', 'gross_amount', 'net_amount', 'billing_amount', 'transaction_amount'];

function foreignKeys(table, row) {
  for (const rel of table.relationships) {
    if (rel.to_table === 'dim_date') continue;
    const pool = currentKeys[rel.to_table];
    if (!pool?.length) { row[rel.from_column] = null; continue; }
    row[rel.from_column] = rel.to_table === 'dim_customer' ? someCustomer() : pick(pool);
  }
}

function eventFact(table, count, shape) {
  const out = [];
  const factKey = table.columns[0].column_name;
  for (let i = 0; i < count; i++) {
    const dayMs = randomDay();
    const row = {};
    for (const column of table.columns) row[column.column_name] = genericValue(column, { dayMs });
    foreignKeys(table, row);
    row[factKey] = i + 1;
    row.business_date_key = dateKey(dayMs);
    if ('currency_key' in row && row.currency_key) {
      row.currency_key = weighted([[1, 35], [2, 15], [3, 40], [4, 4], [5, 3], [6, 3]]);
      const code = currencyCode(row.currency_key);
      for (const c of ['currency_code', 'original_currency_code', 'settlement_currency_code', 'billing_currency_code']) if (c in row) row[c] = code;
    }
    const value = money(5, 20000);
    for (const c of AMOUNT_SYNONYMS) if (c in row) row[c] = c === 'amount' ? value.toFixed(2) : value;
    if ('fee_amount' in row) row.fee_amount = Math.round(value * 0.002 * 100) / 100 + 1;
    shape?.(row, dayMs, i);
    out.push(row);
  }
  return out;
}

function snapshotFact(table, entities, shape) {
  const out = [];
  const factKey = table.columns[0].column_name;
  let n = 1;
  for (const entity of entities) {
    for (const dayMs of snapshotDays) {
      const row = {};
      for (const column of table.columns) row[column.column_name] = genericValue(column, { dayMs });
      foreignKeys(table, row);
      Object.assign(row, entity.keys);
      row[factKey] = n++;
      row.business_date_key = dateKey(dayMs);
      shape(row, dayMs, entity);
      out.push(row);
    }
  }
  return out;
}

const facts = {
  fact_wire_transfer: (t) => eventFact(t, 2400, (row) => {
    row.is_cross_border = chance(0.3);
    row.payment_status_code = weighted([['COMPLETED', 92], ['REJECTED', 5], ['PENDING', 3]]);
    row.is_returned = chance(0.03);
  }),
  fact_atm_transaction: (t) => eventFact(t, 3000, (row) => {
    row.payment_method_code = 'CASH_WITHDRAWAL';
    row.channel_key = 4;
  }),
  fact_card_authorization: (t) => eventFact(t, 4000, (row) => {
    row.payment_status_code = weighted([['APPROVED', 91], ['DECLINED', 9]]);
    row.rejection_reason_code = row.payment_status_code === 'DECLINED' ? pick(['INSUFFICIENT_FUNDS', 'SUSPECTED_FRAUD', 'EXPIRED_CARD']) : null;
  }),
  fact_card_dispute: (t) => eventFact(t, 700, (row) => {
    row.dispute_reason_code = weighted([['FRAUD', 35], ['NOT_RECEIVED', 25], ['DUPLICATE', 20], ['QUALITY', 20]]);
    const category = memberOf('dim_merchant_category', row.merchant_category_key);
    if (category) row.merchant_category_code = category.merchant_category_code;
  }),
  fact_complaint: (t) => eventFact(t, 900, (row, dayMs) => {
    row.is_escalated = chance(0.18);
    row.is_resolved = chance(0.8);
    row.contact_started_at = timestamp(dayMs);
    row.resolution_at = row.is_resolved ? new Date(Date.parse(row.contact_started_at) + between(1, 30) * DAY).toISOString() : null;
  }),
  fact_account_transaction: (t) => eventFact(t, 5000, (row, dayMs) => {
    row.channel_key = weighted([[1, 20], [2, 25], [3, 40], [4, 10], [5, 5]]);
    row.debit_credit_code = pick(['D', 'C']);
    row.transaction_type_code = weighted([['PAYMENT', 40], ['TRANSFER', 30], ['DEPOSIT', 15], ['FEE', 5], ['CASH', 10]]);
    // Mobile grows from 2024 to 2025, so a year-on-year question has a direction.
    if (row.channel_key === 3 && new Date(dayMs).getUTCFullYear() === 2024 && chance(0.35)) row.channel_key = 2;
    row.posting_date_key = row.business_date_key;
  }),
  fact_aml_alert: (t) => eventFact(t, 500, (row) => {
    row.alert_severity_code = weighted([['LOW', 50], ['MEDIUM', 32], ['HIGH', 18]]);
    row.jurisdiction_key = weighted([[1, 60], [2, 8], [3, 8], [4, 8], [5, 10], [6, 6]]);
  }),
  fact_loan_delinquency_daily: (t) => {
    const loans = Array.from({ length: 160 }, (_, i) => {
      const account = currentKeys.dim_account[i];
      return {
        loan: `LN-${String(i + 1).padStart(5, '0')}`, drift: random(),
        keys: { account_key: account, customer_key: someCustomer(), loan_product_key: 1 + (i % LOAN_PRODUCTS.length) },
      };
    });
    return snapshotFact(t, loans, (row, dayMs, loan) => {
      // Arrears build up for some loans and clear for others, so the count past
      // 90 days differs from one date to the next.
      const month = Math.round((dayMs - FIRST) / (30 * DAY));
      const dpd = loan.drift > 0.8 ? Math.max(0, Math.round((month - loan.drift * 10) * 9)) : loan.drift > 0.6 ? (month % 5) * 15 : 0;
      row.loan_id = loan.loan;
      row.days_past_due = dpd;
      row.default_flag = dpd > 90;
      row.delinquency_stage_code = dpd === 0 ? 'CURRENT' : dpd <= 30 ? 'DPD_1_30' : dpd <= 60 ? 'DPD_31_60' : dpd <= 90 ? 'DPD_61_90' : 'DPD_90_PLUS';
      row.overdue_amount = dpd > 0 ? money(100, 5000) : 0;
    });
  },
  fact_loan_balance_daily: (t) => {
    const loans = Array.from({ length: 160 }, (_, i) => ({
      loan: `LN-${String(i + 1).padStart(5, '0')}`, principal: money(5000, 250000),
      keys: { account_key: currentKeys.dim_account[i], loan_product_key: 1 + (i % LOAN_PRODUCTS.length) },
    }));
    return snapshotFact(t, loans, (row, dayMs, loan) => {
      const months = (dayMs - FIRST) / (30.4 * DAY);
      row.loan_id = loan.loan;
      row.principal_amount = loan.principal;
      row.outstanding_principal_amount = Math.round(loan.principal * (1 - months / 120) * 100) / 100;
    });
  },
  fact_account_balance_daily: (t) => {
    const accounts = currentKeys.dim_account.slice(0, 250).map((account) => ({
      base: money(50, 60000), keys: { account_key: account },
    }));
    return snapshotFact(t, accounts, (row, dayMs, account) => {
      const closing = Math.round(account.base * (0.8 + random() * 0.4) * 100) / 100;
      for (const c of ['closing_balance_amount', 'ledger_balance_amount', 'available_balance_amount', 'reporting_balance_amount', 'local_balance_amount', 'base_balance_amount']) row[c] = closing;
    });
  },
  fact_fx_rate_daily: (t) => {
    const out = [];
    let n = 1;
    for (const [index, [code, , level]] of CURRENCIES.entries()) {
      if (code === 'EUR') continue;
      let rate = level;
      for (const dayMs of days) {
        rate = Math.round(rate * (1 + (random() - 0.5) * 0.006) * 1e6) / 1e6;
        const row = {};
        for (const column of t.columns) row[column.column_name] = genericValue(column, { dayMs });
        foreignKeys(t, row);
        Object.assign(row, {
          fx_rate_daily_fact_key: n++, business_date_key: dateKey(dayMs), rate_date_key: dateKey(dayMs), currency_key: index + 1,
          currency_code: code, quote_currency_code: code, base_currency_code: 'EUR', currency_pair_code: `EUR${code}`,
          mid_rate: rate, closing_rate: rate, reference_rate: rate, official_rate: rate, spot_rate: rate, average_rate: rate,
          bid_rate: Math.round(rate * 0.999 * 1e6) / 1e6, ask_rate: Math.round(rate * 1.001 * 1e6) / 1e6,
        });
        out.push(row);
      }
    }
    return out;
  },
};

for (const table of catalog.tables.filter((t) => t.table_type === 'fact')) {
  rows[table.table_name] = facts[table.table_name]?.(table) ?? [];
}

// -------------------------------------------------------------------- SQL

const pgType = (type) => type; // the catalog's types are already PostgreSQL's
const copyValue = (value) => {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
};

const parts = [
  'SET client_min_messages = warning;',
  `DROP SCHEMA IF EXISTS ${catalog.schema_name} CASCADE;`,
  `CREATE SCHEMA ${catalog.schema_name};`,
];
for (const table of catalog.tables) {
  const columns = table.columns.map((c) => `  ${c.column_name} ${pgType(c.data_type)}`).join(',\n');
  parts.push(`CREATE TABLE ${catalog.schema_name}.${table.table_name} (\n${columns}\n);`);
  const data = rows[table.table_name];
  if (!data.length) continue;
  const names = table.columns.map((c) => c.column_name);
  parts.push(`COPY ${catalog.schema_name}.${table.table_name} (${names.join(', ')}) FROM stdin;`);
  parts.push(data.map((row) => names.map((n) => copyValue(row[n])).join('\t')).join('\n'));
  parts.push('\\.');
}
parts.push(`ANALYZE;`);
const sql = `${parts.join('\n')}\n`;
const version = createHash('sha256').update(sql).digest('hex').slice(0, 16);

const outIndex = process.argv.indexOf('--out');
if (outIndex === -1) {
  console.error('usage: node eval/bench/seed.mjs --out FILE');
  process.exitCode = 2;
} else {
  await writeFile(process.argv[outIndex + 1], `-- seed ${version}\n${sql}`);
  const populated = Object.entries(rows).filter(([, r]) => r.length);
  console.log(JSON.stringify({ version, tables: catalog.tables.length, populated: populated.length, rows: populated.reduce((n, [, r]) => n + r.length, 0), bytes: sql.length }));
}
