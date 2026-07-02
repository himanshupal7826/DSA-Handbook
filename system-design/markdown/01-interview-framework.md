# 01 · The System Design Interview Framework

> **In one line:** A repeatable 7-step structure — requirements → estimates → API → data → design → scale → wrap — that turns a vague prompt into a defensible architecture.

---

## 1. Overview

A system design interview is not a test of whether you have memorized how Instagram is built. It is a test of **how you think under ambiguity**: can you take a two-sentence prompt ("design a URL shortener") and drive it to a concrete, scalable, defensible design in 45 minutes? The interviewer is your product manager, your rubber duck, and your adversary all at once.

The failure mode of most candidates is **jumping to boxes and arrows** before knowing what they are building. They draw a load balancer and three app servers in minute two, then spend forty minutes defending a design that answers a question nobody asked. The cure is a **framework**: a fixed sequence you run every time so you never freeze and never skip the steps that signal seniority.

The framework here is **7 steps**: (1) clarify requirements, (2) estimate capacity, (3) define the API, (4) design the data model, (5) draw the high-level design, (6) deep-dive and scale, (7) wrap up with failures and trade-offs. It is deliberately front-loaded — the first three steps are where junior and senior candidates diverge most.

A real interview is a **conversation, not a monologue**. The framework gives you the spine; your job is to narrate every decision ("I'll shard by user_id because our access pattern is user-centric"), surface trade-offs out loud, and let the interviewer redirect you. Seniority is demonstrated by *what you choose to spend time on*, not by how many components you can name.

## 2. Core Concepts

- **Functional requirements** — what the system *does*: the features and user actions ("users can post a tweet", "followers see it in their feed"). These define your API and data model.
- **Non-functional requirements (NFRs)** — the *qualities*: latency, throughput, availability, consistency, durability, cost. NFRs shape the architecture far more than features do. See **Latency, Throughput, Availability & SLAs**.
- **Scope negotiation** — you cannot design all of Twitter in 45 min. Explicitly cut scope: "I'll focus on tweet posting and timeline fan-out; I'll skip DMs, search, and ads." Naming what you *won't* do is a seniority signal.
- **Back-of-the-envelope estimation** — order-of-magnitude math for QPS, storage, and bandwidth that tells you whether one box or a thousand is needed. See **Back-of-the-Envelope Estimation**.
- **Driving the conversation** — you own the whiteboard. State assumptions, propose a path, then check in ("does that scope work for you?"). Don't wait to be led.
- **Bottleneck-first thinking** — after the high-level design, ask "where does this break at 10×?" and spend your deep-dive time there (the hot partition, the fan-out, the cache).
- **Trade-offs over answers** — there is no single correct design. Every choice (SQL vs NoSQL, sync vs async, strong vs eventual consistency) is a trade-off you name and justify.
- **Time-boxing** — a rough clock: 5 min requirements, 3 min estimates, 5 min API+data, 10 min high-level, 15 min deep-dive, 5 min wrap. Losing track of time is the most common self-inflicted failure.

## 3. Architecture

The framework is a pipeline: each step feeds the next. Requirements determine the estimates you need; estimates justify your storage and server choices; the API and data model constrain the high-level design; the design exposes bottlenecks you deep-dive. Skipping a step means the later steps rest on nothing.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">The 7-Step Framework</text>
  <g>
    <rect x="20"  y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="95"  y="66" text-anchor="middle" fill="#1e293b" font-weight="700">1. Requirements</text>
    <text x="95"  y="84" text-anchor="middle" fill="#64748b" font-size="11">functional + NFR</text>

    <rect x="200" y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="275" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">2. Estimates</text>
    <text x="275" y="84" text-anchor="middle" fill="#64748b" font-size="11">QPS, storage, BW</text>

    <rect x="380" y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="455" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">3. API</text>
    <text x="455" y="84" text-anchor="middle" fill="#64748b" font-size="11">endpoints/contract</text>

    <rect x="560" y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="635" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">4. Data Model</text>
    <text x="635" y="84" text-anchor="middle" fill="#64748b" font-size="11">entities + store</text>
  </g>
  <g>
    <rect x="140" y="150" width="150" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <text x="215" y="171" text-anchor="middle" fill="#1e293b" font-weight="700">5. High-Level</text>
    <text x="215" y="189" text-anchor="middle" fill="#64748b" font-size="11">boxes + arrows</text>

    <rect x="320" y="150" width="150" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <text x="395" y="171" text-anchor="middle" fill="#1e293b" font-weight="700">6. Deep-Dive</text>
    <text x="395" y="189" text-anchor="middle" fill="#64748b" font-size="11">scale bottlenecks</text>

    <rect x="500" y="150" width="150" height="52" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <text x="575" y="171" text-anchor="middle" fill="#1e293b" font-weight="700">7. Wrap-Up</text>
    <text x="575" y="189" text-anchor="middle" fill="#64748b" font-size="11">failures, trade-offs</text>
  </g>
  <line x1="170" y1="71" x2="196" y2="71" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="350" y1="71" x2="376" y2="71" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="530" y1="71" x2="556" y2="71" stroke="#475569" marker-end="url(#ah)"/>
  <path d="M635,97 L635,125 L215,125 L215,146" fill="none" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="290" y1="176" x2="316" y2="176" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="470" y1="176" x2="496" y2="176" stroke="#475569" marker-end="url(#ah)"/>
  <text x="380" y="245" text-anchor="middle" fill="#64748b" font-size="11">Each step feeds the next — skipping one leaves the rest resting on nothing.</text>
  <text x="380" y="272" text-anchor="middle" fill="#64748b" font-size="11">Clock: ~5 · 3 · 5 · 5 · 10 · 15 · 5 min</text>
</svg>
```

## 4. How It Works

1. **Clarify requirements (≈5 min).** Ask who the users are, the core actions, and the scale ("how many DAU?"). Separate **functional** ("post, follow, view feed") from **non-functional** ("feed loads < 200 ms p99, 99.9% available, read-heavy"). Write both on the board. Explicitly cut scope.
2. **Estimate capacity (≈3 min).** Convert DAU → QPS (avg and peak), then storage/year and bandwidth. State your assumptions ("100 M DAU, each posts twice/day"). The numbers justify every later decision — a 10 K QPS system and a 10 M QPS system are different architectures.
3. **Define the API (≈5 min).** Write the 3–5 core endpoints as method + path + params + response. `POST /tweets`, `GET /feed?cursor=`. The API is the contract; it forces you to nail down what the client actually needs.
4. **Design the data model.** List entities and their key fields, the relationships, and pick a datastore *with a reason* tied to your access pattern and NFRs (not "I like Postgres").
5. **Draw the high-level design (≈10 min).** Client → LB → services → data stores / cache / queue. Keep it to 6–8 boxes. Narrate the request path end to end for one core flow.
6. **Deep-dive and scale (≈15 min).** Ask "where does this break at 10×?" Attack the hardest part: fan-out on write vs read, hot partitions, cache strategy, sharding key. This is where staff-level candidates earn the offer.
7. **Wrap up (≈5 min).** Walk through failure modes ("what if a shard dies?"), name the big trade-offs, and state what you'd revisit with more time. Ending on trade-offs signals maturity.

## 5. Key Components / Deep Dive

### Functional vs Non-Functional Requirements

**Functional** answers *what*: the verbs. Every functional requirement maps to an API endpoint and usually to an entity. **Non-functional** answers *how well*: latency, throughput, availability, consistency, durability, cost, security. NFRs are where architecture is decided — "reads must be < 100 ms p99 and the system is 100:1 read-heavy" immediately tells you to add a cache and read replicas. Always extract at least: read/write ratio, latency target (as a percentile, not an average), availability target, and consistency needs. A candidate who asks "eventual consistency OK for the feed?" is signaling seniority in one sentence.

### Driving the Conversation (Showing Seniority)

The interviewer scores *signal*, not coverage. Generate signal by: **stating assumptions explicitly** ("assuming reads dominate 100:1"), **proposing before asking** ("I'll start with fan-out-on-write; push back if you'd rather explore read-time"), **naming trade-offs unprompted**, and **managing your own clock** ("I've spent enough on the API, let me move to the design"). Junior candidates wait to be told what to do; senior candidates lead and invite correction.

### Time-Boxing and Recovery

If you're 20 minutes in and still on requirements, you've failed the clock. Keep a rough budget (see the diagram) and glance at it. If you get stuck, say so and fall back to the framework: "Let me re-derive from the access pattern." Silence and flailing both read as panic; narrating your recovery reads as composure.

## 6. Trade-offs

| Approach | Pros | Cons |
|---|---|---|
| **Framework-driven** (this) | Never freeze; hits estimates & API that signal seniority; interviewer can follow | Feels rigid if applied mechanically without narration |
| **Dive straight to boxes** | Fast start, looks confident early | Designs the wrong system; no numbers to justify choices; junior signal |
| **Requirements-heavy, thin design** | Great scoping | Runs out of clock; never reaches the deep-dive where offers are won |
| **Deep-dive-first** (one hard part) | Shows depth fast | Skips context; interviewer can't tell if you understand the whole system |

The framework is a **default, not a straitjacket**. Once you internalize it, you can compress steps for a system you know cold and expand the deep-dive for the interesting part. The mistake is skipping requirements/estimates — those two steps are the cheapest, highest-signal minutes in the interview.

## 7. When to Use / When to Avoid

**Use the full framework when:**
- The prompt is open-ended ("design X") and you have 35–60 minutes.
- You're nervous or the domain is unfamiliar — the structure prevents freezing.
- The interviewer is quiet and expects you to drive.

**Compress or adapt when:**
- The interviewer explicitly zooms in ("just design the rate limiter") — skip to the relevant step.
- It's a 20-minute round — do quick requirements + estimates, then one focused design.
- The question is a pure deep-dive ("how does the cache invalidate?") — don't re-derive the whole system.

## 8. Scaling & Production Best Practices

- **Anchor every design decision to a number.** "500 K peak QPS won't fit one Postgres box, so I'll shard by user_id across ~20 nodes." Numbers turn opinions into engineering.
- **Design for peak, not average.** Traffic is bursty; use a peak factor of 2–5× the average for QPS sizing.
- **Start simple, then scale on demand.** Present the single-region, single-DB version first, then evolve it as the interviewer pushes scale. Premature sharding is a red flag.
- **Make the read path and write path explicit** — they scale independently and usually have different QPS and latency budgets.
- **Reserve ~15 minutes for the deep-dive.** That's where staff-level signal lives; protect it by moving fast through the setup.
- **State the datastore choice with its access pattern**, e.g. "KV lookups by short-code → DynamoDB/Redis, not a relational join."

## 9. Failure Modes & Mitigations

| Failure (in the interview) | Impact | Mitigation |
|---|---|---|
| Jump to design, skip requirements | Design the wrong system; no justification | Force 5 min of clarifying Qs before drawing |
| No capacity estimates | Can't justify sharding/caching; sizing is hand-wavy | Always convert DAU → QPS → storage/BW |
| Run out of time before deep-dive | Miss the highest-signal section | Time-box; glance at the clock every ~10 min |
| Monologue, ignore interviewer | Miss hints; feel adversarial | Check in every few minutes; treat hints as gold |
| Only happy path | Looks junior; no resilience thinking | Reserve wrap-up for failures + trade-offs |
| Over-engineer from minute one | Complexity with no driver | Start simple; add components when a number demands it |

## 10. Monitoring & Metrics

In a real system, the "requirements → NFR" step maps to what you'd actually instrument. The metrics you name in the interview should be the ones you'd watch in prod:

- **Latency percentiles** — p50/p95/p99/p999 per endpoint, never the average (averages hide tail pain).
- **Throughput** — requests/sec per service, split read vs write.
- **Availability / error rate** — successful responses ÷ total; track against the SLO.
- **Saturation** — CPU, memory, connection-pool, queue depth — the leading indicators of the next bottleneck.
- **Business KPIs** — the metric the product actually cares about (feed load time, checkout success), which is what the SLO should protect.

## 11. Common Mistakes

1. ⚠️ **Drawing boxes before asking questions** — the single most common failure; you design a system nobody asked for.
2. ⚠️ **Skipping capacity estimation** — with no numbers you can't justify sharding, caching, or a queue.
3. ⚠️ **Giving averages instead of percentiles** for latency — signals you don't understand tail latency.
4. ⚠️ **Not scoping** — trying to build all of Netflix; you run out of time on everything.
5. ⚠️ **Silent thinking** — the interviewer can only score what you say out loud.
6. ⚠️ **Ignoring the read/write ratio** — it determines caching and replication strategy.
7. ⚠️ **Over-engineering** — microservices and Kafka for a 10 QPS system reads as inexperience.
8. ⚠️ **No failure discussion** — happy-path-only designs are a junior tell.

## 12. Interview Questions

**Q: Walk me through your approach to any system design question.**
A: Requirements (functional + NFR, and scope cuts) → capacity estimates (QPS, storage, bandwidth) → API → data model → high-level design → deep-dive on the bottleneck → wrap-up with failures and trade-offs. Front-load requirements and estimates; reserve the back half for the deep-dive.

**Q: What's the difference between functional and non-functional requirements?**
A: Functional = what it does (post, follow, view feed) → drives the API and data model. Non-functional = qualities (latency, throughput, availability, consistency, durability, cost) → drives the architecture. NFRs decide more than features do.

**Q: How much time do you spend on requirements?**
A: About 5 minutes, plus a quick estimation pass. It's the cheapest, highest-leverage part — it prevents building the wrong system and gives numbers to justify every later choice.

**Q: The interviewer gives you a vague one-liner. What do you do?**
A: Ask clarifying questions to bound it: users, core actions, scale (DAU), and the key NFRs (read/write ratio, latency, availability, consistency). Then state assumptions and explicitly cut scope before designing.

**Q: How do you demonstrate seniority in a system design interview?**
A: By what you spend time on and how you reason: extract NFRs unprompted, justify choices with numbers, name trade-offs, drive the conversation, and discuss failure modes. Coverage of components matters less than the quality of your trade-off reasoning.

**Q (senior): You're 30 minutes in and still on the high-level design. How do you recover?**
A: Acknowledge the clock out loud, cut remaining scope, and jump to the single most interesting bottleneck for a focused deep-dive. A crisp deep-dive on one hard part beats a shallow tour of everything. Managing the recovery visibly is itself positive signal.

**Q (senior): How do you decide which part of the system to deep-dive?**
A: Find where it breaks at 10× — usually the highest-QPS path, the hottest partition, or the fan-out. That's where the interesting trade-offs (write vs read fan-out, consistency, hot keys) live and where staff-level signal is generated. I confirm the target with the interviewer before diving.

**Q (senior): The interviewer disagrees with your datastore choice mid-design. How do you respond?**
A: Treat it as a hint, not an attack. Restate the access pattern and NFR driving my choice, then genuinely weigh their alternative ("if we need multi-key transactions, you're right that relational wins; if it's pure KV lookups, the NoSQL choice holds"). Adapting on evidence signals seniority; defending dogmatically does not.

**Q (senior): How would you design for peak vs average load, and why does it matter in the interview?**
A: Size compute and rate limits for peak (typically 2–5× average), size storage for cumulative growth, and size caches for the working set. Averages under-provision bursty systems — quoting a peak factor shows I understand real traffic shapes.

**Q: What are the classic mistakes you avoid?**
A: Designing before scoping, no estimates, averages instead of percentiles, over-engineering small systems, monologuing, and skipping failure modes. Each is a well-known junior tell.

## 13. Alternatives & Related

- **Back-of-the-Envelope Estimation** — step 2 of this framework, in depth.
- **Latency, Throughput, Availability & SLAs** — the non-functional metrics you extract in step 1.
- **CAP & Consistency** — the consistency trade-offs you'll name during the deep-dive.
- **Load Balancing**, **Caching**, **Database Scaling** — the components you assemble in step 5.
- Case studies (**Design a URL Shortener**, **Design a News Feed**) — the framework applied end to end.

## 14. Cheat Sheet

> [!TIP]
> **7 steps:** Requirements → Estimates → API → Data → High-Level → Deep-Dive → Wrap-Up.
> **Clock:** ~5 · 3 · 5 · 5 · 10 · 15 · 5 min.
> **Requirements = functional (what) + NFR (how well: latency %ile, QPS, availability, consistency).**
> **Always estimate:** DAU → QPS (avg & peak, ×2–5) → storage/yr → bandwidth.
> **Deep-dive where it breaks at 10×** (hot partition, fan-out, cache).
> **Signal = numbers + trade-offs + failure modes + driving the convo.** Not component count.
> **Top sins:** design before scoping, no estimates, averages not percentiles, over-engineering, monologuing.

**References:** System Design Primer (donnemartin), Grokking the System Design Interview, Designing Data-Intensive Applications (ch.1), Google SRE Book

---
*System Design Handbook — topic 01.*
