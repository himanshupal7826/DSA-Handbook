# 67 · Configuration Management

> **In one line:** Configuration management in Go is the disciplined layering of defaults, files, environment variables, and flags into a single typed, validated source of truth that follows 12-factor principles.

---

## 1. Overview

Configuration is everything your program needs to know that *isn't* code: database URLs, ports, feature flags, timeouts, secrets, log levels. Done badly, config becomes a swamp of `os.Getenv` calls scattered across packages, magic strings, and "works on my machine" bugs. Done well, it is a single typed struct, loaded once at startup, validated immediately, and injected explicitly into the components that need it.

Go gives you four native sources of config, each with a different precedence and use case:

| Source | Mechanism | Best for | Precedence |
|---|---|---|---|
| Defaults | constants in code | sane fallbacks | lowest |
| Config files | YAML/JSON/TOML via `os` + a decoder | structured, version-controlled, local | low |
| Environment variables | `os.Getenv`, `os.LookupEnv` | per-deployment, 12-factor, secrets | high |
| Command-line flags | `flag` package | operator overrides, one-off runs | highest |

This chapter covers the standard-library tools (`flag`, `os`), the de-facto community library **viper**, the **12-factor** discipline that shapes modern config, and the production hazards (secret leakage, precedence surprises, hot-reload races) that separate a junior implementation from a staff-grade one.

---

## 2. Why It Exists

The same binary should be deployable to dev, staging, and prod **without recompilation**. That single requirement is the entire reason configuration management exists. If `prod_db_password` is baked into a `const`, you have to rebuild to rotate it — and you have leaked a secret into your git history.

The **12-factor app** methodology (factor III, *Config*) makes the strict claim that config — anything that varies between deploys — should live in the **environment**, not in the code or even in checked-in files. The litmus test from 12factor.net: *could you open-source your codebase right now without leaking any credentials?* If not, your config is in the wrong place.

Why env vars specifically?

- **Language-agnostic.** Every OS and orchestrator (Kubernetes, ECS, systemd) speaks env vars natively.
- **No accidental commits.** They live outside the repo.
- **Granular per-deploy control.** Staging and prod differ by env, not by branch.

Flags and files still matter: flags for human operators running a binary by hand, files for structured local development and for the large config trees (think a service mesh's routing table) that don't fit comfortably in flat env strings. The art is **layering** them with a clear precedence so the right value wins.

---

## 3. Internal Working

There is no special compiler or runtime magic for "configuration" — it is ordinary Go data structures and syscalls. But understanding the layers reveals *where* values actually live in memory and *when* they are read.

**Environment variables.** When the OS `exec`s your process, the kernel copies the parent's environment block (a contiguous array of `KEY=VALUE` C strings, NUL-terminated, terminated by a NULL pointer) into the new process's address space, above the stack. The Go runtime, during bootstrap (`runtime.goenvs`), walks this block and copies it into a `[]string` (`runtime.envs`). `os.Getenv` then does a **linear scan** of a package-level `[]string` (lazily synced from the runtime copy) — O(n) in the number of env vars, which is fine because n is tiny. Crucially, the environment is a **snapshot at exec time**; mutating it later via `os.Setenv` only changes Go's in-process copy, not the kernel's, and is not safe to do concurrently with reads.

**Flags.** `flag.String("port", "8080", ...)` allocates a `*string`, registers a `*flag.Flag` in the default `flag.CommandLine` *FlagSet* (a struct holding a `map[string]*Flag` and the formal/actual lists). `flag.Parse()` walks `os.Args[1:]`, matches tokens against the map, and writes parsed values **through the pointers**. So a flag value is just heap memory pointed at by your variable.

**Viper.** Viper maintains an in-memory `map[string]interface{}` keyed by lower-cased, dot-delimited paths. On `Get("server.port")` it resolves against an **ordered set of overrides** — the precedence ladder is the key internal detail:

```text
        viper.Get("server.port")
                 │
                 ▼
   ┌─────────────────────────────┐  highest wins
   │ 1. explicit viper.Set()      │
   │ 2. command-line flag (pflag) │
   │ 3. environment variable      │
   │ 4. config file (yaml/json…)  │
   │ 5. key/value store (etcd…)   │
   │ 6. viper.SetDefault()        │  lowest
   └─────────────────────────────┘
        first non-nil layer returned
                 │
                 ▼
   cast to requested type (cast.ToInt, …)
```

Each layer is its own map; `Get` probes them top-down and returns the first hit, then runs a reflection-based cast. This is why viper is convenient but **not free**: every `Get` is a map lookup chain plus a type assertion. The idiomatic move is to `Unmarshal` once into a struct at startup so the hot path reads plain struct fields, not viper maps.

---

## 4. Syntax

Standard library — flags and env, no dependencies:

```go
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	port := flag.Int("port", 8080, "HTTP listen port")
	flag.Parse()

	// LookupEnv distinguishes "set to empty" from "unset".
	dbURL, ok := os.LookupEnv("DATABASE_URL")
	if !ok {
		dbURL = "postgres://localhost:5432/app"
	}

	fmt.Printf("port=%d db=%s\n", *port, dbURL)
}
```

Viper — layered load with env + file + defaults:

```go
v := viper.New()
v.SetDefault("server.port", 8080)

v.SetConfigName("config")     // config.yaml
v.AddConfigPath("/etc/app/")
v.AddConfigPath(".")
_ = v.ReadInConfig()          // ok if file is absent

v.SetEnvPrefix("APP")                                  // APP_SERVER_PORT
v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))     // server.port -> SERVER_PORT
v.AutomaticEnv()

port := v.GetInt("server.port")
```

---

## 5. Common Interview Questions

**Q1. What is the 12-factor stance on configuration, and why env vars?**
Config is anything that varies between deploys; it belongs in the environment, not the code. Env vars are language-agnostic, never accidentally committed, and trivially overridable per deploy. *Follow-up: what about a 500-line routing config that's awkward as env vars?* Use a checked-in or mounted file for structural config and keep only secrets/per-deploy values in env — pragmatism over dogma; the spirit is "no secrets in code."

**Q2. Give a sane precedence order and justify it.**
`flags > env > file > defaults`. Operator-supplied flags are the most explicit and intentional (a human typed them now), env is per-deploy, files are shared baseline, defaults are last resort. *Follow-up: where do secrets fit?* They ride the env layer (or a secrets manager injected as env), never the file layer in the repo.

**Q3. `os.Getenv` vs `os.LookupEnv` — when does it matter?**
`Getenv` returns `""` for both "unset" and "set to empty string". `LookupEnv` returns `(value, bool)` so you can tell them apart — essential for booleans/flags where empty has meaning. *Follow-up: how do you parse a bool env safely?* `strconv.ParseBool` after `LookupEnv`, returning an error on garbage rather than silently defaulting.

**Q4. Why unmarshal viper into a struct instead of calling `viper.GetString` everywhere?**
Centralizes the config schema, gives you compile-time field names and types, makes the dependency explicit and testable, and avoids per-call map-lookup + reflection cost on hot paths. *Follow-up: how do you validate?* Run a `Validate()` method (or `go-playground/validator` tags) immediately after unmarshal, fail fast at startup.

**Q5. How do you handle secrets without leaking them?**
Never log the full config; never put secrets in files committed to git; inject via env or a secrets manager (Vault, AWS Secrets Manager, K8s Secrets). Wrap secret fields in a type whose `String()`/`MarshalJSON` returns `***`. *Follow-up: how do you rotate without downtime?* Hot-reload (viper `WatchConfig`) or a sidecar that re-injects and signals the process; design code to read config behind an atomic pointer.

**Q6. What's the danger of `viper.WatchConfig` / hot reload?**
Concurrent readers see a struct mutating mid-flight — a data race. *Follow-up: fix?* Build a fresh immutable config and swap it atomically via `atomic.Pointer[Config]`; readers load the pointer, never mutate fields.

**Q7. Why is global mutable config (a package-level `var Config`) an anti-pattern?**
Hidden dependencies, untestable (tests fight over global state), and racy. *Follow-up: alternative?* Construct config once in `main`, pass it explicitly (dependency injection) into constructors.

**Q8. How do you make config testable?**
Define config as a struct; have loaders return `(Config, error)`; pass it as a function/struct parameter so tests build literals directly without touching env or files.

---

## 6. Production Use Cases

- **Kubernetes**: config flows in as env vars (from `ConfigMap`/`Secret` `valueFrom`) and as mounted files (`ConfigMap` volume → viper reads `/etc/app/config.yaml`). The 12-factor env approach is *native* here.
- **HashiCorp Vault / AWS Secrets Manager**: secrets fetched at boot or injected as env by a sidecar (Vault Agent, AWS AppConfig). Code never sees a plaintext secret in a file.
- **spf13/viper + cobra**: the canonical CLI stack used by **kubectl**, **Hugo**, **GitHub CLI**-style patterns, and countless internal tools — cobra wires flags to viper so `--flag`, `ENV_VAR`, and `config.yaml` all resolve to one value.
- **Netflix / Uber-style dynamic config**: feature flags and tunables served from a central store (etcd/Consul, LaunchDarkly) and hot-reloaded so SREs flip behavior without redeploys.
- **systemd services**: `EnvironmentFile=` injects env vars into long-running daemons; the binary stays identical across environments.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common production incident: **logging the full config struct at startup**, which dumps the DB password into your log aggregator (Datadog, Splunk) where it is now retained, indexed, and exfiltratable.

- Calling `os.Getenv` deep inside business logic — turns a pure function into one with a hidden global dependency.
- Silently defaulting on a malformed value (`strconv.Atoi` error ignored), so `PORT=eighty` becomes `0`.
- Confusing "unset" with "empty" by using `Getenv` instead of `LookupEnv` for booleans.
- Committing `config.prod.yaml` with real secrets to the repo.
- Mutating a shared config struct during a hot reload while goroutines read it — a textbook data race.
- Relying on viper's default lowercasing/replacer behavior without testing it — `MyVar` vs `MYVAR` vs `my_var` surprises.
- Validating config *lazily* (first request) instead of at startup, so a bad deploy looks healthy until traffic arrives.

---

## 8. Performance Considerations

Config is read essentially once, so loading cost is irrelevant — *but how you read it on the hot path matters*.

- **`viper.GetString` per request is wasteful.** Each call is a precedence-ladder traversal of several maps plus a reflection cast (`cast.ToString`). On a hot HTTP handler this is measurable allocator and CPU pressure. **Unmarshal once into a struct; reads then cost a single field access (nanoseconds, zero allocation).**
- **Env scans are O(n)** but n is small (tens), and you should read each var once at startup anyway.
- **Flags** are parsed once; `*flag.value` reads are a pointer dereference — free.
- **Hot reload with `atomic.Pointer[Config]`**: `Load()` is a single atomic read, near-free, and lock-free for readers. Far cheaper than an `RWMutex` under high read concurrency.

Rule of thumb: the cost of config should be paid **once at boot**, never per request.

---

## 9. Best Practices

> [!TIP]
> One struct, loaded once, validated immediately, passed explicitly. Everything else is detail.

1. **Define a typed `Config` struct** as the single source of truth; no scattered `Getenv`.
2. **Layer with clear precedence**: defaults → file → env → flags.
3. **Validate at startup and fail fast** — a process that won't start beats one that silently misbehaves.
4. **Keep secrets out of files**; inject via env / secrets manager; redact them in `String()`/logs.
5. **Pass config explicitly** (DI); avoid package-level mutable globals.
6. **Prefix your env vars** (`APP_`) to avoid collisions.
7. **For hot reload, swap an immutable copy atomically** — never mutate live config.
8. **Document every key** (name, type, default, required?) — ideally generated from struct tags.
9. **Provide a `.env.example`** and a sample `config.yaml` with dummy values so onboarding is one command.

---

## 10. Code Examples

A production-grade, dependency-free loader: defaults in the struct, overridden by env, validated, with a redacting secret type.

```go
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Secret redacts itself in logs and JSON.
type Secret string

func (Secret) String() string                { return "***" }
func (Secret) MarshalText() ([]byte, error)  { return []byte("***"), nil }

type Config struct {
	Port     int
	DBURL    Secret
	LogLevel string
	Timeout  time.Duration
}

func Load() (Config, error) {
	c := Config{ // defaults
		Port:     8080,
		LogLevel: "info",
		Timeout:  5 * time.Second,
	}

	if v, ok := os.LookupEnv("APP_PORT"); ok {
		p, err := strconv.Atoi(v)
		if err != nil {
			return Config{}, fmt.Errorf("APP_PORT %q: %w", v, err)
		}
		c.Port = p
	}
	if v, ok := os.LookupEnv("APP_DB_URL"); ok {
		c.DBURL = Secret(v)
	}
	if v, ok := os.LookupEnv("APP_LOG_LEVEL"); ok {
		c.LogLevel = v
	}
	if v, ok := os.LookupEnv("APP_TIMEOUT"); ok {
		d, err := time.ParseDuration(v)
		if err != nil {
			return Config{}, fmt.Errorf("APP_TIMEOUT %q: %w", v, err)
		}
		c.Timeout = d
	}

	return c, c.validate()
}

func (c Config) validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("port out of range: %d", c.Port)
	}
	if c.DBURL == "" {
		return fmt.Errorf("APP_DB_URL is required")
	}
	return nil
}
```

The viper equivalent, when you want files + env + flags unified and unmarshalled into the same struct shape:

```go
package config

import (
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Port     int    `mapstructure:"port"`
	DBURL    string `mapstructure:"db_url"`
	LogLevel string `mapstructure:"log_level"`
}

func Load() (Config, error) {
	v := viper.New()
	v.SetDefault("port", 8080)
	v.SetDefault("log_level", "info")

	v.SetConfigName("config")
	v.AddConfigPath("/etc/app/")
	v.AddConfigPath(".")
	if err := v.ReadInConfig(); err != nil {
		if _, notFound := err.(viper.ConfigFileNotFoundError); !notFound {
			return Config{}, err // a real parse error, not just "absent"
		}
	}

	v.SetEnvPrefix("APP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	var c Config
	if err := v.Unmarshal(&c); err != nil {
		return Config{}, err
	}
	return c, nil // add c.validate() here
}
```

---

## 11. Advanced Concepts

**Atomic hot reload.** Wrap config in an `atomic.Pointer[Config]`. A background goroutine (or viper's `WatchConfig` callback) builds a brand-new `*Config`, validates it, and `Store`s it. Readers `Load()` the pointer — lock-free, race-free, and any in-flight request keeps the snapshot it started with.

```go
var cfg atomic.Pointer[Config]

func Current() *Config { return cfg.Load() }

func reload() {
	next, err := Load()
	if err != nil {
		log.Printf("reload rejected: %v", err) // keep old config
		return
	}
	cfg.Store(&next)
}
```

**Struct-tag-driven loaders.** Libraries like `kelseyhightower/envconfig` and `caarlos0/env` use struct tags (`env:"PORT" envDefault:"8080" required:"true"`) plus reflection to populate config from env with zero boilerplate — a lighter alternative to viper when you only need env.

**Layered config files.** A common pattern is `config.yaml` (base) merged with `config.<env>.yaml` (overlay); viper's `MergeInConfig` supports this. Keep secrets out of *all* of them.

**Remote config.** Viper can read from etcd/Consul (`AddRemoteProvider`), enabling centralized, watchable config across a fleet — the foundation of dynamic feature flagging.

---

## 12. Debugging Tips

- **"Why is this value not taking effect?"** Print the resolved value *and its source*. With viper, the precedence ladder is the usual culprit — a leftover `viper.Set()` or a flag silently outranks your env var.
- **Dump the (redacted) config at startup** behind a debug flag: `log.Printf("config: %+v", cfg)` — with secrets as `Secret` types this is safe and tells you exactly what the process believes.
- **Env key mismatches**: log `os.Environ()` (redacted) to confirm the var is actually present in the container; a missing `APP_` prefix or `.`→`_` replacer mismatch is the classic cause.
- **`viper.AllSettings()`** returns the fully merged map — invaluable for seeing the final picture.
- **Race detector**: run hot-reload code under `go test -race` / `go run -race`; mutating live config will light up immediately.
- **Reproduce locally**: a `.env` file + `direnv` or `godotenv` reproduces the prod env layer on your laptop.

---

## 13. Senior Engineer Notes

A senior engineer's job here is to make config **boring, typed, and centralized**. In code review, reject any new `os.Getenv` buried in a handler or service method — config reads belong in the loader, full stop. Push for a single `Config` struct passed by dependency injection, not a package global, because globals make the whole package untestable.

Insist on **fail-fast validation**: a deploy with a bad value should crash on boot, loudly, not degrade silently under load three hours later. Mentor juniors on the `Getenv` vs `LookupEnv` distinction and on why ignoring a `strconv` error is a latent outage.

Be the person who notices the `log.Printf("%+v", config)` line in a PR and explains, with the redacting `Secret` type as the fix, why it would have leaked credentials to Datadog. Judgement call: don't over-engineer — a 10-line env loader beats dragging in viper for a service with five config keys. Reach for viper when you genuinely need files + env + flags + remote config unified.

---

## 14. Staff Engineer Notes

At staff level the questions are organizational. **Build vs. buy**: do you standardize the whole org on viper+cobra, adopt a lighter `envconfig` convention, or build a thin internal config library that bakes in your secret-redaction and validation conventions so every team gets them for free? The answer hinges on consistency and security posture across dozens of services, not the elegance of one.

Drive a **config contract** across teams: a documented schema, naming conventions (`SERVICE_DOMAIN_KEY`), and a policy that secrets *only* flow through the secrets manager — enforced in CI by a scanner that fails the build on a committed credential. This is a cross-team trade-off: stricter policy slows a few teams down but prevents the breach that costs the org far more.

Decide the **dynamic-config strategy** org-wide: static config + redeploy is simplest and auditable; centralized hot-reload (Consul/LaunchDarkly) enables SRE agility but adds a runtime dependency and a new failure mode (config store down → what's the fallback?). Define the **blast radius**: a bad dynamic config change can take down every service simultaneously, so demand staged rollout and validation gates. Finally, own the **migration path** — moving the fleet from ad-hoc env reads to a unified library is a multi-quarter effort that needs a deprecation plan, not a flag day.

---

## 15. Revision Summary

- **Four sources**: defaults → files → env → flags, increasing precedence; flags win, defaults lose.
- **12-factor (factor III)**: config that varies per deploy lives in the **environment**; no secrets in code or committed files.
- **One typed `Config` struct**, loaded once, **validated at startup (fail fast)**, passed via DI — never a mutable global, never `Getenv` in business logic.
- **`LookupEnv` over `Getenv`** to distinguish unset from empty; never ignore parse errors.
- **Viper precedence**: `Set` > flag > env > file > kv-store > default; `Unmarshal` once, don't `Get` per request (map-lookup + reflection cost).
- **Secrets**: inject via env/secrets manager; wrap in a redacting type; never log the full config.
- **Hot reload**: build an immutable copy and swap with `atomic.Pointer[Config]` — lock-free, race-free.
- **Staff lens**: org-wide config contract, build-vs-buy on the config lib, CI secret scanning, dynamic-config blast radius and rollback.

**References:** [12factor.net](https://12factor.net/config) · `flag`, `os` (Go stdlib) · `github.com/spf13/viper` · `github.com/kelseyhightower/envconfig` · `github.com/caarlos0/env`

---
*Go Engineering Handbook — topic 67.*
