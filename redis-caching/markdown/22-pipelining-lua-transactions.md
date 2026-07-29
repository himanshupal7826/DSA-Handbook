# 22 · Build: Pipelining, Transactions & Lua Scripting

> **In one line:** These three tools solve three different problems that people constantly confuse — pipelining cuts round trips but gives you no atomicity, MULTI/EXEC gives you atomic *queued* execution with optimistic locking but no rollback, and Lua gives you true atomic read-modify-write on the server — so the entire skill is knowing which one your problem actually needs.

---

## 1. Overview

A Redis command is fast — microseconds on the server. So when a Redis operation feels slow, the server is almost never the problem; the *network round trip* is. A single request-response over a datacentre network is a few hundred microseconds to a millisecond, and if your code issues a thousand commands one after another, waiting for each reply before sending the next, you have paid that round trip a thousand times. The server did a millisecond of work and you waited a second. This chapter is about the three mechanisms Redis gives you to stop wasting round trips and to make multi-step logic correct under concurrency — and about the fact that they are frequently reached for in the wrong order.

**Pipelining** is the throughput tool: batch many commands into one network write, read all the replies in one network read, and collapse a thousand round trips into one. It is a pure latency optimisation and it changes nothing about semantics — the commands are *not* atomic, other clients' commands can interleave with yours, and there is no transaction. People reach for pipelining thinking it gives them atomicity; it does not.

**Transactions** — `MULTI`/`EXEC` — are the atomic-batch tool with an optimistic-concurrency twist. `MULTI` starts queueing commands; `EXEC` runs the whole queue as one atomic unit with nothing interleaved. `WATCH` adds compare-and-set: watch some keys, and if any of them changed before your `EXEC`, the transaction aborts so you can retry. This is the right tool for optimistic concurrency across keys. But it has two sharp edges people miss: there is **no rollback** — if a command fails at runtime mid-transaction, the earlier ones still took effect — and you cannot make one command's arguments depend on another command's result, because everything is queued *before* anything runs.

**Lua scripting** — `EVAL`/`EVALSHA` — is the true atomic read-modify-write tool. A script runs entirely on the server, on the single thread, with nothing else interleaved, and *within* the script you can read a value, branch on it, and write — the thing MULTI/EXEC cannot do. It is how you build a correct get-or-set, a precise rate limiter, or a compare-and-delete lock release, all as one atomic server-side step. The price is the single thread again: a slow script blocks every other client for its entire duration, so scripts must be short and bounded.

This is a *build* chapter. By the end you will have working Go for a pipeline, a `WATCH`-based compare-and-set, and an atomic Lua rate-limiter, and — more importantly — a clear decision rule for which of the three any given problem calls for.

## 2. Core Concepts

- **Round trip (RTT)** — one network request and its reply; the dominant cost of a remote Redis command, and the thing pipelining eliminates.
- **Pipelining** — sending many commands in one network write and reading all replies together; a throughput win with *no* atomicity and *no* transaction semantics.
- **Transaction (MULTI/EXEC)** — commands queued after `MULTI` and executed as one atomic block by `EXEC`; nothing else interleaves between the queued commands.
- **DISCARD** — abandon a queued transaction without executing it.
- **WATCH** — mark keys for optimistic locking; if any watched key is modified before `EXEC`, `EXEC` aborts and returns nil, so you retry.
- **No rollback** — Redis transactions do not undo. If a queued command errors at execution time, the other commands still run; there is no rollback like a SQL database.
- **Lua scripting (EVAL)** — a script executed atomically on the server, able to read-then-write with branching logic in a single uninterrupted step.
- **EVALSHA / SCRIPT LOAD** — cache a script by its SHA1 on the server, then invoke it by hash to avoid re-sending the body each call.
- **KEYS[] and ARGV[]** — the way keys and arguments enter a script; keys *must* go through `KEYS[]` so Redis (and Cluster) knows which slots the script touches.
- **Atomicity vs blocking** — the same single thread that makes a script atomic makes a slow script a global stall; the two are one property.

## 3. Theory & Principles

### Pipelining: latency, not atomicity

Picture the timeline of ten sequential commands against a Redis one millisecond of network away. You send command 1, wait ~1 ms for its reply, send command 2, wait ~1 ms, and so on: ten commands, ten round trips, ~10 ms wall-clock, of which the server spent perhaps 20 microseconds actually working. The network was idle almost the entire time, and so was the server, each waiting for the other. Pipelining fixes exactly this: write all ten commands to the socket back-to-back without waiting, then read all ten replies. One round trip of latency covers all ten commands. The improvement is not marginal — batching hundreds of commands can be a 10–100× throughput gain — and it comes purely from removing dead waiting time.

The crucial thing to internalise is what pipelining does *not* do. It is not a transaction. Between your pipelined commands, **other clients' commands can and do run** — Redis still executes each command in the order it arrives on the single thread, but a different client's `SET` can land in the middle of your batch. A pipeline is just a network optimisation: the same commands, in the same order, with the same semantics, sent more efficiently. If you pipeline `GET x` then `SET x <value+1>`, another client can change `x` between the two. Pipelining buys throughput and nothing else. Conflating it with atomicity is the single most common mistake in this area.

### Transactions: atomic queue, optimistic lock, no rollback

`MULTI`/`EXEC` genuinely does give atomicity, but of a specific shape. After `MULTI`, each command you send is *queued*, not executed — the server replies `QUEUED`. When you send `EXEC`, Redis runs the whole queue as one atomic unit: because execution is single-threaded, no other client's command interleaves between your queued commands. That is real isolation. `DISCARD` throws the queue away unexecuted.

Two properties trip people up. First, **there is no rollback**. If a command is syntactically wrong, the whole transaction is rejected before execution (Redis detects it at queue time). But if a command is *accepted* at queue time and only fails at *execution* time — say you run `INCR` on a key holding a string, a runtime type error — then `EXEC` runs the rest of the queue anyway and simply reports that one command's error. The successful commands are *not* undone. Redis's designers made this choice deliberately: such errors are programming bugs, rollback machinery is complex and slows the common path, and the single-threaded model already gives isolation. So a Redis transaction is atomic in the "all queued together, nothing interleaves" sense, but not in the "all-or-nothing with rollback" sense a SQL person expects.

Second, and this is the deeper limitation: **you cannot branch on a value inside a transaction**, because all commands are queued before any of them run. You cannot do "read `x`, and if it is 5 then set `y`". To get read-then-decide-then-write, you need either `WATCH` (optimistic retry) or Lua (server-side logic).

`WATCH` is how MULTI/EXEC supports optimistic concurrency. You `WATCH key`, then read it, decide what to do, `MULTI`, queue your writes, and `EXEC`. If any watched key was modified by anyone between the `WATCH` and the `EXEC`, `EXEC` does nothing and returns nil — your assumption was invalidated, so you loop and retry. This is compare-and-set: no locks held, no blocking, just detect-conflict-and-retry. It is ideal when conflicts are rare; under heavy contention on one key it degrades because everyone keeps retrying.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="p2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Sequential vs pipelined: the round trip is the cost</text>

  <rect x="24" y="40" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Sequential: 4 commands, 4 round trips</text>
  <line x1="60" y1="80" x2="60" y2="222" stroke="#94a3b8"/>
  <line x1="398" y1="80" x2="398" y2="222" stroke="#94a3b8"/>
  <text x="60" y="94" text-anchor="middle" fill="#64748b" font-size="9">client</text>
  <text x="398" y="94" text-anchor="middle" fill="#64748b" font-size="9">redis</text>
  <path d="M62,104 L396,116" stroke="#dc2626" stroke-width="1.5" marker-end="url(#p1)"/>
  <path d="M396,124 L62,136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p1)"/>
  <path d="M62,144 L396,156" stroke="#dc2626" stroke-width="1.5" marker-end="url(#p1)"/>
  <path d="M396,164 L62,176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p1)"/>
  <path d="M62,184 L396,196" stroke="#dc2626" stroke-width="1.5" marker-end="url(#p1)"/>
  <path d="M396,204 L62,216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p1)"/>
  <text x="229" y="236" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">wall-clock &#8776; 4 &#215; RTT (network idle between)</text>

  <rect x="446" y="40" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Pipelined: 4 commands, 1 round trip</text>
  <line x1="482" y1="80" x2="482" y2="222" stroke="#94a3b8"/>
  <line x1="820" y1="80" x2="820" y2="222" stroke="#94a3b8"/>
  <text x="482" y="94" text-anchor="middle" fill="#64748b" font-size="9">client</text>
  <text x="820" y="94" text-anchor="middle" fill="#64748b" font-size="9">redis</text>
  <path d="M484,104 L818,110" stroke="#16a34a" stroke-width="1.5" marker-end="url(#p2)"/>
  <path d="M484,116 L818,122" stroke="#16a34a" stroke-width="1.5" marker-end="url(#p2)"/>
  <path d="M484,128 L818,134" stroke="#16a34a" stroke-width="1.5" marker-end="url(#p2)"/>
  <path d="M484,140 L818,146" stroke="#16a34a" stroke-width="1.5" marker-end="url(#p2)"/>
  <text x="651" y="164" text-anchor="middle" fill="#166534" font-size="9">server processes all four&#8230;</text>
  <path d="M818,180 L484,186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p2)"/>
  <path d="M818,192 L484,198" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p2)"/>
  <path d="M818,204 L484,210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p2)"/>
  <path d="M818,216 L484,222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#p2)"/>
  <text x="651" y="236" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">wall-clock &#8776; 1 &#215; RTT &#8212; but NOT atomic</text>

  <rect x="24" y="256" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Three tools, three jobs &#8212; pick by what the problem needs</text>
  <rect x="44" y="292" width="256" height="146" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="172" y="312" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Pipeline</text>
  <text x="58" y="334" fill="#7f1d1d" font-size="9">GOAL: fewer round trips</text>
  <text x="58" y="352" fill="#7f1d1d" font-size="9">atomic? NO</text>
  <text x="58" y="370" fill="#7f1d1d" font-size="9">others interleave? YES</text>
  <text x="58" y="388" fill="#7f1d1d" font-size="9">read-then-write logic? NO</text>
  <text x="58" y="412" fill="#b91c1c" font-size="9" font-weight="bold">use for: bulk throughput</text>
  <text x="58" y="428" fill="#b91c1c" font-size="9" font-weight="bold">(mget-style, warming, dumps)</text>
  <rect x="312" y="292" width="256" height="146" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="312" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">MULTI / EXEC (+WATCH)</text>
  <text x="326" y="334" fill="#1e3a8a" font-size="9">GOAL: atomic queued batch</text>
  <text x="326" y="352" fill="#1e3a8a" font-size="9">atomic? YES (no interleave)</text>
  <text x="326" y="370" fill="#1e3a8a" font-size="9">rollback? NO</text>
  <text x="326" y="388" fill="#1e3a8a" font-size="9">branch on a value? NO (WATCH+retry)</text>
  <text x="326" y="412" fill="#1e40af" font-size="9" font-weight="bold">use for: optimistic</text>
  <text x="326" y="428" fill="#1e40af" font-size="9" font-weight="bold">concurrency (compare-and-set)</text>
  <rect x="580" y="292" width="256" height="146" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="708" y="312" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Lua (EVAL)</text>
  <text x="594" y="334" fill="#14532d" font-size="9">GOAL: atomic read-modify-write</text>
  <text x="594" y="352" fill="#14532d" font-size="9">atomic? YES</text>
  <text x="594" y="370" fill="#14532d" font-size="9">branch on a value? YES</text>
  <text x="594" y="388" fill="#14532d" font-size="9">hazard: slow script blocks all</text>
  <text x="594" y="412" fill="#15803d" font-size="9" font-weight="bold">use for: rate limit, get-or-set,</text>
  <text x="594" y="428" fill="#15803d" font-size="9" font-weight="bold">CAS lock release</text>
</svg>
```

### Lua: true atomic read-modify-write, and the blocking price

Lua is the tool for the logic that MULTI/EXEC cannot express: read a value, decide based on it, and write — all as one indivisible step. `EVAL` ships a script to the server, which runs it to completion on the single thread before doing anything else. Nothing interleaves, so *inside* the script you can `GET` a counter, compare it to a limit, and `INCR` or reject accordingly, with a guarantee no other client slipped in between the read and the write. That is precisely a correct rate limiter, a get-or-set, or a compare-and-delete — patterns that are races when built from separate client-side commands.

Two disciplines make Lua safe. First, **pass every key through `KEYS[]`**, never hard-code key names or build them from `ARGV` inside the script. Redis uses the declared keys to know which hash slots the script touches; in Redis Cluster, a script that accesses a key not declared in `KEYS[]` is a bug that either errors or, worse, silently misroutes. Declaring keys also keeps scripts portable and analysable. Data and parameters that are not keys go through `ARGV[]`. Second, **keep the script short and bounded**. The atomicity you love and the blocking you fear are the same property: while your script runs, every other client waits. A script with an unbounded loop, or one that iterates a huge collection, stalls the whole instance exactly as `KEYS *` would. Scripts should be O(1) or O(small); if you need to touch many keys, do it in bounded batches, not one monster script.

Operationally you rarely send the full script body every call. `SCRIPT LOAD` caches it on the server under its SHA1 and returns the hash; thereafter you call `EVALSHA <sha> ...`, sending only the 40-character hash. If the server was restarted or the script evicted, `EVALSHA` returns `NOSCRIPT` and you fall back to `EVAL` once to reload it — every good client library does this transparently, and go-redis's `redis.NewScript(...).Run(...)` implements exactly this EVALSHA-then-EVAL fallback for you.

## 4. Architecture & Workflow

How each mechanism moves through the server:

1. **Pipeline.** The client serialises N commands into its socket buffer in one write. Redis reads them, executes each in arrival order on the single thread — interleaved freely with other clients' commands — and buffers the N replies, which the client reads in one pass. No locking, no isolation between your commands: pure batching.
2. **MULTI … EXEC.** `MULTI` puts the connection into transaction mode; each subsequent command returns `QUEUED` (validated for syntax, not executed). `EXEC` executes the whole queue as one atomic unit with no interleaving, returning an array of all the replies. A syntactically bad command makes the whole `EXEC` fail up front; a runtime error on one command does *not* stop or undo the others.
3. **WATCH … MULTI … EXEC.** `WATCH k1 k2` marks those keys. You then read them and decide. Between `WATCH` and `EXEC`, if any watched key is touched by anyone, the server flags the transaction dirty, and `EXEC` returns nil without running anything — the signal to retry the whole read-decide-write loop. `UNWATCH` or a completed `EXEC` clears the watch.
4. **EVAL / EVALSHA.** The script is parsed and run to completion on the single thread. It reads and writes via the Redis API, sees a consistent snapshot (nothing else runs), and returns one reply. `EVALSHA` invokes a previously loaded script by hash; on `NOSCRIPT`, reload with `EVAL`.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="w2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">WATCH-based compare-and-set: optimistic retry loop</text>

  <rect x="30" y="44" width="820" height="120" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Happy path: no conflict &#8594; EXEC commits</text>
  <rect x="48" y="82" width="120" height="34" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="108" y="104" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">WATCH k</text>
  <path d="M170,99 L196,99" stroke="#2563eb" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="198" y="82" width="120" height="34" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="258" y="99" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">GET k = 10</text><text x="258" y="111" text-anchor="middle" fill="#1e3a8a" font-size="8">decide new = 11</text>
  <path d="M320,99 L346,99" stroke="#2563eb" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="348" y="82" width="120" height="34" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="408" y="104" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">MULTI; SET k 11</text>
  <path d="M470,99 L496,99" stroke="#2563eb" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="498" y="82" width="150" height="34" rx="5" fill="#bfdbfe" stroke="#2563eb" stroke-width="2"/><text x="573" y="99" text-anchor="middle" fill="#1e3a8a" font-size="9" font-weight="bold">EXEC (k untouched)</text><text x="573" y="111" text-anchor="middle" fill="#1e3a8a" font-size="8">returns [OK] &#8594; committed</text>
  <path d="M650,99 L676,99" stroke="#16a34a" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="678" y="82" width="150" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="753" y="104" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">DONE</text>

  <rect x="30" y="180" width="820" height="160" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="202" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Conflict path: another client writes k &#8594; EXEC aborts &#8594; retry</text>
  <rect x="48" y="218" width="120" height="34" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="108" y="240" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">WATCH k</text>
  <path d="M170,235 L196,235" stroke="#dc2626" stroke-width="1.5" marker-end="url(#w2)"/>
  <rect x="198" y="218" width="120" height="34" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="258" y="240" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">GET k = 10</text>
  <path d="M320,235 L346,235" stroke="#dc2626" stroke-width="1.5" marker-end="url(#w2)"/>
  <rect x="348" y="218" width="120" height="34" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="408" y="235" text-anchor="middle" fill="#92400e" font-size="8" font-weight="bold">OTHER CLIENT</text><text x="408" y="247" text-anchor="middle" fill="#92400e" font-size="8">SET k 99</text>
  <path d="M470,235 L496,235" stroke="#dc2626" stroke-width="1.5" marker-end="url(#w2)"/>
  <rect x="498" y="218" width="150" height="34" rx="5" fill="#fecaca" stroke="#dc2626" stroke-width="2"/><text x="573" y="235" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">EXEC (k dirty)</text><text x="573" y="247" text-anchor="middle" fill="#b91c1c" font-size="8">returns nil &#8594; aborted</text>
  <path d="M573,254 L573,290" stroke="#dc2626" stroke-width="1.5" marker-end="url(#w2)"/>
  <rect x="440" y="292" width="266" height="34" rx="5" fill="#fff" stroke="#dc2626"/><text x="573" y="313" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">loop: WATCH k again, re-read, retry</text>
  <path d="M440,309 L360,309 L360,254" stroke="#dc2626" stroke-width="1.2" fill="none" marker-end="url(#w2)"/>

  <rect x="30" y="352" width="820" height="60" rx="8" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="374" text-anchor="middle" fill="#854d0e" font-size="11" font-weight="bold">The rule of thumb</text>
  <text x="440" y="394" text-anchor="middle" fill="#713f12" font-size="10">WATCH+retry shines when conflicts are RARE. Under heavy contention on one key, everyone keeps retrying &#8212;</text>
  <text x="440" y="408" text-anchor="middle" fill="#713f12" font-size="10">a single atomic Lua script (do the read-modify-write server-side, once) is usually better.</text>
</svg>
```

## 5. Implementation

Three complete, runnable examples with `github.com/redis/go-redis/v9`: a pipeline, a `WATCH`-based compare-and-set, and an atomic Lua rate-limiter plus a get-or-set. Comments explain the *why*.

```go
package redisbatch

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// -----------------------------------------------------------------------------
// 1) PIPELINING — collapse N round trips into one. Pure throughput; NOT atomic.
// -----------------------------------------------------------------------------

// WarmCache writes many keys in a single network round trip. Doing this as N
// separate Set calls would pay the RTT N times; the pipeline pays it once.
// NOTE: these writes are NOT a transaction — another client's commands may
// interleave, and if the connection dies mid-flush some may apply and some not.
func WarmCache(ctx context.Context, rdb *redis.Client, items map[string]string) error {
	// Pipeline buffers the commands client-side and flushes them together.
	pipe := rdb.Pipeline()
	for k, v := range items {
		// Queued locally — no network yet. Each returns a *StatusCmd whose
		// result is only valid AFTER Exec has run.
		pipe.Set(ctx, k, v, 10*time.Minute)
	}
	// One write, one read: all replies come back together.
	_, err := pipe.Exec(ctx)
	return err
}

// MultiGet reads many keys in one round trip and returns the values that exist.
// We keep the per-command handles so we can read each reply after Exec.
func MultiGet(ctx context.Context, rdb *redis.Client, keys []string) (map[string]string, error) {
	pipe := rdb.Pipeline()
	cmds := make(map[string]*redis.StringCmd, len(keys))
	for _, k := range keys {
		cmds[k] = pipe.Get(ctx, k) // queued; result filled in by Exec
	}
	// Exec returns an error if ANY command errored, but redis.Nil (key missing)
	// is expected here, so we inspect each command individually instead of
	// trusting the aggregate error.
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	out := make(map[string]string, len(keys))
	for k, cmd := range cmds {
		v, err := cmd.Result()
		if errors.Is(err, redis.Nil) {
			continue // key simply did not exist — not an error for a cache read
		}
		if err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, nil
}

// -----------------------------------------------------------------------------
// 2) TRANSACTION with WATCH — optimistic compare-and-set across a read+write.
// -----------------------------------------------------------------------------

// DeductCredits atomically subtracts `cost` from a balance IF the balance is
// sufficient — a read-decide-write that MULTI/EXEC alone cannot express, so we
// use WATCH for optimistic locking and retry on conflict. This is the correct
// pattern when you need branching logic AND want to avoid holding a lock.
func DeductCredits(ctx context.Context, rdb *redis.Client, key string, cost int64) error {
	const maxRetries = 5

	// TxPipelined runs inside a WATCH: if `key` changes between our read and the
	// EXEC, the transaction aborts with redis.TxFailedErr and we retry.
	txf := func(tx *redis.Tx) error {
		// Read the CURRENT value under the watch.
		balance, err := tx.Get(ctx, key).Int64()
		if errors.Is(err, redis.Nil) {
			balance = 0
		} else if err != nil {
			return err
		}
		// Branch on the value — this decision is why a plain MULTI won't do.
		if balance < cost {
			return errors.New("insufficient credits")
		}
		// Queue the write; it only commits if `key` was untouched since WATCH.
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			pipe.Set(ctx, key, balance-cost, 0)
			return nil
		})
		return err
	}

	for i := 0; i < maxRetries; i++ {
		err := rdb.Watch(ctx, txf, key)
		if err == nil {
			return nil // committed
		}
		if errors.Is(err, redis.TxFailedErr) {
			continue // someone changed `key`; re-read and retry the CAS
		}
		return err // a real error (or "insufficient credits")
	}
	return errors.New("deduct credits: too much contention, giving up")
}

// -----------------------------------------------------------------------------
// 3) LUA — true atomic read-modify-write on the server, in one step.
// -----------------------------------------------------------------------------

// rateLimitScript is a fixed-window limiter. It is atomic: the GET-compare-INCR
// happens with nothing interleaved, so two concurrent callers can never both
// slip past the limit. KEYS[1] = the counter key; ARGV[1] = limit; ARGV[2] = ttl
// seconds. Passing the key via KEYS[] (never hard-coded) is what makes this
// Cluster-safe and lets Redis route it to the right slot.
var rateLimitScript = redis.NewScript(`
	local current = tonumber(redis.call("GET", KEYS[1]) or "0")
	if current >= tonumber(ARGV[1]) then
		return 0                       -- over the limit: reject
	end
	-- First hit in this window sets the TTL so the window actually expires.
	if current == 0 then
		redis.call("SET", KEYS[1], 1, "EX", ARGV[2])
	else
		redis.call("INCR", KEYS[1])
	end
	return 1                           -- allowed
`)

// AllowRequest returns true if the caller is within the rate limit. NewScript.Run
// tries EVALSHA first and transparently falls back to EVAL on NOSCRIPT, so the
// script body only travels the wire when the server doesn't already have it.
func AllowRequest(ctx context.Context, rdb *redis.Client, key string, limit, windowSec int) (bool, error) {
	res, err := rateLimitScript.Run(ctx, rdb, []string{key}, limit, windowSec).Int()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// getOrSetScript is an atomic get-or-set: return the existing value, or if the
// key is absent, set it to the supplied default (with a TTL) and return that.
// Done as one Lua step, two concurrent callers cannot both "win" and set
// different values — impossible to guarantee with separate GET then SETNX.
var getOrSetScript = redis.NewScript(`
	local v = redis.call("GET", KEYS[1])
	if v then
		return v
	end
	redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
	return ARGV[1]
`)

// GetOrSet returns the cached value, computing-and-storing the default only if
// the key is missing, atomically. (In real code `def` would be the freshly
// computed value; the atomicity here prevents two callers storing different
// defaults for the same key.)
func GetOrSet(ctx context.Context, rdb *redis.Client, key, def string, ttlSec int) (string, error) {
	return getOrSetScript.Run(ctx, rdb, []string{key}, def, ttlSec).Text()
}
```

The three functions map onto the three jobs: `WarmCache`/`MultiGet` cut round trips with no atomicity, `DeductCredits` does optimistic concurrency across a read and a write with `WATCH`, and `AllowRequest`/`GetOrSet` do genuine atomic read-modify-write server-side with Lua. If you ever find yourself reaching for `WATCH` in a tight retry loop on a hot key, that is the signal to move the logic into a Lua script instead.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Pipelining** turns N round trips into one — often a 10–100× throughput gain on bulk work — with zero change to command semantics and trivial code.
- **MULTI/EXEC** gives real isolation (nothing interleaves) and, with `WATCH`, lock-free optimistic concurrency that scales well when conflicts are rare.
- **Lua** expresses the read-then-write logic transactions cannot, atomically and server-side, replacing multi-round-trip races with one correct call.
- **EVALSHA** keeps Lua cheap on the wire — a 40-byte hash instead of the whole script — and go-redis handles the reload fallback for you.

**Disadvantages**
- **Pipelining is not atomic**, so it is useless when you actually need isolation, and a huge pipeline can bloat client and server buffers and delay other clients' replies.
- **Transactions have no rollback** — a runtime error mid-`EXEC` leaves earlier writes applied — and cannot branch on a value, which surprises people from a SQL background.
- **`WATCH` degrades under contention**: a hot key makes everyone abort and retry, wasting round trips; the optimistic model assumes conflicts are rare.
- **Lua blocks the single thread** for its whole duration, so a slow or unbounded script is a whole-instance stall, and scripts add an operational surface (versioning, `NOSCRIPT`, Cluster key rules).

**Trade-offs**
- *Pipeline vs transaction:* pipelining is throughput with no atomicity; MULTI/EXEC is atomicity (queued, no interleave) with less throughput benefit. Do not use one hoping for the other's property.
- *WATCH vs Lua for read-modify-write:* `WATCH`+retry is lock-free and fine under low contention but wastes work under high contention and needs a client-side loop; Lua does it in one atomic server-side call but occupies the single thread. Prefer Lua for hot-key read-modify-write.
- *Lua power vs blocking risk:* the same single-thread atomicity that makes Lua correct makes a slow script catastrophic. Keep scripts O(1)/bounded; the guarantee and the hazard are one property.
- *EVAL vs EVALSHA:* `EVAL` re-sends the body every call (simple, more bytes); `EVALSHA` sends a hash (efficient, needs `NOSCRIPT` handling). Use a client that does EVALSHA-with-fallback and get both.

## 7. Common Mistakes & Best Practices

- **Thinking a pipeline is a transaction.** It batches network traffic; it does not isolate. Other clients' commands interleave with your pipelined ones. *Best practice:* use pipelining only for throughput, and reach for MULTI/EXEC or Lua when you need atomicity.
- **Expecting rollback from MULTI/EXEC.** A runtime error on one queued command does not undo the others; there is no rollback. *Best practice:* validate inputs and types before the transaction, and use Lua when you need conditional all-or-nothing logic.
- **Trying to branch inside MULTI/EXEC.** You cannot read a value and conditionally queue a command in the same transaction — everything is queued before anything runs. *Best practice:* use `WATCH`+retry, or move the branch into a Lua script.
- **A `WATCH` retry loop on a hot key.** Under heavy contention everyone aborts and retries, burning round trips. *Best practice:* if one key is contended, do the read-modify-write in a single atomic Lua script instead.
- **Hard-coding keys inside Lua (or building them from ARGV).** This breaks Cluster routing and hides which slots the script touches. *Best practice:* pass every key through `KEYS[]`, non-key parameters through `ARGV[]`.
- **A long or unbounded Lua script.** It blocks every client for its whole duration — the same hazard as `KEYS *`. *Best practice:* keep scripts O(1) or bounded; batch large work into many small bounded scripts.
- **An unbounded pipeline.** Queuing a million commands into one flush bloats buffers and delays everyone else's replies. *Best practice:* chunk large pipelines into batches of a few hundred to a few thousand.
- **Non-deterministic Lua.** Historically Lua that used random values or wall-clock in ways that affected writes caused replication/AOF problems. *Best practice:* keep script effects deterministic given `KEYS`/`ARGV`, and pass time in via `ARGV` rather than reading it inside the script.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `SLOWLOG GET` names any script or transaction that stalled the event loop — a slow `EVAL` shows up here just like a `KEYS *`. `SCRIPT EXISTS <sha>` tells you whether a script is cached; a flood of `NOSCRIPT` errors after a failover or `SCRIPT FLUSH` means your loaded scripts vanished and clients must reload. For a stuck script, `SCRIPT KILL` aborts a script that has not yet written (if it has written, only `SHUTDOWN NOSAVE` can stop it — a reason to keep scripts short).
- **Monitoring.** Watch pipeline batch sizes (huge flushes cause reply-buffer growth and latency for others), the `WATCH` abort/retry rate (a rising rate signals contention that Lua would serve better), and per-script execution time via the slowlog. Track `INFO commandstats` for `eval`/`evalsha` call counts and latency.
- **Security.** Lua runs server-side, so a script is code you are executing on the database — treat scripts as reviewed, version-controlled artefacts, not strings assembled from user input (never interpolate untrusted data into a script body; pass it through `ARGV`). Redis 7 sandboxes scripts, but the discipline of parameterising all inputs still matters. `EVAL` can be restricted via ACL command rules if a role should not run arbitrary scripts.
- **Scaling.** In Redis Cluster, every key a pipeline, transaction, or script touches must live on the same node; a MULTI/EXEC or Lua script spanning multiple slots is rejected with a `CROSSSLOT` error. Co-locate related keys with hash tags (`{user:42}:balance`, `{user:42}:credits`) so multi-key atomic operations resolve to one slot. Pipelining across a cluster works but the client must split the batch per node, which good cluster-aware clients do for you.

## 9. Interview Questions

**Q: What does pipelining actually do, and what does it NOT do?**
A: Pipelining batches many commands into one network write and reads all their replies in one read, eliminating the per-command round-trip latency that dominates remote Redis calls — a large throughput win, often 10–100× on bulk work. What it does *not* do is provide any atomicity or isolation: the commands execute in arrival order on the single thread, but other clients' commands can interleave with yours, and there is no transaction. It is purely a network optimisation with identical semantics to sending the commands one at a time. Confusing it with a transaction is the classic mistake.

**Q: How does MULTI/EXEC give atomicity, and what are its two big limitations?**
A: After `MULTI`, commands are queued rather than executed; `EXEC` then runs the whole queue as one atomic unit, and because Redis is single-threaded no other client's command interleaves between them. The first limitation is no rollback: if a command is accepted at queue time but fails at execution time (a runtime error like `INCR` on a non-numeric value), the other commands still run and are not undone — atomic in the "nothing interleaves" sense, not the "all-or-nothing with rollback" sense. The second is that you cannot branch on a value: all commands are queued before any run, so you cannot read a key and conditionally decide what to queue. For that you need `WATCH`+retry or Lua.

**Q: What is WATCH and when do you use it?**
A: `WATCH` implements optimistic concurrency for a read-then-write. You `WATCH` the keys you are about to base a decision on, read them, decide, then `MULTI`/`EXEC` your writes. If any watched key was modified by anyone between the `WATCH` and the `EXEC`, the `EXEC` aborts and returns nil, so you loop and retry the whole read-decide-write. It is compare-and-set with no locks held and no blocking. Use it when conflicts on the watched keys are rare; under heavy contention on a single key it degrades because everyone keeps aborting and retrying, and a Lua script is then the better tool.

**Q: When do you choose Lua over a transaction?**
A: When you need read-then-write logic — read a value, branch on it, and write — as one atomic step, which MULTI/EXEC cannot express because it queues everything before running anything. A rate limiter (read the counter, compare to the limit, increment or reject), a get-or-set, and a compare-and-delete lock release are all this shape. Lua runs the whole thing on the server with nothing interleaved, so there is no race between the read and the write and no client-side retry loop. You also prefer Lua over `WATCH` when the key is hot, because Lua does the work once instead of aborting and retrying under contention.

**Q: Why must keys be passed via KEYS[] in a Lua script?**
A: Because Redis needs to know which keys — and therefore which hash slots — a script touches, and it learns that only from the declared `KEYS[]`. In Redis Cluster this is essential: the client routes the script to the node owning those slots, and a script that accesses a key not declared in `KEYS[]` either errors or misroutes. Even on a single node, declaring keys keeps scripts analysable and portable. Non-key parameters go through `ARGV[]`. Hard-coding a key name or building one from `ARGV` inside the script defeats all of this.

**Q: What is EVALSHA and why use it?**
A: `EVALSHA` invokes a script the server has already cached, by its 40-character SHA1 hash, instead of re-sending the whole body every call — a bandwidth optimisation for scripts you run frequently. You load the script once with `SCRIPT LOAD` (or let the first `EVAL` cache it) and then call `EVALSHA <sha> ...`. If the server no longer has the script — after a restart, a `SCRIPT FLUSH`, or a failover to a replica — it returns `NOSCRIPT`, and the client reloads it with a one-off `EVAL`. Good client libraries, including go-redis's `NewScript`/`Run`, do this EVALSHA-then-EVAL-on-NOSCRIPT dance automatically.

**Q: Does Redis roll back a transaction if one command fails at runtime?**
A: No. Redis distinguishes two failure kinds. A *syntax* error — a command that doesn't exist or has the wrong number of arguments — is caught when it's queued, and it makes the whole `EXEC` fail without running anything. But a *runtime* error — a command that queues fine but fails when it executes, like `INCR` on a key holding a non-numeric string — does not stop or undo the transaction: `EXEC` runs the rest of the queue and simply reports that one command's error alongside the other successful results. There is no rollback of the commands that already applied. This is a deliberate design choice, on the grounds that runtime errors are programming bugs and rollback machinery would complicate and slow the common path, and it's the main thing that surprises engineers coming from SQL databases.

**Q: (Senior) Contrast WATCH-based CAS with a Lua script for an atomic decrement-if-positive, and say when each is right.**
A: Both produce a correct "decrement only if the result stays non-negative", but they distribute the work differently. `WATCH`+retry keeps the logic on the client: watch the key, read it, decide in Go, and `EXEC`; if the key changed, abort and loop. It holds no lock and never blocks the server, and under low contention it is clean and lets you put arbitrary client-side logic between read and write. Its failure mode is contention — if many clients hammer the same key, they collide, abort, and retry, wasting round trips and adding tail latency; the retry count can spike unboundedly. A Lua script moves the whole decrement-if-positive server-side into one atomic step: no retries, no client loop, one round trip regardless of contention, and correctness guaranteed by the single thread. Its cost is that it occupies that single thread for its duration and adds script-management surface (`NOSCRIPT`, Cluster key rules, versioning). My rule: for a low-contention, occasional CAS with complex client-side logic, `WATCH` is fine and keeps logic in the app; for a hot key or anything on a request-path where retries would pile up, use Lua so the operation is O(1) round trips and immune to contention. If I see a `WATCH` loop's abort rate climbing in monitoring, that is my cue to port it to Lua.

**Q: (Senior) Why does Redis deliberately not roll back transactions, and how do you design around it?**
A: The Redis maintainers chose no rollback on principle and for performance. Their argument is that commands only fail at execution time because of programming errors — wrong type, wrong arity used against actual data — and those bugs should surface in development, not be silently papered over by a rollback in production. Rollback also requires maintaining undo information for every command, which complicates the code and slows the common path, and the single-threaded model already provides the isolation a transaction most needs. So a Redis transaction guarantees the queued commands run together with nothing interleaved, but not that they all succeed or all revert. You design around it in two ways. First, prevent execution-time errors up front: validate types and arguments before `EXEC`, because a *syntax* error is caught at queue time and aborts the whole thing, but a *type* error is not. Second, when you genuinely need conditional all-or-nothing behaviour — "do all of this, but only if a condition holds, and leave nothing half-done otherwise" — use a Lua script, where you can check the condition first and only then perform the writes, all atomically, so there is no half-applied state to roll back in the first place. In practice most "I need a transaction" cases in Redis are really "I need atomic read-modify-write", which is Lua's job, not MULTI/EXEC's.

**Q: (Senior) A Lua script occasionally spikes the latency of every client on the instance. What is happening and how do you fix it?**
A: The symptom — *all* clients spiking together — is the fingerprint of the single event loop being held, and a Lua script is a prime suspect because it runs to completion on that one thread with nothing else allowed to run. So somewhere the script is doing more work than O(1): iterating a collection whose size grew (a `SMEMBERS`/`KEYS`-equivalent inside the script), looping over `ARGV` that got large, or running a loop whose bound depends on data that has scaled up. I confirm with `SLOWLOG GET`, which records the `evalsha`/`eval` with its execution time, and `INFO commandstats` for the script's per-call latency and how it trends with data size. The fix is to bound the work: rewrite the script so its cost does not scale with a collection — process a fixed, small number of elements per call and paginate across calls, or restructure the data so the script touches O(1) keys. If the heavy step is fundamentally large (say, expiring thousands of members), do it in bounded batches driven by the client, not one giant script. As an operational guard I'd also make sure `lua-time-limit` is set so a runaway script becomes killable with `SCRIPT KILL` (before it writes), and audit scripts in review specifically for "does any loop here scale with data?" The deeper lesson is that Lua's atomicity and its blocking are the same property: a script is only safe if it is short and bounded, and "atomic" is never a licence to do a lot of work inside one.

## 10. Quick Revision & Cheat Sheet

| Tool | Gives you | Does NOT give you | Reach for it when |
|---|---|---|---|
| Pipeline | Fewer round trips (throughput) | Atomicity, isolation, transaction | Bulk read/write, cache warming, dumps |
| MULTI/EXEC | Atomic queued batch, no interleave | Rollback, branching on a value | A fixed set of writes must apply together |
| WATCH + MULTI/EXEC | Optimistic CAS across read+write | Good behaviour under high contention | Read-decide-write where conflicts are rare |
| Lua (EVAL/EVALSHA) | Atomic server-side read-modify-write | Freedom to run slow/unbounded code | Rate limit, get-or-set, CAS on a hot key |

| Command | Meaning |
|---|---|
| `MULTI` … `EXEC` | Start / run the queued transaction atomically |
| `DISCARD` | Throw away the queued transaction |
| `WATCH k` / `UNWATCH` | Mark / unmark keys for optimistic locking |
| `SCRIPT LOAD` / `EVALSHA` | Cache a script by SHA1 / invoke it by hash |
| `SCRIPT KILL` | Abort a running script (only if it hasn't written) |

**Flash cards**
- **Pipeline = ?** → Throughput (one round trip for many commands); NOT atomic.
- **MULTI/EXEC rollback?** → None. A runtime error mid-EXEC leaves earlier writes applied.
- **Branch on a value inside MULTI?** → No. Use WATCH+retry or Lua.
- **WATCH is?** → Optimistic compare-and-set; EXEC aborts if a watched key changed.
- **Why KEYS[] in Lua?** → So Redis/Cluster knows which slots the script touches.
- **Lua's hazard?** → A slow script blocks every client — atomicity and blocking are one property.

## 11. Hands-On Exercises & Mini Project

- [ ] Write 10,000 keys sequentially, then with a pipeline, and compare wall-clock time; explain the ratio in terms of RTT.
- [ ] Pipeline a `GET` then a `SET` and have a second client mutate the key in between, proving a pipeline is not isolated.
- [ ] Build a `WATCH`-based compare-and-set balance deduction; hammer it with concurrent clients and count how many `EXEC`s abort and retry.
- [ ] Rewrite that same deduction as a single Lua script and compare the retry count (zero) and the round trips.
- [ ] Trigger a `MULTI`/`EXEC` where one queued command errors at runtime and confirm the others still applied — there is no rollback.
- [ ] Load a script with `SCRIPT LOAD`, call it with `EVALSHA`, then `SCRIPT FLUSH` and observe the `NOSCRIPT` fallback.

### Mini Project — "Atomic Rate-Limited API Gateway"

**Goal.** Build a small gateway that uses all three tools where each is correct, so the decision rule becomes muscle memory.

**Requirements.**
1. Use a **pipeline** to warm the gateway's cache with a batch of route configs in one round trip on startup, and to fetch multiple config keys per request without N round trips.
2. Use a **Lua script** as the per-client rate limiter (fixed or sliding window), passing the key via `KEYS[]` and the limit/window via `ARGV[]`, so the check-and-increment is atomic and race-free.
3. Use a **`WATCH`-based transaction** to atomically consume from a per-client credit balance with a read-decide-write, retrying on conflict, and prove it stays correct under concurrent load.
4. Load-test with many concurrent clients and record: pipeline round-trip savings, Lua limiter accuracy under contention (no client ever exceeds the limit), and the `WATCH` abort/retry rate.
5. Instrument the `SLOWLOG` and demonstrate that a deliberately slow Lua script appears there and stalls other clients.

**Extensions.**
- Port the credit deduction from `WATCH` to Lua and chart the retry count and tail latency dropping under contention.
- Make the gateway Cluster-safe: co-locate a client's limiter and balance keys with a hash tag so the multi-key transaction and script resolve to one slot, and show what happens (`CROSSSLOT`) without the tag.
- Add EVALSHA caching with an explicit `NOSCRIPT` fallback and simulate a failover to prove the reload path works.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (why single-threaded execution makes commands atomic and slow ones dangerous), *Redis Data Types & Which to Cache With* (the atomic per-type operations these tools compose), *Sorted Sets: Rate Limiting, Leaderboards & Windows* (the limiter this chapter scripts atomically), *Build: Distributed Locks & Redlock* (Lua compare-and-delete release in anger), *Cache Stampede & the Thundering Herd* (get-or-set and single-flight built on Lua/WATCH).

- **Redis — Pipelining** — Redis · *Beginner* · the official explanation of why round trips dominate and how batching removes them. <https://redis.io/docs/latest/develop/use/pipelining/>
- **Redis — Transactions (MULTI/EXEC/WATCH/DISCARD)** — Redis · *Intermediate* · the canonical reference, including the explicit statement that Redis does not roll back. <https://redis.io/docs/latest/develop/interact/transactions/>
- **Redis — Scripting with Lua (EVAL/EVALSHA)** — Redis · *Advanced* · KEYS/ARGV rules, determinism, and the script cache; essential for correct Cluster-safe scripts. <https://redis.io/docs/latest/develop/interact/programmability/eval-intro/>
- **Redis — Redis programmability & functions** — Redis · *Advanced* · the modern Functions API that builds on scripting, plus the sandboxing model. <https://redis.io/docs/latest/develop/interact/programmability/>
- **go-redis — Pipelines and transactions** — redis/go-redis · *Intermediate* · how `Pipeline`, `TxPipeline`, `Watch` and `NewScript` map to the concepts in this chapter. <https://redis.uptrace.dev/guide/go-redis-pipelines.html>
- **Redis — SCRIPT LOAD / EVALSHA / SCRIPT KILL commands** — Redis · *Intermediate* · the command reference for the script cache and killing a runaway script. <https://redis.io/docs/latest/commands/script-load/>
- **Redis University — RU101 & RU202** — Redis · *Beginner–Intermediate* · free courses covering transactions, scripting and running Redis in production. <https://university.redis.com/>
- **Redis — Cluster specification (keys, slots, CROSSSLOT)** — Redis · *Advanced* · why multi-key commands, transactions and scripts need co-located keys, and how hash tags fix it. <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>

---

*Caching with Redis Handbook — chapter 22.*
