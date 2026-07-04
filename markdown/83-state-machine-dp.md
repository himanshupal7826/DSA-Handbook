# 83 · State Machine DP

> **One-liner:** Model the problem as states + transitions; DP over the automaton.

---

## 1. Overview

### Definition
The **State Machine DP** pattern belongs to the *Dynamic Programming* family. Model the problem as states + transitions; DP over the automaton.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
state machine, stock, transitions, dp, hold sell.

### Constraints
- Input size where the brute-force complexity would time out — the State Machine DP optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the State Machine DP invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — State Machine DP is the upgrade.
- The wording maps onto: state machine, stock, transitions, dp, hold sell.

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
Redundant recomputation; does not exploit the structure the State Machine DP pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the State Machine DP invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr83" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Stock with cooldown: 3 states, transitions per day</text>
  <line x1="168" y1="128" x2="286" y2="92" stroke="#475569" marker-end="url(#arr83)"/>
  <text x="205" y="98" text-anchor="middle" fill="#64748b">buy -price</text>
  <line x1="336" y1="92" x2="452" y2="128" stroke="#475569" marker-end="url(#arr83)"/>
  <text x="418" y="98" text-anchor="middle" fill="#64748b">sell +price</text>
  <line x1="448" y1="152" x2="172" y2="152" stroke="#475569" marker-end="url(#arr83)"/>
  <text x="310" y="170" text-anchor="middle" fill="#64748b">cooldown</text>
  <circle cx="150" cy="150" r="34" fill="#eff6ff" stroke="#2563eb"/><text x="150" y="147" text-anchor="middle" fill="#1e293b">REST</text><text x="150" y="163" text-anchor="middle" fill="#64748b" font-size="11">cash</text>
  <circle cx="310" cy="78" r="34" fill="#eff6ff" stroke="#2563eb"/><text x="310" y="75" text-anchor="middle" fill="#1e293b">HELD</text><text x="310" y="91" text-anchor="middle" fill="#64748b" font-size="11">own</text>
  <circle cx="470" cy="150" r="34" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="470" y="147" text-anchor="middle" font-weight="700" fill="#1e293b">SOLD</text><text x="470" y="163" text-anchor="middle" fill="#64748b" font-size="11">just sold</text>
  <text x="150" y="212" text-anchor="middle" fill="#64748b">held = max(held, rest - price)</text>
  <text x="470" y="212" text-anchor="middle" fill="#64748b">sold = held + price</text>
  <text x="310" y="234" text-anchor="middle" fill="#059669" font-weight="700">answer = max(sold, rest) on last day</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
State Machine DP  : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a State Machine DP problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | State Machine DP (Optimal) |
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

### Problem — Best Time Stock (LeetCode 121)
At most **one** transaction: buy once, sell once (later). Maximize profit; return 0 if no gain is possible.

### Thought Process
1. Two states per day: `cash` = max profit holding no stock, `hold` = max profit currently holding a share.
2. Transitions: `cash = max(cash, hold + price)` (sell today); `hold = max(hold, -price)` (buy today — note `-price`, not `cash - price`, because only one buy is allowed).
3. Start `cash = 0`, `hold = -inf`. Answer is `cash` after the last day.

### Dry Run
prices = [7,1,5,3,6,4]
- day 7: hold=-7, cash=0
- day 1: hold=max(-7,-1)=-1, cash=0
- day 5: hold=-1, cash=max(0,-1+5)=4
- day 6: hold=-1, cash=max(4,-1+6)=5
- Answer = **5** (buy at 1, sell at 6).

### Visualization
```
hold ──▶ [ best profit while owning a share, single buy ]
cash ──▶ [ best profit after selling, read as the answer ]
```

### Code
```python
def maxProfit(prices):
    cash, hold = 0, float('-inf')
    for price in prices:
        cash = max(cash, hold + price)   # sell today (or skip)
        hold = max(hold, -price)         # buy today (only one buy allowed)
    return cash
```

### Complexity
Time O(n), Space O(1) — two scalar states swept once over the prices.

## 10. Solved Example 2

### Problem — Cooldown (LeetCode 309)
Unlimited transactions, but after selling you must **rest one day** before buying again. Maximize profit.

### Thought Process
1. Three states: `hold` = own a share, `sold` = just sold today (in cooldown), `rest` = idle and free to buy.
2. Transitions each day: `hold = max(hold, rest - price)` (buy, only from rest); `sold = hold + price` (sell today); `rest = max(rest, prev_sold)` (stay idle or exit cooldown).
3. Compute with the *previous* day's values, then update. Answer = `max(sold, rest)` at the end (never end holding).

### Dry Run
prices = [1,2,3,0,2]
- start: hold=-inf, sold=0, rest=0
- p=1: hold=-1, sold=-inf, rest=0
- p=2: hold=-1, sold=1, rest=0
- p=3: hold=-1, sold=2, rest=1
- p=0: hold=1, sold=-1, rest=2
- p=2: hold=1, sold=3, rest=2 → Answer = **3** (buy1/sell3, cooldown, buy0/sell2).

### Visualization
```
rest ──▶ buy ──▶ hold ──▶ sell ──▶ sold ──▶ (cooldown) ──▶ rest
```

### Code
```python
def maxProfit(prices):
    hold, sold, rest = float('-inf'), float('-inf'), 0
    for price in prices:
        prev_sold = sold
        hold = max(hold, rest - price)   # buy only from rest
        sold = hold + price              # sell today
        rest = max(rest, prev_sold)      # exit cooldown into rest
    return max(sold, rest)
```

### Complexity
Time O(n), Space O(1) — three rolling scalar states.

## 11. Solved Example 3

### Problem — Stock IV (LeetCode 188)
At most **k** transactions. Maximize profit over the price series.

### Thought Process
1. For each transaction slot `j` in 1..k keep two states: `buy[j]` = best profit after the j-th buy, `sell[j]` = best profit after the j-th sell.
2. Per price: `buy[j] = max(buy[j], sell[j-1] - price)` (open j-th position from proceeds of j-1 sells); `sell[j] = max(sell[j], buy[j] + price)` (close it).
3. If `k >= n//2`, transactions are effectively unlimited — sum every positive delta instead (avoids O(nk) blowup). Answer = `sell[k]`.

### Dry Run
k = 2, prices = [3,2,6,5,0,3]
- init buy=[-inf,-inf], sell=[0,0]
- p=3: buy1=-3
- p=2: buy1=-2
- p=6: sell1=4, buy2=max(-inf,4-6)=-2
- p=5: sell1=4, sell2=max(0,-2+5)=3
- p=0: buy1=max(-2,0)... buy2=max(-2,4-0)=4
- p=3: sell2=max(3,4+3)=7 → Answer = **7** (buy2/sell6 + buy0/sell3).

### Visualization
```
sell[j-1] ──▶ buy[j] ──▶ sell[j]   (k stacked buy/sell layers)
```

### Code
```python
def maxProfit(k, prices):
    n = len(prices)
    if not prices or k == 0:
        return 0
    if k >= n // 2:                       # unlimited transactions
        return sum(max(0, prices[i] - prices[i-1]) for i in range(1, n))
    buy = [float('-inf')] * (k + 1)
    sell = [0] * (k + 1)
    for price in prices:
        for j in range(1, k + 1):
            buy[j] = max(buy[j], sell[j-1] - price)
            sell[j] = max(sell[j], buy[j] + price)
    return sell[k]
```

### Complexity
Time O(n·k) (O(n) in the unlimited fast path), Space O(k).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 121 | Best Time Stock | Easy | Core dynamic programming application |
| 309 | Cooldown | Easy | Core dynamic programming application |
| 188 | Stock IV | Medium | Core dynamic programming application |
| 714 | Transaction Fee | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same State Machine DP logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** State Machine DP (Dynamic Programming).
- **Signal:** state machine, stock, transitions, dp, hold sell.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the State Machine DP invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: State Machine DP
FAMILY : Dynamic Programming (Expert)
WHEN   : state machine, stock, transitions, dp, hold sell
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 121, 309, 188, 714
```

---

*Part of the DSA Patterns Handbook — pattern 83 of 100.*
