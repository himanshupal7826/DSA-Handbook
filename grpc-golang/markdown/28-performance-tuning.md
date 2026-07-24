# 28 · Performance Tuning: Message Size, Compression, Pooling & Benchmarks

> **In one line:** gRPC is fast by default, so almost every tuning opportunity is either a limit you should have set, a window sized for the wrong bandwidth-delay product, or an allocation you can avoid — and none of it matters until you have measured where the time actually goes.

---

## 1. Overview

Most gRPC performance work fails because it starts with a guess. Someone enables gzip, raises the window sizes, adds a connection pool, and the p99 does not move — because the service was spending 40 ms in a database and 0.3 ms in gRPC.

So the first principle is **measure the split**. A gRPC call's latency decomposes into: connection setup (amortised to ~0 on a warm connection), serialisation, transport including flow-control waits, the handler's own work, and deserialisation. Only two of those are gRPC's, and in most services they are a small fraction. `ghz` gives you the end-to-end distribution; pprof tells you where the CPU goes; the trace from chapter 26 tells you which hop is slow.

When gRPC *is* the bottleneck, the causes cluster into four groups:

1. **Limits and windows** — `MaxRecvMsgSize` rejecting valid traffic, or a 64 KiB flow-control window capping throughput on a high-latency link.
2. **Allocation pressure** — protobuf marshalling allocating per call, driving GC, which shows up as p99 latency rather than CPU.
3. **Concurrency structure** — one connection hitting `MaxConcurrentStreams`, or a stream blocked on a slow consumer.
4. **Payload shape** — messages that are larger than they need to be, or a chatty call pattern that should have been one batched call.

Compression sits slightly apart: it trades CPU for bytes, and whether that is a good trade depends entirely on your link. On a datacentre network it is usually a loss.

## 2. Core Concepts

- **`MaxRecvMsgSize` / `MaxSendMsgSize`** — per-message limits. Receive defaults to 4 MiB; **send is unlimited**.
- **`InitialWindowSize` / `InitialConnWindowSize`** — HTTP/2 flow-control windows, 64 KiB by default, auto-tuned via BDP estimation unless you override them.
- **BDP** — bandwidth-delay product: `bandwidth × RTT`. The in-flight bytes needed to saturate a link.
- **`MaxConcurrentStreams`** — per-connection concurrency cap; grpc-go's server default is effectively unlimited.
- **`UseCompressor` / `RegisterCompressor`** — per-call or default compression, negotiated per message.
- **`MarshalAppend` + `sync.Pool`** — reusing buffers to avoid an allocation per marshal.
- **`ghz`** — the gRPC load generator; reports RPS and a latency distribution.
- **pprof** — CPU, heap, goroutine and block profiles; the only reliable way to find where time and allocations go.
- **`GOGC` / `GOMEMLIMIT`** — Go's GC controls; the usual lever when p99 is GC-driven.
- **Chatty vs chunky** — many small calls versus few large ones. Batching usually beats micro-optimising.

## 3. Theory & Principles

### Where the time actually goes

For a warm connection and a small message, a rough decomposition on modern hardware:

| Component | Typical | Notes |
|---|---|---|
| Protobuf marshal | 0.5–5 µs | Scales with field count, not just bytes |
| HTTP/2 framing + write | 1–3 µs | |
| Network RTT | 0.1–1 ms (LAN), 10–100 ms (WAN) | **Usually dominant** |
| Server dispatch + interceptors | 5–50 µs | Depends on chain length (chapter 23) |
| Handler work | 0.1 ms – seconds | **Usually dominant** |
| Protobuf unmarshal | 0.5–5 µs | |

The lesson: for typical services, gRPC's own overhead is tens of microseconds against a handler measured in milliseconds. Optimising serialisation when the handler does a database query is measuring the wrong thing.

gRPC *does* become the bottleneck in specific shapes: very high QPS with tiny messages (framing and interceptor overhead dominate), very large messages (allocation and copying dominate), high-BDP links (flow control dominates), and fan-out patterns where connection concurrency limits throughput.

### Windows and the bandwidth-delay product

This is the single most impactful knob when it applies, and irrelevant otherwise.

Each stream starts with a 64 KiB flow-control window. A sender may have at most that many unacknowledged bytes outstanding. So the maximum single-stream throughput is:

```
throughput ≤ window / RTT
```

At 64 KiB and 1 ms RTT that is ~512 Mbit/s — fine. At 64 KiB and 100 ms RTT it is ~5 Mbit/s — a catastrophic cap on a gigabit link.

The fix is to size the window to the BDP: `bandwidth × RTT`. For 1 Gbit/s at 100 ms, that is about 12 MiB. But there is a catch: **setting `InitialWindowSize` above 64 KiB disables grpc-go's dynamic BDP auto-tuning**, so you lose the adaptive behaviour and must get the static number right. Only override with a measurement in hand, and remember the memory cost is per stream.

### Compression: usually a loss inside a datacentre

gzip typically achieves 3–10× on JSON-like text and much less on protobuf, which is already compact and has no field names to compress. The costs are 10–50 µs of CPU per message each way, plus allocation.

| Scenario | Compress? |
|---|---|
| Datacentre, small messages (<1 KiB) | **No** — CPU cost exceeds the byte saving |
| Datacentre, large repetitive messages (>100 KiB) | Maybe — measure |
| Mobile or metered links | **Yes** — bytes cost more than CPU |
| Cross-region with bandwidth charges | Usually yes |
| Already-compressed payloads (images, video) | **Never** — you pay CPU for nothing |

Compression is negotiated per message via the compressed-flag byte (chapter 3), so it can be enabled per call with `grpc.UseCompressor(gzip.Name)` rather than globally — which is the right granularity, because the answer differs per method.

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Measure the split before tuning anything</text>

  <rect x="24" y="42" width="832" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">A typical warm-connection unary call</text>

  <rect x="48" y="80" width="30" height="24" rx="3" fill="#dcfce7" stroke="#16a34a"/>
  <text x="63" y="118" text-anchor="middle" fill="#15803d" font-size="9">marshal</text>
  <text x="63" y="130" text-anchor="middle" fill="#166534" font-size="8">~2 &#181;s</text>

  <rect x="80" y="80" width="24" height="24" rx="3" fill="#dcfce7" stroke="#16a34a"/>
  <text x="92" y="146" text-anchor="middle" fill="#15803d" font-size="9">framing</text>
  <text x="92" y="158" text-anchor="middle" fill="#166534" font-size="8">~2 &#181;s</text>

  <rect x="106" y="80" width="120" height="24" rx="3" fill="#fef3c7" stroke="#d97706"/>
  <text x="166" y="118" text-anchor="middle" fill="#92400e" font-size="9">network RTT</text>
  <text x="166" y="130" text-anchor="middle" fill="#b45309" font-size="8">0.5 ms</text>

  <rect x="228" y="80" width="48" height="24" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <text x="252" y="146" text-anchor="middle" fill="#1e40af" font-size="9">interceptors</text>
  <text x="252" y="158" text-anchor="middle" fill="#1d4ed8" font-size="8">~30 &#181;s</text>

  <rect x="278" y="80" width="500" height="24" rx="3" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="528" y="97" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">HANDLER WORK &#8212; database query, 40 ms</text>

  <rect x="780" y="80" width="28" height="24" rx="3" fill="#dcfce7" stroke="#16a34a"/>
  <text x="794" y="118" text-anchor="middle" fill="#15803d" font-size="9">unmarshal</text>

  <text x="48" y="182" fill="#b91c1c" font-weight="bold">gRPC's own overhead is ~35 &#181;s against a 40 ms handler. Enabling gzip here moves nothing.</text>

  <rect x="24" y="212" width="410" height="270" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="234" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Flow control and the BDP</text>
  <text x="42" y="258" fill="#1e40af" font-family="ui-monospace,monospace" font-size="11" font-weight="bold">throughput &#8804; window / RTT</text>
  <text x="42" y="284" fill="#166534" font-size="10">64 KiB / 1 ms RTT &#8594; ~512 Mbit/s &#8212; fine on a LAN</text>
  <text x="42" y="306" fill="#b91c1c" font-size="10" font-weight="bold">64 KiB / 100 ms RTT &#8594; ~5 Mbit/s on a 1 Gbit link</text>
  <text x="42" y="328" fill="#1d4ed8" font-size="10">Fix: size the window to bandwidth &#215; RTT.</text>
  <text x="42" y="344" fill="#1d4ed8" font-size="10">1 Gbit/s &#215; 100 ms &#8776; 12 MiB.</text>
  <text x="42" y="370" fill="#b91c1c" font-size="10" font-weight="bold">THE CATCH:</text>
  <text x="42" y="388" fill="#991b1b" font-size="10">Setting InitialWindowSize above 64 KiB DISABLES</text>
  <text x="42" y="404" fill="#991b1b" font-size="10">grpc-go's dynamic BDP auto-tuning. You lose the</text>
  <text x="42" y="420" fill="#991b1b" font-size="10">adaptive behaviour and must get the static number right.</text>
  <text x="42" y="444" fill="#1e40af" font-size="10" font-weight="bold">Only override with a measurement in hand.</text>
  <text x="42" y="464" fill="#1d4ed8" font-size="10">Memory cost is PER STREAM &#8212; 12 MiB &#215; 1000 streams.</text>

  <rect x="446" y="212" width="410" height="270" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="651" y="234" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Compression: usually a loss in a datacentre</text>
  <text x="464" y="258" fill="#713f12" font-size="10">protobuf is already compact and has no field names</text>
  <text x="464" y="274" fill="#713f12" font-size="10">to compress. gzip costs 10&#8211;50 &#181;s each way, plus allocation.</text>
  <g font-size="10">
    <text x="464" y="302" fill="#b91c1c" font-weight="bold">No</text>
    <text x="520" y="302" fill="#991b1b">datacentre, messages &lt; 1 KiB</text>
    <text x="464" y="324" fill="#854d0e" font-weight="bold">Maybe</text>
    <text x="520" y="324" fill="#713f12">datacentre, large repetitive messages &gt; 100 KiB</text>
    <text x="464" y="346" fill="#15803d" font-weight="bold">Yes</text>
    <text x="520" y="346" fill="#166534">mobile / metered links &#8212; bytes cost more than CPU</text>
    <text x="464" y="368" fill="#15803d" font-weight="bold">Yes</text>
    <text x="520" y="368" fill="#166534">cross-region with bandwidth charges</text>
    <text x="464" y="390" fill="#b91c1c" font-weight="bold">Never</text>
    <text x="520" y="390" fill="#991b1b">already-compressed payloads (images, video)</text>
  </g>
  <text x="464" y="422" fill="#854d0e" font-size="10" font-weight="bold">Negotiated PER MESSAGE, so enable it per call:</text>
  <text x="464" y="440" fill="#713f12" font-family="ui-monospace,monospace" font-size="10">grpc.UseCompressor(gzip.Name)</text>
  <text x="464" y="462" fill="#713f12" font-size="10">That is the right granularity &#8212; the answer differs per method.</text>
</svg>
```

### Allocation and GC: where p99 hides

In Go, tail latency is often GC latency. A service allocating heavily per request causes frequent GC cycles, and although Go's collector is concurrent with sub-millisecond pauses, the assist mechanism makes allocating goroutines do collection work — which shows up as p99 latency, not as a CPU spike.

The gRPC-specific allocation sources:

- **Marshal buffers** — one allocation per outgoing message. `proto.MarshalOptions{}.MarshalAppend(buf[:0], m)` with a pooled buffer removes it.
- **Message structs** — one per incoming message. Unavoidable in general, though `sync.Pool` helps on very hot paths.
- **Metadata maps** — one per call with metadata.
- **Interceptor closures and slices** — small, but multiplied by chain length and QPS.

Measure with `go test -bench -benchmem` and a heap profile before optimising any of this. And prefer `GOGC`/`GOMEMLIMIT` tuning first: raising `GOGC` from 100 to 400 on a service with headroom often does more for p99 than any code change.

### Chatty versus chunky

The largest performance wins are usually structural, not tuning. A call pattern that makes 100 unary calls to fetch 100 items pays 100 round trips, 100 auth checks, 100 interceptor chains and 100 trace spans. One `BatchGetItems` call pays one of each.

Before tuning windows or enabling compression, ask whether the *call pattern* is right — and note that this is a schema decision (chapter 11), so it must be designed rather than retrofitted.

## 4. Architecture & Workflow

**The tuning procedure**, in order — each step is cheaper than the next:

1. **Measure end-to-end** with `ghz` at realistic concurrency and payload size. Record RPS and the full latency distribution.
2. **Split the latency** using traces (chapter 26): how much is gRPC, how much is the handler, how much is downstream.
3. **Profile CPU and heap** with pprof if gRPC's share is significant.
4. **Fix the structural problem first** — chatty call patterns, N+1 fan-out, oversized messages.
5. **Then tune limits** — message sizes, `MaxConcurrentStreams`.
6. **Then windows**, but only if BDP arithmetic says they are the cap.
7. **Then allocation** — buffer pooling, `GOGC`.
8. **Compression last**, and only where the link makes it pay.
9. **Re-measure after each change.** A change you did not measure is a change you cannot defend.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="pf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Structural wins beat tuning &#8212; every time</text>

  <rect x="24" y="42" width="410" height="196" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Chatty: 100 unary calls</text>
  <g stroke="#dc2626" stroke-width="1.2">
    <path d="M60,86 L390,86"/><path d="M60,96 L390,96"/><path d="M60,106 L390,106"/>
    <path d="M60,116 L390,116"/><path d="M60,126 L390,126"/><path d="M60,136 L390,136"/>
  </g>
  <text x="225" y="156" text-anchor="middle" fill="#991b1b" font-size="9">&#8230; &#215;100</text>
  <g font-size="10" fill="#991b1b">
    <text x="42" y="180">100 round trips &#183; 100 auth checks</text>
    <text x="42" y="198">100 interceptor chains &#183; 100 trace spans</text>
    <text x="42" y="216">100 &#215; per-call framing and metadata</text>
  </g>
  <text x="42" y="234" fill="#7f1d1d" font-size="10" font-weight="bold">No amount of window tuning fixes this.</text>

  <rect x="446" y="42" width="410" height="196" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Chunky: one BatchGetItems</text>
  <rect x="480" y="86" width="342" height="50" rx="5" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="116" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">1 call, 100 items</text>
  <g font-size="10" fill="#166534">
    <text x="464" y="162">1 round trip &#183; 1 auth check</text>
    <text x="464" y="180">1 interceptor chain &#183; 1 trace span</text>
    <text x="464" y="198">amortised framing and metadata</text>
  </g>
  <text x="464" y="222" fill="#15803d" font-size="10" font-weight="bold">A SCHEMA decision (chapter 11) &#8212; design it,</text>
  <text x="464" y="234" fill="#15803d" font-size="10" font-weight="bold">you cannot retrofit it cheaply.</text>

  <rect x="24" y="258" width="832" height="164" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="280" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The tuning order &#8212; each step cheaper than the next</text>

  <rect x="44" y="296" width="118" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="103" y="313" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">1. measure</text>
  <text x="103" y="328" text-anchor="middle" fill="#1d4ed8" font-size="9">ghz + traces</text>
  <path d="M164,316 L180,316" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pf1)"/>
  <rect x="184" y="296" width="118" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="243" y="313" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">2. profile</text>
  <text x="243" y="328" text-anchor="middle" fill="#1d4ed8" font-size="9">pprof CPU + heap</text>
  <path d="M304,316 L320,316" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pf1)"/>
  <rect x="324" y="296" width="140" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="394" y="313" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">3. STRUCTURE</text>
  <text x="394" y="328" text-anchor="middle" fill="#166534" font-size="9">batch, de-N+1, shrink</text>
  <path d="M466,316 L482,316" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pf1)"/>
  <rect x="486" y="296" width="112" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="542" y="313" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">4. limits</text>
  <text x="542" y="328" text-anchor="middle" fill="#b45309" font-size="9">sizes, streams</text>
  <path d="M600,316 L616,316" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pf1)"/>
  <rect x="620" y="296" width="106" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="673" y="313" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">5. windows</text>
  <text x="673" y="328" text-anchor="middle" fill="#b45309" font-size="9">only if BDP-capped</text>
  <path d="M728,316 L744,316" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pf1)"/>
  <rect x="748" y="296" width="94" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="795" y="313" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">6. alloc/GC</text>
  <text x="795" y="328" text-anchor="middle" fill="#6d28d9" font-size="9">pools, GOGC</text>

  <text x="44" y="362" fill="#334155" font-weight="bold">7. Compression LAST, and only where the link makes it pay.</text>
  <text x="44" y="384" fill="#475569">8. Re-measure after EVERY change. A change you did not measure is a change you cannot defend &#8212;</text>
  <text x="44" y="400" fill="#475569">and in practice about half of "obvious" optimisations turn out to be neutral or negative.</text>
</svg>
```

## 5. Implementation

### Benchmarking with `ghz`

```bash
go install github.com/bojand/ghz/cmd/ghz@latest

# Baseline: fixed concurrency, fixed duration, realistic payload.
ghz --insecure \
  --proto ./proto/acme/inventory/v1/inventory.proto \
  --call acme.inventory.v1.InventoryService/GetItem \
  -d '{"sku":"sku_01HQ8ZK3M4A"}' \
  -c 50 -z 30s \
  --connections 5 \
  localhost:50051

# Sweep concurrency to find the knee: throughput stops rising and latency
# starts climbing linearly — that point is your capacity.
for c in 1 10 50 100 200 500; do
  echo "=== concurrency $c ==="
  ghz --insecure --proto ... --call ... -d '{"sku":"sku_1"}' \
      -c $c -n 20000 --connections 5 localhost:50051 \
      -O json | jq '{rps:.rps, p50:.latencyDistribution[3].latency,
                      p95:.latencyDistribution[5].latency,
                      p99:.latencyDistribution[6].latency}'
done

# Payload sweep: find where message size starts to matter.
for size in 1 10 100 1000; do
  ghz --insecure --proto ... --call ... \
      -d "$(jq -n --argjson n $size '{skus: [range($n) | "sku_\(.)"]}')" \
      -c 50 -z 20s localhost:50051
done
```

`--connections` matters: `ghz` defaults to one, which means every request shares one HTTP/2 connection and you may be measuring `MaxConcurrentStreams` rather than the server.

### Micro-benchmarks that isolate the layer

```go
package inventory_test

import (
	"context"
	"testing"

	"google.golang.org/protobuf/proto"
)

// BenchmarkMarshal isolates serialisation cost. Run with -benchmem: allocation
// count is usually more actionable than ns/op, because allocations drive GC and
// GC drives p99.
func BenchmarkMarshal(b *testing.B) {
	item := largeItem(100) // 100 repeated elements

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := proto.Marshal(item); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkMarshalPooled shows the win from reusing buffers: MarshalAppend
// writes into an existing slice, so the per-call allocation disappears.
//
// Worth doing ONLY on measured hot paths — it adds complexity and a real
// hazard: returning a pooled buffer to the pool before the transport has
// finished with it is a use-after-free.
func BenchmarkMarshalPooled(b *testing.B) {
	item := largeItem(100)

	pool := sync.Pool{New: func() any {
		buf := make([]byte, 0, 4096)
		return &buf
	}}

	opts := proto.MarshalOptions{}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bufp := pool.Get().(*[]byte)
		buf, err := opts.MarshalAppend((*bufp)[:0], item)
		if err != nil {
			b.Fatal(err)
		}
		_ = buf
		*bufp = buf
		pool.Put(bufp)
	}
}

// BenchmarkEndToEnd measures the full stack over bufconn (chapter 27) — the
// gRPC overhead with the network removed, which isolates serialisation,
// framing, dispatch and the interceptor chain.
func BenchmarkEndToEnd(b *testing.B) {
	f := newBenchFixture(b)
	ctx := context.Background()
	req := &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3M4A"}

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := f.client.GetItem(ctx, req); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkInterceptorOverhead quantifies the chain's own cost against a
// no-op handler. Ten interceptors at 10 µs each is 100 µs — 10% of a 1 ms
// method and invisible on a 100 ms one.
func BenchmarkInterceptorOverhead(b *testing.B) {
	for _, n := range []int{0, 3, 5, 10} {
		b.Run(fmt.Sprintf("interceptors=%d", n), func(b *testing.B) {
			f := newBenchFixture(b, withNInterceptors(n))
			ctx := context.Background()
			req := &inventoryv1.GetItemRequest{Sku: "sku_1"}

			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, _ = f.client.GetItem(ctx, req)
			}
		})
	}
}
```

### Server tuning options, with the reasoning

```go
func tunedServer() *grpc.Server {
	return grpc.NewServer(
		// --- Limits: DoS defences first, tuning second ---------------------
		// Enforced against the 4-byte length prefix BEFORE allocation, so
		// this is a genuine memory-exhaustion defence, not a nicety.
		grpc.MaxRecvMsgSize(16<<20),
		// Defaults to UNLIMITED. A handler that accidentally returns a million
		// rows will happily try to serialise them.
		grpc.MaxSendMsgSize(16<<20),

		// grpc-go's default is effectively unlimited, and there is one
		// goroutine per in-flight stream — so this is a memory control.
		// Pick it from a load test, not from a round number.
		grpc.MaxConcurrentStreams(2000),

		// --- Flow control: ONLY with BDP arithmetic in hand ------------------
		// Setting either above 64 KiB DISABLES dynamic BDP auto-tuning, and
		// the memory cost is per stream. For a LAN service, leaving these
		// alone is almost always correct.
		//
		// grpc.InitialWindowSize(4 << 20),      // per stream
		// grpc.InitialConnWindowSize(16 << 20), // per connection

		// --- Buffer sizes ----------------------------------------------------
		// Larger buffers reduce syscalls at the cost of memory per connection.
		// Meaningful only at high message rates; measure both.
		grpc.ReadBufferSize(64<<10),
		grpc.WriteBufferSize(64<<10),

		// --- Keepalive (chapters 18, 21) ------------------------------------
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time: 30 * time.Second, Timeout: 10 * time.Second,
			MaxConnectionAge: 30 * time.Minute, MaxConnectionAgeGrace: 30 * time.Second,
		}),
	)
}
```

### Compression, applied where it pays

```go
import (
	"google.golang.org/grpc"
	"google.golang.org/grpc/encoding/gzip"
)

// Server: registering the compressor lets it DECOMPRESS incoming messages.
// Setting a default forces compression on every response, which is usually
// wrong — the decision belongs per method.
srv := grpc.NewServer(
	// Just importing the gzip package registers it for decompression.
	// grpc.RPCCompressor / RPCDecompressor are deprecated; use encoding.
)

// Client: enable per call, so a large export compresses and a small lookup
// does not.
resp, err := client.ExportItems(ctx, req, grpc.UseCompressor(gzip.Name))

// Or as a connection default when every call on it is large.
conn, _ := grpc.NewClient(target,
	grpc.WithDefaultCallOptions(grpc.UseCompressor(gzip.Name)))
```

A benchmark to decide it rather than guess:

```go
// BenchmarkCompression answers the only question that matters: for MY payload
// on MY link, does gzip pay?
func BenchmarkCompression(b *testing.B) {
	for _, size := range []int{100, 1000, 10000} {
		item := largeItem(size)
		raw, _ := proto.Marshal(item)

		b.Run(fmt.Sprintf("size=%d/uncompressed", size), func(b *testing.B) {
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = proto.Marshal(item)
			}
		})

		b.Run(fmt.Sprintf("size=%d/gzip", size), func(b *testing.B) {
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			var buf bytes.Buffer
			for i := 0; i < b.N; i++ {
				buf.Reset()
				w := gzip.NewWriter(&buf)
				data, _ := proto.Marshal(item)
				_, _ = w.Write(data)
				_ = w.Close()
			}
			b.ReportMetric(float64(buf.Len())/float64(len(raw)), "ratio")
		})
	}
}
```

### Profiling a live server

```go
import _ "net/http/pprof"

// Bind pprof to a SEPARATE, private port. Never expose it publicly: the
// profiles disclose code structure, and the endpoints are trivially abusable
// as a CPU sink.
go func() {
	log.Println(http.ListenAndServe("127.0.0.1:6060", nil))
}()
```

```bash
# CPU: where the time goes under load.
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30

# Heap: what is allocating. Usually more actionable than CPU for gRPC services,
# because allocation drives GC and GC drives p99.
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/allocs

# Goroutines: one per in-flight stream, so this diagnoses stuck streams
# (chapter 16) and leaked handlers directly.
curl -s 'http://localhost:6060/debug/pprof/goroutine?debug=2' | head -100

# Blocking: where goroutines wait. Needs SetBlockProfileRate first.
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/block
```

```go
// Block and mutex profiling are off by default because they cost something.
// Enable at a sample rate in staging, or briefly in production under
// investigation.
runtime.SetBlockProfileRate(10000)   // sample 1 in 10,000 blocking events
runtime.SetMutexProfileFraction(100) // sample 1 in 100 contention events
```

### GC tuning: often the biggest single win

```go
// GOGC controls how much heap growth triggers a collection. The default of 100
// collects when the heap doubles. Raising it trades memory for fewer GC cycles,
// and on a service with headroom this frequently does more for p99 than any
// code change — because Go's GC assist makes ALLOCATING goroutines do
// collection work, which shows up as tail latency.
//
//   GOGC=400        // collect when the heap grows 4x
//   GOMEMLIMIT=6GiB // a soft ceiling; GC works harder as you approach it
//
// The modern combination is a high GOGC plus GOMEMLIMIT as a backstop: normal
// operation gets few collections, and a memory spike is bounded rather than
// OOM-killed.
```

```bash
# Measure the effect properly, not by feel.
GOGC=100 ghz ... -O json | jq '{rps, p99: .latencyDistribution[6].latency}'
GOGC=400 GOMEMLIMIT=6GiB ghz ... -O json | jq '{rps, p99: .latencyDistribution[6].latency}'

# And watch what it costs.
curl -s localhost:6060/debug/pprof/heap?debug=1 | grep -E 'HeapAlloc|HeapSys'
```

### Batching: the structural fix

```protobuf
// One round trip, one auth check, one interceptor chain, one trace span —
// instead of 100 of each. Note the explicit bound: an unbounded batch is a
// memory-exhaustion vector, and the limit must be in the schema comment as
// well as in validation.
message BatchGetItemsRequest {
  // Required, 1..1000 entries.
  repeated string skus = 1;
  google.protobuf.FieldMask read_mask = 2;
}

message BatchGetItemsResponse {
  // Partial success is expressible: found items plus per-sku failures, so one
  // missing sku does not fail the whole batch.
  repeated Item items = 1;
  repeated BatchItemError errors = 2;
}

message BatchItemError {
  string sku = 1;
  google.rpc.Status status = 2;
}
```

```go
// A DataLoader-style coalescer turns a burst of concurrent single lookups into
// one batch call, without changing every call site.
type ItemLoader struct {
	client inventoryv1.InventoryServiceClient
	mu     sync.Mutex
	batch  []request
	timer  *time.Timer
}

func (l *ItemLoader) Get(ctx context.Context, sku string) (*inventoryv1.Item, error) {
	ch := make(chan result, 1)

	l.mu.Lock()
	l.batch = append(l.batch, request{sku: sku, ch: ch})
	// Flush on size OR after a short window, whichever comes first: size alone
	// stalls a small burst, time alone wastes the batching opportunity.
	if len(l.batch) >= 100 {
		l.flushLocked(ctx)
	} else if l.timer == nil {
		l.timer = time.AfterFunc(2*time.Millisecond, func() { l.flush(ctx) })
	}
	l.mu.Unlock()

	select {
	case r := <-ch:
		return r.item, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**What gRPC gives you before any tuning**
- **Efficient serialisation** — protobuf is already 5–20× cheaper than JSON in Go.
- **Connection reuse** — one warm connection removes handshake cost entirely.
- **Multiplexing** — concurrency without a connection pool.
- **Adaptive flow control** — BDP auto-tuning handles most links without intervention.

**Where it needs help**
- **Dangerous defaults** — unlimited send size and effectively unlimited concurrent streams.
- **Window auto-tuning has a ceiling**, so very high-BDP links need a manual override.
- **Per-message allocation** on hot paths, which becomes GC pressure.
- **No built-in batching** — a chatty call pattern is a schema problem you must design away.

**Trade-offs**
- *Window size:* larger windows raise single-stream throughput on high-BDP links, disable auto-tuning, and cost memory per stream. Only with BDP arithmetic in hand.
- *Compression:* trades CPU for bytes. Almost always a loss inside a datacentre with small messages, almost always a win on metered mobile links.
- *Buffer pooling:* removes an allocation per call and adds a use-after-free hazard. Only on measured hot paths.
- *`GOGC` high:* fewer collections and better p99, at the cost of a larger resident heap. Pair with `GOMEMLIMIT`.

## 7. Common Mistakes & Best Practices

- **Tuning before measuring.** Most "obvious" optimisations turn out neutral or negative.
- **Enabling gzip everywhere.** On small datacentre messages the CPU cost exceeds the byte saving.
- **Raising window sizes without BDP arithmetic.** You disable auto-tuning and often make things worse.
- **Leaving `MaxSendMsgSize` unset.** It is unlimited by default.
- **Leaving `MaxConcurrentStreams` unset.** One client can spawn unbounded goroutines.
- **Benchmarking with one connection.** You measure `MaxConcurrentStreams`, not the server. Set `ghz --connections`.
- **Optimising serialisation when the handler dominates.** Split the latency first.
- **Ignoring allocation counts.** They drive GC, and GC drives p99 more than CPU does.
- **Connection pooling as a first resort.** One `ClientConn` multiplexes; pool only when a measurement says the stream limit is the cap.
- **Unbounded batch sizes.** A memory-exhaustion vector; bound them in the schema and in validation.
- **Exposing pprof publicly.** It discloses structure and is a trivial CPU sink.
- **Benchmarking on a laptop.** Thermal throttling and a different network make the numbers meaningless.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** For latency, start from a trace (chapter 26) to find the slow hop, then pprof that process. For throughput, check the goroutine profile — one per in-flight stream makes stuck streams obvious — and channelz for connection and stream counts. For memory, a heap profile plus `GODEBUG=gctrace=1`.
- **Monitoring.** Track `proto.Size` percentiles per method: a p99 creeping toward `MaxRecvMsgSize` is an incident forming. Track goroutine count, GC pause time and heap size alongside RPC latency, because tail latency is frequently GC rather than the handler.
- **Security.** Message-size limits and `MaxConcurrentStreams` are DoS controls before they are tuning knobs — an attacker who can send 4 MiB messages at high rate can exhaust memory. Compression introduces a decompression-bomb surface, so keep `MaxRecvMsgSize` enforced on the *decompressed* size. Bind pprof to a private interface.
- **Scaling.** The order that matters: fix the call pattern, then add replicas, then tune. Horizontal scaling only helps if load balancing works (chapter 21) — `pick_first` against a replicated service means adding pods changes nothing. Verify by scaling under load and watching per-pod QPS converge.

## 9. Interview Questions

**Q: Where does time go in a gRPC call?**
A: Connection setup, which is amortised to nothing on a warm connection; serialisation, typically a few microseconds; HTTP/2 framing and the network round trip; server dispatch through the interceptor chain, tens of microseconds; the handler's own work; and deserialisation. For most services the round trip and the handler dominate, and gRPC's own overhead is tens of microseconds against a handler measured in milliseconds. That is why the first step is always to split the latency with a trace rather than to start tuning serialisation.

**Q: When would you change the HTTP/2 window sizes?**
A: When the bandwidth-delay product says the 64 KiB default is the cap. Single-stream throughput is bounded by window divided by round-trip time, so 64 KiB over a 100 ms link is about 5 Mbit/s regardless of how much bandwidth exists. The fix is to size the window to bandwidth times RTT — roughly 12 MiB for a gigabit link at 100 ms. The catch is that setting `InitialWindowSize` above 64 KiB disables grpc-go's dynamic BDP auto-tuning, so you lose the adaptive behaviour and must get the static number right, and the memory cost is per stream.

**Q: Should you enable compression?**
A: Usually not inside a datacentre. Protobuf is already compact and has no field names to compress, so gzip's ratio is modest, while it costs tens of microseconds of CPU each way plus allocation — on messages under a kilobyte that is a straight loss. It pays on metered or mobile links where bytes cost more than CPU, on cross-region traffic with bandwidth charges, and sometimes on very large repetitive payloads. It never pays on already-compressed content. Since it is negotiated per message, enable it per call rather than globally, because the answer differs by method.

**Q: How do you benchmark a gRPC service properly?**
A: `ghz` for end-to-end load, sweeping concurrency to find the knee where throughput stops rising and latency climbs linearly, and sweeping payload size to find where message size starts to matter. Crucially, set `--connections` above one: the default shares a single HTTP/2 connection, so you may be measuring `MaxConcurrentStreams` rather than the server. Alongside that, Go benchmarks with `-benchmem` to isolate marshalling and the interceptor chain, and a bufconn end-to-end benchmark to measure gRPC overhead with the network removed. And run it on hardware resembling production, not a laptop.

**Q: Why does allocation matter more than CPU for tail latency in Go?**
A: Because Go's garbage collector uses an assist mechanism: goroutines that allocate are made to do proportional collection work. So a service allocating heavily per request has its own request-handling goroutines doing GC work, which appears as p99 latency rather than as a CPU spike. That is why `-benchmem` allocation counts are usually more actionable than nanoseconds per operation, and why raising `GOGC` on a service with memory headroom often improves p99 more than any code change.

**Q: When is connection pooling justified?**
A: Rarely. A single `ClientConn` multiplexes concurrent RPCs over HTTP/2 streams, so pooling is not needed for concurrency and costs handshakes, memory and load-balancing complexity. The two legitimate cases are hitting the server's `MaxConcurrentStreams` — common against non-Go implementations that default to 100 — and TCP head-of-line blocking on a lossy or very high-BDP link, where one connection's congestion window caps throughput. Both should be established by measurement, and in the first case raising the server's limit is usually the better fix.

**Q: What is the single biggest performance win in most gRPC systems?**
A: Fixing the call pattern. A hundred unary calls to fetch a hundred items pays a hundred round trips, a hundred auth checks, a hundred interceptor chains and a hundred trace spans; one batch call pays one of each. No amount of window tuning or compression touches that. The catch is that it is a schema decision — a batch method has to be designed, with a bounded request size, and partial-success semantics so one missing item does not fail the batch — so it is much cheaper to get right up front than to retrofit.

**Q: (Senior) A service handles 10k RPS at 5 ms p50 but 200 ms p99. Diagnose.**
A: A p50 to p99 ratio of forty means something intermittent, not something uniformly slow, so I would not look at serialisation. The candidates in order. GC pauses and assists: check `GODEBUG=gctrace=1` and the heap profile, and if allocation per request is high, try a higher `GOGC` with `GOMEMLIMIT` as a backstop — this is the most common cause of exactly this shape in Go. Lock contention: a mutex profile, since a hot lock produces a long tail while the median stays fine. Load-balancing skew, where a subset of pods carries most traffic because `pick_first` is in effect or DNS returned one address — visible immediately as per-pod QPS variance. A slow dependency's own tail, which a trace with exemplars finds in seconds. Connection churn, where `MaxConnectionAge` without a grace period cuts in-flight RPCs on a timer. And flow-control stalls if any path streams. I would work from the trace first because it localises the hop, then pprof the identified process. If the tail turns out to be a genuinely slow backend rather than our code, hedging on idempotent reads is a legitimate mitigation while the cause is fixed.

**Q: (Senior) How do you decide whether an optimisation is worth it?**
A: Three questions. First, what fraction of latency does this component actually own — if serialisation is 2% of the request, making it twice as fast buys 1%, which is not worth any complexity. Second, what does the change cost in risk and maintenance: buffer pooling removes an allocation and adds a use-after-free hazard that will eventually bite someone who does not know the invariant; a batch method changes the schema permanently. Third, is there a cheaper structural alternative — usually there is, and batching or removing an N+1 beats micro-optimisation by an order of magnitude. Then I measure before and after under realistic load, and I keep the benchmark in the repository so the win does not silently regress. In practice about half of the optimisations people propose turn out neutral or negative when measured, which is the strongest argument for measuring first.

**Q: (Senior) Design a performance-testing strategy for a gRPC service.**
A: Four layers, each answering a different question. Go micro-benchmarks with `-benchmem` on marshalling, the interceptor chain and any hot business logic, run in CI with `benchstat` comparing against the base branch so a regression fails the PR rather than reaching production. A bufconn end-to-end benchmark that measures the full gRPC stack with the network removed, which isolates our overhead from the environment. A `ghz` load test in a production-like environment, sweeping concurrency to establish the capacity knee and payload size to find the message-size cliff, with results published per release so capacity planning has real numbers. And a soak test running for hours at realistic load, because that is the only thing that finds leaks, unbounded growth and stuck streams. Alongside all of it, production instrumentation with per-method latency, message-size percentiles, goroutine count and GC metrics, so the benchmark numbers can be sanity-checked against reality — a benchmark that disagrees with production is measuring the wrong thing.

## 10. Quick Revision & Cheat Sheet

```go
grpc.NewServer(
    grpc.MaxRecvMsgSize(16<<20),
    grpc.MaxSendMsgSize(16<<20),      // default is UNLIMITED
    grpc.MaxConcurrentStreams(2000),  // default is ~unlimited
    grpc.ReadBufferSize(64<<10), grpc.WriteBufferSize(64<<10),
    // grpc.InitialWindowSize(4<<20),  // ONLY with BDP arithmetic; disables auto-tuning
)

client.Export(ctx, req, grpc.UseCompressor(gzip.Name))  // per call, not global
```

```bash
ghz --insecure --proto x.proto --call pkg.Svc/M -d '{...}' -c 50 -z 30s --connections 5 host:50051
go test -bench=. -benchmem ./...
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/allocs
GOGC=400 GOMEMLIMIT=6GiB ./server
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Low single-stream throughput on a WAN | Window < BDP | Raise `InitialWindowSize` to bandwidth × RTT |
| p99 ≫ p50, CPU fine | GC assists | Raise `GOGC`, reduce allocation |
| `ResourceExhausted` on large responses | `MaxRecvMsgSize` | Raise, or paginate |
| Throughput plateaus, server idle | `MaxConcurrentStreams` | Raise, or add connections |
| One pod hot | `pick_first` / DNS | `round_robin` + headless + `MaxConnectionAge` |
| Many small calls | Chatty pattern | Batch method (schema change) |

**Flash cards**
- **First step?** → Measure and split the latency. Never tune first.
- **`throughput ≤ ?`** → `window / RTT`. Size the window to the BDP.
- **Raising the window costs?** → Auto-tuning is disabled, plus memory per stream.
- **Compression in a datacentre?** → Usually a loss. Per call, not global.
- **p99 ≫ p50 in Go?** → Suspect GC assists before anything else.
- **`ghz` gotcha?** → `--connections` defaults to 1.
- **Biggest win overall?** → Batching. It is a schema decision.

## 11. Hands-On Exercises & Mini Project

- [ ] Run `ghz` sweeping concurrency 1 → 500 and plot RPS against p99. Identify the knee.
- [ ] Repeat with `--connections 1` and `--connections 10` and explain the difference using `MaxConcurrentStreams`.
- [ ] Inject 100 ms of latency (`tc qdisc` on Linux, `dnctl` on macOS) and measure single-stream throughput at 64 KiB and 8 MiB windows. Compare against the BDP prediction.
- [ ] Benchmark marshal with and without a pooled buffer, recording ns/op and allocations. Decide whether it is worth it for your message size.
- [ ] Benchmark gzip at 100 B, 1 KiB and 100 KiB, reporting the compression ratio and the CPU cost. Find your break-even point.
- [ ] Run the same load at `GOGC=100` and `GOGC=400` with `GOMEMLIMIT`, and compare p99 and resident memory.
- [ ] Replace 100 sequential unary calls with one batch call and measure the difference in latency, CPU and trace-span count.
- [ ] Capture a goroutine profile under streaming load and confirm the count matches active streams.

### Mini Project — "Performance Investigation"

**Goal.** Take a service from a measured baseline to a defensible improvement, with every change justified by data.

**Requirements.**
1. A baseline: `ghz` at three concurrency levels and three payload sizes, plus a CPU and heap profile, recorded as the reference.
2. A latency split from traces showing the share belonging to gRPC, the handler and downstream calls.
3. Micro-benchmarks isolating marshalling, the interceptor chain and the hot handler path, with `-benchmem`.
4. Four experiments, each measured before and after and each with a verdict: a batch method replacing an N+1 pattern; window sizing on a link with injected latency, validated against the BDP prediction; `GOGC` and `GOMEMLIMIT`; compression at three payload sizes.
5. A write-up recording which changes helped, which were neutral, which hurt, and by how much — including the negative results, which are the most useful part.
6. `benchstat` in CI comparing against the base branch, so a regression fails the PR.
7. A soak test at realistic load for at least an hour, with goroutine count, heap size and active streams charted to prove nothing grows unboundedly.

**Extensions.**
- Implement a DataLoader-style coalescer and measure its effect on a realistic fan-out workload.
- Compare a single connection against a small pool at concurrency levels above the server's `MaxConcurrentStreams`, and quantify where the pool starts to help.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP/2 Under gRPC* (flow control and the window mechanics), *Protocol Buffers: Binary Wire Format* (serialisation cost and message size), *Observability* (the traces and metrics that guide tuning), *Deadlines, Retries, Service Config & Load Balancing* (load distribution as a prerequisite for scaling), *Build: The Complete Service .proto* (batching as a schema decision).

- **gRPC — Performance Best Practices** — grpc.io · *Intermediate* · the maintainers' own guidance on connections, streams, message sizes and when to reuse. <https://grpc.io/docs/guides/performance/>
- **ghz — gRPC benchmarking tool** — Bojan Djurkovic (open source) · *Beginner* · load generation with concurrency and connection control, JSON output for scripting. <https://ghz.sh/>
- **Go Blog — Profiling Go Programs** — The Go Authors · *Intermediate* · pprof CPU, heap, goroutine and block profiles, and how to read them. <https://go.dev/blog/pprof>
- **Go — Guide to the Go Garbage Collector** — The Go Authors · *Advanced* · `GOGC`, `GOMEMLIMIT`, assists, and why allocation drives tail latency. Essential for the p99 question. <https://go.dev/doc/gc-guide>
- **RFC 9113 §5.2 — HTTP/2 flow control** — IETF · *Advanced* · the window mechanics behind the BDP arithmetic in this chapter. <https://www.rfc-editor.org/rfc/rfc9113#section-5.2>
- **grpc-go — ServerOption and DialOption reference** — gRPC Authors · *Intermediate* · every tuning option with its default, including window sizes and buffer sizes. <https://pkg.go.dev/google.golang.org/grpc#ServerOption>
- **benchstat** — The Go Authors · *Intermediate* · statistically comparing benchmark runs, so "it got faster" becomes a defensible claim. <https://pkg.go.dev/golang.org/x/perf/cmd/benchstat>
- **The Tail at Scale** — Dean & Barroso, CACM · *Advanced* · why p99 dominates user experience in fan-out systems, and which techniques actually help. <https://research.google/pubs/pub40801/>

---

*gRPC with Go Handbook — chapter 28.*
