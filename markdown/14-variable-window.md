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

### Intuition
Enumerate all subarrays/substrings and evaluate each — O(n^2) or O(n^3).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Variable Size Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Variable Size Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Variable Size Wind: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Variable Size Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

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

### Problem — Longest Substring (LeetCode 3)
Given a string `s`, find the length of the longest substring without repeating characters.

### Thought Process
1. Keep a window `[left, right]` and a map from each character to its most recent index.
2. Expand `right` one char at a time. If the current char was seen inside the window, jump `left` to just past its previous position so the window stays duplicate-free.
3. After placing each char, update the answer with `right - left + 1`.

### Dry Run
`s = "abcabcbb"`:
- r=0..2 "abc": no repeats, window grows, best = 3.
- r=3 'a': last seen at 0, so left = 1; window "bca", best stays 3.
- r=4 'b': last seen at 1, left = 2; window "cab", best 3.
- Continues at length 3; answer = **3**.

### Visualization
```
a b c a b c b b   ─▶ on repeat 'a', left jumps past its old index
    [c a b]        ─▶ longest duplicate-free window has length 3
```

### Code
```python
def lengthOfLongestSubstring(s):
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

### Problem — Min Window (LeetCode 76)
Given strings `s` and `t`, return the smallest substring of `s` that contains every character of `t` including multiplicity, or `""` if none exists.

### Thought Process
1. Count how many of each char `t` needs; track `missing` = total chars still required.
2. Expand `right`; whenever the added char is still needed (its window count hasn't overshot `t`'s need), decrement `missing`.
3. When `missing == 0` the window is valid — contract `left` while it stays valid, recording the shortest span each time.

### Dry Run
`s = "ADOBECODEBANC"`, `t = "ABC"`:
- Expand until "ADOBEC" — all of A,B,C present, missing = 0. Length 6.
- Shrink left past "A"; keep expanding to find "CODEBA"... eventually "BANC" (start index 9) is valid, length 4.
- Best = **"BANC"**.

### Visualization
```
A D O B E C O D E B A N C
                  [B A N C]  ─▶ shortest window covering A,B,C
```

### Code
```python
def minWindow(s, t):
    from collections import Counter
    need = Counter(t)
    missing = len(t)
    left = start = 0
    end = float('inf')
    for right, ch in enumerate(s):
        if need[ch] > 0:
            missing -= 1
        need[ch] -= 1
        while missing == 0:              # window valid: try to shrink
            if right - left < end - start:
                start, end = left, right
            need[s[left]] += 1
            if need[s[left]] > 0:
                missing += 1
            left += 1
    return "" if end == float('inf') else s[start:end + 1]
```

### Complexity
Time O(|s| + |t|) — each pointer advances once; Space O(|t|) for the need counter.

## 11. Solved Example 3

### Problem — Min Size Subarray (LeetCode 209)
Given a positive-integer array `nums` and a `target`, return the minimal length of a contiguous subarray whose sum is `>= target`, or `0` if none exists.

### Thought Process
1. Because all numbers are positive, growing the window only increases the sum and shrinking only decreases it — a clean shrink-while-valid window works.
2. Add each `nums[right]` to a running `total`.
3. While `total >= target`, record `right - left + 1` and shrink from the left, subtracting `nums[left]` — this finds the shortest valid window ending at each `right`.

### Dry Run
`target = 7`, `nums = [2,3,1,2,4,3]`:
- Grow to [2,3,1,2] total 8 >= 7 → best 4; shrink drops 2 → total 6.
- Add 4 → [3,1,2,4] total 10 → best 4; shrink to [1,2,4]=7 best 3, [2,4]=6 stop.
- Add 3 → [2,4,3]=9 best 3; shrink to [4,3]=7 best 2. Answer = **2**.

### Visualization
```
2 3 1 2 4 3   target = 7
        [4 3]  ─▶ shortest subarray with sum >= 7 has length 2
```

### Code
```python
def minSubArrayLen(target, nums):
    left = 0
    total = 0
    best = float('inf')
    for right, x in enumerate(nums):
        total += x
        while total >= target:           # shrink while still valid
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1
    return 0 if best == float('inf') else best
```

### Complexity
Time O(n) — left and right each advance at most n times; Space O(1).


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
