# 12 · Design: RabbitMQ Clustering, Quorum Queues & HA

> **In one line:** A RabbitMQ cluster shares metadata but puts each queue on a single node by default, so a queue is a single point of failure until you replicate it — and the modern answer is *quorum queues*, Raft-replicated queues that fixed the split-brain and data-loss hazards that got classic mirrored queues deprecated, with *streams* as the replicated log for when you need high throughput and replay.

---

## 1. Overview

A single RabbitMQ node is a single point of failure, so production runs a **cluster** — several nodes that share connections, exchanges, bindings and users, and present as one logical broker. But clustering alone does *not* make your queues highly available, and this is the trap that catches teams. By default a **queue lives on exactly one node**, the node where it was declared — the "queue leader" — and only its *metadata* (that the queue exists) is shared across the cluster. If that node dies, the queue and its messages are unavailable until the node returns, even though the rest of the cluster is healthy. Clustering gives you a shared control plane and horizontal capacity across many queues; it does not, by itself, give you a queue that survives losing its node.

To make a *specific* queue survive node loss you must **replicate** it, and RabbitMQ's history here is the crux of the chapter. The old mechanism, **classic mirrored queues**, replicated a queue to mirror nodes — but it was subtly broken in ways that bit people in production: unbounded synchronisation that could stall a cluster, susceptibility to split-brain during network partitions, and the possibility of *silent data loss* on leader promotion. Mirrored queues are now **deprecated and removed** in current RabbitMQ. Their replacement is **quorum queues**: queues replicated with the **Raft** consensus protocol, where a leader and its followers agree by *majority quorum*, giving well-defined, provably safe behaviour under failure — no split-brain, no silent loss on promotion — at the cost of needing a majority of replicas available to accept writes. Quorum queues are the modern default for any queue that must be highly available.

For a different shape of workload — very high throughput, and the ability to *replay* messages many times like a log — RabbitMQ offers **streams**, a replicated append-only log (also Raft-based) that sits alongside queues. This chapter is a design-round tour: how clustering actually works and why it is not HA, why mirrored queues were a mistake, how quorum queues use Raft to be safe, how streams differ, how RabbitMQ handles **network partitions** (and the partition-handling modes like `pause_minority`), and how to choose quorum queues versus streams — with `rabbitmq.conf`, policy and CLI snippets and a quorum-queue declaration in `amqp091-go`.

## 2. Core Concepts

- **Cluster** — several RabbitMQ nodes sharing metadata (exchanges, bindings, users, vhosts, queue *definitions*) and appearing as one logical broker. Clients can connect to any node.
- **Queue leader** — the single node that hosts a given queue and does its work. By default every queue has exactly one, on the node where it was declared.
- **Metadata vs message replication** — clustering replicates *metadata* everywhere; it does *not* replicate a queue's *messages* unless the queue type does (quorum queues, streams).
- **Classic mirrored queue (deprecated)** — the old HA mechanism: a leader plus mirror copies on other nodes, configured by policy. Removed in current RabbitMQ due to safety flaws.
- **Quorum queue** — a queue replicated across nodes via the Raft consensus algorithm; writes commit once a majority of replicas acknowledge. The modern HA queue type.
- **Raft** — a consensus protocol: a single elected leader replicates an ordered log to followers; an entry is committed when a majority (quorum) has it, which guarantees safety and a consistent leader.
- **Quorum / majority** — more than half the replicas. A quorum queue needs a majority available to accept writes; with 3 replicas it tolerates 1 failure, with 5 it tolerates 2.
- **Delivery limit** — a quorum-queue setting (`delivery-limit`) that dead-letters or drops a message after it has been redelivered too many times — built-in poison-message handling.
- **Stream** — a replicated, append-only, disk-based log (Raft-replicated) supporting very high throughput and *replay* by offset, alongside classic/quorum queues.
- **Network partition** — a split where nodes cannot reach each other though each may be alive; the classic distributed-systems hazard that risks split-brain.
- **Partition-handling mode** — cluster config for what to do during a partition: `pause_minority`, `autoheal`, or `ignore`; `pause_minority` is the safe default.

## 3. Theory & Principles

### Clustering shares metadata, not messages

The single most important thing to understand is the separation between the *control plane* and the *data plane* in a RabbitMQ cluster. When you cluster nodes, they gossip and replicate **metadata**: the set of exchanges, bindings, users, virtual hosts, policies, and the *definitions* of queues (that a queue named `orders` exists and what its arguments are). This is why a client can connect to *any* node and publish to any exchange — the routing table is everywhere. But the **messages** in a classic queue, and the work of that queue, live on exactly *one* node: the queue leader, the node where the queue was declared. Other nodes know the queue exists and will *forward* operations to the leader, but they hold none of its data.

The consequence is stark and often surprising: **a three-node cluster does not make your queues fault-tolerant.** If `orders` was declared on node 2 and node 2 dies, then even though nodes 1 and 3 are perfectly healthy and clients can still connect to them, the `orders` queue is *unavailable* — its messages are on node 2's disk, inaccessible until node 2 recovers. Clustering bought you a shared control plane and the ability to spread *many different queues* across nodes for capacity; it did *not* buy you availability for any *single* queue. For that, the queue's *messages* must be replicated, and that is a property of the *queue type*, not of clustering.

### Why classic mirrored queues were deprecated

The first attempt to replicate messages was **classic mirrored queues**: a policy designated a queue as mirrored, giving it a leader plus mirror copies on other nodes that received a stream of the leader's operations, so a mirror could be promoted if the leader failed. It sounded right and was used for years, but it had three deep problems that got it deprecated and finally removed:

- **Unbounded synchronisation.** When a new mirror was added or a stale one rejoined, it had to synchronise the *entire* queue from the leader, and by default this was a blocking, all-at-once operation that could make the queue unresponsive for the duration — on a large queue, minutes of unavailability, the opposite of what HA is for.
- **Split-brain under partitions.** During a network partition, both sides could believe they were authoritative, accept writes independently, and on healing there was no principled way to merge — you had to *discard* one side's messages. Mirrored queues had no consensus underpinning to prevent two leaders.
- **Silent data loss on promotion.** If the leader failed and a mirror that had *not* fully caught up was promoted, the messages the old leader had but the mirror lacked were simply *gone*, with no error — the most dangerous failure mode, because it looked like everything was fine.

The root cause of all three is that mirroring was *replication without consensus*: it copied data but had no rigorous protocol for agreeing on what was committed and who was leader. That is exactly the gap Raft fills, which is why the replacement is built on it.

### Quorum queues: replication with consensus

**Quorum queues** replace mirroring with **Raft**, a consensus protocol designed precisely to make replication safe. A quorum queue has a **leader** and **followers** across (typically) three or five nodes. Every operation — enqueue, ack — is an entry in a replicated **log**; the leader proposes an entry and it is **committed only once a majority (quorum) of replicas have written it**. This one rule dissolves the mirrored-queue hazards:

- **No silent loss on promotion.** Because an entry is committed only when a majority has it, any node that can win an election necessarily has every committed entry — Raft's election rules guarantee the new leader is up to date. A message the producer was told is committed cannot vanish on failover.
- **No split-brain.** Raft allows only *one* leader per term, elected by majority vote, so a partitioned minority cannot elect its own leader or accept writes — it simply cannot form a quorum. Consistency over availability, deliberately.
- **Bounded, safe recovery.** Followers catch up by replaying the log incrementally, not by a blocking full-sync.

The trade-off is explicit and is the thing to say out loud in a design round: a quorum queue **requires a majority of its replicas to be available to accept writes**. With three replicas it tolerates one node down; with five it tolerates two. Lose the majority — two of three — and the queue becomes *unavailable for writes* rather than risking inconsistency. That is the correct trade-off for a message queue that must not lose data, but it means you size replica counts for your fault-tolerance target and accept that you have chosen consistency over availability during a bad partition. Quorum queues also bring built-in poison-message handling via **`delivery-limit`**: a message redelivered more than the limit is dead-lettered (or dropped), so a poison message cannot loop forever — the broker-native version of the pattern from chapter 11.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="q1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="q2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Clustering is not HA &#8212; the queue type decides fault tolerance</text>

  <rect x="24" y="40" width="410" height="200" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Classic queue in a cluster &#8212; single point of failure</text>
  <rect x="44" y="80" width="80" height="60" rx="6" fill="#fff" stroke="#dc2626"/><text x="84" y="104" text-anchor="middle" fill="#b91c1c" font-size="9">node 1</text><text x="84" y="122" text-anchor="middle" fill="#991b1b" font-size="8">metadata</text>
  <rect x="189" y="80" width="80" height="60" rx="6" fill="#fecaca" stroke="#dc2626" stroke-width="2"/><text x="229" y="102" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">node 2</text><text x="229" y="118" text-anchor="middle" fill="#991b1b" font-size="8">orders queue</text><text x="229" y="132" text-anchor="middle" fill="#991b1b" font-size="8">+ messages</text>
  <rect x="334" y="80" width="80" height="60" rx="6" fill="#fff" stroke="#dc2626"/><text x="374" y="104" text-anchor="middle" fill="#b91c1c" font-size="9">node 3</text><text x="374" y="122" text-anchor="middle" fill="#991b1b" font-size="8">metadata</text>
  <text x="44" y="164" fill="#991b1b" font-size="10">metadata (exchanges, bindings, defs) is on ALL nodes</text>
  <text x="44" y="182" fill="#991b1b" font-size="10">but the queue's MESSAGES live only on node 2</text>
  <text x="44" y="204" fill="#b91c1c" font-size="10" font-weight="bold">node 2 dies &#8594; orders unavailable, though 1 &amp; 3 are healthy</text>
  <text x="44" y="224" fill="#991b1b" font-size="10">clustering = shared control plane + capacity, NOT queue HA</text>

  <rect x="446" y="40" width="410" height="200" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Quorum queue &#8212; Raft-replicated, survives a node</text>
  <rect x="466" y="80" width="80" height="60" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/><text x="506" y="102" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">node 1</text><text x="506" y="118" text-anchor="middle" fill="#166534" font-size="8">LEADER</text><text x="506" y="132" text-anchor="middle" fill="#166534" font-size="8">log</text>
  <rect x="611" y="80" width="80" height="60" rx="6" fill="#fff" stroke="#16a34a"/><text x="651" y="102" text-anchor="middle" fill="#15803d" font-size="9">node 2</text><text x="651" y="118" text-anchor="middle" fill="#166534" font-size="8">follower</text><text x="651" y="132" text-anchor="middle" fill="#166534" font-size="8">log copy</text>
  <rect x="756" y="80" width="80" height="60" rx="6" fill="#fff" stroke="#16a34a"/><text x="796" y="102" text-anchor="middle" fill="#15803d" font-size="9">node 3</text><text x="796" y="118" text-anchor="middle" fill="#166534" font-size="8">follower</text><text x="796" y="132" text-anchor="middle" fill="#166534" font-size="8">log copy</text>
  <path d="M546,100 L609,100" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q1)"/>
  <path d="M546,120 L754,120" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q1)"/>
  <text x="466" y="164" fill="#166534" font-size="10">enqueue/ack = a log entry, COMMITTED when a</text>
  <text x="466" y="180" fill="#166534" font-size="10">MAJORITY (2 of 3) has written it</text>
  <text x="466" y="202" fill="#15803d" font-size="10" font-weight="bold">node dies &#8594; a follower with all committed entries is</text>
  <text x="466" y="218" fill="#15803d" font-size="10" font-weight="bold">elected leader &#8594; no split-brain, no silent loss</text>

  <rect x="24" y="256" width="832" height="228" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why mirrored queues were deprecated &#8594; what Raft fixes</text>
  <rect x="44" y="292" width="392" height="176" rx="8" fill="#fef2f2" stroke="#dc2626"/>
  <text x="240" y="312" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Classic mirrored queues (replication, NO consensus)</text>
  <text x="60" y="336" fill="#991b1b" font-size="10">&#8226; unbounded sync: adding/rejoining a mirror blocks</text>
  <text x="60" y="354" fill="#991b1b" font-size="10">&#8226; split-brain: both sides accept writes in a partition</text>
  <text x="60" y="372" fill="#991b1b" font-size="10">&#8226; SILENT data loss: promote a stale mirror &#8594; msgs gone</text>
  <text x="60" y="398" fill="#7f1d1d" font-size="10" font-weight="bold">root cause: copied data without agreeing what is committed</text>
  <text x="60" y="424" fill="#7f1d1d" font-size="10">&#8594; DEPRECATED and removed in current RabbitMQ</text>
  <text x="60" y="450" fill="#7f1d1d" font-size="10">&#8594; do not use in new designs</text>

  <rect x="448" y="292" width="392" height="176" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="644" y="312" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Quorum queues (Raft consensus)</text>
  <text x="464" y="336" fill="#166534" font-size="10">&#8226; commit needs a MAJORITY &#8594; leader is always up to date</text>
  <text x="464" y="354" fill="#166534" font-size="10">&#8226; one leader per term &#8594; a minority CANNOT accept writes</text>
  <text x="464" y="372" fill="#166534" font-size="10">&#8226; incremental catch-up &#8594; no blocking full-sync</text>
  <text x="464" y="398" fill="#166534" font-size="10">&#8226; delivery-limit &#8594; built-in poison-message handling</text>
  <text x="464" y="424" fill="#14532d" font-size="10" font-weight="bold">trade-off: needs a majority available to WRITE</text>
  <text x="464" y="450" fill="#14532d" font-size="10">(3 replicas tolerate 1 down; 5 tolerate 2) &#8212; consistency over availability</text>
</svg>
```

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="q1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Quorum queues: a Raft-replicated queue that needs a majority</text>

  <rect x="24" y="44" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="66" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Classic mirrored queues (DEPRECATED)</text>
  <text x="40" y="92" fill="#991b1b" font-size="10">&#8226; leader + mirrors, but sync is unbounded &#8212; a new</text>
  <text x="52" y="108" fill="#991b1b" font-size="10">mirror syncing a big queue can stall the leader</text>
  <text x="40" y="128" fill="#991b1b" font-size="10">&#8226; on a partition, both sides can accept writes</text>
  <text x="52" y="144" fill="#991b1b" font-size="10">(split-brain) &#8594; messages silently diverge/lost</text>
  <text x="40" y="164" fill="#991b1b" font-size="10">&#8226; promotion on leader loss can lose unsynced</text>
  <text x="52" y="180" fill="#991b1b" font-size="10">messages &#8212; confirmed data disappears</text>
  <text x="40" y="204" fill="#7f1d1d" font-size="10" font-weight="bold">Ad-hoc replication with no consensus &#8594; unsafe.</text>
  <text x="40" y="226" fill="#7f1d1d" font-size="10" font-weight="bold">Removed as an HA option; do not use for new work.</text>

  <rect x="446" y="44" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Quorum queues (Raft-based, the modern answer)</text>
  <rect x="500" y="82" width="110" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="555" y="100" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">LEADER</text>
  <text x="555" y="114" text-anchor="middle" fill="#166534" font-size="8">node 1</text>
  <rect x="470" y="140" width="90" height="36" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="515" y="162" text-anchor="middle" fill="#166534" font-size="9">follower (n2)</text>
  <rect x="640" y="140" width="90" height="36" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="685" y="162" text-anchor="middle" fill="#166534" font-size="9">follower (n3)</text>
  <path d="M540,124 L520,138" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q1)"/>
  <path d="M572,124 L680,138" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q1)"/>
  <text x="462" y="200" fill="#166534" font-size="10">&#8226; a write is confirmed once a MAJORITY (2 of 3)</text>
  <text x="474" y="214" fill="#166534" font-size="10">has it &#8594; survives losing one node, no data loss</text>
  <text x="462" y="232" fill="#15803d" font-size="10" font-weight="bold">Consensus &#8594; no split-brain, safe leader election.</text>

  <rect x="24" y="264" width="832" height="120" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="286" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why the majority rule is the whole point</text>
  <text x="40" y="310" fill="#475569" font-size="10">&#8226; 3 or 5 nodes (odd) so a majority is unambiguous. A minority partition cannot elect a leader &#8594; it stops accepting writes,</text>
  <text x="52" y="326" fill="#475569" font-size="10">which is exactly what prevents the split-brain that mirrored queues suffered.</text>
  <text x="40" y="346" fill="#475569" font-size="10">&#8226; A message is only acknowledged to the publisher after the quorum has it, so a confirmed message cannot vanish on failover.</text>
  <text x="40" y="366" fill="#334155" font-size="10" font-weight="bold">Trade: quorum queues cost more disk + network (every message replicated to the majority) for correctness under failure.</text>
</svg>
```

The design workflow for a highly-available RabbitMQ deployment, and how the pieces fit:

1. **Cluster an odd number of nodes.** Three (or five) nodes, because quorum queues and the cluster's own consensus need a majority, and an odd count gives the cleanest majority arithmetic (three tolerates one failure). Even counts waste a node and complicate partition handling.
2. **Choose the queue type per queue.** This is the real HA decision, not clustering. A queue that must survive node loss is a **quorum queue** (`x-queue-type: quorum`). A transient, throwaway queue (a reply queue, a per-client queue) can stay a **classic queue** — replicating it would be pure overhead. A high-throughput replayable stream is a **stream**.
3. **Size replica counts for the fault-tolerance target.** Three replicas tolerate one failure and are the common default; five tolerate two for critical queues. More replicas mean more durability but more write latency (a majority must ack) and more storage.
4. **Publish reliably into it.** Publisher confirms (chapter 10) now mean something stronger: a confirm on a quorum queue arrives only after a *majority* of replicas has the message, so a confirm guarantees survival of a node loss — the durability contract from chapter 10 extended across nodes.
5. **Handle partitions deliberately.** Configure `cluster_partition_handling = pause_minority` so that during a network split the minority side *pauses* (stops serving) rather than accepting writes that would later conflict — the cluster-level echo of the quorum principle.
6. **Consume with the delivery limit.** Set `delivery-limit` on quorum queues so a poison message is dead-lettered after N redeliveries rather than looping — native poison handling.
7. **Front the cluster with a load balancer.** Clients connect through a load balancer or use the client's multi-host list, so a dead node is routed around; combine with quorum queues so both the *connection* and the *queue* survive a node loss.

On **streams**: a stream is architecturally a replicated append-only log, so its workflow is different from a queue's. Producers append; consumers read by **offset** and can *replay* from any point; messages are retained by time/size and are *not deleted on consumption* — this is RabbitMQ's log, deliberately Kafka-like. Streams use a dedicated, efficient protocol for very high throughput and support many independent consumers reading the same data. You reach for a stream when you need a *replayable, high-throughput fan-out* — event sourcing, feeding many analytics consumers, retaining a history — rather than the ephemeral, competing-consumer, per-message-routing model a queue gives.

## 5. Implementation

Declaring a quorum queue in `amqp091-go`, plus the cluster and policy configuration (`rabbitmq.conf`, CLI, policy) that make a deployment highly available.

### Declaring a quorum queue with a delivery limit (amqp091-go)

```go
package main

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
	// Connect through several nodes so a dead node does not stop us connecting.
	// amqp091-go dials one URI; in production front the cluster with a load
	// balancer, or retry across a list of node URIs.
	conn, err := amqp.Dial("amqp://guest:guest@rabbit-lb:5672/")
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		log.Fatal(err)
	}
	defer ch.Close()

	// Declare a QUORUM queue: the x-queue-type argument is what makes it
	// Raft-replicated rather than a single-node classic queue. Quorum queues are
	// always durable (there is no such thing as a transient quorum queue).
	_, err = ch.QueueDeclare(
		"orders.critical",
		true,  // durable (required / implied for quorum)
		false, // autoDelete (not allowed for quorum; keep false)
		false, // exclusive (not allowed for quorum)
		false,
		amqp.Table{
			"x-queue-type": "quorum",
			// delivery-limit: after this many redeliveries the message is
			// dead-lettered (with a DLX) or dropped — built-in poison handling,
			// so a bad message cannot loop forever (chapter 11 done natively).
			"x-delivery-limit": int32(5),
			// Optionally pin the replica count; otherwise it follows the
			// cluster default (typically 3 or 5). Odd numbers only.
			"x-quorum-initial-group-size": int32(3),
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	// Publisher confirms now mean "a MAJORITY of replicas has the message", so a
	// confirm here guarantees survival of a single node loss — durability across
	// nodes, not just to one node's disk.
	if err := ch.Confirm(false); err != nil {
		log.Fatal(err)
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = ch.PublishWithContext(ctx, "", "orders.critical", false, false, amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		Body:         []byte(`{"order":42}`),
	})
	if err != nil {
		log.Fatal(err)
	}

	select {
	case c := <-confirms:
		log.Printf("committed to a majority of replicas: ack=%v", c.Ack)
	case <-time.After(5 * time.Second):
		log.Fatal("no confirm: quorum may be unavailable (majority of replicas down)")
	}
}
```

### Cluster and partition-handling config (rabbitmq.conf)

```ini
# rabbitmq.conf on every node

# During a network partition, the MINORITY side pauses (stops serving) rather
# than accepting writes it cannot safely reconcile later. This is the cluster-
# level version of "a minority cannot form a quorum" — it prevents split-brain.
# Alternatives: autoheal (pick a winner and restart losers — riskier),
# ignore (do nothing — only for single-rack setups you fully trust).
cluster_partition_handling = pause_minority

# Make quorum queues the DEFAULT type for newly declared queues, so teams get
# HA by default instead of accidentally creating single-node classic queues.
default_queue_type = quorum

# Raft/quorum tuning: how many segments/entries before snapshotting, etc.
# raft.segment_max_entries = 65536
```

### Forming the cluster and inspecting it (CLI)

```bash
# Join node rabbit@node2 to the cluster led by rabbit@node1.
rabbitmqctl stop_app
rabbitmqctl join_cluster rabbit@node1
rabbitmqctl start_app

# Verify the cluster and see partition status (a non-empty "partitions" field is
# an active split — investigate immediately).
rabbitmqctl cluster_status

# Inspect quorum queue membership: which node is leader, which are followers,
# and whether all replicas are online. If online replicas < majority, the queue
# is unavailable for writes.
rabbitmqctl list_queues name type leader members online

# Grow a quorum queue's replica set onto another node (e.g. after adding a node).
rabbitmq-queues grow rabbit@node3 all

# Rebalance quorum-queue leaders evenly across the cluster (avoid one hot node).
rabbitmq-queues rebalance quorum
```

### Declaring a stream (policy / CLI)

```bash
# A stream is a replicated append-only log: high throughput, replay by offset,
# messages retained (not deleted on consume). Declare via argument or policy.
rabbitmqadmin declare queue name=events.stream queue_type=stream \
  arguments='{"x-max-length-bytes": 20000000000, "x-stream-max-segment-size-bytes": 500000000}'

# Or make all queues matching a pattern quorum queues via policy (the preferred,
# centrally-managed way to set HA rather than per-declare arguments):
rabbitmqctl set_policy ha-quorum "^orders\." \
  '{"queue-type":"quorum","delivery-limit":5}' --apply-to queues
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Quorum queues are safe by construction.** Raft's majority-commit and single-leader-per-term rules eliminate the split-brain and silent-loss failure modes that plagued mirrored queues.
- **Confirmed durability across nodes.** A publisher confirm on a quorum queue means a majority of replicas has the message, so it survives a node loss — the strongest RabbitMQ durability guarantee.
- **Built-in poison handling.** `delivery-limit` dead-letters a message after too many redeliveries without any application code.
- **Streams add high-throughput replay.** For event-sourcing and wide fan-out, streams give a replicated, replayable log alongside queues.
- **Clustering scales capacity and control.** Many queues spread across nodes, one logical broker, clients connect anywhere.

**Disadvantages**
- **Quorum queues need a majority to write.** Lose the majority of replicas and the queue is unavailable for writes — a deliberate consistency-over-availability choice, but it is unavailability.
- **Higher write latency and storage.** A majority must acknowledge each write, and every replica stores a copy, so quorum queues are slower and heavier than a single classic queue.
- **Clustering is not HA on its own.** The common misconception; a cluster of classic queues still has a single point of failure per queue.
- **Streams are a different model.** Replay and offsets change the consumer contract; they are not a drop-in for competing-consumer work queues with per-message routing.

**Trade-offs**
- *Quorum queue vs classic queue:* quorum gives node-loss survival at the cost of write latency, storage and needing a majority up; classic is faster and lighter but a single point of failure. Use quorum for anything whose loss matters, classic for transient/throwaway queues.
- *Quorum queue vs stream:* a quorum queue is a replicated *queue* — competing consumers, per-message ack, delete-on-ack, rich routing; a stream is a replicated *log* — high throughput, replay by offset, retained, many independent readers. Choose the queue for task distribution and routing, the stream for replayable high-throughput event streams.
- *Replica count 3 vs 5:* three tolerates one failure with lower latency and storage; five tolerates two but each write waits for three acks and stores five copies. Match the replica count to the failure budget of the specific queue, not a blanket rule.
- *`pause_minority` vs `autoheal`:* `pause_minority` favours consistency (the minority stops), `autoheal` favours availability (pick a winner, restart losers, risking some loss). For a message system that must not lose or duplicate, `pause_minority` is the safe default.

## 7. Common Mistakes & Best Practices

- **Believing a cluster makes queues HA.** Clustering shares metadata; a classic queue still lives on one node and dies with it. HA is a property of the queue *type* — you must use quorum queues (or streams).
- **Still using classic mirrored queues.** They are deprecated and removed for good reasons (split-brain, silent loss, blocking sync); reaching for `ha-mode` policies in a new design is a mistake — use quorum queues.
- **Even-numbered clusters.** A two- or four-node cluster has a poor majority story (two nodes cannot tolerate one failure for quorum). Use three or five.
- **Making everything a quorum queue.** Replicating transient reply queues or per-client queues is pure overhead and latency for no benefit; reserve quorum queues for data that must survive node loss.
- **Ignoring the majority-availability requirement.** Deploying three-replica quorum queues across only two availability zones, so losing one zone loses the majority and the queue stops accepting writes. Spread replicas so a single failure domain never holds the majority.
- **Leaving partition handling on `ignore`.** Under a real partition with `ignore`, both sides diverge and you get split-brain; set `pause_minority`.
- **Not rebalancing leaders.** All quorum-queue leaders landing on one node makes it a hotspot; use `rabbitmq-queues rebalance quorum`.
- **Best practice:** run an odd-sized cluster (3 or 5), make quorum queues the default type, size replicas to the fault-tolerance target, spread replicas across failure domains so no one domain holds a majority, set `pause_minority` and a `delivery-limit`, and use streams only where you genuinely need replayable high-throughput logs.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `rabbitmqctl cluster_status` shows partitions — a non-empty partitions list is an active split and the first thing to check when a cluster "acts weird". `rabbitmqctl list_queues name type leader members online` shows, per quorum queue, who leads, who the replicas are, and how many are online; if online replicas drop below the majority, the queue is unavailable for writes and that is your incident. For a stuck quorum queue, check whether elections are flapping (unstable network between nodes) — Raft needs a stable majority to make progress.
- **Monitoring.** Alert on: **cluster partitions** (any is bad), **quorum-queue online-replica count** below majority, **leader distribution** (hotspots), **quorum-queue commit latency** (rising means replicas are slow or the network is degraded), and per-queue **unacked/redelivery** (with `delivery-limit`, watch the dead-letter rate). Track disk and memory per node as classic health signals since a node hitting an alarm affects the whole cluster's ability to hold quorum.
- **Security.** Cluster nodes trust one another over the Erlang distribution port, which must be firewalled and secured (a shared Erlang cookie plus TLS for inter-node traffic) — an exposed distribution port is a full compromise. Client-facing AMQP uses TLS and per-vhost, per-service credentials as elsewhere. Quorum replicas store copies on multiple nodes' disks, so disk-at-rest protection now spans several machines.
- **Scaling.** Scale *capacity* by adding nodes and spreading queues (and quorum-queue leaders) across them; scale a *single* queue's throughput by consumers up to the leader-node limit, then shard across multiple queues (a quorum queue's throughput is bounded by its leader, since all writes go through it). For very high throughput with replay, use **streams**, which are designed for it and scale to far higher message rates than queues. Remember that adding replicas increases durability but *decreases* per-write throughput (more acks to wait for), so scaling durability and scaling throughput pull in opposite directions — size deliberately.

## 9. Interview Questions

**Q: Does clustering RabbitMQ make your queues highly available?**
A: No, and this is the most common misconception. Clustering shares *metadata* — exchanges, bindings, users, and queue definitions — across all nodes, so clients can connect anywhere and the routing table is everywhere. But a classic queue's *messages* live on exactly one node, the queue leader where it was declared; other nodes just know it exists and forward to the leader. So if that node dies, the queue is unavailable until it returns, even though the rest of the cluster is healthy. Clustering gives you a shared control plane and the ability to spread many queues across nodes for capacity; high availability for a *specific* queue requires replicating its messages, which is a property of the queue *type* — quorum queues or streams — not of clustering.

**Q: Why were classic mirrored queues deprecated?**
A: Because they were replication without consensus, and that led to three serious problems. Unbounded synchronisation: adding or rejoining a mirror triggered a blocking full-sync of the whole queue, making it unavailable for potentially minutes. Split-brain: during a network partition both sides could accept writes independently with no principled way to reconcile on healing, so you had to discard one side's messages. And silent data loss: if the leader failed and a not-fully-caught-up mirror was promoted, the messages it lacked were simply gone with no error. The root cause was copying data without a rigorous protocol for agreeing what was committed and who was leader — exactly the gap that Raft, and therefore quorum queues, fills.

**Q: How do quorum queues use Raft to be safe?**
A: A quorum queue has a leader and followers across several nodes, and every operation — enqueue, ack — is an entry in a replicated log that is *committed only once a majority of replicas has written it*. That majority-commit rule gives two guarantees. First, no silent loss on failover: because a message is committed only when a majority holds it, and Raft only elects a leader that has all committed entries, a confirmed message cannot vanish when a new leader is chosen. Second, no split-brain: Raft permits only one leader per term, elected by majority vote, so a partitioned minority cannot elect a leader or accept writes. The cost is that the queue needs a majority of replicas available to accept writes — a deliberate choice of consistency over availability.

**Q: What is the availability trade-off of a quorum queue?**
A: A quorum queue can accept writes only while a majority of its replicas is available. With three replicas it tolerates one node down; with five it tolerates two. If it loses the majority — two of three — it stops accepting writes rather than risk inconsistency, so it becomes unavailable for publishing until a majority is restored. That is the right trade-off for a queue that must not lose or duplicate messages, but it is genuinely choosing consistency over availability during a severe partition, and you size the replica count to your fault-tolerance target and spread replicas across failure domains so that a single domain never holds the majority.

**Q: What is a stream and when do you use it instead of a queue?**
A: A stream is a replicated, append-only, disk-based log — RabbitMQ's Kafka-like structure — where producers append, consumers read by offset and can replay from any point, and messages are retained by time or size and not deleted on consumption. You use it instead of a queue when you need high throughput, replay, and multiple independent readers of the same data: event sourcing, feeding many analytics consumers, keeping a history. A queue is the better choice for task distribution — competing consumers, per-message ack, delete-on-ack, and rich routing — while a stream is for a replayable, high-throughput event log. They coexist; you pick per data flow.

**Q: What does `pause_minority` do?**
A: It is a network-partition-handling mode that tells the minority side of a split to *pause* — stop serving clients — rather than continuing to accept operations it could not later reconcile with the majority. It is the cluster-level expression of the same principle quorum queues use: a minority cannot make safe progress, so it should stop rather than diverge, preventing split-brain at the cost of the minority's availability during the partition. The alternatives are `autoheal` (let the cluster pick a winner and restart the losers, favouring availability but risking loss) and `ignore` (do nothing, which invites split-brain); for a message system that must not lose or duplicate, `pause_minority` is the safe default.

**Q: (Senior) You must design a RabbitMQ deployment that survives losing a whole availability zone without losing messages. How?**
A: The key constraint is that no single failure domain — here, an availability zone — may hold a majority of any quorum queue's replicas, because losing that domain would lose the majority and stop the queue. So I would run the cluster across *three* availability zones with an odd number of nodes, placing quorum-queue replicas one per zone (three replicas across three zones), so losing any one zone leaves two replicas — still a majority — and the queue keeps accepting writes with an automatic leader election if the old leader was in the failed zone. Two zones is not enough: three replicas across two zones puts two in one zone, so losing that zone loses the majority. I would make critical queues quorum queues (via a policy, not per-declare), publish with confirms so a confirm means a majority across zones has the message, set `cluster_partition_handling = pause_minority` so a zone that gets cut off pauses rather than diverging, and set a `delivery-limit` for poison handling. I would front the cluster with a zone-aware load balancer (or a client node list spanning zones) so connections survive a zone loss too, and I would spread quorum-queue leaders across zones and rebalance them to avoid a hotspot. The mental model is that both the *connection path* and the *queue's replica majority* must survive the loss of any one zone, and quorum queues plus three-zone placement plus `pause_minority` is the configuration that guarantees it — accepting the write-latency cost of cross-zone majority acknowledgement as the price of zone-loss durability.

**Q: (Senior) Compare quorum queues and streams in depth — when does each win?**
A: They are both Raft-replicated and both survive node loss, but they are fundamentally different data structures for different jobs. A quorum queue is a *queue*: messages are enqueued, delivered to competing consumers, acknowledged individually, and *deleted on ack*; it supports the full routing model (exchanges, bindings, per-message TTL, dead-lettering, priorities to a degree) and its throughput is bounded by its single leader because every operation goes through the leader's Raft log, and per-message acking is relatively expensive. It wins for *task distribution and complex routing that must not lose data* — a payment-processing work queue, an order pipeline — where you want competing consumers, at-least-once with acks, and messages consumed once and removed. A stream is a *log*: messages are appended and *retained* (not deleted on consumption), consumers read by *offset* and can *replay* from any point, and many independent consumers can read the same data at once; it uses a purpose-built protocol for very high throughput — far higher than a queue — because it appends sequentially and does not track per-message acks the same way. It wins for *replayable, high-throughput event streams and wide fan-out* — event sourcing, feeding analytics, retaining history for reprocessing — the workloads you would otherwise reach for Kafka to do. The decision hinges on two questions: do you need *replay and retention* (stream) or *consume-once-and-delete with rich routing* (quorum queue), and do you need *log-scale throughput* (stream) or is *queue throughput with per-message acking and routing* enough (quorum queue). Using a stream as a work queue means reimplementing offset/consumer coordination and losing the routing model; using a quorum queue as an event log means you cannot replay and you hit the leader-throughput ceiling. Pick the structure that matches the access pattern.

**Q: (Senior) A quorum queue has stopped accepting publishes though two of its three nodes are up. What is happening and what do you check?**
A: If two of three replicas are genuinely up and reachable, the queue *should* accept writes — two is a majority of three — so the symptom tells me the real situation is not what it appears. The most likely causes: first, an active *network partition* where the leader is on the minority side of a split it cannot see across, so from the leader's perspective it has lost quorum even though nodes are "up" — I check `rabbitmqctl cluster_status` for a non-empty partitions list, which is the classic tell, and with `pause_minority` the minority pausing is expected and correct. Second, the "up" nodes may not actually be *in-sync replicas* of this queue — a node can be running but its copy of this quorum queue's log may be behind or the replica may be offline for this queue specifically — so I check `rabbitmqctl list_queues name type leader members online` to see how many replicas are *online for this queue*, which can be fewer than the number of running nodes. Third, leader election may be *flapping* due to an unstable or high-latency network between nodes, so no stable leader can commit — I look at logs for repeated elections. Fourth, a node may be in a resource *alarm* (memory or disk high watermark), which blocks publishes cluster-wide via flow control regardless of quorum. So my checklist is: cluster partition status, online-replica count for *this* queue versus the majority threshold, leader stability in the logs, and resource alarms on the nodes. The underlying principle is that "node is running" is not the same as "replica is online and in a stable majority", and quorum queues correctly refuse to accept writes the instant they cannot confirm a real majority — which is the safety property working as designed, not a bug.

## 10. Quick Revision & Cheat Sheet

| Aspect | Classic queue | Quorum queue | Stream |
|---|---|---|---|
| Replication | none (single node) | Raft, majority commit | Raft, replicated log |
| Survives node loss | no | yes (majority up) | yes (majority up) |
| Model | queue, delete on ack | queue, delete on ack | log, retained, replay |
| Consume | competing consumers | competing consumers | read by offset, many readers |
| Poison handling | manual DLX/TTL | `delivery-limit` built-in | n/a (replay) |
| Best for | transient/throwaway | HA task/order queues | high-throughput replayable events |

| Config | Setting |
|---|---|
| Quorum queue | `x-queue-type: quorum` (or `default_queue_type = quorum`) |
| Poison limit | `x-delivery-limit` |
| Partition mode | `cluster_partition_handling = pause_minority` |
| Fault tolerance | 3 replicas → 1 failure; 5 replicas → 2 failures |

**Flash cards**
- **Does clustering give queue HA?** → No — metadata is shared, but a classic queue lives on one node. HA is the queue *type*.
- **Why were mirrored queues deprecated?** → Replication without consensus: unbounded sync, split-brain, silent loss on promotion.
- **How do quorum queues stay safe?** → Raft: commit needs a majority; one leader per term; no split-brain, no silent loss.
- **Quorum queue availability cost?** → Needs a majority of replicas up to accept writes (3 tolerate 1, 5 tolerate 2).
- **Quorum queue vs stream?** → Queue (consume-once, routing) vs log (retained, replay, high throughput).
- **Partition default?** → `pause_minority` — the minority stops rather than diverging.

## 11. Hands-On Exercises & Mini Project

- [ ] Form a three-node cluster, declare a *classic* queue, kill its leader node, and observe the queue become unavailable while the cluster stays up.
- [ ] Redeclare it as a quorum queue, kill the leader, and observe automatic failover with no message loss.
- [ ] Publish with confirms into a quorum queue, take one follower down, and confirm publishing continues (majority still up); take a second down and observe writes stop.
- [ ] Set a `delivery-limit` and feed a poison message; confirm it is dead-lettered after the limit rather than looping.
- [ ] Induce a network partition (block inter-node traffic) with `pause_minority` set and watch the minority pause; heal it and watch recovery.
- [ ] Declare a stream, publish a large batch, and replay it from offset 0 with two independent consumers.

### Mini Project — "Zone-Fault-Tolerant Broker"

**Goal.** Stand up a RabbitMQ cluster that survives losing a node (and ideally a zone) without losing messages, and prove it under fault injection.

**Requirements.**
1. Form a three-node cluster (simulating three zones); set `default_queue_type = quorum` and `cluster_partition_handling = pause_minority`.
2. Declare critical queues as quorum queues with a `delivery-limit`, spread replicas one per node, and publish with confirms.
3. Write a fault harness that kills the leader node mid-stream and asserts zero message loss and continued publishing.
4. Kill a *majority* of replicas and show the queue correctly refuses writes rather than losing/duplicating data; restore and show recovery.
5. Add a stream alongside for a high-throughput event feed and demonstrate replay after a consumer restart.

**Extensions.**
- Compare publish latency and throughput for classic vs 3-replica vs 5-replica quorum queues and quantify the durability/latency trade-off.
- Simulate a partition with `pause_minority` versus `autoheal` and document the different availability/consistency outcomes.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Reliability: Publisher Confirms, Persistence & Mandatory* (what a confirm means once writes are replicated to a majority), *Dead Letter Exchanges, TTL & Delayed Messages* (poison handling, done natively by quorum-queue `delivery-limit`), *Messaging Models: Queues vs Pub/Sub vs the Log* (why a stream is the log and a queue is not), *Design: Routing Patterns — Work Queues, Pub/Sub & RPC* (the queues you are now making highly available), *Design: Kafka vs RabbitMQ* (streams versus Kafka for replayable high-throughput logs).

- **RabbitMQ — Quorum Queues** — RabbitMQ · *Advanced* · the authoritative guide to Raft-based quorum queues, their guarantees, `delivery-limit`, and replica management. <https://www.rabbitmq.com/docs/quorum-queues>
- **RabbitMQ — Clustering Guide** — RabbitMQ · *Intermediate* · how nodes cluster, what metadata is shared, and why a classic queue is single-node. <https://www.rabbitmq.com/docs/clustering>
- **RabbitMQ — Streams** — RabbitMQ · *Advanced* · the replicated append-only log, its protocol, offsets and replay, and when to prefer it over a queue. <https://www.rabbitmq.com/docs/streams>
- **RabbitMQ — Migrate to Quorum Queues (from mirrored)** — RabbitMQ · *Intermediate* · why classic mirrored queues were deprecated and how to move off them. <https://www.rabbitmq.com/docs/migrate-mcq-to-qq>
- **RabbitMQ — Partitions (network partition handling)** — RabbitMQ · *Advanced* · `pause_minority`, `autoheal`, `ignore` and how to choose, with the split-brain reasoning. <https://www.rabbitmq.com/docs/partitions>
- **In Search of an Understandable Consensus Algorithm (Raft)** — Ongaro & Ousterhout · *Advanced* · the Raft paper underpinning quorum queues and streams; the source for majority-commit and leader-election safety. <https://raft.github.io/raft.pdf>
- **RabbitMQ — Quorum Queues internals / Khepri talks** — RabbitMQ / CloudAMQP · *Advanced* · deeper talks on how quorum queues work and the direction of RabbitMQ's replicated metadata store. <https://www.cloudamqp.com/blog/rabbitmq-quorum-queues.html>
- **Designing Data-Intensive Applications, ch. 9 (Consistency & Consensus)** — Martin Kleppmann · *Advanced* · the theory of consensus, quorums and split-brain that quorum queues embody. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 12.*
