# 36 · Next Greater Element

> **One-liner:** Stack scan to find each element's next strictly greater neighbor.

---

## 1. Overview

### Definition
The **Next Greater Element** pattern belongs to the *Stacks* family. Stack scan to find each element's next strictly greater neighbor.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
next greater, monotonic stack, circular, to the right.

### Constraints
- Input size where the brute-force complexity would time out — the Next Greater Element optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Next Greater Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Next Greater Element is the upgrade.
- The wording maps onto: next greater, monotonic stack, circular, to the right.

---

## 3. Brute Force Approach

### Intuition
For each element scan outward to find the next/previous greater or smaller — O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Next Greater Element pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Next Greater Element invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-36" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Next greater: incoming pops smaller tops and becomes their answer</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">nums (scan →)</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="196" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="88" text-anchor="middle" fill="#1e293b">3</text>
  <text x="196" y="122" text-anchor="middle" fill="#059669" font-weight="700">incoming 4</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (values)</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">2  pop</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">2  pop</text>
  <line x1="222" y1="82" x2="448" y2="90" stroke="#475569" marker-end="url(#ar-36)"/>
  <text x="350" y="150" text-anchor="middle" fill="#d97706">4 &gt; top → pop, answer[popped] = 4</text>
  <text x="130" y="186" text-anchor="middle" fill="#64748b">result (next greater)</text>
  <rect x="30"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="52"  y="222" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="78"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="100" y="222" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="126" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="222" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="174" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="222" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="222" text-anchor="middle" fill="#64748b">-1</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Next Greater Eleme: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Next Greater Element problem. I'll a stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element. That brings the complexity down to O(n) time and O(n) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Stacks** family template. Adapt the comparison/condition to the specific problem.

```go
// Next greater element to the right using a monotonic decreasing stack.
func nextGreater(nums []int) []int {
    res := make([]int, len(nums))
    for i := range res { res[i] = -1 }
    stack := []int{} // indices, values decreasing from bottom to top
    for i, v := range nums {
        for len(stack) > 0 && nums[stack[len(stack)-1]] < v {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            res[top] = v
        }
        stack = append(stack, i)
    }
    return res
}
```

```python
def next_greater(nums):
    res = [-1] * len(nums)
    stack = []                      # indices, values decreasing
    for i, v in enumerate(nums):
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        stack.append(i)
    return res
```

```java
int[] nextGreater(int[] nums) {
    int[] res = new int[nums.length];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < nums.length; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i])
            res[stack.pop()] = nums[i];
        stack.push(i);
    }
    return res;
}
```

```cpp
vector<int> nextGreater(vector<int>& nums) {
    vector<int> res(nums.size(), -1);
    stack<int> st;                  // indices
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!st.empty() && nums[st.top()] < nums[i]) {
            res[st.top()] = nums[i]; st.pop();
        }
        st.push(i);
    }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Next Greater Element (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> Each index pushed/popped once; stack holds unresolved indices.

---

## 7. Common Mistakes

1. Storing values instead of indices when you need positions/distances.
2. Wrong monotonic direction (increasing vs decreasing) for the query.
3. Using `<` vs `<=` incorrectly with duplicates.
4. Forgetting to handle elements left on the stack at the end.
5. Not iterating in reverse when the problem is naturally right-to-left.
6. Circular array: forgetting to loop twice with modulo indexing.
7. Histogram: missing the sentinel zero-height bar to flush the stack.
8. Popping in the wrong order, corrupting results.
9. Mixing up 'greater' and 'smaller' semantics.
10. O(n^2) blowup by rescanning instead of trusting the stack invariant.

---

## 8. Interview Follow-Up Questions

1. **Q: Increasing vs decreasing stack — which?**
   A: Decreasing stack finds next greater; increasing finds next smaller.

2. **Q: Why amortized O(n)?**
   A: Each index is pushed once and popped at most once.

3. **Q: Previous greater element?**
   A: Same stack, but resolve as you push / scan the other direction.

4. **Q: Circular next greater?**
   A: Iterate 2n with modulo, don't push twice.

5. **Q: Largest rectangle in histogram?**
   A: Monotonic increasing stack of bar indices.

6. **Q: Daily temperatures?**
   A: Stack of unresolved days; pop when a warmer day arrives.

7. **Q: Stock span?**
   A: Previous greater index gives the span length.

8. **Q: Trapping rain water?**
   A: Stack or two-pointer; stack resolves bounded basins.

9. **Q: Handle ties?**
   A: Decide `<` vs `<=` based on whether equal counts as greater.

10. **Q: Space complexity?**
   A: O(n) worst case (monotonic input).

11. **Q: Maximal rectangle in matrix?**
   A: Histogram per row + stack.

12. **Q: Sum of subarray minimums?**
   A: Monotonic stack to count contribution of each element.

13. **Q: Why store indices?**
   A: To compute distances/widths between boundaries.

14. **Q: Sentinel trick?**
   A: Append a 0 (or +/-inf) to force final pops.

15. **Q: Relation to monotonic queue?**
   A: Queue variant supports sliding-window min/max.

---

## 9. Solved Example 1

### Problem — Next Greater I (LeetCode 496)
A representative **Next Greater Element** problem. The signal: stack scan to find each element's next strictly greater neighbor.

### Thought Process
1. Scan `nums2` with a decreasing monotonic stack; when the current value exceeds the stack top, it is that top's next greater element — record it in a hash map.
2. Any values still on the stack at the end have no greater element, so they default to -1.
3. Answer each query in `nums1` by a direct lookup in the map (nums1 is a subset of nums2).

### Dry Run
`nums1=[4,1,2]`, `nums2=[1,3,4,2]`.
- 1 pushed; 3>1 → map[1]=3, push 3; 4>3 → map[3]=4, push 4; 2<4 → push 2. Leftover 4,2 → -1.
- map={1:3, 3:4, 4:-1, 2:-1}.
- Lookups: 4→-1, 1→3, 2→-1 ⇒ `[-1, 3, -1]`.

### Visualization
```
input  ──▶ [ apply Next Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def nextGreaterElement(nums1, nums2):
    next_greater = {}
    stack = []                      # values, decreasing
    for v in nums2:
        while stack and stack[-1] < v:
            next_greater[stack.pop()] = v
        stack.append(v)
    return [next_greater.get(v, -1) for v in nums1]
```

### Complexity
Time O(n + m), Space O(n) for the stack and map (n = len(nums2), m = len(nums1)).

## 10. Solved Example 2

### Problem — Next Greater II (LeetCode 503)
A representative **Next Greater Element** problem. The signal: stack scan to find each element's next strictly greater neighbor.

### Thought Process
1. The array is circular, so simulate two passes by iterating indices `0 .. 2n-1` and using `i % n` to wrap around.
2. Keep a decreasing monotonic stack of indices; when the current value beats the value at the stack top, that top's next greater element is found.
3. Only assign results during the first conceptual pass isn't needed — the modulo indexing lets later elements resolve earlier ones; leftovers stay -1.

### Dry Run
`nums=[1,2,1]`, n=3, loop i=0..5 (index = i % n).
- i=0 (1): push 0 → stack=[0]. i=1 (2): nums[0]=1<2 → res[0]=2, pop; push 1 → stack=[1].
- i=2 (1): 2<1? no; push 2 → stack=[1,2]. i=3 (1): no pop, i≥n so no push.
- i=4 (2): nums[2]=1<2 → res[2]=2, pop → stack=[1]. i=5 (1): no pop.
- Result `[2, -1, 2]`.

### Visualization
```
input  ──▶ [ apply Next Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def nextGreaterElements(nums):
    n = len(nums)
    res = [-1] * n
    stack = []                      # indices, values decreasing
    for i in range(2 * n):
        v = nums[i % n]
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        if i < n:
            stack.append(i)
    return res
```

### Complexity
Time O(n), Space O(n). Two passes over n elements; each index pushed/popped at most once.

## 11. Solved Example 3

### Problem — Next Greater III (LeetCode 556)
A representative **Next Greater Element** problem. The signal: stack scan to find each element's next strictly greater neighbor.

### Thought Process
1. This is the "next permutation" of `n`'s digits: scan from the right for the first index `i` where `d[i] < d[i+1]` (the pivot). If none exists the digits are descending — no greater permutation, return -1.
2. Scan from the right for the smallest digit greater than `d[i]` and swap it with `d[i]`.
3. Reverse the suffix after `i` to make it the smallest arrangement, then check the result fits in a 32-bit signed int (≤ 2^31 − 1).

### Dry Run
`n=12` → digits `[1,2]`.
- Pivot: rightmost `i` with `d[i]<d[i+1]` is i=0 (1<2).
- Swap d[0] with smallest larger digit to its right (2) → `[2,1]`.
- Reverse suffix after i=0 (single digit) → `21`; fits in 32-bit ⇒ answer **21**.

### Visualization
```
input  ──▶ [ apply Next Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def nextGreaterElement(n):
    d = list(str(n))
    i = len(d) - 2
    while i >= 0 and d[i] >= d[i + 1]:
        i -= 1
    if i < 0:
        return -1
    j = len(d) - 1
    while d[j] <= d[i]:
        j -= 1
    d[i], d[j] = d[j], d[i]
    d[i + 1:] = reversed(d[i + 1:])
    ans = int("".join(d))
    return ans if ans <= 2**31 - 1 else -1
```

### Complexity
Time O(k), Space O(k) where k is the number of digits in n.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 496 | Next Greater I | Easy | Core stacks application |
| 503 | Next Greater II | Easy | Core stacks application |
| 556 | Next Greater III | Medium | Core stacks application |
| 739 | Daily Temps | Medium | Core stacks application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic increasing stack**
- **Monotonic decreasing stack**
- **Next/previous greater**
- **Histogram largest rectangle**
- **Stock span / daily temperatures**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Next Greater Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Next Greater Element (Stacks).
- **Signal:** next greater, monotonic stack, circular, to the right.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Next Greater Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Next Greater Element
FAMILY : Stacks (Intermediate)
WHEN   : next greater, monotonic stack, circular, to the right
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 496, 503, 556, 739
```

---

*Part of the DSA Patterns Handbook — pattern 36 of 100.*
