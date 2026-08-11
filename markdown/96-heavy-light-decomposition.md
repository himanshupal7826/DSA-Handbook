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

**The question this pattern keeps answering:** *"What is the sum / max along the path between node u and node v — asked thousands of times, on a tree whose node values keep changing?"*

Running example: a 7-node tree rooted at 1, one number per node. We must answer `pathSum(u, v)` many times, and sometimes change one node's value.

```
             1(5)
          /        \
        2(3)       3(1)
      /     \          \
    4(2)    5(4)       6(7)
   /
 7(6)
```

### Intuition
The path between `u` and `v` in a tree is unique: climb from `u` to their lowest common ancestor, then descend to `v`. So the obvious method is to physically walk it — step from child to parent, adding values as you go.

### Algorithm
1. Precompute `parent[]` and `depth[]` with one DFS from the root.
2. For a query `(u, v)`: while `depth[u] > depth[v]`, add `value[u]` and set `u = parent[u]`. Do the mirror image for `v`.
3. Once the depths match, step both up together, adding as you go, until `u == v`.
4. Add `value[u]` (the LCA) once and return the total.

### Complexity
- Time: **O(n) per query → O(n · q) overall** — a path in a path-shaped ("bamboo") tree has n nodes.
- Space: O(n) for `parent` and `depth`.

### Drawbacks
- **The top of the tree is re-walked by nearly every query.** In the example, `pathSum(7,6)` and `pathSum(5,6)` both climb through node `1`; the addition `+5` for node 1 happens in both, and in every other query that crosses the root.
- **A path zig-zags, so no ordinary range structure fits.** If you lay the nodes out in plain DFS order, the path `7 → 4 → 2 → 1 → 3 → 6` is *not* a contiguous slice, so you cannot just point a Fenwick tree at it — which is why the brute force feels forced into stepping one edge at a time.
- The brute force never notices that trees have a **skew**: most children sit in small subtrees, and a path spends most of its length inside a few long, straight runs. Those straight runs are exactly what could be pre-flattened.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Cut the tree into vertical "heavy" chains — always continuing into the biggest child — lay each chain out as a contiguous block of one array, and then any path is just O(log n) ranges in that array.**

Picture a river system. From any point, follow the widest branch upstream and you trace one long trunk; the thin tributaries hang off it. Heavy-light decomposition does exactly this: from each node, the edge to its **largest** subtree is *heavy* (part of the trunk), every other edge is *light* (a tributary you have to hop across). Walking a path means sliding along a trunk (one array range, answered by a segment tree in O(log n)) and hopping to another trunk. The whole pattern rests on one guarantee: **you can only hop O(log n) times.**

### The thought process

```text
We need    : path(u,v) aggregates, many queries, values change between them.
Obvious way: walk the path edge by edge.
Too slow   : O(n) per query; the path can be the entire tree.
Notice     : a path is not contiguous in DFS order... but a straight
             downward run of nodes COULD be, if we lay it out on purpose.
Notice more: if we always continue into the biggest child, then every time we
             DON'T (a light edge) the subtree we drop into is less than half
             the size. Halving cannot happen more than log2(n) times.
Therefore  : split the tree into heavy chains; number nodes chain by chain.
             Any path = at most O(log n) contiguous ranges.
Now        : segment tree over that numbering
             -> O(log^2 n) per path query, O(log n) per point update.
```

### Why a path can only cross O(log n) chains

This halving argument is the entire justification for the log factor, so it is worth doing slowly.

**Definition.** `size[u]` = number of nodes in the subtree of `u`. The **heavy child** of `u` is the child with the largest `size`; the edge to it is *heavy*. All other child edges are *light*.

**Claim.** If `(u, c)` is a light edge, then `size[c] ≤ size[u] / 2`.

**Proof.** `c` is not the heavy child, so some other child `h` has `size[h] ≥ size[c]`. Both subtrees are disjoint and both sit under `u`, and `u` itself is a third node, so

```text
size[u]  ≥  1 + size[c] + size[h]  ≥  1 + 2 · size[c]  >  2 · size[c]
```

hence `size[c] < size[u]/2`. ∎

**Consequence.** Walk from the root down to any node. Start with `size = n`. Every light edge you cross at least halves the current subtree size, and the size can never drop below 1. You can halve `n` down to 1 at most `log2(n)` times, so a root-to-node path contains **at most log2(n) light edges**. A chain only ends where a light edge begins, so the path visits at most `log2(n) + 1` chains. A general path `u → v` is two root paths glued at the LCA, so it touches at most `2·log2(n) + 2` chains — still O(log n).

That is why the decomposition pays off: each chain costs one O(log n) segment-tree range query, and there are O(log n) of them → **O(log² n) per path query**.

### Steps

```text
Step 1 -> DFS #1: compute size[u], parent[u], depth[u], and heavy[u]
                  (the child with the largest size, or -1 if u is a leaf).
Step 2 -> DFS #2: assign positions. Walk into heavy[u] FIRST so a chain
                  gets consecutive positions. head[u] = topmost node of u's chain.
Step 3 -> Copy value[u] into base[pos[u]] and build a Fenwick/segment tree on base.
Step 4 -> Point update at node u  ->  update index pos[u].
Step 5 -> pathQuery(u, v):
            while head[u] != head[v]:
                move whichever of u,v has the DEEPER head
                take range [pos[head[u]] .. pos[u]]
                u = parent[head[u]]           # hop the light edge
            take the final range between pos[u] and pos[v] (same chain)
```

### How should I recognize this?

```text
If you see...
  "queries on the path between two nodes of a tree"
  "update a node's value, then ask about a path"
  n and q both around 1e5, tree given by edges
  "maximum edge weight on the path", "sum along the path"
        |
        v
Think about...
  "Is the tree fixed, but the values changing, with many path queries?"
        |
        v
Use...
  Subtree queries only (no paths)?     -> Euler tour + Fenwick, simpler, O(log n)
  Path queries, values NEVER change?   -> prefix sums to the root + LCA, O(1)/O(log n)
  Path queries WITH updates?           -> heavy-light decomposition + segment tree
  Edge weights instead of node values? -> store each edge's weight on its lower
                                          node and skip the LCA in the last range
```

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

```text
sizes and heavy children (heavy edge drawn ||, light edge drawn --)
             1(5)  size 7, heavy child 2
          ||      --
        2(3)          3(1)  size 2, heavy child 6
      ||    --            ||
    4(2)     5(4)         6(7)
   ||         size 1
 7(6)

chains          head   nodes in order
  chain A         1     1 -> 2 -> 4 -> 7
  chain B         5     5
  chain C         3     3 -> 6

base array (chains laid end to end, heavy child visited first)
  pos  :   0    1    2    3    4    5    6
  node :   1    2    4    7    5    3    6
  value:   5    3    2    6    4    1    7
           <----- chain A ---->  |B|  <-C->

pathSum(7, 6):
  head[7]=1 (depth 0), head[6]=3 (depth 1)  -> 6's head is deeper, move v=6
     take range [pos[3] .. pos[6]] = [5..6] = 1 + 7 = 8 ; v = parent[3] = 1
  head[7]=1, head[1]=1  -> same chain
     take range [pos[1] .. pos[7]] = [0..3] = 5 + 3 + 2 + 6 = 16
  total = 24        (2 ranges instead of walking 6 edges)
```

### Interview explanation
"Path queries on a tree are awkward because a path zig-zags, so it is not a contiguous range in any DFS order. Heavy-light decomposition fixes that: from every node I mark the edge to its largest child as *heavy* and the rest as *light*, which carves the tree into vertical chains, and I number nodes chain by chain so each chain is a contiguous block of one array. The key guarantee is that crossing a light edge at least halves the subtree size — the child I drop into can't hold more than half of the parent's subtree — so any root-to-node path crosses at most log₂ n light edges and therefore at most log₂ n + 1 chains. A path query becomes O(log n) segment-tree range queries, so O(log² n) per query, with O(log n) point updates and O(n) build and space."

---

## 5. Generic Templates

> Two DFS passes: the first finds each node's heaviest child, the second lays the chains out in one array — after that, a path is O(log n) ranges.

```go
// HLD cuts a rooted tree into heavy chains. Each chain occupies a contiguous
// block of positions, so any path is O(log n) ranges over one array.
type HLD struct {
	adj                        [][]int
	parent, depth, size, heavy []int
	head, pos                  []int
	timer                      int
	fen                        *Fenwick
}

func NewHLD(adj [][]int, values []int, root int) *HLD {
	n := len(adj)
	h := &HLD{
		adj: adj, parent: make([]int, n), depth: make([]int, n),
		size: make([]int, n), heavy: make([]int, n),
		head: make([]int, n), pos: make([]int, n),
	}

	// Pass 1: subtree sizes, and the heaviest child of every node.
	var measure func(u, p int)
	measure = func(u, p int) {
		h.parent[u], h.size[u], h.heavy[u] = p, 1, -1
		best := 0
		for _, v := range adj[u] {
			if v == p {
				continue
			}
			h.depth[v] = h.depth[u] + 1
			measure(v, u)
			h.size[u] += h.size[v]
			if h.size[v] > best { // biggest child => heavy edge
				best, h.heavy[u] = h.size[v], v
			}
		}
	}
	measure(root, -1)

	// Pass 2: number the nodes, always continuing down the heavy child first
	// so a whole chain lands on consecutive positions.
	base := make([]int, n)
	var decompose func(u, chainHead int)
	decompose = func(u, chainHead int) {
		h.head[u], h.pos[u] = chainHead, h.timer
		base[h.timer] = values[u]
		h.timer++
		if h.heavy[u] != -1 {
			decompose(h.heavy[u], chainHead) // stay on the same chain
		}
		for _, v := range h.adj[u] {
			if v != h.parent[u] && v != h.heavy[u] {
				decompose(v, v) // light edge starts a brand new chain
			}
		}
	}
	decompose(root, root)

	h.fen = NewFenwick(n)
	for i, v := range base {
		h.fen.Add(i, v)
	}
	return h
}

// Update sets node u's value to newValue in O(log n).
func (h *HLD) Update(u, newValue int) {
	old := h.fen.Range(h.pos[u], h.pos[u])
	h.fen.Add(h.pos[u], newValue-old)
}

// PathSum returns the sum of values on the path u..v inclusive, in O(log^2 n).
func (h *HLD) PathSum(u, v int) int {
	total := 0
	for h.head[u] != h.head[v] {
		if h.depth[h.head[u]] < h.depth[h.head[v]] {
			u, v = v, u // always move the node whose chain head is deeper
		}
		total += h.fen.Range(h.pos[h.head[u]], h.pos[u])
		u = h.parent[h.head[u]] // hop the light edge to the chain above
	}
	if h.pos[u] > h.pos[v] {
		u, v = v, u
	}
	return total + h.fen.Range(h.pos[u], h.pos[v]) // last chain, LCA included
}

// Fenwick: point add + prefix sum in O(log n). Swap for a segment tree if you
// need max/min or lazy range updates instead of sums.
type Fenwick struct{ tree []int }

func NewFenwick(n int) *Fenwick { return &Fenwick{make([]int, n+1)} }

func (f *Fenwick) Add(i, delta int) {
	for i++; i < len(f.tree); i += i & (-i) {
		f.tree[i] += delta
	}
}

func (f *Fenwick) prefix(i int) int {
	s := 0
	for i++; i > 0; i -= i & (-i) {
		s += f.tree[i]
	}
	return s
}

func (f *Fenwick) Range(l, r int) int { return f.prefix(r) - f.prefix(l-1) }
```

```python
class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)

    def add(self, i, delta):
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


class HLD:
    """Heavy-light decomposition: any path is O(log n) contiguous ranges."""

    def __init__(self, adj, values, root=0):
        n = len(adj)
        self.adj = adj
        self.parent = [-1] * n
        self.depth = [0] * n
        self.size = [1] * n
        self.heavy = [-1] * n
        self.head = [0] * n
        self.pos = [0] * n

        # Pass 1: subtree sizes + heaviest child (iterative, post-order).
        order, stack = [], [root]
        while stack:
            u = stack.pop()
            order.append(u)
            for v in adj[u]:
                if v != self.parent[u]:
                    self.parent[v] = u
                    self.depth[v] = self.depth[u] + 1
                    stack.append(v)
        for u in reversed(order):
            best = 0
            for v in adj[u]:
                if v != self.parent[u]:
                    self.size[u] += self.size[v]
                    if self.size[v] > best:
                        best, self.heavy[u] = self.size[v], v

        # Pass 2: heavy child first, so each chain is consecutive.
        base, timer = [0] * n, 0
        stack = [(root, root)]
        while stack:
            u, chain_head = stack.pop()
            while u != -1:
                self.head[u], self.pos[u] = chain_head, timer
                base[timer] = values[u]
                timer += 1
                for v in self.adj[u]:
                    if v != self.parent[u] and v != self.heavy[u]:
                        stack.append((v, v))     # light edge -> new chain
                u = self.heavy[u]                # stay on this chain

        self.fen = Fenwick(n)
        for i, v in enumerate(base):
            self.fen.add(i, v)

    def update(self, u, new_value):
        old = self.fen.range_sum(self.pos[u], self.pos[u])
        self.fen.add(self.pos[u], new_value - old)

    def path_sum(self, u, v):
        total = 0
        while self.head[u] != self.head[v]:
            if self.depth[self.head[u]] < self.depth[self.head[v]]:
                u, v = v, u                       # move the deeper head
            total += self.fen.range_sum(self.pos[self.head[u]], self.pos[u])
            u = self.parent[self.head[u]]         # hop the light edge
        if self.pos[u] > self.pos[v]:
            u, v = v, u
        return total + self.fen.range_sum(self.pos[u], self.pos[v])
```

```java
class Fenwick {
    long[] tree;
    Fenwick(int n) { tree = new long[n + 1]; }
    void add(int i, long d) { for (i++; i < tree.length; i += i & (-i)) tree[i] += d; }
    private long prefix(int i) { long s = 0; for (i++; i > 0; i -= i & (-i)) s += tree[i]; return s; }
    long range(int l, int r) { return prefix(r) - prefix(l - 1); }
}

class HLD {
    java.util.List<java.util.List<Integer>> adj;
    int[] parent, depth, size, heavy, head, pos;
    int timer = 0;
    Fenwick fen;

    HLD(java.util.List<java.util.List<Integer>> adj, int[] values, int root) {
        int n = adj.size();
        this.adj = adj;
        parent = new int[n]; depth = new int[n]; size = new int[n];
        heavy = new int[n];  head = new int[n];  pos = new int[n];
        measure(root, -1);
        long[] base = new long[n];
        decompose(root, root, values, base);
        fen = new Fenwick(n);
        for (int i = 0; i < n; i++) fen.add(i, base[i]);
    }

    private void measure(int u, int p) {            // subtree sizes + heavy child
        parent[u] = p; size[u] = 1; heavy[u] = -1;
        int best = 0;
        for (int v : adj.get(u)) if (v != p) {
            depth[v] = depth[u] + 1;
            measure(v, u);
            size[u] += size[v];
            if (size[v] > best) { best = size[v]; heavy[u] = v; }
        }
    }

    private void decompose(int u, int chainHead, int[] values, long[] base) {
        head[u] = chainHead; pos[u] = timer; base[timer++] = values[u];
        if (heavy[u] != -1) decompose(heavy[u], chainHead, values, base);
        for (int v : adj.get(u))
            if (v != parent[u] && v != heavy[u]) decompose(v, v, values, base);
    }

    void update(int u, long newValue) { fen.add(pos[u], newValue - fen.range(pos[u], pos[u])); }

    long pathSum(int u, int v) {
        long total = 0;
        while (head[u] != head[v]) {
            if (depth[head[u]] < depth[head[v]]) { int t = u; u = v; v = t; }
            total += fen.range(pos[head[u]], pos[u]);
            u = parent[head[u]];
        }
        if (pos[u] > pos[v]) { int t = u; u = v; v = t; }
        return total + fen.range(pos[u], pos[v]);
    }
}
```

```cpp
struct Fenwick {
    vector<long long> tree;
    Fenwick(int n = 0) : tree(n + 1, 0) {}
    void add(int i, long long d) { for (++i; i < (int)tree.size(); i += i & (-i)) tree[i] += d; }
    long long prefix(int i) { long long s = 0; for (++i; i > 0; i -= i & (-i)) s += tree[i]; return s; }
    long long range(int l, int r) { return prefix(r) - prefix(l - 1); }
};

struct HLD {
    vector<vector<int>> adj;
    vector<int> parent, depth, sz, heavy, head, pos;
    vector<long long> base;
    int timer = 0;
    Fenwick fen;

    HLD(vector<vector<int>> g, vector<long long> values, int root)
        : adj(move(g)), parent(adj.size()), depth(adj.size()), sz(adj.size()),
          heavy(adj.size(), -1), head(adj.size()), pos(adj.size()), base(adj.size()) {
        measure(root, -1);
        decompose(root, root, values);
        fen = Fenwick(adj.size());
        for (int i = 0; i < (int)base.size(); i++) fen.add(i, base[i]);
    }

    void measure(int u, int p) {                    // subtree sizes + heavy child
        parent[u] = p; sz[u] = 1; heavy[u] = -1;
        int best = 0;
        for (int v : adj[u]) if (v != p) {
            depth[v] = depth[u] + 1;
            measure(v, u);
            sz[u] += sz[v];
            if (sz[v] > best) { best = sz[v]; heavy[u] = v; }
        }
    }

    void decompose(int u, int chainHead, const vector<long long>& values) {
        head[u] = chainHead; pos[u] = timer; base[timer++] = values[u];
        if (heavy[u] != -1) decompose(heavy[u], chainHead, values);
        for (int v : adj[u])
            if (v != parent[u] && v != heavy[u]) decompose(v, v, values);
    }

    void update(int u, long long newValue) { fen.add(pos[u], newValue - fen.range(pos[u], pos[u])); }

    long long pathSum(int u, int v) {
        long long total = 0;
        while (head[u] != head[v]) {
            if (depth[head[u]] < depth[head[v]]) swap(u, v);
            total += fen.range(pos[head[u]], pos[u]);
            u = parent[head[u]];
        }
        if (pos[u] > pos[v]) swap(u, v);
        return total + fen.range(pos[u], pos[v]);
    }
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
Alice starts at node `0` and walks to some leaf; Bob starts at node `bob` and walks to node `0`. They move one edge per second, at the same time. Each node has an `amount` (income if positive, toll if negative) that is collected by whoever arrives **first**; on a tie they split it. Maximise Alice's net income.

### Thought Process
1. Bob has no choice: his route is the unique **root path** from `bob` up to `0`. Stamp `bobTime[node] = t` while climbing it — this is a path annotation, the same object HLD accelerates when there are many such paths (here there is exactly one, so a plain parent-climb is already optimal).
2. Alice's arrival time at a node is simply its depth, because she never backtracks.
3. So each node's payout is decided locally: `bobTime` missing or later → full `amount`; equal → half; earlier → nothing.
4. One DFS from the root carries the running total down; every leaf produces one candidate answer.
5. Return the maximum candidate.

### Dry Run

Input: `edges = [[0,1],[1,2],[1,3],[3,4]]`, `bob = 3`, `amount = [-2,4,2,-4,6]`

Bob's climb `3 → 1 → 0` stamps `bobTime = {3:0, 1:1, 0:2}`; nodes 2 and 4 are never visited by Bob.

| Alice at | her time `t` | `bobTime` | comparison | she collects | running total | leaf? |
|----------|--------------|-----------|------------|--------------|---------------|-------|
| 0 | 0 | 2 | Bob later | −2 | **−2** | no |
| 1 | 1 | 1 | **tie** | 4 / 2 = 2 | **0** | no |
| 2 | 2 | none | Bob never comes | +2 | **2** | yes → candidate 2 |
| 3 | 2 | 0 | Bob was earlier | 0 | **0** | no |
| 4 | 3 | none | Bob never comes | +6 | **6** | yes → candidate 6 |

Output: **6**

The row for node 1 is the subtle one: Alice and Bob step onto it in the same second, so the gate opens together and the `4` is split. The row for node 3 shows the other half of the rule — Bob passed through two seconds before Alice, so the `−4` toll is already paid and costs her nothing.

### Visualization

```text
tree (rooted at 0)          Bob's root path      Alice's arrival times
      0(-2)                   3 -> 1 -> 0          0 : t=0
        |                     t: 0    1    2       1 : t=1
      1( 4)                                        2 : t=2   (leaf)
     /     \                                       3 : t=2
   2( 2)   3(-4)                                   4 : t=3   (leaf)
              |
            4( 6)

per-node verdict          -2       0/tie      earlier      never
  node                     0    ->   1     ->    3      ->   4
  Alice gets              -2        +2           +0         +6   = 6  <-- best
  other branch            -2        +2                      +2   = 2
```

### Code

```go
func mostProfitablePath(edges [][]int, bob int, amount []int) int {
	n := len(amount)
	adj := make([][]int, n)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
		adj[e[1]] = append(adj[e[1]], e[0])
	}

	// Parents, so we can climb Bob's root path.
	parent := make([]int, n)
	var setParents func(u, p int)
	setParents = func(u, p int) {
		parent[u] = p
		for _, v := range adj[u] {
			if v != p {
				setParents(v, u)
			}
		}
	}
	setParents(0, -1)

	bobTime := make([]int, n)
	for i := range bobTime {
		bobTime[i] = -1 // -1 means "Bob never gets here"
	}
	for v, t := bob, 0; v != -1; v, t = parent[v], t+1 {
		bobTime[v] = t
	}

	best := math.MinInt32
	var walk func(u, p, t, sum int)
	walk = func(u, p, t, sum int) {
		switch {
		case bobTime[u] == -1 || bobTime[u] > t:
			sum += amount[u] // Alice is first
		case bobTime[u] == t:
			sum += amount[u] / 2 // they arrive together, split it
		default:
			// Bob already opened this gate; Alice gets nothing.
		}
		isLeaf := true
		for _, v := range adj[u] {
			if v != p {
				isLeaf = false
				walk(v, u, t+1, sum)
			}
		}
		if isLeaf && sum > best {
			best = sum
		}
	}
	walk(0, -1, 0, 0)
	return best
}
```

```python
def mostProfitablePath(edges, bob, amount):
    n = len(amount)
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)

    parent = [-1] * n
    stack = [0]
    seen = [False] * n
    seen[0] = True
    while stack:                       # parents, so we can climb Bob's path
        u = stack.pop()
        for v in adj[u]:
            if not seen[v]:
                seen[v] = True
                parent[v] = u
                stack.append(v)

    bob_time = [-1] * n                # -1 means Bob never gets there
    v, t = bob, 0
    while v != -1:
        bob_time[v] = t
        v, t = parent[v], t + 1

    best = float("-inf")
    stack = [(0, -1, 0, 0)]
    while stack:
        u, p, time, total = stack.pop()
        if bob_time[u] == -1 or bob_time[u] > time:
            total += amount[u]
        elif bob_time[u] == time:
            total += amount[u] // 2 if amount[u] >= 0 else -((-amount[u]) // 2)
        is_leaf = True
        for w in adj[u]:
            if w != p:
                is_leaf = False
                stack.append((w, u, time + 1, total))
        if is_leaf:
            best = max(best, total)
    return best
```

### Complexity
Time O(n) — one pass for parents, one climb up Bob's path, one DFS for Alice. Space O(n) for adjacency, `parent`, `bobTime` and the stack.

---

## 10. Solved Example 2

### Problem — Build Rooms (LeetCode 1916)
`prevRoom[i]` is the room that must be built before room `i` (room 0 is the entrance, `prevRoom[0] = -1`). You build one room per step and may only build a room whose predecessor already exists. Count the valid build orders, modulo 1e9+7.

### Thought Process
1. `prevRoom` describes a rooted tree, and a valid build order is a **topological order** of that tree.
2. HLD's very first pass computes `size[u]`, the number of nodes in `u`'s subtree — that is exactly the quantity this problem is made of, so it is a clean drill on step 1 of the decomposition.
3. Take all `n!` permutations of the rooms. A permutation is valid iff, for **every** node `u`, `u` appears before all `size[u] - 1` of its descendants.
4. Inside the `size[u]` positions its subtree occupies, `u` is equally likely to be any of them, so the chance it is first is `1 / size[u]`; these events over different nodes are independent, giving `answer = n! / Π size[u]`.
5. Division under a prime modulus is multiplication by the modular inverse: `pow(denominator, MOD-2, MOD)`.

### Dry Run

Input: `prevRoom = [-1, 0, 0, 1, 2]`

```text
tree           0
             /   \
            1     2
            |     |
            3     4
```

| node | subtree | `size` | factor `1/size` |
|------|---------|--------|------------------|
| 0 | {0,1,2,3,4} | 5 | 1/5 |
| 1 | {1,3} | 2 | 1/2 |
| 2 | {2,4} | 2 | 1/2 |
| 3 | {3} | 1 | 1/1 |
| 4 | {4} | 1 | 1/1 |

`n! = 5! = 120`, `Π size = 5 · 2 · 2 · 1 · 1 = 20`, so `120 / 20 = 6`.

Output: **6**

Sanity check by hand — room 0 is always first, then we interleave the chain `1,3` with the chain `2,4`:
`0 1 3 2 4`, `0 1 2 3 4`, `0 1 2 4 3`, `0 2 4 1 3`, `0 2 1 4 3`, `0 2 1 3 4` — exactly 6.

### Visualization

```text
think of it as shuffling two chains after the root

      0
     / \          chain L : 1 -> 3        chain R : 2 -> 4
    1   2
    |   |         valid orders = ways to interleave L and R
    3   4                      = C(4,2) = 6      (matches 5!/(5*2*2))

why n! / prod(size):
  positions of subtree(1) = {1,3} inside any permutation: 2 slots
  1 must take the earlier slot  ->  half of all permutations survive
  same independent test at every node  ->  divide by size[u] for each u
```

### Code

```go
func waysToBuildRooms(prevRoom []int) int {
	const mod = 1_000_000_007
	n := len(prevRoom)

	children := make([][]int, n)
	for room := 1; room < n; room++ {
		p := prevRoom[room]
		children[p] = append(children[p], room)
	}

	// Same first pass HLD uses: subtree sizes.
	size := make([]int, n)
	var measure func(u int)
	measure = func(u int) {
		size[u] = 1
		for _, c := range children[u] {
			measure(c)
			size[u] += size[c]
		}
	}
	measure(0)

	powMod := func(base, exp int) int {
		result := 1
		base %= mod
		for exp > 0 {
			if exp&1 == 1 {
				result = result * base % mod
			}
			base = base * base % mod
			exp >>= 1
		}
		return result
	}

	factorial := 1
	for i := 2; i <= n; i++ {
		factorial = factorial * i % mod
	}
	denominator := 1
	for u := 0; u < n; u++ {
		denominator = denominator * size[u] % mod
	}
	// n! / prod(size)  ==  n! * inverse(prod(size))  under a prime modulus.
	return factorial * powMod(denominator, mod-2) % mod
}
```

```python
def waysToBuildRooms(prevRoom):
    MOD = 10 ** 9 + 7
    n = len(prevRoom)

    children = [[] for _ in range(n)]
    for room in range(1, n):
        children[prevRoom[room]].append(room)

    size = [1] * n
    order, stack = [], [0]
    while stack:                       # iterative pre-order, then reverse it
        u = stack.pop()
        order.append(u)
        stack.extend(children[u])
    for u in reversed(order):          # children are finished before their parent
        for c in children[u]:
            size[u] += size[c]

    factorial = 1
    for i in range(2, n + 1):
        factorial = factorial * i % MOD

    denominator = 1
    for s in size:
        denominator = denominator * s % MOD

    return factorial * pow(denominator, MOD - 2, MOD) % MOD
```

### Complexity
Time O(n log MOD) — O(n) for sizes, factorial and the product, plus one O(log MOD) modular exponentiation. Space O(n) for the children lists and `size`.

---

## 11. Solved Example 3

### Problem — Diff Costs (LeetCode 2538)
Every node has a `price`. Root the tree at any node `r`; the cost of that choice is `(largest price-sum of a path starting at r) − (smallest price-sum of a path starting at r)`. Since prices are positive the smallest such path is `r` alone, so the cost is "best downward path from `r`, minus `r`'s own price". Return the largest cost over all choices of `r`.

### Thought Process
1. Rewrite it without the "choose a root" wrapper: the answer is the maximum, over all paths in the tree, of **(sum of the path) − (price of one endpoint)**.
2. That is a maximum over tree paths — the family HLD serves. With values that never change, one DFS beats a decomposition, and recognising *that* is half the skill.
3. For each node keep two downward-path bests: `a[u]` counts every node including the far endpoint, `b[u]` drops the far endpoint's price.
4. At `u`, glue the best branch found so far to the branch just returned: `a_so_far + b_child` and `b_so_far + a_child` are both legal paths through `u` with exactly one endpoint dropped.
5. Seed `a = price[u]`, `b = 0` so that "no branch yet" also covers paths that end at `u` itself.

### Dry Run

Input: `edges = [[0,1],[1,2],[1,3],[3,4],[3,5]]`, `price = [9,8,7,6,10,5]`

```text
       0(9)
        |
       1(8)
      /    \
    2(7)   3(6)
          /    \
       4(10)   5(5)
```

Post-order. `a` = best downward path with the endpoint counted, `b` = with the endpoint dropped.

| at node | child merged | `a_child` | `b_child` | cand `a+b_child` | cand `b+a_child` | best so far | new `a` | new `b` |
|---------|--------------|-----------|-----------|------------------|------------------|-------------|---------|---------|
| 2 (leaf) | — | — | — | — | — | 0 | 7 | 0 |
| 4 (leaf) | — | — | — | — | — | 0 | 10 | 0 |
| 5 (leaf) | — | — | — | — | — | 0 | 5 | 0 |
| 3 (6) | seed | — | — | — | — | 0 | 6 | 0 |
| 3 | 4 | 10 | 0 | 6+0 = 6 | 0+10 = 10 | **10** | 16 | 6 |
| 3 | 5 | 5 | 0 | 16+0 = 16 | 6+5 = 11 | **16** | 16 | 6 |
| 1 (8) | seed | — | — | — | — | 16 | 8 | 0 |
| 1 | 2 | 7 | 0 | 8+0 = 8 | 0+7 = 7 | 16 | 15 | 8 |
| 1 | 3 | 16 | 6 | 15+6 = 21 | 8+16 = **24** | **24** | 24 | 14 |
| 0 (9) | seed | — | — | — | — | 24 | 9 | 0 |
| 0 | 1 | 24 | 14 | 9+14 = 23 | 0+24 = 24 | 24 | 33 | 23 |

Output: **24**

The winning row is `at node 1, child 3`: `b = 8` is the path `1 → 2` with node 2's price *dropped* (0 + 8), and `a_child = 16` is the path `3 → 4` fully counted (6 + 10). Glued, that is the path `2 – 1 – 3 – 4` with endpoint `2` dropped: `0 + 8 + 6 + 10 = 24`. Full path sum is `7+8+6+10 = 31`, minus the dropped endpoint `7`, giving `24`.

### Visualization

```text
the winning path, with one endpoint's price removed

     2(7)  ---  1(8)  ---  3(6)  ---  4(10)
      ^dropped   +8         +6          +10      = 24
      (this endpoint is the "root" r, whose own price cancels out)

what a and b mean, at node 3
  a[3] = 6 + 10 = 16     path 3 -> 4, node 4's price counted
  b[3] = 6 + 0  = 6      path 3 -> 4, node 4's price dropped
       (b never counts the far endpoint, so b of a leaf is 0)
```

### Code

```go
func maxOutput(n int, edges [][]int, price []int) int64 {
	adj := make([][]int, n)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
		adj[e[1]] = append(adj[e[1]], e[0])
	}

	var best int64
	// walk returns (a, b) for the subtree rooted at u:
	//   a = best downward path from u with the far endpoint's price counted
	//   b = best downward path from u with the far endpoint's price dropped
	var walk func(u, parent int) (int64, int64)
	walk = func(u, parent int) (int64, int64) {
		a := int64(price[u]) // just u, counted
		b := int64(0)        // just u, and u is the dropped endpoint
		for _, v := range adj[u] {
			if v == parent {
				continue
			}
			ca, cb := walk(v, u)
			// Glue the best branch seen so far to this new branch.
			if a+cb > best {
				best = a + cb
			}
			if b+ca > best {
				best = b + ca
			}
			if ca+int64(price[u]) > a {
				a = ca + int64(price[u])
			}
			if cb+int64(price[u]) > b {
				b = cb + int64(price[u])
			}
		}
		return a, b
	}
	walk(0, -1)
	return best
}
```

```python
def maxOutput(n, edges, price):
    adj = [[] for _ in range(n)]
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)

    best = 0

    def walk(u, parent):
        # a: best downward path from u counting the far endpoint
        # b: best downward path from u dropping the far endpoint
        nonlocal best
        a, b = price[u], 0
        for v in adj[u]:
            if v == parent:
                continue
            ca, cb = walk(v, u)
            best = max(best, a + cb, b + ca)   # glue two branches through u
            a = max(a, ca + price[u])
            b = max(b, cb + price[u])
        return a, b

    walk(0, -1)
    return best
```

### Complexity
Time O(n) — each edge is walked once and each merge is O(1). Space O(n) for adjacency plus O(height) recursion (use an explicit stack if the tree can be 1e5 deep).

---

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
