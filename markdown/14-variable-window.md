# 14 · Variable Size Window

> **One-liner:** Grow the window to include, shrink to restore validity under a constraint.

---

## 1. Overview

### Definition
The **Variable Size Window** pattern belongs to the *Sliding Window* family. Grow the window to include, shrink to restore validity under a constraint.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
sliding window, variable, expand shrink, constraint, at most.

### Constraints
- Input size where the brute-force complexity would time out — the Variable Size Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Variable Size Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Variable Size Window is the upgrade.
- The wording maps onto: sliding window, variable, expand shrink, constraint, at most.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the longest (or shortest) contiguous stretch that satisfies some rule?"* — where the size is **not** given.

### Intuition
Try every possible stretch. There are `n(n+1)/2` of them.

### Algorithm
1. For each start `left` from `0` to `n−1`:
2. &nbsp;&nbsp;For each end `right` from `left` to `n−1`:
3. &nbsp;&nbsp;&nbsp;&nbsp;Check whether `nums[left..right]` satisfies the rule.
4. &nbsp;&nbsp;&nbsp;&nbsp;If it does, update the best length.

### Complexity
- Time: **O(n²)** if the check is O(1), **O(n³)** if you re-scan the stretch to check it.
- Space: O(1) to O(n).

### Drawbacks
- Restarting from every `left` throws away everything learned about the previous stretch.
- Worse, it checks stretches that cannot possibly be answers. If `nums[3..7]` already breaks the rule, then `nums[3..8]`, `nums[3..9]`, … all break it too (for the many rules that only get *harder* as the window grows). The brute force tests them anyway.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep one window. Always grow it on the right; shrink it from the left only when you must.**

Neither pointer ever moves backwards. Each travels from `0` to `n` at most once, so the total work is O(n) even though the window is constantly resizing.

### The thought process

```text
We need    : the best window satisfying some rule, size unknown.
Obvious way: test every (left, right) pair.
Too slow   : O(n^2), and it restarts from scratch each time.
Notice     : the rule is usually MONOTONE — a window that is already
             broken stays broken as it grows, and shrinking can only
             help. So we never need to move `right` backwards.
Therefore  : advance `right` one step at a time, and advance `left`
             just far enough to restore/leave the valid state.
Now        : both pointers only move forward → O(n) total.
```

### The one thing to decide: when do I shrink?

Every variable-window problem is one of two shapes, and picking the wrong one is the single biggest source of bugs.

**Shape A — longest valid window** ("longest substring with at most K distinct")

```text
grow right → while the window is INVALID, shrink left
           → record the answer AFTER the while loop (the window is now valid)
```

**Shape B — shortest valid window** ("smallest subarray with sum ≥ target")

```text
grow right → while the window is VALID, record the answer, then shrink left
           → record INSIDE the while loop (that is where valid windows live)
```

Say it out loud before writing code:

| Goal | Shrink while… | Record… |
|---|---|---|
| **Longest** valid | the window is **invalid** | **after** the shrink loop |
| **Shortest** valid | the window is **valid** | **inside** the shrink loop |

Both are the same skeleton. Only the condition and the placement of the update differ.

### Steps (Shape A — longest)

```text
Step 1 → left = 0, best = 0, empty window state.
Step 2 → For right = 0 .. n-1:
Step 3 →     add nums[right] to the window state
Step 4 →     while the window is invalid:
Step 5 →         remove nums[left] from the state; left++
Step 6 →     best = max(best, right - left + 1)   ← window is valid here
Step 7 → Return best.
```

### Why this is O(n) even with a nested loop

The inner `while` looks like it could make things quadratic, but `left` only ever **increases**, and it can never exceed `n`. So across the entire run the inner loop body executes at most `n` times in total — not `n` times per iteration. Adding the outer loop's `n` steps gives at most `2n` operations.

This is *amortised* analysis: don't count the worst single step, count the total.

### The prerequisite: the rule must be monotone

Sliding windows need this property:

> Growing the window can only make the rule **harder** to satisfy; shrinking can only make it **easier**.

"At most K distinct characters", "no repeated characters", "sum ≥ target with all-positive numbers" all qualify.

**Where it breaks:** `sum == k` with **negative numbers**. Adding an element might *decrease* the sum, so a too-large window isn't necessarily fixed by shrinking, and a broken window may become valid again later. For that, use prefix sums plus a hash map — see the Prefix Sum chapter.

### How should I recognize this?

```text
If you see...
  "longest / shortest / maximum / minimum" + "substring / subarray"
  "at most K ...", "containing all of ...", "without repeating ..."
  contiguous, and the size is NOT given
        ↓
Think about...
  "Does growing the window only ever make things worse?"
  If yes → sliding window. If no (negatives!) → prefix sums.
        ↓
Use...
  longest  → shrink while INVALID,  record after
  shortest → shrink while VALID,    record inside
```

### Visual explanation

```svg
<svg viewBox="0 0 640 180" width="100%" height="180" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-14" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Variable window: R expands, L shrinks to restore validity</text>
  <g>
    <rect x="40"  y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="63"  y="83" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="90"  y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="113" y="83" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="140" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="83" text-anchor="middle" fill="#1e293b">c</text>
    <rect x="190" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="213" y="83" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="240" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="263" y="83" text-anchor="middle" fill="#1e293b">d</text>
    <rect x="290" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="313" y="83" text-anchor="middle" fill="#1e293b">e</text>
  </g>
  <rect x="86" y="51" width="154" height="54" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="113" y="45" text-anchor="middle" fill="#059669" font-weight="700">L</text>
  <text x="213" y="45" text-anchor="middle" fill="#2563eb" font-weight="700">R</text>
  <line x1="118" y1="120" x2="80" y2="120" stroke="#d97706" marker-end="url(#a-14)"/>
  <text x="150" y="124" text-anchor="middle" fill="#d97706">shrink L</text>
  <line x1="238" y1="120" x2="330" y2="120" stroke="#059669" marker-end="url(#a-14)"/>
  <text x="292" y="114" text-anchor="middle" fill="#059669">expand R →</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">while invalid: drop arr[L], L++   ·   best = max(best, R − L + 1)</text>
</svg>
```

```text
"abcabcbb", longest substring with no repeated characters

a b c a b c b b
└───┘              window "abc"  valid, length 3
  ↑ ↑
 left right

a b c a b c b b        'a' arrives, but 'a' is already inside
└─────┘                → shrink left past the old 'a'
    ↑ ↑
   left right          window "bca", still length 3

left never moves backwards → O(n)
```

### Interview explanation
"The window size isn't given, so I'll keep a variable window with two pointers that both only move forward. I expand `right` one element at a time and maintain the window's state incrementally. Because the rule is monotone — growing can only break it further — I can shrink from the left until the window is valid again instead of restarting. For a *longest* answer I record after the shrink loop, when the window is guaranteed valid; for a *shortest* answer I record inside it. Each pointer traverses the array once, so it's O(n) time."

---

## 5. Generic Templates

> One skeleton, two variants. The difference is *when* you shrink and *where* you record.

```go
// LongestValidWindow — Shape A: shrink while INVALID, record after.
// Here the rule is "at most k distinct values".
func LongestValidWindow(nums []int, k int) int {
    window := make(map[int]int) // value -> count inside the window
    left, best := 0, 0

    for right := 0; right < len(nums); right++ {
        window[nums[right]]++ // grow

        // Shrink until the window is valid again.
        for len(window) > k {
            window[nums[left]]--
            if window[nums[left]] == 0 {
                delete(window, nums[left]) // len(window) must mean "distinct"
            }
            left++
        }

        // The window is valid here.
        if size := right - left + 1; size > best {
            best = size
        }
    }
    return best
}

// ShortestValidWindow — Shape B: shrink while VALID, record inside.
// Here the rule is "sum >= target", with non-negative numbers.
func ShortestValidWindow(nums []int, target int) int {
    left, sum := 0, 0
    best := len(nums) + 1 // sentinel meaning "not found"

    for right := 0; right < len(nums); right++ {
        sum += nums[right] // grow

        // While still valid, record and keep shrinking to look for smaller.
        for sum >= target {
            if size := right - left + 1; size < best {
                best = size
            }
            sum -= nums[left]
            left++
        }
    }

    if best == len(nums)+1 {
        return 0 // no valid window exists
    }
    return best
}
```

```python
def longest_valid_window(nums, k):
    """Shape A: shrink while INVALID, record after. Rule: at most k distinct."""
    window = {}                        # value -> count
    left = best = 0

    for right, x in enumerate(nums):
        window[x] = window.get(x, 0) + 1          # grow

        while len(window) > k:                    # shrink until valid
            window[nums[left]] -= 1
            if window[nums[left]] == 0:
                del window[nums[left]]            # keep len() meaning "distinct"
            left += 1

        best = max(best, right - left + 1)        # valid here
    return best

def shortest_valid_window(nums, target):
    """Shape B: shrink while VALID, record inside. Rule: sum >= target."""
    left = total = 0
    best = len(nums) + 1                          # sentinel: not found

    for right, x in enumerate(nums):
        total += x                                # grow
        while total >= target:                    # still valid: record, shrink
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1

    return 0 if best == len(nums) + 1 else best
```

```java
import java.util.*;

public class VariableWindow {
    // Shape A: shrink while INVALID, record after. Rule: at most k distinct.
    public static int longestValidWindow(int[] nums, int k) {
        Map<Integer, Integer> window = new HashMap<>();
        int left = 0, best = 0;

        for (int right = 0; right < nums.length; right++) {
            window.merge(nums[right], 1, Integer::sum);           // grow

            while (window.size() > k) {                           // shrink until valid
                if (window.merge(nums[left], -1, Integer::sum) == 0)
                    window.remove(nums[left]);
                left++;
            }

            best = Math.max(best, right - left + 1);              // valid here
        }
        return best;
    }

    // Shape B: shrink while VALID, record inside. Rule: sum >= target.
    public static int shortestValidWindow(int[] nums, int target) {
        int left = 0, sum = 0, best = nums.length + 1;

        for (int right = 0; right < nums.length; right++) {
            sum += nums[right];                                   // grow
            while (sum >= target) {                               // record, then shrink
                best = Math.min(best, right - left + 1);
                sum -= nums[left++];
            }
        }
        return best == nums.length + 1 ? 0 : best;
    }
}
```

```cpp
#include <unordered_map>
#include <vector>
using namespace std;

// Shape A: shrink while INVALID, record after. Rule: at most k distinct.
int longestValidWindow(const vector<int>& nums, int k) {
    unordered_map<int, int> window;
    int left = 0, best = 0;

    for (int right = 0; right < (int)nums.size(); ++right) {
        ++window[nums[right]];                                  // grow

        while ((int)window.size() > k) {                        // shrink until valid
            if (--window[nums[left]] == 0) window.erase(nums[left]);
            ++left;
        }

        best = max(best, right - left + 1);                     // valid here
    }
    return best;
}

// Shape B: shrink while VALID, record inside. Rule: sum >= target.
int shortestValidWindow(const vector<int>& nums, int target) {
    int left = 0, sum = 0, best = (int)nums.size() + 1;

    for (int right = 0; right < (int)nums.size(); ++right) {
        sum += nums[right];                                     // grow
        while (sum >= target) {                                 // record, then shrink
            best = min(best, right - left + 1);
            sum -= nums[left++];
        }
    }
    return best == (int)nums.size() + 1 ? 0 : best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Variable Size Window (Optimal) |
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

### Problem — Longest Substring Without Repeating Characters (LeetCode 3)
Return the length of the longest substring of `s` with no repeated characters.

### Thought Process
1. This is **Shape A** — a *longest* window — so: shrink while invalid, record after.
2. "Invalid" here means the window contains a duplicate.
3. Instead of shrinking one step at a time, we can jump: remember the last index of each character, and when a repeat arrives, move `left` to just past the previous occurrence.
4. The guard `lastSeen[ch] >= left` matters — a previous occurrence that already fell out of the window must be ignored, or `left` would move backwards.

### Dry Run

Input: `s = "abcabcbb"`

`lastSeen` maps each character to the most recent index where it appeared.

| right | ch | lastSeen[ch] | inside window (`>= left`)? | left | window | length | best |
|-------|----|--------------|-----------------------------|------|--------|--------|------|
| 0 | a | — | no | 0 | `"a"`   | 1 | 1 |
| 1 | b | — | no | 0 | `"ab"`  | 2 | 2 |
| 2 | c | — | no | 0 | `"abc"` | 3 | **3** |
| 3 | a | 0 | yes (`0 >= 0`) | `0+1 = 1` | `"bca"` | 3 | 3 |
| 4 | b | 1 | yes (`1 >= 1`) | `1+1 = 2` | `"cab"` | 3 | 3 |
| 5 | c | 2 | yes (`2 >= 2`) | `2+1 = 3` | `"abc"` | 3 | 3 |
| 6 | b | 4 | yes (`4 >= 3`) | `4+1 = 5` | `"cb"`  | 2 | 3 |
| 7 | b | 6 | yes (`6 >= 5`) | `6+1 = 7` | `"b"`   | 1 | 3 |

Output: **3** — from `"abc"`.

**Why the `>= left` guard matters:** consider `s = "abba"`. At `right = 3` (`a`), `lastSeen['a'] = 0`, but `left` has already moved to `2`. Since `0 < 2`, that `a` is outside the window — we must *not* pull `left` back to `1`. Without the guard the window would be wrong and the answer would come out as 3 instead of 2.

### Visualization

```text
s = a  b  c  a  b  c  b  b
    0  1  2  3  4  5  6  7

    ┌────────┐
    a  b  c              window "abc"  length 3  ★
    ↑     ↑
   left right

       ┌────────┐
    a  b  c  a           'a' repeats (last seen at 0, inside window)
       ↑     ↑           → left jumps to 0+1 = 1
      left right         window "bca", still length 3
```

### Code

```go
func lengthOfLongestSubstring(s string) int {
    lastSeen := make(map[byte]int) // character -> most recent index
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        ch := s[right]
        // Only react to a repeat that is still INSIDE the window.
        if prev, ok := lastSeen[ch]; ok && prev >= left {
            left = prev + 1 // jump past the previous occurrence
        }
        lastSeen[ch] = right

        if size := right - left + 1; size > best {
            best = size
        }
    }
    return best
}
```

```python
def lengthOfLongestSubstring(s):
    last_seen = {}                     # character -> most recent index
    left = best = 0

    for right, ch in enumerate(s):
        # Only react to a repeat still INSIDE the window.
        if ch in last_seen and last_seen[ch] >= left:
            left = last_seen[ch] + 1   # jump past the previous occurrence
        last_seen[ch] = right
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n) — `right` advances once per character and `left` never moves backwards. Space O(min(n, alphabet)).

---

## 10. Solved Example 2

### Problem — Minimum Window Substring (LeetCode 76)
Return the shortest substring of `s` that contains every character of `t`, **including duplicates**. Return `""` if none exists.

### Thought Process
1. This is **Shape B** — a *shortest* window — so: shrink while valid, record inside.
2. Track `need[ch]` = how many of each character `t` requires.
3. Track `formed` = how many **distinct required characters** currently have *enough* copies in the window. The window is valid when `formed == required`.
4. Counting distinct-characters-satisfied (rather than total characters) keeps validity checking O(1) instead of comparing whole maps.
5. Expand `right` until valid; then record the length and shrink `left` while still valid, looking for something smaller.

### Dry Run

Input: `s = "ADOBECODEBANC"`, `t = "ABC"` → `need = {A:1, B:1, C:1}`, `required = 3`

Only the moments where validity changes are shown.

| right | char | window | formed | valid? | action |
|-------|------|--------|--------|--------|--------|
| 0 | A | `"A"` | 1 | no | grow |
| 3 | B | `"ADOB"` | 2 | no | grow |
| 5 | C | `"ADOBEC"` | **3** | **yes** | record length **6**; shrink: drop `A` → `formed = 2`, `left = 1` |
| 10 | A | `"DOBECODEBA"` | 3 | yes | length 10, no better; shrink `D`,`O`,`B`,`E` → window `"CODEBA"` (length 6, not smaller); dropping `C` makes `formed = 2`, `left = 6` |
| 12 | C | `"ODEBANC"` | 3 | yes | length 7; shrink `O`,`D`,`E` → window **`"BANC"`** length **4** ★; dropping `B` makes `formed = 2`, `left = 10` |

Output: **`"BANC"`**

Note the shrink at `right = 10`: the window contained *two* `B`s, so dropping the first one kept `formed` at 3 — the window stayed valid and kept shrinking. That is why we count copies, not just presence.

### Visualization

```text
s = A  D  O  B  E  C  O  D  E  B  A  N  C
    0  1  2  3  4  5  6  7  8  9 10 11 12

    └──────── "ADOBEC" ────┘        valid, length 6

                          └──── "BANC" ────┘
                           9 10 11 12       valid, length 4  ★

grow right until valid → then shrink left while STILL valid
```

### Code

```go
func minWindow(s string, t string) string {
    if len(s) < len(t) || len(t) == 0 {
        return ""
    }

    need := make(map[byte]int) // character -> how many t requires
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }
    required := len(need) // distinct characters we must satisfy

    window := make(map[byte]int)
    formed := 0 // distinct characters currently satisfied
    left := 0
    bestLen, bestStart := len(s)+1, 0

    for right := 0; right < len(s); right++ {
        ch := s[right]
        window[ch]++
        // Only counts once, at the moment this character becomes satisfied.
        if want, ok := need[ch]; ok && window[ch] == want {
            formed++
        }

        // Valid: record, then shrink to look for something smaller.
        for formed == required {
            if size := right - left + 1; size < bestLen {
                bestLen, bestStart = size, left
            }

            out := s[left]
            window[out]--
            if want, ok := need[out]; ok && window[out] < want {
                formed-- // this character just became unsatisfied
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
    required = len(need)               # distinct characters to satisfy

    window = Counter()
    formed = 0
    left = 0
    best_len, best_start = len(s) + 1, 0

    for right, ch in enumerate(s):
        window[ch] += 1
        if ch in need and window[ch] == need[ch]:
            formed += 1                # just became satisfied

        while formed == required:      # valid: record, then shrink
            if right - left + 1 < best_len:
                best_len, best_start = right - left + 1, left

            out = s[left]
            window[out] -= 1
            if out in need and window[out] < need[out]:
                formed -= 1            # just became unsatisfied
            left += 1

    return "" if best_len == len(s) + 1 else s[best_start:best_start + best_len]
```

### Complexity
Time O(|s| + |t|) — each character of `s` enters and leaves the window at most once. Space O(|s| + |t|) for the two maps.

---

## 11. Solved Example 3

### Problem — Minimum Size Subarray Sum (LeetCode 209)
Given **positive** integers and a `target`, return the length of the shortest contiguous subarray with sum ≥ `target`, or `0` if none exists.

### Thought Process
1. **Shape B** again — shortest valid window: shrink while valid, record inside.
2. All values are positive, which is exactly what makes the window monotone: growing always increases the sum, shrinking always decreases it.
3. Expand `right`, adding to the running sum.
4. While `sum >= target`, record the length and shrink from the left — a smaller valid window may still exist.
5. A sentinel `best = n+1` distinguishes "never found" from a real answer.

**Why positivity is required:** with negatives, shrinking could *increase* the sum, so "the window is too big" would no longer be fixable by moving `left`. That version needs prefix sums instead.

### Dry Run

Input: `nums = [2, 3, 1, 2, 4, 3]`, `target = 7`

| right | nums[right] | sum after add | shrink steps (while `sum >= 7`) | window | best |
|-------|-------------|---------------|----------------------------------|--------|------|
| 0 | 2 | 2  | — | `[2]` | — |
| 1 | 3 | 5  | — | `[2,3]` | — |
| 2 | 1 | 6  | — | `[2,3,1]` | — |
| 3 | 2 | 8  | record len **4**; drop `2` → sum 6, `left=1` | `[3,1,2]` | 4 |
| 4 | 4 | 10 | record len **4**; drop `3` → sum 7, `left=2`<br>record len **3**; drop `1` → sum 6, `left=3` | `[2,4]` | 3 |
| 5 | 3 | 9  | record len **3**; drop `2` → sum 7, `left=4`<br>record len **2**; drop `4` → sum 3, `left=5` | `[3]` | **2** |

Output: **2** — the subarray `[4, 3]`. ✓

### Visualization

```text
nums:  2   3   1   2   4   3
       0   1   2   3   4   5

right=3:  └───────────┘         sum 8 >= 7, length 4
          left      right

right=5:              └───┘     sum 7 >= 7, length 2   ★
                     left right

each shrink is only taken while the window is still VALID,
so the recorded length is always a real answer
```

### Code

```go
func minSubArrayLen(target int, nums []int) int {
    left, sum := 0, 0
    best := len(nums) + 1 // sentinel: larger than any real window

    for right := 0; right < len(nums); right++ {
        sum += nums[right]

        // While the window is still valid, record it and try to shrink.
        for sum >= target {
            if size := right - left + 1; size < best {
                best = size
            }
            sum -= nums[left]
            left++
        }
    }

    if best == len(nums)+1 {
        return 0 // no window ever reached the target
    }
    return best
}
```

```python
def minSubArrayLen(target, nums):
    left = total = 0
    best = len(nums) + 1               # sentinel: larger than any real window

    for right, x in enumerate(nums):
        total += x
        while total >= target:         # still valid: record, then shrink
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1

    return 0 if best == len(nums) + 1 else best
```

### Complexity
Time O(n) — `right` advances `n` times and `left` advances at most `n` times in total. Space O(1).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 3 | Longest Substring | Easy | Core sliding window application |
| 76 | Min Window | Easy | Core sliding window application |
| 209 | Min Size Subarray | Medium | Core sliding window application |
| 424 | Char Replacement | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Variable Size Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Variable Size Window (Sliding Window).
- **Signal:** sliding window, variable, expand shrink, constraint, at most.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Variable Size Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Variable Size Window
FAMILY : Sliding Window (Intermediate)
WHEN   : sliding window, variable, expand shrink, constraint, at most
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 3, 76, 209, 424
```

---

*Part of the DSA Patterns Handbook — pattern 14 of 100.*
