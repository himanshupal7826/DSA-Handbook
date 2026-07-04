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
Given positive `nums` and a `target`, return the minimal length of a contiguous subarray whose sum is `>= target`, or `0` if none exists.

### Thought Process
1. All numbers are positive, so growing the window only increases the sum and shrinking only decreases it — a sliding window works.
2. Expand `right`, adding `nums[right]` to a running `total`.
3. While `total >= target`, record the window length and shrink from `left` (subtracting `nums[left]`) to search for a shorter valid window.
4. Track the minimum length seen; return `0` if it was never updated.

### Dry Run
`nums = [2,3,1,2,4,3]`, `target = 7`.
- Expand to `[2,3,1,2]` → total 8 ≥ 7, len 4; shrink `[3,1,2]` = 6 < 7.
- Add 4 → `[3,1,2,4]` = 10 ≥ 7, len 4; shrink `[1,2,4]` = 7 ≥ 7, len 3; shrink `[2,4]` = 6 < 7.
- Add 3 → `[2,4,3]` = 9 ≥ 7, len 3; shrink `[4,3]` = 7 ≥ 7, len 2; shrink `[3]` = 3 < 7.
- Minimum length = **2**.

### Visualization
```
[2,3,1,2,4,3], target=7  ──▶ grow right; while total>=target shrink left, record len
best window ──▶ [4,3] of length 2
```

### Code
```python
def min_sub_array_len(target, nums):
    left = 0
    total = 0
    best = float('inf')
    for right, val in enumerate(nums):
        total += val
        while total >= target:
            best = min(best, right - left + 1)
            total -= nums[left]
            left += 1
    return 0 if best == float('inf') else best
```

### Complexity
Time O(n), Space O(1). Each index enters and leaves the window at most once.

## 10. Solved Example 2

### Problem — Subarray Sum K (LeetCode 560)
Given `nums` (values may be **negative**) and an integer `k`, count the number of contiguous subarrays that sum to exactly `k`.

### Thought Process
1. Because values can be negative, growing/shrinking a window is no longer monotonic — a plain sliding window fails, so use the prefix-sum variant of this chapter.
2. A subarray `(i, j]` sums to `k` exactly when `prefix[j] - prefix[i] == k`, i.e. `prefix[i] == prefix[j] - k`.
3. Sweep left to right keeping a hashmap of how many times each prefix sum has occurred; for each new prefix, add the count of `prefix - k` seen so far.
4. Seed the map with `{0: 1}` so subarrays starting at index 0 are counted.

### Dry Run
`nums = [1,-1,1,1,1]`, `k = 2`.
- Start `seen = {0:1}`, `prefix = 0`, `count = 0`.
- +1 → prefix 1, need −1: none; seen `{0:1,1:1}`.
- −1 → prefix 0, need −2: none; count adds seen[0]? need `0-2=-2` → 0; seen `{0:2,1:1}`.
- +1 → prefix 1, need −1: 0; seen[1]→2.
- +1 → prefix 2, need 0: seen[0]=2 → count 2; seen `{...,2:1}`.
- +1 → prefix 3, need 1: seen[1]=2 → count **4**.

### Visualization
```
[1,-1,1,1,1], k=2  ──▶ prefix sums with hashmap of counts (negatives break windows)
answer ──▶ matches where prefix-k was seen before = 4
```

### Code
```python
from collections import defaultdict

def subarray_sum(nums, k):
    seen = defaultdict(int)
    seen[0] = 1
    prefix = 0
    count = 0
    for val in nums:
        prefix += val
        count += seen[prefix - k]
        seen[prefix] += 1
    return count
```

### Complexity
Time O(n), Space O(n) for the prefix-sum hashmap.

## 11. Solved Example 3

### Problem — Subarray Product (LeetCode 713)
Given positive `nums` and integer `k`, count the contiguous subarrays whose product is strictly less than `k`.

### Thought Process
1. All numbers are positive, so extending the window multiplies the product up and shrinking divides it down — a sliding window applies.
2. Expand `right`, multiplying `prod` by `nums[right]`.
3. While `prod >= k` (and `left <= right`), divide out `nums[left]` and advance `left` to restore `prod < k`.
4. Every subarray ending at `right` and starting anywhere in `[left, right]` is valid, so add `right - left + 1` to the count.

### Dry Run
`nums = [10,5,2,6]`, `k = 100`.
- right=0: prod 10 < 100 → +1 (`[10]`), count 1.
- right=1: prod 50 < 100 → +2 (`[5],[10,5]`), count 3.
- right=2: prod 100 ≥ 100 → shrink out 10 → prod 10; window `[5,2]`, +2, count 5.
- right=3: prod 60 < 100 → +3 (`[6],[2,6],[5,2,6]`), count **8**.

### Visualization
```
[10,5,2,6], k=100  ──▶ grow right; while prod>=k divide out left; add (right-left+1)
answer ──▶ 8 subarrays with product < 100
```

### Code
```python
def num_subarray_product_less_than_k(nums, k):
    if k <= 1:
        return 0
    left = 0
    prod = 1
    count = 0
    for right, val in enumerate(nums):
        prod *= val
        while prod >= k:
            prod //= nums[left]
            left += 1
        count += right - left + 1
    return count
```

### Complexity
Time O(n), Space O(1). Each index enters and leaves the window at most once.


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
