# 42 · BFS Queue Pattern

> **One-liner:** Queue-driven level-by-level expansion for shortest unweighted paths.

---

## 1. Overview

### Definition
The **BFS Queue Pattern** pattern belongs to the *Queues* family. Queue-driven level-by-level expansion for shortest unweighted paths.

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
bfs, queue, level order, shortest path, unweighted.

### Constraints
- Input size where the brute-force complexity would time out — the BFS Queue Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the BFS Queue Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — BFS Queue Pattern is the upgrade.
- The wording maps onto: bfs, queue, level order, shortest path, unweighted.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the fewest number of moves from here to there, when every move costs the same?"*

Running example: five rooms, doors as listed. Find the fewest doors to walk through from room `0` to room `4`.

```text
       1 ─── 2
      /        \
     0          4          doors: 0-1, 1-2, 2-4, 0-3, 3-4
      \        /
       3 ─────
```

### Intuition
Walk every possible route from `0` to `4`, never repeating a room within a route, and remember the shortest route you ever completed. It is exhaustive, so it must be right.

### Algorithm
1. Depth-first walk from `0`, carrying the set of rooms already on the current route.
2. On reaching `4`, record the route's length and back out.
3. On reaching a dead end or an already-used room, back out.
4. Return the smallest recorded length.

### Complexity
- Time: **O(V!)** in the worst case — the number of simple paths in a dense graph grows factorially.
- Space: O(V) for the recursion stack, plus whatever routes you keep.

### Drawbacks

Trace it on the running example. DFS tries neighbours in order, so it goes `0 → 1` first:

```text
route 0 → 1 → 2 → 4      length 3      ← found first, and it is NOT the answer
route 0 → 3 → 4          length 2      ← found second
route 0 → 1 → 2 → 4 → 3  dead end (4 already used as the target)
...
best = 2
```

- **The exact wasted work:** the search commits to a full 3-door route before ever looking at the 2-door route sitting one branch over. On a grid with 10^4 cells that "look deep before looking wide" habit is fatal.
- **The fact it fails to exploit:** every edge costs exactly **1**. So the answer is a *count of layers*, not a search over routes. If you expanded outward one layer at a time, the first time you touched room `4` you would already be holding its shortest distance — no comparison of alternatives needed.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Expand outward in rings of equal distance — a FIFO queue makes nodes come out in non-decreasing distance order, so the first time you see a node you have already found its shortest path.**

Think of dropping a stone in a pond. The ripple reaches everything 1 metre away before anything 2 metres away, purely because it moves outward uniformly. BFS is that ripple: the queue holds the current ring, and popping the ring enqueues the next one.

### The thought process

```text
We need    : fewest moves from source to target, all moves cost 1
Obvious way: enumerate every route and take the shortest
Too slow   : factorial — and it looks deep before it looks wide
Notice     : every edge costs the same, so "distance" = "number of layers"
Notice     : a FIFO queue pops in insertion order, and a node at distance d
             only ever inserts nodes at distance d+1
Therefore  : the queue is always sorted by distance, holding at most the
             values d and d+1 — nodes leave in non-decreasing distance order
Now        : the FIRST time a node is reached is via a shortest path.
             Mark it, never look at it again → O(V + E).
```

### Why the FIFO order guarantees shortest paths

**The invariant:** at every moment the queue contains only nodes at distance `d` followed by nodes at distance `d+1`, for some `d`.

It starts true (only the source, distance 0). Popping a node of distance `d` can only append nodes of distance `d+1`, which go to the **back** — behind every `d` still waiting and among the existing `d+1`s. The invariant survives. Therefore nodes are dequeued in **non-decreasing distance order**.

That single fact is the whole pattern: since distances only ever grow as you pop, the first time a node is discovered you already hold its minimum distance. There is nothing to compare, nothing to relax, nothing to revisit.

**This breaks the moment edges have different weights.** With a weight-5 edge and a weight-1 edge, a "1 hop" node can be farther than a "2 hop" node, the queue is no longer sorted by distance, and you need Dijkstra's priority queue instead. BFS's speed is bought entirely with the equal-weight assumption.

**Processing level by level.** Sometimes you need the rings themselves (level-order traversal, "how many minutes"). Snapshot the queue length *before* the inner loop:

```text
size := len(queue)          ← freeze the ring boundary HERE
for i := 0; i < size; i++ { ← pop exactly the current ring
    ... pop, record, enqueue children (which land beyond `size`) ...
}
```

Reading `len(queue)` inside the loop condition instead would keep swallowing the children you just appended, and every level would merge into one.

**Mark visited on ENQUEUE, never on dequeue.** This is the single most common BFS bug. Consider node `E` reachable from `B`, `C` and `D`, all in the same ring:

```text
        B
      /   \
  A - C  -  E
      \   /
        D

marking at DEQUEUE:
  pop A → enqueue B, C, D          queue = [B, C, D]
  pop B → E not marked → enqueue   queue = [C, D, E]
  pop C → E STILL not marked → enqueue   queue = [D, E, E]
  pop D → E STILL not marked → enqueue   queue = [E, E, E]
  E is now expanded three times, and each of ITS neighbours gets
  triple-queued in turn → the queue grows multiplicatively per level.

marking at ENQUEUE:
  pop A → enqueue B, C, D (mark all three)
  pop B → mark E, enqueue          queue = [C, D, E]
  pop C → E already marked → skip
  pop D → E already marked → skip
  E enters the queue exactly once.
```

Marking at enqueue is what makes the queue hold ≤ V nodes and the whole traversal O(V + E). Correctness is unaffected either way — the *first* arrival is still shortest — but the cost is not.

### Steps

```text
Step 1 → dist[source] = 0; mark source; queue = [source]
Step 2 → while the queue is non-empty:
Step 3 →   (optional) size := len(queue) to process one whole level
Step 4 →   node := pop the FRONT
Step 5 →   for each neighbour not yet marked:
Step 6 →       mark it NOW, set dist[neighbour] = dist[node] + 1, push to back
Step 7 → the first time target is marked, dist[target] is the answer
```

### How should I recognize this?

```text
If you see...
  "minimum number of steps / moves / transformations / mutations"
  "shortest path" with no edge weights (or all weights equal)
  "level order", "level by level", "each minute/round everything spreads"
  a grid where you move to the 4 or 8 adjacent cells
        ↓
Think about...
  "Do all moves cost the same?"
     yes → BFS.        no → Dijkstra (priority queue) or 0-1 BFS.
  "Do I need the rings themselves, or just a distance?"
     rings → snapshot len(queue).   distance → keep a dist array.
        ↓
Use...
  a FIFO queue, marking visited at ENQUEUE
    · single start                → seed the queue with one node
    · everything spreads at once  → multi-source BFS: seed ALL sources at
                                    distance 0 (rotting oranges, walls & gates)
    · edges weigh 0 or 1          → 0-1 BFS: deque, push-front for 0, back for 1
    · both endpoints known        → bidirectional BFS to halve the frontier
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bfs-42" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">BFS: a FIFO queue expands the frontier level by level</text>
  <!-- tree -->
  <text x="18" y="70" fill="#64748b">L0</text>
  <text x="18" y="135" fill="#64748b">L1</text>
  <text x="18" y="200" fill="#64748b">L2</text>
  <line x1="110" y1="80" x2="72" y2="120" stroke="#475569"/>
  <line x1="110" y1="80" x2="160" y2="120" stroke="#475569"/>
  <line x1="70" y1="146" x2="49" y2="185" stroke="#475569"/>
  <line x1="70" y1="146" x2="95" y2="185" stroke="#475569"/>
  <line x1="162" y1="146" x2="162" y2="185" stroke="#475569"/>
  <circle cx="110" cy="65" r="18" fill="#ecfdf5" stroke="#059669"/><text x="110" y="70" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="70" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="70" y="135" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="162" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="162" y="135" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="47" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="47" y="200" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="97" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="97" y="200" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="162" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="162" y="200" text-anchor="middle" fill="#1e293b">6</text>
  <!-- queue popped level by level -->
  <line x1="300" y1="52" x2="300" y2="200" stroke="#475569" marker-end="url(#bfs-42)"/>
  <text x="300" y="222" text-anchor="middle" fill="#64748b">pop order</text>
  <text x="325" y="72" fill="#64748b">L0</text>
  <rect x="358" y="52" width="34" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="375" y="72" text-anchor="middle" fill="#1e293b">1</text>
  <text x="325" y="125" fill="#64748b">L1</text>
  <rect x="358" y="105" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="375" y="125" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="398" y="105" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="415" y="125" text-anchor="middle" fill="#1e293b">3</text>
  <text x="325" y="178" fill="#64748b">L2</text>
  <rect x="358" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="375" y="178" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="398" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="415" y="178" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="438" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="455" y="178" text-anchor="middle" fill="#1e293b">6</text>
  <text x="560" y="116" text-anchor="middle" fill="#64748b">dequeue front,</text>
  <text x="560" y="134" text-anchor="middle" fill="#64748b">enqueue its children</text>
</svg>
```

```text
doors: 0-1, 1-2, 2-4, 0-3, 3-4        source = 0

pop      queue after pop     newly marked (dist)      ring
────────────────────────────────────────────────────────────
 —       [0]                 0 (dist 0)               L0
 0       [1, 3]              1 (dist 1), 3 (dist 1)   L1
 1       [3, 2]              2 (dist 2)
 3       [2, 4]              4 (dist 2)   ← target!   L2
 2       [4]                 (1 and 4 already marked)
 4       []                  —

dist = [0, 1, 2, 1, 2]        answer: 0 → 4 in 2 doors  (0 → 3 → 4)

The queue never held a distance-2 node ahead of a distance-1 node:
        [1, 3]  →  [3, 2]  →  [2, 4]
         1  1       1  2       2  2
That ordering IS the proof.
```

### Interview explanation
"All the moves cost the same, so I don't need to compare routes — I can expand outward one ring at a time with a FIFO queue. A node at distance `d` only ever enqueues nodes at distance `d+1`, and those go to the back, so the queue stays sorted by distance and nodes come out in non-decreasing distance order. That means the first time I reach a node I already have its shortest distance, so I mark it and never revisit it. I mark visited at *enqueue* time, not dequeue, otherwise the same node gets queued once per parent and the queue blows up. If I need levels I snapshot `len(queue)` before draining a level. It's O(V + E) time and O(V) space."

---

## 5. Generic Templates

> One FIFO queue; mark on enqueue; snapshot `len(queue)` when you need the rings.

```go
// bfsDistances returns the fewest edges from source to every node of an
// unweighted graph, or -1 for unreachable nodes.
func bfsDistances(adj [][]int, source int) []int {
	dist := make([]int, len(adj))
	for i := range dist {
		dist[i] = -1 // -1 doubles as "not yet seen"
	}
	dist[source] = 0
	queue := []int{source}
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		for _, next := range adj[node] {
			if dist[next] == -1 { // mark at ENQUEUE, never at dequeue
				dist[next] = dist[node] + 1
				queue = append(queue, next)
			}
		}
	}
	return dist
}

// bfsLevels groups nodes by distance: levels[d] holds every node d edges away.
func bfsLevels(adj [][]int, source int) [][]int {
	seen := make([]bool, len(adj))
	seen[source] = true
	queue := []int{source}
	levels := [][]int{}
	for len(queue) > 0 {
		size := len(queue) // freeze the ring boundary BEFORE draining it
		level := make([]int, 0, size)
		for i := 0; i < size; i++ {
			node := queue[0]
			queue = queue[1:]
			level = append(level, node)
			for _, next := range adj[node] {
				if !seen[next] {
					seen[next] = true
					queue = append(queue, next)
				}
			}
		}
		levels = append(levels, level)
	}
	return levels
}
```

```python
from collections import deque


def bfs_distances(adj, source):
    """Fewest edges from source to every node; -1 means unreachable."""
    dist = [-1] * len(adj)               # -1 doubles as "not yet seen"
    dist[source] = 0
    queue = deque([source])
    while queue:
        node = queue.popleft()
        for nxt in adj[node]:
            if dist[nxt] == -1:          # mark at ENQUEUE, never at dequeue
                dist[nxt] = dist[node] + 1
                queue.append(nxt)
    return dist


def bfs_levels(adj, source):
    """levels[d] holds every node exactly d edges from source."""
    seen = [False] * len(adj)
    seen[source] = True
    queue, levels = deque([source]), []
    while queue:
        size = len(queue)                # freeze the ring boundary
        level = []
        for _ in range(size):
            node = queue.popleft()
            level.append(node)
            for nxt in adj[node]:
                if not seen[nxt]:
                    seen[nxt] = True
                    queue.append(nxt)
        levels.append(level)
    return levels
```

```java
// Fewest edges from source to every node; -1 means unreachable.
int[] bfsDistances(List<List<Integer>> adj, int source) {
    int[] dist = new int[adj.size()];
    Arrays.fill(dist, -1);                       // -1 doubles as "not yet seen"
    dist[source] = 0;
    Deque<Integer> queue = new ArrayDeque<>();
    queue.offer(source);
    while (!queue.isEmpty()) {
        int node = queue.poll();
        for (int next : adj.get(node)) {
            if (dist[next] == -1) {              // mark at ENQUEUE
                dist[next] = dist[node] + 1;
                queue.offer(next);
            }
        }
    }
    return dist;
}

// levels.get(d) holds every node exactly d edges from source.
List<List<Integer>> bfsLevels(List<List<Integer>> adj, int source) {
    boolean[] seen = new boolean[adj.size()];
    seen[source] = true;
    Deque<Integer> queue = new ArrayDeque<>();
    queue.offer(source);
    List<List<Integer>> levels = new ArrayList<>();
    while (!queue.isEmpty()) {
        int size = queue.size();                 // freeze the ring boundary
        List<Integer> level = new ArrayList<>(size);
        for (int i = 0; i < size; i++) {
            int node = queue.poll();
            level.add(node);
            for (int next : adj.get(node)) {
                if (!seen[next]) {
                    seen[next] = true;
                    queue.offer(next);
                }
            }
        }
        levels.add(level);
    }
    return levels;
}
```

```cpp
// Fewest edges from source to every node; -1 means unreachable.
vector<int> bfsDistances(const vector<vector<int>>& adj, int source) {
    vector<int> dist(adj.size(), -1);            // -1 doubles as "not yet seen"
    dist[source] = 0;
    deque<int> queue{source};
    while (!queue.empty()) {
        int node = queue.front(); queue.pop_front();
        for (int next : adj[node]) {
            if (dist[next] == -1) {              // mark at ENQUEUE
                dist[next] = dist[node] + 1;
                queue.push_back(next);
            }
        }
    }
    return dist;
}

// levels[d] holds every node exactly d edges from source.
vector<vector<int>> bfsLevels(const vector<vector<int>>& adj, int source) {
    vector<bool> seen(adj.size(), false);
    seen[source] = true;
    deque<int> queue{source};
    vector<vector<int>> levels;
    while (!queue.empty()) {
        int size = (int)queue.size();            // freeze the ring boundary
        vector<int> level;
        for (int i = 0; i < size; ++i) {
            int node = queue.front(); queue.pop_front();
            level.push_back(node);
            for (int next : adj[node]) {
                if (!seen[next]) {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
        levels.push_back(level);
    }
    return levels;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | BFS Queue Pattern (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(k)** |

> Each element enters/leaves the deque once; BFS visits each node/edge once.

---

## 7. Common Mistakes

1. Storing values instead of indices, so you can't evict by position.
2. Forgetting to evict indices that fell out of the window.
3. Wrong deque monotonicity for min vs max.
4. Emitting results before the first full window forms.
5. BFS: not marking nodes visited when enqueuing (causes revisits/TLE).
6. BFS: marking visited at dequeue time, allowing duplicates in the queue.
7. Mixing level boundaries in level-order BFS.
8. Using a list as a queue with O(n) pops from the front.
9. Off-by-one in window eviction condition.
10. Not handling k larger than the array length.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a deque for window max?**
   A: It keeps a decreasing sequence of candidates; the front is always the max.

2. **Q: Amortized cost?**
   A: Each index is pushed and popped at most once → O(n).

3. **Q: Window minimum?**
   A: Same idea with an increasing deque.

4. **Q: BFS vs DFS for shortest path?**
   A: BFS gives shortest path in unweighted graphs.

5. **Q: Multi-source BFS?**
   A: Seed the queue with all sources at distance 0.

6. **Q: 0-1 BFS?**
   A: Use a deque: push front for 0-weight, back for 1-weight edges.

7. **Q: Level-order traversal?**
   A: Process the queue in size-batches per level.

8. **Q: Why mark visited at enqueue?**
   A: Prevents the same node being queued multiple times.

9. **Q: Shortest subarray with sum >= K (negatives)?**
   A: Monotonic deque on prefix sums.

10. **Q: Space complexity?**
   A: O(k) for the window / O(V) for BFS frontier.

11. **Q: Deque vs heap for window max?**
   A: Deque is O(n); heap is O(n log k).

12. **Q: Rotting oranges / spread problems?**
   A: Multi-source BFS by time layers.

13. **Q: Word ladder?**
   A: BFS over word-transformation graph.

14. **Q: Bidirectional BFS?**
   A: Search from both ends to cut the frontier.

15. **Q: Queue overflow in huge graphs?**
   A: Stream/iterative deepening or external memory.

---

## 9. Solved Example 1

### Problem — Level Order (LeetCode 102)
Given the root of a binary tree, return its node values grouped level by level, top to bottom and left to right within each level.

### Thought Process
1. "Level" means "distance from the root", and every parent→child step costs 1 — so this is BFS.
2. A plain BFS gives the right *order* but flattens everything into one list; we need the ring boundaries.
3. Snapshot `size := len(queue)` at the top of each outer iteration: those are exactly the nodes of the current level.
4. Drain exactly `size` nodes, appending each child to the back — children land *beyond* the snapshot, so they belong to the next level.
5. Push the collected level onto the result and repeat until the queue is empty.

### Dry Run

Input: `root = [3,9,20,null,null,15,7]`

```text
        3
      /   \
     9     20
          /  \
        15    7
```

| outer pass | `size` snapshot | nodes popped | children enqueued | queue after pass | level emitted |
|------------|-----------------|--------------|-------------------|------------------|---------------|
| 1 | 1 | `3` | `9`, `20` | `[9, 20]` | `[3]` |
| 2 | 2 | `9`, `20` | `9` has none; `20` → `15`, `7` | `[15, 7]` | `[9, 20]` |
| 3 | 2 | `15`, `7` | none (both leaves) | `[]` | `[15, 7]` |

Output: **`[[3],[9,20],[15,7]]`**

Pass 2 is the row that justifies the snapshot. When `20` is popped, the queue already holds nothing else from level 1 but is about to receive `15` and `7`. Because `size` was frozen at `2` *before* the pass began, those two are not swallowed into level 2 — the loop stops after exactly two pops.

### Visualization

```text
queue evolution   ( | marks the frozen level boundary )

start        [ 3 | ]
pass 1       pop 3, push 9, 20        →  [ 9  20 | ]      level = [3]
pass 2       pop 9   (no children)
             pop 20, push 15, 7       →  [ 15  7 | ]      level = [9, 20]
pass 3       pop 15, pop 7            →  [ | ]            level = [15, 7]

if the loop condition read len(queue) instead of the frozen size:
   pass 1 would pop 3, then 9, then 20, then 15, then 7 — one giant level.
```

### Code

```go
// levelOrder returns a binary tree's values grouped level by level.
func levelOrder(root *TreeNode) [][]int {
	result := [][]int{}
	if root == nil {
		return result
	}
	queue := []*TreeNode{root}
	for len(queue) > 0 {
		size := len(queue) // freeze this level's node count
		level := make([]int, 0, size)
		for i := 0; i < size; i++ {
			node := queue[0]
			queue = queue[1:]
			level = append(level, node.Val)
			if node.Left != nil {
				queue = append(queue, node.Left)
			}
			if node.Right != nil {
				queue = append(queue, node.Right)
			}
		}
		result = append(result, level)
	}
	return result
}
```

```python
from collections import deque


def level_order(root):
    if root is None:
        return []
    result, queue = [], deque([root])
    while queue:
        size = len(queue)                # freeze this level's node count
        level = []
        for _ in range(size):
            node = queue.popleft()
            level.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        result.append(level)
    return result
```

### Complexity
Time O(n) — every node is enqueued once and dequeued once. Space O(w) where `w` is the tree's maximum width, since the queue only ever holds one level (plus part of the next); for a perfect tree that is about `n/2`.

## 10. Solved Example 2

### Problem — Rotting Oranges (LeetCode 994)
In a grid, `0` is empty, `1` is a fresh orange and `2` is a rotten one. Each minute, every rotten orange rots its four-directionally adjacent fresh neighbours. Return the minutes until no fresh orange remains, or `-1` if that never happens.

### Thought Process
1. Rot spreads one cell per minute in all directions at once — that is BFS where **one level = one minute**.
2. There are many starting points, so seed the queue with *every* rotten cell at distance 0: multi-source BFS.
3. Count the fresh oranges up front; that is the only bookkeeping needed to answer "-1 or not".
4. Each outer pass increments `minutes` and drains exactly the current frontier (`size` snapshot); rot each fresh neighbour by writing `2` **at enqueue time** so no cell is queued twice.
5. When the queue empties, `fresh > 0` means some oranges were unreachable → `-1`; otherwise return `minutes`.

### Dry Run

Input: `grid = [[2,1,1],[1,1,0],[0,1,1]]`, initial `fresh = 6`, queue `[(0,0)]`

| minute | frontier drained | newly rotted | fresh left | grid after |
|--------|------------------|--------------|------------|------------|
| 1 | `(0,0)` | `(0,1)`, `(1,0)` | 4 | `2 2 1 / 2 1 0 / 0 1 1` |
| 2 | `(1,0)`, `(0,1)` | `(1,1)`, `(0,2)` | 2 | `2 2 2 / 2 2 0 / 0 1 1` |
| 3 | `(1,1)`, `(0,2)` | `(2,1)` | 1 | `2 2 2 / 2 2 0 / 0 2 1` |
| 4 | `(2,1)` | `(2,2)` | 0 | `2 2 2 / 2 2 0 / 0 2 2` |

Output: **`4`**

Minute 3 shows why the `0` at `(1,2)` matters: `(2,2)` is *not* reachable from `(1,2)` — the rot has to go the long way round through `(2,1)`, which is exactly what BFS's ring expansion discovers without any special handling. Note also that `(1,1)` is adjacent to both `(1,0)` and `(0,1)`; because it is written to `2` the instant it is enqueued, only the first of those two enqueues it.

### Visualization

```text
minute 0        minute 1        minute 2        minute 3        minute 4
 2 1 1           2 2 1           2 2 2           2 2 2           2 2 2
 1 1 0           2 1 0           2 2 0           2 2 0           2 2 0
 0 1 1           0 1 1           0 1 1           0 2 1           0 2 2

frontier:        the ring of cells that turned rotten THIS minute
 [(0,0)]         [(0,1),(1,0)]   [(1,1),(0,2)]   [(2,1)]         [(2,2)]

each ring is one BFS level, and one level is one minute — that equivalence
is the whole trick.
```

### Code

```go
// orangesRotting returns the minutes until no fresh orange remains, or -1.
// It mutates grid, using the value 2 as the "visited" mark.
func orangesRotting(grid [][]int) int {
	if len(grid) == 0 || len(grid[0]) == 0 {
		return 0
	}
	rows, cols := len(grid), len(grid[0])
	queue := [][2]int{}
	fresh := 0
	for r := 0; r < rows; r++ { // multi-source: seed EVERY rotten cell
		for c := 0; c < cols; c++ {
			if grid[r][c] == 2 {
				queue = append(queue, [2]int{r, c})
			} else if grid[r][c] == 1 {
				fresh++
			}
		}
	}
	directions := [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}
	minutes := 0
	for len(queue) > 0 && fresh > 0 {
		minutes++
		size := len(queue) // one drained level == one minute
		for i := 0; i < size; i++ {
			cell := queue[0]
			queue = queue[1:]
			for _, d := range directions {
				nr, nc := cell[0]+d[0], cell[1]+d[1]
				if nr < 0 || nr >= rows || nc < 0 || nc >= cols || grid[nr][nc] != 1 {
					continue
				}
				grid[nr][nc] = 2 // mark at ENQUEUE so it is queued once
				fresh--
				queue = append(queue, [2]int{nr, nc})
			}
		}
	}
	if fresh > 0 {
		return -1
	}
	return minutes
}
```

```python
from collections import deque


def oranges_rotting(grid):
    if not grid or not grid[0]:
        return 0
    rows, cols = len(grid), len(grid[0])
    queue, fresh = deque(), 0
    for r in range(rows):                      # multi-source: seed every rotten cell
        for c in range(cols):
            if grid[r][c] == 2:
                queue.append((r, c))
            elif grid[r][c] == 1:
                fresh += 1

    minutes = 0
    while queue and fresh:
        minutes += 1
        for _ in range(len(queue)):            # one drained level == one minute
            r, c = queue.popleft()
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and grid[nr][nc] == 1:
                    grid[nr][nc] = 2           # mark at ENQUEUE
                    fresh -= 1
                    queue.append((nr, nc))
    return -1 if fresh else minutes
```

### Complexity
Time O(rows·cols) — each cell is enqueued at most once and inspects 4 neighbours. Space O(rows·cols) — worst case (an all-rotten grid) the initial queue holds every cell.

## 11. Solved Example 3

### Problem — Word Ladder (LeetCode 127)
Given `beginWord`, `endWord` and a dictionary `wordList`, return the number of words in the shortest transformation sequence from `beginWord` to `endWord`, where each step changes exactly one letter and every intermediate word must be in the dictionary. Return `0` if impossible.

### Thought Process
1. Build the graph implicitly: each dictionary word is a node, and two words are adjacent when they differ in exactly one letter.
2. Every transformation costs 1, so "shortest sequence" is BFS — no need to materialise the edges.
3. Generate a node's neighbours by trying `'a'..'z'` at each position and keeping the results that are still in the dictionary set.
4. **Delete a word from the set the moment you enqueue it.** The set doubles as the visited marker; deleting on enqueue stops the same word being queued once per parent.
5. Count words, not edges: start `steps = 1` and increment after each drained level; return `steps` when `endWord` is popped.

### Dry Run

Input: `beginWord = "hit"`, `endWord = "cog"`, `wordList = ["hot","dot","dog","lot","log","cog"]`

| steps | frontier drained | neighbours found in the set | removed from set | queue after |
|-------|------------------|------------------------------|------------------|-------------|
| 1 | `hit` | `hot` (`h_t` → `hot`) | `hot` | `[hot]` |
| 2 | `hot` | `dot`, `lot` | `dot`, `lot` | `[dot, lot]` |
| 3 | `dot`, `lot` | `dog` (from `dot`), `log` (from `lot`) | `dog`, `log` | `[dog, log]` |
| 4 | `dog`, `log` | `cog` (from `dog`); `log` finds `cog` already gone | `cog` | `[cog]` |
| 5 | `cog` | — equals `endWord` → **return 5** | — | — |

Output: **`5`** (`hit → hot → dot → dog → cog`)

Level 4 is the mark-on-enqueue rule earning its keep: both `dog` and `log` are one letter from `cog`. Because `cog` is deleted from the set the instant `dog` enqueues it, `log` finds nothing and `cog` enters the queue exactly once instead of twice.

### Visualization

```text
level 1        hit
                │  (one letter differs)
level 2        hot
              ╱    ╲
level 3    dot      lot
             │        │
level 4    dog      log
              ╲    ╱
level 5        cog        ← popped at steps = 5

both dog and log point at cog, but cog is removed from the dictionary
the first time it is enqueued, so it appears in the queue ONCE:

   queue at level 4 end:  [cog]        not  [cog, cog]
```

### Code

```go
// ladderLength returns the number of words in the shortest transformation
// sequence from beginWord to endWord, or 0 if none exists.
func ladderLength(beginWord string, endWord string, wordList []string) int {
	unvisited := make(map[string]bool, len(wordList))
	for _, w := range wordList {
		unvisited[w] = true
	}
	if !unvisited[endWord] {
		return 0
	}
	delete(unvisited, beginWord)
	queue := []string{beginWord}
	steps := 1
	for len(queue) > 0 {
		size := len(queue) // one level == one transformation
		for i := 0; i < size; i++ {
			word := queue[0]
			queue = queue[1:]
			if word == endWord {
				return steps
			}
			letters := []byte(word)
			for pos := 0; pos < len(letters); pos++ {
				original := letters[pos]
				for c := byte('a'); c <= 'z'; c++ {
					letters[pos] = c
					candidate := string(letters)
					if unvisited[candidate] {
						delete(unvisited, candidate) // mark at ENQUEUE
						queue = append(queue, candidate)
					}
				}
				letters[pos] = original
			}
		}
		steps++
	}
	return 0
}
```

```python
from collections import deque


def ladder_length(begin_word, end_word, word_list):
    unvisited = set(word_list)
    if end_word not in unvisited:
        return 0
    unvisited.discard(begin_word)
    queue, steps = deque([begin_word]), 1
    while queue:
        for _ in range(len(queue)):            # one level == one transformation
            word = queue.popleft()
            if word == end_word:
                return steps
            for pos in range(len(word)):
                for c in "abcdefghijklmnopqrstuvwxyz":
                    candidate = word[:pos] + c + word[pos + 1:]
                    if candidate in unvisited:
                        unvisited.remove(candidate)   # mark at ENQUEUE
                        queue.append(candidate)
        steps += 1
    return 0
```

### Complexity
Time O(N·L·26) where `N` is the dictionary size and `L` the word length — each word is expanded once, generating `26·L` candidate strings of length `L`. Space O(N·L) for the set and the queue.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 102 | Level Order | Easy | Core queues application |
| 994 | Rotting Oranges | Easy | Core queues application |
| 127 | Word Ladder | Medium | Core queues application |
| 542 | 01 Matrix | Medium | Core queues application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic deque (window max/min)**
- **FIFO BFS**
- **Multi-source BFS**
- **0-1 BFS**
- **Level-order traversal**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same BFS Queue Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** BFS Queue Pattern (Queues).
- **Signal:** bfs, queue, level order, shortest path, unweighted.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the BFS Queue Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: BFS Queue Pattern
FAMILY : Queues (Intermediate)
WHEN   : bfs, queue, level order, shortest path, unweighted
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 102, 994, 127, 542
```

---

*Part of the DSA Patterns Handbook — pattern 42 of 100.*
