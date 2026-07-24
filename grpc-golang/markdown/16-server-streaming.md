# 16 · Server-Side Streaming Handlers

> **In one line:** A server-streaming handler is `func(*Req, Stream) error` where `Send` blocks when the client is slow — that blocking is HTTP/2 flow control doing its job, and every serious bug in this chapter comes from either fighting it or ignoring cancellation.

---

## 1. Overview

Server streaming is the shape where one request produces an open-ended sequence of responses. The generated signature differs from unary in two visible ways and one invisible one:

```go
func (s *Service) WatchStock(
    req *pb.WatchStockRequest,
    stream pb.InventoryService_WatchStockServer,   // or grpc.ServerStreamingServer[pb.StockEvent]
) error
```

Visibly: there is **no `context.Context` parameter** — you get it from `stream.Context()` — and there is **no response return value**; you `Send` responses and return only an error. Invisibly: **the status is committed last**, in HTTP/2 trailers, so the handler can emit forty messages and then fail, and clients must be written to expect exactly that.

The three things that make a streaming handler production-grade are all absent from the tutorial version:

1. **Cancellation.** The client disconnects, the deadline fires, or the server shuts down. If your loop does not select on `stream.Context().Done()`, you keep producing into a stream nobody is reading.
2. **A lifetime cap.** A stream with no maximum duration stalls `GracefulStop` indefinitely, pins load to old backends across a scale-up, and outlives the auth token that authorised it.
3. **Resumption.** A stream is not resumable by default. If the client drops at message 400,000, it starts again from zero — unless you designed a cursor into the schema (chapter 11).

This chapter builds a handler that gets all three right, and explains the backpressure model that determines how it behaves under load.

## 2. Core Concepts

- **Handler signature** — `func(*Req, XxxServer) error`. The request arrives once; responses go through the stream.
- **`stream.Send(msg)`** — enqueues a message; **blocks** when the HTTP/2 flow-control window is full.
- **`stream.Context()`** — the stream's context: deadline, cancellation, metadata. The *only* context you should use.
- **Returning from the handler** — terminates the stream. `nil` → `OK`; an error → that status in trailers. The client sees `io.EOF` for `OK`.
- **Flow control** — per-stream 64 KiB credit window (chapter 2); the receiver's consumption rate throttles the sender. This is backpressure.
- **`stream.SetHeader` / `SendHeader` / `SetTrailer`** — response metadata. Headers must be sent before the first message.
- **Lifetime cap** — a server-enforced maximum stream duration, closing with `Unavailable` and a reconnect hint.
- **Resume token** — an opaque cursor emitted with each message so a client can continue after a disconnect.
- **Snapshot-then-delta** — the standard watch pattern: send current state, then changes, with no gap between them.
- **Slow consumer** — a client reading more slowly than you produce. The correct response is to let `Send` block, never to buffer without bound.

## 3. Theory & Principles

### The lifecycle, and where each failure lives

```
client sends 1 request + END_STREAM
    ↓
server handler starts (its own goroutine)
    ↓
loop: produce → stream.Send(msg)         ← blocks under backpressure
    ↓
handler returns
    ↓ nil                      ↓ error
TRAILERS grpc-status: 0     TRAILERS grpc-status: N
    ↓                          ↓
client Recv() → io.EOF      client Recv() → status error
```

Four things can end a stream, and a correct handler distinguishes all of them:

| Ending | Cause | Handler action |
|---|---|---|
| Natural completion | Source exhausted | `return nil` |
| Client cancellation | Client called cancel, or went away | `return status.FromContextError(ctx.Err()).Err()` |
| Deadline exceeded | Client's `grpc-timeout` fired | Same — the code differs automatically |
| Server-initiated | Lifetime cap, shutdown, backpressure timeout | `return status.Error(codes.Unavailable, "…reconnect…")` |

The reason to translate context errors explicitly rather than returning `ctx.Err()` raw is that a bare `context.Canceled` becomes `codes.Unknown`, which is useless on a dashboard. `status.FromContextError` maps it to `Canceled` or `DeadlineExceeded`, and those two mean very different things: one is the client giving up, the other is you being too slow.

### Backpressure: why `Send` blocking is correct

Each stream has a 64 KiB flow-control window by default. The server may have at most that many unacknowledged bytes outstanding; the client's runtime issues `WINDOW_UPDATE` as the application consumes messages. So if the client's `Recv` loop is slow, the window closes and **`stream.Send` blocks**.

This is the designed behaviour and it is the only thing standing between you and unbounded memory growth. The wrong reactions, in increasing order of damage:

- **Buffering into an unbounded channel** "so we never block" — converts a slow consumer into an OOM.
- **Dropping messages silently** — the client believes it received a complete stream.
- **Spawning a goroutine per message** — same as buffering, with extra scheduler cost.

The right reactions are: let `Send` block and let the producer slow down; or, if the producer cannot be slowed (a live event bus that will drop for you), decide *explicitly* what happens — a bounded buffer plus a documented "slow consumer disconnected" error is honest, silent loss is not.

One important consequence: **a blocked `Send` is not cancellable by `select`.** You cannot write `select { case <-ctx.Done(): ...; case stream.Send(m): ... }` — `Send` is a function call, not a channel operation. It does return promptly when the stream's context is cancelled, because the transport unblocks it, but you cannot impose your own timeout on it directly. The pattern for a hard send timeout is a goroutine plus a channel, shown in §5.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ss1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="ss2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Backpressure: a blocked Send is the system working</text>

  <rect x="24" y="42" width="832" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Correct: let Send block</text>

  <rect x="50" y="80" width="150" height="52" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="125" y="102" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">producer</text>
  <text x="125" y="120" text-anchor="middle" fill="#166534" font-size="9">event bus / DB cursor</text>

  <path d="M202,106 L262,106" stroke="#16a34a" stroke-width="2" marker-end="url(#ss1)"/>

  <rect x="266" y="80" width="150" height="52" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="341" y="102" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">stream.Send()</text>
  <text x="341" y="120" text-anchor="middle" fill="#166534" font-size="9">BLOCKS when window full</text>

  <path d="M418,106 L478,106" stroke="#16a34a" stroke-width="2" marker-end="url(#ss1)"/>

  <rect x="482" y="80" width="170" height="52" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="567" y="102" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">64 KiB window</text>
  <text x="567" y="120" text-anchor="middle" fill="#166534" font-size="9">WINDOW_UPDATE as client reads</text>

  <path d="M654,106 L714,106" stroke="#16a34a" stroke-width="2" marker-end="url(#ss1)"/>

  <rect x="718" y="80" width="118" height="52" rx="8" fill="#fff" stroke="#16a34a"/>
  <text x="777" y="102" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">slow client</text>
  <text x="777" y="120" text-anchor="middle" fill="#166534" font-size="9">Recv() every 100 ms</text>

  <text x="50" y="156" fill="#166534">The chain throttles end to end: a slow client slows the producer, and memory stays flat.</text>
  <text x="50" y="176" fill="#166534">Send DOES return promptly when the stream's context is cancelled &#8212; the transport unblocks it.</text>
  <text x="50" y="196" fill="#15803d" font-weight="bold">But you cannot select on Send: it is a function call, not a channel op. See &#167;5 for a hard send timeout.</text>
  <text x="50" y="214" fill="#166534">Consequence: never spawn a goroutine per message "to avoid blocking" &#8212; that is buffering with extra cost.</text>

  <rect x="24" y="240" width="832" height="230" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="262" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Three wrong reactions, in increasing order of damage</text>

  <rect x="48" y="278" width="256" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="176" y="298" text-anchor="middle" fill="#b91c1c" font-weight="bold">1. Unbounded buffer</text>
  <text x="62" y="320" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">buf := make(chan *Ev, 1e9)</text>
  <text x="62" y="340" fill="#991b1b" font-size="10">"so we never block"</text>
  <text x="62" y="360" fill="#991b1b" font-size="10">Converts a slow consumer</text>
  <text x="62" y="376" fill="#991b1b" font-size="10">into an OOM. Memory grows</text>
  <text x="62" y="392" fill="#991b1b" font-size="10">until the process dies.</text>

  <rect x="312" y="278" width="256" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="298" text-anchor="middle" fill="#b91c1c" font-weight="bold">2. Silent drops</text>
  <text x="326" y="320" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">select { case ch &lt;- ev:</text>
  <text x="326" y="336" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">default: /* drop */ }</text>
  <text x="326" y="358" fill="#991b1b" font-size="10">Memory is fine. The client</text>
  <text x="326" y="374" fill="#991b1b" font-size="10">believes it received a</text>
  <text x="326" y="390" fill="#991b1b" font-size="10">COMPLETE stream. Worse.</text>

  <rect x="576" y="278" width="256" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="704" y="298" text-anchor="middle" fill="#b91c1c" font-weight="bold">3. Goroutine per message</text>
  <text x="590" y="320" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">go stream.Send(ev)</text>
  <text x="590" y="342" fill="#991b1b" font-size="10">Also a data race: Send is</text>
  <text x="590" y="358" fill="#991b1b" font-size="10">NOT safe from two goroutines.</text>
  <text x="590" y="374" fill="#991b1b" font-size="10">Buffering, plus scheduler</text>
  <text x="590" y="390" fill="#991b1b" font-size="10">cost, plus corruption.</text>

  <text x="48" y="424" fill="#7f1d1d" font-weight="bold">The honest alternative when the producer genuinely cannot be slowed:</text>
  <text x="48" y="444" fill="#991b1b">a BOUNDED buffer plus an explicit codes.ResourceExhausted "consumer too slow" close. Documented loss, not silent loss.</text>
  <text x="48" y="462" fill="#991b1b">Emit a metric for it, so "how often do we disconnect slow consumers" is answerable.</text>
</svg>
```

### Snapshot-then-delta, without a gap

The most common server-streaming use case is "watch": send current state, then changes. The subtle bug is the **gap** — if you read the snapshot, then subscribe, any change in between is lost forever.

The fix is to **subscribe first, then snapshot**, buffering events that arrive during the snapshot and replaying them afterwards, deduplicated by version:

1. Subscribe to the change feed; events accumulate in a bounded buffer.
2. Read the snapshot, recording each item's version.
3. Send the snapshot events.
4. Drain the buffer, discarding any event whose version is ≤ the snapshot version for that key.
5. Continue streaming live.

If the buffer overflows during step 2 the snapshot is too slow relative to the change rate; close with `Unavailable` and let the client retry rather than delivering a stream with a hole in it.

## 4. Architecture & Workflow

The shape of a production watch handler:

1. **Validate** the request — including bounding the number of keys watched. A watch on "everything" cannot be load-balanced or bounded, and should be rejected in the schema (chapter 11).
2. **Take `ctx := stream.Context()`** and use it for everything.
3. **Start the lifetime timer** — a `time.Timer` for the maximum stream duration.
4. **Subscribe** to the source, with `defer unsubscribe()`.
5. **Snapshot** (if requested), then drain the gap buffer.
6. **Loop** on `select` over: `ctx.Done()`, the lifetime timer, a heartbeat ticker, and the event channel.
7. **On lifetime expiry**, return `Unavailable` with a message telling the client to reconnect using the last resume token.
8. **On every `Send` error**, return it directly — it already carries a status, and wrapping it loses information.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="sn1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Snapshot-then-delta: closing the gap</text>

  <rect x="24" y="42" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Naive: snapshot, then subscribe</text>
  <rect x="48" y="80" width="360" height="26" rx="5" fill="#fff" stroke="#fca5a5"/>
  <text x="60" y="98" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">1. items := store.Snapshot()</text>
  <rect x="48" y="112" width="360" height="34" rx="5" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="228" y="126" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">&#8592; THE GAP &#8594;</text>
  <text x="228" y="140" text-anchor="middle" fill="#7f1d1d" font-size="9">any change here is lost FOREVER</text>
  <rect x="48" y="152" width="360" height="26" rx="5" fill="#fff" stroke="#fca5a5"/>
  <text x="60" y="170" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">2. ch := bus.Subscribe()</text>
  <text x="48" y="200" fill="#991b1b" font-size="10">The client's view is silently, permanently stale for</text>
  <text x="48" y="216" fill="#991b1b" font-size="10">whichever keys changed during the snapshot read.</text>
  <text x="48" y="234" fill="#7f1d1d" font-size="10" font-weight="bold">Nothing errors. Nothing logs. Tests pass.</text>

  <rect x="446" y="42" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Correct: subscribe, then snapshot</text>
  <rect x="470" y="80" width="360" height="26" rx="5" fill="#fff" stroke="#86efac"/>
  <text x="482" y="98" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">1. ch := bus.Subscribe()   // buffered</text>
  <rect x="470" y="112" width="360" height="26" rx="5" fill="#fff" stroke="#86efac"/>
  <text x="482" y="130" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">2. items := store.Snapshot() // versions</text>
  <rect x="470" y="144" width="360" height="26" rx="5" fill="#fff" stroke="#86efac"/>
  <text x="482" y="162" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">3. send snapshot events</text>
  <rect x="470" y="176" width="360" height="26" rx="5" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="482" y="194" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">4. drain buffer, drop version &#8804; snapshot</text>
  <text x="470" y="222" fill="#166534" font-size="10">Buffer overflow during step 2 &#8594; Unavailable, let the</text>
  <text x="470" y="238" fill="#166534" font-size="10">client retry. A short stream beats a stream with a hole.</text>

  <rect x="24" y="260" width="832" height="160" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="282" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The four ways a stream ends &#8212; distinguish all of them</text>
  <g font-size="10">
    <text x="48" y="308" fill="#334155" font-weight="bold">Source exhausted</text>
    <text x="250" y="308" fill="#475569" font-family="ui-monospace,monospace">return nil</text>
    <text x="470" y="308" fill="#475569">&#8594; client sees io.EOF (success)</text>

    <text x="48" y="330" fill="#334155" font-weight="bold">Client cancelled</text>
    <text x="250" y="330" fill="#475569" font-family="ui-monospace,monospace">FromContextError(ctx.Err())</text>
    <text x="470" y="330" fill="#475569">&#8594; codes.Canceled (they gave up)</text>

    <text x="48" y="352" fill="#334155" font-weight="bold">Deadline fired</text>
    <text x="250" y="352" fill="#475569" font-family="ui-monospace,monospace">FromContextError(ctx.Err())</text>
    <text x="470" y="352" fill="#475569">&#8594; codes.DeadlineExceeded (we were slow)</text>

    <text x="48" y="374" fill="#334155" font-weight="bold">Lifetime cap / shutdown</text>
    <text x="250" y="374" fill="#475569" font-family="ui-monospace,monospace">Unavailable + "reconnect"</text>
    <text x="470" y="374" fill="#475569">&#8594; client resumes from its token</text>
  </g>
  <text x="48" y="404" fill="#7f1d1d" font-weight="bold" font-size="10">Returning ctx.Err() raw yields codes.Unknown, which is useless on a dashboard. Always translate.</text>
</svg>
```

## 5. Implementation

### A complete watch handler

```go
package inventory

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

const (
	maxWatchedSKUs   = 1000
	maxStreamAge     = 30 * time.Minute
	heartbeatEvery   = 30 * time.Second
	gapBufferSize    = 4096
	sendTimeout      = 30 * time.Second
)

// WatchStock streams quantity changes for the requested SKUs.
//
// Note the signature: the request arrives ONCE as a parameter, there is no
// context parameter (use stream.Context()), and there is no response return
// value — returning ends the stream.
func (s *Service) WatchStock(
	req *inventoryv1.WatchStockRequest,
	stream inventoryv1.InventoryService_WatchStockServer,
) error {
	// --- 1. Validate, including bounds ------------------------------------
	skus := req.GetSkus()
	switch {
	case len(skus) == 0:
		// A watch on "everything" is deliberately not offered: it cannot be
		// bounded or load-balanced. See the schema chapter.
		return status.Error(codes.InvalidArgument, "at least one sku is required")
	case len(skus) > maxWatchedSKUs:
		return status.Errorf(codes.InvalidArgument,
			"too many skus: %d (max %d)", len(skus), maxWatchedSKUs)
	}

	// --- 2. THE context. Never context.Background(), never a stored one. ---
	ctx := stream.Context()

	principal, ok := PrincipalFromContext(ctx)
	if !ok {
		return status.Error(codes.Internal, "internal error")
	}
	if err := principal.MayWatch(skus); err != nil {
		return status.Error(codes.PermissionDenied, "not permitted to watch these skus")
	}

	// --- 3. Lifetime cap ---------------------------------------------------
	// Without this, GracefulStop blocks forever, load stays pinned to this
	// pod across a scale-up, and the stream outlives the token that authorised it.
	lifetime := time.NewTimer(maxStreamAge)
	defer lifetime.Stop()

	// --- 4. Subscribe BEFORE snapshotting, so no change is lost in between -
	events, unsubscribe := s.bus.Subscribe(skus, gapBufferSize)
	defer unsubscribe()

	// --- 5. Snapshot, then drain the gap ----------------------------------
	var lastToken string
	if req.GetIncludeInitialSnapshot() && req.GetResumeToken() == "" {
		var err error
		lastToken, err = s.sendSnapshot(stream, skus)
		if err != nil {
			return err
		}
	} else if t := req.GetResumeToken(); t != "" {
		// Resuming: replay history since the token instead of snapshotting.
		var err error
		lastToken, err = s.replaySince(stream, skus, t)
		if errors.Is(err, ErrTokenExpired) {
			// Be explicit: the client must fall back to a full snapshot rather
			// than silently receiving an incomplete stream.
			return status.Error(codes.OutOfRange,
				"resume_token is too old; reconnect without one for a full snapshot")
		}
		if err != nil {
			return err
		}
	}

	heartbeat := time.NewTicker(heartbeatEvery)
	defer heartbeat.Stop()

	// --- 6. The loop -------------------------------------------------------
	for {
		select {
		// Client cancelled, deadline fired, or the server is shutting down.
		// Translate faithfully: Canceled and DeadlineExceeded mean different
		// things, and a raw ctx.Err() would become codes.Unknown.
		case <-ctx.Done():
			return status.FromContextError(ctx.Err()).Err()

		case <-lifetime.C:
			// Ask the client to reconnect. This bounds GracefulStop, rebalances
			// load, and re-authenticates. The message tells the client HOW.
			s.metrics.StreamLifetimeExpired.Inc()
			return status.Errorf(codes.Unavailable,
				"stream lifetime of %s exceeded; reconnect with resume_token=%q",
				maxStreamAge, lastToken)

		case <-heartbeat.C:
			// Keeps intermediaries from reaping an idle stream, and gives the
			// client a liveness signal it can time out on.
			if err := s.sendWithTimeout(ctx, stream, &inventoryv1.StockEvent{
				Kind:        inventoryv1.StockEventKind_STOCK_EVENT_KIND_UNSPECIFIED,
				OccurredAt:  timestamppb.Now(),
				ResumeToken: lastToken,
			}); err != nil {
				return err
			}

		case ev, open := <-events:
			if !open {
				// The source closed cleanly. nil -> OK -> client sees io.EOF.
				return nil
			}

			msg := &inventoryv1.StockEvent{
				Sku:              ev.SKU,
				QuantityOnHand:   ev.OnHand,
				QuantityReserved: ev.Reserved,
				OccurredAt:       timestamppb.New(ev.At),
				Kind:             toProtoKind(ev.Kind),
				// The resume token is what makes this stream resumable. Emit it
				// with EVERY message, not just periodically.
				ResumeToken: ev.Cursor,
			}

			if err := s.sendWithTimeout(ctx, stream, msg); err != nil {
				return err
			}
			lastToken = ev.Cursor
			s.metrics.StreamMessagesSent.Inc()
		}
	}
}

// sendWithTimeout imposes a hard bound on a single Send.
//
// stream.Send blocks under flow control and DOES return when the stream's
// context is cancelled — but it is a function call, not a channel operation,
// so it cannot appear in a select. When you need a bound tighter than the
// stream deadline (to disconnect a pathologically slow consumer, say), this
// is the pattern.
//
// The goroutine is not leaked: Send returns as soon as the stream ends, and
// the buffered channel means it can always complete its write.
func (s *Service) sendWithTimeout(
	ctx context.Context,
	stream inventoryv1.InventoryService_WatchStockServer,
	msg *inventoryv1.StockEvent,
) error {
	done := make(chan error, 1)
	go func() { done <- stream.Send(msg) }()

	select {
	case err := <-done:
		if err != nil {
			// Send's error already carries a status; wrapping it would lose
			// the code. Return it unchanged.
			return err
		}
		return nil

	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()

	case <-time.After(sendTimeout):
		s.metrics.SlowConsumerDisconnected.Inc()
		return status.Errorf(codes.ResourceExhausted,
			"consumer did not read for %s; disconnecting", sendTimeout)
	}
}

// sendSnapshot emits current state for every watched sku and returns the
// cursor the snapshot was taken at.
func (s *Service) sendSnapshot(
	stream inventoryv1.InventoryService_WatchStockServer,
	skus []string,
) (string, error) {
	ctx := stream.Context()

	// Chunk the read so a 1000-sku watch does not build one enormous slice.
	const chunk = 100
	var cursor string

	for i := 0; i < len(skus); i += chunk {
		end := min(i+chunk, len(skus))

		items, c, err := s.store.SnapshotAt(ctx, skus[i:end])
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return "", status.FromContextError(err).Err()
			}
			s.log.ErrorContext(ctx, "snapshot failed", "err", err)
			return "", status.Error(codes.Internal, "internal error")
		}
		cursor = c

		for _, it := range items {
			if err := s.sendWithTimeout(ctx, stream, &inventoryv1.StockEvent{
				Sku:              it.SKU,
				QuantityOnHand:   it.OnHand,
				QuantityReserved: it.Reserved,
				OccurredAt:       timestamppb.New(it.UpdatedAt),
				Kind:             inventoryv1.StockEventKind_STOCK_EVENT_KIND_SNAPSHOT,
				ResumeToken:      cursor,
			}); err != nil {
				return "", err
			}
		}
	}
	return cursor, nil
}
```

### The simpler case: streaming a finite result set

Not every server-streaming method is a watch. Exporting a large table is the other common shape, and it is simpler — but still needs cancellation and chunking:

```go
// ExportItems streams the whole catalogue.
//
// Batching matters: sending one message per row pays HTTP/2 framing and
// protobuf overhead per row. Batches of a few hundred are typically an order
// of magnitude faster while keeping memory bounded.
func (s *Service) ExportItems(
	req *inventoryv1.ExportItemsRequest,
	stream inventoryv1.InventoryService_ExportItemsServer,
) error {
	ctx := stream.Context()

	// A cursor-driven loop, so the export is resumable and each page is an
	// indexed range scan rather than a deepening OFFSET.
	cursor := req.GetResumeFrom()
	const batchSize = 500

	for {
		// The context check is cheap and makes the abort prompt even if the
		// store call is not perfectly ctx-aware.
		if err := ctx.Err(); err != nil {
			return status.FromContextError(err).Err()
		}

		items, next, err := s.store.ScanFrom(ctx, cursor, batchSize)
		if err != nil {
			s.log.ErrorContext(ctx, "scan failed", "err", err, "cursor", cursor)
			return status.Error(codes.Internal, "internal error")
		}
		if len(items) == 0 {
			return nil // exhausted -> OK -> client sees io.EOF
		}

		if err := stream.Send(&inventoryv1.ExportItemsResponse{
			Items:       items,
			NextCursor:  next,   // client stores this to resume after a drop
		}); err != nil {
			return err
		}

		cursor = next
	}
}
```

### Sending headers and trailers

```go
func (s *Service) WatchStockWithMetadata(
	req *inventoryv1.WatchStockRequest,
	stream inventoryv1.InventoryService_WatchStockServer,
) error {
	// Headers must be sent BEFORE the first message. SetHeader queues them
	// (flushed with the first Send); SendHeader flushes immediately, which is
	// useful when the client wants to know the stream is established before
	// any data arrives. SendHeader may be called only once.
	if err := stream.SendHeader(metadata.Pairs(
		"x-stream-id", newStreamID(),
		"x-max-lifetime-seconds", fmt.Sprint(int(maxStreamAge.Seconds())),
	)); err != nil {
		return err
	}

	// Trailers are sent with the final status, after all messages, so they can
	// carry totals the handler only knows at the end.
	var sent int
	defer func() {
		stream.SetTrailer(metadata.Pairs("x-events-sent", fmt.Sprint(sent)))
	}()

	// ... loop, incrementing sent ...
	return nil
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Push, not poll.** Latency is the source's latency, not a polling interval, and there is no wasted request when nothing changed.
- **Bounded memory on both sides.** Neither peer materialises the full result set.
- **Real backpressure**, free, via HTTP/2 flow control.
- **Amortised overhead.** One stream instead of N requests: one auth check, one connection setup, one trace span.
- **Status can be reported after data**, so a partial result is honestly reported as a failure.

**Disadvantages**
- **Pins a connection** for the stream's lifetime, breaking per-call load balancing and complicating rolling deploys.
- **Not resumable by default.** You must design a cursor into the schema.
- **Built-in retry does not apply** once the first response is sent.
- **One long trace span**, so per-message visibility needs explicit events or metrics.
- **Auth is checked once at open**, so a long stream can outlive its token.

**Trade-offs**
- *Batch size:* larger batches amortise framing and protobuf overhead but increase memory and time-to-first-byte. A few hundred rows per message is a common sweet spot; measure.
- *Lifetime cap length:* shorter caps rebalance load and bound drains but cost reconnections; longer caps are cheaper but stall deploys. 15–30 minutes is a reasonable default.
- *Blocking vs bounded buffer:* blocking is simplest and safest; a bounded buffer smooths bursts but needs an explicit overflow policy and a metric.

## 7. Common Mistakes & Best Practices

- **Using `context.Background()` instead of `stream.Context()`.** Cancellation never propagates and the handler keeps working for a departed client.
- **No lifetime cap.** `GracefulStop` blocks indefinitely, load never rebalances, and tokens outlive their validity.
- **Returning `ctx.Err()` raw.** Becomes `codes.Unknown`. Use `status.FromContextError`.
- **Buffering without bound** to avoid blocking `Send`. That converts a slow consumer into an OOM.
- **Dropping messages silently** when a buffer is full. The client believes the stream was complete.
- **Calling `Send` from multiple goroutines.** It is not safe. One sender, always.
- **Snapshot before subscribe.** Creates a silent gap where changes are lost forever.
- **Wrapping `Send`'s error** in a new status. It already carries one; wrapping discards it.
- **One message per row.** Framing and protobuf overhead dominate; batch.
- **No resume token.** A disconnect at message 400,000 restarts from zero.
- **Sending headers after the first message.** Headers must precede all data.
- **No heartbeat on a low-traffic stream.** Intermediaries reap it and the client cannot distinguish "idle" from "dead".

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl -d '{"skus":["sku_1"]}' host:port pkg.Service/WatchStock` prints messages as they arrive — the fastest way to check a stream by hand. For "the stream hangs", check in order: is the client actually calling `Recv`, is the flow-control window closed (goroutine dump showing a blocked `Send`), and is `stream.Context()` being used.
- **Monitoring.** Unary metrics are insufficient. Track: active streams per method, messages sent per stream, stream duration histogram, time-since-last-message, lifetime-expiry count, and slow-consumer disconnects. Active streams rising while message rate is flat means stuck streams.
- **Security.** A token validated at stream open can outlive its expiry, so cap stream lifetime below token lifetime — that single decision resolves it without periodic re-validation. Bound the number of watched keys and the message rate per stream, or one client can consume a backend indefinitely. Treat resume tokens as untrusted input: sign them or store them server-side, since an unsigned cursor is a database offset the client controls.
- **Scaling.** Streams pin connections, so plan for `MaxConnectionAge` plus application-level reconnect prompts. During a rolling deploy, `GracefulStop` waits for streams — the lifetime cap is what bounds it. Measure stream distribution across backends, not just request distribution, because they diverge badly.

## 9. Interview Questions

**Q: How does a server-streaming handler differ from a unary one?**
A: Three ways. The signature is `func(*Req, Stream) error` — the request arrives once as a parameter, and there is no response return value; you call `stream.Send` and return only an error. There is no `context.Context` parameter, so you take it from `stream.Context()`. And the status is committed last, in HTTP/2 trailers, so a handler can send forty messages and then fail — which means clients must never treat "I received data" as "the call succeeded".

**Q: What happens when `stream.Send` blocks?**
A: The HTTP/2 flow-control window for that stream is full — the client has not consumed enough for its runtime to issue `WINDOW_UPDATE`. Blocking is the designed backpressure mechanism and the only thing preventing unbounded memory growth: it slows the producer to the consumer's rate. The wrong responses are buffering without bound, which turns a slow consumer into an OOM, and dropping silently, which makes the client believe it got a complete stream. `Send` does return promptly when the stream's context is cancelled, but it cannot appear in a `select`, so a hard send timeout needs a goroutine plus a channel.

**Q: Why does a stream need a lifetime cap?**
A: Three reasons, all operational. `GracefulStop` waits for in-flight RPCs, and a stream with no maximum duration blocks a rolling deploy indefinitely. Load stays pinned to the backends that hold the streams, so scaling up does nothing until clients reconnect. And the auth token validated at stream open eventually expires, so a long-lived stream becomes an indefinite grant. Capping at 15–30 minutes and closing with `Unavailable` plus a reconnect hint resolves all three at the cost of periodic reconnection.

**Q: How do you make a stream resumable?**
A: By designing a cursor into the schema: every message carries an opaque resume token encoding the source position, and the request accepts a `resume_token` to continue from. On a disconnect the client reconnects with the last token it received and the server replays from there instead of snapshotting. The tokens need an expiry, and the server must respond explicitly — `OutOfRange` — when a token is too old, so the client falls back to a full snapshot rather than silently receiving an incomplete stream. Without this, a drop at message 400,000 restarts from zero.

**Q: What is the snapshot-then-delta gap, and how do you close it?**
A: If you read the current state and *then* subscribe to changes, anything that changed between the two is lost permanently, with no error and no log line. The fix is to subscribe first — so events accumulate in a bounded buffer — then snapshot recording each item's version, send the snapshot, and drain the buffer discarding events at or below the snapshot version. If the buffer overflows during the snapshot, close with `Unavailable` and let the client retry, because a short stream is better than a stream with a hole in it.

**Q: How should a handler end a stream?**
A: By returning. `nil` closes with `OK`, which the client sees as `io.EOF`; a non-nil error closes with that status. The four endings to distinguish are: source exhausted (`return nil`), client cancellation and deadline expiry (both `status.FromContextError(ctx.Err()).Err()`, which yields `Canceled` or `DeadlineExceeded` respectively), and server-initiated closure such as the lifetime cap (`Unavailable` with a reconnect hint). Returning `ctx.Err()` raw is a common mistake — it becomes `codes.Unknown`, which tells a dashboard nothing.

**Q: Why batch messages in a large export?**
A: Because each message pays HTTP/2 framing, a length prefix, protobuf marshalling and a flow-control accounting step. One message per row makes that per-row overhead dominate, and it is common to see an order-of-magnitude throughput difference between per-row and per-few-hundred-row messages. Batching also reduces the number of `Send` calls and therefore scheduler pressure. The counterweights are memory per message and time-to-first-byte, so a few hundred rows is a typical sweet spot — worth measuring rather than assuming.

**Q: (Senior) Design a server-streaming export of 500 million rows.**
A: A raw stream alone is wrong, because a failure at row 400 million must not restart from zero. Each response carries a batch of a few hundred rows plus an opaque cursor encoding the last row's sort key, and the request accepts a `resume_from` cursor, so the loop is a series of indexed range scans rather than a deepening `OFFSET`. The server caps stream lifetime at, say, ten minutes and closes with `Unavailable` plus the current cursor rather than trying to hold one stream for hours — that bounds `GracefulStop`, rebalances load, and makes any failure cost seconds. I would enforce a stable total ordering so the cursor is meaningful, emit a running row count and a checksum so the client can verify completeness, bound message size, and check `ctx.Err()` each iteration so an abandoned export stops consuming database capacity promptly. If durability or multi-consumer replay were also required, I would write the export to object storage and stream object references instead — a live stream is the wrong primitive for something that must survive both ends restarting.

**Q: (Senior) Active streams are climbing but message rate is flat. Diagnose.**
A: That pattern means streams are being established and not terminating — either stuck or leaked. My first check is a goroutine dump: goroutines blocked in `stream.Send` point at flow control, meaning consumers have stopped reading, while goroutines blocked on an internal channel receive point at a producer that has stalled. Second, look at time-since-last-message per stream; if it exceeds the heartbeat interval, the handler's loop is not reaching the heartbeat case. Third, check whether the handler has a lifetime cap at all — without one, streams from clients that vanished without a TCP FIN (a killed container, a NAT timeout) persist until keepalive notices, which can be a long time if keepalive is not configured. Fourth, confirm `stream.Context()` is being used rather than a background context, because with the latter cancellation never arrives and every stream is effectively immortal. The permanent fixes are a lifetime cap, server keepalive with a `Timeout`, a slow-consumer send timeout with its own metric, and an alert on active-streams-per-pod rather than only on request rate.

**Q: (Senior) How do you handle authentication for streams that outlive their tokens?**
A: The simplest correct answer is to cap stream lifetime below the token's remaining validity and close with `Unavailable` plus a reconnect hint, so the client re-authenticates naturally on reconnect. That also bounds deploy drains and rebalances load, so one decision buys three properties. If streams genuinely must be longer-lived, the alternative is periodic re-validation inside the handler — store the token's expiry at open and check it on a ticker, terminating with `Unauthenticated` when it passes, or requiring the client to send a refreshed credential as a message on the stream, which only works for bidirectional. What I would not do is validate once at open and never again, because that silently converts a one-hour token into an indefinite grant, and it is exactly the kind of thing that passes review because the auth interceptor *looks* like it covers streams.

## 10. Quick Revision & Cheat Sheet

```go
func (s *Service) Watch(req *pb.Req, stream pb.Svc_WatchServer) error {
    ctx := stream.Context()                    // THE context. Always.
    if len(req.GetKeys()) > maxKeys { return status.Error(codes.InvalidArgument, "…") }

    lifetime := time.NewTimer(maxStreamAge)    // bounds GracefulStop + rebalances
    defer lifetime.Stop()

    events, unsub := s.bus.Subscribe(req.GetKeys())  // subscribe BEFORE snapshot
    defer unsub()

    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()   // never raw ctx.Err()
        case <-lifetime.C:
            return status.Errorf(codes.Unavailable, "reconnect with resume_token=%q", last)
        case <-heartbeat.C:
            if err := stream.Send(hb); err != nil { return err }
        case ev, open := <-events:
            if !open { return nil }                           // OK -> client io.EOF
            if err := stream.Send(toProto(ev)); err != nil { return err }  // unwrapped
            last = ev.Cursor
        }
    }
}
```

| Concern | Rule |
|---|---|
| Context | `stream.Context()`, never `context.Background()` |
| Ending with success | `return nil` → client `io.EOF` |
| Ending with cancellation | `status.FromContextError(ctx.Err()).Err()` |
| Ending on lifetime cap | `Unavailable` + resume token in the message |
| `Send` error | Return unchanged — it already carries a status |
| Slow consumer | Let `Send` block; bound it explicitly if needed |
| Concurrency | One sender goroutine. Never two. |
| Large exports | Batch a few hundred per message + a cursor |
| Watch | Subscribe → snapshot → drain gap → live |

**Flash cards**
- **Which context?** → `stream.Context()`. Always.
- **`Send` blocked?** → Flow control. That is backpressure working. Never buffer without bound.
- **Return `ctx.Err()`?** → No — `codes.Unknown`. Use `status.FromContextError`.
- **Stream with no lifetime cap?** → Stalls deploys, pins load, outlives tokens.
- **Snapshot then subscribe?** → Silent permanent gap. Reverse the order.
- **Two goroutines calling `Send`?** → Data race. One sender.
- **Resumability?** → A cursor on every message plus `resume_token` in the request.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a handler that sends 100,000 messages while the client sleeps 10 ms between `Recv` calls. Log how long each `Send` blocks and explain the pattern using the 64 KiB window.
- [ ] Replace `stream.Context()` with `context.Background()`, kill the client mid-stream, and watch the handler keep producing. Restore and confirm it stops.
- [ ] Send 50 messages then return `status.Error(codes.Internal, "boom")`. Verify the client received all 50 *and* the error, and write the client bug that would have reported success.
- [ ] Return `ctx.Err()` raw and observe `codes.Unknown` on the client. Switch to `status.FromContextError` and see `Canceled`.
- [ ] Implement snapshot-then-subscribe and construct a test that provably loses an event in the gap. Reverse the order and prove it does not.
- [ ] Export 1,000,000 rows one per message, then in batches of 500, and compare wall-clock time, CPU and allocations.
- [ ] Add a 10-second lifetime cap, trigger `GracefulStop` mid-stream, and time the shutdown with and without the cap.

### Mini Project — "Resumable Live Feed"

**Goal.** Build a server-streaming watch that survives disconnects, deploys and slow consumers without losing data — the properties a demo version lacks.

**Requirements.**
1. A watch method over a bounded key set, rejecting an empty or oversized key list, with per-key authorization.
2. Subscribe-then-snapshot with a bounded gap buffer, deduplicated by version, and an explicit `Unavailable` on buffer overflow. Include a test that provably loses an event with the naive ordering and does not with yours.
3. Resume tokens on every message, a `resume_token` request field, token expiry, and `OutOfRange` when a token is too old.
4. A lifetime cap with an `Unavailable` close carrying the current token, plus a client that reconnects automatically and verifies zero gaps across the reconnection.
5. Heartbeats, a send timeout that disconnects pathologically slow consumers with `ResourceExhausted`, and metrics for both.
6. Metrics for active streams, messages per stream, stream duration, time-since-last-message and lifetime expiries, plus a dashboard.
7. A chaos test: kill the server mid-stream during a rolling restart and assert the client's reconstructed view is identical to the source of truth.

**Extensions.**
- Add per-stream rate limiting and demonstrate that one abusive client cannot starve others.
- Compare a bounded-buffer overflow policy against pure blocking under a synthetic slow consumer, and chart memory and delivered-message counts for each.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *The Four RPC Patterns* (where server streaming fits), *HTTP/2 Under gRPC* (the flow control that causes `Send` to block), *Client-Side & Bidirectional Streaming Handlers* (the other stream shapes), *Graceful Shutdown* (why lifetime caps matter), *Build: The Complete Service .proto* (designing resume tokens into the schema).

- **gRPC — Core concepts: server streaming RPC** — grpc.io · *Beginner* · the normative lifecycle, half-close semantics and where the status is delivered. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC Go — Basics tutorial (route guide)** — grpc.io · *Beginner* · the canonical server-streaming handler and client loop in Go. <https://grpc.io/docs/languages/go/basics/>
- **grpc-go — ServerStream documentation** — gRPC Authors · *Intermediate* · `Send`, `Context`, `SetHeader`/`SendHeader`/`SetTrailer` and the concurrency guarantees. <https://pkg.go.dev/google.golang.org/grpc#ServerStream>
- **RFC 9113 §5.2 — HTTP/2 flow control** — IETF · *Advanced* · the window mechanics that make `Send` block, and how `WINDOW_UPDATE` releases it. <https://www.rfc-editor.org/rfc/rfc9113#section-5.2>
- **gRPC Blog — Deadlines** — gRPC Authors · *Intermediate* · why every stream needs a deadline and how cancellation propagates. <https://grpc.io/blog/deadlines/>
- **Google AIP-158 — Pagination** — Google · *Intermediate* · cursor design that applies directly to resume tokens, including opacity and expiry. <https://google.aip.dev/158>
- **grpc-go examples — features/cancellation and features/deadline** — gRPC Authors · *Intermediate* · runnable demonstrations of cancellation propagating into a streaming handler. <https://github.com/grpc/grpc-go/tree/master/examples/features>
- **Go Blog — Go Concurrency Patterns: Pipelines and cancellation** — The Go Authors · *Intermediate* · the producer/consumer and cancellation patterns this chapter's loop is built from. <https://go.dev/blog/pipelines>

---

*gRPC with Go Handbook — chapter 16.*
