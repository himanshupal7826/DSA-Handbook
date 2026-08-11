# 67 · Floyd Warshall

> **One-liner:** All-pairs shortest paths via DP over intermediate vertices, O(V³).

---

## 1. Overview

### Definition
The **Floyd Warshall** pattern belongs to the *Graphs* family. All-pairs shortest paths via DP over intermediate vertices, O(V³).

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
floyd warshall, all pairs, shortest path, dp, transitive closure.

### Constraints
- Input size where the brute-force complexity would time out — the Floyd Warshall optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Floyd Warshall invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Floyd Warshall is the upgrade.
- The wording maps onto: floyd warshall, all pairs, shortest path, dp, transitive closure.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How far is it from **everywhere** to **everywhere**?"*

Running example (used for the whole chapter) — a 4-node directed chain, deliberately numbered so the useful route runs *backwards* through the labels:

```text
edges:  0 → 3  (1)      true all-pairs row for node 0:
        3 → 2  (1)          dist[0] = [0, 3, 2, 1]
        2 → 1  (1)          because 0 → 3 → 2 → 1 costs 1+1+1 = 3
```

### Intuition
Pick a start and an end, list every path between them, keep the cheapest. Repeat for all `V²` ordered pairs.

### Algorithm
1. For every ordered pair `(i, j)`:
2. &nbsp;&nbsp;Enumerate every simple path from `i` to `j`.
3. &nbsp;&nbsp;Sum each path's weights and keep the smallest total.
4. Store it in `dist[i][j]`.

### Complexity
- Time: **O(V² · V!)** — a factorial path enumeration, done `V²` times.
- Space: O(V²) for the answer matrix, O(V) for the search stack.

### Drawbacks
- **The same sub-path is rediscovered from scratch for every pair.** In the running example, computing `dist[0][1]` walks `0 → 3 → 2 → 1`. Computing `dist[3][1]` then walks `3 → 2 → 1` all over again — the exact tail we had a moment ago.
- **Nothing is shared between the `V²` searches.** Running a single-source algorithm `V` times (`O(V·E log V)`) removes the factorial, but the sources still cannot help each other: source `0` learns "`3 → 2 → 1` costs 2" and immediately throws it away before source `3` starts.
- The reusable fact is not "the best path from `i`" — it is **"the best path from `i` to `j` that is allowed to pass through this particular set of middle vertices."** Nothing in the brute force has a place to store that.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Number the vertices `0..V-1`, then answer `V` progressively easier-to-reach questions: "what is the best `i → j` route if the only vertices I'm allowed to stop at in the middle are `0..k-1`?" — and each layer is built from the previous one in O(1) per pair.**

Think of it as opening airports one at a time. On day 0 you may only fly non-stop, so `dist[i][j]` is the direct flight price or "no such flight". On day 1 airport `0` opens as a connecting hub, so for every pair you ask a single question: *is `i → 0 → j` cheaper than what I had?* Then airport `1` opens, then `2`… After all `V` airports are open, every route in the graph is available and every entry is final.

### The thought process

```text
We need    : shortest distance for all V^2 ordered pairs.
Obvious way: enumerate paths, or run a single-source search V times.
Too slow   : factorial, or V·E·logV with zero sharing between sources.
Notice     : "the shortest i→j path" is hard to build up. But
             "the shortest i→j path allowed to stop only at vertices 0..k-1"
             has a beautiful one-line recurrence.
Because    : the newly-allowed vertex k is either USED by the best route or not.
             If not used, the answer is the old one. If used, the route splits
             at k into two halves that each only used 0..k-1 — already computed.
Therefore  : min(old answer, i→k plus k→j) — two lookups, one comparison.
Now        : V layers × V^2 pairs × O(1) = O(V^3), five lines of code.
```

### The DP, stated properly

**What does `dp[k][i][j]` mean?**

> The weight of the shortest path from `i` to `j` whose **intermediate** vertices are all drawn from the first `k` vertices `{0, 1, …, k-1}`. The endpoints `i` and `j` are *not* restricted — only the stops in the middle are.

Say it out loud; everything else in this chapter follows from it mechanically.

**How do we compute `dp[k+1][i][j]`?**

Vertex `k` has just been unlocked as a permissible stop. The best `i → j` route using stops from `{0..k}` either uses `k` or it does not:

```text
dp[k+1][i][j] = min( dp[k][i][j],              ← does not stop at k: nothing changed
                     dp[k][i][k] + dp[k][k][j] )  ← stops at k: split the route there
```

The second term is exact, not an approximation: if the route stops at `k`, then the piece before `k` and the piece after `k` each use stops only from `{0..k-1}` (a shortest path never visits `k` twice), which is precisely what layer `k` already knows.

**What is the base case?**

```text
dp[0][i][j] = 0                if i == j        (stay put, costs nothing)
            = weight(i → j)    if the edge exists
            = ∞                otherwise        (no stops allowed ⇒ direct or nothing)
```

`k = 0` means "zero vertices are permitted as intermediates", so `dp[0]` is just the adjacency matrix.

**Why must the `k` loop be OUTERMOST?**

Because layer `k+1` is defined *entirely in terms of layer `k`*. Every one of the `V²` entries of layer `k` must be finished before any entry of layer `k+1` is read. `k` outermost is exactly what enforces that. `i` and `j` inside may run in any order at all.

### What breaks if `k` is innermost

This is the single most common way to get Floyd-Warshall wrong, so let's actually run it. Take the running example (`0→3`, `3→2`, `2→1`, all weight 1) with the loops written the natural-looking but **wrong** way:

```text
for i:  for j:  for k:   dist[i][j] = min(dist[i][j], dist[i][k] + dist[k][j])
```

Walk the `i = 0` block:

| `j` | `k` tried | reads | result |
|-----|-----------|-------|--------|
| 1 | 0 | `dist[0][0] + dist[0][1]` = `0 + ∞` | no |
| 1 | 1 | (trivial) | no |
| 1 | 2 | `dist[0][2] + dist[2][1]` = **`∞`** `+ 1` | no — `dist[0][2]` has not been computed yet! |
| 1 | 3 | `dist[0][3] + dist[3][1]` = `1 +` **`∞`** | no — `dist[3][1]` belongs to the `i = 3` block, which runs later |
| | | | **`dist[0][1]` is left at `∞`** |
| 2 | 3 | `dist[0][3] + dist[3][2]` = `1 + 1` | ✓ `dist[0][2] = 2` — one step too late to help `j = 1` |

The `i` loop then moves to `1, 2, 3` and never returns to row `0`. Final answer: `dist[0][1] = ∞`, when the truth is `3`.

The bug is not an off-by-one — it is that `dp[i][j]` no longer *means* anything. With `k` innermost, `dist[i][k]` and `dist[k][j]` are read at arbitrary half-finished stages, so the table is a mix of layers.

Now the same graph with `k` outermost, which is the correct order:

```text
init (k=0 layer)          after k=2                after k=3
      0  1  2  3               0  1  2  3               0  1  2  3
  0 [ 0  ∞  ∞  1 ]         0 [ 0  ∞  ∞  1 ]         0 [ 0  3  2  1 ]  ✔
  1 [ ∞  0  ∞  ∞ ]         1 [ ∞  0  ∞  ∞ ]         1 [ ∞  0  ∞  ∞ ]
  2 [ ∞  1  0  ∞ ]         2 [ ∞  1  0  ∞ ]         2 [ ∞  1  0  ∞ ]
  3 [ ∞  ∞  1  0 ]         3 [ ∞  2  1  0 ]         3 [ ∞  2  1  0 ]
                            ↑ 3→2→1 found            ↑ 0→3 + (3⇝1)=1+2=3
                              (k = 2 is the stop)      (k = 3 is the stop)
```

Layer `k = 2` discovers the tail `3 ⇝ 1 = 2`, and layer `k = 3` **reuses** it to build `0 ⇝ 1 = 3`. That reuse is exactly the work the brute force threw away.

### Why one 2D array is enough (no `k` dimension needed)

The recurrence reads `dp[k][i][k]` and `dp[k][k][j]` — the `k`-th column and the `k`-th row. Could overwriting them in place corrupt the layer we are still reading?

No, and here is why: `dp[k+1][i][k] = min(dp[k][i][k], dp[k][i][k] + dp[k][k][k])`. Since `dp[k][k][k] = 0`, that is just `dp[k][i][k]` again. **Row `k` and column `k` never change during layer `k`** — a shortest path to `k` would never stop at `k` on the way. So the in-place 2D update is safe, and the whole algorithm is five lines with O(V²) memory.

### Steps

```text
Step 1 → dist = V×V matrix: 0 on the diagonal, edge weights where edges exist, ∞ elsewhere.
Step 2 → for k = 0 .. V-1:                    ← OUTERMOST. This is the DP layer.
Step 3 →     for i = 0 .. V-1:
Step 4 →         if dist[i][k] == ∞: skip the whole j row (i can't reach the hub).
Step 5 →         for j = 0 .. V-1:
Step 6 →             if dist[i][k] + dist[k][j] < dist[i][j]:
Step 7 →                 dist[i][j] = dist[i][k] + dist[k][j]
Step 8 → (optional) any dist[i][i] < 0 ⇒ a negative cycle passes through i.
```

### How should I recognize this?

```text
If you see...
  "all pairs", "between every two", "shortest distance from each to each"
  many queries against a static graph
  a small vertex count: V ≤ 400-ish, V^3 ≈ 6·10^7 is fine
  "transitive closure" / "can A reach B" / "is X an ancestor of Y"
        ↓
Think about...
  "Can I phrase this as: best i→j using only these vertices in the middle?"
        ↓
Use...
  weighted all-pairs shortest path  → dist[i][j] = min(dist[i][j], dist[i][k]+dist[k][j])
  reachability only                 → same loop with OR/AND on booleans
  ratios / products (LC 399)        → replace + with ×, min with "any consistent value"
  max-bottleneck path               → min(dist[i][j], max(dist[i][k], dist[k][j]))
  ONE source and V is large         → Dijkstra or Bellman-Ford instead (ch. 65-66)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-67" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Floyd-Warshall: is going via k shorter than direct i→j?</text>
  <!-- direct edge i -> j (weak) -->
  <line x1="110" y1="180" x2="530" y2="180" stroke="#d97706" stroke-width="2" marker-end="url(#arw-67)"/><text x="320" y="200" text-anchor="middle" fill="#d97706">direct i→j = 9</text>
  <!-- path via k (better) -->
  <line x1="105" y1="160" x2="300" y2="80"  stroke="#059669" stroke-width="2" marker-end="url(#arw-67)"/><text x="180" y="110" text-anchor="middle" fill="#059669" font-weight="700">4</text>
  <line x1="340" y1="80"  x2="535" y2="160" stroke="#059669" stroke-width="2" marker-end="url(#arw-67)"/><text x="460" y="110" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <!-- nodes -->
  <circle cx="80"  cy="175" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="80"  y="180" text-anchor="middle" font-weight="700" fill="#1e293b">i</text>
  <circle cx="320" cy="70"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="320" y="75"  text-anchor="middle" font-weight="700" fill="#1e293b">k</text>
  <circle cx="560" cy="175" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="560" y="180" text-anchor="middle" font-weight="700" fill="#1e293b">j</text>
  <text x="320" y="130" text-anchor="middle" fill="#059669" font-weight="700">via k = 4 + 3 = 7</text>
  <text x="320" y="220" text-anchor="middle" fill="#1e293b" font-weight="700">dist[i][j] = min(9, 7) = 7</text>
</svg>
```

```text
graph: 0 →(1) 3 →(1) 2 →(1) 1        vertex numbering runs against the path

k = 0  hub "0" opens : nobody reaches 0, no change
k = 1  hub "1" opens : 1 leaves nowhere, no change
k = 2  hub "2" opens : 3 → [2] → 1   ⇒  dist[3][1] = 1 + 1 = 2
k = 3  hub "3" opens : 0 → [3] → 1   ⇒  dist[0][1] = 1 + 2 = 3   (reuses k=2's work)
                        0 → [3] → 2   ⇒  dist[0][2] = 1 + 1 = 2

each layer adds ONE legal stopover; after V layers all stopovers are legal
```

### Interview explanation
"Floyd-Warshall is a DP over *which vertices you're allowed to pass through*. I define `dp[k][i][j]` as the shortest `i → j` path whose intermediate vertices all come from the first `k` vertices. Unlocking vertex `k` gives a two-case recurrence: either the best route ignores `k`, which is the old value, or it stops at `k`, in which case it splits into two halves that each already only used the first `k` vertices — so it's `dp[k][i][k] + dp[k][k][j]`. The base case is the adjacency matrix, since `k = 0` allows no stops. The `k` loop has to be outermost because layer `k+1` reads a *complete* layer `k`; with `k` innermost the table mixes layers and produces plain wrong answers. Row and column `k` don't change during layer `k`, so I can drop the `k` dimension and update one V×V matrix in place: O(V³) time, O(V²) space. As a bonus, a negative `dist[i][i]` at the end means a negative cycle through `i`."

---

## 5. Generic Templates

> Three nested loops with `k` on the outside. `k` is the vertex you just unlocked as a legal stopover.

```go
// Inf marks "unreachable". Kept well below MaxInt so Inf + Inf cannot overflow.
const Inf = 1 << 30

// FloydWarshall rewrites dist in place with all-pairs shortest distances.
// dist must start as the adjacency matrix: 0 on the diagonal, the edge weight
// where an edge exists, Inf elsewhere.
func FloydWarshall(dist [][]int) {
    n := len(dist)

    // dp layer k: "intermediate vertices may come from {0..k}".
    // k MUST be outermost: layer k is read in full while building layer k+1.
    for k := 0; k < n; k++ {
        for i := 0; i < n; i++ {
            if dist[i][k] == Inf {
                continue // i cannot reach the hub, so no j can benefit
            }
            viaK := dist[i][k]
            for j := 0; j < n; j++ {
                if dist[k][j] == Inf {
                    continue
                }
                if viaK+dist[k][j] < dist[i][j] {
                    dist[i][j] = viaK + dist[k][j]
                }
            }
        }
    }
}

// HasNegativeCycle reports whether some vertex can return to itself for a
// negative total cost. Call it only after FloydWarshall has run.
func HasNegativeCycle(dist [][]int) bool {
    for i := range dist {
        if dist[i][i] < 0 {
            return true
        }
    }
    return false
}

// NewMatrix builds the base layer (k = 0): direct edges only.
func NewMatrix(n int, edges [][]int, directed bool) [][]int {
    dist := make([][]int, n)
    for i := range dist {
        dist[i] = make([]int, n)
        for j := range dist[i] {
            if i != j {
                dist[i][j] = Inf
            }
        }
    }
    for _, e := range edges {
        u, v, w := e[0], e[1], e[2]
        if w < dist[u][v] {
            dist[u][v] = w // keep the cheapest parallel edge
        }
        if !directed && w < dist[v][u] {
            dist[v][u] = w
        }
    }
    return dist
}
```

```python
INF = float('inf')

def floyd_warshall(dist):
    """dist is the adjacency matrix; rewritten in place with all-pairs distances."""
    n = len(dist)
    # dp layer k: "intermediates may come from {0..k}".
    # k MUST be outermost — layer k is read in full while building layer k+1.
    for k in range(n):
        row_k = dist[k]
        for i in range(n):
            via_k = dist[i][k]
            if via_k == INF:
                continue                       # i cannot reach the hub
            row_i = dist[i]
            for j in range(n):
                if via_k + row_k[j] < row_i[j]:
                    row_i[j] = via_k + row_k[j]
    return dist


def has_negative_cycle(dist):
    """Only meaningful after floyd_warshall has run."""
    return any(dist[i][i] < 0 for i in range(len(dist)))


def new_matrix(n, edges, directed=True):
    """Base layer k = 0: direct edges only."""
    dist = [[0 if i == j else INF for j in range(n)] for i in range(n)]
    for u, v, w in edges:
        dist[u][v] = min(dist[u][v], w)        # keep the cheapest parallel edge
        if not directed:
            dist[v][u] = min(dist[v][u], w)
    return dist
```

```java
public class FloydWarshall {
    public static final int INF = 1 << 30;

    /** Rewrites the adjacency matrix in place with all-pairs shortest distances. */
    public static void solve(int[][] dist) {
        int n = dist.length;
        // k MUST be outermost: layer k is read in full while building layer k+1.
        for (int k = 0; k < n; k++) {
            for (int i = 0; i < n; i++) {
                if (dist[i][k] == INF) continue;   // i cannot reach the hub
                int viaK = dist[i][k];
                for (int j = 0; j < n; j++) {
                    if (dist[k][j] == INF) continue;
                    if (viaK + dist[k][j] < dist[i][j]) {
                        dist[i][j] = viaK + dist[k][j];
                    }
                }
            }
        }
    }

    public static boolean hasNegativeCycle(int[][] dist) {
        for (int i = 0; i < dist.length; i++) if (dist[i][i] < 0) return true;
        return false;
    }
}
```

```cpp
#include <vector>
using namespace std;

const int INF = 1 << 30;

// Rewrites the adjacency matrix in place with all-pairs shortest distances.
void floydWarshall(vector<vector<int>>& dist) {
    int n = (int)dist.size();
    // k MUST be outermost: layer k is read in full while building layer k+1.
    for (int k = 0; k < n; ++k) {
        for (int i = 0; i < n; ++i) {
            if (dist[i][k] == INF) continue;      // i cannot reach the hub
            int viaK = dist[i][k];
            for (int j = 0; j < n; ++j) {
                if (dist[k][j] == INF) continue;
                if (viaK + dist[k][j] < dist[i][j]) {
                    dist[i][j] = viaK + dist[k][j];
                }
            }
        }
    }
}

bool hasNegativeCycle(const vector<vector<int>>& dist) {
    for (size_t i = 0; i < dist.size(); ++i) if (dist[i][i] < 0) return true;
    return false;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Floyd Warshall (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(V + E)** |
| Time (best)  | — | **O(V + E)** |
| Time (average) | — | **O(V + E)** |
| Space | varies | **O(V)** |

> Each vertex and edge processed once for BFS/DFS.

---

## 7. Common Mistakes

1. Marking visited at dequeue instead of enqueue (duplicates, TLE).
2. Using BFS for weighted shortest paths (use Dijkstra).
3. Using Dijkstra with negative edges (use Bellman-Ford).
4. Recursion stack overflow on deep DFS (use iterative).
5. Forgetting to handle disconnected components.
6. Union-find without path compression / union by rank (slow).
7. Topological sort ignoring cycle detection.
8. Off-by-one in node indexing (0 vs 1 based).
9. Not deduplicating edges in an undirected graph.
10. Mutating the graph during traversal.

---

## 8. Interview Follow-Up Questions

1. **Q: BFS vs DFS?**
   A: BFS: shortest unweighted paths/levels. DFS: connectivity, cycles, topo order.

2. **Q: Dijkstra prerequisites?**
   A: Non-negative edge weights; uses a min-heap.

3. **Q: Negative weights?**
   A: Bellman-Ford (and it detects negative cycles).

4. **Q: All-pairs shortest paths?**
   A: Floyd-Warshall O(V^3) for dense/small graphs.

5. **Q: Dynamic connectivity?**
   A: Union-Find with path compression + union by rank.

6. **Q: Topological order?**
   A: Kahn's (indegree queue) or DFS finish times.

7. **Q: Detect cycle (directed)?**
   A: DFS colors or topo-sort leftovers.

8. **Q: Detect cycle (undirected)?**
   A: Union-find or DFS with parent tracking.

9. **Q: Minimum spanning tree?**
   A: Kruskal (union-find) or Prim (heap).

10. **Q: Why O(V+E)?**
   A: Each vertex and edge is examined a constant number of times.

11. **Q: Multi-source BFS?**
   A: Seed all sources at distance 0.

12. **Q: Bipartite check?**
   A: 2-coloring via BFS/DFS.

13. **Q: Strongly connected components?**
   A: Tarjan or Kosaraju.

14. **Q: Shortest path with <= k stops?**
   A: Bellman-Ford limited to k relaxations.

15. **Q: Grid as graph?**
   A: Cells are nodes; 4/8 neighbors are edges.

---

## 9. Solved Example 1

### Problem — City Threshold (LeetCode 1334)
Given `n` cities and weighted **bidirectional** `edges`, find the city that can reach the fewest other cities within `distanceThreshold`. On a tie, return the city with the **greatest** index.

### Thought Process
1. The question is asked about *every* city, so we need all-pairs distances — that is Floyd-Warshall's home turf, and `n <= 100` here makes `O(n³)` trivial.
2. Base layer: `dist[i][i] = 0`, `dist[u][v] = dist[v][u] = w` for each edge (bidirectional ⇒ fill both cells), `INF` elsewhere.
3. Run the three loops with `k` outermost.
4. For each city, count the others with `dist[i][j] <= distanceThreshold`.
5. Scan cities ascending and accept with `<=` rather than `<`, so a later (larger) index overwrites an equal count. That is the tie-break, for free.

### Dry Run

Input: `n = 4`, `edges = [[0,1,3],[1,2,1],[1,3,4],[2,3,1]]`, `distanceThreshold = 4`

```text
        3        1
   0 ─────── 1 ─────── 2
             │         │
           4 │         │ 1
             └─── 3 ───┘
```

`dp[k][i][j]` = shortest `i → j` route allowed to stop only at cities `{0..k-1}`.

| layer | what unlocking this hub changes | matrix after the layer |
|-------|----------------------------------|------------------------|
| base `k=0` | direct edges only | `[[0,3,∞,∞],[3,0,1,4],[∞,1,0,1],[∞,4,1,0]]` |
| hub `0` | only city 1 touches 0, and `1→0→1` is not an improvement | unchanged |
| hub `1` | `0→1→2 = 4`, `0→1→3 = 7`, `2→1→0 = 4`, `3→1→0 = 7` | `[[0,3,4,7],[3,0,1,4],[4,1,0,1],[7,4,1,0]]` |
| hub `2` | `0→2→3 = 4+1 = 5 < 7`, `1→2→3 = 1+1 = 2 < 4`, `3→2→0 = 1+4 = 5 < 7`, `3→2→1 = 1+1 = 2 < 4` | `[[0,3,4,5],[3,0,1,2],[4,1,0,1],[5,2,1,0]]` |
| hub `3` | nothing improves — the table has converged | unchanged ✓ |

Then count, scanning ascending:

| city | row | within 4 (excluding self) | count | best so far |
|------|-----|---------------------------|-------|-------------|
| 0 | `[0,3,4,5]` | `1(3)`, `2(4)` | **2** | city 0 |
| 1 | `[3,0,1,2]` | `0(3)`, `2(1)`, `3(2)` | 3 | city 0 |
| 2 | `[4,1,0,1]` | `0(4)`, `1(1)`, `3(1)` | 3 | city 0 |
| 3 | `[5,2,1,0]` | `2(1)`, `1(2)` | **2** | **city 3** ← `<=` takes the tie |

Output: **`3`**

Hub `2` is where the algorithm earns its keep: `0 ⇝ 3` drops from 7 to 5 because the detour `0 → 1 → 2 → 3` costs `3 + 1 + 1 = 5`. And 5 is *over* the threshold — which is exactly why city 0's count is 2 and not 3.

### Visualization

```text
row 0 of the matrix, layer by layer:

  base   : [ 0   3   ∞   ∞ ]      only the direct edge 0-1
  hub 0  : [ 0   3   ∞   ∞ ]      no change
  hub 1  : [ 0   3   4   7 ]      0 →[1]→ 2  and  0 →[1]→ 3
  hub 2  : [ 0   3   4   5 ]      0 ⇝ 2 (=4) →[2]→ 3   7 → 5
  hub 3  : [ 0   3   4   5 ]      settled
                       ↑   ↑
                    ≤ 4   > 4  ⇒  city 0 reaches exactly 2 cities
```

### Code

```go
func findTheCity(n int, edges [][]int, distanceThreshold int) int {
    const inf = 1 << 30

    // Base layer (k = 0): direct edges only.
    dist := make([][]int, n)
    for i := range dist {
        dist[i] = make([]int, n)
        for j := range dist[i] {
            if i != j {
                dist[i][j] = inf
            }
        }
    }
    for _, e := range edges {
        u, v, w := e[0], e[1], e[2]
        if w < dist[u][v] { // bidirectional: fill both cells
            dist[u][v] = w
            dist[v][u] = w
        }
    }

    // k outermost: layer k must be complete before layer k+1 reads it.
    for k := 0; k < n; k++ {
        for i := 0; i < n; i++ {
            if dist[i][k] == inf {
                continue // i cannot reach the hub
            }
            for j := 0; j < n; j++ {
                if dist[i][k]+dist[k][j] < dist[i][j] {
                    dist[i][j] = dist[i][k] + dist[k][j]
                }
            }
        }
    }

    bestCity, fewest := 0, n+1
    for city := 0; city < n; city++ {
        reach := 0
        for other := 0; other < n; other++ {
            if other != city && dist[city][other] <= distanceThreshold {
                reach++
            }
        }
        if reach <= fewest { // `<=` lets a larger index win an exact tie
            fewest, bestCity = reach, city
        }
    }
    return bestCity
}
```

```python
def findTheCity(n, edges, distanceThreshold):
    INF = float('inf')

    # Base layer (k = 0): direct edges only.
    dist = [[0 if i == j else INF for j in range(n)] for i in range(n)]
    for u, v, w in edges:
        dist[u][v] = min(dist[u][v], w)        # bidirectional: both cells
        dist[v][u] = min(dist[v][u], w)

    # k outermost: layer k must be complete before layer k+1 reads it.
    for k in range(n):
        for i in range(n):
            if dist[i][k] == INF:
                continue
            for j in range(n):
                if dist[i][k] + dist[k][j] < dist[i][j]:
                    dist[i][j] = dist[i][k] + dist[k][j]

    best_city, fewest = 0, n + 1
    for city in range(n):
        reach = sum(1 for j in range(n)
                    if j != city and dist[city][j] <= distanceThreshold)
        if reach <= fewest:                    # `<=` keeps the larger index
            fewest, best_city = reach, city
    return best_city
```

### Complexity
Time O(V³) for the three loops plus O(V²) for the counting. Space O(V²) for the matrix.

---

## 10. Solved Example 2

### Problem — Network Delay (LeetCode 743)
Given directed weighted `times[i] = [u, v, w]` over `n` nodes labelled `1..n`, a signal starts at node `k`. Return the time for **all** nodes to receive it, or `-1` if any node is unreachable.

### Thought Process
1. Only one source is needed, so Dijkstra would be the tighter choice — but with `n <= 100` Floyd-Warshall is fine and it makes the layer idea concrete on a directed graph.
2. Build an `(n+1) × (n+1)` matrix (index 0 unused), `0` on the diagonal, `min` of parallel edge weights, `INF` elsewhere. Directed ⇒ fill **one** cell per edge.
3. Run the three loops with `k` outermost — note the loop variable here is called `hub` so it does not collide with the source, which the problem also calls `k`.
4. Read row `k`: the answer is `max(dist[k][1..n])`, or `-1` if any entry is still `INF`.

### Dry Run

Input: `times = [[2,1,1],[2,3,1],[3,4,1]]`, `n = 4`, `k = 2`

```text
   2 →(1)→ 1
   2 →(1)→ 3 →(1)→ 4
```

Only row `2` matters, so watch it:

| layer | reasoning | row `2` = `[d(2,1), d(2,2), d(2,3), d(2,4)]` |
|-------|-----------|---------------------------------------------|
| base | direct edges `2→1` and `2→3` | `[1, 0, 1, ∞]` |
| hub 1 | node 1 has no outgoing edges | `[1, 0, 1, ∞]` |
| hub 2 | `2 → 2 → j` adds nothing (`dist[2][2] = 0`) | `[1, 0, 1, ∞]` |
| hub 3 | `dist[2][3] + dist[3][4] = 1 + 1 = 2 < ∞` ✓ | `[1, 0, 1, **2**]` |
| hub 4 | node 4 has no outgoing edges | `[1, 0, 1, 2]` |

Output: **`2`** — no `INF` remains, and `max(1, 0, 1, 2) = 2`.

Node 4 is the only entry that needed a hub at all. Had the loops been written with the hub innermost, `dist[2][4]` would be tested against `dist[2][3]` before that cell was guaranteed final — on this tiny graph it happens to survive, but section 4 shows a four-node graph where the same mistake returns `∞`.

### Visualization

```text
signal from node 2, distances after each hub unlocks:

        node:   1    2    3    4
        base :  1    0    1    ∞
        hub1 :  1    0    1    ∞
        hub2 :  1    0    1    ∞
        hub3 :  1    0    1    2     ← 2 →[3]→ 4
        hub4 :  1    0    1    2

        answer = slowest recipient = max(1, 0, 1, 2) = 2
        any ∞ in this row would mean -1
```

### Code

```go
func networkDelayTime(times [][]int, n int, k int) int {
    const inf = 1 << 30

    // Base layer: nodes are 1..n, so size n+1 and ignore index 0.
    dist := make([][]int, n+1)
    for i := range dist {
        dist[i] = make([]int, n+1)
        for j := range dist[i] {
            if i != j {
                dist[i][j] = inf
            }
        }
    }
    for _, t := range times {
        u, v, w := t[0], t[1], t[2]
        if w < dist[u][v] { // directed: only one cell
            dist[u][v] = w
        }
    }

    // `hub` is the DP layer; the problem already uses k for the source.
    for hub := 1; hub <= n; hub++ {
        for i := 1; i <= n; i++ {
            if dist[i][hub] == inf {
                continue
            }
            for j := 1; j <= n; j++ {
                if dist[i][hub]+dist[hub][j] < dist[i][j] {
                    dist[i][j] = dist[i][hub] + dist[hub][j]
                }
            }
        }
    }

    slowest := 0
    for node := 1; node <= n; node++ {
        if dist[k][node] == inf {
            return -1 // this node never hears the signal
        }
        if dist[k][node] > slowest {
            slowest = dist[k][node]
        }
    }
    return slowest
}
```

```python
def networkDelayTime(times, n, k):
    INF = float('inf')

    # Base layer: nodes are 1..n, so size n+1 and ignore index 0.
    dist = [[0 if i == j else INF for j in range(n + 1)] for i in range(n + 1)]
    for u, v, w in times:
        dist[u][v] = min(dist[u][v], w)        # directed: one cell only

    # `hub` is the DP layer; the problem already uses k for the source.
    for hub in range(1, n + 1):
        for i in range(1, n + 1):
            if dist[i][hub] == INF:
                continue
            for j in range(1, n + 1):
                if dist[i][hub] + dist[hub][j] < dist[i][j]:
                    dist[i][j] = dist[i][hub] + dist[hub][j]

    slowest = max(dist[k][1:])
    return -1 if slowest == INF else slowest
```

### Complexity
Time O(V³), Space O(V²). (Dijkstra would be O(E log V) / O(V) — the right call when `V` grows.)

---

## 11. Solved Example 3

### Problem — Evaluate Division (LeetCode 399)
Given equations like `a / b = 2.0`, answer division `queries`. Return the ratio if it can be derived, else `-1.0`.

### Thought Process
1. Variables are vertices; `a / b = v` is a directed edge `a → b` with "weight" `v`, and `b → a` with `1/v`.
2. Chaining ratios **multiplies** them: `a/c = (a/b) × (b/c)`. So it is the same DP with `+` replaced by `×`.
3. There is no "min" — a consistent system gives the same product along every path, so we simply record the first product we can build.
4. `dp[k][i][j]` still means "`i / j` derivable using only the first `k` variables as intermediates", and `k` is still outermost for exactly the same reason.
5. Base case: `ratio[x][x] = 1.0` for every known variable, plus the given edges. Unknown variables have no row → `-1.0`, and that includes `x / x` for an unseen `x`.

### Dry Run

Input: `equations = [["a","b"],["b","c"]]`, `values = [2.0, 3.0]`, `queries = [["a","c"],["b","a"],["a","e"],["x","x"]]`

Base layer (`k = 0`, no intermediates allowed):

```text
        /a     b     c
   a  [ 1     2     ·  ]
   b  [ 0.5   1     3  ]
   c  [ ·     1/3   1  ]          "·" = not derivable yet
```

| hub | pair filled | product | matrix cell |
|-----|-------------|---------|-------------|
| `a` | `b/b` via `a` | `0.5 × 2 = 1` | already 1, no news |
| **`b`** | **`a/c`** | `(a/b) × (b/c) = 2 × 3` | **`ratio[a][c] = 6`** |
| `b` | `c/a` | `(c/b) × (b/a) = 1/3 × 0.5` | `ratio[c][a] = 1/6` |
| `c` | `a/a`, `a/b`, … | `6 × 1/6 = 1`, `6 × 1/3 = 2` | consistent, no news |

Answering the queries:

| query | lookup | answer |
|-------|--------|--------|
| `a / c` | `ratio[a][c]` | **`6.0`** |
| `b / a` | `ratio[b][a]` (base layer) | **`0.5`** |
| `a / e` | `e` was never mentioned | **`-1.0`** |
| `x / x` | `x` was never mentioned — undefined, not 1 | **`-1.0`** |

Output: **`[6.0, 0.5, -1.0, -1.0]`**

The last row is the classic trap: `x / x` is only `1.0` when `x` is a *known* variable. Seeding `ratio[x][x] = 1.0` exclusively for variables that appear in an equation handles it without a special case.

### Visualization

```text
       ×2          ×3
   a ──────▶ b ──────▶ c
     ◀──────   ◀──────
      ×0.5       ×1/3

hub = b unlocks the two-step routes:

   a ⇝ c :  2 × 3   = 6        ← this is dp[k=b][a][c]
   c ⇝ a :  1/3 × 0.5 = 1/6

same recurrence as shortest paths, with (min, +) swapped for (first, ×)
```

### Code

```go
func calcEquation(equations [][]string, values []float64, queries [][]string) []float64 {
    ratio := make(map[string]map[string]float64)

    put := func(a, b string, v float64) {
        if ratio[a] == nil {
            ratio[a] = make(map[string]float64)
        }
        ratio[a][b] = v
    }

    // Base layer: the given edges, their reciprocals, and x/x = 1 for every
    // variable that actually appears.
    for idx, eq := range equations {
        a, b := eq[0], eq[1]
        put(a, a, 1.0)
        put(b, b, 1.0)
        put(a, b, values[idx])
        put(b, a, 1.0/values[idx])
    }

    nodes := make([]string, 0, len(ratio))
    for name := range ratio {
        nodes = append(nodes, name)
    }
    sort.Strings(nodes) // any fixed hub order works; sorting keeps runs reproducible

    // k (here: hub) outermost, exactly as in the numeric version.
    for _, hub := range nodes {
        for _, i := range nodes {
            iHub, ok := ratio[i][hub]
            if !ok {
                continue // i / hub is not derivable yet
            }
            for _, j := range nodes {
                if hubJ, ok := ratio[hub][j]; ok {
                    ratio[i][j] = iHub * hubJ // chaining ratios multiplies
                }
            }
        }
    }

    answers := make([]float64, len(queries))
    for idx, q := range queries {
        answers[idx] = -1.0
        if row, ok := ratio[q[0]]; ok {
            if v, ok := row[q[1]]; ok {
                answers[idx] = v
            }
        }
    }
    return answers
}
```

```python
def calcEquation(equations, values, queries):
    ratio = {}

    def put(a, b, v):
        ratio.setdefault(a, {})[b] = v

    # Base layer: given edges, reciprocals, and x/x = 1 for known variables.
    for (a, b), v in zip(equations, values):
        put(a, a, 1.0)
        put(b, b, 1.0)
        put(a, b, v)
        put(b, a, 1.0 / v)

    nodes = sorted(ratio)                      # any fixed hub order works

    for hub in nodes:                          # hub == k, and it is outermost
        for i in nodes:
            if hub not in ratio[i]:
                continue
            i_hub = ratio[i][hub]
            for j in nodes:
                if j in ratio[hub]:
                    ratio[i][j] = i_hub * ratio[hub][j]   # chaining multiplies

    return [ratio.get(c, {}).get(d, -1.0) for c, d in queries]
```

### Complexity
Time O(V³ + Q) where `V` is the number of distinct variables and `Q` the number of queries. Space O(V²) for the ratio table.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1334 | City Threshold | Easy | Core graphs application |
| 743 | Network Delay | Easy | Core graphs application |
| 399 | Evaluate Division | Medium | Core graphs application |
| 2642 | Graph Routes | Medium | Core graphs application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **BFS / DFS**
- **Topological sort**
- **Union-Find**
- **Dijkstra**
- **Bellman-Ford**
- **Floyd-Warshall**
- **MST (Kruskal/Prim)**

---

## 14. Production Engineering Applications

- **Scalability:** Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(V)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Floyd Warshall logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Floyd Warshall (Graphs).
- **Signal:** floyd warshall, all pairs, shortest path, dp, transitive closure.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Floyd Warshall invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Floyd Warshall
FAMILY : Graphs (Expert)
WHEN   : floyd warshall, all pairs, shortest path, dp, transitive closure
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 1334, 743, 399, 2642
```

---

*Part of the DSA Patterns Handbook — pattern 67 of 100.*
