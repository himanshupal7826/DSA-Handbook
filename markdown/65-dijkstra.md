# 65 · Dijkstra

> **One-liner:** Greedy heap-based shortest paths for non-negative edge weights.

---

## 1. Overview

### Definition
The **Dijkstra** pattern belongs to the *Graphs* family. Greedy heap-based shortest paths for non-negative edge weights.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
dijkstra, shortest path, weighted, heap, non-negative.

### Constraints
- Input size where the brute-force complexity would time out — the Dijkstra optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Dijkstra invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Dijkstra is the upgrade.
- The wording maps onto: dijkstra, shortest path, weighted, heap, non-negative.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the cheapest route from here to everywhere, when edges have different costs?"*

### Intuition
BFS finds shortest paths by *hop count*. With weights, the fewest-hops route may be far from the cheapest — so try every route.

### Algorithm
1. Enumerate every simple path from the source to the target.
2. Sum the weights along each.
3. Keep the minimum.

### Complexity
- Time: **exponential** — a dense graph has factorially many simple paths.
- Space: O(V) per path.

### Drawbacks
- Hopeless beyond a handful of nodes.
- And it is blind to a huge shortcut: paths **share prefixes**. Once you know the cheapest way to reach node `X`, every route continuing through `X` can reuse it. The brute force recomputes that prefix once per path.
- Plain BFS doesn't rescue you either: it settles nodes in hop order, and with weights the 1-hop route can cost more than a 5-hop one.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Always expand the unvisited node with the smallest known distance — because with non-negative weights, nothing you discover later can ever make it cheaper.**

That is the greedy claim, and it is what turns exponential into `O((V + E) log V)`.

### The thought process

```text
We need    : cheapest paths in a weighted graph.
Obvious way: enumerate all paths.
Hopeless   : exponential, and it recomputes shared prefixes.
Notice     : BFS works for unweighted graphs because the first time
             you reach a node IS the cheapest. Weights break that.
Notice too : ...unless you always expand the CHEAPEST frontier node
             first. Then the first time you settle a node, it is final.
Therefore  : replace BFS's queue with a MIN-HEAP keyed on distance.
Now        : O((V + E) log V).
```

**Dijkstra is BFS with a priority queue.** If every weight is 1, the heap degenerates into a plain queue and you get BFS back exactly.

### Why the greedy choice is safe — and why it needs non-negative weights

Suppose the heap's minimum is node `u` with tentative distance `d`. Could some other route reach `u` more cheaply?

Any such route must leave the settled region through some frontier node `v`, and `v`'s distance is `≥ d` because `u` was the minimum. Continuing from `v` to `u` adds more edges, and **with non-negative weights that can only increase the total**. So no route beats `d`. `u` is final.

That argument collapses the instant a negative edge exists: adding an edge could *reduce* the total, so a settled node might later become cheaper.

```text
        A ──(1)──▶ B
        │           │
       (5)        (-10)
        │           │
        ▼           ▼
        C ◀─────────┘

Dijkstra settles C at 5 immediately.
The real cheapest is A→B→C = 1 + (-10) = -9.   Dijkstra returns the WRONG answer.
```

Negative weights need **Bellman-Ford** — O(V · E), which relaxes every edge `V−1` times and makes no greedy commitment.

### Steps

```text
Step 1 → dist[] = infinity for all; dist[source] = 0
Step 2 → push (0, source) onto a min-heap keyed by distance
Step 3 → while the heap is non-empty:
Step 4 →     (d, u) = pop the smallest
Step 5 →     if d > dist[u]: skip     ← a stale entry, see below
Step 6 →     for each edge (u → v, weight w):
Step 7 →         if d + w < dist[v]:
Step 8 →             dist[v] = d + w
Step 9 →             push (dist[v], v)
Step 10 → dist[] now holds the cheapest distance to every node
```

### The stale-entry check in step 5

A binary heap cannot update a key in place, so instead of decreasing an existing entry we **push a new one** and leave the old one behind. That means the heap can hold several entries for the same node.

```text
push (10, X)      later found a better route
push (4,  X)      now the heap holds BOTH

pop (4, X)  → dist[X] = 4, process it
pop (10, X) → 10 > dist[X] = 4  →  STALE, skip it
```

Without that check you would relax `X`'s neighbours a second time using a worse distance. It is harmless for correctness of `dist` (the comparisons would fail anyway) but it wastes work — and in variants that track extra state, it produces wrong answers outright.

The alternative is a heap supporting `decrease-key`, which is tidier in theory and rarely worth it in practice.

### The variants: change what "distance" means

Dijkstra generalises to any cost that is **monotone** — extending a path never makes it better:

| Problem | `dist` means | Relaxation |
|---|---|---|
| Shortest path | total weight | `dist[u] + w` |
| **Minimax path** (Path With Minimum Effort) | the largest single edge on the path | `max(dist[u], w)` |
| Maximum-probability path | product of probabilities | `dist[u] * p`, with a **max**-heap |
| Fewest hops | edge count | `dist[u] + 1` — this is just BFS |

The minimax version is worth internalising: swap `+` for `max` and the whole algorithm still works, because `max` is also monotone.

### When Dijkstra is the wrong tool

| Situation | Use instead |
|---|---|
| Negative edge weights | **Bellman-Ford** — O(V · E) |
| Negative cycles must be detected | Bellman-Ford with an extra pass |
| **A hop limit** ("at most k stops") | Bellman-Ford / level-BFS — see Example 3 |
| All weights equal | plain BFS — O(V + E), no heap |
| All-pairs shortest paths | Floyd-Warshall — O(V³) |

The hop-limit case is the subtle one. Dijkstra settles a node once and never revisits it — but under a stop limit, a *more expensive* route using *fewer* stops may be the only one that can still be extended. The greedy commitment is exactly what breaks.

### How should I recognize this?

```text
If you see...
  "shortest / cheapest / fastest path", "minimum time to reach all"
  "network delay", "minimum effort", "maximum probability path"
  a weighted graph with NON-NEGATIVE weights
        ↓
Think about...
  "Is the first time I settle a node necessarily final?"
  (Yes, if weights are non-negative and there is no hop limit.)
        ↓
Use...
  min-heap keyed on distance + the stale-entry skip
  negative weights → Bellman-Ford
  hop limit        → Bellman-Ford / level-BFS
  unweighted       → plain BFS
```

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-65" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Dijkstra: pop nearest, relax edges, tighten tentative dist</text>
  <!-- edges with weights -->
  <line x1="92"  y1="115" x2="208" y2="75"  stroke="#475569"/><text x="150" y="80"  text-anchor="middle" fill="#64748b">2</text>
  <line x1="92"  y1="125" x2="208" y2="185" stroke="#475569"/><text x="150" y="170" text-anchor="middle" fill="#64748b">5</text>
  <line x1="252" y1="70"  x2="368" y2="70"  stroke="#059669" stroke-width="2"/><text x="310" y="58"  text-anchor="middle" fill="#059669" font-weight="700">1</text>
  <line x1="252" y1="185" x2="558" y2="130" stroke="#475569"/><text x="380" y="175" text-anchor="middle" fill="#64748b">2</text>
  <line x1="412" y1="80"  x2="558" y2="115" stroke="#475569"/><text x="490" y="88"  text-anchor="middle" fill="#64748b">3</text>
  <!-- nodes -->
  <circle cx="70"  cy="120" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="70"  y="125" text-anchor="middle" font-weight="700" fill="#1e293b">S</text><text x="70"  y="170" text-anchor="middle" fill="#059669">0</text>
  <circle cx="230" cy="65"  r="22" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="70"  text-anchor="middle" font-weight="700" fill="#1e293b">A</text><text x="230" y="38" text-anchor="middle" fill="#64748b">2</text>
  <circle cx="230" cy="190" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="195" text-anchor="middle" font-weight="700" fill="#1e293b">B</text><text x="230" y="230" text-anchor="middle" fill="#64748b">5</text>
  <circle cx="390" cy="70"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="390" y="75"  text-anchor="middle" font-weight="700" fill="#1e293b">C</text><text x="390" y="43" text-anchor="middle" fill="#059669">3</text>
  <circle cx="580" cy="120" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="580" y="125" text-anchor="middle" font-weight="700" fill="#1e293b">D</text><text x="580" y="170" text-anchor="middle" fill="#64748b">6</text>
  <text x="470" y="205" text-anchor="middle" fill="#059669" font-weight="700">relax A→C: dist[C] = 2 + 1 = 3</text>
</svg>
```

```text
edges (u → v, weight):  2→1 (1),  2→3 (1),  3→4 (1)
source = 2

heap [(0,2)]        pop (0,2)   dist[2]=0
                    relax 1 → 1, 3 → 1        heap [(1,1), (1,3)]
heap [(1,1),(1,3)]  pop (1,1)   dist[1]=1     no outgoing edges
heap [(1,3)]        pop (1,3)   dist[3]=1
                    relax 4 → 2               heap [(2,4)]
heap [(2,4)]        pop (2,4)   dist[4]=2

dist = {1:1, 2:0, 3:1, 4:2}   →   the last node is reached at time 2
```

### Interview explanation
"This is Dijkstra — BFS with a priority queue instead of a plain queue. I keep tentative distances and always expand the unvisited node with the smallest one. That greedy choice is safe because every other route to it must leave through a frontier node whose distance is at least as large, and with non-negative weights extending a path only adds cost — so the first time I settle a node, it's final. Since a binary heap can't decrease a key, I push a new entry instead of updating, and skip any popped entry whose distance is worse than the recorded one. That's O((V + E) log V). If the weights could be negative I'd switch to Bellman-Ford, and if there were a limit on the number of hops I'd also use Bellman-Ford, because the hop limit breaks the settle-once-and-never-revisit property Dijkstra depends on."

---

## 5. Generic Templates

> Min-heap on distance, relax edges, skip stale entries.

```go
// Edge is one weighted outgoing edge.
type Edge struct {
    To     int
    Weight int
}

// state is a heap entry: a tentative distance to a node.
type state struct {
    Distance int
    Node     int
}

type stateHeap []state

func (h stateHeap) Len() int           { return len(h) }
func (h stateHeap) Less(i, j int) bool { return h[i].Distance < h[j].Distance }
func (h stateHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *stateHeap) Push(x any)        { *h = append(*h, x.(state)) }
func (h *stateHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

// Dijkstra returns the cheapest distance from source to every node.
// Unreachable nodes keep the value math.MaxInt32.
func Dijkstra(n int, graph [][]Edge, source int) []int {
    dist := make([]int, n)
    for i := range dist {
        dist[i] = math.MaxInt32
    }
    dist[source] = 0

    frontier := &stateHeap{{Distance: 0, Node: source}}
    heap.Init(frontier)

    for frontier.Len() > 0 {
        current := heap.Pop(frontier).(state)

        // Stale entry: we already found a better route to this node.
        if current.Distance > dist[current.Node] {
            continue
        }

        for _, edge := range graph[current.Node] {
            candidate := current.Distance + edge.Weight
            if candidate < dist[edge.To] {
                dist[edge.To] = candidate
                // Push instead of decrease-key; the stale check cleans up.
                heap.Push(frontier, state{Distance: candidate, Node: edge.To})
            }
        }
    }
    return dist
}

// BellmanFord handles NEGATIVE weights, which Dijkstra cannot.
// Returns nil if a negative cycle is reachable from the source.
func BellmanFord(n int, edges [][3]int, source int) []int {
    dist := make([]int, n)
    for i := range dist {
        dist[i] = math.MaxInt32
    }
    dist[source] = 0

    // V-1 rounds suffice: a shortest path uses at most V-1 edges.
    for round := 0; round < n-1; round++ {
        changed := false
        for _, e := range edges {
            from, to, weight := e[0], e[1], e[2]
            if dist[from] != math.MaxInt32 && dist[from]+weight < dist[to] {
                dist[to] = dist[from] + weight
                changed = true
            }
        }
        if !changed {
            break // already settled
        }
    }

    // One more improvement means a negative cycle exists.
    for _, e := range edges {
        from, to, weight := e[0], e[1], e[2]
        if dist[from] != math.MaxInt32 && dist[from]+weight < dist[to] {
            return nil
        }
    }
    return dist
}
```

```python
import heapq

def dijkstra(n, graph, source):
    """graph[u] = list of (neighbour, weight). Non-negative weights only."""
    INF = float("inf")
    dist = [INF] * n
    dist[source] = 0

    frontier = [(0, source)]
    while frontier:
        d, u = heapq.heappop(frontier)

        if d > dist[u]:
            continue                    # stale entry: a better route won already

        for v, weight in graph[u]:
            candidate = d + weight
            if candidate < dist[v]:
                dist[v] = candidate
                heapq.heappush(frontier, (candidate, v))   # push, don't update
    return dist

def bellman_ford(n, edges, source):
    """Handles NEGATIVE weights. Returns None on a reachable negative cycle."""
    INF = float("inf")
    dist = [INF] * n
    dist[source] = 0

    for _ in range(n - 1):              # a shortest path uses ≤ V-1 edges
        changed = False
        for frm, to, weight in edges:
            if dist[frm] != INF and dist[frm] + weight < dist[to]:
                dist[to] = dist[frm] + weight
                changed = True
        if not changed:
            break

    for frm, to, weight in edges:       # one more improvement ⇒ negative cycle
        if dist[frm] != INF and dist[frm] + weight < dist[to]:
            return None
    return dist
```

```java
import java.util.*;

public class DijkstraPattern {
    // graph.get(u) = list of int[]{neighbour, weight}
    public static int[] dijkstra(int n, List<List<int[]>> graph, int source) {
        int[] dist = new int[n];
        Arrays.fill(dist, Integer.MAX_VALUE);
        dist[source] = 0;

        // int[]{distance, node}, ordered by distance
        PriorityQueue<int[]> frontier =
            new PriorityQueue<>((a, b) -> Integer.compare(a[0], b[0]));
        frontier.add(new int[]{0, source});

        while (!frontier.isEmpty()) {
            int[] current = frontier.poll();
            int d = current[0], u = current[1];

            if (d > dist[u]) continue;              // stale entry

            for (int[] edge : graph.get(u)) {
                int v = edge[0], weight = edge[1];
                if (d + weight < dist[v]) {
                    dist[v] = d + weight;
                    frontier.add(new int[]{dist[v], v});
                }
            }
        }
        return dist;
    }
}
```

```cpp
#include <climits>
#include <queue>
#include <vector>
using namespace std;

// graph[u] = vector of (neighbour, weight). Non-negative weights only.
vector<int> dijkstra(int n, const vector<vector<pair<int, int>>>& graph, int source) {
    vector<int> dist(n, INT_MAX);
    dist[source] = 0;

    // (distance, node); greater<> makes it a MIN-heap.
    priority_queue<pair<int, int>, vector<pair<int, int>>, greater<>> frontier;
    frontier.emplace(0, source);

    while (!frontier.empty()) {
        auto [d, u] = frontier.top();
        frontier.pop();

        if (d > dist[u]) continue;                  // stale entry

        for (auto [v, weight] : graph[u]) {
            if (d + weight < dist[v]) {
                dist[v] = d + weight;
                frontier.emplace(dist[v], v);       // push, don't update
            }
        }
    }
    return dist;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Dijkstra (Optimal) |
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

### Problem — Network Delay Time (LeetCode 743)
`times[i] = [u, v, w]` is a directed edge taking `w` time. A signal starts at node `k`. Return the time for **all** `n` nodes to receive it, or `−1` if some cannot.

### Thought Process
1. "Time for all nodes" is the **maximum** of the shortest distances from `k` — the last node to hear the signal decides.
2. Weights are positive, so Dijkstra applies directly.
3. Run it from `k`, then take the max over all distances.
4. If any distance is still infinity, that node is unreachable → return `−1`.
5. Nodes are 1-indexed, so size the arrays `n+1` and ignore index 0.

### Dry Run

Input: `times = [[2,1,1], [2,3,1], [3,4,1]]`, `n = 4`, `k = 2`

Graph: `2 → 1` (1), `2 → 3` (1), `3 → 4` (1)

Start: `dist = [_, ∞, 0, ∞, ∞]`, heap `[(0, 2)]`

| pop | stale? | relaxations | dist after | heap after |
|-----|--------|-------------|------------|------------|
| `(0, 2)` | no | `1: ∞ → 1`, `3: ∞ → 1` | `[_,1,0,1,∞]` | `[(1,1), (1,3)]` |
| `(1, 1)` | no | node 1 has no outgoing edges | unchanged | `[(1,3)]` |
| `(1, 3)` | no | `4: ∞ → 2` | `[_,1,0,1,2]` | `[(2,4)]` |
| `(2, 4)` | no | node 4 has no outgoing edges | unchanged | `[]` |

All four distances are finite. Maximum = **2**.

Output: **2** ✓

Verify by hand: node 1 hears at time 1, node 3 at time 1, node 4 at time `1 + 1 = 2`. The last is node 4 at time 2. ✓

**The unreachable case:** with `n = 4` but no edge into node 4, `dist[4]` stays infinite and we return `−1`.

### Visualization

```text
        2  (source, t=0)
       / \
   (1)/   \(1)
     ▼     ▼
     1     3   (t=1)
           │
        (1)│
           ▼
           4   (t=2)   ← the last to hear

answer = max over all dist = 2
```

### Code

```go
func networkDelayTime(times [][]int, n int, k int) int {
    // Nodes are 1-indexed; index 0 is unused.
    graph := make([][][2]int, n+1) // graph[u] = list of {neighbour, weight}
    for _, t := range times {
        from, to, weight := t[0], t[1], t[2]
        graph[from] = append(graph[from], [2]int{to, weight})
    }

    const unreachable = math.MaxInt32
    dist := make([]int, n+1)
    for i := range dist {
        dist[i] = unreachable
    }
    dist[k] = 0

    frontier := &delayHeap{{0, k}}
    heap.Init(frontier)

    for frontier.Len() > 0 {
        current := heap.Pop(frontier).(delayState)

        // Stale entry: a cheaper route to this node already won.
        if current.distance > dist[current.node] {
            continue
        }

        for _, edge := range graph[current.node] {
            next, weight := edge[0], edge[1]
            if candidate := current.distance + weight; candidate < dist[next] {
                dist[next] = candidate
                heap.Push(frontier, delayState{candidate, next})
            }
        }
    }

    // The signal arrives when the LAST node hears it.
    slowest := 0
    for node := 1; node <= n; node++ {
        if dist[node] == unreachable {
            return -1 // some node can never be reached
        }
        if dist[node] > slowest {
            slowest = dist[node]
        }
    }
    return slowest
}

type delayState struct {
    distance int
    node     int
}

type delayHeap []delayState

func (h delayHeap) Len() int           { return len(h) }
func (h delayHeap) Less(i, j int) bool { return h[i].distance < h[j].distance }
func (h delayHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *delayHeap) Push(x any)        { *h = append(*h, x.(delayState)) }
func (h *delayHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def networkDelayTime(times, n, k):
    graph = [[] for _ in range(n + 1)]          # nodes are 1-indexed
    for frm, to, weight in times:
        graph[frm].append((to, weight))

    INF = float("inf")
    dist = [INF] * (n + 1)
    dist[k] = 0

    frontier = [(0, k)]
    while frontier:
        d, u = heapq.heappop(frontier)
        if d > dist[u]:
            continue                            # stale entry

        for v, weight in graph[u]:
            if d + weight < dist[v]:
                dist[v] = d + weight
                heapq.heappush(frontier, (dist[v], v))

    slowest = max(dist[1:])                     # the LAST node to hear
    return -1 if slowest == INF else slowest
```

### Complexity
Time **O((V + E) log V)** — each edge may push one heap entry. Space O(V + E).

---

## 10. Solved Example 2

### Problem — Path With Minimum Effort (LeetCode 1631)
From the top-left to the bottom-right of a grid of heights, the **effort** of a route is the largest absolute height difference between consecutive cells. Return the minimum possible effort.

### Thought Process
1. This is Dijkstra with a different notion of "distance". The cost of a path is not a **sum** — it is a **maximum**.
2. Dijkstra only needs the cost to be **monotone**: extending a path must never make it cheaper. `max` satisfies that just as `+` does, because `max(a, b) ≥ a`.
3. So change one line: relax with `max(dist[u], |height difference|)` instead of `dist[u] + w`.
4. Nodes are grid cells; neighbours are the four orthogonal cells.
5. The answer is `dist[bottom-right]`.

### Dry Run

Input:

```text
heights = [[1, 2, 2],
           [3, 8, 2],
           [5, 3, 5]]
```

The answer is the route `1 → 2 → 2 → 2 → 5` along the top row and down the right column:

| step | from → to | heights | difference | running max (effort) |
|------|-----------|---------|------------|----------------------|
| 1 | (0,0) → (0,1) | 1 → 2 | 1 | 1 |
| 2 | (0,1) → (0,2) | 2 → 2 | 0 | 1 |
| 3 | (0,2) → (1,2) | 2 → 2 | 0 | 1 |
| 4 | (1,2) → (2,2) | 2 → 5 | **3** | **3** |

That route costs 3. Dijkstra finds a better one — down the left column and across the bottom:

| step | from → to | heights | difference | running max |
|------|-----------|---------|------------|-------------|
| 1 | (0,0) → (1,0) | 1 → 3 | **2** | 2 |
| 2 | (1,0) → (2,0) | 3 → 5 | **2** | 2 |
| 3 | (2,0) → (2,1) | 5 → 3 | 2 | 2 |
| 4 | (2,1) → (2,2) | 3 → 5 | 2 | **2** |

Output: **2** ✓

Notice how the cost behaves: step 2 of the second route had a difference of 2, but the running effort **stayed** at 2 rather than becoming 4. That is the `max` replacing the `+`, and it is the only change from Example 1.

### Visualization

```text
    1    2    2
    │
    ▼
    3    8    2          the chosen route: 1 → 3 → 5 → 3 → 5
    │
    ▼
    5 ─▶ 3 ─▶ 5

  differences:  2,   2,   2,   2      →  max = 2   ★

  cost of a path = MAX edge, not SUM of edges
```

### Code

```go
func minimumEffortPath(heights [][]int) int {
    rows, cols := len(heights), len(heights[0])

    const unreachable = math.MaxInt32
    effort := make([][]int, rows)
    for r := range effort {
        effort[r] = make([]int, cols)
        for c := range effort[r] {
            effort[r][c] = unreachable
        }
    }
    effort[0][0] = 0

    frontier := &effortHeap{{0, 0, 0}}
    heap.Init(frontier)

    directions := [4][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}}

    for frontier.Len() > 0 {
        current := heap.Pop(frontier).(effortState)

        // Stale entry: a gentler route to this cell already won.
        if current.effort > effort[current.row][current.col] {
            continue
        }
        // The first time we settle the destination, it is final.
        if current.row == rows-1 && current.col == cols-1 {
            return current.effort
        }

        for _, d := range directions {
            nextRow, nextCol := current.row+d[0], current.col+d[1]
            if nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols {
                continue
            }

            step := heights[nextRow][nextCol] - heights[current.row][current.col]
            if step < 0 {
                step = -step
            }

            // The one change from ordinary Dijkstra: MAX, not sum.
            candidate := current.effort
            if step > candidate {
                candidate = step
            }

            if candidate < effort[nextRow][nextCol] {
                effort[nextRow][nextCol] = candidate
                heap.Push(frontier, effortState{candidate, nextRow, nextCol})
            }
        }
    }
    return 0 // a 1x1 grid needs no moves
}

type effortState struct {
    effort int
    row    int
    col    int
}

type effortHeap []effortState

func (h effortHeap) Len() int           { return len(h) }
func (h effortHeap) Less(i, j int) bool { return h[i].effort < h[j].effort }
func (h effortHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *effortHeap) Push(x any)        { *h = append(*h, x.(effortState)) }
func (h *effortHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def minimumEffortPath(heights):
    rows, cols = len(heights), len(heights[0])
    INF = float("inf")
    effort = [[INF] * cols for _ in range(rows)]
    effort[0][0] = 0

    frontier = [(0, 0, 0)]                      # (effort, row, col)
    while frontier:
        e, row, col = heapq.heappop(frontier)

        if e > effort[row][col]:
            continue                            # stale entry
        if row == rows - 1 and col == cols - 1:
            return e                            # settled the destination

        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = row + dr, col + dc
            if not (0 <= nr < rows and 0 <= nc < cols):
                continue

            step = abs(heights[nr][nc] - heights[row][col])
            candidate = max(e, step)            # MAX, not sum
            if candidate < effort[nr][nc]:
                effort[nr][nc] = candidate
                heapq.heappush(frontier, (candidate, nr, nc))

    return 0
```

### Complexity
Time **O(rows · cols · log(rows · cols))**, Space O(rows · cols).

---

## 11. Solved Example 3

### Problem — Cheapest Flights Within K Stops (LeetCode 787)
Find the cheapest route from `src` to `dst` using **at most `k` stops** (so at most `k + 1` flights), or `−1`.

### Thought Process
1. This looks like Dijkstra, and plain Dijkstra **gives the wrong answer**.
2. Why: Dijkstra settles a node once and never revisits it. But under a stop limit, a *more expensive* route reaching a city with *fewer* stops may be the only one that can still be extended. Cost alone is no longer enough to decide what to keep.
3. So use **Bellman-Ford**, restricted to `k + 1` rounds. Round `i` computes the cheapest price reachable using at most `i` flights.
4. Critically, each round must relax from a **snapshot** of the previous round's prices. Relaxing in place would let a single round chain two flights together, silently exceeding the stop limit.
5. After `k + 1` rounds, `dist[dst]` is the answer.

### Dry Run

Input: `n = 3`, `flights = [[0,1,100], [1,2,100], [0,2,500]]`, `src = 0`, `dst = 2`, `k = 1`

At most 1 stop → at most **2** flights → 2 rounds.

Start: `dist = [0, ∞, ∞]`

**Round 1** (relaxing from the snapshot `[0, ∞, ∞]`):

| flight | from price | candidate | updates |
|--------|-----------|-----------|---------|
| `0→1` (100) | `dist[0] = 0` | 100 | `dist[1] = 100` |
| `1→2` (100) | snapshot `dist[1] = ∞` | — | no change ← the snapshot prevents chaining |
| `0→2` (500) | `dist[0] = 0` | 500 | `dist[2] = 500` |

After round 1: `dist = [0, 100, 500]` — routes using at most 1 flight.

**Round 2** (snapshot `[0, 100, 500]`):

| flight | from price | candidate | updates |
|--------|-----------|-----------|---------|
| `0→1` (100) | 0 | 100 | no improvement |
| `1→2` (100) | `100` | **200** | `dist[2] = 200` ✓ |
| `0→2` (500) | 0 | 500 | no improvement |

After round 2: `dist = [0, 100, 200]`

Output: **200** ✓ — the route `0 → 1 → 2` costs 200 and uses exactly 1 stop.

**Why the snapshot matters.** Without it, round 1 would relax `0→1` (setting `dist[1] = 100`) and then immediately relax `1→2` off that fresh value, giving `dist[2] = 200` after just **one** round — implying a 2-flight route was reachable in 1 flight. With `k = 0` that would wrongly return 200 instead of 500.

### Visualization

```text
        0
       / \
  100 /   \ 500
     ▼     ▼
     1 ───▶ 2
       100

k = 1 (at most 2 flights):

  round 1 (≤1 flight):   dist = [0, 100, 500]
  round 2 (≤2 flights):  dist = [0, 100, 200]   ★

  0 → 1 → 2 costs 200 with exactly 1 stop
```

### Code

```go
func findCheapestPrice(n int, flights [][]int, src int, dst int, k int) int {
    const unreachable = math.MaxInt32

    dist := make([]int, n)
    for i := range dist {
        dist[i] = unreachable
    }
    dist[src] = 0

    // At most k stops means at most k+1 flights, so k+1 rounds.
    for round := 0; round <= k; round++ {
        // Relax from a SNAPSHOT of the previous round. Without this, one
        // round could chain several flights and exceed the stop limit.
        snapshot := make([]int, n)
        copy(snapshot, dist)

        for _, f := range flights {
            from, to, price := f[0], f[1], f[2]
            if snapshot[from] == unreachable {
                continue // not reachable within the previous round's budget
            }
            if candidate := snapshot[from] + price; candidate < dist[to] {
                dist[to] = candidate
            }
        }
    }

    if dist[dst] == unreachable {
        return -1
    }
    return dist[dst]
}
```

```python
def findCheapestPrice(n, flights, src, dst, k):
    INF = float("inf")
    dist = [INF] * n
    dist[src] = 0

    # At most k stops = at most k+1 flights = k+1 rounds.
    for _ in range(k + 1):
        # Relax from a SNAPSHOT so one round cannot chain several flights.
        snapshot = dist[:]
        for frm, to, price in flights:
            if snapshot[frm] == INF:
                continue
            if snapshot[frm] + price < dist[to]:
                dist[to] = snapshot[frm] + price

    return -1 if dist[dst] == INF else dist[dst]
```

### Complexity
Time **O(k · E)** — `k + 1` rounds over every flight. Space O(n) for the two arrays.

> The lesson generalises: **Dijkstra's greedy commitment fails whenever the state is more than just "which node".** Here the state is `(node, stops used)`. You can also solve it with Dijkstra over that expanded state — pushing `(cost, node, stopsUsed)` and allowing revisits with fewer stops — but the Bellman-Ford formulation is shorter and much harder to get wrong.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 743 | Network Delay | Easy | Core graphs application |
| 1631 | Min Effort | Easy | Core graphs application |
| 787 | K Stops | Medium | Core graphs application |
| 1514 | Max Prob Path | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Dijkstra logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Dijkstra (Graphs).
- **Signal:** dijkstra, shortest path, weighted, heap, non-negative.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Dijkstra invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Dijkstra
FAMILY : Graphs (Advanced)
WHEN   : dijkstra, shortest path, weighted, heap, non-negative
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 743, 1631, 787, 1514
```

---

*Part of the DSA Patterns Handbook — pattern 65 of 100.*
