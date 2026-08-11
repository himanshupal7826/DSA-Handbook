# 15 · Longest Window

> **One-liner:** Maximize window length; shrink only when the window becomes invalid.

---

## 1. Overview

### Definition
The **Longest Window** pattern belongs to the *Sliding Window* family. Maximize window length; shrink only when the window becomes invalid.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
longest, maximum window, at most k, substring, distinct.

### Constraints
- Input size where the brute-force complexity would time out — the Longest Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Longest Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Longest Window is the upgrade.
- The wording maps onto: longest, maximum window, at most k, substring, distinct.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the **longest** contiguous stretch I can take before some budget runs out?"*

The budget varies — *no repeated characters*, *at most `k` replacements*, *at most `k` zeros flipped* — but the shape never does.

### Intuition
Check every stretch and keep the longest valid one.

### Algorithm
1. For each start `left`:
2. &nbsp;&nbsp;For each end `right >= left`:
3. &nbsp;&nbsp;&nbsp;&nbsp;Verify the stretch `[left..right]` obeys the budget.
4. &nbsp;&nbsp;&nbsp;&nbsp;If it does, update the best length.

### Complexity
- Time: **O(n²)** with an incrementally maintained check, **O(n³)** with a naive rescan.
- Space: O(1) to O(k).

### Drawbacks
- Once `[left..right]` blows the budget, so does every longer stretch from the same `left` — but the brute force keeps testing them.
- Every restart from a new `left` recomputes counts the previous pass already knew.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Grow the window greedily; the moment the budget is blown, shrink from the left just enough to get back inside it — then measure.**

This is the *longest* variant of the sliding window, and it has a fixed shape you can write from memory:

```text
for right in 0..n-1:
    add nums[right] to the window
    while the window is INVALID:
        remove nums[left]; left++
    best = max(best, right - left + 1)      ← window is valid HERE
```

The placement of that last line is the whole pattern. Because the `while` loop only exits when the window is valid again, measuring afterwards is always safe.

### The thought process

```text
We need    : the longest window obeying some budget.
Obvious way: test every (left, right) pair.
Too slow   : O(n^2), and it restarts from scratch each time.
Notice     : if a window is already over budget, extending it can only
             make things worse. So `right` never needs to back up.
Notice too : shrinking from the left always helps, and we only need to
             shrink until we're legal again — not one step further.
Therefore  : grow right always, shrink left minimally, measure after.
Now        : both pointers move forward only → O(n).
```

### Why "shrink the *minimum* amount" is what makes it *longest*

If you over-shrink, you throw away a valid window that might have been the longest. The `while` loop's exit condition is precisely "we are legal again", so it stops at the largest window that starts at or after the old `left`. Combined with growing `right` as far as possible, you measure the longest window ending at each `right` — and the best of those is the global answer.

### The universal budget trick

Most "longest window" problems reduce to counting a single quantity and comparing it against `k`:

| Problem | The window state | Invalid when |
|---|---|---|
| Longest substring, no repeats | count of each character | any count > 1 |
| Longest with at most K distinct | map of character → count | `len(map) > K` |
| Max consecutive ones after k flips | number of zeros inside | `zeros > k` |
| Longest repeating char replacement | counts + the most frequent count | `length − maxCount > k` |

That last row is worth its own sentence, because it is the least obvious:

> **To make a window all one character, you must replace every character that isn't the most frequent one. So the cost is `windowLength − maxCount`, and the window is valid while that cost is ≤ `k`.**

You never have to decide *which* character to keep — the most frequent one is always the cheapest choice.

### Steps

```text
Step 1 → left = 0, best = 0, empty window state.
Step 2 → For right = 0 .. n-1:
Step 3 →     add nums[right] to the state
Step 4 →     while the state violates the budget:
Step 5 →         remove nums[left] from the state; left++
Step 6 →     best = max(best, right - left + 1)
Step 7 → Return best.
```

### How should I recognize this?

```text
If you see...
  "longest / maximum length" + "substring / subarray"
  "at most K ...", "you may change up to k ...", "without repeating"
  contiguous, and you get a budget you must not exceed
        ↓
Think about...
  "What single number measures how far over budget I am?"
        ↓
Use...
  grow right → while over budget, shrink left → measure AFTER
```

> **Contrast with the shortest-window variant:** there you shrink *while valid* and measure *inside* the loop. Getting these backwards is the classic bug. Longest = measure after; shortest = measure inside.

### Visual explanation

```svg
<svg viewBox="0 0 640 180" width="100%" height="180" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-15" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Longest window: keep growing, shrink ONLY when invalid</text>
  <g>
    <rect x="40"  y="55" width="46" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="63"  y="83" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="90"  y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="113" y="83" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="140" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="83" text-anchor="middle" fill="#1e293b">c</text>
    <rect x="190" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="213" y="83" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="240" y="55" width="46" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="263" y="83" text-anchor="middle" fill="#1e293b">d</text>
    <rect x="290" y="55" width="46" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="313" y="83" text-anchor="middle" fill="#1e293b">a</text>
  </g>
  <rect x="86" y="51" width="204" height="54" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="188" y="122" text-anchor="middle" fill="#059669" font-weight="700">longest valid window = 4</text>
  <line x1="300" y1="126" x2="360" y2="126" stroke="#475569" marker-end="url(#a-15)"/>
  <text x="330" y="120" text-anchor="middle" fill="#64748b">grow →</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">'a' repeats ⇒ shrink L past old 'a', then track best length</text>
</svg>
```

```text
"AABABBA", k = 1 replacement allowed

A A B A B B A
└─────┘              window "AABA": length 4, maxCount(A) = 3
  ↑   ↑              cost = 4 - 3 = 1 replacement  ≤ k  ✓
 left right

A A B A B B A
└───────┘            window "AABAB": length 5, maxCount(A) = 3
  ↑     ↑            cost = 5 - 3 = 2  > k  ✗  → shrink left
 left  right

answer: 4
```

### Interview explanation
"This is the *longest* variable-window shape. I grow `right` one element at a time and keep the window's state incrementally. Whenever the state breaks the budget, I shrink from the left — but only until it's legal again, since over-shrinking would discard a potentially longer answer. Then I measure, which is safe because the loop only exits on a valid window. Both pointers move forward only, so it's O(n) time. For the replacement problem, the state I track is the count of the most frequent character, because `windowLength − maxCount` is exactly how many replacements the window needs."

---

## 5. Generic Templates

> Grow right, shrink while invalid, measure after. Only the state and the invalid-test change.

```go
// LongestWindow is the reusable skeleton. `add` and `remove` maintain the
// window state; `invalid` reports whether the budget is currently blown.
func LongestWindow(n int, add, remove func(i int), invalid func(left, right int) bool) int {
    left, best := 0, 0
    for right := 0; right < n; right++ {
        add(right)

        for invalid(left, right) {
            remove(left)
            left++
        }

        if size := right - left + 1; size > best {
            best = size // the window is guaranteed valid here
        }
    }
    return best
}

// LongestAtMostKDistinct: window state is a map; invalid when it holds > k keys.
func LongestAtMostKDistinct(s string, k int) int {
    window := make(map[byte]int)
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        window[s[right]]++

        for len(window) > k {
            window[s[left]]--
            if window[s[left]] == 0 {
                delete(window, s[left]) // len(window) must mean "distinct"
            }
            left++
        }

        if size := right - left + 1; size > best {
            best = size
        }
    }
    return best
}
```

```python
def longest_window(n, add, remove, invalid):
    """Skeleton: add/remove maintain state, invalid reports a blown budget."""
    left = best = 0
    for right in range(n):
        add(right)

        while invalid(left, right):
            remove(left)
            left += 1

        best = max(best, right - left + 1)   # valid here
    return best

def longest_at_most_k_distinct(s, k):
    window = {}
    left = best = 0

    for right, ch in enumerate(s):
        window[ch] = window.get(ch, 0) + 1

        while len(window) > k:
            window[s[left]] -= 1
            if window[s[left]] == 0:
                del window[s[left]]          # keep len() meaning "distinct"
            left += 1

        best = max(best, right - left + 1)
    return best
```

```java
import java.util.*;
import java.util.function.*;

public class LongestWindow {
    // Skeleton: add/remove maintain state, invalid reports a blown budget.
    public static int longestWindow(int n, IntConsumer add, IntConsumer remove,
                                    BiPredicate<Integer, Integer> invalid) {
        int left = 0, best = 0;
        for (int right = 0; right < n; right++) {
            add.accept(right);
            while (invalid.test(left, right)) {
                remove.accept(left);
                left++;
            }
            best = Math.max(best, right - left + 1);   // valid here
        }
        return best;
    }

    public static int longestAtMostKDistinct(String s, int k) {
        Map<Character, Integer> window = new HashMap<>();
        int left = 0, best = 0;

        for (int right = 0; right < s.length(); right++) {
            window.merge(s.charAt(right), 1, Integer::sum);

            while (window.size() > k) {
                if (window.merge(s.charAt(left), -1, Integer::sum) == 0)
                    window.remove(s.charAt(left));
                left++;
            }

            best = Math.max(best, right - left + 1);
        }
        return best;
    }
}
```

```cpp
#include <string>
#include <unordered_map>
using namespace std;

int longestAtMostKDistinct(const string& s, int k) {
    unordered_map<char, int> window;
    int left = 0, best = 0;

    for (int right = 0; right < (int)s.size(); ++right) {
        ++window[s[right]];

        while ((int)window.size() > k) {
            if (--window[s[left]] == 0) window.erase(s[left]);  // keep size() honest
            ++left;
        }

        best = max(best, right - left + 1);                     // valid here
    }
    return best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Longest Window (Optimal) |
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
Return the length of the longest substring with no repeated characters.

### Thought Process
1. Budget: **every character may appear at most once** inside the window.
2. State: a count per character. The window is invalid exactly when the character we just added now has a count of 2.
3. Grow `right`; while invalid, remove `s[left]` and advance `left`.
4. Measure after the shrink loop, where the window is guaranteed valid.
5. Only one character can be over-counted at a time (the one just added), so the loop stops as soon as we pass its earlier copy.

### Dry Run

Input: `s = "abcabcbb"`

| right | ch | count[ch] after add | invalid? | shrink steps | window | length | best |
|-------|----|--------------------|----------|--------------|--------|--------|------|
| 0 | a | a:1 | no  | — | `"a"` | 1 | 1 |
| 1 | b | b:1 | no  | — | `"ab"` | 2 | 2 |
| 2 | c | c:1 | no  | — | `"abc"` | 3 | **3** |
| 3 | a | a:2 | yes | remove `a` (left 0→1) → a:1 | `"bca"` | 3 | 3 |
| 4 | b | b:2 | yes | remove `b` (left 1→2) → b:1 | `"cab"` | 3 | 3 |
| 5 | c | c:2 | yes | remove `c` (left 2→3) → c:1 | `"abc"` | 3 | 3 |
| 6 | b | b:2 | yes | remove `a` (3→4), remove `b` (4→5) → b:1 | `"cb"` | 2 | 3 |
| 7 | b | b:2 | yes | remove `c` (5→6), remove `b` (6→7) → b:1 | `"b"` | 1 | 3 |

Output: **3** — from `"abc"`.

Row 6 shows the shrink loop running **twice**: it removes characters one at a time until the duplicate `b` is gone. That is slower per step than jumping straight past the old index, but `left` still only moves forward `n` times in total, so the overall cost is unchanged.

### Visualization

```text
s = a  b  c  a  b  c  b  b
    0  1  2  3  4  5  6  7

    ┌────────┐
    a  b  c              valid, length 3  ★
    ↑     ↑
   left right

    ┌───────────┐
    a  b  c  a           'a' now appears twice → INVALID
    ↑        ↑
   left    right
       shrink until the duplicate leaves:
       ┌────────┐
       b  c  a           valid again, length 3
```

### Code

```go
func lengthOfLongestSubstring(s string) int {
    var count [128]int // ASCII
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        count[s[right]]++

        // Only the character just added can be over its budget of 1.
        for count[s[right]] > 1 {
            count[s[left]]--
            left++
        }

        if size := right - left + 1; size > best {
            best = size // valid here
        }
    }
    return best
}
```

```python
def lengthOfLongestSubstring(s):
    count = {}
    left = best = 0

    for right, ch in enumerate(s):
        count[ch] = count.get(ch, 0) + 1

        while count[ch] > 1:              # only ch can be over budget
            count[s[left]] -= 1
            left += 1

        best = max(best, right - left + 1)   # valid here
    return best
```

### Complexity
Time O(n) — `left` advances at most `n` times in total across all shrink loops. Space O(alphabet).

> The Variable Window chapter shows the `lastSeen` variant, which jumps `left` directly instead of stepping. Same O(n), fewer iterations; this version is easier to fit into the universal skeleton.

---

## 10. Solved Example 2

### Problem — Longest Repeating Character Replacement (LeetCode 424)
You may change at most `k` characters of `s` to any other uppercase letter. Return the length of the longest substring that can be made of a single repeated character.

### Thought Process
1. Budget: at most `k` replacements inside the window.
2. **Key insight:** to make a window uniform you keep the most frequent character and replace everything else. So the cost is exactly:
   `cost = windowLength − maxCount`, where `maxCount` is the highest count in the window.
3. You never have to *choose* which letter to keep — the most frequent one is always cheapest.
4. Grow `right`; while `cost > k`, shrink from the left.
5. Measure after the shrink loop.

### Dry Run

Input: `s = "AABABBA"`, `k = 1`

| right | ch | counts (A,B) | len | maxCount | cost = len − maxCount | over budget? | after shrinking | best |
|-------|----|--------------|-----|----------|------------------------|--------------|-----------------|------|
| 0 | A | 1,0 | 1 | 1 | 0 | no | `"A"` | 1 |
| 1 | A | 2,0 | 2 | 2 | 0 | no | `"AA"` | 2 |
| 2 | B | 2,1 | 3 | 2 | 1 | no | `"AAB"` | 3 |
| 3 | A | 3,1 | 4 | 3 | 1 | no | `"AABA"` | **4** |
| 4 | B | 3,2 | 5 | 3 | **2** | yes | drop `A` → 2,2 len 4 cost 2 → still over; drop `A` → 1,2 len 3 cost 1 ✓ → `"BAB"` | 4 |
| 5 | B | 1,3 | 4 | 3 | 1 | no | `"BABB"` | 4 |
| 6 | A | 2,3 | 5 | 3 | 2 | yes | drop `B` → 2,2 len 4 cost 2 → still over; drop `A` → 1,2 len 3 cost 1 ✓ → `"BBA"` | 4 |

Output: **4** — the window `"AABA"`: replace its single `B` with `A` to get `"AAAA"`. ✓

Check the cost formula on row 3: window `"AABA"` has length 4 and three `A`s, so one character (`B`) must change — exactly `4 − 3 = 1`, within the budget of `k = 1`.

### Visualization

```text
s = A  A  B  A  B  B  A
    0  1  2  3  4  5  6

    ┌───────────┐
    A  A  B  A              length 4, maxCount(A) = 3
                            replacements needed = 4 - 3 = 1  ≤ k  ✓
                            → replace B with A → "AAAA"       ★

    ┌──────────────┐
    A  A  B  A  B           length 5, maxCount(A) = 3
                            replacements needed = 5 - 3 = 2  > k  ✗
                            → shrink from the left
```

### Code

```go
func characterReplacement(s string, k int) int {
    var count [26]int
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        count[s[right]-'A']++

        // Cost of making this window uniform: keep the most frequent
        // character, replace all the others.
        for (right-left+1)-maxCount(count) > k {
            count[s[left]-'A']--
            left++
        }

        if size := right - left + 1; size > best {
            best = size // valid here
        }
    }
    return best
}

func maxCount(count [26]int) int {
    best := 0
    for _, c := range count {
        if c > best {
            best = c
        }
    }
    return best
}
```

```python
def characterReplacement(s, k):
    count = [0] * 26
    left = best = 0

    for right, ch in enumerate(s):
        count[ord(ch) - 65] += 1

        # Cost = window length minus the most frequent character's count.
        while (right - left + 1) - max(count) > k:
            count[ord(s[left]) - 65] -= 1
            left += 1

        best = max(best, right - left + 1)     # valid here
    return best
```

### Complexity
Time O(26·n) = **O(n)** — recomputing `maxCount` scans a fixed 26-slot array. Space O(1).

> A common refinement never lowers `maxCount` and uses `if` instead of `while`, giving a true O(n) with no inner scan. It works because the answer only ever needs to grow, but the version above is easier to justify — reach for the refinement only after the straightforward one is on the board.

---

## 11. Solved Example 3

### Problem — Max Consecutive Ones III (LeetCode 1004)
Given a binary array and an integer `k`, return the length of the longest run of `1`s obtainable by flipping at most `k` zeros.

### Thought Process
1. Reframe the question. "Flip at most `k` zeros" is just: **the longest window containing at most `k` zeros**. Once you see that, no flipping is ever simulated.
2. Budget: `zeros <= k`. State: a single integer counting zeros inside the window.
3. Grow `right`, incrementing `zeros` when a `0` enters.
4. While `zeros > k`, shrink from the left, decrementing `zeros` when a `0` leaves.
5. Measure after the shrink loop.

This is the cleanest member of the family — the entire window state is one counter.

### Dry Run

Input: `nums = [1,1,1,0,0,0,1,1,1,1,0]`, `k = 2`

| right | nums[right] | zeros | > k? | shrink steps | left | window length | best |
|-------|-------------|-------|------|--------------|------|---------------|------|
| 0 | 1 | 0 | no | — | 0 | 1 | 1 |
| 1 | 1 | 0 | no | — | 0 | 2 | 2 |
| 2 | 1 | 0 | no | — | 0 | 3 | 3 |
| 3 | 0 | 1 | no | — | 0 | 4 | 4 |
| 4 | 0 | 2 | no | — | 0 | 5 | **5** |
| 5 | 0 | 3 | **yes** | drop `1`,`1`,`1` (zeros stays 3), drop `0` → zeros 2 | 4 | 2 | 5 |
| 6 | 1 | 2 | no | — | 4 | 3 | 5 |
| 7 | 1 | 2 | no | — | 4 | 4 | 5 |
| 8 | 1 | 2 | no | — | 4 | 5 | 5 |
| 9 | 1 | 2 | no | — | 4 | **6** | **6** |
| 10| 0 | 3 | **yes** | drop `0` at index 4 → zeros 2 | 5 | 6 | 6 |

Output: **6** — the window at indices 4..9 (`[0,0,1,1,1,1]`): flip the two zeros to get six consecutive ones. ✓

### Visualization

```text
nums:  1  1  1  0  0  0  1  1  1  1  0
       0  1  2  3  4  5  6  7  8  9 10

                   └────────────────┘
                   4  5  6  7  8  9        zeros inside = 2 ≤ k  ✓
                   0  0  1  1  1  1        length 6  ★
                   ↑                ↑
                  left            right

       flip the two zeros → 1 1 1 1 1 1
```

### Code

```go
func longestOnes(nums []int, k int) int {
    left, zeros, best := 0, 0, 0

    for right := 0; right < len(nums); right++ {
        if nums[right] == 0 {
            zeros++
        }

        // Too many zeros to flip: shrink until we are back within budget.
        for zeros > k {
            if nums[left] == 0 {
                zeros--
            }
            left++
        }

        if size := right - left + 1; size > best {
            best = size // valid here
        }
    }
    return best
}
```

```python
def longestOnes(nums, k):
    left = zeros = best = 0

    for right, x in enumerate(nums):
        if x == 0:
            zeros += 1

        while zeros > k:            # too many zeros: shrink back into budget
            if nums[left] == 0:
                zeros -= 1
            left += 1

        best = max(best, right - left + 1)   # valid here
    return best
```

### Complexity
Time O(n) — each index enters and leaves the window once. Space O(1) — a single counter.

> The same code solves "Max Consecutive Ones II" (at most one flip) with `k = 1`, and "longest subarray of 1s after deleting one element" with `k = 1` and the answer reduced by one.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 3 | Longest Substring | Easy | Core sliding window application |
| 424 | Char Replacement | Easy | Core sliding window application |
| 1004 | Max Consecutive Ones | Medium | Core sliding window application |
| 340 | K Distinct | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Longest Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Longest Window (Sliding Window).
- **Signal:** longest, maximum window, at most k, substring, distinct.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Longest Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Longest Window
FAMILY : Sliding Window (Intermediate)
WHEN   : longest, maximum window, at most k, substring, distinct
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 3, 424, 1004, 340
```

---

*Part of the DSA Patterns Handbook — pattern 15 of 100.*
