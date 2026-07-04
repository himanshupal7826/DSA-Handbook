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

### Intuition
Enumerate all subarrays/substrings and evaluate each — O(n^2) or O(n^3).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Longest Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Longest Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Longest Window    : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Longest Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Sliding Window** family template. Adapt the comparison/condition to the specific problem.

```go
// Variable-size window: longest subarray satisfying a constraint.
func longestWindow(s string) int {
    count := map[byte]int{}
    left, best := 0, 0
    for right := 0; right < len(s); right++ {
        count[s[right]]++
        for windowInvalid(count) { // shrink until valid
            count[s[left]]--
            if count[s[left]] == 0 { delete(count, s[left]) }
            left++
        }
        if right-left+1 > best { best = right - left + 1 }
    }
    return best
}
```

```python
def longest_window(s):
    from collections import defaultdict
    count = defaultdict(int)
    left = best = 0
    for right, ch in enumerate(s):
        count[ch] += 1
        while window_invalid(count):      # shrink to restore validity
            count[s[left]] -= 1
            if count[s[left]] == 0:
                del count[s[left]]
            left += 1
        best = max(best, right - left + 1)
    return best
```

```java
int longestWindow(String s) {
    Map<Character,Integer> count = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        count.merge(s.charAt(right), 1, Integer::sum);
        while (windowInvalid(count)) {
            char c = s.charAt(left++);
            if (count.merge(c, -1, Integer::sum) == 0) count.remove(c);
        }
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

```cpp
int longestWindow(const string& s) {
    unordered_map<char,int> count;
    int left = 0, best = 0;
    for (int right = 0; right < (int)s.size(); ++right) {
        ++count[s[right]];
        while (windowInvalid(count)) {
            if (--count[s[left]] == 0) count.erase(s[left]);
            ++left;
        }
        best = max(best, right - left + 1);
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

### Problem — Longest Substring (LeetCode 3)
A representative **Longest Window** problem. The signal: maximize window length; shrink only when the window becomes invalid.

### Thought Process
1. Keep a variable window `[left, right]` that must contain no repeated character.
2. Store the last-seen index of each character. When `s[right]` was seen inside the current window, jump `left` to one past its previous position.
3. After every expansion the window is valid again, so record `right - left + 1` as a candidate answer.

### Dry Run
Input `s = "abcabcbb"`:
- r=0 'a' → window "a", best=1
- r=1 'b' → "ab", best=2
- r=2 'c' → "abc", best=3
- r=3 'a' (last seen at 0, ≥ left) → left=1, window "bca", best=3
- r=4 'b' (last seen 1, ≥ left) → left=2, window "cab", best still 3 → answer **3**

### Visualization
```
"abcabcbb": window "abc" is longest; repeat 'a' pushes left forward → best = 3
```

### Code
```python
def length_of_longest_substring(s):
    last_seen = {}
    left = best = 0
    for right, ch in enumerate(s):
        if ch in last_seen and last_seen[ch] >= left:
            left = last_seen[ch] + 1
        last_seen[ch] = right
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n) — each index visited once; Space O(min(n, alphabet)) for the last-seen map.

## 10. Solved Example 2

### Problem — Char Replacement (LeetCode 424)
A representative **Longest Window** problem. The signal: maximize window length; shrink only when the window becomes invalid.

### Thought Process
1. A window is valid if we can make every char equal by replacing at most `k` of them: `window_len - max_freq <= k`.
2. Track counts of each letter in the window and the running `max_freq` (the most common letter's count).
3. When the window becomes invalid, slide `left` forward by one (dropping one char) — never shrinking more than needed keeps it O(n). Record the best window length.

### Dry Run
Input `s = "AABABBA", k = 1`:
- Expand to "AABA" (r=3): counts A=3,B=1, max_freq=3, len=4, need 4-3=1 ≤ 1 → best=4
- r=4 'B' → "AABAB" len=5, max_freq=3, need 5-3=2 > 1 → invalid, left++ → "ABAB"
- Window stays length 4 thereafter → answer **4**

### Visualization
```
"AABABBA", k=1: best window length 4 ("AABA" → replace one B) → answer 4
```

### Code
```python
def character_replacement(s, k):
    from collections import defaultdict
    count = defaultdict(int)
    left = best = max_freq = 0
    for right, ch in enumerate(s):
        count[ch] += 1
        max_freq = max(max_freq, count[ch])
        if (right - left + 1) - max_freq > k:   # too many to replace
            count[s[left]] -= 1
            left += 1
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n) — single pass, `left` never moves backward; Space O(26) for the count map.

## 11. Solved Example 3

### Problem — Max Consecutive Ones (LeetCode 1004)
A representative **Longest Window** problem. The signal: maximize window length; shrink only when the window becomes invalid.

### Thought Process
1. We may flip up to `k` zeros to ones, so a window is valid while it holds at most `k` zeros.
2. Expand `right` and count zeros inside the window; when the zero count exceeds `k`, advance `left`, decrementing the count as zeros leave.
3. The longest window ever seen is the answer — the largest run of ones achievable with `k` flips.

### Dry Run
Input `nums = [1,1,1,0,0,0,1,1,1,1,0], k = 2`:
- Grow to index 5 → window [1,1,1,0,0,0] has 3 zeros > 2 → shrink left until 2 zeros
- Best stretch is indices 5..10 `[0,1,1,1,1,0]` with 2 zeros flipped → length **6**

### Visualization
```
[1,1,1,0,0,0,1,1,1,1,0], k=2: window "0,1,1,1,1,0" holds ≤2 zeros → answer 6
```

### Code
```python
def longest_ones(nums, k):
    left = best = zeros = 0
    for right, val in enumerate(nums):
        if val == 0:
            zeros += 1
        while zeros > k:                 # too many zeros to flip
            if nums[left] == 0:
                zeros -= 1
            left += 1
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n) — each index enters and leaves the window once; Space O(1).


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
