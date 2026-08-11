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

**The question this pattern keeps answering:** *"If I may take as many copies of each item as I like, what is the most I can fit into the bag?"*

Running example: two item **types**, available in unlimited supply — **A** (weight 2, value 3) and **B** (weight 3, value 4) — and a bag of capacity **7**.

### Intuition
Nothing stops you from taking an item twice, so instead of "in or out" each type has a *count*: 0, 1, 2, … up to `capacity / weight`. Try every combination of counts and keep the best one that fits.

### Algorithm
1. Recurse over item types. At type `i`, loop `k = 0, 1, 2, …` while `k · wt[i] ≤ remaining`.
2. Subtract `k · wt[i]` from the remaining capacity, add `k · val[i]` to the running value, recurse on type `i+1`.
3. When the types run out, report the running value.
4. Return the maximum reported value.

### Complexity
- Time: **O((W/w₁ + 1) × (W/w₂ + 1) × …)** — exponential in the number of types; with `n` types and small weights it behaves like `O(W^n)`.
- Space: O(n) recursion depth.

### Drawbacks
- **The exact wasted work:** with `A(2,3)` and `B(3,4)` and capacity 7, these two branches land in the same place:

  ```text
  take A once,   then B once   →  B still available, 2 capacity free
  take B once,   then A once   →  B still available, 2 capacity free   ← identical
  ```

  and so does "take A twice then stop, with 3 left" versus several other orderings. Every ordering of the same multiset is explored separately even though only the leftover capacity matters.
- **The fact it fails to exploit:** the future depends on the remaining capacity **and nothing else** — not on which items produced it, not on the order they were taken in, and (unlike 0/1) not even on which types are still "unused", because every type stays available forever.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Because every item type stays available no matter how often you used it, the state collapses to a single number — the capacity still free — and `dp[w]` can be built from smaller capacities that already include the same item.**

Think of a vending machine rather than a suitcase. In 0/1 knapsack an item, once taken, is gone; in unbounded knapsack the shelf is restocked instantly. So "best value for capacity `w`" no longer needs to remember which items are spent — it is a one-dimensional fact about `w` alone.

### The thought process

```text
We need    : max value with unlimited copies of each item type, weight <= W.
Obvious way: try every count for every type.
Too slow   : counts multiply -> W^n.
Notice     : after any purchase, only "capacity left" survives into the future.
Notice too : the SAME item may legally be bought again.
Therefore  : dp over capacity alone; dp[w] may read a dp cell that already
             used this item.
Now        : n x W states, O(1) each -> O(n*W).
```

### The recurrence, in words

```text
dp[w] means : the best total value you can pack into a bag of capacity exactly
              w or less, using unlimited copies of the item types considered so far.

dp[w] = max( dp[w]                     ← don't add another copy of this item
           , dp[w - wt] + val )        ← add one more copy of this item; the
                                         remaining w-wt must be packed optimally
                                         and IS ALLOWED to contain this item too
base case   : dp[0] = 0 — an empty bag is worth nothing, and there is no
              smaller capacity to build it from. Everything else starts at 0
              too, because "take nothing" is always legal.
answer      : dp[W].
```

### Why the capacity loop runs **upward** — and why 0/1 runs downward

This is the single most valuable contrast in dynamic programming, because in the space-optimised 1-D form the two algorithms are **the same five lines with the loop reversed**:

```text
0/1        : for w = W down to wt:   dp[w] = max(dp[w], dp[w-wt] + val)
unbounded  : for w = wt up to W:     dp[w] = max(dp[w], dp[w-wt] + val)
```

`dp[w-wt]` is the cell in question. Downward, it has not been touched yet this round, so it means *"best value before this item existed"* → the item can be added at most once. Upward, it has already been rewritten this round, so it means *"best value that may already contain this item"* → the item can be added again.

**Demonstrate it.** One item type: weight 2, value 3. Capacity 7.

*Upward* — watch a single item become three copies:

```text
start          dp = [0, 0, 0, 0, 0, 0, 0, 0]
w=2  dp[2] = max(0, dp[0]+3) = max(0, 0+3) = 3     dp = [0,0,3,0,0,0,0,0]
w=3  dp[3] = max(0, dp[1]+3) = max(0, 0+3) = 3     dp = [0,0,3,3,0,0,0,0]
w=4  dp[4] = max(0, dp[2]+3) = max(0, 3+3) = 6     dp = [0,0,3,3,6,0,0,0]
                              ^^^^^^ dp[2] already holds ONE copy -> now TWO
w=5  dp[5] = max(0, dp[3]+3) = max(0, 3+3) = 6     dp = [0,0,3,3,6,6,0,0]
w=6  dp[6] = max(0, dp[4]+3) = max(0, 6+3) = 9     dp = [0,0,3,3,6,6,9,0]
                              ^^^^^^ dp[4] holds TWO copies -> now THREE
w=7  dp[7] = max(0, dp[5]+3) = max(0, 6+3) = 9     dp = [0,0,3,3,6,6,9,9]

dp[7] = 9 = three copies of the item (weight 6, value 9). Exactly what
"unlimited supply" should give — the reuse is the FEATURE here.
```

*Downward* — the same five lines, and the item can only be bought once:

```text
start          dp = [0, 0, 0, 0, 0, 0, 0, 0]
w=7  dp[7] = max(0, dp[5]+3) = max(0, 0+3) = 3     (dp[5] untouched this round)
w=6  dp[6] = max(0, dp[4]+3) = max(0, 0+3) = 3
w=5  dp[5] = max(0, dp[3]+3) = 3
w=4  dp[4] = max(0, dp[2]+3) = 3
w=3  dp[3] = max(0, dp[1]+3) = 3
w=2  dp[2] = max(0, dp[0]+3) = 3
               dp = [0, 0, 3, 3, 3, 3, 3, 3]

dp[7] = 3 = one copy. That is the 0/1 answer, and it is WRONG here.
```

Two directions, two problems, one line of code. If you remember nothing else from this chapter, remember which way the arrow points.

### Steps

```text
Step 1 → dp = array of W+1 zeros.
Step 2 → for each item type i:
Step 3 →     for w = wt[i] up to W:            (UPWARD — reuse allowed)
Step 4 →         dp[w] = max(dp[w], dp[w-wt[i]] + val[i])
Step 5 → answer = dp[W]
```

### How should I recognize this?

```text
If you see...
  "unlimited supply", "you may reuse", "as many as you want",
  "infinite coins", "cut the rod into pieces", "repetition allowed"
        ↓
Think about...
  "Does using an item remove it from the pool?"
  No  -> unbounded, capacity loop UPWARD
  Yes -> 0/1,       capacity loop DOWNWARD
        ↓
Use...
  dp over capacity/amount, one pass per item type, loop upward
    ├─ maximise value      → dp[w] = max(dp[w], dp[w-wt]+val)     (rod cutting)
    ├─ minimise count      → dp[a] = min(dp[a], dp[a-c]+1)        (coin change)
    ├─ count COMBINATIONS  → item loop OUTSIDE, amount inside
    └─ count PERMUTATIONS  → amount loop OUTSIDE, item inside
```

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

```text
types: A(wt 2, val 3), B(wt 3, val 4)   unlimited copies   capacity 7

start            dp = [0, 0, 0, 0, 0, 0, 0, 0]

type A (2,3), w = 2 → 7   (upward)
  w=2: dp[0]+3 = 3 > 0    → dp[2]=3
  w=3: dp[1]+3 = 3 > 0    → dp[3]=3
  w=4: dp[2]+3 = 6 > 0    → dp[4]=6      (second A)
  w=5: dp[3]+3 = 6 > 0    → dp[5]=6
  w=6: dp[4]+3 = 9 > 0    → dp[6]=9      (third A)
  w=7: dp[5]+3 = 9 > 0    → dp[7]=9
                 dp = [0, 0, 3, 3, 6, 6, 9, 9]   ← the state drawn above

type B (3,4), w = 3 → 7   (upward)
  w=3: dp[0]+4 = 4 > 3    → dp[3]=4
  w=4: dp[1]+4 = 4 < 6    → dp[4]=6  (keep A+A)
  w=5: dp[2]+4 = 7 > 6    → dp[5]=7  (A + B)
  w=6: dp[3]+4 = 8 < 9    → dp[6]=9  (keep A+A+A)
  w=7: dp[4]+4 = 10 > 9   → dp[7]=10 (A + A + B)
                 dp = [0, 0, 3, 4, 6, 7, 9, 10]

answer dp[7] = 10   (A + A + B: weight 2+2+3 = 7, value 3+3+4 = 10)
```

### Interview explanation
"Because every item type can be reused, the state is just the remaining capacity — I don't have to remember which items are spent. So `dp[w] = max(dp[w], dp[w - wt] + val)` over a single array of size `W+1`. The important detail is that I sweep capacity **upward**: `dp[w - wt]` is then a cell I have already updated in this same pass, so it may already contain a copy of the current item, which is exactly the reuse I want. Sweeping downward would turn this into 0/1 knapsack. That's O(n·W) time and O(W) space, and the same skeleton handles min-coins and counting variants by swapping `max` for `min` or `+=`."

---

## 5. Generic Templates

> One array over capacity, one pass per item type, capacity **ascending** — ascending is what allows reuse.

```go
// UnboundedKnapsack returns the greatest total value obtainable with unlimited
// copies of each item type, subject to a total weight of at most capacity.
//
// dp[w] = best value for a bag of capacity w using the types seen so far.
func UnboundedKnapsack(weights, values []int, capacity int) int {
    dp := make([]int, capacity+1) // taking nothing is always allowed -> 0

    for i := range weights {
        // Ascending: dp[w-weights[i]] has ALREADY been updated in this pass,
        // so it may already contain item i — that is how reuse happens.
        for w := weights[i]; w <= capacity; w++ {
            if take := dp[w-weights[i]] + values[i]; take > dp[w] {
                dp[w] = take
            }
        }
    }
    return dp[capacity]
}
```

```python
def unbounded_knapsack(weights, values, capacity):
    """Best total value with unlimited copies of each item type.

    dp[w] = best value for a bag of capacity w using the types seen so far.
    """
    dp = [0] * (capacity + 1)          # taking nothing is always allowed
    for weight, value in zip(weights, values):
        # ascending: dp[w - weight] may already contain this item -> reuse
        for w in range(weight, capacity + 1):
            dp[w] = max(dp[w], dp[w - weight] + value)
    return dp[capacity]
```

```java
// dp[w] = best value for a bag of capacity w using the types seen so far.
int unboundedKnapsack(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];              // taking nothing is allowed
    for (int i = 0; i < weights.length; i++) {
        // Ascending lets dp[w - weights[i]] already contain item i.
        for (int w = weights[i]; w <= capacity; w++) {
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[capacity];
}
```

```cpp
// dp[w] = best value for a bag of capacity w using the types seen so far.
int unboundedKnapsack(const vector<int>& weights, const vector<int>& values, int capacity) {
    vector<int> dp(capacity + 1, 0);               // taking nothing is allowed
    for (size_t i = 0; i < weights.size(); ++i) {
        // Ascending lets dp[w - weights[i]] already contain item i.
        for (int w = weights[i]; w <= capacity; ++w) {
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[capacity];
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
Given coin denominations and an `amount`, return the fewest coins that add up to `amount`, or `-1` if it cannot be done. Every denomination is available in unlimited supply.

### Thought Process
1. This is unbounded knapsack with `min` where the maximisation version had `max`: the "value" of a coin is 1 coin spent, and we want the smallest total.
2. Greedy fails — with coins `{1, 3, 4}` and amount 6, grabbing the biggest coin first gives `4+1+1 = 3` coins while `3+3 = 2` is optimal. So we must actually try every coin at every amount.
3. `dp[a]` = fewest coins for amount `a`. Try each coin as the **last** coin placed: that costs `dp[a - coin] + 1`.
4. Unreachable amounts must be marked with a sentinel (infinity) so they never win a `min` and never get `+1`'d into a fake answer.

### The DP, spelled out

```text
What does dp[a] mean?
    dp[a] is the minimum number of coins whose values add up to exactly a.
    If no set of coins adds up to a, dp[a] is INF ("impossible").

How is dp[a] computed?
    dp[a] = 1 + min over every coin c <= a of dp[a - c]
    Term by term: pick which coin is placed LAST. After placing coin c you
    still owe a - c, and the cheapest way to owe a - c is dp[a-c] — already
    computed, because a - c < a. The "+1" is the coin you just placed.
    Skip any c where dp[a-c] is INF: you cannot extend an impossibility.

What is the base case?
    dp[0] = 0. Making amount 0 needs zero coins, and it is the only amount
    that is free. Every other cell starts at INF so that "unreachable" is
    the default and must be earned.

Why forward?
    dp[a] reads dp[a-c] with c > 0, i.e. strictly smaller amounts. Sweeping a
    upward from 1 guarantees those cells are final before they are read. And
    because dp[a-c] may itself already use coin c, coins are automatically
    reusable — exactly the unbounded behaviour we want.
```

### Dry Run

Input: `coins = [1, 2, 5]`, `amount = 11`

| a | via 1: dp[a−1]+1 | via 2: dp[a−2]+1 | via 5: dp[a−5]+1 | **dp[a]** |
|---|---|---|---|---|
| 0 | — | — | — | **0** |
| 1 | 0+1 = 1 | — | — | **1** |
| 2 | 1+1 = 2 | 0+1 = 1 | — | **1** |
| 3 | 1+1 = 2 | 1+1 = 2 | — | **2** |
| 4 | 2+1 = 3 | 1+1 = 2 | — | **2** |
| 5 | 2+1 = 3 | 2+1 = 3 | 0+1 = 1 | **1** |
| 6 | 1+1 = 2 | 2+1 = 3 | 1+1 = 2 | **2** |
| 7 | 2+1 = 3 | 1+1 = 2 | 1+1 = 2 | **2** |
| 8 | 2+1 = 3 | 2+1 = 3 | 2+1 = 3 | **3** |
| 9 | 3+1 = 4 | 2+1 = 3 | 2+1 = 3 | **3** |
| 10 | 3+1 = 4 | 3+1 = 4 | 1+1 = 2 | **2** |
| 11 | 2+1 = 3 | 3+1 = 4 | 2+1 = 3 | **3** |

Output: **`3`** — `5 + 5 + 1`.

Row `a = 10` is the reuse in action: it wins through `dp[5] + 1`, and `dp[5]` was itself a single 5-coin. One denomination, used twice, with no extra machinery — that is what the forward sweep buys.

### Visualization

```text
a     0   1   2   3   4   5   6   7   8   9  10  11
dp    0   1   1   2   2   1   2   2   3   3   2   3
                          ^                   ^   ^
                        one 5              5+5   5+5+1

back-trace from dp[11]:
  dp[11]=3 came from dp[10]+1  → take coin 1,  owe 10
  dp[10]=2 came from dp[5]+1   → take coin 5,  owe 5
  dp[5] =1 came from dp[0]+1   → take coin 5,  owe 0   ✔
```

### Code

```go
func coinChange(coins []int, amount int) int {
    const impossible = 1 << 30 // sentinel: bigger than any real coin count

    // dp[a] = fewest coins adding up to exactly a
    dp := make([]int, amount+1)
    for a := 1; a <= amount; a++ {
        dp[a] = impossible
    }
    dp[0] = 0 // amount 0 needs no coins

    // Forward over amounts: dp[a-c] is final, and may already contain coin c.
    for a := 1; a <= amount; a++ {
        for _, c := range coins {
            if c <= a && dp[a-c]+1 < dp[a] {
                dp[a] = dp[a-c] + 1
            }
        }
    }

    if dp[amount] == impossible {
        return -1
    }
    return dp[amount]
}
```

```python
def coinChange(coins, amount):
    INF = float('inf')                  # sentinel for "unreachable"
    dp = [INF] * (amount + 1)           # dp[a] = fewest coins adding up to a
    dp[0] = 0                           # amount 0 needs no coins

    for a in range(1, amount + 1):      # forward: dp[a - c] is already final
        for c in coins:
            if c <= a and dp[a - c] + 1 < dp[a]:
                dp[a] = dp[a - c] + 1

    return -1 if dp[amount] == INF else dp[amount]
```

### Complexity
Time **O(amount × len(coins))** — every amount tries every coin once. Space **O(amount)** for the single row.

---

## 10. Solved Example 2

### Problem — Coin Change II (LeetCode 518)
Count how many **combinations** of coins add up to `amount`. Coins are unlimited, and two selections that differ only in order count as one.

### Thought Process
1. Same unbounded knapsack, but the combine step counts instead of minimising: `dp[a] += dp[a - coin]`.
2. The whole difficulty is *not* the recurrence — it is the **loop order**. Put the coin loop **outside** and the amount loop inside.
3. Coin-outside means: by the time coin `c` is being processed, every combination already counted uses only coins from earlier iterations. So each multiset is built in exactly one canonical order (smallest-indexed coin first) and is counted exactly once.
4. Swap the loops and you count ordered sequences instead — that is LeetCode 377, the next example.

### The DP, spelled out

```text
What does dp[a] mean?
    dp[a] is the number of distinct MULTISETS of coins, drawn only from the
    denominations processed so far, whose values add up to exactly a.

How is dp[a] computed?
    dp[a] += dp[a - coin]
    Every combination summing to a-coin (built from this coin and earlier ones)
    becomes a distinct combination summing to a when one more `coin` is dropped
    in. dp[a]'s current value already counts the combinations that use no copy
    of `coin` at all, so the += merges "without it" and "with at least one".

What is the base case?
    dp[0] = 1. There is exactly one way to make 0: take nothing. Every "+="
    chain ultimately bottoms out here, so seeding it to 0 would zero everything.

Why forward, and why the coin loop outside?
    Forward (a ascending) means dp[a-coin] may already include copies of `coin`
    -> unlimited supply. Coin-outside means a combination is only ever extended
    by coins at or before the current one, which fixes a single canonical order
    per multiset and prevents double counting.
```

### Dry Run

Input: `coins = [1, 2, 3]`, `amount = 4`

| after coin | dp[0] | dp[1] | dp[2] | dp[3] | dp[4] |
|---|---|---|---|---|---|
| *(start)* | 1 | 0 | 0 | 0 | 0 |
| `1` | 1 | 1 | 1 | 1 | 1 |
| `2` | 1 | 1 | 2 | 2 | 3 |
| `3` | 1 | 1 | 2 | 3 | 4 |

Output: **`4`** — the multisets are `{1,1,1,1}`, `{1,1,2}`, `{2,2}`, `{1,3}`.

Follow the `2` row: `dp[2] += dp[0]` gives 2 (`{1,1}` and `{2}`), then `dp[4] += dp[2]` reads the **already updated** `dp[2] = 2`, contributing `{1,1,2}` and `{2,2}`. That second contribution is a *second* copy of the coin 2 — the forward sweep is what allows it.

### Visualization

```text
coin loop OUTSIDE  →  each multiset gets one canonical build order

  coin 1 pass:  1+1+1+1                                 dp[4] = 1
  coin 2 pass:  1+1+2 , 2+2                             dp[4] = 3
  coin 3 pass:  1+3                                     dp[4] = 4

nothing is ever built as "2 then 1 then 1" — by the time coin 1 has been
processed the pass is over, so no combination can prepend a smaller coin later.
```

### Code

```go
func change(amount int, coins []int) int {
    // ways[a] = number of coin multisets (from the coins processed so far)
    // that add up to exactly a
    ways := make([]int, amount+1)
    ways[0] = 1 // one way to make 0: take nothing

    for _, coin := range coins { // coin OUTSIDE -> combinations, not orderings
        for a := coin; a <= amount; a++ { // ascending -> the coin may repeat
            ways[a] += ways[a-coin]
        }
    }
    return ways[amount]
}
```

```python
def change(amount, coins):
    # ways[a] = number of coin multisets summing to exactly a
    ways = [0] * (amount + 1)
    ways[0] = 1                         # one way to make 0: take nothing

    for coin in coins:                  # coin OUTSIDE -> combinations
        for a in range(coin, amount + 1):   # ascending -> the coin may repeat
            ways[a] += ways[a - coin]

    return ways[amount]
```

### Complexity
Time **O(amount × len(coins))**. Space **O(amount)**.

---

## 11. Solved Example 3

### Problem — Combination Sum IV (LeetCode 377)
Given distinct positive integers `nums` and a `target`, count the **ordered sequences** of numbers (repeats allowed) that sum to `target`. Despite the name, `(1,2)` and `(2,1)` are counted separately.

### Thought Process
1. Identical recurrence to example 10 — `dp[t] += dp[t - n]` — with the loops **swapped**: target outside, numbers inside.
2. Target-outside means: at amount `t`, *every* number gets a chance to be the last element of the sequence. Different last elements produce different orderings, so orderings are counted separately.
3. That is the entire distinction. Same array, same `+=`, opposite nesting, different question answered.
4. Feed it the same input as example 10 to see the gap directly.

### The DP, spelled out

```text
What does dp[t] mean?
    dp[t] is the number of ordered SEQUENCES (order matters, repeats allowed)
    of elements of nums whose sum is exactly t.

How is dp[t] computed?
    dp[t] = sum over every n in nums with n <= t of dp[t - n]
    Term by term: fix which number is LAST in the sequence. If it is n, the
    part before it is any sequence summing to t-n, and there are dp[t-n] of
    those. Different choices of last element give genuinely different
    sequences, so the counts simply add.

What is the base case?
    dp[0] = 1 — the empty sequence, the unique sequence summing to 0.

Why forward, and why the target loop outside?
    Forward because dp[t] needs dp[t-n] for smaller t, which must be final.
    Target-outside because every number must be allowed to be the last element
    of every sequence; with the number loop outside, only "non-decreasing by
    coin index" builds are reachable and you would count multisets instead.
```

### Dry Run

Input: `nums = [1, 2, 3]`, `target = 4`

| t | dp[t−1] | dp[t−2] | dp[t−3] | **dp[t] = sum** |
|---|---|---|---|---|
| 0 | — | — | — | **1** (base) |
| 1 | dp[0] = 1 | — | — | **1** |
| 2 | dp[1] = 1 | dp[0] = 1 | — | **2** |
| 3 | dp[2] = 2 | dp[1] = 1 | dp[0] = 1 | **4** |
| 4 | dp[3] = 4 | dp[2] = 2 | dp[1] = 1 | **7** |

Output: **`7`**

Same `nums`, same target as example 10 — which returned **4**. Here is the whole difference, written out:

```text
combinations (LC 518, coin loop outside) = 4
    {1,1,1,1}   {1,1,2}   {2,2}   {1,3}

permutations (LC 377, target loop outside) = 7
    1+1+1+1
    1+1+2   1+2+1   2+1+1        ← one multiset, three orderings
    2+2
    1+3     3+1                  ← one multiset, two orderings
```

### Visualization

```text
target loop OUTSIDE: at each t, every number may be the tail

  t=4 ──┬── last = 1 → prefix sums to 3 → dp[3] = 4 sequences
        ├── last = 2 → prefix sums to 2 → dp[2] = 2 sequences
        └── last = 3 → prefix sums to 1 → dp[1] = 1 sequence
                                          ------------------
                                          dp[4] = 7
```

### Code

```go
func combinationSum4(nums []int, target int) int {
    // ways[t] = number of ORDERED sequences of nums summing to exactly t
    ways := make([]int, target+1)
    ways[0] = 1 // the empty sequence

    for t := 1; t <= target; t++ { // target OUTSIDE -> order matters
        for _, n := range nums { // n is the LAST element of the sequence
            if n <= t {
                ways[t] += ways[t-n]
            }
        }
    }
    return ways[target]
}
```

```python
def combinationSum4(nums, target):
    # ways[t] = number of ORDERED sequences of nums summing to exactly t
    ways = [0] * (target + 1)
    ways[0] = 1                         # the empty sequence

    for t in range(1, target + 1):      # target OUTSIDE -> order matters
        for n in nums:                  # n is the LAST element of the sequence
            if n <= t:
                ways[t] += ways[t - n]

    return ways[target]
```

### Complexity
Time **O(target × len(nums))**. Space **O(target)**.

---

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
