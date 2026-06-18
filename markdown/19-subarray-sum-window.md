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

### Intuition
Enumerate all subarrays/substrings and evaluate each — O(n^2) or O(n^3).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Subarray Sum Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Subarray Sum Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation
```
brute  : recompute everything each step      ──▶ slow
Subarray Sum Windo: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Subarray Sum Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

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
A representative **Subarray Sum Window** problem. The signal: window/prefix sums to count or bound subarrays by their sum.

### Thought Process
1. Confirm the pattern via its recognition signals (subarray sum, window sum, positive, prefix, count subarrays).
2. Reach for the Subarray Sum Window template below and map the problem's entities onto it.
3. A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Subarray Sum Window step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(k). Each index is added and removed at most once; k = window/alphabet size.

## 10. Solved Example 2

### Problem — Subarray Sum K (LeetCode 560)
A representative **Subarray Sum Window** problem. The signal: window/prefix sums to count or bound subarrays by their sum.

### Thought Process
1. Confirm the pattern via its recognition signals (subarray sum, window sum, positive, prefix, count subarrays).
2. Reach for the Subarray Sum Window template below and map the problem's entities onto it.
3. A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Subarray Sum Window step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(k). Each index is added and removed at most once; k = window/alphabet size.

## 11. Solved Example 3

### Problem — Subarray Product (LeetCode 713)
A representative **Subarray Sum Window** problem. The signal: window/prefix sums to count or bound subarrays by their sum.

### Thought Process
1. Confirm the pattern via its recognition signals (subarray sum, window sum, positive, prefix, count subarrays).
2. Reach for the Subarray Sum Window template below and map the problem's entities onto it.
3. A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Subarray Sum Window step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(k). Each index is added and removed at most once; k = window/alphabet size.


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
