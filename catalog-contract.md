# Catalog contract — bringing your own metadata

The application's entire view of a warehouse comes from one JSON file, located
by `CATALOG_PATH`. Replace that file and it describes your warehouse instead of
the bundled fixture. Nothing else needs to change.

This document is the contract for that file: what is required, what is optional,
what is ignored, and which fields decide whether retrieval works well.

Validate before you index:

```bash
npm run validate:catalog                       # whatever CATALOG_PATH points at
node server/validate-catalog.mjs my-catalog.json
```

Ingestion runs the same check and refuses a catalog that fails it.

## Shape

```json
{
  "schema_name": "risk_mart",
  "tables": [
    {
      "table_name": "dim_customer",
      "table_type": "dimension",
      "domain": "conformed",
      "grain": "One row per version of a customer.",
      "columns": [
        {
          "column_name": "customer_key",
          "data_type": "BIGINT",
          "nullable": false,
          "description": "Surrogate key for this version of the customer."
        }
      ],
      "relationships": []
    },
    {
      "table_name": "fact_account_balance_daily",
      "table_type": "fact",
      "domain": "deposits",
      "grain": "One row per account per business date.",
      "columns": [
        {
          "column_name": "customer_key",
          "data_type": "BIGINT",
          "nullable": true,
          "description": "Customer the balance belongs to."
        }
      ],
      "relationships": [
        {
          "from_table": "fact_account_balance_daily",
          "from_column": "customer_key",
          "to_table": "dim_customer",
          "to_column": "customer_key"
        }
      ]
    }
  ]
}
```

## Fields

### Top level

| Field | Required | Effect |
| --- | --- | --- |
| `tables` | yes | The whole catalog. Must be a non-empty array |
| `schema_name` | no | The SQL schema every draft is written against, and the one the safety check accepts. Defaults to `bank_dwh` |

### Table

| Field | Required | Effect |
| --- | --- | --- |
| `table_name` | yes | Document identity, and search field with the **highest boost (×6)**. Must be unique |
| `domain` | yes | The subject-area filter in the UI, and a search filter. Any string; the set of values becomes the dropdown |
| `grain` | yes | Shown to the model as the table's meaning, and folded into `search_text` |
| `table_type` | yes | Shown to the model, uppercased, as the table's kind. Conventionally `fact` or `dimension` |
| `columns` | yes | Must be non-empty |
| `relationships` | no | Offered to the model as candidate joins. Not indexed |

### Column

| Field | Required | Effect |
| --- | --- | --- |
| `column_name` | yes | Indexed as `column_names`, **boost ×3**, and shown to the model |
| `data_type` | yes | Shown to the model beside the column name |
| `description` | no | Folded into `search_text`. Absent costs recall, not correctness |
| `nullable` | no | Stored in the document and never read. Omit it if producing it is expensive |

### Relationship

| Field | Required | Effect |
| --- | --- | --- |
| `from_table`, `from_column`, `to_table`, `to_column` | yes | Rendered to the model as `CANDIDATE: a.x = b.y` |

`to_table` must name a table in the same catalog. A join offered to the model
that points nowhere is worse than no join at all, because it reads as approved
metadata.

## What is ignored

The bundled fixture carries more than the application reads: `design_status`,
`ordinal_position`, `is_primary_key`, `column_count`, `design_origin`,
`relationship_type`, and per-table and per-column `schema_name`. All of it is
ignored. Do not spend effort producing any of it.

The per-table `schema_name` in particular is a trap worth naming: only the
**top-level** one is read. A catalog whose tables each declare a schema, with no
top-level `schema_name`, silently falls back to `bank_dwh`.

## What decides whether retrieval works

Search runs BM25 over four fields with fixed weights:

```
table_name^6    title^4    column_names^3    search_text
```

`title` is derived from `table_name`, and `search_text` is the concatenation of
`domain`, `table_name`, `grain`, and every column's name and description.

Two consequences worth designing around:

**Names carry most of the weight.** If your physical names are cryptic —
`T_CUST_BAL_D` rather than `fact_customer_balance_daily` — the boosted fields
stop earning their boost, and a question phrased in business language will not
reach the table. This is the single largest difference between the fixture and a
real warehouse, and it is not a model problem: no amount of prompt work recovers
a table that retrieval never returned.

**`grain` and `description` are where recall comes from.** They are the only
place a question's vocabulary can meet the catalog when it does not match a name.
A precise grain statement — "one row per account per business date", not "balance
data" — is the highest-value writing in the whole file.

If your names are cryptic, put the business name in the description of every
column and a plain-language sentence in `grain`. That is the cheap fix. The
thorough fix is an alias field, which this POC does not have; the
[Elasticsearch metadata model](elasticsearch-metadata-model.md) describes one as
part of a fuller implementation.

## Scale

The fixture is 100 tables and 5,000 columns, and the whole catalog is read into
memory at startup and held there. Retrieval returns at most 12 tables and the
prompt is capped at 8, so catalog size affects memory and index build time rather
than prompt size.

Prompt size is driven by the width of the tables retrieved, not by how many
tables exist. A warehouse of 10,000 narrow tables is a smaller prompt than one of
50 tables with 400 columns each.

## What this does not cover

- **Row-level or column-level access control.** Every table in the catalog is
  visible to every user of the POC. There is no scoping of any kind.
- **Physical identifiers beyond the schema.** One schema, one database. There is
  no catalog, link, or connection concept.
- **Dialect.** The prompt says PostgreSQL. A different target dialect is a prompt
  change, not a catalog field.
- **Verified joins.** Relationships are offered to the model as *candidates* and
  labelled that way in the prompt. Nothing checks them against the database.
