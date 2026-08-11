# 90 · Segment Tree

> **One-liner:** Tree over ranges for O(log n) range queries and updates.

---

## 1. Overview

### Definition
The **Segment Tree** pattern belongs to the *Advanced* family. Tree over ranges for O(log n) range queries and updates.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
segment tree, range query, range update, lazy propagation, point update.

### Constraints
- Input size where the brute-force complexity would time out — the Segment Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Segment Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Segment Tree is the upgrade.
- The wording maps onto: segment tree, range query, range update, lazy propagation, point update.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the sum (or min, or max) of `arr[l..r]` — when the array keeps **changing** between questions?"*

Running example: `arr = [2, 1, 5, 3]`, interleaved calls like `sum(1,3)`, `set(2, 8)`, `sum(1,3)` again.

### Intuition
There are two obvious data layouts, and each one is fast at exactly one of the two operations.

### Algorithm

**Layout A — just keep the array.**
1. `set(i, v)`: write `arr[i] = v`. **O(1)**.
2. `sum(l, r)`: loop from `l` to `r` adding as you go. **O(n)**.

**Layout B — keep prefix sums** (`pre[i] = arr[0] + … + arr[i-1]`).
1. `sum(l, r)`: return `pre[r+1] - pre[l]`. **O(1)**.
2. `set(i, v)`: every prefix from `i+1` onwards shifts by the delta — rebuild them. **O(n)**.

### Complexity
- Layout A: Time O(1) update, **O(n)** query. Space O(n).
- Layout B: Time **O(n)** update, O(1) query. Space O(n).
- Either way, `q` mixed operations cost **O(n · q)** — 10⁵ of each is 10¹⁰ steps.

### Drawbacks
- **The Prefix Sum chapter's structure is too rigid.** Every one of its `n` stored values depends on `arr[0]`, so changing `arr[0]` invalidates all of them. One tiny edit forces a total rebuild.
- **The plain array is too fine-grained.** Summing `arr[0..999]` re-adds 1000 numbers that were already added together on the previous query, and probably didn't change:

  ```text
  sum(0,999)  → 1000 additions
  set(500, x) → 1 value changed
  sum(0,999)  → 1000 additions again, 999 of them producing the same partial sums
  ```
- The fact being wasted: **a change to one index only invalidates the blocks that contain that index.** Prefix sums make *every* block contain index 0; the raw array has no blocks at all. Neither exploits it.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Pre-add the array in nested halves, so that any range is the sum of O(log n) stored blocks and any single change invalidates only the O(log n) blocks above it.**

Think of a company's headcount. The CEO knows the company total, each VP knows their division's, each manager their team's. If one person joins a team, exactly one number per level changes — the manager's, the VP's, the CEO's — not everybody's. And if you want the headcount of "these three teams", you ask three managers, not 400 individuals. A segment tree is that org chart over an array.

### The thought process

```text
We need    : range sums AND point updates, both fast.
Obvious way: raw array (fast update, slow query) or prefix sums (the reverse).
Too slow   : whichever operation the problem calls often — O(n) each.
Notice     : prefix sums fail because every block starts at index 0, so every
             block contains the changed index. That is a choice, not a law.
Therefore  : choose blocks that NEST instead: [0,7] splits into [0,3] and [4,7],
             each of those splits again, down to single elements.
             Now index 3 sits in only 4 blocks (one per level), not n of them.
Now        : update = fix one block per level  → O(log n)
             query  = stitch the range out of whole blocks → O(log n)
```

### Why nested halves give you both operations

Build a binary tree where the root covers `[0, n-1]`, and every non-leaf node splits its range at the midpoint. For `arr = [2,1,5,3]`:

```text
                  [0,3] = 11
                 /          \
          [0,1] = 3        [2,3] = 8
          /     \          /      \
     [0]=2    [1]=1    [2]=5    [3]=3
```

Two facts fall straight out of the shape:

1. **Depth is log₂ n.** Halving the range each level means `n → n/2 → n/4 → … → 1`, so the tree is about `log₂ n` levels deep and holds `2n − 1` nodes.
2. **Each index appears in exactly one node per level.** Index `3` is inside `[3,3]`, `[2,3]`, `[0,3]` — three nodes total, one per level. So `set(3, v)` rewrites the leaf and re-adds each ancestor from its two children on the way back up. That is `O(log n)` work, and nothing else in the tree is stale.

**Querying is the interesting half.** At each node you compare the node's range against the query range `[l, r]`, and there are exactly three cases:

| Case | Test | What to do | Cost |
|---|---|---|---|
| **No overlap** | `r < lo` or `hi < l` | return the identity (`0` for sum) | O(1), prunes the whole subtree |
| **Total overlap** | `l ≤ lo` and `hi ≤ r` | return the node's stored value | O(1), the whole point of the tree |
| **Partial overlap** | otherwise | recurse into both children and combine | keeps descending |

`sum(1,3)` on the tree above:

```text
[0,3]  vs [1,3] → partial   → ask both children
  [0,1] vs [1,3] → partial  → ask both children
    [0,0] vs [1,3] → NO overlap    → 0
    [1,1] vs [1,3] → TOTAL overlap → 1     ← stored value, no descent
  [2,3] vs [1,3] → TOTAL overlap   → 8     ← stored value, whole subtree skipped
answer = 0 + 1 + 8 = 9
```

**Why this stays O(log n).** It looks like the recursion could explode, but it cannot: on each level, at most **two** nodes are in the "partial" case — the one containing `l` and the one containing `r`. Everything strictly between them is totally covered (return immediately) and everything outside is disjoint (return immediately). Two live nodes per level × log n levels = O(log n) visits.

> **Only sums?** No — nothing above mentioned addition except the "combine" step. Swap `+` for `min`, `max`, `gcd`, or "count of items in this value range" and every argument still holds. That generality is exactly what a Fenwick tree (next chapter) gives up in exchange for being shorter.

> **Range *updates* ("add 5 to everything in `[l,r]`")** would touch O(n) leaves as written. The fix is **lazy propagation**: stamp the pending "+5" on the O(log n) fully-covered nodes and only push it down to children when a later query actually needs to look inside. Same three cases, one extra field. Reach for it only when the problem updates ranges, not points.

### Steps

```text
Step 1 → build(node, lo, hi): if lo == hi store arr[lo];
         else build both halves and store child1 + child2.
Step 2 → query(node, lo, hi, l, r):
Step 3 →   no overlap  → return 0
Step 4 →   total cover → return tree[node]
Step 5 →   otherwise   → return query(left) + query(right)
Step 6 → update(node, lo, hi, i, v):
Step 7 →   leaf → tree[node] = v
Step 8 →   else recurse into the half containing i,
           then re-combine: tree[node] = tree[2n] + tree[2n+1]
```

Store the tree in a flat array of size `4n` with node `1` as the root, children `2*node` and `2*node+1`. (`4n` rather than `2n` because a non-power-of-two `n` leaves gaps in that indexing; `4n` is always enough.)

### How should I recognize this?

```text
If you see...
  "range sum / min / max query" mixed with "update element i"
  a Design problem with both a query and an update method
  n and q both around 10^4..10^5 (so O(n·q) is ~10^10 — dead)
  "after each operation, report ..." on a mutating array
        ↓
Think about...
  "Is the array changing between queries?
   If it were static, prefix sums or a sparse table would do — is it?"
        ↓
Use...
  static array, sums          → prefix sums (chapter 2)
  static array, min/max/gcd   → sparse table (chapter 92)
  point update + prefix sum   → Fenwick tree (chapter 91) — shorter, faster
  point update + any range op → segment tree
  RANGE update + range query  → segment tree + lazy propagation
```

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="st-90" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Segment tree over [2,1,5,3] &amp; query sum(1,3) = 9</text>
  <!-- edges -->
  <line x1="320" y1="58" x2="180" y2="108" stroke="#475569"/>
  <line x1="320" y1="58" x2="460" y2="108" stroke="#475569"/>
  <line x1="180" y1="130" x2="110" y2="176" stroke="#475569"/>
  <line x1="180" y1="130" x2="250" y2="176" stroke="#475569"/>
  <line x1="460" y1="130" x2="390" y2="176" stroke="#475569"/>
  <line x1="460" y1="130" x2="530" y2="176" stroke="#475569"/>
  <!-- root [0,3]=11 -->
  <rect x="278" y="38" width="84" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="60" text-anchor="middle" fill="#1e293b">[0,3]=11</text>
  <!-- [0,1]=3 -->
  <rect x="138" y="110" width="84" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="132" text-anchor="middle" fill="#1e293b">[0,1]=3</text>
  <!-- [2,3]=8 covers query fully -->
  <rect x="418" y="110" width="84" height="34" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="460" y="132" text-anchor="middle" fill="#1e293b">[2,3]=8</text>
  <!-- leaves -->
  <rect x="72"  y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="110" y="200" text-anchor="middle" fill="#1e293b">[0]=2</text>
  <rect x="212" y="178" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="250" y="200" text-anchor="middle" fill="#1e293b">[1]=1</text>
  <rect x="352" y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="390" y="200" text-anchor="middle" fill="#1e293b">[2]=5</text>
  <rect x="492" y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="530" y="200" text-anchor="middle" fill="#1e293b">[3]=3</text>
  <text x="320" y="240" text-anchor="middle" fill="#059669" font-weight="700">green nodes [1,1]=1 &amp; [2,3]=8 fully cover the range ──▶ 1 + 8 = 9 (O(log n))</text>
</svg>
```

```text
arr = [2, 1, 5, 3]                        set(2, 8)  — only the path changes

            [0,3]=11                                [0,3]=14   ← 11+3
            /      \                                /      \
      [0,1]=3      [2,3]=8                    [0,1]=3      [2,3]=11  ← 8+3
       /   \        /   \                      /   \        /    \
   [0]=2 [1]=1  [2]=5 [3]=3                [0]=2 [1]=1  [2]=8  [3]=3
                                                          ↑
sum(1,3): [1,1]=1  +  [2,3]=8  =  9        3 of 7 nodes touched, not 4 of 4
          (total)     (total)               → O(log n)
```

### Interview explanation
"Prefix sums answer range sums in O(1) but need an O(n) rebuild after any update, because every prefix depends on index 0. So instead I'll store nested blocks: a binary tree where the root covers the whole array and each node splits its range in half. An update touches exactly one node per level — O(log n) — and a query decomposes the range into whole stored blocks using three cases: no overlap returns zero, total overlap returns the stored value, partial overlap recurses. At most two nodes per level are partial, so a query is O(log n) too. Build is O(n), space is O(n). If the problem updated ranges rather than points, I'd add lazy propagation."

---

## 5. Generic Templates

> Root covers everything, each node splits in half; three cases decide every query: no overlap, total overlap, partial overlap.

```go
// SegmentTree answers range queries with point updates in O(log n).
// Swap combine (and identity) for min, max, gcd, ... — nothing else changes.
type SegmentTree struct {
    n    int
    tree []int
}

func NewSegmentTree(nums []int) *SegmentTree {
    st := &SegmentTree{n: len(nums), tree: make([]int, 4*len(nums)+4)}
    if st.n > 0 {
        st.build(1, 0, st.n-1, nums)
    }
    return st
}

func combine(a, b int) int { return a + b }
func identity() int        { return 0 } // value that combine() ignores

func (st *SegmentTree) build(node, lo, hi int, nums []int) {
    if lo == hi {
        st.tree[node] = nums[lo]
        return
    }
    mid := (lo + hi) / 2
    st.build(2*node, lo, mid, nums)
    st.build(2*node+1, mid+1, hi, nums)
    st.tree[node] = combine(st.tree[2*node], st.tree[2*node+1])
}

// Set writes value at index i.
func (st *SegmentTree) Set(i, value int) { st.set(1, 0, st.n-1, i, value) }

func (st *SegmentTree) set(node, lo, hi, i, value int) {
    if lo == hi {
        st.tree[node] = value
        return
    }
    mid := (lo + hi) / 2
    if i <= mid {
        st.set(2*node, lo, mid, i, value)
    } else {
        st.set(2*node+1, mid+1, hi, i, value)
    }
    st.tree[node] = combine(st.tree[2*node], st.tree[2*node+1]) // re-combine going up
}

// Query folds arr[l..r] inclusive.
func (st *SegmentTree) Query(l, r int) int { return st.query(1, 0, st.n-1, l, r) }

func (st *SegmentTree) query(node, lo, hi, l, r int) int {
    if r < lo || hi < l {
        return identity() // case 1: disjoint — prune this whole subtree
    }
    if l <= lo && hi <= r {
        return st.tree[node] // case 2: fully inside — the stored value IS the answer
    }
    mid := (lo + hi) / 2 // case 3: straddles the midpoint — ask both children
    return combine(st.query(2*node, lo, mid, l, r), st.query(2*node+1, mid+1, hi, l, r))
}
```

```python
class SegmentTree:
    """Range query + point update in O(log n). Swap combine/identity for min, max, gcd."""

    IDENTITY = 0

    @staticmethod
    def combine(a, b):
        return a + b

    def __init__(self, nums):
        self.n = len(nums)
        self.tree = [self.IDENTITY] * (4 * self.n + 4)
        if self.n:
            self._build(1, 0, self.n - 1, nums)

    def _build(self, node, lo, hi, nums):
        if lo == hi:
            self.tree[node] = nums[lo]
            return
        mid = (lo + hi) // 2
        self._build(2 * node, lo, mid, nums)
        self._build(2 * node + 1, mid + 1, hi, nums)
        self.tree[node] = self.combine(self.tree[2 * node], self.tree[2 * node + 1])

    def set(self, i, value):
        self._set(1, 0, self.n - 1, i, value)

    def _set(self, node, lo, hi, i, value):
        if lo == hi:
            self.tree[node] = value
            return
        mid = (lo + hi) // 2
        if i <= mid:
            self._set(2 * node, lo, mid, i, value)
        else:
            self._set(2 * node + 1, mid + 1, hi, i, value)
        self.tree[node] = self.combine(self.tree[2 * node], self.tree[2 * node + 1])

    def query(self, l, r):
        return self._query(1, 0, self.n - 1, l, r)

    def _query(self, node, lo, hi, l, r):
        if r < lo or hi < l:
            return self.IDENTITY                 # case 1: disjoint
        if l <= lo and hi <= r:
            return self.tree[node]               # case 2: fully inside
        mid = (lo + hi) // 2                     # case 3: straddles the midpoint
        return self.combine(self._query(2 * node, lo, mid, l, r),
                            self._query(2 * node + 1, mid + 1, hi, l, r))
```

```java
public class SegmentTree {
    private final int n;
    private final long[] tree;

    private static final long IDENTITY = 0;
    private static long combine(long a, long b) { return a + b; }

    public SegmentTree(int[] nums) {
        n = nums.length;
        tree = new long[4 * n + 4];
        if (n > 0) build(1, 0, n - 1, nums);
    }

    private void build(int node, int lo, int hi, int[] nums) {
        if (lo == hi) { tree[node] = nums[lo]; return; }
        int mid = (lo + hi) / 2;
        build(2 * node, lo, mid, nums);
        build(2 * node + 1, mid + 1, hi, nums);
        tree[node] = combine(tree[2 * node], tree[2 * node + 1]);
    }

    public void set(int i, int value) { set(1, 0, n - 1, i, value); }

    private void set(int node, int lo, int hi, int i, int value) {
        if (lo == hi) { tree[node] = value; return; }
        int mid = (lo + hi) / 2;
        if (i <= mid) set(2 * node, lo, mid, i, value);
        else          set(2 * node + 1, mid + 1, hi, i, value);
        tree[node] = combine(tree[2 * node], tree[2 * node + 1]);
    }

    public long query(int l, int r) { return query(1, 0, n - 1, l, r); }

    private long query(int node, int lo, int hi, int l, int r) {
        if (r < lo || hi < l) return IDENTITY;   // case 1: disjoint
        if (l <= lo && hi <= r) return tree[node]; // case 2: fully inside
        int mid = (lo + hi) / 2;                 // case 3: straddles the midpoint
        return combine(query(2 * node, lo, mid, l, r),
                       query(2 * node + 1, mid + 1, hi, l, r));
    }
}
```

```cpp
#include <vector>
using namespace std;

class SegmentTree {
public:
    explicit SegmentTree(const vector<int>& nums) : n((int)nums.size()), tree(4 * nums.size() + 4, IDENTITY) {
        if (n > 0) build(1, 0, n - 1, nums);
    }

    void set(int i, long long value) { set(1, 0, n - 1, i, value); }
    long long query(int l, int r) { return query(1, 0, n - 1, l, r); }

private:
    static const long long IDENTITY = 0;
    static long long combine(long long a, long long b) { return a + b; }

    int n;
    vector<long long> tree;

    void build(int node, int lo, int hi, const vector<int>& nums) {
        if (lo == hi) { tree[node] = nums[lo]; return; }
        int mid = (lo + hi) / 2;
        build(2 * node, lo, mid, nums);
        build(2 * node + 1, mid + 1, hi, nums);
        tree[node] = combine(tree[2 * node], tree[2 * node + 1]);
    }

    void set(int node, int lo, int hi, int i, long long value) {
        if (lo == hi) { tree[node] = value; return; }
        int mid = (lo + hi) / 2;
        if (i <= mid) set(2 * node, lo, mid, i, value);
        else          set(2 * node + 1, mid + 1, hi, i, value);
        tree[node] = combine(tree[2 * node], tree[2 * node + 1]);
    }

    long long query(int node, int lo, int hi, int l, int r) {
        if (r < lo || hi < l) return IDENTITY;      // case 1: disjoint
        if (l <= lo && hi <= r) return tree[node];  // case 2: fully inside
        int mid = (lo + hi) / 2;                    // case 3: straddles the midpoint
        return combine(query(2 * node, lo, mid, l, r),
                       query(2 * node + 1, mid + 1, hi, l, r));
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Segment Tree (Optimal) |
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

### Problem — Range Sum Mutable (LeetCode 307)
Design a structure over an integer array supporting `update(index, val)` (overwrite one element) and `sumRange(left, right)` (sum of the inclusive range), with both called up to 3·10⁴ times.

### Thought Process
1. Both operations are hot, so neither "plain array" (O(n) query) nor "prefix sums" (O(n) update) survives.
2. Build the array into nested halves: root covers `[0, n-1]`, every node splits at its midpoint.
3. `sumRange` walks down using the three cases — disjoint → 0, fully covered → stored sum, straddling → recurse.
4. `update` descends to the leaf, writes it, then re-adds each ancestor from its two children on the way back up.
5. Flat array storage: node `1` is the root, children at `2*node` and `2*node+1`, size `4n`.

### Dry Run

Input: `nums = [1, 3, 5, 7, 9, 11, 13, 15]`, then `sumRange(2,5)`, `update(3, 10)`, `sumRange(2,5)`.

**After build** — 15 nodes:

| node | covers | sum | | node | covers | sum |
|---|---|---|---|---|---|---|
| 1 | `[0,7]` | 64 | | 8 | `[0,0]` | 1 |
| 2 | `[0,3]` | 16 | | 9 | `[1,1]` | 3 |
| 3 | `[4,7]` | 48 | | 10 | `[2,2]` | 5 |
| 4 | `[0,1]` | 4 | | 11 | `[3,3]` | 7 |
| 5 | `[2,3]` | 12 | | 12 | `[4,4]` | 9 |
| 6 | `[4,5]` | 20 | | 13 | `[5,5]` | 11 |
| 7 | `[6,7]` | 28 | | 14 | `[6,6]` | 13 |
| | | | | 15 | `[7,7]` | 15 |

**`sumRange(2,5)`** — every visited node, in order:

| # | node | covers | vs `[2,5]` | case | returns |
|---|------|--------|-----------|------|---------|
| 1 | 1 | `[0,7]` | straddles | **partial** → recurse | 12 + 20 = **32** |
| 2 | 2 | `[0,3]` | straddles | **partial** → recurse | 0 + 12 = 12 |
| 3 | 4 | `[0,1]` | ends before 2 | **no overlap** | 0 |
| 4 | 5 | `[2,3]` | inside `[2,5]` | **total** → stored | 12 |
| 5 | 3 | `[4,7]` | straddles | **partial** → recurse | 20 + 0 = 20 |
| 6 | 6 | `[4,5]` | inside `[2,5]` | **total** → stored | 20 |
| 7 | 7 | `[6,7]` | starts after 5 | **no overlap** | 0 |

Output: **32** (= 5 + 7 + 9 + 11 ✓). Seven node visits, and the four leaves in the range were never touched — nodes 5 and 6 answered for them.

**`update(3, 10)`** — only the root-to-leaf path changes:

| node | covers | before | after |
|---|---|---|---|
| 11 | `[3,3]` | 7 | **10** |
| 5 | `[2,3]` | 12 | 5 + 10 = **15** |
| 2 | `[0,3]` | 16 | 15 + 4 = **19** |
| 1 | `[0,7]` | 64 | 19 + 48 = **67** |

4 nodes out of 15 rewritten — the other 11 were already correct.

**`sumRange(2,5)` again**: same walk, node 5 now returns 15 → **15 + 20 = 35** (= 5 + 10 + 9 + 11 ✓).

Output: **32, then 35**

### Visualization

```text
                          [0,7]=64
                    ______/      \______
              [0,3]=16                [4,7]=48
             /        \              /        \
       [0,1]=4      [2,3]=12    [4,5]=20    [6,7]=28
        /   \        /    \      /    \      /    \
       1     3      5      7    9     11    13    15

sumRange(2,5):     ✗skip      ✔TOTAL       ✔TOTAL     ✗skip
                  [0,1]        [2,3]=12     [4,5]=20   [6,7]
                                    \         /
                                     12 + 20 = 32

update(3,10):  leaf[3] ← 10, then repair upward
       [3,3]:7→10  →  [2,3]:12→15  →  [0,3]:16→19  →  [0,7]:64→67
       (one node per level = log2(8) + 1 = 4 writes)
```

### Code

```go
// NumArray stores the array as nested half-ranges (a segment tree).
// tree[node] holds the sum of the range that node covers.
type NumArray struct {
    n    int
    tree []int
}

func NewNumArray(nums []int) *NumArray {
    a := &NumArray{n: len(nums), tree: make([]int, 4*len(nums)+4)}
    if a.n > 0 {
        a.build(1, 0, a.n-1, nums)
    }
    return a
}

func (a *NumArray) build(node, lo, hi int, nums []int) {
    if lo == hi {
        a.tree[node] = nums[lo]
        return
    }
    mid := (lo + hi) / 2
    a.build(2*node, lo, mid, nums)
    a.build(2*node+1, mid+1, hi, nums)
    a.tree[node] = a.tree[2*node] + a.tree[2*node+1]
}

func (a *NumArray) Update(index, val int) { a.update(1, 0, a.n-1, index, val) }

func (a *NumArray) update(node, lo, hi, i, val int) {
    if lo == hi {
        a.tree[node] = val
        return
    }
    mid := (lo + hi) / 2
    if i <= mid {
        a.update(2*node, lo, mid, i, val)
    } else {
        a.update(2*node+1, mid+1, hi, i, val)
    }
    a.tree[node] = a.tree[2*node] + a.tree[2*node+1] // repair this ancestor
}

func (a *NumArray) SumRange(left, right int) int {
    return a.query(1, 0, a.n-1, left, right)
}

func (a *NumArray) query(node, lo, hi, l, r int) int {
    if r < lo || hi < l {
        return 0 // case 1: no overlap — prune
    }
    if l <= lo && hi <= r {
        return a.tree[node] // case 2: total overlap — the stored sum is the answer
    }
    mid := (lo + hi) / 2 // case 3: partial overlap — ask both halves
    return a.query(2*node, lo, mid, l, r) + a.query(2*node+1, mid+1, hi, l, r)
}
```

```python
class NumArray:
    def __init__(self, nums):
        self.n = len(nums)
        self.tree = [0] * (4 * self.n + 4)
        if self.n:
            self._build(1, 0, self.n - 1, nums)

    def _build(self, node, lo, hi, nums):
        if lo == hi:
            self.tree[node] = nums[lo]
            return
        mid = (lo + hi) // 2
        self._build(2 * node, lo, mid, nums)
        self._build(2 * node + 1, mid + 1, hi, nums)
        self.tree[node] = self.tree[2 * node] + self.tree[2 * node + 1]

    def update(self, index, val):
        self._update(1, 0, self.n - 1, index, val)

    def _update(self, node, lo, hi, i, val):
        if lo == hi:
            self.tree[node] = val
            return
        mid = (lo + hi) // 2
        if i <= mid:
            self._update(2 * node, lo, mid, i, val)
        else:
            self._update(2 * node + 1, mid + 1, hi, i, val)
        self.tree[node] = self.tree[2 * node] + self.tree[2 * node + 1]

    def sumRange(self, left, right):
        return self._query(1, 0, self.n - 1, left, right)

    def _query(self, node, lo, hi, l, r):
        if r < lo or hi < l:
            return 0                       # case 1: no overlap
        if l <= lo and hi <= r:
            return self.tree[node]         # case 2: total overlap
        mid = (lo + hi) // 2               # case 3: partial overlap
        return (self._query(2 * node, lo, mid, l, r) +
                self._query(2 * node + 1, mid + 1, hi, l, r))
```

### Complexity
Time O(n) to build; O(log n) per `update` (one node per level) and O(log n) per `sumRange` (at most two "partial" nodes per level, everything else returns immediately). Space O(n) — the `4n` array is a constant-factor convenience for the `2*node` indexing.

---

## 10. Solved Example 2

### Problem — Count Smaller (LeetCode 315)
For each index `i`, count how many elements to the **right** of `nums[i]` are strictly smaller than it. Return that list of counts.

### Thought Process
1. The O(n²) answer compares each element with everything after it — the same suffix re-scanned `n` times.
2. Flip the direction: sweep **right to left**, so "everything to the right of `i`" is exactly "everything inserted so far".
3. Then the question becomes "how many inserted values are `< nums[i]`?" — a *count over a value range*, not an index range.
4. So build the segment tree over **values**, not positions: leaf `v` holds "how many copies of value `v` have I inserted". `query(0, rank(nums[i]) - 1)` is the answer.
5. Values can be huge and negative, so compress them first: sort the distinct values and use each value's position as its leaf index.

### Dry Run

Input: `nums = [5, 2, 6, 1]`

Distinct sorted values → leaf indices: `1→0, 2→1, 5→2, 6→3`. The tree starts all-zero.

| step | i | nums[i] | rank | query ranks `[0, rank-1]` | result[i] | leaf counts after inserting |
|---|---|---|---|---|---|---|
| 1 | 3 | 1 | 0 | `[0,-1]` → empty | **0** | `1:1  2:0  5:0  6:0` |
| 2 | 2 | 6 | 3 | `[0,2]` → counts of 1,2,5 = 1+0+0 | **1** | `1:1  2:0  5:0  6:1` |
| 3 | 1 | 2 | 1 | `[0,0]` → count of 1 = 1 | **1** | `1:1  2:1  5:0  6:1` |
| 4 | 0 | 5 | 2 | `[0,1]` → counts of 1,2 = 1+1 | **2** | `1:1  2:1  5:1  6:1` |

Output: **`[2, 1, 1, 0]`**

Step 1 is the edge case worth naming: `rank - 1 = -1` makes the query range empty, and the `r < l` guard returns 0 rather than reading garbage. Step 4 shows the payoff — one `O(log n)` query replaced scanning the three elements to the right of index 0.

### Visualization

```text
segment tree over VALUE ranks (not positions), after all four inserts:

  ranks:      0     1     2     3
  values:     1     2     5     6

                    [0,3] = 4
                   /         \
            [0,1] = 2       [2,3] = 2
             /    \          /     \
        [0]=1   [1]=1    [2]=1    [3]=1

query(0,1) at step 4  →  node [0,1] is TOTALLY covered  →  return 2
                          (one node visit, not two leaf visits)

sweeping right-to-left is what makes "already inserted" mean "to my right":

  [5, 2, 6, 1]
            ↑ insert 1
         ↑    insert 6, tree holds {1}
      ↑       insert 2, tree holds {1,6}
   ↑          insert 5, tree holds {1,6,2}   → 2 of them are < 5
```

### Code

```go
// countSeg counts how many inserted values fall in each rank range.
type countSeg struct{ tree []int }

// add records one occurrence of the value with this rank.
func (s *countSeg) add(node, lo, hi, rank int) {
    s.tree[node]++
    if lo == hi {
        return
    }
    mid := (lo + hi) / 2
    if rank <= mid {
        s.add(2*node, lo, mid, rank)
    } else {
        s.add(2*node+1, mid+1, hi, rank)
    }
}

// count returns how many inserted values have rank in [l, r].
func (s *countSeg) count(node, lo, hi, l, r int) int {
    if r < l || r < lo || hi < l {
        return 0 // empty or disjoint range
    }
    if l <= lo && hi <= r {
        return s.tree[node]
    }
    mid := (lo + hi) / 2
    return s.count(2*node, lo, mid, l, r) + s.count(2*node+1, mid+1, hi, l, r)
}

func countSmaller(nums []int) []int {
    n := len(nums)
    result := make([]int, n)
    if n == 0 {
        return result
    }

    // Coordinate compression: distinct sorted values become leaf indices 0..m-1.
    sorted := append([]int(nil), nums...)
    sort.Ints(sorted)
    uniq := make([]int, 0, n)
    for i, v := range sorted {
        if i == 0 || v != sorted[i-1] {
            uniq = append(uniq, v)
        }
    }
    m := len(uniq)
    seg := &countSeg{tree: make([]int, 4*m+4)}

    // Right to left, so "already inserted" == "lies to my right".
    for i := n - 1; i >= 0; i-- {
        rank := sort.SearchInts(uniq, nums[i])
        result[i] = seg.count(1, 0, m-1, 0, rank-1) // strictly smaller values
        seg.add(1, 0, m-1, rank)
    }
    return result
}
```

```python
import bisect


def countSmaller(nums):
    n = len(nums)
    result = [0] * n
    if n == 0:
        return result

    uniq = sorted(set(nums))            # distinct values become leaf indices
    m = len(uniq)
    tree = [0] * (4 * m + 4)

    def add(node, lo, hi, rank):
        tree[node] += 1
        if lo == hi:
            return
        mid = (lo + hi) // 2
        if rank <= mid:
            add(2 * node, lo, mid, rank)
        else:
            add(2 * node + 1, mid + 1, hi, rank)

    def count(node, lo, hi, l, r):
        if r < l or r < lo or hi < l:
            return 0                    # empty or disjoint
        if l <= lo and hi <= r:
            return tree[node]
        mid = (lo + hi) // 2
        return (count(2 * node, lo, mid, l, r) +
                count(2 * node + 1, mid + 1, hi, l, r))

    for i in range(n - 1, -1, -1):      # right to left
        rank = bisect.bisect_left(uniq, nums[i])
        result[i] = count(1, 0, m - 1, 0, rank - 1)
        add(1, 0, m - 1, rank)
    return result
```

### Complexity
Time O(n log n) — one sort for compression, then `n` iterations doing one O(log n) query and one O(log n) insert. Space O(n) for the compressed values and the `4m` tree.

---

## 11. Solved Example 3

### Problem — Skyline (LeetCode 218)
Given buildings as `[left, right, height]`, output the skyline's key points: the `[x, height]` pairs where the outline's height **changes**, left to right, ending with a point at height `0`.

### Thought Process
1. The skyline's height at any x is just `max` over the buildings covering that x — so this is a **range-max stamp** problem, not a sum problem.
2. Heights only ever change at a building's left or right edge, so compress those x values and treat the gaps between consecutive ones as indivisible **slabs**.
3. Building `[l, r, h]` stamps `h` onto every slab inside `[l, r)`: a range update. But every update is "take the max", and we only read at the very end.
4. That means no push-down is needed — just record `h` on the O(log n) fully-covered nodes, and a slab's true height is the **max of the tags on its root-to-leaf path**.
5. One final left-to-right pass over the slab heights emits a key point wherever the height differs from the previous slab.

### Dry Run

Input: `buildings = [[1,3,4], [2,4,2]]`

Compressed x values: `[1, 2, 3, 4]` → 3 slabs: `slab0 = [1,2)`, `slab1 = [2,3)`, `slab2 = [3,4)`.

**Stamping** (`chmax` over slab indices):

| building | covers slabs | nodes tagged | tag values |
|---|---|---|---|
| `[1,3,4]` | `[0,1]` | node `[0,1]` fully covered | `tag[0,1] = 4` |
| `[2,4,2]` | `[1,2]` | node `[1,1]`, node `[2,2]` | `tag[1,1] = 2`, `tag[2,2] = 2` |

**Reading the leaves** (max of tags along the path from the root):

| slab | x range | path tags | height |
|---|---|---|---|
| 0 | `[1,2)` | `[0,2]`:0 → `[0,1]`:**4** → `[0,0]`:0 | **4** |
| 1 | `[2,3)` | `[0,2]`:0 → `[0,1]`:**4** → `[1,1]`:2 | **4** |
| 2 | `[3,4)` | `[0,2]`:0 → `[2,2]`:**2** | **2** |

**Emitting key points** (`prev` starts at 0):

| slab | x | height | vs prev | emit |
|---|---|---|---|---|
| 0 | 1 | 4 | 4 ≠ 0 | `[1, 4]` |
| 1 | 2 | 4 | 4 = 4 | — (no change, no key point) |
| 2 | 3 | 2 | 2 ≠ 4 | `[3, 2]` |
| end | 4 | 0 | drop to ground | `[4, 0]` |

Output: **`[[1,4], [3,2], [4,0]]`**

Slab 1 is the row that matters: the shorter building `[2,4,2]` *is* stamped there, but the taller tag `4` sits on an ancestor and wins, so no key point is emitted. That is why "max along the path" is the correct read, and why the equal-height row must be suppressed.

### Visualization

```text
     4 ┤ ┌───────┐
       │ │       │
     2 ┤ │   ┌───┼───┐          buildings [1,3,4] and [2,4,2]
       │ │   │   │   │
     0 ┼─┴───┴───┴───┴──
       0 1   2   3   4

slabs:      [1,2)  [2,3)  [3,4)
heights:      4      4      2
key points:  [1,4]   —    [3,2]   then [4,0]
              ↑ rise        ↑ drop

tag tree (nothing is pushed down; a leaf reads the max above it)

              [0,2] tag 0
             /            \
      [0,1] tag 4        [2,2] tag 2
       /       \
  [0,0] 0   [1,1] tag 2      ← 2 loses to the 4 on its parent
```

### Code

```go
// heightSeg stamps heights on whole ranges. tag[node] = the tallest height
// applied to that node's ENTIRE range. Nothing is pushed down, because the
// leaves are only read once, at the end.
type heightSeg struct{ tag []int }

func (s *heightSeg) chmax(node, lo, hi, l, r, h int) {
    if r < lo || hi < l {
        return
    }
    if l <= lo && hi <= r {
        if h > s.tag[node] { // whole node covered: record and stop
            s.tag[node] = h
        }
        return
    }
    mid := (lo + hi) / 2
    s.chmax(2*node, lo, mid, l, r, h)
    s.chmax(2*node+1, mid+1, hi, l, r, h)
}

// collect walks down carrying the best tag seen so far; each leaf's height is
// the max tag on its root-to-leaf path.
func (s *heightSeg) collect(node, lo, hi, best int, out []int) {
    if s.tag[node] > best {
        best = s.tag[node]
    }
    if lo == hi {
        out[lo] = best
        return
    }
    mid := (lo + hi) / 2
    s.collect(2*node, lo, mid, best, out)
    s.collect(2*node+1, mid+1, hi, best, out)
}

func getSkyline(buildings [][]int) [][]int {
    result := [][]int{}
    if len(buildings) == 0 {
        return result
    }

    // 1. Compress every edge x into a sorted list of distinct coordinates.
    xs := make([]int, 0, 2*len(buildings))
    for _, b := range buildings {
        xs = append(xs, b[0], b[1])
    }
    sort.Ints(xs)
    uniq := make([]int, 0, len(xs))
    for i, x := range xs {
        if i == 0 || x != xs[i-1] {
            uniq = append(uniq, x)
        }
    }
    slabs := len(uniq) - 1 // slab i is the half-open span [uniq[i], uniq[i+1])
    seg := &heightSeg{tag: make([]int, 4*slabs+4)}

    // 2. Stamp each building's height onto the slabs it covers.
    for _, b := range buildings {
        l := sort.SearchInts(uniq, b[0])
        r := sort.SearchInts(uniq, b[1]) - 1
        if l <= r {
            seg.chmax(1, 0, slabs-1, l, r, b[2])
        }
    }

    // 3. Read every slab's height, then emit a point wherever it changes.
    heights := make([]int, slabs)
    seg.collect(1, 0, slabs-1, 0, heights)
    prev := 0
    for i := 0; i < slabs; i++ {
        if heights[i] != prev {
            result = append(result, []int{uniq[i], heights[i]})
            prev = heights[i]
        }
    }
    if prev != 0 {
        result = append(result, []int{uniq[slabs], 0}) // back to ground level
    }
    return result
}
```

```python
import bisect


def getSkyline(buildings):
    if not buildings:
        return []

    uniq = sorted({x for b in buildings for x in (b[0], b[1])})
    slabs = len(uniq) - 1                 # slab i spans [uniq[i], uniq[i+1])
    tag = [0] * (4 * slabs + 4)           # tag[node] = tallest height on that whole range

    def chmax(node, lo, hi, l, r, h):
        if r < lo or hi < l:
            return
        if l <= lo and hi <= r:
            tag[node] = max(tag[node], h)  # whole node covered: record and stop
            return
        mid = (lo + hi) // 2
        chmax(2 * node, lo, mid, l, r, h)
        chmax(2 * node + 1, mid + 1, hi, l, r, h)

    for left, right, h in buildings:
        l = bisect.bisect_left(uniq, left)
        r = bisect.bisect_left(uniq, right) - 1
        if l <= r:
            chmax(1, 0, slabs - 1, l, r, h)

    heights = [0] * slabs

    def collect(node, lo, hi, best):
        best = max(best, tag[node])        # max tag on the root-to-leaf path
        if lo == hi:
            heights[lo] = best
            return
        mid = (lo + hi) // 2
        collect(2 * node, lo, mid, best)
        collect(2 * node + 1, mid + 1, hi, best)

    collect(1, 0, slabs - 1, 0)

    result, prev = [], 0
    for i in range(slabs):
        if heights[i] != prev:
            result.append([uniq[i], heights[i]])
            prev = heights[i]
    if prev != 0:
        result.append([uniq[slabs], 0])    # back to ground level
    return result
```

### Complexity
Time O(n log n) — sorting the `2n` edge coordinates dominates; each of the `n` buildings does one O(log n) stamp, and the final `collect` is one O(n) walk. Space O(n) for the compressed coordinates and the tag tree.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 307 | Range Sum Mutable | Easy | Core advanced application |
| 315 | Count Smaller | Easy | Core advanced application |
| 218 | Skyline | Medium | Core advanced application |
| 699 | Falling Squares | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Segment Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Segment Tree (Advanced).
- **Signal:** segment tree, range query, range update, lazy propagation, point update.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Segment Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Segment Tree
FAMILY : Advanced (Expert)
WHEN   : segment tree, range query, range update, lazy propagation, point update
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 307, 315, 218, 699
```

---

*Part of the DSA Patterns Handbook — pattern 90 of 100.*
