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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Graph DFS pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Graph DFS invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Graph DFS         : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Graph DFS problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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

### Problem — Num Islands (LeetCode 200)
A representative **Graph DFS** problem. The signal: recursive/stack exploration for connectivity, components, and cycles.

### Thought Process
1. Scan the grid; each unvisited `'1'` cell is the start of a new island, so increment the count and launch a DFS from it.
2. The DFS floods the whole connected land mass, sinking every reachable `'1'` to `'0'` so it is never counted again — this marks the component visited in place.
3. When the scan finishes, the number of DFS launches equals the number of islands.

### Dry Run
grid `[[1,1,0],[0,1,0],[0,0,1]]`.
- (0,0)=='1' → count=1, DFS sinks (0,0),(0,1),(1,1) → those become '0'.
- continue scan: (2,2)=='1' → count=2, DFS sinks (2,2).
- no more '1' cells → answer **2**.

### Visualization
```
input  ──▶ [ apply Graph DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def numIslands(grid):
    rows, cols = len(grid), len(grid[0])

    def dfs(r, c):
        if r < 0 or r >= rows or c < 0 or c >= cols or grid[r][c] != '1':
            return
        grid[r][c] = '0'               # sink visited land
        dfs(r + 1, c)
        dfs(r - 1, c)
        dfs(r, c + 1)
        dfs(r, c - 1)

    count = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == '1':
                count += 1
                dfs(r, c)
    return count
```

### Complexity
Time O(R·C), Space O(R·C) worst-case recursion depth on a full-land grid.

## 10. Solved Example 2

### Problem — Clone Graph (LeetCode 133)
A representative **Graph DFS** problem. The signal: recursive/stack exploration for connectivity, components, and cycles.

### Thought Process
1. Keep a hash map from each original node to its freshly-made copy; this map doubles as the visited set that breaks cycles.
2. DFS from the entry node: if a node is already in the map, return its clone immediately; otherwise create the clone, record it, then recurse into every neighbour and attach the returned clones.
3. Returning the entry node's clone yields a deep copy with identical structure.

### Dry Run
Graph: 1—2, 1—3, 2—3 (undirected), start at node 1.
- dfs(1): create 1'; recurse neighbour 2.
- dfs(2): create 2'; neighbour 1 already mapped → attach 1'; neighbour 3 → dfs(3).
- dfs(3): create 3'; neighbours 1',2' attached. Unwind → 1'.neighbors=[2',3'].
- return **1'** (full clone).

### Visualization
```
input  ──▶ [ apply Graph DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
# class Node: def __init__(self, val=0, neighbors=None): ...

def cloneGraph(node):
    clones = {}

    def dfs(cur):
        if cur in clones:
            return clones[cur]
        copy = Node(cur.val)
        clones[cur] = copy             # record before recursing (breaks cycles)
        for nei in cur.neighbors:
            copy.neighbors.append(dfs(nei))
        return copy

    return dfs(node) if node else None
```

### Complexity
Time O(V + E), Space O(V) for the map plus recursion stack.

## 11. Solved Example 3

### Problem — Provinces (LeetCode 547)
A representative **Graph DFS** problem. The signal: recursive/stack exploration for connectivity, components, and cycles.

### Thought Process
1. The `isConnected` matrix is an adjacency matrix over n cities; a province is one connected component, so the answer is the number of components.
2. Loop over cities; each unvisited city starts a new province — increment the counter and DFS to every city reachable through direct/indirect connections, marking them visited.
3. The count of DFS launches is the number of provinces.

### Dry Run
`isConnected = [[1,1,0],[1,1,0],[0,0,1]]`, n=3.
- city 0 unvisited → provinces=1; DFS visits 0, then 1 (edge 0-1). visited={0,1}.
- city 1 already visited → skip.
- city 2 unvisited → provinces=2; DFS visits 2. → answer **2**.

### Visualization
```
input  ──▶ [ apply Graph DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def findCircleNum(isConnected):
    n = len(isConnected)
    visited = [False] * n

    def dfs(i):
        for j in range(n):
            if isConnected[i][j] == 1 and not visited[j]:
                visited[j] = True
                dfs(j)

    provinces = 0
    for i in range(n):
        if not visited[i]:
            provinces += 1
            visited[i] = True
            dfs(i)
    return provinces
```

### Complexity
Time O(N²) to scan the matrix, Space O(N) for the visited array and stack.


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
