# 63 · Topological Sort

> **One-liner:** Order a DAG so every edge points forward (Kahn / DFS finish times).

---

## 1. Overview

### Definition
The **Topological Sort** pattern belongs to the *Graphs* family. Order a DAG so every edge points forward (Kahn / DFS finish times).

### Intuition
Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.

### Why it works
Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.

---

## 2. Recognition Signals

### Keywords
topological sort, kahn, dag, ordering, prerequisites, indegree.

### Constraints
- Input size where the brute-force complexity would time out — the Topological Sort optimization is the intended solution.
- Structural hints in the statement that match this family (Graphs).

### Hidden clues
- The problem can be reframed so the Topological Sort invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Topological Sort is the upgrade.
- The wording maps onto: topological sort, kahn, dag, ordering, prerequisites, indegree.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"In what order can I do these tasks, when some must come before others?"*

### Intuition
Guess an order, then check whether it respects every constraint.

### Algorithm
1. Generate a permutation of the `n` tasks.
2. For each prerequisite pair `(a before b)`, check that `a` appears before `b`.
3. If every pair holds, that permutation is a valid order.
4. Otherwise try the next permutation.

### Complexity
- Time: **O(n! · E)** — factorially many permutations, each validated against every edge.
- Space: O(n).

### Drawbacks
- `n = 12` already gives half a billion permutations. Real inputs have thousands of tasks.
- And it discards the structure completely. The constraints don't merely *filter* orders — they **construct** one, if you read them the right way.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Repeatedly take any task that has no unmet prerequisites, and remove it — the order you take them in *is* the answer.**

That "no unmet prerequisites" test is just a counter per task: how many prerequisites are still outstanding. Finishing a task decrements its dependents' counters, which may free them in turn.

### The thought process

```text
We need    : an order respecting all "a before b" constraints.
Obvious way: try every permutation and validate.
Hopeless   : O(n!).
Notice     : at any moment, a task with ZERO unmet prerequisites can
             be done immediately — and doing it can only ever HELP
             other tasks, never hurt them.
             So there is no need to guess: take any such task.
Therefore  : count prerequisites per task (its in-degree). Keep a queue
             of the zero-count ones. Pop, output, decrement dependents,
             enqueue anything that just reached zero.
Now        : O(V + E), one pass.
```

This is **Kahn's algorithm**, and the greedy choice is safe for a simple reason: taking an available task never removes an edge that some other task needed. Removals only ever reduce counters.

### Steps

```text
Step 1 → Build the adjacency list: prerequisite → the tasks that need it.
Step 2 → Compute inDegree[task] = how many prerequisites it has.
Step 3 → Queue every task with inDegree == 0.
Step 4 → While the queue is not empty:
Step 5 →     task = dequeue; append it to the order
Step 6 →     for each dependent of task:
Step 7 →         inDegree[dependent]--
Step 8 →         if it hit 0, enqueue it
Step 9 → If len(order) == n, that is a valid order.
          Otherwise a CYCLE exists and no order is possible.
```

### The cycle check is free — and it is the whole point of half these problems

Step 9 deserves its own paragraph, because it is where most of the value lives.

If the graph has a cycle, every task on that cycle permanently waits for another task on the same cycle. None of their in-degrees ever reaches zero, so none is ever enqueued. The loop simply ends early:

```text
processed all n tasks   →  no cycle, and `order` is a valid schedule
processed fewer than n  →  a cycle exists, no valid order at all
```

So "can I finish all courses?" (a yes/no question) and "give me the order" (a construction) are **the same algorithm**, differing only in what you return. You never need a separate cycle-detection pass.

### Which direction do the edges point?

The single most common bug. `[a, b]` in LeetCode's course problems means *"to take `a`, you must first take `b`"* — so the dependency runs `b → a`:

```text
prerequisite  ──edge──▶  the course that needs it
      b       ──────▶          a

inDegree[a] counts how many prerequisites a still has
```

Draw one arrow before you write the loop. Getting this backwards produces a reversed but plausible-looking answer that passes small tests and fails larger ones.

### The DFS alternative

There is a second construction: run DFS, and **prepend** each node to the result when its recursion finishes (postorder, reversed).

```text
Kahn (BFS)                    DFS + reverse postorder
──────────────────────────    ──────────────────────────
iterative, no stack limit     recursive, can overflow
cycle check is free (count)   needs 3-colour marking to spot cycles
natural for "levels"          natural when you already have a DFS
```

For cycle detection with DFS you need three states — unvisited / **in progress** / done — because meeting an *in-progress* node means you've looped back onto your own path. A plain two-state `visited` set cannot tell that apart from a legitimate re-visit via a different branch.

Kahn's is usually the better interview answer: iterative, and the cycle check comes for free.

### Ordering is not unique

Any task with in-degree 0 may be taken. Different queue orders give different valid answers, and problems that ask for *the* order normally accept any of them. If a specific tie-break is required (say, lexicographically smallest), swap the queue for a **min-heap** — same algorithm, O(V log V + E).

### How should I recognize this?

```text
If you see...
  "prerequisites", "dependencies", "build order", "course schedule"
  "can all tasks be finished", "is there a cycle in a DIRECTED graph"
  "alien dictionary", any "X must come before Y"
        ↓
Think about...
  "What has nothing waiting on it right now?"
        ↓
Use...
  Kahn: in-degree counts + a queue of the zeros
  order shorter than n  ⇒  a cycle  ⇒  impossible
  need a specific tie-break?  →  min-heap instead of a queue
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="arw-63" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Topological order: every edge points forward (left → right)</text>
  <!-- edges, all left to right -->
  <line x1="102" y1="105" x2="208" y2="70"  stroke="#475569" marker-end="url(#arw-63)"/>
  <line x1="102" y1="115" x2="368" y2="112" stroke="#475569" marker-end="url(#arw-63)"/>
  <line x1="252" y1="72"  x2="368" y2="105" stroke="#475569" marker-end="url(#arw-63)"/>
  <line x1="412" y1="110" x2="528" y2="110" stroke="#475569" marker-end="url(#arw-63)"/>
  <!-- nodes -->
  <circle cx="80"  cy="110" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="80"  y="115" text-anchor="middle" font-weight="700" fill="#1e293b">A</text>
  <circle cx="230" cy="65"  r="22" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="70"  text-anchor="middle" font-weight="700" fill="#1e293b">B</text>
  <circle cx="390" cy="110" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="390" y="115" text-anchor="middle" font-weight="700" fill="#1e293b">C</text>
  <circle cx="550" cy="110" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="550" y="115" text-anchor="middle" font-weight="700" fill="#1e293b">D</text>
  <!-- order strip -->
  <text x="60"  y="185" text-anchor="middle" fill="#64748b">order:</text>
  <rect x="150" y="168" width="34" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="167" y="188" text-anchor="middle" fill="#1e293b">A</text>
  <rect x="190" y="168" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="207" y="188" text-anchor="middle" fill="#1e293b">B</text>
  <rect x="230" y="168" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="247" y="188" text-anchor="middle" fill="#1e293b">C</text>
  <rect x="270" y="168" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="287" y="188" text-anchor="middle" fill="#1e293b">D</text>
  <text x="360" y="188" text-anchor="middle" fill="#64748b">(indegree 0 first)</text>
</svg>
```

```text
courses 0..3, prerequisites [[1,0],[2,0],[3,1],[3,2]]
(edges point prerequisite → dependent)

        0
       / \
      ▼   ▼
      1   2
       \ /
        ▼
        3

inDegree:  0→0   1→1   2→1   3→2

queue [0]      pop 0 → order [0]        1 and 2 drop to 0 → queue [1,2]
queue [1,2]    pop 1 → order [0,1]      3 drops to 1
queue [2]      pop 2 → order [0,1,2]    3 drops to 0 → queue [3]
queue [3]      pop 3 → order [0,1,2,3]

4 of 4 processed → no cycle → valid order
```

### Interview explanation
"I'll use Kahn's algorithm. I build an adjacency list pointing from each prerequisite to the courses that need it, and count in-degrees — how many prerequisites each course still has. Everything with in-degree zero goes in a queue. I pop one, append it to the order, and decrement its dependents' counters, enqueueing any that reach zero. The greedy choice is safe because completing an available task can only reduce other tasks' counters, never increase them. The cycle check comes for free: if I finish having processed fewer than `n` courses, the remaining ones are all waiting on each other, so no valid order exists. That's O(V + E) time and space. The DFS alternative is reverse postorder, but it needs three-colour marking to detect cycles, so Kahn's is usually cleaner."

---

## 5. Generic Templates

> In-degrees plus a queue of the zeros. A short result means a cycle.

```go
// TopologicalSort returns a valid ordering, or nil if the graph has a cycle.
// edges are (from → to), meaning `from` must come before `to`.
func TopologicalSort(n int, edges [][]int) []int {
    dependents := make([][]int, n) // prerequisite → tasks needing it
    inDegree := make([]int, n)     // how many prerequisites remain

    for _, e := range edges {
        from, to := e[0], e[1]
        dependents[from] = append(dependents[from], to)
        inDegree[to]++
    }

    // Everything with nothing waiting on it can start immediately.
    queue := []int{}
    for task := 0; task < n; task++ {
        if inDegree[task] == 0 {
            queue = append(queue, task)
        }
    }

    order := make([]int, 0, n)
    for len(queue) > 0 {
        task := queue[0]
        queue = queue[1:]
        order = append(order, task)

        for _, next := range dependents[task] {
            inDegree[next]-- // one prerequisite satisfied
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    if len(order) != n {
        return nil // a cycle: some tasks never reached in-degree 0
    }
    return order
}

// HasCycle reuses the exact same machinery — only the return type differs.
func HasCycle(n int, edges [][]int) bool {
    return TopologicalSort(n, edges) == nil
}

// TopologicalSortSmallest breaks ties toward the smallest task id by
// swapping the queue for a min-heap.
func TopologicalSortSmallest(n int, edges [][]int) []int {
    dependents := make([][]int, n)
    inDegree := make([]int, n)
    for _, e := range edges {
        dependents[e[0]] = append(dependents[e[0]], e[1])
        inDegree[e[1]]++
    }

    available := &intMinHeap{}
    for task := 0; task < n; task++ {
        if inDegree[task] == 0 {
            *available = append(*available, task)
        }
    }
    heap.Init(available)

    order := make([]int, 0, n)
    for available.Len() > 0 {
        task := heap.Pop(available).(int)
        order = append(order, task)
        for _, next := range dependents[task] {
            inDegree[next]--
            if inDegree[next] == 0 {
                heap.Push(available, next)
            }
        }
    }

    if len(order) != n {
        return nil
    }
    return order
}

type intMinHeap []int

func (h intMinHeap) Len() int           { return len(h) }
func (h intMinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h intMinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *intMinHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *intMinHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
from collections import deque

def topological_sort(n, edges):
    """Valid ordering, or None if there is a cycle. edges are (from, to)."""
    dependents = [[] for _ in range(n)]
    in_degree = [0] * n

    for frm, to in edges:
        dependents[frm].append(to)
        in_degree[to] += 1

    queue = deque(task for task in range(n) if in_degree[task] == 0)

    order = []
    while queue:
        task = queue.popleft()
        order.append(task)
        for nxt in dependents[task]:
            in_degree[nxt] -= 1          # one prerequisite satisfied
            if in_degree[nxt] == 0:
                queue.append(nxt)

    return order if len(order) == n else None   # short result ⇒ cycle

def has_cycle(n, edges):
    """Same machinery, different return type."""
    return topological_sort(n, edges) is None

def topological_sort_smallest(n, edges):
    """Lexicographically smallest order: min-heap instead of a queue."""
    import heapq
    dependents = [[] for _ in range(n)]
    in_degree = [0] * n
    for frm, to in edges:
        dependents[frm].append(to)
        in_degree[to] += 1

    available = [t for t in range(n) if in_degree[t] == 0]
    heapq.heapify(available)

    order = []
    while available:
        task = heapq.heappop(available)
        order.append(task)
        for nxt in dependents[task]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                heapq.heappush(available, nxt)

    return order if len(order) == n else None
```

```java
import java.util.*;

public class TopologicalSort {
    // Valid ordering, or null if the graph has a cycle.
    public static List<Integer> sort(int n, int[][] edges) {
        List<List<Integer>> dependents = new ArrayList<>();
        for (int i = 0; i < n; i++) dependents.add(new ArrayList<>());
        int[] inDegree = new int[n];

        for (int[] e : edges) {
            dependents.get(e[0]).add(e[1]);
            inDegree[e[1]]++;
        }

        Queue<Integer> queue = new ArrayDeque<>();
        for (int t = 0; t < n; t++) if (inDegree[t] == 0) queue.add(t);

        List<Integer> order = new ArrayList<>();
        while (!queue.isEmpty()) {
            int task = queue.poll();
            order.add(task);
            for (int next : dependents.get(task)) {
                if (--inDegree[next] == 0) queue.add(next);
            }
        }

        return order.size() == n ? order : null;   // short result ⇒ cycle
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

// Valid ordering, or an empty vector if the graph has a cycle.
vector<int> topologicalSort(int n, const vector<vector<int>>& edges) {
    vector<vector<int>> dependents(n);
    vector<int> inDegree(n, 0);

    for (const auto& e : edges) {
        dependents[e[0]].push_back(e[1]);
        ++inDegree[e[1]];
    }

    queue<int> q;
    for (int t = 0; t < n; ++t) if (inDegree[t] == 0) q.push(t);

    vector<int> order;
    order.reserve(n);
    while (!q.empty()) {
        int task = q.front();
        q.pop();
        order.push_back(task);
        for (int next : dependents[task])
            if (--inDegree[next] == 0) q.push(next);
    }

    if ((int)order.size() != n) return {};        // short result ⇒ cycle
    return order;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Topological Sort (Optimal) |
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

### Problem — Course Schedule (LeetCode 207)
`prerequisites[i] = [a, b]` means you must take course `b` before course `a`. Return `true` if all courses can be finished.

### Thought Process
1. "Can all courses be finished?" is exactly "does this directed graph have no cycle?"
2. Kahn's algorithm answers it for free: run the topological sort and check how many courses came out.
3. Edge direction matters — `[a, b]` means `b → a`, so `inDegree[a]` counts `a`'s prerequisites.
4. Process courses with in-degree 0, decrementing dependents as they complete.
5. If fewer than `n` courses were processed, the rest are waiting on each other — a cycle.

### Dry Run — a schedulable case

Input: `numCourses = 2`, `prerequisites = [[1, 0]]` (take 0 before 1)

Edges: `0 → 1`. In-degrees: `0 → 0`, `1 → 1`.

| step | queue | popped | processed | decrements | new zeros |
|------|-------|--------|-----------|------------|-----------|
| init | `[0]` | — | 0 | — | — |
| 1 | `[0]` | `0` | **1** | `inDegree[1]: 1 → 0` | `1` |
| 2 | `[1]` | `1` | **2** | none | — |
| 3 | `[]` | — | 2 | — | stop |

Processed 2 of 2 → **`true`** ✓

### Dry Run — a cyclic case

Input: `numCourses = 2`, `prerequisites = [[1, 0], [0, 1]]`

Edges: `0 → 1` and `1 → 0`. In-degrees: `0 → 1`, `1 → 1`.

| step | queue | note |
|------|-------|------|
| init | `[]` | **nothing** has in-degree 0 — every course waits on the other |
| 1 | `[]` | loop never runs; processed = 0 |

Processed 0 of 2 → **`false`** ✓

That empty initial queue is the cycle announcing itself. No separate detection pass is needed.

### Visualization

```text
schedulable:   0 ──▶ 1          inDegree: 0→0, 1→1
               start at 0, then 1     →  2 of 2  →  true

cyclic:        0 ──▶ 1
               ▲     │          inDegree: 0→1, 1→1
               └─────┘          nothing starts at 0  →  0 of 2  →  false
```

### Code

```go
func canFinish(numCourses int, prerequisites [][]int) bool {
    dependents := make([][]int, numCourses) // prerequisite → courses needing it
    inDegree := make([]int, numCourses)

    for _, p := range prerequisites {
        course, prerequisite := p[0], p[1]
        // [course, prerequisite] means prerequisite must come FIRST.
        dependents[prerequisite] = append(dependents[prerequisite], course)
        inDegree[course]++
    }

    queue := []int{}
    for course := 0; course < numCourses; course++ {
        if inDegree[course] == 0 {
            queue = append(queue, course)
        }
    }

    processed := 0
    for len(queue) > 0 {
        course := queue[0]
        queue = queue[1:]
        processed++

        for _, next := range dependents[course] {
            inDegree[next]--
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    // Short of numCourses means the rest are waiting on each other.
    return processed == numCourses
}
```

```python
from collections import deque

def canFinish(numCourses, prerequisites):
    dependents = [[] for _ in range(numCourses)]
    in_degree = [0] * numCourses

    for course, prerequisite in prerequisites:
        # [course, prerequisite] means prerequisite comes FIRST.
        dependents[prerequisite].append(course)
        in_degree[course] += 1

    queue = deque(c for c in range(numCourses) if in_degree[c] == 0)

    processed = 0
    while queue:
        course = queue.popleft()
        processed += 1
        for nxt in dependents[course]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)

    return processed == numCourses      # short ⇒ cycle
```

### Complexity
Time **O(V + E)** — each course is enqueued once and each edge relaxed once. Space O(V + E).

---

## 10. Solved Example 2

### Problem — Course Schedule II (LeetCode 210)
Same input, but return **an actual valid order**, or an empty array if none exists.

### Thought Process
1. Identical algorithm — the only change is that we collect the popped courses instead of just counting them.
2. That is the useful realisation: the yes/no question and the construction question are one algorithm.
3. If the collected order is shorter than `numCourses`, a cycle exists and we return an empty array.
4. Any valid order is accepted; different queue orders give different correct answers.
5. To force a specific tie-break (lexicographically smallest, say), swap the queue for a min-heap.

### Dry Run

Input: `numCourses = 4`, `prerequisites = [[1,0], [2,0], [3,1], [3,2]]`

Edges: `0 → 1`, `0 → 2`, `1 → 3`, `2 → 3`.
In-degrees: `0 → 0`, `1 → 1`, `2 → 1`, `3 → 2`.

```text
        0
       / \
      ▼   ▼
      1   2
       \ /
        ▼
        3
```

| step | queue before | pop | order so far | decrements | enqueued |
|------|--------------|-----|--------------|------------|----------|
| 1 | `[0]` | `0` | `[0]` | `1: 1→0`, `2: 1→0` | `1`, `2` |
| 2 | `[1, 2]` | `1` | `[0, 1]` | `3: 2→1` | — |
| 3 | `[2]` | `2` | `[0, 1, 2]` | `3: 1→0` | `3` |
| 4 | `[3]` | `3` | `[0, 1, 2, 3]` | none | — |

Output: **`[0, 1, 2, 3]`** ✓

Note step 2: course `3` had **two** prerequisites, so finishing `1` alone was not enough. It only became available after `2` finished too — which is precisely what the in-degree counter tracks.

`[0, 2, 1, 3]` is equally valid; it is what you would get by enqueueing `2` before `1`.

### Visualization

```text
inDegree:  0:0   1:1   2:1   3:2

pop 0  →  order [0]           1→0, 2→0        queue [1,2]
pop 1  →  order [0,1]         3→1             queue [2]
pop 2  →  order [0,1,2]       3→0             queue [3]
pop 3  →  order [0,1,2,3]                     queue []

4 of 4 processed → valid order
```

### Code

```go
func findOrder(numCourses int, prerequisites [][]int) []int {
    dependents := make([][]int, numCourses)
    inDegree := make([]int, numCourses)

    for _, p := range prerequisites {
        course, prerequisite := p[0], p[1]
        dependents[prerequisite] = append(dependents[prerequisite], course)
        inDegree[course]++
    }

    queue := []int{}
    for course := 0; course < numCourses; course++ {
        if inDegree[course] == 0 {
            queue = append(queue, course)
        }
    }

    // Same loop as Example 1 — we just keep the courses instead of counting.
    order := make([]int, 0, numCourses)
    for len(queue) > 0 {
        course := queue[0]
        queue = queue[1:]
        order = append(order, course)

        for _, next := range dependents[course] {
            inDegree[next]--
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    if len(order) != numCourses {
        return []int{} // a cycle: no valid order exists
    }
    return order
}
```

```python
from collections import deque

def findOrder(numCourses, prerequisites):
    dependents = [[] for _ in range(numCourses)]
    in_degree = [0] * numCourses

    for course, prerequisite in prerequisites:
        dependents[prerequisite].append(course)
        in_degree[course] += 1

    queue = deque(c for c in range(numCourses) if in_degree[c] == 0)

    order = []                          # keep them, don't just count
    while queue:
        course = queue.popleft()
        order.append(course)
        for nxt in dependents[course]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)

    return order if len(order) == numCourses else []
```

### Complexity
Time **O(V + E)**, Space O(V + E).

---

## 11. Solved Example 3

### Problem — Alien Dictionary (LeetCode 269)
Given words sorted according to an unknown alphabet, return a possible letter order, or `""` if the input is inconsistent.

### Thought Process
1. The sortedness of the word list is the *only* source of information, and it constrains **adjacent pairs** only.
2. For each adjacent pair, walk both words together to the **first differing character**. That single pair gives one ordering edge; everything after it tells you nothing.
3. Collect every letter that appears — even letters with no constraints must be in the output.
4. Run the standard topological sort over those edges.
5. Two failure modes: a cycle (contradictory constraints) and an **invalid prefix**.

**The invalid-prefix case** is the edge case interviewers look for. If `word1` is longer than `word2` and `word2` is a prefix of it — like `["abc", "ab"]` — then no alphabet makes that ordering valid, because a prefix always sorts first. Return `""` immediately.

### Dry Run

Input: `words = ["wrt", "wrf", "er", "ett", "rftt"]`

**Step 1 — derive edges from adjacent pairs:**

| pair | first difference | edge |
|------|------------------|------|
| `"wrt"`, `"wrf"` | index 2: `t` vs `f` | **t → f** |
| `"wrf"`, `"er"`  | index 0: `w` vs `e` | **w → e** |
| `"er"`, `"ett"`  | index 1: `r` vs `t` | **r → t** |
| `"ett"`, `"rftt"`| index 0: `e` vs `r` | **e → r** |

Letters present: `w, r, t, f, e`

**Step 2 — in-degrees:**

| letter | w | e | r | t | f |
|--------|---|---|---|---|---|
| in-degree | 0 | 1 (from w) | 1 (from e) | 1 (from r) | 1 (from t) |

**Step 3 — Kahn's:**

| queue | pop | order | decrements |
|-------|-----|-------|------------|
| `[w]` | `w` | `w` | `e: 1→0` |
| `[e]` | `e` | `we` | `r: 1→0` |
| `[r]` | `r` | `wer` | `t: 1→0` |
| `[t]` | `t` | `wert` | `f: 1→0` |
| `[f]` | `f` | `wertf` | — |

Output: **`"wertf"`** ✓

All 5 letters emitted, so there is no cycle. Note the chain was forced here — every step had exactly one available letter — so this input has a unique answer.

### Visualization

```text
"wrt"           t before f
"wrf"    ──▶    w before e
"er"            r before t
"ett"           e before r
"rftt"

  w ──▶ e ──▶ r ──▶ t ──▶ f

only the FIRST differing character of each adjacent pair matters
```

### Code

```go
func alienOrder(words []string) string {
    // Every letter that appears must show up in the answer, even if
    // no constraint mentions it.
    dependents := make(map[byte][]byte)
    inDegree := make(map[byte]int)
    for _, word := range words {
        for i := 0; i < len(word); i++ {
            if _, seen := inDegree[word[i]]; !seen {
                inDegree[word[i]] = 0
            }
        }
    }

    // Each adjacent pair gives at most one ordering edge.
    for i := 0; i+1 < len(words); i++ {
        first, second := words[i], words[i+1]

        minLen := len(first)
        if len(second) < minLen {
            minLen = len(second)
        }

        foundDifference := false
        for j := 0; j < minLen; j++ {
            if first[j] != second[j] {
                dependents[first[j]] = append(dependents[first[j]], second[j])
                inDegree[second[j]]++
                foundDifference = true
                break // only the FIRST difference carries information
            }
        }

        // "abc" before "ab" is impossible: a prefix always sorts first.
        if !foundDifference && len(first) > len(second) {
            return ""
        }
    }

    queue := []byte{}
    for letter, degree := range inDegree {
        if degree == 0 {
            queue = append(queue, letter)
        }
    }
    // Sort the initial queue so the output is deterministic.
    sort.Slice(queue, func(a, b int) bool { return queue[a] < queue[b] })

    order := make([]byte, 0, len(inDegree))
    for len(queue) > 0 {
        letter := queue[0]
        queue = queue[1:]
        order = append(order, letter)

        for _, next := range dependents[letter] {
            inDegree[next]--
            if inDegree[next] == 0 {
                queue = append(queue, next)
            }
        }
    }

    if len(order) != len(inDegree) {
        return "" // a cycle: the constraints contradict each other
    }
    return string(order)
}
```

```python
from collections import deque

def alienOrder(words):
    dependents = {}
    in_degree = {ch: 0 for word in words for ch in word}   # every letter appears

    for first, second in zip(words, words[1:]):
        found = False
        for a, b in zip(first, second):
            if a != b:
                dependents.setdefault(a, []).append(b)
                in_degree[b] += 1
                found = True
                break                    # only the FIRST difference matters
        # "abc" before "ab" is impossible: a prefix always sorts first.
        if not found and len(first) > len(second):
            return ""

    queue = deque(sorted(ch for ch, d in in_degree.items() if d == 0))

    order = []
    while queue:
        ch = queue.popleft()
        order.append(ch)
        for nxt in dependents.get(ch, ()):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)

    return "".join(order) if len(order) == len(in_degree) else ""
```

### Complexity
Time **O(C)** where `C` is the total number of characters across all words — building the graph dominates, and the sort is over at most 26 letters. Space O(1) in the alphabet size, or O(U + E) for `U` distinct letters.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 207 | Course Schedule | Easy | Core graphs application |
| 210 | Course Schedule II | Easy | Core graphs application |
| 269 | Alien Dict | Medium | Core graphs application |
| 310 | Min Height Trees | Medium | Core graphs application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Topological Sort logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Topological Sort (Graphs).
- **Signal:** topological sort, kahn, dag, ordering, prerequisites, indegree.
- **Move:** Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.
- **Cost:** O(V + E) time, O(V) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Topological Sort invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Topological Sort
FAMILY : Graphs (Advanced)
WHEN   : topological sort, kahn, dag, ordering, prerequisites, indegree
DO     : Pick the traversal by structure: BFS for unweighted shortest paths, DFS for conn
TIME   : O(V + E)    SPACE: O(V)
PRACTICE: 207, 210, 269, 310
```

---

*Part of the DSA Patterns Handbook — pattern 63 of 100.*
