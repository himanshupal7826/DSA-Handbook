# 58 · Path Sum

> **One-liner:** DFS carrying running sum; optionally prefix-sum for any-path counts.

---

## 1. Overview

### Definition
The **Path Sum** pattern belongs to the *Trees* family. DFS carrying running sum; optionally prefix-sum for any-path counts.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
path sum, root to leaf, dfs, target, prefix sum tree.

### Constraints
- Input size where the brute-force complexity would time out — the Path Sum optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Path Sum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Path Sum is the upgrade.
- The wording maps onto: path sum, root to leaf, dfs, target, prefix sum tree.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Does some path in this tree add up to the number I want?"*

Running example:

```text
        5            target = 11
      /   \
     4     4
    / \     \
   8   2     2
```

### Intuition
A root-to-leaf path is just a list of node values. So collect every such list, add each one up, and compare to the target. Nothing clever — enumerate, then total.

### Algorithm
1. Walk down from the root, pushing each node's value onto a `path` list.
2. When you reach a leaf, you have a complete path.
3. &nbsp;&nbsp;Sum the whole `path` list from scratch and compare with `target`.
4. Pop the value back off and continue with the next branch.
5. Report whether any leaf produced a matching sum.

### Complexity
- Time: **O(n · h)** — there are up to `n/2` leaves, and re-summing a path costs O(h) each. On a skewed tree that is **O(n²)**.
- Space: O(h) for the path list plus the recursion stack.

### Drawbacks
- The re-summing is pure waste. On the example, the two leaves `8` and `2` both sit under `5 → 4`:

  ```text
  leaf 8 : 5 + 4 + 8      ← computes 5 + 4
  leaf 2 : 5 + 4 + 2      ← computes 5 + 4 AGAIN
  ```

  The prefix `5 + 4` was already known the moment we stood on that `4`.
- It fails to exploit the one fact that makes trees easy: **the parent already knows the sum of everything above it.** The child needs one addition, not a whole re-scan.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Don't rebuild the path sum at the leaf — carry a running sum *down* the recursion, so every node adds exactly one number.**

Think of walking down a staircase with a running total on a sticky note. At each step you add that step's value and hand the note to the next step down. Nobody ever re-adds the steps already behind them. When you hit the bottom (a leaf), the note already holds the answer.

### The thought process

```text
We need    : whether some path's values add to target.
Obvious way: collect each root-to-leaf list, sum it, compare.
Too slow   : O(n·h) — sibling paths re-add their shared prefix.
Notice     : a node's parent already holds the sum of everything above it.
Therefore  : pass that sum down as an argument; each node does one addition.
Now        : O(n) total — one visit, one add, per node.
```

### Why the running sum has to travel *down* (and the map has to be undone)

Two different questions live in this pattern, and they need two different tools.

**1. Root-to-leaf paths — a single accumulator is enough.**
Every path we care about starts at the root, so there is exactly one "sum so far" at any moment: the sum along the current branch. Pass it as a parameter and Go/Python's call stack does the bookkeeping for you — when the recursion returns, the caller's local `acc` is untouched, which is precisely the un-doing we want.

**2. Any-path counting (any node down to any descendant) — prefix sums + a hash map.**
Now a path may *start* anywhere. This is the classic "subarray sums to k" trick, moved onto a tree:

```text
array  : count j < i with prefix[i] - prefix[j] == target
tree   : count ANCESTORS a of node v with acc[v] - acc[a] == target
```

So keep a map `seen[prefixSum] → how many ancestors on the current branch produced it`. At node `v` with running sum `acc`, the number of paths *ending at v* is `seen[acc - target]`. Seed it with `seen[0] = 1` so paths that start at the root are counted.

**And here is the subtle part: the map must be rolled back as the recursion unwinds.** `seen` is only allowed to describe the *current* root-to-node branch. A node from a finished branch is not an ancestor of anything you visit next, so its entry must go:

```go
seen[acc]++
walk(node.Left, acc)
walk(node.Right, acc)
seen[acc]--   // leaving the node: it is no longer an ancestor
```

**What breaks without that `seen[acc]--`.** Take a three-node tree and `target = 3`:

```text
      1
     / \
    2    5

real answer: 1   (only the path 1→2 sums to 3)
```

```text
node 1 : acc=1, need 1-3=-2 → 0 hits.  seen = {0:1, 1:1}
node 2 : acc=3, need 3-3= 0 → 1 hit  ✔ (path 1→2).  seen = {0:1, 1:1, 3:1}
         ...returning from node 2...
   WITH    rollback: seen = {0:1, 1:1}
   WITHOUT rollback: seen = {0:1, 1:1, 3:1}   ← stale
node 5 : acc=6, need 6-3=3
   WITH    rollback: seen[3] = 0 → 0 hits → total 1  ✔
   WITHOUT rollback: seen[3] = 1 → 1 hit  → total 2  ✘
```

The phantom hit claims a path running from node `2` down to node `5` — but `2` is not an ancestor of `5`; they are cousins. The rollback is what enforces "ancestor", and forgetting it is the single most common bug in this pattern.

### Steps

```text
Step 1 → Recurse with an extra parameter acc = sum of the path above this node.
Step 2 → At each node: acc += node.Val.
Step 3 → ROOT-TO-LEAF question: at a leaf, answer acc == target.
Step 4 → ANY-PATH question: total += seen[acc - target], then seen[acc]++.
Step 5 → Recurse into both children with the same acc.
Step 6 → ANY-PATH question: seen[acc]-- before returning (rollback).
```

### How should I recognize this?

```text
If you see...
  "root-to-leaf", "path sums to target", "sum root to leaf numbers"
  "paths that sum to k" (path may start/end anywhere going downward)
  a binary tree + a target number
        ↓
Think about...
  "Where may a qualifying path START?"
        ↓
Use...
  starts only at the root  → carry acc down; test at leaves
  starts anywhere downward → carry acc down + map of ancestor prefix sums
                             + roll the map back on the way out
  path may bend through a node (goes up then down) → tree DP, not this
```

### Visual explanation

```svg
<svg viewBox="0 0 560 265" width="100%" height="265" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="psum-58" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">DFS carries a running sum down each root-to-leaf path (target 11)</text>
  <!-- highlighted path A-C-F -->
  <line x1="294" y1="54" x2="366" y2="96" stroke="#059669" stroke-width="4"/>
  <line x1="394" y1="124" x2="426" y2="166" stroke="#059669" stroke-width="4"/>
  <!-- other edges -->
  <line x1="266" y1="54" x2="194" y2="96" stroke="#475569"/>
  <line x1="166" y1="124" x2="134" y2="166" stroke="#475569"/>
  <line x1="194" y1="124" x2="226" y2="166" stroke="#475569"/>
  <!-- nodes with values -->
  <circle cx="280" cy="40" r="20" fill="#ecfdf5" stroke="#059669"/><text x="280" y="45" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="180" cy="110" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="180" y="115" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="380" cy="110" r="20" fill="#ecfdf5" stroke="#059669"/><text x="380" y="115" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="120" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="185" text-anchor="middle" fill="#1e293b">8</text>
  <circle cx="240" cy="180" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="240" y="185" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="440" cy="180" r="20" fill="#ecfdf5" stroke="#059669"/><text x="440" y="185" text-anchor="middle" fill="#1e293b">2</text>
  <text x="308" y="44"  text-anchor="start" fill="#059669" font-weight="700">acc=5</text>
  <text x="404" y="114" text-anchor="start" fill="#059669" font-weight="700">acc=9</text>
  <text x="466" y="184" text-anchor="start" fill="#059669" font-weight="700">acc=11</text>
  <line x1="120" y1="215" x2="440" y2="215" stroke="#475569" marker-end="url(#psum-58)"/>
  <text x="280" y="252" text-anchor="middle" fill="#059669" font-weight="700">leaf reached with acc == target, so 5 + 4 + 2 = 11 is a hit</text>
</svg>
```

```text
        5            target = 11
      /   \
     4     4
    / \     \
   8   2     2

visit 5      acc = 0 + 5  =  5    not a leaf → descend
  visit 4    acc = 5 + 4  =  9    not a leaf → descend      (5+4 computed ONCE)
    visit 8  acc = 9 + 8  = 17    leaf, 17 != 11 → false
    visit 2  acc = 9 + 2  = 11    leaf, 11 == 11 → TRUE
                                  ↑ reuses the acc=9 its sibling used
answer: true
```

### Interview explanation
"A root-to-leaf path sum is a prefix sum on a branch, so instead of rebuilding it at each leaf I pass the running total down as a recursion parameter — every node does exactly one addition, giving O(n) time and O(h) stack. If the problem instead asks for paths that may start at *any* node, it becomes the subarray-sum-equals-k trick moved onto the tree: I keep a hash map of the prefix sums of my current ancestors, seeded with `{0: 1}`, and at each node add `seen[acc - target]` to the count. The critical detail is decrementing that map entry as the recursion unwinds — otherwise a node from a finished branch is still treated as an ancestor and I count paths that don't exist. Both versions are O(n) time; the counting one is O(n) space for the map."

---

## 5. Generic Templates

> Push the running sum **down**; if paths may start anywhere, add a prefix-sum map and **undo it on the way out**.

```go
// 1. Root-to-leaf: one accumulator, tested only at leaves.
func existsRootToLeafSum(root *TreeNode, target int) bool {
    var descend func(node *TreeNode, acc int) bool
    descend = func(node *TreeNode, acc int) bool {
        if node == nil {
            return false
        }
        acc += node.Val // the one addition this node owes
        if node.Left == nil && node.Right == nil {
            return acc == target // only a leaf closes a root-to-leaf path
        }
        return descend(node.Left, acc) || descend(node.Right, acc)
    }
    return descend(root, 0)
}

// 2. Any downward path: prefix sums of the CURRENT ancestors, rolled back.
func countDownwardPaths(root *TreeNode, target int) int {
    seen := map[int]int{0: 1} // prefix sum -> how many ancestors produced it
    total := 0
    var descend func(node *TreeNode, acc int)
    descend = func(node *TreeNode, acc int) {
        if node == nil {
            return
        }
        acc += node.Val
        total += seen[acc-target] // each such ancestor closes one path here
        seen[acc]++
        descend(node.Left, acc)
        descend(node.Right, acc)
        seen[acc]-- // leaving this node: it is no longer an ancestor
    }
    descend(root, 0)
    return total
}
```

```python
def exists_root_to_leaf_sum(root, target):
    def descend(node, acc):
        if not node:
            return False
        acc += node.val                       # the one addition this node owes
        if not node.left and not node.right:
            return acc == target              # only a leaf closes a path
        return descend(node.left, acc) or descend(node.right, acc)
    return descend(root, 0)


def count_downward_paths(root, target):
    seen = {0: 1}                             # prefix sum -> ancestor count
    total = 0

    def descend(node, acc):
        nonlocal total
        if not node:
            return
        acc += node.val
        total += seen.get(acc - target, 0)    # ancestors that close a path here
        seen[acc] = seen.get(acc, 0) + 1
        descend(node.left, acc)
        descend(node.right, acc)
        seen[acc] -= 1                        # no longer an ancestor

    descend(root, 0)
    return total
```

```java
boolean existsRootToLeafSum(TreeNode node, int acc, int target) {
    if (node == null) return false;
    acc += node.val;                              // the one addition this node owes
    if (node.left == null && node.right == null)
        return acc == target;                     // only a leaf closes a path
    return existsRootToLeafSum(node.left, acc, target)
        || existsRootToLeafSum(node.right, acc, target);
}

int countDownwardPaths(TreeNode root, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    seen.put(0, 1);                               // prefix sum -> ancestor count
    return walk(root, 0, target, seen);
}

int walk(TreeNode node, int acc, int target, Map<Integer, Integer> seen) {
    if (node == null) return 0;
    acc += node.val;
    int total = seen.getOrDefault(acc - target, 0);   // paths ending here
    seen.merge(acc, 1, Integer::sum);
    total += walk(node.left, acc, target, seen);
    total += walk(node.right, acc, target, seen);
    seen.merge(acc, -1, Integer::sum);                // no longer an ancestor
    return total;
}
```

```cpp
bool existsRootToLeafSum(TreeNode* node, int acc, int target) {
    if (!node) return false;
    acc += node->val;                          // the one addition this node owes
    if (!node->left && !node->right)
        return acc == target;                  // only a leaf closes a path
    return existsRootToLeafSum(node->left, acc, target)
        || existsRootToLeafSum(node->right, acc, target);
}

int walk(TreeNode* node, int acc, int target, unordered_map<int,int>& seen) {
    if (!node) return 0;
    acc += node->val;
    int total = seen.count(acc - target) ? seen[acc - target] : 0;  // ends here
    seen[acc]++;
    total += walk(node->left, acc, target, seen);
    total += walk(node->right, acc, target, seen);
    seen[acc]--;                               // no longer an ancestor
    return total;
}

int countDownwardPaths(TreeNode* root, int target) {
    unordered_map<int,int> seen{{0, 1}};       // prefix sum -> ancestor count
    return walk(root, 0, target, seen);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Path Sum (Optimal) |
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

### Problem — Path Sum (LeetCode 112)
Given a binary tree and a number `targetSum`, return `true` if some **root-to-leaf** path's values add up to `targetSum`.

### Thought Process
1. Only paths that start at the root and end at a leaf count, so there is exactly one running sum in play at any moment.
2. Pass that running sum down as a recursion parameter — the parent already knows the sum above it.
3. Test `acc == targetSum` **only at a leaf**; an internal node matching the target proves nothing.
4. `||` short-circuits, so the moment one branch answers `true` the rest of the tree is skipped.
5. An empty tree has no root-to-leaf path at all → `false`, even when `targetSum` is 0.

### Dry Run

Input:

```text
        5            targetSum = 11
      /   \
     4     4
    / \     \
   8   2     2
```

| step | node | acc before | acc after | leaf? | decision |
|------|------|-----------|-----------|-------|----------|
| 1 | 5 | 0 | 5 | no | descend left |
| 2 | 4 (left) | 5 | 9 | no | descend left |
| 3 | 8 | 9 | 17 | **yes** | 17 ≠ 11 → `false` |
| 4 | 2 (left branch) | 9 | 11 | **yes** | 11 == 11 → `true` |
| 5 | — | — | — | — | `true` bubbles up; right subtree never visited |

Output: **`true`**

Row 4 is the whole point: it starts from `acc = 9`, the value its sibling in row 3 already computed. The brute force would have re-added `5 + 4` here.

### Visualization

```text
descend(5,  acc=0) ─▶ acc=5
   └── descend(4,  acc=5) ─▶ acc=9        <-- "5+4" computed once, reused twice
          ├── descend(8, acc=9) ─▶ 17  leaf  17 != 11   false
          └── descend(2, acc=9) ─▶ 11  leaf  11 == 11   TRUE
   └── descend(4, acc=5)   [never reached — || short-circuited]

acc only ever grows going DOWN; returning restores the caller's acc for free.
```

### Code

```go
func hasPathSum(root *TreeNode, targetSum int) bool {
    var descend func(node *TreeNode, acc int) bool
    descend = func(node *TreeNode, acc int) bool {
        if node == nil {
            return false // an empty subtree contains no root-to-leaf path
        }
        acc += node.Val
        if node.Left == nil && node.Right == nil {
            return acc == targetSum // only a leaf may answer
        }
        return descend(node.Left, acc) || descend(node.Right, acc)
    }
    return descend(root, 0)
}
```

```python
def hasPathSum(root, targetSum):
    def descend(node, acc):
        if not node:
            return False                      # no root-to-leaf path here
        acc += node.val
        if not node.left and not node.right:
            return acc == targetSum           # only a leaf may answer
        return descend(node.left, acc) or descend(node.right, acc)
    return descend(root, 0)
```

### Complexity
Time O(n) — each node is visited at most once and does one addition. Space O(h) — recursion depth equals the tree height (O(n) on a skewed tree).

---

## 10. Solved Example 2

### Problem — Path Sum II (LeetCode 113)
Same tree and target, but now return **every** root-to-leaf path whose values add up to `targetSum`, each as a list of node values.

### Thought Process
1. Same descent as before, but we must also remember *which* nodes we walked through.
2. Keep one shared `path` slice: append on the way in, pop on the way out. That pop is the backtracking.
3. At a leaf with `acc == targetSum`, the current `path` is an answer.
4. **Copy the path before storing it.** `path` keeps mutating; appending it directly stores an alias that later branches will overwrite.
5. No early exit — we want all matches, so both children are always explored.

### Dry Run

Input:

```text
        5            targetSum = 12
      /   \
     4     6
    / \     \
   2   3     1
```

| step | node | acc | path | leaf? | action |
|------|------|-----|------|-------|--------|
| 1 | 5 | 5 | `[5]` | no | descend |
| 2 | 4 | 9 | `[5,4]` | no | descend |
| 3 | 2 | 11 | `[5,4,2]` | yes | 11 ≠ 12 → nothing |
| 4 | — | — | `[5,4]` | — | pop 2 (backtrack) |
| 5 | 3 | 12 | `[5,4,3]` | yes | 12 == 12 → **record `[5,4,3]`** |
| 6 | — | — | `[5]` | — | pop 3, pop 4 |
| 7 | 6 | 11 | `[5,6]` | no | descend |
| 8 | 1 | 12 | `[5,6,1]` | yes | 12 == 12 → **record `[5,6,1]`** |
| 9 | — | — | `[]` | — | pops unwind to empty |

Output: **`[[5,4,3], [5,6,1]]`**

Rows 4 and 6 are the backtracking. Without them, step 7 would start from `path = [5,4,2,3]` and every later answer would be garbage.

### Visualization

```text
path grows going down, shrinks coming back up:

[]  →  [5]  →  [5,4]  →  [5,4,2]     acc=11  ✗
               [5,4]  ←  pop 2
               [5,4]  →  [5,4,3]     acc=12  ✔  copy → result
               [5,4]  ←  pop 3
        [5]    ←  pop 4
        [5]    →  [5,6]  →  [5,6,1]  acc=12  ✔  copy → result
        []     ←  pops unwind

result = [ [5,4,3], [5,6,1] ]
```

### Code

```go
func pathSumII(root *TreeNode, targetSum int) [][]int {
    result := [][]int{}
    path := []int{}
    var descend func(node *TreeNode, acc int)
    descend = func(node *TreeNode, acc int) {
        if node == nil {
            return
        }
        acc += node.Val
        path = append(path, node.Val)
        if node.Left == nil && node.Right == nil && acc == targetSum {
            found := make([]int, len(path))
            copy(found, path) // path keeps mutating — store a snapshot
            result = append(result, found)
        }
        descend(node.Left, acc)
        descend(node.Right, acc)
        path = path[:len(path)-1] // backtrack: this node is no longer on the path
    }
    descend(root, 0)
    return result
}
```

```python
def pathSumII(root, targetSum):
    result, path = [], []

    def descend(node, acc):
        if not node:
            return
        acc += node.val
        path.append(node.val)
        if not node.left and not node.right and acc == targetSum:
            result.append(path[:])            # snapshot — path keeps mutating
        descend(node.left, acc)
        descend(node.right, acc)
        path.pop()                            # backtrack

    descend(root, 0)
    return result
```

### Complexity
Time O(n · h) in the worst case — O(n) to visit every node, plus O(h) to copy each recorded path (and there can be O(n) of them). Space O(h) for the recursion and the live path, excluding the output.

---

## 11. Solved Example 3

### Problem — Path Sum III (LeetCode 437)
Count the paths that sum to `targetSum`, where a path may **start and end at any node** as long as it travels downward (parent → child).

### Thought Process
1. A downward path from ancestor `a` to node `v` sums to `acc[v] - acc[a]`, where `acc[x]` is the root-to-`x` running sum. This is "subarray sums to k", moved onto the tree.
2. So at node `v`, the number of paths **ending at v** is the number of ancestors `a` with `acc[a] == acc[v] - targetSum`.
3. Keep `seen[prefixSum] → count of ancestors on the current branch`, seeded with `seen[0] = 1` so paths starting at the root are counted.
4. Add `seen[acc - targetSum]` to the total *before* inserting the current node, so a node never pairs with itself.
5. **Decrement `seen[acc]` on the way out.** The map must describe only the current branch's ancestors.

### Dry Run

Input:

```text
       1            targetSum = 3
      / \
     2    5
    /
   3
```

| step | node | acc | look up `acc − 3` | `seen[...]` | total | `seen` after this row |
|------|------|-----|------------------|-------------|-------|-----------------------|
| 0 | — (start) | 0 | — | — | 0 | `{0:1}` |
| 1 | 1 | 1 | −2 | 0 | 0 | `{0:1, 1:1}` |
| 2 | 2 | 3 | 0 | **1** | **1** | `{0:1, 1:1, 3:1}` |
| 3 | 3 | 6 | 3 | **1** | **2** | `{0:1, 1:1, 3:1, 6:1}` |
| 4 | ← leave 3 | — | — | — | 2 | `{0:1, 1:1, 3:1}` (6 rolled back) |
| 5 | ← leave 2 | — | — | — | 2 | `{0:1, 1:1}` (3 rolled back) |
| 6 | 5 | 6 | 3 | **0** | 2 | `{0:1, 1:1, 6:1}` |
| 7 | ← leave 5, leave 1 | — | — | — | 2 | `{0:1}` |

Output: **`2`** — the paths `1→2` and the single node `3`.

Row 6 is the row that proves the rollback matters. Node `5` looks up prefix `3`; row 5 had already removed it, so it finds 0. Skip the rollback and `seen[3]` would still be 1, giving a third "path" running from node `2` to node `5` — two cousins that no downward path connects.

### Visualization

```text
seen = prefix sums of the CURRENT ancestor chain only

        1 (acc=1)          chain: [0,1]              seen {0:1, 1:1}
       / \
 acc=3 2   5 acc=6         chain: [0,1,3]            seen {0:1, 1:1, 3:1}
      /                    look 3-3=0 → hit ✔  (path 1→2)
 acc=6 3                   chain: [0,1,3,6]
                           look 6-3=3 → hit ✔  (path 3)

 unwind ... seen drops back to {0:1, 1:1}

        5 (acc=6)          chain: [0,1,6]
                           look 6-3=3 → seen[3]=0 → no hit ✔ correct
                           (without rollback it would be 1 → phantom 2→5)

total = 2
```

### Code

```go
func pathSumIII(root *TreeNode, targetSum int) int {
    seen := map[int]int{0: 1} // prefix sum -> ancestors on the current branch
    total := 0
    var descend func(node *TreeNode, acc int)
    descend = func(node *TreeNode, acc int) {
        if node == nil {
            return
        }
        acc += node.Val
        total += seen[acc-targetSum] // ancestors that close a path ending here
        seen[acc]++                  // this node becomes an ancestor
        descend(node.Left, acc)
        descend(node.Right, acc)
        seen[acc]-- // ROLLBACK: leaving the branch, no longer an ancestor
    }
    descend(root, 0)
    return total
}
```

```python
def pathSumIII(root, targetSum):
    seen = {0: 1}                              # prefix sum -> ancestor count
    total = 0

    def descend(node, acc):
        nonlocal total
        if not node:
            return
        acc += node.val
        total += seen.get(acc - targetSum, 0)  # paths ending at this node
        seen[acc] = seen.get(acc, 0) + 1       # becomes an ancestor
        descend(node.left, acc)
        descend(node.right, acc)
        seen[acc] -= 1                         # ROLLBACK on the way out

    descend(root, 0)
    return total
```

### Complexity
Time O(n) — one visit per node, each doing O(1) map work. Space O(h) for the recursion plus O(h) for the map, since it only ever holds the current branch's prefix sums (O(n) on a skewed tree). The naive "run a fresh downward sum from every node" version is O(n·h); the map removes that factor.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 112 | Path Sum | Easy | Core trees application |
| 113 | Path Sum II | Easy | Core trees application |
| 437 | Path Sum III | Medium | Core trees application |
| 129 | Sum Root to Leaf | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Path Sum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Path Sum (Trees).
- **Signal:** path sum, root to leaf, dfs, target, prefix sum tree.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Path Sum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Path Sum
FAMILY : Trees (Intermediate)
WHEN   : path sum, root to leaf, dfs, target, prefix sum tree
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 112, 113, 437, 129
```

---

*Part of the DSA Patterns Handbook — pattern 58 of 100.*
