# 01 · The System Design Interview Framework

> **In one line:** A repeatable structure: requirements → estimates → API → data → design → scale.

---

## 1. Overview

System design interviews are open-ended; a **structured approach** signals seniority. Drive the conversation: clarify requirements, estimate scale, define the API and data model, sketch a high-level design, then deep-dive and address bottlenecks with explicit trade-offs.

## 2. Key Concepts

- Clarify functional + non-functional requirements first.
- Estimate scale (QPS, storage, bandwidth) to justify choices.
- Define API contract and data model before components.
- Start simple, then scale and remove bottlenecks.
- Every decision is a trade-off — state them aloud.

## 3. Syntax & Code

```text
1. Requirements   (functional + non-functional, constraints)
2. Estimation    (QPS, storage, read:write ratio)
3. API           (endpoints / contracts)
4. Data model    (schema, access patterns)
5. High-level    (boxes: client, LB, services, DB, cache, queue)
6. Deep dive     (bottlenecks, scaling, failure modes)
7. Wrap up       (trade-offs, future work)
```

## 4. Worked Example

**Non-functional requirements**

Pin down scale, latency, availability, consistency, and durability — these drive the architecture more than features.

```text
Availability: 99.9%   Latency: p99 < 200ms
Consistency: eventual OK?   Read:Write = 100:1   DAU: 10M
```

## 5. Best Practices

- ✅ Spend real time clarifying before designing.
- ✅ Quantify scale with back-of-envelope math.
- ✅ State assumptions explicitly.
- ✅ Begin simple; scale only where numbers demand.
- ✅ Always articulate trade-offs and alternatives.

## 6. Common Pitfalls

1. ⚠️ Jumping to components before requirements.
2. ⚠️ Skipping capacity estimation.
3. ⚠️ Designing for hypothetical scale you didn't justify.
4. ⚠️ Silent decisions with no trade-off discussion.
5. ⚠️ Ignoring non-functional requirements.
6. ⚠️ Getting lost in one component and missing the big picture.

## 7. Interview Questions

1. **Q: How do you start a system design question?**
   A: Clarify functional and non-functional requirements and constraints before any design.

2. **Q: Why estimate scale?**
   A: Numbers (QPS, storage, read:write) justify architectural choices like caching, sharding, and replication.

3. **Q: What are non-functional requirements?**
   A: Availability, latency, consistency, durability, scalability — they shape the design most.

4. **Q: How to structure the whole answer?**
   A: Requirements → estimation → API → data → high-level → deep dive → trade-offs.

5. **Q: Why start simple?**
   A: Avoid over-engineering; add complexity only where the scale requires it.

6. **Q: How to show seniority?**
   A: Drive the conversation, quantify, and discuss trade-offs and failure modes.

7. **Q: What if requirements are ambiguous?**
   A: Ask targeted questions and state assumptions explicitly.

8. **Q: How to manage time?**
   A: Time-box: requirements/estimation early, then high-level, then one or two deep dives.

## 8. Practice

- [ ] Run the 7-step framework on 'design a URL shortener'.
- [ ] List non-functional requirements for a chat app.
- [ ] Do capacity estimation for 10M DAU.

## 9. Quick Revision

Framework: requirements → estimation → API → data model → high-level → deep dive → trade-offs. Quantify scale, start simple, state assumptions and trade-offs aloud.

**References:** System design primer

---

*System Design Handbook — topic 01.*
