## Reading the results

### The schema contract held, and that was the question that mattered

Neither run produced a single `schema_violation`. llama.cpp compiles the
`response_format` JSON schema into a grammar and constrains decoding with it, so
every reply parsed and satisfied the contract the application is built on.

This is the result worth leading with, because it is the only one whose failure
would have *broken* the system rather than degraded it. A backend that enforces
the schema loosely does not give worse SQL — it gives unparseable responses and a
dead request path. That does not happen here.

It is also the result that generalises least far on its own evidence: it says
llama.cpp honours the contract, not that every server does. vLLM, TGI and NIM
implement constrained decoding through different engines, and `strict: true` in
particular is a field each may interpret or ignore. Run this before trusting any
of them.

### Retrieval and grounding are backend-independent

Both runs scored full marks on table grounding: every answered case reached for
the tables the schema forces and avoided the ones the prompt rules out, including
the case that tempts a payments or ATM fact when the question says only
"transactions".

That is the reassuring half of the portability question, and it is the larger
half. Retrieval quality, the catalog, the bounded-context assembly and the prompt
are what determine whether the answer is about the right tables, and none of it
moved when the runtime did.

### The safety behaviour did move

Asked to delete duplicate customer records, the two backends behaved differently:

- **Hosted** produced a `DELETE … USING` statement behind a CTE. The statement
  check caught it, the status was downgraded to `needs_revision`, and no
  executable write was ever presented as a draft.
- **Local** declined, returned no SQL at all, and asked a clarifying question.

Same weights, same prompt, same temperature, opposite handling of the only
destructive request in the set. Both outcomes were safe, but only one of them was
safe *because of the guard*. Nothing in the prompt predicts which you get.

The practical consequence is about where to place trust. `checkSql` is not a
secondary nicety; on at least one backend it is the single thing between a
destructive request and a statement the user could copy into a client. It should
be treated as production-critical code — which is also why the `EXTRACT` defect
this harness found in it mattered more than a false positive normally would.

### Dimension joins drift, in both directions

For wire transfers by currency the hosted backend joined `dim_currency`; the
local one grouped by the surrogate key. For FX rates by currency they swapped
positions. Both forms answer the question correctly.

The direction-swapping is what makes this informative. A systematic difference —
one backend always joining, the other never — would suggest a capability gap.
Disagreeing in opposite directions on two structurally identical cases instead
suggests ordinary sampling variation, visible here because the questions are
narrow enough for it to show.

This is also why `preferred_tables` do not gate a case. Had they been required,
this comparison — the harness's first real use — would have produced two false
failures, and the correct response would have been to stop believing the harness.

### Reasoning length did not inflate

A specific worry going in was that `reasoning_effort: 'low'` is a gpt-oss
parameter that a different server might quietly ignore, letting reasoning run
long enough to truncate the answer against `max_completion_tokens`. Mean
completion tokens were 237 hosted and 226 locally. Whatever llama.cpp did with
the field, the effect on output length was not material at this prompt size.

### Latency is not comparable and should not be quoted as if it were

The p50 moved from 598 ms to 161 s — roughly 270×. That is four CPU cores against
purpose-built inference hardware, and it measures the hardware, not the software
change. Grounding and behaviour carry between runs; timing carries only within
one.

Two numbers from the local run are worth keeping anyway:

- **Prompt size.** ~2,600 tokens per question. On-prem that multiplies by
  concurrent users against the KV cache, and it is the constraint that binds
  before compute does.
- **Prefix reuse.** `active-customers` took 271 s run on its own and 32 s inside
  the full run, because llama.cpp reuses the cached prompt prefix and these
  questions share most of their schema context. For a deployment serving many
  analysts against one warehouse, that reuse is worth designing the prompt
  around: stable content first, question last.

## What this does not settle

- **Quantisation parity with a real on-prem stack.** llama.cpp on CPU is not vLLM
  or NIM on CUDA. The MXFP4 weights are the same file, but the kernels, the
  batching and the numerics are not. The next comparison worth running is against
  the serving stack an actual deployment would use.
- **Concurrency.** Every case ran sequentially. Nothing here predicts behaviour
  with fifty analysts, which is the question that decides cluster sizing.
- **Whether the SQL is right.** Nothing executes it. Table selection is checked;
  column choice, join direction and business meaning are not — the same limits the
  PWA declares to its own users.
- **A larger or different model.** The likely corporate reality is not this model
  self-hosted but a different one entirely, chosen by model risk approval. That
  swap would dwarf the hosting difference measured here.
