# 55 · Tree Height

> **One-liner:** Post-order recursion returns subtree height to its parent.

---

## 1. Overview

### Definition
The **Tree Height** pattern belongs to the *Trees* family. Post-order recursion returns subtree height to its parent.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
height, depth, recursion, postorder, tree.

### Constraints
- Input size where the brute-force complexity would time out — the Tree Height optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Tree Height invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tree Height is the upgrade.
- The wording maps onto: height, depth, recursion, postorder, tree.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How tall is this tree?"* — and, more sharply, *"how far is the nearest or farthest leaf?"*

### Intuition
Enumerate every root-to-leaf path, measure each, take the longest (or shortest).

### Algorithm
1. Walk the tree, carrying the current path.
2. Each time you reach a leaf, record the path's length.
3. After the walk, return the maximum (or minimum) recorded length.

### Complexity
- Time: O(n) to walk, but building and copying paths adds up.
- Space: **O(n · h)** if you store every path, versus O(h) if you only ever keep a counter.

### Drawbacks
- Materialising the paths is pure overhead — we only ever needed their **lengths**, never their contents.
- It also splits the work into "collect" and then "reduce", when a single recursive pass can return the number directly.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **The height of a node is one more than the height of its tallest child — so let the recursion carry the number up, and never build a path at all.**

```text
height(node) = 1 + max( height(left), height(right) )
height(nil)  = 0
```

Two lines, and the whole family of problems is variations on them.

### First, get the vocabulary straight

These two are constantly confused, and mixing them up produces off-by-one bugs that are hard to spot:

```text
        3          ← depth 0,  height 3
       / \
      9  20        ← depth 1,  height(9) = 1, height(20) = 2
        /  \
       15   7      ← depth 2,  height 1

DEPTH  is measured DOWNWARD FROM THE ROOT   → known on the way DOWN
HEIGHT is measured UPWARD FROM THE LEAVES   → known on the way UP
```

LeetCode 104 says "maximum depth", but what it actually asks for is the **height of the root**, counted in nodes. Depth and height of the root coincide, which is why the sloppy naming survives.

Also fix the unit: this chapter counts **nodes**, so a single-node tree has height 1 and an empty tree has height 0. Some textbooks count **edges**, making those 0 and −1. Neither is wrong — but say which you mean, because it moves every answer by one.

### The thought process

```text
We need    : the distance to the farthest (or nearest) leaf.
Obvious way: enumerate all root-to-leaf paths and measure them.
Wasteful   : we build paths only to take their lengths.
Notice     : a node's height depends only on its children's heights.
             That is a number, and it flows upward.
Therefore  : return the number from the recursion instead of
             collecting paths.
Now        : O(n) time, O(h) space, and no allocation.
```

### The trap: minimum depth is NOT the mirror image

This is the one genuinely tricky thing in the chapter. The obvious "just swap max for min" is **wrong**:

```go
// WRONG
return 1 + min(minDepth(root.Left), minDepth(root.Right))
```

Consider a tree that is really a chain:

```text
      2
       \
        3
         \
          4
```

At node `2` the left child is `nil`, so `minDepth(nil)` returns `0`, and `min(0, 2)` is `0`. The function reports depth **1** — as if `2` were a leaf. It isn't; it has no left subtree at all.

The fix comes from the definition: minimum depth is the distance to the nearest **leaf**, and a leaf is a node with **no children**. A `nil` child is not a leaf — it is the absence of a subtree, and a path cannot end there.

```text
if left is nil  → the answer must come through the right:  1 + right
if right is nil → the answer must come through the left:   1 + left
otherwise       → 1 + min(left, right)
```

Maximum depth needs no such care, because a missing subtree returns `0` and `max` ignores it automatically. **Only the `min` version needs the guard** — and that asymmetry is exactly what interviewers probe.

### Steps (height / maximum depth)

```text
Step 1 → if node is nil, return 0
Step 2 → left  = height(node.Left)
Step 3 → right = height(node.Right)
Step 4 → return 1 + max(left, right)
```

### Steps (minimum depth)

```text
Step 1 → if node is nil, return 0
Step 2 → if both children are nil, return 1        ← a real leaf
Step 3 → if left is nil,  return 1 + minDepth(right)
Step 4 → if right is nil, return 1 + minDepth(left)
Step 5 → return 1 + min(minDepth(left), minDepth(right))
```

### When BFS beats recursion

For **minimum** depth, BFS can stop the moment it meets the first leaf, because levels are visited in increasing order of depth. DFS must explore every branch before it can be sure. On a tree with one short branch and one enormous one, that is the difference between reading a handful of nodes and reading all of them.

For **maximum** depth there is no early exit either way — you must see every node — so recursion is the simpler choice.

### How should I recognize this?

```text
If you see...
  "height", "depth", "how many levels", "distance to the nearest leaf"
  "is it balanced", "deepest node"
  any answer that is a number flowing upward from the leaves
        ↓
Think about...
  "Is my answer 1 + something about my children?"
  "Does a MISSING child mean zero, or does it mean 'not a path'?"
        ↓
Use...
  maximum depth → 1 + max(left, right), nil = 0
  minimum depth → guard the nil children, or use BFS with early exit
  n-ary tree    → 1 + max over ALL children
```

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="hgt-55" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">height(node) = 1 + max(height L, height R)</text>
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
  <!-- height badges bubbling up -->
  <text x="316" y="36" text-anchor="start" fill="#059669" font-weight="700">h=3</text>
  <text x="146" y="106" text-anchor="start" fill="#059669" font-weight="700">h=2</text>
  <text x="416" y="106" text-anchor="start" fill="#059669" font-weight="700">h=2</text>
  <text x="86"  y="176" text-anchor="start" fill="#64748b">h=1</text>
  <text x="266" y="176" text-anchor="start" fill="#64748b">h=1</text>
  <text x="466" y="176" text-anchor="start" fill="#64748b">h=1</text>
  <line x1="250" y1="205" x2="250" y2="70" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#hgt-55)"/>
  <text x="280" y="248" text-anchor="middle" fill="#64748b">leaves return 1; each parent adds 1 to the taller child, up to the root</text>
</svg>
```

```text
        3
       / \
      9  20
        /  \
       15   7

heights computed on the way UP:

  height(9)  = 1        height(15) = 1     height(7) = 1
  height(20) = 1 + max(1, 1) = 2
  height(3)  = 1 + max(1, 2) = 3      ← the answer

minimum depth on the SAME tree:
  node 9 is a real leaf at depth 2  →  minDepth = 2
```

### Interview explanation
"Height is one plus the height of the taller child, with an empty tree counting as 0 — so I let the recursion return the number rather than building paths. That's O(n) time and O(h) stack. The subtlety is minimum depth: swapping `max` for `min` is wrong, because a missing child returns 0 and drags the minimum down, making a one-child node look like a leaf. Minimum depth is the distance to a node with *no* children, so I guard: if one side is nil, the answer must come through the other. I'd also mention that BFS is strictly better for minimum depth — it stops at the first leaf, whereas DFS has to explore everything."

---

## 5. Generic Templates

> `1 + max(children)` for height. For minimum depth, guard the nil children.

```go
// Height returns the number of nodes on the longest root-to-leaf path.
// An empty tree has height 0; a single node has height 1.
func Height(root *TreeNode) int {
    if root == nil {
        return 0 // base case: no nodes
    }
    left := Height(root.Left)
    right := Height(root.Right)

    if left > right {
        return left + 1
    }
    return right + 1
}

// MinDepth returns the distance to the NEAREST leaf.
// A nil child is not a leaf, so it must not contribute 0 to the minimum.
func MinDepth(root *TreeNode) int {
    if root == nil {
        return 0
    }
    // A real leaf: no children at all.
    if root.Left == nil && root.Right == nil {
        return 1
    }
    // Exactly one child: the path must go through it.
    if root.Left == nil {
        return 1 + MinDepth(root.Right)
    }
    if root.Right == nil {
        return 1 + MinDepth(root.Left)
    }

    left := MinDepth(root.Left)
    right := MinDepth(root.Right)
    if left < right {
        return left + 1
    }
    return right + 1
}

// MinDepthBFS stops at the first leaf — the real reason to prefer BFS here.
func MinDepthBFS(root *TreeNode) int {
    if root == nil {
        return 0
    }

    queue := []*TreeNode{root}
    depth := 1

    for len(queue) > 0 {
        levelSize := len(queue)
        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]

            if node.Left == nil && node.Right == nil {
                return depth // the first leaf is on the shallowest level
            }
            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
        depth++
    }
    return depth
}
```

```python
def height(root):
    """Nodes on the longest root-to-leaf path. Empty tree = 0."""
    if root is None:
        return 0
    return 1 + max(height(root.left), height(root.right))

def min_depth(root):
    """Distance to the NEAREST leaf. A nil child is not a leaf."""
    if root is None:
        return 0
    if root.left is None and root.right is None:
        return 1                             # a real leaf
    if root.left is None:
        return 1 + min_depth(root.right)     # path must go right
    if root.right is None:
        return 1 + min_depth(root.left)      # path must go left
    return 1 + min(min_depth(root.left), min_depth(root.right))

def min_depth_bfs(root):
    """BFS stops at the first leaf."""
    from collections import deque
    if root is None:
        return 0
    queue, depth = deque([root]), 1
    while queue:
        for _ in range(len(queue)):
            node = queue.popleft()
            if node.left is None and node.right is None:
                return depth
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        depth += 1
    return depth
```

```java
public class TreeHeight {
    public static class TreeNode {
        int val; TreeNode left, right;
        TreeNode(int val) { this.val = val; }
    }

    public static int height(TreeNode root) {
        if (root == null) return 0;
        return 1 + Math.max(height(root.left), height(root.right));
    }

    // A nil child is NOT a leaf, so it must not contribute 0 to the minimum.
    public static int minDepth(TreeNode root) {
        if (root == null) return 0;
        if (root.left == null && root.right == null) return 1;    // real leaf
        if (root.left == null) return 1 + minDepth(root.right);
        if (root.right == null) return 1 + minDepth(root.left);
        return 1 + Math.min(minDepth(root.left), minDepth(root.right));
    }
}
```

```cpp
#include <algorithm>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    explicit TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

int height(TreeNode* root) {
    if (root == nullptr) return 0;
    return 1 + max(height(root->left), height(root->right));
}

// A nil child is NOT a leaf, so it must not contribute 0 to the minimum.
int minDepth(TreeNode* root) {
    if (root == nullptr) return 0;
    if (root->left == nullptr && root->right == nullptr) return 1;   // real leaf
    if (root->left == nullptr) return 1 + minDepth(root->right);
    if (root->right == nullptr) return 1 + minDepth(root->left);
    return 1 + min(minDepth(root->left), minDepth(root->right));
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Tree Height (Optimal) |
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

### Problem — Maximum Depth of Binary Tree (LeetCode 104)
Return the number of nodes along the longest path from the root down to a leaf.

### Thought Process
1. "Maximum depth" here is the **height of the root**, counted in nodes.
2. Base case: an empty tree has depth `0`.
3. Combine: `1 + max(left, right)`.
4. A missing child contributes `0`, and `max` ignores it — so no guard is needed. (Contrast this with minimum depth in the next example.)
5. Answers flow upward from the leaves; nothing is computed on the way down.

### Dry Run

Input:

```text
        3
       / \
      9  20
        /  \
       15   7
```

| call | left | right | returns |
|------|------|-------|---------|
| `maxDepth(9)`  | 0 | 0 | `1 + max(0,0)` = **1** |
| `maxDepth(15)` | 0 | 0 | **1** |
| `maxDepth(7)`  | 0 | 0 | **1** |
| `maxDepth(20)` | 1 | 1 | `1 + max(1,1)` = **2** |
| `maxDepth(3)`  | 1 | 2 | `1 + max(1,2)` = **3** |

Output: **3** ✓

The longest path is `3 → 20 → 15` (or `3 → 20 → 7`), which has 3 nodes. ✓

**Why no nil-guard is needed here.** Take the chain `2 → 3 → 4`: at node `2`, `maxDepth(nil) = 0` and `maxDepth(3) = 2`, so `max(0, 2) = 2` and we return 3. The missing subtree simply loses the `max`, which is exactly right.

### Visualization

```text
        3  ─────────── 1 + max(1, 2) = 3   ★
       / \
      9  20 ────────── 1 + max(1, 1) = 2
     (1)  / \
       15    7
      (1)   (1) ────── leaves: 1 + max(0, 0) = 1

values flow UP ↑ from the leaves
```

### Code

```go
func maxDepth(root *TreeNode) int {
    if root == nil {
        return 0 // an empty tree has depth 0
    }

    left := maxDepth(root.Left)
    right := maxDepth(root.Right)

    // A missing child returns 0, which max discards — no guard needed.
    if left > right {
        return left + 1
    }
    return right + 1
}
```

```python
def maxDepth(root):
    if root is None:
        return 0                        # empty tree has depth 0
    # A missing child returns 0, which max() discards — no guard needed.
    return 1 + max(maxDepth(root.left), maxDepth(root.right))
```

### Complexity
Time **O(n)**, Space **O(h)** — O(log n) on a balanced tree, O(n) on a degenerate one.

---

## 10. Solved Example 2

### Problem — Minimum Depth of Binary Tree (LeetCode 111)
Return the number of nodes along the **shortest** path from the root down to a **leaf** — a node with no children.

### Thought Process
1. The obvious mirror of Example 1, `1 + min(left, right)`, is **wrong**.
2. A `nil` child returns `0`, and `min(0, anything)` is `0` — so a node with exactly one child would be reported as depth 1, as if it were a leaf. It isn't: a path cannot end at a missing subtree.
3. The definition is the fix. A leaf has **no** children. So if one side is `nil`, the shortest path must go through the other side.
4. Three cases: both children nil (a real leaf), exactly one nil (recurse the other side), or two children (take the min).
5. BFS is the better tool here — it returns at the first leaf it meets.

### Dry Run — the case that exposes the bug

Input: `[2, null, 3, null, 4, null, 5, null, 6]`, a right-leaning chain:

```text
      2
       \
        3
         \
          4
           \
            5
             \
              6
```

**The naive `1 + min(left, right)`:**

| node | left | right | naive result |
|------|------|-------|--------------|
| `2` | `minDepth(nil)` = **0** | `minDepth(3)` = … | `1 + min(0, …)` = **1** ✗ |

It stops at 1 — claiming node `2` is a leaf. It has no left subtree, but it certainly has a right child.

**The correct version:**

| call | situation | returns |
|------|-----------|---------|
| `minDepth(6)` | both children nil → real leaf | **1** |
| `minDepth(5)` | left nil → go right | `1 + 1` = **2** |
| `minDepth(4)` | left nil → go right | `1 + 2` = **3** |
| `minDepth(3)` | left nil → go right | `1 + 3` = **4** |
| `minDepth(2)` | left nil → go right | `1 + 4` = **5** |

Output: **5** ✓

**A tree where the minimum really is shallower than the maximum:**

```text
        3
       / \
      9  20
        /  \
       15   7
```

Node `9` is a genuine leaf at depth 2, so `minDepth = 2` while `maxDepth = 3`. Here both children of `3` exist, so the `min` branch applies normally.

### Visualization

```text
      2            left is nil  →  cannot end here
       \               the path MUST continue right
        3
         \
          4          naive:   min(0, ...) = 0  →  returns 1   ✗
           \
            5        correct: skip the nil side  →  returns 5  ✓
             \
              6      ← the only real leaf
```

### Code

```go
func minDepth(root *TreeNode) int {
    if root == nil {
        return 0
    }

    // A real leaf: no children at all.
    if root.Left == nil && root.Right == nil {
        return 1
    }

    // Exactly one child: a nil side is NOT a leaf, so the path must
    // continue through the side that exists.
    if root.Left == nil {
        return 1 + minDepth(root.Right)
    }
    if root.Right == nil {
        return 1 + minDepth(root.Left)
    }

    // Both children exist: now min is safe.
    left := minDepth(root.Left)
    right := minDepth(root.Right)
    if left < right {
        return left + 1
    }
    return right + 1
}

// minDepthBFS stops at the first leaf, which DFS cannot do.
func minDepthBFS(root *TreeNode) int {
    if root == nil {
        return 0
    }

    queue := []*TreeNode{root}
    depth := 1

    for len(queue) > 0 {
        levelSize := len(queue)
        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]

            if node.Left == nil && node.Right == nil {
                return depth // shallowest level containing a leaf
            }
            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
        depth++
    }
    return depth
}
```

```python
def minDepth(root):
    if root is None:
        return 0
    if root.left is None and root.right is None:
        return 1                             # a real leaf
    if root.left is None:
        return 1 + minDepth(root.right)      # nil is not a leaf: go right
    if root.right is None:
        return 1 + minDepth(root.left)       # nil is not a leaf: go left
    return 1 + min(minDepth(root.left), minDepth(root.right))
```

### Complexity
DFS: O(n) time, O(h) space. **BFS: O(n) worst case but often far less** — it stops at the first leaf, so a tree with one short branch and one huge branch is resolved almost immediately.

---

## 11. Solved Example 3

### Problem — Maximum Depth of N-ary Tree (LeetCode 559)
Each node has a list of children instead of exactly two. Return the maximum depth.

### Thought Process
1. Nothing conceptual changes: the height is still one more than the tallest child's height.
2. `max(left, right)` becomes a loop taking the max over **all** children.
3. A node with an empty children list is a leaf and returns 1 — which the loop handles for free, since the running max starts at 0.
4. Base case is still `nil → 0`.
5. Every node is visited once, so it stays O(n) regardless of branching factor.

### Dry Run

Input: `root = [1, null, 3, 2, 4, null, 5, 6]` — node `1` has children `3, 2, 4`, and node `3` has children `5, 6`:

```text
          1
        / | \
       3  2  4
      / \
     5   6
```

| call | children's heights | max over children | returns |
|------|--------------------|-------------------|---------|
| `depth(5)` | none | 0 | **1** |
| `depth(6)` | none | 0 | **1** |
| `depth(2)` | none | 0 | **1** |
| `depth(4)` | none | 0 | **1** |
| `depth(3)` | `5 → 1`, `6 → 1` | 1 | `1 + 1` = **2** |
| `depth(1)` | `3 → 2`, `2 → 1`, `4 → 1` | 2 | `1 + 2` = **3** |

Output: **3** ✓

The longest path is `1 → 3 → 5` (or `1 → 3 → 6`), which has 3 nodes. ✓

Note `depth(2)` and `depth(4)`: their children lists are empty, so the loop body never runs, the running max stays 0, and they correctly return 1.

### Visualization

```text
          1  ────────── 1 + max(2, 1, 1) = 3   ★
        / | \
       3  2  4
      /|   (1) (1)
     5 6  ────────────── 3 returns 1 + max(1, 1) = 2
   (1)(1)

the only change from the binary case: max over ALL children
```

### Code

```go
// NaryNode has an arbitrary number of children instead of exactly two.
type NaryNode struct {
    Val      int
    Children []*NaryNode
}

func maxDepthNary(root *NaryNode) int {
    if root == nil {
        return 0
    }

    // Max over ALL children. An empty list leaves this at 0,
    // so a leaf correctly returns 1.
    tallestChild := 0
    for _, child := range root.Children {
        if h := maxDepthNary(child); h > tallestChild {
            tallestChild = h
        }
    }

    return 1 + tallestChild
}
```

```python
def maxDepth(root):
    """N-ary version: max over ALL children."""
    if root is None:
        return 0
    # An empty children list leaves the max at 0, so a leaf returns 1.
    tallest_child = 0
    for child in root.children:
        tallest_child = max(tallest_child, maxDepth(child))
    return 1 + tallest_child
```

### Complexity
Time **O(n)** — every node is visited once, whatever the branching factor. Space **O(h)** for the recursion stack.

> The same generalisation applies to every problem in this chapter: swap the two hard-coded child slots for a loop over the children list, and the logic is unchanged. That is a good sign the recursion was expressing the actual structure rather than an accident of binary trees.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 104 | Max Depth | Easy | Core trees application |
| 111 | Min Depth | Easy | Core trees application |
| 559 | N-ary Depth | Medium | Core trees application |
| 110 | Balanced | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tree Height logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tree Height (Trees).
- **Signal:** height, depth, recursion, postorder, tree.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tree Height invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tree Height
FAMILY : Trees (Intermediate)
WHEN   : height, depth, recursion, postorder, tree
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 104, 111, 559, 110
```

---

*Part of the DSA Patterns Handbook — pattern 55 of 100.*
