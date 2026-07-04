# 75 · Unbounded Knapsack

> **One-liner:** Items reusable any number of times; iterate capacity forward.

---

## 1. Overview

### Definition
The **Unbounded Knapsack** pattern belongs to the *Dynamic Programming* family. Items reusable any number of times; iterate capacity forward.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
unbounded knapsack, dp, reuse, coin change, repeat items.

### Constraints
- Input size where the brute-force complexity would time out — the Unbounded Knapsack optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Unbounded Knapsack invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Unbounded Knapsack is the upgrade.
- The wording maps onto: unbounded knapsack, dp, reuse, coin change, repeat items.

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
Redundant recomputation; does not exploit the structure the Unbounded Knapsack pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Unbounded Knapsack invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 660 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="au-75" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Unbounded Knapsack (1D, forward): dp[w] = max(dp[w], dp[w-wt] + val)</text>
  <text x="97" y="52" text-anchor="middle" fill="#64748b">w=0</text>
  <text x="159" y="52" text-anchor="middle" fill="#64748b">1</text>
  <text x="221" y="52" text-anchor="middle" fill="#64748b">2</text>
  <text x="283" y="52" text-anchor="middle" fill="#64748b">3</text>
  <text x="345" y="52" text-anchor="middle" fill="#64748b">4</text>
  <text x="407" y="52" text-anchor="middle" fill="#64748b">5</text>
  <text x="469" y="52" text-anchor="middle" fill="#64748b">6</text>
  <text x="531" y="52" text-anchor="middle" fill="#64748b">7</text>
  <rect x="70"  y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="97"  y="85" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="132" y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="159" y="85" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="194" y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="221" y="85" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="256" y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="283" y="85" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="318" y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="345" y="85" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="380" y="60" width="54" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="407" y="85" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="442" y="60" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="469" y="85" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="504" y="60" width="54" height="40" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="531" y="85" text-anchor="middle" fill="#1e293b" font-weight="700">9</text>
  <path d="M407,58 Q469,26 531,58" fill="none" stroke="#475569" marker-end="url(#au-75)"/>
  <text x="469" y="30" text-anchor="middle" fill="#64748b">+val, reuse item wt2/val3 (forward)</text>
  <text x="330" y="130" text-anchor="middle" fill="#059669" font-weight="700">dp[7] = dp[5] + 3 = 9  answer</text>
  <text x="330" y="152" text-anchor="middle" fill="#64748b">forward loop lets the same item be picked again</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Unbounded Knapsack: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Unbounded Knapsack problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | Unbounded Knapsack (Optimal) |
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
Find the **minimum** number of coins to make `amount`, coins reusable any number of times. Minimization over an unbounded knapsack.

### Thought Process
1. `dp[a]` = fewest coins to make amount `a`; seed `dp[0] = 0`, all others `inf`.
2. Fill `a` from 1 to `amount`; for each coin `c ≤ a`, `dp[a] = min(dp[a], dp[a - c] + 1)`.
3. Because we sweep amounts **upward** and reuse `dp[a - c]`, each coin may be used repeatedly.
4. Return `dp[amount]`, or `-1` if it stayed `inf`.

### Dry Run
Input `coins = [1, 2, 5]`, amount = 11.
- `dp[1]=1, dp[2]=1, dp[3]=2, dp[4]=2, dp[5]=1`.
- `dp[6]=2, dp[10]=2` (5+5).
- `dp[11] = min(dp[10]+1, dp[9]+1, dp[6]+1) = 3` (5+5+1).
- Answer `3`.

### Visualization
```
amount = 11 ──▶ [ dp[a] = min(dp[a-c]+1), a ascending -> coins reused ]
dp[11] = 3  ──▶ 5 + 5 + 1
```

### Code
```python
def coinChange(coins, amount):
    INF = float('inf')
    dp = [0] + [INF] * amount           # dp[a] = min coins for amount a
    for a in range(1, amount + 1):
        for c in coins:
            if c <= a:
                dp[a] = min(dp[a], dp[a - c] + 1)
    return -1 if dp[amount] == INF else dp[amount]
```

### Complexity
Time O(amount × len(coins)), Space O(amount).

## 10. Solved Example 2

### Problem — Coin Change II (LeetCode 518)
Count the number of **combinations** of coins that make `amount`, coins reusable. Order does not matter, so the coin loop goes **outside**.

### Thought Process
1. `dp[a]` = number of combinations summing to `a`; seed `dp[0] = 1` (one way: pick nothing).
2. Put the **coin loop outermost**; for each coin sweep `a` **upward** from `coin` to `amount`: `dp[a] += dp[a - coin]`.
3. Coin-outer ordering counts each combination once (no permutations), and upward sweep allows reuse.
4. Return `dp[amount]`.

### Dry Run
Input `amount = 5`, coins = [1, 2, 5].
- After coin 1: `dp = [1,1,1,1,1,1]` (all-ones way).
- After coin 2: `dp[2..5] += dp[a-2]` → `dp = [1,1,2,2,3,3]`.
- After coin 5: `dp[5] += dp[0]` → `dp[5] = 4`.
- Answer `4` (5; 1+2+2; 1+1+1+2; 1+1+1+1+1).

### Visualization
```
coins outer ──▶ [ dp[a] += dp[a-coin], a ascending ]
each combination counted once  ──▶ dp[5] = 4
```

### Code
```python
def change(amount, coins):
    dp = [0] * (amount + 1)
    dp[0] = 1                           # one way to make 0: empty selection
    for coin in coins:                  # coin outer -> combinations, not permutations
        for a in range(coin, amount + 1):   # ascending -> coin reusable
            dp[a] += dp[a - coin]
    return dp[amount]
```

### Complexity
Time O(amount × len(coins)), Space O(amount).

## 11. Solved Example 3

### Problem — Combination Sum IV (LeetCode 377)
Count ordered sequences (**permutations**) of `nums` that sum to `target`, numbers reusable. Because order matters, the target loop goes **outside** and nums inner.

### Thought Process
1. `dp[a]` = number of ordered sequences summing to `a`; seed `dp[0] = 1`.
2. Put the **target loop outermost**; for each amount `a` from 1 to `target`, add `dp[a - n]` for every `n ≤ a`.
3. Target-outer ordering lets the same amount be reached by different last-picked numbers, so `[1,2]` and `[2,1]` both count.
4. Return `dp[target]`.

### Dry Run
Input `nums = [1, 2, 3]`, target = 4.
- `dp[0]=1`.
- `dp[1]=dp[0]=1`.
- `dp[2]=dp[1]+dp[0]=2`.
- `dp[3]=dp[2]+dp[1]+dp[0]=4`.
- `dp[4]=dp[3]+dp[2]+dp[1]=4+2+1=7`. Answer `7`.

### Visualization
```
target outer ──▶ [ dp[a] += dp[a-n] for n in nums, a ascending ]
order matters -> [1,2] and [2,1] both counted  ──▶ dp[4] = 7
```

### Code
```python
def combinationSum4(nums, target):
    dp = [0] * (target + 1)
    dp[0] = 1                           # empty sequence sums to 0
    for a in range(1, target + 1):      # amount outer -> permutations
        for n in nums:
            if n <= a:
                dp[a] += dp[a - n]
    return dp[target]
```

### Complexity
Time O(target × len(nums)), Space O(target).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 322 | Coin Change | Easy | Core dynamic programming application |
| 518 | Coin Change II | Easy | Core dynamic programming application |
| 377 | Combination Sum IV | Medium | Core dynamic programming application |
| 279 | Perfect Squares | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Unbounded Knapsack logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Unbounded Knapsack (Dynamic Programming).
- **Signal:** unbounded knapsack, dp, reuse, coin change, repeat items.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Unbounded Knapsack invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Unbounded Knapsack
FAMILY : Dynamic Programming (Advanced)
WHEN   : unbounded knapsack, dp, reuse, coin change, repeat items
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 322, 518, 377, 279
```

---

*Part of the DSA Patterns Handbook — pattern 75 of 100.*
