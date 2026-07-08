# 40 · GPU Computing & Distributed Training

> **In one line:** GPUs win at deep learning because they do thousands of multiply-adds in parallel — and when one GPU isn't enough, data, tensor, and pipeline parallelism spread a model and its batches across many of them.

---

## 1. Overview

Deep learning is, at its core, a mountain of matrix multiplications. A **GPU** is a chip built to do exactly that: instead of a handful of fast CPU cores optimized for branchy serial code, a GPU packs tens of thousands of simple arithmetic units that all crunch numbers at once. That single architectural bet — throughput over latency, SIMT parallelism over sequential speed — is why an NVIDIA H100 does matrix math roughly `10–50×` faster than a top server CPU, and why the entire modern AI era rides on GPUs.

The problem GPUs solve is that training and running neural networks means multiplying huge matrices millions of times, and those multiplications are **embarrassingly parallel** — every output element is an independent dot product. CPUs, tuned for one thread going fast, waste that opportunity. GPUs schedule thousands of threads over the same instruction stream, hiding memory latency by swapping between warps of threads. The catch is that a GPU's speed is gated by **memory bandwidth** as much as raw FLOPs: feeding those arithmetic units from high-bandwidth memory (HBM) is often the real bottleneck (the "roofline").

But models outgrew single GPUs. GPT-3 has 175B parameters — `~350 GB` in fp16 just for weights, before gradients and optimizer state that triple it. No single GPU holds that. **Distributed training** splits the work: **data parallelism** replicates the model and splits the batch; **tensor parallelism** splits individual layers across GPUs; **pipeline parallelism** splits the layer stack into stages; and **FSDP/ZeRO** shard the optimizer state, gradients, and parameters themselves. Frameworks like PyTorch FSDP, DeepSpeed, and Megatron-LM orchestrate this, with **NCCL** handling the GPU-to-GPU communication.

A concrete example: training a 7B model on 1B tokens on one A100 would take weeks and might not even fit with a reasonable batch size. With 64 A100s using FSDP for sharding plus gradient accumulation, the same run finishes in a day. The engineering is entirely about keeping every GPU fed and minimizing the communication tax between them.

## 2. Core Concepts

- **GPU (SIMT architecture)** — Single Instruction, Multiple Threads: thousands of cores execute the same instruction over many data elements in lockstep warps, ideal for matrix math.
- **CUDA** — NVIDIA's programming model/toolkit for writing GPU kernels; the ecosystem (cuBLAS, cuDNN) most DL frameworks build on.
- **HBM & memory bandwidth** — high-bandwidth GPU memory; feeding compute units from it is often the true bottleneck (memory-bound vs compute-bound, the "roofline").
- **Tensor Cores** — specialized units that do mixed-precision matrix-multiply-accumulate (fp16/bf16/fp8) far faster than general cores.
- **Data parallelism (DP)** — replicate the full model on each GPU, split the batch; average gradients via all-reduce each step.
- **Tensor parallelism (TP)** — split a single layer's weight matrices across GPUs; each computes a shard and they combine via all-reduce/all-gather.
- **Pipeline parallelism (PP)** — assign consecutive layer groups (stages) to different GPUs; micro-batches flow through like an assembly line.
- **FSDP / ZeRO** — shard parameters, gradients, and optimizer state across GPUs so no device holds a full copy; gather just-in-time per layer.
- **NCCL** — NVIDIA's collective communication library implementing all-reduce, all-gather, reduce-scatter over NVLink/InfiniBand.
- **Mixed precision & gradient accumulation** — train in bf16/fp16 with an fp32 master copy; accumulate gradients over micro-batches to simulate a large batch.

## 3. Theory & Mathematical Intuition

**Why GPUs win.** A matrix multiply `C = A·B` where `A` is `m×k` and `B` is `k×n` requires `m·n` independent dot products, each `k` multiply-adds — `2·m·n·k` FLOPs with no data dependencies between outputs. A GPU maps this onto a grid of threads, each computing a tile of `C`, and hides memory latency by oversubscribing threads. Whether you hit peak throughput depends on **arithmetic intensity** = FLOPs / bytes moved. The roofline model says:

```
achievable_FLOPs = min(peak_compute,  arithmetic_intensity · memory_bandwidth)
```

Big dense matmuls (training, prefill) have high intensity and hit compute peak; token-by-token decode has low intensity and is memory-bound — the same reason serving is bandwidth-limited.

**Data parallelism math.** With `N` GPUs each holding the full model and processing a batch shard `B/N`, the local gradients `g_i` are averaged: `g = (1/N)·Σ g_i` via an **all-reduce**. Ring all-reduce moves `~2·(N−1)/N · model_size` bytes — nearly independent of `N`, which is why DP scales well until the network saturates. The compute is trivially parallel; the communication is the tax.

**Memory is the real constraint.** Training memory per parameter (Adam, mixed precision) is roughly: `2 bytes` (bf16 weight) + `2` (bf16 gradient) + `4` (fp32 master) + `8` (Adam m and v) ≈ `16 bytes/param`. A 7B model needs `~112 GB` — more than one 80 GB GPU. **ZeRO/FSDP** shards these across `N` GPUs so each holds `~1/N`, gathering a layer's full parameters only for the moment it computes, then discarding them:

```
mem_per_gpu ≈ (16 · P) / N   +  activations   (ZeRO-3 / FSDP)
```

That `1/N` scaling on state is what makes trillion-parameter training feasible. The trade-off is extra all-gather/reduce-scatter communication per layer.

The diagram compares the three parallelism axes.

```svg
<svg viewBox="0 0 740 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">Three axes of parallelism</text>

  <text x="130" y="52" text-anchor="middle" fill="#1e293b" font-size="12">Data parallel</text>
  <rect x="70" y="62" width="55" height="80" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="97" y="106" text-anchor="middle" fill="#1e293b" font-size="10">full model</text>
  <rect x="140" y="62" width="55" height="80" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="167" y="106" text-anchor="middle" fill="#1e293b" font-size="10">full model</text>
  <text x="130" y="160" text-anchor="middle" fill="#64748b" font-size="10">split batch · all-reduce grads</text>

  <text x="370" y="52" text-anchor="middle" fill="#1e293b" font-size="12">Tensor parallel</text>
  <rect x="300" y="62" width="140" height="80" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-dasharray="4 3"/>
  <rect x="312" y="74" width="55" height="56" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="339" y="106" text-anchor="middle" fill="#1e293b" font-size="10">W left</text>
  <rect x="373" y="74" width="55" height="56" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="400" y="106" text-anchor="middle" fill="#1e293b" font-size="10">W right</text>
  <text x="370" y="160" text-anchor="middle" fill="#64748b" font-size="10">split one layer's matrix</text>

  <text x="610" y="52" text-anchor="middle" fill="#1e293b" font-size="12">Pipeline parallel</text>
  <rect x="545" y="62" width="130" height="80" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-dasharray="4 3"/>
  <rect x="555" y="74" width="52" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="581" y="90" text-anchor="middle" fill="#1e293b" font-size="10">layers 1-8</text>
  <rect x="555" y="106" width="52" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="581" y="122" text-anchor="middle" fill="#1e293b" font-size="10">layers 9-16</text>
  <rect x="614" y="74" width="52" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="640" y="90" text-anchor="middle" fill="#1e293b" font-size="10">GPU A</text>
  <rect x="614" y="106" width="52" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="640" y="122" text-anchor="middle" fill="#1e293b" font-size="10">GPU B</text>
  <text x="610" y="160" text-anchor="middle" fill="#64748b" font-size="10">stages · micro-batches flow</text>

  <rect x="150" y="220" width="440" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="370" y="245" text-anchor="middle" fill="#1e293b" font-size="12">FSDP / ZeRO-3: shard params + grads + optimizer state across all GPUs</text>
  <text x="370" y="268" text-anchor="middle" fill="#64748b" font-size="11">each GPU holds ~1/N; all-gather a layer just-in-time, then free</text>
  <text x="370" y="284" text-anchor="middle" fill="#64748b" font-size="10">combine axes for large models: 3D parallelism (DP × TP × PP)</text>
</svg>
```

## 4. Architecture & Workflow

A distributed training step with FSDP proceeds as follows:

1. **Launch & init.** A launcher (`torchrun`) starts one process per GPU across nodes; each joins a process group over NCCL and learns its `rank` and `world_size`.
2. **Shard the model.** FSDP wraps the model and shards parameters, gradients, and optimizer state so each rank stores only its `1/N` slice.
3. **Load data disjointly.** A `DistributedSampler` gives each rank a non-overlapping batch shard, so together they cover the global batch.
4. **Forward pass.** For each FSDP unit (a layer or block), ranks **all-gather** the full parameters just before computing it, run the layer, then **discard** the non-owned shards to reclaim memory.
5. **Backward pass.** Gradients are computed per layer; a **reduce-scatter** averages and scatters them so each rank ends up with the reduced gradient for only its parameter shard.
6. **Optimizer step.** Each rank updates just its shard using its slice of Adam state — no full-model copy anywhere.
7. **Gradient accumulation.** Repeat forward/backward over several micro-batches before stepping, simulating a large batch without the memory.
8. **Checkpoint.** Periodically gather and save a consolidated (or sharded) checkpoint; on failure, resume from it.

For very large models this composes into **3D parallelism**: TP within a node (fast NVLink), PP across nodes, DP/FSDP on top — mapping each communication pattern to the fastest available link.

The diagram shows one FSDP training iteration's communication pattern.

```svg
<svg viewBox="0 0 740 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="g2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">One FSDP step: gather → compute → reduce-scatter → update</text>

  <rect x="40" y="50" width="150" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="115" y="72" text-anchor="middle" fill="#1e293b" font-size="12">Each rank holds</text>
  <text x="115" y="89" text-anchor="middle" fill="#64748b" font-size="11">1/N of params</text>

  <rect x="240" y="50" width="150" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="315" y="72" text-anchor="middle" fill="#1e293b" font-size="12">All-gather layer</text>
  <text x="315" y="89" text-anchor="middle" fill="#64748b" font-size="11">full params (temp)</text>

  <rect x="440" y="50" width="150" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="515" y="72" text-anchor="middle" fill="#1e293b" font-size="12">Fwd + Bwd</text>
  <text x="515" y="89" text-anchor="middle" fill="#64748b" font-size="11">compute grads</text>

  <rect x="440" y="150" width="150" height="50" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="515" y="172" text-anchor="middle" fill="#1e293b" font-size="12">Reduce-scatter</text>
  <text x="515" y="189" text-anchor="middle" fill="#64748b" font-size="11">avg + shard grads</text>

  <rect x="240" y="150" width="150" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="315" y="172" text-anchor="middle" fill="#1e293b" font-size="12">Optimizer step</text>
  <text x="315" y="189" text-anchor="middle" fill="#64748b" font-size="11">update own shard</text>

  <rect x="40" y="150" width="150" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="115" y="172" text-anchor="middle" fill="#1e293b" font-size="12">Free non-owned</text>
  <text x="115" y="189" text-anchor="middle" fill="#64748b" font-size="11">reclaim memory</text>

  <line x1="190" y1="75" x2="238" y2="75" stroke="#475569" stroke-width="1.5" marker-end="url(#g2)"/>
  <line x1="390" y1="75" x2="438" y2="75" stroke="#475569" stroke-width="1.5" marker-end="url(#g2)"/>
  <line x1="515" y1="100" x2="515" y2="148" stroke="#475569" stroke-width="1.5" marker-end="url(#g2)"/>
  <line x1="440" y1="175" x2="392" y2="175" stroke="#475569" stroke-width="1.5" marker-end="url(#g2)"/>
  <line x1="240" y1="175" x2="192" y2="175" stroke="#475569" stroke-width="1.5" marker-end="url(#g2)"/>
  <line x1="115" y1="150" x2="115" y2="102" stroke="#475569" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#g2)"/>
  <text x="130" y="128" fill="#64748b" font-size="10">next layer</text>
</svg>
```

## 5. Implementation

Confirming GPU compute and mixed precision in PyTorch.

```python
import torch

print(torch.cuda.is_available(), torch.cuda.get_device_name(0))
a = torch.randn(8192, 8192, device="cuda", dtype=torch.bfloat16)
b = torch.randn(8192, 8192, device="cuda", dtype=torch.bfloat16)
torch.cuda.synchronize(); import time; t0 = time.time()
for _ in range(50):
    c = a @ b                       # runs on Tensor Cores in bf16
torch.cuda.synchronize()
flops = 50 * 2 * 8192**3
print(f"{flops / (time.time()-t0) / 1e12:.1f} TFLOP/s")   # e.g. ~250 TFLOP/s on an A100
```

Single-GPU AMP (automatic mixed precision) training loop — the building block.

```python
import torch
from torch.cuda.amp import autocast, GradScaler

model = MyModel().cuda()
opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
scaler = GradScaler()                       # keeps fp16 gradients from underflowing
accum = 4                                   # gradient accumulation micro-batches

for step, (x, y) in enumerate(loader):
    x, y = x.cuda(), y.cuda()
    with autocast(dtype=torch.bfloat16):    # compute in bf16, master weights fp32
        loss = model(x, y) / accum
    scaler.scale(loss).backward()
    if (step + 1) % accum == 0:             # step every `accum` micro-batches
        scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True)
```

Multi-GPU training with FSDP, launched via `torchrun --nproc_per_node=8 train.py`.

```python
import torch, torch.distributed as dist
from torch.distributed.fsdp import FullyShardedDataParallel as FSDP
from torch.distributed.fsdp import ShardingStrategy, MixedPrecision
from torch.utils.data import DataLoader, DistributedSampler

dist.init_process_group("nccl")             # one process per GPU
rank = dist.get_rank(); torch.cuda.set_device(rank)

model = build_model().cuda()
model = FSDP(
    model,
    sharding_strategy=ShardingStrategy.FULL_SHARD,     # ZeRO-3: shard params+grads+optim
    mixed_precision=MixedPrecision(param_dtype=torch.bfloat16,
                                   reduce_dtype=torch.bfloat16),
    device_id=rank,
)
opt = torch.optim.AdamW(model.parameters(), lr=3e-4)

sampler = DistributedSampler(dataset)       # disjoint shard per rank
loader = DataLoader(dataset, batch_size=8, sampler=sampler)
for epoch in range(3):
    sampler.set_epoch(epoch)                # reshuffle deterministically across ranks
    for x, y in loader:
        loss = model(x.cuda(), y.cuda())
        loss.backward()                     # triggers reduce-scatter of grads
        opt.step(); opt.zero_grad(set_to_none=True)
dist.destroy_process_group()
```

**Optimization note:** The three biggest wins are (1) **bf16 mixed precision** to use Tensor Cores and halve memory bandwidth; (2) **activation/gradient checkpointing** to trade recompute for memory so you can fit bigger models/batches; and (3) **gradient accumulation** to reach a large effective batch on limited GPUs. Keep TP inside a node (NVLink) and DP/PP across nodes (slower InfiniBand). Overlap communication with compute (FSDP prefetches the next layer's all-gather during the current compute), and watch that you're compute-bound, not stalled on the network.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **GPU vs CPU** | `10–50×` on dense matmul, Tensor Cores | Poor at branchy/serial code; costly; memory-bound at low intensity |
| **Data parallelism** | Simple, scales throughput near-linearly | Every GPU stores the full model; caps model size |
| **Tensor parallelism** | Fits layers too big for one GPU | Heavy per-layer all-reduce; needs fast NVLink |
| **Pipeline parallelism** | Fits deep models across nodes | Pipeline "bubbles" idle GPUs; needs micro-batching |
| **FSDP / ZeRO-3** | `1/N` memory; trillion-param training | Extra all-gather/reduce-scatter communication each layer |
| **Mixed precision** | `~2×` speed + memory | Numerical care (loss scaling, fp32 master) |
| **Grad checkpointing** | Big memory savings | `~30%` extra compute (recompute forward) |

## 7. Common Mistakes & Best Practices

1. ⚠️ Assuming more GPUs = proportionally faster → ✅ Communication overhead and pipeline bubbles cause sub-linear scaling; measure efficiency, not just GPU count.
2. ⚠️ Reaching for tensor parallelism first → ✅ Try FSDP/ZeRO and gradient checkpointing before TP; TP's per-layer all-reduce is expensive off NVLink.
3. ⚠️ Running TP across nodes over slow interconnect → ✅ Keep TP within a node (NVLink); use PP/DP across nodes where latency is tolerable.
4. ⚠️ Ignoring the memory breakdown → ✅ Remember optimizer state (`8 bytes/param` for Adam) dominates; shard it with ZeRO before blaming activations.
5. ⚠️ Not overlapping communication with compute → ✅ Enable prefetch/backward-prefetch so all-gather hides behind compute; otherwise GPUs stall on the network.
6. ⚠️ Using fp16 without loss scaling → ✅ Use bf16 (wider range, no scaling needed) or fp16 with a `GradScaler`; raw fp16 underflows gradients.
7. ⚠️ Forgetting `sampler.set_epoch()` → ✅ Call it each epoch so shards reshuffle; otherwise every epoch sees the same per-rank data.
8. ⚠️ Small pipeline micro-batch count → ✅ Use many micro-batches to shrink the pipeline bubble; few micro-batches leave stages idle.
9. ⚠️ Checkpointing naively at huge scale → ✅ Use sharded/async checkpointing; a synchronous full-gather checkpoint stalls thousands of GPUs.
10. ⚠️ No failure handling on long runs → ✅ Checkpoint frequently and use elastic/fault-tolerant launch; at 1000-GPU scale, hardware *will* fail mid-run.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** For OOM, print the memory breakdown (`torch.cuda.memory_summary()`); optimizer state or activations are usually the culprit — shard with ZeRO or add gradient checkpointing. For NaN loss, suspect fp16 without scaling or a too-high LR; switch to bf16. For hangs, a NCCL collective is likely mismatched across ranks (different shapes/order) — every rank must call the same collectives in the same order. Use `NCCL_DEBUG=INFO` to trace communication.

**Monitoring.** Track per-GPU utilization and HBM usage, TFLOP/s (are you near roofline?), communication vs compute time ratio, and **scaling efficiency** (throughput with `N` GPUs vs `N×` one GPU). Watch for stragglers — one slow GPU/link stalls every collective. Monitor loss curves and gradient norms for divergence, and interconnect (NVLink/InfiniBand) bandwidth saturation.

**Security.** Multi-tenant GPU clusters need isolation — MIG (Multi-Instance GPU) partitions an H100 into isolated slices; without it, tenants can contend or leak via shared memory. Secure the training data pipeline (it's an injection/poisoning vector) and the checkpoint store (a tampered checkpoint is a supply-chain risk). Restrict cluster access and audit who can launch jobs on expensive hardware.

**Performance & Scaling.** Choose the parallelism to fit the constraint: FSDP for memory, TP for layers too big for one GPU (within a node), PP for very deep models across nodes, DP for throughput. Compose them as 3D parallelism at extreme scale, mapping heavy communication to the fastest links. Push arithmetic intensity up (larger matmuls, fused kernels, bf16) to stay compute-bound. Use elastic training and frequent checkpoints so a node failure costs minutes, not the whole run.

## 9. Interview Questions

**Q: Why are GPUs so much faster than CPUs for deep learning?**
A: Deep learning is dominated by large matrix multiplications where every output is an independent dot product — embarrassingly parallel. GPUs pack tens of thousands of simple cores that execute the same instruction over many data elements (SIMT) and hide memory latency by oversubscribing threads, whereas CPUs optimize a few cores for fast serial execution. Tensor Cores further accelerate mixed-precision matmul, giving GPUs a `10–50×` edge on this workload.

**Q: What is the difference between data, tensor, and pipeline parallelism?**
A: Data parallelism replicates the whole model on each GPU and splits the batch, averaging gradients via all-reduce. Tensor parallelism splits a single layer's weight matrices across GPUs so they cooperatively compute one layer. Pipeline parallelism assigns consecutive layer groups to different GPUs and streams micro-batches through like an assembly line. DP scales throughput; TP and PP let you fit a model too big for one GPU.

**Q: What does FSDP / ZeRO do and why is it needed?**
A: Training memory per parameter (weights + gradients + fp32 master + Adam state) is `~16 bytes`, so large models exceed single-GPU memory. FSDP/ZeRO shards parameters, gradients, and optimizer state across `N` GPUs so each holds `~1/N`, all-gathering a layer's full weights only when computing it, then freeing them. This makes the memory scale down with GPU count, enabling very large models.

**Q: What is mixed-precision training and why use it?**
A: It computes forward/backward in bf16 or fp16 (using fast Tensor Cores and half the memory bandwidth) while keeping an fp32 master copy of weights for stable updates. bf16 has a wide exponent range so it needs no loss scaling; fp16 needs a `GradScaler` to prevent gradient underflow. The result is roughly `2×` speed and memory savings with minimal accuracy impact.

**Q: What is a ring all-reduce and why does data parallelism scale well?**
A: Ring all-reduce averages gradients by passing chunks around a logical ring in reduce-scatter then all-gather phases, moving `~2·(N−1)/N` times the model size in bytes — nearly independent of `N`. Because the communication volume per GPU stays roughly constant as you add GPUs, data-parallel throughput scales close to linearly until the network bandwidth saturates.

**Q: What is arithmetic intensity and why does it matter?**
A: Arithmetic intensity is FLOPs performed per byte moved from memory. The roofline model says achievable performance is `min(peak_compute, intensity × bandwidth)`. High-intensity ops (big dense matmuls in training) hit compute peak; low-intensity ops (token-by-token decode) are memory-bandwidth-bound. It tells you whether to optimize compute or memory movement.

**Q: What is a pipeline bubble and how do you reduce it?**
A: In pipeline parallelism, early and late stages sit idle while the pipeline fills and drains — that idle time is the bubble, wasting GPU cycles. Splitting each batch into many micro-batches keeps more stages busy simultaneously, shrinking the bubble fraction toward zero. Interleaved/1F1B schedules further overlap forward and backward passes to reduce it.

**Q: (Senior) You add GPUs but throughput barely improves. Diagnose.**
A: Scaling is being eaten by communication or imbalance. Check the compute-vs-communication time ratio — if all-reduce/all-gather dominates, you're network-bound (slow interconnect, TP across nodes, or no compute/comm overlap). Look for stragglers (one slow GPU/link stalls every collective), too-small per-GPU batch (low intensity), or pipeline bubbles. Fixes: overlap comm with compute, keep TP on NVLink, raise per-GPU batch, use faster interconnect, and rebalance stages.

**Q: (Senior) A 70B model won't fit for training. Walk through your parallelism plan.**
A: Start with FSDP/ZeRO-3 to shard params, grads, and optimizer state across GPUs, plus bf16 mixed precision and gradient/activation checkpointing to cut memory further. If a single layer still doesn't fit or you want lower per-step latency, add tensor parallelism within a node over NVLink. For very deep models across many nodes, add pipeline parallelism with many micro-batches. Layer data parallelism on top for throughput — 3D parallelism — mapping heavy communication to the fastest links.

**Q: (Senior) How do you make a 1000-GPU run survive hardware failures?**
A: Assume failure is routine at that scale. Checkpoint frequently with sharded, asynchronous writes so saving doesn't stall the cluster, and store to durable shared storage. Use an elastic/fault-tolerant launcher (e.g. torchrun with elastic, or a scheduler that reschedules) that can restart failed ranks and resume from the latest checkpoint. Monitor for stragglers and dead links, and design the run so a node loss costs minutes of recompute, not the whole job.

**Q: When is memory-bound vs compute-bound, and how does it change optimization?**
A: Training's large dense matmuls and prefill are compute-bound (high arithmetic intensity), so you optimize FLOPs — Tensor Cores, fused kernels, bf16. Autoregressive decode is memory-bound (matrix-vector, low intensity), so you optimize bytes moved — quantization, batching to amortize weight reads, KV-cache efficiency. Profiling arithmetic intensity tells you which lever pays off.

**Q: What is CUDA and where does it sit in the stack?**
A: CUDA is NVIDIA's parallel-computing platform and programming model for writing GPU kernels, plus libraries like cuBLAS (matrix ops) and cuDNN (DL primitives) and the NCCL collective library. Frameworks like PyTorch and TensorFlow call these under the hood, so most engineers use CUDA indirectly. It's the reason NVIDIA GPUs dominate DL — the mature software ecosystem, not just the silicon.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** GPUs beat CPUs at deep learning because matmuls are embarrassingly parallel and GPUs run thousands of threads in lockstep, accelerated by Tensor Cores; performance is capped by the roofline of compute vs memory bandwidth. Training memory is `~16 bytes/param` (weights + grads + fp32 master + Adam), so big models exceed one GPU. Data parallelism splits the batch (all-reduce grads); tensor parallelism splits a layer (needs NVLink); pipeline parallelism splits the layer stack (needs micro-batches to avoid bubbles); FSDP/ZeRO shards all state for `1/N` memory. Use bf16 mixed precision, gradient checkpointing, and accumulation. Overlap communication with compute, keep TP within a node, and checkpoint often for fault tolerance.

| Method | Splits | Scales | Watch out |
|---|---|---|---|
| Data parallel | batch | throughput | full model per GPU |
| Tensor parallel | one layer | model size | all-reduce, need NVLink |
| Pipeline parallel | layer stack | depth | bubbles |
| FSDP / ZeRO-3 | all state | memory (1/N) | extra comm/layer |
| Mixed precision | precision | speed 2× | fp16 loss scaling |

**Flash cards**
- **Training memory/param** → `~16 bytes` (bf16 weight+grad, fp32 master, Adam m+v).
- **Why GPUs win** → SIMT: thousands of threads run the same instruction; Tensor Cores for matmul.
- **FSDP idea** → shard params/grads/optim across GPUs; all-gather a layer just-in-time, then free.
- **Roofline** → performance = `min(peak_compute, intensity × bandwidth)`.
- **Keep TP where** → within a node on NVLink; DP/PP across nodes.

## 11. Hands-On Exercises & Mini Project

- [ ] Benchmark a large bf16 matmul on GPU vs the same on CPU and compute the speedup and TFLOP/s.
- [ ] Compute the training memory budget for a 7B model with Adam and verify it exceeds one 80 GB GPU.
- [ ] Convert a single-GPU training script to FSDP and measure memory-per-GPU and throughput at 2 and 4 GPUs.
- [ ] Add gradient checkpointing and measure the memory saved vs the compute cost.
- [ ] Measure scaling efficiency (throughput at `N` GPUs / `N ×` throughput at 1) and explain any gap.

**Mini Project: Scale a Training Run and Chart Efficiency.**
Goal: train a small transformer and quantify distributed scaling.
Requirements: (1) implement a single-GPU AMP training loop with gradient accumulation; (2) wrap it in FSDP and launch on 2, 4, and 8 GPUs via `torchrun`; (3) measure tokens/sec, memory-per-GPU, and scaling efficiency; (4) add activation checkpointing and show the memory/throughput trade-off.
Extensions: profile compute-vs-communication time and enable comm/compute overlap; simulate a straggler and measure its impact on the collective; add a sharded checkpoint and time a resume after a killed rank.

## 12. Related Topics & Free Learning Resources

Related chapters: **Fine-Tuning, LoRA & QLoRA** (FSDP + QLoRA for memory-efficient training), **Quantization & Inference Optimization** (the roofline and memory-bandwidth story on the inference side), **Serving LLMs: vLLM, Batching & Throughput** (tensor parallelism at serving time), and **MLOps: Pipelines, CI/CD & Registries** (orchestrating and reproducing training jobs).

**Free Learning Resources**
- **NVIDIA CUDA C++ Programming Guide** — NVIDIA · *Advanced* · the canonical reference for the GPU execution model and memory hierarchy. <https://docs.nvidia.com/cuda/cuda-c-programming-guide/>
- **PyTorch FSDP tutorial** — PyTorch · *Intermediate* · hands-on sharded training, wrapping policies, and checkpointing. <https://pytorch.org/tutorials/intermediate/FSDP_tutorial.html>
- **ZeRO: Memory Optimizations Toward Training Trillion Parameter Models** — Rajbhandari et al. (DeepSpeed) · *Advanced* · the sharding math behind ZeRO-1/2/3. <https://arxiv.org/abs/1910.02054>
- **Megatron-LM: Training Multi-Billion Parameter Models** — Shoeybi et al. (NVIDIA) · *Advanced* · tensor and pipeline parallelism for transformers. <https://arxiv.org/abs/1909.08053>
- **How to Train Really Large Models on Many GPUs** — Lilian Weng · *Intermediate* · a clear survey of DP/TP/PP/ZeRO trade-offs. <https://lilianweng.github.io/posts/2021-09-25-train-large/>
- **The Ultra-Scale Playbook** — Hugging Face · *Advanced* · practical, illustrated guide to 3D parallelism and scaling. <https://huggingface.co/spaces/nanotron/ultrascale-playbook>
- **Making Deep Learning Go Brrrr From First Principles** — Horace He · *Intermediate* · compute-bound vs memory-bound and the roofline in practice. <https://horace.io/brrr_intro.html>

---

*AI Engineering Handbook — chapter 40.*
