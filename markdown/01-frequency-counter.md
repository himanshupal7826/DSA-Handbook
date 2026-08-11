# 01 · Frequency Counter

> **One-liner:** Replace expensive nested comparisons with a single pass that *tallies* occurrences into a hash map, then answer questions by reading the tally.

---

## 1. Overview

### Definition
The **Frequency Counter** pattern uses a hash map (or array, when the key space is small and dense) to record *how many times* each value, character, or property appears. Once the tally is built, comparisons that would normally require nested loops become O(1) map lookups.

### Intuition
Whenever you catch yourself comparing **every element against every other element** ("does this match that?"), pause. Most of those comparisons are about *counts* or *existence*. A hash map answers "how many of X have I seen?" in constant time, collapsing an O(n²) double loop into two independent O(n) passes.

### Why it works
Two collections are equivalent (anagrams, permutations, same multiset) **if and only if** their frequency maps are identical. Counting is *associative and order-independent*, so a single linear scan captures all the information a quadratic scan would — without revisiting elements.

### Real-world use cases
- **Anagram / duplicate detection** in text processing and plagiarism checkers.
- **Word/term frequency** in search engines (TF in TF-IDF).
- **Rate limiting & analytics** — counting events per user/IP in a window.
- **Cache & deduplication** — counting references before eviction.
- **Bioinformatics** — k-mer counting in DNA sequences.

---

## 2. Recognition Signals

Train your eye to fire on these:

### Keywords
- "anagram", "permutation", "rearrange"
- "how many times", "count", "frequency", "occurrences"
- "duplicate", "unique", "appears once / twice / k times"
- "same characters", "contains all", "majority element"

### Constraints
- Comparing **two strings/arrays** for equivalence.
- Small, bounded alphabet (e.g., 26 lowercase letters → use a `[26]int` array instead of a map).
- `n` up to 10^5–10^7, so an O(n²) brute force will TLE — the counting reduction to O(n) is the intended solution.

### Hidden clues
- The answer doesn't depend on **order**, only on **multiset membership**.
- You only need to know *whether* something exists or *how often*, not *where*.

### Interview hints
- The interviewer says "can you do better than O(n²)?" after a brute-force comparison → counting is usually the first optimization.
- "Constant extra space" with a fixed alphabet → array of counts, not a map.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How many times does each thing appear?"* — and then something about those counts.

Running example: are `s` and `t` anagrams (same letters, same counts, order ignored)?

### Intuition
Without any bookkeeping, the only way to know whether `t` has "the right number of each letter" is to go looking for each letter, one at a time. For every character of `s`, scan all of `t` for an unused match and cross it off.

### Algorithm
1. If `len(s) != len(t)` → not anagrams.
2. Take the first character of `s`. Scan `t` from the start looking for it.
3. If found, mark that position of `t` as used so it can't match twice.
4. If not found, return false.
5. Repeat for every character of `s`. If all matched → anagram.

### Complexity
- Time: **O(n²)** — every one of the `n` characters may scan all `n` positions.
- Space: O(n) for the "used" marks.
- (Sorting both strings and comparing is the other obvious route: O(n log n).)

### Drawbacks
- We rescan `t` from scratch for every single character — the same work over and over.
- Sorting is better, but it does more than we asked for: we don't need the letters *in order*, we only need *how many of each*. Paying O(n log n) to learn an ordering we then throw away is wasted work.

---

## 4. Optimal Approach

### Core idea

Here is the whole idea in one sentence:

> **Stop searching for characters. Count them once, then just read the counts.**

The brute force is slow because *lookup* is slow — finding "is there another `a` left in `t`?" costs a scan. But if we build a small table `letter → how many times it appears`, that same question becomes a single array read.

### The thought process

```text
We need    : to know if s and t have identical letter counts.
Obvious way: for each letter of s, search t for it.
Too slow   : each search is O(n), so O(n²) total.
Notice     : we never care WHERE a letter is, only HOW MANY there are.
Therefore  : store the counts in a table indexed by the letter itself.
Now        : "how many a's are left?" is one array read instead of a scan.
```

### Why we need a counting table (and not something else)

A frequency table is just a **direct-address array**: the character *is* the index. `count['a'-'a']` is slot 0, `count['b'-'a']` is slot 1, and so on. No searching, no hashing, no comparison — the data tells you where to look. That is why lookups are O(1).

Use a fixed array when the key domain is small and known (26 lowercase letters, ASCII 128, digits 0–9). Use a hash map when the keys are arbitrary (words, large integers, structs).

### Steps

```text
Step 1 → If lengths differ, return false immediately.
Step 2 → Walk both strings together with one index i.
Step 3 → For s[i], add 1 to its slot. For t[i], subtract 1 from its slot.
Step 4 → After the walk, every slot must be 0.
Step 5 → Any non-zero slot means one string has a surplus → not anagrams.
```

Why can we fuse both strings into **one** table? Because `+1` for `s` and `−1` for `t` cancel exactly when the counts match. We are really computing `count(s) − count(t)` and asking whether it is all zeros. Two tables would work too — one is just cheaper.

### Why the equal-length check matters

With equal lengths, "no slot is negative" and "no slot is positive" mean the same thing — the total of all slots is forced to 0. That is what lets a single scan settle it. Without the length check, `s="a"`, `t="aa"` would leave slot `a` at `−1` and you would still need to reason about it separately.

### How should I recognize this?

```text
If you see...
  "anagram", "permutation of", "same characters"
  "count / how many times", "appears exactly k times"
  "first non-repeating", "majority element", "duplicate"
        ↓
Think about...
  "I don't need positions — I need tallies."
        ↓
Use...
  fixed array  → small known alphabet (a-z, ASCII, digits)
  hash map     → arbitrary keys (words, ints, tuples)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="fc-01" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">s = "anagram" vs t = "nagaram": +1 for s, then −1 for t</text>
  <text x="55" y="82" fill="#64748b">count(s)</text>
  <text x="55" y="182" fill="#64748b">after t</text>
  <!-- top row: tally of s -->
  <g>
    <text x="163" y="58" text-anchor="middle" fill="#64748b">a</text><rect x="135" y="65" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="163" y="91" text-anchor="middle" fill="#1e293b">3</text>
    <text x="233" y="58" text-anchor="middle" fill="#64748b">n</text><rect x="205" y="65" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="233" y="91" text-anchor="middle" fill="#1e293b">1</text>
    <text x="303" y="58" text-anchor="middle" fill="#64748b">g</text><rect x="275" y="65" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="303" y="91" text-anchor="middle" fill="#1e293b">1</text>
    <text x="373" y="58" text-anchor="middle" fill="#64748b">r</text><rect x="345" y="65" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="373" y="91" text-anchor="middle" fill="#1e293b">1</text>
    <text x="443" y="58" text-anchor="middle" fill="#64748b">m</text><rect x="415" y="65" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="443" y="91" text-anchor="middle" fill="#1e293b">1</text>
  </g>
  <line x1="303" y1="112" x2="303" y2="158" stroke="#475569" marker-end="url(#fc-01)"/>
  <text x="500" y="138" text-anchor="middle" fill="#64748b">scan t, decrement</text>
  <!-- bottom row: all zero after t -->
  <g>
    <rect x="135" y="165" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="163" y="191" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="205" y="165" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="233" y="191" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="275" y="165" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="303" y="191" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="345" y="165" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="373" y="191" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="415" y="165" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="443" y="191" text-anchor="middle" fill="#1e293b">0</text>
  </g>
  <text x="540" y="191" text-anchor="middle" fill="#059669" font-weight="700">all 0 → anagram</text>
</svg>
```

```text
s = "anagram"        t = "nagaram"

count after adding s : a:3  n:1  g:1  r:1  m:1
count after minus t  : a:0  n:0  g:0  r:0  m:0

all zero  →  ANAGRAM ✅
```

### Interview explanation
"I'll tally into a fixed 26-slot array since the input is lowercase English. I walk both strings in one loop: `+1` for `s[i]`, `−1` for `t[i]`. Because the lengths are equal, an all-zero array at the end is exactly the anagram condition. That's one pass, O(n) time and O(1) space — the array size doesn't grow with the input."

---

## 5. Generic Templates

> The four implementations below share one skeleton: **build the table, then read the table.**

```go
// CountFrequencies tallies any comparable values. O(n) time, O(k) space
// where k is the number of distinct values.
func CountFrequencies[T comparable](xs []T) map[T]int {
    freq := make(map[T]int, len(xs))
    for _, x := range xs {
        freq[x]++ // missing keys read as 0, so this is safe
    }
    return freq
}

// IsAnagram fuses both strings into one 26-slot table.
// +1 for s, -1 for t; all zeros means the counts matched.
func IsAnagram(s, t string) bool {
    if len(s) != len(t) {
        return false
    }
    var count [26]int
    for i := 0; i < len(s); i++ {
        count[s[i]-'a']++
        count[t[i]-'a']--
    }
    for _, c := range count {
        if c != 0 {
            return false
        }
    }
    return true
}
```

```python
from collections import Counter

def count_frequencies(xs):
    """Tally any hashable values. O(n) time."""
    return Counter(xs)

def is_anagram(s: str, t: str) -> bool:
    """One table, +1 for s and -1 for t. All zeros means anagram."""
    if len(s) != len(t):
        return False
    count = [0] * 26
    for a, b in zip(s, t):
        count[ord(a) - 97] += 1
        count[ord(b) - 97] -= 1
    return all(c == 0 for c in count)
```

```java
import java.util.*;

public class FrequencyCounter {
    // Tally any object type.
    public static <T> Map<T, Integer> countFrequencies(List<T> xs) {
        Map<T, Integer> freq = new HashMap<>();
        for (T x : xs) freq.merge(x, 1, Integer::sum);
        return freq;
    }

    // One table, +1 for s and -1 for t.
    public static boolean isAnagram(String s, String t) {
        if (s.length() != t.length()) return false;
        int[] count = new int[26];
        for (int i = 0; i < s.length(); i++) {
            count[s.charAt(i) - 'a']++;
            count[t.charAt(i) - 'a']--;
        }
        for (int c : count) if (c != 0) return false;
        return true;
    }
}
```

```cpp
#include <string>
#include <unordered_map>
#include <vector>
using namespace std;

// Tally any hashable values.
template <typename T>
unordered_map<T, int> countFrequencies(const vector<T>& xs) {
    unordered_map<T, int> freq;
    freq.reserve(xs.size());
    for (const auto& x : xs) ++freq[x];
    return freq;
}

// One table, +1 for s and -1 for t.
bool isAnagram(const string& s, const string& t) {
    if (s.size() != t.size()) return false;
    int count[26] = {0};
    for (size_t i = 0; i < s.size(); ++i) {
        ++count[s[i] - 'a'];
        --count[t[i] - 'a'];
    }
    for (int c : count) if (c != 0) return false;
    return true;
}
```

---

## 6. Complexity Analysis

| Metric | Brute (search) | Brute (sort) | Frequency Counter |
|--------|----------------|--------------|-------------------|
| Time (worst) | O(n²) | O(n log n) | **O(n)** |
| Time (best)  | O(n) early-exit | O(n log n) | **O(n)** |
| Time (avg)   | O(n²) | O(n log n) | **O(n)** |
| Space        | O(1) | O(n) | **O(k)** (k = distinct keys) |

> [!TIP]
> With a fixed alphabet (26 letters, ASCII 128, digits 10), `k` is a constant, so space is effectively **O(1)**.

---

## 7. Common Mistakes

1. **Forgetting the length check** — different-length strings can never be anagrams; checking first saves work and avoids false positives.
2. **Using a map when an array suffices** — for `a–z`, a `[26]int` is faster and uses constant memory.
3. **Off-by-one with character indexing** — `ch - 'a'` must use the correct base (`'A'` for uppercase, `'0'` for digits).
4. **Not handling Unicode** — `[26]int` breaks for accented/emoji input; fall back to a hash map.
5. **Comparing counts with `>` instead of `!=`** when both directions matter (decrement approach can go negative *or* leave positives).
6. **Mutating the input** by sorting in place when the caller still needs the original.
7. **Re-counting inside a loop** — build the map once, then query; don't rebuild per query.
8. **Ignoring case/whitespace** when the problem says "ignore spaces and capitalization."
9. **Integer overflow** in languages with fixed-width ints when counts are huge (rare, but real in streaming).
10. **Assuming map iteration order** — never rely on hash-map ordering for output.
11. **Leaving zero entries** in the map and then checking `len(map)==0` — delete on zero or compare values explicitly.
12. **Forgetting that two passes can be fused** — increment for one input and decrement for the other in a single loop.

---

## 8. Interview Follow-Up Questions

1. **Q: Why is this O(n) and not O(n log n)?**
   A: Hash insert/lookup is amortized O(1), and we touch each element a constant number of times — no sorting needed.

2. **Q: Array vs. hash map — when do you pick which?**
   A: Array when the key domain is small, dense, and known (e.g., 26 letters); map when keys are sparse, large, or arbitrary objects.

3. **Q: How do you make it O(1) space?**
   A: Fixed alphabet → fixed-size array. The constant alphabet makes space independent of `n`.

4. **Q: Handle Unicode anagrams?**
   A: Normalize (NFC/NFKC) then count *code points* (or grapheme clusters) in a hash map, not bytes.

5. **Q: What if you must be case-insensitive and ignore punctuation?**
   A: Pre-filter: lowercase and skip non-letters before counting.

6. **Q: Group all anagrams in a list of words?**
   A: Use the sorted string (or a 26-length count tuple) as a map key; words sharing a key are anagrams (LeetCode 49).

7. **Q: Streaming input you can't store — count distinct approximately?**
   A: Use a Count-Min Sketch or HyperLogLog for sublinear-memory approximate frequencies/cardinality.

8. **Q: Find the majority element (> n/2)?**
   A: Frequency map works, but **Boyer-Moore voting** does it in O(1) space — a related optimization.

9. **Q: First non-repeating character?**
   A: Count first, then scan again returning the first char with count 1 (LeetCode 387).

10. **Q: Two arrays — find the intersection with multiplicity?**
    A: Count one, decrement while scanning the other; emit when count > 0 (LeetCode 350).

11. **Q: How would you parallelize counting across machines?**
    A: Map-Reduce: each shard emits partial counts; reduce sums by key. Counts are commutative/associative.

12. **Q: Detect if any value appears more than k times?**
    A: Count, then check `max(values) > k`; or short-circuit during counting.

13. **Q: Memory blows up with billions of distinct keys — options?**
    A: External/disk-based aggregation, sketches, or top-k heaps if only the heavy hitters matter.

14. **Q: Can you verify anagram without extra space at all?**
    A: Sorting in place gives O(1) auxiliary (ignoring sort stack) but O(n log n) time — a time/space trade-off.

15. **Q: How does this relate to the HashMap Lookup pattern?**
    A: Both trade space for O(1) access; counting stores *quantities*, lookup stores *existence/positions*. See [[02-hashmap-lookup]].

---

## 9. Solved Example 1

### Problem — Valid Anagram (LeetCode 242)
Given `s` and `t`, return `true` if `t` is an anagram of `s`.

### Thought Process
1. Anagram means *same multiset of letters*, so only counts matter.
2. Unequal lengths can never be anagrams — reject in O(1).
3. Walk both strings with one index: `+1` for `s[i]`, `−1` for `t[i]`.
4. Equal lengths + all-zero table ⇔ anagram.

### Dry Run

Input: `s = "rat"`, `t = "car"`

Lengths match (3 == 3), so we walk the pair `(s[i], t[i])`.

| i | s[i] | t[i] | change            | table after (only non-zero) |
|---|------|------|-------------------|-----------------------------|
| 0 | r    | c    | r +1, c −1        | r:+1, c:−1                  |
| 1 | a    | a    | a +1, a −1        | r:+1, c:−1                  |
| 2 | t    | r    | t +1, r −1        | c:−1, t:+1                  |

Final scan finds `c = −1` (a letter `t` has that `s` doesn't) → return **false**.

### Visualization

```text
letter :  a    c    r    t
net    :  0   -1    0   +1
                ↑         ↑
        t has a 'c'   s has a 't'
        s lacks       t lacks
```

Any non-zero entry ⇒ not an anagram.

### Code

```go
func isAnagram(s string, t string) bool {
    if len(s) != len(t) {
        return false
    }
    var count [26]int
    for i := 0; i < len(s); i++ {
        count[s[i]-'a']++ // surplus from s
        count[t[i]-'a']-- // consumed by t
    }
    for _, c := range count {
        if c != 0 {
            return false
        }
    }
    return true
}
```

```python
def isAnagram(s, t):
    if len(s) != len(t):
        return False
    count = [0] * 26
    for a, b in zip(s, t):
        count[ord(a) - 97] += 1
        count[ord(b) - 97] -= 1
    return all(c == 0 for c in count)
```

### Complexity
Time O(n) — one pass plus a fixed 26-slot scan. Space O(1) — the table size never grows with the input.

---

## 10. Solved Example 2

### Problem — Group Anagrams (LeetCode 49)
Group words that are anagrams of each other.

### Thought Process
1. Comparing every pair of words is O(N²) — too slow.
2. Instead, give each word a **signature** that is identical for anagrams and different otherwise.
3. The frequency table *is* that signature: `"eat"` and `"tea"` both tally to `a:1, e:1, t:1`.
4. Use the signature as a map key and append the word to its bucket.

### Dry Run

Input: `["eat", "tea", "tan"]`

We write the signature as the counts of `a,b,…,z`; only non-zero letters are shown.

| word  | signature      | map after                          |
|-------|----------------|------------------------------------|
| "eat" | a:1, e:1, t:1  | `{aet: [eat]}`                     |
| "tea" | a:1, e:1, t:1  | `{aet: [eat, tea]}`  ← same bucket |
| "tan" | a:1, n:1, t:1  | `{aet: [eat, tea], ant: [tan]}`    |

Output: `[["eat","tea"], ["tan"]]`

### Visualization

```text
"eat" ─┐
       ├─▶ signature a1 e1 t1 ─▶ bucket #1  [eat, tea]
"tea" ─┘

"tan" ───▶ signature a1 n1 t1 ─▶ bucket #2  [tan]
```

### Code

```go
func groupAnagrams(strs []string) [][]string {
    // key: the 26-slot count array, usable directly as a Go map key.
    groups := make(map[[26]int][]string)
    for _, w := range strs {
        var key [26]int
        for i := 0; i < len(w); i++ {
            key[w[i]-'a']++
        }
        groups[key] = append(groups[key], w)
    }

    result := make([][]string, 0, len(groups))
    for _, bucket := range groups {
        result = append(result, bucket)
    }
    return result
}
```

```python
from collections import defaultdict

def groupAnagrams(strs):
    groups = defaultdict(list)
    for w in strs:
        key = [0] * 26
        for ch in w:
            key[ord(ch) - 97] += 1
        groups[tuple(key)].append(w)   # tuple is hashable, list is not
    return list(groups.values())
```

### Complexity
Time O(N·L) for N words of max length L — each word is tallied once. Space O(N·L) for the buckets.

> Sorting each word to build the key also works, but costs O(N·L log L). Counting is strictly cheaper.

---

## 11. Solved Example 3

### Problem — First Unique Character (LeetCode 387)
Return the index of the first non-repeating character in `s`, or `−1` if there is none.

### Thought Process
1. "Non-repeating" is a statement about a count, so we need counts.
2. But we can't answer while counting — the character at index 0 might repeat at the very end.
3. So: **pass 1** counts every character, **pass 2** walks left to right and returns the first index whose count is 1.
4. Two passes are still O(n) total.

### Dry Run

Input: `s = "leetcode"`

**Pass 1 — build the table:**

| char  | l | e | t | c | o | d |
|-------|---|---|---|---|---|---|
| count | 1 | 3 | 1 | 1 | 1 | 1 |

**Pass 2 — scan left to right:**

| i | s[i] | count | unique? |
|---|------|-------|---------|
| 0 | l    | 1     | yes → return **0** |

Output: **0**

A second case, `s = "loveleetcode"` → counts `l:2, o:2, v:1, e:4, …`; index 0 (`l`) has count 2, index 1 (`o`) has count 2, index 2 (`v`) has count 1 → answer **2**.

### Visualization

```text
s :  l  e  e  t  c  o  d  e
cnt: 1  3  3  1  1  1  1  3
     ↑
   first count == 1  →  index 0
```

### Code

```go
func firstUniqChar(s string) int {
    var count [26]int
    for i := 0; i < len(s); i++ { // pass 1: tally
        count[s[i]-'a']++
    }
    for i := 0; i < len(s); i++ { // pass 2: first with count 1
        if count[s[i]-'a'] == 1 {
            return i
        }
    }
    return -1
}
```

```python
from collections import Counter

def firstUniqChar(s):
    count = Counter(s)                 # pass 1: tally
    for i, ch in enumerate(s):         # pass 2: first with count 1
        if count[ch] == 1:
            return i
    return -1
```

### Complexity
Time O(n) — two linear passes. Space O(1) — 26 fixed slots.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 242 | Valid Anagram | Easy | Canonical frequency-equality check |
| 383 | Ransom Note | Easy | Subset-count containment |
| 387 | First Unique Character | Easy | Count-then-scan two-pass idiom |
| 1 | Two Sum | Easy | Bridges into HashMap Lookup |
| 349 | Intersection of Two Arrays | Easy | Set/count intersection |
| 350 | Intersection II | Easy | Multiset intersection with counts |
| 49 | Group Anagrams | Medium | Frequency signature as a map key |
| 347 | Top K Frequent Elements | Medium | Counting + heap/bucket selection |
| 451 | Sort Characters By Frequency | Medium | Count then order by frequency |
| 438 | Find All Anagrams in a String | Medium | Counting + sliding window combo |
| 567 | Permutation in String | Medium | Window of fixed counts |
| 76 | Minimum Window Substring | Hard | Counting drives window validity |

---

## 13. Pattern Variations

- **Fixed-array counter** — small dense alphabet, O(1) space.
- **Hash-map counter** — arbitrary/large key space.
- **Signature key** — use the count vector itself as a dictionary key (Group Anagrams).
- **Decrement-to-match** — one map, +1/−1 to compare two collections in one pass.
- **Count + window** — frequency map maintained over a sliding window (links to [[17-anagram-window]]).
- **Approximate counting** — Count-Min Sketch / HyperLogLog when memory is tight.
- **Boyer-Moore voting** — O(1)-space specialization for majority elements.

---

## 14. Production Engineering Applications

- **Scalability:** Counting is embarrassingly parallel — Map-Reduce/Spark `reduceByKey` sums partial counts across shards because addition is associative and commutative.
- **Monitoring:** Per-endpoint/error-code counters power dashboards (Prometheus counters are literally this pattern).
- **Memory trade-offs:** Exact counts cost O(distinct keys). For high-cardinality streams (unique users), switch to **HyperLogLog** (cardinality) or **Count-Min Sketch** (frequency) for bounded memory with controlled error.
- **Performance optimization:** Prefer arrays over hash maps for dense small domains (cache-friendly, no hashing). Pre-size maps to avoid rehash churn.
- **Distributed systems:** Heavy-hitter detection (Space-Saving algorithm), rate limiting (sliding-window counters in Redis), and TF-IDF indexing all build on frequency counting.

---

## 15. Revision Notes

### 5-Minute Revision
- Tally with a hash map / fixed array; read answers in O(1).
- Two collections equal ⇔ frequency maps equal.
- Fused +1/−1 single pass compares two inputs.
- Fixed alphabet ⇒ array ⇒ O(1) space.

### 15-Minute Revision
- Recognize via "anagram / count / duplicate / how many".
- Brute O(n²) compare → count both → fuse into one pass.
- Watch length check, indexing base, Unicode, zero-cleanup.
- Extensions: Group Anagrams (signature key), Top-K (count+heap), windows (anagram window).
- Production: Map-Reduce counts, sketches for high cardinality.

### One-Page Cheat Sheet
```
WHEN: order-independent equality / counts / duplicates / anagrams
HOW:  freq[x]++ over input; query in O(1)
SPACE: array for dense small domain, map otherwise
TRICK: +1 for A and -1 for B in one loop -> all zero means equal
TRAPS: length check, index base, Unicode, clean zeros
NEXT:  HashMap Lookup, Anagram Window, Top-K Elements
```

---

**Related patterns:** [[02-hashmap-lookup]] · [[17-anagram-window]] · [[43-top-k-elements]]
