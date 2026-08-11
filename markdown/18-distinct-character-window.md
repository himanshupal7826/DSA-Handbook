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

**The question this pattern keeps answering:** *"How long can a stretch of the string get before it holds too many different characters?"*

Running example: `s = "eceba"`, at most `k = 2` distinct characters. (Answer: `"ece"`, length 3.)

### Intuition
"How many different characters are in here?" is a question about a *set*. So take every possible start, walk right, drop each character into a set, and stop the moment the set grows past `k`. Whatever the longest surviving stretch was, that's the answer.

### Algorithm
1. For each start index `i` from `0` to `n − 1`:
2. &nbsp;&nbsp;Create an empty set `seen`.
3. &nbsp;&nbsp;For each end index `j` from `i` forward: add `s[j]` to `seen`.
4. &nbsp;&nbsp;If `len(seen) > k`, stop extending this start.
5. &nbsp;&nbsp;Otherwise record `j − i + 1` if it beats the best so far.
6. Return the best length.

### Complexity
- Time: **O(n²)** — `n` starts, each scanning up to `n` characters. (Rebuilding a fresh set per start rather than reusing one makes it O(n²) even though each inner step is O(1).)
- Space: O(k) for the set — at most `k + 1` characters live in it.

### Drawbacks
- Look at what happens on `"eceba"` with `k = 2`. Start `i = 0` builds the set `{e} → {e,c} → {e,c}` before dying at `'b'`. Start `i = 1` then rebuilds `{c} → {c,e} → {c,e}` — **the exact same characters, counted again from scratch**.
- Every start re-reads the tail of the string that the previous start already read. Positions `1` and `2` get scanned by start `0`, start `1`, *and* start `2`.
- The brute force refuses to exploit one fact: when start `i` fails at position `j`, moving to start `i + 1` does not change the characters in `[i+1, j]` at all. It only removes `s[i]`. We are throwing away a valid, already-computed window just to rebuild 99% of it.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep a count map of exactly the characters inside the window — then `len(map)` *is* the distinct count, free, at every step.**

Think of a small tray with one labelled bin per character. Adding a character bumps its bin; removing one lowers it. The question "how many different characters do I have?" becomes "how many bins are on the tray?" — which you never have to compute, because it is just the map's size. The whole pattern is: push the right edge out, and if the tray has too many bins, pull the left edge in until it doesn't.

### The thought process

```text
We need    : the longest stretch with at most k distinct characters.
Obvious way: try every start, extend until the set gets too big.
Too slow   : O(n^2) — each start rebuilds a set the previous start already had.
Notice     : moving the start from i to i+1 only removes ONE character.
Notice too : "number of distinct chars" = number of keys in a count map.
Therefore  : keep one map alive and edit it at both edges instead of rebuilding.
Now        : each index enters once and leaves once → O(n).
```

### Why `len(map)` only tells the truth if you delete zeroed keys

This is the whole chapter in one rule, and it is the single most common bug in it.

The map serves two jobs at once:

```text
count[ch]   → how many copies of ch are in the window   (needed to know when ch is gone)
len(count)  → how many DISTINCT chars are in the window (the thing we are bounding)
```

The second job only works if a key exists **exactly when** its character is present. A key sitting at `0` is a character that has already left the window but is still occupying a slot on the tray.

Concretely, on `s = "aab"` with `k = 2`, if you decrement without deleting:

```text
window "aab"   count = {a:2, b:1}   len = 3?  no — len = 2, fine so far
shrink 'a'     count = {a:1, b:1}   len = 2   window "ab"   ✓
shrink 'a'     count = {a:0, b:1}   len = 2   window "b"    ✗ WRONG
                                              the window holds ONE distinct char,
                                              but len(count) still reports 2
```

That inflated `2` makes the shrink loop stop too early on some inputs and never stop on others — and worse, it silently reports a smaller answer rather than crashing. So the shrink step is always three lines, never one:

```text
count[left char]--          decrement
if it hit 0 → delete it     keep the key set honest
left++                      then move the edge
```

The symmetric mistake is deleting on `> 0` or checking `< 0` — decrement first, compare to `0` exactly, and the invariant holds forever.

### Why shrinking with `while` (not `if`) is still O(n)

Each character is added by the right edge exactly once and removed by the left edge at most once. `left` never moves backwards. So across the entire run the inner `while` body executes at most `n` times *in total*, not per step — that is why a loop nested inside a loop is still linear.

### Steps

```text
Step 1 → left = 0, best = 0, count = empty map.
Step 2 → For right = 0 .. n-1:
Step 3 →     count[s[right]]++            (character enters)
Step 4 →     while len(count) > k:        (too many distinct)
Step 5 →         count[s[left]]--
Step 6 →         if count[s[left]] == 0 → delete the key
Step 7 →         left++
Step 8 →     best = max(best, right-left+1)
Step 9 → Return best.
```

For "all characters distinct" (LeetCode 3), the same code runs with the invalidity test `len(count) < right-left+1` — i.e. some character has a count above 1.

### How should I recognize this?

```text
If you see...
  "at most k distinct", "at most two distinct", "no repeating characters"
  "longest substring such that ..." where the condition counts CHARACTER KINDS
  a character/alphabet constraint rather than a numeric one
        ↓
Think about...
  "Is my window's validity a statement about how many DIFFERENT things it holds?"
        ↓
Use...
  a count map as the window state, len(map) as the distinct count
  ├─ at most k distinct   → shrink while len(count) > k
  ├─ all distinct         → shrink while len(count) < windowLength
  └─ exactly k distinct   → atMost(k) - atMost(k-1)
  and ALWAYS delete a key when its count reaches 0
```

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

```text
s = "eceba", k = 2

right  char  count map        len  action                    window   best
-----  ----  ---------------  ---  ------------------------  -------  ----
  0     e    {e:1}             1   ok                        "e"       1
  1     c    {e:1,c:1}         2   ok                        "ec"      2
  2     e    {e:2,c:1}         2   ok                        "ece"     3
  3     b    {e:2,c:1,b:1}     3   too many → shrink
             drop 'e' (idx 0)  {e:1,c:1,b:1}  len 3, still too many
             drop 'c' (idx 1)  {e:1,b:1}      len 2, stop.   "eb"      3
  4     a    {e:1,b:1,a:1}     3   too many → shrink
             drop 'e' (idx 2)  {b:1,a:1}      len 2, stop.   "ba"      3

answer: 3
```

Notice row `right = 3`: dropping `'e'` at index 0 left `e:1` behind, because index 2 is still inside the window. Only when a count truly reaches zero does the key vanish — that is exactly the distinction `len(map)` depends on.

### Interview explanation
"The condition here counts *kinds* of characters, so I make the window's state a character-count map: `len(map)` is then the distinct count, available for free at every step. I expand the right edge, incrementing the entering character's count, and while the map has more than `k` keys I shrink from the left — decrementing, and crucially **deleting the key when its count hits zero**, otherwise a character that has already left the window keeps inflating `len(map)` and the answer comes out wrong. Each index enters and leaves at most once, so despite the nested loop it's O(n) time and O(k) space."

---

## 5. Generic Templates

> Count map = window state. `len(map)` = distinct count. Delete at zero, or the count lies.

```go
// LongestAtMostKDistinct returns the length of the longest substring of s
// containing at most k distinct characters.
func LongestAtMostKDistinct(s string, k int) int {
    if k <= 0 {
        return 0
    }
    count := make(map[byte]int)
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        count[s[right]]++ // character enters the window

        for len(count) > k { // len(count) IS the distinct count
            leftChar := s[left]
            count[leftChar]--
            if count[leftChar] == 0 {
                delete(count, leftChar) // or len(count) would lie
            }
            left++
        }

        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```

```python
def longest_at_most_k_distinct(s, k):
    """Length of the longest substring of s with at most k distinct characters."""
    if k <= 0:
        return 0
    count = {}
    left = best = 0

    for right, ch in enumerate(s):
        count[ch] = count.get(ch, 0) + 1      # character enters

        while len(count) > k:                 # len(count) IS the distinct count
            left_char = s[left]
            count[left_char] -= 1
            if count[left_char] == 0:
                del count[left_char]          # or len(count) would lie
            left += 1

        best = max(best, right - left + 1)
    return best
```

```java
import java.util.*;

public class DistinctWindow {
    // Longest substring of s with at most k distinct characters.
    public static int longestAtMostKDistinct(String s, int k) {
        if (k <= 0) return 0;
        Map<Character, Integer> count = new HashMap<>();
        int left = 0, best = 0;

        for (int right = 0; right < s.length(); right++) {
            count.merge(s.charAt(right), 1, Integer::sum);   // enters

            while (count.size() > k) {                       // size() IS the distinct count
                char leftChar = s.charAt(left);
                if (count.merge(leftChar, -1, Integer::sum) == 0) {
                    count.remove(leftChar);                  // or size() would lie
                }
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

// Longest substring of s with at most k distinct characters.
int longestAtMostKDistinct(const string& s, int k) {
    if (k <= 0) return 0;
    unordered_map<char, int> count;
    int left = 0, best = 0;

    for (int right = 0; right < (int)s.size(); ++right) {
        ++count[s[right]];                     // enters

        while ((int)count.size() > k) {        // size() IS the distinct count
            char leftChar = s[left];
            if (--count[leftChar] == 0) {
                count.erase(leftChar);         // or size() would lie
            }
            ++left;
        }

        if (right - left + 1 > best) best = right - left + 1;
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
Return the length of the longest substring of `s` that contains **no repeating characters**.

### Thought Process
1. "No repeating characters" means: every character in the window is distinct — i.e. the number of *distinct* characters equals the window's *length*.
2. That is exactly the state this chapter maintains: `len(count)` is the distinct count, `right - left + 1` is the length.
3. So the window is invalid precisely when `len(count) < right - left + 1`, and we shrink from the left until they agree again.
4. Shrinking must delete a key when its count reaches zero — otherwise `len(count)` stays too high and the loop exits before the duplicate is actually gone.
5. Record the length after every shrink.

> Chapter 14 solves this same problem with a `lastSeen` map and a **jump** (`left = lastSeen[ch] + 1`), and chapter 15 with a "some count exceeded 1" test. Same answer, three lenses. The count-map lens below is the one that generalises to "at most k distinct" without any change of shape.

### Dry Run

Input: `s = "pwwkew"`

| right | char | count map after add | `len(count)` | window len | valid? | shrink actions | window | best |
|-------|------|---------------------|--------------|------------|--------|----------------|--------|------|
| 0 | `p` | `{p:1}` | 1 | 1 | yes | — | `"p"` | 1 |
| 1 | `w` | `{p:1, w:1}` | 2 | 2 | yes | — | `"pw"` | 2 |
| 2 | `w` | `{p:1, w:2}` | 2 | 3 | **no** | drop `p` → **delete** → `{w:2}`, len 1 vs 2 still no; drop `w` → `{w:1}`, len 1 vs 1 ok | `"w"` | 2 |
| 3 | `k` | `{w:1, k:1}` | 2 | 2 | yes | — | `"wk"` | 2 |
| 4 | `e` | `{w:1, k:1, e:1}` | 3 | 3 | yes | — | `"wke"` | **3** |
| 5 | `w` | `{w:2, k:1, e:1}` | 3 | 4 | **no** | drop `w` → `{w:1,…}`, len 3 vs 3 ok | `"kew"` | 3 |

Output: **3** (`"wke"` or `"kew"`)

Row `right = 2` is the one to study. The first shrink removes `'p'`, whose count hits `0` — the key is **deleted**, so `len(count)` drops from 2 to 1. Had we left `p:0` in the map, `len(count)` would still read 2, equal to the window length 2, and the loop would have stopped with `"ww"` declared valid.

### Visualization

```text
s =  p  w  w  k  e  w
     0  1  2  3  4  5

     └──┘                 "pw"    distinct 2 = len 2   ok
        └──┘              "ww"    distinct 1 < len 2   shrink!
           └───────┘      "wke"   distinct 3 = len 3   ★ best = 3
              └──────┘    "kew"   distinct 3 = len 3   also 3

rule: window is valid  ⟺  len(count) == right - left + 1
```

### Code

```go
func lengthOfLongestSubstring(s string) int {
    count := make(map[byte]int)
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        count[s[right]]++

        // Invalid while some character appears twice, i.e. distinct < length.
        for len(count) < right-left+1 {
            leftChar := s[left]
            count[leftChar]--
            if count[leftChar] == 0 {
                delete(count, leftChar) // keep len(count) honest
            }
            left++
        }

        if right-left+1 > best {
            best = right - left + 1
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

        # Invalid while some character appears twice, i.e. distinct < length.
        while len(count) < right - left + 1:
            left_char = s[left]
            count[left_char] -= 1
            if count[left_char] == 0:
                del count[left_char]       # keep len(count) honest
            left += 1

        best = max(best, right - left + 1)
    return best
```

### Complexity
Time **O(n)** — `right` advances `n` times and `left` advances at most `n` times in total. Space **O(min(n, alphabet))** — the map holds one key per distinct character in the window.

---

## 10. Solved Example 2

### Problem — K Distinct (LeetCode 340)
Return the length of the longest substring of `s` containing **at most `k` distinct** characters.

### Thought Process
1. This is the pattern in its purest form: the window's validity is literally `len(count) <= k`.
2. Expand `right`, incrementing the entering character's count.
3. While `len(count) > k`, shrink from `left`: decrement, delete on zero, advance.
4. Because we shrink only when invalid, the window is as long as it can be for the current `right` — record `right - left + 1` each step.
5. Guard `k == 0`: no substring can hold zero distinct characters, so the answer is `0`.

### Dry Run

Input: `s = "eceba"`, `k = 2`

| right | char | count map after add | `len` | shrink? | count after shrink | left | window | best |
|-------|------|---------------------|-------|---------|--------------------|------|--------|------|
| 0 | `e` | `{e:1}` | 1 | no | — | 0 | `"e"` | 1 |
| 1 | `c` | `{e:1, c:1}` | 2 | no | — | 0 | `"ec"` | 2 |
| 2 | `e` | `{e:2, c:1}` | 2 | no | — | 0 | `"ece"` | **3** |
| 3 | `b` | `{e:2, c:1, b:1}` | 3 | **yes** | drop `e` → `{e:1,c:1,b:1}` len 3, *still* > 2; drop `c` → **delete** → `{e:1,b:1}` len 2 | 2 | `"eb"` | 3 |
| 4 | `a` | `{e:1, b:1, a:1}` | 3 | **yes** | drop `e` → **delete** → `{b:1,a:1}` len 2 | 3 | `"ba"` | 3 |

Output: **3** (`"ece"`)

Row `right = 3` shows both halves of the rule in one step. Removing the `'e'` at index 0 leaves `e:1` because the `'e'` at index 2 is still inside the window — so the key must **stay**, and the shrink loop correctly runs again. Removing `'c'` takes its count to `0` — so the key must **go**, and only then does `len(count)` fall to 2.

### Visualization

```text
s =  e  c  e  b  a          k = 2
     0  1  2  3  4

     └────────┘            "ece"  map {e:2, c:1}   2 keys   ★ best = 3
           └──┘            "eb"   map {e:1, b:1}   2 keys
              └──┘         "ba"   map {b:1, a:1}   2 keys

left only ever moves right → each index leaves the window at most once
```

### Code

```go
func lengthOfLongestSubstringKDistinct(s string, k int) int {
    if k <= 0 {
        return 0
    }
    count := make(map[byte]int)
    left, best := 0, 0

    for right := 0; right < len(s); right++ {
        count[s[right]]++ // enters

        for len(count) > k { // too many distinct characters
            leftChar := s[left]
            count[leftChar]--
            if count[leftChar] == 0 {
                delete(count, leftChar) // the character is truly gone now
            }
            left++
        }

        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```

```python
def lengthOfLongestSubstringKDistinct(s, k):
    if k <= 0:
        return 0
    count = {}
    left = best = 0

    for right, ch in enumerate(s):
        count[ch] = count.get(ch, 0) + 1       # enters

        while len(count) > k:                  # too many distinct characters
            left_char = s[left]
            count[left_char] -= 1
            if count[left_char] == 0:
                del count[left_char]           # truly gone now
            left += 1

        best = max(best, right - left + 1)
    return best
```

### Complexity
Time **O(n)** — every index is added once and removed at most once. Space **O(k)** — the map never exceeds `k + 1` keys.

---

## 11. Solved Example 3

### Problem — Two Distinct (LeetCode 159)
Return the length of the longest substring of `s` containing **at most two distinct** characters.

### Thought Process
1. This is example 2 with `k` nailed to `2`, so the algorithm is unchanged — but it lets us show the array version of the same state.
2. When the alphabet is fixed (128 ASCII codes), swap the map for a plain array `counts[128]`. Array indexing is faster and allocation-free.
3. **But an array has no "size".** `len(counts)` is always 128. So you must maintain the distinct count by hand.
4. The rule is exactly what `delete`-on-zero was doing for you: bump `distinct` when a count goes `0 → 1`, and drop it when a count goes `1 → 0`. Nothing else changes `distinct`.
5. Shrink while `distinct > 2`, and record the length each step.

### Dry Run

Input: `s = "ccaabbb"`

| right | char | count change | `distinct` | shrink? | left | window | best |
|-------|------|--------------|------------|---------|------|--------|------|
| 0 | `c` | c 0→1 | 1 (`0→1`, bump) | no | 0 | `"c"` | 1 |
| 1 | `c` | c 1→2 | 1 (no change) | no | 0 | `"cc"` | 2 |
| 2 | `a` | a 0→1 | 2 (bump) | no | 0 | `"cca"` | 3 |
| 3 | `a` | a 1→2 | 2 | no | 0 | `"ccaa"` | **4** |
| 4 | `b` | b 0→1 | 3 (bump) | **yes**: drop `c` (c 2→1, *no* change to distinct); drop `c` (c 1→0, distinct → 2) | 2 | `"aab"` | 4 |
| 5 | `b` | b 1→2 | 2 | no | 2 | `"aabb"` | 4 |
| 6 | `b` | b 2→3 | 2 | no | 2 | `"aabbb"` | **5** |

Output: **5** (`"aabbb"`)

Row `right = 4` is the payoff: the first shrink takes `c` from 2 to 1 and `distinct` **must not** move, because a `'c'` is still in the window. Only the second shrink, `1 → 0`, is allowed to decrement it. That is the array-shaped restatement of "delete the key when it hits zero".

### Visualization

```text
s =  c  c  a  a  b  b  b
     0  1  2  3  4  5  6

     └────────┘                  "ccaa"    {c,a}   distinct 2   len 4
              (add 'b' → {c,a,b}, distinct 3 → shrink both c's)
           └──────────────┘      "aabbb"   {a,b}   distinct 2   ★ len 5

counts[]:  no .size() available  →  distinct is maintained by hand
           0 → 1 : distinct++        1 → 0 : distinct--
```

### Code

```go
func lengthOfLongestSubstringTwoDistinct(s string) int {
    const k = 2
    var counts [128]int // fixed ASCII alphabet: array instead of a map
    distinct, left, best := 0, 0, 0

    for right := 0; right < len(s); right++ {
        in := s[right]
        if counts[in] == 0 {
            distinct++ // 0 -> 1: a new character kind appeared
        }
        counts[in]++

        for distinct > k {
            out := s[left]
            counts[out]--
            if counts[out] == 0 {
                distinct-- // 1 -> 0: that character kind is gone
            }
            left++
        }

        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```

```python
def lengthOfLongestSubstringTwoDistinct(s):
    K = 2
    counts = [0] * 128           # fixed ASCII alphabet: list instead of a dict
    distinct = left = best = 0

    for right, ch in enumerate(s):
        i = ord(ch)
        if counts[i] == 0:
            distinct += 1        # 0 -> 1: a new character kind appeared
        counts[i] += 1

        while distinct > K:
            j = ord(s[left])
            counts[j] -= 1
            if counts[j] == 0:
                distinct -= 1    # 1 -> 0: that character kind is gone
            left += 1

        best = max(best, right - left + 1)
    return best
```

### Complexity
Time **O(n)** — one pass, each index entering and leaving once. Space **O(1)** — a fixed 128-slot array regardless of input size (versus O(k) for the map version).

---

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
