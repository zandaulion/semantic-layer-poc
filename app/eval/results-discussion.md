## Reading the results

### The schema contract held, and that was the question that mattered

No run produced a single `schema_violation`, and neither did any of the 392
requests in the concurrency sweep. llama.cpp compiles the `response_format` JSON
schema into a grammar and constrains decoding with it; vLLM does the same through
its structured-output backend, applied to the final answer only and not to
gpt-oss's reasoning channel. Every reply from every server parsed and satisfied
the contract the application is built on.

This is the result worth leading with, because it is the only one whose failure
would have *broken* the system rather than degraded it. A backend that enforces
the schema loosely does not give worse SQL — it gives unparseable responses and a
dead request path. That does not happen here.

vLLM was the server this question was really about, because it is what an
on-prem deployment would most likely run. It held the contract one request at a
time and with 64 requests batched together, which is where a constrained-decoding
implementation is most likely to slip. TGI and NIM remain untested and implement
this through their own engines; `strict: true` in particular is a field each may
interpret or ignore. Run this before trusting either.

### Retrieval and grounding are backend-independent

Every run scored full marks on table grounding: every answered case reached for
the tables the schema forces and avoided the ones the prompt rules out, including
the case that tempts a payments or ATM fact when the question says only
"transactions".

That is the reassuring half of the portability question, and it is the larger
half. Retrieval quality, the catalog, the bounded-context assembly and the prompt
are what determine whether the answer is about the right tables, and none of it
moved when the runtime did.

### The safety behaviour did move

Asked to delete duplicate customer records, the backends split:

- **Hosted** produced a `DELETE … USING` statement behind a CTE. The statement
  check caught it, the status was downgraded to `needs_revision`, and no
  executable write was ever presented as a draft.
- **llama.cpp** on both CPUs, and **vLLM**, declined, returned no SQL at all,
  and asked a clarifying question.

Same weights, same temperature, opposite handling of the only destructive
request in the set. Both outcomes were safe, but only one of them was
safe *because of the guard*. Nothing in the prompt predicts which you get.

The practical consequence is about where to place trust. `checkSql` is not a
secondary nicety; on at least one backend it is the single thing between a
destructive request and a statement the user could copy into a client. It should
be treated as production-critical code — which is also why the `EXTRACT` defect
this harness found in it mattered more than a false positive normally would.

### Dimension joins drift, in both directions

For wire transfers by currency the hosted backend and the x86 CPU run joined
`dim_currency`; the A1 CPU run and vLLM grouped by the surrogate key. For FX
rates by currency only the hosted backend left `dim_currency` out. Both forms
answer the question correctly.

The pattern is what makes this informative. A systematic difference — one
backend always joining, the other never — would suggest a capability gap. What
happened instead is that no backend was consistent across the two structurally
identical cases, and the two llama.cpp CPU runs disagreed with each other on wire
transfers. Those two had the same runtime, the same weights and, for that case,
a prompt identical token for token; only the machine differed. At this
temperature a join choice is not a property of the backend, and nothing here
should be read as one.

This is also why `preferred_tables` do not gate a case. Had they been required,
this comparison would have produced false failures on every run, and the correct
response would have been to stop believing the harness.

### Reasoning length did not inflate

A specific worry going in was that `reasoning_effort: 'low'` is a gpt-oss
parameter that a different server might quietly ignore, letting reasoning run
long enough to truncate the answer against `max_completion_tokens`. Mean
completion tokens were 237 hosted, 226 and 220 on the two llama.cpp runs, and
193 on vLLM. Whatever each server did with the field, the effect on output
length was not material at this prompt size.

### The later runs used newer retrieval

The retrieval fix recorded in [retrieval and naming](../../retrieval-and-naming.md)
landed after the A1 CPU run and before the x86 and vLLM runs, so they did not
see identical prompts everywhere. Ten of the twelve cases retrieved the same
tables and sent the same number of prompt tokens. The other two,
`active-customers` and `refuse-write`, retrieved eight tables instead of five,
which is why the mean prompt grew from 2,598 to 2,797 tokens. Neither changed
outcome: both passed on every run, and `refuse-write` was declined on every
self-hosted run.

### The x86 run was meant to be a GPU run

The run labelled x86 CPU was started on a RunPod pod with an RTX 4090, using
llama.cpp's CUDA image and `-ngl 999`, and was first recorded as a GPU run. It
was not one. Generation ran at about 28 tokens per second where a 4090 manages
several times that, and a second pod started from the same image with the same
flags and verbose logging allocated its KV cache and compute buffers on the CPU:
llama.cpp never used the card. Why is not established. The image asks for CUDA
12.8 and the host offered 13.0, which should work, and the log lines that would
have said why the CUDA backend was skipped were not retrievable before the pod
was deleted.

It stays in the comparison because it is still a clean record of something: the
same llama.cpp on a different CPU, which is what makes the wire-transfers
disagreement above informative. It is not a GPU measurement, and its 10 s
latency is what 64 x86 threads did, not what the card can do.

The lesson for anyone repeating this is that llama.cpp falls back to the CPU
without failing, so a CUDA image and `-ngl` prove nothing on their own. vLLM
refuses to start without a GPU, which is why its figures need no such caveat.

### Latency is not comparable across runs, and should not be quoted as if it were

The p50 was 598 ms hosted, 161 s on four A1 cores, 10.1 s on the x86 host CPU
and 1.3 s on vLLM with an RTX 4090. That measures the hardware and the network
path, not the software change. Grounding and behaviour carry between runs;
timing carries only within one. The vLLM figure includes a round trip from the
A1 host in Frankfurt through RunPod's HTTPS proxy to a pod in Romania.

Two numbers from the A1 CPU run are worth keeping anyway:

- **Prompt size.** ~2,600–2,800 tokens per question. On-prem that multiplies by
  concurrent users against the KV cache.
- **Prefix reuse.** `active-customers` took 271 s run on its own and 32 s inside
  the full run, because llama.cpp reused the cached prompt from an earlier
  identical request. Reuse across *different* questions is a different matter:
  the prompt currently opens with the question and puts the schema context
  last, so two questions share almost no prefix. Moving the stable instructions
  first and the question last would let a server cache the shared part. It is
  worth doing before sizing hardware, and worth re-running this harness after,
  because it changes what the model reads.

### What one card holds

The sweep measures vLLM on one RTX 4090 with requests held in flight at rising
levels. Latency grows smoothly and nothing failed at any level. Throughput
climbs from 49 requests a minute with one request in flight to 243 with 32, and
then only to 273 with 64 while the p95 nearly doubles to 20.5 s. The card is
effectively full at around 32 concurrent requests.

Requests in flight are not analysts. Someone reading and editing a draft holds
no slot between questions, so the number to size against is throughput: about
190 questions a minute with a p95 under 7 s, or about 240 with a p95 of 12 s.
How many analysts that serves depends on how often they ask, which this POC has
no data on.

Two conditions make these figures conservative rather than optimistic. Prefix
caching was off, so no request reused another's work; with the prompt reordered
as above, it would. And the context limit was 8,192 tokens, which is ample for
these prompts but leaves memory for more concurrent requests than a longer limit
would.

### What the GPU runs cost

Five RunPod pods over the two sessions, all RTX 4090, came to roughly $0.25:
the run that turned out to be CPU-bound, the pod that diagnosed it, two vLLM
starts on a community host whose card was already partly occupied by something
else, and the Secure Cloud pod that produced the vLLM results and the sweep in
seven minutes at $0.74 an hour.

## What this does not settle

- **TGI or NIM.** vLLM held the schema contract. The other on-prem servers have
  their own constrained-decoding engines and would each need this run.
- **Larger cards, or more than one.** The sweep is one RTX 4090. A datacenter
  card has more memory for concurrent requests, and the saturation point above
  does not transfer to it.
- **Whether the SQL is right.** Nothing executes it. Table selection is checked;
  column choice, join direction and business meaning are not — the same limits the
  PWA declares to its own users.
- **A larger or different model.** The likely corporate reality is not this model
  self-hosted but a different one entirely, chosen by model risk approval. That
  swap would dwarf the hosting difference measured here.
