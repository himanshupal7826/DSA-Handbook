# 59 · Lowest Common Ancestor

> **One-liner:** Post-order recursion bubbles up where two targets first meet.

---

## 1. Overview

### Definition
The **Lowest Common Ancestor** pattern belongs to the *Trees* family. Post-order recursion bubbles up where two targets first meet.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
lca, lowest common ancestor, tree, recursion, binary lifting.

### Constraints
- Input size where the brute-force complexity would time out — the Lowest Common Ancestor optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Lowest Common Ancestor invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Lowest Common Ancestor is the upgrade.
- The wording maps onto: lca, lowest common ancestor, tree, recursion, binary lifting.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the deepest node that has both of these nodes underneath it?"*

Running example:

```text
       3            p = 6,  q = 2
      / \
     5   1          answer: 5
    / \   \
   6   2   8
```

### Intuition
"Common ancestor of `p` and `q`" literally means "a node whose subtree contains both". So write a `contains(node, target)` helper and ask that question at every node. Among all the nodes that say yes, the deepest one wins.

### Algorithm
1. Write `contains(node, target)` — a full subtree scan returning true/false.
2. Start at the root (which certainly contains both).
3. If `contains(node.Left, p)` **and** `contains(node.Left, q)`, move down to `node.Left`.
4. Else if the same holds for `node.Right`, move down to `node.Right`.
5. Otherwise `p` and `q` are split across the two sides (or one *is* this node) — return `node`.

### Complexity
- Time: **O(n · h)** — each of the `h` steps down runs up to four O(n) subtree scans. On a skewed tree that is **O(n²)**.
- Space: O(h) for the recursion inside `contains`.

### Drawbacks
- Every `contains` call re-walks nodes an earlier `contains` already walked:

  ```text
  contains(3, 6)  visits  3,5,6,2,1,8      ← already saw node 6
  contains(5, 6)  visits    5,6,2          ← visits node 6 AGAIN
  ```

- It asks a **yes/no** question when the recursion could just as easily hand back **which node it found**. That extra bit of information is free, and it is exactly what removes the repeated scans.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Do one post-order pass in which every node reports upward "here is the interesting thing I found below me" — the first node that hears back from *both* children is the answer.**

Imagine two people lost in a building, each walking up the corridors toward the exit. The first room where their two routes merge is the lowest common ancestor. Nobody searches the whole building; each person just reports "I came from here" to the room above.

### The thought process

```text
We need    : the deepest node with p in its subtree and q in its subtree.
Obvious way: at each node, scan both subtrees asking "do you contain p / q?"
Too slow   : O(n·h) — the scans overlap enormously.
Notice     : a scan that returns a NODE instead of a boolean costs the same.
Notice too : if my left child reports something and my right child reports
             something, the two reports must be p and q — so I am the answer.
Therefore  : one post-order pass; each node returns p, q, an answer, or nil.
Now        : O(n) — every node is visited exactly once.
```

### Why the "return it upward" rule works

The whole algorithm is four lines of plain English. At a node, after asking both children:

```text
1. I am nil                      → return nil          ("nothing here")
2. I am p or I am q              → return myself       ("found one")
3. Both children returned        → return myself       ("I AM the LCA")
4. Exactly one child returned    → return that one     ("pass it up")
```

Read the meaning of the return value carefully — it is deliberately overloaded, and that is what makes the code short:

> *"the LCA, if I already know it; otherwise whichever of `p`/`q` lives in my subtree; otherwise nil."*

**Why rule 3 is correct.** If my left subtree handed back a non-nil node and my right subtree did too, then each subtree contains at least one target. They are disjoint, so one holds `p` and the other holds `q`. Every node below me sits in only one of the two subtrees, so no deeper node can contain both. I am the deepest — the LCA.

**Why rule 4 is correct.** If only one side reported, both targets (if both exist) are on that side, so the answer is somewhere down there. Passing the report up unchanged is safe: either it is already the LCA, in which case rules 3 and 4 keep forwarding it untouched all the way to the root, or it is a lone target still looking for its partner higher up.

**Why rule 2 may stop early — the ancestor case.** Suppose `p` is an ancestor of `q`. Standing on `p`, we return immediately without looking below. That feels like cheating, but the answer is still right: `q` is inside `p`'s subtree, so `p` contains both, and nothing deeper than `p` can contain `p` itself. **LCA(p, descendant of p) = p.** This is the case candidates most often get wrong by "helpfully" searching deeper.

**The assumption hiding in rule 2:** both nodes actually exist in the tree. Return early at `p` and you never confirm `q` is there at all — see section 11 for the fix.

### The BST shortcut

If the tree is a **binary search tree**, throw all of the above away. Values now tell you where things are, so you never need a return-value protocol:

```text
both p.val and q.val  <  node.val   → both are in the left subtree  → go left
both p.val and q.val  >  node.val   → both are in the right subtree → go right
otherwise (they split, or one IS node) → node is the LCA, stop
```

It is simpler for three reasons: no recursion needed (a `for` loop suffices), O(1) space instead of O(h) stack, and you touch only the O(h) nodes on one root-to-answer path instead of all `n`.

### Steps

```text
Step 1 → If node is nil, return nil.
Step 2 → If node == p or node == q, return node.
Step 3 → left  = recurse(node.Left)
Step 4 → right = recurse(node.Right)
Step 5 → If left != nil and right != nil, return node.   (the split point)
Step 6 → Otherwise return whichever of left/right is non-nil (possibly nil).
```

### How should I recognize this?

```text
If you see...
  "lowest / least common ancestor", "deepest node containing both"
  "where do two root-to-node paths first diverge"
  "distance between two nodes in a tree"
        ↓
Think about...
  "Is it a BST? Are both nodes guaranteed to exist? Do I have parent pointers?"
        ↓
Use...
  BST                        → walk down comparing values (O(h) time, O(1) space)
  plain binary tree          → post-order 'return what you found' (LC 236)
  nodes may be absent        → same walk, but COUNT the hits and require 2 (LC 1644)
  parent pointers available  → lift the deeper node, then step up in lockstep
  many queries on one tree   → preprocess: binary lifting / Euler tour + sparse table
```

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="lca-59" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">LCA(D, E) = B where the two targets first meet</text>
  <!-- edges -->
  <line x1="266" y1="54" x2="194" y2="96" stroke="#475569"/>
  <line x1="294" y1="54" x2="366" y2="96" stroke="#475569"/>
  <line x1="166" y1="124" x2="134" y2="166" stroke="#059669" stroke-width="4"/>
  <line x1="194" y1="124" x2="226" y2="166" stroke="#059669" stroke-width="4"/>
  <line x1="394" y1="124" x2="426" y2="166" stroke="#475569"/>
  <!-- nodes -->
  <circle cx="280" cy="40" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">A</text>
  <circle cx="180" cy="110" r="22" fill="#ecfdf5" stroke="#059669" stroke-width="2.5"/><text x="180" y="115" text-anchor="middle" fill="#1e293b" font-weight="700">B</text>
  <circle cx="380" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">C</text>
  <circle cx="120" cy="180" r="20" fill="#fff7ed" stroke="#d97706"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">D</text>
  <circle cx="240" cy="180" r="20" fill="#fff7ed" stroke="#d97706"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">E</text>
  <circle cx="440" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="440" y="185" text-anchor="middle" fill="#1e293b">F</text>
  <text x="86"  y="176" text-anchor="start" fill="#d97706" font-weight="700">p</text>
  <text x="266" y="176" text-anchor="start" fill="#d97706" font-weight="700">q</text>
  <text x="210" y="106" text-anchor="start" fill="#059669" font-weight="700">LCA</text>
  <text x="280" y="238" text-anchor="middle" fill="#64748b">post-order: a subtree returning both p and q surfaces the answer</text>
  <text x="280" y="257" text-anchor="middle" fill="#059669" font-weight="700">B is the deepest node with p on one side and q on the other</text>
</svg>
```

```text
       3            p = 6,  q = 2
      / \
     5   1
    / \   \
   6   2   8

post-order, each node returning what it found:

   node 6 : leaf, node == p            → returns 6
   node 2 : leaf, node == q            → returns 2
   node 5 : left=6, right=2  BOTH      → returns 5   ★ I am the LCA
   node 8 : leaf, neither              → returns nil
   node 1 : left=nil, right=nil        → returns nil
   node 3 : left=5, right=nil  ONE     → returns 5   (pass it up unchanged)

answer: 5
```

### Interview explanation
"I'll do one post-order traversal where each call returns the most useful thing it found in its subtree: `p`, `q`, an already-determined LCA, or nil. If a node *is* `p` or `q` I return it immediately — that is safe because if the other target is below me, I'm still the answer. Otherwise I ask both children: if both come back non-nil, the two targets are split across my subtrees so I'm the deepest node containing both and I return myself; if only one comes back, I forward it upward unchanged. That's O(n) time and O(h) stack, one visit per node. If the tree happened to be a BST I'd skip all of this and just walk down comparing values — the first node whose value sits between `p` and `q` is the LCA, in O(h) time and O(1) space."

---

## 5. Generic Templates

> Post-order, and the return value means *"the LCA if I know it, else whichever target I found, else nil"*. In a BST, just walk down until the two targets split.

```go
// General binary tree: one post-order pass, overloaded return value.
func lca(node, p, q *TreeNode) *TreeNode {
    if node == nil || node == p || node == q {
        return node // nothing here, or one of the targets is right here
    }
    left := lca(node.Left, p, q)
    right := lca(node.Right, p, q)
    if left != nil && right != nil {
        return node // targets split across my two subtrees → I am the LCA
    }
    if left != nil {
        return left // forward the single report upward
    }
    return right
}

// BST: values reveal the side, so no recursion protocol is needed.
func lcaBST(root *TreeNode, pVal, qVal int) *TreeNode {
    node := root
    for node != nil {
        switch {
        case pVal < node.Val && qVal < node.Val:
            node = node.Left // both strictly smaller → both on the left
        case pVal > node.Val && qVal > node.Val:
            node = node.Right // both strictly larger → both on the right
        default:
            return node // they split here (or one IS this node)
        }
    }
    return nil
}
```

```python
def lca(node, p, q):
    if node is None or node is p or node is q:
        return node                       # nothing here, or a target is right here
    left = lca(node.left, p, q)
    right = lca(node.right, p, q)
    if left and right:
        return node                       # targets split → this node is the LCA
    return left or right                  # forward the single report upward


def lca_bst(root, p_val, q_val):
    node = root
    while node:
        if p_val < node.val and q_val < node.val:
            node = node.left              # both smaller → go left
        elif p_val > node.val and q_val > node.val:
            node = node.right             # both larger → go right
        else:
            return node                   # they split here → LCA
    return None
```

```java
TreeNode lca(TreeNode node, TreeNode p, TreeNode q) {
    if (node == null || node == p || node == q) return node;
    TreeNode left = lca(node.left, p, q);
    TreeNode right = lca(node.right, p, q);
    if (left != null && right != null) return node;   // split → this is the LCA
    return left != null ? left : right;               // forward one report up
}

TreeNode lcaBST(TreeNode root, int pVal, int qVal) {
    TreeNode node = root;
    while (node != null) {
        if (pVal < node.val && qVal < node.val)       node = node.left;
        else if (pVal > node.val && qVal > node.val)  node = node.right;
        else return node;                             // they split here
    }
    return null;
}
```

```cpp
TreeNode* lca(TreeNode* node, TreeNode* p, TreeNode* q) {
    if (!node || node == p || node == q) return node;
    TreeNode* left = lca(node->left, p, q);
    TreeNode* right = lca(node->right, p, q);
    if (left && right) return node;        // split across subtrees → the LCA
    return left ? left : right;            // forward the single report upward
}

TreeNode* lcaBST(TreeNode* root, int pVal, int qVal) {
    TreeNode* node = root;
    while (node) {
        if (pVal < node->val && qVal < node->val)      node = node->left;
        else if (pVal > node->val && qVal > node->val) node = node->right;
        else return node;                  // they split here
    }
    return nullptr;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Lowest Common Ancestor (Optimal) |
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

### Problem — LCA (LeetCode 236)
Given a binary tree and two nodes `p` and `q` that are both guaranteed to be in it, return their lowest common ancestor — the deepest node having both in its subtree (a node may be its own ancestor).

### Thought Process
1. "Deepest node containing both" = "the node where the two search directions split".
2. Let every recursive call return the most useful thing in its subtree: `p`, `q`, an LCA already found, or nil.
3. If a node *is* `p` or `q`, return it right away — if the other target is below, this node is still the answer.
4. If **both** children return non-nil, the targets are on opposite sides → this node is the LCA.
5. If only one child returns non-nil, forward it up unchanged; the answer is that node or something above.

### Dry Run

Input:

```text
       3            p = 6,  q = 2
      / \
     5   1
    / \   \
   6   2   8
```

Rows are in post-order (a node finishes after both of its children):

| step | node | left returns | right returns | rule fired | returns |
|------|------|--------------|---------------|------------|---------|
| 1 | 6 | — | — | node == p | **6** |
| 2 | 2 | — | — | node == q | **2** |
| 3 | 5 | 6 | 2 | both non-nil → **I am the LCA** | **5** |
| 4 | 8 | nil | nil | nothing found | nil |
| 5 | 1 | nil | nil | nothing found | nil |
| 6 | 3 | 5 | nil | one non-nil → forward it | **5** |

Output: **`5`**

Step 3 is the only place a decision is actually made; steps 4-6 just carry the answer to the root. Note step 6: node `3` does **not** overwrite the answer just because it heard from one side — that is rule 4 doing its job.

### Visualization

```text
              3  ◄── returns 5 (forwarded)
             / \
   returns 5 5   1  ◄── returns nil
   ★ LCA    / \   \
           6   2   8
           │   │
        "I'm p"  "I'm q"

reports travel UPWARD:   6 ──┐
                             ├──▶ 5 hears from BOTH sides → 5 is the answer
                         2 ──┘
```

### Code

```go
func lowestCommonAncestor(root, p, q *TreeNode) *TreeNode {
    if root == nil || root == p || root == q {
        return root // nil, or one of the targets is standing right here
    }
    left := lowestCommonAncestor(root.Left, p, q)
    right := lowestCommonAncestor(root.Right, p, q)
    if left != nil && right != nil {
        return root // p on one side, q on the other → this node is the LCA
    }
    if left != nil {
        return left // only one side reported → forward it upward unchanged
    }
    return right
}
```

```python
def lowestCommonAncestor(root, p, q):
    if root is None or root is p or root is q:
        return root                     # nil, or a target is standing right here
    left = lowestCommonAncestor(root.left, p, q)
    right = lowestCommonAncestor(root.right, p, q)
    if left and right:
        return root                     # split across subtrees → this is the LCA
    return left or right                # forward the single report upward
```

### Complexity
Time O(n) — each node is visited once and does O(1) work. Space O(h) for the recursion stack (O(n) on a skewed tree). The brute force was O(n·h) because its `contains` scans overlapped.

---

## 10. Solved Example 2

### Problem — LCA of BST (LeetCode 235)
Same question, but the tree is a **binary search tree**: every left descendant is smaller than the node and every right descendant is larger.

### Thought Process
1. In a BST a value tells you where it lives, so you never need to search both sides.
2. If both targets are smaller than the current node, both are in the left subtree — go left.
3. If both are larger, go right.
4. Otherwise they straddle this node (or one of them *is* this node) — this is the split point, so it is the LCA.
5. No recursion and no return-value protocol needed: a plain `while` loop walking down one path suffices.

### Dry Run

Input:

```text
        6            p = 3,  q = 5
       / \
      2   8
     / \  / \
    0  4 7   9
      / \
     3   5
```

| step | node | 3 vs node | 5 vs node | verdict | move |
|------|------|-----------|-----------|---------|------|
| 1 | 6 | 3 < 6 | 5 < 6 | both smaller | go left |
| 2 | 2 | 3 > 2 | 5 > 2 | both larger | go right |
| 3 | 4 | 3 < 4 | 5 > 4 | **they split** | **answer = 4** |

Output: **`4`**

Step 3 is the stopping rule. The `default` branch also covers the ancestor case: querying `(2, 4)` stops at node `2` on step 2, because `2 < 2` is false — a node counts as its own ancestor.

### Visualization

```text
        6      3<6 and 5<6  → both left
       / \
      2   8    3>2 and 5>2  → both right
     / \
    0   4      3<4 but 5>4  → SPLIT  ★ LCA = 4
       / \
      3   5    ← the two targets, now on opposite sides

only one root-to-answer path is ever touched: 6 → 2 → 4
```

### Code

```go
func lowestCommonAncestorBST(root *TreeNode, pVal, qVal int) *TreeNode {
    node := root
    for node != nil {
        switch {
        case pVal < node.Val && qVal < node.Val:
            node = node.Left // both strictly smaller → both live on the left
        case pVal > node.Val && qVal > node.Val:
            node = node.Right // both strictly larger → both live on the right
        default:
            return node // they split here, or one of them IS this node
        }
    }
    return nil
}
```

```python
def lowestCommonAncestorBST(root, p_val, q_val):
    node = root
    while node:
        if p_val < node.val and q_val < node.val:
            node = node.left            # both smaller → both on the left
        elif p_val > node.val and q_val > node.val:
            node = node.right           # both larger → both on the right
        else:
            return node                 # they split here → this is the LCA
    return None
```

### Complexity
Time O(h) — one step per level, `h ≈ log n` on a balanced BST. Space **O(1)** — a loop, no recursion stack. That is strictly better than the general O(n)/O(h) version, and it is why "is it a BST?" is worth asking out loud.

---

## 11. Solved Example 3

### Problem — LCA II (LeetCode 1644)
Same as LeetCode 236, except `p` and `q` are **not guaranteed to exist** in the tree. Return `nil` unless both are present.

### Thought Process
1. The LC 236 trick returns as soon as it stands on `p` — so it never checks whether `q` exists at all. On `p = 6, q = 10` it would happily return `6`.
2. Fix: **always recurse into both children first**, then check whether this node is a target. No early exit.
3. Keep a counter `found`, incremented once per target actually seen.
4. Compute the candidate exactly as in LC 236 (both sides reported → me; one side → forward it).
5. Return the candidate only if `found == 2`; otherwise return nil.

### Dry Run

Input:

```text
       3            p = 6,  q = 10  ← 10 is NOT in the tree
      / \
     5   1
    / \   \
   6   2   8
```

Post-order again, with the counter:

| step | node | left | right | is target? | `found` | returns |
|------|------|------|-------|------------|---------|---------|
| 1 | 6 | nil | nil | **yes (p)** | 1 | **6** |
| 2 | 2 | nil | nil | no | 1 | nil |
| 3 | 5 | 6 | nil | no | 1 | 6 (forward) |
| 4 | 8 | nil | nil | no | 1 | nil |
| 5 | 1 | nil | nil | no | 1 | nil |
| 6 | 3 | 6 | nil | no | 1 | 6 (forward) |
| 7 | final check | — | — | — | **1 ≠ 2** | **nil** |

Output: **`nil`**

Step 7 is the entire difference from LeetCode 236. The walk still produced the candidate `6`; only the counter reveals that `q` was never seen. Run the same code with `q = 2` and step 2 would increment `found` to 2, step 3 would fire the both-sides rule and return `5`, and step 7 would let it through.

### Visualization

```text
LC 236 (both guaranteed):        LC 1644 (may be missing):

  at node p:                       at node p:
     return p  ── STOP               left  = recurse(...)    ← still descend
     (never looks below)             right = recurse(...)
                                     found++ ; return p      ← count, then report

                                   at the very end:
                                     found == 2 ?  answer : nil

on p=6, q=10:  236 → 6 (wrong)   |   1644 → found=1 → nil (right)
```

### Code

```go
func lowestCommonAncestorII(root, p, q *TreeNode) *TreeNode {
    found := 0
    var walk func(node *TreeNode) *TreeNode
    walk = func(node *TreeNode) *TreeNode {
        if node == nil {
            return nil
        }
        // Descend FIRST — unlike LC 236 we may not stop at a target,
        // because we still have to prove the other target exists.
        left := walk(node.Left)
        right := walk(node.Right)
        if node == p || node == q {
            found++
            return node
        }
        if left != nil && right != nil {
            return node // targets split across my subtrees
        }
        if left != nil {
            return left
        }
        return right
    }
    candidate := walk(root)
    if found == 2 {
        return candidate // both really are in the tree
    }
    return nil
}
```

```python
def lowestCommonAncestorII(root, p, q):
    found = 0

    def walk(node):
        nonlocal found
        if node is None:
            return None
        # Descend FIRST: we may not stop at a target, because we still
        # have to prove the other target exists.
        left = walk(node.left)
        right = walk(node.right)
        if node is p or node is q:
            found += 1
            return node
        if left and right:
            return node                 # targets split across my subtrees
        return left or right

    candidate = walk(root)
    return candidate if found == 2 else None
```

### Complexity
Time O(n) — the traversal is now guaranteed to be full (no early exit), so it is exactly `n` visits. Space O(h) for the recursion. Losing the early return costs nothing asymptotically; it only removes a best-case shortcut.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 236 | LCA | Easy | Core trees application |
| 235 | LCA of BST | Easy | Core trees application |
| 1644 | LCA II | Medium | Core trees application |
| 1650 | LCA III | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Lowest Common Ancestor logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Lowest Common Ancestor (Trees).
- **Signal:** lca, lowest common ancestor, tree, recursion, binary lifting.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Lowest Common Ancestor invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Lowest Common Ancestor
FAMILY : Trees (Advanced)
WHEN   : lca, lowest common ancestor, tree, recursion, binary lifting
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 236, 235, 1644, 1650
```

---

*Part of the DSA Patterns Handbook — pattern 59 of 100.*
