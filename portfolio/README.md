# Bank DWH Studio portfolio captures

Ten full-page screenshots show hard banking questions, the SQL drafts the POC
wrote for them, the retrieved synthetic schema context, review notes and checks,
at desktop, laptop, tablet and phone sizes.

| # | Question | Viewport | Screenshot |
|---|---|---:|---|
| 1 | Which 5 customers sent the highest total wire transfer amount in 2025? Give each customer's business id and their total. | 1440 × 900 | [Desktop](screenshots/01-top5-wire-customers-desktop.png) |
| 2 | How many distinct customers made both a wire transfer and an ATM transaction in 2025? | 1600 × 1000 | [Wide desktop](screenshots/02-wire-and-atm-customers-desktop-wide.png) |
| 3 | How many loans were more than 90 days past due on 31 August 2025? | 1280 × 800 | [Laptop](screenshots/03-loans-90-days-past-due-laptop.png) |
| 4 | Which 3 merchant category codes had the highest total card authorization amount in 2025? Give the merchant category code and the total. | 1024 × 768 | [Landscape tablet](screenshots/04-top-merchant-categories-tablet-landscape.png) |
| 5 | What percentage of card authorizations in 2025 had payment status code DECLINED? Answer as a percentage between 0 and 100. | 820 × 1180 | [Portrait tablet](screenshots/05-declined-card-share-tablet-portrait.png) |
| 6 | How many escalated complaints were recorded in 2025 per complaint category name? One row per category. | 768 × 1024 | [Compact tablet](screenshots/06-escalated-complaints-tablet-compact.png) |
| 7 | How many AML alerts with alert severity code HIGH were raised in 2025 per jurisdiction name? One row per jurisdiction. | 430 × 932 | [Large phone](screenshots/07-high-aml-alerts-phone-large.png) |
| 8 | How many account transactions were made through the Mobile App channel in 2024 and in 2025? One row per year. | 390 × 844 | [Phone](screenshots/08-mobile-transactions-phone.png) |
| 9 | What was the average account closing balance on 30 June 2025? | 375 × 812 | [Compact phone](screenshots/09-closing-balance-phone-compact.png) |
| 10 | How many distinct customers in the SME segment made at least one cross-border wire transfer in 2025? | 360 × 800 | [Small phone](screenshots/10-sme-cross-border-phone-small.png) |

## Where the examples come from

Every question is one of the [model benchmark](../app/eval/bench/README.md)'s
hard questions, which have a single right answer, and one that gpt-oss-20b, the
model the POC uses, answered correctly in all three of its benchmark runs on an
A100. The drafts in [examples.json](examples.json) were written by the POC's
own pipeline and model: Elasticsearch retrieval over the synthetic 100-table
catalog, then gpt-oss-20b through Groq.

**Each draft is verified by running it.** `verify-examples.mjs` executes it and
the benchmark's reference query against the benchmark's seeded PostgreSQL copy
of the warehouse, compares the results, and records the verdict in
`examples.json`; all ten returned the right answer on 2026-09-27. The PWA itself
still never runs SQL, which is why its Execution check reads "not run" in every
screenshot.

The screenshots render those recorded responses in the actual PWA frontend: the
capture script serves the app, answers its API calls with the recorded example,
and needs no invite, key, Elasticsearch or model. They contain no real banking
data.

## Regenerate

1. **Draft the examples**, on the host running the POC. The pipeline needs its
   Elasticsearch, which is reachable only on the `banking-dwh` network, and the
   model key from the server's environment file:

   ```bash
   podman run --rm --network banking-dwh --security-opt label=disable -v "$PWD:/srv/repo" -w /srv/repo \
     --env-file ~/.config/banking-sql-poc/server.env -e ELASTICSEARCH_URL=http://banking-poc-elasticsearch:9200 \
     docker.io/library/node:24-alpine node portfolio/generate-examples.mjs
   ```

   It keeps examples already drafted; delete `examples.json` for a fresh set.
2. **Verify them**: `node portfolio/verify-examples.mjs`. A wrong draft is marked
   so; run step 1 again to redraft only those, then verify again.
3. **Capture**: start a headless Chromium with remote debugging on port 9222 (the
   command is at the top of `capture-screenshots.mjs`), then run
   `node portfolio/capture-screenshots.mjs`. It drives Chromium through the
   DevTools protocol with no Playwright or Puppeteer, so it also works on arm64,
   and refuses to run unless all ten examples are verified correct. It replaces
   the PNGs and writes [screenshots.json](screenshots.json).

Model output changes between runs, so review the drafts again after
regenerating them.
