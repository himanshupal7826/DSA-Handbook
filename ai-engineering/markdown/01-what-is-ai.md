# 01 · What Is AI? ML vs DL vs Generative AI

> **In one line:** AI is the broad goal of building machines that act intelligently; machine learning, deep learning, and generative AI are progressively narrower toolkits nested inside it.

---

## 1. Overview

**Artificial Intelligence (AI)** is the umbrella discipline concerned with getting computers to perform tasks that normally require human intelligence — perceiving, reasoning, planning, understanding language, and acting. It is a *goal*, not a single technique. Under that goal live many families of methods: hand-written rules, search algorithms, probabilistic models, and — dominating the last decade — learning from data.

The problem AI exists to solve is that most valuable tasks are **too complex to specify by hand**. You cannot write an explicit `if/else` program to recognize a cat, translate Hindi to English, or summarize a legal contract, because the rules are fuzzy, high-dimensional, and full of exceptions. **Machine Learning (ML)** solves this by letting a program *infer* the rules from examples instead of having a human enumerate them. **Deep Learning (DL)** is the subset of ML that uses many-layered neural networks to learn those rules directly from raw data (pixels, audio, text). **Generative AI** is the subset of deep learning whose models produce new content — text, images, code, audio — by learning the distribution of their training data.

The one-line history: the term "artificial intelligence" was coined at the 1956 Dartmouth workshop; symbolic/rule-based AI dominated into the 1980s; statistical ML took over in the 1990s–2000s; deep learning ignited in 2012 (AlexNet); and generative AI + Large Language Models (LLMs) became mainstream after the 2017 Transformer paper and 2022's ChatGPT.

**Concrete example.** Your email spam filter is *classical ML* — it learns from labeled "spam/not-spam" examples using features like word frequencies. Face unlock on your phone is *deep learning* — a convolutional network maps pixels to an identity. ChatGPT drafting an email is *generative AI* — an LLM predicts the next token to compose new text. All three are "AI," but they sit at different depths of the nesting.

The durable mental model: **AI ⊃ ML ⊃ Deep Learning ⊃ Generative AI**, with **LLMs** a species of generative model and **agents** a way of wrapping an LLM in a loop that can call tools and take actions.

## 2. Core Concepts

- **Artificial Intelligence** — the broad field of making machines perform tasks that require intelligence; includes both learning and non-learning (rule-based, search) methods.
- **Machine Learning** — algorithms that improve at a task by learning patterns from data rather than being explicitly programmed.
- **Deep Learning** — ML using neural networks with many layers that learn hierarchical features directly from raw input; no manual feature engineering.
- **Generative AI** — models that learn a data distribution and sample new, plausible instances from it (text, images, audio, code).
- **Discriminative vs Generative** — discriminative models learn `P(y|x)` (a decision boundary; e.g., spam classifier); generative models learn `P(x)` or `P(x,y)` (how the data itself is distributed).
- **Large Language Model (LLM)** — a Transformer-based generative model trained on massive text to predict the next token, e.g., `claude-opus-4`, GPT-4.
- **Narrow (Weak) AI** — systems that excel at one specific task; every AI in production today is narrow.
- **Artificial General Intelligence (AGI)** — hypothetical AI matching human breadth across arbitrary tasks; not yet achieved.
- **Agent** — an LLM placed in a loop where it can reason, call tools/APIs, observe results, and act toward a goal.
- **Foundation Model** — a large model pre-trained on broad data that is adapted (fine-tuned/prompted) to many downstream tasks.

## 3. Theory & Mathematical Intuition

At the core, ML is **function approximation**. You assume there is some true but unknown function `f: X → Y` mapping inputs to outputs, and you fit a parameterized approximation `f_θ` by minimizing a loss over data:

```
θ* = argmin_θ  (1/N) Σ_i  L( f_θ(x_i), y_i )
```

For a **discriminative** classifier you model the conditional `P(y|x)` and pick the label with highest probability. For a **generative** model you learn `P(x)` (unsupervised) or `P(x,y)`; you can then *sample* new `x`. LLMs are generative over sequences and factorize the joint probability of a token sequence by the chain rule:

```
P(w_1, …, w_T) = Π_t  P(w_t | w_1, …, w_{t-1})
```

Each conditional `P(w_t | context)` is produced by a Transformer and turned into a probability distribution with **softmax**:

```
softmax(z_i) = e^{z_i} / Σ_j e^{z_j}
```

The reason **deep** learning wins on perception is the *representation learning* argument: a stack of nonlinear layers composes simple features (edges → textures → parts → objects), so the network learns the features instead of a human designing them. This is why the same architecture handles images, audio, and text with minimal change.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="20" y="20" width="680" height="260" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="360" y="48" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Nested scope of the field</text>
  <ellipse cx="360" cy="175" rx="320" ry="95" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="70" y="120" fill="#1e293b" font-size="13" font-weight="700">Artificial Intelligence</text>
  <ellipse cx="380" cy="180" rx="250" ry="72" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="180" y="140" fill="#1e293b" font-size="13" font-weight="700">Machine Learning</text>
  <ellipse cx="405" cy="185" rx="175" ry="52" fill="#fef3c7" stroke="#d97706"/>
  <text x="300" y="160" fill="#1e293b" font-size="13" font-weight="700">Deep Learning</text>
  <ellipse cx="430" cy="190" rx="105" ry="34" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="430" y="188" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Generative AI</text>
  <text x="430" y="204" text-anchor="middle" fill="#1e293b" font-size="10">LLMs, diffusion</text>
</svg>
```

## 4. Architecture & Workflow

How an AI capability comes to life, end to end:

1. **Frame the task** — decide what `X` (input) and `Y` (output) are, and whether the problem is discriminative (predict a label/number) or generative (produce content).
2. **Collect & label data** — gather examples. Supervised tasks need labels; generative pre-training uses raw unlabeled corpora.
3. **Choose a model family** — a linear/tree model for tabular ML, a CNN for images, a Transformer for text/sequences.
4. **Train** — minimize the loss with gradient descent, adjusting parameters `θ` over many passes (epochs).
5. **Evaluate** — measure on held-out data (accuracy, F1, perplexity, human preference) to estimate real-world performance.
6. **Deploy** — serve the model behind an API; for LLMs this is often a hosted endpoint you call with a prompt.
7. **Wrap in an application** — add retrieval (RAG), tools, or an agent loop so the model can access fresh data and take actions.
8. **Monitor & iterate** — watch for drift, collect feedback, and retrain or re-prompt.

```svg
<svg viewBox="0 0 760 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="210" rx="12" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">From data to a deployed AI capability</text>
  <rect x="30" y="70" width="120" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="98" text-anchor="middle" fill="#1e293b" font-size="12">Data +</text>
  <text x="90" y="114" text-anchor="middle" fill="#1e293b" font-size="12">Labels</text>
  <rect x="190" y="70" width="120" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="250" y="105" text-anchor="middle" fill="#1e293b" font-size="12">Train model</text>
  <rect x="350" y="70" width="120" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="410" y="105" text-anchor="middle" fill="#1e293b" font-size="12">Evaluate</text>
  <rect x="510" y="70" width="120" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="570" y="105" text-anchor="middle" fill="#1e293b" font-size="12">Deploy API</text>
  <rect x="510" y="150" width="220" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="620" y="180" text-anchor="middle" fill="#1e293b" font-size="12">App: RAG / tools / agent</text>
  <line x1="150" y1="100" x2="188" y2="100" stroke="#4f46e5" stroke-width="2"/>
  <line x1="310" y1="100" x2="348" y2="100" stroke="#4f46e5" stroke-width="2"/>
  <line x1="470" y1="100" x2="508" y2="100" stroke="#4f46e5" stroke-width="2"/>
  <line x1="570" y1="130" x2="570" y2="148" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="188,100 180,96 180,104" fill="#4f46e5"/>
  <polygon points="348,100 340,96 340,104" fill="#4f46e5"/>
  <polygon points="508,100 500,96 500,104" fill="#4f46e5"/>
</svg>
```

## 5. Implementation

Three tiny examples, one from each layer of the hierarchy.

**Classical ML — a discriminative classifier (scikit-learn):**

```python
from sklearn.linear_model import LogisticRegression
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import train_test_split

X, y = load_breast_cancer(return_X_y=True)
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)

clf = LogisticRegression(max_iter=5000).fit(Xtr, ytr)
print(f"accuracy = {clf.score(Xte, yte):.3f}")
# accuracy = 0.956  -> learned P(malignant | features) from labeled data
```

**Deep learning — a neural net that learns features (PyTorch):**

```python
import torch, torch.nn as nn

net = nn.Sequential(
    nn.Linear(30, 64), nn.ReLU(),   # hidden layer learns feature combos
    nn.Linear(64, 2),               # 2 output logits
)
x = torch.randn(8, 30)              # batch of 8 samples, 30 features each
logits = net(x)
probs = torch.softmax(logits, dim=-1)
print(probs.shape)   # torch.Size([8, 2]) -> class probabilities per sample
```

**Generative AI — call an LLM (modern Anthropic SDK):**

```python
from anthropic import Anthropic

client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment
msg = client.messages.create(
    model="claude-opus-4",
    max_tokens=256,
    messages=[{"role": "user",
               "content": "Explain the difference between ML and DL in 2 sentences."}],
)
print(msg.content[0].text)
# -> newly generated text sampled token-by-token from P(next token | context)
```

> **Optimization note:** For classical ML, the win is usually *feature engineering* and regularization, not a bigger model. For deep learning, batch your inputs and use a GPU (`net.to("cuda")`). For LLMs, the cheapest speedups are *prompt caching* of stable system prompts and picking the smallest model that passes your evals (e.g., `claude-sonnet-4` before reaching for `claude-opus-4`).

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Classical ML | Interpretable, cheap, works on small tabular data | Needs hand-crafted features; weak on raw pixels/audio/text |
| Deep learning | Learns features automatically; state-of-the-art perception | Data- and compute-hungry; opaque; harder to debug |
| Generative AI / LLMs | General-purpose, zero-shot, natural-language interface | Hallucinations, cost/latency, non-determinism, data governance |
| Rule-based AI | Fully predictable and auditable | Brittle; doesn't generalize; expensive to maintain |
| Narrow AI (all today) | Reliable within its scope | No transfer beyond its trained task |

## 7. Common Mistakes & Best Practices

1. ⚠️ Calling every statistical model "AI" and every AI "an LLM." → ✅ Use the nesting precisely: pick the *narrowest* accurate term.
2. ⚠️ Reaching for deep learning on 500 rows of tabular data. → ✅ Start with logistic regression or gradient-boosted trees; DL rarely wins on small tabular sets.
3. ⚠️ Treating an LLM as a database of facts. → ✅ Ground it with retrieval (RAG) or tools; expect and check for hallucinations.
4. ⚠️ Evaluating on the training data. → ✅ Always hold out a test set (and a separate validation set for tuning).
5. ⚠️ Confusing generative and discriminative goals. → ✅ Ask "am I *deciding* about `x` or *creating* new `x`?" — it dictates the model family.
6. ⚠️ Assuming more parameters always means better. → ✅ Match model size to data and task; the smallest model that passes evals wins on cost and latency.
7. ⚠️ Ignoring data quality while tuning hyperparameters. → ✅ Cleaner labels beat cleverer models almost every time.
8. ⚠️ Believing current systems are "general." → ✅ All deployed AI is narrow; design for its scope and failure modes.
9. ⚠️ Skipping a baseline. → ✅ Always compare against a trivial baseline (majority class, keyword rules) before claiming a win.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** For classical/deep models, inspect a confusion matrix and the worst-scoring examples — errors cluster. For LLM apps, log the *full* prompt, tools, and raw response; most "model bugs" are actually prompt or retrieval bugs.

**Monitoring.** Track input **distribution drift** (features/queries shifting away from training), output quality (accuracy/F1 offline; human thumbs and task-success online), latency (p50/p95/p99), and cost per request (tokens for LLMs).

**Security.** Classical ML risks: training-data poisoning and membership inference. LLM risks: **prompt injection**, data exfiltration through tools, and jailbreaks. Never trust model output as code/SQL without validation; sandbox any tool the model can call; keep secrets out of prompts.

**Performance & Scaling.** Batch and quantize deep models; use GPUs. For LLMs, cache stable prompt prefixes, stream tokens for perceived latency, route easy requests to smaller models, and set token/QPS budgets so a runaway agent loop can't bankrupt you.

## 9. Interview Questions

**Q: What is the relationship between AI, ML, DL, and generative AI?**
A: They are nested subsets. AI is the broad goal of intelligent behavior; ML is the subset that learns from data; deep learning is the subset of ML using multi-layer neural networks; generative AI is the subset of deep learning that produces new content. Each inner circle is a more specialized toolkit.

**Q: How do discriminative and generative models differ?**
A: Discriminative models learn `P(y|x)` — a decision boundary between classes — and are used to classify or predict. Generative models learn `P(x)` or `P(x,y)` — the data distribution itself — and can sample new instances. A spam filter is discriminative; an LLM is generative.

**Q: Why did deep learning take off around 2012 and not earlier?**
A: The ideas (backprop, CNNs) existed for decades, but three enablers converged: large labeled datasets (ImageNet), cheap parallel compute (GPUs), and better training tricks (ReLU, dropout). AlexNet's 2012 ImageNet win made the advantage undeniable.

**Q: When would you NOT use deep learning?**
A: On small or moderate tabular datasets, when interpretability is required, or when you have tight latency/compute budgets. Logistic regression or gradient-boosted trees are usually faster, cheaper, and just as accurate there.

**Q: What is narrow AI versus AGI?**
A: Narrow (weak) AI is competent at one specific task and does not transfer — every AI in production is narrow. AGI is a hypothetical system with human-level breadth across arbitrary tasks; it does not yet exist.

**Q: Where do LLMs and agents fit in the taxonomy?**
A: An LLM is a generative deep-learning model over text (a Transformer trained to predict the next token). An agent is not a model class but a pattern: wrap an LLM in a loop where it can reason, call tools, observe results, and act toward a goal.

**Q: Is a rule-based expert system "AI"?**
A: Yes — historically it was the dominant form of AI. It is AI but not ML, because a human writes the rules rather than the system learning them from data. It is predictable and auditable but brittle and hard to scale.

**Q: (Senior) A stakeholder wants to "add AI" to a product. How do you decide what technique to use?**
A: Start from the task and constraints, not the technology. Define input/output and whether it's discriminative or generative, estimate available labeled data, and set latency/cost/interpretability requirements. Then pick the narrowest tool that meets them — often rules or classical ML beat an LLM on cost, latency, and predictability.

**Q: (Senior) Why is representation learning the core argument for deep learning?**
A: Stacked nonlinear layers compose features hierarchically — edges to textures to parts to objects — so the network *learns* the features instead of engineers designing them. This is why one architecture (the Transformer) transfers across text, images, and audio, and why deep models dominate raw-perception tasks.

**Q: (Senior) How do you tell a genuine AI need from over-engineering?**
A: Ask whether the mapping from input to output is too complex or fuzzy to specify by hand and whether you have data to learn it. If a short rule set or a SQL query suffices, that's simpler, cheaper, and more reliable. AI earns its keep on high-dimensional, exception-heavy problems, not on things a deterministic program handles.

**Q: (Senior) What are the main failure modes of generative AI in production?**
A: Hallucination (confident but wrong output), prompt injection and data exfiltration, non-determinism that complicates testing, latency and per-token cost, and data-governance/privacy exposure. Mitigations include retrieval grounding, output validation, sandboxed tools, evals, caching, and model routing.

**Q: What's the difference between a foundation model and a task-specific model?**
A: A foundation model is pre-trained on broad data and adapted to many downstream tasks via prompting or fine-tuning. A task-specific model is trained for one job. Foundation models trade some per-task efficiency for enormous flexibility and reuse.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** AI is the goal of intelligent machines. ML learns rules from data instead of hand-coding them. Deep learning is ML with many-layered neural nets that learn features from raw input. Generative AI is deep learning that *creates* content; LLMs are its text species and agents wrap LLMs in tool-using loops. Choose the narrowest tool that solves the task: rules < classical ML < deep learning < generative AI, in rising order of power and cost. Everything deployed today is *narrow* AI.

| Term | Learns from data? | Uses neural nets? | Creates new content? |
|---|---|---|---|
| Rule-based AI | No | No | No |
| Classical ML | Yes | Not necessarily | No (usually) |
| Deep learning | Yes | Yes | Not necessarily |
| Generative AI / LLM | Yes | Yes | Yes |

- **AI vs ML** → AI is the goal; ML is one way to reach it (learning from data).
- **Discriminative vs generative** → `P(y|x)` (decide) vs `P(x)` (create).
- **Why deep learning won** → representation learning + data + GPUs.
- **Narrow vs AGI** → single-task competence vs human-level breadth (hypothetical).
- **What an agent is** → an LLM in a loop with tools and a goal, not a new model type.

## 11. Hands-On Exercises & Mini Project

- [ ] Classify five real products (Netflix recommendations, Face ID, ChatGPT, a thermostat, chess engine) into rule-based / classical ML / deep learning / generative AI and justify each.
- [ ] Train the scikit-learn logistic-regression example above, then swap in a `RandomForestClassifier` and compare accuracy.
- [ ] Take the PyTorch snippet and add a second hidden layer; observe how output shape stays `(8, 2)`.
- [ ] Call an LLM with the same prompt twice at temperature 0 and at temperature 1; note determinism differences.
- [ ] Write a one-paragraph explanation of why a spam filter is discriminative and an email-drafting assistant is generative.

**Mini Project — "Which AI is this?" classifier.**
*Goal:* Build a small CLI that, given a plain-English description of a system, labels which layer of the AI hierarchy it belongs to.
*Requirements:* Accept a description string; use an LLM with a carefully engineered prompt that returns one of {rule-based, classical-ML, deep-learning, generative-AI} plus a one-line reason; print the label and reason.
*Extensions:* Add a confidence score; log all inputs/outputs; add a small hand-labeled test set and measure the classifier's accuracy against your own labels.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *A Brief History of AI* (chapter 02) for how these layers emerged; *The AI Engineer's Toolkit & Workflow* (chapter 03) for how to build with them; *Types of ML* (chapter 04) for the learning paradigms inside the ML circle.

**Free Learning Resources**
- **Elements of AI** — University of Helsinki & MinnaLearn · *Beginner* · gentle, non-mathematical tour of what AI is and isn't. <https://www.elementsofai.com/>
- **Machine Learning Crash Course** — Google · *Beginner* · hands-on intro to ML concepts with interactive exercises. <https://developers.google.com/machine-learning/crash-course>
- **But what is a neural network?** — 3Blue1Brown · *Beginner* · the clearest visual intuition for what deep learning actually does. <https://www.youtube.com/watch?v=aircAruvnKk>
- **Neural Networks: Zero to Hero** — Andrej Karpathy · *Intermediate* · builds the whole stack from scratch, demystifying "deep learning." <https://karpathy.ai/zero-to-hero.html>
- **Anthropic Docs — Intro to Claude** — Anthropic · *Beginner* · what an LLM is and how to call one with the Messages API. <https://docs.anthropic.com/en/docs/intro-to-claude>
- **Generative AI for Everyone** — DeepLearning.AI (Andrew Ng) · *Beginner* · what generative AI can and cannot do, for practitioners. <https://www.deeplearning.ai/courses/generative-ai-for-everyone/>
- **AI: A Modern Approach (companion site)** — Russell & Norvig · *Intermediate* · the canonical map of the whole field. <https://aima.cs.berkeley.edu/>

---

*AI Engineering Handbook — chapter 01.*
