# 13 · Fixed Size Window

> **One-liner:** Slide a window of constant width k, adding the new and dropping the old element.

---

## 1. Overview

### Definition
The **Fixed Size Window** pattern belongs to the *Sliding Window* family. Slide a window of constant width k, adding the new and dropping the old element.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
sliding window, fixed size, k elements, subarray of size k, average.

### Constraints
- Input size where the brute-force complexity would time out — the Fixed Size Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Fixed Size Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Fixed Size Window is the upgrade.
- The wording maps onto: sliding window, fixed size, k elements, subarray of size k, average.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Look at every block of exactly `k` consecutive elements — which one is best?"*

### Intuition
Go to each starting position and add up the `k` elements from there.

### Algorithm
1. For each start `i` from `0` to `n−k`:
2. &nbsp;&nbsp;Set `sum = 0`.
3. &nbsp;&nbsp;For `j` from `i` to `i+k−1`: `sum += nums[j]`.
4. &nbsp;&nbsp;Compare `sum` against the best so far.

### Complexity
- Time: **O(n·k)**.
- Space: O(1).

### Drawbacks
- Consider two neighbouring windows on `[1, 12, -5, -6, 50, 3]` with `k = 4`:

```text
window at 0:  1 + 12 + (-5) + (-6)
window at 1:      12 + (-5) + (-6) + 50
                  └──── identical ────┘
```

Three of the four additions are **exactly the same work**. We redo them for every position. With `k = 10⁴` and `n = 10⁵`, that's 10⁹ pointless additions.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Don't rebuild the window — slide it. Add the element entering on the right, remove the element leaving on the left.**

The window has a fixed size, so moving it one step changes exactly **two** things. Everything else is untouched, so it doesn't need to be recomputed.

```text
       ┌─────────────┐
[1,   12,  -5,  -6,] 50,   3
       └─────────────┘
        subtract 1        add 50
        (leaves)          (enters)
```

### The thought process

```text
We need    : a statistic over every block of k consecutive elements.
Obvious way: recompute each block from scratch.
Too slow   : O(n·k), and neighbouring blocks overlap in k-1 elements.
Notice     : sliding one step removes ONE element and adds ONE element.
             The k-1 in the middle don't change at all.
Therefore  : maintain the running statistic incrementally.
Now        : O(1) per step → O(n) total.
```

### Steps

```text
Step 1 → Build the first window: sum nums[0..k-1].
Step 2 → Record it as the current best.
Step 3 → For i = k .. n-1:
Step 4 →     sum += nums[i]        ← the element entering on the right
Step 5 →     sum -= nums[i-k]      ← the element leaving on the left
Step 6 →     update the best
Step 7 → Return the best.
```

### Why `i - k` is the element that leaves

When `i` enters, the window covers `[i−k+1 … i]`, which is `k` elements. The element that just fell out is the one immediately before that range: `i − k`.

Check it on `k = 3`, `i = 3`: the window is `[1..3]` and the departing index is `3 − 3 = 0`. ✓

This single expression is where most fixed-window bugs live. Sanity-check it with tiny numbers every time.

### Fixed vs variable windows

This chapter is the **fixed** case: `k` is given, so the window size never changes and both ends move in lockstep. Its sibling — the variable window — grows the right end and shrinks the left end only when a condition is violated. Recognising which one you have is most of the battle:

| Signal | Window type |
|---|---|
| "of size k", "every k consecutive", "k-length substring" | **fixed** |
| "longest / shortest such that…", "at most K distinct" | variable |

### When the statistic isn't a sum

Adding and subtracting works because sums are **reversible** — you can undo an element's contribution. Not every statistic is:

| Statistic | Slide in O(1)? | Tool |
|---|---|---|
| sum, average, count of a value | yes | add/subtract |
| character frequencies | yes | increment/decrement a table |
| **maximum / minimum** | **no** | monotonic deque — O(1) amortised |
| median | no | two heaps |

You can't "subtract" a maximum: if the departing element *was* the max, the new max is unknown. That gap is exactly what the Monotonic Queue pattern exists to fill.

### How should I recognize this?

```text
If you see...
  "subarray/substring of size k", "every k consecutive"
  "maximum average", "k-length window", a fixed k in the constraints
        ↓
Think about...
  "What changes when the window slides by one?
   Exactly one element in, exactly one element out."
        ↓
Use...
  sum/count  → add the entering, subtract the leaving
  max/min    → monotonic deque
  frequencies→ a count table plus a "how many are matched" counter
```

### Visual explanation

```svg
<svg viewBox="0 0 640 170" width="100%" height="170" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-13" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Fixed window k=3: drop left, add right, sum stays O(1)</text>
  <g>
    <rect x="40"  y="50" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="63"  y="78" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="90"  y="50" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="113" y="78" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="140" y="50" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="78" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="190" y="50" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="213" y="78" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="240" y="50" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="263" y="78" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="290" y="50" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="313" y="78" text-anchor="middle" fill="#1e293b">2</text>
  </g>
  <rect x="86" y="46" width="154" height="54" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="163" y="122" text-anchor="middle" fill="#059669" font-weight="700">window sum = 1+5+1 = 7</text>
  <line x1="250" y1="126" x2="330" y2="126" stroke="#475569" marker-end="url(#a-13)"/>
  <text x="292" y="120" text-anchor="middle" fill="#64748b">slide →</text>
  <text x="320" y="150" text-anchor="middle" fill="#64748b">next: sum += arr[R] &amp; sum -= arr[L] (no re-scan)</text>
</svg>
```

```text
nums = [1, 12, -5, -6, 50, 3]   k = 4

window [0..3] :  1 + 12 - 5 - 6 = 2        avg = 0.5
                 └── slide right ──┘
window [1..4] :  2 - nums[0] + nums[4]
              =  2 -    1    +   50  = 51   avg = 12.75   ★
window [2..5] : 51 - nums[1] + nums[5]
              = 51 -   12    +    3  = 42   avg = 10.5

only two operations per slide, never four
```

### Interview explanation
"Neighbouring windows of size `k` overlap in `k−1` elements, so recomputing each one from scratch repeats almost all the work. I'll build the first window in O(k), then slide: each step adds `nums[i]` and subtracts `nums[i-k]`, which is O(1). That makes the whole scan O(n) instead of O(n·k), with O(1) space. If the statistic were a maximum rather than a sum I couldn't just subtract, so I'd maintain a monotonic deque instead."

---

## 5. Generic Templates

> Build the first window, then add-one / remove-one for each step.

```go
// FixedWindowSum returns the maximum sum over all windows of size k.
func FixedWindowSum(nums []int, k int) int {
    if len(nums) < k || k <= 0 {
        return 0
    }

    // Build the first window.
    sum := 0
    for i := 0; i < k; i++ {
        sum += nums[i]
    }
    best := sum

    // Slide: one in on the right, one out on the left.
    for i := k; i < len(nums); i++ {
        sum += nums[i]   // entering
        sum -= nums[i-k] // leaving
        if sum > best {
            best = sum
        }
    }
    return best
}

// FixedWindowCounts is the frequency-table variant: it keeps a live count
// of each byte inside the window as it slides.
func FixedWindowCounts(s string, k int) []map[byte]int {
    snapshots := []map[byte]int{}
    if len(s) < k || k <= 0 {
        return snapshots
    }

    window := make(map[byte]int, k)
    for i := 0; i < len(s); i++ {
        window[s[i]]++ // entering

        if i >= k {
            left := s[i-k]
            window[left]--
            if window[left] == 0 {
                delete(window, left) // keep the map size meaningful
            }
        }

        if i >= k-1 {
            snapshot := make(map[byte]int, len(window))
            for ch, c := range window {
                snapshot[ch] = c
            }
            snapshots = append(snapshots, snapshot)
        }
    }
    return snapshots
}
```

```python
def fixed_window_sum(nums, k):
    """Maximum sum over all windows of size k."""
    if len(nums) < k or k <= 0:
        return 0

    total = sum(nums[:k])          # build the first window
    best = total
    for i in range(k, len(nums)):
        total += nums[i]           # entering
        total -= nums[i - k]       # leaving
        best = max(best, total)
    return best

def fixed_window_counts(s, k):
    """Live frequency table for every window of size k."""
    from collections import Counter
    snapshots = []
    if len(s) < k or k <= 0:
        return snapshots

    window = Counter()
    for i, ch in enumerate(s):
        window[ch] += 1                    # entering
        if i >= k:
            left = s[i - k]
            window[left] -= 1
            if window[left] == 0:
                del window[left]           # keep the map size meaningful
        if i >= k - 1:
            snapshots.append(dict(window))
    return snapshots
```

```java
import java.util.*;

public class FixedWindow {
    // Maximum sum over all windows of size k.
    public static long fixedWindowSum(int[] nums, int k) {
        if (nums.length < k || k <= 0) return 0;

        long sum = 0;
        for (int i = 0; i < k; i++) sum += nums[i];   // first window
        long best = sum;

        for (int i = k; i < nums.length; i++) {
            sum += nums[i];        // entering
            sum -= nums[i - k];    // leaving
            best = Math.max(best, sum);
        }
        return best;
    }

    // Live frequency table for every window of size k.
    public static List<Map<Character, Integer>> fixedWindowCounts(String s, int k) {
        List<Map<Character, Integer>> snapshots = new ArrayList<>();
        if (s.length() < k || k <= 0) return snapshots;

        Map<Character, Integer> window = new HashMap<>();
        for (int i = 0; i < s.length(); i++) {
            window.merge(s.charAt(i), 1, Integer::sum);           // entering
            if (i >= k) {
                char left = s.charAt(i - k);
                if (window.merge(left, -1, Integer::sum) == 0) window.remove(left);
            }
            if (i >= k - 1) snapshots.add(new HashMap<>(window));
        }
        return snapshots;
    }
}
```

```cpp
#include <string>
#include <unordered_map>
#include <vector>
using namespace std;

// Maximum sum over all windows of size k.
long long fixedWindowSum(const vector<int>& nums, int k) {
    if ((int)nums.size() < k || k <= 0) return 0;

    long long sum = 0;
    for (int i = 0; i < k; ++i) sum += nums[i];       // first window
    long long best = sum;

    for (int i = k; i < (int)nums.size(); ++i) {
        sum += nums[i];        // entering
        sum -= nums[i - k];    // leaving
        best = max(best, sum);
    }
    return best;
}

// Live frequency table for every window of size k.
vector<unordered_map<char, int>> fixedWindowCounts(const string& s, int k) {
    vector<unordered_map<char, int>> snapshots;
    if ((int)s.size() < k || k <= 0) return snapshots;

    unordered_map<char, int> window;
    for (int i = 0; i < (int)s.size(); ++i) {
        ++window[s[i]];                                // entering
        if (i >= k) {
            char left = s[i - k];
            if (--window[left] == 0) window.erase(left);
        }
        if (i >= k - 1) snapshots.push_back(window);
    }
    return snapshots;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Fixed Size Window (Optimal) |
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

### Problem — Maximum Average Subarray I (LeetCode 643)
Find the contiguous subarray of length exactly `k` with the maximum average, and return that average.

### Thought Process
1. The window size is fixed, so maximising the **average** is the same as maximising the **sum** — every window is divided by the same `k`.
2. Working with sums avoids floating-point arithmetic until the very last line.
3. Build the first window in O(k), then slide: add `nums[i]`, subtract `nums[i-k]`.
4. Track the maximum sum, then divide once at the end.

### Dry Run

Input: `nums = [1, 12, -5, -6, 50, 3]`, `k = 4`

**Build the first window** `[0..3]`: `1 + 12 + (−5) + (−6) = 2` → `best = 2`

**Slide:**

| i | entering `nums[i]` | leaving `nums[i−k]` | sum | best |
|---|--------------------|---------------------|-----|------|
| 4 | `nums[4] = 50` | `nums[0] = 1`  | `2 + 50 − 1 = 51` | **51** |
| 5 | `nums[5] = 3`  | `nums[1] = 12` | `51 + 3 − 12 = 42` | 51 |

Best sum = **51**, over the window `[12, −5, −6, 50]`.

Output: **`51 / 4 = 12.75`**

Verify by hand: the three windows are `[1,12,−5,−6] = 2`, `[12,−5,−6,50] = 51`, `[−5,−6,50,3] = 42`. ✓

### Visualization

```text
nums:  1   12   -5   -6   50    3
      ┌──────────────────┐
sum=2 │ 1   12   -5   -6 │            avg  0.50
      └──────────────────┘
           ┌──────────────────┐
sum=51     │12   -5   -6   50 │       avg 12.75  ★
           └──────────────────┘
                ┌──────────────────┐
sum=42          │-5   -6   50    3 │  avg 10.50
                └──────────────────┘

each slide = one subtraction + one addition
```

### Code

```go
func findMaxAverage(nums []int, k int) float64 {
    // Build the first window.
    sum := 0
    for i := 0; i < k; i++ {
        sum += nums[i]
    }
    best := sum

    // Slide: one element in, one element out.
    for i := k; i < len(nums); i++ {
        sum += nums[i]   // entering on the right
        sum -= nums[i-k] // leaving on the left
        if sum > best {
            best = sum
        }
    }

    // Divide once, at the end: all windows share the same k.
    return float64(best) / float64(k)
}
```

```python
def findMaxAverage(nums, k):
    total = sum(nums[:k])              # build the first window
    best = total
    for i in range(k, len(nums)):
        total += nums[i]               # entering on the right
        total -= nums[i - k]           # leaving on the left
        best = max(best, total)
    return best / k                    # divide once, at the end
```

### Complexity
Time O(n) — O(k) to build plus O(1) per slide. Space O(1).

---

## 10. Solved Example 2

### Problem — Sliding Window Maximum (LeetCode 239)
Return the maximum of every window of size `k`.

### Thought Process
1. The window size is fixed, so we slide — but the statistic is a **maximum**, and a maximum cannot be "subtracted".
2. When the departing element happens to *be* the current maximum, the new maximum is unknown and rescanning costs O(k).
3. Fix: keep a **deque of indices whose values are in decreasing order**. The front is always the window's maximum.
4. Two rules maintain that order:
   - **Before pushing `i`**: pop from the back every index whose value is `<= nums[i]`. They can never be the maximum again — `nums[i]` is both bigger and stays in the window longer.
   - **After pushing**: if the front index has slid out of the window (`front <= i − k`), pop it from the front.
5. Each index is pushed once and popped once → O(n) overall.

### Dry Run

Input: `nums = [1, 3, -1, -3, 5, 3, 6, 7]`, `k = 3`

The deque holds **indices**; the values are shown for readability.

| i | nums[i] | pop from back (value ≤ nums[i]) | push | drop stale front | deque (values) | window complete? | max |
|---|---------|--------------------------------|------|------------------|----------------|------------------|-----|
| 0 | 1  | —                | 0 | — | `[1]`        | no  | — |
| 1 | 3  | pop 0 (`1 ≤ 3`)  | 1 | — | `[3]`        | no  | — |
| 2 | −1 | —                | 2 | — | `[3, −1]`    | yes | **3** |
| 3 | −3 | —                | 3 | — | `[3, −1, −3]`| yes | **3** |
| 4 | 5  | pop 3, 2, 1 (all ≤ 5) | 4 | — | `[5]`   | yes | **5** |
| 5 | 3  | —                | 5 | — | `[5, 3]`     | yes | **5** |
| 6 | 6  | pop 5, 4 (both ≤ 6) | 6 | — | `[6]`     | yes | **6** |
| 7 | 7  | pop 6 (`6 ≤ 7`)  | 7 | — | `[7]`        | yes | **7** |

Output: **`[3, 3, 5, 5, 6, 7]`**

Row `i = 4` is the whole idea: when `5` arrives it evicts `−3`, `−1` and `3` in one go. Those three can never win again — `5` is larger *and* outlives all of them.

### Visualization

```text
nums:  1   3  -1  -3   5   3   6   7
                       ↑
        arriving 5 evicts everything smaller behind it:

        deque before:  [3, -1, -3]      (decreasing)
        5 >= -3 → pop     5 >= -1 → pop     5 >= 3 → pop
        deque after :  [5]

        front of the deque is ALWAYS the window maximum
```

### Code

```go
func maxSlidingWindow(nums []int, k int) []int {
    if len(nums) == 0 || k <= 0 {
        return nil
    }

    deque := []int{} // indices, values strictly decreasing front → back
    result := make([]int, 0, len(nums)-k+1)

    for i := 0; i < len(nums); i++ {
        // Smaller values behind us can never be the maximum again.
        for len(deque) > 0 && nums[deque[len(deque)-1]] <= nums[i] {
            deque = deque[:len(deque)-1]
        }
        deque = append(deque, i)

        // Drop the front if it has slid out of the window.
        if deque[0] <= i-k {
            deque = deque[1:]
        }

        // Record once the first full window exists.
        if i >= k-1 {
            result = append(result, nums[deque[0]])
        }
    }
    return result
}
```

```python
from collections import deque

def maxSlidingWindow(nums, k):
    if not nums or k <= 0:
        return []

    dq = deque()                       # indices, values decreasing
    result = []

    for i, x in enumerate(nums):
        while dq and nums[dq[-1]] <= x:    # smaller values can never win again
            dq.pop()
        dq.append(i)

        if dq[0] <= i - k:                 # front slid out of the window
            dq.popleft()

        if i >= k - 1:                     # first full window exists
            result.append(nums[dq[0]])
    return result
```

### Complexity
Time **O(n)** — each index is pushed once and popped at most once, so the inner `while` is O(1) amortised. Space O(k) for the deque.

---

## 11. Solved Example 3

### Problem — Permutation in String (LeetCode 567)
Return `true` if `s2` contains a substring that is a permutation of `s1`.

### Thought Process
1. A permutation of `s1` has exactly `len(s1)` characters with exactly `s1`'s letter counts — so this is a **fixed** window of size `len(s1)`.
2. Comparing two 26-slot tables at every position costs O(26) per step. Acceptable, but we can do better.
3. Keep a single `need` table (`+1` for `s1`, `−1` for each window character) plus a counter `matched` = how many letters currently have count zero.
4. When `matched == 26`, every letter's count agrees → the window is a permutation.
5. Update `matched` only for the two letters that actually change on each slide, making every step O(1).

### Dry Run

Input: `s1 = "ab"`, `s2 = "eidbaooo"` → window size 2

Only the letters `a`, `b`, `d`, `e`, `i`, `o` are shown; all others stay at 0 (and therefore stay matched).

Initial `need` after loading `s1`: `a: 1, b: 1` → `matched = 24` (the 24 untouched letters).

| i | entering | leaving | need changes | matched | window | permutation? |
|---|----------|---------|--------------|---------|--------|--------------|
| 0 | `e` | — | `e: −1` | 23 | `"e"` | window not full |
| 1 | `i` | — | `i: −1` | 22 | `"ei"` | no (`matched ≠ 26`) |
| 2 | `d` | `e` | `d: −1`, `e: 0` | 22 | `"id"` | no |
| 3 | `b` | `i` | `b: 0`, `i: 0` | 24 | `"db"` | no |
| 4 | `a` | `d` | `a: 0`, `d: 0` | **26** | `"ba"` | **yes → `true`** |

Output: **`true`** — `"ba"` is a permutation of `"ab"`. ✓

### Visualization

```text
s1 = "ab"        need:  a:+1  b:+1   (everything else 0)

s2 = e  i  d  b  a  o  o  o
              └──┘
              window "ba"

     a: +1 - 1 = 0  ✓
     b: +1 - 1 = 0  ✓
     all 26 letters at 0  →  matched = 26  →  permutation found
```

### Code

```go
func checkInclusion(s1 string, s2 string) bool {
    if len(s1) > len(s2) {
        return false
    }

    // need[c] > 0 means we still need c; < 0 means the window has a surplus.
    var need [26]int
    for i := 0; i < len(s1); i++ {
        need[s1[i]-'a']++
    }

    matched := 0 // how many of the 26 letters are currently balanced
    for _, v := range need {
        if v == 0 {
            matched++
        }
    }

    for i := 0; i < len(s2); i++ {
        // The entering character consumes one unit of need.
        in := s2[i] - 'a'
        if need[in] == 0 {
            matched--
        }
        need[in]--
        if need[in] == 0 {
            matched++
        }

        // Once the window is oversized, the leftmost character leaves.
        if i >= len(s1) {
            out := s2[i-len(s1)] - 'a'
            if need[out] == 0 {
                matched--
            }
            need[out]++
            if need[out] == 0 {
                matched++
            }
        }

        if matched == 26 {
            return true
        }
    }
    return false
}
```

```python
def checkInclusion(s1, s2):
    if len(s1) > len(s2):
        return False

    need = [0] * 26                    # >0: still needed, <0: surplus
    for ch in s1:
        need[ord(ch) - 97] += 1
    matched = sum(1 for v in need if v == 0)

    for i, ch in enumerate(s2):
        enter = ord(ch) - 97           # entering character consumes need
        if need[enter] == 0:
            matched -= 1
        need[enter] -= 1
        if need[enter] == 0:
            matched += 1

        if i >= len(s1):               # window oversized: leftmost leaves
            leave = ord(s2[i - len(s1)]) - 97
            if need[leave] == 0:
                matched -= 1
            need[leave] += 1
            if need[leave] == 0:
                matched += 1

        if matched == 26:
            return True
    return False
```

### Complexity
Time **O(n)** where `n = len(s2)` — each step touches at most two letters. Space O(1) — a fixed 26-slot table.

> The simpler version compares the two 26-arrays outright on each slide. That is O(26·n), which also passes; the `matched` counter is the refinement that gets it to a true O(n).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 643 | Max Average | Easy | Core sliding window application |
| 239 | Sliding Window Max | Easy | Core sliding window application |
| 567 | Permutation in String | Medium | Core sliding window application |
| 1456 | Max Vowels | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Fixed Size Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Fixed Size Window (Sliding Window).
- **Signal:** sliding window, fixed size, k elements, subarray of size k, average.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Fixed Size Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Fixed Size Window
FAMILY : Sliding Window (Beginner)
WHEN   : sliding window, fixed size, k elements, subarray of size k, average
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 643, 239, 567, 1456
```

---

*Part of the DSA Patterns Handbook — pattern 13 of 100.*
