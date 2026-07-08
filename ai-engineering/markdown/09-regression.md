# 09 · Linear & Logistic Regression

> **In one line:** Two linear models — one predicts a number, one predicts a probability — that together form the foundation every neural network is built on and the baseline every serious project should beat first.

---

## 1. Overview

Linear and logistic regression are the two workhorses of classical machine learning. **Linear regression** predicts a continuous number — a price, a temperature, a demand — as a weighted sum of features. **Logistic regression** predicts a probability — spam or not, click or not, churn or not — by squashing that same weighted sum through a sigmoid. They share one skeleton, `z = w·x + b`, and differ only in what they do with `z` and which loss they minimize. Master these two and you understand the atom of nearly every model that came after: a single neuron *is* logistic regression, and a deep network is just many of them stacked.

The **problem they solve** is turning a vector of features into a decision, with a model simple enough to train instantly, interpret directly, and deploy anywhere. Every coefficient tells you how the prediction moves when a feature moves — a transparency that deep models sacrifice. That is why regression remains the default in medicine, credit scoring, and econometrics, where you must *explain* the decision, and why it is the baseline that keeps ambitious teams honest: if your transformer can't beat logistic regression, the problem is your data, not your model.

The history is deep. Least-squares linear regression dates to Gauss and Legendre around 1800 for predicting planetary orbits. Logistic regression came from early-1900s population growth curves and was formalized for statistics by the 1950s. Both predate computers, yet they remain in daily production use two centuries later — a testament to how much a linear boundary buys you.

**Concrete real-world example.** A bank scores loan applications. Regulators require that every denial come with reasons ("income too low, too many recent inquiries"). A logistic-regression credit model outputs a default probability *and* a set of signed coefficients you can translate directly into those reasons — "this feature pushed your risk up by X." A gradient-boosted forest might score marginally higher on AUC but can't hand a regulator clean, monotonic, per-feature explanations. Here the linear model wins on the requirement that actually matters.

By the end you'll be able to derive both losses, explain why logistic regression uses cross-entropy and not MSE, apply L1/L2 regularization deliberately, and read coefficients as odds ratios.

## 2. Core Concepts

- **Feature vector `x`** — the numeric inputs for one example; categorical fields are encoded into numbers first.
- **Weights `w` and bias `b`** — the learned coefficients; `wⱼ` is how much prediction changes per unit of feature `j`.
- **Linear predictor `z = w·x + b`** — the shared core of both models; a dot product plus an intercept.
- **Sigmoid `σ(z) = 1/(1+e^{−z})`** — squashes any real `z` into (0,1) to read as a probability; the logistic link.
- **Loss function** — MSE for regression (Gaussian assumption), binary cross-entropy for logistic (Bernoulli assumption).
- **Gradient descent** — iteratively nudge `w` down the loss gradient; the universal optimizer for both when closed forms don't scale.
- **Regularization (L1/L2)** — a penalty on weight size; L2 (ridge) shrinks, L1 (lasso) zeros out features for sparsity.
- **Odds & log-odds** — logistic regression is linear in the *log-odds* `log(p/(1−p)) = z`; `e^{wⱼ}` is the odds ratio per unit of feature `j`.
- **Decision threshold** — the probability cutoff (default 0.5) that converts a logistic probability into a class; tune it by cost.
- **Multicollinearity** — correlated features that make individual coefficients unstable and un-interpretable.

## 3. Theory & Mathematical Intuition

**Linear regression.** The model is `ŷ = w·x + b`. Fit it by minimizing mean-squared error `L = (1/n) Σ (yᵢ − ŷᵢ)²`. This has a closed form — the **normal equations** `w = (XᵀX)⁻¹ Xᵀy` — which is exact but costs `O(d³)` to invert and breaks when features are collinear (`XᵀX` becomes singular). As shown in the statistics chapter, minimizing MSE is maximum likelihood under Gaussian noise, which is why outliers hurt so much: squared error gives a single far point enormous leverage.

**Logistic regression.** You *cannot* just threshold a linear output for classification — the prediction should be a probability, bounded in (0,1). So pass `z` through the sigmoid: `p = σ(z) = 1/(1+e^{−z})`. Now `p` is `P(y=1 | x)`. The natural loss is **binary cross-entropy** (negative log-likelihood of a Bernoulli):

```text
z = w·x + b
p = σ(z) = 1 / (1 + e^{-z})
BCE = -(1/n) Σ_i [ y_i·log(p_i) + (1 - y_i)·log(1 - p_i) ]
```

**Why not MSE for logistic regression?** Two reasons. First, MSE composed with the sigmoid is **non-convex**, so gradient descent can get stuck; cross-entropy composed with the sigmoid is convex with a single global minimum. Second, MSE's gradient vanishes when the model is confidently wrong (the sigmoid saturates), so learning stalls exactly when it most needs to correct. Cross-entropy's gradient stays healthy.

The gradients are remarkably clean and *identical in form* for both models — the "prediction minus target, times the input":

```text
∂L/∂w = (1/n) Σ_i (p_i - y_i) · x_i        # logistic (and linear, with p→ŷ)
∂L/∂b = (1/n) Σ_i (p_i - y_i)
w ← w - η · ∂L/∂w                          # gradient-descent update, η = learning rate
```

**Interpreting logistic coefficients.** Because `log(p/(1−p)) = w·x + b`, the model is *linear in the log-odds*. A one-unit increase in feature `j` multiplies the odds by `e^{wⱼ}` — the **odds ratio**. So `wⱼ = 0.7` means the odds of the positive class rise by `e^{0.7} ≈ 2×` per unit. This direct interpretability is the model's superpower.

**Regularization.** Add a penalty to keep weights small and fight overfitting: L2/ridge adds `λ‖w‖²` (shrinks all weights smoothly, a Gaussian prior), L1/lasso adds `λ‖w‖₁` (drives some weights to exactly 0, doing feature selection, a Laplace prior). Elastic-net mixes both.

```svg
<svg viewBox="0 0 720 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="250" fill="#ffffff"/>
  <text x="180" y="24" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Linear: fit a line, minimize MSE</text>
  <line x1="60" y1="210" x2="330" y2="210" stroke="#1e293b"/>
  <line x1="60" y1="210" x2="60" y2="50" stroke="#1e293b"/>
  <line x1="70" y1="195" x2="320" y2="70" stroke="#4f46e5" stroke-width="3"/>
  <circle cx="100" cy="185" r="4" fill="#0ea5e9"/><circle cx="140" cy="160" r="4" fill="#0ea5e9"/>
  <circle cx="180" cy="150" r="4" fill="#0ea5e9"/><circle cx="220" cy="120" r="4" fill="#0ea5e9"/>
  <circle cx="260" cy="105" r="4" fill="#0ea5e9"/><circle cx="300" cy="80" r="4" fill="#0ea5e9"/>
  <line x1="180" y1="150" x2="180" y2="135" stroke="#d97706" stroke-dasharray="3 2"/>
  <text x="195" y="140" fill="#d97706" font-size="10">residual</text>
  <text x="540" y="24" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Logistic: sigmoid squashes to (0,1)</text>
  <line x1="410" y1="210" x2="690" y2="210" stroke="#1e293b"/>
  <line x1="410" y1="210" x2="410" y2="50" stroke="#1e293b"/>
  <path d="M410 205 C500 205 520 60 690 55" fill="none" stroke="#16a34a" stroke-width="3"/>
  <line x1="410" y1="130" x2="690" y2="130" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="695" y="134" fill="#1e293b" font-size="10">0.5</text>
  <text x="415" y="60" fill="#1e293b" font-size="10">p=1</text>
  <text x="415" y="205" fill="#1e293b" font-size="10">p=0</text>
  <circle cx="450" cy="205" r="4" fill="#4f46e5"/><circle cx="480" cy="205" r="4" fill="#4f46e5"/>
  <circle cx="620" cy="55" r="4" fill="#dc2626"/><circle cx="660" cy="55" r="4" fill="#dc2626"/>
</svg>
```

## 4. Architecture & Workflow

1. **Assemble features.** Encode categoricals, impute missing values, and — critically for linear models — **scale** numeric features so no coefficient is dwarfed by a large-magnitude column and so gradient descent converges evenly.
2. **Pick the model.** Continuous target → linear regression. Binary target → logistic regression. Multi-class → softmax (multinomial logistic) regression.
3. **Choose the loss and regularizer.** MSE or Huber (robust) for regression; cross-entropy for classification. Add L2 by default; L1 if you want sparse, self-selecting features.
4. **Optimize.** Small data → closed form / L-BFGS. Large or streaming data → (mini-batch) stochastic gradient descent with a tuned learning rate. Watch the loss curve descend.
5. **Calibrate and threshold.** Logistic outputs are usually well-calibrated out of the box; pick the decision threshold by minimizing expected cost, not by defaulting to 0.5.
6. **Interpret & ship.** Read coefficients (odds ratios for logistic), check for multicollinearity (VIF), validate on held-out data, and deploy — a linear model is just a dot product, trivially fast and portable.

```svg
<svg viewBox="0 0 760 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="210" fill="#ffffff"/>
  <rect x="20" y="80" width="110" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="75" y="102" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">features x</text>
  <text x="75" y="120" text-anchor="middle" fill="#1e293b" font-size="10">scaled/encoded</text>
  <rect x="170" y="80" width="120" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="230" y="102" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">z = w·x + b</text>
  <text x="230" y="120" text-anchor="middle" fill="#1e293b" font-size="10">linear core</text>
  <rect x="330" y="30" width="150" height="50" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="405" y="52" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">identity → ŷ</text>
  <text x="405" y="70" text-anchor="middle" fill="#1e293b" font-size="10">regression, MSE</text>
  <rect x="330" y="130" width="150" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="405" y="152" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">σ(z) → p</text>
  <text x="405" y="170" text-anchor="middle" fill="#1e293b" font-size="10">classification, BCE</text>
  <rect x="520" y="80" width="120" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="580" y="102" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">loss + λ·pen</text>
  <text x="580" y="120" text-anchor="middle" fill="#1e293b" font-size="10">L1 / L2</text>
  <rect x="670" y="80" width="80" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="710" y="102" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">SGD</text>
  <text x="710" y="120" text-anchor="middle" fill="#1e293b" font-size="10">update w</text>
  <line x1="130" y1="105" x2="168" y2="105" stroke="#1e293b" stroke-width="2" marker-end="url(#a9)"/>
  <line x1="290" y1="95" x2="328" y2="60" stroke="#1e293b" stroke-width="2" marker-end="url(#a9)"/>
  <line x1="290" y1="115" x2="328" y2="150" stroke="#1e293b" stroke-width="2" marker-end="url(#a9)"/>
  <line x1="480" y1="105" x2="518" y2="105" stroke="#1e293b" stroke-width="2" marker-end="url(#a9)"/>
  <line x1="640" y1="105" x2="668" y2="105" stroke="#1e293b" stroke-width="2" marker-end="url(#a9)"/>
  <path d="M710 130 Q710 180 250 165 L250 132" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#a9)"/>
  <defs><marker id="a9" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#1e293b"/></marker></defs>
</svg>
```

## 5. Implementation

Logistic regression from scratch with numpy — 30 lines that reveal the whole mechanism:

```python
import numpy as np
rng = np.random.default_rng(0)

def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -500, 500)))

def train_logreg(X, y, lr=0.1, epochs=500, l2=1e-3):
    n, d = X.shape
    w, b = np.zeros(d), 0.0
    for _ in range(epochs):
        p = sigmoid(X @ w + b)
        error = p - y                       # the shared gradient signal
        w -= lr * (X.T @ error / n + l2 * w)  # + L2 shrinkage
        b -= lr * error.mean()
    return w, b

# toy separable-ish data
X = rng.normal(size=(800, 3))
true_w = np.array([2.0, -1.0, 0.5])
y = (sigmoid(X @ true_w) > rng.random(800)).astype(float)

w, b = train_logreg(X, y)
print("recovered w:", np.round(w, 2))       # recovered w: [1.98 -0.97 0.49]
print("odds ratios:", np.round(np.exp(w), 2))  # odds ratios: [7.24 0.38 1.63]
```

The production way — scikit-learn with a pipeline, regularization, and calibration check:

```python
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, brier_score_loss

X, y = make_classification(n_samples=5000, n_features=15, n_informative=6,
                           weights=[0.7, 0.3], random_state=0)
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, stratify=y, random_state=0)

# C is INVERSE regularization strength; penalty="l1" gives sparse coefficients
clf = make_pipeline(StandardScaler(),
                    LogisticRegression(penalty="l2", C=1.0, max_iter=1000))
clf.fit(Xtr, ytr)
proba = clf.predict_proba(Xte)[:, 1]
print(f"AUC={roc_auc_score(yte, proba):.3f}  Brier={brier_score_loss(yte, proba):.3f}")
# AUC=0.928  Brier=0.121   (low Brier → well-calibrated probabilities)
```

Linear regression: closed form vs. gradient descent, and why scaling matters:

```python
import numpy as np
rng = np.random.default_rng(1)
X = rng.normal(size=(500, 4)); w_true = np.array([1.5, -2.0, 0.0, 3.0])
y = X @ w_true + rng.normal(scale=0.5, size=500)

# Closed form (normal equations) — exact but O(d^3) and fails on collinearity
Xb = np.c_[X, np.ones(len(X))]
w_closed = np.linalg.lstsq(Xb, y, rcond=None)[0]
print("closed-form w:", np.round(w_closed[:4], 2))   # [1.49 -2.0 0.0 2.99]

# Ridge (L2) stabilizes when X^T X is near-singular: add λI before inverting
lam = 1.0
w_ridge = np.linalg.solve(Xb.T @ Xb + lam*np.eye(Xb.shape[1]), Xb.T @ y)
print("ridge w:      ", np.round(w_ridge[:4], 2))
```

> **Optimization:** for wide/sparse data (text TF-IDF, one-hot), use `LogisticRegression(solver="saga")` which handles L1/elastic-net and sparse matrices, or `SGDClassifier(loss="log_loss")` for out-of-core streaming with `partial_fit`. Always scale features first — unscaled inputs make the loss surface elongated so gradient descent zig-zags and needs far more iterations. Prefer L-BFGS (`solver="lbfgs"`) for dense small-to-medium problems; it converges in far fewer steps than plain SGD.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Interpretability | Signed coefficients / odds ratios explain every prediction | Only linear effects; interactions must be hand-crafted |
| Speed | Trains in seconds, predicts as one dot product | Underfits genuinely non-linear data |
| Calibration | Logistic outputs are usually well-calibrated probabilities | Needs enough data; extreme imbalance still distorts |
| Regularization | L1/L2 control overfitting and do feature selection | λ/C must be tuned; L1 arbitrary among correlated features |
| Baseline value | Sets the bar every complex model must beat | Rarely the final winner on rich, non-linear data |
| Deployment | Tiny model, portable anywhere, no GPU | Sensitive to feature scaling and multicollinearity |

## 7. Common Mistakes & Best Practices

1. ⚠️ Forgetting to scale features → ✅ StandardScale numeric inputs; unscaled features slow convergence and make L1/L2 penalize unfairly.
2. ⚠️ Using MSE loss for classification → ✅ Use cross-entropy; MSE+sigmoid is non-convex and its gradient vanishes when confidently wrong.
3. ⚠️ Interpreting logistic coefficients as probabilities → ✅ They're log-odds; exponentiate for odds ratios, and remember effects are multiplicative.
4. ⚠️ Ignoring multicollinearity → ✅ Check VIF/correlations; correlated features give unstable, misleading coefficients — drop, combine, or use L2.
5. ⚠️ Always thresholding at 0.5 → ✅ Choose the threshold that minimizes expected cost for your problem; 0.5 is rarely optimal under imbalance.
6. ⚠️ Adding a huge polynomial expansion with no regularization → ✅ Regularize (ridge) when you add interactions/polynomials, or you'll overfit instantly.
7. ⚠️ Leaving strong outliers in a linear regression → ✅ Squared error over-weights them; use Huber loss or robust regression, or clip/winsorize.
8. ⚠️ Reading L1's zeros as "these features don't matter" → ✅ Among correlated features L1 keeps one arbitrarily; use it for sparsity, not causal importance.
9. ⚠️ Confusing C and λ → ✅ In scikit-learn `C = 1/λ`, so *smaller* C means *stronger* regularization — the opposite of intuition.
10. ⚠️ Expecting a linear model to learn XOR/interactions → ✅ It can't natively; engineer interaction/polynomial features or switch to trees.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** If a logistic model won't train, first check scaling (a feature in the millions swamps the gradient), then the learning rate (loss NaN → too high; loss flat → too low), then class balance (all-one-class predictions → use `class_weight="balanced"`). Coefficients exploding to huge magnitudes signal separable data or multicollinearity — add regularization. Plot the loss curve; a clean monotonic descent confirms the optimizer is healthy.

**Monitoring.** Because coefficients are interpretable, monitoring is easy and powerful: track each coefficient's stability across retrains (a sign-flip is a red flag), the distribution of predicted probabilities (drift means the input world moved), and calibration (reliability diagram / Brier score) over time. Alert on feature drift with PSI — linear models extrapolate poorly, so out-of-range inputs at serve time produce wild predictions.

**Security.** Linear models are transparent, which is a double edge: an attacker who learns the coefficients can craft adversarial inputs by pushing the highest-weight features. Never expose raw coefficients on user-controllable features, validate/clip input ranges server-side, and watch for **gaming** — if a high-weight feature is user-supplied (e.g. self-reported income), users will inflate it. For regulated use, keep an audit log mapping coefficients to the human-readable reasons you surface.

**Scaling.** Prediction is a single dot product — nanoseconds, trivially cacheable, no GPU. Training scales to billions of rows with mini-batch SGD (`SGDClassifier.partial_fit`) or distributed L-BFGS. For very wide sparse features (millions of one-hot columns) use sparse matrices and the `saga`/`sag` solvers, and hash features to bound dimensionality. The whole model is a weight vector, so serialization and A/B rollout are near-instant.

## 9. Interview Questions

**Q: What is the difference between linear and logistic regression?**
A: Both compute a linear score `z = w·x + b`. Linear regression outputs `z` directly to predict a continuous number and minimizes MSE. Logistic regression passes `z` through a sigmoid to output a probability in (0,1) for binary classification and minimizes cross-entropy. Same core, different link function and loss.

**Q: Why can't you use MSE loss for logistic regression?**
A: Two reasons. MSE composed with the sigmoid is non-convex, so gradient descent can land in a local minimum. And its gradient vanishes when the model is confidently wrong (the sigmoid saturates), stalling learning exactly when correction is most needed. Cross-entropy is convex with the sigmoid and keeps a healthy gradient.

**Q: How do you interpret a logistic regression coefficient?**
A: The model is linear in the log-odds, so a coefficient `wⱼ` means a one-unit increase in feature j adds `wⱼ` to the log-odds, multiplying the odds of the positive class by `e^{wⱼ}` — the odds ratio. A positive coefficient raises the probability, negative lowers it, and the effect is multiplicative on odds, not additive on probability.

**Q: What's the difference between L1 and L2 regularization?**
A: L2 (ridge) adds `λ‖w‖²`, shrinking all weights smoothly toward zero without eliminating them, and handles correlated features gracefully. L1 (lasso) adds `λ‖w‖₁`, which drives some weights to exactly zero, performing automatic feature selection and yielding a sparse model. Elastic-net combines both.

**Q: Why do you need to scale features for linear models?**
A: Gradient descent converges much faster on a well-conditioned, spherical loss surface; unscaled features with very different magnitudes create an elongated surface that makes the optimizer zig-zag. Scaling also makes L1/L2 penalize features fairly, since the penalty is on coefficient magnitude, which depends on feature scale.

**Q: What is the closed-form solution for linear regression and when does it fail?**
A: The normal equations `w = (XᵀX)⁻¹Xᵀy` solve least squares exactly. They fail when `XᵀX` is singular or near-singular — from perfectly correlated features or more features than samples — and they cost `O(d³)`, impractical for high dimensions. Ridge regression (`+ λI`) or gradient descent fixes both.

**Q: In scikit-learn, does a larger C mean more or less regularization?**
A: Less. `C` is the inverse of regularization strength (`C = 1/λ`), so a large C means a weak penalty and a model that fits the training data more closely, while a small C means strong regularization and simpler coefficients. It's a common gotcha because it's the opposite of the intuitive direction.

**Q: (Senior) Your logistic regression achieves high accuracy but predicts almost everything as the majority class. What's happening and what do you do?**
A: The data is imbalanced and accuracy rewards predicting the majority. The default 0.5 threshold and unweighted loss both favor the majority class. Fix it with `class_weight="balanced"` (or resampling the training fold), evaluate with PR-AUC/F1 instead of accuracy, and choose the decision threshold by minimizing expected cost rather than defaulting to 0.5.

**Q: (Senior) When would you still choose logistic regression over gradient boosting in 2026?**
A: When you need transparent, per-feature explanations (credit, medicine, regulated decisions), when data is small or extremely high-dimensional-sparse (text), when you need a rock-solid calibrated baseline, or when inference must be a trivially fast, GPU-free dot product at massive scale. Boosting usually wins raw accuracy on rich tabular data, but not these requirements.

**Q: (Senior) How does multicollinearity affect a linear model, and how do you detect and handle it?**
A: Correlated features make the coefficient estimates unstable — large variance, unintuitive signs — because the model can't attribute effect between them, even though predictions may still be fine. Detect it with pairwise correlations and Variance Inflation Factor (VIF > 5–10 is a warning). Handle it by dropping/combining features, using PCA, or applying L2 regularization, which stabilizes the split of shared signal.

**Q: What is the sigmoid function and why is it used?**
A: `σ(z) = 1/(1+e^{−z})` maps any real number to (0,1), giving a monotonic, differentiable squashing that reads as a probability and has the clean derivative `σ(z)(1−σ(z))`. It's the inverse of the logit (log-odds) function, which is why logistic regression is linear in the log-odds.

**Q: How does softmax regression extend logistic regression to multiple classes?**
A: Instead of one weight vector and a sigmoid, you have one weight vector per class and apply softmax `e^{zₖ}/Σ e^{zⱼ}` to produce a probability distribution over classes, trained with categorical cross-entropy. Binary logistic regression is the two-class special case, and this multinomial form is exactly the final layer of a neural-network classifier.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Both models compute `z = w·x + b`. Linear regression returns `z` and minimizes MSE (Gaussian assumption, closed form via normal equations or gradient descent). Logistic regression applies the sigmoid to get a probability and minimizes cross-entropy (Bernoulli assumption, convex, no closed form). Their gradient is the same shape: `(prediction − target)·x`. Logistic coefficients are log-odds; `e^{wⱼ}` is the odds ratio. Always scale features; regularize with L2 (shrink) or L1 (sparsify), remembering scikit-learn's `C = 1/λ`. Choose the threshold by cost, not 0.5. These are the interpretable baseline every project should beat first and the atom every neural network is built from.

| Item | Linear | Logistic |
|---|---|---|
| Output | number `ŷ = z` | probability `σ(z)` |
| Loss | MSE | cross-entropy |
| Assumption | Gaussian noise | Bernoulli |
| Closed form | normal equations | none (iterative) |
| Coefficient meaning | Δŷ per unit | Δlog-odds per unit |

**Flash cards**
- **Shared core** → `z = w·x + b`; link + loss are the only difference.
- **Why not MSE for logistic** → non-convex with sigmoid + vanishing gradient when confidently wrong.
- **Odds ratio** → `e^{wⱼ}`; per-unit multiplicative effect on odds.
- **L1 vs L2** → L1 zeros features (sparsity), L2 shrinks smoothly (stability).
- **C gotcha** → in sklearn `C = 1/λ`; smaller C = stronger regularization.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement logistic regression from scratch and verify recovered weights match scikit-learn's on the same data.
- [ ] Plot the loss surface of MSE+sigmoid vs. cross-entropy+sigmoid for a 1-D problem and confirm the non-convexity.
- [ ] Sweep `C` from 1e-3 to 1e3 and plot the number of non-zero L1 coefficients and validation AUC.
- [ ] Add polynomial/interaction features to a linear regression and show overfitting appear, then tame it with ridge.
- [ ] Compute odds ratios on a real dataset (e.g. Titanic) and translate the top three into plain-English risk statements.

**Mini Project — An Explainable Credit-Risk Scorer**
*Goal:* build a logistic-regression default predictor that a compliance officer could sign off on.
*Requirements:* (1) preprocess a lending dataset with scaling and encoding inside a pipeline; (2) train L2-regularized logistic regression and report AUC, PR-AUC, and Brier score; (3) output odds ratios per feature and generate human-readable reasons for individual denials; (4) select the decision threshold by minimizing a stated cost matrix; (5) check calibration with a reliability diagram.
*Extensions:* add monotonicity constraints so risk can only increase with certain features; compare against gradient boosting on AUC and discuss the interpretability trade; add L1 to produce a sparse, self-documenting model and report which features survived.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Probability & Statistics for AI* (MLE, cross-entropy, calibration), *The ML Workflow & Data Splits* (honest evaluation of your baseline), *Feature Engineering & Preprocessing* (scaling, encoding, interactions that linear models need), *Gradient Boosting* (the model that usually beats it on tabular data), and any neural-network chapter (logistic regression is a single neuron).

**Free Learning Resources**
- **StatQuest: Logistic Regression** — Josh Starmer · *Beginner* · the clearest walkthrough of odds, log-odds, and maximum likelihood. <https://www.youtube.com/watch?v=yIYKR4sgzI8>
- **Andrew Ng — Machine Learning Specialization (Supervised Learning)** — DeepLearning.AI · *Beginner–Intermediate* · builds linear and logistic regression from first principles with hands-on labs. <https://www.deeplearning.ai/courses/machine-learning-specialization/>
- **scikit-learn: Linear Models** — scikit-learn docs · *Intermediate* · comprehensive reference for ridge, lasso, elastic-net, and logistic regression with solver guidance. <https://scikit-learn.org/stable/modules/linear_model.html>
- **CS229 Lecture Notes (Supervised Learning)** — Stanford / Andrew Ng · *Intermediate–Advanced* · rigorous derivations of least squares, logistic regression, and the exponential family. <https://cs229.stanford.edu/main_notes.pdf>
- **3Blue1Brown: Gradient descent** — Grant Sanderson · *Beginner* · geometric intuition for the optimizer both models rely on. <https://www.youtube.com/watch?v=IHZwWFHWa-w>
- **An Introduction to Statistical Learning** — James, Witten, Hastie, Tibshirani · *Intermediate* · free textbook with excellent chapters on linear and logistic regression and regularization. <https://www.statlearning.com/>
- **Google ML Crash Course: Logistic Regression** — Google · *Beginner* · concise interactive lessons with the sigmoid, log loss, and regularization. <https://developers.google.com/machine-learning/crash-course/logistic-regression>

---

*AI Engineering Handbook — chapter 09.*
