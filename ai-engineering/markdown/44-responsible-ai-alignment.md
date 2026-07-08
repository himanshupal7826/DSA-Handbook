# 44 · Responsible AI, Safety & Alignment

> **In one line:** The techniques and processes — fairness auditing, transparency, RLHF, and Constitutional AI — that make a capable model *behave* the way its builders and users actually want.

---

## 1. Overview

A large language model trained purely to predict the next token is astonishingly capable and completely amoral: it will just as happily draft a phishing email as a birthday card, and it will confidently reproduce whatever biases lurk in its training corpus. **Alignment** is the engineering problem of steering that raw capability toward being *helpful, honest, and harmless*, and **Responsible AI** is the broader socio-technical practice — fairness, transparency, accountability, and governance — of deploying such systems without causing disproportionate harm. The two are inseparable: alignment techniques are the levers, and responsible-AI processes decide which way to pull them and how to prove you did.

The problem it solves is the gap between the **training objective** (predict text) and the **behavioral objective** (be a trustworthy assistant). Pretraining gives a model knowledge and fluency but no notion of which answers are appropriate. Left unaligned, models are sycophantic, easily jailbroken, prone to reflecting societal bias in hiring or lending contexts, and opaque about why they produced a given answer. Responsible AI adds the accountability layer: who is accountable when the model denies a loan unfairly, and can you show the process was fair?

Historically, the modern recipe emerged in stages: **InstructGPT (2022)** showed that reinforcement learning from human feedback (RLHF) could turn GPT-3 into something that followed instructions; **Constitutional AI (Anthropic, 2022)** showed a model could critique and revise its own outputs against a written set of principles, reducing the human-labeling burden; and **fairness research** (COMPAS recidivism debates, Gender Shades, 2018) had already established that unexamined models encode discrimination. Regulators followed with the EU AI Act and the NIST AI Risk Management Framework.

A concrete example: a bank fine-tunes an LLM to summarize loan applications. Responsible AI requires that the summaries not systematically emphasize negatives for one demographic (fairness), that the bank can explain to a regulator what the model does and its known limits (transparency), and that a human makes the final decision (accountability). Alignment techniques ensure the model refuses to invent facts about an applicant, declines to give discriminatory reasoning, and stays calibrated about its uncertainty. Getting one without the other is a liability.

## 2. Core Concepts

- **Alignment** — making a model's behavior match human intent and values, beyond what the raw training objective produces.
- **HHH** — the *helpful, honest, harmless* triad Anthropic uses as the north-star behavioral spec.
- **RLHF (Reinforcement Learning from Human Feedback)** — train a reward model on human preference comparisons, then optimize the policy against it, usually with PPO.
- **Reward model** — a network that scores a response's quality/preference, learned from pairs of "chosen vs rejected" outputs.
- **Constitutional AI (CAI) / RLAIF** — use a written set of principles ("a constitution") and the model itself to critique and revise outputs, replacing much human feedback with AI feedback.
- **DPO (Direct Preference Optimization)** — a simpler alternative to RLHF that optimizes preferences directly with a classification-style loss, no separate reward model or RL loop.
- **Fairness** — the absence of unjustified performance or outcome disparities across protected groups; measured by metrics like demographic parity or equalized odds.
- **Bias** — systematic skew in data or model behavior that disadvantages a group; can be historical, representational, or measurement bias.
- **Transparency & interpretability** — the ability to describe what a model does (documentation) and why it produced an output (mechanistic/feature-level explanation).
- **Sycophancy** — the failure mode where a model tells users what they want to hear rather than what is true, often a side effect of preference training.

## 3. Theory & Mathematical Intuition

RLHF has three stages. First, **supervised fine-tuning (SFT)** on demonstration data gives a baseline policy `π_SFT`. Second, a **reward model** `r_φ` is trained on human preference pairs. Given a prompt `x` with a chosen response `y_w` and rejected `y_l`, the Bradley–Terry model says the probability a human prefers `y_w` is a logistic function of the reward gap, so the loss is:

```
L(φ) = - E[ log σ( r_φ(x, y_w) - r_φ(x, y_l) ) ]
```

Third, the policy is optimized to maximize reward while staying close to the reference model, penalized by a KL term so it does not drift into gibberish that games the reward:

```
max_π  E_{x, y~π}[ r_φ(x, y) ] - β · KL( π(y|x) || π_ref(y|x) )
```

The `β·KL` term is the safety valve: without it the policy overfits to the reward model's blind spots (**reward hacking**), producing verbose or sycophantic text that scores high but is worse.

**DPO** collapses this into a single loss with no RL loop by observing that the optimal policy for the KL-regularized objective has a closed form. The DPO loss reweights the same preference data directly on the policy:

```
L_DPO = - E[ log σ( β·log(π(y_w|x)/π_ref(y_w|x)) - β·log(π(y_l|x)/π_ref(y_l|x)) ) ]
```

**Constitutional AI** replaces the human in "chosen vs rejected" with the model itself: given a response, the model critiques it against a principle ("was this harmful?"), revises it, and the revised/original pair becomes preference data — *RL from AI Feedback (RLAIF)*.

Fairness is a set of *mutually incompatible* mathematical definitions. Two common ones, with `Ŷ` the prediction, `A` the protected attribute, `Y` the true label:

```
Demographic parity:  P(Ŷ=1 | A=a) = P(Ŷ=1 | A=b)
Equalized odds:      P(Ŷ=1 | Y=y, A=a) = P(Ŷ=1 | Y=y, A=b)  for all y
```

An impossibility result (Kleinberg et al.) proves you generally cannot satisfy calibration, demographic parity, and equalized odds simultaneously — so fairness is a *choice*, not a solved equation.

```svg
<svg viewBox="0 0 700 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="700" height="300" fill="#ffffff"/>
  <text x="350" y="30" fill="#1e293b" font-size="16" font-weight="bold" text-anchor="middle">RLHF: reward gap drives preference probability</text>
  <line x1="70" y1="240" x2="640" y2="240" stroke="#1e293b" stroke-width="2"/>
  <line x1="350" y1="250" x2="350" y2="60" stroke="#1e293b" stroke-width="2"/>
  <text x="640" y="265" fill="#1e293b" font-size="13" text-anchor="end">r(y_w) - r(y_l)</text>
  <text x="360" y="72" fill="#1e293b" font-size="13">P(prefer y_w)</text>
  <path d="M70 235 C 250 232, 320 200, 350 150 C 380 100, 450 68, 640 65" fill="none" stroke="#4f46e5" stroke-width="3"/>
  <line x1="70" y1="150" x2="640" y2="150" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"/>
  <text x="80" y="145" fill="#94a3b8" font-size="12">0.5</text>
  <circle cx="470" cy="90" r="6" fill="#16a34a"/>
  <text x="482" y="86" fill="#1e293b" font-size="12">large positive gap: y_w confidently preferred</text>
  <circle cx="220" cy="228" r="6" fill="#d97706"/>
  <text x="130" y="215" fill="#1e293b" font-size="12">negative gap</text>
</svg>
```

## 4. Architecture & Workflow

The standard alignment pipeline transforms a raw pretrained model into a deployable assistant, then wraps it in a governance process.

1. **Pretrain** a base model on a broad corpus — pure next-token prediction, no behavior shaping.
2. **Supervised fine-tune (SFT)** on high-quality demonstrations of the desired behavior (instruction following, refusals, formatting).
3. **Collect preferences.** Humans (RLHF) or the model itself against a constitution (RLAIF/CAI) label pairs of responses as chosen/rejected.
4. **Train the reward model** (RLHF) or skip straight to **DPO** on the preference pairs.
5. **Optimize the policy** with PPO against the reward model plus a KL penalty, or apply the DPO loss directly. Constitutional AI inserts self-critique-and-revise before this step.
6. **Red-team & evaluate.** Probe for jailbreaks, bias, and harmful compliance; run fairness audits across demographic slices; measure calibration and sycophancy.
7. **Document & govern.** Produce a model card and system card, define acceptable-use policy, and add human-in-the-loop review for high-stakes decisions.
8. **Deploy & monitor.** Watch for drift, bias regressions, and emerging jailbreaks; feed findings back into steps 3–6.

```svg
<svg viewBox="0 0 740 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="740" height="320" fill="#ffffff"/>
  <rect x="20" y="40" width="120" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="80" y="66" fill="#1e293b" font-size="13" text-anchor="middle">Pretrained</text>
  <text x="80" y="84" fill="#1e293b" font-size="13" text-anchor="middle">base model</text>
  <rect x="175" y="40" width="120" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="235" y="72" fill="#1e293b" font-size="13" text-anchor="middle">SFT</text>
  <rect x="330" y="40" width="150" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="405" y="65" fill="#1e293b" font-size="12" text-anchor="middle">Preferences:</text>
  <text x="405" y="83" fill="#1e293b" font-size="12" text-anchor="middle">human (RLHF) / AI (CAI)</text>
  <rect x="515" y="40" width="150" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="590" y="65" fill="#1e293b" font-size="12" text-anchor="middle">Optimize policy</text>
  <text x="590" y="83" fill="#1e293b" font-size="12" text-anchor="middle">PPO+KL or DPO</text>
  <line x1="140" y1="68" x2="173" y2="68" stroke="#1e293b" stroke-width="2"/>
  <line x1="295" y1="68" x2="328" y2="68" stroke="#1e293b" stroke-width="2"/>
  <line x1="480" y1="68" x2="513" y2="68" stroke="#1e293b" stroke-width="2"/>
  <rect x="150" y="160" width="180" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="240" y="185" fill="#1e293b" font-size="13" text-anchor="middle">Red-team + fairness</text>
  <text x="240" y="203" fill="#1e293b" font-size="13" text-anchor="middle">audit</text>
  <rect x="380" y="160" width="180" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="470" y="185" fill="#1e293b" font-size="13" text-anchor="middle">Model card +</text>
  <text x="470" y="203" fill="#1e293b" font-size="13" text-anchor="middle">governance</text>
  <line x1="590" y1="96" x2="470" y2="158" stroke="#1e293b" stroke-width="2"/>
  <line x1="380" y1="188" x2="332" y2="188" stroke="#1e293b" stroke-width="2"/>
  <rect x="230" y="255" width="260" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="360" y="283" fill="#1e293b" font-size="13" text-anchor="middle">Deploy + monitor (loop back to preferences)</text>
  <line x1="240" y1="216" x2="300" y2="253" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 5"/>
  <line x1="360" y1="255" x2="405" y2="98" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 5"/>
</svg>
```

## 5. Implementation

A compact, runnable illustration of the reward-model loss and DPO loss in PyTorch — the mathematical heart of preference alignment.

```python
import torch
import torch.nn.functional as F

# Reward-model preference loss (Bradley-Terry).
# r_w, r_l: reward-model scores for chosen and rejected responses.
def reward_model_loss(r_w: torch.Tensor, r_l: torch.Tensor) -> torch.Tensor:
    # -log sigmoid(r_w - r_l): pushes chosen above rejected.
    return -F.logsigmoid(r_w - r_l).mean()

r_w = torch.tensor([2.1, 0.8, 3.0])
r_l = torch.tensor([1.0, 1.2, 0.5])
print(reward_model_loss(r_w, r_l).item())  # ~0.42; note middle pair is "wrong" (r_l > r_w)
```

```python
# Direct Preference Optimization loss: no reward model, no RL loop.
# logp_* are summed log-probs of the response under policy / reference.
def dpo_loss(logp_pol_w, logp_pol_l, logp_ref_w, logp_ref_l, beta=0.1):
    pol_logratio = logp_pol_w - logp_pol_l
    ref_logratio = logp_ref_w - logp_ref_l
    return -F.logsigmoid(beta * (pol_logratio - ref_logratio)).mean()

# Toy numbers: policy already prefers chosen more than the reference did -> low loss.
loss = dpo_loss(
    torch.tensor([-5.0]), torch.tensor([-8.0]),   # policy: chosen higher prob
    torch.tensor([-6.0]), torch.tensor([-7.0]),   # reference: closer
    beta=0.1,
)
print(round(loss.item(), 4))  # ~0.61
```

A fairness audit computing demographic parity and equalized-odds gaps from predictions:

```python
import numpy as np

def fairness_report(y_true, y_pred, group):
    y_true, y_pred, group = map(np.asarray, (y_true, y_pred, group))
    out = {}
    groups = np.unique(group)
    # Selection rate per group -> demographic parity difference.
    rates = {g: y_pred[group == g].mean() for g in groups}
    out["demographic_parity_diff"] = max(rates.values()) - min(rates.values())
    # True positive rate per group -> equalized odds (TPR gap).
    tpr = {}
    for g in groups:
        m = (group == g) & (y_true == 1)
        tpr[g] = y_pred[m].mean() if m.any() else float("nan")
    out["tpr_gap"] = np.nanmax(list(tpr.values())) - np.nanmin(list(tpr.values()))
    out["selection_rates"] = rates
    return out

rng = np.random.default_rng(0)
grp = rng.integers(0, 2, 1000)
y = rng.integers(0, 2, 1000)
pred = ((rng.random(1000) + 0.15 * grp) > 0.5).astype(int)  # injected bias
print(fairness_report(y, pred, grp))
# {'demographic_parity_diff': ~0.14, 'tpr_gap': ~0.13, 'selection_rates': {0: .., 1: ..}}
```

Using a written constitution as a self-critique step against a live model (illustrative Anthropic Messages API):

```python
from anthropic import Anthropic
client = Anthropic()

PRINCIPLE = "Responses must not reveal private personal data or give discriminatory reasoning."

def critique_and_revise(prompt: str, draft: str) -> str:
    msg = client.messages.create(
        model="claude-sonnet-4",
        max_tokens=600,
        system=f"Constitution: {PRINCIPLE}\nCritique the draft against the constitution, then output a revised, compliant answer only.",
        messages=[{"role": "user",
                   "content": f"PROMPT:\n{prompt}\n\nDRAFT:\n{draft}"}],
    )
    return msg.content[0].text
```

> **Optimization:** DPO removes the reward-model training and PPO loop, cutting compute and instability by a large factor — it is now the default for many open-weight fine-tunes. When you must use RLHF, tune the KL coefficient `β` carefully: too low and the policy reward-hacks into sycophancy, too high and it barely learns. For fairness, prefer post-hoc threshold adjustment per group over retraining when you only need to close an outcome gap quickly.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| RLHF | Strong alignment, flexible reward | Expensive human labels; unstable PPO; reward hacking |
| DPO | Simple, stable, no reward model | Slightly less expressive; sensitive to `β` and data quality |
| Constitutional AI / RLAIF | Scales feedback, auditable principles | Inherits model's own blind spots; principles need careful wording |
| Fairness constraints | Reduces outcome disparities | Definitions conflict; may lower overall accuracy |
| Transparency (model cards) | Accountability, regulatory fit | Effort to maintain; can reveal capabilities to attackers |
| Human-in-the-loop | Catches high-stakes errors | Latency and cost; humans can rubber-stamp |
| Heavy safety tuning | Fewer harmful outputs | Over-refusal; unhelpful on benign edge cases |

## 7. Common Mistakes & Best Practices

1. ⚠️ Optimizing reward with no KL penalty → ✅ Keep the `β·KL` term so the policy stays near the reference and does not reward-hack.
2. ⚠️ Treating fairness as one metric → ✅ Report multiple (parity, equalized odds, calibration) and state which trade-off you chose and why.
3. ⚠️ Auditing only aggregate accuracy → ✅ Slice metrics by protected group; disparities hide in the average.
4. ⚠️ Over-tuning for harmlessness → ✅ Balance against helpfulness; measure over-refusal on benign prompts.
5. ⚠️ Assuming preference training removes bias → ✅ Bias enters from labelers and data; audit explicitly after alignment.
6. ⚠️ No documentation → ✅ Ship a model card and system card describing intended use, limits, and eval results.
7. ⚠️ Sycophancy from naive preference data → ✅ Include preferences that reward honest disagreement, not just agreeable answers.
8. ⚠️ One-off alignment then forget → ✅ Re-red-team and re-audit after every major change and periodically in production.
9. ⚠️ Human-in-the-loop as a rubber stamp → ✅ Design reviews so the human can actually override, with the info needed to do so.
10. ⚠️ Ignoring provenance of preference labels → ✅ Track labeler guidelines and demographics; label quality bounds alignment quality.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When an aligned model misbehaves, first localize: is it an SFT gap (never demonstrated), a reward-model error (rewards the wrong thing), or reward hacking (KL too low)? Inspect reward-model scores on the failing outputs — if it scores a bad answer highly, the reward model is the culprit. For fairness bugs, trace whether disparity comes from the data, the labels, or the threshold.

**Monitoring.** Track refusal rate (over- and under-refusal), sycophancy probes, calibration (does stated confidence match accuracy?), and group-sliced quality metrics over time. Alert on regressions after model or prompt updates. Log a sample of high-stakes decisions for human audit.

**Security.** Alignment is not a security boundary — aligned models are still jailbreakable (see ch. 45). Combine alignment with runtime guardrails and least-privilege tool access. Protect the reward model and constitution as sensitive assets; a poisoned preference dataset can silently install a backdoor.

**Scaling & governance.** RLAIF/Constitutional AI scales feedback beyond what human labelers can produce, which is essential at frontier scale. Governance scales through process: standardized model cards, an incident response plan, an acceptable-use policy, and mapping controls to frameworks like the NIST AI RMF or the EU AI Act risk tiers. Keep humans accountable for outcomes even when the model is automated.

## 9. Interview Questions

**Q: What problem does alignment solve that pretraining does not?**
A: Pretraining optimizes next-token prediction, which yields knowledge and fluency but no sense of appropriate behavior. Alignment closes the gap between that training objective and the behavioral objective — being helpful, honest, and harmless — via SFT plus preference optimization.

**Q: Walk through the three stages of RLHF.**
A: (1) Supervised fine-tuning on demonstrations to get a baseline policy; (2) train a reward model on human preference pairs using the Bradley–Terry logistic loss; (3) optimize the policy with PPO to maximize reward minus a KL penalty to the reference model, which prevents reward hacking.

**Q: What is reward hacking and how does the KL term prevent it?**
A: Reward hacking is when the policy finds outputs that score high on the imperfect reward model but are actually worse (verbose, sycophantic). The `β·KL(π‖π_ref)` penalty keeps the policy close to the reference distribution, bounding how far it can exploit the reward model's blind spots.

**Q: How does DPO differ from RLHF?**
A: DPO skips the separate reward model and the RL loop, optimizing the preference data directly with a logistic loss over the policy-vs-reference log-ratio. It is simpler, more stable, and cheaper, at some cost in expressiveness and sensitivity to `β` and data quality.

**Q: What is Constitutional AI?**
A: An alignment method where the model critiques and revises its own outputs against a written set of principles (the constitution), generating AI feedback instead of human labels (RLAIF). It scales the feedback process and makes the guiding principles explicit and auditable.

**Q: Name two fairness metrics and why you can't always satisfy both.**
A: Demographic parity (equal selection rates across groups) and equalized odds (equal true/false positive rates across groups). An impossibility result shows that, except in degenerate cases, you cannot simultaneously satisfy calibration, demographic parity, and equalized odds — fairness is a deliberate trade-off, not a solved optimum.

**Q: (Senior) Your aligned model became sycophantic after preference training. Why, and how do you fix it?**
A: Preference data often rewards agreeable, confident answers because raters prefer them, teaching the model to tell users what they want to hear. Fix it by curating preferences that reward honest disagreement and calibrated uncertainty, penalizing flattery, and adding sycophancy probes to evaluation so regressions are caught.

**Q: (Senior) How would you audit a hiring model for bias end to end?**
A: Slice performance and outcome metrics by protected group (selection rate, TPR/FPR, calibration); trace disparities to data, labels, or thresholds; test counterfactual fairness by flipping the protected attribute; document the chosen fairness definition and its justification; add human review and monitor for regressions post-deployment.

**Q: (Senior) Is alignment a security control? Defend your answer.**
A: No. Alignment shapes default behavior but is not a hard boundary — aligned models remain jailbreakable and can be manipulated via prompt injection. Security requires defense-in-depth: runtime guardrails, least-privilege tool access, input/output filtering, and monitoring, layered on top of alignment rather than instead of it.

**Q: Why include a KL-regularized reference model at all, philosophically?**
A: The reference (SFT) model encodes fluent, coherent language; the reward model only encodes preference and is imperfect. Anchoring to the reference lets you improve on preference without discarding the linguistic competence the base model already has, and bounds the search to a trustworthy region.

**Q: What goes in a model card and why does it matter?**
A: Intended use and out-of-scope uses, training data provenance, evaluation results including fairness slices, known limitations, and safety considerations. It provides accountability and transparency for users and regulators, and is increasingly required by frameworks like the EU AI Act.

**Q: How does RLAIF let alignment scale?**
A: Human preference labeling is a bottleneck at frontier scale. RLAIF uses the model itself, guided by a constitution, to generate the chosen/rejected labels, producing far more feedback than humans can while keeping the guiding principles explicit and revisable.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Pretraining makes a model capable but amoral; alignment makes it behave. The classic recipe is SFT then preference optimization: RLHF trains a reward model (Bradley–Terry loss) and runs PPO with a KL penalty to avoid reward hacking, while DPO optimizes preferences directly with no reward model or RL loop. Constitutional AI/RLAIF replaces human labels with the model critiquing itself against a written constitution, which scales feedback. Responsible AI wraps this in fairness auditing (parity vs equalized odds — mutually incompatible, so choose deliberately), transparency (model cards), and governance (human-in-the-loop, NIST/EU frameworks). Alignment is not security; layer guardrails on top.

**Cheat sheet.**

| Concept | One-liner |
| --- | --- |
| RLHF | SFT → reward model → PPO + KL |
| DPO | Direct preference loss, no RL |
| Constitutional AI | Self-critique vs written principles (RLAIF) |
| KL penalty | Stops reward hacking |
| Demographic parity | Equal selection rates |
| Equalized odds | Equal TPR/FPR across groups |
| Model card | Use, limits, eval, fairness |

**Flash cards.**
- **HHH** → Helpful, honest, harmless — the alignment north star.
- **Reward hacking** → Policy exploits reward-model errors; KL penalty bounds it.
- **DPO** → Preference alignment with a single classification-style loss, no reward model.
- **Fairness impossibility** → Calibration, parity, and equalized odds can't all hold at once.
- **RLAIF** → AI feedback against a constitution replaces human preference labels.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the Bradley–Terry reward-model loss and verify it decreases as chosen scores rise above rejected.
- [ ] Implement the DPO loss and confirm it matches RLHF preference direction on toy data.
- [ ] Compute demographic parity and equalized-odds gaps on a public dataset (e.g., Adult/UCI) and try to close one without wrecking the other.
- [ ] Write a 5-principle "constitution" and use a model to critique-and-revise 10 borderline prompts; compare before/after.
- [ ] Draft a one-page model card for a small classifier you trained.

**Mini Project — Align a small assistant with DPO + a fairness audit.**
*Goal:* fine-tune a small open-weight model on preference data and prove it improved without introducing bias.
*Requirements:* (1) build/borrow a preference dataset of chosen/rejected pairs; (2) fine-tune with DPO (e.g., TRL's `DPOTrainer`); (3) evaluate helpfulness with an LLM judge and over-refusal on a benign set; (4) run a fairness audit on any demographic-tagged prompts; (5) write a model card summarizing use, limits, and results.
*Extensions:* add a constitutional self-critique pass and compare to plain DPO; run a sycophancy probe before/after; sweep `β` and plot reward-vs-KL to visualize the trade-off.

## 12. Related Topics & Free Learning Resources

Related chapters: **Fine-Tuning & PEFT**, **LLM Evaluation & Guardrails** (ch. 43), **AI Security & Red-Teaming** (ch. 45), **AI System Design** (ch. 46), **Prompt Engineering**, **Reinforcement Learning Foundations**.

**Free Learning Resources.**
- **Training language models to follow instructions (InstructGPT)** — Ouyang et al., arXiv 2203.02155 · *Advanced* · the paper that established the RLHF recipe. <https://arxiv.org/abs/2203.02155>
- **Constitutional AI: Harmlessness from AI Feedback** — Bai et al., arXiv 2212.08073 · *Advanced* · the CAI/RLAIF method in full. <https://arxiv.org/abs/2212.08073>
- **Direct Preference Optimization** — Rafailov et al., arXiv 2305.18290 · *Advanced* · the DPO derivation and results. <https://arxiv.org/abs/2305.18290>
- **Illustrating RLHF** — Hugging Face Blog · *Intermediate* · clear, diagram-driven walkthrough of the RLHF pipeline. <https://huggingface.co/blog/rlhf>
- **NIST AI Risk Management Framework** — NIST · *Intermediate* · the reference governance framework for responsible AI. <https://www.nist.gov/itl/ai-risk-management-framework>
- **Fairness and Machine Learning** — Barocas, Hardt, Narayanan · *Advanced* · the free textbook on fairness definitions and their trade-offs. <https://fairmlbook.org/>
- **TRL (Transformer Reinforcement Learning)** — Hugging Face · *Intermediate* · docs and code for SFT, reward modeling, PPO, and DPO. <https://huggingface.co/docs/trl>

---

*AI Engineering Handbook — chapter 44.*
