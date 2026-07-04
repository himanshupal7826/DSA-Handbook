# 76 · Subset Sum

> **One-liner:** Boolean DP: can a subset reach exactly the target sum?

---

## 1. Overview

### Definition
The **Subset Sum** pattern belongs to the *Dynamic Programming* family. Boolean DP: can a subset reach exactly the target sum?

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
subset sum, partition, dp, boolean, target.

### Constraints
- Input size where the brute-force complexity would time out — the Subset Sum optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Subset Sum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Subset Sum is the upgrade.
- The wording maps onto: subset sum, partition, dp, boolean, target.

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
Redundant recomputation; does not exploit the structure the Subset Sum pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Subset Sum invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="as-76" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Subset Sum (boolean): dp[s] = dp[s] OR dp[s-num]  · nums {2,3,4}, target 6</text>
  <text x="120" y="52" text-anchor="middle" fill="#64748b">s=0</text>
  <text x="186" y="52" text-anchor="middle" fill="#64748b">1</text>
  <text x="252" y="52" text-anchor="middle" fill="#64748b">2</text>
  <text x="318" y="52" text-anchor="middle" fill="#64748b">3</text>
  <text x="384" y="52" text-anchor="middle" fill="#64748b">4</text>
  <text x="450" y="52" text-anchor="middle" fill="#64748b">5</text>
  <text x="516" y="52" text-anchor="middle" fill="#64748b">6</text>
  <rect x="90"  y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="156" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="186" y="85" text-anchor="middle" fill="#64748b">F</text>
  <rect x="222" y="60" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="252" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="288" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="318" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="354" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="384" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="420" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="486" y="60" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="516" y="85" text-anchor="middle" fill="#1e293b" font-weight="700">T</text>
  <path d="M252,58 Q384,24 516,58" fill="none" stroke="#475569" marker-end="url(#as-76)"/>
  <text x="384" y="28" text-anchor="middle" fill="#64748b">add num=4: dp[6] |= dp[6-4] = dp[2]</text>
  <text x="320" y="130" text-anchor="middle" fill="#059669" font-weight="700">dp[6] = true  answer · subset {2,4} sums to 6</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">loop s downward so each number is used at most once</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Subset Sum        : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Subset Sum problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | Subset Sum (Optimal) |
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
A representative **Subset Sum** problem. The signal: boolean dp: can a subset reach exactly the target sum?

### Thought Process
1. If the total sum is odd it can't split into two equal halves — return False immediately.
2. Otherwise the goal is a subset summing to `target = sum // 2`; this is exact-target subset sum.
3. Use a 1D boolean dp where `dp[j]` means "some subset sums to j"; iterate each num and update j downward so each num is used at most once.

### Dry Run
nums = [1, 5, 11, 5], sum = 22, target = 11.
- start dp[0]=True.
- num=1  → dp[1]=True.
- num=5  → dp[6],dp[5] become True.
- num=11 → dp[11] becomes True → dp[11] already reachable, answer is True.
Subset {1,5,5} and {11} both sum to 11 → return True.

### Visualization
```
nums {1,5,11,5} · target 11 ──▶ dp[11] flips True once 11 (or 1+5+5) is reachable
```

### Code
```python
def canPartition(nums):
    total = sum(nums)
    if total % 2:
        return False
    target = total // 2
    dp = [False] * (target + 1)
    dp[0] = True
    for num in nums:
        for j in range(target, num - 1, -1):
            dp[j] |= dp[j - num]
    return dp[target]
```

### Complexity
Time O(n × target), Space O(target) — one boolean row of size sum/2 + 1.

## 10. Solved Example 2

### Problem — Target Sum (LeetCode 494)
A representative **Subset Sum** problem. The signal: boolean dp: can a subset reach exactly the target sum?

### Thought Process
1. Assign each num a `+` or `-`; let P be the set given `+`. Then sum(P) - (total - sum(P)) = target, so sum(P) = (total + target) / 2.
2. If (total + target) is odd or target > total, no assignment works — return 0.
3. Count subsets that sum to P using a 1D counting dp: `dp[j] += dp[j - num]`, iterating j downward for 0/1 usage.

### Dry Run
nums = [1,1,1,1,1], target = 3, total = 5, P = (5 + 3)/2 = 4.
- dp[0]=1, rest 0.
- After each of the five 1's, dp counts subsets summing to each j.
- Number of size-4 subsets of five 1's = C(5,4) = 5 → dp[4] = 5.
return 5.

### Visualization
```
nums {1,1,1,1,1} · target 3 ──▶ count subsets summing to P=4 → C(5,4)=5 ways
```

### Code
```python
def findTargetSumWays(nums, target):
    total = sum(nums)
    if (total + target) % 2 or target > total or -target > total:
        return 0
    P = (total + target) // 2
    dp = [0] * (P + 1)
    dp[0] = 1
    for num in nums:
        for j in range(P, num - 1, -1):
            dp[j] += dp[j - num]
    return dp[P]
```

### Complexity
Time O(n × P), Space O(P) where P = (sum + target) / 2.

## 11. Solved Example 3

### Problem — K Subsets (LeetCode 698)
A representative **Subset Sum** problem. The signal: boolean dp: can a subset reach exactly the target sum?

### Thought Process
1. Each bucket must sum to `target = total / k`; if total isn't divisible by k, or the largest element exceeds target, it's impossible.
2. Sort descending so large elements are placed first, pruning dead branches early.
3. Backtrack: fill one bucket to exactly target, then recurse to fill the next; a `used[]` array tracks consumed elements.

### Dry Run
nums = [4,3,2,3,5,2,1], k = 4, total = 20, target = 5. Sorted desc: [5,4,3,3,2,2,1].
- bucket1: {5}=5 ✓.
- bucket2: {4,1}=5 ✓.
- bucket3: {3,2}=5 ✓.
- bucket4: {3,2}=5 ✓ — all k buckets filled → return True.

### Visualization
```
nums {4,3,2,3,5,2,1} · k=4 ──▶ four buckets each summing to 5: {5}{4,1}{3,2}{3,2}
```

### Code
```python
def canPartitionKSubsets(nums, k):
    total = sum(nums)
    if total % k:
        return False
    target = total // k
    nums.sort(reverse=True)
    if nums[0] > target:
        return False
    n = len(nums)
    used = [False] * n

    def dfs(start, filled, cur):
        if filled == k:
            return True
        if cur == target:
            return dfs(0, filled + 1, 0)
        for j in range(start, n):
            if not used[j] and cur + nums[j] <= target:
                used[j] = True
                if dfs(j + 1, filled, cur + nums[j]):
                    return True
                used[j] = False
        return False

    return dfs(0, 0, 0)
```

### Complexity
Time O(k × 2^n) worst case with pruning, Space O(n) for the used array and recursion.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 416 | Partition Equal | Easy | Core dynamic programming application |
| 494 | Target Sum | Easy | Core dynamic programming application |
| 698 | K Subsets | Medium | Core dynamic programming application |
| 1049 | Last Stone II | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Subset Sum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Subset Sum (Dynamic Programming).
- **Signal:** subset sum, partition, dp, boolean, target.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Subset Sum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Subset Sum
FAMILY : Dynamic Programming (Advanced)
WHEN   : subset sum, partition, dp, boolean, target
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 416, 494, 698, 1049
```

---

*Part of the DSA Patterns Handbook — pattern 76 of 100.*
