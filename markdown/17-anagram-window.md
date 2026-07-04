# 17 · Anagram Window

> **One-liner:** Fixed window + char-count match to find anagrams/permutations.

---

## 1. Overview

### Definition
The **Anagram Window** pattern belongs to the *Sliding Window* family. Fixed window + char-count match to find anagrams/permutations.

### Intuition
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Why it works
Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.

---

## 2. Recognition Signals

### Keywords
anagram, permutation, fixed window, char count, find all.

### Constraints
- Input size where the brute-force complexity would time out — the Anagram Window optimization is the intended solution.
- Structural hints in the statement that match this family (Sliding Window).

### Hidden clues
- The problem can be reframed so the Anagram Window invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Anagram Window is the upgrade.
- The wording maps onto: anagram, permutation, fixed window, char count, find all.

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
Redundant recomputation; does not exploit the structure the Anagram Window pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Anagram Window invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-17" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Anagram window: slide k=3 over "cbaebabacd", match counts to "abc"</text>
  <g>
    <rect x="40"  y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="61"  y="73" text-anchor="middle" fill="#1e293b">c</text>
    <rect x="86"  y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="107" y="73" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="132" y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="153" y="73" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="178" y="46" width="42" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="199" y="73" text-anchor="middle" fill="#1e293b">e</text>
    <rect x="224" y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="245" y="73" text-anchor="middle" fill="#1e293b">b</text>
    <rect x="270" y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="291" y="73" text-anchor="middle" fill="#1e293b">a</text>
    <rect x="316" y="46" width="42" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="337" y="73" text-anchor="middle" fill="#1e293b">b</text>
  </g>
  <rect x="84" y="42" width="138" height="50" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <line x1="153" y1="100" x2="245" y2="100" stroke="#475569" marker-end="url(#a-17)"/>
  <text x="200" y="94" text-anchor="middle" fill="#64748b">slide →</text>
  <text x="470" y="52" text-anchor="middle" fill="#64748b" font-weight="700">char-count map</text>
  <g>
    <rect x="400" y="62" width="46" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="423" y="82" text-anchor="middle" fill="#1e293b">a:1</text>
    <rect x="452" y="62" width="46" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="475" y="82" text-anchor="middle" fill="#1e293b">b:1</text>
    <rect x="504" y="62" width="46" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="527" y="82" text-anchor="middle" fill="#1e293b">c:1</text>
  </g>
  <text x="470" y="112" text-anchor="middle" fill="#64748b">need = a:1 b:1 c:1</text>
  <text x="320" y="150" text-anchor="middle" fill="#059669" font-weight="700">window "cba" counts == need ⇒ anagram found at index 0</text>
  <text x="320" y="180" text-anchor="middle" fill="#64748b">on each step: add arr[R] to map, remove arr[R−k], compare to need</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Anagram Window    : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Anagram Window problem. I'll a window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n). That brings the complexity down to O(n) time and O(k) space — here's the template."

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

| Metric | Brute Force | Anagram Window (Optimal) |
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

### Problem — Find Anagrams (LeetCode 438)
Return the start indices of every substring of `s` that is an anagram of `p`.

### Thought Process
1. Any anagram of `p` has length `len(p)` and identical character counts, so use a **fixed window** of size `len(p)`.
2. Build a `Counter` for `p` and a running `Counter` for the current window.
3. Slide the window one char right each step: add the entering char, drop the char that fell off the left. When the two counters match, record the window's start index.

### Dry Run
`s = "cbaebabacd", p = "abc"` (window size 3, need `{a:1,b:1,c:1}`):
- window `cba` (i=0) → counts match → record `0`.
- windows `bae, aeb, eba, bab, aba` → no match.
- window `bac` (i=6) → counts match → record `6`.
- Result `[0, 6]`.

### Visualization
```
"cbaebabacd" ──▶ slide fixed window of len(p)=3, compare counts to p
match at index 0 ("cba") and index 6 ("bac") ──▶ [0, 6]
```

### Code
```python
from collections import Counter

def findAnagrams(s: str, p: str) -> list[int]:
    if len(p) > len(s):
        return []
    need = Counter(p)
    window = Counter(s[:len(p)])
    res = []
    if window == need:
        res.append(0)
    for right in range(len(p), len(s)):
        window[s[right]] += 1               # char enters on the right
        left = right - len(p)
        window[s[left]] -= 1                # char leaves on the left
        if window[s[left]] == 0:
            del window[s[left]]
        if window == need:
            res.append(left + 1)
    return res
```

### Complexity
Time O(n) with a 26-way count compare per step; Space O(1) (at most 26 keys).

## 10. Solved Example 2

### Problem — Permutation in String (LeetCode 567)
Return `True` if `s2` contains any permutation of `s1` as a contiguous substring.

### Thought Process
1. A permutation of `s1` is just an anagram, so we need a **fixed window** of size `len(s1)` whose char counts equal those of `s1`.
2. Track how many of the 26 letters currently have the *exact* required count with a single `matches` integer, so each slide is O(1) instead of comparing whole maps.
3. When `matches == 26`, the window is a permutation → return `True`. Return `False` if we run off the end.

### Dry Run
`s1 = "ab", s2 = "eidbaooo"` (window size 2):
- windows `ei, id, db` → counts differ, no match.
- window `ba` → counts `{b:1,a:1}` equal `s1` → return `True`.

### Visualization
```
"eidbaooo" ──▶ slide window of len(s1)=2, keep 26-letter match count
window "ba" matches counts of "ab" ──▶ True
```

### Code
```python
def checkInclusion(s1: str, s2: str) -> bool:
    if len(s1) > len(s2):
        return False
    need = [0] * 26
    window = [0] * 26
    for ch in s1:
        need[ord(ch) - 97] += 1
    matches = sum(1 for i in range(26) if need[i] == window[i])
    for right in range(len(s2)):
        r = ord(s2[right]) - 97
        window[r] += 1
        if window[r] == need[r]:
            matches += 1
        elif window[r] == need[r] + 1:
            matches -= 1
        if right >= len(s1):
            l = ord(s2[right - len(s1)]) - 97
            window[l] -= 1
            if window[l] == need[l]:
                matches += 1
            elif window[l] == need[l] - 1:
                matches -= 1
        if matches == 26:
            return True
    return False
```

### Complexity
Time O(n) with O(1) work per slide; Space O(1) (two fixed 26-length arrays).

## 11. Solved Example 3

### Problem — Substring Concat (LeetCode 30)
All words in `words` share length `L`. Find every start index in `s` where a substring is a concatenation of **every** word exactly once (in any order).

### Thought Process
1. A valid substring has length `total = L * len(words)` and is a sequence of back-to-back `L`-sized chunks whose multiset of chunks equals `Counter(words)`.
2. Since words are all length `L`, any valid start is congruent mod `L`; run `L` independent sliding windows, one per offset `0..L-1`, stepping by `L` words at a time.
3. In each offset window keep a running `seen` count; when a chunk's count exceeds the need, shrink from the left by whole words. When the window holds exactly `len(words)` words, record its start.

### Dry Run
`s = "barfoothefoobarman", words = ["foo","bar"]` (`L=3, total=6`):
- offset 0: chunks `bar,foo` → both needed, count 2 → record start `0`; then `the` not a word → reset.
- later chunks `foo,bar` at index 9 → count 2 → record start `9`.
- Result `[0, 9]`.

### Visualization
```
"barfoothefoobarman" ──▶ L=3 offset windows, match chunk multiset to words
"barfoo" @0 and "foobar" @9 ──▶ [0, 9]
```

### Code
```python
from collections import Counter

def findSubstring(s: str, words: list[str]) -> list[int]:
    if not words or not s:
        return []
    L, n = len(words[0]), len(words)
    total = L * n
    need = Counter(words)
    res = []
    for offset in range(L):
        left = offset
        seen = Counter()
        count = 0                              # words currently in window
        for right in range(offset, len(s) - L + 1, L):
            word = s[right:right + L]
            if word in need:
                seen[word] += 1
                count += 1
                while seen[word] > need[word]: # too many of this word → shrink
                    lw = s[left:left + L]
                    seen[lw] -= 1
                    count -= 1
                    left += L
                if count == n:
                    res.append(left)
                    lw = s[left:left + L]       # slide past one word to keep searching
                    seen[lw] -= 1
                    count -= 1
                    left += L
            else:
                seen.clear()                   # invalid word breaks the run
                count = 0
                left = right + L
    return res
```

### Complexity
Time O(len(s) · L) — each of the `L` offsets scans the string once; Space O(len(words) · L) for the counters.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 438 | Find Anagrams | Easy | Core sliding window application |
| 567 | Permutation in String | Easy | Core sliding window application |
| 30 | Substring Concat | Medium | Core sliding window application |
| 76 | Min Window | Medium | Core sliding window application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Anagram Window logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Anagram Window (Sliding Window).
- **Signal:** anagram, permutation, fixed window, char count, find all.
- **Move:** A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Anagram Window invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Anagram Window
FAMILY : Sliding Window (Intermediate)
WHEN   : anagram, permutation, fixed window, char count, find all
DO     : A window with incrementally maintained aggregates means each element enters and 
TIME   : O(n)    SPACE: O(k)
PRACTICE: 438, 567, 30, 76
```

---

*Part of the DSA Patterns Handbook — pattern 17 of 100.*
