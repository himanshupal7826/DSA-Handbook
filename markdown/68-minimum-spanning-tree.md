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

### Intuition
Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Minimum Spanning Tree pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Minimum Spanning Tree invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Minimum Spanning T: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Minimum Spanning Tree problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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
A representative **Minimum Spanning Tree** problem. The signal: kruskal/prim connect all nodes at minimum total edge weight.

### Thought Process
1. Confirm the pattern via its recognition signals (mst, kruskal, prim, spanning tree, minimum cost, union find).
2. Reach for the Minimum Spanning Tree template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Minimum Spanning Tree step-by-step ]
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

### Problem — Connect Cities (LeetCode 1135)
A representative **Minimum Spanning Tree** problem. The signal: kruskal/prim connect all nodes at minimum total edge weight.

### Thought Process
1. Confirm the pattern via its recognition signals (mst, kruskal, prim, spanning tree, minimum cost, union find).
2. Reach for the Minimum Spanning Tree template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Minimum Spanning Tree step-by-step ]
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

### Problem — Critical Edges (LeetCode 1489)
A representative **Minimum Spanning Tree** problem. The signal: kruskal/prim connect all nodes at minimum total edge weight.

### Thought Process
1. Confirm the pattern via its recognition signals (mst, kruskal, prim, spanning tree, minimum cost, union find).
2. Reach for the Minimum Spanning Tree template below and map the problem's entities onto it.
3. Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Minimum Spanning Tree step-by-step ]
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
