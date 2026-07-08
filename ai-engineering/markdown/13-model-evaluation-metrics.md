# 13 · Model Evaluation & Metrics

> **In one line:** Accuracy, precision/recall, ROC-AUC and confusion matrices — the craft of choosing the number that matches the *cost* of being wrong.

---

## 1. Overview

**Model evaluation** is the discipline of measuring how good a model actually is — and it is where most machine-learning projects quietly fail. A model that scores 99% accuracy can be worthless, and a model that scores 0.62 AUC can be worth millions. The metric is not a formality you compute at the end; it is the objective your entire project optimizes toward, whether you chose it deliberately or not.

The problem evaluation solves is **honest, decision-relevant measurement**. Training loss tells you the model fit the data; it says nothing about whether the model helps the business. Evaluation asks: on data the model has never seen, does it make the *kind* of mistakes we can tolerate? A cancer screen and a spam filter both output a probability, but one must never miss a positive (recall matters) and the other must never annoy the user with false alarms (precision matters). The same 0.5 threshold produces opposite outcomes.

Historically, accuracy was the default because early benchmarks (MNIST, Iris) were balanced. The field moved to precision/recall and ROC curves as real problems turned out to be **imbalanced** — fraud is 0.1% of transactions, disease is 1% of patients — and where a naive "predict the majority class" baseline scores 99.9% while catching nothing. The modern practice adds **calibration** (are the predicted probabilities trustworthy?) because downstream systems threshold, rank, and combine those probabilities.

A concrete example: a fraud model flags 1 in 1,000 transactions. At 99.9% accuracy it looks perfect, but if it simply predicts "not fraud" every time it *is* 99.9% accurate and catches zero fraud. Precision, recall, and the confusion matrix are what expose that fraud. Get the metric right and the rest of the pipeline has a compass; get it wrong and you optimize confidently in the wrong direction.

## 2. Core Concepts

- **Confusion matrix** — the 2×2 (or K×K) table of predicted-vs-actual counts: TP, FP, FN, TN. Every scalar metric below is a ratio derived from these four numbers.
- **Accuracy** — `(TP + TN) / total`. Fraction of correct predictions. Misleading whenever classes are imbalanced.
- **Precision** — `TP / (TP + FP)`. Of the things you flagged positive, how many were right? Answers *"can I trust a positive prediction?"*
- **Recall (sensitivity, TPR)** — `TP / (TP + FN)`. Of the actual positives, how many did you catch? Answers *"how much did I miss?"*
- **F1 score** — harmonic mean `2·P·R / (P + R)`. A single number balancing precision and recall; penalizes lopsided models.
- **ROC-AUC** — area under the TPR-vs-FPR curve; the probability a random positive is ranked above a random negative. Threshold-independent, but optimistic under heavy imbalance.
- **PR-AUC (average precision)** — area under the precision-recall curve; the honest ranking metric when positives are rare.
- **Threshold** — the probability cutoff that turns scores into decisions. Precision/recall/F1 all move as you slide it; AUC does not.
- **Calibration** — agreement between predicted probability and observed frequency: of samples scored 0.7, do ~70% turn out positive? Measured by reliability diagrams, Brier score, and ECE.
- **Macro / micro / weighted averaging** — three ways to collapse per-class metrics into one number for multiclass problems; they disagree sharply under imbalance.

## 3. Theory & Mathematical Intuition

Everything starts from the confusion matrix. For binary labels with a positive class, each prediction lands in one of four cells:

```
                 Predicted +      Predicted −
Actual +      TP (hit)         FN (miss)
Actual −      FP (false alarm) TN (correct reject)
```

From these four counts the core ratios are just different normalizations:

```
precision = TP / (TP + FP)          recall = TP / (TP + FN)
accuracy  = (TP + TN) / (TP+TN+FP+FN)
F1        = 2 * precision * recall / (precision + recall)
FPR       = FP / (FP + TN)          TPR = recall
```

**Why F1 uses the harmonic mean, not the average.** The harmonic mean is dominated by the smaller value: precision 1.0 with recall 0.0 gives F1 = 0, not 0.5. This is deliberate — a model that is precise but catches nothing is useless, and F1 refuses to reward it. The general form `F_β` weights recall β times as much as precision; use `F2` when misses cost more than false alarms.

**ROC and AUC.** As you sweep the threshold from 1 down to 0, you trace TPR against FPR. The **AUC** is the area under that curve and has a beautiful probabilistic meaning: it equals `P(score(random positive) > score(random negative))`. AUC = 0.5 is random, 1.0 is perfect ranking, and it is invariant to the threshold and to class prior. That invariance is also its weakness: with 99.9% negatives, a huge absolute number of false positives barely moves FPR, so ROC-AUC looks great while precision is terrible. **PR-AUC** exposes that, which is why rare-event problems report it.

**Calibration.** A ranking-perfect model can still output nonsense probabilities. Calibration asks whether `P(y=1 | score=s) ≈ s`. Three measures: the **Brier score** `mean((p − y)²)` (a proper scoring rule, lower is better), **Expected Calibration Error (ECE)** — bin predictions and average `|confidence − accuracy|` per bin weighted by bin size — and the visual **reliability diagram**. The diagram below shows a typical over-confident model bowing below the diagonal.

```svg
<svg viewBox="0 0 520 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <rect x="0" y="0" width="520" height="360" fill="#ffffff"/>
  <text x="260" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Reliability Diagram (Calibration)</text>
  <rect x="70" y="50" width="260" height="260" fill="#f0fdf4" stroke="#16a34a"/>
  <line x1="70" y1="310" x2="330" y2="50" stroke="#16a34a" stroke-width="2" stroke-dasharray="5,4"/>
  <text x="200" y="185" fill="#16a34a" font-size="11" transform="rotate(-45 200 185)">perfectly calibrated</text>
  <path d="M70,310 L122,285 L174,250 L226,200 L278,135 L330,50" fill="none" stroke="#d97706" stroke-width="2.5"/>
  <circle cx="122" cy="285" r="3.5" fill="#d97706"/>
  <circle cx="174" cy="250" r="3.5" fill="#d97706"/>
  <circle cx="226" cy="200" r="3.5" fill="#d97706"/>
  <circle cx="278" cy="135" r="3.5" fill="#d97706"/>
  <text x="300" y="290" fill="#d97706" font-size="11">over-confident model</text>
  <line x1="70" y1="50" x2="70" y2="310" stroke="#1e293b"/>
  <line x1="70" y1="310" x2="330" y2="310" stroke="#1e293b"/>
  <text x="200" y="340" text-anchor="middle" fill="#1e293b" font-size="12">predicted probability</text>
  <text x="40" y="180" text-anchor="middle" fill="#1e293b" font-size="12" transform="rotate(-90 40 180)">observed frequency</text>
  <text x="66" y="325" text-anchor="middle" fill="#64748b" font-size="10">0</text>
  <text x="330" y="325" text-anchor="middle" fill="#64748b" font-size="10">1</text>
  <rect x="360" y="70" width="150" height="120" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="372" y="92" fill="#1e293b" font-size="12" font-weight="700">Read it as:</text>
  <text x="372" y="114" fill="#334155" font-size="11">curve below line</text>
  <text x="372" y="132" fill="#334155" font-size="11">= over-confident</text>
  <text x="372" y="154" fill="#334155" font-size="11">curve above line</text>
  <text x="372" y="172" fill="#334155" font-size="11">= under-confident</text>
</svg>
```

## 4. Architecture & Workflow

Evaluation is a pipeline, not a single call. The flow below shows how raw predictions become a defensible decision, with the threshold chosen on validation data and locked before touching the test set.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <rect x="0" y="0" width="760" height="300" fill="#ffffff"/>
  <defs>
    <marker id="arw" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Evaluation Workflow</text>

  <rect x="20" y="55" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="95" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">Model scores</text>
  <text x="95" y="98" text-anchor="middle" fill="#64748b" font-size="11">P(y=1) per sample</text>

  <rect x="205" y="55" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="280" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">Pick threshold</text>
  <text x="280" y="98" text-anchor="middle" fill="#64748b" font-size="11">on validation set</text>

  <rect x="390" y="55" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="465" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">Confusion matrix</text>
  <text x="465" y="98" text-anchor="middle" fill="#64748b" font-size="11">TP FP FN TN</text>

  <rect x="575" y="55" width="160" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="80" text-anchor="middle" fill="#1e293b" font-weight="700">Metrics</text>
  <text x="655" y="98" text-anchor="middle" fill="#64748b" font-size="11">P / R / F1 / AUC</text>

  <rect x="205" y="165" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="280" y="190" text-anchor="middle" fill="#1e293b" font-weight="700">Calibrate</text>
  <text x="280" y="208" text-anchor="middle" fill="#64748b" font-size="11">Platt / isotonic</text>

  <rect x="390" y="165" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="465" y="190" text-anchor="middle" fill="#1e293b" font-weight="700">Cross-validate</text>
  <text x="465" y="208" text-anchor="middle" fill="#64748b" font-size="11">k-fold ± std</text>

  <rect x="575" y="165" width="160" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="190" text-anchor="middle" fill="#1e293b" font-weight="700">Ship / reject</text>
  <text x="655" y="208" text-anchor="middle" fill="#64748b" font-size="11">vs baseline gate</text>

  <line x1="170" y1="85" x2="203" y2="85" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="355" y1="85" x2="388" y2="85" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="540" y1="85" x2="573" y2="85" stroke="#475569" marker-end="url(#arw)"/>
  <path d="M280,115 L280,163" fill="none" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="355" y1="195" x2="388" y2="195" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="540" y1="195" x2="573" y2="195" stroke="#475569" marker-end="url(#arw)"/>
  <text x="380" y="265" text-anchor="middle" fill="#64748b" font-size="11">Threshold chosen on validation, then frozen; test set is touched exactly once.</text>
</svg>
```

**Step by step:**

1. **Produce scores, not labels.** Keep the raw `predict_proba` output; you lose all threshold and calibration information the moment you collapse to 0/1.
2. **Split honestly.** Train / validation / test — or k-fold cross-validation. The test set is a vault: opened once, at the end.
3. **Choose the threshold on validation** to hit a business target (e.g. "precision ≥ 0.9" or "recall ≥ 0.95"), never on the test set.
4. **Build the confusion matrix** at that threshold and derive precision, recall, F1.
5. **Compute threshold-free metrics** (ROC-AUC, PR-AUC) to judge ranking quality independent of the cutoff.
6. **Check calibration** if downstream code consumes the probabilities; recalibrate with Platt scaling or isotonic regression if needed.
7. **Compare against a baseline gate** (majority class, previous model) and report mean ± std across folds so you know the number is stable, not lucky.

## 5. Implementation

Real scikit-learn on an imbalanced synthetic problem. Outputs shown in comments are representative.

```python
import numpy as np
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (confusion_matrix, precision_score, recall_score,
                             f1_score, roc_auc_score, average_precision_score,
                             classification_report)

rng = np.random.default_rng(42)
X, y = make_classification(n_samples=20000, n_features=20, weights=[0.97, 0.03],
                           n_informative=6, random_state=42)   # 3% positive
X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25,
                                          stratify=y, random_state=42)

clf = LogisticRegression(max_iter=1000, class_weight="balanced").fit(X_tr, y_tr)
proba = clf.predict_proba(X_te)[:, 1]          # keep probabilities
pred = (proba >= 0.5).astype(int)

tn, fp, fn, tp = confusion_matrix(y_te, pred).ravel()
print(tn, fp, fn, tp)                          # e.g. 4520 330 40 110
print("accuracy :", (tp + tn) / len(y_te))     # ~0.926  <- looks fine
print("precision:", precision_score(y_te, pred))  # ~0.250  <- the truth
print("recall   :", recall_score(y_te, pred))     # ~0.733
print("f1       :", f1_score(y_te, pred))         # ~0.373
print("roc_auc  :", roc_auc_score(y_te, proba))   # ~0.92   optimistic
print("pr_auc   :", average_precision_score(y_te, proba))  # ~0.42 honest
```

**Threshold selection** to hit a precision target, then re-measure:

```python
from sklearn.metrics import precision_recall_curve

prec, rec, thr = precision_recall_curve(y_te, proba)
# find the lowest threshold that still gives precision >= 0.90
target = 0.90
ok = np.where(prec[:-1] >= target)[0]
t_star = thr[ok[0]] if len(ok) else 1.0
print("chosen threshold:", round(float(t_star), 3))   # e.g. 0.86

pred2 = (proba >= t_star).astype(int)
print("precision:", precision_score(y_te, pred2))  # ~0.90 (by construction)
print("recall   :", recall_score(y_te, pred2))     # ~0.31 (the trade-off)
```

**Calibration** — measure Brier + ECE, then fit isotonic regression:

```python
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss

def ece(y_true, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    e = 0.0
    for i in range(bins):
        m = (p > edges[i]) & (p <= edges[i + 1])
        if m.sum():
            e += m.mean() * abs(p[m].mean() - y_true[m].mean())
    return e

print("brier:", brier_score_loss(y_te, proba))     # ~0.061 (lower better)
print("ece  :", round(ece(y_te, proba), 3))        # ~0.048

cal = CalibratedClassifierCV(clf, method="isotonic", cv=5).fit(X_tr, y_tr)
p_cal = cal.predict_proba(X_te)[:, 1]
print("ece cal:", round(ece(y_te, p_cal), 3))      # ~0.018 improved
```

**Cross-validation** for a stable estimate, and **regression metrics** for completeness:

```python
from sklearn.model_selection import cross_val_score
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

scores = cross_val_score(clf, X, y, cv=5, scoring="average_precision")
print(f"PR-AUC: {scores.mean():.3f} +/- {scores.std():.3f}")  # 0.41 +/- 0.02

# regression side: MAE, RMSE, R^2
y_true = np.array([3.0, 5.0, 2.5, 7.0]); y_hat = np.array([2.8, 5.5, 2.0, 6.0])
print("MAE :", mean_absolute_error(y_true, y_hat))            # 0.55
print("RMSE:", mean_squared_error(y_true, y_hat) ** 0.5)      # 0.62
print("R2  :", round(r2_score(y_true, y_hat), 3))             # 0.902
```

> **Optimization:** For ROC/PR-AUC on large datasets, sort scores once (`O(n log n)`) rather than recomputing at every threshold — `roc_auc_score` already does this internally. When sweeping thresholds yourself, use `precision_recall_curve` which returns all breakpoints in one pass instead of looping over a grid, and cache `predict_proba` output so you never re-run inference per metric.

## 6. Advantages, Disadvantages & Trade-offs

| Metric | Strength | Cost / Trade-off |
|---|---|---|
| **Accuracy** | Intuitive, single number | Useless under imbalance; hides which class fails |
| **Precision** | Trust of a positive flag | Ignores misses; trivially 1.0 by predicting almost nothing |
| **Recall** | Coverage of positives | Ignores false alarms; trivially 1.0 by predicting all positive |
| **F1** | Balances P and R in one value | Assumes P and R equally important; ignores TN; not calibrated |
| **ROC-AUC** | Threshold-free, prior-invariant | Over-optimistic under heavy imbalance; not decision-ready |
| **PR-AUC** | Honest for rare positives | Depends on class prior; harder to compare across datasets |
| **Brier / ECE** | Judges probability quality | Needs enough data per bin; ECE sensitive to binning choice |
| **Cross-validation** | Stable estimate + variance | k× compute; leakage if preprocessing sits outside the fold |

The master trade-off is **precision vs recall**, dialed by the threshold: you cannot maximize both, and the right balance is dictated by the *cost* of a false positive versus a false negative, which is a business decision, not a statistical one.

## 7. Common Mistakes & Best Practices

1. ⚠️ Reporting accuracy on imbalanced data → ✅ Report precision, recall, PR-AUC, and always compare against the majority-class baseline.
2. ⚠️ Choosing the threshold on the test set → ✅ Tune it on validation, freeze it, then evaluate on test exactly once.
3. ⚠️ Using ROC-AUC alone for rare events → ✅ Add PR-AUC; ROC-AUC can read 0.95 while precision is 0.05.
4. ⚠️ Fitting the scaler/encoder on the full dataset before splitting → ✅ Fit preprocessing *inside* the CV fold via a `Pipeline` to prevent leakage.
5. ⚠️ Trusting `predict_proba` as a real probability → ✅ Check calibration (Brier/ECE); recalibrate with isotonic or Platt if the model feeds a threshold or expected-value calculation.
6. ⚠️ Optimizing F1 when false negatives are far costlier → ✅ Use F-beta (F2) or set the threshold from an explicit cost matrix.
7. ⚠️ Reporting a single split's score as gospel → ✅ Use k-fold and report mean ± std; a 3-point swing across folds means the number is noise.
8. ⚠️ Using micro-average on imbalanced multiclass and calling it fair → ✅ Report macro (treats classes equally) and per-class metrics so a rare class can't hide.
9. ⚠️ Evaluating on data that overlaps training (temporal or ID leakage) → ✅ Split by time or by entity; shuffle-splitting time series inflates every metric.
10. ⚠️ Ignoring confidence intervals → ✅ Bootstrap the test metric to get a CI; a 0.71 vs 0.72 AUC difference is usually not real.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a metric looks wrong, print the raw confusion matrix first — a swapped positive class or an inverted threshold shows up instantly as an off-diagonal blowup. Reproduce with a fixed seed and a stratified split; a metric that changes wildly between runs points to a tiny positive class or leaked preprocessing. Slice metrics by segment (region, device, cohort): a healthy aggregate often hides a broken subgroup.

**Monitoring.** In production you rarely have immediate labels, so track **proxy signals**: the distribution of predicted scores (a sudden shift in mean score is drift), the flag rate (positives per day), and input feature distributions (PSI / KL divergence vs training). When labels arrive (often delayed), recompute precision/recall/PR-AUC on a rolling window and alert on a relative drop past a threshold. Log calibration too — a model can stay accurate while its probabilities drift.

**Security.** Metrics are an attack surface: an adversary who learns your threshold can craft inputs that sit just under it. Keep thresholds server-side, add rate limits, and monitor for clusters of near-threshold scores. Guard against label poisoning in feedback loops — attacker-supplied "corrections" can silently degrade the metric you retrain against.

**Scaling.** For billions of predictions, compute metrics with streaming/approximate methods: maintain running confusion-matrix counts per threshold bucket, use reservoir sampling for ROC/PR estimation, and parallelize k-fold across workers. Store scores (not just labels) so you can re-threshold offline without re-running inference.

## 9. Interview Questions

**Q: Your model has 99% accuracy on a fraud dataset. Is it good?**
A: Almost certainly not — if fraud is 1% of transactions, a model that always predicts "not fraud" also scores 99%. Accuracy is meaningless under imbalance. I'd ask for precision, recall, and PR-AUC, and compare against the majority-class baseline before believing anything.

**Q: Explain precision vs recall with a concrete cost.**
A: Precision is how many of my positive flags are correct; recall is how many actual positives I caught. For cancer screening, a false negative (missed cancer) is catastrophic, so I maximize recall and accept lower precision. For a spam filter, a false positive (a real email deleted) is worse, so I favor precision.

**Q: What does ROC-AUC actually measure, and when does it mislead?**
A: It's the probability that a random positive is scored higher than a random negative — pure ranking quality, independent of threshold and class prior. It misleads under heavy imbalance: a flood of false positives barely moves FPR, so AUC stays high while precision collapses. PR-AUC exposes that.

**Q: When would you prefer PR-AUC over ROC-AUC?**
A: When positives are rare and false positives are costly — fraud, disease, rare-defect detection. PR-AUC's x-axis is recall and its y-axis is precision, both of which ignore the huge TN count, so it reflects real performance on the minority class instead of being flattered by it.

**Q: How do you pick a decision threshold?**
A: Not at 0.5 by default. I pick it on the validation set to hit a business constraint — e.g. the lowest threshold with precision ≥ 0.9, or the point that maximizes expected value given a cost matrix — then freeze it before touching the test set.

**Q: What is model calibration and why care?**
A: Calibration means a predicted probability matches the observed frequency: of samples scored 0.7, about 70% are truly positive. It matters whenever the probability is consumed downstream — expected-value thresholds, risk scores, ensembling. I measure it with a reliability diagram, Brier score, and ECE, and fix it with Platt or isotonic scaling.

**Q: Difference between macro, micro, and weighted averaging in multiclass?**
A: Macro averages the per-class metric equally, so a rare class counts as much as a common one. Micro pools all TP/FP/FN globally, so it's dominated by frequent classes and equals accuracy for single-label problems. Weighted averages by class support. Under imbalance macro and micro can differ by 30+ points; I report both plus per-class.

**Q: (Senior) A model shows 0.92 ROC-AUC offline but performs poorly in production. Diagnose.**
A: Prime suspects: (1) train/serve skew — features computed differently online; (2) temporal leakage in the offline split inflating AUC; (3) distribution shift making the offline test unrepresentative; (4) the metric being right but the *threshold* wrong for the real cost. I'd check feature parity, re-split by time, compare score distributions offline vs online, and look at PR-AUC and calibration rather than ROC-AUC alone.

**Q: (Senior) How do you evaluate a model whose labels arrive weeks late?**
A: Use a delayed-label evaluation harness: log every score at prediction time, join labels as they mature, and compute metrics on a rolling window with a maturation cutoff so you don't score half-labeled cohorts. In the meantime monitor proxies — score distribution drift, flag rate, input PSI — and use them as early-warning gates before the true metric lands.

**Q: (Senior) Why can F1 be the wrong optimization target, and what would you use instead?**
A: F1 weights precision and recall equally and ignores true negatives, which rarely matches real costs. If a miss costs 10× a false alarm, F1 silently under-weights recall. I'd optimize expected utility from an explicit cost matrix, or use F-beta with β chosen from that ratio, and select the threshold to maximize that utility on validation.

**Q: (Senior) How do you know a metric improvement is real and not noise?**
A: Bootstrap the test set to get a confidence interval on the metric, or run k-fold and report mean ± std; for paired model comparison use a paired bootstrap or McNemar's test on the same examples. A 0.71→0.72 AUC bump inside overlapping CIs is not a real improvement, and shipping on it is chasing noise.

**Q: What regression metrics do you know and when does each fail?**
A: MAE is robust and in the target's units but ignores error direction and treats all errors linearly. RMSE penalizes large errors quadratically — good when big misses are disproportionately bad, but outlier-sensitive. R² reports variance explained but can go negative and is inflated by adding features, so I pair it with adjusted R² or a held-out score.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Every classification metric is a ratio of the confusion matrix's four cells. Accuracy lies under imbalance; precision asks "can I trust a positive?", recall asks "how much did I miss?", and F1 balances them via the harmonic mean. ROC-AUC measures threshold-free ranking but flatters rare-positive problems — use PR-AUC there. The threshold is a business dial tuned on validation, never on test. Calibration (Brier, ECE, reliability diagram) checks whether the probabilities are trustworthy. Always compare to a baseline and report variance from cross-validation.

| Situation | Metric to trust |
|---|---|
| Balanced classes | Accuracy, F1 |
| Rare positives | PR-AUC, precision@recall |
| Cost of miss ≫ false alarm | Recall / F2 |
| Cost of false alarm ≫ miss | Precision |
| Probabilities feed downstream | Brier, ECE, reliability diagram |
| Ranking quality only | ROC-AUC |
| Regression | MAE (robust), RMSE (penalize big), R² |

- **Precision** → `TP / (TP + FP)` — trust of a positive flag.
- **Recall** → `TP / (TP + FN)` — coverage of actual positives.
- **F1** → harmonic mean of P and R; zero if either is zero.
- **ROC-AUC vs PR-AUC** → ranking overall vs ranking under rare positives; prefer PR-AUC when imbalanced.
- **ECE** → binned average gap between confidence and accuracy; measures calibration, not correctness.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a confusion matrix by hand from 10 labeled predictions and derive accuracy, precision, recall, F1 without a library.
- [ ] Take an imbalanced dataset and plot how precision, recall, and F1 change as you sweep the threshold from 0 to 1.
- [ ] Compute ROC-AUC and PR-AUC on the same rare-positive dataset and explain in writing why they diverge.
- [ ] Draw a reliability diagram before and after isotonic calibration; report the ECE improvement.
- [ ] Run 5-fold cross-validation and report mean ± std; bootstrap the test set for a 95% CI on your headline metric.

**Mini Project — A Reusable Evaluation Report.**
*Goal:* write `evaluate(model, X_test, y_test)` that emits a one-page report for any binary classifier.
*Requirements:* (1) confusion matrix at the chosen threshold; (2) accuracy, precision, recall, F1, ROC-AUC, PR-AUC; (3) a threshold-vs-metric table and a recommended threshold for a given precision target; (4) calibration section with Brier, ECE, and a reliability diagram; (5) all figures saved as PNG and a Markdown summary. Use scikit-learn end to end.
*Extensions:* add multiclass support with macro/micro/weighted rows; add bootstrap confidence intervals on every metric; add a slice-based breakdown by a categorical feature to surface subgroup failures; add a McNemar test comparing two candidate models.

## 12. Related Topics & Free Learning Resources

Related chapters: **Clustering & Dimensionality Reduction** (unsupervised evaluation — silhouette, inertia), **Overfitting, Regularization & Validation** (why the test set is a vault), **Imbalanced Learning & Sampling**, and **Feature Engineering & Leakage** (the silent metric inflator).

**Free Learning Resources**
- **scikit-learn: Metrics and scoring** — scikit-learn · *Beginner–Intermediate* · the canonical reference with formulas and API for every metric here. <https://scikit-learn.org/stable/modules/model_evaluation.html>
- **StatQuest: ROC and AUC, Clearly Explained** — Josh Starmer · *Beginner* · the clearest visual walk-through of ROC curves and AUC on the internet. <https://www.youtube.com/watch?v=4jRBRDbJemM>
- **The Relationship Between Precision-Recall and ROC Curves** — Davis & Goadrich (ICML) · *Advanced* · the paper proving why PR curves expose what ROC hides under imbalance. <https://www.biostat.wisc.edu/~page/rocpr.pdf>
- **On Calibration of Modern Neural Networks** — Guo et al., arXiv · *Advanced* · shows deep nets are miscalibrated and introduces temperature scaling; defines ECE. <https://arxiv.org/abs/1706.04599>
- **Google ML Crash Course: Classification** — Google · *Beginner* · interactive lessons on thresholds, precision/recall, and ROC with widgets. <https://developers.google.com/machine-learning/crash-course/classification>
- **scikit-learn: Probability calibration** — scikit-learn · *Intermediate* · practical guide to Platt/isotonic scaling and reliability diagrams with code. <https://scikit-learn.org/stable/modules/calibration.html>
- **StatQuest: Cross Validation** — Josh Starmer · *Beginner* · why single splits lie and how k-fold gives you variance. <https://www.youtube.com/watch?v=fSytzGwwBVw>

---

*AI Engineering Handbook — chapter 13.*
