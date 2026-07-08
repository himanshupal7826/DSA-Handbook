# 25 · How LLMs Work: Pretraining to Inference

> **In one line:** A large language model is a next-token predictor trained on trillions of tokens, then shaped by supervised fine-tuning and RLHF into a helpful assistant.

---

## 1. Overview

A **large language model (LLM)** is a neural network that models the probability of the next token given all the tokens before it: `P(token_t | token_1 … token_{t-1})`. That single objective — *predict what comes next* — is deceptively simple, yet scaling it to hundreds of billions of parameters and trillions of training tokens produces a system that can translate, summarize, write code, reason through multi-step problems, and hold a conversation.

The problem LLMs solve is **general-purpose language competence without task-specific engineering**. Before 2018, every NLP task (sentiment, translation, question answering) needed its own labeled dataset and bespoke model. The insight behind modern LLMs is that a model trained only to predict text learns grammar, facts, world knowledge, and even reasoning patterns *as a side effect* — because to predict the next word in "The capital of France is ___" you must have learned geography. This is **transfer learning at scale**: one pretraining run, then light adaptation for many downstream tasks.

Historically the lineage runs from word2vec embeddings (2013) → the Transformer architecture (Vaswani et al., 2017) → GPT-1/2/3 scaling the decoder-only Transformer → InstructGPT (2022) adding human-feedback alignment → the current generation of chat assistants like Claude and GPT-4. The architectural constant since 2017 is the Transformer; the variable is scale and alignment technique.

A concrete real-world example: when you type "Write a Python function to reverse a linked list" into a chat model, three things happen. The **tokenizer** splits your text into subword tokens; the **Transformer** processes them and produces a probability distribution over the next token; a **decoding loop** samples tokens one at a time, feeding each back in, until it emits a stop token. The "intelligence" you perceive is billions of learned weights turning your prompt into a trajectory through token space that happens to be correct, runnable code.

The durable mental model: **an LLM is a compression of the internet's text into a function that continues any prompt plausibly**, refined by human feedback to continue prompts *helpfully and safely* rather than merely plausibly.

---

## 2. Core Concepts

- **Token** — the atomic unit an LLM reads and writes; a subword chunk (e.g. `"un"`, `"believ"`, `"able"`) produced by a tokenizer like Byte-Pair Encoding. Roughly 0.75 words per token in English.
- **Autoregressive generation** — producing output one token at a time, where each new token is conditioned on all previously generated tokens.
- **Pretraining** — the first, most expensive phase: self-supervised next-token prediction over a massive unlabeled text corpus.
- **Self-supervised learning** — training where the labels come free from the data itself (the "label" for each position is simply the actual next token), so no human annotation is required.
- **Parameters (weights)** — the learned numbers inside the network; model "size" (e.g. 70B) counts these.
- **Scaling laws** — empirical power-law relationships showing loss decreases predictably as parameters, data, and compute increase together.
- **SFT (Supervised Fine-Tuning)** — training the pretrained model on curated prompt→response demonstrations to teach it the *assistant* format.
- **RLHF (Reinforcement Learning from Human Feedback)** — using human preference rankings to train a reward model, then optimizing the LLM against it to make outputs more helpful and harmless.
- **Emergence** — capabilities (arithmetic, chain-of-thought) that appear only above a certain scale and are absent in smaller models.
- **Inference** — running a trained model to generate output; cheap per-query relative to training but the dominant cost at production scale.

---

## 3. Theory & Mathematical Intuition

The training objective is **maximum likelihood** over the corpus. For a sequence of tokens `x_1 … x_n`, the model maximizes the log-probability of each token given its predecessors:

```
Loss = - Σ_t log P(x_t | x_1, ..., x_{t-1}; θ)
```

This is the **cross-entropy loss** averaged over every position. Because the loss is defined at every token, a single 2,000-token document yields 2,000 training signals — this density is why self-supervised pretraining is so data-efficient.

The model outputs a **logit vector** of size `|vocab|` (often 50k–130k) per position. Softmax turns logits into a probability distribution:

```
P(token_i) = e^{logit_i} / Σ_j e^{logit_j}
```

**Scaling laws** (Kaplan et al. 2020; Hoffmann et al. "Chinchilla" 2022) show test loss `L` follows a power law in compute `C`, parameters `N`, and data `D`:

```
L(N) ≈ (N_c / N)^α      with α ≈ 0.076
```

Chinchilla's correction: for a fixed compute budget, you should scale parameters and tokens *together* (~20 tokens per parameter), not just parameters. This is why a well-trained 70B model can beat an under-trained 175B one.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="300" fill="#f0fdf4"/>
  <text x="320" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Scaling Laws: Loss vs Compute (log-log)</text>
  <line x1="80" y1="250" x2="600" y2="250" stroke="#1e293b" stroke-width="2"/>
  <line x1="80" y1="60" x2="80" y2="250" stroke="#1e293b" stroke-width="2"/>
  <text x="340" y="285" text-anchor="middle" font-size="13" fill="#1e293b">Training compute (FLOPs, log scale)</text>
  <text x="30" y="160" text-anchor="middle" font-size="13" fill="#1e293b" transform="rotate(-90 30 160)">Test loss (log)</text>
  <path d="M 100 90 Q 300 200 590 235" fill="none" stroke="#16a34a" stroke-width="3"/>
  <circle cx="140" cy="120" r="5" fill="#d97706"/>
  <text x="150" y="115" font-size="12" fill="#1e293b">small model</text>
  <circle cx="340" cy="185" r="5" fill="#d97706"/>
  <text x="350" y="180" font-size="12" fill="#1e293b">mid model</text>
  <circle cx="560" cy="230" r="5" fill="#d97706"/>
  <text x="430" y="222" font-size="12" fill="#1e293b">large, well-trained</text>
  <text x="330" y="130" font-size="12" fill="#16a34a">predictable power-law descent</text>
</svg>
```

The key takeaway: loss improvement is **smooth and predictable**, but downstream *capabilities* often appear as sharp jumps (emergence) — a smooth loss curve masks discontinuous ability gains.

---

## 4. Architecture & Workflow

The dominant architecture is the **decoder-only Transformer**. Here is the end-to-end flow from raw text to a fully aligned chat model:

1. **Tokenize** the input text into integer token IDs using a BPE tokenizer.
2. **Embed** each token ID into a dense vector, then add **positional information** (via RoPE or learned positions) so the model knows token order.
3. **Stack of Transformer blocks** — each block runs **masked self-attention** (every token attends to prior tokens only) followed by a **feed-forward network**, wrapped in residual connections and layer normalization. Modern models stack 32–120 such blocks.
4. **Unembed** the final layer's hidden state at each position into logits over the vocabulary.
5. **Pretrain** by minimizing cross-entropy over trillions of tokens (weeks on thousands of GPUs).
6. **SFT** on tens of thousands of high-quality prompt→response demonstrations to teach the instruction-following format.
7. **Train a reward model** on human preference pairs (given a prompt and two responses, which is better?).
8. **RLHF / preference optimization** — fine-tune the SFT model with PPO (or DPO) to maximize the reward model's score while staying close to the SFT distribution.
9. **Deploy for inference** — the aligned model serves requests via autoregressive decoding.

```svg
<svg viewBox="0 0 660 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="360" fill="#eef2ff"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Pretrain → SFT → RLHF Pipeline</text>
  <rect x="40" y="60" width="150" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="115" y="90" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">Pretraining</text>
  <text x="115" y="110" text-anchor="middle" font-size="11" fill="#1e293b">trillions of tokens</text>
  <rect x="255" y="60" width="150" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="330" y="90" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">SFT</text>
  <text x="330" y="110" text-anchor="middle" font-size="11" fill="#1e293b">demonstrations</text>
  <rect x="470" y="60" width="150" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="545" y="90" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">RLHF</text>
  <text x="545" y="110" text-anchor="middle" font-size="11" fill="#1e293b">preference tuning</text>
  <line x1="190" y1="95" x2="253" y2="95" stroke="#4f46e5" stroke-width="2" marker-end="url(#a25)"/>
  <line x1="405" y1="95" x2="468" y2="95" stroke="#4f46e5" stroke-width="2" marker-end="url(#a25)"/>
  <rect x="40" y="180" width="580" height="60" rx="8" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="330" y="205" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">Base model: raw text continuation</text>
  <text x="330" y="225" text-anchor="middle" font-size="11" fill="#1e293b">knows facts &amp; grammar, but not how to be an assistant</text>
  <rect x="40" y="270" width="580" height="60" rx="8" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="330" y="295" text-anchor="middle" font-size="12" fill="#1e293b" font-weight="bold">Aligned model: helpful, honest, harmless assistant</text>
  <text x="330" y="315" text-anchor="middle" font-size="11" fill="#1e293b">follows instructions, refuses unsafe requests, formats replies</text>
  <line x1="115" y1="130" x2="200" y2="178" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <line x1="545" y1="130" x2="460" y2="268" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <defs>
    <marker id="a25" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

---

## 5. Implementation

You rarely pretrain an LLM yourself, but you *do* interact with one via inference. Here is the core autoregressive loop, first with Hugging Face Transformers to show the mechanics, then via the Anthropic Messages API for production.

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("gpt2")
model = AutoModelForCausalLM.from_pretrained("gpt2")
model.eval()

prompt = "The capital of France is"
inputs = tokenizer(prompt, return_tensors="pt")

# Manual autoregressive loop — one token at a time
generated = inputs["input_ids"]
for _ in range(5):
    with torch.no_grad():
        logits = model(generated).logits          # (batch, seq, vocab)
    next_token_logits = logits[:, -1, :]           # last position only
    next_id = next_token_logits.argmax(dim=-1, keepdim=True)  # greedy
    generated = torch.cat([generated, next_id], dim=-1)

print(tokenizer.decode(generated[0]))
# The capital of France is Paris, and the city is
```

Inspecting the next-token distribution makes the probabilistic nature concrete:

```python
import torch.nn.functional as F

probs = F.softmax(next_token_logits, dim=-1)
top = torch.topk(probs, 5)
for p, idx in zip(top.values[0], top.indices[0]):
    print(f"{tokenizer.decode([idx]):>12}  {p.item():.3f}")
#         Paris  0.812
#           the  0.041
#      Marseille 0.017
#          home  0.011
#          also  0.009
```

In production you call a hosted, aligned model rather than running weights locally. The **Anthropic Messages API** shape:

```python
import anthropic

client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

response = client.messages.create(
    model="claude-opus-4",
    max_tokens=1024,
    system="You are a concise technical tutor.",
    messages=[
        {"role": "user", "content": "In one sentence, what is next-token prediction?"}
    ],
)
print(response.content[0].text)
print(response.usage.input_tokens, response.usage.output_tokens)
```

**Optimization note:** The single biggest inference optimization is the **KV cache** — attention keys and values for already-processed tokens are stored and reused, so generating token N is O(N) not O(N²). Without it, each new token would reprocess the entire prefix. Batching, quantization (INT8/FP8), and speculative decoding stack on top to raise throughput further.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Generality | One model, many tasks — no per-task training | Jack of all trades; a fine-tuned small model can beat it on a narrow task |
| Self-supervision | No human labels needed for pretraining | Requires trillions of tokens and massive compute |
| Emergent ability | Reasoning, in-context learning appear at scale | Unpredictable; you can't schedule when a capability emerges |
| Fluency | Human-quality text generation | Fluency ≠ truth — confident hallucinations |
| Transfer | Few-shot/zero-shot adaptation via prompting | Prompt sensitivity; brittle to phrasing |
| Alignment (RLHF) | Helpful, safer, formatted outputs | Can induce sycophancy and reduced diversity ("alignment tax") |
| Inference cost | Cheap per token vs training | Dominant recurring cost at scale; latency grows with output length |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Treating the model as a database of facts → ✅ Treat it as a *plausible continuation engine*; verify factual claims and use retrieval for ground truth.
2. ⚠️ Assuming bigger is always better → ✅ Per Chinchilla, match data to parameters; a right-sized, well-trained model often wins on cost and quality.
3. ⚠️ Confusing the base model with the chat model → ✅ Remember the assistant behavior comes from SFT+RLHF layered on the base; base models just continue text.
4. ⚠️ Ignoring tokenization → ✅ Count *tokens*, not words or characters, when reasoning about limits and cost (numbers and code tokenize inefficiently).
5. ⚠️ Expecting deterministic output → ✅ Generation is sampled; set temperature to 0 (or use greedy) when you need reproducibility, and even then hardware nondeterminism can vary.
6. ⚠️ Over-trusting RLHF alignment → ✅ RLHF reduces but does not eliminate harmful or false outputs; keep guardrails and human review for high-stakes use.
7. ⚠️ Fine-tuning when prompting would do → ✅ Try few-shot prompting and retrieval first; fine-tuning is expensive and can degrade general ability.
8. ⚠️ Forgetting the context window is finite → ✅ Budget tokens; long prompts silently push out earlier content or raise cost quadratically in attention.
9. ⚠️ Reading "emergence" as magic → ✅ It's a measurement artifact of sharp metrics on smooth loss; useful to know but not mystical.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When output is wrong, first inspect the exact tokens sent (including system prompt and any injected context) — most "model" bugs are prompt-assembly bugs. Log `usage.input_tokens` / `usage.output_tokens` and the `stop_reason` (`end_turn`, `max_tokens`, `refusal`). A truncated answer with `stop_reason == "max_tokens"` means raise `max_tokens`, not "the model is dumb."

**Monitoring.** Track token throughput, p50/p95 latency (which scales with output length), cost per request, and refusal/error rates. Sample outputs for quality regression whenever you change prompts or model versions — a model upgrade can shift behavior even with identical prompts.

**Security.** LLMs are vulnerable to **prompt injection**: untrusted text in the context can hijack instructions. Never concatenate untrusted user data into a trusted system prompt without isolation, and never give a model tool access it could misuse on injected instructions. Treat model output as untrusted input to downstream systems (sanitize before executing generated code or SQL).

**Scaling.** Inference cost is dominated by the KV cache memory and the sequential decode loop. Scale with request batching, prompt caching (reuse of a fixed prefix across requests), model routing (cheap model for easy queries, flagship for hard ones), and streaming responses to improve perceived latency. Choose the smallest model that meets your quality bar — e.g. route bulk classification to `claude-sonnet-4` and reserve `claude-opus-4` for hard reasoning.

---

## 9. Interview Questions

**Q: What is the training objective of a base LLM?**
A: Next-token prediction via maximum likelihood: minimize the cross-entropy between the model's predicted distribution and the actual next token, summed over every position in the corpus. It is self-supervised, so no human labels are needed — the label for each position is simply the observed next token.

**Q: Why does predicting the next word teach a model facts and reasoning?**
A: To assign high probability to the correct continuation of arbitrary text, the model must implicitly learn grammar, world knowledge, and the relationships in the data. Predicting "The chemical symbol for gold is ___" correctly requires having learned chemistry. Compressing the corpus well *is* learning its structure.

**Q: What is the difference between a base model and a chat model?**
A: A base model only continues text in the style of its training data — it has no notion of being a helpful assistant. The chat model is that base model after SFT (teaching the instruction-response format) and RLHF (aligning to human preferences), which is what makes it follow instructions, format answers, and refuse unsafe requests.

**Q: Explain the three stages of the modern LLM training pipeline.**
A: (1) Pretraining — self-supervised next-token prediction over trillions of tokens, producing broad competence. (2) SFT — supervised fine-tuning on curated prompt→response demonstrations to teach assistant behavior. (3) RLHF — train a reward model on human preference rankings, then optimize the policy against it (PPO or DPO) to make outputs more helpful and harmless.

**Q: What are scaling laws and why do they matter?**
A: Scaling laws are empirical power-law relationships showing test loss decreases predictably as parameters, data, and compute increase. They matter because they let you forecast the performance of a larger run before spending the compute, and (via Chinchilla) they tell you the compute-optimal ratio of data to parameters — roughly 20 tokens per parameter.

**Q: What is the KV cache and why is it essential?**
A: During autoregressive decoding, the attention keys and values for already-processed tokens don't change, so they're cached and reused. This turns per-token generation from O(sequence²) recomputation into O(sequence) work, making inference tractable. The cache's memory footprint is a primary constraint on batch size and context length.

**Q: (Senior) Why does Chinchilla say a smaller model can outperform a larger one?**
A: For a fixed compute budget, Kaplan-era models over-invested in parameters and under-trained on data. Chinchilla showed loss is minimized by scaling parameters and tokens together (~20:1). An under-trained 175B model wastes capacity it never learned to use, so a fully-trained 70B model can match or beat it — at far lower inference cost, which compounds in production.

**Q: (Senior) What is emergence, and is it real or an artifact?**
A: Emergence describes capabilities absent in small models that appear abruptly above some scale (e.g. multi-digit arithmetic, chain-of-thought). The underlying pretraining loss improves smoothly; the *appearance* of discontinuity is largely an artifact of using sharp, all-or-nothing metrics (exact match) on a smoothly improving capability. It's practically important for planning but not evidence of a phase transition in the loss.

**Q: (Senior) What is the "alignment tax" of RLHF?**
A: RLHF optimizes toward human-preferred responses, which can reduce output diversity, induce sycophancy (telling users what they want to hear), and slightly degrade raw capability on some benchmarks versus the SFT model. The KL penalty to the SFT policy limits drift but doesn't eliminate the tradeoff — you buy helpfulness and safety at some cost in calibration and diversity.

**Q: How would you make an LLM's factual answers more reliable?**
A: Ground it with retrieval-augmented generation so answers cite real documents, lower temperature for factual tasks, ask for citations or source quotes you can verify, and add a verification pass or tool call for high-stakes claims. Fine-tuning on domain data helps format and terminology but does not reliably fix factual grounding — retrieval does.

**Q: Why is generation sequential and what does that imply for latency?**
A: Each token depends on all previous tokens, so decoding is inherently sequential — you can't produce token N+1 until token N exists. Latency therefore scales with the number of output tokens, and streaming is used to improve perceived latency. Prefill (processing the prompt) is parallel and fast; decode is the slow part.

**Q: (Senior) How do PPO-based RLHF and DPO differ?**
A: Classic RLHF trains an explicit reward model then optimizes the policy with PPO against it, requiring an online RL loop. DPO (Direct Preference Optimization) reparameterizes the same objective so you optimize directly on preference pairs with a simple classification-style loss — no separate reward model or RL loop — which is more stable and cheaper, at some cost in flexibility.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** An LLM predicts the next token: `P(x_t | x_{<t})`, trained by minimizing cross-entropy over trillions of tokens (pretraining). Scaling laws make loss predictable; Chinchilla says balance data and parameters ~20:1. Capabilities can emerge sharply. A raw base model only continues text; SFT teaches the assistant format and RLHF aligns it to human preferences to make a chat model. Inference is autoregressive and sequential, made fast by the KV cache. Fluency is not truth — hallucination and prompt injection are the standing risks.

| Concept | One-liner |
|---|---|
| Objective | Minimize cross-entropy of next token |
| Pretraining | Self-supervised, no labels, trillions of tokens |
| SFT | Demonstrations teach instruction-following |
| RLHF | Preference model + PPO/DPO → alignment |
| Scaling law | Loss ∝ compute^(−α), predictable |
| Chinchilla | ~20 tokens per parameter is compute-optimal |
| KV cache | Reuse past keys/values → O(n) decode |

Flash cards:
- **What loss does pretraining minimize?** → Cross-entropy of next-token prediction.
- **What turns a base model into an assistant?** → SFT + RLHF.
- **What does Chinchilla recommend?** → Scale data and parameters together (~20:1 tokens per param).
- **Why is decoding slow?** → It's sequential; each token depends on all prior tokens.
- **What makes decode O(n) instead of O(n²)?** → The KV cache.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Load `gpt2` with Transformers and print the top-5 next-token probabilities for three different prompts; observe how confidence varies.
- [ ] Implement greedy decoding manually (as in §5) and compare its output to `model.generate()`.
- [ ] Tokenize the same sentence in English, Python code, and a long number; compare token counts and explain the differences.
- [ ] Call the Messages API with the same prompt at `max_tokens=10` and `max_tokens=500`; inspect `stop_reason` in each case.
- [ ] Write a prompt that makes a chat model confidently state a false fact, then rewrite it with a retrieval instruction that fixes it.

**Mini Project — Build a "next-word predictor" demo.**
*Goal:* A small CLI that, given a prompt, shows a live bar chart of the top-10 next-token probabilities and lets the user pick a token to append, then repeats — making autoregressive generation tangible.
*Requirements:* Use `gpt2` (CPU-friendly); display token strings and probabilities; support both "auto (greedy)" and "manual pick" modes; print the running token count.
*Extension ideas:* Add a temperature slider and show how the distribution flattens; add top-p filtering; swap in a larger model and compare the sharpness of predictions.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **Decoding & Sampling** (how logits become text), **Prompt Engineering** (steering the aligned model), **Context Windows, Tokens & Cost** (the accounting), and **Retrieval-Augmented Generation** (fixing factual grounding).

**Free Learning Resources**
- **Let's build GPT: from scratch, in code** — Andrej Karpathy · *Intermediate* · builds a working Transformer LM line by line; the single best hands-on intro. <https://www.youtube.com/watch?v=kCc8FmEb1nY>
- **The Illustrated Transformer** — Jay Alammar · *Beginner* · clearest visual explanation of attention and the Transformer block. <https://jalammar.github.io/illustrated-transformer/>
- **Attention Is All You Need** — Vaswani et al. · *Advanced* · the original Transformer paper; read it once you have the intuition. <https://arxiv.org/abs/1706.03762>
- **Training language models to follow instructions (InstructGPT)** — Ouyang et al. · *Advanced* · the RLHF recipe that produced modern chat models. <https://arxiv.org/abs/2203.02155>
- **Training Compute-Optimal LLMs (Chinchilla)** — Hoffmann et al. · *Advanced* · the data-vs-parameters scaling result. <https://arxiv.org/abs/2203.15556>
- **Hugging Face LLM Course** — Hugging Face · *Beginner→Intermediate* · free, hands-on, covers tokenization through fine-tuning. <https://huggingface.co/learn/llm-course>
- **Anthropic Docs: Models Overview** — Anthropic · *Beginner* · current model IDs, context windows, and capabilities. <https://docs.claude.com/en/docs/about-claude/models>

---

*AI Engineering Handbook — chapter 25.*
