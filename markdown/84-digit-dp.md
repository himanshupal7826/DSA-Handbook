# 84 · Digit DP

> **One-liner:** Count numbers in a range satisfying digit constraints via tight-flag DP.

---

## 1. Overview

### Definition
The **Digit DP** pattern belongs to the *Dynamic Programming* family. Count numbers in a range satisfying digit constraints via tight-flag DP.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
digit dp, count numbers, tight, bounds, constraints.

### Constraints
- Input size where the brute-force complexity would time out — the Digit DP optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Digit DP invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Digit DP is the upgrade.
- The wording maps onto: digit dp, count numbers, tight, bounds, constraints.

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
Redundant recomputation; does not exploit the structure the Digit DP pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Digit DP invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 262" width="100%" height="262" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr84" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Digit DP over N = 57: tight vs free branching</text>
  <rect x="230" y="40" width="160" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="310" y="60" text-anchor="middle" fill="#1e293b">pos 0, tight</text>
  <text x="310" y="76" text-anchor="middle" fill="#64748b" font-size="11">first digit &#8804; 5</text>
  <line x1="270" y1="84" x2="160" y2="134" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="188" y="112" text-anchor="middle" fill="#059669">d0 in 0..4</text>
  <line x1="350" y1="84" x2="452" y2="134" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="432" y="112" text-anchor="middle" fill="#d97706">d0 = 5</text>
  <rect x="60" y="136" width="180" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="150" y="156" text-anchor="middle" font-weight="700" fill="#1e293b">FREE</text>
  <text x="150" y="172" text-anchor="middle" fill="#64748b" font-size="11">below bound, unrestricted</text>
  <rect x="380" y="136" width="180" height="44" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="470" y="156" text-anchor="middle" font-weight="700" fill="#1e293b">TIGHT</text>
  <text x="470" y="172" text-anchor="middle" fill="#64748b" font-size="11">still on the bound</text>
  <line x1="150" y1="182" x2="150" y2="212" stroke="#475569" marker-end="url(#arr84)"/>
  <line x1="470" y1="182" x2="470" y2="212" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="150" y="232" text-anchor="middle" fill="#059669">pos 1: digit 0..9 (any)</text>
  <text x="470" y="232" text-anchor="middle" fill="#d97706">pos 1: digit 0..7 (&#8804; N)</text>
  <text x="310" y="254" text-anchor="middle" fill="#64748b">memo keyed on (pos, tight) so free subtrees are reused</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Digit DP          : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Digit DP problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | Digit DP (Optimal) |
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

### Problem — Number of Digit One (LeetCode 233)
Count how many times the digit `1` appears across every number from `1` to `n`.

### Thought Process
1. Count 1s contributed by each digit position independently, sweeping place value `i = 1, 10, 100, …`.
2. At position `i` split `n` into `high = n // (i*10)`, `cur = (n // i) % 10`, `low = n % i` — `cur` is the digit currently sitting in that place.
3. That place shows a `1` for `high * i` full cycles, plus an extra partial block: `0` more if `cur == 0`, `low + 1` more if `cur == 1`, and a whole extra `i` if `cur >= 2`.

### Dry Run
`n = 13`, expect `6` (ones in 1,10,11,11,12,13).
- `i = 1`: high=1, cur=3 (>=2) ⇒ add `(1+1)*1 = 2`.
- `i = 10`: high=0, cur=1 ⇒ add `0*10 + low(3) + 1 = 4`.
- Total `2 + 4 = 6`. ✔

### Visualization
```
place ──▶ [ high | cur | low ] evaluated per power of 10
state  ──▶ running count of 1s accumulated place by place
output ──▶ sum over all places
```

### Code
```python
def countDigitOne(n):
    count, i = 0, 1
    while i <= n:
        high, cur, low = n // (i * 10), (n // i) % 10, n % i
        if cur == 0:
            count += high * i
        elif cur == 1:
            count += high * i + low + 1
        else:
            count += (high + 1) * i
        i *= 10
    return count
```

### Complexity
Time O(log₁₀ n) — one pass per digit position; Space O(1).

## 10. Solved Example 2

### Problem — Numbers At Most N Given Digit Set (LeetCode 902)
Given a sorted set of digit characters, count positive integers `<= n` whose every digit comes from that set (digits may repeat).

### Thought Process
1. Any number with **fewer** digits than `n` is automatically valid: with `K` allowed digits there are `K^length` of each shorter length.
2. For numbers with the **same** length as `n`, walk `n` left to right keeping a *tight* bound: at each position, digits strictly smaller than `n`'s digit free up all remaining positions ⇒ add `K^(remaining)`.
3. Continue tight only if the exact digit of `n` is in the set; if it is, and we reach the end still tight, `n` itself is formable ⇒ add 1.

### Dry Run
`digits = ["1","3","5","7"], n = 100`, expect `20`.
- Shorter lengths: length 1 ⇒ `4`, length 2 ⇒ `16`, total `20`.
- Same length (3): first digit of `n` is `1`; no allowed digit is `< 1`, and `1` is in the set (stay tight). Next digit `0` has no allowed digit `<= 0`, so we stop: no 3-digit numbers. Total `20`. ✔

### Visualization
```
length ──▶ [ shorter: K^len each | equal: tight prefix scan ]
state  ──▶ tight flag drops once a smaller digit is chosen
output ──▶ shorter counts + tight-bounded same-length counts
```

### Code
```python
def atMostNGivenDigitSet(digits, n):
    s = str(n)
    L, K = len(s), len(digits)
    total = sum(K ** length for length in range(1, L))  # fewer digits
    for i, ch in enumerate(s):
        has_same = False
        for d in digits:
            if d < ch:
                total += K ** (L - i - 1)
            elif d == ch:
                has_same = True
        if not has_same:
            return total          # cannot stay tight -> done
    return total + 1              # n itself is formable
```

### Complexity
Time O(L · K) where L = number of digits of n; Space O(1).

## 11. Solved Example 3

### Problem — Numbers With Repeated Digits (LeetCode 1012)
Count integers in `[1, n]` that have **at least one repeated digit**. Easier to count the complement (all-distinct-digit numbers) and subtract: `answer = n - distinct`.

### Thought Process
1. Count all-distinct-digit numbers with **fewer** digits than `n`: for length `L`, `9 · P(9, L-1)` (leading digit 1–9, then falling permutations of the rest).
2. For the **same** length, scan `n` left to right with a `seen` set (used-digit mask): at each position, each unused digit smaller than `n`'s digit frees the tail ⇒ add `P(10-(i+1), L-(i+1))`.
3. Stop the tight scan the moment `n`'s own digit repeats; if it never repeats, `n` itself is all-distinct ⇒ add 1. Return `n - distinct`.

### Dry Run
`n = 20`, expect `1` (only `11`).
- Fewer digits (length 1): `9` distinct numbers.
- Same length, i=0 digit `2`, smaller unused `{1}` ⇒ `P(9,1)=9`; mark `2`. i=1 digit `0`, no smaller digit; `0` unused so append ⇒ `n` distinct ⇒ `+1`.
- distinct `= 9 + 9 + 1 = 19`; answer `= 20 - 19 = 1`. ✔

### Visualization
```
mask  ──▶ [ seen digits chosen so far ] guards distinctness
state  ──▶ falling-permutation counts for free tail positions
output ──▶ n - (distinct-digit numbers in [1, n])
```

### Code
```python
def numDupDigitsAtMostN(n):
    digits = list(map(int, str(n)))
    L = len(digits)

    def perm(m, k):                    # m * (m-1) * ... (k factors)
        res = 1
        for j in range(k):
            res *= (m - j)
        return res

    distinct = sum(9 * perm(9, length - 1) for length in range(1, L))

    seen = set()
    for i, d in enumerate(digits):
        for x in range(0 if i else 1, d):
            if x not in seen:
                distinct += perm(10 - (i + 1), L - (i + 1))
        if d in seen:
            break
        seen.add(d)
    else:
        distinct += 1                  # n itself has all-distinct digits

    return n - distinct
```

### Complexity
Time O(L · 10) where L = number of digits of n; Space O(L) for the seen mask.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 233 | Number of Digit One | Easy | Core dynamic programming application |
| 902 | Numbers At Most N | Easy | Core dynamic programming application |
| 1012 | Repeated Digit | Medium | Core dynamic programming application |
| 600 | No Adjacent Ones | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Digit DP logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Digit DP (Dynamic Programming).
- **Signal:** digit dp, count numbers, tight, bounds, constraints.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Digit DP invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Digit DP
FAMILY : Dynamic Programming (Expert)
WHEN   : digit dp, count numbers, tight, bounds, constraints
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 233, 902, 1012, 600
```

---

*Part of the DSA Patterns Handbook — pattern 84 of 100.*
