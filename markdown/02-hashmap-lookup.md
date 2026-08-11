# 02 · Hash Map Lookup

> **One-liner:** Trade space for time: store seen values for O(1) existence/complement checks.

---

## 1. Overview

### Definition
The **Hash Map Lookup** pattern belongs to the *Foundations* family. Trade space for time: store seen values for O(1) existence/complement checks.

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
hashmap, lookup, complement, seen, cache, O(1), dictionary.

### Constraints
- Input size where the brute-force complexity would time out — the Hash Map Lookup optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Hash Map Lookup invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Hash Map Lookup is the upgrade.
- The wording maps onto: hashmap, lookup, complement, seen, cache, O(1), dictionary.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Have I already seen the thing I need?"*

Running example: given `nums` and a `target`, find two indices whose values add up to `target`.

### Intuition
With no memory of what we've already looked at, the only option is to try every pair: fix one element, then walk the rest of the array hoping to find its partner.

### Algorithm
1. For each index `i` from `0` to `n−1`:
2. &nbsp;&nbsp;For each index `j` from `i+1` to `n−1`:
3. &nbsp;&nbsp;&nbsp;&nbsp;If `nums[i] + nums[j] == target`, return `[i, j]`.
4. If the loops finish, no pair exists.

### Complexity
- Time: **O(n²)** — roughly `n²/2` pairs are tested.
- Space: O(1).

### Drawbacks
- The inner loop re-walks the same suffix over and over. For `n = 10⁵` that's ~5·10⁹ comparisons — far too slow.
- Notice what the inner loop actually *does*: it asks a yes/no question — *"is the value `target − nums[i]` somewhere in this array?"* Scanning is a very expensive way to ask that.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Remember what you've seen in a hash map, so "have I seen X?" costs O(1) instead of a scan.**

The brute force never had a memory. Every time it needed to know whether some value existed, it went and looked. A hash map *is* that memory: you pay O(n) space once, and every "does this exist / where was it / how many times" question becomes a single lookup.

### The thought process

```text
We need    : two numbers that add to target.
Obvious way: test every pair.
Too slow   : O(n²), because finding the partner means scanning.
Notice     : once we fix nums[i], the partner is not a mystery —
             it is exactly target - nums[i]. One specific value.
Therefore  : we don't need to search. We need to LOOK UP.
Now        : keep a map value → index of everything seen so far,
             and check for the partner before moving on. One pass.
```

That shift — from *"search for something that fits"* to *"compute exactly what I need, then look it up"* — is the whole pattern.

### Why we need a hash map

A hash map turns a value into a storage location by hashing it. It doesn't compare against the other keys, so lookup time doesn't grow with the number of entries: O(1) average for insert, lookup, and delete.

Pick the right flavour:

| You need to know… | Use |
|---|---|
| "have I seen this value?" | `set` |
| "where did I see it?" | `map[value]index` |
| "how many times?" | `map[value]count` |
| "which things belong together?" | `map[signature][]item` |

### Steps (Two Sum)

```text
Step 1 → Create an empty map: value → index.
Step 2 → Walk the array once with index i.
Step 3 → Compute need = target - nums[i].
Step 4 → If need is already in the map, we're done: return [map[need], i].
Step 5 → Otherwise record map[nums[i]] = i and move on.
```

### Why we check *before* we insert

This is the subtle part, and it is what makes one pass correct.

Checking first guarantees the partner we find is at a **strictly earlier index**, so we never pair an element with itself. Consider `nums = [3, 2, 4]`, `target = 6`:

- If we inserted first, then at `i = 0` the map would already hold `{3: 0}`, `need = 3` would be found, and we'd wrongly return `[0, 0]`.
- Checking first, `i = 0` finds nothing, stores `{3: 0}`; the real answer `[1, 2]` is found later.

The same "check the past, then join the past" order is why one pass suffices: every pair `(i, j)` with `i < j` gets considered exactly once — at the moment we reach `j`.

### How should I recognize this?

```text
If you see...
  "find two/three things that satisfy a relation"
  "does X exist", "contains duplicate", "seen before"
  "group these by something", "count occurrences of"
  and your first instinct is a nested loop
        ↓
Think about...
  "For a fixed element, is the thing I'm hunting for
   actually a single computable value?"
        ↓
Use...
  a hash map / set holding what you've already processed,
  and query it in O(1) instead of scanning.
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="hm-02" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Two Sum, target = 9: for each x, look up complement 9 − x</text>
  <!-- array with indices -->
  <g>
    <text x="93"  y="56" text-anchor="middle" fill="#64748b">i=0</text><rect x="65"  y="62" width="56" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="93"  y="90" text-anchor="middle" fill="#1e293b">2</text>
    <text x="163" y="56" text-anchor="middle" fill="#64748b">i=1</text><rect x="135" y="62" width="56" height="46" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="163" y="90" text-anchor="middle" fill="#1e293b">7</text>
    <text x="233" y="56" text-anchor="middle" fill="#64748b">i=2</text><rect x="205" y="62" width="56" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="233" y="90" text-anchor="middle" fill="#1e293b">11</text>
    <text x="303" y="56" text-anchor="middle" fill="#64748b">i=3</text><rect x="275" y="62" width="56" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="303" y="90" text-anchor="middle" fill="#1e293b">15</text>
  </g>
  <text x="163" y="128" text-anchor="middle" fill="#d97706" font-weight="700">current x = 7</text>
  <!-- seen map -->
  <text x="430" y="56" text-anchor="middle" fill="#64748b">seen{ value : index }</text>
  <rect x="380" y="62" width="100" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="430" y="90" text-anchor="middle" fill="#1e293b">2 : 0</text>
  <line x1="163" y1="150" x2="163" y2="176" stroke="#475569" marker-end="url(#hm-02)"/>
  <text x="320" y="170" text-anchor="middle" fill="#64748b">complement = 9 − 7 = 2, is 2 in seen?</text>
  <text x="320" y="200" text-anchor="middle" fill="#059669" font-weight="700">yes → found at index 0 → answer (0, 1)</text>
</svg>
```

```text
nums = [2, 7, 11, 15]   target = 9

i=0  x=2   need 9-2=7   map {}          → 7 not there   → store {2:0}
i=1  x=7   need 9-7=2   map {2:0}       → 2 FOUND at 0  → answer [0, 1]
```

### Interview explanation
"The brute force is O(n²) because finding the partner requires a scan. But the partner isn't unknown — for element `x` it's exactly `target − x`. So I'll keep a hash map of `value → index` for everything I've already passed, and at each element check whether its complement is in the map before inserting it. Checking before inserting guarantees the match is at an earlier index. One pass, O(n) time, O(n) space."

---

## 5. Generic Templates

> Three shapes cover almost every hash-map problem: **seen-set**, **complement lookup**, and **group-by-signature**.

```go
// 1. Seen-set: "have I encountered this before?"
func hasDuplicate(nums []int) bool {
    seen := make(map[int]struct{}, len(nums)) // struct{} costs no memory
    for _, x := range nums {
        if _, ok := seen[x]; ok {
            return true
        }
        seen[x] = struct{}{}
    }
    return false
}

// 2. Complement lookup: check the map BEFORE inserting.
func twoSum(nums []int, target int) []int {
    seen := make(map[int]int, len(nums)) // value -> index
    for i, x := range nums {
        if j, ok := seen[target-x]; ok {
            return []int{j, i}
        }
        seen[x] = i
    }
    return nil
}

// 3. Group-by-signature: bucket items under a key they share.
func groupBy(words []string, signature func(string) string) [][]string {
    groups := make(map[string][]string)
    for _, w := range words {
        key := signature(w)
        groups[key] = append(groups[key], w)
    }
    out := make([][]string, 0, len(groups))
    for _, bucket := range groups {
        out = append(out, bucket)
    }
    return out
}
```

```python
from collections import defaultdict

# 1. Seen-set
def has_duplicate(nums):
    seen = set()
    for x in nums:
        if x in seen:
            return True
        seen.add(x)
    return False

# 2. Complement lookup: check before insert
def two_sum(nums, target):
    seen = {}                        # value -> index
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
    return []

# 3. Group-by-signature
def group_by(items, signature):
    groups = defaultdict(list)
    for it in items:
        groups[signature(it)].append(it)
    return list(groups.values())
```

```java
import java.util.*;

public class HashMapLookup {
    // 1. Seen-set
    public static boolean hasDuplicate(int[] nums) {
        Set<Integer> seen = new HashSet<>();
        for (int x : nums) if (!seen.add(x)) return true;  // add returns false if present
        return false;
    }

    // 2. Complement lookup: check before insert
    public static int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();      // value -> index
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get(target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put(nums[i], i);
        }
        return new int[]{};
    }

    // 3. Group-by-signature
    public static List<List<String>> groupBy(String[] words,
                                             java.util.function.Function<String, String> signature) {
        Map<String, List<String>> groups = new HashMap<>();
        for (String w : words) groups.computeIfAbsent(signature.apply(w), k -> new ArrayList<>()).add(w);
        return new ArrayList<>(groups.values());
    }
}
```

```cpp
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <string>
#include <functional>
using namespace std;

// 1. Seen-set
bool hasDuplicate(const vector<int>& nums) {
    unordered_set<int> seen;
    seen.reserve(nums.size());
    for (int x : nums) if (!seen.insert(x).second) return true;
    return false;
}

// 2. Complement lookup: check before insert
vector<int> twoSum(const vector<int>& nums, int target) {
    unordered_map<int, int> seen;                 // value -> index
    for (int i = 0; i < (int)nums.size(); ++i) {
        auto it = seen.find(target - nums[i]);
        if (it != seen.end()) return {it->second, i};
        seen[nums[i]] = i;
    }
    return {};
}

// 3. Group-by-signature
vector<vector<string>> groupBy(const vector<string>& words,
                               function<string(const string&)> signature) {
    unordered_map<string, vector<string>> groups;
    for (const auto& w : words) groups[signature(w)].push_back(w);
    vector<vector<string>> out;
    out.reserve(groups.size());
    for (auto& kv : groups) out.push_back(move(kv.second));
    return out;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Hash Map Lookup (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> One pass to build, O(1) per query.

---

## 7. Common Mistakes

1. Off-by-one in prefix arrays (use size n+1 and 1-based prefix indices).
2. Rebuilding the auxiliary structure inside a loop instead of once.
3. Integer overflow on large sums — use 64-bit accumulators.
4. Forgetting that hashing has worst-case O(n) collisions (rare but real).
5. Choosing a map when a fixed-size array would be faster and O(1) space.
6. Mutating the input array when the caller still needs it.
7. Not handling empty input / single-element edge cases.
8. Confusing inclusive vs exclusive range boundaries.
9. Assuming hash-map iteration order is stable.
10. Ignoring negative numbers when reasoning about monotonic prefix sums.

---

## 8. Interview Follow-Up Questions

1. **Q: Why O(n) instead of O(n^2)?**
   A: Each element is touched a constant number of times; queries become O(1) reads.

2. **Q: Array vs hash map?**
   A: Array for small dense key domains; map for sparse/large/arbitrary keys.

3. **Q: How to make it O(1) extra space?**
   A: Sometimes you can accumulate on the fly without storing the whole prefix.

4. **Q: Handle updates between queries?**
   A: Switch to a Fenwick/Segment tree for O(log n) updates.

5. **Q: 2D version?**
   A: Use a 2D prefix-sum matrix; submatrix sum in O(1).

6. **Q: Streaming input?**
   A: Maintain running aggregates; use sketches for high cardinality.

7. **Q: Parallelize?**
   A: Counting/summing is associative — Map-Reduce by key.

8. **Q: Negative numbers break a technique?**
   A: Sliding-window-by-sum needs non-negativity; prefix+hashmap handles negatives.

9. **Q: Overflow risk?**
   A: Use wider integer types or modular arithmetic if required.

10. **Q: Memory pressure?**
   A: Compress keys or use approximate structures (Count-Min Sketch).

11. **Q: Detect duplicates fast?**
   A: A hash set gives O(1) membership.

12. **Q: Most frequent element?**
   A: Count then take the max value, or a heap for top-k.

13. **Q: Pivot/equilibrium index?**
   A: Compare left prefix to total minus prefix.

14. **Q: Why does prefix subtraction work?**
   A: Sums telescope: pre[r+1]-pre[l] = sum of [l..r].

15. **Q: Relation to difference arrays?**
   A: Difference array is the inverse: it supports range updates, prefix supports range queries.

---

## 9. Solved Example 1

### Problem — Two Sum (LeetCode 1)
Return the indices of the two numbers that add up to `target`. Exactly one solution exists, and you may not use the same element twice.

### Thought Process
1. For a fixed `nums[i]`, the partner is not vague — it is exactly `target − nums[i]`.
2. So the real question is "does that specific value already exist?", which a map answers in O(1).
3. Walk once, keeping `value → index` of everything already passed.
4. Check for the complement **before** inserting the current value — that keeps the match strictly earlier and stops an element pairing with itself.

### Dry Run

Input: `nums = [2, 7, 11, 15]`, `target = 9`

| i | nums[i] | need = 9 − nums[i] | need in map? | map before this step | action |
|---|---------|--------------------|--------------|----------------------|--------|
| 0 | 2       | 7                  | no           | `{}`                 | store `2 → 0` |
| 1 | 7       | 2                  | **yes → 0**  | `{2:0}`              | return `[0, 1]` |

Output: **`[0, 1]`** (since `nums[0] + nums[1] = 2 + 7 = 9`)

### Visualization

```text
nums:  [ 2 ,  7 , 11 , 15 ]
         ↑
       i=0  need 7 → map {} → miss, remember 2

nums:  [ 2 ,  7 , 11 , 15 ]
              ↑
       i=1  need 2 → map {2:0} → HIT at index 0  ⇒  [0, 1]
```

### Code

```go
func twoSum(nums []int, target int) []int {
    seen := make(map[int]int, len(nums)) // value -> index seen so far
    for i, x := range nums {
        if j, ok := seen[target-x]; ok { // check BEFORE inserting
            return []int{j, i}
        }
        seen[x] = i
    }
    return nil
}
```

```python
def twoSum(nums, target):
    seen = {}                            # value -> index
    for i, x in enumerate(nums):
        if target - x in seen:           # check BEFORE inserting
            return [seen[target - x], i]
        seen[x] = i
    return []
```

### Complexity
Time O(n) — one pass, O(1) lookups. Space O(n) — the map holds at most `n` entries.

---

## 10. Solved Example 2

### Problem — Contains Duplicate (LeetCode 217)
Return `true` if any value appears at least twice in `nums`.

### Thought Process
1. A duplicate exists exactly when some value shows up a second time as we scan.
2. We don't need positions or counts — only membership. That's a `set`.
3. For each element: if it's already in the set, we've found the repeat; otherwise add it.
4. Reaching the end with no hit means every value was distinct.

### Dry Run

Input: `nums = [1, 2, 3, 1]`

| step | x | already in set? | set after |
|------|---|-----------------|-----------|
| 1    | 1 | no              | `{1}`     |
| 2    | 2 | no              | `{1,2}`   |
| 3    | 3 | no              | `{1,2,3}` |
| 4    | 1 | **yes**         | → return `true` |

Output: **`true`**

For `nums = [1, 2, 3, 4]` the scan finishes with `{1,2,3,4}` and no hit → **`false`**.

### Visualization

```text
seen = { 1, 2, 3 }        x = 1
                            ↑
                    already present ⇒ true
```

### Code

```go
func containsDuplicate(nums []int) bool {
    seen := make(map[int]struct{}, len(nums))
    for _, x := range nums {
        if _, ok := seen[x]; ok {
            return true
        }
        seen[x] = struct{}{}
    }
    return false
}
```

```python
def containsDuplicate(nums):
    seen = set()
    for x in nums:
        if x in seen:
            return True
        seen.add(x)
    return False
```

### Complexity
Time O(n), Space O(n). Sorting first would also work in O(n log n) time and O(1) extra space — that's the trade-off to mention if the interviewer restricts memory.

---

## 11. Solved Example 3

### Problem — Group Anagrams (LeetCode 49)
Group the words that are anagrams of each other.

### Thought Process
1. Comparing every pair of words is O(N²).
2. Instead, reduce each word to a **signature** that is identical for anagrams and different otherwise.
3. Sorting a word's letters is the simplest such signature: `"eat"` and `"tea"` both become `"aet"`.
4. Use the signature as a map key; each bucket is one answer group.

### Dry Run

Input: `["eat", "tea", "tan"]`

| word  | sorted key | map after                          |
|-------|-----------|------------------------------------|
| "eat" | `"aet"`   | `{aet: [eat]}`                     |
| "tea" | `"aet"`   | `{aet: [eat, tea]}` ← joins bucket |
| "tan" | `"ant"`   | `{aet: [eat, tea], ant: [tan]}`    |

Output: `[["eat","tea"], ["tan"]]` (group order is not required to be stable)

### Visualization

```text
"eat" ──sort──▶ "aet" ─┐
                       ├─▶ bucket "aet" = [eat, tea]
"tea" ──sort──▶ "aet" ─┘

"tan" ──sort──▶ "ant" ───▶ bucket "ant" = [tan]
```

### Code

```go
func groupAnagramsSorted(strs []string) [][]string {
    groups := make(map[string][]string)
    for _, w := range strs {
        b := []byte(w)
        sort.Slice(b, func(i, j int) bool { return b[i] < b[j] })
        key := string(b) // anagrams share this key
        groups[key] = append(groups[key], w)
    }

    out := make([][]string, 0, len(groups))
    for _, bucket := range groups {
        out = append(out, bucket)
    }
    return out
}
```

```python
from collections import defaultdict

def groupAnagrams(strs):
    groups = defaultdict(list)
    for w in strs:
        key = "".join(sorted(w))   # anagrams share the sorted key
        groups[key].append(w)
    return list(groups.values())
```

### Complexity
Time O(N·L log L) for N words of max length L (the sort dominates). Space O(N·L).

> Counting letters into a 26-slot key instead of sorting drops this to O(N·L) — see the Frequency Counter chapter.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1 | Two Sum | Easy | Core foundations application |
| 217 | Contains Duplicate | Easy | Core foundations application |
| 49 | Group Anagrams | Medium | Core foundations application |
| 36 | Valid Sudoku | Medium | Core foundations application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Hash-map counting**
- **1D / 2D prefix sums**
- **Difference arrays (inverse)**
- **Prefix + hashmap for subarray sums**
- **Custom-comparator sorting**

---

## 14. Production Engineering Applications

- **Scalability:** Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Hash Map Lookup logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Hash Map Lookup (Foundations).
- **Signal:** hashmap, lookup, complement, seen, cache, O(1), dictionary.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Hash Map Lookup invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Hash Map Lookup
FAMILY : Foundations (Beginner)
WHEN   : hashmap, lookup, complement, seen, cache, O(1), dictionary
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 1, 217, 49, 36
```

---

*Part of the DSA Patterns Handbook — pattern 02 of 100.*
