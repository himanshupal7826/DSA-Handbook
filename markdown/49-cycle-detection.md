# 49 · Cycle Detection

> **One-liner:** Floyd's tortoise & hare detects and locates cycles in O(1) space.

---

## 1. Overview

### Definition
The **Cycle Detection** pattern belongs to the *Linked Lists* family. Floyd's tortoise & hare detects and locates cycles in O(1) space.

### Intuition
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Why it works
Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).

---

## 2. Recognition Signals

### Keywords
cycle, floyd, linked list, loop, fast slow.

### Constraints
- Input size where the brute-force complexity would time out — the Cycle Detection optimization is the intended solution.
- Structural hints in the statement that match this family (Linked Lists).

### Hidden clues
- The problem can be reframed so the Cycle Detection invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Cycle Detection is the upgrade.
- The wording maps onto: cycle, floyd, linked list, loop, fast slow.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Does walking this list ever bring me back somewhere I've already been?"*

Running example: `3 → 2 → 0 → 4 → 2 → 1 → ` back to the node holding `0`.

```text
3 → 2 → 0 → 4
            ↓
        1 ← 2
        ↓
        └──▶ back to 0
```

### Intuition
A cycle is just "I've been here before". So write down every node you visit; the first
node you see twice proves the loop exists and marks where it starts.

### Algorithm
1. Create an empty set of visited **node addresses** — not values. Values may legitimately
   repeat (this list contains `2` twice) while addresses cannot.
2. Walk one node at a time from the head.
3. If the current node is already in the set → cycle found, and this node is the entrance.
4. Otherwise insert it and continue.
5. Reaching `nil` means no cycle.

### Complexity
- Time: O(n) — one pass, O(1) set operations.
- Space: **O(n)** — the set can hold every node in the list.

### Drawbacks
- The **time** is already optimal; the **memory** is the problem. Answering a yes/no
  question about a 10⁷-node list costs a 10⁷-entry hash set.
- Concretely: to detect the loop in the 6-node example above, the set has to hold
  `{3, 2, 0, 4, 2, 1}` — six pointers — before the seventh step repeats `0`. All that
  storage exists only to notice a repeat.
- It ignores the structural fact that makes lists special: **a cycle has a fixed length**,
  so anything moving faster than you will lap you. That relationship needs no memory at all.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Run two pointers at different speeds — in a loop the fast one must lap the slow one, and the size of their gap is the only thing you have to "remember".**

Two runners on a circular track: the faster one inevitably catches the slower one from
behind. On a straight track it never does — it just reaches the finish line and stops.
That single difference is the entire cycle test, and it costs two variables.

`slow` moves 1 node per step, `fast` moves 2.

### The thought process

```text
We need    : detect a cycle in O(1) extra space.
Obvious way: store every node visited.
Too costly : O(n) memory for a yes/no answer.
Notice     : inside a loop, a 2x-speed pointer closes on a 1x pointer.
             Outside a loop, the fast pointer simply runs off the end.
Therefore  : slow += 1, fast += 2.
             fast reaches nil  →  no cycle
             fast == slow      →  cycle
Now        : two pointers, zero allocation.
```

### Why they *must* meet — the shrinking-gap invariant

This is the one thing to be able to prove at a whiteboard.

Once **both** pointers are inside the loop, measure the gap as "how many steps forward
must `fast` take, going around the loop, to land on `slow`". Each step:

```text
fast advances 2, slow advances 1   →   gap changes by 2 − 1 = −1
```

The gap shrinks by **exactly one** every step. A quantity that decreases in steps of
exactly 1 can never jump over 0 — it has to land on it. So they meet, in at most `C` steps
once both are inside a cycle of length `C`.

That is also why the speeds are 1 and 2, not 1 and 3. With `fast += 3` the gap shrinks by
2 per step, and in an even-length loop a gap of 3 goes `3 → 1 → −1 (= C−1)` — it steps
straight over zero and can circle forever without a meeting.

`slow` also cannot lap the loop before `fast` catches it: `slow` needs `C` steps for a full
lap and the gap starts below `C`, so the meeting always happens first.

### Why the loop guard is `fast != nil && fast.Next != nil`

`fast` takes two hops, so the node it stands on **and** the node after it must both exist
before it moves. Checking only `fast != nil` panics on an even-length acyclic list, where
`fast.Next` is `nil`. This one condition also covers the empty list and the single-node
list without any extra `if`.

### Finding where the cycle starts

Detection lands you on *some* node inside the loop, which is usually not the entrance. The
fix is famously short:

> **Reset one pointer to `head`, leave the other at the meeting node, then advance both by 1. They meet exactly at the cycle entrance.**

The reason is the identity **`L = m·C − k`** (with `L` = head→entrance, `C` = loop length,
`k` = entrance→meeting point around the loop). Chapter 08 derives it line by line from
"fast walked twice as far as slow"; the plain-English reading is all you need here:

> the distance from the **head** to the entrance equals the distance from the **meeting
> point** onward to the entrance, give or take whole extra laps — and whole laps don't
> change where you land.

So two one-step pointers, launched from those two places, arrive together.

### The same two pointers, other jobs

| Goal | Setup | Read the answer from |
|---|---|---|
| Is there a cycle? | slow +1, fast +2 | they met ⇒ yes |
| Where does it start? | then reset one to head, both +1 | the node where they meet |
| **How long is the cycle?** | from the meeting node, walk +1 counting until you return to it | the counter |
| **Remove the cycle** | find the entrance, then walk the loop to the node whose `Next` is the entrance | set that node's `Next = nil` |
| Middle of a list | slow +1, fast +2 | `slow`, when `fast` ends |
| Duplicate in `nums[]` | treat `i → nums[i]` as a list | the cycle entrance |

### Steps

```text
Phase 1 — detect
  Step 1 → slow = head, fast = head
  Step 2 → while fast != nil && fast.Next != nil:
  Step 3 →     slow = slow.Next        (+1)
  Step 4 →     fast = fast.Next.Next   (+2)
  Step 5 →     if slow == fast → cycle; remember this node
  Step 6 → fast fell off the end → no cycle

Phase 2 — locate the entrance (only if phase 1 met)
  Step 7 → p = head, q = meeting node
  Step 8 → while p != q: p = p.Next, q = q.Next
  Step 9 → p is the cycle entrance

Phase 3 — measure the cycle (optional)
  Step 10 → n = 1, q = meeting.Next
  Step 11 → while q != meeting: q = q.Next, n++
  Step 12 → n is the cycle length
```

### How should I recognize this?

```text
If you see...
  "linked list" + "O(1) extra space"
  "cycle", "loop", "does it repeat forever", "where does the loop begin"
  an array read as a function i → nums[i] (Find the Duplicate, Happy Number)
  "middle node", "k-th from the end"
        ↓
Think about...
  "Two speeds. Does the GAP between them encode what I'd otherwise store?"
        ↓
Use...
  slow += 1, fast += 2, guarded by (fast != nil && fast.Next != nil)
    · yes/no          → stop at the meeting
    · entrance        → reset one pointer to head, both +1
    · length          → lap the loop from the meeting node
    · break the cycle → nil out the entrance's predecessor
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="cyc49" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Floyd: slow +1, fast +2 — they meet inside the loop</text>
  <!-- tail leading into loop -->
  <rect x="40" y="60" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="62" y="82" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="120" y="60" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="142" y="82" text-anchor="middle" fill="#1e293b">2</text>
  <line x1="86" y1="77" x2="118" y2="77" stroke="#475569" marker-end="url(#cyc49)"/>
  <line x1="166" y1="77" x2="220" y2="90" stroke="#475569" marker-end="url(#cyc49)"/>
  <!-- loop nodes -->
  <rect x="230" y="80" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="252" y="102" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="360" y="80" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="382" y="102" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="360" y="170" width="44" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="382" y="192" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="230" y="170" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="252" y="192" text-anchor="middle" fill="#1e293b">1</text>
  <line x1="274" y1="97" x2="358" y2="97" stroke="#475569" marker-end="url(#cyc49)"/>
  <line x1="382" y1="114" x2="382" y2="168" stroke="#475569" marker-end="url(#cyc49)"/>
  <line x1="358" y1="187" x2="276" y2="187" stroke="#475569" marker-end="url(#cyc49)"/>
  <line x1="252" y1="168" x2="252" y2="116" stroke="#475569" marker-end="url(#cyc49)"/>
  <!-- meeting marker -->
  <text x="382" y="228" text-anchor="middle" fill="#059669" font-weight="700">slow &amp; fast meet here</text>
  <circle cx="440" cy="187" r="7" fill="none" stroke="#059669" stroke-width="2"/>
</svg>
```

```text
index :  0    1    2    3    4    5
value :  3 →  2 →  0 →  4 →  2 →  1
                   ↑                │
                   └────────────────┘      (node 5 links back to node 2)

L = 2 (head → entrance)      C = 4 (loop length)

phase 1
  step | slow (idx) | fast (idx) | met?
  -----|------------|------------|-----
  start|     0      |     0      |  -
    1  |     1      |     2      |  no
    2  |     2      |     4      |  no
    3  |     3      |     2      |  no
    4  |     4      |     4      |  YES  → meeting at index 4, k = 2

check: L = m·C − k  →  2 = 1·4 − 2  ✓

phase 2   p = idx0, q = idx4
  step 1: p = idx1, q = idx5
  step 2: p = idx2, q = idx2      → entrance = index 2 (value 0)

phase 3   from idx4: 5, 2, 3, 4   → cycle length = 4
```

### Interview explanation
"I'll use Floyd's tortoise and hare instead of a hash set. `slow` moves one node per step,
`fast` two, guarded by `fast != nil && fast.Next != nil`. If the list ends, `fast` hits nil
and there's no cycle. If there is one, then once both pointers are inside it the gap between
them shrinks by exactly one per step, so it can't skip past zero — they must land on the
same node. To get the entrance I reset one pointer to the head and advance both by one:
the head-to-entrance distance equals the meeting-point-to-entrance distance modulo full
laps, so they meet at the start of the loop. O(n) time, O(1) space."

---

## 5. Generic Templates

> `slow += 1`, `fast += 2`. Meet ⇒ cycle. Reset one to head ⇒ entrance. Lap it ⇒ length.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// DetectCycle returns the cycle's entrance node and its length.
// It returns (nil, 0) when the list is acyclic.
func DetectCycle(head *ListNode) (*ListNode, int) {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next      // +1
        fast = fast.Next.Next // +2
        if slow == fast {     // pointer identity, never value equality
            return cycleFacts(head, slow)
        }
    }
    return nil, 0 // fast ran off the end
}

// cycleFacts turns a meeting node into (entrance, length).
func cycleFacts(head, meeting *ListNode) (*ListNode, int) {
    // Entrance: head-to-entrance == meeting-to-entrance (mod full laps).
    p, q := head, meeting
    for p != q {
        p, q = p.Next, q.Next
    }
    entrance := p

    // Length: one full lap starting from the meeting node.
    length, n := 1, meeting.Next
    for n != meeting {
        n = n.Next
        length++
    }
    return entrance, length
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt


def detect_cycle(head):
    """Return (entrance, length), or (None, 0) if the list is acyclic."""
    slow = fast = head
    while fast and fast.next:
        slow = slow.next            # +1
        fast = fast.next.next       # +2
        if slow is fast:            # identity, never value equality
            return _cycle_facts(head, slow)
    return None, 0                  # fast ran off the end


def _cycle_facts(head, meeting):
    p, q = head, meeting            # entrance: equal distances mod full laps
    while p is not q:
        p, q = p.next, q.next
    length, n = 1, meeting.next     # length: one lap from the meeting node
    while n is not meeting:
        n, length = n.next, length + 1
    return p, length
```

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

// Returns the cycle entrance, or null when the list is acyclic.
ListNode detectCycle(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;           // +1
        fast = fast.next.next;      // +2
        if (slow == fast) {         // reference identity
            ListNode p = head;
            while (p != slow) { p = p.next; slow = slow.next; }
            return p;               // entrance
        }
    }
    return null;
}

int cycleLength(ListNode meeting) {
    int len = 1;
    for (ListNode n = meeting.next; n != meeting; n = n.next) len++;
    return len;
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v) : val(v), next(nullptr) {}
};

// Returns the cycle entrance, or nullptr when the list is acyclic.
ListNode* detectCycle(ListNode* head) {
    ListNode *slow = head, *fast = head;
    while (fast && fast->next) {
        slow = slow->next;          // +1
        fast = fast->next->next;    // +2
        if (slow == fast) {         // pointer identity
            ListNode* p = head;
            while (p != slow) { p = p->next; slow = slow->next; }
            return p;               // entrance
        }
    }
    return nullptr;
}

int cycleLength(ListNode* meeting) {
    int len = 1;
    for (ListNode* n = meeting->next; n != meeting; n = n->next) len++;
    return len;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Cycle Detection (Optimal) |
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

### Problem — Cycle (LeetCode 141)
Given the head of a linked list, return `true` if some node's `Next` eventually points back
to an earlier node, forming a loop. Do it without extra memory.

### Thought Process
1. A visited-set answers it in O(n) memory; the interviewer wants O(1).
2. Send `slow` forward one node per step and `fast` two.
3. No cycle → `fast` runs out of list and the guard stops the loop → `false`.
4. Cycle → both pointers end up inside it, the gap shrinks by exactly 1 per step, so it must
   hit 0 → they land on the same node → `true`.
5. Compare **nodes, not values** — a valid list may hold the same number twice.

### Dry Run

Input: `1 → 2 → 3 → 4`, with node `4`'s `Next` pointing back at node `2`.

```text
idx  :  0    1    2    3
value:  1 →  2 →  3 →  4
             ↑         │
             └─────────┘        L = 1, C = 3
```

| step | `slow` (+1) | `fast` (+2) | gap around the loop | same node? |
|------|-------------|-------------|---------------------|------------|
| start| `idx0 (1)`  | `idx0 (1)`  | — (not in the loop yet) | — |
| 1    | `idx1 (2)`  | `idx2 (3)`  | 2 | no |
| 2    | `idx2 (3)`  | `idx1 (2)`  | 1 | no |
| 3    | `idx3 (4)`  | `idx3 (4)`  | 0 | **yes → `true`** |

Output: **`true`**

The gap column is the whole proof: `2 → 1 → 0`. It falls by exactly one each step, so it
can never jump over zero.

For an acyclic list such as `1 → 2`: step 1 gives `slow = idx1`, `fast = nil`, the guard
`fast != nil` fails, and the answer is `false`.

### Visualization

```text
step 1        1     2     3     4
                    ↑     ↑
                  slow   fast          gap = 2

step 2        1     2     3     4
                    ↑     ↑
                  fast   slow          gap = 1   (fast wrapped around)

step 3        1     2     3     4
                                ↑↑
                          slow, fast   gap = 0   → cycle
```

### Code

```go
func hasCycle(head *ListNode) bool {
    slow, fast := head, head
    // fast takes two hops, so it and its successor must both exist.
    for fast != nil && fast.Next != nil {
        slow = slow.Next      // +1
        fast = fast.Next.Next // +2
        if slow == fast {     // pointer identity, not value equality
            return true
        }
    }
    return false // fast ran off the end
}
```

```python
def hasCycle(head):
    slow = fast = head
    while fast and fast.next:   # fast needs two nodes ahead of it
        slow = slow.next        # +1
        fast = fast.next.next   # +2
        if slow is fast:        # identity, not value equality
            return True
    return False                # fast ran off the end
```

### Complexity
Time O(n) — `slow` walks at most `L + C` nodes before the meeting. Space **O(1)** — two
pointers, no set.

---

## 10. Solved Example 2

### Problem — Cycle II (LeetCode 142)
Same list, harder question: return the **node where the cycle begins**, or `nil` if there
is no cycle. Still O(1) space.

### Thought Process
1. Run phase 1 exactly as in Example 1 to get a meeting node — but that node is somewhere
   *inside* the loop, not its entrance.
2. Name the distances: `L` = head → entrance, `C` = loop length, `k` = entrance → meeting
   (measured forward around the loop).
3. `fast` walked twice as far as `slow`, and the surplus is whole laps, which gives
   `L = m·C − k` (chapter 08 derives this step by step).
4. Read it in English: *head → entrance* and *meeting → entrance* are the same distance,
   up to extra full laps that change nothing about where you land.
5. So reset one pointer to `head`, leave the other at the meeting node, step both by one,
   and the node where they collide is the entrance.

### Dry Run

Input: `3 → 2 → 0 → 4 → 2 → 1`, with the last node pointing back at index 2.

```text
idx  :  0    1    2    3    4    5
value:  3 →  2 →  0 →  4 →  2 →  1
                  ↑                │
                  └────────────────┘      L = 2, C = 4
```

**Phase 1 — find a meeting node**

| step | `slow` (+1) | `fast` (+2) | met? |
|------|-------------|-------------|------|
| start| `idx0`      | `idx0`      | — |
| 1    | `idx1`      | `idx2`      | no |
| 2    | `idx2`      | `idx4`      | no |
| 3    | `idx3`      | `idx2`      | no |
| 4    | `idx4`      | `idx4`      | **yes** |

Meeting at `idx4`, so `k = 2` (entrance `idx2` → `idx3` → `idx4`).
Check the identity: `L = m·C − k` → `2 = 1·4 − 2` ✓.

**Phase 2 — walk both at speed 1**

| step | `p` (from head) | `q` (from meeting) | equal? |
|------|-----------------|--------------------|--------|
| start| `idx0`          | `idx4`             | no |
| 1    | `idx1`          | `idx5`             | no |
| 2    | `idx2`          | `idx2`             | **yes** |

Output: **the node at index 2 (value `0`)** — the cycle entrance.

Phase 2 took exactly `L = 2` steps, which is what the identity promised.

### Visualization

```text
     ├─── L = 2 ───┤
     3 ──▶ 2 ──▶ ( 0 ──▶ 4 )
                   ▲       │
                   │       ▼
                 ( 1 ◀── 2 )
                           ▲
                       meeting (k = 2 past the entrance)

phase 2:  p ─┐                     ┌─ q
             3 ▸ 2 ▸ 0        4 ▸ 2 ▸ 1 ▸ 0
             └─2 steps─┘       └──2 steps──┘
                       both land on 0
```

### Code

```go
func detectCycle(head *ListNode) *ListNode {
    // Phase 1: does a cycle exist, and where do they meet?
    slow, fast := head, head
    for {
        if fast == nil || fast.Next == nil {
            return nil // no cycle
        }
        slow = slow.Next
        fast = fast.Next.Next
        if slow == fast {
            break // meeting node found (somewhere inside the loop)
        }
    }
    // Phase 2: L == distance from the meeting node to the entrance.
    p := head
    for p != slow {
        p = p.Next
        slow = slow.Next
    }
    return p // the entrance
}
```

```python
def detectCycle(head):
    # Phase 1: does a cycle exist, and where do they meet?
    slow = fast = head
    while True:
        if fast is None or fast.next is None:
            return None                  # no cycle
        slow = slow.next
        fast = fast.next.next
        if slow is fast:
            break                        # meeting node inside the loop
    # Phase 2: L == distance from the meeting node to the entrance.
    p = head
    while p is not slow:
        p = p.next
        slow = slow.next
    return p                             # the entrance
```

### Complexity
Time O(n) — phase 1 is at most `L + C` steps, phase 2 exactly `L`. Space O(1).

---

## 11. Solved Example 3

### Problem — Find Duplicate (LeetCode 287)
An array `nums` of `n+1` integers, each in `[1, n]`, contains exactly one repeated value.
Return it **without modifying the array and using O(1) extra space**.

### Thought Process
1. Sorting or a seen-set both break a stated constraint, so the array itself must become
   the data structure.
2. Read `nums` as a linked list: node `i` has `Next = nums[i]`. Every value is in `[1, n]`,
   so every "pointer" is a valid index — this walk can never fall off the end.
3. Start at index `0`. Nothing points *to* index `0` (values are ≥ 1), so index `0` sits
   outside the loop — exactly the "tail leading into a cycle" shape.
4. Two different indices holding the same value are two nodes pointing at one node — that
   node is the cycle entrance.
5. So the duplicate **is** the entrance, and Floyd finds it: phase 1 to meet, phase 2 to
   walk one pointer from index `0`.

### Dry Run

Input: `nums = [1, 3, 4, 2, 2]`

```text
index :  0    1    2    3    4
value :  1    3    4    2    2

as a list:  0 → 1 → 3 → 2 → 4 → 2 → 4 → ...
                        ↑         │
                        └─────────┘     entrance = 2 (the duplicate)
```

**Phase 1** — `slow = nums[slow]`, `fast = nums[nums[fast]]`

| step | `slow` | `fast` | equal? |
|------|--------|--------|--------|
| init | `nums[0] = 1` | `nums[nums[0]] = nums[1] = 3` | no |
| 1    | `nums[1] = 3` | `nums[nums[3]] = nums[2] = 4` | no |
| 2    | `nums[3] = 2` | `nums[nums[4]] = nums[2] = 4` | no |
| 3    | `nums[2] = 4` | `nums[nums[4]] = nums[2] = 4` | **yes** |

**Phase 2** — restart `p` at index `0`, both move one hop

| step | `p` | `slow` | equal? |
|------|-----|--------|--------|
| start| `0` | `4`    | no |
| 1    | `nums[0] = 1` | `nums[4] = 2` | no |
| 2    | `nums[1] = 3` | `nums[2] = 4` | no |
| 3    | `nums[3] = 2` | `nums[4] = 2` | **yes** |

Output: **`2`** — and indeed `nums[3] = nums[4] = 2`.

Two indices point at `2`, which is precisely what makes `2` the entrance node.

### Visualization

```text
0 ──▶ 1 ──▶ 3 ──▶ 2 ──▶ 4
                  ▲      │
                  └──────┘

indices 3 and 4 both hold the value 2
  ⇒ two arrows converge on node 2
  ⇒ node 2 is where the cycle begins
  ⇒ 2 is the duplicate
```

### Code

```go
func findDuplicate(nums []int) int {
    // Phase 1: i -> nums[i] is a linked list; find a meeting point.
    slow, fast := nums[0], nums[nums[0]]
    for slow != fast {
        slow = nums[slow]       // +1 hop
        fast = nums[nums[fast]] // +2 hops
    }
    // Phase 2: index 0 is outside the loop, so walk from there.
    p := 0
    for p != slow {
        p = nums[p]
        slow = nums[slow]
    }
    return p // the cycle entrance == the duplicated value
}
```

```python
def findDuplicate(nums):
    # Phase 1: i -> nums[i] is a linked list; find a meeting point.
    slow, fast = nums[0], nums[nums[0]]
    while slow != fast:
        slow = nums[slow]            # +1 hop
        fast = nums[nums[fast]]      # +2 hops
    # Phase 2: index 0 is outside the loop, so walk from there.
    p = 0
    while p != slow:
        p = nums[p]
        slow = nums[slow]
    return p                         # entrance == duplicated value
```

### Complexity
Time O(n) — both phases are linear in the number of "nodes". Space **O(1)** — four `int`
variables, and `nums` is never written to.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 141 | Cycle | Easy | Core linked lists application |
| 142 | Cycle II | Easy | Core linked lists application |
| 287 | Find Duplicate | Medium | Core linked lists application |
| 202 | Happy Number | Medium | Core linked lists application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Cycle Detection logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Cycle Detection (Linked Lists).
- **Signal:** cycle, floyd, linked list, loop, fast slow.
- **Move:** Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.
- **Cost:** O(n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Cycle Detection invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Cycle Detection
FAMILY : Linked Lists (Intermediate)
WHEN   : cycle, floyd, linked list, loop, fast slow
DO     : Most list problems are pointer-rewiring; a dummy sentinel removes head edge case
TIME   : O(n)    SPACE: O(1)
PRACTICE: 141, 142, 287, 202
```

---

*Part of the DSA Patterns Handbook — pattern 49 of 100.*
