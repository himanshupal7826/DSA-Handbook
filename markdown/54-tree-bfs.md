# 54 · Tree BFS

> **One-liner:** Queue-based level traversal for level-aggregate problems.

---

## 1. Overview

### Definition
The **Tree BFS** pattern belongs to the *Trees* family. Queue-based level traversal for level-aggregate problems.

### Intuition
Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.

### Why it works
One DFS post-order pass returns each subtree's summary to its parent — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.

---

## 2. Recognition Signals

### Keywords
bfs, tree, level order, queue, breadth.

### Constraints
- Input size where the brute-force complexity would time out — the Tree BFS optimization is the intended solution.
- Structural hints in the statement that match this family (Trees).

### Hidden clues
- The problem can be reframed so the Tree BFS invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Tree BFS is the upgrade.
- The wording maps onto: bfs, tree, level order, queue, breadth.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Process the tree one **level** at a time — and know where each level begins and ends."*

### Intuition
If you only have DFS, you can still get levels: record every node's depth, then group by depth afterwards.

### Algorithm
1. Run a DFS, passing each node's depth down as a parameter.
2. Store pairs `(depth, value)` in a list.
3. Afterwards, group the list by depth and sort the groups.
4. Emit the groups in depth order.

### Complexity
- Time: O(n) for the walk plus O(n log n) if you sort the groups.
- Space: O(n) for all the pairs.

### Drawbacks
- It needs a **second pass** and a grouping structure just to recover information the traversal order could have given for free.
- Left-to-right order within a level isn't guaranteed unless you're careful about how you append.
- And it can't answer "what is the *first* level satisfying X?" without walking the entire tree — a BFS could have stopped at that level.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Use a queue. It naturally visits nodes in level order — and if you record the queue's length before processing, you know exactly how many nodes are in the current level.**

That length snapshot is the whole pattern. Without it you get the right *order* but no idea where the levels break.

### The thought process

```text
We need    : nodes grouped by level, in left-to-right order.
Obvious way: DFS with depths, then group afterwards.
Awkward    : two passes, extra structure, and no early exit.
Notice     : a QUEUE is first-in-first-out — enqueue the root, and
             children always come out after every node at their
             parent's level. So the ORDER is already correct.
Problem    : the queue mixes levels, so where does a level end?
Notice too : at the START of an iteration the queue holds EXACTLY
             the current level and nothing else.
Therefore  : snapshot len(queue), then process exactly that many.
Now        : one pass, levels perfectly delimited, early exit possible.
```

### Why the length snapshot works

This is the invariant that makes everything correct:

> At the top of each outer iteration, the queue contains **precisely** the nodes of one level.

It holds inductively. Start: the queue holds just the root — level 0. During an iteration you remove all `k` nodes of the current level and enqueue only their children. So when the iteration ends, the queue holds exactly the next level.

```text
queue: [3]                  size = 1  →  level 0 is [3]
  process 3, enqueue 9, 20
queue: [9, 20]              size = 2  →  level 1 is [9, 20]
  process 9 (no children), process 20, enqueue 15, 7
queue: [15, 7]              size = 2  →  level 2 is [15, 7]
```

**The snapshot must be taken before the inner loop**, and the inner loop must count against that saved number — not against a live `len(queue)`, which grows as you enqueue children. Reading the length inside the loop condition is the classic bug: it merges every level into one.

### Steps

```text
Step 1 → If the root is nil, return empty.
Step 2 → queue = [root]
Step 3 → While the queue is not empty:
Step 4 →     levelSize = len(queue)          ← snapshot BEFORE processing
Step 5 →     Repeat levelSize times:
Step 6 →         node = dequeue
Step 7 →         record node.Val into the current level
Step 8 →         enqueue node.Left and node.Right if non-nil
Step 9 →     Append the finished level to the result.
```

### The variations are all "what do I do with one level?"

The skeleton never changes. Only the line inside the inner loop does:

| Problem | What changes |
|---|---|
| Level order (102) | collect all values in the level |
| Zigzag (103) | reverse the level list on odd levels |
| Right side view (199) | keep only the **last** node of each level |
| Level averages (637) | sum the level, divide by `levelSize` |
| Minimum depth (111) | return the level index at the **first leaf** you see |
| Largest value per level (515) | keep the max of the level |

That last-but-one entry is the real argument for BFS: **minimum depth** is O(shallowest level) with BFS because you stop the instant you meet a leaf, while DFS must explore everything.

### BFS or DFS?

| Use BFS when… | Use DFS when… |
|---|---|
| the answer depends on **levels** | the answer combines **subtree** results |
| you want the **shallowest** thing (early exit) | you need depth-first order (in/pre/post) |
| the tree is deep but narrow | the tree is shallow but wide |

Memory is the mirror image: BFS holds up to one full level — **O(w)** for the widest level, which is O(n/2) for a complete tree. DFS holds one root-to-node path, **O(h)**. Neither dominates; pick by shape.

### How should I recognize this?

```text
If you see...
  "level order", "level by level", "each row", "zigzag"
  "right/left side view", "average per level", "minimum depth"
  "shortest path in an unweighted structure"
        ↓
Think about...
  "Does the answer group by DEPTH? Then use a queue —
   and snapshot its length to delimit each level."
        ↓
Use...
  queue + levelSize := len(queue) before the inner loop
```

### Visual explanation

```svg
<svg viewBox="0 0 560 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bfs-54" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="280" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">BFS sweeps level by level using a queue</text>
  <!-- level bands -->
  <rect x="30" y="30" width="420" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-dasharray="4 3"/>
  <rect x="30" y="92" width="420" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-dasharray="4 3"/>
  <rect x="30" y="154" width="420" height="42" rx="8" fill="#ecfdf5" stroke="#059669" stroke-dasharray="4 3"/>
  <text x="470" y="56" text-anchor="start" fill="#64748b">L0: A</text>
  <text x="470" y="118" text-anchor="start" fill="#64748b">L1: B C</text>
  <text x="470" y="180" text-anchor="start" fill="#64748b">L2: D E F</text>
  <!-- edges -->
  <line x1="226" y1="66" x2="174" y2="98" stroke="#475569"/>
  <line x1="254" y1="66" x2="306" y2="98" stroke="#475569"/>
  <line x1="146" y1="128" x2="114" y2="160" stroke="#475569"/>
  <line x1="174" y1="128" x2="206" y2="160" stroke="#475569"/>
  <line x1="334" y1="128" x2="366" y2="160" stroke="#475569"/>
  <!-- nodes -->
  <circle cx="240" cy="51" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="240" y="56" text-anchor="middle" fill="#1e293b">A</text>
  <circle cx="160" cy="113" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="160" y="118" text-anchor="middle" fill="#1e293b">B</text>
  <circle cx="320" cy="113" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="118" text-anchor="middle" fill="#1e293b">C</text>
  <circle cx="100" cy="175" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="180" text-anchor="middle" fill="#1e293b">D</text>
  <circle cx="220" cy="175" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="220" y="180" text-anchor="middle" fill="#1e293b">E</text>
  <circle cx="380" cy="175" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="380" y="180" text-anchor="middle" fill="#1e293b">F</text>
  <line x1="60" y1="225" x2="430" y2="225" stroke="#475569" marker-end="url(#bfs-54)"/>
  <text x="245" y="248" text-anchor="middle" fill="#059669" font-weight="700">dequeue order: A B C D E F</text>
</svg>
```

```text
        3
       / \
      9  20
        /  \
       15   7

queue [3]        size 1 → level 0: [3]      enqueue 9, 20
queue [9,20]     size 2 → level 1: [9,20]   enqueue 15, 7
queue [15,7]     size 2 → level 2: [15,7]   nothing to enqueue
queue []         done

result: [[3], [9,20], [15,7]]
```

### Interview explanation
"I'll use BFS with a queue, which visits nodes in level order naturally. The one trick is delimiting the levels: at the top of each iteration the queue holds exactly the current level, so I snapshot its length and process precisely that many nodes, enqueueing their children as I go. Taking the snapshot *before* the inner loop is essential — reading the live length inside the loop would merge every level into one. That gives one pass, O(n) time, and O(w) space for the widest level. BFS is also what lets me exit early for shallowest-answer questions like minimum depth, which DFS can't do."

---

## 5. Generic Templates

> Queue, snapshot the length, process exactly that many. Change only what happens per level.

```go
// LevelOrder returns the node values grouped by level, left to right.
func LevelOrder(root *TreeNode) [][]int {
    result := [][]int{}
    if root == nil {
        return result
    }

    queue := []*TreeNode{root}
    for len(queue) > 0 {
        // Snapshot BEFORE processing: the queue is exactly this level.
        levelSize := len(queue)
        level := make([]int, 0, levelSize)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            level = append(level, node.Val)

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
        result = append(result, level)
    }
    return result
}

// MinDepth shows BFS's real advantage: it stops at the first leaf.
func MinDepth(root *TreeNode) int {
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

            // The first leaf we meet is on the shallowest level.
            if node.Left == nil && node.Right == nil {
                return depth
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
from collections import deque

def level_order(root):
    """Node values grouped by level, left to right."""
    result = []
    if root is None:
        return result

    queue = deque([root])
    while queue:
        level_size = len(queue)          # snapshot BEFORE processing
        level = []
        for _ in range(level_size):
            node = queue.popleft()
            level.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        result.append(level)
    return result

def min_depth(root):
    """BFS stops at the first leaf — DFS would have to explore everything."""
    if root is None:
        return 0

    queue = deque([root])
    depth = 1
    while queue:
        for _ in range(len(queue)):
            node = queue.popleft()
            if node.left is None and node.right is None:
                return depth             # shallowest leaf
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        depth += 1
    return depth
```

```java
import java.util.*;

public class TreeBFS {
    public static List<List<Integer>> levelOrder(TreeNode root) {
        List<List<Integer>> result = new ArrayList<>();
        if (root == null) return result;

        Queue<TreeNode> queue = new ArrayDeque<>();
        queue.add(root);

        while (!queue.isEmpty()) {
            int levelSize = queue.size();          // snapshot BEFORE processing
            List<Integer> level = new ArrayList<>(levelSize);

            for (int i = 0; i < levelSize; i++) {
                TreeNode node = queue.poll();
                level.add(node.val);
                if (node.left != null) queue.add(node.left);
                if (node.right != null) queue.add(node.right);
            }
            result.add(level);
        }
        return result;
    }

    public static class TreeNode {
        int val; TreeNode left, right;
        TreeNode(int val) { this.val = val; }
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    explicit TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

vector<vector<int>> levelOrder(TreeNode* root) {
    vector<vector<int>> result;
    if (root == nullptr) return result;

    queue<TreeNode*> q;
    q.push(root);

    while (!q.empty()) {
        int levelSize = (int)q.size();             // snapshot BEFORE processing
        vector<int> level;
        level.reserve(levelSize);

        for (int i = 0; i < levelSize; ++i) {
            TreeNode* node = q.front();
            q.pop();
            level.push_back(node->val);
            if (node->left) q.push(node->left);
            if (node->right) q.push(node->right);
        }
        result.push_back(level);
    }
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Tree BFS (Optimal) |
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

### Problem — Binary Tree Level Order Traversal (LeetCode 102)
Return the node values grouped level by level, left to right.

### Thought Process
1. A queue gives level order for free — children always leave the queue after every node at their parent's level.
2. The only missing piece is the level boundaries, and the queue supplies those too: at the start of each iteration it holds exactly one level.
3. Snapshot `len(queue)` **before** the inner loop, then process precisely that many nodes.
4. Enqueue children as you go; they form the next level.
5. Append the finished level to the result and repeat.

### Dry Run

Input:

```text
        3
       / \
      9  20
        /  \
       15   7
```

| iteration | queue at start | levelSize | nodes processed | children enqueued | level produced |
|-----------|----------------|-----------|-----------------|--------------------|----------------|
| 1 | `[3]` | **1** | `3` | `9`, `20` | `[3]` |
| 2 | `[9, 20]` | **2** | `9`, `20` | `15`, `7` (from 20; 9 has none) | `[9, 20]` |
| 3 | `[15, 7]` | **2** | `15`, `7` | none | `[15, 7]` |
| 4 | `[]` | — | — | — | queue empty → stop |

Output: **`[[3], [9, 20], [15, 7]]`** ✓

**Why the snapshot must come first.** In iteration 2 the queue starts at length 2, but after processing `20` it holds `[15, 7]` — still length 2. If the inner loop tested against the live length it would keep going and swallow `15` and `7` into level 1, producing `[[3], [9,20,15,7]]`. Saving `levelSize` up front is what prevents that.

### Visualization

```text
queue [3]        ─┐ size 1
                  └─▶ level 0 = [3]        enqueue 9, 20

queue [9,20]     ─┐ size 2
                  └─▶ level 1 = [9,20]     enqueue 15, 7

queue [15,7]     ─┐ size 2
                  └─▶ level 2 = [15,7]     nothing to enqueue

queue []            done
```

### Code

```go
func levelOrder(root *TreeNode) [][]int {
    result := [][]int{}
    if root == nil {
        return result
    }

    queue := []*TreeNode{root}
    for len(queue) > 0 {
        // Snapshot BEFORE the inner loop: the queue is exactly this level.
        levelSize := len(queue)
        level := make([]int, 0, levelSize)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            level = append(level, node.Val)

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
        result = append(result, level)
    }
    return result
}
```

```python
from collections import deque

def levelOrder(root):
    result = []
    if root is None:
        return result

    queue = deque([root])
    while queue:
        level_size = len(queue)          # snapshot BEFORE the inner loop
        level = []
        for _ in range(level_size):
            node = queue.popleft()
            level.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        result.append(level)
    return result
```

### Complexity
Time **O(n)** — each node is enqueued and dequeued once. Space **O(w)** where `w` is the widest level, up to O(n/2) for a complete tree.

---

## 10. Solved Example 2

### Problem — Binary Tree Zigzag Level Order Traversal (LeetCode 103)
Same as level order, but alternate direction: left-to-right on level 0, right-to-left on level 1, and so on.

### Thought Process
1. The traversal itself does not change at all — only the presentation of each finished level.
2. So keep the identical BFS and reverse the collected level when its index is odd.
3. **Do not reverse the queue or change the enqueue order.** That would corrupt the parent-child ordering for every level below, not just this one.
4. Track a boolean that flips each iteration, or just test the level index's parity.
5. Reversing a level of size `k` is O(k), and the levels sum to `n`, so the total stays O(n).

### Dry Run

Input:

```text
        3
       / \
      9  20
        /  \
       15   7
```

| level index | collected left-to-right | odd index? | emitted |
|-------------|--------------------------|------------|---------|
| 0 | `[3]` | no | `[3]` |
| 1 | `[9, 20]` | **yes** | `[20, 9]` |
| 2 | `[15, 7]` | no | `[15, 7]` |

Output: **`[[3], [20, 9], [15, 7]]`** ✓

Note level 2 came out `[15, 7]` — left to right — even though level 1 was emitted reversed. That is only correct because we reversed the *output list* and left the queue untouched. Had we enqueued children in reversed order for level 1, level 2 would have come out `[7, 15]` and the alternation would break down.

### Visualization

```text
level 0:   [3]              →  left to right   →  [3]
                                    ↓
level 1:   [9, 20]          →  reverse         →  [20, 9]
                                    ↓
level 2:   [15, 7]          →  left to right   →  [15, 7]

the QUEUE always runs left to right; only the output flips
```

### Code

```go
func zigzagLevelOrder(root *TreeNode) [][]int {
    result := [][]int{}
    if root == nil {
        return result
    }

    queue := []*TreeNode{root}
    leftToRight := true

    for len(queue) > 0 {
        levelSize := len(queue)
        level := make([]int, 0, levelSize)

        // The traversal itself never changes — always left to right.
        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            level = append(level, node.Val)

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }

        // Only the OUTPUT is flipped, never the queue order.
        if !leftToRight {
            for i, j := 0, len(level)-1; i < j; i, j = i+1, j-1 {
                level[i], level[j] = level[j], level[i]
            }
        }
        leftToRight = !leftToRight

        result = append(result, level)
    }
    return result
}
```

```python
from collections import deque

def zigzagLevelOrder(root):
    result = []
    if root is None:
        return result

    queue = deque([root])
    left_to_right = True

    while queue:
        level = []
        for _ in range(len(queue)):      # traversal is always left to right
            node = queue.popleft()
            level.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)

        if not left_to_right:            # only the OUTPUT flips
            level.reverse()
        left_to_right = not left_to_right

        result.append(level)
    return result
```

### Complexity
Time **O(n)** — the reversals add O(n) in total across all levels. Space O(w).

---

## 11. Solved Example 3

### Problem — Binary Tree Right Side View (LeetCode 199)
Standing to the right of the tree, return the values visible from top to bottom.

### Thought Process
1. What you see from the right is exactly the **last node of each level** — not the rightmost path, which is a different and wrong idea.
2. Why not the rightmost path? Because a node's right child may be missing while a deeper node further left is still the last on its level.
3. So run the standard BFS and, within each level, keep only the node at index `levelSize − 1`.
4. That is a one-line change to the template.
5. (The DFS alternative visits right before left and records the first node seen at each new depth — same answer, different traversal.)

### Dry Run

Input:

```text
      1
     / \
    2   3
     \    \
      5    4
```

| level | nodes left to right | last node | visible |
|-------|---------------------|-----------|---------|
| 0 | `1` | `1` | **1** |
| 1 | `2, 3` | `3` | **3** |
| 2 | `5, 4` | `4` | **4** |

Output: **`[1, 3, 4]`** ✓

**The case that kills the "walk the right spine" idea.** Consider:

```text
      1
     / \
    2   3
   /
  5
```

The right spine is `1 → 3`, and `3` has no children, so that approach returns `[1, 3]`. But level 2 contains `5`, which *is* visible from the right — nothing blocks it. The correct answer is `[1, 3, 5]`, and the level-based method gets it because `5` is the only (hence last) node on its level.

### Visualization

```text
      1              level 0:  [1]        → last = 1   👁
     / \
    2   3            level 1:  [2, 3]     → last = 3   👁
     \    \
      5    4         level 2:  [5, 4]     → last = 4   👁

viewer stands here ──▶  sees 1, 3, 4
```

### Code

```go
func rightSideView(root *TreeNode) []int {
    result := []int{}
    if root == nil {
        return result
    }

    queue := []*TreeNode{root}
    for len(queue) > 0 {
        levelSize := len(queue)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]

            // The last node of the level is the one visible from the right.
            if i == levelSize-1 {
                result = append(result, node.Val)
            }

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
    }
    return result
}
```

```python
from collections import deque

def rightSideView(root):
    result = []
    if root is None:
        return result

    queue = deque([root])
    while queue:
        level_size = len(queue)
        for i in range(level_size):
            node = queue.popleft()
            if i == level_size - 1:      # last node of the level
                result.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
    return result
```

### Complexity
Time O(n), Space O(w).

> Swap `i == levelSize-1` for `i == 0` and you get the **left** side view. That interchangeability is the sign you've internalised the template: the BFS skeleton is fixed, and each problem is a single decision about what to do inside one level.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 102 | Level Order | Easy | Core trees application |
| 103 | Zigzag | Easy | Core trees application |
| 199 | Right Side View | Medium | Core trees application |
| 515 | Largest Per Row | Medium | Core trees application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Tree BFS logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Tree BFS (Trees).
- **Signal:** bfs, tree, level order, queue, breadth.
- **Move:** Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.
- **Cost:** O(n) time, O(h) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Tree BFS invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Tree BFS
FAMILY : Trees (Intermediate)
WHEN   : bfs, tree, level order, queue, breadth
DO     : Trees are recursive: solve children first, combine their results at the parent. 
TIME   : O(n)    SPACE: O(h)
PRACTICE: 102, 103, 199, 515
```

---

*Part of the DSA Patterns Handbook — pattern 54 of 100.*
