# 27 · Build: Testing gRPC in Go — bufconn, Table Tests & Mocks

> **In one line:** `bufconn` gives you a real gRPC server over an in-memory pipe — real serialisation, real interceptors, real status codes, no ports — which makes the fast test and the realistic test the same test.

---

## 1. Overview

There are three ways to test a gRPC service in Go, and choosing the right one per case is most of the skill.

**Call the handler directly.** `svc.GetItem(ctx, req)` is an ordinary method call. It is the fastest and simplest option, and it skips serialisation, interceptors, deadline propagation and status-code conversion entirely. Use it for business-logic branches where the transport is irrelevant.

**Use `bufconn`.** `google.golang.org/grpc/test/bufconn` provides an in-memory `net.Listener`. You run a real `grpc.Server` on it and dial with a custom dialer, so the whole stack executes — marshalling, the interceptor chain, metadata, deadlines, status codes — with no ports, no network and no flakiness. Tests run in microseconds and can be fully parallel. **This should be your default.**

**Use a real network or containers.** Necessary for TLS certificate verification, load-balancer behaviour, or anything involving a real database. Slow, and worth it only for the handful of things bufconn cannot exercise.

The reason bufconn matters so much is that the difference between "handler works" and "service works" is exactly the layer bufconn includes: an interceptor that rejects the request, a validation rule that fires, a domain error that maps to the wrong code, a field that fails to serialise. Those are the bugs that reach production, and a direct handler call cannot see any of them.

One migration note that trips people up: with `grpc.NewClient` (chapter 19) the default resolver is `dns`, so the classic `"bufnet"` target no longer works — you need `passthrough:///bufnet`.

## 2. Core Concepts

- **`bufconn.Listen(size)`** — an in-memory `net.Listener` backed by a buffered pipe.
- **`grpc.WithContextDialer`** — supplies a custom dialer so the client reaches the bufconn listener.
- **`passthrough:///bufnet`** — the required target form under `grpc.NewClient`.
- **Test fixture** — a helper returning a wired client plus a cleanup function.
- **Table-driven tests** — Go's idiom: a slice of cases, one loop, `t.Run` per case.
- **`protocmp.Transform()`** — the `go-cmp` option that makes protobuf comparison correct; `reflect.DeepEqual` is wrong.
- **Fake vs mock** — a fake is a working in-memory implementation; a mock asserts on calls. Prefer fakes.
- **`gomock` / `mockgen`** — generated mocks for the client interface, for testing *consumers*.
- **Golden bytes** — encoded fixtures from an older schema, the only way to catch field-number reuse (chapter 13).
- **`testcontainers-go`** — real dependencies in Docker for integration tests.
- **`-race`** — mandatory for anything with streaming or concurrency.

## 3. Theory & Principles

### The testing pyramid, gRPC-shaped

| Level | Tool | Speed | Covers | Use for |
|---|---|---|---|---|
| Unit | Direct call | ~µs | Business logic only | Branch coverage, edge cases |
| Service | **bufconn** | ~100 µs | Full gRPC stack, in-memory deps | **Most tests** |
| Integration | testcontainers | ~seconds | Real database, real queries | Storage behaviour |
| End-to-end | Real network | ~seconds+ | TLS, LB, deploys | A handful of critical paths |

The important claim is that **bufconn is not a compromise**. It exercises the same code paths as a network connection: the same codec, the same HTTP/2 framing, the same interceptor chain, the same status conversion. What it skips is the socket — and TCP is not where your bugs are.

### What bufconn catches that a direct call cannot

- **Interceptor behaviour**: auth rejections, validation failures, panic recovery, metrics.
- **Status-code mapping**: a handler returning a domain error becomes `Unknown` on the wire and the test sees it.
- **Serialisation**: a field that fails to marshal, a message exceeding `MaxRecvMsgSize`.
- **Metadata**: headers and trailers actually being set and received.
- **Deadline propagation**: `grpc-timeout` arriving as a server-side context deadline.
- **Streaming semantics**: `io.EOF` on `Recv`, `CloseSend` behaviour, flow control.
- **Concurrency**: run it with `-race` and real goroutine-per-stream behaviour.

That list is the reason a direct-call-only test suite passes while production fails.

### Fakes over mocks

A **mock** asserts on interactions: "`Get` was called once with `sku_1`". A **fake** is a working implementation: an in-memory map with the same semantics as the real store.

Prefer fakes, for three reasons. Mocks encode *how* the code works, so every refactor breaks tests that were not testing behaviour. Fakes let you write realistic multi-step scenarios — reserve, then confirm, then check — that mocks make painful. And a fake is reusable across the whole suite, while mock expectations are re-declared per test.

Mocks earn their place in two situations: testing a **consumer** of a gRPC client (where you want to control responses precisely, and `mockgen` on the generated client interface is ideal), and asserting that something *was not* called.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="tb1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">bufconn: the full stack, in memory</text>

  <rect x="24" y="42" width="410" height="220" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Direct handler call</text>
  <text x="42" y="88" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">resp, err := svc.GetItem(ctx, req)</text>
  <text x="42" y="112" fill="#b91c1c" font-size="10" font-weight="bold">SKIPS everything that actually breaks:</text>
  <g font-size="10" fill="#991b1b">
    <text x="42" y="134">&#10007; interceptors &#8212; auth, validation, recovery, metrics</text>
    <text x="42" y="152">&#10007; status mapping &#8212; a raw error becoming Unknown</text>
    <text x="42" y="170">&#10007; serialisation &#8212; marshal failures, size limits</text>
    <text x="42" y="188">&#10007; metadata &#8212; headers and trailers</text>
    <text x="42" y="206">&#10007; deadline propagation &#8212; grpc-timeout &#8594; ctx</text>
    <text x="42" y="224">&#10007; streaming &#8212; io.EOF, CloseSend, flow control</text>
  </g>
  <text x="42" y="250" fill="#7f1d1d" font-size="10" font-weight="bold">This list is why a direct-call suite passes and prod fails.</text>

  <rect x="446" y="42" width="410" height="220" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">bufconn</text>
  <rect x="466" y="80" width="110" height="34" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="521" y="101" text-anchor="middle" fill="#14532d" font-size="10">real client</text>
  <path d="M578,97 L616,97" stroke="#0ea5e9" stroke-width="2" marker-end="url(#tb1)"/>
  <rect x="620" y="80" width="100" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="670" y="96" text-anchor="middle" fill="#14532d" font-size="9">in-memory</text>
  <text x="670" y="108" text-anchor="middle" fill="#14532d" font-size="9">pipe</text>
  <path d="M722,97 L760,97" stroke="#0ea5e9" stroke-width="2" marker-end="url(#tb1)"/>
  <rect x="764" y="80" width="72" height="34" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="800" y="101" text-anchor="middle" fill="#14532d" font-size="10">real server</text>

  <g font-size="10" fill="#166534">
    <text x="464" y="140">&#10003; the SAME codec, framing, interceptors, status conversion</text>
    <text x="464" y="158">&#10003; ~100 &#181;s per call &#183; no ports &#183; no flakiness &#183; fully parallel</text>
    <text x="464" y="176">&#10003; works under -race with real goroutine-per-stream behaviour</text>
  </g>
  <text x="464" y="202" fill="#15803d" font-size="10" font-weight="bold">What it skips: the SOCKET. TCP is not where your bugs are.</text>
  <text x="464" y="226" fill="#b91c1c" font-size="10" font-weight="bold">Migration gotcha (grpc.NewClient):</text>
  <text x="464" y="244" fill="#991b1b" font-size="10">target must be "passthrough:///bufnet" &#8212; the default</text>
  <text x="464" y="258" fill="#991b1b" font-size="10">resolver is now dns, which tries to resolve "bufnet".</text>

  <rect x="24" y="280" width="832" height="190" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="302" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Fakes over mocks</text>

  <rect x="48" y="318" width="380" height="136" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="238" y="338" text-anchor="middle" fill="#15803d" font-weight="bold">Fake &#8212; a working implementation</text>
  <text x="62" y="360" fill="#166534" font-size="10">An in-memory map with the real store's semantics.</text>
  <text x="62" y="380" fill="#15803d" font-size="10" font-weight="bold">&#10003; survives refactors &#8212; it tests BEHAVIOUR</text>
  <text x="62" y="398" fill="#166534" font-size="10">&#10003; realistic multi-step scenarios: reserve &#8594; confirm &#8594; check</text>
  <text x="62" y="416" fill="#166534" font-size="10">&#10003; written once, reused across the whole suite</text>
  <text x="62" y="440" fill="#15803d" font-size="10" font-weight="bold">Default to this.</text>

  <rect x="452" y="318" width="380" height="136" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="642" y="338" text-anchor="middle" fill="#92400e" font-weight="bold">Mock &#8212; asserts on interactions</text>
  <text x="466" y="360" fill="#b45309" font-size="10">"Get was called once with sku_1"</text>
  <text x="466" y="380" fill="#b91c1c" font-size="10" font-weight="bold">&#10007; encodes HOW the code works &#8594; refactors break tests</text>
  <text x="466" y="398" fill="#991b1b" font-size="10">&#10007; multi-step scenarios become painful</text>
  <text x="466" y="418" fill="#92400e" font-size="10" font-weight="bold">Earns its place for:</text>
  <text x="466" y="440" fill="#b45309" font-size="10">testing CONSUMERS of a client &#183; asserting NOT called</text>
</svg>
```

### Comparing protobuf messages

`reflect.DeepEqual` on generated structs is wrong: they carry `state`, `sizeCache` and `unknownFields`, which can differ between two semantically identical messages. Use:

```go
proto.Equal(want, got)                       // boolean
cmp.Diff(want, got, protocmp.Transform())    // readable diff — prefer in tests
```

`protocmp.Transform()` also unlocks `protocmp.IgnoreFields` for server-set values like timestamps and generated ids, which is what makes assertions on real responses practical.

## 4. Architecture & Workflow

**The fixture pattern.** One helper builds the whole stack and returns a client:

1. Create the `bufconn` listener.
2. Build the server with the **real** interceptor chain — testing without it tests a different program.
3. Register the service with fake dependencies.
4. Serve in a goroutine.
5. Dial with `passthrough:///bufnet` plus a context dialer.
6. Register cleanup with `t.Cleanup`.

Every test then starts with one line, and because there are no ports, tests can be `t.Parallel()`.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The testing pyramid, gRPC-shaped</text>

  <path d="M440,44 L560,132 L320,132 Z" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="88" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">E2E</text>
  <text x="440" y="106" text-anchor="middle" fill="#991b1b" font-size="9">real network</text>
  <text x="600" y="90" fill="#991b1b" font-size="10">TLS verification, load balancing, deploys</text>
  <text x="600" y="106" fill="#991b1b" font-size="10">seconds+ &#183; a handful of critical paths only</text>

  <path d="M320,136 L560,136 L620,214 L260,214 Z" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="170" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Integration</text>
  <text x="440" y="190" text-anchor="middle" fill="#b45309" font-size="9">testcontainers</text>
  <text x="650" y="172" fill="#b45309" font-size="10">real database, real queries, migrations</text>
  <text x="650" y="188" fill="#b45309" font-size="10">seconds &#183; storage behaviour only</text>

  <path d="M260,218 L620,218 L700,320 L180,320 Z" fill="#dcfce7" stroke="#16a34a" stroke-width="3"/>
  <text x="440" y="256" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">bufconn &#8212; MOST TESTS</text>
  <text x="440" y="278" text-anchor="middle" fill="#166534" font-size="10">full gRPC stack, in-memory dependencies</text>
  <text x="440" y="298" text-anchor="middle" fill="#166534" font-size="10">~100 &#181;s &#183; no ports &#183; fully parallel &#183; -race clean</text>
  <text x="726" y="262" fill="#166534" font-size="10">interceptors, status codes,</text>
  <text x="726" y="278" fill="#166534" font-size="10">serialisation, metadata,</text>
  <text x="726" y="294" fill="#166534" font-size="10">deadlines, streaming</text>

  <path d="M180,324 L700,324 L760,392 L120,392 Z" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="352" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Unit &#8212; direct handler calls</text>
  <text x="440" y="374" text-anchor="middle" fill="#1d4ed8" font-size="10">business-logic branches where the transport is irrelevant &#183; ~&#181;s</text>

  <text x="120" y="412" fill="#334155" font-size="10" font-weight="bold">The claim worth internalising: bufconn is not a compromise. It runs the same code as a socket, minus the socket.</text>
</svg>
```

## 5. Implementation

### The bufconn fixture

```go
package inventory_test

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
	"github.com/acme/inventory/internal/inventory"
)

const bufSize = 1024 * 1024

type fixture struct {
	client inventoryv1.InventoryServiceClient
	store  *fakeStore
	server *grpc.Server
}

// newFixture wires the FULL stack over an in-memory pipe.
//
// The interceptor chain here must be the SAME one production uses. A fixture
// that omits auth or validation tests a different program from the one you
// ship, which is the single most common way a bufconn suite gives false
// confidence.
func newFixture(t *testing.T, opts ...fixtureOption) *fixture {
	t.Helper()

	cfg := defaultFixtureConfig()
	for _, o := range opts {
		o(&cfg)
	}

	lis := bufconn.Listen(bufSize)
	store := newFakeStore(cfg.seed...)

	srv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			interceptors.Recovery(testLogger(t)),
			interceptors.Logging(testLogger(t)),
			interceptors.Auth(cfg.verifier),
			interceptors.Validate(cfg.validator),
		),
		grpc.ChainStreamInterceptor(
			interceptors.RecoveryStream(testLogger(t)),
			interceptors.AuthStream(cfg.verifier),
		),
	)
	inventoryv1.RegisterInventoryServiceServer(srv, inventory.New(store))

	go func() {
		// After GracefulStop, Serve returns nil; anything else is a real failure.
		if err := srv.Serve(lis); err != nil {
			t.Errorf("bufconn serve: %v", err)
		}
	}()

	// "passthrough:///" is REQUIRED with grpc.NewClient: its default resolver
	// is dns, which would try to resolve the literal string "bufnet" and fail.
	// Under the deprecated grpc.Dial the default was passthrough, which is why
	// older examples use a bare "bufnet".
	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial bufconn: %v", err)
	}

	t.Cleanup(func() {
		conn.Close()
		srv.GracefulStop()
		lis.Close()
	})

	return &fixture{
		client: inventoryv1.NewInventoryServiceClient(conn),
		store:  store,
		server: srv,
	}
}
```

### Table-driven service tests

```go
func TestGetItem(t *testing.T) {
	t.Parallel() // no ports, so every test can run concurrently

	seed := []*inventoryv1.Item{
		{Sku: "sku_01HQ8ZK3M4A", Name: "Blue Widget", QuantityOnHand: 42},
		{Sku: "sku_01HQ8ZK3M4B", Name: "Red Widget", QuantityOnHand: 0},
	}

	tests := []struct {
		name     string
		token    string
		req      *inventoryv1.GetItemRequest
		wantCode codes.Code
		wantItem *inventoryv1.Item
		// wantReason asserts the STABLE ErrorInfo reason (chapter 22) rather
		// than a message string, so rewording a message never breaks a test.
		wantReason string
	}{
		{
			name:     "found",
			token:    validToken(t, "inventory:read"),
			req:      &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3M4A"},
			wantCode: codes.OK,
			wantItem: seed[0],
		},
		{
			name:     "zero quantity is a real value, not absent",
			token:    validToken(t, "inventory:read"),
			req:      &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3M4B"},
			wantCode: codes.OK,
			wantItem: seed[1],
		},
		{
			name:       "not found",
			token:      validToken(t, "inventory:read"),
			req:        &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3MZZ"},
			wantCode:   codes.NotFound,
			wantReason: "ITEM_NOT_FOUND",
		},
		{
			name:       "empty sku rejected by validation",
			token:      validToken(t, "inventory:read"),
			req:        &inventoryv1.GetItemRequest{Sku: ""},
			wantCode:   codes.InvalidArgument,
			wantReason: "VALIDATION_FAILED",
		},
		{
			// Only reachable through the real interceptor chain — a direct
			// handler call could never produce this.
			name:     "missing token",
			token:    "",
			req:      &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3M4A"},
			wantCode: codes.Unauthenticated,
		},
		{
			name:     "wrong scope",
			token:    validToken(t, "inventory:write"), // not :read
			req:      &inventoryv1.GetItemRequest{Sku: "sku_01HQ8ZK3M4A"},
			wantCode: codes.PermissionDenied,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			f := newFixture(t, withSeed(seed...))
			ctx := ctxWithToken(context.Background(), tc.token)

			resp, err := f.client.GetItem(ctx, tc.req)

			if got := status.Code(err); got != tc.wantCode {
				t.Fatalf("code = %v, want %v (err: %v)", got, tc.wantCode, err)
			}
			if tc.wantReason != "" {
				if got := errorReason(err); got != tc.wantReason {
					t.Errorf("ErrorInfo.reason = %q, want %q", got, tc.wantReason)
				}
			}
			if tc.wantCode != codes.OK {
				return
			}

			// protocmp.Transform is MANDATORY: generated structs carry
			// internal state, so reflect.DeepEqual is both wrong and useless
			// as a diff. IgnoreFields handles server-set values.
			if diff := cmp.Diff(tc.wantItem, resp.GetItem(),
				protocmp.Transform(),
				protocmp.IgnoreFields(&inventoryv1.Item{}, "created_at", "updated_at", "etag"),
			); diff != "" {
				t.Errorf("item mismatch (-want +got):\n%s", diff)
			}
		})
	}
}
```

### Testing streaming

```go
// TestWatchStock exercises a server stream end to end, including the
// success-vs-failure distinction that a direct handler call cannot reach.
func TestWatchStock(t *testing.T) {
	t.Parallel()
	f := newFixture(t, withSeed(seedItems...))

	ctx, cancel := context.WithTimeout(authedCtx(t), 5*time.Second)
	defer cancel()

	stream, err := f.client.WatchStock(ctx, &inventoryv1.WatchStockRequest{
		Skus: []string{"sku_01HQ8ZK3M4A"}, IncludeInitialSnapshot: true,
	})
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}

	// The snapshot arrives first.
	first, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv snapshot: %v", err)
	}
	if first.GetKind() != inventoryv1.StockEventKind_STOCK_EVENT_KIND_SNAPSHOT {
		t.Errorf("first event kind = %v, want SNAPSHOT", first.GetKind())
	}

	// Then a live change.
	f.store.Adjust("sku_01HQ8ZK3M4A", -5)

	ev, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv delta: %v", err)
	}
	if got, want := ev.GetQuantityOnHand(), int32(37); got != want {
		t.Errorf("quantity = %d, want %d", got, want)
	}
	if ev.GetResumeToken() == "" {
		// Without this the stream is not resumable (chapter 16), and the
		// omission is invisible until a production disconnect.
		t.Error("event carries no resume_token")
	}
}

// TestWatchStockFailsAfterData asserts the property clients get wrong: a
// stream can deliver messages and THEN fail, because the status is in
// trailers. A client that stops reading on the first error, or ignores the
// error once it has data, reports success for a failed call.
func TestWatchStockFailsAfterData(t *testing.T) {
	t.Parallel()
	f := newFixture(t, withFailAfter(3)) // server errors after 3 messages

	stream, err := f.client.WatchStock(authedCtx(t), &inventoryv1.WatchStockRequest{
		Skus: []string{"sku_01HQ8ZK3M4A"},
	})
	if err != nil {
		t.Fatal(err)
	}

	var received int
	for {
		_, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			t.Fatal("stream ended with io.EOF; expected a failure after data")
		}
		if err != nil {
			if got := status.Code(err); got != codes.Internal {
				t.Errorf("code = %v, want Internal", got)
			}
			break
		}
		received++
	}
	if received != 3 {
		t.Errorf("received %d messages before the error, want 3", received)
	}
}

// TestBulkAdjustRequiresCloseSend documents the classic hang: without
// CloseAndRecv the server blocks in Recv until the deadline.
func TestBulkAdjustRequiresCloseSend(t *testing.T) {
	t.Parallel()
	f := newFixture(t)

	ctx, cancel := context.WithTimeout(authedCtx(t), 1*time.Second)
	defer cancel()

	stream, err := f.client.BulkAdjustStock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&inventoryv1.AdjustStockRequest{
		Sku: "sku_01HQ8ZK3M4A", Delta: -1, AdjustmentId: "a1",
	}); err != nil {
		t.Fatal(err)
	}

	// Deliberately NOT calling CloseAndRecv: the deadline must fire.
	<-ctx.Done()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded, got %v", ctx.Err())
	}
}

// TestSyncBidiConcurrency must be run with -race. The two-goroutine structure
// is where stream concurrency bugs live (chapter 17).
func TestSyncBidiConcurrency(t *testing.T) {
	t.Parallel()
	f := newFixture(t, withSeed(seedItems...))

	stream, err := f.client.SyncInventory(authedCtx(t))
	if err != nil {
		t.Fatal(err)
	}

	// Exactly ONE Recv goroutine.
	responses := make(chan *inventoryv1.SyncResponse, 64)
	recvDone := make(chan error, 1)
	go func() {
		defer close(responses)
		for {
			r, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				recvDone <- nil
				return
			}
			if err != nil {
				recvDone <- err
				return
			}
			responses <- r
		}
	}()

	// Exactly ONE Send goroutine (this one). Correlation ids, because bidi
	// responses do NOT pair with requests by ordering.
	sent := map[string]string{}
	for i, sku := range []string{"sku_01HQ8ZK3M4A", "sku_01HQ8ZK3M4B"} {
		cid := fmt.Sprintf("c%d", i)
		sent[cid] = sku
		if err := stream.Send(&inventoryv1.SyncRequest{
			CorrelationId: cid,
			Payload: &inventoryv1.SyncRequest_CountReport{
				CountReport: &inventoryv1.CountReport{Sku: sku, CountedQuantity: 10},
			},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.CloseSend(); err != nil {
		t.Fatal(err)
	}

	got := map[string]bool{}
	for r := range responses {
		if cr := r.GetCountResult(); cr != nil {
			if sent[r.GetCorrelationId()] != cr.GetSku() {
				t.Errorf("correlation %q returned sku %q, want %q",
					r.GetCorrelationId(), cr.GetSku(), sent[r.GetCorrelationId()])
			}
			got[r.GetCorrelationId()] = true
		}
	}
	if err := <-recvDone; err != nil {
		t.Fatalf("recv loop: %v", err)
	}
	if len(got) != len(sent) {
		t.Errorf("got %d responses, want %d", len(got), len(sent))
	}
}
```

### A fake store

```go
// fakeStore is a working in-memory implementation with the SAME semantics as
// the real one — including the errors it returns, which is what makes the
// error-mapping tests meaningful.
type fakeStore struct {
	mu    sync.RWMutex
	items map[string]*inventoryv1.Item
	subs  []chan storeEvent

	// Hooks for failure injection, so a test can exercise the Internal path
	// without a broken database.
	failGet    error
	failAfterN int
	calls      int
}

func newFakeStore(seed ...*inventoryv1.Item) *fakeStore {
	s := &fakeStore{items: map[string]*inventoryv1.Item{}}
	for _, it := range seed {
		// Clone: a test must not be able to mutate another test's fixture
		// through a shared pointer.
		s.items[it.GetSku()] = proto.Clone(it).(*inventoryv1.Item)
	}
	return s
}

func (s *fakeStore) Get(ctx context.Context, sku string) (*inventoryv1.Item, error) {
	// Respect ctx: this is what makes deadline-propagation tests real.
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.Lock()
	s.calls++
	n, injected := s.calls, s.failGet
	s.mu.Unlock()

	if injected != nil {
		return nil, injected
	}
	if s.failAfterN > 0 && n > s.failAfterN {
		return nil, errors.New("injected storage failure")
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	it, ok := s.items[sku]
	if !ok {
		return nil, inventory.ErrNotFound
	}
	return proto.Clone(it).(*inventoryv1.Item), nil
}
```

### Mocks for testing a consumer

```go
//go:generate mockgen -destination=mock_inventory_test.go -package=orders_test \
//   github.com/acme/apis/gen/go/acme/inventory/v1 InventoryServiceClient

// TestPlaceOrderHandlesInsufficientStock tests the ORDERS service, so the
// inventory client is the thing to control. A mock is right here: we want
// precise control over the error, including its structured details.
func TestPlaceOrderHandlesInsufficientStock(t *testing.T) {
	ctrl := gomock.NewController(t)
	inv := NewMockInventoryServiceClient(ctrl)

	st, _ := status.New(codes.FailedPrecondition, "insufficient stock").WithDetails(
		&errdetails.ErrorInfo{
			Reason: "INSUFFICIENT_STOCK", Domain: "inventory.acme.com",
			Metadata: map[string]string{"sku": "sku_1", "available": "3", "requested": "10"},
		},
	)

	inv.EXPECT().
		ReserveStock(gomock.Any(), gomock.Any(), gomock.Any()).
		Return(nil, st.Err())

	svc := orders.New(inv)
	_, err := svc.PlaceOrder(context.Background(), &ordersv1.PlaceOrderRequest{
		Sku: "sku_1", Quantity: 10,
	})

	// The orders service must translate the detail into a partial-order offer,
	// reading the STRUCTURED metadata rather than parsing the message.
	var partial *orders.PartialStockError
	if !errors.As(err, &partial) {
		t.Fatalf("expected PartialStockError, got %v", err)
	}
	if partial.Available != 3 {
		t.Errorf("available = %d, want 3", partial.Available)
	}
}
```

### Testing interceptors in isolation

```go
func TestRecoveryInterceptor(t *testing.T) {
	interceptor := interceptors.Recovery(testLogger(t))

	_, err := interceptor(context.Background(), nil,
		&grpc.UnaryServerInfo{FullMethod: "/test.Service/Method"},
		func(ctx context.Context, req any) (any, error) {
			panic("boom")
		})

	if got := status.Code(err); got != codes.Internal {
		t.Fatalf("code = %v, want Internal", got)
	}
	// The stack trace must NOT reach the client.
	if strings.Contains(status.Convert(err).Message(), "boom") {
		t.Error("panic value leaked into the client-visible message")
	}
}

func TestInterceptorCanSetHeader(t *testing.T) {
	// grpc.SetHeader silently fails when the context lacks a
	// ServerTransportStream. In a real chain it is always present; in an
	// isolated test it is not, and the resulting silent no-op is a genuinely
	// confusing debugging session.
	var captured metadata.MD
	ctx := grpc.NewContextWithServerTransportStream(context.Background(),
		&fakeTransportStream{setHeader: func(md metadata.MD) error {
			captured = md
			return nil
		}})

	_, _ = interceptors.ResponseHeaders("v1.8.0")(ctx, nil,
		&grpc.UnaryServerInfo{FullMethod: "/test.Service/Method"},
		func(ctx context.Context, req any) (any, error) { return nil, nil })

	if got := captured.Get("x-server-version"); len(got) == 0 || got[0] != "v1.8.0" {
		t.Errorf("header = %v, want v1.8.0", got)
	}
}
```

### Integration tests with a real database

```go
//go:build integration

func TestInventoryStoreWithPostgres(t *testing.T) {
	ctx := context.Background()

	// A real Postgres, so migrations, constraints, transaction isolation and
	// query behaviour are exercised. Slow — which is why this tier stays small
	// and is build-tagged out of the default `go test ./...`.
	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("inventory"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(30*time.Second)),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pg.Terminate(ctx) })

	dsn, _ := pg.ConnectionString(ctx, "sslmode=disable")
	store, err := storage.OpenPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(ctx, store); err != nil {
		t.Fatal(err)
	}

	// The behaviour a fake genuinely cannot reproduce: real concurrency
	// semantics under the database's isolation level.
	t.Run("concurrent reservations do not oversell", func(t *testing.T) {
		_ = store.Put(ctx, &inventoryv1.Item{Sku: "sku_x", QuantityOnHand: 10})

		var wg sync.WaitGroup
		results := make([]error, 20)
		for i := range results {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				_, results[i] = store.Reserve(ctx, storage.ReserveParams{
					IdempotencyKey: fmt.Sprintf("k%d", i),
					Lines:          []storage.Line{{SKU: "sku_x", Quantity: 1}},
				})
			}(i)
		}
		wg.Wait()

		var ok int
		for _, err := range results {
			if err == nil {
				ok++
			}
		}
		if ok != 10 {
			t.Errorf("%d reservations succeeded, want exactly 10", ok)
		}
	})
}
```

### Golden bytes for schema compatibility

```go
// goldenV16Item is a real Item encoded by the v1.6 schema, captured from a
// production event log.
//
// This is the ONLY kind of test that can catch field-number reuse (chapter 13),
// because every other test encodes with TODAY's schema and therefore cannot
// observe the incompatibility.
const goldenV16Item = "0a0d736b755f303148513858..."

func TestOldEncodedBytesStillParse(t *testing.T) {
	raw, err := hex.DecodeString(goldenV16Item)
	if err != nil {
		t.Fatal(err)
	}

	var item inventoryv1.Item
	if err := proto.Unmarshal(raw, &item); err != nil {
		t.Fatalf("v1.6 bytes no longer parse: %v", err)
	}
	if got, want := item.GetQuantityOnHand(), int32(42); got != want {
		t.Errorf("quantity_on_hand = %d, want %d — a field number may have been reused", got, want)
	}

	// Unknown fields must survive a round trip, or a pass-through service
	// would silently destroy data it cannot see.
	out, _ := proto.Marshal(&item)
	if len(out) != len(raw) {
		t.Errorf("round trip changed size %d -> %d; unknown fields were dropped", len(raw), len(out))
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of bufconn**
- **Realistic and fast at once** — the full stack in ~100 µs.
- **No ports**, so no collisions and full `t.Parallel()`.
- **Deterministic** — no network flakiness, so no retries in CI.
- **`-race` clean** with real goroutine-per-stream behaviour, which is where streaming bugs live.
- **Exercises interceptors and status mapping**, the layer that actually breaks.

**Disadvantages**
- **No TLS verification** — certificate and mTLS problems need a real connection.
- **No load-balancer behaviour** — resolvers, `round_robin` and connection rotation are invisible.
- **No real network conditions** — latency, loss and MTU effects do not appear.
- **`passthrough:///` is a required gotcha** after the `NewClient` migration.

**Trade-offs**
- *Fakes vs mocks:* fakes survive refactors and enable realistic scenarios; mocks give precise control and are right for testing consumers of a client.
- *bufconn vs testcontainers:* bufconn for everything except genuine storage semantics; containers for isolation levels, constraints and migrations. Keep the container tier small and build-tagged.
- *Interceptors in the fixture vs not:* including them makes tests realistic but means every test needs a valid token. Include them, and provide a helper that mints one.

## 7. Common Mistakes & Best Practices

- **Testing handlers directly only.** Misses interceptors, status mapping, serialisation, deadlines and every streaming semantic.
- **A fixture without the real interceptor chain.** You are testing a different program from the one you deploy.
- **`"bufnet"` without `passthrough:///`** under `grpc.NewClient`. The `dns` resolver tries to resolve it and fails.
- **`reflect.DeepEqual` on messages.** Generated structs carry internal state; use `protocmp.Transform()`.
- **Asserting on `st.Message()`.** Rewording a message then breaks tests. Assert on the code and the stable `ErrorInfo.reason`.
- **No streaming tests.** `io.EOF` handling, `CloseSend` and flow control are exactly where the bugs are.
- **Not running `-race`.** Bidi concurrency bugs are invisible without it.
- **Mocking everything.** Tests then assert on implementation and break on every refactor.
- **Fakes that ignore `ctx`.** Deadline-propagation tests become meaningless.
- **Fakes that share pointers with the test.** One test mutates another's fixture. Clone on read and write.
- **No golden-byte tests.** Field-number reuse is undetectable by tests that encode with the current schema.
- **Forgetting `t.Cleanup`.** Leaked goroutines and listeners across a package's tests.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **CI.** Run `go test -race ./...` on every PR, with the container-backed tier behind a build tag so the default run stays fast. Add `buf breaking` (chapter 8) and the golden-byte tests, since those catch a class of failure no unit test can.
- **Coverage that matters.** Aim for full coverage of the *error* paths, not just the happy ones — every status code your service can return should have a test. That is what makes the error vocabulary (chapter 22) trustworthy.
- **Security testing.** Assert authorization negatively: every method rejects a missing token, an expired token and a wrong scope. Add the reflection-driven test from chapter 24 that enumerates every registered method and asserts it has a policy — that is what catches the newly added RPC.
- **Scaling the suite.** bufconn tests are fast enough that thousands run in seconds; keep them that way by fully parallelising, avoiding sleeps in favour of synchronisation, and keeping the container tier small. A suite that takes twenty minutes is a suite people skip.

## 9. Interview Questions

**Q: What is `bufconn` and why use it?**
A: An in-memory `net.Listener` from `google.golang.org/grpc/test/bufconn`. You run a real `grpc.Server` on it and dial with a custom dialer, so the entire gRPC stack executes — codec, HTTP/2 framing, interceptor chain, metadata, deadlines, status conversion — with no ports and no network. Tests run in around a hundred microseconds, never flake, and can be fully parallel. The reason to prefer it over calling handlers directly is that the layer it adds is exactly where the bugs are: an interceptor rejecting the request, a domain error mapping to the wrong code, a message failing to serialise.

**Q: What does a direct handler call miss?**
A: Everything between the wire and the handler. Interceptors — so auth rejections, validation failures and panic recovery are untested. Status mapping — a handler returning a raw Go error becomes `Unknown` on the wire, and a direct call sees the original error instead. Serialisation, so marshalling failures and message-size limits are invisible. Metadata, headers and trailers. Deadline propagation from `grpc-timeout`. And every streaming semantic: `io.EOF` on `Recv`, `CloseSend`, flow control. That list is why a direct-call-only suite passes while production fails.

**Q: Why must a bufconn target be `passthrough:///bufnet`?**
A: Because `grpc.NewClient` defaults to the `dns` resolver, so a bare `"bufnet"` is treated as a hostname and resolution fails. The deprecated `grpc.Dial` defaulted to `passthrough`, which handed the string straight to the custom dialer — which is why older examples use a bare name and break after the migration. Adding the explicit `passthrough:///` scheme restores the old behaviour and is the standard fix.

**Q: How do you compare protobuf messages in tests?**
A: `cmp.Diff(want, got, protocmp.Transform())` for a readable diff, or `proto.Equal` for a boolean. Never `reflect.DeepEqual`: generated structs carry `state`, `sizeCache` and `unknownFields`, so two semantically identical messages can compare unequal, and the failure output is unreadable. `protocmp.Transform` also unlocks `protocmp.IgnoreFields`, which is how you assert on a real response containing server-set timestamps and generated ids.

**Q: Fakes or mocks?**
A: Fakes by default. A fake is a working in-memory implementation with the same semantics as the real dependency, including the errors it returns, so tests assert on behaviour and survive refactors, and multi-step scenarios like reserve-then-confirm-then-check are natural. A mock encodes how the code works, so every refactor breaks tests that were not testing behaviour. Mocks earn their place for testing a *consumer* of a gRPC client, where `mockgen` on the generated client interface gives precise control over responses and their structured details, and for asserting that something was not called.

**Q: How do you test that a stream can fail after delivering data?**
A: Configure the server to error after N messages, then in the client loop count messages and assert that the loop ends with the expected status code rather than `io.EOF`. This is worth an explicit test because it is the property clients most often get wrong: the status lives in HTTP/2 trailers after the body, so a client that breaks out of the loop on any error, or ignores the error once it has data, reports success for a failed call. A direct handler call cannot reach this behaviour at all.

**Q: What do golden-byte tests catch that nothing else does?**
A: Field-number reuse and unknown-field loss. Every ordinary test encodes with today's schema, so it structurally cannot observe that number 3 used to mean something else — the old bytes never exist in the test. Committing real messages encoded by an older schema as hex fixtures, then asserting they still parse to the right values and that a re-marshal preserves the byte length, is the only way to detect it. It matters because number reuse produces silent misinterpretation rather than an error, and stored data in queues and event logs outlives every running binary.

**Q: (Senior) Design the test strategy for a gRPC service.**
A: Four tiers with deliberate proportions. A small unit tier calling handlers or domain functions directly, for business-logic branches where the transport is irrelevant. A large bufconn tier that is the default — the full stack with the real interceptor chain and fake dependencies, table-driven, fully parallel, covering every status code the service can return and every streaming semantic including `io.EOF`, `CloseSend` and failure-after-data. A small integration tier behind a build tag using testcontainers, for the things a fake genuinely cannot reproduce: transaction isolation, constraints, migrations, concurrent-update semantics. And a handful of end-to-end tests for TLS verification, load balancing and deploy behaviour. On top of those, three cross-cutting suites: negative authorization tests for every method plus the reflection-driven policy-coverage test, golden-byte tests for schema compatibility, and `buf breaking` in CI. Everything runs with `-race`, and the default `go test ./...` stays under about thirty seconds, because a suite people skip protects nothing.

**Q: (Senior) Your test suite passes but production breaks on every release. What is missing?**
A: The first hypothesis is that tests call handlers directly, so the entire interceptor and transport layer is untested — auth, validation, error mapping and serialisation all only run in production. The fix is a bufconn fixture using the real interceptor chain. The second is that the fixture exists but omits interceptors "to keep tests simple", which is the same problem wearing a disguise: the tested program is not the shipped program. Third, error paths are untested — a suite covering only happy paths will not notice that a domain error maps to `Unknown` and leaks a SQL fragment. Fourth, streaming is untested, so `io.EOF` handling, missing `CloseSend` and flow-control behaviour surface only under real load. Fifth, schema compatibility is unchecked, so a field rename or number reuse ships and breaks consumers or corrupts stored data. I would add the bufconn tier first, because it addresses the largest share, then the negative authorization suite, then golden bytes and `buf breaking` — and I would look at what the last five incidents were, because that list usually names the missing tier directly.

**Q: (Senior) How do you test deadline propagation and cancellation?**
A: bufconn makes this straightforward because it carries `grpc-timeout` exactly as a socket would. For propagation, I set a short client deadline and have the fake store record whether the context it received had one and what its remaining budget was — asserting the budget is less than the client's confirms the header made the round trip and the server derived from it. For cancellation, the fake blocks on a channel until the context fires, and the test asserts the handler returned promptly with `DeadlineExceeded` rather than after the fake's nominal duration; that catches the common bug of a handler passing `context.Background()` to its store. For streaming, I cancel the client context mid-stream and assert the server handler's `stream.Context()` fired, which catches handlers that use a stored context instead. And I add a negative test for a `context.Background()` call against the deadline-enforcement interceptor, so a client that forgets a deadline is rejected loudly rather than holding resources indefinitely.

## 10. Quick Revision & Cheat Sheet

```go
lis := bufconn.Listen(1024 * 1024)
srv := grpc.NewServer(grpc.ChainUnaryInterceptor(realChain...))  // the REAL chain
pb.RegisterServiceServer(srv, svc)
go srv.Serve(lis)

conn, _ := grpc.NewClient(
    "passthrough:///bufnet",                     // REQUIRED with NewClient
    grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
        return lis.DialContext(ctx)
    }),
    grpc.WithTransportCredentials(insecure.NewCredentials()),
)
t.Cleanup(func() { conn.Close(); srv.GracefulStop(); lis.Close() })

// Comparison
cmp.Diff(want, got, protocmp.Transform(),
    protocmp.IgnoreFields(&pb.Item{}, "created_at", "etag"))
```

| Test | Tool |
|---|---|
| Business-logic branch | Direct call |
| Handler + interceptors + status | **bufconn** |
| Streaming semantics | bufconn + `-race` |
| Consumer of a client | `mockgen` on the client interface |
| Transaction isolation | testcontainers |
| TLS / load balancing | Real network |
| Schema compatibility | Golden bytes + `buf breaking` |
| Message comparison | `protocmp.Transform()` |

**Flash cards**
- **Default test level?** → bufconn, with the real interceptor chain.
- **bufconn target?** → `passthrough:///bufnet` under `grpc.NewClient`.
- **Comparing messages?** → `protocmp.Transform()`, never `reflect.DeepEqual`.
- **Assert on what, for errors?** → The code and the stable `ErrorInfo.reason`. Never the message.
- **Fake or mock?** → Fake, unless testing a consumer of a client.
- **Field-number reuse?** → Only golden bytes can catch it.
- **Streaming tests?** → Always with `-race`.

## 11. Hands-On Exercises & Mini Project

- [ ] Build the bufconn fixture and convert an existing direct-call test to it. Note which assertions became possible.
- [ ] Use `"bufnet"` without `passthrough:///` under `grpc.NewClient`, read the resolver error, then fix it.
- [ ] Compare two messages with `reflect.DeepEqual` and with `cmp.Diff(..., protocmp.Transform())`. Compare the failure output.
- [ ] Write the failure-after-data streaming test, then deliberately write the naive client loop and watch it report success.
- [ ] Write the bidi concurrency test and run it with and without `-race`.
- [ ] Add negative authorization tests for every method, plus the reflection-driven policy-coverage test. Add a new RPC and watch it fail.
- [ ] Capture a real encoded message as hex, evolve the schema, and keep the golden test green. Then reuse a field number and watch it fail.
- [ ] Write a deadline-propagation test that asserts the fake store received a context with a remaining budget smaller than the client's deadline.

### Mini Project — "Complete Test Suite"

**Goal.** Build a test suite that would have caught your last five production incidents, and prove the properties that make it trustworthy.

**Requirements.**
1. A bufconn fixture using the real interceptor chain, with options for seeding, failure injection and token minting.
2. Table-driven tests for every method covering every status code the service can return, asserting on code and stable `ErrorInfo.reason` rather than messages.
3. Streaming tests for all three shapes: `io.EOF` success, failure after data, missing `CloseSend`, resume-token presence, and bidi correlation under `-race`.
4. A fake store honouring `ctx`, cloning on read and write, and offering failure injection.
5. `mockgen`-based tests for a consumer service, asserting it acts on structured error details.
6. Negative authorization tests for every method plus the reflection-driven policy-coverage test.
7. A build-tagged integration tier with testcontainers covering concurrent updates, constraints and migrations.
8. Golden-byte tests plus `buf breaking` in CI.
9. `go test -race ./...` completing in under 30 seconds, fully parallel.

**Extensions.**
- Add a fuzz test over request messages asserting no input can panic or produce `codes.Unknown`.
- Add a benchmark comparing direct calls against bufconn and quantify the overhead you are paying for realism.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The gRPC Server* (the wiring the fixture reuses), *Interceptors* (what bufconn exercises that direct calls do not), *The Error Model* (asserting on codes and reasons), *Client-Side & Bidirectional Streaming Handlers* (the semantics being tested), *Schema Evolution* (why golden bytes exist).

- **grpc-go — test/bufconn package** — gRPC Authors · *Intermediate* · the in-memory listener, its buffer semantics and `DialContext`. <https://pkg.go.dev/google.golang.org/grpc/test/bufconn>
- **google.golang.org/protobuf/testing/protocmp** — Go Protobuf Authors · *Intermediate* · `Transform`, `IgnoreFields`, `SortRepeated` and why `reflect.DeepEqual` is wrong for messages. <https://pkg.go.dev/google.golang.org/protobuf/testing/protocmp>
- **Go — testing package and subtests** — The Go Authors · *Beginner* · table-driven tests, `t.Run`, `t.Parallel` and `t.Cleanup`, the idioms this chapter is built on. <https://pkg.go.dev/testing>
- **go-cmp** — Google (open source) · *Intermediate* · readable structural diffs, options and custom comparers. <https://pkg.go.dev/github.com/google/go-cmp/cmp>
- **gomock / mockgen** — Uber fork (open source) · *Intermediate* · generating mocks from the generated gRPC client interfaces, for testing consumers. <https://github.com/uber-go/mock>
- **testcontainers-go** — Testcontainers (open source) · *Intermediate* · real dependencies in Docker with wait strategies, for the integration tier. <https://golang.testcontainers.org/>
- **Go Blog — Race Detector** — The Go Authors · *Intermediate* · what `-race` catches and why streaming tests must run under it. <https://go.dev/blog/race-detector>
- **grpc-go examples and interop tests** — gRPC Authors · *Intermediate* · how the maintainers themselves structure tests over bufconn and real connections. <https://github.com/grpc/grpc-go/tree/master/test>

---

*gRPC with Go Handbook — chapter 27.*
