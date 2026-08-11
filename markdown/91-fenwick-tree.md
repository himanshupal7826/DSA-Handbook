# 91 · Fenwick Tree

> **One-liner:** Binary Indexed Tree: compact O(log n) prefix sums with updates.

---

## 1. Overview

### Definition
The **Fenwick Tree** pattern belongs to the *Advanced* family. Binary Indexed Tree: compact O(log n) prefix sums with updates.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
fenwick, binary indexed tree, bit, prefix sum, point update.

### Constraints
- Input size where the brute-force complexity would time out — the Fenwick Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Fenwick Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Fenwick Tree is the upgrade.
- The wording maps onto: fenwick, binary indexed tree, bit, prefix sum, point update.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Give me a range sum — on an array that keeps changing."*

### Intuition
Recompute the sum whenever it is asked for.

### Algorithm
1. `update(i, value)`: write `nums[i] = value`. O(1).
2. `rangeSum(l, r)`: loop from `l` to `r`, adding. O(n).

### Complexity
- Update: O(1). Query: **O(n)**. Over `q` operations, **O(q · n)**.
- Space: O(n).

### Drawbacks
- A prefix-sum array flips the trade-off — O(1) queries, but every update invalidates the whole suffix, so updates become O(n). Either way one operation is linear.

```text
plain array   :  update O(1)      query O(n)
prefix sums   :  update O(n)      query O(1)
                 ↑ we want BOTH to be fast
```

- The problem is granularity. A plain array stores each element alone (nothing shared, so queries must re-add everything); a prefix array stores one running total per position (everything shared, so any change ripples everywhere). Neither balances the two.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Store partial sums over *blocks whose sizes are powers of two*, so any prefix is the sum of a handful of blocks and any element belongs to only a handful of blocks.**

That single structure makes **both** operations O(log n), because a number's binary representation has at most `log n` one-bits.

### The thought process

```text
We need    : fast range sums AND fast updates.
Obvious way: plain array (slow query) or prefix sums (slow update).
Stuck      : each stores at the wrong granularity.
Notice     : any prefix length can be written as a sum of powers of two —
             that is just its binary representation.
Therefore  : keep one partial sum per power-of-two block. A prefix is
             then a handful of blocks, and an element sits in a handful.
Now        : both operations are O(log n).
```

### What each node covers

The Fenwick tree (or Binary Indexed Tree) is a **1-indexed** array where:

```text
tree[i] = the sum of the `lowbit(i)` elements ending at position i
        = sum of nums[i - lowbit(i) + 1 .. i]

lowbit(i) = i & -i     ← the lowest set bit of i
```

For `n = 8`:

| i | binary | lowbit | covers |
|---|--------|--------|--------|
| 1 | `0001` | 1 | `[1..1]` |
| 2 | `0010` | 2 | `[1..2]` |
| 3 | `0011` | 1 | `[3..3]` |
| 4 | `0100` | 4 | `[1..4]` |
| 5 | `0101` | 1 | `[5..5]` |
| 6 | `0110` | 2 | `[5..6]` |
| 7 | `0111` | 1 | `[7..7]` |
| 8 | `1000` | 8 | `[1..8]` |

Ranges of length 1, 2, 4, 8 — every power of two, and every position covered exactly once at each level.

### Why `i & -i` is the lowest set bit

Two's complement negation is "flip every bit, then add 1". The flip turns the lowest set bit's trailing zeros into ones; adding 1 carries through them and stops exactly at that bit:

```text
i    = 0110 1000        (104)
~i   = 1001 0111
-i   = 1001 1000        (~i + 1)
i&-i = 0000 1000        (8)  ← only the lowest set bit survives
```

Everything above the lowest set bit differs between `i` and `−i`, so those positions AND to zero; everything below is zero in both.

### The two traversals, and why they go opposite ways

**Query (prefix sum up to `i`): strip bits off, moving down.**

```text
for ; i > 0; i -= i & -i {  sum += tree[i]  }
```

`tree[i]` covers a block ending at `i`; removing the lowest set bit jumps to the position just before that block starts. Each step clears one bit, so at most `log n` steps.

```text
query(7):  7 = 0111  →  tree[7] covers [7..7],  7-1 = 6
           6 = 0110  →  tree[6] covers [5..6],  6-2 = 4
           4 = 0100  →  tree[4] covers [1..4],  4-4 = 0  stop
           total = [7..7] + [5..6] + [1..4] = [1..7]   ✓
```

**Update (add `delta` at `i`): add the lowest bit, moving up.**

```text
for ; i <= n; i += i & -i {  tree[i] += delta  }
```

Every node whose block *contains* `i` must be corrected, and adding the lowest set bit is exactly how you reach the next such node.

```text
update(3):  3 = 0011  →  tree[3],  3+1 = 4
            4 = 0100  →  tree[4],  4+4 = 8
            8 = 1000  →  tree[8],  8+8 = 16 > n  stop
            blocks [3..3], [1..4], [1..8] all contain index 3   ✓
```

The two loops move in opposite directions because one *decomposes* a prefix while the other *repairs* every enclosing block.

### One-indexing is not optional

`lowbit(0) = 0`, so an update at index 0 would loop forever and a query would never terminate. **Store the array 1-indexed** and translate at the boundary. This is the single most common Fenwick bug.

### Range queries and the counting trick

```text
rangeSum(l, r) = prefix(r) - prefix(l - 1)
```

Beyond sums, the real power is **counting**: index the tree by *value* rather than position, and `prefix(v)` becomes "how many values ≤ v have I inserted". That converts a whole family of "count inversions / smaller elements to the right" problems into a sweep — which is what Examples 2 and 3 are about.

Values are usually huge or negative, so first **coordinate-compress**: sort the distinct values and use each one's rank as the index.

### Fenwick or segment tree?

| | Fenwick | Segment tree |
|---|---|---|
| Code size | ~10 lines | ~40 lines |
| Constant factor | **smaller** | larger |
| Prefix-decomposable ops (sum, xor, count) | **yes** | yes |
| Range **min/max**, range assignment, lazy propagation | **no** | **yes** |

Fenwick needs the operation to be *invertible* (so `prefix(r) − prefix(l−1)` works). Sums qualify; minima do not. Reach for Fenwick when sums or counts suffice — it is far quicker to write correctly.

### Steps

```text
Query — prefix sum of 1..i (walk DOWN, stripping the lowest set bit):
  Step 1 → sum = 0
  Step 2 → while i > 0:  sum += tree[i];  i -= i & -i
  Step 3 → return sum

Update — add delta at position i (walk UP, adding the lowest set bit):
  Step 4 → while i <= n:  tree[i] += delta;  i += i & -i

Range — sum of l..r:
  Step 5 → prefix(r) - prefix(l - 1)     (needs an INVERTIBLE operation)

Counting — index the tree by VALUE, not position:
  Step 6 → coordinate-compress the values to dense 1-based ranks
  Step 7 → prefix(rank) then answers "how many values so far are <= this"
```

### How should I recognize this?

```text
If you see...
  "range sum" plus "update an element", interleaved
  "count smaller elements to the right", "count inversions"
  "how many values so far are less than X"
        ↓
Think about...
  "Do I need both updates and prefix queries to be fast?"
  "Am I counting, rather than summing? → index by VALUE, not position"
        ↓
Use...
  Fenwick tree, 1-indexed
  query: i -= i & -i     update: i += i & -i
  counting → coordinate-compress the values first
  need range min/max or lazy updates → segment tree instead
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="fw-91" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">query(7): jump i -= i &amp; (-i) ──▶ 7 → 6 → 4 → 0</text>
  <!-- BIT index cells 1..8 -->
  <g>
    <rect x="40"  y="60" width="60" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="70"  y="87" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="110" y="60" width="60" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="140" y="87" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="180" y="60" width="60" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="210" y="87" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="250" y="60" width="60" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="280" y="87" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="320" y="60" width="60" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="350" y="87" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="390" y="60" width="60" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="420" y="87" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="460" y="60" width="60" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="490" y="87" text-anchor="middle" fill="#1e293b">7</text>
    <rect x="530" y="60" width="60" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="560" y="87" text-anchor="middle" fill="#1e293b">8</text>
  </g>
  <!-- coverage widths under each tree node -->
  <text x="490" y="124" text-anchor="middle" fill="#64748b">tree[7] covers [7]</text>
  <text x="420" y="124" text-anchor="middle" fill="#64748b">tree[6] covers [5,6]</text>
  <text x="280" y="124" text-anchor="middle" fill="#64748b">tree[4] covers [1,4]</text>
  <!-- jump arrows 7 -> 6 -> 4 -->
  <path d="M480,52 C455,30 440,30 420,52" fill="none" stroke="#475569" marker-end="url(#fw-91)"/>
  <path d="M410,52 C360,20 320,20 280,52" fill="none" stroke="#475569" marker-end="url(#fw-91)"/>
  <text x="320" y="176" text-anchor="middle" fill="#059669" font-weight="700">prefixSum[1..7] = tree[7] + tree[6] + tree[4]  (3 steps, not 7)</text>
  <text x="320" y="198" text-anchor="middle" fill="#64748b">i &amp; (-i) isolates the lowest set bit ──▶ the block each index owns</text>
</svg>
```

```text
nums (1-indexed):  1   2   3   4   5   6   7   8

tree[8] ────────── covers [1..8] ──────────────────────
tree[4] ── covers [1..4] ────
tree[2] covers [1..2]        tree[6] covers [5..6]
tree[1]  tree[3]  tree[5]  tree[7]     (single elements)

query(7) = tree[7] + tree[6] + tree[4]
         =  [7..7] +  [5..6] +  [1..4]   = [1..7]

update(3) touches tree[3], tree[4], tree[8]
         — exactly the blocks containing index 3
```

### Interview explanation
"I'll use a Fenwick tree. The idea is to store partial sums over blocks whose lengths are powers of two: `tree[i]` holds the sum of the `i & -i` elements ending at `i`. Because any prefix length is a sum of powers of two — literally its binary representation — a prefix query decomposes into at most `log n` blocks, and I walk them by repeatedly stripping the lowest set bit. An update walks the other way, adding the lowest set bit to reach each enclosing block, which is also at most `log n` steps. So both operations are O(log n) with a very small constant. It must be 1-indexed, because `lowbit(0)` is zero and the loops would never terminate. The trick that makes it more than a sum structure is indexing by *value* instead of position after coordinate compression — then a prefix query counts how many values so far are below a threshold, which is what turns 'count smaller elements to the right' into a single sweep."

---

## 5. Generic Templates

> 1-indexed. Query strips the lowest bit; update adds it.

```go
// FenwickTree supports point updates and prefix sums, both in O(log n).
// It is 1-INDEXED: lowbit(0) is 0, so index 0 would loop forever.
type FenwickTree struct {
    tree []int
    size int
}

func NewFenwickTree(n int) *FenwickTree {
    return &FenwickTree{tree: make([]int, n+1), size: n}
}

// Add adds delta at 1-indexed position i, repairing every block that
// contains i by walking UP: i += i & -i.
func (f *FenwickTree) Add(i, delta int) {
    for ; i <= f.size; i += i & (-i) {
        f.tree[i] += delta
    }
}

// Prefix returns the sum of positions 1..i by decomposing the prefix into
// power-of-two blocks, walking DOWN: i -= i & -i.
func (f *FenwickTree) Prefix(i int) int {
    sum := 0
    for ; i > 0; i -= i & (-i) {
        sum += f.tree[i]
    }
    return sum
}

// RangeSum returns the sum of positions l..r, inclusive and 1-indexed.
// This works only because addition is invertible — which is exactly why
// a Fenwick tree cannot do range min or max.
func (f *FenwickTree) RangeSum(l, r int) int {
    return f.Prefix(r) - f.Prefix(l-1)
}

// CompressValues maps arbitrary values to dense 1-based ranks, which is
// what lets the tree be indexed by VALUE for counting problems.
func CompressValues(values []int) map[int]int {
    sorted := append([]int(nil), values...)
    sort.Ints(sorted)

    rank := make(map[int]int, len(sorted))
    next := 1
    for _, v := range sorted {
        if _, seen := rank[v]; !seen {
            rank[v] = next
            next++
        }
    }
    return rank
}
```

```python
class FenwickTree:
    """Point updates and prefix sums in O(log n). 1-INDEXED, because
    lowbit(0) == 0 would make the loops never terminate."""

    def __init__(self, n):
        self.tree = [0] * (n + 1)
        self.size = n

    def add(self, i, delta):
        """Repair every block containing i by walking UP."""
        while i <= self.size:
            self.tree[i] += delta
            i += i & (-i)

    def prefix(self, i):
        """Decompose 1..i into power-of-two blocks, walking DOWN."""
        total = 0
        while i > 0:
            total += self.tree[i]
            i -= i & (-i)
        return total

    def range_sum(self, l, r):
        """Works only because addition is invertible — hence no range min."""
        return self.prefix(r) - self.prefix(l - 1)

def compress_values(values):
    """Map arbitrary values to dense 1-based ranks for value-indexed counting."""
    return {v: i + 1 for i, v in enumerate(sorted(set(values)))}
```

```java
public class FenwickTree {
    private final long[] tree;
    private final int size;

    // 1-INDEXED: lowbit(0) == 0 would loop forever.
    public FenwickTree(int n) {
        tree = new long[n + 1];
        size = n;
    }

    // Walk UP, repairing every block that contains i.
    public void add(int i, long delta) {
        for (; i <= size; i += i & (-i)) tree[i] += delta;
    }

    // Walk DOWN, decomposing the prefix into power-of-two blocks.
    public long prefix(int i) {
        long sum = 0;
        for (; i > 0; i -= i & (-i)) sum += tree[i];
        return sum;
    }

    // Requires an invertible operation — which is why range min is impossible.
    public long rangeSum(int l, int r) {
        return prefix(r) - prefix(l - 1);
    }
}
```

```cpp
#include <vector>
using namespace std;

// 1-INDEXED: lowbit(0) == 0 would loop forever.
class FenwickTree {
    vector<long long> tree;
    int size;

public:
    explicit FenwickTree(int n) : tree(n + 1, 0), size(n) {}

    // Walk UP, repairing every block containing i.
    void add(int i, long long delta) {
        for (; i <= size; i += i & (-i)) tree[i] += delta;
    }

    // Walk DOWN, decomposing the prefix into power-of-two blocks.
    long long prefix(int i) const {
        long long sum = 0;
        for (; i > 0; i -= i & (-i)) sum += tree[i];
        return sum;
    }

    // Needs an invertible operation — hence no range min/max.
    long long rangeSum(int l, int r) const { return prefix(r) - prefix(l - 1); }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Fenwick Tree (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **Varies (often O(log n) per op)** |
| Time (best)  | — | **Varies (often O(log n) per op)** |
| Time (average) | — | **Varies (often O(log n) per op)** |
| Space | varies | **O(n) to O(n log n)** |

> Build cost amortized over many fast queries/updates.

---

## 7. Common Mistakes

1. Mixing 0-indexed and 1-indexed conventions (Fenwick is 1-indexed).
2. Segment tree: wrong recursion bounds or lazy-propagation push-down.
3. Trie: not marking end-of-word, or leaking memory on delete.
4. Sparse table on a non-idempotent operation (sums need a different trick).
5. Bitmask DP exceeding memory for n > ~22.
6. Meet-in-the-middle: incorrect merge of the two halves.
7. Euler tour: off-by-one in in/out times.
8. Network flow: forgetting residual/back edges.
9. SCC/Tarjan: mishandling the low-link update and stack.
10. Mo's algorithm: wrong block size or add/remove ordering.

---

## 8. Interview Follow-Up Questions

1. **Q: Fenwick vs segment tree?**
   A: Fenwick is smaller/faster for prefix sums; segment tree is more general (min/max, lazy ranges).

2. **Q: Range update + range query?**
   A: Segment tree with lazy propagation, or two Fenwicks.

3. **Q: Trie use cases?**
   A: Prefix search, autocomplete, word dictionaries, XOR-maximization.

4. **Q: Sparse table limits?**
   A: O(1) queries but only static, idempotent operations (min/max/gcd).

5. **Q: Bitmask DP feasibility?**
   A: n ≲ 20–22 because of 2^n states.

6. **Q: Meet-in-the-middle when?**
   A: n ≲ 40 subset problems: split into 2^(n/2).

7. **Q: Euler tour purpose?**
   A: Flatten a tree so subtrees are contiguous ranges.

8. **Q: Heavy-light decomposition?**
   A: Path queries on trees via O(log n) chains + segment tree.

9. **Q: Max flow = min cut?**
   A: By the max-flow min-cut theorem; models matching/assignment.

10. **Q: SCC algorithms?**
   A: Tarjan (one DFS) or Kosaraju (two passes).

11. **Q: Bridges / articulation points?**
   A: Tarjan's low-link values in one DFS.

12. **Q: Mo's algorithm complexity?**
   A: O((n+q)√n) for offline range queries.

13. **Q: When is the build cost worth it?**
   A: When many queries/updates amortize the O(n log n) build.

14. **Q: Persistence?**
   A: Persistent segment trees answer historical-version queries.

15. **Q: Coordinate compression?**
   A: Map large/sparse keys to a dense index range first.

---

## 9. Solved Example 1

### Problem — Range Sum Query, Mutable (LeetCode 307)
Support `update(index, value)` and `sumRange(left, right)` on an array, interleaved arbitrarily.

### Thought Process
1. A plain array gives O(1) updates but O(n) queries; a prefix array gives the reverse. We need both fast.
2. A Fenwick tree gives O(log n) for each by storing partial sums over power-of-two blocks.
3. `update` takes a **new value**, not a delta — so compute `delta = value − current` and keep a copy of the raw array to know `current`.
4. Translate to 1-indexed at the boundary: LeetCode's index `i` becomes tree position `i + 1`.
5. `sumRange(l, r) = prefix(r+1) − prefix(l)` after that shift.

### Dry Run

Input: `nums = [1, 3, 5]`, then `sumRange(0, 2)`, `update(1, 2)`, `sumRange(0, 2)`

**Build** (1-indexed positions 1, 2, 3):

| position | binary | lowbit | covers | value |
|----------|--------|--------|--------|-------|
| 1 | `001` | 1 | `[1..1]` | `1` |
| 2 | `010` | 2 | `[1..2]` | `1 + 3 = 4` |
| 3 | `011` | 1 | `[3..3]` | `5` |

**`sumRange(0, 2)`** → `prefix(3) − prefix(0)`:

```text
prefix(3):  3 = 011  → tree[3] = 5,   3 - 1 = 2
            2 = 010  → tree[2] = 4,   2 - 2 = 0  stop
            total = 9
```

Output: **9** ✓ (`1 + 3 + 5`)

**`update(1, 2)`** — position `2`, old value `3`, so `delta = 2 − 3 = −1`:

```text
2 = 010  → tree[2] += -1  → 3,   2 + 2 = 4 > 3  stop
```

| position | value after |
|----------|-------------|
| 1 | 1 |
| 2 | **3** |
| 3 | 5 |

**`sumRange(0, 2)`** again:

```text
prefix(3):  tree[3] = 5,  then tree[2] = 3  →  total = 8
```

Output: **8** ✓ (`1 + 2 + 5`)

Note the update touched only **one** node here. Index 2's enclosing blocks are `[1..2]` and then position 4, which is past the end — that is the `log n` bound in action.

### Visualization

```text
nums (1-indexed):   1     3     5
                    1     2     3

tree[2] covers [1..2] = 4
tree[1] = 1        tree[3] = 5

prefix(3) = tree[3] + tree[2] = 5 + 4 = 9

update position 2 by -1:
    tree[2] → 3          (4 + 8 = 12 > n, so we stop)
prefix(3) = 5 + 3 = 8
```

### Code

```go
type NumArray struct {
    tree []int // 1-indexed Fenwick tree
    nums []int // the raw values, so update() can compute a delta
    size int
}

func Constructor(nums []int) NumArray {
    n := len(nums)
    array := NumArray{
        tree: make([]int, n+1),
        nums: make([]int, n),
        size: n,
    }
    for i, v := range nums {
        array.nums[i] = v
        array.add(i+1, v) // shift to 1-indexed
    }
    return array
}

// add walks UP, repairing every block that contains position i.
func (a *NumArray) add(i, delta int) {
    for ; i <= a.size; i += i & (-i) {
        a.tree[i] += delta
    }
}

// prefix walks DOWN, decomposing 1..i into power-of-two blocks.
func (a *NumArray) prefix(i int) int {
    sum := 0
    for ; i > 0; i -= i & (-i) {
        sum += a.tree[i]
    }
    return sum
}

func (a *NumArray) Update(index int, val int) {
    // The tree stores sums, so it needs the DELTA, not the new value.
    delta := val - a.nums[index]
    a.nums[index] = val
    a.add(index+1, delta)
}

func (a *NumArray) SumRange(left int, right int) int {
    // 0-indexed [left, right] → 1-indexed prefix(right+1) - prefix(left).
    return a.prefix(right+1) - a.prefix(left)
}
```

```python
class NumArray:
    def __init__(self, nums):
        self.size = len(nums)
        self.tree = [0] * (self.size + 1)    # 1-indexed
        self.nums = list(nums)               # so update() can compute a delta
        for i, v in enumerate(nums):
            self._add(i + 1, v)

    def _add(self, i, delta):
        """Walk UP, repairing every block containing i."""
        while i <= self.size:
            self.tree[i] += delta
            i += i & (-i)

    def _prefix(self, i):
        """Walk DOWN, decomposing 1..i into power-of-two blocks."""
        total = 0
        while i > 0:
            total += self.tree[i]
            i -= i & (-i)
        return total

    def update(self, index, val):
        delta = val - self.nums[index]       # the tree needs a DELTA
        self.nums[index] = val
        self._add(index + 1, delta)

    def sumRange(self, left, right):
        return self._prefix(right + 1) - self._prefix(left)
```

### Complexity
Build **O(n log n)** (or O(n) with an in-place trick). `update` and `sumRange` are **O(log n)** each. Space O(n).

---

## 10. Solved Example 2

### Problem — Count of Smaller Numbers After Self (LeetCode 315)
For each `nums[i]`, count how many elements to its **right** are strictly smaller. Return those counts.

### Thought Process
1. The brute force is O(n²). The Fenwick insight is to index the tree by **value** rather than position.
2. Then `prefix(v)` answers "how many values ≤ `v` have I inserted so far".
3. Sweep **right to left**. At each element, everything already inserted lies to its right — so query first, then insert.
4. Values can be large or negative, so **coordinate-compress**: replace each value by its 1-based rank among the sorted distinct values.
5. For *strictly* smaller, query `prefix(rank − 1)`.

### Dry Run

Input: `nums = [5, 2, 6, 1]`

**Compression** — sorted distinct values `[1, 2, 5, 6]`:

| value | 1 | 2 | 5 | 6 |
|-------|---|---|---|---|
| rank  | 1 | 2 | 3 | 4 |

**Sweep right to left** (tree starts empty):

| i | value | rank | query `prefix(rank−1)` | meaning | result | then insert |
|---|-------|------|-------------------------|---------|--------|-------------|
| 3 | `1` | 1 | `prefix(0)` = **0** | nothing smaller to the right | **0** | rank 1 |
| 2 | `6` | 4 | `prefix(3)` = **1** | only the `1` is smaller | **1** | rank 4 |
| 1 | `2` | 2 | `prefix(1)` = **1** | only the `1` is smaller | **1** | rank 2 |
| 0 | `5` | 3 | `prefix(2)` = **2** | the `1` and the `2` | **2** | rank 3 |

Reversing the collected results gives **`[2, 1, 1, 0]`** ✓

Check by hand: after `5` come `{2, 6, 1}` → two smaller; after `2` come `{6, 1}` → one; after `6` comes `{1}` → one; after `1` nothing → zero. ✓

**Why query before insert.** At `i = 2` (value `6`) the tree holds only rank 1, inserted at `i = 3`. Inserting `6` first would let it count itself — `prefix(3)` would still be 1 here, but on a duplicate value it would be wrong. Query-then-insert keeps "already inserted" exactly synonymous with "strictly to the right".

### Visualization

```text
nums:    5    2    6    1
                        ↑ sweep starts here, moving LEFT

value-indexed tree (ranks 1..4 for values 1, 2, 5, 6):

  insert 1        tree counts {1}
  6 → prefix(3) = 1        (values 1,2,5 seen: just the 1)
  insert 6        tree counts {1, 6}
  2 → prefix(1) = 1        (value 1 seen)
  insert 2        tree counts {1, 2, 6}
  5 → prefix(2) = 2        (values 1 and 2 seen)

results reversed:  [2, 1, 1, 0]
```

### Code

```go
func countSmaller(nums []int) []int {
    n := len(nums)
    if n == 0 {
        return []int{}
    }

    // Coordinate-compress: values may be huge or negative, but the tree
    // must be indexed by a dense 1-based range.
    sorted := append([]int(nil), nums...)
    sort.Ints(sorted)

    rank := make(map[int]int, n)
    next := 1
    for _, v := range sorted {
        if _, seen := rank[v]; !seen {
            rank[v] = next
            next++
        }
    }
    distinct := next - 1

    tree := make([]int, distinct+1)

    add := func(i int) {
        for ; i <= distinct; i += i & (-i) {
            tree[i]++
        }
    }
    prefix := func(i int) int {
        count := 0
        for ; i > 0; i -= i & (-i) {
            count += tree[i]
        }
        return count
    }

    result := make([]int, n)
    // Right to left: everything already inserted is to the right of i.
    for i := n - 1; i >= 0; i-- {
        r := rank[nums[i]]
        // prefix(r-1) counts values STRICTLY smaller. Query BEFORE
        // inserting, so an equal value never counts itself.
        result[i] = prefix(r - 1)
        add(r)
    }
    return result
}
```

```python
def countSmaller(nums):
    n = len(nums)
    if n == 0:
        return []

    # Coordinate-compress to dense 1-based ranks.
    rank = {v: i + 1 for i, v in enumerate(sorted(set(nums)))}
    distinct = len(rank)
    tree = [0] * (distinct + 1)

    def add(i):
        while i <= distinct:
            tree[i] += 1
            i += i & (-i)

    def prefix(i):
        count = 0
        while i > 0:
            count += tree[i]
            i -= i & (-i)
        return count

    result = [0] * n
    # Right to left: everything inserted so far lies to the right.
    for i in range(n - 1, -1, -1):
        r = rank[nums[i]]
        result[i] = prefix(r - 1)   # strictly smaller; query BEFORE inserting
        add(r)
    return result
```

### Complexity
Time **O(n log n)** — one Fenwick query and one update per element. Space O(n).

---

## 11. Solved Example 3

### Problem — Reverse Pairs (LeetCode 493)
Count the pairs `(i, j)` with `i < j` and `nums[i] > 2 · nums[j]`.

### Thought Process
1. Same value-indexed sweep, but the threshold is now `2 · nums[j]` rather than `nums[j]` itself.
2. Sweep **left to right**. At each `j`, everything already inserted has index `i < j` — exactly the pairs we may count.
3. We want how many inserted values are **greater than** `2 · nums[j]`. A Fenwick tree gives prefixes, so take the complement:

```text
count = (how many inserted) − prefix(rank of the last value ≤ 2·nums[j])
```

4. The compression must include the values *and* the doubled thresholds, since a threshold may fall between two real values.
5. Use 64-bit arithmetic for `2 · nums[j]` — doubling a large negative or positive `int32` overflows.

### Dry Run

Input: `nums = [1, 3, 2, 3, 1]`

Distinct values `{1, 2, 3}` and thresholds `2·nums[j]` ∈ `{2, 6, 4}`. Compressed universe, sorted: `[1, 2, 3, 4, 6]` with ranks `1..5`.

**Sweep left to right:**

| j | `nums[j]` | threshold `2·nums[j]` | inserted so far | how many `> threshold` | running total | then insert |
|---|-----------|------------------------|------------------|-------------------------|---------------|-------------|
| 0 | `1` | 2 | {} | 0 | 0 | `1` |
| 1 | `3` | 6 | {1} | none `> 6` → **0** | 0 | `3` |
| 2 | `2` | 4 | {1, 3} | none `> 4` → **0** | 0 | `2` |
| 3 | `3` | 6 | {1, 3, 2} | none `> 6` → **0** | 0 | `3` |
| 4 | `1` | 2 | {1, 3, 2, 3} | `3` and `3` → **2** | **2** | `1` |

Output: **2** ✓

The two reverse pairs are `(1, 4)` — `nums[1] = 3 > 2·1 = 2` — and `(3, 4)` — `nums[3] = 3 > 2`. ✓

Note `nums[2] = 2` is **not** counted against `nums[4] = 1`, because `2 > 2·1 = 2` is false. Strictness matters, and it is why the query uses "count of values `≤ threshold`" and subtracts.

**A second case**, `nums = [2, 4, 3, 5, 1]`: at `j = 4` (value `1`, threshold `2`), the inserted values are `{2, 4, 3, 5}`, of which `4`, `3` and `5` exceed 2 → **3**. Every earlier `j` contributes 0. Output **3** ✓

### Visualization

```text
nums:  1    3    2    3    1
                            ↑ j = 4, threshold = 2*1 = 2

inserted so far: {1, 3, 2, 3}

  values <= 2 :  {1, 2}        → prefix = 2
  total inserted              → 4
  values > 2  :  4 - 2         = 2      ★

  the tree gives PREFIXES, so "greater than" is answered
  by subtracting from the total
```

### Code

```go
func reversePairs(nums []int) int {
    n := len(nums)
    if n < 2 {
        return 0
    }

    // The universe must contain both the values and the doubled
    // thresholds, since a threshold can fall between two real values.
    universe := make([]int, 0, 2*n)
    for _, v := range nums {
        universe = append(universe, v)
        universe = append(universe, 2*v) // int is 64-bit here, so this is safe
    }
    sort.Ints(universe)

    rank := make(map[int]int, len(universe))
    next := 1
    for _, v := range universe {
        if _, seen := rank[v]; !seen {
            rank[v] = next
            next++
        }
    }
    distinct := next - 1

    tree := make([]int, distinct+1)
    add := func(i int) {
        for ; i <= distinct; i += i & (-i) {
            tree[i]++
        }
    }
    prefix := func(i int) int {
        count := 0
        for ; i > 0; i -= i & (-i) {
            count += tree[i]
        }
        return count
    }

    total := 0
    inserted := 0

    // Left to right: everything inserted has index i < j.
    for j := 0; j < n; j++ {
        threshold := 2 * nums[j]

        // The tree answers prefixes, so count "> threshold" as
        // (everything inserted) - (those <= threshold).
        total += inserted - prefix(rank[threshold])

        add(rank[nums[j]])
        inserted++
    }
    return total
}
```

```python
def reversePairs(nums):
    n = len(nums)
    if n < 2:
        return 0

    # The universe needs the values AND the doubled thresholds.
    universe = sorted(set(nums) | {2 * v for v in nums})
    rank = {v: i + 1 for i, v in enumerate(universe)}
    distinct = len(universe)

    tree = [0] * (distinct + 1)

    def add(i):
        while i <= distinct:
            tree[i] += 1
            i += i & (-i)

    def prefix(i):
        count = 0
        while i > 0:
            count += tree[i]
            i -= i & (-i)
        return count

    total = inserted = 0
    # Left to right: everything inserted has index i < j.
    for value in nums:
        threshold = 2 * value
        # "> threshold" = everything inserted minus those <= threshold.
        total += inserted - prefix(rank[threshold])
        add(rank[value])
        inserted += 1

    return total
```

### Complexity
Time **O(n log n)** — sorting the universe plus one query and one update per element. Space O(n).

> Both counting examples share one move: the tree is indexed by **value**, so a prefix query answers "how many so far are below this threshold". Once that clicks, inversion counting, "smaller to the right", and reverse pairs stop being three problems and become one sweep with three different thresholds.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 307 | Range Sum Mutable | Easy | Core advanced application |
| 315 | Count Smaller | Easy | Core advanced application |
| 493 | Reverse Pairs | Medium | Core advanced application |
| 327 | Range Sum Count | Medium | Core advanced application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Trie**
- **Segment tree (+ lazy)**
- **Fenwick / BIT**
- **Sparse table**
- **Bitmask DP**
- **Meet in the middle**
- **Euler tour / HLD**
- **Max flow**
- **SCC / Tarjan**
- **Mo's algorithm**

---

## 14. Production Engineering Applications

- **Scalability:** These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n) to O(n log n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Fenwick Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Fenwick Tree (Advanced).
- **Signal:** fenwick, binary indexed tree, bit, prefix sum, point update.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Fenwick Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Fenwick Tree
FAMILY : Advanced (Expert)
WHEN   : fenwick, binary indexed tree, bit, prefix sum, point update
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 307, 315, 493, 327
```

---

*Part of the DSA Patterns Handbook — pattern 91 of 100.*
