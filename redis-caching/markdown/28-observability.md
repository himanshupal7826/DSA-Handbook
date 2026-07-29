# 28 · Observability: Hit Ratio, Slowlog, Latency & Memory

> **In one line:** A cache you cannot see is a cache you cannot trust — and the four numbers that actually matter (hit ratio, evictions, memory pressure, and the latency of the single thread) tell you whether Redis is saving you money or quietly falling over, long before your users do.

---

## 1. Overview

A cache is an optimisation, and an optimisation you cannot measure is an act of faith. Redis will happily serve traffic while its hit ratio collapses, its memory creeps toward `maxmemory`, or one badly-written command stalls the single thread for every client — and none of that shows up as an error. It shows up as *slowness somewhere else*: your database gets busier, your p99 drifts up, your bill grows. Observability is how you turn those silent failures into signals you can alert on.

This chapter is about the specific metrics that matter for a *cache*, which are a narrower and sharper set than general application monitoring. The single most important number is the **hit ratio** — the fraction of lookups Redis served without touching the origin — because it is the direct measure of whether the cache is doing its job. Close behind are the signs of memory pressure (**evicted_keys**, **used_memory** against **maxmemory**, and **mem_fragmentation_ratio**), because a cache that is evicting your working set has a hit ratio that is about to fall. And because Redis executes on one thread (chapter 3), the **slowlog** and **latency** subsystems matter more here than on almost any other server: one O(N) command is not a slow request, it is a global outage.

The tools are almost entirely built in. `INFO` exposes hundreds of fields across sections (`stats`, `memory`, `clients`, `persistence`); `SLOWLOG` records the commands that blocked the thread; `LATENCY` diagnoses event-loop stalls; `commandstats` and `latencystats` break down cost per command; `--bigkeys` and `MEMORY DOCTOR` find the keys and conditions that hurt. This chapter shows you which fields to scrape, what healthy looks like, what to alert on, and how to wire it into Prometheus so a human hears about a falling hit ratio before a customer does.

## 2. Core Concepts

- **Hit ratio** — `keyspace_hits / (keyspace_hits + keyspace_misses)` from `INFO stats`; the headline measure of cache effectiveness.
- **keyspace_hits / keyspace_misses** — cumulative counters of key lookups that found / did not find a key; the raw material of the hit ratio.
- **evicted_keys** — cumulative count of keys removed by the eviction policy because `maxmemory` was reached; rising evictions mean memory pressure.
- **expired_keys** — cumulative count of keys removed because their TTL elapsed; healthy and expected, unlike evictions.
- **used_memory vs used_memory_rss** — the memory Redis allocated for data vs the resident memory the OS actually gave the process; their ratio is fragmentation.
- **mem_fragmentation_ratio** — `used_memory_rss / used_memory`; near 1.0 is healthy, high means fragmentation, below 1.0 means swapping (a red alert).
- **connected_clients** — current client connections; a leak here exhausts file descriptors and memory.
- **instantaneous_ops_per_sec** — a live estimate of commands per second; the throughput pulse.
- **SLOWLOG** — an in-memory ring buffer of commands whose execution exceeded a threshold; the first place to look for what blocked the thread.
- **LATENCY monitoring** — a subsystem (`LATENCY HISTORY`/`DOCTOR`/`RESET`) that records latency spikes by cause (fork, expire, command), diagnosing event-loop stalls.
- **commandstats / latencystats** — per-command call counts, total time and per-call latency; how you find the expensive command, not just the slow request.

## 3. Theory & Principles

### The hit ratio is the whole point — and it is a rate, not a level

Everything a cache does reduces to one question: *did the lookup avoid the origin?* The hit ratio answers it. `INFO stats` gives you two ever-increasing counters, `keyspace_hits` and `keyspace_misses`, and the ratio between them is your cache's reason for existing. A 95% hit ratio means nineteen of twenty reads never touched your database; drop to 80% and you have quadrupled the origin's read load, because misses went from 5% to 20%.

The crucial subtlety is that these are **cumulative counters since the last restart or `CONFIG RESETSTAT`**. If you compute the ratio over all-time counters, you get a smooth lie — a number dominated by history that barely moves when today's hit ratio falls off a cliff. What you actually want is the *rate* over a recent window: `rate(keyspace_hits)` and `rate(keyspace_misses)` over the last five minutes. This is exactly why a Prometheus exporter that samples the counters and lets you compute deltas is worth more than eyeballing `INFO`. A falling *windowed* hit ratio is the earliest warning that something changed — a deploy that changed key names, a TTL that got too short, a working set that outgrew memory.

One honest caveat: `keyspace_hits`/`misses` count *key* lookups across the whole instance, not your application's logical cache lookups. A `GET` on a missing key is a miss; an `EXISTS`, an `HGET` on a present key, all fold in. For a dedicated cache instance this is close enough to your logical hit ratio to be the number you live by; on a shared instance you may prefer to also track hits/misses in your application code for precision.

### Evictions and expirations are not the same thing

`expired_keys` and `evicted_keys` both count key removals, and confusing them is a classic misdiagnosis. **Expiration is healthy**: keys you set with a TTL reached the end of their life and were removed, exactly as designed. A high `expired_keys` rate on a TTL-driven cache is normal. **Eviction is pressure**: Redis hit `maxmemory` and the policy (chapter 7) threw out keys to make room for new writes. A non-zero and *rising* `evicted_keys` rate means your working set no longer fits in the memory budget, and every evicted key that gets requested again is a future miss. So the alert is not "any eviction" (a busy `allkeys-lru` cache evicts constantly by design) but a *rising trend* or evictions correlated with a *falling hit ratio* — that combination is the signature of a cache being squeezed.

### Memory: allocated, resident, and the fragmentation ratio

Redis reports two memory numbers that you must not confuse. `used_memory` is what Redis's allocator (jemalloc, usually) has handed out for your data and overhead. `used_memory_rss` is the **R**esident **S**et **S**ize — the physical RAM the operating system has actually committed to the process. Their ratio, `mem_fragmentation_ratio = used_memory_rss / used_memory`, is one of the most diagnostic single numbers Redis exposes:

- **~1.0–1.5**: healthy. Some overhead is normal.
- **> 1.5**: real fragmentation — the allocator is holding pages it cannot pack tightly, often after a workload that filled and then deleted many keys of varying sizes. `used_memory_rss` far above `used_memory` means you are paying for RAM you cannot use.
- **< 1.0**: alarm. RSS is *below* allocated memory, which means part of Redis has been **swapped to disk**. On a single-threaded in-memory server, a memory access that becomes a disk seek is catastrophic — latency goes from microseconds to milliseconds for everyone. Redis on a swapping host is a production emergency.

There is a related trap: `used_memory` counts data, but the process also spends memory on client buffers, replication backlog, and the copy-on-write pages during an RDB fork. This is why `maxmemory` should leave headroom below the machine's RAM — a `maxmemory` set to 100% of the box invites the OOM killer or swapping during a fork.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The four cache signals and what a bad reading means</text>

  <rect x="24" y="44" width="410" height="180" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="68" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">1. Hit ratio  (is the cache working?)</text>
  <text x="40" y="92" fill="#1d4ed8" font-size="10">keyspace_hits / (hits + misses)</text>
  <text x="40" y="112" fill="#1e40af" font-size="9" font-weight="bold">healthy: 90&#8211;99% on the RATE, not all-time</text>
  <text x="40" y="132" fill="#64748b" font-size="9">falling &#8594; deploy changed keys, TTL too short,</text>
  <text x="40" y="148" fill="#64748b" font-size="9">working set outgrew memory &#8594; origin load rises</text>
  <rect x="40" y="162" width="378" height="50" rx="6" fill="#fff" stroke="#93c5fd"/>
  <text x="52" y="182" fill="#1e40af" font-size="9" font-weight="bold">Alert on the 5-min windowed ratio dropping,</text>
  <text x="52" y="200" fill="#1e40af" font-size="9" font-weight="bold">not the smooth all-time number.</text>

  <rect x="446" y="44" width="410" height="180" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="68" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">2. Evictions  (is memory squeezing you?)</text>
  <text x="462" y="92" fill="#b45309" font-size="10">evicted_keys (pressure)  vs  expired_keys (normal)</text>
  <text x="462" y="112" fill="#92400e" font-size="9" font-weight="bold">expired = healthy TTL churn</text>
  <text x="462" y="130" fill="#92400e" font-size="9" font-weight="bold">evicted = maxmemory reached, policy dropped keys</text>
  <text x="462" y="150" fill="#64748b" font-size="9">rising evictions + falling hit ratio = working set</text>
  <text x="462" y="164" fill="#64748b" font-size="9">no longer fits the budget</text>
  <rect x="462" y="176" width="378" height="36" rx="6" fill="#fff" stroke="#fbbf24"/>
  <text x="474" y="199" fill="#92400e" font-size="9" font-weight="bold">Alert on rising eviction RATE, not any eviction.</text>

  <rect x="24" y="236" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="260" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">3. Memory / fragmentation</text>
  <text x="40" y="284" fill="#166534" font-size="10">mem_fragmentation_ratio = used_memory_rss / used_memory</text>
  <rect x="40" y="296" width="378" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="52" y="312" fill="#166534" font-size="9">~1.0&#8211;1.5  &#8594;  healthy</text>
  <rect x="40" y="324" width="378" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="52" y="340" fill="#92400e" font-size="9">&gt; 1.5  &#8594;  fragmentation, paying for unusable RAM</text>
  <rect x="40" y="352" width="378" height="24" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="52" y="368" fill="#b91c1c" font-size="9" font-weight="bold">&lt; 1.0  &#8594;  SWAPPING &#8212; emergency, us becomes ms</text>
  <text x="40" y="396" fill="#64748b" font-size="9">used_memory near maxmemory &#8594; imminent eviction/OOM;</text>
  <text x="40" y="412" fill="#64748b" font-size="9">leave headroom for client buffers + RDB fork COW pages.</text>

  <rect x="446" y="236" width="410" height="200" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="260" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">4. Latency of the single thread</text>
  <text x="462" y="284" fill="#991b1b" font-size="10">One O(N) command is not a slow request &#8212; it is a</text>
  <text x="462" y="300" fill="#991b1b" font-size="10">GLOBAL stall for every client on the instance.</text>
  <text x="462" y="324" fill="#b91c1c" font-size="9" font-weight="bold">SLOWLOG &#8594; which command blocked the loop</text>
  <text x="462" y="342" fill="#b91c1c" font-size="9" font-weight="bold">LATENCY DOCTOR &#8594; fork / expire / command spikes</text>
  <text x="462" y="362" fill="#b91c1c" font-size="9" font-weight="bold">commandstats &#8594; where total time is actually spent</text>
  <rect x="462" y="374" width="378" height="46" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="474" y="394" fill="#b91c1c" font-size="9">Alert on ANY new slowlog entry above ~10ms and on</text>
  <text x="474" y="410" fill="#b91c1c" font-size="9">latency spikes &#8212; on one thread they hit everyone.</text>
</svg>
```

### Latency on a single thread is a shared fate

On a multi-threaded server, a slow request hurts one client. On Redis, because command execution is single-threaded (chapter 3), a slow *command* hurts **all** clients — while it runs, nothing else does. This is why latency observability for Redis is not about averages but about *outliers*: the one `KEYS *`, the one `HGETALL` on a million-field hash, the one Lua script with an accidental loop. Those never show up in mean latency because they are rare; they show up as p99/p999 spikes that correlate across every client at once. The tools are built for exactly this shape of problem: the `SLOWLOG` catches individual slow commands, and the `LATENCY` subsystem attributes spikes to their cause (a `fork` for RDB/AOF, an `expire` cycle, a specific command). You are not asking "is Redis fast on average" — it always is — you are asking "what briefly held the one thread that serves everyone."

## 4. Architecture & Workflow

The observability data flows from three built-in sources into whatever collects and alerts on it:

1. **`INFO` — the periodic vital signs.** A single command returns a large keyed text block, grouped into sections: `server`, `clients`, `memory`, `persistence`, `stats`, `replication`, `cpu`, `commandstats`, `latencystats`, `keyspace`. A collector scrapes it every 10–30 seconds and turns the fields into time series. This is where hit ratio, evictions, memory and connections come from.
2. **`SLOWLOG` — the event log of stalls.** A ring buffer (default 128 entries) recording every command whose *execution time* — not counting network — exceeded `slowlog-log-slower-than` microseconds (default 10000 = 10ms). Each entry has an id, timestamp, duration, the command with arguments, and the client. You pull it with `SLOWLOG GET`, size it with `CONFIG SET`, and clear it with `SLOWLOG RESET`.
3. **`LATENCY` — the spike diagnostician.** When `latency-monitor-threshold` is set above 0 (it defaults to 0 = off), Redis records the worst latency events by *category* — `fork`, `expire-cycle`, `command`, `aof-write` — with `LATENCY HISTORY <event>` for the time series of one category, `LATENCY LATEST` for the current worst, `LATENCY DOCTOR` for a human-readable analysis with likely causes and remedies, and `LATENCY RESET` to clear.

Around these, a **Prometheus exporter** (the community `redis_exporter`) runs `INFO`, `commandstats`, `latencystats` and optionally `slowlog`, exposes them as `/metrics`, and Prometheus scrapes and stores them. Grafana dashboards and Alertmanager rules sit on top. The workflow in an incident is: dashboard shows the symptom (hit ratio down, latency up, memory near max) → `SLOWLOG GET` and `LATENCY DOCTOR` name the cause → `commandstats` confirms which command is eating the time → `--bigkeys`/`MEMORY DOCTOR` finds the offending key.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ob1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">From Redis internals to an alert in someone's hand</text>

  <rect x="24" y="44" width="220" height="330" rx="10" fill="#f1f5f9" stroke="#475569" stroke-width="2"/>
  <text x="134" y="66" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Redis built-ins</text>

  <rect x="40" y="80" width="188" height="80" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="134" y="100" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">INFO</text>
  <text x="52" y="118" fill="#1d4ed8" font-size="9">stats: hits/misses/evictions</text>
  <text x="52" y="134" fill="#1d4ed8" font-size="9">memory: used / rss / frag</text>
  <text x="52" y="150" fill="#1d4ed8" font-size="9">clients, ops/sec, persistence</text>

  <rect x="40" y="170" width="188" height="70" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="134" y="190" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">SLOWLOG</text>
  <text x="52" y="208" fill="#991b1b" font-size="9">ring buffer of commands</text>
  <text x="52" y="224" fill="#991b1b" font-size="9">slower than N microseconds</text>

  <rect x="40" y="250" width="188" height="70" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="134" y="270" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">LATENCY + commandstats</text>
  <text x="52" y="288" fill="#b45309" font-size="9">spikes by cause: fork/expire</text>
  <text x="52" y="304" fill="#b45309" font-size="9">per-command time &amp; calls</text>

  <rect x="40" y="330" width="188" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="134" y="352" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">--bigkeys / MEMORY DOCTOR</text>

  <path d="M244,150 L300,150" stroke="#64748b" stroke-width="1.5" marker-end="url(#ob1)"/>
  <rect x="304" y="110" width="210" height="90" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="409" y="140" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">redis_exporter</text>
  <text x="316" y="162" fill="#6d28d9" font-size="9">runs INFO/commandstats,</text>
  <text x="316" y="178" fill="#6d28d9" font-size="9">exposes /metrics</text>

  <path d="M514,155 L570,155" stroke="#64748b" stroke-width="1.5" marker-end="url(#ob1)"/>
  <rect x="574" y="110" width="130" height="90" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="639" y="150" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Prometheus</text>
  <text x="639" y="170" text-anchor="middle" fill="#1d4ed8" font-size="9">scrape + store</text>

  <path d="M639,200 L639,240" stroke="#64748b" stroke-width="1.5" marker-end="url(#ob1)"/>
  <rect x="540" y="244" width="180" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="630" y="270" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Grafana dashboards</text>
  <text x="630" y="290" text-anchor="middle" fill="#166534" font-size="9">hit ratio, memory, latency</text>

  <path d="M639,304 L639,340" stroke="#64748b" stroke-width="1.5" marker-end="url(#ob1)"/>
  <rect x="540" y="344" width="180" height="60" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="630" y="370" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Alertmanager</text>
  <text x="630" y="390" text-anchor="middle" fill="#991b1b" font-size="9">page a human before a customer</text>

  <rect x="744" y="110" width="112" height="294" rx="8" fill="#fff" stroke="#94a3b8"/>
  <text x="800" y="132" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">Incident flow</text>
  <text x="756" y="158" fill="#475569" font-size="8">symptom on dashboard</text>
  <text x="800" y="172" text-anchor="middle" fill="#64748b" font-size="9">&#8595;</text>
  <text x="756" y="188" fill="#475569" font-size="8">SLOWLOG GET names it</text>
  <text x="800" y="202" text-anchor="middle" fill="#64748b" font-size="9">&#8595;</text>
  <text x="756" y="218" fill="#475569" font-size="8">LATENCY DOCTOR</text>
  <text x="756" y="230" fill="#475569" font-size="8">attributes the spike</text>
  <text x="800" y="244" text-anchor="middle" fill="#64748b" font-size="9">&#8595;</text>
  <text x="756" y="260" fill="#475569" font-size="8">commandstats: which</text>
  <text x="756" y="272" fill="#475569" font-size="8">command eats time</text>
  <text x="800" y="286" text-anchor="middle" fill="#64748b" font-size="9">&#8595;</text>
  <text x="756" y="302" fill="#475569" font-size="8">--bigkeys finds the</text>
  <text x="756" y="314" fill="#475569" font-size="8">offending key</text>
  <text x="800" y="330" text-anchor="middle" fill="#64748b" font-size="9">&#8595;</text>
  <text x="756" y="348" fill="#166534" font-size="8" font-weight="bold">fix: SCAN not KEYS,</text>
  <text x="756" y="360" fill="#166534" font-size="8" font-weight="bold">shard big key,</text>
  <text x="756" y="372" fill="#166534" font-size="8" font-weight="bold">raise maxmemory or</text>
  <text x="756" y="384" fill="#166534" font-size="8" font-weight="bold">shorten TTL churn</text>
</svg>
```

## 5. Implementation

The core skill is scraping `INFO`, computing the hit ratio as a rate, and reading the slowlog. Here it is in `redis-cli` first, then in Go with `github.com/redis/go-redis/v9`.

### redis-cli: the commands you run in an incident

```bash
# Hit ratio inputs — these are CUMULATIVE counters since restart/RESETSTAT.
# For a live ratio, sample twice and diff, or use a Prometheus exporter.
redis-cli INFO stats | grep -E 'keyspace_hits|keyspace_misses|evicted_keys|expired_keys|instantaneous_ops_per_sec'
# keyspace_hits:918273
# keyspace_misses:41022
# expired_keys:20551      <- healthy TTL churn
# evicted_keys:0          <- non-zero + rising = memory pressure
# instantaneous_ops_per_sec:14200

# Memory: used vs resident, and the fragmentation ratio that diagnoses swapping.
redis-cli INFO memory | grep -E 'used_memory:|used_memory_rss:|used_memory_human|maxmemory_human|mem_fragmentation_ratio'
# used_memory:2147483648
# used_memory_rss:2415919104
# mem_fragmentation_ratio:1.12   <- healthy; <1.0 means SWAPPING

# Clients — a leak here exhausts file descriptors.
redis-cli INFO clients | grep -E 'connected_clients|blocked_clients|maxclients'

# SLOWLOG — the first stop when latency spikes. Lower the threshold to 5ms,
# reproduce, then read what blocked the single thread.
redis-cli CONFIG SET slowlog-log-slower-than 5000     # microseconds
redis-cli SLOWLOG GET 10                               # last 10 slow commands
# 1) 1) (integer) 14          <- entry id
#    2) (integer) 1722240000  <- unix time
#    3) (integer) 82734       <- microseconds it ran (82ms!)
#    4) 1) "KEYS"             <- the offending command...
#       2) "user:*"           <- ...and its arguments
#    5) "10.0.3.7:53122"      <- the client that issued it
redis-cli SLOWLOG RESET                                # clear after triage

# LATENCY — turn it on, then attribute spikes to fork / expire / command.
redis-cli CONFIG SET latency-monitor-threshold 100    # record events over 100ms
redis-cli LATENCY LATEST                               # current worst per category
redis-cli LATENCY HISTORY fork                         # time series for RDB fork stalls
redis-cli LATENCY DOCTOR                               # human-readable diagnosis + remedy

# commandstats / latencystats — WHERE the time actually goes, per command.
redis-cli INFO commandstats | head
# cmdstat_get:calls=8123,usec=41200,usec_per_call=5.07,...
# cmdstat_hgetall:calls=52,usec=903400,usec_per_call=17373.0,...  <- 17ms/call!
redis-cli INFO latencystats                           # p50/p99 per command (Redis 7+)

# --bigkeys / MEMORY DOCTOR — find the key and condition hurting you.
redis-cli --bigkeys                                   # samples the keyspace for big keys
redis-cli MEMORY DOCTOR                               # narrates memory problems
redis-cli MEMORY USAGE some:key                       # exact bytes for one key
```

### Go: scrape INFO, compute a windowed hit ratio, read the slowlog

```go
package cacheobs

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// InfoStats holds the handful of fields that actually matter for a cache. We
// parse them out of the big INFO text block rather than trusting a single
// helper, because which fields you care about is a design decision, not a
// library one.
type InfoStats struct {
	Hits, Misses     int64
	Evicted, Expired int64
	UsedMemory       int64
	UsedMemoryRSS    int64
	Maxmemory        int64
	FragRatio        float64
	ConnectedClients int64
	OpsPerSec        int64
}

// scrapeInfo runs INFO across the sections we need and parses the flat
// "key:value" lines into a struct. INFO returns one big string; each section is
// separated by a "# Section" header we simply ignore while scanning fields.
func scrapeInfo(ctx context.Context, rdb *redis.Client) (InfoStats, error) {
	// Ask for exactly the sections we use to keep the payload small.
	raw, err := rdb.Info(ctx, "stats", "memory", "clients").Result()
	if err != nil {
		return InfoStats{}, err
	}
	fields := map[string]string{}
	for _, line := range strings.Split(raw, "\r\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue // skip blank lines and "# Memory" style headers
		}
		if k, v, ok := strings.Cut(line, ":"); ok {
			fields[k] = v
		}
	}
	atoi := func(k string) int64 { n, _ := strconv.ParseInt(fields[k], 10, 64); return n }
	atof := func(k string) float64 { f, _ := strconv.ParseFloat(fields[k], 64); return f }
	return InfoStats{
		Hits:             atoi("keyspace_hits"),
		Misses:           atoi("keyspace_misses"),
		Evicted:          atoi("evicted_keys"),
		Expired:          atoi("expired_keys"),
		UsedMemory:       atoi("used_memory"),
		UsedMemoryRSS:    atoi("used_memory_rss"),
		Maxmemory:        atoi("maxmemory"),
		FragRatio:        atof("mem_fragmentation_ratio"),
		ConnectedClients: atoi("connected_clients"),
		OpsPerSec:        atoi("instantaneous_ops_per_sec"),
	}, nil
}

// WindowedHitRatio is the number you actually want to alert on. The INFO
// counters are cumulative since restart, so an all-time ratio is a smooth lie
// that barely moves when today's ratio collapses. We sample twice over a window
// and compute the ratio of the DELTAS — the true recent hit ratio.
func WindowedHitRatio(ctx context.Context, rdb *redis.Client, window time.Duration) (float64, error) {
	before, err := scrapeInfo(ctx, rdb)
	if err != nil {
		return 0, err
	}
	select {
	case <-time.After(window):
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	after, err := scrapeInfo(ctx, rdb)
	if err != nil {
		return 0, err
	}
	dHits := after.Hits - before.Hits
	dMiss := after.Misses - before.Misses
	total := dHits + dMiss
	if total == 0 {
		return 1.0, nil // no lookups in the window; treat as "no misses"
	}
	return float64(dHits) / float64(total), nil
}

// HealthCheck applies the alerting thresholds this chapter argues for. It
// returns the list of problems, empty if all is well — the shape a health
// endpoint or an alert rule wants.
func HealthCheck(ctx context.Context, rdb *redis.Client) ([]string, error) {
	s, err := scrapeInfo(ctx, rdb)
	if err != nil {
		return nil, err
	}
	var problems []string

	// Fragmentation < 1.0 means Redis has been swapped to disk: on a
	// single-threaded in-memory server this is an emergency, not a warning.
	if s.FragRatio > 0 && s.FragRatio < 1.0 {
		problems = append(problems, fmt.Sprintf(
			"SWAPPING: mem_fragmentation_ratio=%.2f (<1.0) — Redis is on disk", s.FragRatio))
	} else if s.FragRatio > 1.5 {
		problems = append(problems, fmt.Sprintf(
			"fragmentation high: %.2f — paying for unusable RAM", s.FragRatio))
	}

	// Memory near maxmemory means imminent eviction or OOM. Alert at 90%.
	if s.Maxmemory > 0 {
		if used := float64(s.UsedMemory) / float64(s.Maxmemory); used > 0.90 {
			problems = append(problems, fmt.Sprintf(
				"memory %.0f%% of maxmemory — evictions/OOM imminent", used*100))
		}
	}
	return problems, nil
}

// ReadSlowlog pulls recent slow commands so an incident tool can show WHAT
// blocked the single thread, not just that latency was high.
func ReadSlowlog(ctx context.Context, rdb *redis.Client, n int64) error {
	entries, err := rdb.SlowLogGet(ctx, n).Result()
	if err != nil {
		return err
	}
	for _, e := range entries {
		// Duration is the execution time on the single thread — the number that
		// matters, because while it ran every other client waited.
		fmt.Printf("[%s] took %v — %s — from %s\n",
			e.Time.Format(time.RFC3339), e.Duration, strings.Join(e.Args, " "), e.ClientAddr)
	}
	return nil
}
```

The Go code encodes the chapter's three load-bearing ideas: the hit ratio must be windowed to mean anything, fragmentation below 1.0 is an emergency rather than a warning, and the slowlog is how you turn "latency was high" into "this exact command blocked everyone."

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Everything is built in.** `INFO`, `SLOWLOG`, `LATENCY`, `commandstats`, `--bigkeys`, `MEMORY DOCTOR` ship with Redis; you need no agent inside the process to get deep visibility.
- **Cheap to collect.** `INFO` is O(1) and slowlog reads are trivial, so scraping every 10–30 seconds adds negligible load to the one thread.
- **Directly actionable.** The slowlog names the offending command and client; `LATENCY DOCTOR` suggests a remedy. These are diagnoses, not just numbers.
- **A single fragmentation number** cleanly separates healthy overhead from real fragmentation from a swapping emergency.

**Disadvantages**
- **Counters are cumulative.** Hit ratio, evictions and expirations are all-time totals; you must diff over a window yourself (or use an exporter) to see recent behaviour.
- **`keyspace_hits/misses` is instance-wide.** It approximates but does not equal your application's logical cache hit ratio, especially on a shared instance.
- **The slowlog is a small ring buffer.** At the default 128 entries a burst of slow commands can push earlier ones out before you read them.
- **`LATENCY` and `SLOWLOG` are off or coarse by default.** `latency-monitor-threshold` defaults to 0 (disabled); you must configure thresholds before an incident, not during.

**Trade-offs**
- *Scrape frequency vs resolution:* frequent `INFO` scrapes give sharper time series but add load and storage; 10–30 seconds is the usual balance for a cache.
- *Slowlog threshold vs noise:* a low `slowlog-log-slower-than` (e.g. 1ms) catches more but fills the buffer with near-normal commands; 5–10ms catches the genuinely dangerous ones without noise.
- *Instance-wide hit ratio vs application-level:* the built-in counters are free and close enough for a dedicated cache; application-level instrumentation is precise but is code you must write and maintain.
- *Alerting on levels vs rates:* memory-near-maxmemory is a level you alert on directly; hit ratio and evictions must be rates, because their all-time levels are meaningless for detecting a change.

## 7. Common Mistakes & Best Practices

- **Computing hit ratio from all-time counters.** The smooth all-time number barely moves when today's ratio collapses. *Best practice:* alert on the rate over a 5-minute window, via `rate()` in Prometheus or a diff of two scrapes.
- **Confusing evictions with expirations.** Panicking over a high `expired_keys` (healthy TTL churn) while ignoring a rising `evicted_keys` (real memory pressure). *Best practice:* alert on the eviction *rate* trend, and correlate it with the hit ratio.
- **Ignoring `mem_fragmentation_ratio < 1.0`.** Treating a sub-1.0 ratio as "low fragmentation, good" when it actually means Redis is swapping to disk — an emergency on a single-threaded in-memory server. *Best practice:* page immediately on `< 1.0`.
- **Setting `maxmemory` to 100% of the box.** Leaving no headroom for client buffers, replication backlog and the copy-on-write pages of an RDB fork invites the OOM killer. *Best practice:* set `maxmemory` to ~70–80% of RAM.
- **Leaving `LATENCY` and a sane `SLOWLOG` threshold unconfigured.** Discovering during an incident that the tools that would have diagnosed it were off. *Best practice:* enable `latency-monitor-threshold` and set `slowlog-log-slower-than` as part of provisioning.
- **Never reading `commandstats`.** Knowing latency is high but not *which command* consumes the time. *Best practice:* watch `usec_per_call` per command; a rare command with a huge per-call cost is your blocker.
- **Alerting on averages.** Mean latency on Redis is always good and hides the one O(N) command that spiked everyone. *Best practice:* alert on p99/p999 and on any new slowlog entry.
- **Best practice: define "healthy" up front.** Write down the target hit ratio, the eviction and memory thresholds, and the slowlog threshold before go-live, so alerts fire against a baseline rather than a vibe.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The incident loop is fixed: dashboard shows the symptom, `SLOWLOG GET` names the blocking command, `LATENCY DOCTOR` attributes the spike (fork vs expire vs command), `INFO commandstats` confirms which command eats the total time, and `--bigkeys`/`MEMORY USAGE` finds the offending key. Simultaneous latency spikes across *all* clients almost always mean the event loop was held — look for an O(N) command or an RDB fork, not a per-client problem.
- **Monitoring.** Scrape `INFO` (stats/memory/clients/persistence), `commandstats` and `latencystats` every 10–30s via `redis_exporter` into Prometheus. Dashboard the four signals: windowed hit ratio, eviction/expiration rates, memory-vs-maxmemory with the fragmentation ratio, and p99 latency with slowlog entries overlaid. In Cluster, collect *per node* — a hotspot shard can be starving while the fleet average looks fine.
- **Security.** `INFO` and `SLOWLOG` leak operational detail, and slowlog entries contain **command arguments** — which may include cached values or key names that reveal PII or business logic. Restrict the monitoring user with ACLs (chapter 29) to `INFO`, `SLOWLOG`, `LATENCY`, `MEMORY` and `CONFIG GET` only, and never expose `/metrics` publicly.
- **Scaling.** As you add nodes, the number of `INFO` fields to reason about explodes; aggregate in Prometheus (sum evictions, average fragmentation, max latency across the fleet) but keep the ability to drill into one node. The hit ratio should be tracked *per logical cache* (per key prefix or per service) as well as per instance, because a single instance can hide one collapsing cache behind several healthy ones.

## 9. Interview Questions

**Q: What single metric best tells you whether a Redis cache is doing its job, and how do you compute it?**
A: The hit ratio: `keyspace_hits / (keyspace_hits + keyspace_misses)` from `INFO stats`. It is the direct measure of how often a lookup avoided the origin. The catch is that those are cumulative counters since restart, so the all-time ratio is a smooth number that barely moves when the current ratio falls; you want the ratio of the *deltas* over a recent window (e.g. `rate()` over five minutes in Prometheus), which reveals a change — a bad deploy, a too-short TTL, a working set that outgrew memory — as soon as it happens.

**Q: What is the difference between `evicted_keys` and `expired_keys`, and which should alarm you?**
A: `expired_keys` counts keys removed because their TTL elapsed — healthy, expected churn on a TTL-driven cache. `evicted_keys` counts keys the eviction policy removed because `maxmemory` was reached — that is memory pressure. A rising eviction rate, especially correlated with a falling hit ratio, means your working set no longer fits the budget and evicted keys are becoming future misses. So a high expiration rate is normal; a *rising* eviction rate is the one to alert on.

**Q: You see `mem_fragmentation_ratio` at 0.85. Is that good?**
A: No — it is an emergency. The ratio is `used_memory_rss / used_memory`; below 1.0 means the resident memory is *less* than what Redis allocated, which means part of Redis has been swapped to disk. On a single-threaded in-memory server, a memory access that becomes a disk seek turns microsecond latency into millisecond latency for every client at once. A ratio near 1.0–1.5 is healthy overhead; above 1.5 is real fragmentation (paying for RAM you cannot pack); below 1.0 you page someone immediately.

**Q: Why does the slowlog matter more on Redis than on a typical server?**
A: Because Redis executes commands on a single thread, so a slow command does not just make one request slow — while it runs, every other client waits. A slow request on a multi-threaded server hurts one user; a slow *command* on Redis is a global stall. The slowlog records exactly those commands (execution time over a threshold) with the arguments and client, so it turns "everyone's latency spiked at once" into "this `KEYS user:*` from that client blocked the loop for 82ms."

**Q: What is `instantaneous_ops_per_sec` and what does it tell you?**
A: It is Redis's live estimate of commands executed per second, sampled over a short recent window. It is the throughput pulse — a sudden drop can indicate the thread is blocked (fewer commands completing because one is hogging it) or that clients disconnected; a sudden spike can precede memory or latency pressure. It pairs with `connected_clients` and the latency metrics to distinguish "load went up" from "the thread is stuck."

**Q: How do you find which command is responsible for high latency, not just that latency is high?**
A: `INFO commandstats`, which reports per command the call count, total microseconds, and `usec_per_call`. A command with a high `usec_per_call`, even if rarely called, is your blocker — a single `HGETALL` averaging 17ms is far more dangerous on a single thread than a million 5-microsecond `GET`s. On Redis 7+, `INFO latencystats` adds per-command latency percentiles. The slowlog then gives you the individual offending invocations with arguments.

**Q: (Senior) Design an alerting strategy for a production Redis cache. What fires a page versus a ticket?**
A: I separate signals by whether they are levels or rates and by severity. Immediate pages: `mem_fragmentation_ratio < 1.0` (swapping — the whole instance is degraded), `used_memory > 90%` of `maxmemory` (imminent eviction/OOM), and any new slowlog entry above a critical threshold (say 50ms) or a p999 latency spike, because on one thread those are global. Tickets/warnings: a windowed hit ratio falling below its baseline (e.g. under 85% when it normally runs 95%), a rising eviction rate, `connected_clients` trending toward `maxclients`, and fragmentation above 1.5. The key discipline is that hit ratio and evictions are alerted as *rates over a window* (their all-time levels are meaningless), while memory-vs-maxmemory and fragmentation are alerted as *levels*. I also alert per logical cache and per Cluster node, because a fleet average hides a single collapsing cache or a hotspot shard. And I make sure `latency-monitor-threshold` and `slowlog-log-slower-than` are configured at provisioning time, so the diagnostic tools are already recording when the page fires.

**Q: (Senior) Your dashboard shows p99 latency spiking every hour on the hour, but mean latency is fine and the slowlog is empty. What is happening?**
A: Empty slowlog plus periodic all-client spikes points away from a slow *command* and toward an out-of-band event that holds or slows the process without being a command — the classic culprit is an RDB `BGSAVE` fork on a schedule. The `fork()` to snapshot memory causes a copy-on-write page-fault storm and a latency blip proportional to dataset size, and it will not appear in the slowlog because it is not a command. `LATENCY HISTORY fork` and `LATENCY DOCTOR` confirm it by attributing the spike to the `fork` category, and `INFO persistence` shows the `rdb_last_save_time` aligning with the spikes. Other candidates for periodic all-client spikes are an AOF rewrite, an active-expiration cycle clearing a batch of simultaneously-expiring keys (an avalanche of TTLs set at the same instant), a cron job running `HGETALL`/`KEYS` on a schedule, or the host swapping. The fix depends: for a pure cache, disable RDB/AOF entirely; for a persistent instance, move saves off-peak or use a replica for snapshots; for the TTL avalanche, add jitter to TTLs. The tell is that mean latency is fine and the slowlog is clean — that rules out a steadily slow command and points at a periodic, non-command event.

**Q: (Senior) How would you build hit-ratio observability that is meaningful when one Redis instance serves several logical caches?**
A: The instance-wide `keyspace_hits/misses` is an average that can hide one collapsing cache behind several healthy ones, so I would not rely on it alone. I would instrument at two levels. Instance-wide from `INFO` gives me the cheap, always-on baseline and the memory/eviction context. But for per-logical-cache visibility I add application-level counters — increment a hit or miss metric labelled by cache name (or key prefix) in the code that wraps each cache lookup — because only the application knows that `product:*` and `session:*` are different caches with different SLOs. That lets me alert when the product-catalog cache's hit ratio drops even while the session cache masks it in the instance average. If I cannot change the application, a second-best is to segment by key prefix using `--scan` sampling or keyspace notifications, but that is approximate. The principle is that the hit ratio is only actionable at the granularity of a thing that has an owner and an SLO, and on a shared instance that granularity is finer than the instance.

**Q: Why should you leave headroom below `maxmemory` rather than setting it to the machine's full RAM?**
A: Because `used_memory` counts your data, but the process needs memory beyond that: client output buffers (which can balloon for slow consumers or big replies), the replication backlog, Lua/script overhead, and — most importantly — the copy-on-write pages created during an RDB fork, which in the worst case can approach doubling memory for write-heavy workloads. If `maxmemory` equals the box's RAM, a fork or a buffer spike pushes the process into swap (fragmentation ratio drops below 1.0) or triggers the OOM killer. Setting `maxmemory` to roughly 70–80% of RAM leaves room for these, so the eviction policy manages your data budget while the OS is never starved.

**Q: What does `--bigkeys` do and when do you reach for it?**
A: `redis-cli --bigkeys` samples the keyspace with `SCAN` (so it does not block the thread) and reports the largest key it found per type, along with distributions. You reach for it when memory is unexpectedly high, when one Cluster node is a hotspot, or when the slowlog shows an O(N) command and you need to find which key it was operating on. A single multi-megabyte value or million-element collection makes every command touching it slow and, in Cluster, concentrates memory and latency on one shard. `--bigkeys` finds those keys so you can split or shard them; `MEMORY USAGE key` then gives the exact byte cost of a specific suspect.

## 10. Quick Revision & Cheat Sheet

| Signal | Field(s) | Healthy | Alert when |
|---|---|---|---|
| Hit ratio | `keyspace_hits`/`keyspace_misses` | 90–99% (windowed) | rate drops below baseline |
| Evictions | `evicted_keys` | low / flat | rate rising (memory pressure) |
| Expirations | `expired_keys` | any (TTL churn) | — (normal) |
| Memory | `used_memory` vs `maxmemory` | < 80% | > 90% (OOM imminent) |
| Fragmentation | `mem_fragmentation_ratio` | 1.0–1.5 | > 1.5 (frag) / < 1.0 (swap!) |
| Clients | `connected_clients` | stable | near `maxclients` |
| Throughput | `instantaneous_ops_per_sec` | steady | sudden drop (thread stuck) |
| Blocking | `SLOWLOG`, p99 latency | empty / flat | any new entry / spike |

| Tool | Answers |
|---|---|
| `INFO stats/memory/clients` | hit ratio, evictions, memory, connections |
| `SLOWLOG GET` | which command blocked the single thread |
| `LATENCY DOCTOR`/`HISTORY` | fork / expire / command spikes, with remedies |
| `INFO commandstats` | which command consumes the total time |
| `--bigkeys` / `MEMORY USAGE` | which key is big and expensive |

**Flash cards**
- **Hit ratio?** → `hits/(hits+misses)`; alert on the *rate*, not the all-time level.
- **Evicted vs expired?** → evicted = memory pressure (alarm on rising rate); expired = healthy TTL churn.
- **Fragmentation < 1.0?** → Redis is swapping — emergency on a single-threaded server.
- **Why slowlog matters here?** → one slow command blocks *every* client, not one request.
- **Find the expensive command?** → `INFO commandstats`, watch `usec_per_call`.
- **maxmemory headroom?** → set ~70–80% of RAM for buffers + RDB fork COW pages.

## 11. Hands-On Exercises & Mini Project

- [ ] Scrape `INFO stats`, compute the hit ratio from all-time counters, then compute it as a delta over a 60-second window and note how differently they respond to a burst of misses.
- [ ] Set a small `maxmemory` with `allkeys-lru`, load more data than fits, and watch `evicted_keys` climb while the hit ratio falls.
- [ ] Fill and delete many keys of varying sizes, then read `mem_fragmentation_ratio` and observe it rise above 1.0.
- [ ] Lower `slowlog-log-slower-than` to 5ms, run a `KEYS *` on a loaded instance, and find it in `SLOWLOG GET` with its duration and client.
- [ ] Enable `latency-monitor-threshold`, trigger a `BGSAVE` under write load, and read `LATENCY HISTORY fork` and `LATENCY DOCTOR`.
- [ ] Run `--bigkeys`, then `MEMORY USAGE` on the biggest key it reports, and confirm the byte cost.

### Mini Project — "Cache Health Exporter"

**Goal.** Build a small service that turns Redis's raw internals into the four alertable signals and exposes them for Prometheus, so cache health becomes a dashboard and a page rather than a manual `INFO` read.

**Requirements.**
1. Scrape `INFO stats/memory/clients` on a configurable interval and expose gauges for used/rss memory, connected clients and ops/sec.
2. Compute and export a **windowed** hit ratio and eviction/expiration *rates* from the cumulative counters, not the all-time levels.
3. Export `mem_fragmentation_ratio` and a derived `used_memory / maxmemory` ratio, with the swapping (`< 1.0`) and near-max (`> 90%`) conditions as separate alertable series.
4. Pull the slowlog periodically and export a counter of new entries above a threshold, plus the worst duration seen.
5. Ship an Alertmanager rule file encoding the page-vs-ticket policy from section 8.

**Extensions.**
- Add per-key-prefix hit/miss instrumentation in a sample application and compare it to the instance-wide ratio, demonstrating how a shared instance hides a collapsing logical cache.
- Run against a 3-node Cluster and add per-node panels plus fleet aggregates, then deliberately create a hotspot shard and show it in the per-node view but not the average.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (why one slow command is a global event), *Memory, maxmemory & Eviction* (what drives evictions and fragmentation), *Cache Stampede, Penetration & Avalanche* (the TTL avalanche behind periodic latency spikes), *Persistence: RDB, AOF & the Durability Trade-off* (the fork that causes fork-latency), *Security & Production Hardening* (locking down the monitoring user).

- **Redis — INFO command reference** — Redis · *Intermediate* · the authoritative list of every `INFO` field and section, the source of every metric in this chapter. <https://redis.io/docs/latest/commands/info/>
- **Redis — Diagnosing latency issues** — Redis · *Advanced* · the maintainers' guide to the `LATENCY` subsystem, fork stalls and the single-thread latency model. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>
- **Redis — SLOWLOG documentation** — Redis · *Intermediate* · how the slowlog buffer works, its config, and how to read entries. <https://redis.io/docs/latest/commands/slowlog-get/>
- **Redis — Memory optimization & fragmentation** — Redis · *Advanced* · what `used_memory` vs `used_memory_rss` mean and how to reason about the fragmentation ratio. <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/>
- **redis_exporter (Prometheus)** — oliver006 · *Intermediate* · the community exporter that scrapes `INFO`/`commandstats` and exposes `/metrics`; the standard way to wire Redis into Prometheus. <https://github.com/oliver006/redis_exporter>
- **Redis — LATENCY DOCTOR & MEMORY DOCTOR** — Redis · *Intermediate* · the self-diagnosing commands that narrate latency and memory problems with remedies. <https://redis.io/docs/latest/commands/latency-doctor/>
- **Grafana — Redis dashboards** — Grafana Labs · *Beginner* · ready-made dashboards for the `redis_exporter` metrics, a fast start for the four signals. <https://grafana.com/grafana/dashboards/>
- **Redis University — RU301: Running Redis in Production** — Redis · *Intermediate* · a free course covering observability, latency and memory operations end to end. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 28.*
