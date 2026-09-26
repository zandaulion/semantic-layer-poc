## Reading the results

### The schema contract held, with one server needing a flag

No run of the twelve cases produced a `schema_violation`, and neither did any
of the 392 requests in vLLM's concurrency sweep or the 200 in llama.cpp's.
llama.cpp compiles the `response_format` JSON schema into a grammar and
constrains decoding with it; vLLM and SGLang do the same through their
structured-output backends, applied to the final answer only and not to
gpt-oss's reasoning channel.

SGLang was the exception, and only under load. Started with its defaults, it
answered all twelve cases correctly one at a time, then produced four schema
violations in 200 concurrent requests. A repeat that kept the raw replies
showed what they were: the model finished every field of the object, then
wrote whitespace, 3,510 characters of spaces and newlines, until it reached
`max_completion_tokens`, so the JSON arrived cut off. The grammar SGLang
enforces by default allows any amount of whitespace between JSON tokens, and a
model can fall into generating it. Restarted with
`--constrained-json-disable-any-whitespace` and nothing else changed, the same
sweep produced no schema violations in 200 requests.

This is the result worth leading with, because it is the only one whose
failure would have *broken* the system rather than degraded it. A backend that
enforces the schema loosely does not give worse SQL — it gives unparseable
responses and a dead request path. Two findings follow:

- **"Supports structured outputs" is not the same as "holds the contract".**
  SGLang supports them, and still let one reply in fifty run away until the
  flag was set. The failure did not show in the twelve sequential cases at
  all; it needed load to appear.
- **The flag belongs in the deployment, and the check belongs in the app.**
  Anyone serving this with SGLang should set it. The app now also checks
  `finish_reason`: a reply that stopped at the token limit is reported as
  `model_truncated`, and the harness counts it as `truncated` rather than
  `schema_violation`, so an operator can tell a runaway from a server that
  ignored the schema. The SGLang runs recorded here predate that check, which
  is why their four runaways appear as schema violations.

vLLM was the server this question was really about, because it is what an
on-prem deployment would most likely run. It held the contract one request at a
time and with 64 requests batched together, where a constrained-decoding
implementation is most likely to slip. TGI, which this document once listed as
the next server to test, was archived by Hugging Face in March 2026, which
recommends vLLM or SGLang instead. NIM remains untested; `strict: true` in
particular is a field each server may interpret or ignore. Run this, and the
load sweep, before trusting it.

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
- **llama.cpp** on both CPUs and on the GPU, **vLLM** and **SGLang** declined,
  returned no SQL at all, and asked a clarifying question.

Same weights, same temperature, opposite handling of the only destructive
request in the set. Both outcomes were safe, but only one of them was
safe *because of the guard*. Nothing in the prompt predicts which you get.

The practical consequence is about where to place trust. `checkSql` is not a
secondary nicety; on at least one backend it is the single thing between a
destructive request and a statement the user could copy into a client. It should
be treated as production-critical code — which is also why the `EXTRACT` defect
this harness found in it mattered more than a false positive normally would.

### Dimension joins drift, in both directions

For wire transfers by currency the hosted backend, the x86 CPU run, llama.cpp
on the GPU and SGLang joined `dim_currency`; the A1 CPU run and vLLM grouped by
the surrogate key. For FX rates by currency only the hosted backend left
`dim_currency` out. Both forms answer the question correctly.

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
completion tokens were 237 hosted, 220–226 on the three llama.cpp runs, 193 on
vLLM and 173 on SGLang. Whatever each server did with the field, the effect on output
length was not material at this prompt size.

### The later runs used newer retrieval

The retrieval fix recorded in [retrieval and naming](../../retrieval-and-naming.md)
landed after the A1 CPU run and before all the rented-pod runs, so they did
not see identical prompts everywhere. Ten of the twelve cases retrieved the same
tables and sent the same number of prompt tokens. The other two,
`active-customers` and `refuse-write`, retrieved eight tables instead of five,
which is why the mean prompt grew from 2,598 to 2,797 tokens. Neither changed
outcome: both passed on every run, and `refuse-write` was declined on every
self-hosted run.

### The x86 run was meant to be a GPU run

The run labelled x86 CPU was started on a RunPod Community Cloud pod with an
RTX 4090, using llama.cpp's CUDA image and `-ngl 999`, and was first recorded
as a GPU run. It was not one. Generation ran at about 28 tokens per second, and
a second community pod started from the same image with the same flags and
verbose logging allocated its KV cache and compute buffers on the CPU:
llama.cpp never used the card, and reported no error.

The same image, flags and driver then worked on a Secure Cloud pod. Before
starting the server it listed `CUDA0: NVIDIA GeForce RTX 4090 (23685 MiB free)`,
and the server read prompts at about 11,500 tokens per second and generated at
about 200 — seven times the fallback's rate. That run is the llama.cpp GPU
column. So the fallback belonged to the community hosts, not to the image or
the flags; what on those hosts hid the card from llama.cpp was not established.

The x86 run stays in the comparison because it is still a clean record of
something: the same llama.cpp on a different CPU, which is what makes the
wire-transfers disagreement above informative. It is not a GPU measurement.

The lesson for anyone repeating this is that llama.cpp falls back to the CPU
without failing, so a CUDA image and `-ngl` prove nothing on their own. Passing
`--device CUDA0` makes a missing card an error, and `--list-devices` before
the server starts shows what llama.cpp can see. vLLM refuses to start without
a GPU, which is why its figures needed no such check.

### Latency is not comparable across runs, and should not be quoted as if it were

The p50 was 598 ms hosted, 161 s on four A1 cores, 10.1 s on the x86 host CPU,
and 1.5 s for llama.cpp, 1.3 s for vLLM and 8.4 s for SGLang on the same model
of RTX 4090. That
measures the hardware and the network path, not the software change. Grounding
and behaviour carry between runs; timing carries only within one. Both GPU
figures include a round trip from the A1 host in Frankfurt through RunPod's
HTTPS proxy to a pod in Romania.

One request at a time, llama.cpp and vLLM are close. vLLM's higher p95 is its
first request, `active-customers` at 3.9 s; its other model-backed cases took
0.9–1.6 s. SGLang is the outlier: it generated about 20 tokens a second for a
single request, against about 200 for llama.cpp on the same card. Its startup
log warned that its MXFP4 path "is not fully optimized yet", and gpt-oss ships
in MXFP4. Why it is slow on this card was not investigated; SGLang is tuned
for datacenter GPUs, and an RTX 4090 is not one. The difference that matters
more shows under load, below.

Two numbers from the A1 CPU run are worth keeping anyway:

- **Prompt size.** ~2,600–2,800 tokens per question. On-prem that multiplies by
  concurrent users against the KV cache.
- **Prefix reuse.** `active-customers` took 271 s run on its own and 32 s inside
  the full run, because llama.cpp reused the cached prompt from an earlier
  identical request. Reuse across *different* questions is a different matter,
  and it was measured rather than assumed; see below.

### Reordering the prompt would save little

The prompt opens with the question, so two different questions share only the
system message, about 2% of a prompt. The obvious fix is to put the stable
instructions first and the question last, so a server's prefix cache can
reuse them. Measured offline on the twelve cases, without a model:

- The stable instructions are about 12% of a prompt. The other 88% is the
  schema context, the retrieved tables, and it differs from question to
  question.
- With the question last, about 12% of each prompt is reusable across
  unrelated questions. Sorting the tables into a fixed order adds almost
  nothing, because one differing table ends the shared prefix.
- A question that retrieves the same tables as an earlier one reuses nearly
  all of its prompt. `refuse-write` did: it retrieved the same tables as
  `active-customers`, so everything before the question matched. Follow-up
  questions in one subject area would behave the same way.

On a GPU the saving is small either way. At the 11,500 tokens a second that
llama.cpp read prompts on the RTX 4090, a 2,800-token prompt takes about
0.25 s of a request whose median is 1.3–1.5 s; generating the answer takes
the rest. Caching 12% of the prompt would save tens of milliseconds. The prompt
was left as it is: changing it would change what the model reads, and every
recorded run would need repeating to compare against.

This matters more on a CPU, where reading the prompt is most of the time. It
does not change the conclusion for a GPU deployment.

### What one card holds

The sweeps put vLLM, llama.cpp and SGLang each on one RTX 4090 and held
requests in flight at rising levels.

**vLLM** is the one to size with. Latency grows smoothly and nothing failed at
any level. Throughput climbs from 49 requests a minute with one request in
flight to 243 with 32, and then only to 273 with 64 while the p95 nearly
doubles to 20.5 s. The card is effectively full at around 32 concurrent
requests.

**llama.cpp** with 16 slots batches, but reaches about half of that: 123
requests a minute at 16 in flight and 130 at 32, where vLLM managed 190 and
243. That is despite an advantage vLLM did not have. llama.cpp reuses a slot's
cached prompt by default, and because the sweep cycles through ten questions,
95% of its prompt tokens came from cache. Its figures are the better case for
it, not a like-for-like one. It is a good server for one user on one machine,
which is what the CPU quadlet uses it for; it is not the one to share a card
between analysts.

**SGLang** held none of this on this card: at most 38 requests a minute, with a
p50 of 47.5 s at 32 in flight. Given the single-request speed above, that says
more about its MXFP4 support on an RTX 4090 than about SGLang in general, and
it should not be read as a verdict on a datacenter deployment.

Requests in flight are not analysts. Someone reading and editing a draft holds
no slot between questions, so the number to size against is throughput: on
vLLM, about 190 questions a minute with a p95 under 7 s, or about 240 with a
p95 of 12 s. How many analysts that serves depends on how often they ask, which
this POC has no data on.

None of this capacity is reachable through the application as it stands. The
server generates one draft at a time for everyone and answers a second request
with `429 busy`. `load.mjs` calls the pipeline directly, so the sweep measured
the model server, not the app. Using the card means replacing that flag with a
bounded pool — a limit near the saturation point above, a queue and a timeout —
and that change belongs before any sizing conversation, not after.

The vLLM figures are conservative rather than optimistic in one respect: the
context limit was 8,192 tokens, which is ample for these prompts but leaves
memory for more concurrent requests than a longer limit would. Prefix caching
was off, but as the section above shows, turning it on would save little for
different questions.

### The larger model changed nothing this harness can see

`gpt-oss-120b` passed all twelve cases, grounded every answer in the right
tables, held the schema contract and declined the delete request, as every
self-hosted 20b run did. The one case where it differed from the 20b on the
RTX 4090 was the `dim_currency` join on wire transfers. The 20b on the A100
made the same join, as did four of the six 20b runs above, so that is the
sampling drift described earlier rather than something the larger model knows.
The 120b gave the same statuses and tables in all three of its runs.

What it did change was cost. On the same card it took 2.2 s at the median
instead of 1.2 s, wrote about 40% more tokens per answer (267 against 191,
mostly reasoning), and topped out at about 115 questions a minute against 263.
Each question costs more than twice the GPU time, and on these
twelve cases nothing was bought with it.

That is a statement about the cases, not the model. All twelve are ones every
20b backend already answers, so the set sits at its ceiling and cannot show
what a larger model is for. Telling the two apart needs questions the 20b gets
wrong: ambiguous business terms, joins across more than one hop, and the
abbreviated catalog from `make-cryptic.mjs`, where the names stop explaining
themselves.

On the card question, the A100 did not beat the RTX 4090 for the 20b: the same
median for one request, and 263 questions a minute at saturation against 273.
The 20b fits comfortably in 24 GB, so the A100's extra memory buys it nothing,
and at $1.59 an hour against $0.74 it costs about twice as much per question.
The A100 pod was in Maryland rather than Romania, which adds a transatlantic
round trip to every request, but that affects single-request latency, not
throughput with 64 in flight.

One request in the A100 20b sweep came back `truncated`, at 64 in flight. That
is the check added after SGLang's whitespace runaway, and it caught a reply
cut off at `max_completion_tokens`. Two more batches of 384 requests at 64 in
flight, which kept each failure's raw reply, produced no failure at all, so the
cause was not captured. vLLM's startup configuration shows its JSON grammar
also allows arbitrary whitespace by default (`disable_any_whitespace=False`),
so the same runaway is a plausible cause but an unconfirmed one. At about one
in a thousand requests, it is a reason to keep the check, not a reason to
change servers.

### What the GPU runs cost

Eight RunPod pods, all RTX 4090, came to roughly $0.90:

- the first six, about $0.30: the run that turned out to be CPU-bound, the pod
  that diagnosed it, two vLLM starts on a community host whose card was
  already partly occupied by something else, the Secure Cloud pod that
  produced the vLLM results and sweep in seven minutes, and a four-minute pod
  for the llama.cpp GPU run;
- then about $0.60 for two Secure Cloud pods at $0.74 an hour: eight minutes
  for the llama.cpp sweep, and 42 for SGLang, most of it spent in its slow
  sweeps, the repeat that captured the failures and the restart that tested
  the fix.

A ninth pod, one A100 SXM on Secure Cloud at $1.59 an hour, ran for about 21
minutes and cost about $0.56. It served the 120b for three runs and a sweep,
was restarted with the 20b for one run and a sweep, and ran the two capture
batches.

## What this does not settle

- **NIM.** vLLM held the schema contract, and SGLang held it once configured.
  NIM has its own engine and would need this run and the load sweep. TGI no
  longer needs testing: it was archived in March 2026.
- **SGLang on the hardware it is built for.** Its speed here is a result for
  an RTX 4090 and gpt-oss's MXFP4 weights, not for SGLang on a datacenter
  card.
- **More than one card, or newer ones.** The sweeps are one RTX 4090 and one
  A100. Neither says how the 120b scales across cards with tensor parallelism,
  or what a Hopper-class card with native FP8 and FP4 support would do.
- **Whether the SQL is right.** Nothing executes it. Table selection is checked;
  column choice, join direction and business meaning are not — the same limits the
  PWA declares to its own users.
- **What a larger model is worth.** The 120b matched the 20b on every case,
  because every case is one the 20b already answers. A harder question set is
  needed before that comparison means anything.
- **A different model.** The likely corporate reality is not this model
  self-hosted but a different one entirely, chosen by model risk approval. That
  swap would dwarf the hosting difference measured here.
