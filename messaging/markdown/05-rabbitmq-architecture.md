# 05 · RabbitMQ Architecture: Broker, Connections & Channels

> **In one line:** RabbitMQ is an Erlang/OTP broker built to route millions of small messages reliably, and to talk to it well you need one truth in your bones — you open *one* long-lived TCP connection and multiplex many lightweight *channels* over it, one channel per goroutine, because the connection is the expensive socket and the channel is the cheap unit of concurrency.

---

## 1. Overview

RabbitMQ is the archetypal *smart broker*. Where Kafka is a dumb append-only log that pushes intelligence to the client, RabbitMQ puts the intelligence in the broker: it accepts messages, routes them through exchanges to queues by binding rules, applies per-message semantics, pushes them to consumers, and tracks acknowledgements. To use it well you have to understand three layered things — the *broker* itself and why it is written in Erlang, the *AMQP 0-9-1 object model* it exposes, and the *connection/channel* mechanics of how your client actually talks to it. This chapter is those three, in that order, because most RabbitMQ performance and reliability bugs trace back to getting the connection/channel model wrong.

Start with the broker. RabbitMQ is written in **Erlang** and runs on the **BEAM** virtual machine (the Erlang/OTP runtime), and that is not an incidental implementation detail — it is why RabbitMQ is good at what it does. A message broker's core job is to manage an enormous number of concurrent, mostly-idle, independent connections and route small messages between them with high reliability and quick failure recovery. That is *exactly* what Erlang/OTP was built for at Ericsson: massive concurrency via cheap lightweight processes, isolation so one crash does not take down its neighbours, supervision trees that restart failed components, and battle-tested distribution across nodes. A broker is, in a real sense, a telephone exchange for messages, and Erlang was designed to run telephone exchanges.

On top of the broker sits the **AMQP 0-9-1 protocol model**: producers publish to **exchanges**, exchanges route to **queues** via **bindings**, consumers read from queues, and everything lives inside a **virtual host** for isolation. Crucially, a client does not open a raw socket per operation. It opens *one* TCP **connection** to the broker and then opens many **channels** — lightweight, independent virtual connections — multiplexed over that single socket. The rule that follows, and that this chapter drives home, is **channel-per-thread, not connection-per-thread**: connections are relatively expensive (a TCP socket, a TLS handshake, heartbeats, an Erlang process on the broker), while channels are cheap, so you share one connection across your application and give each concurrent worker its own channel.

Get that model right and RabbitMQ is a joy — a fast, reliable, richly-routing broker. Get it wrong — a new connection per message, or one channel shared across goroutines — and you get socket exhaustion, broker overload, or subtle protocol corruption. This chapter builds the model from the broker up, with the real `amqp091-go` connection-and-channel setup you will actually write.

## 2. Core Concepts

- **Broker** — the RabbitMQ server process: accepts connections, hosts exchanges and queues, routes and delivers messages, tracks acknowledgements. Written in Erlang, runs on the BEAM VM.
- **Erlang / OTP / BEAM** — the language, framework and virtual machine RabbitMQ is built on; gives it cheap concurrency, process isolation, supervision and node clustering.
- **AMQP 0-9-1** — the wire protocol RabbitMQ speaks by default: a programmable model of exchanges, queues, bindings and messages, negotiated over a connection and its channels.
- **Connection** — one long-lived TCP (optionally TLS) connection between a client and the broker. Relatively expensive; you keep it open and reuse it.
- **Channel** — a lightweight virtual connection multiplexed over one TCP connection. Almost all operations (declare, publish, consume, ack) happen on a channel. Cheap; one per concurrent worker.
- **Virtual host (vhost)** — a namespace inside the broker isolating exchanges, queues, bindings and permissions; the unit of multi-tenancy.
- **Exchange** — where producers publish; routes messages to queues by type (direct/topic/fanout/headers) and bindings. (Depth in a later chapter.)
- **Queue** — an ordered buffer messages land in and consumers read from; the broker deletes a message once acked.
- **Binding** — a rule linking an exchange to a queue (with a routing key or arguments) that decides which messages reach which queue.
- **Heartbeat** — periodic frames that keep a connection alive and let both sides detect a dead peer (a hung TCP connection that never sends a FIN).

## 3. Theory & Principles

### Why Erlang suits a broker

It is worth understanding *why* RabbitMQ is written in Erlang, because the reasons explain its operational character. A broker must do four things extremely well, and Erlang/OTP was designed for all four:

- **Massive concurrency.** A broker holds tens or hundreds of thousands of connections and channels, most idle, a few busy. Erlang's *processes* are not OS threads — they are extremely lightweight (a few hundred bytes each), scheduled by the BEAM, so millions can coexist. RabbitMQ maps each connection, channel and queue to Erlang processes, which is why it handles huge connection counts that would exhaust an OS-thread-per-connection design.
- **Isolation.** Erlang processes share nothing — no shared memory, communication only by message passing. So one misbehaving connection or a crashing queue process cannot corrupt another's state. A broker routing between untrusting clients needs exactly this blast-radius containment.
- **Supervision and fault tolerance.** OTP's supervision trees restart failed processes to a known good state ("let it crash" — recover rather than defensively guard every line). A queue process that fails is restarted; the broker keeps running. This is why RabbitMQ has a reputation for staying up.
- **Distribution.** Erlang has built-in node-to-node distribution, which RabbitMQ uses for clustering — multiple broker nodes forming one logical broker, with queues (classic, quorum, or streams) living on nodes and metadata replicated across the cluster.

The practical upshot: RabbitMQ inherits Erlang's strengths (concurrency, resilience, clustering) and its characteristics (it is memory-sensitive — queues held in RAM trigger flow control and memory alarms; it prefers many small messages over few huge ones). When you reason about RabbitMQ's behaviour under load, you are really reasoning about a system of communicating Erlang processes.

### The AMQP 0-9-1 object model

AMQP 0-9-1 is a *programmable* protocol: unlike some protocols where the topology is fixed by an administrator, an AMQP client can declare exchanges, queues and bindings at runtime. The model has four moving parts, and getting their relationships right is the whole game:

1. **Producers publish to an exchange, never directly to a queue.** This indirection is the heart of the smart broker. The producer names an exchange and a *routing key*; it does not know or care which queues exist.
2. **Exchanges route to queues via bindings.** A binding connects an exchange to a queue with a routing key (or header arguments). The exchange *type* decides how the routing key is matched: direct = exact match, topic = wildcard match, fanout = ignore the key and copy to all bound queues, headers = match on message headers. (Full treatment in the exchanges chapter.)
3. **Queues hold messages and are read by consumers.** A queue is an ordered buffer. Consumers either subscribe (`basic.consume`, push) or poll (`basic.get`, pull, rarely used). The broker deletes a message once acknowledged.
4. **Everything lives in a virtual host.** Exchanges, queues, bindings and permissions are scoped to a vhost, which is the isolation boundary — different applications or tenants get different vhosts and cannot see each other's topology.

The reason producers publish to exchanges rather than queues is worth dwelling on: it *decouples* the producer from the consumer topology. The producer emits "something happened, with this routing key" and the broker's bindings decide where it goes. You can add a new consumer by binding a new queue to the exchange, with zero producer changes — the smart broker absorbs the routing so the endpoints stay dumb.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#ea580c"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One TCP connection, many channels &#8212; and the AMQP object model inside a vhost</text>

  <rect x="24" y="40" width="300" height="230" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="174" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">CLIENT (your app)</text>
  <rect x="44" y="76" width="120" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="104" y="93" text-anchor="middle" fill="#1e40af" font-size="9">goroutine 1</text>
  <rect x="44" y="108" width="120" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="104" y="125" text-anchor="middle" fill="#1e40af" font-size="9">goroutine 2</text>
  <rect x="44" y="140" width="120" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="104" y="157" text-anchor="middle" fill="#1e40af" font-size="9">goroutine 3</text>
  <rect x="196" y="76" width="108" height="26" rx="4" fill="#fff" stroke="#60a5fa"/><text x="250" y="93" text-anchor="middle" fill="#1e40af" font-size="9">channel 1</text>
  <rect x="196" y="108" width="108" height="26" rx="4" fill="#fff" stroke="#60a5fa"/><text x="250" y="125" text-anchor="middle" fill="#1e40af" font-size="9">channel 2</text>
  <rect x="196" y="140" width="108" height="26" rx="4" fill="#fff" stroke="#60a5fa"/><text x="250" y="157" text-anchor="middle" fill="#1e40af" font-size="9">channel 3</text>
  <path d="M164,89 L194,89" stroke="#2563eb" stroke-width="1.5" marker-end="url(#r2)"/>
  <path d="M164,121 L194,121" stroke="#2563eb" stroke-width="1.5" marker-end="url(#r2)"/>
  <path d="M164,153 L194,153" stroke="#2563eb" stroke-width="1.5" marker-end="url(#r2)"/>
  <text x="174" y="188" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">channel-per-goroutine</text>
  <text x="174" y="206" text-anchor="middle" fill="#1d4ed8" font-size="9">NOT connection-per-goroutine</text>
  <rect x="44" y="220" width="260" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="174" y="236" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">ONE TCP connection (multiplexed)</text>
  <text x="174" y="252" text-anchor="middle" fill="#1d4ed8" font-size="9">TLS handshake + heartbeats: pay once</text>

  <path d="M304,240 L360,240" stroke="#64748b" stroke-width="2.5" marker-end="url(#r2)"/>
  <text x="332" y="232" text-anchor="middle" fill="#475569" font-size="8">TCP</text>

  <rect x="360" y="40" width="496" height="230" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="608" y="62" text-anchor="middle" fill="#c2410c" font-size="12" font-weight="bold">BROKER (Erlang/OTP)  &#8212;  vhost "/app"</text>
  <rect x="380" y="80" width="70" height="30" rx="5" fill="#fff" stroke="#fdba74"/><text x="415" y="99" text-anchor="middle" fill="#c2410c" font-size="9">producer</text>
  <rect x="470" y="76" width="90" height="38" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="515" y="92" text-anchor="middle" fill="#c2410c" font-size="9">EXCHANGE</text><text x="515" y="106" text-anchor="middle" fill="#c2410c" font-size="8">(topic)</text>
  <path d="M450,95 L468,95" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r1)"/>
  <text x="426" y="74" fill="#c2410c" font-size="8">publish(key)</text>
  <rect x="600" y="76" width="110" height="24" rx="4" fill="#ffedd5" stroke="#ea580c"/><text x="655" y="92" text-anchor="middle" fill="#c2410c" font-size="9">queue: orders</text>
  <rect x="600" y="104" width="110" height="24" rx="4" fill="#ffedd5" stroke="#ea580c"/><text x="655" y="120" text-anchor="middle" fill="#c2410c" font-size="9">queue: audit</text>
  <path d="M560,90 L598,86" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r1)"/>
  <path d="M560,100 L598,114" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r1)"/>
  <text x="578" y="82" fill="#c2410c" font-size="7">binding</text>
  <rect x="740" y="76" width="100" height="24" rx="4" fill="#fff" stroke="#fdba74"/><text x="790" y="92" text-anchor="middle" fill="#c2410c" font-size="8">consumer (ack)</text>
  <path d="M710,88 L738,88" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r1)"/>
  <text x="380" y="150" fill="#c2410c" font-size="10" font-weight="bold">Smart broker: routing lives HERE.</text>
  <text x="380" y="170" fill="#9a3412" font-size="9">&#8226; producer publishes to EXCHANGE, never a queue</text>
  <text x="380" y="188" fill="#9a3412" font-size="9">&#8226; bindings decide which queues receive it</text>
  <text x="380" y="206" fill="#9a3412" font-size="9">&#8226; each connection/channel/queue = an Erlang process</text>
  <text x="380" y="224" fill="#9a3412" font-size="9">&#8226; vhost isolates topology + permissions</text>
  <text x="380" y="248" fill="#c2410c" font-size="9" font-weight="bold">Erlang: cheap processes, isolation, supervision, clustering</text>

  <rect x="24" y="284" width="832" height="176" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="306" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The protocol flow: how a client and broker actually converse</text>
  <g font-size="10">
    <text x="48" y="332" fill="#334155" font-weight="bold">1. connection.open</text><text x="230" y="332" fill="#475569">TCP + TLS handshake, AUTH (vhost + credentials), heartbeat negotiated &#8212; pay ONCE</text>
    <text x="48" y="356" fill="#334155" font-weight="bold">2. channel.open</text><text x="230" y="356" fill="#475569">a lightweight virtual connection over the socket &#8212; one per goroutine/thread</text>
    <text x="48" y="380" fill="#334155" font-weight="bold">3. queue.declare / exchange.declare / queue.bind</text><text x="470" y="380" fill="#475569">idempotently set up topology</text>
    <text x="48" y="404" fill="#334155" font-weight="bold">4. basic.publish</text><text x="230" y="404" fill="#475569">producer &#8594; exchange (routing key); broker routes to bound queues</text>
    <text x="48" y="428" fill="#334155" font-weight="bold">5. basic.consume &#8594; deliver &#8594; basic.ack</text><text x="380" y="428" fill="#475569">broker PUSHES; consumer acks; broker deletes the message</text>
    <text x="48" y="450" fill="#b91c1c" font-weight="bold">Heartbeats run underneath the whole time &#8594; detect a dead peer the TCP stack hasn't noticed.</text>
  </g>
</svg>
```

### Connections vs channels: the model that matters most

Here is the single most important operational fact about RabbitMQ clients. A **connection** is a TCP socket (optionally TLS) between your process and the broker. It is *expensive*: the TCP setup, the TLS handshake, the authentication round-trip, an Erlang process on the broker to manage it, and ongoing heartbeats. A **channel** is a *virtual connection* multiplexed over that one socket — the broker tags frames with a channel number and demultiplexes them. Channels are *cheap*: opening one is a lightweight protocol exchange, not a network handshake.

Almost every AMQP operation — declaring, publishing, consuming, acking — happens *on a channel*, not directly on the connection. So the design rule is:

- **One connection per application (or a small pool).** Open it once at startup, keep it alive, reuse it. Opening a connection per message or per request is a classic anti-pattern that exhausts sockets and hammers the broker with handshakes.
- **One channel per concurrent unit of work** — per thread in Java, per goroutine in Go. Channels are *not* thread-safe: a channel must not be used by two goroutines concurrently, because the protocol interleaves frames on that channel and concurrent use corrupts the stream. So the pattern is channel-per-goroutine: cheap, isolated, correct.

The tempting-but-wrong alternatives: connection-per-goroutine (wasteful — you pay the socket/TLS/heartbeat cost N times and can exhaust the broker's connection limit), or one-channel-shared-across-goroutines (broken — concurrent frames on one channel corrupt the protocol; you get baffling errors). The right answer is *share the connection, isolate the channel*, and it falls straight out of "connection is the expensive socket, channel is the cheap concurrency unit".

## 4. Architecture & Workflow

The connection lifecycle and the protocol flow, step by step, which is exactly what your client code performs:

1. **connection.open.** The client opens a TCP connection to the broker (default port 5672, or 5671 for TLS). Over it, AMQP negotiates: protocol version, authentication (SASL — typically PLAIN with username/password), the target *virtual host*, a maximum channel count, a maximum frame size, and a *heartbeat* interval. This is the expensive part — do it once.
2. **channel.open.** The client opens one or more channels over the connection. Each channel is an independent conversation: operations on channel 1 do not block or interfere with channel 2. Give each goroutine its own.
3. **Declare topology.** On a channel, the client idempotently declares what it needs: `exchange.declare`, `queue.declare`, `queue.bind`. Declaring is idempotent — declaring an existing entity with the same parameters is a no-op, so clients can safely declare on startup without coordinating. (Declaring with *different* parameters errors — a common gotcha.)
4. **basic.publish.** A producer publishes a message to an exchange with a routing key, optionally with properties (persistence via `delivery_mode=2`, priority, per-message TTL, reply-to). The broker routes it through bindings to zero or more queues.
5. **basic.consume → deliver → basic.ack.** A consumer subscribes to a queue with `basic.consume`; the broker *pushes* messages to it (respecting the channel's prefetch/`basic.qos`); the consumer processes and sends `basic.ack`, and the broker deletes the message. On failure, `basic.nack`/`basic.reject` requeues or dead-letters.
6. **Heartbeats, throughout.** Underneath everything, heartbeat frames flow both ways at the negotiated interval (default 60s). Their job is to detect a peer that has died *without* cleanly closing the TCP connection — a hung process, a yanked network cable, a firewall silently dropping the connection. Without heartbeats, such a "half-open" connection can linger for a very long time (the OS TCP keepalive default is often two hours), leaving the broker holding resources for a client that is gone and the client believing it is still connected. If two heartbeat intervals pass with no frame, the peer is declared dead and the connection is torn down.

The contrast with Kafka is instructive and worth naming. Kafka's protocol is likewise over persistent TCP connections, but Kafka has *no* exchange/binding routing layer — a producer sends to a topic-partition, the broker appends, and that is the model. RabbitMQ's connection carries a whole programmable routing topology (exchanges, bindings, per-message properties) that the *broker* evaluates; Kafka's carries appends and fetches that the *client* orchestrates. The channel abstraction is RabbitMQ's answer to "how do I do many independent things over one socket"; Kafka solves concurrency differently (one connection per broker, requests multiplexed by correlation id, partitions as the parallelism unit). The connection/channel model is distinctively RabbitMQ's, and it is a direct expression of the smart-broker design.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="t1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="t2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0891b2"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The protocol conversation over time: pay for the connection ONCE, work on channels</text>

  <line x1="120" y1="50" x2="120" y2="352" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="120" y="44" text-anchor="middle" fill="#475569" font-size="10" font-weight="bold">CLIENT</text>
  <line x1="760" y1="50" x2="760" y2="352" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="760" y="44" text-anchor="middle" fill="#475569" font-size="10" font-weight="bold">BROKER (Erlang)</text>

  <rect x="24" y="60" width="832" height="66" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="1.5"/>
  <text x="40" y="80" fill="#1e40af" font-size="10" font-weight="bold">1. connection.open  (EXPENSIVE &#8212; do it once)</text>
  <path d="M124,96 L756,96" stroke="#2563eb" stroke-width="1.5" marker-end="url(#t1)"/>
  <text x="440" y="90" text-anchor="middle" fill="#1e40af" font-size="9">TCP + TLS handshake, SASL auth, vhost, heartbeat + frame-max negotiated</text>
  <path d="M756,112 L124,112" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#t1)"/>
  <text x="440" y="124" text-anchor="middle" fill="#1e40af" font-size="9">connection.open-ok &#8594; one Erlang process now manages this connection</text>

  <rect x="24" y="134" width="832" height="46" rx="8" fill="#cffafe" stroke="#0891b2" stroke-width="1.5"/>
  <text x="40" y="153" fill="#155e75" font-size="10" font-weight="bold">2. channel.open  (CHEAP &#8212; one per goroutine)</text>
  <path d="M124,168 L756,168" stroke="#0891b2" stroke-width="1.5" marker-end="url(#t2)"/>
  <text x="440" y="162" text-anchor="middle" fill="#155e75" font-size="9">channel 1, channel 2, channel 3&#8230; multiplexed over the SAME socket, each isolated</text>

  <rect x="24" y="188" width="832" height="70" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="40" y="208" fill="#c2410c" font-size="10" font-weight="bold">3. declare + bind, then publish / consume  (on a channel)</text>
  <path d="M124,224 L756,224" stroke="#ea580c" stroke-width="1.5" marker-end="url(#t1)"/>
  <text x="440" y="218" text-anchor="middle" fill="#c2410c" font-size="9">exchange.declare &#183; queue.declare &#183; queue.bind &#183; basic.publish(exchange, key) &#183; basic.consume</text>
  <path d="M756,242 L124,242" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#t1)"/>
  <text x="440" y="254" text-anchor="middle" fill="#c2410c" font-size="9">broker routes via bindings, PUSHES deliveries (bounded by prefetch), receives basic.ack &#8594; deletes</text>

  <rect x="24" y="266" width="832" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="40" y="286" fill="#15803d" font-size="10" font-weight="bold">underneath, the WHOLE time: heartbeats both ways</text>
  <path d="M124,300 L400,300" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="2 3" marker-end="url(#t2)"/>
  <path d="M756,300 L480,300" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="2 3" marker-end="url(#t2)"/>
  <text x="440" y="296" text-anchor="middle" fill="#15803d" font-size="8">&#9829; every ~interval</text>
  <text x="440" y="314" text-anchor="middle" fill="#15803d" font-size="9">2 missed intervals &#8594; peer declared DEAD &#8594; connection torn down (reclaim resources)</text>

  <rect x="24" y="326" width="832" height="40" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="1.5"/>
  <text x="440" y="351" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Rule in one line: share the ONE expensive connection; give each goroutine its OWN cheap channel.</text>
</svg>
```

## 5. Implementation

The real thing: connecting, opening a channel, declaring topology, publishing and consuming with `github.com/rabbitmq/amqp091-go`. Every comment explains *why*, and the code embodies the connection/channel rules from section 3.

```go
package rmq

import (
	"context"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Connect opens the ONE long-lived connection the whole application shares.
// This is the expensive object: a TCP socket, TLS handshake, auth, heartbeats,
// and an Erlang process on the broker. Open it once at startup and reuse it —
// never per-request, never per-message.
func Connect(url string) (*amqp.Connection, error) {
	// amqp.DialConfig lets us set the heartbeat and a dial timeout explicitly.
	// Heartbeat=10s: the broker and client exchange heartbeat frames every 10s,
	// so a DEAD peer (crashed process, yanked cable) is detected within ~2
	// intervals instead of waiting for the OS TCP keepalive (often ~2 hours).
	conn, err := amqp.DialConfig(url, amqp.Config{
		Heartbeat: 10 * time.Second,
		Locale:    "en_US",
		Dial:      amqp.DefaultDial(5 * time.Second), // TCP connect timeout
		// Vhost is taken from the URL path, e.g. amqp://user:pass@host:5672/app
		// -> vhost "app". The vhost isolates this app's exchanges/queues/perms.
	})
	if err != nil {
		return nil, fmt.Errorf("dial rabbitmq: %w", err)
	}
	return conn, nil
}

// Publisher owns ONE channel. A channel is NOT thread-safe, so each goroutine
// that publishes must have its OWN channel (channel-per-goroutine). Channels
// are cheap — opening one is a light protocol exchange, not a TCP handshake.
type Publisher struct {
	ch       *amqp.Channel
	exchange string
	confirms chan amqp.Confirmation
}

// NewPublisher opens a channel on the SHARED connection and declares topology.
func NewPublisher(conn *amqp.Connection, exchange string) (*Publisher, error) {
	ch, err := conn.Channel() // channel.open over the existing connection
	if err != nil {
		return nil, fmt.Errorf("open channel: %w", err)
	}

	// Declare a durable TOPIC exchange. Producers publish HERE, never to a queue
	// directly — the broker's bindings decide which queues receive the message.
	// durable=true: the exchange survives a broker restart. Declaring is
	// idempotent, so calling this on every startup is safe.
	if err := ch.ExchangeDeclare(
		exchange, "topic",
		true,  // durable
		false, // auto-delete
		false, // internal
		false, // no-wait
		nil,   // args
	); err != nil {
		return nil, fmt.Errorf("declare exchange: %w", err)
	}

	// Put the channel into confirm mode: the broker will ACK each publish, so we
	// know it accepted (and routed) the message. This is how you avoid silently
	// losing a publish — the producer-side of at-least-once (chapter 4).
	if err := ch.Confirm(false); err != nil {
		return nil, fmt.Errorf("enable confirms: %w", err)
	}

	return &Publisher{
		ch:       ch,
		exchange: exchange,
		confirms: ch.NotifyPublish(make(chan amqp.Confirmation, 1)),
	}, nil
}

// Publish sends a message to the exchange with a routing key and waits for the
// broker's confirm. The routing key + the exchange's bindings decide the queues.
func (p *Publisher) Publish(ctx context.Context, routingKey string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := p.ch.PublishWithContext(ctx,
		p.exchange, // exchange (smart broker routes from here)
		routingKey, // e.g. "order.eu.placed" — matched by bindings
		true,       // mandatory: if it routes to NO queue, the broker RETURNS it
		false,      // immediate (deprecated) — must be false
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent, // delivery_mode=2: persist if the queue is durable
			MessageId:    routingKey,       // a stable id helps idempotent consumers (chapter 4)
			Timestamp:    time.Now(),
			Body:         body,
		},
	); err != nil {
		return fmt.Errorf("publish: %w", err)
	}

	// Block on the confirm. If it comes back Ack=false, the broker did NOT accept
	// the message and we should retry/alert rather than assume success.
	select {
	case c := <-p.confirms:
		if !c.Ack {
			return fmt.Errorf("publish nacked by broker")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Consumer also owns its OWN channel — one per consuming goroutine.
type Consumer struct {
	ch    *amqp.Channel
	queue string
}

// NewConsumer opens a channel, declares+binds the queue, and sets prefetch.
func NewConsumer(conn *amqp.Connection, exchange, queue, bindingKey string) (*Consumer, error) {
	ch, err := conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("open channel: %w", err)
	}

	// Declare a durable queue (survives broker restart). The queue is where
	// messages actually rest and where the consumer reads from.
	if _, err := ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
		return nil, fmt.Errorf("declare queue: %w", err)
	}

	// BIND the queue to the exchange with a routing pattern. THIS is the routing
	// rule — the smart broker uses it to decide the queue receives "order.eu.*".
	if err := ch.QueueBind(queue, bindingKey, exchange, false, nil); err != nil {
		return nil, fmt.Errorf("bind queue: %w", err)
	}

	// Prefetch (basic.qos): at most 20 UNACKED messages delivered to this
	// consumer at once. This is flow control — without it the broker floods a
	// fast pusher into a slow consumer. prefetchCount=20, global=false (per-channel).
	if err := ch.Qos(20, 0, false); err != nil {
		return nil, fmt.Errorf("set qos: %w", err)
	}

	return &Consumer{ch: ch, queue: queue}, nil
}

// Consume subscribes and processes with manual ack (at-least-once, chapter 4).
func (c *Consumer) Consume(handle func([]byte) error) error {
	// autoAck=false: we ack manually AFTER processing, so a crash mid-handler
	// causes redelivery rather than loss.
	deliveries, err := c.ch.Consume(c.queue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}
	go func() {
		for d := range deliveries {
			if err := handle(d.Body); err != nil {
				// Reject and requeue THIS message only; in production cap retries
				// then dead-letter (chapter 11). requeue=true.
				_ = d.Nack(false, true)
				continue
			}
			_ = d.Ack(false) // success -> broker deletes the message
		}
	}()
	return nil
}
```

A couple of CLI touches you will use constantly. Inspect connections and channels with `rabbitmqctl`, and manage topology with `rabbitmqadmin`:

```bash
# See every connection and how many channels each has multiplexed over it.
# A healthy app shows FEW connections with MANY channels — not the reverse.
rabbitmqctl list_connections name user vhost channels state

# List channels with their unacked counts and prefetch — spot a channel that
# has taken messages but isn't acking (a stuck consumer).
rabbitmqctl list_channels connection number prefetch_count messages_unacknowledged

# List virtual hosts (the isolation boundary) and queues within one.
rabbitmqctl list_vhosts
rabbitmqctl list_queues -p /app name messages consumers memory

# Declare topology from the CLI (rabbitmqadmin, over the HTTP management API).
rabbitmqadmin declare exchange name=orders type=topic durable=true
rabbitmqadmin declare queue name=eu-orders durable=true
rabbitmqadmin declare binding source=orders destination=eu-orders routing_key="order.eu.*"
```

The code embodies the whole chapter: `Connect` builds the *one* expensive connection with an explicit heartbeat; `NewPublisher` and `NewConsumer` each open their *own cheap channel*; publishing goes to an *exchange*, consuming reads from a *queue* reached by a *binding*; and `rabbitmqctl list_connections` lets you *verify* the few-connections-many-channels shape in production.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Smart-broker routing.** Exchanges and bindings put routing in the broker, so producers and consumers stay simple and the topology evolves without producer changes.
- **Erlang/OTP foundation.** Cheap processes, isolation, supervision and clustering give high concurrency and strong resilience out of the box.
- **Efficient multiplexing.** One TCP connection carries many channels, so an application does massive concurrent work over a single socket, sparing sockets and handshakes.
- **Isolation via vhosts.** Multi-tenancy and environment separation are first-class — one broker, many isolated namespaces.
- **Rich per-message control.** Persistence, priority, per-message TTL, dead-lettering and confirms are all available at the protocol level.

**Disadvantages**
- **Channel thread-safety footguns.** Channels are not thread-safe; sharing one across goroutines corrupts the protocol, a common and confusing bug.
- **Connection/channel bookkeeping.** You must manage connection recovery, channel lifecycle and re-declaration after reconnects yourself (or via a helper library).
- **Memory sensitivity.** Queues held in RAM mean a backlog can trigger memory alarms and flow control; RabbitMQ is happiest with messages flowing, not piling up.
- **Erlang operational unfamiliarity.** Debugging deep broker issues means understanding BEAM behaviour, which many teams find unfamiliar.

**Trade-offs**
- *One connection vs a pool:* a single connection is simplest and usually fine, but all channels share its throughput and its fate; a small pool spreads load and isolates failures at the cost of more sockets. Size to your concurrency, not to your message rate.
- *Channel-per-goroutine vs channel reuse:* a channel per goroutine is correct and isolated but each channel is a little broker state; extremely high goroutine counts may want a bounded channel pool with careful non-concurrent use.
- *Heartbeat interval:* short heartbeats detect dead peers fast but add traffic and can false-positive on a busy/paused process; long heartbeats are lean but leave dead connections lingering. Tune to your network and pause behaviour.
- *Smart broker vs dumb log:* RabbitMQ's broker-side routing is ergonomic and flexible but the broker does more work per message than Kafka's append-only log, which is part of why peak throughput is lower (chapter 3).

## 7. Common Mistakes & Best Practices

- **Opening a connection per message or per request.** The classic killer: you pay the TCP/TLS/auth/heartbeat cost every time and exhaust sockets and the broker's connection limit. Open one connection at startup and reuse it.
- **Sharing one channel across goroutines.** Channels are not thread-safe; concurrent frames on one channel corrupt the protocol and produce baffling errors. One channel per goroutine.
- **Publishing directly expecting a queue.** There is no publishing to a queue in AMQP — you publish to an *exchange*, and a binding routes to the queue. Forgetting this (or using the default exchange without understanding it) causes messages to vanish.
- **No publisher confirms.** Fire-and-forget publishing silently loses messages the broker never accepted. Enable confirm mode and check the confirm for durable work.
- **Ignoring heartbeats / no reconnect logic.** Assuming a connection stays up forever; when it drops (deploy, network blip), the app must detect it (heartbeats help) and re-establish the connection, channels, and topology. Handle `NotifyClose` and reconnect.
- **Declaring with mismatched parameters.** Re-declaring an existing exchange/queue with *different* durability or arguments errors and closes the channel. Keep declarations consistent everywhere, or declare once via infrastructure.
- **Best practice: one shared connection, a channel per worker, confirms on, prefetch set, and automatic recovery.** This single sentence is the whole operational discipline: share the expensive socket, isolate the cheap channel, confirm your publishes, bound your in-flight messages, and rebuild topology on reconnect.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The first diagnostic is always `rabbitmqctl list_connections` and `list_channels`: a healthy application shows *few connections with many channels*; if you see thousands of connections, someone is opening one per request. A stuck consumer shows as high `messages_unacknowledged` on its channel — it took messages but never acked (a crashed handler, a lost ack, or a prefetch set too high with slow processing). The management UI's connection and channel views make both patterns visible at a glance.
- **Monitoring.** Watch **queue depth** (`messages`), **unacked count**, **publish/deliver/ack rates**, **consumer count** per queue, and the broker's **memory and disk alarms** — because when memory crosses the high-watermark the broker applies flow control and *blocks publishers*, which surfaces as mysteriously slow producers. Also watch **connection and channel churn**: a rising open/close rate is the signature of the connection-per-request anti-pattern. Prometheus via the `rabbitmq_prometheus` plugin exposes all of this.
- **Security.** Authenticate with real credentials (SASL PLAIN over **TLS** — use port 5671, never plaintext credentials over 5672 in production). Scope applications to **virtual hosts** and grant least-privilege **permissions** (configure/write/read regex per vhost), so a compromised app cannot touch another's topology. The vhost is your primary isolation boundary; use one per application or tenant. Rotate credentials and prefer per-service users over a shared admin account.
- **Scaling.** Scale *consumers* by adding competing consumers on a queue (each with its own channel), bounded by prefetch for fairness. Scale the *broker* by **clustering** multiple Erlang nodes into one logical broker, using **quorum queues** (Raft-based replication) for HA rather than the deprecated classic mirrored queues, and **Streams** for high-throughput replayable workloads (chapter 12). Beware the single-hot-queue bottleneck: a queue lives on one node, so a very hot queue is a scaling limit addressed by sharding the workload across multiple queues. Connections and channels scale cheaply because they map to lightweight Erlang processes, but the broker's memory is the ceiling — keep messages flowing, not piling up.

## 9. Interview Questions

**Q: What is the difference between a connection and a channel in RabbitMQ?**
A: A connection is a single TCP (optionally TLS) connection between the client and the broker — an expensive object involving the socket, a TLS handshake, authentication, heartbeats, and an Erlang process on the broker. A channel is a lightweight virtual connection multiplexed over that one TCP connection; the broker tags frames with a channel number and demultiplexes them. Almost every operation — declaring, publishing, consuming, acking — happens on a channel. Because connections are expensive and channels are cheap, the rule is to share one connection across the application and open a channel per concurrent worker.

**Q: Why "channel-per-thread, not connection-per-thread"?**
A: Because connections are expensive and channels are cheap, so you want to pay the connection cost once and get concurrency from channels. Opening a connection per thread means paying the TCP setup, TLS handshake, authentication and heartbeat cost N times and risking exhaustion of sockets and the broker's connection limit. A channel, by contrast, is a light protocol exchange over the existing socket. The catch is that channels are not thread-safe — a channel must be used by only one thread or goroutine at a time, because the protocol interleaves frames on a channel and concurrent use corrupts the stream. So the correct pattern is one shared connection plus one channel per concurrent worker: cheap, isolated, and correct.

**Q: Why is RabbitMQ written in Erlang?**
A: Because a broker's core job — managing an enormous number of concurrent, mostly-idle connections and routing small messages reliably with quick failure recovery — is exactly what Erlang/OTP was built for at Ericsson to run telephone exchanges. Erlang gives extremely lightweight processes so hundreds of thousands of connections, channels and queues can each be their own process; share-nothing isolation so one crash cannot corrupt its neighbours; OTP supervision trees that restart failed components to a known good state; and built-in node-to-node distribution that RabbitMQ uses for clustering. Those four properties — massive concurrency, isolation, supervision, and distribution — are precisely a broker's requirements, which is why the language choice is fundamental rather than incidental.

**Q: Do producers publish to queues in RabbitMQ?**
A: No — and this is the heart of the smart-broker model. Producers publish to an *exchange* with a routing key; they never address a queue directly. The exchange, using its type (direct, topic, fanout, headers) and its bindings, decides which queue or queues the message lands in. This indirection decouples the producer from the consumer topology: the producer just emits "this happened, with this routing key", and you can add a new consumer by binding a new queue to the exchange without changing the producer at all. The one apparent exception — publishing with a queue name as the routing key — actually uses the default (nameless) direct exchange, so even then you are publishing to an exchange.

**Q: What is a virtual host and what is it for?**
A: A virtual host, or vhost, is a namespace inside a single broker that isolates a set of exchanges, queues, bindings and permissions. It is RabbitMQ's unit of multi-tenancy and environment separation: different applications or tenants get different vhosts and cannot see or touch each other's topology, and permissions are granted per vhost. You select a vhost when you open a connection. It lets one physical broker safely serve many independent applications, which is why per-application or per-tenant vhosts with least-privilege permissions are the standard isolation practice.

**Q: What do heartbeats do?**
A: Heartbeats are periodic frames exchanged in both directions on a connection at a negotiated interval, whose job is to detect a peer that has died *without* cleanly closing the TCP connection — a crashed process, a yanked cable, or a firewall silently dropping the link. Without them, such a half-open connection can linger for a very long time, since the OS TCP keepalive default is often around two hours, leaving the broker holding resources for a client that is gone. If roughly two heartbeat intervals pass with no frame at all, the peer is declared dead and the connection is torn down, so resources are reclaimed promptly and the client learns it must reconnect.

**Q: (Senior) A service under load opens thousands of RabbitMQ connections and the broker is struggling. Diagnose and fix.**
A: The symptom — thousands of connections — is almost always the connection-per-request or connection-per-message anti-pattern, and I would confirm it with `rabbitmqctl list_connections` (and the connection churn rate in the management UI): a healthy service shows a handful of connections each multiplexing many channels, so thousands of connections means someone is opening a fresh connection for each unit of work and paying the TCP, TLS, auth and heartbeat cost every time, while exhausting sockets and the broker's per-node connection limit and burning broker memory on all those Erlang connection processes. The fix is to restructure the client to the correct model: open one long-lived connection (or a small fixed pool) at startup and reuse it for the whole application's lifetime, and get concurrency from channels — one channel per goroutine or worker, since channels are cheap and are the real unit of concurrent work. I would add automatic recovery so a dropped connection is re-established along with its channels and topology, set a sensible heartbeat so dead connections are reclaimed, and verify after the change that `list_connections` shows few connections with many channels and that connection churn has gone to near zero. If the concurrency is genuinely enormous, a bounded channel pool with strictly non-concurrent per-channel use is the refinement, but the core error is confusing the expensive connection for the cheap channel.

**Q: (Senior) How does RabbitMQ's connection/channel model contrast with Kafka's client model, and why do they differ?**
A: They differ because the two systems put the intelligence in opposite places. RabbitMQ is a smart broker, so its protocol carries a whole programmable routing topology — exchanges, bindings, per-message properties like persistence, priority and TTL — that the *broker* evaluates, and the channel abstraction exists to let a client run many independent such conversations (declare, publish, consume, ack) concurrently over a single expensive TCP socket, with channels as cheap, isolated, non-thread-safe virtual connections. Kafka is a dumb broker, so its protocol carries appends and fetches that the *client* orchestrates; there is no exchange/binding layer, concurrency comes from partitions rather than channels, a client typically holds one connection per broker and multiplexes requests over it by correlation id, and the consumer, not the broker, tracks position via offsets. So RabbitMQ's channel-per-worker-over-one-connection is a direct expression of the smart-broker design — many routing conversations multiplexed over one socket — while Kafka's partition-based parallelism and client-tracked offsets express the dumb-broker, smart-consumer design. Both multiplex over persistent TCP, but RabbitMQ multiplexes *routing conversations* (channels) and Kafka multiplexes *requests to append and fetch from a log*, which is the connection/channel model versus the partition/offset model in a nutshell.

**Q: (Senior) Why are channels not thread-safe, and what goes wrong if you ignore that?**
A: Channels are not thread-safe because the AMQP protocol multiplexes by interleaving frames tagged with a channel number over the single TCP connection, and a channel represents one ordered conversation — a sequence of method frames, content headers and body frames that must arrive in a coherent order. If two threads or goroutines use the same channel concurrently, their frames interleave on the wire in a way the protocol does not expect: a publish's header and body frames can be split by another operation's frames, or two operations' responses can be confused, corrupting the channel's state. In practice this shows up as seemingly random errors — unexpected frame errors, the broker closing the channel, messages published to the wrong place, or acks applied to the wrong delivery — bugs that are maddening precisely because they are timing-dependent and non-reproducible. The correct model avoids the whole class of problem: give each concurrent worker its own channel, which is cheap because a channel is just a light virtual connection over the shared socket, so you get true isolation without paying for extra connections. If you genuinely must share a channel, you have to serialise all access to it with a lock, but that throws away the concurrency you wanted, so channel-per-goroutine is almost always the right answer.

**Q: What is prefetch (basic.qos) and why does it matter?**
A: Prefetch, set via `basic.qos`, is the limit on how many *unacknowledged* messages the broker will push to a consumer (or channel) at once before it must receive an ack for one before delivering the next. It matters because RabbitMQ is a push-based smart broker: by default it will happily fire messages at a consumer as fast as it can, so a fast broker pushing into a slow consumer floods that consumer's memory with messages it has taken but not yet processed, and — because the broker is holding those as unacked — grows broker-side state too. Setting a sensible prefetch (say 10-50 for typical work, lower for slow/heavy handlers) bounds the in-flight window, which does two things: it applies backpressure so a slow consumer naturally pulls work at its own rate, and it improves fairness across competing consumers, because without a limit one consumer can greedily grab a huge batch while others sit idle. A prefetch that is too high reintroduces the flooding and unfairness; one that is too low underutilises the consumer by starving it between acks. So prefetch is RabbitMQ's per-consumer flow-control knob, and getting it right is central to a healthy consume path, which is why the consumer code sets it before subscribing.

## 10. Quick Revision & Cheat Sheet

| Concept | What it is | Cost / rule |
|---|---|---|
| **Broker** | Erlang/OTP server that routes and delivers | Concurrency, isolation, supervision, clustering |
| **Connection** | One TCP (TLS) link to the broker | Expensive; one per app, reuse it |
| **Channel** | Virtual connection over the socket | Cheap; one per goroutine; NOT thread-safe |
| **Vhost** | Namespace isolating topology + perms | The multi-tenancy boundary |
| **Exchange** | Where producers publish | direct / topic / fanout / headers |
| **Binding** | Exchange → queue routing rule | Decides which queue receives a message |
| **Queue** | Buffer consumers read from | Message deleted on ack |
| **Heartbeat** | Keep-alive / dead-peer detection | ~2 missed intervals → connection torn down |

| Protocol flow | Purpose |
|---|---|
| connection.open | TCP + TLS + auth + vhost + heartbeat negotiate (pay once) |
| channel.open | lightweight virtual connection (per worker) |
| exchange/queue.declare, queue.bind | idempotently set up topology |
| basic.publish | producer → exchange (routing key) |
| basic.consume → deliver → basic.ack | broker pushes; consumer acks; broker deletes |

**Flash cards**
- **Connection vs channel?** → Connection = expensive TCP socket (share it); channel = cheap virtual connection (one per goroutine).
- **The golden rule?** → Channel-per-thread, not connection-per-thread; channels are not thread-safe.
- **Why Erlang?** → Cheap processes, isolation, supervision, clustering — a broker is a telephone exchange.
- **Do producers publish to queues?** → No — to an exchange; bindings route to queues.
- **What is a vhost?** → A namespace isolating exchanges/queues/permissions — the tenancy boundary.
- **What do heartbeats catch?** → A dead peer that never closed the TCP connection cleanly.

## 11. Hands-On Exercises & Mini Project

- [ ] Open one connection and three channels in `amqp091-go`; verify with `rabbitmqctl list_connections` and `list_channels` that you see one connection multiplexing three channels.
- [ ] Deliberately share one channel across two goroutines publishing concurrently and observe the protocol errors; then fix it with channel-per-goroutine.
- [ ] Declare a topic exchange, bind two queues with different patterns, and confirm a published message routes by the binding, not by any queue name.
- [ ] Set a 5-second heartbeat, pause the client process (SIGSTOP) past two intervals, and watch the broker tear the connection down.
- [ ] Create two vhosts, put the same-named queue in each, and confirm they are fully isolated (a consumer in one never sees the other's messages).
- [ ] Enable publisher confirms and demonstrate that a publish to a non-existent-routing (with `mandatory=true`) is returned rather than silently dropped.

### Mini Project — "A Correct RabbitMQ Client"

**Goal.** Build a small, production-shaped RabbitMQ client library that embodies the connection/channel discipline, so the architecture is not just understood but enforced in code.

**Requirements.**
1. A shared connection manager: one connection (or a small fixed pool) opened at startup with an explicit heartbeat and a dial timeout, exposing a method to open channels.
2. Publisher and Consumer types that each own their own channel, declare topology idempotently (durable exchange, durable queue, binding), and never share a channel across goroutines.
3. Publisher confirms on the publish path and manual ack with prefetch on the consume path (at-least-once, chapter 4).
4. Automatic recovery: subscribe to `NotifyClose`, and on a dropped connection, re-establish the connection, re-open channels, and re-declare topology.
5. A `rabbitmqctl`-based verification script proving the running app shows few connections with many channels, and near-zero connection churn under load.

**Extensions.**
- Add a bounded channel pool for a high-goroutine-count workload with strictly non-concurrent per-channel use, and measure the trade-off against channel-per-goroutine.
- Run the same client against two vhosts with least-privilege permissions and demonstrate that a credential scoped to one vhost cannot declare or consume in the other.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Kafka vs RabbitMQ* (why the smart broker exists and when to pick it), *RabbitMQ Exchanges, Bindings & Routing* (the routing layer this chapter introduces), *Delivery Guarantees* (the ack/confirm mechanics used here), *RabbitMQ Reliability: Confirms, Durability & Quorum Queues* (making the broker not lose messages), *Messaging Models: Queues vs Pub/Sub vs the Log* (the primitives RabbitMQ composes).

- **RabbitMQ — AMQP 0-9-1 Model Explained** — RabbitMQ · *Beginner* · the authoritative description of connections, channels, exchanges, queues and bindings; the foundation for this chapter. <https://www.rabbitmq.com/tutorials/amqp-concepts>
- **RabbitMQ — Connections** — RabbitMQ · *Intermediate* · connection lifecycle, heartbeats, TLS and recovery from the source. <https://www.rabbitmq.com/docs/connections>
- **RabbitMQ — Channels** — RabbitMQ · *Intermediate* · why channels exist, their lifecycle, and the thread-safety rules that make channel-per-worker mandatory. <https://www.rabbitmq.com/docs/channels>
- **RabbitMQ — Virtual Hosts** — RabbitMQ · *Intermediate* · the isolation boundary and how permissions are scoped to a vhost. <https://www.rabbitmq.com/docs/vhosts>
- **amqp091-go** — RabbitMQ (Go client) · *Intermediate* · the maintained Go client used in this chapter, with connection, channel, publish and consume examples. <https://github.com/rabbitmq/amqp091-go>
- **Programming Erlang / "Let it crash"** — Joe Armstrong · *Advanced* · why Erlang/OTP's concurrency, isolation and supervision suit a broker; the philosophy behind RabbitMQ's resilience. <https://pragprog.com/titles/jaerlang2/programming-erlang-2nd-edition/>
- **RabbitMQ — Production Checklist** — RabbitMQ · *Intermediate* · connection/channel counts, heartbeats, memory alarms and the operational settings this chapter's advice maps onto. <https://www.rabbitmq.com/docs/production-checklist>
- **RabbitMQ in Depth** — Gavin M. Roy (Manning) · *Intermediate* · a thorough treatment of the AMQP model, connections and channels, and broker internals. <https://www.manning.com/books/rabbitmq-in-depth>

---

*Kafka & RabbitMQ Handbook — chapter 05.*
