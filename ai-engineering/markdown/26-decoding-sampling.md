# 26 · Decoding & Sampling: Temperature, Top-p & Beam

> **In one line:** Decoding is the algorithm that turns a model's next-token probability distribution into actual text, trading coherence for diversity via temperature, top-k, and top-p.

---

## 1. Overview

An LLM does not emit words — at each step it emits a **probability distribution over the entire vocabulary**. *Decoding* (also called sampling) is the separate, deterministic-or-stochastic algorithm that reads that distribution and chooses the actual next token. The exact same model weights can produce a dry, repetitive answer or a creative, varied one depending purely on the decoding strategy. This is one of the most underappreciated levers in applied LLM work: you can change output quality dramatically without touching the model.

The problem decoding solves is **the gap between a distribution and a choice**. If you always pick the single highest-probability token (greedy), you get coherent but bland, often repetitive text — and paradoxically not the most probable *sequence*, because locally-optimal choices can lead to globally-poor sequences. If you sample naively from the full distribution, you risk picking a low-probability token that derails the whole generation. Decoding strategies are the engineering answer to "how do we choose well?"

Historically, machine translation relied on **beam search** to approximate the highest-probability sequence. When GPT-2 arrived, researchers found beam search produced dull, repetitive open-ended text, and Holtzman et al. (2019) introduced **nucleus (top-p) sampling** — now the default for creative generation. The field's practical wisdom crystallized: use near-greedy/low-temperature for factual and code tasks, and top-p sampling for open-ended writing.

A concrete real-world example: ask a model to "list three prime numbers." At **temperature 0** it reliably answers "2, 3, 5" every time — you want determinism and correctness. Ask it to "write an opening line for a mystery novel" and temperature 0 gives you the same clichéd sentence every call; bump temperature to 0.9 with top-p 0.95 and you get varied, surprising openings. Same model, opposite settings, because the *task* has opposite needs.

The durable mental model: **the model gives you a probability landscape; decoding is how aggressively you explore it.** Low temperature hugs the peaks (safe, repeatable); high temperature wanders the slopes (creative, risky). Every knob — temperature, top-k, top-p — is a different way to reshape or truncate that landscape before you draw a sample.

---

## 2. Core Concepts

- **Logits** — the raw, unnormalized scores the model outputs per vocabulary token before softmax.
- **Softmax** — converts logits into a valid probability distribution that sums to 1.
- **Greedy decoding** — always take the single highest-probability token; deterministic, coherent, prone to repetition.
- **Temperature** — a scalar that divides the logits before softmax; `<1` sharpens the distribution (more confident/deterministic), `>1` flattens it (more random).
- **Top-k sampling** — restrict sampling to the `k` most-probable tokens, renormalize, then sample.
- **Top-p (nucleus) sampling** — restrict to the smallest set of tokens whose cumulative probability exceeds `p`, then sample; adapts the candidate set size to the model's confidence.
- **Beam search** — keep the `b` most-probable partial sequences at each step to approximate the globally most-probable sequence; standard in translation, poor for open-ended text.
- **Repetition penalty** — downweight tokens already generated to combat loops.
- **Stop sequences** — strings that end generation when produced.
- **Determinism** — greedy or temperature 0 gives repeatable output (modulo hardware); any sampling introduces run-to-run variation controlled by the random seed.

---

## 3. Theory & Mathematical Intuition

Start from the logit vector `z`. Plain softmax gives:

```
P(token_i) = e^{z_i} / Σ_j e^{z_j}
```

**Temperature** `T` rescales the logits *before* softmax:

```
P_T(token_i) = e^{z_i / T} / Σ_j e^{z_j / T}
```

- As `T → 0`, the distribution collapses onto the single largest logit → equivalent to greedy (deterministic).
- At `T = 1`, you sample from the model's native distribution.
- As `T → ∞`, the distribution flattens toward uniform → maximally random.

**Top-k** keeps only the k largest probabilities, sets the rest to zero, and renormalizes. Its weakness: a fixed `k` is too permissive when the model is confident (one token has 0.95 mass) and too restrictive when it's uncertain (mass spread over hundreds of tokens).

**Top-p / nucleus** fixes this by choosing the *smallest* set `V_p` such that `Σ_{i∈V_p} P(i) ≥ p`, then renormalizing over `V_p`. The candidate set shrinks when the model is confident and grows when it's uncertain — an adaptive, well-behaved truncation.

Temperature and top-p compose: temperature reshapes the distribution, then top-p truncates it.

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="320" fill="#e0f2fe"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Temperature reshapes the same distribution</text>
  <text x="120" y="55" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">T = 0.5 (sharp)</text>
  <rect x="60" y="90" width="30" height="160" fill="#0ea5e9"/>
  <rect x="100" y="180" width="30" height="70" fill="#0ea5e9"/>
  <rect x="140" y="215" width="30" height="35" fill="#0ea5e9"/>
  <rect x="180" y="235" width="30" height="15" fill="#0ea5e9"/>
  <line x1="55" y1="250" x2="215" y2="250" stroke="#1e293b" stroke-width="2"/>
  <text x="330" y="55" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">T = 1.0 (native)</text>
  <rect x="270" y="130" width="30" height="120" fill="#4f46e5"/>
  <rect x="310" y="175" width="30" height="75" fill="#4f46e5"/>
  <rect x="350" y="200" width="30" height="50" fill="#4f46e5"/>
  <rect x="390" y="220" width="30" height="30" fill="#4f46e5"/>
  <line x1="265" y1="250" x2="425" y2="250" stroke="#1e293b" stroke-width="2"/>
  <text x="545" y="55" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">T = 1.5 (flat)</text>
  <rect x="485" y="160" width="30" height="90" fill="#16a34a"/>
  <rect x="525" y="175" width="30" height="75" fill="#16a34a"/>
  <rect x="565" y="185" width="30" height="65" fill="#16a34a"/>
  <rect x="605" y="195" width="30" height="55" fill="#16a34a"/>
  <line x1="480" y1="250" x2="640" y2="250" stroke="#1e293b" stroke-width="2"/>
  <text x="330" y="295" text-anchor="middle" font-size="12" fill="#1e293b">Lower T concentrates mass on the top token; higher T spreads it out</text>
</svg>
```

---

## 4. Architecture & Workflow

Decoding sits in a loop *after* the forward pass. Here is the per-token workflow:

1. **Forward pass** — the model processes the current sequence and outputs logits for the next position.
2. **Apply repetition/frequency penalties** (optional) — subtract from logits of recently used tokens.
3. **Apply temperature** — divide all logits by `T`.
4. **Apply top-k filter** (optional) — zero out all but the k largest.
5. **Apply top-p filter** (optional) — keep the smallest nucleus reaching cumulative probability `p`; zero the rest.
6. **Softmax + sample** — normalize the surviving logits and draw one token (or take argmax if greedy/T=0).
7. **Append & check stop conditions** — add the token; if it's a stop token/sequence or `max_tokens` is hit, end; otherwise go to step 1.

Beam search replaces steps 3–6 with a different regime: maintain `b` candidate sequences ("beams"), expand each by its top continuations, score all expansions by cumulative log-probability, and keep the best `b`. It approximates `argmax_sequence P(sequence)` rather than sampling.

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#eef2ff"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Per-token Decoding Pipeline</text>
  <rect x="40" y="55" width="120" height="50" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="100" y="85" text-anchor="middle" font-size="12" fill="#1e293b">1. Logits</text>
  <rect x="185" y="55" width="120" height="50" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="245" y="80" text-anchor="middle" font-size="12" fill="#1e293b">2. Rep. penalty</text>
  <text x="245" y="95" text-anchor="middle" font-size="10" fill="#1e293b">(optional)</text>
  <rect x="330" y="55" width="120" height="50" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="390" y="85" text-anchor="middle" font-size="12" fill="#1e293b">3. Temperature</text>
  <rect x="475" y="55" width="140" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="545" y="80" text-anchor="middle" font-size="12" fill="#1e293b">4-5. top-k / top-p</text>
  <text x="545" y="95" text-anchor="middle" font-size="10" fill="#1e293b">truncate</text>
  <rect x="200" y="150" width="140" height="50" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="270" y="180" text-anchor="middle" font-size="12" fill="#1e293b">6. Softmax + sample</text>
  <rect x="380" y="150" width="140" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="450" y="175" text-anchor="middle" font-size="12" fill="#1e293b">7. Append token</text>
  <text x="450" y="190" text-anchor="middle" font-size="10" fill="#1e293b">check stop</text>
  <line x1="160" y1="80" x2="183" y2="80" stroke="#4f46e5" stroke-width="2" marker-end="url(#a26)"/>
  <line x1="305" y1="80" x2="328" y2="80" stroke="#4f46e5" stroke-width="2" marker-end="url(#a26)"/>
  <line x1="450" y1="80" x2="473" y2="80" stroke="#4f46e5" stroke-width="2" marker-end="url(#a26)"/>
  <line x1="545" y1="105" x2="300" y2="148" stroke="#4f46e5" stroke-width="2" marker-end="url(#a26)"/>
  <line x1="340" y1="175" x2="378" y2="175" stroke="#4f46e5" stroke-width="2" marker-end="url(#a26)"/>
  <path d="M 450 200 Q 450 260 100 260 Q 60 260 90 108" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5" marker-end="url(#a26g)"/>
  <text x="300" y="278" text-anchor="middle" font-size="11" fill="#64748b">loop until stop token or max_tokens</text>
  <defs>
    <marker id="a26" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="a26g" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8"/></marker>
  </defs>
</svg>
```

---

## 5. Implementation

First, implement the core knobs from scratch on a logit vector to see exactly what each does:

```python
import numpy as np

def softmax(z):
    z = z - z.max()               # numerical stability
    e = np.exp(z)
    return e / e.sum()

def apply_temperature(logits, T):
    if T == 0:                    # greedy limit
        out = np.full_like(logits, -np.inf)
        out[logits.argmax()] = 0.0
        return out
    return logits / T

def top_k_filter(logits, k):
    if k <= 0:
        return logits
    kth = np.sort(logits)[-k]     # k-th largest value
    return np.where(logits >= kth, logits, -np.inf)

def top_p_filter(logits, p):
    probs = softmax(logits)
    order = np.argsort(probs)[::-1]           # high → low
    cum = np.cumsum(probs[order])
    keep = order[cum <= p]
    if len(keep) == 0:                        # always keep the top token
        keep = order[:1]
    mask = np.full_like(logits, -np.inf)
    mask[keep] = logits[keep]
    return mask

rng = np.random.default_rng(0)
logits = np.array([3.0, 2.0, 1.0, 0.5, 0.2, -1.0])

for T in (0.5, 1.0, 1.5):
    z = top_p_filter(apply_temperature(logits, T), p=0.9)
    probs = softmax(z)
    choice = rng.choice(len(probs), p=probs)
    print(f"T={T}: dist={np.round(probs,3)}  sampled_idx={choice}")
# T=0.5: mass concentrates on token 0
# T=1.5: mass spreads across tokens 0-3
```

In production, you set these as API parameters. The **Anthropic Messages API** exposes `temperature` and `top_p` (use one, not both) plus `stop_sequences`:

```python
import anthropic

client = anthropic.Anthropic()

# Factual / code task → low temperature for determinism
factual = client.messages.create(
    model="claude-sonnet-4",
    max_tokens=256,
    temperature=0.0,
    messages=[{"role": "user", "content": "Return only the JSON {\"answer\": <2+2>}"}],
)

# Creative task → higher temperature for diversity
creative = client.messages.create(
    model="claude-opus-4",
    max_tokens=256,
    temperature=1.0,
    stop_sequences=["\n\n"],
    messages=[{"role": "user", "content": "Write one surprising opening line for a sci-fi story."}],
)
print(factual.content[0].text, "|", creative.content[0].text)
```

**Optimization note:** Beam search is far more expensive than sampling — it runs `b` parallel forward passes per step and needs careful length normalization to avoid favoring short sequences. For open-ended generation, well-tuned nucleus sampling (top-p ~0.9–0.95) usually beats beam search on both quality *and* cost. Reserve beam search for constrained tasks (translation, closed-ended extraction) where the single most-probable sequence genuinely matters.

---

## 6. Advantages, Disadvantages & Trade-offs

| Strategy | Strength | Cost / Trade-off |
|---|---|---|
| Greedy (T=0) | Deterministic, coherent, reproducible | Repetitive, bland; not the global optimum |
| Temperature | Single intuitive dial for randomness | Too high → incoherent; too low → repetitive |
| Top-k | Simple cap on candidate set | Fixed k is non-adaptive to model confidence |
| Top-p (nucleus) | Adapts candidate set to confidence; best default for creative text | Extra sort per step; another hyperparameter to tune |
| Beam search | Approximates most-probable sequence; strong for translation | Expensive (b× compute); dull/repetitive for open-ended text |
| Repetition penalty | Kills loops | Over-penalizing distorts natural repetition (e.g. code) |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Setting both `temperature` and `top_p` aggressively → ✅ Tune one primary knob (temperature is most intuitive); leave the other at its default.
2. ⚠️ Using high temperature for factual/code output → ✅ Use temperature 0 (or near-0) whenever correctness and reproducibility matter.
3. ⚠️ Using temperature 0 for brainstorming → ✅ Raise temperature (0.8–1.0) and/or top-p for diverse creative output.
4. ⚠️ Expecting temperature 0 to be perfectly deterministic across hardware → ✅ It's deterministic in the math but GPU nondeterminism can still cause tiny variation; don't hard-depend on byte-identical output.
5. ⚠️ Reaching for beam search on chat/creative tasks → ✅ Beam search produces dull, repetitive open-ended text; use nucleus sampling instead.
6. ⚠️ Cranking temperature above ~1.3 and getting gibberish → ✅ Combine high temperature with top-p to clip the long tail of nonsense tokens.
7. ⚠️ Forgetting stop sequences → ✅ Set explicit stop sequences (or rely on the model's stop token) so generation ends cleanly instead of running to `max_tokens`.
8. ⚠️ Ignoring the random seed in evaluation → ✅ Fix the seed (where the API supports it) or run multiple samples when comparing prompts, so you don't mistake sampling noise for a real difference.
9. ⚠️ Assuming greedy gives the most probable *sentence* → ✅ Greedy is locally optimal per token, not globally optimal per sequence — that's what beam search targets.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** If output is repetitive or looping, your temperature is too low or you lack a repetition penalty. If it's incoherent, temperature is too high or top-p too permissive. When a "flaky" test intermittently fails, check whether temperature > 0 is introducing sampling variance — set it to 0 for deterministic assertions. Always log the exact decoding parameters alongside the output so you can reproduce issues.

**Monitoring.** Track output-length distribution (a spike near `max_tokens` means truncation — raise the cap or add stop sequences), repetition rate, and refusal rate. For creative products, monitor diversity across samples (e.g. distinct-n metrics); a collapse toward identical outputs signals temperature drift or a model change.

**Security.** Decoding parameters don't create injection risk by themselves, but higher temperature makes a model *more* likely to follow an injected instruction it would otherwise ignore, and makes safety refusals less consistent. For untrusted-input pipelines, prefer low temperature and strict stop sequences to keep behavior predictable.

**Scaling.** Sampling is cheap; beam search multiplies cost by the beam width. If you need multiple diverse candidates (best-of-n, self-consistency), generate them by sampling in parallel rather than beam search — it's cheaper and more diverse. Cache the prompt prefix so repeated calls with different decoding settings don't reprocess the same input, and stream tokens to the client to hide decode latency.

---

## 9. Interview Questions

**Q: What does decoding do, and why is it separate from the model?**
A: The model outputs a probability distribution over the next token; decoding is the algorithm that selects an actual token from that distribution. It's separate because the same weights can produce very different text depending on the strategy — decoding is a runtime choice, not a property of the model.

**Q: How does temperature mathematically affect the distribution?**
A: Temperature `T` divides the logits before softmax: `P_i = e^{z_i/T} / Σ e^{z_j/T}`. `T < 1` sharpens the distribution toward the top token (more deterministic); `T > 1` flattens it (more random); `T → 0` becomes greedy argmax; `T → ∞` approaches uniform.

**Q: What's the difference between top-k and top-p sampling?**
A: Top-k keeps a fixed number `k` of the most-probable tokens. Top-p (nucleus) keeps the smallest set whose cumulative probability reaches `p`, so the candidate set grows when the model is uncertain and shrinks when it's confident — an adaptive truncation that top-k can't do.

**Q: When would you use temperature 0?**
A: For factual answers, code generation, structured/JSON output, classification, and any task needing reproducibility. Temperature 0 gives greedy, deterministic decoding so the same prompt yields the same answer, which is what those tasks require.

**Q: Why does greedy decoding produce repetitive text?**
A: Always taking the single highest-probability token pushes the model into high-confidence loops — once it starts a phrase it has seen often, that phrase remains locally most probable, so it repeats. Sampling breaks these loops by occasionally choosing lower-probability continuations.

**Q: Why is beam search a poor choice for open-ended generation?**
A: Beam search optimizes for the highest-probability sequence, and for open-ended text the highest-probability continuations are generic, repetitive, and low-information ("the the the" pathologies). Human-like text is actually *not* the most probable sequence, so nucleus sampling — which deliberately injects controlled randomness — reads more naturally.

**Q: (Senior) Why should you tune either temperature or top-p, not both aggressively?**
A: They interact multiplicatively — temperature reshapes the distribution and top-p truncates it — so tuning both makes the effect of each hard to reason about and hard to reproduce. Best practice is to fix one at its default and sweep the other. Temperature is usually the primary dial because its effect is most intuitive.

**Q: (Senior) How would you get diverse, high-quality candidates for a best-of-n or self-consistency pipeline?**
A: Sample n independent completions with moderate temperature (e.g. 0.7–1.0) and top-p ~0.95, ideally in parallel, then score/aggregate them (majority vote for reasoning, a reward model or heuristic for generation). This gives more diversity than beam search's b beams and costs the same as n forward passes with no beam-management overhead.

**Q: (Senior) A model outputs valid JSON 95% of the time but occasionally emits malformed JSON. How does decoding help?**
A: Lower the temperature toward 0 to make the model take its highest-confidence (well-formed) path, add stop sequences to end cleanly, and consider constrained/structured decoding or the provider's structured-output feature that masks logits to only grammar-valid tokens. Sampling variance at higher temperature is a common cause of the occasional 5% failures.

**Q: What is a repetition penalty and when can it backfire?**
A: It downweights the logits of tokens (or n-grams) already generated to discourage loops. It backfires when repetition is legitimate — code with repeated keywords, lists, or tabular data — where penalizing repeats degrades correctness. Apply it for prose, not for structured or code output.

**Q: Does temperature 0 guarantee identical output every time?**
A: In the math, yes — it's deterministic argmax. In practice, floating-point nondeterminism on GPUs (reduction order, kernel selection) can occasionally flip a near-tie, so byte-identical output isn't strictly guaranteed. It's far more stable than sampling, but don't build systems that assume perfect reproducibility.

**Q: How do stop sequences interact with decoding?**
A: Stop sequences are checked after each token is chosen; when the generated text matches a stop sequence, generation halts before appending it. They're orthogonal to temperature/top-p (which choose tokens) and are essential for ending generation cleanly instead of running to `max_tokens`.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The model gives a distribution; decoding picks a token. Temperature `T` divides logits before softmax: low = sharp/deterministic (use for facts, code, JSON), high = flat/creative (use for writing, brainstorming). Top-k caps the candidate set at k; top-p (nucleus) caps it at cumulative probability p and adapts to model confidence — the best default for open text. Greedy (T=0) is coherent but repetitive and only locally optimal. Beam search chases the most-probable *sequence* — great for translation, dull for chat. Tune one knob, set stop sequences, and match settings to the task.

| Setting | Use for | Typical value |
|---|---|---|
| Temperature 0 | Facts, code, JSON, classification | 0.0 |
| Temperature high | Creative writing, brainstorming | 0.8–1.0 |
| Top-p | Open-ended generation default | 0.9–0.95 |
| Top-k | Simple candidate cap | 40–100 |
| Beam search | Translation, closed extraction | beam 4–8 |

Flash cards:
- **What does temperature divide?** → The logits, before softmax.
- **Which sampling adapts to confidence?** → Top-p (nucleus).
- **Best temperature for reproducible code?** → 0 (greedy).
- **Why is beam search bad for chat?** → Most-probable text is generic and repetitive.
- **Tune temperature or top-p?** → One primary knob, not both aggressively.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement `softmax`, temperature, top-k, and top-p filters from scratch (as in §5) and verify each on a hand-crafted logit vector.
- [ ] Generate the same creative prompt at temperatures 0, 0.5, 1.0, and 1.4; qualitatively compare coherence vs diversity.
- [ ] Sweep top-p from 0.5 to 1.0 at fixed temperature 1.0 and observe when output starts to degrade.
- [ ] Compare greedy vs nucleus sampling on an open-ended prompt and count repeated bigrams in each.
- [ ] Add a stop sequence to a call and confirm `stop_reason` reflects `stop_sequence` instead of `max_tokens`.

**Mini Project — Decoding playground.**
*Goal:* A small web or CLI tool that calls an LLM with user-adjustable temperature, top-p, top-k, and stop sequences, and displays both the output and the per-step top-token probabilities (using a local `gpt2` for the probability view).
*Requirements:* Sliders/flags for each parameter; side-by-side comparison of two settings on the same prompt; a "diversity meter" computing distinct-bigram ratio across n samples.
*Extension ideas:* Add self-consistency (sample n, majority-vote a numeric answer); add a beam-search mode and compare its output and latency to sampling; visualize how the nucleus size changes token-to-token.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **How LLMs Work** (where logits come from), **Prompt Engineering** (steering *what* the distribution looks like), and **Context Windows, Tokens & Cost** (how output length driven by decoding affects price).

**Free Learning Resources**
- **The Curious Case of Neural Text Degeneration** — Holtzman et al. · *Advanced* · the paper that introduced nucleus (top-p) sampling and diagnosed beam search's failures. <https://arxiv.org/abs/1904.09751>
- **How to generate text: decoding methods** — Hugging Face blog (Patrick von Platen) · *Intermediate* · hands-on tour of greedy, beam, top-k, and top-p with code. <https://huggingface.co/blog/how-to-generate>
- **Text generation strategies** — Hugging Face Docs · *Intermediate* · reference for every `generate()` decoding parameter. <https://huggingface.co/docs/transformers/generation_strategies>
- **Anthropic API Reference: Messages** — Anthropic · *Beginner* · exact semantics of `temperature`, `top_p`, and `stop_sequences`. <https://docs.claude.com/en/api/messages>
- **Let's build the GPT Tokenizer / generation** — Andrej Karpathy · *Intermediate* · builds sampling from first principles in code. <https://www.youtube.com/watch?v=zduSFxRajkE>
- **The Illustrated GPT-2** — Jay Alammar · *Beginner* · visual walkthrough including how output tokens are chosen. <https://jalammar.github.io/illustrated-gpt2/>

---

*AI Engineering Handbook — chapter 26.*
