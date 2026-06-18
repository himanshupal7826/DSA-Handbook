# ⏱️ Big-O Cheat Sheet

## Growth rates (best → worst)
`O(1) < O(log n) < O(√n) < O(n) < O(n log n) < O(n²) < O(n³) < O(2ⁿ) < O(n!)`

## What the constraints tell you (competitive heuristic)
| n (max) | Acceptable complexity | Likely technique |
|---------|----------------------|------------------|
| ≤ 12 | O(n!) | Permutations, brute force |
| ≤ 20 | O(2ⁿ) | Bitmask DP, subsets, meet-in-the-middle |
| ≤ 100 | O(n³) / O(n⁴) | Floyd-Warshall, interval DP |
| ≤ 1,000 | O(n²) | DP grids, nested loops |
| ≤ 10⁵ | O(n log n) | Sort, heap, binary search, segment tree |
| ≤ 10⁶ | O(n) / O(n log n) | Sliding window, two pointers, prefix sums |
| ≤ 10⁸ | O(n) tight | Single linear pass, simple math |
| > 10⁸ | O(log n) / O(1) | Closed form, binary search on answer |

## Common data structure operations
| Structure | Access | Search | Insert | Delete | Notes |
|-----------|--------|--------|--------|--------|-------|
| Array | O(1) | O(n) | O(n) | O(n) | Cache-friendly |
| Hash Map | — | O(1)* | O(1)* | O(1)* | *amortized; O(n) worst |
| Balanced BST / TreeMap | O(log n) | O(log n) | O(log n) | O(log n) | Ordered |
| Binary Heap | O(1) peek | O(n) | O(log n) | O(log n) | Priority queue |
| Stack / Queue | — | O(n) | O(1) | O(1) | LIFO / FIFO |
| Linked List | O(n) | O(n) | O(1)† | O(1)† | †given the node |
| Trie | — | O(L) | O(L) | O(L) | L = key length |
| Union-Find | — | O(α(n)) | O(α(n)) | — | ~O(1) amortized |
| Fenwick / Segment Tree | — | O(log n) | O(log n) | O(log n) | Range queries |

## Sorting algorithms
| Algorithm | Best | Average | Worst | Space | Stable |
|-----------|------|---------|-------|-------|--------|
| Quicksort | O(n log n) | O(n log n) | O(n²) | O(log n) | No |
| Mergesort | O(n log n) | O(n log n) | O(n log n) | O(n) | Yes |
| Heapsort | O(n log n) | O(n log n) | O(n log n) | O(1) | No |
| Counting/Radix | O(n+k) | O(n+k) | O(n+k) | O(n+k) | Yes |

## Amortized analysis quick notes
- **Dynamic array push:** O(1) amortized (doubling).
- **Monotonic stack/queue:** O(n) total — each element pushed/popped once.
- **Two pointers / sliding window:** O(n) — each index visited O(1) times.
- **Union-Find with path compression + rank:** O(α(n)) ≈ O(1).
