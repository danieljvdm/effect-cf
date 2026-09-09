# Hosted runtime benchmark — 2026-09-09

Measured revision: [`00a1247cfff4641539ffdb3928b56e4887e32499`](https://github.com/danieljvdm/effect-cf/commit/00a1247cfff4641539ffdb3928b56e4887e32499), Effect `4.0.0-rc.112`, compatibility date `2026-08-25`, `nodejs_compat` and `new_module_registry`. Per-pipeline build versions are recorded in [versions.json](versions.json).

This is the archived hosted experiment. The current [example](../../../examples/runtime-bench/README.md) and `runtime:bench` command prepare the baseline workloads locally; they do not replay the account-specific hosted deployment, collection, and cleanup harness. The measured RPC cache was an isolated built-module prototype and is not applied by the example or current build command.

Some recorded observations are incomplete or invalid. Cohort conclusions below require complete paired repeated-request measurements and their own verification; outstanding gaps remain explicit.

Evidence: 1392 scheduled repeated requests; 2443 responses including first/warmup/setup; 1 recorded failures; 147 reconciliation issues.

Retained operator interruption: main-wrangler-http-fresh-http-large-none-b-2-i0 (phase first). It was not replayed or removed. This fixed exception keeps the whole-run complete flag false; repeated-request evidence is evaluated independently below.
Repeated-request coverage: 1392/1392 completed response timings and 1375/1392 primary CPU measurements. 8 repeated requests have incomplete target CPU; 16 have outstanding functional, context or delivery verification gaps. Exact IDs are in samples.csv.

Primary CPU is caller CPU for RPC, HTTP and telemetry, and Durable Object scheduling CPU for alarms. The table reports milliseconds; Δ is candidate minus baseline. Negative means lower. Each baseline/candidate cell gives sample count followed by p50/p95; Δ and its 95% interval summarize paired time blocks. N is matched request pairs / blocks.

| Pipeline | Case      | Comparison                  |    N |  Baseline p50 / p95 | Candidate p50 / p95 |           Δ ms [95% CI] |    Δ % |
| -------- | --------- | --------------------------- | ---: | ------------------: | ------------------: | ----------------------: | -----: |
| wrangler | count-10  | alarm-transaction           | 24/6 |   24; 36.00 / 56.85 |   24; 28.50 / 43.10 |  -11.25 [-16.25, -7.75] | -25.7% |
| wrangler | count-100 | alarm-transaction           | 24/6 | 24; 116.00 / 181.20 |   24; 43.50 / 73.25 | -71.50 [-94.00, -60.50] | -64.4% |
| vite     | count-1   | parser-cache                | 24/6 |     24; 1.00 / 2.85 |     24; 2.00 / 4.85 |      0.25 [-0.25, 1.25] |  25.0% |
| vite     | count-1   | A/A                         | 24/6 |     24; 1.00 / 2.85 |     24; 2.00 / 5.85 |       0.75 [0.50, 1.50] |  50.0% |
| vite     | count-25  | parser-cache                | 23/6 |    23; 8.00 / 17.80 |   24; 10.50 / 14.00 |      0.25 [-3.75, 3.50] |   5.2% |
| vite     | count-25  | A/A                         | 23/6 |    23; 8.00 / 17.80 |   24; 14.00 / 22.00 |      3.50 [-1.00, 9.50] |  43.8% |
| vite     | small     | runtime-reuse               | 24/6 |     24; 2.00 / 5.00 |     24; 2.00 / 3.85 |     -0.75 [-1.50, 0.75] | -35.0% |
| vite     | small     | A/A                         | 24/6 |     24; 2.00 / 5.00 |     24; 3.50 / 6.00 |       1.25 [0.75, 1.75] |  55.0% |
| vite     | large     | runtime-reuse               | 24/6 |   24; 39.50 / 58.95 |   24; 43.50 / 90.45 |     8.00 [-9.25, 29.50] |  27.0% |
| vite     | large     | A/A                         | 24/6 |   24; 39.50 / 58.95 |   24; 59.50 / 97.85 |    23.75 [12.50, 42.25] |  69.0% |
| vite     | small     | empty-metrics-configuration | 24/6 |   24; 18.50 / 30.85 |    24; 9.00 / 12.00 |  -10.50 [-13.75, -1.75] | -49.9% |
| vite     | small     | signal-loss-diagnostic      | 23/6 |   23; 17.00 / 33.30 |   24; 11.00 / 20.00 |   -5.00 [-10.50, -3.00] | -32.1% |
| vite     | count-1   | alarm-transaction           | 24/6 |   24; 19.00 / 28.85 |   24; 17.50 / 32.10 |      0.25 [-6.00, 4.25] |   3.2% |
| vite     | count-10  | alarm-transaction           | 22/6 |   23; 32.00 / 46.70 |   23; 19.00 / 33.70 |  -12.00 [-17.50, -6.25] | -35.5% |
| vite     | count-100 | alarm-transaction           | 24/6 | 24; 102.00 / 173.80 |   24; 41.00 / 71.05 | -59.00 [-66.50, -41.00] | -57.8% |
| alchemy  | count-1   | parser-cache                | 23/6 |     23; 1.00 / 3.90 |     24; 1.00 / 3.85 |     -0.25 [-1.00, 0.25] | -16.7% |
| alchemy  | count-25  | parser-cache                | 23/6 |    23; 9.00 / 15.60 |    24; 8.00 / 14.70 |      0.25 [-1.00, 2.25] |   2.6% |
| alchemy  | small     | runtime-reuse               | 24/6 |     24; 2.00 / 3.00 |     24; 2.00 / 5.00 |     -0.50 [-0.75, 1.25] | -22.5% |
| alchemy  | large     | runtime-reuse               | 22/6 |   22; 37.50 / 57.90 |   24; 45.50 / 79.60 |     5.75 [-4.25, 22.50] |  19.0% |
| alchemy  | small     | empty-metrics-configuration | 24/6 |   24; 16.00 / 30.40 |    24; 9.00 / 12.85 |   -6.75 [-16.50, -2.00] | -39.3% |
| alchemy  | small     | signal-loss-diagnostic      | 22/6 |   23; 17.00 / 25.60 |   23; 12.00 / 20.80 |    -4.00 [-8.25, -3.00] | -21.7% |
| alchemy  | count-1   | alarm-transaction           | 24/6 |   24; 18.50 / 37.70 |   24; 20.00 / 29.85 |      2.25 [-4.75, 4.75] |  12.1% |
| alchemy  | count-10  | alarm-transaction           | 24/6 |   24; 34.00 / 45.55 |   24; 25.00 / 39.00 |  -10.25 [-14.00, -1.75] | -29.2% |
| alchemy  | count-100 | alarm-transaction           | 24/6 | 24; 104.00 / 170.55 |   24; 41.50 / 64.85 | -65.00 [-83.75, -48.50] | -62.7% |
| wrangler | count-1   | parser-cache                | 23/6 |     24; 1.50 / 3.00 |     23; 1.00 / 3.00 |     -0.25 [-1.50, 0.00] | -16.7% |
| wrangler | count-25  | parser-cache                | 22/6 |   23; 11.00 / 22.40 |    23; 8.00 / 15.70 |     -2.25 [-4.50, 0.25] | -20.1% |
| wrangler | small     | runtime-reuse               | 23/6 |     24; 2.00 / 3.85 |     23; 2.00 / 4.90 |      0.00 [-0.75, 2.00] |   0.0% |
| wrangler | large     | runtime-reuse               | 22/6 |   24; 38.50 / 74.35 |   22; 54.00 / 90.55 |     20.00 [5.50, 37.25] |  61.2% |
| wrangler | small     | empty-metrics-configuration | 24/6 |   24; 20.50 / 62.55 |   24; 15.50 / 21.55 |   -5.25 [-14.75, -0.50] | -24.3% |
| wrangler | small     | signal-loss-diagnostic      | 24/6 |   24; 30.00 / 50.25 |   24; 15.00 / 45.10 |  -14.00 [-17.75, -7.50] | -44.6% |
| wrangler | count-1   | alarm-transaction           | 23/6 |   23; 22.00 / 35.70 |   24; 15.50 / 26.55 |   -4.75 [-13.50, -0.25] | -22.4% |

**RPC parser caching.** vite/count-1: A/A shows systematic difference; inference inconclusive; vite/count-25: insufficient paired main evidence; alchemy/count-1: insufficient paired main evidence; alchemy/count-25: insufficient paired main evidence; wrangler/count-1: insufficient paired main evidence; wrangler/count-25: insufficient paired main evidence

**HTTP application runtime reuse.** vite/small: A/A shows systematic difference; inference inconclusive; vite/large: A/A shows systematic difference; inference inconclusive; alchemy/small: no demonstrated useful improvement; alchemy/large: insufficient paired main evidence; wrangler/small: insufficient paired main evidence; wrangler/large: insufficient paired main evidence

**Telemetry signals.** vite/small/empty-metrics-configuration: functional or telemetry verification incomplete; vite/small/signal-loss-diagnostic: signal-loss diagnostic; not an equivalent optimization; alchemy/small/empty-metrics-configuration: functional or telemetry verification incomplete; alchemy/small/signal-loss-diagnostic: configured 100-counter diagnostic failed cardinality/delivery verification; wrangler/small/empty-metrics-configuration: meets predeclared useful-gain criterion in this cohort; wrangler/small/signal-loss-diagnostic: signal-loss diagnostic; not an equivalent optimization

**Alarm batching.** wrangler/count-10: meets predeclared useful-gain criterion in this cohort; wrangler/count-100: meets predeclared useful-gain criterion in this cohort; vite/count-1: no demonstrated useful improvement; vite/count-10: insufficient paired main evidence; vite/count-100: meets predeclared useful-gain criterion in this cohort; alchemy/count-1: no demonstrated useful improvement; alchemy/count-10: meets predeclared useful-gain criterion in this cohort; alchemy/count-100: meets predeclared useful-gain criterion in this cohort; wrangler/count-1: insufficient paired main evidence

Completed response time is measured independently and includes reading the response body. Telemetry waitUntil work and exporter finalizers may continue after the response; Worker CPU can include that later lifecycle.

| Pipeline | Case      | Comparison                  |    N |   Baseline p50 / p95 |  Candidate p50 / p95 |            Δ ms [95% CI] |    Δ % |
| -------- | --------- | --------------------------- | ---: | -------------------: | -------------------: | -----------------------: | -----: |
| wrangler | count-10  | alarm-transaction           | 24/6 |  24; 695.36 / 899.35 |  24; 711.12 / 861.49 |    6.71 [-72.90, 129.06] |   1.1% |
| wrangler | count-100 | alarm-transaction           | 24/6 |  24; 814.61 / 954.26 | 24; 710.83 / 1098.58 |  -81.15 [-142.03, 34.69] | -10.5% |
| vite     | count-1   | parser-cache                | 24/6 |  24; 179.89 / 269.98 |  24; 184.61 / 246.29 |      4.22 [-17.75, 9.36] |   2.4% |
| vite     | count-1   | A/A                         | 24/6 |  24; 179.89 / 269.98 |  24; 183.63 / 263.75 |     1.94 [-15.70, 39.46] |   1.2% |
| vite     | count-25  | parser-cache                | 24/6 |  24; 214.84 / 254.58 |  24; 214.21 / 272.10 |      4.51 [-6.89, 11.93] |   2.2% |
| vite     | count-25  | A/A                         | 24/6 |  24; 214.84 / 254.58 |  24; 228.36 / 279.00 |      22.77 [1.47, 39.46] |  11.3% |
| vite     | small     | runtime-reuse               | 24/6 |  24; 181.85 / 268.56 |  24; 181.62 / 267.56 |      -1.69 [-4.18, 8.48] |  -0.9% |
| vite     | small     | A/A                         | 24/6 |  24; 181.85 / 268.56 |  24; 182.06 / 267.40 |      3.12 [-1.18, 13.29] |   1.7% |
| vite     | large     | runtime-reuse               | 24/6 | 24; 270.13 / 1106.52 |  24; 280.86 / 465.26 |     2.07 [-37.24, 32.26] |   0.5% |
| vite     | large     | A/A                         | 24/6 | 24; 270.13 / 1106.52 |  24; 309.36 / 514.31 |    16.94 [-17.27, 86.27] |   5.9% |
| vite     | small     | empty-metrics-configuration | 24/6 |  24; 204.58 / 297.99 |  24; 188.43 / 280.83 |    -12.90 [-36.86, 7.57] |  -6.7% |
| vite     | small     | signal-loss-diagnostic      | 24/6 |  24; 206.96 / 268.33 |  24; 192.15 / 211.20 |  -13.20 [-14.57, -11.89] |  -6.5% |
| vite     | count-1   | alarm-transaction           | 24/6 |  24; 644.52 / 823.13 |  24; 663.98 / 764.48 |     0.51 [-36.72, 56.64] |   0.1% |
| vite     | count-10  | alarm-transaction           | 24/6 |  24; 680.10 / 782.45 |  24; 653.05 / 758.97 |     4.28 [-63.96, 56.59] |   0.6% |
| vite     | count-100 | alarm-transaction           | 24/6 |  24; 781.61 / 916.91 |  24; 703.56 / 943.93 |  -67.07 [-148.95, 59.55] |  -8.5% |
| alchemy  | count-1   | parser-cache                | 24/6 |  24; 181.03 / 235.95 |  24; 179.33 / 246.50 |      -0.72 [-3.26, 2.70] |  -0.4% |
| alchemy  | count-25  | parser-cache                | 24/6 |  24; 207.17 / 264.91 |  24; 210.26 / 294.79 |       0.90 [-7.17, 7.12] |   0.5% |
| alchemy  | small     | runtime-reuse               | 24/6 |  24; 181.55 / 267.21 |  24; 181.79 / 255.75 |    -2.52 [-43.49, 18.54] |  -1.4% |
| alchemy  | large     | runtime-reuse               | 24/6 |  24; 266.16 / 520.08 |  24; 274.01 / 978.89 |    16.35 [-17.33, 43.85] |   5.7% |
| alchemy  | small     | empty-metrics-configuration | 24/6 |  24; 210.91 / 272.57 |  24; 188.86 / 229.99 |   -27.47 [-52.40, -4.42] | -12.6% |
| alchemy  | small     | signal-loss-diagnostic      | 24/6 |  24; 204.01 / 335.68 |  24; 192.27 / 256.36 |    -10.83 [-13.54, 5.13] |  -5.3% |
| alchemy  | count-1   | alarm-transaction           | 24/6 |  24; 673.78 / 904.20 |  24; 658.23 / 854.65 |   20.31 [-126.87, 73.68] |   3.3% |
| alchemy  | count-10  | alarm-transaction           | 24/6 |  24; 684.89 / 836.87 |  24; 690.99 / 834.11 |   -14.59 [-65.53, 20.65] |  -2.1% |
| alchemy  | count-100 | alarm-transaction           | 24/6 | 24; 783.84 / 1007.43 |  24; 674.04 / 929.74 | -73.96 [-166.03, -14.82] | -10.5% |
| wrangler | count-1   | parser-cache                | 24/6 |  24; 181.41 / 259.74 |  24; 180.39 / 191.47 |     -0.55 [-18.06, 2.21] |  -0.3% |
| wrangler | count-25  | parser-cache                | 24/6 |  24; 218.30 / 317.31 |  24; 219.11 / 278.95 |    -3.72 [-19.22, 10.54] |  -1.9% |
| wrangler | small     | runtime-reuse               | 24/6 |  24; 181.37 / 264.40 |  24; 184.39 / 264.34 |      1.03 [-2.97, 37.10] |   0.6% |
| wrangler | large     | runtime-reuse               | 24/6 |  24; 272.56 / 412.51 |  24; 306.87 / 530.21 |     39.84 [-1.69, 72.34] |  12.9% |
| wrangler | small     | empty-metrics-configuration | 24/6 |  24; 222.54 / 782.33 |  24; 195.56 / 233.45 |   -54.76 [-64.46, -5.97] | -21.8% |
| wrangler | small     | signal-loss-diagnostic      | 24/6 |  24; 221.13 / 326.05 |  24; 195.69 / 285.06 |   -22.67 [-30.54, -8.93] | -10.3% |
| wrangler | count-1   | alarm-transaction           | 24/6 |  24; 709.87 / 924.25 |  24; 635.19 / 829.11 |  -43.54 [-176.19, -7.10] |  -6.5% |

RPC target CPU is the sum of distinct, completely joined native target invocations, reported separately from the caller. It is not added to caller CPU. Each 25-call row requires 25 distinct request IDs.

| Pipeline | Case     | Comparison   |    N | Baseline p50 / p95 | Candidate p50 / p95 |       Δ ms [95% CI] |    Δ % |
| -------- | -------- | ------------ | ---: | -----------------: | ------------------: | ------------------: | -----: |
| vite     | count-1  | parser-cache | 24/6 |    24; 0.00 / 1.85 |     24; 0.00 / 1.85 |  0.00 [-0.25, 0.25] |     —% |
| vite     | count-1  | A/A          | 24/6 |    24; 0.00 / 1.85 |     24; 0.00 / 1.00 |   0.25 [0.00, 0.50] |     —% |
| vite     | count-25 | parser-cache | 23/6 |    23; 3.00 / 6.00 |    24; 5.00 / 11.85 |   2.50 [0.50, 3.75] | 116.7% |
| vite     | count-25 | A/A          | 23/6 |    23; 3.00 / 6.00 |    24; 8.00 / 17.70 |   3.50 [2.25, 8.00] | 152.8% |
| alchemy  | count-1  | parser-cache | 23/6 |    23; 0.00 / 1.00 |     24; 0.00 / 1.00 |  0.00 [-0.25, 0.25] |     —% |
| alchemy  | count-25 | parser-cache | 23/6 |   23; 3.00 / 12.70 |    24; 3.00 / 11.70 |  1.00 [-3.00, 2.75] |  46.4% |
| wrangler | count-1  | parser-cache | 24/6 |    24; 0.00 / 1.00 |     24; 0.00 / 1.00 |   0.00 [0.00, 0.25] |     —% |
| wrangler | count-25 | parser-cache | 22/6 |   23; 3.00 / 15.80 |    23; 2.00 / 13.30 | -1.25 [-5.25, 2.00] | -35.1% |

Observed invocation outcomes (all non-setup performance phases): caller {"ok":1489,"missing":19}; target {"ok":5094,"missing":17}. Canceled/failed invocations remain in observed CPU; independent ok-only sensitivity tables are in the original analysis. Missing timings are recorded per request.

Scheduled repeated-request caller state: {"observed-reused":1344,"observed-first":38,"unknown":10}. Alarm requests use fresh object names; they measure code reuse with fresh object state.

HTTP layer behavior: 17/18 observed arm/isolate sequences verify the expected fresh/cached construction behavior. The sole unverified sequence includes the interrupted initial request, whose response headers were unavailable. Per-request header/context verification flags are preserved in samples.csv; full isolate identities and construction-counter sequences are omitted from this extract.

Collector delivery requires exactly one log and three spans per import and preserves every actual export, including duplicate finalizer snapshots. Only repeated query rows with the same script/request/event ID are deduplicated. Metrics/data point columns total exported entries across POSTs: 200 can mean two snapshots of the same 100 counters.

| Arm                                | Requests | Verified logs/traces + cardinality | POST p50 | Bytes p50 | Metrics p50 | Datapoints p50 | Logs p50 | Spans p50 |
| ---------------------------------- | -------: | ---------------------------------: | -------: | --------: | ----------: | -------------: | -------: | --------: |
| vite/telemetry-all-0               |       24 |                                 23 |        4 |      6498 |           0 |              0 |        1 |         3 |
| vite/telemetry-logs-traces-0       |       24 |                                 24 |        2 |      5418 |           0 |              0 |        1 |         3 |
| vite/telemetry-all-100             |       24 |                                 24 |        4 |     49902 |         200 |            200 |        1 |         3 |
| vite/telemetry-logs-traces-100     |       24 |                                 24 |        2 |      5436 |           0 |              0 |        1 |         3 |
| alchemy/telemetry-all-0            |       24 |                                 23 |        4 |      6525 |           0 |              0 |        1 |         3 |
| alchemy/telemetry-logs-traces-0    |       24 |                                 21 |        2 |      5439 |           0 |              0 |        1 |         3 |
| alchemy/telemetry-all-100          |       24 |                                 23 |        4 |     49929 |         200 |            200 |        1 |         3 |
| alchemy/telemetry-logs-traces-100  |       24 |                                 24 |        2 |      5457 |           0 |              0 |        1 |         3 |
| wrangler/telemetry-all-0           |       24 |                                 24 |        4 |      6533 |           0 |              0 |        1 |         3 |
| wrangler/telemetry-logs-traces-0   |       24 |                                 24 |        2 |      5446 |           0 |              0 |        1 |         3 |
| wrangler/telemetry-all-100         |       24 |                                 24 |        4 |     49938 |         200 |            200 |        1 |         3 |
| wrangler/telemetry-logs-traces-100 |       24 |                                 24 |        2 |      5464 |           0 |              0 |        1 |         3 |

A useful gain requires at least 10% lower primary CPU, a paired CPU interval below zero, complete matched main observations and functional verification, with no demonstrated completed-response latency regression. That is not a proof of latency equivalence. Vite RPC and HTTP A/A rows estimate deployment noise; the other pipelines and telemetry/alarm comparisons have no matched A/A.

Six time blocks share deployments and isolates; they are not six independent cold starts. Intervals use 10,000 block bootstrap samples and are exploratory, with no adjustment for multiple comparisons. CPU is quantized to integer milliseconds. First/warmup phases and observed first/reused cohorts are preserved in samples.csv. Nested wall durations are never added.

The 100-counter logs/traces arm deliberately discards metrics and cannot establish an equivalent optimization. The empty-registry pair still compares supported signal configurations. Alarm transaction grouping changes failure atomicity; full successful state and cleanup are checked outside the timed request.

Coverage: 29/29 arms have build/deployment evidence; 58/58 planned request cells match the declared sample design. Each request is checked against the latest recorded deployment preceding it. Reconciliation issue counts: {"response-count":1,"invalid-or-missing-response":1,"response-context":18,"layer-header-verification":4,"invocation-evidence":35,"missing-marker":28,"edge-stage-coverage":32,"target-count":12,"rpc-count-verification":7,"collector-delivery":6,"collector-cardinality":3}.

Portable evidence: [per-request samples](samples.csv), [build versions](versions.json), and [benchmark app](../../../examples/runtime-bench/README.md). CSV blanks mean missing/ineligible metrics or inapplicable checks, not zero. Samples retain all performance phases, missing metrics, verification flags, and issue codes. Provider account/host details, provider request and isolate IDs, raw collector payloads, and local paths are omitted. This is a curated extract of the completed experiment, not a replacement for the full raw telemetry archive.
