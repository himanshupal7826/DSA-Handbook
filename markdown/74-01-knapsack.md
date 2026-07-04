# 74 · 0/1 Knapsack

> **One-liner:** Take-or-skip DP over items and capacity; each item used once.

---

## 1. Overview

### Definition
The **0/1 Knapsack** pattern belongs to the *Dynamic Programming* family. Take-or-skip DP over items and capacity; each item used once.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
knapsack, 01, dp, capacity, weight value, take skip.

### Constraints
- Input size where the brute-force complexity would time out — the 0/1 Knapsack optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the 0/1 Knapsack invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — 0/1 Knapsack is the upgrade.
- The wording maps onto: knapsack, 01, dp, capacity, weight value, take skip.

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
Redundant recomputation; does not exploit the structure the 0/1 Knapsack pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the 0/1 Knapsack invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 660 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ak-74" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">0/1 Knapsack table: dp[i][w] = max(skip dp[i-1][w], take dp[i-1][w-wt]+val)</text>
  <text x="95" y="46" text-anchor="middle" fill="#64748b">item \ w</text>
  <text x="172" y="46" text-anchor="middle" fill="#64748b">0</text>
  <text x="216" y="46" text-anchor="middle" fill="#64748b">1</text>
  <text x="260" y="46" text-anchor="middle" fill="#64748b">2</text>
  <text x="304" y="46" text-anchor="middle" fill="#64748b">3</text>
  <text x="348" y="46" text-anchor="middle" fill="#64748b">4</text>
  <text x="392" y="46" text-anchor="middle" fill="#64748b">5</text>
  <text x="95" y="78" text-anchor="middle" fill="#1e293b">none</text>
  <text x="95" y="116" text-anchor="middle" fill="#1e293b">w2,v3</text>
  <text x="95" y="154" text-anchor="middle" fill="#1e293b">w3,v4</text>
  <rect x="150" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="172" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="194" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="216" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="238" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="260" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="282" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="304" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="326" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="348" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="370" y="54" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="392" y="78" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="150" y="92" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="172" y="116" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="194" y="92" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="216" y="116" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="238" y="92" width="44" height="38" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="260" y="116" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="282" y="92" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="304" y="116" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="326" y="92" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="348" y="116" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="370" y="92" width="44" height="38" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="392" y="116" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="150" y="130" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="172" y="154" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="194" y="130" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="216" y="154" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="238" y="130" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="260" y="154" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="282" y="130" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="304" y="154" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="326" y="130" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="348" y="154" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="370" y="130" width="44" height="38" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="392" y="154" text-anchor="middle" fill="#1e293b" font-weight="700">7</text>
  <line x1="392" y1="111" x2="392" y2="140" stroke="#475569" marker-end="url(#ak-74)"/>
  <line x1="262" y1="119" x2="376" y2="143" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#ak-74)"/>
  <text x="408" y="108" text-anchor="middle" fill="#64748b">skip</text>
  <text x="300" y="120" text-anchor="middle" fill="#64748b">take</text>
  <text x="330" y="200" text-anchor="middle" fill="#059669" font-weight="700">dp[2][5] = max(skip 3, take dp[1][2]+4 = 7) = 7  answer</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
0/1 Knapsack      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a 0/1 Knapsack problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | 0/1 Knapsack (Optimal) |
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

### Problem — Partition Equal (LeetCode 416)
Split the array into two equal-sum halves. Reduces to: can any subset reach `sum // 2`? That is a 0/1 subset-sum knapsack where each number is used at most once.

### Thought Process
1. If the total sum is odd, no equal split exists — return False immediately.
2. Set `target = sum // 2`; a boolean `dp[j]` means "sum `j` is reachable by some subset."
3. For each number iterate `j` **downward** from `target` to `num`, so each number is counted once (0/1).
4. The answer is `dp[target]`.

### Dry Run
Input `nums = [1, 5, 11, 5]`, sum = 22, target = 11.
- Start `dp[0]=True`, rest False.
- After 1: reachable {0,1}.
- After 5: {0,1,5,6}.
- After 11: {0,1,5,6,11,12,16,17} → `dp[11]=True`.
- Answer `True` (subsets {11} and {1,5,5} both sum to 11).

### Visualization
```
target = 11 ──▶ [ flip dp[j] |= dp[j-num], j descending ]
dp[11] becomes True once a subset hits 11  ──▶ answer = True
```

### Code
```python
def canPartition(nums):
    total = sum(nums)
    if total % 2:                       # odd total -> impossible
        return False
    target = total // 2
    dp = [False] * (target + 1)
    dp[0] = True                        # empty subset sums to 0
    for num in nums:
        for j in range(target, num - 1, -1):   # downward -> 0/1 (each num once)
            dp[j] |= dp[j - num]
    return dp[target]
```

### Complexity
Time O(n × target), Space O(target) — one rolling boolean row of size `sum/2 + 1`.

## 10. Solved Example 2

### Problem — Target Sum (LeetCode 494)
Assign `+` or `-` to each number to hit `target`. If `P` is the subset given `+`, then `P - (sum - P) = target`, so `P = (sum + target) / 2`. Count subsets summing to `P` — a 0/1 counting knapsack.

### Thought Process
1. Let `P = (sum + target) / 2`. If `sum + target` is odd or `abs(target) > sum`, no assignment works — return 0.
2. `dp[j]` = number of subsets summing to `j`; seed `dp[0] = 1` (empty subset).
3. For each number iterate `j` **downward** from `P` to `num`, adding `dp[j] += dp[j - num]` so each number is used once.
4. The answer is `dp[P]`.

### Dry Run
Input `nums = [1, 1, 1, 1, 1]`, target = 3, sum = 5, P = (5+3)/2 = 4.
- `dp[0]=1`.
- After each 1, counts of subsets by size accumulate (binomial).
- After all five 1s, `dp[4] = C(5,4) = 5`.
- Answer `5` (five ways to choose which four are `+`).

### Visualization
```
P = 4 ──▶ [ dp[j] += dp[j-num], j descending -> subsets counted once ]
dp[P] holds the number of + / - assignments  ──▶ answer = 5
```

### Code
```python
def findTargetSumWays(nums, target):
    total = sum(nums)
    if (total + target) % 2 or abs(target) > total:
        return 0
    P = (total + target) // 2
    dp = [0] * (P + 1)
    dp[0] = 1                           # one way to make sum 0: empty subset
    for num in nums:
        for j in range(P, num - 1, -1):        # downward -> each num once (0/1)
            dp[j] += dp[j - num]
    return dp[P]
```

### Complexity
Time O(n × P), Space O(P) where `P = (sum + target) / 2`.

## 11. Solved Example 3

### Problem — Last Stone II (LeetCode 1049)
Smashing stones splits them into two piles with signs `+`/`-`; the smallest leftover is `total - 2 * best`, where `best` is the largest subset sum not exceeding `total // 2`. Maximize a bounded subset sum — 0/1 knapsack.

### Thought Process
1. Let `total = sum(stones)` and `target = total // 2`; boolean `dp[j]` = "subset sum `j` reachable."
2. For each stone iterate `j` **downward** from `target` to `stone`: `dp[j] |= dp[j - stone]` (each stone once).
3. Take `best` = the largest `j ≤ target` with `dp[j]` True.
4. The minimum remaining weight is `total - 2 * best`.

### Dry Run
Input `stones = [2, 7, 4, 1, 8, 1]`, total = 23, target = 11.
- Seed `dp[0]=True`.
- Reachable sums grow; 11 is reachable (2+8+1 = 11).
- `best = 11`.
- Answer `23 - 2*11 = 1`.

### Visualization
```
target = 11 ──▶ [ dp[j] |= dp[j-stone], j descending ]
best = max reachable j ≤ 11 = 11  ──▶ answer = 23 - 22 = 1
```

### Code
```python
def lastStoneWeightII(stones):
    total = sum(stones)
    target = total // 2
    dp = [False] * (target + 1)
    dp[0] = True
    for stone in stones:
        for j in range(target, stone - 1, -1):   # downward -> each stone once
            dp[j] |= dp[j - stone]
    best = max(j for j in range(target + 1) if dp[j])
    return total - 2 * best
```

### Complexity
Time O(n × target), Space O(target) with `target = sum/2`.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 416 | Partition Equal | Easy | Core dynamic programming application |
| 494 | Target Sum | Easy | Core dynamic programming application |
| 1049 | Last Stone II | Medium | Core dynamic programming application |
| 474 | Ones Zeroes | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same 0/1 Knapsack logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** 0/1 Knapsack (Dynamic Programming).
- **Signal:** knapsack, 01, dp, capacity, weight value, take skip.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the 0/1 Knapsack invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: 0/1 Knapsack
FAMILY : Dynamic Programming (Advanced)
WHEN   : knapsack, 01, dp, capacity, weight value, take skip
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 416, 494, 1049, 474
```

---

*Part of the DSA Patterns Handbook — pattern 74 of 100.*
