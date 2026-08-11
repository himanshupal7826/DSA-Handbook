# 56 · Diameter of Tree

> **One-liner:** At each node combine left+right heights; track the global best path.

---

## 1. Overview

### Definition
The **Diameter of Tree** pattern belongs to the *Trees* family. At each node combine left+right heights; track the global best path.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
diameter, longest path, tree dp, postorder, through node.

### Constraints
- Input size where the brute-force complexity would time out — the Diameter of Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Diameter of Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Diameter of Tree is the upgrade.
- The wording maps onto: diameter, longest path, tree dp, postorder, through node.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the best path in this tree?"* — where the path may **bend**, going down one side, through a node, and back down the other.

### Intuition
Every path bends at exactly one topmost node. So try every node as that bend point.

### Algorithm
1. For each node `v` in the tree:
2. &nbsp;&nbsp;Compute the height of `v`'s left subtree.
3. &nbsp;&nbsp;Compute the height of `v`'s right subtree.
4. &nbsp;&nbsp;The best path bending at `v` is `leftHeight + rightHeight`.
5. Return the maximum over all `v`.

### Complexity
- Time: **O(n²)** — computing a height is O(size of subtree), and we do it for every node. On a degenerate tree that is the full quadratic cost.
- Space: O(h).

### Drawbacks
- The idea is right; the **execution** repeats work catastrophically. Computing the height at the root walks the entire tree, then we do it again at the root's child, and again at its child…
- Every node's height gets recomputed once per ancestor. But a single postorder pass already computes every height exactly once — we just have to *use* it while we're there.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Do a single postorder pass. At each node, *record* the best bending path but *return* only the best straight-down path.**

That split is the entire pattern, and it is the thing worth remembering:

```text
RETURN   the best path going straight DOWN from this node
         (through at most ONE child) — the parent can extend this

RECORD   the best path BENDING at this node
         (left + node + right) — the parent can NEVER extend this
```

### The thought process

```text
We need    : the best path, which may bend at some node.
Obvious way: try each node as the bend point, measuring both subtrees.
Too slow   : O(n^2) — heights get recomputed once per ancestor.
Notice     : one postorder pass already computes every subtree's
             answer exactly once. We just have to consume it in place.
Problem    : the answer we want (a bent path) is not the answer the
             parent needs (a straight one).
Therefore  : return the straight one, and stash the bent one in a
             variable that outlives the recursion.
Now        : O(n) time, one pass.
```

### Why you cannot return the bent path

This is the part that trips people up, and it is pure geometry.

Suppose node `v` uses **both** children and returns that combined value to its parent `p`. Then `p` would be extending a path that already goes down `v`'s left side and down `v`'s right side. Adding `p` on top would create a shape with **three** branches meeting at `v` — that is a subtree, not a path.

```text
        p
        │
        v          ← if v hands up "left + right",
       / \           p would attach a THIRD branch at v
    left   right     which is no longer a path
```

A path is a simple sequence of nodes. Through any node it can use **at most two** of its edges. So:

- the parent may extend a path that arrives from **one** child → that is what we return
- a path that already used **two** children is finished → that is what we record

### Steps

```text
Step 1 → best = 0 (or -infinity for sums that can be negative)
Step 2 → define gain(node):
Step 3 →     if node is nil, return 0
Step 4 →     left  = gain(node.Left)
Step 5 →     right = gain(node.Right)
Step 6 →     best = max(best, left + right + <node's own contribution>)
                                └────── the BENT path, recorded ──────┘
Step 7 →     return <node's contribution> + max(left, right)
                                └───── the STRAIGHT path, returned ───┘
Step 8 → run gain(root); the answer is `best`
```

### The three problems are the same code with two knobs

| Problem | Node's contribution | `best` update | Clamp negatives? |
|---|---|---|---|
| Diameter (edges) | 1 per edge | `left + right` | no — lengths are ≥ 0 |
| Max path sum | `node.Val` | `node.Val + left + right` | **yes** — `max(0, child)` |
| Longest univalue | 1 per matching edge | `leftArrow + rightArrow` | n/a — reset to 0 on mismatch |

### Why max-path-sum needs `max(0, childGain)`

With values that can be negative, a subtree may actively *hurt* you. If the left subtree's best downward sum is `−5`, attaching it makes every path worse. Since a path may simply stop at the current node, the right move is to treat a negative contribution as **zero**:

```text
leftGain  = max(0, gain(node.Left))
rightGain = max(0, gain(node.Right))
```

Diameter needs no such clamp because a length is never negative.

Also seed `best` at negative infinity, not `0`. A tree of all-negative values has a best path sum that is negative — the largest single node — and starting at `0` would wrongly report `0`.

### Counting edges or nodes?

Diameter is defined in **edges**, and this bites people:

```text
a single node        →  diameter 0   (no edges)
two nodes            →  diameter 1
```

If `gain` returns a height in nodes, then `left + right` is already the edge count of the bent path — the two `+1`s that would convert to nodes are exactly the two edges joining the children to the node. Convenient, but only if you state which unit you are in.

### How should I recognize this?

```text
If you see...
  "diameter", "longest path", "maximum path sum"
  "longest path with property X", "path between ANY two nodes"
  a path that does NOT have to pass through the root
        ↓
Think about...
  "This path bends somewhere. What do I hand upward,
   and what do I record on the spot?"
        ↓
Use...
  one postorder pass
  return  → best straight-down value (one child only)
  record  → best bent value (both children) in an outer variable
```

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="dia-56" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">diameter at A = leftH + rightH = 2 + 2 = 4 edges</text>
  <!-- highlighted diameter path edges D-B-A-C-F -->
  <line x1="266" y1="54" x2="194" y2="96" stroke="#059669" stroke-width="4"/>
  <line x1="294" y1="54" x2="366" y2="96" stroke="#059669" stroke-width="4"/>
  <line x1="166" y1="124" x2="134" y2="166" stroke="#059669" stroke-width="4"/>
  <line x1="394" y1="124" x2="426" y2="166" stroke="#059669" stroke-width="4"/>
  <!-- non-path edge -->
  <line x1="194" y1="124" x2="226" y2="166" stroke="#475569"/>
  <!-- nodes -->
  <circle cx="280" cy="40" r="20" fill="#ecfdf5" stroke="#059669"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">A</text>
  <circle cx="180" cy="110" r="20" fill="#ecfdf5" stroke="#059669"/><text x="180" y="115" text-anchor="middle" fill="#1e293b">B</text>
  <circle cx="380" cy="110" r="20" fill="#ecfdf5" stroke="#059669"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">C</text>
  <circle cx="120" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">D</text>
  <circle cx="240" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">E</text>
  <circle cx="440" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="440" y="185" text-anchor="middle" fill="#1e293b">F</text>
  <text x="316" y="44" text-anchor="start" fill="#059669" font-weight="700">L=2, R=2</text>
  <text x="280" y="242" text-anchor="middle" fill="#059669" font-weight="700">longest path: D to B to A to C to F</text>
  <text x="280" y="260" text-anchor="middle" fill="#64748b">each node tests leftH + rightH against the global best</text>
</svg>
```

```text
        1
       / \
      2   3
     / \
    4   5

at node 2:  left gain = 1 (from 4), right gain = 1 (from 5)
            RECORD bent path 4-2-5  → 1 + 1 = 2 edges
            RETURN straight 1 + max(1,1) = 2   (2 nodes down)

at node 1:  left gain = 2 (from 2), right gain = 1 (from 3)
            RECORD bent path 4-2-1-3 → 2 + 1 = 3 edges   ★
            RETURN 1 + max(2,1) = 3

answer: 3 edges
```

### Interview explanation
"Every path bends at exactly one topmost node, so the brute force tries each node as that bend — but recomputing subtree heights per node makes it O(n²). Instead I do one postorder pass. The key realisation is that the value I want and the value my parent needs are different: my parent can only extend a path arriving from one of my children, so I **return** the best straight-down value, while I **record** the best bent value — left plus right plus me — in a variable outside the recursion. A bent path can't be extended upward without creating a three-way branch, which isn't a path. That's O(n) time, O(h) space. For the max-path-sum variant I also clamp negative child gains to zero, since a path may just stop at the current node."

---

## 5. Generic Templates

> One postorder pass. Return the straight-down value; record the bent one.

```go
// Diameter returns the number of EDGES on the longest path between any
// two nodes. A single node has diameter 0.
func Diameter(root *TreeNode) int {
    best := 0

    // height returns the number of nodes on the longest downward path.
    var height func(*TreeNode) int
    height = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        left := height(node.Left)
        right := height(node.Right)

        // RECORD: the path bending here. left + right is already the
        // edge count, since each term includes the edge into that child.
        if left+right > best {
            best = left + right
        }

        // RETURN: the best straight-down path, through ONE child only.
        if left > right {
            return left + 1
        }
        return right + 1
    }

    height(root)
    return best
}

// MaxPathSum returns the largest sum over any path. Values may be negative.
func MaxPathSum(root *TreeNode) int {
    best := math.MinInt32 // NOT 0: an all-negative tree has a negative answer

    var gain func(*TreeNode) int
    gain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        // A negative subtree only hurts, and a path may stop here instead.
        left := gain(node.Left)
        if left < 0 {
            left = 0
        }
        right := gain(node.Right)
        if right < 0 {
            right = 0
        }

        // RECORD: the path bending at this node.
        if node.Val+left+right > best {
            best = node.Val + left + right
        }

        // RETURN: straight down through ONE child.
        if left > right {
            return node.Val + left
        }
        return node.Val + right
    }

    gain(root)
    return best
}
```

```python
def diameter(root):
    """Number of EDGES on the longest path between any two nodes."""
    best = 0

    def height(node):
        nonlocal best
        if node is None:
            return 0
        left = height(node.left)
        right = height(node.right)

        best = max(best, left + right)      # RECORD: the bent path
        return 1 + max(left, right)         # RETURN: straight down

    height(root)
    return best

def max_path_sum(root):
    """Largest sum over any path. Values may be negative."""
    best = float("-inf")                    # NOT 0: all-negative trees exist

    def gain(node):
        nonlocal best
        if node is None:
            return 0
        # A negative subtree only hurts: a path may stop here instead.
        left = max(0, gain(node.left))
        right = max(0, gain(node.right))

        best = max(best, node.val + left + right)   # RECORD: bent
        return node.val + max(left, right)          # RETURN: straight

    gain(root)
    return best
```

```java
public class TreeDiameter {
    public static class TreeNode {
        int val; TreeNode left, right;
        TreeNode(int val) { this.val = val; }
    }

    private int best;

    public int diameter(TreeNode root) {
        best = 0;
        height(root);
        return best;
    }

    private int height(TreeNode node) {
        if (node == null) return 0;
        int left = height(node.left);
        int right = height(node.right);

        best = Math.max(best, left + right);      // RECORD: the bent path
        return 1 + Math.max(left, right);         // RETURN: straight down
    }

    private int bestSum;

    public int maxPathSum(TreeNode root) {
        bestSum = Integer.MIN_VALUE;              // NOT 0
        gain(root);
        return bestSum;
    }

    private int gain(TreeNode node) {
        if (node == null) return 0;
        int left = Math.max(0, gain(node.left));  // negatives only hurt
        int right = Math.max(0, gain(node.right));

        bestSum = Math.max(bestSum, node.val + left + right);   // RECORD
        return node.val + Math.max(left, right);                // RETURN
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <functional>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    explicit TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

int diameter(TreeNode* root) {
    int best = 0;
    function<int(TreeNode*)> height = [&](TreeNode* node) -> int {
        if (node == nullptr) return 0;
        int left = height(node->left);
        int right = height(node->right);

        best = max(best, left + right);           // RECORD: the bent path
        return 1 + max(left, right);              // RETURN: straight down
    };
    height(root);
    return best;
}

int maxPathSum(TreeNode* root) {
    int best = INT_MIN;                           // NOT 0
    function<int(TreeNode*)> gain = [&](TreeNode* node) -> int {
        if (node == nullptr) return 0;
        int left = max(0, gain(node->left));      // negatives only hurt
        int right = max(0, gain(node->right));

        best = max(best, node->val + left + right);   // RECORD
        return node->val + max(left, right);          // RETURN
    };
    gain(root);
    return best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Diameter of Tree (Optimal) |
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

### Problem — Diameter of Binary Tree (LeetCode 543)
Return the length of the longest path between any two nodes, measured in **edges**. The path need not pass through the root.

### Thought Process
1. Every path bends at one topmost node, so consider each node as the bend.
2. A single postorder pass already computes every subtree's height once — consume it there instead of recomputing.
3. At each node: **record** `leftHeight + rightHeight` (the bent path, in edges) and **return** `1 + max(leftHeight, rightHeight)` (the straight path, in nodes).
4. `left + right` is already an edge count because each height includes the edge down into that child.
5. Seed `best` at 0: a single node has diameter 0, and lengths are never negative.

### Dry Run

Input:

```text
        1
       / \
      2   3
     / \
    4   5
```

| node | left height | right height | recorded `left+right` | best | returned `1+max` |
|------|-------------|--------------|------------------------|------|-------------------|
| `4` | 0 | 0 | 0 | 0 | **1** |
| `5` | 0 | 0 | 0 | 0 | **1** |
| `2` | 1 | 1 | `1+1` = **2** | 2 | **2** |
| `3` | 0 | 0 | 0 | 2 | **1** |
| `1` | 2 | 1 | `2+1` = **3** | **3** | **3** |

Output: **3** ✓

Verify: the longest path is `4 → 2 → 1 → 3`, which has 4 nodes and therefore **3 edges**. ✓

Watch node `2` closely. It recorded `2` (the bent path `4 → 2 → 5`) but returned `2` as a *height* — the straight path `2 → 4`. Those two numbers happen to be equal here, but they mean different things, and only the returned one is allowed to travel upward. Node `1` then built `2 + 1 = 3` from that returned height.

### Visualization

```text
        1        record 2 + 1 = 3 edges   ★     return height 3
       / \
      2   3      2: record 1+1 = 2 edges        return height 2
     / \    (h=1)
    4   5
  (h=1)(h=1)

the winning path 4 → 2 → 1 → 3 BENDS at node 1
node 1 cannot hand it upward — it already uses two of node 1's edges
```

### Code

```go
func diameterOfBinaryTree(root *TreeNode) int {
    best := 0

    // height returns the number of nodes on the longest downward path.
    var height func(*TreeNode) int
    height = func(node *TreeNode) int {
        if node == nil {
            return 0
        }

        left := height(node.Left)
        right := height(node.Right)

        // RECORD the bent path. left + right is already in EDGES, because
        // each height counts the edge down into that child.
        if left+right > best {
            best = left + right
        }

        // RETURN the straight path — through at most ONE child, so the
        // parent can extend it without creating a three-way branch.
        if left > right {
            return left + 1
        }
        return right + 1
    }

    height(root)
    return best
}
```

```python
def diameterOfBinaryTree(root):
    best = 0

    def height(node):
        nonlocal best
        if node is None:
            return 0
        left = height(node.left)
        right = height(node.right)

        best = max(best, left + right)      # RECORD the bent path (edges)
        return 1 + max(left, right)         # RETURN the straight path

    height(root)
    return best
```

### Complexity
Time **O(n)** — one postorder pass, each height computed exactly once. Space **O(h)** for the recursion stack.

---

## 10. Solved Example 2

### Problem — Binary Tree Maximum Path Sum (LeetCode 124)
Return the largest sum over any path. Node values may be negative, and the path must contain at least one node.

### Thought Process
1. Same skeleton: record the bent sum, return the straight one.
2. New wrinkle — **negative subtrees**. If a child's best downward sum is negative, attaching it makes things worse, and a path is allowed to stop at the current node. So clamp: `max(0, childGain)`.
3. `best` must start at negative infinity, not `0`. In an all-negative tree the answer is the single largest node, and `0` would beat it wrongly.
4. Record `node.Val + left + right` — the path bending here.
5. Return `node.Val + max(left, right)` — the straight path the parent can extend.

### Dry Run

Input:

```text
      -10
      /  \
     9    20
         /  \
        15   7
```

| node | raw left gain | raw right gain | clamped left | clamped right | recorded `val+L+R` | best | returned `val+max` |
|------|---------------|----------------|--------------|---------------|---------------------|------|---------------------|
| `9`  | 0 | 0 | 0 | 0 | `9+0+0` = 9 | 9 | **9** |
| `15` | 0 | 0 | 0 | 0 | `15` | 15 | **15** |
| `7`  | 0 | 0 | 0 | 0 | `7` | 15 | **7** |
| `20` | 15 | 7 | 15 | 7 | `20+15+7` = **42** | **42** | `20+15` = **35** |
| `-10`| 9 | 35 | 9 | 35 | `-10+9+35` = 34 | **42** | `-10+35` = 25 |

Output: **42** ✓

The winning path is `15 → 20 → 7`, summing to 42. It bends at `20`, so node `20` recorded it but handed its parent only `35` (the straight path `20 → 15`).

**The clamp, demonstrated.** On `[2, -1, -2]`:

```text
      2
     / \
   -1  -2
```

Raw gains are `−1` and `−2`. Clamped, both become `0`, so node `2` records `2 + 0 + 0 = 2` — correctly preferring the single-node path over dragging in a negative child. Without the clamp it would record `2 − 1 − 2 = −1`. ✓

### Visualization

```text
      -10          record -10 + 9 + 35 = 34     return 25
      /  \
     9    20       record 20 + 15 + 7 = 42  ★   return 20 + 15 = 35
   (9)   /  \
       15    7
     (15)   (7)

the best path 15 → 20 → 7 bends at 20 and stops there —
the parent -10 could only ever receive the straight 35
```

### Code

```go
func maxPathSum(root *TreeNode) int {
    // NOT 0: an all-negative tree has a negative answer.
    best := math.MinInt32

    // gain returns the best downward sum starting at node, or 0 if
    // taking this subtree at all would hurt.
    var gain func(*TreeNode) int
    gain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }

        // A negative child only hurts; a path may simply stop here.
        left := gain(node.Left)
        if left < 0 {
            left = 0
        }
        right := gain(node.Right)
        if right < 0 {
            right = 0
        }

        // RECORD: the path bending at this node, using both children.
        if node.Val+left+right > best {
            best = node.Val + left + right
        }

        // RETURN: straight down through ONE child only.
        if left > right {
            return node.Val + left
        }
        return node.Val + right
    }

    gain(root)
    return best
}
```

```python
def maxPathSum(root):
    best = float("-inf")                # NOT 0: all-negative trees exist

    def gain(node):
        nonlocal best
        if node is None:
            return 0
        # A negative child only hurts; the path may stop at this node.
        left = max(0, gain(node.left))
        right = max(0, gain(node.right))

        best = max(best, node.val + left + right)   # RECORD: bent path
        return node.val + max(left, right)          # RETURN: straight path

    gain(root)
    return best
```

### Complexity
Time **O(n)**, Space **O(h)**.

---

## 11. Solved Example 3

### Problem — Longest Univalue Path (LeetCode 687)
Return the length, in **edges**, of the longest path where every node has the same value. The path need not pass through the root.

### Thought Process
1. Same record/return split, with one extra condition: an edge only counts if the child's value **equals** the current node's value.
2. So compute each child's downward arrow length, then decide whether the edge to that child survives:
   - values match → `childArrow + 1`
   - values differ → `0`, the chain is broken here
3. **Record** `leftArrow + rightArrow` — the bent univalue path through this node.
4. **Return** `max(leftArrow, rightArrow)` — the straight one.
5. Note the recursion must visit every child regardless, because a longer univalue path may live entirely inside a subtree with a different value.

### Dry Run

Input:

```text
        5
       / \
      4   5
     / \   \
    1   1   5
```

| node | left arrow | right arrow | why | recorded `L+R` | best | returned `max` |
|------|-----------|-------------|-----|-----------------|------|-----------------|
| `1` (left) | 0 | 0 | leaf | 0 | 0 | **0** |
| `1` (right)| 0 | 0 | leaf | 0 | 0 | **0** |
| `4` | **0** | **0** | children are `1`, `1` ≠ `4` → both broken | 0 | 0 | **0** |
| `5` (deepest right) | 0 | 0 | leaf | 0 | 0 | **0** |
| `5` (right child) | 0 | **1** | right child is `5` = `5` → `0+1` | `0+1` = 1 | 1 | **1** |
| `5` (root) | **0** | **2** | left is `4` ≠ `5` → 0; right is `5` = `5` → `1+1` | `0+2` = **2** | **2** | **2** |

Output: **2** ✓

The path is `5 → 5 → 5` down the right spine — 3 nodes, **2 edges**. ✓

Node `4` is the instructive one: both its children hold `1`, which differs from `4`, so both arrows reset to `0` even though the recursion did visit them. The chain is broken at that node, not below it.

### Visualization

```text
        5              left arrow 0 (4 ≠ 5), right arrow 2 (5 = 5)
       / \                 record 0 + 2 = 2 edges   ★
      4   5            right child: arrow 1 (its right 5 matches)
     / \   \
    1   1   5

  winning path:  5 ── 5 ── 5   (2 edges)

  at node 4: children are 1, 1 — values differ, so both arrows reset to 0
```

### Code

```go
func longestUnivaluePath(root *TreeNode) int {
    best := 0

    // arrow returns the longest univalue path going straight DOWN from
    // node, measured in edges.
    var arrow func(*TreeNode) int
    arrow = func(node *TreeNode) int {
        if node == nil {
            return 0
        }

        // Visit both children unconditionally — a longer univalue path
        // may live entirely inside a subtree of a different value.
        leftDown := arrow(node.Left)
        rightDown := arrow(node.Right)

        // An edge survives only if the child holds the same value.
        leftArrow := 0
        if node.Left != nil && node.Left.Val == node.Val {
            leftArrow = leftDown + 1
        }
        rightArrow := 0
        if node.Right != nil && node.Right.Val == node.Val {
            rightArrow = rightDown + 1
        }

        // RECORD: the bent univalue path through this node.
        if leftArrow+rightArrow > best {
            best = leftArrow + rightArrow
        }

        // RETURN: straight down through ONE side.
        if leftArrow > rightArrow {
            return leftArrow
        }
        return rightArrow
    }

    arrow(root)
    return best
}
```

```python
def longestUnivaluePath(root):
    best = 0

    def arrow(node):
        """Longest univalue path going straight DOWN, in edges."""
        nonlocal best
        if node is None:
            return 0

        # Visit both children regardless: a longer path may be inside them.
        left_down = arrow(node.left)
        right_down = arrow(node.right)

        # An edge survives only if the child has the same value.
        left_arrow = left_down + 1 if node.left and node.left.val == node.val else 0
        right_arrow = right_down + 1 if node.right and node.right.val == node.val else 0

        best = max(best, left_arrow + right_arrow)   # RECORD: bent
        return max(left_arrow, right_arrow)          # RETURN: straight

    arrow(root)
    return best
```

### Complexity
Time **O(n)**, Space **O(h)**.

> All three examples are the same twelve lines with two knobs: what a node contributes, and whether the edge to a child counts at all. Once the record/return split is internalised, "longest path with property X" problems stop being separate problems.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 543 | Diameter | Easy | Core trees application |
| 124 | Max Path Sum | Easy | Core trees application |
| 687 | Longest Univalue | Medium | Core trees application |
| 1522 | N-ary Diameter | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Diameter of Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Diameter of Tree (Trees).
- **Signal:** diameter, longest path, tree dp, postorder, through node.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Diameter of Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Diameter of Tree
FAMILY : Trees (Advanced)
WHEN   : diameter, longest path, tree dp, postorder, through node
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 543, 124, 687, 1522
```

---

*Part of the DSA Patterns Handbook — pattern 56 of 100.*
