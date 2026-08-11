# 64 · Union Find

> **One-liner:** Disjoint Set Union answers connectivity in near-constant amortized time.

---

## 1. Overview

### Definition
The **Union Find** pattern belongs to the *Graphs* family. Disjoint Set Union answers connectivity in near-constant amortized time.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
union find, disjoint set, dsu, connectivity, path compression.

### Constraints
- Input size where the brute-force complexity would time out — the Union Find optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Union Find invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Union Find is the upgrade.
- The wording maps onto: union find, disjoint set, dsu, connectivity, path compression.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Are these two things in the same group?"* — asked repeatedly, while groups keep **merging**.

### Intuition
Store each group as an explicit list of members. To merge two groups, copy one list into the other.

### Algorithm
1. Give every element its own list.
2. To test "same group?", scan the lists for both elements.
3. To merge, append one list to the other and update every moved element's group pointer.

### Complexity
- "Same group?" — O(n) per query with a scan, or O(1) with a group-id array.
- **Merge — O(n)**, because every element of the absorbed group must be relabelled.
- Over `m` merges that is **O(m · n)**.

### Drawbacks
- A DFS or BFS could recompute all components in O(V + E) — but only for a **static** graph. Here edges arrive one at a time, and re-running a full traversal after each new edge is O(m · (V + E)).
- The real waste is relabelling: after merging, every member of the smaller group gets rewritten, even though nothing about *them* changed — only which group they belong to.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Don't store groups as lists. Give each group a single representative, and let every element just point toward it — merging is then one pointer change.**

Each element points at a parent; following parents leads to the group's **root**. Two elements are in the same group exactly when they reach the same root.

```text
group A          group B                 after union(A, B)

   1                 4                        1
  / \                |                       /|\
 2   3               5                      2 3 4
                                                |
                                                5

merging = making one root point at the other: ONE write
```

### The thought process

```text
We need    : "same group?" queries while groups keep merging.
Obvious way: keep member lists; merge by copying.
Too slow   : every merge relabels a whole group → O(m·n).
Notice     : we never need to enumerate a group. We only need to
             ANSWER whether two elements share one.
             That needs a single identity per group, not a list.
Therefore  : point every element toward a representative. Merging two
             groups is just pointing one root at the other.
Now        : both operations are effectively O(1).
```

### The two optimisations, and why each is needed

The naive version degenerates badly: unioning in a bad order builds a long chain, and `find` walks it in O(n). Two fixes together fix that completely.

**1. Union by size (or rank) — keeps trees shallow.**

Always attach the **smaller** tree under the larger root. An element's depth only increases when its tree is absorbed by a bigger one, which at least doubles the size it lives in. A size can double at most `log n` times, so depth is bounded by `O(log n)`.

```text
BAD: always attach root A under root B      GOOD: smaller under larger
     1 → 2 → 3 → 4 → 5   (depth 5)               depth stays ≤ log n
```

**2. Path compression — flattens as you go.**

While walking up in `find`, re-point every node visited **directly at the root**. The walk was going to happen anyway; pointing nodes at the root as you return costs nothing extra and makes every future query on them O(1).

```text
before find(5):   1 → 2 → 3 → 4 → 5      walking up costs 4 hops
after  find(5):   1 ← 2, 3, 4, 5         all now point straight at 1
```

Together these give an amortised cost of **α(n)** — the inverse Ackermann function, which is below 5 for any input that fits in the universe. Treat it as O(1), but call it "effectively constant" rather than actually constant.

### Steps

```text
find(x):
  Step 1 → while parent[x] != x:
  Step 2 →     parent[x] = parent[parent[x]]   ← path compression
  Step 3 →     x = parent[x]
  Step 4 → return x

union(a, b):
  Step 5 → rootA = find(a); rootB = find(b)
  Step 6 → if rootA == rootB: return false     ← already together
  Step 7 → attach the smaller tree under the larger
  Step 8 → add the sizes; decrement the component count
  Step 9 → return true
```

### The return value of `union` is the useful part

Have `union` return **whether it actually merged anything**. That single boolean answers a surprising number of problems directly:

| It returned… | Meaning | Used for |
|---|---|---|
| `false` | they were already connected | **a cycle was just closed** → Redundant Connection |
| `true` | two groups became one | decrement the component count → count islands/provinces |

Counting components needs no extra pass: start the count at `n` and decrement on every successful union.

### Union-Find or DFS?

Both count connected components in roughly linear time. The distinction is *when the edges arrive*:

| | Union-Find | DFS / BFS |
|---|---|---|
| Edges known up front (static) | works | **simpler** |
| Edges arrive one at a time (dynamic) | **the only good option** | must re-run per edge |
| "Did this edge create a cycle?" | one `union` call | needs a traversal |
| Need the actual path or the members | awkward | **natural** |

Union-Find answers *connectivity*; it does not give you paths. And it does **not** handle deletions — removing an edge can split a group, which the structure cannot undo.

### How should I recognize this?

```text
If you see...
  "connected components", "provinces", "friend circles", "islands"
  "does adding this edge create a cycle", "redundant connection"
  "accounts merge", "equations satisfiable"
  edges arriving incrementally
        ↓
Think about...
  "Do I need to KNOW the group, or only whether two things share one?"
        ↓
Use...
  union-find with union by size AND path compression
  count components by decrementing on each successful union
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-64" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Union-Find: child pointers climb to the set root</text>
  <!-- parent pointers (child -> parent) -->
  <line x1="128" y1="140" x2="185" y2="80"  stroke="#475569" marker-end="url(#arw-64)"/>
  <line x1="292" y1="140" x2="235" y2="80"  stroke="#475569" marker-end="url(#arw-64)"/>
  <line x1="120" y1="215" x2="120" y2="168" stroke="#475569" marker-end="url(#arw-64)"/>
  <!-- set A tree rooted at 1 -->
  <circle cx="210" cy="60"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="210" y="65"  text-anchor="middle" font-weight="700" fill="#1e293b">1</text><text x="210" y="35" text-anchor="middle" fill="#059669">root</text>
  <circle cx="110" cy="150" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="110" y="155" text-anchor="middle" font-weight="700" fill="#1e293b">2</text>
  <circle cx="310" cy="150" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="310" y="155" text-anchor="middle" font-weight="700" fill="#1e293b">3</text>
  <circle cx="110" cy="235" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="110" y="240" text-anchor="middle" font-weight="700" fill="#1e293b">4</text>
  <!-- separate singleton set -->
  <circle cx="520" cy="120" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="520" y="125" text-anchor="middle" font-weight="700" fill="#1e293b">5</text><text x="520" y="95" text-anchor="middle" fill="#059669">root</text>
  <text x="400" y="70"  text-anchor="middle" fill="#64748b">find(4) → 1</text>
  <text x="400" y="90"  text-anchor="middle" fill="#64748b">find(5) → 5</text>
  <text x="400" y="115" text-anchor="middle" fill="#1e293b" font-weight="700">1 ≠ 5 → separate sets</text>
</svg>
```

```text
union(1,2), union(3,4), union(2,3)

start:   1   2   3   4        components = 4

union(1,2):   1        3   4      components = 3
              |
              2

union(3,4):   1        3          components = 2
              |        |
              2        4

union(2,3):  find(2)=1, find(3)=3, different → merge
             attach the smaller under the larger

              1
             / \
            2   3
                |
                4              components = 1
```

### Interview explanation
"I'll use union-find. Each element points at a parent, and following parents reaches the group's root — two elements are together exactly when they share a root. Merging is one pointer write instead of relabelling a whole group. Two optimisations keep it fast: union by size, which attaches the smaller tree under the larger so depth stays logarithmic, and path compression, which re-points every node visited during a `find` straight at the root. Together they give amortised inverse-Ackermann, effectively constant. I'll have `union` return whether it actually merged — `false` means the two were already connected, which is exactly a cycle, and counting successful unions gives the component count without a second pass. The reason to prefer this over DFS is that edges arrive incrementally; DFS would have to re-traverse after every edge."

---

## 5. Generic Templates

> Union by size, path compression, and a `union` that reports whether it merged.

```go
// UnionFind maintains disjoint sets with near-constant find and union.
type UnionFind struct {
    parent     []int
    size       []int
    Components int // how many disjoint sets remain
}

func NewUnionFind(n int) *UnionFind {
    parent := make([]int, n)
    size := make([]int, n)
    for i := range parent {
        parent[i] = i // every element starts as its own root
        size[i] = 1
    }
    return &UnionFind{parent: parent, size: size, Components: n}
}

// Find returns x's root, compressing the path on the way up.
func (u *UnionFind) Find(x int) int {
    for u.parent[x] != x {
        // Path compression: point x at its grandparent, halving the
        // chain on every step. The walk was happening anyway.
        u.parent[x] = u.parent[u.parent[x]]
        x = u.parent[x]
    }
    return x
}

// Union merges the sets containing a and b.
// It returns false if they were ALREADY together — which means this
// edge closes a cycle.
func (u *UnionFind) Union(a, b int) bool {
    rootA, rootB := u.Find(a), u.Find(b)
    if rootA == rootB {
        return false // already connected
    }

    // Union by size: attach the smaller tree under the larger one,
    // so depth grows at most logarithmically.
    if u.size[rootA] < u.size[rootB] {
        rootA, rootB = rootB, rootA
    }
    u.parent[rootB] = rootA
    u.size[rootA] += u.size[rootB]
    u.Components--

    return true
}

// Connected reports whether a and b are in the same set.
func (u *UnionFind) Connected(a, b int) bool {
    return u.Find(a) == u.Find(b)
}
```

```python
class UnionFind:
    """Disjoint sets with union by size and path compression."""

    def __init__(self, n):
        self.parent = list(range(n))     # every element is its own root
        self.size = [1] * n
        self.components = n

    def find(self, x):
        while self.parent[x] != x:
            # Path compression: point x at its grandparent.
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        """Returns False if a and b were ALREADY connected (a cycle)."""
        root_a, root_b = self.find(a), self.find(b)
        if root_a == root_b:
            return False

        # Union by size: smaller tree goes under the larger.
        if self.size[root_a] < self.size[root_b]:
            root_a, root_b = root_b, root_a
        self.parent[root_b] = root_a
        self.size[root_a] += self.size[root_b]
        self.components -= 1
        return True

    def connected(self, a, b):
        return self.find(a) == self.find(b)
```

```java
public class UnionFind {
    private final int[] parent;
    private final int[] size;
    private int components;

    public UnionFind(int n) {
        parent = new int[n];
        size = new int[n];
        for (int i = 0; i < n; i++) { parent[i] = i; size[i] = 1; }
        components = n;
    }

    public int find(int x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];      // path compression
            x = parent[x];
        }
        return x;
    }

    // Returns false if a and b were ALREADY connected (a cycle).
    public boolean union(int a, int b) {
        int rootA = find(a), rootB = find(b);
        if (rootA == rootB) return false;

        if (size[rootA] < size[rootB]) {        // union by size
            int t = rootA; rootA = rootB; rootB = t;
        }
        parent[rootB] = rootA;
        size[rootA] += size[rootB];
        components--;
        return true;
    }

    public boolean connected(int a, int b) { return find(a) == find(b); }
    public int getComponents() { return components; }
}
```

```cpp
#include <numeric>
#include <vector>
using namespace std;

class UnionFind {
    vector<int> parent, size;
    int components;

public:
    explicit UnionFind(int n) : parent(n), size(n, 1), components(n) {
        iota(parent.begin(), parent.end(), 0);   // every element its own root
    }

    int find(int x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];       // path compression
            x = parent[x];
        }
        return x;
    }

    // Returns false if a and b were ALREADY connected (a cycle).
    bool unite(int a, int b) {
        int rootA = find(a), rootB = find(b);
        if (rootA == rootB) return false;

        if (size[rootA] < size[rootB]) swap(rootA, rootB);   // union by size
        parent[rootB] = rootA;
        size[rootA] += size[rootB];
        --components;
        return true;
    }

    bool connected(int a, int b) { return find(a) == find(b); }
    int getComponents() const { return components; }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Union Find (Optimal) |
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

### Problem — Number of Provinces (LeetCode 547)
`isConnected[i][j] == 1` means cities `i` and `j` are directly connected. Count the provinces (groups of directly or indirectly connected cities).

### Thought Process
1. A province is a connected component, and union-find counts components without any traversal.
2. Start with `n` components — every city alone.
3. Walk the upper triangle of the matrix (it is symmetric, so `j > i` suffices) and union each connected pair.
4. Every **successful** union merges two groups into one, so decrement the count.
5. The remaining count is the answer — no second pass, no visited array.

### Dry Run

Input:

```text
isConnected = [[1, 1, 0],
               [1, 1, 0],
               [0, 0, 1]]
```

Start: `parent = [0, 1, 2]`, `components = 3`

| pair (i,j) | connected? | find(i), find(j) | union merged? | components |
|------------|-----------|-------------------|---------------|------------|
| (0,1) | yes | 0, 1 — different | **yes** → `parent[1] = 0` | 3 → **2** |
| (0,2) | no | — | — | 2 |
| (1,2) | no | — | — | 2 |

Output: **2** ✓

Only the upper triangle is scanned, and the diagonal is skipped entirely — a city connected to itself would be a no-op union anyway, since `find(i) == find(i)`.

### Visualization

```text
      0 —— 1        2

start:  {0} {1} {2}          components = 3
union(0,1) succeeds:
        {0,1}  {2}           components = 2

           0
           |
           1        2
```

### Code

```go
func findCircleNum(isConnected [][]int) int {
    n := len(isConnected)
    uf := NewUnionFind(n)

    // The matrix is symmetric, so the upper triangle is enough.
    for i := 0; i < n; i++ {
        for j := i + 1; j < n; j++ {
            if isConnected[i][j] == 1 {
                uf.Union(i, j) // decrements Components on a real merge
            }
        }
    }

    return uf.Components
}

// UnionFind maintains disjoint sets with near-constant find and union.
type UnionFind struct {
    parent     []int
    size       []int
    Components int
}

func NewUnionFind(n int) *UnionFind {
    parent := make([]int, n)
    size := make([]int, n)
    for i := range parent {
        parent[i] = i
        size[i] = 1
    }
    return &UnionFind{parent: parent, size: size, Components: n}
}

func (u *UnionFind) Find(x int) int {
    for u.parent[x] != x {
        u.parent[x] = u.parent[u.parent[x]] // path compression
        x = u.parent[x]
    }
    return x
}

// Union returns false if a and b were already connected.
func (u *UnionFind) Union(a, b int) bool {
    rootA, rootB := u.Find(a), u.Find(b)
    if rootA == rootB {
        return false
    }
    if u.size[rootA] < u.size[rootB] { // union by size
        rootA, rootB = rootB, rootA
    }
    u.parent[rootB] = rootA
    u.size[rootA] += u.size[rootB]
    u.Components--
    return true
}
```

```python
def findCircleNum(isConnected):
    n = len(isConnected)
    uf = UnionFind(n)

    # The matrix is symmetric, so the upper triangle is enough.
    for i in range(n):
        for j in range(i + 1, n):
            if isConnected[i][j] == 1:
                uf.union(i, j)          # decrements components on a real merge

    return uf.components
```

### Complexity
Time **O(n² · α(n))** — the matrix scan dominates; each union is effectively constant. Space O(n).

> The Graph DFS chapter solves this same problem with a traversal. Both are fine here because the graph is static. Union-find becomes the *only* good option once edges arrive one at a time — which is exactly the next example.

---

## 10. Solved Example 2

### Problem — Redundant Connection (LeetCode 684)
A tree of `n` nodes had one extra edge added, creating exactly one cycle. Return the edge that can be removed — if several qualify, the one appearing last in the input.

### Thought Process
1. A tree on `n` nodes has exactly `n − 1` edges and no cycles. Adding one more must close exactly one cycle.
2. Process edges in order, unioning each pair.
3. If `union(a, b)` returns **`false`**, then `a` and `b` were already connected — so this edge closes a cycle. That is the redundant one.
4. Because we scan in input order, the **first** such failure is the last edge that could be removed... and since exactly one cycle exists, it is the answer.
5. This is the payoff of having `union` return a boolean: cycle detection is one function call, no traversal.

### Dry Run

Input: `edges = [[1,2], [1,3], [2,3]]` (nodes are 1-indexed)

Start: every node its own root, `components = 3` (ignoring the unused index 0)

| edge | find(a) | find(b) | same root? | action |
|------|---------|---------|------------|--------|
| `[1,2]` | 1 | 2 | no | merge → `{1,2}` |
| `[1,3]` | 1 | 3 | no | merge → `{1,2,3}` |
| `[2,3]` | **1** | **1** | **yes** | `union` returns `false` → **return `[2,3]`** |

Output: **`[2, 3]`** ✓

Verify: without `[2,3]`, the edges `[1,2]` and `[1,3]` form a valid tree on 3 nodes. Adding `[2,3]` creates the cycle `1–2–3–1`. ✓

**A longer case**, `edges = [[1,2], [2,3], [3,4], [1,4], [1,5]]`:

| edge | same root? | action |
|------|------------|--------|
| `[1,2]` | no | merge → `{1,2}` |
| `[2,3]` | no | merge → `{1,2,3}` |
| `[3,4]` | no | merge → `{1,2,3,4}` |
| `[1,4]` | **yes** — both reach root 1 | **return `[1,4]`** |
| `[1,5]` | not reached | — |

Output: **`[1, 4]`** ✓ — the cycle is `1–2–3–4–1`.

### Visualization

```text
edges: [1,2]  [1,3]  [2,3]

    1        1          1
    |       / \        / \
    2      2   3      2   3
                       \_/   ← [2,3] joins two already-connected nodes

  union(2,3) → find(2) == find(3) == 1 → returns false → redundant
```

### Code

```go
func findRedundantConnection(edges [][]int) []int {
    // Nodes are 1..n, so size the structure n+1 and ignore index 0.
    uf := NewRedundantUF(len(edges) + 1)

    for _, edge := range edges {
        // union returns false when the two ends were ALREADY connected,
        // which means this edge closes a cycle.
        if !uf.Union(edge[0], edge[1]) {
            return edge
        }
    }
    return nil // the problem guarantees exactly one redundant edge
}

type RedundantUF struct {
    parent []int
    size   []int
}

func NewRedundantUF(n int) *RedundantUF {
    parent := make([]int, n)
    size := make([]int, n)
    for i := range parent {
        parent[i] = i
        size[i] = 1
    }
    return &RedundantUF{parent: parent, size: size}
}

func (u *RedundantUF) Find(x int) int {
    for u.parent[x] != x {
        u.parent[x] = u.parent[u.parent[x]] // path compression
        x = u.parent[x]
    }
    return x
}

func (u *RedundantUF) Union(a, b int) bool {
    rootA, rootB := u.Find(a), u.Find(b)
    if rootA == rootB {
        return false // already connected: this edge is redundant
    }
    if u.size[rootA] < u.size[rootB] {
        rootA, rootB = rootB, rootA
    }
    u.parent[rootB] = rootA
    u.size[rootA] += u.size[rootB]
    return true
}
```

```python
def findRedundantConnection(edges):
    # Nodes are 1..n, so size the structure n+1 and ignore index 0.
    uf = UnionFind(len(edges) + 1)

    for a, b in edges:
        # union returns False when a and b were ALREADY connected.
        if not uf.union(a, b):
            return [a, b]
    return []
```

### Complexity
Time **O(n · α(n))** — effectively linear. Space O(n).

> DFS could also find the cycle, but it would need a fresh traversal after each edge to know *when* the cycle appeared — O(n²). Union-find answers it incrementally, which is exactly the situation it exists for.

---

## 11. Solved Example 3

### Problem — Number of Islands (LeetCode 200)
Count islands in a grid of `'1'` (land) and `'0'` (water), where land connects horizontally and vertically.

### Thought Process
1. Map each cell `(row, col)` to a single integer id: `row * cols + col`. Union-find works on integers, so this flattening is what makes a grid usable.
2. Count the land cells and start `islands` at that number — every land cell is initially its own island.
3. For each land cell, union it with its **right** and **down** neighbours only. Left and up are covered when those cells are processed, so checking all four would just do the work twice.
4. Every successful union merges two islands, so decrement.
5. Water cells are never unioned and never counted.

### Dry Run

Input:

```text
     col: 0 1 2
row 0:    1 1 0
row 1:    1 0 0
row 2:    0 0 1
```

Cell ids: `(r,c) → r*3 + c`. Land cells: `(0,0)=0`, `(0,1)=1`, `(1,0)=3`, `(2,2)=8` → **4 land cells**, so `islands` starts at 4.

| cell | id | right neighbour | down neighbour | unions attempted | merged? | islands |
|------|-----|-----------------|----------------|-------------------|---------|---------|
| (0,0) | 0 | (0,1) is land, id 1 | (1,0) is land, id 3 | union(0,1), union(0,3) | both **yes** | 4 → 3 → **2** |
| (0,1) | 1 | (0,2) is water | (1,1) is water | none | — | 2 |
| (1,0) | 3 | (1,1) is water | (2,0) is water | none | — | 2 |
| (2,2) | 8 | out of bounds | out of bounds | none | — | **2** |

Output: **2** ✓

The two islands are `{(0,0), (0,1), (1,0)}` and `{(2,2)}`. ✓

Note that we never union `(0,1)` with `(0,0)` a second time: `(0,1)` only looks right and down, and `(0,0)` already handled the leftward link. That halves the union calls with no loss of coverage.

### Visualization

```text
    1 1 0        ids:  0 1 ·
    1 0 0              3 · ·
    0 0 1              · · 8

start: 4 land cells → islands = 4

  (0,0) unions right (id 1)  →  merged, islands = 3
  (0,0) unions down  (id 3)  →  merged, islands = 2
  (2,2) has no land neighbours

    {0, 1, 3}      {8}       →  2 islands
```

### Code

```go
func numIslands(grid [][]byte) int {
    if len(grid) == 0 || len(grid[0]) == 0 {
        return 0
    }
    rows, cols := len(grid), len(grid[0])

    // Flatten (row, col) into a single id so union-find can hold it.
    uf := NewIslandUF(rows * cols)

    islands := 0
    for row := 0; row < rows; row++ {
        for col := 0; col < cols; col++ {
            if grid[row][col] == '1' {
                islands++ // every land cell starts as its own island
            }
        }
    }

    for row := 0; row < rows; row++ {
        for col := 0; col < cols; col++ {
            if grid[row][col] != '1' {
                continue
            }
            id := row*cols + col

            // Only right and down: left and up are handled by those cells.
            if col+1 < cols && grid[row][col+1] == '1' {
                if uf.Union(id, row*cols+col+1) {
                    islands-- // two islands became one
                }
            }
            if row+1 < rows && grid[row+1][col] == '1' {
                if uf.Union(id, (row+1)*cols+col) {
                    islands--
                }
            }
        }
    }

    return islands
}

type IslandUF struct {
    parent []int
    size   []int
}

func NewIslandUF(n int) *IslandUF {
    parent := make([]int, n)
    size := make([]int, n)
    for i := range parent {
        parent[i] = i
        size[i] = 1
    }
    return &IslandUF{parent: parent, size: size}
}

func (u *IslandUF) Find(x int) int {
    for u.parent[x] != x {
        u.parent[x] = u.parent[u.parent[x]]
        x = u.parent[x]
    }
    return x
}

func (u *IslandUF) Union(a, b int) bool {
    rootA, rootB := u.Find(a), u.Find(b)
    if rootA == rootB {
        return false
    }
    if u.size[rootA] < u.size[rootB] {
        rootA, rootB = rootB, rootA
    }
    u.parent[rootB] = rootA
    u.size[rootA] += u.size[rootB]
    return true
}
```

```python
def numIslands(grid):
    if not grid or not grid[0]:
        return 0
    rows, cols = len(grid), len(grid[0])

    uf = UnionFind(rows * cols)         # flatten (row, col) → row*cols + col
    islands = sum(row.count("1") for row in grid)   # each land cell starts alone

    for row in range(rows):
        for col in range(cols):
            if grid[row][col] != "1":
                continue
            cell = row * cols + col
            # Only right and down: left and up are handled by those cells.
            if col + 1 < cols and grid[row][col + 1] == "1":
                if uf.union(cell, row * cols + col + 1):
                    islands -= 1
            if row + 1 < rows and grid[row + 1][col] == "1":
                if uf.union(cell, (row + 1) * cols + col):
                    islands -= 1

    return islands
```

### Complexity
Time **O(rows × cols × α)** — effectively linear in the number of cells. Space O(rows × cols).

> DFS solves this in the same complexity and with less code (see the Graph DFS chapter). Union-find earns its place when the grid **changes** — LeetCode 305, "Number of Islands II", adds land one cell at a time, and re-running DFS after each addition would be quadratic. Union-find just calls `union`.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 547 | Provinces | Easy | Core graphs application |
| 684 | Redundant Connection | Easy | Core graphs application |
| 200 | Num Islands | Medium | Core graphs application |
| 1319 | Network Connected | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Union Find logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Union Find (Graphs).
- **Signal:** union find, disjoint set, dsu, connectivity, path compression.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Union Find invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Union Find
FAMILY : Graphs (Advanced)
WHEN   : union find, disjoint set, dsu, connectivity, path compression
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 547, 684, 200, 1319
```

---

*Part of the DSA Patterns Handbook — pattern 64 of 100.*
