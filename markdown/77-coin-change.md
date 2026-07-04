# 77 · Coin Change

> **One-liner:** Min-coins / count-ways DP, a canonical unbounded-knapsack case.

---

## 1. Overview

### Definition
The **Coin Change** pattern belongs to the *Dynamic Programming* family. Min-coins / count-ways DP, a canonical unbounded-knapsack case.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
coin change, min coins, ways, dp, unbounded.

### Constraints
- Input size where the brute-force complexity would time out — the Coin Change optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Coin Change invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Coin Change is the upgrade.
- The wording maps onto: coin change, min coins, ways, dp, unbounded.

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
Redundant recomputation; does not exploit the structure the Coin Change pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Coin Change invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ac-77" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Coin Change (min): dp[a] = min over coins of dp[a-coin] + 1  · coins {1,3,4}</text>
  <text x="120" y="52" text-anchor="middle" fill="#64748b">a=0</text>
  <text x="186" y="52" text-anchor="middle" fill="#64748b">1</text>
  <text x="252" y="52" text-anchor="middle" fill="#64748b">2</text>
  <text x="318" y="52" text-anchor="middle" fill="#64748b">3</text>
  <text x="384" y="52" text-anchor="middle" fill="#64748b">4</text>
  <text x="450" y="52" text-anchor="middle" fill="#64748b">5</text>
  <text x="516" y="52" text-anchor="middle" fill="#64748b">6</text>
  <rect x="90"  y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="85" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="156" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="186" y="85" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="222" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="252" y="85" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="288" y="60" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="318" y="85" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="354" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="384" y="85" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="420" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="85" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="486" y="60" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="516" y="85" text-anchor="middle" fill="#1e293b" font-weight="700">2</text>
  <path d="M318,58 Q417,24 516,58" fill="none" stroke="#475569" marker-end="url(#ac-77)"/>
  <text x="417" y="28" text-anchor="middle" fill="#64748b">use coin 3: dp[6] = dp[6-3] + 1 = dp[3] + 1</text>
  <text x="320" y="130" text-anchor="middle" fill="#059669" font-weight="700">dp[6] = 2  answer · coins 3 + 3</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">dp[0]=0, unreachable = INF; forward over amounts (coins reusable)</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Coin Change       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Coin Change problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | Coin Change (Optimal) |
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

### Problem — Coin Change (LeetCode 322)
Given coins of distinct denominations and a target `amount`, return the **fewest coins** needed to make up that amount, or `-1` if it is impossible. Coins may be reused (unbounded).

### Thought Process
1. Let `dp[a]` = minimum coins to make amount `a`. Base case `dp[0] = 0`; initialize all others to infinity (unreachable).
2. For each amount `a` from 1 to `amount`, try every coin `c ≤ a`: taking coin `c` costs `dp[a - c] + 1`, so `dp[a] = min(dp[a], dp[a - c] + 1)`.
3. The answer is `dp[amount]` if it stayed finite, else `-1`.

### Dry Run
coins = [1, 2, 5], amount = 6.
- dp[1]=1, dp[2]=min(dp[1]+1, dp[0]+1)=1, dp[3]=dp[2]+1=2, dp[4]=dp[2]+1=2.
- dp[5]=min(dp[4]+1, dp[3]+1, dp[0]+1)=1 (one 5-coin).
- dp[6]=min(dp[5]+1, dp[4]+1, dp[1]+1)=2 (5+1). Answer = **2**.

### Visualization
```
amount ──▶ [ build dp[0..amount], min over each coin ]
state  ──▶ dp[a] = fewest coins for a, filled bottom-up
output ──▶ dp[amount], or -1 if still infinity
```

### Code
```python
def coinChange(coins, amount):
    INF = float('inf')
    dp = [0] + [INF] * amount          # dp[a] = fewest coins to make a
    for a in range(1, amount + 1):
        for c in coins:
            if c <= a and dp[a - c] + 1 < dp[a]:
                dp[a] = dp[a - c] + 1
    return dp[amount] if dp[amount] != INF else -1
```

### Complexity
Time O(amount × len(coins)), Space O(amount).

## 10. Solved Example 2

### Problem — Coin Change II (LeetCode 518)
Given coins of distinct denominations and a target `amount`, return the **number of combinations** that make up that amount. Order does not matter (2+1 and 1+2 count once); coins may be reused.

### Thought Process
1. Let `dp[a]` = number of combinations making amount `a`, with `dp[0] = 1` (the empty combination).
2. To avoid counting the same multiset in different orders, loop coins on the **outside** and amounts on the inside. Each coin is fully considered before moving on, so combinations stay order-independent.
3. For each coin `c`, add `dp[a - c]` into `dp[a]` for `a` from `c` to `amount`. Return `dp[amount]`.

### Dry Run
coins = [1, 2, 5], amount = 5.
- After coin 1: dp = [1,1,1,1,1,1] (all-ones combinations).
- After coin 2: dp[2]+=dp[0]→2, dp[3]+=dp[1]→2, dp[4]+=dp[2]→3, dp[5]+=dp[3]→3.
- After coin 5: dp[5]+=dp[0]→4. Answer = **4** ({1x5},{1,2,2},{1,1,1,2},{1x5 ones},{5}).

### Visualization
```
coins  ──▶ [ for each coin, sweep amounts upward ]
state  ──▶ dp[a] = # combinations, coin-outer keeps order out
output ──▶ dp[amount]
```

### Code
```python
def change(amount, coins):
    dp = [1] + [0] * amount            # dp[a] = # combinations making a
    for c in coins:                    # coin outer -> combinations, not permutations
        for a in range(c, amount + 1):
            dp[a] += dp[a - c]
    return dp[amount]
```

### Complexity
Time O(amount × len(coins)), Space O(amount).

## 11. Solved Example 3

### Problem — Comb Sum IV (LeetCode 377)
Given an array of distinct positive integers `nums` and a `target`, return the **number of ordered permutations** (sequences) that sum to `target`. Here order matters: (1,2) and (2,1) are counted separately; numbers may be reused.

### Thought Process
1. Let `dp[t]` = number of ordered sequences summing to `t`, with `dp[0] = 1` (the empty sequence).
2. Because order matters, loop the **target on the outside** and the numbers on the inside — this lets any number be the last element of a sequence, counting each ordering.
3. For each `t` from 1 to `target`, add `dp[t - n]` for every `n ≤ t`. Return `dp[target]`.

### Dry Run
nums = [1, 2, 3], target = 4.
- dp[0]=1, dp[1]=dp[0]=1, dp[2]=dp[1]+dp[0]=2, dp[3]=dp[2]+dp[1]+dp[0]=4.
- dp[4]=dp[3]+dp[2]+dp[1]=4+2+1=7. Answer = **7** ordered sequences summing to 4.

### Visualization
```
target ──▶ [ for each t, sum dp[t-n] over all n ]
state  ──▶ dp[t] = # ordered sequences, target-outer counts order
output ──▶ dp[target]
```

### Code
```python
def combinationSum4(nums, target):
    dp = [1] + [0] * target            # dp[t] = # ordered sequences summing to t
    for t in range(1, target + 1):     # target outer -> permutations, order counts
        for n in nums:
            if n <= t:
                dp[t] += dp[t - n]
    return dp[target]
```

### Complexity
Time O(target × len(nums)), Space O(target).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 322 | Coin Change | Easy | Core dynamic programming application |
| 518 | Coin Change II | Easy | Core dynamic programming application |
| 377 | Comb Sum IV | Medium | Core dynamic programming application |
| 983 | Min Cost Tickets | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Coin Change logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Coin Change (Dynamic Programming).
- **Signal:** coin change, min coins, ways, dp, unbounded.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Coin Change invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Coin Change
FAMILY : Dynamic Programming (Advanced)
WHEN   : coin change, min coins, ways, dp, unbounded
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 322, 518, 377, 983
```

---

*Part of the DSA Patterns Handbook — pattern 77 of 100.*
