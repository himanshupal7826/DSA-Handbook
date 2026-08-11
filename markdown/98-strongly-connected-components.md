# 98 · Strongly Connected Components

> **One-liner:** Kosaraju/Tarjan group mutually reachable nodes in directed graphs.

---

## 1. Overview

### Definition
The **Strongly Connected Components** pattern belongs to the *Advanced* family. Kosaraju/Tarjan group mutually reachable nodes in directed graphs.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
scc, kosaraju, tarjan, condensation, directed cycle.

### Constraints
- Input size where the brute-force complexity would time out — the Strongly Connected Components optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Strongly Connected Components invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Strongly Connected Components is the upgrade.
- The wording maps onto: scc, kosaraju, tarjan, condensation, directed cycle.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which nodes can reach each other **both ways** — and therefore sit on a common cycle?"*

### Intuition
Test every pair for mutual reachability.

### Algorithm
1. For each pair `(u, v)`:
2. &nbsp;&nbsp;Run a DFS from `u` to see whether `v` is reachable.
3. &nbsp;&nbsp;Run another from `v` back to `u`.
4. &nbsp;&nbsp;If both succeed, they belong to the same strongly connected component.
5. Group the pairs into components.

### Complexity
- Time: **O(V² · (V + E))** — a traversal per ordered pair.
- Space: O(V).

### Drawbacks
- Hopeless past a few hundred nodes.
- And it misses the structure: strong connectivity is an **equivalence relation**, so the components partition the graph. Discovering that partition should take one pass, not `V²` of them.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A single DFS already knows enough: track, for each node, the oldest node its subtree can reach via a back edge — and where that "reach back" stops, a component ends.**

That value is the **low-link**, and it powers this whole family.

### The thought process

```text
We need    : the groups of mutually reachable nodes.
Obvious way: test every pair both ways.
Too slow   : O(V^2 (V+E)).
Notice     : strong connectivity is an equivalence relation, so the
             components PARTITION the graph — one pass should find all.
Notice too : during a DFS, a node closes off a component exactly when
             nothing in its subtree can reach anything older than itself.
Therefore  : record a discovery index per node and propagate the
             oldest reachable index back up.
Now        : O(V + E), one traversal.
```

### The two numbers every low-link algorithm keeps

```text
discovery[u] = when u was first visited (a counter, incremented per node)
low[u]       = the SMALLEST discovery index reachable from u's subtree,
               using tree edges plus AT MOST ONE back edge
```

The update rules, applied while exploring `u`'s neighbours:

```text
v not yet visited  →  recurse, then  low[u] = min(low[u], low[v])
v already visited  →  a back edge:   low[u] = min(low[u], discovery[v])
```

Note the asymmetry: a **tree edge** propagates the child's `low`, while a **back edge** contributes only the target's `discovery`. Using `low[v]` for a back edge would let information leak across components.

### What low-link tells you, in two different graphs

The same two numbers answer two famous questions, depending on the graph type:

**Directed — strongly connected components.** `u` is the *root* of a component exactly when

```text
low[u] == discovery[u]
```

meaning nothing in `u`'s subtree can reach any node discovered earlier. Everything still on the stack above `u` forms its component.

**Undirected — bridges.** The edge `u → v` (a tree edge) is a **bridge** exactly when

```text
low[v] > discovery[u]
```

meaning `v`'s entire subtree has no back edge reaching `u` or anything above it, so removing that edge disconnects the subtree.

```text
low[v] >  discovery[u]   →  bridge (nothing routes around it)
low[v] <= discovery[u]   →  a cycle bypasses this edge
```

### The condensation, and why it is useful

Collapse every strongly connected component to a single node and you get the **condensation** — which is always a **DAG**, because a cycle between two components would have merged them.

That makes a whole class of problems easy:

| Question | On the condensation |
|---|---|
| Is a node on a cycle? | its component has size > 1 (or a self-loop) |
| Longest cycle | the largest component's size |
| Nodes that cannot reach a cycle | reachability in the DAG |
| Minimum nodes to reach everything | components with in-degree 0 |

### Tarjan or Kosaraju?

| | Tarjan | Kosaraju |
|---|---|---|
| Passes over the graph | **one** | two |
| Needs the reversed graph | no | **yes** |
| Extra state | stack + `low` + `discovery` | finish order + reversed adjacency |
| Easier to remember | — | **often** |

Both are O(V + E). Kosaraju — DFS to get finish times, then DFS the reversed graph in decreasing finish order — is easier to reconstruct under pressure; Tarjan is one pass and gives low-link, which you need for bridges anyway.

### Recursion depth

Both algorithms recurse to the depth of the DFS tree, which is `O(V)`. At `V = 10⁵` that can overflow the stack in several languages. Convert to an explicit stack if the constraints are large — the logic is identical, only the bookkeeping changes.

### Steps

```text
Step 1 → give every node discovery = low = timer++, push it, mark it on-stack.
Step 2 → for each neighbour v:
           unvisited  → recurse, then low[u] = min(low[u], low[v])
           on-stack   → low[u] = min(low[u], discovery[v])
           visited but off-stack → ignore it (finished component)
Step 3 → after the loop, if low[u] == discovery[u], pop the stack down to u:
           that popped block is one strongly connected component.
Step 4 → restart from any node still unvisited, so disconnected parts are covered.
Step 5 → undirected variant: drop the stack, skip the parent edge, and report
           u–v as a bridge whenever low[v] > discovery[u].
```

### How should I recognize this?

```text
If you see...
  a DIRECTED graph plus "cycle", "mutually reachable", "can return to"
  "eventual safe states", "longest cycle", "condense the graph"
  an UNDIRECTED graph plus "critical connection", "bridge", "single point
  of failure"
        ↓
Think about...
  "Can this subtree reach back past its parent?"
        ↓
Use...
  directed   → Tarjan/Kosaraju SCC; the condensation is a DAG
  undirected → the same low-link, with low[v] > discovery[u] for bridges
```

### Visual explanation

```svg
<svg viewBox="0 0 640 290" width="100%" height="290" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="scc-98" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Group mutually reachable nodes into SCCs, then condense to a DAG</text>
  <text x="150" y="44" text-anchor="middle" fill="#64748b" font-weight="700">directed graph</text>
  <!-- SCC A blob -->
  <rect x="40" y="55" width="150" height="95" rx="12" fill="#ecfdf5" stroke="#059669" stroke-dasharray="5 4"/>
  <text x="115" y="72" text-anchor="middle" fill="#059669" font-weight="700">SCC A</text>
  <!-- SCC B blob -->
  <rect x="55" y="175" width="120" height="80" rx="12" fill="#eff6ff" stroke="#2563eb" stroke-dasharray="5 4"/>
  <text x="115" y="192" text-anchor="middle" fill="#2563eb" font-weight="700">SCC B</text>
  <!-- cycle A: 1->2->3->1 -->
  <line x1="82" y1="100" x2="140" y2="90" stroke="#475569" marker-end="url(#scc-98)"/>
  <line x1="150" y1="105" x2="120" y2="135" stroke="#475569" marker-end="url(#scc-98)"/>
  <line x1="105" y1="130" x2="75" y2="112" stroke="#475569" marker-end="url(#scc-98)"/>
  <circle cx="72" cy="102" r="15" fill="#fff" stroke="#059669"/><text x="72" y="106" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="152" cy="88" r="15" fill="#fff" stroke="#059669"/><text x="152" y="92" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="118" cy="138" r="15" fill="#fff" stroke="#059669"/><text x="118" y="142" text-anchor="middle" fill="#1e293b">3</text>
  <!-- cycle B: 4<->5 -->
  <line x1="88" y1="210" x2="132" y2="210" stroke="#475569" marker-end="url(#scc-98)"/>
  <line x1="132" y1="222" x2="88" y2="222" stroke="#475569" marker-end="url(#scc-98)"/>
  <circle cx="75" cy="216" r="15" fill="#fff" stroke="#2563eb"/><text x="75" y="220" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="145" cy="216" r="15" fill="#fff" stroke="#2563eb"/><text x="145" y="220" text-anchor="middle" fill="#1e293b">5</text>
  <!-- node 6 (SCC C) -->
  <circle cx="115" cy="272" r="15" fill="#fff7ed" stroke="#d97706"/><text x="115" y="276" text-anchor="middle" fill="#1e293b">6</text>
  <text x="150" y="276" text-anchor="middle" fill="#d97706" font-weight="700">SCC C</text>
  <!-- cross edges A->B, B->C -->
  <line x1="118" y1="153" x2="118" y2="198" stroke="#475569" marker-end="url(#scc-98)"/>
  <line x1="130" y1="230" x2="118" y2="258" stroke="#475569" marker-end="url(#scc-98)"/>
  <!-- condensation DAG -->
  <text x="470" y="44" text-anchor="middle" fill="#64748b" font-weight="700">condensation (DAG)</text>
  <line x1="470" y1="95" x2="470" y2="150" stroke="#475569" stroke-width="2" marker-end="url(#scc-98)"/>
  <line x1="470" y1="185" x2="470" y2="235" stroke="#475569" stroke-width="2" marker-end="url(#scc-98)"/>
  <circle cx="470" cy="75" r="22" fill="#ecfdf5" stroke="#059669"/><text x="470" y="79" text-anchor="middle" fill="#1e293b" font-weight="700">A</text>
  <circle cx="470" cy="170" r="22" fill="#eff6ff" stroke="#2563eb"/><text x="470" y="174" text-anchor="middle" fill="#1e293b" font-weight="700">B</text>
  <circle cx="470" cy="258" r="22" fill="#fff7ed" stroke="#d97706"/><text x="470" y="262" text-anchor="middle" fill="#1e293b" font-weight="700">C</text>
  <text x="560" y="170" text-anchor="middle" fill="#64748b">no cycles</text>
  <text x="560" y="188" text-anchor="middle" fill="#64748b">between SCCs</text>
</svg>
```

```text
directed graph:   0 → 1 → 2 → 0        and   2 → 3

DFS from 0, discovery indices in order:

   node :  0   1   2   3
   disc :  0   1   2   3
   low  :  0   0   0   3
                        ↑
              3 reaches nothing older than itself
              → low[3] == disc[3] → 3 is its own component

   0, 1, 2 all reach back to discovery 0
              → low == disc only at node 0
              → {0, 1, 2} is one component

condensation:   {0,1,2} → {3}        a DAG, as it must be
```

### Interview explanation
"I'll use a single DFS carrying two numbers per node: `discovery`, the order it was first visited, and `low`, the oldest discovery index reachable from its subtree using at most one back edge. A tree edge propagates the child's `low` upward; a back edge contributes only the target's `discovery`, which matters because using the child's `low` there would leak information across components. In a directed graph, a node whose `low` equals its own `discovery` is the root of a strongly connected component — nothing beneath it reaches anything older — and everything above it on the stack is that component. In an undirected graph the same two numbers find bridges: a tree edge to `v` is a bridge exactly when `low[v] > discovery[u]`, meaning nothing in `v`'s subtree routes back around it. Both are O(V + E) in one pass. Collapsing each component gives the condensation, which is always a DAG — that's what makes 'longest cycle' or 'which nodes can reach a cycle' straightforward afterwards."

---

## 5. Generic Templates

> One DFS, two numbers per node. `low == discovery` closes a component; `low[v] > discovery[u]` marks a bridge.

```go
// TarjanSCC returns the strongly connected components of a directed graph.
// One pass, O(V + E).
func TarjanSCC(graph [][]int) [][]int {
    n := len(graph)

    const unvisited = -1
    discovery := make([]int, n)
    low := make([]int, n)
    onStack := make([]bool, n)
    for i := range discovery {
        discovery[i] = unvisited
    }

    stack := []int{}
    timer := 0
    components := [][]int{}

    var explore func(u int)
    explore = func(u int) {
        discovery[u] = timer
        low[u] = timer
        timer++
        stack = append(stack, u)
        onStack[u] = true

        for _, v := range graph[u] {
            if discovery[v] == unvisited {
                explore(v)
                // Tree edge: propagate the child's low.
                if low[v] < low[u] {
                    low[u] = low[v]
                }
            } else if onStack[v] {
                // Back edge: use DISCOVERY, not low — using low here
                // would leak reachability across components.
                if discovery[v] < low[u] {
                    low[u] = discovery[v]
                }
            }
        }

        // Nothing beneath u reaches anything older: u closes a component.
        if low[u] == discovery[u] {
            component := []int{}
            for {
                top := stack[len(stack)-1]
                stack = stack[:len(stack)-1]
                onStack[top] = false
                component = append(component, top)
                if top == u {
                    break
                }
            }
            components = append(components, component)
        }
    }

    for u := 0; u < n; u++ {
        if discovery[u] == unvisited {
            explore(u)
        }
    }
    return components
}

// FindBridges returns the bridges of an UNDIRECTED graph using the same
// low-link machinery.
func FindBridges(n int, graph [][]int) [][]int {
    const unvisited = -1
    discovery := make([]int, n)
    low := make([]int, n)
    for i := range discovery {
        discovery[i] = unvisited
    }

    timer := 0
    bridges := [][]int{}

    var explore func(u, parent int)
    explore = func(u, parent int) {
        discovery[u] = timer
        low[u] = timer
        timer++

        for _, v := range graph[u] {
            if v == parent {
                continue // do not walk straight back up the tree edge
            }
            if discovery[v] == unvisited {
                explore(v, u)
                if low[v] < low[u] {
                    low[u] = low[v]
                }
                // v's subtree cannot reach u or above → this edge is critical.
                if low[v] > discovery[u] {
                    bridges = append(bridges, []int{u, v})
                }
            } else if discovery[v] < low[u] {
                low[u] = discovery[v] // back edge
            }
        }
    }

    for u := 0; u < n; u++ {
        if discovery[u] == unvisited {
            explore(u, -1)
        }
    }
    return bridges
}
```

```python
def tarjan_scc(graph):
    """Strongly connected components of a directed graph, in one pass."""
    n = len(graph)
    UNVISITED = -1
    discovery = [UNVISITED] * n
    low = [0] * n
    on_stack = [False] * n
    stack, components = [], []
    timer = 0

    def explore(u):
        nonlocal timer
        discovery[u] = low[u] = timer
        timer += 1
        stack.append(u)
        on_stack[u] = True

        for v in graph[u]:
            if discovery[v] == UNVISITED:
                explore(v)
                low[u] = min(low[u], low[v])        # tree edge: child's low
            elif on_stack[v]:
                low[u] = min(low[u], discovery[v])  # back edge: DISCOVERY

        if low[u] == discovery[u]:                  # u closes a component
            component = []
            while True:
                top = stack.pop()
                on_stack[top] = False
                component.append(top)
                if top == u:
                    break
            components.append(component)

    for u in range(n):
        if discovery[u] == UNVISITED:
            explore(u)
    return components

def find_bridges(n, graph):
    """Bridges of an UNDIRECTED graph, same low-link machinery."""
    UNVISITED = -1
    discovery = [UNVISITED] * n
    low = [0] * n
    bridges = []
    timer = 0

    def explore(u, parent):
        nonlocal timer
        discovery[u] = low[u] = timer
        timer += 1

        for v in graph[u]:
            if v == parent:
                continue                            # do not re-cross the tree edge
            if discovery[v] == UNVISITED:
                explore(v, u)
                low[u] = min(low[u], low[v])
                if low[v] > discovery[u]:           # nothing routes around it
                    bridges.append([u, v])
            else:
                low[u] = min(low[u], discovery[v])  # back edge

    for u in range(n):
        if discovery[u] == UNVISITED:
            explore(u, -1)
    return bridges
```

```java
import java.util.*;

public class StronglyConnected {
    private int[] discovery, low;
    private boolean[] onStack;
    private Deque<Integer> stack;
    private int timer;
    private List<List<Integer>> components;

    public List<List<Integer>> tarjanSCC(List<List<Integer>> graph) {
        int n = graph.size();
        discovery = new int[n];
        low = new int[n];
        onStack = new boolean[n];
        Arrays.fill(discovery, -1);
        stack = new ArrayDeque<>();
        components = new ArrayList<>();
        timer = 0;

        for (int u = 0; u < n; u++)
            if (discovery[u] == -1) explore(graph, u);
        return components;
    }

    private void explore(List<List<Integer>> graph, int u) {
        discovery[u] = low[u] = timer++;
        stack.push(u);
        onStack[u] = true;

        for (int v : graph.get(u)) {
            if (discovery[v] == -1) {
                explore(graph, v);
                low[u] = Math.min(low[u], low[v]);          // tree edge
            } else if (onStack[v]) {
                low[u] = Math.min(low[u], discovery[v]);    // back edge
            }
        }

        if (low[u] == discovery[u]) {                       // component root
            List<Integer> component = new ArrayList<>();
            int top;
            do {
                top = stack.pop();
                onStack[top] = false;
                component.add(top);
            } while (top != u);
            components.add(component);
        }
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

vector<int> discoveryTime, lowLink;
vector<bool> onStack;
vector<int> sccStack;
int sccTimer;
vector<vector<int>> sccComponents;

void exploreSCC(const vector<vector<int>>& graph, int u) {
    discoveryTime[u] = lowLink[u] = sccTimer++;
    sccStack.push_back(u);
    onStack[u] = true;

    for (int v : graph[u]) {
        if (discoveryTime[v] == -1) {
            exploreSCC(graph, v);
            lowLink[u] = min(lowLink[u], lowLink[v]);           // tree edge
        } else if (onStack[v]) {
            lowLink[u] = min(lowLink[u], discoveryTime[v]);     // back edge
        }
    }

    if (lowLink[u] == discoveryTime[u]) {                       // component root
        vector<int> component;
        while (true) {
            int top = sccStack.back();
            sccStack.pop_back();
            onStack[top] = false;
            component.push_back(top);
            if (top == u) break;
        }
        sccComponents.push_back(component);
    }
}

vector<vector<int>> tarjanSCC(const vector<vector<int>>& graph) {
    int n = (int)graph.size();
    discoveryTime.assign(n, -1);
    lowLink.assign(n, 0);
    onStack.assign(n, false);
    sccStack.clear();
    sccComponents.clear();
    sccTimer = 0;

    for (int u = 0; u < n; ++u)
        if (discoveryTime[u] == -1) exploreSCC(graph, u);
    return sccComponents;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Strongly Connected Components (Optimal) |
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

### Problem — Eventual Safe States (LeetCode 802)
In a directed graph, a node is **safe** if *every* path leaving it ends at a terminal node (a node with no outgoing edges). Return all safe nodes in ascending order.

### Thought Process
1. A walk fails to terminate only by looping forever, so a node is **unsafe** exactly when it can reach a cycle.
2. Cycles are precisely what SCCs expose: a component is *cyclic* when it has more than one node, or one node with a self-loop.
3. So: every node of a cyclic component is unsafe, and so is every node that can reach such a component.
4. "Can reach" over the condensation is easy because the condensation is a **DAG** — one sweep in reverse topological order settles it.
5. Tarjan already **emits components in reverse topological order** (sinks first), so by the time a component pops, all components it points to are already labelled. One pass, no extra sort.

### Dry Run

Input: `graph = [[1,2],[2,3],[5],[0],[5],[],[]]`

Edges: `0→1, 0→2, 1→2, 1→3, 2→5, 3→0, 4→5`; nodes `5` and `6` are terminal.

DFS from node 0, `timer` starting at 0:

| # | at node | discovery | low | what happens |
|---|---|---|---|---|
| 1 | 0 | 0 | 0 | push 0, follow `0→1` |
| 2 | 1 | 1 | 1 | push 1, follow `1→2` |
| 3 | 2 | 2 | 2 | push 2, follow `2→5` |
| 4 | 5 | 3 | 3 | terminal; `low == discovery` → **pop {5} = C0** |
| 5 | back at 2 | 2 | 2 | `low[5]=3` doesn't lower it; `low == discovery` → **pop {2} = C1** |
| 6 | 3 | 4 | **0** | back edge `3→0`, 0 is on the stack → `low[3] = discovery[0] = 0` |
| 7 | back at 1 | 1 | **0** | `low[1] = min(1, low[3]=0) = 0 ≠ 1` → stays on the stack |
| 8 | back at 0 | 0 | 0 | `0→2`: visited but **off** the stack → ignored; `low == discovery` → **pop {3,1,0} = C2** |
| 9 | 4 | 5 | 5 | `4→5`: off the stack → ignored → **pop {4} = C3** |
| 10 | 6 | 6 | 6 | terminal → **pop {6} = C4** |

Now walk the components in that same emission order — each one's successors are already decided:

| component | members | cyclic? | points to | unsafe? |
|---|---|---|---|---|
| C0 | {5} | no (size 1, no self-loop) | — | no |
| C1 | {2} | no | C0 (safe) | no |
| C2 | {0,1,3} | **yes** (size 3) | C1 | **yes** |
| C3 | {4} | no | C0 (safe) | no |
| C4 | {6} | no | — | no |

Output: **[2, 4, 5, 6]**

Row 8 is the one to stare at. Node 2 was already popped when `0→2` was examined, so `onStack[2]` is false and the edge is skipped — exactly right, because 2 lives in a *finished* component and cannot lead back to 0. Had we used `low[2]` there instead of ignoring it, reachability would have leaked between components.

### Visualization

```text
original graph                     condensation (a DAG)

  0 ⇄ 1 → 3                          ┌─────────┐
  │   │   │                          │ C2      │  cyclic → unsafe
  ↓   ↓   └──→ 0                     │ {0,1,3} │
  2   2                              └────┬────┘
  │                                       ↓
  ↓          4 → 5     6                ┌────┐      ┌────┐
  5                                     │ C1 │      │ C3 │
                                        │{2} │      │{4} │
  cycle: 0 → 1 → 3 → 0                  └─┬──┘      └─┬──┘
                                          └────┬──────┘
                                               ↓
                                            ┌────┐   ┌────┐
                                            │ C0 │   │ C4 │
                                            │{5} │   │{6} │
                                            └────┘   └────┘

Tarjan pops sinks first:  C0, C1, C2, C3, C4
                          ^^^^^^^^ successors always resolved first
```

### Code

```go
// eventualSafeNodes: a node is unsafe iff it can reach a cycle.
// Tarjan finds the cycles (components) and pops them sinks-first,
// so one sweep over the condensation labels everything.
func eventualSafeNodes(graph [][]int) []int {
    n := len(graph)
    const unseen = -1

    discovery := make([]int, n)
    low := make([]int, n)
    onStack := make([]bool, n)
    compOf := make([]int, n)
    for i := 0; i < n; i++ {
        discovery[i] = unseen
    }

    stack := []int{}
    timer := 0
    comps := [][]int{} // emitted in REVERSE topological order: sinks first

    var explore func(u int)
    explore = func(u int) {
        discovery[u], low[u] = timer, timer
        timer++
        stack = append(stack, u)
        onStack[u] = true

        for _, v := range graph[u] {
            if discovery[v] == unseen {
                explore(v)
                if low[v] < low[u] { // tree edge: child's low
                    low[u] = low[v]
                }
            } else if onStack[v] {
                if discovery[v] < low[u] { // back edge: DISCOVERY
                    low[u] = discovery[v]
                }
            }
        }

        if low[u] == discovery[u] { // u closes a component
            id := len(comps)
            members := []int{}
            for {
                top := stack[len(stack)-1]
                stack = stack[:len(stack)-1]
                onStack[top] = false
                compOf[top] = id
                members = append(members, top)
                if top == u {
                    break
                }
            }
            comps = append(comps, members)
        }
    }

    for u := 0; u < n; u++ {
        if discovery[u] == unseen {
            explore(u)
        }
    }

    // Sinks first, so every successor component is already labelled.
    compUnsafe := make([]bool, len(comps))
    for id, members := range comps {
        unsafe := len(members) > 1 // more than one node ⇒ a real cycle
        for _, u := range members {
            for _, v := range graph[u] {
                if compOf[v] == id {
                    unsafe = true // self-loop: a cycle of length 1
                } else if compUnsafe[compOf[v]] {
                    unsafe = true // reaches a cyclic component
                }
            }
        }
        compUnsafe[id] = unsafe
    }

    safe := []int{}
    for u := 0; u < n; u++ {
        if !compUnsafe[compOf[u]] {
            safe = append(safe, u) // ascending by construction
        }
    }
    return safe
}
```

```python
def eventual_safe_nodes(graph):
    """A node is unsafe iff it can reach a cycle; Tarjan finds the cycles."""
    n = len(graph)
    UNSEEN = -1
    discovery = [UNSEEN] * n
    low = [0] * n
    on_stack = [False] * n
    comp_of = [0] * n
    stack, comps = [], []          # comps: sinks first
    timer = 0

    def explore(u):
        nonlocal timer
        discovery[u] = low[u] = timer
        timer += 1
        stack.append(u)
        on_stack[u] = True

        for v in graph[u]:
            if discovery[v] == UNSEEN:
                explore(v)
                low[u] = min(low[u], low[v])        # tree edge
            elif on_stack[v]:
                low[u] = min(low[u], discovery[v])  # back edge

        if low[u] == discovery[u]:
            comp_id = len(comps)
            members = []
            while True:
                top = stack.pop()
                on_stack[top] = False
                comp_of[top] = comp_id
                members.append(top)
                if top == u:
                    break
            comps.append(members)

    for u in range(n):
        if discovery[u] == UNSEEN:
            explore(u)

    comp_unsafe = [False] * len(comps)
    for comp_id, members in enumerate(comps):
        unsafe = len(members) > 1                   # a real cycle inside
        for u in members:
            for v in graph[u]:
                if comp_of[v] == comp_id:
                    unsafe = True                   # self-loop
                elif comp_unsafe[comp_of[v]]:
                    unsafe = True                   # reaches a cycle
        comp_unsafe[comp_id] = unsafe

    return [u for u in range(n) if not comp_unsafe[comp_of[u]]]
```

### Complexity
Time O(V + E) — one DFS, then one pass over every component member and its edges. Space O(V) for `discovery`, `low`, the stack and the component labels.

## 10. Solved Example 2

### Problem — Longest Cycle in a Graph (LeetCode 2360)
Each node has **at most one** outgoing edge, given as `edges[i]` (or `-1` for none). Return the length of the longest cycle, or `-1` if there is none.

### Thought Process
1. "Longest cycle" is the condensation table entry: the answer is the size of the **largest strongly connected component**.
2. With at most one edge out per node, every component with ≥ 2 nodes *is* a cycle — no chords are possible, so component size = cycle length exactly.
3. Components of size 1 mean "no cycle through this node" (the constraints forbid `edges[i] == i`, so there are no self-loops).
4. Run Tarjan; when a component pops, its size is known immediately — no need to store members.
5. If no component exceeds size 1, answer `-1`.

### Dry Run

Input: `edges = [3,3,4,2,3]` — that is `0→3, 1→3, 2→4, 3→2, 4→3`.

| # | at node | discovery | low | what happens |
|---|---|---|---|---|
| 1 | 0 | 0 | 0 | push 0, follow `0→3` |
| 2 | 3 | 1 | 1 | push 3, follow `3→2` |
| 3 | 2 | 2 | 2 | push 2, follow `2→4` |
| 4 | 4 | 3 | **1** | `4→3`, 3 is on the stack → `low[4] = discovery[3] = 1` |
| 5 | back at 2 | 2 | **1** | `low[2] = min(2, low[4]=1) = 1` |
| 6 | back at 3 | 1 | 1 | `low[3] = min(1, low[2]=1) = 1 == discovery[3]` → **pop {4,2,3}, size 3** → best = 3 |
| 7 | back at 0 | 0 | 0 | `low[0] = min(0, low[3]=1) = 0 == discovery[0]` → **pop {0}, size 1** → ignored |
| 8 | 1 | 4 | 4 | `1→3`: visited and **off** the stack → ignored → **pop {1}, size 1** → ignored |

Output: **3**

Rows 7 and 8 are the whole point: 0 and 1 both *feed into* the cycle but are not on it, and the `onStack` test is what keeps them out of it. Node 3's discovery index (1) is lower than 0's low would suggest, yet `low[0]` stays 0 because a component root never inherits anything older than itself.

Second case: `edges = [2,-1,3,1]` — `0→2, 2→3, 3→1, 1→` nothing. Every node pops as its own component (sizes 1,1,1,1), so no component reaches size 2 → output **-1**.

### Visualization

```text
edges = [3,3,4,2,3]

     0 ──┐            the cycle:      2 ──→ 4
         ↓                            ↑     │
     1 ──→ 3 ⇄ 2 → 4                  └── 3 ←┘
              ↖___/
                                      size 3  ⇒  answer 3

stack over time:
  [0]        push 0
  [0,3]      push 3
  [0,3,2]    push 2
  [0,3,2,4]  push 4      4→3 is a back edge (3 on stack) → low[4]=1
  [0]        pop 4,2,3   low[3]==discovery[3]  ⇒ component {3,2,4}, size 3
  []         pop 0                              ⇒ component {0},    size 1
  [1] → []   node 1 alone                       ⇒ component {1},    size 1
```

### Code

```go
// longestCycle: with one edge out per node, every SCC of size > 1 is
// itself a cycle, so the answer is the largest component size.
func longestCycle(edges []int) int {
    n := len(edges)
    const unseen = -1

    discovery := make([]int, n)
    low := make([]int, n)
    onStack := make([]bool, n)
    for i := 0; i < n; i++ {
        discovery[i] = unseen
    }

    stack := []int{}
    timer := 0
    best := -1

    var explore func(u int)
    explore = func(u int) {
        discovery[u], low[u] = timer, timer
        timer++
        stack = append(stack, u)
        onStack[u] = true

        if v := edges[u]; v != -1 { // at most one outgoing edge
            if discovery[v] == unseen {
                explore(v)
                if low[v] < low[u] { // tree edge
                    low[u] = low[v]
                }
            } else if onStack[v] {
                if discovery[v] < low[u] { // back edge: DISCOVERY
                    low[u] = discovery[v]
                }
            }
        }

        if low[u] == discovery[u] { // u closes a component
            size := 0
            for {
                top := stack[len(stack)-1]
                stack = stack[:len(stack)-1]
                onStack[top] = false
                size++
                if top == u {
                    break
                }
            }
            if size > 1 && size > best { // size 1 = no cycle here
                best = size
            }
        }
    }

    for u := 0; u < n; u++ {
        if discovery[u] == unseen {
            explore(u)
        }
    }
    return best
}
```

```python
def longest_cycle(edges):
    """One edge out per node ⇒ every SCC of size > 1 is exactly a cycle."""
    n = len(edges)
    UNSEEN = -1
    discovery = [UNSEEN] * n
    low = [0] * n
    on_stack = [False] * n
    stack = []
    timer = 0
    best = -1

    def explore(u):
        nonlocal timer, best
        discovery[u] = low[u] = timer
        timer += 1
        stack.append(u)
        on_stack[u] = True

        v = edges[u]
        if v != -1:
            if discovery[v] == UNSEEN:
                explore(v)
                low[u] = min(low[u], low[v])        # tree edge
            elif on_stack[v]:
                low[u] = min(low[u], discovery[v])  # back edge

        if low[u] == discovery[u]:
            size = 0
            while True:
                top = stack.pop()
                on_stack[top] = False
                size += 1
                if top == u:
                    break
            if size > 1:
                best = max(best, size)

    for u in range(n):
        if discovery[u] == UNSEEN:
            explore(u)
    return best
```

### Complexity
Time O(n) — each node is pushed and popped once, and there are at most `n` edges. Space O(n) for the three arrays plus the stack.

## 11. Solved Example 3

### Problem — Critical Connections in a Network (LeetCode 1192)
Given `n` servers and a list of **undirected** connections, return every connection whose removal disconnects some server from the rest — the *bridges*.

### Thought Process
1. This is the **undirected analogue** of the same machinery. In an undirected graph, asking "which nodes are mutually reachable?" is trivial — every connected component already is — so the interesting question moves from *nodes* to *edges*: which edges is that mutual reachability relying on?
2. Keep `discovery` and `low` exactly as before. Only the test at the end changes: `low[u] == discovery[u]` closes a strongly connected component, while `low[v] > discovery[u]` marks a bridge.
3. Read `low[v] > discovery[u]` as: nothing in `v`'s subtree reaches `u` or anything discovered earlier, so the only route into that subtree is this edge.
4. Undirected edges are stored both ways, so skip the immediate parent — otherwise every tree edge would look like a back edge to itself and no bridge would survive.
5. Chapter 99 derives all of this in full; here the point is only that it is the *same* two numbers, read with a different comparison.

### Dry Run

Input: `n = 4, connections = [[0,1],[1,2],[2,0],[1,3]]`

Adjacency (each edge stored twice): `0: [1,2]`, `1: [0,2,3]`, `2: [1,0]`, `3: [1]`

| # | at node (parent) | discovery | low | what happens |
|---|---|---|---|---|
| 1 | 0 (—) | 0 | 0 | follow `0→1` |
| 2 | 1 (0) | 1 | 1 | neighbour 0 is the parent → skipped; follow `1→2` |
| 3 | 2 (1) | 2 | **0** | neighbour 1 is the parent → skipped; `2→0` visited → `low[2] = discovery[0] = 0` |
| 4 | back at 1 | 1 | **0** | `low[1] = min(1, 0) = 0`. Bridge? `low[2]=0 > discovery[1]=1` → **no** |
| 5 | 3 (1) | 3 | 3 | only neighbour is the parent 1 → nothing to explore |
| 6 | back at 1 | 1 | 0 | Bridge? `low[3]=3 > discovery[1]=1` → **yes, edge (1,3)** |
| 7 | back at 0 | 0 | 0 | Bridge? `low[1]=0 > discovery[0]=0` → no. Then `0→2` visited → `low[0] = min(0, 2) = 0` |

Output: **[[1,3]]**

Compare rows 4 and 6. Node 2 could climb back to discovery `0`, which is `≤ discovery[1]`, so the triangle routes around edge (1,2). Node 3 could only ever reach discovery `3` — itself — so its single edge is critical.

### Visualization

```text
         0 ──── 1 ════ 3        ════ = bridge
         │     ╱
         │    ╱
         2 ──┘

discovery/low after the DFS:

   node :  0   1   2   3
   disc :  0   1   2   3
   low  :  0   0   0   3
                        ↑
              low[3] = 3 > disc[1] = 1  → (1,3) is a bridge

   the triangle {0,1,2} all share low = 0: every one of its edges
   has an alternate route, so none of them is critical.

directed reading            undirected reading
  low[u] == disc[u]           low[v] > disc[u]
  → u roots an SCC            → edge u–v is a bridge
```

### Code

```go
// criticalConnections: same discovery/low as Tarjan's SCC, but the
// closing test becomes low[v] > discovery[u] — v's subtree has no way
// back around this edge.
func criticalConnections(n int, connections [][]int) [][]int {
    graph := make([][]int, n)
    for _, e := range connections { // undirected: store both directions
        graph[e[0]] = append(graph[e[0]], e[1])
        graph[e[1]] = append(graph[e[1]], e[0])
    }

    const unseen = -1
    discovery := make([]int, n)
    low := make([]int, n)
    for i := 0; i < n; i++ {
        discovery[i] = unseen
    }

    timer := 0
    bridges := [][]int{}

    var explore func(u, parent int)
    explore = func(u, parent int) {
        discovery[u], low[u] = timer, timer
        timer++

        for _, v := range graph[u] {
            if v == parent {
                continue // do not walk straight back up the tree edge
            }
            if discovery[v] == unseen {
                explore(v, u)
                if low[v] < low[u] {
                    low[u] = low[v]
                }
                if low[v] > discovery[u] { // no route around u–v
                    bridges = append(bridges, []int{u, v})
                }
            } else if discovery[v] < low[u] {
                low[u] = discovery[v] // back edge: DISCOVERY
            }
        }
    }

    for u := 0; u < n; u++ {
        if discovery[u] == unseen {
            explore(u, -1)
        }
    }
    return bridges
}
```

```python
def critical_connections(n, connections):
    """Same low-link, undirected: low[v] > discovery[u] marks a bridge."""
    graph = [[] for _ in range(n)]
    for a, b in connections:
        graph[a].append(b)
        graph[b].append(a)

    UNSEEN = -1
    discovery = [UNSEEN] * n
    low = [0] * n
    bridges = []
    timer = 0

    def explore(u, parent):
        nonlocal timer
        discovery[u] = low[u] = timer
        timer += 1

        for v in graph[u]:
            if v == parent:
                continue                            # never re-cross the tree edge
            if discovery[v] == UNSEEN:
                explore(v, u)
                low[u] = min(low[u], low[v])
                if low[v] > discovery[u]:           # nothing routes around it
                    bridges.append([u, v])
            else:
                low[u] = min(low[u], discovery[v])  # back edge

    for u in range(n):
        if discovery[u] == UNSEEN:
            explore(u, -1)
    return bridges
```

Skipping by parent *node* is fine here because LeetCode guarantees no repeated connections; with parallel edges you must skip by parent *edge index* instead, or a duplicated edge would masquerade as a back edge.

### Complexity
Time O(V + E) — build the adjacency list, then visit every node once and every edge twice. Space O(V + E) for the adjacency list plus O(V) of DFS state.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1192 | Critical Connections | Easy | Core advanced application |
| 2360 | Longest Cycle | Easy | Core advanced application |
| 802 | Eventual Safe | Medium | Core advanced application |
| 207 | Course Schedule | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Strongly Connected Components logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Strongly Connected Components (Advanced).
- **Signal:** scc, kosaraju, tarjan, condensation, directed cycle.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Strongly Connected Components invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Strongly Connected Components
FAMILY : Advanced (Expert)
WHEN   : scc, kosaraju, tarjan, condensation, directed cycle
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1192, 2360, 802, 207
```

---

*Part of the DSA Patterns Handbook — pattern 98 of 100.*
