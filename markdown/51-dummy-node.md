# 51 · Dummy Node Pattern

> **One-liner:** A sentinel head node erases head-edge special cases.

---

## 1. Overview

### Definition
The **Dummy Node Pattern** pattern belongs to the *Linked Lists* family. A sentinel head node erases head-edge special cases.

### Intuition
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Why it works
Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).

---

## 2. Recognition Signals

### Keywords
dummy node, sentinel, head, remove, edge case.

### Constraints
- Input size where the brute-force complexity would time out — the Dummy Node Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Linked Lists).

### Hidden clues
- The problem can be reframed so the Dummy Node Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Dummy Node Pattern is the upgrade.
- The wording maps onto: dummy node, sentinel, head, remove, edge case.

---

## 3. Brute Force Approach

### Intuition
Copy to an array, manipulate, rebuild — O(n) extra space.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Dummy Node Pattern pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Dummy Node Pattern invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="dmy51" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Sentinel dummy points at head, so deleting node 1 needs no special case</text>
  <!-- dummy -->
  <rect x="40" y="55" width="60" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="70" y="77" text-anchor="middle" fill="#1e293b">dummy</text>
  <text x="70" y="108" text-anchor="middle" fill="#d97706" font-weight="700">sentinel</text>
  <!-- nodes -->
  <rect x="150" y="55" width="46" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="173" y="77" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="270" y="55" width="46" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="293" y="77" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="390" y="55" width="46" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="413" y="77" text-anchor="middle" fill="#1e293b">3</text>
  <line x1="100" y1="72" x2="148" y2="72" stroke="#475569" marker-end="url(#dmy51)"/>
  <line x1="196" y1="72" x2="268" y2="72" stroke="#64748b" stroke-dasharray="3,3"/>
  <line x1="316" y1="72" x2="388" y2="72" stroke="#475569" marker-end="url(#dmy51)"/>
  <!-- deletion of node 1 -->
  <line x1="150" y1="95" x2="196" y2="55" stroke="#b91c1c" stroke-width="2"/>
  <line x1="196" y1="95" x2="150" y2="55" stroke="#b91c1c" stroke-width="2"/>
  <text x="173" y="110" text-anchor="middle" fill="#b91c1c" font-weight="700">removed</text>
  <!-- rewired dummy to 2 -->
  <path d="M70,89 C70,150 293,155 293,91" fill="none" stroke="#059669" stroke-width="2" marker-end="url(#dmy51)"/>
  <text x="200" y="175" text-anchor="middle" fill="#059669" font-weight="700">dummy.next = node 2 — return dummy.next</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Dummy Node Pattern: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Dummy Node Pattern problem. I'll most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure. That brings the complexity down to O(n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Linked Lists** family template. Adapt the comparison/condition to the specific problem.

```go
// Reverse a singly linked list in place.
type ListNode struct { Val int; Next *ListNode }
func reverseList(head *ListNode) *ListNode {
    var prev *ListNode
    for head != nil {
        next := head.Next   // save
        head.Next = prev    // reverse pointer
        prev = head         // advance prev
        head = next         // advance head
    }
    return prev
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt

def reverse_list(head):
    prev = None
    while head:
        nxt = head.next      # save next
        head.next = prev     # reverse pointer
        prev = head          # advance
        head = nxt
    return prev
```

```java
class ListNode { int val; ListNode next; ListNode(int v){val=v;} }
ListNode reverseList(ListNode head) {
    ListNode prev = null;
    while (head != null) {
        ListNode next = head.next;
        head.next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
```

```cpp
struct ListNode { int val; ListNode* next; ListNode(int v):val(v),next(nullptr){} };
ListNode* reverseList(ListNode* head) {
    ListNode* prev = nullptr;
    while (head) {
        ListNode* next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Dummy Node Pattern (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(1)** |

> In-place pointer manipulation, single traversal.

---

## 7. Common Mistakes

1. Losing the `next` pointer before rewiring (save it first).
2. Not using a dummy head, then special-casing head insert/delete.
3. Null-pointer dereference at the list's end.
4. Creating cycles by mis-wiring `next`.
5. Fast/slow: advancing fast without checking `fast.next` for null.
6. Off-by-one finding the middle (even vs odd length).
7. Forgetting to disconnect the tail when splitting lists.
8. Returning the old head instead of the new one after reversal.
9. Memory leaks in C++ when removing nodes (delete them).
10. Reversing in k-groups but not stitching segments correctly.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a dummy node?**
   A: It gives a stable handle so head insert/delete needs no special case.

2. **Q: Find the middle?**
   A: Fast/slow pointers; fast moves 2x.

3. **Q: Detect a cycle?**
   A: Floyd's tortoise & hare; meeting implies a cycle.

4. **Q: Find cycle start?**
   A: Reset one pointer to head after meeting; advance both by 1.

5. **Q: Reverse in k-groups?**
   A: Reverse each block, connect previous tail to new head.

6. **Q: Merge two sorted lists?**
   A: Dummy head + splice smaller node each step.

7. **Q: Remove nth from end?**
   A: Two pointers n apart, then delete.

8. **Q: Palindrome list?**
   A: Find middle, reverse second half, compare.

9. **Q: Why O(1) space?**
   A: Only a few pointers beyond the list.

10. **Q: Recursion vs iteration?**
   A: Recursion is clean but O(n) stack; iteration is O(1).

11. **Q: Copy list with random pointer?**
   A: Interleave clones or use a hash map.

12. **Q: Reorder list?**
   A: Split, reverse second half, merge alternately.

13. **Q: Sort a linked list?**
   A: Merge sort fits lists naturally (O(n log n), O(1) extra with bottom-up).

14. **Q: Intersection of two lists?**
   A: Two pointers switching heads equalize lengths.

15. **Q: Doubly linked tricks?**
   A: Prev pointers simplify deletion and LRU caches.

---

## 9. Solved Example 1

### Problem — Remove Nth (LeetCode 19)
A representative **Dummy Node Pattern** problem. The signal: a sentinel head node erases head-edge special cases.

### Thought Process
1. Put a dummy before the head so removing the real head is not a special case.
2. Advance a `fast` pointer n steps ahead, then move `fast` and `slow` together until `fast` reaches the last node.
3. `slow` now sits just before the target; splice it out with `slow.next = slow.next.next`.

### Dry Run
Input `1→2→3→4→5`, n=2.
- fast advances 2 → at node 2; slow at dummy
- move together until fast at node 5 → slow at node 3
- slow.next = node5 → result `1→2→3→5`

### Visualization
```
input  ──▶ [ apply Dummy Node Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def removeNthFromEnd(head, n):
    dummy = ListNode(0, head)
    fast = slow = dummy
    for _ in range(n):            # gap of n between fast and slow
        fast = fast.next
    while fast.next:              # move both to the end
        fast = fast.next
        slow = slow.next
    slow.next = slow.next.next    # unlink nth-from-end
    return dummy.next
```

### Complexity
Time O(n), Space O(1). Single pass with two pointers, dummy removes the head case.

## 10. Solved Example 2

### Problem — Remove Elements (LeetCode 203)
A representative **Dummy Node Pattern** problem. The signal: a sentinel head node erases head-edge special cases.

### Thought Process
1. A dummy before the head lets us delete matching head nodes with the same code as any other node.
2. Walk a `curr` pointer; whenever `curr.next` holds the target value, unlink it by skipping over it.
3. Only advance `curr` when it does not delete, so consecutive matches are all removed.

### Dry Run
Input `1→2→6→3→6`, val=6.
- curr=dummy: next=1 keep → curr=1
- 1.next=2 keep → curr=2; 2.next=6 delete → 2→3
- curr=2: next=3 keep → curr=3; 3.next=6 delete → 3→None → `1→2→3`

### Visualization
```
input  ──▶ [ apply Dummy Node Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def removeElements(head, val):
    dummy = ListNode(0, head)
    curr = dummy
    while curr.next:
        if curr.next.val == val:
            curr.next = curr.next.next   # skip the match
        else:
            curr = curr.next             # advance only when kept
    return dummy.next
```

### Complexity
Time O(n), Space O(1). One pass, dummy removes the leading-match edge case.

## 11. Solved Example 3

### Problem — Add Two Numbers (LeetCode 2)
A representative **Dummy Node Pattern** problem. The signal: a sentinel head node erases head-edge special cases.

### Thought Process
1. Digits are stored least-significant first, so add position by position while carrying like grade-school addition.
2. A dummy head lets us append result digits uniformly without a special first-node case.
3. Keep looping while either list has digits or a carry remains; use `divmod` to split sum into carry and digit.

### Dry Run
Input `2→4→3` (342) and `5→6→4` (465).
- 2+5=7 → digit 7, carry 0
- 4+6=10 → digit 0, carry 1
- 3+4+1=8 → digit 8 → result `7→0→8` (807)

### Visualization
```
input  ──▶ [ apply Dummy Node Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def addTwoNumbers(l1, l2):
    dummy = tail = ListNode()
    carry = 0
    while l1 or l2 or carry:
        total = carry
        if l1: total, l1 = total + l1.val, l1.next
        if l2: total, l2 = total + l2.val, l2.next
        carry, digit = divmod(total, 10)
        tail.next = ListNode(digit)
        tail = tail.next
    return dummy.next
```

### Complexity
Time O(max(n, m)), Space O(max(n, m)) for the result list.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 19 | Remove Nth | Easy | Core linked lists application |
| 203 | Remove Elements | Easy | Core linked lists application |
| 2 | Add Two Numbers | Medium | Core linked lists application |
| 82 | Remove Dup II | Medium | Core linked lists application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Reverse (whole / k-group)**
- **Cycle detection**
- **Merge sorted lists**
- **Dummy-node insert/delete**
- **Fast/slow midpoint**

---

## 14. Production Engineering Applications

- **Scalability:** Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Dummy Node Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Dummy Node Pattern (Linked Lists).
- **Signal:** dummy node, sentinel, head, remove, edge case.
- **Move:** Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.
- **Cost:** O(n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Dummy Node Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Dummy Node Pattern
FAMILY : Linked Lists (Beginner)
WHEN   : dummy node, sentinel, head, remove, edge case
DO     : Most list problems are pointer-rewiring; a dummy sentinel removes head edge case
TIME   : O(n)    SPACE: O(1)
PRACTICE: 19, 203, 2, 82
```

---

*Part of the DSA Patterns Handbook — pattern 51 of 100.*
