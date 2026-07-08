# 05 · Linear Algebra for AI

> **In one line:** Vectors and matrices are how AI represents data and transforms it; the dot product measures similarity and matrix multiplication is the single operation underlying every layer of every model.

---

## 1. Overview

Linear algebra is the **native language of machine learning**. Every input — an image, a sentence, a user profile — becomes a **vector** of numbers. Every learned transformation — a neural-network layer, an attention head, a PCA projection — is a **matrix** multiplied against those vectors. When you hear that a model has "billions of parameters," those parameters are the entries of matrices. Understanding vectors, matrices, dot products, and matrix multiplication is not optional background; it *is* what models do at the arithmetic level.

The problem linear algebra solves for AI is **representing and manipulating high-dimensional data efficiently**. A single sentence embedding might live in 1,536 dimensions; a hidden layer might map 4,096 numbers to 4,096 others. Doing this with loops would be hopeless. Linear algebra packages these operations into a handful of dense array operations that GPUs execute in massively parallel fashion — one matrix multiply can do billions of multiply-adds at once. This is why the entire deep-learning stack (numpy, PyTorch, JAX) is built around the array as the primitive.

The historical motivation in one line: neural networks were reframed in the 1980s as compositions of linear maps and nonlinearities, and the GPU era (2012 onward) made large matrix multiplication cheap — turning linear algebra from theory into the engine of modern AI.

**Concrete example.** A recommendation system represents each user and each movie as a vector in the same space. To predict how much a user will like a movie, it takes the **dot product** of their two vectors — a single number measuring alignment. High dot product means "this user's tastes point the same way as this movie's attributes," so recommend it. That one operation, scaled to matrices, computes predictions for millions of user–movie pairs at once.

The durable mental model: **data are vectors, models are matrices, and learning is finding the matrix entries that make the transformations useful.**

## 2. Core Concepts

- **Scalar / vector / matrix / tensor** — a number; an ordered list of numbers (a point/direction in space); a 2-D grid of numbers (a linear transformation); an n-D array (the general case, e.g., a batch of image feature maps).
- **Vector** — an element of an n-dimensional space; represents a data point or a direction. Notated `x ∈ ℝⁿ`.
- **Dot product** — `x·y = Σ xᵢyᵢ`; a scalar measuring how aligned two vectors are; zero means orthogonal (unrelated).
- **Norm** — the length of a vector; the L2 norm `‖x‖₂ = √(Σ xᵢ²)` is the most common; used to normalize and to measure distance.
- **Matrix multiplication (matmul)** — combining two matrices so that `(AB)ᵢⱼ = Σₖ Aᵢₖ Bₖⱼ`; composes linear transformations and is the core op of every layer.
- **Matrix–vector product** — `Wx`: applies the linear transformation `W` to the vector `x`; one neural-network layer before the activation.
- **Transpose** — `Aᵀ`, flipping rows and columns; turns column vectors into row vectors and appears throughout gradient math.
- **Identity & inverse** — `I` leaves vectors unchanged; `A⁻¹` undoes `A` (when it exists); underpins solving linear systems.
- **Eigenvector / eigenvalue** — a vector whose direction is unchanged by `A` (`Av = λv`); reveals a matrix's principal axes; the basis of PCA.
- **Singular Value Decomposition (SVD)** — factorizes any matrix `A = UΣVᵀ` into rotation–scale–rotation; the workhorse behind dimensionality reduction and low-rank approximation.

## 3. Theory & Mathematical Intuition

The two ideas to internalize are the **dot product as similarity** and **matrix multiply as transformation**.

The dot product connects algebra to geometry:

```
x · y = Σ xᵢ yᵢ = ‖x‖ ‖y‖ cos(θ)
```

So the dot product is large and positive when vectors point the same way (`θ ≈ 0`), zero when orthogonal (`θ = 90°`), and negative when opposed. Normalizing both to unit length gives **cosine similarity** = `cos(θ)` directly — the standard way to compare embeddings in search and RAG.

A matrix–vector product is a **linear transformation**: it rotates, scales, and shears space. A neural layer is exactly `h = σ(Wx + b)` — apply the learned linear map `W`, shift by `b`, then bend with a nonlinearity `σ`. Stacking layers composes transformations, and composition of linear maps is itself matrix multiplication, which is why `matmul` dominates the flop count.

**Eigen/SVD** reveal a matrix's intrinsic structure. Eigenvectors are directions the matrix only stretches (not rotates); their eigenvalues are the stretch factors. PCA finds the eigenvectors of the data's covariance matrix — the directions of greatest variance — to compress data while keeping the most information. SVD generalizes this to any (even non-square) matrix and is how you get low-rank approximations (e.g., LoRA fine-tuning approximates a big weight update with two small matrices).

```svg
<svg viewBox="0 0 720 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="700" height="230" rx="12" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="34" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Dot product = alignment of directions</text>
  <line x1="120" y1="200" x2="120" y2="60" stroke="#1e293b" stroke-width="1"/>
  <line x1="120" y1="200" x2="320" y2="200" stroke="#1e293b" stroke-width="1"/>
  <line x1="120" y1="200" x2="290" y2="90" stroke="#0ea5e9" stroke-width="3"/>
  <text x="295" y="82" fill="#0ea5e9" font-size="12" font-weight="700">x</text>
  <line x1="120" y1="200" x2="250" y2="120" stroke="#16a34a" stroke-width="3"/>
  <text x="255" y="115" fill="#16a34a" font-size="12" font-weight="700">y</text>
  <path d="M 170 200 A 50 50 0 0 0 158 168" fill="none" stroke="#d97706" stroke-width="2"/>
  <text x="185" y="185" fill="#d97706" font-size="12">θ</text>
  <text x="150" y="225" fill="#1e293b" font-size="11">small θ → large x·y (similar)</text>
  <line x1="470" y1="200" x2="470" y2="60" stroke="#1e293b" stroke-width="1"/>
  <line x1="470" y1="200" x2="670" y2="200" stroke="#1e293b" stroke-width="1"/>
  <line x1="470" y1="200" x2="600" y2="90" stroke="#0ea5e9" stroke-width="3"/>
  <line x1="470" y1="200" x2="470" y2="90" stroke="#16a34a" stroke-width="3"/>
  <path d="M 470 150 A 50 50 0 0 0 500 162" fill="none" stroke="#d97706" stroke-width="2"/>
  <text x="510" y="120" fill="#d97706" font-size="12">90°</text>
  <text x="500" y="225" fill="#1e293b" font-size="11">orthogonal → x·y = 0 (unrelated)</text>
</svg>
```

## 4. Architecture & Workflow

How linear algebra flows through one forward pass of a neural network:

1. **Encode the input as a vector/tensor.** A 28×28 image flattens to a vector `x ∈ ℝ⁷⁸⁴`; a batch of 64 images becomes a matrix `X ∈ ℝ⁶⁴ˣ⁷⁸⁴`.
2. **Apply the first linear layer.** Multiply by the weight matrix: `Z₁ = X W₁ + b₁`, where `W₁ ∈ ℝ⁷⁸⁴ˣ²⁵⁶`. One matmul transforms all 64 samples at once.
3. **Apply a nonlinearity.** `A₁ = ReLU(Z₁)` — element-wise, bending the space so the network can model non-linear relationships.
4. **Repeat for deeper layers.** `Z₂ = A₁ W₂ + b₂`, and so on. Each layer is a matrix multiply plus a nonlinearity; depth = composition of transformations.
5. **Produce logits.** The final matrix maps to the number of classes: `Z_out ∈ ℝ⁶⁴ˣ¹⁰`.
6. **Normalize to probabilities.** Softmax turns each row of logits into a distribution.
7. **In attention (Transformers).** Queries, keys, values are matrices `Q, K, V`; the scores are the matmul `QKᵀ` (dot products of every query with every key), scaled and softmaxed, then `× V`.
8. **Backward pass.** Gradients flow back through the same matrices via transposes (`∂L/∂X = (∂L/∂Z) Wᵀ`), which is why transpose and matmul are the two ops the whole framework optimizes.

```svg
<svg viewBox="0 0 760 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="190" rx="12" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="34" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">A layer = matmul + bias + nonlinearity</text>
  <rect x="30" y="70" width="120" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="100" text-anchor="middle" fill="#1e293b" font-size="12">input X</text>
  <text x="90" y="120" text-anchor="middle" fill="#1e293b" font-size="10">(64 × 784)</text>
  <rect x="200" y="70" width="130" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="265" y="100" text-anchor="middle" fill="#1e293b" font-size="12">× W  (784×256)</text>
  <text x="265" y="120" text-anchor="middle" fill="#1e293b" font-size="10">+ bias b</text>
  <rect x="380" y="70" width="130" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="445" y="100" text-anchor="middle" fill="#1e293b" font-size="12">ReLU(Z)</text>
  <text x="445" y="120" text-anchor="middle" fill="#1e293b" font-size="10">element-wise</text>
  <rect x="560" y="70" width="170" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="645" y="100" text-anchor="middle" fill="#1e293b" font-size="12">output A (64×256)</text>
  <text x="645" y="120" text-anchor="middle" fill="#1e293b" font-size="10">feeds next layer</text>
  <line x1="150" y1="105" x2="198" y2="105" stroke="#16a34a" stroke-width="2"/>
  <line x1="330" y1="105" x2="378" y2="105" stroke="#16a34a" stroke-width="2"/>
  <line x1="510" y1="105" x2="558" y2="105" stroke="#16a34a" stroke-width="2"/>
  <text x="380" y="180" text-anchor="middle" fill="#1e293b" font-size="11">stack these → deep network; backward pass reuses Wᵀ</text>
</svg>
```

## 5. Implementation

**Vectors, dot products, and cosine similarity (numpy):**

```python
import numpy as np
a = np.array([1.0, 2.0, 3.0])
b = np.array([2.0, 0.0, 1.0])

dot = a @ b                              # 1*2 + 2*0 + 3*1 = 5.0
cos = (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b))
print(dot, round(cos, 3))                # 5.0 0.535  -> moderately aligned
```

**Matrix multiplication is one neural layer:**

```python
rng = np.random.default_rng(0)
X = rng.normal(size=(64, 784))           # batch of 64 flattened images
W = rng.normal(size=(784, 256)) * 0.01   # learned weights
b = np.zeros(256)

Z = X @ W + b                            # (64,784) @ (784,256) -> (64,256)
A = np.maximum(0, Z)                     # ReLU nonlinearity
print(A.shape)                           # (64, 256)  -> all 64 samples transformed at once
```

**Eigen / SVD for dimensionality reduction (PCA via SVD):**

```python
Xc = X - X.mean(axis=0)                  # center the data
U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
X_2d = Xc @ Vt[:2].T                     # project onto top-2 principal directions
print(X_2d.shape)                        # (64, 2)  -> 784 dims compressed to 2
explained = (S[:2]**2).sum() / (S**2).sum()
print(f"variance kept in 2D: {explained:.2%}")
```

**The same math on a GPU (PyTorch), with the optimization note built in:**

```python
import torch
X = torch.randn(64, 784, device="cuda" if torch.cuda.is_available() else "cpu")
W = torch.randn(784, 256, device=X.device) * 0.01
A = torch.relu(X @ W)                     # fused, parallel matmul on the GPU
print(A.shape)                            # torch.Size([64, 256])
```

> **Optimization note:** Never write Python loops over vector elements — always express the computation as a single vectorized array op. A `for`-loop dot product is orders of magnitude slower than `a @ b`, because BLAS/cuBLAS execute matmuls with cache-optimal, massively parallel kernels. On GPUs, keeping data in large contiguous tensors and batching many samples into one matmul is the single biggest performance lever in all of deep learning.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Vectorized ops (matmul) | Massively parallel, GPU-friendly, concise | Memory-hungry; big matrices can exhaust VRAM |
| Dot-product similarity | Cheap, meaningful for embeddings | Sensitive to scale unless normalized |
| Dimensionality reduction (PCA/SVD) | Compresses, denoises, visualizes | Loses information; assumes linear structure |
| Dense matrices | Simple, hardware-optimized | Wasteful when data is sparse |
| Eigen/SVD decompositions | Reveal structure; enable low-rank tricks (LoRA) | O(n³) cost; expensive on huge matrices |
| Low precision (fp16/bf16) | 2× faster, half the memory | Numerical instability if unmanaged |

## 7. Common Mistakes & Best Practices

1. ⚠️ Mismatched matrix shapes in a matmul. → ✅ Track shapes explicitly; inner dimensions must agree (`(m×k)@(k×n)`), and print `.shape` when debugging.
2. ⚠️ Comparing embeddings by raw dot product without normalizing. → ✅ Use cosine similarity (normalize to unit length) so magnitude doesn't dominate direction.
3. ⚠️ Writing Python loops over vector/matrix elements. → ✅ Vectorize with numpy/torch; loops are orders of magnitude slower and defeat BLAS.
4. ⚠️ Forgetting to center data before PCA. → ✅ Subtract the mean; PCA finds directions of variance around the centroid.
5. ⚠️ Confusing element-wise (`*`) with matrix (`@`) multiplication. → ✅ Know which you need; `*` is Hadamard, `@` is matmul — silent bugs otherwise.
6. ⚠️ Assuming every matrix is invertible. → ✅ Singular/near-singular matrices break `inv`; prefer `solve` or pseudo-inverse (SVD) for stability.
7. ⚠️ Ignoring numerical precision in large sums/exponentials. → ✅ Use stable implementations (subtract the max before softmax); mind fp16 overflow.
8. ⚠️ Transposing incorrectly in gradient/backprop math. → ✅ Derive shapes from first principles; the gradient w.r.t. input is `(∂L/∂Z) Wᵀ`.
9. ⚠️ Storing sparse data as dense matrices. → ✅ Use sparse formats (CSR) when most entries are zero to save memory and time.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Ninety percent of deep-learning bugs are **shape mismatches** and silent broadcasting. Assert tensor shapes at layer boundaries, and when a loss won't go down, print intermediate tensor norms — an exploding or vanishing norm localizes the bad layer.

**Monitoring.** Track weight and gradient **norms** during training; a norm blowing up signals instability (lower the learning rate or add gradient clipping), a norm collapsing to zero signals dead units. In inference, monitor embedding norms to catch drift in a vector search index.

**Security.** Embeddings can **leak information** — an attacker with vector access may reconstruct or infer the original input, so treat embeddings of sensitive data as sensitive. Validate the dimensionality and range of incoming vectors to a similarity search to prevent malformed-input attacks.

**Performance & Scaling.** Matmul is the flop bottleneck, so: batch aggressively, use mixed precision (bf16) with care, keep tensors contiguous on the GPU, and exploit structure — low-rank (LoRA), sparsity, or quantization to shrink matrices. For billion-scale similarity search, use approximate nearest-neighbor indexes (FAISS, HNSW) instead of exact dot products against every vector.

## 9. Interview Questions

**Q: Why is linear algebra central to machine learning?**
A: Because data are represented as vectors/tensors and every learned transformation is a matrix operation. A neural layer is a matrix multiply plus a nonlinearity, and "parameters" are matrix entries. Vectorized linear algebra also maps perfectly onto GPUs, making large models feasible.

**Q: What does the dot product measure, and how is it used in AI?**
A: It measures alignment between two vectors: `x·y = ‖x‖‖y‖cos θ`. Normalized, it gives cosine similarity, which is how embeddings are compared in semantic search, RAG retrieval, and recommendation. Zero means orthogonal (unrelated), positive means similar direction.

**Q: What is matrix multiplication doing geometrically?**
A: It applies (and composes) linear transformations — rotation, scaling, shearing — to vectors. Stacking neural-network layers composes these transformations, and composition of linear maps is itself a matrix multiply, which is why matmul dominates a model's computation.

**Q: What's the difference between element-wise and matrix multiplication?**
A: Element-wise (Hadamard, `*`) multiplies corresponding entries and requires matching shapes; matrix multiplication (`@`) contracts the inner dimension so `(m×k)@(k×n)=(m×n)`. Confusing them is a common silent bug; activations are element-wise, layers are matmuls.

**Q: What are eigenvectors and eigenvalues intuitively?**
A: An eigenvector is a direction a matrix only stretches without rotating; its eigenvalue is the stretch factor (`Av = λv`). They expose a matrix's principal axes, which is exactly what PCA uses to find the directions of greatest variance in data.

**Q: How does PCA use linear algebra to reduce dimensions?**
A: It centers the data, computes the covariance matrix, and takes its top eigenvectors (or equivalently the top singular vectors via SVD) — the directions of maximum variance. Projecting data onto those few directions compresses it while retaining the most information.

**Q: Why must you normalize vectors before comparing them with a dot product?**
A: Because the raw dot product mixes direction and magnitude; a long vector can score high just by being long. Normalizing to unit length isolates direction, giving cosine similarity, so the comparison reflects semantic alignment rather than scale.

**Q: (Senior) How does self-attention reduce to linear algebra?**
A: Attention forms query, key, and value matrices `Q, K, V` by linear projection. The score matrix is `QKᵀ` — every query's dot product with every key — scaled by `1/√d_k`, softmaxed, then multiplied by `V`. So attention is two matmuls plus a softmax, which is why Transformers are so GPU-efficient.

**Q: (Senior) What is a low-rank approximation and where does it matter in modern AI?**
A: SVD lets you approximate a matrix `A ≈ U_k Σ_k V_kᵀ` using only the top-k singular values, capturing most of its action with far fewer numbers. This underpins LoRA fine-tuning, which represents a large weight update as the product of two small low-rank matrices, cutting trainable parameters by orders of magnitude.

**Q: (Senior) Why do we prefer solving `Ax = b` over computing `A⁻¹b`?**
A: Explicit inversion is numerically unstable and expensive, and it breaks when `A` is singular or ill-conditioned. Direct solvers (LU, QR) or the SVD-based pseudo-inverse are more accurate and robust. In practice you almost never materialize an inverse.

**Q: (Senior) How do you keep large matrix computations numerically stable and fast?**
A: Use numerically stable formulations (subtract the max before softmax, log-sum-exp for sums of exponentials), employ mixed precision (bf16) with loss scaling, keep tensors contiguous and batched for cache/GPU efficiency, and exploit structure — sparsity, low rank, or quantization — to shrink the matrices.

**Q: What is the L2 norm and why is it everywhere in ML?**
A: The L2 norm `‖x‖₂ = √(Σxᵢ²)` is a vector's Euclidean length. It's used to normalize embeddings, measure distances, define regularization (weight decay penalizes large `‖w‖`), and monitor gradient magnitudes during training.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** In AI, data are vectors and models are matrices. The dot product `x·y = ‖x‖‖y‖cosθ` measures alignment and, normalized, gives cosine similarity for comparing embeddings. A neural layer is `σ(Wx + b)` — a matrix multiply, a bias, and a nonlinearity — and depth is the composition of these transformations, so matmul is the dominant operation. Eigenvectors/SVD expose a matrix's principal directions and enable dimensionality reduction (PCA) and low-rank tricks (LoRA). Always vectorize, always track shapes, normalize before comparing, and center before PCA.

| Operation | Meaning | ML use |
|---|---|---|
| `x·y` | alignment (scalar) | similarity, attention scores |
| `Wx` | linear transform | one layer |
| `AB` | compose transforms | stacked layers |
| `Aᵀ` | flip rows/cols | backprop gradients |
| eig/SVD | principal directions | PCA, LoRA, compression |

- **Dot product** → alignment; normalize it for cosine similarity.
- **A layer** → matmul + bias + nonlinearity.
- **Matmul rule** → `(m×k) @ (k×n) = (m×n)`; inner dims must match.
- **PCA** → top eigenvectors/singular vectors of centered data.
- **Golden rule** → vectorize everything; never loop over elements.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement cosine similarity from scratch in numpy and verify it against `sklearn.metrics.pairwise.cosine_similarity`.
- [ ] Multiply a `(3×4)` and a `(4×2)` matrix by hand, then confirm with numpy `@`.
- [ ] Take a small dataset, run PCA to 2-D via SVD, and plot it; report the variance retained.
- [ ] Break a matmul on purpose with mismatched shapes and read the error to learn the shape rule.
- [ ] Time a loop-based dot product vs `a @ b` on 1-million-element vectors and record the speedup.

**Mini Project — Build a tiny semantic search engine.**
*Goal:* Retrieve the most relevant document for a query using only linear algebra.
*Requirements:* Turn a small set of sentences into vectors (bag-of-words or precomputed embeddings), normalize them, and rank documents by cosine similarity (a single matrix–vector product) against a query vector; return the top-3.
*Extensions:* Add PCA to compress the vectors and compare retrieval quality; replace the exact search with an approximate nearest-neighbor index (FAISS) and measure the speed/accuracy trade-off.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Calculus, Gradients & Backprop Intuition* (chapter 06) for how these matrices are learned; *Types of ML* (chapter 04) for where PCA and clustering use this math; *What Is AI?* (chapter 01) for how these operations build up to full models.

**Free Learning Resources**
- **Essence of Linear Algebra** — 3Blue1Brown · *Beginner* · the definitive visual intuition for vectors, matrices, and transformations. <https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab>
- **Immersive Linear Algebra** — J. Ström, K. Åström, T. Akenine-Möller · *Beginner* · interactive, figure-driven online textbook. <https://immersivemath.com/ila/index.html>
- **MIT 18.06 Linear Algebra** — Gilbert Strang (OCW) · *Intermediate* · the classic rigorous course, full video lectures free. <https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/>
- **Mathematics for Machine Learning (Linear Algebra)** — Deisenroth, Faisal, Ong (free PDF) · *Intermediate* · linear algebra framed specifically for ML. <https://mml-book.github.io/>
- **NumPy: the absolute basics** — NumPy docs · *Beginner* · hands-on array and matmul operations in code. <https://numpy.org/doc/stable/user/absolute_beginners.html>
- **CS231n Linear Algebra Review** — Stanford · *Intermediate* · a compact refresher aimed at deep-learning practitioners. <https://cs231n.github.io/python-numpy-tutorial/>
- **The Matrix Cookbook** — Petersen & Pedersen (free PDF) · *Advanced* · reference of matrix identities and derivatives used in ML math. <https://www.math.uwaterloo.ca/~hwolkowi/matrixcookbook.pdf>

---

*AI Engineering Handbook — chapter 05.*
