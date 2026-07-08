# 32 · AI Agents: The Loop, Tools & Autonomy

> **In one line:** An agent is an LLM placed inside a loop that lets it perceive, plan, act with tools, and observe results — repeating until a goal is met, rather than answering in a single shot.

---

## 1. Overview

A plain LLM call is a function: text in, text out, one turn, no memory of the world. An **agent** wraps that call in a loop and hands the model levers to *act* — call tools, read their results, and decide what to do next. The defining property is not intelligence but **autonomy over control flow**: the model, not your code, decides how many steps to take, which tool to call, and when it is done.

The problem agents solve is open-endedness. Many real tasks — "triage this bug", "book a trip within budget", "reconcile these two spreadsheets" — cannot be fully specified in advance because the right next step depends on what the previous step returned. A fixed pipeline (retrieve → summarize → answer) works when the steps are known. When they aren't — when the task requires exploration, branching, and recovery from partial failure — you need a loop where the model steers.

The intellectual lineage runs through **ReAct** (Reason + Act), a 2022 pattern showing that interleaving chain-of-thought reasoning with tool calls beats either alone: the model thinks about what it needs, acts to get it, observes the result, and reasons again. Modern tool-use APIs (like Anthropic's Messages API) bake this loop into the protocol — the model emits structured `tool_use` blocks, your harness executes them and returns `tool_result` blocks, and the model continues.

A concrete example: a coding agent asked to "fix the failing test." It reads the test file (tool: read), runs the suite (tool: bash) and sees the error, greps for the buggy function (tool: grep), edits it (tool: edit), reruns the suite (tool: bash), and — seeing green — stops. No human scripted that sequence; the model chose each step from the observation before it. That is the agent loop, and knowing *when* it beats a plain pipeline is the core engineering judgment of this chapter.

---

## 2. Core Concepts

- **Agent** — an LLM in a loop with tools, where the model controls how many steps to take and when to stop.
- **The agent loop** — perceive → plan → act → observe, repeated until a stop condition. Also called the "agentic loop."
- **ReAct** — the reason-then-act pattern: interleave explicit reasoning with tool calls so each action is grounded in a fresh thought.
- **Tool** — a typed function the model can invoke (search, read a file, query a database); the model emits the call, your harness runs it.
- **Observation** — the tool result fed back into the model's context; the model's next decision is conditioned on it.
- **Stop condition** — how the loop ends: the model signals `end_turn` (no more tool calls), a max-iteration cap is hit, or a budget is exhausted.
- **Harness (agent runtime)** — the code that runs the loop: calls the model, executes tools, appends results, enforces limits, handles errors.
- **Autonomy vs. control** — the spectrum from a fixed workflow (you own the control flow) to a fully autonomous agent (the model owns it); most production systems sit deliberately in between.
- **Grounding** — anchoring the model's actions in real observations from tools rather than its parametric memory, which reduces hallucinated actions.

---

## 3. Theory & Mathematical Intuition

An agent is best understood as a policy operating over a state that grows each turn. Let the context at step `t` be `c_t` — the accumulated history of the user goal, prior thoughts, tool calls, and observations. The LLM is a policy `π` that maps context to an action:

```
a_t = π(c_t)      where a_t ∈ { call tool k with args x , finish with answer }
```

The environment (your tools) returns an observation:

```
o_t = env(a_t)
c_{t+1} = c_t ⊕ a_t ⊕ o_t      # append action and observation to context
```

The loop iterates `t = 0, 1, 2, ...` until `a_t` is "finish" or a cap is hit. This is exactly the **agent-environment loop** of reinforcement learning, but with a crucial difference: the policy `π` is a frozen pretrained LLM, not something you train online. The "learning" happens *in-context* — each observation `o_t` reshapes the next decision without any weight update.

Two properties matter. First, **the loop is autoregressive over actions, not just tokens.** A single wrong observation early can derail every subsequent step, because `c_{t+1}` carries the error forward. This is why grounding matters: a real tool result corrects the model's assumptions, whereas an ungrounded guess compounds.

Second, **context grows monotonically**, so cost and latency grow with loop depth, and eventually context-window pressure forces compaction or summarization (Chapter 34). The practical implication: an agent's reliability degrades with the number of steps, so you design tools and prompts to *minimize steps to goal*, not to maximize cleverness per step.

Why does ReAct's interleaving help? Because forcing an explicit reasoning token *before* each action makes the action a function of a deliberate plan rather than a reflexive pattern-match, and forcing an observation *after* each action prevents the model from hallucinating what the tool "probably" returned.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="300" fill="#ffffff"/>
  <text x="360" y="28" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">The perceive to plan to act to observe loop</text>
  <circle cx="150" cy="130" r="52" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="150" y="126" font-size="13" fill="#1e293b" text-anchor="middle">Perceive</text>
  <text x="150" y="144" font-size="11" fill="#1e293b" text-anchor="middle">read goal + obs</text>
  <circle cx="360" cy="80" r="52" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="360" y="76" font-size="13" fill="#1e293b" text-anchor="middle">Plan</text>
  <text x="360" y="94" font-size="11" fill="#1e293b" text-anchor="middle">reason (ReAct)</text>
  <circle cx="570" cy="130" r="52" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="570" y="126" font-size="13" fill="#1e293b" text-anchor="middle">Act</text>
  <text x="570" y="144" font-size="11" fill="#1e293b" text-anchor="middle">call tool</text>
  <circle cx="360" cy="220" r="52" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="360" y="216" font-size="13" fill="#1e293b" text-anchor="middle">Observe</text>
  <text x="360" y="234" font-size="11" fill="#1e293b" text-anchor="middle">tool result</text>
  <path d="M 198 115 L 312 92" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a)"/>
  <path d="M 408 92 L 524 115" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#a)"/>
  <path d="M 560 178 L 410 205" stroke="#d97706" stroke-width="2" fill="none" marker-end="url(#a)"/>
  <path d="M 312 210 L 170 168" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#a)"/>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="288" font-size="12" fill="#1e293b" text-anchor="middle">Loop until the model emits a final answer (end_turn) or a step/budget cap is hit.</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Define the goal and tools.** Give the model a system prompt describing its role and a set of typed tools (name, description, JSON schema).
2. **Seed context.** Put the user's request into the message history.
3. **Model turn.** Call the LLM. It responds either with a final answer (`stop_reason: "end_turn"`) or with one or more `tool_use` blocks.
4. **Branch on stop reason.** If `end_turn`, return the answer and exit. If `tool_use`, proceed to execute.
5. **Execute tools.** Run each requested tool (concurrently when they're independent), capturing results or errors.
6. **Append observations.** Add the assistant's `tool_use` blocks and the corresponding `tool_result` blocks (with matching `tool_use_id`) back into the message history.
7. **Loop.** Call the model again with the extended history. It reasons over the new observations and decides the next action.
8. **Enforce limits.** Cap iterations, wall-clock time, and token budget; break out if a limit is hit, returning a partial result or escalating to a human.
9. **Handle errors.** Return failed tool results with `is_error: true` so the model can adapt rather than crash.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Agent harness control flow</text>
  <rect x="290" y="46" width="140" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="71" font-size="12" fill="#1e293b" text-anchor="middle">user goal</text>
  <rect x="270" y="112" width="180" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="360" y="134" font-size="12" fill="#1e293b" text-anchor="middle">call model</text>
  <text x="360" y="150" font-size="11" fill="#1e293b" text-anchor="middle">(claude-sonnet-4 + tools)</text>
  <line x1="360" y1="86" x2="360" y2="112" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="360,182 430,208 360,234 290,208" fill="#fef3c7" stroke="#d97706"/>
  <text x="360" y="212" font-size="12" fill="#1e293b" text-anchor="middle">stop_reason?</text>
  <line x1="360" y1="158" x2="360" y2="182" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="500" y="188" width="180" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="590" y="210" font-size="12" fill="#1e293b" text-anchor="middle">execute tools</text>
  <text x="590" y="226" font-size="11" fill="#1e293b" text-anchor="middle">append tool_result</text>
  <line x1="430" y1="208" x2="500" y2="208" stroke="#d97706" stroke-width="2"/>
  <text x="465" y="200" font-size="11" fill="#d97706">tool_use</text>
  <path d="M 590 188 C 590 130, 470 120, 450 130" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b)"/>
  <text x="560" y="120" font-size="11" fill="#16a34a">loop back</text>
  <rect x="40" y="188" width="180" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="130" y="215" font-size="12" fill="#1e293b" text-anchor="middle">return answer</text>
  <line x1="290" y1="208" x2="220" y2="208" stroke="#16a34a" stroke-width="2"/>
  <text x="245" y="200" font-size="11" fill="#16a34a">end_turn</text>
  <rect x="270" y="270" width="180" height="36" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="360" y="293" font-size="11" fill="#1e293b" text-anchor="middle">guard: max steps / budget</text>
  <line x1="360" y1="234" x2="360" y2="270" stroke="#d97706" stroke-width="2" stroke-dasharray="4 3"/>
  <defs>
    <marker id="b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#16a34a"/>
    </marker>
  </defs>
</svg>
```

---

## 5. Implementation

A manual agent loop against the Anthropic Messages API. Tools are typed JSON schemas; the harness runs the loop until the model stops calling tools.

```python
import anthropic, json

client = anthropic.Anthropic()

tools = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a city. Call this whenever the "
                       "user asks about weather or conditions in a place.",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        },
    }
]

def get_weather(city: str) -> str:
    return f"{city}: 18°C, light rain"          # stand-in for a real API

def run_agent(user_goal: str, max_steps: int = 8) -> str:
    messages = [{"role": "user", "content": user_goal}]
    for step in range(max_steps):
        resp = client.messages.create(
            model="claude-sonnet-4",
            max_tokens=1024,
            tools=tools,
            messages=messages,
        )
        if resp.stop_reason == "end_turn":       # model is done
            return next(b.text for b in resp.content if b.type == "text")

        # Append the assistant turn (preserves tool_use blocks)
        messages.append({"role": "assistant", "content": resp.content})

        # Execute each requested tool, collect results in one user turn
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                try:
                    output = get_weather(**block.input)
                    results.append({"type": "tool_result",
                                    "tool_use_id": block.id, "content": output})
                except Exception as e:              # let the model recover
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": f"Error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    return "Stopped: step budget exhausted."

print(run_agent("Should I take an umbrella in Paris today?"))
# The model calls get_weather('Paris'), observes rain, then answers: "Yes — light rain."
```

The same loop, with far less code, using the SDK's beta **tool runner**, which drives the request → execute → loop cycle for you:

```python
from anthropic import Anthropic, beta_tool

client = Anthropic()

@beta_tool
def get_weather(city: str) -> str:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. Paris.
    """
    return f"{city}: 18°C, light rain"

runner = client.beta.messages.tool_runner(
    model="claude-sonnet-4",
    max_tokens=1024,
    tools=[get_weather],
    messages=[{"role": "user", "content": "Umbrella in Paris today?"}],
)
for message in runner:      # loop runs automatically until end_turn
    pass
final = message            # last yielded message is the answer
```

**Optimization note.** The dominant cost is re-sending the whole growing history on every turn. Enable **prompt caching** on the stable prefix (system prompt + tool definitions) so repeated turns pay ~0.1× for the cached portion. Cap `max_steps` to bound blast radius. Execute independent tool calls **concurrently** and return all `tool_result` blocks in one user message — splitting them across turns silently trains the model to stop making parallel calls.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Autonomy | Handles open-ended tasks a fixed pipeline can't specify | The model can go off-track; harder to guarantee behavior |
| Grounding via tools | Actions anchored in real results, fewer hallucinations | Each tool call adds latency and a failure mode |
| Adaptivity | Recovers from partial failure by re-planning | Non-deterministic; same input can take different paths |
| Multi-step reach | Solves tasks needing exploration and branching | Cost & latency scale with loop depth |
| ReAct reasoning | Deliberate actions grounded in explicit thought | More tokens per step |
| Generality | One harness serves many task types | Weaker guarantees than a hand-coded workflow |

**The core trade-off:** autonomy buys flexibility and costs predictability. Reach for an agent only when the task is genuinely open-ended, the value justifies higher cost and latency, the model is capable of the task, and errors are recoverable (tests, review, rollback). If any of those fails, a fixed workflow is the better engineering choice.

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Using an agent for a task a fixed pipeline solves → ✅ use the simplest tier: single call → workflow → agent, in that order.
2. ⚠️ No iteration cap, so a confused agent loops forever burning tokens → ✅ enforce max-steps, wall-clock, and token-budget guards.
3. ⚠️ Dropping the assistant's `tool_use` blocks from history → ✅ append the full `resp.content`, then the matching `tool_result` blocks.
4. ⚠️ Crashing the harness on a tool error → ✅ return `is_error: true` so the model can adapt.
5. ⚠️ Vague tool descriptions the model can't act on → ✅ write prescriptive descriptions saying *when* to call each tool, not just what it does.
6. ⚠️ Too many tools cluttering the decision → ✅ keep the tool set focused; use tool search for large libraries.
7. ⚠️ Splitting parallel tool results across multiple user turns → ✅ return all results in one user message to preserve parallel behavior.
8. ⚠️ Trusting the agent's self-reported success → ✅ verify with a check step (run the test, re-query the result) before declaring done.
9. ⚠️ Letting context grow unbounded → ✅ compact or summarize long histories (Chapter 34) before hitting the window.
10. ⚠️ No human-in-the-loop for irreversible actions → ✅ gate destructive/expensive tools behind confirmation.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the full transcript per run — every thought, tool call, arguments, observation, and stop reason. Agent bugs are almost always visible as a wrong *decision* at a specific step: a bad tool argument, an observation the model misread, or a premature `end_turn`. Replaying the transcript step-by-step is the primary debugging tool. Track the step at which runs diverge from expectation.

**Monitoring.** Instrument steps-to-completion (a rising average signals degradation), tool-call success rate, loop-cap-hit rate (agents giving up), token/cost per task, and task success rate against a labeled eval set. Alert on runaway loops and cost spikes.

**Security.** Tool arguments are untrusted model output — validate and sandbox them. A bash tool must run in an isolated environment with an allowlist; a file tool must confine paths to a project root. Retrieved or fetched content can carry prompt injection that hijacks the agent; keep instructions separate from data and gate any irreversible action (send email, delete, pay) behind human approval. Least-privilege the credentials each tool holds.

**Scaling.** Prompt-cache the stable prefix to cut repeated-turn cost. Run independent tool calls concurrently. For fleets of agents, cap concurrent sessions and per-session budgets. When many similar tasks run, consider a cheaper model (`claude-haiku-4-5`) for simple sub-steps and reserve the stronger model for planning.

---

## 9. Interview Questions

**Q: What actually makes an LLM an "agent"?**
A: The loop plus tools plus autonomy over control flow. A plain call is one-shot; an agent runs the model repeatedly, lets it call tools, feeds results back, and — crucially — lets the *model* decide how many steps to take and when to stop, rather than your code scripting the sequence.

**Q: Describe the ReAct pattern.**
A: ReAct interleaves reasoning and acting: the model emits an explicit thought about what it needs, takes an action (tool call), observes the result, and reasons again. The reasoning grounds each action in a deliberate plan, and the observation prevents the model from hallucinating what the tool would have returned.

**Q: When should you NOT build an agent?**
A: When the task's steps are known and fixed — then a workflow is cheaper, faster, and more predictable. Also when errors are unrecoverable (no test or rollback), when the value doesn't justify higher cost and latency, or when the model isn't actually capable of the task. Start at the simplest tier and only escalate when the task is genuinely open-ended.

**Q: How does the agent loop terminate?**
A: Three ways: the model signals it's done (`stop_reason: "end_turn"`, no tool calls), a hard cap fires (max steps, wall-clock, or token budget), or an error path escalates to a human. You must always enforce a cap — an LLM can loop indefinitely if it keeps deciding it needs one more tool call.

**Q: Why must you append the assistant's tool_use blocks to history, not just the tool results?**
A: The Messages API pairs each `tool_result` (by `tool_use_id`) with the `tool_use` block that requested it. If you drop the assistant turn and send only results, the history is malformed — the model has no record of what it asked for — and the API rejects it or the model loses the thread.

**Q: Why return tool errors instead of raising them?**
A: Returning a `tool_result` with `is_error: true` keeps the model in the loop so it can adapt — retry with different arguments, pick another tool, or ask for clarification. Raising an exception kills the harness and forfeits the model's ability to recover, which is one of the main reasons to use an agent at all.

**Q: (Senior) How do you make a non-deterministic agent reliable enough for production?**
A: Constrain the space it operates in: focused tools with strict schemas, prescriptive prompts, hard step/budget caps, and a verification step that checks the outcome (run the test, re-read the result) before declaring success. Add human gates on irreversible actions, evaluate against a labeled task set to catch regressions, and log full transcripts so failures are diagnosable. You trade some autonomy for guarantees deliberately.

**Q: (Senior) An agent burns huge token cost per task. Where does it go and how do you cut it?**
A: Cost scales with loop depth because you re-send the entire growing context every turn. Cut it by prompt-caching the stable prefix (system + tools) so repeated turns pay ~0.1× on the cached span, minimizing steps-to-goal with better tools and prompts, compacting long histories, running independent tool calls in parallel to reduce turns, and downgrading simple sub-steps to a cheaper model.

**Q: (Senior) How do you keep an agent from being hijacked by content it retrieves?**
A: Treat all tool output — retrieved documents, fetched pages, file contents — as untrusted data, not instructions. Keep it clearly delimited from the system/instruction channel, don't let it silently expand the agent's authority, apply access control before retrieval, and gate any irreversible or high-privilege action behind human confirmation. Prompt injection is the agent-era analog of SQL injection.

**Q: What is grounding and why does it matter in the loop?**
A: Grounding means each action is conditioned on a real observation from a tool rather than the model's parametric guess. It matters because the loop is autoregressive over actions — an early ungrounded error propagates into every later step's context. A real tool result corrects the model's assumptions before the mistake compounds.

**Q: How do parallel tool calls work and what's the pitfall?**
A: A single model turn can contain multiple `tool_use` blocks; you execute them concurrently and return *all* the `tool_result` blocks in one user message. The pitfall is splitting those results across multiple user turns — that silently teaches the model to stop issuing parallel calls, serializing future work and slowing everything down.

**Q: Agent vs. workflow — give the one-sentence decision rule.**
A: If you can enumerate the steps in advance, write a workflow and own the control flow; if the right next step depends on what the last step returned and can't be scripted, use an agent and let the model own the control flow.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** An agent is an LLM in a loop with tools where the model owns the control flow. The loop is perceive → plan → act → observe, repeated until `end_turn` or a cap. ReAct interleaves explicit reasoning with tool calls so actions are deliberate and grounded. The harness calls the model, executes tools, appends `tool_result` blocks (with the assistant's `tool_use` blocks preserved), enforces step/budget guards, and returns tool errors so the model can recover. Reach for an agent only when the task is open-ended, valuable, feasible, and error-recoverable — otherwise use a workflow.

| Element | Role |
| --- | --- |
| Loop | perceive → plan → act → observe |
| Tool | typed function the model calls |
| Observation | tool result fed back into context |
| Stop | end_turn, step cap, or budget |
| Harness | runs loop, executes tools, guards limits |

- **Agent** → LLM + loop + tools + autonomy over control flow.
- **ReAct** → reason, act, observe, repeat.
- **Preserve history** → append `tool_use` *and* matching `tool_result`.
- **Always cap** → max steps, time, and token budget.
- **Agent vs. workflow** → open-ended → agent; scriptable → workflow.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement a manual agent loop with two tools (calculator + web search stub); log each thought, action, and observation.
- [ ] Add a max-steps guard and a "return partial result on cap" path; test it with a task that can't complete.
- [ ] Convert the manual loop to the SDK tool runner and compare the code.
- [ ] Introduce a flaky tool (fails 30% of the time) and verify the agent recovers via `is_error` results.
- [ ] Add prompt caching on the system + tools prefix and measure the per-turn cost drop across a 5-step run.

**Mini Project — "Repo Triage Agent."** Build an agent that triages a failing test in a small repo.
*Goal:* given "fix the failing test," reach a passing suite autonomously.
*Requirements:* tools for read-file, grep, edit-file, and run-tests (sandboxed); a manual or tool-runner loop with a step cap; full transcript logging; a verification step (rerun tests) before declaring success; a human-confirmation gate before writing any file.
*Extensions:* add parallel tool calls for reading multiple files; add a cheaper model for the grep/read steps and the strong model for editing; add an eval set of 10 seeded bugs and measure success rate; add compaction when the transcript grows large.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 33 — Tool & Function Calling** (the mechanics of the tool-use protocol)
- **Chapter 34 — Agent Memory & State** (managing the growing context of a long-running agent)
- **Chapter 36 — Multi-Agent Systems & Orchestration** (splitting work across cooperating agents)

**Free Learning Resources**
- **Building Effective Agents** — Anthropic · *Intermediate* · the canonical guide on when to use agents vs. workflows and how to compose the loop. <https://www.anthropic.com/engineering/building-effective-agents>
- **ReAct: Synergizing Reasoning and Acting in Language Models** — Yao et al. (arXiv) · *Advanced* · the paper that established the reason-act-observe pattern. <https://arxiv.org/abs/2210.03629>
- **Anthropic Tool Use Overview** — Anthropic Docs · *Intermediate* · the practical reference for the tool-use loop and the Messages API shape. <https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview>
- **A Survey on LLM-based Autonomous Agents** — Wang et al. (arXiv) · *Advanced* · a broad map of agent architectures, memory, and planning. <https://arxiv.org/abs/2308.11432>
- **Agents (whitepaper)** — Google / Kaggle · *Beginner–Intermediate* · an accessible overview of the agent loop, tools, and orchestration. <https://www.kaggle.com/whitepaper-agents>
- **LangGraph Conceptual Docs** — LangChain · *Intermediate* · how agent loops and control flow are modeled as graphs. <https://langchain-ai.github.io/langgraph/concepts/>

---

*AI Engineering Handbook — chapter 32.*
