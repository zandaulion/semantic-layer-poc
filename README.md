# Banking DWH SQL assistant POC

This repository contains an invite-only PWA and synthetic banking warehouse fixture for a personal proof of concept. The assistant retrieves metadata from Elasticsearch, calls a hosted GPT-OSS model, generates an **editable SQL draft**, and shows basic checks. Users review and run the draft in their own SQL client. The app never connects to a banking DWH or executes generated SQL.

## Start here

- [Minimal POC architecture](minimal-logical-architecture.md) — implementation scope and flow.
- [PWA and A1 deployment](app/README.md) — run locally, configure Elasticsearch and the hosted model, and deploy to Oracle Ampere A1.
- [Portfolio screenshots](portfolio/README.md) — ten natural-language-to-SQL examples across desktop, tablet, and phone layouts.
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

Released under [GPL-3.0-only](LICENSE). The PWA update files are adapted from [pwa-kit](https://github.com/zandaulion/pwa-kit), also GPL-3.0, at commit `e2ad9dced4f471afb3d307b00af214dacd0d2e6e`. The invite administration API follows the contract of [pwa-invite-console](https://github.com/zandaulion/pwa-invite-console); that console's source is not bundled here.
