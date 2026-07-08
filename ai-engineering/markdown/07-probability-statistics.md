# 07 · Probability & Statistics for AI

> **In one line:** Machine learning is applied probability — every loss function, every metric, and every "confidence" a model reports is a statistical statement, so the math here is the grammar of the whole field.

---

## 1. Overview

Probability and statistics are the load-bearing math of AI. A classifier does not output a class; it outputs a **probability distribution** over classes, and you pick the argmax. A regression model does not "know" a house price; it predicts the **mean** of a conditional distribution `p(price | features)`. Training minimizes a loss that is almost always a **negative log-likelihood** in disguise. If you understand distributions, expectation, and Bayes' rule, most of ML stops being a bag of tricks and becomes a single coherent story: *estimate a distribution, then use it to decide.*

The **problem it solves** is decision-making under uncertainty. Real data is noisy, incomplete, and sampled — you never see the true population, only a finite draw from it. Probability gives you a language to quantify "how sure am I," and statistics gives you the tools to infer population facts from a sample without fooling yourself. Every time a model says "spam with 0.98 probability" or an A/B test says "the new model is better with p < 0.01," that is this chapter at work.

Historically, the field braids two threads: **frequentist** statistics (Fisher, Neyman, Pearson — probabilities are long-run frequencies, estimate parameters, run hypothesis tests) and **Bayesian** statistics (Bayes, Laplace — probabilities are degrees of belief you update with evidence). Modern ML uses both fluidly: maximum-likelihood training is frequentist in spirit, while regularization, priors, and calibrated uncertainty are Bayesian.

**Concrete real-world example.** A fraud-detection model scores each transaction. Fraud is rare — say 0.3% of transactions. A model that is "99% accurate" can be worthless (predicting "not fraud" for everything is 99.7% accurate). To reason correctly you need the **base rate**, **Bayes' rule** to combine the model's signal with that rate, the **expected cost** of a false negative versus a false positive, and a **calibrated probability** so a threshold means what it says. Skip the statistics and you ship a model that looks great on a dashboard and loses money in production.

By the end of this chapter you should be able to read a loss function and name the distribution it assumes, compute a posterior from a prior and a likelihood, and explain why variance — not just bias — determines whether your model generalizes.

## 2. Core Concepts

- **Random variable** — a quantity whose value depends on a random outcome; discrete (dice, class label) or continuous (height, a logit).
- **Probability distribution** — the function assigning probability mass (PMF, discrete) or density (PDF, continuous) to values; e.g. Bernoulli, Categorical, Gaussian, Poisson.
- **Expectation `E[X]`** — the probability-weighted average, `Σ x·p(x)` or `∫ x·p(x) dx`; the "center of mass" and the thing most losses try to predict.
- **Variance & standard deviation** — `Var(X) = E[(X − E[X])²]`, the spread; std is its square root, in the same units as `X`.
- **Conditional probability `p(A|B)`** — probability of `A` given `B` is known; the engine of all prediction: models learn `p(y | x)`.
- **Bayes' rule** — `p(A|B) = p(B|A)·p(A) / p(B)`; how to invert a conditional and update beliefs with evidence.
- **Likelihood** — `p(data | parameters)` viewed as a function of the parameters; maximizing it (MLE) is how most models are fit.
- **Independence** — `p(A,B) = p(A)·p(B)`; the "naive" assumption in Naive Bayes and the reason i.i.d. sampling matters.
- **Entropy `H(X)`** — `−Σ p(x)·log p(x)`, the average surprise / bits needed to encode outcomes; the basis of cross-entropy loss.
- **Bias–variance** — a decomposition of expected error into systematic error (bias) plus sensitivity to the training sample (variance).

## 3. Theory & Mathematical Intuition

**Distributions are model assumptions.** When you choose a loss, you are implicitly choosing a distribution for the target given the inputs. Mean-squared-error assumes `y | x ~ Gaussian(μ = model(x), σ²)`; minimizing MSE is exactly maximizing that Gaussian likelihood. Binary cross-entropy assumes `y | x ~ Bernoulli(p = model(x))`. This is the single most useful idea in the chapter: **loss ↔ distribution.**

The **Gaussian** density is `p(x) = (1/√(2πσ²)) · exp(−(x−μ)² / (2σ²))`. Take its log and the constant drops away, leaving `−(x−μ)²/(2σ²)` — the squared error. That is why least-squares and Gaussian noise are the same assumption.

**Maximum likelihood.** Given i.i.d. data `x₁…xₙ`, the likelihood is `L(θ) = Π p(xᵢ | θ)`. Products underflow, so we maximize the **log-likelihood** `ℓ(θ) = Σ log p(xᵢ | θ)`. Minimizing negative log-likelihood is the universal training objective:

```text
NLL(θ) = − Σ_i log p(y_i | x_i ; θ)
softmax(z_i) = e^{z_i} / Σ_j e^{z_j}       # turns logits into a categorical distribution
cross_entropy = − Σ_i y_i · log(ŷ_i)        # NLL for the categorical case
```

**Bayes' rule** is the other pillar. It lets you go from `p(evidence | hypothesis)` — which models give you — to `p(hypothesis | evidence)` — which you actually want:

```text
p(θ | data) = p(data | θ) · p(θ) / p(data)
 posterior  =   likelihood · prior  / evidence
```

The **base-rate example** makes this concrete. A disease has prevalence 1% (`p(D)=0.01`). A test has 99% sensitivity (`p(+|D)=0.99`) and 5% false-positive rate (`p(+|¬D)=0.05`). If you test positive:

```text
p(D|+) = (0.99·0.01) / (0.99·0.01 + 0.05·0.99) = 0.0099 / 0.0594 ≈ 0.167
```

Only ~17% — because the disease is rare, most positives are false positives. Ignore the prior and you are off by 6×. This is the same math as fraud detection, spam, and medical AI.

**Entropy and cross-entropy.** Entropy `H(p) = −Σ p(x) log p(x)` measures uncertainty. **Cross-entropy** `H(p,q) = −Σ p(x) log q(x)` measures the cost of using distribution `q` when truth is `p`; it is minimized when `q = p`, which is why it works as a training loss. Their difference is the **KL divergence** `D_KL(p‖q) = H(p,q) − H(p)`, the "distance" from your model to the truth.

The diagram below shows how three families of distributions cover the cases you meet in ML.

```svg
<svg viewBox="0 0 720 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="260" fill="#ffffff"/>
  <rect x="20" y="30" width="210" height="200" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="125" y="55" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Bernoulli / Categorical</text>
  <text x="125" y="78" text-anchor="middle" fill="#1e293b" font-size="12">discrete outcomes</text>
  <rect x="55" y="100" width="30" height="90" fill="#4f46e5"/>
  <rect x="105" y="140" width="30" height="50" fill="#4f46e5"/>
  <rect x="155" y="120" width="30" height="70" fill="#4f46e5"/>
  <text x="125" y="212" text-anchor="middle" fill="#1e293b" font-size="12">loss: cross-entropy</text>
  <rect x="255" y="30" width="210" height="200" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="360" y="55" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Gaussian</text>
  <text x="360" y="78" text-anchor="middle" fill="#1e293b" font-size="12">continuous targets</text>
  <path d="M275 190 Q360 90 445 190" fill="none" stroke="#0ea5e9" stroke-width="3"/>
  <line x1="360" y1="100" x2="360" y2="190" stroke="#1e293b" stroke-dasharray="4 3"/>
  <text x="360" y="212" text-anchor="middle" fill="#1e293b" font-size="12">loss: MSE</text>
  <rect x="490" y="30" width="210" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="595" y="55" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Poisson</text>
  <text x="595" y="78" text-anchor="middle" fill="#1e293b" font-size="12">counts / rare events</text>
  <rect x="520" y="150" width="22" height="40" fill="#16a34a"/>
  <rect x="552" y="115" width="22" height="75" fill="#16a34a"/>
  <rect x="584" y="130" width="22" height="60" fill="#16a34a"/>
  <rect x="616" y="165" width="22" height="25" fill="#16a34a"/>
  <rect x="648" y="178" width="22" height="12" fill="#16a34a"/>
  <text x="595" y="212" text-anchor="middle" fill="#1e293b" font-size="12">loss: Poisson NLL</text>
</svg>
```

## 4. Architecture & Workflow

Statistics is not a step in the ML pipeline — it is woven through every step. Here is the workflow, framed statistically:

1. **Frame the target distribution.** Decide what `p(y | x)` looks like. Binary label → Bernoulli → sigmoid + BCE. Multi-class → Categorical → softmax + cross-entropy. Real value → Gaussian → linear head + MSE. Count → Poisson. This choice *is* your loss.
2. **Sample the data.** Assume (and check) that rows are i.i.d. draws from the population. Non-i.i.d. data — time series, grouped users, leakage — breaks every guarantee downstream.
3. **Estimate parameters by MLE/MAP.** Training minimizes negative log-likelihood (MLE). Add a prior over weights and you minimize NLL + regularization (MAP) — L2 is a Gaussian prior, L1 is a Laplace prior.
4. **Quantify uncertainty.** A point prediction is incomplete. Report a calibrated probability, a prediction interval, or an ensemble spread so downstream decisions can weigh risk.
5. **Decide with expected cost.** Convert probabilities to actions by minimizing expected cost, not by defaulting to a 0.5 threshold. Pick the threshold that minimizes `E[cost] = FP·cost_FP + FN·cost_FN`.
6. **Evaluate on a held-out sample and test significance.** Metrics are themselves random variables; a 0.2% AUC gain on 500 examples is noise. Use confidence intervals and hypothesis tests before believing a win.

```svg
<svg viewBox="0 0 760 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="250" fill="#ffffff"/>
  <rect x="20" y="95" width="130" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="85" y="120" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Population</text>
  <text x="85" y="140" text-anchor="middle" fill="#1e293b" font-size="11">true p(y|x)</text>
  <rect x="200" y="95" width="130" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="265" y="120" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Sample</text>
  <text x="265" y="140" text-anchor="middle" fill="#1e293b" font-size="11">i.i.d. draw</text>
  <rect x="380" y="95" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="455" y="118" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">MLE / MAP</text>
  <text x="455" y="138" text-anchor="middle" fill="#1e293b" font-size="11">min negative log-lik</text>
  <rect x="580" y="55" width="160" height="55" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="660" y="78" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Calibrated p̂(y|x)</text>
  <text x="660" y="97" text-anchor="middle" fill="#1e293b" font-size="11">uncertainty</text>
  <rect x="580" y="140" width="160" height="55" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="660" y="163" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Decision</text>
  <text x="660" y="182" text-anchor="middle" fill="#1e293b" font-size="11">min expected cost</text>
  <line x1="150" y1="125" x2="198" y2="125" stroke="#1e293b" stroke-width="2" marker-end="url(#a7)"/>
  <line x1="330" y1="125" x2="378" y2="125" stroke="#1e293b" stroke-width="2" marker-end="url(#a7)"/>
  <line x1="530" y1="115" x2="578" y2="90" stroke="#1e293b" stroke-width="2" marker-end="url(#a7)"/>
  <line x1="580" y1="167" x2="530" y2="140" stroke="#1e293b" stroke-width="2" marker-end="url(#a7)"/>
  <defs>
    <marker id="a7" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
</svg>
```

## 5. Implementation

Simulate the disease-test Bayes calculation and confirm it against a Monte-Carlo run.

```python
import numpy as np
rng = np.random.default_rng(42)

prevalence, sensitivity, fpr = 0.01, 0.99, 0.05

# Analytical posterior via Bayes' rule
num = sensitivity * prevalence
den = num + fpr * (1 - prevalence)
posterior = num / den
print(f"P(disease | +) = {posterior:.4f}")   # P(disease | +) = 0.1667

# Monte-Carlo check with 2,000,000 people
n = 2_000_000
has_disease = rng.random(n) < prevalence
tested_pos = np.where(has_disease, rng.random(n) < sensitivity,
                                   rng.random(n) < fpr)
emp = has_disease[tested_pos].mean()
print(f"empirical      = {emp:.4f}")          # empirical      = 0.1665
```

Show that minimizing MSE recovers the mean and that cross-entropy is negative log-likelihood.

```python
import numpy as np

# 1) MSE is minimized at the mean of the data
y = np.array([3.0, 5.0, 5.0, 8.0, 9.0])
grid = np.linspace(0, 12, 1201)
mse = ((y[:, None] - grid[None, :]) ** 2).mean(axis=0)
print("argmin MSE:", round(grid[mse.argmin()], 2), " mean:", y.mean())
# argmin MSE: 6.0  mean: 6.0

# 2) Cross-entropy == negative log-likelihood of a Bernoulli
def bce(y_true, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -(y_true * np.log(p) + (1 - y_true) * np.log(1 - p)).mean()

y_true = np.array([1, 0, 1, 1, 0])
p_good = np.array([0.9, 0.1, 0.8, 0.7, 0.2])
p_bad  = np.array([0.5, 0.5, 0.5, 0.5, 0.5])
print(f"good model BCE={bce(y_true, p_good):.3f}  bad model BCE={bce(y_true, p_bad):.3f}")
# good model BCE=0.235  bad model BCE=0.693   (0.693 = log 2 = pure guessing)
```

Bootstrap a confidence interval — the practical tool for "is this metric real?"

```python
import numpy as np
rng = np.random.default_rng(0)

scores = rng.normal(0.82, 0.06, size=400)          # per-example accuracy proxy
boot = [rng.choice(scores, size=scores.size, replace=True).mean()
        for _ in range(10_000)]
lo, hi = np.percentile(boot, [2.5, 97.5])
print(f"mean={scores.mean():.3f}  95% CI=[{lo:.3f}, {hi:.3f}]")
# mean=0.821  95% CI=[0.815, 0.827]
```

> **Optimization:** the bootstrap loop above is O(B·n) Python; vectorize by drawing all resamples at once with `rng.integers(0, n, size=(B, n))` and indexing `scores[idx].mean(axis=1)`. On 10k resamples of 400 points this is ~50× faster and fits in memory. For very large n, use the Gaussian approximation `mean ± 1.96·std/√n` instead of resampling.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Probabilistic outputs | Calibrated confidence enables cost-aware decisions and abstention | Requires calibration; raw softmax is often over-confident |
| MLE training | Universal, well-understood, asymptotically efficient | Overfits with little data; needs a prior (regularization) |
| Bayesian priors | Encode domain knowledge, regularize, quantify uncertainty | Choosing/justifying a prior is subjective; inference can be costly |
| Frequentist tests | Objective error control (Type-I/II rates) | p-values are widely misinterpreted; sensitive to sample size |
| Gaussian assumption | Closed-form, fast, MSE just works | Breaks on heavy tails/outliers; median/robust loss may be better |
| Entropy/cross-entropy | Differentiable, information-theoretic grounding | Log is unstable near 0/1; needs clipping and logits, not probs |

## 7. Common Mistakes & Best Practices

1. ⚠️ Ignoring the base rate ("99% accurate!") → ✅ Always report metrics that respect prevalence (precision/recall, PR-AUC) and use Bayes' rule to interpret positives.
2. ⚠️ Treating softmax outputs as calibrated probabilities → ✅ Check a reliability diagram; apply temperature scaling or isotonic regression if mis-calibrated.
3. ⚠️ Confusing correlation with causation → ✅ Remember that a fitted `p(y|x)` predicts, it does not explain; use experiments or causal methods for "why."
4. ⚠️ Assuming i.i.d. when data is grouped or temporal → ✅ Split by group/time, not randomly, or every estimate is optimistically biased.
5. ⚠️ Reporting a point estimate with no uncertainty → ✅ Attach a confidence/prediction interval; a metric without a CI is an anecdote.
6. ⚠️ p-hacking / peeking at A/B tests → ✅ Fix sample size or use sequential tests; a p-value you stopped at when it dipped below 0.05 is meaningless.
7. ⚠️ Using accuracy on imbalanced data → ✅ Use PR-AUC, F1, or expected-cost; accuracy rewards predicting the majority class.
8. ⚠️ `log(0)` blow-ups in cross-entropy → ✅ Compute the loss from logits with `log_softmax`/`BCEWithLogitsLoss`, never from clipped probabilities.
9. ⚠️ Forgetting variance in the bias–variance trade → ✅ A model with tiny training error and huge test error is high-variance; add data or regularization, don't add capacity.
10. ⚠️ Comparing models on a single test draw → ✅ Bootstrap or cross-validate the metric to know if the difference exceeds noise.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a probabilistic model behaves oddly, first plot the predicted-probability histogram: a spike at 0/1 signals over-confidence or leakage; a pile at the base rate signals an under-fit model that learned only the prior. Compare loss to the entropy of the label distribution — if train loss can't beat `H(labels)`, the model learned nothing.

**Monitoring.** Track **calibration drift** (Expected Calibration Error over time), **prediction distribution** (mean predicted probability vs. observed positive rate), and **input distribution shift** with population-stability index (PSI) or KL divergence between the training and live feature histograms. A rising KL is your early warning that the world moved and `p(x)` no longer matches training.

**Security.** Probabilistic outputs leak information: confident, calibrated scores enable **membership-inference** attacks (was this record in training?). Mitigate with differential privacy or by coarsening exposed scores. Also guard against **distribution-shift attacks** where an adversary crafts inputs from a region your training sample never covered — your calibration guarantees do not hold there.

**Performance & Scaling.** Prefer log-space arithmetic everywhere (`logsumexp`, `log_softmax`) for numerical stability at scale. For uncertainty at inference cost, deep ensembles or MC-dropout give usable intervals without full Bayesian inference. For streaming statistics on billions of events, use Welford's online mean/variance and reservoir sampling rather than materializing the data. When estimating rare-event rates (fraud, clicks), the standard error scales as `√(p(1−p)/n)` — you need proportionally more data as `p` shrinks, so budget sample size accordingly.

## 9. Interview Questions

**Q: What is the difference between a PMF and a PDF?**
A: A PMF gives the actual probability of each value of a discrete random variable, and its values sum to 1. A PDF gives probability *density* for a continuous variable, so a single point has probability 0 and you integrate over an interval to get a probability; the density can exceed 1.

**Q: Why does minimizing mean-squared error correspond to a Gaussian assumption?**
A: MSE is the negative log-likelihood of `y | x ~ Gaussian(model(x), σ²)` up to constants: taking the log of the Gaussian density leaves `−(y−μ)²/(2σ²)`. So least-squares regression is maximum likelihood under Gaussian noise, which is why it is sensitive to outliers (the tails are thin).

**Q: State Bayes' rule and explain each term.**
A: `p(θ|D) = p(D|θ)·p(θ)/p(D)`. `p(θ)` is the prior belief before data, `p(D|θ)` is the likelihood of the data under parameters, `p(D)` is the marginal evidence (normalizer), and `p(θ|D)` is the posterior — your updated belief. Prediction learns the likelihood; decisions want the posterior.

**Q: A test is 99% sensitive with a 5% false-positive rate for a disease with 1% prevalence. You test positive — how worried should you be?**
A: About 17%. `p(D|+) = (0.99·0.01)/(0.99·0.01 + 0.05·0.99) ≈ 0.167`. Because the disease is rare, most positives come from the large healthy population's false-positive stream. This is the base-rate fallacy.

**Q: What is entropy and how does it relate to cross-entropy loss?**
A: Entropy `H(p) = −Σ p log p` is the average surprise / minimum bits to encode outcomes from `p`. Cross-entropy `H(p,q) = −Σ p log q` is the cost of encoding truth `p` with model `q`; it is minimized when `q=p`, so minimizing it drives the model toward the true distribution. Their gap is the KL divergence.

**Q: Explain the bias–variance decomposition.**
A: Expected test error splits into bias² (systematic error from a too-simple model), variance (sensitivity to the particular training sample), and irreducible noise. High bias = underfitting, high variance = overfitting. You trade one for the other via model capacity and regularization.

**Q: What does it mean for a classifier to be calibrated?**
A: Among all cases where it predicts probability 0.7, about 70% are actually positive. Calibration is separate from accuracy — a model can rank well (high AUC) yet be badly calibrated. You check it with a reliability diagram and fix it with temperature or isotonic scaling.

**Q: (Senior) When would you prefer a Bayesian (MAP) estimate over a maximum-likelihood one?**
A: When data is scarce or noisy, when you have genuine prior knowledge, or when you need uncertainty for downstream decisions. MAP adds a prior term to the log-likelihood, which regularizes — L2 weight decay is a zero-mean Gaussian prior, L1 is a Laplace prior. With abundant data the prior washes out and MAP ≈ MLE.

**Q: (Senior) Why is accuracy a poor metric for rare-event detection, and what would you use?**
A: With a 0.3% positive rate, predicting "negative" always scores 99.7% accuracy while catching zero events. Accuracy ignores the cost asymmetry and the base rate. Use precision/recall, PR-AUC, or better, define per-error costs and minimize expected cost, choosing the decision threshold accordingly rather than defaulting to 0.5.

**Q: (Senior) An A/B test hits p < 0.05 after you check it daily for two weeks. Do you trust it?**
A: No. Repeated peeking inflates the false-positive rate far above 5% — under the null you will eventually cross 0.05 by chance. Fix a sample size in advance, or use a sequential/always-valid test (e.g. mSPRT, group-sequential boundaries) designed for continuous monitoring.

**Q: (Senior) How do you quantify whether two models' evaluation scores differ meaningfully?**
A: Treat the metric as a random variable and estimate its sampling distribution: bootstrap the test set (or use paired resampling / McNemar's test for classification) to get a confidence interval on the difference. If the CI for the difference excludes 0, the gap is likely real; a raw point difference on one split is not evidence.

**Q: What is the law of large numbers versus the central limit theorem?**
A: The law of large numbers says the sample mean converges to the true mean as `n→∞`. The central limit theorem says the *distribution* of that sample mean approaches a Gaussian with standard error `σ/√n`, regardless of the population's shape. LLN justifies estimation; CLT justifies confidence intervals and t-tests.

**Q: Why do we maximize log-likelihood instead of likelihood directly?**
A: The likelihood is a product over data points, which underflows to 0 numerically and is hard to differentiate. Taking the log turns products into sums, is monotonic (same argmax), stabilizes the numbers, and yields the additive loss (sum over examples) that gradient descent expects.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Machine learning estimates `p(y|x)`. Your loss encodes the assumed distribution: Bernoulli → BCE, Categorical → cross-entropy, Gaussian → MSE, Poisson → count loss. Training = minimize negative log-likelihood (MLE); add a prior and it becomes MAP, i.e. regularization (L2 = Gaussian prior, L1 = Laplace). Bayes' rule inverts a conditional and forces you to respect base rates — the reason a rare-disease positive is usually a false alarm. Entropy measures uncertainty; cross-entropy and KL measure distance to the truth. Always report uncertainty (bootstrap CI), respect i.i.d. when splitting, and turn probabilities into actions by minimizing expected cost, not by defaulting to 0.5.

| Concept | Formula | Use in ML |
|---|---|---|
| Expectation | `E[X]=Σ x·p(x)` | what regression predicts |
| Variance | `E[(X−E[X])²]` | spread, bias-variance |
| Bayes | `p(A|B)=p(B|A)p(A)/p(B)` | posteriors, base rates |
| MLE | `argmax Σ log p(xᵢ|θ)` | training objective |
| Cross-entropy | `−Σ p log q` | classification loss |
| Std error | `σ/√n` | confidence intervals |

**Flash cards**
- **Loss ↔ distribution** → MSE=Gaussian, BCE=Bernoulli, CE=Categorical, count=Poisson.
- **Base-rate fallacy** → ignoring the prior makes rare-positive tests look far more reliable than they are.
- **Calibration** → predicted 0.7 should mean 70% actually positive; independent of accuracy.
- **MAP = MLE + prior** → L2 is a Gaussian prior, L1 a Laplace prior on the weights.
- **CLT** → sample means are ~Gaussian with spread `σ/√n`, whatever the population shape.

## 11. Hands-On Exercises & Mini Project

- [ ] Derive on paper that minimizing MSE gives the mean and minimizing MAE gives the median of the targets; verify numerically.
- [ ] Implement temperature scaling: fit a single scalar `T` on a validation set to minimize NLL and plot the reliability diagram before/after.
- [ ] Reproduce the base-rate example with a Monte-Carlo simulation and sweep prevalence from 0.001 to 0.5, plotting `p(D|+)`.
- [ ] Vectorize the bootstrap CI and compare its width to the Gaussian `±1.96·σ/√n` approximation across sample sizes.
- [ ] Show empirically that repeatedly peeking at an A/B test inflates the false-positive rate above 5%.

**Mini Project — A Calibrated, Cost-Aware Fraud Classifier**
*Goal:* build an end-to-end classifier whose outputs are probabilities you can trust and act on.
*Requirements:* (1) train any classifier on an imbalanced tabular dataset (e.g. credit-card fraud); (2) plot the reliability diagram and report Expected Calibration Error; (3) apply temperature or isotonic calibration and re-measure ECE; (4) define per-error costs and compute the expected-cost-minimizing threshold; (5) bootstrap a 95% CI on PR-AUC and on the chosen operating point's precision/recall.
*Extensions:* add a "reject/abstain" option when predicted probability lands in an uncertain band; add PSI monitoring that flags feature drift on a shifted test set; compare a deep-ensemble uncertainty estimate to MC-dropout.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *The ML Workflow & Data Splits* (sampling and honest evaluation), *Linear & Logistic Regression* (MLE in action), *Feature Engineering & Preprocessing* (distributions of inputs), and the evaluation-metrics chapters that build on precision/recall and calibration.

**Free Learning Resources**
- **Seeing Theory** — Brown University (Kunin) · *Beginner* · gorgeous interactive visualizations of probability, distributions, and Bayes. <https://seeing-theory.brown.edu/>
- **StatQuest with Josh Starmer** — YouTube · *Beginner–Intermediate* · the clearest short explainers on likelihood, cross-entropy, and bias-variance. <https://www.youtube.com/c/joshstarmer>
- **3Blue1Brown: Bayes' theorem** — Grant Sanderson · *Beginner* · builds unforgettable geometric intuition for updating beliefs. <https://www.youtube.com/watch?v=HZGCoVF3YvM>
- **MIT 6.041 Probabilistic Systems Analysis** — MIT OCW (Tsitsiklis) · *Intermediate* · a rigorous, free full course with problem sets. <https://ocw.mit.edu/courses/6-041-probabilistic-systems-analysis-and-applied-probability-fall-2010/>
- **Think Bayes** — Allen Downey · *Intermediate* · free book teaching Bayesian statistics through Python code. <https://allendowney.github.io/ThinkBayes2/>
- **Mathematics for Machine Learning (Part I: Statistics)** — Deisenroth, Faisal, Ong · *Intermediate–Advanced* · free PDF grounding the probability behind ML. <https://mml-book.github.io/>
- **scikit-learn: Probability calibration** — scikit-learn docs · *Intermediate* · practical guide with reliability diagrams and calibrators. <https://scikit-learn.org/stable/modules/calibration.html>

---

*AI Engineering Handbook — chapter 07.*
