# 96 · Heavy Light Decomposition

> **One-liner:** Decompose tree paths into O(log n) chains for path queries.

---

## 1. Overview

### Definition
The **Heavy Light Decomposition** pattern belongs to the *Advanced* family. Decompose tree paths into O(log n) chains for path queries.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
heavy light, hld, path query, tree chains, segment tree on tree.

### Constraints
- Input size where the brute-force complexity would time out — the Heavy Light Decomposition optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Heavy Light Decomposition invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Heavy Light Decomposition is the upgrade.
- The wording maps onto: heavy light, hld, path query, tree chains, segment tree on tree.

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
Redundant recomputation; does not exploit the structure the Heavy Light Decomposition pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Heavy Light Decomposition invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="hld-96" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Heavy edges (bold) form chains; each chain maps to a contiguous segment-tree range</text>
  <!-- heavy edges (bold green) -->
  <line x1="90" y1="55" x2="90" y2="115" stroke="#059669" stroke-width="4"/>
  <line x1="90" y1="115" x2="90" y2="175" stroke="#059669" stroke-width="4"/>
  <line x1="90" y1="175" x2="90" y2="235" stroke="#059669" stroke-width="4"/>
  <line x1="200" y1="115" x2="200" y2="175" stroke="#059669" stroke-width="4"/>
  <!-- light edge (thin dashed) -->
  <line x1="90" y1="55" x2="200" y2="115" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="150" y="82" text-anchor="middle" fill="#94a3b8">light</text>
  <circle cx="90" cy="55" r="16" fill="#ecfdf5" stroke="#059669"/><text x="90" y="59" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="90" cy="115" r="16" fill="#ecfdf5" stroke="#059669"/><text x="90" y="119" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="90" cy="175" r="16" fill="#ecfdf5" stroke="#059669"/><text x="90" y="179" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="90" cy="235" r="16" fill="#ecfdf5" stroke="#059669"/><text x="90" y="239" text-anchor="middle" fill="#1e293b">6</text>
  <circle cx="200" cy="115" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="119" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="200" cy="175" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="179" text-anchor="middle" fill="#1e293b">5</text>
  <text x="145" y="260" text-anchor="middle" fill="#059669" font-weight="700">chain A = 1-2-4-6</text>
  <text x="230" y="215" text-anchor="middle" fill="#2563eb" font-weight="700">chain B = 3-5</text>
  <!-- flattened base array by chains -->
  <text x="470" y="70" text-anchor="middle" fill="#64748b" font-weight="700">base array (chains laid end to end)</text>
  <rect x="330" y="85" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="352" y="110" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="374" y="85" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="396" y="110" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="418" y="85" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="440" y="110" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="462" y="85" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="484" y="110" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="518" y="85" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="540" y="110" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="562" y="85" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="584" y="110" text-anchor="middle" fill="#1e293b">5</text>
  <text x="418" y="150" text-anchor="middle" fill="#059669">chain A range</text>
  <text x="562" y="150" text-anchor="middle" fill="#2563eb">chain B</text>
  <text x="470" y="200" text-anchor="middle" fill="#1e293b" font-weight="700">path 6 → 3 climbs chain A then jumps one light edge</text>
  <line x1="360" y1="215" x2="580" y2="215" stroke="#475569" marker-end="url(#hld-96)"/>
  <text x="470" y="240" text-anchor="middle" fill="#64748b">any root-to-node path crosses O(log n) chains</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Heavy Light Decomp: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Heavy Light Decomposition problem. I'll match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP. That brings the complexity down to Varies (often O(log n) per op) time and O(n) to O(n log n) space — here's the template."

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

| Metric | Brute Force | Heavy Light Decomposition (Optimal) |
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

### Problem — Game on Tree (LeetCode 2467)
A representative **Heavy Light Decomposition** problem. The signal: decompose tree paths into o(log n) chains for path queries.

### Thought Process
1. Confirm the pattern via its recognition signals (heavy light, hld, path query, tree chains, segment tree on tree).
2. Reach for the Heavy Light Decomposition template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Heavy Light Decomposition step-by-step ]
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

### Problem — Build Rooms (LeetCode 1916)
A representative **Heavy Light Decomposition** problem. The signal: decompose tree paths into o(log n) chains for path queries.

### Thought Process
1. Confirm the pattern via its recognition signals (heavy light, hld, path query, tree chains, segment tree on tree).
2. Reach for the Heavy Light Decomposition template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Heavy Light Decomposition step-by-step ]
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

### Problem — Diff Costs (LeetCode 2538)
A representative **Heavy Light Decomposition** problem. The signal: decompose tree paths into o(log n) chains for path queries.

### Thought Process
1. Confirm the pattern via its recognition signals (heavy light, hld, path query, tree chains, segment tree on tree).
2. Reach for the Heavy Light Decomposition template below and map the problem's entities onto it.
3. Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Heavy Light Decomposition step-by-step ]
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
| 2467 | Game on Tree | Easy | Core advanced application |
| 1916 | Build Rooms | Easy | Core advanced application |
| 2538 | Diff Costs | Medium | Core advanced application |
| Tree | path queries | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Heavy Light Decomposition logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Heavy Light Decomposition (Advanced).
- **Signal:** heavy light, hld, path query, tree chains, segment tree on tree.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Heavy Light Decomposition invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Heavy Light Decomposition
FAMILY : Advanced (Expert)
WHEN   : heavy light, hld, path query, tree chains, segment tree on tree
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 2467, 1916, 2538, Tree
```

---

*Part of the DSA Patterns Handbook — pattern 96 of 100.*
