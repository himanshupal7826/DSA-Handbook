# 99 · Tarjan Algorithm

> **One-liner:** One DFS with low-link values finds bridges, articulation points, SCCs.

---

## 1. Overview

### Definition
The **Tarjan Algorithm** pattern belongs to the *Advanced* family. One DFS with low-link values finds bridges, articulation points, SCCs.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
tarjan, bridges, articulation points, low link, dfs tree.

### Constraints
- Input size where the brute-force complexity would time out — the Tarjan Algorithm optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Tarjan Algorithm invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tarjan Algorithm is the upgrade.
- The wording maps onto: tarjan, bridges, articulation points, low link, dfs tree.

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
Redundant recomputation; does not exploit the structure the Tarjan Algorithm pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Tarjan Algorithm invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="tarjan-99" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">low-link on the DFS tree: a back edge lowers low; a tree edge with low(child) &gt; disc(u) is a bridge</text>
  <!-- tree edges -->
  <line x1="120" y1="72" x2="120" y2="127" stroke="#475569" stroke-width="2"/>
  <line x1="120" y1="145" x2="120" y2="200" stroke="#475569" stroke-width="2"/>
  <line x1="140" y1="140" x2="270" y2="200" stroke="#d97706" stroke-width="3"/>
  <!-- back edge 3 -> 1 (dashed) -->
  <path d="M105,205 C40,160 40,110 105,80" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-dasharray="5 4" marker-end="url(#tarjan-99)"/>
  <text x="45" y="145" text-anchor="middle" fill="#2563eb" font-weight="700">back edge</text>
  <!-- bridge label -->
  <text x="230" y="160" text-anchor="middle" fill="#d97706" font-weight="700">bridge</text>
  <!-- nodes with disc/low -->
  <circle cx="120" cy="72" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="76" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="120" cy="135" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="139" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="120" cy="210" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="214" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="285" cy="210" r="20" fill="#fff7ed" stroke="#d97706"/><text x="285" y="214" text-anchor="middle" fill="#1e293b">4</text>
  <text x="160" y="70" fill="#64748b">disc=1 low=1</text>
  <text x="160" y="135" fill="#64748b">disc=2 low=1</text>
  <text x="160" y="240" text-anchor="middle" fill="#64748b">disc=3 low=1</text>
  <text x="285" y="245" text-anchor="middle" fill="#d97706" font-weight="700">disc=4 low=4</text>
  <!-- explanation box -->
  <text x="470" y="90" text-anchor="middle" fill="#1e293b" font-weight="700">rule</text>
  <text x="470" y="115" text-anchor="middle" fill="#64748b">low(u) = min( disc(u),</text>
  <text x="470" y="133" text-anchor="middle" fill="#64748b">low(child), disc(back-target) )</text>
  <text x="470" y="165" text-anchor="middle" fill="#2563eb">3→1 back edge: low(3)=1</text>
  <text x="470" y="183" text-anchor="middle" fill="#2563eb">propagates up: low(2)=1</text>
  <text x="470" y="212" text-anchor="middle" fill="#d97706">edge 2-4: low(4)=4 &gt; disc(2)=2</text>
  <text x="470" y="230" text-anchor="middle" fill="#d97706" font-weight="700">so 2-4 is a bridge</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Tarjan Algorithm  : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Tarjan Algorithm problem. I'll match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP. That brings the complexity down to Varies (often O(log n) per op) time and O(n) to O(n log n) space — here's the template."

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

| Metric | Brute Force | Tarjan Algorithm (Optimal) |
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

### Problem — Critical Connections (LeetCode 1192)
A representative **Tarjan Algorithm** problem. The signal: one dfs with low-link values finds bridges, articulation points, sccs.

### Thought Process
1. Confirm the pattern via its recognition signals (tarjan, bridges, articulation points, low link, dfs tree).
2. Reach for the Tarjan Algorithm template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tarjan Algorithm step-by-step ]
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

### Problem — Min Days Disconnect (LeetCode 1568)
A representative **Tarjan Algorithm** problem. The signal: one dfs with low-link values finds bridges, articulation points, sccs.

### Thought Process
1. Confirm the pattern via its recognition signals (tarjan, bridges, articulation points, low link, dfs tree).
2. Reach for the Tarjan Algorithm template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tarjan Algorithm step-by-step ]
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

### Problem — Min Malware II (LeetCode 928)
A representative **Tarjan Algorithm** problem. The signal: one dfs with low-link values finds bridges, articulation points, sccs.

### Thought Process
1. Confirm the pattern via its recognition signals (tarjan, bridges, articulation points, low link, dfs tree).
2. Reach for the Tarjan Algorithm template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tarjan Algorithm step-by-step ]
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
| 1192 | Critical Connections | Easy | Core advanced application |
| 1568 | Min Days Disconnect | Easy | Core advanced application |
| 928 | Min Malware II | Medium | Core advanced application |
| Bridges |  | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tarjan Algorithm logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tarjan Algorithm (Advanced).
- **Signal:** tarjan, bridges, articulation points, low link, dfs tree.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tarjan Algorithm invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tarjan Algorithm
FAMILY : Advanced (Expert)
WHEN   : tarjan, bridges, articulation points, low link, dfs tree
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1192, 1568, 928, Bridges
```

---

*Part of the DSA Patterns Handbook — pattern 99 of 100.*
