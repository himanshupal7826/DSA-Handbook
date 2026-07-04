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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Floyd Warshall pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Floyd Warshall invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Floyd Warshall    : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Floyd Warshall problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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
Given `n` cities and weighted bidirectional `edges`, find the city that can reach the fewest other cities within `distanceThreshold`. On a tie, return the city with the greatest index.

### Thought Process
1. Build an `n × n` distance matrix seeded with `0` on the diagonal, each edge weight, and `INF` elsewhere.
2. Run Floyd-Warshall: for every intermediate `k`, relax `dist[i][j]` with `dist[i][k] + dist[k][j]`.
3. For each city count reachable neighbors with `dist[i][j] <= threshold`; iterate ascending with `<=` so the largest index wins ties.

### Dry Run
Input `n=4`, edges `[[0,1,3],[1,2,1],[1,3,4],[2,3,1]]`, threshold `4`.
- After FW: `dist[0]=[0,3,4,5]`, `dist[3]=[5,4,1,0]`.
- City 0 reaches {1,2} within 4 → count 2; city 1 → count 3; city 2 → count 2; city 3 → count 2.
- Min count 2 shared by 0,2,3 → largest index 3 wins. Answer `3`.

### Visualization
```
input  ──▶ [ apply Floyd Warshall step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def findTheCity(n, edges, distanceThreshold):
    INF = float('inf')
    dist = [[INF] * n for _ in range(n)]
    for i in range(n):
        dist[i][i] = 0
    for u, v, w in edges:
        dist[u][v] = dist[v][u] = w
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if dist[i][k] + dist[k][j] < dist[i][j]:
                    dist[i][j] = dist[i][k] + dist[k][j]
    best_city, best_count = 0, n + 1
    for i in range(n):
        reach = sum(1 for j in range(n) if i != j and dist[i][j] <= distanceThreshold)
        if reach <= best_count:          # <= so larger index wins ties
            best_count, best_city = reach, i
    return best_city
```

### Complexity
Time O(V³) for Floyd-Warshall plus O(V²) counting, Space O(V²).

## 10. Solved Example 2

### Problem — Network Delay (LeetCode 743)
Given directed weighted `times` over `n` nodes (labelled `1..n`), a signal starts at node `k`. Return the time for all nodes to receive it, or `-1` if some node is unreachable.

### Thought Process
1. Build an `(n+1) × (n+1)` matrix with `0` on the diagonal, directed edge weights, `INF` otherwise.
2. Run Floyd-Warshall to get all-pairs shortest times.
3. The answer is the maximum of `dist[k][j]` over all nodes `j`; if any is still `INF`, return `-1`.

### Dry Run
Input `times=[[2,1,1],[2,3,1],[3,4,1]]`, `n=4`, `k=2`.
- After FW: `dist[2] = [_, 1, 0, 1, 2]` (index 0 unused).
- Times from k=2: node1=1, node2=0, node3=1, node4=2 — all finite.
- Answer = max(1,0,1,2) = `2`.

### Visualization
```
input  ──▶ [ apply Floyd Warshall step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def networkDelayTime(times, n, k):
    INF = float('inf')
    dist = [[INF] * (n + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dist[i][i] = 0
    for u, v, w in times:
        dist[u][v] = min(dist[u][v], w)
    for m in range(1, n + 1):
        for i in range(1, n + 1):
            for j in range(1, n + 1):
                if dist[i][m] + dist[m][j] < dist[i][j]:
                    dist[i][j] = dist[i][m] + dist[m][j]
    ans = max(dist[k][j] for j in range(1, n + 1))
    return ans if ans < INF else -1
```

### Complexity
Time O(V³), Space O(V²).

## 11. Solved Example 3

### Problem — Evaluate Division (LeetCode 399)
Given `equations` like `a/b = value`, answer division `queries`. Return the ratio if derivable from the graph, else `-1.0`.

### Thought Process
1. Treat each variable as a node and each `a/b = v` as edges `ratio[a][b] = v`, `ratio[b][a] = 1/v`, `ratio[x][x] = 1`.
2. Run Floyd-Warshall multiplicatively: if `k` links `i` and `j`, set `ratio[i][j] = ratio[i][k] * ratio[k][j]`.
3. For each query `c/d`, return `ratio[c][d]` when both are known and connected, else `-1.0`.

### Dry Run
Equations `a/b=2`, `b/c=3`; query `a/c`.
- Seed: `ratio[a][b]=2, ratio[b][c]=3`, reciprocals and self-ratios set.
- FW via `k=b`: `ratio[a][c] = ratio[a][b] * ratio[b][c] = 2*3 = 6`.
- Query `a/c` → `6.0`.

### Visualization
```
input  ──▶ [ apply Floyd Warshall step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def calcEquation(equations, values, queries):
    ratio = {}
    for (a, b), v in zip(equations, values):
        ratio.setdefault(a, {})[a] = 1.0
        ratio.setdefault(b, {})[b] = 1.0
        ratio[a][b] = v
        ratio[b][a] = 1.0 / v
    nodes = list(ratio)
    for k in nodes:
        for i in nodes:
            if k in ratio[i]:
                for j in nodes:
                    if j in ratio[k]:
                        ratio[i][j] = ratio[i][k] * ratio[k][j]
    res = []
    for c, d in queries:
        if c in ratio and d in ratio[c]:
            res.append(ratio[c][d])
        else:
            res.append(-1.0)
    return res
```

### Complexity
Time O(V³) over the V distinct variables, Space O(V²).


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
