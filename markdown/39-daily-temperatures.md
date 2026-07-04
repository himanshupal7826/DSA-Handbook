# 39 · Daily Temperatures Pattern

> **One-liner:** Stack of unresolved indices to compute 'days until' answers.

---

## 1. Overview

### Definition
The **Daily Temperatures Pattern** pattern belongs to the *Stacks* family. Stack of unresolved indices to compute 'days until' answers.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
daily temperatures, wait days, next warmer, monotonic stack, distance.

### Constraints
- Input size where the brute-force complexity would time out — the Daily Temperatures Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Daily Temperatures Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Daily Temperatures Pattern is the upgrade.
- The wording maps onto: daily temperatures, wait days, next warmer, monotonic stack, distance.

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
Redundant recomputation; does not exploit the structure the Daily Temperatures Pattern pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Daily Temperatures Pattern invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-39" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Daily temperatures: days until a warmer day</text>
  <path d="M148,78 Q267,30 386,78" fill="none" stroke="#475569" stroke-dasharray="5 4" marker-end="url(#ar-39)"/>
  <text x="267" y="44" text-anchor="middle" fill="#059669" font-weight="700">4 days until warmer</text>
  <text x="60" y="70" text-anchor="middle" fill="#64748b">temps</text>
  <rect x="30"  y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="106" text-anchor="middle" fill="#1e293b">73</text>
  <rect x="78"  y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="106" text-anchor="middle" fill="#1e293b">74</text>
  <rect x="126" y="78" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="148" y="106" text-anchor="middle" fill="#1e293b" font-weight="700">75</text>
  <rect x="174" y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="106" text-anchor="middle" fill="#1e293b">71</text>
  <rect x="222" y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="106" text-anchor="middle" fill="#1e293b">69</text>
  <rect x="270" y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="292" y="106" text-anchor="middle" fill="#1e293b">72</text>
  <rect x="318" y="78" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="340" y="106" text-anchor="middle" fill="#1e293b" font-weight="700">76</text>
  <rect x="366" y="78" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="388" y="106" text-anchor="middle" fill="#1e293b">73</text>
  <text x="60" y="170" text-anchor="middle" fill="#64748b">answer</text>
  <rect x="30"  y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="78"  y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="126" y="150" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="176" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <rect x="174" y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="176" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="222" y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="270" y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="292" y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="318" y="150" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="340" y="176" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="366" y="150" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="388" y="176" text-anchor="middle" fill="#1e293b">0</text>
  <text x="530" y="120" text-anchor="middle" fill="#64748b">stack holds indices</text>
  <text x="530" y="138" text-anchor="middle" fill="#64748b">still waiting for a</text>
  <text x="530" y="156" text-anchor="middle" fill="#64748b">warmer day; a warmer</text>
  <text x="530" y="174" text-anchor="middle" fill="#64748b">temp pops and dates them</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Daily Temperatures: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Daily Temperatures Pattern problem. I'll a stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element. That brings the complexity down to O(n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Daily Temperatures Pattern (Optimal) |
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
A representative **Daily Temperatures Pattern** problem. The signal: stack of unresolved indices to compute 'days until' answers.

### Thought Process
1. Confirm the pattern via its recognition signals (daily temperatures, wait days, next warmer, monotonic stack, distance).
2. Reach for the Daily Temperatures Pattern template below and map the problem's entities onto it.
3. A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Daily Temperatures Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(n). Each index pushed/popped once; stack holds unresolved indices.

## 10. Solved Example 2

### Problem — Next Greater (LeetCode 496)
A representative **Daily Temperatures Pattern** problem. The signal: stack of unresolved indices to compute 'days until' answers.

### Thought Process
1. Confirm the pattern via its recognition signals (daily temperatures, wait days, next warmer, monotonic stack, distance).
2. Reach for the Daily Temperatures Pattern template below and map the problem's entities onto it.
3. A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Daily Temperatures Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(n). Each index pushed/popped once; stack holds unresolved indices.

## 11. Solved Example 3

### Problem — Stock Span (LeetCode 901)
A representative **Daily Temperatures Pattern** problem. The signal: stack of unresolved indices to compute 'days until' answers.

### Thought Process
1. Confirm the pattern via its recognition signals (daily temperatures, wait days, next warmer, monotonic stack, distance).
2. Reach for the Daily Temperatures Pattern template below and map the problem's entities onto it.
3. A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Daily Temperatures Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(n). Each index pushed/popped once; stack holds unresolved indices.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 739 | Daily Temps | Easy | Core stacks application |
| 496 | Next Greater | Easy | Core stacks application |
| 901 | Stock Span | Medium | Core stacks application |
| 2104 | Subarray Ranges | Medium | Core stacks application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Daily Temperatures Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Daily Temperatures Pattern (Stacks).
- **Signal:** daily temperatures, wait days, next warmer, monotonic stack, distance.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Daily Temperatures Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Daily Temperatures Pattern
FAMILY : Stacks (Intermediate)
WHEN   : daily temperatures, wait days, next warmer, monotonic stack, distance
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 739, 496, 901, 2104
```

---

*Part of the DSA Patterns Handbook — pattern 39 of 100.*
