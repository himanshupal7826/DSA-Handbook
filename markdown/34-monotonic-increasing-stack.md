# 34 · Monotonic Increasing Stack

> **One-liner:** Maintain an increasing stack to find nearest smaller elements.

---

## 1. Overview

### Definition
The **Monotonic Increasing Stack** pattern belongs to the *Stacks* family. Maintain an increasing stack to find nearest smaller elements.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
monotonic stack, increasing, previous smaller, next smaller.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Increasing Stack optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Monotonic Increasing Stack invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Increasing Stack is the upgrade.
- The wording maps onto: monotonic stack, increasing, previous smaller, next smaller.

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
Redundant recomputation; does not exploit the structure the Monotonic Increasing Stack pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Monotonic Increasing Stack invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-34" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Increasing stack: pop while top &gt; incoming (nearest smaller)</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">scan array →</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="244" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">3</text>
  <text x="244" y="122" text-anchor="middle" fill="#059669" font-weight="700">incoming</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (bottom → top)</text>
  <rect x="452" y="150" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="490" y="172" text-anchor="middle" fill="#1e293b">1  keep</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">5  pop</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">6  pop</text>
  <line x1="270" y1="82" x2="448" y2="90" stroke="#475569" marker-end="url(#ar-34)"/>
  <text x="360" y="76" text-anchor="middle" fill="#d97706">3 &lt; 6 and 3 &lt; 5 → pop</text>
  <text x="490" y="214" text-anchor="middle" fill="#059669" font-weight="700">then push 3 → stack [1, 3]</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Monotonic Increasi: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Monotonic Increasing Stack problem. I'll a stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element. That brings the complexity down to O(n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Monotonic Increasing Stack (Optimal) |
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

### Problem — Daily Temps (LeetCode 739)
A representative **Monotonic Increasing Stack** problem. The signal: maintain an increasing stack to find nearest smaller elements.

### Thought Process
1. We want, for each day, how many days until a warmer temperature — i.e. the distance to the next greater element.
2. Keep a stack of indices whose warmer day hasn't been found yet, with temperatures kept monotonically decreasing (top is the coldest pending day).
3. For each new day, pop every pending index whose temperature is strictly less than today's; today is their answer, so record `i - popped_index`.
4. Push the current index. Any indices left on the stack at the end keep their default answer of 0.

### Dry Run
Input `[73, 74, 75, 71, 69, 72]`:
```
i=0 t=73  stack=[]        -> push 0            stack=[0]
i=1 t=74  74>73 pop 0 ans[0]=1-0=1             stack=[1]
i=2 t=75  75>74 pop 1 ans[1]=2-1=1             stack=[2]
i=3 t=71  71<75 push 3                         stack=[2,3]
i=4 t=69  69<71 push 4                         stack=[2,3,4]
i=5 t=72  pop 4 ans[4]=1, pop 3 ans[3]=2       stack=[2,5]
end -> index 2 & 5 unresolved, ans stays 0
```
Result `[1, 1, 4, 2, 1, 0]`.

### Visualization
```
input  ──▶ [ apply Monotonic Increasing Stack step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def dailyTemperatures(temperatures):
    res = [0] * len(temperatures)
    stack = []                          # indices, temps decreasing
    for i, t in enumerate(temperatures):
        while stack and temperatures[stack[-1]] < t:
            j = stack.pop()
            res[j] = i - j
        stack.append(i)
    return res
```

### Complexity
Time O(n), Space O(n). Each index is pushed and popped at most once.

## 10. Solved Example 2

### Problem — Next Greater (LeetCode 496)
A representative **Monotonic Increasing Stack** problem. The signal: maintain an increasing stack to find nearest smaller elements.

### Thought Process
1. `nums1` is a subset of `nums2`; for each value we need its next greater element to the right within `nums2`.
2. Sweep `nums2` once with a decreasing stack of values whose next-greater is still unknown.
3. When the current value exceeds the stack top, it is that top's next greater — pop and record it in a hash map `value -> next greater`.
4. Finally map each element of `nums1` through the dictionary, defaulting to -1.

### Dry Run
`nums2 = [1, 3, 4, 2]`, `nums1 = [4, 1, 2]`:
```
v=1  stack=[]        push 1        stack=[1]
v=3  3>1 pop1 nge[1]=3, push3      stack=[3]
v=4  4>3 pop3 nge[3]=4, push4      stack=[4]
v=2  2<4 push2                     stack=[4,2]
end -> nge={1:3, 3:4}
map nums1: 4->-1, 1->3, 2->-1
```
Result `[-1, 3, -1]`.

### Visualization
```
input  ──▶ [ apply Monotonic Increasing Stack step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def nextGreaterElement(nums1, nums2):
    nge = {}
    stack = []                          # values, decreasing
    for v in nums2:
        while stack and stack[-1] < v:
            nge[stack.pop()] = v
        stack.append(v)
    return [nge.get(v, -1) for v in nums1]
```

### Complexity
Time O(n + m), Space O(n) for the stack and map (n = len(nums2), m = len(nums1)).

## 11. Solved Example 3

### Problem — Largest Rectangle (LeetCode 84)
A representative **Monotonic Increasing Stack** problem. The signal: maintain an increasing stack to find nearest smaller elements.

### Thought Process
1. Each bar defines a maximal rectangle whose height is that bar; its width spans until a strictly shorter bar on each side.
2. Keep a stack of indices with heights in increasing order. When a bar shorter than the stack top arrives, the top's rectangle can be closed.
3. On popping index `top`, its height is `heights[top]` and its width is bounded left by the new stack top and right by the current index `i`, giving width `i - stack[-1] - 1` (or `i` if the stack is empty).
4. Append a sentinel height 0 at the end to flush all remaining bars.

### Dry Run
Input `[2, 1, 5, 6, 2]` (append sentinel 0):
```
i=0 h=2  push0                       stack=[0]
i=1 h=1  1<2 pop0 area=2*1=2          stack=[1]  push1
i=2 h=5  push2                        stack=[1,2]
i=3 h=6  push3                        stack=[1,2,3]
i=4 h=2  2<6 pop3 area=6*(4-2-1)=6
         2<5 pop2 area=5*(4-1-1)=10   best=10  push4
i=5 h=0  pop4 area=2*(5-1-1)=6, pop1 area=1*5=5
```
Best area `10`.

### Visualization
```
input  ──▶ [ apply Monotonic Increasing Stack step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def largestRectangleArea(heights):
    stack = []                          # indices, heights increasing
    best = 0
    for i, h in enumerate(heights + [0]):
        while stack and heights[stack[-1]] >= h:
            height = heights[stack.pop()]
            width = i - stack[-1] - 1 if stack else i
            best = max(best, height * width)
        stack.append(i)
    return best
```

### Complexity
Time O(n), Space O(n). Each bar is pushed and popped exactly once.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 739 | Daily Temps | Easy | Core stacks application |
| 496 | Next Greater | Easy | Core stacks application |
| 84 | Largest Rectangle | Medium | Core stacks application |
| 901 | Stock Span | Medium | Core stacks application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Increasing Stack logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Increasing Stack (Stacks).
- **Signal:** monotonic stack, increasing, previous smaller, next smaller.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Increasing Stack invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Increasing Stack
FAMILY : Stacks (Intermediate)
WHEN   : monotonic stack, increasing, previous smaller, next smaller
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 739, 496, 84, 901
```

---

*Part of the DSA Patterns Handbook — pattern 34 of 100.*
