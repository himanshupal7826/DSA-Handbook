# 60 · Tree DP

> **One-liner:** Combine children's DP states post-order to solve subtree subproblems.

---

## 1. Overview

### Definition
The **Tree DP** pattern belongs to the *Trees* family. Combine children's DP states post-order to solve subtree subproblems.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
tree dp, rerooting, subtree, postorder, include exclude.

### Constraints
- Input size where the brute-force complexity would time out — the Tree DP optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Tree DP invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tree DP is the upgrade.
- The wording maps onto: tree dp, rerooting, subtree, postorder, include exclude.

---

## 3. Brute Force Approach

### Intuition
Recompute subtree properties repeatedly across calls — O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Tree DP pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Tree DP invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="tdp-60" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">dp[node] = val + dp[L] + dp[R], combined post-order</text>
  <!-- edges with upward arrows showing values bubbling up -->
  <line x1="194" y1="96" x2="266" y2="54" stroke="#475569" marker-end="url(#tdp-60)"/>
  <line x1="366" y1="96" x2="294" y2="54" stroke="#475569" marker-end="url(#tdp-60)"/>
  <line x1="134" y1="166" x2="166" y2="124" stroke="#475569" marker-end="url(#tdp-60)"/>
  <line x1="226" y1="166" x2="194" y2="124" stroke="#475569" marker-end="url(#tdp-60)"/>
  <line x1="426" y1="166" x2="394" y2="124" stroke="#475569" marker-end="url(#tdp-60)"/>
  <!-- nodes: val shown inside -->
  <circle cx="280" cy="40" r="20" fill="#ecfdf5" stroke="#059669"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="180" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="115" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="380" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="120" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="240" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="440" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="440" y="185" text-anchor="middle" fill="#1e293b">6</text>
  <!-- dp badges -->
  <text x="308" y="44"  text-anchor="start" fill="#059669" font-weight="700">dp=21</text>
  <text x="140" y="98"  text-anchor="start" fill="#059669" font-weight="700">dp=8</text>
  <text x="404" y="98"  text-anchor="start" fill="#059669" font-weight="700">dp=8</text>
  <text x="86"  y="176" text-anchor="start" fill="#64748b">dp=1</text>
  <text x="266" y="176" text-anchor="start" fill="#64748b">dp=4</text>
  <text x="466" y="176" text-anchor="start" fill="#64748b">dp=6</text>
  <text x="280" y="242" text-anchor="middle" fill="#64748b">leaves seed dp = val; each parent folds in its children</text>
  <text x="280" y="260" text-anchor="middle" fill="#059669" font-weight="700">root dp = 5 + 8 + 8 = 21</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Tree DP           : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Tree DP problem. I'll trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates. That brings the complexity down to O(n) time and O(h) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Trees** family template. Adapt the comparison/condition to the specific problem.

```go
// Post-order DFS returning subtree height; also tracks diameter.
type TreeNode struct { Val int; Left, Right *TreeNode }
func height(node *TreeNode, best *int) int {
    if node == nil { return 0 }
    l := height(node.Left, best)
    r := height(node.Right, best)
    if l+r > *best { *best = l + r }   // path through this node
    if l > r { return l + 1 }
    return r + 1
}
```

```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)       # longest path through node
        return 1 + max(l, r)
    height(root)
    return best
```

```java
class TreeNode { int val; TreeNode left, right; }
int best = 0;
int height(TreeNode node) {
    if (node == null) return 0;
    int l = height(node.left), r = height(node.right);
    best = Math.max(best, l + r);
    return 1 + Math.max(l, r);
}
```

```cpp
struct TreeNode { int val; TreeNode *left, *right; };
int best = 0;
int height(TreeNode* node) {
    if (!node) return 0;
    int l = height(node->left), r = height(node->right);
    best = max(best, l + r);
    return 1 + max(l, r);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Tree DP (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(h)** |

> Visit each node once; recursion stack is O(height).

---

## 7. Common Mistakes

1. Returning the global answer instead of the local subtree value.
2. Confusing height (edges) with depth/number of nodes.
3. Null checks missing, causing crashes at leaves.
4. Using O(n) extra work per node (e.g., recomputing height) → O(n^2).
5. BFS without tracking level boundaries when levels matter.
6. Deep recursion stack overflow on skewed trees.
7. Mutating shared state across recursion branches incorrectly.
8. LCA: not handling the case where one node is ancestor of the other.
9. Forgetting BST ordering to prune search.
10. Serialization: ambiguous null markers.

---

## 8. Interview Follow-Up Questions

1. **Q: Pre/in/post-order — when each?**
   A: Post-order to combine children; in-order for BST sorted output; pre-order to copy/serialize.

2. **Q: Iterative DFS?**
   A: Explicit stack mirrors the call stack.

3. **Q: BFS vs DFS on trees?**
   A: BFS for level/shortest; DFS for path/subtree aggregates.

4. **Q: Diameter computation?**
   A: At each node combine left+right heights; track the global max.

5. **Q: Balanced check in O(n)?**
   A: Return height and a balance flag together.

6. **Q: LCA in a binary tree?**
   A: Post-order; the node where both targets surface is the LCA.

7. **Q: LCA in a BST?**
   A: Walk down comparing values.

8. **Q: Path sum (any path)?**
   A: Prefix sums along the root path with a hash map.

9. **Q: Max path sum?**
   A: Tree DP: gain = node + max(0, left, right).

10. **Q: Why O(h) space?**
   A: Recursion depth equals tree height.

11. **Q: Serialize/deserialize?**
   A: Pre-order with null markers, or level-order.

12. **Q: Tree DP / rerooting?**
   A: Compute subtree DP, then a second pass for all roots.

13. **Q: Count nodes in complete tree?**
   A: Use height symmetry for O(log^2 n).

14. **Q: Kth smallest in BST?**
   A: In-order traversal with a counter.

15. **Q: Vertical/zigzag order?**
   A: BFS with column index or alternating direction.

---

## 9. Solved Example 1

### Problem — House Robber III (LeetCode 337)
A representative **Tree DP** problem. The signal: combine children's dp states post-order to solve subtree subproblems.

### Thought Process
1. Confirm the pattern via its recognition signals (tree dp, rerooting, subtree, postorder, include exclude).
2. Reach for the Tree DP template below and map the problem's entities onto it.
3. Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tree DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)       # longest path through node
        return 1 + max(l, r)
    height(root)
    return best
```

### Complexity
Time O(n), Space O(h). Visit each node once; recursion stack is O(height).

## 10. Solved Example 2

### Problem — Cameras (LeetCode 968)
A representative **Tree DP** problem. The signal: combine children's dp states post-order to solve subtree subproblems.

### Thought Process
1. Confirm the pattern via its recognition signals (tree dp, rerooting, subtree, postorder, include exclude).
2. Reach for the Tree DP template below and map the problem's entities onto it.
3. Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tree DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)       # longest path through node
        return 1 + max(l, r)
    height(root)
    return best
```

### Complexity
Time O(n), Space O(h). Visit each node once; recursion stack is O(height).

## 11. Solved Example 3

### Problem — Max Path Sum (LeetCode 124)
A representative **Tree DP** problem. The signal: combine children's dp states post-order to solve subtree subproblems.

### Thought Process
1. Confirm the pattern via its recognition signals (tree dp, rerooting, subtree, postorder, include exclude).
2. Reach for the Tree DP template below and map the problem's entities onto it.
3. Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Tree DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)       # longest path through node
        return 1 + max(l, r)
    height(root)
    return best
```

### Complexity
Time O(n), Space O(h). Visit each node once; recursion stack is O(height).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 337 | House Robber III | Easy | Core trees application |
| 968 | Cameras | Easy | Core trees application |
| 124 | Max Path Sum | Medium | Core trees application |
| 834 | Sum of Distances | Medium | Core trees application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **DFS (pre/in/post)**
- **BFS level order**
- **Height / diameter**
- **Balanced check**
- **LCA**
- **Path sum**
- **Tree DP**

---

## 14. Production Engineering Applications

- **Scalability:** Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(h)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tree DP logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tree DP (Trees).
- **Signal:** tree dp, rerooting, subtree, postorder, include exclude.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tree DP invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tree DP
FAMILY : Trees (Advanced)
WHEN   : tree dp, rerooting, subtree, postorder, include exclude
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 337, 968, 124, 834
```

---

*Part of the DSA Patterns Handbook — pattern 60 of 100.*
