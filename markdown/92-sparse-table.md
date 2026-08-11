# 92 · Sparse Table

> **One-liner:** O(1) idempotent range queries (min/max/gcd) after O(n log n) build.

---

## 1. Overview

### Definition
The **Sparse Table** pattern belongs to the *Advanced* family. O(1) idempotent range queries (min/max/gcd) after O(n log n) build.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
sparse table, range minimum, rmq, static, idempotent, binary lifting.

### Constraints
- Input size where the brute-force complexity would time out — the Sparse Table optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Sparse Table invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sparse Table is the upgrade.
- The wording maps onto: sparse table, range minimum, rmq, static, idempotent, binary lifting.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the minimum (or maximum, or gcd) over this range?"* — asked many times, on an array that never changes.

### Intuition
Scan the range and take the extreme.

### Algorithm
1. Read the query `(l, r)`.
2. Walk from `l` to `r`, tracking the minimum.
3. Return it.

### Complexity
- Time: **O(n) per query**, so **O(q · n)** overall.
- Space: O(1).

### Drawbacks
- With `q = 10⁵` queries on `n = 10⁵` elements that is 10¹⁰ operations.
- And the array is **static** — nothing ever changes — so every query re-derives facts that were already true the first time. Overlapping ranges recompute the same minima again and again.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Precompute the answer for every range whose length is a power of two — then any range is covered by just *two* of them, even if they overlap.**

That overlap is the whole trick, and it is what makes queries **O(1)** rather than O(log n).

### The thought process

```text
We need    : range minima, many queries, array never changes.
Obvious way: scan each range.
Too slow   : O(q x n), and it recomputes the same facts.
Notice     : min is IDEMPOTENT — min(x, x) = x — so counting an
             element twice does no harm.
Therefore  : precompute minima for all power-of-two lengths, then
             cover any range with two possibly-OVERLAPPING blocks.
Now        : O(n log n) to build, O(1) per query.
```

### The table

```text
table[k][i] = the minimum over the range [i, i + 2^k - 1]
              (a block of length 2^k starting at i)
```

Each level is built from the one below by splitting the block in half:

```text
table[0][i] = nums[i]                                   blocks of length 1
table[k][i] = min( table[k-1][i],                       first half
                   table[k-1][i + 2^(k-1)] )            second half
```

There are `log n` levels of `n` entries, so building is O(n log n) time and space.

### The query, and why overlap is allowed

Take the largest power of two that fits inside the range:

```text
length = r - l + 1
k      = floor(log2(length))

answer = min( table[k][l],                 the block starting at l
              table[k][r - 2^k + 1] )      the block ENDING at r
```

Those two blocks together cover `[l, r]` completely, and they **overlap in the middle** whenever the length is not an exact power of two.

```text
range [2, 8], length 7, k = 2 (blocks of length 4)

index :  2  3  4  5  6  7  8
block1: [2  3  4  5]
block2:       [5  6  7  8]
                ↑↑
            overlap — harmless, because min(x, x) = x
```

**This is the entire reason a sparse table is O(1) instead of O(log n).** A segment tree must partition the range into disjoint pieces, so it needs `log n` of them. A sparse table may double-count, so two always suffice.

### Which operations qualify

Overlap is only safe for **idempotent** operations — ones where combining a value with itself changes nothing:

| Operation | `f(x, x) == x`? | Sparse table? |
|---|---|---|
| min, max | yes | **yes, O(1)** |
| gcd, bitwise AND, bitwise OR | yes | **yes, O(1)** |
| **sum**, product, XOR | **no** | no — double-counting corrupts it |

For a sum you would count the overlap twice. Use a prefix-sum array (O(1), static) or a Fenwick tree (O(log n), updatable) instead.

### The other hard requirement: the array must be static

There is no update operation. Changing one element can invalidate up to `log n` entries per level, so a rebuild costs O(n log n). If the data changes, use a segment tree.

```text
static + idempotent      →  sparse table:   build O(n log n), query O(1)
static + any operation   →  prefix sums (if invertible)
updates + any operation  →  segment tree:   build O(n),  query/update O(log n)
updates + invertible     →  Fenwick tree:   smaller and simpler
```

### Steps

```text
Step 1 → table[0][i] = nums[i] for every i
Step 2 → For k = 1 while 2^k <= n:
Step 3 →     For each i with i + 2^k - 1 < n:
Step 4 →         table[k][i] = min(table[k-1][i], table[k-1][i + 2^(k-1)])
Step 5 → To query (l, r):
Step 6 →     k = floor(log2(r - l + 1))
Step 7 →     return min(table[k][l], table[k][r - 2^k + 1])
```

Precompute the logarithms in an array (`log[1] = 0`, `log[i] = log[i/2] + 1`) so the query needs no floating-point call.

### How should I recognize this?

```text
If you see...
  "range minimum / maximum / gcd", many queries
  the array is FIXED — no updates anywhere in the problem
  a nested loop over all subarrays needing an extreme of each
        ↓
Think about...
  "Is the operation idempotent? Then two overlapping blocks suffice."
        ↓
Use...
  sparse table   → static + idempotent, O(1) queries
  segment tree   → updates needed, or a non-idempotent operation
  monotonic deque→ a single SLIDING window rather than arbitrary ranges
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="sp-92" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Sparse table: precompute min over intervals of length 2^k</text>
  <!-- index row 0..7 -->
  <g>
    <rect x="40"  y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="75"  y="60" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="110" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="145" y="60" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="180" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="215" y="60" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="250" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="285" y="60" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="320" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="355" y="60" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="390" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="425" y="60" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="460" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="495" y="60" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="530" y="40" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="565" y="60" text-anchor="middle" fill="#1e293b">7</text>
  </g>
  <!-- k=0 length 1 -->
  <text x="18" y="60" fill="#64748b">k0</text>
  <!-- k=1 length 2 -->
  <text x="18" y="98" fill="#64748b">k1</text>
  <rect x="40"  y="82" width="140" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <rect x="180" y="82" width="140" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <rect x="320" y="82" width="140" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <rect x="460" y="82" width="140" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <text x="110" y="99" text-anchor="middle" fill="#64748b" font-size="11">len 2</text>
  <!-- k=2 length 4 -->
  <text x="18" y="136" fill="#64748b">k2</text>
  <rect x="40"  y="120" width="280" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <rect x="320" y="120" width="280" height="26" rx="6" fill="none" stroke="#2563eb"/>
  <text x="180" y="137" text-anchor="middle" fill="#64748b" font-size="11">len 4</text>
  <!-- query [1,6] via two overlapping len-4 blocks -->
  <rect x="110" y="164" width="280" height="26" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="250" y="181" text-anchor="middle" fill="#059669" font-size="11">[1..4]</text>
  <rect x="250" y="196" width="280" height="26" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="390" y="213" text-anchor="middle" fill="#059669" font-size="11">[3..6]</text>
  <text x="320" y="243" text-anchor="middle" fill="#059669" font-weight="700">query(1,6) = min( st[k2][1] , st[k2][3] ) ──▶ O(1); overlap is fine for min/max/gcd</text>
</svg>
```

```text
nums = [5, 2, 8, 1, 9, 3]

table[0]:  5   2   8   1   9   3          blocks of length 1
table[1]:  2   2   1   1   3              blocks of length 2
table[2]:  1   1   1                      blocks of length 4

query(1, 4)   length 4, k = 2
    = min( table[2][1], table[2][4 - 4 + 1] )
    = min( table[2][1], table[2][1] )
    = 1                                    ✓ min of {2, 8, 1, 9}

query(0, 4)   length 5, k = 2
    = min( table[2][0], table[2][1] )
    = min( 1, 1 ) = 1
      blocks [0..3] and [1..4] OVERLAP at 1,2,3 — harmless for min
```

### Interview explanation
"The array is static and I have many range-minimum queries, so I'll build a sparse table. `table[k][i]` holds the minimum over the block of length `2^k` starting at `i`, and each level is built from the one below by combining two half-blocks — O(n log n) to build. A query takes the largest power of two that fits in the range and combines the block starting at `l` with the block *ending* at `r`. Those two cover the range and generally overlap, which is fine because `min` is idempotent: counting an element twice doesn't change the answer. That's what makes queries O(1) rather than O(log n) — a segment tree has to partition the range into disjoint pieces and needs `log n` of them. The two requirements are that the operation is idempotent, so sums are out, and that the array never changes, since there's no update operation."

---

## 5. Generic Templates

> Build by doubling; query with two overlapping blocks. Idempotent operations only.

```go
// SparseTable answers range-minimum queries in O(1) on a STATIC array.
// It relies on min being idempotent, which is what allows the two query
// blocks to overlap.
type SparseTable struct {
    table [][]int // table[k][i] = min over [i, i + 2^k - 1]
    logOf []int   // logOf[n] = floor(log2(n)), precomputed
}

func NewSparseTable(nums []int) *SparseTable {
    n := len(nums)
    if n == 0 {
        return &SparseTable{}
    }

    // logOf[1] = 0, and each doubling adds one.
    logOf := make([]int, n+1)
    for i := 2; i <= n; i++ {
        logOf[i] = logOf[i/2] + 1
    }

    levels := logOf[n] + 1
    table := make([][]int, levels)
    table[0] = append([]int(nil), nums...) // blocks of length 1

    for k := 1; k < levels; k++ {
        width := 1 << k
        half := width >> 1
        count := n - width + 1
        table[k] = make([]int, count)

        for i := 0; i < count; i++ {
            // Combine the two halves of this block.
            left, right := table[k-1][i], table[k-1][i+half]
            if left < right {
                table[k][i] = left
            } else {
                table[k][i] = right
            }
        }
    }

    return &SparseTable{table: table, logOf: logOf}
}

// Min returns the minimum over the inclusive range [l, r] in O(1).
func (s *SparseTable) Min(l, r int) int {
    k := s.logOf[r-l+1] // the largest power of two that fits

    // The block starting at l and the block ENDING at r. They overlap
    // unless the length is an exact power of two — harmless for min.
    left := s.table[k][l]
    right := s.table[k][r-(1<<k)+1]

    if left < right {
        return left
    }
    return right
}
```

```python
class SparseTable:
    """Range minimum in O(1) on a STATIC array. Requires an IDEMPOTENT
    operation, because the two query blocks may overlap."""

    def __init__(self, nums):
        n = len(nums)
        self.log_of = [0] * (n + 1)
        for i in range(2, n + 1):
            self.log_of[i] = self.log_of[i // 2] + 1

        levels = self.log_of[n] + 1 if n else 1
        self.table = [list(nums)]                   # blocks of length 1

        for k in range(1, levels):
            width, half = 1 << k, 1 << (k - 1)
            row = [
                min(self.table[k - 1][i], self.table[k - 1][i + half])
                for i in range(n - width + 1)
            ]
            self.table.append(row)

    def minimum(self, l, r):
        """Minimum over the inclusive range [l, r], in O(1)."""
        k = self.log_of[r - l + 1]          # largest power of two that fits
        # Block starting at l, and block ENDING at r. Overlap is harmless.
        return min(self.table[k][l], self.table[k][r - (1 << k) + 1])
```

```java
public class SparseTable {
    private final int[][] table;    // table[k][i] = min over [i, i + 2^k - 1]
    private final int[] logOf;

    public SparseTable(int[] nums) {
        int n = nums.length;
        logOf = new int[n + 1];
        for (int i = 2; i <= n; i++) logOf[i] = logOf[i / 2] + 1;

        int levels = logOf[n] + 1;
        table = new int[levels][];
        table[0] = nums.clone();                    // blocks of length 1

        for (int k = 1; k < levels; k++) {
            int width = 1 << k, half = width >> 1, count = n - width + 1;
            table[k] = new int[count];
            for (int i = 0; i < count; i++)
                table[k][i] = Math.min(table[k - 1][i], table[k - 1][i + half]);
        }
    }

    // O(1): two blocks that cover [l, r] and may overlap.
    public int min(int l, int r) {
        int k = logOf[r - l + 1];
        return Math.min(table[k][l], table[k][r - (1 << k) + 1]);
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// Range minimum in O(1) on a STATIC array; needs an idempotent operation.
class SparseTable {
    vector<vector<int>> table;      // table[k][i] = min over [i, i + 2^k - 1]
    vector<int> logOf;

public:
    explicit SparseTable(const vector<int>& nums) {
        int n = (int)nums.size();
        logOf.assign(n + 1, 0);
        for (int i = 2; i <= n; ++i) logOf[i] = logOf[i / 2] + 1;

        int levels = n ? logOf[n] + 1 : 1;
        table.assign(levels, {});
        table[0] = nums;                            // blocks of length 1

        for (int k = 1; k < levels; ++k) {
            int width = 1 << k, half = width >> 1;
            table[k].resize(n - width + 1);
            for (int i = 0; i + width <= n; ++i)
                table[k][i] = min(table[k - 1][i], table[k - 1][i + half]);
        }
    }

    // Two blocks covering [l, r]; overlap is harmless for min.
    int minimum(int l, int r) const {
        int k = logOf[r - l + 1];
        return min(table[k][l], table[k][r - (1 << k) + 1]);
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Sparse Table (Optimal) |
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

### Problem — Sliding Window Maximum (LeetCode 239)
Return the maximum of every window of size `k`.

### Thought Process
1. Every window is a range query on a **static** array, so a sparse table answers each in O(1).
2. Build a max table: `table[j][i]` is the maximum over `[i, i + 2^j − 1]`.
3. Since all windows share the same length `k`, the level `j = floor(log2(k))` is fixed — computed once, reused for every window.
4. Each window `[i, i+k−1]` is covered by the block starting at `i` and the block ending at `i+k−1`, which overlap unless `k` is a power of two. Harmless, because `max` is idempotent.
5. Build O(n log n), then O(1) per window.

### Dry Run

Input: `nums = [1, 3, -1, -3, 5, 3, 6, 7]`, `k = 3`

**The table** (only the levels we need):

```text
index  :   0   1   2   3   4   5   6   7
level 0:   1   3  -1  -3   5   3   6   7        blocks of length 1
level 1:   3   3  -1   5   5   6   7            blocks of length 2
```

For `k = 3`, `j = floor(log2 3) = 1`, so blocks of length 2.

**Queries** — each window `[i, i+2]` becomes `max(level1[i], level1[i+1])`:

| window | range | `level1[i]` | `level1[i+2−2+1] = level1[i+1]` | max | overlap |
|--------|-------|-------------|----------------------------------|-----|---------|
| `[1,3,-1]` | `[0,2]` | `3` (covers 0–1) | `3` (covers 1–2) | **3** | index 1 counted twice |
| `[3,-1,-3]` | `[1,3]` | `3` (1–2) | `-1` (2–3) | **3** | index 2 twice |
| `[-1,-3,5]` | `[2,4]` | `-1` (2–3) | `5` (3–4) | **5** | index 3 twice |
| `[-3,5,3]` | `[3,5]` | `5` (3–4) | `5` (4–5) | **5** | index 4 twice |
| `[5,3,6]` | `[4,6]` | `5` (4–5) | `6` (5–6) | **6** | index 5 twice |
| `[3,6,7]` | `[5,7]` | `6` (5–6) | `7` (6–7) | **7** | index 6 twice |

Output: **`[3, 3, 5, 5, 6, 7]`** ✓

Every single query double-counted one element, and every answer is still correct — that is idempotence doing its job.

### Visualization

```text
nums  :   1   3  -1  -3   5   3   6   7
level1:  [3] [3] [-1] [5] [5] [6] [7]      blocks of length 2

window [2, 4]  (length 3, so j = 1)

   block starting at 2 : [-1, -3]  → -1
   block ending   at 4 : [-3,  5]  →  5
                  ↑↑
              index 3 is in BOTH — harmless for max

   answer = max(-1, 5) = 5   ✓
```

### Code

```go
func maxSlidingWindow(nums []int, k int) []int {
    n := len(nums)
    if n == 0 || k <= 0 {
        return nil
    }

    // logOf[i] = floor(log2(i)), so the query needs no floating point.
    logOf := make([]int, n+1)
    for i := 2; i <= n; i++ {
        logOf[i] = logOf[i/2] + 1
    }

    // table[j][i] = maximum over [i, i + 2^j - 1].
    levels := logOf[n] + 1
    table := make([][]int, levels)
    table[0] = append([]int(nil), nums...)

    for j := 1; j < levels; j++ {
        width := 1 << j
        half := width >> 1
        table[j] = make([]int, n-width+1)
        for i := 0; i+width <= n; i++ {
            left, right := table[j-1][i], table[j-1][i+half]
            if left > right {
                table[j][i] = left
            } else {
                table[j][i] = right
            }
        }
    }

    // Every window has the same length, so the level is fixed.
    j := logOf[k]
    result := make([]int, 0, n-k+1)

    for i := 0; i+k <= n; i++ {
        // The block starting at i and the block ENDING at i+k-1.
        // They overlap unless k is a power of two — fine, max is idempotent.
        left := table[j][i]
        right := table[j][i+k-(1<<j)]
        if left > right {
            result = append(result, left)
        } else {
            result = append(result, right)
        }
    }
    return result
}
```

```python
def maxSlidingWindow(nums, k):
    n = len(nums)
    if n == 0 or k <= 0:
        return []

    log_of = [0] * (n + 1)
    for i in range(2, n + 1):
        log_of[i] = log_of[i // 2] + 1

    # table[j][i] = maximum over [i, i + 2^j - 1]
    table = [list(nums)]
    for j in range(1, log_of[n] + 1):
        width, half = 1 << j, 1 << (j - 1)
        table.append([
            max(table[j - 1][i], table[j - 1][i + half])
            for i in range(n - width + 1)
        ])

    j = log_of[k]                       # every window has the same length
    return [
        max(table[j][i], table[j][i + k - (1 << j)])    # overlap is harmless
        for i in range(n - k + 1)
    ]
```

### Complexity
Build **O(n log n)** time and space; each of the `n − k + 1` queries is **O(1)**.

> A monotonic deque solves this specific problem in **O(n)** time and O(k) space, which is strictly better *here* — see the Sliding Window Maximum chapter. The sparse table earns its place when the ranges are **arbitrary** rather than a fixed-width window sliding forward, which is exactly Examples 2 and 3.

---

## 10. Solved Example 2

### Problem — Find a Value of a Mysterious Function Closest to Target (LeetCode 1521)
The function is the **bitwise AND** of a subarray. Over all subarrays, minimise `|AND(l, r) − target|`.

### Thought Process
1. Bitwise AND is idempotent (`x & x == x`), so a sparse table answers `AND(l, r)` in O(1).
2. That alone gives an O(n²) sweep over all subarrays, which is fine for moderate `n`.
3. The sharper observation: for a fixed left endpoint, extending right can only ever **clear** bits, never set them. So `AND(l, r)` is non-increasing in `r`, and it can change at most **30 times** (once per bit).
4. So the set of distinct AND values ending at each position has at most ~30 members — keep them in a small set and roll it forward.
5. That gives O(n · 30). The sparse table version is shown here because it demonstrates the pattern directly.

### Dry Run

Input: `arr = [9, 12, 3, 7, 15]`, `target = 5`

**Distinct AND values by starting point:**

| start `l` | AND as `r` extends | values produced |
|-----------|---------------------|-----------------|
| 0 | `9`, `9&12=8`, `8&3=0`, `0&7=0`, `0&15=0` | `9, 8, 0` |
| 1 | `12`, `12&3=0`, `0`, `0` | `12, 0` |
| 2 | `3`, `3&7=3`, `3&15=3` | `3` |
| 3 | `7`, `7&15=7` | `7` |
| 4 | `15` | `15` |

**Distances from `target = 5`:**

| value | 9 | 8 | 0 | 12 | 3 | 7 | 15 |
|-------|---|---|---|----|---|---|----|
| `\|v − 5\|` | 4 | 3 | 5 | 7 | **2** | **2** | 10 |

Minimum: **2** ✓ — achieved by the subarray `[3]` (value 3) and by `[7]` or `[3,7]` (value 7).

**Watch the monotone collapse.** Starting at `l = 0`, the AND went `9 → 8 → 0` and then stayed at `0` forever. Bits only ever turn off, so each starting point produces at most about 30 distinct values no matter how long the array is — which is what makes the linear-ish variant possible.

### Visualization

```text
arr = [9, 12, 3, 7, 15]     target = 5

l = 0:   9  →  8  →  0  →  0  →  0
              bits only ever CLEAR, never set
              so at most ~30 distinct values per start

all distinct ANDs: {9, 8, 0, 12, 3, 7, 15}

           |3 - 5| = 2      ★
           |7 - 5| = 2      ★
```

### Code

```go
func closestToTarget(arr []int, target int) int {
    n := len(arr)

    logOf := make([]int, n+1)
    for i := 2; i <= n; i++ {
        logOf[i] = logOf[i/2] + 1
    }

    // table[j][i] = bitwise AND over [i, i + 2^j - 1].
    // AND is idempotent, so overlapping query blocks are safe.
    levels := logOf[n] + 1
    table := make([][]int, levels)
    table[0] = append([]int(nil), arr...)

    for j := 1; j < levels; j++ {
        width := 1 << j
        half := width >> 1
        table[j] = make([]int, n-width+1)
        for i := 0; i+width <= n; i++ {
            table[j][i] = table[j-1][i] & table[j-1][i+half]
        }
    }

    rangeAnd := func(l, r int) int {
        j := logOf[r-l+1]
        return table[j][l] & table[j][r-(1<<j)+1]
    }

    best := math.MaxInt32
    for l := 0; l < n; l++ {
        for r := l; r < n; r++ {
            value := rangeAnd(l, r)

            difference := value - target
            if difference < 0 {
                difference = -difference
            }
            if difference < best {
                best = difference
            }

            // AND only clears bits, so once it reaches 0 it stays 0 and
            // no further r can improve this starting point.
            if value == 0 {
                break
            }
        }
    }
    return best
}
```

```python
def closestToTarget(arr, target):
    """The linear-ish variant: for each position keep the small set of
    distinct ANDs of subarrays ending there. Bits only clear, so the set
    never exceeds about 30 members."""
    best = float("inf")
    ending_here = set()                 # distinct AND values ending at i

    for value in arr:
        # Extend every previous subarray by one, plus the singleton.
        ending_here = {value} | {previous & value for previous in ending_here}
        for candidate in ending_here:
            best = min(best, abs(candidate - target))

    return best
```

### Complexity
Sparse-table version: build **O(n log n)**, then O(n²) queries at O(1) each. The rolling-set version is **O(n · 30)** time and O(30) space, and is the one to reach for when `n` is large.

---

## 11. Solved Example 3

### Problem — Sum of Subarray Ranges (LeetCode 2104)
The *range* of a subarray is its maximum minus its minimum. Return the sum of the ranges of **all** subarrays.

### Thought Process
1. There are `n(n+1)/2` subarrays, and each needs both a maximum and a minimum.
2. Two sparse tables — one for max, one for min — answer each in O(1), so the whole sum is O(n²) instead of O(n³).
3. Both operations are idempotent, so overlapping blocks are safe for both tables.
4. Enumerate every `(l, r)` and add `max(l,r) − min(l,r)`.
5. The array is static, which is exactly the sparse table's requirement.

### Dry Run

Input: `nums = [1, 2, 3]`

**The two tables:**

```text
max level 0:  1   2   3          min level 0:  1   2   3
max level 1:  2   3              min level 1:  1   2
```

**All six subarrays:**

| `l` | `r` | subarray | max | min | range | running sum |
|-----|-----|----------|-----|-----|-------|-------------|
| 0 | 0 | `[1]` | 1 | 1 | 0 | 0 |
| 0 | 1 | `[1,2]` | 2 | 1 | **1** | 1 |
| 0 | 2 | `[1,2,3]` | 3 | 1 | **2** | 3 |
| 1 | 1 | `[2]` | 2 | 2 | 0 | 3 |
| 1 | 2 | `[2,3]` | 3 | 2 | **1** | **4** |
| 2 | 2 | `[3]` | 3 | 3 | 0 | 4 |

Output: **4** ✓

**Check the overlap on `[0, 2]`** (length 3, so `j = 1`, blocks of length 2):

```text
max: max( level1[0], level1[2-2+1] ) = max( maxOf[1,2], maxOf[2,3] )
                                     = max( 2, 3 ) = 3     index 1 counted twice
min: min( level1[0], level1[1] )     = min( 1, 2 ) = 1
range = 3 - 1 = 2   ✓
```

**A second case**, `nums = [1, 3, 3]`: subarrays give ranges `0, 0, 0, 2, 0, 2` → sum **4** ✓ — note `[3,3]` has range 0, and the duplicate values cause no trouble.

### Visualization

```text
nums = [1, 2, 3]

  subarray    max  min  range
  [1]          1    1     0
  [1,2]        2    1     1
  [1,2,3]      3    1     2
  [2]          2    2     0
  [2,3]        3    2     1
  [3]          3    3     0
                       ─────
                          4

  two sparse tables (one max, one min) make every row O(1)
```

### Code

```go
func subArrayRanges(nums []int) int64 {
    n := len(nums)
    if n < 2 {
        return 0
    }

    logOf := make([]int, n+1)
    for i := 2; i <= n; i++ {
        logOf[i] = logOf[i/2] + 1
    }
    levels := logOf[n] + 1

    // Two tables: one for max, one for min. Both operations are
    // idempotent, so overlapping query blocks are safe for both.
    maxTable := make([][]int, levels)
    minTable := make([][]int, levels)
    maxTable[0] = append([]int(nil), nums...)
    minTable[0] = append([]int(nil), nums...)

    for j := 1; j < levels; j++ {
        width := 1 << j
        half := width >> 1
        count := n - width + 1
        maxTable[j] = make([]int, count)
        minTable[j] = make([]int, count)

        for i := 0; i < count; i++ {
            a, b := maxTable[j-1][i], maxTable[j-1][i+half]
            if a > b {
                maxTable[j][i] = a
            } else {
                maxTable[j][i] = b
            }

            c, d := minTable[j-1][i], minTable[j-1][i+half]
            if c < d {
                minTable[j][i] = c
            } else {
                minTable[j][i] = d
            }
        }
    }

    var total int64
    for l := 0; l < n; l++ {
        for r := l; r < n; r++ {
            j := logOf[r-l+1]
            offset := r - (1 << j) + 1

            high := maxTable[j][l]
            if maxTable[j][offset] > high {
                high = maxTable[j][offset]
            }
            low := minTable[j][l]
            if minTable[j][offset] < low {
                low = minTable[j][offset]
            }

            total += int64(high - low)
        }
    }
    return total
}
```

```python
def subArrayRanges(nums):
    n = len(nums)
    if n < 2:
        return 0

    log_of = [0] * (n + 1)
    for i in range(2, n + 1):
        log_of[i] = log_of[i // 2] + 1

    # Two tables: max and min. Both idempotent, so overlap is safe.
    max_table, min_table = [list(nums)], [list(nums)]
    for j in range(1, log_of[n] + 1):
        width, half = 1 << j, 1 << (j - 1)
        max_table.append([max(max_table[j - 1][i], max_table[j - 1][i + half])
                          for i in range(n - width + 1)])
        min_table.append([min(min_table[j - 1][i], min_table[j - 1][i + half])
                          for i in range(n - width + 1)])

    total = 0
    for l in range(n):
        for r in range(l, n):
            j = log_of[r - l + 1]
            offset = r - (1 << j) + 1
            total += (max(max_table[j][l], max_table[j][offset])
                      - min(min_table[j][l], min_table[j][offset]))
    return total
```

### Complexity
Build **O(n log n)**; the double loop is **O(n²)** with O(1) per subarray. Space O(n log n).

> There is an O(n) solution using monotonic stacks — count how many subarrays each element is the maximum of, and likewise the minimum. It is faster but much less obvious. The sparse table version is the one to write first, and it makes the *structure* of the problem visible.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 239 | Sliding Window Max | Easy | Core advanced application |
| 1521 | Closest Threshold | Easy | Core advanced application |
| 2104 | Subarray Ranges | Medium | Core advanced application |
| 1235 | Job Sched | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sparse Table logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sparse Table (Advanced).
- **Signal:** sparse table, range minimum, rmq, static, idempotent, binary lifting.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sparse Table invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sparse Table
FAMILY : Advanced (Expert)
WHEN   : sparse table, range minimum, rmq, static, idempotent, binary lifting
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 239, 1521, 2104, 1235
```

---

*Part of the DSA Patterns Handbook — pattern 92 of 100.*
