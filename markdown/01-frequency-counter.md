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

**Problem framing:** Are two strings `s` and `t` anagrams?

### Intuition
Sort both and compare, or for each character in `s` scan `t` to find and remove a match.

### Algorithm
1. For each char in `s`, linearly search `t` for it.
2. Mark matched positions so they aren't reused.
3. If every char matches and lengths are equal → anagram.

### Complexity
- Time: **O(n²)** (search-and-mark) or **O(n log n)** (sort-and-compare).
- Space: O(1) or O(n) depending on sort.

### Drawbacks
- The nested search is quadratic and dies on large inputs.
- Sorting throws away the linear-time opportunity and mutates/copies data.

---

## 4. Optimal Approach

### Core idea
Build **one** frequency map for `s` (increment), then **decrement** while scanning `t`. If any count goes negative or a key is missing, they differ. Equal lengths + all-zero counts ⇒ anagram.

### Optimization journey
1. *Sort both* → O(n log n).
2. *Count s, count t, compare maps* → O(n) time, O(k) space (k = alphabet).
3. *Single map, +1 for s and −1 for t* → still O(n), but one map and an early exit.

### Visual explanation

```
s = "anagram"        t = "nagaram"
count(s): a:3 n:1 g:1 r:1 m:1
scan t:   n-- a-- g-- a-- r-- a-- m--
final:    a:0 n:0 g:0 r:0 m:0   → all zero → ANAGRAM ✅
```

### Interview explanation
"I'll tally `s` into a frequency array of size 26 since it's lowercase English. Then I walk `t`, decrementing. If a count drops below zero, `t` has a character `s` doesn't have enough of — return false immediately. Equal lengths guarantee the converse, so an all-zero array means they're anagrams. Two linear passes, O(n) time, O(1) space."

---

## 5. Generic Templates

> The four implementations below share one skeleton — switch language tabs to compare. Each is production-quality with detailed comments.

```go
// CountFrequencies returns a map of element -> occurrences. O(n) time, O(k) space.
func CountFrequencies[T comparable](xs []T) map[T]int {
    freq := make(map[T]int, len(xs))
    for _, x := range xs {
        freq[x]++ // zero value is 0, so this is safe
    }
    return freq
}

// IsAnagram uses a fixed 26-slot array (lowercase English) for O(1) space.
func IsAnagram(s, t string) bool {
    if len(s) != len(t) {
        return false
    }
    var count [26]int
    for i := 0; i < len(s); i++ {
        count[s[i]-'a']++
        count[t[i]-'a']-- // process both strings in one loop
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
    """Return a Counter mapping element -> occurrences. O(n)."""
    return Counter(xs)

def is_anagram(s: str, t: str) -> bool:
    """Two strings are anagrams iff their multisets of chars match."""
    if len(s) != len(t):
        return False
    count = {}
    for ch in s:
        count[ch] = count.get(ch, 0) + 1
    for ch in t:
        if ch not in count:        # char in t not present in s
            return False
        count[ch] -= 1
        if count[ch] == 0:
            del count[ch]          # keep the map clean
    return len(count) == 0
```

```java
import java.util.*;

public class FrequencyCounter {
    // Generic counter for any object type.
    public static <T> Map<T, Integer> countFrequencies(List<T> xs) {
        Map<T, Integer> freq = new HashMap<>();
        for (T x : xs) freq.merge(x, 1, Integer::sum);
        return freq;
    }

    // Fixed-array anagram check, O(n) time, O(1) space.
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

// Generic frequency map.
template <typename T>
unordered_map<T, int> countFrequencies(const vector<T>& xs) {
    unordered_map<T, int> freq;
    freq.reserve(xs.size());
    for (const auto& x : xs) ++freq[x];
    return freq;
}

// Fixed-array anagram check.
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
Given `s` and `t`, return true if `t` is an anagram of `s`.

### Thought Process
Lengths must match. A fixed 26-array fused over both strings gives O(n)/O(1).

### Dry Run
`s="rat", t="car"` → count: r:1−? Let's tally: from s `r+,a+,t+`; from t `c+? no` … fused: index r:+1 then c:−1 → array has +1 at r/a/t and −1 at c/a/r ⇒ r:0, a:0, t:+1, c:−1 → not all zero → **false**.

### Visualization

| char | a | c | r | t |
|------|---|---|---|---|
| net  | 0 | -1| 0 | +1|

Non-zero entries ⇒ not an anagram.

### Code

```python
def isAnagram(s, t):
    if len(s) != len(t): return False
    cnt = [0]*26
    for a, b in zip(s, t):
        cnt[ord(a)-97] += 1
        cnt[ord(b)-97] -= 1
    return all(c == 0 for c in cnt)
```

### Complexity
O(n) time, O(1) space.

---

## 10. Solved Example 2

### Problem — Group Anagrams (LeetCode 49)
Group words that are anagrams of each other.

### Thought Process
Anagrams share the same frequency signature. Use a 26-length count tuple as the map key — cheaper than sorting for long words.

### Dry Run
`["eat","tea","tan"]`
- "eat" → key (a1,e1,t1) → bucket A
- "tea" → same key → bucket A
- "tan" → key (a1,n1,t1) → bucket B
Result: `[["eat","tea"],["tan"]]`.

### Visualization
```
key (1,0,...,1,...,1)  -> [eat, tea]
key (1,...,n,...,t)    -> [tan]
```

### Code

```python
from collections import defaultdict
def groupAnagrams(words):
    groups = defaultdict(list)
    for w in words:
        key = [0]*26
        for ch in w: key[ord(ch)-97] += 1
        groups[tuple(key)].append(w)
    return list(groups.values())
```

### Complexity
O(N·L) time (N words, L max length), O(N·L) space.

---

## 11. Solved Example 3

### Problem — First Unique Character (LeetCode 387)
Return the index of the first non-repeating character, or −1.

### Thought Process
Count all chars, then scan left-to-right for the first with count 1. Two passes.

### Dry Run
`"leetcode"` → counts: l1 e3 t1 c1 o1 d1 → scan: l has count 1 → index **0**.

### Visualization

| char | l | e | t | c | o | d |
|------|---|---|---|---|---|---|
| cnt  | 1 | 3 | 1 | 1 | 1 | 1 |

### Code

```python
from collections import Counter
def firstUniqChar(s):
    cnt = Counter(s)
    for i, ch in enumerate(s):
        if cnt[ch] == 1:
            return i
    return -1
```

### Complexity
O(n) time, O(1) space (fixed alphabet).

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
