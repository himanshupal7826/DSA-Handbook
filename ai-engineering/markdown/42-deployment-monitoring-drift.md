# 42 · Deployment, Monitoring & Drift

> **In one line:** Shipping a model is the start, not the finish — you serve it as a versioned service, then watch inputs, predictions, and outcomes for drift and regressions so you catch decay before your users do.

---

## 1. Overview

A trained model is a static function; the world it predicts on is not. Customers change behavior, upstream data schemas shift, a competitor launches, a holiday spikes traffic — and a model that scored `0.92` AUC at launch quietly slides to `0.78` while every dashboard stays green because *the code never changed*. **Deployment, monitoring, and drift detection** is the discipline of running a model as a live service and continuously verifying it still works, because unlike normal software, ML systems fail *silently*: no exception, no stack trace, just slowly wrong answers.

The problem has two halves. **Deployment** is getting the model behind a stable, scalable, observable interface — a REST/gRPC service, a batch job, or an embedded artifact — with safe release mechanics (canary, blue-green, rollback) so a bad model never takes down production. **Monitoring** is the harder half: traditional monitoring watches latency and errors, but an ML service can be fast, error-free, and *wrong*. You must additionally watch the **data** flowing in (has the input distribution shifted?), the **predictions** coming out (has the output distribution shifted?), and — when labels eventually arrive — the **actual quality** (has accuracy dropped?).

This matured as teams learned the expensive way that models decay. The vocabulary — **data drift** (inputs change), **concept drift** (the input→output relationship changes), **training/serving skew**, and **feedback loops** — comes from repeated production incidents. Tools like Evidently, WhyLabs, Arize, and Prometheus/Grafana emerged to make model observability as routine as APM.

A concrete example: a demand-forecasting model deployed as a service performs well until a new product category launches. Its inputs now contain SKUs the model never saw (data drift), and the relationship between features and demand shifts (concept drift). Input-monitoring catches the new distribution within hours and fires an alert; because labels (actual sales) lag by days, the drift signal is what buys time to retrain and canary a new model before the forecast errors cost real inventory dollars.

## 2. Core Concepts

- **Model serving pattern** — how predictions are delivered: **online** (low-latency REST/gRPC per request), **batch** (scheduled scoring of large sets), or **streaming** (event-driven), or **embedded** (on-device).
- **Canary / blue-green deployment** — release strategies that route a small or parallel traffic slice to the new model before full cutover, enabling safe validation and instant rollback.
- **Data drift (covariate shift)** — the distribution of input features `P(X)` changes over time while the target relationship may stay fixed.
- **Concept drift** — the relationship `P(Y|X)` between inputs and target changes; the same inputs now imply a different answer.
- **Label drift / prior shift** — the distribution of the target `P(Y)` changes (e.g. fraud rate rises).
- **Ground-truth latency** — the delay before true labels arrive (minutes to months), which determines how fast you can measure real accuracy vs proxy signals.
- **Model observability** — logging and analyzing inputs, predictions, confidence, and outcomes to explain and monitor model behavior.
- **Drift metric** — a statistical distance between a reference and current distribution: PSI, KL divergence, KS-test, or Jensen–Shannon.
- **Shadow deployment** — running a new model on live traffic without serving its predictions, to compare against production risk-free.
- **Rollback** — reverting to a previously registered model version quickly when the new one regresses.

## 3. Theory & Mathematical Intuition

A model learns a mapping from a *training* joint distribution `P_train(X, Y) = P(X)·P(Y|X)`. It stays accurate only while production data resembles that distribution. **Drift** is any change to that joint, and decomposing it tells you what to do:

- **Data drift (covariate shift):** `P(X)` changes, `P(Y|X)` fixed. The model's learned mapping is still *correct*, but it's now extrapolating into input regions it saw rarely. Often fixable by retraining on fresh data.
- **Concept drift:** `P(Y|X)` changes. The mapping itself is now *wrong* — the same customer profile that was low-risk is now high-risk. No amount of the old model helps; you must relearn the relationship.

You detect drift by comparing a **reference** distribution (training or a healthy baseline) against the **current** window. Common metrics:

```
PSI = Σ (curr_i − ref_i) · ln(curr_i / ref_i)         # Population Stability Index, per bin
KL(P‖Q) = Σ P(x) · log( P(x) / Q(x) )                  # asymmetric divergence
KS statistic = max_x | F_curr(x) − F_ref(x) |          # max CDF gap (continuous features)
```

Rules of thumb: **PSI < 0.1** = stable, `0.1–0.25` = moderate shift (investigate), **> 0.25** = significant drift (act). KS-test gives a p-value for "same distribution." The subtlety is **multiple testing**: monitoring 200 features means some will "drift" by chance — correct for it and prioritize by feature importance, since drift in an unimportant feature rarely matters.

The hard reality is **ground-truth latency**. Real accuracy needs labels, which often arrive late (did this loan default? — months). So monitoring is layered: input drift (available instantly) and prediction drift (instant) are *leading* proxies; measured accuracy (delayed) is the *lagging* truth. You act on the proxies and confirm with the truth.

The diagram shows the three drift types on the joint distribution and their monitoring signals.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="14">Drift decomposes P(X,Y) = P(X)·P(Y|X)</text>

  <rect x="40" y="55" width="200" height="90" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="140" y="80" text-anchor="middle" fill="#1e293b" font-size="12">Data drift</text>
  <text x="140" y="100" text-anchor="middle" fill="#64748b" font-size="11">P(X) changes</text>
  <text x="140" y="118" text-anchor="middle" fill="#64748b" font-size="11">P(Y|X) fixed</text>
  <text x="140" y="136" text-anchor="middle" fill="#0ea5e9" font-size="10">signal: input distribution</text>

  <rect x="260" y="55" width="200" height="90" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="360" y="80" text-anchor="middle" fill="#1e293b" font-size="12">Concept drift</text>
  <text x="360" y="100" text-anchor="middle" fill="#64748b" font-size="11">P(Y|X) changes</text>
  <text x="360" y="118" text-anchor="middle" fill="#64748b" font-size="11">mapping now wrong</text>
  <text x="360" y="136" text-anchor="middle" fill="#d97706" font-size="10">signal: accuracy drop (lagging)</text>

  <rect x="480" y="55" width="200" height="90" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="80" text-anchor="middle" fill="#1e293b" font-size="12">Label / prior shift</text>
  <text x="580" y="100" text-anchor="middle" fill="#64748b" font-size="11">P(Y) changes</text>
  <text x="580" y="118" text-anchor="middle" fill="#64748b" font-size="11">e.g. fraud rate up</text>
  <text x="580" y="136" text-anchor="middle" fill="#16a34a" font-size="10">signal: prediction distribution</text>

  <rect x="120" y="185" width="480" height="80" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="210" text-anchor="middle" fill="#1e293b" font-size="12">Detect: compare reference vs current window</text>
  <text x="360" y="232" text-anchor="middle" fill="#64748b" font-size="11">PSI &lt; 0.1 stable · 0.1–0.25 moderate · &gt; 0.25 act</text>
  <text x="360" y="252" text-anchor="middle" fill="#64748b" font-size="11">leading proxies (input/prediction) buy time before labels arrive</text>
</svg>
```

## 4. Architecture & Workflow

A monitored deployment operates as a closed loop:

1. **Package the model** as a versioned service artifact (container with the model, preprocessing, and an inference server) pulled from the registry (chapter 41).
2. **Deploy safely.** Roll out with a canary (small traffic %) or blue-green (parallel stack). Optionally run the new model in **shadow** on live traffic first, comparing predictions to production without serving them.
3. **Serve & log.** For every request, log the input features, the prediction, the confidence, model version, and latency to a monitoring store — this is the raw material for observability.
4. **Monitor operations.** Track latency (p50/p95/p99), throughput, error rate, and resource usage — the traditional layer that catches crashes and slowdowns.
5. **Monitor data & predictions.** On a rolling window, compute drift metrics (PSI/KS) per feature against the reference, and watch the prediction distribution and average confidence for shifts.
6. **Join labels when they arrive.** As ground truth lands (later), join it to logged predictions to compute real accuracy/AUC and per-segment quality; this confirms or refutes the drift proxies.
7. **Alert & triage.** Fire alerts on drift thresholds, accuracy drops, or SLA breaches. An on-call engineer inspects which features drifted and whether it's data or concept drift.
8. **Remediate.** Retrain on fresh data (data drift), roll back to a prior version (bad release), or trigger the pipeline (chapter 41) — then canary the fix. The loop closes back to deployment.

The diagram shows the serving + monitoring loop with leading and lagging signals.

```svg
<svg viewBox="0 0 740 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="d2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">Serving + monitoring closed loop</text>

  <rect x="30" y="60" width="120" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="82" text-anchor="middle" fill="#1e293b" font-size="12">Requests</text>
  <text x="90" y="98" text-anchor="middle" fill="#64748b" font-size="11">live traffic</text>

  <rect x="185" y="55" width="140" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="255" y="78" text-anchor="middle" fill="#1e293b" font-size="12">Model service</text>
  <text x="255" y="96" text-anchor="middle" fill="#64748b" font-size="11">canary / blue-green</text>

  <rect x="360" y="55" width="150" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="435" y="78" text-anchor="middle" fill="#1e293b" font-size="12">Log store</text>
  <text x="435" y="96" text-anchor="middle" fill="#64748b" font-size="11">inputs, preds, version</text>

  <rect x="360" y="150" width="150" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="435" y="171" text-anchor="middle" fill="#1e293b" font-size="12">Drift monitor</text>
  <text x="435" y="188" text-anchor="middle" fill="#64748b" font-size="10">PSI/KS (leading)</text>

  <rect x="360" y="235" width="150" height="50" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="435" y="256" text-anchor="middle" fill="#1e293b" font-size="12">Labels join</text>
  <text x="435" y="273" text-anchor="middle" fill="#64748b" font-size="10">real accuracy (lagging)</text>

  <rect x="560" y="150" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="635" y="174" text-anchor="middle" fill="#1e293b" font-size="12">Alert + triage</text>
  <text x="635" y="192" text-anchor="middle" fill="#64748b" font-size="11">retrain / rollback</text>

  <line x1="150" y1="83" x2="183" y2="83" stroke="#475569" stroke-width="1.5" marker-end="url(#d2)"/>
  <line x1="325" y1="83" x2="358" y2="83" stroke="#475569" stroke-width="1.5" marker-end="url(#d2)"/>
  <line x1="435" y1="111" x2="435" y2="148" stroke="#475569" stroke-width="1.5" marker-end="url(#d2)"/>
  <line x1="435" y1="200" x2="435" y2="233" stroke="#475569" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#d2)"/>
  <line x1="510" y1="175" x2="558" y2="178" stroke="#475569" stroke-width="1.5" marker-end="url(#d2)"/>
  <line x1="510" y1="255" x2="635" y2="212" stroke="#16a34a" stroke-width="1.3" marker-end="url(#d2)"/>
  <line x1="635" y1="150" x2="255" y2="113" stroke="#4f46e5" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#d2)"/>
  <text x="430" y="128" fill="#64748b" font-size="10">remediation redeploys the model (loop)</text>
</svg>
```

## 5. Implementation

Detecting data drift with the Population Stability Index in numpy.

```python
import numpy as np

def psi(reference, current, bins=10):
    # Bin on reference quantiles; compare population shares per bin
    edges = np.quantile(reference, np.linspace(0, 1, bins + 1))
    edges[0], edges[-1] = -np.inf, np.inf
    ref_frac = np.histogram(reference, edges)[0] / len(reference)
    cur_frac = np.histogram(current, edges)[0] / len(current)
    eps = 1e-6                                   # avoid log(0) / divide-by-zero
    ref_frac, cur_frac = ref_frac + eps, cur_frac + eps
    return float(np.sum((cur_frac - ref_frac) * np.log(cur_frac / ref_frac)))

rng = np.random.default_rng(0)
ref = rng.normal(50, 10, 10_000)                # baseline feature
ok  = rng.normal(50, 10, 5_000)                 # no shift
bad = rng.normal(58, 12, 5_000)                 # shifted
print("stable PSI:", round(psi(ref, ok), 3))    # ~0.01  -> fine
print("drift  PSI:", round(psi(ref, bad), 3))   # ~0.34  -> ACT
```

A minimal FastAPI serving endpoint that logs everything needed for monitoring.

```python
import time, json, logging
from fastapi import FastAPI
from pydantic import BaseModel
import joblib

app = FastAPI()
model = joblib.load("model.joblib")
MODEL_VERSION = "fraud_rf:v3"
log = logging.getLogger("inference")

class Req(BaseModel):
    features: list[float]

@app.post("/predict")
def predict(req: Req):
    t0 = time.time()
    proba = float(model.predict_proba([req.features])[0][1])
    latency_ms = (time.time() - t0) * 1000
    # Structured log = raw material for drift + accuracy monitoring later
    log.info(json.dumps({
        "model_version": MODEL_VERSION,
        "features": req.features,          # for input-drift analysis
        "prediction": proba,               # for prediction-drift analysis
        "latency_ms": round(latency_ms, 2),
        "ts": time.time(),
    }))
    return {"score": proba, "model_version": MODEL_VERSION}
```

Production-grade drift reporting with Evidently, plus joining delayed labels for real accuracy.

```python
import pandas as pd
from evidently.report import Report
from evidently.metric_preset import DataDriftPreset
from sklearn.metrics import roc_auc_score

reference = pd.read_parquet("reference_window.parquet")   # healthy baseline
current   = pd.read_parquet("last_24h.parquet")           # live inputs

report = Report(metrics=[DataDriftPreset()])
report.run(reference_data=reference, current_data=current)
result = report.as_dict()
share = result["metrics"][0]["result"]["share_of_drifted_columns"]
print("drifted feature share:", share)                    # e.g. 0.28 -> alert

# When ground truth arrives, join to logged predictions for the lagging truth
labeled = current.merge(pd.read_parquet("labels.parquet"), on="request_id")
auc = roc_auc_score(labeled["y_true"], labeled["prediction"])
print("realized AUC:", round(auc, 4))                     # compare vs launch AUC
```

**Optimization note:** Don't monitor all 200 features equally — weight drift alerts by feature importance, and use sampling/aggregation to keep the monitoring pipeline cheap at high QPS (log a representative sample of requests, not every one, for expensive analyses). Pre-aggregate metrics in a time-series store (Prometheus) for cheap dashboards, and reserve heavy distribution comparisons (Evidently reports) for scheduled batch jobs. Cache the reference distribution rather than recomputing it.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **Online serving** | Fresh, per-request predictions, low latency | Ops-heavy; must handle scale, availability, latency SLAs |
| **Batch serving** | Simple, cheap, high throughput | Stale predictions; not for real-time needs |
| **Canary / blue-green** | Safe rollout, instant rollback | Extra infra; needs traffic-splitting + good metrics |
| **Shadow deployment** | Risk-free comparison on live traffic | Doubles inference cost during the shadow window |
| **Input drift monitoring** | Instant leading signal, no labels needed | Drift ≠ performance drop; false alarms possible |
| **Accuracy monitoring** | The real truth about quality | Needs labels; often delayed by days/months |
| **Automated retraining** | Keeps model fresh, less toil | Can amplify feedback loops / bad data if unguarded |

## 7. Common Mistakes & Best Practices

1. ⚠️ Monitoring only latency/errors → ✅ Add data, prediction, and accuracy monitoring; an ML service can be fast, error-free, and wrong.
2. ⚠️ Assuming a green build means the model still works → ✅ Models decay with no code change; watch drift and outcomes continuously.
3. ⚠️ Not logging inputs and predictions → ✅ Log features, prediction, confidence, and model version per request; you can't debug what you didn't record.
4. ⚠️ Treating any drift as a problem → ✅ Prioritize by feature importance and confirm with performance; drift in a trivial feature rarely matters.
5. ⚠️ Waiting for labels to notice failure → ✅ Use input/prediction drift as leading proxies since ground truth lags; act before accuracy is measurable.
6. ⚠️ Full-cutover deploys with no canary → ✅ Canary or blue-green with a rollback path; validate on a slice before 100% traffic.
7. ⚠️ Confusing data drift with concept drift → ✅ Diagnose which: data drift may just need retraining; concept drift means the relationship changed and old data won't help.
8. ⚠️ Ignoring multiple-testing across many features → ✅ Correct thresholds and rank alerts; 200 features guarantee some spurious "drift."
9. ⚠️ Blindly auto-retraining on live data → ✅ Guard retraining with validation and human review; feedback loops and poisoned data can make it worse.
10. ⚠️ No per-segment monitoring → ✅ Track slices (region, device, cohort); aggregate accuracy can hide a collapsed segment.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When quality drops, start from the logs: has input drift risen (which features)? Has the prediction distribution shifted? Is it one segment or all? Data drift with stable `P(Y|X)` points to retraining; a sudden step change often means a broken upstream feature or a schema change (check data validation). If offline metrics were fine but live isn't, suspect train/serve skew. Reproduce with the exact registered model version to rule out a bad release.

**Monitoring.** Layer the signals: operational (latency p50/p95/p99, error rate, throughput, saturation), data (per-feature PSI/KS, missing-value rates, new categorical values), prediction (output distribution, mean confidence), and outcome (accuracy/AUC per segment once labels arrive). Dashboard model version alongside every metric so you can attribute changes to releases. Alert on drift thresholds, accuracy drops, and SLA breaches, but tune to avoid alert fatigue.

**Security.** Prediction endpoints face the usual API threats plus ML-specific ones: model-extraction (adversaries querying to clone your model — rate-limit and monitor query patterns), adversarial inputs crafted to force errors, and membership-inference on sensitive training data. Access-control and audit-log the endpoint, avoid leaking confidence scores or internals unnecessarily, and scrub PII from logged features. For LLM endpoints, add prompt-injection and output filtering.

**Performance & Scaling.** Autoscale online serving on latency/QPS; use batch or async for non-real-time workloads. Sample logs at high QPS to keep monitoring affordable, pre-aggregate in a time-series DB, and run heavy drift reports as scheduled batch jobs. Separate the monitoring pipeline from the serving path so analysis never adds request latency. For rollout at scale, canary by percentage with automated rollback wired to the alert conditions.

## 9. Interview Questions

**Q: Why do ML systems need monitoring beyond normal software monitoring?**
A: Traditional monitoring catches crashes, errors, and latency, but an ML service can be perfectly healthy on all of those and still return increasingly wrong predictions as the world changes. Models fail silently — no exception, just declining accuracy. So you must additionally monitor input data, prediction distributions, and (when labels arrive) real accuracy.

**Q: What is the difference between data drift and concept drift?**
A: Data drift (covariate shift) is when the input distribution `P(X)` changes while the input→output relationship `P(Y|X)` stays the same — the model's mapping is still correct but sees unfamiliar inputs. Concept drift is when `P(Y|X)` itself changes — the same inputs now imply a different answer, so the learned mapping is wrong. Data drift is often fixed by retraining on fresh data; concept drift requires relearning the relationship.

**Q: How do you detect drift, and what does PSI tell you?**
A: Compare a reference distribution (training or a healthy baseline) against a current window using statistical distances like PSI, KL divergence, or the KS-test. PSI sums per-bin population differences weighted by log-ratio: below `0.1` is stable, `0.1–0.25` is moderate shift worth investigating, and above `0.25` signals significant drift requiring action.

**Q: What is ground-truth latency and why does it shape monitoring?**
A: Ground-truth latency is the delay before true labels become available — minutes for clicks, months for loan defaults. Because you can't measure real accuracy until labels arrive, you rely on leading proxies (input and prediction drift, available instantly) to catch problems early and confirm with the lagging accuracy signal once labels land.

**Q: What are canary and blue-green deployments?**
A: Canary routes a small percentage of live traffic to the new model, validating it on real requests before ramping to 100%, with instant rollback if metrics degrade. Blue-green runs the new version as a parallel full stack and switches traffic over atomically (and back on failure). Both limit blast radius and enable fast rollback compared to a full cutover.

**Q: What is a shadow deployment?**
A: A shadow deployment runs the new model on live traffic in parallel with production but does not serve its predictions to users — they're only logged and compared. It lets you validate a candidate on real inputs with zero user risk, at the cost of extra inference compute during the shadow window. It's ideal before promoting a model whose live behavior is uncertain.

**Q: Why prioritize drift alerts by feature importance?**
A: Monitoring many features guarantees some will appear to drift by chance (multiple testing), and drift in a low-importance feature usually doesn't affect predictions. Weighting alerts by each feature's contribution to the model focuses attention on shifts that actually threaten performance and reduces alert fatigue from irrelevant fluctuations.

**Q: (Senior) Your model's live accuracy dropped but no input feature shows drift. What's happening?**
A: That pattern points to concept drift — the input distribution `P(X)` is unchanged but the relationship `P(Y|X)` shifted, so inputs look normal while answers are now wrong (e.g. a new fraud tactic reuses old-looking features). Input-drift monitors are blind to it; you catch it only via the accuracy/outcome signal. Remediate by retraining on recent labeled data that captures the new relationship, and consider more frequent retraining if the concept is unstable.

**Q: (Senior) Design a monitoring strategy when labels take 60 days to arrive.**
A: Lean on leading proxies: monitor input drift (PSI/KS per important feature) and prediction-distribution/confidence shifts in near-real-time, plus operational metrics. Use these to trigger investigation and canary decisions immediately. Build a delayed pipeline that joins labels as they arrive to compute true accuracy per cohort, and backfill dashboards. Optionally collect a small fast-labeled sample (human review) as an early accuracy estimate, and use business KPIs as an intermediate proxy.

**Q: (Senior) A feedback loop is degrading your model. Explain and mitigate.**
A: A feedback loop occurs when the model's own predictions influence future training data — e.g. a recommender only shows items it rates highly, so it never gets data on items it suppressed, reinforcing its bias. Symptoms include narrowing diversity and drift that retraining worsens. Mitigate with exploration (serve some randomized/holdout traffic to gather unbiased labels), logging propensities for debiased training, and guarding automated retraining with validation and human review.

**Q: (Senior) How do you build automated rollback into a deployment?**
A: Deploy via canary with the previous registered version kept warm and one-command deployable. Wire the alert conditions (accuracy drop on fast labels, prediction-drift spike, latency/error SLA breach) to an automated trigger that reverts traffic to the prior version and pages on-call. Keep deployments as immutable versioned artifacts from the registry so rollback is deterministic, and rehearse it — an untested rollback is not a rollback.

**Q: What should you log per prediction for good observability?**
A: Log the input features, the prediction and its confidence, the model version, latency, a request id, and a timestamp. This enables input-drift analysis, prediction-drift analysis, later joining of ground-truth labels for accuracy, per-segment slicing, and attribution of behavior changes to specific model releases. Scrub PII and sample at high QPS to control cost.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Deploying a model is the start: serve it as a versioned, observable service and release safely with canary/blue-green (and shadow for risk-free validation) so a bad model can be rolled back instantly. ML fails silently, so monitor three layers beyond latency/errors: input data drift `P(X)`, prediction drift, and — when labels arrive — real accuracy. Decompose drift: data drift (`P(X)` changes, retrain) vs concept drift (`P(Y|X)` changes, relearn). Detect with PSI (`>0.25` = act), KS, or KL against a reference window. Because ground truth lags, input/prediction drift are leading proxies you act on before accuracy is measurable. Log everything per request, prioritize alerts by feature importance, monitor per segment, and guard automated retraining against feedback loops.

| Signal | Availability | Catches |
|---|---|---|
| Latency/errors | instant | crashes, slowdowns |
| Input drift (PSI/KS) | instant | data drift (leading) |
| Prediction drift | instant | output shift, label shift |
| Accuracy (labels) | delayed | concept drift (lagging truth) |
| Per-segment metrics | with labels | hidden cohort collapse |

**Flash cards**
- **Data vs concept drift** → data: `P(X)` changes (retrain); concept: `P(Y|X)` changes (relearn).
- **PSI thresholds** → `<0.1` stable, `0.1–0.25` moderate, `>0.25` act.
- **Why leading proxies** → labels lag, so input/prediction drift warns before accuracy can be measured.
- **Canary vs shadow** → canary serves a small % of real traffic; shadow serves none, just logs/compares.
- **Silent failure** → model can be fast and error-free yet increasingly wrong; monitor outcomes.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement PSI and KS drift metrics and validate them on synthetic shifted vs stable distributions.
- [ ] Add structured per-request logging (features, prediction, version, latency) to a serving endpoint.
- [ ] Generate an Evidently data-drift report comparing a reference window to a drifted current window.
- [ ] Simulate delayed labels, join them to logged predictions, and compute realized accuracy over time.
- [ ] Script a canary rollout with automated rollback triggered by a drift or accuracy threshold.

**Mini Project: A Model Observability Dashboard.**
Goal: deploy a model and build a monitoring loop that detects decay.
Requirements: (1) serve a classifier behind a REST endpoint with full structured logging; (2) compute per-feature drift (PSI/KS) on a rolling window against a reference; (3) simulate delayed labels and compute realized accuracy per segment; (4) build a dashboard (Grafana/Streamlit) showing operational, drift, and accuracy signals with model version overlaid.
Extensions: add a canary deployment with automated rollback on threshold breach; inject a concept-drift scenario (change `P(Y|X)`) and show only accuracy — not input drift — catches it; wire a drift alert to trigger the retraining pipeline from chapter 41.

## 12. Related Topics & Free Learning Resources

Related chapters: **MLOps: Pipelines, CI/CD & Registries** (the training/registry loop that retraining triggers close into), **Serving LLMs: vLLM, Batching & Throughput** (serving mechanics for LLM endpoints), **GPU Computing & Distributed Training** (retraining the model you monitor), and **Fine-Tuning, LoRA & QLoRA** (versioning and canarying updated adapters).

**Free Learning Resources**
- **Evidently AI documentation & tutorials** — Evidently · *Intermediate* · practical data-drift and model-quality monitoring with runnable examples. <https://docs.evidentlyai.com/>
- **A Comprehensive Guide on How to Monitor Your Models in Production** — Neptune.ai blog · *Intermediate* · the layers of ML monitoring and what to track. <https://neptune.ai/blog/how-to-monitor-your-models-in-production-guide>
- **Google Cloud: ML Model Monitoring / Skew and Drift Detection** — Google · *Advanced* · production drift detection concepts and thresholds. <https://cloud.google.com/vertex-ai/docs/model-monitoring/overview>
- **Machine Learning in Production (MLOps) — Monitoring** — DeepLearning.AI (audit free) · *Intermediate* · deployment patterns, concept/data drift, and monitoring. <https://www.deeplearning.ai/courses/machine-learning-engineering-for-production-mlops/>
- **An Introduction to Concept Drift** — Papers With Code / survey references · *Advanced* · formal treatment of drift types and detectors. <https://paperswithcode.com/task/concept-drift-detection>
- **Awesome MLOps: Monitoring** — community list · *Beginner* · curated tools and articles for model observability. <https://github.com/visenger/awesome-mlops>
- **Prometheus documentation** — Prometheus · *Intermediate* · time-series metrics and alerting for the operational monitoring layer. <https://prometheus.io/docs/introduction/overview/>

---

*AI Engineering Handbook — chapter 42.*
