# Banking DWH SQL assistant POC

This repository contains the architecture and synthetic banking warehouse fixture for a personal proof of concept. The assistant is intended to retrieve metadata and reviewed examples, generate an **editable SQL draft**, and show basic checks. Users review and run the draft in their own SQL client.

## Start here

- [Minimal POC architecture](minimal-logical-architecture.md) — implementation scope and flow.
- [Banking warehouse fixture](banking-poc/README.md) — 100 synthetic tables, 5,000 columns, PostgreSQL DDL, catalog, relationships, and small seed.
- [Elasticsearch metadata model](elasticsearch-metadata-model.md) — indexing contract, mapping, and sample documents.
- [Broader architecture](logical-architecture.md) and [PDF](output/pdf/DWH-SQL-Assistant-Architecture.pdf) — future reference design.

Generate and validate the warehouse fixture with Python's standard library:

```powershell
python generate_banking_warehouse.py
python validate_banking_warehouse.py
```

The warehouse content is synthetic. Names, relationships, and measures are POC test material, not approved banking definitions. The generated files are committed so the fixture can be inspected without running the generator. The PDF build source is in `tmp/pdfs/build_architecture_pdf.py`.

## License

Released under the [MIT License](LICENSE).
