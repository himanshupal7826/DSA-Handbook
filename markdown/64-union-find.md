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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Union Find pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Union Find invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Union Find        : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Union Find problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Graphs** family template. Adapt the comparison/condition to the specific problem.

```go
// BFS shortest distance from src in an unweighted adjacency list.
func bfs(adj map[int][]int, src, n int) []int {
    dist := make([]int, n)
    for i := range dist { dist[i] = -1 }
    dist[src] = 0
    queue := []int{src}
    for len(queue) > 0 {
        u := queue[0]; queue = queue[1:]
        for _, v := range adj[u] {
            if dist[v] == -1 {           // first visit = shortest in BFS
                dist[v] = dist[u] + 1
                queue = append(queue, v)
            }
        }
    }
    return dist
}
```

```python
from collections import deque
def bfs(adj, src, n):
    dist = [-1] * n
    dist[src] = 0
    q = deque([src])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if dist[v] == -1:           # unvisited
                dist[v] = dist[u] + 1
                q.append(v)
    return dist
```

```java
int[] bfs(List<List<Integer>> adj, int src, int n) {
    int[] dist = new int[n];
    Arrays.fill(dist, -1);
    dist[src] = 0;
    Queue<Integer> q = new ArrayDeque<>();
    q.add(src);
    while (!q.isEmpty()) {
        int u = q.poll();
        for (int v : adj.get(u)) if (dist[v] == -1) {
            dist[v] = dist[u] + 1; q.add(v);
        }
    }
    return dist;
}
```

```cpp
vector<int> bfs(vector<vector<int>>& adj, int src, int n) {
    vector<int> dist(n, -1);
    dist[src] = 0;
    queue<int> q; q.push(src);
    while (!q.empty()) {
        int u = q.front(); q.pop();
        for (int v : adj[u]) if (dist[v] == -1) {
            dist[v] = dist[u] + 1; q.push(v);
        }
    }
    return dist;
}
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
Given an `n x n` adjacency matrix `isConnected` where `isConnected[i][j] = 1` means cities i and j are directly connected, return the number of provinces (connected components).

### Thought Process
1. Each city is its own set initially, so there are `n` provinces to start.
2. Scan the upper triangle of the matrix; whenever `isConnected[i][j] == 1`, union i and j.
3. Every successful union (two different roots merged) reduces the province count by one.
4. Return the remaining count.

### Dry Run
Input: `isConnected=[[1,1,0],[1,1,0],[0,0,1]]`, count=3.
- i=0,j=1 → 1: union(0,1), roots differ → count=2.
- i=0,j=2 → 0: skip. i=1,j=2 → 0: skip.
- No more edges → return 2.

### Visualization
```
input  ──▶ [ apply Union Find step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def findCircleNum(isConnected):
    n = len(isConnected)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]   # path compression
            x = parent[x]
        return x

    count = n
    for i in range(n):
        for j in range(i + 1, n):
            if isConnected[i][j]:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[ri] = rj
                    count -= 1
    return count
```

### Complexity
Time O(n^2 · α(n)) to scan the matrix; Space O(n) for the parent array.

## 10. Solved Example 2

### Problem — Redundant Connection (LeetCode 684)
A tree of `n` nodes had one extra edge added, making exactly one cycle. Given the `edges` in order, return the edge that can be removed — the last one that closes a cycle.

### Thought Process
1. Start with every node in its own set (nodes are 1-indexed).
2. Process edges in input order; for `[u, v]` find the roots of u and v.
3. If the roots already match, u and v are connected, so this edge closes the cycle → it is the answer.
4. Otherwise union them and continue.

### Dry Run
Input: `edges=[[1,2],[1,3],[2,3]]`.
- [1,2]: roots 1,2 differ → union → {1,2}.
- [1,3]: roots 1,3 differ → union → {1,2,3}.
- [2,3]: find(2)=find(3)=same root → cycle → return `[2,3]`.

### Visualization
```
input  ──▶ [ apply Union Find step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def findRedundantConnection(edges):
    parent = list(range(len(edges) + 1))   # nodes are 1..n

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]   # path compression
            x = parent[x]
        return x

    for u, v in edges:
        ru, rv = find(u), find(v)
        if ru == rv:
            return [u, v]                    # this edge closes a cycle
        parent[ru] = rv
    return []
```

### Complexity
Time O(n · α(n)) over the edges; Space O(n) for the parent array.

## 11. Solved Example 3

### Problem — Number of Islands (LeetCode 200)
Given a grid of `'1'` (land) and `'0'` (water), count the islands (groups of land connected horizontally/vertically). Solve it with union-find here.

### Thought Process
1. Give each land cell a linear id `r * cols + c`; count starts as the number of land cells.
2. Scan the grid; for each land cell, union it with its right and down land neighbors (covers all adjacencies without double counting).
3. Each successful union of two distinct components decrements the island count.
4. Return the remaining count.

### Dry Run
Grid `[["1","1","0"],["0","1","0"],["0","0","1"]]`, land cells = 4 → count=4.
- (0,0)-(0,1): union → count=3. (0,1)-(1,1): union → count=2.
- (1,1) down is (2,1)="0": skip. (2,2) has no land right/down neighbor.
- Remaining components: {(0,0),(0,1),(1,1)} and {(2,2)} → return 2.

### Visualization
```
input  ──▶ [ apply Union Find step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def numIslands(grid):
    if not grid or not grid[0]:
        return 0
    rows, cols = len(grid), len(grid[0])
    parent = list(range(rows * cols))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]   # path compression
            x = parent[x]
        return x

    count = sum(grid[r][c] == '1' for r in range(rows) for c in range(cols))

    def union(a, b):
        nonlocal count
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
            count -= 1

    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == '1':
                if r + 1 < rows and grid[r + 1][c] == '1':
                    union(r * cols + c, (r + 1) * cols + c)
                if c + 1 < cols and grid[r][c + 1] == '1':
                    union(r * cols + c, r * cols + c + 1)
    return count
```

### Complexity
Time O(rows · cols · α) for the grid scan and unions; Space O(rows · cols) for the parent array.


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
