# 81 · DP on Grids

> **One-liner:** 2D DP accumulating optimal paths/areas across a grid.

---

## 1. Overview

### Definition
The **DP on Grids** pattern belongs to the *Dynamic Programming* family. 2D DP accumulating optimal paths/areas across a grid.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
grid dp, paths, min path sum, 2d dp, robot.

### Constraints
- Input size where the brute-force complexity would time out — the DP on Grids optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the DP on Grids invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — DP on Grids is the upgrade.
- The wording maps onto: grid dp, paths, min path sum, 2d dp, robot.

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
Redundant recomputation; does not exploit the structure the DP on Grids pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the DP on Grids invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr81" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
    <marker id="arr81a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Unique Paths: dp[i][j] = dp[i-1][j] + dp[i][j-1]</text>
  <rect x="250" y="52"  width="48" height="48" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="274" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="52"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="354" y="52"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="378" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="250" y="104" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="274" y="133" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="104" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="133" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="354" y="104" width="48" height="48" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="378" y="133" text-anchor="middle" font-weight="700" fill="#1e293b">3</text>
  <rect x="250" y="156" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="274" y="185" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="156" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="185" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="354" y="156" width="48" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="378" y="185" text-anchor="middle" font-weight="700" fill="#1e293b">6</text>
  <line x1="378" y1="80" x2="378" y2="102" stroke="#d97706" marker-end="url(#arr81a)"/>
  <line x1="328" y1="128" x2="352" y2="128" stroke="#d97706" marker-end="url(#arr81a)"/>
  <text x="472" y="124" fill="#d97706" font-weight="700">up 1 + left 2</text>
  <text x="472" y="142" fill="#64748b">= 3</text>
  <text x="274" y="228" text-anchor="middle" fill="#059669">start</text>
  <text x="378" y="228" text-anchor="middle" fill="#059669" font-weight="700">answer = 6</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
DP on Grids       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a DP on Grids problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | DP on Grids (Optimal) |
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

### Problem — Unique Paths (LeetCode 62)
Count the number of distinct paths a robot can take from the top-left to the bottom-right of an `m × n` grid, moving only right or down.

### Thought Process
1. Let `dp[i][j]` = number of paths reaching cell `(i, j)`. A cell is entered either from above or from the left, so `dp[i][j] = dp[i-1][j] + dp[i][j-1]`.
2. Base case: the first row and first column have exactly one path each (only rights, or only downs), so initialize them to 1.
3. Roll the 2D table down to a single row: `row[j] += row[j-1]` sweeps left-to-right, reusing the previous row in place.

### Dry Run
For `m=3, n=3`, start with `row = [1, 1, 1]` (top row).
- After row 2: `row[1]+=row[0]→2`, `row[2]+=row[1]→3` ⇒ `[1, 2, 3]`.
- After row 3: `row[1]→1+2=3`, `row[2]→3+3=6` ⇒ `[1, 3, 6]`.
- Answer = `row[-1] = 6` paths.

### Visualization
```
input  ──▶ [ fill dp[i][j] = dp[i-1][j] + dp[i][j-1] ]
state  ──▶ each cell = paths into it, built from top row/left column
output ──▶ dp[m-1][n-1]
```

### Code
```python
def uniquePaths(m, n):
    row = [1] * n                      # paths for the top row are all 1
    for _ in range(1, m):
        for j in range(1, n):
            row[j] += row[j - 1]       # from above (row[j]) + from left (row[j-1])
    return row[-1]
```

### Complexity
Time O(m·n), Space O(n) using a single rolling row.

## 10. Solved Example 2

### Problem — Min Path Sum (LeetCode 64)
Given an `m × n` grid of non-negative numbers, find a path from top-left to bottom-right, moving only right or down, that minimizes the sum of the numbers along the path.

### Thought Process
1. Let `dp[i][j]` = minimum sum to reach cell `(i, j)`. You arrive from above or from the left, so `dp[i][j] = grid[i][j] + min(dp[i-1][j], dp[i][j-1])`.
2. Seed the first row and first column as running prefix sums (only one way to reach them).
3. Compress to a rolling row: `row[j] = grid[i][j] + min(row[j] (above), row[j-1] (left))`.

### Dry Run
For `grid = [[1,3,1],[1,5,1],[4,2,1]]`, first row prefix ⇒ `row = [1, 4, 5]`.
- Row 1: `row[0]=1+1=2`; `row[1]=5+min(4,2)=7`; `row[2]=1+min(5,7)=6` ⇒ `[2, 7, 6]`.
- Row 2: `row[0]=2+4=6`; `row[1]=2+min(7,6)=8`; `row[2]=1+min(6,8)=7` ⇒ `[6, 8, 7]`.
- Answer = `row[-1] = 7` (path 1→3→1→1→1).

### Visualization
```
input  ──▶ [ dp[i][j] = grid[i][j] + min(top, left) ]
state  ──▶ each cell = cheapest cost to reach it
output ──▶ dp[m-1][n-1]
```

### Code
```python
def minPathSum(grid):
    m, n = len(grid), len(grid[0])
    row = [0] * n
    row[0] = grid[0][0]
    for j in range(1, n):              # first row: only move right
        row[j] = row[j - 1] + grid[0][j]
    for i in range(1, m):
        row[0] += grid[i][0]           # first column: only move down
        for j in range(1, n):
            row[j] = grid[i][j] + min(row[j], row[j - 1])
    return row[-1]
```

### Complexity
Time O(m·n), Space O(n) using a single rolling row.

## 11. Solved Example 3

### Problem — Triangle (LeetCode 120)
Given a triangle array, find the minimum path sum from top to bottom, where each step moves to an adjacent number on the row below (index `i` goes to `i` or `i+1`).

### Thought Process
1. Work bottom-up: let `dp[j]` = min path sum from cell `j` of the current row down to the base. The last row's values are their own totals.
2. For each higher row, `dp[j] = triangle[i][j] + min(dp[j], dp[j+1])`, since from `(i, j)` you may descend to `(i+1, j)` or `(i+1, j+1)`.
3. After processing the top row, `dp[0]` holds the answer, and one 1D array suffices.

### Dry Run
For `triangle = [[2],[3,4],[6,5,7],[4,1,8,3]]`, start `dp = [4, 1, 8, 3]` (last row).
- Row `[6,5,7]`: `dp=[6+min(4,1), 5+min(1,8), 7+min(8,3)] = [7, 6, 10]`.
- Row `[3,4]`: `dp=[3+min(7,6), 4+min(6,10)] = [9, 10]`.
- Row `[2]`: `dp=[2+min(9,10)] = [11]` ⇒ answer `11` (path 2→3→5→1).

### Visualization
```
input  ──▶ [ bottom-up: dp[j] = tri[i][j] + min(dp[j], dp[j+1]) ]
state  ──▶ dp shrinks by one each row toward the apex
output ──▶ dp[0]
```

### Code
```python
def minimumTotal(triangle):
    dp = triangle[-1][:]               # start from the bottom row
    for i in range(len(triangle) - 2, -1, -1):
        for j in range(len(triangle[i])):
            dp[j] = triangle[i][j] + min(dp[j], dp[j + 1])
    return dp[0]
```

### Complexity
Time O(n²) for a triangle of n rows, Space O(n) using one rolling array.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 62 | Unique Paths | Easy | Core dynamic programming application |
| 64 | Min Path Sum | Easy | Core dynamic programming application |
| 120 | Triangle | Medium | Core dynamic programming application |
| 221 | Maximal Square | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same DP on Grids logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** DP on Grids (Dynamic Programming).
- **Signal:** grid dp, paths, min path sum, 2d dp, robot.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the DP on Grids invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: DP on Grids
FAMILY : Dynamic Programming (Advanced)
WHEN   : grid dp, paths, min path sum, 2d dp, robot
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 62, 64, 120, 221
```

---

*Part of the DSA Patterns Handbook — pattern 81 of 100.*
