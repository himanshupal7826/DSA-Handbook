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

### Intuition
Direct per-query computation or full recomputation — too slow for large/online workloads.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Network Flow pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Network Flow invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Network Flow      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Network Flow problem. I'll match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP. That brings the complexity down to Varies (often O(log n) per op) time and O(n) to O(n log n) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Advanced** family template. Adapt the comparison/condition to the specific problem.

```go
// Fenwick (Binary Indexed) Tree: prefix sums with point updates, O(log n).
type Fenwick struct{ tree []int }
func NewFenwick(n int) *Fenwick { return &Fenwick{make([]int, n+1)} }
func (f *Fenwick) Update(i, delta int) {
    for ; i < len(f.tree); i += i & (-i) { f.tree[i] += delta }
}
func (f *Fenwick) Query(i int) int { // prefix sum [1..i]
    s := 0
    for ; i > 0; i -= i & (-i) { s += f.tree[i] }
    return s
}
```

```python
class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)
    def update(self, i, delta):          # 1-indexed
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)
    def query(self, i):                  # prefix sum [1..i]
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s
```

```java
class Fenwick {
    long[] tree;
    Fenwick(int n) { tree = new long[n + 1]; }
    void update(int i, long d) { for (; i < tree.length; i += i & (-i)) tree[i] += d; }
    long query(int i) { long s = 0; for (; i > 0; i -= i & (-i)) s += tree[i]; return s; }
}
```

```cpp
struct Fenwick {
    vector<long long> tree;
    Fenwick(int n) : tree(n + 1, 0) {}
    void update(int i, long long d) { for (; i < (int)tree.size(); i += i & (-i)) tree[i] += d; }
    long long query(int i) { long long s = 0; for (; i > 0; i -= i & (-i)) s += tree[i]; return s; }
};
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

### Problem — Max Students (LeetCode 1349)
A representative **Network Flow** problem. The signal: max-flow / min-cut models matching, assignment, and capacity problems.

### Thought Process
1. Confirm the pattern via its recognition signals (max flow, min cut, dinic, ford fulkerson, bipartite matching).
2. Reach for the Network Flow template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Network Flow step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)
    def update(self, i, delta):          # 1-indexed
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)
    def query(self, i):                  # prefix sum [1..i]
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s
```

### Complexity
Time Varies (often O(log n) per op), Space O(n) to O(n log n). Build cost amortized over many fast queries/updates.

## 10. Solved Example 2

### Problem — Campus Bikes II (LeetCode 1066)
A representative **Network Flow** problem. The signal: max-flow / min-cut models matching, assignment, and capacity problems.

### Thought Process
1. Confirm the pattern via its recognition signals (max flow, min cut, dinic, ford fulkerson, bipartite matching).
2. Reach for the Network Flow template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Network Flow step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)
    def update(self, i, delta):          # 1-indexed
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)
    def query(self, i):                  # prefix sum [1..i]
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s
```

### Complexity
Time Varies (often O(log n) per op), Space O(n) to O(n log n). Build cost amortized over many fast queries/updates.

## 11. Solved Example 3

### Problem — Bipartite (LeetCode 785)
A representative **Network Flow** problem. The signal: max-flow / min-cut models matching, assignment, and capacity problems.

### Thought Process
1. Confirm the pattern via its recognition signals (max flow, min cut, dinic, ford fulkerson, bipartite matching).
2. Reach for the Network Flow template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Network Flow step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)
    def update(self, i, delta):          # 1-indexed
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)
    def query(self, i):                  # prefix sum [1..i]
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s
```

### Complexity
Time Varies (often O(log n) per op), Space O(n) to O(n log n). Build cost amortized over many fast queries/updates.


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
