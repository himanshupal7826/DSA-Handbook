# 99 · Tarjan Algorithm

> **One-liner:** One DFS with low-link values finds bridges, articulation points, SCCs.

---

## 1. Overview

### Definition
The **Tarjan Algorithm** pattern belongs to the *Advanced* family. One DFS with low-link values finds bridges, articulation points, SCCs.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
tarjan, bridges, articulation points, low link, dfs tree.

### Constraints
- Input size where the brute-force complexity would time out — the Tarjan Algorithm optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Tarjan Algorithm invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tarjan Algorithm is the upgrade.
- The wording maps onto: tarjan, bridges, articulation points, low link, dfs tree.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which single edge — or single node — is holding this network together?"*

Running example: 4 routers, cables `0–1`, `1–2`, `2–0`, `1–3`.

```text
      0 ───── 1 ───── 3
       \     /
        \   /
          2
```

### Intuition
A cable is *critical* if cutting it splits the network. So cut it and look. Same for a router: unplug it and look.

### Algorithm
1. Count the connected components of the whole graph — call it `base`.
2. **Bridges:** for each edge `e`, delete `e`, re-run a full DFS/BFS, count components. If the count went above `base`, `e` was a bridge.
3. **Articulation points:** for each vertex `u`, delete `u` *and all its edges*, re-run a full traversal on the remaining `V-1` vertices. If the count went up, `u` was an articulation point.
4. Restore and move to the next candidate.

### Complexity
- Time: **O(E · (V + E))** for bridges, **O(V · (V + E))** for articulation points — one full traversal per candidate.
- Space: O(V + E).

### Drawbacks
- The traversals are almost identical. On the running example:

```text
remove 0–1 → walk 0–2–1–3   components 1  → not a bridge
remove 1–2 → walk 0–1–3, 0–2 components 1  → not a bridge
remove 2–0 → walk 0–1–2, 1–3 components 1  → not a bridge
remove 1–3 → walk 0–1–2, 3   components 2  → BRIDGE
             ^^^^^^^^^^^
             the same triangle re-discovered three times
```

- It never uses the fact it keeps re-deriving: **an edge is a bridge exactly when it lies on no cycle.** A single DFS already labels every edge as "tree edge" or "cycle-closing edge" — the brute force throws that away and starts over `E` times.
- Bridges and articulation points are answered by two separate `O(V·E)` sweeps, even though they are the *same* question asked about an edge versus a vertex.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **One DFS, and for every node record the oldest node its subtree can climb back to — if a child's subtree cannot climb past you, you are the only way in or out.**

Think of the DFS tree as a rope ladder you unrolled into the graph, and the non-tree edges as safety ropes thrown back up to an ancestor. Cut a rung: the piece below falls off *unless* some safety rope from below is tied above the cut. Every bridge and every articulation point is just a question about how high the highest safety rope from a subtree reaches.

### The thought process

```text
We need    : the edges / nodes whose removal disconnects the graph.
Obvious way: remove each one and recount components.
Too slow   : O(E(V+E)) and O(V(V+E)).
Notice     : in an UNDIRECTED DFS there are no cross edges — every
             non-tree edge joins a node to one of its own ancestors.
Notice too : so the ONLY way out of a subtree is the tree edge to its
             parent, or a back edge from inside it to an ancestor.
Therefore  : per node record low[u] = the smallest discovery time any
             back edge out of u's subtree can reach.
Now        : compare low[child] with disc[u] and read the answer off. O(V + E).
```

### The two numbers, and the fact that makes them work

```text
disc[u] = the tick at which DFS first visited u        (final immediately)
low[u]  = the smallest disc reachable from u's subtree
          using tree edges DOWN and at most ONE back edge UP,
          never using the tree edge from u to its parent
```

Update rules while scanning `u`'s neighbours:

```text
v unvisited (tree edge)   →  recurse, then  low[u] = min(low[u], low[v])
v visited   (back edge)   →                 low[u] = min(low[u], disc[v])
```

**The enabling fact: an undirected DFS has no cross edges.** Suppose `u—v` is an edge and, when DFS at `u` looks at `v`, `v` is already visited but is *neither* an ancestor nor a descendant of `u`. Then `v` finished before `u` was discovered. But DFS at `v` looked at every neighbour of `v`, including `u`, and `u` was unvisited then — so it would have descended into `u`, making `u` a descendant of `v`. Contradiction. Therefore **every non-tree edge in an undirected graph goes to an ancestor**, which is why "the only exit from a subtree is a back edge to an ancestor" is a complete statement, not an approximation.

### Why `low[v] > disc[u]` means the tree edge `u—v` is a bridge

Read `low[v] > disc[u]` as *"nothing under `v` can reach `u` or anything older than `u` — except by walking the edge `u—v` itself."*

**If `low[v] > disc[u]`, the edge is a bridge.** Every edge leaving `subtree(v)` lands on an ancestor of `v` (no cross edges). The ancestors of `v` are `u` and `u`'s ancestors, all of which have `disc ≤ disc[u]`. If any such edge existed, `low[v]` would have been pulled down to `≤ disc[u]`. It wasn't. So `u—v` is the *only* edge between `subtree(v)` and the rest — delete it and `subtree(v)` falls off.

**If `low[v] ≤ disc[u]`, the edge is not a bridge.** Some node `x` inside `subtree(v)` has a back edge to an ancestor `a` with `disc[a] ≤ disc[u]`. Then `v → … → x → a → … → u` is a detour that never uses `u—v`, so cutting `u—v` changes nothing.

```text
low[v] >  disc[u]   →  bridge (nothing routes around it)
low[v] == disc[u]   →  something under v reaches u ITSELF by another route
low[v] <  disc[u]   →  something under v reaches PAST u
```

### Why articulation points need `>=`, not `>`

For a bridge we delete an **edge**, so `u` survives and can still act as a junction — a subtree that reaches `u` is saved, hence the strict `>`.
For an articulation point we delete the **vertex** `u` itself, so reaching `u` is worthless — the subtree must reach *strictly past* `u` to survive. That single difference flips the comparison:

| Deleting | Subtree of `v` is cut off when | Test |
|---|---|---|
| the edge `u—v` | it cannot reach `u` **or above** | `low[v] > disc[u]` |
| the vertex `u` | it cannot reach **above** `u` | `low[v] >= disc[u]` |

**Non-root `u` is an articulation point ⟺ some tree child `v` has `low[v] >= disc[u]`.**

- *(⟸)* If `low[v] >= disc[u]`, no edge out of `subtree(v)` reaches a proper ancestor of `u` — they all land on `u`. Delete `u` and `subtree(v)` is severed from the root (which is not `u`, since `u` is not the root).
- *(⟹)* If *every* child has `low[v] < disc[u]`, then every child subtree still has an edge to something above `u`. The part of the tree above `u` stays connected to itself without `u`, and each child subtree re-attaches to it, so the graph survives the deletion of `u`.

### Why the root is special

`disc[root] = 0`, so `low[v] >= disc[root]` is true for *every* child — the rule would flag every root. The correct rule:

> **The root is an articulation point ⟺ it has more than one DFS child.**

With **one** child, everything else in the component sits inside that one subtree and stays connected by tree edges after the root is deleted. With **two or more** children `v₁, v₂`, no cross edges exist, so nothing joins `subtree(v₁)` to `subtree(v₂)` except the root — delete it and they fall apart.

"DFS children" means *tree* children, not degree. A root of degree 5 can easily have one DFS child; the other four edges become back edges from below.

### Why a back edge contributes `disc[v]` and a tree edge contributes `low[v]`

A tree edge gives you the child's whole subtree, so you inherit the best escape that subtree found: `low[v]`. A back edge gives you exactly one node, `v` — so you get `disc[v]` and nothing more.

Using `low[v]` for a back edge is not a harmless sloppiness, for two reasons:

1. When you read `low[v]` at a back edge, **`v` is still on the recursion stack and its `low` is not final** — you are reading a half-finished number.
2. It silently reports the **wrong articulation points**. Take two triangles glued at node 1:

```text
   0 ─── 1 ─── 3          edges: 0-1, 1-2, 2-0, 1-3, 3-4, 4-1
   │    ╱ ╲    │
   │   ╱   ╲   │          node 1 IS an articulation point:
   2 ─╯     ╰─ 4          delete it and {0,2} splits from {3,4}
```

DFS from 0 gives `disc = [0,1,2,3,4]` for nodes `0,1,2,3,4`.

```text
correct  : low[4] = min(4, disc[1]=1) = 1  →  low[3] = 1
           at node 1: child 3 has low[3]=1 >= disc[1]=1  →  1 is an AP  ✓

sloppy   : low[4] = min(4, low[1])  and low[1] is already 0
           (node 2's back edge to 0 lowered it)  →  low[4] = 0, low[3] = 0
           at node 1: low[3]=0 >= disc[1]=1 is FALSE  →  1 reported safe  ✗
```

The bogus value leaked *through* node 1 from a completely different subtree. Note also that this graph has **no bridges at all** yet **does** have an articulation point — the two questions are genuinely different.

### The parent edge, and how parallel edges break the naive skip

In an undirected graph every tree edge `u—v` is stored twice, so from `v` you will immediately see `u` again. Walking straight back would set `low[v] = disc[u]` on every node and destroy the whole method. The usual guard is:

```go
if v == parent {
    continue
}
```

That is correct **only when there are no parallel edges**. With two cables between the same pair, `v == parent` skips *both copies* — including the one that is a genuine alternative route:

```text
0 ═══ 1        two distinct cables 0–1

naive skip : at 1, both neighbours equal parent 0 → both skipped
             low[1] = 1 > disc[0] = 0  →  reports "0–1 is a bridge"   ✗
truth      : cut either cable, the other still connects 0 and 1       ✓
```

The fix is to skip **one edge, not one vertex**: give every edge an id, pass down the id you arrived on, and skip only that id. The second copy then reads as an ordinary back edge and correctly pulls `low[1]` down to `0`.

Two smaller cousins of the same care:

- A **self-loop** `u—u` contributes `disc[u]`, which never lowers `low[u]` — harmless, and never a bridge.
- Seeing an already-visited **descendant** (the other half of a back edge you already used) contributes `disc[v] > disc[u]`, which also never lowers `low[u]` — harmless.

### Steps

```text
Step 1 → Build the adjacency list as (neighbour, edgeID) pairs.
Step 2 → For every unvisited node, DFS from it as a root with viaEdge = -1.
Step 3 → On entering u: disc[u] = low[u] = timer++.
Step 4 → For each (v, id) in adj[u]:
           id == viaEdge  → skip (this exact edge, not this vertex)
           v unvisited    → children++; recurse(v, id)
                            low[u] = min(low[u], low[v])
                            low[v] >  disc[u]  → edge u-v is a BRIDGE
                            low[v] >= disc[u] and u is not the root
                                               → u is an ARTICULATION POINT
           v visited      → low[u] = min(low[u], disc[v])
Step 5 → After the loop, if u is the root and children > 1
           → u is an ARTICULATION POINT.
```

### How should I recognize this?

```text
If you see...
  an UNDIRECTED graph plus "critical connection", "single point of
  failure", "the network splits", "minimum days to disconnect",
  "remove one server/cable", "cut vertex", "cut edge"
        ↓
Think about...
  "Can this subtree climb back past its parent without using the
   edge I am about to cut?"
        ↓
Use...
  one DFS with disc[] and low[]
    cutting an EDGE   → low[child] >  disc[u]        (bridge)
    cutting a VERTEX  → low[child] >= disc[u]        (articulation point)
                        root: articulation iff >= 2 DFS children
    directed graph    → the same low-link, but for SCCs (chapter 98)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="tarjan-99" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">low-link on the DFS tree: a back edge lowers low; a tree edge with low(child) &gt; disc(u) is a bridge</text>
  <!-- tree edges -->
  <line x1="120" y1="72" x2="120" y2="127" stroke="#475569" stroke-width="2"/>
  <line x1="120" y1="145" x2="120" y2="200" stroke="#475569" stroke-width="2"/>
  <line x1="140" y1="140" x2="270" y2="200" stroke="#d97706" stroke-width="3"/>
  <!-- back edge 3 -> 1 (dashed) -->
  <path d="M105,205 C40,160 40,110 105,80" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-dasharray="5 4" marker-end="url(#tarjan-99)"/>
  <text x="45" y="145" text-anchor="middle" fill="#2563eb" font-weight="700">back edge</text>
  <!-- bridge label -->
  <text x="230" y="160" text-anchor="middle" fill="#d97706" font-weight="700">bridge</text>
  <!-- nodes with disc/low -->
  <circle cx="120" cy="72" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="76" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="120" cy="135" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="139" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="120" cy="210" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="214" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="285" cy="210" r="20" fill="#fff7ed" stroke="#d97706"/><text x="285" y="214" text-anchor="middle" fill="#1e293b">4</text>
  <text x="160" y="70" fill="#64748b">disc=1 low=1</text>
  <text x="160" y="135" fill="#64748b">disc=2 low=1</text>
  <text x="160" y="240" text-anchor="middle" fill="#64748b">disc=3 low=1</text>
  <text x="285" y="245" text-anchor="middle" fill="#d97706" font-weight="700">disc=4 low=4</text>
  <!-- explanation box -->
  <text x="470" y="90" text-anchor="middle" fill="#1e293b" font-weight="700">rule</text>
  <text x="470" y="115" text-anchor="middle" fill="#64748b">low(u) = min( disc(u),</text>
  <text x="470" y="133" text-anchor="middle" fill="#64748b">low(child), disc(back-target) )</text>
  <text x="470" y="165" text-anchor="middle" fill="#2563eb">3→1 back edge: low(3)=1</text>
  <text x="470" y="183" text-anchor="middle" fill="#2563eb">propagates up: low(2)=1</text>
  <text x="470" y="212" text-anchor="middle" fill="#d97706">edge 2-4: low(4)=4 &gt; disc(2)=2</text>
  <text x="470" y="230" text-anchor="middle" fill="#d97706" font-weight="700">so 2-4 is a bridge</text>
</svg>
```

```text
graph: 0-1, 1-2, 2-0, 1-3          DFS from 0, timer starts at 0

   0(disc 0, low 0)
   │
   1(disc 1, low 0)
   ├── 2(disc 2, low 0) ──back──▶ 0
   └── 3(disc 3, low 3)

edge 1-2 : low[2] = 0 <= disc[1] = 1   the back edge 2→0 routes around it
edge 0-1 : low[1] = 0 <= disc[0] = 0   ditto
edge 1-3 : low[3] = 3 >  disc[1] = 1   nothing under 3 climbs back → BRIDGE

articulation points (delete the vertex, so use >=):
   node 1 : child 3 has low[3] = 3 >= disc[1] = 1  →  1 IS an AP
   node 2 : no children                            →  not an AP
   node 0 : ROOT with only 1 DFS child             →  not an AP
```

### Interview explanation
"I'll run one DFS and keep two numbers per node: `disc`, the tick it was first visited, and `low`, the smallest `disc` its subtree can reach using tree edges down plus at most one back edge up. This works because an undirected DFS has no cross edges — every non-tree edge goes to an ancestor — so the only exits from a subtree are the parent edge and back edges. A tree edge `u—v` is a bridge when `low[v] > disc[u]`: nothing under `v` reaches `u` or above, so that edge is the only link. For articulation points I delete the vertex instead of the edge, so reaching `u` no longer helps and the test relaxes to `low[v] >= disc[u]`; the root is special because everything is `>= 0`, so the root is an articulation point exactly when it has two or more DFS children. Two traps: a back edge must contribute `disc[v]`, not `low[v]` — `low[v]` isn't final yet and leaks values across subtrees — and the parent guard must skip one *edge*, not one *vertex*, or parallel edges get misreported as bridges. It's O(V + E) time and O(V) space."

---

## 5. Generic Templates

> One DFS, two numbers. `low[child] > disc[u]` cuts an edge; `low[child] >= disc[u]` cuts a vertex; the root counts its DFS children instead.

```go
// Neighbor pairs a destination with the id of the edge used to reach it, so
// the parent guard can skip one EDGE rather than one VERTEX (which would be
// wrong when the graph has parallel edges).
type Neighbor struct {
    To     int
    EdgeID int
}

// BuildUndirected turns an edge list into an adjacency list of Neighbors.
func BuildUndirected(n int, edges [][]int) [][]Neighbor {
    adj := make([][]Neighbor, n)
    for id, e := range edges {
        u, v := e[0], e[1]
        adj[u] = append(adj[u], Neighbor{To: v, EdgeID: id})
        adj[v] = append(adj[v], Neighbor{To: u, EdgeID: id})
    }
    return adj
}

// FindBridges returns every edge whose removal increases the number of
// connected components. O(V + E).
func FindBridges(n int, adj [][]Neighbor) [][]int {
    const unvisited = -1
    disc := make([]int, n)
    low := make([]int, n)
    for i := range disc {
        disc[i] = unvisited
    }
    timer := 0
    bridges := [][]int{}

    var explore func(u, viaEdge int)
    explore = func(u, viaEdge int) {
        disc[u] = timer
        low[u] = timer
        timer++
        for _, nb := range adj[u] {
            if nb.EdgeID == viaEdge {
                continue // the one edge we arrived on, not a parallel copy
            }
            if disc[nb.To] == unvisited {
                explore(nb.To, nb.EdgeID)
                if low[nb.To] < low[u] { // tree edge: inherit the child's low
                    low[u] = low[nb.To]
                }
                if low[nb.To] > disc[u] { // nothing below reaches u or above
                    bridges = append(bridges, []int{u, nb.To})
                }
            } else if disc[nb.To] < low[u] {
                low[u] = disc[nb.To] // back edge: DISCOVERY, never low
            }
        }
    }

    for u := 0; u < n; u++ {
        if disc[u] == unvisited {
            explore(u, -1)
        }
    }
    return bridges
}

// FindArticulationPoints returns every vertex whose removal increases the
// number of connected components. Same DFS, >= instead of >, plus the
// special rule for the root of each DFS tree.
func FindArticulationPoints(n int, adj [][]Neighbor) []int {
    const unvisited = -1
    disc := make([]int, n)
    low := make([]int, n)
    isCut := make([]bool, n)
    for i := range disc {
        disc[i] = unvisited
    }
    timer := 0

    var explore func(u, viaEdge int, isRoot bool)
    explore = func(u, viaEdge int, isRoot bool) {
        disc[u] = timer
        low[u] = timer
        timer++
        children := 0
        for _, nb := range adj[u] {
            if nb.EdgeID == viaEdge {
                continue
            }
            if disc[nb.To] == unvisited {
                children++
                explore(nb.To, nb.EdgeID, false)
                if low[nb.To] < low[u] {
                    low[u] = low[nb.To]
                }
                // Deleting u also deletes the edge, so merely reaching u
                // does not save the subtree: >= , not >.
                if !isRoot && low[nb.To] >= disc[u] {
                    isCut[u] = true
                }
            } else if disc[nb.To] < low[u] {
                low[u] = disc[nb.To]
            }
        }
        // Every low is >= disc[root] = 0, so the root needs its own rule.
        if isRoot && children > 1 {
            isCut[u] = true
        }
    }

    for u := 0; u < n; u++ {
        if disc[u] == unvisited {
            explore(u, -1, true)
        }
    }
    points := []int{}
    for u := 0; u < n; u++ {
        if isCut[u] {
            points = append(points, u)
        }
    }
    return points
}
```

```python
def build_undirected(n, edges):
    """Adjacency list of (neighbour, edge_id) so the parent guard can skip
    one EDGE rather than one VERTEX (parallel edges would break the latter)."""
    adj = [[] for _ in range(n)]
    for eid, (u, v) in enumerate(edges):
        adj[u].append((v, eid))
        adj[v].append((u, eid))
    return adj


def find_bridges(n, adj):
    """Edges whose removal increases the component count. O(V + E)."""
    UNVISITED = -1
    disc = [UNVISITED] * n
    low = [0] * n
    bridges = []
    timer = 0

    def explore(u, via_edge):
        nonlocal timer
        disc[u] = low[u] = timer
        timer += 1
        for v, eid in adj[u]:
            if eid == via_edge:
                continue                       # the edge we arrived on
            if disc[v] == UNVISITED:
                explore(v, eid)
                low[u] = min(low[u], low[v])   # tree edge: child's low
                if low[v] > disc[u]:           # nothing below reaches u or above
                    bridges.append([u, v])
            else:
                low[u] = min(low[u], disc[v])  # back edge: DISCOVERY

    for u in range(n):
        if disc[u] == UNVISITED:
            explore(u, -1)
    return bridges


def find_articulation_points(n, adj):
    """Vertices whose removal increases the component count. O(V + E)."""
    UNVISITED = -1
    disc = [UNVISITED] * n
    low = [0] * n
    is_cut = [False] * n
    timer = 0

    def explore(u, via_edge, is_root):
        nonlocal timer
        disc[u] = low[u] = timer
        timer += 1
        children = 0
        for v, eid in adj[u]:
            if eid == via_edge:
                continue
            if disc[v] == UNVISITED:
                children += 1
                explore(v, eid, False)
                low[u] = min(low[u], low[v])
                # Deleting u deletes the edge too, so reaching u is worthless.
                if not is_root and low[v] >= disc[u]:
                    is_cut[u] = True
            else:
                low[u] = min(low[u], disc[v])
        if is_root and children > 1:            # every low >= disc[root] = 0
            is_cut[u] = True

    for u in range(n):
        if disc[u] == UNVISITED:
            explore(u, -1, True)
    return [u for u in range(n) if is_cut[u]]
```

```java
import java.util.*;

public class LowLink {
    private int[] disc, low;
    private int timer;
    private List<int[]>[] adj;              // each entry: {neighbour, edgeId}
    private List<int[]> bridges;
    private boolean[] isCut;

    @SuppressWarnings("unchecked")
    public LowLink(int n, int[][] edges) {
        adj = new List[n];
        for (int i = 0; i < n; i++) adj[i] = new ArrayList<>();
        for (int id = 0; id < edges.length; id++) {
            int u = edges[id][0], v = edges[id][1];
            adj[u].add(new int[]{v, id});
            adj[v].add(new int[]{u, id});   // edge id, so parallel edges work
        }
        disc = new int[n];
        low = new int[n];
        isCut = new boolean[n];
    }

    public List<int[]> findBridges() {
        Arrays.fill(disc, -1);
        bridges = new ArrayList<>();
        timer = 0;
        for (int u = 0; u < disc.length; u++)
            if (disc[u] == -1) bridgeDfs(u, -1);
        return bridges;
    }

    private void bridgeDfs(int u, int viaEdge) {
        disc[u] = low[u] = timer++;
        for (int[] nb : adj[u]) {
            int v = nb[0], id = nb[1];
            if (id == viaEdge) continue;            // skip one EDGE, not a vertex
            if (disc[v] == -1) {
                bridgeDfs(v, id);
                low[u] = Math.min(low[u], low[v]);  // tree edge
                if (low[v] > disc[u]) bridges.add(new int[]{u, v});
            } else {
                low[u] = Math.min(low[u], disc[v]); // back edge: DISCOVERY
            }
        }
    }

    public List<Integer> findArticulationPoints() {
        Arrays.fill(disc, -1);
        Arrays.fill(isCut, false);
        timer = 0;
        for (int u = 0; u < disc.length; u++)
            if (disc[u] == -1) cutDfs(u, -1, true);
        List<Integer> points = new ArrayList<>();
        for (int u = 0; u < disc.length; u++) if (isCut[u]) points.add(u);
        return points;
    }

    private void cutDfs(int u, int viaEdge, boolean isRoot) {
        disc[u] = low[u] = timer++;
        int children = 0;
        for (int[] nb : adj[u]) {
            int v = nb[0], id = nb[1];
            if (id == viaEdge) continue;
            if (disc[v] == -1) {
                children++;
                cutDfs(v, id, false);
                low[u] = Math.min(low[u], low[v]);
                // vertex removal: reaching u does not save the subtree
                if (!isRoot && low[v] >= disc[u]) isCut[u] = true;
            } else {
                low[u] = Math.min(low[u], disc[v]);
            }
        }
        if (isRoot && children > 1) isCut[u] = true;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

struct LowLink {
    int n, timer = 0;
    vector<vector<pair<int, int>>> adj;   // (neighbour, edgeId)
    vector<int> disc, low;
    vector<char> isCut;
    vector<pair<int, int>> bridges;

    LowLink(int n, const vector<pair<int, int>>& edges) : n(n), adj(n) {
        for (int id = 0; id < (int)edges.size(); ++id) {
            auto [u, v] = edges[id];
            adj[u].push_back({v, id});
            adj[v].push_back({u, id});     // edge id keeps parallel edges honest
        }
    }

    void bridgeDfs(int u, int viaEdge) {
        disc[u] = low[u] = timer++;
        for (auto [v, id] : adj[u]) {
            if (id == viaEdge) continue;              // skip one EDGE
            if (disc[v] == -1) {
                bridgeDfs(v, id);
                low[u] = min(low[u], low[v]);         // tree edge
                if (low[v] > disc[u]) bridges.push_back({u, v});
            } else {
                low[u] = min(low[u], disc[v]);        // back edge: DISCOVERY
            }
        }
    }

    vector<pair<int, int>> findBridges() {
        disc.assign(n, -1); low.assign(n, 0); bridges.clear(); timer = 0;
        for (int u = 0; u < n; ++u) if (disc[u] == -1) bridgeDfs(u, -1);
        return bridges;
    }

    void cutDfs(int u, int viaEdge, bool isRoot) {
        disc[u] = low[u] = timer++;
        int children = 0;
        for (auto [v, id] : adj[u]) {
            if (id == viaEdge) continue;
            if (disc[v] == -1) {
                ++children;
                cutDfs(v, id, false);
                low[u] = min(low[u], low[v]);
                // vertex removal: reaching u is worthless, hence >=
                if (!isRoot && low[v] >= disc[u]) isCut[u] = 1;
            } else {
                low[u] = min(low[u], disc[v]);
            }
        }
        if (isRoot && children > 1) isCut[u] = 1;     // every low >= disc[root]
    }

    vector<int> findArticulationPoints() {
        disc.assign(n, -1); low.assign(n, 0); isCut.assign(n, 0); timer = 0;
        for (int u = 0; u < n; ++u) if (disc[u] == -1) cutDfs(u, -1, true);
        vector<int> points;
        for (int u = 0; u < n; ++u) if (isCut[u]) points.push_back(u);
        return points;
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Tarjan Algorithm (Optimal) |
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

### Problem — Critical Connections (LeetCode 1192)
A network of `n` servers is wired by undirected `connections`. Return every connection that is **critical**: removing it leaves some server unreachable from some other server. Those are exactly the graph's **bridges**.

### Thought Process
1. "Critical connection" = "removing this edge disconnects the graph" = **bridge**. That is the whole translation.
2. A bridge is an edge on no cycle. One DFS already tells us which edges close cycles — the non-tree edges.
3. Run one DFS keeping `disc[u]` (visit tick) and `low[u]` (smallest tick the subtree can climb back to via one back edge).
4. On returning from a tree edge `u → v`, report `u—v` when `low[v] > disc[u]`: nothing under `v` reaches `u` or above, so this edge is the only link.
5. Guard the parent by **edge id**, not by vertex id — that costs nothing and stays correct if duplicate connections ever appear.

### Dry Run

Input: `n = 4`, `connections = [[0,1],[1,2],[2,0],[1,3]]`

```text
      0 ───── 1 ───── 3          edge ids: 0-1 → 0
       \     /                             1-2 → 1
        \   /                              2-0 → 2
          2                                1-3 → 3
```

`adj[0] = [(1,e0),(2,e2)]`, `adj[1] = [(0,e0),(2,e1),(3,e3)]`, `adj[2] = [(1,e1),(0,e2)]`, `adj[3] = [(1,e3)]`

| # | at | via | look at | kind | disc / low after | bridge test |
|---|----|-----|---------|------|------------------|-------------|
| 1 | 0 | – | enter | root | `disc[0]=0 low[0]=0` | – |
| 2 | 0 | – | `(1,e0)` | tree, recurse | – | later |
| 3 | 1 | e0 | enter | – | `disc[1]=1 low[1]=1` | – |
| 4 | 1 | e0 | `(0,e0)` | **skip**, arrived on e0 | – | – |
| 5 | 1 | e0 | `(2,e1)` | tree, recurse | – | later |
| 6 | 2 | e1 | enter | – | `disc[2]=2 low[2]=2` | – |
| 7 | 2 | e1 | `(1,e1)` | **skip**, arrived on e1 | – | – |
| 8 | 2 | e1 | `(0,e2)` | back edge | `low[2]=min(2,disc[0]=0)=0` | – |
| 9 | 1 | e0 | return from 2 | – | `low[1]=min(1,0)=0` | `low[2]=0 > disc[1]=1?` **no** |
| 10 | 1 | e0 | `(3,e3)` | tree, recurse | – | later |
| 11 | 3 | e3 | enter | – | `disc[3]=3 low[3]=3` | – |
| 12 | 3 | e3 | `(1,e3)` | **skip**, arrived on e3 | – | – |
| 13 | 1 | e0 | return from 3 | – | `low[1]=min(0,3)=0` | `low[3]=3 > disc[1]=1?` **YES → bridge 1–3** |
| 14 | 0 | – | return from 1 | – | `low[0]=min(0,0)=0` | `low[1]=0 > disc[0]=0?` **no** |
| 15 | 0 | – | `(2,e2)` | back edge | `low[0]=min(0,disc[2]=2)=0` | – |

Output: **`[[1,3]]`**

Row 8 is the row that matters: node 3 never gets a row like it. Nodes 1 and 2 both climb back to tick `0`, so their edges are bypassable; node 3 has no escape rope at all, so `low[3]` stays at its own tick `3`.

### Visualization

```text
DFS tree (solid) + back edge (dashed)

        0  disc 0  low 0
        │
        1  disc 1  low 0
       ╱ ╲
      2   3      2: disc 2  low 0   ← back edge 2⇢0 pulled low to 0
      ┊          3: disc 3  low 3   ← no rope out of its subtree
      ┊
      ╰ ⇢ 0

edge 1–3:  low[3] = 3  >  disc[1] = 1     nothing under 3 climbs past 1
                                          ⇒ cutting it strands 3   → BRIDGE
edge 1–2:  low[2] = 0 <= disc[1] = 1      2 climbs to 0            → safe
edge 0–1:  low[1] = 0 <= disc[0] = 0      1's subtree reaches 0    → safe
```

### Code

```go
// ccNeighbor stores the edge id used to reach To, so the parent guard skips
// one EDGE rather than one VERTEX (which would misreport parallel edges).
type ccNeighbor struct {
    to     int
    edgeID int
}

func criticalConnections(n int, connections [][]int) [][]int {
    adj := make([][]ccNeighbor, n)
    for id, e := range connections {
        u, v := e[0], e[1]
        adj[u] = append(adj[u], ccNeighbor{to: v, edgeID: id})
        adj[v] = append(adj[v], ccNeighbor{to: u, edgeID: id})
    }

    const unvisited = -1
    disc := make([]int, n)
    low := make([]int, n)
    for i := range disc {
        disc[i] = unvisited
    }
    timer := 0
    bridges := [][]int{}

    var explore func(u, viaEdge int)
    explore = func(u, viaEdge int) {
        disc[u] = timer
        low[u] = timer
        timer++

        for _, nb := range adj[u] {
            if nb.edgeID == viaEdge {
                continue // the single edge we arrived on
            }
            if disc[nb.to] == unvisited {
                explore(nb.to, nb.edgeID)
                if low[nb.to] < low[u] { // tree edge: inherit the child's low
                    low[u] = low[nb.to]
                }
                if low[nb.to] > disc[u] { // nothing below reaches u or above
                    bridges = append(bridges, []int{u, nb.to})
                }
            } else if disc[nb.to] < low[u] {
                low[u] = disc[nb.to] // back edge: DISCOVERY, never low
            }
        }
    }

    for u := 0; u < n; u++ {
        if disc[u] == unvisited {
            explore(u, -1)
        }
    }
    return bridges
}
```

```python
def critical_connections(n, connections):
    adj = [[] for _ in range(n)]
    for eid, (u, v) in enumerate(connections):
        adj[u].append((v, eid))
        adj[v].append((u, eid))     # same edge id on both copies

    UNVISITED = -1
    disc = [UNVISITED] * n
    low = [0] * n
    bridges = []
    timer = 0

    def explore(u, via_edge):
        nonlocal timer
        disc[u] = low[u] = timer
        timer += 1
        for v, eid in adj[u]:
            if eid == via_edge:
                continue                        # the single edge we arrived on
            if disc[v] == UNVISITED:
                explore(v, eid)
                low[u] = min(low[u], low[v])    # tree edge: child's low
                if low[v] > disc[u]:            # nothing below reaches u or above
                    bridges.append([u, v])
            else:
                low[u] = min(low[u], disc[v])   # back edge: DISCOVERY

    for u in range(n):
        if disc[u] == UNVISITED:
            explore(u, -1)
    return bridges
```

### Complexity
Time **O(V + E)** — one DFS, each edge inspected twice. Space **O(V + E)** — the adjacency list, plus `O(V)` for `disc`/`low` and the recursion stack.

## 10. Solved Example 2

### Problem — Min Days Disconnect (LeetCode 1568)
A binary grid is an island map (4-directional connectivity). In one day you may turn one land cell into water. Return the minimum number of days until the grid has **zero or more than one** island. The answer is always 0, 1, or 2.

### Thought Process
1. **0 days** if the grid does not already hold exactly one island — nothing to do.
2. **1 day** if some single land cell can be removed to break the island. Deleting one *vertex* to split a graph is precisely the **articulation point** question — so run Tarjan on the island with the `low[child] >= disc[u]` test.
3. One special case the DFS cannot see: an island of a **single cell**. Deleting it leaves zero islands, which also counts as disconnected, so that is 1 day.
4. **2 days always suffice**, so anything else answers 2. Take the topmost-then-leftmost land cell `c`; its up and left neighbours are water, so it has at most 2 land neighbours. Remove them: if land remains, `c` is now its own island and there are ≥ 2 islands; if no land remains the island had ≤ 2 cells, and a 2-cell island erased in 2 days leaves 0 islands. Either way, done.
5. So the whole problem collapses to one articulation-point scan.

### Dry Run

Input: `grid = [[0,1,1,0],[0,1,1,0],[0,0,0,0]]`

```text
      col: 0 1 2 3
row 0:     . A B .        A=(0,1) B=(0,2)
row 1:     . C D .        C=(1,1) D=(1,2)
row 2:     . . . .
```

Islands = 1 and size = 4, so we scan for an articulation cell. DFS from `A`, neighbour order up → down → left → right.

| # | at | parent | look at | kind | disc / low after | AP test |
|---|----|--------|---------|------|------------------|---------|
| 1 | A | – | enter (root) | – | `disc[A]=0 low[A]=0` | – |
| 2 | A | – | down `C` | tree, recurse | `children[A]=1` | later |
| 3 | C | A | enter | – | `disc[C]=1 low[C]=1` | – |
| 4 | C | A | up `A` | **skip**, parent | – | – |
| 5 | C | A | right `D` | tree, recurse | – | later |
| 6 | D | C | enter | – | `disc[D]=2 low[D]=2` | – |
| 7 | D | C | up `B` | tree, recurse | – | later |
| 8 | B | D | enter | – | `disc[B]=3 low[B]=3` | – |
| 9 | B | D | down `D` | **skip**, parent | – | – |
| 10 | B | D | left `A` | back edge | `low[B]=min(3,disc[A]=0)=0` | – |
| 11 | D | C | return from `B` | – | `low[D]=min(2,0)=0` | `low[B]=0 >= disc[D]=2?` **no** |
| 12 | C | A | return from `D` | – | `low[C]=min(1,0)=0` | `low[D]=0 >= disc[C]=1?` **no** |
| 13 | A | – | return from `C` | – | `low[A]=min(0,0)=0` | root: defer |
| 14 | A | – | right `B` | back edge (already visited) | `low[A]=min(0,disc[B]=3)=0` | not a new child |
| 15 | A | – | finish | – | `children[A]=1` | root with 1 child → **not an AP** |

No articulation cell, island size 4 > 1 → Output: **2**

Row 10 is the decisive one: the back edge `B → A` closes the 2×2 cycle, which drags every `low` down to `0` and makes all four `>=` tests fail. Row 14 shows why the root rule counts *DFS children*, not neighbours: `A` has two land neighbours but only one DFS child.

Two more inputs, for the other two answers:

| Input | Islands | Size | Articulation cell? | Output |
|---|---|---|---|---|
| `[[1,0,1,0]]` | 2 | – | – | **0** (already disconnected) |
| `[[1,1]]` | 1 | 2 | none (a lone edge has no cut vertex) | **2** |
| `[[1,1,1]]` | 1 | 3 | the middle cell | **1** |

### Visualization

```text
the island as a graph        the DFS tree found above

   A ─── B                       A          disc/low
   │     │                       │          A: 0 / 0
   C ─── D                       C          C: 1 / 0
                                 │          D: 2 / 0
                                 D          B: 3 / 0
                                 │
                                 B ⇢ A   (back edge closes the cycle)

every low = 0, so no child ever satisfies low[child] >= disc[parent]
        ⇒ it is a 4-cycle: removing ANY one cell leaves an L of 3
        ⇒ still one island ⇒ 1 day is not enough ⇒ answer 2

contrast, a line of three:   E ─ F ─ G
        disc: 0   1   2      low[G] = 2 >= disc[F] = 1  ⇒ F is a cut cell
                             ⇒ answer 1
```

### Code

```go
func gridLandCount(grid [][]int) int {
    total := 0
    for _, row := range grid {
        for _, cell := range row {
            total += cell
        }
    }
    return total
}

// gridIslandCount is a plain flood fill: how many 4-connected land groups.
func gridIslandCount(grid [][]int) int {
    rows, cols := len(grid), len(grid[0])
    seen := make([][]bool, rows)
    for r := range seen {
        seen[r] = make([]bool, cols)
    }
    dr := []int{-1, 1, 0, 0}
    dc := []int{0, 0, -1, 1}

    islands := 0
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == 0 || seen[r][c] {
                continue
            }
            islands++
            stack := [][2]int{{r, c}}
            seen[r][c] = true
            for len(stack) > 0 {
                cur := stack[len(stack)-1]
                stack = stack[:len(stack)-1]
                for k := 0; k < 4; k++ {
                    nr, nc := cur[0]+dr[k], cur[1]+dc[k]
                    if nr < 0 || nr >= rows || nc < 0 || nc >= cols {
                        continue
                    }
                    if grid[nr][nc] == 1 && !seen[nr][nc] {
                        seen[nr][nc] = true
                        stack = append(stack, [2]int{nr, nc})
                    }
                }
            }
        }
    }
    return islands
}

// gridHasCutCell runs Tarjan's articulation-point DFS over the land cells.
// A grid graph has no parallel edges, so guarding by parent CELL is safe.
func gridHasCutCell(grid [][]int) bool {
    rows, cols := len(grid), len(grid[0])
    disc := make([]int, rows*cols)
    low := make([]int, rows*cols)
    for i := range disc {
        disc[i] = -1
    }
    dr := []int{-1, 1, 0, 0}
    dc := []int{0, 0, -1, 1}
    timer := 0
    found := false

    var explore func(r, c, pr, pc int)
    explore = func(r, c, pr, pc int) {
        id := r*cols + c
        disc[id] = timer
        low[id] = timer
        timer++
        children := 0
        isRoot := pr < 0

        for k := 0; k < 4; k++ {
            nr, nc := r+dr[k], c+dc[k]
            if nr < 0 || nr >= rows || nc < 0 || nc >= cols || grid[nr][nc] == 0 {
                continue
            }
            if nr == pr && nc == pc {
                continue // the tree edge we arrived on
            }
            nid := nr*cols + nc
            if disc[nid] == -1 {
                children++
                explore(nr, nc, r, c)
                if low[nid] < low[id] {
                    low[id] = low[nid]
                }
                // Deleting this cell deletes the edge too, so a subtree that
                // only reaches this cell is still cut off: >=, not >.
                if !isRoot && low[nid] >= disc[id] {
                    found = true
                }
            } else if disc[nid] < low[id] {
                low[id] = disc[nid] // back edge: DISCOVERY
            }
        }
        if isRoot && children > 1 { // every low >= disc[root], so count children
            found = true
        }
    }

    for r := 0; r < rows && !found; r++ {
        for c := 0; c < cols && !found; c++ {
            if grid[r][c] == 1 && disc[r*cols+c] == -1 {
                explore(r, c, -1, -1)
            }
        }
    }
    return found
}

func minDaysToDisconnect(grid [][]int) int {
    if len(grid) == 0 || len(grid[0]) == 0 {
        return 0
    }
    if gridIslandCount(grid) != 1 {
        return 0 // zero islands, or already more than one
    }
    if gridLandCount(grid) == 1 {
        return 1 // erase the lone cell → zero islands
    }
    if gridHasCutCell(grid) {
        return 1 // one articulation cell splits the island
    }
    return 2 // two cells always suffice
}
```

```python
def min_days_to_disconnect(grid):
    if not grid or not grid[0]:
        return 0
    rows, cols = len(grid), len(grid[0])
    DIRS = ((-1, 0), (1, 0), (0, -1), (0, 1))

    def island_count():
        seen = [[False] * cols for _ in range(rows)]
        islands = 0
        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == 0 or seen[r][c]:
                    continue
                islands += 1
                stack = [(r, c)]
                seen[r][c] = True
                while stack:
                    cr, cc = stack.pop()
                    for dr, dc in DIRS:
                        nr, nc = cr + dr, cc + dc
                        if 0 <= nr < rows and 0 <= nc < cols \
                                and grid[nr][nc] == 1 and not seen[nr][nc]:
                            seen[nr][nc] = True
                            stack.append((nr, nc))
        return islands

    def has_cut_cell():
        disc = [-1] * (rows * cols)
        low = [0] * (rows * cols)
        state = {"timer": 0, "found": False}

        def explore(r, c, pr, pc):
            cid = r * cols + c
            disc[cid] = low[cid] = state["timer"]
            state["timer"] += 1
            children = 0
            is_root = pr < 0
            for dr, dc in DIRS:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < rows and 0 <= nc < cols) or grid[nr][nc] == 0:
                    continue
                if (nr, nc) == (pr, pc):
                    continue                       # the tree edge we arrived on
                nid = nr * cols + nc
                if disc[nid] == -1:
                    children += 1
                    explore(nr, nc, r, c)
                    low[cid] = min(low[cid], low[nid])
                    # vertex removal ⇒ reaching this cell does not save the subtree
                    if not is_root and low[nid] >= disc[cid]:
                        state["found"] = True
                else:
                    low[cid] = min(low[cid], disc[nid])   # back edge: DISCOVERY
            if is_root and children > 1:
                state["found"] = True

        for r in range(rows):
            for c in range(cols):
                if grid[r][c] == 1 and disc[r * cols + c] == -1:
                    explore(r, c, -1, -1)
        return state["found"]

    if island_count() != 1:
        return 0
    if sum(sum(row) for row in grid) == 1:
        return 1
    return 1 if has_cut_cell() else 2
```

### Complexity
Time **O(R · C)** — a constant number of passes over the grid (each cell has ≤ 4 neighbours, so the graph has O(R·C) edges). Space **O(R · C)** for `disc`, `low` and the recursion stack.

## 11. Solved Example 3

### Problem — Min Malware II (LeetCode 928)
`graph` is an adjacency matrix; `initial` lists the infected nodes. Infection spreads through the whole connected component of every infected node. Remove **one** node from `initial` — deleting it *and all its edges* — so that the final infected count is smallest. Ties go to the smallest index.

### Thought Process
1. This is the articulation-point question with the candidates handed to you: *"if I delete this vertex, what falls off?"* — we do not have to **find** the cut vertices, only **measure** each one.
2. After deleting `u` and infecting from `initial \ {u}`, every remaining infected node is either one of the other `|initial| - 1` seeds, or a clean node reachable from one of them. The seed count is the same whichever `u` you drop, so only the clean nodes matter.
3. Delete **all** the initial nodes and flood-fill what is left. Each resulting **clean component** is infected iff it touches at least one initial node other than `u`.
4. So a clean component `C` is saved by removing `u` exactly when `u` is the **only** initial node adjacent to `C` — that is, `u` is the sole gateway into `C`, a cut vertex for `C`. Add `|C|` to `saved[u]`.
5. Answer = the initial node with the largest `saved`, smallest index on a tie.

### Dry Run

Input: `graph = [[1,1,0,0],[1,1,1,0],[0,1,1,1],[0,0,1,1]]`, `initial = [0,1]`

```text
   (0) ─── (1) ─── 2 ─── 3        (n) = infected seed
```

Step A — delete all seeds `{0,1}` and flood-fill the rest:

| # | start | pop | clean neighbours pushed | component | size |
|---|-------|-----|-------------------------|-----------|------|
| 1 | 2 | 2 | 3 (1 is a seed → not part of it) | `C0 = {2}` | 1 |
| 2 | – | 3 | none (2 already in `C0`) | `C0 = {2,3}` | 2 |

Step B — which seeds touch `C0`?

| seed | its neighbours | clean ones | components touched | owner update |
|------|----------------|-----------|--------------------|--------------|
| 0 | 0, 1 | none | – | – |
| 1 | 0, 1, 2 | 2 | `C0` | `owner[C0] = 1` (first and only) |

Step C — `owner[C0] = 1`, so `saved[1] = |C0| = 2`, `saved[0] = 0`.

Output: **1**

Node `1` is the sole gateway to `{2,3}`; deleting it saves both. Deleting `0` saves nothing, because `1` still infects `2` and `3`.

Two contrast cases:

| `graph` | `initial` | Clean components | Owners | `saved` | Output |
|---|---|---|---|---|---|
| `[[1,1,0],[1,1,0],[0,0,1]]` | `[0,1]` | `{2}` (isolated) | none | `0:0, 1:0` | **0** — tie, smallest index |
| `[[1,1,0],[1,1,1],[0,1,1]]` | `[0,1]` | `{2}` | `1` | `0:0, 1:1` | **1** |

### Visualization

```text
    seeds deleted           who is the sole gateway?

    (0) ─── (1) ─── 2 ─── 3
     ╲       ╲      └─────┘
      ╲       ╲      clean component C0, size 2
       ╲       ╲
        ╲       ╰─▶ adjacent to C0  → candidate owner
         ╰─────────▶ not adjacent   → owns nothing

    owner[C0] = 1  (exactly one seed touches it)
      ⇒ saved[1] = 2 , saved[0] = 0
      ⇒ remove node 1

    if BOTH seeds had touched C0, owner[C0] = "shared" and neither
    could save it — removing one still leaves the other gateway open.
```

### Code

```go
func minMalwareSpread(graph [][]int, initial []int) int {
    n := len(graph)
    if len(initial) == 0 {
        return -1
    }

    isSeed := make([]bool, n)
    for _, u := range initial {
        isSeed[u] = true
    }

    // Flood-fill the graph with EVERY seed deleted: the clean components.
    compOf := make([]int, n)
    for i := range compOf {
        compOf[i] = -1
    }
    compSize := []int{}
    for s := 0; s < n; s++ {
        if isSeed[s] || compOf[s] != -1 {
            continue
        }
        id := len(compSize)
        size := 0
        compOf[s] = id
        stack := []int{s}
        for len(stack) > 0 {
            u := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            size++
            for v := 0; v < n; v++ {
                if graph[u][v] == 1 && !isSeed[v] && compOf[v] == -1 {
                    compOf[v] = id
                    stack = append(stack, v)
                }
            }
        }
        compSize = append(compSize, size)
    }

    // owner[c] = the single seed adjacent to component c,
    //            -1 = none yet, -2 = two or more (nobody can save it).
    owner := make([]int, len(compSize))
    for i := range owner {
        owner[i] = -1
    }
    for _, u := range initial {
        for v := 0; v < n; v++ {
            if graph[u][v] != 1 || isSeed[v] {
                continue
            }
            c := compOf[v]
            if owner[c] == -1 {
                owner[c] = u
            } else if owner[c] != u {
                owner[c] = -2
            }
        }
    }

    saved := make([]int, n)
    for c, o := range owner {
        if o >= 0 {
            saved[o] += compSize[c]
        }
    }

    best := initial[0]
    for _, u := range initial {
        if saved[u] > saved[best] || (saved[u] == saved[best] && u < best) {
            best = u
        }
    }
    return best
}
```

```python
def min_malware_spread(graph, initial):
    n = len(graph)
    if not initial:
        return -1

    is_seed = [False] * n
    for u in initial:
        is_seed[u] = True

    # Flood-fill with every seed deleted: the clean components.
    comp_of = [-1] * n
    comp_size = []
    for s in range(n):
        if is_seed[s] or comp_of[s] != -1:
            continue
        cid = len(comp_size)
        comp_of[s] = cid
        size = 0
        stack = [s]
        while stack:
            u = stack.pop()
            size += 1
            for v in range(n):
                if graph[u][v] == 1 and not is_seed[v] and comp_of[v] == -1:
                    comp_of[v] = cid
                    stack.append(v)
        comp_size.append(size)

    # owner[c]: -1 = no seed yet, -2 = two or more seeds (unsaveable)
    owner = [-1] * len(comp_size)
    for u in initial:
        for v in range(n):
            if graph[u][v] != 1 or is_seed[v]:
                continue
            c = comp_of[v]
            if owner[c] == -1:
                owner[c] = u
            elif owner[c] != u:
                owner[c] = -2

    saved = [0] * n
    for c, o in enumerate(owner):
        if o >= 0:
            saved[o] += comp_size[c]

    best = initial[0]
    for u in initial:
        if saved[u] > saved[best] or (saved[u] == saved[best] and u < best):
            best = u
    return best
```

### Complexity
Time **O(V²)** — the input is an adjacency matrix, so scanning every node's row dominates; on an adjacency list it would be O(V + E). Space **O(V)** for `compOf`, `compSize`, `owner` and `saved`.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1192 | Critical Connections | Easy | Core advanced application |
| 1568 | Min Days Disconnect | Easy | Core advanced application |
| 928 | Min Malware II | Medium | Core advanced application |
| Bridges |  | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tarjan Algorithm logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tarjan Algorithm (Advanced).
- **Signal:** tarjan, bridges, articulation points, low link, dfs tree.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tarjan Algorithm invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tarjan Algorithm
FAMILY : Advanced (Expert)
WHEN   : tarjan, bridges, articulation points, low link, dfs tree
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1192, 1568, 928, Bridges
```

---

*Part of the DSA Patterns Handbook — pattern 99 of 100.*
