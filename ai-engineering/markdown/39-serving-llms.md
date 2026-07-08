# 39 · Serving LLMs: vLLM, Batching & Throughput

> **In one line:** Production LLM serving is the art of keeping expensive GPUs busy — continuous batching and PagedAttention squeeze many concurrent users onto one model while navigating the latency-versus-throughput frontier.

---

## 1. Overview

Training a model is a one-time cost; **serving** it is a bill you pay on every single request, forever. A serving engine's job is to take a fleet of GPUs worth thousands of dollars a month and extract the maximum number of useful tokens per second from them without blowing anyone's latency budget. That sounds mundane until you realize a naive server wastes `70–90%` of a GPU's capacity, so the difference between a good and bad serving stack is often `10×` in cost.

The core problem is that LLM generation is **autoregressive and variable-length**. Requests arrive at random times, each prompt is a different length, and each response finishes after an unpredictable number of tokens. A naive batching scheme — collect N requests, run them together, wait for all to finish — leaves the GPU idle while it waits for the slowest, and can't admit new requests mid-flight. **Continuous batching** fixes this by scheduling at the *token* level: it adds and evicts requests every decoding step, so the GPU never waits for stragglers. **PagedAttention** (from vLLM, 2023) fixes the memory side: it manages the KV cache in fixed-size pages like an OS virtual-memory system, eliminating the fragmentation that otherwise wasted most of the cache and capped batch size.

Historically, early LLM serving reused generic model servers (TorchServe, Triton) that batched at the request level and pre-allocated KV cache for the maximum sequence length — hugely wasteful. vLLM's PagedAttention and continuous batching, followed by NVIDIA TensorRT-LLM and Hugging Face TGI, redefined the baseline. Today the question isn't "can I serve an LLM" but "which engine and config hits my latency/throughput/cost target."

A concrete example: a coding assistant handles bursty traffic where prompts range from 50 to 8,000 tokens and responses from 10 to 2,000. On a request-batched server, one long prompt stalls the batch and the KV cache fragments, so a single A100 serves maybe 5 concurrent users. Switch to vLLM with continuous batching and PagedAttention and the same GPU serves 30+ users at the same per-user latency — a `6×` cost reduction from software alone.

## 2. Core Concepts

- **Prefill vs decode** — prefill processes the whole prompt in one parallel, compute-bound pass; decode generates tokens one at a time, memory-bound. Their costs and SLAs differ.
- **Static (request) batching** — group N requests, run to completion together; simple but wastes GPU on length variance and can't admit mid-flight.
- **Continuous (in-flight) batching** — schedule at each decode step, adding new and evicting finished requests every iteration to keep the GPU saturated.
- **PagedAttention** — manage KV cache as fixed-size non-contiguous pages (like OS paging), eliminating fragmentation and enabling near-100% cache utilization.
- **KV cache** — stored keys/values of past tokens; its size (batch × context × layers) usually caps how many requests fit on a GPU.
- **Throughput** — total tokens/sec across all users; maximized by large batches. **Latency** — per-user response time (TTFT + inter-token). They trade off.
- **TTFT (time-to-first-token)** — dominated by prefill and queueing; the "feels responsive" metric for streaming UIs.
- **TPOT / ITL (time-per-output-token / inter-token latency)** — decode speed per user; determines how fast text streams out.
- **Tensor parallelism** — split each layer's matrices across GPUs to serve a model too big for one device (see chapter 40).
- **Continuous batching engines** — vLLM, TensorRT-LLM, TGI, SGLang; Ollama/llama.cpp target local/edge single-user use.

## 3. Theory & Mathematical Intuition

The governing tension is **throughput vs latency**, and it comes from GPU arithmetic intensity. Decode is memory-bound: for one request, the GPU reads all model weights from HBM to produce a single token, doing tiny matrix-vector math. Reading the same weights for a batch of `B` requests costs almost the same time but produces `B` tokens — so throughput rises nearly linearly with batch size *until* compute or memory saturates. This is why batching is the master lever:

```
tokens_per_sec ≈ B / step_time(B)      # step_time grows slowly with B while memory-bound
```

The ceiling on `B` is the **KV cache**. Its size is:

```
kv_bytes = 2 · L · n_kv_heads · d_head · seq_len · dtype_bytes   (per request)
```

For Llama-3-70B (`L=80`, and using GQA), a single 8k-token sequence needs on the order of a gigabyte of KV. With naive contiguous allocation you also pre-reserve for the *maximum* length and leave gaps between requests — studies measured `60–80%` of KV memory wasted. **PagedAttention** allocates KV in fixed pages (e.g. 16 tokens each) drawn from a shared pool, referenced by a per-sequence block table — exactly like virtual memory. Internal fragmentation drops to under one page per sequence, so effective batch size (and thus throughput) multiplies.

**Continuous batching** changes the scheduling math. Static batching's latency for a request is bounded below by the *longest* request in its batch; utilization is `mean_len / max_len`, often `<50%` under high variance. Continuous batching evicts a sequence the step it emits EOS and admits a waiting one immediately, so utilization approaches `100%` and a short request no longer waits behind a long one. The scheduler each step chooses which running sequences to decode and which queued prompts to prefill, subject to the KV budget — a bin-packing problem solved greedily every iteration.

The diagram contrasts static batching (idle bubbles) with continuous batching (packed).

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">Static vs continuous batching (rows = requests, x = time)</text>

  <text x="60" y="52" fill="#1e293b" font-size="12">Static batching</text>
  <rect x="60" y="62" width="150" height="20" rx="3" fill="#4f46e5"/>
  <rect x="60" y="86" width="90" height="20" rx="3" fill="#4f46e5"/>
  <rect x="150" y="86" width="60" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-dasharray="3 2"/>
  <rect x="60" y="110" width="120" height="20" rx="3" fill="#4f46e5"/>
  <rect x="180" y="110" width="30" height="20" rx="3" fill="#e2e8f0" stroke="#94a3b8" stroke-dasharray="3 2"/>
  <line x1="210" y1="56" x2="210" y2="138" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="255" y="100" fill="#d97706" font-size="11">batch waits for slowest;</text>
  <text x="255" y="116" fill="#64748b" font-size="11">grey = idle GPU, no new admits</text>

  <text x="60" y="182" fill="#1e293b" font-size="12">Continuous batching</text>
  <rect x="60" y="192" width="150" height="20" rx="3" fill="#16a34a"/>
  <rect x="60" y="216" width="90" height="20" rx="3" fill="#16a34a"/>
  <rect x="152" y="216" width="120" height="20" rx="3" fill="#0ea5e9"/>
  <rect x="60" y="240" width="120" height="20" rx="3" fill="#16a34a"/>
  <rect x="182" y="240" width="150" height="20" rx="3" fill="#0ea5e9"/>
  <text x="360" y="230" fill="#16a34a" font-size="11">finished slot immediately</text>
  <text x="360" y="246" fill="#0ea5e9" font-size="11">filled by a new request (blue)</text>
  <text x="360" y="286" fill="#64748b" font-size="11">GPU stays saturated → higher throughput</text>
</svg>
```

## 4. Architecture & Workflow

A production vLLM-style engine flows like this:

1. **Request arrives** at an OpenAI-compatible HTTP endpoint and enters a **waiting queue** with its sampling params (temperature, max_tokens, stop).
2. **Scheduler admits** requests each iteration based on the free KV-cache block budget. It balances prefill (new prompts) and decode (running sequences), often prioritizing to protect TTFT while maximizing batch fill.
3. **Prefill** runs admitted prompts through the model in parallel (compute-bound), writing each layer's K/V into paged KV blocks; a block table maps logical positions to physical pages.
4. **Decode step** runs all active sequences together for one token. PagedAttention gathers each sequence's scattered KV pages. The step emits one token per sequence.
5. **Sample & stream** the new token per sequence back to the client (Server-Sent Events), append its K/V page, and continue.
6. **Eviction** frees a sequence's KV pages the moment it hits EOS or max_tokens, returning them to the pool for waiting requests.
7. **Preemption / recompute** under memory pressure: if the pool is exhausted, the scheduler preempts a low-priority sequence (swapping its KV to CPU or recomputing later) so others make progress.
8. **Autoscaling** across replicas by a load balancer; long-context or premium tiers may route to dedicated pools.

The diagram shows the serving pipeline and the paged KV pool.

```svg
<svg viewBox="0 0 740 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="s2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="14">vLLM serving pipeline with paged KV cache</text>

  <rect x="30" y="60" width="120" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="82" text-anchor="middle" fill="#1e293b" font-size="12">HTTP requests</text>
  <text x="90" y="98" text-anchor="middle" fill="#64748b" font-size="11">OpenAI API</text>

  <rect x="185" y="60" width="130" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="250" y="82" text-anchor="middle" fill="#1e293b" font-size="12">Scheduler</text>
  <text x="250" y="98" text-anchor="middle" fill="#64748b" font-size="11">admit / evict / preempt</text>

  <rect x="350" y="45" width="150" height="40" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="425" y="70" text-anchor="middle" fill="#1e293b" font-size="12">Prefill (parallel)</text>
  <rect x="350" y="95" width="150" height="40" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="425" y="120" text-anchor="middle" fill="#1e293b" font-size="12">Decode step (batch)</text>

  <rect x="540" y="55" width="170" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-dasharray="4 3"/>
  <text x="625" y="74" text-anchor="middle" fill="#64748b" font-size="11">Paged KV pool</text>
  <rect x="555" y="84" width="30" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
  <rect x="590" y="84" width="30" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
  <rect x="625" y="84" width="30" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
  <rect x="660" y="84" width="30" height="22" rx="3" fill="#e2e8f0" stroke="#94a3b8"/>
  <rect x="555" y="112" width="30" height="22" rx="3" fill="#e2e8f0" stroke="#94a3b8"/>
  <rect x="590" y="112" width="30" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
  <rect x="625" y="112" width="30" height="22" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
  <rect x="660" y="112" width="30" height="22" rx="3" fill="#e2e8f0" stroke="#94a3b8"/>
  <text x="625" y="158" text-anchor="middle" fill="#64748b" font-size="10">16-token pages · block table maps them</text>

  <rect x="350" y="250" width="150" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="425" y="272" text-anchor="middle" fill="#1e293b" font-size="12">Stream tokens (SSE)</text>
  <text x="425" y="288" text-anchor="middle" fill="#64748b" font-size="11">one token/seq/step</text>

  <line x1="150" y1="83" x2="183" y2="83" stroke="#475569" stroke-width="1.5" marker-end="url(#s2)"/>
  <line x1="315" y1="80" x2="348" y2="70" stroke="#475569" stroke-width="1.5" marker-end="url(#s2)"/>
  <line x1="425" y1="85" x2="425" y2="93" stroke="#475569" stroke-width="1.5" marker-end="url(#s2)"/>
  <line x1="500" y1="115" x2="553" y2="115" stroke="#16a34a" stroke-width="1.4" marker-end="url(#s2)"/>
  <line x1="553" y1="100" x2="502" y2="100" stroke="#16a34a" stroke-width="1.4" marker-end="url(#s2)"/>
  <line x1="425" y1="135" x2="425" y2="248" stroke="#475569" stroke-width="1.5" marker-end="url(#s2)"/>
</svg>
```

## 5. Implementation

Offline batched inference with vLLM — the scheduler batches these automatically.

```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Meta-Llama-3-8B-Instruct",
    gpu_memory_utilization=0.90,     # fraction of VRAM for weights + KV cache
    max_num_seqs=256,                # max concurrent sequences in a batch
    max_model_len=8192,
    enable_prefix_caching=True,      # reuse KV for shared prompt prefixes
)
prompts = ["Explain PagedAttention.", "What is continuous batching?", "Define TTFT."]
params = SamplingParams(temperature=0.7, max_tokens=200)
for out in llm.generate(prompts, params):        # all three batched together
    print(out.outputs[0].text[:80])
```

Running vLLM as an OpenAI-compatible server, then streaming from a client.

```bash
# Launch the server (continuous batching + PagedAttention on by default)
python -m vllm.entrypoints.openai.api_server \
    --model meta-llama/Meta-Llama-3-8B-Instruct \
    --gpu-memory-utilization 0.90 \
    --max-num-seqs 256 \
    --tensor-parallel-size 1
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")
stream = client.chat.completions.create(
    model="meta-llama/Meta-Llama-3-8B-Instruct",
    messages=[{"role": "user", "content": "Summarize continuous batching in 3 lines."}],
    stream=True,          # tokens arrive as they decode -> low perceived latency
    max_tokens=200,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

A tiny benchmark to observe the latency/throughput trade-off across concurrency.

```python
import time, threading
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")

def one_call(latencies):
    t0 = time.time()
    client.chat.completions.create(
        model="meta-llama/Meta-Llama-3-8B-Instruct",
        messages=[{"role": "user", "content": "Write a haiku about GPUs."}],
        max_tokens=64,
    )
    latencies.append(time.time() - t0)

for concurrency in (1, 8, 32):
    lat, threads = [], []
    t0 = time.time()
    for _ in range(concurrency):
        th = threading.Thread(target=one_call, args=(lat,)); th.start(); threads.append(th)
    for th in threads: th.join()
    wall = time.time() - t0
    print(f"conc={concurrency:2d}  p50_latency={sorted(lat)[len(lat)//2]:.2f}s  throughput={concurrency/wall:.1f} req/s")
# conc= 1  p50_latency=0.9s  throughput=1.1 req/s
# conc= 8  p50_latency=1.3s  throughput=6.0 req/s   <- batching wins
# conc=32  p50_latency=2.4s  throughput=13.5 req/s  <- latency up, throughput up
```

**Optimization note:** `gpu_memory_utilization` and `max_num_seqs` are the two dials that set your batch ceiling — push utilization to `0.9–0.95` to give the KV pool room, and raise `max_num_seqs` until latency SLAs bind. Turn on **prefix caching** when many requests share a system prompt (chat, few-shot) to skip re-prefilling it. Use tensor parallelism only when the model doesn't fit on one GPU or when it lowers latency enough to justify the communication overhead. Chunked prefill smooths TTFT by interleaving long-prompt prefill with ongoing decode.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **Continuous batching** | Near-100% GPU utilization, high throughput | Larger batches raise per-user latency |
| **PagedAttention** | Eliminates KV fragmentation, more concurrency | Slight kernel complexity; page-gather overhead |
| **vLLM** | Fast, OpenAI-compatible, easy to run | Fewer knobs than TensorRT-LLM for last-mile tuning |
| **TensorRT-LLM** | Peak NVIDIA performance, fused kernels | Complex build, engine compilation, NVIDIA-only |
| **TGI** | Production-hardened, HF ecosystem | Slightly behind vLLM on some throughput benchmarks |
| **Ollama / llama.cpp** | Trivial local/edge, CPU + GPU | Single-user focus; not for high-concurrency serving |
| **Prefix caching** | Free win on shared prompts | Only helps when prefixes actually repeat |

## 7. Common Mistakes & Best Practices

1. ⚠️ Using a request-batched or single-request server for concurrent traffic → ✅ Use a continuous-batching engine (vLLM/TGI/TRT-LLM); it's often a `5–10×` cost difference.
2. ⚠️ Setting `gpu_memory_utilization` too low "to be safe" → ✅ Push it to `0.9–0.95`; the leftover VRAM is your KV cache and thus your batch size.
3. ⚠️ Reporting only average latency → ✅ Track p95/p99 TTFT and inter-token latency separately; averages hide the queueing tail.
4. ⚠️ Conflating throughput and latency SLAs → ✅ Decide which you're optimizing; bigger batches help throughput but hurt latency, and they can't both be maximal.
5. ⚠️ Re-sending the same system prompt uncached → ✅ Enable prefix caching for shared prefixes to skip redundant prefill.
6. ⚠️ Reaching for tensor parallelism unnecessarily → ✅ Only shard when the model won't fit on one GPU or TP measurably cuts latency; TP adds all-reduce overhead.
7. ⚠️ Ignoring max_tokens and letting runaway generations hog the batch → ✅ Enforce sane max_tokens and stop sequences; unbounded outputs starve other users.
8. ⚠️ Benchmarking with uniform, short prompts → ✅ Benchmark with realistic length distributions; variance is exactly what continuous batching addresses.
9. ⚠️ No autoscaling or admission control → ✅ Add a queue with backpressure and horizontal replicas; a saturated GPU should shed or queue, not melt down.
10. ⚠️ Assuming Ollama/llama.cpp scales to production concurrency → ✅ Use them for local/dev; use vLLM/TGI/TRT-LLM for multi-user serving.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Rising TTFT usually means queueing — the scheduler can't admit prompts because the KV pool is full; check preemption/recompute counts and lower `max_num_seqs` or add replicas. Slow inter-token latency at low load points to an inefficient kernel or unnecessary tensor parallelism. If throughput plateaus below expectation, verify `gpu_memory_utilization` is high and prefix caching is on. Reproduce with a fixed seed and greedy decoding to separate engine bugs from sampling noise.

**Monitoring.** The essential dashboard: TTFT p50/p95/p99, inter-token latency, tokens/sec throughput, running-vs-waiting queue depth, KV-cache utilization, preemption rate, and GPU utilization/HBM bandwidth. Alert on queue depth growth (impending overload), preemption spikes (memory pressure), and TTFT SLA breaches. Track cost-per-million-tokens as the north-star efficiency metric.

**Security.** Serving endpoints need authentication, per-tenant rate limits, and input size caps (a 100k-token prompt can DoS the KV cache). Enforce max prompt and output length. Isolate tenants' prompts and caches; be careful that prefix caching doesn't leak one user's cached prompt content into another's results. Sanitize/guard against prompt injection at the application layer, not the engine.

**Performance & Scaling.** Scale up by maximizing batch (utilization + max_num_seqs), then scale out with replicas behind a load balancer. Route by workload: separate long-context or premium tiers into their own pools so they don't evict interactive traffic. Consider **disaggregated prefill/decode** (separate GPU pools) when TTFT and throughput SLAs conflict. Combine with quantization (chapter 38) to shrink weights and grow the KV pool. Use speculative decoding where acceptance is high.

## 9. Interview Questions

**Q: What is continuous batching and why is it better than static batching?**
A: Continuous (in-flight) batching schedules at the token level, admitting new requests and evicting finished ones every decode step, rather than running a fixed batch to completion. This keeps the GPU saturated instead of waiting for the slowest request in a batch, and a short request no longer queues behind a long one. It typically multiplies throughput several-fold under realistic length variance.

**Q: Explain PagedAttention and the problem it solves.**
A: Naive KV-cache allocation reserves contiguous memory for each sequence's max length, wasting `60–80%` to fragmentation and over-reservation. PagedAttention stores KV in fixed-size non-contiguous pages from a shared pool, referenced by a per-sequence block table — like OS virtual memory. Fragmentation drops to under one page per sequence, so far more sequences fit and throughput rises.

**Q: Why does batching increase throughput so dramatically for decode?**
A: Decode is memory-bandwidth-bound: producing one token requires reading all model weights from HBM but doing tiny math. Batching many sequences amortizes that same weight read across many tokens, so throughput scales nearly linearly with batch size until compute or the KV cache saturates. Prefill, being compute-bound, benefits less.

**Q: What is the difference between TTFT and inter-token latency, and what drives each?**
A: TTFT (time-to-first-token) is dominated by queueing plus the compute-bound prefill of the prompt; it's the responsiveness a user first feels. Inter-token latency (TPOT) is the memory-bound decode speed per token, which sets how fast text streams. They have different SLAs and different remedies — batch size and admission control affect TTFT, while decode kernels and model size affect TPOT.

**Q: How does the KV cache limit concurrency?**
A: Each active sequence holds KV memory proportional to its context length across all layers, and this cache competes with weights for VRAM. The number of sequences that fit — and thus batch size and throughput — is capped by free KV memory. Shrinking KV (GQA, fp8 cache, PagedAttention) or weights (quantization) directly raises concurrency.

**Q: When would you choose vLLM vs TensorRT-LLM vs Ollama?**
A: vLLM for fast, easy, high-throughput serving with an OpenAI-compatible API and minimal tuning. TensorRT-LLM when you need peak NVIDIA performance and will invest in engine compilation and tuning. Ollama/llama.cpp for local, single-user, or edge/CPU scenarios where simplicity matters more than concurrency.

**Q: What is prefix caching and when does it help?**
A: Prefix caching stores the KV of a shared prompt prefix (e.g. a long system prompt or few-shot examples) so subsequent requests reuse it instead of re-prefilling. It cuts prefill cost and TTFT dramatically for workloads where many requests share a prefix — chat with a fixed system prompt, RAG with a common template — but does nothing when prefixes don't repeat.

**Q: (Senior) Your p99 TTFT is spiking under load but throughput looks fine. Diagnose.**
A: Throughput fine + TTFT spiking means requests are queueing before admission: the KV pool is saturated by long-running decodes, so new prompts wait. Check waiting-queue depth and preemption rate. Fixes: cap max_tokens to free slots faster, lower max_num_seqs to reserve headroom for prefill, enable chunked prefill to interleave, add replicas, or disaggregate prefill onto a separate pool. Prioritize prefill in the scheduler if the engine allows.

**Q: (Senior) Design serving for a chat product with a 20k-token shared system prompt and strict TTFT.**
A: Enable prefix caching so the 20k prompt is prefilled once and reused across all users — the dominant TTFT win. Use chunked prefill to keep decode flowing while prefilling long prompts. Pick a GQA model and consider fp8 KV cache to fit more sequences. Set high `gpu_memory_utilization`, cap per-request output, and put a low-context interactive pool separate from any long-generation batch pool. Monitor TTFT p99 and cache hit rate.

**Q: (Senior) How do you decide between scaling batch size (up) versus adding replicas (out)?**
A: Scale up first — raising batch improves per-GPU throughput and cost efficiency essentially for free until latency SLAs bind or the KV pool is full. Once further batching breaches latency targets or memory is exhausted, scale out with replicas behind a load balancer to add capacity while holding latency. Out-scaling also gives availability and lets you segment workloads (long-context vs interactive) into dedicated pools.

**Q: (Senior) What is disaggregated prefill/decode serving and why use it?**
A: It runs prefill and decode on separate GPU pools rather than interleaving them on the same devices. Because prefill is compute-bound and decode memory-bound with conflicting SLAs (TTFT vs throughput), mixing them causes long prompts to stall token streaming. Disaggregation lets each pool be sized and tuned independently — prefill GPUs optimized for burst compute, decode GPUs for large batched KV — improving both TTFT and throughput at scale.

**Q: What causes preemption in vLLM and what happens to the sequence?**
A: Preemption happens when the KV pool is exhausted and the scheduler must free memory for higher-priority or already-running work. The engine either swaps the preempted sequence's KV pages to CPU memory or discards and later recomputes them via prefill. It's a graceful degradation mechanism, but frequent preemption signals memory pressure — reduce concurrency or add capacity.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** LLM serving extracts maximum tokens/sec from expensive GPUs. Decode is memory-bound, so batching amortizes weight reads and throughput scales with batch size — capped by KV-cache memory. Continuous batching schedules per token, admitting and evicting requests every step to keep the GPU saturated instead of waiting for the slowest. PagedAttention manages KV in OS-style pages to kill fragmentation and multiply concurrency. Watch TTFT (prefill/queue-bound) and inter-token latency (decode-bound) separately; they trade off against throughput. Use vLLM/TGI/TensorRT-LLM for concurrent serving, Ollama for local. Push `gpu_memory_utilization` high, enable prefix caching for shared prompts, and scale up before scaling out.

| Metric / knob | Meaning | Lever |
|---|---|---|
| TTFT | first-token latency | admission, chunked prefill, prefix cache |
| ITL/TPOT | per-token decode speed | model size, kernels, quantization |
| throughput | total tokens/sec | batch size, utilization |
| KV cache | concurrency ceiling | PagedAttention, GQA, fp8 KV |
| max_num_seqs | batch ceiling | raise until latency binds |
| gpu_memory_utilization | VRAM for weights+KV | 0.9–0.95 |

**Flash cards**
- **Continuous batching** → schedule per token; add/evict every step to avoid straggler idle.
- **PagedAttention** → KV in fixed pages from a shared pool; block table maps them; near-zero fragmentation.
- **Throughput vs latency** → bigger batch raises throughput, raises per-user latency; can't max both.
- **TTFT driver** → prefill + queueing; fix with admission control, chunked prefill, prefix cache.
- **When to scale out** → after batch-up breaches latency SLA or KV memory is full.

## 11. Hands-On Exercises & Mini Project

- [ ] Serve a model with vLLM and measure throughput vs latency at concurrency `1, 8, 32, 64`.
- [ ] Toggle prefix caching on/off with a shared 2k-token system prompt and measure TTFT.
- [ ] Sweep `max_num_seqs` and `gpu_memory_utilization` and plot the throughput/latency frontier.
- [ ] Compare vLLM against TGI on identical hardware and a realistic prompt-length distribution.
- [ ] Induce preemption by overloading concurrency and observe the preemption/recompute counters.

**Mini Project: A Serving Cost Calculator + Load Test.**
Goal: characterize and price a production LLM endpoint.
Requirements: (1) deploy an 8B model on vLLM with an OpenAI-compatible API; (2) build a load generator with realistic prompt/response length distributions; (3) sweep concurrency and record p50/p95/p99 TTFT, inter-token latency, and tokens/sec; (4) compute cost-per-million-tokens from GPU hourly price and measured throughput.
Extensions: add prefix caching and quantify the TTFT win; add a second replica behind a round-robin balancer and show latency stability under 2× load; compare against TGI and write a one-page recommendation.

## 12. Related Topics & Free Learning Resources

Related chapters: **Quantization & Inference Optimization** (shrinking weights and KV to grow the batch), **GPU Computing & Distributed Training** (tensor parallelism for models too big for one GPU), **Fine-Tuning, LoRA & QLoRA** (multi-LoRA serving over a shared base), and **Deployment, Monitoring & Drift** (operating the endpoint in production).

**Free Learning Resources**
- **Efficient Memory Management for LLM Serving with PagedAttention** — Kwon et al. (vLLM paper) · *Advanced* · the paging design and throughput results. <https://arxiv.org/abs/2309.06180>
- **vLLM documentation** — vLLM project · *Intermediate* · deployment, scheduler tuning, prefix caching, disaggregation. <https://docs.vllm.ai>
- **How Continuous Batching Enables 23x Throughput** — Anyscale blog · *Intermediate* · clear explanation and benchmarks of in-flight batching. <https://www.anyscale.com/blog/continuous-batching-llm-inference>
- **Text Generation Inference (TGI) docs** — Hugging Face · *Intermediate* · production serving features and API. <https://huggingface.co/docs/text-generation-inference>
- **TensorRT-LLM documentation** — NVIDIA · *Advanced* · fused kernels, in-flight batching, engine build. <https://nvidia.github.io/TensorRT-LLM/>
- **LLM Inference Performance Engineering: Best Practices** — Databricks/Mosaic blog · *Intermediate* · TTFT/throughput metrics and tuning. <https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices>
- **Ollama documentation** — Ollama · *Beginner* · local single-user serving for development. <https://github.com/ollama/ollama/tree/main/docs>

---

*AI Engineering Handbook — chapter 39.*
