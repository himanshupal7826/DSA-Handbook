# 53 · Tree DFS

> **One-liner:** Recursive/stack traversal visiting a subtree fully before siblings.

---

## 1. Overview

### Definition
The **Tree DFS** pattern belongs to the *Trees* family. Recursive/stack traversal visiting a subtree fully before siblings.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
dfs, tree, preorder, inorder, postorder, recursion.

### Constraints
- Input size where the brute-force complexity would time out — the Tree DFS optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Tree DFS invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tree DFS is the upgrade.
- The wording maps onto: dfs, tree, preorder, inorder, postorder, recursion.

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
Redundant recomputation; does not exploit the structure the Tree DFS pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Tree DFS invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 560 285" width="100%" height="285" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="dfs-53" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">DFS finishes a whole subtree before its sibling</text>
  <!-- edges -->
  <line x1="266" y1="54" x2="194" y2="96" stroke="#475569"/>
  <line x1="294" y1="54" x2="366" y2="96" stroke="#475569"/>
  <line x1="166" y1="124" x2="134" y2="166" stroke="#475569"/>
  <line x1="194" y1="124" x2="226" y2="166" stroke="#475569"/>
  <line x1="394" y1="124" x2="426" y2="166" stroke="#475569"/>
  <!-- nodes -->
  <circle cx="280" cy="40" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">A</text>
  <circle cx="180" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="115" text-anchor="middle" fill="#1e293b">B</text>
  <circle cx="380" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">C</text>
  <circle cx="120" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">D</text>
  <circle cx="240" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">E</text>
  <circle cx="440" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="440" y="185" text-anchor="middle" fill="#1e293b">F</text>
  <text x="40" y="238" text-anchor="start" fill="#64748b">pre  (node,L,R):  A B D E C F</text>
  <text x="40" y="258" text-anchor="start" fill="#64748b">in   (L,node,R):  D B E A C F</text>
  <text x="40" y="278" text-anchor="start" fill="#059669" font-weight="700">post (L,R,node):  D E B F C A</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Tree DFS          : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Tree DFS problem. I'll trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates. That brings the complexity down to O(n) time and O(h) space — here's the template."

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

| Metric | Brute Force | Tree DFS (Optimal) |
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

### Problem — Max Depth (LeetCode 104)
Find the length of the longest root-to-leaf path — the canonical post-order Tree DFS combine.

### Thought Process
1. The depth of an empty subtree is 0 — that is the recursion's base case.
2. A node's depth is 1 plus the deeper of its two subtree depths (combine after recursing).
3. DFS dives to the leaves, then folds the child depths back up to the root.

### Dry Run
Tree `[3,9,20,null,null,15,7]`:
- leaves 9, 15, 7 each return depth 1
- node 20 = 1 + max(1,1) = 2
- root 3 = 1 + max(1,2) = 3 → answer 3

### Visualization
```
input  ──▶ [ apply Tree DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def maxDepth(root):
    if not root:
        return 0
    return 1 + max(maxDepth(root.left), maxDepth(root.right))
```

### Complexity
Time O(n), Space O(h) for the recursion stack.

## 10. Solved Example 2

### Problem — Preorder (LeetCode 144)
Return the values in preorder (node, then left, then right) using DFS.

### Thought Process
1. Preorder means: record the current node's value first, before its children.
2. Then recurse into the left subtree fully, then the right subtree.
3. DFS visits each subtree completely before moving on to the sibling.

### Dry Run
Tree `[1,null,2,3]` (1's right child is 2, whose left child is 3):
- visit 1 → out=[1]; left of 1 is None
- recurse right to 2 → out=[1,2]; left of 2 is 3 → out=[1,2,3]
- answer [1,2,3]

### Visualization
```
input  ──▶ [ apply Tree DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def preorderTraversal(root):
    out = []
    def dfs(node):
        if not node:
            return
        out.append(node.val)   # visit node before its children
        dfs(node.left)
        dfs(node.right)
    dfs(root)
    return out
```

### Complexity
Time O(n), Space O(h) for the recursion stack.

## 11. Solved Example 3

### Problem — Inorder (LeetCode 94)
Return the values in inorder (left, then node, then right) using DFS.

### Thought Process
1. Inorder means: fully traverse the left subtree before recording the node.
2. Record the node's value between the left and right recursions.
3. On a BST this emits the values in sorted order.

### Dry Run
Tree `[1,null,2,3]`:
- dfs(1): left is None → record 1 → out=[1]
- recurse right to 2: its left is 3 → record 3 → out=[1,3]; then record 2 → out=[1,3,2]
- answer [1,3,2]

### Visualization
```
input  ──▶ [ apply Tree DFS step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def inorderTraversal(root):
    out = []
    def dfs(node):
        if not node:
            return
        dfs(node.left)
        out.append(node.val)   # visit node between the two subtrees
        dfs(node.right)
    dfs(root)
    return out
```

### Complexity
Time O(n), Space O(h) for the recursion stack.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 104 | Max Depth | Easy | Core trees application |
| 144 | Preorder | Easy | Core trees application |
| 94 | Inorder | Medium | Core trees application |
| 145 | Postorder | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tree DFS logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tree DFS (Trees).
- **Signal:** dfs, tree, preorder, inorder, postorder, recursion.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tree DFS invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tree DFS
FAMILY : Trees (Intermediate)
WHEN   : dfs, tree, preorder, inorder, postorder, recursion
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 104, 144, 94, 145
```

---

*Part of the DSA Patterns Handbook — pattern 53 of 100.*
