# 61 · Graph BFS

> **One-liner:** Layered queue expansion for shortest paths in unweighted graphs.

---

## 1. Overview

### Definition
The **Graph BFS** pattern belongs to the *Graphs* family. Layered queue expansion for shortest paths in unweighted graphs.

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
graph bfs, shortest path, unweighted, queue, levels.

### Constraints
- Input size where the brute-force complexity would time out — the Graph BFS optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Graph BFS invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Graph BFS is the upgrade.
- The wording maps onto: graph bfs, shortest path, unweighted, queue, levels.

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
Redundant recomputation; does not exploit the structure the Graph BFS pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Graph BFS invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-61" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">BFS from source A: distance = layer number</text>
  <!-- layer guides -->
  <text x="80"  y="200" text-anchor="middle" fill="#64748b">layer 0</text>
  <text x="250" y="200" text-anchor="middle" fill="#64748b">layer 1</text>
  <text x="430" y="200" text-anchor="middle" fill="#64748b">layer 2</text>
  <text x="580" y="200" text-anchor="middle" fill="#64748b">layer 3</text>
  <!-- edges -->
  <line x1="102" y1="105" x2="228" y2="70"  stroke="#475569" marker-end="url(#arw-61)"/>
  <line x1="102" y1="115" x2="228" y2="150" stroke="#475569" marker-end="url(#arw-61)"/>
  <line x1="272" y1="65"  x2="408" y2="65"  stroke="#475569" marker-end="url(#arw-61)"/>
  <line x1="272" y1="155" x2="408" y2="155" stroke="#475569" marker-end="url(#arw-61)"/>
  <line x1="452" y1="72"  x2="558" y2="105" stroke="#475569" marker-end="url(#arw-61)"/>
  <line x1="452" y1="148" x2="558" y2="115" stroke="#475569" marker-end="url(#arw-61)"/>
  <!-- nodes -->
  <circle cx="80"  cy="110" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="80"  y="115" text-anchor="middle" font-weight="700" fill="#1e293b">A</text><text x="80"  y="160" text-anchor="middle" fill="#059669">d=0</text>
  <circle cx="250" cy="65"  r="22" fill="#eff6ff" stroke="#2563eb"/><text x="250" y="70"  text-anchor="middle" font-weight="700" fill="#1e293b">B</text><text x="250" y="40" text-anchor="middle" fill="#64748b">d=1</text>
  <circle cx="250" cy="155" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="250" y="160" text-anchor="middle" font-weight="700" fill="#1e293b">C</text><text x="250" y="130" text-anchor="middle" fill="#64748b">d=1</text>
  <circle cx="430" cy="65"  r="22" fill="#eff6ff" stroke="#2563eb"/><text x="430" y="70"  text-anchor="middle" font-weight="700" fill="#1e293b">D</text><text x="430" y="40" text-anchor="middle" fill="#64748b">d=2</text>
  <circle cx="430" cy="155" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="430" y="160" text-anchor="middle" font-weight="700" fill="#1e293b">E</text><text x="430" y="130" text-anchor="middle" fill="#64748b">d=2</text>
  <circle cx="580" cy="110" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="580" y="115" text-anchor="middle" font-weight="700" fill="#1e293b">F</text><text x="580" y="160" text-anchor="middle" fill="#64748b">d=3</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Graph BFS         : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Graph BFS problem. I'll pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity. That brings the complexity down to O(V + E) time and O(V) space — here's the template."

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

| Metric | Brute Force | Graph BFS (Optimal) |
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

### Problem — Rotting Oranges (LeetCode 994)
A representative **Graph BFS** problem. The signal: layered queue expansion for shortest paths in unweighted graphs.

### Thought Process
1. Seed a queue with **all** rotten oranges (value 2) at once — this is multi-source BFS, so every rotten cell starts at time 0. Count the fresh oranges (value 1) as we go.
2. Process the queue one layer (minute) at a time; each rotten orange rots its 4-neighbour fresh cells, which join the next layer and decrement the fresh count.
3. The answer is the number of layers processed. If any fresh orange remains after the queue drains, it is unreachable — return -1.

### Dry Run
grid `[[2,1,1],[1,1,0],[0,1,1]]`, fresh=6, queue=[(0,0)].
- min 1: (0,0) rots (0,1) and (1,0) → fresh=4.
- min 2: rots (0,2) and (1,1) → fresh=2.
- min 3: rots (2,1) → fresh=1.
- min 4: rots (2,2) → fresh=0. Queue empties → answer **4**.

### Visualization
```
input  ──▶ [ apply Graph BFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def orangesRotting(grid):
    rows, cols = len(grid), len(grid[0])
    q = deque()
    fresh = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == 2:
                q.append((r, c))
            elif grid[r][c] == 1:
                fresh += 1
    minutes = 0
    while q and fresh:
        for _ in range(len(q)):        # process one minute's layer
            r, c = q.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 1:
                    grid[nr][nc] = 2
                    fresh -= 1
                    q.append((nr, nc))
        minutes += 1
    return -1 if fresh else minutes
```

### Complexity
Time O(R·C), Space O(R·C) — every cell is enqueued at most once.

## 10. Solved Example 2

### Problem — Word Ladder (LeetCode 127)
A representative **Graph BFS** problem. The signal: layered queue expansion for shortest paths in unweighted graphs.

### Thought Process
1. Model each word as a node; two words are adjacent if they differ by exactly one letter. The shortest transformation is the shortest path in this unweighted graph, so BFS is exact.
2. From each dequeued word, generate every one-letter mutation; keep only mutations present in the word set and not yet seen, tagging each with `steps + 1`.
3. Return `steps` when `endWord` is dequeued; if the queue empties first, no ladder exists → 0.

### Dry Run
begin `hit`, end `cog`, list `[hot,dot,dog,cog]`.
- q=[(hit,1)] → mutate hit → `hot` in set → q=[(hot,2)].
- (hot,2) → `dot`, `lot`(not in set) → q=[(dot,3)].
- (dot,3) → `dog` → q=[(dog,4)]; (dog,4) → `cog` → q=[(cog,5)].
- (cog,5) == endWord → answer **5**.

### Visualization
```
input  ──▶ [ apply Graph BFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def ladderLength(beginWord, endWord, wordList):
    words = set(wordList)
    if endWord not in words:
        return 0
    q = deque([(beginWord, 1)])
    seen = {beginWord}
    while q:
        word, steps = q.popleft()
        if word == endWord:
            return steps
        for i in range(len(word)):
            for ch in "abcdefghijklmnopqrstuvwxyz":
                nxt = word[:i] + ch + word[i + 1:]
                if nxt in words and nxt not in seen:
                    seen.add(nxt)
                    q.append((nxt, steps + 1))
    return 0
```

### Complexity
Time O(N·L·26) where N = word count, L = word length; Space O(N·L).

## 11. Solved Example 3

### Problem — Shortest Path Binary (LeetCode 1091)
A representative **Graph BFS** problem. The signal: layered queue expansion for shortest paths in unweighted graphs.

### Thought Process
1. Treat each 0-cell as a node with up to 8 neighbours (all directions). The shortest clear path length equals the BFS distance in this unweighted grid, so BFS gives the exact minimum.
2. Start BFS at the top-left carrying the path length (1). Mark cells visited by writing 1 into the grid so they are never re-enqueued.
3. Return the length when the bottom-right cell is dequeued. If either corner is blocked, or the queue drains first, return -1.

### Dry Run
grid `[[0,0,0],[1,1,0],[1,1,0]]`, n=3.
- q=[(0,0,1)]; expand → (0,1,2),(1,2 blocked)… enqueue (0,1,2),(0,2 via diag? later).
- (0,1,2) → (0,2,3),(1,2,3).
- (0,2,3) → (1,2 already) ; (1,2,3) → (2,2,4).
- (2,2,4) is bottom-right → answer **4**.

### Visualization
```
input  ──▶ [ apply Graph BFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def shortestPathBinaryMatrix(grid):
    n = len(grid)
    if grid[0][0] == 1 or grid[n - 1][n - 1] == 1:
        return -1
    q = deque([(0, 0, 1)])
    grid[0][0] = 1                     # mark visited
    dirs = [(-1, -1), (-1, 0), (-1, 1), (0, -1),
            (0, 1), (1, -1), (1, 0), (1, 1)]
    while q:
        r, c, dist = q.popleft()
        if r == n - 1 and c == n - 1:
            return dist
        for dr, dc in dirs:
            nr, nc = r + dr, c + dc
            if 0 <= nr < n and 0 <= nc < n and grid[nr][nc] == 0:
                grid[nr][nc] = 1
                q.append((nr, nc, dist + 1))
    return -1
```

### Complexity
Time O(N²), Space O(N²) — each of the N² cells is visited at most once.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 994 | Rotting Oranges | Easy | Core graphs application |
| 127 | Word Ladder | Easy | Core graphs application |
| 1091 | Shortest Path Binary | Medium | Core graphs application |
| 542 | 01 Matrix | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Graph BFS logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Graph BFS (Graphs).
- **Signal:** graph bfs, shortest path, unweighted, queue, levels.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Graph BFS invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Graph BFS
FAMILY : Graphs (Intermediate)
WHEN   : graph bfs, shortest path, unweighted, queue, levels
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 994, 127, 1091, 542
```

---

*Part of the DSA Patterns Handbook — pattern 61 of 100.*
