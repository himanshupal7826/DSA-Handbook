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

**The question this pattern keeps answering:** *"Which subset of these items fits in the bag and is worth the most?"*

Running example: two items — **A** (weight 2, value 3) and **B** (weight 3, value 4) — and a bag that holds weight **5**.

### Intuition
Every item is either in the bag or out of it. That is one yes/no decision per item, so there are only `2^n` possible bags. List them all, throw away the ones that are too heavy, and keep the most valuable survivor.

### Algorithm
1. Recurse over the items. At item `i` branch twice: **take** it or **skip** it.
2. Carry the running weight and running value down each branch.
3. If the running weight exceeds the capacity, abandon that branch.
4. At the end of the item list, report the running value.
5. Return the maximum reported value.

### Complexity
- Time: **O(2^n)** — every item doubles the number of branches.
- Space: O(n) for the recursion stack.

### Drawbacks
- **The exact wasted work:** take items `A(wt 2, val 3)`, `B(wt 2, val 4)`, `C(wt 3, val 5)` and capacity 5. Two different branches meet in the same place:

  ```text
  take A, skip B  →  C still undecided, 3 capacity free
  skip A, take B  →  C still undecided, 3 capacity free   ← identical situation
  ```

  Both must now answer "best value from {C} with capacity 3". The recursion computes that answer from scratch **twice**. With `n` items the same collision happens at every level, and the duplicate work is what turns a small problem into `2^n`.
- **The fact it fails to exploit:** the only thing a decision hands to the future is the **remaining capacity**. Two different partial selections weighing the same are completely interchangeable from that point on — yet the brute force treats them as different worlds.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **After you have decided the first `i` items, the only thing the rest of the problem can see is how much capacity is left — so answer each `(items decided, capacity left)` question once and remember the answer.**

Think of two people packing the same suitcase for the same trip. One packed two shirts, the other packed a jacket. If both used 3 kg, they now face *exactly* the same problem: same remaining items, same remaining kilos. Whatever is best for one is best for the other. That is the whole optimisation.

### The thought process

```text
We need    : the most valuable subset of items whose weight fits the bag.
Obvious way: try all 2^n subsets.
Too slow   : n = 100 items is 2^100 branches.
Notice     : a branch only passes "remaining capacity" to the future.
Notice too : remaining capacity is an integer in 0..W — few distinct values!
Therefore  : index the answer by (item index, capacity) and reuse it.
Now        : n × W states, O(1) work each → O(n·W).
```

### The recurrence, in words

```text
dp[i][w] means : the best total value obtainable using only the first i items
                 with a bag of capacity w.

dp[i][w] = max( dp[i-1][w]                      ← skip item i: same bag, one fewer item
              , dp[i-1][w - wt[i]] + val[i] )   ← take item i: pay wt[i] of capacity,
                                                  gain val[i], and the leftover problem
                                                  must be solved WITHOUT item i
base case  : dp[0][w] = 0 for every w — with no items on offer you can earn nothing.
answer     : dp[n][W].
```

Both branches read row `i-1`. That single fact is what "each item is used at most once" *means* in table form, and it is what the 1-D version has to protect.

### Why the capacity loop must run downward

The 2-D table is honest but wasteful: row `i` only ever reads row `i-1`, so one array is enough. Overwrite `dp` in place and `dp[w]` silently plays two roles — "the old row" for cells not yet touched this round, "the new row" for cells already touched. The loop direction decides which one you read.

**Demonstrate it.** One item only: weight 2, value 3. Capacity 4. The correct answer is 3 — there is literally one item in the world.

*Upward* (`w = 2, 3, 4`):

```text
start        dp = [0, 0, 0, 0, 0]
w=2  dp[2] = max(dp[2], dp[0]+3) = max(0, 0+3) = 3   dp = [0,0,3,0,0]
w=3  dp[3] = max(dp[3], dp[1]+3) = max(0, 0+3) = 3   dp = [0,0,3,3,0]
w=4  dp[4] = max(dp[4], dp[2]+3) = max(0, 3+3) = 6   dp = [0,0,3,3,6]
                                        ^^^^
                            dp[2] was already updated THIS round —
                            it already contains one copy of the item.
                            Adding the item again claims value 6 from
                            an item we only own once.  WRONG.
```

*Downward* (`w = 4, 3, 2`):

```text
start        dp = [0, 0, 0, 0, 0]
w=4  dp[4] = max(dp[4], dp[2]+3) = max(0, 0+3) = 3   dp = [0,0,0,3,3]
w=3  dp[3] = max(dp[3], dp[1]+3) = max(0, 0+3) = 3   dp = [0,0,0,3,3]
w=2  dp[2] = max(dp[2], dp[0]+3) = max(0, 0+3) = 3   dp = [0,0,3,3,3]
                                        ^^^^
                            dp[2], dp[1], dp[0] have NOT been touched yet
                            this round, so they still describe the world
                            before the item existed.  dp[4] = 3.  CORRECT.
```

The rule falls out of the recurrence: `dp[w]` needs `dp[w - wt]` **from the previous row**. Going downward, every cell you read has a smaller index than the cell you write, and smaller indices are exactly the ones this round has not reached yet.

### Steps

```text
Step 1 → dp = array of W+1 zeros.        (no items chosen yet)
Step 2 → for each item i:
Step 3 →     for w = W down to wt[i]:
Step 4 →         dp[w] = max(dp[w], dp[w-wt[i]] + val[i])
Step 5 → answer = dp[W]
```

### How should I recognize this?

```text
If you see...
  "each item can be used at most once" / "pick a subset"
  a budget, capacity, weight limit, or exact target sum
  small numeric limit (sum or capacity ≤ ~10^4) but many items
        ↓
Think about...
  "What single number does a decision hand to the next decision?"
  If the answer is 'how much budget is left', it is 0/1 knapsack.
        ↓
Use...
  dp over capacity, one pass per item, capacity loop DOWNWARD
    ├─ maximise value        → dp[w] = max(dp[w], dp[w-wt]+val)
    ├─ "is a sum reachable"  → dp[s] = dp[s] || dp[s-num]      (subset sum)
    └─ "how many subsets"    → dp[s] += dp[s-num]              (counting)
  Items reusable instead? → same loop, UPWARD (unbounded knapsack).
```

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

```text
items: A(wt 2, val 3), B(wt 3, val 4)      capacity 5
1-D dp, capacity index 0..5

start            dp = [0, 0, 0, 0, 0, 0]

item A (2,3), w = 5 → 2
  w=5: dp[3]+3 = 0+3 = 3 > 0  → dp[5]=3
  w=4: dp[2]+3 = 0+3 = 3 > 0  → dp[4]=3
  w=3: dp[1]+3 = 0+3 = 3 > 0  → dp[3]=3
  w=2: dp[0]+3 = 0+3 = 3 > 0  → dp[2]=3
                 dp = [0, 0, 3, 3, 3, 3]

item B (3,4), w = 5 → 3
  w=5: dp[2]+4 = 3+4 = 7 > 3  → dp[5]=7     ← dp[2]=3 is "A only", so this is A+B
  w=4: dp[1]+4 = 0+4 = 4 > 3  → dp[4]=4
  w=3: dp[0]+4 = 0+4 = 4 > 3  → dp[3]=4
                 dp = [0, 0, 3, 4, 4, 7]

answer dp[5] = 7   (take A and B: weight 2+3 = 5, value 3+4 = 7)
```

### Interview explanation
"Each item is a single take-or-skip decision, and the only thing a decision passes forward is the capacity still available — so I define `dp[i][w]` as the best value using the first `i` items with capacity `w`, and take the max of skipping (`dp[i-1][w]`) and taking (`dp[i-1][w-wt]+val`). Row `i` only reads row `i-1`, so I collapse it to a single array of size `W+1`. The one subtlety is that I sweep capacity **downward**: `dp[w-wt]` has to still describe the table *before* this item was offered, and downward iteration guarantees the cells I read haven't been rewritten yet — sweeping upward would let one item be taken twice. That is O(n·W) time and O(W) space."

---

## 5. Generic Templates

> One array over capacity, one pass per item, capacity **descending** — descending is what makes it 0/1 instead of unbounded.

```go
// Knapsack01 returns the greatest total value of a sub-collection of items whose
// total weight is at most capacity. Each item may be used at most once.
//
// dp[w] = best value achievable with a bag of capacity w using the items seen so far.
func Knapsack01(weights, values []int, capacity int) int {
    dp := make([]int, capacity+1) // no items considered yet -> every capacity is worth 0

    for i := range weights {
        // Descending: dp[w-weights[i]] must still hold the value from BEFORE
        // item i was offered, or item i would be counted twice.
        for w := capacity; w >= weights[i]; w-- {
            if take := dp[w-weights[i]] + values[i]; take > dp[w] {
                dp[w] = take
            }
        }
    }
    return dp[capacity]
}
```

```python
def knapsack_01(weights, values, capacity):
    """Best total value of a subset of items fitting in `capacity`; each item once.

    dp[w] = best value achievable with a bag of capacity w using the items seen so far.
    """
    dp = [0] * (capacity + 1)          # no items considered yet
    for weight, value in zip(weights, values):
        # Descending: dp[w - weight] must still describe the table BEFORE this
        # item was offered, otherwise the item gets used twice.
        for w in range(capacity, weight - 1, -1):
            dp[w] = max(dp[w], dp[w - weight] + value)
    return dp[capacity]
```

```java
// dp[w] = best value achievable with a bag of capacity w using the items seen so far.
int knapsack01(int[] weights, int[] values, int capacity) {
    int[] dp = new int[capacity + 1];              // no items considered yet
    for (int i = 0; i < weights.length; i++) {
        // Descending keeps dp[w - weights[i]] on the previous item's row.
        for (int w = capacity; w >= weights[i]; w--) {
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[capacity];
}
```

```cpp
// dp[w] = best value achievable with a bag of capacity w using the items seen so far.
int knapsack01(const vector<int>& weights, const vector<int>& values, int capacity) {
    vector<int> dp(capacity + 1, 0);               // no items considered yet
    for (size_t i = 0; i < weights.size(); ++i) {
        // Descending keeps dp[w - weights[i]] on the previous item's row.
        for (int w = capacity; w >= weights[i]; --w) {
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[capacity];
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
Given an array of positive integers, decide whether it can be split into two groups with the same sum.

### Thought Process
1. If the two halves are equal, each one sums to `total / 2`. So an odd `total` is instantly impossible.
2. Once one half is chosen the other half is whatever is left over — so the question collapses to **"is there a subset summing to exactly `total/2`?"**
3. That is a 0/1 knapsack where the "weight" and the "value" of each number are the same thing, and we only care whether the target is *reachable*, not how valuable it is. Boolean table.
4. Each number may be used at most once → sweep the sum axis **downward**.

### The DP, spelled out

```text
What does dp[s] mean?
    dp[s] is true exactly when some subset of the numbers processed so far
    adds up to exactly s.

How is dp[s] computed?
    dp[s] = dp[s]            ← s was already reachable without using num
          OR dp[s - num]     ← s - num was reachable, so adding num reaches s
    (in code: if dp[s-num] { dp[s] = true })

What is the base case?
    dp[0] = true. The empty subset sums to 0, and it is always available.
    Every other cell starts false: nothing else is reachable using no numbers.

Why downward?
    dp[s-num] must still mean "reachable WITHOUT num". Sweeping s from target
    down to num, the cell dp[s-num] sits at a lower index than dp[s], and lower
    indices have not been rewritten yet in this number's pass. Sweeping upward
    would let one num be added to itself.
```

### Dry Run

Input: `nums = [1, 5, 11, 5]` → `total = 22`, `target = 11`

| after processing | sweep | cells that flip to true (source) | reachable sums |
|---|---|---|---|
| *(start)* | — | `dp[0]` | `{0}` |
| `1` | s = 11 → 1 | `dp[1]` ← `dp[0]` | `{0,1}` |
| `5` | s = 11 → 5 | `dp[6]` ← `dp[1]`, `dp[5]` ← `dp[0]` | `{0,1,5,6}` |
| `11` | s = 11 → 11 | `dp[11]` ← `dp[0]` | `{0,1,5,6,11}` |
| `5` | s = 11 → 5 | `dp[10]` ← `dp[5]` | `{0,1,5,6,10,11}` |

`dp[11]` is true.

Output: **`true`** — `{11}` on one side, `{1,5,5}` on the other.

Row two is where the direction earns its keep. Sweeping down with `num = 5`, `dp[6]` is written first by reading `dp[1]` — a value belonging to the previous number's picture — and only afterwards is `dp[5]` set from `dp[0]`. Sweep upward instead and `dp[5]` becomes true first, so `dp[10]` would then read that brand-new `dp[5]` and claim that `{5, 5}` is reachable from a **single** 5.

### Visualization

```text
sum index   0  1  2  3  4  5  6  7  8  9 10 11
start       T  .  .  .  .  .  .  .  .  .  .  .
+1          T  T  .  .  .  .  .  .  .  .  .  .
+5          T  T  .  .  .  T  T  .  .  .  .  .
+11         T  T  .  .  .  T  T  .  .  .  .  T
+5          T  T  .  .  .  T  T  .  .  .  T  T
                                              ^
                                        dp[target] = true
```

### Code

```go
func canPartition(nums []int) bool {
    total := 0
    for _, n := range nums {
        total += n
    }
    if total%2 != 0 { // two equal halves cannot come from an odd total
        return false
    }
    target := total / 2

    // reachable[s] = "some subset of the numbers seen so far sums to exactly s"
    reachable := make([]bool, target+1)
    reachable[0] = true // the empty subset sums to 0

    for _, num := range nums {
        // Downward: reachable[s-num] must still describe the state before num.
        for s := target; s >= num; s-- {
            if reachable[s-num] {
                reachable[s] = true
            }
        }
    }
    return reachable[target]
}
```

```python
def canPartition(nums):
    total = sum(nums)
    if total % 2:                       # odd total -> no equal split
        return False
    target = total // 2

    # reachable[s] = some subset of the numbers seen so far sums to exactly s
    reachable = [False] * (target + 1)
    reachable[0] = True                 # the empty subset sums to 0

    for num in nums:
        # downward, so reachable[s - num] still describes the state before num
        for s in range(target, num - 1, -1):
            if reachable[s - num]:
                reachable[s] = True

    return reachable[target]
```

### Complexity
Time **O(n × target)** — one pass over the `target+1` cells per number. Space **O(target)** — a single boolean row, no 2-D table needed.

---

## 10. Solved Example 2

### Problem — Target Sum (LeetCode 494)
Put a `+` or a `-` in front of every number and concatenate them into an expression. Count how many of the `2^n` sign assignments evaluate to `target`.

### Thought Process
1. Let `P` be the set of numbers that get `+` and `N` the set that gets `-`. Then `sum(P) - sum(N) = target` and `sum(P) + sum(N) = total`.
2. Add the two equations: `2·sum(P) = total + target`, so **`sum(P) = (total + target) / 2`**. Choosing the signs *is* choosing the subset `P`.
3. So the question becomes "how many subsets sum to exactly `P`?" — a 0/1 **counting** knapsack. If `total + target` is odd or `|target| > total`, no subset works; answer 0.
4. Counting instead of max/boolean changes only the combine step: `+=` instead of `max` / `||`.

### The DP, spelled out

```text
What does dp[s] mean?
    dp[s] is the NUMBER OF DISTINCT SUBSETS of the numbers processed so far
    whose elements add up to exactly s.

How is dp[s] computed?
    dp[s] += dp[s - num]
    Read it as: every subset that summed to s-num without using num becomes a
    new, different subset summing to s once num is added. Those are exactly the
    subsets of s that contain num; dp[s]'s existing value already counts the
    subsets that do not.

What is the base case?
    dp[0] = 1. There is exactly one subset summing to 0 — the empty one.
    (Seeding it to 0 would make every count zero forever.)

Why downward?
    dp[s-num] must count subsets that do NOT already contain num. Going downward
    we only read cells this pass has not yet updated, so they are still the
    "without num" counts. Upward would count subsets using num twice.
```

### Dry Run

Input: `nums = [1, 1, 1, 1, 1]`, `target = 3` → `total = 5`, `P = (5 + 3) / 2 = 4`

| after processing | dp[0] | dp[1] | dp[2] | dp[3] | dp[4] |
|---|---|---|---|---|---|
| *(start)* | 1 | 0 | 0 | 0 | 0 |
| 1st `1` | 1 | 1 | 0 | 0 | 0 |
| 2nd `1` | 1 | 2 | 1 | 0 | 0 |
| 3rd `1` | 1 | 3 | 3 | 1 | 0 |
| 4th `1` | 1 | 4 | 6 | 4 | 1 |
| 5th `1` | 1 | 5 | 10 | 10 | 5 |

Output: **`5`**

The rows are the rows of Pascal's triangle, which is the sanity check: `dp[s]` after `k` ones must be `C(k, s)`, and the answer `dp[4] = C(5,4) = 5` — choose which four of the five ones get a `+`.

Trace one row by hand to see the direction at work. Going from the 4th row to the 5th, the sweep is `s = 4, 3, 2, 1`:

```text
s=4: dp[4] += dp[3]  →  1 + 4  = 5      (dp[3] is still the 4-ones value, 4)
s=3: dp[3] += dp[2]  →  4 + 6  = 10     (dp[2] is still 6)
s=2: dp[2] += dp[1]  →  6 + 4  = 10
s=1: dp[1] += dp[0]  →  4 + 1  = 5
```

Every right-hand side was read *before* this pass overwrote it. An upward sweep would have computed `dp[2] += dp[1]` using the already-updated `dp[1]`, i.e. counting the fifth `1` twice inside one subset.

### Visualization

```text
signs:  +1 +1 +1 +1 -1      sum = 3   ✓
        +1 +1 +1 -1 +1      sum = 3   ✓
        +1 +1 -1 +1 +1      sum = 3   ✓
        +1 -1 +1 +1 +1      sum = 3   ✓
        -1 +1 +1 +1 +1      sum = 3   ✓

each row = a choice of which FOUR ones go into P (sum P = 4)
count of such subsets = dp[4] = 5
```

### Code

```go
func findTargetSumWays(nums []int, target int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    // |target| > total is unreachable; an odd (total+target) cannot be halved.
    if target > total || -target > total || (total+target)%2 != 0 {
        return 0
    }
    plus := (total + target) / 2 // the subset that receives '+'

    // ways[s] = number of subsets of the numbers seen so far that sum to s
    ways := make([]int, plus+1)
    ways[0] = 1 // exactly one subset sums to 0: the empty one

    for _, num := range nums {
        // Downward: ways[s-num] must still count subsets that exclude num.
        for s := plus; s >= num; s-- {
            ways[s] += ways[s-num]
        }
    }
    return ways[plus]
}
```

```python
def findTargetSumWays(nums, target):
    total = sum(nums)
    # |target| > total is unreachable; an odd (total + target) cannot be halved
    if abs(target) > total or (total + target) % 2:
        return 0
    plus = (total + target) // 2        # the subset that receives '+'

    ways = [0] * (plus + 1)             # ways[s] = # subsets summing to s
    ways[0] = 1                         # the empty subset

    for num in nums:
        # downward, so ways[s - num] still excludes num
        for s in range(plus, num - 1, -1):
            ways[s] += ways[s - num]

    return ways[plus]
```

### Complexity
Time **O(n × P)** where `P = (total + target) / 2` — one sweep of the row per number. Space **O(P)**.

---

## 11. Solved Example 3

### Problem — Last Stone II (LeetCode 1049)
Repeatedly smash two stones together; the survivor weighs the difference. Return the smallest possible weight of the last remaining stone (0 if none remains).

### Thought Process
1. Every smash gives one stone a `+` and one a `-`. Unwinding all the smashes, the final weight is `|sum(group A) − sum(group B)|` for some split of the stones into two groups.
2. Write `a = sum(A)` and `b = total − a`. The leftover is `|total − 2a|`, minimised by pushing `a` as close to `total/2` as possible **from below**.
3. So: find the **largest reachable subset sum `a ≤ total/2`** — a boolean 0/1 knapsack over the sums `0..total/2`.
4. Answer `total − 2a`. Each stone belongs to exactly one group, so the sum axis sweeps **downward**.

### The DP, spelled out

```text
What does dp[s] mean?
    dp[s] is true exactly when some subset of the stones seen so far weighs
    exactly s.

How is dp[s] computed?
    dp[s] = dp[s] OR dp[s - stone]
    "s was already reachable" OR "s - stone was reachable, so throw this stone
    onto that subset".

What is the base case?
    dp[0] = true — the empty pile weighs 0. All other cells false.

Why downward?
    Each stone exists once. dp[s-stone] has to mean "reachable without this
    stone"; downward sweeping only reads indices this pass has not yet written.
```

### Dry Run

Input: `stones = [2, 7, 4, 1, 8, 1]` → `total = 23`, `target = 23 / 2 = 11`

| after stone | cells that flip to true | reachable sums ≤ 11 |
|---|---|---|
| *(start)* | `dp[0]` | `{0}` |
| `2` | `dp[2]` | `{0,2}` |
| `7` | `dp[9]`, `dp[7]` | `{0,2,7,9}` |
| `4` | `dp[11]`, `dp[6]`, `dp[4]` | `{0,2,4,6,7,9,11}` |
| `1` | `dp[10]`,`dp[8]`,`dp[5]`,`dp[3]`,`dp[1]` | `{0,1,2,3,4,5,6,7,8,9,10,11}` |
| `8` | *(none new)* | unchanged |
| `1` | *(none new)* | unchanged |

Largest reachable `a ≤ 11` is `11` (e.g. `2 + 8 + 1`).

Output: **`23 − 2 × 11 = 1`**

The `4` row is the one to stare at: sweeping down, `dp[11]` is written first by reading `dp[7]` (true, set by the previous stone), and `dp[6]` is written later by reading `dp[2]`. Because `dp[7]` and `dp[2]` both belong to the *previous* stone's picture, no stone is reused. Had we swept upward, `dp[4]` would be set first (from `dp[0]`), and then `dp[8]` would read that fresh `dp[4]` and claim weight 8 from a single 4-stone.

### Visualization

```text
total = 23, aim for a split as even as possible

           a = 11                  total - a = 12
   [ 2 , 8 , 1 ]              [ 7 , 4 , 1 ]
        \                          /
         \____ 12 - 11 = 1 ______ /

reachable sums ≤ 11 :  0 1 2 3 4 5 6 7 8 9 10 11
                                              ^ best a
answer = 23 - 2*11 = 1
```

### Code

```go
func lastStoneWeightII(stones []int) int {
    total := 0
    for _, s := range stones {
        total += s
    }
    target := total / 2 // the closest a group can get to half, from below

    // reachable[s] = "some subset of the stones seen so far weighs exactly s"
    reachable := make([]bool, target+1)
    reachable[0] = true // the empty pile

    for _, stone := range stones {
        // Downward: each stone lands in exactly one group.
        for s := target; s >= stone; s-- {
            if reachable[s-stone] {
                reachable[s] = true
            }
        }
    }

    best := 0
    for s := target; s >= 0; s-- { // largest reachable sum not exceeding half
        if reachable[s] {
            best = s
            break
        }
    }
    return total - 2*best
}
```

```python
def lastStoneWeightII(stones):
    total = sum(stones)
    target = total // 2                 # closest a group can get to half, from below

    reachable = [False] * (target + 1)  # reachable[s] = some subset weighs exactly s
    reachable[0] = True                 # the empty pile

    for stone in stones:
        for s in range(target, stone - 1, -1):   # downward: one group per stone
            if reachable[s - stone]:
                reachable[s] = True

    best = max(s for s in range(target + 1) if reachable[s])
    return total - 2 * best
```

### Complexity
Time **O(n × total/2)** — one sweep per stone over half the total weight. Space **O(total/2)** for the boolean row.

---

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
