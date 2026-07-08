# 17 · Training Deep Nets: Optimizers, LR & Regularization

> **In one line:** SGD/Adam, learning-rate schedules, batch/layer norm, and dropout — the craft of turning a loss surface no human can picture into a model that actually converges.

---

## 1. Overview

**Training a deep network** is an exercise in numerical optimization on a non-convex loss surface with millions to billions of parameters. The forward pass computes a loss; backpropagation computes its gradient; an **optimizer** takes a step that (usually) lowers the loss. Do that a few hundred thousand times and — if the learning rate, normalization, and regularization are right — a useful function emerges. The whole chapter is about *making that loop converge fast and generalize well*.

The problem it solves is brutal in practice: raw gradient descent on a deep net either diverges (loss → NaN), crawls (loss barely moves for epochs), or overfits (train loss → 0, validation loss climbs). Each pathology has a named cure — momentum and adaptive learning rates for slow/noisy gradients, learning-rate **schedules** and **warmup** for the early-training instability, **normalization** layers for internal covariate shift and exploding activations, **dropout** and **weight decay** for overfitting, and **gradient clipping** for the rare exploding-gradient spike. Modern training is the disciplined composition of these tricks.

Historically the field moved from plain **SGD** (1950s roots, deep-learning revival ~2012 with AlexNet) to **momentum** and **Nesterov**, then to adaptive methods — **AdaGrad → RMSprop → Adam** (2014) — and finally to **AdamW** (2017), which fixed a subtle weight-decay bug and is now the default for training transformers. In parallel, **BatchNorm** (2015) unlocked much deeper CNNs, and **LayerNorm** became the backbone of every transformer.

A concrete example: training a GPT-style model. You use **AdamW** with `betas=(0.9, 0.95)`, a **cosine** learning-rate schedule with a few hundred steps of **linear warmup**, **gradient clipping** at norm 1.0, **weight decay** ~0.1 on the weight matrices (not on biases or LayerNorm), **bf16 mixed precision**, and **gradient accumulation** to reach an effective batch of millions of tokens on hardware that can only hold thousands at once. Every one of those choices is in this chapter.

The mental model to keep: **the optimizer decides the direction and size of each step; the schedule decides how that size changes over time; normalization keeps the activations and gradients in a sane range; regularization decides how much the model is allowed to memorize.** Get those four right and training is almost boring. Get one wrong and you stare at a NaN.

## 2. Core Concepts

- **Gradient descent** — update rule `θ ← θ − η·∇L(θ)` that moves parameters downhill; the entire family of optimizers are variations on this.
- **Learning rate (η)** — the single most important hyperparameter; the step-size multiplier on the gradient. Too high → divergence, too low → glacial convergence.
- **Momentum** — an exponentially-decaying running average of past gradients that accelerates along consistent directions and damps oscillation across ravines.
- **Adaptive optimizer** — one that gives each parameter its own effective learning rate from a running estimate of gradient magnitude (RMSprop, Adam, AdamW).
- **Learning-rate schedule** — a rule that changes η over the course of training (step decay, cosine, warmup, one-cycle) rather than holding it fixed.
- **Warmup** — starting η near zero and ramping up over the first few hundred/thousand steps so early, high-variance updates don't blow up an untrained model.
- **Batch normalization** — normalizes each feature across the **batch** dimension per layer, stabilizing and accelerating training; depends on batch statistics.
- **Layer normalization** — normalizes across the **feature** dimension per token independently of batch, which is why transformers use it.
- **Dropout** — randomly zeroing a fraction of activations at train time to prevent co-adaptation; a stochastic ensemble that regularizes.
- **Weight decay** — shrinking weights toward zero each step (`θ ← θ(1−ηλ) − η·g`), which limits model capacity and improves generalization; distinct from L2 in adaptive optimizers.
- **Gradient clipping** — capping the global gradient norm (or value) before the step so a single exploding batch can't wreck the weights.
- **Mixed precision (AMP)** — running most ops in bf16/fp16 for speed and memory while keeping a fp32 master copy and (for fp16) a loss scaler for numerical stability.

## 3. Theory & Mathematical Intuition

Start with plain **SGD** on a mini-batch: `g_t = ∇L_batch(θ_t)`, then `θ_{t+1} = θ_t − η·g_t`. The mini-batch makes `g_t` a noisy estimate of the true gradient — that noise is a feature (it helps escape sharp minima) and a bug (it slows convergence in ravines).

**Momentum** fixes the ravine problem with a velocity term:

```
v_t = μ·v_{t-1} + g_t
θ_{t+1} = θ_t − η·v_t          (μ ≈ 0.9)
```

The velocity accumulates gradient in directions that stay consistent and cancels directions that flip sign, so you accelerate down the valley and stop bouncing off the walls. **Nesterov** momentum looks ahead — it evaluates the gradient at the *anticipated* next point `θ_t − η·μ·v_{t-1}` — giving a better-informed, slightly more stable step.

**RMSprop** attacks a different problem: features with large gradients need small steps, features with tiny gradients need large ones. It keeps a running mean of squared gradients and divides by its root:

```
s_t = ρ·s_{t-1} + (1−ρ)·g_t²
θ_{t+1} = θ_t − η·g_t / (√s_t + ε)
```

**Adam** combines both ideas — momentum (first moment `m`) *and* RMSprop's per-parameter scaling (second moment `v`) — plus a **bias correction** because `m` and `v` start at zero:

```
m_t = β₁·m_{t-1} + (1−β₁)·g_t                 (β₁ = 0.9)
v_t = β₂·v_{t-1} + (1−β₂)·g_t²                (β₂ = 0.999, or 0.95 for LLMs)
m̂_t = m_t / (1 − β₁ᵗ)          v̂_t = v_t / (1 − β₂ᵗ)
θ_{t+1} = θ_t − η·m̂_t / (√v̂_t + ε)
```

**AdamW** decouples weight decay from the gradient. In classic Adam, adding L2 to the loss puts the decay term *inside* the adaptive denominator, so heavily-updated weights get decayed less — the opposite of what you want. AdamW applies decay directly to the weights, outside the adaptive step: `θ_{t+1} = θ_t − η·(m̂_t/(√v̂_t+ε) + λ·θ_t)`. That one change measurably improves generalization and is why AdamW, not Adam, trains modern models.

**Normalization** operates on activations, not weights. Given a pre-activation `x`, both norms compute `x̂ = (x − μ)/√(σ² + ε)` then a learnable affine `y = γ·x̂ + β`. The difference is the axis of the mean/variance: **BatchNorm** takes μ, σ² over the batch (and spatial) dims per channel — great for CNNs but broken for tiny/variable batches and sequence models; **LayerNorm** takes them over the feature dim per example — batch-independent, which is why transformers use it. The diagram below shows exactly which axis each one reduces over.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">BatchNorm vs LayerNorm: which axis is normalized</text>

  <text x="185" y="52" text-anchor="middle" fill="#4f46e5" font-size="13" font-weight="700">BatchNorm (normalize down each feature)</text>
  <text x="575" y="52" text-anchor="middle" fill="#0ea5e9" font-size="13" font-weight="700">LayerNorm (normalize across each row)</text>

  <text x="40" y="86" fill="#1e293b" font-size="11">samples</text>
  <text x="120" y="76" fill="#1e293b" font-size="11">f1</text>
  <text x="165" y="76" fill="#1e293b" font-size="11">f2</text>
  <text x="210" y="76" fill="#1e293b" font-size="11">f3</text>
  <text x="255" y="76" fill="#1e293b" font-size="11">f4</text>

  <rect x="105" y="90"  width="170" height="34" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="105" y="128" width="170" height="34" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <rect x="105" y="166" width="170" height="34" rx="4" fill="#eef2ff" stroke="#4f46e5"/>
  <line x1="152" y1="86" x2="152" y2="204" stroke="#4f46e5" stroke-dasharray="4 3"/>
  <line x1="197" y1="86" x2="197" y2="204" stroke="#4f46e5" stroke-dasharray="4 3"/>
  <line x1="242" y1="86" x2="242" y2="204" stroke="#4f46e5" stroke-dasharray="4 3"/>
  <text x="190" y="228" text-anchor="middle" fill="#475569" font-size="11">μ,σ over the batch → per-feature</text>
  <text x="190" y="246" text-anchor="middle" fill="#475569" font-size="11">breaks on batch size 1 / variable seq</text>

  <rect x="470" y="90"  width="200" height="34" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="470" y="128" width="200" height="34" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <rect x="470" y="166" width="200" height="34" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="570" y="228" text-anchor="middle" fill="#475569" font-size="11">μ,σ over features → per-sample</text>
  <text x="570" y="246" text-anchor="middle" fill="#475569" font-size="11">batch-independent → transformers</text>

  <text x="380" y="284" text-anchor="middle" fill="#64748b" font-size="11">Both then apply a learnable scale γ and shift β: y = γ·x̂ + β</text>
</svg>
```

Finally, **initialization** sets the starting variance so signals neither vanish nor explode through depth. **Xavier/Glorot** targets `Var(W) = 2/(fan_in + fan_out)` for tanh/sigmoid; **He/Kaiming** uses `Var(W) = 2/fan_in` for ReLU (which halves variance by zeroing negatives). Good init is why a 100-layer ResNet trains at all before BatchNorm even kicks in.

## 4. Architecture & Workflow

A production training loop is a pipeline of well-defined stages that repeat every step. The order matters: mixed precision wraps the forward/backward, unscaling must precede clipping, clipping must precede the optimizer step, and the scheduler steps after the optimizer.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <defs>
    <marker id="arw" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">One training step (AdamW + AMP + clip + cosine)</text>

  <rect x="30"  y="50" width="150" height="44" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="105" y="70" text-anchor="middle" fill="#1e293b" font-weight="700">Batch + aug</text>
  <text x="105" y="86" text-anchor="middle" fill="#64748b" font-size="11">to GPU (non_blocking)</text>

  <rect x="215" y="50" width="150" height="44" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="290" y="70" text-anchor="middle" fill="#1e293b" font-weight="700">Forward (autocast)</text>
  <text x="290" y="86" text-anchor="middle" fill="#64748b" font-size="11">bf16/fp16 → loss</text>

  <rect x="400" y="50" width="160" height="44" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="480" y="70" text-anchor="middle" fill="#1e293b" font-weight="700">scaler.scale(loss)</text>
  <text x="480" y="86" text-anchor="middle" fill="#64748b" font-size="11">.backward()</text>

  <rect x="595" y="50" width="160" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="675" y="70" text-anchor="middle" fill="#1e293b" font-weight="700">accumulate grads</text>
  <text x="675" y="86" text-anchor="middle" fill="#64748b" font-size="11">every N micro-steps</text>

  <rect x="595" y="150" width="160" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="675" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">unscale_(opt)</text>
  <text x="675" y="186" text-anchor="middle" fill="#64748b" font-size="11">fp32 grads restored</text>

  <rect x="400" y="150" width="160" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="480" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">clip_grad_norm_</text>
  <text x="480" y="186" text-anchor="middle" fill="#64748b" font-size="11">max_norm = 1.0</text>

  <rect x="215" y="150" width="150" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="290" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">scaler.step(opt)</text>
  <text x="290" y="186" text-anchor="middle" fill="#64748b" font-size="11">AdamW update</text>

  <rect x="30"  y="150" width="150" height="44" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="105" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">scheduler.step()</text>
  <text x="105" y="186" text-anchor="middle" fill="#64748b" font-size="11">warmup → cosine</text>

  <rect x="215" y="250" width="340" height="44" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="385" y="270" text-anchor="middle" fill="#1e293b" font-weight="700">zero_grad(set_to_none=True) → log loss / lr / grad-norm</text>
  <text x="385" y="286" text-anchor="middle" fill="#64748b" font-size="11">then next batch</text>

  <line x1="180" y1="72" x2="213" y2="72" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="365" y1="72" x2="398" y2="72" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="560" y1="72" x2="593" y2="72" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="675" y1="94" x2="675" y2="148" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="595" y1="172" x2="562" y2="172" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="400" y1="172" x2="367" y2="172" stroke="#475569" marker-end="url(#arw)"/>
  <line x1="215" y1="172" x2="182" y2="172" stroke="#475569" marker-end="url(#arw)"/>
  <path d="M105,194 L105,272 L213,272" fill="none" stroke="#475569" marker-end="url(#arw)"/>
</svg>
```

Step by step:

1. **Fetch & augment a batch**, move it to the GPU with `non_blocking=True` so the copy overlaps compute.
2. **Forward pass under `autocast`** so matmuls/convs run in bf16 (or fp16), producing the loss in low precision but accumulating reductions in fp32.
3. **Scale the loss and backpropagate.** With fp16 the `GradScaler` multiplies the loss up so small gradients don't underflow to zero; bf16 skips scaling.
4. **Gradient accumulation:** only every `N` micro-batches do you actually step, which simulates a batch `N×` larger than fits in memory. Divide the loss by `N` so the accumulated gradient has the right scale.
5. **Unscale**, then **clip** the global grad norm to `max_norm` (e.g. 1.0) — order matters, you clip real gradients, not scaled ones.
6. **Optimizer step** (`scaler.step`) applies the AdamW update; **`scaler.update()`** adjusts the fp16 scale factor.
7. **Scheduler step** advances the learning rate along warmup→cosine. **Zero the grads** with `set_to_none=True` (faster, less memory) and log loss/lr/grad-norm before the next iteration.

## 5. Implementation

A realistic, runnable AdamW + cosine-with-warmup + gradient-clipping + AMP training loop in PyTorch 2.x.

```python
import math
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

device = "cuda" if torch.cuda.is_available() else "cpu"
torch.manual_seed(0)

# --- toy model + data so this actually runs end-to-end -----------------
model = nn.Sequential(
    nn.Linear(256, 512), nn.LayerNorm(512), nn.GELU(), nn.Dropout(0.1),
    nn.Linear(512, 512), nn.LayerNorm(512), nn.GELU(), nn.Dropout(0.1),
    nn.Linear(512, 10),
).to(device)

X = torch.randn(20_000, 256)
y = (X[:, :10].sum(dim=1) > 0).long() % 10          # a learnable signal
loader = DataLoader(TensorDataset(X, y), batch_size=256, shuffle=True, drop_last=True)

# --- weight decay ONLY on 2D weights, not biases / LayerNorm ------------
decay, no_decay = [], []
for name, p in model.named_parameters():
    if not p.requires_grad:
        continue
    (no_decay if p.ndim < 2 else decay).append(p)

opt = torch.optim.AdamW(
    [{"params": decay, "weight_decay": 0.1},
     {"params": no_decay, "weight_decay": 0.0}],
    lr=3e-4, betas=(0.9, 0.95), eps=1e-8,
)

# --- LR schedule: linear warmup then cosine decay to ~0 -----------------
EPOCHS, WARMUP = 15, 100
total_steps = EPOCHS * len(loader)

def lr_lambda(step):
    if step < WARMUP:
        return step / max(1, WARMUP)                # 0 → 1 linearly
    prog = (step - WARMUP) / max(1, total_steps - WARMUP)
    return 0.5 * (1.0 + math.cos(math.pi * prog))   # 1 → 0 (cosine)

sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_lambda)
scaler = torch.cuda.amp.GradScaler(enabled=(device == "cuda"))
loss_fn = nn.CrossEntropyLoss()
ACCUM = 2                                            # effective batch = 512

step = 0
for epoch in range(EPOCHS):
    model.train()
    running = 0.0
    for i, (xb, yb) in enumerate(loader):
        xb, yb = xb.to(device, non_blocking=True), yb.to(device, non_blocking=True)
        with torch.autocast(device_type=device, dtype=torch.bfloat16,
                            enabled=(device == "cuda")):
            loss = loss_fn(model(xb), yb) / ACCUM
        scaler.scale(loss).backward()
        running += loss.item() * ACCUM

        if (i + 1) % ACCUM == 0:
            scaler.unscale_(opt)                     # restore fp32 grads
            gnorm = nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            scaler.step(opt)
            scaler.update()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
    print(f"epoch {epoch:02d}  loss {running/len(loader):.4f}  "
          f"lr {sched.get_last_lr()[0]:.2e}  gnorm {gnorm:.2f}")

# Realistic loss-curve behaviour you should SEE printed:
#   epoch 00  loss 2.30 ... 2.10   lr rises during warmup, grad-norm ~ 3-8 (clipped)
#   epoch 05  loss 1.20           lr near its peak, steadily falling
#   epoch 14  loss 0.35  lr 2e-06  grad-norm ~0.4 (no longer hitting the clip)
# If loss -> nan in step 1: lr too high, or fp16 without a scaler.
# If loss is flat: lr too low, or you forgot warmup and the first steps blew up silently.
```

The **LR finder** is the fastest way to pick that `3e-4`. Sweep the LR exponentially over a couple hundred batches and plot loss vs LR; pick the LR about one order of magnitude below where the loss starts diverging (the steepest-descent region).

```python
def lr_finder(model, loader, loss_fn, lo=1e-6, hi=1.0, n=200):
    model.train()
    mult = (hi / lo) ** (1 / n)
    opt = torch.optim.AdamW(model.parameters(), lr=lo)
    lr, best, lrs, losses = lo, float("inf"), [], []
    it = iter(loader)
    for _ in range(n):
        try: xb, yb = next(it)
        except StopIteration:
            it = iter(loader); xb, yb = next(it)
        xb, yb = xb.to(device), yb.to(device)
        for g in opt.param_groups: g["lr"] = lr
        opt.zero_grad(set_to_none=True)
        loss = loss_fn(model(xb), yb)
        loss.backward(); opt.step()
        lrs.append(lr); losses.append(loss.item())
        best = min(best, loss.item())
        if loss.item() > 4 * best:                  # diverged — stop early
            break
        lr *= mult
    # Choose lr at the point of steepest downward slope, ~10x below the min.
    return lrs, losses
```

> **Optimization note:** three cheap, high-impact speedups. (1) `model = torch.compile(model)` in PyTorch 2.x fuses kernels for a 1.3–2× step-time win. (2) Prefer **bf16** over fp16 on Ampere/Hopper — same speed, wider dynamic range, and no `GradScaler` needed, so you drop a whole class of overflow bugs. (3) Use `set_to_none=True` in `zero_grad` and `channels_last` memory format for CNNs. Together these routinely cut wall-clock training time 30–50% with zero accuracy cost.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **SGD + momentum** | Best final generalization on vision; cheap memory (1 state tensor) | Needs careful LR tuning + schedule; slow early convergence |
| **Adam / AdamW** | Fast, robust to LR choice, near-default for transformers | 2× optimizer state (m, v) → more memory; can generalize slightly worse than SGD on CNNs |
| **BatchNorm** | Huge speedup + regularization for CNNs; enables very deep nets | Breaks at batch size 1, unstable for sequences/RNNs, train/eval mismatch |
| **LayerNorm** | Batch-independent, stable for transformers & variable-length seqs | Slightly less regularizing; no free "batch noise" bonus |
| **Dropout** | Cheap, strong regularizer against co-adaptation | Slows convergence; wrong rate hurts; redundant with heavy augmentation/BN |
| **Weight decay (AdamW)** | Reliable generalization gain, decoupled and clean | One more hyperparameter; must exclude norms/biases |
| **Cosine + warmup** | Smooth, high final accuracy, hard to misconfigure | Needs known total step count; less flexible than plateau-based |
| **Mixed precision** | ~2× throughput, ~40% less memory | fp16 needs a loss scaler; rare op-level precision bugs |
| **Gradient accumulation** | Large effective batch on small GPUs | Linearly slower per optimizer step; BN stats still use the micro-batch |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Learning rate too high** → loss goes NaN on the first steps. ✅ Run an LR finder; start ~3e-4 for AdamW transformers, add warmup, clip grads at 1.0.
2. ⚠️ **No warmup on a big model / big batch** → early divergence or a permanent bad basin. ✅ Warm up over 1–10% of total steps (hundreds to thousands).
3. ⚠️ **Applying weight decay to biases and LayerNorm/BatchNorm params** → hurts, sometimes badly. ✅ Split param groups; decay only 2D weight matrices.
4. ⚠️ **Using classic Adam L2 instead of AdamW** → decay interacts with the adaptive denominator. ✅ Use `torch.optim.AdamW`.
5. ⚠️ **Forgetting `model.eval()` at validation** → dropout stays on and BatchNorm uses batch stats → noisy, pessimistic metrics. ✅ Toggle `eval()`/`train()` and wrap eval in `torch.no_grad()`.
6. ⚠️ **BatchNorm with tiny or size-1 batches** → garbage running stats. ✅ Use GroupNorm/LayerNorm, or sync-BN across GPUs, when batches are small.
7. ⚠️ **Clipping the scaled gradients under fp16 AMP** → clips the wrong magnitude. ✅ `scaler.unscale_(opt)` *before* `clip_grad_norm_`.
8. ⚠️ **Not zeroing gradients** (or zeroing after the step) → gradients accumulate across batches unintentionally. ✅ `opt.zero_grad(set_to_none=True)` each optimizer step.
9. ⚠️ **Dropout + BatchNorm stacked carelessly** → variance shift between train and eval. ✅ Prefer one primary regularizer per block; put dropout after activation, not between conv and BN.
10. ⚠️ **Judging the LR from train loss alone** → you tune to overfit. ✅ Watch validation loss and the gap; regularize when the gap widens.
11. ⚠️ **fp16 without a `GradScaler`** → small gradients underflow to zero, model silently stops learning. ✅ Use the scaler, or just switch to bf16.
12. ⚠️ **Comparing runs with different effective batch sizes but the same LR** → apples to oranges. ✅ Scale LR ~linearly with batch (the linear-scaling rule) when you change accumulation/GPUs.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The three canonical failures each have a signature. *NaN loss* → lower LR, add warmup, check for fp16 overflow (`torch.isnan` on grads), verify no division by zero in a custom layer. *Flat loss* → LR too low, dead ReLUs (check activation stats), a data-loading bug (labels shuffled independently of inputs), or a detached graph. *Train↓ but val↑* → overfitting: add dropout/weight decay/augmentation or reduce capacity. Turn on `torch.autograd.set_detect_anomaly(True)` to localize the op that first produces NaN, but only while debugging — it is slow.

**Monitoring.** Log at every step: **loss**, **learning rate**, and **global grad-norm** (a spiking grad-norm predicts an imminent NaN and validates your clip threshold). Per epoch: train/val loss and the **generalization gap**, plus per-layer weight and gradient histograms (a layer whose gradients vanish to ~0 is dead; one that explodes is unclipped). Track **throughput** (samples/s, tokens/s) and **GPU memory** to catch regressions. Weights & Biases or TensorBoard scalars are the standard.

**Security & robustness.** Training data is an attack surface: **data poisoning** can implant backdoors, so validate provenance and checksums of datasets and pretrained weights (a malicious `.pt` file executes arbitrary code on `torch.load` — use `weights_only=True`). Pin dependency versions, and treat downloaded checkpoints like untrusted code. Set deterministic seeds and log them for reproducibility and auditing.

**Performance & scaling.** For a single GPU: mixed precision + `torch.compile` + `channels_last`. For multiple GPUs: **DistributedDataParallel** (DDP) — one process per GPU, gradients all-reduced each step; it scales near-linearly and beats the old DataParallel. When the model itself doesn't fit, use **FSDP** or DeepSpeed ZeRO to shard optimizer states, gradients, and parameters across GPUs — this is how billion-parameter models train. Use **gradient accumulation** to hit the target effective batch, and **gradient checkpointing** to trade ~30% compute for a large activation-memory saving when depth is the constraint. Remember the **linear LR scaling rule**: multiply the base LR by the effective-batch multiplier (with warmup) when you add workers.

## 9. Interview Questions

**Q: Why does Adam usually converge faster than plain SGD, and when might SGD still win?**
A: Adam gives each parameter an adaptive step from the running second moment, so sparse or poorly-scaled features still move, and momentum accelerates consistent directions — that makes it fast and robust to LR choice. SGD with momentum often reaches *better* final generalization on vision tasks because its noisier, less adaptive updates find flatter minima. Many CV papers therefore train with SGD; most transformer work uses AdamW.

**Q: What exactly does AdamW change relative to Adam, and why does it matter?**
A: AdamW **decouples weight decay** from the gradient: instead of adding L2 to the loss (which routes decay through the adaptive `√v` denominator, decaying frequently-updated weights less), it subtracts `η·λ·θ` directly from the weights. This makes decay behave as intended and consistently improves generalization, which is why AdamW is the default for training modern models.

**Q: Why do transformers use LayerNorm instead of BatchNorm?**
A: BatchNorm normalizes across the batch dimension, so its statistics depend on batch size and composition — unstable for variable-length sequences, small batches, and autoregressive inference where you process one token at a time. LayerNorm normalizes across the feature dimension per token, independent of the batch, giving stable behavior in training and inference. That batch-independence is the deciding factor.

**Q: What is learning-rate warmup and why is it needed?**
A: Warmup ramps the LR from ~0 up to its target over the first few hundred/thousand steps. Early in training the model is random and gradient estimates (especially Adam's second moment) are high-variance, so a full-size step can push weights into a bad region or diverge. A gentle start lets the moment estimates stabilize; it's essential for large batches and large models.

**Q: You see loss go to NaN after a few steps. Walk through your debugging.**
A: First lower the learning rate and add/lengthen warmup — the most common cause. Check for fp16 overflow (switch to bf16 or verify the GradScaler is active). Add gradient clipping at norm 1.0 and inspect grad-norm — a spike right before the NaN confirms an exploding gradient. If it persists, enable anomaly detection to find the first NaN-producing op, and check custom layers for `log(0)`, division by zero, or `sqrt` of a negative.

**Q: How does dropout regularize, and how does inference differ from training?**
A: At train time dropout zeros each activation with probability `p`, preventing neurons from co-adapting and effectively training an ensemble of subnetworks. At inference dropout is off and activations are scaled (or, with inverted dropout, scaled by `1/(1−p)` during training) so expected magnitudes match. Forgetting `model.eval()` leaves dropout on and corrupts validation metrics.

**Q: Why exclude biases and normalization parameters from weight decay?**
A: Weight decay shrinks parameters toward zero to limit capacity, which is sensible for weight *matrices*. Biases and the γ/β of LayerNorm/BatchNorm are low-dimensional and control shift/scale, not capacity; decaying them just biases activations off their learned operating point and empirically hurts. Best practice is two param groups — decay only tensors with `ndim ≥ 2`.

**Q: (Senior) Derive why He initialization uses variance 2/fan_in for ReLU while Xavier uses 2/(fan_in+fan_out).**
A: To keep activation variance stable through depth you want each layer to preserve variance: for a linear layer `y = Wx`, `Var(y) = fan_in · Var(W) · Var(x)`, so `Var(W)=1/fan_in` preserves the forward signal and `1/fan_out` preserves the backward gradient — Xavier averages them as `2/(fan_in+fan_out)` for symmetric activations like tanh. ReLU zeros half the inputs, halving the variance, so you compensate with an extra factor of 2, giving He's `2/fan_in`. Using Xavier init with ReLU makes signals decay through depth and slows early training.

**Q: (Senior) Explain the interaction between gradient accumulation, batch normalization, and the effective batch size.**
A: Gradient accumulation sums gradients over `N` micro-batches before stepping, so the *optimizer* sees an effective batch of `N × micro_batch` — you should divide the loss by `N` and scale the LR accordingly. But BatchNorm computes its statistics per forward pass on the *micro-batch*, so accumulation does **not** enlarge BN's effective batch; with small micro-batches BN stats stay noisy. That's a reason to prefer LayerNorm/GroupNorm, or SyncBN across GPUs, when you rely on accumulation for large effective batches.

**Q: (Senior) How would you set up learning-rate scaling when moving a run from 8 to 64 GPUs?**
A: The effective batch grows 8×, so by the linear-scaling rule multiply the base LR by ~8 and lengthen warmup proportionally to avoid early divergence at the larger step size. Verify with a short LR-finder or a few hundred steps that grad-norm stays bounded. At extreme batch sizes linear scaling breaks down (diminishing returns, instability), so consider LARS/LAMB layer-wise adaptive optimizers, and always confirm validation curves match the small-scale baseline rather than trusting the rule blindly.

**Q: When should you clip gradients, and by value or by norm?**
A: Clip when gradients occasionally spike — common in RNNs, transformers, and RL — to stop a single bad batch from destroying the weights. **Norm clipping** (rescale the whole gradient so its global L2 norm ≤ threshold, e.g. 1.0) preserves direction and is the standard for deep nets; **value clipping** caps each element independently and distorts direction, so it's rarer. Under fp16 AMP, always unscale before clipping.

**Q: Cosine schedule vs step decay vs reduce-on-plateau — how do you choose?**
A: **Cosine (with warmup)** is the modern default: smooth, one decay curve to near-zero, high final accuracy, and it needs only the total step count. **Step decay** (drop LR ×0.1 at fixed epochs) is simple and classic for CV but bumpy. **Reduce-on-plateau** adapts to the validation curve without knowing total length — useful when you can't predict training duration or for fine-tuning. For fixed-budget large-model training, cosine-with-warmup is almost always the pick.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The optimizer sets step direction and size: **SGD+momentum** (best CV generalization, cheap), **AdamW** (default for transformers — momentum + per-parameter scaling + *decoupled* weight decay). Wrap the LR in a **schedule**: linear **warmup** then **cosine** to ~0. Keep activations sane with **normalization** — **BatchNorm** for CNNs (batch axis), **LayerNorm** for transformers (feature axis, batch-independent). Regularize with **dropout** and **weight decay** (exclude biases/norms). Guard against blowups with **gradient clipping** at norm 1.0. Go faster with **bf16 mixed precision**, **gradient accumulation** for large effective batches, and **He/Xavier init** so signals don't vanish. Debug by the signature: NaN→LR/warmup/overflow, flat→LR/dead-ReLU/data-bug, val-gap→regularize.

| Knob | Default that usually works | Watch out for |
|---|---|---|
| Optimizer | AdamW, betas (0.9, 0.95), eps 1e-8 | decay only on 2D weights |
| LR | 3e-4 (transformer), find with LR-finder | too high → NaN |
| Schedule | warmup 1–5% then cosine → 0 | needs total step count |
| Norm | LayerNorm (transformer) / BatchNorm (CNN) | BN breaks at batch 1 |
| Regularize | dropout 0.1, weight decay 0.1 | overfit = widen gap |
| Clip | grad-norm 1.0 | unscale before clip (fp16) |
| Precision | bf16 (no scaler) | fp16 needs GradScaler |

- **What does momentum do?** → Averages past gradients to accelerate consistent directions and damp oscillation.
- **BatchNorm vs LayerNorm axis?** → BN normalizes over the batch (per feature); LN over the features (per sample).
- **AdamW vs Adam?** → Decoupled weight decay applied to weights, not through the adaptive denominator.
- **Why warmup?** → Early gradient/moment estimates are noisy; a small starting LR prevents divergence.
- **Order before optimizer.step under fp16?** → backward → unscale_ → clip_grad_norm_ → step → update → scheduler → zero_grad.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement AdamW's update from scratch in ~15 lines of numpy (including bias correction) and match PyTorch's `AdamW` on a 2-layer net to 1e-5.
- [ ] Write an LR finder, plot loss vs LR on a real dataset, and justify your chosen LR from the curve's steepest-descent region.
- [ ] Train the same CNN three ways — no norm, BatchNorm, LayerNorm — and plot the convergence curves; explain the differences.
- [ ] Reproduce a NaN by cranking the LR 100×, then fix it with warmup + clipping and confirm grad-norm stays bounded.
- [ ] Ablate dropout ∈ {0, 0.1, 0.3, 0.5} and weight decay ∈ {0, 0.01, 0.1}; report the train/val gap for each.

**Mini Project — A configurable training harness.**
*Goal:* build a single `train(cfg)` function that trains an MLP or small CNN on CIFAR-10 (or Fashion-MNIST) and exposes every knob in this chapter as a config field.
*Requirements:* support optimizer ∈ {SGD+momentum, AdamW}; schedule ∈ {step, cosine+warmup, plateau}; norm ∈ {none, batch, layer, group}; toggles for dropout, weight-decay grouping, gradient clipping, AMP (bf16/fp16), and gradient accumulation. Log loss/LR/grad-norm per step and train/val/gap per epoch to TensorBoard. Save the best checkpoint by validation accuracy.
*Extensions:* add `torch.compile` and measure the speedup; add an LR-finder mode that auto-selects the LR before training; wrap the model in DDP and reproduce the linear-scaling rule across 2 GPUs; implement gradient checkpointing and measure the memory/compute trade-off.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Backpropagation & Autograd* (where the gradients come from), *CNNs & Computer Vision* (chapter 18 — normalization and augmentation in practice), *Transformers & Attention* (why AdamW + warmup + LayerNorm is the standard recipe), *Regularization & Generalization*, and *Distributed Training & Scaling*.

**Free Learning Resources**
- **Deep Learning Book, Ch. 8 "Optimization for Training Deep Models"** — Goodfellow, Bengio, Courville · *Intermediate* · the rigorous reference on SGD, momentum, adaptive methods, and init. <https://www.deeplearningbook.org/contents/optimization.html>
- **CS231n: Neural Networks III (optimization & training)** — Stanford / Andrej Karpathy et al. · *Intermediate* · the clearest lecture notes on update rules, LR schedules, and babysitting training. <https://cs231n.github.io/neural-networks-3/>
- **Adam: A Method for Stochastic Optimization** — Kingma & Ba, arXiv 1412.6980 · *Advanced* · the original Adam paper with the update equations and bias correction. <https://arxiv.org/abs/1412.6980>
- **Decoupled Weight Decay Regularization (AdamW)** — Loshchilov & Hutter, arXiv 1711.05101 · *Advanced* · why decoupled decay beats L2-in-Adam. <https://arxiv.org/abs/1711.05101>
- **Batch Normalization** — Ioffe & Szegedy, arXiv 1502.03167 · *Advanced* · the paper that made very deep nets trainable. <https://arxiv.org/abs/1502.03167>
- **The 1cycle policy / super-convergence** — Leslie Smith, arXiv 1708.07120 · *Advanced* · LR range test and one-cycle scheduling. <https://arxiv.org/abs/1708.07120>
- **PyTorch: Automatic Mixed Precision recipe** — PyTorch docs · *Beginner* · the canonical `autocast` + `GradScaler` reference. <https://pytorch.org/docs/stable/notes/amp_examples.html>
- **A Recipe for Training Neural Networks** — Andrej Karpathy · *Intermediate* · a battle-tested checklist for making training actually work. <https://karpathy.github.io/2019/04/25/recipe/>

---

*AI Engineering Handbook — chapter 17.*
