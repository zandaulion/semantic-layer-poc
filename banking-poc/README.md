# Synthetic banking warehouse fixture

This fixture provides **100 tables, 5,000 columns**, and **490 candidate fact-to-dimension relationships** for the personal SQL-assistant POC. It covers customer and party, accounts and deposits, lending, payments, cards, service, wealth, treasury, finance, and risk/compliance. The split is 42 dimensions and 58 facts.

All names, fields, relationships, and rows are **synthetic**. They are designed to exercise metadata retrieval and SQL drafting at the requested scale. They are not a recommended production physical model, reviewed join guidance, regulatory definitions, or evidence that a SQL query is business-correct. In particular, 5,000 columns across 100 tables is deliberately wide. Review and prune the schema before treating any definition as authoritative.

## Files

| File | Purpose |
|---|---|
| `schema_postgresql.sql` | PostgreSQL DDL: schema, 100 tables, primary keys, and foreign keys. Run once in a fresh database. |
| `seed_small.sql` | Five rows per dimension and twenty per fact, with consistent keys and simple numeric values. |
| `tables.csv` | Subject area, grain, table type, and column count. |
| `columns.csv` | All 5,000 columns, types, nullability, descriptions, and design origin. |
| `relationships.csv` | Candidate fact-to-dimension foreign keys. |
| `catalog.json` | Machine-readable nested version of the metadata for POC ingestion. |
| `manifest.json` | Counts and generation status. |

The source of truth for regeneration is [`generate_banking_warehouse.py`](../generate_banking_warehouse.py). It uses Python's standard library:

```powershell
python generate_banking_warehouse.py
python validate_banking_warehouse.py
```

The validator checks counts, unique names, relationship targets, generated DDL structure, and insertion of all 1,370 seed rows using an in-memory SQL compatibility check. A local PostgreSQL server was not available during generation, so run the `psql` commands below when you provision one.

To create and lightly populate a personal PostgreSQL database:

```powershell
psql -X -v ON_ERROR_STOP=1 -d banking_poc -f banking-poc/schema_postgresql.sql
psql -X -v ON_ERROR_STOP=1 -d banking_poc -f banking-poc/seed_small.sql
```

The seed is intentionally small. Many optional fields are null, and its values do not model realistic balances or regulatory calculations. It is suitable for checking joins, identifiers, and basic end-to-end SQL execution. Use a separately reviewed set of examples and expected answers to evaluate SQL quality.

The JSON catalog can be transformed into the project's Elasticsearch table documents. It contains no embeddings and must not be marked as approved enterprise metadata. The existing [metadata model](../elasticsearch-metadata-model.md) explains the additional fields, access scopes, and guidance/examples required for the assistant.
