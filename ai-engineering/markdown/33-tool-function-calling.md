# 33 · Tool & Function Calling

> **In one line:** Tool calling lets a model request a typed function by name with structured JSON arguments; your code runs it and returns the result, turning a text generator into something that can act on the world.

---

## 1. Overview

Left alone, an LLM can only produce text. **Tool calling** (also called function calling) is the protocol that lets it *do* things: you describe a set of functions with JSON schemas, the model decides when one is needed, emits a structured call with validated arguments, your code executes it, and you hand the result back. The model never runs your code — it only *requests* the call — which keeps a clean security boundary between the reasoning engine and the systems it touches.

The problem it solves is the gap between language and action. A user asks "what's my account balance?" The answer isn't in the model's weights; it's in a database. Without tools, the model hallucinates a number. With a `get_balance` tool, it emits `get_balance(account_id="…")`, your handler queries the real DB, and the model answers from the truth. Tool calling is the substrate on which every agent, RAG pipeline, and integration is built.

The idea evolved from brittle "parse the model's freeform text for a command" hacks into a first-class, schema-validated API. Modern APIs — like Anthropic's Messages API — define tools as objects with a `name`, `description`, and JSON Schema `input_schema`; the model responds with typed `tool_use` blocks the model provider guarantees to match the schema (and with strict mode, guarantees exactly). This structure is what makes tool calling reliable enough to build on.

A concrete example: a scheduling assistant. The user says "book me a 30-minute slot with Priya next Tuesday afternoon." The model calls `find_availability(person="Priya", date="2026-07-14", after="12:00")`, observes three open slots, then calls `create_event(title="Sync", start="2026-07-14T14:00", duration_min=30, attendees=["Priya"])`. Two typed calls, each argument validated, each executed by your code against real calendar APIs. Understanding the shape of that exchange — the schema, the tool-use loop, parallel calls, and error handling — is what this chapter delivers.

---

## 2. Core Concepts

- **Tool definition** — an object with `name`, `description`, and `input_schema` (JSON Schema) that tells the model what a function does and what arguments it takes.
- **`tool_use` block** — the model's structured request to call a tool, carrying an `id`, the tool `name`, and validated `input` arguments.
- **`tool_result` block** — your reply, keyed by `tool_use_id`, carrying the function's output (or an error) back into the model's context.
- **JSON Schema** — the contract for a tool's arguments: types, enums, required fields, descriptions. The model generates arguments that conform to it.
- **Tool choice** — a control over the model's behavior: `auto` (model decides), `any` (must call some tool), `tool` (must call a named one), `none` (no tools).
- **Parallel tool use** — a single model turn may contain multiple `tool_use` blocks; you run them concurrently and return all results together.
- **Strict mode** — `strict: true` on a tool definition guarantees the generated arguments validate exactly against the schema (requires `additionalProperties: false` and `required`).
- **The tool-use loop** — the request → execute → return → continue cycle that repeats until the model stops calling tools.

---

## 3. Theory & Mathematical Intuition

There is no exotic math here — the intuition is about *constrained generation*. A tool call is the model producing a structured object rather than free prose, and the reliability of that object comes from how the decoder is constrained.

Consider the model's job at each token: it produces a distribution over the vocabulary, `P(token | context)`, and samples. In freeform generation nothing stops it from emitting invalid JSON. Tool calling constrains this in two layers. First, **schema-conditioned prompting**: the tool definitions are injected into the context, so the model has seen the exact shape it must produce and has been trained to emit conformant structures. Second, **structured decoding / grammar constraints** (what strict mode leverages): the decoder is masked so that only tokens keeping the output valid against the schema grammar have nonzero probability:

```
P'(token | context) = P(token | context) · valid(token)   / Z
```

where `valid(token)` is 1 if appending it can still complete a schema-valid document and 0 otherwise, and `Z` renormalizes. This is why strict mode can *guarantee* validity: impossible tokens are literally unreachable.

The **argument-selection** intuition is that a tool's `description` and its parameter descriptions act as the model's only guide to *when* and *how* to call it. The model is effectively computing an implicit relevance score between the user's need and each tool's description, then filling arguments by grounding on the conversation. Prescriptive descriptions — "call this when the user asks about current prices" — measurably raise the should-call rate, because they sharpen that implicit match.

Parallel tool use falls out of the model emitting multiple independent `tool_use` blocks in one response when it recognizes several sub-goals with no data dependency between them — e.g. "weather in Paris and Tokyo" yields two independent calls. Dependent calls (call B needs A's result) can't parallelize; they serialize across loop turns.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="300" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">Schema-constrained argument generation</text>
  <rect x="30" y="60" width="200" height="120" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="130" y="82" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">input_schema</text>
  <text x="130" y="104" font-size="11" fill="#1e293b" text-anchor="middle">city: string (req)</text>
  <text x="130" y="122" font-size="11" fill="#1e293b" text-anchor="middle">unit: enum[C,F]</text>
  <text x="130" y="140" font-size="11" fill="#1e293b" text-anchor="middle">additionalProps: false</text>
  <text x="130" y="162" font-size="11" fill="#1e293b" text-anchor="middle">(the contract)</text>
  <rect x="280" y="80" width="160" height="80" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="360" y="108" font-size="12" fill="#1e293b" text-anchor="middle">decoder mask</text>
  <text x="360" y="128" font-size="11" fill="#1e293b" text-anchor="middle">valid(token) = 1</text>
  <text x="360" y="146" font-size="11" fill="#1e293b" text-anchor="middle">else 0</text>
  <line x1="230" y1="120" x2="280" y2="120" stroke="#4f46e5" stroke-width="2" marker-end="url(#c)"/>
  <rect x="490" y="80" width="200" height="80" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="590" y="106" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">tool_use block</text>
  <text x="590" y="128" font-size="11" fill="#1e293b" text-anchor="middle">{"city":"Paris",</text>
  <text x="590" y="146" font-size="11" fill="#1e293b" text-anchor="middle">"unit":"C"} valid</text>
  <line x1="440" y1="120" x2="490" y2="120" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c)"/>
  <defs>
    <marker id="c" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="215" font-size="12" fill="#1e293b" text-anchor="middle">P'(token) = P(token) · valid(token) / Z  — invalid tokens get zero probability.</text>
  <text x="360" y="245" font-size="12" fill="#1e293b" text-anchor="middle">Descriptions drive WHEN to call; the schema drives WHAT arguments are legal.</text>
  <text x="360" y="275" font-size="11" fill="#64748b" text-anchor="middle">strict: true makes conformance a hard guarantee, not a best effort.</text>
</svg>
```

---

## 4. Architecture & Workflow

1. **Define tools.** For each capability, write a `name`, a prescriptive `description` (say *when* to call it), and an `input_schema` in JSON Schema. Mark truly required parameters; use enums for fixed value sets.
2. **Send the request.** Call the model with the tools array, the conversation, and optionally a `tool_choice`.
3. **Inspect the response.** If `stop_reason` is `end_turn`, the model answered in text — done. If it's `tool_use`, the response contains one or more `tool_use` blocks.
4. **Validate & dispatch.** For each `tool_use` block, parse its `input` (it's already a structured object — never regex the raw string), route by `name`, and execute the function.
5. **Collect results.** Build a `tool_result` block per call, keyed by `tool_use_id`, with the output or an `is_error: true` result on failure.
6. **Return results.** Append the assistant's `tool_use` turn *and* a single user turn containing all `tool_result` blocks.
7. **Continue the loop.** Call the model again with the extended history; it reasons over the results and either answers or calls more tools.
8. **Repeat** until `end_turn`, enforcing a max-iteration guard.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="26" font-size="16" font-weight="bold" fill="#1e293b" text-anchor="middle">The tool-use loop (Messages API)</text>
  <rect x="40" y="60" width="150" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="115" y="82" font-size="12" fill="#1e293b" text-anchor="middle">your app</text>
  <text x="115" y="98" font-size="11" fill="#1e293b" text-anchor="middle">tools + messages</text>
  <rect x="290" y="60" width="150" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="365" y="86" font-size="12" fill="#1e293b" text-anchor="middle">model</text>
  <line x1="190" y1="82" x2="290" y2="82" stroke="#4f46e5" stroke-width="2" marker-end="url(#d)"/>
  <rect x="290" y="140" width="150" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="365" y="164" font-size="12" fill="#1e293b" text-anchor="middle">tool_use blocks</text>
  <text x="365" y="182" font-size="11" fill="#1e293b" text-anchor="middle">id, name, input</text>
  <line x1="365" y1="104" x2="365" y2="140" stroke="#0ea5e9" stroke-width="2" marker-end="url(#d)"/>
  <rect x="500" y="140" width="180" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="590" y="164" font-size="12" fill="#1e293b" text-anchor="middle">execute functions</text>
  <text x="590" y="182" font-size="11" fill="#1e293b" text-anchor="middle">(concurrent if independent)</text>
  <line x1="440" y1="170" x2="500" y2="170" stroke="#d97706" stroke-width="2" marker-end="url(#d)"/>
  <rect x="290" y="240" width="150" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="365" y="262" font-size="12" fill="#1e293b" text-anchor="middle">tool_result blocks</text>
  <text x="365" y="279" font-size="11" fill="#1e293b" text-anchor="middle">tool_use_id + output</text>
  <line x1="590" y1="200" x2="440" y2="255" stroke="#16a34a" stroke-width="2" marker-end="url(#d)"/>
  <path d="M 290 265 C 120 265, 115 130, 115 104" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#d)"/>
  <text x="180" y="150" font-size="11" fill="#16a34a">append + re-send</text>
  <defs>
    <marker id="d" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#1e293b"/>
    </marker>
  </defs>
  <text x="360" y="312" font-size="11" fill="#64748b" text-anchor="middle">Loop until stop_reason == end_turn.</text>
</svg>
```

---

## 5. Implementation

Defining tools, handling parallel calls, strict mode, and errors against the Messages API.

```python
import anthropic

client = anthropic.Anthropic()

tools = [
    {
        "name": "get_weather",
        "description": "Get current weather for a city. Call this whenever the user "
                       "asks about weather or conditions in a specific place.",
        "strict": True,                       # guarantees exact schema conformance
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["city", "unit"],
            "additionalProperties": False,    # required for strict mode
        },
    },
    {
        "name": "get_time",
        "description": "Get the current local time in a city.",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
]

def dispatch(name, args):                     # your real handlers
    if name == "get_weather":
        return f"{args['city']}: 18°, light rain"
    if name == "get_time":
        return f"{args['city']}: 14:32 local"
    return "unknown tool"
```

```python
def run(query, max_steps=6):
    messages = [{"role": "user", "content": query}]
    for _ in range(max_steps):
        resp = client.messages.create(
            model="claude-sonnet-4", max_tokens=1024,
            tools=tools, messages=messages,
        )
        if resp.stop_reason != "tool_use":
            return next(b.text for b in resp.content if b.type == "text")

        messages.append({"role": "assistant", "content": resp.content})

        # PARALLEL: one turn may hold several tool_use blocks — run all,
        # return ALL results in ONE user message.
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                try:
                    out = dispatch(block.name, block.input)   # input is parsed, not raw
                    results.append({"type": "tool_result",
                                    "tool_use_id": block.id, "content": out})
                except Exception as e:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": f"Error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    return "step budget exhausted"

# "Weather and time in Paris?" → model emits TWO tool_use blocks in one turn.
print(run("What's the weather and current time in Paris?"))
```

Forcing a specific tool with `tool_choice`, and validating structured output:

```python
resp = client.messages.create(
    model="claude-sonnet-4", max_tokens=512,
    tools=tools,
    tool_choice={"type": "tool", "name": "get_weather"},   # must call get_weather
    messages=[{"role": "user", "content": "Paris"}],
)
call = next(b for b in resp.content if b.type == "tool_use")
assert set(call.input) <= {"city", "unit"}      # strict mode guarantees this holds
```

**Optimization note.** Cache the tools + system prefix with prompt caching — tool definitions are large and stable, so they're prime cache candidates (any change to the tool list invalidates the whole cache, so serialize tools deterministically). Keep the tool set small and focused; with hundreds of tools, use **tool search** so only relevant schemas load into context. Batch parallel calls and never split their results across turns.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Typed schemas | Validated, parseable arguments; no fragile text parsing | Schema authoring effort; over-constrained schemas frustrate the model |
| Strict mode | Guaranteed conformance | First-request compile latency; forbids some schema features |
| Parallel calls | Concurrency cuts latency for independent work | Must return all results together or lose the behavior |
| `tool_choice` control | Force or forbid tool use deterministically | Forcing a tool can produce a bad call when none fits |
| Clean boundary | Model requests, your code executes | You own validation, sandboxing, and auth |
| Descriptions as routing | Prescriptive descriptions lift call accuracy | Vague descriptions cause missed or wrong calls |
| Many tools | Rich capability surface | Too many tools degrade selection; needs tool search |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Regex-parsing the model's serialized tool input → ✅ read the already-parsed `input` object; escaping varies between models.
2. ⚠️ Vague tool descriptions ("weather") → ✅ prescriptive descriptions stating *when* to call ("call when the user asks about conditions in a place").
3. ⚠️ Dropping the assistant's `tool_use` blocks before sending results → ✅ append the full assistant turn, then the `tool_result` turn.
4. ⚠️ Mismatched or missing `tool_use_id` on results → ✅ key every `tool_result` to the exact `tool_use.id` it answers.
5. ⚠️ Splitting parallel results across multiple user turns → ✅ return them all in one user message.
6. ⚠️ Strict mode without `additionalProperties: false` and `required` → ✅ include both, or strict validation fails.
7. ⚠️ Raising on tool failure → ✅ return `tool_result` with `is_error: true` so the model adapts.
8. ⚠️ Exposing 50 tools with overlapping purposes → ✅ keep the set focused and disjoint; use tool search for large libraries.
9. ⚠️ Trusting arguments blindly → ✅ validate and sanitize before executing (paths, SQL, shell) — arguments are untrusted model output.
10. ⚠️ Forcing a tool with `tool_choice` when none fits → ✅ use `auto` unless you truly need to force, and handle the "no good tool" case.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a tool is called with wrong arguments or not called when it should be, inspect two things: the tool's `description` (does it say *when* to use it?) and the argument descriptions (are they unambiguous?). Log every `tool_use` — name, arguments, result — and the `stop_reason`. Most tool-calling bugs are description or schema bugs, not model bugs; a badly worded description silently steers selection.

**Monitoring.** Track per-tool call frequency, argument-validation failure rate, tool execution error rate, and end-to-end tool-loop latency. A spike in one tool's error rate often means an upstream API changed; a drop in a tool's usage after a prompt edit signals a description regression.

**Security.** Tool arguments are untrusted model output — the model can be steered by prompt injection to emit hostile arguments. Validate every argument against an allowlist, parameterize SQL, sandbox shell/bash tools, and confine file paths to a project root (reject `..` and symlinks). Gate irreversible or high-privilege tools (send money, delete data, email) behind human confirmation, and give each tool the least privilege it needs.

**Scaling.** Prompt-cache the stable tools + system prefix to cut cost on multi-turn loops. Execute independent calls concurrently. For large tool catalogs, tool search keeps only relevant schemas in context, preserving the cache. Rate-limit and circuit-break slow or flaky downstream tools so one bad dependency doesn't stall the loop.

---

## 9. Interview Questions

**Q: Walk through one iteration of the tool-use loop.**
A: You send tools + messages. The model responds; if `stop_reason` is `tool_use`, its content holds `tool_use` blocks (id, name, input). You append that assistant turn, execute each tool, build a `tool_result` per call keyed by `tool_use_id`, append them all in one user turn, and call the model again. Repeat until `end_turn`.

**Q: Why should you never regex the model's tool arguments from raw text?**
A: The API delivers `input` as an already-parsed structured object; different models escape JSON differently (Unicode, forward slashes), so raw string matching is brittle and breaks silently across model upgrades. Read the parsed object, which the SDK guarantees is valid JSON.

**Q: What does strict mode guarantee and what does it require?**
A: `strict: true` guarantees the generated arguments validate exactly against your schema — no extra fields, correct types, required present — by constraining decoding to schema-valid tokens. It requires `additionalProperties: false` and a `required` list, and it can't express some schema features (like numeric ranges). There's a one-time schema-compile latency on first use.

**Q: How do parallel tool calls work and what's the failure mode?**
A: A single model turn can contain multiple independent `tool_use` blocks (e.g. weather in two cities). You execute them concurrently and return *all* the `tool_result` blocks in one user message. If you split those results across multiple user turns, you silently train the model to stop making parallel calls, serializing future work.

**Q: What are the `tool_choice` options and when do you force a tool?**
A: `auto` (model decides — the default), `any` (must call some tool), `tool` (must call a specific named one), and `none` (no tools). Force a specific tool when you're using the model purely for structured extraction and always want that call; otherwise leave it `auto`, because forcing a tool that doesn't fit produces a poor call.

**Q: Why return tool errors instead of raising them?**
A: A `tool_result` with `is_error: true` keeps the model in the loop so it can retry with corrected arguments, choose a different tool, or ask for clarification. Raising an exception aborts the loop and forfeits recovery. The error message you return becomes the model's guidance, so make it informative.

**Q: (Senior) The model isn't calling a tool it should. How do you diagnose and fix it?**
A: It's almost always a description problem. Check the tool's `description` — make it prescriptive about *when* to call ("call this when the user asks about current prices"), which measurably raises the should-call rate on models that reach for tools conservatively. Also verify the tool isn't drowned among too many similar tools, that the argument descriptions are clear, and that `tool_choice` isn't set to `none`. Instrument call frequency before and after the edit.

**Q: (Senior) How does structured decoding actually guarantee valid JSON?**
A: The decoder is masked against the schema's grammar: at each step, only tokens that keep the partial output completable to a schema-valid document retain nonzero probability, the rest are zeroed and the distribution renormalizes. Invalid continuations become literally unreachable, so the output can't drift off-schema — that's the mechanism strict mode uses.

**Q: (Senior) Tool definitions are large. How do you keep multi-turn tool loops cheap?**
A: Prompt-cache the tools + system prefix, since it's stable across turns and renders first in the cache prefix — repeated turns then pay ~0.1× on that span. Serialize tools deterministically so a reordering doesn't invalidate the cache. For very large catalogs, use tool search so only relevant schemas enter context (they're appended, preserving the cache) rather than loading all of them upfront.

**Q: What's the difference between tool calling and structured outputs?**
A: Structured outputs constrain the model's *final response* to a JSON schema (e.g. always return `{name, email}`). Tool calling constrains the model's *action requests* — the model asks to run a function with typed arguments, and you execute it. Both use JSON Schema and can use strict mode, but tool calling is about acting on the world, structured output is about the shape of the answer.

**Q: Why is the model-requests-you-execute split a security feature?**
A: The model never runs code; it only emits a request that your harness chooses whether and how to execute. That boundary lets you validate arguments, enforce auth, sandbox execution, and gate destructive actions before anything runs — so a prompt-injected hostile argument still has to pass your checks. Collapsing that boundary (letting the model execute directly) removes your only enforcement point.

**Q: How does the model decide which tool to call?**
A: It matches the user's need against each tool's `description` and fills arguments by grounding on the conversation, effectively an implicit relevance ranking over the descriptions. That's why prescriptive, disjoint descriptions matter — overlapping or vague ones make the implicit match ambiguous and produce wrong or missed calls.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A tool is `{name, description, input_schema}`. The model emits `tool_use` blocks (id, name, parsed input); you execute and return `tool_result` blocks keyed by `tool_use_id`, appending the assistant turn first. Loop until `end_turn`. Descriptions drive *when* to call; the schema drives *what* arguments are legal; strict mode makes conformance a hard guarantee. Parallel calls arrive in one turn — return all results in one user message. Return errors with `is_error: true`. Validate arguments — they're untrusted.

| Element | Key point |
| --- | --- |
| Definition | name + prescriptive description + JSON Schema |
| Request | model emits `tool_use` (id, name, input) |
| Reply | `tool_result` keyed by `tool_use_id` |
| Choice | auto / any / tool / none |
| Strict | needs `additionalProperties: false` + `required` |

- **Read parsed input** → never regex the serialized arguments.
- **Preserve history** → append `tool_use` turn before results.
- **Parallel** → all results in one user message.
- **Errors** → `is_error: true`, keep the model in the loop.
- **Descriptions** → say *when* to call, not just what.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Define three tools with strict mode; verify generated arguments always conform.
- [ ] Trigger a parallel call ("weather in 3 cities") and confirm all results return in one user turn.
- [ ] Force a specific tool with `tool_choice` and observe the difference from `auto`.
- [ ] Make a tool fail and confirm the model recovers via an `is_error` result.
- [ ] A/B two versions of a tool description (vague vs. prescriptive) and measure the change in call rate over 20 queries.

**Mini Project — "Structured Data Extractor with Tools."** Build a service that answers questions over a small SQL database via tool calling.
*Goal:* the model answers natural-language questions by calling typed query tools, never hallucinating data.
*Requirements:* tools for `list_tables`, `describe_table`, and `run_query` (parameterized, read-only, allowlisted); strict schemas; a tool-use loop with a step cap; argument validation and SQL parameterization; `is_error` handling; logging of every call.
*Extensions:* add prompt caching on the tools prefix and measure the cost drop; add a `tool_choice`-forced extraction endpoint; add a destructive `delete_row` tool gated behind human confirmation; add tool search once you exceed ~15 tools.

---

## 12. Related Topics & Free Learning Resources

- **Chapter 32 — AI Agents: The Loop, Tools & Autonomy** (tool calling as the agent's action mechanism)
- **Chapter 34 — Agent Memory & State** (managing context across many tool-call turns)
- **Chapter 35 — Model Context Protocol (MCP)** (a standard way to expose tools to any model)

**Free Learning Resources**
- **Tool Use with Claude** — Anthropic Docs · *Intermediate* · the authoritative reference for the tool-use loop, schemas, `tool_choice`, and parallel calls. <https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview>
- **Implement Tool Use** — Anthropic Docs · *Intermediate* · step-by-step handling of `tool_use`/`tool_result` and error handling. <https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use>
- **JSON Schema — Understanding JSON Schema** — json-schema.org · *Beginner–Intermediate* · the reference for writing correct `input_schema` contracts. <https://json-schema.org/understanding-json-schema>
- **Structured Outputs & Strict Tool Use** — Anthropic Docs · *Intermediate* · how schema conformance is guaranteed. <https://docs.claude.com/en/docs/build-with-claude/structured-outputs>
- **Function Calling Guide** — OpenAI Docs · *Intermediate* · a second provider's take on the same protocol, useful for contrast. <https://platform.openai.com/docs/guides/function-calling>
- **Toolformer: Language Models Can Teach Themselves to Use Tools** — Schick et al. (arXiv) · *Advanced* · the research grounding for models learning to call APIs. <https://arxiv.org/abs/2302.04761>

---

*AI Engineering Handbook — chapter 33.*
