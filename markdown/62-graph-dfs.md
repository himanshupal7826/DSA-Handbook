# 62 · Graph DFS

> **One-liner:** Recursive/stack exploration for connectivity, components, and cycles.

---

## 1. Overview

### Definition
The **Graph DFS** pattern belongs to the *Graphs* family. Recursive/stack exploration for connectivity, components, and cycles.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
graph dfs, connected components, recursion, visited, islands.

### Constraints
- Input size where the brute-force complexity would time out — the Graph DFS optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Graph DFS invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Graph DFS is the upgrade.
- The wording maps onto: graph dfs, connected components, recursion, visited, islands.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which things are reachable from here?"* — connected components, islands, whole-graph copies.

### Intuition
Without any memory of where you've been, follow edges and hope.

### Algorithm
1. Start at a node and follow an edge.
2. Keep following edges to unexplored-looking neighbours.
3. Whenever you return to a node you've already processed, you have no way to tell — so you process it again.
4. Repeat for every starting node to find all components.

### Complexity
- Time: **unbounded** — on any graph containing a cycle this never terminates.
- Even on a DAG it is **exponential**, because a node reachable by many distinct paths is re-explored once per path.

### Drawbacks
- This is the one place where the naive approach isn't merely slow — it is **wrong**. A graph is not a tree: nodes can have multiple parents and edges can form cycles, so "follow the edges" can loop forever.
- That single difference is what every graph traversal is built around.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Same recursion as a tree DFS, plus one thing a tree never needed: a `visited` set, checked *before* you recurse.**

```text
tree DFS   :  visit node → recurse into children
graph DFS  :  if already visited, STOP
              mark visited
              recurse into neighbours
```

That guard is the entire difference, and it is what turns a non-terminating walk into a linear one.

### The thought process

```text
We need    : everything reachable from a starting node.
Obvious way: follow edges recursively, like a tree.
Breaks     : graphs have cycles and multiple parents, so this
             loops forever or re-explores exponentially.
Notice     : a node's reachable set doesn't change based on HOW
             we arrived. Visiting it twice can never teach us
             anything new.
Therefore  : mark each node the first time we see it, and never
             enter it again.
Now        : every node and edge is handled once → O(V + E).
```

### Why trees don't need `visited` and graphs do

A tree guarantees three things a general graph does not:

```text
tree                          graph
─────────────────────────     ─────────────────────────
no cycles                     cycles are normal
exactly one parent per node   many parents allowed
one path between any two      many paths possible
```

Each of those independently breaks the naive walk. Cycles make it non-terminating; multiple paths make it exponential. **A tree is just a graph where the guard happens to be unnecessary.**

### Mark on entry, not on exit

The single most common bug in this pattern:

```go
var adjacency [][]int
var visited []bool

// WRONG — the mark comes too late.
func dfsBroken(node int) {
    for _, next := range adjacency[node] {
        dfsBroken(next) // a cycle re-enters `node` before it is ever marked
    }
    visited[node] = true
}

// RIGHT — the mark happens before any neighbour is touched.
func dfsCorrect(node int) {
    if visited[node] {
        return
    }
    visited[node] = true
    for _, next := range adjacency[node] {
        dfsCorrect(next)
    }
}
```

By the time the mark is written, the recursion may already have come back around. **Mark the node the instant you enter it**, before touching any neighbour.

### Steps

```text
Step 1 → visited = empty set
Step 2 → define dfs(node):
Step 3 →     if node is in visited, return
Step 4 →     add node to visited          ← immediately, before recursing
Step 5 →     for each neighbour of node:  dfs(neighbour)
Step 6 → to cover the WHOLE graph, loop over every node and dfs it
          if it isn't visited yet; each such call is one component
```

Step 6 matters: a graph may be **disconnected**, so a single DFS from one node can miss entire regions. The outer loop is what makes "count the components" work — and the number of times you *start* a fresh DFS is exactly the component count.

### Grids are graphs in disguise

Most "islands" problems are grid problems, and the translation is mechanical:

```text
node       = cell (row, col)
neighbours = the 4 (or 8) adjacent cells, if in bounds and passable
visited    = a bool grid, OR mutate the input cell to mark it
```

Overwriting the input (turning a `'1'` into a `'0'`) saves the O(V) visited grid, but it destroys the caller's data. Say which trade you are making — some interviewers care.

### DFS or BFS?

For pure reachability, **either works and both are O(V + E)**. Choose on other grounds:

| Use DFS when… | Use BFS when… |
|---|---|
| you just need reachability / components | you need the **shortest** path in an unweighted graph |
| you need path structure (cycle detection, topological order) | the graph is very deep (recursion would overflow) |
| the recursive code is simpler to write | you need level-by-level information |

DFS uses O(depth) stack; BFS uses O(width) queue. Neither dominates.

### How should I recognize this?

```text
If you see...
  "number of islands / provinces / connected components"
  "can I reach X from Y", "flood fill", "clone / copy a graph"
  a grid where adjacent same-valued cells form regions
        ↓
Think about...
  "What is a node, what is an edge, and what does visited mean?"
        ↓
Use...
  DFS/BFS with a visited set, marked ON ENTRY
  plus an outer loop over all nodes if the graph may be disconnected
```

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-62" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#059669"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">DFS from A — numbers show discovery order</text>
  <!-- tree edges with discovery arrows -->
  <line x1="300" y1="60"  x2="205" y2="115" stroke="#059669" stroke-width="2" marker-end="url(#arw-62)"/>
  <line x1="185" y1="140" x2="130" y2="185" stroke="#059669" stroke-width="2" marker-end="url(#arw-62)"/>
  <line x1="205" y1="140" x2="255" y2="185" stroke="#059669" stroke-width="2" marker-end="url(#arw-62)"/>
  <line x1="330" y1="65"  x2="450" y2="110" stroke="#059669" stroke-width="2" marker-end="url(#arw-62)"/>
  <line x1="470" y1="135" x2="470" y2="180" stroke="#059669" stroke-width="2" marker-end="url(#arw-62)"/>
  <!-- nodes -->
  <circle cx="315" cy="50"  r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="315" y="55"  text-anchor="middle" font-weight="700" fill="#1e293b">A</text><text x="315" y="30" text-anchor="middle" fill="#059669">1</text>
  <circle cx="190" cy="125" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="190" y="130" text-anchor="middle" font-weight="700" fill="#1e293b">B</text><text x="158" y="120" text-anchor="middle" fill="#059669">2</text>
  <circle cx="115" cy="200" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="115" y="205" text-anchor="middle" font-weight="700" fill="#1e293b">C</text><text x="115" y="180" text-anchor="middle" fill="#059669">3</text>
  <circle cx="270" cy="200" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="270" y="205" text-anchor="middle" font-weight="700" fill="#1e293b">D</text><text x="270" y="180" text-anchor="middle" fill="#059669">4</text>
  <circle cx="470" cy="120" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="470" y="125" text-anchor="middle" font-weight="700" fill="#1e293b">E</text><text x="502" y="115" text-anchor="middle" fill="#059669">5</text>
  <circle cx="470" cy="200" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="470" y="205" text-anchor="middle" font-weight="700" fill="#1e293b">F</text><text x="502" y="200" text-anchor="middle" fill="#059669">6</text>
  <text x="590" y="55" text-anchor="middle" fill="#64748b">go deep,</text>
  <text x="590" y="72" text-anchor="middle" fill="#64748b">backtrack</text>
</svg>
```

```text
grid:   1 1 0
        1 0 0
        0 0 1

start DFS at (0,0):
    mark (0,0) → neighbours (0,1) and (1,0)
    mark (0,1) → no unvisited land neighbours
    mark (1,0) → none
  → one island consumed

outer loop continues, finds unvisited land at (2,2):
    mark (2,2)
  → second island

answer: 2 islands  =  2 times we STARTED a fresh DFS
```

### Interview explanation
"A graph differs from a tree in exactly one way that matters here: it can have cycles and multiple paths to the same node, so a plain recursive walk either loops forever or re-explores exponentially. The fix is a `visited` set checked before recursing, and marked the moment I enter a node rather than on the way out — otherwise a cycle can re-enter before the mark lands. Then every node and edge is processed once, giving O(V + E). For counting components I wrap it in an outer loop over all nodes, since the graph may be disconnected; the number of times I start a fresh DFS is the number of components. For a grid, the node is a cell and the neighbours are the in-bounds adjacent cells — same algorithm."

---

## 5. Generic Templates

> The `visited` guard is the whole difference from a tree. Mark on entry.

```go
// DFS explores everything reachable from start, marking on entry.
func DFS(adjacency map[int][]int, start int, visited map[int]bool) []int {
    order := []int{}

    var walk func(int)
    walk = func(node int) {
        if visited[node] {
            return // the guard: without it, cycles loop forever
        }
        visited[node] = true // mark IMMEDIATELY, before any recursion
        order = append(order, node)

        for _, next := range adjacency[node] {
            walk(next)
        }
    }

    walk(start)
    return order
}

// CountComponents handles a possibly disconnected graph. Each fresh DFS
// start is exactly one component.
func CountComponents(n int, edges [][]int) int {
    adjacency := make(map[int][]int, n)
    for _, e := range edges {
        adjacency[e[0]] = append(adjacency[e[0]], e[1])
        adjacency[e[1]] = append(adjacency[e[1]], e[0]) // undirected
    }

    visited := make(map[int]bool, n)
    components := 0

    for node := 0; node < n; node++ {
        if !visited[node] {
            components++ // starting a new DFS means a new component
            DFS(adjacency, node, visited)
        }
    }
    return components
}

// DFSGrid is the same idea where a node is a cell.
func DFSGrid(grid [][]byte, row, col int, target byte, visited [][]bool) int {
    // Out of bounds, wrong value, or already seen → stop.
    if row < 0 || row >= len(grid) || col < 0 || col >= len(grid[0]) {
        return 0
    }
    if visited[row][col] || grid[row][col] != target {
        return 0
    }

    visited[row][col] = true // mark on entry
    size := 1

    // The four orthogonal neighbours.
    size += DFSGrid(grid, row-1, col, target, visited)
    size += DFSGrid(grid, row+1, col, target, visited)
    size += DFSGrid(grid, row, col-1, target, visited)
    size += DFSGrid(grid, row, col+1, target, visited)

    return size
}
```

```python
def dfs(adjacency, start, visited):
    """Everything reachable from start. Marks on entry."""
    order = []

    def walk(node):
        if node in visited:
            return                      # the guard: cycles would loop forever
        visited.add(node)               # mark IMMEDIATELY
        order.append(node)
        for nxt in adjacency.get(node, ()):
            walk(nxt)

    walk(start)
    return order

def count_components(n, edges):
    """Each fresh DFS start is exactly one component."""
    adjacency = {}
    for a, b in edges:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)      # undirected

    visited, components = set(), 0
    for node in range(n):
        if node not in visited:
            components += 1
            dfs(adjacency, node, visited)
    return components

def dfs_grid(grid, row, col, target, visited):
    """Same idea where a node is a cell."""
    if not (0 <= row < len(grid) and 0 <= col < len(grid[0])):
        return 0
    if visited[row][col] or grid[row][col] != target:
        return 0

    visited[row][col] = True            # mark on entry
    size = 1
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        size += dfs_grid(grid, row + dr, col + dc, target, visited)
    return size
```

```java
import java.util.*;

public class GraphDFS {
    public static List<Integer> dfs(Map<Integer, List<Integer>> adjacency,
                                    int start, Set<Integer> visited) {
        List<Integer> order = new ArrayList<>();
        walk(adjacency, start, visited, order);
        return order;
    }

    private static void walk(Map<Integer, List<Integer>> adjacency, int node,
                             Set<Integer> visited, List<Integer> order) {
        if (!visited.add(node)) return;         // add returns false if present
        order.add(node);
        for (int next : adjacency.getOrDefault(node, List.of()))
            walk(adjacency, next, visited, order);
    }

    // Each fresh DFS start is exactly one component.
    public static int countComponents(int n, int[][] edges) {
        Map<Integer, List<Integer>> adjacency = new HashMap<>();
        for (int[] e : edges) {
            adjacency.computeIfAbsent(e[0], k -> new ArrayList<>()).add(e[1]);
            adjacency.computeIfAbsent(e[1], k -> new ArrayList<>()).add(e[0]);
        }

        Set<Integer> visited = new HashSet<>();
        int components = 0;
        for (int node = 0; node < n; node++) {
            if (!visited.contains(node)) {
                components++;
                dfs(adjacency, node, visited);
            }
        }
        return components;
    }
}
```

```cpp
#include <unordered_map>
#include <unordered_set>
#include <vector>
using namespace std;

void walk(const unordered_map<int, vector<int>>& adjacency, int node,
          unordered_set<int>& visited, vector<int>& order) {
    if (visited.count(node)) return;            // the guard
    visited.insert(node);                        // mark on entry
    order.push_back(node);

    auto it = adjacency.find(node);
    if (it == adjacency.end()) return;
    for (int next : it->second) walk(adjacency, next, visited, order);
}

// Each fresh DFS start is exactly one component.
int countComponents(int n, const vector<vector<int>>& edges) {
    unordered_map<int, vector<int>> adjacency;
    for (const auto& e : edges) {
        adjacency[e[0]].push_back(e[1]);
        adjacency[e[1]].push_back(e[0]);         // undirected
    }

    unordered_set<int> visited;
    int components = 0;
    for (int node = 0; node < n; ++node) {
        if (!visited.count(node)) {
            ++components;
            vector<int> order;
            walk(adjacency, node, visited, order);
        }
    }
    return components;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Graph DFS (Optimal) |
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

### Problem — Number of Islands (LeetCode 200)
Given a grid of `'1'` (land) and `'0'` (water), count the islands. An island is land connected horizontally or vertically.

### Thought Process
1. This is a graph in disguise: each land cell is a node, and edges join orthogonally adjacent land cells.
2. Counting islands is counting **connected components**, so scan every cell and start a DFS whenever an unvisited land cell appears.
3. Each DFS floods one entire island, marking every cell it reaches so the outer scan never restarts inside the same island.
4. The count is simply **how many times we started a DFS**.
5. Mark on entry, and let the bounds check live at the top of the recursion so callers never need to test before recursing.

### Dry Run

Input:

```text
     col: 0 1 2 3 4
row 0:    1 1 0 0 0
row 1:    1 1 0 0 0
row 2:    0 0 1 0 0
row 3:    0 0 0 1 1
```

Outer scan, row by row:

| cell | value | already visited? | action | islands |
|------|-------|------------------|--------|---------|
| (0,0) | `1` | no | **start DFS** → floods (0,0), (0,1), (1,0), (1,1) | **1** |
| (0,1) | `1` | yes (flooded) | skip | 1 |
| (1,0), (1,1) | `1` | yes | skip | 1 |
| (2,2) | `1` | no | **start DFS** → floods (2,2) alone | **2** |
| (3,3) | `1` | no | **start DFS** → floods (3,3), (3,4) | **3** |
| all others | `0` | — | skip | 3 |

Output: **3** ✓

The first DFS is worth tracing: from (0,0) it reaches (0,1) and (1,0); from (1,0) it reaches (1,1); from (1,1) it tries (0,1), which is already marked, and stops. Without the visited guard that last step would bounce between (0,1) and (1,1) forever.

### Visualization

```text
    1 1 0 0 0        ┌───┐
    1 1 0 0 0        │ A │ A            island A: 4 cells
    0 0 1 0 0        └───┘   B          island B: 1 cell
    0 0 0 1 1                  C C      island C: 2 cells

3 fresh DFS starts  →  3 islands
```

### Code

```go
func numIslands(grid [][]byte) int {
    if len(grid) == 0 || len(grid[0]) == 0 {
        return 0
    }

    rows, cols := len(grid), len(grid[0])
    visited := make([][]bool, rows)
    for i := range visited {
        visited[i] = make([]bool, cols)
    }

    var flood func(row, col int)
    flood = func(row, col int) {
        // Bounds check lives here, so callers never need to pre-test.
        if row < 0 || row >= rows || col < 0 || col >= cols {
            return
        }
        if visited[row][col] || grid[row][col] != '1' {
            return
        }

        visited[row][col] = true // mark ON ENTRY, before recursing

        flood(row-1, col)
        flood(row+1, col)
        flood(row, col-1)
        flood(row, col+1)
    }

    islands := 0
    for row := 0; row < rows; row++ {
        for col := 0; col < cols; col++ {
            if grid[row][col] == '1' && !visited[row][col] {
                islands++ // each fresh start is one island
                flood(row, col)
            }
        }
    }
    return islands
}
```

```python
def numIslands(grid):
    if not grid or not grid[0]:
        return 0

    rows, cols = len(grid), len(grid[0])
    visited = [[False] * cols for _ in range(rows)]

    def flood(row, col):
        if not (0 <= row < rows and 0 <= col < cols):
            return
        if visited[row][col] or grid[row][col] != "1":
            return

        visited[row][col] = True        # mark ON ENTRY
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            flood(row + dr, col + dc)

    islands = 0
    for row in range(rows):
        for col in range(cols):
            if grid[row][col] == "1" and not visited[row][col]:
                islands += 1            # each fresh start is one island
                flood(row, col)
    return islands
```

### Complexity
Time **O(rows × cols)** — every cell is examined a constant number of times. Space **O(rows × cols)** for the visited grid, plus the recursion stack, which is O(rows × cols) in the worst case of a grid that is entirely land.

> Overwriting `grid[row][col] = '0'` instead of keeping a `visited` grid saves that space, at the cost of destroying the caller's input. Worth offering as a trade-off, not as a default.

---

## 10. Solved Example 2

### Problem — Clone Graph (LeetCode 133)
Given a reference to a node in a connected undirected graph, return a **deep copy** of the whole graph.

### Thought Process
1. Two things must happen at once: traverse the graph, and build a copy as we go.
2. Cycles make this delicate. Copying a neighbour may lead back to a node we are still in the middle of copying.
3. The insight: make the visited structure a **map from original node → its copy**. It then does two jobs at once — it is the cycle guard *and* the lookup that lets us wire up neighbours.
4. Create the copy and put it in the map **before** recursing into neighbours. If we recursed first, a cycle would find nothing in the map and create a second copy of the same node.
5. Each node is copied once, and each edge is wired once from each side.

### Dry Run

Input: `adjList = [[2,4], [1,3], [2,4], [1,3]]` — a 4-cycle:

```text
    1 —— 2
    |    |
    4 —— 3
```

| step | node | in map? | action | map (original → copy) |
|------|------|---------|--------|------------------------|
| 1 | `1` | no | create copy `1'`, store, then recurse | `{1: 1'}` |
| 2 | `2` | no | create `2'`, store, recurse | `{1:1', 2:2'}` |
| 3 | `1` (from 2) | **yes** | return `1'` — no new copy, no infinite loop | unchanged |
| 4 | `3` | no | create `3'`, store, recurse | `{1:1', 2:2', 3:3'}` |
| 5 | `2` (from 3) | yes | return `2'` | unchanged |
| 6 | `4` | no | create `4'`, store, recurse | `{1:1', 2:2', 3:3', 4:4'}` |
| 7 | `1` (from 4) | yes | return `1'` | unchanged |
| 8 | `3` (from 4) | yes | return `3'` | unchanged |
| 9 | `4` (from 1) | yes | return `4'` | unchanged |

Output: a copy where `1'—2'—3'—4'—1'` mirrors the original exactly. ✓

Step 3 is the crux. We reached node `1` again while still inside its own recursive call. Because `1'` was placed in the map **before** recursing, the lookup succeeds and we return the existing copy instead of spiralling.

### Visualization

```text
original            copy

  1 —— 2            1' —— 2'
  |    |     ──▶    |     |
  4 —— 3            4' —— 3'

map: {1→1', 2→2', 3→3', 4→4'}

the map is BOTH the visited set AND the original→copy lookup;
the copy is registered BEFORE recursing, so cycles resolve
```

### Code

```go
// GraphNode is an undirected graph node with an adjacency list.
type GraphNode struct {
    Val       int
    Neighbors []*GraphNode
}

func cloneGraph(node *GraphNode) *GraphNode {
    if node == nil {
        return nil
    }

    // One map, two jobs: cycle guard AND original → copy lookup.
    copies := make(map[*GraphNode]*GraphNode)

    var clone func(*GraphNode) *GraphNode
    clone = func(original *GraphNode) *GraphNode {
        if existing, ok := copies[original]; ok {
            return existing // already copied: this is the cycle guard
        }

        // Register the copy BEFORE recursing, so a cycle coming back
        // here finds it instead of creating a duplicate.
        duplicate := &GraphNode{Val: original.Val}
        copies[original] = duplicate

        for _, neighbor := range original.Neighbors {
            duplicate.Neighbors = append(duplicate.Neighbors, clone(neighbor))
        }
        return duplicate
    }

    return clone(node)
}
```

```python
def cloneGraph(node):
    if node is None:
        return None

    copies = {}                         # original → copy; also the cycle guard

    def clone(original):
        if original in copies:
            return copies[original]     # already copied

        # Register BEFORE recursing so cycles find it.
        duplicate = Node(original.val)
        copies[original] = duplicate

        for neighbor in original.neighbors:
            duplicate.neighbors.append(clone(neighbor))
        return duplicate

    return clone(node)
```

### Complexity
Time **O(V + E)** — each node is copied once and each edge traversed once from each endpoint. Space **O(V)** for the map plus O(V) recursion depth.

---

## 11. Solved Example 3

### Problem — Number of Provinces (LeetCode 547)
`isConnected[i][j] == 1` means cities `i` and `j` are directly connected. A province is a group of directly or indirectly connected cities. Count the provinces.

### Thought Process
1. Same connected-components count as Example 1, but the graph arrives as an **adjacency matrix** instead of a grid.
2. So the neighbour lookup changes and nothing else: city `i`'s neighbours are all `j` with `isConnected[i][j] == 1`.
3. Scan every city; if unvisited, start a DFS and increment the count.
4. The DFS marks every city in that province, so the outer loop never restarts inside one.
5. The matrix is symmetric (`isConnected[i][j] == isConnected[j][i]`), which is what makes this an undirected graph.

### Dry Run

Input:

```text
isConnected = [[1, 1, 0],
               [1, 1, 0],
               [0, 0, 1]]
```

Reading it: city 0 ↔ city 1 are connected; city 2 is isolated. (The diagonal is always 1 — a city is connected to itself.)

| city | visited? | action | visits made | provinces |
|------|----------|--------|-------------|-----------|
| 0 | no | **start DFS**: mark 0, neighbour 1 is connected → mark 1; from 1, neighbour 0 already marked → stop | `{0, 1}` | **1** |
| 1 | yes | skip | — | 1 |
| 2 | no | **start DFS**: mark 2; no connections to 0 or 1 | `{0, 1, 2}` | **2** |

Output: **2** ✓

Note the self-connection on the diagonal is harmless: when DFS at city 0 considers neighbour `0`, the visited check rejects it immediately.

### Visualization

```text
      0 —— 1        2

  isConnected:
        0  1  2
     0 [1  1  0]
     1 [1  1  0]
     2 [0  0  1]
         ↑
    diagonal is self-connection, ignored by the visited guard

2 fresh DFS starts  →  2 provinces
```

### Code

```go
func findCircleNum(isConnected [][]int) int {
    n := len(isConnected)
    visited := make([]bool, n)

    var explore func(city int)
    explore = func(city int) {
        if visited[city] {
            return
        }
        visited[city] = true // mark on entry

        // Neighbours come from the matrix row rather than a grid or list.
        for other := 0; other < n; other++ {
            if isConnected[city][other] == 1 && !visited[other] {
                explore(other)
            }
        }
    }

    provinces := 0
    for city := 0; city < n; city++ {
        if !visited[city] {
            provinces++ // each fresh start is one province
            explore(city)
        }
    }
    return provinces
}
```

```python
def findCircleNum(isConnected):
    n = len(isConnected)
    visited = [False] * n

    def explore(city):
        if visited[city]:
            return
        visited[city] = True            # mark on entry
        # Neighbours come from the matrix row.
        for other in range(n):
            if isConnected[city][other] == 1 and not visited[other]:
                explore(other)

    provinces = 0
    for city in range(n):
        if not visited[city]:
            provinces += 1              # each fresh start is one province
            explore(city)
    return provinces
```

### Complexity
Time **O(n²)** — the adjacency matrix forces scanning every row fully. Space O(n) for `visited` plus recursion depth.

> With an adjacency **list** the same algorithm is O(V + E). The matrix representation is what costs the extra factor here, not the algorithm — a useful thing to point out, since it shows you can separate the two.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 200 | Num Islands | Easy | Core graphs application |
| 133 | Clone Graph | Easy | Core graphs application |
| 547 | Provinces | Medium | Core graphs application |
| 417 | Pacific Atlantic | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Graph DFS logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Graph DFS (Graphs).
- **Signal:** graph dfs, connected components, recursion, visited, islands.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Graph DFS invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Graph DFS
FAMILY : Graphs (Intermediate)
WHEN   : graph dfs, connected components, recursion, visited, islands
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 200, 133, 547, 417
```

---

*Part of the DSA Patterns Handbook — pattern 62 of 100.*
