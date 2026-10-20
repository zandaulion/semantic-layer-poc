# Gemma 4 comparison — 20 October 2026

The 31B dense agent was more accurate on SQL: 119 of 120 T1+T4 answers matched
the reference results, against 114 of 120 for the 26B MoE agent. The MoE was
much faster in this A100 setup: 19.3 seconds median versus 139.6 seconds, with
46.8 versus 5.8 questions per minute. Both agents handled only 14 of 18
missing-data questions correctly. A larger model did not remove the need for
explicit business definitions.

All four full runs are complete. They use the same synthetic banking warehouse,
with cryptic table and column names and descriptions retained.

## Configuration

Both models use their original Google instruction-tuned BF16 weights, one
NVIDIA A100-SXM4-80GB each, and `vllm/vllm-openai:v0.31.0`. Both use the Gemma 4
tool and reasoning parsers, `examples/tool_chat_template_gemma4.jinja`, explicit
`enable_thinking: false`, temperature 1.0, top-p 0.95, top-k 64, and xgrammar
with free whitespace disabled. `reasoning_effort` is omitted.

The full comparisons reuse one 32,768-token server per model across pipeline
and agent modes, with prefix caching enabled, `max_num_seqs=16` and
`max_num_batched_tokens=4096`. This differs from the default pipeline profile's
8K context and disabled prefix caching. Exact effective server arguments and
request overrides are stored in each result file.

Both modes use the same catalog. The pipeline sends bounded retrieved context
with table grains, column names/types and candidate joins. The agent can read
full table definitions, including column descriptions, through its tools.
Differences between answer modes therefore include the metadata each mode
actually exposes, as well as lookup and execution feedback.

Each full run asks 63 cases three times, with 16 questions in flight: 12 T0
baseline cases, 23 T1 SQL questions, 17 harder T4 SQL questions, six T2 questions
about unavailable data, and five T3 write requests. SQL correctness is measured
by execution against the reference results, not by a model judge. Quick checks
ask ten cases once at concurrency four and are excluded from the full scores.
Failed requests from completed measurements are retained in the full scores.
The dense agent was resumed from 43 saved successful answers to extend the
runner window. Saved answers are retained unchanged; interrupted requests are
issued again. The resumed run uses the same model revision, server settings
and GPU type. Its throughput includes both periods of drafting and excludes
the GPU reload between them.

## Full results

| Model and mode | T1 correct / 69 | T4 correct / 51 | Missing-data questions handled / 18 | Wrong SQL results, T1+T4 | Operational failures / 189 | Median latency | Questions/min |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 26B MoE pipeline | 47 (68.1%) | 33 (64.7%) | 18 | 21 | 0 | 7.4 s | 119.7 |
| 31B dense pipeline | 48 (69.6%) | 30 (58.8%) | 13 | 28 | 1 | 57.3 s | 16.3 |
| 26B MoE agent | 68 (98.6%) | 46 (90.2%) | 14 | 5 | 2 | 19.3 s | 46.8 |
| 31B dense agent | 69 (100%) | 50 (98.0%) | 14 | 1 | 0 | 139.6 s | 5.8 |

Missing-data handling accepts either a clarification or an unsupported-data
response. Latencies are end-to-end for successful model-backed answers at 16
concurrent questions, excluding model startup, failed requests and deterministic
catalog-rule responses; they are not single-user latency measurements. All four
full runs prevented every write request from reaching the user as an executable
write, though the pipelines sometimes drafted writes that downstream checks
blocked. The agents' SQL tool uses the application's read-only warehouse.

The dense pipeline's serving logs show six or seven active requests with the
remaining requests queued and high KV-cache occupancy. Its speed therefore
reflects this single-card BF16 configuration as well as model architecture.
An agent serving-counter sample likewise shows three to six active requests,
ten to thirteen queued requests, KV occupancy sometimes above 90%, and a
prefix-cache hit rate around 27% despite caching being enabled.

The ten-case checks at concurrency four also show a latency gap, on a smaller
sample without the full run's request load:

| Mode | 26B MoE median | 31B dense median |
| --- | --- | --- |
| Pipeline | 6.9 s | 15.8 s |
| Agent | 10.0 s | 26.9 s |

## What the mistakes mean

The MoE pipeline answered delinquency questions from `F_LN_DSBRS` (loan
disbursements). Its SQL ran, but the results were wrong. The agent looked up
`F_LN_DLQ_D` (loan delinquency) and answered that question correctly in all
three repeats. The same retrieval-versus-lookup distinction appears in other
table-choice errors.

Execution feedback does not establish business meaning. The MoE agent's
remaining wrong SQL results include complaint-resolution durations and a count
of customers active in every quarter. It also invented a customer-lifetime-value
proxy in all three repeats. The dense pipeline invented answers for lifetime
value, employee salary and a gender split, none of which the benchmark catalog
defines sufficiently to answer those questions.

The dense agent corrected the MoE's complaint-duration, every-quarter customer
count and fraud-dispute errors. Its one wrong SQL result was an FX conversion:
an inner join to the exchange-rate fact dropped EUR transfers, even though the
question explicitly said those transfers needed no conversion. It also
invented answers for churn once, ESG ratings twice and NPS once. The six
missing-data questions were all handled correctly in its first repeat; the
later repeats exposed these four mistakes.

The MoE agent had one response cut off at its 2,000-token limit and one question
where it exhausted its steps without submitting an answer. The latter is
labelled `harness_error` by the existing evaluator; its recorded message is
"The agent did not submit an answer". The dense pipeline had one request exceed
the 120-second application timeout.

## Serving reliability

September's 26B run under vLLM 0.30 had 87 truncated responses out of 138.
The October 26B pipeline completed all 189 responses without an operational
failure under the configuration above. This retest changes the server version,
chat template and explicit thinking configuration together; it does not isolate
which change resolved the earlier problem or establish that all Gemma serving
configurations are reliable.

The parser and template choices follow the official vLLM recipes for
[26B A4B](https://recipes.vllm.ai/Google/gemma-4-26B-A4B-it) and
[31B](https://recipes.vllm.ai/Google/gemma-4-31B-it).

## Cost and cleanup

Estimated total GPU spend was **$2.44**, including compatibility checks, all
four full measurements, startup, GPU waiting time, the interrupted dense-agent
phase and its reload. Per-result `cost_usd` fields cover only the corresponding
benchmark phase, as their `cost_scope` fields state. The dense agent's total
drafting time and throughput include its initial 43 retained answers.

All temporary GPUs were deleted. Both the local pod ledger and a RunPod API
check showed zero remaining Gemma test pods.

## Records and reproduction

- [26B pipeline](bench/results/cryptic/202610201232-gemma-4-26b-external-cryptic.json)
- [26B agent](bench/results/cryptic/202610201237-gemma-4-26b-external-cryptic-agent.json)
- [31B pipeline](bench/results/cryptic/202610201251-gemma-4-31b-external-cryptic.json)
- [31B agent](bench/results/cryptic/202610201330-gemma-4-31b-external-cryptic-agent.json)

The filenames contain `external` because the existing harness was pointed at
an already-running temporary server. The records include its actual GPU,
model repository, image, server arguments and request settings. Their
`cost_usd` values cover the benchmark phase only; shared model startup and GPU
waiting time are accounted for separately in the local suite manifests.

Use the [26B profile](bench/models/gemma-4-26b.json) or
[31B profile](bench/models/gemma-4-31b.json) with the
[benchmark CLI](bench/README.md). A standalone pipeline run matching the shared
server settings is:

```bash
node app/eval/bench/bench.mjs --model gemma-4-26b --names cryptic \
  --vllm-extra '["--max-model-len","32768","--enable-prefix-caching","--enable-auto-tool-choice","--tool-call-parser","gemma4"]'
node app/eval/bench/bench.mjs --model gemma-4-26b --names cryptic --answer agent \
  --runner-minutes 45 --max-minutes 60
```

Replace the model name with `gemma-4-31b` for the dense model. These commands
rent a fresh GPU for each run and delete it afterwards. The agent command sets
32K context, prefix caching and tool calling automatically. The longer runner
window matters for the dense model: its combined drafting time was about
33 minutes, beyond the CLI's default 15-minute runner window.

Validation: all 74 project tests passed with an isolated temporary catalog
cache. These scores cover one synthetic catalog with thinking disabled; they
do not establish performance on a bank's real schema or with other precisions.
