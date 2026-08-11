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

**The question this pattern keeps answering:** *"What if the node I need to insert or delete is the head?"*

Running example: delete every node with value `1` from `1 → 2 → 3`.

### Intuition
To unlink a node you need its **predecessor**, because deletion is the single assignment
`prev.Next = curr.Next`. Every node has a predecessor… except the head. So the brute-force
answer is: handle the head separately with an `if`, and handle everything else with the loop.

### Algorithm
1. While `head != nil && head.Val == val`, move `head = head.Next` — peel off leading matches.
2. If `head == nil`, return `nil` (the whole list matched).
3. Set `prev = head` and walk `curr = head.Next` through the rest.
4. If `curr.Val == val`, unlink it with `prev.Next = curr.Next`; otherwise advance `prev`.
5. Return `head` — which may not be the `head` you were passed.

### Complexity
- Time: O(n) — one pass.
- Space: O(1).

### Drawbacks
- The complexity is fine; the **shape** is the problem. There are now two deletion code
  paths — one that moves `head`, one that writes `prev.Next` — doing the same conceptual job.
- Here is the version everyone writes first, with step 1 missing:

  ```go
  func removeElementsBuggy(head *ListNode, val int) *ListNode {
      prev := head
      for curr := head; curr != nil; curr = curr.Next {
          if curr.Val == val {
              prev.Next = curr.Next // unlink
          } else {
              prev = curr
          }
      }
      return head // <- BUG: head itself was never allowed to change
  }
  ```

  On `1 → 2 → 3` with `val = 1` it returns `1 → 2 → 3`: the loop dutifully sets
  `prev.Next = curr.Next` where `prev == curr == head`, i.e. `head.Next = head.Next` — a
  no-op — and then hands back the very node it was asked to remove. **The answer is wrong
  and nothing crashed**, which is the worst kind of bug.
- The same missing branch reappears in *every* list problem that can touch the front:
  insert-at-front, remove-nth-from-end when `n` equals the length, build-a-new-list. Five
  problems, five copies of the same `if`.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Put one fake node in front of the list, so the real head has a predecessor and "delete the head" becomes an ordinary delete.**

A train station platform with a buffer stop at the end: every carriage, including the first
one, is coupled to *something*. You can now uncouple any carriage with the same motion —
there is no "but this is the front one" case to remember.

The fake node is called a **dummy**, a **sentinel**, or a **header node**. It is thrown
away at the end; you return `dummy.Next`.

### The thought process

```text
We need    : insert/delete anywhere in a list, including at the front.
Obvious way: an `if node == head` branch beside the normal path.
Problem    : two code paths for one operation; the head branch is the one
             people forget, and forgetting it fails silently.
Notice     : the head is only special because it has no predecessor.
Therefore  : give it one — a fake node whose Next is the head.
Now        : every real node has a predecessor, the branch disappears,
             and the new head is just dummy.Next.
```

### Why the dummy actually removes the special case

Look at the two operations side by side.

| | without a dummy | with a dummy |
|---|---|---|
| delete the head | `head = head.Next` | `prev.Next = prev.Next.Next` |
| delete node *i* | `prev.Next = prev.Next.Next` | `prev.Next = prev.Next.Next` |
| what you return | `head` (must be reassigned) | `dummy.Next` (read once, at the end) |

With the dummy the two rows are **literally the same line of code**, so the `if` has
nothing left to distinguish. And because the answer is read from `dummy.Next` at the very
end, the loop never has to track "did the head change?".

Here is the buggy example from section 3, fixed by three characters of setup:

```text
without dummy       head → [1] → [2] → [3]
                     ↑
                 no predecessor  ⇒  needs a special case

with dummy    [dummy] → [1] → [2] → [3]
                 ↑
              prev starts here  ⇒  dummy.Next = node2 deletes the head
                                    with the ordinary line
```

### Why it is safe

- The dummy is **local**: it is allocated inside the function and never returned, so no
  caller can observe it.
- Its `Val` is never read. Only its `Next` matters. (Set it to `0` and ignore it.)
- `dummy.Next` is the source of truth for the head at all times, including when the list
  becomes empty — then `dummy.Next` is `nil`, which is exactly the right answer.

### The two shapes you will use

```text
DELETE shape                        BUILD shape
  dummy.Next = head                   dummy = empty node
  prev = dummy                        tail  = dummy
  walk with prev.Next                 tail.Next = newNode; tail = tail.Next
  return dummy.Next                   return dummy.Next
```

The delete shape removes the "is it the head?" branch. The build shape removes the "is this
the first node I've appended?" branch. Same trick, both directions.

### Steps

```text
Step 1 → dummy = &Node{Next: head}     (delete shape)   or   &Node{} (build shape)
Step 2 → prev / tail = dummy
Step 3 → run the loop using ONLY prev.Next (or tail.Next); never touch `head`
Step 4 → after a deletion do NOT advance prev — the new prev.Next is unexamined
Step 5 → return dummy.Next
```

Step 4 is the one people trip on: after `prev.Next = prev.Next.Next`, `prev` already points
at a node it has not inspected. Advancing as well would skip it, so `6 → 6 → 1` with
`val = 6` would leave one `6` behind.

### How should I recognize this?

```text
If you see...
  "remove / delete / insert" in a linked list
  "the head may change", "return the new head"
  building a result list node by node (merge, add two numbers, partition, copy)
  a solution draft where you wrote `if node == head`
        ↓
Think about...
  "Is the head special only because it has no predecessor?"
        ↓
Use...
  dummy := &Node{Next: head} ; prev := dummy ; ... ; return dummy.Next
    · deleting   → walk with prev.Next, don't advance prev after a cut
    · building   → tail := dummy, append with tail.Next
    · both ends  → two dummies (e.g. partition into a "less" and a "ge" chain)
```

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

```text
delete every node with value 1 from  1 → 2 → 3

  dummy → [1] → [2] → [3]
    ↑
   prev

step 1  prev.Next = node(1), value matches
        prev.Next = prev.Next.Next        →  dummy → [2] → [3]
        prev stays on dummy (its Next is now unexamined)

step 2  prev.Next = node(2), no match     →  prev = node(2)
step 3  prev.Next = node(3), no match     →  prev = node(3)
step 4  prev.Next == nil                  →  stop

return dummy.Next = 2 → 3      (the head changed, and no `if` was needed)
```

### Interview explanation
"The head of a list is awkward only because it has no predecessor, and deletion is written
in terms of the predecessor. So I allocate one dummy node whose `Next` is the head; now
every real node has a predecessor and 'delete the head' is the same assignment as 'delete
any node'. I walk with `prev.Next` instead of the head variable and return `dummy.Next` at
the end, which is correct even if the list becomes empty. It costs one node of memory and
removes an entire class of edge-case bugs — the same trick gives me a clean `tail` when I'm
building a result list."

---

## 5. Generic Templates

> `dummy := &Node{Next: head}`; walk with `prev.Next`; `return dummy.Next`.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// Filter removes every node for which drop returns true. The head may change.
func Filter(head *ListNode, drop func(int) bool) *ListNode {
    dummy := &ListNode{Next: head} // gives the head a predecessor
    prev := dummy
    for prev.Next != nil {
        if drop(prev.Next.Val) {
            prev.Next = prev.Next.Next // unlink; prev stays put on purpose
        } else {
            prev = prev.Next
        }
    }
    return dummy.Next // nil when everything was removed
}

// Build appends nodes one at a time with no "first node" special case.
func Build(vals []int) *ListNode {
    dummy := &ListNode{} // tail always has somewhere to write
    tail := dummy
    for _, v := range vals {
        tail.Next = &ListNode{Val: v}
        tail = tail.Next
    }
    return dummy.Next
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt


def filter_list(head, drop):
    """Remove every node where drop(val) is true. The head may change."""
    dummy = ListNode(0, head)        # gives the head a predecessor
    prev = dummy
    while prev.next:
        if drop(prev.next.val):
            prev.next = prev.next.next   # unlink; prev stays put on purpose
        else:
            prev = prev.next
    return dummy.next                # None when everything was removed


def build(vals):
    """Append nodes with no 'first node' special case."""
    dummy = ListNode()               # tail always has somewhere to write
    tail = dummy
    for v in vals:
        tail.next = ListNode(v)
        tail = tail.next
    return dummy.next
```

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

ListNode removeValue(ListNode head, int val) {
    ListNode dummy = new ListNode(0); // gives the head a predecessor
    dummy.next = head;
    ListNode prev = dummy;
    while (prev.next != null) {
        if (prev.next.val == val) prev.next = prev.next.next; // prev stays put
        else                      prev = prev.next;
    }
    return dummy.next;                // null when everything was removed
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v) : val(v), next(nullptr) {}
};

ListNode* removeValue(ListNode* head, int val) {
    ListNode dummy(0);                // sentinel on the stack
    dummy.next = head;
    ListNode* prev = &dummy;
    while (prev->next) {
        if (prev->next->val == val) {
            ListNode* dead = prev->next;
            prev->next = dead->next;  // prev stays put on purpose
            delete dead;              // C++ owns its nodes
        } else {
            prev = prev->next;
        }
    }
    return dummy.next;                // nullptr when everything was removed
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
Remove the `n`-th node **from the end** of the list and return the head. One pass.

### Thought Process
1. "From the end" is unknown until you know the length — but a fixed **gap** between two
   pointers survives without knowing it.
2. Move `fast` forward `n + 1` nodes from the dummy. Now `fast` is `n + 1` ahead of `slow`.
3. Advance both until `fast` falls off the end. The gap is preserved, so `slow` stops on the
   node *just before* the one to delete — exactly the predecessor deletion needs.
4. Delete with `slow.Next = slow.Next.Next`.
5. When `n` equals the length, the node to delete **is** the head — and the dummy means that
   case runs the identical line.

### Dry Run

Input: `1 → 2 → 3 → 4 → 5`, `n = 2`

Setup: `dummy → 1 → 2 → 3 → 4 → 5`; advance `fast` `n + 1 = 3` times.

| phase | `slow` | `fast` | note |
|-------|--------|--------|------|
| after setup | `dummy` | `3` | gap = 3 nodes |
| move 1 | `1` | `4` | gap held |
| move 2 | `2` | `5` | gap held |
| move 3 | `3` | `nil` | `fast` off the end → stop |

`slow = node 3`, so `slow.Next = node 4` is the 2nd from the end. Unlink it:
`3.Next = 5`.

Output: **`1 → 2 → 3 → 5`**

Now the head case, `[1]` with `n = 1`: `fast` advances twice — to `node 1`, then to `nil` —
so the move loop never runs and `slow` is still `dummy`. The same line
`slow.Next = slow.Next.Next` sets `dummy.Next = nil`, and `dummy.Next` returns `nil`.
Without the dummy this input needs its own `if`.

### Visualization

```text
gap = n + 1 = 3

dummy → 1 → 2 → 3 → 4 → 5 → nil
  ↑             ↑
 slow          fast                after setup

        1 → 2 → 3 → 4 → 5 → nil
            ↑             ↑
           slow          fast      after 2 moves

        1 → 2 → 3 → 4 → 5 → nil
                ↑             ↑
               slow          fast(nil)

slow.Next is the target ──┘
            1 → 2 → 3 ─────────▶ 5
```

The gap never changes, so wherever `fast` stops, `slow` is always `n + 1` behind it —
which is `n` behind the end, i.e. one before the target.

### Code

```go
func removeNthFromEnd(head *ListNode, n int) *ListNode {
    dummy := &ListNode{Next: head} // the target may be the head
    slow, fast := dummy, dummy
    for i := 0; i <= n; i++ { // open a gap of n+1 nodes
        fast = fast.Next
    }
    for fast != nil { // keep the gap, slide both to the end
        slow = slow.Next
        fast = fast.Next
    }
    slow.Next = slow.Next.Next // slow is the target's predecessor
    return dummy.Next
}
```

```python
def removeNthFromEnd(head, n):
    dummy = ListNode(0, head)        # the target may be the head
    slow = fast = dummy
    for _ in range(n + 1):           # open a gap of n+1 nodes
        fast = fast.next
    while fast:                      # keep the gap, slide both to the end
        slow, fast = slow.next, fast.next
    slow.next = slow.next.next       # slow is the target's predecessor
    return dummy.next
```

### Complexity
Time O(n) — `fast` traverses the list once and `slow` follows. Space O(1) — one sentinel
and two pointers.

---

## 10. Solved Example 2

### Problem — Remove Elements (LeetCode 203)
Delete **every** node whose value equals `val` and return the head of the resulting list.

### Thought Process
1. Deletion is `prev.Next = prev.Next.Next`, so every candidate needs a predecessor — give
   the head one with a dummy.
2. Inspect `prev.Next` rather than a separate `curr`. Then "should I delete?" and "what do I
   delete?" are the same expression.
3. On a match, unlink and **leave `prev` where it is** — its new `Next` has not been checked yet.
4. On a miss, advance `prev`.
5. Stop when `prev.Next` is `nil`, and return `dummy.Next` — correct even if every node went.

### Dry Run

Input: `6 → 1 → 6`, `val = 6` (the head matches *and* the tail matches)

| step | `prev` | `prev.Next` | match? | action | list after |
|------|--------|-------------|--------|--------|------------|
| 1 | `dummy` | `6` (1st) | yes | `dummy.Next = node(1)`; `prev` **stays** | `dummy → 1 → 6` |
| 2 | `dummy` | `1`       | no  | `prev = node(1)` | `dummy → 1 → 6` |
| 3 | `1`     | `6` (2nd) | yes | `1.Next = nil`; `prev` stays | `dummy → 1` |
| 4 | `1`     | `nil`     | —   | loop guard fails → stop | `dummy → 1` |

Output: **`1`**

Step 1 is the one the no-dummy version gets wrong — and step 1 → step 2 shows why `prev`
must not advance after a cut. On `6 → 6 → 1`, advancing would jump straight past the second
`6` and leave it in the output.

### Visualization

```text
      prev
       ↓
   [dummy] → [6] → [1] → [6] → nil

step 1  cut the first 6, prev unchanged
   [dummy] ─────▶ [1] → [6] → nil
       ↑
      prev        (its Next is a node we have not looked at yet)

step 2  1 != 6, advance
   [dummy] → [1] → [6] → nil
              ↑
             prev

step 3  cut the second 6
   [dummy] → [1] → nil
              ↑
             prev

return dummy.Next = 1
```

### Code

```go
func removeElements(head *ListNode, val int) *ListNode {
    dummy := &ListNode{Next: head} // the head may itself be removed
    prev := dummy
    for prev.Next != nil {
        if prev.Next.Val == val {
            prev.Next = prev.Next.Next // unlink; prev stays: new Next is unchecked
        } else {
            prev = prev.Next
        }
    }
    return dummy.Next // nil if every node matched
}
```

```python
def removeElements(head, val):
    dummy = ListNode(0, head)            # the head may itself be removed
    prev = dummy
    while prev.next:
        if prev.next.val == val:
            prev.next = prev.next.next   # unlink; prev stays: new Next unchecked
        else:
            prev = prev.next
    return dummy.next                    # None if every node matched
```

### Complexity
Time O(n) — each node is examined once; a deletion is O(1). Space O(1).

---

## 11. Solved Example 3

### Problem — Add Two Numbers (LeetCode 2)
Two non-negative integers are stored as linked lists with their digits in **reverse** order
(ones digit first). Add them and return the sum in the same format.

### Thought Process
1. Reverse order is a gift: the heads are the ones digits, so you can add left to right
   exactly like long addition on paper.
2. Walk both lists together, adding `a + b + carry`; the output digit is `sum % 10` and the
   new carry is `sum / 10`.
3. The lists may differ in length — treat a missing digit as `0` instead of writing a second
   loop.
4. Building the answer front-to-back needs a `tail`, and a **build-shape dummy** removes the
   "is this the first digit?" branch.
5. Keep looping while *either* list has digits **or** a carry survives — `99 + 1` must grow
   the answer by a node.

### Dry Run

Input: `l1 = 2 → 4 → 3` (342), `l2 = 5 → 6 → 4` (465)

| step | `a` | `b` | carry in | `sum` | digit `sum%10` | carry out | output so far |
|------|-----|-----|----------|-------|----------------|-----------|---------------|
| 1 | `2` | `5` | 0 | 7  | `7` | 0 | `7` |
| 2 | `4` | `6` | 0 | 10 | `0` | 1 | `7 → 0` |
| 3 | `3` | `4` | 1 | 8  | `8` | 0 | `7 → 0 → 8` |
| 4 | — | — | 0 | — | — | — | both lists empty and carry 0 → stop |

Output: **`7 → 0 → 8`** = 807 = 342 + 465 ✓

Now the growth case, `l1 = 9 → 9` (99) and `l2 = 1` (1):

| step | `a` | `b` | carry in | `sum` | digit | carry out |
|------|-----|-----|----------|-------|-------|-----------|
| 1 | `9` | `1` | 0 | 10 | `0` | 1 |
| 2 | `9` | — (0) | 1 | 10 | `0` | 1 |
| 3 | — (0) | — (0) | 1 | 1 | `1` | 0 |

Result `0 → 0 → 1` = 100. Step 3 only happens because the loop condition includes
`carry != 0`; drop that clause and the answer is `00` — wrong by a whole digit.

### Visualization

```text
    3   4   2        (l1 read right-to-left)
+   4   6   5        (l2 read right-to-left)
    ─────────
    8   0   7

list order (ones first):
  l1:  2 → 4 → 3
  l2:  5 → 6 → 4
        ↓   ↓   ↓
carry:  0   1   0
  out:  7 → 0 → 8

dummy → 7 → 0 → 8
  ↑
build-shape sentinel: tail always has somewhere to append
```

### Code

```go
func addTwoNumbers(l1, l2 *ListNode) *ListNode {
    dummy := &ListNode{} // build shape: no "first node" special case
    tail := dummy
    carry := 0
    for l1 != nil || l2 != nil || carry != 0 { // carry can outlive both lists
        sum := carry
        if l1 != nil {
            sum += l1.Val
            l1 = l1.Next
        }
        if l2 != nil { // a missing digit counts as 0
            sum += l2.Val
            l2 = l2.Next
        }
        carry = sum / 10
        tail.Next = &ListNode{Val: sum % 10}
        tail = tail.Next
    }
    return dummy.Next
}
```

```python
def addTwoNumbers(l1, l2):
    dummy = ListNode()                 # build shape: no "first node" special case
    tail, carry = dummy, 0
    while l1 or l2 or carry:           # carry can outlive both lists
        total = carry
        if l1:
            total += l1.val
            l1 = l1.next
        if l2:                         # a missing digit counts as 0
            total += l2.val
            l2 = l2.next
        carry, digit = divmod(total, 10)
        tail.next = ListNode(digit)
        tail = tail.next
    return dummy.next
```

### Complexity
Time O(max(n, m)) — one node of output per digit position, plus at most one for the final
carry. Space O(max(n, m)) for the result; O(1) beyond it.

---

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
