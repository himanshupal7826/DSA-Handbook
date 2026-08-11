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

**The question this pattern keeps answering:** *"Each day I can do one of a few things; what sequence of decisions ends up best?"*

Running example: prices `[1, 3, 2, 4]`, unlimited buy/sell, and you may hold at most one share.

### Intuition
On every day you either act or you don't, and what you're allowed to do depends on whether you currently own a share. Branch on the decision, recurse into the next day, and keep the better outcome.

### Algorithm
1. `best(day, owning)` = best profit obtainable from `day` onward, given whether you own a share.
2. If `day == n`, return 0 — no future decisions left.
3. **Do nothing:** `best(day+1, owning)`.
4. **Act:** if `owning`, sell → `prices[day] + best(day+1, false)`; if not, buy → `-prices[day] + best(day+1, true)`.
5. Return the larger of the two.

### Complexity
- Time: **O(2^n)** — two branches every day.
- Space: O(n) recursion stack.

### Drawbacks
- Only two things ever distinguish one call from another: the day, and whether you're holding. Yet the recursion re-derives them constantly:

```text
prices = [1, 3, 2, 4]

buy@0, sell@1, buy@2  ──▶ best(3, owning=true)
buy@0, sell@1, skip@2 ──▶ best(3, owning=false)
skip@0, buy@1, skip@2 ──▶ best(3, owning=true)   ← identical to the first
skip@0, skip@1, buy@2 ──▶ best(3, owning=true)   ← and again
```

  Three different histories, same future. The profit already banked differs, but the *decision problem* from day 3 onward is byte-for-byte the same.
- What the brute force fails to exploit: **the future depends on the situation you are in, not on the story of how you got there.** Here there are only two situations per day, so `2n` states — not `2^n`.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Name the handful of situations ("states") you can be in at the close of a day, draw one arrow per legal action, and carry a single running best for each state as you sweep the days forward.**

It is a board game with two or three squares. Each day, every square asks "what's the best I can be worth, either by staying put or by receiving a token from a square that has an arrow pointing at me?" You only ever track one number per square, so the whole array of days collapses into two or three scalars.

### The thought process

```text
We need    : the best outcome of a long sequence of daily decisions.
Obvious way: branch on every decision.
Too slow   : 2^n.
Notice     : the only thing that carries forward is "do I hold a share?"
             (plus a cooldown flag, or a transaction counter, if the
              problem adds one).
Notice too : that is a tiny finite set of situations — a state machine.
Therefore  : one running best per state, updated once per day.
Now        : O(n * states) time and O(states) space.
```

### The machine, drawn

The base machine has two states. Everything else in this chapter is this picture with extra boxes.

```text
       stay (do nothing)                    stay (do nothing)
            ┌───┐                                ┌───┐
            v   │                                v   │
        ┌────────────┐   buy:  hold = cash - p   ┌────────────┐
        │    cash    │ ────────────────────────▶ │    hold    │
        │ own 0 shrs │                           │ own 1 shr  │
        └────────────┘ ◀──────────────────────── └────────────┘
                         sell: cash = hold + p

  cash = the best profit I can be sitting on today while owning nothing
  hold = the best profit I can be sitting on today while owning one share
         (a negative number early on — you have spent money and banked none)
```

Each day, at price `p`:

```text
cash = max(cash, hold + p)      stay in cash, or sell the share I hold
hold = max(hold, cash - p)      keep holding,  or spend cash to buy today
```

Base case: `cash = 0` (you start owning nothing and having earned nothing) and `hold = -infinity` (owning a share before day 0 is impossible, and the sentinel must lose every `max`). Starting `hold` at `0` would be a bug: it would claim you can own a share for free.

**Variants are new boxes and new arrows, nothing more:**

| Variant | Change to the machine |
|---|---|
| At most one transaction (LC 121) | `hold = max(hold, -p)` — the buy comes from a fixed 0 baseline, not from `cash`, so previous profits can't fund a second purchase |
| Transaction fee (LC 714) | charge it once per round trip: `cash = max(cash, hold + p - fee)` |
| Cooldown (LC 309) | split `cash` into `sold` (sold *today*, frozen) and `rest` (idle, free to buy); `rest` receives from `sold` a day late |
| At most `k` transactions (LC 188) | `k` stacked copies of the pair: `buy[j]`, `sell[j]` |

### Why every update must read *yesterday's* numbers

All the transitions describe "state at the end of day `d`, computed from states at the end of day `d-1`". If you overwrite a variable and then read it again in the same day, you have silently allowed two actions on one day.

For the two-state machine that happens to be harmless (buying and selling on the same day nets zero). For **cooldown it is a real bug.** Correct: `rest` may only absorb `sold` from the *previous* day — that one-day gap *is* the cooldown. Watch it vanish if you feed `rest` the freshly-computed `sold`:

```text
prices = [1, 3, 2, 4]        correct answer with cooldown: 3  (buy@1, sell@4)

  BROKEN (rest reads today's sold)       CORRECT (everything reads yesterday)
  p=1: hold=-1 sold=0 rest=0             p=1: hold=-1  sold=-inf rest=0
  p=3: hold=-1 sold=2 rest=2             p=3: hold=-1  sold=2    rest=0
  p=2: hold=0  sold=2 rest=2  ← bought   p=2: hold=-1  sold=1    rest=2
       on the same day it sold                (rest only NOW learns about the
  p=4: hold=0  sold=4 rest=4               sale from p=3 — one day later)
                                         p=4: hold=-1  sold=3    rest=2

  answer 4  ✗  (that's the no-cooldown   answer 3  ✓
                answer: 1->3 and 2->4)
```

The fix is one line: snapshot the three values into `prevHold, prevSold, prevRest` at the top of the loop and compute every new value from the snapshot.

### Steps

```text
Step 1 → List the states. Ask: "what must I remember at the end of a day?"
Step 2 → Give each state a variable and an English sentence.
Step 3 → Draw one arrow per legal action, and label it with its price effect.
Step 4 → Initialise: 0 for reachable start states, -infinity for the rest.
Step 5 → For each day: snapshot, then apply every transition to the snapshot.
Step 6 → Answer = the best terminal state (never one where you still hold).
```

### How should I recognize this?

```text
If you see...
  a timeline of days/steps, a small set of modes you can be in,
  and rules about what you may do in each mode:
  "buy/sell", "at most k transactions", "cooldown", "fee",
  "cannot do X twice in a row"
        ↓
Think about...
  "What is the complete list of situations I can be in at the end of a step?"
  Each situation is one variable.
        ↓
Use...
  one running best per state, swept forward over the days
  2 states  -> cash / hold
  3 states  -> hold / sold / rest        (cooldown)
  2k states -> buy[1..k] / sell[1..k]    (bounded transactions)
  and ALWAYS compute the new values from a snapshot of the old ones
```

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

```text
Cooldown machine (LeetCode 309) — three states, four arrows.

                buy:  hold = max(hold, prevRest - p)
        ┌────────────────────────────────────────────┐
        │                                            v
  ┌───────────┐                              ┌──────────────┐
  │   rest    │                              │     hold     │
  │ idle, may │                              │  own 1 share │
  │ buy today │                              └──────────────┘
  └───────────┘                                     │
        ^                                           │ sell:
        │                                           │ sold = prevHold + p
        │  cooldown expires:                        v
        │  rest = max(prevRest, prevSold)    ┌──────────────┐
        └────────────────────────────────────│     sold     │
                                             │ sold TODAY,  │
                                             │ frozen       │
                                             └──────────────┘

  the missing arrow is the point: there is NO sold ──▶ hold arrow.
  You must pass through `rest`, which costs exactly one day.
```

### Interview explanation
"I'd model this as a small state machine. At the end of each day I'm in one of a few situations — holding a share or not, plus a cooldown or transaction-count dimension if the problem adds one — and I keep one running best profit per situation. Each legal action is an arrow: buying moves me from `cash` to `hold` and costs today's price, selling moves me back and pays it. So per day it's just `cash = max(cash, hold + price)` and `hold = max(hold, cash - price)`. I start `cash` at 0 and `hold` at negative infinity, since holding before day zero is impossible. The one thing to be careful about is computing every new value from yesterday's snapshot — with a cooldown, reading a value you just overwrote silently lets you buy and sell on the same day. It's O(n) time and O(1) space for the two- and three-state versions, O(n·k) time and O(k) space when there's a transaction cap."

---

## 5. Generic Templates

> One running best per state; snapshot yesterday, then apply every arrow.

```go
// MaxProfitUnlimited is the two-state machine with an optional per-round-trip
// fee (pass fee = 0 for the plain unlimited-transactions problem).
//   cash = best profit today while owning nothing
//   hold = best profit today while owning one share
func MaxProfitUnlimited(prices []int, fee int) int {
    cash, hold := 0, -1<<62 // holding before day 0 is impossible

    for _, p := range prices {
        prevCash, prevHold := cash, hold // yesterday's snapshot

        cash = max(prevCash, prevHold+p-fee) // stay in cash, or sell
        hold = max(prevHold, prevCash-p)     // keep holding, or buy today
    }
    return cash // never end the sequence still holding
}

// MaxProfitAtMostK stacks k copies of the buy/sell pair.
//   buy[j]  = best profit after the j-th purchase (currently holding)
//   sell[j] = best profit after the j-th sale     (currently in cash)
func MaxProfitAtMostK(prices []int, k int) int {
    n := len(prices)
    if n == 0 || k <= 0 {
        return 0
    }

    // More than n/2 transactions can never be used: each needs two days.
    // Fall back to grabbing every upward step.
    if k >= n/2 {
        profit := 0
        for i := 1; i < n; i++ {
            if prices[i] > prices[i-1] {
                profit += prices[i] - prices[i-1]
            }
        }
        return profit
    }

    buy := make([]int, k+1)
    sell := make([]int, k+1)
    for j := 1; j <= k; j++ {
        buy[j] = -1 << 62 // no purchase has happened yet
    }

    for _, p := range prices {
        for j := 1; j <= k; j++ {
            buy[j] = max(buy[j], sell[j-1]-p) // fund the j-th buy from j-1 sales
            sell[j] = max(sell[j], buy[j]+p)  // close the j-th position
        }
    }
    return sell[k]
}
```

```python
def max_profit_unlimited(prices, fee=0):
    """Two-state machine; fee is charged once per completed round trip."""
    cash, hold = 0, float('-inf')          # holding before day 0 is impossible

    for p in prices:
        prev_cash, prev_hold = cash, hold  # yesterday's snapshot
        cash = max(prev_cash, prev_hold + p - fee)   # stay, or sell
        hold = max(prev_hold, prev_cash - p)         # stay, or buy today
    return cash                            # never end still holding


def max_profit_at_most_k(prices, k):
    """k stacked buy/sell layers.
    buy[j]  = best profit after the j-th purchase (holding)
    sell[j] = best profit after the j-th sale     (in cash)"""
    n = len(prices)
    if n == 0 or k <= 0:
        return 0

    if k >= n // 2:                        # cap is unreachable: take every rise
        return sum(max(0, prices[i] - prices[i - 1]) for i in range(1, n))

    buy = [float('-inf')] * (k + 1)
    sell = [0] * (k + 1)

    for p in prices:
        for j in range(1, k + 1):
            buy[j] = max(buy[j], sell[j - 1] - p)    # fund j-th buy from j-1 sales
            sell[j] = max(sell[j], buy[j] + p)       # close the j-th position
    return sell[k]
```

```java
public class StateMachineDP {
    // Two-state machine; fee is charged once per completed round trip.
    public static int maxProfitUnlimited(int[] prices, int fee) {
        long cash = 0, hold = Long.MIN_VALUE / 4;   // cannot hold before day 0

        for (int p : prices) {
            long prevCash = cash, prevHold = hold;  // yesterday's snapshot
            cash = Math.max(prevCash, prevHold + p - fee);  // stay, or sell
            hold = Math.max(prevHold, prevCash - p);        // stay, or buy
        }
        return (int) cash;
    }

    // k stacked buy/sell layers.
    public static int maxProfitAtMostK(int[] prices, int k) {
        int n = prices.length;
        if (n == 0 || k <= 0) return 0;

        if (k >= n / 2) {                          // cap unreachable
            int profit = 0;
            for (int i = 1; i < n; i++)
                if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
            return profit;
        }

        long[] buy = new long[k + 1];
        long[] sell = new long[k + 1];
        for (int j = 1; j <= k; j++) buy[j] = Long.MIN_VALUE / 4;

        for (int p : prices) {
            for (int j = 1; j <= k; j++) {
                buy[j] = Math.max(buy[j], sell[j - 1] - p);  // fund j-th buy
                sell[j] = Math.max(sell[j], buy[j] + p);     // close it
            }
        }
        return (int) sell[k];
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <vector>
using namespace std;

// Two-state machine; fee is charged once per completed round trip.
int maxProfitUnlimited(const vector<int>& prices, int fee) {
    long long cash = 0, hold = LLONG_MIN / 4;      // cannot hold before day 0

    for (int p : prices) {
        long long prevCash = cash, prevHold = hold;      // yesterday's snapshot
        cash = max(prevCash, prevHold + p - fee);        // stay, or sell
        hold = max(prevHold, prevCash - p);              // stay, or buy
    }
    return (int)cash;
}

// k stacked buy/sell layers.
int maxProfitAtMostK(const vector<int>& prices, int k) {
    int n = (int)prices.size();
    if (n == 0 || k <= 0) return 0;

    if (k >= n / 2) {                              // cap unreachable
        int profit = 0;
        for (int i = 1; i < n; ++i)
            if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
        return profit;
    }

    vector<long long> buy(k + 1, LLONG_MIN / 4), sell(k + 1, 0);

    for (int p : prices) {
        for (int j = 1; j <= k; ++j) {
            buy[j] = max(buy[j], sell[j - 1] - p);       // fund the j-th buy
            sell[j] = max(sell[j], buy[j] + p);          // close the position
        }
    }
    return (int)sell[k];
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
You may complete **at most one** transaction: buy on one day and sell on a later day. Return the maximum profit, or `0` if no profitable pair exists.

### Thought Process
1. **What do the states mean?** Two variables, each holding a running best over all days seen so far.
   `cash` = *the best profit I can be sitting on at the end of today, having already sold (or never bought).*
   `hold` = *the best profit I can be sitting on at the end of today while owning the one share I am allowed to buy* — a negative number, because money went out and none has come back.
2. **How do we compute them?** At price `p`:
   `cash = max(cash, hold + p)` — either stay in cash, or sell the share I'm holding for `p`.
   `hold = max(hold, -p)` — either keep the share I have, or buy today. Note the term is `-p`, **not** `cash - p`: with only one transaction allowed, the purchase must start from a zero baseline. Funding it from `cash` would spend the profit of an earlier sale, which is a second transaction.
3. **What is the base case?** `cash = 0`: before day 0 you own nothing and have earned nothing. `hold = -infinity`: owning a share before day 0 is impossible, and the sentinel has to lose every `max`. Setting `hold = 0` would claim a free share and inflate the answer by the first sale price.
4. **Why forward, and why a snapshot?** Days are processed left to right because a state at day `d` is defined from day `d-1`. Here `hold` never reads `cash`, so the two lines are independent and order does not matter — but writing `cash` first keeps the habit that saves you in the cooldown variant.
5. Answer is `cash` after the last day — you would never choose to end still holding.

### Dry Run

Input: `prices = [7, 1, 5, 3, 6, 4]`

| day | `p` | `hold + p` (sell today) | `cash` = max(prev, that) | `-p` (buy today) | `hold` = max(prev, that) |
|-----|-----|--------------------------|---------------------------|-------------------|---------------------------|
| — | start | — | **0** | — | **-inf** |
| 0 | 7 | `-inf + 7` | **0** | -7 | **-7** |
| 1 | 1 | `-7 + 1 = -6` | **0** | -1 | **-1** |
| 2 | 5 | `-1 + 5 = 4` | **4** | -5 | **-1** |
| 3 | 3 | `-1 + 3 = 2` | **4** | -3 | **-1** |
| 4 | 6 | `-1 + 6 = 5` | **5** | -6 | **-1** |
| 5 | 4 | `-1 + 4 = 3` | **5** | -4 | **-1** |

Output: **5** — buy at 1 (day 1), sell at 6 (day 4).

Day 2 is the row worth studying: `cash` jumps to 4 by selling at 5, but `hold` stays at `-1`. The machine keeps both worlds alive simultaneously, so when day 4's price of 6 arrives, the still-open position bought at 1 is right there waiting. A single-variable "best so far" cannot do that.

### Visualization

```text
        stay                                     stay
       ┌───┐                                    ┌───┐
       v   │                                    v   │
  ┌──────────┐    buy: hold = max(hold, -p)    ┌──────────┐
  │   cash   │ ──────────────────────────────▶ │   hold   │
  │  own 0   │                                 │  own 1   │
  └──────────┘ ◀────────────────────────────── └──────────┘
                 sell: cash = max(cash, hold+p)

prices:   7     1     5     3     6     4
cash:     0     0     4     4     5     5     <-- answer
hold:    -7    -1    -1    -1    -1    -1
               ^                 ^
               |                 |
          cheapest buy      best sale against it
             so far            (-1) + 6 = 5
```

### Code

```go
// maxProfit solves "at most one transaction" with a two-state machine.
//   cash = best profit today while owning nothing
//   hold = best profit today while owning the one permitted share
func maxProfit(prices []int) int {
    cash, hold := 0, -1<<62 // owning a share before day 0 is impossible

    for _, p := range prices {
        prevCash, prevHold := cash, hold // yesterday's snapshot

        cash = max(prevCash, prevHold+p) // stay in cash, or sell today
        hold = max(prevHold, -p)         // keep the share, or buy today.
        // -p, not prevCash-p: only ONE transaction is allowed, so the
        // purchase cannot be funded by an earlier sale.
    }
    return cash // never end still holding
}
```

```python
def maxProfit(prices):
    cash, hold = 0, float('-inf')     # cannot own a share before day 0

    for p in prices:
        prev_cash, prev_hold = cash, hold          # yesterday's snapshot
        cash = max(prev_cash, prev_hold + p)       # stay in cash, or sell
        hold = max(prev_hold, -p)                  # keep it, or buy today
        # -p (not prev_cash - p): one transaction only, so an earlier
        # sale's profit may not fund this purchase.
    return cash                       # never end still holding
```

### Complexity
Time O(n) — one pass, two comparisons per day. Space O(1) — two scalars, regardless of how long the price series is.

---

## 10. Solved Example 2

### Problem — Cooldown (LeetCode 309)
Unlimited transactions, but after you sell you must **wait one full day** before buying again. Maximize profit.

### Thought Process
1. **What do the states mean?** The cooldown forces `cash` to split in two, because "in cash and free to buy" and "in cash but frozen" behave differently tomorrow.
   `hold` = *best profit at the end of today while owning a share.*
   `sold` = *best profit at the end of today, having sold **today** — so I am frozen and cannot buy tomorrow.*
   `rest` = *best profit at the end of today, owning nothing and free to buy tomorrow.*
2. **How do we compute them?** From yesterday's values:
   `hold = max(prevHold, prevRest - p)` — keep holding, or buy today; buying is only legal out of `rest`, never out of `sold`. **That missing arrow is the cooldown.**
   `sold = prevHold + p` — the only way to be in `sold` is to have been holding yesterday and sell today.
   `rest = max(prevRest, prevSold)` — stay idle, or arrive from yesterday's `sold` now that the freeze has expired.
3. **What is the base case?** `rest = 0` (day zero: idle, nothing earned), `hold = -infinity` (cannot own a share yet), `sold = -infinity` (cannot have sold yet). The two sentinels must lose every `max`; `0` would grant a free share or a free imaginary sale.
4. **Why the snapshot is mandatory here.** Every right-hand side above is yesterday's value. Feed `rest` today's freshly-written `sold` and you let it buy on the same day it sold — the cooldown disappears. On `prices = [1,3,2,4]` the broken version returns **4** (`1→3` and `2→4`, back-to-back) while the correct answer is **3** (`1→4`). Same code shape, one-day difference, wrong answer.
5. Answer is `max(sold, rest)` — the two ways to finish without a share. Ending in `hold` would mean money still tied up.

### Dry Run

Input: `prices = [1, 2, 3, 0, 2]`

| day | `p` | `hold` = max(prevHold, prevRest−p) | `sold` = prevHold + p | `rest` = max(prevRest, prevSold) |
|-----|-----|------------------------------------|------------------------|-----------------------------------|
| — | start | **-inf** | **-inf** | **0** |
| 0 | 1 | `max(-inf, 0−1)` = **-1** | `-inf + 1` = **-inf** | `max(0, -inf)` = **0** |
| 1 | 2 | `max(-1, 0−2)` = **-1** | `-1 + 2` = **1** | `max(0, -inf)` = **0** |
| 2 | 3 | `max(-1, 0−3)` = **-1** | `-1 + 3` = **2** | `max(0, 1)` = **1** |
| 3 | 0 | `max(-1, 1−0)` = **1** | `-1 + 0` = **-1** | `max(1, 2)` = **2** |
| 4 | 2 | `max(1, 2−2)` = **1** | `1 + 2` = **3** | `max(2, -1)` = **2** |

Output: **`max(sold, rest) = max(3, 2) = 3`** — buy at 1, sell at 3, cooldown, buy at 0, sell at 2.

Day 3 is where the cooldown is visible. `hold` becomes `1` by buying at price 0 out of `prevRest = 1`. That `1` had entered `rest` on **day 2**, from the sale made on **day 1**. The profit had to sit in `sold` for a day before `rest` would accept it — precisely one skipped buying opportunity.

### Visualization

```text
                buy:  hold = max(prevHold, prevRest − p)
        ┌────────────────────────────────────────────┐
        │                                            v
  ┌───────────┐                              ┌──────────────┐
  │   rest    │                              │     hold     │
  │ idle, may │                              │  own 1 share │
  │ buy today │                              └──────────────┘
  └───────────┘                                     │
        ^                                           │ sell:
        │  cooldown expires:                        │ sold = prevHold + p
        │  rest = max(prevRest, prevSold)           v
        │                                    ┌──────────────┐
        └────────────────────────────────────│     sold     │
                                             │ sold TODAY,  │
                                             │ frozen       │
                                             └──────────────┘
        there is NO sold ──▶ hold arrow. That absence IS the cooldown.

prices:    1     2     3     0     2
hold:     -1    -1    -1     1     1
sold:   -inf     1     2    -1     3   <-- answer 3
rest:      0     0     1     2     2
                       ^     ^
                       |     └── buys at 0 using the profit that
                       └──────── landed in rest one day AFTER the sale
```

### Code

```go
// maxProfitCooldown solves unlimited transactions with a one-day rest after
// every sale, using a three-state machine.
//   hold = best profit today while owning a share
//   sold = best profit today, having sold TODAY (frozen tomorrow)
//   rest = best profit today, owning nothing and free to buy tomorrow
func maxProfitCooldown(prices []int) int {
    const neg = -1 << 62
    hold, sold, rest := neg, neg, 0

    for _, p := range prices {
        // Snapshot yesterday. Without this, `rest` could absorb a sale made
        // today and buy again immediately, erasing the cooldown.
        prevHold, prevSold, prevRest := hold, sold, rest

        hold = max(prevHold, prevRest-p) // keep it, or buy — only out of rest
        sold = prevHold + p              // the only route into sold: sell today
        rest = max(prevRest, prevSold)   // stay idle, or thaw from yesterday
    }

    return max(sold, rest) // finishing while still holding is never best
}
```

```python
def maxProfitCooldown(prices):
    NEG = float('-inf')
    hold, sold, rest = NEG, NEG, 0

    for p in prices:
        # Snapshot yesterday: if `rest` read today's `sold`, it could buy on the
        # same day it sold and the cooldown would vanish.
        prev_hold, prev_sold, prev_rest = hold, sold, rest

        hold = max(prev_hold, prev_rest - p)   # keep, or buy — only out of rest
        sold = prev_hold + p                   # only route into sold
        rest = max(prev_rest, prev_sold)       # stay idle, or thaw

    return max(sold, rest)                     # never end still holding
```

### Complexity
Time O(n) — three constant-time updates per day. Space O(1) — three scalars.

---

## 11. Solved Example 3

### Problem — Stock IV (LeetCode 188)
Complete **at most `k`** transactions over the price series. Maximize total profit.

### Thought Process
1. **What do the states mean?** The two-state machine, stacked `k` times — one floor per transaction.
   `buy[j]` = *best profit at the end of today, having opened the `j`-th position and still holding it.*
   `sell[j]` = *best profit at the end of today, having completed exactly `j` sales and holding nothing.*
2. **How do we compute them?** At price `p`, for each floor `j = 1..k`:
   `buy[j] = max(buy[j], sell[j-1] - p)` — keep the `j`-th position open, or open it today. The capital comes from `sell[j-1]`: the profit after `j-1` completed transactions. That subscript is the transaction counter incrementing.
   `sell[j] = max(sell[j], buy[j] + p)` — keep the `j`-th sale as it was, or close today's position now.
3. **What is the base case?** `sell[0] = 0` — zero transactions completed, zero profit; this is the ground floor every ladder climbs from. `sell[j] = 0` for all `j` (doing nothing is always allowed, and profits are never negative). `buy[j] = -infinity` for every `j` — no position has been opened yet.
4. **Why this direction, and is the in-place read safe?** Days sweep forward as always. Inside a day, `j` ascends, so `sell[j]` reads the `buy[j]` that was just written this iteration. That looks like the cooldown bug, but here it is provably harmless: if `buy[j]` was just set to `sell[j-1] - p`, then `sell[j]` becomes `sell[j-1] - p + p = sell[j-1]` — buying and selling at the same price on the same day, a no-op that can never beat an existing value. The `j-1` read in the buy line is also safe: floor `j-1` is finished for today before floor `j` starts.
5. **The shortcut.** A transaction needs at least two days, so at most `n/2` of them fit. If `k >= n/2` the cap is unreachable and the answer is simply the sum of every upward price step — this avoids allocating a huge `k`-sized array when `k` is like `10^9`.

### Dry Run

Input: `k = 2`, `prices = [3, 2, 6, 5, 0, 3]` (`n = 6`, and `k = 2 < 3 = n/2`, so the full ladder runs)

Start: `sell = [0, 0, 0]`, `buy = [–, -inf, -inf]`.

| day | `p` | `buy[1]` = max(prev, `sell[0]`−p) | `sell[1]` = max(prev, `buy[1]`+p) | `buy[2]` = max(prev, `sell[1]`−p) | `sell[2]` = max(prev, `buy[2]`+p) |
|-----|-----|------------------------------------|------------------------------------|------------------------------------|------------------------------------|
| 0 | 3 | `max(-inf, 0−3)` = **-3** | `max(0, -3+3)` = **0** | `max(-inf, 0−3)` = **-3** | `max(0, -3+3)` = **0** |
| 1 | 2 | `max(-3, 0−2)` = **-2** | `max(0, -2+2)` = **0** | `max(-3, 0−2)` = **-2** | `max(0, -2+2)` = **0** |
| 2 | 6 | `max(-2, -6)` = **-2** | `max(0, -2+6)` = **4** | `max(-2, 4−6)` = **-2** | `max(0, -2+6)` = **4** |
| 3 | 5 | `max(-2, -5)` = **-2** | `max(4, 3)` = **4** | `max(-2, 4−5)` = **-1** | `max(4, -1+5)` = **4** |
| 4 | 0 | `max(-2, 0−0)` = **0** | `max(4, 0+0)` = **4** | `max(-1, 4−0)` = **4** | `max(4, 4+0)` = **4** |
| 5 | 3 | `max(0, 0−3)` = **0** | `max(4, 0+3)` = **4** | `max(4, 4−3)` = **4** | `max(4, 4+3)` = **7** |

Output: **`sell[2] = 7`** — buy at 2 / sell at 6 (profit 4), then buy at 0 / sell at 3 (profit 3).

Day 4 is the interesting one: `buy[2]` becomes `4`, which reads "I have banked 4 from my first transaction and my second share cost me nothing (price 0), so my net position is `+4`." The `sell[1] - p` term is literally the first transaction's profit being rolled into the second purchase.

### Visualization

```text
the ladder — k stacked copies of the two-state machine

  sell[0] = 0
      │ buy[1] = sell[0] − p
      v
  [ buy[1] ]  ──── sell[1] = buy[1] + p ────▶  [ sell[1] ]
                                                    │ buy[2] = sell[1] − p
                                                    v
                                               [ buy[2] ] ──── + p ──▶ [ sell[2] ]

prices:      3     2     6     5     0     3
buy[1]:     -3    -2    -2    -2     0     0
sell[1]:     0     0     4     4     4     4     first transaction: 2 -> 6
buy[2]:     -3    -2    -2    -1     4     4
sell[2]:     0     0     4     4     4    [7]    second: 0 -> 3, on top of 4
                                          ^
                                       answer
```

### Code

```go
// maxProfitK allows at most k transactions.
//   buy[j]  = best profit today with the j-th position open (holding)
//   sell[j] = best profit today after exactly j completed sales (in cash)
func maxProfitK(k int, prices []int) int {
    n := len(prices)
    if n == 0 || k <= 0 {
        return 0
    }

    // A transaction needs two days, so more than n/2 of them can never be
    // used. Then the answer is just every upward step, and we skip the ladder.
    if k >= n/2 {
        profit := 0
        for i := 1; i < n; i++ {
            if prices[i] > prices[i-1] {
                profit += prices[i] - prices[i-1]
            }
        }
        return profit
    }

    buy := make([]int, k+1)
    sell := make([]int, k+1) // sell[0] = 0: zero transactions, zero profit
    for j := 1; j <= k; j++ {
        buy[j] = -1 << 62 // no position opened yet
    }

    for _, p := range prices {
        for j := 1; j <= k; j++ {
            buy[j] = max(buy[j], sell[j-1]-p) // open the j-th position
            sell[j] = max(sell[j], buy[j]+p)  // close it
        }
    }
    return sell[k]
}
```

```python
def maxProfitK(k, prices):
    n = len(prices)
    if n == 0 or k <= 0:
        return 0

    # A transaction needs two days: more than n // 2 of them cannot be used.
    if k >= n // 2:
        return sum(max(0, prices[i] - prices[i - 1]) for i in range(1, n))

    buy = [float('-inf')] * (k + 1)     # no position opened yet
    sell = [0] * (k + 1)                # sell[0] = 0: the ground floor

    for p in prices:
        for j in range(1, k + 1):
            buy[j] = max(buy[j], sell[j - 1] - p)   # open the j-th position
            sell[j] = max(sell[j], buy[j] + p)      # close it
    return sell[k]
```

### Complexity
Time O(n·k) — `k` constant-time floors per day — collapsing to O(n) whenever the `k >= n/2` shortcut fires. Space O(k) for the two ladders.

---

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
