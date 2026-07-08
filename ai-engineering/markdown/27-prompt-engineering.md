# 27 · Prompt Engineering

> **In one line:** Prompt engineering is the discipline of structuring inputs — instructions, examples, roles, and output specs — to reliably steer a fixed model toward the behavior you want.

---

## 1. Overview

**Prompt engineering** is the practice of designing the text you send to a language model so it produces the output you need, reliably and repeatably, *without changing the model's weights*. Because a chat model has already absorbed a vast range of skills during training, the task is less about teaching it something new and more about **selecting and activating the right behavior** it already has. A good prompt is a specification: it tells the model who it is, what to do, what inputs to use, and exactly what the output should look like.

The problem prompt engineering solves is **controllability of a probabilistic system**. LLMs are sensitive to phrasing — the same request worded two ways can yield very different quality. Rather than fine-tuning (expensive, slow, and easy to overfit), prompting lets you adapt a general model to a specific task in seconds, iterate in minutes, and deploy immediately. For most applications, a well-crafted prompt plus retrieval beats fine-tuning on both cost and time-to-value.

The field emerged from the "in-context learning" surprise in GPT-3 (Brown et al., 2020): the model could perform a task from a few examples in the prompt alone, with no gradient updates. Then Wei et al. (2022) showed that simply asking the model to "think step by step" — **chain-of-thought (CoT)** — dramatically improved reasoning. Since then, patterns like few-shot exemplars, role prompting, structured output, and self-consistency have become the standard toolkit of applied LLM work.

A concrete real-world example: an e-commerce team needs to extract structured data from messy product reviews. A vague prompt ("summarize this review") returns free-form prose that's useless downstream. A well-engineered prompt — assigning a role ("You are a data extraction service"), specifying an exact JSON schema, giving two examples of input→output, and instructing "output only valid JSON" — returns parseable, consistent records the pipeline can ingest directly. Same model, night-and-day reliability.

The durable mental model: **the model is a capable but literal contractor; the prompt is the work order.** Ambiguity in the order produces variance in the result. The engineering is in removing ambiguity — through explicit instructions, concrete examples, clear roles, and precise output contracts — until the model has exactly one reasonable interpretation of what you want.

---

## 2. Core Concepts

- **System prompt** — a high-priority instruction (role, rules, tone, constraints) that frames the entire conversation, kept separate from user turns.
- **Zero-shot prompting** — asking for a task with instructions but no examples.
- **Few-shot prompting** — including a handful of input→output examples in the prompt to demonstrate the task and format.
- **In-context learning** — the model's ability to adapt to a task from examples in the prompt, with no weight updates.
- **Chain-of-thought (CoT)** — prompting the model to produce intermediate reasoning steps before the final answer, improving accuracy on multi-step problems.
- **Role/persona prompting** — assigning the model an identity ("You are a senior tax accountant") to bias tone and expertise.
- **Structured output** — constraining the response to a machine-readable format (JSON, XML tags) via schema or explicit format instructions.
- **Delimiters** — using markers (triple backticks, XML tags) to cleanly separate instructions from data and reduce injection risk.
- **Self-consistency** — sampling multiple CoT answers and taking a majority vote to boost reasoning accuracy.
- **Prompt template** — a reusable, parameterized prompt with slots filled at runtime.

---

## 3. Theory & Mathematical Intuition

There is no new math in prompting — it reuses next-token prediction (Ch. 25) — but there's a useful *probabilistic intuition*. The model computes `P(output | prompt)`. A prompt is effective when it makes the desired output the high-probability continuation and suppresses undesired ones. Every element you add — a role, an example, a format constraint — reshapes that conditional distribution.

**Why few-shot works:** examples condition the model on a *pattern*. After seeing two `input → JSON` pairs, the continuation `input → ` most probably continues with JSON of the same shape. You are steering the distribution by demonstration rather than description.

**Why CoT works:** the final answer to a hard problem may be low-probability directly, but high-probability *given* the correct intermediate steps. By allocating tokens to reasoning, the model conditions its answer on its own scratch work — effectively using generated tokens as working memory. This is why CoT helps on arithmetic and logic but not on simple recall.

**Self-consistency** exploits the variance in sampled reasoning: `answer = mode({sample_i})` over n independent CoT samples. Correct reasoning paths tend to converge on the same answer while errors scatter, so the majority vote is more accurate than any single sample.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="300" fill="#f0fdf4"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Chain-of-Thought reshapes the answer distribution</text>
  <rect x="40" y="70" width="260" height="180" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="170" y="95" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">Direct answer</text>
  <text x="170" y="120" text-anchor="middle" font-size="11" fill="#1e293b">Q → answer</text>
  <rect x="90" y="150" width="30" height="40" fill="#16a34a"/>
  <rect x="130" y="130" width="30" height="60" fill="#d97706"/>
  <rect x="170" y="140" width="30" height="50" fill="#d97706"/>
  <rect x="210" y="160" width="30" height="30" fill="#d97706"/>
  <text x="170" y="215" text-anchor="middle" font-size="11" fill="#1e293b">correct answer not dominant</text>
  <line x1="85" y1="190" x2="245" y2="190" stroke="#1e293b" stroke-width="1.5"/>
  <rect x="360" y="70" width="260" height="180" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="490" y="95" text-anchor="middle" font-size="13" fill="#1e293b" font-weight="bold">Step-by-step</text>
  <text x="490" y="120" text-anchor="middle" font-size="11" fill="#1e293b">Q → steps → answer</text>
  <rect x="410" y="115" width="30" height="75" fill="#16a34a"/>
  <rect x="450" y="165" width="30" height="25" fill="#0ea5e9"/>
  <rect x="490" y="170" width="30" height="20" fill="#0ea5e9"/>
  <rect x="530" y="175" width="30" height="15" fill="#0ea5e9"/>
  <text x="490" y="215" text-anchor="middle" font-size="11" fill="#1e293b">reasoning makes it dominant</text>
  <line x1="405" y1="190" x2="565" y2="190" stroke="#1e293b" stroke-width="1.5"/>
  <text x="330" y="280" text-anchor="middle" font-size="12" fill="#1e293b">Intermediate steps condition the answer, raising P(correct)</text>
</svg>
```

---

## 4. Architecture & Workflow

A production prompt is assembled from parts, not written as one blob. The standard workflow:

1. **Define the task and success criteria** — what exact output do you need, and how will you judge it? Write 5–10 test cases first.
2. **Assign a role** in the system prompt — the persona/expertise that biases the model correctly ("You are a meticulous SQL analyst").
3. **State the instruction clearly and specifically** — imperative, unambiguous, with any hard constraints (length, tone, what to refuse).
4. **Provide context/data with delimiters** — wrap user-supplied or retrieved data in clear markers (`<document>…</document>`) separate from instructions.
5. **Show examples (few-shot)** — 1–5 input→output pairs demonstrating the exact format, especially for structured output.
6. **Specify the output contract** — the exact format ("Respond only with JSON matching this schema") and what to do on failure ("If the answer isn't in the document, return null").
7. **Add reasoning scaffolding if needed** — "Think step by step" or a `<scratchpad>` for hard tasks; keep the final answer separate.
8. **Test, measure, iterate** — run against your test cases, inspect failures, and adjust one element at a time.
9. **Templatize and deploy** — freeze the working prompt as a parameterized template with runtime slots.

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#eef2ff"/>
  <text x="330" y="28" text-anchor="middle" font-size="16" fill="#1e293b" font-weight="bold">Anatomy of a Production Prompt</text>
  <rect x="60" y="55" width="540" height="45" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="80" y="82" font-size="13" fill="#1e293b" font-weight="bold">System / Role:</text>
  <text x="210" y="82" font-size="12" fill="#1e293b">"You are a precise data-extraction service."</text>
  <rect x="60" y="110" width="540" height="45" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="80" y="137" font-size="13" fill="#1e293b" font-weight="bold">Instruction:</text>
  <text x="200" y="137" font-size="12" fill="#1e293b">"Extract fields X, Y, Z. Output only JSON."</text>
  <rect x="60" y="165" width="540" height="45" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="80" y="192" font-size="13" fill="#1e293b" font-weight="bold">Examples:</text>
  <text x="185" y="192" font-size="12" fill="#1e293b">input → {"x":..., "y":...}  (1-5 shots)</text>
  <rect x="60" y="220" width="540" height="45" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="80" y="247" font-size="13" fill="#1e293b" font-weight="bold">Data:</text>
  <text x="150" y="247" font-size="12" fill="#1e293b">&lt;document&gt; ...user text, delimited... &lt;/document&gt;</text>
  <rect x="60" y="275" width="540" height="45" rx="6" fill="#fce7f3" stroke="#db2777" stroke-width="2"/>
  <text x="80" y="302" font-size="13" fill="#1e293b" font-weight="bold">Output contract:</text>
  <text x="235" y="302" font-size="12" fill="#1e293b">"If a field is missing, use null. JSON only."</text>
</svg>
```

---

## 5. Implementation

Prompt engineering is language-agnostic, but here it is applied through the Anthropic Messages API. First, a zero-shot vs few-shot comparison for structured extraction:

```python
import anthropic, json

client = anthropic.Anthropic()

SYSTEM = (
    "You are a precise data-extraction service. "
    "Given a product review, output ONLY a JSON object with keys "
    "'sentiment' (positive|negative|neutral), 'rating' (1-5 int or null), "
    "and 'themes' (list of short strings). No prose, no markdown fences."
)

FEW_SHOT = [
    {"role": "user", "content": "Review: Battery dies in two hours. Waste of money."},
    {"role": "assistant", "content": '{"sentiment": "negative", "rating": 1, "themes": ["battery life", "value"]}'},
    {"role": "user", "content": "Review: Sleek design, works fine, nothing special."},
    {"role": "assistant", "content": '{"sentiment": "neutral", "rating": 3, "themes": ["design"]}'},
]

def extract(review: str) -> dict:
    resp = client.messages.create(
        model="claude-sonnet-4",
        max_tokens=256,
        temperature=0,                      # deterministic for extraction
        system=SYSTEM,
        messages=FEW_SHOT + [{"role": "user", "content": f"Review: {review}"}],
    )
    return json.loads(resp.content[0].text)

print(extract("Camera is stunning but the app crashes constantly."))
# {'sentiment': 'negative', 'rating': None, 'themes': ['camera', 'app stability']}
```

Chain-of-thought with a separated final answer, so downstream code can parse just the result:

```python
COT_SYSTEM = (
    "Solve the problem. First reason step by step inside <scratchpad> tags. "
    "Then give ONLY the final numeric answer inside <answer> tags."
)

resp = client.messages.create(
    model="claude-opus-4",
    max_tokens=1024,
    temperature=0,
    system=COT_SYSTEM,
    messages=[{"role": "user", "content":
        "A shop sells pens at 3 for $2. How much for 21 pens?"}],
)
text = resp.content[0].text
answer = text.split("<answer>")[1].split("</answer>")[0].strip()
print(answer)  # 14
```

Self-consistency: sample several CoT answers and majority-vote.

```python
from collections import Counter

def self_consistent(question: str, n: int = 5) -> str:
    answers = []
    for _ in range(n):
        r = client.messages.create(
            model="claude-sonnet-4", max_tokens=512, temperature=0.8,
            system=COT_SYSTEM,
            messages=[{"role": "user", "content": question}],
        )
        t = r.content[0].text
        answers.append(t.split("<answer>")[1].split("</answer>")[0].strip())
    return Counter(answers).most_common(1)[0][0]
```

**Optimization note:** Put the *stable* parts of your prompt (system prompt, few-shot examples, long reference docs) at the front and the *variable* part (the user's query) at the end. Providers cache the fixed prefix, so repeated calls with the same instructions and examples cost far less and respond faster. Never interpolate volatile values (timestamps, request IDs) into the cached prefix — it invalidates the cache.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Speed to deploy | Iterate in minutes, no training | Brittle to phrasing; small edits shift behavior |
| Cost | No GPUs, no fine-tuning pipeline | Long prompts (many examples) raise per-call token cost |
| Few-shot | Teaches format/pattern instantly | Examples consume context and can overfit to their style |
| CoT | Big accuracy gains on reasoning | More output tokens → higher latency and cost |
| Role prompting | Cheap way to bias tone/expertise | Persona can leak or be overridden by injection |
| Structured output | Machine-parseable, pipeline-ready | Model can still drift; needs validation/retry |
| Self-consistency | Boosts reasoning accuracy | n× cost and latency |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ Vague instructions ("summarize this") → ✅ Be specific about length, format, audience, and what to include/exclude.
2. ⚠️ Mixing instructions and data with no separation → ✅ Delimit data with XML tags or fences so the model (and you) know what's an instruction vs input — this also reduces prompt injection.
3. ⚠️ Asking for JSON without examples or a schema → ✅ Show the exact schema and 1–2 examples; instruct "output only valid JSON, no markdown fences."
4. ⚠️ Using CoT for tasks that don't need reasoning → ✅ Reserve CoT for multi-step problems; for simple extraction/classification it just wastes tokens.
5. ⚠️ Putting the reasoning and the answer in one blob → ✅ Separate the final answer (e.g. in `<answer>` tags) so code can parse it deterministically.
6. ⚠️ Overloading one prompt with ten tasks → ✅ Decompose into focused steps or separate calls; single-responsibility prompts are more reliable.
7. ⚠️ Testing on one happy-path example → ✅ Build a test set covering edge cases (empty input, missing fields, adversarial phrasing) and measure before shipping.
8. ⚠️ Ignoring the system prompt → ✅ Put durable rules, role, and constraints in the system prompt; keep the user turn for the actual task.
9. ⚠️ Trusting the model to follow "always/never" perfectly → ✅ Validate output programmatically and add a retry or repair step; instructions reduce but don't guarantee compliance.
10. ⚠️ Changing five things at once when a prompt fails → ✅ Iterate one variable at a time so you know what actually helped.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a prompt misbehaves, log the *fully assembled* prompt (system + examples + data) exactly as sent — most failures are template bugs (a slot filled wrong, data landing inside the instruction block). Reproduce with temperature 0 to remove sampling noise, then change one element at a time. Keep a versioned library of prompts with their test results so regressions are visible.

**Monitoring.** Track output-format validity rate (e.g. % of responses that parse as valid JSON), task-success rate against a golden set, token cost per call, and latency. When you upgrade the model version, re-run your test suite — prompts that worked on one model can regress on another.

**Security.** **Prompt injection** is the dominant risk: untrusted data (a web page, a user message, a retrieved document) can contain instructions like "ignore previous instructions and…". Mitigate by keeping trusted instructions in the system prompt, wrapping untrusted data in delimiters and explicitly telling the model to treat delimited content as data not instructions, never granting tool/side-effect access based on instructions found *inside* untrusted content, and validating all output before acting on it. Assume any text you didn't write could be adversarial.

**Scaling.** Cache the stable prompt prefix (system + few-shot) to cut cost and latency across many calls. Route by difficulty — cheap model (`claude-sonnet-4`) for routine tasks, flagship (`claude-opus-4`) for hard reasoning. Templatize prompts and store them in version control with owners and tests, so prompt changes go through the same review as code. For high-volume batch work, minimize few-shot examples to the smallest set that still passes your tests.

---

## 9. Interview Questions

**Q: What is the difference between zero-shot and few-shot prompting?**
A: Zero-shot gives the model instructions but no examples; few-shot includes a handful of input→output demonstrations. Few-shot is more reliable for enforcing a specific format or a subtle task because the examples condition the model on the exact pattern, whereas zero-shot relies entirely on the model interpreting your description.

**Q: Why does chain-of-thought prompting improve accuracy?**
A: On multi-step problems the correct final answer may be low-probability directly but high-probability given the correct intermediate steps. Asking the model to reason step by step lets it use generated tokens as working memory, conditioning its answer on its own scratch work. It helps on reasoning/arithmetic but not on simple recall.

**Q: When should you NOT use chain-of-thought?**
A: For simple tasks — direct classification, extraction, or factual lookup — where no multi-step reasoning is needed. CoT there just adds latency, cost, and tokens without accuracy gains, and can even introduce errors by over-thinking a trivial question.

**Q: How do delimiters help, and why do they matter for security?**
A: Delimiters (XML tags, fences) cleanly separate instructions from data so the model knows which text is a command and which is content to process. For security, wrapping untrusted input in delimiters and telling the model to treat it as data — not instructions — reduces prompt injection, where malicious text tries to hijack the model's behavior.

**Q: What is the role of the system prompt?**
A: It sets the durable frame for the whole conversation — the model's role, tone, rules, and hard constraints — at a higher priority than user turns. Putting stable instructions there keeps user turns focused on the task and makes behavior more consistent and cache-friendly.

**Q: How would you get reliable JSON output from a model?**
A: Specify the exact schema, give 1–2 examples, instruct "output only valid JSON, no markdown fences," set temperature to 0, and — critically — validate the output programmatically with a retry/repair step. Where available, use the provider's structured-output feature that constrains generation to schema-valid tokens.

**Q: (Senior) What is self-consistency and when is it worth the cost?**
A: Self-consistency samples multiple independent chain-of-thought completions at moderate temperature and takes a majority vote on the final answer. Correct reasoning paths tend to agree while errors scatter, so the vote beats any single sample. It's worth the n× cost on high-stakes reasoning tasks where accuracy matters more than latency/price.

**Q: (Senior) When is prompt engineering preferable to fine-tuning, and when not?**
A: Prefer prompting when you need fast iteration, low cost, no training infrastructure, and the base model already has the capability — which covers most applications, especially combined with retrieval. Prefer fine-tuning when you need consistent adherence to a very specific style/format at scale, want to bake in domain vocabulary, or need to shrink prompts (and cost) by moving instructions into weights — but it's slower, costlier, and can degrade general ability.

**Q: (Senior) How do you make a prompt robust rather than lucky?**
A: Treat it like software: write a test set of diverse and adversarial cases first, measure success rate, change one variable at a time, version the prompt, and re-run the suite on every model upgrade. Add programmatic validation and a repair step so the system degrades gracefully instead of silently emitting malformed output.

**Q: Why might the same prompt give different answers across two model versions?**
A: Models differ in training data, alignment, and default behaviors, so a prompt tuned to exploit one model's tendencies may not transfer. Instruction-following strictness, verbosity, and format adherence all shift between versions — which is why you re-run your evaluation suite after any model change rather than assuming portability.

**Q: What's a good general structure for a complex prompt?**
A: Role/system → clear instruction → constraints → delimited context/data → few-shot examples → explicit output contract (format + failure behavior), with optional reasoning scaffolding for hard tasks and the variable user input placed last so the fixed prefix can be cached.

**Q: How do you handle a case where the answer isn't present in the provided data?**
A: Explicitly instruct the failure behavior — e.g. "If the answer is not in the document, respond with null" or "say 'not found'" — rather than letting the model guess. Without an explicit escape hatch, models tend to hallucinate a plausible-sounding answer to fill the gap.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Prompting steers a fixed model by shaping `P(output | prompt)`. Structure: role → instruction → constraints → delimited data → few-shot examples → output contract, variable input last. Zero-shot for simple tasks; few-shot to lock in format; CoT for multi-step reasoning (separate the final answer); self-consistency (sample-and-vote) for hard reasoning at n× cost. Use temperature 0 and explicit schemas for structured output, and always validate programmatically. Delimit untrusted data and treat it as data, not instructions, to blunt prompt injection. Test with a golden set, change one thing at a time, version everything.

| Technique | Use when |
|---|---|
| Zero-shot | Simple, well-known tasks |
| Few-shot | Enforce format / subtle patterns |
| Chain-of-thought | Multi-step reasoning |
| Self-consistency | High-stakes reasoning (n× cost) |
| Role prompting | Bias tone/expertise cheaply |
| Structured output | Pipeline-ready machine data |

Flash cards:
- **What does few-shot teach the model?** → The exact pattern/format via examples.
- **Why does CoT help?** → Intermediate steps condition the answer, raising P(correct).
- **Biggest security risk in prompting?** → Prompt injection via untrusted data.
- **How to get parseable JSON?** → Schema + examples + temperature 0 + validation.
- **Prompt vs fine-tune default?** → Try prompting + retrieval first.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Take a vague prompt and rewrite it with role, constraints, and an output contract; compare outputs.
- [ ] Convert a zero-shot extraction prompt to few-shot and measure the improvement in format compliance over 20 inputs.
- [ ] Add `<scratchpad>`/`<answer>` CoT scaffolding to a math prompt and parse only the answer.
- [ ] Implement self-consistency (sample n, majority vote) and compare accuracy to a single sample on 10 word problems.
- [ ] Craft a prompt-injection attack against your own extraction prompt, then defend it with delimiters and explicit instructions.

**Mini Project — Reliable review-to-JSON extractor.**
*Goal:* A service that turns free-text product reviews into validated JSON records, with a measured success rate.
*Requirements:* System-prompt role + JSON schema + 2–3 few-shot examples; temperature 0; a validator that checks the schema and retries once with a repair instruction on failure; a test set of 30 reviews (including empty, adversarial, and multi-language) with a reported parse-success and field-accuracy score.
*Extension ideas:* Add a prompt-injection test suite and harden against it; A/B two prompt variants and report which wins; add prompt caching for the fixed prefix and measure the cost reduction.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **How LLMs Work** (why in-context learning exists), **Decoding & Sampling** (temperature's role in output reliability), **Context Windows, Tokens & Cost** (budgeting few-shot examples), and **Retrieval-Augmented Generation** (feeding grounded context into prompts).

**Free Learning Resources**
- **Anthropic Prompt Engineering Guide** — Anthropic · *Beginner→Advanced* · practical, model-specific techniques (roles, XML tags, CoT, prefills). <https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/overview>
- **Learn Prompting** — Learn Prompting (open source) · *Beginner→Intermediate* · comprehensive free course covering every major technique. <https://learnprompting.org/>
- **Chain-of-Thought Prompting Elicits Reasoning** — Wei et al. · *Advanced* · the paper that introduced CoT. <https://arxiv.org/abs/2201.11903>
- **Self-Consistency Improves Chain of Thought Reasoning** — Wang et al. · *Advanced* · the sample-and-vote method. <https://arxiv.org/abs/2203.11171>
- **Language Models are Few-Shot Learners (GPT-3)** — Brown et al. · *Advanced* · the origin of in-context/few-shot learning. <https://arxiv.org/abs/2005.14165>
- **OpenAI Prompt Engineering Guide** — OpenAI · *Beginner* · concise, provider-neutral best practices. <https://platform.openai.com/docs/guides/prompt-engineering>
- **DeepLearning.AI — ChatGPT Prompt Engineering for Developers** — Andrew Ng & Isa Fulford · *Beginner* · free short course with hands-on notebooks. <https://www.deeplearning.ai/short-courses/chatgpt-prompt-engineering-for-developers/>

---

*AI Engineering Handbook — chapter 27.*
