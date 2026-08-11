# 57 · Balanced Tree

> **One-liner:** Return height and a balance flag together to check balance in O(n).

---

## 1. Overview

### Definition
The **Balanced Tree** pattern belongs to the *Trees* family. Return height and a balance flag together to check balance in O(n).

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
balanced, height balanced, avl, recursion, subtree.

### Constraints
- Input size where the brute-force complexity would time out — the Balanced Tree optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Balanced Tree invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Balanced Tree is the upgrade.
- The wording maps onto: balanced, height balanced, avl, recursion, subtree.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Is this tree balanced — and if not, how do I rebuild it so it is?"*

### Intuition
The definition reads like a recipe: a tree is height-balanced if, **at every node**, the two subtree heights differ by at most 1. So check that condition at every node.

### Algorithm
1. For each node `v`:
2. &nbsp;&nbsp;Compute `height(v.left)` with a full traversal of that subtree.
3. &nbsp;&nbsp;Compute `height(v.right)` the same way.
4. &nbsp;&nbsp;If `|leftHeight − rightHeight| > 1`, return `false`.
5. Recurse into both children and require them to pass too.

### Complexity
- Time: **O(n²)** — `height` is O(size of subtree), and it runs once per node. A degenerate tree hits the full quadratic cost.
- Space: O(h).

### Drawbacks
- Each node's height is recomputed once for **every ancestor**. The root's height calculation already walked the whole tree; then we walk most of it again for the root's child, and so on.
- Yet a single postorder pass computes every height exactly once. The information is there — the brute force just throws it away between checks.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Compute heights bottom-up, and let one recursive function return the height *and* the verdict at the same time — by reserving an impossible height value to mean "already unbalanced".**

```text
height(nil) = 0
height(v)   = 1 + max(left, right)     if this subtree is balanced
            = -1                        if it is not
```

`-1` is safe as a sentinel because a real height in nodes is always `≥ 0`. The moment any subtree reports `-1`, every ancestor short-circuits and reports `-1` too.

### The thought process

```text
We need    : a boolean, but the condition is stated in terms of heights.
Obvious way: check the height condition at every node.
Too slow   : O(n^2) — heights get recomputed once per ancestor.
Notice     : one postorder pass computes every height exactly once,
             and at that same moment we know both child heights —
             which is precisely what the balance test needs.
Problem    : the function can only return one value.
Therefore  : overload the return. Use an impossible height (-1) to
             carry the failure, so one number says both things.
Now        : O(n), single pass, with early exit.
```

### Why an "impossible value" instead of returning two things

You could return a `(height, isBalanced)` pair, and in production that is arguably clearer. The sentinel is preferred here for two reasons:

- **Early exit is free.** Once a `-1` appears, every ancestor's first check propagates it without touching any more nodes.
- **No allocation, no tuple unpacking** — the recursion stays a single `int`.

The rule for choosing a sentinel: it must be a value the function could **never** legitimately return. Heights are non-negative, so `-1` qualifies. If your function could return any integer, use a pair instead — do not invent a "magic number" that real data could collide with.

### Steps (is it balanced?)

```text
Step 1 → define check(node) returning a height, or -1 for "unbalanced":
Step 2 →     if node is nil, return 0
Step 3 →     left = check(node.Left);   if left  == -1, return -1
Step 4 →     right = check(node.Right); if right == -1, return -1
Step 5 →     if |left - right| > 1, return -1
Step 6 →     return 1 + max(left, right)
Step 7 → the tree is balanced iff check(root) != -1
```

Steps 3 and 4 are the early exit: the moment a subtree fails, nothing above it is examined.

### The other half: *building* a balanced tree

If you are handed a **sorted array**, building a balanced BST is almost free:

> **Pick the middle element as the root.** Everything left of it becomes the left subtree; everything right becomes the right subtree. Recurse.

Both halves differ in size by at most one, so the heights differ by at most one — balanced by construction. And because the array is sorted, the BST ordering property holds automatically.

```text
[-10, -3, 0, 5, 9]
           ↑ middle → root 0
  [-10, -3]     [5, 9]
      ↑ root -10    ↑ root 5
```

Different choices of "middle" (`lo+(hi-lo)/2` vs rounding up) give different — but equally valid — balanced trees.

### Balancing an *existing* BST: two steps, not one

For "rebalance this BST" the trick is to notice you already know how to do both halves:

```text
1. INORDER traverse the BST  →  a sorted array   (that is what inorder gives on a BST)
2. Rebuild from that array   →  a balanced BST   (the middle-element recipe)
```

No rotations, no AVL machinery. O(n) time and O(n) space, and it is far easier to get right under interview pressure than an in-place rebalance.

### Height-balanced is not the only kind

Worth naming, because interviewers sometimes mean something else:

| Kind | Condition |
|---|---|
| **Height-balanced** (this chapter, AVL) | every node's subtree heights differ by ≤ 1 |
| Weight-balanced | every node's subtree *sizes* are within a constant factor |
| Perfectly balanced | all leaves on the same level |
| Red-black balanced | no root-to-leaf path is more than twice any other |

LeetCode 110 means height-balanced. If a question just says "balanced", ask.

### How should I recognize this?

```text
If you see...
  "height-balanced", "is this tree balanced"
  "convert a sorted array to a BST"
  "rebalance a BST", "minimum-height tree from sorted data"
        ↓
Think about...
  Checking → "can one postorder pass return both the height
              and the verdict?"
  Building → "the middle element splits the data evenly"
        ↓
Use...
  check  → return height, or -1 as an impossible-value sentinel
  build  → middle element as root, recurse on the halves
  rebalance → inorder to a sorted array, then rebuild
```

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bal-57" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">balanced if every node has |leftH - rightH| at most 1</text>
  <!-- edges -->
  <line x1="266" y1="54" x2="194" y2="96" stroke="#475569"/>
  <line x1="294" y1="54" x2="366" y2="96" stroke="#475569"/>
  <line x1="166" y1="124" x2="134" y2="166" stroke="#475569"/>
  <line x1="194" y1="124" x2="226" y2="166" stroke="#475569"/>
  <line x1="380" y1="130" x2="380" y2="166" stroke="#d97706" stroke-width="3"/>
  <!-- nodes -->
  <circle cx="280" cy="40" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">A</text>
  <circle cx="180" cy="110" r="20" fill="#ecfdf5" stroke="#059669"/><text x="180" y="115" text-anchor="middle" fill="#1e293b">B</text>
  <circle cx="380" cy="110" r="20" fill="#fff7ed" stroke="#d97706"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">C</text>
  <circle cx="120" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">D</text>
  <circle cx="240" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">E</text>
  <circle cx="380" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="380" y="185" text-anchor="middle" fill="#1e293b">F</text>
  <text x="304" y="36"  text-anchor="start" fill="#059669" font-weight="700">|2-2|=0 ok</text>
  <text x="146" y="106" text-anchor="start" fill="#059669" font-weight="700">|1-1|=0 ok</text>
  <text x="406" y="106" text-anchor="start" fill="#d97706" font-weight="700">|0-1|=1 ok</text>
  <text x="280" y="240" text-anchor="middle" fill="#64748b">one post-order pass returns height AND a balance flag together</text>
  <text x="280" y="258" text-anchor="middle" fill="#059669" font-weight="700">any |diff| over 1 short-circuits to false</text>
</svg>
```

```text
        3
       / \
      9  20
        /  \
       15   7

check(9)  → 1
check(15) → 1,  check(7) → 1
check(20) → |1 - 1| = 0 ≤ 1  →  height 2
check(3)  → |1 - 2| = 1 ≤ 1  →  height 3, never -1

balanced ✓

unbalanced example:
        1
       / \
      2   2
     / \
    3   3
   / \
  4   4          at node 1: |3 - 1| = 2 > 1  →  -1 propagates up
```

### Interview explanation
"The definition checks every node, so the naive version recomputes subtree heights once per ancestor — O(n²). But one postorder pass already computes each height exactly once, and at that moment I have both child heights, which is exactly what the balance test needs. The problem is the function can only return one value, so I overload it: return the height normally, and `-1` to mean 'a subtree below me is already unbalanced'. `-1` is safe because a real height is never negative. Any ancestor seeing `-1` returns it immediately, which gives a free early exit. O(n) time, O(h) space. For the building variants, a sorted array becomes a balanced BST by taking the middle element as the root — the halves differ by at most one, so it's balanced by construction — and rebalancing an existing BST is inorder-to-array followed by that same rebuild."

---

## 5. Generic Templates

> Overload the return with an impossible value. To build, take the middle element.

```go
// IsBalanced reports whether every node's subtree heights differ by at most 1.
func IsBalanced(root *TreeNode) bool {
    return checkHeight(root) != -1
}

// checkHeight returns the height, or -1 meaning "already unbalanced".
// -1 is a safe sentinel because a real height is never negative.
func checkHeight(node *TreeNode) int {
    if node == nil {
        return 0
    }

    left := checkHeight(node.Left)
    if left == -1 {
        return -1 // early exit: nothing above needs checking
    }
    right := checkHeight(node.Right)
    if right == -1 {
        return -1
    }

    diff := left - right
    if diff < 0 {
        diff = -diff
    }
    if diff > 1 {
        return -1 // this node is where balance breaks
    }

    if left > right {
        return left + 1
    }
    return right + 1
}

// SortedArrayToBST builds a height-balanced BST from a sorted slice.
func SortedArrayToBST(nums []int) *TreeNode {
    if len(nums) == 0 {
        return nil
    }

    // The middle element splits the rest into halves differing by at most
    // one, so the result is balanced by construction.
    mid := len(nums) / 2
    return &TreeNode{
        Val:   nums[mid],
        Left:  SortedArrayToBST(nums[:mid]),
        Right: SortedArrayToBST(nums[mid+1:]),
    }
}
```

```python
def is_balanced(root):
    """Every node's subtree heights differ by at most 1."""
    return check_height(root) != -1

def check_height(node):
    """Height, or -1 meaning 'already unbalanced'. Heights are never negative,
    so -1 is a safe sentinel."""
    if node is None:
        return 0

    left = check_height(node.left)
    if left == -1:
        return -1                       # early exit
    right = check_height(node.right)
    if right == -1:
        return -1

    if abs(left - right) > 1:
        return -1                       # balance breaks here
    return 1 + max(left, right)

def sorted_array_to_bst(nums):
    """Middle element as root → halves differ by at most one → balanced."""
    if not nums:
        return None
    mid = len(nums) // 2
    node = TreeNode(nums[mid])
    node.left = sorted_array_to_bst(nums[:mid])
    node.right = sorted_array_to_bst(nums[mid + 1:])
    return node
```

```java
public class BalancedTree {
    public static class TreeNode {
        int val; TreeNode left, right;
        TreeNode(int val) { this.val = val; }
    }

    public static boolean isBalanced(TreeNode root) {
        return checkHeight(root) != -1;
    }

    // Height, or -1 meaning "already unbalanced".
    private static int checkHeight(TreeNode node) {
        if (node == null) return 0;

        int left = checkHeight(node.left);
        if (left == -1) return -1;              // early exit
        int right = checkHeight(node.right);
        if (right == -1) return -1;

        if (Math.abs(left - right) > 1) return -1;
        return 1 + Math.max(left, right);
    }

    public static TreeNode sortedArrayToBST(int[] nums) {
        return buildBalanced(nums, 0, nums.length - 1);
    }

    private static TreeNode buildBalanced(int[] nums, int lo, int hi) {
        if (lo > hi) return null;
        int mid = lo + (hi - lo) / 2;           // middle splits evenly
        TreeNode node = new TreeNode(nums[mid]);
        node.left = buildBalanced(nums, lo, mid - 1);
        node.right = buildBalanced(nums, mid + 1, hi);
        return node;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    explicit TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

// Height, or -1 meaning "already unbalanced".
int checkHeight(TreeNode* node) {
    if (node == nullptr) return 0;

    int left = checkHeight(node->left);
    if (left == -1) return -1;                  // early exit
    int right = checkHeight(node->right);
    if (right == -1) return -1;

    if (abs(left - right) > 1) return -1;
    return 1 + max(left, right);
}

bool isBalanced(TreeNode* root) { return checkHeight(root) != -1; }

TreeNode* buildBalanced(const vector<int>& nums, int lo, int hi) {
    if (lo > hi) return nullptr;
    int mid = lo + (hi - lo) / 2;               // middle splits evenly
    TreeNode* node = new TreeNode(nums[mid]);
    node->left = buildBalanced(nums, lo, mid - 1);
    node->right = buildBalanced(nums, mid + 1, hi);
    return node;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Balanced Tree (Optimal) |
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

### Problem — Balanced Binary Tree (LeetCode 110)
Return `true` if the tree is height-balanced: at every node, the two subtree heights differ by at most 1.

### Thought Process
1. Checking the condition at every node with a separate `height` call is O(n²), because heights get recomputed once per ancestor.
2. One postorder pass computes every height exactly once — and at that moment both child heights are in hand, which is precisely what the test needs.
3. The function can only return one value, so overload it: return the height normally, and `-1` for "a subtree below is already unbalanced".
4. `-1` is a safe sentinel because a real height is never negative.
5. Checking for `-1` immediately after each recursive call gives a free early exit.

### Dry Run — a balanced tree

Input:

```text
        3
       / \
      9  20
        /  \
       15   7
```

| call | left | right | \|diff\| | returns |
|------|------|-------|----------|---------|
| `check(9)`  | 0 | 0 | 0 | **1** |
| `check(15)` | 0 | 0 | 0 | **1** |
| `check(7)`  | 0 | 0 | 0 | **1** |
| `check(20)` | 1 | 1 | 0 ≤ 1 | **2** |
| `check(3)`  | 1 | 2 | 1 ≤ 1 | **3** |

`check(root)` returned 3, not −1 → **`true`** ✓

### Dry Run — an unbalanced tree

Input:

```text
          1
         / \
        2   2
       / \
      3   3
     / \
    4   4
```

| call | left | right | \|diff\| | returns |
|------|------|-------|----------|---------|
| `check(4)` (both) | 0 | 0 | 0 | **1** |
| `check(3)` (left) | 1 | 1 | 0 | **2** |
| `check(3)` (right)| 0 | 0 | 0 | **1** |
| `check(2)` (left) | 2 | 1 | 1 ≤ 1 | **3** |
| `check(2)` (right)| 0 | 0 | 0 | **1** |
| `check(1)` | 3 | 1 | **2 > 1** | **−1** |

Output: **`false`** ✓

The failure surfaces at the root, where a height-3 left subtree meets a height-1 right one. Had it surfaced deeper, the `-1` would have propagated up untouched and no further nodes would have been examined.

### Visualization

```text
        3                       balanced: every |diff| ≤ 1
       / \                      check returns 3
      9  20
     (1)  (2)

          1                     |3 - 1| = 2  →  return -1
         / \                     the -1 propagates to the top
        2   2                    and nothing above is checked further
      (3)  (1)
```

### Code

```go
func isBalanced(root *TreeNode) bool {
    return checkHeight(root) != -1
}

// checkHeight returns the subtree height, or -1 meaning "unbalanced".
// -1 is a safe sentinel because a real height is never negative.
func checkHeight(node *TreeNode) int {
    if node == nil {
        return 0
    }

    left := checkHeight(node.Left)
    if left == -1 {
        return -1 // early exit: nothing above needs checking
    }

    right := checkHeight(node.Right)
    if right == -1 {
        return -1
    }

    diff := left - right
    if diff < 0 {
        diff = -diff
    }
    if diff > 1 {
        return -1 // balance breaks exactly here
    }

    if left > right {
        return left + 1
    }
    return right + 1
}
```

```python
def isBalanced(root):
    return check_height(root) != -1

def check_height(node):
    """Height, or -1 for 'unbalanced'. Heights are never negative."""
    if node is None:
        return 0

    left = check_height(node.left)
    if left == -1:
        return -1                       # early exit
    right = check_height(node.right)
    if right == -1:
        return -1

    if abs(left - right) > 1:
        return -1                       # balance breaks here
    return 1 + max(left, right)
```

### Complexity
Time **O(n)** — one postorder pass, each height computed once. Space **O(h)**.

---

## 10. Solved Example 2

### Problem — Convert Sorted Array to Binary Search Tree (LeetCode 108)
Given a sorted ascending array, build a **height-balanced** BST.

### Thought Process
1. Two properties must hold: BST ordering, and height balance.
2. Both fall out of one choice — **make the middle element the root**.
3. BST ordering: everything before the middle is smaller, everything after is larger. The array being sorted guarantees it.
4. Balance: the two halves differ in size by at most one, so recursively their heights differ by at most one.
5. Recurse on the halves. An empty range produces `nil`.

Any valid balanced BST is accepted, so rounding the middle up or down both work — they just yield different trees.

### Dry Run

Input: `nums = [-10, -3, 0, 5, 9]`

| range | middle index | root value | left range | right range |
|-------|--------------|------------|------------|-------------|
| `[-10,-3,0,5,9]` | `5/2 = 2` | **0** | `[-10,-3]` | `[5,9]` |
| `[-10,-3]` | `2/2 = 1` | **−3** | `[-10]` | `[]` |
| `[-10]` | `1/2 = 0` | **−10** | `[]` | `[]` |
| `[5,9]` | `2/2 = 1` | **9** | `[5]` | `[]` |
| `[5]` | `1/2 = 0` | **5** | `[]` | `[]` |

Resulting tree:

```text
        0
       / \
     -3   9
     /   /
   -10  5
```

Output: this tree ✓

**Verify both properties.** Inorder traversal gives `-10, -3, 0, 5, 9` — the original sorted array, so the BST ordering holds. Heights: `-3` has height 2, `9` has height 2, so at the root `|2 − 2| = 0`; every other node's children differ by at most 1. Balanced. ✓

### Visualization

```text
[-10, -3,  0,  5,  9]
            ↑ middle → root

  [-10, -3]        [5, 9]
       ↑ mid            ↑ mid
      -3                9
   [-10]              [5]
     ↑                  ↑
   -10                  5

        0
       / \
     -3   9
     /   /
   -10  5          height 3, perfectly balanced
```

### Code

```go
func sortedArrayToBST(nums []int) *TreeNode {
    if len(nums) == 0 {
        return nil // empty range → no subtree
    }

    // The middle splits the remainder into halves differing by at most one,
    // so the tree is balanced by construction. Sortedness gives BST order.
    mid := len(nums) / 2

    return &TreeNode{
        Val:   nums[mid],
        Left:  sortedArrayToBST(nums[:mid]),
        Right: sortedArrayToBST(nums[mid+1:]),
    }
}
```

```python
def sortedArrayToBST(nums):
    if not nums:
        return None                     # empty range → no subtree

    # Middle as root: halves differ by ≤ 1 (balanced), and sortedness
    # gives the BST ordering for free.
    mid = len(nums) // 2
    node = TreeNode(nums[mid])
    node.left = sortedArrayToBST(nums[:mid])
    node.right = sortedArrayToBST(nums[mid + 1:])
    return node
```

### Complexity
Time **O(n)** — each element becomes exactly one node. Space **O(log n)** for the recursion, plus O(n) for the tree itself.

> In Go and Python, slicing copies, which makes this O(n log n) in practice. Passing `lo`/`hi` indices instead keeps it a true O(n) — worth mentioning if the interviewer asks about allocations.

---

## 11. Solved Example 3

### Problem — Balance a Binary Search Tree (LeetCode 1382)
Given a BST, return a **balanced** BST containing the same values.

### Thought Process
1. Rebalancing in place with rotations is AVL/red-black territory — correct, but far too error-prone for an interview.
2. Instead, notice we already have both halves of the answer from the previous examples:
   - **inorder on a BST yields a sorted array** (Tree DFS chapter)
   - **a sorted array becomes a balanced BST by taking the middle as root** (Example 2)
3. So: flatten with inorder, then rebuild. Two simple passes.
4. The values are unchanged and their sorted order is preserved, so the result is a valid BST containing exactly the same elements.
5. O(n) time and O(n) space — the extra array is the price of not doing rotations, and it is worth paying.

### Dry Run

Input: a right-leaning BST

```text
  1
   \
    2
     \
      3
       \
        4
```

**Step 1 — inorder traversal:**

| visit order | value |
|-------------|-------|
| leftmost first | `1` |
| then | `2` |
| then | `3` |
| then | `4` |

Sorted array: **`[1, 2, 3, 4]`**

**Step 2 — rebuild from the middle:**

| range | middle index | root | left range | right range |
|-------|--------------|------|------------|-------------|
| `[1,2,3,4]` | `4/2 = 2` | **3** | `[1,2]` | `[4]` |
| `[1,2]` | `2/2 = 1` | **2** | `[1]` | `[]` |
| `[1]` | 0 | **1** | `[]` | `[]` |
| `[4]` | 0 | **4** | `[]` | `[]` |

Result:

```text
      3
     / \
    2   4
   /
  1
```

Output: this tree ✓

Height went from **4** (a degenerate chain) to **3**. Checking balance: node `2` has heights 1 and 0 (diff 1 ✓); the root has heights 2 and 1 (diff 1 ✓). Balanced. And inorder on the result is `1, 2, 3, 4` — the same values in the same order. ✓

### Visualization

```text
  1                                        3
   \                                      / \
    2      ── inorder ──▶  [1,2,3,4]     2   4
     \     ── rebuild ──▶               /
      3                                1
       \
        4              height 4                height 3

the chain is exactly the worst case for a BST — every lookup is O(n)
```

### Code

```go
func balanceBST(root *TreeNode) *TreeNode {
    // Step 1: inorder on a BST produces the values in sorted order.
    sorted := []int{}
    var inorder func(*TreeNode)
    inorder = func(node *TreeNode) {
        if node == nil {
            return
        }
        inorder(node.Left)
        sorted = append(sorted, node.Val)
        inorder(node.Right)
    }
    inorder(root)

    // Step 2: rebuild by taking the middle element as the root.
    return buildBalanced(sorted)
}

func buildBalanced(nums []int) *TreeNode {
    if len(nums) == 0 {
        return nil
    }
    mid := len(nums) / 2
    return &TreeNode{
        Val:   nums[mid],
        Left:  buildBalanced(nums[:mid]),
        Right: buildBalanced(nums[mid+1:]),
    }
}
```

```python
def balanceBST(root):
    # Step 1: inorder on a BST gives the values sorted.
    sorted_values = []

    def inorder(node):
        if node is None:
            return
        inorder(node.left)
        sorted_values.append(node.val)
        inorder(node.right)

    inorder(root)

    # Step 2: rebuild from the middle element.
    def build(nums):
        if not nums:
            return None
        mid = len(nums) // 2
        node = TreeNode(nums[mid])
        node.left = build(nums[:mid])
        node.right = build(nums[mid + 1:])
        return node

    return build(sorted_values)
```

### Complexity
Time **O(n)** — one traversal plus one rebuild. Space **O(n)** for the intermediate array.

> A true in-place rebalance (the Day–Stout–Warren algorithm) achieves O(1) extra space by rotating the tree into a "vine" and back. It is a good thing to *name*, and almost never the right thing to write under time pressure.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 110 | Balanced Tree | Easy | Core trees application |
| 108 | Sorted Array to BST | Easy | Core trees application |
| 1382 | Balance BST | Medium | Core trees application |
| 104 | Max Depth | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Balanced Tree logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Balanced Tree (Trees).
- **Signal:** balanced, height balanced, avl, recursion, subtree.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Balanced Tree invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Balanced Tree
FAMILY : Trees (Intermediate)
WHEN   : balanced, height balanced, avl, recursion, subtree
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 110, 108, 1382, 104
```

---

*Part of the DSA Patterns Handbook — pattern 57 of 100.*
