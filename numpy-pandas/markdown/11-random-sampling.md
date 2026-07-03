# 11 · Random Sampling & Generators

> **In one line:** Use the modern `np.random.default_rng()` Generator — seedable, faster, and free of the hidden global state that makes legacy `np.random` a reproducibility hazard.

---

## 1. Overview

Randomness drives simulation, bootstrapping, train/test splits, data augmentation, and Monte Carlo estimation. NumPy has **two** APIs for it, and picking the right one matters more than beginners expect.

The **legacy** API — `np.random.seed`, `np.random.rand`, `np.random.choice` — operates on a single hidden **global** state. Any library you import can call it and perturb your "reproducible" results, and it's awkward to parallelize.

Since NumPy 1.17 the recommended API is the **Generator**, created with `np.random.default_rng(seed)`. It bundles a **BitGenerator** (default PCG64, a modern statistically-strong stream) with the distribution methods. State is explicit and local: you pass the `rng` object around, so nothing global can taint it.

This page covers creating and seeding a Generator, the common distributions, `choice`/`shuffle`/`permutation`, sampling **with and without replacement**, and how to spawn independent streams for parallel work.

## 2. Core Concepts

- **Generator** — `rng = np.random.default_rng(seed)`. The modern entry point; all sampling is a method on `rng`.
- **BitGenerator** — the raw bit stream (default **PCG64**). The Generator turns bits into distributions.
- **Seeding** — pass an `int` (or `SeedSequence`) for reproducibility. Same seed → identical stream, forever.
- **Legacy `RandomState`** — the old global (`np.random.*`) and its class. Frozen for backward-compat, uses the slower **Mersenne Twister (MT19937)**.
- **Distributions** — `rng.random`, `.integers`, `.normal`, `.uniform`, `.binomial`, `.poisson`, `.choice`, etc.
- **`integers(low, high)`** — the modern replacement for legacy `randint`; note the `endpoint=` flag.
- **`choice`** — sample from an array/range, with or without replacement, optional probability weights `p=`.
- **`shuffle`** — in-place permutation; **`permutation`** returns a shuffled copy.
- **Without replacement** — each element drawn at most once (`replace=False`); needed for splits and unique subsets.
- **Independent streams** — `SeedSequence(seed).spawn(n)` or `rng.spawn(n)` gives non-overlapping child generators for parallelism.

## 3. Syntax & Examples

```python
import numpy as np

rng = np.random.default_rng(42)      # seeded Generator

rng.random(3)                        # 3 floats in [0, 1)
rng.integers(0, 10, size=5)          # 5 ints in [0, 10)  (high exclusive)
rng.normal(loc=0, scale=1, size=3)   # standard normal
rng.uniform(-1, 1, size=3)           # uniform on [-1, 1)
```

```text
random  : [0.77395605 0.43887844 0.85859792]
integers: [8 6 5 2 3]
normal  : [ 0.30471708 -1.03998411  0.7504512 ]
uniform : [-0.20470766  0.47894334 -0.51943872]
```

Reproducibility — same seed, same numbers:

```python
np.random.default_rng(0).random(3)   # -> [0.63696169 0.26978671 0.04097352]
np.random.default_rng(0).random(3)   # -> identical
```

`choice`, `shuffle`, `permutation`:

```python
deck = np.arange(10)
rng.choice(deck, size=3, replace=False)     # 3 distinct draws
rng.choice(deck, size=4, replace=True)      # with replacement (repeats OK)
rng.choice(['a','b','c'], size=5, p=[0.7, 0.2, 0.1])  # weighted

rng.shuffle(deck)          # shuffles deck IN PLACE, returns None
perm = rng.permutation(10) # returns a NEW shuffled array 0..9
```

## 4. Worked Example

**Reproducible bootstrap confidence interval for a mean.** We resample a dataset *with replacement* 10,000 times and take the 2.5/97.5 percentiles — a classic use of `choice(replace=True)`.

```python
import numpy as np

rng = np.random.default_rng(2024)
data = rng.normal(loc=50, scale=8, size=200)   # our "sample"

n_boot = 10_000
means = np.empty(n_boot)
for i in range(n_boot):
    resample = rng.choice(data, size=data.size, replace=True)
    means[i] = resample.mean()

lo, hi = np.percentile(means, [2.5, 97.5])
print(f"sample mean : {data.mean():.3f}")
print(f"95% bootstrap CI : [{lo:.3f}, {hi:.3f}]")
```

```text
sample mean : 49.616
95% bootstrap CI : [48.512, 50.744]
```

Because `rng` was seeded with `2024`, this CI is byte-for-byte reproducible on any machine. Swap the loop for a vectorized `rng.choice(data, size=(n_boot, data.size), replace=True).mean(axis=1)` to get the same statistics ~50× faster.

## 5. Under the Hood

A Generator is two layers: a **BitGenerator** producing a deterministic stream of 64-bit integers from its seed, and the **Generator** wrapper mapping those bits onto distributions (via inversion, Ziggurat, etc.). The seed is expanded by a **SeedSequence** into a high-quality initial state, which is why nearby integer seeds still yield statistically independent streams. `spawn` hands each worker a distinct, non-overlapping child sequence — the correct way to parallelize without correlated draws.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="330" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">default_rng: explicit local state, spawnable streams</text>

  <rect x="30" y="55" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="95" y="80" text-anchor="middle" fill="#1e293b">seed = 42</text>
  <text x="95" y="100" text-anchor="middle" fill="#64748b">int / entropy</text>

  <path d="M162 85 L212 85" stroke="#475569" fill="none" marker-end="url(#arr)"/>

  <rect x="216" y="55" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="291" y="80" text-anchor="middle" fill="#1e293b">SeedSequence</text>
  <text x="291" y="100" text-anchor="middle" fill="#64748b">expands to state</text>

  <path d="M368 85 L418 85" stroke="#475569" fill="none" marker-end="url(#arr)"/>

  <rect x="422" y="55" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="497" y="80" text-anchor="middle" fill="#1e293b">BitGenerator</text>
  <text x="497" y="100" text-anchor="middle" fill="#64748b">PCG64 bits</text>

  <path d="M497 117 L497 155" stroke="#475569" fill="none" marker-end="url(#arr)"/>

  <rect x="400" y="158" width="195" height="55" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="497" y="182" text-anchor="middle" fill="#1e293b">Generator</text>
  <text x="497" y="201" text-anchor="middle" fill="#64748b">.normal .choice .integers</text>

  <text x="291" y="150" text-anchor="middle" fill="#64748b">.spawn(3) →</text>
  <rect x="70" y="165" width="90" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="115" y="190" text-anchor="middle" fill="#1e293b">child 0</text>
  <rect x="170" y="165" width="90" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="215" y="190" text-anchor="middle" fill="#1e293b">child 1</text>
  <rect x="270" y="165" width="90" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="315" y="190" text-anchor="middle" fill="#1e293b">child 2</text>
  <path d="M291 117 L291 160" stroke="#475569" fill="none" stroke-dasharray="4 3" marker-end="url(#arr)"/>
  <text x="215" y="245" text-anchor="middle" fill="#64748b">independent, non-overlapping streams for parallel workers</text>

  <rect x="30" y="255" width="600" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="277" text-anchor="middle" fill="#b91c1c">Legacy np.random.* shares ONE hidden global state — any import can perturb it.</text>
</svg>
```

## 6. Variations & Trade-offs

| Aspect | Legacy `np.random.*` / `RandomState` | Modern `default_rng()` Generator |
|---|---|---|
| State | single hidden **global** | explicit, local object |
| Algorithm | MT19937 (Mersenne Twister) | **PCG64** (faster, better stats) |
| Seed API | `np.random.seed(n)` | `default_rng(n)` |
| Int sampler | `randint(low, high)` | `integers(low, high, endpoint=False)` |
| Parallelism | error-prone | `spawn()` / `SeedSequence` |
| Stream stability | frozen (values guaranteed) | may improve across major versions |
| Recommended? | only for legacy reproducibility | **yes, for all new code** |

Prefer the Generator everywhere. The one reason to touch legacy code is reproducing an *old* result whose exact numbers were pinned to MT19937 — the Generator's stream is intentionally different and, unlike legacy, isn't frozen forever across NumPy versions (though seeds stay reproducible within a version line).

**`shuffle` vs `permutation`:** `shuffle(a)` mutates `a` in place and returns `None`; `permutation(a)` leaves the input untouched and returns a shuffled copy (and `permutation(n)` shuffles `arange(n)`).

## 7. Production / Performance Notes

- **Seed once, pass the object.** Create one `rng` at your entry point and thread it through functions/classes. Don't call `default_rng()` in a hot loop — construction has real cost and you lose stream continuity.
- **Vectorize, don't loop.** `rng.normal(size=(1_000_000,))` is one call; a Python loop of scalar draws is 100×+ slower.
- **Parallel workers → `spawn`.** Never share one `rng` across processes, and never seed each worker with the same int. Use `rng.spawn(n_workers)` (or `SeedSequence(seed).spawn(n)`) for guaranteed-independent streams.
- **`choice` without replacement is O(n) in the population** for weighted sampling — for huge populations sample indices with `rng.permutation` and slice, or use reservoir sampling.
- **Reproducibility ≠ security.** PCG64 is *not* cryptographic. For tokens, keys, or nonces use the `secrets` module, never NumPy.
- **Pin the seed AND record the NumPy version** for auditable experiments; the Generator stream can differ across major versions.
- **GPU/dask:** libraries like CuPy and Dask have their own Generator-compatible RNGs — mirror the same seed-passing discipline.

## 8. Common Mistakes

1. ⚠️ **Using `np.random.seed()` for "reproducibility."** A stray library call to `np.random.*` breaks it. Fix: use a local `default_rng(seed)`.
2. ⚠️ **Recreating `default_rng()` inside a loop.** You keep restarting the same short stream. Fix: create once, reuse.
3. ⚠️ **Seeding parallel workers identically.** Every worker draws the *same* numbers. Fix: `rng.spawn(n)`.
4. ⚠️ **Expecting `integers(0, 10)` to include 10.** `high` is exclusive by default. Fix: pass `endpoint=True` or use `high=11`.
5. ⚠️ **`shuffle` "returning" the array.** It returns `None`; `x = rng.shuffle(a)` sets `x=None`. Fix: use `permutation` for a returned copy.
6. ⚠️ **`choice(..., replace=False, size > len(a))`.** Impossible — raises `ValueError`. Fix: reduce size or allow replacement.
7. ⚠️ **Weighted `choice` with `p` not summing to 1.** Raises. Fix: normalize `p = p / p.sum()`.
8. ⚠️ **Using NumPy RNG for secrets/passwords.** It's predictable. Fix: use the `secrets` module.

## 9. Interview Questions

**Q: What is the difference between `np.random.default_rng()` and the legacy `np.random` functions?**
A: `default_rng()` returns a Generator with explicit, local state built on the modern PCG64 BitGenerator. The legacy functions share a single hidden global state on the older MT19937. The Generator is faster, statistically stronger, easier to parallelize, and immune to other code mutating a global.

**Q: How do you make random results reproducible?**
A: Create a seeded Generator, `rng = np.random.default_rng(seed)`, and thread that object everywhere you sample. Same seed and NumPy version → identical stream. Avoid the global `np.random.seed`, which any import can disturb.

**Q: Why is the global `np.random.seed` considered fragile?**
A: It sets one process-wide state. Any library that also calls `np.random.*` advances or reseeds it, so your "reproducible" run silently changes. Local Generators isolate state.

**Q: What is a BitGenerator versus a Generator?**
A: The BitGenerator (e.g. PCG64) produces the raw deterministic bit stream from the seed; the Generator wraps it and maps those bits onto distributions like `normal` or `poisson`. You can swap BitGenerators under the same Generator interface.

**Q: What's the difference between `shuffle` and `permutation`?**
A: `shuffle` permutes the array in place and returns `None`; `permutation` returns a shuffled copy and leaves the input intact. `permutation(n)` shuffles `arange(n)`.

**Q: How do you sample without replacement, and when do you need it?**
A: `rng.choice(a, size=k, replace=False)` draws each element at most once. You need it for train/test splits, dealing cards, or any unique subset where duplicates would be invalid.

**Q: How does `choice` apply probability weights?**
A: Pass `p=` — an array the same length as the population summing to 1. Each element is then drawn proportional to its weight, with or without replacement.

**Q: How do you generate independent random streams across parallel workers?**
A: Create a root `SeedSequence(seed)` (or one Generator) and call `.spawn(n)` to produce non-overlapping child sequences, one per worker. Never share a single Generator across processes or seed workers identically.

**Q: (Senior) You seeded everything but two runs still differ across machines — what could cause it?**
A: Different NumPy versions (stream not guaranteed across majors), a non-NumPy RNG (Python `random`, torch, cuDNN) left unseeded, thread/process nondeterminism in reductions, or floating-point differences in BLAS. Pin all RNGs, versions, and thread counts.

**Q: (Senior) Why not just use NumPy's RNG for security tokens?**
A: PCG64 is a fast *statistical* PRNG, not cryptographic — its output is predictable given enough samples or the seed. Use the `secrets` module (CSPRNG) for anything security-sensitive.

**Q: (Senior) How would you make a bootstrap of 10k resamples fast and reproducible?**
A: Seed one Generator; draw all resamples in a single vectorized `rng.choice(data, size=(n_boot, n), replace=True)` and reduce with `.mean(axis=1)`. One dispatch, no Python loop, fully reproducible from the seed.

## 10. Practice

- [ ] Create two Generators with the same seed and confirm they emit identical arrays; reseed one and show divergence.
- [ ] Draw 1M standard-normal samples and verify the empirical mean/std ≈ 0/1.
- [ ] Deal a 5-card poker hand from `arange(52)` using `choice(replace=False)`.
- [ ] Implement a weighted die (`p=[...]`) and check the empirical frequencies over 100k rolls.
- [ ] Use `rng.spawn(4)` to give four "workers" independent streams; confirm no overlap in their first draws.

## 11. Cheat Sheet

> [!TIP]
> **Always:** `rng = np.random.default_rng(seed)` then use `rng.*` — never the global `np.random.seed`. **Distros:** `rng.random`, `.integers(low,high)` (high exclusive!), `.normal`, `.uniform`, `.binomial`, `.poisson`. **Pick:** `rng.choice(a, size, replace=False, p=w)`. **Order:** `shuffle` (in place, returns None) vs `permutation` (returns copy). **Parallel:** `rng.spawn(n)` for independent streams. **Never** use it for crypto — use `secrets`. Pin seed + NumPy version for auditable results.

**References:** NumPy Random sampling docs (`numpy.random.Generator`), "NumPy random: legacy vs new" NEP 19, PCG paper (O'Neill), NumPy release notes 1.17

---
*NumPy & Pandas Handbook — topic 11.*
