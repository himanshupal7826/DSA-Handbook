# 10 · Linear Algebra & Matrix Ops

> **In one line:** NumPy speaks BLAS/LAPACK — `@` for matrix products, `linalg.solve` instead of inverting, and `eig`/`svd` for the geometry underneath your data.

---

## 1. Overview

Almost every numerical workload — least squares, PCA, graph algorithms, neural nets, physics sims — bottoms out in **matrix arithmetic**. NumPy doesn't reimplement it; it dispatches to the same tuned **BLAS** (matrix products) and **LAPACK** (solvers, decompositions) libraries that MATLAB and R use. Your job is to phrase the problem so a single call does the heavy lifting.

The recurring beginner trap is treating `*` as matrix multiply. In NumPy `*` is **element-wise**; the matrix product is `@` (or `np.matmul` / `np.dot`). Getting this wrong produces silently-broadcast garbage rather than an error.

The second recurring trap is *inverting a matrix* to solve `Ax = b`. Computing `inv(A) @ b` is slower and numerically worse than `np.linalg.solve(A, b)`. Reach for a solver, a decomposition, or a norm — almost never an explicit inverse.

This page covers the product operators, the solve-vs-inverse decision, vector/matrix **norms**, the **eig** and **svd** decompositions, and how **broadcasting** turns `matmul` into a batched (stacked) operation for free.

## 2. Core Concepts

- **`*` is element-wise**, `@` is the matrix product. They coincide only for scalars.
- **`np.dot(a, b)`** — 1-D·1-D = inner product (scalar); 2-D·2-D = matrix product; N-D uses a last-axis/second-to-last-axis rule.
- **`np.matmul` / `@`** — like `dot` for 2-D, but **broadcasts the leading dims** as a stack of matrices. Rejects scalar operands. Prefer it.
- **`np.linalg.solve(A, b)`** — solves `Ax = b` via LU factorization. Faster and more accurate than `inv(A) @ b`.
- **`np.linalg.inv`** — the explicit inverse. Needed rarely (e.g. a covariance you'll reuse many times); usually a code smell.
- **Norm** — `np.linalg.norm` measures size: `ord=2` Euclidean (default for vectors), `ord=1`, `ord=np.inf`, `'fro'` for matrices.
- **Eigendecomposition** — `eig`/`eigh` factor `A = V Λ V⁻¹`; `eigh` is the fast, stable path for **symmetric/Hermitian** matrices.
- **SVD** — `U S Vᵀ = svd(A)` works for *any* shape; the Swiss-army knife behind PCA, pseudo-inverse, rank, and low-rank compression.
- **Batched matmul** — stack matrices in an array of shape `(N, m, k)` and `@` multiplies all N pairs at once via broadcasting.
- **Conditioning** — `np.linalg.cond(A)` warns when a "solvable" system is numerically fragile.

## 3. Syntax & Examples

```python
import numpy as np

a = np.array([[1., 2.],
              [3., 4.]])
b = np.array([[5., 6.],
              [7., 8.]])

a * b          # element-wise (Hadamard)
a @ b          # matrix product
np.matmul(a, b)  # same as @
np.dot(a, b)     # same for 2-D
```

```text
element-wise a*b:
[[ 5. 12.]
 [21. 32.]]
matrix a@b:
[[19. 22.]
 [43. 50.]]
```

Vector inner vs outer product:

```python
u = np.array([1., 2., 3.])
v = np.array([4., 5., 6.])

u @ v              # inner product -> scalar 32.0
np.outer(u, v)     # 3x3 outer product
```

```text
u @ v = 32.0
outer:
[[ 4.  5.  6.]
 [ 8. 10. 12.]
 [12. 15. 18.]]
```

Norms:

```python
x = np.array([3., 4.])
np.linalg.norm(x)              # 5.0  (L2)
np.linalg.norm(x, ord=1)       # 7.0  (L1)
np.linalg.norm(a, ord='fro')   # Frobenius norm of matrix a
```

## 4. Worked Example

**Solve a linear system three ways and compare.** We solve `Ax = b` for a well-posed 3×3 system, then check the solver against the (discouraged) inverse.

```python
import numpy as np

A = np.array([[ 3.,  2., -1.],
              [ 2., -2.,  4.],
              [-1.,  0.5, -1.]])
b = np.array([1., -2., 0.])

x_solve = np.linalg.solve(A, b)          # preferred
x_inv   = np.linalg.inv(A) @ b           # discouraged

print("solve :", x_solve)
print("inv@b :", x_inv)
print("residual ||Ax-b|| :", np.linalg.norm(A @ x_solve - b))
print("condition number  :", np.linalg.cond(A))
```

```text
solve : [ 1.  -2.  -2. ]
inv@b : [ 1.  -2.  -2. ]
residual ||Ax-b|| : 4.4e-16
condition number  : 6.36
```

Both agree here because the matrix is well-conditioned (`cond ≈ 6`). On ill-conditioned matrices the residual from `inv` grows faster than from `solve`, and `solve` also runs ~2–3× fewer FLOPs because it never forms the full inverse.

## 5. Under the Hood

`solve` runs an **LU factorization** (LAPACK `gesv`): decompose `A = P·L·U` once, then do cheap forward/back substitution against `b`. Computing `inv(A)` internally solves `A·X = I` — i.e. it does the same factorization plus *n* extra substitutions to build all *n* columns of the inverse, then you pay another matmul. So `inv(A) @ b` is strictly more work and accumulates more rounding error.

`matmul` with stacked inputs treats every leading axis as a **batch dimension** and broadcasts them, calling BLAS `gemm` per matrix pair.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">solve(A, b): factor once, substitute — never form the inverse</text>

  <rect x="30" y="60" width="120" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="90" text-anchor="middle" fill="#1e293b">A · x = b</text>
  <text x="90" y="112" text-anchor="middle" fill="#64748b">system</text>

  <path d="M156 95 L214 95" stroke="#475569" fill="none" marker-end="url(#arrow)"/>

  <rect x="220" y="60" width="150" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="295" y="86" text-anchor="middle" fill="#1e293b">LU: A = P·L·U</text>
  <text x="295" y="108" text-anchor="middle" fill="#64748b">one factorization</text>

  <path d="M376 95 L434 95" stroke="#475569" fill="none" marker-end="url(#arrow)"/>

  <rect x="440" y="60" width="170" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="525" y="86" text-anchor="middle" fill="#1e293b">fwd/back subst.</text>
  <text x="525" y="108" text-anchor="middle" fill="#64748b">solve for x</text>

  <rect x="220" y="185" width="390" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="415" y="211" text-anchor="middle" fill="#1e293b">inv(A) @ b : same LU + n extra substitutions to build A⁻¹ + a matmul</text>
  <text x="415" y="233" text-anchor="middle" fill="#b91c1c">more FLOPs, more rounding error — avoid</text>

  <path d="M90 130 L90 220 L214 220" stroke="#475569" fill="none" stroke-dasharray="4 3" marker-end="url(#arrow)"/>
  <text x="120" y="180" fill="#64748b">the tempting detour</text>
</svg>
```

## 6. Variations & Trade-offs

| Operation | Call | Shapes | When |
|---|---|---|---|
| Element-wise | `A * B` | equal / broadcastable | scaling, masks, Hadamard |
| Matrix product | `A @ B`, `matmul` | `(…,m,k)·(…,k,n)` | the default product; batched |
| Generalized dot | `np.dot` | 1-D→scalar, 2-D→matrix | inner products, legacy code |
| Einstein sum | `np.einsum('ij,jk->ik', A, B)` | arbitrary | custom contractions, one-liners |
| Solve system | `linalg.solve(A, b)` | square `A` | `Ax=b`, one/few RHS |
| Least squares | `linalg.lstsq(A, b)` | tall/wide `A` | over/under-determined |
| Explicit inverse | `linalg.inv(A)` | square | reuse of A⁻¹ many times |
| Symmetric eig | `linalg.eigh(A)` | symmetric | covariance, PCA, stable |
| General eig | `linalg.eig(A)` | square | non-symmetric, complex λ |
| SVD | `linalg.svd(A)` | any | rank, PCA, pseudo-inverse |

`@` vs `dot`: prefer `@`/`matmul` — it broadcasts batches and *rejects* scalars, which catches bugs `dot` would silently accept. Use `einsum` when you need a contraction that doesn't map to a single product (e.g. batched `'bij,bjk->bik'` or a trace `'ii->'`).

`eig` vs `eigh`: if the matrix is symmetric, `eigh` is faster, returns **real** eigenvalues in ascending order, and is numerically stable. Using `eig` on a symmetric matrix wastes cycles and can return tiny imaginary parts.

## 7. Production / Performance Notes

- **Link a real BLAS.** `np.show_config()` should report OpenBLAS or MKL. The reference/no-BLAS build can be 10–100× slower on large matmuls.
- **`matmul` is multi-threaded** inside BLAS. Nesting NumPy matmul inside a Python thread/process pool can oversubscribe cores — cap threads with `OMP_NUM_THREADS`.
- **Dtype matters.** `float32` matmul is ~2× the throughput of `float64` and uses half the memory — great for ML, risky for ill-conditioned solves. Never do heavy linear algebra in `float16` on CPU.
- **Batched > Python loop.** Multiplying 1000 small matrices via a single `(1000,m,k) @ (1000,k,n)` call beats a `for` loop by orders of magnitude — one BLAS dispatch, no interpreter overhead.
- **`solve` over `inv`** everywhere: least squares → `lstsq`; positive-definite systems → `scipy.linalg.cho_solve`; repeated RHS → factor once with `scipy.linalg.lu_factor`.
- **Truncated SVD** (`scipy.sparse.linalg.svds` / sklearn `TruncatedSVD`) for large low-rank problems — full `svd` on a 100k×100k matrix will OOM.
- **Contiguity.** BLAS is fastest on C- or F-contiguous arrays; a transposed view is free, but fancy-indexed non-contiguous input forces a copy.

## 8. Common Mistakes

1. ⚠️ **Using `*` for matrix multiply.** `A * B` is element-wise. Fix: use `A @ B`.
2. ⚠️ **`inv(A) @ b` to solve a system.** Slower, less accurate. Fix: `np.linalg.solve(A, b)`.
3. ⚠️ **Inverting to solve least squares.** For non-square `A`, `inv` fails. Fix: `np.linalg.lstsq(A, b, rcond=None)`.
4. ⚠️ **`eig` on a symmetric matrix.** Returns complex dust and is slower. Fix: use `eigh`.
5. ⚠️ **Ignoring `LinAlgError: Singular matrix`.** The matrix is (near) rank-deficient. Fix: check `cond`, add regularization, or use `lstsq`/`pinv`.
6. ⚠️ **Assuming `svd` returns V, not Vᵀ.** NumPy returns `Vh = Vᵀ`; reconstruct with `U @ np.diag(S) @ Vh`.
7. ⚠️ **Mismatched inner dimensions.** `(m,k)@(n,p)` with `k≠n` raises — read the shapes, the *inner* pair must match.
8. ⚠️ **Norm default confusion.** `norm(matrix)` defaults to Frobenius, not spectral; pass `ord=2` explicitly if you want the spectral norm.

## 9. Interview Questions

**Q: What is the difference between `*`, `np.dot`, and `@` in NumPy?**
A: `*` is element-wise (Hadamard) multiplication. `@`/`np.matmul` is the matrix product and broadcasts leading batch dimensions. `np.dot` also does the matrix product for 2-D but uses a different last-axis rule for N-D and accepts scalars; prefer `@` for clarity and batching.

**Q: Why should you use `np.linalg.solve` instead of `np.linalg.inv` to solve `Ax = b`?**
A: `solve` does one LU factorization plus a substitution — fewer FLOPs and less rounding error. `inv` computes the full inverse (solving A·X=I) and then a matmul, which is strictly more work and numerically worse, especially for ill-conditioned matrices.

**Q: When would you legitimately compute an explicit inverse?**
A: When you truly reuse `A⁻¹` against many independent right-hand sides in a context where a factorization can't be cached, or when a formula genuinely needs the inverse (e.g. a Mahalanobis distance with a fixed precision matrix). Even then, caching an LU/Cholesky factor is usually better.

**Q: What does the condition number tell you?**
A: `cond(A)` bounds how much relative error in `b` amplifies into `x`. A large condition number (say ≫ 1/machine-eps) means the system is ill-conditioned: "solvable" on paper but numerically unreliable.

**Q: Difference between `eig` and `eigh`?**
A: `eigh` is for symmetric/Hermitian matrices — it returns real eigenvalues (sorted ascending) using a faster, stable algorithm. `eig` handles general square matrices and may return complex eigenvalues. Use `eigh` whenever the matrix is symmetric.

**Q: What is the SVD and why is it so useful?**
A: `A = U S Vᵀ` factors any matrix into rotations (U, V) and non-negative scaling (S). It gives rank, the pseudo-inverse, the best low-rank approximation (Eckart–Young), and is the numerically stable backbone of PCA and least squares.

**Q: How does `matmul` handle arrays with more than two dimensions?**
A: It treats all but the last two axes as batch dimensions, broadcasts them, and does a matrix product on each trailing `(m,k)·(k,n)` pair — "stacked" or batched matmul, computed in one BLAS-backed call.

**Q: How do you multiply 1000 small matrices efficiently?**
A: Stack them into arrays of shape `(1000, m, k)` and `(1000, k, n)` and use `@`. Broadcasting the batch axis runs a single vectorized dispatch instead of a Python loop.

**Q: (Senior) Your `solve` raises `Singular matrix` in production — how do you make it robust?**
A: Detect near-singularity via `cond`; switch to `lstsq` or `pinv` (SVD-based, handles rank deficiency); add Tikhonov regularization (`AᵀA + λI`); or reformulate to drop collinear features. Log the condition number so you catch drift early.

**Q: (Senior) How do PCA and eigendecomposition relate to SVD?**
A: PCA eigendecomposes the covariance `XᵀX/(n-1)`. Equivalently, the right singular vectors of centered `X` are the principal directions and the singular values squared give the variances. SVD on `X` is preferred — it avoids forming `XᵀX` (which squares the condition number).

**Q: (Senior) Why can `float32` linear algebra be dangerous, and when is it fine?**
A: `float32` has ~7 decimal digits; for ill-conditioned solves it loses accuracy fast and can diverge. It's fine for well-conditioned, error-tolerant workloads like neural-net inference where the 2× speed/memory win dominates. Reserve `float64` for solvers and anything numerically sensitive.

## 10. Practice

- [ ] Build a 4×4 matrix and verify `A @ B != A * B`; explain each entry of both results.
- [ ] Solve a 3×3 system with `solve` and with `inv(A) @ b`; compare residual norms and timings.
- [ ] Center a data matrix and compute principal directions two ways: `eigh` on the covariance and `svd` on the data. Confirm they match.
- [ ] Create a `(500, 3, 3)` stack and batched-multiply it against a `(500, 3, 1)` stack in one call; verify against a Python loop.
- [ ] Take an ill-conditioned matrix (e.g. a Hilbert matrix), print its `cond`, and watch `inv`-based solving degrade versus `lstsq`.

## 11. Cheat Sheet

> [!TIP]
> **Products:** `*` = element-wise, `@`/`matmul` = matrix product (batches!), `dot` = legacy. **Solve `Ax=b`:** `np.linalg.solve(A,b)` — never `inv(A)@b`. **Least squares:** `lstsq`. **Norms:** `norm(x)`=L2, `ord=1/np.inf/'fro'`. **Decomps:** `eigh` (symmetric) / `eig` (general) / `svd` (any shape → U,S,Vh). **Batched:** stack as `(N,m,k)` and `@`. **Check health:** `cond(A)` before trusting a solve. Link a real BLAS (`show_config`), match inner dims, use `float64` for solvers.

**References:** NumPy `numpy.linalg` docs, LAPACK Users' Guide, "Numerical Linear Algebra" (Trefethen & Bau), SciPy linalg tutorial

---
*NumPy & Pandas Handbook — topic 10.*
