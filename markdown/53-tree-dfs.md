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

**The question this pattern keeps answering:** *"Visit every node of a tree — and combine what the children tell me into an answer for the parent."*

### Intuition
There isn't really a "brute force" for visiting a tree; every node must be seen at least once. The naive part is in **how** you manage the walk.

### Algorithm (the awkward manual version)
1. Start at the root.
2. Keep a list of nodes you still need to visit and a set of nodes already seen.
3. Repeatedly pick a node, mark it seen, and append its children to the list.
4. Afterwards, make a second pass to compute whatever the question asked for.

### Complexity
- Time: O(n) — unavoidable, every node is visited.
- Space: O(n) for the bookkeeping.

### Drawbacks
- The "already seen" set is **pure waste in a tree**: a tree has no cycles and every node has exactly one parent, so you can never arrive twice. That set is only needed for graphs.
- Separating "walk the tree" from "compute the answer" forces two passes and extra storage, when a single recursive walk can compute the answer on the way back up.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A tree is made of smaller trees, so solve the whole problem by asking each child the *same question* and combining their answers.**

That is all DFS on a tree is. The recursion mirrors the structure of the data.

```text
                answer(node)
                     │
        ┌────────────┴────────────┐
   answer(left)              answer(right)
        │                         │
      ...                       ...
```

### The thought process

```text
We need    : some fact about a tree (depth, sum, a traversal order).
Notice     : the left subtree is a tree. So is the right subtree.
             The question I'm asking about the whole tree is exactly
             the question I'd ask about each of them.
Therefore  : write a function that answers it for a node, assuming
             the recursive calls answer it for the children.
Now        : the only two things left to decide are
               1. the BASE CASE (what does an empty tree return?)
               2. the COMBINE step (how do child answers make mine?)
```

### The two questions that define every tree DFS

Every solution in this family is these two lines and nothing more:

```text
1. BASE CASE  — what do I return for a nil node?
2. COMBINE    — given left's answer and right's answer, what is mine?
```

| Problem | Base case | Combine |
|---|---|---|
| Max depth | `0` | `1 + max(left, right)` |
| Node count | `0` | `1 + left + right` |
| Sum of values | `0` | `node.Val + left + right` |
| Contains a value | `false` | `left \|\| right \|\| node.Val == target` |

Get the base case right and the combine step usually writes itself.

### Why `nil → 0` and not "a leaf → 1"

The tempting base case is *"if the node is a leaf, return 1"*. It is worse, for two reasons:

- It needs **two** checks (`node == nil` for safety **and** `isLeaf`), so it's longer, not shorter.
- It breaks on a node with exactly one child. `if isLeaf return 1` never fires for such a node, and the missing branch returns whatever `nil` returns — so you need the `nil` case anyway.

**Always handle `nil` first.** It is the true empty tree, it makes one-child nodes fall out automatically, and it is a single check.

### The three DFS orders — one line of code apart

The traversal orders differ *only* in where you touch the node relative to the recursive calls:

```text
PREORDER   visit(node); go left; go right      → node before its subtrees
INORDER    go left; visit(node); go right      → node between them
POSTORDER  go left; go right; visit(node)      → node after its subtrees
```

Which one you need follows from the question:

| You need… | Order | Why |
|---|---|---|
| To copy/serialise a tree top-down | **preorder** | the parent must exist before its children |
| Sorted output from a **BST** | **inorder** | left subtree < node < right subtree |
| To compute from children upward | **postorder** | children's answers must be ready first |
| To delete/free a tree | **postorder** | you cannot free a parent before its children |

> Almost every "compute a value" tree problem is postorder — because you need the children's answers before you can produce your own.

### Recursion vs an explicit stack

Recursion *is* a stack; the compiler manages it. Write it recursively first.

Use an explicit stack when the tree could be deep enough to overflow — a degenerate tree of 10⁵ nodes is a linked list, and many languages blow the stack around that depth. The iterative preorder is easy (push right, then left). Iterative inorder and postorder are noticeably fiddlier, which is exactly why the recursive version is the one to reach for by default.

### How should I recognize this?

```text
If you see...
  a binary tree and "depth / height / sum / count / path / check property"
  "traverse", "preorder / inorder / postorder"
  anything where a node's answer depends on its subtrees
        ↓
Think about...
  "What do I return for nil, and how do I combine left and right?"
        ↓
Use...
  compute a value      → postorder recursion
  sorted BST output    → inorder
  top-down copy/print  → preorder
  very deep tree       → the same order, with an explicit stack
```

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

```text
        3
       / \
      9  20
        /  \
       15   7

maxDepth(3)
  ├── maxDepth(9)  → 1 + max(0, 0) = 1
  └── maxDepth(20)
        ├── maxDepth(15) → 1
        └── maxDepth(7)  → 1
        → 1 + max(1, 1) = 2
  → 1 + max(1, 2) = 3

answers flow UP from the leaves — that is postorder
```

### Interview explanation
"A tree is recursive by construction, so I'll write a recursive function and let it mirror the structure. The only two decisions are the base case and the combine step: for `nil` I return the identity value — 0 for a depth or a sum — and for a real node I combine the two child answers. I handle `nil` rather than checking for a leaf, because that also covers nodes with a single child without a special case. This is postorder: I need both children's answers before I can produce mine. It's O(n) time since every node is visited once, and O(h) space for the recursion stack, which is O(log n) on a balanced tree and O(n) in the degenerate case. If the tree could be deep enough to overflow the stack, I'd convert it to an explicit stack."

---

## 5. Generic Templates

> Decide the base case, decide the combine step. Everything else follows.

```go
// MaxDepth is the canonical postorder shape: combine the children's answers.
func MaxDepth(root *TreeNode) int {
    if root == nil {
        return 0 // base case: an empty tree has depth 0
    }
    left := MaxDepth(root.Left)
    right := MaxDepth(root.Right)

    // Combine: my depth is one more than my deeper child's.
    if left > right {
        return left + 1
    }
    return right + 1
}

// Preorder: node, then left, then right.
func Preorder(root *TreeNode) []int {
    result := []int{}
    var walk func(*TreeNode)
    walk = func(node *TreeNode) {
        if node == nil {
            return
        }
        result = append(result, node.Val) // visit BEFORE the subtrees
        walk(node.Left)
        walk(node.Right)
    }
    walk(root)
    return result
}

// Inorder: left, then node, then right. On a BST this yields sorted order.
func Inorder(root *TreeNode) []int {
    result := []int{}
    var walk func(*TreeNode)
    walk = func(node *TreeNode) {
        if node == nil {
            return
        }
        walk(node.Left)
        result = append(result, node.Val) // visit BETWEEN the subtrees
        walk(node.Right)
    }
    walk(root)
    return result
}

// Postorder: left, then right, then node.
func Postorder(root *TreeNode) []int {
    result := []int{}
    var walk func(*TreeNode)
    walk = func(node *TreeNode) {
        if node == nil {
            return
        }
        walk(node.Left)
        walk(node.Right)
        result = append(result, node.Val) // visit AFTER the subtrees
    }
    walk(root)
    return result
}

// PreorderIterative avoids recursion for very deep trees.
// Push right before left so left is processed first.
func PreorderIterative(root *TreeNode) []int {
    result := []int{}
    if root == nil {
        return result
    }
    stack := []*TreeNode{root}

    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        result = append(result, node.Val)

        if node.Right != nil {
            stack = append(stack, node.Right)
        }
        if node.Left != nil {
            stack = append(stack, node.Left) // popped first
        }
    }
    return result
}
```

```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right

def max_depth(root):
    """Postorder: combine the children's answers."""
    if root is None:
        return 0                        # base case: empty tree
    return 1 + max(max_depth(root.left), max_depth(root.right))

def preorder(root):
    result = []
    def walk(node):
        if node is None:
            return
        result.append(node.val)         # visit BEFORE the subtrees
        walk(node.left)
        walk(node.right)
    walk(root)
    return result

def inorder(root):
    """On a BST this yields sorted order."""
    result = []
    def walk(node):
        if node is None:
            return
        walk(node.left)
        result.append(node.val)         # visit BETWEEN the subtrees
        walk(node.right)
    walk(root)
    return result

def postorder(root):
    result = []
    def walk(node):
        if node is None:
            return
        walk(node.left)
        walk(node.right)
        result.append(node.val)         # visit AFTER the subtrees
    walk(root)
    return result

def preorder_iterative(root):
    """Push right before left so left is processed first."""
    if root is None:
        return []
    result, stack = [], [root]
    while stack:
        node = stack.pop()
        result.append(node.val)
        if node.right:
            stack.append(node.right)
        if node.left:
            stack.append(node.left)
    return result
```

```java
import java.util.*;

public class TreeDFS {
    public static class TreeNode {
        int val; TreeNode left, right;
        TreeNode(int val) { this.val = val; }
    }

    // Postorder: combine the children's answers.
    public static int maxDepth(TreeNode root) {
        if (root == null) return 0;                     // base case
        return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
    }

    public static List<Integer> preorder(TreeNode root) {
        List<Integer> result = new ArrayList<>();
        walkPre(root, result);
        return result;
    }

    private static void walkPre(TreeNode node, List<Integer> out) {
        if (node == null) return;
        out.add(node.val);              // visit BEFORE the subtrees
        walkPre(node.left, out);
        walkPre(node.right, out);
    }

    public static List<Integer> inorder(TreeNode root) {
        List<Integer> result = new ArrayList<>();
        walkIn(root, result);
        return result;
    }

    private static void walkIn(TreeNode node, List<Integer> out) {
        if (node == null) return;
        walkIn(node.left, out);
        out.add(node.val);              // visit BETWEEN the subtrees
        walkIn(node.right, out);
    }
}
```

```cpp
#include <functional>
#include <vector>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    explicit TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

// Postorder: combine the children's answers.
int maxDepth(TreeNode* root) {
    if (root == nullptr) return 0;                      // base case
    return 1 + max(maxDepth(root->left), maxDepth(root->right));
}

vector<int> preorder(TreeNode* root) {
    vector<int> result;
    function<void(TreeNode*)> walk = [&](TreeNode* node) {
        if (node == nullptr) return;
        result.push_back(node->val);    // visit BEFORE the subtrees
        walk(node->left);
        walk(node->right);
    };
    walk(root);
    return result;
}

vector<int> inorder(TreeNode* root) {
    vector<int> result;
    function<void(TreeNode*)> walk = [&](TreeNode* node) {
        if (node == nullptr) return;
        walk(node->left);
        result.push_back(node->val);    // visit BETWEEN the subtrees
        walk(node->right);
    };
    walk(root);
    return result;
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

### Problem — Maximum Depth of Binary Tree (LeetCode 104)
Return the number of nodes along the longest path from the root down to a leaf.

### Thought Process
1. Ask the two defining questions. **Base case:** an empty tree has depth `0`. **Combine:** my depth is `1 + ` the deeper of my two children.
2. That is postorder — I cannot answer until both children have answered.
3. Handling `nil` (rather than checking for a leaf) makes single-child nodes work with no extra case.
4. Every node is visited exactly once.

### Dry Run

Input:

```text
        3
       / \
      9  20
        /  \
       15   7
```

Calls unwind from the leaves upward:

| call | left result | right result | returns |
|------|-------------|--------------|---------|
| `maxDepth(9)`  | `maxDepth(nil)` = 0 | `maxDepth(nil)` = 0 | `1 + max(0,0)` = **1** |
| `maxDepth(15)` | 0 | 0 | **1** |
| `maxDepth(7)`  | 0 | 0 | **1** |
| `maxDepth(20)` | 1 (from 15) | 1 (from 7) | `1 + max(1,1)` = **2** |
| `maxDepth(3)`  | 1 (from 9) | 2 (from 20) | `1 + max(1,2)` = **3** |

Output: **3** ✓

Check by hand: the longest root-to-leaf path is `3 → 20 → 15`, which has 3 nodes. ✓

Notice nothing is computed on the way *down*. Every value is produced on the way back **up** — that is what postorder means in practice.

### Visualization

```text
        3  ──────────────── returns 1 + max(1, 2) = 3
       / \
      9  20 ─────────────── returns 1 + max(1, 1) = 2
   (1)   /  \
       15    7
      (1)   (1)  ────────── leaves return 1 + max(0, 0) = 1

answers flow UPWARD ↑
```

### Code

```go
func maxDepth(root *TreeNode) int {
    if root == nil {
        return 0 // base case: an empty tree has depth 0
    }

    // Both children must answer before I can.
    left := maxDepth(root.Left)
    right := maxDepth(root.Right)

    if left > right {
        return left + 1
    }
    return right + 1
}
```

```python
def maxDepth(root):
    if root is None:
        return 0                        # base case: empty tree
    # Both children answer first; then combine.
    return 1 + max(maxDepth(root.left), maxDepth(root.right))
```

### Complexity
Time **O(n)** — each node is visited once. Space **O(h)** for the recursion stack: O(log n) on a balanced tree, O(n) on a degenerate one.

---

## 10. Solved Example 2

### Problem — Binary Tree Preorder Traversal (LeetCode 144)
Return the node values in preorder: node, then left subtree, then right subtree.

### Thought Process
1. Preorder means visit the node **before** recursing — the only difference from the other two orders is where that line sits.
2. Recursive version: append `node.Val`, then walk left, then walk right.
3. The iterative version uses an explicit stack, which matters for trees deep enough to overflow the call stack.
4. **Push right before left.** A stack is last-in-first-out, so the child pushed *last* is popped first — and preorder needs left first.
5. Never push `nil` children; the pop loop stays clean.

### Dry Run

Input:

```text
      1
       \
        2
       /
      3
```

**Recursive:**

| call | action | output so far |
|------|--------|---------------|
| `walk(1)` | append `1`, then go left | `[1]` |
| `walk(nil)` | return | `[1]` |
| `walk(2)` | append `2`, then go left | `[1, 2]` |
| `walk(3)` | append `3`, both children nil | `[1, 2, 3]` |

**Iterative** — watch the push order:

| step | stack before (top on the right) | pop | push | output |
|------|----------------------------------|-----|------|--------|
| 1 | `[1]` | `1` | right `2` (no left) | `[1]` |
| 2 | `[2]` | `2` | no right; left `3` | `[1, 2]` |
| 3 | `[3]` | `3` | none | `[1, 2, 3]` |

Output: **`[1, 2, 3]`** ✓

A fuller push-order example on a two-child root:

```text
      1
     / \
    2   3

push 1        stack [1]
pop 1, push 3 then 2   stack [3, 2]   ← right first, so left is on top
pop 2         output [1, 2]
pop 3         output [1, 2, 3]        ✓
```

Pushing left first would produce `[1, 3, 2]` — the mirror image.

### Visualization

```text
preorder = node, left, right

      1          visit 1  ──▶ output 1
       \
        2        visit 2  ──▶ output 2
       /
      3          visit 3  ──▶ output 3

  [1, 2, 3]
```

### Code

```go
func preorderTraversal(root *TreeNode) []int {
    result := []int{}

    var walk func(*TreeNode)
    walk = func(node *TreeNode) {
        if node == nil {
            return
        }
        result = append(result, node.Val) // visit BEFORE the subtrees
        walk(node.Left)
        walk(node.Right)
    }

    walk(root)
    return result
}

// preorderIterative is the same order without recursion, for very deep trees.
func preorderIterative(root *TreeNode) []int {
    result := []int{}
    if root == nil {
        return result
    }

    stack := []*TreeNode{root}
    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        result = append(result, node.Val)

        // Push RIGHT first so LEFT is popped first (a stack is LIFO).
        if node.Right != nil {
            stack = append(stack, node.Right)
        }
        if node.Left != nil {
            stack = append(stack, node.Left)
        }
    }
    return result
}
```

```python
def preorderTraversal(root):
    result = []

    def walk(node):
        if node is None:
            return
        result.append(node.val)         # visit BEFORE the subtrees
        walk(node.left)
        walk(node.right)

    walk(root)
    return result

def preorder_iterative(root):
    """Same order without recursion; push RIGHT first so LEFT pops first."""
    if root is None:
        return []
    result, stack = [], [root]
    while stack:
        node = stack.pop()
        result.append(node.val)
        if node.right:
            stack.append(node.right)
        if node.left:
            stack.append(node.left)
    return result
```

### Complexity
Time O(n), Space O(h) — the recursion stack, or the explicit stack, holds at most one node per level.

---

## 11. Solved Example 3

### Problem — Binary Tree Inorder Traversal (LeetCode 94)
Return the node values in inorder: left subtree, then node, then right subtree.

### Thought Process
1. Inorder moves the visit **between** the two recursive calls — one line different from preorder.
2. This is the order that matters most, because **inorder on a BST produces sorted output.** The BST property (`left < node < right`) makes it fall out.
3. The iterative version is genuinely trickier than preorder: you must descend all the way left, pushing as you go, before visiting anything.
4. Then pop, visit, and move to the popped node's right child — repeating the whole descent from there.
5. The loop continues while either the stack is non-empty or there is still a node to descend into.

### Dry Run

Input:

```text
      1
       \
        2
       /
      3
```

**Recursive:**

| call | action | output |
|------|--------|--------|
| `walk(1)` | go left first → `nil`, return | — |
| back at `1` | append `1`, go right | `[1]` |
| `walk(2)` | go left | — |
| `walk(3)` | left is nil; append `3`; right is nil | `[1, 3]` |
| back at `2` | append `2`, go right → nil | `[1, 3, 2]` |

Output: **`[1, 3, 2]`** ✓

**Iterative** — the descend/visit alternation:

| step | current | stack | action | output |
|------|---------|-------|--------|--------|
| 1 | `1` | `[]` | push 1, go left | — |
| 2 | `nil` | `[1]` | pop 1, visit, go right | `[1]` |
| 3 | `2` | `[]` | push 2, go left | `[1]` |
| 4 | `3` | `[2]` | push 3, go left | `[1]` |
| 5 | `nil` | `[2,3]` | pop 3, visit, go right | `[1, 3]` |
| 6 | `nil` | `[2]` | pop 2, visit, go right | `[1, 3, 2]` |
| 7 | `nil` | `[]` | both empty → stop | `[1, 3, 2]` |

**And the reason inorder matters** — on a BST:

```text
        2
       / \
      1   3        inorder → [1, 2, 3]   sorted ✓
```

### Visualization

```text
inorder = left, node, right

      1
       \           left of 1 is empty → visit 1
        2
       /           inside 2: go left to 3 first
      3            3 has no left → visit 3, then back up → visit 2

  [1, 3, 2]
```

### Code

```go
func inorderTraversal(root *TreeNode) []int {
    result := []int{}

    var walk func(*TreeNode)
    walk = func(node *TreeNode) {
        if node == nil {
            return
        }
        walk(node.Left)
        result = append(result, node.Val) // visit BETWEEN the subtrees
        walk(node.Right)
    }

    walk(root)
    return result
}

// inorderIterative: descend left pushing as you go, then pop-visit-go-right.
func inorderIterative(root *TreeNode) []int {
    result := []int{}
    stack := []*TreeNode{}
    current := root

    for current != nil || len(stack) > 0 {
        // Go as far left as possible, remembering the path.
        for current != nil {
            stack = append(stack, current)
            current = current.Left
        }

        // Nothing further left: the top of the stack is next in order.
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        result = append(result, node.Val)

        // Now do the same for its right subtree.
        current = node.Right
    }
    return result
}
```

```python
def inorderTraversal(root):
    result = []

    def walk(node):
        if node is None:
            return
        walk(node.left)
        result.append(node.val)         # visit BETWEEN the subtrees
        walk(node.right)

    walk(root)
    return result

def inorder_iterative(root):
    """Descend left pushing as you go, then pop-visit-go-right."""
    result, stack, current = [], [], root
    while current or stack:
        while current:                  # go as far left as possible
            stack.append(current)
            current = current.left
        node = stack.pop()              # nothing further left: visit it
        result.append(node.val)
        current = node.right            # repeat on the right subtree
    return result
```

### Complexity
Time O(n), Space O(h).

> The payoff: inorder on a **BST** is sorted, which turns "validate a BST", "find the k-th smallest", and "find the minimum absolute difference" into one-pass problems — you just check or scan the inorder sequence.

---

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
