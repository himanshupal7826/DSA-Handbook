# 34 · Agent Memory & State

> **In one line:** An agent's context window is short-term memory that fills and forgets; durable memory comes from deliberately summarizing, storing, and retrieving state so long-running agents stay coherent without exceeding the window.

---

## 1. Overview

An LLM is stateless. Each API call sees only what you put in the prompt; nothing persists between calls unless you resend it. For a one-shot answer that's fine, but an agent that works for hours — or a chatbot a user returns to next week — needs **memory**: a way to carry relevant state forward without pasting the entire history into every request.

There are two distinct problems. The first is **short-term memory management**: the conversation grows every turn, and eventually it approaches the context window (1M tokens on current Claude models, but attention and cost degrade well before that). You must compress or prune the history so the agent keeps the information it needs and drops what it doesn't. The second is **long-term memory**: information that must survive across sessions — user preferences, learned facts, a project's accumulated state — which can't live in a single conversation at all and must be written to durable storage and retrieved on demand.

The motivation is coherence over time. Without memory management, a long agent run hits the window and either errors or silently loses its earliest instructions — a phenomenon where the model "forgets" the original goal mid-task. Without long-term memory, every session starts from zero: the assistant that knew your name yesterday is a stranger today.

The techniques evolved from naive "keep the last N messages" truncation into a layered system: a **scratchpad** for the agent's working notes, **summarization/compaction** to compress old turns into dense summaries, and **retrieval-backed memory** where facts are embedded and pulled back in only when relevant. A concrete example: a research agent tasked with a multi-day literature review keeps a running scratchpad of findings, compacts old tool outputs it no longer needs into a summary block, and writes durable notes to a memory file it re-reads at the start of each session. That layered design — knowing what to keep in context, what to compress, and what to externalize — is the craft of agent memory.

---

## 2. Core Concepts

- **Context window** — the fixed token budget for a single request; the agent's short-term memory. Everything the model "knows" this turn is in here.
- **Short-term memory** — the live conversation and tool results held in the current context; volatile, lost when the session ends.
- **Long-term memory** — state persisted outside the context (files, a database, a vector store) and retrieved into future sessions.
- **Scratchpad** — a working-notes area (a file or a running message) where the agent records intermediate reasoning, plans, and findings.
- **Summarization / compaction** — compressing older turns into a dense summary so the conversation fits the window while retaining meaning.
- **Context editing** — *clearing* stale content (old tool results, thinking blocks) from the transcript, as opposed to summarizing it.
- **Retrieval-backed memory** — embedding stored facts and pulling only the relevant ones back into context (RAG applied to memory).
- **Working memory vs. episodic memory** — working memory is the current task's active state; episodic memory is a log of past interactions the agent can recall.
- **Memory tool** — a client-side tool that lets the model read/write a persistent memory directory across sessions.

---

## 3. Theory & Mathematical Intuition

The governing constraint is a budget inequality. Let `W` be the context window, `S` the fixed system prompt and tool definitions, `H_t` the conversation history after `t` turns, and `R` the room reserved for the model's response. Every request must satisfy:

```
tokens(S) + tokens(H_t) + tokens(R) ≤ W
```

`H_t` grows monotonically — each turn appends the model's output plus tool results — so this inequality is eventually violated. Memory management is the set of operations that keep `tokens(H_t)` bounded while preserving the information the agent needs.

Three operations reduce `tokens(H_t)`:

```
truncate:   H_t → last N messages            (cheap, lossy, forgets the goal)
compact:    H_t → summary(old) ⊕ recent      (LLM call, lossy-but-semantic)
edit:       H_t → H_t minus stale tool_uses  (cheap, targeted, preserves structure)
```

The intuition behind *why summarization beats truncation* is information density. Truncation drops whole messages regardless of importance — it might discard the original task while keeping a routine tool result. Summarization is a lossy compression that preserves *meaning per token*: a 20,000-token stretch of tool outputs might compress to a 400-token summary that keeps the conclusions and drops the raw data. The compression ratio you can afford depends on how much of the old context is genuinely reusable.

Long-term memory reframes the problem as retrieval. Instead of keeping everything in `H_t`, you store facts externally and fetch only those relevant to the current query. The recall model is the same as RAG (Chapter 31): a fact is retrieved if its embedding is close to the query embedding. This trades perfect recall for a bounded context — you accept that a fact you didn't retrieve is effectively forgotten this turn, in exchange for never blowing the budget.

The deep tension is **relevance vs. completeness**. Keep too much and you hit the window and dilute attention (the model attends worse to any single fact when the context is huge); keep too little and the agent loses coherence. Good memory design is continuous triage: what does *this* turn actually need?

```svg
<svg viewBox="0 0 720 310" width="100%" height="310" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="310" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Context budget under a growing conversation</text>
  <rect x="60" y="60" width="180" height="200" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="150" y="52" font-size="12" fill="#1e293b" text-anchor="middle">before compaction</text>
  <rect x="60" y="60" width="180" height="30" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="150" y="80" font-size="11" fill="#1e293b" text-anchor="middle">system + tools (S)</text>
  <rect x="60" y="90" width="180" height="140" fill="#fef3c7" stroke="#d97706"/>
  <text x="150" y="150" font-size="11" fill="#1e293b" text-anchor="middle">history H_t (growing)</text>
  <text x="150" y="168" font-size="11" fill="#1e293b" text-anchor="middle">old tool results</text>
  <rect x="60" y="230" width="180" height="30" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="150" y="250" font-size="11" fill="#1e293b" text-anchor="middle">response room (R)</text>
  <text x="150" y="278" font-size="11" fill="#dc2626" text-anchor="middle">overflowing the window</text>
  <text x="360" y="160" font-size="26" fill="#1e293b" text-anchor="middle">→</text>
  <rect x="470" y="60" width="180" height="200" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="560" y="52" font-size="12" fill="#1e293b" text-anchor="middle">after compaction</text>
  <rect x="470" y="60" width="180" height="30" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="560" y="80" font-size="11" fill="#1e293b" text-anchor="middle">system + tools (S)</text>
  <rect x="470" y="90" width="180" height="44" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="560" y="110" font-size="11" fill="#1e293b" text-anchor="middle">summary of old turns</text>
  <text x="560" y="126" font-size="11" fill="#1e293b" text-anchor="middle">(dense, lossy)</text>
  <rect x="470" y="134" width="180" height="76" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="176" font-size="11" fill="#1e293b" text-anchor="middle">recent turns (kept)</text>
  <rect x="470" y="210" width="180" height="50" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="560" y="240" font-size="11" fill="#1e293b" text-anchor="middle">response room (R)</text>
  <text x="560" y="292" font-size="11" fill="#16a34a" text-anchor="middle">fits within W</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Reserve the fixed budget.** Account for the system prompt, tool definitions, and response room; the rest is available for history.
2. **Append each turn.** Add the model's output and tool results to the conversation as normal.
3. **Watch the threshold.** Track `tokens(H_t)`; when it crosses a trigger (e.g. 70% of the window), fire a memory operation.
4. **Compact old context.** Summarize the oldest reusable turns into a dense summary block; keep the most recent turns verbatim. Preserve any provider-issued compaction/summary blocks and pass them back on the next request.
5. **Edit stale content.** Alternatively (or additionally) clear old tool results and thinking blocks that are no longer relevant, keeping the conversation structure intact.
6. **Maintain a scratchpad.** Let the agent write plans and findings to a working-notes area it can re-read, so key state survives compaction.
7. **Externalize durable facts.** Write cross-session state (preferences, learned facts, project status) to long-term storage — a memory file or a vector store.
8. **Retrieve on demand.** At the start of a session or when relevant, pull long-term memories back into context (read the memory file, or embed the query and fetch matching facts).
9. **Loop.** Continue the agent loop with the bounded, refreshed context.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Layered memory architecture</text>
  <rect x="250" y="50" width="220" height="52" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="72" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">short-term (context window)</text>
  <text x="360" y="90" font-size="11" fill="#1e293b" text-anchor="middle">live conversation + tool results</text>
  <rect x="60" y="150" width="180" height="60" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="150" y="174" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">scratchpad</text>
  <text x="150" y="192" font-size="11" fill="#1e293b" text-anchor="middle">plans, running notes</text>
  <rect x="270" y="150" width="180" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="360" y="174" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">compaction</text>
  <text x="360" y="192" font-size="11" fill="#1e293b" text-anchor="middle">summarize / edit stale</text>
  <rect x="480" y="150" width="180" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="570" y="174" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">long-term store</text>
  <text x="570" y="192" font-size="11" fill="#1e293b" text-anchor="middle">memory file / vector DB</text>
  <line x1="300" y1="102" x2="150" y2="150" stroke="#0ea5e9" stroke-width="2" marker-end="url(#e)"/>
  <line x1="360" y1="102" x2="360" y2="150" stroke="#d97706" stroke-width="2" marker-end="url(#e)"/>
  <line x1="420" y1="102" x2="570" y2="150" stroke="#16a34a" stroke-width="2" marker-end="url(#e)"/>
  <path d="M 150 210 C 150 250, 300 250, 340 218" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#e)"/>
  <path d="M 570 210 C 570 260, 400 260, 380 218" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#e)"/>
  <text x="360" y="278" font-size="11" fill="#1e293b" text-anchor="middle">retrieve relevant memories back into context on demand</text>
  <defs>
    <marker id="e" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="304" font-size="11" fill="#64748b" text-anchor="middle">Keep the window bounded; externalize what must survive; retrieve what's relevant.</text>
</svg>
```

---

## 5. Implementation

A threshold-triggered summarization strategy for short-term memory, plus server-side compaction.

```python
import anthropic

client = anthropic.Anthropic()
MODEL = "claude-sonnet-4"

def count(messages, system):
    return client.messages.count_tokens(
        model=MODEL, system=system, messages=messages
    ).input_tokens

def summarize(old_messages):
    """Compress a stretch of old turns into one dense summary."""
    resp = client.messages.create(
        model=MODEL, max_tokens=600,
        system="Summarize this conversation segment. Preserve decisions, facts, "
               "open questions, and the current goal. Drop raw tool output.",
        messages=old_messages + [{"role": "user", "content": "Summarize the above."}],
    )
    return next(b.text for b in resp.content if b.type == "text")

def manage_memory(messages, system, window=200_000, trigger=0.7, keep_recent=6):
    """When history crosses the trigger, compact everything but the recent tail."""
    if count(messages, system) < window * trigger:
        return messages
    old, recent = messages[:-keep_recent], messages[-keep_recent:]
    summary = summarize(old)
    return [{"role": "user", "content": f"[Summary of earlier conversation]\n{summary}"}] + recent
```

Using the SDK's server-side **compaction** — the API summarizes automatically and returns a `compaction` block you must pass back:

```python
messages = []

def chat(user_msg):
    messages.append({"role": "user", "content": user_msg})
    resp = client.beta.messages.create(
        betas=["compact-2026-01-12"],
        model="claude-opus-4",
        max_tokens=1024,
        messages=messages,
        context_management={"edits": [{"type": "compact_20260112"}]},
    )
    # Append the FULL content — the compaction block must be preserved so the
    # API can replace compacted history on the next request.
    messages.append({"role": "assistant", "content": resp.content})
    return next(b.text for b in resp.content if b.type == "text")
```

Long-term memory via the model's **memory tool** (client-side; you implement the backend):

```python
# The model reads/writes a persistent /memories directory across sessions.
resp = client.messages.create(
    model="claude-sonnet-4", max_tokens=1024,
    tools=[{"type": "memory_20250818", "name": "memory"}],
    messages=[{"role": "user", "content": "Remember I prefer metric units."}],
)
# You implement view/create/str_replace/insert/delete against a per-user, path-validated
# /memories directory; the model calls them and the preference survives future sessions.
```

**Optimization note.** Summarization costs an LLM call, so trigger it on a threshold, not every turn. Keep the *stable* prefix (system + tools + any frozen summary) first so prompt caching survives — but note that rewriting the summary invalidates the cache below it, so compact in batches, not continuously. Prefer **context editing** (clearing old tool results) when the raw outputs are truly disposable; it's cheaper than summarizing. For long-term memory, embed and retrieve rather than loading the whole store.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Truncation | Trivial, zero cost | Blindly drops important context (may forget the goal) |
| Summarization | Preserves meaning per token | Costs an LLM call; lossy; can drop a needed detail |
| Context editing | Cheap, targeted, keeps structure | Only removes stale content; doesn't compress kept content |
| Scratchpad | Durable working state across compaction | Agent must be prompted to maintain it |
| Retrieval-backed memory | Unbounded storage, bounded context | A non-retrieved fact is effectively forgotten this turn |
| Long-term memory file | Cross-session continuity | Storage, retrieval, and staleness/consistency to manage |
| Larger window | Less compaction needed | Higher cost; attention dilutes over huge contexts |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Truncating to "last N messages" and losing the original goal → ✅ summarize with a prompt that preserves the goal, decisions, and open questions.
2. ⚠️ Summarizing every single turn → ✅ trigger compaction on a threshold to control cost.
3. ⚠️ Dropping the provider's compaction block from history → ✅ append the full `resp.content`; the block carries the compaction state.
4. ⚠️ Compacting so aggressively the recent context is lost → ✅ keep a verbatim recent tail; only compress older turns.
5. ⚠️ Storing secrets or PII in long-term memory carelessly → ✅ never store credentials; scope PII to per-user stores with access control.
6. ⚠️ Continuously rewriting the summary and killing prompt caching → ✅ compact in batches so the cached prefix survives.
7. ⚠️ Loading the entire long-term store into context → ✅ retrieve only relevant memories by embedding similarity.
8. ⚠️ Path traversal in a memory tool backend → ✅ validate every path stays inside the memory directory; reject `..` and symlinks.
9. ⚠️ Letting stale memories contradict fresh ones → ✅ timestamp entries and prefer/overwrite with the latest; prune contradictions.
10. ⚠️ Treating a 1M window as "infinite" → ✅ budget it; attention and cost degrade long before the hard limit.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When an agent "forgets" mid-run, the culprit is almost always a memory operation dropping something it shouldn't. Log every compaction: what was summarized, the summary produced, and what was kept. If the agent loses its goal after turn 20, check whether compaction discarded the original instruction — a good summary prompt should always retain the goal. Diff the pre- and post-compaction context.

**Monitoring.** Track `tokens(H_t)` over the run, compaction frequency and compression ratio, the rate of "goal lost" failures, long-term memory hit rate (are retrieved memories actually used?), and cost per session (summarization calls add up). Watch for context that grows despite compaction — a sign the trigger or keep-recent window is misconfigured.

**Security.** Long-term memory is a persistence surface: never write API keys, passwords, or tokens into it, and treat stored content as potentially attacker-influenced (a user could plant injection text that's replayed into every future session). Enforce per-user memory isolation, validate all paths in a memory-tool backend, and apply retention/deletion policies (GDPR/CCPA) since you're now persisting user data. Redact secrets before they can be written.

**Scaling.** For many concurrent long-lived agents, compaction and retrieval calls dominate cost — batch and cache aggressively. Store long-term memory in a vector DB sharded per tenant; retrieve top-k rather than scanning. Use context editing (cheap clearing) before reaching for summarization (an LLM call). Consider a smaller model for the summarization step itself.

---

## 9. Interview Questions

**Q: Why does an LLM need explicit memory management at all — isn't the context the memory?**
A: The context *is* short-term memory, but it's stateless across calls and bounded in size. It grows every turn until it hits the window, at which point the model errors or silently loses its earliest content. And nothing in the context survives the session. Memory management keeps the live context bounded and externalizes what must persist beyond it.

**Q: When would you summarize versus truncate?**
A: Truncation drops whole messages by position, so it can discard the goal while keeping trivia — use it only when recency is genuinely all that matters. Summarization compresses old turns into a dense, meaning-preserving block, keeping decisions and the goal while shedding raw tool output. Summarization costs an LLM call but is the right default for long agent runs.

**Q: What's the difference between compaction and context editing?**
A: Compaction *summarizes* old context into a shorter block (semantic, lossy, costs an LLM call). Context editing *clears* stale content — old tool results, thinking blocks — leaving the rest of the structure intact (cheap, targeted, no summarization). Use editing when the raw outputs are disposable; use compaction when you need to preserve their meaning in less space.

**Q: How does long-term memory differ from short-term, and how is it retrieved?**
A: Short-term memory is the live context, volatile and session-scoped. Long-term memory is state written to durable storage — a memory file or vector DB — that survives across sessions. It's retrieved on demand: read the memory file at session start, or embed the query and pull back only the facts whose embeddings are close. You accept that unretrieved facts are effectively forgotten this turn.

**Q: What is a scratchpad and why does it help?**
A: A scratchpad is a working-notes area — a file or a running message — where the agent records plans, intermediate findings, and current state. It helps because that state is explicit and durable: it survives compaction (you preserve the scratchpad), and it lets the agent re-ground itself after old turns are summarized away.

**Q: Why must you preserve the provider's compaction block in history?**
A: With server-side compaction, the API returns a `compaction` block that encodes the summarized state; on the next request the API uses it to replace the compacted history. If you extract only the text and drop the block, you silently lose the compaction state and the history balloons again. Always append the full `response.content`.

**Q: (Senior) Your long-running agent forgets its goal after ~30 turns. Diagnose it.**
A: The goal was almost certainly dropped by a memory operation. Check the compaction: is the summary prompt instructed to always retain the original goal, decisions, and open questions? If it's truncation, switch to summarization. If the goal is in a summary but ignored, the summary may be buried too deep or too terse — pin the goal in a persistent scratchpad or the system prompt so it survives every compaction. Log pre/post-compaction context to confirm.

**Q: (Senior) How do you keep prompt caching effective while managing memory?**
A: Caching is a prefix match, so any change to the stable prefix invalidates everything after it. Keep the frozen parts (system, tools, and any settled summary) first and unchanged, and compact in batches rather than rewriting the summary every turn — continuous rewriting kills the cache. Put volatile recent turns after the last cache breakpoint so the cached prefix survives across turns.

**Q: (Senior) What are the security risks unique to long-term memory?**
A: It's a durable persistence surface, so anything written is replayed into future sessions — including attacker-planted prompt-injection text or leaked secrets. Never store credentials or tokens; treat stored content as untrusted; enforce per-user isolation so one user's memory never bleeds into another's; validate all paths in a memory-tool backend against traversal; and apply retention/deletion policies for the PII you're now persisting.

**Q: Why does a huge context window not eliminate the need for memory management?**
A: Even at 1M tokens, cost scales with context size and attention dilutes — the model attends worse to any single fact when the context is enormous, so relevant details get lost in the noise. And no window is truly infinite: a long enough agent run still overflows it. Bounded, relevant context beats a maximal but diluted one.

**Q: How do you decide what to keep in context each turn?**
A: Continuous triage against the question "what does *this* turn need?" Keep the goal, the recent turns, the active plan/scratchpad, and any facts the current step depends on; compress or clear old tool outputs and resolved sub-tasks; retrieve long-term facts only when relevant. It's a relevance-vs-completeness trade-off you re-make every turn.

**Q: What's the difference between working memory and episodic memory for an agent?**
A: Working memory is the current task's active state — the plan, recent observations, the immediate goal — held in context. Episodic memory is a log of past interactions the agent can recall later, typically stored externally and retrieved by similarity. Working memory drives the current step; episodic memory gives continuity across steps and sessions.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The context window is bounded short-term memory that grows every turn until it overflows. Keep it in budget with truncation (cheap, lossy), summarization/compaction (semantic, costs a call), or context editing (clears stale content). Preserve the goal across every compaction — pin it in a scratchpad or system prompt. Externalize cross-session state to a memory file or vector store and retrieve only what's relevant. Never store secrets; isolate per user; keep the cached prefix stable by compacting in batches.

| Operation | Cost | Keeps meaning? |
| --- | --- | --- |
| Truncate | free | no (position-based) |
| Summarize / compact | LLM call | yes (dense) |
| Context edit | cheap | removes stale only |
| Retrieve (long-term) | embedding lookup | fetches relevant facts |

- **Short-term** → live context, volatile, bounded by the window.
- **Long-term** → durable store, retrieved on demand.
- **Compaction** → summarize old, keep recent verbatim.
- **Preserve the goal** → across every memory operation.
- **Never store secrets** → memory is replayed into future sessions.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement threshold-triggered summarization; run a 40-turn conversation and confirm it never exceeds the window.
- [ ] Add a "goal preservation" check: assert the summary always contains the original task.
- [ ] Compare truncation vs. summarization on a task where an early instruction matters late; measure which loses it.
- [ ] Implement a simple long-term memory file the agent reads at session start and writes to at session end.
- [ ] Add retrieval-backed memory: embed stored facts and pull only the top-3 relevant ones into context.

**Mini Project — "Persistent Research Assistant."** Build an assistant that conducts multi-session research and remembers across sessions.
*Goal:* the assistant carries findings and user preferences from one session to the next without exceeding the window.
*Requirements:* a scratchpad the agent maintains; threshold-triggered compaction that preserves the goal and decisions; a long-term memory store (file or vector DB) written at session end and retrieved at session start; per-user isolation; token-usage logging.
*Extensions:* switch to server-side compaction and verify the block round-trips; add embedding-based retrieval of past findings; add a secret-redaction pass before any memory write; measure compression ratio and cost per session across 5 sessions.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 31 — Chunking, Embeddings & Reranking** (the retrieval mechanics behind long-term memory)
- **Chapter 32 — AI Agents: The Loop, Tools & Autonomy** (why the loop's growing context creates the memory problem)
- **Chapter 36 — Multi-Agent Systems & Orchestration** (shared vs. per-agent state across a fleet)

**Free Learning Resources**
- **Context Editing & Memory (Anthropic Docs)** — Anthropic · *Intermediate* · how context editing and the memory tool work in the Messages API. <https://docs.claude.com/en/docs/build-with-claude/context-editing>
- **Compaction** — Anthropic Docs · *Intermediate* · server-side summarization for long conversations and the block round-trip. <https://docs.claude.com/en/docs/build-with-claude/compaction>
- **Memory Tool** — Anthropic Docs · *Intermediate* · the client-side memory directory pattern for cross-session state. <https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool>
- **MemGPT: Towards LLMs as Operating Systems** — Packer et al. (arXiv) · *Advanced* · the influential paper treating context as tiered virtual memory. <https://arxiv.org/abs/2310.08560>
- **Generative Agents: Interactive Simulacra of Human Behavior** — Park et al. (arXiv) · *Advanced* · memory streams, retrieval, and reflection for long-lived agents. <https://arxiv.org/abs/2304.03442>
- **Lost in the Middle: How Language Models Use Long Contexts** — Liu et al. (arXiv) · *Advanced* · why attention degrades over huge contexts, motivating bounded memory. <https://arxiv.org/abs/2307.03172>

---

*AI Engineering Handbook — chapter 34.*
