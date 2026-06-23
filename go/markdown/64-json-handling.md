# 64 · JSON Handling

> **In one line:** Go's `encoding/json` turns Go values into JSON and back using reflection, struct tags, and streaming decoders — and mastering its edge cases separates correct services from subtly broken ones.

---

## 1. Overview

JSON is the lingua franca of backend engineering: REST APIs, config files, message queues, structured logs, and most service-to-service contracts speak it. Go ships JSON support in the standard library via the `encoding/json` package, so you almost never reach for a third-party encoder for correctness reasons (only for performance).

The two workhorses are `json.Marshal` (Go value → `[]byte`) and `json.Unmarshal` (`[]byte` → Go value). For payloads that don't fit in memory or arrive over a network, you stream with `json.Encoder` and `json.Decoder`. Field-level behavior — names, omission, embedding — is controlled declaratively through **struct tags**. Custom types control their own wire format by implementing `json.Marshaler` / `json.Unmarshaler`.

This chapter focuses on what production systems actually trip over: zero-value vs. absent fields, numeric precision, streaming large payloads, and the cost of reflection at scale.

> [!NOTE]
> Go 1.25 introduced an experimental `encoding/json/v2` (gated behind `GOEXPERIMENT=jsonv2`). This chapter targets the stable `encoding/json` (v1) that virtually all production code uses today, and flags v2 differences where relevant.

---

## 2. Why It Exists

Before `encoding/json`, you'd hand-roll serialization or use unsafe `fmt`-based hacks. The package exists to provide a **safe, reflection-driven, spec-compliant** bridge between Go's static type system and JSON's dynamic, schemaless documents.

It solves three concrete problems:

1. **Type mapping.** JSON has 6 types (object, array, string, number, boolean, null); Go has dozens. The package defines the canonical mapping (numbers → `float64` when decoding into `interface{}`, objects → `map[string]interface{}`, etc.).
2. **Declarative customization.** Struct tags let you decouple your Go field names (Go style: exported PascalCase) from your wire contract (often snake_case) without writing manual code.
3. **Round-trip safety.** It handles UTF-8 validation, escaping (`<`, `>`, `&` are HTML-escaped by default), and RFC 8259 compliance so you don't reinvent it badly.

The design trade-off baked in: it favors **correctness and ergonomics over raw speed**. Reflection makes it general but slower than codegen approaches like `easyjson` or `ffjson`.

---

## 3. Internal Working

`json.Marshal` does not magically know your struct. At runtime it uses the `reflect` package to walk the value, and it builds an **encoder function** per type, which it caches.

**The encoder cache.** The first time you marshal a `type User struct{...}`, `encoding/json` computes a `encoderFunc` — a closure specialized for that type's fields, tags, and kinds — and stores it in a `sync.Map` keyed by `reflect.Type`. Subsequent marshals of the same type skip the analysis and reuse the cached encoder. This is why the *first* marshal of a type is measurably slower (cold path) and steady-state is faster.

**Struct field analysis.** For structs, the package builds a `[]field` describing each exported field: its JSON name (from tag or field name), index path (to reach embedded fields), `omitempty` flag, quoting, and a pre-resolved encoder for the field's type. Embedded structs are flattened per Go's field-promotion rules; conflicts at the same depth are dropped.

```text
json.Marshal(u)  // u is type User
        │
        ▼
 reflect.TypeOf(u) ──► look up in encoderCache (sync.Map)
        │                         │
        │ miss                    │ hit
        ▼                         ▼
 newTypeEncoder()          cached encoderFunc(e, v)
   analyze fields                 │
   resolve tags                   ▼
   build []field ──► store ──► write into bytes.Buffer (encodeState)
        │                          (pooled via sync.Pool)
        ▼
   structEncoder closure
```

**Memory layout.** Marshaling writes into an `encodeState`, which wraps a `bytes.Buffer`. These `encodeState` objects are recycled through a `sync.Pool` to cut allocations across calls. The final `Marshal` copies the buffer into a fresh `[]byte` so the pooled buffer can be returned — meaning every `Marshal` allocates at least once for the result.

**Decoding** is the mirror: `json.Unmarshal` runs a scanner (a hand-written state machine, not regex) that tokenizes bytes, then a decoder that, per token, uses reflection to assign into the destination. Decoding into `interface{}` allocates `map[string]interface{}` / `[]interface{}` / `float64` — heavy on allocations and the reason typed structs are far cheaper.

**Interface dispatch.** Before reflection, the encoder checks whether the type implements `json.Marshaler` or `encoding.TextMarshaler`. If so, it calls that method instead. This check is the hook for custom formats (Section 11).

---

## 4. Syntax

```go
// Encode
b, err := json.Marshal(v)                 // compact
b, err := json.MarshalIndent(v, "", "  ") // pretty-printed

// Decode
err := json.Unmarshal(data, &v)           // pointer required

// Streaming
dec := json.NewDecoder(r) // r is io.Reader
err = dec.Decode(&v)
enc := json.NewEncoder(w) // w is io.Writer
err = enc.Encode(v)       // appends a trailing newline
```

Struct tags — the core of field control:

```go
type Order struct {
    ID        string  `json:"id"`                  // rename
    Total     float64 `json:"total,omitempty"`     // omit if zero value
    Internal  string  `json:"-"`                   // never serialize
    Hyphen    string  `json:"-,"`                  // field literally named "-"
    Count     int     `json:"count,string"`        // encode number as JSON string
    CreatedAt int64   `json:",omitempty"`          // keep Go name, add option
}
```

Decoder options that matter in production:

```go
dec.DisallowUnknownFields() // error on JSON keys with no matching field
dec.UseNumber()             // decode numbers as json.Number, not float64
```

---

## 5. Common Interview Questions

**Q1. Why must `Unmarshal` take a pointer?**
Go is pass-by-value. To mutate the caller's variable, the package needs its address. Passing a non-pointer (or nil pointer) returns an `InvalidUnmarshalError`.
*Follow-up: what about Marshal?* `Marshal` only reads, so a value is fine — though a pointer also works and is dereferenced.

**Q2. What's the difference between `omitempty` and a missing field on decode?**
`omitempty` is an *encode* directive: it skips fields whose value is the zero value (0, "", nil, empty slice/map, false). On *decode*, a missing JSON key simply leaves the Go field at its zero value — you cannot distinguish "absent" from "explicitly zero" without a pointer or `json.RawMessage`.
*Follow-up: how do you detect explicit null vs absent?* Use `*T` (pointer): absent → nil pointer; `null` → nil pointer too in v1, so to distinguish all three states you need `json.RawMessage` or a custom `Unmarshaler` with a "was set" bool.

**Q3. Why do numbers come back as `float64`?**
When decoding into `interface{}`, JSON numbers map to `float64` because JSON has a single number type. This loses precision for integers above 2^53.
*Follow-up: how do you preserve a large int64 ID?* Call `dec.UseNumber()` and read `json.Number` (a string), or decode into a typed struct with an `int64` field.

**Q4. Are struct tags required for unexported fields?**
Unexported (lowercase) fields are **never** marshaled or unmarshaled, tags or not. Only exported fields participate.
*Follow-up: how to serialize private state?* Add an exported field, or implement `MarshalJSON` to build the output manually.

**Q5. `Marshal` vs `Encoder.Encode` — when each?**
`Marshal` returns a `[]byte`, ideal when you need the bytes (caching, signing). `Encoder.Encode` streams to an `io.Writer`, avoids holding the whole payload in memory, and is the right tool for HTTP responses and large/streamed data. Note `Encode` appends a newline.
*Follow-up: which is faster for an HTTP handler?* `Encoder` can be marginally better (no intermediate full buffer copy), but the real win is memory for large bodies.

**Q6. Why is `<` rendered as `<`?**
`encoding/json` HTML-escapes `<`, `>`, `&` by default so output is safe to embed in `<script>` tags. Disable with `enc.SetEscapeHTML(false)`.
*Follow-up: when must you disable it?* When generating JSON for non-HTML consumers that do byte-exact comparison (e.g. signatures), or readable config files.

**Q7. How does Go marshal a `map`? Is order deterministic?**
Maps marshal as JSON objects with keys **sorted lexically** (string keys), which makes output deterministic — handy for golden-file tests. Struct field order follows declaration order.
*Follow-up: is that guaranteed by the spec?* It's documented behavior in `encoding/json`, so yes you can rely on it for v1.

**Q8. What happens if a struct has duplicate JSON keys in the input?**
On decode, `encoding/json` takes the **last** value for a duplicated key. The spec (RFC 8259) leaves duplicate handling to implementations, so don't rely on this cross-language.
*Follow-up: any security angle?* Yes — parser disagreement on duplicate keys has caused auth-bypass bugs in polyglot systems; reject duplicates explicitly if it matters.

---

## 6. Production Use Cases

- **HTTP APIs.** Every Go web framework (`net/http`, Gin, Echo, Chi) decodes request bodies with `json.NewDecoder(r.Body).Decode(&req)` and writes responses via `json.NewEncoder(w).Encode(resp)`. Kubernetes' API machinery and the `client-go` library are built on JSON (and YAML→JSON) serialization of typed resources.
- **Configuration.** Terraform state files, VS Code settings, and many service configs are JSON; `DisallowUnknownFields` catches typos at load time.
- **Message queues / event streams.** Kafka, NATS, and SQS payloads are frequently JSON-encoded events. Consumers use `json.RawMessage` to defer decoding of the polymorphic `data` field until the `type` discriminator is read.
- **Structured logging.** `log/slog`, Uber's `zap`, and `zerolog` emit JSON log lines; zap and zerolog hand-write JSON encoders to avoid reflection overhead in hot logging paths.
- **gRPC-gateway / OpenAPI.** Tools that bridge protobuf and REST use JSON marshaling for the HTTP edge.
- **Webhooks.** Stripe, GitHub, and Slack send JSON webhook payloads; services verify an HMAC over the *raw* bytes, so they read the body once (`io.ReadAll`) before unmarshaling.

---

## 7. Common Mistakes

> [!WARNING]
> The most common production bug: **reading `r.Body` twice.** Once `json.Decoder` consumes it, it's gone. If you also need the raw bytes (for signature verification), `io.ReadAll` first, then `json.Unmarshal` the bytes.

- **Forgetting the pointer:** `json.Unmarshal(data, v)` silently does nothing useful and returns an error you must check.
- **Lowercase fields:** `firstName string` is invisible to the package. Always export and tag: `FirstName string` with `` `json:"firstName"` ``.
- **`omitempty` on structs:** It does **not** omit a zero-valued non-pointer struct (a struct is never "empty"). Use `*MyStruct` if you want it omitted when nil.
- **Float ID precision loss:** decoding `{"id": 12345678901234567}` into `interface{}` corrupts the value silently.
- **Ignoring `Decode` returning `io.EOF`:** on streaming, EOF signals end-of-stream, not an error.
- **Assuming field order in objects on decode:** decode order is irrelevant, but people sometimes write parsers assuming it.
- **Marshaling time.Time and expecting Unix:** `time.Time` marshals to RFC 3339 strings by default, not epoch seconds.

---

## 8. Performance Considerations

Reflection is the cost center. Concrete guidance:

| Concern | Cost | Mitigation |
|---|---|---|
| First marshal of a type | Builds + caches encoder | Warm up at startup if latency-critical |
| Decode into `interface{}` | Many allocs (maps/slices) | Decode into typed structs |
| Large payloads via `Marshal` | Whole body in memory | Use `Encoder`/`Decoder` streaming |
| `json.Number`/`UseNumber` | String alloc per number | Only when precision matters |
| HTML escaping | Extra branch per byte | `SetEscapeHTML(false)` if safe |

Numbers worth knowing: `encoding/json` is roughly **2–5x slower** than codegen libraries (`easyjson`, `sonic`, `goccy/go-json`) for marshal-heavy workloads. ByteDance's `sonic` uses JIT + SIMD and can be 2–10x faster; it's the go-to when JSON is your bottleneck. But default to stdlib — it's correct and maintained.

Reduce allocations by:
- Reusing a `json.Decoder` across multiple objects in a stream.
- Pooling destination structs with `sync.Pool` in hot paths.
- Using `json.RawMessage` to skip decoding sub-trees you don't need.

> [!TIP]
> Profile before swapping libraries. Most services are I/O- or DB-bound; JSON rarely dominates unless you're a high-QPS edge proxy or a log pipeline.

---

## 9. Best Practices

1. **Define explicit DTO structs** for every API boundary; don't decode into `map[string]interface{}` except for genuinely dynamic payloads.
2. **Always tag fields** with the exact wire name — never rely on Go's name-mangling defaulting to PascalCase.
3. **Use pointers or `RawMessage`** when you must distinguish absent / null / zero.
4. **Stream large bodies** with `Encoder`/`Decoder`; cap request size with `http.MaxBytesReader`.
5. **`DisallowUnknownFields()`** on internal/config decoders to fail loud on schema drift; leave it off on public APIs where forward-compat matters.
6. **Always check the error** from `Encode`/`Decode`/`Unmarshal` — partial writes and malformed input are routine.
7. **Validate after decode.** JSON decode success ≠ semantic validity; run a validator (e.g. `go-playground/validator`).
8. **Version your contracts** — additive changes (new optional fields) are safe; renames/removals are breaking.

---

## 10. Code Examples

Primary idiomatic example — an HTTP handler with streaming decode, size limiting, and strict fields:

```go
type CreateUserReq struct {
    Name  string `json:"name"`
    Email string `json:"email"`
    Age   *int   `json:"age,omitempty"` // pointer: distinguish absent vs 0
}

func handleCreate(w http.ResponseWriter, r *http.Request) {
    r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB cap

    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields()

    var req CreateUserReq
    if err := dec.Decode(&req); err != nil {
        http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
        return
    }

    resp := map[string]any{"id": "u_123", "name": req.Name}
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    if err := json.NewEncoder(w).Encode(resp); err != nil {
        log.Printf("encode response: %v", err)
    }
}
```

Alternative — deferred/polymorphic decoding with `json.RawMessage` (decode the discriminator first, the body later):

```go
type Envelope struct {
    Type string          `json:"type"`
    Data json.RawMessage `json:"data"` // kept as raw bytes
}

func dispatch(b []byte) (any, error) {
    var env Envelope
    if err := json.Unmarshal(b, &env); err != nil {
        return nil, err
    }
    switch env.Type {
    case "order":
        var o Order
        return o, json.Unmarshal(env.Data, &o)
    case "refund":
        var rf Refund
        return rf, json.Unmarshal(env.Data, &rf)
    default:
        return nil, fmt.Errorf("unknown type %q", env.Type)
    }
}
```

Streaming a large JSON array element-by-element without loading it all:

```go
func streamArray(r io.Reader) error {
    dec := json.NewDecoder(r)
    if _, err := dec.Token(); err != nil { // consume opening '['
        return err
    }
    for dec.More() {
        var item Order
        if err := dec.Decode(&item); err != nil {
            return err
        }
        process(item)
    }
    _, err := dec.Token() // consume closing ']'
    return err
}
```

---

## 11. Advanced Concepts

**Custom marshalers.** Implement `json.Marshaler` / `json.Unmarshaler` to control wire format. Classic use: an enum that serializes as a string.

```go
type Status int

const (
    StatusActive Status = iota
    StatusBanned
)

func (s Status) MarshalJSON() ([]byte, error) {
    return json.Marshal([...]string{"active", "banned"}[s])
}

func (s *Status) UnmarshalJSON(b []byte) error {
    var str string
    if err := json.Unmarshal(b, &str); err != nil {
        return err
    }
    switch str {
    case "active":
        *s = StatusActive
    case "banned":
        *s = StatusBanned
    default:
        return fmt.Errorf("invalid status %q", str)
    }
    return nil
}
```

> [!WARNING]
> Inside `MarshalJSON`, never call `json.Marshal(s)` on the same type — you'll infinitely recurse. Convert to a different type (a string, or a type alias without the method) first.

**`encoding.TextMarshaler`.** If you implement `MarshalText`/`UnmarshalText`, the JSON package uses it automatically (wrapping the text in quotes) and, crucially, it also works as a **map key**. JSON object keys must be strings, so a custom map-key type needs `TextMarshaler`, not `Marshaler`.

**Generics-friendly decoding (Go 1.18+):**

```go
func DecodeInto[T any](b []byte) (T, error) {
    var v T
    err := json.Unmarshal(b, &v)
    return v, err
}
```

**`encoding/json/v2` (experimental).** v2 makes `omitempty` semantics saner, treats `null` for slices/maps distinctly, is faster, and adds `omitzero` (which v1 also gained in Go 1.24). Watch it, but don't depend on it in production yet.

---

## 12. Debugging Tips

- **Silent empty struct after decode?** Check that fields are *exported* and tags match the JSON keys (case-sensitive on tag, case-insensitive fallback on field name).
- **"json: cannot unmarshal string into Go value of type int":** a type mismatch — inspect the actual payload; consider the `,string` tag or `json.Number`.
- **Find unexpected keys:** turn on `DisallowUnknownFields()` temporarily to surface schema mismatches.
- **Inspect raw bytes:** `log.Printf("%s", body)` before decoding; `%s` on `[]byte` prints the JSON text.
- **Pretty-print for eyeballs:** `json.MarshalIndent(v, "", "  ")`.
- **Position of parse errors:** a `*json.SyntaxError` has an `Offset` field pointing at the byte where parsing failed.
- **Round-trip test:** marshal then unmarshal in a unit test and `reflect.DeepEqual` to catch tag mistakes early.

```go
var se *json.SyntaxError
if errors.As(err, &se) {
    log.Printf("syntax error at byte offset %d", se.Offset)
}
```

---

## 13. Senior Engineer Notes

As a senior, your JSON judgment shows up in code review and design choices:

- **Reject `map[string]interface{}` in PRs** unless the payload is genuinely dynamic. Push for typed DTOs — they document the contract and catch errors at compile time.
- **Insist on the absent/null/zero analysis.** When a teammate adds an optional field, ask: "what happens when it's missing vs. explicitly null vs. zero?" Most bugs live here. Steer them to `*T` or `RawMessage`.
- **Separate wire models from domain models.** Don't put `json` tags on your core business entities; map between a transport struct and your domain type. This prevents the API contract from leaking into business logic and makes versioning painless.
- **Mentor on error handling discipline** — `Decode` errors are user input errors (400), not server errors (500). Get the HTTP status mapping right.
- **Golden-file tests** for serialization: marshal known fixtures and diff against checked-in expected output to catch accidental contract changes in review.
- Know when `omitempty` is a footgun (zero-valued structs, `false` booleans that are meaningful) and call it out.

---

## 14. Staff Engineer Notes

At staff level, JSON becomes an org-wide contract and architecture concern:

- **Schema governance across teams.** JSON's flexibility is a liability at scale. Drive adoption of a schema source of truth — OpenAPI, JSON Schema, or protobuf-with-JSON-mapping — so cross-team contracts are validated in CI, not discovered in incidents. Decide org-wide whether public APIs accept unknown fields (forward-compat) and document the policy.
- **Build vs. buy on performance.** When a service's profile shows JSON dominating CPU (log pipelines, API gateways at 100k+ QPS), evaluate `sonic`/`go-json`. The trade-off: codegen/JIT libraries add build complexity, occasional correctness divergence from stdlib, and a maintenance dependency. Quantify the win (e.g. "15% CPU, $X/month in instances") before mandating a non-stdlib encoder org-wide.
- **Wire-format evolution strategy.** Establish backward/forward compatibility rules: additive-only changes, never repurpose a field, deprecate before removal. For high-stakes contracts, consider protobuf for internal RPC (binary, schema-enforced) and reserve JSON for the public/human-facing edge.
- **Number precision as a systemic risk.** Mandate string-typed IDs (`"id": "12345..."`) in API standards to dodge the 2^53 JavaScript/float64 problem org-wide — frontends consume your JSON too.
- **Observability of payloads.** Standardize PII-safe JSON logging and payload size limits as platform defaults, not per-service decisions.
- **Track `encoding/json/v2`** at the platform level; plan a migration path and a compatibility test matrix before it stabilizes, since its `omitempty`/null semantics differ.

---

## 15. Revision Summary

- `json.Marshal`/`Unmarshal` = bytes ↔ Go value; `Encoder`/`Decoder` = streaming via `io.Writer`/`io.Reader`.
- Only **exported** fields serialize; control names/behavior with **struct tags** (`json:"name,omitempty,string"`, `-` to skip).
- `Unmarshal` needs a **pointer**; `Marshal` reads a value.
- Internally: reflection builds a per-type **encoder cached in a `sync.Map`**; buffers pooled via `sync.Pool`; decode uses a scanner state machine.
- Numbers into `interface{}` become **`float64`** (precision loss > 2^53) — use `UseNumber()` or typed `int64`.
- `omitempty` is encode-only and does **not** omit zero structs; use `*T` for absent/null distinction.
- Custom formats: implement `MarshalJSON`/`UnmarshalJSON` (avoid self-recursion) or `TextMarshaler` (needed for map keys).
- Use `json.RawMessage` for polymorphic/deferred decoding; `DisallowUnknownFields()` to fail on schema drift.
- Default to stdlib; reach for `sonic`/`go-json` only when profiling proves JSON is the bottleneck.
- Senior: typed DTOs, wire/domain separation, correct 400-vs-500 mapping. Staff: schema governance, string IDs, build-vs-buy, contract evolution.

**References:** [`encoding/json` package docs](https://pkg.go.dev/encoding/json); RFC 8259 (JSON spec); Go blog "JSON and Go"; `encoding/json/v2` design discussion.

---
*Go Engineering Handbook — topic 64.*
