# 23 · NLP Foundations & Tokenization

> **In one line:** Before a model can reason about language it must turn raw text into a finite sequence of integer tokens — and the tokenizer's choices about subwords silently shape vocabulary size, context length, cost, and even what the model can spell.

---

## 1. Overview

A language model never sees letters or words — it sees integers. **Tokenization** is the bridge: the deterministic process that converts a raw string like "unbelievable" into a sequence of token ids such as `[un, believ, able]` → `[315, 8461, 712]`, which are then embedded (Chapter 21) and fed to a Transformer (Chapter 20). It sounds like plumbing, but it is one of the most consequential design choices in the whole stack. Tokenization decides how long your context window effectively is, how much an API call costs (you pay per token), whether the model can do arithmetic or spell a rare name, and how well it handles languages other than English.

The problem tokenization solves is the **vocabulary trade-off**. If you use whole words, your vocabulary must be enormous and you still choke on any word you've never seen ("out-of-vocabulary"). If you use individual characters, sequences become painfully long and the model must learn everything from scratch. **Subword tokenization** — BPE, WordPiece, Unigram — hits the sweet spot: common words stay whole, rare words split into meaningful pieces, and *any* string is representable because the pieces bottom out at single bytes/characters. Nothing is ever truly out-of-vocabulary.

Historically, NLP moved from bag-of-words and hand-built rules, to whitespace/word tokenization with `<UNK>` tokens for unknowns, to the subword revolution: BPE was adapted from data compression to NLP by Sennrich et al. (2016) for machine translation, WordPiece powered BERT, and Unigram/SentencePiece brought language-agnostic tokenization. Every frontier LLM today ships its own subword tokenizer (GPT models use byte-level BPE via `tiktoken`; Llama uses SentencePiece BPE).

A concrete real-world example: you send "The café's naïve résumé" to an LLM API. Normalization decides whether accented characters survive; the tokenizer splits it into subword pieces; you're billed for the resulting token count. Because "café" may split into `["ca", "fé"]` or a byte sequence, the model's ability to reason about that word — and your bill — hinges on the tokenizer. Understanding this layer prevents a whole class of subtle bugs.

## 2. Core Concepts

- **Token** — the atomic unit a model processes; can be a word, subword, character, or byte depending on the scheme.
- **Vocabulary** — the fixed finite set of tokens the model knows, mapping tokens ↔ integer ids (typically 30k–256k entries).
- **Normalization** — pre-tokenization cleanup: Unicode normalization (NFC/NFKC), lowercasing, accent stripping, whitespace handling.
- **Pre-tokenization** — an initial split (usually on whitespace/punctuation) that bounds where subword merges can happen.
- **BPE (Byte-Pair Encoding)** — greedily merges the most frequent adjacent symbol pair, repeatedly, to build a subword vocabulary.
- **WordPiece** — like BPE but merges the pair that most increases corpus likelihood; used by BERT, marks continuations with `##`.
- **Unigram LM** — starts from a large vocab and prunes tokens to maximize likelihood; used by SentencePiece/T5.
- **Byte-level tokenization** — operates on raw UTF-8 bytes so every possible string is representable with no `<UNK>`.
- **Special tokens** — reserved ids like `[CLS]`, `[SEP]`, `<pad>`, `<s>`, `</s>`, `<|endoftext|>` for structure and control.
- **Context window** — the maximum number of tokens (not words) a model can attend to at once; tokenization determines how much text fits.

## 3. Theory & Mathematical Intuition

**Byte-Pair Encoding** is the clearest algorithm to reason about. Start with a base vocabulary of individual characters (or bytes). Then repeat: count all adjacent symbol pairs in the corpus, find the most frequent pair, merge it into a new single symbol, and add that merge to the vocabulary. Do this `k` times to reach the target vocab size.

```
corpus (as chars):  l o w </w> ,  l o w e s t </w> ,  n e w e r </w> ...
step 1: most frequent pair = (l, o)  -> merge to "lo"
step 2: most frequent pair = (lo, w) -> merge to "low"
...
result: frequent words become single tokens; rare words stay split.
```

The learned artifact is an *ordered list of merge rules*. At inference, encoding applies those merges greedily in order to any new string. Because the base is characters/bytes, any input is representable — there is no `<UNK>`.

**WordPiece** changes the selection criterion. Instead of raw frequency it merges the pair `(a, b)` that maximizes the increase in corpus likelihood, approximated by:

```
score(a, b) = freq(ab) / ( freq(a) · freq(b) )
```

This favors merges where the pair occurs together far more than chance predicts, producing linguistically tighter subwords.

**Unigram LM** works top-down. It posits that a sentence's tokenization is a latent variable and each token has a probability; it starts with a big candidate vocabulary and iteratively removes the tokens whose loss (drop in total corpus likelihood) is smallest, via an EM-style procedure, until reaching the target size. At inference it uses Viterbi to pick the highest-probability segmentation.

**Why subwords are efficient** ties back to Zipf's law: a small number of tokens (frequent words) cover most text, while a long tail of rare words is decomposed into reusable pieces. A ~50k subword vocab typically encodes English at ~1.3 tokens per word, balancing sequence length against vocabulary size.

The diagram traces BPE building "lower" from characters through learned merges.

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="250" fill="#fef3c7"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">BPE merges building "lower"</text>
  <g font-size="12" fill="#1e293b">
    <text x="40" y="70">start:</text>
    <rect x="100" y="52" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="108" y="70">l</text>
    <rect x="132" y="52" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="140" y="70">o</text>
    <rect x="164" y="52" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="172" y="70">w</text>
    <rect x="196" y="52" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="204" y="70">e</text>
    <rect x="228" y="52" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="236" y="70">r</text>
  </g>
  <g font-size="12" fill="#1e293b">
    <text x="40" y="130">merge lo, low:</text>
    <rect x="150" y="112" width="52" height="26" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/><text x="164" y="130">low</text>
    <rect x="208" y="112" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="216" y="130">e</text>
    <rect x="240" y="112" width="26" height="26" rx="4" fill="#eef2ff" stroke="#4f46e5"/><text x="248" y="130">r</text>
  </g>
  <g font-size="12" fill="#1e293b">
    <text x="40" y="190">final tokens:</text>
    <rect x="150" y="172" width="52" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a"/><text x="164" y="190">low</text>
    <rect x="208" y="172" width="40" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a"/><text x="218" y="190">er</text>
  </g>
  <text x="300" y="190" font-size="11" fill="#1e293b">2 tokens instead of 5 chars — common pieces reused.</text>
  <line x1="120" y1="82" x2="160" y2="112" stroke="#d97706" stroke-width="1.6" marker-end="url(#a23)"/>
  <line x1="180" y1="142" x2="180" y2="172" stroke="#d97706" stroke-width="1.6" marker-end="url(#a23)"/>
  <defs><marker id="a23" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker></defs>
</svg>
```

## 4. Architecture & Workflow

The tokenization pipeline from raw string to model input and back:

1. **Normalize** — apply Unicode normalization (e.g. NFKC), optional lowercasing/accent-stripping, and whitespace cleanup so equivalent strings map to the same bytes.
2. **Pre-tokenize** — split on whitespace/punctuation (or, for byte-level BPE, map to a reversible byte alphabet) to bound merge locations.
3. **Apply subword model** — run the learned merges (BPE), likelihood merges (WordPiece), or Viterbi segmentation (Unigram) to produce subword strings.
4. **Map to ids** — look up each subword in the vocabulary to get integer ids; unknown bytes never happen in byte-level schemes.
5. **Add special tokens** — insert `[CLS]`/`[SEP]` or `<s>`/`</s>` and pad/truncate to the model's context length; build an attention mask.
6. **Feed the model** — the id sequence indexes the embedding table; the model processes and predicts token ids.
7. **Decode** — map predicted ids back to subword strings and concatenate, reversing byte mapping and merges to recover text.

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="250" fill="#e0f2fe"/>
  <text x="20" y="26" font-size="15" fill="#1e293b" font-weight="bold">Text to token ids and back</text>
  <g font-size="10.5" fill="#1e293b">
    <rect x="20" y="90" width="90" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/><text x="34" y="118">raw text</text>
    <rect x="130" y="90" width="90" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="140" y="112">normalize</text><text x="150" y="128">+ split</text>
    <rect x="240" y="90" width="90" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/><text x="252" y="112">subword</text><text x="258" y="128">merges</text>
    <rect x="350" y="90" width="90" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="365" y="112">vocab</text><text x="360" y="128">lookup ids</text>
    <rect x="460" y="90" width="90" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="472" y="112">specials</text><text x="474" y="128">+ pad</text>
    <rect x="560" y="90" width="70" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/><text x="575" y="118">model</text>
  </g>
  <g stroke="#0ea5e9" stroke-width="1.8" fill="none">
    <line x1="110" y1="113" x2="130" y2="113" marker-end="url(#b23)"/>
    <line x1="220" y1="113" x2="240" y2="113" marker-end="url(#b23)"/>
    <line x1="330" y1="113" x2="350" y2="113" marker-end="url(#b23)"/>
    <line x1="440" y1="113" x2="460" y2="113" marker-end="url(#b23)"/>
    <line x1="550" y1="113" x2="560" y2="113" marker-end="url(#b23)"/>
  </g>
  <path d="M595 136 C 595 190, 65 190, 65 136" fill="none" stroke="#4f46e5" stroke-width="1.6" marker-end="url(#b23)"/>
  <text x="270" y="182" font-size="11" fill="#4f46e5">decode: ids to subwords to text</text>
  <defs><marker id="b23" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker></defs>
</svg>
```

## 5. Implementation

BPE merge-learning in a few lines to demystify it:

```python
from collections import Counter

def get_pairs(word):                       # word is a tuple of symbols
    return [(word[i], word[i+1]) for i in range(len(word)-1)]

corpus = {("l","o","w","</w>"): 5, ("l","o","w","e","s","t","</w>"): 2,
          ("n","e","w","e","r","</w>"): 6, ("w","i","d","e","r","</w>"): 3}

def merge(corpus, pair):
    a, b = pair; out = {}
    for word, freq in corpus.items():
        w, i = [], 0
        while i < len(word):
            if i < len(word)-1 and (word[i], word[i+1]) == pair:
                w.append(a+b); i += 2
            else:
                w.append(word[i]); i += 1
        out[tuple(w)] = freq
    return out

for _ in range(4):                         # learn 4 merges
    pairs = Counter()
    for word, freq in corpus.items():
        for p in get_pairs(word): pairs[p] += freq
    best = pairs.most_common(1)[0][0]
    corpus = merge(corpus, best)
    print("merged:", best)
# merged: ('e', 'r')  merged: ('l', 'o')  merged: ('lo', 'w') ...
```

Using a production tokenizer (Hugging Face) — the way you'll actually do it:

```python
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained("bert-base-uncased")
enc = tok("Tokenization shapes everything!", return_tensors="pt")
print(tok.convert_ids_to_tokens(enc["input_ids"][0]))
# ['[CLS]', 'token', '##ization', 'shapes', 'everything', '!', '[SEP]']
print(enc["input_ids"].shape, enc["attention_mask"].tolist())
# torch.Size([1, 7]) [[1, 1, 1, 1, 1, 1, 1]]
```

Counting tokens for an LLM (cost/context planning) with byte-level BPE:

```python
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")   # GPT-4 / 3.5 family
text = "The café's naïve résumé cost 3 tokens more than you think."
ids = enc.encode(text)
print(len(ids), ids[:6])          # 16 [791, 30129, 596, 46587, ...]
print(enc.decode(ids[:3]))        # 'The café'
# rule of thumb: ~1 token ≈ 4 English characters ≈ 0.75 words
```

> **Optimization:** Use the fast (Rust-backed) tokenizers — `AutoTokenizer(..., use_fast=True)` or `tiktoken` — which are 10–100× faster than pure-Python and support batch encoding. Pre-tokenize and cache token ids for static corpora so you never re-tokenize. Pad to the longest sequence *in the batch* (dynamic padding) rather than the model max to cut wasted compute, and use `truncation=True` with an explicit `max_length`.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Subword (BPE/WordPiece) | No OOV; compact vocab; handles morphology | Splits can be unintuitive; hurts arithmetic/spelling |
| Byte-level | Every string representable, language-agnostic | Non-English can cost many more tokens |
| Word-level | Simple, interpretable | Huge vocab, `<UNK>` on unseen words |
| Character-level | Tiny vocab, no OOV | Very long sequences, more compute |
| Larger vocab | Shorter sequences, more context per call | Bigger embedding table; rarer tokens undertrained |
| Smaller vocab | Better token utilization | Longer sequences, higher latency/cost |
| Fixed tokenizer | Deterministic, cacheable | Locked at pretraining; hard to change later |

## 7. Common Mistakes & Best Practices

1. ⚠️ Assuming "token" means "word" when estimating cost/context. ✅ Count real tokens with the model's tokenizer (`tiktoken`/HF).
2. ⚠️ Using a different tokenizer than the model was trained with. ✅ Always pair the exact tokenizer with its model.
3. ⚠️ Padding every batch to the model max length. ✅ Use dynamic padding to the batch max + attention masks.
4. ⚠️ Forgetting special tokens (`[CLS]`/`[SEP]`/`<s>`). ✅ Let the tokenizer add them (`add_special_tokens=True`).
5. ⚠️ Ignoring Unicode normalization → "café" (NFC) ≠ "café" (NFD) as different byte strings. ✅ Normalize consistently (NFC/NFKC).
6. ⚠️ Expecting reliable character-level tasks (reverse a word, count letters) from subword models. ✅ Know the tokenizer hides characters; add tools or char-level handling.
7. ⚠️ Truncating from the wrong end. ✅ Choose truncation side deliberately (keep the question, drop old context).
8. ⚠️ Blaming the model for bad non-English performance. ✅ Check token inflation; some languages cost 2–4× more tokens.
9. ⚠️ Adding new tokens without resizing the embedding matrix. ✅ Call `model.resize_token_embeddings(len(tokenizer))`.
10. ⚠️ Not accounting for special/system tokens in the context budget. ✅ Reserve tokens for template/system overhead.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When outputs look off, print the actual tokens (`convert_ids_to_tokens`) — you'll often find an unexpected split, a missing special token, or a normalization mismatch. Round-trip test: `decode(encode(x))` should recover `x` (byte-level BPE guarantees this; lossy normalization may not). Verify token counts match your cost expectations.

**Monitoring.** Track average tokens per request and per document (drives cost and latency), truncation rate (how often inputs exceed the window — a silent quality killer), and the distribution of sequence lengths for batching efficiency. Alert if truncation rate spikes after a data-source change.

**Security.** Tokenization is an attack surface: adversaries use homoglyphs, zero-width characters, and unusual Unicode to smuggle instructions past filters (prompt injection) or to evade moderation. Normalize aggressively and detect anomalous characters. "Token smuggling" and glitch tokens (rare, undertrained tokens) can trigger odd behavior — screen for them. Beware ReDoS in regex-based pre-tokenizers on adversarial input.

**Performance & Scaling.** Use Rust-backed fast tokenizers with batch/parallel encoding. Cache tokenized static corpora. Right-size the vocabulary at pretraining: too large bloats the embedding/output layers, too small inflates sequence length and cost. For multilingual systems, evaluate token fertility per language and consider a multilingual tokenizer to avoid penalizing some languages.

## 9. Interview Questions

**Q: Why do modern LLMs use subword tokenization instead of words or characters?**
A: Words require a massive vocabulary and still fail on unseen words (OOV); characters make sequences very long and force the model to learn everything from scratch. Subwords balance both — frequent words stay whole, rare words split into reusable pieces, and since pieces bottom out at bytes/characters, nothing is out-of-vocabulary.

**Q: How does Byte-Pair Encoding build its vocabulary?**
A: It starts from a base of characters/bytes, then repeatedly finds the most frequent adjacent symbol pair in the corpus, merges it into a new symbol, and records the merge rule. After `k` merges you have the vocabulary; encoding applies the learned merges greedily in order to any string.

**Q: How does WordPiece differ from BPE?**
A: Both are greedy bottom-up merges, but BPE merges the most *frequent* pair while WordPiece merges the pair that most increases corpus likelihood (roughly `freq(ab)/(freq(a)·freq(b))`). WordPiece (used by BERT) marks word-internal continuations with `##`.

**Q: What problem does byte-level tokenization solve?**
A: By operating on raw UTF-8 bytes, every possible input — any language, emoji, or unseen symbol — is representable with no `<UNK>` token, and decoding is exactly reversible. GPT models use byte-level BPE for this robustness; the cost is that non-Latin scripts may consume many more tokens.

**Q: Why can subword tokenization hurt arithmetic and spelling tasks?**
A: The model never sees individual digits or letters when they're merged into multi-character tokens, so "12345" might be one or two tokens rather than five digits, and letter-level operations (reverse a word, count 'r's) are obscured. The tokenizer hides the character structure the task needs.

**Q: What is the difference between tokens and words for cost estimation?**
A: You're billed and constrained per token, not per word. In English roughly 1 token ≈ 0.75 words or ~4 characters, but code, numbers, and non-English text tokenize very differently. Always count with the model's actual tokenizer rather than assuming a word count.

**Q: (Senior) Explain the Unigram language model tokenizer.**
A: It's top-down and probabilistic: it treats segmentation as latent, assigns each candidate token a probability, starts from a large vocabulary, and iteratively prunes tokens whose removal least decreases corpus likelihood (EM-style) until reaching the target size. At inference it picks the most probable segmentation via Viterbi. It's used by SentencePiece/T5.

**Q: (Senior) Why do some languages cost far more tokens than English on the same content?**
A: Tokenizer merges are learned from a corpus dominated by English, so English words compress into few tokens while under-represented scripts fall back to many short pieces or individual bytes. This "token fertility" gap means the same meaning costs 2–4× more tokens (and money, and context) in some languages — an equity and cost issue.

**Q: (Senior) What are glitch tokens and why do they cause weird model behavior?**
A: Glitch tokens are entries in the vocabulary that appeared in the tokenizer's training data but almost never in the model's training data (e.g. scraped usernames), so their embeddings are essentially untrained. Prompting them can produce bizarre, unstable outputs. They're a byproduct of training the tokenizer and model on mismatched corpora.

**Q: What special tokens exist and what are they for?**
A: Tokens like `[CLS]` (sequence representation), `[SEP]` (segment boundary), `<pad>` (padding), `<s>`/`</s>` (start/end), and `<|endoftext|>` (document boundary) give the model structural signals. They're reserved ids added around your content and must match what the model was trained with.

**Q: How do you add new domain-specific tokens to a pretrained model?**
A: Add them to the tokenizer with `add_tokens`, then resize the model's embedding matrix (`resize_token_embeddings`) so the new ids have (initially random) embeddings, and fine-tune so they're learned. This helps for frequent domain terms that would otherwise fragment into many subwords.

**Q: (Senior) How does tokenization interact with the context window and truncation strategy?**
A: The context window is measured in tokens, so tokenization determines how much text fits, and system/template tokens eat into the budget. When input exceeds the limit you must truncate or chunk; the truncation side matters (keep the question and recent context, drop stale history), and silent truncation is a common cause of quality regressions.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Models consume integer tokens, so text is normalized, pre-tokenized, split into subwords, mapped to vocabulary ids, wrapped with special tokens, and padded. Subword schemes — BPE (merge most frequent pair), WordPiece (merge most likelihood-increasing pair, BERT), Unigram (prune a large vocab, SentencePiece/T5) — eliminate OOV while keeping sequences short. Byte-level BPE makes any string representable. Tokenization drives cost, context length, multilingual fairness, and character-level weaknesses (arithmetic, spelling). Always use the model's own tokenizer, count real tokens, normalize consistently, and pad dynamically.

| Scheme | Selection rule | Used by |
|---|---|---|
| BPE | most frequent adjacent pair | GPT (byte-level), Llama |
| WordPiece | max likelihood gain (`##`) | BERT |
| Unigram | prune to max likelihood | SentencePiece, T5 |
| Byte-level | bytes as base alphabet | GPT / `tiktoken` |
| Rule of thumb | 1 tok ≈ 4 chars ≈ 0.75 words | English |

Flash cards:
- **What does BPE merge each step?** → The most frequent adjacent symbol pair.
- **Why no `<UNK>` in byte-level BPE?** → Every string decomposes to bytes.
- **BERT's tokenizer?** → WordPiece (continuations marked `##`).
- **Why is subword bad at spelling/math?** → Characters/digits are hidden inside merged tokens.
- **Cost is measured in?** → Tokens, not words.

## 11. Hands-On Exercises & Mini Project

- [ ] Train a BPE tokenizer on a corpus with Hugging Face `tokenizers` and inspect its merge list.
- [ ] Tokenize the same paragraph in English, Hindi, and code; compare token counts (token fertility).
- [ ] Round-trip test `decode(encode(x)) == x` and find a normalization case where it fails.
- [ ] Ask an LLM to reverse a word and count letters; explain the failures via tokenization.
- [ ] Add 20 domain tokens, resize embeddings, and measure the sequence-length reduction on domain text.

**Mini Project — Build and analyze a tokenizer.**
Goal: train a subword tokenizer from scratch and quantify its impact.
Requirements: (1) train BPE and Unigram tokenizers (via `tokenizers`/SentencePiece) on a chosen corpus at vocab sizes 8k/16k/32k; (2) measure average tokens per word and OOV rate; (3) compare how each splits rare/technical words; (4) plot vocab size vs sequence length trade-off; (5) write up which you'd ship and why.
Extensions: add byte-level fallback and verify no OOV; evaluate multilingual token fertility; measure downstream classification accuracy at each vocab size to connect tokenization to task performance.

## 12. Related Topics & Free Learning Resources

Related chapters: **Embeddings & Representation Learning** (token ids become vectors), **Attention & the Transformer** (consumes the token sequence), **RNNs, LSTMs & Sequence Models** (also tokenize inputs), and **Generative AI: Diffusion Models & GANs** (text encoders behind text-to-image start with tokenization).

**Free Learning Resources**
- **Hugging Face NLP Course — Tokenizers** — Hugging Face · *Beginner→Intermediate* · hands-on BPE/WordPiece/Unigram with runnable code. <https://huggingface.co/learn/nlp-course/chapter6>
- **Neural Machine Translation of Rare Words with Subword Units (BPE)** — Sennrich et al. (2016) · *Advanced* · the paper that brought BPE to NLP. <https://arxiv.org/abs/1508.07909>
- **Let's build the GPT Tokenizer** — Andrej Karpathy · *Intermediate* · builds byte-level BPE (`tiktoken`-style) from scratch on video. <https://www.youtube.com/watch?v=zduSFxRajkE>
- **SentencePiece** — Kudo & Richardson (Google) · *Intermediate* · language-agnostic Unigram/BPE tokenizer and paper. <https://github.com/google/sentencepiece>
- **tiktoken** — OpenAI · *Reference* · fast byte-level BPE used by GPT models; great for token counting. <https://github.com/openai/tiktoken>
- **CS224n: Subword Models** — Stanford · *Advanced* · lecture on subword and character-level modeling. <https://web.stanford.edu/class/cs224n/>
- **The Tokenizer Playground / tokenizer viz** — Hugging Face Spaces · *Beginner* · see exactly how text splits across different tokenizers. <https://huggingface.co/spaces/Xenova/the-tokenizer-playground>

---

*AI Engineering Handbook — chapter 23.*
