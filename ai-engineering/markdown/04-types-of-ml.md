# 04 · Types of ML: Supervised, Unsupervised & RL

> **In one line:** The three learning paradigms differ by their signal — supervised learns from labeled answers, unsupervised finds structure with no answers, and reinforcement learning learns from rewards for actions.

---

## 1. Overview

Machine learning has three classic paradigms, distinguished by **what feedback the model gets**. In **supervised learning**, every training example comes with the correct answer (a label), and the model learns to map inputs to those answers. In **unsupervised learning**, there are no labels; the model discovers structure — clusters, low-dimensional representations, or anomalies — in the data itself. In **reinforcement learning (RL)**, an agent takes actions in an environment and learns from a scalar **reward** signal, optimizing long-term return rather than imitating given answers.

The problem this taxonomy solves is **matching method to available signal**. Labels are expensive; sometimes you have none; sometimes the "answer" only reveals itself through trial and error. Knowing which paradigm a problem needs is the difference between a tractable project and a doomed one. A fourth, now-dominant approach — **self-supervised learning** — sits between the first two: it manufactures labels from the data itself (predict the next word, fill in a masked patch) and is how modern LLMs and vision foundation models are pre-trained.

The paradigms map cleanly to question types. Supervised answers "what is this / how much?" (classification, regression). Unsupervised answers "how is this organized / what's unusual?" (clustering, dimensionality reduction, anomaly detection). RL answers "what should I *do* to maximize a goal over time?" (control, game-playing, robotics, and RLHF for aligning LLMs).

**Concrete example.** For a music app: predicting whether a user will skip a song from labeled skip history is **supervised**; grouping listeners into taste segments without predefined categories is **unsupervised**; and a recommendation policy that learns which sequence of songs keeps a session going, from engagement rewards, is **reinforcement learning**. Same product, three different signals.

The durable mental model: ask **"what teaches the model here — answers, structure, or rewards?"** and the paradigm follows.

## 2. Core Concepts

- **Supervised learning** — learns a mapping `f: X → Y` from labeled pairs `(x, y)`; split into classification (discrete `y`) and regression (continuous `y`).
- **Label** — the ground-truth target attached to a training example; the supervision signal.
- **Unsupervised learning** — finds structure in unlabeled data: clustering, dimensionality reduction, density estimation, anomaly detection.
- **Reinforcement learning** — an agent learns a **policy** mapping states to actions to maximize cumulative reward through interaction.
- **Reward** — a scalar feedback signal in RL indicating how good an action/outcome was; may be sparse and delayed.
- **Policy** — the agent's strategy `π(a|s)`: the probability of taking action `a` in state `s`.
- **Self-supervised learning** — supervised learning where labels are auto-generated from the data (e.g., predict the next token); powers foundation-model pre-training.
- **Exploration vs exploitation** — RL's core tension: try new actions to learn vs use known-good actions to earn reward.
- **Semi-supervised learning** — mixes a little labeled data with lots of unlabeled data to cut labeling cost.
- **Ground truth** — the true target values against which supervised and semi-supervised models are trained and scored.

## 3. Theory & Mathematical Intuition

Each paradigm optimizes a different objective.

**Supervised** minimizes expected loss between prediction and label:

```
minimize  E_(x,y)[ L(f_θ(x), y) ]
# classification: cross-entropy  L = -Σ y_c log p_c
# regression:     squared error  L = (ŷ - y)^2
```

**Unsupervised** has no `y`, so it optimizes a structural objective. K-means minimizes within-cluster variance; PCA maximizes retained variance in fewer dimensions:

```
k-means:  minimize  Σ_i  || x_i - μ_{c(i)} ||²      (μ = cluster centroid)
PCA:      find top-k eigenvectors of the covariance matrix (max variance directions)
```

**Reinforcement learning** maximizes expected **discounted return** — future rewards matter but less than immediate ones (`γ ∈ [0,1)` is the discount factor):

```
G_t = Σ_{k≥0} γ^k r_{t+k+1}          # return from time t
maximize_π  E_π[ G_t ]                # find the policy with highest expected return
Q*(s,a) = E[ r + γ max_{a'} Q*(s', a') ]   # Bellman optimality (value of acting well)
```

The crucial theoretical distinction: supervised learning gets a **dense, per-example teaching signal** (the right answer every time), while RL gets a **sparse, delayed, evaluative signal** (a reward that may come many steps after the decisive action, and only tells you *how good*, not *what was right*). That is why RL is far harder and sample-hungrier — it must solve **credit assignment** across time.

```svg
<svg viewBox="0 0 760 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="220" rx="12" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="34" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Three signals, three objectives</text>
  <rect x="30" y="60" width="220" height="150" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="140" y="86" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Supervised</text>
  <text x="140" y="112" text-anchor="middle" fill="#1e293b" font-size="11">input x + label y</text>
  <text x="140" y="134" text-anchor="middle" fill="#1e293b" font-size="11">learn f: X → Y</text>
  <text x="140" y="160" text-anchor="middle" fill="#1e293b" font-size="10">dense answer signal</text>
  <text x="140" y="182" text-anchor="middle" fill="#1e293b" font-size="10">classify / regress</text>
  <rect x="270" y="60" width="220" height="150" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="380" y="86" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Unsupervised</text>
  <text x="380" y="112" text-anchor="middle" fill="#1e293b" font-size="11">input x, no labels</text>
  <text x="380" y="134" text-anchor="middle" fill="#1e293b" font-size="11">find structure</text>
  <text x="380" y="160" text-anchor="middle" fill="#1e293b" font-size="10">cluster / reduce dims</text>
  <text x="380" y="182" text-anchor="middle" fill="#1e293b" font-size="10">anomaly detect</text>
  <rect x="510" y="60" width="220" height="150" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="620" y="86" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Reinforcement</text>
  <text x="620" y="112" text-anchor="middle" fill="#1e293b" font-size="11">state → action</text>
  <text x="620" y="134" text-anchor="middle" fill="#1e293b" font-size="11">reward feedback</text>
  <text x="620" y="160" text-anchor="middle" fill="#1e293b" font-size="10">maximize return</text>
  <text x="620" y="182" text-anchor="middle" fill="#1e293b" font-size="10">sparse + delayed</text>
</svg>
```

## 4. Architecture & Workflow

How to pick and run the right paradigm:

1. **Inventory your signal.** Do you have labeled answers? Only raw data? An environment that gives rewards for actions? This single question routes the whole project.
2. **If labels exist → supervised.** Decide classification vs regression by the target type. Split data, train `f_θ`, evaluate with accuracy/F1 or MAE/R².
3. **If no labels → unsupervised.** Pick the goal: grouping (clustering), compression/visualization (PCA/t-SNE/UMAP), or outlier finding (anomaly detection). Validate with domain judgment and internal metrics (silhouette, reconstruction error).
4. **If few labels + many unlabeled → semi/self-supervised.** Pre-train a representation on the unlabeled data, then fine-tune on the few labels.
5. **If the task is sequential decision-making with rewards → RL.** Define the state, action space, reward function, and environment; choose an algorithm (Q-learning, policy gradients, PPO).
6. **Balance exploration/exploitation (RL only).** Use ε-greedy or entropy bonuses so the agent keeps discovering while exploiting.
7. **Evaluate against the right metric.** Held-out accuracy for supervised; cluster quality/reconstruction for unsupervised; average return over episodes for RL.
8. **Iterate.** Improve labels/features (supervised), features/algorithms (unsupervised), or the reward function and exploration (RL).

```svg
<svg viewBox="0 0 760 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="230" rx="12" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="34" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Decision tree: which paradigm?</text>
  <rect x="300" y="55" width="160" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="83" text-anchor="middle" fill="#1e293b" font-size="12">What is my signal?</text>
  <rect x="40" y="140" width="180" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="130" y="166" text-anchor="middle" fill="#1e293b" font-size="11">Labels present</text>
  <text x="130" y="184" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">→ Supervised</text>
  <rect x="290" y="140" width="180" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="380" y="166" text-anchor="middle" fill="#1e293b" font-size="11">No labels</text>
  <text x="380" y="184" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">→ Unsupervised</text>
  <rect x="540" y="140" width="180" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="630" y="166" text-anchor="middle" fill="#1e293b" font-size="11">Reward per action</text>
  <text x="630" y="184" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">→ RL</text>
  <line x1="360" y1="101" x2="150" y2="138" stroke="#4f46e5" stroke-width="2"/>
  <line x1="380" y1="101" x2="380" y2="138" stroke="#4f46e5" stroke-width="2"/>
  <line x1="400" y1="101" x2="620" y2="138" stroke="#4f46e5" stroke-width="2"/>
  <text x="380" y="228" text-anchor="middle" fill="#1e293b" font-size="10">Few labels + much unlabeled → self/semi-supervised (pre-train, then fine-tune)</text>
</svg>
```

## 5. Implementation

**Supervised — classification (scikit-learn):**

```python
from sklearn.svm import SVC
from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split

X, y = load_iris(return_X_y=True)                 # x = flower measurements, y = species label
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=0)
clf = SVC().fit(Xtr, ytr)                          # learns X → Y from labeled answers
print(f"test accuracy = {clf.score(Xte, yte):.3f}")
# test accuracy = 0.974
```

**Unsupervised — clustering with no labels (K-means):**

```python
import numpy as np
from sklearn.cluster import KMeans
from sklearn.datasets import load_iris

X, _ = load_iris(return_X_y=True)                  # note: labels ignored on purpose
km = KMeans(n_clusters=3, n_init=10, random_state=0).fit(X)
print("cluster sizes:", np.bincount(km.labels_))
# cluster sizes: [50 62 38]  -> structure discovered without any y
```

**Reinforcement learning — tabular Q-learning:**

```python
import numpy as np
rng = np.random.default_rng(0)
n_states, n_actions = 5, 2
Q = np.zeros((n_states, n_actions))
alpha, gamma, eps = 0.1, 0.9, 0.2

def step(s, a):                                    # toy environment
    s2 = min(n_states - 1, s + a)
    r = 1.0 if s2 == n_states - 1 else 0.0         # reward only at the goal
    return s2, r

for episode in range(500):
    s = 0
    for _ in range(20):
        a = rng.integers(n_actions) if rng.random() < eps else int(Q[s].argmax())  # explore/exploit
        s2, r = step(s, a)
        Q[s, a] += alpha * (r + gamma * Q[s2].max() - Q[s, a])   # Bellman update
        s = s2
        if s == n_states - 1: break
print("learned policy:", Q.argmax(axis=1).tolist())
# learned policy: [1, 1, 1, 1, 0]  -> agent learns to move toward the reward
```

> **Optimization note:** Supervised models are optimized with better labels and features; a few thousand *clean* labels usually beat tens of thousands of noisy ones. RL is optimized largely through **reward shaping** and sample efficiency — a sparse reward can make learning intractable, so add intermediate rewards or use experience replay. For unsupervised work, standardize features first; distance-based methods like K-means are dominated by whichever feature has the largest scale.

## 6. Advantages, Disadvantages & Trade-offs

| Paradigm | Strength | Cost / Trade-off |
|---|---|---|
| Supervised | Accurate, well-understood metrics, easy to evaluate | Needs expensive labeled data; can't exceed label quality |
| Unsupervised | No labels needed; reveals hidden structure | Hard to evaluate; results can be ambiguous or unstable |
| Reinforcement learning | Learns behavior/control no labels can specify | Sample-hungry, unstable, reward design is hard |
| Self-supervised | Uses unlimited unlabeled data; powers foundation models | Huge compute; the pretext task must transfer to the real one |
| Semi-supervised | Cuts labeling cost with a little labeled data | Sensitive to wrong assumptions about the unlabeled data |

## 7. Common Mistakes & Best Practices

1. ⚠️ Forcing a labeling effort when the problem is really unsupervised. → ✅ First ask what signal you truly have; don't invent labels you can't trust.
2. ⚠️ Reaching for RL when supervised imitation would do. → ✅ If you have expert demonstrations (labels), imitation learning is far cheaper and more stable than RL.
3. ⚠️ Not standardizing features before K-means/PCA. → ✅ Scale features; distance/variance methods are dominated by the largest-scale feature.
4. ⚠️ Judging clusters by accuracy against labels that don't exist. → ✅ Use internal metrics (silhouette) plus domain review; clustering has no single "right" answer.
5. ⚠️ Using a sparse reward and expecting fast RL convergence. → ✅ Shape rewards or add intermediate signals; sparse rewards make credit assignment brutal.
6. ⚠️ Ignoring exploration in RL. → ✅ Keep an exploration mechanism (ε-greedy, entropy bonus) or the agent gets stuck in a local policy.
7. ⚠️ Treating self-supervised pre-training's pretext accuracy as the goal. → ✅ What matters is downstream transfer, not how well it predicts masked tokens.
8. ⚠️ Assuming more unlabeled data always helps semi-supervised learning. → ✅ It helps only if the unlabeled data shares the true structure; wrong assumptions hurt.
9. ⚠️ Mislabeling regression as classification (or vice versa). → ✅ Let the target type decide: continuous → regression, discrete categories → classification.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Supervised: inspect the confusion matrix and worst-loss examples — errors cluster and often reveal label noise. Unsupervised: visualize clusters (PCA/UMAP) to sanity-check that they mean something. RL: plot the reward curve per episode; flat or collapsing curves usually mean a broken reward or too little exploration.

**Monitoring.** Supervised: watch accuracy/F1 and input drift. Unsupervised: track cluster stability and reconstruction error over time. RL: monitor average return and the exploration rate; a policy that stops improving may have over-exploited.

**Security.** All paradigms are vulnerable to **data poisoning**; supervised models are also targets for adversarial examples. RL reward functions are exploitable — agents famously find degenerate strategies that maximize the literal reward (**reward hacking**), so red-team the reward. For LLM alignment (RLHF), guard the human-preference pipeline against manipulation.

**Performance & Scaling.** Supervised and self-supervised scale with data and GPUs (batching, distributed training). Unsupervised methods like K-means scale with mini-batch variants; approximate nearest neighbors handle large clustering. RL scales by parallelizing environments (many simulators at once) and using replay buffers to reuse experience.

## 9. Interview Questions

**Q: What distinguishes the three learning paradigms?**
A: The feedback signal. Supervised learns from labeled correct answers, unsupervised finds structure in unlabeled data, and reinforcement learning learns from a scalar reward for actions taken in an environment. Ask "what teaches the model — answers, structure, or rewards?"

**Q: When is unsupervised learning the right choice?**
A: When you have no labels and want to discover organization in the data — segment customers, compress or visualize high-dimensional data, or flag anomalies. It answers "how is this organized / what's unusual?" rather than "what is this?"

**Q: Why is reinforcement learning harder than supervised learning?**
A: Its signal is sparse, delayed, and evaluative — a reward that may arrive many steps after the decisive action and only says how good, not what was right. That forces the agent to solve credit assignment over time and to explore, making RL far more sample-hungry and unstable.

**Q: What is self-supervised learning and why does it matter?**
A: It's supervised learning where labels are generated automatically from the data — predict the next token, fill a masked patch. It matters because it unlocks unlimited unlabeled data for pre-training, which is exactly how modern LLMs and vision foundation models learn their representations.

**Q: How do you choose between classification and regression?**
A: By the target's type. If the output is a discrete category (spam/not-spam, species), it's classification; if it's a continuous quantity (price, temperature), it's regression. The choice also sets the loss (cross-entropy vs squared error) and metrics.

**Q: What is the exploration–exploitation trade-off?**
A: In RL, the agent must balance trying new actions to gather information (exploration) against using known-good actions to earn reward (exploitation). Too much exploitation gets stuck in a suboptimal policy; too much exploration wastes reward. Techniques like ε-greedy and entropy bonuses tune the balance.

**Q: Give a single product that could use all three paradigms.**
A: A music app: predicting song skips from labeled history is supervised; segmenting listeners by taste without predefined categories is unsupervised; and a session-level recommendation policy learned from engagement rewards is reinforcement learning.

**Q: (Senior) How does RLHF fit into this taxonomy, and why is it used to align LLMs?**
A: RLHF is reinforcement learning where the reward comes from a model trained on human preference comparisons. It's used because "helpful, honest, harmless" behavior can't be written as labeled targets, but humans can compare two responses. The preference model provides a reward signal that RL (e.g., PPO) optimizes the LLM against.

**Q: (Senior) What is reward hacking and how do you prevent it?**
A: Reward hacking is when an RL agent maximizes the literal reward in unintended, degenerate ways — exploiting a loophole rather than solving the task. Prevent it by red-teaming the reward function, adding constraints/penalties, using human oversight, and testing the policy for pathological strategies before deployment.

**Q: (Senior) How would you evaluate an unsupervised clustering model with no ground truth?**
A: Combine internal metrics (silhouette score, Davies–Bouldin, within-cluster variance) with stability checks (do clusters persist under resampling?) and, crucially, domain expert review of whether clusters are meaningful and actionable. There is no single correct answer, so triangulate.

**Q: (Senior) When would you prefer imitation learning over reinforcement learning?**
A: When you have expert demonstrations of the desired behavior. Imitation learning turns control into a supervised problem (map states to expert actions), which is far more stable and sample-efficient than reward-driven RL. RL is warranted when no demonstrations exist or you need to surpass human performance.

**Q: Why must you standardize features before K-means?**
A: K-means uses Euclidean distance, so a feature measured in large units (e.g., income in thousands) dominates one in small units (e.g., age), distorting the clusters. Standardizing to zero mean and unit variance gives every feature comparable influence.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Three paradigms, one distinguishing question — what signal teaches the model? Supervised uses labeled answers to learn `X → Y` (classification/regression); unsupervised uses no labels to find structure (clustering, dimensionality reduction, anomalies); reinforcement learning uses rewards to learn a policy that maximizes long-term return. Self-supervised manufactures labels from the data and pre-trains foundation models; semi-supervised mixes a few labels with lots of unlabeled data. Match method to available signal, standardize features for distance methods, and shape rewards to make RL tractable.

| Paradigm | Signal | Typical tasks | Example metric |
|---|---|---|---|
| Supervised | Labels | Classify, regress | Accuracy, F1, MAE |
| Unsupervised | None (structure) | Cluster, reduce dims, anomaly | Silhouette, reconstruction |
| Reinforcement | Reward | Control, game-play, RLHF | Average return |
| Self-supervised | Auto-labels | Pre-training | Downstream transfer |

- **Supervised** → labeled answers → learn a mapping.
- **Unsupervised** → no labels → find structure.
- **RL** → rewards → learn a policy over time.
- **Self-supervised** → labels from the data itself → foundation-model pre-training.
- **Exploration/exploitation** → RL must try new actions vs bank known rewards.

## 11. Hands-On Exercises & Mini Project

- [ ] Run the SVM and K-means snippets on Iris; compare the discovered clusters to the true labels using `adjusted_rand_score`.
- [ ] Standardize the Iris features and re-run K-means; observe how cluster sizes change.
- [ ] Modify the Q-learning reward to be non-sparse (small reward each step toward the goal) and compare convergence speed.
- [ ] Classify five business problems into supervised / unsupervised / RL and justify each in one sentence.
- [ ] Take a labeled dataset, hide 90% of the labels, and prototype a semi-supervised approach; compare to using only the 10%.

**Mini Project — Multi-paradigm customer analytics.**
*Goal:* Apply all three paradigms to one e-commerce dataset.
*Requirements:* (1) Supervised: predict churn from labeled history. (2) Unsupervised: segment customers with K-means and interpret the segments. (3) RL (simulated): a simple bandit that learns which of three promotions maximizes conversion reward. Report the right metric for each.
*Extensions:* Add a self-supervised step that pre-trains an autoencoder on all customer features and use its embedding as input to the churn model; compare accuracy with and without it.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *What Is AI?* (chapter 01) for where these paradigms sit in the field; *The AI Engineer's Toolkit & Workflow* (chapter 03) for how to evaluate each; *Linear Algebra for AI* (chapter 05) for the vector math behind clustering and PCA.

**Free Learning Resources**
- **Machine Learning Crash Course** — Google · *Beginner* · clear intro to supervised learning and evaluation. <https://developers.google.com/machine-learning/crash-course>
- **StatQuest — Machine Learning playlist** — Josh Starmer · *Beginner* · intuitive videos on classification, clustering, and PCA. <https://www.youtube.com/playlist?list=PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF>
- **Spinning Up in Deep RL** — OpenAI · *Intermediate* · the best free on-ramp to reinforcement learning, with code. <https://spinningup.openai.com/>
- **Reinforcement Learning: An Introduction** — Sutton & Barto (free PDF) · *Advanced* · the canonical RL textbook. <http://incompleteideas.net/book/the-book-2nd.html>
- **scikit-learn — Clustering & Unsupervised Guide** — scikit-learn · *Beginner* · practical unsupervised methods with examples. <https://scikit-learn.org/stable/modules/clustering.html>
- **Self-Supervised Learning (Lilian Weng)** — OpenAI blog · *Advanced* · deep survey of how modern pre-training generates its own labels. <https://lilianweng.github.io/posts/2019-11-10-self-supervised/>
- **CS229 Lecture Notes** — Stanford (Andrew Ng) · *Intermediate* · rigorous notes covering supervised and unsupervised learning. <https://cs229.stanford.edu/notes2022fall/main_notes.pdf>

---

*AI Engineering Handbook — chapter 04.*
