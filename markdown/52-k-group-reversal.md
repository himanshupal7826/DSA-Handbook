# 52 · K Group Reversal

> **One-liner:** Reverse the list in fixed-size k blocks, stitching segments together.

---

## 1. Overview

### Definition
The **K Group Reversal** pattern belongs to the *Linked Lists* family. Reverse the list in fixed-size k blocks, stitching segments together.

### Intuition
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Why it works
Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).

---

## 2. Recognition Signals

### Keywords
reverse k group, linked list, in place, segment reverse.

### Constraints
- Input size where the brute-force complexity would time out — the K Group Reversal optimization is the intended solution.
- Structural hints in the statement that match this family (Linked Lists).

### Hidden clues
- The problem can be reframed so the K Group Reversal invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — K Group Reversal is the upgrade.
- The wording maps onto: reverse k group, linked list, in place, segment reverse.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Reverse the list in chunks of k — but only the chunks that are actually full."*

Running example: `1 → 2 → 3 → 4 → 5` with `k = 3` → `3 → 2 → 1 → 4 → 5`.

### Intuition
Pointer surgery on blocks is fiddly, so avoid it: copy every value into an array, reverse
each full run of `k` values there, then write the array back into the nodes.

### Algorithm
1. Walk the list, appending values to a slice → `[1, 2, 3, 4, 5]`.
2. For each block start `i = 0, k, 2k, …`, if `i + k <= len`, reverse `slice[i : i+k]`
   → `[3, 2, 1, 4, 5]` (the trailing `[4, 5]` is shorter than `k`, so it is left alone).
3. Walk the list a second time, writing the slice back into `Val`.
4. Return `head`.

### Complexity
- Time: O(n) — three linear passes.
- Space: **O(n)** — the value buffer.

### Drawbacks
- The O(n) buffer exists only to avoid touching `Next`, but `Next` is where the answer
  lives. The problem statement usually says *"you may not alter the values in the nodes,
  only the nodes themselves may be changed"* — this approach breaks that rule outright.
- It cannot be adapted. Reverse a sublist, swap pairs, rotate — every variant needs the same
  three passes and the same buffer, and none of them teaches the reconnection logic that
  every list problem eventually demands.
- It hides the only genuinely hard part: **stitching the reversed block back into the list
  on both sides**. That is what interviewers are testing, and this approach never faces it.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Do it in three separate moves per block: count `k` nodes ahead (bail out if there aren't `k`), reverse just that block, then re-attach it on both sides.**

Trying to do all three at once is why this problem feels hard. Split apart, each move is
something you already know: a counting walk, chapter 48's reversal loop, and two pointer
assignments.

### The thought process

```text
We need    : reverse every FULL block of k, leave a short tail untouched.
Obvious way: copy values out, reverse in an array, copy back.
Not allowed: most statements forbid changing values; only links may move.
Notice     : a block is just a small list. Reversing it is chapter 48.
             The only new work is reconnecting it at both ends.
Therefore  : per block — (1) can I see k nodes? (2) reverse them
             (3) fix the two boundary pointers.
Now        : O(n) time, O(1) space, and each step is independently testable.
```

### Move 1 — look before you leap

You must know whether a full block exists **before** touching anything, because a partial
block has to be left in its original order. Walk `k` steps from `groupPrev`:

```text
kth := groupPrev
for i := 0; i < k && kth != nil; i++ { kth = kth.Next }
if kth == nil { break }      // fewer than k nodes remain — stop, leave the tail as-is
```

`kth` ends on the **last node of the block**, and `kth.Next` is the first node of the next
block. Save that as `nextGroup` before you reverse, because reversing destroys `kth.Next`.

Reverse first and count later and you get the classic bug: a 5-node list with `k = 3`
comes out as `3 → 2 → 1 → 5 → 4` instead of `3 → 2 → 1 → 4 → 5`.

### Move 2 — reverse the block

Chapter 48's loop, with one twist: instead of starting `prev = nil`, start it at
`nextGroup`. Then the block's old head — which becomes the block's tail — is *already*
pointing at the next block when the loop finishes. One less thing to fix up.

```text
prev, curr := nextGroup, groupPrev.Next
for curr != nextGroup {
    next := curr.Next     // save first — always
    curr.Next = prev
    prev = curr
    curr = next
}
```

The loop ends when `curr` reaches `nextGroup`, which is exactly `k` iterations.

### Move 3 — reconnect (the part people get wrong)

Two pointers must be rewritten, in this order, and one of them must be captured *before*
you overwrite it.

```text
BEFORE the block is reversed
                    groupStart                       nextGroup
                        │                                │
  ... groupPrev ──▶ [ 1  →  2  →  3 ] ──▶ 4 ──▶ 5
                                    │
                                   kth  (last node of the block)

AFTER reversing (move 2 already pointed 1 at 4)
  groupStart = groupPrev.Next        ← CAPTURE THIS FIRST: it is the block's
                                        old head = new tail
  groupPrev.Next = kth               ← left seam: attach the new head
  ( groupStart.Next == nextGroup )   ← right seam: free, thanks to move 2

  ... groupPrev ──▶ [ 3  →  2  →  1 ] ──▶ 4 ──▶ 5
                        ▲             │
                      kth = new head   groupStart = new tail

THEN set up for the next block
  groupPrev = groupStart             ← the block's tail anchors the next block
```

If you write `groupPrev.Next = kth` before saving `groupStart`, the pointer to the block's
new tail is gone and the list is cut in half at every seam.

The very first block has no predecessor, so use a **dummy node** as `groupPrev` (chapter 51)
— then "attach the first block" is the same assignment as every other seam, and the answer
is `dummy.Next`.

### Steps

```text
Step 1 → dummy = &Node{Next: head}; groupPrev = dummy
Step 2 → loop forever:
Step 3 →   kth = walk k nodes from groupPrev; if kth == nil → break
Step 4 →   nextGroup = kth.Next
Step 5 →   reverse [groupPrev.Next .. kth], starting prev = nextGroup
Step 6 →   groupStart = groupPrev.Next        (capture before overwriting)
Step 7 →   groupPrev.Next = kth               (left seam)
Step 8 →   groupPrev = groupStart             (anchor for the next block)
Step 9 → return dummy.Next
```

### How should I recognize this?

```text
If you see...
  "reverse nodes in k-group", "swap every two adjacent nodes"
  "reverse nodes between position left and right"
  "leave the last partial group as it is"
  "you may not change node values, only the nodes themselves"
        ↓
Think about...
  "Can I treat each chunk as its own tiny list, then sew the seams?"
        ↓
Use...
  dummy + groupPrev, then per block: count k → reverse → reconnect
    · k = 2               → the same thing, unrolled into 4 assignments (Swap Pairs)
    · one block [l, r]    → walk to l-1, reverse r-l+1 nodes, sew both seams
    · reverse the remainder too → drop the "kth == nil → break" bail-out
```

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="kgr52" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">k=3: reverse each block, stitch prev tail to new head</text>
  <text x="60" y="60" text-anchor="middle" fill="#64748b">BEFORE</text>
  <!-- before -->
  <g>
    <rect x="110" y="45" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="130" y="65" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="180" y="45" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="200" y="65" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="250" y="45" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="270" y="65" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="330" y="45" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="350" y="65" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="400" y="45" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="420" y="65" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <line x1="150" y1="60" x2="178" y2="60" stroke="#475569" marker-end="url(#kgr52)"/>
  <line x1="220" y1="60" x2="248" y2="60" stroke="#475569" marker-end="url(#kgr52)"/>
  <line x1="290" y1="60" x2="328" y2="60" stroke="#475569" marker-end="url(#kgr52)"/>
  <line x1="370" y1="60" x2="398" y2="60" stroke="#475569" marker-end="url(#kgr52)"/>
  <rect x="104" y="40" width="192" height="40" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="200" y="98" text-anchor="middle" fill="#059669" font-weight="700">group of k reversed</text>
  <text x="60" y="150" text-anchor="middle" fill="#64748b">AFTER</text>
  <!-- after -->
  <g>
    <rect x="110" y="135" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="130" y="155" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="180" y="135" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="200" y="155" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="250" y="135" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="270" y="155" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="330" y="135" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="350" y="155" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="400" y="135" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="420" y="155" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <line x1="150" y1="150" x2="178" y2="150" stroke="#475569" marker-end="url(#kgr52)"/>
  <line x1="220" y1="150" x2="248" y2="150" stroke="#475569" marker-end="url(#kgr52)"/>
  <line x1="290" y1="150" x2="328" y2="150" stroke="#059669" marker-end="url(#kgr52)"/>
  <line x1="370" y1="150" x2="398" y2="150" stroke="#475569" marker-end="url(#kgr52)"/>
  <text x="310" y="190" text-anchor="middle" fill="#059669" font-weight="700">tail 1 stitched to next block head 4</text>
</svg>
```

```text
list: 1 → 2 → 3 → 4 → 5      k = 3

── block 1 ─────────────────────────────────────────────
groupPrev = dummy
count 3 from dummy:  1, 2, 3     → kth = 3   ✔ full block
nextGroup = 4

reverse [1,2,3] with prev starting at 4:
  curr=1  next=2   1.Next=4    prev=1   curr=2
  curr=2  next=3   2.Next=1    prev=2   curr=3
  curr=3  next=4   3.Next=2    prev=3   curr=4 == nextGroup → stop

groupStart = 1  (captured first)
dummy.Next = kth = 3
groupPrev  = 1
list now: 3 → 2 → 1 → 4 → 5

── block 2 ─────────────────────────────────────────────
count 3 from node 1:  4, 5, nil  → kth = nil  ✘ only 2 left
break — the tail 4 → 5 keeps its original order

result: 3 → 2 → 1 → 4 → 5
```

### Interview explanation
"I'll process one block at a time with a dummy node in front so the first block needs no
special case. For each block I first walk `k` nodes to check a full block exists — if it
doesn't I stop, which leaves the short tail untouched as required. I save `kth.Next` as
`nextGroup`, then run the standard prev/curr/next reversal but seed `prev` with `nextGroup`,
so the block's old head ends up already pointing at the next block. Then two assignments
sew the seam: capture the old head as the new tail, point `groupPrev.Next` at `kth`, and
move `groupPrev` to that new tail for the next round. Every node is visited a constant
number of times, so O(n) time and O(1) space."

---

## 5. Generic Templates

> Per block: count `k` (bail if short) → reverse with `prev = nextGroup` → sew the seam → advance `groupPrev`.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// ReverseKGroup reverses every full block of k nodes, in place.
// A trailing block shorter than k keeps its original order.
func ReverseKGroup(head *ListNode, k int) *ListNode {
    dummy := &ListNode{Next: head} // the first block has no predecessor
    groupPrev := dummy
    for {
        // 1. is there a full block of k?
        kth := groupPrev
        for i := 0; i < k && kth != nil; i++ {
            kth = kth.Next
        }
        if kth == nil {
            break // short tail: leave it alone
        }
        nextGroup := kth.Next // save before the reversal destroys kth.Next

        // 2. reverse the block; seeding prev with nextGroup sews the right seam
        prev, curr := nextGroup, groupPrev.Next
        for curr != nextGroup {
            next := curr.Next
            curr.Next = prev
            prev = curr
            curr = next
        }

        // 3. sew the left seam
        groupStart := groupPrev.Next // capture BEFORE overwriting: new tail
        groupPrev.Next = kth         // new head of the block
        groupPrev = groupStart       // anchor for the next block
    }
    return dummy.Next
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt


def reverse_k_group(head, k):
    """Reverse every full block of k nodes; a short tail keeps its order."""
    dummy = ListNode(0, head)          # the first block has no predecessor
    group_prev = dummy
    while True:
        # 1. is there a full block of k?
        kth, i = group_prev, 0
        while kth and i < k:
            kth, i = kth.next, i + 1
        if not kth:
            break                       # short tail: leave it alone
        next_group = kth.next           # save before the reversal destroys it

        # 2. reverse; seeding prev with next_group sews the right seam
        prev, curr = next_group, group_prev.next
        while curr is not next_group:
            nxt = curr.next
            curr.next = prev
            prev, curr = curr, nxt

        # 3. sew the left seam
        group_start = group_prev.next   # capture BEFORE overwriting: new tail
        group_prev.next = kth           # new head of the block
        group_prev = group_start        # anchor for the next block
    return dummy.next
```

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

ListNode reverseKGroup(ListNode head, int k) {
    ListNode dummy = new ListNode(0);
    dummy.next = head;
    ListNode groupPrev = dummy;
    while (true) {
        ListNode kth = groupPrev;                       // 1. full block of k?
        for (int i = 0; i < k && kth != null; i++) kth = kth.next;
        if (kth == null) break;                         // short tail: stop
        ListNode nextGroup = kth.next;

        ListNode prev = nextGroup, curr = groupPrev.next; // 2. reverse
        while (curr != nextGroup) {
            ListNode next = curr.next;
            curr.next = prev;
            prev = curr;
            curr = next;
        }

        ListNode groupStart = groupPrev.next;           // 3. sew the seam
        groupPrev.next = kth;
        groupPrev = groupStart;
    }
    return dummy.next;
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v) : val(v), next(nullptr) {}
};

ListNode* reverseKGroup(ListNode* head, int k) {
    ListNode dummy(0);
    dummy.next = head;
    ListNode* groupPrev = &dummy;
    while (true) {
        ListNode* kth = groupPrev;                        // 1. full block of k?
        for (int i = 0; i < k && kth; i++) kth = kth->next;
        if (!kth) break;                                  // short tail: stop
        ListNode* nextGroup = kth->next;

        ListNode *prev = nextGroup, *curr = groupPrev->next; // 2. reverse
        while (curr != nextGroup) {
            ListNode* next = curr->next;
            curr->next = prev;
            prev = curr;
            curr = next;
        }

        ListNode* groupStart = groupPrev->next;           // 3. sew the seam
        groupPrev->next = kth;
        groupPrev = groupStart;
    }
    return dummy.next;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | K Group Reversal (Optimal) |
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

### Problem — Reverse K Group (LeetCode 25)
Reverse the nodes of the list `k` at a time and return the modified list. If the number of
remaining nodes is fewer than `k`, leave them as they are. You may not change node values.

### Thought Process
1. Put a dummy in front so the first block is attached exactly like every other block.
2. **Count first:** walk `k` nodes from `groupPrev`. If you fall off the end, fewer than `k`
   remain — stop and leave that tail alone.
3. Save `nextGroup = kth.Next` now; the reversal is about to overwrite it.
4. Reverse the block with prev/curr/next, but seed `prev = nextGroup` so the block's old
   head already points at the next block when the loop ends — the right seam is free.
5. Sew the left seam: capture `groupStart = groupPrev.Next` **before** overwriting it, set
   `groupPrev.Next = kth`, then move `groupPrev` to `groupStart` for the next round.

### Dry Run

Input: `1 → 2 → 3 → 4 → 5`, `k = 3`

**Block 1** — `groupPrev = dummy`

| move | what happens | result |
|------|--------------|--------|
| count | walk 3 from `dummy`: `1`, `2`, `3` | `kth = 3` — full block ✔ |
| save  | `nextGroup = kth.Next` | `nextGroup = 4` |
| reverse | `prev = 4`, `curr = 1` | see the inner table |
| sew | `groupStart = 1`; `dummy.Next = 3`; `groupPrev = 1` | `3 → 2 → 1 → 4 → 5` |

Inner reversal loop (stops when `curr == nextGroup`):

| iter | `next` | rewire | `prev` | `curr` |
|------|--------|--------|--------|--------|
| 1 | `2` | `1.Next = 4` | `1` | `2` |
| 2 | `3` | `2.Next = 1` | `2` | `3` |
| 3 | `4` | `3.Next = 2` | `3` | `4` → equals `nextGroup`, stop |

**Block 2** — `groupPrev = node 1`

| move | what happens | result |
|------|--------------|--------|
| count | walk 3 from `1`: `4`, `5`, then `nil` | `kth = nil` — only 2 remain ✘ |
| bail  | `break` | tail `4 → 5` keeps its original order |

Output: **`3 → 2 → 1 → 4 → 5`**

Iteration 1 is worth a second look: `1.Next = 4` happens *inside* the reversal, purely
because `prev` was seeded with `nextGroup`. That is the right seam, sewn for free.

### Visualization

```text
before        dummy → [1 → 2 → 3] → 4 → 5
                ↑                    ↑
            groupPrev             nextGroup
                       kth = 3 ────┘

after reversing the block (prev seeded with nextGroup = 4)

              dummy    [3 → 2 → 1] ──▶ 4 → 5
                ↑       ↑         ↑
            groupPrev  kth     groupStart
                       (new head)  (new tail — already sewn on the right)

sew the left seam:  groupPrev.Next = kth
              dummy ─▶ [3 → 2 → 1] ──▶ 4 → 5

advance:      groupPrev = groupStart (node 1) for the next block
```

### Code

```go
func reverseKGroup(head *ListNode, k int) *ListNode {
    dummy := &ListNode{Next: head}
    groupPrev := dummy
    for {
        // move 1: is a full block of k available?
        kth := groupPrev
        for i := 0; i < k && kth != nil; i++ {
            kth = kth.Next
        }
        if kth == nil {
            break // fewer than k remain: leave the tail untouched
        }
        nextGroup := kth.Next // save before the reversal destroys kth.Next

        // move 2: reverse the block; prev = nextGroup sews the right seam
        prev, curr := nextGroup, groupPrev.Next
        for curr != nextGroup {
            next := curr.Next // save first, always
            curr.Next = prev
            prev = curr
            curr = next
        }

        // move 3: sew the left seam
        groupStart := groupPrev.Next // capture BEFORE overwriting: the new tail
        groupPrev.Next = kth         // kth is the block's new head
        groupPrev = groupStart       // anchor for the next block
    }
    return dummy.Next
}
```

```python
def reverseKGroup(head, k):
    dummy = ListNode(0, head)
    group_prev = dummy
    while True:
        # move 1: is a full block of k available?
        kth, i = group_prev, 0
        while kth and i < k:
            kth, i = kth.next, i + 1
        if not kth:
            break                       # fewer than k remain: leave the tail
        next_group = kth.next           # save before the reversal destroys it

        # move 2: reverse; prev = next_group sews the right seam
        prev, curr = next_group, group_prev.next
        while curr is not next_group:
            nxt = curr.next             # save first, always
            curr.next = prev
            prev, curr = curr, nxt

        # move 3: sew the left seam
        group_start = group_prev.next   # capture BEFORE overwriting: new tail
        group_prev.next = kth           # kth is the block's new head
        group_prev = group_start        # anchor for the next block
    return dummy.next
```

### Complexity
Time O(n) — each node is counted once and rewired once, so a constant number of visits per
node. Space O(1) — a dummy and four pointers, no matter how large `k` is.

---

## 10. Solved Example 2

### Problem — Swap Pairs (LeetCode 24)
Swap every two adjacent nodes and return the head. Node values may not be modified — only
the links.

### Thought Process
1. This is the `k = 2` case, and with `k` fixed the counting loop collapses into a single
   guard: does `prev.Next.Next` exist?
2. Name the pair `first = prev.Next` and `second = prev.Next.Next`.
3. Three assignments do the swap: `first` jumps over `second`, `second` points back at
   `first`, and the anchor points at `second`. Order matters — `first.Next` must be read
   before `second.Next` overwrites the chain.
4. `prev` then moves to `first`, which is now the pair's tail and the anchor for the next pair.
5. A dummy makes the very first pair use the same three assignments as the rest.

### Dry Run

Input: `1 → 2 → 3 → 4`

| round | `prev` | `first` | `second` | `first.Next = second.Next` | `second.Next = first` | `prev.Next = second` | list after | new `prev` |
|-------|--------|---------|----------|----------------------------|------------------------|----------------------|------------|------------|
| 1 | `dummy` | `1` | `2` | `1.Next = 3` | `2.Next = 1` | `dummy.Next = 2` | `2 → 1 → 3 → 4` | `1` |
| 2 | `1`     | `3` | `4` | `3.Next = nil` | `4.Next = 3` | `1.Next = 4` | `2 → 1 → 4 → 3` | `3` |
| 3 | `3`     | — | — | guard `prev.Next != nil && prev.Next.Next != nil` fails (`prev.Next == nil`) → stop | | | `2 → 1 → 4 → 3` | — |

Output: **`2 → 1 → 4 → 3`**

On an odd-length list such as `1 → 2 → 3`, round 2 finds `prev.Next.Next == nil`, so the
lone node `3` is left in place — the same "bail out on a short block" rule as Example 1.

### Visualization

```text
        prev  first second
          ↓     ↓     ↓
round 1  dummy [1] → [2] → 3 → 4

   1.Next = 3       (first jumps over second)
   2.Next = 1       (second points back)
   dummy.Next = 2   (anchor takes the new head)

         dummy → [2] → [1] → 3 → 4
                        ↑
                      prev (the pair's tail anchors the next pair)

round 2         2 → 1 → [4] → [3] → nil
```

### Code

```go
func swapPairs(head *ListNode) *ListNode {
    dummy := &ListNode{Next: head} // the first pair has no predecessor
    prev := dummy
    for prev.Next != nil && prev.Next.Next != nil { // a full pair remains?
        first, second := prev.Next, prev.Next.Next
        first.Next = second.Next // first jumps over second
        second.Next = first      // second points back at first
        prev.Next = second       // anchor takes the pair's new head
        prev = first             // first is now the pair's tail
    }
    return dummy.Next
}
```

```python
def swapPairs(head):
    dummy = ListNode(0, head)                     # first pair has no predecessor
    prev = dummy
    while prev.next and prev.next.next:           # a full pair remains?
        first, second = prev.next, prev.next.next
        first.next = second.next                  # first jumps over second
        second.next = first                       # second points back at first
        prev.next = second                        # anchor takes the new head
        prev = first                              # first is now the pair's tail
    return dummy.next
```

### Complexity
Time O(n) — one pass, constant work per pair. Space O(1).

---

## 11. Solved Example 3

### Problem — Reverse II (LeetCode 92)
Reverse only the nodes from position `left` to position `right` (1-indexed) and return the
list. One pass.

### Thought Process
1. This is *one* block instead of many, so the same three moves apply — there is just no
   outer loop.
2. Walk `groupPrev` forward `left - 1` steps to sit immediately before the block. A dummy
   covers `left = 1`, where the block starts at the head.
3. `groupStart = groupPrev.Next` is the block's current head and will become its **tail**.
4. Reverse exactly `right - left` links inside the block. After the loop, `prev` is the
   block's new head and `curr` is the first node *after* the block.
5. Sew both seams: `groupPrev.Next = prev` (left) and `groupStart.Next = curr` (right).

### Dry Run

Input: `1 → 2 → 3 → 4 → 5`, `left = 2`, `right = 4`

Walk `left - 1 = 1` step: `groupPrev = node 1`. `groupStart = node 2`.
Start the reversal with `prev = groupStart (2)`, `curr = 3`, and run `right - left = 2` times.

| iter | `next = curr.Next` | `curr.Next = prev` | `prev` | `curr` |
|------|--------------------|--------------------|--------|--------|
| 1 | `next = 4` | `3.Next = 2` | `3` | `4` |
| 2 | `next = 5` | `4.Next = 3` | `4` | `5` |

Sew the seams:

| seam | assignment | effect |
|------|------------|--------|
| left  | `groupPrev.Next = prev` → `1.Next = 4` | the block's new head hangs off node 1 |
| right | `groupStart.Next = curr` → `2.Next = 5` | the block's new tail rejoins the remainder |

Output: **`1 → 4 → 3 → 2 → 5`**

Note the loop runs `right - left = 2` times, not 3: reversing a block of `m` nodes flips
`m - 1` internal links. `prev` starts on `groupStart` rather than `nil` precisely so that
node `2` is left pointing forward, ready for the right seam.

With `left == right` the loop runs zero times and both assignments write back the values
already there — a no-op, exactly as it should be.

### Visualization

```text
                groupPrev  groupStart
                    ↓          ↓
       dummy → 1 → [2 →  3  →  4] → 5
                                     ↑
                                curr ends here

after 2 internal flips:      2 ← 3 ← 4      prev = 4

sew left   1.Next = 4  ──┐
sew right  2.Next = 5    │
                         ▼
       dummy → 1 → 4 → 3 → 2 → 5
                    └────────┘
                  block reversed, both seams closed
```

### Code

```go
func reverseBetween(head *ListNode, left, right int) *ListNode {
    dummy := &ListNode{Next: head} // left may be 1
    groupPrev := dummy
    for i := 0; i < left-1; i++ { // stop just before the block
        groupPrev = groupPrev.Next
    }
    groupStart := groupPrev.Next // block's head now, its tail afterwards

    // reverse right-left links inside the block
    prev, curr := groupStart, groupStart.Next
    for i := 0; i < right-left; i++ {
        next := curr.Next // save first, always
        curr.Next = prev
        prev = curr
        curr = next
    }

    groupPrev.Next = prev   // left seam: new head of the block
    groupStart.Next = curr  // right seam: new tail rejoins the remainder
    return dummy.Next
}
```

```python
def reverseBetween(head, left, right):
    dummy = ListNode(0, head)            # left may be 1
    group_prev = dummy
    for _ in range(left - 1):            # stop just before the block
        group_prev = group_prev.next
    group_start = group_prev.next        # block's head now, its tail afterwards

    prev, curr = group_start, group_start.next
    for _ in range(right - left):        # flip right-left internal links
        nxt = curr.next                  # save first, always
        curr.next = prev
        prev, curr = curr, nxt

    group_prev.next = prev               # left seam: new head of the block
    group_start.next = curr              # right seam: tail rejoins the remainder
    return dummy.next
```

### Complexity
Time O(n) — `left - 1` steps to reach the block plus `right - left` flips, both bounded by
the list length. Space O(1).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 25 | Reverse K Group | Easy | Core linked lists application |
| 24 | Swap Pairs | Easy | Core linked lists application |
| 92 | Reverse II | Medium | Core linked lists application |
| 206 | Reverse List | Medium | Core linked lists application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same K Group Reversal logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** K Group Reversal (Linked Lists).
- **Signal:** reverse k group, linked list, in place, segment reverse.
- **Move:** Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.
- **Cost:** O(n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the K Group Reversal invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: K Group Reversal
FAMILY : Linked Lists (Advanced)
WHEN   : reverse k group, linked list, in place, segment reverse
DO     : Most list problems are pointer-rewiring; a dummy sentinel removes head edge case
TIME   : O(n)    SPACE: O(1)
PRACTICE: 25, 24, 92, 206
```

---

*Part of the DSA Patterns Handbook — pattern 52 of 100.*
