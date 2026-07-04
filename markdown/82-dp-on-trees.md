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

### Intuition
Naive recursion recomputes overlapping subproblems — exponential time.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the DP on Trees pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the DP on Trees invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
DP on Trees       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a DP on Trees problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Dynamic Programming** family template. Adapt the comparison/condition to the specific problem.

```go
// 0/1 Knapsack, space-optimized to 1D. dp[w] = best value at capacity w.
func knapsack(weights, values []int, cap int) int {
    dp := make([]int, cap+1)
    for i := range weights {
        for w := cap; w >= weights[i]; w-- {  // reverse: each item once
            if dp[w-weights[i]]+values[i] > dp[w] {
                dp[w] = dp[w-weights[i]] + values[i]
            }
        }
    }
    return dp[cap]
}
```

```python
def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]
```

```java
int knapsack(int[] weights, int[] values, int cap) {
    int[] dp = new int[cap + 1];
    for (int i = 0; i < weights.length; i++)
        for (int w = cap; w >= weights[i]; w--)
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
}
```

```cpp
int knapsack(vector<int>& weights, vector<int>& values, int cap) {
    vector<int> dp(cap + 1, 0);
    for (size_t i = 0; i < weights.size(); ++i)
        for (int w = cap; w >= weights[i]; --w)
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
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
Rob a binary tree of houses for maximum money, but you cannot rob two directly-connected (parent–child) nodes.

### Thought Process
1. For each node, the choice depends on whether we rob it. Return **two** values per subtree: `rob` (max money if we DO rob this node) and `notRob` (max if we don't).
2. If we rob a node: add `node.val` plus each child's `notRob` (children must be skipped).
3. If we don't rob it: each child contributes `max(childRob, childNotRob)` — free to pick the better option.
4. Post-order DFS bubbles these pairs up; the answer is `max(rob, notRob)` at the root.

### Dry Run
Tree: root=3, left=2 (leaf), right=3 (leaf).
- Leaf 2 → (rob=2, notRob=0); leaf 3 → (rob=3, notRob=0).
- Root: rob = 3 + 0 + 0 = 3; notRob = max(2,0) + max(3,0) = 5.
- Answer = max(3, 5) = **5** (rob the two children, skip root).

### Visualization
```
each node ──▶ returns (rob, notRob)
rob     = node.val + left.notRob + right.notRob
notRob  = max(left) + max(right)
answer  = max(rob, notRob) at root
```

### Code
```python
def rob(self, root):
    def dfs(node):
        if not node:
            return (0, 0)                       # (rob, notRob)
        l_rob, l_not = dfs(node.left)
        r_rob, r_not = dfs(node.right)
        rob_here = node.val + l_not + r_not     # rob node -> skip children
        skip_here = max(l_rob, l_not) + max(r_rob, r_not)
        return (rob_here, skip_here)
    return max(dfs(root))
```

### Complexity
Time O(n) — each node visited once; Space O(h) recursion stack (h = tree height).

## 10. Solved Example 2

### Problem — Binary Tree Cameras (LeetCode 968)
Place the minimum number of cameras on tree nodes so every node is monitored; a camera covers its parent, itself, and its direct children.

### Thought Process
1. Greedy post-order DFS with three states per node: `0` = not covered, `1` = covered (no camera), `2` = has a camera.
2. Push cameras as high as possible: only place one when a child is uncovered — leaves should never hold cameras.
3. If any child returns `0` (uncovered), this node MUST hold a camera → return `2` and increment count.
4. Else if any child has a camera (`2`), this node is covered → return `1`; otherwise it is uncovered → return `0`. A `null` node returns `1` (covered) so leaves report uncovered.

### Dry Run
Tree: root=0, root.left=0, root.left.left=0 (a left-leaning chain of 3).
- Deepest leaf → children are null (`1`,`1`) → node is uncovered → returns `0`.
- Its parent sees a child `0` → places camera, count=1, returns `2`.
- Root sees child `2` → covered → returns `1`. Root itself covered by that camera.
- Answer = **1** camera.

### Visualization
```
null      ──▶ 1 (treated as covered)
child==0  ──▶ place camera here, return 2  (count++)
child==2  ──▶ covered by child, return 1
else      ──▶ uncovered, return 0 (parent must cover)
```

### Code
```python
def minCameraCover(self, root):
    self.count = 0
    NOT_COVERED, COVERED, CAMERA = 0, 1, 2

    def dfs(node):
        if not node:
            return COVERED                       # null is fine, needs no camera
        l = dfs(node.left)
        r = dfs(node.right)
        if l == NOT_COVERED or r == NOT_COVERED:
            self.count += 1
            return CAMERA
        if l == CAMERA or r == CAMERA:
            return COVERED
        return NOT_COVERED

    return self.count + (1 if dfs(root) == NOT_COVERED else 0)
```

### Complexity
Time O(n) — one post-order pass; Space O(h) recursion stack (h = tree height).

## 11. Solved Example 3

### Problem — Binary Tree Maximum Path Sum (LeetCode 124)
Find the maximum sum of any path in a binary tree, where a path is any node sequence connected by edges (need not pass through the root).

### Thought Process
1. Each node's DFS returns the best **downward gain**: `node.val + max(0, leftGain, rightGain)` — a straight path extending into at most one child.
2. Clamp negative child gains to `0`, since a path can always drop a harmful branch.
3. The best path *through* a node bends: `node.val + leftGain + rightGain` (uses both children). Update a global `max` with this at every node.
4. Return the one-sided gain upward so the parent can extend a valid single path.

### Dry Run
Tree: root=-10, left=9, right=20 (20.left=15, 20.right=7).
- Leaves 9,15,7 → gains 9,15,7.
- Node 20: through = 20+15+7 = 42 → update global; returns 20+15 = 35.
- Root -10: through = -10+9+35 = 34; global stays **42**.
- Answer = **42** (path 15→20→7).

### Visualization
```
gain(node)  = node.val + max(0, gain(left), gain(right))   # extend upward
through     = node.val + max(0,gain(left)) + max(0,gain(right))  # bend here
best        = max over all nodes of `through`
```

### Code
```python
def maxPathSum(self, root):
    self.best = float('-inf')

    def gain(node):
        if not node:
            return 0
        l = max(gain(node.left), 0)     # drop negative branches
        r = max(gain(node.right), 0)
        self.best = max(self.best, node.val + l + r)   # path bending at node
        return node.val + max(l, r)     # extend one side upward

    gain(root)
    return self.best
```

### Complexity
Time O(n) — each node visited once; Space O(h) recursion stack (h = tree height).


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
