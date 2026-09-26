# Model benchmark

One command benchmarks a model end to end: it rents a GPU on RunPod, serves the
model with vLLM, sends the benchmark questions through the POC's real pipeline,
runs every drafted query against a seeded PostgreSQL copy of the warehouse,
deletes the GPU, and prints the result beside every earlier run. It is meant to
take about ten minutes and well under a dollar.

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
  "about": "What it is, where it comes from, its licence.",
  "hf": "Qwen/Qwen3.8-27B-FP8",
  "cards": ["NVIDIA L40S", "NVIDIA A100-SXM4-80GB"],
  "disk_gb": 80,
  "vllm_args": ["--max-model-len", "8192", "--gpu-memory-utilization", "0.9", "--no-enable-prefix-caching"],
  "extra_body": { "chat_template_kwargs": { "enable_thinking": false } }
}
```

| Field | Meaning |
| --- | --- |
| `hf` | The Hugging Face repository vLLM loads. It must be ungated: the pod has no Hugging Face token |
| `cards` | RunPod GPU ids to try, in order; the first with stock is rented. `--card` overrides the list |
| `disk_gb` | Container disk for the weights, about twice their size |
| `vllm_args` | Passed to `vllm serve` after the model and its served name. Keep `--no-enable-prefix-caching` so the load figures are real |
| `extra_body` | Fields sent with every request, for switches the OpenAI shape has no name for, such as a thinking mode |
| `image` | Optional: a different vLLM image, for a model the default one cannot load |

Or skip the profile for a first look: `--hf org/name --card "NVIDIA A100-SXM4-80GB"`.

Card sizes, roughly, for weights plus room to batch at an 8k context: a model
up to about 14 GB of weights fits an RTX 4090 (24 GB), up to about 35 GB an
L40S (48 GB), up to about 65 GB an A100 or H100 (80 GB).

Every run sends two probe requests the moment the server answers, one for
plain text and one for a tiny JSON schema, and prints both replies. When a
model fails, they say whether it is broken as served or only under the schema.

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

## Reading the result

```
T1 hard questions   61/69 correct (88.4%): 5 wrong result, 1 did not run, 2 asked, 0 failed
T2 unanswerable     16/18 asked, 2 drafted anyway
T3 writes           0 unsafe of 15, model wrote DML 3 times (caught)
T0 original twelve  36/36 (100%)
confidently wrong   7 (8.1% of T1+T2)
```

**Confidently wrong** is the number to watch: a T1 draft that ran and returned
the wrong answer, plus a T2 draft for data that does not exist. Both read as an
answer. A draft that fails to run, or a question back to the user, is visible
to the analyst; these are not.

The table printed at the end has one row per run in `results/`, with the
questions per minute the model answered while sixteen were in flight, and the
GPU cost per 1,000 questions at that rate. `--report` prints it without
running anything.

While it runs, it names each phase (`[4/6] asking the benchmark questions`)
and shows what it is waiting for: vLLM's stage while the model loads, read
from the pod's log every 30 seconds, and a bar of answers received with an
estimate of the time left. On a terminal the progress line updates in place;
in a log file it adds a line at most every 20 seconds. Every run also writes
its progress to `.cache/progress.log`, so a run started elsewhere can be
followed with `tail -f app/eval/bench/.cache/progress.log`.

The PWA shows the same runs in its **Model tests** tab (`/#tests`): the table,
a legend, and every question's outcome per run. With the daemon running it
reads the checkout's `results/`, so a new run appears at once; without it,
the files built into the image. Quick and superseded runs stay out, as they
do here.

## Running a test from the PWA

The **Run a test** tab (`/#run`) does what the command line does. Enter a
model, a Hugging Face id or a profile name, and check it; choose a card from
the list; choose Fast (`--quick`) or Full; confirm the price; and follow the
run as it goes. The finished run stays on show for two hours.

Checking a model asks Hugging Face, before anything is rented, whether it
exists, is public and ungated, has safetensors weights, and generates text,
and sizes its weights from the files themselves. The card list then offers
only cards with room for it and stock right now, counting only hosts new
enough for the vLLM image (CUDA 12.8). What cannot be checked in advance is
whether vLLM serves the model well; that is what a fast run is for.

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
| `--quick` | A smoke test: ten questions once each, saved under `results/quick/` and left out of the table. Use it first for a new model |
| `--vllm-extra JSON`, `--image REF` | Extra `vllm serve` arguments, or a different image, for an experiment, without editing the profile |
| `--no-fail-fast` | Keeps asking even when most replies fail. By default a run stops once more than half of at least eight replies have failed |
| `--card ID` | Overrides the profile's card list |
| `--community` | Community Cloud instead of Secure. Cheaper, and less predictable |
| `--repeats N`, `--concurrency N` | Default 3 and 16 |
| `--load` | Adds a load test at 1, 8 and 32 requests in flight (`--load-levels`), stopped early if a level's median passes 30 s. Adds a few minutes |
| `--max-minutes N` | Hard limit on the whole run, default 20 |
| `--endpoint URL --served-name NAME --key-file F` | Benchmarks a server that already exists; rents nothing |
| `--resume FILE` | Keeps the answers of a stopped run and asks only the rest. A stopped run prints the file to pass |
| `--rate-limit-attempts N`, `--runner-minutes N` | For a rate-limited API: how often a question may wait for room, and how long the question phase may take |
| `--drafts FILE` | Re-scores saved answers without calling a model |
| `--keep-db` | Leaves the benchmark's PostgreSQL running afterwards |
| `--cleanup` | Deletes pods an interrupted run left behind |

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
