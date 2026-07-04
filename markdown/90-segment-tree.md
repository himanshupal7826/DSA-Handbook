# 90 · Segment Tree

> **One-liner:** Tree over ranges for O(log n) range queries and updates.

---

## 1. Overview

### Definition
The **Segment Tree** pattern belongs to the *Advanced* family. Tree over ranges for O(log n) range queries and updates.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
segment tree, range query, range update, lazy propagation, point update.

### Constraints
- Input size where the brute-force complexity would time out — the Segment Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Segment Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Segment Tree is the upgrade.
- The wording maps onto: segment tree, range query, range update, lazy propagation, point update.

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
Redundant recomputation; does not exploit the structure the Segment Tree pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Segment Tree invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="st-90" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Segment tree over [2,1,5,3] &amp; query sum(1,3) = 9</text>
  <!-- edges -->
  <line x1="320" y1="58" x2="180" y2="108" stroke="#475569"/>
  <line x1="320" y1="58" x2="460" y2="108" stroke="#475569"/>
  <line x1="180" y1="130" x2="110" y2="176" stroke="#475569"/>
  <line x1="180" y1="130" x2="250" y2="176" stroke="#475569"/>
  <line x1="460" y1="130" x2="390" y2="176" stroke="#475569"/>
  <line x1="460" y1="130" x2="530" y2="176" stroke="#475569"/>
  <!-- root [0,3]=11 -->
  <rect x="278" y="38" width="84" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="60" text-anchor="middle" fill="#1e293b">[0,3]=11</text>
  <!-- [0,1]=3 -->
  <rect x="138" y="110" width="84" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="132" text-anchor="middle" fill="#1e293b">[0,1]=3</text>
  <!-- [2,3]=8 covers query fully -->
  <rect x="418" y="110" width="84" height="34" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="460" y="132" text-anchor="middle" fill="#1e293b">[2,3]=8</text>
  <!-- leaves -->
  <rect x="72"  y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="110" y="200" text-anchor="middle" fill="#1e293b">[0]=2</text>
  <rect x="212" y="178" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="250" y="200" text-anchor="middle" fill="#1e293b">[1]=1</text>
  <rect x="352" y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="390" y="200" text-anchor="middle" fill="#1e293b">[2]=5</text>
  <rect x="492" y="178" width="76" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="530" y="200" text-anchor="middle" fill="#1e293b">[3]=3</text>
  <text x="320" y="240" text-anchor="middle" fill="#059669" font-weight="700">green nodes [1,1]=1 &amp; [2,3]=8 fully cover the range ──▶ 1 + 8 = 9 (O(log n))</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Segment Tree      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Segment Tree problem. I'll match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP. That brings the complexity down to Varies (often O(log n) per op) time and O(n) to O(n log n) space — here's the template."

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

| Metric | Brute Force | Segment Tree (Optimal) |
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

### Problem — Range Sum Mutable (LeetCode 307)
A representative **Segment Tree** problem. The signal: tree over ranges for o(log n) range queries and updates.

### Thought Process
1. Confirm the pattern via its recognition signals (segment tree, range query, range update, lazy propagation, point update).
2. Reach for the Segment Tree template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Segment Tree step-by-step ]
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

### Problem — Count Smaller (LeetCode 315)
A representative **Segment Tree** problem. The signal: tree over ranges for o(log n) range queries and updates.

### Thought Process
1. Confirm the pattern via its recognition signals (segment tree, range query, range update, lazy propagation, point update).
2. Reach for the Segment Tree template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Segment Tree step-by-step ]
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

### Problem — Skyline (LeetCode 218)
A representative **Segment Tree** problem. The signal: tree over ranges for o(log n) range queries and updates.

### Thought Process
1. Confirm the pattern via its recognition signals (segment tree, range query, range update, lazy propagation, point update).
2. Reach for the Segment Tree template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Segment Tree step-by-step ]
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
| 307 | Range Sum Mutable | Easy | Core advanced application |
| 315 | Count Smaller | Easy | Core advanced application |
| 218 | Skyline | Medium | Core advanced application |
| 699 | Falling Squares | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Segment Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Segment Tree (Advanced).
- **Signal:** segment tree, range query, range update, lazy propagation, point update.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Segment Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Segment Tree
FAMILY : Advanced (Expert)
WHEN   : segment tree, range query, range update, lazy propagation, point update
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 307, 315, 218, 699
```

---

*Part of the DSA Patterns Handbook — pattern 90 of 100.*
