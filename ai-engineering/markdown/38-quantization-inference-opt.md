# 38 · Quantization & Inference Optimization

> **In one line:** Shrink models by storing weights in fewer bits and speed them up with KV-caching, FlashAttention, and speculative decoding — turning an expensive GPU model into a fast, cheap service.

---

## 1. Overview

A trained LLM is a pile of floating-point numbers, and by default each is a 16-bit `bfloat16` value. A 70B-parameter model is therefore `~140 GB` just to store the weights — before any activations or KV cache. **Quantization** is the art of representing those numbers in fewer bits (8, 4, even 2) so the model fits in less memory and moves fewer bytes per token. Because LLM inference is overwhelmingly **memory-bandwidth-bound** — the GPU spends most of its time reading weights from HBM, not doing math — halving the bytes read roughly doubles token throughput.

The second front is the *algorithm* of decoding. Autoregressive generation emits one token at a time, each depending on all previous tokens. Naively that means re-computing attention over the whole prefix at every step — quadratic waste. **Inference optimizations** eliminate that waste: the **KV cache** stores past keys/values so each new token is `O(context)` not `O(context²)`; **FlashAttention** computes attention without ever materializing the giant score matrix; and **speculative decoding** uses a small draft model to guess several tokens that the big model verifies in one pass.

Historically these emerged from a simple pressure: models grew faster than GPU memory and users demanded interactive latency. GPTQ and AWQ (2022–2023) made 4-bit weights practical without retraining; FlashAttention (2022) removed the memory wall in attention; speculative decoding (2023) broke the one-token-per-forward-pass barrier. Together they're why a 70B model that once needed an 8-GPU node can now serve on two GPUs at interactive speed.

A concrete example: a chatbot serving `100 tokens/s` per user on bf16 needs an expensive multi-GPU setup and still bottlenecks on memory bandwidth. Quantize the weights to int4 (`4×` smaller), enable a paged KV cache and FlashAttention, and add a `1B` draft model for speculative decoding — and the same hardware serves several times the users at lower latency, with quality within a fraction of a percent of the original.

## 2. Core Concepts

- **Quantization** — mapping high-precision values (fp16/bf16) to a low-bit representation (int8/int4) via a scale and zero-point, trading precision for memory/bandwidth.
- **PTQ (Post-Training Quantization)** — quantizing an already-trained model with no or minimal calibration data; fast, no retraining. GPTQ and AWQ are PTQ methods.
- **QAT (Quantization-Aware Training)** — simulating quantization during training so the model learns to be robust to it; higher quality, much more expensive.
- **GPTQ** — layer-wise PTQ that minimizes output error using approximate second-order (Hessian) information; strong 4-bit accuracy.
- **AWQ (Activation-aware Weight Quantization)** — protects the `~1%` of weight channels tied to large activations, scaling them before quantizing; fast and accurate.
- **KV cache** — stored keys and values of all past tokens so attention for a new token reuses them instead of recomputing.
- **FlashAttention** — an IO-aware exact-attention algorithm that tiles the computation in SRAM and never writes the full `N×N` score matrix to HBM.
- **Speculative decoding** — a small draft model proposes `k` tokens; the target model verifies them in one forward pass, accepting the longest correct prefix.
- **Prefill vs decode** — prefill processes the whole prompt in parallel (compute-bound); decode generates tokens one at a time (memory-bound).
- **Weight-only vs weight+activation quantization** — quantizing only weights (W4A16) keeps activations in fp16; quantizing both (W8A8) needs care with activation outliers.

## 3. Theory & Mathematical Intuition

**Quantization** maps a real value `x` to an integer `q` with a scale `s` and zero-point `z`:

```
q = round(x / s) + z          # quantize
x_hat = s · (q - z)           # dequantize (approximate)
```

For a symmetric int8 range, `s = max(|x|) / 127` over the tensor (or per-channel). The error is bounded by `±s/2`. The trouble is **outliers**: a few weights or activations with huge magnitude inflate `max(|x|)`, stretching `s` and destroying resolution for the other 99%. This is why naive int8 works but int4 often needs smarter schemes. **GPTQ** frames it as minimizing `||W·x − Ŵ·x||²` and uses the Hessian of that loss to quantize columns in the order that least disturbs the output, compensating remaining columns. **AWQ** observes that weights connected to large-magnitude activation channels matter most; it scales those channels up before quantizing (and down after) so they keep resolution.

**Attention cost.** Standard attention computes `S = QKᵀ` (an `N×N` matrix), softmaxes it, then multiplies by `V`. Writing and reading that `N×N` matrix to HBM costs `O(N²)` memory traffic — the real bottleneck. **FlashAttention** computes the same result in tiles that fit in on-chip SRAM, using the *online softmax* trick to accumulate the result without ever storing `S`:

```
Attention(Q,K,V) = softmax(QKᵀ / √d_k) · V     # d_k = head dimension
```

By streaming blocks and rescaling running sums, FlashAttention drops memory traffic from `O(N²)` to `O(N)` and is numerically exact — same output, far less HBM I/O.

**Speculative decoding** exploits that verifying tokens is cheaper than generating them. A draft model `q` proposes tokens `x₁..x_k`. The target model `p` scores all `k` in one parallel forward pass. Each proposed token is accepted with probability `min(1, p(x)/q(x))`; on rejection, a corrected token is sampled from the adjusted distribution. The output distribution is provably identical to sampling from `p` directly — it's a pure speedup, not an approximation. Expected tokens per target-pass ≈ `(1 − α^{k+1})/(1 − α)` where `α` is the acceptance rate.

The diagram shows how int4 quantization compresses the fp16 weight distribution onto a small grid, with outliers stretching the scale.

```svg
<svg viewBox="0 0 720 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="14">Quantization: fp16 weights mapped to a low-bit grid</text>

  <text x="60" y="70" fill="#1e293b" font-size="12">fp16 (continuous)</text>
  <line x1="60" y1="90" x2="600" y2="90" stroke="#0ea5e9" stroke-width="1.5"/>
  <circle cx="140" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="205" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="255" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="330" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="360" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="415" cy="90" r="4" fill="#0ea5e9"/>
  <circle cx="560" cy="90" r="6" fill="#d97706"/>
  <text x="560" y="76" text-anchor="middle" fill="#d97706" font-size="11">outlier</text>

  <text x="60" y="160" fill="#1e293b" font-size="12">int4 grid (16 levels)</text>
  <line x1="60" y1="180" x2="600" y2="180" stroke="#4f46e5" stroke-width="1.5"/>
  <line x1="100" y1="172" x2="100" y2="188" stroke="#4f46e5"/>
  <line x1="163" y1="172" x2="163" y2="188" stroke="#4f46e5"/>
  <line x1="226" y1="172" x2="226" y2="188" stroke="#4f46e5"/>
  <line x1="289" y1="172" x2="289" y2="188" stroke="#4f46e5"/>
  <line x1="352" y1="172" x2="352" y2="188" stroke="#4f46e5"/>
  <line x1="415" y1="172" x2="415" y2="188" stroke="#4f46e5"/>
  <line x1="478" y1="172" x2="478" y2="188" stroke="#4f46e5"/>
  <line x1="541" y1="172" x2="541" y2="188" stroke="#4f46e5"/>
  <text x="330" y="215" text-anchor="middle" fill="#64748b" font-size="11">each fp16 value snaps to nearest level:  q = round(x/s) + z</text>
  <text x="330" y="235" text-anchor="middle" fill="#16a34a" font-size="11">AWQ/GPTQ protect outlier channels so scale s stays tight</text>

  <line x1="140" y1="94" x2="163" y2="172" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="360" y1="94" x2="352" y2="172" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"/>
  <line x1="560" y1="96" x2="541" y2="172" stroke="#d97706" stroke-width="1" stroke-dasharray="3 3"/>
</svg>
```

## 4. Architecture & Workflow

An optimized inference stack layers these techniques. A typical path from request to token:

1. **Load a quantized checkpoint.** Weights arrive pre-quantized (GPTQ/AWQ int4 or fp8) and are unpacked into the serving engine's kernels. Memory footprint drops `~4×` versus bf16.
2. **Prefill the prompt.** The whole prompt runs through the model in one parallel pass (compute-bound). FlashAttention computes attention tile-by-tile in SRAM. The resulting keys/values for every layer are written into the **KV cache**.
3. **Decode loop begins.** For each new token, only the *latest* token's query attends to the cached keys/values — no recomputation of the prefix. This is memory-bound: the GPU streams weights and KV cache from HBM.
4. **Speculative step (optional).** A small draft model generates `k` candidate tokens cheaply; the target model verifies all `k` in one forward pass and accepts the longest matching prefix, emitting multiple tokens per target step.
5. **Sample & append.** Apply temperature/top-p, pick the token, append its K/V to the cache, and repeat until EOS or max length.
6. **Evict / page the cache.** As sequences finish, their KV blocks are freed; paged allocation (PagedAttention) avoids fragmentation and enables high batch sizes.

The diagram contrasts naive decoding against a KV-cached, speculative pipeline.

```svg
<svg viewBox="0 0 740 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="q2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">Optimized decode: KV cache + speculative verification</text>

  <rect x="30" y="50" width="150" height="90" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="72" text-anchor="middle" fill="#1e293b" font-size="12">Prefill (prompt)</text>
  <text x="105" y="92" text-anchor="middle" fill="#64748b" font-size="11">parallel · compute-bound</text>
  <text x="105" y="112" text-anchor="middle" fill="#64748b" font-size="11">FlashAttention in SRAM</text>
  <text x="105" y="130" text-anchor="middle" fill="#64748b" font-size="11">fills KV cache</text>

  <rect x="230" y="40" width="150" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="305" y="65" text-anchor="middle" fill="#1e293b" font-size="12">Draft model (1B)</text>
  <text x="305" y="84" text-anchor="middle" fill="#64748b" font-size="11">proposes k tokens</text>

  <rect x="230" y="120" width="150" height="70" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="305" y="145" text-anchor="middle" fill="#1e293b" font-size="12">Target model (70B)</text>
  <text x="305" y="164" text-anchor="middle" fill="#64748b" font-size="11">verifies k in 1 pass</text>
  <text x="305" y="181" text-anchor="middle" fill="#64748b" font-size="11">accept longest prefix</text>

  <rect x="440" y="80" width="140" height="70" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="510" y="105" text-anchor="middle" fill="#1e293b" font-size="12">KV cache (paged)</text>
  <text x="510" y="124" text-anchor="middle" fill="#64748b" font-size="11">int4 weights streamed</text>
  <text x="510" y="141" text-anchor="middle" fill="#64748b" font-size="11">reused every step</text>

  <rect x="620" y="120" width="100" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="670" y="148" text-anchor="middle" fill="#1e293b" font-size="12">Tokens out</text>
  <text x="670" y="166" text-anchor="middle" fill="#64748b" font-size="11">≥1 per pass</text>

  <line x1="180" y1="95" x2="228" y2="75" stroke="#475569" stroke-width="1.5" marker-end="url(#q2)"/>
  <line x1="305" y1="100" x2="305" y2="118" stroke="#475569" stroke-width="1.5" marker-end="url(#q2)"/>
  <line x1="380" y1="150" x2="438" y2="120" stroke="#475569" stroke-width="1.5" marker-end="url(#q2)"/>
  <line x1="510" y1="150" x2="360" y2="180" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#q2)"/>
  <line x1="380" y1="160" x2="618" y2="155" stroke="#475569" stroke-width="1.5" marker-end="url(#q2)"/>
  <text x="470" y="230" text-anchor="middle" fill="#64748b" font-size="11">reject → resample from corrected distribution (output identical to target sampling)</text>
</svg>
```

## 5. Implementation

Quantizing to int8 conceptually, and loading a real 4-bit model for fast inference.

```python
import numpy as np

def quantize_int8(w, per_channel_axis=0):
    # Symmetric per-channel int8 quantization
    max_abs = np.max(np.abs(w), axis=per_channel_axis, keepdims=True)
    scale = max_abs / 127.0                 # one scale per output channel
    q = np.round(w / scale).astype(np.int8) # store int8 + scale
    return q, scale

def dequantize_int8(q, scale):
    return q.astype(np.float32) * scale

rng = np.random.default_rng(0)
W = rng.standard_normal((512, 512)).astype(np.float32)
q, s = quantize_int8(W)
W_hat = dequantize_int8(q, s)
print("bytes fp32:", W.nbytes, "-> int8:", q.nbytes + s.nbytes)   # 1,048,576 -> 264,192
print("max abs error:", np.max(np.abs(W - W_hat)))                # ~0.008
```

Loading a 4-bit AWQ model and generating with a fast engine (vLLM), including KV cache and continuous batching for free.

```python
from vllm import LLM, SamplingParams

# AWQ-quantized 4-bit checkpoint: ~4x less GPU memory than bf16
llm = LLM(
    model="TheBloke/Llama-2-13B-chat-AWQ",
    quantization="awq",
    dtype="float16",
    gpu_memory_utilization=0.90,    # KV cache uses the rest of VRAM
    max_model_len=4096,
)
params = SamplingParams(temperature=0.7, top_p=0.9, max_tokens=256)
out = llm.generate(["Explain speculative decoding in two sentences."], params)
print(out[0].outputs[0].text)
```

Speculative decoding with a draft model, again via vLLM.

```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Meta-Llama-3-70B-Instruct",
    speculative_model="meta-llama/Meta-Llama-3-8B-Instruct",  # small draft
    num_speculative_tokens=5,        # propose 5, verify in one target pass
    tensor_parallel_size=4,
)
# On acceptance-friendly workloads this yields ~2-3x tokens/sec at identical output
out = llm.generate(["Summarize the CAP theorem."], SamplingParams(max_tokens=200))
print(out[0].outputs[0].text)
```

**Optimization note:** The single biggest lever is matching quantization to the bottleneck. Decode is memory-bound, so **weight-only int4 (W4A16)** almost always speeds it up. Prefill is compute-bound, so int4 helps less there — fp8 (W8A8) on Hopper/Blackwell GPUs can accelerate the matmuls themselves. Always pair quantization with FlashAttention and a paged KV cache; the KV cache often becomes the memory bottleneck at long context, so consider fp8 KV cache or GQA models. Speculative decoding only pays off when the draft model's acceptance rate is high — measure it before deploying.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **int8 PTQ** | Near-lossless, trivial to apply | Modest `2×` memory savings |
| **int4 (GPTQ/AWQ)** | `4×` smaller, big throughput gains | Small accuracy drop; needs calibration |
| **QAT** | Best low-bit accuracy | Requires full retraining — expensive |
| **KV cache** | Turns `O(N²)` decode into `O(N)` | Consumes VRAM that grows with context×batch |
| **FlashAttention** | Exact, huge memory-traffic savings | GPU/kernel-specific; long-context tuning |
| **Speculative decoding** | `2–3×` tokens/s, output identical | Needs a good draft model; wasted work on low acceptance |
| **fp8 (W8A8)** | Speeds compute-bound prefill too | Needs Hopper/Blackwell; activation outlier care |

## 7. Common Mistakes & Best Practices

1. ⚠️ Quantizing to int4 and never re-evaluating quality → ✅ Always run task evals and perplexity after quantizing; some tasks tolerate it far worse than others.
2. ⚠️ Assuming int4 speeds up prefill as much as decode → ✅ Understand prefill is compute-bound; weight-only quant mostly helps memory-bound decode.
3. ⚠️ Ignoring activation outliers when doing W8A8 → ✅ Use per-channel scales or methods like SmoothQuant/AWQ that handle outlier channels.
4. ⚠️ Forgetting the KV cache grows with batch × context → ✅ Budget VRAM for it; use paged allocation, GQA, or fp8 KV cache at long context.
5. ⚠️ Deploying speculative decoding without measuring acceptance rate → ✅ Profile it; a poorly-matched draft model can be net-slower.
6. ⚠️ Using a bad or too-small calibration set for GPTQ/AWQ → ✅ Calibrate on representative in-domain data; garbage calibration = degraded weights.
7. ⚠️ Disabling FlashAttention "to debug" and shipping it that way → ✅ Keep IO-aware attention on in production; the memory-traffic savings are large.
8. ⚠️ Comparing throughput at batch size 1 only → ✅ Measure across realistic batch sizes; many optimizations shine only under load.
9. ⚠️ Mixing quantized weights with an incompatible kernel → ✅ Match the quantization format to an engine that has optimized kernels for it (Marlin, ExLlama, etc.).
10. ⚠️ Over-quantizing a small model → ✅ Small models are more fragile to low-bit quantization; reserve aggressive int4 for large models where the accuracy hit is minimal.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** If a quantized model outputs gibberish, first check the format/kernel match and the calibration data, then compare per-layer activation statistics against the fp16 model to find where error explodes (usually an outlier-heavy layer). For speculative decoding regressions, log the acceptance rate — a low rate means the draft model diverged from the target's distribution. Reproduce with greedy decoding to isolate quality from sampling noise.

**Monitoring.** Track **time-to-first-token (TTFT)** (dominated by prefill) and **inter-token latency / tokens-per-second** (dominated by decode) separately. Watch KV-cache utilization and eviction/preemption rates, GPU HBM bandwidth utilization, batch size, and — for speculation — the token acceptance rate. Alert on quality-proxy metrics (perplexity on a canary set) after any model or quantization change.

**Security.** Quantization can subtly shift a model's refusal behavior, so re-run safety evals on the quantized artifact, not just the fp16 one. Treat quantized checkpoints from third parties (e.g. community uploads) as untrusted — a maliciously crafted quantization could degrade safety; verify provenance and evaluate before serving.

**Performance & Scaling.** Combine techniques: int4 weights + FlashAttention + PagedAttention + continuous batching + (when acceptance is high) speculative decoding. At long context, the KV cache dominates memory — adopt GQA/MQA models and fp8 KV cache. Scale horizontally with tensor parallelism for a single large model, and separate prefill and decode onto different replicas (disaggregated serving) when TTFT and throughput have conflicting SLAs.

## 9. Interview Questions

**Q: Why does quantization speed up LLM inference, not just shrink it?**
A: Decoding is memory-bandwidth-bound — the GPU spends most time reading weights from HBM rather than doing arithmetic. Fewer bits per weight means fewer bytes streamed per token, so throughput scales roughly with the compression ratio. int4 weights move `~4×` less data than bf16, which is why they roughly quadruple memory-bound decode throughput.

**Q: What's the difference between PTQ and QAT?**
A: Post-Training Quantization quantizes an already-trained model with little or no calibration and no retraining — fast and cheap. Quantization-Aware Training simulates quantization during training so the model adapts to it, yielding better low-bit accuracy at the cost of a full training run. PTQ (GPTQ/AWQ) is the default for LLMs; QAT is reserved for aggressive low-bit or edge deployment.

**Q: How do GPTQ and AWQ differ?**
A: GPTQ uses approximate second-order (Hessian) information to quantize weight columns in an error-minimizing order, compensating remaining columns as it goes. AWQ instead identifies the small fraction of weight channels tied to large activations and scales them to preserve their resolution before quantizing. Both target 4-bit; AWQ is often faster to produce and hardware-friendly.

**Q: What is the KV cache and why is it essential?**
A: During autoregressive decoding, each new token attends to all previous tokens' keys and values. The KV cache stores those K/V tensors so they're computed once and reused, turning per-step cost from `O(N²)` recomputation into `O(N)`. Without it, generation cost would grow quadratically with sequence length.

**Q: What problem does FlashAttention solve?**
A: Standard attention materializes the `N×N` score matrix in HBM, making attention memory-traffic-bound and `O(N²)` in memory. FlashAttention tiles the computation in on-chip SRAM and uses an online softmax to accumulate the result without ever writing the full score matrix, cutting memory traffic to `O(N)`. It's numerically exact — same output, far less I/O.

**Q: How does speculative decoding preserve output quality?**
A: A draft model proposes tokens; the target verifies them in one pass and accepts each with probability `min(1, p/q)`, resampling from a corrected distribution on rejection. This acceptance rule makes the final distribution provably identical to sampling directly from the target model. It's a lossless speedup, not an approximation.

**Q: Why is prefill compute-bound but decode memory-bound?**
A: Prefill processes all prompt tokens in parallel, giving large matrix-matrix multiplies with high arithmetic intensity that saturate the GPU's compute units. Decode generates one token at a time — small matrix-vector operations with low arithmetic intensity, so the GPU stalls waiting on weight reads from memory. This is why quantization helps decode most.

**Q: (Senior) At 32k context the KV cache is your bottleneck. What are your options?**
A: Use grouped-query or multi-query attention models to share K/V across heads, shrinking the cache several-fold; quantize the KV cache to fp8/int8; adopt PagedAttention to eliminate fragmentation and pack more sequences; and consider sliding-window or attention-sink schemes to bound cache growth. If SLAs allow, offload cold KV blocks to CPU or reduce max context per tenant.

**Q: (Senior) You quantized a 7B model to int4 and quality collapsed, but the same recipe was fine on 70B. Why?**
A: Smaller models have less redundancy, so each weight carries more information and low-bit rounding hurts more — the accuracy-per-bit curve is steeper. Large models tolerate int4 because their over-parameterization absorbs the error. Fixes: use a higher bit width (int8) or group-wise quantization for the small model, better calibration data, or an outlier-aware method like AWQ.

**Q: (Senior) Design an inference stack to minimize both TTFT and cost for a chat product.**
A: Serve an int4 (AWQ/GPTQ) or fp8 quantized model with FlashAttention and PagedAttention for a large KV cache. Use continuous batching to keep the GPU busy across users, and disaggregate prefill (compute-bound, drives TTFT) from decode (memory-bound, drives throughput) onto tuned replicas. Add speculative decoding where acceptance is high, and pick a GQA model to keep the cache small. Monitor TTFT and inter-token latency separately against SLAs.

**Q: (Senior) When does speculative decoding hurt rather than help?**
A: When the draft model's acceptance rate is low — its proposals diverge from the target, so most verified tokens are rejected and the extra draft compute is wasted, making throughput worse than plain decoding. It also helps little when the system is already at high batch utilization (the GPU is saturated), since speculation trades extra compute for fewer serial steps. Always measure acceptance and net tokens/sec under real load.

**Q: What is the difference between weight-only (W4A16) and weight+activation (W8A8) quantization?**
A: W4A16 quantizes only weights to 4-bit while activations stay fp16 — ideal for memory-bound decode and simple to apply since activations avoid outlier issues. W8A8 quantizes both to int8, enabling faster integer matmuls (helpful for compute-bound prefill) but requiring outlier handling on activations (e.g. SmoothQuant). Choose based on whether your bottleneck is memory or compute.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** LLM inference is memory-bandwidth-bound during decode, so quantization (int8/int4 via GPTQ/AWQ) speeds it up by moving fewer bytes per token, not just saving memory. Outliers are the enemy of low-bit quantization; AWQ and GPTQ handle them. The KV cache turns quadratic decode into linear by reusing past keys/values. FlashAttention computes exact attention without materializing the `N×N` score matrix, slashing memory traffic. Speculative decoding uses a small draft model to propose tokens the big model verifies in one pass, giving `2–3×` speedup with identical output. Prefill is compute-bound; decode is memory-bound — match your optimization to the bottleneck.

| Technique | Wins on | Key idea |
|---|---|---|
| int4 weights | decode memory BW | 4× fewer bytes/token |
| AWQ/GPTQ | low-bit accuracy | protect outlier channels |
| KV cache | decode compute | reuse past K/V |
| FlashAttention | attention memory | tile in SRAM, online softmax |
| Speculative decode | serial latency | draft proposes, target verifies |
| PagedAttention | batch density | no cache fragmentation |

**Flash cards**
- **Quantize formula** → `q = round(x/s) + z`, store int + scale, dequant `x̂ = s(q−z)`.
- **Why decode is memory-bound** → one token at a time = small matrix-vector ops, GPU waits on weight reads.
- **FlashAttention trick** → tiled computation in SRAM with online softmax, never write `N×N` to HBM.
- **Speculative decoding guarantee** → accept rule makes output distribution identical to target sampling.
- **KV cache cost** → grows with batch × context × layers; often the long-context bottleneck.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement per-tensor vs per-channel int8 quantization in numpy and compare max error on a real weight matrix.
- [ ] Quantize a 7B model with AWQ and GPTQ; measure perplexity and tokens/sec against bf16.
- [ ] Plot KV-cache memory versus context length and batch size for a chosen model.
- [ ] Enable and disable FlashAttention in a serving run and measure the long-context latency delta.
- [ ] Run speculative decoding with two different draft models and record the acceptance rate and net throughput.

**Mini Project: Build a Latency/Cost Dashboard for a Quantized Model.**
Goal: serve one open model at three precisions (bf16, int8, int4) and characterize the frontier.
Requirements: (1) deploy each variant on identical hardware via vLLM; (2) measure TTFT, inter-token latency, and tokens/sec across batch sizes `1, 8, 32`; (3) measure quality via perplexity and a small task eval; (4) plot the quality-vs-throughput-vs-cost trade-off.
Extensions: add a speculative-decoding variant and overlay its curve; add fp8 KV cache and show the long-context memory savings; write a short recommendation for which config to ship for an interactive chat SLA.

## 12. Related Topics & Free Learning Resources

Related chapters: **Fine-Tuning, LoRA & QLoRA** (QLoRA reuses this quantization machinery), **Serving LLMs: vLLM, Batching & Throughput** (PagedAttention and continuous batching build on the KV cache), and **GPU Computing & Distributed Training** (the memory-bandwidth roofline that explains why decode is memory-bound).

**Free Learning Resources**
- **FlashAttention: Fast and Memory-Efficient Exact Attention** — Dao et al. · *Advanced* · the IO-aware attention algorithm; read the tiling/online-softmax section. <https://arxiv.org/abs/2205.14135>
- **AWQ: Activation-aware Weight Quantization** — Lin et al. (MIT) · *Advanced* · why protecting outlier channels enables accurate 4-bit. <https://arxiv.org/abs/2306.00978>
- **GPTQ: Accurate Post-Training Quantization** — Frantar et al. · *Advanced* · Hessian-guided one-shot 4-bit quantization. <https://arxiv.org/abs/2210.17323>
- **Fast Inference from Transformers via Speculative Decoding** — Leviathan et al. (Google) · *Advanced* · the acceptance rule and the lossless-speedup proof. <https://arxiv.org/abs/2211.17192>
- **Hugging Face Quantization docs** — Hugging Face · *Intermediate* · practical bitsandbytes/GPTQ/AWQ usage and trade-offs. <https://huggingface.co/docs/transformers/quantization>
- **A Visual Guide to Quantization** — Maarten Grootendorst · *Beginner* · clear pictures of scales, zero-points, and outliers. <https://newsletter.maartengrootendorst.com/p/a-visual-guide-to-quantization>
- **vLLM documentation** — vLLM project · *Intermediate* · KV cache, quantization backends, and speculative decoding config. <https://docs.vllm.ai>

---

*AI Engineering Handbook — chapter 38.*
