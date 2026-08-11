# 68 · Minimum Spanning Tree

> **One-liner:** Kruskal/Prim connect all nodes at minimum total edge weight.

---

## 1. Overview

### Definition
The **Minimum Spanning Tree** pattern belongs to the *Graphs* family. Kruskal/Prim connect all nodes at minimum total edge weight.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
mst, kruskal, prim, spanning tree, minimum cost, union find.

### Constraints
- Input size where the brute-force complexity would time out — the Minimum Spanning Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Minimum Spanning Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Minimum Spanning Tree is the upgrade.
- The wording maps onto: mst, kruskal, prim, spanning tree, minimum cost, union find.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the cheapest set of edges that still leaves everything connected?"*

Running example (used for the whole chapter) — 5 nodes, 6 edges:

```text
   A ──1── B          A-B : 1        the answer is a TREE:
   │       │ \        A-C : 2          n = 5 nodes
   2       8   3      B-C : 8          ⇒ exactly 4 edges
   │       │     \    B-D : 3          ⇒ no cycles, everything reachable
   C       │       D
           │      /
           └─9─  E ──4── D             B-E : 9,  D-E : 4
```

### Intuition
A spanning tree of `n` nodes always uses exactly `n-1` edges. So: list every set of `n-1` edges, throw away the ones that leave a node stranded or contain a cycle, and keep the cheapest survivor.

### Algorithm
1. Enumerate every subset of `n-1` edges.
2. Reject it if it contains a cycle or does not touch all `n` nodes.
3. Sum its weights.
4. Keep the smallest total.

### Complexity
- Time: **O(C(E, V-1) · V)** — on a complete graph the number of spanning trees is `V^(V-2)` (Cayley's formula). For `V = 5` that is 125; for `V = 12` it is over 60 billion.
- Space: O(V) for the connectivity check.

### Drawbacks
- **Almost every candidate is a near-duplicate of another.** The trees `{AB, AC, BD, DE}` and `{AB, AC, BD, BE}` differ in one edge, yet the brute force re-sums and re-validates the other three from scratch.
- **It considers edges it should never look at twice.** Edge `B-C` costs 8 while `A-B` and `A-C` cost 1 and 2 — `B` and `C` are already connected far more cheaply, so `B-C` can never appear in an optimal tree. Enumeration keeps offering it.
- The fact being ignored is a *local* one: **"is this edge the cheapest link between two pieces that are still apart?"** Answering that one question per edge is enough — no enumeration needed.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep adding the cheapest edge that joins two pieces which are not yet connected; skip any edge whose endpoints already sit in the same piece.**

Picture connecting towns with road-building crews. You never build a road between two towns that already have a route between them — that is money spent on a loop. And when you *do* connect two separate regions, you obviously use the cheapest road that crosses between them. Do that `n-1` times and you are done. The surprise is that this obvious, greedy, never-look-back rule is provably optimal.

### The thought process

```text
We need    : the cheapest edge set that keeps everything connected.
Obvious way: enumerate all spanning trees.
Too slow   : V^(V-2) of them.
Notice     : a tree on V nodes has exactly V-1 edges, and adding an edge inside
             an already-connected piece creates a cycle → pure waste.
Notice too : if I split the nodes into "these" and "the rest", SOME edge has to
             cross that split. The cheapest crossing edge is never a mistake.
Therefore  : make V-1 greedy moves, each one "cheapest edge crossing some split".
Now        : two ways to schedule those moves — sort all edges (Kruskal), or grow
             one tree with a heap (Prim). Same answer, different bookkeeping.
```

### The cut property — why greedy is safe

Everything in this chapter rests on one statement. In plain English:

> **Split the nodes into any two non-empty groups. Look at all the edges that cross from one group to the other. The cheapest one of those is safe — there is a minimum spanning tree that contains it.**

(If several crossing edges tie for cheapest, at least one of them is safe; picking any of them works.)

**Why it is true**, in one exchange argument:

```text
Let e be the cheapest edge crossing the split, and suppose an MST T does not contain e.
Add e to T. T already connects everything, so e closes a CYCLE.
That cycle leaves the first group and comes back, so it crosses the split
at some OTHER edge f.
f also crosses the split, so weight(f) >= weight(e)  (e was the cheapest crossing edge).
Swap: T' = T - f + e. Still V-1 edges, still connected, still a tree,
and weight(T') = weight(T) - weight(f) + weight(e) <= weight(T).
So T' is also an MST — and it contains e.  ∎
```

Every MST algorithm is just a different way of choosing which split to look at.

### Kruskal — sort the edges, use union-find

Process edges cheapest-first. Accept an edge only if its endpoints are currently in **different** components.

**Why that is a cut-property move:** at the moment Kruskal accepts an edge `e = (u, v)`, take the split to be *(the component containing `u`)* versus *(everything else)*. Every edge cheaper than `e` was already examined and either accepted (so it lives inside a component) or rejected. So no crossing edge cheaper than `e` remains — `e` **is** the cheapest edge across that split, hence safe.

Union-find (disjoint set union) answers "same component?" and "merge them" in near-O(1). Trace the running example:

| edge | weight | `find(u)` vs `find(v)` | action | total | edges used |
|------|--------|------------------------|--------|-------|------------|
| A–B | 1 | `A` ≠ `B` | **take** | 1 | 1 |
| A–C | 2 | `{A,B}` ≠ `C` | **take** | 3 | 2 |
| B–D | 3 | `{A,B,C}` ≠ `D` | **take** | 6 | 3 |
| D–E | 4 | `{A,B,C,D}` ≠ `E` | **take** | 10 | 4 = `n-1` ✔ |
| B–C | 8 | same component | skip — would close a cycle | 10 | 4 |
| B–E | 9 | same component | skip | 10 | 4 |

If the loop ends with fewer than `n-1` accepted edges, the graph was disconnected — no spanning tree exists.

### Prim — grow one tree with a heap

Start from any node. Repeatedly add the cheapest edge leading from the tree to a node **outside** it.

**Why that is a cut-property move:** the split is *(nodes already in the tree)* versus *(nodes outside)*, and Prim explicitly takes the cheapest edge crossing it. Same theorem, applied to a different split each round.

The min-heap holds candidate crossing edges. A node can be pushed several times with different costs; the first time it is *popped* it has its cheapest cost, so a `visited` check discards the stale duplicates.

```text
start at A, heap = [(0, A)]

pop (0, A)  visit A  total 0   push (1,B) (2,C)
pop (1, B)  visit B  total 1   push (8,C) (3,D) (9,E)
pop (2, C)  visit C  total 3   push (8,B)                    ← B already in
pop (3, D)  visit D  total 6   push (4,E)
pop (4, E)  visit E  total 10  ✔ all 5 nodes in the tree
pop (8, C)  already visited → discard    (stale duplicate)
```

Same total, 10, and the same four edges — just discovered in a different order.

### Which one do I write?

| | **Kruskal** | **Prim** |
|---|---|---|
| Needs | edge list + union-find | adjacency + min-heap |
| Cost | `O(E log E)` (the sort dominates) | `O(E log V)` with a heap, `O(V²)` with an array |
| Best when | the graph is **sparse**, or the edges arrive already sorted | the graph is **dense** (`E ≈ V²`), e.g. "every pair of points is an edge" |
| Bonus | naturally reports "disconnected" by counting accepted edges | naturally gives a single connected tree from a chosen root |

For a dense graph, skip the heap entirely: keep an array `cheapest[v]` = cost of the best known edge from the tree to `v`, and scan it for the minimum each round. That is `O(V²)` with no `log` and no heap — strictly better when `E ≈ V²`.

### Steps

```text
KRUSKAL
Step 1 → sort all edges by weight, ascending.
Step 2 → parent[v] = v for every v; used = 0, total = 0.
Step 3 → for each edge (u, v, w) in order:
Step 4 →     if find(u) != find(v):   union them; total += w; used++
Step 5 →     stop early once used == V-1.
Step 6 → return total if used == V-1, else "disconnected".

PRIM
Step 1 → visited[] = false; heap = [(0, anyStartNode)]; total = 0, used = 0.
Step 2 → while heap is not empty and used < V:
Step 3 →     pop the cheapest (cost, u); if visited[u], discard it and continue.
Step 4 →     visited[u] = true; total += cost; used++
Step 5 →     push (weight(u,v), v) for every unvisited neighbour v.
Step 6 → return total if used == V, else "disconnected".
```

### How should I recognize this?

```text
If you see...
  "connect all", "minimum cost to connect", "every node reachable"
  "wire / cable / pipe / road all the ... cheaply"
  the answer must use exactly n-1 edges, or "-1 if impossible"
        ↓
Think about...
  "Am I asked to CONNECT everything cheaply (MST),
   or to travel from A to B cheaply (shortest path)?"   ← these differ!
        ↓
Use...
  sparse graph / edge list given       → Kruskal + union-find
  dense graph, all pairs are edges     → Prim, O(V²) array version
  "cheapest to reach ONE target"       → Dijkstra, not MST
  "which edges are essential"          → Kruskal rerun with skip / force (LC 1489)
```

> **Careful:** an MST minimises the *total* wiring cost, not the distance between any particular pair. Triangle `A–B = 1`, `B–C = 1`, `A–C = 1.9`: the MST is `{A–B, B–C}` for a total of `2`, so the MST route from `A` to `C` costs `2` — while the true shortest path is the direct edge, `1.9`, which the MST threw away. **MST ≠ shortest-path tree.** If the question is "cheapest way from X to Y", reach for Dijkstra, not this chapter.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-68" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">MST: keep cheapest edges that connect all, skip cycles</text>
  <!-- chosen MST edges (green, thick) -->
  <line x1="102" y1="70"  x2="248" y2="70"  stroke="#059669" stroke-width="3"/><text x="175" y="58"  text-anchor="middle" fill="#059669" font-weight="700">1</text>
  <line x1="112" y1="90"  x2="185" y2="175" stroke="#059669" stroke-width="3"/><text x="130" y="140" text-anchor="middle" fill="#059669" font-weight="700">2</text>
  <line x1="292" y1="80"  x2="428" y2="160" stroke="#059669" stroke-width="3"/><text x="380" y="110" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <line x1="472" y1="170" x2="558" y2="90"  stroke="#059669" stroke-width="3"/><text x="530" y="140" text-anchor="middle" fill="#059669" font-weight="700">4</text>
  <!-- rejected edges (muted, dashed) -->
  <line x1="222" y1="90"  x2="215" y2="170" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3"/><text x="245" y="140" text-anchor="middle" fill="#d97706">8 skip</text>
  <line x1="285" y1="70"  x2="548" y2="70"  stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3"/><text x="415" y="60" text-anchor="middle" fill="#d97706">9 skip</text>
  <!-- nodes -->
  <circle cx="80"  cy="70"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="80"  y="75"  text-anchor="middle" font-weight="700" fill="#1e293b">A</text>
  <circle cx="270" cy="70"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="270" y="75"  text-anchor="middle" font-weight="700" fill="#1e293b">B</text>
  <circle cx="200" cy="190" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="200" y="195" text-anchor="middle" font-weight="700" fill="#1e293b">C</text>
  <circle cx="450" cy="180" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="450" y="185" text-anchor="middle" font-weight="700" fill="#1e293b">D</text>
  <circle cx="575" cy="70"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="575" y="75"  text-anchor="middle" font-weight="700" fill="#1e293b">E</text>
  <text x="320" y="228" text-anchor="middle" fill="#059669" font-weight="700">MST total weight = 1 + 2 + 3 + 4 = 10</text>
</svg>
```

```text
edges sorted: 1(A-B)  2(A-C)  3(B-D)  4(D-E)  8(B-C)  9(B-E)

  take 1 : {A,B}  {C}  {D}  {E}                total 1
  take 2 : {A,B,C}      {D}  {E}               total 3
  take 3 : {A,B,C,D}         {E}               total 6
  take 4 : {A,B,C,D,E}                         total 10   ← n-1 = 4 edges, done
  skip 8 : B and C are already together → cycle
  skip 9 : B and E are already together → cycle

components merge like union-find; each merge is one cut-property move
```

### Interview explanation
"I want the cheapest edge set that keeps the graph connected, which is a minimum spanning tree — exactly `n-1` edges, no cycles. The greedy rule is justified by the cut property: split the nodes any way you like, and the cheapest edge crossing that split belongs to some MST, because swapping it for any other crossing edge in a tree can only lower the total. Kruskal applies that by sorting all edges and accepting one whenever union-find says its endpoints are in different components — `O(E log E)`, and if fewer than `n-1` edges are accepted the graph is disconnected. Prim applies the same property to the split 'tree so far versus the rest', pulling the cheapest crossing edge off a min-heap — `O(E log V)`, which I'd prefer on a dense graph, and on a fully dense graph I'd use the `O(V²)` array version instead."

---

## 5. Generic Templates

> Both algorithms are the cut property on a schedule: Kruskal sorts every edge, Prim grows one tree. Kruskal needs union-find; Prim needs a heap.

```go
// ---------- Union-Find: "are these two in the same piece?" in near-O(1) ----------

type DSU struct {
    parent []int
    rank   []int
}

func NewDSU(n int) *DSU {
    d := &DSU{parent: make([]int, n), rank: make([]int, n)}
    for i := range d.parent {
        d.parent[i] = i
    }
    return d
}

func (d *DSU) Find(x int) int {
    for d.parent[x] != x {
        d.parent[x] = d.parent[d.parent[x]] // path halving
        x = d.parent[x]
    }
    return x
}

// Union merges the two pieces and reports whether they were actually distinct.
func (d *DSU) Union(a, b int) bool {
    ra, rb := d.Find(a), d.Find(b)
    if ra == rb {
        return false // same piece already: this edge would close a cycle
    }
    if d.rank[ra] < d.rank[rb] {
        ra, rb = rb, ra
    }
    d.parent[rb] = ra
    if d.rank[ra] == d.rank[rb] {
        d.rank[ra]++
    }
    return true
}

// ---------- Kruskal: sort every edge, accept the ones that merge pieces ----------

// KruskalMST returns the total MST weight and whether the graph is connected.
// edges are [u, v, weight]; the slice is sorted in place.
func KruskalMST(n int, edges [][]int) (int, bool) {
    sort.Slice(edges, func(i, j int) bool { return edges[i][2] < edges[j][2] })

    dsu := NewDSU(n)
    total, used := 0, 0
    for _, e := range edges {
        if dsu.Union(e[0], e[1]) { // different pieces ⇒ cheapest crossing edge
            total += e[2]
            used++
            if used == n-1 {
                break // a spanning tree is complete
            }
        }
    }
    return total, used == n-1
}

// ---------- Prim: grow one tree, pulling the cheapest crossing edge ----------

type primItem struct{ cost, node int }

type primHeap []primItem

func (h primHeap) Len() int           { return len(h) }
func (h primHeap) Less(i, j int) bool { return h[i].cost < h[j].cost }
func (h primHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *primHeap) Push(x any) { *h = append(*h, x.(primItem)) }

func (h *primHeap) Pop() any {
    old := *h
    item := old[len(old)-1]
    *h = old[:len(old)-1]
    return item
}

// PrimMST grows the tree from node 0. adj[u] holds [neighbour, weight] pairs.
func PrimMST(n int, adj [][][2]int) (int, bool) {
    visited := make([]bool, n)
    h := &primHeap{{cost: 0, node: 0}}
    total, used := 0, 0

    for h.Len() > 0 && used < n {
        item := heap.Pop(h).(primItem)
        if visited[item.node] {
            continue // stale duplicate: this node joined more cheaply already
        }
        visited[item.node] = true
        total += item.cost
        used++

        for _, nb := range adj[item.node] {
            if !visited[nb[0]] { // only edges CROSSING the cut are candidates
                heap.Push(h, primItem{cost: nb[1], node: nb[0]})
            }
        }
    }
    return total, used == n
}
```

```python
import heapq


class DSU:
    """Union-Find: 'are these two in the same piece?' in near-O(1)."""

    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]     # path halving
            x = self.parent[x]
        return x

    def union(self, a, b):
        """Merge and report whether the two were actually distinct."""
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False                    # same piece: would close a cycle
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1
        return True


def kruskal_mst(n, edges):
    """edges: list of (u, v, w). Returns (total_weight, connected)."""
    dsu = DSU(n)
    total = used = 0
    for u, v, w in sorted(edges, key=lambda e: e[2]):
        if dsu.union(u, v):                 # different pieces ⇒ safe edge
            total += w
            used += 1
            if used == n - 1:
                break
    return total, used == n - 1


def prim_mst(n, adj):
    """adj[u] = list of (neighbour, weight). Returns (total_weight, connected)."""
    visited = [False] * n
    heap = [(0, 0)]                         # (edge cost, node)
    total = used = 0
    while heap and used < n:
        cost, u = heapq.heappop(heap)
        if visited[u]:
            continue                        # stale duplicate
        visited[u] = True
        total += cost
        used += 1
        for v, w in adj[u]:
            if not visited[v]:              # only edges crossing the cut
                heapq.heappush(heap, (w, v))
    return total, used == n
```

```java
import java.util.*;

public class MST {
    static int[] parent, rank_;

    static int find(int x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];          // path halving
            x = parent[x];
        }
        return x;
    }

    /** Merge and report whether the two were actually distinct. */
    static boolean union(int a, int b) {
        int ra = find(a), rb = find(b);
        if (ra == rb) return false;                 // would close a cycle
        if (rank_[ra] < rank_[rb]) { int t = ra; ra = rb; rb = t; }
        parent[rb] = ra;
        if (rank_[ra] == rank_[rb]) rank_[ra]++;
        return true;
    }

    /** Kruskal: returns total MST weight, or -1 if the graph is disconnected. */
    public static int kruskal(int n, int[][] edges) {
        parent = new int[n];
        rank_ = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;

        Arrays.sort(edges, (a, b) -> Integer.compare(a[2], b[2]));
        int total = 0, used = 0;
        for (int[] e : edges) {
            if (union(e[0], e[1])) {                // cheapest crossing edge
                total += e[2];
                if (++used == n - 1) break;
            }
        }
        return used == n - 1 ? total : -1;
    }

    /** Prim: adj.get(u) holds {neighbour, weight}. -1 if disconnected. */
    public static int prim(int n, List<List<int[]>> adj) {
        boolean[] visited = new boolean[n];
        PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
        pq.add(new int[]{0, 0});                    // {cost, node}
        int total = 0, used = 0;

        while (!pq.isEmpty() && used < n) {
            int[] cur = pq.poll();
            if (visited[cur[1]]) continue;          // stale duplicate
            visited[cur[1]] = true;
            total += cur[0];
            used++;
            for (int[] nb : adj.get(cur[1])) {
                if (!visited[nb[0]]) pq.add(new int[]{nb[1], nb[0]});
            }
        }
        return used == n ? total : -1;
    }
}
```

```cpp
#include <algorithm>
#include <queue>
#include <vector>
using namespace std;

vector<int> parentArr, rankArr;

int findRoot(int x) {
    while (parentArr[x] != x) {
        parentArr[x] = parentArr[parentArr[x]];     // path halving
        x = parentArr[x];
    }
    return x;
}

// Merge and report whether the two were actually distinct.
bool unite(int a, int b) {
    int ra = findRoot(a), rb = findRoot(b);
    if (ra == rb) return false;                     // would close a cycle
    if (rankArr[ra] < rankArr[rb]) swap(ra, rb);
    parentArr[rb] = ra;
    if (rankArr[ra] == rankArr[rb]) rankArr[ra]++;
    return true;
}

// Kruskal: total MST weight, or -1 if the graph is disconnected.
int kruskal(int n, vector<vector<int>> edges) {
    parentArr.resize(n);
    rankArr.assign(n, 0);
    for (int i = 0; i < n; ++i) parentArr[i] = i;

    sort(edges.begin(), edges.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[2] < b[2]; });

    int total = 0, used = 0;
    for (const auto& e : edges) {
        if (unite(e[0], e[1])) {                    // cheapest crossing edge
            total += e[2];
            if (++used == n - 1) break;
        }
    }
    return used == n - 1 ? total : -1;
}

// Prim: adj[u] holds {neighbour, weight}. -1 if disconnected.
int prim(int n, const vector<vector<pair<int, int>>>& adj) {
    vector<bool> visited(n, false);
    priority_queue<pair<int, int>, vector<pair<int, int>>, greater<>> pq;
    pq.push({0, 0});                                // {cost, node}
    int total = 0, used = 0;

    while (!pq.empty() && used < n) {
        auto [cost, u] = pq.top();
        pq.pop();
        if (visited[u]) continue;                   // stale duplicate
        visited[u] = true;
        total += cost;
        used++;
        for (auto [v, w] : adj[u]) {
            if (!visited[v]) pq.push({w, v});
        }
    }
    return used == n ? total : -1;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Minimum Spanning Tree (Optimal) |
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

### Problem — Connect Points (LeetCode 1584)
Given `points` on a plane, connect all of them at minimum total cost, where the cost of joining two points is their Manhattan distance `|x1-x2| + |y1-y2|`. Return the minimum total cost.

### Thought Process
1. Every pair of points is an edge, so the graph is **complete**: `E = V(V-1)/2`. Kruskal would have to build and sort all of those edges.
2. Prim is the right shape here — it never materialises the edge list, it just asks "which outside point is closest to the tree?".
3. With `E ≈ V²`, drop the heap and keep an array `cheapest[v]` = the cost of the best known edge from the tree to `v`. Each round: scan for the smallest, absorb it, then update the array. That is `O(V²)` with no `log` factor.
4. `cheapest[]` is literally the cut property made concrete — it stores, for every node outside the tree, the cheapest edge crossing the cut.
5. After `V` rounds every point is in the tree; the running sum is the answer.

### Dry Run

Input: `points = [[0,0], [2,2], [3,10], [5,2]]`

All Manhattan distances (never actually built by the code — shown here for checking):

```text
        p0      p1      p2      p3
 p0      ·       4      13       7
 p1      4       ·       9       3
 p2     13       9       ·      10
 p3      7       3      10       ·
```

| round | `cheapest[]` before | pick (smallest unvisited) | total | `cheapest[]` after the update |
|-------|---------------------|---------------------------|-------|-------------------------------|
| 1 | `[0, ∞, ∞, ∞]` | **p0**, cost 0 | 0 | `[·, 4, 13, 7]` |
| 2 | `[·, 4, 13, 7]` | **p1**, cost 4 | 4 | `[·, ·, 9, 3]` ← both lowered by p1 |
| 3 | `[·, ·, 9, 3]` | **p3**, cost 3 | 7 | `[·, ·, 9, ·]` ← p3→p2 is 10, no gain |
| 4 | `[·, ·, 9, ·]` | **p2**, cost 9 | **16** | all visited |

Output: **`16`** (edges `p0–p1 = 4`, `p1–p3 = 3`, `p1–p2 = 9`)

Round 2 is the interesting one. Absorbing `p1` lowers *two* entries at once: `p2` from 13 to 9 and `p3` from 7 to 3. That is the whole point of `cheapest[]` — the tree grew, so the cut moved, so previously-expensive crossings got cheaper alternatives.

### Visualization

```text
tree grows one point per round; "|" marks the cut

 round 1   [ p0 ] | p1(4)  p2(13) p3(7)         take p1
 round 2   [ p0 p1 ] | p2(9)  p3(3)             take p3   (13→9, 7→3)
 round 3   [ p0 p1 p3 ] | p2(9)                 take p2   (p3→p2 is 10, worse)
 round 4   [ p0 p1 p3 p2 ]                      done

 total = 0 + 4 + 3 + 9 = 16
```

### Code

```go
func minCostConnectPoints(points [][]int) int {
    const inf = 1 << 30
    n := len(points)
    if n <= 1 {
        return 0
    }

    manhattan := func(a, b int) int {
        dx := points[a][0] - points[b][0]
        if dx < 0 {
            dx = -dx
        }
        dy := points[a][1] - points[b][1]
        if dy < 0 {
            dy = -dy
        }
        return dx + dy
    }

    // cheapest[v] = cost of the cheapest edge crossing the cut into v.
    cheapest := make([]int, n)
    inTree := make([]bool, n)
    for i := range cheapest {
        cheapest[i] = inf
    }
    cheapest[0] = 0

    total := 0
    for round := 0; round < n; round++ {
        // Pick the outside point closest to the tree (the cheapest crossing edge).
        best := -1
        for v := 0; v < n; v++ {
            if !inTree[v] && (best == -1 || cheapest[v] < cheapest[best]) {
                best = v
            }
        }

        inTree[best] = true
        total += cheapest[best]

        // The cut moved: every outside point may now have a cheaper crossing.
        for v := 0; v < n; v++ {
            if !inTree[v] {
                if d := manhattan(best, v); d < cheapest[v] {
                    cheapest[v] = d
                }
            }
        }
    }
    return total
}
```

```python
def minCostConnectPoints(points):
    INF = float('inf')
    n = len(points)
    if n <= 1:
        return 0

    def manhattan(a, b):
        return abs(points[a][0] - points[b][0]) + abs(points[a][1] - points[b][1])

    cheapest = [INF] * n          # cheapest edge crossing the cut into each node
    cheapest[0] = 0
    in_tree = [False] * n
    total = 0

    for _ in range(n):
        # Pick the outside point closest to the tree.
        best = min((v for v in range(n) if not in_tree[v]), key=lambda v: cheapest[v])
        in_tree[best] = True
        total += cheapest[best]

        # The cut moved: refresh every remaining crossing cost.
        for v in range(n):
            if not in_tree[v]:
                cheapest[v] = min(cheapest[v], manhattan(best, v))

    return total
```

### Complexity
Time O(V²) — `V` rounds, each doing an O(V) scan and an O(V) refresh. Space O(V) for `cheapest` and `inTree`. A heap-based Prim would be `O(E log V) = O(V² log V)` here, i.e. strictly worse on a complete graph.

---

## 10. Solved Example 2

### Problem — Connect Cities (LeetCode 1135)
Given `n` cities labelled `1..n` and weighted `connections`, return the minimum cost to connect **all** cities, or `-1` if it is impossible.

### Thought Process
1. The edge list is given explicitly and the graph is sparse, so Kruskal is the natural fit.
2. Sort connections ascending — Kruskal always looks at the cheapest remaining edge first.
3. Union-find answers "already connected?"; accept an edge only when it merges two distinct components (otherwise it closes a cycle).
4. Count accepted edges. A spanning tree needs exactly `n-1`; ending with fewer means the graph was disconnected → `-1`.
5. Cities are 1-indexed, so size the parent array `n+1` and ignore slot 0.

### Dry Run

Input: `n = 3`, `connections = [[1,2,5], [1,3,6], [2,3,1]]`

Sorted by weight: `(2,3,1)`, `(1,2,5)`, `(1,3,6)`

| edge | weight | components before | `find(u)` vs `find(v)` | action | total | used |
|------|--------|-------------------|------------------------|--------|-------|------|
| 2–3 | 1 | `{1} {2} {3}` | `2` ≠ `3` | **take** | 1 | 1 |
| 1–2 | 5 | `{1} {2,3}` | `1` ≠ `{2,3}` | **take** | 6 | 2 = `n-1` ✔ |
| 1–3 | 6 | `{1,2,3}` | same root | skip — cycle | 6 | 2 |

Output: **`6`**

Note the cheapest edge (weight 1) is not the one joining city 1 — greedy does not care where the edges are, only that each accepted edge merges two separate pieces. The last row shows the cycle rejection: by then 1 and 3 are already linked through 2, so paying 6 would buy nothing.

If instead `n = 4` with `connections = [[1,2,3], [3,4,4]]`, the loop ends with `used = 2 < 3` — cities `{1,2}` and `{3,4}` are two islands → **`-1`**.

### Visualization

```text
sorted edges:  1(2-3)   5(1-2)   6(1-3)

  start   {1}   {2}   {3}                  total 0   used 0
  take 1  {1}   {2,3}                      total 1   used 1
  take 5  {1,2,3}                          total 6   used 2 = n-1  ✔
  skip 6  find(1) == find(3) → cycle       total 6   used 2

  used == n-1 ⇒ connected ⇒ answer 6
  used <  n-1 ⇒ islands remain ⇒ answer -1
```

### Code

```go
func minimumCost(n int, connections [][]int) int {
    parent := make([]int, n+1) // cities are 1..n
    for i := range parent {
        parent[i] = i
    }

    var find func(int) int
    find = func(x int) int {
        for parent[x] != x {
            parent[x] = parent[parent[x]] // path halving
            x = parent[x]
        }
        return x
    }

    sort.Slice(connections, func(i, j int) bool {
        return connections[i][2] < connections[j][2]
    })

    total, used := 0, 0
    for _, c := range connections {
        ru, rv := find(c[0]), find(c[1])
        if ru == rv {
            continue // same component: this edge would close a cycle
        }
        parent[rv] = ru
        total += c[2]
        used++
        if used == n-1 {
            break // spanning tree complete
        }
    }

    if used != n-1 {
        return -1 // some cities were never connected
    }
    return total
}
```

```python
def minimumCost(n, connections):
    parent = list(range(n + 1))            # cities are 1..n

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]  # path halving
            x = parent[x]
        return x

    total = used = 0
    for u, v, w in sorted(connections, key=lambda c: c[2]):
        ru, rv = find(u), find(v)
        if ru == rv:
            continue                       # would close a cycle
        parent[rv] = ru
        total += w
        used += 1
        if used == n - 1:
            break                          # spanning tree complete

    return total if used == n - 1 else -1
```

### Complexity
Time O(E log E) — the sort dominates; the unions are near-O(E·α(V)). Space O(V) for the parent array.

---

## 11. Solved Example 3

### Problem — Critical Edges (LeetCode 1489)
Given a weighted undirected graph, classify each edge. An edge is **critical** if it appears in *every* MST; **pseudo-critical** if it appears in *some* but not all. Return `[critical, pseudoCritical]` as lists of edge indices.

### Thought Process
1. Compute the baseline MST weight `W` with plain Kruskal.
2. **Critical test:** rebuild the MST while *banning* edge `i`. If the weight rises above `W` (or the graph falls apart, i.e. weight `∞`), then no MST can do without `i` → critical.
3. **Pseudo-critical test:** rebuild while *forcing* edge `i` in first. If the weight is still exactly `W`, then some MST does contain `i` → pseudo-critical.
4. Test critical first: an edge that passes the ban test is critical, and critical edges are excluded from the pseudo list by definition.
5. Sort the edge *indices* once, up front, so each rebuild is a linear pass and the original indices survive.

### Dry Run

Input: `n = 4`, `edges = [[0,1,1], [1,2,1], [0,2,1], [2,3,5]]` — a weight-1 triangle on `{0,1,2}` plus a single bridge to `3`.

```text
        1
   0 ───────  1
    \        /
   1 \      / 1            2 ───5─── 3     (edge index 3, the only way to reach 3)
      \    /
        2
```

Baseline Kruskal (sorted: idx0, idx1, idx2 at weight 1, then idx3 at weight 5):

| edge idx | weight | merges? | total | used |
|----------|--------|---------|-------|------|
| 0 (0–1) | 1 | yes | 1 | 1 |
| 1 (1–2) | 1 | yes | 2 | 2 |
| 2 (0–2) | 1 | no — cycle | 2 | 2 |
| 3 (2–3) | 5 | yes | **7** | 3 = `n-1` ✔ |

Baseline `W = 7`. Now test each edge:

| idx | ban it → weight | > W? | force it → weight | = W? | verdict |
|-----|-----------------|------|-------------------|------|---------|
| 0 | `1(idx1) + 1(idx2) + 5 = 7` | no | `1 + 1 + 5 = 7` | yes | **pseudo-critical** |
| 1 | `1(idx0) + 1(idx2) + 5 = 7` | no | `7` | yes | **pseudo-critical** |
| 2 | `1(idx0) + 1(idx1) + 5 = 7` | no | `7` | yes | **pseudo-critical** |
| 3 | node 3 unreachable → `∞` | **yes** | — (not needed) | — | **critical** |

Output: **`[[3], [0, 1, 2]]`**

The two categories are visible in the picture. Edge 3 is a **bridge** — remove it and the graph splits, so every MST must use it. The three triangle edges are perfectly interchangeable: any two of them span `{0,1,2}` for a cost of 2, so each appears in *some* MST but none appears in *all*. Ties are exactly where pseudo-critical edges come from.

### Visualization

```text
baseline MST weight W = 7

  ban edge 3          ban edge 0           force edge 0
  ────────────        ────────────         ─────────────
   0 ─1─ 1             0     1              [0-1] taken first
    \   /               \   / 1              then 1-2, then 2-3
     \ /                 \ /
      2      3            2 ─5─ 3           total = 7 = W
   3 is stranded       total = 7 = W        ⇒ some MST has it
   weight = ∞ > W      ⇒ not critical       ⇒ PSEUDO-CRITICAL
   ⇒ CRITICAL
```

### Code

```go
func findCriticalAndPseudoCriticalEdges(n int, edges [][]int) [][]int {
    const inf = 1 << 30
    m := len(edges)

    // Sort indices, not edges, so the original indices survive.
    order := make([]int, m)
    for i := range order {
        order[i] = i
    }
    sort.Slice(order, func(a, b int) bool {
        return edges[order[a]][2] < edges[order[b]][2]
    })

    // mst runs Kruskal while banning one edge and/or forcing another in first.
    // Returns inf when the result does not span all n nodes.
    mst := func(ban, force int) int {
        parent := make([]int, n)
        for i := range parent {
            parent[i] = i
        }
        find := func(x int) int {
            for parent[x] != x {
                parent[x] = parent[parent[x]]
                x = parent[x]
            }
            return x
        }

        total, used := 0, 0
        if force >= 0 {
            e := edges[force]
            parent[find(e[0])] = find(e[1])
            total, used = e[2], 1
        }
        for _, i := range order {
            if i == ban || i == force {
                continue
            }
            e := edges[i]
            ru, rv := find(e[0]), find(e[1])
            if ru == rv {
                continue // cycle
            }
            parent[rv] = ru
            total += e[2]
            used++
        }
        if used != n-1 {
            return inf // disconnected
        }
        return total
    }

    base := mst(-1, -1)
    critical, pseudo := []int{}, []int{}
    for i := 0; i < m; i++ {
        if mst(i, -1) > base { // banning it makes every tree worse
            critical = append(critical, i)
        } else if mst(-1, i) == base { // forcing it still reaches the optimum
            pseudo = append(pseudo, i)
        }
    }
    return [][]int{critical, pseudo}
}
```

```python
def findCriticalAndPseudoCriticalEdges(n, edges):
    INF = float('inf')
    m = len(edges)
    order = sorted(range(m), key=lambda i: edges[i][2])   # indices survive

    def mst(ban=-1, force=-1):
        """Kruskal while banning one edge and/or forcing another in first."""
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        total = used = 0
        if force >= 0:
            u, v, w = edges[force]
            parent[find(u)] = find(v)
            total, used = w, 1
        for i in order:
            if i == ban or i == force:
                continue
            u, v, w = edges[i]
            ru, rv = find(u), find(v)
            if ru == rv:
                continue                                  # cycle
            parent[rv] = ru
            total += w
            used += 1
        return total if used == n - 1 else INF

    base = mst()
    critical, pseudo = [], []
    for i in range(m):
        if mst(ban=i) > base:                             # every MST needs it
            critical.append(i)
        elif mst(force=i) == base:                        # some MST has it
            pseudo.append(i)
    return [critical, pseudo]
```

### Complexity
Time O(E² · α(V)) — the edges are sorted once, then up to two MST rebuilds per edge, each a linear pass. Space O(V + E).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1584 | Connect Points | Easy | Core graphs application |
| 1135 | Connect Cities | Easy | Core graphs application |
| 1489 | Critical Edges | Medium | Core graphs application |
| 778 | Swim Rising | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Minimum Spanning Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Minimum Spanning Tree (Graphs).
- **Signal:** mst, kruskal, prim, spanning tree, minimum cost, union find.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Minimum Spanning Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Minimum Spanning Tree
FAMILY : Graphs (Expert)
WHEN   : mst, kruskal, prim, spanning tree, minimum cost, union find
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 1584, 1135, 1489, 778
```

---

*Part of the DSA Patterns Handbook — pattern 68 of 100.*
