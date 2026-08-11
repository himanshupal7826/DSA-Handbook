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

**The question this pattern keeps answering:** *"How few moves does it take to get from here to there, when every move costs the same?"*

Running example — an unweighted directed graph, stored as an **adjacency list** (for each vertex, the list of vertices it points to):

```text
A: B, C          A ─▶ B ─▶ D ─┐
B: D                             ├─▶ F        shortest A→F = 3 edges
C: E             A ─▶ C ─▶ E ─┘
D: F
E: F
F: —
```

### Intuition
A path is just a sequence of edges. So walk out from the source with DFS, remember the current path, and every time you land on the target record how long the path was. The smallest recorded length is the answer.

### Algorithm
1. Start a DFS at the source with `pathLength = 0`.
2. If the current vertex is the target, update `best = min(best, pathLength)` and return.
3. Otherwise, for each neighbour not already on the current path, recurse with `pathLength + 1`.
4. Un-mark the vertex on the way out so other paths may use it.
5. Return `best` (or "unreachable" if it was never updated).

### Complexity
- Time: **O(number of simple paths)** — exponential in general, since a graph with `k` choices at each of `d` layers has `k^d` paths.
- Space: O(V) for the current path plus the recursion stack.

### Drawbacks
- The same vertex is fully re-explored once per path that reaches it. Take a three-wide graph:

  ```text
  S ─▶ a1 ─┐
  S ─▶ a2 ─┼─▶ T          DFS reaches T three times: via a1, via a2, via a3
  S ─▶ a3 ─┘              the 2nd and 3rd visits learn nothing new
  ```

  Stack two such layers and T's subtree is explored 9 times; three layers, 27.
- It ignores the one fact that makes unweighted shortest paths easy: **the first time you reach a vertex is already the best time.** DFS has no way to exploit that, because it dives deep before it goes wide.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Expand outward in rings — visit everything 1 step away, then everything 2 steps away — so the first time you touch a vertex, you have touched it by a shortest path.**

Think of dropping a stone in a pond. The ripple reaches every point at exactly the moment corresponding to its distance from the splash. It never arrives somewhere "early by a shortcut" and it never revisits a point it has already wetted. A queue is what turns the recursion into a ripple.

### The thought process

```text
We need    : the fewest edges from source to target (every edge costs 1).
Obvious way: enumerate every path with DFS and keep the shortest.
Too slow   : exponential — each vertex is re-explored once per path reaching it.
Notice     : if all edges cost the same, distance = number of rings crossed.
Notice too : process vertices in ring order and the FIRST arrival is optimal.
Therefore  : a FIFO queue — push the source, pop, push its unseen neighbours.
Now        : O(V + E) — every vertex is popped once, every edge scanned once.
```

### Why the queue gives shortest paths — and why you must mark on ENQUEUE

**Why FIFO order is correct.** A queue keeps the invariant *"the distances inside the queue are non-decreasing, and differ by at most 1"*. Popping a vertex at distance `d` can only push vertices at distance `d+1`, which go to the back — behind everything already at `d`. So the queue drains ring by ring, and the first time a vertex is reached its recorded distance is the smallest possible. **This is exactly what breaks the moment edges have different weights** — then a longer-in-edges path can be cheaper, and you need Dijkstra.

**Now the part that gets people in interviews.** There are two places you could mark a vertex visited: when you *push* it, or when you *pop* it. Only one is right.

```text
S ─▶ a1 ─┐
S ─▶ a2 ─┼─▶ T
S ─▶ a3 ─┘
```

Mark on **dequeue**:

```text
pop S           push a1, a2, a3        queue: [a1 a2 a3]
pop a1  mark    T not marked → push T  queue: [a2 a3 T]
pop a2  mark    T STILL not marked (only pushed, never popped) → push T
pop a3  mark    T still not marked     → push T
                                       queue: [T T T]   ← T is in there 3 times
```

`T` gets popped three times; the last two do nothing but burn time. That looks like a small constant, but it **compounds per layer**: with `k` predecessors per layer, each layer multiplies the queue size by `k`, so a graph of depth `d` produces `k^d` queue entries. The bug turns O(V + E) back into exponential — the very thing BFS was meant to fix.

Mark on **enqueue**:

```text
pop S     mark+push a1, a2, a3         queue: [a1 a2 a3]
pop a1    T unmarked → MARK, push T    queue: [a2 a3 T]
pop a2    T already marked → skip
pop a3    T already marked → skip      queue: [T]       ← exactly one copy
```

Every vertex enters the queue at most once. **Rule: set `dist[next]` / `visited[next]` in the same breath as `queue.push(next)` — never later.** As a bonus, storing the distance *is* the visited mark, so `dist[v] != -1` doubles as "already seen".

### Grids are graphs

Most interview BFS is on a grid, and the only difference is that you never build the adjacency list:

| graph term | grid equivalent |
|------------|-----------------|
| vertex | cell `(r, c)` |
| `adj[v]` | the 4 (or 8) in-bounds, non-wall neighbours, generated on the fly from a `dirs` array |
| `V + E` | `rows·cols` cells × 4 directions = O(rows·cols) |
| visited set | a parallel `bool` grid — or overwrite the input grid itself |

**Multi-source BFS** is the other grid staple: if several cells start at distance 0 (all the rotten oranges, all the gates), push *all of them* before the loop begins. The ripples merge automatically and each cell still gets its true minimum distance, because the queue is still drained in ring order.

### Steps

```text
Step 1 → dist[src] = 0 (or dist[every source] = 0 for multi-source); push them.
Step 2 → While the queue is not empty, pop the front vertex `v`.
Step 3 → If `v` is the target, its dist is the answer.
Step 4 → For each neighbour `w` of `v`:
Step 5 →     if w is already marked, skip it.
Step 6 →     dist[w] = dist[v] + 1 and MARK w, then push w.   (same breath!)
Step 7 → Queue empty and target never marked → unreachable.
```

### How should I recognize this?

```text
If you see...
  "shortest / fewest / minimum number of steps, moves, transformations"
  "in how many minutes / rounds does everything ...", "level order"
  edges with no weights, or all weights equal
        ↓
Think about...
  "Every move costs the same — so distance is just the ring number."
        ↓
Use...
  one start vertex          → plain BFS with a dist array
  several start vertices    → multi-source BFS: push them ALL at distance 0
  need the ROUND count      → drain one whole layer per outer iteration
  a grid                    → same code, neighbours generated from a dirs array
  weights differ            → NOT this; use Dijkstra (or 0-1 BFS for weights 0/1)
```

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

```text
A: B,C   B: D   C: E   D: F   E: F         source = A

ring 0   queue [A]              dist A=0
         pop A  → push B,C (mark both on push)
ring 1   queue [B C]            dist B=1  dist C=1
         pop B  → push D
         pop C  → push E
ring 2   queue [D E]            dist D=2  dist E=2
         pop D  → F unmarked → MARK, push F      dist F=3
         pop E  → F already marked → skip   ★    (no second copy of F)
ring 3   queue [F]
         pop F  → target reached

shortest A→F = 3
```

### Interview explanation
"All edges cost the same, so the shortest path is just the number of rings you cross — that's BFS. I keep a queue and a `dist` array, push the source at distance 0, and repeatedly pop a vertex and push its unseen neighbours at `dist + 1`. Because a queue is FIFO, everything at distance `d` is popped before anything at `d+1`, so the first time I reach a vertex I've reached it optimally. The detail I'm careful about is marking a vertex visited when I *push* it, not when I pop it — otherwise a vertex with several predecessors in the same layer lands in the queue once per predecessor, and that multiplies layer over layer until BFS is exponential again. It's O(V + E) time and O(V) space. If there were several starting points I'd push all of them at distance 0; if the edge weights differed I'd switch to Dijkstra."

---

## 5. Generic Templates

> Queue + `dist` array. Mark a vertex in the same breath as pushing it. On a grid, the adjacency list is a `dirs` array.

```go
// Template A — adjacency-list graph; dist[v] == -1 means "not seen yet".
func bfsDistances(adj [][]int, sources []int) []int {
    dist := make([]int, len(adj))
    for i := range dist {
        dist[i] = -1
    }
    queue := make([]int, 0, len(adj))
    for _, s := range sources { // multi-source: seed them ALL at distance 0
        if dist[s] == -1 {
            dist[s] = 0
            queue = append(queue, s)
        }
    }
    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        for _, next := range adj[node] {
            if dist[next] != -1 {
                continue // already reached, and never by a longer path
            }
            dist[next] = dist[node] + 1 // MARK and push in the same breath
            queue = append(queue, next)
        }
    }
    return dist
}

// Template B — grid as an implicit graph, drained one whole layer per round.
// Returns the number of rounds needed to reach `target`, or -1.
func bfsGridRounds(grid [][]byte, sr, sc, tr, tc int, wall byte) int {
    rows := len(grid)
    if rows == 0 {
        return -1
    }
    cols := len(grid[0])
    seen := make([][]bool, rows)
    for r := range seen {
        seen[r] = make([]bool, cols)
    }
    dirs := [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} // the "adjacency list"

    seen[sr][sc] = true
    queue := [][2]int{{sr, sc}}
    rounds := 0
    for len(queue) > 0 {
        layer := queue // everything currently at distance `rounds`
        queue = nil
        for _, cur := range layer {
            if cur[0] == tr && cur[1] == tc {
                return rounds
            }
            for _, d := range dirs {
                nr, nc := cur[0]+d[0], cur[1]+d[1]
                if nr < 0 || nr >= rows || nc < 0 || nc >= cols {
                    continue
                }
                if seen[nr][nc] || grid[nr][nc] == wall {
                    continue
                }
                seen[nr][nc] = true // MARK on push
                queue = append(queue, [2]int{nr, nc})
            }
        }
        rounds++
    }
    return -1
}
```

```python
from collections import deque


def bfs_distances(adj, sources):
    dist = [-1] * len(adj)                       # -1 = not seen yet
    queue = deque()
    for s in sources:                            # multi-source: seed ALL at 0
        if dist[s] == -1:
            dist[s] = 0
            queue.append(s)
    while queue:
        node = queue.popleft()
        for nxt in adj[node]:
            if dist[nxt] != -1:
                continue                         # already reached, never worse
            dist[nxt] = dist[node] + 1           # MARK and push together
            queue.append(nxt)
    return dist


def bfs_grid_rounds(grid, start, target, wall):
    rows, cols = len(grid), len(grid[0])
    dirs = ((1, 0), (-1, 0), (0, 1), (0, -1))    # the implicit adjacency list
    seen = [[False] * cols for _ in range(rows)]
    seen[start[0]][start[1]] = True
    queue = deque([start])
    rounds = 0
    while queue:
        for _ in range(len(queue)):              # drain exactly one layer
            r, c = queue.popleft()
            if (r, c) == target:
                return rounds
            for dr, dc in dirs:
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols \
                        and not seen[nr][nc] and grid[nr][nc] != wall:
                    seen[nr][nc] = True          # MARK on push
                    queue.append((nr, nc))
        rounds += 1
    return -1
```

```java
int[] bfsDistances(List<List<Integer>> adj, int[] sources) {
    int[] dist = new int[adj.size()];
    Arrays.fill(dist, -1);                        // -1 = not seen yet
    Deque<Integer> queue = new ArrayDeque<>();
    for (int s : sources)                         // multi-source: seed ALL at 0
        if (dist[s] == -1) { dist[s] = 0; queue.add(s); }

    while (!queue.isEmpty()) {
        int node = queue.poll();
        for (int next : adj.get(node)) {
            if (dist[next] != -1) continue;       // already reached, never worse
            dist[next] = dist[node] + 1;          // MARK and push together
            queue.add(next);
        }
    }
    return dist;
}

int bfsGridRounds(char[][] grid, int sr, int sc, int tr, int tc, char wall) {
    int rows = grid.length, cols = grid[0].length;
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};   // the implicit adjacency list
    boolean[][] seen = new boolean[rows][cols];
    seen[sr][sc] = true;
    Deque<int[]> queue = new ArrayDeque<>();
    queue.add(new int[]{sr, sc});
    int rounds = 0;
    while (!queue.isEmpty()) {
        for (int i = queue.size(); i > 0; i--) {  // drain exactly one layer
            int[] cur = queue.poll();
            if (cur[0] == tr && cur[1] == tc) return rounds;
            for (int[] d : dirs) {
                int nr = cur[0] + d[0], nc = cur[1] + d[1];
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (seen[nr][nc] || grid[nr][nc] == wall) continue;
                seen[nr][nc] = true;              // MARK on push
                queue.add(new int[]{nr, nc});
            }
        }
        rounds++;
    }
    return -1;
}
```

```cpp
vector<int> bfsDistances(const vector<vector<int>>& adj, const vector<int>& sources) {
    vector<int> dist(adj.size(), -1);             // -1 = not seen yet
    queue<int> q;
    for (int s : sources)                         // multi-source: seed ALL at 0
        if (dist[s] == -1) { dist[s] = 0; q.push(s); }

    while (!q.empty()) {
        int node = q.front(); q.pop();
        for (int next : adj[node]) {
            if (dist[next] != -1) continue;       // already reached, never worse
            dist[next] = dist[node] + 1;          // MARK and push together
            q.push(next);
        }
    }
    return dist;
}

int bfsGridRounds(vector<vector<char>>& grid, int sr, int sc,
                  int tr, int tc, char wall) {
    int rows = grid.size(), cols = grid[0].size();
    int dirs[4][2] = {{1,0},{-1,0},{0,1},{0,-1}}; // the implicit adjacency list
    vector<vector<bool>> seen(rows, vector<bool>(cols, false));
    seen[sr][sc] = true;
    queue<pair<int,int>> q;
    q.push({sr, sc});
    int rounds = 0;
    while (!q.empty()) {
        for (int i = q.size(); i > 0; --i) {      // drain exactly one layer
            auto [r, c] = q.front(); q.pop();
            if (r == tr && c == tc) return rounds;
            for (auto& d : dirs) {
                int nr = r + d[0], nc = c + d[1];
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (seen[nr][nc] || grid[nr][nc] == wall) continue;
                seen[nr][nc] = true;              // MARK on push
                q.push({nr, nc});
            }
        }
        ++rounds;
    }
    return -1;
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
A grid holds `0` = empty, `1` = fresh orange, `2` = rotten orange. Each minute, every rotten orange rots its 4-directional fresh neighbours. Return the minute at which no fresh orange remains, or `-1` if that never happens.

### Thought Process
1. Rot spreads one cell per minute in all directions at once — that is a ripple, so it is BFS on the grid.
2. There is not one source but *many*: **every** rotten orange starts at minute 0, so push them all before the loop.
3. Neighbours come from a `dirs` array; the grid is the graph, no adjacency list is built.
4. Overwrite a fresh cell with `2` **the moment it is pushed** — the grid doubles as the visited set, so no cell is queued twice.
5. Count the fresh oranges up front and decrement on each rot. If any are left at the end, they were unreachable → `-1`.

### Dry Run

Input: `grid = [[2,1,1],[1,1,0]]` — fresh count starts at **4**.

```text
      c0 c1 c2
 r0 [  2  1  1 ]
 r1 [  1  1  0 ]
```

| pop | cell (minute) | neighbours rotted this pop | fresh left | queue after |
|-----|---------------|----------------------------|-----------|-------------|
| 1 | (0,0) @ 0 | (1,0)@1, (0,1)@1 | 2 | `[(1,0)@1, (0,1)@1]` |
| 2 | (1,0) @ 1 | (1,1)@2 | 1 | `[(0,1)@1, (1,1)@2]` |
| 3 | (0,1) @ 1 | (0,2)@2 — (1,1) is already `2`, skipped ★ | 0 | `[(1,1)@2, (0,2)@2]` |
| 4 | (1,1) @ 2 | none (left/up rotten, right is empty) | 0 | `[(0,2)@2]` |
| 5 | (0,2) @ 2 | none | 0 | `[]` |

Output: **`2`** — the largest minute stamp popped, and `fresh == 0`.

Row 3 is the mark-on-enqueue rule paying off: `(1,1)` is a neighbour of both `(1,0)` and `(0,1)`. Because pop 2 already wrote `2` into it, pop 3 skips it instead of queueing a duplicate.

### Visualization

```text
minute 0        minute 1        minute 2
 2 1 1           2 2 1           2 2 2
 1 1 0           2 1 0           2 2 0

the ripple front:   {(0,0)}  →  {(1,0),(0,1)}  →  {(1,1),(0,2)}
                      ring 0        ring 1           ring 2

every cell is written exactly once, at the minute it is first reached
```

### Code

```go
func orangesRotting(grid [][]int) int {
    rows := len(grid)
    if rows == 0 {
        return 0
    }
    cols := len(grid[0])

    type cell struct{ r, c, minute int }
    queue := []cell{}
    fresh := 0
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if grid[r][c] == 2 {
                queue = append(queue, cell{r, c, 0}) // EVERY rotten cell is a source
            } else if grid[r][c] == 1 {
                fresh++
            }
        }
    }

    dirs := [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
    minutes := 0
    for len(queue) > 0 {
        cur := queue[0]
        queue = queue[1:]
        if cur.minute > minutes {
            minutes = cur.minute
        }
        for _, d := range dirs {
            nr, nc := cur.r+d[0], cur.c+d[1]
            if nr < 0 || nr >= rows || nc < 0 || nc >= cols {
                continue
            }
            if grid[nr][nc] != 1 {
                continue // empty, or already rotten (the grid IS the visited set)
            }
            grid[nr][nc] = 2 // MARK on enqueue, so it is never queued twice
            fresh--
            queue = append(queue, cell{nr, nc, cur.minute + 1})
        }
    }
    if fresh > 0 {
        return -1 // some fresh orange had no rotten neighbour, ever
    }
    return minutes
}
```

```python
from collections import deque


def orangesRotting(grid):
    rows, cols = len(grid), len(grid[0])
    queue, fresh = deque(), 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == 2:
                queue.append((r, c, 0))          # EVERY rotten cell is a source
            elif grid[r][c] == 1:
                fresh += 1

    dirs = ((1, 0), (-1, 0), (0, 1), (0, -1))
    minutes = 0
    while queue:
        r, c, minute = queue.popleft()
        minutes = max(minutes, minute)
        for dr, dc in dirs:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 1:
                grid[nr][nc] = 2                 # MARK on enqueue
                fresh -= 1
                queue.append((nr, nc, minute + 1))

    return -1 if fresh > 0 else minutes
```

### Complexity
Time O(rows · cols) — every cell is queued at most once and scans 4 neighbours. Space O(rows · cols) for the queue in the worst case (a grid that is entirely rotten at the start). No separate visited grid is needed because rotting a cell marks it.

---

## 10. Solved Example 2

### Problem — Word Ladder (LeetCode 127)
Given `beginWord`, `endWord` and a dictionary, return the number of words in the shortest transformation sequence where each step changes exactly one letter and every intermediate word is in the dictionary. Return `0` if impossible.

### Thought Process
1. Words are vertices; two words share an edge when they differ in exactly one letter. Every step costs 1 → BFS.
2. Never build the adjacency list by comparing all pairs (`O(N²·L)`). Generate neighbours instead: for each of the `L` positions try all 26 letters and keep the candidates that are in the dictionary — `O(26·L)` per word.
3. Process the queue **one whole layer at a time** so `steps` counts words, not pops.
4. Mark on enqueue by **deleting the word from the dictionary** — the dictionary itself is the visited set.
5. If `endWord` is not in the dictionary at all, answer `0` immediately.

### Dry Run

Input: `beginWord = "hit"`, `endWord = "cog"`, `wordList = ["hot","dot","dog","lot","log","cog"]`

| layer (`steps`) | queue at start of layer | one-letter neighbours still in the dict | queue for next layer |
|-----------------|-------------------------|------------------------------------------|----------------------|
| 1 | `hit` | `hot` | `[hot]` |
| 2 | `hot` | `dot`, `lot` | `[dot, lot]` |
| 3 | `dot`, `lot` | `dot`→`dog` (`lot` already taken ★), `lot`→`log` | `[dog, log]` |
| 4 | `dog`, `log` | `dog`→`cog`; `log`→`cog` already taken ★ | `[cog]` |
| 5 | `cog` | — `cog == endWord` → **return 5** | — |

Output: **`5`** (`hit → hot → dot → dog → cog`)

Both ★ marks are the same rule. In layer 3, `dot` and `lot` differ by one letter, so `dot` would happily re-queue `lot` — but `lot` was deleted from the dictionary when layer 2 pushed it. In layer 4, `dog` and `log` both reach `cog`; the first deletes it, the second finds nothing. Without deletion-on-push, layer 4 would contain `cog` twice, and in a dictionary of thousands of words that duplication compounds layer after layer.

### Visualization

```text
layer 1        layer 2        layer 3        layer 4        layer 5
  hit    ───▶   hot    ───▶    dot    ───▶    dog    ───▶    cog   ★ end
                       ───▶    lot    ───▶    log    ──✗ cog already taken

steps counts WORDS, not edges:  hit,hot,dot,dog,cog = 5

neighbour generation for "hot":
   _ot → aot bot cot ... (only dot, lot in dict)
   h_t → hat hbt hct ... (none)
   ho_ → hoa hob hoc ... (none)
   26 x 3 candidates, no pairwise comparison anywhere
```

### Code

```go
func ladderLength(beginWord string, endWord string, wordList []string) int {
    dict := make(map[string]bool, len(wordList))
    for _, w := range wordList {
        dict[w] = true
    }
    if !dict[endWord] {
        return 0 // the target is not even a legal word
    }
    delete(dict, beginWord) // never come back to the start

    queue := []string{beginWord}
    steps := 1 // the sequence length counts words, so it starts at 1
    for len(queue) > 0 {
        next := []string{} // collect one whole layer before advancing steps
        for _, word := range queue {
            if word == endWord {
                return steps
            }
            letters := []byte(word)
            for i := 0; i < len(letters); i++ {
                original := letters[i]
                for ch := byte('a'); ch <= 'z'; ch++ {
                    if ch == original {
                        continue
                    }
                    letters[i] = ch
                    candidate := string(letters)
                    if dict[candidate] {
                        delete(dict, candidate) // MARK on enqueue
                        next = append(next, candidate)
                    }
                }
                letters[i] = original // restore before moving to the next position
            }
        }
        queue = next
        steps++
    }
    return 0
}
```

```python
from collections import deque
from string import ascii_lowercase


def ladderLength(beginWord, endWord, wordList):
    dict_words = set(wordList)
    if endWord not in dict_words:
        return 0                                   # target is not a legal word
    dict_words.discard(beginWord)                  # never come back to the start

    queue = deque([beginWord])
    steps = 1                                      # sequence length counts words
    while queue:
        for _ in range(len(queue)):                # drain exactly one layer
            word = queue.popleft()
            if word == endWord:
                return steps
            for i in range(len(word)):
                for ch in ascii_lowercase:
                    if ch == word[i]:
                        continue
                    candidate = word[:i] + ch + word[i + 1:]
                    if candidate in dict_words:
                        dict_words.remove(candidate)   # MARK on enqueue
                        queue.append(candidate)
        steps += 1
    return 0
```

### Complexity
Time O(N · L · 26) where `N` is the dictionary size and `L` the word length — each word is dequeued once and generates `26·L` candidates, each checked in O(L) for hashing. Space O(N · L) for the dictionary and queue. Building an explicit adjacency list by comparing every pair would be O(N² · L).

---

## 11. Solved Example 3

### Problem — Shortest Path Binary (LeetCode 1091)
In an `n × n` binary matrix, a clear path goes from `(0,0)` to `(n−1,n−1)` visiting only cells equal to `0`, moving in any of the **8** directions. Return the number of cells on the shortest such path, or `-1`.

### Thought Process
1. Every move costs 1 cell → BFS. The only twist versus a normal grid is 8 neighbours instead of 4.
2. Bail out immediately if the start or the end cell is blocked; BFS would otherwise wander pointlessly.
3. Carry the distance in the queue entry, counting **cells**, so the start is `1`, not `0`.
4. Use a separate `visited` grid (the input is const-ish here) and set it when pushing.
5. Return as soon as the target is popped — with BFS, the first arrival is the shortest.

### Dry Run

Input:

```text
      c0 c1 c2
 r0 [  0  0  0 ]
 r1 [  1  1  0 ]
 r2 [  1  1  0 ]
```

| pop | cell (dist) | open, unvisited 8-neighbours | queue after |
|-----|-------------|------------------------------|-------------|
| 1 | (0,0) @ 1 | (0,1) — (1,0) and (1,1) are walls | `[(0,1)@2]` |
| 2 | (0,1) @ 2 | (0,2), (1,2) — (1,0),(1,1) are walls | `[(0,2)@3, (1,2)@3]` |
| 3 | (0,2) @ 3 | none — (1,1) is a wall, (1,2) already visited ★ | `[(1,2)@3]` |
| 4 | (1,2) @ 3 | (2,2) — (2,1) is a wall | `[(2,2)@4]` |
| 5 | (2,2) @ 4 | **target popped → return 4** | — |

Output: **`4`** — the path `(0,0) → (0,1) → (1,2) → (2,2)`, using one diagonal step.

Row 3 shows mark-on-enqueue again: `(1,2)` is a diagonal neighbour of both `(0,1)` and `(0,2)`. Pop 2 marked it, so pop 3 skips it rather than adding a second copy at the same distance.

### Visualization

```text
distance grid (blank = wall, never reached):

      c0  c1  c2
 r0 [  1   2   3 ]
 r1 [  #   #   3 ]      ← (1,2) reached DIAGONALLY from (0,1), also at 3
 r2 [  #   #   4 ]

path:  (0,0) ──▶ (0,1) ──↘ (1,2) ──▶ (2,2)          4 cells
                       diagonal

8 directions = all (dr,dc) with dr,dc in {-1,0,1}, excluding (0,0):

        ↖  ↑  ↗
        ←  ·  →
        ↙  ↓  ↘
```

### Code

```go
func shortestPathBinaryMatrix(grid [][]int) int {
    n := len(grid)
    if n == 0 || grid[0][0] != 0 || grid[n-1][n-1] != 0 {
        return -1 // start or end is blocked — no path can exist
    }

    visited := make([][]bool, n)
    for r := range visited {
        visited[r] = make([]bool, n)
    }
    type cell struct{ r, c, dist int }
    visited[0][0] = true
    queue := []cell{{0, 0, 1}} // dist counts CELLS, so the start is 1

    for len(queue) > 0 {
        cur := queue[0]
        queue = queue[1:]
        if cur.r == n-1 && cur.c == n-1 {
            return cur.dist // first arrival is the shortest, by BFS ring order
        }
        for dr := -1; dr <= 1; dr++ {
            for dc := -1; dc <= 1; dc++ {
                if dr == 0 && dc == 0 {
                    continue // all 8 neighbours, but not the cell itself
                }
                nr, nc := cur.r+dr, cur.c+dc
                if nr < 0 || nr >= n || nc < 0 || nc >= n {
                    continue
                }
                if grid[nr][nc] != 0 || visited[nr][nc] {
                    continue
                }
                visited[nr][nc] = true // MARK on enqueue
                queue = append(queue, cell{nr, nc, cur.dist + 1})
            }
        }
    }
    return -1 // queue drained without reaching the corner
}
```

```python
from collections import deque


def shortestPathBinaryMatrix(grid):
    n = len(grid)
    if n == 0 or grid[0][0] != 0 or grid[n - 1][n - 1] != 0:
        return -1                                  # start or end blocked
    visited = [[False] * n for _ in range(n)]
    visited[0][0] = True
    queue = deque([(0, 0, 1)])                     # dist counts CELLS

    while queue:
        r, c, dist = queue.popleft()
        if r == n - 1 and c == n - 1:
            return dist                            # first arrival is shortest
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue                       # 8 neighbours, not itself
                nr, nc = r + dr, c + dc
                if 0 <= nr < n and 0 <= nc < n \
                        and grid[nr][nc] == 0 and not visited[nr][nc]:
                    visited[nr][nc] = True         # MARK on enqueue
                    queue.append((nr, nc, dist + 1))
    return -1
```

### Complexity
Time O(n²) — each of the `n²` cells is queued at most once and inspects 8 neighbours, a constant. Space O(n²) for the `visited` grid and the queue. Enumerating paths instead would be exponential.

---

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
