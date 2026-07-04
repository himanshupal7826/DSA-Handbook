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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Bellman Ford pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Bellman Ford invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Bellman Ford      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Bellman Ford problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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
A representative **Bellman Ford** problem. The signal: relax all edges v-1 times; handles negative weights & detects cycles.

### Thought Process
1. Confirm the pattern via its recognition signals (bellman ford, negative edges, shortest path, relax, negative cycle).
2. Reach for the Bellman Ford template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Bellman Ford step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(V + E), Space O(V). Each vertex and edge processed once for BFS/DFS.

## 10. Solved Example 2

### Problem — Network Delay (LeetCode 743)
A representative **Bellman Ford** problem. The signal: relax all edges v-1 times; handles negative weights & detects cycles.

### Thought Process
1. Confirm the pattern via its recognition signals (bellman ford, negative edges, shortest path, relax, negative cycle).
2. Reach for the Bellman Ford template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Bellman Ford step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(V + E), Space O(V). Each vertex and edge processed once for BFS/DFS.

## 11. Solved Example 3

### Problem — City Threshold (LeetCode 1334)
A representative **Bellman Ford** problem. The signal: relax all edges v-1 times; handles negative weights & detects cycles.

### Thought Process
1. Confirm the pattern via its recognition signals (bellman ford, negative edges, shortest path, relax, negative cycle).
2. Reach for the Bellman Ford template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Bellman Ford step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(V + E), Space O(V). Each vertex and edge processed once for BFS/DFS.


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
