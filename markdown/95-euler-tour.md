# 95 · Euler Tour

> **One-liner:** Flatten a tree to an array so subtrees become contiguous ranges.

---

## 1. Overview

### Definition
The **Euler Tour** pattern belongs to the *Advanced* family. Flatten a tree to an array so subtrees become contiguous ranges.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
euler tour, flatten tree, subtree range, in out time, lca.

### Constraints
- Input size where the brute-force complexity would time out — the Euler Tour optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Euler Tour invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Euler Tour is the upgrade.
- The wording maps onto: euler tour, flatten tree, subtree range, in out time, lca.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the total (or count, or best) over everything hanging below node u — asked over and over, for many different u?"*

Running example: a 6-node tree rooted at node 1, one number written on each node. We must answer `subtreeSum(u)` for many different `u`.

```
          1(5)
        /      \
      2(3)     5(4)
     /    \        \
   3(2)   4(7)     6(1)
```

### Intuition
A subtree is "node u plus everything you can reach going downwards from u". So the obvious way to answer a subtree question is to walk down from u and add things up. If someone asks about ten different nodes, you walk ten times. Nothing is remembered between walks.

### Algorithm
1. Read the query node `u`.
2. Start a DFS at `u` that never goes back up towards the root.
3. Add each visited node's value into a running total.
4. Return the total. Repeat from step 1 for the next query.

### Complexity
- Time: **O(n) per query → O(n · q) overall** — one full walk of u's subtree each time, and u's subtree can be the whole tree.
- Space: O(n) for the recursion stack.

### Drawbacks
- **The same additions are performed again and again.** Ask for `subtreeSum(2)` and you compute `3 + 2 + 7 = 12`. Ask for `subtreeSum(1)` next and you compute `3 + 2 + 7` *a second time* on your way to `22`. Nodes 3 and 4 were re-read for no new information.
- **A deep node is re-walked once per ancestor.** Node 3 sits inside subtree(2) and inside subtree(1), so it is touched by every query about an ancestor of it.
- The brute force never exploits the one fact that makes trees nice: **a DFS visits a subtree as one uninterrupted stretch of time.** It throws that ordering away and re-derives it from scratch on every query.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Number the nodes in the order a DFS first touches them; then every subtree occupies one unbroken block of that numbering, so a subtree question turns into a plain array-range question.**

Think of a DFS as a stopwatch. You start the watch at the root and write down the time whenever you *enter* a node. Because a DFS that enters node `u` cannot leave `u`'s subtree and come back later, every timestamp handed out between "entered u" and "finished u" belongs to a descendant of `u`. So if you lay the nodes out in entry-time order, all of `u`'s descendants sit side by side. And once something is a contiguous array range, every range tool you own — prefix sums, Fenwick tree, segment tree — suddenly applies to trees.

### The thought process

```text
We need    : subtree(u) aggregates, for many different u, possibly with updates.
Obvious way: DFS down from u on every query.
Too slow   : O(n) per query; ancestors re-walk the same descendants.
Notice     : a DFS enters u, handles ALL of u's subtree, then leaves u.
             It never interleaves u's subtree with anything else.
Therefore  : if we label nodes by entry time, subtree(u) is one contiguous block
             of labels: [tin[u] .. tout[u]].
Now        : subtree query  = range query   on an array of size n
             point update   = point update  on that same array
             -> Fenwick / segment tree, O(log n) each.
```

### Why the block is contiguous (and why the ancestor test works)

Run the stopwatch on the running example. Visit children in increasing order:

```text
enter 1  -> tin[1]=0
  enter 2  -> tin[2]=1
    enter 3 -> tin[3]=2   leave 3 -> tout[3]=2
    enter 4 -> tin[4]=3   leave 4 -> tout[4]=3
  leave 2  -> tout[2]=3
  enter 5  -> tin[5]=4
    enter 6 -> tin[6]=5   leave 6 -> tout[6]=5
  leave 5  -> tout[5]=5
leave 1    -> tout[1]=5
```

Why is this airtight? A DFS at `u` only returns to `u`'s parent after every recursive call from `u` has returned. So the clock ticks assigned during those calls form one solid interval with no outsider slipped in — an outsider would have to be reached without passing through `u`, and in a tree the only way out of `u`'s subtree is through `u` itself.

Two consequences you will use constantly:

| Fact | Statement |
|------|-----------|
| Subtree = range | The nodes of subtree(u) are exactly the tour positions `tin[u] … tout[u]`. |
| Ancestry in O(1) | `u` is an ancestor of `v` ⟺ `tin[u] ≤ tin[v] ≤ tout[u]`. |

Check the ancestry rule against the example. Is 2 an ancestor of 4? `tin[2]=1 ≤ tin[4]=3 ≤ tout[2]=3` — yes. Is 2 an ancestor of 6? `tin[2]=1 ≤ tin[6]=5` but `5 > tout[2]=3` — no. The interval of a descendant is *nested inside* the interval of its ancestor; the interval of an unrelated node is *disjoint*. Intervals from a DFS are never partially overlapping, which is exactly why one comparison decides it.

**One subtlety:** the tour must be built once, before any query, and the tree must not change shape afterwards. Values on nodes may change freely (that is a point update); edges may not.

### Steps

```text
Step 1 -> Root the tree and build adjacency lists.
Step 2 -> One DFS: on entry record tin[u] and append u to order[];
          on exit record tout[u] = timer-1.
Step 3 -> Build a flat array flat[i] = value(order[i]).
Step 4 -> Put flat[] into a prefix-sum array (static) or a Fenwick tree (updates).
Step 5 -> subtree(u) query  = range(tin[u], tout[u])
          point update at u = update(tin[u], delta)
```

### How should I recognize this?

```text
If you see...
  "for every node, report something about its subtree"
  "queries of the form (node, ...) on a rooted tree"
  "is u an ancestor of v?"
  "update one node's value, then ask about a whole subtree"
        |
        v
Think about...
  "Can I turn this tree into an array where each subtree is one slice?"
        |
        v
Use...
  Euler tour with tin/tout  -> subtree becomes [tin[u], tout[u]]
    + prefix sums           -> static subtree aggregates
    + Fenwick / segment tree-> subtree aggregates with point updates
    + tin/tout comparison   -> O(1) ancestor test
  Need LCA instead of subtrees?
    -> record the tour on EVERY visit (length 2n-1, node repeats on the way
       back up) and run RMQ-by-depth over it: the shallowest node between
       first[u] and first[v] in that walk IS the LCA.
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="euler-95" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Euler tour: subtree of node 2 becomes a contiguous range [in=2 .. out=4]</text>
  <!-- tree edges drawn first -->
  <line x1="110" y1="55" x2="80" y2="120" stroke="#475569"/>
  <line x1="110" y1="55" x2="180" y2="120" stroke="#475569"/>
  <line x1="80" y1="120" x2="50" y2="185" stroke="#475569"/>
  <line x1="80" y1="120" x2="110" y2="185" stroke="#475569"/>
  <text x="110" y="48" text-anchor="middle" fill="#64748b" font-weight="700">tree</text>
  <circle cx="110" cy="55" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="110" y="59" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="80" cy="120" r="16" fill="#ecfdf5" stroke="#059669"/><text x="80" y="124" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="180" cy="120" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="124" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="50" cy="185" r="16" fill="#ecfdf5" stroke="#059669"/><text x="50" y="189" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="110" cy="185" r="16" fill="#ecfdf5" stroke="#059669"/><text x="110" y="189" text-anchor="middle" fill="#1e293b">4</text>
  <!-- flattened in-order array -->
  <text x="425" y="70" text-anchor="middle" fill="#64748b" font-weight="700">flatten by entry (in) time</text>
  <rect x="270" y="85" width="62" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="301" y="112" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="332" y="85" width="62" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="363" y="112" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="394" y="85" width="62" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="425" y="112" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="456" y="85" width="62" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="487" y="112" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="518" y="85" width="62" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="549" y="112" text-anchor="middle" fill="#1e293b">5</text>
  <text x="301" y="148" text-anchor="middle" fill="#64748b">1</text>
  <text x="363" y="148" text-anchor="middle" fill="#64748b">2</text>
  <text x="425" y="148" text-anchor="middle" fill="#64748b">3</text>
  <text x="487" y="148" text-anchor="middle" fill="#64748b">4</text>
  <text x="549" y="148" text-anchor="middle" fill="#64748b">5</text>
  <line x1="332" y1="162" x2="518" y2="162" stroke="#059669" stroke-width="2" marker-end="url(#euler-95)"/>
  <text x="425" y="182" text-anchor="middle" fill="#059669" font-weight="700">subtree(2) = range [in=2 .. out=4]</text>
  <text x="425" y="205" text-anchor="middle" fill="#64748b">a subtree query is now one contiguous range query</text>
</svg>
```

```text
tree                     tour order (by entry time)
          1(5)           idx :   0    1    2    3    4    5
        /      \         node:   1    2    3    4    5    6
      2(3)     5(4)      val :   5    3    2    7    4    1
     /    \        \             ^--------------^
   3(2)   4(7)     6(1)          subtree(2) = idx 1..3  = 3+2+7 = 12
                                                     ^-------^
                                 subtree(5) = idx 4..5  = 4+1  = 5

tin/tout table
  node : 1  2  3  4  5  6
  tin  : 0  1  2  3  4  5
  tout : 5  3  2  3  5  5

prefix sums of val:  P = [0, 5, 8, 10, 17, 21, 22]
  subtreeSum(2) = P[tout[2]+1] - P[tin[2]] = P[4] - P[1] = 17 - 5 = 12
  subtreeSum(1) = P[6] - P[0] = 22
```

### Interview explanation
"A subtree is whatever a DFS visits between entering a node and leaving it, and a DFS never interrupts that stretch — so if I stamp each node with its entry time, the subtree of `u` is exactly the contiguous index range `[tin[u], tout[u]]`. I do one DFS to record `tin` and `tout`, copy the node values into that tour order, and then a subtree query is a range query and a node update is a point update. With prefix sums that is O(1) per query for a static tree; with a Fenwick tree it is O(log n) per query and per update, on O(n) build and O(n) space. The same `tin/tout` pair also gives me an O(1) ancestor test, since `u` is an ancestor of `v` exactly when `tin[u] ≤ tin[v] ≤ tout[u]`."

---

## 5. Generic Templates

> One DFS stamps `tin`/`tout`; after that the tree *is* an array, so use array tools.

```go
// EulerTour flattens a rooted tree so that the subtree of v occupies the
// contiguous index range [Tin[v] .. Tout[v]] of the tour order.
type EulerTour struct {
	Tin, Tout []int // entry index and last-descendant index of each node
	Order     []int // Order[i] = the node whose entry index is i
}

func NewEulerTour(adj [][]int, root int) *EulerTour {
	n := len(adj)
	t := &EulerTour{Tin: make([]int, n), Tout: make([]int, n)}
	timer := 0
	var dfs func(u, parent int)
	dfs = func(u, parent int) {
		t.Tin[u] = timer
		t.Order = append(t.Order, u)
		timer++
		for _, v := range adj[u] {
			if v != parent {
				dfs(v, u)
			}
		}
		// Every index handed out since entering u belongs to u's subtree.
		t.Tout[u] = timer - 1
	}
	dfs(root, -1)
	return t
}

// IsAncestor reports whether u is an ancestor of v (a node is its own ancestor).
func (t *EulerTour) IsAncestor(u, v int) bool {
	return t.Tin[u] <= t.Tin[v] && t.Tin[v] <= t.Tout[u]
}

// Fenwick gives point update + prefix sum in O(log n), 1-indexed internally.
type Fenwick struct{ tree []int }

func NewFenwick(n int) *Fenwick { return &Fenwick{make([]int, n+1)} }

func (f *Fenwick) Add(i, delta int) { // i is a 0-based tour index
	for i++; i < len(f.tree); i += i & (-i) {
		f.tree[i] += delta
	}
}

func (f *Fenwick) prefix(i int) int { // sum of tour indices [0..i]
	s := 0
	for i++; i > 0; i -= i & (-i) {
		s += f.tree[i]
	}
	return s
}

func (f *Fenwick) Range(l, r int) int { return f.prefix(r) - f.prefix(l-1) }

// SubtreeSum answers "sum of values in the subtree of v" in O(log n).
func SubtreeSum(t *EulerTour, f *Fenwick, v int) int {
	return f.Range(t.Tin[v], t.Tout[v])
}
```

```python
class EulerTour:
    """Flatten a rooted tree: subtree(v) == tour indices [tin[v] .. tout[v]]."""

    def __init__(self, adj, root):
        n = len(adj)
        self.tin = [0] * n
        self.tout = [0] * n
        self.order = []
        timer = 0
        # Explicit stack so deep trees do not blow the recursion limit.
        stack = [(root, -1, False)]
        while stack:
            u, parent, leaving = stack.pop()
            if leaving:
                self.tout[u] = timer - 1
                continue
            self.tin[u] = timer
            self.order.append(u)
            timer += 1
            stack.append((u, parent, True))
            for v in reversed(adj[u]):
                if v != parent:
                    stack.append((v, u, False))

    def is_ancestor(self, u, v):
        return self.tin[u] <= self.tin[v] <= self.tout[u]


class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)

    def add(self, i, delta):             # i is a 0-based tour index
        i += 1
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)

    def _prefix(self, i):
        s, i = 0, i + 1
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s

    def range_sum(self, l, r):
        return self._prefix(r) - self._prefix(l - 1)


def subtree_sum(tour, fen, v):
    return fen.range_sum(tour.tin[v], tour.tout[v])
```

```java
class EulerTour {
    int[] tin, tout;
    int[] order;
    private int timer = 0, k = 0;

    EulerTour(java.util.List<java.util.List<Integer>> adj, int root) {
        int n = adj.size();
        tin = new int[n];
        tout = new int[n];
        order = new int[n];
        dfs(adj, root, -1);
    }

    private void dfs(java.util.List<java.util.List<Integer>> adj, int u, int parent) {
        tin[u] = timer++;
        order[k++] = u;
        for (int v : adj.get(u)) if (v != parent) dfs(adj, v, u);
        tout[u] = timer - 1;          // whole subtree used indices tin[u]..timer-1
    }

    boolean isAncestor(int u, int v) { return tin[u] <= tin[v] && tin[v] <= tout[u]; }
}

class Fenwick {
    long[] tree;
    Fenwick(int n) { tree = new long[n + 1]; }
    void add(int i, long d) { for (i++; i < tree.length; i += i & (-i)) tree[i] += d; }
    private long prefix(int i) { long s = 0; for (i++; i > 0; i -= i & (-i)) s += tree[i]; return s; }
    long range(int l, int r) { return prefix(r) - prefix(l - 1); }
    long subtreeSum(EulerTour t, int v) { return range(t.tin[v], t.tout[v]); }
}
```

```cpp
struct EulerTour {
    vector<int> tin, tout, order;
    int timer = 0;

    EulerTour(const vector<vector<int>>& adj, int root)
        : tin(adj.size()), tout(adj.size()) {
        dfs(adj, root, -1);
    }
    void dfs(const vector<vector<int>>& adj, int u, int parent) {
        tin[u] = timer++;
        order.push_back(u);
        for (int v : adj[u]) if (v != parent) dfs(adj, v, u);
        tout[u] = timer - 1;          // subtree of u owns indices tin[u]..timer-1
    }
    bool isAncestor(int u, int v) const { return tin[u] <= tin[v] && tin[v] <= tout[u]; }
};

struct Fenwick {
    vector<long long> tree;
    Fenwick(int n) : tree(n + 1, 0) {}
    void add(int i, long long d) { for (++i; i < (int)tree.size(); i += i & (-i)) tree[i] += d; }
    long long prefix(int i) { long long s = 0; for (++i; i > 0; i -= i & (-i)) s += tree[i]; return s; }
    long long range(int l, int r) { return prefix(r) - prefix(l - 1); }
    long long subtreeSum(const EulerTour& t, int v) { return range(t.tin[v], t.tout[v]); }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Euler Tour (Optimal) |
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

### Problem — Subtree Labels (LeetCode 1519)
A tree with `n` nodes rooted at `0`; node `i` carries the lowercase letter `labels[i]`. For every node `i`, report how many nodes in the subtree of `i` carry the *same* letter as `i`.

### Thought Process
1. The question is "count of letter `c` inside subtree(i)" — asked once per node, so `n` separate subtree counts.
2. Euler tour: flatten the tree by entry time, so subtree(i) becomes the index range `[tin[i] .. tout[i]]` of a flat letter array.
3. A "count letter `c` in a range" question over a fixed array is answered by prefix counts — one prefix array per letter, 26 in total.
4. `answer[i] = pref[c][tout[i]+1] - pref[c][tin[i]]` where `c = labels[i]`.
5. Cost: one DFS plus 26 prefix arrays — O(26n) build, O(1) per node.

### Dry Run

Input: `n = 7`, `edges = [[0,1],[0,2],[1,4],[1,5],[2,3],[2,6]]`, `labels = "abaedcd"`

DFS from 0 visiting neighbours in increasing order stamps:

| node | label | tin | tout | subtree range | letters in that range | count of own label |
|------|-------|-----|------|---------------|------------------------|--------------------|
| 0 | a | 0 | 6 | [0..6] | a b d c a e d | **2** (idx 0, 4) |
| 1 | b | 1 | 3 | [1..3] | b d c | **1** |
| 4 | d | 2 | 2 | [2..2] | d | **1** |
| 5 | c | 3 | 3 | [3..3] | c | **1** |
| 2 | a | 4 | 6 | [4..6] | a e d | **1** |
| 3 | e | 5 | 5 | [5..5] | e | **1** |
| 6 | d | 6 | 6 | [6..6] | d | **1** |

Output: **[2,1,1,1,1,1,1]**

The row for node 0 is the one that matters: nodes `0` and `2` both carry `a`, and although they sit in different branches of the tree they land at flat indices `0` and `4` — both inside `[0..6]`, so one subtraction on the `a` prefix array finds them.

### Visualization

```text
tree (rooted at 0)                flat by entry time
        0(a)                      idx  : 0  1  2  3  4  5  6
      /      \                    node : 0  1  4  5  2  3  6
    1(b)     2(a)                 label: a  b  d  c  a  e  d
   /   \     /   \                        \________/
 4(d) 5(c) 3(e) 6(d)                       subtree(1) = [1..3]
                                                       \______/
                                                subtree(2) = [4..6]

prefix counts for letter 'a' over the flat labels
  idx     :  -   0  1  2  3  4  5  6
  pref[a] :  0   1  1  1  1  2  2  2
  node 0 -> pref[a][6+1] - pref[a][0] = 2 - 0 = 2
  node 2 -> pref[a][6+1] - pref[a][4] = 2 - 1 = 1
```

### Code

```go
func countSubTrees(n int, edges [][]int, labels string) []int {
	adj := make([][]int, n)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
		adj[e[1]] = append(adj[e[1]], e[0])
	}

	// One DFS: stamp entry/exit indices and write the tour order.
	tin := make([]int, n)
	tout := make([]int, n)
	flat := make([]byte, 0, n)
	timer := 0
	var dfs func(u, parent int)
	dfs = func(u, parent int) {
		tin[u] = timer
		flat = append(flat, labels[u])
		timer++
		for _, v := range adj[u] {
			if v != parent {
				dfs(v, u)
			}
		}
		tout[u] = timer - 1 // subtree of u owns tour indices tin[u]..timer-1
	}
	dfs(0, -1)

	// pref[c][i] = how many of flat[0..i-1] equal letter c.
	pref := make([][]int, 26)
	for c := 0; c < 26; c++ {
		pref[c] = make([]int, n+1)
	}
	for i := 0; i < n; i++ {
		for c := 0; c < 26; c++ {
			pref[c][i+1] = pref[c][i]
		}
		pref[int(flat[i]-'a')][i+1]++
	}

	answer := make([]int, n)
	for u := 0; u < n; u++ {
		c := int(labels[u] - 'a')
		answer[u] = pref[c][tout[u]+1] - pref[c][tin[u]]
	}
	return answer
}
```

```python
def countSubTrees(n, edges, labels):
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)

    tin, tout, flat = [0] * n, [0] * n, []
    timer = 0
    stack = [(0, -1, False)]
    while stack:                       # iterative DFS, same stamps as recursion
        u, parent, leaving = stack.pop()
        if leaving:
            tout[u] = timer - 1
            continue
        tin[u] = timer
        flat.append(labels[u])
        timer += 1
        stack.append((u, parent, True))
        for v in reversed(adj[u]):
            if v != parent:
                stack.append((v, u, False))

    pref = [[0] * (n + 1) for _ in range(26)]
    for i, ch in enumerate(flat):
        for c in range(26):
            pref[c][i + 1] = pref[c][i]
        pref[ord(ch) - 97][i + 1] += 1

    answer = [0] * n
    for u in range(n):
        c = ord(labels[u]) - 97
        answer[u] = pref[c][tout[u] + 1] - pref[c][tin[u]]
    return answer
```

### Complexity
Time O(26n) — one DFS plus 26 prefix arrays of length n, then O(1) per node. Space O(26n) for the prefix tables (drop to O(n) by answering during the DFS instead, at the cost of losing random access).

---

## 10. Solved Example 2

### Problem — Min Score Tree (LeetCode 2322)
Remove **two distinct edges** from an undirected tree with values `nums[i]` on the nodes. That splits it into three components; the score is `max(XOR of a component) - min(XOR of a component)`. Return the smallest score achievable.

### Thought Process
1. Root the tree at 0. Then every edge is "the edge above node `v`", so choosing two edges = choosing two non-root nodes `a` and `b`.
2. One DFS gives `sub[v]` = XOR of all values in subtree(v), and `total = sub[0]`.
3. The three components depend on whether `a` is an ancestor of `b`:
   - **nested** (`a` above `b`): `sub[b]`, `sub[a] ^ sub[b]`, `total ^ sub[a]`
   - **disjoint**: `sub[a]`, `sub[b]`, `total ^ sub[a] ^ sub[b]`
4. The ancestry test is exactly the Euler tour comparison `tin[a] ≤ tin[b] ≤ tout[a]` — O(1), no extra walking.
5. Try all O(n²) pairs, keep the smallest `max - min`.

### Dry Run

Input: `nums = [1,5,5,4,11]`, `edges = [[0,1],[0,2],[2,3],[2,4]]`

After one DFS from 0 (children in increasing order):

| node | tin | tout | sub (subtree XOR) |
|------|-----|------|-------------------|
| 0 | 0 | 4 | 14 |
| 1 | 1 | 1 | 5 |
| 2 | 2 | 4 | 10 |
| 3 | 3 | 3 | 4 |
| 4 | 4 | 4 | 11 |

`total = 14`. Now every pair of removable edges (identified by their lower node):

| pair (a,b) | ancestor test `tin[a] ≤ tin[b] ≤ tout[a]` | relation | three XORs | max−min |
|------------|------------------------------------------|----------|------------|---------|
| (1,2) | 1 ≤ 2 ≤ 1? no | disjoint | 5, 10, 14^5^10 = 1 | 10−1 = **9** |
| (1,3) | 1 ≤ 3 ≤ 1? no | disjoint | 5, 4, 14^5^4 = 15 | 15−4 = 11 |
| (1,4) | no | disjoint | 5, 11, 14^5^11 = 0 | 11−0 = 11 |
| (2,3) | 2 ≤ 3 ≤ 4? **yes** | nested | 4, 10^4 = 14, 14^10 = 4 | 14−4 = 10 |
| (2,4) | 2 ≤ 4 ≤ 4? **yes** | nested | 11, 10^11 = 1, 14^10 = 4 | 11−1 = 10 |
| (3,4) | 3 ≤ 4 ≤ 3? no | disjoint | 4, 11, 14^4^11 = 1 | 11−1 = 10 |

Output: **9**

Rows `(2,3)` and `(2,4)` are the ones the Euler tour earns its keep on: node 2 sits *above* nodes 3 and 4, so `sub[2]` already contains them and the middle component must be `sub[2] ^ sub[child]`. A single interval comparison told us that, with no second traversal.

### Visualization

```text
tree rooted at 0            tin/tout intervals on the timeline
      0 (1)                 0 : [0 ................ 4]
     /     \                1 :    [1]
   1(5)    2(5)             2 :        [2 ......... 4]
          /    \            3 :           [3]
       3(4)   4(11)         4 :              [4]

  nested  : 3's interval sits INSIDE 2's  -> cutting above 2 and above 3
            leaves the ring between them: sub[2] ^ sub[3]
  disjoint: 1's interval and 3's do not overlap -> two separate hanging pieces

best pair (1,2):   [1]      [2,3,4]        [0]
                   xor=5    xor=10         xor=1     -> 10 - 1 = 9
```

### Code

```go
func minimumScore(nums []int, edges [][]int) int {
	n := len(nums)
	adj := make([][]int, n)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
		adj[e[1]] = append(adj[e[1]], e[0])
	}

	tin := make([]int, n)
	tout := make([]int, n)
	sub := make([]int, n)
	timer := 0
	var dfs func(u, parent int)
	dfs = func(u, parent int) {
		tin[u] = timer
		timer++
		sub[u] = nums[u]
		for _, v := range adj[u] {
			if v != parent {
				dfs(v, u)
				sub[u] ^= sub[v]
			}
		}
		tout[u] = timer - 1
	}
	dfs(0, -1)

	isAncestor := func(a, b int) bool { return tin[a] <= tin[b] && tin[b] <= tout[a] }
	total := sub[0]

	best := -1
	for a := 1; a < n; a++ { // node a stands for the edge above a
		for b := a + 1; b < n; b++ {
			var x, y, z int
			switch {
			case isAncestor(a, b): // b hangs below a
				x, y, z = sub[b], sub[a]^sub[b], total^sub[a]
			case isAncestor(b, a): // a hangs below b
				x, y, z = sub[a], sub[b]^sub[a], total^sub[b]
			default: // two disjoint subtrees
				x, y, z = sub[a], sub[b], total^sub[a]^sub[b]
			}
			hi, lo := x, x
			for _, v := range []int{y, z} {
				if v > hi {
					hi = v
				}
				if v < lo {
					lo = v
				}
			}
			if best == -1 || hi-lo < best {
				best = hi - lo
			}
		}
	}
	return best
}
```

```python
def minimumScore(nums, edges):
    n = len(nums)
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)

    tin, tout, sub = [0] * n, [0] * n, [0] * n
    timer = 0
    stack = [(0, -1, False)]
    while stack:
        u, parent, leaving = stack.pop()
        if leaving:
            tout[u] = timer - 1
            for v in adj[u]:
                if v != parent:
                    sub[u] ^= sub[v]        # children are finished by now
            continue
        tin[u] = timer
        timer += 1
        sub[u] = nums[u]
        stack.append((u, parent, True))
        for v in reversed(adj[u]):
            if v != parent:
                stack.append((v, u, False))

    def is_ancestor(a, b):
        return tin[a] <= tin[b] <= tout[a]

    total, best = sub[0], None
    for a in range(1, n):
        for b in range(a + 1, n):
            if is_ancestor(a, b):
                parts = (sub[b], sub[a] ^ sub[b], total ^ sub[a])
            elif is_ancestor(b, a):
                parts = (sub[a], sub[b] ^ sub[a], total ^ sub[b])
            else:
                parts = (sub[a], sub[b], total ^ sub[a] ^ sub[b])
            score = max(parts) - min(parts)
            if best is None or score < best:
                best = score
    return best
```

### Complexity
Time O(n²) — one DFS to stamp the tour, then every pair of edges tested in O(1) thanks to the interval ancestor test. Space O(n) for `tin`, `tout`, `sub` and adjacency.

---

## 11. Solved Example 3

### Problem — Subtree Sums (LeetCode 508)
Given a binary tree, the *subtree sum* of a node is the sum of all values in the subtree rooted there. Return every subtree sum that occurs most often.

### Thought Process
1. Every node needs a subtree aggregate — the exact shape the Euler tour was built for.
2. Flatten the binary tree in DFS entry order into `flat[]`, recording `tin` and `tout` per node.
3. Prefix-sum `flat[]` once. Then `subtreeSum(u) = P[tout[u]+1] - P[tin[u]]` in O(1), no re-walking.
4. Tally the sums in a map and return every key that hits the maximum frequency.
5. Sort the result so the output is deterministic (LeetCode accepts any order).

### Dry Run

Input: the tree `5` with left child `2` (which has left child `1`) and right child `-5`.

DFS entry order is `5, 2, 1, -5`, so `flat = [5, 2, 1, -5]` and `P = [0, 5, 7, 8, 3]`.

| node | tin | tout | range | `P[tout+1] - P[tin]` | subtree sum |
|------|-----|------|-------|----------------------|-------------|
| 5 (root) | 0 | 3 | [0..3] | 3 − 0 | **3** |
| 2 | 1 | 2 | [1..2] | 8 − 5 | **3** |
| 1 | 2 | 2 | [2..2] | 8 − 7 | **1** |
| −5 | 3 | 3 | [3..3] | 3 − 8 | **−5** |

Frequencies: `3 → 2`, `1 → 1`, `−5 → 1`. Maximum frequency is 2.

Output: **[3]**

Note the row for node `2`: its range `[1..2]` is a *strict slice* of the root's `[0..3]`, and the arithmetic `8 − 5` reuses prefix values the root's own answer also used. That reuse is what the brute force could not do.

### Visualization

```text
binary tree              flat by entry time
      5                  idx  :  0   1   2   3
     / \                 node :  5   2   1  -5
   2    -5               val  :  5   2   1  -5
  /                      P    : 0   5   7   8   3
 1                                ^-----^
                          subtree(2) = idx 1..2 -> P[3]-P[1] = 8-5 = 3
                         ^-------------------^
                          subtree(5) = idx 0..3 -> P[4]-P[0] = 3-0 = 3

tally: { 3:2, 1:1, -5:1 }  -> best frequency 2 -> answer [3]
```

### Code

```go
func findFrequentTreeSum(root *TreeNode) []int {
	if root == nil {
		return nil
	}

	// Flatten the binary tree by DFS entry time; record tin/tout per node.
	var flat []int
	var tin, tout []int
	timer := 0
	var walk func(node *TreeNode) int
	walk = func(node *TreeNode) int {
		id := len(tin)
		tin = append(tin, timer)
		tout = append(tout, 0)
		flat = append(flat, node.Val)
		timer++
		if node.Left != nil {
			walk(node.Left)
		}
		if node.Right != nil {
			walk(node.Right)
		}
		tout[id] = timer - 1
		return id
	}
	walk(root)

	// Prefix sums turn "sum over subtree" into one subtraction.
	prefix := make([]int, len(flat)+1)
	for i, v := range flat {
		prefix[i+1] = prefix[i] + v
	}

	freq := make(map[int]int)
	best := 0
	for id := range tin {
		sum := prefix[tout[id]+1] - prefix[tin[id]]
		freq[sum]++
		if freq[sum] > best {
			best = freq[sum]
		}
	}

	answer := []int{}
	for sum, count := range freq {
		if count == best {
			answer = append(answer, sum)
		}
	}
	sort.Ints(answer) // deterministic output; LeetCode accepts any order
	return answer
}
```

```python
# class TreeNode: __init__(self, val=0, left=None, right=None)
def findFrequentTreeSum(root):
    if not root:
        return []

    flat, tin, tout = [], [], []

    def walk(node):
        node_id = len(tin)
        tin.append(len(flat))
        tout.append(0)
        flat.append(node.val)
        if node.left:
            walk(node.left)
        if node.right:
            walk(node.right)
        tout[node_id] = len(flat) - 1
        return node_id

    walk(root)

    prefix = [0] * (len(flat) + 1)
    for i, v in enumerate(flat):
        prefix[i + 1] = prefix[i] + v

    freq = {}
    for node_id in range(len(tin)):
        total = prefix[tout[node_id] + 1] - prefix[tin[node_id]]
        freq[total] = freq.get(total, 0) + 1

    best = max(freq.values())
    return sorted(s for s, c in freq.items() if c == best)
```

### Complexity
Time O(n log n) — O(n) for the tour, prefix sums and tallying, plus the final sort of the answer (O(n) if you skip sorting). Space O(n) for `flat`, `tin`, `tout`, the prefix array and the frequency map.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1519 | Subtree Labels | Easy | Core advanced application |
| 2322 | Min Score Tree | Easy | Core advanced application |
| 508 | Subtree Sums | Medium | Core advanced application |
| 663 | Equal Tree | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Euler Tour logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Euler Tour (Advanced).
- **Signal:** euler tour, flatten tree, subtree range, in out time, lca.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Euler Tour invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Euler Tour
FAMILY : Advanced (Expert)
WHEN   : euler tour, flatten tree, subtree range, in out time, lca
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1519, 2322, 508, 663
```

---

*Part of the DSA Patterns Handbook — pattern 95 of 100.*
