# 93 · Bitmask DP

> **One-liner:** Encode subsets as bitmasks to DP over 2^n states.

---

## 1. Overview

### Definition
The **Bitmask DP** pattern belongs to the *Advanced* family. Encode subsets as bitmasks to DP over 2^n states.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
bitmask dp, subset state, tsp, assignment, exponential.

### Constraints
- Input size where the brute-force complexity would time out — the Bitmask DP optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Bitmask DP invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Bitmask DP is the upgrade.
- The wording maps onto: bitmask dp, subset state, tsp, assignment, exponential.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which **subset** of these items should I pick — and in what order?"* — when `n` is small but the choices interact.

### Intuition
Try every subset, or every ordering, and evaluate each.

### Algorithm
1. Enumerate all `2ⁿ` subsets (or all `n!` orderings).
2. For each, check validity and compute its score.
3. Keep the best.

### Complexity
- Time: **O(n!)** for orderings, or **O(2ⁿ · n)** for subsets evaluated independently.
- Space: O(n).

### Drawbacks
- `n!` is hopeless past about 11. `2ⁿ` alone is fine to `n ≈ 25`, but *re-evaluating* each subset from scratch is not.
- The real waste: two different orderings that have visited **the same set** of items and are standing in the same place are in **identical situations**. Everything about the future depends only on that pair — not on the route taken to get there.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Represent "which items have I used" as the bits of an integer, and memoise on it — because the route that produced a set never matters, only the set itself.**

```text
n! orderings   →  2^n subsets     (an enormous collapse)
```

For `n = 15`: `15! ≈ 1.3 × 10¹²` versus `2¹⁵ = 32,768`.

### The thought process

```text
We need    : the best subset / ordering, with items interacting.
Obvious way: enumerate orderings.
Hopeless   : n!.
Notice     : two partial solutions that used the SAME SET of items and
             ended in the same place face identical futures. The order
             they were picked in is irrelevant.
Therefore  : the state is (set of used items, current position), and a
             set of up to ~20 items is just an integer's bits.
Now        : O(2^n x n) states, each visited once.
```

### Why an integer is the right container for a set

A subset of `n` items is exactly `n` yes/no answers — which is what an integer's bits are. Every set operation becomes one machine instruction:

| Set operation | Bit operation |
|---|---|
| is item `i` in the set? | `mask & (1 << i) != 0` |
| add item `i` | `mask \| (1 << i)` |
| remove item `i` | `mask &^ (1 << i)` (Go) or `mask & ~(1 << i)` |
| the full set | `(1 << n) - 1` |
| how many items? | `bits.OnesCount(uint(mask))` |
| the empty set | `0` |

So `dp` can be a plain array indexed `0 .. 2ⁿ − 1`, with no hashing at all.

### The state, and how to choose it

Almost every bitmask DP has a state of the form:

```text
(mask of items already used, plus a little extra)
```

The "little extra" is whatever the future genuinely depends on:

| Problem | State | Size |
|---|---|---|
| Travelling salesman / visit all nodes | `(mask, currentNode)` | `2ⁿ · n` |
| Partition into `k` equal subsets | `(mask)` — the bucket remainder is derivable | `2ⁿ` |
| Row-by-row grid placement | `(row, mask of this row)` | `rows · 2^cols` |
| Assign `n` jobs to `n` workers | `(mask)` — popcount gives the worker index | `2ⁿ` |

The last two rows show a useful trick: **if a piece of state is derivable from the mask, do not store it.** In the assignment problem the number of jobs assigned is `popcount(mask)`, so the worker index is free.

### Weighted or unweighted decides BFS versus DP

```text
all transitions cost the same  →  BFS over states, first arrival is optimal
transitions have varying cost  →  DP or Dijkstra over states
```

Shortest Path Visiting All Nodes is unweighted, so a plain BFS over `(mask, node)` suffices — no distance array comparison needed, because BFS settles each state at its optimal distance the first time it is reached.

### Iterating subsets, and the submask trick

Two enumerations come up constantly:

```text
all masks:        for mask := 0; mask < (1 << n); mask++
all submasks of m: for sub := m; sub > 0; sub = (sub - 1) & m
```

The second is worth knowing. `(sub − 1) & m` walks every subset of `m` in decreasing order, and over all masks it totals **3ⁿ** rather than `4ⁿ` — the difference between feasible and not for set-partition problems.

### The hard limit

```text
n <= 20    2^20 = 1,048,576         comfortable
n <= 25    2^25 = 33,554,432        borderline
n >  25                             find another approach
```

Seeing `n ≤ 20` in the constraints is itself the hint. It is unusual enough that it almost always means "the exponent is intended".

### How should I recognize this?

```text
If you see...
  n <= 20 (or the grid has <= 20 columns)
  "visit all", "cover all", "assign each to each", "partition into k sets"
  a permutation problem where only the SET visited so far matters
        ↓
Think about...
  "Do two routes with the same set of used items face the same future?"
        ↓
Use...
  state = (bitmask, plus anything not derivable from it)
  unweighted → BFS over states
  weighted   → DP over masks in increasing order, or Dijkstra
  set partition → the (sub-1) & m submask enumeration
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bm-93" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">n=3: each subset is a 3-bit mask ──▶ dp over 2³ = 8 states</text>
  <!-- lattice of masks by popcount -->
  <rect x="290" y="38" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="58" text-anchor="middle" fill="#1e293b">000</text>
  <rect x="120" y="92" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="150" y="112" text-anchor="middle" fill="#1e293b">001</text>
  <rect x="290" y="92" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="112" text-anchor="middle" fill="#1e293b">010</text>
  <rect x="460" y="92" width="60" height="30" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="490" y="112" text-anchor="middle" fill="#1e293b">100</text>
  <rect x="120" y="150" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="150" y="170" text-anchor="middle" fill="#1e293b">011</text>
  <rect x="290" y="150" width="60" height="30" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="320" y="170" text-anchor="middle" fill="#1e293b">110</text>
  <rect x="460" y="150" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="170" text-anchor="middle" fill="#1e293b">101</text>
  <rect x="290" y="204" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="224" text-anchor="middle" fill="#1e293b">111</text>
  <!-- highlighted transition 010 + bit2(100) = 110 -->
  <line x1="350" y1="107" x2="455" y2="150" stroke="#059669" stroke-width="2" marker-end="url(#bm-93)"/>
  <line x1="490" y1="122" x2="345" y2="150" stroke="#059669" stroke-width="2" marker-end="url(#bm-93)"/>
  <text x="150" y="212" fill="#64748b" font-size="12">column = popcount</text>
  <text x="150" y="230" fill="#64748b" font-size="12">(items chosen)</text>
  <text x="320" y="248" text-anchor="middle" fill="#059669" font-weight="700">dp[110] = best over bits j in mask of dp[110 ^ (1&lt;&lt;j)] + cost(j)</text>
</svg>
```

```text
4 nodes, state = (visited mask, current node)

  mask 0001, at node 0     ← started at node 0
  mask 0011, at node 1     ← then moved to node 1
  mask 0111, at node 2

  two different routes:
      0 → 1 → 2   has mask 0111, at node 2
      0 → 2 → 1 → 2  ... also mask 0111, at node 2

  identical futures  →  visit the state ONCE

  goal: mask == 1111 (all four bits set)
```

### Interview explanation
"The constraint `n ≤ 20` is the tell — that's small enough for `2ⁿ` and far too small for `n!`, which means the intended state is a subset. The key realisation is that two partial solutions which have used the same *set* of items and are in the same position face identical futures; the order they were chosen in doesn't matter. So I encode the used set as the bits of an integer and memoise on `(mask, position)`. Every set operation is then one bit operation, and `dp` is a flat array indexed by the mask — no hashing. For this problem the transitions are unweighted, so a BFS over states is enough: the first time BFS reaches a state, that's its optimal cost. If the transitions had costs I'd do a DP over masks in increasing order, or Dijkstra. The complexity is O(2ⁿ · n) states, which for `n = 20` is about 20 million — comfortable."

---

## 5. Generic Templates

> The mask *is* the set. Store only what the mask cannot tell you.

```go
// SubsetSumPartition reports whether nums can be split into `k` groups
// of equal sum. State: which elements have been placed.
func SubsetSumPartition(nums []int, k int) bool {
    total := 0
    for _, v := range nums {
        total += v
    }
    if k <= 0 || total%k != 0 {
        return false
    }
    target := total / k

    n := len(nums)
    full := (1 << n) - 1

    // remainder[mask] = how full the CURRENT bucket is after placing the
    // elements in `mask`, or -1 if that mask is unreachable.
    // Note we never store which bucket we are on — popcount is not needed,
    // because completed buckets simply wrap the remainder back to 0.
    remainder := make([]int, full+1)
    for i := range remainder {
        remainder[i] = -1
    }
    remainder[0] = 0

    for mask := 0; mask <= full; mask++ {
        if remainder[mask] < 0 {
            continue // unreachable
        }
        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                continue // already placed
            }
            if remainder[mask]+nums[i] > target {
                continue // would overflow the current bucket
            }
            next := mask | (1 << i)
            // Wrapping at `target` starts the next bucket automatically.
            remainder[next] = (remainder[mask] + nums[i]) % target
        }
    }

    return remainder[full] == 0
}

// ShortestPathAllNodes: unweighted, so BFS over (mask, node) states.
func ShortestPathAllNodes(graph [][]int) int {
    n := len(graph)
    if n <= 1 {
        return 0
    }
    full := (1 << n) - 1

    type state struct{ mask, node int }

    visited := make([][]bool, 1<<n)
    for i := range visited {
        visited[i] = make([]bool, n)
    }

    // Every node is a legal starting point, so seed them all at once.
    queue := []state{}
    for node := 0; node < n; node++ {
        start := state{mask: 1 << node, node: node}
        queue = append(queue, start)
        visited[start.mask][node] = true
    }

    steps := 0
    for len(queue) > 0 {
        next := []state{}

        for _, current := range queue {
            if current.mask == full {
                return steps // BFS: the first arrival is optimal
            }
            for _, neighbour := range graph[current.node] {
                newMask := current.mask | (1 << neighbour)
                if visited[newMask][neighbour] {
                    continue
                }
                visited[newMask][neighbour] = true
                next = append(next, state{mask: newMask, node: neighbour})
            }
        }

        queue = next
        steps++
    }
    return -1
}

// IterateSubmasks walks every subset of `mask`. Over all masks this
// totals 3^n rather than 4^n.
func IterateSubmasks(mask int, visit func(sub int)) {
    for sub := mask; sub > 0; sub = (sub - 1) & mask {
        visit(sub)
    }
    visit(0) // the loop above stops before reaching the empty set
}
```

```python
def subset_sum_partition(nums, k):
    """Split nums into k groups of equal sum. State: which elements are placed."""
    total = sum(nums)
    if k <= 0 or total % k != 0:
        return False
    target = total // k

    n = len(nums)
    full = (1 << n) - 1

    # remainder[mask] = how full the current bucket is, or -1 if unreachable.
    remainder = [-1] * (full + 1)
    remainder[0] = 0

    for mask in range(full + 1):
        if remainder[mask] < 0:
            continue
        for i in range(n):
            if mask & (1 << i):
                continue                        # already placed
            if remainder[mask] + nums[i] > target:
                continue                        # would overflow the bucket
            # Wrapping at target starts the next bucket automatically.
            remainder[mask | (1 << i)] = (remainder[mask] + nums[i]) % target

    return remainder[full] == 0

def shortest_path_all_nodes(graph):
    """Unweighted → BFS over (mask, node)."""
    from collections import deque
    n = len(graph)
    if n <= 1:
        return 0
    full = (1 << n) - 1

    queue = deque((1 << node, node) for node in range(n))   # all starts
    seen = {(1 << node, node) for node in range(n)}

    steps = 0
    while queue:
        for _ in range(len(queue)):
            mask, node = queue.popleft()
            if mask == full:
                return steps                    # first arrival is optimal
            for neighbour in graph[node]:
                state = (mask | (1 << neighbour), neighbour)
                if state not in seen:
                    seen.add(state)
                    queue.append(state)
        steps += 1
    return -1

def iterate_submasks(mask):
    """Every subset of mask; 3^n in total across all masks."""
    sub = mask
    while sub > 0:
        yield sub
        sub = (sub - 1) & mask
    yield 0
```

```java
import java.util.*;

public class BitmaskDP {
    // Split nums into k groups of equal sum.
    public static boolean subsetSumPartition(int[] nums, int k) {
        int total = 0;
        for (int v : nums) total += v;
        if (k <= 0 || total % k != 0) return false;
        int target = total / k, n = nums.length, full = (1 << n) - 1;

        int[] remainder = new int[full + 1];
        Arrays.fill(remainder, -1);
        remainder[0] = 0;

        for (int mask = 0; mask <= full; mask++) {
            if (remainder[mask] < 0) continue;
            for (int i = 0; i < n; i++) {
                if ((mask & (1 << i)) != 0) continue;
                if (remainder[mask] + nums[i] > target) continue;
                remainder[mask | (1 << i)] = (remainder[mask] + nums[i]) % target;
            }
        }
        return remainder[full] == 0;
    }

    // Unweighted → BFS over (mask, node).
    public static int shortestPathAllNodes(int[][] graph) {
        int n = graph.length;
        if (n <= 1) return 0;
        int full = (1 << n) - 1;

        boolean[][] visited = new boolean[1 << n][n];
        Queue<int[]> queue = new ArrayDeque<>();
        for (int node = 0; node < n; node++) {
            queue.add(new int[]{1 << node, node});
            visited[1 << node][node] = true;
        }

        int steps = 0;
        while (!queue.isEmpty()) {
            for (int size = queue.size(); size > 0; size--) {
                int[] current = queue.poll();
                if (current[0] == full) return steps;
                for (int neighbour : graph[current[1]]) {
                    int newMask = current[0] | (1 << neighbour);
                    if (visited[newMask][neighbour]) continue;
                    visited[newMask][neighbour] = true;
                    queue.add(new int[]{newMask, neighbour});
                }
            }
            steps++;
        }
        return -1;
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

bool subsetSumPartition(const vector<int>& nums, int k) {
    int total = 0;
    for (int v : nums) total += v;
    if (k <= 0 || total % k != 0) return false;
    int target = total / k, n = (int)nums.size(), full = (1 << n) - 1;

    vector<int> remainder(full + 1, -1);
    remainder[0] = 0;

    for (int mask = 0; mask <= full; ++mask) {
        if (remainder[mask] < 0) continue;
        for (int i = 0; i < n; ++i) {
            if (mask & (1 << i)) continue;
            if (remainder[mask] + nums[i] > target) continue;
            remainder[mask | (1 << i)] = (remainder[mask] + nums[i]) % target;
        }
    }
    return remainder[full] == 0;
}

// Unweighted → BFS over (mask, node).
int shortestPathAllNodes(const vector<vector<int>>& graph) {
    int n = (int)graph.size();
    if (n <= 1) return 0;
    int full = (1 << n) - 1;

    vector<vector<bool>> visited(1 << n, vector<bool>(n, false));
    queue<pair<int, int>> q;
    for (int node = 0; node < n; ++node) {
        q.push({1 << node, node});
        visited[1 << node][node] = true;
    }

    int steps = 0;
    while (!q.empty()) {
        for (int size = (int)q.size(); size > 0; --size) {
            auto [mask, node] = q.front();
            q.pop();
            if (mask == full) return steps;
            for (int neighbour : graph[node]) {
                int newMask = mask | (1 << neighbour);
                if (visited[newMask][neighbour]) continue;
                visited[newMask][neighbour] = true;
                q.push({newMask, neighbour});
            }
        }
        ++steps;
    }
    return -1;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Bitmask DP (Optimal) |
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

### Problem — Shortest Path Visiting All Nodes (LeetCode 847)
Given an undirected connected graph, return the length of the shortest path that visits **every** node. You may start anywhere and revisit nodes and edges freely.

### Thought Process
1. Revisiting is allowed, so this is not a simple-path problem — the state cannot just be "current node".
2. What matters for the future is **which nodes are still unvisited** and **where I am standing**. So the state is `(mask, node)`.
3. Two routes reaching the same `(mask, node)` face identical futures, so each state need be explored only once.
4. Every edge costs 1, so **BFS** settles each state at its optimal distance the first time it is reached — no distance comparisons needed.
5. Any node may be the start, so seed the queue with all `n` of them at distance 0.

### Dry Run

Input: `graph = [[1,2,3], [0], [0], [0]]` — a star with node 0 at the centre.

**Seed** (distance 0): `(0001, 0)`, `(0010, 1)`, `(0100, 2)`, `(1000, 3)`

**Level 1** — expand each:

| from | to | new state |
|------|-----|-----------|
| `(0001, 0)` | 1, 2, 3 | `(0011,1)`, `(0101,2)`, `(1001,3)` |
| `(0010, 1)` | 0 | `(0011,0)` |
| `(0100, 2)` | 0 | `(0101,0)` |
| `(1000, 3)` | 0 | `(1001,0)` |

**Level 2** — from `(0011, 0)` we can reach 2 and 3: `(0111,2)`, `(1011,3)`; from `(0101,0)`: `(0111,1)`, `(1101,3)`; and so on. No mask is `1111` yet.

**Level 3** — from `(0111, 2)` step back to 0: `(0111, 0)`. From `(1011, 3)` → `(1011, 0)`. Still not complete.

**Level 4** — from `(0111, 0)` step to node 3: mask becomes `1111` → **goal reached at distance 4**.

Output: **4** ✓ — for example the walk `1 → 0 → 2 → 0 → 3`, which uses 4 edges.

**Why the mask must be part of the state.** Node 0 is visited three times in that walk. Keyed only by node, BFS would mark it visited on the first arrival and never expand it again — losing the answer entirely. The mask is what distinguishes "at node 0 having seen `{0,1}`" from "at node 0 having seen `{0,1,2}`".

### Visualization

```text
        1
        │
   2 ── 0 ── 3          star graph, 4 nodes

walk: 1 → 0 → 2 → 0 → 3        4 edges

states along the way:
  (0010, 1)  →  (0011, 0)  →  (0111, 2)  →  (0111, 0)  →  (1111, 3)
     ↑                            ↑              ↑
  start at 1                node 0 revisited with DIFFERENT masks —
                            which is why (mask, node) is the state
```

### Code

```go
func shortestPathLength(graph [][]int) int {
    n := len(graph)
    if n <= 1 {
        return 0
    }
    full := (1 << n) - 1

    type state struct{ mask, node int }

    // visited[mask][node]: the same (mask, node) never needs re-exploring,
    // because the route that produced it does not affect the future.
    visited := make([][]bool, 1<<n)
    for i := range visited {
        visited[i] = make([]bool, n)
    }

    // Any node may be the start, so seed all of them at distance 0.
    queue := make([]state, 0, n)
    for node := 0; node < n; node++ {
        queue = append(queue, state{mask: 1 << node, node: node})
        visited[1<<node][node] = true
    }

    steps := 0
    for len(queue) > 0 {
        next := make([]state, 0, len(queue))

        for _, current := range queue {
            if current.mask == full {
                return steps // BFS: the first arrival is already optimal
            }

            for _, neighbour := range graph[current.node] {
                newMask := current.mask | (1 << neighbour)
                if visited[newMask][neighbour] {
                    continue
                }
                visited[newMask][neighbour] = true
                next = append(next, state{mask: newMask, node: neighbour})
            }
        }

        queue = next
        steps++
    }
    return -1 // the graph is connected, so this is unreachable
}
```

```python
from collections import deque

def shortestPathLength(graph):
    n = len(graph)
    if n <= 1:
        return 0
    full = (1 << n) - 1

    # Any node may be the start, so seed all of them at distance 0.
    queue = deque((1 << node, node) for node in range(n))
    seen = {(1 << node, node) for node in range(n)}

    steps = 0
    while queue:
        for _ in range(len(queue)):
            mask, node = queue.popleft()
            if mask == full:
                return steps            # BFS: first arrival is optimal
            for neighbour in graph[node]:
                state = (mask | (1 << neighbour), neighbour)
                if state not in seen:
                    seen.add(state)
                    queue.append(state)
        steps += 1
    return -1
```

### Complexity
Time **O(2ⁿ · n²)** — there are `2ⁿ · n` states and each expands over up to `n` neighbours. Space O(2ⁿ · n).

---

## 10. Solved Example 2

### Problem — Maximum Students Taking Exam (LeetCode 1349)
A classroom grid has broken seats (`'#'`) and usable ones (`'.'`). A student can copy from the seats immediately **left**, **right**, **upper-left** and **upper-right**. Seat the maximum number of students so nobody can copy.

### Thought Process
1. The columns are at most 8, so a whole row's seating is a bitmask of at most 256 values — small enough to enumerate exhaustively.
2. A row's validity depends only on itself (no two adjacent, only usable seats) and on the **row above** (no diagonal neighbours). Rows further up are irrelevant.
3. So the state is `(row index, mask of that row)`, and we sweep row by row.
4. Two bit tests capture all the constraints:
   - **within the row:** `mask & (mask << 1) == 0` — no two adjacent seats
   - **against the row above:** `mask & (above << 1) == 0` **and** `mask & (above >> 1) == 0`
5. Take the best over all masks in the last row.

**Why those two shifts cover both diagonals.** A student at column `c` in the current row is threatened by students at `c−1` and `c+1` in the row above. Shifting the row above left by one aligns its column `c−1` with our column `c`; shifting right aligns `c+1`. Testing both catches upper-left and upper-right together.

### Dry Run

Input:

```text
row 0:  #  .  #  #  .  #
row 1:  .  #  #  #  #  .
row 2:  #  .  #  #  .  #
```

Writing bit `i` for column `i`, the usable seats per row are:

| row | usable columns | as a mask |
|-----|----------------|-----------|
| 0 | 1, 4 | `010010` |
| 1 | 0, 5 | `100001` |
| 2 | 1, 4 | `010010` |

**Row 0** — the best valid mask is `010010` (columns 1 and 4). They are not adjacent, so it is valid → **2 students**.

**Row 1** — candidate `100001` (columns 0 and 5). Check against row 0's `010010`:

```text
above      = 010010          (columns 1, 4)
above << 1 = 100100          (columns 2, 5)
mask       = 100001          (columns 0, 5)
mask & (above << 1) = 100001 & 100100 = 100000  ≠ 0   ✗ column 5 conflicts
```

Column 5 is upper-right-adjacent to column 4 above, so this combination is rejected. Valid alternatives seat one student in row 1, or none.

**The optimum**, found by the DP, seats students in rows 0 and 2 only:

```text
row 0:  columns 1 and 4        2 students
row 1:  (empty)                0 students
row 2:  columns 1 and 4        2 students
                              ───────────
                                4 students
```

Row 2 checks against row 1's empty mask, so both diagonal tests pass trivially.

Output: **4** ✓

### Visualization

```text
       col: 0  1  2  3  4  5
   row 0:   #  S  #  #  S  #      2 students
   row 1:   .  #  #  #  #  .      0 — seating either end
                                     conflicts diagonally with row 0
   row 2:   #  S  #  #  S  #      2 students
                                 ─────────
                                  total 4

  mask & (mask << 1)   catches LEFT/RIGHT within the row
  mask & (above << 1)  catches UPPER-LEFT
  mask & (above >> 1)  catches UPPER-RIGHT
```

### Code

```go
func maxStudents(seats [][]byte) int {
    rows := len(seats)
    if rows == 0 {
        return 0
    }
    cols := len(seats[0])
    allMasks := 1 << cols

    // usable[r] has a 1 bit wherever row r has a working seat.
    usable := make([]int, rows)
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if seats[r][c] == '.' {
                usable[r] |= 1 << c
            }
        }
    }

    const impossible = -1
    previous := make([]int, allMasks)
    for i := range previous {
        previous[i] = impossible
    }
    previous[0] = 0 // an imaginary empty row above the first one

    for r := 0; r < rows; r++ {
        current := make([]int, allMasks)
        for i := range current {
            current[i] = impossible
        }

        for mask := 0; mask < allMasks; mask++ {
            // Only working seats, and no two adjacent within the row.
            if mask&usable[r] != mask {
                continue
            }
            if mask&(mask<<1) != 0 {
                continue
            }

            seated := bits.OnesCount(uint(mask))

            for above := 0; above < allMasks; above++ {
                if previous[above] == impossible {
                    continue
                }
                // above<<1 aligns column c-1 with c  → upper-LEFT
                // above>>1 aligns column c+1 with c  → upper-RIGHT
                if mask&(above<<1) != 0 || mask&(above>>1) != 0 {
                    continue
                }
                if total := previous[above] + seated; total > current[mask] {
                    current[mask] = total
                }
            }
        }
        previous = current
    }

    best := 0
    for _, value := range previous {
        if value > best {
            best = value
        }
    }
    return best
}
```

```python
def maxStudents(seats):
    rows = len(seats)
    if rows == 0:
        return 0
    cols = len(seats[0])
    all_masks = 1 << cols

    # usable[r] has a 1 bit wherever row r has a working seat.
    usable = [
        sum(1 << c for c in range(cols) if seats[r][c] == ".")
        for r in range(rows)
    ]

    IMPOSSIBLE = -1
    previous = [IMPOSSIBLE] * all_masks
    previous[0] = 0                     # an imaginary empty row above

    for r in range(rows):
        current = [IMPOSSIBLE] * all_masks
        for mask in range(all_masks):
            if mask & usable[r] != mask:        # only working seats
                continue
            if mask & (mask << 1):              # no two adjacent in the row
                continue

            seated = bin(mask).count("1")
            for above, best_above in enumerate(previous):
                if best_above == IMPOSSIBLE:
                    continue
                # above<<1 → upper-LEFT, above>>1 → upper-RIGHT
                if mask & (above << 1) or mask & (above >> 1):
                    continue
                current[mask] = max(current[mask], best_above + seated)

        previous = current

    return max(0, max(previous))
```

### Complexity
Time **O(rows · 4^cols)** — every pair of row masks is considered. With `cols ≤ 8` that is about `rows × 65,536`. Space O(2^cols).

---

## 11. Solved Example 3

### Problem — Partition to K Equal Sum Subsets (LeetCode 698)
Determine whether `nums` can be split into `k` non-empty subsets with equal sums.

### Thought Process
1. Reject immediately if `sum % k != 0`; otherwise each bucket must total `target = sum / k`.
2. Backtracking over buckets works but revisits equivalent states. The bitmask insight: **which elements are placed** determines everything.
3. `remainder[mask]` = how full the *current* bucket is after placing exactly the elements in `mask`, or `−1` if that mask is unreachable.
4. The elegant part: we never track *which* bucket we are filling. Taking the running total **modulo `target`** wraps back to 0 whenever a bucket completes, automatically starting the next one.
5. The answer is whether `remainder[full] == 0` — every element placed, and the last bucket exactly full.

**Why the modulo trick is sound.** Elements are added one at a time and never exceed `target` (we skip those that would). So the running total advances from 0 up to `target`, wraps to 0, and repeats. Reaching `remainder[full] == 0` means the total is an exact multiple of `target` with every element used — which is precisely `k` full buckets.

### Dry Run

Input: `nums = [4, 3, 2, 3, 5, 2, 1]`, `k = 4`

`sum = 20`, `20 % 4 == 0`, so `target = 5`.

**A reachable path through the masks** (bit `i` = element `i` placed):

| mask (elements placed) | running bucket | note |
|------------------------|----------------|------|
| `{}` | 0 | start |
| `{5}` — element 4 | `5 % 5 = 0` | bucket complete, wraps to 0 |
| `{5, 4}` | `0 + 4 = 4` | new bucket, partly full |
| `{5, 4, 1}` — element 6 | `(4+1) % 5 = 0` | second bucket complete |
| `{5, 4, 1, 3}` | `3` | third bucket started |
| `{5, 4, 1, 3, 2}` | `(3+2) % 5 = 0` | third bucket complete |
| `{5, 4, 1, 3, 2, 3}` | `3` | fourth bucket started |
| all seven placed | `(3+2) % 5 = 0` | fourth bucket complete |

`remainder[full] == 0` → **`true`** ✓

The four buckets are `{5}`, `{4,1}`, `{3,2}`, `{3,2}`, each summing to 5. ✓

**A failing case:** `nums = [1, 2, 3, 4]`, `k = 3`. `sum = 10`, and `10 % 3 != 0`, so we reject at the first check → **`false`** ✓

**A subtler failure:** `nums = [2, 2, 2, 2, 3, 4, 5]`, `k = 4`. `sum = 20`, `target = 5`. The `3` can only pair with a `2`, and the `4` needs a `1` that does not exist — so no assignment works and `remainder[full]` stays `−1` → **`false`**.

### Visualization

```text
nums = [4, 3, 2, 3, 5, 2, 1]     target = 5

  place 5      → bucket  5 → wraps to 0   ✓ bucket 1 done
  place 4      → bucket  4
  place 1      → bucket  5 → wraps to 0   ✓ bucket 2 done
  place 3      → bucket  3
  place 2      → bucket  5 → wraps to 0   ✓ bucket 3 done
  place 3      → bucket  3
  place 2      → bucket  5 → wraps to 0   ✓ bucket 4 done

  remainder[all placed] == 0  →  true

  the modulo means we never track WHICH bucket we are on
```

### Code

```go
func canPartitionKSubsets(nums []int, k int) bool {
    total := 0
    for _, v := range nums {
        total += v
    }
    if k <= 0 || total%k != 0 {
        return false
    }
    target := total / k

    for _, v := range nums {
        if v > target {
            return false // a single element overflows a bucket
        }
    }

    n := len(nums)
    full := (1 << n) - 1

    // remainder[mask] = how full the CURRENT bucket is after placing
    // exactly the elements in `mask`, or -1 if unreachable.
    remainder := make([]int, full+1)
    for i := range remainder {
        remainder[i] = -1
    }
    remainder[0] = 0

    for mask := 0; mask <= full; mask++ {
        if remainder[mask] < 0 {
            continue // this mask cannot be produced
        }

        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                continue // element already placed
            }
            if remainder[mask]+nums[i] > target {
                continue // would overflow the current bucket
            }

            // The modulo wraps a completed bucket back to 0, which
            // starts the next one — so we never track WHICH bucket.
            next := mask | (1 << i)
            remainder[next] = (remainder[mask] + nums[i]) % target
        }
    }

    return remainder[full] == 0
}
```

```python
def canPartitionKSubsets(nums, k):
    total = sum(nums)
    if k <= 0 or total % k != 0:
        return False
    target = total // k
    if any(v > target for v in nums):
        return False                    # one element overflows a bucket

    n = len(nums)
    full = (1 << n) - 1

    # remainder[mask] = how full the current bucket is, or -1 if unreachable.
    remainder = [-1] * (full + 1)
    remainder[0] = 0

    for mask in range(full + 1):
        if remainder[mask] < 0:
            continue
        for i in range(n):
            if mask & (1 << i):
                continue                # already placed
            if remainder[mask] + nums[i] > target:
                continue                # would overflow
            # Modulo wraps a full bucket to 0, starting the next one.
            remainder[mask | (1 << i)] = (remainder[mask] + nums[i]) % target

    return remainder[full] == 0
```

### Complexity
Time **O(2ⁿ · n)** — every mask times every element. For `n = 16` that is about a million operations. Space O(2ⁿ).

> The three examples show the same idea at three sizes of state: `(mask, node)` when position matters, `(row, mask)` when only the previous row matters, and `mask` alone when everything else is derivable. Choosing the *smallest* sufficient state is what keeps the exponent manageable.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 847 | Shortest Visiting | Easy | Core advanced application |
| 1349 | Max Students | Easy | Core advanced application |
| 698 | K Subsets | Medium | Core advanced application |
| 943 | Shortest Superstring | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Bitmask DP logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Bitmask DP (Advanced).
- **Signal:** bitmask dp, subset state, tsp, assignment, exponential.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Bitmask DP invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Bitmask DP
FAMILY : Advanced (Expert)
WHEN   : bitmask dp, subset state, tsp, assignment, exponential
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 847, 1349, 698, 943
```

---

*Part of the DSA Patterns Handbook — pattern 93 of 100.*
