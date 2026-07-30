# 27 · Monitoring: Lag, Throughput & Broker Health

> **In one line:** Of the dozens of metrics a broker emits, a mere handful decide whether you sleep — consumer lag above all (are consumers keeping up?), then under-replicated partitions on Kafka and queue depth on RabbitMQ (is the broker healthy and is the backlog growing?) — and everything else is context you consult only after one of those has already told you something is wrong.

---

## 1. Overview

A message broker is a shared, stateful dependency, and the whole point of the previous chapters — buffering, decoupling, at-least-once delivery — quietly assumes one thing: that consumers are draining the queue roughly as fast as producers fill it. Monitoring is how you verify that assumption continuously, and catch the moment it stops being true *before* the buffer becomes an outage.

The temptation is to drown in metrics. Kafka exposes hundreds of JMX beans; RabbitMQ's management API returns pages of numbers per queue. Most of them are noise most of the time. The discipline of this chapter is to name the *few that matter* and to be ruthless about the rest. The single most important messaging metric, across both systems and above all others, is **consumer lag**: how far behind the consumers are from the tip of the stream. On Kafka that is `log-end-offset − committed-offset`, per partition, per consumer group. On RabbitMQ the direct equivalent is **queue depth** (`messages_ready`): how many messages are sitting in the queue waiting to be delivered. Rising lag or rising depth means one thing — consumers cannot keep up — and it is the earliest, clearest signal that something needs attention, long before the disk fills or the user complains.

Beyond lag, each broker has a small set of *health* metrics that tell you the broker itself is sound. For Kafka the crown jewel is **under-replicated partitions**: if this is anything other than zero, your durability guarantees are quietly degraded and a single further failure could lose data. For RabbitMQ it is the **memory and disk alarms**, **unacknowledged message** counts, and **consumer utilisation**. Then there is throughput (messages and bytes per second, the pulse of the system) and end-to-end latency (how long a message takes from produce to consume, the number your users actually feel).

This chapter covers what to measure, how to scrape it (JMX exporters, the `rabbitmq_prometheus` plugin, the CLI tools), and — the part that separates operators from dashboard-admirers — *what to actually alert on*. A dashboard nobody looks at is worthless; an alert that fires on the right threshold at 3am is what keeps the system honest.

## 2. Core Concepts

- **Consumer lag (Kafka)** — for one partition in one group: `log-end-offset − last-committed-offset` = the number of messages produced but not yet processed. The #1 metric. Aggregate across a group's partitions for the group's total lag.
- **Log-end-offset (LEO)** — the offset of the *next* message to be appended to a partition; the tip of the log.
- **Committed offset** — the last offset a consumer group has recorded as processed (in `__consumer_offsets`). Lag is measured against this.
- **Queue depth / `messages_ready` (RabbitMQ)** — messages in a queue ready to be delivered but not yet sent to any consumer. RabbitMQ's equivalent of lag.
- **`messages_unacknowledged`** — messages delivered to a consumer but not yet acked; in-flight work. High and stuck = a consumer that took messages and is not acking them.
- **Under-replicated partitions (URP)** — Kafka partitions where the ISR (in-sync replica set) is smaller than the configured replication factor. The single most important broker-health alert.
- **Offline partitions** — partitions with no active leader; those partitions are unavailable for reads and writes. Should always be zero.
- **Active controller count** — cluster-wide this should sum to exactly 1. Zero means no controller (a crisis); more than one means split brain.
- **ISR shrink/expand rate** — how often replicas fall out of and re-join the in-sync set; frequent churn signals an overloaded or flaky broker.
- **Consumer utilisation (RabbitMQ)** — the fraction of time a queue could deliver messages because consumers were ready to receive; below 1.0 means consumers (or prefetch) are the bottleneck.
- **Throughput** — messages/s and bytes/s in (produce) and out (consume). The pulse.
- **End-to-end latency** — wall-clock time from a message being produced to it being processed. What users feel.
- **JMX / Prometheus exporter** — the plumbing that exposes broker-internal metrics to a scraper (Prometheus) and a dashboard (Grafana).

## 3. Theory & Principles

### Lag is a derivative, and that is why it matters

The reason consumer lag is the master metric is that it is a *rate* signal disguised as a *level*. At any instant, lag is a number of messages. But its *trend* is the difference between the produce rate and the consume rate integrated over time:

`lag(t) = lag(0) + ∫ (produce_rate − consume_rate) dt`

If producers and consumers run at the same rate, lag is flat — it can be flat at zero or flat at ten thousand, and either is fine as long as it is *stable*. If the produce rate exceeds the consume rate, lag rises monotonically, and the slope tells you exactly how fast you are falling behind and therefore how long until the buffer (retention window on Kafka, disk/memory on RabbitMQ) is exhausted. This is why you alert on *rising* lag, not on lag being non-zero: a healthy busy system always has some lag; a dying one has lag with a positive slope.

The single most useful derived number is **time-to-drain** (or its inverse, estimated catch-up time): `lag / consume_rate`. A lag of 2,000,000 messages sounds alarming, but if the group processes 500,000/s it will clear in four seconds — a blip. A lag of 50,000 that is growing while the group processes 100/s is a genuine emergency. Always interpret lag against throughput; a raw lag threshold with no rate context generates false alarms and misses real ones.

### Kafka health is about replication, not liveness

A naive Kafka health check pings the broker port and calls it healthy. That is nearly useless, because Kafka's failure modes are rarely "the process is dead" — they are "the process is alive but replicas have fallen behind so your durability is a lie". The metric that captures this is **under-replicated partitions**. With replication factor 3 and `min.insync.replicas=2`, a partition is fully healthy when all 3 replicas are in the ISR. If one replica falls behind (slow disk, network partition, GC pause), the ISR shrinks to 2 — the partition is now *under-replicated*. Producing with `acks=all` still works (2 ≥ min.insync), but you have lost a replica's worth of redundancy: one more failure and either the partition goes read-only or, if you were foolish enough to enable unclean leader election, you lose data. URP > 0 is therefore the earliest structural warning that your durability contract is degraded, which is why it is the classic pager alert for Kafka.

### RabbitMQ health is about flow and resources

RabbitMQ's failure modes are different in shape because it holds messages in memory (classic and quorum queues both keep a working set in RAM) and deletes on ack. So its health is dominated by *resource pressure* and *flow*. The **memory alarm** and **disk-free alarm** are the two that stop the world: when memory use crosses the high-watermark (default 40% of system RAM) or free disk drops below the limit (default 50MB, absurdly low — raise it), the broker **blocks publishers** to protect itself. A blocked publisher looks, from the application side, like the broker has hung — connections stall on publish. So watching those alarms, and the memory/disk headroom before them, is as important on RabbitMQ as URP is on Kafka. Alongside them, `messages_ready` (depth) is the lag equivalent, and `messages_unacknowledged` catches the subtler failure where a consumer grabbed a batch (up to its prefetch limit) and then wedged without acking — those messages are neither processed nor redelivered until the channel closes.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Consumer lag: the master metric, and what its slope means</text>

  <rect x="40" y="44" width="800" height="230" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <line x1="90" y1="250" x2="810" y2="250" stroke="#334155" stroke-width="1.5"/>
  <line x1="90" y1="60" x2="90" y2="250" stroke="#334155" stroke-width="1.5"/>
  <text x="450" y="270" text-anchor="middle" fill="#475569" font-size="10">time &#8594;</text>
  <text x="70" y="155" text-anchor="middle" fill="#475569" font-size="10" transform="rotate(-90 70 155)">lag (messages)</text>

  <polyline points="90,210 200,208 310,212 420,209 530,211 640,208 750,210" fill="none" stroke="#16a34a" stroke-width="2.5"/>
  <text x="756" y="205" fill="#15803d" font-size="10" font-weight="bold">flat &#8594; healthy</text>

  <polyline points="90,205 200,190 310,168 420,142 530,112 640,84 750,66" fill="none" stroke="#dc2626" stroke-width="2.5"/>
  <text x="640" y="60" fill="#b91c1c" font-size="10" font-weight="bold">rising slope &#8594; falling behind</text>

  <polyline points="90,150 180,110 260,120 360,175 460,225 540,238 620,240" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-dasharray="5 3"/>
  <text x="300" y="100" fill="#1d4ed8" font-size="10" font-weight="bold">spike then drains &#8594; a blip, not an outage</text>

  <text x="110" y="90" fill="#334155" font-size="10" font-weight="bold">lag(t) = lag(0) + &#8747;(produce_rate &#8722; consume_rate) dt</text>
  <text x="110" y="108" fill="#475569" font-size="9">so the SLOPE is the rate mismatch &#8212; alert on rising, not on non-zero</text>

  <rect x="40" y="288" width="800" height="164" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="310" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Always read lag against throughput: time-to-drain = lag / consume_rate</text>
  <rect x="64" y="326" width="360" height="104" rx="8" fill="#fff" stroke="#93c5fd"/>
  <text x="244" y="348" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">lag 2,000,000 &#183; rate 500,000/s</text>
  <text x="244" y="372" text-anchor="middle" fill="#166534" font-size="11">drains in 4s &#8594; a blip, ignore</text>
  <text x="244" y="396" text-anchor="middle" fill="#475569" font-size="10">big number, healthy system</text>
  <text x="244" y="416" text-anchor="middle" fill="#475569" font-size="9">raw lag threshold would false-alarm here</text>
  <rect x="456" y="326" width="360" height="104" rx="8" fill="#fff" stroke="#fca5a5"/>
  <text x="636" y="348" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">lag 50,000 &#183; rate 100/s &#183; rising</text>
  <text x="636" y="372" text-anchor="middle" fill="#b91c1c" font-size="11">drains in ~8min and GROWING</text>
  <text x="636" y="396" text-anchor="middle" fill="#475569" font-size="10">small number, genuine emergency</text>
  <text x="636" y="416" text-anchor="middle" fill="#475569" font-size="9">raw lag threshold would miss this</text>
</svg>
```

## 4. Architecture & Workflow

The monitoring pipeline has the same shape for both brokers: the broker exposes metrics, a scraper pulls them on an interval, a time-series database stores them, a dashboard visualises them, and an alerting rule evaluates them and pages a human. The differences are in *where the metrics live* and *what you compute lag from*.

For **Kafka**, the broker JVM exposes everything over **JMX**. You run the **Kafka JMX exporter** (a Java agent that translates JMX MBeans into a Prometheus text endpoint) alongside each broker, Prometheus scrapes `:port/metrics`, and Grafana renders it. Consumer lag is special: the broker knows the log-end-offset, and `__consumer_offsets` holds each group's committed offset, but computing the *difference* per group is not a native broker metric — you either use `kafka-consumer-groups.sh --describe` (point-in-time), the `kafka_exporter` (a separate exporter that continuously computes lag), or **Burrow** (LinkedIn's purpose-built lag monitor that also evaluates whether a consumer is *stalled* rather than merely behind).

For **RabbitMQ**, the modern path is the built-in **`rabbitmq_prometheus`** plugin, which exposes a `/metrics` endpoint directly — no sidecar. Enable it and Prometheus scrapes per-queue depth, unacked counts, publish/deliver rates, memory and connection stats. The management HTTP API (`/api/queues`) and `rabbitmqctl`/`rabbitmqadmin` give the same numbers for scripting and spot checks.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two scrape paths into one alerting pipeline</text>

  <rect x="30" y="48" width="250" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="155" y="70" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Kafka</text>
  <rect x="48" y="82" width="214" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="155" y="101" text-anchor="middle" fill="#1e40af" font-size="9">broker JVM &#8594; JMX MBeans</text>
  <rect x="48" y="118" width="100" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="98" y="137" text-anchor="middle" fill="#1e40af" font-size="8">JMX exporter</text>
  <rect x="158" y="118" width="104" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="210" y="132" text-anchor="middle" fill="#1e40af" font-size="8">Burrow /</text><text x="210" y="143" text-anchor="middle" fill="#1e40af" font-size="8">kafka_exporter (lag)</text>
  <text x="155" y="168" text-anchor="middle" fill="#1d4ed8" font-size="8">URP, offline parts, controller,</text>
  <text x="155" y="181" text-anchor="middle" fill="#1d4ed8" font-size="8">request latency, ISR churn, LEO</text>
  <text x="155" y="192" text-anchor="middle" fill="#1d4ed8" font-size="8">lag = LEO &#8722; committed</text>

  <rect x="30" y="216" width="250" height="150" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="155" y="238" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">RabbitMQ</text>
  <rect x="48" y="250" width="214" height="30" rx="5" fill="#fff" stroke="#fca5a5"/><text x="155" y="269" text-anchor="middle" fill="#b91c1c" font-size="9">rabbitmq_prometheus plugin</text>
  <rect x="48" y="286" width="214" height="30" rx="5" fill="#fff" stroke="#fca5a5"/><text x="155" y="305" text-anchor="middle" fill="#b91c1c" font-size="8">/metrics endpoint (no sidecar)</text>
  <text x="155" y="334" text-anchor="middle" fill="#991b1b" font-size="8">messages_ready (depth), unacked,</text>
  <text x="155" y="347" text-anchor="middle" fill="#991b1b" font-size="8">publish/deliver rate, mem/disk alarms,</text>
  <text x="155" y="358" text-anchor="middle" fill="#991b1b" font-size="8">consumer utilisation, connection churn</text>

  <rect x="360" y="140" width="150" height="130" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="435" y="200" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Prometheus</text>
  <text x="435" y="222" text-anchor="middle" fill="#b45309" font-size="9">pulls /metrics</text>
  <text x="435" y="238" text-anchor="middle" fill="#b45309" font-size="9">on an interval,</text>
  <text x="435" y="254" text-anchor="middle" fill="#b45309" font-size="9">stores time series</text>

  <rect x="560" y="70" width="290" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="705" y="92" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Grafana dashboards</text>
  <text x="705" y="116" text-anchor="middle" fill="#166534" font-size="9">lag per group &#183; throughput &#183; URP</text>
  <text x="705" y="134" text-anchor="middle" fill="#166534" font-size="9">queue depth &#183; latency percentiles</text>
  <text x="705" y="158" text-anchor="middle" fill="#166534" font-size="9">the eyes-on view during an incident</text>
  <text x="705" y="176" text-anchor="middle" fill="#166534" font-size="9">(nobody watches it at 3am, though)</text>

  <rect x="560" y="220" width="290" height="120" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="705" y="242" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Alertmanager &#8594; pager</text>
  <text x="705" y="266" text-anchor="middle" fill="#6d28d9" font-size="9">URP &gt; 0 &#183; lag rising over threshold</text>
  <text x="705" y="284" text-anchor="middle" fill="#6d28d9" font-size="9">depth growth &#183; DLQ growth &#183; broker down</text>
  <text x="705" y="308" text-anchor="middle" fill="#6d28d9" font-size="9">THIS is what wakes someone &#8212;</text>
  <text x="705" y="324" text-anchor="middle" fill="#6d28d9" font-size="9">the rest is context you consult after</text>

  <path d="M280,130 L358,180" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#a1)"/>
  <path d="M280,290 L358,220" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#a1)"/>
  <path d="M510,175 L558,140" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#a1)"/>
  <path d="M510,235 L558,270" stroke="#4f46e5" stroke-width="1.8" marker-end="url(#a1)"/>
</svg>
```

The workflow lesson: dashboards are for *investigation* (a human already knows something is wrong and is looking), alerts are for *detection* (nobody is looking and the system must summon a human). Build both, but be far more careful about the alert set — an over-alerting pipeline trains people to ignore the pager, which is worse than no pager at all.

## 5. Implementation

Real scrape and inspection commands, config, and a small Go exporter that publishes end-to-end latency — the one number the broker cannot give you because it requires correlating produce time with consume time.

### Kafka: inspect consumer lag from the CLI

```bash
# The workhorse. --describe shows, per partition for a group:
# CURRENT-OFFSET (committed), LOG-END-OFFSET (tip), and LAG = the difference.
kafka-consumer-groups.sh \
  --bootstrap-server broker1:9092 \
  --describe --group order-processor

# Example output (the LAG column is the whole point):
# TOPIC        PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG    CONSUMER-ID
# orders       0          1048231         1048250         19     consumer-1-abc
# orders       1          998112          1041005         42893  consumer-2-def   <-- this partition is behind
# orders       2          1050001         1050001         0      consumer-3-ghi

# List all groups, and spot ones with no active members (a stopped consumer
# whose lag will grow silently until retention deletes the un-read messages).
kafka-consumer-groups.sh --bootstrap-server broker1:9092 --list
kafka-consumer-groups.sh --bootstrap-server broker1:9092 \
  --describe --group order-processor --state
```

### Kafka: JMX exporter config (the metrics that matter)

```yaml
# jmx-exporter-kafka.yml — passed to the prometheus jmx_exporter java agent:
#   -javaagent:jmx_prometheus_javaagent.jar=7071:jmx-exporter-kafka.yml
# We whitelist ONLY the beans worth scraping; whitelisting everything makes
# the scrape huge and Prometheus slow. These are the broker-health crown jewels.
lowercaseOutputName: true
rules:
  # UNDER-REPLICATED PARTITIONS — alert if > 0 on any broker.
  - pattern: 'kafka.server<type=ReplicaManager, name=UnderReplicatedPartitions><>Value'
    name: kafka_under_replicated_partitions
  # OFFLINE PARTITIONS — should always be 0; > 0 means unavailable partitions.
  - pattern: 'kafka.controller<type=KafkaController, name=OfflinePartitionsCount><>Value'
    name: kafka_offline_partitions
  # ACTIVE CONTROLLER — sum across brokers must equal exactly 1.
  - pattern: 'kafka.controller<type=KafkaController, name=ActiveControllerCount><>Value'
    name: kafka_active_controller
  # ISR shrink/expand — frequent churn signals an overloaded/flaky broker.
  - pattern: 'kafka.server<type=ReplicaManager, name=IsrShrinksPerSec><>Count'
    name: kafka_isr_shrinks_total
  # Produce/fetch request latency (p99 comes from the histogram percentiles).
  - pattern: 'kafka.network<type=RequestMetrics, name=TotalTimeMs, request=(Produce|FetchConsumer)><>(\d+)thPercentile'
    name: kafka_request_total_time_ms
    labels: { request: "$1", quantile: "0.$2" }
  # Broker throughput in bytes/s.
  - pattern: 'kafka.server<type=BrokerTopicMetrics, name=(BytesInPerSec|BytesOutPerSec)><>OneMinuteRate'
    name: kafka_broker_$1
```

### RabbitMQ: enable the Prometheus plugin and inspect queues

```bash
# Enable the built-in exporter — no sidecar. Metrics then live at :15692/metrics.
rabbitmq-plugins enable rabbitmq_prometheus

# Per-queue snapshot: messages (total), messages_ready (DEPTH = the lag equivalent),
# messages_unacknowledged (in-flight), and consumer count.
rabbitmqctl list_queues name messages messages_ready messages_unacknowledged consumers

# Example:
# name            messages  messages_ready  messages_unacknowledged  consumers
# orders          42893     42891           2                        3   <-- depth 42891, backing up
# orders.dlq      517       517             0                        0   <-- a growing DLQ with no consumer

# Consumer utilisation (0.0-1.0): time the queue COULD deliver because a consumer
# was ready. Below 1.0 => consumers or prefetch are the bottleneck.
rabbitmqadmin list queues name consumer_utilisation messages_ready

# Check the resource alarms directly — if either fires, publishers are BLOCKED.
rabbitmqctl status | grep -A5 alarms
```

### Go: an end-to-end latency probe

```go
// Package latprobe measures produce-to-consume latency, which no broker metric
// can give you because it spans producer and consumer clocks. We stamp the
// produce time in a header and, on consume, subtract it from now. Requires the
// two clocks to be NTP-synced; the number is only as good as that sync.
package latprobe

import (
	"context"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/segmentio/kafka-go"
)

// e2eLatency is a histogram so we can read p50/p99, not just a mean — latency
// distributions are long-tailed and a mean hides the tail that users feel.
var e2eLatency = prometheus.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "messaging_e2e_latency_seconds",
	Help:    "Produce-to-consume latency in seconds.",
	Buckets: prometheus.ExponentialBuckets(0.001, 2, 14), // 1ms .. ~8s
}, []string{"topic"})

func init() { prometheus.MustRegister(e2eLatency) }

// StampProduceTime attaches the current time as a header on the outgoing message.
// Call this in the producer path just before writing.
func StampProduceTime(msg *kafka.Message) {
	msg.Headers = append(msg.Headers, kafka.Header{
		Key:   "produced_at_unixnano",
		Value: []byte(strconv.FormatInt(time.Now().UnixNano(), 10)),
	})
}

// ObserveOnConsume reads the stamp and records the elapsed time. Call this in the
// consumer path as soon as a message is received, BEFORE your processing, so the
// number reflects broker + delivery latency rather than your handler's runtime.
func ObserveOnConsume(msg kafka.Message) {
	for _, h := range msg.Headers {
		if h.Key != "produced_at_unixnano" {
			continue
		}
		producedNs, err := strconv.ParseInt(string(h.Value), 10, 64)
		if err != nil {
			return // malformed stamp; skip rather than record garbage
		}
		elapsed := time.Since(time.Unix(0, producedNs))
		e2eLatency.WithLabelValues(msg.Topic).Observe(elapsed.Seconds())
		return
	}
}

// ScrapeLoop is the shape of a lag-alerting sidecar: poll the group's lag and
// export it. In production prefer kafka_exporter/Burrow, but this shows the math.
func ScrapeLoop(ctx context.Context, computeLag func() (int64, float64), lagGauge prometheus.Gauge) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			lag, _ := computeLag() // lag = sum over partitions of (LEO - committed)
			lagGauge.Set(float64(lag))
		}
	}
}
```

### Prometheus alert rules (the payoff)

```yaml
# alerts.yml — the SMALL set that actually pages someone.
groups:
  - name: messaging
    rules:
      # Kafka: any under-replicated partition means degraded durability.
      - alert: KafkaUnderReplicated
        expr: kafka_under_replicated_partitions > 0
        for: 5m
        labels: { severity: page }
        annotations: { summary: "Kafka has under-replicated partitions" }
      # Kafka: consumer lag high AND still rising (deriv > 0) for 10m.
      - alert: ConsumerLagGrowing
        expr: kafka_consumergroup_lag > 100000 and deriv(kafka_consumergroup_lag[10m]) > 0
        for: 10m
        labels: { severity: page }
      # RabbitMQ: queue depth climbing steadily.
      - alert: QueueDepthGrowing
        expr: rabbitmq_queue_messages_ready > 50000 and deriv(rabbitmq_queue_messages_ready[10m]) > 0
        for: 10m
        labels: { severity: page }
      # DLQ growth is silent data-quality death — alert on ANY sustained growth.
      - alert: DLQGrowing
        expr: deriv(rabbitmq_queue_messages_ready{queue=~".*\\.dlq"}[15m]) > 0
        for: 15m
        labels: { severity: ticket }
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of disciplined lag/health monitoring**
- **Early detection.** Rising lag warns you hours before retention expiry or a disk fills — the earliest possible signal that consumers are losing the race.
- **Precise localisation.** Per-partition lag and per-queue depth point at the *specific* slow consumer or partition, not a vague "the system is slow".
- **Durability assurance.** URP and ISR metrics tell you your replication guarantees are actually being met, not just configured.
- **Capacity signal.** Throughput trends feed capacity planning (chapter 28) — you scale before saturation, not after an outage.

**Disadvantages / costs**
- **Metric sprawl.** Brokers emit hundreds of metrics; without ruthless curation the signal drowns in noise and dashboards become unreadable.
- **Lag computation is not free.** Kafka lag is a derived quantity; computing it continuously (Burrow, kafka_exporter) is extra infrastructure to run and keep healthy.
- **Clock dependence.** End-to-end latency needs NTP-synced producer and consumer clocks; a skewed clock produces nonsense latency numbers that look real.
- **Alert fatigue.** Poorly tuned thresholds (raw lag with no rate context) train people to ignore the pager, defeating the purpose.

**Trade-offs**
- *Level vs rate:* alerting on a raw lag *level* is simple but wrong — it false-alarms on healthy busy systems and misses slow-but-rising ones. Alerting on the *slope* (deriv) is correct but needs a longer evaluation window, which delays detection slightly. Prefer the slope, accept the small delay.
- *Push vs pull scrape:* Prometheus pull is simple and self-healing (a dead target just goes stale) but has scrape-interval granularity; a push/streaming path catches sub-scrape spikes at the cost of more moving parts.
- *Broker-native vs external lag:* `kafka-consumer-groups.sh` is zero-infra but point-in-time; Burrow is continuous and smarter (it judges *stalled* vs *behind*) but is another service to operate.

## 7. Common Mistakes & Best Practices

- **Alerting on non-zero lag instead of rising lag.** A healthy busy system always has some lag. Alert on positive slope over a window, interpreted against throughput (time-to-drain), not on a raw threshold.
- **Watching only broker liveness.** A Kafka broker whose port answers can still have under-replicated partitions silently degrading durability. Health is replication, not a ping.
- **Ignoring under-replicated partitions.** URP > 0 is the single most important Kafka alert and the one teams most often omit until a second failure loses data.
- **Forgetting the DLQ.** A dead-letter queue that grows unmonitored is silent data loss — messages your system decided it could never process, piling up where nobody looks. Alert on DLQ growth.
- **Missing RabbitMQ resource alarms.** When memory or disk crosses the watermark, RabbitMQ *blocks publishers*, which manifests as mysterious application-side hangs. Watch the alarms and the headroom before them.
- **Measuring latency with unsynced clocks.** End-to-end latency across producer and consumer requires NTP; without it the number is fiction.
- **No consumer-lag for stopped consumers.** A consumer that has *stopped* has no active member; its lag grows silently and some tools stop reporting it. Alert on missing group members too.
- **Best practice: define a golden signal set per broker and alert on only those.** Kafka: URP, offline partitions, active-controller, rising lag, request-latency p99. RabbitMQ: memory/disk alarms, queue depth growth, unacked stuck, DLQ growth. Everything else is dashboard context, not a pager rule.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When lag alerts fire, the diagnostic sequence is: is it *one* partition/queue or all? One partition behind while others are flat means a data skew (a hot key sending too much to one partition, chapter 22) or a slow-to-process message on that partition; all partitions behind means the consumer group as a whole is under-provisioned or stuck on a downstream dependency. Cross-reference lag with the consumer's own processing-time metric and its downstream call latency — lag rising while consumer CPU is idle points at a slow downstream, not the broker.
- **Monitoring.** This chapter *is* the monitoring chapter, but the meta-point is layering: broker health (URP, alarms), flow (lag, depth, throughput), and business latency (end-to-end) are three tiers, and an incident usually shows a symptom in one that is caused in another — high end-to-end latency (tier 3) caused by rising lag (tier 2) caused by an under-replicated broker doing extra recovery work (tier 1). Dashboards should stack the three so the causal chain is visible.
- **Security.** Metrics endpoints leak topology and volumes (queue names, message rates) that an attacker finds useful for reconnaissance — put the `/metrics` and JMX ports behind the internal network and authentication, never public. JMX in particular has historically been an RCE vector if exposed; bind it to localhost and scrape via the exporter (chapter 29).
- **Scaling.** Monitoring is what makes scaling *decisions* possible: you add consumers when lag rises and time-to-drain lengthens, add partitions when a single group has hit its parallelism ceiling (consumers = partitions and still behind), and add brokers when per-broker throughput or disk approaches its limit. The metric that confirms a scaling action worked is lag returning to flat at the new, higher throughput (chapter 28).

## 9. Interview Questions

**Q: What is consumer lag and why is it the most important messaging metric?**
A: Consumer lag is how far behind a consumer is from the tip of the stream — on Kafka, `log-end-offset − committed-offset` per partition per group; on RabbitMQ, the queue depth (`messages_ready`). It is the master metric because it is a rate signal in disguise: its trend equals the produce rate minus the consume rate integrated over time, so a rising slope means consumers cannot keep up and tells you exactly how fast you are falling behind. It is the earliest, clearest warning that the buffer is turning into an outage — it moves before the disk fills, before retention expires, before users complain.

**Q: What is the RabbitMQ equivalent of Kafka consumer lag?**
A: Queue depth, specifically `messages_ready` — the number of messages sitting in a queue ready to be delivered but not yet sent to a consumer. It plays the same role: a rising depth means consumers are not draining as fast as producers fill. The nuance is that RabbitMQ also exposes `messages_unacknowledged` (delivered but not yet acked), which catches a different failure — a consumer that grabbed messages up to its prefetch limit and then wedged without acking, so they are neither processed nor redelivered.

**Q: Why should you alert on rising lag rather than lag above a fixed number?**
A: Because a healthy busy system always carries some lag, and the raw number is meaningless without the consume rate. A lag of two million on a group that processes half a million per second drains in four seconds — a blip. A lag of fifty thousand that is growing on a group processing a hundred per second is an emergency. A fixed threshold false-alarms on the first and misses the second. The correct signal is the slope (is lag rising?) interpreted as time-to-drain (lag divided by consume rate). You accept a slightly longer evaluation window in exchange for alerts that mean something.

**Q: What is the single most important Kafka broker-health alert and why?**
A: Under-replicated partitions greater than zero. Kafka rarely fails by the process dying; it fails by staying alive while replicas fall behind, so a partition's in-sync replica set shrinks below the replication factor. With RF=3 and min.insync=2, one replica falling out leaves you at 2 — producing still works, but you have lost your redundancy margin, and one more failure either makes the partition read-only or loses data. URP is the earliest structural sign that your durability contract is degraded, which is exactly what you want to know before, not after, the second failure.

**Q: What are offline partitions and active-controller-count, and what values are healthy?**
A: Offline partitions are partitions with no active leader; they are unavailable for reads and writes, so the healthy value is always zero — anything above zero is an outage for those partitions. Active-controller-count is per-broker; summed across the cluster it must equal exactly one. Zero means there is no controller, so no leadership changes or metadata updates can happen — a cluster-wide crisis. More than one means split brain, two brokers each believing they are the controller, which corrupts metadata. Both are canary metrics you scrape from every broker.

**Q: How do you monitor RabbitMQ, and what stops the world?**
A: Enable the `rabbitmq_prometheus` plugin, which exposes a `/metrics` endpoint natively (no sidecar), and scrape per-queue depth, unacked counts, publish/deliver rates, consumer utilisation, memory and connection stats. The things that stop the world are the memory alarm and the disk-free alarm: when memory crosses the high watermark (default 40% of RAM) or free disk drops below the limit, RabbitMQ blocks all publishers to protect itself. From the application side that looks like the broker hanging, so watching those alarms and the headroom before them is as important on RabbitMQ as under-replicated partitions is on Kafka.

**Q: Why can't the broker give you end-to-end latency, and how do you get it?**
A: Because end-to-end latency spans two clocks — the producer's, when the message was created, and the consumer's, when it was processed — and the broker sees neither. You get it by stamping the produce timestamp in a message header and, on consume, subtracting it from the current time, recording the result in a histogram so you can read p99 and not just the mean. The catch is that it is only as accurate as the NTP sync between the two hosts; skewed clocks produce plausible-looking nonsense.

**Q: (Senior) A latency alert fires but broker CPU and lag look normal. Walk through your diagnosis.**
A: I would treat this as a three-tier problem and locate which tier the cause is in. Tier three is the symptom — high end-to-end latency. Tier two is flow: I check whether lag is genuinely flat or just flat *on average* while one partition spikes; a single hot partition (a skewed key) can inflate tail latency for that key's messages while aggregate lag looks fine. Tier one is broker health: even with normal CPU, an under-replicated partition triggers replica recovery that adds request latency, and a GC pause on the leader adds tail latency invisible in one-minute-averaged CPU. If all three broker tiers are clean, the latency is almost certainly in the consumer's own processing or its downstream calls — the message is being *delivered* promptly but the handler is slow, which end-to-end latency captures but broker metrics never would. So I would cross-reference the e2e histogram with the consumer's handler-time and downstream-call histograms; if handler-time tracks the e2e tail, the broker is exonerated and the problem is downstream. The discipline is that end-to-end latency is a composite, and you debug it by decomposing it into produce-wait, broker-time, delivery, and handler-time, each of which has its own metric.

**Q: (Senior) How do you design an alerting set that detects real problems without causing alert fatigue?**
A: I start from the principle that alerts are for detection when nobody is looking, and dashboards are for investigation when someone already is — so the alert set must be small, high-signal, and each rule must correspond to a genuine "wake a human" condition. I define a golden set per broker: for Kafka, under-replicated partitions over zero, offline partitions over zero, active-controller not equal to one, consumer lag rising over a threshold interpreted against throughput, and request-latency p99 breaching SLO; for RabbitMQ, the memory and disk alarms, queue-depth growth, stuck unacknowledged messages, and DLQ growth. Everything else — per-topic byte rates, connection counts, GC stats — is dashboard context, not a pager rule, because it helps you investigate but should not by itself wake someone. Each rule gets a `for:` duration so a transient blip does not page, a severity that routes page-worthy versus ticket-worthy differently, and a threshold expressed as a slope or a rate rather than a raw level wherever the underlying quantity is naturally noisy. I also review firing history periodically and delete or retune any alert that has fired more than a couple of times without corresponding to a real action taken — an alert nobody acts on is training people to ignore the pager, which is more dangerous than not having it. The test of a good alerting set is that when the pager goes off, the on-call's default assumption is "this is real", and that trust is a resource you spend every time you let a noisy rule survive.

**Q: (Senior) Your DLQ has been growing for a week and nobody noticed. What went wrong and how do you prevent recurrence?**
A: What went wrong is a monitoring gap that is depressingly common: the dead-letter queue is where the system quietly files messages it has decided it can never process, and because those messages have already "left" the main flow, the main-flow metrics — lag, throughput, latency — all look perfectly healthy while data quietly accumulates in a corner nobody watches. Growing DLQ depth is silent data loss in slow motion: each of those messages represents an event the business intended to happen that did not. The immediate fix is to alert on DLQ growth specifically — any sustained positive slope on a queue matching the DLQ naming convention should raise at least a ticket, because a healthy DLQ is either empty or drained by a deliberate redrive process, never monotonically growing. To prevent recurrence structurally I would make DLQ monitoring a required part of the definition-of-done for any consumer: you do not ship a consumer with a DLQ without also shipping the alert on that DLQ's growth and a documented redrive procedure. I would also add a business-level check where possible — the DLQ depth compared against the main-flow volume, so a DLQ taking even one percent of traffic flags a systemic problem (a bad deploy, a schema change, a poison-message pattern) rather than the occasional genuinely-unprocessable message. The deeper lesson is that anything that removes work from the happy path — DLQs, discarded messages, dropped-on-overflow — must have its own explicit alert, because by construction the happy-path metrics will look fine while it fails.

## 10. Quick Revision & Cheat Sheet

| Metric | Kafka | RabbitMQ | Alert when |
|---|---|---|---|
| **Lag / backlog** | LEO − committed offset (per partition/group) | `messages_ready` (queue depth) | Rising over threshold vs throughput |
| **In-flight** | (implicit in un-committed) | `messages_unacknowledged` | High and stuck |
| **Durability health** | under-replicated partitions | mirror/quorum member down | URP > 0 |
| **Availability** | offline partitions, active-controller | memory/disk alarms | offline > 0; controller ≠ 1; alarm set |
| **Throughput** | BytesIn/OutPerSec | publish/deliver rate | Sudden drop |
| **Latency** | request TotalTimeMs p99 | end-to-end (custom) | p99 breaches SLO |
| **DLQ** | dead-letter topic size | DLX queue depth | Any sustained growth |

| Scrape path | Kafka | RabbitMQ |
|---|---|---|
| **Exporter** | JMX exporter (sidecar) + kafka_exporter/Burrow for lag | `rabbitmq_prometheus` plugin (built-in) |
| **CLI** | `kafka-consumer-groups.sh --describe` | `rabbitmqctl list_queues` / `rabbitmqadmin` |

**Flash cards**
- **#1 messaging metric?** → Consumer lag (Kafka) / queue depth (RabbitMQ) — are consumers keeping up?
- **Alert on lag level or slope?** → Slope (rising), read as time-to-drain = lag / consume_rate.
- **Most important Kafka broker alert?** → Under-replicated partitions > 0 (durability degraded).
- **What stops RabbitMQ?** → Memory or disk alarm → publishers blocked.
- **Active-controller-count healthy value?** → Exactly 1 cluster-wide (0 = no controller, >1 = split brain).
- **Why watch the DLQ?** → It grows silently while all happy-path metrics look fine.

## 11. Hands-On Exercises & Mini Project

- [ ] Run `kafka-consumer-groups.sh --describe` on a group and read the LAG column per partition; identify the most-behind partition.
- [ ] Enable `rabbitmq_prometheus`, curl the `/metrics` endpoint, and find `rabbitmq_queue_messages_ready` for one queue.
- [ ] Stop a consumer and watch lag/depth rise; restart it and watch it drain, then compute the observed catch-up rate.
- [ ] Write a Prometheus rule that fires on *rising* lag (using `deriv`) and confirm it does not fire on a stable-but-high lag.
- [ ] Deliberately shrink an ISR (stop one replica broker) and watch `kafka_under_replicated_partitions` go above zero.
- [ ] Add the produce-time header + consume-side observation and plot the p99 end-to-end latency histogram.

### Mini Project — "The Golden Signals Dashboard"

**Goal.** Build a single dashboard and alert set that would let an on-call engineer detect and localise any lag or health problem on both a Kafka and a RabbitMQ cluster.

**Requirements.**
1. Stand up Prometheus + Grafana, a Kafka cluster with the JMX exporter and kafka_exporter (or Burrow), and RabbitMQ with `rabbitmq_prometheus`.
2. Build a dashboard with three stacked tiers: broker health (URP, offline partitions, controller, RabbitMQ alarms), flow (per-group lag, per-queue depth, throughput), and latency (request p99 and custom end-to-end).
3. Write the golden alert set: URP > 0, rising lag, growing queue depth, growing DLQ, broker down, RabbitMQ resource alarms — each with a sensible `for:` and severity.
4. Instrument a producer/consumer pair with the produce-time header and export end-to-end latency as a histogram.
5. Induce three failures (slow consumer, stopped replica, blocked publisher via memory alarm) and confirm the dashboard localises each and the correct alert fires.

**Extensions.**
- Add time-to-drain as a computed panel (`lag / rate`) and alert on it exceeding your retention window minus a safety margin.
- Add a DLQ-to-main-flow ratio panel and alert when the DLQ takes more than 1% of traffic.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Delivery Guarantees* (why at-least-once makes lag and redelivery central), *Ordering, Partitioning & Keys* (why one hot partition shows up as skewed per-partition lag), *Backpressure, Flow Control & Poison Messages* (what rising lag ultimately becomes), *Performance Tuning & Capacity Planning* (turning throughput trends into scaling actions), *Security & Multi-Tenancy* (locking down the metrics and JMX endpoints).

- **Apache Kafka — Monitoring** — Apache · *Intermediate* · the authoritative list of broker, producer and consumer JMX metrics, including under-replicated partitions and request latency. <https://kafka.apache.org/documentation/#monitoring>
- **Burrow — Kafka Consumer Lag Checking** — LinkedIn · *Advanced* · the purpose-built lag monitor that judges *stalled* versus *behind* rather than a raw threshold. <https://github.com/linkedin/Burrow>
- **RabbitMQ — Monitoring** — RabbitMQ · *Intermediate* · the definitive guide to what to watch (depth, unacked, memory/disk alarms, consumer utilisation) and how. <https://www.rabbitmq.com/docs/monitoring>
- **RabbitMQ — Prometheus & Grafana** — RabbitMQ · *Intermediate* · enabling `rabbitmq_prometheus` and the official Grafana dashboards. <https://www.rabbitmq.com/docs/prometheus>
- **Prometheus JMX Exporter** — Prometheus · *Intermediate* · the Java agent that turns Kafka's JMX beans into a scrapeable endpoint, with example configs. <https://github.com/prometheus/jmx_exporter>
- **kafka_exporter** — Daniel Qian et al. · *Intermediate* · a standalone exporter that continuously computes consumer-group lag for Prometheus. <https://github.com/danielqsj/kafka_exporter>
- **Monitoring Kafka with JMX** — Confluent · *Intermediate* · Confluent's practical treatment of the broker metrics that matter and how to alert on them. <https://docs.confluent.io/platform/current/kafka/monitoring.html>
- **Google SRE Book — Monitoring Distributed Systems (Golden Signals)** — Google · *Advanced* · the framing (latency, traffic, errors, saturation) behind choosing a small, meaningful signal set. <https://sre.google/sre-book/monitoring-distributed-systems/>

---

*Kafka & RabbitMQ Handbook — chapter 27.*
