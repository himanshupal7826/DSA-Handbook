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

**The question this pattern keeps answering:** *"For each element, how far do I have to look before I find something bigger?"*

### Intuition
For each day, scan forward until you find a warmer day.

### Algorithm
1. For each index `i`:
2. &nbsp;&nbsp;For `j` from `i+1` to `n−1`:
3. &nbsp;&nbsp;&nbsp;&nbsp;If `temperatures[j] > temperatures[i]`, record `j − i` and stop.
4. &nbsp;&nbsp;If nothing was found, record `0`.

### Complexity
- Time: **O(n²)** — a strictly decreasing array makes every scan run to the end.
- Space: O(1) beyond the output.

### Drawbacks
- On input like `[80, 79, 78, …]` every element scans the entire remaining array and finds nothing. That is the full quadratic cost, spent to learn nothing.
- The deeper waste: when day `j` turns out to be warmer than day `i`, it is very often warmer than several *other* pending days too — but the brute force rediscovers that fact once per day instead of settling them all at once.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep a stack of days still waiting for a warmer day. When a warm day arrives, it settles every waiting day it beats — all at once.**

Flip the question around. Instead of asking *"which future day answers day `i`?"* — which forces you to look forward — ask *"which past days does today answer?"* Today knows that immediately.

### The thought process

```text
We need    : for each element, the distance to the next greater one.
Obvious way: scan forward from every element.
Too slow   : O(n^2), worst on decreasing input.
Notice     : ask the reverse question. When today's value arrives,
             it is the answer for EVERY pending day it exceeds.
Notice too : those pending days are always in DECREASING order —
             if an earlier day were smaller, a later pending day
             would already have settled it.
Therefore  : keep a stack of unsettled indices, decreasing in value.
             A bigger arrival pops and settles them.
Now        : each index is pushed once and popped once → O(n).
```

### Why the stack is automatically decreasing

The stack holds exactly the indices **still waiting for an answer**. Ask whether a smaller value could ever sit below a larger one:

- Suppose index `a` (value 5) is below index `b` (value 9) on the stack.
- But `b` arrived *after* `a`, and `9 > 5` — so on arrival `b` would have popped `a` and settled it.

Contradiction. So the values only ever decrease from bottom to top. Nobody has to enforce this; it is a consequence of the pop rule.

### Steps

```text
Step 1 → answer = all zeros; empty stack of indices.
Step 2 → For i = 0 .. n-1:
Step 3 →     While the stack is non-empty and values[stack.top] < values[i]:
Step 4 →         j = pop
Step 5 →         answer[j] = i - j        ← distance, or values[i] for "which value"
Step 6 →     Push i.
Step 7 → Anything left on the stack never found a greater value → stays 0.
```

Note what the leftover stack means: those indices are the **suffix maxima**, the days no later day ever beat. Leaving their answers at `0` needs no extra code.

### Increasing or decreasing? Read the question

Chapter 38 used an *increasing* stack; this one uses a *decreasing* stack. The rule is mechanical:

| You want, for each element… | Pop while the stack top is… | Stack ends up |
|---|---|---|
| next **greater** element | **smaller** than the arrival | decreasing |
| next **smaller** element | **greater** than the arrival | increasing |

And the direction of travel decides which side you get:

| Traverse | You find |
|---|---|
| left → right | the **next** (right-side) greater/smaller |
| right → left | the **previous** (left-side) greater/smaller |

Four combinations, one template. Pick the comparison, pick the direction.

### Strict or non-strict?

If the problem says *"strictly warmer"*, pop on `stack.top < current`. If it says *"warmer or equal"* (or asks for a span "less than or equal to today"), pop on `stack.top <= current`. Equal values are the only inputs that distinguish them — and the only ones that break a solution using the wrong one.

### Circular arrays

For "next greater in a circular array", walk the array **twice** (`i` from `0` to `2n−1`, indexing with `i % n`) and only push during the first pass. The second pass answers anything that had to wrap around.

### How should I recognize this?

```text
If you see...
  "next greater / warmer / taller", "days until ...", "span"
  "previous smaller", "how long until it increases"
  a nested loop scanning forward for the first element beating this one
        ↓
Think about...
  "Instead of searching forward, can each arrival settle
   everything behind it that was waiting?"
        ↓
Use...
  next greater  → stack decreasing, pop while top < current
  next smaller  → stack increasing, pop while top > current
  previous ...  → same, but traverse right to left
```

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

```text
temperatures = [73, 74, 75, 71, 69, 72, 76, 73]

i=5 (value 72) arrives. Stack holds unsettled days, decreasing:

    stack (bottom → top):  [2]=75   [3]=71   [4]=69
                                       ↑        ↑
                              72 beats both — pop and settle:

    answer[4] = 5 - 4 = 1
    answer[3] = 5 - 3 = 2
    72 < 75 → stop; push 5

one arrival settled two pending days
```

### Interview explanation
"Scanning forward from every day is O(n²) and worst on a decreasing sequence. Instead I flip the question: when today's temperature arrives, it is the answer for every earlier day still waiting that it beats. So I keep a stack of unsettled indices, and today pops all of them whose value is smaller, writing `i − j` as each one's answer. The stack is automatically decreasing — a smaller value could never sit beneath a larger one, because the larger one would have popped it on arrival. Anything left on the stack at the end never found a warmer day, so its answer stays 0. Each index is pushed once and popped once, so it's O(n) time and O(n) space."

---

## 5. Generic Templates

> One template, four variants: pick the comparison (greater/smaller) and the direction (next/previous).

```go
// NextGreaterDistance returns, for each i, how many steps forward until a
// strictly greater value appears, or 0 if none does.
func NextGreaterDistance(values []int) []int {
    answer := make([]int, len(values)) // zeros are already the "none" answer
    stack := []int{}                   // indices, values decreasing top ← bottom

    for i, v := range values {
        // Today settles every pending day it beats.
        for len(stack) > 0 && values[stack[len(stack)-1]] < v {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            answer[j] = i - j
        }
        stack = append(stack, i)
    }
    return answer // indices left on the stack keep answer 0
}

// NextGreaterValue returns the next strictly greater value, or -1.
func NextGreaterValue(values []int) []int {
    answer := make([]int, len(values))
    for i := range answer {
        answer[i] = -1
    }
    stack := []int{}

    for i, v := range values {
        for len(stack) > 0 && values[stack[len(stack)-1]] < v {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            answer[j] = v
        }
        stack = append(stack, i)
    }
    return answer
}

// PreviousSmallerIndex: same idea, mirrored — traverse right to left and
// flip the comparison to get the nearest smaller element on the LEFT.
func PreviousSmallerIndex(values []int) []int {
    answer := make([]int, len(values))
    stack := []int{}

    for i := len(values) - 1; i >= 0; i-- {
        for len(stack) > 0 && values[stack[len(stack)-1]] > values[i] {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            answer[j] = i
        }
        stack = append(stack, i)
    }
    for len(stack) > 0 { // nothing smaller to the left
        answer[stack[len(stack)-1]] = -1
        stack = stack[:len(stack)-1]
    }
    return answer
}
```

```python
def next_greater_distance(values):
    """Steps forward until a strictly greater value, or 0 if none."""
    answer = [0] * len(values)         # 0 already means "none"
    stack = []                         # indices, values decreasing

    for i, v in enumerate(values):
        while stack and values[stack[-1]] < v:      # today settles them
            j = stack.pop()
            answer[j] = i - j
        stack.append(i)
    return answer

def next_greater_value(values):
    """The next strictly greater value, or -1."""
    answer = [-1] * len(values)
    stack = []
    for i, v in enumerate(values):
        while stack and values[stack[-1]] < v:
            answer[stack.pop()] = v
        stack.append(i)
    return answer

def previous_smaller_index(values):
    """Nearest smaller element on the LEFT: mirror the traversal."""
    answer = [-1] * len(values)
    stack = []
    for i in range(len(values) - 1, -1, -1):
        while stack and values[stack[-1]] > values[i]:
            answer[stack.pop()] = i
        stack.append(i)
    return answer
```

```java
import java.util.*;

public class DailyTemperaturesPattern {
    // Steps forward until a strictly greater value, or 0 if none.
    public static int[] nextGreaterDistance(int[] values) {
        int[] answer = new int[values.length];       // zeros mean "none"
        Deque<Integer> stack = new ArrayDeque<>();   // indices, values decreasing

        for (int i = 0; i < values.length; i++) {
            while (!stack.isEmpty() && values[stack.peek()] < values[i]) {
                int j = stack.pop();
                answer[j] = i - j;
            }
            stack.push(i);
        }
        return answer;
    }

    // The next strictly greater value, or -1.
    public static int[] nextGreaterValue(int[] values) {
        int[] answer = new int[values.length];
        Arrays.fill(answer, -1);
        Deque<Integer> stack = new ArrayDeque<>();

        for (int i = 0; i < values.length; i++) {
            while (!stack.isEmpty() && values[stack.peek()] < values[i])
                answer[stack.pop()] = values[i];
            stack.push(i);
        }
        return answer;
    }
}
```

```cpp
#include <vector>
using namespace std;

// Steps forward until a strictly greater value, or 0 if none.
vector<int> nextGreaterDistance(const vector<int>& values) {
    vector<int> answer(values.size(), 0);    // zeros mean "none"
    vector<int> stack;                       // indices, values decreasing

    for (int i = 0; i < (int)values.size(); ++i) {
        while (!stack.empty() && values[stack.back()] < values[i]) {
            int j = stack.back();
            stack.pop_back();
            answer[j] = i - j;
        }
        stack.push_back(i);
    }
    return answer;
}

// The next strictly greater value, or -1.
vector<int> nextGreaterValue(const vector<int>& values) {
    vector<int> answer(values.size(), -1);
    vector<int> stack;

    for (int i = 0; i < (int)values.size(); ++i) {
        while (!stack.empty() && values[stack.back()] < values[i]) {
            answer[stack.back()] = values[i];
            stack.pop_back();
        }
        stack.push_back(i);
    }
    return answer;
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

### Problem — Daily Temperatures (LeetCode 739)
For each day, return how many days you must wait for a warmer temperature. If none exists, use `0`.

### Thought Process
1. Scanning forward from each day is O(n²) and worst on a cooling streak.
2. Flip the question: when today arrives, it is the answer for every earlier day still waiting that it beats.
3. Keep a stack of unsettled indices. Today pops each one whose temperature is smaller and writes `i − j`.
4. The stack stays decreasing on its own — a cooler day could never sit beneath a warmer one, because the warmer one would have popped it.
5. Initialise the answer to zeros, so days left on the stack need no special handling.

### Dry Run

Input: `temperatures = [73, 74, 75, 71, 69, 72, 76, 73]`

| i | temp | pops (index → answer) | stack after (indices) | answer so far |
|---|------|-----------------------|-----------------------|---------------|
| 0 | 73 | — | `[0]` | `[0,0,0,0,0,0,0,0]` |
| 1 | 74 | pop 0 → `answer[0] = 1−0 = 1` | `[1]` | `[1,0,0,0,0,0,0,0]` |
| 2 | 75 | pop 1 → `answer[1] = 2−1 = 1` | `[2]` | `[1,1,0,0,0,0,0,0]` |
| 3 | 71 | — (`71 < 75`) | `[2,3]` | unchanged |
| 4 | 69 | — (`69 < 71`) | `[2,3,4]` | unchanged |
| 5 | 72 | pop 4 → `answer[4] = 5−4 = 1`<br>pop 3 → `answer[3] = 5−3 = 2`<br>stop (`72 < 75`) | `[2,5]` | `[1,1,0,2,1,0,0,0]` |
| 6 | 76 | pop 5 → `answer[5] = 6−5 = 1`<br>pop 2 → `answer[2] = 6−2 = 4`<br>stack empty | `[6]` | `[1,1,4,2,1,1,0,0]` |
| 7 | 73 | — (`73 < 76`) | `[6,7]` | unchanged |

Indices 6 and 7 remain on the stack — no warmer day ever came — so their answers stay `0`.

Output: **`[1, 1, 4, 2, 1, 1, 0, 0]`** ✓

Step `i = 5` is the payoff: one arrival settled **two** pending days. The brute force would have discovered the same fact twice.

### Visualization

```text
temps:  73  74  75  71  69  72  76  73
index:   0   1   2   3   4   5   6   7

at i=5 (72), the stack is [2]=75  [3]=71  [4]=69   ← decreasing
                                     ↑       ↑
                              72 beats both → settle both

  answer[4] = 1     answer[3] = 2
  72 < 75 → stop, push 5
```

### Code

```go
func dailyTemperatures(temperatures []int) []int {
    answer := make([]int, len(temperatures)) // zeros already mean "never warmer"
    stack := []int{}                         // indices still waiting, decreasing

    for i, temp := range temperatures {
        // Today is the answer for every warmer-than-it pending day.
        for len(stack) > 0 && temperatures[stack[len(stack)-1]] < temp {
            j := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            answer[j] = i - j
        }
        stack = append(stack, i)
    }
    return answer
}
```

```python
def dailyTemperatures(temperatures):
    answer = [0] * len(temperatures)     # zeros already mean "never warmer"
    stack = []                           # indices still waiting, decreasing

    for i, temp in enumerate(temperatures):
        while stack and temperatures[stack[-1]] < temp:
            j = stack.pop()
            answer[j] = i - j            # today settles this pending day
        stack.append(i)
    return answer
```

### Complexity
Time **O(n)** — each index is pushed once and popped at most once, so the inner loop is O(1) amortised. Space O(n) for the stack.

---

## 10. Solved Example 2

### Problem — Next Greater Element I (LeetCode 496)
`nums1` is a subset of `nums2`. For each value in `nums1`, return the first value to its **right in `nums2`** that is greater, or `−1`.

### Thought Process
1. Solve the general problem on `nums2` first: compute the next greater element for **every** value there.
2. That is the same decreasing stack — but this time we record the *value* that pops, not the distance.
3. Store the results in a map `value → next greater`. The problem guarantees the values are unique, so a map keyed by value is safe.
4. Then answer each query in `nums1` with a single O(1) lookup, defaulting to `−1`.
5. Values still on the stack at the end have nothing greater to their right, so they simply never enter the map — and the default handles them.

### Dry Run

Input: `nums1 = [4, 1, 2]`, `nums2 = [1, 3, 4, 2]`

**Pass over `nums2` building the map:**

| i | value | pops (value → next greater) | stack after (values) | map |
|---|-------|------------------------------|----------------------|-----|
| 0 | 1 | — | `[1]` | `{}` |
| 1 | 3 | pop 1 → `1 → 3` | `[3]` | `{1:3}` |
| 2 | 4 | pop 3 → `3 → 4` | `[4]` | `{1:3, 3:4}` |
| 3 | 2 | — (`2 < 4`) | `[4, 2]` | `{1:3, 3:4}` |

`4` and `2` are left on the stack — nothing greater follows them — so they stay out of the map.

**Answer the queries:**

| query | map lookup | result |
|-------|------------|--------|
| 4 | not in map | **−1** |
| 1 | `1 → 3` | **3** |
| 2 | not in map | **−1** |

Output: **`[-1, 3, -1]`** ✓

### Visualization

```text
nums2:   1    3    4    2
         └─▶3
              └─▶4
                   ✗ nothing greater
                        ✗ nothing greater

map: {1: 3, 3: 4}

nums1 = [4, 1, 2]  →  [-1, 3, -1]
```

### Code

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
    // Solve the general problem on nums2 once.
    nextGreater := make(map[int]int, len(nums2))
    stack := []int{} // values, decreasing

    for _, v := range nums2 {
        for len(stack) > 0 && stack[len(stack)-1] < v {
            popped := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            nextGreater[popped] = v
        }
        stack = append(stack, v)
    }
    // Values still on the stack have nothing greater to their right and are
    // simply absent from the map.

    answer := make([]int, len(nums1))
    for i, v := range nums1 {
        if g, ok := nextGreater[v]; ok {
            answer[i] = g
        } else {
            answer[i] = -1
        }
    }
    return answer
}
```

```python
def nextGreaterElement(nums1, nums2):
    next_greater = {}                  # value -> first greater value to its right
    stack = []                         # values, decreasing

    for v in nums2:
        while stack and stack[-1] < v:
            next_greater[stack.pop()] = v
        stack.append(v)
    # Values left on the stack are absent from the map, which is what we want.

    return [next_greater.get(v, -1) for v in nums1]
```

### Complexity
Time **O(n + m)** — one pass over `nums2` plus one lookup per element of `nums1`. Space O(n) for the stack and map.

---

## 11. Solved Example 3

### Problem — Online Stock Span (LeetCode 901)
For each daily price, return the **span**: how many consecutive days up to and including today had a price **less than or equal to** today's.

### Thought Process
1. This is the mirror of Daily Temperatures — we look *backwards* instead of forwards, and it must work **online** (each price arrives one at a time, with no future knowledge).
2. The span ends at the first earlier day with a **strictly greater** price. So we want the previous greater element.
3. A decreasing stack again — but here we pop on `top <= current`, because equal prices count *inside* the span.
4. The trick that makes it online: when we pop a day, we **absorb its span** into ours. That day already summarised everything behind it, so we never re-walk the history.
5. Start with `span = 1` (today itself), then add the span of everything popped.

### Dry Run

Input prices: `100, 80, 60, 70, 60, 75, 85`

The stack holds `(price, span)` pairs.

| price | pops (price, span absorbed) | span | stack after | output |
|-------|------------------------------|------|-------------|--------|
| 100 | — | 1 | `[(100,1)]` | **1** |
| 80  | — (`100 > 80`) | 1 | `[(100,1), (80,1)]` | **1** |
| 60  | — (`80 > 60`) | 1 | `[(100,1), (80,1), (60,1)]` | **1** |
| 70  | pop `(60,1)` → span `1+1 = 2` | 2 | `[(100,1), (80,1), (70,2)]` | **2** |
| 60  | — (`70 > 60`) | 1 | `… (70,2), (60,1)]` | **1** |
| 75  | pop `(60,1)` → `1+1 = 2`<br>pop `(70,2)` → `2+2 = 4` | 4 | `[(100,1), (80,1), (75,4)]` | **4** |
| 85  | pop `(75,4)` → `1+4 = 5`<br>pop `(80,1)` → `5+1 = 6` | 6 | `[(100,1), (85,6)]` | **6** |

Output: **`[1, 1, 1, 2, 1, 4, 6]`** ✓

The `85` step shows why absorbing spans matters: popping `(75, 4)` inherits the four days that `75` had already accounted for, so we never revisit them. Each price is pushed once and popped once no matter how many days it summarises.

### Visualization

```text
prices:  100   80   60   70   60   75   85
spans :    1    1    1    2    1    4    6
                              ↑         ↑
                              │         └ absorbs 75's span (4) + 80's (1) + itself
                              └ absorbs 60's span (1) + itself

each pop inherits work already done — never re-walk the history
```

### Code

```go
// StockSpanner answers span queries online, one price at a time.
type StockSpanner struct {
    // stack of (price, span), prices strictly decreasing bottom → top
    prices []int
    spans  []int
}

func NewStockSpanner() StockSpanner {
    return StockSpanner{}
}

func (s *StockSpanner) Next(price int) int {
    span := 1 // today always counts

    // <= : equal prices belong inside the span.
    for len(s.prices) > 0 && s.prices[len(s.prices)-1] <= price {
        // Absorb the popped day's span: it already summarised its own history.
        span += s.spans[len(s.spans)-1]
        s.prices = s.prices[:len(s.prices)-1]
        s.spans = s.spans[:len(s.spans)-1]
    }

    s.prices = append(s.prices, price)
    s.spans = append(s.spans, span)
    return span
}
```

```python
class StockSpanner:
    def __init__(self):
        self.stack = []                # (price, span), prices decreasing

    def next(self, price):
        span = 1                       # today always counts
        # <= : equal prices belong inside the span
        while self.stack and self.stack[-1][0] <= price:
            span += self.stack.pop()[1]     # absorb the popped day's span
        self.stack.append((price, span))
        return span
```

### Complexity
Time **O(1) amortised** per call — each price is pushed once and popped once across the whole run. Space O(n) worst case, when prices arrive in strictly decreasing order.

> Note the `<=` here versus the `<` in Example 1. Daily Temperatures wants *strictly* warmer, so equal temperatures must not settle a pending day; Stock Span counts equal prices as part of the span. Equal values are the only inputs that tell these two apart — and the only ones that will fail if you pick the wrong comparison.

---

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
