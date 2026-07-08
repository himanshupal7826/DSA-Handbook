# 46 · AI System Design (Interview)

> **In one line:** A repeatable framework for designing production AI systems end to end — worked through a RAG chatbot and a recommender — plus how to actually run the 45-minute interview.

---

## 1. Overview

An AI system design interview is a machine-learning design interview with the messy realities of LLMs bolted on: nondeterministic outputs, token-based costs that dwarf CPU costs, retrieval and grounding, evaluation without labels, and safety. The interviewer is not testing whether you can invent a novel architecture; they are testing whether you can take a vague prompt ("design a customer-support chatbot") and drive it to a concrete, justified, production-ready system while narrating your trade-offs. **AI system design** as a skill is the ability to move from ambiguous requirements to a diagram with data flows, model choices, latency and cost budgets, an evaluation plan, and a scaling story — and to defend every decision.

The problem it solves in real life is coordination and risk. A production AI feature touches data engineering (ingest, chunking, embeddings), infrastructure (vector DB, model serving, caching), ML (retrieval quality, ranking, fine-tuning), product (latency, UX, fallbacks), and governance (evaluation, guardrails, cost). Without a shared design, teams build a demo that works on ten queries and collapses at scale, or burns the budget on GPT-4-class calls for tasks a small model handles. The framework in this chapter is the same one you use on the job; the interview is just a compressed rehearsal.

Historically the discipline borrowed the classic "requirements → high-level design → deep dive → scale" flow from distributed-systems interviews (popularized by *Designing Data-Intensive Applications* and the ML-design books), then added the LLM-specific layers — RAG, prompt/version management, LLM-as-judge evaluation, and guardrails — as those patterns matured from 2023 onward.

A concrete example we'll carry through the chapter: **design a RAG-based support chatbot for a SaaS company** with a 50,000-document knowledge base, a p95 latency target of 3 seconds, a budget of a few cents per conversation, and a hard requirement that it never fabricate policy. By the end you should be able to draw the ingest pipeline, the online serving path, the caching and fallback strategy, the eval harness, and the cost model — and say what you'd cut if the budget halved. We'll also contrast it with a **recommender**, which trades open-ended generation for ranking at scale, to show how the framework flexes.

## 2. Core Concepts

- **Functional vs non-functional requirements** — *what* the system does (answer questions, rank items) vs the *constraints* (latency, cost, availability, freshness, safety).
- **RAG (Retrieval-Augmented Generation)** — grounding an LLM's answer in documents fetched at query time so it cites real sources instead of hallucinating.
- **Two-stage retrieval** — a cheap recall stage (vector/BM25) fetches many candidates, then a precise reranker (cross-encoder) reorders the top-k.
- **Candidate generation + ranking** — the recommender analogue: fast retrieval of a candidate set, then a heavier model scores and orders it.
- **Latency budget** — the p95/p99 end-to-end time allocation split across retrieval, generation, and guardrails.
- **Cost per request** — dominated by LLM tokens; modeled as `(input + output tokens) × price`, tuned via model tiering, caching, and prompt size.
- **Semantic cache** — returns a stored answer when a new query is embedding-close to a previous one, cutting cost and latency.
- **Model tiering / routing** — sending easy queries to a small cheap model and hard ones to a large model to optimize cost/quality.
- **Offline vs online metrics** — offline (retrieval recall@k, faithfulness) predict quality pre-launch; online (deflection rate, CSAT, CTR) measure real impact.
- **Fallback & graceful degradation** — what the system does when retrieval finds nothing or the model times out (escalate to human, cached answer, "I don't know").

## 3. Theory & Mathematical Intuition

The two quantities you must be able to reason about numerically are **latency** and **cost**, because they turn hand-wavy design into engineering.

**Latency** is additive along the critical path and you care about tails, not means. For the RAG bot:

```
p95_total ≈ p95_embed + p95_retrieve + p95_rerank + p95_generate + p95_guardrail
```

Generation dominates and scales roughly linearly with output tokens (streaming hides it from the *perceived* latency but not the total). If your budget is 3s and generation of a 300-token answer costs ~1.8s, retrieval+rerank+guardrails must fit in ~1.2s — which forces an ANN index and a fast reranker.

**Cost** per conversation is a sum over model calls:

```
cost = Σ_calls ( n_input × p_in + n_output × p_out )
```

Two levers dominate: shrink `n_input` (retrieve fewer/shorter chunks, cache, compress the system prompt) and route to cheaper models when quality allows. A semantic cache with hit rate `h` reduces effective cost to `(1 - h) × cost_uncached + h × cost_cache`, and cache lookups are ~1000× cheaper than generation, so even `h = 0.3` is a large win.

**Retrieval quality** is measured by recall@k and precision. Embedding search returns the `k` nearest neighbors under cosine similarity:

```
sim(q, d) = (q · d) / (||q|| ||d||)
```

Approximate nearest-neighbor (HNSW, IVF) trades a little recall for sub-linear query time; the tuning knob (`efSearch`/`nprobe`) is a recall-vs-latency dial. For recommenders the same math powers candidate generation, then a learned ranker optimizes a business objective (e.g., predicted engagement) rather than similarity alone.

**Capacity**: throughput follows Little's Law, `concurrency = arrival_rate × latency`. At 50 requests/s and 3s latency you need ~150 concurrent slots — which sizes your model-serving fleet and vector-DB replicas.

```svg
<svg viewBox="0 0 700 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="700" height="260" fill="#ffffff"/>
  <text x="350" y="28" fill="#1e293b" font-size="15" font-weight="bold" text-anchor="middle">Latency budget: 3s p95 broken down (streaming hides generation tail)</text>
  <rect x="60" y="70" width="90" height="40" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="105" y="95" fill="#1e293b" font-size="12" text-anchor="middle">embed .1s</text>
  <rect x="150" y="70" width="120" height="40" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="210" y="95" fill="#1e293b" font-size="12" text-anchor="middle">retrieve .3s</text>
  <rect x="270" y="70" width="120" height="40" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="330" y="95" fill="#1e293b" font-size="12" text-anchor="middle">rerank .4s</text>
  <rect x="390" y="70" width="220" height="40" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="500" y="95" fill="#1e293b" font-size="12" text-anchor="middle">generate ~1.8s (streamed)</text>
  <line x1="60" y1="130" x2="610" y2="130" stroke="#1e293b" stroke-width="2"/>
  <text x="60" y="150" fill="#1e293b" font-size="11">0s</text>
  <text x="590" y="150" fill="#1e293b" font-size="11">~2.6s + guardrail</text>
  <text x="105" y="185" fill="#1e293b" font-size="12" text-anchor="middle">first token at ~0.8s</text>
  <line x1="390" y1="115" x2="390" y2="175" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>
  <text x="350" y="215" fill="#1e293b" font-size="13" text-anchor="middle">Cost lever: cut input tokens (fewer/shorter chunks) + route small model for easy queries</text>
</svg>
```

## 4. Architecture & Workflow

Run every AI design interview through the same five-phase framework, then deep-dive where the interviewer pushes.

1. **Clarify requirements (3–5 min).** Pin functional scope (Q&A? actions? languages?) and non-functionals (QPS, p95 latency, cost ceiling, freshness, safety bar). State assumptions out loud: "I'll assume 50k docs, 50 QPS peak, 3s p95, must cite sources."
2. **Sketch the high-level design (5–8 min).** Draw two paths. **Offline ingest:** load docs → clean → chunk → embed → upsert to vector DB (+ metadata). **Online serving:** query → embed → retrieve top-k → rerank → build prompt with context → LLM generate → guardrail → respond, streaming.
3. **Deep dive on the hard parts (15–20 min).** Chunking strategy and size; hybrid retrieval (vector + BM25) and reranking; prompt construction and grounding instructions; caching (semantic + exact); model tiering/routing; fallback when retrieval is empty or the model errors.
4. **Evaluation & guardrails (5 min).** Offline: retrieval recall@k and faithfulness on a golden set gating deploys. Online: deflection rate, CSAT, escalation rate. Guardrails: injection detection, PII/secret output scan, "answer only from context" grounding.
5. **Scale, cost & failure modes (5 min).** Capacity via Little's Law, autoscaling model servers and vector-DB replicas, cost model with cache hit rate, and graceful degradation (cached answer, "I don't know," human handoff).

```svg
<svg viewBox="0 0 740 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="740" height="340" fill="#ffffff"/>
  <text x="180" y="28" fill="#1e293b" font-size="14" font-weight="bold" text-anchor="middle">Offline ingest</text>
  <rect x="30" y="45" width="90" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="75" y="70" fill="#1e293b" font-size="12" text-anchor="middle">docs</text>
  <rect x="140" y="45" width="90" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="185" y="70" fill="#1e293b" font-size="12" text-anchor="middle">chunk</text>
  <rect x="250" y="45" width="90" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="295" y="70" fill="#1e293b" font-size="12" text-anchor="middle">embed</text>
  <rect x="360" y="45" width="110" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="415" y="70" fill="#1e293b" font-size="12" text-anchor="middle">vector DB</text>
  <line x1="120" y1="65" x2="138" y2="65" stroke="#1e293b" stroke-width="2"/>
  <line x1="230" y1="65" x2="248" y2="65" stroke="#1e293b" stroke-width="2"/>
  <line x1="340" y1="65" x2="358" y2="65" stroke="#1e293b" stroke-width="2"/>
  <text x="360" y="140" fill="#1e293b" font-size="14" font-weight="bold" text-anchor="middle">Online serving</text>
  <rect x="30" y="160" width="90" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="75" y="187" fill="#1e293b" font-size="12" text-anchor="middle">query</text>
  <rect x="140" y="160" width="100" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="190" y="180" fill="#1e293b" font-size="11" text-anchor="middle">semantic</text>
  <text x="190" y="196" fill="#1e293b" font-size="11" text-anchor="middle">cache?</text>
  <rect x="260" y="160" width="100" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="310" y="180" fill="#1e293b" font-size="11" text-anchor="middle">retrieve +</text>
  <text x="310" y="196" fill="#1e293b" font-size="11" text-anchor="middle">rerank</text>
  <rect x="380" y="160" width="100" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="430" y="180" fill="#1e293b" font-size="11" text-anchor="middle">LLM</text>
  <text x="430" y="196" fill="#1e293b" font-size="11" text-anchor="middle">generate</text>
  <rect x="500" y="160" width="100" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="550" y="180" fill="#1e293b" font-size="11" text-anchor="middle">guardrail</text>
  <text x="550" y="196" fill="#1e293b" font-size="11" text-anchor="middle">+ cite</text>
  <line x1="120" y1="182" x2="138" y2="182" stroke="#1e293b" stroke-width="2"/>
  <line x1="240" y1="182" x2="258" y2="182" stroke="#1e293b" stroke-width="2"/>
  <line x1="360" y1="182" x2="378" y2="182" stroke="#1e293b" stroke-width="2"/>
  <line x1="480" y1="182" x2="498" y2="182" stroke="#1e293b" stroke-width="2"/>
  <line x1="600" y1="182" x2="640" y2="182" stroke="#16a34a" stroke-width="2"/>
  <text x="675" y="186" fill="#16a34a" font-size="12">reply</text>
  <line x1="415" y1="85" x2="310" y2="158" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 5"/>
  <line x1="190" y1="204" x2="230" y2="230" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 5"/>
  <text x="300" y="250" fill="#1e293b" font-size="12" text-anchor="middle">cache hit short-circuits to reply</text>
  <rect x="120" y="280" width="500" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="370" y="305" fill="#1e293b" font-size="13" text-anchor="middle">Fallback: empty retrieval or timeout to "I don't know" / human handoff</text>
</svg>
```

## 5. Implementation

A compact, realistic serving path for the RAG bot: two-stage retrieval, grounded prompt, and a cost estimate. Uses illustrative clients you'd swap for your stack.

```python
from dataclasses import dataclass

@dataclass
class Chunk:
    text: str
    source: str
    score: float

def retrieve(query_vec, vector_db, k=20) -> list[Chunk]:
    # Stage 1: cheap ANN recall — many candidates.
    return vector_db.search(query_vec, k=k)  # returns Chunks by cosine sim

def rerank(query: str, chunks: list[Chunk], cross_encoder, top_n=4) -> list[Chunk]:
    # Stage 2: precise but costlier cross-encoder reorders, keep top_n.
    scored = cross_encoder.score(query, [c.text for c in chunks])
    for c, s in zip(chunks, scored):
        c.score = s
    return sorted(chunks, key=lambda c: c.score, reverse=True)[:top_n]

def build_prompt(query: str, context: list[Chunk]) -> str:
    blocks = "\n\n".join(f"[{i+1}] (source: {c.source})\n{c.text}"
                         for i, c in enumerate(context))
    return (
        "Answer ONLY using the context below. If the answer is not present, "
        "say you don't know. Cite sources as [n].\n\n"
        f"CONTEXT:\n{blocks}\n\nQUESTION: {query}"
    )
```

```python
from anthropic import Anthropic
client = Anthropic()

def answer(query: str, query_vec, vdb, cross_encoder) -> dict:
    cands = retrieve(query_vec, vdb, k=20)
    if not cands:                                  # fallback: nothing retrieved
        return {"text": "I don't have information on that. Escalating to support.",
                "sources": []}
    ctx = rerank(query, cands, cross_encoder, top_n=4)
    prompt = build_prompt(query, ctx)
    msg = client.messages.create(
        model="claude-sonnet-4",                   # tier: sonnet for support Q&A
        max_tokens=400, temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )
    return {"text": msg.content[0].text, "sources": [c.source for c in ctx]}
```

A back-of-envelope cost model you can recite in the interview:

```python
def conversation_cost(n_turns=4, ctx_tokens=1500, out_tokens=300,
                      p_in=3e-6, p_out=15e-6, cache_hit=0.3):
    per_turn = ctx_tokens * p_in + out_tokens * p_out
    uncached = n_turns * per_turn
    return round(uncached * (1 - cache_hit), 4)  # cache short-circuits some turns

print(conversation_cost())  # ~0.0165  -> about 1.6 cents per conversation
```

> **Optimization:** The three highest-leverage moves are (1) **model tiering** — classify query difficulty and send FAQ-style questions to a small model, reserving the large model for complex ones, often halving cost; (2) **semantic caching** — even a 30% hit rate cuts cost and latency proportionally; (3) **prompt-context trimming** — reranking down to the top 3–4 chunks instead of stuffing 20 slashes input tokens (the dominant cost term) without hurting faithfulness, because more context often *lowers* precision.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| RAG over fine-tuning | Fresh, cite-able, cheap to update | Retrieval quality caps answer quality; more infra |
| Two-stage retrieval | High recall + high precision | Reranker adds latency and cost |
| Semantic cache | Big cost/latency win | Stale answers; false hits on near-duplicate-but-different queries |
| Model tiering | Cuts cost substantially | Routing errors send hard queries to weak models |
| Streaming responses | Great perceived latency | Total latency unchanged; harder to guardrail mid-stream |
| Recommender (retrieval+rank) | Scales to billions of items | Cold-start; feedback-loop bias |
| Human fallback | Safety net, protects trust | Ops cost; must detect when to escalate |

## 7. Common Mistakes & Best Practices

1. ⚠️ Jumping to architecture before clarifying requirements → ✅ Spend the first minutes pinning QPS, latency, cost, and safety; state assumptions aloud.
2. ⚠️ Proposing fine-tuning for a knowledge problem → ✅ Use RAG for facts that change; fine-tune only for style/format/behavior.
3. ⚠️ Stuffing 20 chunks into the prompt → ✅ Rerank to the top 3–4; more context lowers precision and raises cost.
4. ⚠️ Ignoring cost and latency numbers → ✅ Put real numbers on the board — token cost, p95 budget, capacity via Little's Law.
5. ⚠️ No evaluation plan → ✅ Name offline (recall@k, faithfulness) and online (deflection, CSAT) metrics and how they gate deploys.
6. ⚠️ Forgetting the empty-retrieval / timeout path → ✅ Design explicit fallbacks: "I don't know," cached answer, human handoff.
7. ⚠️ One model for everything → ✅ Tier/route by query difficulty to balance cost and quality.
8. ⚠️ Skipping guardrails in the design → ✅ Include injection detection and output PII/secret scanning as part of the serving path.
9. ⚠️ Treating the vector DB as free and infinite → ✅ Account for index build time, memory, replicas, and re-embedding on model change.
10. ⚠️ Silent one-way monologue → ✅ Narrate trade-offs continuously and invite the interviewer to steer; it's a collaboration.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Trace every request end to end: log the query, retrieved chunks with scores, the final prompt, the model output, and guardrail verdicts. Most "the bot lied" bugs are retrieval failures — the right document was never fetched — so always inspect the context before blaming the model. Keep a replayable trace so you can reproduce a bad conversation deterministically (fix the retrieved set, re-run generation).

**Monitoring.** Track p50/p95/p99 latency per stage, cost per conversation, cache hit rate, retrieval recall on a shadow set, faithfulness sampled online, deflection/escalation rate, and error/timeout rates. Alert on latency and cost regressions after any model or prompt change. Dashboards should separate retrieval health from generation health.

**Security.** Everything from ch. 45 applies: treat retrieved content as untrusted (it can carry indirect injection), scan outputs for PII/secret leakage, enforce per-user authorization on which documents are retrievable (a support agent must not retrieve another tenant's docs), and rate-limit. Store no secrets in prompts.

**Scaling.** Size the fleet with Little's Law (`concurrency = QPS × latency`), autoscale model servers on queue depth, and replicate the vector DB for read throughput. Batch embeddings for ingest. Handle re-embedding as a migration when you change embedding models (dual-write both indexes, cut over). For recommenders, precompute candidate sets offline and keep only ranking online. Degrade gracefully under load: shed the reranker or serve cached answers before dropping requests.

## 9. Interview Questions

**Q: How do you start an AI system design interview?**
A: Clarify requirements before designing: functional scope (Q&A vs actions, languages), and non-functionals (QPS, p95 latency, cost ceiling, freshness, safety bar). State explicit assumptions out loud so the interviewer can correct scope early, then sketch the high-level design.

**Q: When do you choose RAG over fine-tuning?**
A: RAG for knowledge that changes or must be cited — it's fresh, updatable by editing documents, and grounds answers in sources. Fine-tuning for teaching style, format, or behavior the model should internalize. They compose: fine-tune for how to answer, RAG for what facts to use.

**Q: Why two-stage retrieval instead of just top-k vector search?**
A: Vector search gives high recall cheaply but imprecise ordering; a cross-encoder reranker is accurate but too slow to run over the whole corpus. Stage one recalls ~20 candidates, stage two reranks to the best 3–4, combining recall and precision within the latency budget.

**Q: How do you estimate cost per conversation?**
A: Sum over model calls: `(input_tokens × price_in + output_tokens × price_out)` per turn, times turns, adjusted by cache hit rate. Input tokens (context chunks + system prompt) usually dominate, so trimming context and caching are the biggest levers, along with routing easy turns to a cheaper model.

**Q: What's your latency budget approach for a 3-second p95 target?**
A: Break it additively across embed, retrieve, rerank, generate, and guardrail stages and design each to fit. Generation dominates, so use streaming to improve *perceived* latency (first token fast), an ANN index for sub-second retrieval, and a lightweight reranker. Measure p95/p99, not the mean.

**Q: How do you evaluate the chatbot before and after launch?**
A: Offline, gate deploys on retrieval recall@k and faithfulness over a versioned golden set. Online, track deflection rate, CSAT, escalation rate, and sampled faithfulness. Combine both: offline predicts quality, online measures real impact and catches distribution shift.

**Q: (Senior) The bot occasionally fabricates policy. Walk me through diagnosis and fixes.**
A: First check retrieval — log the fetched chunks; if the correct doc wasn't retrieved, fix chunking/embeddings/hybrid search, not the prompt. If it was retrieved but ignored, strengthen grounding instructions ("answer only from context, cite [n]"), lower temperature, and add a faithfulness output guardrail that blocks unsupported claims. Add the failing case to the eval set as a regression test.

**Q: (Senior) Design a recommender and contrast it with the RAG bot.**
A: A recommender is candidate-generation plus ranking: fast retrieval (ANN over item embeddings, co-visitation) yields hundreds of candidates, then a learned ranker scores them against a business objective (predicted engagement/conversion), with filters for freshness and diversity. Versus RAG it replaces open-ended generation with ranking, operates at far larger item scale, is trained on implicit feedback (clicks), and its key risks are cold-start and feedback-loop bias rather than hallucination.

**Q: (Senior) Your traffic 10x's overnight. What breaks and what do you do?**
A: The LLM-serving fleet and vector DB saturate first. Apply Little's Law to resize concurrency, autoscale model servers on queue depth, add vector-DB read replicas, and raise the semantic-cache hit rate. Under sustained load, degrade gracefully — drop the reranker, serve cached answers, or queue with backpressure — before shedding requests, and route more traffic to cheaper models to hold cost.

**Q: How do you handle the empty-retrieval case?**
A: Never force an answer. If retrieval returns nothing above a similarity threshold, respond "I don't have information on that" and offer a human handoff or a clarifying question. Forcing generation on empty context is the primary hallucination trigger.

**Q: What guardrails belong in the serving path?**
A: Input-side injection/PII detection before the model, and output-side scanning for secrets, PII, and grounding (answer supported by context) before returning. Plus per-user authorization on retrievable documents so tenants can't read each other's data.

**Q: How do you decide chunk size?**
A: Balance retrieval precision against context completeness: chunks too small lose surrounding meaning, too large dilute the embedding and waste input tokens. Start around a few hundred tokens with overlap, then tune empirically against retrieval recall and answer faithfulness on your golden set.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Drive the interview through five phases: clarify requirements (QPS, p95, cost, safety), sketch high-level design (offline ingest: chunk→embed→vector DB; online: query→retrieve→rerank→generate→guardrail), deep-dive the hard parts (chunking, hybrid retrieval + reranking, caching, model tiering, fallbacks), state an evaluation plan (offline recall@k + faithfulness gating deploys; online deflection/CSAT), and finish with scale/cost/failure (Little's Law, autoscaling, cache hit rate, graceful degradation). Put real numbers on the board — token cost and latency budgets — prefer RAG for facts and fine-tuning for behavior, rerank to a few chunks, and always design the empty-retrieval/timeout fallback. Narrate trade-offs throughout.

**Cheat sheet.**

| Phase | Deliverable |
| --- | --- |
| Requirements | QPS, p95, cost ceiling, safety bar |
| High-level | Ingest + serving diagram |
| Deep dive | Chunking, hybrid retrieval, rerank, cache, tiering |
| Evaluation | recall@k, faithfulness / deflection, CSAT |
| Scale & cost | Little's Law, autoscale, cache hit, fallback |

**Flash cards.**
- **RAG vs fine-tune** → RAG for changing facts; fine-tune for style/behavior.
- **Two-stage retrieval** → Cheap ANN recall then precise cross-encoder rerank.
- **Cost driver** → Input tokens dominate; trim context, cache, tier models.
- **Little's Law** → concurrency = QPS × latency; sizes the fleet.
- **Empty retrieval** → Say "I don't know" / escalate; never force an answer.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a one-page requirements doc (functional + non-functional) for a support chatbot, with explicit assumptions.
- [ ] Build a cost model spreadsheet/function and find the cache hit rate needed to hit a 1-cent-per-conversation target.
- [ ] Implement two-stage retrieval (ANN + a cross-encoder rerank) and measure recall@k before and after reranking.
- [ ] Add a semantic cache and measure the latency and cost reduction at a realistic hit rate.
- [ ] Draw the full architecture diagram from memory in under 5 minutes, including fallbacks.

**Mini Project — End-to-end RAG support bot with an eval and cost report.**
*Goal:* build the SaaS support bot from this chapter and produce the artifacts an interviewer would want.
*Requirements:* (1) ingest pipeline (chunk → embed → vector DB) over a real doc set; (2) serving path with two-stage retrieval, grounded prompt, and streaming; (3) semantic cache + model tiering; (4) an eval harness scoring retrieval recall@k and faithfulness on a golden set; (5) a cost-and-latency report with p95 and per-conversation cost.
*Extensions:* add per-tenant authorization on retrieval; add guardrails (injection + output PII scan); build a query-difficulty router and quantify the cost saving; add a recommender-style "related articles" module to contrast the two designs.

## 12. Related Topics & Free Learning Resources

Related chapters: **RAG (Retrieval-Augmented Generation)**, **Vector Databases & Embeddings**, **LLM Evaluation & Guardrails** (ch. 43), **AI Security & Red-Teaming** (ch. 45), **AI Agents & Tool Use**, **Model Serving & Inference Optimization**.

**Free Learning Resources.**
- **Designing Data-Intensive Applications (concepts)** — Martin Kleppmann · *Advanced* · the systems-thinking foundation (companion material and talks are free). <https://martin.kleppmann.com/>
- **RAG best practices** — Anthropic Docs · *Intermediate* · practical guidance on retrieval, context, and citations for production. <https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips>
- **Building RAG-based LLM Applications for Production** — Anyscale/Ray blog · *Advanced* · a full production RAG walkthrough with evaluation and scaling. <https://www.anyscale.com/blog/a-comprehensive-guide-for-building-rag-based-llm-applications-part-1>
- **Full Stack Deep Learning** — FSDL course · *Intermediate* · free lectures on ML system design, deployment, and monitoring. <https://fullstackdeeplearning.com/course/>
- **Machine Learning System Design** — Chip Huyen (Stanford CS329S notes) · *Intermediate* · the reference for ML design interviews and production ML. <https://stanford-cs329s.github.io/>
- **FAISS documentation** — Meta AI · *Intermediate* · how ANN indexes (IVF, HNSW) trade recall for latency. <https://faiss.ai/>
- **Pinecone Learning Center** — Pinecone · *Beginner* · clear explainers on embeddings, vector search, and RAG patterns. <https://www.pinecone.io/learn/>

---

*AI Engineering Handbook — chapter 46.*
