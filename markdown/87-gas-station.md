# 87 · Gas Station

> **One-liner:** Single pass: reset start when the running tank goes negative.

---

## 1. Overview

### Definition
The **Gas Station** pattern belongs to the *Greedy* family. Single pass: reset start when the running tank goes negative.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
gas station, greedy, circular, running total, reset start.

### Constraints
- Input size where the brute-force complexity would time out — the Gas Station optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Gas Station invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Gas Station is the upgrade.
- The wording maps onto: gas station, greedy, circular, running total, reset start.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Can I get all the way along this route without running out — and where should I start, or where should I stop to refill?"*

### Intuition
Try every starting station and simulate the whole trip.

### Algorithm
1. For each candidate start `i`:
2. &nbsp;&nbsp;Set `tank = 0` and walk all `n` stations in circular order.
3. &nbsp;&nbsp;At each station add its gas and subtract the cost to the next.
4. &nbsp;&nbsp;If the tank ever goes negative, this start fails — try the next one.
5. Return the first start that completes the loop.

### Complexity
- Time: **O(n²)** — `n` candidate starts, each simulated over `n` stations.
- Space: O(1).

### Drawbacks
- Every failed simulation is thrown away entirely. But a failure carries information: it tells you about *many* starting points at once, not just the one you tried.
- That discarded information is exactly what turns this into a single pass.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **When a trip from `i` runs dry at station `j`, every station between `i` and `j` also fails — so skip past `j` instead of retrying them one by one.**

### The thought process

```text
We need    : a starting station from which the loop completes.
Obvious way: simulate from each start.
Too slow   : O(n^2), and each failure is discarded.
Notice     : if starting at i we run dry arriving at j, then for any
             k strictly between i and j we ARRIVED at k with a
             non-negative tank. Starting at k instead means arriving
             with an EMPTY tank — never better. So k fails too.
Therefore  : one failure eliminates the whole block i..j at once.
             Jump the candidate start to j+1.
Now        : each station is examined once → O(n).
```

### Why one failure eliminates a whole block

This is the argument the whole chapter rests on, so it is worth writing out.

Suppose starting at `i` we reach station `k` (with `i < k < j`) carrying `t ≥ 0` units of fuel, and then run dry at `j`.

Starting *at* `k` instead means arriving at `k` with `0` units — that is `t` units **worse**, and `t ≥ 0`. Every subsequent tank reading is therefore at most what it was before, so we still run dry at or before `j`.

```text
start at i:   ... → k (tank = t ≥ 0) → ... → j  RAN DRY
start at k:   ...   k (tank = 0)     → ... → j  ran dry no later
```

So no station in `(i, j)` can succeed. The next candidate worth trying is `j + 1`.

### Why a solution exists exactly when total gas ≥ total cost

Two halves:

- **If `total(gas) < total(cost)`**, the loop consumes more than it provides, so no start can finish. Impossible.
- **If `total(gas) ≥ total(cost)`**, a valid start is *guaranteed* to exist — and the elimination argument shows the last candidate the sweep lands on must be it. Every earlier station was ruled out, and something must work, so it is that one.

That is why the algorithm needs **no second pass to verify**: check the totals once, and the surviving candidate is correct by construction.

### Steps

```text
Step 1 → totalTank = 0, currentTank = 0, start = 0
Step 2 → For i = 0 .. n-1:
Step 3 →     gain = gas[i] - cost[i]
Step 4 →     totalTank += gain
Step 5 →     currentTank += gain
Step 6 →     if currentTank < 0:          ← ran dry arriving here
Step 7 →         start = i + 1            ← everything up to i is eliminated
Step 8 →         currentTank = 0
Step 9 → if totalTank < 0: return -1
Step 10 → return start
```

### The sibling problem: "how few stops?"

Gas Station asks *where to start*. The related family asks *how few refuels* are needed along a one-way route — and that needs a different greedy, because you get to choose **retroactively**.

The trick is that you do not have to decide whether to refuel at a station **when you pass it**. Drive as far as you can, and only when you are about to run dry, look back and take the **largest** tank you passed but did not use.

```text
drive until the fuel runs out
    → then "retroactively" refuel at the best station already passed
    → a max-heap of passed stations makes that O(log n)
```

This works because deferring the decision loses nothing: any station you passed remains available to your past self, and taking the biggest one buys the most range per stop.

| Question | Technique |
|---|---|
| Where can I start and finish the loop? | single sweep with the elimination argument — O(n) |
| Fewest refuel stops to reach the target | max-heap of passed stations — O(n log n) |
| Fewest jumps over a reachable range | contiguous-level sweep — O(n) |

### How should I recognize this?

```text
If you see...
  "circular route", "start where you can complete the circuit"
  "will you run out of fuel/battery/resources"
  "minimum refuels / stops / recharges to reach the target"
        ↓
Think about...
  "When I fail, does that failure rule out more than one candidate?"
  "Must I commit at each station, or can I decide retroactively?"
        ↓
Use...
  find a valid start   → one sweep, reset start on a negative tank
  fewest stops         → max-heap of passed options, refuel when dry
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-87" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Run the tank across stations; when it drops below 0, restart start at the next station</text>
  <!-- stations gas minus cost: +2 +3 -4 +1 -2  -->
  <g>
    <rect x="40"  y="55" width="100" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="90"  y="82" text-anchor="middle" fill="#1e293b">S0 +2</text>
    <rect x="150" y="55" width="100" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="82" text-anchor="middle" fill="#1e293b">S1 +3</text>
    <rect x="260" y="55" width="100" height="44" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="310" y="82" text-anchor="middle" fill="#d97706">S2 −4</text>
    <rect x="370" y="55" width="100" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="420" y="82" text-anchor="middle" fill="#059669" font-weight="700">S3 +1</text>
    <rect x="480" y="55" width="100" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="530" y="82" text-anchor="middle" fill="#059669" font-weight="700">S4 +5</text>
  </g>
  <!-- running tank -->
  <text x="90"  y="130" text-anchor="middle" fill="#64748b">tank 2</text>
  <text x="200" y="130" text-anchor="middle" fill="#64748b">5</text>
  <text x="310" y="130" text-anchor="middle" fill="#b91c1c" font-weight="700">1 → &lt;0</text>
  <text x="420" y="130" text-anchor="middle" fill="#059669">1</text>
  <text x="530" y="130" text-anchor="middle" fill="#059669">6</text>
  <line x1="360" y1="150" x2="380" y2="150" stroke="#475569" marker-end="url(#a-87)"/>
  <text x="310" y="172" text-anchor="middle" fill="#b91c1c">tank &lt; 0 at S2</text>
  <text x="450" y="172" text-anchor="middle" fill="#059669" font-weight="700">restart start = S3</text>
  <text x="320" y="200" text-anchor="middle" fill="#64748b">if total sum ≥ 0, the last restart index is the unique answer</text>
</svg>
```

```text
gas  = [1, 2, 3, 4, 5]
cost = [3, 4, 5, 1, 2]
gain = [-2, -2, -2, 3, 3]      total = 0 ≥ 0, so a solution exists

i=0  gain -2  currentTank -2 < 0  →  start = 1, tank reset
i=1  gain -2  currentTank -2 < 0  →  start = 2, tank reset
i=2  gain -2  currentTank -2 < 0  →  start = 3, tank reset
i=3  gain +3  currentTank  3
i=4  gain +3  currentTank  6

answer: start at station 3
```

### Interview explanation
"The brute force simulates from every start, but each failure tells us more than it looks. If starting at `i` I run dry arriving at `j`, then any station `k` in between was reached with a non-negative tank — so starting at `k` instead means arriving with an empty one, which is never better, and I'd still run dry by `j`. That means one failure eliminates the whole block, so I can jump the candidate start to `j+1` and never re-simulate. That's a single O(n) sweep with O(1) space. I also track the total gain: if total gas is less than total cost no start can work, and if it isn't, a solution is guaranteed to exist — so the candidate the sweep ends on must be correct, with no verification pass needed. The related 'fewest refuels' question needs a different greedy, because you can decide retroactively: drive until you're about to run dry, then take the largest tank among the stations you already passed, which a max-heap gives in O(log n)."

---

## 5. Generic Templates

> One sweep, reset the start on a negative tank. For fewest stops, a max-heap of passed options.

```go
// CanCompleteCircuit returns a starting station index from which the whole
// circuit can be completed, or -1 if none exists.
func CanCompleteCircuit(gas []int, cost []int) int {
    totalTank, currentTank, start := 0, 0, 0

    for i := 0; i < len(gas); i++ {
        gain := gas[i] - cost[i]
        totalTank += gain
        currentTank += gain

        if currentTank < 0 {
            // Ran dry arriving here. Every station from `start` to i is
            // eliminated: each was reached with a non-negative tank, so
            // starting there is never better.
            start = i + 1
            currentTank = 0
        }
    }

    if totalTank < 0 {
        return -1 // the route consumes more than it provides
    }
    // A solution is guaranteed to exist, and everything before `start`
    // has been ruled out — so `start` is it. No verification pass needed.
    return start
}

// MinRefuelStops returns the fewest refuelling stops needed to travel
// `target` miles, or -1 if the target is unreachable.
// stations[i] = {position, fuel}.
func MinRefuelStops(target int, startFuel int, stations [][]int) int {
    passed := &fuelHeap{} // max-heap of fuel at stations already driven past
    heap.Init(passed)

    fuel, stops, index := startFuel, 0, 0

    for fuel < target {
        // Bank every station we can currently reach.
        for index < len(stations) && stations[index][0] <= fuel {
            heap.Push(passed, stations[index][1])
            index++
        }

        if passed.Len() == 0 {
            return -1 // stranded with nothing left to draw on
        }

        // Retroactively refuel at the biggest tank we passed.
        fuel += heap.Pop(passed).(int)
        stops++
    }

    return stops
}

type fuelHeap []int

func (h fuelHeap) Len() int           { return len(h) }
func (h fuelHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h fuelHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *fuelHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *fuelHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def can_complete_circuit(gas, cost):
    """A valid starting station, or -1."""
    total_tank = current_tank = start = 0

    for i in range(len(gas)):
        gain = gas[i] - cost[i]
        total_tank += gain
        current_tank += gain

        if current_tank < 0:
            # Everything from `start` to i is eliminated at once.
            start = i + 1
            current_tank = 0

    if total_tank < 0:
        return -1                       # consumes more than it provides
    return start                        # guaranteed correct, no re-check

def min_refuel_stops(target, start_fuel, stations):
    """Fewest refuelling stops, or -1. stations[i] = (position, fuel)."""
    passed = []                         # max-heap via negation
    fuel, stops, index = start_fuel, 0, 0

    while fuel < target:
        # Bank every station we can currently reach.
        while index < len(stations) and stations[index][0] <= fuel:
            heapq.heappush(passed, -stations[index][1])
            index += 1

        if not passed:
            return -1                   # stranded

        fuel += -heapq.heappop(passed)  # retroactively take the biggest tank
        stops += 1

    return stops
```

```java
import java.util.*;

public class GasStation {
    public static int canCompleteCircuit(int[] gas, int[] cost) {
        int totalTank = 0, currentTank = 0, start = 0;

        for (int i = 0; i < gas.length; i++) {
            int gain = gas[i] - cost[i];
            totalTank += gain;
            currentTank += gain;

            if (currentTank < 0) {      // eliminates the whole block
                start = i + 1;
                currentTank = 0;
            }
        }

        return totalTank < 0 ? -1 : start;
    }

    // stations[i] = {position, fuel}
    public static int minRefuelStops(int target, int startFuel, int[][] stations) {
        PriorityQueue<Integer> passed = new PriorityQueue<>(Comparator.reverseOrder());
        int fuel = startFuel, stops = 0, index = 0;

        while (fuel < target) {
            while (index < stations.length && stations[index][0] <= fuel)
                passed.add(stations[index++][1]);       // bank what we passed

            if (passed.isEmpty()) return -1;            // stranded

            fuel += passed.poll();                       // biggest tank passed
            stops++;
        }
        return stops;
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

int canCompleteCircuit(const vector<int>& gas, const vector<int>& cost) {
    int totalTank = 0, currentTank = 0, start = 0;

    for (int i = 0; i < (int)gas.size(); ++i) {
        int gain = gas[i] - cost[i];
        totalTank += gain;
        currentTank += gain;

        if (currentTank < 0) {          // eliminates the whole block
            start = i + 1;
            currentTank = 0;
        }
    }
    return totalTank < 0 ? -1 : start;
}

// stations[i] = {position, fuel}
int minRefuelStops(int target, int startFuel, const vector<vector<int>>& stations) {
    priority_queue<int> passed;         // max-heap of fuel already driven past
    int fuel = startFuel, stops = 0, index = 0;

    while (fuel < target) {
        while (index < (int)stations.size() && stations[index][0] <= fuel)
            passed.push(stations[index++][1]);

        if (passed.empty()) return -1;  // stranded

        fuel += passed.top();           // retroactively take the biggest tank
        passed.pop();
        ++stops;
    }
    return stops;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Gas Station (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log n)** |
| Time (best)  | — | **O(n log n)** |
| Time (average) | — | **O(n log n)** |
| Space | varies | **O(1)** |

> Sorting dominates; the greedy sweep is O(n).

---

## 7. Common Mistakes

1. Assuming greedy works without proving the exchange argument.
2. Sorting by the wrong key (e.g., start instead of finish time).
3. Ties broken incorrectly, flipping the result.
4. Greedy on a problem that actually needs DP.
5. Not handling the empty / single-element case.
6. Integer overflow in running totals (e.g., gas station).
7. Resetting accumulators at the wrong moment.
8. Off-by-one in reachability (jump game).
9. Forgetting that local optimum ≠ global without the safety proof.
10. Mutating input order when it matters downstream.

---

## 8. Interview Follow-Up Questions

1. **Q: How to know greedy is valid?**
   A: Prove an exchange argument: swapping to the greedy choice never worsens the optimum.

2. **Q: Activity selection key?**
   A: Sort by earliest finish time.

3. **Q: Jump game reachability?**
   A: Track the farthest reachable index.

4. **Q: Jump game II min jumps?**
   A: BFS-like greedy over reach boundaries.

5. **Q: Gas station start?**
   A: Reset start when the running tank goes negative.

6. **Q: Huffman coding?**
   A: Repeatedly merge the two smallest weights (heap).

7. **Q: Greedy vs DP?**
   A: Greedy when local choice is safe; DP when you must compare futures.

8. **Q: Fractional vs 0/1 knapsack?**
   A: Fractional is greedy; 0/1 needs DP.

9. **Q: Min arrows to burst balloons?**
   A: Greedy by end coordinate.

10. **Q: Task scheduling with cooldown?**
   A: Greedy with counts + idle slots, or heap.

11. **Q: Why O(n log n)?**
   A: Sorting dominates the single greedy pass.

12. **Q: Counterexample habit?**
   A: Always try to break greedy with a small case.

13. **Q: Stability of choice?**
   A: Document tie-breaking explicitly.

14. **Q: Interval partitioning (min rooms)?**
   A: Sweep / heap of end times.

15. **Q: Coin change greedy fails when?**
   A: Non-canonical coin systems need DP.

---

## 9. Solved Example 1

### Problem — Gas Station (LeetCode 134)
There are `n` stations in a circle. Station `i` gives `gas[i]` fuel, and driving from `i` to `i+1` costs `cost[i]`. Starting with an empty tank, return the index you must begin at to complete the circuit, or `−1`. The answer is unique if it exists.

### Thought Process
1. Only the difference matters at each station: `gain[i] = gas[i] − cost[i]`.
2. Sweep once, tracking the tank. When it goes negative arriving at `i`, every station from the current candidate through `i` is eliminated — each was reached with a non-negative tank, so starting there is never better.
3. So jump the candidate to `i + 1` and reset the tank.
4. Separately accumulate the total gain. If it is negative, the route consumes more than it provides and no start works.
5. If the total is non-negative a solution is guaranteed, and everything before the surviving candidate has been ruled out — so it is the answer, with no verification pass.

### Dry Run — a solvable route

Input: `gas = [1, 2, 3, 4, 5]`, `cost = [3, 4, 5, 1, 2]`

`gain = [−2, −2, −2, 3, 3]`, total = **0** ≥ 0, so an answer exists.

| i | gain | totalTank | currentTank before | currentTank after | negative? | start |
|---|------|-----------|--------------------|--------------------|-----------|-------|
| 0 | −2 | −2 | 0 | −2 | **yes** | → **1**, tank reset to 0 |
| 1 | −2 | −4 | 0 | −2 | **yes** | → **2**, tank reset to 0 |
| 2 | −2 | −6 | 0 | −2 | **yes** | → **3**, tank reset to 0 |
| 3 | +3 | −3 | 0 | 3 | no | 3 |
| 4 | +3 | **0** | 3 | 6 | no | **3** |

`totalTank = 0 ≥ 0` → return **3** ✓

Verify by simulating from station 3: start empty, take 4 gas → tank 4, pay 1 → 3. Station 4: take 5 → 8, pay 2 → 6. Station 0: take 1 → 7, pay 3 → 4. Station 1: take 2 → 6, pay 4 → 2. Station 2: take 3 → 5, pay 5 → 0. Back at station 3 with a non-negative tank throughout. ✓

### Dry Run — an impossible route

Input: `gas = [2, 3, 4]`, `cost = [3, 4, 3]`

`gain = [−1, −1, 1]`, total = **−1** < 0.

The sweep still runs and lands on some candidate, but the total is negative, so we return **`−1`** ✓ — the circuit consumes 10 units and supplies only 9.

### Visualization

```text
gain :  -2   -2   -2   +3   +3       total = 0

  i=0  tank -2  → negative → start = 1
  i=1  tank -2  → negative → start = 2
  i=2  tank -2  → negative → start = 3
  i=3  tank +3
  i=4  tank +6                       never negative after start=3

  answer: station 3

  one failure at i eliminates EVERY candidate up to i,
  because each was reached with tank >= 0
```

### Code

```go
func canCompleteCircuit(gas []int, cost []int) int {
    totalTank, currentTank, start := 0, 0, 0

    for i := 0; i < len(gas); i++ {
        gain := gas[i] - cost[i]
        totalTank += gain
        currentTank += gain

        if currentTank < 0 {
            // Ran dry arriving at i. Every station from `start` through i
            // was reached with a non-negative tank, so beginning at any of
            // them is no better — the whole block is eliminated at once.
            start = i + 1
            currentTank = 0
        }
    }

    if totalTank < 0 {
        return -1 // the route consumes more than it supplies
    }

    // A solution is guaranteed when totalTank >= 0, and everything before
    // `start` has been ruled out — so `start` is correct by construction.
    return start
}
```

```python
def canCompleteCircuit(gas, cost):
    total_tank = current_tank = start = 0

    for i in range(len(gas)):
        gain = gas[i] - cost[i]
        total_tank += gain
        current_tank += gain

        if current_tank < 0:
            # Eliminates every candidate from `start` through i at once.
            start = i + 1
            current_tank = 0

    if total_tank < 0:
        return -1                       # consumes more than it supplies
    return start                        # guaranteed correct, no re-check
```

### Complexity
Time **O(n)** — one sweep. Space **O(1)**.

---

## 10. Solved Example 2

### Problem — Jump Game II (LeetCode 45)
Each `nums[i]` is the maximum jump length from index `i`. Return the **minimum** number of jumps to reach the last index.

### Thought Process
1. Framed as a journey, this is "fewest stops to traverse the route" — the same question Example 3 asks with fuel.
2. Here the resource is *reach* rather than fuel, and it is replaced rather than accumulated: landing at `i` gives you a fresh range of `nums[i]`.
3. Because a jump permits **any** distance up to `nums[i]`, everything reachable in `k` jumps forms a contiguous range — so a BFS level can be tracked with two numbers instead of a queue.
4. `currentEnd` is the end of the current level; `farthest` is the end of the next.
5. Loop to `n − 2`: arriving at the last index means the journey is over, and continuing would count one stop too many.

### Dry Run

Input: `nums = [2, 3, 1, 1, 4]` → loop `i = 0 .. 3`

| i | `i + nums[i]` | `farthest` | `i == currentEnd`? | jumps | currentEnd |
|---|----------------|------------|---------------------|-------|------------|
| 0 | `0 + 2 = 2` | **2** | `0 == 0` **yes** | **1** | **2** |
| 1 | `1 + 3 = 4` | **4** | `1 == 2` no | 1 | 2 |
| 2 | `2 + 1 = 3` | 4 | `2 == 2` **yes** | **2** | **4** |
| 3 | `3 + 1 = 4` | 4 | `3 == 4` no | 2 | 4 |

Output: **2** ✓ — the route `0 → 1 → 4`.

**The levels, made explicit:**

```text
level 0:  index 0            0 jumps
level 1:  indices 1..2       1 jump   (reachable from 0)
level 2:  indices 3..4       2 jumps  (reachable from 1 or 2)  ← contains the end
```

**Why the loop stops at `n − 2`.** At `i = 4` we would have `i == currentEnd == 4`, incrementing `jumps` to 3 — counting a jump *out of* the destination we had already arrived at.

### Visualization

```text
nums  =  2    3    1    1    4
index :  0    1    2    3    4

level 0: [0]
level 1:      [1    2]              1 jump
level 2:            [3    4]        2 jumps  ★ contains the end

  each level is contiguous, so `currentEnd` and `farthest`
  replace a BFS queue entirely
```

### Code

```go
func jump(nums []int) int {
    jumps := 0
    currentEnd := 0 // end of the level reachable with the jumps counted
    farthest := 0   // end of the level reachable with ONE more jump

    // Stop at n-2: arriving at the last index ends the journey, and
    // continuing would count a jump that is never taken.
    for i := 0; i < len(nums)-1; i++ {
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }

        if i == currentEnd { // the current level is exhausted
            jumps++
            currentEnd = farthest
        }
    }

    return jumps
}
```

```python
def jump(nums):
    jumps = current_end = farthest = 0

    # Stop at n-2: arriving at the last index ends the journey.
    for i in range(len(nums) - 1):
        farthest = max(farthest, i + nums[i])   # reach of ONE more jump
        if i == current_end:                    # level exhausted
            jumps += 1
            current_end = farthest

    return jumps
```

### Complexity
Time **O(n)**, Space **O(1)**.

---

## 11. Solved Example 3

### Problem — Minimum Number of Refueling Stops (LeetCode 871)
A car starts with `startFuel` and travels `target` miles, using one unit of fuel per mile. `stations[i] = [position, fuel]`. Return the fewest stops needed, or `−1`.

### Thought Process
1. Unlike Example 2, the resource **accumulates** — refuelling adds to what you have rather than replacing your range. So the level trick does not apply.
2. The freeing insight: you do not have to decide at each station whether to stop. **Drive until you are about to run dry, then decide retroactively.**
3. Keep a max-heap of the fuel amounts at every station already driven past but not used.
4. Whenever `fuel < target` and you cannot reach further, pop the **largest** passed tank and count a stop. That buys the most range per stop.
5. If the heap is empty and you still cannot reach the target, you are stranded → `−1`.

Deferring the choice loses nothing: a station you drove past remains available to your past self, so postponing the decision only gives you more information.

### Dry Run

Input: `target = 100`, `startFuel = 10`, `stations = [[10,60], [20,30], [30,30], [60,40]]`

| step | fuel | stations reachable now (`position <= fuel`) | heap after banking | action | stops |
|------|------|----------------------------------------------|--------------------|--------|-------|
| 1 | 10 | `[10,60]` | `{60}` | `10 < 100`, pop **60** → fuel **70** | **1** |
| 2 | 70 | `[20,30]`, `[30,30]`, `[60,40]` | `{40, 30, 30}` | `70 < 100`, pop **40** → fuel **110** | **2** |
| 3 | 110 | — | `{30, 30}` | `110 >= 100` → stop | 2 |

Output: **2** ✓

**Watch the retroactive choice at step 2.** By the time we needed more fuel, we had already passed three stations offering 30, 30 and 40. We took the 40 — even though it is the one *furthest along* the road — because the decision is made after the fact. Committing greedily at the first station reachable would have taken a 30 and needed an extra stop.

**The stranded case:** `target = 100`, `startFuel = 1`, `stations = [[10,100]]`. With 1 unit of fuel we cannot even reach position 10, so nothing is banked, the heap is empty, and we return **`−1`** ✓.

### Visualization

```text
target = 100,  startFuel = 10

   0    10        20   30              60           100
   |     |         |    |               |            |
   ▼    [60]     [30] [30]            [40]           ▼
   ─────┴─────────┴────┴───────────────┴──────────────

fuel 10  → can reach position 10, bank 60
         → need more: take 60          fuel 70   stops 1

fuel 70  → can reach 20, 30, 60: bank 30, 30, 40
         → need more: take the LARGEST (40)   fuel 110  stops 2

110 >= 100  →  done in 2 stops
```

### Code

```go
func minRefuelStops(target int, startFuel int, stations [][]int) int {
    // Max-heap of fuel at stations already driven past but not yet used.
    passed := &passedFuelHeap{}
    heap.Init(passed)

    fuel, stops, index := startFuel, 0, 0

    for fuel < target {
        // Bank every station the current fuel lets us reach. We do NOT
        // decide to stop at them yet — only that they are now available.
        for index < len(stations) && stations[index][0] <= fuel {
            heap.Push(passed, stations[index][1])
            index++
        }

        if passed.Len() == 0 {
            return -1 // stranded with nothing left to draw on
        }

        // Retroactively refuel at the biggest tank we passed: the most
        // range bought per stop.
        fuel += heap.Pop(passed).(int)
        stops++
    }

    return stops
}

type passedFuelHeap []int

func (h passedFuelHeap) Len() int           { return len(h) }
func (h passedFuelHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h passedFuelHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *passedFuelHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *passedFuelHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def minRefuelStops(target, startFuel, stations):
    passed = []                         # max-heap (negated) of passed tanks
    fuel, stops, index = startFuel, 0, 0

    while fuel < target:
        # Bank what we can reach — without deciding to stop there yet.
        while index < len(stations) and stations[index][0] <= fuel:
            heapq.heappush(passed, -stations[index][1])
            index += 1

        if not passed:
            return -1                   # stranded

        fuel += -heapq.heappop(passed)  # retroactively take the biggest tank
        stops += 1

    return stops
```

### Complexity
Time **O(n log n)** — each station is pushed and popped at most once. Space **O(n)** for the heap.

> The three examples separate three different resource shapes. Gas Station's failure *eliminates a block*, so one sweep suffices. Jump Game II's reach is *replaced* and contiguous, so two counters replace a queue. Refuelling *accumulates*, so the decision can be deferred — and a max-heap is what makes deferring cheap.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 134 | Gas Station | Easy | Core greedy application |
| 45 | Jump Game II | Easy | Core greedy application |
| 871 | Min Refuel | Medium | Core greedy application |
| 1011 | Ship Days | Medium | Core greedy application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Activity selection / scheduling**
- **Jump game reachability**
- **Gas station circuit**
- **Huffman / merge-cost**

---

## 14. Production Engineering Applications

- **Scalability:** Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Gas Station logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Gas Station (Greedy).
- **Signal:** gas station, greedy, circular, running total, reset start.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Gas Station invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Gas Station
FAMILY : Greedy (Intermediate)
WHEN   : gas station, greedy, circular, running total, reset start
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 134, 45, 871, 1011
```

---

*Part of the DSA Patterns Handbook — pattern 87 of 100.*
