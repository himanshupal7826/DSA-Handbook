# 19 · Subarray Sum Window

> **One-liner:** Window/prefix sums to count or bound subarrays by their sum.

---

## 1. Overview

### Definition
The **Subarray Sum Window** pattern belongs to the *Sliding Window* family. Window/prefix sums to count or bound subarrays by their sum.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
subarray sum, window sum, positive, prefix, count subarrays.

### Constraints
- Input size where the brute-force complexity would time out — the Subarray Sum Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Subarray Sum Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Subarray Sum Window is the upgrade.
- The wording maps onto: subarray sum, window sum, positive, prefix, count subarrays.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which contiguous stretches of this array have a sum (or product) in the range I care about?"*

Running example: `nums = [2,3,1,2,4,3]`, `target = 7` — find the **shortest** subarray whose sum is at least 7. (Answer: `[4,3]`, length 2.)

### Intuition
A subarray is fixed by its two endpoints. So pick every start, walk the end rightwards while keeping a running total, and check the condition at each step.

### Algorithm
1. For each start `i` from `0` to `n − 1`:
2. &nbsp;&nbsp;Set `total = 0`.
3. &nbsp;&nbsp;For each end `j` from `i` to `n − 1`: `total += nums[j]`.
4. &nbsp;&nbsp;Test the condition on `total` (≥ target, < k, == k …) and update the answer.
5. Return the answer.

### Complexity
- Time: **O(n²)** — there are `n(n+1)/2` subarrays and this visits each one with O(1) extra work.
- Space: O(1).
- (The truly naive version re-sums each subarray from scratch and is **O(n³)**.)

### Drawbacks
- Concrete waste on `[2,3,1,2,4,3]`: start `i = 0` computes the prefix totals `2, 5, 6, 8, 12, 15`. Start `i = 1` then computes `3, 4, 6, 10, 13`. But `3 = 5 − 2`, `4 = 6 − 2`, `6 = 8 − 2` — **every one of those additions is the previous row minus 2**. We redo `n` additions to apply a single subtraction.
- The brute force never uses the fact that `sum(i+1 .. j) = sum(i .. j) − nums[i]`. Both edges of the range can be *adjusted*, and it insists on rebuilding.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A subarray's sum can be updated at either edge in O(1) — so either slide one window (when the sum moves in a predictable direction) or subtract two prefix sums (when it doesn't).**

Picture a tape measure laid over the array. Pulling the right end out adds a number; pulling the left end in removes one. If every number is positive, that tape behaves intuitively: extend and the sum goes up, retract and it goes down. That predictability is the *only* thing that makes a sliding window legal — and this chapter is mostly about noticing when it is missing.

### The thought process

```text
We need    : subarrays whose sum satisfies some condition.
Obvious way: try every (start, end) pair.
Too slow   : O(n^2) — and neighbouring ranges differ by one element.
Notice     : sum(i..j) can be edited at both edges in O(1).
Careful    : "shrink to reduce the sum" is only true if all values are >= 0.
Therefore  : positives  → sliding window;
             any values → prefix sums + a hash map.
Now        : O(n) either way.
```

### Why the sliding window needs positive values — and what breaks without them

The two-pointer window rests on one unstated assumption:

> **Monotonicity precondition:** extending the window right never *decreases* the sum, and shrinking it from the left never *increases* it.

With all values `> 0` that holds automatically, and it is what licences the shrink loop: "the sum is still ≥ target, so pulling `left` in can only bring it closer to the boundary — keep going until it drops below, and the last valid length was the best for this `right`."

Put one negative number in and the floor gives way. Take:

```text
nums = [1, -1, 5], target = 5     → shortest subarray with sum >= 5

sliding window:
  right=0  total = 1                      < 5
  right=1  total = 0                      < 5
  right=2  total = 5                      >= 5  → record length 3
           shrink: total -= 1  → 4        < 5   → STOP, left = 1
  answer reported: 3

truth:  [5] alone has sum 5, length 1.
```

The window stopped shrinking at `total = 4` because it read that as "the window is now too small". But one more shrink would have removed the `−1` and pushed the sum back **up** to 5. Shrinking increased the sum — the precondition was false, so the loop's stopping rule was meaningless. The bug is silent: no crash, just a wrong number.

The same trap exists for products (LeetCode 713 needs strictly positive values; a `0` or a negative destroys the monotonic behaviour of `prod *= v` / `prod /= v`).

### The general fallback: prefix sums + a hash map

When values may be negative, stop thinking about windows and think about **prefix sums**:

```text
prefix[j] = nums[0] + nums[1] + ... + nums[j-1]      (prefix[0] = 0)

sum of nums[i..j-1] = prefix[j] - prefix[i]
```

So "does some subarray ending here sum to `k`?" becomes:

```text
prefix[j] - prefix[i] == k
        ⟺  prefix[i] == prefix[j] - k
        ⟺  "have I seen the value (currentPrefix - k) before?"
```

That is a hash-map lookup. Sweep left to right, keep a map from *prefix value* → *how many times it has occurred*, and for each new prefix add `seen[prefix − k]` to the answer. Every earlier index with that prefix is the start of a qualifying subarray, so counting occurrences (not just presence) is what makes duplicates come out right.

Seed the map with `{0: 1}` — the empty prefix. Without it, a subarray that starts at index 0 (whose `prefix[i]` is `0`) is never counted.

### Choosing between the two

| Condition | Values | Tool |
|---|---|---|
| sum **≥ target**, shortest | all positive | sliding window, shrink while valid |
| product **< k**, count them | all positive | sliding window, add `right−left+1` |
| sum **== k**, count them | any (negatives ok) | prefix sums + hash map |
| sum **== k**, count them | all positive | window also works via `atMost(k) − atMost(k−1)` |
| sum **≥ target** | has negatives | prefix sums + a monotonic deque (out of scope here) |

### Steps

```text
── Sliding window (positives only) ──
Step 1 → left = 0, total = 0.
Step 2 → For right = 0..n-1:  total += nums[right]
Step 3 →   while the window is valid: record it, then total -= nums[left], left++
Step 4 → Return the recorded best.

── Prefix + map (any values) ──
Step 1 → seen = {0: 1}, prefix = 0, count = 0.
Step 2 → For each v in nums:
Step 3 →   prefix += v
Step 4 →   count += seen[prefix - k]
Step 5 →   seen[prefix]++
Step 6 → Return count.
```

### How should I recognize this?

```text
If you see...
  "contiguous subarray", "sum at least / at most", "product less than",
  "count subarrays whose sum equals k", "minimum length subarray"
        ↓
Think about...
  "Are all the values non-negative?"   ← ask this FIRST, every time
        ↓
Use...
  ├─ yes, and the condition is a threshold  → sliding window (O(1) space)
  ├─ no  (negatives / zeros present)        → prefix sums + hash map (O(n) space)
  └─ "exactly k" with positives             → atMost(k) - atMost(k-1)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 180" width="100%" height="180" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-19" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Subarray sum (positives): grow to add, shrink while sum &gt; target</text>
  <g>
    <rect x="40"  y="55" width="46" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="63"  y="83" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="90"  y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="113" y="83" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="140" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="83" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="190" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="213" y="83" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="240" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="263" y="83" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="290" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="313" y="83" text-anchor="middle" fill="#1e293b">1</text>
  </g>
  <rect x="86" y="51" width="154" height="54" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="163" y="122" text-anchor="middle" fill="#059669" font-weight="700">running sum = 2+3+2 = 7</text>
  <line x1="118" y1="126" x2="80" y2="126" stroke="#d97706" marker-end="url(#a-19)"/>
  <text x="150" y="120" text-anchor="middle" fill="#d97706">shrink L</text>
  <line x1="250" y1="126" x2="330" y2="126" stroke="#059669" marker-end="url(#a-19)"/>
  <text x="292" y="120" text-anchor="middle" fill="#059669">grow R →</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">sum += arr[R]; while sum &gt; k: sum −= arr[L], L++ (needs non-negatives)</text>
</svg>
```

```text
POSITIVE VALUES — the window is monotone, so shrinking is safe

nums = [2, 3, 1, 2, 4, 3]   target = 7

 r  add  total  window            action
 0   2     2    [2]              < 7
 1   3     5    [2,3]            < 7
 2   1     6    [2,3,1]          < 7
 3   2     8    [2,3,1,2]        >= 7 → len 4;  drop 2 → 6, left=1
 4   4    10    [3,1,2,4]        >= 7 → len 4;  drop 3 → 7 >= 7 → len 3;
                                              drop 1 → 6, left=3
 5   3     9    [2,4,3]          >= 7 → len 3;  drop 2 → 7 >= 7 → len 2 ★
                                              drop 4 → 3, left=5
best = 2


ONE NEGATIVE — the same code lies

nums = [1, -1, 5]   target = 5

 r=2  total = 5 >= 5, len 3, then shrink: 5-1 = 4 < 5 → stop
      but removing -1 next would RAISE the sum back to 5, length 1
      shrink-until-invalid is only a valid stopping rule when values >= 0
```

### Interview explanation
"First I check the sign of the values, because that decides the whole approach. With all-positive numbers the running sum is monotone in the window's endpoints — extending raises it, shrinking lowers it — so I can use a two-pointer sliding window: grow `right`, and while the window satisfies the condition, record it and shrink `left`. Each index enters and leaves once, so that's O(n) time and O(1) space. If negatives are possible, shrinking can *increase* the sum, and the shrink loop's stopping rule becomes invalid — so I switch to prefix sums with a hash map: since `sum(i..j) = prefix[j+1] − prefix[i]`, I look up `prefix − k` in a map of previously seen prefix counts, seeded with `{0:1}`. That's O(n) time and O(n) space and handles any values."

---

## 5. Generic Templates

> Positives → slide the window. Anything else → subtract two prefix sums and look the difference up in a map.

```go
// ShortestAtLeast returns the length of the shortest contiguous subarray whose
// sum is >= target, or 0 if none exists. Requires all values to be non-negative.
func ShortestAtLeast(nums []int, target int) int {
    left, total, best := 0, 0, len(nums)+1

    for right := 0; right < len(nums); right++ {
        total += nums[right]
        for total >= target { // valid: record, then try to make it shorter
            if right-left+1 < best {
                best = right - left + 1
            }
            total -= nums[left] // safe to shrink only because nums[i] >= 0
            left++
        }
    }

    if best == len(nums)+1 {
        return 0
    }
    return best
}

// CountSubarraysWithSum counts contiguous subarrays summing to exactly k.
// Works for ANY values, including negatives — no window required.
func CountSubarraysWithSum(nums []int, k int) int {
    seen := map[int]int{0: 1} // the empty prefix has occurred once
    prefix, count := 0, 0

    for _, v := range nums {
        prefix += v
        count += seen[prefix-k] // every earlier index with this prefix starts a match
        seen[prefix]++
    }
    return count
}
```

```python
def shortest_at_least(nums, target):
    """Shortest subarray with sum >= target, or 0. Requires non-negative values."""
    left = total = 0
    best = len(nums) + 1

    for right, v in enumerate(nums):
        total += v
        while total >= target:            # valid: record, then try to shorten
            best = min(best, right - left + 1)
            total -= nums[left]           # safe only because values are >= 0
            left += 1

    return 0 if best == len(nums) + 1 else best


def count_subarrays_with_sum(nums, k):
    """Count subarrays summing to exactly k. Works with negative values."""
    seen = {0: 1}                         # the empty prefix has occurred once
    prefix = count = 0

    for v in nums:
        prefix += v
        count += seen.get(prefix - k, 0)  # every earlier match starts a subarray
        seen[prefix] = seen.get(prefix, 0) + 1
    return count
```

```java
import java.util.*;

public class SubarraySum {
    // Shortest subarray with sum >= target, or 0. Requires non-negative values.
    public static int shortestAtLeast(int[] nums, int target) {
        int left = 0, total = 0, best = nums.length + 1;

        for (int right = 0; right < nums.length; right++) {
            total += nums[right];
            while (total >= target) {              // valid: record, then shorten
                best = Math.min(best, right - left + 1);
                total -= nums[left];               // safe only for values >= 0
                left++;
            }
        }
        return best == nums.length + 1 ? 0 : best;
    }

    // Count subarrays summing to exactly k. Works with negative values.
    public static int countSubarraysWithSum(int[] nums, int k) {
        Map<Integer, Integer> seen = new HashMap<>();
        seen.put(0, 1);                            // the empty prefix
        int prefix = 0, count = 0;

        for (int v : nums) {
            prefix += v;
            count += seen.getOrDefault(prefix - k, 0);
            seen.merge(prefix, 1, Integer::sum);
        }
        return count;
    }
}
```

```cpp
#include <unordered_map>
#include <vector>
using namespace std;

// Shortest subarray with sum >= target, or 0. Requires non-negative values.
int shortestAtLeast(const vector<int>& nums, int target) {
    int left = 0, total = 0, best = (int)nums.size() + 1;

    for (int right = 0; right < (int)nums.size(); ++right) {
        total += nums[right];
        while (total >= target) {                 // valid: record, then shorten
            if (right - left + 1 < best) best = right - left + 1;
            total -= nums[left];                  // safe only for values >= 0
            ++left;
        }
    }
    return best == (int)nums.size() + 1 ? 0 : best;
}

// Count subarrays summing to exactly k. Works with negative values.
int countSubarraysWithSum(const vector<int>& nums, int k) {
    unordered_map<int, int> seen{{0, 1}};         // the empty prefix
    int prefix = 0, count = 0;

    for (int v : nums) {
        prefix += v;
        auto it = seen.find(prefix - k);
        if (it != seen.end()) count += it->second;
        ++seen[prefix];
    }
    return count;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Subarray Sum Window (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(k)** |

> Each index is added and removed at most once; k = window/alphabet size.

---

## 7. Common Mistakes

1. Shrinking with `if` when the invariant needs a `while` loop (or vice versa).
2. Forgetting to update the answer at the right moment (after vs before shrink).
3. Not removing zero-count keys, corrupting the 'distinct' count.
4. Confusing 'longest' (shrink on invalid) with 'shortest' (shrink while valid).
5. Fixed-window code that recomputes the whole window each step (O(nk)).
6. Off-by-one in window length: `right - left + 1`.
7. Mishandling the first k elements when seeding a fixed window.
8. Using the window for problems needing negatives (sums) — prefix+hashmap instead.
9. Not resetting state between the expand and shrink phases.
10. Returning window indices that are stale after shrinking.

---

## 8. Interview Follow-Up Questions

1. **Q: Fixed vs variable window — how to tell?**
   A: Fixed when size k is given; variable when a constraint defines validity.

2. **Q: Longest vs shortest window logic?**
   A: Longest: shrink only when invalid. Shortest: shrink while still valid, recording length.

3. **Q: Why amortized O(n)?**
   A: Each index enters and exits the window at most once.

4. **Q: Handle 'at most k distinct'?**
   A: Shrink while distinct-count > k.

5. **Q: Exactly k distinct?**
   A: atMost(k) - atMost(k-1).

6. **Q: Negative numbers in sum windows?**
   A: Window-by-sum needs non-negativity; use prefix sums + hashmap otherwise.

7. **Q: Anagram/permutation in string?**
   A: Fixed window + char-count match.

8. **Q: Window maximum efficiently?**
   A: Monotonic deque gives O(n).

9. **Q: Minimum window substring?**
   A: Expand to cover need, shrink to minimize.

10. **Q: Counting subarrays with a property?**
   A: Often sum over windows or atMost differences.

11. **Q: Two pointers vs sliding window?**
   A: Sliding window is a specialized two-pointer with maintained aggregates.

12. **Q: Unicode/large alphabet?**
   A: Use a hash map instead of a fixed array.

13. **Q: Multiple constraints?**
   A: Track each as separate counters; invalid if any violated.

14. **Q: Stream input?**
   A: Maintain window state incrementally; evict by time/size.

15. **Q: Space complexity?**
   A: O(k) for the window's distinct elements or alphabet.

---

## 9. Solved Example 1

### Problem — Min Size Subarray (LeetCode 209)
Given an array of **positive** integers `nums` and a positive `target`, return the minimal length of a contiguous subarray whose sum is `>= target`, or `0` if no such subarray exists.

### Thought Process
1. Check the values first: they are all positive, so the running sum is **monotone** in both endpoints — extending right raises it, shrinking left lowers it. The sliding window is legal.
2. Grow `right`, adding `nums[right]` to `total`.
3. Whenever `total >= target`, the window is *valid* — record its length, then shrink from `left` to look for something shorter. We shrink **while valid**, because we want the minimum (contrast with "longest", which shrinks only when invalid).
4. Shrinking can only lower the sum, so the first time `total` drops below `target` we know no shorter window ending at this `right` exists — stop and move `right` on.
5. Sentinel `best = n + 1`; if it never improves, return `0`.

### Dry Run

Input: `nums = [2,3,1,2,4,3]`, `target = 7`

| right | value | total after add | window | `total >= 7`? | shrink steps | left after | best |
|-------|-------|-----------------|--------|---------------|--------------|------------|------|
| 0 | 2 | 2 | `[2]` | no | — | 0 | — |
| 1 | 3 | 5 | `[2,3]` | no | — | 0 | — |
| 2 | 1 | 6 | `[2,3,1]` | no | — | 0 | — |
| 3 | 2 | 8 | `[2,3,1,2]` | yes | record len **4**; drop 2 → total 6 (< 7, stop) | 1 | 4 |
| 4 | 4 | 10 | `[3,1,2,4]` | yes | record len 4; drop 3 → 7, still ≥ 7 → record len **3**; drop 1 → 6, stop | 3 | 3 |
| 5 | 3 | 9 | `[2,4,3]` | yes | record len 3; drop 2 → 7, still ≥ 7 → record len **2**; drop 4 → 3, stop | 5 | **2** |

Output: **2** — the subarray `[4,3]`.

Row `right = 5` is where the "shrink **while** valid, not `if` valid" rule earns its keep: the first shrink still left a valid window, and only the second shrink invalidated it. An `if` would have returned 3.

### Visualization

```text
nums =  2   3   1   2   4   3        target = 7
        0   1   2   3   4   5

r=3   [ 2   3   1   2 ]              sum 8  ≥ 7   len 4
r=4       [ 3   1   2   4 ]          sum 10 ≥ 7   len 4
r=4           [ 1   2   4 ]          sum 7  ≥ 7   len 3
r=5                 [ 4   3 ]        sum 7  ≥ 7   len 2   ★ best

left never moves backwards → total pointer movement is 2n → O(n)
```

### Code

```go
func minSubArrayLen(target int, nums []int) int {
    left, total := 0, 0
    best := len(nums) + 1 // sentinel: "no valid window found"

    for right := 0; right < len(nums); right++ {
        total += nums[right]

        // Shrink WHILE valid — we want the shortest such window.
        for total >= target {
            if right-left+1 < best {
                best = right - left + 1
            }
            total -= nums[left] // legal only because all values are positive
            left++
        }
    }

    if best == len(nums)+1 {
        return 0
    }
    return best
}
```

```python
def minSubArrayLen(target, nums):
    left = total = 0
    best = len(nums) + 1                  # sentinel: no valid window found

    for right, value in enumerate(nums):
        total += value

        while total >= target:            # shrink WHILE valid → shortest
            best = min(best, right - left + 1)
            total -= nums[left]           # legal only because values are positive
            left += 1

    return 0 if best == len(nums) + 1 else best
```

### Complexity
Time **O(n)** — `right` advances `n` times, `left` advances at most `n` times overall. Space **O(1)** — just two pointers and a running total.

---

## 10. Solved Example 2

### Problem — Subarray Sum K (LeetCode 560)
Given an array `nums` whose values **may be negative** and an integer `k`, count how many contiguous subarrays sum to exactly `k`.

### Thought Process
1. Check the values first — negatives are allowed, so **the sliding window is off the table**. Growing the window may lower the sum and shrinking may raise it, which destroys the shrink loop's stopping rule.
2. Switch to prefix sums: `sum(nums[i..j]) = prefix[j+1] − prefix[i]`, where `prefix[t]` is the sum of the first `t` elements.
3. Rearranging, a subarray ending at position `j` sums to `k` exactly when some earlier prefix equals `prefix[j+1] − k`.
4. So sweep once, keeping a hash map from prefix value → **how many times** it has occurred. For each new prefix, add `seen[prefix − k]` to the answer (the count, not a boolean — several earlier indices can share a prefix value).
5. Seed `seen = {0: 1}` for the empty prefix, so subarrays starting at index 0 are counted.

### Dry Run

Input: `nums = [1,-1,1,1,1]`, `k = 2`

| i | value | prefix | look up `prefix − k` | `seen[...]` | count | `seen` after recording prefix |
|---|-------|--------|----------------------|-------------|-------|-------------------------------|
| — | — | 0 | — | — | 0 | `{0:1}` |
| 0 | 1 | 1 | −1 | 0 | 0 | `{0:1, 1:1}` |
| 1 | −1 | 0 | −2 | 0 | 0 | `{0:2, 1:1}` |
| 2 | 1 | 1 | −1 | 0 | 0 | `{0:2, 1:2}` |
| 3 | 1 | 2 | 0 | **2** | **2** | `{0:2, 1:2, 2:1}` |
| 4 | 1 | 3 | 1 | **2** | **4** | `{0:2, 1:2, 2:1, 3:1}` |

Output: **4** — the subarrays `[1,-1,1,1]`, `[-1,1,1,1]`, `[1,1]` (indices 2–3), `[1,1]` (indices 3–4).

Row `i = 3` is the point of the whole method. `prefix = 2`, and `prefix − k = 0` has been seen **twice** (once as the empty prefix, once after index 1). Those two occurrences are two different starting points, so this single step contributes 2 — a boolean "have I seen it" map would have contributed 1 and undercounted.

Note that `[-1,1,1,1]` sums to 2 while the *shorter* `[1,1,1]` inside it sums to 3. A window would never find the first without walking past the second, which is exactly the monotonicity the negatives destroyed.

### Visualization

```text
nums   =    1   -1    1    1    1
index       0    1    2    3    4
prefix  0   1    0    1    2    3
        ↑                  ↑
        └── prefix 0 seen here and here ─┘
            prefix 2 - k(2) = 0  →  2 matches at i=3

sum(nums[i..j]) = prefix[j+1] - prefix[i]
   "how many earlier prefixes equal (current prefix - k)?"  → hash map

seen = {0:1} at the start, because the empty prefix is a legal left edge
```

### Code

```go
func subarraySum(nums []int, k int) int {
    seen := map[int]int{0: 1} // the empty prefix has occurred once
    prefix, count := 0, 0

    for _, value := range nums {
        prefix += value
        // Every earlier index whose prefix was (prefix-k) starts a subarray
        // ending here that sums to exactly k.
        count += seen[prefix-k]
        seen[prefix]++
    }
    return count
}
```

```python
def subarraySum(nums, k):
    seen = {0: 1}                          # the empty prefix has occurred once
    prefix = count = 0

    for value in nums:
        prefix += value
        # every earlier index with prefix == prefix-k starts a matching subarray
        count += seen.get(prefix - k, 0)
        seen[prefix] = seen.get(prefix, 0) + 1

    return count
```

### Complexity
Time **O(n)** — one pass, one hash lookup and one insert per element. Space **O(n)** — the map can hold a distinct prefix value for every index. (This is the price of dropping the window: O(1) space is not achievable once negatives are allowed.)

---

## 11. Solved Example 3

### Problem — Subarray Product (LeetCode 713)
Given an array of **positive** integers `nums` and an integer `k`, count the contiguous subarrays whose product is **strictly less than** `k`.

### Thought Process
1. Values are positive, so the product is monotone at both edges: multiplying in raises it, dividing out lowers it. The window is legal — but note the precondition is stricter here, since a single `0` would pin the product at 0 and a negative would flip comparisons.
2. Grow `right`, multiplying `prod` by `nums[right]`.
3. While `prod >= k` (and `left <= right`), divide out `nums[left]` and advance `left`, restoring `prod < k`.
4. **The counting trick:** once the window `[left, right]` is valid, *every* subarray ending at `right` and starting anywhere in `[left, right]` is also valid — because dropping elements from the front of a positive-valued product only makes it smaller. That's `right − left + 1` new subarrays, added in O(1).
5. Guard `k <= 1`: no product of positive integers is below 1, so return `0`.

### Dry Run

Input: `nums = [10,5,2,6]`, `k = 100`

| right | value | prod after × | shrink? | prod after shrink | left | window | new subarrays (`right−left+1`) | count |
|-------|-------|--------------|---------|-------------------|------|--------|-------------------------------|-------|
| 0 | 10 | 10 | no | 10 | 0 | `[10]` | 1 → `[10]` | 1 |
| 1 | 5 | 50 | no | 50 | 0 | `[10,5]` | 2 → `[5]`, `[10,5]` | 3 |
| 2 | 2 | 100 | **yes** (100 ≥ 100): divide out 10 | 10 | 1 | `[5,2]` | 2 → `[2]`, `[5,2]` | 5 |
| 3 | 6 | 60 | no | 60 | 1 | `[5,2,6]` | 3 → `[6]`, `[2,6]`, `[5,2,6]` | **8** |

Output: **8**

Row `right = 2` shows the boundary handled correctly: `100 >= 100` fails the *strict* inequality, so the window must shrink. Row `right = 3` shows why the `right − left + 1` shortcut is sound — `[5,2,6] = 60 < 100`, and the shorter suffixes `[2,6] = 12` and `[6] = 6` are automatically smaller still.

### Visualization

```text
nums = 10   5   2   6      k = 100
        0   1   2   3

r=0  [10]                        prod 10   → +1  ([10])
r=1  [10  5]                     prod 50   → +2  ([5], [10,5])
r=2  [10  5  2] = 100 ≥ 100      shrink out 10
         [5  2]                  prod 10   → +2  ([2], [5,2])
r=3      [5  2  6]               prod 60   → +3  ([6], [2,6], [5,2,6])
                                                        total = 8

why "+ (right-left+1)":  with positive values, every SUFFIX of a valid
window is valid too — dropping a factor ≥ 1 can only shrink the product
```

### Code

```go
func numSubarrayProductLessThanK(nums []int, k int) int {
    if k <= 1 { // no product of positive integers is < 1
        return 0
    }

    left, prod, count := 0, 1, 0
    for right := 0; right < len(nums); right++ {
        prod *= nums[right]

        for prod >= k { // restore validity; safe because values are positive
            prod /= nums[left]
            left++
        }

        // Every subarray ending at `right` and starting in [left, right] works.
        count += right - left + 1
    }
    return count
}
```

```python
def numSubarrayProductLessThanK(nums, k):
    if k <= 1:                             # no product of positives is < 1
        return 0

    left, prod, count = 0, 1, 0
    for right, value in enumerate(nums):
        prod *= value

        while prod >= k:                   # restore validity (values are positive)
            prod //= nums[left]
            left += 1

        # every subarray ending at right and starting in [left, right] is valid
        count += right - left + 1

    return count
```

### Complexity
Time **O(n)** — each index is multiplied in once and divided out at most once. Space **O(1)**.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 209 | Min Size Subarray | Easy | Core sliding window application |
| 560 | Subarray Sum K | Easy | Core sliding window application |
| 713 | Subarray Product | Medium | Core sliding window application |
| 930 | Binary Subarrays | Medium | Core sliding window application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Fixed-size window**
- **Variable-size window**
- **Longest-window (shrink on invalid)**
- **Shortest-window (shrink while valid)**
- **Anagram/permutation window**
- **At-most-k distinct**

---

## 14. Production Engineering Applications

- **Scalability:** Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Subarray Sum Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Subarray Sum Window (Sliding Window).
- **Signal:** subarray sum, window sum, positive, prefix, count subarrays.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Subarray Sum Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Subarray Sum Window
FAMILY : Sliding Window (Intermediate)
WHEN   : subarray sum, window sum, positive, prefix, count subarrays
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 209, 560, 713, 930
```

---

*Part of the DSA Patterns Handbook — pattern 19 of 100.*
