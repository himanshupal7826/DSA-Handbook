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
A representative **State Machine DP** problem. The signal: model the problem as states + transitions; dp over the automaton.

### Thought Process
1. Confirm the pattern via its recognition signals (state machine, stock, transitions, dp, hold sell).
2. Reach for the State Machine DP template below and map the problem's entities onto it.
3. Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply State Machine DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]
```

### Complexity
Time O(states × transitions), Space O(states). Each state computed once; space often reducible to a rolling row.

## 10. Solved Example 2

### Problem — Cooldown (LeetCode 309)
A representative **State Machine DP** problem. The signal: model the problem as states + transitions; dp over the automaton.

### Thought Process
1. Confirm the pattern via its recognition signals (state machine, stock, transitions, dp, hold sell).
2. Reach for the State Machine DP template below and map the problem's entities onto it.
3. Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply State Machine DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]
```

### Complexity
Time O(states × transitions), Space O(states). Each state computed once; space often reducible to a rolling row.

## 11. Solved Example 3

### Problem — Stock IV (LeetCode 188)
A representative **State Machine DP** problem. The signal: model the problem as states + transitions; dp over the automaton.

### Thought Process
1. Confirm the pattern via its recognition signals (state machine, stock, transitions, dp, hold sell).
2. Reach for the State Machine DP template below and map the problem's entities onto it.
3. Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply State Machine DP step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]
```

### Complexity
Time O(states × transitions), Space O(states). Each state computed once; space often reducible to a rolling row.


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
