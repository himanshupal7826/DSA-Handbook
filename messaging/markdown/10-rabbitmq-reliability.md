# 10 · Reliability: Publisher Confirms, Persistence & Mandatory

> **In one line:** RabbitMQ will happily lose your message at four distinct points — in flight to the broker, in the broker's memory before it hits disk, at an exchange with no matching queue, and in a consumer that crashes before acking — and durability is not one setting but a chain of four defences (publisher confirms, durable queues *and* persistent messages, the mandatory flag, and manual consumer acks) where any missing link loses data.

---

## 1. Overview

"RabbitMQ is durable" is a half-truth that has cost many teams a production incident. Out of the box, with default settings, a message can vanish silently at several points along its journey, and each point needs its *own* deliberate defence. The dangerous part is that the defences are independent — turning on one and assuming the rest follow is exactly how you end up believing you are safe when you are not. This chapter is the honest, end-to-end account of *where* RabbitMQ loses messages and *what* stops it at each place.

There are four loss points. First, **the publish may never reach the broker**: the network drops, the broker is restarting, and a fire-and-forget publish returns success to your code while the message never arrived. The defence is **publisher confirms** — the broker explicitly acknowledges each message it has taken responsibility for. Second, **the broker may crash before the message is on disk**: even if the publish arrived, a message sitting only in memory dies with the node. The defence is a **durable queue** *plus* a **persistent message** (`delivery_mode=2`) — and it must be *both*, which is the single most common misunderstanding in RabbitMQ reliability. Third, **the message may be unroutable**: published to an exchange with no matching binding, it is discarded without a whisper. The defence is the **mandatory flag** with a **return listener** (or an alternate exchange). Fourth, **the consumer may crash before it finishes**: if it acknowledged on receipt, the message is gone. The defence is **manual acknowledgement after processing** (covered in chapters 8 and 9; we tie it in here for completeness).

The chapter also settles a question people still get wrong: AMQP *transactions* exist (`tx.select`/`tx.commit`) and give atomic multi-message publishes, but they are slow — a synchronous round-trip per commit — and **publisher confirms are the preferred mechanism** for the "did the broker get it?" question, because confirms can be pipelined asynchronously for orders-of-magnitude more throughput. We finish with the end-to-end reliable-publish recipe and heavily-commented `amqp091-go` code that wires confirms, persistence and a return handler together, because reliability is precisely the property that only holds when *all* the links are present.

## 2. Core Concepts

- **Publisher confirm** — an asynchronous acknowledgement from the broker to the producer that it has taken responsibility for a message (routed it to all queues, and persisted it if persistent). Enabled per channel with `confirm.select`.
- **Durable queue** — a queue whose *definition* is written to disk, so the queue still exists after a broker restart. Durability of the queue is separate from durability of its messages.
- **Persistent message** — a message published with `delivery_mode=2`, asking the broker to write the *message body* to disk. Non-persistent messages live only in memory.
- **The "both" rule** — a message survives a broker restart only if the queue is durable *and* the message is persistent. Either alone is not enough.
- **Mandatory flag** — a publish option: if the message cannot be routed to *any* queue, the broker returns it to the producer rather than dropping it.
- **Return listener** — the producer-side handler that receives mandatory-returned (unroutable) messages so they are caught, not lost.
- **Alternate exchange** — an exchange configured as a fallback on another exchange; messages the primary cannot route are sent here instead of being discarded.
- **Consumer acknowledgement** — `basic.ack` after successful processing; until acked, the broker keeps the message and redelivers it if the consumer dies (at-least-once).
- **AMQP transaction** — `tx.select`/`tx.commit`/`tx.rollback`: atomic batching of publishes/acks, but synchronous and slow; superseded by confirms for throughput.
- **`delivery_mode`** — message property: `1` = transient (memory), `2` = persistent (write to disk). The single flag that controls message persistence.

## 3. Theory & Principles

### The four places a message dies

Reliability in RabbitMQ is best understood as a chain, and a chain is exactly as strong as its weakest link. Trace one message from producer to processed and mark every place it can be lost:

1. **Producer → broker (in flight).** The producer calls publish. If it does not wait for a confirmation, "publish returned" means only "handed to the client library / TCP socket", not "the broker has it". A connection blip, a broker restart, or an internal error can swallow it. **Publisher confirms** close this gap: the broker sends an `ack` (basic.ack) for each message it has accepted, or a `nack` for one it could not, and the producer treats *unconfirmed* as *not sent*.

2. **Broker memory → disk (before persist).** The broker has the message, but if it is only in memory and the node crashes, it is gone. Two independent flags govern survival: the *queue* must be **durable** (so the queue still exists after restart to hold recovered messages) and the *message* must be **persistent** (`delivery_mode=2`, so the body was written to disk). Miss either and a restart loses the message — a durable queue full of transient messages comes back empty, and persistent messages routed to a non-durable queue vanish with the queue.

3. **Exchange → queue (unroutable).** The producer published to an exchange, but no binding matched the routing key, so there is no queue to hold it. By default RabbitMQ *silently drops* it. The **mandatory** flag makes the broker *return* the message to the producer instead, where a **return listener** catches it; alternatively an **alternate exchange** re-routes unroutables to a catch-all queue.

4. **Queue → consumer (crash before ack).** The consumer received the message but crashed before finishing. If it used auto-ack (acked on delivery), the broker already forgot the message and it is lost. **Manual ack after processing** means the broker holds the message until success and redelivers on a dropped connection — the at-least-once guarantee.

The unifying principle is that **the broker only guarantees what you asked it to guarantee, at each hop, and the guarantees do not imply one another.** Confirms do not make messages persistent; persistence does not make unroutables safe; none of it survives an auto-acking consumer. Reliability is the *conjunction* of all four defences.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="rl" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Four loss points, four independent defences</text>

  <rect x="24" y="44" width="120" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="84" y="65" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">producer</text>
  <text x="84" y="82" text-anchor="middle" fill="#1d4ed8" font-size="9">publish</text>

  <rect x="256" y="44" width="120" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="316" y="65" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">exchange</text>
  <text x="316" y="82" text-anchor="middle" fill="#b45309" font-size="9">route</text>

  <rect x="488" y="44" width="120" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="548" y="65" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">queue</text>
  <text x="548" y="82" text-anchor="middle" fill="#166534" font-size="9">buffer (disk?)</text>

  <rect x="720" y="44" width="120" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="780" y="65" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">consumer</text>
  <text x="780" y="82" text-anchor="middle" fill="#6d28d9" font-size="9">process + ack</text>

  <path d="M146,67 L254,67" stroke="#334155" stroke-width="2" marker-end="url(#rl)"/>
  <path d="M378,67 L486,67" stroke="#334155" stroke-width="2" marker-end="url(#rl)"/>
  <path d="M610,67 L718,67" stroke="#334155" stroke-width="2" marker-end="url(#rl)"/>

  <text x="200" y="112" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LOSS 1</text>
  <text x="200" y="126" text-anchor="middle" fill="#991b1b" font-size="8">never reaches broker</text>
  <text x="432" y="112" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LOSS 3</text>
  <text x="432" y="126" text-anchor="middle" fill="#991b1b" font-size="8">unroutable, dropped</text>
  <text x="548" y="112" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LOSS 2</text>
  <text x="548" y="126" text-anchor="middle" fill="#991b1b" font-size="8">crash before disk</text>
  <text x="780" y="112" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">LOSS 4</text>
  <text x="780" y="126" text-anchor="middle" fill="#991b1b" font-size="8">crash before ack</text>

  <rect x="24" y="146" width="410" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="168" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Defence 1 &#8212; Publisher confirms</text>
  <text x="40" y="192" fill="#1d4ed8" font-size="10">confirm.select on the channel</text>
  <text x="40" y="210" fill="#1d4ed8" font-size="10">broker sends basic.ack per accepted message</text>
  <text x="40" y="228" fill="#1d4ed8" font-size="10">treat UNCONFIRMED as NOT SENT &#8594; resend</text>
  <text x="40" y="252" fill="#1e40af" font-size="10" font-weight="bold">Defence 3 &#8212; mandatory + return listener</text>
  <text x="40" y="272" fill="#1d4ed8" font-size="10">unroutable &#8594; RETURNED, not dropped</text>
  <text x="40" y="288" fill="#1d4ed8" font-size="10">(or alternate exchange &#8594; catch-all queue)</text>

  <rect x="446" y="146" width="410" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="168" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Defence 2 &#8212; the BOTH rule</text>
  <text x="462" y="192" fill="#166534" font-size="10">durable queue &#8594; queue survives restart</text>
  <text x="462" y="210" fill="#166534" font-size="10">persistent msg (delivery_mode=2) &#8594; body on disk</text>
  <text x="462" y="230" fill="#b91c1c" font-size="10" font-weight="bold">need BOTH &#8212; either alone loses the message</text>
  <text x="462" y="254" fill="#15803d" font-size="10" font-weight="bold">Defence 4 &#8212; manual ack after processing</text>
  <text x="462" y="274" fill="#166534" font-size="10">basic.ack only on success &#8594; at-least-once</text>
  <text x="462" y="290" fill="#166534" font-size="10">crash before ack &#8594; broker redelivers</text>

  <rect x="24" y="312" width="832" height="140" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="334" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Reliability = the CONJUNCTION of all four &#8212; a chain is as strong as its weakest link</text>
  <text x="48" y="360" fill="#475569" font-size="10">Confirms do NOT make a message persistent. Persistence does NOT protect an unroutable message.</text>
  <text x="48" y="380" fill="#475569" font-size="10">None of it survives an auto-acking consumer that crashes mid-process. The guarantees do not imply one another.</text>
  <text x="48" y="406" fill="#b45309" font-size="10" font-weight="bold">Transactions vs confirms:</text>
  <text x="200" y="406" fill="#475569" font-size="10">tx.commit is a synchronous round-trip per batch &#8212; slow.</text>
  <text x="48" y="426" fill="#475569" font-size="10">Confirms pipeline asynchronously &#8594; same "did the broker get it?" guarantee at far higher throughput. Prefer confirms.</text>
</svg>
```

### Transactions vs confirms: why confirms won

AMQP has native transactions: `tx.select` puts a channel in transactional mode, and a batch of publishes and acks becomes atomic on `tx.commit` (or is discarded on `tx.rollback`). This *does* give you "the broker has these messages" — but it is slow, because `tx.commit` is a synchronous round-trip that blocks the publisher until the broker has durably recorded the whole batch, and there is no pipelining. A single-message transaction is roughly a request/response per message, which throttles throughput by an order of magnitude or more.

**Publisher confirms** solve the same problem differently and better. The producer enables confirm mode once (`confirm.select`), then publishes as fast as it likes *without blocking*; the broker sends `basic.ack` frames back asynchronously, tagged with each message's delivery sequence number, and may batch them (`multiple=true` acks everything up to a sequence number). The producer keeps a set of unconfirmed messages and clears them as acks arrive. This decouples "publish rate" from "confirm latency" — you get the *same* durability guarantee as a transaction (the broker took responsibility) but pipelined, so throughput stays high. That is why the RabbitMQ team recommends confirms over transactions for reliability, and why every modern reliable-publish recipe is built on confirms. Transactions retain a niche only when you genuinely need *atomicity across several publishes* (all-or-nothing), which confirms do not provide.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Four places a message is lost &#8212; and the fix at each</text>

  <rect x="24" y="44" width="120" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="84" y="72" text-anchor="middle" fill="#1e40af" font-weight="bold">producer</text>
  <path d="M146,67 L206,67" stroke="#4f46e5" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="210" y="44" width="120" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="270" y="66" text-anchor="middle" fill="#92400e" font-weight="bold">exchange</text>
  <text x="270" y="82" text-anchor="middle" fill="#b45309" font-size="9">routes</text>
  <path d="M332,67 L392,67" stroke="#4f46e5" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="396" y="44" width="120" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="456" y="66" text-anchor="middle" fill="#15803d" font-weight="bold">queue</text>
  <text x="456" y="82" text-anchor="middle" fill="#166534" font-size="9">on disk?</text>
  <path d="M518,67 L578,67" stroke="#4f46e5" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="582" y="44" width="120" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="642" y="72" text-anchor="middle" fill="#5b21b6" font-weight="bold">consumer</text>

  <rect x="24" y="110" width="180" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="114" y="130" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">1. publish never arrives</text>
  <text x="114" y="150" text-anchor="middle" fill="#991b1b" font-size="9">network drop / broker busy</text>
  <text x="114" y="170" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">FIX: publisher confirms</text>
  <text x="114" y="184" text-anchor="middle" fill="#166534" font-size="8">broker acks each publish</text>

  <rect x="212" y="110" width="180" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="302" y="130" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">2. unroutable, dropped</text>
  <text x="302" y="150" text-anchor="middle" fill="#991b1b" font-size="9">no queue bound &#8594; silently gone</text>
  <text x="302" y="170" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">FIX: mandatory + return</text>
  <text x="302" y="184" text-anchor="middle" fill="#166534" font-size="8">broker returns it to you</text>

  <rect x="400" y="110" width="180" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="490" y="130" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">3. broker crash before disk</text>
  <text x="490" y="150" text-anchor="middle" fill="#991b1b" font-size="9">in-memory only &#8594; lost on restart</text>
  <text x="490" y="170" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">FIX: durable queue +</text>
  <text x="490" y="184" text-anchor="middle" fill="#166534" font-size="8">persistent msg (delivery_mode=2) &#8212; BOTH</text>

  <rect x="588" y="110" width="180" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="678" y="130" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">4. consumer crash mid-work</text>
  <text x="678" y="150" text-anchor="middle" fill="#991b1b" font-size="9">auto-ack &#8594; message gone</text>
  <text x="678" y="170" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">FIX: manual ack</text>
  <text x="678" y="184" text-anchor="middle" fill="#166534" font-size="8">ack AFTER processing (ch08)</text>

  <rect x="24" y="210" width="744" height="110" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="396" y="232" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">End-to-end reliable publish = all four, together</text>
  <text x="40" y="256" fill="#166534" font-size="10">&#8226; confirm.select once per channel, then wait for (or track) the broker ack for every publish</text>
  <text x="40" y="274" fill="#166534" font-size="10">&#8226; declare the queue DURABLE and mark each message PERSISTENT &#8212; one without the other still loses data</text>
  <text x="40" y="292" fill="#166534" font-size="10">&#8226; publish with the mandatory flag and a return listener, so an unroutable message is caught, not dropped</text>
  <text x="40" y="310" fill="#166534" font-size="10">&#8226; consumers ack only after successful processing &#8594; a crash redelivers rather than loses (at-least-once)</text>
</svg>
```

The reliable-publish workflow, hop by hop, is the chain from section 3 turned into an operational sequence:

1. **Enable confirms once per channel** with `confirm.select`. From now on the broker will ack (or nack) every publish on this channel.
2. **Declare the queue durable** and bind it, so its definition survives a restart. Do this at startup; declaration is idempotent.
3. **Publish persistent, mandatory.** Set `delivery_mode=2` and `mandatory=true`. Register a *return listener* before publishing so an unroutable message is caught the instant it comes back.
4. **Track the message as unconfirmed** by its delivery tag / sequence number, and start a timer. The message is *not* durably sent until the broker confirms it.
5. **On `basic.ack`,** clear the message from the unconfirmed set — it is now the broker's responsibility. On `basic.nack` (rare — broker could not take it, e.g. an internal error or a full quorum queue), *resend* it. On timeout with neither, resend (and deduplicate downstream, because the original may still land — confirms give at-least-once on the publish side).
6. **On a return** (mandatory + unroutable), the message never reached a queue; treat it as a routing bug or hold it for reprocessing — do not consider it delivered.
7. **Consumer side:** consume with manual ack, process, then `basic.ack`. A crash before the ack redelivers. This closes loss point 4.

The critical architectural insight is timing: **the confirm arrives only after the broker has done everything it promised for that message** — routed it to all matching queues and, for a persistent message on a durable queue, written it to disk (or replicated it, for a quorum queue). So a confirm is a genuine "it is safe now" signal, but *only as safe as the queue it landed in*: a persistent message confirmed into a durable classic queue on a single node is safe against that node restarting, but not against that node's disk being permanently lost — for that you need replication (quorum queues, chapter 12). Confirms and persistence protect against *crashes/restarts*; replication protects against *node loss*. Knowing which threat each defence addresses is what separates a real reliability design from cargo-culted flags.

## 5. Implementation

A reliable publisher in `amqp091-go` with confirms, persistence, the mandatory flag and a return handler — and a matching reliable consumer. Comments explain why each piece is load-bearing.

### Reliable publisher — confirms + persistence + mandatory + returns

```go
package main

import (
	"context"
	"log"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// reliablePublisher wires all four publish-side defences together. Any one of
// them missing reopens a loss point, so they belong in one place.
type reliablePublisher struct {
	ch      *amqp.Channel
	returns chan amqp.Return // unroutable messages come back here (mandatory)

	mu          sync.Mutex
	unconfirmed map[uint64][]byte // seqNo -> body, so we can resend on nack/timeout
	nextSeq     uint64
}

func newReliablePublisher(conn *amqp.Connection) (*reliablePublisher, error) {
	ch, err := conn.Channel()
	if err != nil {
		return nil, err
	}

	// STEP 1: put the channel into confirm mode. From here the broker acks or
	// nacks every publish. noWait=false so we block until the broker agrees.
	if err := ch.Confirm(false /*noWait*/); err != nil {
		return nil, err
	}

	// STEP 2: declare the queue DURABLE so it survives a broker restart. A
	// persistent message routed to a NON-durable queue is still lost on restart,
	// because the queue vanishes and takes its messages with it.
	if _, err := ch.QueueDeclare("orders", true /*durable*/, false, false, false, nil); err != nil {
		return nil, err
	}

	p := &reliablePublisher{
		ch:          ch,
		returns:     ch.NotifyReturn(make(chan amqp.Return, 64)), // mandatory returns
		unconfirmed: make(map[uint64][]byte),
	}

	// Async confirm listener: the broker sends confirmations out of band, tagged
	// with the delivery sequence number. multiple=true means "everything up to
	// and including this seqNo" — so we clear a RANGE, which is what lets confirms
	// pipeline instead of blocking per message like a transaction would.
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 256))
	go p.handleConfirms(confirms)
	go p.handleReturns()

	return p, nil
}

func (p *reliablePublisher) handleConfirms(confirms <-chan amqp.Confirmation) {
	for c := range confirms {
		p.mu.Lock()
		if c.Ack {
			// The broker took responsibility: routed it, and (persistent+durable)
			// wrote it to disk. Safe to forget now.
			delete(p.unconfirmed, c.DeliveryTag)
		} else {
			// NACK: the broker could NOT accept it (internal error, quorum queue
			// unavailable, etc). It is NOT stored — we must resend it.
			body := p.unconfirmed[c.DeliveryTag]
			log.Printf("NACK for seq %d: resending", c.DeliveryTag)
			delete(p.unconfirmed, c.DeliveryTag)
			go p.publish(body) // resend; downstream must dedup (at-least-once)
		}
		p.mu.Unlock()
	}
}

func (p *reliablePublisher) handleReturns() {
	// A returned message was UNROUTABLE — no binding matched. It never reached a
	// queue, so it is NOT delivered. Treat as a routing bug / hold for replay.
	for r := range p.returns {
		log.Printf("RETURNED unroutable: exchange=%q key=%q reason=%q body=%s",
			r.Exchange, r.RoutingKey, r.ReplyText, r.Body)
	}
}

func (p *reliablePublisher) publish(body []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p.mu.Lock()
	p.nextSeq++
	seq := p.nextSeq
	p.unconfirmed[seq] = body // remember it until the confirm clears it
	p.mu.Unlock()

	// STEP 3: publish PERSISTENT and MANDATORY.
	//  - DeliveryMode Persistent (=2) asks the broker to write the body to disk.
	//  - mandatory=true makes an unroutable message RETURN instead of vanishing.
	err := p.ch.PublishWithContext(ctx,
		"",       // default exchange -> routing key is the queue name
		"orders", // routing key = queue "orders"
		true,     // mandatory: return if unroutable
		false,    // immediate: deprecated, always false
		amqp.Publishing{
			DeliveryMode: amqp.Persistent, // delivery_mode = 2
			ContentType:  "application/json",
			MessageId:    "order-" + time.Now().Format("150405.000"), // for dedup
			Body:         body,
		},
	)
	if err != nil {
		// A publish error means the message never left; drop it from unconfirmed
		// and retry per your policy.
		p.mu.Lock()
		delete(p.unconfirmed, seq)
		p.mu.Unlock()
		log.Printf("publish error: %v (will retry)", err)
	}
}

func main() {
	conn, err := amqp.Dial("amqp://guest:guest@localhost:5672/")
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	pub, err := newReliablePublisher(conn)
	if err != nil {
		log.Fatal(err)
	}

	for i := 0; i < 100; i++ {
		pub.publish([]byte(`{"order":"place","id":` + time.Now().Format("0405000") + `}`))
	}

	// Give async confirms time to arrive before exit; a real service would block
	// on a shutdown signal and only exit once unconfirmed is empty.
	time.Sleep(2 * time.Second)
	pub.mu.Lock()
	log.Printf("still unconfirmed at shutdown: %d (would resend these)", len(pub.unconfirmed))
	pub.mu.Unlock()
}
```

### Reliable consumer — manual ack after processing

```go
package main

import (
	"log"

	amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()

	// Must match the publisher's declaration exactly (durable).
	_, _ = ch.QueueDeclare("orders", true, false, false, false, nil)

	// Bound in-flight work; also fair dispatch across consumers.
	_ = ch.Qos(10, 0, false)

	// autoAck=false is the WHOLE point: the broker keeps the message until we ack,
	// and redelivers it if we die mid-processing. autoAck=true would ack on
	// delivery and lose the message on a crash (at-most-once).
	msgs, _ := ch.Consume("orders", "", false /*autoAck*/, false, false, false, nil)

	for d := range msgs {
		if err := handleOrder(d.Body); err != nil {
			// requeue=false so a permanently-bad message dead-letters (chapter 11)
			// instead of looping. requeue=true only for transient failures.
			_ = d.Nack(false, false)
			continue
		}
		// Ack ONLY after success -> at-least-once. If we crashed above, no ack was
		// sent, so the broker redelivers to another consumer.
		_ = d.Ack(false)
	}
}

func handleOrder(body []byte) error {
	// ... idempotent processing keyed on MessageId (chapter 21) ...
	return nil
}
```

### CLI cross-check

```bash
# Confirm the queue came back DURABLE and still holds its messages after a
# broker restart. "durable=true" plus a non-zero "messages" after a bounce is
# the proof that the BOTH rule held.
rabbitmqctl list_queues name durable messages messages_ready messages_unacknowledged

# Publish a test message and watch confirms/returns in the management UI, or
# declare an alternate exchange as a belt-and-braces catch-all for unroutables:
rabbitmqadmin declare exchange name=unrouted type=fanout durable=true
rabbitmqadmin declare queue name=unrouted-hold durable=true
rabbitmqadmin declare binding source=unrouted destination=unrouted-hold
# then set alternate-exchange=unrouted as an argument on your primary exchange.
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **No silent message loss.** With confirms, persistence, mandatory and manual acks in place, every one of the four loss points is closed — a message is either processed or visibly held/returned/resent, never quietly gone.
- **High throughput despite durability.** Asynchronous publisher confirms pipeline, so you get the transaction-grade "broker has it" guarantee without the per-message round-trip that makes transactions slow.
- **Explicit failure signals.** Nacks, returns and redeliveries turn invisible loss into observable events you can log, alert on and act upon.

**Disadvantages**
- **More moving parts.** You now track unconfirmed messages, handle returns, resend on nack/timeout, and dedup downstream — real code and state that fire-and-forget did not need.
- **Persistence costs throughput and latency.** Writing every message to disk (`delivery_mode=2`) is slower than memory-only, and fsync policy trades durability against speed.
- **Confirms give at-least-once, not exactly-once.** A resend after a timeout can duplicate a message that actually landed, so consumers must be idempotent — durability does not remove the dedup burden.

**Trade-offs**
- *Durability vs throughput:* persistent messages on durable queues, confirmed, are the reliable default but the slowest; transient, unconfirmed, auto-acked is the fastest and least safe. Choose per stream — an audit log wants full durability, a live metrics feed may prefer speed and tolerate loss.
- *Confirms vs transactions:* confirms give the same "broker got it" guarantee with far more throughput via pipelining; transactions add true atomicity across a batch at a heavy speed cost. Prefer confirms unless you specifically need all-or-nothing across several publishes.
- *Sync-wait vs async-confirm:* waiting for each confirm before the next publish is simplest but throttles throughput to the round-trip; tracking unconfirmed asynchronously is faster but requires the bookkeeping shown above. Match the complexity to the throughput you actually need.

## 7. Common Mistakes & Best Practices

- **Durable queue, transient messages.** Declaring the queue durable but forgetting `delivery_mode=2` — the queue survives a restart but comes back *empty*. Both are required; this is the number-one RabbitMQ reliability bug.
- **Persistent messages, non-durable queue.** The mirror image: the message asks to be persisted but the queue is not durable, so the queue disappears on restart and takes the message with it.
- **Fire-and-forget publishing.** Assuming "publish returned" means "the broker has it". Without confirms, a connection blip loses the message and your code never knows. Enable confirms for anything that matters.
- **Ignoring nacks and returns.** Enabling confirms/mandatory but not handling the nack and return channels — the signals arrive and are dropped, so you are no safer than before, just noisier.
- **No mandatory / no alternate exchange.** Publishing to an exchange and assuming it routes; a typo'd routing key or missing binding silently discards every message. Use mandatory + a return listener, or an alternate exchange.
- **Using transactions for throughput.** Reaching for `tx.commit` per message and then wondering why publishing is ten times slower. Confirms give the same guarantee, pipelined.
- **Forgetting idempotency.** Treating confirms as exactly-once. A timeout-triggered resend can duplicate a landed message; consumers must dedup on a stable message id.
- **Best practice:** for any stream that must not lose data, turn on all four defences together — confirms, durable queue *and* persistent messages, mandatory with a return handler (or an alternate exchange), and manual consumer acks after processing — and make consumers idempotent, because the whole thing is at-least-once.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** "We lost messages" is diagnosed by walking the four loss points. Check `rabbitmqctl list_queues name durable messages` — is the queue durable, and did messages survive a restart? Check whether the publisher enabled confirms and whether the unconfirmed set drains (a growing unconfirmed set means the broker is not acking — often flow control or a full disk). Check for returns (unroutable — a binding/routing-key mismatch). Check consumer acks — a rising `messages_unacknowledged` with no throughput means consumers receive but never ack. The management UI's per-message-rate graphs (publish, confirm, return, deliver, ack) make the leaking hop visible.
- **Monitoring.** Alert on: **confirm latency / unconfirmed backlog** (publisher not getting acks → broker under pressure), **return rate** (unroutable messages → routing bug), **redelivery rate** (consumers failing → poison messages), **queue depth** and **disk/memory alarms**. RabbitMQ's *memory and disk high-watermark alarms* trigger *flow control* (it stops accepting publishes) — a spike in blocked connections often explains "publishes hanging".
- **Security.** Durability means data at rest on the broker's disk — ensure disk encryption and least-privilege access to the RabbitMQ data directory, since persistent messages now live there. Use TLS for AMQP so in-flight messages and confirms are encrypted, and per-service credentials scoped to a virtual host so a compromised producer cannot publish to arbitrary exchanges.
- **Scaling.** Persistence and confirms cost throughput, so scale by (a) batching confirms asynchronously rather than waiting per message, (b) tuning the queue's storage (lazy/classic v2 queues page to disk to bound memory), and (c) accepting that single-node durability protects against *restart* but not *node loss* — for the latter you replicate with quorum queues (chapter 12), which changes when a confirm arrives (after a majority has the message) and thus the throughput/latency profile.

## 9. Interview Questions

**Q: Where can RabbitMQ lose a message, and what stops it at each point?**
A: Four places. In flight from producer to broker — a fire-and-forget publish can be lost on a connection blip; publisher confirms stop it by making the broker ack every accepted message. In the broker before it reaches disk — a crash loses an in-memory message; a durable queue plus a persistent message (`delivery_mode=2`) stop it, and you need both. At the exchange with no matching binding — the message is silently dropped; the mandatory flag with a return listener (or an alternate exchange) stops it. And at the consumer — a crash before acking loses the message if it auto-acked; manual ack after processing stops it, giving at-least-once. Reliability is all four together, because none implies the others.

**Q: What is the single most common RabbitMQ durability mistake?**
A: Declaring the queue durable but publishing transient (non-persistent) messages, or the reverse. People assume "durable queue" means "durable messages", but they are separate settings: the queue being durable means its *definition* survives a restart, while the message being persistent (`delivery_mode=2`) means its *body* was written to disk. A durable queue full of transient messages comes back empty after a restart; persistent messages sent to a non-durable queue vanish with the queue. You need *both* the durable queue and the persistent message for a message to survive a broker restart.

**Q: What are publisher confirms and how do they differ from just publishing?**
A: A plain publish returns as soon as the message is handed to the client library and socket; it does not tell you the broker actually received or stored it. Publisher confirms, enabled with `confirm.select` on the channel, make the broker send an asynchronous `basic.ack` for each message once it has taken responsibility — routed it to all queues and persisted it if persistent — or a `basic.nack` if it could not. The producer tracks unconfirmed messages by sequence number and treats anything unconfirmed as not sent, resending on nack or timeout. This turns "I hope it arrived" into "the broker told me it has it".

**Q: What does the mandatory flag do?**
A: It changes what happens to an *unroutable* message — one published to an exchange where no binding matches the routing key. By default such a message is silently discarded. With `mandatory=true`, the broker instead *returns* the message to the producer, which catches it via a return listener and can treat it as a routing bug or hold it for reprocessing. It is the defence against the third loss point: a typo in a routing key or a missing binding that would otherwise drop every affected message without a trace. An alternate exchange is the server-side alternative — unroutables go to a catch-all queue instead.

**Q: Why are publisher confirms preferred over AMQP transactions?**
A: Because they give the same durability guarantee with far higher throughput. A transaction (`tx.select`/`tx.commit`) makes a batch of publishes atomic, but `tx.commit` is a synchronous round-trip that blocks the publisher until the broker has durably recorded the batch, with no pipelining — roughly a request/response per message, which throttles throughput by an order of magnitude. Publisher confirms let you publish continuously without blocking; the broker acks asynchronously, batching acks with `multiple=true`, so publish rate is decoupled from confirm latency. You get "the broker has it" pipelined. Transactions retain a niche only when you need true all-or-nothing atomicity across several publishes, which confirms do not provide.

**Q: Do publisher confirms give exactly-once delivery?**
A: No. They give a reliable at-least-once *publish*: you know the broker has the message, but if a confirm times out or the connection drops after the broker stored it but before the ack reached you, you will resend a message that actually landed, producing a duplicate. So confirms remove message *loss* on the publish side but not message *duplication*. Achieving effectively-once still requires idempotent consumers — deduplicating on a stable message id — because the end-to-end guarantee across confirms and redeliveries is at-least-once, not exactly-once.

**Q: (Senior) Walk through the exact sequence and timing of a fully reliable publish. When is it "safe"?**
A: I enable confirm mode on the channel once (`confirm.select`), declare the target queue durable, and register a return listener before publishing. For each message I assign it the next delivery sequence number, add it to an unconfirmed map, and publish it persistent (`delivery_mode=2`) and mandatory. The publish call returns immediately — that is *not* the safe point; the message is only "in flight". The broker then does its work: routes the message to every matching queue and, because it is persistent and the queue is durable, writes it to disk (or, for a quorum queue, replicates it to a majority). Only *after* that does the broker send `basic.ack` with the message's sequence number, at which point I remove it from the unconfirmed map — *that* is the safe point. If instead I get a `basic.nack`, the broker could not accept it and I resend. If I get a return, it was unroutable and never reached a queue, so it is not delivered. If neither arrives before a timeout, I resend and rely on downstream idempotency. The crucial nuance is that a confirm is only as strong as the queue it landed in: confirmed into a single-node durable classic queue, the message survives that node *restarting* but not that node's disk being *lost* — for node-loss survival I need a quorum queue, and then the confirm arrives only after a majority has the message, trading some latency for real fault tolerance.

**Q: (Senior) A team reports intermittent message loss under load but "everything is durable". How do you investigate?**
A: "Everything is durable" almost always means they set *some* of the four defences, so I check each independently rather than trusting the summary. First, are messages actually persistent? A durable queue with `delivery_mode=1` messages loses everything on a restart, and under load a memory alarm can force the broker to page or a crash to occur — so I confirm `delivery_mode=2` on the publish path, not just `durable=true` on the queue. Second, are they using publisher confirms and actually *handling* nacks and timeouts? Under load the broker may nack (or apply flow control and stop acking) when memory/disk watermarks trip; if the publisher fires and forgets, or enables confirms but ignores the nack channel, those messages are lost precisely when load is high. A growing unconfirmed backlog or blocked connections in the management UI is the tell. Third, is the loss actually *unroutable* messages? Under a deploy, a routing key or binding change can leave a class of messages unroutable, and without mandatory/alternate-exchange they are dropped — the return rate metric shows this. Fourth, the consumer: auto-ack under load plus a crash or a slow handler that gets its connection closed will lose in-flight messages; I check `messages_unacknowledged` and redelivery rate. The investigative principle is that "durable" is a conjunction, and intermittent-under-load loss usually points at the load-sensitive links — flow control, nacks and memory alarms — that only bite when the broker is stressed, which is exactly when fire-and-forget and ignored-nack code fails silently.

**Q: (Senior) How do persistence and confirms interact with replication, and what threat does each actually defend against?**
A: They defend against different failures and it is a mistake to conflate them. Persistence (`delivery_mode=2`) plus a durable queue defends against a *broker restart or crash on a single node*: the message was written to that node's disk, so when the node comes back it recovers the message. A publisher confirm tells you that defence has completed — the broker has routed and, for a persistent message, persisted the message before acking. But neither protects against that single node's *disk being permanently lost* or the node never returning, because there is only one copy. Replication is the defence for *node loss*: a quorum queue (chapter 12) keeps the message on a majority of nodes via Raft, so losing one node loses no data. Crucially, replication changes the *meaning and timing* of the confirm: for a quorum queue the broker acks only after a majority of replicas have the message, so a confirm now guarantees the message survives a node loss, at the cost of higher latency (a network round-trip to the followers). So the layered picture is: confirms answer "did the broker take it?", persistence answers "will it survive a restart?", and replication answers "will it survive losing a node?" — and a serious durability design states which of those three threats it is buying protection against, rather than assuming `durable=true` covers all of them.

## 10. Quick Revision & Cheat Sheet

| Loss point | Defence | Setting |
|---|---|---|
| Publish never reaches broker | Publisher confirms | `confirm.select`, track + resend on nack/timeout |
| Broker crash before disk | Durable queue **and** persistent message | `durable=true` **and** `delivery_mode=2` |
| Unroutable, dropped | Mandatory + return listener (or alternate exchange) | `mandatory=true` + handle returns |
| Consumer crash before ack | Manual ack after processing | `autoAck=false`, `basic.ack` on success |

| Mechanism | Guarantee | Throughput |
|---|---|---|
| Fire-and-forget | none | highest |
| Publisher confirms (async) | broker has it (at-least-once) | high (pipelined) |
| AMQP transactions | broker has it + atomic batch | low (sync round-trip) |

**Flash cards**
- **What survives a broker restart?** → A *persistent* message in a *durable* queue — need BOTH.
- **What does a confirm mean?** → The broker routed and (if persistent) persisted the message; safe to forget.
- **What does mandatory do?** → Returns an unroutable message instead of silently dropping it.
- **Confirms vs transactions?** → Same "broker has it" guarantee; confirms pipeline, transactions block. Prefer confirms.
- **Do confirms give exactly-once?** → No — at-least-once; resends can duplicate, so consumers must be idempotent.
- **What does persistence NOT protect against?** → Losing the node's disk — that needs replication (quorum queues).

## 11. Hands-On Exercises & Mini Project

- [ ] Publish 1000 messages to a durable queue with `delivery_mode=1`, restart the broker, and confirm the queue comes back empty; repeat with `delivery_mode=2` and confirm they survive.
- [ ] Enable publisher confirms, publish in a loop, and log each `basic.ack`; then kill the broker mid-run and observe which messages stay unconfirmed.
- [ ] Publish with `mandatory=true` to an exchange with a deliberately wrong routing key and catch the returned messages in a return listener.
- [ ] Configure an alternate exchange and prove unroutable messages land in the catch-all queue.
- [ ] Compare throughput of (a) transactions per message, (b) synchronous wait-per-confirm, and (c) asynchronous confirms with a tracked unconfirmed set.
- [ ] Make the consumer auto-ack, crash it mid-processing, and observe message loss; switch to manual ack and observe redelivery.

### Mini Project — "Zero-Loss Publisher"

**Goal.** Build a publisher/consumer pair that provably loses nothing across broker restarts, unroutable keys, and consumer crashes.

**Requirements.**
1. Implement the async reliable publisher: confirms, `delivery_mode=2`, `mandatory=true`, a tracked unconfirmed set, and resend on nack/timeout.
2. Declare durable queues and register a return listener; add an alternate exchange as a second line of defence for unroutables.
3. Implement the consumer with manual ack after processing and idempotent handling keyed on `MessageId`.
4. Write a chaos harness that (a) restarts the broker mid-stream, (b) publishes some unroutable keys, and (c) kills the consumer mid-processing, and assert that every message is eventually processed exactly once in effect.
5. Instrument publish, confirm, return, deliver and ack rates and graph them to see the pipeline.

**Extensions.**
- Add memory/disk watermark pressure (fill the queue) and observe flow control blocking publishers; handle the blocked-connection notification gracefully.
- Move the queue to a quorum queue and measure how confirm latency changes when the broker acks only after a majority has the message.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Routing Patterns — Work Queues, Pub/Sub & RPC* (the topologies these defences protect), *Dead Letter Exchanges, TTL & Delayed Messages* (what to do with the failures manual acks surface), *Design: RabbitMQ Clustering, Quorum Queues & HA* (replication, the defence against node loss confirms cannot provide), *Delivery Guarantees* (why the end-to-end result is at-least-once), *Idempotency, Deduplication & the Outbox Pattern* (making at-least-once safe on the consumer).

- **RabbitMQ — Publisher Confirms and Consumer Acknowledgements** — RabbitMQ · *Intermediate* · the authoritative treatment of confirms, acks, and their reliability implications, with the async-confirm patterns used here. <https://www.rabbitmq.com/docs/confirms>
- **RabbitMQ — Reliability Guide** — RabbitMQ · *Intermediate* · the end-to-end checklist for not losing messages, mapping directly onto the four loss points. <https://www.rabbitmq.com/docs/reliability>
- **RabbitMQ — Publishers (mandatory, returns, persistence)** — RabbitMQ · *Intermediate* · publishing semantics including the mandatory flag, returns, and `delivery_mode`. <https://www.rabbitmq.com/docs/publishers>
- **RabbitMQ — Queues & Durability** — RabbitMQ · *Beginner* · what durable queues do and do not guarantee, and the queue-vs-message durability distinction. <https://www.rabbitmq.com/docs/queues>
- **RabbitMQ — Alternate Exchanges** — RabbitMQ · *Intermediate* · the server-side catch-all for unroutable messages, complementing the mandatory flag. <https://www.rabbitmq.com/docs/ae>
- **RabbitMQ — Memory and Disk Alarms (Flow Control)** — RabbitMQ · *Advanced* · why publishes block under pressure and how watermark alarms interact with confirms. <https://www.rabbitmq.com/docs/memory>
- **amqp091-go — Confirmations example** — RabbitMQ / Go · *Intermediate* · the maintained Go client's confirm/return APIs used in this chapter's code. <https://pkg.go.dev/github.com/rabbitmq/amqp091-go>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems framing of delivery guarantees and why durable messaging is a chain of independent properties. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 10.*
