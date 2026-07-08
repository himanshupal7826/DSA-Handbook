# 36 · Multi-Agent Systems & Orchestration

> **In one line:** When one agent's context and focus can't hold a whole task, you split it across specialized agents coordinated by a supervisor — trading coordination overhead for parallelism and separation of concerns.

---

## 1. Overview

A single agent is a generalist working in one context window. That works until the task is too big, too parallel, or too varied for one context to hold coherently. **Multi-agent systems** split the work across several agents — each with its own context, tools, and instructions — coordinated by an orchestration layer. The classic shape is **supervisor/worker** (also called orchestrator/subagent): a lead agent decomposes the task, spawns workers to handle pieces, and synthesizes their results.

The problem it solves is context and focus limits. One agent researching a broad question keeps everything — every source, every tool result — in one growing context, which dilutes attention and eventually overflows. Split it: a supervisor delegates "research the market" to one worker and "research the competitors" to another; each works in a clean, focused context; the supervisor merges their findings. The same decomposition gives you *parallelism* — workers run concurrently — and *specialization* — a code-writing agent and a code-reviewing agent can have different prompts, tools, and even different models.

The motivation traces to a long line of distributed-systems and blackboard-architecture ideas, now realized with LLMs as the agents. Frameworks like LangGraph model the system as a graph of agent nodes with explicit control-flow edges; Anthropic's own multi-agent research system used an orchestrator spawning parallel subagents, each exploring a facet of a query.

But multi-agent is not free, and the central lesson of this chapter is that **coordination has a cost**. Every hand-off is a place to lose information, every extra agent multiplies token spend, and a poorly decomposed task fragments into agents that duplicate work or contradict each other. A concrete example: a "write a research report" system with a lead agent, three parallel research workers, and a writer agent produces a far richer report than one agent — but costs several times the tokens and adds failure modes (a worker returns garbage; the lead mis-merges). Knowing *when* the split pays for itself, and how to structure the hand-offs, is the skill this chapter builds.

---

## 2. Core Concepts

- **Multi-agent system** — several LLM agents, each with its own context and role, working toward a shared goal under some coordination scheme.
- **Supervisor / orchestrator** — the lead agent that decomposes the task, delegates sub-tasks, and synthesizes results.
- **Worker / subagent** — a specialized agent that handles one delegated sub-task in its own context and returns a result.
- **Hand-off** — passing control and context from one agent to another; the join point where information can be lost or preserved.
- **Orchestration pattern** — the topology of coordination: supervisor/worker, sequential pipeline, parallel fan-out/fan-in, or a graph.
- **Fan-out / fan-in** — spawning multiple workers in parallel (fan-out) and merging their results (fan-in).
- **Shared vs. isolated context** — whether agents share one conversation/state or each keeps a private context, communicating only via hand-offs.
- **Coordination cost** — the token, latency, and reliability overhead added by delegation, hand-offs, and synthesis.
- **Router** — a lightweight agent (or classifier) that dispatches a request to the right specialized agent.

---

## 3. Theory & Mathematical Intuition

The core question is *when does splitting a task across agents beat keeping it in one?* The intuition is a cost-benefit inequality. Let a single agent solve the task with cost `C_single` (tokens × latency) and quality `Q_single`. A multi-agent decomposition into `k` workers has:

```
C_multi ≈ C_orchestrator + Σ_i C_worker_i + C_synthesis + C_handoff·(hand-offs)
```

Multi-agent wins only when the quality gain justifies the overhead:

```
split if:   Q_multi − Q_single  >  value_penalty(C_multi − C_single)
```

Two forces push `Q_multi` up. First, **context isolation**: each worker operates in a clean, focused context, so attention isn't diluted across unrelated sub-tasks — quality per sub-task rises (the same "lost in the middle" degradation that hurts one giant context is avoided). Second, **parallelism**: independent workers run concurrently, so wall-clock latency for the whole task can *drop* even as total token spend rises. Anthropic's research on multi-agent systems found token usage explains a large share of performance variance — more agents spending more tokens on a decomposable task genuinely helped, but *only* when the task actually decomposed.

Three forces push cost and risk up. **Token multiplication**: an orchestrator plus `k` workers each re-sends its own context, so total tokens can be several times a single agent's. **Hand-off loss**: each hand-off compresses one agent's rich context into a message for the next, and information not passed is lost — a lossy channel between agents. **Coordination failure**: workers can duplicate work, contradict each other, or the supervisor can mis-merge — failure modes a single agent doesn't have.

The decisive property is **decomposability**. If the task cleanly splits into independent sub-tasks with narrow interfaces (research these three topics), multi-agent shines: isolation and parallelism help, hand-offs are clean. If the sub-tasks are tightly coupled (each needs the others' intermediate state), hand-offs become expensive and lossy, and a single agent — which keeps everything in one shared context — usually wins. The engineering judgment is: *does this task decompose into loosely-coupled pieces?* If yes, split; if no, don't.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="300" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">When splitting pays: decomposability vs. coupling</text>
  <text x="180" y="58" font-size="13" font-weight="bold" fill="#16a34a" text-anchor="middle">Loosely coupled (split wins)</text>
  <rect x="120" y="72" width="120" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="180" y="94" font-size="11" fill="#1e293b" text-anchor="middle">supervisor</text>
  <rect x="60" y="150" width="90" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="105" y="170" font-size="11" fill="#1e293b" text-anchor="middle">topic A</text>
  <rect x="160" y="150" width="90" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="205" y="170" font-size="11" fill="#1e293b" text-anchor="middle">topic B</text>
  <line x1="160" y1="106" x2="105" y2="150" stroke="#16a34a" stroke-width="2"/>
  <line x1="200" y1="106" x2="205" y2="150" stroke="#16a34a" stroke-width="2"/>
  <text x="155" y="135" font-size="10" fill="#16a34a">clean hand-off</text>
  <text x="180" y="215" font-size="11" fill="#1e293b" text-anchor="middle">independent → parallel,</text>
  <text x="180" y="232" font-size="11" fill="#1e293b" text-anchor="middle">isolated, easy merge</text>
  <line x1="360" y1="55" x2="360" y2="250" stroke="#cbd5e1" stroke-dasharray="4 4"/>
  <text x="540" y="58" font-size="13" font-weight="bold" fill="#dc2626" text-anchor="middle">Tightly coupled (split loses)</text>
  <rect x="480" y="72" width="120" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="540" y="94" font-size="11" fill="#1e293b" text-anchor="middle">supervisor</text>
  <rect x="420" y="150" width="90" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="465" y="170" font-size="11" fill="#1e293b" text-anchor="middle">step 1</text>
  <rect x="570" y="150" width="90" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="615" y="170" font-size="11" fill="#1e293b" text-anchor="middle">step 2</text>
  <line x1="520" y1="106" x2="465" y2="150" stroke="#d97706" stroke-width="2"/>
  <line x1="560" y1="106" x2="615" y2="150" stroke="#d97706" stroke-width="2"/>
  <line x1="510" y1="165" x2="570" y2="165" stroke="#dc2626" stroke-width="2" stroke-dasharray="3 2" marker-end="url(#g)"/>
  <text x="540" y="200" font-size="10" fill="#dc2626" text-anchor="middle">step 2 needs step 1's state</text>
  <text x="540" y="232" font-size="11" fill="#1e293b" text-anchor="middle">lossy hand-offs → keep in one agent</text>
  <defs>
    <marker id="g" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#dc2626"/>
    </marker>
  </defs>
  <text x="360" y="280" font-size="11" fill="#64748b" text-anchor="middle">Split cost ≈ orchestrator + Σ workers + synthesis + hand-off loss.</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Decide to split.** Confirm the task decomposes into loosely-coupled sub-tasks and that the quality/parallelism gain justifies the coordination cost. If not, use one agent.
2. **Design the topology.** Pick a pattern: supervisor/worker (fan-out/fan-in), sequential pipeline (each agent's output feeds the next), or a graph with conditional edges.
3. **Define roles.** Give each agent a focused system prompt, its own tool set, and — if useful — a fit-for-purpose model (a cheaper model for simple workers, a stronger one for the supervisor).
4. **Decompose.** The supervisor breaks the goal into concrete, self-contained sub-tasks with clear success criteria, and passes each worker exactly the context it needs (nothing more).
5. **Delegate (fan-out).** Spawn workers — in parallel when the sub-tasks are independent — each running its own agent loop in an isolated context.
6. **Execute & return.** Each worker completes its sub-task and returns a structured result (a summary, not its raw transcript — the hand-off must be a clean, compressed interface).
7. **Synthesize (fan-in).** The supervisor collects worker results, resolves conflicts, and merges them into the final output.
8. **Verify.** Optionally add a critic/reviewer agent that checks the synthesized result before it's returned.
9. **Guard.** Enforce global limits — total agents, total tokens, wall-clock — so a runaway decomposition can't spiral.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Supervisor / worker orchestration (fan-out / fan-in)</text>
  <rect x="290" y="50" width="140" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="72" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">supervisor</text>
  <text x="360" y="88" font-size="11" fill="#1e293b" text-anchor="middle">decompose</text>
  <rect x="60" y="150" width="150" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="135" y="172" font-size="12" fill="#1e293b" text-anchor="middle">worker: research</text>
  <text x="135" y="190" font-size="11" fill="#1e293b" text-anchor="middle">own context + tools</text>
  <rect x="285" y="150" width="150" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="360" y="172" font-size="12" fill="#1e293b" text-anchor="middle">worker: analyze</text>
  <text x="360" y="190" font-size="11" fill="#1e293b" text-anchor="middle">own context + tools</text>
  <rect x="510" y="150" width="150" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="585" y="172" font-size="12" fill="#1e293b" text-anchor="middle">worker: draft</text>
  <text x="585" y="190" font-size="11" fill="#1e293b" text-anchor="middle">own context + tools</text>
  <line x1="320" y1="94" x2="135" y2="150" stroke="#16a34a" stroke-width="2" marker-end="url(#h)"/>
  <line x1="360" y1="94" x2="360" y2="150" stroke="#16a34a" stroke-width="2" marker-end="url(#h)"/>
  <line x1="400" y1="94" x2="585" y2="150" stroke="#16a34a" stroke-width="2" marker-end="url(#h)"/>
  <text x="230" y="128" font-size="10" fill="#16a34a">fan-out (parallel)</text>
  <rect x="290" y="240" width="140" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="360" y="262" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">synthesize</text>
  <text x="360" y="278" font-size="11" fill="#1e293b" text-anchor="middle">merge + verify</text>
  <line x1="135" y1="206" x2="310" y2="240" stroke="#0ea5e9" stroke-width="2" marker-end="url(#h)"/>
  <line x1="360" y1="206" x2="360" y2="240" stroke="#0ea5e9" stroke-width="2" marker-end="url(#h)"/>
  <line x1="585" y1="206" x2="410" y2="240" stroke="#0ea5e9" stroke-width="2" marker-end="url(#h)"/>
  <text x="470" y="228" font-size="10" fill="#0ea5e9">fan-in (results)</text>
  <defs>
    <marker id="h" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="308" font-size="11" fill="#64748b" text-anchor="middle">Workers return compressed summaries, not raw transcripts — the hand-off is a clean interface.</text>
</svg>
```

---

## 5. Implementation

A supervisor/worker system built directly on the Messages API: the supervisor decomposes, workers run in parallel isolated contexts, and the supervisor synthesizes.

```python
import anthropic
from concurrent.futures import ThreadPoolExecutor

client = anthropic.Anthropic()

def worker(subtask: str) -> str:
    """A specialized agent in its own isolated context; returns a compact summary."""
    resp = client.messages.create(
        model="claude-haiku-4-5",              # cheaper model for scoped work
        max_tokens=800,
        system="You are a focused research worker. Investigate the assigned subtopic "
               "and return a concise, factual summary — not your reasoning.",
        messages=[{"role": "user", "content": subtask}],
    )
    return next(b.text for b in resp.content if b.type == "text")

def supervisor(goal: str) -> str:
    # 1. Decompose (the lead agent plans the split)
    plan = client.messages.create(
        model="claude-sonnet-4", max_tokens=400,
        system="Split the user's goal into 2-4 independent, self-contained subtasks. "
               "Return one subtask per line, no numbering.",
        messages=[{"role": "user", "content": goal}],
    )
    subtasks = [ln.strip() for ln in
                next(b.text for b in plan.content if b.type == "text").splitlines()
                if ln.strip()]

    # 2. Fan-out: run workers in parallel, each in an isolated context
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(worker, subtasks))

    # 3. Fan-in: synthesize (hand-off is the compressed summaries, not transcripts)
    findings = "\n\n".join(f"[{t}]\n{r}" for t, r in zip(subtasks, results))
    final = client.messages.create(
        model="claude-sonnet-4", max_tokens=1500,
        system="Synthesize the worker findings into one coherent answer. "
               "Resolve any contradictions and note gaps.",
        messages=[{"role": "user", "content": f"Goal: {goal}\n\nFindings:\n{findings}"}],
    )
    return next(b.text for b in final.content if b.type == "text")

print(supervisor("Compare the trade-offs of three vector databases for RAG."))
# Supervisor splits into per-DB subtasks, workers research in parallel, supervisor merges.
```

Adding a verification agent (critic) as a fan-in guard:

```python
def critic(goal: str, draft: str) -> str:
    resp = client.messages.create(
        model="claude-sonnet-4", max_tokens=600,
        system="You are a reviewer. Check the draft against the goal for factual gaps, "
               "contradictions, and unsupported claims. Return APPROVED or a fix list.",
        messages=[{"role": "user", "content": f"Goal: {goal}\n\nDraft:\n{draft}"}],
    )
    return next(b.text for b in resp.content if b.type == "text")
```

**Optimization note.** Parallelize independent workers — the whole point of fan-out is that wall-clock latency drops even as token spend rises. Use a **cheaper model** (`claude-haiku-4-5`) for narrow workers and reserve the strong model for the supervisor's decomposition and synthesis, where reasoning matters most. Make hand-offs *compressed summaries*, not raw transcripts — passing full worker context defeats the isolation and multiplies tokens. Cap total agents and a global token budget so a mis-decomposed task can't spawn a runaway tree. Prompt-cache each agent's stable system prefix.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Context isolation | Each worker focuses; no attention dilution | More agents to prompt and maintain |
| Parallelism | Independent workers cut wall-clock latency | Only helps if sub-tasks are truly independent |
| Specialization | Per-role prompts, tools, and models | Coordination logic to design and debug |
| Scalability of scope | Tackles tasks too big for one context | Token spend multiplies with agent count |
| Supervisor synthesis | Coherent merge of diverse findings | Supervisor can mis-merge or contradict workers |
| Fault isolation | One worker failing needn't kill the task | New failure modes: duplication, deadlock, drift |
| Verification agent | Extra quality gate | Another agent's cost and latency |

**The core trade-off:** multi-agent buys parallelism and separation of concerns at the cost of tokens, latency-per-hand-off, and reliability. It pays off on decomposable, high-value tasks; it's pure overhead on coupled or simple ones.

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Splitting a task that doesn't decompose → ✅ use one agent for tightly-coupled work; split only loosely-coupled tasks.
2. ⚠️ Passing full worker transcripts across hand-offs → ✅ hand off compressed, structured summaries — the interface, not the internals.
3. ⚠️ No global budget, so a bad decomposition spawns a runaway tree → ✅ cap total agents, tokens, and wall-clock.
4. ⚠️ Running independent workers serially → ✅ fan out in parallel to actually gain the latency benefit.
5. ⚠️ Using the strongest, priciest model for every trivial worker → ✅ match model to sub-task; cheap models for narrow work.
6. ⚠️ Vague sub-task definitions workers can't act on → ✅ give each worker a self-contained task with clear success criteria.
7. ⚠️ No synthesis strategy, so results are stapled together → ✅ have the supervisor actively resolve conflicts and merge.
8. ⚠️ Reaching for multi-agent as the default → ✅ start with a single agent; escalate only when it demonstrably can't cope.
9. ⚠️ Workers duplicating each other's work → ✅ make the decomposition partition the space with minimal overlap.
10. ⚠️ No observability across the fleet → ✅ trace every agent, hand-off, and cost; a distributed failure is invisible without it.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Multi-agent failures are distributed and hard to see. Log a trace spanning the whole run — the supervisor's decomposition, each worker's task and result, and the synthesis — with a shared correlation ID so you can reconstruct the tree. The common bugs: a worker got a malformed sub-task (decomposition bug), a worker returned garbage that the supervisor trusted (no verification), or two workers duplicated work (bad partition). Replay the trace to find which agent's decision went wrong.

**Monitoring.** Track total agents spawned per task, total tokens and cost (this is where multi-agent bites), per-worker success rate, hand-off count, wall-clock vs. single-agent baseline, and synthesis-conflict frequency. Alert on runaway agent counts and cost spikes — a mis-decomposed task is the classic cause.

**Security.** Every agent widens the surface: each has its own tools, credentials, and context. Apply least-privilege per agent — a research worker shouldn't hold write credentials. Treat inter-agent messages as untrusted (one compromised or injected worker can feed poisoned results to the supervisor, propagating an attack). Gate any irreversible action at the supervisor level with human confirmation, and don't let workers spawn unbounded sub-agents.

**Scaling.** Fan-out parallelism scales wall-clock down but tokens up — bound concurrency and budget. For high throughput, use a router agent (or cheap classifier) to dispatch requests to the right specialist rather than always running the full supervisor tree. Managed orchestration platforms (multi-agent coordinators that run the loop and host per-session sandboxes) remove hand-rolled harness code at the cost of platform lock-in. Reserve the strongest model for supervisor/synthesis; scale workers horizontally on cheaper models.

---

## 9. Interview Questions

**Q: When does splitting a task across multiple agents actually beat a single agent?**
A: When the task decomposes into loosely-coupled sub-tasks and the quality/parallelism gain outweighs the coordination cost. Independent sub-tasks let workers run in isolated, focused contexts (better attention) and in parallel (lower wall-clock latency). If the sub-tasks are tightly coupled — each needs the others' intermediate state — the hand-offs become lossy and expensive, and one agent keeping everything in shared context usually wins.

**Q: Describe the supervisor/worker pattern.**
A: A lead (supervisor/orchestrator) agent decomposes the goal into sub-tasks, delegates each to a worker (subagent) that runs its own agent loop in an isolated context, then collects and synthesizes the workers' results into the final output. It's a fan-out (spawn workers) / fan-in (merge results) topology, often with the supervisor on a strong model and workers on cheaper ones.

**Q: What is the "coordination cost" and where does it come from?**
A: The overhead multi-agent adds beyond a single agent: token multiplication (orchestrator plus each worker re-sends its own context), hand-off loss (compressing one agent's context into a message for the next drops information), added latency per hand-off, and new failure modes (duplication, contradiction, mis-merge). It's the price you pay for parallelism and isolation.

**Q: Why should hand-offs be summaries, not full transcripts?**
A: Passing a worker's entire transcript defeats the point of isolation — it re-injects all that context into the next agent, multiplying tokens and diluting focus. A hand-off should be a clean, compressed interface: the worker's *conclusions*, structured for the supervisor to merge. The interface, not the internals.

**Q: How does parallelism reduce latency even though it raises token cost?**
A: Independent workers run concurrently, so the whole task's wall-clock time is roughly the slowest worker plus orchestration, not the sum of all workers. Total tokens still rise because every worker spends its own context, but the user waits less. It's a latency-vs-cost trade, favorable when sub-tasks are genuinely independent.

**Q: Why not just always use multi-agent since it can improve quality?**
A: Because it's pure overhead when the task doesn't decompose or is simple enough for one agent. You pay multiplied tokens, added latency per hand-off, and new distributed failure modes for no gain. The right default is a single agent; escalate to multi-agent only when one agent demonstrably can't hold the task's scope or when the sub-tasks are independent enough to parallelize.

**Q: (Senior) Your multi-agent system costs 5× a single agent but isn't 5× better. How do you investigate?**
A: Check decomposability first — if the sub-tasks are actually coupled, workers are re-doing shared context via lossy hand-offs, so you're paying multi-agent cost for single-agent-quality work; collapse it. Then check for duplication (bad partition — workers overlapping), over-strong models on trivial workers (downgrade), and full-transcript hand-offs (compress them). Trace the run and measure quality per token per agent; often the fix is fewer, better-scoped workers on cheaper models, or reverting to one agent.

**Q: (Senior) What new failure modes does multi-agent introduce, and how do you guard against them?**
A: Runaway spawning (a mis-decomposed task spawns an unbounded tree) — cap total agents and a global budget. Hand-off loss (needed context not passed) — design explicit, complete sub-task specs. Contradiction/mis-merge — have the supervisor actively resolve conflicts or add a critic agent. Duplication — partition the sub-task space cleanly. Silent worker failure — verify worker output rather than trusting it. And prompt injection propagating across agents — treat inter-agent messages as untrusted.

**Q: (Senior) How do you decide the topology — supervisor/worker vs. pipeline vs. graph?**
A: Match topology to the task's dependency structure. Independent sub-tasks with a final merge → supervisor with parallel fan-out/fan-in. A fixed sequence where each stage transforms the previous output → a pipeline. Conditional branching, loops, or dynamic routing → a graph with explicit edges (e.g. LangGraph). If control flow is data-dependent and irregular, a graph gives you the explicit edges you need; if it's a clean split-and-merge, supervisor/worker is simpler.

**Q: What role does model selection play in a multi-agent system?**
A: You can match each agent to its job. The supervisor's decomposition and synthesis need strong reasoning, so use a capable model there. Narrow, well-scoped workers often do fine on a cheaper, faster model, which cuts the token-multiplication cost that multi-agent otherwise incurs. Heterogeneous model assignment is one of the main levers for making multi-agent cost-effective.

**Q: What is a router agent and when do you use it?**
A: A lightweight agent (or a plain classifier) that inspects an incoming request and dispatches it to the right specialized agent, rather than always running a full decomposition. Use it for high-throughput systems with distinct request types — a support system routing "billing" vs. "technical" to specialists — where the coordination you need is *dispatch*, not *decompose-and-merge*.

**Q: How do you keep a fleet of agents debuggable in production?**
A: Distributed tracing with a shared correlation ID spanning the supervisor and every worker and hand-off, plus per-agent logs of task, result, tokens, and decisions. Without a unified trace, a failure is invisible — you can't tell which agent's decision was wrong. You reconstruct and replay the whole tree to localize the fault, exactly as you would in distributed systems.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Multi-agent splits a task across specialized agents under a supervisor (decompose → fan-out to workers in isolated contexts → fan-in to synthesize). It buys context isolation and parallelism but costs multiplied tokens, lossy hand-offs, and new failure modes. Split only when the task *decomposes* into loosely-coupled sub-tasks; keep coupled tasks in one agent. Hand off compressed summaries, not transcripts; parallelize independent workers; match model to sub-task; cap total agents and budget. Default to one agent; escalate deliberately.

| Pattern | Use when |
| --- | --- |
| Supervisor/worker | independent sub-tasks + final merge |
| Pipeline | fixed sequential transform |
| Graph | conditional/looping control flow |
| Router | dispatch by request type |

- **Split rule** → decomposable & loosely-coupled → yes; coupled → no.
- **Hand-off** → compressed summaries, not transcripts.
- **Cost** → orchestrator + Σ workers + synthesis + hand-off loss.
- **Parallelize** → independent workers, for latency.
- **Guard** → cap agents, tokens, and wall-clock.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build a supervisor that decomposes a query into 3 sub-tasks and runs workers in parallel; compare its output and cost to one agent.
- [ ] Measure wall-clock latency serial vs. parallel workers and confirm the parallel speedup.
- [ ] Add a critic agent and measure how often it catches a factual gap the supervisor missed.
- [ ] Deliberately over-decompose a coupled task and observe the duplication/contradiction failures.
- [ ] Assign a cheaper model to workers and the strong model to the supervisor; measure the cost/quality change.

**Mini Project — "Research Report Orchestrator."** Build a supervisor/worker system that produces a sourced report on a topic.
*Goal:* a coherent, multi-section report that measurably beats a single agent on a decomposable topic.
*Requirements:* a supervisor (strong model) that decomposes into independent sub-topics; parallel workers (cheaper model) each returning a compressed summary; a synthesis step that resolves conflicts; a critic agent as a final gate; global caps on total agents and tokens; full distributed tracing with a correlation ID.
*Extensions:* add a router that skips decomposition for narrow queries; give each worker MCP-backed tools (Chapter 35); add per-agent least-privilege credentials; A/B multi-agent vs. single-agent on a labeled task set and report the quality-per-token delta; add human confirmation before the report is published.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 32 — AI Agents: The Loop, Tools & Autonomy** (the single-agent loop each worker runs)
- **Chapter 34 — Agent Memory & State** (shared vs. isolated context across agents)
- **Chapter 35 — Model Context Protocol (MCP)** (sharing tools across a fleet of agents)

**Free Learning Resources**
- **How We Built Our Multi-Agent Research System** — Anthropic · *Advanced* · a production case study on orchestrator/subagent design, token economics, and evaluation. <https://www.anthropic.com/engineering/multi-agent-research-system>
- **Building Effective Agents** — Anthropic · *Intermediate* · orchestration patterns (routing, orchestrator-workers, evaluator-optimizer) and when to use each. <https://www.anthropic.com/engineering/building-effective-agents>
- **LangGraph: Multi-Agent Concepts** — LangChain · *Intermediate* · modeling supervisor/worker and graph topologies with explicit control flow. <https://langchain-ai.github.io/langgraph/concepts/multi_agent/>
- **AutoGen: Multi-Agent Conversation Framework** — Microsoft (arXiv) · *Advanced* · a framework and study of conversational multi-agent orchestration. <https://arxiv.org/abs/2308.08155>
- **Generative Agents: Interactive Simulacra of Human Behavior** — Park et al. (arXiv) · *Advanced* · coordination and interaction among many long-lived agents. <https://arxiv.org/abs/2304.03442>
- **A Survey on LLM-based Multi-Agent Systems** — (arXiv) · *Advanced* · a map of coordination patterns, communication, and open problems. <https://arxiv.org/abs/2402.01680>

---

*AI Engineering Handbook — chapter 36.*
