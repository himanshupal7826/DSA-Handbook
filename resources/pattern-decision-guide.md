# 🧭 Pattern Decision Guide

A fast text reference that mirrors the interactive **Pattern Selector**. Read top-down; the first match usually wins.

## By problem phrasing
| If the problem says… | Reach for | Patterns |
|----------------------|-----------|----------|
| "anagram / count / duplicate / frequency" | Frequency Counter / HashMap | 01, 02 |
| "range sum / subarray sum" | Prefix Sum / Difference Array | 03, 04 |
| "pair/triplet summing to target", sorted | Two Pointers / k-Sum | 06, 10, 11 |
| "contiguous subarray/substring" + constraint | Sliding Window | 13–19 |
| "longest / shortest window" | Variable Sliding Window | 14, 15, 16 |
| "sorted array, find X in O(log n)" | Binary Search | 20–24 |
| "minimize the maximum / maximize the minimum" | Binary Search on Answer | 25 |
| "rotated sorted array" | Rotated Binary Search | 26 |
| "overlapping intervals / merge / rooms" | Intervals / Sweep Line | 29–33 |
| "next greater / warmer / span" | Monotonic Stack | 34–39 |
| "sliding window maximum" | Monotonic Deque | 40, 41 |
| "top K / K closest / Kth largest" | Heap | 43, 44 |
| "median of a stream" | Two Heaps | 45, 47 |
| "merge K sorted …" | K-way Merge Heap | 46 |
| "reverse / cycle / middle of list" | Linked List techniques | 48–52 |
| "tree depth / path / ancestor" | Tree DFS / BFS / DP | 53–60 |
| "shortest path, unweighted" | BFS | 42, 61 |
| "shortest path, weighted ≥ 0" | Dijkstra | 65 |
| "shortest path, negative edges" | Bellman-Ford | 66 |
| "all-pairs shortest path" | Floyd-Warshall | 67 |
| "connected components / dynamic connectivity" | Union-Find | 64 |
| "prerequisites / ordering / DAG" | Topological Sort | 63 |
| "connect all nodes at min cost" | MST (Kruskal/Prim) | 68 |
| "all subsets / permutations / combinations" | Backtracking | 69–73 |
| "min/max/count with optimal substructure" | Dynamic Programming | 74–84 |
| "take/skip with capacity" | 0/1 Knapsack | 74 |
| "fewest coins / ways to make amount" | Coin Change | 77 |
| "longest increasing / common subsequence" | LIS / LCS | 78, 79 |
| "locally optimal is globally safe" | Greedy | 85–88 |
| "prefix / autocomplete / word dictionary" | Trie | 89 |
| "range query + update" | Segment / Fenwick Tree | 90, 91 |
| "static range min/max" | Sparse Table | 92 |
| "n ≤ 20, subset states" | Bitmask DP | 93 |
| "n ≤ 40 subset sum" | Meet in the Middle | 94 |

## By data structure
- **Array / String** → 01–28, 34–41, 69–84, 90–94, 100
- **Linked List** → 08, 46, 48–52
- **Tree** → 53–60, 82, 95, 96
- **Graph / Grid** → 42, 61–68, 81, 97–99
- **Numbers / Math** → 08, 28, 84, 94

## The 3-question triage
1. **What's the structure?** (array, list, tree, graph, intervals, numbers)
2. **What's the objective?** (exists, count, longest/shortest, Kth, order, all combinations)
3. **What do the constraints allow?** (use the Big-O cheat sheet to pick the target complexity)

Answer these and the pattern is usually obvious. When unsure, open the interactive **[Pattern Selector](../pattern-selector.html)**.
