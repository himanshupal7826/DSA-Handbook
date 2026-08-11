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

**The question this pattern keeps answering:** *"What is the best value over a subtree, when my choice at a node constrains what my children may do?"*

Running example — House Robber III: pick a set of nodes with no two adjacent, maximising the sum.

```text
     3            answer: rob 3 (root) + 3 + 1 = 7
    / \
   2   3
    \    \
     3    1
```

### Intuition
At each node there are only two choices: take it or don't. If you take it, its children are off-limits, so you continue from the **grandchildren**. If you don't, you continue from the **children**. Try both and keep the larger.

### Algorithm
1. `best(node)`: if `node` is nil, return 0.
2. `take = node.Val +` `best` of all four **grandchildren**.
3. `skip = best(node.Left) + best(node.Right)`.
4. Return `max(take, skip)`.
5. The answer is `best(root)`.

### Complexity
- Time: **exponential** — closer to O(2^h). Every subtree is re-solved once per branch that reaches it.
- Space: O(h) for the recursion.

### Drawbacks
- The same subtree is solved twice at every level. On the example:

  ```text
  best(root) take-branch → best(node 3, under the left 2)   ← grandchild
  best(root) skip-branch → best(node 2) → best(node 3)      ← SAME call, again
  ```

  The node-`3` subtree is solved once as a grandchild of the root and once as a child of node `2`. Two levels down it is four times, then eight.
- The two branches want **different facts about the same child**: "your best assuming you are skipped" and "your best with no restriction". The brute force gets those by making two separate calls — but the child could compute *both* in a single visit for the same price.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Have every node return a small tuple — one entry per state its parent might care about — so the parent can answer all of its questions from one visit.**

It is a status report, not an interrogation. Instead of the parent asking the child two questions on two separate trips, the child hands up a card that already answers both: *"if you take yourself, I'm worth X; if you don't, I'm worth Y."* One trip down, one card back, done.

### The thought process

```text
We need    : the best value over the whole tree under an adjacency constraint.
Obvious way: at each node try take/skip and recurse to grandchildren/children.
Too slow   : O(2^h) — each subtree is re-solved once per branch that reaches it.
Notice     : the two branches only differ in ONE fact about each child:
             "were you allowed to take yourself?"
Notice too : the child can compute both answers in the same post-order visit.
Therefore  : return the PAIR (best if taken, best if skipped) instead of one number.
Now        : O(n) — one visit per node, O(1) combining work.
```

### Why returning a tuple beats recomputing

Write out what the parent actually needs:

| parent's choice | what it needs from each child |
|-----------------|-------------------------------|
| take the parent | the child's best **given the child is skipped** |
| skip the parent | the child's best **with no restriction** = `max(childTaken, childSkipped)` |

Both are functions of the same two numbers. So the child computes:

```text
taken(v)   = v.val + skipped(left) + skipped(right)
skipped(v) = max(taken(left), skipped(left)) + max(taken(right), skipped(right))
```

and hands `(taken, skipped)` up. Nothing is ever asked twice.

**Why this makes the whole thing linear.** Say each node is visited `T(h)` times. The brute force obeys `T(h) = 2·T(h−1) + 4·T(h−2)` — a node is reached both as a child and as a grandchild, so the count doubles per level and explodes. With the tuple, each node is entered from exactly one place (its parent), once. `n` nodes, O(1) work each, O(n) total.

**Why the tuple must be small.** The rule of thumb: *one slot per distinct constraint the parent can impose*. Two choices at a node → two slots. Three states (LeetCode 968's "needs cover / has camera / covered") → three. If your tuple starts growing with `n`, you have modelled the state wrong.

**Why post-order, always.** A node's tuple is defined in terms of its children's tuples, so children must be finished before the parent starts combining. That is exactly what post-order means: recurse first, combine after. Do the combining before the recursive calls and you are reading values that do not exist yet.

**The variant to watch for: "bendable" paths.** In LeetCode 124 the answer may pass *through* a node (down-left, up, down-right) but a node can only report *one* downward chain to its parent. So the node returns the best **straight** extension `val + max(leftGain, rightGain)` while separately updating a global best with the **bent** path `val + leftGain + rightGain`. Two different quantities: one goes up, one goes into the answer. Mixing them up is the classic bug.

### Steps

```text
Step 1 → Decide the states: what can the parent constrain? That is your tuple.
Step 2 → Write the nil base case (usually the neutral value for each slot).
Step 3 → Recurse into both children FIRST, capturing their tuples.
Step 4 → Combine: each slot is a formula over the children's slots.
Step 5 → Return the tuple upward.
Step 6 → At the root, reduce the tuple to a single answer (often a max).
```

### How should I recognize this?

```text
If you see...
  "on a tree / in a binary tree" + "maximum / minimum / count"
  "no two adjacent", "cannot pick a node and its child"
  "cover every node", "path may start and end anywhere in the tree"
        ↓
Think about...
  "What does my PARENT need to know about me — and how many different
   answers are there depending on what the parent does?"
        ↓
Use...
  two choices per node (take/skip)     → return a PAIR  (LC 337)
  three or more node states            → return a small enum/int (LC 968)
  path may BEND at a node              → return the straight gain,
                                          update a global best with the bend (LC 124)
  answer needed for EVERY node as root → rerooting: second top-down pass
```

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

The diagram shows the shape in its simplest form — leaves seed their value, each parent folds in what its children returned. Tree DP is the same picture with a *tuple* instead of a single number:

```text
     3            each node returns (taken, skipped)
    / \
   2   3
    \    \
     3    1

post-order:
  node 3 (leaf, left side) → taken=3, skipped=0            (3, 0)
  node 2                   → taken = 2 + 0(skip of nil) + 0(skip of 3) = 2
                             skipped = max(0,0) + max(3,0)             = 3   (2, 3)
  node 1 (leaf)            → taken=1, skipped=0                        (1, 0)
  node 3 (right child)     → taken = 3 + 0 + 0 = 3
                             skipped = 0 + max(1,0) = 1                (3, 1)
  root 3                   → taken   = 3 + 3(skip of left) + 1(skip of right) = 7
                             skipped = max(2,3) + max(3,1)             = 6   (7, 6)

answer = max(7, 6) = 7        ← rob the root and both grandchildren
```

### Interview explanation
"This is tree DP: the answer for a subtree depends on a choice made at its root, so a single number per node isn't enough. I have each node return a small tuple — here `(best if I'm taken, best if I'm skipped)` — computed post-order from its children's tuples. `taken` forces both children to be skipped; `skipped` lets each child do whatever is better. The naive version re-solves each subtree once per branch that reaches it, which is exponential; returning both answers together means each node is visited exactly once, so it's O(n) time and O(h) stack. The tuple size is just the number of distinct constraints a parent can impose — two here, three for the camera-covering variant."

---

## 5. Generic Templates

> Each node returns a small tuple, one slot per state its parent can impose. Recurse first, combine after, reduce at the root.

```go
// Template A — include/exclude: return (best if taken, best if skipped).
func treeDPIncludeExclude(root *TreeNode) int {
    var solve func(node *TreeNode) (int, int)
    solve = func(node *TreeNode) (taken, skipped int) {
        if node == nil {
            return 0, 0 // neutral value for both slots
        }
        lTaken, lSkipped := solve(node.Left) // children FIRST
        rTaken, rSkipped := solve(node.Right)

        taken = node.Val + lSkipped + rSkipped                  // children forced off
        skipped = max(lTaken, lSkipped) + max(rTaken, rSkipped) // children free
        return taken, skipped
    }
    taken, skipped := solve(root)
    return max(taken, skipped) // reduce the tuple at the root
}

// Template B — bendable path: one value goes UP, another feeds a global best.
func treeDPBendingPath(root *TreeNode) int {
    best := math.MinInt32
    var gain func(node *TreeNode) int
    gain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        left := max(0, gain(node.Left)) // a negative branch is worse than nothing
        right := max(0, gain(node.Right))

        best = max(best, node.Val+left+right) // path that BENDS here
        return node.Val + max(left, right)    // path that continues UPWARD
    }
    gain(root)
    return best
}
```

```python
def tree_dp_include_exclude(root):
    def solve(node):
        if not node:
            return 0, 0                       # neutral value for both slots
        l_taken, l_skipped = solve(node.left)  # children FIRST
        r_taken, r_skipped = solve(node.right)
        taken = node.val + l_skipped + r_skipped              # children forced off
        skipped = max(l_taken, l_skipped) + max(r_taken, r_skipped)  # children free
        return taken, skipped

    return max(solve(root))                   # reduce the tuple at the root


def tree_dp_bending_path(root):
    best = float('-inf')

    def gain(node):
        nonlocal best
        if not node:
            return 0
        left = max(0, gain(node.left))        # negative branch is worse than nothing
        right = max(0, gain(node.right))
        best = max(best, node.val + left + right)   # path that BENDS here
        return node.val + max(left, right)          # path that continues UPWARD

    gain(root)
    return best
```

```java
int[] solve(TreeNode node) {                 // [best if taken, best if skipped]
    if (node == null) return new int[]{0, 0};
    int[] l = solve(node.left);              // children FIRST
    int[] r = solve(node.right);
    int taken = node.val + l[1] + r[1];      // children forced off
    int skipped = Math.max(l[0], l[1]) + Math.max(r[0], r[1]);  // children free
    return new int[]{taken, skipped};
}

int treeDPIncludeExclude(TreeNode root) {
    int[] top = solve(root);
    return Math.max(top[0], top[1]);         // reduce the tuple at the root
}

int best;
int gain(TreeNode node) {
    if (node == null) return 0;
    int left = Math.max(0, gain(node.left));  // negative branch is worse than nothing
    int right = Math.max(0, gain(node.right));
    best = Math.max(best, node.val + left + right);  // path that BENDS here
    return node.val + Math.max(left, right);         // path that continues UPWARD
}
```

```cpp
pair<int,int> solve(TreeNode* node) {        // {best if taken, best if skipped}
    if (!node) return {0, 0};
    auto l = solve(node->left);              // children FIRST
    auto r = solve(node->right);
    int taken = node->val + l.second + r.second;              // children forced off
    int skipped = max(l.first, l.second) + max(r.first, r.second); // children free
    return {taken, skipped};
}

int treeDPIncludeExclude(TreeNode* root) {
    auto top = solve(root);
    return max(top.first, top.second);       // reduce the tuple at the root
}

int best = INT_MIN;
int gain(TreeNode* node) {
    if (!node) return 0;
    int left = max(0, gain(node->left));     // negative branch is worse than nothing
    int right = max(0, gain(node->right));
    best = max(best, node->val + left + right);   // path that BENDS here
    return node->val + max(left, right);          // path that continues UPWARD
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
Each node of a binary tree holds an amount of money. You may not take two directly connected nodes. Return the maximum total you can take.

### Thought Process

```text
What does the state mean?  Each node returns a PAIR:
                             taken   = best total in my subtree WHEN I am taken
                             skipped = best total in my subtree WHEN I am not taken
How do we compute it?      taken   = my.Val + skipped(left) + skipped(right)
                                     (taking me forces both children off)
                           skipped = max(taken(L), skipped(L))
                                   + max(taken(R), skipped(R))
                                     (skipping me leaves each child free to choose)
What is the base case?     nil → (0, 0). An empty subtree is worth nothing under
                           either assumption, and 0 is neutral for addition.
Why post-order?            My pair is defined from my children's pairs, so both
                           children must be finished before I combine.
```

1. Each node has exactly two choices, so the tuple has exactly two slots.
2. The parent needs a different fact per choice — the pair supplies both in one visit.
3. Combine post-order, then take `max(taken, skipped)` at the root.

### Dry Run

Input:

```text
     3
    / \
   2   3
    \    \
     3    1
```

Rows in post-order. Call the lower-left node `3ᴸ` and the lower-right node `1`.

| step | node | left pair | right pair | `taken` | `skipped` | returns |
|------|------|-----------|------------|---------|-----------|---------|
| 1 | `3ᴸ` (leaf) | (0,0) | (0,0) | 3 + 0 + 0 = **3** | 0 + 0 = **0** | (3, 0) |
| 2 | `2` | (0,0) | (3,0) | 2 + 0 + 0 = **2** | max(0,0) + max(3,0) = **3** | (2, 3) |
| 3 | `1` (leaf) | (0,0) | (0,0) | 1 + 0 + 0 = **1** | 0 + 0 = **0** | (1, 0) |
| 4 | `3` (right child) | (0,0) | (1,0) | 3 + 0 + 0 = **3** | 0 + max(1,0) = **1** | (3, 1) |
| 5 | `3` (root) | (2,3) | (3,1) | 3 + 3 + 1 = **7** | max(2,3) + max(3,1) = **6** | (7, 6) |

Output: **`max(7, 6) = 7`**

Look at step 2: node `2`'s own value loses. Its `skipped` slot (3) beats its `taken` slot (2), and the root's `taken` formula reads exactly that `skipped` value. A single-number recursion could not have expressed "3, but only if you don't take me".

### Visualization

```text
             3  (7, 6)          ← answer = max(7, 6) = 7
            / \
   (2, 3)  2   3  (3, 1)
            \    \
      (3,0)  3    1  (1, 0)

pairs travel UPWARD, one visit per node:

  taken(parent)   uses  skipped(child)          ── the "forced off" number
  skipped(parent) uses  max(taken, skipped)     ── the "free choice" number

chosen set: root 3, plus 3ᴸ, plus 1  →  3 + 3 + 1 = 7
```

### Code

```go
func robTree(root *TreeNode) int {
    // returns (best if this node is taken, best if this node is skipped)
    var solve func(node *TreeNode) (int, int)
    solve = func(node *TreeNode) (int, int) {
        if node == nil {
            return 0, 0
        }
        lTaken, lSkipped := solve(node.Left) // children FIRST (post-order)
        rTaken, rSkipped := solve(node.Right)

        taken := node.Val + lSkipped + rSkipped                   // children forced off
        skipped := max(lTaken, lSkipped) + max(rTaken, rSkipped)  // children free
        return taken, skipped
    }
    taken, skipped := solve(root)
    return max(taken, skipped)
}
```

```python
def robTree(root):
    def solve(node):
        if not node:
            return 0, 0
        l_taken, l_skipped = solve(node.left)        # children FIRST
        r_taken, r_skipped = solve(node.right)
        taken = node.val + l_skipped + r_skipped                     # forced off
        skipped = max(l_taken, l_skipped) + max(r_taken, r_skipped)  # free
        return taken, skipped

    return max(solve(root))
```

### Complexity
Time O(n) — one visit per node, O(1) combining. Space O(h) for the recursion stack. The take/skip brute force was O(2^h) because it re-solved each subtree once per branch that reached it.

---

## 10. Solved Example 2

### Problem — Cameras (LeetCode 968)
A camera on a node monitors that node, its parent, and its immediate children. Return the minimum number of cameras needed so that every node is monitored.

### Thought Process

```text
What does the state mean?  Each node returns ONE of three labels describing
                           itself after its subtree has been settled:
                             NEEDS_COVER = I am not monitored yet; my PARENT must act
                             HAS_CAMERA  = I hold a camera (so my parent is covered)
                             COVERED     = I am monitored by a child's camera
How do we compute it?      if either child NEEDS_COVER → place a camera → HAS_CAMERA
                           else if either child HAS_CAMERA → COVERED
                           else (both children COVERED) → NEEDS_COVER
What is the base case?     nil → COVERED. A missing child never demands a camera,
                           so it must not trigger the first rule.
Why post-order?            A camera is only justified by a child that would
                           otherwise go uncovered, so children must report first.
Why greedy is optimal?     A camera placed as HIGH as possible covers strictly more
                           (parent + self + children). So never place one on a leaf —
                           push it up to the leaf's parent, which is what the rules do.
```

1. Three node states → the "tuple" is a single label with three values.
2. Rule order matters: check `NEEDS_COVER` before `HAS_CAMERA`, because an uncovered child is an obligation while a child's camera is only a convenience.
3. The root has no parent, so if it finishes as `NEEDS_COVER` nobody will ever cover it — add one final camera.

### Dry Run

Input (LeetCode's example 1):

```text
     A
    /
   B
  / \
 C   D
```

| step | node | left | right | rule fired | cameras | returns |
|------|------|------|-------|------------|---------|---------|
| 1 | C (leaf) | COVERED (nil) | COVERED (nil) | neither → nobody covers me | 0 | **NEEDS_COVER** |
| 2 | D (leaf) | COVERED (nil) | COVERED (nil) | neither | 0 | **NEEDS_COVER** |
| 3 | B | NEEDS_COVER | NEEDS_COVER | child needs cover → place camera | **1** | **HAS_CAMERA** |
| 4 | A | HAS_CAMERA | COVERED (nil) | a child has a camera | 1 | **COVERED** |
| 5 | root check | — | — | A is COVERED, not NEEDS_COVER | 1 | — |

Output: **`1`**

Step 3 is the greedy move: `C` and `D` both demanded cover, and one camera at their shared parent `B` satisfies both *and* covers `B` and `A` for free. Step 5 is the rule people forget — try a **single-node tree**: step 1 returns `NEEDS_COVER`, no parent ever runs, and only the final root check adds the camera, giving the correct answer `1`. Drop that check and the answer would be `0`.

### Visualization

```text
              A   COVERED           ← covered by B's camera, no camera needed
             /
            B   HAS_CAMERA  ★      ← one camera here
           / \
NEEDS_COVER C   D  NEEDS_COVER      ← leaves never take a camera themselves

a camera at B monitors:  B (itself), C and D (children), A (parent)  = all 4 nodes

reports travel UP; the camera is pushed as HIGH as it can go while still
covering the node that demanded it.
```

### Code

```go
func minCameraCover(root *TreeNode) int {
    const (
        needsCover = 0 // not monitored yet — my parent must place a camera
        hasCamera  = 1 // I hold a camera
        covered    = 2 // monitored by a child's camera
    )
    cameras := 0
    var solve func(node *TreeNode) int
    solve = func(node *TreeNode) int {
        if node == nil {
            return covered // a missing child never demands a camera
        }
        left := solve(node.Left) // children FIRST
        right := solve(node.Right)

        if left == needsCover || right == needsCover {
            cameras++ // an uncovered child is an obligation
            return hasCamera
        }
        if left == hasCamera || right == hasCamera {
            return covered
        }
        return needsCover
    }
    if solve(root) == needsCover {
        cameras++ // the root has no parent to cover it
    }
    return cameras
}
```

```python
def minCameraCover(root):
    NEEDS_COVER, HAS_CAMERA, COVERED = 0, 1, 2
    cameras = 0

    def solve(node):
        nonlocal cameras
        if not node:
            return COVERED                      # a missing child demands nothing
        left = solve(node.left)                 # children FIRST
        right = solve(node.right)
        if left == NEEDS_COVER or right == NEEDS_COVER:
            cameras += 1                        # an uncovered child is an obligation
            return HAS_CAMERA
        if left == HAS_CAMERA or right == HAS_CAMERA:
            return COVERED
        return NEEDS_COVER

    if solve(root) == NEEDS_COVER:
        cameras += 1                            # the root has no parent
    return cameras
```

### Complexity
Time O(n) — one visit per node, three comparisons each. Space O(h) for the recursion stack. The state is a single small integer, so there is no extra memory beyond the stack.

---

## 11. Solved Example 3

### Problem — Max Path Sum (LeetCode 124)
Find the maximum sum over all non-empty paths in a binary tree. A path is any sequence of connected nodes, may start and end anywhere, and **may bend** at one node (go down-left, up through the node, and down-right).

### Thought Process

```text
What does the state mean?  gain(node) = the best sum of a path that starts at
                           `node` and goes strictly DOWNWARD (never bends).
                           That is the only thing a parent can extend.
How do we compute it?      left  = max(0, gain(node.Left))   ← clamp: a negative
                           right = max(0, gain(node.Right))    branch is worse
                                                                than taking nothing
                           gain  = node.Val + max(left, right)  ← goes UP
                           best  = max(best, node.Val + left + right) ← bends HERE
What is the base case?     nil → 0. An absent child contributes nothing, and 0 is
                           also exactly what the clamp would produce.
Why two quantities?        A node may only hand ONE chain to its parent (a path
                           cannot fork), but the overall answer may use both of
                           its branches. So the bent value updates a global best
                           and never travels upward.
```

1. Every path has a unique highest node — the node where it bends (or its single endpoint).
2. So compute, at each node, the best path whose highest node is *this* node: `val + left + right`.
3. Maximise that over all nodes and you have considered every path exactly once.
4. Clamp negatives to 0: including a branch with a negative best only makes things worse.
5. Initialise `best` to a very negative number — all values may be negative, and the path must be non-empty.

### Dry Run

Input:

```text
    -10
    /  \
   9    20
       /  \
      15   7
```

| step | node | left gain (clamped) | right gain (clamped) | bend = val+L+R | `best` after | returns val+max(L,R) |
|------|------|---------------------|----------------------|----------------|--------------|----------------------|
| 1 | 9 | 0 | 0 | 9 + 0 + 0 = **9** | 9 | 9 + 0 = **9** |
| 2 | 15 | 0 | 0 | 15 + 0 + 0 = **15** | 15 | **15** |
| 3 | 7 | 0 | 0 | 7 + 0 + 0 = **7** | 15 | **7** |
| 4 | 20 | 15 | 7 | 20 + 15 + 7 = **42** | **42** | 20 + max(15,7) = **35** |
| 5 | −10 | 9 | 35 | −10 + 9 + 35 = **34** | 42 | −10 + 35 = **25** |

Output: **`42`** — the path `15 → 20 → 7`.

Step 4 is where the two quantities diverge: the node reports **35** upward (one chain only) while contributing **42** to the answer (both chains, bending at `20`). Step 5 shows why that matters — the root's bent value, 34, is worse than 42, so the best path never reaches the root at all. The clamp earns its keep on a tree like `2` with a single child `−1`: `gain(−1) = −1` is clamped to `0`, so the answer is `2`, not `1`.

### Visualization

```text
        -10   bend = -10 + 9 + 35 = 34      returns 25 upward
        /  \
   9 ──┘    └── 20   bend = 20 + 15 + 7 = 42  ★ ANSWER
                /  \
              15    7

two different numbers at every node:

   returned UPWARD :  val + max(left, right)   ← a straight chain the parent extends
   fed to `best`   :  val + left + right       ← the path that BENDS here, and so
                                                 can never be extended further up

        15 ──▶ 20 ──▶ 7     sum 42, highest node = 20
```

### Code

```go
func maxPathSum(root *TreeNode) int {
    best := math.MinInt32 // the path must be non-empty; all values may be negative
    var gain func(node *TreeNode) int
    gain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        left := gain(node.Left) // children FIRST
        if left < 0 {
            left = 0 // a negative branch is worse than taking nothing
        }
        right := gain(node.Right)
        if right < 0 {
            right = 0
        }
        if bend := node.Val + left + right; bend > best {
            best = bend // best path whose HIGHEST node is this one
        }
        return node.Val + max(left, right) // only one chain may go upward
    }
    gain(root)
    return best
}
```

```python
def maxPathSum(root):
    best = float('-inf')          # path must be non-empty; values may be negative

    def gain(node):
        nonlocal best
        if not node:
            return 0
        left = max(0, gain(node.left))    # negative branch is worse than nothing
        right = max(0, gain(node.right))
        best = max(best, node.val + left + right)   # path that BENDS here
        return node.val + max(left, right)          # only one chain goes upward

    gain(root)
    return best
```

### Complexity
Time O(n) — one visit per node, O(1) work. Space O(h) for the recursion stack. Trying every pair of endpoints would be O(n²) paths; anchoring each path at its unique highest node collapses that to one pass.

---

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
