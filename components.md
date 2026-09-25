# Component inventory

Written for the question "which parts of this POC would survive a move into the
bank, and in what form?"

Every component is listed with what it does, the contract it exposes, what is
specific to this proof of concept, and a verdict. The verdicts mean:

- **Reuse** — the design and the code transfer. Read it, keep it.
- **Port** — the design transfers, the implementation does not. Rewrite against
  the bank's stack, keeping the shape.
- **Reimplement** — POC-specific. The idea may be worth knowing; the code is not
  worth carrying.

The whole application is about 2,000 lines of Node with no runtime
dependencies, which is small enough that reading it is a realistic alternative to
trusting this document. What each component's behaviour is pinned to is listed
under [tests](app/README.md#tests); three of those tests exist specifically
because the bundled fixture is lower-case and readable, and a real warehouse is
neither.

## Summary

| # | Component | Files | Verdict |
| --- | --- | --- | --- |
| 1 | Catalog contract and loader | `server/catalog.js` | **Reuse** the contract, **port** the loader |
| 2 | Catalog validation | `server/catalog-schema.js`, `server/validate-catalog.mjs` | **Reuse** |
| 3 | Index lifecycle | `server/ingest.js` | **Reuse** the pattern |
| 4 | Retrieval | `server/elastic.js` | **Port** |
| 5 | Bounded context assembly | `server/catalog.js`, `server/model.js` | **Reuse** the design |
| 6 | Response contract | `server/model.js` | **Reuse** |
| 7 | Deterministic catalog rules | `server/model.js` | **Reimplement** |
| 8 | Clarification behaviour | `server/model.js` | **Port** |
| 9 | SQL safety check | `server/sql-check.js` | **Port**, and strengthen |
| 10 | Evaluation harness | `app/eval/` | **Reuse** |
| 11 | Access control | `server/auth.js` | **Reimplement** |
| 12 | PWA client | `app/web/` | **Port** or discard |
| 13 | Deployment | `app/deploy/`, `deploy.sh` | **Reimplement** |

---

## 1. Catalog contract and loader

**What it does.** Defines the application's entire view of a warehouse as one
JSON document, and builds one Elasticsearch document per table from it.

**Contract.** [catalog-contract.md](catalog-contract.md). Six fields per table,
three per column, four per relationship. The schema name comes from the catalog.

**POC-specific.** The loader reads the whole file into memory at startup and
never reloads it. Fine at 100 tables; a bank's catalog changes while the service
is running and is likely far larger.

**Verdict.** Reuse the contract — it is deliberately minimal and everything in it
earns its place. Port the loader: you need incremental refresh from whatever
metadata system is authoritative, not a file read at boot. The important property
to preserve is that *one source defines what the model can see*, because that is
what makes the blast radius of a metadata error knowable.

## 2. Catalog validation

**What it does.** Rejects catalogs that would index but behave badly: duplicate
table names that silently overwrite documents, relationships pointing at absent
tables, tables with no columns. Warns where quality degrades rather than breaks.

**Verdict.** Reuse. The error/warning split is the part worth keeping — a
validator that fails on everything imperfect gets bypassed, and one that fails on
nothing gets ignored. The specific checks are cheap to re-derive; the discipline
of validating metadata *before* it becomes an index is what saves debugging time.

## 3. Index lifecycle

**What it does.** Builds a new physical index per ingestion, swaps an alias onto
it atomically, then deletes the generations it superseded.

**Verdict.** Reuse the pattern, wholesale. Readers never see a half-built index,
rollback is an alias move, and the cluster does not accumulate copies. It is
standard practice and correctly implemented here, including the detail that
pruning selects positively — by name shape and age — rather than deleting
whatever is not current.

## 4. Retrieval

**What it does.** One BM25 `multi_match` over four fields with fixed boosts
(`table_name^6 title^4 column_names^3 search_text`), filtered by `status` and
optionally by domain, returning 12 tables.

**POC-specific.** The boosts are tuned to a fixture with clean, descriptive,
consistent names. A small hand-written synonym expansion folds
`client`→`customer` and adds delinquency terms to default questions.

**Verdict.** Port. The single-query, boosted-fields shape is right and cheap. The
constants are not transferable and the synonym list is a fixture artefact. Expect
this to be the component that needs the most work: on a real warehouse with
cryptic physical names, lexical retrieval over names alone degrades badly, and
this is where hybrid retrieval with embeddings earns its cost. The
[metadata model](elasticsearch-metadata-model.md) describes that fuller design.

**This is also the component that most determines answer quality** for facts. A
fact that retrieval never returns cannot be recovered downstream — dimensions
are a different matter, since component 5 supplies those structurally.

Measured against an abbreviated catalog, search recall was **unchanged**:
curated grain and column descriptions carry lexical retrieval on their own.
Strip those as well and recall falls by nearly half, with facts disappearing
first. The practical conclusion is that descriptions are worth more than
renaming, and it is written up in
[retrieval and naming](retrieval-and-naming.md).

## 5. Bounded context assembly

**What it does.** Takes retrieval hits, selects at most 8 tables, renders them as
a compact block of table name, type, grain and columns, plus candidate joins, and
refuses the request if the prompt exceeds 40,000 characters.

**Verdict.** Reuse the design, and read the ranking carefully before porting it.
Three properties matter and all three transfer: the context is **bounded** by
construction rather than by hope; joins are labelled *candidate* so the model is
not told they are approved; and the prompt has a hard ceiling with a defined
behaviour when it is hit. Prompt size is driven by the width of retrieved
tables, not the size of the warehouse — worth knowing when sizing a KV cache.

**This component supplies more grounding than search does.** On the fixture,
lexical search finds only 55% of the required tables; the rest arrive because
this step walks the selected facts' declared relationships. A reimplementation
that dropped the graph expansion would lose half its grounding while its search
metrics looked unchanged.

**Its ranking originally assumed readable table names** — word overlap with the
question, plus a literal comparison against `dim_date` — and against a catalog
using bank-style abbreviations it supplied no dimensions at all. Ranking
neighbours by join-graph degree instead is name-free and restores parity. See
[retrieval and naming](retrieval-and-naming.md).

## 6. Response contract

**What it does.** Requires the model to return one JSON object with `status`,
`sql`, `interpretation`, `assumptions`, `clarification_question` and `sources`,
enforced by `response_format` with a strict JSON schema.

**Verdict.** Reuse. The contract is the reason the application can show
assumptions and sources rather than a wall of SQL, and `status` as an enum is
what lets "I need to ask something" and "I cannot do this" be first-class answers
instead of prose the UI has to guess at.

**Carry this caveat with it:** enforcement is the serving stack's job, and stacks
differ. Verify it on whatever server you deploy, under load as well as one
request at a time — component 10 exists for this. SGLang's default JSON grammar
allowed unlimited whitespace, and under load the model sometimes padded a
finished object until the token limit cut it off. The server now checks
`finish_reason` and reports such a reply as `model_truncated` rather than as an
unparseable one.

## 7. Deterministic catalog rules

**What it does.** Three hand-written answers for specific question shapes, which
check that the required tables and columns exist and then return SQL with no
model call at all.

**Verdict.** Reimplement, if at all. The code is bound to fixture table names.
But the *idea* is worth taking seriously: for the handful of questions that get
asked constantly and have one correct answer, a reviewed, deterministic query
beats a generated one every time, and it cannot drift when the model changes. In
a bank this is the natural home for metric definitions that have been through
governance. Keep the guard clause pattern — check the schema supports the rule
before applying it, and fall through to the model otherwise.

## 8. Clarification behaviour

**What it does.** Detects a month named without a year and asks rather than
guessing; the prompt also instructs the model to ask at most one focused
question when business meaning is genuinely missing.

**Verdict.** Port. The heuristic is English-specific and narrow. The behaviour —
one question, under 160 characters, only when the answer is not derivable from
the supplied metadata — is a product decision worth keeping, and the evaluation
set has a case that measures whether a backend still honours it.

## 9. SQL safety check

**What it does.** Regex-level checks that a draft is a single read-only
`SELECT`/`WITH`, references only tables in the catalog, and contains no DML or
locking clause. On failure the status is downgraded so the draft is never
presented as ready.

**POC-specific.** It is a regex over text, not a parser. It reports `syntax`,
`columns`, `business` and `execution` as explicitly *not verified*, which is
honest but limited. It also carried a case-sensitivity defect that only appeared
once it was pointed at a catalog with uppercase names — invisible against an
all-lowercase fixture, and fatal against most real warehouses. See
[retrieval and naming](retrieval-and-naming.md).

**Verdict.** Port, and strengthen — replace the regexes with a real PostgreSQL
parser, which removes a whole class of both false positives and evasions.

**Treat it as production-critical, not as a nicety.** The backend comparison
found one model that declined a destructive request outright and another that
wrote the `DELETE` and relied on this check to catch it. On at least one serving
stack, this component is the only thing between a user's request and an
executable write. The bug the evaluation harness found here — a valid `EXTRACT`
filter read as an unknown table — is exactly the kind of defect that erodes trust
in a guard until people route around it.

## 10. Evaluation harness

**What it does.** Runs the real pipeline over questions whose correct answers the
schema determines, scores grounding, status and read-only safety, classifies
failures, and writes comparable result files per backend. A companion script,
`eval/load.mjs`, sends the same model requests at rising concurrency and reports
latency, throughput and failures per level, so a serving stack can be sized as
well as compared.

**Verdict.** Reuse — and this is arguably the most portable thing in the
repository. The cases are fixture-bound, but the method is not: ground truth
derived from the schema rather than from taste, gating expectations separated
from preferred ones, and failure classes that distinguish "the server broke the
contract" from "the account hit a rate limit".

A bank will need exactly this for model upgrades, quantisation changes, prompt
edits and serving-stack migrations. Bringing a validated method is a stronger
position than bringing benchmark numbers for a stack the bank will not use.
See [RESULTS.md](app/eval/RESULTS.md) for what it detected on first use, and
for the llama.cpp, vLLM and SGLang runs and concurrency sweeps on a rented RTX
4090. The sweep is what caught SGLang breaking the schema contract under load, a
failure the sequential cases never showed; a migration check that runs only one
request at a time would have passed it.

## 11. Access control

**What it does.** Invite codes redeemed for a device-scoped session cookie, held
in SQLite, with an admin API behind a shared token. Revocation is a soft flag.

**Verdict.** Reimplement. There is no user identity, no group, no row-level or
column-level scoping, and every catalog table is visible to everyone who gets in.
A bank replaces all of this with its own identity provider.

**The gap worth flagging early:** the retrieval layer has no concept of
entitlement. Adding access scoping is not a login change — it means filtering
what a given user is allowed to *see described*, at query time, which is a
retrieval and indexing concern. The metadata model reserves
`access_scope_ids` for this; nothing here implements it.

## 12. PWA client

**What it does.** Single-page app with a service worker, offline shell,
versioned-asset cache busting, per-device history, and the review surface that
shows SQL, interpretation, assumptions, checks and sources.

**Verdict.** Port the review surface, discard the rest. The screen layout is the
product thinking worth keeping — showing assumptions and retrieved sources beside
the SQL is what makes a draft reviewable rather than merely produced. Everything
around it (installability, offline, device history) answers a personal-use
requirement that an internal tool behind SSO does not have.

## 13. Deployment

**What it does.** Rootless Podman quadlets for the app, Elasticsearch and an
optional local model server, on a private network with a single published
loopback port; a deploy script that tests, builds, installs units and
health-checks.

**Verdict.** Reimplement against the bank's platform. Two decisions are worth
carrying: **Elasticsearch publishes no port at all**, so the only route to it is
the application; and the deploy script **starts Elasticsearch first and waits**,
because the app answers its own health check without it and a broken pair would
otherwise look deployed.

---

## What is missing entirely

Named explicitly, so nobody infers these exist:

- **Entitlements.** No user identity, no scoping of any kind (see 11).
- **Embeddings.** Retrieval is BM25 only. No encoder is called anywhere.
- **Execution.** Nothing runs the generated SQL. No connection to a warehouse
  exists in this codebase.
- **Business term / metric layer.** No glossary, no approved metric definitions.
  The catalog rules (7) are the nearest thing and they are hardcoded.
- **Lineage.** Relationships are candidate joins, not derived lineage.
- **Concurrent generation.** The server generates one draft at a time for all
  users: `/api/generate` answers a second request with `429 busy` until the
  first finishes. The concurrency sweep measured the model server directly,
  around this guard, and found one RTX 4090 handling about 240 questions a
  minute with 32 in flight on vLLM. The application cannot use any of that until the
  single flag becomes a bounded pool with a queue and a timeout.
- **Audit.** History is per-device convenience, not an audit trail.
