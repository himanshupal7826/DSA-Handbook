# 10 · Decision Trees & Random Forests

> **In one line:** A decision tree asks a sequence of yes/no questions to carve the feature space into pure regions — intuitive but wildly overfitting-prone — and a random forest averages hundreds of decorrelated trees to trade that variance for accuracy.

---

## 1. Overview

A **decision tree** is the most human of machine-learning models: it learns a flowchart of if-then questions ("is income > 50k? is age < 30?") that splits the data into ever-purer groups until each leaf makes a confident prediction. You can print it, read it, and explain any prediction as a path from root to leaf. That transparency is why trees underpin credit decisions, medical triage, and every "how did the model decide?" conversation. But a single tree grown to completion memorizes its training data — it is the textbook example of **high variance**.

The **problem trees solve** is capturing non-linear, interaction-rich structure without any feature scaling or distributional assumptions. Unlike linear regression, a tree natively models "feature A matters *only when* feature B is high" because each split conditions on the path above it. It handles mixed numeric and categorical data, missing values, and monotonic transforms of features for free. The cost is instability: change a few training rows and the tree can restructure entirely.

The **random forest** (Breiman, 2001) is the elegant fix. Grow many trees, each on a bootstrap resample of the rows and — crucially — each split choosing from a *random subset of features*. Then average their predictions (or vote). Because the trees are **decorrelated**, their errors partially cancel, and averaging slashes variance without raising bias much. The result is one of the most reliable off-the-shelf models ever built: strong accuracy, minimal tuning, and free out-of-bag validation.

**Concrete real-world example.** A wildlife team classifies animal species from camera-trap features (size, color, time-of-day, location). A single decision tree gives a clean, explainable flowchart but its accuracy swings depending on which photos landed in training. Swapping in a random forest of 300 trees lifts accuracy several points and makes it stable across seasons, while `feature_importances_` still tells the biologists which measurements matter most. They lose the single printable flowchart but gain a model they can trust in the field.

By the end you'll know exactly how a split is chosen (Gini/entropy/variance reduction), why deep trees overfit, how bagging and feature-subsampling decorrelate trees, and how to read feature importance without being fooled by its biases.

## 2. Core Concepts

- **Node & split** — an internal node tests one feature against a threshold, sending rows left or right; a **leaf** holds the final prediction.
- **Gini impurity** — `1 − Σ pₖ²`, the chance of mislabeling a random element if labeled by the node's class distribution; 0 = pure.
- **Entropy** — `−Σ pₖ log pₖ`, an alternative impurity; **information gain** is the entropy drop from a split.
- **Variance reduction** — the regression analogue: pick the split that most reduces the weighted variance of the target.
- **Greedy recursive splitting** — trees are built top-down, choosing the locally best split at each node (not globally optimal).
- **Pruning / depth limits** — stopping or trimming the tree (`max_depth`, `min_samples_leaf`, cost-complexity `ccp_alpha`) to fight overfitting.
- **Bagging (bootstrap aggregating)** — train each tree on a random resample-with-replacement of the rows, then average/vote.
- **Feature subsampling (`max_features`)** — at each split consider only a random subset of features, the key that *decorrelates* forest trees.
- **Out-of-bag (OOB) score** — each tree's bootstrap omits ~37% of rows; predicting those gives a free validation estimate.
- **Feature importance** — how much each feature reduced impurity (fast, biased) or degraded accuracy when permuted (slower, honest).

## 3. Theory & Mathematical Intuition

**How a split is chosen.** At each node the tree searches every feature and every candidate threshold for the split that most reduces impurity. For classification, impurity is usually Gini `G = 1 − Σₖ pₖ²` or entropy `H = −Σₖ pₖ log₂ pₖ`. A split's quality is the **weighted impurity decrease**:

```text
ΔI = I(parent) − ( n_L/n · I(left) + n_R/n · I(right) )
choose the (feature, threshold) that maximizes ΔI     # greedy, per node
```

Gini and entropy usually pick nearly identical splits; Gini is slightly cheaper (no log) and the default. For **regression** the impurity is variance, so you pick the split that most reduces `Σ(y − ȳ)²` in the children — equivalently, minimizes within-child MSE.

**Why trees overfit.** A tree grown without limits keeps splitting until every leaf is pure — in the limit, one leaf per training row. That fits the training data perfectly (zero bias) but memorizes noise, so tiny data changes reshuffle the splits: **high variance**. A single deep tree is the poster child for the bias-variance trade-off's variance side.

**Why averaging trees helps.** If you average `B` identically-distributed predictions each with variance `σ²` and pairwise correlation `ρ`, the variance of the average is:

```text
Var(avg) = ρ·σ²  +  (1 − ρ)/B · σ²
```

As `B → ∞` the second term vanishes, leaving `ρ·σ²`. So the *only* way to keep driving variance down is to **lower the correlation ρ** between trees. Bagging (different row samples) helps a little, but bootstrap samples overlap ~63%, so the trees stay correlated. Breiman's key trick — **randomly restricting the features considered at each split** (`max_features ≈ √d` for classification) — forces trees to look different, cutting ρ dramatically. That is the whole reason a random forest beats plain bagged trees.

**Out-of-bag magic.** Each bootstrap sample leaves out about `(1 − 1/n)ⁿ → 1/e ≈ 37%` of the rows. Predict each row using only the trees that didn't see it, and you get an unbiased validation score for free — no separate holdout needed.

```svg
<svg viewBox="0 0 720 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="260" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">A decision tree splits to reduce impurity</text>
  <rect x="300" y="40" width="120" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">income &gt; 50k?</text>
  <text x="360" y="76" text-anchor="middle" fill="#1e293b" font-size="10">Gini 0.48</text>
  <rect x="140" y="120" width="120" height="42" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="200" y="140" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">age &lt; 30?</text>
  <text x="200" y="156" text-anchor="middle" fill="#1e293b" font-size="10">Gini 0.32</text>
  <rect x="470" y="120" width="120" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="530" y="140" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">debt &gt; 10k?</text>
  <text x="530" y="156" text-anchor="middle" fill="#1e293b" font-size="10">Gini 0.21</text>
  <rect x="70" y="198" width="90" height="38" rx="8" fill="#f0fdf4" stroke="#16a34a"/><text x="115" y="222" text-anchor="middle" fill="#1e293b" font-size="11">approve</text>
  <rect x="200" y="198" width="90" height="38" rx="8" fill="#fee2e2" stroke="#dc2626"/><text x="245" y="222" text-anchor="middle" fill="#1e293b" font-size="11">deny</text>
  <rect x="430" y="198" width="90" height="38" rx="8" fill="#f0fdf4" stroke="#16a34a"/><text x="475" y="222" text-anchor="middle" fill="#1e293b" font-size="11">approve</text>
  <rect x="560" y="198" width="90" height="38" rx="8" fill="#fee2e2" stroke="#dc2626"/><text x="605" y="222" text-anchor="middle" fill="#1e293b" font-size="11">deny</text>
  <line x1="330" y1="82" x2="220" y2="120" stroke="#1e293b" stroke-width="2"/><text x="255" y="104" fill="#16a34a" font-size="10">yes</text>
  <line x1="390" y1="82" x2="510" y2="120" stroke="#1e293b" stroke-width="2"/><text x="450" y="104" fill="#dc2626" font-size="10">no</text>
  <line x1="180" y1="162" x2="130" y2="198" stroke="#1e293b" stroke-width="2"/>
  <line x1="220" y1="162" x2="245" y2="198" stroke="#1e293b" stroke-width="2"/>
  <line x1="510" y1="162" x2="480" y2="198" stroke="#1e293b" stroke-width="2"/>
  <line x1="550" y1="162" x2="600" y2="198" stroke="#1e293b" stroke-width="2"/>
</svg>
```

## 4. Architecture & Workflow

1. **Grow a tree (per estimator).** Starting at the root, evaluate candidate splits, pick the one with the largest impurity decrease, partition the rows, and recurse until a stopping rule (`max_depth`, `min_samples_leaf`, pure node) fires.
2. **Bag the rows.** For a forest, draw a bootstrap sample (n rows with replacement) for each of the `B` trees, so every tree sees a slightly different dataset.
3. **Subsample features per split.** At each node, restrict the candidate features to a random subset of size `max_features` (~√d classification, ~d/3 regression). This is what decorrelates the trees.
4. **Aggregate.** For classification, majority-vote (or average class probabilities); for regression, average the leaf predictions across all trees.
5. **Validate with OOB.** Score each row on the ~37% of trees that didn't train on it to get a free, honest estimate; use it to tune `B`, `max_depth`, and `max_features`.
6. **Interpret.** Read `feature_importances_` for a fast ranking, but prefer **permutation importance** on held-out data for an unbiased view, and SHAP for per-prediction explanations.

```svg
<svg viewBox="0 0 760 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="240" fill="#ffffff"/>
  <rect x="20" y="95" width="120" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="80" y="118" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Training set</text>
  <text x="80" y="135" text-anchor="middle" fill="#1e293b" font-size="10">n rows, d features</text>
  <rect x="190" y="30" width="150" height="34" rx="7" fill="#e0f2fe" stroke="#0ea5e9"/><text x="265" y="52" text-anchor="middle" fill="#1e293b" font-size="11">bootstrap 1 → tree 1</text>
  <rect x="190" y="78" width="150" height="34" rx="7" fill="#e0f2fe" stroke="#0ea5e9"/><text x="265" y="100" text-anchor="middle" fill="#1e293b" font-size="11">bootstrap 2 → tree 2</text>
  <rect x="190" y="126" width="150" height="34" rx="7" fill="#e0f2fe" stroke="#0ea5e9"/><text x="265" y="148" text-anchor="middle" fill="#1e293b" font-size="11">bootstrap 3 → tree 3</text>
  <rect x="190" y="174" width="150" height="34" rx="7" fill="#e0f2fe" stroke="#0ea5e9"/><text x="265" y="196" text-anchor="middle" fill="#1e293b" font-size="11">… → tree B</text>
  <text x="410" y="118" text-anchor="middle" fill="#1e293b" font-size="10">√d features</text>
  <text x="410" y="132" text-anchor="middle" fill="#1e293b" font-size="10">per split</text>
  <rect x="470" y="95" width="140" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="540" y="117" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">vote / average</text>
  <text x="540" y="134" text-anchor="middle" fill="#1e293b" font-size="10">aggregate B trees</text>
  <rect x="650" y="95" width="90" height="50" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="695" y="118" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">prediction</text>
  <text x="695" y="134" text-anchor="middle" fill="#1e293b" font-size="10">low variance</text>
  <line x1="140" y1="120" x2="188" y2="47" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="140" y1="120" x2="188" y2="95" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="140" y1="120" x2="188" y2="143" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="140" y1="120" x2="188" y2="191" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="340" y1="47" x2="468" y2="108" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="340" y1="95" x2="468" y2="115" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="340" y1="143" x2="468" y2="125" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="340" y1="191" x2="468" y2="132" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#a10)"/>
  <line x1="610" y1="120" x2="648" y2="120" stroke="#1e293b" stroke-width="2" marker-end="url(#a10)"/>
  <defs><marker id="a10" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#1e293b"/></marker></defs>
</svg>
```

## 5. Implementation

A single tree overfits; a forest doesn't. Watch the train-vs-test gap:

```python
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier

X, y = make_classification(n_samples=4000, n_features=20, n_informative=8, random_state=0)
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=0)

deep = DecisionTreeClassifier(random_state=0).fit(Xtr, ytr)   # no depth limit
print(f"tree  train={deep.score(Xtr,ytr):.3f}  test={deep.score(Xte,yte):.3f}")
# tree  train=1.000  test=0.808   <-- memorized: huge gap = high variance

forest = RandomForestClassifier(n_estimators=300, max_features="sqrt",
                                oob_score=True, n_jobs=-1, random_state=0).fit(Xtr, ytr)
print(f"forest train={forest.score(Xtr,ytr):.3f}  test={forest.score(Xte,yte):.3f}"
      f"  oob={forest.oob_score_:.3f}")
# forest train=1.000 test=0.887 oob=0.884  <-- test≈oob, variance averaged away
```

Reading the split logic and impurity by hand for one small tree:

```python
import numpy as np
def gini(y):
    _, counts = np.unique(y, return_counts=True)
    p = counts / counts.sum()
    return 1.0 - (p ** 2).sum()

def best_split(x, y):
    parent = gini(y); best = (None, -1.0)
    for t in np.unique(x)[:-1]:                      # candidate thresholds
        left, right = y[x <= t], y[x > t]
        w = len(left) / len(y)
        gain = parent - (w * gini(left) + (1 - w) * gini(right))
        if gain > best[1]:
            best = (t, gain)
    return best                                       # (threshold, information gain)

x = np.array([1, 2, 3, 6, 7, 8]); y = np.array([0, 0, 0, 1, 1, 1])
print(best_split(x, y))   # (3, 0.5)  perfect split at x=3 gives full Gini gain
```

Honest feature importance via permutation (impurity importance is biased toward high-cardinality features):

```python
from sklearn.inspection import permutation_importance
import numpy as np

# Fast but biased: built-in impurity importance
imp_builtin = forest.feature_importances_

# Slower but honest: how much does test accuracy drop when a feature is shuffled?
perm = permutation_importance(forest, Xte, yte, n_repeats=10,
                              random_state=0, n_jobs=-1)
top = np.argsort(perm.importances_mean)[::-1][:5]
print("top features by permutation importance:", top.tolist())
# top features by permutation importance: [12, 3, 7, 1, 15]
```

> **Optimization:** forests parallelize perfectly — set `n_jobs=-1` to grow trees across all cores, since trees are independent. Cap tree depth or `min_samples_leaf` to shrink model size and inference latency; a 300-tree forest can be tens of MB. Use `max_samples < 1.0` to bag on a subsample for faster training on huge data, and prefer `HistGradientBoosting` or a forest's `warm_start` to tune `n_estimators` incrementally. For inference at scale, more trees only help up to a point — the variance floor is `ρ·σ²`, so past ~200–500 trees you pay latency for negligible gain.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Single tree interpretability | A readable flowchart; explain any path | Extremely high variance, unstable to data changes |
| No preprocessing | No scaling, handles mixed types & non-linearity | Splits are axis-aligned; diagonal boundaries need many splits |
| Random forest accuracy | Strong, robust, minimal tuning out of the box | Loses the single-tree explainability; a "black box of trees" |
| Variance reduction | Averaging decorrelated trees crushes variance | Can't reduce bias much — a forest of stumps still underfits |
| OOB validation | Free unbiased estimate, no holdout needed | Slightly pessimistic; not a substitute for a real test set |
| Feature importance | Built-in ranking for free | Impurity importance is biased; use permutation/SHAP |
| Inference | Embarrassingly parallel training | Large memory footprint; slower predict than a linear model |

## 7. Common Mistakes & Best Practices

1. ⚠️ Growing a single tree to full depth and trusting it → ✅ Limit depth / `min_samples_leaf` or use a forest; a full tree memorizes noise.
2. ⚠️ Trusting `feature_importances_` blindly → ✅ It's biased toward high-cardinality/continuous features; confirm with permutation importance or SHAP on held-out data.
3. ⚠️ Expecting a forest to extrapolate → ✅ Trees predict constants in leaves, so they can't extrapolate beyond the training range; forests inherit this — use linear models for extrapolation.
4. ⚠️ Using too few trees → ✅ Variance keeps dropping with `n_estimators` until it plateaus; use 200–500 and check the OOB curve, but don't over-pay past the plateau.
5. ⚠️ Leaving `max_features` at the max → ✅ Restricting features per split is what decorrelates trees; `sqrt`/`log2` for classification, `~1/3` for regression.
6. ⚠️ One-hot encoding high-cardinality categoricals for trees → ✅ It fragments splits and inflates importance; use ordinal/target encoding or a library with native categorical support.
7. ⚠️ Treating OOB score as a final test metric → ✅ It's a great tuning signal but still keep a true untouched test set for the headline number.
8. ⚠️ Ignoring class imbalance → ✅ Use `class_weight="balanced"` or balanced subsampling; trees happily predict the majority otherwise.
9. ⚠️ Comparing trees to a linear model without tuning depth → ✅ An unpruned tree always overfits; tune `max_depth`/`ccp_alpha` for a fair comparison.
10. ⚠️ Assuming a forest is inherently interpretable → ✅ Hundreds of trees are a black box; reach for permutation importance, partial-dependence plots, and SHAP.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** A huge train-vs-test accuracy gap on a single tree signals overfitting — reduce depth or switch to a forest. If a forest underfits (train and test both low), the trees are too shallow or `max_features` too small; deepen them. If one feature dominates importance suspiciously, check for leakage (a proxy for the target) — trees find leaks eagerly because a leaky feature gives a perfect split. Visualize a couple of trees or a partial-dependence plot to sanity-check that splits are sensible.

**Monitoring.** Track prediction distribution and per-feature drift (PSI/KL) — because trees can't extrapolate, inputs drifting outside the training range silently clamp to boundary leaves and degrade quietly. Monitor feature-importance stability across retrains; a sudden reshuffle hints at data-pipeline changes or drift. Log OOB or validation score at each retrain as a regression guardrail.

**Security.** Trees expose their logic: publishing a tree or its importances can reveal sensitive thresholds (e.g. the exact income cutoff for a loan), inviting gaming — users nudge a known high-importance feature across a threshold. Keep split thresholds private, validate input ranges, and watch for adversarial inputs crafted near decision boundaries. Feature-importance leakage can also disclose which private attributes drive decisions, a fairness/compliance concern.

**Scaling.** Training is embarrassingly parallel (`n_jobs=-1`, or distributed with Spark MLlib / cuML on GPU). Model size grows with `n_estimators × nodes`; prune depth to bound memory and latency. For very large datasets, subsample rows per tree (`max_samples`) and features to keep training tractable, and consider histogram-based implementations. At inference, a forest is `B` tree traversals — vectorize or compile (e.g. `treelite`) to hit low-latency SLAs, and cache if inputs repeat.

## 9. Interview Questions

**Q: How does a decision tree decide where to split?**
A: It greedily searches every feature and threshold for the split that most reduces impurity — Gini or entropy for classification, variance for regression — measured as the parent impurity minus the weighted average child impurity (information gain). It picks the locally best split at each node and recurses, which is greedy, not globally optimal.

**Q: What's the difference between Gini impurity and entropy?**
A: Both measure node impurity and usually choose nearly identical splits. Gini is `1 − Σpₖ²`, entropy is `−Σpₖ log pₖ`. Gini is slightly cheaper (no logarithm) and is scikit-learn's default; entropy corresponds to information gain and is marginally more sensitive to probability changes. In practice the choice rarely matters.

**Q: Why do decision trees overfit, and how do you control it?**
A: Grown without limits, a tree keeps splitting until leaves are pure — in the limit one row per leaf — so it memorizes noise and has very high variance. Control it with `max_depth`, `min_samples_leaf`, `min_samples_split`, or cost-complexity pruning (`ccp_alpha`), or by ensembling many trees into a forest.

**Q: How does a random forest reduce variance?**
A: It averages many trees, and the variance of an average of correlated predictors is `ρσ² + (1−ρ)/B·σ²`. Adding trees (B) drives the second term to zero, but the floor is `ρσ²`, so the real trick is lowering correlation ρ. Bagging plus random feature subsampling at each split decorrelates the trees, which is what makes the average so much better than a single tree.

**Q: What is bagging and why does it help?**
A: Bagging (bootstrap aggregating) trains each model on a random resample-with-replacement of the rows and averages their outputs. Because each tree sees different data, their errors partially cancel when averaged, reducing variance. It helps high-variance, low-bias models like deep trees the most and barely helps stable models like linear regression.

**Q: What is the out-of-bag score?**
A: Each bootstrap sample omits about 37% of the rows (`1/e`). For each row you predict using only the trees that didn't train on it, yielding an unbiased validation estimate without a separate holdout. It's excellent for tuning, though you should still keep a true test set for the final reported number.

**Q: Why does a random forest subsample features at each split?**
A: If one feature is very strong, every tree would split on it first and the trees would be highly correlated, so averaging wouldn't help much. Restricting each split to a random feature subset (`max_features ≈ √d`) forces trees to explore other features, decorrelating them and unlocking the variance reduction that averaging provides.

**Q: (Senior) Why is built-in feature importance misleading, and what do you use instead?**
A: Impurity-based importance is biased toward high-cardinality and continuous features because they offer more split points and can reduce impurity by chance, and it's computed on training data so it rewards overfitting. Use permutation importance on held-out data (how much accuracy drops when a feature is shuffled) or SHAP values for consistent, per-prediction attributions.

**Q: (Senior) Can a random forest overfit, and how would you tell?**
A: Much less than a single tree, but yes — with very deep trees, too few samples per leaf, or leaky features it can. The tell is a large gap between train (near 100%) and OOB/test accuracy that doesn't close as you add trees. Adding more trees never overfits (it only reduces variance toward the floor); depth and leaf size are the knobs that cause overfitting.

**Q: (Senior) Why can't tree-based models extrapolate, and when does that bite you?**
A: A tree predicts the constant value of whichever leaf an input falls into, and leaves are bounded by training-data splits, so any input beyond the training range clamps to the nearest boundary leaf — it cannot output a value outside the observed target range. This bites time-series with trends or any regression where the future exceeds past values; use a linear or additive model for extrapolation.

**Q: When would you choose a random forest over gradient boosting?**
A: When you want strong accuracy with almost no tuning, robust behavior, easy parallelism, and free OOB validation, or when you're prototyping and want a reliable baseline fast. Gradient boosting usually edges out a forest on raw accuracy but needs careful tuning and is sequential; forests are the safer, lower-effort default.

**Q: How do random forests handle missing values and mixed feature types?**
A: Trees split on thresholds and category membership, so they handle numeric and categorical features without scaling and are naturally robust to monotonic transforms. Some implementations route missing values down a default branch or learn the best direction; scikit-learn historically required imputation, while modern histogram-based trees and boosting libraries handle NaNs natively.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A decision tree greedily splits the feature space to reduce impurity (Gini/entropy for classification, variance for regression) until a stopping rule fires; grown fully it memorizes noise — high variance. A random forest fixes this by averaging many trees, each trained on a bootstrap sample and each split limited to a random √d feature subset. The averaging trick works only because it *decorrelates* the trees — variance of the average is `ρσ² + (1−ρ)/B·σ²`, so lowering ρ (feature subsampling) is the real lever. Forests give strong accuracy with little tuning, free OOB validation, and feature importance — but use permutation importance, not the biased built-in one, and remember trees can't extrapolate.

| Knob | Effect |
|---|---|
| `max_depth` ↓ | less overfit, more bias |
| `min_samples_leaf` ↑ | smoother, less variance |
| `n_estimators` ↑ | lower variance → plateau |
| `max_features` ↓ | more decorrelation |
| `class_weight` | handle imbalance |

**Flash cards**
- **Split rule** → maximize impurity decrease `I(parent) − weighted I(children)`.
- **Why trees overfit** → split until leaves pure = memorize noise = high variance.
- **Forest's key trick** → random feature subset per split decorrelates trees (lowers ρ).
- **OOB score** → validate on the ~37% each tree didn't see; free estimate.
- **Importance caveat** → built-in is biased; prefer permutation importance / SHAP.

## 11. Hands-On Exercises & Mini Project

- [ ] Grow trees at `max_depth` 1..20 and plot train vs. test accuracy to see the variance explosion.
- [ ] Implement Gini and the best-split search from scratch and match scikit-learn's first split.
- [ ] Sweep `n_estimators` from 1 to 500 and plot the OOB error curve; find where it plateaus.
- [ ] Compare built-in vs. permutation feature importance on a dataset with a high-cardinality ID column and explain the difference.
- [ ] Show a forest failing to extrapolate: train on x in [0,10], predict at x=20, and compare to linear regression.

**Mini Project — Camera-Trap Species Classifier**
*Goal:* build and interpret a random forest that classifies species from tabular sensor/image-derived features.
*Requirements:* (1) train a single tree and a forest, comparing train/test/OOB accuracy to demonstrate variance reduction; (2) tune `max_depth`, `max_features`, and `n_estimators` using OOB score; (3) produce permutation importance and a partial-dependence plot for the top two features; (4) handle class imbalance across rare species; (5) report a confusion matrix on a locked test set.
*Extensions:* add SHAP explanations for individual predictions; compare against gradient boosting on accuracy and training time; profile inference latency and compile the forest with `treelite` to hit a 5 ms budget.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Gradient Boosting: XGBoost, LightGBM & CatBoost* (the sequential cousin that usually wins accuracy), *The ML Workflow & Data Splits* (OOB vs. proper test sets), *Feature Engineering & Preprocessing* (encoding categoricals for trees), *Linear & Logistic Regression* (the extrapolating, interpretable alternative), and *Probability & Statistics* (bias-variance behind it all).

**Free Learning Resources**
- **StatQuest: Decision Trees & Random Forests** — Josh Starmer · *Beginner* · the definitive visual explanation of splits, Gini, and bagging. <https://www.youtube.com/watch?v=7VeUPuFGJHk>
- **scikit-learn: Decision Trees & Ensembles** — scikit-learn docs · *Intermediate* · authoritative reference with tuning guidance and pitfalls. <https://scikit-learn.org/stable/modules/ensemble.html#forest>
- **Random Forests** — Leo Breiman (original paper) · *Advanced* · the 2001 paper that introduced feature subsampling and OOB. <https://www.stat.berkeley.edu/~breiman/randomforest2001.pdf>
- **An Introduction to Statistical Learning (Ch. 8: Tree-Based Methods)** — James, Witten, Hastie, Tibshirani · *Intermediate* · free textbook chapter on trees, bagging, and forests. <https://www.statlearning.com/>
- **scikit-learn: Permutation Importance** — scikit-learn docs · *Intermediate* · why impurity importance misleads and how to compute honest importance. <https://scikit-learn.org/stable/modules/permutation_importance.html>
- **Interpretable Machine Learning** — Christoph Molnar · *Intermediate* · free book covering trees, feature importance, PDP, and SHAP. <https://christophm.github.io/interpretable-ml-book/>
- **Kaggle: Machine Learning (Random Forests)** — Kaggle Learn · *Beginner* · short hands-on lessons building and validating forests. <https://www.kaggle.com/learn/intro-to-machine-learning>

---

*AI Engineering Handbook — chapter 10.*
