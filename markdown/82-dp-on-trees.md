# 82 · DP on Trees

> **One-liner:** States computed bottom-up per subtree; reroot for all-roots answers.

---

## 1. Overview

### Definition
The **DP on Trees** pattern belongs to the *Dynamic Programming* family. States computed bottom-up per subtree; reroot for all-roots answers.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
tree dp, rerooting, subtree dp, postorder, states.

### Constraints
- Input size where the brute-force complexity would time out — the DP on Trees optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the DP on Trees invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — DP on Trees is the upgrade.
- The wording maps onto: tree dp, rerooting, subtree dp, postorder, states.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the best I can do in this subtree, given a constraint that couples a node to its children?"*

Running example: rob a tree of houses for maximum money, but never two houses joined by an edge.

### Intuition
At every node there are two worlds: rob it, or don't. If you rob it, its children are off-limits, so you jump to the grandchildren. If you don't, you are free to solve both children normally. Try both worlds and keep the bigger number.

### Algorithm
1. `best(node)` = most money obtainable from the subtree rooted at `node`.
2. If `node` is nil, return 0.
3. **Rob it:** `node.val` + `best` of all four grandchildren.
4. **Skip it:** `best(node.left) + best(node.right)`.
5. Return the larger of the two.

### Complexity
- Time: **O(2^h)** on a balanced tree with height `h` — closer to exponential in the node count on a path-shaped tree.
- Space: O(h) recursion stack.

### Drawbacks
- Every subtree is solved twice, once from each of two different ancestors:

```text
best(A) --skip--> best(B)  --skip--> best(C)   ← C's subtree, visit #1
best(A) --rob---> best(C)                      ← C's subtree, visit #2

    A
    |
    B        A's "rob" branch jumps straight to C.
    |        A's "skip" branch reaches C through B.
    C        Both compute best(C) from scratch.
```

- The wasted work is structural: the recursion asks a node about its **grandchildren**, so it descends two levels at a time in one branch and one level at a time in the other, and the two descents overlap.
- What it fails to exploit: **a node only ever needs to know two facts about each child — the child's best answer if the child is used, and its best answer if it isn't.** Both facts are produced by the same single visit.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Visit the tree once in post-order, and have every node hand its parent a small tuple that already answers every question the parent could possibly ask about that subtree.**

Think of it as an org chart rolling numbers upward. A manager doesn't re-audit the whole department; each report submits a tiny summary — "here's my number if you use me, here's my number if you don't" — and the manager combines the summaries in constant time. Nobody is asked twice.

### The thought process

```text
We need    : an optimum over a tree with a parent/child constraint.
Obvious way: recurse, branching on "use this node or not".
Too slow   : the two branches descend at different speeds and overlap.
Notice     : a parent's decision depends on the child only through a couple
             of summary numbers, never on the child's internal structure.
Notice too : those numbers can all be produced during one visit to the child.
Therefore  : return a TUPLE from each node instead of a single number.
Now        : one post-order traversal, O(1) work per node -> O(n) total.
```

### Why a single number is not enough

Suppose each node returned only `best(subtree)`. Take this chain, where the parent `P` is deciding:

```text
P (val 2)
|
B (val 5)          best(B) = 5   -- achieved by ROBBING B
|
C (val 4)          best(C) = 4
```

`P` wants to rob itself, so it needs "B's best **given B is not robbed**", which is 4. But the number it was handed is 5, and 5 is unusable — adding it would rob two adjacent houses. A single number tells the parent *how good* the child can be, not *whether that goodness is still legal*. The parent's only recourse is to descend again to the grandchildren, which is exactly the brute force.

Return both numbers and the ambiguity disappears:

```text
C returns (rob = 4, skip = 0)
B returns (rob = 5 + C.skip = 5,  skip = max(C.rob, C.skip) = 4)
P returns (rob = 2 + B.skip = 6,  skip = max(B.rob, B.skip) = 5)
answer = max(6, 5) = 6
```

The rule generalises: **the tuple must contain one entry per "mode" the parent can put this node in.** Two modes for house robbing (used / unused). Three for camera placement (has a camera / covered without one / still uncovered). One for max-path-sum, plus a side-channel global (see below).

### Why post-order, and never anything else

The recurrence for a node is written purely in terms of its children's tuples, so a node is only computable once **both** children are final. Post-order — left subtree, right subtree, *then* the node — is exactly the order that guarantees that. Pre-order or level-order would ask a parent to combine tuples that do not exist yet.

Concretely, in code, the shape is always:

```text
tuple := dfs(node.left)      ← must come first
other := dfs(node.right)     ← must come first
combine(node, tuple, other)  ← only now is the node decidable
```

> **One extra idea: the global side-channel.** Sometimes the best answer is *not* the value a node returns upward. In max-path-sum a path may bend at a node and use both children — but such a bent path cannot be extended by the parent, so it must not be returned. The fix is to *record* the bent value into a running maximum and *return* the straight one. Recording locally while returning something else is a normal, correct tree-DP move.

### Steps

```text
Step 1 → Name the modes a parent can force on a child. That list IS the tuple.
Step 2 → Write, in English, what each tuple entry means for one subtree.
Step 3 → Base case: what should nil return so that a leaf behaves correctly?
Step 4 → Combine: express the node's tuple from the two children's tuples.
Step 5 → If some answer cannot be returned upward, record it in a global.
Step 6 → Answer = a function of the root's tuple (and the global, if used).
```

### How should I recognize this?

```text
If you see...
  a tree (or a general graph with no cycles) and a rule that links a node
  to its parent/children: "no two adjacent", "cover every node",
  "path through the tree", "subtree sum / count"
        ↓
Think about...
  "What would my parent need to know about me?"
  If the answer is more than one number, that's your tuple.
        ↓
Use...
  post-order DFS returning a tuple
  independent set / robbery -> (include, exclude)
  covering / matching       -> (has, covered, uncovered)
  best path                 -> return the best single arm, record the bend
```

### Visual explanation

```svg
<svg viewBox="0 0 620 258" width="100%" height="258" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr82" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#059669"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Tree DP: each node returns {rob, skip}, combined bottom-up</text>
  <line x1="290" y1="82" x2="212" y2="150" stroke="#475569"/>
  <line x1="330" y1="82" x2="408" y2="150" stroke="#475569"/>
  <line x1="200" y1="150" x2="290" y2="90" stroke="#059669" marker-end="url(#arr82)"/>
  <line x1="420" y1="150" x2="330" y2="90" stroke="#059669" marker-end="url(#arr82)"/>
  <circle cx="310" cy="72" r="26" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="310" y="77" text-anchor="middle" font-weight="700" fill="#1e293b">3</text>
  <circle cx="190" cy="168" r="24" fill="#eff6ff" stroke="#2563eb"/><text x="190" y="173" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="430" cy="168" r="24" fill="#eff6ff" stroke="#2563eb"/><text x="430" y="173" text-anchor="middle" fill="#1e293b">5</text>
  <text x="150" y="210" text-anchor="middle" fill="#64748b">{rob 4, skip 0}</text>
  <text x="470" y="210" text-anchor="middle" fill="#64748b">{rob 5, skip 0}</text>
  <text x="310" y="120" text-anchor="middle" fill="#64748b">rob = 3 + skipL + skipR = 3</text>
  <text x="310" y="137" text-anchor="middle" fill="#64748b">skip = max(4,0) + max(5,0) = 9</text>
  <text x="310" y="238" text-anchor="middle" fill="#059669" font-weight="700">answer = max(rob, skip) = 9</text>
</svg>
```

```text
House robbing on a tiny tree. Each node returns (rob, skip).

              3                (rob = 3 + 3 + 1 = 7,  skip = 3 + 3 = 6)
             / \                                              answer 7
            /   \
     (2,3) 2     3 (3,1)
            \     \
             3     1
          (3,0)   (1,0)

reading it bottom-up:

  leaf 3 -> (rob 3, skip 0)      a leaf robbed is its own value
  leaf 1 -> (rob 1, skip 0)

  node 2 -> rob  = 2 + 0        (child must be skipped)
            skip = max(3, 0) = 3 (child free to be robbed)

  node 3 -> rob  = 3 + 0 = 3
            skip = max(1, 0) = 1

  root 3 -> rob  = 3 + skip(2) + skip(3) = 3 + 3 + 1 = 7   <-- winner
            skip = max(2,3) + max(3,1)   = 3 + 3     = 6
```

### Interview explanation
"This is tree DP. The trick is that a node's parent doesn't need the child's whole subtree — it only needs a couple of summary numbers, one for each mode the parent can force the child into. For house robbing that's two numbers: the best money if we rob this node, and the best if we don't. So the DFS returns a pair instead of a single integer. If we rob a node, we must add each child's *skip* value; if we don't, each child contributes the better of its two values. Base case is nil returning `(0, 0)`. It has to be post-order, because a node's pair is defined entirely in terms of its children's pairs. That's one visit per node with O(1) combining work, so O(n) time and O(h) stack space for the recursion."

---

## 5. Generic Templates

> Post-order DFS. Each node returns a tuple — one entry per mode its parent can put it in.

```go
// TreeNode is the usual binary tree node.
type TreeNode struct {
    Val         int
    Left, Right *TreeNode
}

// MaxIndependentSet is the include/exclude skeleton: pick a maximum-weight set
// of nodes with no two of them adjacent.
// dfs returns (use, skip):
//   use  = best total for this subtree when THIS node is taken
//   skip = best total for this subtree when this node is NOT taken
func MaxIndependentSet(root *TreeNode) int {
    var dfs func(*TreeNode) (int, int)
    dfs = func(node *TreeNode) (int, int) {
        if node == nil {
            return 0, 0 // an absent subtree contributes nothing either way
        }
        leftUse, leftSkip := dfs(node.Left)   // children first: post-order
        rightUse, rightSkip := dfs(node.Right)

        use := node.Val + leftSkip + rightSkip // taking me forbids my children
        skip := max(leftUse, leftSkip) + max(rightUse, rightSkip)
        return use, skip
    }

    use, skip := dfs(root)
    return max(use, skip)
}

// BestArmSum is the "return one arm, record the bend" skeleton.
// dfs returns the best sum of a path that starts at the node and descends into
// AT MOST ONE child, so a parent can extend it. The best bent path (using both
// children) can never be extended, so it is recorded in a global instead.
func BestArmSum(root *TreeNode) int {
    best := -1 << 62 // sentinel: smaller than any real path sum

    var arm func(*TreeNode) int
    arm = func(node *TreeNode) int {
        if node == nil {
            return 0 // an empty arm adds nothing
        }
        left := max(arm(node.Left), 0)   // a negative arm is better dropped
        right := max(arm(node.Right), 0)

        best = max(best, node.Val+left+right) // path BENDING here: record only
        return node.Val + max(left, right)    // path passing THROUGH: return
    }

    arm(root)
    return best
}
```

```python
class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right


def max_independent_set(root):
    """Include/exclude skeleton. dfs returns (use, skip) for each subtree."""
    def dfs(node):
        if node is None:
            return (0, 0)                     # absent subtree: nothing either way
        left_use, left_skip = dfs(node.left)      # children first: post-order
        right_use, right_skip = dfs(node.right)

        use = node.val + left_skip + right_skip   # taking me forbids my children
        skip = max(left_use, left_skip) + max(right_use, right_skip)
        return (use, skip)

    return max(dfs(root))


def best_arm_sum(root):
    """Return one arm upward, record the bend in a global."""
    best = float('-inf')

    def arm(node):
        nonlocal best
        if node is None:
            return 0                          # empty arm adds nothing
        left = max(arm(node.left), 0)         # drop negative arms
        right = max(arm(node.right), 0)

        best = max(best, node.val + left + right)   # bends here: record only
        return node.val + max(left, right)          # passes through: return

    arm(root)
    return best
```

```java
class TreeNode {
    int val;
    TreeNode left, right;
    TreeNode(int val) { this.val = val; }
}

public class TreeDP {
    // Include/exclude skeleton: dfs returns {use, skip} for each subtree.
    public static int maxIndependentSet(TreeNode root) {
        int[] r = dfsIndep(root);
        return Math.max(r[0], r[1]);
    }

    private static int[] dfsIndep(TreeNode node) {
        if (node == null) return new int[]{0, 0};   // absent subtree
        int[] l = dfsIndep(node.left);              // children first
        int[] r = dfsIndep(node.right);

        int use = node.val + l[1] + r[1];           // taking me forbids children
        int skip = Math.max(l[0], l[1]) + Math.max(r[0], r[1]);
        return new int[]{use, skip};
    }

    // "Return one arm, record the bend" skeleton.
    private static int best;

    public static int bestArmSum(TreeNode root) {
        best = Integer.MIN_VALUE;
        arm(root);
        return best;
    }

    private static int arm(TreeNode node) {
        if (node == null) return 0;                 // empty arm adds nothing
        int left = Math.max(arm(node.left), 0);     // drop negative arms
        int right = Math.max(arm(node.right), 0);

        best = Math.max(best, node.val + left + right);  // bend: record only
        return node.val + Math.max(left, right);         // through: return
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <utility>
using namespace std;

struct TreeNode {
    int val;
    TreeNode *left, *right;
    TreeNode(int v) : val(v), left(nullptr), right(nullptr) {}
};

// Include/exclude skeleton: returns {use, skip} for each subtree.
pair<int, int> dfsIndep(TreeNode* node) {
    if (!node) return {0, 0};                       // absent subtree
    auto l = dfsIndep(node->left);                  // children first
    auto r = dfsIndep(node->right);

    int use = node->val + l.second + r.second;      // taking me forbids children
    int skip = max(l.first, l.second) + max(r.first, r.second);
    return {use, skip};
}

int maxIndependentSet(TreeNode* root) {
    auto r = dfsIndep(root);
    return max(r.first, r.second);
}

// "Return one arm, record the bend" skeleton.
int arm(TreeNode* node, int& best) {
    if (!node) return 0;                            // empty arm adds nothing
    int left = max(arm(node->left, best), 0);       // drop negative arms
    int right = max(arm(node->right, best), 0);

    best = max(best, node->val + left + right);     // bend: record only
    return node->val + max(left, right);            // through: return
}

int bestArmSum(TreeNode* root) {
    int best = INT_MIN;
    arm(root, best);
    return best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | DP on Trees (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(states × transitions)** |
| Time (best)  | — | **O(states × transitions)** |
| Time (average) | — | **O(states × transitions)** |
| Space | varies | **O(states)** |

> Each state computed once; space often reducible to a rolling row.

---

## 7. Common Mistakes

1. Wrong loop direction (0/1 needs reverse; unbounded needs forward).
2. Ill-defined state that doesn't capture all needed information.
3. Incorrect base cases.
4. Off-by-one in dimensions (use size n+1 frequently).
5. Forgetting to initialize unreachable states to ±infinity.
6. Memoization key collisions / missing dimensions.
7. Recomputing instead of reading the memo.
8. Space-optimizing prematurely and breaking the recurrence.
9. Integer overflow on counts/sums.
10. Not reconstructing the solution when the problem asks for it.

---

## 8. Interview Follow-Up Questions

1. **Q: Top-down vs bottom-up?**
   A: Memoized recursion vs iterative table; same complexity, different constants/stack use.

2. **Q: How to find the state?**
   A: Identify the minimal info to make a decision and recurse.

3. **Q: 0/1 vs unbounded knapsack?**
   A: 0/1 iterates capacity in reverse; unbounded forward (reuse).

4. **Q: Space optimization?**
   A: Keep only the previous row(s) you depend on.

5. **Q: Reconstruct the answer?**
   A: Store choices or backtrack through the table.

6. **Q: LIS in O(n log n)?**
   A: Patience sorting with binary search.

7. **Q: LCS / edit distance?**
   A: 2D grid DP aligning two sequences.

8. **Q: Coin change (min vs ways)?**
   A: Min-coins vs count-ways differ in init and loop order.

9. **Q: Why overlapping subproblems matter?**
   A: They make memoization pay off (vs divide & conquer).

10. **Q: Tree DP?**
   A: Combine children's states post-order; reroot for all-roots.

11. **Q: Bitmask DP?**
   A: Encode subsets as bitmasks for ≤20 elements.

12. **Q: State machine DP?**
   A: Model hold/sell/cooldown states (stock problems).

13. **Q: Digit DP?**
   A: Count numbers with a tight-bound flag over digits.

14. **Q: Interval DP?**
   A: dp[i][j] over a range, split at k (matrix chain, burst balloons).

15. **Q: Prove correctness?**
   A: Show optimal substructure and a correct recurrence.

---

## 9. Solved Example 1

### Problem — House Robber III (LeetCode 337)
Houses are arranged as a binary tree. Robbing two directly-connected houses (a parent and its child) triggers the alarm. Return the maximum money you can rob.

### Thought Process
1. **What does the state mean?** `dfs(node)` returns a pair `(rob, skip)`.
   `rob` = *the most money obtainable from the subtree rooted at `node`, in the world where we do rob `node` itself.*
   `skip` = *the most money obtainable from that same subtree, in the world where we do not rob `node`.*
2. **How do we compute it?** If we rob `node`, both children become illegal, so each child may only contribute its `skip`: `rob = node.Val + left.skip + right.skip`. If we don't rob `node`, each child is unconstrained and contributes whichever of its two worlds is larger: `skip = max(left.rob, left.skip) + max(right.rob, right.skip)`.
3. **What is the base case?** `nil → (0, 0)`. An absent subtree yields nothing whether or not you "rob" it. This makes a leaf fall out correctly: `rob = val + 0 + 0 = val`, `skip = 0`.
4. **Why post-order?** A node's pair is written purely in terms of its children's pairs, so both children must be finished first. Left, right, then combine — never any other order.
5. Answer is `max(rob, skip)` at the root: the root is free to be robbed or not.

### Dry Run

Input:
```text
      3
     / \
    2   3
     \    \
      3    1
```

Post-order visit order: the leaf `3`, then node `2`, then the leaf `1`, then the right `3`, then the root.

| node | left pair | right pair | `rob` = val + L.skip + R.skip | `skip` = max(L) + max(R) | returns |
|------|-----------|------------|-------------------------------|---------------------------|---------|
| leaf `3` | (0,0) | (0,0) | `3 + 0 + 0` = **3** | `0 + 0` = **0** | (3, 0) |
| `2` | (0,0) | (3,0) | `2 + 0 + 0` = **2** | `0 + max(3,0)` = **3** | (2, 3) |
| leaf `1` | (0,0) | (0,0) | `1 + 0 + 0` = **1** | `0 + 0` = **0** | (1, 0) |
| right `3` | (0,0) | (1,0) | `3 + 0 + 0` = **3** | `0 + max(1,0)` = **1** | (3, 1) |
| root `3` | (2,3) | (3,1) | `3 + 3 + 1` = **7** | `max(2,3) + max(3,1)` = `3 + 3` = **6** | (7, 6) |

Output: **7** — rob the root (3) plus both grandchildren (3 and 1).

Notice node `2`: its `skip` (3) beats its `rob` (2). The root then used that `skip = 3` when robbing itself. Had the child returned only the single number "best = 3", the root could not have known that the 3 came from the *grandchild* and was therefore still legal — that ambiguity is exactly what the pair removes.

### Visualization

```text
each node hands its parent a pair (rob, skip)

              3  (7, 6)
             / \
    (2,3)   2   3   (3,1)
             \   \
      (3,0)   3   1  (1,0)

the two worlds at the root, drawn:

  world "rob the root"          world "skip the root"
        [3]                            3
        / \                           / \
       2   3      forbidden          [2] [3]     free choice per child
        \   \                          \   \
       [3] [1]    grandchildren ok      3   1     (but then 3 and 1 are out
                                                   of reach via those parents)
    3 + 3 + 1 = 7   <-- winner      3 + 3 = 6
```

### Code

```go
// rob returns the maximum money robbable from a binary tree of houses without
// taking two directly-connected houses.
// dfs returns (robHere, skipHere) for the subtree rooted at node.
func rob(root *TreeNode) int {
    var dfs func(*TreeNode) (int, int)
    dfs = func(node *TreeNode) (int, int) {
        if node == nil {
            return 0, 0 // absent subtree pays nothing either way
        }

        leftRob, leftSkip := dfs(node.Left)    // post-order: children first
        rightRob, rightSkip := dfs(node.Right)

        // Robbing this node forbids both children -> use their skip values.
        robHere := node.Val + leftSkip + rightSkip
        // Skipping it leaves each child free to do whatever is best for it.
        skipHere := max(leftRob, leftSkip) + max(rightRob, rightSkip)

        return robHere, skipHere
    }

    robRoot, skipRoot := dfs(root)
    return max(robRoot, skipRoot)
}
```

```python
def rob(root):
    def dfs(node):
        """Return (rob_here, skip_here) for the subtree rooted at node."""
        if node is None:
            return (0, 0)                    # absent subtree pays nothing

        left_rob, left_skip = dfs(node.left)      # post-order: children first
        right_rob, right_skip = dfs(node.right)

        # Robbing this node forbids both children -> use their skip values.
        rob_here = node.val + left_skip + right_skip
        # Skipping it leaves each child free to pick its own best.
        skip_here = max(left_rob, left_skip) + max(right_rob, right_skip)

        return (rob_here, skip_here)

    return max(dfs(root))
```

### Complexity
Time O(n) — every node is visited exactly once and does O(1) combining work. Space O(h) for the recursion stack, where `h` is the tree height (O(log n) balanced, O(n) for a degenerate chain).

---

## 10. Solved Example 2

### Problem — Binary Tree Cameras (LeetCode 968)
Place cameras on nodes so that every node is monitored. A camera on a node watches that node, its parent, and its direct children. Return the minimum number of cameras.

### Thought Process
1. **What does the state mean?** `dfs(node)` returns one of three labels describing the subtree *after* it has been optimally handled:
   `UNCOVERED` — *`node` has no camera and nothing in its subtree watches it; its parent must take care of it.*
   `COVERED` — *`node` is watched by a camera somewhere in its subtree, but `node` itself has no camera, so it offers its parent nothing.*
   `HAS_CAMERA` — *`node` holds a camera, so it also watches its parent.*
2. **How do we compute it?** Look at the two children's labels, in this priority:
   - If **either child is `UNCOVERED`**, nobody else can ever reach that child, so a camera must go here → count it and return `HAS_CAMERA`.
   - Else if **either child has a camera**, this node is already watched → return `COVERED`.
   - Else (both children covered but camera-less) nothing is watching this node → return `UNCOVERED` and let the parent handle it.
3. **What is the base case?** `nil → COVERED`. This is the one design decision in the problem. `nil` needs no camera, so it must not be reported `UNCOVERED`; if it were, every leaf would see an uncovered child and place a camera on itself. Reporting `COVERED` instead makes a leaf return `UNCOVERED`, which pushes its camera up to the parent — where it also covers a sibling and a grandparent. **Cameras belong one level above the leaves**, and that fact is encoded entirely in the nil base case.
4. **Why post-order?** You cannot decide whether a node needs a camera until you know whether either child was left uncovered. Strictly children first.
5. After the traversal, if the **root** comes back `UNCOVERED`, it has no parent to save it — add one more camera.

### Dry Run

Input (LeetCode's first example):
```text
      A
     /
    B
   / \
  C   D
```

| visit | node | left label | right label | rule fired | returns | cameras |
|-------|------|------------|-------------|------------|---------|---------|
| 1 | `C` | `COVERED` (nil) | `COVERED` (nil) | neither child uncovered, neither has a camera | `UNCOVERED` | 0 |
| 2 | `D` | `COVERED` (nil) | `COVERED` (nil) | same | `UNCOVERED` | 0 |
| 3 | `B` | `UNCOVERED` | `UNCOVERED` | a child is uncovered → place a camera | `HAS_CAMERA` | **1** |
| 4 | `A` | `HAS_CAMERA` | `COVERED` (nil) | no uncovered child; a child holds a camera | `COVERED` | 1 |

Root returned `COVERED`, so no extra camera is needed.

Output: **1**

Row 3 is the whole algorithm: the camera lands on `B`, not on `C` or `D`, and from `B` it covers `B`, `C`, `D` **and** `A` — four nodes for one camera. That leverage is only available because nil reported `COVERED` and let the leaves say "not my job".

### Visualization

```text
labels flowing upward             what one camera at B covers

      A  COVERED                        A   <- covered as B's parent
     /                                 /
    B  HAS_CAMERA  <- placed here     [B]  <- the camera
   / \                                / \
  C   D   both UNCOVERED             C   D <- covered as B's children
 / \ / \
nil ... all COVERED

if nil returned UNCOVERED instead:

    C and D would each place their own camera  -> 2 cameras
    A would still be uncovered                 -> 3 cameras total
    ...versus 1. The base case IS the optimisation.
```

### Code

```go
// minCameraCover returns the fewest cameras needed so that every node is
// watched; a camera watches its own node, its parent and its children.
func minCameraCover(root *TreeNode) int {
    const (
        uncovered = 0 // no camera here, and nothing watches me: parent must act
        covered   = 1 // watched from below, but I hold no camera
        hasCamera = 2 // I hold a camera, so I also watch my parent
    )

    cameras := 0

    var dfs func(*TreeNode) int
    dfs = func(node *TreeNode) int {
        if node == nil {
            return covered // nil needs nothing; this keeps cameras off leaves
        }

        left := dfs(node.Left) // post-order: children decide first
        right := dfs(node.Right)

        if left == uncovered || right == uncovered {
            cameras++ // nobody else can ever reach that child
            return hasCamera
        }
        if left == hasCamera || right == hasCamera {
            return covered // a child's camera reaches up to me
        }
        return uncovered // both children fine, but nothing watches me
    }

    if dfs(root) == uncovered {
        cameras++ // the root has no parent to rescue it
    }
    return cameras
}
```

```python
def minCameraCover(root):
    UNCOVERED, COVERED, HAS_CAMERA = 0, 1, 2
    cameras = 0

    def dfs(node):
        nonlocal cameras
        if node is None:
            return COVERED               # nil needs nothing; keeps cameras off leaves

        left = dfs(node.left)            # post-order: children decide first
        right = dfs(node.right)

        if left == UNCOVERED or right == UNCOVERED:
            cameras += 1                 # nobody else can reach that child
            return HAS_CAMERA
        if left == HAS_CAMERA or right == HAS_CAMERA:
            return COVERED               # a child's camera reaches up to me
        return UNCOVERED                 # children fine, but nothing watches me

    if dfs(root) == UNCOVERED:
        cameras += 1                     # the root has no parent
    return cameras
```

### Complexity
Time O(n) — one visit per node, constant work each. Space O(h) recursion stack.

---

## 11. Solved Example 3

### Problem — Binary Tree Maximum Path Sum (LeetCode 124)
A path is any sequence of nodes connected by edges; it need not touch the root, and it must contain at least one node. Return the maximum sum of node values along any path.

### Thought Process
1. **What does the state mean?** `arm(node)` returns *the largest sum of a path that starts at `node` and goes strictly downward, entering at most one child.* Call it the node's best "arm" — the piece a parent could grab and extend.
2. **How do we compute it?** Let `left = max(arm(node.Left), 0)` and `right = max(arm(node.Right), 0)`. The clamp to `0` says "a negative arm is worse than no arm at all" — a path is always allowed to stop at the node. Then `arm(node) = node.Val + max(left, right)`.
3. **What about the answer?** The best path *through* `node` may bend, using both arms: `node.Val + left + right`. But a bent path cannot be extended by the parent — the parent would create a fork with three edges at `node`, which is not a path. So the bent value is **recorded** into a running global maximum and **not returned**. Returning one arm while recording the bend is the crux of the problem.
4. **What is the base case?** `nil → 0`: an empty arm contributes nothing. Note the global starts at negative infinity, not `0` — an all-negative tree must be allowed to answer with a negative number.
5. **Why post-order?** Both arms must be final before the node's bend can be evaluated or its own arm returned.

### Dry Run

Input:
```text
     -10
     /  \
    9    20
        /  \
      15    7
```

Post-order visit order: `9`, `15`, `7`, `20`, `-10`. Global `best` starts at `-inf`.

| visit | node | `left` (clamped) | `right` (clamped) | bend = `val + left + right` | new `best` | returns `val + max(left,right)` |
|-------|------|------------------|--------------------|------------------------------|------------|-----------------------------------|
| 1 | `9`   | 0 | 0 | `9 + 0 + 0` = 9 | **9** | `9 + 0` = 9 |
| 2 | `15`  | 0 | 0 | `15 + 0 + 0` = 15 | **15** | `15 + 0` = 15 |
| 3 | `7`   | 0 | 0 | `7 + 0 + 0` = 7 | 15 | `7 + 0` = 7 |
| 4 | `20`  | 15 | 7 | `20 + 15 + 7` = **42** | **42** | `20 + max(15,7)` = 35 |
| 5 | `-10` | `max(9,0)` = 9 | `max(35,0)` = 35 | `-10 + 9 + 35` = 34 | 42 | `-10 + 35` = 25 |

Output: **42** — the path `15 → 20 → 7`.

Visit 4 is the money row: `20` records **42** for the bent path but only returns **35** upward. If it had returned 42, the root would have computed `-10 + 9 + 42`, describing a shape that visits `20` three times — not a path at all.

### Visualization

```text
     -10                arms returned upward        bends recorded
     /  \                 9  -> 9                     9  -> 9
    9    20              15  -> 15                   15  -> 15
        /  \              7  -> 7                     7  -> 7
      15    7            20  -> 35 (20+15)           20  -> 42 (15+20+7)  ★
                        -10  -> 25 (-10+35)         -10  -> 34

the winning path bends at 20:

      15 ──▶ 20 ──▶ 7          sum 42

what an arm looks like (extendable)   what a bend looks like (terminal)

        20                                  20
       /                                   /  \
     15                                  15    7
     (returned: 20 + 15 = 35)            (recorded: 42, never returned)
```

### Code

```go
// maxPathSum returns the largest sum over any node-to-node path in the tree.
// arm(node) = best downward path starting at node and using at most one child.
func maxPathSum(root *TreeNode) int {
    best := math.MinInt32 // must start below any real value: trees can be all-negative

    var arm func(*TreeNode) int
    arm = func(node *TreeNode) int {
        if node == nil {
            return 0 // an empty arm contributes nothing
        }

        left := arm(node.Left) // post-order: both arms first
        if left < 0 {
            left = 0 // a negative arm is worse than stopping here
        }
        right := arm(node.Right)
        if right < 0 {
            right = 0
        }

        // Path BENDING at this node uses both arms: record it, never return it.
        if bend := node.Val + left + right; bend > best {
            best = bend
        }

        // Path PASSING THROUGH toward the parent may use only one arm.
        return node.Val + max(left, right)
    }

    arm(root)
    return best
}
```

```python
def maxPathSum(root):
    best = float('-inf')          # trees can be entirely negative

    def arm(node):
        """Best downward path from node using at most one child."""
        nonlocal best
        if node is None:
            return 0                          # empty arm contributes nothing

        left = max(arm(node.left), 0)         # a negative arm is worth dropping
        right = max(arm(node.right), 0)

        best = max(best, node.val + left + right)   # bends here: record only
        return node.val + max(left, right)          # passes through: return

    arm(root)
    return best
```

### Complexity
Time O(n) — one visit per node with constant work. Space O(h) for the recursion stack.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 337 | House Robber III | Easy | Core dynamic programming application |
| 968 | Cameras | Easy | Core dynamic programming application |
| 124 | Max Path | Medium | Core dynamic programming application |
| 834 | Sum Distances | Medium | Core dynamic programming application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **0/1 & unbounded knapsack**
- **Subset sum / partition**
- **LIS / LCS**
- **Grid / string DP**
- **Tree / bitmask / digit / state-machine DP**

---

## 14. Production Engineering Applications

- **Scalability:** DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(states)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same DP on Trees logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** DP on Trees (Dynamic Programming).
- **Signal:** tree dp, rerooting, subtree dp, postorder, states.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the DP on Trees invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: DP on Trees
FAMILY : Dynamic Programming (Expert)
WHEN   : tree dp, rerooting, subtree dp, postorder, states
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 337, 968, 124, 834
```

---

*Part of the DSA Patterns Handbook — pattern 82 of 100.*
