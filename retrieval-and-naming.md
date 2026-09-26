# Retrieval and naming

## The question

Retrieval boosts `table_name` by six and `column_names` by three. The bundled
fixture spells everything out — `fact_account_balance_daily` — so those boosts
land on words a person would actually type.

Warehouses that grew out of a mainframe rarely do. They carry `F_ACCT_BAL_D`,
and if the boosted fields stop matching the question, a table that retrieval
never returns cannot be recovered by any amount of prompt work downstream.

So: how much of this POC's retrieval quality is borrowed from the fixture having
unusually readable names?

## Method

[`eval/make-cryptic.mjs`](app/eval/make-cryptic.mjs) rewrites the fixture's table
and column names through a consistent abbreviation map — `dim_customer` becomes
`D_CUST`, `fact_loan_delinquency_daily` becomes `F_LN_DLQ_D`, and every column
with them, so `business_date_key` becomes `BUS_DT_K` and `is_active` becomes
`IS_ACTV` — and refuses to run if two names collide. Foreign key columns inside
relationships are rewritten too, so the join graph still resolves.

Columns matter separately from tables here. They are indexed as `column_names`
with a boost of three, they are rendered into the prompt beside their types, and
they are named as literals by the deterministic catalog rules. All three of
those are affected. It translates the evaluation's expected tables through
the same map, so each case still asserts the same thing about the same tables.
The questions stay in business English, which is the point.

Three catalogs, each ingested and measured in turn:

| | Names | Grain and descriptions |
| --- | --- | --- |
| **A** | descriptive | curated |
| **B** | abbreviated | curated |
| **C** | abbreviated | stripped |

Measured with `eval/run.mjs --retrieval-only`, which skips the model entirely.
The claim under test is about search, so measuring search directly is both the
sharper experiment and the one that finishes in seconds rather than hours.

It reports **two** layers, because the pipeline has two:

- **search recall** — required tables in the BM25 results.
- **context recall** — required tables that actually reach the prompt, after
  context assembly has walked the selected facts' declared relationships.

## What the baseline already showed

On the unmodified fixture, search recall is **0.550**. Nine of the nineteen
required tables — every `dim_date` — are never in the top twelve hits.

Context recall is **1.000** regardless, because context assembly pulls those
dimensions in through the join graph. The system does not rely on lexical search
to find dimensions at all: it finds facts lexically, then follows their declared
relationships.

That is worth knowing before porting anything. Measuring search alone would have
badly overstated the problem, and a reimplementation that dropped the graph
expansion would lose half its grounding while its search metrics looked fine.

## Results

Cases where every required table reached the prompt, and mean recall at each
layer:

| | Search recall | Context recall — before | after | Mean context tables |
| --- | --- | --- | --- | --- |
| **A** descriptive, curated | 0.550 | 1.000 (12/12) | 1.000 (12/12) | 6.5 |
| **B** abbreviated, curated | 0.550 | **0.550 (3/12)** | **1.000 (12/12)** | 8.0 |
| **C** abbreviated, stripped | 0.300 | 0.300 (3/12) | 0.550 (6/12) | 7.3 |

### Abbreviating names cost search nothing

A and B have **identical** search recall, with *both* table and column names
abbreviated. Curated grain and column descriptions carry lexical retrieval
entirely; the question's vocabulary meets the catalog through `search_text`, and
`search_text` was still in English.

Abbreviating columns does have one further consequence, invisible to retrieval:
the deterministic catalog rules name their columns as literals — `default_flag`,
`business_date_key`, `is_active` — so none of them can apply to a catalog like
this. That is the designed behaviour rather than a defect, and it is pinned by a
test, but it means a real warehouse gets no deterministic answers until those
rules are rewritten against its own column names.

This is the most useful result here. Cryptic physical names are survivable, and
what makes them survivable is metadata you can write without touching the
warehouse.

### But abbreviating names broke context assembly

Context recall halved in B, and tables recovered through relationships fell from
nine to **zero** — while search was unchanged. The cause was in
`contextForHits`:

```js
const relevance = overlap(dim) * 10 + (dim.table_name === 'dim_date' && dateIntent ? 8 : 0);
if (relevance > 0) candidateDimensions.set(...)
```

Two name dependencies — word overlap between a dimension's name and the
question, and a literal comparison against the string `dim_date` — and a gate
that adds nothing scoring zero. Against abbreviated names every score is zero,
so no dimension is ever added. What looked like a graph walk was a lexical
filter applied to graph neighbours.

### The fix is structural ranking, applied as a fallback

Filling the spare context slots in relationship declaration order was not
enough: B stayed at 3/12, because the date dimension is not the first
relationship declared on most facts and the budget is eight tables.

What works is ranking those neighbours by **join-graph degree** — how many facts
in the whole catalog reference each dimension. In a star schema the conformed
dimensions are referenced by nearly everything:

```
dim_date 58 · dim_currency 53 · dim_customer 49 · dim_branch 47 · dim_account 44
```

A name-free stand-in for "conformed dimension", computed once from the catalog.

It is deliberately a **fallback**, firing only when lexical scoring supplied no
dimension at all. Applying it unconditionally also filled the spare slots for
catalogs where the lexical path already worked: A went from 6.5 context tables
to 8.0, a larger prompt for no gain in grounding. Prompt size is the constraint
that binds first on an on-premise KV cache, so the wider context has to earn
itself. As a fallback, **B matches A exactly — 12/12, context recall 1.000** —
and A keeps its smaller prompt.

### Losing the prose is the real damage

C is the case that does not recover. Search recall falls to 0.300 and facts
themselves start disappearing — `F_WR_TRF`, `F_CMPLT`, `F_CD_DSPT` are simply
not found. Relationships cannot rescue a fact that was never retrieved, because
the graph is only walked outward from what search returned.

C improves to 0.550 with the fix, entirely through dimensions. Every remaining
failure is a missing fact.

### A second defect, found by accident

Running the abbreviated catalog end to end surfaced something the retrieval
measurement could not. The model drafted, correctly:

```sql
SELECT COUNT(*) AS active_customer_count FROM bank_dwh.D_CUST WHERE IS_ACTV = TRUE;
```

and the safety check reported `unknown bank_dwh.d_cust`. It lower-cased the
reference before looking it up, while the catalog was keyed by its own spelling.
SQL identifiers are case-insensitive unless quoted, so a model may return any
casing — and **every correct draft against a warehouse with uppercase physical
names was being rejected.** Uppercase is the norm in Oracle and DB2 and in
anything descended from a mainframe, which is to say in most banks.

The fixture is entirely lower-case, so nothing before this experiment could have
revealed it. Fixed by indexing the catalog under both spellings and reporting
matches under the catalog's own.

## What this means for an on-premise deployment

**Invest in descriptions and grain, not in renaming tables.** Renaming a
warehouse is a multi-year programme; writing a sentence of grain per table and a
phrase per column is a data-governance task that can start on Monday. The
measurement says the second one buys the retrieval quality and the first one is
close to unnecessary.

**Do not port `contextForHits` as written.** Its shape is right — find facts
lexically, expand through declared joins, cap the budget — but the ranking
inside it assumed readable names, and that assumption is invisible until a
catalog violates it. Rank structurally.

**Declared relationships are load-bearing.** Half this system's grounding comes
from the join graph, not from search. A metadata source that omits foreign keys
degrades the system in a way that no amount of retrieval tuning fixes.

**Fact retrieval is the remaining risk.** Dimensions are supplied structurally
and no longer depend on naming at all. Facts must still be found lexically, and
that is where hybrid retrieval with embeddings would pay — it is exactly the
failure mode variant C exhibits.

**Test against a catalog shaped like yours, early.** Both defects found here
were invisible against the fixture and would have been found on the first real
warehouse instead — one of them silently, as drafts that looked wrong rather
than as an error. Generating a variant catalog cost an afternoon.

## What is pinned by tests

Both defects are now regressions rather than findings, in tests that the bundled
fixture could never have triggered — it is lower-case and spells every name out,
so neither bug was reachable from it.

| Test | Pins |
| --- | --- |
| `context-assembly.test.js` — *an abbreviated date dimension reaches the prompt too* | The same star schema built twice, as `fact_wire_transfer`/`dim_date` and as `F_WR_TRF`/`D_DT`. The date join is declared second on purpose, so relationship ordering cannot make it pass by accident |
| `context-assembly.test.js` — *the context stays within its table budget* | The structural fallback cannot exceed the table cap or repeat a table |
| `schema-name.test.js` — *an uppercase catalog accepts a draft written in either case* | `BANK_DWH.D_CUST`, `bank_dwh.d_cust` and `Bank_Dwh.D_Cust` all accepted, and reported under the catalog's own spelling |
| `catalog-rules.test.js` — *cryptic column names make the rule stand down* | The same three tables with the same question, columns readable and then abbreviated. The rule answers in the first case and declines in the second, letting the model try, rather than throwing or emitting SQL for columns that do not exist |

They run in child processes: the catalog resolves once when the module is first
imported, so a different catalog needs a different process.

`eval/make-cryptic.mjs` is kept as well, so the whole measurement can be repeated
against any future change:

```bash
node eval/make-cryptic.mjs --out /tmp/cryptic
node eval/make-cryptic.mjs --out /tmp/cryptic-bare --strip-prose
# ingest each catalog, then
node eval/run.mjs --retrieval-only --cases /tmp/cryptic/cases.json
```

`--retrieval-only` needs Elasticsearch but no model, so a full three-variant
sweep takes seconds.

## With a model

The retrieval figures above were later checked end to end, with `gpt-oss-20b`
and `gpt-oss-120b` each drafting on catalogs B and C, three runs apiece. On B
both passed every case. On C both passed the same six: three questions found no
tables and never reached a model, and three reached one without the table they
needed. The 120b asked a question each time; the 20b did too, except once,
when it drafted a plausible query from the wrong table. The figures are in
[RESULTS.md](app/eval/RESULTS.md#abbreviated-names).

## Limits

- One fixture, generated with regular naming. A real warehouse is messier in
  ways an abbreviation map does not simulate — inconsistent conventions,
  homonyms, tables named after the system that produced them.
- The abbreviation map is consistent. Warehouses that were abbreviated by hand
  over twenty years are not, and inconsistency is likely worse than brevity.
- Twelve questions, all answerable. Nothing here measures behaviour on questions
  the warehouse cannot answer.
- The measurement is of retrieval, not of SQL correctness.
