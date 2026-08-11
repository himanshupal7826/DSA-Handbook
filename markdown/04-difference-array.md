# 04 · Difference Array

> **One-liner:** Apply many range updates in O(1) each, then reconstruct with one pass.

---

## 1. Overview

### Definition
The **Difference Array** pattern belongs to the *Foundations* family. Apply many range updates in O(1) each, then reconstruct with one pass.

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
difference, range update, increment range, imos, interval add.

### Constraints
- Input size where the brute-force complexity would time out — the Difference Array optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Difference Array invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Difference Array is the upgrade.
- The wording maps onto: difference, range update, increment range, imos, interval add.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Add `v` to every element between `l` and `r`"* — asked many times, before anyone reads the array.

### Intuition
Do exactly what was asked. For each update, walk the range and add.

### Algorithm
1. Read the update `(l, r, v)`.
2. For `i` from `l` to `r`: `arr[i] += v`.
3. Repeat for every update.
4. Return `arr`.

### Complexity
- Time: **O(n) per update**, so **O(m·n)** for `m` updates.
- Space: O(n).

### Drawbacks
- An update covering the whole array touches all `n` cells even though it says one simple thing: *"everyone here goes up by `v`"*.
- With `m = 10⁴` bookings over `n = 10⁴` seats, that's 10⁸ writes — and nobody has read a single value yet.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Don't record the value at every position. Record only where the value *changes* — the start and the end.**

Imagine marking a stretch of road as "+10 speed limit". You don't repaint every metre. You put up one sign at the start saying **+10**, and one sign at the end saying **−10**. A driver keeping a running tally of signs always knows the current limit.

That running tally is a prefix sum. So:

> **Difference array is the inverse of prefix sum. Prefix sum turns many range *queries* into O(1); difference array turns many range *updates* into O(1).**

### The thought process

```text
We need    : many range updates, then read the final array once.
Obvious way: loop over each range and add.
Too slow   : O(m·n), and the same cells get written again and again.
Notice     : inside a range, every element changes by the SAME amount.
             The only interesting places are the two edges.
Therefore  : store the CHANGE between neighbours instead of the values.
             +v where the range starts, -v just after it ends.
Now        : each update is 2 writes, and one prefix sum at the end
             rebuilds the whole array.
```

### Steps

```text
Step 1 → Make diff of size n+1, all zeros.
Step 2 → For each update (l, r, v):
             diff[l]   += v      "from here on, add v"
             diff[r+1] -= v      "stop adding v from here on"
Step 3 → Sweep once with a running total:
             running += diff[i];  arr[i] = running
Step 4 → arr is the final array.
```

### Why `diff[r+1] -= v` and not `diff[r] -= v`

Because `r` is **inclusive** — element `r` must still receive the `+v`. The cancellation has to happen at the *first index that should not get it*, which is `r+1`.

This is exactly why `diff` needs `n+1` slots: when `r = n−1`, the write goes to `diff[n]`, one past the last real element. That slot is never read during reconstruction, it just gives the "−v" somewhere legal to land — the same "one extra slot removes a special case" trick as the prefix array's leading zero.

### Why the prefix sum rebuilds the array

If `diff[i]` holds `arr[i] − arr[i−1]`, then adding up `diff[0..i]` telescopes back to `arr[i]`:

```text
diff[0] + diff[1] + diff[2] + ... + diff[i]
= arr[0] + (arr[1]-arr[0]) + (arr[2]-arr[1]) + ... + (arr[i]-arr[i-1])
= arr[i]                    ← everything in between cancels
```

Each update writes two deltas; the sweep integrates them all at once.

### A tiny worked check

```text
n = 5, update (1, 3, +2)

diff : [ 0, +2,  0,  0, -2,  0 ]
         0   1   2   3   4   5     ← index 5 exists only to hold the -2
running: 0   2   2   2   0
arr    : [0,  2,  2,  2,  0]       ← exactly indices 1..3 got +2  ✓
```

### How should I recognize this?

```text
If you see...
  "add v to all elements in range [l, r]", many times
  bookings / reservations / flights / passengers over a range
  "how many intervals cover each point"
  all updates come FIRST, reads come after
        ↓
Think about...
  "Inside a range nothing varies — only the two edges matter."
        ↓
Use...
  difference array   → offline: all updates, then one read
  Fenwick / segment  → online: updates and reads interleaved
  sweep line         → the same idea when the coordinates are sparse
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="da-04" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">add +2 to range [1..3]: mark diff[1] += 2, diff[4] −= 2</text>
  <text x="40" y="78" fill="#64748b">diff</text>
  <!-- diff row with +/- marks -->
  <g>
    <text x="118" y="52" text-anchor="middle" fill="#64748b">0</text><rect x="90"  y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="118" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="178" y="52" text-anchor="middle" fill="#64748b">1</text><rect x="150" y="58" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="178" y="85" text-anchor="middle" fill="#059669" font-weight="700">+2</text>
    <text x="238" y="52" text-anchor="middle" fill="#64748b">2</text><rect x="210" y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="238" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="298" y="52" text-anchor="middle" fill="#64748b">3</text><rect x="270" y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="298" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="358" y="52" text-anchor="middle" fill="#64748b">4</text><rect x="330" y="58" width="56" height="42" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="358" y="85" text-anchor="middle" fill="#d97706" font-weight="700">−2</text>
  </g>
  <line x1="238" y1="112" x2="238" y2="150" stroke="#475569" marker-end="url(#da-04)"/>
  <text x="430" y="135" text-anchor="middle" fill="#64748b">running prefix of diff</text>
  <text x="40" y="182" fill="#64748b">result</text>
  <!-- reconstructed result -->
  <g>
    <rect x="90"  y="162" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="118" y="189" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="150" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="178" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="210" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="238" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="270" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="298" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="330" y="162" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="358" y="189" text-anchor="middle" fill="#1e293b">0</text>
  </g>
  <text x="238" y="230" text-anchor="middle" fill="#059669" font-weight="700">+2 applied across [1..3] with just two edits</text>
</svg>
```

```text
update (1,3,+2)          ┌──── +2 applies here ────┐
index :   0      1      2      3      4
diff  :   0     +2      0      0     -2
                ↑                     ↑
            turn it on           turn it off
                                 (r+1 = 4)
running:  0      2      2      2      0
```

### Interview explanation
"All the updates arrive before any read, so I don't need the real array while updating. I'll keep a difference array where `diff[i]` is the change from `arr[i-1]` to `arr[i]`. Each range update `(l, r, v)` becomes two writes: `diff[l] += v` and `diff[r+1] -= v` — `r+1` because `r` is inclusive. After all updates, one prefix-sum sweep reconstructs the array. That's O(1) per update and O(n) once at the end, instead of O(m·n)."

---

## 5. Generic Templates

> Two writes per update, one sweep at the end. Size the array `n+1` so `r+1` is always a legal index.

```go
// DiffArray applies range updates in O(1) each and materialises in O(n).
type DiffArray struct {
    diff []int
}

func NewDiffArray(n int) *DiffArray {
    return &DiffArray{diff: make([]int, n+1)} // one extra slot for r+1
}

// Add adds v to every element in the inclusive range [l, r].
func (d *DiffArray) Add(l, r, v int) {
    d.diff[l] += v   // from l onwards, add v
    d.diff[r+1] -= v // from r+1 onwards, stop adding v
}

// Build reconstructs the final array with one prefix-sum sweep.
func (d *DiffArray) Build() []int {
    out := make([]int, len(d.diff)-1)
    running := 0
    for i := range out {
        running += d.diff[i]
        out[i] = running
    }
    return out
}
```

```python
class DiffArray:
    """Range updates in O(1) each, materialise in O(n)."""

    def __init__(self, n):
        self.diff = [0] * (n + 1)      # one extra slot for r+1

    def add(self, l, r, v):            # inclusive [l, r]
        self.diff[l] += v              # from l onwards, add v
        self.diff[r + 1] -= v          # from r+1 onwards, stop

    def build(self):
        out, running = [], 0
        for i in range(len(self.diff) - 1):
            running += self.diff[i]
            out.append(running)
        return out
```

```java
public class DiffArray {
    private final long[] diff;

    public DiffArray(int n) {
        diff = new long[n + 1];        // one extra slot for r+1
    }

    // Adds v to every element in the inclusive range [l, r].
    public void add(int l, int r, long v) {
        diff[l] += v;
        diff[r + 1] -= v;
    }

    public long[] build() {
        long[] out = new long[diff.length - 1];
        long running = 0;
        for (int i = 0; i < out.length; i++) {
            running += diff[i];
            out[i] = running;
        }
        return out;
    }
}
```

```cpp
#include <vector>
using namespace std;

class DiffArray {
    vector<long long> diff;

public:
    explicit DiffArray(int n) : diff(n + 1, 0) {}   // one extra slot for r+1

    // Adds v to every element in the inclusive range [l, r].
    void add(int l, int r, long long v) {
        diff[l] += v;
        diff[r + 1] -= v;
    }

    vector<long long> build() const {
        vector<long long> out(diff.size() - 1);
        long long running = 0;
        for (size_t i = 0; i < out.size(); ++i) {
            running += diff[i];
            out[i] = running;
        }
        return out;
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Difference Array (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> One pass to build, O(1) per query.

---

## 7. Common Mistakes

1. Off-by-one in prefix arrays (use size n+1 and 1-based prefix indices).
2. Rebuilding the auxiliary structure inside a loop instead of once.
3. Integer overflow on large sums — use 64-bit accumulators.
4. Forgetting that hashing has worst-case O(n) collisions (rare but real).
5. Choosing a map when a fixed-size array would be faster and O(1) space.
6. Mutating the input array when the caller still needs it.
7. Not handling empty input / single-element edge cases.
8. Confusing inclusive vs exclusive range boundaries.
9. Assuming hash-map iteration order is stable.
10. Ignoring negative numbers when reasoning about monotonic prefix sums.

---

## 8. Interview Follow-Up Questions

1. **Q: Why O(n) instead of O(n^2)?**
   A: Each element is touched a constant number of times; queries become O(1) reads.

2. **Q: Array vs hash map?**
   A: Array for small dense key domains; map for sparse/large/arbitrary keys.

3. **Q: How to make it O(1) extra space?**
   A: Sometimes you can accumulate on the fly without storing the whole prefix.

4. **Q: Handle updates between queries?**
   A: Switch to a Fenwick/Segment tree for O(log n) updates.

5. **Q: 2D version?**
   A: Use a 2D prefix-sum matrix; submatrix sum in O(1).

6. **Q: Streaming input?**
   A: Maintain running aggregates; use sketches for high cardinality.

7. **Q: Parallelize?**
   A: Counting/summing is associative — Map-Reduce by key.

8. **Q: Negative numbers break a technique?**
   A: Sliding-window-by-sum needs non-negativity; prefix+hashmap handles negatives.

9. **Q: Overflow risk?**
   A: Use wider integer types or modular arithmetic if required.

10. **Q: Memory pressure?**
   A: Compress keys or use approximate structures (Count-Min Sketch).

11. **Q: Detect duplicates fast?**
   A: A hash set gives O(1) membership.

12. **Q: Most frequent element?**
   A: Count then take the max value, or a heap for top-k.

13. **Q: Pivot/equilibrium index?**
   A: Compare left prefix to total minus prefix.

14. **Q: Why does prefix subtraction work?**
   A: Sums telescope: pre[r+1]-pre[l] = sum of [l..r].

15. **Q: Relation to difference arrays?**
   A: Difference array is the inverse: it supports range updates, prefix supports range queries.

---

## 9. Solved Example 1

### Problem — Corporate Flight Bookings (LeetCode 1109)
There are `n` flights labelled `1..n`. Each booking `[first, last, seats]` reserves `seats` on every flight from `first` to `last` inclusive. Return the total seats booked per flight.

### Thought Process
1. Every booking is a range update, and all bookings arrive before we report anything — the ideal difference-array setup.
2. Flights are **1-indexed** but our array is 0-indexed, so flight `f` lives at index `f−1`.
3. Booking `[first, last, seats]` therefore becomes `diff[first-1] += seats` and `diff[last] -= seats`.
   - The stop index is `(last−1)+1 = last`. The two `−1`s cancel, which is why this one looks asymmetric.
4. One prefix-sum sweep gives the per-flight totals.

### Dry Run

Input: `bookings = [[1,2,10], [2,3,20]]`, `n = 3` → `diff` has `n+1 = 4` slots, all zero.

| booking     | writes                              | diff after            |
|-------------|-------------------------------------|-----------------------|
| `[1,2,10]`  | `diff[0] += 10`, `diff[2] -= 10`    | `[10, 0, −10, 0]`     |
| `[2,3,20]`  | `diff[1] += 20`, `diff[3] -= 20`    | `[10, 20, −10, −20]`  |

**Sweep to rebuild:**

| flight | index | diff | running | answer |
|--------|-------|------|---------|--------|
| 1      | 0     | 10   | 10      | 10     |
| 2      | 1     | 20   | 30      | 30     |
| 3      | 2     | −10  | 20      | 20     |

Output: **`[10, 30, 20]`**

Sanity check: flight 2 is covered by both bookings → `10 + 20 = 30` ✓

### Visualization

```text
flight :    1      2      3
b1     : [-- 10 --]
b2     :        [-- 20 --]
         ────────────────────
total  :   10     30     20
```

### Code

```go
func corpFlightBookings(bookings [][]int, n int) []int {
    diff := make([]int, n+1)
    for _, b := range bookings {
        first, last, seats := b[0], b[1], b[2]
        diff[first-1] += seats // flight `first` is index first-1
        diff[last] -= seats    // stop after flight `last` (index last-1)
    }

    answer := make([]int, n)
    running := 0
    for i := 0; i < n; i++ {
        running += diff[i]
        answer[i] = running
    }
    return answer
}
```

```python
def corpFlightBookings(bookings, n):
    diff = [0] * (n + 1)
    for first, last, seats in bookings:
        diff[first - 1] += seats     # flight `first` is index first-1
        diff[last] -= seats          # stop after flight `last`
    answer, running = [], 0
    for i in range(n):
        running += diff[i]
        answer.append(running)
    return answer
```

### Complexity
Time O(n + m) for `m` bookings — O(1) per booking plus one sweep. Space O(n).

---

## 10. Solved Example 2

### Problem — Range Addition (LeetCode 370)
Start with an array of `length` zeros. Apply updates `[start, end, inc]`, each adding `inc` to the inclusive range. Return the final array.

### Thought Process
1. This is the difference array in its purest form — no index translation to worry about.
2. `diff[start] += inc` turns the increment on; `diff[end+1] -= inc` turns it off.
3. `end+1` can be `length`, which is why `diff` has `length+1` slots.
4. Sweep once at the end.

### Dry Run

Input: `length = 5`, `updates = [[1,3,2], [2,4,3]]` → `diff` has 6 slots.

| update    | writes                          | diff after                |
|-----------|---------------------------------|---------------------------|
| `[1,3,2]` | `diff[1] += 2`, `diff[4] -= 2`  | `[0, 2, 0, 0, −2, 0]`     |
| `[2,4,3]` | `diff[2] += 3`, `diff[5] -= 3`  | `[0, 2, 3, 0, −2, −3]`    |

**Sweep to rebuild** (only indices 0..4 are read):

| i       | 0 | 1 | 2 | 3 | 4 |
|---------|---|---|---|---|---|
| diff[i] | 0 | 2 | 3 | 0 | −2|
| running | 0 | 2 | 5 | 5 | 3 |

Output: **`[0, 2, 5, 5, 3]`**

Sanity check: index 2 and 3 are inside both ranges → `2 + 3 = 5` ✓. Index 4 is only in the second → `3` ✓. The `−3` in slot 5 is never read; it exists only so `end+1 = 5` is a legal write.

### Visualization

```text
index  :   0     1     2     3     4
u1     :        [--- +2 ---]
u2     :              [------ +3 ------]
         ──────────────────────────────
result :   0     2     5     5     3
```

### Code

```go
func getModifiedArray(length int, updates [][]int) []int {
    diff := make([]int, length+1) // slot `length` absorbs end+1 writes
    for _, u := range updates {
        start, end, inc := u[0], u[1], u[2]
        diff[start] += inc
        diff[end+1] -= inc
    }

    answer := make([]int, length)
    running := 0
    for i := 0; i < length; i++ {
        running += diff[i]
        answer[i] = running
    }
    return answer
}
```

```python
def getModifiedArray(length, updates):
    diff = [0] * (length + 1)        # slot `length` absorbs end+1 writes
    for start, end, inc in updates:
        diff[start] += inc
        diff[end + 1] -= inc
    answer, running = [], 0
    for i in range(length):
        running += diff[i]
        answer.append(running)
    return answer
```

### Complexity
Time O(length + m), Space O(length).

---

## 11. Solved Example 3

### Problem — Car Pooling (LeetCode 1094)
A car has `capacity` seats and only drives forward. Each trip `[numPassengers, from, to]` means those passengers board at `from` and get off at `to`. Return `true` if every trip fits.

### Thought Process
1. Occupancy over a location range is a range update — difference array again.
2. **Key difference from the previous two problems:** passengers get off *at* `to`, so the range is **half-open** `[from, to)`. Location `to` is already free.
3. That means the stop write is `diff[to] -= num`, with **no `+1`**. Getting this right is the whole problem.
4. Sweep locations in increasing order tracking occupancy; if it ever exceeds `capacity`, return `false`.
5. Constraints cap locations at 1000, so a fixed 1001-slot array is enough.

### Dry Run

Input: `trips = [[2,1,5], [3,3,7]]`, `capacity = 4`

| trip      | writes                        |
|-----------|-------------------------------|
| `[2,1,5]` | `diff[1] += 2`, `diff[5] -= 2` |
| `[3,3,7]` | `diff[3] += 3`, `diff[7] -= 3` |

**Sweep by location:**

| location | diff | occupancy | ≤ capacity 4? |
|----------|------|-----------|---------------|
| 0        | 0    | 0         | yes           |
| 1        | +2   | 2         | yes           |
| 2        | 0    | 2         | yes           |
| 3        | +3   | **5**     | **no → false**|

Output: **`false`**

Now raise the capacity to 5: the sweep continues — location 5 drops to `5−2 = 3`, location 7 drops to `0`, never exceeding 5 → **`true`**. Note that at location 5 the first group leaves *before* anyone would board there; that is exactly what the half-open range encodes.

### Visualization

```text
location:  1   2   3   4   5   6   7
trip1   : [--- 2 passengers ---)          (off at 5)
trip2   :         [--- 3 passengers ---)  (off at 7)
          ─────────────────────────────
occupied:  2   2   5   5   3   3   0
                   ↑
              5 > capacity 4  →  false
```

### Code

```go
func carPooling(trips [][]int, capacity int) bool {
    const maxLocation = 1001
    diff := make([]int, maxLocation+1)

    for _, t := range trips {
        num, from, to := t[0], t[1], t[2]
        diff[from] += num // board here
        diff[to] -= num   // get off here: the range is half-open [from, to)
    }

    occupancy := 0
    for _, d := range diff {
        occupancy += d
        if occupancy > capacity {
            return false
        }
    }
    return true
}
```

```python
def carPooling(trips, capacity):
    diff = [0] * 1002                # locations 0..1000, plus slack
    for num, start, end in trips:
        diff[start] += num           # board here
        diff[end] -= num             # get off here: range is half-open
    occupancy = 0
    for d in diff:
        occupancy += d
        if occupancy > capacity:
            return False
    return True
```

### Complexity
Time O(m + maxLocation), Space O(maxLocation). If locations were unbounded you'd sort the boarding/alighting events instead — that is the Sweep Line pattern.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1109 | Corporate Flight | Easy | Core foundations application |
| 370 | Range Addition | Easy | Core foundations application |
| 1094 | Car Pooling | Medium | Core foundations application |
| 1854 | Max Population | Medium | Core foundations application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Hash-map counting**
- **1D / 2D prefix sums**
- **Difference arrays (inverse)**
- **Prefix + hashmap for subarray sums**
- **Custom-comparator sorting**

---

## 14. Production Engineering Applications

- **Scalability:** Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Difference Array logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Difference Array (Foundations).
- **Signal:** difference, range update, increment range, imos, interval add.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Difference Array invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Difference Array
FAMILY : Foundations (Beginner)
WHEN   : difference, range update, increment range, imos, interval add
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 1109, 370, 1094, 1854
```

---

*Part of the DSA Patterns Handbook — pattern 04 of 100.*
