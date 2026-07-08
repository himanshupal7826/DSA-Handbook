# 14 · Clustering & Dimensionality Reduction

> **In one line:** K-means, DBSCAN, PCA and t-SNE/UMAP — finding structure and compressing features when nobody handed you labels.

---

## 1. Overview

**Clustering and dimensionality reduction** are the two workhorses of *unsupervised* learning: they extract structure from data that has no labels at all. Clustering answers "which points belong together?"; dimensionality reduction answers "what are the few directions that actually carry the information?" Together they turn a wall of raw feature vectors into something a human — or a downstream model — can reason about.

The problem they solve is that **most real data is unlabeled and high-dimensional**, and both properties break naive analysis. You can't run supervised learning without labels, and you can't eyeball a 300-dimensional vector. Clustering discovers groups you didn't know existed (customer segments, anomaly cohorts, document topics). Dimensionality reduction fights the *curse of dimensionality* — in high dimensions distances concentrate, everything looks equidistant, and volume explodes so fast that data becomes hopelessly sparse. Reduce to 2, 10, or 50 meaningful dimensions and both distance-based methods and visualization come back to life.

Historically, k-means dates to the 1950s (Lloyd's algorithm, 1957) and PCA to Karl Pearson in 1901 — remarkably durable ideas. The modern additions are density clustering (DBSCAN, 1996) for non-spherical clusters and noise, and manifold-learning visualizers t-SNE (2008) and UMAP (2018) that unfold curved high-dimensional structure into a 2-D picture. These last two are everywhere in ML now — every embedding space you've seen plotted was almost certainly UMAP or t-SNE.

Concrete example: a retailer has 2 million customers described by 80 behavioral features. Run PCA to compress to ~15 components that retain 90% of the variance, cluster those with k-means or DBSCAN into segments, and visualize with UMAP to sanity-check the grouping. The output — "high-value dormant," "price-sensitive frequent," "one-time gift buyers" — drives marketing with no labels ever provided.

## 2. Core Concepts

- **Cluster** — a group of points more similar to each other than to points outside it; "similar" is defined by a distance or density criterion you choose.
- **Centroid** — the mean vector of a k-means cluster; each point is assigned to its nearest centroid.
- **Inertia (within-cluster sum of squares)** — total squared distance from points to their centroids; k-means minimizes it, and it always drops as k rises.
- **Silhouette score** — per-point measure `(b − a) / max(a, b)` where `a` is mean intra-cluster distance and `b` is mean nearest-other-cluster distance; ranges −1 to 1, higher is better.
- **Density reachability (DBSCAN)** — a point is *core* if it has ≥ `minPts` neighbors within radius `eps`; clusters grow by chaining core points, and unreachable points are labeled **noise**.
- **Manifold** — the low-dimensional curved surface that high-dimensional data actually lives on; manifold learning tries to unfold it.
- **Principal component** — an orthogonal direction of maximum remaining variance; PCA's components are the eigenvectors of the covariance matrix (equivalently, the right singular vectors from SVD).
- **Explained variance ratio** — the fraction of total variance captured by each principal component; the cumulative curve tells you how many to keep.
- **Perplexity / n_neighbors** — the locality knob for t-SNE / UMAP: roughly how many neighbors define "local," trading local detail against global structure.
- **Curse of dimensionality** — as dimensions grow, distances concentrate, volume explodes, and data becomes sparse, degrading every distance-based method.

## 3. Theory & Mathematical Intuition

**K-means (Lloyd's algorithm).** Minimize inertia `J = Σ_i ||x_i − μ_{c(i)}||²` by alternating two steps: (1) *assign* each point to its nearest centroid, (2) *update* each centroid to the mean of its assigned points. Each step can only lower J, so it converges — but only to a *local* minimum, which is why initialization matters. **k-means++** seeds centroids far apart (probability of picking a point as the next seed ∝ its squared distance to the nearest existing seed), which dramatically improves both speed and final quality. k-means assumes clusters are convex, roughly equal-sized, and isotropic; it fails on crescents and nested rings.

**Choosing k.** Inertia decreases monotonically with k, so you can't just minimize it — you look for the **elbow**, the k where the marginal drop flattens. A more principled choice is the **silhouette score**, which rewards tight, well-separated clusters and peaks at a good k.

**DBSCAN** needs no k. With radius `eps` and `minPts`, a *core* point has ≥ minPts neighbors within eps; density-connected core points form a cluster, border points attach to a nearby core, and everything else is **noise**. This finds arbitrary shapes and rejects outliers, but is sensitive to `eps` — set it from the knee of the sorted k-distance plot.

**PCA.** Center the data, form the covariance matrix `C = (1/n) XᵀX`, and take its eigenvectors: the eigenvector with the largest eigenvalue is the direction of maximum variance (PC1), the next-largest orthogonal one is PC2, and so on. In practice you compute this via **SVD** (`X = U Σ Vᵀ`; the columns of `V` are the components) which is numerically stabler. Keep the top components whose cumulative `explained_variance_ratio` reaches your target (often 0.90–0.95). PCA is linear — it can only rotate and project, so it cannot unfold a curved manifold.

```svg
<svg viewBox="0 0 520 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <rect x="0" y="0" width="520" height="340" fill="#ffffff"/>
  <text x="260" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">PCA: Directions of Maximum Variance</text>
  <line x1="60" y1="300" x2="460" y2="300" stroke="#94a3b8"/>
  <line x1="60" y1="300" x2="60" y2="60" stroke="#94a3b8"/>
  <text x="455" y="318" fill="#64748b" font-size="11">feature 1</text>
  <text x="18" y="70" fill="#64748b" font-size="11">feature 2</text>
  <circle cx="130" cy="250" r="4" fill="#0ea5e9"/><circle cx="160" cy="235" r="4" fill="#0ea5e9"/>
  <circle cx="185" cy="230" r="4" fill="#0ea5e9"/><circle cx="205" cy="210" r="4" fill="#0ea5e9"/>
  <circle cx="235" cy="200" r="4" fill="#0ea5e9"/><circle cx="260" cy="180" r="4" fill="#0ea5e9"/>
  <circle cx="290" cy="170" r="4" fill="#0ea5e9"/><circle cx="315" cy="150" r="4" fill="#0ea5e9"/>
  <circle cx="345" cy="140" r="4" fill="#0ea5e9"/><circle cx="375" cy="120" r="4" fill="#0ea5e9"/>
  <circle cx="200" cy="245" r="4" fill="#0ea5e9"/><circle cx="300" cy="200" r="4" fill="#0ea5e9"/>
  <line x1="120" y1="260" x2="390" y2="115" stroke="#4f46e5" stroke-width="3"/>
  <text x="395" y="112" fill="#4f46e5" font-size="12" font-weight="700">PC1</text>
  <text x="300" y="150" fill="#4f46e5" font-size="11">(most variance)</text>
  <line x1="240" y1="235" x2="285" y2="150" stroke="#16a34a" stroke-width="3"/>
  <text x="250" y="150" fill="#16a34a" font-size="12" font-weight="700">PC2</text>
  <text x="150" y="90" fill="#334155" font-size="11">PC1 = direction of largest spread</text>
  <text x="150" y="108" fill="#334155" font-size="11">PC2 orthogonal, next-largest spread</text>
</svg>
```

**t-SNE and UMAP.** Both build a graph of local neighbor relationships in high-D and then lay points out in 2-D to preserve that neighbor structure. t-SNE converts distances to probabilities and minimizes KL divergence; UMAP uses a fuzzy-simplicial graph and optimizes a cross-entropy — it's faster and preserves more global structure. **Crucial caveat:** in these plots, *cluster sizes and inter-cluster distances are not meaningful* — only local neighborhoods are. Never read "these two blobs are far apart, so they're very different" from a t-SNE plot; that distance is an artifact of the layout, not the data.

## 4. Architecture & Workflow

A production unsupervised pipeline chains scaling → reduction → clustering → evaluation → visualization. Reduce *before* clustering so distance-based methods work in a space where distance still means something.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <rect x="0" y="0" width="760" height="320" fill="#ffffff"/>
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Unsupervised Pipeline</text>

  <rect x="20" y="60" width="140" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">Raw features</text>
  <text x="90" y="102" text-anchor="middle" fill="#64748b" font-size="11">n samples × d dims</text>

  <rect x="195" y="60" width="140" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="265" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">Standardize</text>
  <text x="265" y="102" text-anchor="middle" fill="#64748b" font-size="11">zero mean, unit var</text>

  <rect x="370" y="60" width="150" height="58" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="445" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">PCA reduce</text>
  <text x="445" y="102" text-anchor="middle" fill="#64748b" font-size="11">keep 90% variance</text>

  <rect x="555" y="60" width="185" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="647" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">Cluster</text>
  <text x="647" y="102" text-anchor="middle" fill="#64748b" font-size="11">k-means / DBSCAN</text>

  <rect x="195" y="185" width="140" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="265" y="209" text-anchor="middle" fill="#1e293b" font-weight="700">Evaluate</text>
  <text x="265" y="227" text-anchor="middle" fill="#64748b" font-size="11">silhouette / elbow</text>

  <rect x="370" y="185" width="150" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="445" y="209" text-anchor="middle" fill="#1e293b" font-weight="700">UMAP / t-SNE</text>
  <text x="445" y="227" text-anchor="middle" fill="#64748b" font-size="11">2-D visual check</text>

  <rect x="555" y="185" width="185" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="647" y="209" text-anchor="middle" fill="#1e293b" font-weight="700">Label &amp; act</text>
  <text x="647" y="227" text-anchor="middle" fill="#64748b" font-size="11">name the segments</text>

  <line x1="160" y1="89" x2="193" y2="89" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="335" y1="89" x2="368" y2="89" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="520" y1="89" x2="553" y2="89" stroke="#475569" marker-end="url(#a2)"/>
  <path d="M647,118 L647,160 L265,160 L265,183" fill="none" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="335" y1="214" x2="368" y2="214" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="520" y1="214" x2="553" y2="214" stroke="#475569" marker-end="url(#a2)"/>
  <text x="380" y="290" text-anchor="middle" fill="#64748b" font-size="11">Reduce first so distances stay meaningful; visualize only to confirm, never to decide k.</text>
</svg>
```

**Step by step:**

1. **Standardize** every feature to zero mean and unit variance — distance- and variance-based methods are dominated by whatever feature has the largest scale otherwise.
2. **Reduce with PCA** to kill noise and collinearity and to shrink dimensionality before clustering; keep enough components for ~90% cumulative variance.
3. **Cluster** in the reduced space: k-means when clusters are roughly convex and you can guess k, DBSCAN when shapes are irregular or you need noise rejection.
4. **Choose k / eps** empirically: elbow + silhouette for k-means, the k-distance knee for DBSCAN's eps.
5. **Evaluate** with silhouette (internal) and, if you have any labels, adjusted Rand or mutual information (external).
6. **Visualize** with UMAP or t-SNE to confirm the clusters look coherent — as a *check*, not as the thing you cluster on or tune k with.
7. **Name and operationalize** the clusters: inspect centroids / feature profiles, give each segment a human label, and wire it into the product.

## 5. Implementation

K-means with elbow and silhouette, on standardized data:

```python
import numpy as np
from sklearn.datasets import make_blobs
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

X, _ = make_blobs(n_samples=1500, centers=4, cluster_std=1.1, random_state=42)
Xs = StandardScaler().fit_transform(X)

for k in range(2, 8):
    km = KMeans(n_clusters=k, init="k-means++", n_init=10, random_state=42).fit(Xs)
    sil = silhouette_score(Xs, km.labels_)
    print(f"k={k}  inertia={km.inertia_:8.1f}  silhouette={sil:.3f}")
# k=2  inertia= 4200.3  silhouette=0.579
# k=3  inertia= 2510.7  silhouette=0.611
# k=4  inertia= 1180.4  silhouette=0.723   <- elbow + best silhouette
# k=5  inertia= 1050.9  silhouette=0.588
# k=6  inertia=  960.2  silhouette=0.552
```

DBSCAN for non-spherical clusters + noise, with eps chosen from the k-distance knee:

```python
from sklearn.cluster import DBSCAN
from sklearn.datasets import make_moons
from sklearn.neighbors import NearestNeighbors

Xm, _ = make_moons(n_samples=1000, noise=0.06, random_state=42)

# pick eps from the knee of the sorted 4th-nearest-neighbor distances
nn = NearestNeighbors(n_neighbors=5).fit(Xm)
dists = np.sort(nn.kneighbors(Xm)[0][:, -1])
print("suggested eps near:", round(float(dists[int(0.95 * len(dists))]), 3))  # ~0.12

db = DBSCAN(eps=0.12, min_samples=5).fit(Xm)
labels = db.labels_
n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
n_noise = int((labels == -1).sum())
print(f"clusters={n_clusters}  noise_points={n_noise}")   # clusters=2  noise_points=17
# k-means would split each moon in half here; DBSCAN recovers both crescents.
```

PCA — explained variance and reconstruction:

```python
from sklearn.decomposition import PCA

X, _ = make_blobs(n_samples=2000, n_features=30, centers=5, random_state=42)
Xs = StandardScaler().fit_transform(X)

pca = PCA(n_components=0.90, svd_solver="full").fit(Xs)   # keep 90% variance
Xr = pca.transform(Xs)
print("kept components:", pca.n_components_)               # e.g. 8 (of 30)
print("cum variance   :", round(pca.explained_variance_ratio_.sum(), 3))  # 0.902
print("first 3 ratios :", np.round(pca.explained_variance_ratio_[:3], 3)) # [0.21 0.17 0.12]

# reconstruction error tells you what you lost
Xrec = pca.inverse_transform(Xr)
print("recon MSE:", round(float(np.mean((Xs - Xrec) ** 2)), 4))           # ~0.098
```

UMAP / t-SNE for visualization (fit on PCA-reduced data for speed):

```python
from sklearn.manifold import TSNE
# import umap   # pip install umap-learn

emb_tsne = TSNE(n_components=2, perplexity=30, init="pca",
                learning_rate="auto", random_state=42).fit_transform(Xr)
print(emb_tsne.shape)   # (2000, 2)  -> scatter-plot, color by cluster label

# reducer = umap.UMAP(n_neighbors=15, min_dist=0.1, random_state=42)
# emb_umap = reducer.fit_transform(Xr)   # faster, better global structure
# Reminder: distances/sizes in these 2-D plots are NOT quantitatively meaningful.
```

> **Optimization:** For millions of points use `MiniBatchKMeans` (streams batches, ~10× faster, near-identical clusters), run PCA before t-SNE/UMAP to cut the neighbor-search cost, and cache the fitted PCA/scaler in a `Pipeline` so inference is one transform. DBSCAN is `O(n log n)` only with a spatial index (KD/ball tree), which scikit-learn uses automatically for low dimensions — reduce first, because that index degrades to `O(n²)` in high-D.

## 6. Advantages, Disadvantages & Trade-offs

| Method | Strength | Cost / Trade-off |
|---|---|---|
| **K-means** | Fast, simple, scales to millions | Must pick k; assumes convex equal-size clusters; sensitive to init and outliers |
| **DBSCAN** | No k; finds arbitrary shapes; flags noise | eps/minPts tuning is finicky; struggles with varying density and high dimensions |
| **Hierarchical** | Full dendrogram, no k upfront, interpretable | `O(n²)` memory/time; doesn't scale past ~10⁴ points |
| **PCA** | Fast, deterministic, denoises, invertible | Linear only — can't unfold curved manifolds; components can be hard to interpret |
| **t-SNE** | Beautiful local structure for viz | Slow; non-deterministic; distances/sizes meaningless; not for downstream features |
| **UMAP** | Faster than t-SNE, keeps more global structure | Still a viz tool; hyperparameter-sensitive; distances still not fully trustworthy |
| **Silhouette** | Label-free cluster-quality score | `O(n²)` naive; assumes convex clusters, so it under-rates DBSCAN shapes |

The central trade-off: **k-means is fast but assumes shape; DBSCAN is flexible but assumes uniform density; PCA is faithful but linear; t-SNE/UMAP are gorgeous but only qualitative.** Pick by matching the assumption to your data, never by defaulting.

## 7. Common Mistakes & Best Practices

1. ⚠️ Clustering without standardizing → ✅ Always scale features first; otherwise the largest-unit feature silently dominates every distance.
2. ⚠️ Reading cluster sizes/distances off a t-SNE or UMAP plot → ✅ Treat those plots as qualitative neighbor maps only; quantify with silhouette in the real feature space.
3. ⚠️ Picking k by minimizing inertia → ✅ Inertia always drops with k; use the elbow *and* the silhouette peak.
4. ⚠️ Using k-means on crescents, rings, or varying-density data → ✅ Switch to DBSCAN or spectral clustering; k-means only sees convex blobs.
5. ⚠️ Running t-SNE on 500 dimensions directly → ✅ PCA-reduce to ~30–50 dims first; it's faster and denoises the neighbor graph.
6. ⚠️ Applying PCA to non-standardized or wildly non-Gaussian features → ✅ Standardize; consider log/quantile transforms so variance reflects information, not scale.
7. ⚠️ Treating DBSCAN noise (`-1`) as a real cluster → ✅ It's the outlier bin; handle or drop it explicitly, don't feed it downstream as a group.
8. ⚠️ Comparing t-SNE runs with different seeds/perplexity as if stable → ✅ Fix the seed, sweep perplexity/n_neighbors, and confirm structure is robust across settings.
9. ⚠️ Assuming clusters are "real" → ✅ Clustering always returns something; validate with silhouette, stability across resamples, and domain sanity before believing it.
10. ⚠️ Keeping too few PCA components to "simplify" → ✅ Let the cumulative explained-variance curve decide; under-keeping throws away signal you needed for clustering.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When clusters look wrong, first check scaling — an unscaled feature is the most common culprit. Plot the sorted k-distance graph for DBSCAN and the elbow/silhouette curve for k-means to justify hyperparameters rather than guessing. If t-SNE shows structure but silhouette in feature space is near zero, trust the number: the visual is an artifact. For PCA, inspect `explained_variance_ratio_` — a flat spectrum means no low-rank structure and reduction won't help much.

**Monitoring.** Clusters drift as populations change. Track cluster *sizes* and *centroid positions* over time; a segment that swells or a centroid that migrates signals distribution shift. For a deployed k-means, monitor the fraction of points far from any centroid (rising = new behavior the model can't place). Log the PCA explained variance on fresh data — a drop means the learned subspace no longer fits.

**Security.** Unsupervised models leak information: cluster assignments and PCA loadings can reveal sensitive attributes even when the raw feature was excluded (proxy leakage). Audit that segments don't encode protected classes. Guard against poisoning — injected outliers can pull k-means centroids or split DBSCAN clusters; robust scaling and outlier caps help. Treat learned centroids/components as sensitive artifacts, not public constants.

**Scaling.** Use `MiniBatchKMeans` and incremental/`IncrementalPCA` for out-of-core data. Fit reduction and clustering on a representative sample, then `transform`/`predict` the full stream. DBSCAN doesn't scale to tens of millions in high-D; approximate it (HDBSCAN with a sample, or grid-based density methods) or cluster in a PCA-reduced space where the spatial index stays efficient.

## 9. Interview Questions

**Q: How does Lloyd's algorithm for k-means work, and why can it give different answers?**
A: It alternates assigning points to the nearest centroid and moving each centroid to its cluster's mean, each step lowering inertia until convergence. Because inertia is non-convex it only reaches a *local* minimum, so different random initializations land in different solutions — which is why we run `n_init` restarts and use k-means++ seeding.

**Q: How do you choose k?**
A: There's no label to optimize, so I use the elbow of the inertia-vs-k curve (where marginal drop flattens) together with the silhouette score, which peaks at a good k. If I have any external signal I add adjusted Rand or mutual information; ultimately domain interpretability breaks ties.

**Q: When does k-means fail, and what do you use instead?**
A: It fails on non-convex shapes (crescents, rings), clusters of very different sizes or densities, and in the presence of outliers, because it only carves space into convex Voronoi cells around means. For those I use DBSCAN (arbitrary shapes, noise handling) or spectral clustering (connectivity-based).

**Q: Explain DBSCAN's eps and minPts.**
A: minPts is the minimum neighbors within radius eps for a point to be a *core* point; clusters grow by density-connecting core points, and points reachable from none are labeled noise. eps sets the neighborhood scale — I pick it from the knee of the sorted k-distance plot, and minPts around 2×dimensionality as a rule of thumb.

**Q: What is PCA doing geometrically?**
A: It finds an orthogonal set of axes ordered by variance: PC1 is the direction of maximum spread, PC2 the next-largest orthogonal one, and so on. Projecting onto the top few axes keeps most of the variance while dropping dimensions — a pure rotation-and-projection, so it's linear and can't unfold curved structure.

**Q: Eigen-decomposition vs SVD for PCA — which and why?**
A: SVD of the centered data matrix, in practice. It gives the same principal directions (the right singular vectors) but avoids explicitly forming the covariance matrix, which is more numerically stable and faster when features outnumber samples. scikit-learn's PCA uses SVD under the hood.

**Q: Why should you not read cluster distances off a t-SNE plot?**
A: t-SNE optimizes to preserve *local* neighborhoods by minimizing KL divergence, deliberately sacrificing global geometry. So the gap between two blobs and their relative sizes are layout artifacts, not real distances — two "far apart" clusters may be adjacent in the original space. It's a qualitative neighbor map, not a metric space.

**Q: (Senior) You have 200-dimensional embeddings and want to both cluster and visualize. Design the pipeline.**
A: Standardize, then PCA to ~50 dims for denoising and speed. Cluster in that PCA space with k-means (if roughly convex) or HDBSCAN (if irregular), choosing k via silhouette. Separately, run UMAP on the PCA output to 2-D purely for a visual sanity check, coloring by the cluster labels. Never tune k from the UMAP plot — cluster in the faithful space, visualize only to confirm.

**Q: (Senior) Explain the curse of dimensionality and its effect on these methods.**
A: As dimensions grow, volume explodes so data becomes sparse, and pairwise distances concentrate — the ratio of nearest to farthest neighbor approaches 1, so "nearest" loses meaning. That guts distance-based clustering (k-means, DBSCAN) and neighbor graphs (t-SNE/UMAP). The mitigation is dimensionality reduction first (PCA/autoencoder) or distance metrics suited to the domain, so clustering happens where distance is still informative.

**Q: (Senior) t-SNE vs UMAP — technical differences and when each?**
A: t-SNE models pairwise similarities as probabilities and minimizes KL divergence, emphasizing local structure and running slowly (`O(n²)` naively, `O(n log n)` with Barnes-Hut). UMAP builds a fuzzy-simplicial neighbor graph and optimizes cross-entropy, so it's faster, scales better, preserves more global structure, and can transform new points. I default to UMAP for large data and reusable embeddings; t-SNE when I want the cleanest local separation for a one-off figure.

**Q: (Senior) How do you validate that discovered clusters are real, not artifacts?**
A: Clustering always returns groups, so I test stability: re-cluster on bootstrap resamples and measure label agreement (adjusted Rand), check silhouette against a null of shuffled/uniform data, and confirm clusters are separable and interpretable on held-out data. If the structure vanishes under resampling or matches a random baseline, it isn't real.

**Q: Why standardize before PCA and k-means?**
A: Both are variance/distance driven, so an unscaled feature measured in large units (e.g. income in dollars vs age in years) dominates the covariance and every distance, hijacking the components and the clusters. Standardizing to zero mean and unit variance puts features on equal footing so structure reflects information, not units.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Unsupervised learning finds structure without labels. K-means minimizes within-cluster variance via Lloyd's algorithm — fast but assumes convex, similar-size clusters and needs k (pick via elbow + silhouette); k-means++ fixes initialization. DBSCAN needs no k, finds arbitrary shapes, and flags noise, but is sensitive to eps/minPts. PCA rotates data onto variance-ordered orthogonal axes (via SVD) to denoise and compress linearly. t-SNE and UMAP unfold manifolds into 2-D for *visualization only* — their distances and cluster sizes are not quantitatively meaningful. Always standardize first, reduce before clustering, and validate clusters for stability.

| Task | Reach for | Watch out for |
|---|---|---|
| Fast clustering, convex blobs | k-means (++ init) | must pick k; outlier-sensitive |
| Irregular shapes + noise | DBSCAN / HDBSCAN | eps tuning; varying density |
| Small data, want hierarchy | Agglomerative + dendrogram | `O(n²)` cost |
| Linear compression / denoise | PCA (SVD) | linear only |
| 2-D visualization | UMAP (or t-SNE) | distances not meaningful |
| Pick k | silhouette + elbow | inertia alone always drops |

- **K-means objective** → minimize inertia `Σ ||x − μ||²`; converges to a *local* optimum.
- **DBSCAN core point** → ≥ minPts neighbors within eps; unreachable points = noise.
- **PCA component** → eigenvector of covariance / right singular vector; ordered by explained variance.
- **Silhouette** → `(b − a)/max(a,b)`, range −1..1; higher = tighter, better-separated clusters.
- **t-SNE/UMAP rule** → local neighborhoods trustworthy, global distances and sizes are not.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement k-means from scratch in numpy (assign + update loop) and match scikit-learn's inertia on `make_blobs`.
- [ ] Run k-means and DBSCAN on `make_moons`; explain with a plot why k-means splits each crescent.
- [ ] Plot the cumulative explained-variance curve for a 30-D dataset and justify how many components to keep.
- [ ] Sweep t-SNE perplexity over {5, 30, 100} and UMAP n_neighbors over {5, 15, 50}; document how structure changes.
- [ ] Compute silhouette across k = 2..10 and cross-check the elbow; report the k you'd ship and why.

**Mini Project — Unsupervised Customer Segmentation.**
*Goal:* segment a customer dataset (e.g. the UCI Online Retail or Mall Customers set) end to end with no labels.
*Requirements:* (1) standardize features; (2) PCA to ~90% variance and report the component count; (3) cluster the reduced data with both k-means (k chosen by silhouette) and DBSCAN, comparing results; (4) UMAP visualization colored by cluster; (5) profile each cluster's centroid and give it a human-readable name. Deliver a short report with the plots.
*Extensions:* add HDBSCAN and compare noise handling; measure cluster stability via bootstrap adjusted-Rand; wire the fitted scaler+PCA+k-means into a `Pipeline` that assigns a segment to a new customer in one call; A/B a marketing action per segment.

## 12. Related Topics & Free Learning Resources

Related chapters: **Model Evaluation & Metrics** (silhouette, adjusted Rand as the unsupervised analog of the supervised metrics), **Feature Engineering & Scaling** (standardization is a prerequisite here), **Embeddings & Vector Search** (what you usually cluster and visualize), and **Anomaly Detection** (DBSCAN noise as outliers).

**Free Learning Resources**
- **scikit-learn: Clustering** — scikit-learn · *Beginner–Intermediate* · authoritative guide to k-means, DBSCAN, and hierarchical clustering with a side-by-side comparison chart. <https://scikit-learn.org/stable/modules/clustering.html>
- **StatQuest: PCA Step-by-Step** — Josh Starmer · *Beginner* · the intuitive geometric walk-through of eigenvectors and explained variance. <https://www.youtube.com/watch?v=FgakZw6K1QQ>
- **How to Use t-SNE Effectively** — Wattenberg et al., distill.pub · *Intermediate* · interactive article on why perplexity, cluster sizes, and distances mislead. <https://distill.pub/2016/misread-tsne/>
- **UMAP: Uniform Manifold Approximation and Projection** — McInnes & Healy, arXiv · *Advanced* · the original paper on the algorithm and its theory. <https://arxiv.org/abs/1802.03426>
- **umap-learn documentation** — Leland McInnes · *Intermediate* · practical parameter guide (n_neighbors, min_dist) and how UMAP differs from t-SNE. <https://umap-learn.readthedocs.io/en/latest/>
- **A Density-Based Algorithm for Discovering Clusters (DBSCAN)** — Ester et al., KDD 1996 · *Advanced* · the founding paper defining density reachability and noise. <https://www.aaai.org/Papers/KDD/1996/KDD96-037.pdf>
- **StatQuest: K-means Clustering** — Josh Starmer · *Beginner* · clear visual of Lloyd's algorithm, the elbow method, and why initialization matters. <https://www.youtube.com/watch?v=4b5d3muPQmA>

---

*AI Engineering Handbook — chapter 14.*
