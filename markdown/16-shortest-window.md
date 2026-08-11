# 16 · Shortest Window

> **One-liner:** Minimize window length; shrink aggressively while validity holds.

---

## 1. Overview

### Definition
The **Shortest Window** pattern belongs to the *Sliding Window* family. Minimize window length; shrink aggressively while validity holds.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
shortest, minimum window, cover, at least, min length.

### Constraints
- Input size where the brute-force complexity would time out — the Shortest Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Shortest Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Shortest Window is the upgrade.
- The wording maps onto: shortest, minimum window, cover, at least, min length.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the **shortest** contiguous stretch that is good enough?"*

"Good enough" varies — *contains all of `t`*, *sums to at least `target`*, *leaves the rest balanced* — but the shape never does.

### Intuition
Try every stretch; keep the shortest one that qualifies.

### Algorithm
1. For each start `left`:
2. &nbsp;&nbsp;For each end `right >= left`:
3. &nbsp;&nbsp;&nbsp;&nbsp;Check whether `[left..right]` satisfies the requirement.
4. &nbsp;&nbsp;&nbsp;&nbsp;If it does, update the best length **and break** — extending further can only get longer.

### Complexity
- Time: **O(n²)** with incremental checking, **O(n²·m)** if you re-verify the requirement from scratch.
- Space: O(m) for the requirement bookkeeping.

### Drawbacks
- Every new `left` rebuilds state the previous pass already had.
- The `break` helps, but the outer restart is the real cost: `n` fresh scans.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Grow the window until it qualifies; then, while it still qualifies, record its length and squeeze it from the left.**

The *longest*-window pattern shrinks to escape an invalid state. This one is the mirror image: it shrinks **while valid**, because every extra step it survives is a shorter answer.

```text
for right in 0..n-1:
    add nums[right] to the window
    while the window is VALID:
        best = min(best, right - left + 1)      ← record INSIDE the loop
        remove nums[left]; left++
```

### The thought process

```text
We need    : the shortest window that satisfies a requirement.
Obvious way: test every (left, right) pair.
Too slow   : O(n^2) and it restarts constantly.
Notice     : once a window qualifies, making it LONGER cannot help —
             we want short. So the only interesting move is to shrink.
Notice too : shrinking may break the requirement, and that is fine:
             we grow `right` again until it qualifies once more.
Therefore  : grow right to become valid, shrink left while STILL valid,
             recording on every valid configuration.
Now        : both pointers only move forward → O(n).
```

### The one thing that separates this from the longest variant

| | Longest | **Shortest** |
|---|---|---|
| Shrink while… | the window is **invalid** | the window is **valid** |
| Record… | **after** the shrink loop | **inside** the shrink loop |
| Why | the loop exits on a valid window | every iteration *is* a valid window |
| Initial best | `0` | a sentinel larger than `n` |

Getting these crossed is the single most common bug in window problems. Before writing code, say which one you're solving.

### Why the sentinel matters

For a *longest* answer, `best = 0` is a fine starting value — zero is a real, if useless, length. For a *shortest* answer, `0` would be a permanent winner that nothing can beat. Use `n + 1` (impossible) and translate it at the end:

```go
best := len(nums) + 1
...
if best == len(nums)+1 { return 0 }   // or "" for string problems
```

### Tracking "is it valid?" in O(1)

Checking the requirement by comparing whole frequency maps is O(alphabet) per step. The standard fix is a single counter:

```text
required = number of DISTINCT characters t needs
formed   = how many of those currently have ENOUGH copies in the window

valid  ⇔  formed == required
```

Then `formed` changes only at the exact moment a character crosses its threshold:

```text
on adding ch    : if window[ch] becomes == need[ch]  → formed++
on removing ch  : if window[ch] drops  <  need[ch]   → formed--
```

Notice both use the *threshold-crossing* moment, not a `>=` test — otherwise a character with three copies would increment `formed` three times.

### Steps

```text
Step 1 → left = 0, best = n+1, empty window state.
Step 2 → For right = 0 .. n-1:
Step 3 →     add nums[right] to the state
Step 4 →     while the window is VALID:
Step 5 →         best = min(best, right - left + 1)
Step 6 →         remove nums[left] from the state; left++
Step 7 → Return best (or 0 / "" if it is still the sentinel).
```

### How should I recognize this?

```text
If you see...
  "minimum / smallest / shortest" + "substring / subarray / window"
  "containing all of ...", "sum at least ...", "so that the rest is balanced"
        ↓
Think about...
  "Once it qualifies, can I keep squeezing from the left
   and still qualify?"
        ↓
Use...
  grow right → while VALID, record then shrink left
  and start `best` at a sentinel, not 0
```

> **Careful:** the requirement must be monotone — growing the window can only *help* it qualify. "Sum ≥ target" satisfies that only with non-negative numbers. With negatives, use prefix sums plus a monotonic deque instead (LeetCode 862).

### Visual explanation

```svg
<svg viewBox="0 0 640 180" width="100%" height="180" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-16" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Shortest window (sum ≥ 7): shrink L while still valid</text>
  <g>
    <rect x="40"  y="55" width="46" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="63"  y="83" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="90"  y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="113" y="83" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="140" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="83" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="190" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="213" y="83" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="240" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="263" y="83" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="290" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="313" y="83" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <rect x="86" y="51" width="154" height="54" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="163" y="122" text-anchor="middle" fill="#059669" font-weight="700">3+1+4 = 8 ≥ 7, len = 3</text>
  <line x1="118" y1="126" x2="80" y2="126" stroke="#d97706" marker-end="url(#a-16)"/>
  <text x="150" y="120" text-anchor="middle" fill="#d97706">shrink L</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">while sum ≥ target: record len, drop arr[L], L++ (minimize)</text>
</svg>
```

```text
s = "ABAACBAB", t = "ABC"

A B A A C B A B
└─────────┘            "ABAAC" — valid, length 5, record
↑         ↑
left    right

  └───────┘            shrink: "BAAC" — still valid, length 4, record
  ↑       ↑

      └───┘            later: "ACB" — valid, length 3, record  ★
      ↑   ↑

record on EVERY valid configuration, then squeeze further
```

### Interview explanation
"This is the *shortest*-window shape, which is the mirror of the longest one. I grow `right` until the window satisfies the requirement, then — while it still satisfies it — I record the length and shrink from the left, because any shorter valid window is a better answer. I record inside the shrink loop, since that is exactly where valid windows live. To keep the validity check O(1) I track `formed`, the number of required characters that currently have enough copies, and compare it against `required`. Both pointers move forward only, so O(n) time. I start `best` at `n+1` as a sentinel so a real answer always beats it."

---

## 5. Generic Templates

> Grow to become valid, shrink while valid, record inside. Sentinel-initialise `best`.

```go
// ShortestWindow is the reusable skeleton. `add`/`remove` maintain the window
// state; `valid` reports whether the requirement is currently satisfied.
func ShortestWindow(n int, add, remove func(i int), valid func() bool) int {
    left, best := 0, n+1

    for right := 0; right < n; right++ {
        add(right)

        for valid() { // every iteration here is a valid window
            if size := right - left + 1; size < best {
                best = size
            }
            remove(left)
            left++
        }
    }

    if best == n+1 {
        return 0 // never satisfied
    }
    return best
}

// MinWindowContaining returns the shortest substring of s containing every
// character of t, honouring duplicate counts.
func MinWindowContaining(s, t string) string {
    if len(t) == 0 || len(s) < len(t) {
        return ""
    }

    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }
    required := len(need) // distinct characters that must be satisfied

    window := make(map[byte]int)
    formed, left := 0, 0
    bestLen, bestStart := len(s)+1, 0

    for right := 0; right < len(s); right++ {
        ch := s[right]
        window[ch]++
        if want, ok := need[ch]; ok && window[ch] == want {
            formed++ // crossed the threshold exactly now
        }

        for formed == required {
            if size := right - left + 1; size < bestLen {
                bestLen, bestStart = size, left
            }
            out := s[left]
            window[out]--
            if want, ok := need[out]; ok && window[out] < want {
                formed--
            }
            left++
        }
    }

    if bestLen == len(s)+1 {
        return ""
    }
    return s[bestStart : bestStart+bestLen]
}
```

```python
def shortest_window(n, add, remove, valid):
    """Skeleton: grow to become valid, shrink while valid, record inside."""
    left, best = 0, n + 1
    for right in range(n):
        add(right)
        while valid():                        # every iteration is a valid window
            best = min(best, right - left + 1)
            remove(left)
            left += 1
    return 0 if best == n + 1 else best

def min_window_containing(s, t):
    from collections import Counter
    if not t or len(s) < len(t):
        return ""

    need = Counter(t)
    required = len(need)                      # distinct chars to satisfy
    window = Counter()
    formed = left = 0
    best_len, best_start = len(s) + 1, 0

    for right, ch in enumerate(s):
        window[ch] += 1
        if ch in need and window[ch] == need[ch]:
            formed += 1                       # crossed the threshold now

        while formed == required:
            if right - left + 1 < best_len:
                best_len, best_start = right - left + 1, left
            out = s[left]
            window[out] -= 1
            if out in need and window[out] < need[out]:
                formed -= 1
            left += 1

    return "" if best_len == len(s) + 1 else s[best_start:best_start + best_len]
```

```java
import java.util.*;

public class ShortestWindow {
    public static String minWindowContaining(String s, String t) {
        if (t.isEmpty() || s.length() < t.length()) return "";

        Map<Character, Integer> need = new HashMap<>();
        for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);
        int required = need.size();

        Map<Character, Integer> window = new HashMap<>();
        int formed = 0, left = 0, bestLen = s.length() + 1, bestStart = 0;

        for (int right = 0; right < s.length(); right++) {
            char ch = s.charAt(right);
            window.merge(ch, 1, Integer::sum);
            if (need.containsKey(ch) && window.get(ch).equals(need.get(ch))) formed++;

            while (formed == required) {
                if (right - left + 1 < bestLen) {
                    bestLen = right - left + 1;
                    bestStart = left;
                }
                char out = s.charAt(left);
                window.merge(out, -1, Integer::sum);
                if (need.containsKey(out) && window.get(out) < need.get(out)) formed--;
                left++;
            }
        }
        return bestLen == s.length() + 1 ? "" : s.substring(bestStart, bestStart + bestLen);
    }
}
```

```cpp
#include <string>
#include <unordered_map>
using namespace std;

string minWindowContaining(const string& s, const string& t) {
    if (t.empty() || s.size() < t.size()) return "";

    unordered_map<char, int> need;
    for (char c : t) ++need[c];
    int required = (int)need.size();

    unordered_map<char, int> window;
    int formed = 0, left = 0;
    int bestLen = (int)s.size() + 1, bestStart = 0;

    for (int right = 0; right < (int)s.size(); ++right) {
        char ch = s[right];
        ++window[ch];
        if (need.count(ch) && window[ch] == need[ch]) ++formed;

        while (formed == required) {
            if (right - left + 1 < bestLen) {
                bestLen = right - left + 1;
                bestStart = left;
            }
            char out = s[left];
            --window[out];
            if (need.count(out) && window[out] < need[out]) --formed;
            ++left;
        }
    }
    return bestLen == (int)s.size() + 1 ? "" : s.substr(bestStart, bestLen);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Shortest Window (Optimal) |
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

### Problem — Minimum Window Substring (LeetCode 76)
Return the shortest substring of `s` containing every character of `t`, respecting duplicate counts. Return `""` if there is none.

### Thought Process
1. Shortest window → shrink **while valid**, record **inside** the loop.
2. `need[ch]` says how many copies `t` requires; `window[ch]` says how many the window currently has.
3. `formed` counts how many *distinct* required characters have enough copies. Valid ⇔ `formed == required`.
4. Update `formed` only when a count crosses its threshold (`== need` on the way up, `< need` on the way down) — otherwise extra copies would inflate it.
5. Sentinel `bestLen = len(s) + 1` so any real window wins.

### Dry Run

Input: `s = "ABAACBAB"`, `t = "ABC"` → `need = {A:1, B:1, C:1}`, `required = 3`

| right | ch | window | formed | valid? | shrink steps (record then remove) |
|-------|----|--------|--------|--------|-----------------------------------|
| 0 | A | A:1 | 1 | no | — |
| 1 | B | A:1 B:1 | 2 | no | — |
| 2 | A | A:2 B:1 | 2 | no | — |
| 3 | A | A:3 B:1 | 2 | no | — |
| 4 | C | A:3 B:1 C:1 | **3** | yes | record `"ABAAC"` len **5**; drop `A` → A:2 (still ≥1, `formed` stays 3)<br>record `"BAAC"` len **4**; drop `B` → B:0 < 1 → `formed = 2`, `left = 2` |
| 5 | B | A:2 C:1 B:1 | 3 | yes | record `"AACB"` len 4 (not better); drop `A` → A:1, `formed` stays 3<br>record `"ACB"` len **3** ★; drop `A` → A:0 → `formed = 2`, `left = 4` |
| 6 | A | C:1 B:1 A:1 | 3 | yes | record `"CBA"` len 3 (not better); drop `C` → `formed = 2`, `left = 5` |
| 7 | B | B:2 A:1 | 2 | no | — |

Output: **`"ACB"`** (indices 3..5) ✓

Look at `right = 4`: dropping the first `A` kept the window valid because two more `A`s remained — so the loop kept squeezing and found a length-4 window. That is why we track *counts*, not mere presence.

### Visualization

```text
s = A  B  A  A  C  B  A  B
    0  1  2  3  4  5  6  7

    └──────────────┘         "ABAAC"  valid, length 5
       └───────────┘         "BAAC"   valid, length 4
                └────────┘   "ACB"    valid, length 3   ★
                3  4  5

record on every valid configuration, then squeeze from the left
```

### Code

```go
func minWindow(s string, t string) string {
    if len(t) == 0 || len(s) < len(t) {
        return ""
    }

    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }
    required := len(need) // distinct characters that must be satisfied

    window := make(map[byte]int)
    formed, left := 0, 0
    bestLen, bestStart := len(s)+1, 0 // sentinel

    for right := 0; right < len(s); right++ {
        ch := s[right]
        window[ch]++
        if want, ok := need[ch]; ok && window[ch] == want {
            formed++ // crossed the threshold exactly now
        }

        // Valid: record, then squeeze from the left.
        for formed == required {
            if size := right - left + 1; size < bestLen {
                bestLen, bestStart = size, left
            }

            out := s[left]
            window[out]--
            if want, ok := need[out]; ok && window[out] < want {
                formed-- // dropped below the threshold
            }
            left++
        }
    }

    if bestLen == len(s)+1 {
        return ""
    }
    return s[bestStart : bestStart+bestLen]
}
```

```python
from collections import Counter

def minWindow(s, t):
    if not t or len(s) < len(t):
        return ""

    need = Counter(t)
    required = len(need)
    window = Counter()
    formed = left = 0
    best_len, best_start = len(s) + 1, 0     # sentinel

    for right, ch in enumerate(s):
        window[ch] += 1
        if ch in need and window[ch] == need[ch]:
            formed += 1                       # crossed the threshold

        while formed == required:             # valid: record, then squeeze
            if right - left + 1 < best_len:
                best_len, best_start = right - left + 1, left
            out = s[left]
            window[out] -= 1
            if out in need and window[out] < need[out]:
                formed -= 1
            left += 1

    return "" if best_len == len(s) + 1 else s[best_start:best_start + best_len]
```

### Complexity
Time O(|s| + |t|), Space O(|s| + |t|).

---

## 10. Solved Example 2

### Problem — Minimum Size Subarray Sum (LeetCode 209)
With **positive** integers and a `target`, return the length of the shortest subarray whose sum is ≥ `target`, or `0` if none exists.

### Thought Process
1. Shortest window → record inside the shrink loop.
2. The window state is a single running sum, so validity is one comparison.
3. All values are positive, which is what makes the window monotone: adding always grows the sum, removing always shrinks it. Without that, a too-large window could not reliably be fixed by moving `left`.
4. Sentinel `best = n + 1`; translate to `0` at the end.

### Dry Run

Input: `nums = [1, 2, 3, 4, 5]`, `target = 11`

| right | nums[right] | sum | valid (`≥ 11`)? | record / shrink | left | best |
|-------|-------------|-----|------------------|-----------------|------|------|
| 0 | 1 | 1  | no | — | 0 | — |
| 1 | 2 | 3  | no | — | 0 | — |
| 2 | 3 | 6  | no | — | 0 | — |
| 3 | 4 | 10 | no | — | 0 | — |
| 4 | 5 | 15 | yes | record len **5**; drop `1` → sum 14 | 1 | 5 |
|   |   | 14 | yes | record len **4**; drop `2` → sum 12 | 2 | 4 |
|   |   | 12 | yes | record len **3**; drop `3` → sum 9  | 3 | **3** |
|   |   | 9  | no  | exit the shrink loop | 3 | 3 |

Output: **3** — the subarray `[3, 4, 5]` with sum 12. ✓

Note that the answer was found by *shrinking a valid window*, not by growing into one. That is the shortest-window rhythm.

### Visualization

```text
nums:  1   2   3   4   5
       0   1   2   3   4

  └────────────────────┘     sum 15  valid, length 5
      └────────────────┘     sum 14  valid, length 4
          └────────────┘     sum 12  valid, length 3   ★
              └────────┘     sum  9  INVALID → stop shrinking
```

### Code

```go
func minSubArrayLen(target int, nums []int) int {
    left, sum := 0, 0
    best := len(nums) + 1 // sentinel: beats any real window

    for right := 0; right < len(nums); right++ {
        sum += nums[right]

        // Valid: record it, then squeeze to look for something shorter.
        for sum >= target {
            if size := right - left + 1; size < best {
                best = size
            }
            sum -= nums[left]
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
    best = len(nums) + 1                  # sentinel

    for right, x in enumerate(nums):
        total += x
        while total >= target:            # valid: record, then squeeze
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1

    return 0 if best == len(nums) + 1 else best
```

### Complexity
Time O(n), Space O(1).

> **Follow-up (the O(n log n) version).** Build the prefix sums, which are strictly increasing because the values are positive. For each `right`, binary-search the largest `left` with `pre[right+1] − pre[left] >= target`. That trades the linear scan for a logarithmic search and is the natural answer when the interviewer asks for a second approach.

---

## 11. Solved Example 3

### Problem — Replace the Substring for Balanced String (LeetCode 1234)
`s` has length `n` (a multiple of 4) and contains only `Q`, `W`, `E`, `R`. A string is *balanced* when each letter appears exactly `n/4` times. You may replace **one contiguous substring** with any characters. Return the minimum length you must replace.

### Thought Process
1. The replaced substring can become anything, so its contents don't matter — only what's left **outside** it does.
2. So the question becomes: **find the shortest window such that every letter outside it appears at most `n/4` times.** Whatever deficit remains can be filled by the replaced part.
3. That's a shortest-window problem, so: grow `right`, and while valid, record and shrink.
4. Neat implementation trick: keep the count array as *the counts outside the window*. Moving an index into the window **decrements** its count; moving it back out **increments** it.
5. If the string is already balanced, the answer is `0`.

### Dry Run

Input: `s = "QQWE"` → `n = 4`, so each letter must appear `k = 1` time.

Initial outside-counts (the whole string): `Q:2, W:1, E:1, R:0`. Not balanced (`Q` is over), so we search.

Valid means: every outside-count is `<= 1`.

| right | ch | outside-counts after moving `s[right]` in | valid? | action |
|-------|----|--------------------------------------------|--------|--------|
| 0 | Q | `Q:1, W:1, E:1, R:0` | **yes** | record len **1**; move `s[0]` back out → `Q:2`, `left = 1` |
|   |   | `Q:2, W:1, E:1, R:0` | no | exit shrink loop |
| 1 | Q | `Q:1, W:1, E:1, R:0` | **yes** | record len **1**; move `s[1]` back out → `Q:2`, `left = 2` |
|   |   | `Q:2, …` | no | exit |
| 2 | W | `Q:2, W:0, E:1, R:0` | no (`Q:2 > 1`) | — |
| 3 | E | `Q:2, W:0, E:0, R:0` | no (`Q:2 > 1`) | — |

Output: **1** — replace one of the two `Q`s (say index 0) to get `"WQWE"`… more precisely, replacing `s[0..0]` with `"R"` gives `"RQWE"`, which has one of each. ✓

### Visualization

```text
s = Q  Q  W  E        n = 4, each letter needs exactly 1

    ┌──┐
    Q                 window = the part we will replace
       └─ outside = "QWE" → Q:1 W:1 E:1  all ≤ 1  ✓ valid

    length 1 is enough  →  answer 1

if the window were empty, outside = "QQWE" → Q:2 > 1  ✗
```

### Code

```go
func balancedString(s string) int {
    n := len(s)
    k := n / 4

    // count holds the tally of characters OUTSIDE the window.
    // It starts as the whole string, since the window starts empty.
    count := map[byte]int{'Q': 0, 'W': 0, 'E': 0, 'R': 0}
    for i := 0; i < n; i++ {
        count[s[i]]++
    }

    balanced := func() bool {
        return count['Q'] <= k && count['W'] <= k && count['E'] <= k && count['R'] <= k
    }

    if balanced() {
        return 0 // already balanced: replace nothing
    }

    best, left := n, 0
    for right := 0; right < n; right++ {
        count[s[right]]-- // s[right] moves INTO the window

        for left <= right && balanced() {
            if size := right - left + 1; size < best {
                best = size
            }
            count[s[left]]++ // s[left] moves back OUT of the window
            left++
        }
    }
    return best
}
```

```python
def balancedString(s):
    n = len(s)
    k = n // 4

    # count = tally of characters OUTSIDE the window (window starts empty)
    count = {'Q': 0, 'W': 0, 'E': 0, 'R': 0}
    for ch in s:
        count[ch] += 1

    def balanced():
        return all(v <= k for v in count.values())

    if balanced():
        return 0                     # already balanced

    best, left = n, 0
    for right, ch in enumerate(s):
        count[ch] -= 1               # s[right] moves INTO the window

        while left <= right and balanced():
            best = min(best, right - left + 1)
            count[s[left]] += 1      # s[left] moves back OUT
            left += 1

    return best
```

### Complexity
Time O(n) — the validity check inspects a fixed four letters. Space O(1).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 76 | Min Window | Easy | Core sliding window application |
| 209 | Min Size Subarray | Easy | Core sliding window application |
| 1234 | Balanced String | Medium | Core sliding window application |
| 632 | Smallest Range | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Shortest Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Shortest Window (Sliding Window).
- **Signal:** shortest, minimum window, cover, at least, min length.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Shortest Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Shortest Window
FAMILY : Sliding Window (Intermediate)
WHEN   : shortest, minimum window, cover, at least, min length
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 76, 209, 1234, 632
```

---

*Part of the DSA Patterns Handbook — pattern 16 of 100.*
