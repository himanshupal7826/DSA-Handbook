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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Dijkstra pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Dijkstra invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Dijkstra          : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Dijkstra problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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

### Problem — Network Delay (LeetCode 743)
Given directed travel times `times[i] = (u, v, w)`, a node count `n`, and a source `k`, return the time for a signal from `k` to reach every node, or `-1` if some node is unreachable.

### Thought Process
1. Build a weighted adjacency list; the signal reaches a node at its shortest-path distance from `k`.
2. Run Dijkstra from `k`: pop the nearest unfinalized node from a min-heap and relax its outgoing edges.
3. The answer is the maximum finalized distance (the last node to be reached); if fewer than `n` nodes were finalized, return `-1`.

### Dry Run
`times=[(2,1,1),(2,3,1),(3,4,1)]`, `n=4`, `k=2`.
- Pop (0,2) → dist[2]=0, push (1,1),(1,3).
- Pop (1,1) → dist[1]=1; pop (1,3) → dist[3]=1, push (2,4).
- Pop (2,4) → dist[4]=2. All 4 reached → answer `max(0,1,1,2) = 2`.

### Visualization
```
heap pops nodes in nondecreasing distance ──▶ each finalized once
answer = max over all finalized dist[node]
```

### Code
```python
import heapq

def networkDelayTime(times, n, k):
    graph = {i: [] for i in range(1, n + 1)}
    for u, v, w in times:
        graph[u].append((v, w))
    dist = {}
    heap = [(0, k)]                       # (distance, node)
    while heap:
        d, node = heapq.heappop(heap)
        if node in dist:                  # already finalized
            continue
        dist[node] = d
        for nei, w in graph[node]:
            if nei not in dist:
                heapq.heappush(heap, (d + w, nei))
    return max(dist.values()) if len(dist) == n else -1
```

### Complexity
Time O(E log V), Space O(V + E).

## 10. Solved Example 2

### Problem — Min Effort (LeetCode 1631)
On a grid of `heights`, a path's effort is the maximum absolute height difference between consecutive cells. Return the minimum effort to walk from the top-left to the bottom-right cell.

### Thought Process
1. Treat each cell as a node; the "cost" of a path is the max edge weight (height jump) along it, not the sum.
2. Run Dijkstra where a node's key is the smallest possible max-jump to reach it; relax neighbor with `max(current_effort, |Δheight|)`.
3. Pop the bottom-right cell the moment it comes off the heap — that popped effort is the minimum.

### Dry Run
`heights=[[1,2,2],[3,8,2],[5,3,5]]`.
- Start (0,0) effort 0; push down |3-1|=2 and right |2-1|=1.
- Pop (0,1) e=1 → push (0,2) e=max(1,0)=1, (1,1) e=6.
- Follow low-effort rim 1→1→2→2→5 down the right/bottom; target (2,2) pops at e=2 → answer `2`.

### Visualization
```
effort[cell] = min over paths of ( max |Δheight| on path )
relax: ne = max(effort[cur], |h[nbr]-h[cur]|)
```

### Code
```python
import heapq

def minimumEffortPath(heights):
    rows, cols = len(heights), len(heights[0])
    effort = [[float('inf')] * cols for _ in range(rows)]
    effort[0][0] = 0
    heap = [(0, 0, 0)]                    # (effort_so_far, r, c)
    while heap:
        e, r, c = heapq.heappop(heap)
        if r == rows - 1 and c == cols - 1:
            return e
        if e > effort[r][c]:
            continue
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols:
                ne = max(e, abs(heights[nr][nc] - heights[r][c]))
                if ne < effort[nr][nc]:
                    effort[nr][nc] = ne
                    heapq.heappush(heap, (ne, nr, nc))
    return 0
```

### Complexity
Time O(R·C·log(R·C)), Space O(R·C).

## 11. Solved Example 3

### Problem — K Stops (LeetCode 787)
Given `flights[i] = (u, v, price)`, find the cheapest price from `src` to `dst` using at most `k` stops (so at most `k + 1` edges), or `-1` if none.

### Thought Process
1. Extend the Dijkstra state to `(cost, node, stops_remaining)` so the stop budget rides along in the heap.
2. Pop the cheapest state; if it is `dst`, return its cost — the heap guarantees it is the cheapest that respects the budget.
3. Only expand a neighbor when `stops_remaining > 0` and the new cost improves the best seen for `(neighbor, stops_remaining - 1)`.

### Dry Run
`n=3`, `flights=[(0,1,100),(1,2,100),(0,2,500)]`, `src=0`, `dst=2`, `k=1`.
- Start (0, 0, 2 edges). Push (100, 1, 1) and (500, 2, 1).
- Pop (100,1,1) → push (200, 2, 0).
- Pop (200,2,0) → node==dst → answer `200` (cheaper than the direct 500, within 1 stop).

### Visualization
```
state = (cost, node, edges_left); heap ordered by cost
first pop of dst within budget = cheapest valid price
```

### Code
```python
import heapq

def findCheapestPrice(n, flights, src, dst, k):
    graph = {i: [] for i in range(n)}
    for u, v, w in flights:
        graph[u].append((v, w))
    # (cost, node, edges_remaining); k stops == k+1 edges
    heap = [(0, src, k + 1)]
    best = {}                             # (node, edges_left) -> cheapest cost
    while heap:
        cost, node, edges = heapq.heappop(heap)
        if node == dst:
            return cost
        if edges == 0:
            continue
        if best.get((node, edges), float('inf')) < cost:
            continue
        for nei, w in graph[node]:
            nc = cost + w
            if nc < best.get((nei, edges - 1), float('inf')):
                best[(nei, edges - 1)] = nc
                heapq.heappush(heap, (nc, nei, edges - 1))
    return -1
```

### Complexity
Time O(E·K·log(E·K)), Space O(V·K).


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
