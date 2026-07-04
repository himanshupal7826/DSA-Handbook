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

### Intuition
Enumerate all subarrays/substrings and evaluate each — O(n^2) or O(n^3).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Fixed Size Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Fixed Size Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Fixed Size Window : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Fixed Size Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

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

### Problem — Max Average (LeetCode 643)
Given `nums` and an integer `k`, find the contiguous subarray of length exactly `k` with the largest average, and return that maximum average.

### Thought Process
1. The subarray length is fixed at `k`, so maximizing the average is the same as maximizing the window sum — divide by `k` at the end.
2. Seed the sum of the first `k` elements as the initial `window_sum` and best.
3. Slide one step at a time: add `nums[right]`, subtract `nums[right - k]`, and track the max sum in O(1) per step.

### Dry Run
`nums = [1, 12, -5, -6, 50, 3], k = 4`
- Seed sum of first 4 = `1+12-5-6 = 2` → best = 2
- Slide to index 4: `2 + 50 - 1 = 51` → best = 51
- Slide to index 5: `51 + 3 - 12 = 42` → best stays 51
- Answer = `51 / 4 = 12.75`

### Visualization
```
window sum slides by +nums[right] -nums[right-k]; answer = best_sum / k
```

### Code
```python
def findMaxAverage(nums, k):
    window_sum = sum(nums[:k])
    best = window_sum
    for right in range(k, len(nums)):
        window_sum += nums[right] - nums[right - k]
        best = max(best, window_sum)
    return best / k
```

### Complexity
Time O(n), Space O(1). One pass with a rolling sum; no extra storage beyond scalars.

## 10. Solved Example 2

### Problem — Sliding Window Max (LeetCode 239)
Given `nums` and window size `k`, return a list containing the maximum of each contiguous window of size `k` as it slides left to right.

### Thought Process
1. Keep a deque of *indices* whose values are in decreasing order — the front always holds the index of the current window's maximum.
2. Before pushing `i`, pop from the back every index whose value is `<= nums[i]`; those can never be the max again.
3. Pop the front when it falls outside the window (`front <= i - k`); once `i >= k-1`, record `nums[deque[0]]`.

### Dry Run
`nums = [1, 3, -1, -3, 5], k = 3`
- i=0 push0 dq=[0]; i=1 3>1 pop0 push1 dq=[1]; i=2 dq=[1,2] → max nums[1]=3
- i=3 dq=[1,2,3] front 1<=3-3=0? no → max nums[1]=3
- i=4 5 pops all, dq=[4] → max 5 → result `[3, 3, 5]`

### Visualization
```
deque holds indices with decreasing values; front = window max
```

### Code
```python
from collections import deque

def maxSlidingWindow(nums, k):
    dq = deque()          # indices, values decreasing
    result = []
    for i, x in enumerate(nums):
        while dq and nums[dq[-1]] <= x:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:      # front slid out of window
            dq.popleft()
        if i >= k - 1:
            result.append(nums[dq[0]])
    return result
```

### Complexity
Time O(n), Space O(k). Each index is pushed and popped at most once; deque holds at most k indices.

## 11. Solved Example 3

### Problem — Permutation in String (LeetCode 567)
Return `True` if `s2` contains any permutation of `s1` as a contiguous substring — i.e. some window of length `len(s1)` in `s2` has the exact same character counts as `s1`.

### Thought Process
1. A permutation match means equal character frequencies, so use a fixed window of width `len(s1)` over `s2`.
2. Build the target count for `s1` and a rolling count for the current window; compare them.
3. Slide the window one char at a time: add the incoming char, drop the outgoing char, and return `True` the moment the counts match.

### Dry Run
`s1 = "ab", s2 = "eidbaooo"` → need = {a:1, b:1}, window size 2
- "ei" {e,i} ≠ need; "id" ≠; "db" ≠; "ba" {b:1,a:1} == need → return True

### Visualization
```
fixed window len(s1) over s2; compare rolling counts to target counts
```

### Code
```python
from collections import Counter

def checkInclusion(s1, s2):
    k = len(s1)
    if k > len(s2):
        return False
    need = Counter(s1)
    window = Counter(s2[:k])
    if window == need:
        return True
    for i in range(k, len(s2)):
        window[s2[i]] += 1
        left = s2[i - k]
        window[left] -= 1
        if window[left] == 0:
            del window[left]
        if window == need:
            return True
    return False
```

### Complexity
Time O(n), Space O(1). One pass over `s2`; the counts hold at most 26 distinct letters.


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
