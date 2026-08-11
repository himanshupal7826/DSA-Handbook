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

**The question this pattern keeps answering:** *"Using these denominations, how do I make this amount?"* — fewest coins, or how many ways.

### Intuition
At every step, try every coin.

### Algorithm
1. `fewest(amount)`: if `amount == 0`, zero coins are needed.
2. Otherwise, for each coin `c ≤ amount`, recursively compute `fewest(amount − c)`.
3. Take the minimum and add 1.
4. If no coin leads to a solution, the amount is unreachable.

### Complexity
- Time: **O(cᵃ)** for `c` coins and amount `a` — exponential.
- Space: O(a) recursion depth.

### Drawbacks
- The same subproblem is solved over and over. With coins `{1,2,5}` and amount 11, `fewest(9)` is reached via `11→10→9`, via `11→9` directly, and countless other routes — each time recomputed from scratch.
- The recursion tree has exponentially many nodes but only `a + 1` **distinct** values inside it. That gap is the entire opportunity.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **There are only `amount + 1` distinct subproblems, so compute each one once and store it.**

### The four DP questions

Every DP solution is these four answers. For "fewest coins":

**1. What does `dp[i]` mean?**

```text
dp[i] = the fewest coins needed to make exactly amount i
```

Say it as a full sentence, out loud, before writing any code. Almost every DP bug is a vague or shifting definition.

**2. How do we compute `dp[i]`?**

Any solution for `i` must end with *some* coin `c`. Remove that coin and what remains is an optimal solution for `i − c`:

```text
dp[i] = min over all coins c <= i of ( dp[i - c] + 1 )
```

**3. What is the base case?**

```text
dp[0] = 0        making zero requires zero coins
dp[i] = infinity for i > 0, meaning "not yet known to be reachable"
```

The infinity sentinel matters: it lets `min` ignore unreachable states without a special case. Use a value like `amount + 1` — larger than any real answer, and safe from overflow when you add 1.

**4. Why iterate forward?**

`dp[i]` depends on `dp[i − c]`, which is a **smaller** index. Computing `i` in increasing order guarantees every dependency is already final.

### The part that actually trips people: loop order changes the meaning

For *counting* problems the two nested loops can be written either way round, and **they compute different things**. This is the most important idea in the chapter.

```text
COMBINATIONS  (order does NOT matter: 1+2 and 2+1 are the same)
    for each coin:                ← coins OUTER
        for amount = coin..target:
            dp[amount] += dp[amount - coin]

PERMUTATIONS  (order DOES matter: 1+2 and 2+1 are different)
    for amount = 1..target:       ← amount OUTER
        for each coin <= amount:
            dp[amount] += dp[amount - coin]
```

**Why coins-outer counts combinations.** Fixing a coin and sweeping every amount before moving to the next coin means each coin is considered *once, in a fixed order*. A count can therefore only ever use coins in that order — `1` then `2`, never `2` then `1` — so `1+2` is counted and `2+1` is not.

**Why amount-outer counts permutations.** Here every coin is reconsidered at every amount, with no fixed order between them, so `1+2` and `2+1` are both reached and both counted.

Check it on `coins = {1,2}`, `target = 3`:

```text
coins outer:  ways(3) = 2      →  {1,1,1} and {1,2}
amount outer: ways(3) = 3      →  1+1+1, 1+2, 2+1
```

Same code, one swap, different answers. Read the problem statement to decide which it wants.

> LeetCode 377 is called "Combination Sum IV" but actually counts **permutations** — the name is misleading, the examples are not. Always check the examples.

### Why the minimisation version doesn't care about loop order

For `min`, order is irrelevant: taking a minimum is commutative and associative, so `dp[i]` ends up the same either way. Only **counting** distinguishes the two loop orders — which is exactly why the distinction is easy to forget until it bites.

### Greedy does not work here

The natural instinct — "always take the largest coin that fits" — is wrong for general denominations:

```text
coins = {1, 3, 4},  amount = 6

greedy: 4 + 1 + 1        = 3 coins
optimal: 3 + 3           = 2 coins
```

Greedy happens to be correct for real-world currency systems, which are designed to make it so. It is not correct in general, and DP is.

### How should I recognize this?

```text
If you see...
  "fewest coins / minimum number of items to reach a total"
  "how many ways to make change", "how many ways to reach a target"
  unlimited reuse of each item
        ↓
Think about...
  "What does dp[i] mean, in one sentence?"
  "Does order matter?  →  it decides the loop order"
        ↓
Use...
  minimise → dp[i] = min(dp[i-c] + 1),  loop order irrelevant
  count combinations → coins OUTER
  count permutations → amount OUTER
```

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

```text
coins = [1, 2, 5], amount = 11, minimising

  i  :  0  1  2  3  4  5  6  7  8  9 10 11
 dp  :  0  1  1  2  2  1  2  2  3  3  2  3
                          ↑              ↑
              dp[5]=1 (one 5)      dp[11] = dp[6]+1 = 3
                                   → 5 + 5 + 1

each dp[i] looks back to dp[i-1], dp[i-2], dp[i-5] — all already final
because we sweep i upward
```

### Interview explanation
"I'll define `dp[i]` as the fewest coins needed to make exactly amount `i`. Any solution for `i` ends with some coin `c`, and removing it leaves an optimal solution for `i − c`, so `dp[i] = min over c of dp[i−c] + 1`. The base case is `dp[0] = 0`, and I initialise the rest to `amount + 1` as an infinity sentinel so `min` ignores unreachable states. I sweep `i` upward because every dependency is at a smaller index. That's O(amount × coins) time and O(amount) space. For the counting variants the loop order carries the meaning: coins on the outside counts **combinations**, because each coin is only ever considered in one fixed position, while amount on the outside counts **permutations**, because every coin is reconsidered at every amount. And I'd note that greedy fails here — with coins {1,3,4} and amount 6, greedy gives 3 coins but the optimum is 2."

---

## 5. Generic Templates

> Define `dp[i]` in words first. For counting, the loop order *is* the specification.

```go
// MinCoins returns the fewest coins summing to amount, or -1 if impossible.
// dp[i] = the fewest coins needed to make exactly amount i.
func MinCoins(coins []int, amount int) int {
    // amount+1 acts as infinity: larger than any real answer, no overflow.
    const unreachableMarker = 1
    dp := make([]int, amount+1)
    for i := 1; i <= amount; i++ {
        dp[i] = amount + unreachableMarker
    }
    dp[0] = 0 // making zero needs zero coins

    // Forward sweep: dp[i] depends only on smaller indices.
    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin > i {
                continue
            }
            if dp[i-coin]+1 < dp[i] {
                dp[i] = dp[i-coin] + 1
            }
        }
    }

    if dp[amount] > amount {
        return -1 // never improved from the sentinel
    }
    return dp[amount]
}

// CountCombinations counts unordered ways to reach amount.
// COINS OUTER: each coin is considered once, in a fixed order, so
// 1+2 is counted and 2+1 is not.
func CountCombinations(coins []int, amount int) int {
    dp := make([]int, amount+1)
    dp[0] = 1 // one way to make zero: take nothing

    for _, coin := range coins { // outer
        for i := coin; i <= amount; i++ {
            dp[i] += dp[i-coin]
        }
    }
    return dp[amount]
}

// CountPermutations counts ORDERED ways to reach amount.
// AMOUNT OUTER: every coin is reconsidered at every amount, so both
// 1+2 and 2+1 are counted.
func CountPermutations(coins []int, amount int) int {
    dp := make([]int, amount+1)
    dp[0] = 1

    for i := 1; i <= amount; i++ { // outer
        for _, coin := range coins {
            if coin <= i {
                dp[i] += dp[i-coin]
            }
        }
    }
    return dp[amount]
}
```

```python
def min_coins(coins, amount):
    """dp[i] = fewest coins needed to make exactly amount i."""
    INF = amount + 1                    # larger than any real answer
    dp = [INF] * (amount + 1)
    dp[0] = 0                           # zero needs zero coins

    for i in range(1, amount + 1):      # forward: dependencies are smaller
        for coin in coins:
            if coin <= i:
                dp[i] = min(dp[i], dp[i - coin] + 1)

    return -1 if dp[amount] > amount else dp[amount]

def count_combinations(coins, amount):
    """Unordered ways. COINS OUTER: each coin considered once, in order."""
    dp = [0] * (amount + 1)
    dp[0] = 1                           # one way to make zero

    for coin in coins:                  # outer
        for i in range(coin, amount + 1):
            dp[i] += dp[i - coin]
    return dp[amount]

def count_permutations(coins, amount):
    """Ordered ways. AMOUNT OUTER: every coin reconsidered at every amount."""
    dp = [0] * (amount + 1)
    dp[0] = 1

    for i in range(1, amount + 1):      # outer
        for coin in coins:
            if coin <= i:
                dp[i] += dp[i - coin]
    return dp[amount]
```

```java
import java.util.*;

public class CoinChange {
    // dp[i] = fewest coins needed to make exactly amount i.
    public static int minCoins(int[] coins, int amount) {
        int[] dp = new int[amount + 1];
        Arrays.fill(dp, amount + 1);        // infinity sentinel
        dp[0] = 0;

        for (int i = 1; i <= amount; i++)   // forward sweep
            for (int coin : coins)
                if (coin <= i) dp[i] = Math.min(dp[i], dp[i - coin] + 1);

        return dp[amount] > amount ? -1 : dp[amount];
    }

    // COINS OUTER → combinations (order does not matter).
    public static int countCombinations(int[] coins, int amount) {
        long[] dp = new long[amount + 1];
        dp[0] = 1;
        for (int coin : coins)
            for (int i = coin; i <= amount; i++) dp[i] += dp[i - coin];
        return (int) dp[amount];
    }

    // AMOUNT OUTER → permutations (order matters).
    public static int countPermutations(int[] coins, int amount) {
        long[] dp = new long[amount + 1];
        dp[0] = 1;
        for (int i = 1; i <= amount; i++)
            for (int coin : coins)
                if (coin <= i) dp[i] += dp[i - coin];
        return (int) dp[amount];
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// dp[i] = fewest coins needed to make exactly amount i.
int minCoins(const vector<int>& coins, int amount) {
    vector<int> dp(amount + 1, amount + 1);     // infinity sentinel
    dp[0] = 0;

    for (int i = 1; i <= amount; ++i)           // forward sweep
        for (int coin : coins)
            if (coin <= i) dp[i] = min(dp[i], dp[i - coin] + 1);

    return dp[amount] > amount ? -1 : dp[amount];
}

// COINS OUTER → combinations.
long long countCombinations(const vector<int>& coins, int amount) {
    vector<long long> dp(amount + 1, 0);
    dp[0] = 1;
    for (int coin : coins)
        for (int i = coin; i <= amount; ++i) dp[i] += dp[i - coin];
    return dp[amount];
}

// AMOUNT OUTER → permutations.
long long countPermutations(const vector<int>& coins, int amount) {
    vector<long long> dp(amount + 1, 0);
    dp[0] = 1;
    for (int i = 1; i <= amount; ++i)
        for (int coin : coins)
            if (coin <= i) dp[i] += dp[i - coin];
    return dp[amount];
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
Given coin denominations and an `amount`, return the fewest coins summing to it, or `−1` if it cannot be made. You have unlimited coins of each denomination.

### Thought Process

**What does `dp[i]` mean?** The fewest coins needed to make exactly amount `i`.

**How do we compute it?** Any solution for `i` ends with some coin `c`. Remove that coin and the rest is an optimal solution for `i − c`. So `dp[i] = min over c of dp[i−c] + 1`.

**What is the base case?** `dp[0] = 0` — zero coins make zero. Everything else starts at `amount + 1`, a value larger than any real answer, so `min` ignores unreachable states without a special case.

**Why iterate forward?** `dp[i]` reads only `dp[i − c]` for positive `c`, which are smaller indices. Sweeping upward means every dependency is already final when we need it.

### Dry Run

Input: `coins = [1, 2, 5]`, `amount = 11`

Start: `dp[0] = 0`, everything else `12` (the sentinel).

| i | from `dp[i−1]+1` | from `dp[i−2]+1` | from `dp[i−5]+1` | `dp[i]` |
|---|-------------------|-------------------|-------------------|---------|
| 1 | `0+1 = 1` | — | — | **1** |
| 2 | `1+1 = 2` | `0+1 = 1` | — | **1** |
| 3 | `1+1 = 2` | `1+1 = 2` | — | **2** |
| 4 | `2+1 = 3` | `1+1 = 2` | — | **2** |
| 5 | `2+1 = 3` | `2+1 = 3` | `0+1 = 1` | **1** |
| 6 | `1+1 = 2` | `2+1 = 3` | `1+1 = 2` | **2** |
| 7 | `2+1 = 3` | `1+1 = 2` | `1+1 = 2` | **2** |
| 8 | `2+1 = 3` | `2+1 = 3` | `2+1 = 3` | **3** |
| 9 | `3+1 = 4` | `2+1 = 3` | `2+1 = 3` | **3** |
| 10 | `3+1 = 4` | `3+1 = 4` | `1+1 = 2` | **2** |
| 11 | `2+1 = 3` | `3+1 = 4` | `2+1 = 3` | **3** |

Output: **3** ✓

Check by hand: `5 + 5 + 1 = 11` uses three coins, and no two coins reach 11. ✓

Trace `dp[11] = 3` back: it came from `dp[6] + 1`, and `dp[6] = 2` came from `dp[5] + 1`, and `dp[5] = 1` came from `dp[0] + 1`. That chain is `1, 5, 5` — exactly the coins.

**The unreachable case:** `coins = [2]`, `amount = 3`. `dp[1]` never improves from the sentinel `4`, so `dp[3]` cannot either, and we return `−1`. ✓

### Visualization

```text
coins = [1, 2, 5]

  i  :  0  1  2  3  4  5  6  7  8  9 10 11
 dp  :  0  1  1  2  2  1  2  2  3  3  2  3
        └──────────────┘        ↑        ↑
        all already final    dp[6]=2   dp[11] = dp[6]+1 = 3

  backtrack the choices:  11 ─5─▶ 6 ─5─▶ 1 ─1─▶ 0
```

### Code

```go
func coinChange(coins []int, amount int) int {
    // dp[i] = fewest coins to make exactly amount i.
    dp := make([]int, amount+1)

    // amount+1 is an infinity sentinel: bigger than any real answer
    // (which is at most `amount` using all 1s), and safe to add 1 to.
    for i := 1; i <= amount; i++ {
        dp[i] = amount + 1
    }
    dp[0] = 0 // zero coins make zero

    // Forward: every dp[i-coin] is a smaller index, hence already final.
    for i := 1; i <= amount; i++ {
        for _, coin := range coins {
            if coin > i {
                continue
            }
            if candidate := dp[i-coin] + 1; candidate < dp[i] {
                dp[i] = candidate
            }
        }
    }

    if dp[amount] > amount {
        return -1 // never improved: the amount is unreachable
    }
    return dp[amount]
}
```

```python
def coinChange(coins, amount):
    INF = amount + 1                    # bigger than any real answer
    dp = [INF] * (amount + 1)
    dp[0] = 0                           # zero coins make zero

    for i in range(1, amount + 1):      # forward: dependencies are smaller
        for coin in coins:
            if coin <= i:
                dp[i] = min(dp[i], dp[i - coin] + 1)

    return -1 if dp[amount] > amount else dp[amount]
```

### Complexity
Time **O(amount × len(coins))**, Space **O(amount)**.

---

## 10. Solved Example 2

### Problem — Coin Change II (LeetCode 518)
Count the number of **combinations** that make up `amount`. Two combinations differing only in order are the **same**.

### Thought Process

**What does `dp[i]` mean?** The number of distinct combinations summing to exactly `i`.

**How do we compute it?** Processing coin `c`, every combination for `i − c` extends to one for `i` by adding a `c`. So `dp[i] += dp[i − c]`.

**What is the base case?** `dp[0] = 1` — exactly one way to make zero: take nothing. Starting at `0` instead would make every count zero forever.

**Why coins on the outside?** Because order must *not* matter. Fixing one coin and sweeping all amounts before moving on means coins can only ever be used in the outer loop's order — so `1+2` is counted and `2+1` is never reachable.

### Dry Run

Input: `amount = 5`, `coins = [1, 2, 5]` — coins outer.

Start: `dp = [1, 0, 0, 0, 0, 0]`

**After coin 1** (each `dp[i] += dp[i−1]`, sweeping `i = 1..5`):

| i | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| dp| 1 | 1 | 1 | 1 | 1 | 1 |

Only one way per amount so far — all 1s.

**After coin 2** (`dp[i] += dp[i−2]`, sweeping `i = 2..5`):

| i | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| dp| 1 | 1 | **2** | **2** | **3** | **3** |

`dp[4] = 1 + dp[2] = 1 + 2 = 3` → `{1,1,1,1}`, `{1,1,2}`, `{2,2}`.

**After coin 5** (`dp[i] += dp[i−5]`, only `i = 5`):

| i | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| dp| 1 | 1 | 2 | 2 | 3 | **4** |

Output: **4** ✓

The four combinations are `{5}`, `{2,2,1}`, `{2,1,1,1}`, `{1,1,1,1,1}`. ✓

**Why `2+1+1+1` and `1+2+1+1` were not counted separately.** By the time coin 2 is processed, coin 1's sweep is complete and never revisited. So a combination is always built as "some 1s, then some 2s, then some 5s" — one canonical order per multiset.

### Visualization

```text
coins outer, one full sweep per coin:

  after coin 1:  [1, 1, 1, 1, 1, 1]
  after coin 2:  [1, 1, 2, 2, 3, 3]
  after coin 5:  [1, 1, 2, 2, 3, 4]
                                  ↑
                            answer = 4

  each coin is finished before the next begins
     ⇒ combinations are built in a fixed coin order
     ⇒ {2,1,1,1} counted once, not four times
```

### Code

```go
func change(amount int, coins []int) int {
    // dp[i] = number of distinct combinations summing to exactly i.
    dp := make([]int, amount+1)
    dp[0] = 1 // exactly one way to make zero: take nothing

    // COINS OUTER. Each coin is fully processed before the next begins,
    // so combinations are only ever built in this fixed coin order —
    // which is what makes 1+2 and 2+1 the same single count.
    for _, coin := range coins {
        for i := coin; i <= amount; i++ {
            dp[i] += dp[i-coin]
        }
    }

    return dp[amount]
}
```

```python
def change(amount, coins):
    dp = [0] * (amount + 1)
    dp[0] = 1                           # one way to make zero: take nothing

    # COINS OUTER: each coin finished before the next starts, so a
    # combination is always built in this fixed order → 1+2 == 2+1.
    for coin in coins:
        for i in range(coin, amount + 1):
            dp[i] += dp[i - coin]

    return dp[amount]
```

### Complexity
Time **O(amount × len(coins))**, Space **O(amount)**.

---

## 11. Solved Example 3

### Problem — Combination Sum IV (LeetCode 377)
Given distinct positive integers and a `target`, count the number of **ordered** combinations summing to the target. Sequences in different orders count separately.

### Thought Process

**Read the examples, not the title.** Despite the name, LeetCode 377 counts **permutations** — `(1,2,1)` and `(2,1,1)` are two different answers. That single fact decides the loop order.

**What does `dp[i]` mean?** The number of ordered sequences summing to exactly `i`.

**How do we compute it?** Every such sequence has a *last* element `x`. Removing it leaves an ordered sequence summing to `i − x`. So `dp[i] = sum over x of dp[i − x]`.

**What is the base case?** `dp[0] = 1` — the empty sequence.

**Why amount on the outside?** Because at each amount we reconsider *every* number as the last element, with no fixed ordering between them. That is exactly what makes `1+2` and `2+1` two separate counts.

### Dry Run

Input: `nums = [1, 2, 3]`, `target = 4` — amount outer.

Start: `dp[0] = 1`.

| i | from `dp[i−1]` | from `dp[i−2]` | from `dp[i−3]` | `dp[i]` |
|---|-----------------|-----------------|-----------------|---------|
| 1 | `dp[0] = 1` | — | — | **1** |
| 2 | `dp[1] = 1` | `dp[0] = 1` | — | **2** |
| 3 | `dp[2] = 2` | `dp[1] = 1` | `dp[0] = 1` | **4** |
| 4 | `dp[3] = 4` | `dp[2] = 2` | `dp[1] = 1` | **7** |

Output: **7** ✓

The seven ordered sequences are:

```text
(1,1,1,1)   (1,1,2)   (1,2,1)   (2,1,1)
(2,2)       (1,3)     (3,1)
```

Note `(1,2,1)` and `(2,1,1)` are counted separately — that is the permutation semantics. ✓

**The same input with the loops swapped.** Putting `nums` on the outside would count only unordered combinations: `{1,1,1,1}`, `{1,1,2}`, `{2,2}`, `{1,3}` — just **4**. Same code, one swap, and a wrong answer for this problem.

### Visualization

```text
dp[4] = dp[3] + dp[2] + dp[1]
      =   4   +   2   +   1   = 7
        ↑        ↑        ↑
   last elem   last elem  last elem
      is 1       is 2       is 3

amount OUTER ⇒ every number is reconsidered at every amount
             ⇒ (1,2,1) and (2,1,1) both counted

    compare:   coins outer → 4   (combinations)
               amount outer → 7  (permutations)   ← what 377 wants
```

### Code

```go
func combinationSum4(nums []int, target int) int {
    // dp[i] = number of ORDERED sequences summing to exactly i.
    dp := make([]int, target+1)
    dp[0] = 1 // the empty sequence

    // AMOUNT OUTER. Every number is reconsidered as the last element at
    // every amount, with no fixed order between them — so (1,2) and (2,1)
    // are counted separately.
    for i := 1; i <= target; i++ {
        for _, num := range nums {
            if num <= i {
                dp[i] += dp[i-num]
            }
        }
    }

    return dp[target]
}
```

```python
def combinationSum4(nums, target):
    dp = [0] * (target + 1)
    dp[0] = 1                           # the empty sequence

    # AMOUNT OUTER: every number reconsidered at every amount, so
    # (1,2) and (2,1) are counted separately.
    for i in range(1, target + 1):
        for num in nums:
            if num <= i:
                dp[i] += dp[i - num]

    return dp[target]
```

### Complexity
Time **O(target × len(nums))**, Space **O(target)**.

> Put Examples 2 and 3 side by side: identical recurrence, identical base case, identical complexity — and different answers, because the loop order *is* the specification. When a counting problem involves reusable items, decide "does order matter?" first, and let that choose which loop goes outside.

---

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
