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

**The question this pattern keeps answering:** *"Where in `s` does a rearrangement of `p` appear?"*

### Intuition
An anagram of `p` must have exactly `len(p)` characters with exactly `p`'s letter counts. So check every substring of that length.

### Algorithm
1. Let `m = len(p)`.
2. For each start `i` from `0` to `n − m`:
3. &nbsp;&nbsp;Take the substring `s[i..i+m−1]`.
4. &nbsp;&nbsp;Sort it (or count its letters) and compare against `p`.
5. &nbsp;&nbsp;If they match, record `i`.

### Complexity
- Time: **O(n · m log m)** with sorting, **O(n · m)** with counting.
- Space: O(m).

### Drawbacks
- Consecutive substrings differ by exactly **two** characters, yet we recount all `m` of them each time.
- Sorting is even more wasteful: it computes an ordering we immediately discard, when all we needed was a tally.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **An anagram is a statement about counts, and the window has a fixed size — so slide the window and keep the counts up to date incrementally.**

Two patterns compose here:

```text
Fixed Window      →  one character in, one character out per step
Frequency Counter →  compare tallies, never orderings
```

### The thought process

```text
We need    : all positions where a permutation of p occurs in s.
Obvious way: check every length-m substring from scratch.
Too slow   : O(n·m) — and neighbouring substrings share m-1 characters.
Notice     : "is an anagram" only depends on letter COUNTS, not order.
Notice too : sliding by one changes exactly two counts.
Therefore  : maintain a live count table and slide it.
Now        : O(1) work per position → O(n) total.
```

### Making the comparison O(1) too

Sliding gets the counts updated in O(1), but naively comparing two 26-slot tables is O(26) per position. That's fine in practice, yet there's a clean way to make it truly O(1):

> Track an integer **`matches`** = *how many of the 26 letters currently have `windowCount[letter] == pCount[letter]`*.
> The window is an anagram exactly when `matches == 26`.

Since a slide touches only two letters, you only re-evaluate those two:

```text
before changing a letter's count : if it was matching, matches--
change the count
after changing it                : if it now matches, matches++
```

That "un-match, change, re-match" sandwich is the part worth memorising. Doing it in any other order double-counts.

### Steps

```text
Step 1 → Build pCount from p. Build windowCount from the first m characters.
Step 2 → Compute matches = number of letters where the two tables agree.
Step 3 → If matches == 26, record index 0.
Step 4 → For right = m .. n-1:
Step 5 →     add s[right]          (un-match, ++, re-match)
Step 6 →     remove s[right-m]     (un-match, --, re-match)
Step 7 →     if matches == 26, record right - m + 1
```

### Why all 26 letters, not just the ones in `p`

A letter absent from `p` has `pCount = 0`, so it matches only while the window has none of it. Counting all 26 automatically enforces "the window contains nothing extra" — no separate check needed.

### When the alphabet isn't small

For Unicode or arbitrary tokens, swap the array for a hash map and track `matches` against `len(pCount)` distinct keys instead. The logic is unchanged; only the container differs.

### How should I recognize this?

```text
If you see...
  "anagram", "permutation of", "rearrangement", "same letters"
  "find all starting indices", "contains a permutation"
  a fixed-length target pattern
        ↓
Think about...
  "This is a fixed window whose validity is a COUNT comparison."
        ↓
Use...
  fixed window of size len(p)
  + a count table maintained incrementally
  + a `matches` counter so the check is O(1)
```

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

```text
s = "cbaebabacd", p = "abc"   → window size 3

c b a e b a b a c d
└───┘                  "cba"  counts a1 b1 c1 = p  ✓  → index 0
  └───┘                "bae"  has an 'e'          ✗
    └───┘              "aeb"                      ✗
      └───┘            "eba"                      ✗
        └───┘          "bab"  two b's, no c       ✗
          └───┘        "aba"                      ✗
            └───┘      "bac"  counts a1 b1 c1 = p ✓  → index 6
              └───┘    "acd"                      ✗

answer: [0, 6]
```

### Interview explanation
"Being an anagram depends only on letter counts, so I never sort. The window has a fixed size `len(p)`, so sliding it changes exactly two counts — one character enters, one leaves. I keep a live 26-slot count table plus an integer `matches` recording how many letters currently agree with `p`'s table. Since a slide touches two letters, I only re-check those two, so each position costs O(1) and the whole scan is O(n) with O(1) space. Tracking all 26 letters rather than just `p`'s also enforces that the window contains nothing extra."

---

## 5. Generic Templates

> Fixed window + count table + `matches` counter. The un-match / change / re-match sandwich keeps `matches` honest.

```go
// FindAnagrams returns every start index in s where a permutation of p occurs.
func FindAnagrams(s, p string) []int {
    result := []int{}
    if len(s) < len(p) || len(p) == 0 {
        return result
    }

    var pCount, windowCount [26]int
    for i := 0; i < len(p); i++ {
        pCount[p[i]-'a']++
        windowCount[s[i]-'a']++ // prime the first window at the same time
    }

    matches := 0 // how many of the 26 letters currently agree
    for i := 0; i < 26; i++ {
        if pCount[i] == windowCount[i] {
            matches++
        }
    }
    if matches == 26 {
        result = append(result, 0)
    }

    for right := len(p); right < len(s); right++ {
        adjust(&windowCount, &pCount, &matches, int(s[right]-'a'), +1)        // entering
        adjust(&windowCount, &pCount, &matches, int(s[right-len(p)]-'a'), -1) // leaving

        if matches == 26 {
            result = append(result, right-len(p)+1)
        }
    }
    return result
}

// adjust applies delta to one letter's count, keeping `matches` correct.
func adjust(windowCount, pCount *[26]int, matches *int, letter int, delta int) {
    if windowCount[letter] == pCount[letter] {
        *matches-- // it was matching; it may not be after the change
    }
    windowCount[letter] += delta
    if windowCount[letter] == pCount[letter] {
        *matches++ // it matches now
    }
}
```

```python
def find_anagrams(s, p):
    """Every start index in s where a permutation of p occurs."""
    result = []
    if len(s) < len(p) or not p:
        return result

    p_count = [0] * 26
    window = [0] * 26
    for i in range(len(p)):
        p_count[ord(p[i]) - 97] += 1
        window[ord(s[i]) - 97] += 1        # prime the first window

    matches = sum(1 for i in range(26) if p_count[i] == window[i])

    def adjust(letter, delta):
        nonlocal matches
        if window[letter] == p_count[letter]:
            matches -= 1                   # was matching
        window[letter] += delta
        if window[letter] == p_count[letter]:
            matches += 1                   # matches now

    if matches == 26:
        result.append(0)

    for right in range(len(p), len(s)):
        adjust(ord(s[right]) - 97, 1)              # entering
        adjust(ord(s[right - len(p)]) - 97, -1)    # leaving
        if matches == 26:
            result.append(right - len(p) + 1)

    return result
```

```java
import java.util.*;

public class AnagramWindow {
    public static List<Integer> findAnagrams(String s, String p) {
        List<Integer> result = new ArrayList<>();
        if (s.length() < p.length() || p.isEmpty()) return result;

        int[] pCount = new int[26], window = new int[26];
        for (int i = 0; i < p.length(); i++) {
            pCount[p.charAt(i) - 'a']++;
            window[s.charAt(i) - 'a']++;          // prime the first window
        }

        int matches = 0;
        for (int i = 0; i < 26; i++) if (pCount[i] == window[i]) matches++;
        if (matches == 26) result.add(0);

        for (int right = p.length(); right < s.length(); right++) {
            matches = adjust(window, pCount, matches, s.charAt(right) - 'a', 1);
            matches = adjust(window, pCount, matches, s.charAt(right - p.length()) - 'a', -1);
            if (matches == 26) result.add(right - p.length() + 1);
        }
        return result;
    }

    private static int adjust(int[] window, int[] pCount, int matches, int letter, int delta) {
        if (window[letter] == pCount[letter]) matches--;   // was matching
        window[letter] += delta;
        if (window[letter] == pCount[letter]) matches++;   // matches now
        return matches;
    }
}
```

```cpp
#include <string>
#include <vector>
using namespace std;

static void adjust(int* window, const int* pCount, int& matches, int letter, int delta) {
    if (window[letter] == pCount[letter]) --matches;   // was matching
    window[letter] += delta;
    if (window[letter] == pCount[letter]) ++matches;   // matches now
}

vector<int> findAnagrams(const string& s, const string& p) {
    vector<int> result;
    if (s.size() < p.size() || p.empty()) return result;

    int pCount[26] = {0}, window[26] = {0};
    for (size_t i = 0; i < p.size(); ++i) {
        ++pCount[p[i] - 'a'];
        ++window[s[i] - 'a'];                          // prime the first window
    }

    int matches = 0;
    for (int i = 0; i < 26; ++i) if (pCount[i] == window[i]) ++matches;
    if (matches == 26) result.push_back(0);

    for (size_t right = p.size(); right < s.size(); ++right) {
        adjust(window, pCount, matches, s[right] - 'a', 1);
        adjust(window, pCount, matches, s[right - p.size()] - 'a', -1);
        if (matches == 26) result.push_back((int)(right - p.size() + 1));
    }
    return result;
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

### Problem — Find All Anagrams in a String (LeetCode 438)
Return every start index in `s` where an anagram of `p` begins.

### Thought Process
1. An anagram of `p` has length `len(p)` and identical letter counts — so this is a **fixed window** of size `len(p)`.
2. Maintain `windowCount` incrementally: one letter enters, one leaves per slide.
3. Keep an integer `matches` = how many of the 26 letters currently agree with `pCount`. The window is an anagram exactly when `matches == 26`.
4. A slide touches only two letters, so only those two need re-checking — un-match, change, re-match.
5. Counting all 26 letters (not just `p`'s) automatically rejects windows containing extra letters.

### Dry Run

Input: `s = "cbaebabacd"`, `p = "abc"` → window size 3, `pCount = {a:1, b:1, c:1}`

| window (start) | contents | windowCount | equals pCount? | record |
|----------------|----------|-------------|----------------|--------|
| 0 | `"cba"` | a:1 b:1 c:1 | **yes** | **0** |
| 1 | `"bae"` | a:1 b:1 e:1 | no (`e` extra, `c` missing) | |
| 2 | `"aeb"` | a:1 b:1 e:1 | no | |
| 3 | `"eba"` | a:1 b:1 e:1 | no | |
| 4 | `"bab"` | a:1 b:2 | no (`b` is 2, `c` is 0) | |
| 5 | `"aba"` | a:2 b:1 | no | |
| 6 | `"bac"` | a:1 b:1 c:1 | **yes** | **6** |
| 7 | `"acd"` | a:1 c:1 d:1 | no | |

Output: **`[0, 6]`**

Watch one slide in detail — from window 0 (`"cba"`) to window 1 (`"bae"`): `e` enters and `c` leaves. `e` was matching at 0 = 0, so `matches--`; it becomes 1 ≠ 0, so no re-increment. `c` was matching at 1 = 1, so `matches--`; it drops to 0 ≠ 1, so no re-increment. `matches` falls from 26 to 24. Only two letters were ever examined.

### Visualization

```text
s = c  b  a  e  b  a  b  a  c  d
    0  1  2  3  4  5  6  7  8  9

    └─────┘                            "cba" = anagram of "abc"  ★ index 0
                          └─────┘      "bac" = anagram of "abc"  ★ index 6

each slide: one letter in, one letter out, two counters touched
```

### Code

```go
func findAnagrams(s string, p string) []int {
    result := []int{}
    if len(s) < len(p) || len(p) == 0 {
        return result
    }

    var pCount, windowCount [26]int
    for i := 0; i < len(p); i++ {
        pCount[p[i]-'a']++
        windowCount[s[i]-'a']++ // build the first window
    }

    matches := 0 // letters where windowCount and pCount agree
    for i := 0; i < 26; i++ {
        if pCount[i] == windowCount[i] {
            matches++
        }
    }
    if matches == 26 {
        result = append(result, 0)
    }

    // adjust changes one letter's count while keeping `matches` correct.
    adjust := func(letter, delta int) {
        if windowCount[letter] == pCount[letter] {
            matches-- // it was matching
        }
        windowCount[letter] += delta
        if windowCount[letter] == pCount[letter] {
            matches++ // it matches now
        }
    }

    for right := len(p); right < len(s); right++ {
        adjust(int(s[right]-'a'), +1)          // entering on the right
        adjust(int(s[right-len(p)]-'a'), -1)   // leaving on the left
        if matches == 26 {
            result = append(result, right-len(p)+1)
        }
    }
    return result
}
```

```python
def findAnagrams(s, p):
    result = []
    if len(s) < len(p) or not p:
        return result

    p_count, window = [0] * 26, [0] * 26
    for i in range(len(p)):
        p_count[ord(p[i]) - 97] += 1
        window[ord(s[i]) - 97] += 1            # build the first window

    matches = sum(1 for i in range(26) if p_count[i] == window[i])

    def adjust(letter, delta):
        nonlocal matches
        if window[letter] == p_count[letter]:
            matches -= 1                       # was matching
        window[letter] += delta
        if window[letter] == p_count[letter]:
            matches += 1                       # matches now

    if matches == 26:
        result.append(0)

    for right in range(len(p), len(s)):
        adjust(ord(s[right]) - 97, 1)                # entering
        adjust(ord(s[right - len(p)]) - 97, -1)      # leaving
        if matches == 26:
            result.append(right - len(p) + 1)

    return result
```

### Complexity
Time **O(n)** — O(26) to set up, then O(1) per slide. Space O(1).

---

## 10. Solved Example 2

### Problem — Permutation in String (LeetCode 567)
Return `true` if `s2` contains any permutation of `s1`.

### Thought Process
1. This is the previous problem asking a yes/no question instead of collecting indices — so we return as soon as one window matches.
2. Since we bail out early, the O(26)-per-window comparison is perfectly acceptable and much easier to read than the `matches` bookkeeping.
3. Build both 26-slot tables for the first window, compare, then slide and compare again.
4. In Go, comparing two `[26]int` arrays with `==` is a single expression — arrays are comparable values.

### Dry Run

Input: `s1 = "ab"`, `s2 = "eidbaooo"` → window size 2, `count1 = {a:1, b:1}`

| window (start) | contents | window table | equal to count1? |
|----------------|----------|--------------|------------------|
| 0 | `"ei"` | e:1 i:1 | no |
| 1 | `"id"` | i:1 d:1 | no |
| 2 | `"db"` | d:1 b:1 | no |
| 3 | `"ba"` | b:1 a:1 | **yes → return `true`** |

Output: **`true`** — `"ba"` is a permutation of `"ab"`. ✓

A negative case: `s2 = "eidboaoo"` gives windows `"ei"`, `"id"`, `"db"`, `"bo"`, `"oa"`, `"ao"`, `"oo"` — none matches, so **`false`**.

### Visualization

```text
s1 = "ab"   →  a:1  b:1

s2 = e  i  d  b  a  o  o  o
              └───┘
              "ba" → b:1 a:1 → identical table → true
```

### Code

```go
func checkInclusion(s1 string, s2 string) bool {
    if len(s1) > len(s2) {
        return false
    }

    var need, window [26]int
    for i := 0; i < len(s1); i++ {
        need[s1[i]-'a']++
        window[s2[i]-'a']++ // build the first window
    }
    if window == need { // Go compares arrays element-wise
        return true
    }

    for right := len(s1); right < len(s2); right++ {
        window[s2[right]-'a']++          // entering on the right
        window[s2[right-len(s1)]-'a']--  // leaving on the left
        if window == need {
            return true
        }
    }
    return false
}
```

```python
def checkInclusion(s1, s2):
    if len(s1) > len(s2):
        return False

    need, window = [0] * 26, [0] * 26
    for i in range(len(s1)):
        need[ord(s1[i]) - 97] += 1
        window[ord(s2[i]) - 97] += 1         # build the first window
    if window == need:
        return True

    for right in range(len(s1), len(s2)):
        window[ord(s2[right]) - 97] += 1               # entering
        window[ord(s2[right - len(s1)]) - 97] -= 1     # leaving
        if window == need:
            return True
    return False
```

### Complexity
Time **O(26·n)** = O(n) with `n = len(s2)`. Space O(1).

> The Fixed Size Window chapter solves this with a `matched` counter instead, which removes the 26-element comparison. Both are O(n); this version is the one to write first under time pressure.

---

## 11. Solved Example 3

### Problem — Substring with Concatenation of All Words (LeetCode 30)
All words in `words` have the **same length**. Return every start index in `s` where a concatenation of all the words — in any order, each used exactly once — begins.

### Thought Process
1. Because every word has the same length `L`, the whole match has a fixed length `L × numWords`. Fixed window again.
2. **The key move:** don't slide by one character, slide by one **word**. A valid match is always aligned to some offset `0 <= offset < L`, so run the sweep `L` times, once per alignment.
3. Within one alignment, treat each `L`-character chunk as a single token and run the ordinary "window containing exactly these counts" logic.
4. Three cases per chunk:
   - **unknown word** → nothing containing it can be valid: reset the window and restart after it;
   - **too many copies** of a known word → shrink from the left until the excess is gone;
   - **all words present** → record the index, then drop one word from the left to keep searching.
5. Each alignment scans `n/L` chunks, and there are `L` alignments, so the total is O(n) chunk visits.

### Dry Run

Input: `s = "barfoothefoobarman"`, `words = ["foo", "bar"]` → `L = 3`, `numWords = 2`, total length 6

**Alignment `offset = 0`** — chunks at 0, 3, 6, 9, 12, 15:

| pos | chunk | known? | window counts | matched | action |
|-----|-------|--------|---------------|---------|--------|
| 0  | `bar` | yes | bar:1 | 1 | grow |
| 3  | `foo` | yes | bar:1 foo:1 | **2** | **record index 0**; drop `bar` at left → matched 1, `left = 3` |
| 6  | `the` | **no** | — | 0 | reset; `left = 9` |
| 9  | `foo` | yes | foo:1 | 1 | grow |
| 12 | `bar` | yes | foo:1 bar:1 | **2** | **record index 9**; drop `foo` at left → matched 1, `left = 12` |
| 15 | `man` | **no** | — | 0 | reset; `left = 18` |

**Alignment `offset = 1`** — chunks `arf`, `oot`, `hef`, `oob`, `arm`: all unknown, nothing found.
**Alignment `offset = 2`** — chunks `rfo`, `oth`, `efo`, `oba`, `rma`: all unknown, nothing found.

Output: **`[0, 9]`** ✓ (`s[0:6] = "barfoo"` and `s[9:15] = "foobar"`)

### Visualization

```text
s = b a r f o o t h e f o o b a r m a n
    0     3     6     9    12    15

offset 0 chunks:  [bar][foo][the][foo][bar][man]
                   └────────┘                        index 0  ★
                                  └────────┘         index 9  ★

offset 1 chunks:  [arf][oot][hef][oob][arm]   none known
offset 2 chunks:  [rfo][oth][efo][oba][rma]   none known

slide by a WORD, not by a character — L alignments cover every position
```

### Code

```go
func findSubstring(s string, words []string) []int {
    result := []int{}
    if len(words) == 0 || len(s) == 0 {
        return result
    }

    wordLen, numWords := len(words[0]), len(words)
    if len(s) < wordLen*numWords {
        return result
    }

    need := make(map[string]int, numWords)
    for _, w := range words {
        need[w]++
    }

    // Every valid match starts at some offset in [0, wordLen).
    for offset := 0; offset < wordLen; offset++ {
        window := make(map[string]int)
        left, matched := offset, 0

        for right := offset; right+wordLen <= len(s); right += wordLen {
            word := s[right : right+wordLen]

            want, known := need[word]
            if !known {
                // Nothing spanning this chunk can ever be valid.
                window = make(map[string]int)
                matched = 0
                left = right + wordLen
                continue
            }

            window[word]++
            matched++

            // Too many copies of `word`: drop from the left until it fits.
            for window[word] > want {
                out := s[left : left+wordLen]
                window[out]--
                matched--
                left += wordLen
            }

            if matched == numWords {
                result = append(result, left)
                // Drop one word so the search continues past this match.
                out := s[left : left+wordLen]
                window[out]--
                matched--
                left += wordLen
            }
        }
    }
    return result
}
```

```python
from collections import defaultdict

def findSubstring(s, words):
    result = []
    if not words or not s:
        return result

    word_len, num_words = len(words[0]), len(words)
    if len(s) < word_len * num_words:
        return result

    need = defaultdict(int)
    for w in words:
        need[w] += 1

    for offset in range(word_len):          # every alignment
        window = defaultdict(int)
        left, matched = offset, 0

        for right in range(offset, len(s) - word_len + 1, word_len):
            word = s[right:right + word_len]

            if word not in need:            # nothing spanning it can be valid
                window.clear()
                matched = 0
                left = right + word_len
                continue

            window[word] += 1
            matched += 1

            while window[word] > need[word]:      # too many copies
                out = s[left:left + word_len]
                window[out] -= 1
                matched -= 1
                left += word_len

            if matched == num_words:
                result.append(left)
                out = s[left:left + word_len]     # drop one and keep going
                window[out] -= 1
                matched -= 1
                left += word_len

    return result
```

### Complexity
Time **O(n · L)** where `L` is the word length — `L` alignments, each visiting `n/L` chunks, and each chunk costs O(L) to slice and hash. Space O(numWords · L) for the maps.

---

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
