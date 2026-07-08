# 20 · Attention & the Transformer

> **In one line:** Self-attention lets every token look directly at every other token and pull in what's relevant, and the Transformer stacks that operation — with multiple heads and positional encoding — into the parallelizable architecture behind every modern LLM.

---

## 1. Overview

Recurrent networks (Chapter 19) read a sequence one step at a time, squeezing all history into a single hidden vector. Two problems follow: information from far-back tokens is diluted, and the sequential dependency makes training impossible to parallelize across time. In 2017 the paper *"Attention Is All You Need"* proposed replacing recurrence entirely with **self-attention** — a mechanism where each position computes a weighted sum over *all* positions, deciding for itself which other tokens matter. Every token gets a direct, constant-length path to every other token, and the whole operation is a few big matrix multiplications that GPUs devour in parallel.

The problem attention solves is **content-based routing of information**. When the model processes "it" in "The animal didn't cross the street because *it* was too tired," attention lets "it" attend strongly to "animal," resolving the reference. No fixed window, no recurrence — the model learns which relationships to form. Because the operation is order-agnostic by itself, the Transformer injects **positional encoding** so the model still knows token order.

The motivation was scale. Because attention parallelizes, Transformers can be trained on internet-scale corpora with enormous batch sizes. This unlocked the modern era: BERT (2018) for understanding, GPT for generation, and today Claude, GPT-4/5-class models, Llama, and Gemini — all Transformers at heart. The same architecture, with minor tweaks, powers vision (ViT), audio (Whisper), and protein folding (AlphaFold's Evoformer).

A concrete real-world example: machine translation. The encoder reads the full source sentence with bidirectional self-attention, building a context-rich representation of every word; the decoder generates the target one token at a time, using **cross-attention** to look back at the source and **masked self-attention** to look at what it has already produced. The result is far more fluent than the RNN seq2seq systems it replaced.

Understanding attention is now table stakes for any AI engineer: it is the computational primitive underneath prompting, fine-tuning, RAG, and every LLM you will build on.

## 2. Core Concepts

- **Self-attention** — each token produces a query, key, and value, and its output is a weighted average of all values, weighted by query–key similarity.
- **Query, Key, Value (Q, K, V)** — three learned linear projections of each token: Q = "what I'm looking for," K = "what I offer," V = "what I pass on."
- **Scaled dot-product attention** — the core formula `softmax(QKᵀ/√d)V`; the `√d` scaling keeps softmax gradients healthy.
- **Attention weights** — the softmax-normalized similarity matrix (each row sums to 1) that says how much each token attends to every other.
- **Multi-head attention** — run several attention operations in parallel on projected subspaces, letting different heads capture different relations (syntax, coreference, position).
- **Positional encoding** — vectors added to embeddings so the otherwise order-blind model knows token order (sinusoidal, learned, or rotary/RoPE).
- **Causal (masked) attention** — masks out future positions so a token can only attend to itself and the past, required for autoregressive generation.
- **Cross-attention** — queries come from one sequence (decoder) and keys/values from another (encoder), letting the decoder read the source.
- **Feed-forward network (FFN)** — a per-token two-layer MLP applied after attention; where much of the model's capacity and "knowledge" lives.
- **Residual + LayerNorm** — skip connections and normalization that make deep stacks trainable and stable.

## 3. Theory & Mathematical Intuition

Given an input of `n` tokens each of dimension `d_model`, we project them into queries, keys, and values:

```
Q = X · W_Q      K = X · W_K      V = X · W_V     # shapes (n, d_k), (n, d_k), (n, d_v)
```

Scaled dot-product attention is:

```
Attention(Q, K, V) = softmax( Q Kᵀ / √d_k ) V
```

Read it geometrically. `Q Kᵀ` is an `n×n` matrix of dot products — entry `(i,j)` is how much token `i`'s query aligns with token `j`'s key, i.e. relevance. Dividing by `√d_k` prevents these dot products from growing large (they scale with dimension), which would push softmax into a saturated region with vanishing gradients. `softmax` turns each row into a probability distribution over tokens. Multiplying by `V` produces, for each token, a weighted blend of all value vectors — the information it chose to gather.

**Multi-head attention** runs `h` of these in parallel, each on a `d_k = d_model/h` slice:

```
head_i = Attention(X W_Q^i, X W_K^i, X W_V^i)
MultiHead(X) = Concat(head_1, ..., head_h) · W_O
```

Each head can specialize — one tracks the previous token, another links verbs to subjects, another resolves pronouns. Concatenation and a final projection `W_O` mix them back together.

**Positional encoding** is needed because attention is permutation-equivariant: shuffle the input and you shuffle the output identically, with no sense of order. The original sinusoidal scheme adds, to dimension `2i` and `2i+1` of position `pos`:

```
PE(pos, 2i)   = sin( pos / 10000^{2i/d} )
PE(pos, 2i+1) = cos( pos / 10000^{2i/d} )
```

Different dimensions oscillate at different frequencies, giving every position a unique fingerprint and letting the model express relative offsets. Modern LLMs often use **RoPE** (rotary), which rotates Q and K by a position-dependent angle so that dot products naturally encode relative distance.

A full block is `x → x + MHA(LN(x)) → x + FFN(LN(x))` (pre-norm), where FFN is `Linear → GELU → Linear` expanding to ~4×`d_model`. The residual paths give gradients a direct highway through dozens of layers.

The diagram below shows how one query attends across all keys/values via the softmax-weighted matrix.

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="280" fill="#e0f2fe"/>
  <text x="20" y="28" font-size="15" fill="#1e293b" font-weight="bold">Scaled dot-product attention for one query</text>
  <rect x="30" y="70" width="70" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="52" y="95" font-size="12" fill="#1e293b">Q_i</text>
  <g font-size="11" fill="#1e293b">
    <rect x="200" y="55" width="60" height="30" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="220" y="75">K_1</text>
    <rect x="200" y="95" width="60" height="30" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="220" y="115">K_2</text>
    <rect x="200" y="135" width="60" height="30" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="220" y="155">K_3</text>
    <rect x="200" y="175" width="60" height="30" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="220" y="195">K_n</text>
  </g>
  <g stroke="#0ea5e9" stroke-width="1.6" fill="none">
    <line x1="100" y1="90" x2="200" y2="70" marker-end="url(#a20)"/>
    <line x1="100" y1="90" x2="200" y2="110" marker-end="url(#a20)"/>
    <line x1="100" y1="90" x2="200" y2="150" marker-end="url(#a20)"/>
    <line x1="100" y1="90" x2="200" y2="190" marker-end="url(#a20)"/>
  </g>
  <text x="120" y="55" font-size="10" fill="#0ea5e9">dot / √d</text>
  <rect x="300" y="95" width="150" height="70" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="315" y="125" font-size="11" fill="#1e293b">softmax weights</text>
  <text x="315" y="145" font-size="11" fill="#1e293b">[.6 .1 .2 .1]</text>
  <line x1="260" y1="130" x2="300" y2="130" stroke="#16a34a" stroke-width="1.8" marker-end="url(#a20)"/>
  <rect x="500" y="95" width="110" height="70" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="512" y="125" font-size="11" fill="#1e293b">output_i =</text>
  <text x="512" y="145" font-size="11" fill="#1e293b">Σ w·V_j</text>
  <line x1="450" y1="130" x2="500" y2="130" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#a20)"/>
  <text x="300" y="235" font-size="11" fill="#1e293b">Each token blends all values, weighted by query-key relevance.</text>
  <defs>
    <marker id="a20" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker>
  </defs>
</svg>
```

## 4. Architecture & Workflow

How a decoder-only Transformer (GPT/Claude-style) processes a prompt and generates:

1. **Tokenize** — split text into subword tokens (Chapter 23); map to integer ids.
2. **Embed + position** — look up a `d_model` vector per token, add (or rotate in) positional information.
3. **Per block, attention sublayer** — LayerNorm the input, project to Q/K/V across `h` heads, compute masked scaled-dot-product attention (each token sees only itself and earlier tokens), concatenate heads, project, add the residual.
4. **Per block, FFN sublayer** — LayerNorm, apply `Linear→GELU→Linear` (≈4× width) per token independently, add the residual.
5. **Stack N blocks** — repeat 3–4 for N layers (12 for GPT-2 small, 80+ for frontier models), building progressively abstract representations.
6. **Final norm + unembed** — LayerNorm, then multiply by the output embedding to get logits over the vocabulary.
7. **Sample next token** — apply temperature / top-p, pick a token, append it, and repeat from step 2 (autoregressive loop). A **KV cache** stores past keys/values so each new token costs O(n) not O(n²).

```svg
<svg viewBox="0 0 640 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="340" fill="#eef2ff"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">Transformer block (pre-norm, decoder-only)</text>
  <rect x="240" y="300" width="160" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="255" y="320" font-size="11" fill="#1e293b">tokens + positional enc</text>
  <rect x="230" y="230" width="180" height="50" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="248" y="252" font-size="11" fill="#1e293b">LayerNorm</text>
  <text x="248" y="270" font-size="11" fill="#1e293b">Masked Multi-Head Attn</text>
  <rect x="230" y="150" width="180" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="248" y="172" font-size="11" fill="#1e293b">LayerNorm</text>
  <text x="248" y="190" font-size="11" fill="#1e293b">FFN (Linear-GELU-Linear)</text>
  <rect x="240" y="80" width="160" height="30" rx="5" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="255" y="100" font-size="11" fill="#1e293b">to next block / logits</text>
  <g stroke="#4f46e5" stroke-width="2" fill="none">
    <line x1="320" y1="300" x2="320" y2="280" marker-end="url(#b20)"/>
    <line x1="320" y1="230" x2="320" y2="200" marker-end="url(#b20)"/>
    <line x1="320" y1="150" x2="320" y2="110" marker-end="url(#b20)"/>
  </g>
  <path d="M440 305 C 500 305, 500 205, 440 205" fill="none" stroke="#d97706" stroke-width="1.6" marker-end="url(#c20)"/>
  <text x="505" y="258" font-size="10" fill="#d97706">residual</text>
  <path d="M440 225 C 505 225, 505 125, 440 125" fill="none" stroke="#16a34a" stroke-width="1.6" marker-end="url(#c20)"/>
  <text x="505" y="178" font-size="10" fill="#16a34a">residual</text>
  <text x="30" y="180" font-size="11" fill="#1e293b">Repeat</text>
  <text x="30" y="196" font-size="11" fill="#1e293b">N times</text>
  <defs>
    <marker id="b20" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
    <marker id="c20" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 5. Implementation

Scaled dot-product attention from scratch in NumPy:

```python
import numpy as np

def softmax(x, axis=-1):
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)

def attention(Q, K, V, mask=None):
    d_k = Q.shape[-1]
    scores = Q @ K.swapaxes(-1, -2) / np.sqrt(d_k)   # (..., n, n)
    if mask is not None:
        scores = np.where(mask, scores, -1e9)        # causal / padding mask
    weights = softmax(scores, axis=-1)
    return weights @ V, weights

rng = np.random.default_rng(0)
n, d = 4, 8
Q = K = V = rng.standard_normal((n, d))
causal = np.tril(np.ones((n, n), dtype=bool))        # lower-triangular
out, w = attention(Q, K, V, mask=causal)
print(out.shape, w[0].round(2))   # (4, 8)  row0 attends only to token 0
```

Multi-head attention as a PyTorch module:

```python
import torch, torch.nn as nn, torch.nn.functional as F

class MultiHeadAttention(nn.Module):
    def __init__(self, d_model=512, n_heads=8):
        super().__init__()
        assert d_model % n_heads == 0
        self.h, self.d_k = n_heads, d_model // n_heads
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.proj = nn.Linear(d_model, d_model)

    def forward(self, x, causal=True):
        B, T, C = x.shape
        q, k, v = self.qkv(x).chunk(3, dim=-1)
        # (B, h, T, d_k)
        q, k, v = [t.view(B, T, self.h, self.d_k).transpose(1, 2) for t in (q, k, v)]
        # PyTorch 2.x fused, flash-attention kernel:
        out = F.scaled_dot_product_attention(q, k, v, is_causal=causal)
        out = out.transpose(1, 2).contiguous().view(B, T, C)
        return self.proj(out)

x = torch.randn(2, 16, 512)
print(MultiHeadAttention()(x).shape)   # torch.Size([2, 16, 512])
```

Using a pretrained Transformer via Hugging Face:

```python
from transformers import AutoTokenizer, AutoModel
import torch

tok = AutoTokenizer.from_pretrained("bert-base-uncased")
model = AutoModel.from_pretrained("bert-base-uncased").eval()
inputs = tok("Attention routes information between tokens.", return_tensors="pt")
with torch.no_grad():
    out = model(**inputs)
print(out.last_hidden_state.shape)   # torch.Size([1, 8, 768])  contextual vectors
```

> **Optimization:** Use `F.scaled_dot_product_attention` (PyTorch 2.x), which dispatches to **FlashAttention** — a fused, IO-aware kernel that never materializes the `n×n` score matrix in HBM, cutting attention memory from O(n²) to O(n) and running several times faster. For inference, a **KV cache** avoids recomputing keys/values for prior tokens, turning generation from O(n²) per token into O(n).

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Parallelism | All positions computed at once → fast training | Needs large GPUs/memory to hold activations |
| Long-range modeling | Every token has an O(1) path to every other | Naive attention is O(n²) in time and memory |
| Multi-head | Captures many relation types simultaneously | More projections; heads can be redundant |
| Positional encoding | Flexible order handling (sinusoidal/RoPE) | Length extrapolation beyond training context is hard |
| Scalability | Scales smoothly to billions of params (LLMs) | Enormous compute/data cost; expensive to serve |
| Interpretability | Attention maps are inspectable | Attention weights are not faithful explanations |
| Generality | One architecture for text, vision, audio | Data-hungry; weak in low-data regimes vs inductive-bias models |

## 7. Common Mistakes & Best Practices

1. ⚠️ Forgetting the `1/√d_k` scaling → saturated softmax and vanishing gradients. ✅ Always scale scores by `√d_k`.
2. ⚠️ Omitting the causal mask in a decoder → the model "cheats" by seeing future tokens and looks great in training, fails at generation. ✅ Apply a lower-triangular mask (or `is_causal=True`).
3. ⚠️ No positional information → the model is order-blind and treats sentences as bags of words. ✅ Add sinusoidal/learned/RoPE positions.
4. ⚠️ Not masking padding tokens → attention leaks into pad positions. ✅ Pass an attention mask that sets pad scores to `-inf`.
5. ⚠️ Materializing the full `n×n` matrix for long sequences → OOM. ✅ Use FlashAttention / fused SDPA.
6. ⚠️ Post-norm in very deep stacks → unstable training. ✅ Prefer pre-norm (LayerNorm before each sublayer) for depth stability.
7. ⚠️ Reading attention maps as ground-truth explanations. ✅ Treat them as suggestive, not causal; use proper attribution methods.
8. ⚠️ Reusing the KV cache across a changed prompt prefix. ✅ Invalidate the cache when earlier tokens change.
9. ⚠️ Setting `d_model` not divisible by `n_heads`. ✅ Ensure `d_model % n_heads == 0`.
10. ⚠️ Training a Transformer from scratch on a tiny dataset. ✅ Fine-tune a pretrained model; Transformers are data-hungry.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Sanity-check masks by feeding a permuted-future input and confirming the loss is unchanged for a causal model. Verify attention rows sum to 1. Overfit a tiny dataset to confirm the block wiring (residuals, norm placement) is correct before scaling.

**Monitoring.** Track training loss/perplexity, gradient norms, and activation statistics (LayerNorm can drift). In serving, monitor tokens/sec, time-to-first-token (dominated by prompt encoding), inter-token latency (dominated by KV-cache reads), and GPU memory (KV cache grows linearly with context and batch). Watch for attention entropy collapse (heads attending to one token) as a training-health signal.

**Security.** LLMs are vulnerable to prompt injection — untrusted text in the context can hijack instructions; isolate and sanitize retrieved/user content and never grant tools blind trust. Guard against jailbreaks with system prompts and output filtering. Long contexts enable token-flooding DoS; cap context length and rate-limit.

**Performance & Scaling.** Train with tensor/pipeline/data parallelism (Megatron/DeepSpeed) and mixed precision (bf16). Serve with FlashAttention, paged KV cache (vLLM), continuous batching, and quantization (int8/int4, GPTQ/AWQ). For long context, use grouped-query attention (GQA) to shrink the KV cache and sliding-window or sparse attention to bound cost.

## 9. Interview Questions

**Q: What are queries, keys, and values?**
A: They are three learned linear projections of each token. The query is what a token is looking for, the key is what each token offers, and the value is the information passed along. Attention weights come from query–key similarity and are used to average the values.

**Q: Why divide the dot products by √d_k?**
A: Dot products of `d_k`-dimensional vectors have variance proportional to `d_k`, so without scaling they grow large, pushing softmax into a saturated region where gradients vanish. Dividing by `√d_k` keeps the score variance ~1 and gradients healthy.

**Q: Why does a Transformer need positional encoding?**
A: Self-attention is permutation-equivariant — it has no inherent notion of order, so "dog bites man" and "man bites dog" would be identical. Positional encodings inject order information, either added to embeddings (sinusoidal/learned) or via rotation of Q/K (RoPE).

**Q: What is multi-head attention and why use multiple heads?**
A: It runs several attention operations in parallel on lower-dimensional projections, then concatenates them. Different heads specialize in different relationships — adjacency, syntax, coreference — giving the model a richer, multi-relational view than a single head could.

**Q: What is the difference between self-attention and cross-attention?**
A: In self-attention, Q, K, and V all come from the same sequence. In cross-attention, queries come from one sequence (e.g. the decoder) and keys/values from another (e.g. the encoder), letting the decoder read the source in translation or the retrieved context in RAG.

**Q: Why is a causal mask needed and how does it work?**
A: For autoregressive generation each token must predict the next using only past context. The causal mask sets attention scores to future positions to `-inf` before softmax (a lower-triangular allowed pattern), so each position attends only to itself and earlier tokens.

**Q: (Senior) What is the computational complexity of self-attention and how do you reduce it?**
A: Vanilla attention is O(n²·d) in time and O(n²) in memory because of the `n×n` score matrix. Reductions include FlashAttention (IO-aware, no full matrix materialized, still exact), sparse/sliding-window attention, linear-attention approximations, and grouped-query attention to shrink the KV cache.

**Q: (Senior) What is a KV cache and why is it essential for serving?**
A: During generation, keys and values for already-processed tokens don't change, so we cache them and only compute Q/K/V for the new token. This turns per-token cost from O(n²) to O(n) and is the main reason autoregressive inference is tractable; its size (linear in context × layers × heads) often dominates serving memory.

**Q: (Senior) Compare encoder-only, decoder-only, and encoder–decoder Transformers.**
A: Encoder-only (BERT) uses bidirectional attention, great for understanding/classification. Decoder-only (GPT/Claude) uses causal attention and is trained to predict the next token, ideal for generation and now dominant. Encoder–decoder (T5, original Transformer) encodes the input bidirectionally and decodes with cross-attention, natural for seq2seq like translation.

**Q: Are attention weights a faithful explanation of the model's decision?**
A: Not reliably. Attention maps show where the model looked but not why an output resulted, and different attention distributions can yield the same prediction. Use them as a diagnostic hint, not as a causal explanation; prefer gradient- or perturbation-based attribution for rigor.

**Q: What does the feed-forward network in a block do?**
A: After attention mixes information across tokens, the FFN (`Linear→GELU→Linear`, ~4× width) processes each token independently, adding non-linear capacity. It holds a large share of the model's parameters and is where much factual "knowledge" is thought to reside.

**Q: (Senior) What is grouped-query attention (GQA) and why do modern LLMs use it?**
A: GQA lets multiple query heads share a single key/value head, between full multi-head (one KV per query) and multi-query (one KV total). It shrinks the KV cache and memory bandwidth at inference with minimal quality loss, which is why models like Llama 2/3 adopt it for efficient long-context serving.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Attention computes `softmax(QKᵀ/√d)V`: each token forms a query, matches it against every key to get relevance weights, and gathers a weighted blend of values. Multi-head attention runs this in parallel subspaces to capture different relations; positional encoding restores order; residuals + LayerNorm make deep stacks trainable; and a per-token FFN adds capacity. Decoder-only models add a causal mask and generate autoregressively with a KV cache. It's fully parallel (unlike RNNs), gives O(1) token-to-token paths, but costs O(n²) — mitigated by FlashAttention, GQA, and sparse attention.

| Piece | Formula / role |
|---|---|
| Attention | `softmax(QKᵀ/√d_k)·V` |
| Multi-head | concat h heads, project with W_O |
| Positional | sinusoidal / learned / RoPE |
| Causal mask | future scores → -inf |
| Block | pre-norm: x+MHA(LN x), x+FFN(LN x) |
| Serving | KV cache, FlashAttention, GQA |

Flash cards:
- **What does softmax(QKᵀ/√d) produce?** → Attention weights: how much each token attends to every other.
- **Why √d_k scaling?** → Keeps dot-product variance ~1 so softmax gradients don't vanish.
- **What breaks if you drop positional encoding?** → The model becomes order-blind (bag of tokens).
- **What makes generation efficient?** → The KV cache (reuse past keys/values).
- **Encoder-only vs decoder-only?** → Bidirectional understanding (BERT) vs causal generation (GPT/Claude).

## 11. Hands-On Exercises & Mini Project

- [ ] Implement scaled dot-product attention in NumPy and verify a causal mask zeros out future weights.
- [ ] Visualize attention weights of `bert-base-uncased` on a coreference sentence and identify a head that resolves the pronoun.
- [ ] Ablate the `√d_k` scaling and plot how softmax entropy collapses as `d_k` grows.
- [ ] Add a KV cache to a small decoder and measure the per-token latency drop vs recomputing.
- [ ] Swap sinusoidal for RoPE in a toy model and test extrapolation to sequences longer than training length.

**Mini Project — Build a mini-GPT.**
Goal: implement a decoder-only Transformer that generates Shakespeare-like text at the character level.
Requirements: (1) token/position embeddings; (2) N pre-norm blocks with masked multi-head attention and an FFN; (3) train with cross-entropy next-token loss; (4) generate with temperature and top-p sampling; (5) report validation loss and sample outputs.
Extensions: add a KV cache for fast generation; switch to BPE tokenization (Chapter 23); implement FlashAttention via `F.scaled_dot_product_attention` and benchmark; scale to 2–4 layers and study the loss curve.

## 12. Related Topics & Free Learning Resources

Related chapters: **RNNs, LSTMs & Sequence Models** (what attention replaced), **Embeddings & Representation Learning** (the input the Transformer consumes), **NLP Foundations & Tokenization** (how text becomes tokens), and **PyTorch in Practice** (building and training the blocks).

**Free Learning Resources**
- **Attention Is All You Need** — Vaswani et al. (2017) · *Advanced* · the original paper; read it once you know the intuition. <https://arxiv.org/abs/1706.03762>
- **The Illustrated Transformer** — Jay Alammar · *Beginner* · the definitive visual walkthrough of Q/K/V and multi-head attention. <https://jalammar.github.io/illustrated-transformer/>
- **Let's build GPT** — Andrej Karpathy · *Intermediate* · code a decoder-only Transformer from scratch on video. <https://www.youtube.com/watch?v=kCc8FmEb1nY>
- **The Annotated Transformer** — Harvard NLP · *Intermediate* · the paper implemented line-by-line in PyTorch. <https://nlp.seas.harvard.edu/annotated-transformer/>
- **CS224n: Transformers lecture** — Stanford · *Advanced* · rigorous treatment of self-attention and positional encoding. <https://web.stanford.edu/class/cs224n/>
- **FlashAttention** — Dao et al. · *Advanced* · IO-aware exact attention that makes long context practical. <https://arxiv.org/abs/2205.14135>
- **Hugging Face Transformers docs** — Hugging Face · *Intermediate* · load, fine-tune, and serve real Transformer models. <https://huggingface.co/docs/transformers/index>

---

*AI Engineering Handbook — chapter 20.*
