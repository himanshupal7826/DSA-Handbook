# 07 · Exchange Types: Direct, Fanout, Topic & Headers

> **In one line:** RabbitMQ's routing power lives in four exchange types — *direct* matches a routing key exactly, *fanout* broadcasts to everything ignoring the key, *topic* matches dotted routing keys against wildcard patterns, and *headers* matches on message attributes instead of the key — and choosing the right one is the difference between a clean topology and a tangle of glue code.

---

## 1. Overview

Chapter 6 established the object model: a producer publishes to an exchange, and the exchange routes copies to queues via bindings. But it deferred the interesting question — *how does the exchange decide which bindings match?* The answer is the exchange's **type**, and there are four. Each defines a different matching rule between a message's routing key (and, for headers, its attributes) and a queue's binding, and each exists because a real routing problem is awkward or impossible with the others. Learning the four types is learning the four shapes of routing RabbitMQ gives you for free, in the broker, without a line of client-side dispatch code.

The **direct** exchange is the simplest: it delivers a message to the queues whose binding key *equals* the routing key, exactly. It is the tool for point-to-point and for routing by a discrete category — send `severity=error` logs to the error queue, `payment.refund` commands to the refund worker. The **fanout** exchange is the broadcaster: it ignores the routing key entirely and delivers a copy to *every* bound queue. It is pub/sub in one object — publish an event once, and every subscriber's queue gets it, no matter what. The **topic** exchange is the pattern matcher: routing keys are dot-separated words (`logs.eu.error`, `payment.us.refund`), and binding keys are patterns with two wildcards — `*` matches exactly one word and `#` matches zero or more words — so `logs.*.error` catches error logs from any single region and `#.critical` catches anything ending in `critical`. The **headers** exchange ignores the routing key and matches instead on the message's *header attributes*, using `x-match` set to `all` (every specified header must match) or `any` (at least one), which is the tool when routing depends on multiple independent dimensions that do not compose neatly into one dotted string.

The art is choosing correctly. A great deal of accidental complexity in RabbitMQ systems comes from using the wrong exchange type and papering over it — a fanout with client-side filtering that should have been a topic, a direct exchange with a combinatorial explosion of routing keys that should have been headers, a topic pattern contorted to express what a headers `x-match=any` states plainly. This chapter defines each type's matching rule precisely, gives worked routing examples you can trace by hand, states when to reach for each, covers the exchange-to-exchange binding that lets exchanges chain, and provides `amqp091-go` code for all four. Get the type right and the topology reads like a specification; get it wrong and it reads like a workaround.

## 2. Core Concepts

- **Exchange type** — the rule an exchange uses to match a published message against its bindings: `direct`, `fanout`, `topic`, or `headers`. Set at `exchange.declare` and immutable thereafter.
- **Direct exchange** — delivers to queues whose binding key *exactly equals* the message's routing key. Exact-match routing.
- **Fanout exchange** — delivers a copy to *every* bound queue, ignoring the routing key entirely. Broadcast / pub-sub.
- **Topic exchange** — delivers to queues whose binding-key *pattern* matches the dotted routing key, using wildcards `*` (exactly one word) and `#` (zero or more words).
- **Headers exchange** — ignores the routing key; matches on the message's header attributes against binding arguments, governed by `x-match` (`all` or `any`).
- **Word** — in a topic routing key, a run of characters between dots; `logs.eu.error` has three words. Wildcards operate on whole words.
- **`*` (star)** — topic wildcard matching *exactly one* word.
- **`#` (hash)** — topic wildcard matching *zero or more* words; the only wildcard that can match an empty segment or several segments.
- **`x-match`** — a headers-exchange binding argument: `all` requires every specified header to match (AND), `any` requires at least one (OR).
- **Exchange-to-exchange binding** — a RabbitMQ extension (`exchange.bind`) letting a *source* exchange route to a *destination* exchange, so exchanges chain and compose.
- **Internal exchange** — an exchange declared `internal=true` that clients cannot publish to directly; it only receives from other exchanges via exchange-to-exchange bindings.

## 3. Theory & Principles

### The four matching rules, precisely

Every exchange type answers the same question — "given this message, which bound queues get a copy?" — with a different rule. Stating the rules exactly is the whole of the theory.

- **Direct:** deliver to every queue whose binding key is *string-equal* to the message's routing key. Multiple queues may share a binding key (all get a copy); one queue may be bound with several keys. The default exchange (chapter 6) is a direct exchange behind the scenes.
- **Fanout:** deliver to *every* bound queue. The routing key is not examined. This is the cheapest exchange to reason about and, because it does no matching, often the fastest.
- **Topic:** treat the routing key as a list of dot-separated words and each binding key as a pattern over words. `*` matches exactly one word; `#` matches zero or more words. Deliver to every queue whose pattern matches. A binding key of `#` matches everything (a fanout in topic clothing); a binding key with no wildcards behaves like a direct binding.
- **Headers:** ignore the routing key. Look at the message's `headers` table and the binding's argument table. If the binding's `x-match` is `all`, deliver iff *every* header named in the binding (other than `x-match`) is present with the specified value. If `x-match` is `any`, deliver iff *at least one* matches. Header values can be matched on presence or exact value.

The consequence worth internalising is that **direct, fanout and a `#`-only topic form a spectrum of specificity**: fanout is "everything", direct is "exactly this token", and topic spans the middle with patterns. Headers sits apart because it routes on a *different input* — attributes rather than a single key — which is exactly why it exists: some routing decisions depend on several independent booleans (`format=pdf`, `region=eu`, `priority=high`) that do not linearise into one meaningful dotted string.

### Why topic is usually the right default for events

For event-driven systems, the topic exchange is the workhorse, and it is worth understanding why. Events naturally have a *hierarchical* identity: a thing, a qualifier, an action — `order.eu.created`, `user.us.deleted`, `payment.uk.refunded`. That hierarchy maps directly onto dotted routing keys, and the two wildcards then let each consumer subscribe at exactly the granularity it cares about. A regional fulfilment service binds `order.eu.*` — all EU order events. An audit sink binds `#` — everything. A refund processor binds `payment.*.refunded` — refunds from any region. Each consumer expresses its interest declaratively as a pattern, and adding a consumer with a new interest is a new binding, not a producer change. This is the exchange type that most cleanly delivers the location-and-identity decoupling a message system exists for, which is why "publish events to a topic exchange with a well-designed dotted key scheme" is the default advice.

The design work is in the **key scheme**: the order of the words matters because `*` and `#` operate positionally. Put the most-selective, most-commonly-filtered dimension where consumers will most often pin it, and put dimensions consumers usually wildcard toward the variable end. A scheme like `<entity>.<region>.<action>` lets you filter by entity (`order.#`), by region (`*.eu.#`), or by action (`*.*.created`) — but only because you chose that order deliberately. A badly ordered scheme forces contorted patterns or a fallback to headers.

### Headers exchange: when the key is the wrong shape

The headers exchange trades the routing key for the message's attribute table, and it earns its place precisely when routing depends on *multiple independent dimensions*. Suppose a document must be routed by `format` (pdf/png), `region` (eu/us) and `priority` (high/low), and a consumer wants "any high-priority EU document, in any format". As a topic key you would need `*.eu.high` and a key scheme that fixed format in the first position — and a second consumer wanting "any pdf, any region" would need the format elsewhere, contradicting the first. The dimensions do not have a single natural order, so no dotted scheme serves all consumers. Headers solves this: the producer sets `format`, `region`, `priority` as headers, and each binding names just the dimensions it cares about with `x-match=all` (AND) or `x-match=any` (OR). The cost is that headers matching is a little slower (it hashes an argument table rather than comparing a short string) and, in practice, less used and less familiar to teams — so the guidance is to prefer topic when the routing dimensions compose into a sensible hierarchy, and reach for headers only when they genuinely do not.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="e1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="e2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="e3" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="e4" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Four exchange types, four matching rules</text>

  <rect x="20" y="36" width="205" height="210" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="122" y="56" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">DIRECT</text>
  <text x="122" y="72" text-anchor="middle" fill="#1d4ed8" font-size="9">binding key == routing key</text>
  <rect x="34" y="84" width="70" height="22" rx="4" fill="#fff" stroke="#60a5fa"/><text x="69" y="99" text-anchor="middle" fill="#1e40af" font-size="8">rk=error</text>
  <rect x="150" y="82" width="62" height="20" rx="3" fill="#bfdbfe" stroke="#2563eb"/><text x="181" y="96" text-anchor="middle" fill="#1e40af" font-size="8">bk=error &#10003;</text>
  <rect x="150" y="108" width="62" height="20" rx="3" fill="#f1f5f9" stroke="#94a3b8"/><text x="181" y="122" text-anchor="middle" fill="#64748b" font-size="8">bk=info &#10007;</text>
  <path d="M104,95 L146,93" stroke="#2563eb" stroke-width="1.5" marker-end="url(#e1)"/>
  <text x="34" y="158" fill="#1d4ed8" font-size="9">exact category routing</text>
  <text x="34" y="176" fill="#1d4ed8" font-size="9">e.g. severity, command type</text>
  <text x="34" y="200" fill="#1e40af" font-size="9" font-weight="bold">use: point-to-point,</text>
  <text x="34" y="216" fill="#1e40af" font-size="9" font-weight="bold">discrete categories</text>
  <text x="34" y="236" fill="#1d4ed8" font-size="8">default exchange is direct</text>

  <rect x="235" y="36" width="205" height="210" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="337" y="56" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">FANOUT</text>
  <text x="337" y="72" text-anchor="middle" fill="#15803d" font-size="9">ignores routing key</text>
  <rect x="249" y="84" width="60" height="22" rx="4" fill="#fff" stroke="#86efac"/><text x="279" y="99" text-anchor="middle" fill="#15803d" font-size="8">any rk</text>
  <rect x="360" y="80" width="66" height="18" rx="3" fill="#bbf7d0" stroke="#16a34a"/><text x="393" y="93" text-anchor="middle" fill="#15803d" font-size="8">queue A &#10003;</text>
  <rect x="360" y="102" width="66" height="18" rx="3" fill="#bbf7d0" stroke="#16a34a"/><text x="393" y="115" text-anchor="middle" fill="#15803d" font-size="8">queue B &#10003;</text>
  <rect x="360" y="124" width="66" height="18" rx="3" fill="#bbf7d0" stroke="#16a34a"/><text x="393" y="137" text-anchor="middle" fill="#15803d" font-size="8">queue C &#10003;</text>
  <path d="M309,95 L356,89" stroke="#16a34a" stroke-width="1.5" marker-end="url(#e2)"/>
  <path d="M309,97 L356,111" stroke="#16a34a" stroke-width="1.5" marker-end="url(#e2)"/>
  <path d="M309,99 L356,133" stroke="#16a34a" stroke-width="1.5" marker-end="url(#e2)"/>
  <text x="249" y="170" fill="#166534" font-size="9">every bound queue gets a copy</text>
  <text x="249" y="188" fill="#166534" font-size="9">pub/sub in one object</text>
  <text x="249" y="212" fill="#15803d" font-size="9" font-weight="bold">use: broadcast events,</text>
  <text x="249" y="228" fill="#15803d" font-size="9" font-weight="bold">cache invalidation</text>

  <rect x="450" y="36" width="205" height="210" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="552" y="56" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">TOPIC</text>
  <text x="552" y="72" text-anchor="middle" fill="#6d28d9" font-size="9">dotted key vs wildcard pattern</text>
  <rect x="464" y="84" width="96" height="22" rx="4" fill="#fff" stroke="#c4b5fd"/><text x="512" y="99" text-anchor="middle" fill="#5b21b6" font-size="8">rk=logs.eu.error</text>
  <rect x="574" y="80" width="72" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="610" y="93" text-anchor="middle" fill="#5b21b6" font-size="8">logs.*.error &#10003;</text>
  <rect x="574" y="102" width="72" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="610" y="115" text-anchor="middle" fill="#5b21b6" font-size="8">logs.# &#10003;</text>
  <rect x="574" y="124" width="72" height="18" rx="3" fill="#f1f5f9" stroke="#94a3b8"/><text x="610" y="137" text-anchor="middle" fill="#64748b" font-size="8">*.us.# &#10007;</text>
  <path d="M560,95 L570,90" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#e3)"/>
  <text x="464" y="168" fill="#6d28d9" font-size="9"><tspan font-weight="bold">*</tspan> = exactly one word</text>
  <text x="464" y="186" fill="#6d28d9" font-size="9"><tspan font-weight="bold">#</tspan> = zero or more words</text>
  <text x="464" y="210" fill="#5b21b6" font-size="9" font-weight="bold">use: hierarchical events,</text>
  <text x="464" y="226" fill="#5b21b6" font-size="9" font-weight="bold">the workhorse default</text>

  <rect x="665" y="36" width="195" height="210" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="762" y="56" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">HEADERS</text>
  <text x="762" y="72" text-anchor="middle" fill="#b45309" font-size="9">matches header attributes</text>
  <rect x="679" y="82" width="120" height="34" rx="4" fill="#fff" stroke="#fbbf24"/>
  <text x="739" y="96" text-anchor="middle" fill="#92400e" font-size="8">format=pdf, region=eu</text>
  <text x="739" y="110" text-anchor="middle" fill="#92400e" font-size="8">(routing key ignored)</text>
  <text x="679" y="140" fill="#b45309" font-size="9">x-match=all &#8594; AND</text>
  <text x="679" y="158" fill="#b45309" font-size="9">x-match=any &#8594; OR</text>
  <text x="679" y="182" fill="#92400e" font-size="9" font-weight="bold">use: multi-dimension</text>
  <text x="679" y="198" fill="#92400e" font-size="9" font-weight="bold">routing that doesn't</text>
  <text x="679" y="214" fill="#92400e" font-size="9" font-weight="bold">linearise into one key</text>

  <rect x="20" y="258" width="840" height="228" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="280" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Topic wildcards worked out &#8212; routing key logs.eu.error against binding keys</text>
  <g font-size="10">
    <text x="44" y="308" fill="#15803d" font-weight="bold">logs.eu.error</text><text x="220" y="308" fill="#166534">&#10003; exact match (no wildcard)</text>
    <text x="44" y="330" fill="#15803d" font-weight="bold">logs.*.error</text><text x="220" y="330" fill="#166534">&#10003; * matches the one word &#8220;eu&#8221;</text>
    <text x="44" y="352" fill="#15803d" font-weight="bold">logs.#</text><text x="220" y="352" fill="#166534">&#10003; # matches &#8220;eu.error&#8221; (two words)</text>
    <text x="44" y="374" fill="#15803d" font-weight="bold">#</text><text x="220" y="374" fill="#166534">&#10003; # matches all three words &#8212; catches EVERYTHING</text>
    <text x="44" y="396" fill="#15803d" font-weight="bold">logs.#.error</text><text x="220" y="396" fill="#166534">&#10003; # matches zero-or-more between logs and error</text>
    <text x="44" y="418" fill="#b91c1c" font-weight="bold">logs.*</text><text x="220" y="418" fill="#991b1b">&#10007; * is ONE word; logs.eu.error has TWO after logs</text>
    <text x="44" y="440" fill="#b91c1c" font-weight="bold">*.error</text><text x="220" y="440" fill="#991b1b">&#10007; * is one word, so pattern is 2 words; key is 3</text>
    <text x="44" y="462" fill="#b91c1c" font-weight="bold">logs.eu.error.detail</text><text x="220" y="462" fill="#991b1b">&#10007; 4 words vs the key&#8217;s 3 &#8212; no match</text>
  </g>
</svg>
```

## 4. Architecture & Workflow

Choosing an exchange type is a design decision made per data flow, and it follows a short decision path:

1. **Do all bound queues need every message?** If yes, use **fanout**. It is the simplest and cheapest broadcast; do not fake it with a topic bound to `#` unless you specifically want to *also* allow selective bindings on the same exchange later.
2. **Is routing a single discrete category with exact values?** If the decision is "route by this one token, exactly" — severity level, command name, tenant id — use **direct**. It is the fastest exact match and the clearest to read.
3. **Is the routing identity hierarchical, with consumers wanting different granularities?** If keys look like `entity.qualifier.action` and consumers want to filter at varying levels, use **topic**. This is the default for event streams; design the dotted key scheme deliberately.
4. **Does routing depend on several independent attributes that do not linearise into one key?** If consumers want AND/OR combinations across orthogonal dimensions (`format`, `region`, `priority`), use **headers** with `x-match=all`/`any`.
5. **Do you need to chain or aggregate routing?** Bind exchanges to exchanges (`exchange.bind`) so, for example, several per-service topic exchanges feed one central audit fanout, or an internal exchange aggregates before a final routing stage.

The **exchange-to-exchange binding** deserves its own note because it is under-used. A binding's *destination* can be another exchange rather than a queue, so a *source* exchange routes matching messages into a *destination* exchange, which then applies its own type and bindings. This lets you compose routing in stages: a topic exchange per bounded context, all bound into a central fanout that copies everything to an audit stream; or a public exchange that forwards a filtered subset into an `internal=true` exchange that clients cannot publish to directly, enforcing that only routed (not directly published) messages reach a sensitive queue. Chaining keeps each exchange's rule simple while expressing routing that a single exchange could not.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="f1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Exchange-to-exchange binding: composing routing in stages</text>

  <rect x="30" y="70" width="120" height="50" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="90" y="90" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">orders svc</text>
  <text x="90" y="107" text-anchor="middle" fill="#6d28d9" font-size="8">publishes events</text>
  <rect x="30" y="200" width="120" height="50" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="90" y="220" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">payments svc</text>
  <text x="90" y="237" text-anchor="middle" fill="#6d28d9" font-size="8">publishes events</text>

  <path d="M152,95 L214,110" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>
  <path d="M152,225 L214,175" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>

  <rect x="216" y="90" width="130" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="281" y="110" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">orders (topic)</text>
  <text x="281" y="126" text-anchor="middle" fill="#1d4ed8" font-size="8">order.*.*</text>
  <rect x="216" y="150" width="130" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="281" y="170" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">payments (topic)</text>
  <text x="281" y="186" text-anchor="middle" fill="#1d4ed8" font-size="8">payment.*.*</text>

  <path d="M348,113 L430,140" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>
  <text x="390" y="118" text-anchor="middle" fill="#4f46e5" font-size="8">ex-to-ex bind</text>
  <path d="M348,173 L430,152" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>

  <rect x="432" y="122" width="140" height="52" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="502" y="143" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">audit-all</text>
  <text x="502" y="159" text-anchor="middle" fill="#166534" font-size="8">fanout (internal)</text>

  <path d="M572,135 L648,110" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>
  <path d="M572,148 L648,190" stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)"/>
  <rect x="650" y="86" width="200" height="44" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="750" y="106" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">queue: audit-store</text>
  <text x="750" y="122" text-anchor="middle" fill="#b45309" font-size="8">every event, forever</text>
  <rect x="650" y="170" width="200" height="44" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="750" y="190" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">queue: analytics</text>
  <text x="750" y="206" text-anchor="middle" fill="#b45309" font-size="8">every event, streamed</text>

  <rect x="30" y="286" width="820" height="98" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="308" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why chain exchanges?</text>
  <text x="50" y="332" fill="#475569" font-size="10">Each per-service TOPIC exchange keeps its own clean key scheme; consumers of that context bind selectively as usual.</text>
  <text x="50" y="352" fill="#475569" font-size="10">Binding both into one FANOUT aggregates EVERY event into audit/analytics without the producers knowing those sinks exist.</text>
  <text x="50" y="372" fill="#334155" font-size="10" font-weight="bold">Marking the fanout internal=true means clients cannot publish to it directly &#8212; only routed messages reach the audit queues.</text>
</svg>
```

## 5. Implementation

Here is `amqp091-go` code declaring and binding all four exchange types, with worked routing so you can see exactly what each delivers. The exchange type is the second argument to `ExchangeDeclare`.

```go
package main

import (
	"context"
	"log"

	amqp "github.com/rabbitmq/amqp091-go"
)

func setupExchanges(ch *amqp.Channel) error {
	// --- DIRECT: exact routing-key == binding-key match -----------------------
	// Route log messages by severity to per-severity queues.
	if err := ch.ExchangeDeclare("logs.direct", "direct", true, false, false, false, nil); err != nil {
		return err
	}
	// queue "errors" wants exactly severity "error"; "all" wants "error" AND "info".
	mustQ(ch, "logs.errors")
	mustQ(ch, "logs.all")
	// A queue may be bound with MULTIPLE keys — each is a separate binding.
	must(ch.QueueBind("logs.errors", "error", "logs.direct", false, nil))
	must(ch.QueueBind("logs.all", "error", "logs.direct", false, nil))
	must(ch.QueueBind("logs.all", "info", "logs.direct", false, nil))
	// publish rk="error"  -> logs.errors AND logs.all
	// publish rk="info"   -> logs.all only
	// publish rk="debug"  -> NOTHING is bound -> dropped

	// --- FANOUT: every bound queue gets a copy, routing key ignored ------------
	// Broadcast a cache-invalidation event to every service's private queue.
	if err := ch.ExchangeDeclare("cache.invalidate", "fanout", true, false, false, false, nil); err != nil {
		return err
	}
	mustQ(ch, "cache.svc-a")
	mustQ(ch, "cache.svc-b")
	// Binding key is IGNORED for fanout — pass "" by convention.
	must(ch.QueueBind("cache.svc-a", "", "cache.invalidate", false, nil))
	must(ch.QueueBind("cache.svc-b", "", "cache.invalidate", false, nil))
	// publish with ANY routing key -> BOTH cache.svc-a and cache.svc-b

	// --- TOPIC: dotted routing key vs wildcard pattern ------------------------
	// Event scheme: <entity>.<region>.<action>, e.g. order.eu.created
	if err := ch.ExchangeDeclare("events", "topic", true, false, false, false, nil); err != nil {
		return err
	}
	mustQ(ch, "eu.orders")   // all EU order events, any action
	mustQ(ch, "all.created") // creations of anything, any entity/region
	mustQ(ch, "audit")       // literally everything
	// "*" = exactly one word; "#" = zero or more words.
	must(ch.QueueBind("eu.orders", "order.eu.*", "events", false, nil))
	must(ch.QueueBind("all.created", "*.*.created", "events", false, nil))
	must(ch.QueueBind("audit", "#", "events", false, nil))
	// publish rk="order.eu.created" -> eu.orders, all.created, audit
	// publish rk="order.us.created" -> all.created, audit
	// publish rk="payment.eu.refunded" -> audit only

	// --- HEADERS: match on message header attributes, key ignored -------------
	// Route documents by orthogonal dimensions that don't linearise into a key.
	if err := ch.ExchangeDeclare("documents", "headers", true, false, false, false, nil); err != nil {
		return err
	}
	mustQ(ch, "eu.pdf.high")
	mustQ(ch, "any.png.or.eu")
	// x-match=all -> ALL listed headers must match (AND).
	must(ch.QueueBind("eu.pdf.high", "", "documents", false, amqp.Table{
		"x-match":  "all",
		"format":   "pdf",
		"region":   "eu",
		"priority": "high",
	}))
	// x-match=any -> at least ONE listed header must match (OR).
	must(ch.QueueBind("any.png.or.eu", "", "documents", false, amqp.Table{
		"x-match": "any",
		"format":  "png",
		"region":  "eu",
	}))
	return nil
}

// publishExamples shows what a header-routed publish looks like: the routing key
// is empty because a headers exchange never looks at it.
func publishHeaders(ch *amqp.Channel) error {
	return ch.PublishWithContext(context.Background(), "documents", "", false, false,
		amqp.Publishing{
			ContentType: "application/pdf",
			Headers: amqp.Table{ // these drive routing, NOT the routing key
				"format":   "pdf",
				"region":   "eu",
				"priority": "high",
			},
			Body: []byte("...pdf bytes..."),
		})
	// Matches eu.pdf.high (all three match) AND any.png.or.eu (region=eu matches
	// the OR), so BOTH queues receive a copy.
}

// bindExchangeToExchange composes routing: the per-context "events" topic
// exchange forwards EVERYTHING into a central "audit-all" fanout, which then
// fans out to audit/analytics queues — without the producers knowing.
func bindExchangeToExchange(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare("audit-all", "fanout", true, false,
		true /* internal: clients cannot publish here directly */, false, nil); err != nil {
		return err
	}
	// exchange.bind(destination, key, source): route "#" from events -> audit-all.
	return ch.ExchangeBind("audit-all", "#", "events", false, nil)
}

func mustQ(ch *amqp.Channel, name string) {
	if _, err := ch.QueueDeclare(name, true, false, false, false, nil); err != nil {
		log.Fatalf("declare queue %s: %v", name, err)
	}
}
func must(err error) {
	if err != nil {
		log.Fatalf("%v", err)
	}
}
```

The code makes the four rules concrete: direct compares the routing key for equality, fanout ignores it, topic pattern-matches the dotted key, and headers ignores the key and reads the `Headers` table with `x-match`. Trace the commented `publish rk=...` lines by hand against the bindings — that manual tracing is exactly what you will do when a message routes somewhere unexpected in production.

One subtlety in the headers example repays attention because it is the commonest headers bug. Header *values are typed*: a header set by the producer as the string `"eu"` matches a binding argument of the string `"eu"`, but a header sent as an integer `1` will *not* match a binding argument of the string `"1"`, even though they look alike, because the AMQP field-table comparison is type-sensitive. The same trap catches booleans sent as `true` versus the string `"true"`. When a headers exchange mysteriously routes nothing, the first thing to check is that the producer and the binding agree on both the value *and its type* — the management UI shows the field types, which makes the mismatch obvious once you look. This is part of why headers exchanges, while powerful, carry more operational friction than the string-only matching of direct and topic.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Broker-side routing with no client dispatch code.** All four types push the routing decision into the broker, so consumers stay simple loops and the routing logic is a declarative topology.
- **A type for every shape of routing.** Exact (direct), broadcast (fanout), hierarchical pattern (topic), multi-attribute (headers) — the four cover essentially every routing need without custom code.
- **Topic keys map cleanly onto event hierarchies,** giving consumers per-granularity subscriptions and producers a stable key scheme.
- **Fanout is trivially cheap and clear** for genuine broadcast, and does no matching work.
- **Exchange-to-exchange bindings compose routing in stages,** letting each exchange stay simple while expressing routing one exchange could not.

**Disadvantages**
- **Wrong-type choices ossify.** An exchange's type is fixed at declaration; changing it means deleting and recreating the exchange and re-binding everything.
- **Topic key schemes are hard to change later.** Once producers emit `entity.region.action` and dozens of consumers bind patterns, reordering the words is a breaking change across the whole system.
- **Headers matching is slower and less familiar,** so teams sometimes contort a topic key to avoid it, or misuse it where a topic would be clearer.
- **Silent drops persist across all types** — a routing key or header set matching no binding is discarded unless `mandatory`/alternate-exchange is used (chapter 10).

**Trade-offs**
- *Fanout simplicity vs topic flexibility:* fanout is the clearest broadcast but offers no selectivity; a topic bound to `#` gives the same broadcast plus the option to add selective bindings later, at the cost of a slightly less obvious intent.
- *Topic vs headers for multi-dimensional routing:* topic is faster and more familiar and works when dimensions form a natural hierarchy; headers is the honest choice when they do not, at the cost of speed and familiarity. Prefer topic until the key scheme starts fighting you.
- *One rich exchange vs chained exchanges:* a single exchange keeps the topology flat but can force awkward keys; chaining exchanges keeps each rule simple and enables aggregation/internal-only stages, at the cost of more objects to operate and reason about.

## 7. Common Mistakes & Best Practices

- **Using `*` where `#` is needed (or vice versa).** `*` matches *exactly one* word; `#` matches *zero or more*. `logs.*` does not match `logs.eu.error` (three words), and `logs.#` does. Getting this wrong silently drops or over-delivers messages.
- **Faking pub/sub with a direct exchange and one shared key.** It works, but a fanout states the intent ("everyone gets this") and cannot be accidentally broken by a mismatched key. Use fanout for genuine broadcast.
- **Designing the topic key scheme carelessly.** The word order determines which filters are expressible with clean patterns. Put the dimension consumers most often pin first, and think before producers start emitting — it is painful to change later.
- **Reaching for headers when a topic would do.** Headers is slower and less familiar; use it only when routing genuinely depends on independent attributes that do not linearise into a dotted key.
- **Forgetting fanout ignores the routing key.** Setting a "meaningful" routing key on a fanout publish and expecting it to filter — it does not; every bound queue gets a copy regardless.
- **Expecting to change an exchange's type in place.** The type is immutable; you must delete and recreate the exchange and re-establish all bindings. Plan the type up front.
- **Best practice: default to a topic exchange with a deliberate `entity.qualifier.action` key scheme for events, direct for discrete exact categories, fanout for true broadcast, and headers only when the routing dimensions refuse to linearise — and always design the key scheme before producers depend on it.**

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When a message routes to the wrong place (or nowhere), reconstruct the decision by hand: `rabbitmqctl list_bindings <vhost>` shows every source/destination/binding-key, and you compare the message's routing key (or headers) against each in the exchange's type language. The management UI's "Publish message" tester lets you send a probe with a chosen key/headers and see which queues it lands in. For topic exchanges especially, a single-word miscount (`*` vs `#`) is the usual culprit; for headers, a value-type mismatch (a header sent as an int but bound as a string) silently fails to match.
- **Monitoring.** Track per-exchange publish-in and (where meaningful) the fan-out ratio — messages routed vs messages published — since a ratio of zero on an exchange with active publishers means bindings are wrong. Watch each destination queue's ingress rate to confirm the intended queues, and only those, are receiving. Alert on returned/unroutable message rate to catch silent drops from key or header mismatches (chapter 27).
- **Security.** Publishing to an exchange requires *write* permission on it; binding a queue requires *write* on the exchange and *configure*/*read* as appropriate on the queue. Marking an exchange `internal=true` is a security tool: clients cannot publish to it directly, so a sensitive queue fed only by an internal exchange receives exactly the routed subset and nothing a client could inject by publishing directly. Combine internal exchanges with tight per-exchange write permissions to control who can originate messages into a flow (chapter 29).
- **Scaling.** Fanout and direct do the least matching work and scale best; topic matches with a trie over words and is efficient but does more per message; headers hashes an argument table and is the heaviest. For very high fan-out (thousands of bound queues), a fanout exchange's cost is in the number of enqueues, not the matching, so the queues and their consumers are the scaling concern, not the exchange. For very high-cardinality topic routing, consider whether a consistent-hash exchange (to shard load across queues) fits better than an ever-growing set of bindings (chapter 22).

## 9. Interview Questions

**Q: What are the four exchange types and their matching rules?**
A: Direct delivers to queues whose binding key exactly equals the message's routing key — exact-match routing. Fanout delivers a copy to every bound queue and ignores the routing key entirely — broadcast. Topic treats the routing key as dot-separated words and each binding key as a pattern with `*` (matching exactly one word) and `#` (matching zero or more words), delivering to queues whose pattern matches — hierarchical, selective routing. Headers ignores the routing key and matches on the message's header attributes against the binding's arguments, governed by `x-match` set to `all` (every listed header must match) or `any` (at least one). Direct, fanout and a `#`-topic form a specificity spectrum; headers sits apart because it routes on attributes rather than a single key.

**Q: In a topic exchange, what is the difference between `*` and `#`?**
A: Both are wildcards over the dot-separated words of a routing key. `*` matches *exactly one* word — so `logs.*.error` matches `logs.eu.error` but not `logs.error` (missing a word) or `logs.eu.db.error` (too many). `#` matches *zero or more* words — so `logs.#` matches `logs`, `logs.error`, and `logs.eu.db.error` alike, and a binding key of just `#` matches every routing key, effectively a fanout. The single most common bug is using `*` where the key has a variable number of trailing words; `#` is the one to reach for when the tail length varies.

**Q: When would you choose a headers exchange over a topic exchange?**
A: When routing depends on several independent attributes that do not compose into one meaningful dotted key. A topic key imposes an order on its words, so it serves consumers whose filters agree with that order; if one consumer wants "any high-priority EU document" and another wants "any pdf, any region", no single word order satisfies both. A headers exchange lets the producer set `format`, `region`, `priority` as independent headers and each binding name only the dimensions it cares about, with `x-match=all` for AND or `x-match=any` for OR. The cost is that headers matching is slower and less familiar, so I use topic whenever the dimensions form a natural hierarchy and reserve headers for the genuinely multi-dimensional case.

**Q: What does a fanout exchange do with the routing key?**
A: Nothing — it ignores it completely. A fanout delivers a copy of every published message to every queue bound to it, regardless of the routing key on the message or the binding. This is why a fanout is the clean expression of broadcast/pub-sub: publish once, and every subscriber's queue receives it. A common mistake is setting a "meaningful" routing key on a fanout publish expecting it to filter; it will not. If you need selectivity you want a direct or topic exchange, not a fanout.

**Q: How is the default exchange related to the four types?**
A: The default (nameless) exchange is a direct exchange that RabbitMQ pre-declares in every virtual host, to which every queue is automatically bound by its own name. So `publish(exchange="", routingKey="myqueue")` is a direct-exchange exact match against the auto-binding whose key is `myqueue`, landing the message in that queue. It is not a fifth type; it is a conventional direct exchange with special auto-binding behaviour, which is what makes "publishing to a queue by name" work while still going through an exchange.

**Q: What is an exchange-to-exchange binding and why use it?**
A: A binding's destination can be another exchange rather than a queue, so a source exchange routes matching messages into a destination exchange, which then applies its own type and bindings. You use it to compose routing in stages: for example, several per-service topic exchanges each keep a clean key scheme, and all of them are bound into one central fanout that aggregates every event into audit and analytics queues, without the producing services knowing those sinks exist. Combined with an `internal=true` destination exchange (which clients cannot publish to directly), it also lets you guarantee a sensitive queue receives only routed messages, not anything a client injects by publishing.

**Q: Can you change an exchange's type after it is created?**
A: No. The type is fixed at `exchange.declare` and is part of the exchange's identity — re-declaring the same name with a different type fails the equivalence check. To change it you delete the exchange and recreate it with the new type, then re-establish every binding, which is disruptive because in-flight publishes during the gap have nowhere to route. This immutability is why the type (and, for topic, the key scheme) is a decision to get right before producers and consumers depend on it.

**Q: (Senior) How would you design the routing topology for a multi-region, multi-service event platform?**
A: I would lead with topic exchanges and a deliberately designed dotted key scheme, because events are hierarchical and consumers want different granularities. A scheme like `<domain>.<entity>.<region>.<action>` — for instance `commerce.order.eu.created` — lets a regional service bind `commerce.order.eu.#`, a global creation-indexer bind `*.*.*.created`, and an audit sink bind `#`. I would choose the word order by which dimensions consumers most often pin versus wildcard: the domain and entity are usually pinned, region and action vary, so they go where wildcards are cheap. I would keep one topic exchange per bounded context rather than one giant exchange, so each team owns its key scheme and namespace, and then use exchange-to-exchange bindings to feed a central `internal=true` fanout for cross-cutting sinks (audit, analytics, a data lake) that must see everything without the producers coupling to them. Where routing genuinely depends on orthogonal attributes that fight the key order — say a compliance router keyed on `pii=true` AND `region=eu` regardless of entity — I would add a headers exchange for just that flow rather than distort the whole key scheme. I would treat the key scheme as a versioned contract, document it, and resist changing word order after producers adopt it, because that is a breaking change across every binding. Finally I would set `mandatory` (or an alternate exchange) on producers so an unroutable event surfaces loudly rather than vanishing, since with rich routing the failure mode is a silent drop from a mis-typed key.

**Q: (Senior) A topic exchange is delivering a message to more queues than expected. Walk through how you find the offending binding.**
A: Over-delivery in a topic exchange almost always means a binding's pattern is broader than intended, and the usual offender is `#`. I would first `list_bindings` for that exchange and enumerate every binding key on the destination queues, then take the message's actual routing key and match it by hand against each pattern in the topic language — remembering that `#` matches zero-or-more words, so a binding meant as `orders.#` will also match `orders` alone and `orders.eu.created.detail`, and a stray `#` binding (perhaps an audit queue someone bound to "everything") will catch the message legitimately but surprisingly. I would check for duplicate or overlapping bindings on the same queue, since a queue bound with both `order.eu.*` and `order.#` gets one copy but from two matching rules, which can confuse reasoning. I would also verify no exchange-to-exchange binding is forwarding the message from another exchange into this one — over-delivery sometimes comes from an upstream source exchange bound in with `#`. The management UI's publish tester is invaluable here: send the exact routing key and it lists precisely which queues match, which turns the hand analysis into a confirmed answer. Once I have the offending binding, the fix is to tighten the pattern (`*` instead of `#`, or add a word) or move the over-broad audit binding to a separate exchange so it does not share the selective one. The root cause is nearly always `#` used where a bounded `*` was meant, or an audit-everything binding living on the same exchange as selective ones.

**Q: (Senior) What are the performance and operational implications of each exchange type at scale?**
A: The types differ in matching cost and in how their cost scales. Fanout does no matching at all — its cost is purely the number of enqueues, one per bound queue — so it is cheap per message but expensive in fan-out width; thousands of bound queues means thousands of copies per publish, and the bottleneck is the queues and their consumers, not the exchange. Direct is a hash-map lookup on the exact key, effectively O(1) in the number of bindings, so it scales well even with many discrete keys. Topic matches the routing key against a trie of binding-key words, which is efficient but does more work per message than direct and grows with pattern complexity and the number of distinct patterns; very high-cardinality topic routing with thousands of patterns is where you feel it. Headers is the heaviest because it evaluates an argument table per binding rather than comparing a short string, and it cannot use the same trie optimisation, so a headers exchange with many bindings is the one to load-test. Operationally, the immutability of type and the difficulty of changing a topic key scheme mean the biggest risk is not runtime cost but change cost: getting the type and key scheme wrong forces a disruptive delete-recreate-rebind. At real scale I also watch that a single exchange is not a routing hotspot — since an exchange itself is cheap but the queues behind it carry the load, I shard hot flows across multiple queues (consistent-hash exchange) rather than relying on one exchange to absorb everything. In short: prefer direct/fanout for the hottest paths, use topic as the flexible default with an eye on pattern cardinality, load-test headers before committing to it at volume, and treat the key scheme as the thing most expensive to change.

## 10. Quick Revision & Cheat Sheet

| Type | Matches on | Rule | Use for |
|---|---|---|---|
| **Direct** | routing key | binding key == routing key | discrete exact categories, point-to-point |
| **Fanout** | nothing | every bound queue gets a copy | broadcast / pub-sub |
| **Topic** | routing key | wildcard pattern (`*`, `#`) over dotted words | hierarchical events (the default) |
| **Headers** | header attributes | `x-match` all (AND) / any (OR) | multi-dimensional attribute routing |

| Topic wildcard | Matches |
|---|---|
| `*` | exactly one word |
| `#` | zero or more words |
| `#` (whole key) | everything (fanout-like) |
| no wildcard | exact (direct-like) |

**Flash cards**
- **Exact-match routing?** → Direct exchange (binding key == routing key).
- **Broadcast to all?** → Fanout (routing key ignored).
- **`*` vs `#`?** → `*` = exactly one word; `#` = zero or more words.
- **`logs.*` vs `logs.eu.error`?** → No match — `*` is one word, the key has two after `logs`. Use `logs.#`.
- **Route on `format=pdf` AND `region=eu`?** → Headers exchange, `x-match=all`.
- **Chain exchanges?** → `exchange.bind` (exchange-to-exchange), optionally into an `internal=true` exchange.

## 11. Hands-On Exercises & Mini Project

- [ ] Declare a direct exchange and bind two queues (one with `error`, one with `error`+`info`); publish `error`, `info`, `debug` and record where each lands.
- [ ] Declare a fanout exchange with three bound queues; publish with three different routing keys and confirm all three queues receive every message regardless.
- [ ] Declare a topic exchange and bind `order.eu.*`, `*.*.created`, and `#`; publish `order.eu.created`, `order.us.created`, `payment.eu.refunded` and trace the deliveries.
- [ ] Deliberately try `logs.*` against `logs.eu.error` and confirm it does *not* match; fix it to `logs.#` and confirm it does.
- [ ] Declare a headers exchange with an `x-match=all` and an `x-match=any` binding; publish messages with different header sets and verify AND/OR behaviour.
- [ ] Create an exchange-to-exchange binding feeding a fanout audit exchange, mark it `internal=true`, and confirm clients cannot publish to it directly.

### Mini Project — "Routing Playground"

**Goal.** Build one topology exercising all four exchange types and prove, by tracing real publishes, that each routes exactly as its rule dictates — turning the matching rules from memorised facts into observed behaviour.

**Requirements.**
1. Declare one exchange of each type (`direct`, `fanout`, `topic`, `headers`) and a set of queues bound to each with deliberately chosen binding keys / header arguments.
2. Write a publisher that can send a message to any exchange with a chosen routing key and header set, and a consumer harness that logs which queue received each message.
3. Produce a table of test publishes with the expected destination set for each, then run them and confirm actual matches expected — especially the topic wildcard edge cases (`*` vs `#`, empty tail).
4. Add an exchange-to-exchange binding routing everything from the topic exchange into a fanout audit exchange, and show the audit queues receive every topic message without the publisher targeting them.
5. Enable `mandatory` and publish a deliberately unroutable message to each exchange type, catching the return instead of losing the message.

**Extensions.**
- Benchmark publish throughput through each exchange type with many bindings and compare direct vs topic vs headers matching cost.
- Redesign a real topic key scheme two ways (different word orders) and show which consumer filters become clean or contorted under each.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Exchanges, Queues & Bindings (AMQP 0-9-1)* (the object model these types plug into), *Producing & Consuming: Acks, Prefetch & QoS* (the consume side), *Reliability: Publisher Confirms, Durability & the Mandatory Flag* (catching unroutable messages), *Dead-Letter Exchanges, TTL & Delayed Messages* (routing rejected/expired messages), *Ordering, Partitioning & Keys* (where per-key routing and order meet).

- **RabbitMQ — Tutorial 4 (Routing) & Tutorial 5 (Topics)** — RabbitMQ · *Beginner* · runnable walkthroughs of direct and topic routing with worked wildcard examples. <https://www.rabbitmq.com/tutorials/tutorial-five-python>
- **RabbitMQ — AMQP 0-9-1 Model Explained (Exchanges)** — RabbitMQ · *Beginner* · the definitive description of the four exchange types and their matching rules. <https://www.rabbitmq.com/tutorials/amqp-concepts#exchanges>
- **RabbitMQ — Exchange-to-Exchange Bindings** — RabbitMQ · *Intermediate* · the extension that lets exchanges chain, with semantics and examples. <https://www.rabbitmq.com/docs/e2e>
- **RabbitMQ — Headers Exchange & x-match** — RabbitMQ · *Intermediate* · how attribute-based routing and `x-match=all/any` work in practice. <https://www.rabbitmq.com/docs/exchanges>
- **rabbitmq/amqp091-go — examples** — RabbitMQ (GitHub) · *Intermediate* · the Go client used here, with per-exchange-type example programs. <https://github.com/rabbitmq/amqp091-go/tree/main/_examples>
- **Consistent Hash Exchange plugin** — RabbitMQ · *Advanced* · sharding load across many queues by hashing the routing key, for high-cardinality routing. <https://github.com/rabbitmq/rabbitmq-server/tree/main/deps/rabbitmq_consistent_hash_exchange>
- **Enterprise Integration Patterns — Content-Based Router & Message Filter** — Hohpe & Woolf · *Intermediate* · the patterns that topic and headers exchanges implement. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/ContentBasedRouter.html>
- **RabbitMQ in Depth (ch. on exchanges & routing)** — Gavin M. Roy (Manning) · *Advanced* · a thorough treatment of exchange types and topology design for production routing. <https://www.manning.com/books/rabbitmq-in-depth>

---

*Kafka & RabbitMQ Handbook — chapter 07.*
