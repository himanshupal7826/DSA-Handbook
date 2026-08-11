# 66 · Bellman Ford

> **One-liner:** Relax all edges V-1 times; handles negative weights & detects cycles.

---

## 1. Overview

### Definition
The **Bellman Ford** pattern belongs to the *Graphs* family. Relax all edges V-1 times; handles negative weights & detects cycles.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
bellman ford, negative edges, shortest path, relax, negative cycle.

### Constraints
- Input size where the brute-force complexity would time out — the Bellman Ford optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Bellman Ford invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Bellman Ford is the upgrade.
- The wording maps onto: bellman ford, negative edges, shortest path, relax, negative cycle.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the cheapest route from the source to every node, when some edges are allowed to make the trip **cheaper**?"*

Running example (used for the whole chapter) — 4 nodes, and the edge list is deliberately in an awkward order:

```text
edges, in the order the algorithm will scan them:
  e0 : 2 → 3   weight  1
  e1 : 1 → 2   weight -2
  e2 : 0 → 1   weight  4

source = 0        true answer: dist = [0, 4, 2, 3]
```

### Intuition
List every path from the source to the target, add up its weights, and keep the smallest total. No cleverness — just enumerate.

### Algorithm
1. Start a walk at `src` with cost `0`.
2. From the current node, try every outgoing edge whose destination is not already on the walk (paths that revisit a node are not simple).
3. When the walk reaches the target, record its total cost.
4. Return the smallest cost recorded.

### Complexity
- Time: **O(V!)** — in a dense graph the number of simple paths between two nodes grows factorially.
- Space: O(V) for the recursion stack, O(V) for the "on the current walk" marks.

### Drawbacks
- **The same prefix is re-added over and over.** With 100 paths that all begin `0 → 1 → 2`, that three-edge prefix is summed 100 times. Only its *total* ever mattered.
- **It never reuses a solved sub-answer.** Once we know the cheapest way to reach node `1` is 4, every path through `1` should start from the number 4 — not rebuild it.
- **It has no stopping rule.** Enumeration cannot tell "there is no cheapest path here because a negative cycle lets you loop forever and keep getting cheaper" apart from "I haven't looked hard enough yet".

The fix for all three is the same: stop tracking *paths* and start tracking, for each node, **one number — the best cost known so far** — and let edges improve it.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A shortest path can contain at most `V-1` edges, so `V-1` sweeps of "try every edge as a path's next step" must find it — and if a `V`-th sweep still improves something, a negative cycle exists.**

Think of it as gossip spreading through a town. Each round, everyone tells all their neighbours the cheapest price they know. After one round, prices that are one handshake away are correct. After two rounds, two handshakes. Nobody's true best price is more than `V-1` handshakes away, so after `V-1` rounds everyone is correct — unless there's a scam loop that lowers the price every time you go around it, which is exactly what round `V` detects.

### The thought process

```text
We need    : the cheapest cost from src to every node, with negative weights allowed.
Obvious way: enumerate every simple path.
Too slow   : O(V!), and it re-adds the same prefixes forever.
Notice     : a path's cost only depends on (cost to the previous node) + (last edge).
             So one number per node is enough state — call it dist[v].
Notice too : "dist[u] + w < dist[v]  →  dist[v] = dist[u] + w" is the ONLY operation
             we ever need. It is called a *relaxation*.
Problem    : in what order do we relax? Dijkstra's order (cheapest-first) breaks
             when a later, negative edge can undercut an already-settled node.
Therefore  : don't pick an order. Relax EVERY edge, then do it again, V-1 times.
Now        : O(V·E), correct with negative weights, and round V is a free
             negative-cycle detector.
```

### Why exactly `V-1` rounds — no more, no less

This is the whole chapter. Two facts, one after the other.

**Fact 1 — after round `r`, `dist[v]` is correct for every path that uses at most `r` edges.**

Proof by walking one round forward. Before any round, `dist[src] = 0` is the correct answer over paths of 0 edges. Now suppose it holds after round `r-1`, and let `P` be the cheapest path to `v` using at most `r` edges:

```text
P  =  src ⇝ u  (at most r-1 edges)  +  edge u→v

By assumption, dist[u] ≤ cost(src ⇝ u) already, before round r starts.
Round r scans EVERY edge, so it scans u→v, and performs
        dist[v] ← min(dist[v], dist[u] + w(u,v))  ≤  cost(P).
```

We never had to know *which* edge was the last one — sweeping all of them guarantees the right one was tried. That is why the naive "relax everything, blindly" works, and it is why the edge order inside a round does not matter for correctness.

**Fact 2 — a shortest path never needs more than `V-1` edges.**

If a path visits a node twice, it contains a cycle. With no negative cycle, deleting that cycle cannot make the path more expensive — so there is always a *simple* cheapest path. A simple path touches at most `V` distinct nodes, and `V` nodes are joined by `V-1` edges.

Put the two together: after `V-1` rounds, `dist` is correct over paths of up to `V-1` edges, which is all the paths that matter. **Done.**

Watch it happen on the running example. The edge order is the worst possible — each round manages to settle exactly one more edge of the chain `0→1→2→3`:

```text
start    dist = [0,  ∞,  ∞,  ∞]
round 1  e0(2→3): dist[2]=∞, skip.  e1(1→2): dist[1]=∞, skip.  e2(0→1): 0+4=4  ✓
         dist = [0,  4,  ∞,  ∞]      ← paths of ≤1 edge are now correct
round 2  e0: dist[2] still ∞, skip.  e1(1→2): 4+(-2)=2  ✓.  e2: 0+4=4, no gain.
         dist = [0,  4,  2,  ∞]      ← paths of ≤2 edges are now correct
round 3  e0(2→3): 2+1=3  ✓.  e1, e2: no gain.
         dist = [0,  4,  2,  3]      ← paths of ≤3 edges = V-1 = done
```

Three rounds for `V = 4`. Not a coincidence — a chain of `V-1` edges scanned backwards is precisely the worst case that makes the bound tight.

**And why not fewer?** Stop after 2 rounds and `dist[3]` is still `∞`. **Why not more?** Round 4 would change nothing — because by Fact 2 there is nothing left to find.

### Why round `V` proves a negative cycle

Run one extra round. If some edge still relaxes, then there is a walk to that node **cheaper than every path of `V-1` edges**, so it uses at least `V` edges, so it touches at least `V+1` nodes, so — with only `V` nodes to go around — **it repeats a node**. It contains a cycle, and since removing that cycle would have given a shorter path with fewer edges (contradiction), the cycle's total weight must be **negative**.

Add `3 → 1` with weight `-4` to the running example and the loop `1 → 2 → 3 → 1` costs `-2 + 1 - 4 = -5`:

```text
round 4 : e_new(3→1): dist[3] + (-4) = 3 - 4 = -1 < dist[1] = 4  → still relaxing!
          ⇒ negative cycle reachable from the source.
```

Note the wording: *reachable from the source*. Nodes with `dist == ∞` are skipped, so a negative cycle in a disconnected corner of the graph is invisible — which is usually what you want. To find negative cycles anywhere, seed `dist[v] = 0` for all `v`.

### Why Dijkstra cannot just be patched

Dijkstra's whole promise is "the unsettled node with the smallest `dist` is final". One negative edge destroys it:

```text
S →A  weight 1
S →B  weight 2
B →A  weight -2          true dist[A] = 2 + (-2) = 0

Dijkstra pops A first (1 < 2), stamps dist[A] = 1 as FINAL, and never revisits it.
Bellman-Ford has no "final" — round 2 simply relaxes B→A and fixes A to 0.
```

Refusing to commit is exactly the price Bellman-Ford pays (`O(V·E)` instead of `O(E log V)`) and exactly the power it buys.

### Steps

```text
Step 1 → dist[] = +∞ for all nodes; dist[src] = 0.
Step 2 → Repeat V-1 times:
Step 3 →     changed = false
Step 4 →     for every edge (u, v, w):
Step 5 →         if dist[u] != ∞ and dist[u] + w < dist[v]:
Step 6 →             dist[v] = dist[u] + w ; changed = true
Step 7 →     if not changed: stop early — a fixed point can never move again.
Step 8 → One more sweep: if any edge still relaxes → negative cycle. Else dist is final.
```

The `dist[u] != ∞` guard is not cosmetic: `∞ + (-5)` in fixed-width integers is a large negative number that would poison the whole table.

### How should I recognize this?

```text
If you see...
  "shortest path" + weights that can be NEGATIVE
  "detect a negative cycle" / "arbitrage" / "is the profit unbounded"
  "at most k stops" / "using at most k edges"
  tiny V (≤ a few hundred) but the statement forbids Dijkstra
        ↓
Think about...
  "Can I stop caring about the ORDER of relaxations
   and just sweep every edge a bounded number of times?"
        ↓
Use...
  plain shortest path, negatives allowed → V-1 sweeps of all edges
  need a negative-cycle answer           → run sweep number V and see if it moves
  "at most k edges"                      → exactly k sweeps, each off a FROZEN copy
  all-pairs and V is small               → Floyd-Warshall instead (chapter 67)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-66" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Bellman-Ford: relax every edge V-1 times (negatives OK)</text>
  <!-- edges with weights -->
  <line x1="94"  y1="105" x2="206" y2="75"  stroke="#475569" marker-end="url(#arw-66)"/><text x="150" y="78"  text-anchor="middle" fill="#64748b">6</text>
  <line x1="94"  y1="120" x2="206" y2="160" stroke="#475569" marker-end="url(#arw-66)"/><text x="150" y="155" text-anchor="middle" fill="#64748b">7</text>
  <line x1="254" y1="90"  x2="336" y2="150" stroke="#d97706" stroke-width="2" marker-end="url(#arw-66)"/><text x="270" y="135" text-anchor="middle" fill="#d97706" font-weight="700">-3</text>
  <line x1="256" y1="160" x2="558" y2="120" stroke="#475569" marker-end="url(#arw-66)"/><text x="410" y="150" text-anchor="middle" fill="#64748b">9</text>
  <!-- nodes -->
  <circle cx="70"  cy="115" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="70"  y="120" text-anchor="middle" font-weight="700" fill="#1e293b">S</text><text x="70"  y="160" text-anchor="middle" fill="#059669">0</text>
  <circle cx="230" cy="65"  r="22" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="70"  text-anchor="middle" font-weight="700" fill="#1e293b">A</text><text x="230" y="38" text-anchor="middle" fill="#64748b">6</text>
  <circle cx="230" cy="170" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="175" text-anchor="middle" font-weight="700" fill="#1e293b">B</text><text x="197" y="175" text-anchor="middle" fill="#64748b">7</text>
  <circle cx="360" cy="170" r="22" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="360" y="175" text-anchor="middle" font-weight="700" fill="#1e293b">C</text><text x="360" y="212" text-anchor="middle" fill="#d97706">3</text>
  <circle cx="580" cy="115" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="580" y="120" text-anchor="middle" font-weight="700" fill="#1e293b">D</text><text x="580" y="160" text-anchor="middle" fill="#64748b">12</text>
  <text x="470" y="205" text-anchor="middle" fill="#d97706" font-weight="700">relax A→C: 6 + (-3) = 3 &lt; ∞</text>
</svg>
```

```text
edge scan order:  e0(2→3,1)   e1(1→2,-2)   e2(0→1,4)

           node:   0     1     2     3
        start  :   0     ∞     ∞     ∞
        round 1:   0     4     ∞     ∞      one edge deep
        round 2:   0     4     2     ∞      two edges deep
        round 3:   0     4     2     3      three edges deep = V-1  ✔
        round 4:   0     4     2     3      unchanged ⇒ no negative cycle

each round pushes the frontier exactly one edge further, worst case
```

### Interview explanation
"Because edges can be negative, Dijkstra's 'smallest unsettled distance is final' invariant breaks — a cheap edge discovered later can undercut a node I already committed to. Bellman-Ford drops the commitment entirely: it just relaxes every edge, `V-1` times. The reason `V-1` is enough is that after round `r`, every distance achievable with `r` edges is correct, and a shortest path is simple, so it has at most `V-1` edges. Then I run one extra round: if anything still improves, the improving walk must have `V` or more edges, so it repeats a vertex, so it rides a negative cycle. That's `O(V·E)` time and `O(V)` space, and I keep a `changed` flag to exit early when the table stops moving."

---

## 5. Generic Templates

> Relax every edge, `V-1` times. Then relax once more — if anything moves, a negative cycle is reachable.

```go
// Edge is a directed edge From -> To; Weight may be negative.
type Edge struct {
    From, To, Weight int
}

// Inf marks "no route known yet". Kept well below MaxInt so that Inf + weight
// cannot overflow.
const Inf = 1 << 30

// BellmanFord returns the shortest distance from src to every vertex, plus a
// flag saying whether a negative cycle is reachable from src. Vertices with no
// route keep the value Inf.
func BellmanFord(n int, edges []Edge, src int) ([]int, bool) {
    dist := make([]int, n)
    for i := range dist {
        dist[i] = Inf
    }
    dist[src] = 0

    // After round r, dist is optimal over all paths of at most r edges.
    // A shortest path is simple, so n-1 rounds cover every path that matters.
    for round := 0; round < n-1; round++ {
        changed := false
        for _, e := range edges {
            if dist[e.From] == Inf {
                continue // nothing to extend, and Inf+w would overflow
            }
            if dist[e.From]+e.Weight < dist[e.To] {
                dist[e.To] = dist[e.From] + e.Weight
                changed = true
            }
        }
        if !changed {
            return dist, false // fixed point: no later round can move it either
        }
    }

    // Round n. Any improvement now needs >= n edges, so it repeats a vertex,
    // so it rides a cycle of negative total weight.
    for _, e := range edges {
        if dist[e.From] != Inf && dist[e.From]+e.Weight < dist[e.To] {
            return dist, true
        }
    }
    return dist, false
}

// BellmanFordAtMostK is the "at most k edges" variant. Each round must relax
// off a frozen snapshot, otherwise a single round could chain two edges.
func BellmanFordAtMostK(n int, edges []Edge, src, k int) []int {
    dist := make([]int, n)
    for i := range dist {
        dist[i] = Inf
    }
    dist[src] = 0

    for round := 0; round < k; round++ {
        next := make([]int, n)
        copy(next, dist) // snapshot: reads come from the PREVIOUS round only
        for _, e := range edges {
            if dist[e.From] != Inf && dist[e.From]+e.Weight < next[e.To] {
                next[e.To] = dist[e.From] + e.Weight
            }
        }
        dist = next
    }
    return dist
}
```

```python
INF = float('inf')

def bellman_ford(n, edges, src):
    """edges: list of (u, v, w). Returns (dist, negative_cycle_reachable)."""
    dist = [INF] * n
    dist[src] = 0

    # After round r, dist is optimal over all paths of at most r edges.
    for _ in range(n - 1):
        changed = False
        for u, v, w in edges:
            if dist[u] == INF:
                continue                      # nothing to extend
            if dist[u] + w < dist[v]:
                dist[v] = dist[u] + w
                changed = True
        if not changed:
            return dist, False                # fixed point reached early

    # Round n: any further gain needs >= n edges -> repeats a vertex -> cycle.
    for u, v, w in edges:
        if dist[u] != INF and dist[u] + w < dist[v]:
            return dist, True
    return dist, False


def bellman_ford_at_most_k(n, edges, src, k):
    """Cheapest cost using at most k edges: k rounds off a frozen snapshot."""
    dist = [INF] * n
    dist[src] = 0
    for _ in range(k):
        nxt = dist[:]                         # reads come from the previous round
        for u, v, w in edges:
            if dist[u] != INF and dist[u] + w < nxt[v]:
                nxt[v] = dist[u] + w
        dist = nxt
    return dist
```

```java
import java.util.*;

public class BellmanFord {
    public static final int INF = 1 << 30;

    /** dist[] in result[0]; result[1][0] == 1 iff a negative cycle is reachable. */
    public static int[][] shortestPaths(int n, int[][] edges, int src) {
        int[] dist = new int[n];
        Arrays.fill(dist, INF);
        dist[src] = 0;

        // After round r, dist is optimal over all paths of at most r edges.
        for (int round = 0; round < n - 1; round++) {
            boolean changed = false;
            for (int[] e : edges) {
                if (dist[e[0]] == INF) continue;      // nothing to extend
                if (dist[e[0]] + e[2] < dist[e[1]]) {
                    dist[e[1]] = dist[e[0]] + e[2];
                    changed = true;
                }
            }
            if (!changed) return new int[][]{dist, {0}};
        }

        // Round n: still improving means the walk repeats a vertex.
        for (int[] e : edges) {
            if (dist[e[0]] != INF && dist[e[0]] + e[2] < dist[e[1]]) {
                return new int[][]{dist, {1}};
            }
        }
        return new int[][]{dist, {0}};
    }
}
```

```cpp
#include <vector>
using namespace std;

const int INF = 1 << 30;

// Returns shortest distances from src; sets negativeCycle if one is reachable.
vector<int> bellmanFord(int n, const vector<vector<int>>& edges, int src,
                        bool& negativeCycle) {
    vector<int> dist(n, INF);
    dist[src] = 0;
    negativeCycle = false;

    // After round r, dist is optimal over all paths of at most r edges.
    for (int round = 0; round < n - 1; ++round) {
        bool changed = false;
        for (const auto& e : edges) {
            if (dist[e[0]] == INF) continue;      // nothing to extend
            if (dist[e[0]] + e[2] < dist[e[1]]) {
                dist[e[1]] = dist[e[0]] + e[2];
                changed = true;
            }
        }
        if (!changed) return dist;                // fixed point reached early
    }

    // Round n: still improving means the walk repeats a vertex.
    for (const auto& e : edges) {
        if (dist[e[0]] != INF && dist[e[0]] + e[2] < dist[e[1]]) {
            negativeCycle = true;
            break;
        }
    }
    return dist;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Bellman Ford (Optimal) |
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

### Problem — K Stops (LeetCode 787)
Given `n` cities and `flights[i] = [from, to, price]`, return the cheapest price from `src` to `dst` using **at most `k` stops**, or `-1`. "At most `k` stops" means at most `k + 1` flights, i.e. at most `k + 1` edges.

### Thought Process
1. "At most `k + 1` edges" is literally Fact 1 from section 4 — after round `r`, `dist` is optimal over paths of at most `r` edges. So run exactly `k + 1` rounds instead of `V - 1`.
2. `dist[v]` = cheapest price to reach `v` using at most (rounds run so far) flights. Start `dist[src] = 0`, everything else `∞`.
3. Each round must read from a **frozen snapshot** of the previous round. Otherwise an edge relaxed earlier in the same sweep could immediately feed the next edge, chaining two flights into one round and blowing the stop budget.
4. Skip any edge whose source is still `∞` — there is nothing to extend, and `∞ + price` would overflow.
5. After `k + 1` rounds, `dist[dst]` is the answer, or `-1` if it is still `∞`.

### Dry Run

Input: `n = 3`, `flights = [[0,1,100],[1,2,100],[0,2,500]]`, `src = 0`, `dst = 2`, `k = 1` → **2 rounds**

| round | edge scanned | `dist[u]` (frozen) | test | `next` after the edge |
|-------|--------------|--------------------|------|------------------------|
| — | *init* | — | — | `[0, ∞, ∞]` |
| 1 | `0→1` (100) | `dist[0] = 0` | `0+100 = 100 < ∞` ✓ | `[0, 100, ∞]` |
| 1 | `1→2` (100) | `dist[1] = ∞` | skip — nothing to extend | `[0, 100, ∞]` |
| 1 | `0→2` (500) | `dist[0] = 0` | `0+500 = 500 < ∞` ✓ | `[0, 100, 500]` |
| | *end of round 1* | | | `dist = [0, 100, 500]` — best with **≤ 1 flight** |
| 2 | `0→1` (100) | `dist[0] = 0` | `100 < 100`? no | `[0, 100, 500]` |
| 2 | `1→2` (100) | `dist[1] = 100` | `100+100 = 200 < 500` ✓ | `[0, 100, 200]` |
| 2 | `0→2` (500) | `dist[0] = 0` | `500 < 200`? no | `[0, 100, 200]` |
| | *end of round 2* | | | `dist = [0, 100, 200]` — best with **≤ 2 flights** |

Output: **`200`** (route `0 → 1 → 2`, one stop)

Look at row 2 of round 1. The snapshot is doing the work: `1→2` was scanned *after* `0→1` had already written `100` into `next[1]`, but the test reads `dist[1]`, which is still `∞`. Without the snapshot, `dist[2]` would have become `200` in round **1** — and for `k = 0` (a single round, no stops allowed) the function would return `200` instead of the correct `500`.

### Visualization

```text
"at most r flights" is exactly "after r rounds"

  after round 1 (≤1 flight)      after round 2 (≤2 flights)
        0                              0
      /   \                          /   \
   100     500                    100     500
    ↓        ↓                     ↓        ↓
   [1]      [2]                   [1]      [2]=500
  dist=100  dist=500               \        ↑
                                    +100 ──┘   200 < 500  ✔
                                   dist[2] = 200
```

### Code

```go
func findCheapestPrice(n int, flights [][]int, src int, dst int, k int) int {
    const inf = 1 << 30

    dist := make([]int, n)
    for i := range dist {
        dist[i] = inf
    }
    dist[src] = 0

    // k stops = at most k+1 edges = exactly k+1 relaxation rounds.
    for round := 0; round < k+1; round++ {
        next := make([]int, n)
        copy(next, dist) // frozen: every test reads the PREVIOUS round's values

        for _, f := range flights {
            from, to, price := f[0], f[1], f[2]
            if dist[from] == inf {
                continue // no route to `from` yet within the budget
            }
            if dist[from]+price < next[to] {
                next[to] = dist[from] + price
            }
        }
        dist = next
    }

    if dist[dst] == inf {
        return -1
    }
    return dist[dst]
}
```

```python
def findCheapestPrice(n, flights, src, dst, k):
    INF = float('inf')
    dist = [INF] * n
    dist[src] = 0

    for _ in range(k + 1):                 # k stops = at most k+1 edges
        nxt = dist[:]                      # frozen snapshot of the last round
        for u, v, price in flights:
            if dist[u] == INF:
                continue                   # nothing to extend
            if dist[u] + price < nxt[v]:
                nxt[v] = dist[u] + price
        dist = nxt

    return -1 if dist[dst] == INF else dist[dst]
```

### Complexity
Time O((k+1)·E) — one full edge sweep per allowed flight. Space O(V) for `dist` plus the one-round snapshot.

---

## 10. Solved Example 2

### Problem — Network Delay (LeetCode 743)
Given directed travel times `times[i] = [u, v, w]` over `n` nodes labelled `1..n` and a source `k`, return how long it takes for a signal to reach **all** nodes, or `-1` if some node is unreachable.

### Thought Process
1. A signal reaching everyone takes as long as its **slowest** recipient, so the answer is `max(dist[1..n])` after shortest paths from `k`.
2. All weights are non-negative here, so no snapshot is needed — relaxations may cascade freely within a round. That only ever makes convergence *faster*.
3. Run at most `n - 1` rounds (Fact 2), with a `changed` flag so we stop the moment the table reaches a fixed point.
4. If any `dist` is still `∞`, that node never hears the signal → `-1`.

### Dry Run

Input: `times = [[3,4,1],[2,3,1],[2,1,1]]`, `n = 4`, `k = 2`

The edge list is deliberately in an unhelpful order (the `3→4` edge is scanned first, before `3` is even reachable) so you can watch the rounds do real work.

| round | edge | test | `dist[1..4]` after | changed? |
|-------|------|------|--------------------|----------|
| — | *init* | `dist[2] = 0` | `[∞, 0, ∞, ∞]` | — |
| 1 | `3→4` (1) | `dist[3] = ∞` → skip | `[∞, 0, ∞, ∞]` | |
| 1 | `2→3` (1) | `0+1 = 1 < ∞` ✓ | `[∞, 0, 1, ∞]` | yes |
| 1 | `2→1` (1) | `0+1 = 1 < ∞` ✓ | `[1, 0, 1, ∞]` | yes |
| 2 | `3→4` (1) | `1+1 = 2 < ∞` ✓ | `[1, 0, 1, 2]` | yes |
| 2 | `2→3` (1) | `1 < 1`? no | `[1, 0, 1, 2]` | |
| 2 | `2→1` (1) | `1 < 1`? no | `[1, 0, 1, 2]` | |
| 3 | all three | nothing improves | `[1, 0, 1, 2]` | **no → break** |

Output: **`2`** — `max(1, 0, 1, 2) = 2`, and no `∞` remains.

Round 1 could only reach one edge deep; node `4` is two edges from the source, so it *had* to wait for round 2. Round 3 is where the `changed` flag pays off: it proves the table has settled and exits `n-1` rounds early.

### Visualization

```text
       (2)
      /   \        w=1 both
    1      3
            \      w=1
             4

frontier growth, one edge per round:
  round 0 :  {2}                    dist 0
  round 1 :  {2} ∪ {1, 3}           dist 1, 1
  round 2 :  {2, 1, 3} ∪ {4}        dist 2          ← slowest recipient
  round 3 :  no change → settled

answer = the largest finalized dist = 2
```

### Code

```go
func networkDelayTime(times [][]int, n int, k int) int {
    const inf = 1 << 30

    dist := make([]int, n+1) // nodes are 1..n; index 0 is unused
    for i := range dist {
        dist[i] = inf
    }
    dist[k] = 0

    // Weights are non-negative, so plain in-place relaxation is fine.
    for round := 0; round < n-1; round++ {
        changed := false
        for _, t := range times {
            from, to, w := t[0], t[1], t[2]
            if dist[from] == inf {
                continue
            }
            if dist[from]+w < dist[to] {
                dist[to] = dist[from] + w
                changed = true
            }
        }
        if !changed {
            break // fixed point: later rounds cannot move anything
        }
    }

    slowest := 0
    for node := 1; node <= n; node++ {
        if dist[node] == inf {
            return -1 // this node never receives the signal
        }
        if dist[node] > slowest {
            slowest = dist[node]
        }
    }
    return slowest
}
```

```python
def networkDelayTime(times, n, k):
    INF = float('inf')
    dist = [INF] * (n + 1)                 # nodes are 1..n
    dist[k] = 0

    for _ in range(n - 1):
        changed = False
        for u, v, w in times:
            if dist[u] == INF:
                continue
            if dist[u] + w < dist[v]:
                dist[v] = dist[u] + w
                changed = True
        if not changed:
            break                          # fixed point reached early

    slowest = max(dist[1:])
    return -1 if slowest == INF else slowest
```

### Complexity
Time O(V·E) worst case — `V-1` sweeps of `E` edges, often far fewer thanks to the `changed` flag. Space O(V).

---

## 11. Solved Example 3

### Problem — City Threshold (LeetCode 1334)
Given `n` cities and weighted **undirected** `edges`, find the city that can reach the fewest other cities within `distanceThreshold`. On a tie, return the city with the **greatest** index.

### Thought Process
1. This is all-pairs shortest paths, but with a small `n` we can simply run single-source Bellman-Ford `n` times, once per city.
2. Undirected means each edge relaxes **both ways**: try `u → v` and `v → u` on every scan.
3. For a source, count the cities `j ≠ src` with `dist[j] <= distanceThreshold`.
4. Scan cities in ascending order and accept with `<=` rather than `<`. A later (larger) index with an equal count therefore overwrites the earlier one — that is the tie-break, for free.

### Dry Run

Input: `n = 4`, `edges = [[0,1,3],[1,2,1],[1,3,4],[2,3,1]]`, `distanceThreshold = 4`

```text
        3        1
   0 ─────── 1 ─────── 2
             │         │
           4 │         │ 1
             └─── 3 ───┘
```

| source | shortest distances `[d0,d1,d2,d3]` | within 4 (excluding self) | count | best-so-far |
|--------|-------------------------------------|---------------------------|-------|-------------|
| 0 | `[0, 3, 4, 5]` | `1(3)`, `2(4)` | **2** | city 0, count 2 |
| 1 | `[3, 0, 1, 2]` | `0(3)`, `2(1)`, `3(2)` | 3 | city 0, count 2 |
| 2 | `[4, 1, 0, 1]` | `0(4)`, `1(1)`, `3(1)` | 3 | city 0, count 2 |
| 3 | `[5, 2, 1, 0]` | `2(1)`, `1(2)` | **2** | **city 3**, count 2 |

Output: **`3`**

The last row is the tie-break in action: city 3 ties city 0 at count 2, and because the test is `count <= fewest` it replaces city 0. Two distances worth checking by hand: from `0`, city `3` costs `min(0→1→3 = 3+4 = 7, 0→1→2→3 = 3+1+1 = 5) = 5`, which is **over** the threshold — that is exactly why city 0's count is 2 and not 3.

### Visualization

```text
run Bellman-Ford once per source, then just count:

 src=0 : [0, 3, 4, 5]   ≤4 → · ✓ ✓ ✗   count 2   ← tie
 src=1 : [3, 0, 1, 2]   ≤4 → ✓ · ✓ ✓   count 3
 src=2 : [4, 1, 0, 1]   ≤4 → ✓ ✓ · ✓   count 3
 src=3 : [5, 2, 1, 0]   ≤4 → ✗ ✓ ✓ ·   count 2   ← tie, larger index wins

scan ascending with `<=`  ⇒  the last minimum seen is the largest index
```

### Code

```go
func bellmanFordUndirected(n int, edges [][]int, src int) []int {
    const inf = 1 << 30

    dist := make([]int, n)
    for i := range dist {
        dist[i] = inf
    }
    dist[src] = 0

    for round := 0; round < n-1; round++ {
        changed := false
        for _, e := range edges {
            u, v, w := e[0], e[1], e[2]
            if dist[u] != inf && dist[u]+w < dist[v] { // u -> v
                dist[v] = dist[u] + w
                changed = true
            }
            if dist[v] != inf && dist[v]+w < dist[u] { // v -> u (undirected)
                dist[u] = dist[v] + w
                changed = true
            }
        }
        if !changed {
            break
        }
    }
    return dist
}

func findTheCity(n int, edges [][]int, distanceThreshold int) int {
    bestCity, fewest := 0, n+1

    for city := 0; city < n; city++ {
        dist := bellmanFordUndirected(n, edges, city)

        reach := 0
        for other := 0; other < n; other++ {
            if other != city && dist[other] <= distanceThreshold {
                reach++
            }
        }

        // `<=` means a later (larger) index wins an exact tie.
        if reach <= fewest {
            fewest, bestCity = reach, city
        }
    }
    return bestCity
}
```

```python
def findTheCity(n, edges, distanceThreshold):
    INF = float('inf')

    def bellman_ford(src):
        dist = [INF] * n
        dist[src] = 0
        for _ in range(n - 1):
            changed = False
            for u, v, w in edges:              # undirected: relax both ways
                if dist[u] != INF and dist[u] + w < dist[v]:
                    dist[v] = dist[u] + w
                    changed = True
                if dist[v] != INF and dist[v] + w < dist[u]:
                    dist[u] = dist[v] + w
                    changed = True
            if not changed:
                break
        return dist

    best_city, fewest = 0, n + 1
    for city in range(n):
        dist = bellman_ford(city)
        reach = sum(1 for j in range(n)
                    if j != city and dist[j] <= distanceThreshold)
        if reach <= fewest:                    # `<=` keeps the larger index
            fewest, best_city = reach, city
    return best_city
```

### Complexity
Time O(V²·E) — one Bellman-Ford (`O(V·E)`) per source. Space O(V) per run. For denser inputs, Floyd-Warshall's O(V³) (chapter 67) is the usual choice.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 787 | K Stops | Easy | Core graphs application |
| 743 | Network Delay | Easy | Core graphs application |
| 1334 | City Threshold | Medium | Core graphs application |
| 399 | Evaluate Division | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Bellman Ford logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Bellman Ford (Graphs).
- **Signal:** bellman ford, negative edges, shortest path, relax, negative cycle.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Bellman Ford invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Bellman Ford
FAMILY : Graphs (Expert)
WHEN   : bellman ford, negative edges, shortest path, relax, negative cycle
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 787, 743, 1334, 399
```

---

*Part of the DSA Patterns Handbook — pattern 66 of 100.*
