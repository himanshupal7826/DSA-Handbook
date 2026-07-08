# 28 · Context Windows, Tokens & Cost

> **In one line:** Everything an LLM reads and writes is measured in tokens, bounded by a finite context window, priced per token, and made fast or slow by the KV cache — so token accounting is the core of LLM cost and latency engineering.

---

## 1. Overview

Every interaction with an LLM is an exercise in **token accounting**. A *token* is the atomic unit the model processes — a subword chunk, not a word or character. The model can only "see" a bounded number of tokens at once (the **context window**), you pay per token in *and* per token out, and generation speed depends on how efficiently past tokens are reused (the **KV cache**). Understanding these four things — tokens, context window, cost, and latency — is what separates a prototype that works on one example from a production system that stays fast and affordable at scale.

The problem this chapter addresses is **resource management for a metered, bounded system**. Unlike a normal function call, an LLM call has a hard input limit, a price that scales with input and output length, and a latency that grows with the number of tokens generated. Ignore these and you get truncated prompts, surprise bills, and slow responses. Reason about them deliberately and you can fit more context, cut costs by an order of magnitude, and hit latency targets.

Historically, context windows were tiny — GPT-3 handled ~2,048 tokens. They have grown rapidly to 128K, 200K, and now 1M tokens in current flagship models, enabling entire codebases or books in a single prompt. But bigger windows aren't free: attention cost and KV-cache memory grow with sequence length, so "just stuff everything in" is often the wrong answer. Meanwhile **prompt caching** (2024) let providers reuse a fixed prefix across calls, turning repeated-context workloads from expensive to cheap.

A concrete real-world example: a support bot prepends a 20,000-token knowledge base to every user question. Without caching, each of 100,000 daily questions pays for those 20,000 input tokens — enormous and slow. With prompt caching, the knowledge base is processed once and reused at ~10% of the input price on every subsequent call, and latency drops because the prefill work is skipped. Same behavior, a fraction of the cost.

The durable mental model: **an LLM call is a metered pipe with a fixed diameter.** Tokens are the fluid, the context window is the diameter, price is per unit of fluid, and the KV cache is the mechanism that lets you not re-pump fluid you've already pushed through. Good LLM engineering is plumbing: minimize what you send, reuse what you can, and never exceed the pipe.

---

## 2. Core Concepts

- **Token** — a subword unit produced by the tokenizer; ~0.75 English words per token, but code, numbers, and non-English text tokenize less efficiently.
- **Context window** — the maximum number of tokens (input + output) the model can attend to in a single request; e.g. 200K or 1M.
- **Input (prompt) tokens** — everything you send: system prompt, history, retrieved context, and the user query.
- **Output (completion) tokens** — everything the model generates; usually priced higher than input tokens.
- **Tokenizer** — the algorithm (often BPE) that maps text ↔ token IDs; token counts are model-specific.
- **KV cache** — stored attention keys/values for processed tokens, reused so each new token is O(n) not O(n²); the main inference-speed enabler.
- **Prompt caching** — provider-side reuse of a fixed prompt *prefix* across requests, billed at a large discount, cutting cost and latency.
- **Prefill vs decode** — prefill processes the whole prompt in parallel (fast per token); decode generates output sequentially (the latency bottleneck).
- **Throughput** — tokens generated per second across all concurrent requests; a system-level capacity metric.
- **Time-to-first-token (TTFT)** — latency until the first output token, dominated by prefill and queueing.

---

## 3. Theory & Mathematical Intuition

**Cost** is a simple linear function of tokens:

```
cost = input_tokens × price_in + output_tokens × price_out
```

Output tokens are typically 3–5× the price of input tokens, so *generation length* often dominates cost even when prompts are long.

**Latency** splits into two regimes. **Prefill** processes all `P` prompt tokens in one parallel forward pass — fast, and the main driver of TTFT. **Decode** generates `G` output tokens one at a time, each requiring a forward pass, so total latency is roughly:

```
latency ≈ prefill(P) + G × per_token_decode_time
```

Because decode is sequential, output length is usually the bigger latency lever than prompt length.

**Attention** cost scales as `O(P²)` in the prompt length for the full self-attention matrix, which is why very long contexts are expensive to process and why the KV cache matters: it stores per-token keys/values so that decoding token `t` costs `O(t)` (attend to cached past) instead of recomputing everything. KV-cache **memory** grows linearly with sequence length and number of layers, and is a primary limit on how many requests you can batch and how long a context you can hold.

**Prompt caching** exploits the prefix structure: if requests share an identical leading prefix (system prompt + fixed context), its KV/prefill work is computed once and reused. Cache reads cost ~0.1× the normal input price; the invariant is strict prefix matching — a single byte change anywhere in the prefix invalidates everything after it.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="300" fill="#e0f2fe"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Prefill (parallel) vs Decode (sequential)</text>
  <text x="80" y="70" font-size="13" fill="#1e293b" font-weight="bold">Prefill: process P prompt tokens at once</text>
  <rect x="80" y="80" width="40" height="35" fill="#0ea5e9"/>
  <rect x="125" y="80" width="40" height="35" fill="#0ea5e9"/>
  <rect x="170" y="80" width="40" height="35" fill="#0ea5e9"/>
  <rect x="215" y="80" width="40" height="35" fill="#0ea5e9"/>
  <rect x="260" y="80" width="40" height="35" fill="#0ea5e9"/>
  <text x="320" y="103" font-size="12" fill="#1e293b">→ one parallel pass (fast, sets TTFT)</text>
  <text x="80" y="165" font-size="13" fill="#1e293b" font-weight="bold">Decode: generate G output tokens one by one</text>
  <rect x="80" y="175" width="40" height="35" fill="#16a34a"/>
  <text x="128" y="198" font-size="18" fill="#16a34a">→</text>
  <rect x="150" y="175" width="40" height="35" fill="#16a34a"/>
  <text x="198" y="198" font-size="18" fill="#16a34a">→</text>
  <rect x="220" y="175" width="40" height="35" fill="#16a34a"/>
  <text x="268" y="198" font-size="18" fill="#16a34a">→</text>
  <rect x="290" y="175" width="40" height="35" fill="#16a34a"/>
  <text x="360" y="198" font-size="12" fill="#1e293b">each step reuses the KV cache (O(n) not O(n²))</text>
  <rect x="80" y="235" width="500" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="330" y="260" text-anchor="middle" font-size="12" fill="#1e293b">Output length drives latency &amp; cost more than prompt length does</text>
</svg>
```

---

## 4. Architecture & Workflow

Reasoning about a request's cost and latency follows a repeatable workflow:

1. **Count the input tokens** — sum system prompt + conversation history + retrieved context + user query using the model's tokenizer (not a word count).
2. **Check against the context window** — ensure input + expected output ≤ window; if not, trim history, chunk, or summarize.
3. **Estimate output tokens** — set `max_tokens` realistically; over-large caps waste budget headroom, too-small caps truncate.
4. **Identify the cacheable prefix** — the stable, repeated part (system prompt, fixed instructions, long reference docs) that many requests share.
5. **Place the cache boundary** — mark the end of the stable prefix so the volatile suffix (the user's specific query) sits after it.
6. **Send the request** — provider prefills (using cache if the prefix hits), then decodes output autoregressively.
7. **Read `usage`** — inspect `input_tokens`, `output_tokens`, and cache read/write counts to verify the cache is working and to attribute cost.
8. **Optimize** — trim redundant context, compress history (summarize old turns), route easy queries to cheaper models, and stream output to hide decode latency.

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="320" fill="#eef2ff"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Request Budget: prefix caching layout</text>
  <rect x="50" y="60" width="560" height="55" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="330" y="82" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">Stable prefix (cacheable)</text>
  <text x="330" y="102" text-anchor="middle" font-size="11" fill="#1e293b">system prompt · fixed instructions · long reference docs</text>
  <line x1="50" y1="130" x2="610" y2="130" stroke="#d97706" stroke-width="2" stroke-dasharray="6"/>
  <text x="330" y="147" text-anchor="middle" font-size="11" fill="#d97706" font-weight="bold">◄ cache breakpoint ►</text>
  <rect x="50" y="160" width="560" height="45" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="330" y="187" text-anchor="middle" font-size="12" fill="#1e293b">Volatile suffix: this user's specific query (never cached)</text>
  <rect x="50" y="225" width="270" height="55" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="185" y="248" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">First call</text>
  <text x="185" y="267" text-anchor="middle" font-size="11" fill="#1e293b">writes cache (~1.25× prefix)</text>
  <rect x="340" y="225" width="270" height="55" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="475" y="248" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">Later calls</text>
  <text x="475" y="267" text-anchor="middle" font-size="11" fill="#1e293b">read cache (~0.1× prefix)</text>
  <text x="330" y="305" text-anchor="middle" font-size="11" fill="#64748b">Any byte change in the prefix invalidates the cache after that point</text>
</svg>
```

---

## 5. Implementation

Always count tokens with the model's own tokenizer, not a word estimate. The Anthropic API exposes a token-counting endpoint:

```python
import anthropic

client = anthropic.Anthropic()

count = client.messages.count_tokens(
    model="claude-sonnet-4",
    system="You are a helpful assistant.",
    messages=[{"role": "user", "content": open("long_doc.txt").read()}],
)
print("input tokens:", count.input_tokens)

# Rough cost estimate (illustrative prices per 1M tokens)
PRICE_IN, PRICE_OUT = 3.00, 15.00   # $ per 1M tokens
est_input_cost = count.input_tokens / 1_000_000 * PRICE_IN
print(f"estimated input cost: ${est_input_cost:.4f}")
```

Prompt caching: mark the stable prefix so repeated calls reuse it. Put the large, fixed reference material in `system` with a cache breakpoint, and the varying question in `messages`:

```python
resp = client.messages.create(
    model="claude-opus-4",
    max_tokens=512,
    system=[
        {
            "type": "text",
            "text": KNOWLEDGE_BASE,            # large, stable prefix
            "cache_control": {"type": "ephemeral"},
        }
    ],
    messages=[{"role": "user", "content": "What is the refund window?"}],
)

u = resp.usage
print("input:", u.input_tokens,
      "output:", u.output_tokens,
      "cache_write:", u.cache_creation_input_tokens,
      "cache_read:", u.cache_read_input_tokens)
# First call:  cache_write large, cache_read 0
# Later calls: cache_write 0, cache_read large (≈0.1× price)
```

Compressing conversation history to stay under budget — summarize old turns so the window doesn't overflow:

```python
def trim_history(messages, budget_tokens, client, model):
    """Summarize the oldest turns when total tokens exceed budget."""
    total = client.messages.count_tokens(model=model, messages=messages).input_tokens
    if total <= budget_tokens:
        return messages
    head, tail = messages[:-4], messages[-4:]           # keep recent 4 turns verbatim
    summary = client.messages.create(
        model=model, max_tokens=300,
        messages=[{"role": "user",
                   "content": "Summarize this conversation concisely:\n" + str(head)}],
    ).content[0].text
    return [{"role": "user", "content": f"[Earlier summary] {summary}"}] + tail
```

**Optimization note:** The highest-leverage moves, in order: (1) cache the stable prefix — often a 5–10× cost cut for repeated-context workloads; (2) shorten output with a tight `max_tokens` and a "be concise" instruction, since output tokens are the priciest and slowest; (3) route easy requests to a cheaper model; (4) retrieve only the *relevant* chunks (see RAG) instead of dumping whole documents into the window.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Large context window | Fit whole docs/codebases in one call | Higher per-call cost; attention cost grows with length |
| Prompt caching | 5–10× cheaper, faster for repeated prefix | Fragile — any prefix byte change invalidates it |
| Big `max_tokens` | Room for long answers | Wasted budget; longer decode = higher latency & cost |
| Long history in context | Model "remembers" the conversation | Grows cost every turn; may push out early content |
| Streaming | Better perceived latency (early tokens) | More complex client handling |
| Cheaper model routing | Big cost savings on easy tasks | Quality drop if routing misjudges difficulty |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Estimating cost/limits by word or character count → ✅ Count actual tokens with the model's tokenizer; code and numbers tokenize far less efficiently than prose.
2. ⚠️ Assuming a 200K window is "free" to fill → ✅ Every token in the prompt is paid and processed; retrieve only what's relevant.
3. ⚠️ Interpolating timestamps/UUIDs into a cached prefix → ✅ Keep the cached prefix byte-stable; put volatile values after the cache boundary.
4. ⚠️ Setting `max_tokens` far higher than needed → ✅ Set it to a realistic ceiling; output tokens dominate cost and latency.
5. ⚠️ Letting conversation history grow unbounded → ✅ Trim or summarize old turns to cap per-turn cost and avoid window overflow.
6. ⚠️ Ignoring the `usage` object → ✅ Log input/output and cache read/write tokens on every call to verify caching and attribute cost.
7. ⚠️ Using the flagship model for trivial tasks → ✅ Route classification/extraction to a cheaper model; reserve the big model for hard reasoning.
8. ⚠️ Silently truncating input that overflows the window → ✅ Detect the overflow and chunk/summarize deliberately instead of losing content.
9. ⚠️ Treating prompt and output cost as equal → ✅ Output is usually 3–5× the input price; optimizing output length has outsized impact.
10. ⚠️ Blaming the model for slow responses → ✅ Latency scales with output length; shorten answers, stream, and cache the prefix.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a request errors on length, count the fully-assembled prompt's tokens — the overflow is usually accumulated history or an oversized retrieved chunk, not the user's message. If caching isn't reducing cost, log `cache_read_input_tokens`: if it's persistently zero across identical-prefix calls, a silent invalidator (a timestamp, unsorted JSON, a varying tool list) is breaking the prefix match. Reproduce with the exact bytes you sent.

**Monitoring.** Track per-request input/output tokens, cache hit rate (`cache_read / (cache_read + cache_creation)`), cost per request and per feature, TTFT, and end-to-end latency percentiles. Alert on cost spikes (often runaway history growth) and on cache-hit-rate drops after a deploy (a prompt-template change may have shifted the prefix).

**Security.** Token limits are a denial-of-service and cost vector: an attacker submitting huge inputs can exhaust your budget or hit rate limits. Enforce input-size caps before calling the model, rate-limit per user, and validate that untrusted content fits your context budget. Never let user input silently balloon the prompt.

**Scaling.** Throughput is bounded by KV-cache memory (fewer/longer requests fit) and decode speed. Scale by batching requests, caching shared prefixes across users, keeping outputs short, routing by difficulty, and using streaming to keep users engaged during decode. For very high volume, batch/async APIs process non-latency-sensitive work at a discount.

---

## 9. Interview Questions

**Q: What is a token, and why can't you use word count to estimate limits or cost?**
A: A token is a subword unit produced by the tokenizer, roughly 0.75 English words on average — but code, numbers, punctuation, and non-English text tokenize much less efficiently. Cost and context limits are measured in tokens, so a word- or character-based estimate can be off by a large and unpredictable factor. Always count with the model's tokenizer.

**Q: What is the context window and what happens if you exceed it?**
A: It's the maximum number of tokens (input plus output) the model can attend to in one request. Exceeding it causes an error or forces truncation, silently dropping content. You handle it by trimming history, summarizing, or chunking so the prompt plus expected output fits.

**Q: Why does output length affect latency more than input length?**
A: Input is processed in a single parallel prefill pass, but output is generated sequentially — one forward pass per token — because each token depends on the previous ones. So latency scales roughly linearly with the number of output tokens, while a long prompt is prefilled quickly. Shortening output is the bigger latency lever.

**Q: What is the KV cache and why does it matter?**
A: During decoding, the attention keys and values for already-processed tokens don't change, so they're cached and reused. This makes generating each new token O(n) instead of O(n²) recomputation, which is what makes inference tractable. Its memory footprint also limits batch size and maximum context length.

**Q: What is prompt caching and how much does it save?**
A: Prompt caching reuses the prefill/KV work for an identical prompt *prefix* across requests, billing cache reads at roughly 10% of the normal input price. For workloads that prepend a large fixed context (a knowledge base, long instructions) to every call, it can cut input cost 5–10× and reduce latency by skipping prefill.

**Q: Why can prompt caching silently stop working?**
A: It requires an exact prefix match — a single byte change anywhere in the cached prefix invalidates everything after it. Common culprits are a `datetime.now()` or UUID in the system prompt, non-deterministic JSON serialization, or a changing tool list. If `cache_read_input_tokens` is zero across identical-looking calls, hunt for a silent invalidator.

**Q: (Senior) How would you cut the cost of a high-volume RAG chatbot by an order of magnitude?**
A: Cache the stable prefix (system prompt + fixed instructions), retrieve only the top-k relevant chunks instead of whole documents, cap `max_tokens` and instruct concise answers (output is the priciest tokens), summarize old conversation turns to bound history growth, and route simple queries to a cheaper model. Prefix caching plus tight retrieval usually delivers the biggest single win.

**Q: (Senior) What limits how many concurrent requests you can serve on a GPU?**
A: Primarily KV-cache memory — each active request holds keys/values for all its tokens across all layers, growing linearly with sequence length. Longer contexts and more concurrent requests compete for the same GPU memory, so throughput is a tradeoff between batch size, context length, and available memory. Decode speed (sequential per-token work) is the other bound.

**Q: (Senior) When should you use a batch/async API over the real-time one?**
A: For large, non-latency-sensitive workloads — bulk classification, embedding generation, offline enrichment — where you can tolerate minutes-to-hours turnaround. Batch APIs typically process at a significant discount (often ~50%), trading immediacy for cost. Keep real-time APIs for user-facing, interactive requests.

**Q: How do prefill and decode differ, and which sets time-to-first-token?**
A: Prefill processes the entire prompt in one parallel forward pass and is what you wait through before the first output token, so it dominates TTFT (along with queueing). Decode then emits output tokens one at a time. TTFT is mostly prefill; total latency is prefill plus decode, and decode scales with output length.

**Q: You're told a 200K-context model "fixes" a truncation problem. Any caveats?**
A: A bigger window lets you fit more, but every token is still paid for and processed, attention cost grows with length, and stuffing irrelevant content can dilute the model's focus ("lost in the middle"). Prefer retrieving relevant chunks over dumping everything in; use the large window deliberately, not as a default.

**Q: Why are output tokens usually more expensive than input tokens?**
A: Generating output is sequential and compute-bound (one forward pass per token) while input is prefilled in parallel, so providers price output tokens higher — often 3–5×. This is why minimizing output length has outsized impact on both cost and latency.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Tokens are subword units; count them with the model's tokenizer, never by words. The context window bounds input+output. Cost = input×price_in + output×price_out, with output ~3–5× pricier. Latency = prefill (parallel, sets TTFT) + decode (sequential, scales with output length). The KV cache makes decode O(n); prompt caching reuses a stable prefix at ~0.1× input price but breaks on any prefix byte change. To optimize: cache the prefix, retrieve only relevant context, cap output length, trim/summarize history, and route easy queries to cheaper models. Always log the `usage` object.

| Lever | Effect |
|---|---|
| Prompt caching | 5–10× cheaper repeated prefix |
| Short output / max_tokens | Lower cost + latency |
| Retrieve relevant chunks | Smaller, focused prompts |
| Summarize old history | Bounds per-turn growth |
| Cheaper-model routing | Big savings on easy tasks |
| Streaming | Better perceived latency |

Flash cards:
- **What sets time-to-first-token?** → Prefill (processing the prompt).
- **Why is output pricier than input?** → Sequential decode vs parallel prefill.
- **What breaks prompt caching?** → Any byte change in the cached prefix.
- **How to check caching works?** → `cache_read_input_tokens` in `usage`.
- **Biggest cost lever for repeated context?** → Prompt caching the stable prefix.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Tokenize the same 100-word passage in English prose, JSON, and Python code; compare token counts and explain the differences.
- [ ] Use the token-counting endpoint to estimate the cost of a request before sending it.
- [ ] Send the same large-prefix prompt twice with caching enabled and confirm `cache_read_input_tokens` jumps on the second call.
- [ ] Deliberately break caching by inserting a timestamp into the prefix and observe the cache read drop to zero.
- [ ] Measure latency at `max_tokens=50` vs `max_tokens=1000` for the same prompt and relate the difference to sequential decode.

**Mini Project — Token & cost dashboard.**
*Goal:* A wrapper around the Messages API that logs, per request, input/output tokens, cache read/write tokens, estimated cost, and latency, and renders a running summary.
*Requirements:* Count tokens before sending; enable prompt caching on a fixed system prefix; parse the `usage` object after each call; compute cost from a configurable price table; report cache hit rate and total spend.
*Extension ideas:* Add automatic history summarization when the conversation exceeds a token budget; add difficulty-based model routing and show the cost delta; add a batch mode for offline jobs and compare its cost to real-time.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **How LLMs Work** (where tokens and the KV cache come from), **Decoding & Sampling** (output length is decoding-driven), **Prompt Engineering** (budgeting few-shot examples), and **Retrieval-Augmented Generation** (retrieving only relevant context to shrink prompts).

**Free Learning Resources**
- **Anthropic Docs: Token counting & Pricing** — Anthropic · *Beginner* · the `count_tokens` endpoint, context windows, and per-model prices. <https://docs.claude.com/en/docs/build-with-claude/token-counting>
- **Anthropic Docs: Prompt Caching** — Anthropic · *Intermediate* · how to place cache breakpoints and verify hits. <https://docs.claude.com/en/docs/build-with-claude/prompt-caching>
- **Efficient Memory Management for LLM Serving (PagedAttention / vLLM)** — Kwon et al. · *Advanced* · how KV-cache memory governs serving throughput. <https://arxiv.org/abs/2309.06180>
- **Let's build the GPT Tokenizer** — Andrej Karpathy · *Intermediate* · builds BPE tokenization from scratch; explains why token counts vary. <https://www.youtube.com/watch?v=zduSFxRajkE>
- **Lost in the Middle: How Language Models Use Long Contexts** — Liu et al. · *Advanced* · why filling a big window isn't automatically better. <https://arxiv.org/abs/2307.03172>
- **Hugging Face: Tokenizers** — Hugging Face Docs · *Beginner* · practical tokenization and counting. <https://huggingface.co/docs/tokenizers/index>

---

*AI Engineering Handbook — chapter 28.*
