# 41 · MLOps: Pipelines, CI/CD & Registries

> **In one line:** MLOps makes machine learning reproducible and shippable — versioning data, code, and models; automating training pipelines; and gating every model through a registry and CI/CD before it reaches production.

---

## 1. Overview

A model that works in a notebook is a demo; a model that keeps working in production, retrains on fresh data, and can be rolled back in minutes is a *system*. **MLOps** is the discipline of building that system — bringing the reproducibility, automation, and testing culture of DevOps to machine learning, plus the extra headaches ML adds: data changes, models decay, and "it works on my machine" hides a random seed, a stale CSV, and an untracked dependency.

The core problem MLOps solves is that ML has **three moving parts, not one**. Traditional software versions code. ML systems must version *code + data + model* together, because the same code on different data produces a different model, and the same model behaves differently on different data. Without disciplined versioning you cannot reproduce yesterday's result, explain why accuracy dropped, or safely roll back a bad model. Add that ML artifacts are large (gigabyte checkpoints, terabyte datasets) and training is expensive and non-deterministic, and ad-hoc workflows collapse under their own weight.

MLOps emerged around 2018–2020 as teams industrializing ML hit these walls; Google's "Hidden Technical Debt in ML Systems" paper crystallized that the model is a tiny box in a huge diagram of surrounding infrastructure. The response was a toolchain: **DVC/LakeFS** for data versioning, **MLflow/Weights & Biases** for experiment tracking, orchestrators like **Airflow/Kubeflow/Prefect** for pipelines, a **model registry** as the source of truth for what's deployable, and **CI/CD** adapted to test and promote models.

A concrete example: a fraud-detection team retrains weekly on new transactions. A pipeline pulls a versioned data snapshot, trains, evaluates against a fixed test set and last week's champion, logs everything to MLflow, and — only if it beats the incumbent on AUC without regressing latency — registers the new model and promotes it to a canary. If the canary's live metrics look good after 24 hours, CD promotes it to full traffic; if not, one command rolls back to the previous registered version. Every step is logged, reproducible, and auditable.

## 2. Core Concepts

- **Reproducibility** — the ability to recreate a model exactly from pinned code, data version, environment, and random seeds.
- **Data versioning** — snapshotting datasets (e.g. with DVC/LakeFS) so a training run references an immutable data hash, not a mutable file.
- **Experiment tracking** — logging params, metrics, code version, and artifacts of each run (MLflow, W&B) so results are comparable and searchable.
- **Pipeline / DAG** — an orchestrated sequence of steps (ingest → validate → train → evaluate → register) with dependencies, run by Airflow/Kubeflow/Prefect.
- **Model registry** — a versioned store of trained models with stages (staging, production, archived), lineage, and metadata; the single source of truth for deployables.
- **Model lineage** — the recorded chain linking a model to its exact code, data, hyperparameters, and environment.
- **CI for ML** — automated tests on every change: data validation, unit tests, training smoke tests, and model-quality gates.
- **CD for ML** — automated promotion of a passing model through staging → canary → production, with rollback.
- **Feature store** — a central, versioned repository of features shared between training and serving to prevent train/serve skew.
- **Training/serving skew** — the bug where features are computed differently in training vs production, silently degrading live accuracy.

## 3. Theory & Mathematical Intuition

MLOps is less about equations and more about a **reproducibility function**. Think of a trained model `M` as the deterministic output of a function over four inputs:

```
M = train(code_version, data_version, hyperparams, seed, environment)
```

If any input is unpinned, `M` is irreproducible — you cannot get the same model back, cannot A/B fairly, and cannot debug a regression. MLOps' whole job is to make every argument of that function an immutable, recorded reference. Data versioning pins `data_version` (a content hash, not a filename); a lockfile/container pins `environment`; the experiment tracker records `hyperparams` and `seed`; git pins `code_version`. Given all four, `train(...)` is (approximately) reproducible — the remaining nondeterminism (GPU floating-point, parallel reductions) is bounded and often controllable with deterministic flags.

The second idea is the **promotion gate** as a decision rule. A candidate model `M_cand` should replace the champion `M_prod` only if it satisfies a conjunction of conditions on a *fixed* evaluation set:

```
promote if:  metric(M_cand) ≥ metric(M_prod) + δ        # meaningfully better
        and  latency(M_cand) ≤ SLA
        and  no_regression(slices)                        # per-segment fairness/quality
        and  passes(data_and_model_tests)
```

The `δ` margin guards against promoting noise — a `0.1%` AUC bump within confidence intervals isn't real. Evaluating on a *frozen* test set (not the latest data, which changes) is what makes comparisons across weeks meaningful. This is the ML analogue of a passing test suite gating a merge.

The diagram shows the three versioned artifacts converging into a reproducible run and a registered model.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="m2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="14">Reproducibility = version(code + data + env) → run → registry</text>

  <rect x="40" y="55" width="130" height="44" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="105" y="77" text-anchor="middle" fill="#1e293b" font-size="12">Code (git sha)</text>
  <text x="105" y="93" text-anchor="middle" fill="#64748b" font-size="10">params, seed</text>
  <rect x="40" y="115" width="130" height="44" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="137" text-anchor="middle" fill="#1e293b" font-size="12">Data (dvc hash)</text>
  <text x="105" y="153" text-anchor="middle" fill="#64748b" font-size="10">immutable snapshot</text>
  <rect x="40" y="175" width="130" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="105" y="197" text-anchor="middle" fill="#1e293b" font-size="12">Env (container)</text>
  <text x="105" y="213" text-anchor="middle" fill="#64748b" font-size="10">pinned deps</text>

  <rect x="270" y="105" width="150" height="64" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="345" y="132" text-anchor="middle" fill="#1e293b" font-size="12">Training run</text>
  <text x="345" y="150" text-anchor="middle" fill="#64748b" font-size="11">logged to MLflow</text>

  <rect x="500" y="70" width="180" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="590" y="94" text-anchor="middle" fill="#1e293b" font-size="12">Model Registry</text>
  <text x="590" y="112" text-anchor="middle" fill="#64748b" font-size="11">v3 · staging/prod</text>
  <rect x="500" y="145" width="180" height="56" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="590" y="168" text-anchor="middle" fill="#1e293b" font-size="12">Metrics + lineage</text>
  <text x="590" y="186" text-anchor="middle" fill="#64748b" font-size="11">reproduce any run</text>

  <line x1="170" y1="77" x2="268" y2="120" stroke="#475569" stroke-width="1.4" marker-end="url(#m2)"/>
  <line x1="170" y1="137" x2="268" y2="137" stroke="#475569" stroke-width="1.4" marker-end="url(#m2)"/>
  <line x1="170" y1="197" x2="268" y2="155" stroke="#475569" stroke-width="1.4" marker-end="url(#m2)"/>
  <line x1="420" y1="130" x2="498" y2="105" stroke="#475569" stroke-width="1.4" marker-end="url(#m2)"/>
  <line x1="420" y1="145" x2="498" y2="168" stroke="#475569" stroke-width="1.4" marker-end="url(#m2)"/>
</svg>
```

## 4. Architecture & Workflow

A production ML pipeline runs as an orchestrated DAG:

1. **Ingest & version data.** Pull raw data, snapshot it with DVC/LakeFS so the run pins an immutable data hash. Record the snapshot id.
2. **Validate data.** Run schema and distribution checks (Great Expectations / TFDV): types, ranges, null rates, and drift vs the previous snapshot. Fail fast on anomalies before wasting compute.
3. **Build features.** Compute features via shared code or a feature store so training and serving use identical logic (no skew). Materialize a versioned feature set.
4. **Train.** Run training in a pinned container with logged hyperparameters and seed. Stream metrics and the final artifact to the experiment tracker.
5. **Evaluate & gate.** Score on a frozen test set and per-segment slices; compare against the current production champion with a margin `δ`; check latency and fairness. Only passing candidates proceed.
6. **Register.** Push the passing model to the registry with a new version, its lineage (code sha, data hash, env), metrics, and a `staging` stage tag.
7. **CI checks.** On the PR/commit that triggered this, run unit tests, a training smoke test on a tiny sample, and the model-quality gate; block merge on failure.
8. **CD promote.** Deploy the registered model to a canary receiving a small traffic slice; monitor live metrics; on success promote to `production`, else roll back to the prior version — all via the registry stage transition.
9. **Schedule & trigger.** Re-run on a schedule (weekly) or on triggers (drift detected, new data volume), closing the loop back to step 1.

The diagram shows the end-to-end pipeline and CI/CD gates.

```svg
<svg viewBox="0 0 740 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="p2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">ML pipeline with CI/CD gates</text>

  <rect x="20" y="55" width="110" height="42" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="75" y="80" text-anchor="middle" fill="#1e293b" font-size="11">Ingest + version</text>
  <rect x="150" y="55" width="110" height="42" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="205" y="80" text-anchor="middle" fill="#1e293b" font-size="11">Validate data</text>
  <rect x="280" y="55" width="110" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="335" y="80" text-anchor="middle" fill="#1e293b" font-size="11">Train</text>
  <rect x="410" y="55" width="120" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="470" y="74" text-anchor="middle" fill="#1e293b" font-size="11">Evaluate + gate</text>
  <text x="470" y="90" text-anchor="middle" fill="#64748b" font-size="9">vs champion + δ</text>

  <rect x="560" y="55" width="150" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="635" y="74" text-anchor="middle" fill="#1e293b" font-size="11">Model Registry</text>
  <text x="635" y="90" text-anchor="middle" fill="#64748b" font-size="9">v_n · staging</text>

  <line x1="130" y1="76" x2="148" y2="76" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="260" y1="76" x2="278" y2="76" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="390" y1="76" x2="408" y2="76" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="530" y1="76" x2="558" y2="76" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>

  <rect x="200" y="150" width="150" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="275" y="170" text-anchor="middle" fill="#1e293b" font-size="11">CI: tests + smoke</text>
  <text x="275" y="186" text-anchor="middle" fill="#64748b" font-size="9">data + model checks</text>
  <rect x="400" y="150" width="130" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="465" y="170" text-anchor="middle" fill="#1e293b" font-size="11">CD: canary</text>
  <text x="465" y="186" text-anchor="middle" fill="#64748b" font-size="9">small traffic %</text>
  <rect x="580" y="150" width="130" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="645" y="170" text-anchor="middle" fill="#1e293b" font-size="11">Production</text>
  <text x="645" y="186" text-anchor="middle" fill="#64748b" font-size="9">or rollback</text>

  <line x1="635" y1="97" x2="465" y2="148" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="350" y1="173" x2="398" y2="173" stroke="#475569" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="530" y1="173" x2="578" y2="173" stroke="#16a34a" stroke-width="1.4" marker-end="url(#p2)"/>
  <line x1="465" y1="196" x2="465" y2="215" stroke="#d97706" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#p2)"/>
  <text x="540" y="222" fill="#64748b" font-size="10">fail → rollback to v_(n-1)</text>

  <rect x="20" y="240" width="240" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="140" y="262" text-anchor="middle" fill="#1e293b" font-size="11">Schedule / drift trigger</text>
  <text x="140" y="279" text-anchor="middle" fill="#64748b" font-size="10">re-runs the pipeline (closes loop)</text>
  <line x1="140" y1="240" x2="75" y2="99" stroke="#0ea5e9" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#p2)"/>
</svg>
```

## 5. Implementation

Experiment tracking and registration with MLflow — the reproducibility backbone.

```python
import mlflow, mlflow.sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score

mlflow.set_tracking_uri("http://mlflow:5000")
mlflow.set_experiment("fraud-detection")

with mlflow.start_run(run_name="rf-v3") as run:
    params = {"n_estimators": 300, "max_depth": 12, "random_state": 42}
    mlflow.log_params(params)
    mlflow.set_tag("data_version", "dvc:9f3a1c")     # pin the data snapshot -> lineage
    mlflow.set_tag("git_sha", "e02569b")

    model = RandomForestClassifier(**params).fit(X_train, y_train)
    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("test_auc", auc)               # logged against a FROZEN test set

    # Register only the artifact; promotion is a separate gated step
    mlflow.sklearn.log_model(model, artifact_path="model",
                             registered_model_name="fraud_rf")
    print(run.info.run_id, "auc=", round(auc, 4))
```

Data versioning with DVC so the pipeline references an immutable data hash.

```bash
dvc init
dvc add data/transactions.parquet        # tracks content hash, stores blob in remote
git add data/transactions.parquet.dvc .gitignore
git commit -m "data: transactions snapshot v3"
dvc remote add -d storage s3://ml-artifacts/dvc
dvc push                                  # large file goes to S3, hash stays in git
# Anyone can reproduce: git checkout <sha> && dvc pull  -> exact same data
```

A promotion gate that compares a candidate against the production champion before staging it.

```python
from mlflow.tracking import MlflowClient

client = MlflowClient()

def promote_if_better(name: str, candidate_version: str, delta: float = 0.005):
    cand = client.get_model_version(name, candidate_version)
    cand_auc = float(client.get_run(cand.run_id).data.metrics["test_auc"])

    prod = [m for m in client.get_latest_versions(name, ["Production"])]
    prod_auc = 0.0
    if prod:
        prod_auc = float(client.get_run(prod[0].run_id).data.metrics["test_auc"])

    if cand_auc >= prod_auc + delta:                 # meaningful improvement only
        client.transition_model_version_stage(name, candidate_version, "Staging")
        print(f"promoted v{candidate_version} to Staging ({cand_auc:.4f} > {prod_auc:.4f})")
    else:
        print(f"rejected v{candidate_version}: {cand_auc:.4f} !>= {prod_auc:.4f}+{delta}")

promote_if_better("fraud_rf", candidate_version="3")
```

**Optimization note:** Keep pipelines **idempotent and cached** — step outputs keyed by input hashes (DVC, Kubeflow caching) so re-runs skip unchanged stages, turning a 2-hour pipeline into minutes on a small change. Separate *cheap* CI (unit tests, tiny-sample smoke train on every commit) from *expensive* scheduled full training, so PRs stay fast. Store the frozen evaluation set under version control so gate comparisons remain apples-to-apples over time.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **Reproducibility** | Recreate any model; audit and debug | Upfront discipline; must pin data/env/seed |
| **Data versioning (DVC)** | Immutable snapshots, git-like workflow | Extra storage; large-file remote to manage |
| **Experiment tracking** | Compare/search runs; kill lost results | Another service to run and instrument |
| **Model registry** | Single source of truth, staged promotion | Governance overhead; must enforce it |
| **Pipelines / orchestration** | Automated, retryable, scheduled | Infra complexity; DAG maintenance |
| **CI/CD for ML** | Safe, fast, gated releases | Quality gates are harder than pass/fail tests |
| **Feature store** | Kills train/serve skew, reuse | Heavy infra; overkill for small teams |

## 7. Common Mistakes & Best Practices

1. ⚠️ Versioning code but not data → ✅ Pin an immutable data hash per run (DVC/LakeFS); same code + different data = different model.
2. ⚠️ Training in an unpinned environment → ✅ Use a container + lockfile; "works on my machine" is an irreproducibility bug.
3. ⚠️ Evaluating candidates on the latest (changing) data → ✅ Compare against a frozen test set so weekly comparisons are meaningful.
4. ⚠️ Promoting on any metric bump → ✅ Require a margin `δ` beyond noise and check per-segment slices, not just the aggregate.
5. ⚠️ Train/serve feature skew → ✅ Share feature code or a feature store so both paths compute features identically.
6. ⚠️ Manual, click-driven deployment → ✅ Automate promotion via the registry + CD so releases are repeatable and rollbackable.
7. ⚠️ No lineage from model to data/code → ✅ Tag every registered model with its git sha, data hash, and env for auditability.
8. ⚠️ Heavyweight tooling on day one → ✅ Start with git + DVC + MLflow; add Kubeflow/feature stores only when scale demands.
9. ⚠️ Running expensive full training on every commit → ✅ Split cheap CI (smoke tests) from scheduled/triggered full runs.
10. ⚠️ No rollback plan → ✅ Keep the previous production version registered and one-command deployable; canary before full rollout.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a model regresses, lineage is everything: pull the run's code sha, data hash, and params from the registry and reproduce it exactly. A common culprit is a silent data-schema change that passed unvalidated — add stricter data tests. If a candidate mysteriously beats the champion, verify they were scored on the *same* frozen test set with the same preprocessing (leakage or skew often explains "too good" results).

**Monitoring.** Track pipeline health (run success rate, step durations, cache hit rate), data-validation failures, and — for each model version — its evaluation and live metrics. Alert on failed data validation, pipeline failures, and gate rejections trending up (data quality decaying). Keep dashboards linking model version → live performance for fast incident triage.

**Security.** Registries and artifact stores are supply-chain surfaces: sign and access-control model artifacts, since a tampered checkpoint is remote code that runs in production. Guard training data provenance against poisoning, scan dependencies (a malicious pickle in a model file is an RCE), and restrict who can transition a model to `production`. Log every stage transition for audit and compliance (who promoted what, when, why).

**Performance & Scaling.** Make pipelines idempotent and content-cached so unchanged steps skip. Parallelize independent DAG branches and distribute training (chapter 40). Use lightweight tooling for small teams and graduate to Kubeflow/Argo/Vertex/SageMaker Pipelines as job volume grows. Store artifacts in object storage with lifecycle policies (archive old versions) to control cost.

## 9. Interview Questions

**Q: Why is MLOps harder than traditional DevOps?**
A: Traditional software versions one artifact — code. ML systems must version code, data, and model together, because the same code on different data yields a different model. Data drifts, models decay, artifacts are large, and training is expensive and non-deterministic, so reproducibility, testing, and monitoring all require ML-specific tooling beyond standard CI/CD.

**Q: What are the three things you must version for reproducibility?**
A: Code (git sha, including hyperparameters and seed), data (an immutable snapshot/hash via DVC or LakeFS), and environment (a container with pinned dependencies). With all three plus the seed pinned, a training run is reproducible; leaving any unpinned makes the resulting model impossible to recreate or debug.

**Q: What is a model registry and why do you need one?**
A: A model registry is a versioned store of trained models with stages (staging, production, archived), metrics, and lineage — the single source of truth for what is deployable. It decouples training from deployment, enables gated promotion and one-command rollback, and provides an audit trail of who deployed which version when.

**Q: What is training/serving skew and how do you prevent it?**
A: It's when features are computed differently during training than in production serving, so the model sees inconsistent inputs and live accuracy silently degrades. Prevent it by sharing the exact feature-computation code between training and serving, or by using a feature store that materializes the same features for both paths.

**Q: How does CI/CD differ for ML versus regular software?**
A: CI adds data validation, training smoke tests, and model-quality gates on top of unit tests; the pass/fail criterion is a statistical comparison (does the candidate beat the champion by a margin on a frozen set, without regressing slices or latency?) rather than a deterministic test. CD promotes a registered model through staging → canary → production with live-metric checks and rollback, since a "green build" model can still fail on real traffic.

**Q: Why compare a candidate model against a frozen test set instead of the latest data?**
A: The latest data changes every run, so scores computed on it aren't comparable week to week — you can't tell whether a metric moved because the model improved or the data got easier/harder. A frozen, versioned test set holds the yardstick constant, making cross-run and champion-vs-challenger comparisons valid.

**Q: What does a data-versioning tool like DVC actually store?**
A: DVC stores a small metadata file (a content hash and pointer) in git while pushing the large data blob to a remote like S3. Checking out a git commit and running `dvc pull` retrieves the exact data that commit referenced, so code and data versions stay in lockstep without bloating the git repo.

**Q: (Senior) Design a promotion gate for a model that must not regress any customer segment.**
A: Evaluate the candidate and current champion on the same frozen test set, both overall and sliced by each segment. Require the aggregate metric to improve by a margin `δ` beyond confidence-interval noise, and require no segment to regress beyond a small tolerance. Add latency/SLA and fairness checks. Only if all conditions hold does the registry transition the model to staging; then a canary validates on live traffic before full promotion, with automatic rollback on regression.

**Q: (Senior) A model that passed all offline gates degraded in production. Walk through diagnosis.**
A: First suspect train/serve skew — verify features are computed identically offline and online. Next check for data drift: the live input distribution may differ from the frozen test set, so offline metrics don't predict live performance. Look for leakage that inflated offline scores, a label-availability delay masking true accuracy, and feedback loops. Use lineage to reproduce the exact model, add online monitoring, and tighten data validation and the canary window.

**Q: (Senior) How would you bootstrap MLOps for a small team without over-engineering?**
A: Start minimal: git for code, DVC for data, a container + lockfile for environment, and MLflow for tracking and a simple registry. Add a scripted training pipeline with a frozen-test-set quality gate and manual-but-recorded promotion. Introduce orchestration (Airflow/Prefect), a feature store, and full CD only when job volume, team size, or reliability needs justify the complexity — avoid buying Kubeflow before you have the scale to use it.

**Q: What is model lineage and why does it matter?**
A: Lineage is the recorded chain linking a deployed model back to its exact code version, data snapshot, hyperparameters, and environment. It matters for debugging regressions (reproduce the exact model), auditing/compliance (prove what produced a decision), and rollback (know precisely what you're reverting to). Without it, a production incident becomes an unanswerable "which model was this and how did we make it?"

**Q: When is a feature store worth the complexity?**
A: When multiple models or teams reuse the same features, when train/serve skew has bitten you, or when you need low-latency online features consistent with offline training data. For a single small model computed from a simple pipeline, a shared feature-computation module is enough; a feature store's infrastructure only pays off at organizational scale.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** MLOps industrializes ML by versioning code + data + environment so any model is reproducible from `train(code, data, params, seed, env)`. Pipelines orchestrate ingest → validate → train → evaluate → register as a retryable DAG. Experiment trackers (MLflow/W&B) log every run; a model registry is the single source of truth with staged promotion (staging → canary → production) and one-command rollback. Gate promotion on a frozen test set with a margin `δ` and per-segment checks, not any bump. Prevent train/serve skew with shared feature code or a feature store. CI adds data/model tests; CD automates gated deployment. Start lightweight (git + DVC + MLflow) and scale tooling with need.

| Concern | Tool/Practice |
|---|---|
| Code version | git sha + params + seed |
| Data version | DVC / LakeFS (content hash) |
| Environment | container + lockfile |
| Tracking | MLflow / Weights & Biases |
| Orchestration | Airflow / Kubeflow / Prefect |
| Deployable source of truth | model registry (stages) |
| Skew prevention | shared features / feature store |
| Release | CI gates → canary → prod, rollback |

**Flash cards**
- **Reproducibility inputs** → code + data + params + seed + environment, all pinned.
- **Model registry purpose** → versioned, staged source of truth for deployables + rollback.
- **Promotion rule** → beat champion by margin `δ` on a frozen set, no slice regression, within SLA.
- **Train/serve skew fix** → identical feature code offline and online (feature store).
- **DVC stores** → hash/pointer in git, big blob in S3-like remote.

## 11. Hands-On Exercises & Mini Project

- [ ] Version a dataset with DVC, push to a remote, and reproduce it from a fresh clone.
- [ ] Instrument a training script with MLflow, logging params, a data-version tag, and metrics.
- [ ] Write a promotion gate that compares a candidate to the registered production model with a margin.
- [ ] Add a data-validation step (schema + null-rate + range checks) that fails the pipeline on anomalies.
- [ ] Build a GitHub Actions job that runs a tiny-sample training smoke test on every push.

**Mini Project: A Reproducible Retraining Pipeline.**
Goal: build an end-to-end pipeline that retrains a classifier and safely promotes it.
Requirements: (1) DVC-versioned data + a frozen test set; (2) a pipeline (script or Prefect/Airflow DAG) doing validate → train → evaluate → register to MLflow with full lineage tags; (3) a promotion gate comparing candidate vs champion by margin and per-segment; (4) CI that runs data/model tests on every commit.
Extensions: add a canary deployment step with a rollback command; add a drift trigger that re-runs the pipeline; add a Great Expectations suite and fail on validation errors.

## 12. Related Topics & Free Learning Resources

Related chapters: **Deployment, Monitoring & Drift** (the runtime half of MLOps — watching the model you just shipped), **GPU Computing & Distributed Training** (the training step your pipeline orchestrates), **Fine-Tuning, LoRA & QLoRA** (versioning adapters and their base/data), and **Serving LLMs: vLLM, Batching & Throughput** (deploying the registered model as a service).

**Free Learning Resources**
- **Hidden Technical Debt in Machine Learning Systems** — Sculley et al. (Google) · *Intermediate* · why the model is a tiny part of a real ML system. <https://papers.nips.cc/paper/2015/hash/86df7dcfd896fcaf2674f757a2463eba-Abstract.html>
- **MLflow documentation** — Databricks/MLflow · *Intermediate* · tracking, model registry, and deployment concepts. <https://mlflow.org/docs/latest/index.html>
- **DVC documentation** — Iterative · *Beginner* · data/model versioning and pipelines with a git-like workflow. <https://dvc.org/doc>
- **Made With ML — MLOps Course** — Goku Mohandas · *Intermediate* · a full, free, hands-on MLOps curriculum. <https://madewithml.com/>
- **Machine Learning Engineering for Production (MLOps) Specialization** — DeepLearning.AI (audit free) · *Intermediate* · pipelines, deployment, and monitoring end to end. <https://www.deeplearning.ai/courses/machine-learning-engineering-for-production-mlops/>
- **Google Cloud: MLOps Continuous Delivery and Automation Pipelines** — Google · *Advanced* · the canonical MLOps maturity levels (0/1/2). <https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning>
- **Kubeflow Pipelines documentation** — Kubeflow · *Advanced* · orchestrating ML DAGs on Kubernetes with caching and lineage. <https://www.kubeflow.org/docs/components/pipelines/>

---

*AI Engineering Handbook — chapter 41.*
