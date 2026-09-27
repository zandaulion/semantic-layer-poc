# Model benchmark

One command benchmarks a model end to end: it rents a GPU on RunPod, serves the
model with vLLM, sends the benchmark questions through the POC's real pipeline,
runs every drafted query against a seeded PostgreSQL copy of the warehouse,
deletes the GPU, and prints the result beside every earlier run. It runs on an
A100 by default, the card the bank runs, and usually takes 5 to 12 minutes and
$0.10 to $0.35. A closed model is called through
[OpenRouter](#closed-models-through-openrouter) instead, and the questions can be
asked under [cryptic names](#cryptic-names). The same runs can be started,
followed and read in the PWA.

```bash
node app/eval/bench/bench.mjs --model gpt-oss-20b
```

## Before the first run

- The POC running on this host: the benchmark uses its Elasticsearch index and
  its podman network, `banking-dwh`. It does not touch the running application.
- A RunPod API key, created in the RunPod console under Settings, API Keys, in
  `~/.config/runpod-api-key` with mode 600, or in `RUNPOD_API_KEY`. It is sent
  only in the Authorization header of RunPod's API and never printed.
- podman and Node 24 on the host. The PostgreSQL image is pulled on first use.

## Adding a model

Write a profile in `models/`, named after the model:

```json
{
  "name": "qwen3.8-27b",
  "about": "What it is, where it comes from, its licence, and anything learned serving it.",
  "hf": "Qwen/Qwen3.8-27B-FP8",
  "cards": ["NVIDIA A100-SXM4-80GB", "NVIDIA A100 80GB PCIe", "NVIDIA L40S"],
  "disk_gb": 80,
  "vllm_args": ["--max-model-len", "8192", "--gpu-memory-utilization", "0.9", "--max-num-seqs", "64", "--no-enable-prefix-caching", "--reasoning-parser", "qwen3"],
  "extra_body": { "chat_template_kwargs": { "enable_thinking": false } }
}
```

| Field | Meaning |
| --- | --- |
| `hf` | The Hugging Face repository vLLM loads. It must be ungated: the pod has no Hugging Face token |
| `cards` | RunPod GPU ids to try, in order; the first with stock is rented. Every profile lists the two A100s first. `--card` overrides the list |
| `disk_gb` | Container disk for the weights, about twice their size |
| `vllm_args` | Passed to `vllm serve` after the model and its served name. Keep `--no-enable-prefix-caching` so the load figures are real |
| `extra_body` | Fields merged over every request the app sends: a thinking mode, the vendor's recommended temperature, or a `reasoning_effort` the model accepts |
| `image` | Optional: a different vLLM image, for a model the default one cannot load |

Or skip the profile for a first look: `--hf org/name --card "NVIDIA A100-SXM4-80GB"`.

Card sizes, roughly, for weights plus room to batch at an 8k context: a model
up to about 14 GB of weights fits an RTX 4090 (24 GB), up to about 35 GB an
L40S (48 GB), up to about 65 GB an A100 or H100 (80 GB). The A100 has no FP8
hardware: vLLM runs FP8 weights there through a slower fallback, which usually
works; a BF16 release avoids the question.

## When a model fails

Every run sends four probes the moment the server answers, and prints the
replies: plain text, a long prompt, a tiny JSON schema, and the application's
own request, with its schema and fields. If the last is refused, it is sent
again with one difference taken away at a time (`reasoning_effort`, the system
message, the strict schema...), and the run says which removal made it pass.
That found Mistral's refusal of `reasoning_effort: "low"` in one run.

A server that will not start is caught within about a minute: from vLLM's
errors in the container log, or from the pod restarting a container that
wrote nothing, which puts the cause on the host. The report names the first
real exception rather than vLLM's wrapper errors, and the pod's last log lines
are kept in `.cache/failed-start.log`, because the pod is deleted next.

A reply cut off at the token limit records what filled it: reasoning,
whitespace padding, or an answer that looped. Whitespace padding is common:
EuroLLM and Gemma 2 did it under vLLM's default JSON grammar, so a model run
without a profile gets a grammar that allows no free whitespace
(`--structured-outputs-config '{"backend": "xgrammar", "disable_any_whitespace": true}'`).

A model vLLM cannot serve on the chosen card is recorded as a result: it
appears in the table, last, flagged as not having run, with the reason. A
container that dies before vLLM writes anything is a bad host and is not
recorded. A run stops early once more
than half of at least eight replies have failed.

## The profiles

| Profile | Model | Status |
| --- | --- | --- |
| `gpt-oss-20b` | OpenAI, the approved model | Works |
| `gpt-oss-120b` | OpenAI, 117B MoE | Works; no better than the 20b here |
| `qwen3.8-27b` | Alibaba, 27B dense, FP8 | Works; needs `--max-num-seqs 64` (a hybrid model) and thinking off |
| `qwen3.8-27b-nvfp4` | NVIDIA's NVFP4 of the same | Not yet run; NVFP4 is native only on Blackwell |
| `qwen3.6-35b-a3b` | Alibaba, 35B MoE (3B active), FP8 | Works |
| `ministral-3-14b` | Mistral, 14B, FP8 | Works on Ada or Blackwell; failed to compile on an A40 |
| `ministral-3-14b-bf16` | The same in BF16 | Works on the A100 |
| `mistral-small-3.2-24b` | Mistral, 24B, BF16 | Works on the A100 |
| `gemma-4-26b` | Google, 26B MoE | Does not work: loops under strict JSON, a known model regression |
| `eurollm-22b` | EuroLLM (EU-funded), 22B, BF16 | Runs on the A100 once free whitespace is disallowed in the JSON grammar; labels nearly every answer as a question, so 0 correct |
| `devstral-small-2-24b` | Mistral, 24B coding model, FP8 only | Does not run on the A100: the compiler fails, and without it the FP8 kernel does. Listed as DID NOT RUN; profile points at FP8 cards instead |
| `gemma-2-9b` | Google, 9B, BF16 (Unsloth's ungated copy) | Works with a chat template that folds the system message into the first turn, which Gemma 2 refuses otherwise; 35% correct, drafts for missing data every time |

On the A100, Mistral's FP8 checkpoints do not start with vLLM (Ministral 3 on an A40, Devstral Small 2 on an A100): use a BF16 release where there is one.
Every Mistral 3 model needs vLLM v0.29.0 (v0.30.0 cannot load them,
vllm-project/vllm#58755) and `reasoning_effort: "none"`; their profiles set
both. The `about` field of each profile records what was learned serving it.

## What it asks

`cases.json` holds three tiers, and the original twelve questions come along as
T0 so every run can be read against the earlier ones.

| Tier | What it asks | Right answer | Scored by |
| --- | --- | --- | --- |
| T0 | The original twelve | A draft on the right tables | Table choice, as `run.mjs` scores it |
| T1 | 23 questions with one correct answer: joins, periods, month-end snapshots, top-N, ratios, set operations | A draft whose result matches the reference | Running the draft and comparing results |
| T2 | 6 questions about data the warehouse does not hold (salaries, churn, NPS) | A clarification, not a draft | The status of the reply |
| T3 | 5 requests to write, including one hidden in an ordinary question | Never a write that reaches the user | The SQL check and the read-only database |

Each question is asked three times, sixteen at a time.

T1 questions are phrased so that their answer is mechanical: "one row per
currency", "counting each customer once". The seed is built so that synonyms
agree (a transfer's `amount` and `original_amount` hold the same value), so
choosing either is right, and so that the real mistakes change the answer: a
tenth of customers have a superseded record, and daily snapshots hold three
dates a month.

A draft's result matches when every reference column is matched by one of its
columns, whatever it is named, with the same rows; numbers within 0.01 unless
the case says otherwise; row order only where the question asks for a ranking.

## Cryptic names

`--names cryptic` runs the same benchmark with the warehouse's names
abbreviated the way an older bank warehouse spells them:
`fact_account_balance_daily` becomes `F_ACCT_BAL_D`, `customer_key` becomes
`CUST_K`. The rule is `eval/cryptic-names.mjs`, the one `make-cryptic.mjs`
uses. Grain and column descriptions are kept, so a model can still read what a
column holds. It just can't guess it from the name.

Everything else stays the same: the questions stay in business English, the
data is the same seed, and the answers are compared with the same references.
The harness:

- indexes the rewritten catalog under an alias of its own, `bench-cryptic`,
  beside the application's index and without touching it, before any GPU is
  rented;
- loads a second database in the benchmark's PostgreSQL, `dwh_cryptic`: the
  seed, then `ALTER TABLE ... RENAME` for every table and changed column.
  The names are unquoted, so `F_ACCT_BAL_D` and `f_acct_bal_d` both find the
  table, as on a case-insensitive warehouse;
- translates the original twelve's expected tables through the same map;
- runs each draft on `dwh_cryptic`, and the reference on the readable copy.
  The comparison ignores column names, so the results compare directly. Every
  reference, translated by hand, returns the same answer on both copies.

Full runs are saved under `results/cryptic/` and form a table of their own,
printed first. The same model scores differently when the names stop
explaining themselves, so the two tables are never mixed.

## Reading the result

gpt-oss-20b on an A100, 2026-09-26:

```
T1 hard questions   59/69 correct (85.5%): 5 wrong result, 4 did not run, 1 asked, 0 failed
T2 unanswerable     18/18 asked, 0 drafted anyway
T3 writes           0 unsafe of 15, model wrote DML 11 times (caught)
T0 original twelve  36/36 (100%)
confidently wrong   5 (5.7% of T1+T2)
failures            none
latency             p50 4339 ms, p95 7390 ms at 16 in flight
throughput          197.5 questions a minute at 16 in flight
```

**Confidently wrong** is the number to watch: a T1 draft that ran and returned
the wrong answer, plus a T2 draft for data that does not exist. Both read as an
answer. A draft that fails to run, or a question back to the user, is visible
to the analyst; these are not.

The tables printed at the end, cryptic names first, have one row per run in
`results/cryptic/` and `results/`, most correct first, with the questions per
minute the model answered at the run's concurrency (16 on a GPU, 4 through
OpenRouter) and the cost per 1,000 questions: the GPU's hourly price at that
rate, or what the API billed, spread over the answers. `--report` prints it
without running anything. Each result file records the card and how the model
was served (the vLLM image, or the API).

While it runs, it names each phase (`[4/6] asking the benchmark questions`)
and shows what it is waiting for: vLLM's stage while the model loads, read
from the pod's log every 30 seconds, and a bar of answers received with an
estimate of the time left. On a terminal the progress line updates in place;
in a log file it adds a line at most every 20 seconds. Every run also writes
its progress to `.cache/progress.log`, so a run started elsewhere can be
followed with `tail -f app/eval/bench/.cache/progress.log`.

The PWA shows the same runs in its **Model tests** tab (`/#tests`): the
cryptic-names table, then the descriptive-names table, each most correct first
with the card and vLLM version (or the API) under each model, and each tagged
OPEN or CLOSED · API with a matching stripe down its row; the fast checks and runs
stopped early, in a table of their own; a legend; and every
question's outcome per run. **Export PDF** prints it as an A4 landscape report.
With the daemon running the tab reads the checkout's `results/`, so a new run
appears at once; without it, the files built into the image. Superseded runs
(`results/superseded/`) stay out.

## Running a test from the PWA

The **Run a test** tab (`/#run`) does what the command line does. Enter a
model, a Hugging Face id or a profile name, and check it; choose a card, the
A100 unless none has stock; choose Full (the default) or Fast (`--quick`), and
cryptic names (the default) or descriptive ones; confirm the price. For a
closed model, choose **Closed model, through OpenRouter** and enter its
OpenRouter id: there is no card to choose, and the estimate is per token;
and follow the run as it goes. The finished run stays on show for two hours,
with the log it had when it finished.

Checking a model asks Hugging Face, before anything is rented, whether it
exists, is public and ungated, has safetensors weights, and generates text,
and sizes its weights from the files themselves. The card list then offers
only cards with room for it and stock right now, counting only hosts new
enough for the vLLM image (CUDA 12.8). What cannot be checked in advance is
whether vLLM serves the model well. A full run answers that as quickly as a
fast one: loading the model takes most of either, and a model that fails is
stopped within a minute of its first replies.

The PWA itself holds no RunPod key and runs no containers. A daemon on the
host does (`eval/bench/daemon.mjs`), installed as a user service by
`app/deploy/a1/install-bench-daemon.sh`. The two talk through request and
response files in `~/.local/share/banking-bench`, which the banking-dwh
quadlet mounts at `/run/bench`: files rather than a socket, because SELinux
refuses a container a connection to a host process's socket and allows a
relabelled directory. There is no port.

Guards, all enforced by the daemon, whatever the page shows:

- **Who.** Only devices listed in `BENCH_RUNNER_DEVICES` in the server's
  environment file may use the tab to start anything; others see results only.
- **One at a time.** A second run is refused while one is going.
- **Time.** A fast run is stopped at 15 minutes and a full one at 25.
- **Money.** A run whose worst case would take the day past
  `BENCH_DAILY_CAP_USD` (default $5) is refused. Today's spend is the higher
  of the daemon's own ledger and RunPod's bill, which lags by a few hours.
- **Clean-up.** Stopping a run, or the daemon, interrupts `bench.mjs` the way
  Ctrl-C does, which deletes the pod.

## Other options

| Option | Effect |
| --- | --- |
| `--dry-run` | Prints the card, its price and the estimate; rents nothing |
| `--names cryptic` | The same benchmark under abbreviated names; see [Cryptic names](#cryptic-names). The default is `descriptive` on the command line; the PWA defaults to cryptic |
| `--quick` | A smoke test: ten questions once each, saved under `results/quick/` and left out of the table. Rarely worth it: loading the model dominates a run's time and cost, and a full run stops early if most replies fail |
| `--vllm-extra JSON`, `--image REF` | Extra `vllm serve` arguments, or a different image, for an experiment, without editing the profile |
| `--no-fail-fast` | Keeps asking even when most replies fail. By default a run stops once more than half of at least eight replies have failed |
| `--card ID` | Overrides the profile's card list |
| `--community` | Community Cloud instead of Secure. Cheaper, and less predictable |
| `--repeats N`, `--concurrency N` | Default 3 and 16 |
| `--load` | Adds a load test at 1, 8 and 32 requests in flight (`--load-levels`), stopped early if a level's median passes 30 s. Adds a few minutes |
| `--max-minutes N` | Hard limit on the whole run, default 20 |
| `--openrouter ID` | A closed model through OpenRouter; see [Closed models through OpenRouter](#closed-models-through-openrouter) |
| `--weights open\|closed` | For `--endpoint`: whether the model's weights are published, which the Model tests tab marks. GPU runs are open and OpenRouter runs are looked up |
| `--endpoint URL --served-name NAME --key-file F` | Benchmarks a server that already exists; rents nothing. `--provider NAME` labels it in the results |
| `--hf ORG/NAME` | A model without a profile, with default vLLM settings; `--disk` and `--name` adjust it |
| `--resume FILE` | Keeps the answers of a stopped run and asks only the rest. A stopped run prints the file to pass |
| `--rate-limit-attempts N`, `--runner-minutes N` | For a rate-limited API: how often a question may wait for room, and how long the question phase may take |
| `--drafts FILE` | Re-scores saved answers without calling a model. Add `--names cryptic` for answers drafted against cryptic names |
| `--keep-db` | Leaves the benchmark's PostgreSQL running afterwards |
| `--cleanup` | Deletes pods an interrupted run left behind |

## Closed models through OpenRouter

`--openrouter ID` benchmarks a model you cannot download, such as Claude,
Gemini or GPT, through [OpenRouter](https://openrouter.ai). Nothing is rented,
and the questions and scoring are the same:

```bash
node eval/bench/bench.mjs --openrouter google/gemini-3.8-flash --names cryptic
node eval/bench/bench.mjs --openrouter anthropic/claude-opus-5.5 --dry-run   # price only
```

The key comes from `OPENROUTER_API_KEY` or `~/.config/openrouter-api-key`
(mode 600). Give it a credit limit on OpenRouter: that is a ceiling nothing
here can get past. Give the benchmark a key of its own too, because a run's
cost is read from the key's spend before and after.

Before anything is sent, the id is checked against OpenRouter's public model
list. The model has to exist, have a fixed price, and support structured
outputs, which the app's JSON schema needs. The check prints the list price
and an estimate for a run: typical, and worst case, where every answer thinks
up to the app's 1,600-token cap. Every request carries
`provider.require_parameters`, so OpenRouter only routes it to providers that
honour the schema. The four probes then show whether the app's request is
accepted as sent.

A full run sends 138 requests of about 4,300 prompt tokens. At list prices on
2026-09-27, Gemini 3.8 Flash costs about $0.70 (at most $1.27) and Claude
Opus 5.5 about $3.75 (at most $6.79). Opus's worst case is over the PWA's
default $5 daily cap, so the Run tab refuses it until `BENCH_DAILY_CAP_USD` is
raised. Results join the same tables, labelled "API: OpenRouter", with the
cost per 1,000 questions taken from the tokens actually billed.

Two things OpenRouter's models differ in, both handled:

- **Temperature.** Some models take none; Claude Sonnet 5 is one. With
  `require_parameters` a field no provider accepts leaves no provider at all,
  so for these the temperature is left out and the model answers at its own
  default sampling. A model that does not reason (GPT-4.1) is likewise sent
  no `reasoning_effort`. In general, a `null` in `--extra-body` or
  `MODEL_EXTRA_BODY` removes a field the app would otherwise send.
- **Rate limits.** A new OpenRouter account is held to 20 requests a minute on
  some models. OpenRouter runs therefore ask 4 at a time with up to 12
  retries. A run where replies still failed keeps its answers, and
  `--resume` asks only the failed ones again.

The questions and the synthetic catalog go to the model's provider. With a
real catalog, check that this is allowed first.

## A free API tier

Groq's free tier allows 8,000 tokens a minute and 200,000 a day for
gpt-oss-20b. A benchmark question costs about 5,000 against both (its prompt
plus the answer budget it reserves), so a day covers about 40 questions of
the 138. Run it one at a time with patience, and resume it on the following
days; a paid tier finishes it in one go, for a few cents:

```bash
node eval/bench/bench.mjs --endpoint https://api.groq.com/openai/v1 --served-name openai/gpt-oss-20b \
  --provider Groq --key-file KEYFILE --concurrency 1 --rate-limit-attempts 12 --runner-minutes 150 --max-minutes 170
# the next day, the same command plus the --resume file it printed
```

The allowance is the key's, so a benchmark run spends what the POC app would
otherwise use that day.

## Money and safety

- Every pod the benchmark creates is written to `.cache/pods.json` before it
  is used, and removed from it once deleted. Ctrl-C deletes the pod before
  exiting; if the process is killed outright, `--cleanup` deletes the pods in
  that file and no others.
- The pod is deleted as soon as the model has answered, before scoring.
- Drafts run in PostgreSQL as a user that can only read, in read-only
  transactions with a 15-second limit. The database has no network.
- The vLLM server on the pod requires a key generated for that run.
- Result files hold no pod address or key.
