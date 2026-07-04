# 18 · Distinct Character Window

> **One-liner:** Track distinct-count in window to bound by ≤K or all-unique.

---

## 1. Overview

### Definition
The **Distinct Character Window** pattern belongs to the *Sliding Window* family. Track distinct-count in window to bound by ≤K or all-unique.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
distinct, unique, k distinct, without repeating, char set.

### Constraints
- Input size where the brute-force complexity would time out — the Distinct Character Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Distinct Character Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Distinct Character Window is the upgrade.
- The wording maps onto: distinct, unique, k distinct, without repeating, char set.

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
Redundant recomputation; does not exploit the structure the Distinct Character Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Distinct Character Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-18" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Distinct ≤ K=2: shrink L while map has too many keys</text>
  <g>
    <rect x="40"  y="46" width="42" height="42" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="61"  y="73" text-anchor="middle" fill="#1e293b">e</text>
    <rect x="86"  y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="107" y="73" text-anchor="middle" fill="#1e293b">c</text>
    <rect x="132" y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="153" y="73" text-anchor="middle" fill="#1e293b">e</text>
    <rect x="178" y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="199" y="73" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="224" y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="245" y="73" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="270" y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="291" y="73" text-anchor="middle" fill="#1e293b">e</text>
  </g>
  <rect x="84" y="42" width="138" height="50" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <line x1="107" y1="102" x2="70" y2="102" stroke="#d97706" marker-end="url(#a-18)"/>
  <text x="145" y="106" text-anchor="middle" fill="#d97706">shrink L</text>
  <text x="470" y="52" text-anchor="middle" fill="#64748b" font-weight="700">count map (window "ceb")</text>
  <g>
    <rect x="410" y="62" width="46" height="30" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="433" y="82" text-anchor="middle" fill="#1e293b">c:1</text>
    <rect x="462" y="62" width="46" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="485" y="82" text-anchor="middle" fill="#1e293b">e:1</text>
    <rect x="514" y="62" width="46" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="537" y="82" text-anchor="middle" fill="#1e293b">b:1</text>
  </g>
  <text x="485" y="112" text-anchor="middle" fill="#d97706">3 distinct &gt; K ⇒ evict</text>
  <text x="320" y="150" text-anchor="middle" fill="#059669" font-weight="700">after dropping 'c': window "eb" has 2 distinct — valid</text>
  <text x="320" y="180" text-anchor="middle" fill="#64748b">while map.size &gt; K: count[arr[L]]−−, drop key if 0, L++</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Distinct Character: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Distinct Character Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

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

| Metric | Brute Force | Distinct Character Window (Optimal) |
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
Find the length of the longest substring of `s` with **no repeating characters**.

### Thought Process
1. Keep a map `last` from a character to the most recent index where it appeared.
2. Expand `right` over the string; when the current char was seen inside the window, jump `left` to `last[ch] + 1` so the window stays all-unique.
3. After each step the window `[left, right]` has all distinct chars — record its length.

### Dry Run
`s = "abcabcbb"`
- r=0 'a' → window "a", best 1; r=1 'b' → "ab", best 2; r=2 'c' → "abc", best 3.
- r=3 'a': last['a']=0 ≥ left → left=1, window "bca", best 3.
- r=4 'b': last['b']=1 ≥ left → left=2, window "cab", best 3.
- Continues at length 3 → answer **3**.

### Visualization
```
"abcabcbb": window slides right; on a repeat, left jumps past the prior copy.
```

### Code
```python
def length_of_longest_substring(s):
    last = {}
    left = best = 0
    for right, ch in enumerate(s):
        if ch in last and last[ch] >= left:
            left = last[ch] + 1
        last[ch] = right
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n), Space O(min(n, alphabet)). Each index is visited once; the map holds at most one entry per distinct char.

## 10. Solved Example 2

### Problem — K Distinct (LeetCode 340)
Find the length of the longest substring of `s` that contains **at most `k` distinct** characters.

### Thought Process
1. Maintain a frequency `count` of chars in the current window plus a `left` pointer.
2. Expand `right`, incrementing `count[ch]`; the window is invalid while it holds more than `k` distinct keys.
3. Shrink from `left`, decrementing counts and deleting keys that hit zero, until `len(count) <= k`; record the window length each step.

### Dry Run
`s = "eceba", k = 2`
- r=0 'e' {e:1}; r=1 'c' {e:1,c:1}; r=2 'e' {e:2,c:1} → best 3 ("ece").
- r=3 'b' {e:2,c:1,b:1} → 3 distinct > 2, shrink: drop 'e'→{e:1,c:1,b:1} still 3, drop 'c'→{e:1,b:1}, left=3.
- r=4 'a' {e:1,b:1,a:1} > 2, shrink drop 'e','b' → {a:1}, left=... best stays **3**.

### Visualization
```
"eceba", k=2: shrink left whenever the count map has more than k keys.
```

### Code
```python
def length_of_longest_substring_k_distinct(s, k):
    if k == 0:
        return 0
    count = {}
    left = best = 0
    for right, ch in enumerate(s):
        count[ch] = count.get(ch, 0) + 1
        while len(count) > k:
            lc = s[left]
            count[lc] -= 1
            if count[lc] == 0:
                del count[lc]
            left += 1
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n), Space O(k). Each index enters and leaves the window once; the map holds at most k+1 keys.

## 11. Solved Example 3

### Problem — Two Distinct (LeetCode 159)
Find the length of the longest substring of `s` with **at most two distinct** characters.

### Thought Process
1. This is the k-distinct problem fixed at `k = 2`, so track only a tiny map `last` of char → its most recent index (at most 3 keys live).
2. Expand `right`; when a third distinct char appears, find the other char whose last-seen index is smallest — that char must fully leave the window.
3. Set `left` to that evicted char's index + 1 and delete it, keeping exactly two distinct chars; record the length.

### Dry Run
`s = "ccaabbb"`
- "cc" last{c}; "cca" last{c:1,a:2}; "ccaa" best 4.
- r=4 'b': third char → evict 'c' (smallest last idx 1), left=2, window "aab", last{a,b}.
- r=5,6 'b': window "aabbb" best **5**.

### Visualization
```
"ccaabbb": on a 3rd char, drop the char whose last index is furthest left.
```

### Code
```python
def length_of_longest_substring_two_distinct(s):
    last = {}          # char -> most recent index, at most 2 kept
    left = best = 0
    for right, ch in enumerate(s):
        last[ch] = right
        if len(last) > 2:
            evict = min(last, key=last.get)   # char last seen furthest back
            left = last[evict] + 1
            del last[evict]
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n), Space O(1). The `last` map never exceeds three entries, so each step is constant work.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 3 | Longest Substring | Easy | Core sliding window application |
| 340 | K Distinct | Easy | Core sliding window application |
| 159 | Two Distinct | Medium | Core sliding window application |
| 992 | K Distinct Subarrays | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Distinct Character Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Distinct Character Window (Sliding Window).
- **Signal:** distinct, unique, k distinct, without repeating, char set.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Distinct Character Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Distinct Character Window
FAMILY : Sliding Window (Intermediate)
WHEN   : distinct, unique, k distinct, without repeating, char set
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 3, 340, 159, 992
```

---

*Part of the DSA Patterns Handbook — pattern 18 of 100.*
