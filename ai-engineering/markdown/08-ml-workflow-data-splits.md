# 08 · The ML Workflow & Data Splits

> **In one line:** The single biggest reason "great" models fail in production is not the algorithm — it's a leaky or dishonest split, so the discipline of train/validation/test and cross-validation is what makes an offline number mean anything.

---

## 1. Overview

Every machine-learning project is a bet: the number you measured offline will hold up when the model meets data it has never seen. **Data splits are the machinery that makes that bet honest.** You carve your data into a **training** set the model learns from, a **validation** set you tune against, and a **test** set you touch exactly once to estimate real-world performance. Cross-validation squeezes more reliable estimates out of limited data. Get this wrong and every downstream decision — which model, which features, which hyperparameters — is built on a lie.

The **problem it solves** is *optimism*. A model can memorize its training data and score 100% on it while being useless on anything new. If you also tune your choices on the same data you evaluate on, you leak information and inflate the score. The split protocol creates a clean firewall: the test set is a stand-in for the future, and you protect it from contamination so its verdict is trustworthy. This is not bureaucracy — it is the difference between a model that ships and a model that embarrasses you in week one.

Historically this discipline crystallized as ML moved from academia to industry. Kaggle competitions made **leakage** infamous: teams topping public leaderboards by exploiting an ID column that correlated with the target, only to collapse on the private set. The lesson generalized — the hardest part of applied ML is usually not modeling but building an evaluation you can trust.

**Concrete real-world example.** A team builds a hospital readmission model and reports 0.94 AUC — spectacular. In production it performs like a coin flip. The autopsy: the training data included a "discharge disposition" feature that was only populated *after* the readmission outcome was known. It was a leak from the future. A time-based split, where you train on 2022 and test on 2023, would have exposed it instantly because the feature wouldn't exist at prediction time. The model wasn't wrong; the *evaluation* was.

By the end of this chapter you'll know how to split data so your offline metric predicts online reality, when to use k-fold vs. a single holdout vs. a time-based split, and how to spot the leakage traps that silently inflate scores.

## 2. Core Concepts

- **Training set** — the data the model fits its parameters on; typically 60–80% of the data.
- **Validation (dev) set** — data used to tune hyperparameters and pick models; touched many times but never trained on.
- **Test (holdout) set** — data used **once** for the final unbiased estimate; never used for any decision.
- **Cross-validation (k-fold)** — rotate the validation role across k slices so every point is validated once, averaging k estimates for a lower-variance score.
- **Data leakage** — any way information about the target or the test set sneaks into training, inflating offline scores.
- **Stratification** — splitting so each fold preserves the class balance (or key group proportions) of the whole dataset.
- **Grouped split** — keeping all rows of an entity (a user, a patient) entirely on one side so the model can't memorize the entity.
- **Temporal split** — training on the past and testing on the future to mirror deployment and catch time leaks.
- **Pipeline** — bundling preprocessing + model so transforms are *fit on training folds only*, preventing preprocessing leakage.
- **Nested cross-validation** — an outer loop for unbiased evaluation wrapping an inner loop for tuning, so tuning can't inflate the estimate.

## 3. Theory & Mathematical Intuition

The purpose of splitting is to estimate the **generalization error** `E_(x,y)~D [ loss(model(x), y) ]` — the expected loss over the true data distribution `D` — using only a finite sample. Training error is a biased, optimistic estimate because the model was optimized on those exact points. A held-out sample gives an *unbiased* estimate **only if the model never saw it in any way**, directly or indirectly.

Every time you use a set to *make a choice* (pick a threshold, a feature, a hyperparameter, an epoch to stop at), you spend a little of its independence. After enough choices, the validation set becomes optimistic too — this is why you keep a separate, single-use test set. Think of independence as a budget you deplete with each peek.

**Bias–variance of the estimate itself.** A single holdout of `n_test` points has high variance: the score wobbles depending on which points landed there. Its standard error scales like `√(p(1−p)/n_test)` for a rate metric. K-fold cross-validation reduces this variance by averaging k estimates:

```text
CV_error = (1/k) · Σ_{i=1..k}  error_on_fold_i        # each fold used as test once
```

Larger `k` → more training data per fold (less pessimistic bias) but more correlated, costlier folds. `k = 5` or `10` is the standard sweet spot. Leave-one-out (`k = n`) is nearly unbiased but high-variance and expensive.

**The golden rule of preprocessing.** Any statistic used to transform data — a mean for imputation, a scaler's `μ`/`σ`, a target-encoding average, a vocabulary — must be computed from **training rows only**, then *applied* to validation/test. Compute it on the full dataset first and you've leaked the test distribution into training. This is the most common and most subtle leak.

```svg
<svg viewBox="0 0 720 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="250" fill="#ffffff"/>
  <text x="360" y="26" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">5-Fold Cross-Validation (each row is one split)</text>
  <text x="60" y="60" fill="#1e293b" font-size="12">Fold 1</text>
  <text x="60" y="98" fill="#1e293b" font-size="12">Fold 2</text>
  <text x="60" y="136" fill="#1e293b" font-size="12">Fold 3</text>
  <text x="60" y="174" fill="#1e293b" font-size="12">Fold 4</text>
  <text x="60" y="212" fill="#1e293b" font-size="12">Fold 5</text>
  <g font-size="11" text-anchor="middle">
    <rect x="120" y="46" width="100" height="24" fill="#fef3c7" stroke="#d97706"/><text x="170" y="63" fill="#1e293b">VALID</text>
    <rect x="220" y="46" width="380" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="410" y="63" fill="#1e293b">train</text>
    <rect x="120" y="84" width="100" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="170" y="101" fill="#1e293b">train</text>
    <rect x="220" y="84" width="100" height="24" fill="#fef3c7" stroke="#d97706"/><text x="270" y="101" fill="#1e293b">VALID</text>
    <rect x="320" y="84" width="280" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="460" y="101" fill="#1e293b">train</text>
    <rect x="120" y="122" width="200" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="220" y="139" fill="#1e293b">train</text>
    <rect x="320" y="122" width="100" height="24" fill="#fef3c7" stroke="#d97706"/><text x="370" y="139" fill="#1e293b">VALID</text>
    <rect x="420" y="122" width="180" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="510" y="139" fill="#1e293b">train</text>
    <rect x="120" y="160" width="300" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="270" y="177" fill="#1e293b">train</text>
    <rect x="420" y="160" width="100" height="24" fill="#fef3c7" stroke="#d97706"/><text x="470" y="177" fill="#1e293b">VALID</text>
    <rect x="520" y="160" width="80" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="560" y="177" fill="#1e293b">train</text>
    <rect x="120" y="198" width="380" height="24" fill="#eef2ff" stroke="#4f46e5"/><text x="310" y="215" fill="#1e293b">train</text>
    <rect x="500" y="198" width="100" height="24" fill="#fef3c7" stroke="#d97706"/><text x="550" y="215" fill="#1e293b">VALID</text>
  </g>
  <text x="360" y="242" text-anchor="middle" fill="#1e293b" font-size="12">final score = average of the 5 VALID scores</text>
</svg>
```

## 4. Architecture & Workflow

1. **Split first, look later.** Before any EDA that could bias choices, carve off the test set and lock it away. Ideally split by *time* or *group* if either matters for deployment.
2. **Choose the split strategy.** Random for i.i.d. rows; **stratified** for imbalanced classification; **grouped** when entities repeat; **temporal** when the model predicts the future. These can combine (stratified-group-time).
3. **Build a pipeline, not a script.** Wrap imputation, scaling, encoding, and the model into one object so every transform is fit only on training folds.
4. **Cross-validate on the train+validation portion.** Use k-fold (or grouped/time-series CV) to select model family, features, and hyperparameters. Never let the test set inform any of this.
5. **Refit on all non-test data** with the chosen config, then **evaluate once on the test set**. That number is your honest estimate. If you don't like it, you cannot re-tune and re-test — you'd need fresh data.
6. **Deploy and compare online.** Offline is a proxy; the real judge is an online A/B test. Track the offline↔online gap: a persistent gap means your split still doesn't mirror production.

```svg
<svg viewBox="0 0 760 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="240" fill="#ffffff"/>
  <rect x="20" y="30" width="720" height="34" rx="6" fill="#f1f5f9" stroke="#64748b"/>
  <text x="380" y="52" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">All labeled data</text>
  <rect x="20" y="90" width="520" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="280" y="115" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Train + Validation (used for CV &amp; tuning)</text>
  <rect x="560" y="90" width="180" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="650" y="109" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">TEST</text>
  <text x="650" y="124" text-anchor="middle" fill="#1e293b" font-size="10">locked — touch once</text>
  <rect x="20" y="150" width="120" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/><text x="80" y="170" text-anchor="middle" fill="#1e293b" font-size="11">fit pipeline</text>
  <rect x="160" y="150" width="140" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/><text x="230" y="170" text-anchor="middle" fill="#1e293b" font-size="11">k-fold CV</text>
  <rect x="320" y="150" width="150" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/><text x="395" y="170" text-anchor="middle" fill="#1e293b" font-size="11">pick best config</text>
  <rect x="490" y="150" width="150" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a"/><text x="565" y="170" text-anchor="middle" fill="#1e293b" font-size="11">refit on all train</text>
  <rect x="20" y="196" width="620" height="30" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="330" y="216" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Evaluate ONCE on TEST → report honest metric → then A/B online</text>
  <line x1="140" y1="165" x2="158" y2="165" stroke="#1e293b" stroke-width="2" marker-end="url(#a8)"/>
  <line x1="300" y1="165" x2="318" y2="165" stroke="#1e293b" stroke-width="2" marker-end="url(#a8)"/>
  <line x1="470" y1="165" x2="488" y2="165" stroke="#1e293b" stroke-width="2" marker-end="url(#a8)"/>
  <defs><marker id="a8" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#1e293b"/></marker></defs>
</svg>
```

## 5. Implementation

The right way: a pipeline evaluated with stratified k-fold, so preprocessing is fit per fold.

```python
import numpy as np
from sklearn.datasets import make_classification
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression

X, y = make_classification(n_samples=4000, n_features=20, weights=[0.9, 0.1],
                           random_state=0)

# 1) Lock the test set FIRST, stratified to preserve the 90/10 balance
X_dev, X_test, y_dev, y_test = train_test_split(
    X, y, test_size=0.2, stratify=y, random_state=0)

# 2) A pipeline: imputer + scaler are refit inside every CV fold (no leakage)
pipe = Pipeline([
    ("impute", SimpleImputer(strategy="median")),
    ("scale",  StandardScaler()),
    ("clf",    LogisticRegression(max_iter=1000, class_weight="balanced")),
])

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
scores = cross_val_score(pipe, X_dev, y_dev, cv=cv, scoring="roc_auc")
print(f"CV AUC = {scores.mean():.3f} ± {scores.std():.3f}")
# CV AUC = 0.933 ± 0.010

# 3) Refit on all dev data, evaluate ONCE on the locked test set
pipe.fit(X_dev, y_dev)
from sklearn.metrics import roc_auc_score
test_auc = roc_auc_score(y_test, pipe.predict_proba(X_test)[:, 1])
print(f"TEST AUC = {test_auc:.3f}")
# TEST AUC = 0.930   (close to CV → the split is honest)
```

A demonstration of **preprocessing leakage** — scaling on the full data before splitting inflates the score:

```python
from sklearn.preprocessing import StandardScaler
# WRONG: fit the scaler on everything, then split → test stats leaked into train
X_leaked = StandardScaler().fit_transform(X)          # uses test mean/std!
Xl_dev, Xl_test, yl_dev, yl_test = train_test_split(
    X_leaked, y, test_size=0.2, stratify=y, random_state=0)
# The gap is small here but grows with high-dimensional or target-derived transforms.
# Rule: any .fit() must see training rows ONLY. Put transforms inside the Pipeline.
```

**Grouped and temporal** splits — the fixes for the hospital and time-leak traps:

```python
from sklearn.model_selection import GroupKFold, TimeSeriesSplit
import numpy as np

groups = np.random.default_rng(0).integers(0, 800, size=len(X_dev))  # e.g. patient id
gkf = GroupKFold(n_splits=5)                       # no patient spans train & valid
for tr, va in gkf.split(X_dev, y_dev, groups=groups):
    assert set(groups[tr]).isdisjoint(groups[va])  # entity firewall holds

# Time series: train only on the past of each fold, validate on the immediate future
tss = TimeSeriesSplit(n_splits=5)
for tr, va in tss.split(X_dev):
    assert tr.max() < va.min()                     # never train on the future
```

> **Optimization:** for large data, k-fold's k full refits are the bottleneck. Prefer a single large stratified holdout when `n` is huge (variance is already low), cache preprocessing that doesn't leak (e.g. tokenization is input-only), and parallelize folds with `cross_val_score(..., n_jobs=-1)`. For hyperparameter search, use `HalvingGridSearchCV` (successive halving) to spend compute only on promising configs.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Single holdout | Cheap, simple, one model fit | High-variance estimate; wastes data on small sets |
| k-fold CV | Lower-variance estimate, uses all data | k× the compute; folds are correlated |
| Stratified split | Stable metrics on imbalanced data | Only meaningful for classification / discrete strata |
| Grouped split | Prevents entity memorization leakage | Fewer effective samples; needs a clean group key |
| Temporal split | Mirrors deployment, catches time leaks | Discards shuffling gains; earliest data may be stale |
| Nested CV | Unbiased estimate *with* tuning | k_outer × k_inner fits — expensive |
| Locked test set | Honest final number | "Wasted" data you can't train on; one-shot only |

## 7. Common Mistakes & Best Practices

1. ⚠️ Fitting scalers/encoders/imputers on the whole dataset before splitting → ✅ Put every transform inside a `Pipeline` so `.fit` sees only training folds.
2. ⚠️ Random splitting time-series or grouped data → ✅ Use `TimeSeriesSplit` for temporal data and `GroupKFold` when entities repeat.
3. ⚠️ Tuning hyperparameters on the test set → ✅ Tune on validation/CV; the test set is evaluated exactly once, ever.
4. ⚠️ Reporting the best-of-many test runs → ✅ That's the test set leaking through you; fix choices on validation and accept the first test number.
5. ⚠️ Random split on imbalanced data → ✅ Stratify so rare classes appear in every fold; otherwise metrics are unstable or undefined.
6. ⚠️ Including target-derived or future-populated features → ✅ Audit each feature: "would this value exist at prediction time?" If not, drop it.
7. ⚠️ Deduplicating after splitting → ✅ Deduplicate first; identical rows straddling train/test is direct leakage.
8. ⚠️ Ignoring the offline↔online gap → ✅ Track it; a persistent gap means the split doesn't mirror production (shift, leakage, or feedback loops).
9. ⚠️ Using a tiny validation set for early stopping → ✅ Small val sets give noisy stopping points; use enough data or CV-based stopping.
10. ⚠️ Leaking through cross-validation folds during feature selection → ✅ Select features *inside* the CV loop (or nested CV), not once on all data beforehand.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging leakage.** The tell-tale sign is a *too-good* score or a feature with implausibly high importance. Two fast probes: (1) shuffle the target and retrain — any AUC above ~0.5 means information is leaking from the split itself; (2) train on early data and test on late data — a big drop versus random split points at a time leak. Inspect top features for anything computed from or after the label.

**Monitoring.** In production the "test set" is the live stream. Log the offline metric at ship time and compare it to realized online performance on the same cohort weeks later. Monitor **training-serving skew**: the exact same preprocessing code must run offline and online, or you get silent leakage-in-reverse (features computed differently at serve time). Track label-delay: if labels arrive late (e.g. churn after 30 days), your recent evaluation windows are incomplete.

**Security.** Splits interact with privacy. If the same user appears in train and test, membership-inference and re-identification get easier; grouped splits by user also help privacy. Be wary of **feedback loops**: a deployed model influences future data, so naive splits on post-deployment data over-credit the model for outcomes it caused.

**Scaling.** For huge datasets, materialize splits deterministically by hashing a stable key (`hash(user_id) % 100 < 80 → train`) so the assignment is reproducible and stable as data grows — new users land in the same bucket forever. This beats random splits that reshuffle every run. For distributed training, ensure the hash-based split happens before sharding so no shard mixes train/test. Store split assignments as a column or manifest for full reproducibility and audits.

## 9. Interview Questions

**Q: What is the purpose of a separate validation and test set — why not just one holdout?**
A: The validation set is used repeatedly to make choices (hyperparameters, model selection, early stopping), which slowly leaks its information and makes it optimistic. The test set stays untouched until the very end so it gives an unbiased final estimate. One holdout used for both tuning and reporting produces an inflated number.

**Q: What is data leakage and why is it so dangerous?**
A: Leakage is any path by which information about the target or the test data enters training — a future-populated feature, preprocessing fit on all data, duplicate rows across splits. It's dangerous because it inflates offline scores while doing nothing for real performance, so the model looks great and then fails in production. It's often invisible without deliberate checks.

**Q: When should you use a stratified split versus a random one?**
A: Use stratification for classification, especially imbalanced classes, so each fold preserves the class ratio and metrics stay stable and defined. Pure random splits can leave a rare class absent from a fold, making its recall undefined and the estimate high-variance.

**Q: Why fit preprocessing inside cross-validation folds instead of once on all data?**
A: Because a scaler's mean/std, an imputer's median, or a target encoding computed on all data has "seen" the validation/test rows, leaking their distribution into training. Wrapping transforms in a pipeline refits them on each training fold only, so the estimate stays honest.

**Q: How do you choose k in k-fold cross-validation?**
A: k=5 or 10 balances bias and variance and cost. Larger k means more training data per fold (less pessimistic bias) but higher variance and more compute; leave-one-out is nearly unbiased but noisy and expensive. For large datasets a single big holdout is often enough because its variance is already low.

**Q: When must you use a grouped split?**
A: Whenever an entity (user, patient, device, document) contributes multiple rows and could be memorized. If the same user is in train and test, the model can cheat by recognizing the user rather than learning the pattern, so you use GroupKFold to keep all of an entity's rows on one side.

**Q: Why does time-series data require a temporal split?**
A: Because deployment always predicts the future from the past, so evaluation must too. Random shuffling lets the model train on future points to predict past ones, which is impossible at serve time and hides look-ahead leaks. TimeSeriesSplit trains on a past window and validates on the following one.

**Q: (Senior) Explain nested cross-validation and when it's worth the cost.**
A: An inner CV loop selects hyperparameters; an outer CV loop evaluates the whole tuning procedure on data the inner loop never saw. It gives an unbiased performance estimate that *includes* the optimism from tuning. It's worth it when data is limited and you're reporting a headline number, but it costs k_outer × k_inner fits, so on large data a single locked test set is usually enough.

**Q: (Senior) Your offline AUC is 0.92 but online it behaves like 0.75. Walk through your diagnosis.**
A: Check for leakage first (shuffle-target probe, audit features for future/target derivation), then training-serving skew (is the exact preprocessing identical offline and online?), then distribution shift (compare live feature histograms to training via PSI/KL), then label definition mismatch and feedback loops. Also verify the split mirrored deployment — random where it should have been temporal is a classic cause.

**Q: (Senior) How do you make splits reproducible and stable as the dataset grows over months?**
A: Assign each record deterministically by hashing a stable key (e.g. `hash(user_id) % 100`) into buckets, so a user always lands in the same split even as new data streams in and you never accidentally move a row from test to train. Persist the assignment as a column or manifest for audits, and do the hashing before any sharding.

**Q: What is the difference between validation error and generalization error?**
A: Generalization error is the true expected loss over the whole data distribution — unobservable. Validation and test errors are finite-sample estimates of it. They're unbiased only if the model made no decisions using that data; the more you tune on a set, the more its error underestimates the true generalization error.

**Q: How does class imbalance interact with your choice of split and metric?**
A: Imbalance demands stratified splits so rare positives appear in every fold, and it invalidates accuracy as a metric (predicting the majority scores high). Use PR-AUC, F1, or expected cost, and consider class weighting or resampling *inside* the training fold only — never resample before splitting, which leaks and duplicates across sets.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Split before you look. Lock a test set and touch it exactly once. Tune and select on validation/cross-validation, then refit on all non-test data and report the single test number. Fit every preprocessing step inside the CV fold (use a Pipeline) so no test statistic leaks into training. Choose the split to mirror deployment: stratified for imbalance, grouped when entities repeat, temporal when you predict the future. The biggest risk isn't the model — it's leakage: future-derived features, preprocessing-on-all-data, duplicate rows, or peeking at the test set. If offline and online disagree, suspect leakage, training-serving skew, or a split that didn't mirror production.

| Situation | Use this split |
|---|---|
| i.i.d. rows | random / stratified k-fold |
| imbalanced classes | StratifiedKFold |
| repeating entities | GroupKFold |
| predict the future | TimeSeriesSplit |
| tuning + honest estimate | nested CV or locked test set |
| huge data | deterministic hash split |

**Flash cards**
- **Golden rule** → any `.fit()` sees training rows only; wrap transforms in a Pipeline.
- **Test set** → evaluated exactly once; any reuse for decisions leaks it.
- **Leakage smell** → too-good score or one feature with implausible importance.
- **k-fold** → k=5/10; averages folds to cut estimate variance at k× compute.
- **Grouped split** → keeps all of a user/patient on one side to stop memorization.

## 11. Hands-On Exercises & Mini Project

- [ ] Build the same model twice — once scaling before the split, once inside a pipeline — and measure the inflated AUC from the leak.
- [ ] Take a dataset with a user id, compare random KFold vs. GroupKFold scores, and explain the gap.
- [ ] Implement a deterministic hash split and show that adding new rows never reassigns existing ones.
- [ ] Run the shuffle-the-target probe on your favorite dataset and confirm AUC collapses to ~0.5.
- [ ] Compare 5-fold and 10-fold CV variance on a 500-row dataset; discuss the bias-variance trade.

**Mini Project — A Leakage-Proof Evaluation Harness**
*Goal:* build a reusable harness that makes honest evaluation the default and catches leaks automatically.
*Requirements:* (1) accept a dataset, a group key, and a time column; (2) auto-select the split strategy (temporal if a time column exists, else grouped if a group key exists, else stratified); (3) run everything through an sklearn Pipeline so preprocessing can't leak; (4) include an automated shuffle-target leak test that fails loudly if AUC > 0.55; (5) produce a report with CV mean±std and a single locked-test number.
*Extensions:* add nested CV for unbiased tuning; add a PSI-based drift check comparing train vs. test feature distributions; add a "would this feature exist at prediction time?" audit prompt for each column.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Probability & Statistics for AI* (why estimates have variance), *Feature Engineering & Preprocessing* (where preprocessing leakage lives), *Linear & Logistic Regression* and *Gradient Boosting* (the models you'll be honestly evaluating), and any evaluation-metrics chapter for choosing the right score.

**Free Learning Resources**
- **scikit-learn: Cross-validation & model selection** — scikit-learn docs · *Intermediate* · the canonical, example-rich reference for every splitter. <https://scikit-learn.org/stable/modules/cross_validation.html>
- **Kaggle: Data Leakage** — Kaggle Learn · *Beginner–Intermediate* · short, practical lesson with real leakage examples and fixes. <https://www.kaggle.com/code/alexisbcook/data-leakage>
- **StatQuest: Cross Validation** — Josh Starmer · *Beginner* · a crisp visual explanation of k-fold and why we do it. <https://www.youtube.com/watch?v=fSytzGwwBVw>
- **Google: Rules of Machine Learning** — Martin Zinkevich · *Intermediate* · battle-tested rules, several on training-serving skew and honest evaluation. <https://developers.google.com/machine-learning/guides/rules-of-ml>
- **A Few Useful Things to Know About Machine Learning** — Pedro Domingos · *Intermediate* · classic paper on generalization, overfitting, and evaluation pitfalls. <https://homes.cs.washington.edu/~pedrod/papers/cacm12.pdf>
- **Full Stack Deep Learning: Data Management** — FSDL · *Intermediate* · practical lecture on splits, versioning, and building trustworthy datasets. <https://fullstackdeeplearning.com/>
- **scikit-learn: Common pitfalls & recommended practices** — scikit-learn docs · *Intermediate* · a focused guide to leakage and evaluation mistakes. <https://scikit-learn.org/stable/common_pitfalls.html>

---

*AI Engineering Handbook — chapter 08.*
