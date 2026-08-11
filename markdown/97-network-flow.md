# 97 · Network Flow

> **One-liner:** Max-flow / min-cut models matching, assignment, and capacity problems.

---

## 1. Overview

### Definition
The **Network Flow** pattern belongs to the *Advanced* family. Max-flow / min-cut models matching, assignment, and capacity problems.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
max flow, min cut, dinic, ford fulkerson, bipartite matching.

### Constraints
- Input size where the brute-force complexity would time out — the Network Flow optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Network Flow invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Network Flow is the upgrade.
- The wording maps onto: max flow, min cut, dinic, ford fulkerson, bipartite matching.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How do I pair things up as well as possible — as many pairs as I can, or the cheapest set of pairs?"*

### Intuition
Try every way of pairing.

### Algorithm
1. Enumerate every subset of the possible pairs.
2. Discard any subset where a vertex is used twice.
3. Keep the largest (or cheapest) survivor.

### Complexity
- Time: **O(2^E)** over the edges, or **O(n!)** if you enumerate assignments directly.
- Space: O(n).

### Drawbacks
- `n!` is hopeless past about 11, and `2^E` is worse on dense graphs.
- It also misses the structural fact that makes matching tractable: a *locally* stuck matching can often be improved by **rerouting**, not by starting over. Enumerating whole matchings never notices that.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Grow a matching one pair at a time, and when a vertex has no free partner, look for an *augmenting path* that reshuffles existing pairs to make room.**

That reshuffling is the whole idea, and it is what separates matching from greedy pairing.

### The thought process

```text
We need    : the maximum (or cheapest) set of disjoint pairs.
Obvious way: enumerate all pairings.
Hopeless   : n! or 2^E.
Notice     : greedy pairing gets STUCK — but being stuck is not the
             same as being optimal. Existing pairs can be rearranged.
Therefore  : search for an alternating path that starts and ends at
             free vertices; flipping it grows the matching by one.
Now        : O(V x E) with Kuhn's algorithm.
```

### The augmenting path, and why flipping it works

An **augmenting path** alternates between edges *not* in the matching and edges *in* it, starting and ending at **unmatched** vertices:

```text
free ──not matched──▶ b ──matched──▶ a ──not matched──▶ free
```

Because it starts and ends free, such a path always has **one more** non-matching edge than matching edges. Flipping every edge along it — matched becomes unmatched and vice versa — therefore increases the matching size by exactly **one**, and no vertex ends up doubly matched because the path visits each at most once.

```text
before:   a ═══ b        (a matched to b)
          c     d        (c and d free)
          with edges c–b and a–d available

path:     c ── b ═══ a ── d          alternating, ends free at both sides
flip:     c ═══ b     a ═══ d        two pairs instead of one
```

**Berge's theorem** completes the argument: a matching is maximum **exactly when** no augmenting path exists. So "keep finding augmenting paths until none remain" is not a heuristic — it is a proof of optimality.

### First, is the graph even bipartite?

Matching algorithms of this kind need the vertices split into two sides with all edges crossing between them. That is testable in O(V + E): **2-colour** the graph with BFS or DFS, giving every neighbour the opposite colour. A conflict means an odd cycle, which means not bipartite.

```text
bipartite      →  Kuhn's / Hopcroft-Karp, and König's theorem applies
not bipartite  →  general matching (Blossom algorithm) — rarely needed in interviews
```

### The theorem that turns other problems into matching

**König's theorem** (bipartite graphs only):

```text
maximum matching  +  maximum independent set  =  number of vertices
```

So "choose the most items with no two conflicting" becomes "count the vertices, subtract the maximum matching" — provided the conflict graph is bipartite. That reduction is what Example 2 is built on, and it is the single most useful thing to remember from this chapter.

### Maximum versus minimum-cost

Two different questions, two different tools:

| Question | Technique | Cost |
|---|---|---|
| Most pairs possible | Kuhn's augmenting paths | O(V · E) |
| Most pairs, large graph | Hopcroft–Karp | O(E √V) |
| **Cheapest** perfect assignment | Hungarian algorithm | O(n³) |
| Cheapest assignment, `n ≤ 20` | **bitmask DP over assigned items** | O(2ⁿ · n) |
| General max flow | Dinic's / Edmonds–Karp | O(E²V) / O(V²E) |

For interview-sized inputs (`n ≤ 20`) the bitmask DP is far easier to write correctly than the Hungarian algorithm, and it is what Example 3 uses.

### Steps (Kuhn's maximum bipartite matching)

```text
Step 1 → matchedTo[right vertex] = -1 for all
Step 2 → For each left vertex u:
Step 3 →     mark all right vertices unseen
Step 4 →     if tryAugment(u): matching++
Step 5 →
Step 6 → tryAugment(u):
Step 7 →     for each right neighbour v of u:
Step 8 →         if v already seen this round: skip
Step 9 →         mark v seen
Step 10 →        if v is free, OR its current partner can be re-matched
                  elsewhere (recursive tryAugment):
Step 11 →            matchedTo[v] = u;  return true
Step 12 →    return false
```

The `seen` set must be reset **per left vertex**, not once globally — it exists to stop the search revisiting a right vertex within a single augmenting attempt.

### How should I recognize this?

```text
If you see...
  "assign each X to a Y", "maximum number of pairs", "minimum total cost
   of an assignment", "maximum items with no two conflicting"
  two distinct groups with edges only between them
        ↓
Think about...
  "Is this bipartite? Then max independent set = V - max matching."
  "Do I want the MOST pairs, or the CHEAPEST assignment?"
        ↓
Use...
  bipartite check → 2-colouring, O(V + E)
  most pairs      → Kuhn's augmenting paths
  cheapest, n<=20 → bitmask DP over which items are assigned
```

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="flow-97" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Max-flow: every edge shows flow/capacity; value = 5 = min cut</text>
  <!-- edges (flow/cap). saturated edges in orange -->
  <line x1="82" y1="140" x2="256" y2="80" stroke="#d97706" stroke-width="2.5" marker-end="url(#flow-97)"/>
  <text x="150" y="98" text-anchor="middle" fill="#d97706" font-weight="700">3/3</text>
  <line x1="82" y1="150" x2="256" y2="200" stroke="#d97706" stroke-width="2.5" marker-end="url(#flow-97)"/>
  <text x="150" y="196" text-anchor="middle" fill="#d97706" font-weight="700">2/2</text>
  <line x1="280" y1="98" x2="280" y2="182" stroke="#059669" stroke-width="2.5" marker-end="url(#flow-97)"/>
  <text x="298" y="145" text-anchor="middle" fill="#059669" font-weight="700">1/1</text>
  <line x1="304" y1="80" x2="478" y2="140" stroke="#d97706" stroke-width="2.5" marker-end="url(#flow-97)"/>
  <text x="410" y="98" text-anchor="middle" fill="#d97706" font-weight="700">2/2</text>
  <line x1="304" y1="200" x2="478" y2="150" stroke="#d97706" stroke-width="2.5" marker-end="url(#flow-97)"/>
  <text x="410" y="196" text-anchor="middle" fill="#d97706" font-weight="700">3/3</text>
  <!-- nodes -->
  <circle cx="65" cy="145" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="65" y="149" text-anchor="middle" fill="#1e293b" font-weight="700">s</text>
  <circle cx="280" cy="78" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="82" text-anchor="middle" fill="#1e293b" font-weight="700">a</text>
  <circle cx="280" cy="202" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="206" text-anchor="middle" fill="#1e293b" font-weight="700">b</text>
  <circle cx="495" cy="145" r="20" fill="#ecfdf5" stroke="#059669"/><text x="495" y="149" text-anchor="middle" fill="#1e293b" font-weight="700">t</text>
  <!-- min cut around source -->
  <line x1="120" y1="45" x2="175" y2="235" stroke="#b91c1c" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="565" y="120" text-anchor="middle" fill="#b91c1c" font-weight="700">min cut</text>
  <text x="565" y="138" text-anchor="middle" fill="#b91c1c">s→a + s→b</text>
  <text x="565" y="156" text-anchor="middle" fill="#b91c1c">= 3 + 2 = 5</text>
  <text x="320" y="248" text-anchor="middle" fill="#64748b">orange = saturated (flow = capacity); augment along residual paths until none remain</text>
</svg>
```

```text
left:  a   b        right:  x   y

start with the matching  a ═══ x

now try to match b, whose only neighbour is x (already taken):

    b ── x ═══ a ── y          alternating path, both ends free
    │            │
    free       free

flip every edge along it:

    b ═══ x      a ═══ y       matching grew from 1 to 2

the path had 2 non-matching edges and 1 matching edge —
one more non-matching, which is why flipping gains exactly one pair
```

### Interview explanation
"This is bipartite matching. A greedy pairing gets stuck, but being stuck isn't the same as being optimal — existing pairs can be rearranged. So I use Kuhn's algorithm: for each left vertex I search for an augmenting path, which alternates between unmatched and matched edges and has free vertices at both ends. Such a path always has one more unmatched edge than matched ones, so flipping every edge along it grows the matching by exactly one. Berge's theorem says a matching is maximum precisely when no augmenting path exists, so repeating until none is found is provably optimal, not a heuristic. That's O(V · E). The reason this matters beyond pairing is König's theorem: in a bipartite graph, maximum independent set equals the vertex count minus the maximum matching — so 'pick the most items with no two conflicting' reduces to a matching problem. If instead I needed the *cheapest* assignment rather than the most pairs, that's the Hungarian algorithm at O(n³), or for `n ≤ 20` a bitmask DP, which is much easier to get right."

---

## 5. Generic Templates

> 2-colour to confirm bipartiteness, then augment until stuck.

```go
// IsBipartite 2-colours the graph; a conflict means an odd cycle.
// It handles disconnected graphs by restarting at every uncoloured node.
func IsBipartite(graph [][]int) bool {
    const uncoloured = 0
    colour := make([]int, len(graph))

    for start := range graph {
        if colour[start] != uncoloured {
            continue
        }

        colour[start] = 1
        queue := []int{start}

        for len(queue) > 0 {
            node := queue[0]
            queue = queue[1:]

            for _, neighbour := range graph[node] {
                if colour[neighbour] == uncoloured {
                    colour[neighbour] = -colour[node] // the opposite side
                    queue = append(queue, neighbour)
                } else if colour[neighbour] == colour[node] {
                    return false // same side on both ends of an edge
                }
            }
        }
    }
    return true
}

// MaxBipartiteMatching runs Kuhn's algorithm. adjacency[u] lists the
// right-hand vertices reachable from left-hand vertex u.
func MaxBipartiteMatching(adjacency [][]int, rightCount int) int {
    matchedTo := make([]int, rightCount)
    for i := range matchedTo {
        matchedTo[i] = -1 // -1 means this right vertex is free
    }

    var seen []bool

    // tryAugment looks for an augmenting path starting at left vertex u.
    var tryAugment func(u int) bool
    tryAugment = func(u int) bool {
        for _, v := range adjacency[u] {
            if seen[v] {
                continue // already explored in THIS attempt
            }
            seen[v] = true

            // Either v is free, or its current partner can move elsewhere.
            if matchedTo[v] == -1 || tryAugment(matchedTo[v]) {
                matchedTo[v] = u
                return true
            }
        }
        return false
    }

    matching := 0
    for u := range adjacency {
        // Reset per left vertex: `seen` scopes ONE augmenting attempt.
        seen = make([]bool, rightCount)
        if tryAugment(u) {
            matching++
        }
    }
    return matching
}

// MinCostAssignment finds the cheapest way to give every worker a distinct
// task. cost[worker][task]. For n <= 20 this beats writing Hungarian.
func MinCostAssignment(cost [][]int) int {
    workers := len(cost)
    if workers == 0 {
        return 0
    }
    tasks := len(cost[0])
    full := (1 << tasks) - 1

    const unreachable = math.MaxInt32
    // best[mask] = cheapest way to assign the first popcount(mask) workers
    // using exactly the tasks in `mask`.
    best := make([]int, full+1)
    for i := range best {
        best[i] = unreachable
    }
    best[0] = 0

    for mask := 0; mask <= full; mask++ {
        if best[mask] == unreachable {
            continue
        }
        // The worker index is derivable from the mask — no need to store it.
        worker := bits.OnesCount(uint(mask))
        if worker >= workers {
            continue
        }

        for task := 0; task < tasks; task++ {
            if mask&(1<<task) != 0 {
                continue // task already assigned
            }
            next := mask | (1 << task)
            if candidate := best[mask] + cost[worker][task]; candidate < best[next] {
                best[next] = candidate
            }
        }
    }

    // Any mask with exactly `workers` bits set is a complete assignment.
    answer := unreachable
    for mask := 0; mask <= full; mask++ {
        if bits.OnesCount(uint(mask)) == workers && best[mask] < answer {
            answer = best[mask]
        }
    }
    return answer
}
```

```python
from collections import deque

def is_bipartite(graph):
    """2-colour the graph; a conflict means an odd cycle."""
    colour = [0] * len(graph)               # 0 = uncoloured

    for start in range(len(graph)):
        if colour[start]:
            continue
        colour[start] = 1
        queue = deque([start])

        while queue:
            node = queue.popleft()
            for neighbour in graph[node]:
                if colour[neighbour] == 0:
                    colour[neighbour] = -colour[node]    # opposite side
                    queue.append(neighbour)
                elif colour[neighbour] == colour[node]:
                    return False                          # odd cycle
    return True

def max_bipartite_matching(adjacency, right_count):
    """Kuhn's algorithm: repeatedly find augmenting paths."""
    matched_to = [-1] * right_count         # -1 = free

    def try_augment(u, seen):
        for v in adjacency[u]:
            if v in seen:
                continue                    # already explored this attempt
            seen.add(v)
            # v is free, or its partner can be re-matched elsewhere.
            if matched_to[v] == -1 or try_augment(matched_to[v], seen):
                matched_to[v] = u
                return True
        return False

    matching = 0
    for u in range(len(adjacency)):
        if try_augment(u, set()):           # `seen` scopes ONE attempt
            matching += 1
    return matching

def min_cost_assignment(cost):
    """Cheapest assignment of workers to distinct tasks. n <= 20."""
    workers = len(cost)
    if workers == 0:
        return 0
    tasks = len(cost[0])
    full = (1 << tasks) - 1

    INF = float("inf")
    best = [INF] * (full + 1)
    best[0] = 0

    for mask in range(full + 1):
        if best[mask] == INF:
            continue
        worker = bin(mask).count("1")       # derivable — do not store it
        if worker >= workers:
            continue
        for task in range(tasks):
            if mask & (1 << task):
                continue
            nxt = mask | (1 << task)
            best[nxt] = min(best[nxt], best[mask] + cost[worker][task])

    return min(best[mask] for mask in range(full + 1)
               if bin(mask).count("1") == workers)
```

```java
import java.util.*;

public class BipartiteMatching {
    public static boolean isBipartite(int[][] graph) {
        int[] colour = new int[graph.length];
        for (int start = 0; start < graph.length; start++) {
            if (colour[start] != 0) continue;
            colour[start] = 1;
            Queue<Integer> queue = new ArrayDeque<>();
            queue.add(start);

            while (!queue.isEmpty()) {
                int node = queue.poll();
                for (int neighbour : graph[node]) {
                    if (colour[neighbour] == 0) {
                        colour[neighbour] = -colour[node];
                        queue.add(neighbour);
                    } else if (colour[neighbour] == colour[node]) {
                        return false;               // odd cycle
                    }
                }
            }
        }
        return true;
    }

    private static int[] matchedTo;
    private static boolean[] seen;
    private static List<List<Integer>> adj;

    public static int maxBipartiteMatching(List<List<Integer>> adjacency, int rightCount) {
        adj = adjacency;
        matchedTo = new int[rightCount];
        Arrays.fill(matchedTo, -1);

        int matching = 0;
        for (int u = 0; u < adjacency.size(); u++) {
            seen = new boolean[rightCount];         // reset per left vertex
            if (tryAugment(u)) matching++;
        }
        return matching;
    }

    private static boolean tryAugment(int u) {
        for (int v : adj.get(u)) {
            if (seen[v]) continue;
            seen[v] = true;
            if (matchedTo[v] == -1 || tryAugment(matchedTo[v])) {
                matchedTo[v] = u;
                return true;
            }
        }
        return false;
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

bool isBipartite(const vector<vector<int>>& graph) {
    vector<int> colour(graph.size(), 0);
    for (int start = 0; start < (int)graph.size(); ++start) {
        if (colour[start]) continue;
        colour[start] = 1;
        queue<int> q;
        q.push(start);

        while (!q.empty()) {
            int node = q.front();
            q.pop();
            for (int neighbour : graph[node]) {
                if (colour[neighbour] == 0) {
                    colour[neighbour] = -colour[node];
                    q.push(neighbour);
                } else if (colour[neighbour] == colour[node]) {
                    return false;                   // odd cycle
                }
            }
        }
    }
    return true;
}

vector<int> matchedTo;
vector<bool> seenRight;

bool tryAugment(const vector<vector<int>>& adjacency, int u) {
    for (int v : adjacency[u]) {
        if (seenRight[v]) continue;
        seenRight[v] = true;
        if (matchedTo[v] == -1 || tryAugment(adjacency, matchedTo[v])) {
            matchedTo[v] = u;
            return true;
        }
    }
    return false;
}

int maxBipartiteMatching(const vector<vector<int>>& adjacency, int rightCount) {
    matchedTo.assign(rightCount, -1);
    int matching = 0;
    for (int u = 0; u < (int)adjacency.size(); ++u) {
        seenRight.assign(rightCount, false);        // reset per left vertex
        if (tryAugment(adjacency, u)) ++matching;
    }
    return matching;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Network Flow (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **Varies (often O(log n) per op)** |
| Time (best)  | — | **Varies (often O(log n) per op)** |
| Time (average) | — | **Varies (often O(log n) per op)** |
| Space | varies | **O(n) to O(n log n)** |

> Build cost amortized over many fast queries/updates.

---

## 7. Common Mistakes

1. Mixing 0-indexed and 1-indexed conventions (Fenwick is 1-indexed).
2. Segment tree: wrong recursion bounds or lazy-propagation push-down.
3. Trie: not marking end-of-word, or leaking memory on delete.
4. Sparse table on a non-idempotent operation (sums need a different trick).
5. Bitmask DP exceeding memory for n > ~22.
6. Meet-in-the-middle: incorrect merge of the two halves.
7. Euler tour: off-by-one in in/out times.
8. Network flow: forgetting residual/back edges.
9. SCC/Tarjan: mishandling the low-link update and stack.
10. Mo's algorithm: wrong block size or add/remove ordering.

---

## 8. Interview Follow-Up Questions

1. **Q: Fenwick vs segment tree?**
   A: Fenwick is smaller/faster for prefix sums; segment tree is more general (min/max, lazy ranges).

2. **Q: Range update + range query?**
   A: Segment tree with lazy propagation, or two Fenwicks.

3. **Q: Trie use cases?**
   A: Prefix search, autocomplete, word dictionaries, XOR-maximization.

4. **Q: Sparse table limits?**
   A: O(1) queries but only static, idempotent operations (min/max/gcd).

5. **Q: Bitmask DP feasibility?**
   A: n ≲ 20–22 because of 2^n states.

6. **Q: Meet-in-the-middle when?**
   A: n ≲ 40 subset problems: split into 2^(n/2).

7. **Q: Euler tour purpose?**
   A: Flatten a tree so subtrees are contiguous ranges.

8. **Q: Heavy-light decomposition?**
   A: Path queries on trees via O(log n) chains + segment tree.

9. **Q: Max flow = min cut?**
   A: By the max-flow min-cut theorem; models matching/assignment.

10. **Q: SCC algorithms?**
   A: Tarjan (one DFS) or Kosaraju (two passes).

11. **Q: Bridges / articulation points?**
   A: Tarjan's low-link values in one DFS.

12. **Q: Mo's algorithm complexity?**
   A: O((n+q)√n) for offline range queries.

13. **Q: When is the build cost worth it?**
   A: When many queries/updates amortize the O(n log n) build.

14. **Q: Persistence?**
   A: Persistent segment trees answer historical-version queries.

15. **Q: Coordinate compression?**
   A: Map large/sparse keys to a dense index range first.

---

## 9. Solved Example 1

### Problem — Is Graph Bipartite? (LeetCode 785)
Given an undirected graph, determine whether its vertices can be split into two sets with every edge crossing between them.

### Thought Process
1. This is the prerequisite for everything else in the chapter: matching and König's theorem only apply to bipartite graphs.
2. "Splittable into two sides" is the same as "2-colourable": give every neighbour the opposite colour of its node.
3. BFS or DFS from an uncoloured node, colouring as you go. An edge whose endpoints already share a colour is a contradiction.
4. A colour conflict means an **odd cycle** — you cannot alternate colours around a cycle of odd length.
5. The graph may be disconnected, so restart from every still-uncoloured vertex.

### Dry Run — bipartite

Input: `graph = [[1,3], [0,2], [1,3], [0,2]]` — a 4-cycle `0–1–2–3–0`.

| step | node | neighbours | action | colours |
|------|------|------------|--------|---------|
| 1 | start at 0 | — | colour `+1` | `0:+1` |
| 2 | 0 | 1, 3 | both uncoloured → colour `−1` | `1:−1, 3:−1` |
| 3 | 1 | 0, 2 | `0` is `+1` (differs, fine); `2` uncoloured → `+1` | `2:+1` |
| 4 | 3 | 0, 2 | `0` is `+1` ✓; `2` is `+1` ✓ (differs from 3's `−1`) | — |
| 5 | 2 | 1, 3 | both `−1` ✓ | — |

Output: **`true`** ✓ — sides are `{0, 2}` and `{1, 3}`.

### Dry Run — not bipartite

Input: `graph = [[1,2,3], [0,2], [0,1,3], [0,2]]` — contains the triangle `0–1–2`.

| step | node | neighbour | check | result |
|------|------|-----------|-------|--------|
| 1 | 0 | — | colour `+1` | `0:+1` |
| 2 | 0 | 1 | uncoloured → `−1` | `1:−1` |
| 3 | 0 | 2 | uncoloured → `−1` | `2:−1` |
| 4 | 1 | 2 | `2` is `−1`, same as `1` | **conflict → `false`** |

Output: **`false`** ✓

The triangle is an odd cycle: going `0 → 1 → 2` forces the colours `+1, −1, +1`, but `2` is also adjacent to `0`, which is already `+1`. No 2-colouring exists.

### Visualization

```text
bipartite (4-cycle):        not bipartite (triangle):

   0 ─── 1                        0
   │     │                       / \
   3 ─── 2                      1───2

   +1   -1                     +1  -1
   -1   +1                        -1  ← 1 and 2 are adjacent
                                       and share a colour
   even cycle → alternates      odd cycle → impossible
```

### Code

```go
func isBipartite(graph [][]int) bool {
    const uncoloured = 0
    colour := make([]int, len(graph))

    // The graph may be disconnected, so try every vertex as a start.
    for start := range graph {
        if colour[start] != uncoloured {
            continue
        }

        colour[start] = 1
        queue := []int{start}

        for len(queue) > 0 {
            node := queue[0]
            queue = queue[1:]

            for _, neighbour := range graph[node] {
                if colour[neighbour] == uncoloured {
                    colour[neighbour] = -colour[node] // put it on the other side
                    queue = append(queue, neighbour)
                } else if colour[neighbour] == colour[node] {
                    // Both ends of an edge on the same side: an odd cycle.
                    return false
                }
            }
        }
    }
    return true
}
```

```python
from collections import deque

def isBipartite(graph):
    colour = [0] * len(graph)               # 0 = uncoloured

    for start in range(len(graph)):
        if colour[start]:
            continue                        # already handled
        colour[start] = 1
        queue = deque([start])

        while queue:
            node = queue.popleft()
            for neighbour in graph[node]:
                if colour[neighbour] == 0:
                    colour[neighbour] = -colour[node]    # the other side
                    queue.append(neighbour)
                elif colour[neighbour] == colour[node]:
                    return False            # odd cycle
    return True
```

### Complexity
Time **O(V + E)** — each vertex and edge is examined once. Space O(V).

---

## 10. Solved Example 2

### Problem — Maximum Students Taking Exam (LeetCode 1349)
Seat the maximum number of students in a classroom grid so that nobody can copy from the seats immediately left, right, upper-left or upper-right.

### Thought Process
1. Build a **conflict graph**: one vertex per usable seat, one edge per pair that would allow copying.
2. Seating the maximum number with no conflicts is exactly a **maximum independent set** — which is NP-hard in general.
3. But look at the conflicts: left, right, upper-left, upper-right all connect columns `c` and `c ± 1`, which always have **different parity**. So the graph is bipartite, split by column parity.
4. **König's theorem** then applies: `max independent set = vertices − max matching`.
5. So: count the usable seats, compute the maximum bipartite matching in the conflict graph with Kuhn's algorithm, and subtract.

### Dry Run

Input:

```text
row 0:  #  .  #  #  .  #
row 1:  .  #  #  #  #  .
row 2:  #  .  #  #  .  #
```

**Usable seats** (6 in total):

| seat | column parity |
|------|---------------|
| (0,1) | odd |
| (0,4) | even |
| (1,0) | even |
| (1,5) | odd |
| (2,1) | odd |
| (2,4) | even |

**Conflict edges** — only the four rules above, and every edge crosses the parity split:

| edge | reason |
|------|--------|
| (0,1) – (1,0) | (1,0)'s upper-right is (0,1) |
| (0,4) – (1,5) | (1,5)'s upper-left is (0,4) |
| (1,0) – (2,1) | (2,1)'s upper-left is (1,0) |
| (1,5) – (2,4) | (2,4)'s upper-right is (1,5) |

The graph is two disjoint paths of three vertices each:

```text
(0,1) ── (1,0) ── (2,1)          (0,4) ── (1,5) ── (2,4)
```

**Maximum matching:** a 3-vertex path admits exactly one edge, so each path contributes 1 → **matching = 2**.

**König:** `6 − 2` = **4**

Output: **4** ✓

Verify directly: seat students at (0,1), (0,4), (2,1), (2,4) — rows 0 and 2 only, leaving row 1 empty. No two are adjacent within a row, and rows 0 and 2 are not vertically adjacent, so no diagonal conflicts. Four students. ✓

**Why the bipartite check matters.** Maximum independent set is NP-hard for general graphs. It is only because every conflict edge joins columns of opposite parity that König's theorem turns this into a polynomial matching problem.

### Visualization

```text
       col: 0  1  2  3  4  5
   row 0:   #  S  #  #  S  #
   row 1:   .  ·  #  #  ·  .        · = usable but left empty
   row 2:   #  S  #  #  S  #

conflict graph (bipartite by column parity):

   odd side:   (0,1)      (1,5)      (2,1)
                 │          │          │
   even side:  (1,0)      (0,4)      (2,4)

   two paths of 3 vertices → max matching 2
   independent set = 6 vertices - 2 = 4        ★
```

### Code

```go
func maxStudents(seats [][]byte) int {
    rows := len(seats)
    if rows == 0 {
        return 0
    }
    cols := len(seats[0])

    // Number the usable seats; -1 means broken.
    id := make([][]int, rows)
    usable := 0
    for r := 0; r < rows; r++ {
        id[r] = make([]int, cols)
        for c := 0; c < cols; c++ {
            if seats[r][c] == '.' {
                id[r][c] = usable
                usable++
            } else {
                id[r][c] = -1
            }
        }
    }
    if usable == 0 {
        return 0
    }

    // Every conflict joins columns c and c±1, which have OPPOSITE parity —
    // so the conflict graph is bipartite, split by column parity.
    // Left side = even columns, right side = odd columns.
    leftIndex := make([]int, usable)
    rightIndex := make([]int, usable)
    leftCount, rightCount := 0, 0
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            if id[r][c] < 0 {
                continue
            }
            if c%2 == 0 {
                leftIndex[id[r][c]] = leftCount
                leftCount++
            } else {
                rightIndex[id[r][c]] = rightCount
                rightCount++
            }
        }
    }

    adjacency := make([][]int, leftCount)

    // The four copying directions, from an even-column seat to odd ones.
    offsets := [4][2]int{{0, -1}, {0, 1}, {-1, -1}, {-1, 1}}
    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c += 2 { // even columns only
            if id[r][c] < 0 {
                continue
            }
            from := leftIndex[id[r][c]]

            for _, offset := range offsets {
                nr, nc := r+offset[0], c+offset[1]
                if nr < 0 || nr >= rows || nc < 0 || nc >= cols {
                    continue
                }
                if id[nr][nc] < 0 {
                    continue
                }
                adjacency[from] = append(adjacency[from], rightIndex[id[nr][nc]])
            }
        }
    }

    // Konig: max independent set = vertices - max matching.
    return usable - kuhnMatching(adjacency, rightCount)
}

// kuhnMatching finds the maximum bipartite matching by repeatedly
// searching for augmenting paths.
func kuhnMatching(adjacency [][]int, rightCount int) int {
    matchedTo := make([]int, rightCount)
    for i := range matchedTo {
        matchedTo[i] = -1 // free
    }

    var seen []bool
    var tryAugment func(u int) bool
    tryAugment = func(u int) bool {
        for _, v := range adjacency[u] {
            if seen[v] {
                continue
            }
            seen[v] = true
            // v is free, or its partner can be re-matched elsewhere.
            if matchedTo[v] == -1 || tryAugment(matchedTo[v]) {
                matchedTo[v] = u
                return true
            }
        }
        return false
    }

    matching := 0
    for u := range adjacency {
        seen = make([]bool, rightCount) // reset per left vertex
        if tryAugment(u) {
            matching++
        }
    }
    return matching
}
```

```python
def maxStudents(seats):
    rows = len(seats)
    if rows == 0:
        return 0
    cols = len(seats[0])

    usable = [(r, c) for r in range(rows) for c in range(cols) if seats[r][c] == "."]
    if not usable:
        return 0

    # Conflicts join columns c and c±1 → opposite parity → bipartite.
    left = {seat: i for i, seat in enumerate(s for s in usable if s[1] % 2 == 0)}
    right = {seat: i for i, seat in enumerate(s for s in usable if s[1] % 2 == 1)}

    adjacency = [[] for _ in range(len(left))]
    for (r, c), u in left.items():
        for dr, dc in ((0, -1), (0, 1), (-1, -1), (-1, 1)):
            neighbour = (r + dr, c + dc)
            if neighbour in right:
                adjacency[u].append(right[neighbour])

    def kuhn():
        matched_to = [-1] * len(right)

        def try_augment(u, seen):
            for v in adjacency[u]:
                if v in seen:
                    continue
                seen.add(v)
                if matched_to[v] == -1 or try_augment(matched_to[v], seen):
                    matched_to[v] = u
                    return True
            return False

        return sum(try_augment(u, set()) for u in range(len(adjacency)))

    # Konig: max independent set = vertices - max matching.
    return len(usable) - kuhn()
```

### Complexity
Time **O(V · E)** for Kuhn's algorithm, where `V` is the number of usable seats and `E` the number of conflicts — at most `4V`, so effectively O(V²). Space O(V + E).

> The Bitmask DP chapter solves this same problem by sweeping row masks in O(rows · 4^cols). That version is easier to write; this one is more interesting, because the reduction to matching is what makes it scale to grids far too wide for a column mask.

---

## 11. Solved Example 3

### Problem — Campus Bikes II (LeetCode 1066)
Assign each worker a distinct bike, minimising the total Manhattan distance.

### Thought Process
1. This is the **assignment problem**: a minimum-cost perfect matching on a complete bipartite graph.
2. The Hungarian algorithm solves it in O(n³), but it is long and error-prone to write from memory.
3. With `n ≤ 10` a bitmask DP is far simpler and comfortably fast.
4. `best[mask]` = the cheapest way to assign the first `popcount(mask)` workers using exactly the bikes in `mask`.
5. The worker index is **derivable** from the mask, so it does not need to be part of the state — that is what keeps it `2ⁿ` rather than `2ⁿ · n`.

### Dry Run

Input: `workers = [[0,0], [2,1]]`, `bikes = [[1,2], [3,3]]`

**Distance matrix** (Manhattan):

| | bike 0 `(1,2)` | bike 1 `(3,3)` |
|---|---|---|
| **worker 0** `(0,0)` | `1 + 2 = 3` | `3 + 3 = 6` |
| **worker 1** `(2,1)` | `1 + 1 = 2` | `1 + 2 = 3` |

**The DP** — `best[mask]`, where the worker index is `popcount(mask)`:

| mask | bikes used | worker to assign | transitions | `best` |
|------|-----------|-------------------|-------------|--------|
| `00` | none | worker 0 | — | **0** |
| `01` | bike 0 | worker 1 | from `00` + cost(w0, b0) = `0 + 3` | **3** |
| `10` | bike 1 | worker 1 | from `00` + cost(w0, b1) = `0 + 6` | **6** |
| `11` | both | done | from `01` + cost(w1, b1) = `3 + 3` = **6**<br>from `10` + cost(w1, b0) = `6 + 2` = 8 | **6** |

Output: **6** ✓ — worker 0 takes bike 0 (cost 3) and worker 1 takes bike 1 (cost 3).

**A second case**, `workers = [[0,0], [1,1], [2,0]]`, `bikes = [[1,0], [2,2], [2,1]]`:

| | bike 0 | bike 1 | bike 2 |
|---|---|---|---|
| worker 0 `(0,0)` | 1 | 4 | 3 |
| worker 1 `(1,1)` | 1 | 2 | 1 |
| worker 2 `(2,0)` | 1 | 2 | 1 |

The optimum is `w0→b0 (1)`, `w1→b1 (2)`, `w2→b2 (1)` = **4** ✓

**Why the worker index is free.** At `mask = 01` exactly one bike is taken, so exactly one worker has been assigned — worker 0 — and the next to assign is worker 1. Storing it would double the state space for no information.

### Visualization

```text
workers            bikes
  w0 (0,0)  ────3────  b0 (1,2)
       \  6            /
        \             /  2
         \           /
  w1 (2,1)  ────3────  b1 (3,3)

  assignments:
     w0→b0, w1→b1  =  3 + 3 = 6      ★
     w0→b1, w1→b0  =  6 + 2 = 8

  DP over masks of USED BIKES; the worker index is popcount(mask)
```

### Code

```go
func assignBikes(workers [][]int, bikes [][]int) int {
    workerCount := len(workers)
    bikeCount := len(bikes)
    full := (1 << bikeCount) - 1

    distance := func(w, b int) int {
        dx := workers[w][0] - bikes[b][0]
        if dx < 0 {
            dx = -dx
        }
        dy := workers[w][1] - bikes[b][1]
        if dy < 0 {
            dy = -dy
        }
        return dx + dy
    }

    const unreachable = math.MaxInt32
    // best[mask] = cheapest assignment of the first popcount(mask) workers
    // using exactly the bikes in `mask`.
    best := make([]int, full+1)
    for i := range best {
        best[i] = unreachable
    }
    best[0] = 0

    for mask := 0; mask <= full; mask++ {
        if best[mask] == unreachable {
            continue
        }

        // The worker index is DERIVABLE from the mask, so it is not part
        // of the state — that keeps this 2^n rather than 2^n * n.
        worker := bits.OnesCount(uint(mask))
        if worker >= workerCount {
            continue // every worker already has a bike
        }

        for bike := 0; bike < bikeCount; bike++ {
            if mask&(1<<bike) != 0 {
                continue // bike already taken
            }
            next := mask | (1 << bike)
            if candidate := best[mask] + distance(worker, bike); candidate < best[next] {
                best[next] = candidate
            }
        }
    }

    // Any mask with exactly workerCount bits set is a complete assignment.
    answer := unreachable
    for mask := 0; mask <= full; mask++ {
        if bits.OnesCount(uint(mask)) == workerCount && best[mask] < answer {
            answer = best[mask]
        }
    }
    return answer
}
```

```python
def assignBikes(workers, bikes):
    worker_count, bike_count = len(workers), len(bikes)
    full = (1 << bike_count) - 1

    def distance(w, b):
        return abs(workers[w][0] - bikes[b][0]) + abs(workers[w][1] - bikes[b][1])

    INF = float("inf")
    best = [INF] * (full + 1)
    best[0] = 0

    for mask in range(full + 1):
        if best[mask] == INF:
            continue
        worker = bin(mask).count("1")       # derivable — not part of the state
        if worker >= worker_count:
            continue
        for bike in range(bike_count):
            if mask & (1 << bike):
                continue                    # bike already taken
            nxt = mask | (1 << bike)
            best[nxt] = min(best[nxt], best[mask] + distance(worker, bike))

    return min(best[mask] for mask in range(full + 1)
               if bin(mask).count("1") == worker_count)
```

### Complexity
Time **O(2^bikes · bikes)**, Space O(2^bikes). With `bikes ≤ 10` that is about 10,000 operations.

> The Hungarian algorithm gets this to O(n³), which matters when `n` runs into the hundreds. For interview-sized inputs the bitmask DP is the right trade: it is a dozen lines, and you can reason about its correctness on the spot.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1349 | Max Students | Easy | Core advanced application |
| 1066 | Campus Bikes II | Easy | Core advanced application |
| 785 | Bipartite | Medium | Core advanced application |
| Maximum | matching | Medium | Core advanced application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Trie**
- **Segment tree (+ lazy)**
- **Fenwick / BIT**
- **Sparse table**
- **Bitmask DP**
- **Meet in the middle**
- **Euler tour / HLD**
- **Max flow**
- **SCC / Tarjan**
- **Mo's algorithm**

---

## 14. Production Engineering Applications

- **Scalability:** These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n) to O(n log n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Network Flow logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Network Flow (Advanced).
- **Signal:** max flow, min cut, dinic, ford fulkerson, bipartite matching.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Network Flow invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Network Flow
FAMILY : Advanced (Expert)
WHEN   : max flow, min cut, dinic, ford fulkerson, bipartite matching
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1349, 1066, 785, Maximum
```

---

*Part of the DSA Patterns Handbook — pattern 97 of 100.*
