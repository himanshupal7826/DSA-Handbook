# 22 · PyTorch in Practice

> **In one line:** PyTorch gives you NumPy-like tensors that run on GPUs, automatic differentiation that records your forward pass and hands back gradients, and `nn.Module` + `DataLoader` to assemble the canonical five-line training loop.

---

## 1. Overview

Deep learning is, mechanically, three things: represent data as multidimensional arrays, push them through a chain of differentiable operations, and adjust parameters by following gradients. **PyTorch** provides exactly these primitives with an ergonomics that made it the default framework for research and, increasingly, production. Its core promise is *define-by-run*: you write ordinary Python, and PyTorch records each operation on a tape (the autograd graph) as it executes, so `loss.backward()` can replay it in reverse to compute every gradient. There is no separate compile step to fight — your model *is* the code.

The problem PyTorch solves is the tedious, error-prone plumbing between an idea and a trained model. Before it, you either hand-derived gradients (impossible for deep nets) or used static-graph frameworks (TensorFlow 1.x) where debugging meant reasoning about a graph you couldn't step through. PyTorch's dynamic graph means you can drop a `print` or a debugger anywhere, use Python control flow (loops, conditionals) inside the model, and get gradients for free.

Historically, PyTorch grew out of Torch and was released by Meta AI in 2016; by 2019 it dominated research papers, and PyTorch 2.0 (2023) added `torch.compile` for graph-level speedups without giving up the eager experience. Today it powers Hugging Face Transformers, most published models, and large-scale training runs at frontier labs.

A concrete real-world example: training an image classifier. You wrap your dataset in a `Dataset`, batch it with a `DataLoader`, define a CNN as an `nn.Module`, move it to `cuda`, and run the loop — forward pass, compute loss, `zero_grad`, `backward`, `optimizer.step`. Those five lines are the same whether you're training a 10k-parameter toy or a billion-parameter transformer; only the module and scale change.

Fluency in PyTorch is the practical skill that turns understanding of RNNs, Transformers, and embeddings (Chapters 19–21) into working, GPU-accelerated systems. This chapter is the hands-on backbone of the handbook.

## 2. Core Concepts

- **Tensor** — an n-dimensional array (like `np.ndarray`) with a `dtype`, `shape`, and `device`, supporting GPU compute and autograd.
- **Autograd** — PyTorch's reverse-mode automatic differentiation; it records operations on tensors with `requires_grad=True` and computes gradients via `.backward()`.
- **Computational graph** — the dynamic DAG of operations built during the forward pass, traversed in reverse to accumulate gradients.
- **`nn.Module`** — the base class for models/layers; holds parameters, defines `forward()`, and composes into larger modules.
- **Parameter** — a tensor registered on a module that the optimizer updates (`requires_grad=True` by default).
- **Optimizer** — an algorithm (SGD, Adam, AdamW) that updates parameters from their `.grad` fields.
- **Loss function** — a differentiable objective (`CrossEntropyLoss`, `MSELoss`) whose gradient drives learning.
- **`Dataset` / `DataLoader`** — abstractions for indexing samples and batching/shuffling/parallel-loading them.
- **Device** — where a tensor lives (`cpu`, `cuda`, `mps`); compute happens where the tensors are, and all operands must share a device.
- **`train()` / `eval()` mode** — toggles behavior of dropout and batchnorm; wrap inference in `torch.no_grad()` to skip graph building.

## 3. Theory & Mathematical Intuition

Autograd implements **reverse-mode automatic differentiation** (backpropagation). Think of your model as a composition of functions `L = f_n(...f_2(f_1(x, θ)))`. The chain rule says the gradient of the scalar loss `L` with respect to any intermediate value is the product of local Jacobians along the path back to that value. Reverse mode computes this efficiently by starting from `∂L/∂L = 1` and propagating backward, so all parameter gradients come from a *single* backward pass regardless of how many parameters exist — this is why it scales to billions of parameters.

Concretely, every operation stores a `grad_fn` — the recipe to compute its input gradients from its output gradient. When you call `loss.backward()`, PyTorch walks this graph in reverse topological order, and each node applies its local vector-Jacobian product:

```
grad_input = grad_output @ J_local      # vector-Jacobian product (VJP)
```

Gradients **accumulate** into `.grad` (they add, not overwrite) — which is why you must call `optimizer.zero_grad()` each step, and also what enables gradient accumulation across micro-batches.

A gradient-descent step is simply:

```
θ ← θ − η · ∂L/∂θ        # η = learning rate
```

Adam/AdamW refine this with per-parameter adaptive step sizes using running estimates of the gradient's first moment (mean `m`) and second moment (variance `v`):

```
m_t = β1·m_{t-1} + (1-β1)·g
v_t = β2·v_{t-1} + (1-β2)·g²
θ  ← θ − η · m̂_t / (√v̂_t + ε)
```

Broadcasting lets tensors of compatible shapes combine without explicit loops (a `(B, 1)` bias adds to a `(B, D)` activation), and this is where most beginner bugs live — a silent broadcast can produce a wrong-but-runnable result.

The diagram shows a tiny forward graph and the reverse gradient flow autograd traverses.

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="250" fill="#eef2ff"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">Autograd: forward build, backward flow</text>
  <g font-size="11" fill="#1e293b">
    <rect x="30" y="90" width="70" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="55" y="115">x</text>
    <rect x="30" y="150" width="70" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/><text x="52" y="175">W</text>
    <rect x="160" y="120" width="90" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="180" y="145">z = Wx</text>
    <rect x="310" y="120" width="100" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="325" y="145">a = relu(z)</text>
    <rect x="470" y="120" width="120" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="485" y="145">L = loss(a,y)</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" fill="none">
    <line x1="100" y1="110" x2="160" y2="135" marker-end="url(#a22)"/>
    <line x1="100" y1="170" x2="160" y2="145" marker-end="url(#a22)"/>
    <line x1="250" y1="140" x2="310" y2="140" marker-end="url(#a22)"/>
    <line x1="410" y1="140" x2="470" y2="140" marker-end="url(#a22)"/>
  </g>
  <g stroke="#d97706" stroke-width="1.8" fill="none" stroke-dasharray="5 4">
    <line x1="470" y1="175" x2="410" y2="175" marker-end="url(#b22)"/>
    <line x1="310" y1="180" x2="250" y2="180" marker-end="url(#b22)"/>
    <line x1="160" y1="185" x2="100" y2="185" marker-end="url(#b22)"/>
  </g>
  <text x="200" y="210" font-size="11" fill="#d97706">backward(): grads flow right to left, accumulating into .grad</text>
  <defs>
    <marker id="a22" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
    <marker id="b22" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 4. Architecture & Workflow

The canonical PyTorch training workflow, step by step:

1. **Data** — implement a `Dataset` (`__len__`, `__getitem__` returning `(x, y)` tensors) and wrap it in a `DataLoader` for batching, shuffling, and multi-worker loading.
2. **Model** — subclass `nn.Module`, define layers in `__init__`, and the computation in `forward`.
3. **Device** — pick `cuda`/`mps`/`cpu` and `.to(device)` the model; move each batch to the same device.
4. **Loss & optimizer** — instantiate a loss function and an optimizer over `model.parameters()`.
5. **Training loop** — for each epoch, iterate batches: `optimizer.zero_grad()` → forward → `loss` → `loss.backward()` → (clip) → `optimizer.step()`.
6. **Validation** — switch to `model.eval()`, wrap in `torch.no_grad()`, compute metrics without updating weights.
7. **Checkpoint** — save `model.state_dict()` (and optimizer/scheduler state) periodically; keep the best by validation metric.
8. **Deploy** — export via `torch.compile`, TorchScript, or ONNX; load weights and run inference in `eval()` mode.

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="260" fill="#e0f2fe"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">The canonical training loop</text>
  <g font-size="11" fill="#1e293b">
    <rect x="30" y="100" width="90" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/><text x="45" y="126">DataLoader</text>
    <rect x="150" y="100" width="90" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="168" y="126">forward</text>
    <rect x="270" y="100" width="90" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="292" y="126">loss</text>
    <rect x="390" y="100" width="100" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="400" y="126">backward()</text>
    <rect x="520" y="100" width="90" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="530" y="126">opt.step()</text>
  </g>
  <g stroke="#0ea5e9" stroke-width="2" fill="none">
    <line x1="120" y1="122" x2="150" y2="122" marker-end="url(#c22)"/>
    <line x1="240" y1="122" x2="270" y2="122" marker-end="url(#c22)"/>
    <line x1="360" y1="122" x2="390" y2="122" marker-end="url(#c22)"/>
    <line x1="490" y1="122" x2="520" y2="122" marker-end="url(#c22)"/>
  </g>
  <path d="M565 100 C 565 50, 75 50, 75 100" fill="none" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#c22)"/>
  <text x="250" y="45" font-size="11" fill="#4f46e5">next batch (zero_grad first)</text>
  <text x="380" y="175" font-size="11" fill="#1e293b">Validate each epoch: model.eval() + torch.no_grad()</text>
  <defs><marker id="c22" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker></defs>
</svg>
```

## 5. Implementation

Tensors and autograd fundamentals:

```python
import torch

x = torch.tensor([2.0], requires_grad=True)
y = x ** 3 + 2 * x                 # y = x^3 + 2x
y.backward()                       # dy/dx = 3x^2 + 2
print(x.grad)                      # tensor([14.])  (3*4 + 2)

a = torch.randn(2, 3, device="cuda" if torch.cuda.is_available() else "cpu")
b = torch.ones(3)                  # broadcasts over rows
print((a + b).shape)               # torch.Size([2, 3])
```

A model as an `nn.Module` and the full training loop:

```python
import torch, torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

class MLP(nn.Module):
    def __init__(self, in_dim=20, hidden=64, classes=3):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden), nn.ReLU(), nn.Dropout(0.2),
            nn.Linear(hidden, classes))
    def forward(self, x):
        return self.net(x)                       # logits (B, classes)

device = "cuda" if torch.cuda.is_available() else "cpu"
X = torch.randn(1000, 20); y = torch.randint(0, 3, (1000,))
loader = DataLoader(TensorDataset(X, y), batch_size=32, shuffle=True)

model = MLP().to(device)
opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
loss_fn = nn.CrossEntropyLoss()

model.train()
for epoch in range(5):
    total = 0.0
    for xb, yb in loader:
        xb, yb = xb.to(device), yb.to(device)
        opt.zero_grad()                          # clear old grads
        loss = loss_fn(model(xb), yb)            # forward + loss
        loss.backward()                          # autograd
        opt.step()                               # update params
        total += loss.item() * xb.size(0)
    print(f"epoch {epoch}: loss {total/len(X):.4f}")
# epoch 0: loss 1.09 ... epoch 4: loss 0.71
```

Evaluation and checkpointing:

```python
@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    correct = total = 0
    for xb, yb in loader:
        preds = model(xb.to(device)).argmax(1).cpu()
        correct += (preds == yb).sum().item(); total += yb.size(0)
    return correct / total

torch.save({"model": model.state_dict(), "opt": opt.state_dict()}, "ckpt.pt")
state = torch.load("ckpt.pt", map_location=device)
model.load_state_dict(state["model"])
print("accuracy:", evaluate(model, loader, device))
```

> **Optimization:** Wrap the model in `model = torch.compile(model)` (PyTorch 2.x) for graph-level fusion — often 1.3–2× faster with no code change. Use mixed precision with `torch.autocast` + `GradScaler` to roughly halve memory and speed up on modern GPUs. Set `DataLoader(num_workers>0, pin_memory=True)` and use `.to(device, non_blocking=True)` so data loading overlaps compute. For big models, use gradient accumulation to simulate large batches within limited VRAM.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Dynamic graph | Pythonic, debuggable, control flow works | Slightly slower than static unless `torch.compile`d |
| Autograd | Free gradients for any differentiable code | Graph memory grows with sequence/depth |
| Ecosystem | Huge (HF, Lightning, torchvision) | Fast-moving APIs; version churn |
| GPU support | First-class CUDA/MPS, mixed precision | Device mismatch bugs; VRAM limits |
| Flexibility | Custom layers/losses trivially | Easy to write inefficient eager code |
| Deployment | TorchScript/ONNX/compile paths | Export can be finicky for dynamic models |
| Eager execution | Immediate results, easy prototyping | Per-op Python overhead without fusion |

## 7. Common Mistakes & Best Practices

1. ⚠️ Forgetting `optimizer.zero_grad()` → gradients accumulate across steps and training diverges. ✅ Zero grads every step.
2. ⚠️ Leaving the model in `train()` during inference → dropout/batchnorm corrupt predictions. ✅ Call `model.eval()` and `torch.no_grad()`.
3. ⚠️ Mixing devices (`cpu` tensor + `cuda` tensor) → runtime error or silent slowdown. ✅ Keep model and batch on the same device.
4. ⚠️ Using `loss` (a graph tensor) to accumulate metrics → memory leak. ✅ Use `loss.item()` / `.detach()`.
5. ⚠️ Calling `.backward()` twice on the same graph → error (graph freed). ✅ `retain_graph=True` only if truly needed; usually restructure.
6. ⚠️ Silent broadcasting producing wrong shapes. ✅ Assert shapes; prefer explicit `unsqueeze`/`view`.
7. ⚠️ Not clipping gradients on RNNs/transformers → NaNs. ✅ `clip_grad_norm_` before `step()`.
8. ⚠️ `num_workers=0` bottlenecking the GPU on data loading. ✅ Increase workers, `pin_memory=True`, prefetch.
9. ⚠️ Saving the whole model object instead of `state_dict`. ✅ Save/load `state_dict` for portability.
10. ⚠️ Learning rate untuned or no scheduler. ✅ Use AdamW with warmup + cosine/step schedule; sweep LR.
11. ⚠️ Comparing loss magnitudes across different reductions. ✅ Fix `reduction='mean'` and be consistent.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first test is to overfit a single batch to near-zero loss — if you can't, there's a wiring bug (wrong shapes, detached graph, label mismatch). Use `torch.autograd.set_detect_anomaly(True)` to locate the op that produces NaN. Print tensor `shape`, `dtype`, and `device` liberally; most bugs are shape/device mismatches. Check that `requires_grad` and `.grad` are populated where expected.

**Monitoring.** Log training/validation loss, learning rate, gradient norm, and throughput (samples/sec) to TensorBoard or Weights & Biases. Watch for exploding/vanishing gradient norms and loss plateaus. Track GPU utilization and memory; low utilization usually means a data-loading bottleneck.

**Security.** `torch.load` can execute arbitrary code when unpickling untrusted checkpoints — load only trusted files or use `weights_only=True`. Validate and sanitize model inputs at serving time. Pin dependency versions to avoid supply-chain surprises. Be mindful that models can memorize and leak training data.

**Performance & Scaling.** Use `torch.compile` and mixed precision. Scale across GPUs with `DistributedDataParallel` (one process per GPU, gradient all-reduce), and for models too big for one GPU use FSDP or DeepSpeed ZeRO to shard parameters/optimizer state. Increase effective batch size with gradient accumulation. For serving, export to TorchScript/ONNX or use TorchServe/Triton, and quantize (int8) for CPU/edge deployment.

## 9. Interview Questions

**Q: What does `requires_grad=True` do?**
A: It tells autograd to track operations on that tensor so gradients can be computed with respect to it during `.backward()`. Parameters in `nn.Module`s have it by default; inputs usually don't. Only tensors in the graph with `requires_grad=True` get populated `.grad` fields.

**Q: Why must you call `optimizer.zero_grad()` each step?**
A: PyTorch *accumulates* gradients into `.grad` rather than overwriting them, so without zeroing, each step's gradient adds to the previous one and updates become wrong. This same accumulation behavior is what lets you deliberately do gradient accumulation across micro-batches.

**Q: What's the difference between `model.train()` and `model.eval()`?**
A: They toggle layers that behave differently between training and inference — dropout is active in `train()` and disabled in `eval()`, and batchnorm uses batch statistics in `train()` but running statistics in `eval()`. They do not disable gradients; use `torch.no_grad()` for that.

**Q: What does `torch.no_grad()` do and when do you use it?**
A: It disables autograd graph construction within its scope, saving memory and time. Use it for inference/validation where you don't need gradients. It's orthogonal to `eval()` — you typically use both together at inference.

**Q: How does autograd compute gradients?**
A: It uses reverse-mode automatic differentiation. During the forward pass each op records a `grad_fn`; calling `.backward()` traverses this graph in reverse topological order, applying each op's vector-Jacobian product, so all parameter gradients are obtained in a single backward pass.

**Q: Why detach a tensor or call `.item()` when logging loss?**
A: The loss tensor carries a reference to the whole computational graph. Accumulating it directly keeps every graph alive across iterations, leaking memory. `.item()` extracts a Python float and `.detach()` returns a tensor cut from the graph, both freeing the graph.

**Q: (Senior) Explain the difference between `DataParallel` and `DistributedDataParallel`.**
A: `DataParallel` runs one process with multiple GPUs, replicating the model each step and gathering on a single device — simple but with a GIL/communication bottleneck. `DistributedDataParallel` runs one process per GPU with overlapping gradient all-reduce, scaling far better and being the recommended approach for multi-GPU/multi-node training.

**Q: (Senior) What is mixed-precision training and why does it help?**
A: It runs most ops in bf16/fp16 while keeping a master copy of weights and loss scaling in fp32. This roughly halves memory and leverages tensor-core throughput for large speedups, while `GradScaler` (for fp16) prevents small gradients from underflowing. Accuracy is typically preserved.

**Q: (Senior) How does `torch.compile` speed models up without changing the eager model?**
A: It traces the model into a graph (TorchDynamo), applies backend optimizations like operator fusion and kernel selection (TorchInductor), and falls back to eager for unsupported ops. You keep writing normal PyTorch; the first call compiles and subsequent calls run the optimized graph, often 1.3–2× faster.

**Q: What is broadcasting and where does it bite?**
A: Broadcasting lets tensors of compatible (aligned-from-the-right) shapes combine by virtually expanding size-1 dimensions, avoiding explicit loops. It bites when an unintended broadcast (e.g. `(B,)` vs `(B,1)`) produces a valid but semantically wrong result — a silent bug. Assert shapes to catch it.

**Q: How do you save and restore a model correctly?**
A: Save `model.state_dict()` (and optimizer/scheduler state) rather than the whole object, because pickling the object couples it to your code layout. Restore by constructing the model, then `load_state_dict`. Use `map_location` to move across devices and `weights_only=True` for untrusted files.

**Q: (Senior) Your GPU utilization is low during training — how do you diagnose it?**
A: Low utilization usually means the GPU is starved by data loading or host-device transfer. Increase `DataLoader` `num_workers`, set `pin_memory=True` and `non_blocking=True` transfers, profile with the PyTorch profiler to find CPU/IO bottlenecks, and ensure preprocessing isn't on the critical path. Larger batches or `torch.compile` can also raise utilization.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** PyTorch = GPU tensors + autograd + `nn.Module`. Build a `Dataset`/`DataLoader`, define a model as an `nn.Module`, move both to the device, then loop: `zero_grad → forward → loss → backward → step`. Autograd records the forward pass and computes all gradients in one reverse pass; gradients accumulate, so zero them each step. Use `eval()` + `no_grad()` for inference, save the `state_dict`, and speed things up with `torch.compile`, mixed precision, and multi-worker loading. Scale across GPUs with DDP/FSDP.

| Step | Call |
|---|---|
| Clear grads | `optimizer.zero_grad()` |
| Forward | `out = model(xb)` |
| Loss | `loss = loss_fn(out, yb)` |
| Backward | `loss.backward()` |
| Update | `optimizer.step()` |
| Inference | `model.eval()` + `torch.no_grad()` |
| Save | `torch.save(model.state_dict(), ...)` |

Flash cards:
- **Why zero_grad each step?** → Gradients accumulate into `.grad`; otherwise they add up.
- **What disables dropout/batchnorm training behavior?** → `model.eval()`.
- **What skips graph building at inference?** → `torch.no_grad()`.
- **Free speedup in PyTorch 2.x?** → `torch.compile(model)`.
- **Multi-GPU recommendation?** → DistributedDataParallel (one process per GPU).

## 11. Hands-On Exercises & Mini Project

- [ ] Compute a gradient by hand and verify it with `.backward()` on a small expression.
- [ ] Deliberately omit `zero_grad()` and observe the loss diverge; then fix it.
- [ ] Add `torch.autocast` + `GradScaler` and measure the memory/speed change.
- [ ] Profile a training step with the PyTorch profiler and find the biggest time sink.
- [ ] Save and reload a `state_dict`, confirming identical predictions before and after.

**Mini Project — MNIST from scratch to GPU.**
Goal: train a CNN on MNIST/FashionMNIST end to end with production hygiene.
Requirements: (1) `Dataset`/`DataLoader` with transforms and `num_workers`; (2) a CNN `nn.Module`; (3) full train/val loop with a scheduler and gradient clipping; (4) checkpoint the best model by val accuracy; (5) log loss/accuracy to TensorBoard and report ≥99% test accuracy.
Extensions: add mixed precision and `torch.compile` and benchmark the speedup; convert to `DistributedDataParallel` on two GPUs; export to ONNX and run inference; add early stopping and a confusion-matrix visualization.

## 12. Related Topics & Free Learning Resources

Related chapters: **RNNs, LSTMs & Sequence Models** and **Attention & the Transformer** (models you build in PyTorch), **Embeddings & Representation Learning** (`nn.Embedding` in practice), and **NLP Foundations & Tokenization** (feeding token ids into models).

**Free Learning Resources**
- **PyTorch official tutorials** — PyTorch · *Beginner→Advanced* · the "60-Minute Blitz" and training-loop guides. <https://pytorch.org/tutorials/>
- **Deep Learning with PyTorch: 60 Minute Blitz** — PyTorch · *Beginner* · tensors, autograd, and a first network fast. <https://pytorch.org/tutorials/beginner/deep_learning_60min_blitz.html>
- **Neural Networks: Zero to Hero** — Andrej Karpathy · *Intermediate* · builds autograd (micrograd) and nets from scratch. <https://karpathy.ai/zero-to-hero.html>
- **PyTorch documentation** — PyTorch · *Reference* · authoritative API for tensors, autograd, and `nn`. <https://pytorch.org/docs/stable/index.html>
- **Practical Deep Learning for Coders** — fast.ai · *Beginner→Intermediate* · top-down, project-first course built on PyTorch. <https://course.fast.ai/>
- **torch.compile tutorial** — PyTorch · *Advanced* · how to accelerate models with the 2.x compiler. <https://pytorch.org/tutorials/intermediate/torch_compile_tutorial.html>
- **Dive into Deep Learning (D2L)** — Zhang et al. · *Intermediate* · free interactive textbook with runnable PyTorch. <https://d2l.ai/>

---

*AI Engineering Handbook — chapter 22.*
