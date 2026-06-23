# 65 · Validation

> **In one line:** Validation is the disciplined act of rejecting bad input at the boundary, and in Go that usually means struct tags plus `go-playground/validator` wired into your request-binding layer, returning structured, actionable errors.

---

## 1. Overview

Validation is the gate between the untrusted outside world and your business logic. Every byte arriving from an HTTP client, a Kafka message, a CLI flag, or a config file is a *claim* — "this is a valid email", "this quantity is positive" — and validation is where you verify the claim before code downstream assumes it.

In Go, validation lives at three layers:

1. **Syntactic / type validation** — does the JSON even unmarshal into the struct? (handled by `encoding/json`)
2. **Field-level constraint validation** — is `Age >= 18`, is `Email` an RFC 5322 address? (handled by `go-playground/validator` via struct tags)
3. **Semantic / business validation** — does this user actually exist, is this coupon still active? (handled by your service layer, usually requiring I/O)

The community workhorse is `github.com/go-playground/validator/v10`, used internally by Gin (`binding`), Echo, Fiber, and most production Go APIs. This chapter focuses on it, but the *principles* — fail fast, validate at the edge, return machine-readable errors — are framework-agnostic.

> [!NOTE]
> Validation is not authorization and not sanitization. Validation says "this shape is acceptable"; authorization says "you may do this"; sanitization transforms data (e.g. HTML-escaping). Conflating them produces security holes.

---

## 2. Why It Exists

The alternative to centralized validation is a thousand scattered `if x == "" { return errors.New("...") }` checks, each subtly different, each a place a `nil` deref or a panic can hide. Hand-rolled validation rots: a new field is added, the validation isn't, and a `0` quantity slips into the payment service.

`go-playground/validator` exists to make constraints **declarative, colocated with the type, and consistent**:

```go
type CreateUserRequest struct {
    Email    string `json:"email" validate:"required,email"`
    Age      int    `json:"age" validate:"gte=18,lte=130"`
    Password string `json:"password" validate:"required,min=8"`
}
```

The constraint travels *with* the struct. Anyone reading `CreateUserRequest` sees the contract. The validator becomes a single, well-tested, reflection-driven engine instead of N bespoke functions. This is the same philosophy as `encoding/json` struct tags: push metadata onto the type, let a generic engine interpret it.

The trade-off — reflection cost and "stringly-typed" rules — is the price for eliminating an entire class of human-error bugs.

---

## 3. Internal Working

`validator` is a **reflection-driven, tag-parsing engine** with aggressive caching. Understanding its internals explains both its cost and its quirks.

### Struct tags are just strings

Struct tags are stored in the `reflect.StructField.Tag`, which is a `reflect.StructTag` (a `string`). They are part of the type metadata baked into the binary at compile time — there is *no* runtime tag parsing of the raw source. At runtime, `validator` calls `field.Tag.Get("validate")` to extract `"required,email"`, then parses that string.

### The cache

The expensive part is reflecting over a struct's fields and parsing tags. `validator` does this **once per type** and caches a compiled plan in a `sync.Map` keyed by `reflect.Type`. The cached value (`cStruct`) holds a slice of `cField` entries, each with a pre-parsed list of `cTag` (the individual rules like `required`, `email`). On the second and subsequent validations of the same type, it walks the cached plan instead of re-reflecting.

```text
  Validate(req)  -->  reflect.TypeOf(req)
                          |
            sync.Map lookup (key = reflect.Type)
              |  hit                       |  miss
              v                            v
        cached cStruct           reflect over fields,
              |                  Tag.Get("validate"),
              v                  parse into cTags, store
   for each cField:                        |
     for each cTag:  <----------------------+
        fn := registered validator (e.g. "email")
        ok := fn(fieldValue)
        if !ok: append FieldError
              |
              v
   return ValidationErrors ([]FieldError)
```

### Memory layout & FieldError

A failed validation produces `validator.ValidationErrors`, which is a slice of `FieldError` (an interface). Each `FieldError` carries the namespace (`CreateUserRequest.Email`), the failed tag (`email`), the actual value, and the parameter (e.g. `8` for `min=8`). Crucially, the actual field *value* is captured via `reflect.Value`, so a `ValidationErrors` keeps a reference until GC'd — don't stuff huge structs into long-lived error logs.

### Dive and recursion

For slices/maps, the `dive` tag tells the engine to recurse into elements. Internally it re-enters the same `validateStruct`/`traverseField` loop with an incremented depth. Deeply nested `dive` chains multiply the reflection walk.

> [!WARNING]
> Reflection cannot read **unexported fields**. `validator` silently skips them. A `validate:"required"` on a lowercase field is a no-op — a classic silent failure.

---

## 4. Syntax

Tag grammar: `validate:"rule1,rule2=param,rule3"`. Rules are comma-separated; `=` supplies a parameter; `|` means OR within a rule group.

```go
type Order struct {
    ID       string   `validate:"required,uuid4"`
    Email    string   `validate:"required,email"`
    Qty      int      `validate:"required,gt=0,lte=1000"`
    Currency string   `validate:"required,oneof=USD EUR GBP"`
    Tags     []string `validate:"max=5,dive,min=1"`        // each element min len 1
    Discount *float64 `validate:"omitempty,gte=0,lte=1"`   // optional pointer
    Coupon   string   `validate:"required_if=Currency USD"` // cross-field
    Website  string   `validate:"omitempty,url"`
}
```

Key building blocks:

| Tag | Meaning |
|-----|---------|
| `required` | non-zero value (beware: `0`, `""`, `false` are "zero") |
| `omitempty` | skip remaining rules if value is zero |
| `dive` | descend into slice/map/array elements |
| `oneof=a b c` | enum membership |
| `gt/gte/lt/lte` | numeric or length comparison |
| `eqfield/nefield/gtfield` | cross-field comparison |
| `required_if/required_with/required_without` | conditional requirement |

> [!TIP]
> `required` and `omitempty` interact subtly. For optional fields that *may* be absent but must be valid *if present*, use a pointer + `omitempty`: `*int` with `validate:"omitempty,gt=0"`. A non-pointer `int` of `0` is indistinguishable from "not sent".

---

## 5. Common Interview Questions

**Q1. Why does `validator` use reflection, and what's the cost?**
It must inspect arbitrary struct types and read their tags at runtime — generics can't read tags. Cost is the reflection walk on first encounter (~µs), amortized by the per-type cache. *Follow-up: how would you avoid reflection entirely?* Code-generate validators (e.g. via `go:generate`) producing concrete `func Validate(o Order) error`, trading flexibility for zero-reflection speed.

**Q2. Why does `validate:"required"` on a lowercase field do nothing?**
Reflection cannot access unexported fields, so the engine skips them silently. *Follow-up: how do you catch this?* A unit test asserting a known-bad payload is rejected; or a linter/CI check scanning for `validate` tags on unexported fields.

**Q3. The number `0` fails your `required` field — why?**
`required` checks for the *zero value*. For `int`, `0` is the zero value, so an int field of `0` *fails* `required`. To allow `0` but require presence, use `*int` so `nil` means absent and `&0` means "explicitly zero". *Follow-up: how to distinguish absent vs explicit zero in JSON?* Pointers, or `json.RawMessage` / `sql.Null*`-style wrappers.

**Q4. How do you validate one field against another (e.g. `PasswordConfirm == Password`)?**
Cross-field tags: `validate:"eqfield=Password"`. For cross-struct, `eqcsfield`. *Follow-up: what if the rule needs DB access?* That's *semantic* validation — it belongs in the service layer, not in struct tags; tags are for stateless constraints.

**Q5. Should you return raw `validator.ValidationErrors` to the client?**
No. It leaks internal field names and Go types. Translate into a stable API error contract (field, code, message). *Follow-up: how do you localize messages?* Use the `ut` (universal-translator) integration with registered translations.

**Q6. Is `validator.Validate` safe for concurrent use?**
Yes — a single `*validator.Validate` instance is goroutine-safe and *should* be shared (its cache is a `sync.Map`). Creating one per request defeats caching. *Follow-up: where do you store it?* A package-level singleton initialized in `init()` or via `sync.Once`.

**Q7. What's the difference between validation and binding?**
Binding deserializes bytes → struct (JSON/form). Validation checks the populated struct. Gin's `ShouldBindJSON` does both: unmarshal then run `validator`. *Follow-up: does order matter?* Yes — malformed JSON fails binding before validation runs, so you handle two distinct error classes.

**Q8. How do you add a custom rule like `validate:"strongpassword"`?**
`v.RegisterValidation("strongpassword", fn)` where `fn` is `func(fl validator.FieldLevel) bool`. *Follow-up: custom error message?* Register a translation for that tag via universal-translator.

---

## 6. Production Use Cases

- **HTTP API request validation** — Gin (`github.com/gin-gonic/gin/binding`) and Echo embed `go-playground/validator` directly. `c.ShouldBindJSON(&req)` returns `validator.ValidationErrors` you map to HTTP 400. This is the single most common usage across Go microservices at companies like Uber, Cloudflare, and countless fintechs.
- **gRPC / protobuf** — `protoc-gen-validate` (PGV) and the newer `protovalidate` (CEL-based, used by Buf) generate validation from `.proto` options — the same idea, different surface. Constraints live in the schema.
- **Config validation at boot** — load YAML into a struct, `validate.Struct(cfg)`, and *crash on startup* if config is malformed. Fail-fast beats a 3am page when a typo'd timeout surfaces under load.
- **Event/message consumers** — Kafka/NATS handlers validate the decoded payload before processing; reject to a dead-letter queue rather than poison the pipeline.
- **Multi-tenant SaaS forms** — dynamic per-tenant rules layered on top of static struct tags (e.g. tenant-configurable max field lengths).

---

## 7. Common Mistakes

> [!WARNING]
> The mistakes below are the ones that reach production and cause incidents, not toy errors.

- **Validating unexported fields** — silently skipped; the field is never checked.
- **`required` on value types where `0`/`""`/`false` is legitimate** — use pointers.
- **Creating a new `validator.New()` per request** — throws away the type cache; turns a µs operation into a per-call reflection walk.
- **Leaking `ValidationErrors` to clients** — exposes Go internals and is unstable across refactors.
- **Forgetting `dive`** — `[]string` with `validate:"required"` checks the *slice* is non-nil, not the elements.
- **Mixing semantic checks into tags** — "email must be unique" needs a DB; it cannot and must not live in a struct tag.
- **Trusting client-supplied IDs without ownership checks** — validation confirms *shape*, never *permission*. A valid UUID is not an authorized UUID.

---

## 8. Performance Considerations

The first validation of a type pays the reflection + tag-parse cost; subsequent ones hit the `sync.Map` cache and cost roughly **a few hundred nanoseconds to low microseconds** for a small struct — negligible next to JSON unmarshalling and any I/O.

Hotspots and mitigations:

| Concern | Impact | Mitigation |
|---------|--------|-----------|
| Per-request `validator.New()` | Re-reflects every call | Share a singleton |
| Heavy `dive` over large slices | O(n) reflection per element | Cap slice size first (`max=N` *before* `dive`) |
| Regex-based rules (`email`, custom) | Regex match per field | Acceptable; precompile custom regexes once |
| Reflection vs codegen | Reflection ~10–50x slower than direct code | Codegen only if profiling proves it matters |

> [!TIP]
> Put cheap, short-circuiting rules first. With `required,email`, if `required` fails on empty input the expensive `email` regex never runs. Also use `max=N,dive` so an attacker can't send a million-element array and force a million regex evaluations (a real DoS vector).

For 99% of services, validator's reflection cost is invisible. Reach for codegen (`protovalidate`, hand-written validators) only when a profiler points at it.

---

## 9. Best Practices

1. **One shared `*validator.Validate` instance**, package-level, registered with custom rules at init.
2. **Validate at the edge** — handler/binding layer — so business code can assume clean input.
3. **Separate the three layers**: type (json), constraint (validator), semantic (service). Never push DB lookups into tags.
4. **Translate errors into a stable API contract** — `{field, code, message}` — decoupled from Go field names.
5. **Use `RegisterTagNameFunc`** to make error namespaces use JSON names, not Go field names.
6. **Pointers for genuinely optional fields**; `omitempty` to guard the rest of the chain.
7. **Test the rejections, not just the happy path** — assert each bad input yields the expected error code.
8. **Cap collection sizes before `dive`** to bound work.

---

## 10. Code Examples

Primary idiomatic example: a Gin handler with a shared validator, JSON field names in errors, and a clean error contract.

```go
package user

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
)

type CreateUserRequest struct {
	Email           string `json:"email"            validate:"required,email"`
	Password        string `json:"password"         validate:"required,min=8"`
	PasswordConfirm string `json:"password_confirm" validate:"required,eqfield=Password"`
	Age             *int   `json:"age"              validate:"omitempty,gte=18,lte=130"`
}

type APIFieldError struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func init() {
	// Gin reuses one validator; make error namespaces use JSON tag names.
	if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
		v.RegisterTagNameFunc(jsonTagName)
	}
}

func CreateUser(c *gin.Context) {
	var req CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		var ve validator.ValidationErrors
		if errors.As(err, &ve) {
			c.JSON(http.StatusBadRequest, gin.H{"errors": toAPIErrors(ve)})
			return
		}
		// malformed JSON / type mismatch — not a validation error
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	// req is now trusted for shape; proceed to service layer.
	c.JSON(http.StatusCreated, gin.H{"email": req.Email})
}

func toAPIErrors(ve validator.ValidationErrors) []APIFieldError {
	out := make([]APIFieldError, 0, len(ve))
	for _, fe := range ve {
		out = append(out, APIFieldError{
			Field:   fe.Field(), // JSON name thanks to RegisterTagNameFunc
			Code:    fe.Tag(),   // e.g. "required", "email", "eqfield"
			Message: humanize(fe),
		})
	}
	return out
}
```

The helper functions and a custom rule registration:

```go
package user

import (
	"reflect"
	"strings"

	"github.com/go-playground/validator/v10"
)

func jsonTagName(fld reflect.StructField) string {
	name := strings.SplitN(fld.Tag.Get("json"), ",", 2)[0]
	if name == "-" {
		return ""
	}
	return name
}

func humanize(fe validator.FieldError) string {
	switch fe.Tag() {
	case "required":
		return fe.Field() + " is required"
	case "email":
		return fe.Field() + " must be a valid email"
	case "min":
		return fe.Field() + " must be at least " + fe.Param() + " characters"
	case "eqfield":
		return fe.Field() + " must match " + fe.Param()
	default:
		return fe.Field() + " is invalid"
	}
}

// Custom rule: validate:"strongpassword"
func registerCustom(v *validator.Validate) error {
	return v.RegisterValidation("strongpassword", func(fl validator.FieldLevel) bool {
		s := fl.Field().String()
		var hasUpper, hasDigit bool
		for _, r := range s {
			switch {
			case r >= 'A' && r <= 'Z':
				hasUpper = true
			case r >= '0' && r <= '9':
				hasDigit = true
			}
		}
		return len(s) >= 8 && hasUpper && hasDigit
	})
}
```

Standalone usage without a web framework (config validation at boot):

```go
var validate = validator.New(validator.WithRequiredStructEnabled())

type Config struct {
	ListenAddr string        `validate:"required,hostname_port"`
	Timeout    time.Duration `validate:"required,gt=0"`
	LogLevel   string        `validate:"oneof=debug info warn error"`
}

func LoadConfig(c Config) error {
	if err := validate.Struct(c); err != nil {
		return fmt.Errorf("invalid config: %w", err) // crash on startup
	}
	return nil
}
```

---

## 11. Advanced Concepts

- **Struct-level validation** (`RegisterStructValidation`) — for rules spanning multiple fields that read cleaner as Go code than as a tangle of `required_if` tags (e.g. "exactly one of `CardToken` or `BankAccount` must be set").
- **`WithRequiredStructEnabled()`** — Go 1.18+ option changing how nested struct `required` semantics behave; the *recommended* mode for new code, and the default in future major versions.
- **Translations / i18n** — pair with `github.com/go-playground/universal-translator` and `locales`; register per-tag translations to emit user-facing messages in the right language.
- **Context-aware validation** — `v.StructCtx(ctx, s)` passes a `context.Context` into custom validators, enabling (carefully) deadline-aware checks. Resist using it for DB calls — that blurs the layer boundary.
- **`protovalidate` (CEL)** — for gRPC, constraints are written in Google's Common Expression Language inside `.proto` files and evaluated at runtime; richer than tags, schema-colocated, language-agnostic across your polyglot fleet.
- **Code generation alternatives** — `ozzo-validation` offers a fluent, reflection-light, *programmatic* API (no tags) that some teams prefer for type-safety and IDE support at the cost of colocated declarativeness.

> [!NOTE]
> Tag-based (`validator`) vs programmatic (`ozzo-validation`) vs schema-based (`protovalidate`) is a real architectural choice, not just taste. Tags win for HTTP+JSON ergonomics; schema wins for polyglot gRPC; programmatic wins for compile-time safety.

---

## 12. Debugging Tips

- **"My validation does nothing"** → check the field is **exported** (capitalized) and the tag key is exactly `validate` (typos like `validates` are silently ignored).
- **Type-assert the error**: `var ve validator.ValidationErrors; errors.As(err, &ve)`. If `errors.As` returns false, you got a *binding* error (bad JSON), not a validation error — different code path.
- **Inspect a `FieldError`**: `fe.Namespace()`, `fe.Field()`, `fe.Tag()`, `fe.Param()`, `fe.Value()` tell you exactly which rule fired and on what value.
- **`InvalidValidationError`** is returned if you pass a non-struct (e.g. a `nil` pointer or a plain `int`) to `Struct()`. Always pass a struct or pointer-to-struct.
- **Unexpected `required` failure on `0`/`false`** → that's the zero-value semantics; switch to a pointer.
- **`dive` not recursing** → confirm `dive` precedes the element rules in the tag, and the field is a slice/map/array.

```text
err := v.Struct(req)
        |
        +- nil                       -> valid
        +- InvalidValidationError    -> you passed a non-struct (programmer bug)
        +- ValidationErrors          -> []FieldError; iterate for field/tag/param
```

---

## 13. Senior Engineer Notes

A senior engineer owns the *validation layer's design* within a service and enforces it in review:

- **Draw the boundary explicitly.** In code review, reject PRs that perform DB lookups inside struct tags or, conversely, re-validate shape deep in the service. The handler validates shape; the service validates meaning. Make this a written convention.
- **Demand a stable error contract.** Block any handler that returns raw `validator.ValidationErrors` to clients — it leaks Go field names and breaks API consumers on refactor. Insist on the `{field, code, message}` mapping.
- **Watch for the pointer trap.** When reviewing a struct with `int`/`bool`/`string` and `required`, ask: "is the zero value a legal value?" If yes, it must be a pointer. This single review reflex prevents a recurring bug class.
- **Mentor on test discipline.** Junior engineers test the happy path; coach them to table-test each *rejection* with the expected error code. The bugs live in the rejections.
- **Singleton hygiene.** Ensure exactly one shared validator with custom rules registered once; flag per-request `New()` calls in review as a performance and correctness (missing custom rules) smell.

The senior's leverage is *consistency*: ten engineers validating ten different ways is the real cost, not the reflection.

---

## 14. Staff Engineer Notes

A staff engineer decides the validation *strategy across services* and makes build-vs-buy calls:

- **Standardize one approach org-wide.** If half your fleet uses Gin+validator and half uses hand-rolled `if` blocks, error responses are inconsistent and clients suffer. Pick a canonical stack (e.g. validator + a shared error-contract module) and publish it as an internal library. The win is a *uniform 400 contract* every client team can rely on.
- **Schema vs tags at the platform level.** For a polyglot org (Go + Java + Python services behind gRPC), `protovalidate`/CEL in `.proto` files means the *same* constraints generate validation in every language from one source of truth. That cross-team consistency can outweigh validator's per-service convenience. This is a real build-vs-buy/standardize decision with org-wide blast radius.
- **Validation as a contract artifact.** Treat the validated schema as part of the public API contract, versioned and tested for backward compatibility. Tightening a rule (`min=8` → `min=12`) is a *breaking change* for existing clients — gate it through your API-versioning process.
- **DoS and resource governance.** Mandate collection size caps before `dive` and request-body size limits at the gateway. Unbounded validation work is an availability risk that no single team owns — it's a platform guardrail.
- **Cost of reflection at scale.** For the handful of ultra-hot paths (millions of RPS), evaluate codegen. But quantify first: at most service scales, validation is sub-1% of CPU, and prematurely abandoning validator for hand-written code trades a tiny CPU win for a large maintainability loss.

The staff lens: validation is an *interface contract* between systems and teams, not just a function call.

---

## 15. Revision Summary

- Validation = reject bad input *at the boundary*; three layers: type (json) → constraint (validator) → semantic (service/DB).
- `go-playground/validator/v10` is the de-facto standard; embedded in Gin/Echo/Fiber.
- Declares rules via `validate:"..."` struct tags; reflection-driven with a per-`reflect.Type` `sync.Map` cache.
- **Reflection skips unexported fields silently** — fields must be exported.
- `required` rejects the *zero value* — use pointers when `0`/`""`/`false` is legal.
- `dive` to recurse into slices/maps; put cheap rules first; cap sizes before `dive` (DoS).
- Share **one** `*validator.Validate` instance — it's concurrency-safe and caches.
- Never leak `ValidationErrors` to clients; map to a stable `{field, code, message}` contract; use `RegisterTagNameFunc` for JSON names.
- Custom rules via `RegisterValidation`; multi-field via `RegisterStructValidation`; i18n via universal-translator.
- Alternatives: `ozzo-validation` (programmatic), `protovalidate`/CEL (schema-based for gRPC/polyglot).
- Senior: enforce layer boundary, error contract, pointer trap, singleton, rejection tests. Staff: org-wide standardization, schema-vs-tags, validation-as-versioned-contract, DoS guardrails.

**References:** [go-playground/validator](https://github.com/go-playground/validator) · [Gin binding](https://github.com/gin-gonic/gin) · [protovalidate](https://github.com/bufbuild/protovalidate) · [ozzo-validation](https://github.com/go-ozzo/ozzo-validation)

---

*Go Engineering Handbook — topic 65.*
