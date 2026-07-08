# 37 · Fine-Tuning, LoRA & QLoRA

> **In one line:** Fine-tuning adapts a pretrained model to your task by continuing training on your data — and LoRA/QLoRA make that affordable by updating a tiny fraction of the weights instead of all of them.

---

## 1. Overview

A pretrained large language model already knows grammar, world facts, and reasoning patterns from trillions of tokens. **Fine-tuning** takes that base and continues training it on a smaller, task-specific dataset so it internalizes your format, tone, domain vocabulary, or behavior. It is the difference between a model that *can* answer questions and one that answers them the way your product needs — as a JSON-emitting support agent, a SQL generator for your schema, or a medical-note summarizer that respects your house style.

The problem it solves is that prompting has limits. You can few-shot a model into a format, but prompts consume context, drift under load, and cannot teach genuinely new behavior or compress domain knowledge into the weights. Fine-tuning bakes the behavior in: shorter prompts, more reliable structure, and often a smaller model matching a larger one on your narrow task.

The catch is cost. **Full fine-tuning** updates every weight — for a 70B model that means holding the weights, gradients, and optimizer state (Adam keeps two extra tensors per parameter) in GPU memory, easily `>1 TB`. **Parameter-efficient fine-tuning (PEFT)** solves this. In 2021 Microsoft's **LoRA** (Low-Rank Adaptation) showed you can freeze the base model and train only small "adapter" matrices, cutting trainable parameters by `~10,000×` with near-identical quality. In 2023 **QLoRA** went further: quantize the frozen base to 4-bit, then train LoRA adapters on top — letting you fine-tune a 65B model on a *single* 48 GB GPU.

A concrete example: a startup wants a customer-support assistant fluent in their product's 400 SKUs and refund policy. Full fine-tuning of Llama-3-70B would need a multi-GPU cluster and days of engineering. With QLoRA they load the 4-bit base on one A100, train a `~100 MB` adapter on 20,000 curated support transcripts overnight, and ship. The adapter can be swapped, versioned, or A/B tested independently of the base.

## 2. Core Concepts

- **Pretraining vs fine-tuning** — pretraining learns general language from web-scale unlabeled text (self-supervised); fine-tuning specializes that model on a smaller labeled/curated dataset.
- **SFT (Supervised Fine-Tuning)** — training on `(prompt, ideal_response)` pairs so the model imitates desired outputs; the most common fine-tuning recipe.
- **Instruction tuning** — SFT on diverse `(instruction, response)` data so the model follows arbitrary natural-language instructions rather than just completing text.
- **PEFT (Parameter-Efficient Fine-Tuning)** — a family of methods that train a small number of new/selected parameters while freezing the base: LoRA, prefix-tuning, `(IA)³`, prompt-tuning.
- **LoRA (Low-Rank Adaptation)** — freezes base weights and learns two small matrices `A` and `B` whose product `BA` is added to a chosen weight matrix; only `A`, `B` are trained.
- **Rank `r`** — the inner dimension of the LoRA decomposition; controls adapter capacity. Typical `r` = `8–64`.
- **`alpha` (scaling)** — a constant that scales the adapter's contribution; effective update is `(alpha/r) · BA`.
- **QLoRA** — LoRA where the frozen base is stored in 4-bit **NF4** quantization, with paged optimizers and double quantization to fit huge models on one GPU.
- **Adapter merging** — folding `BA` back into `W` (`W' = W + BA`) so inference has zero added latency; the merged model is a normal checkpoint.
- **Catastrophic forgetting** — when fine-tuning overwrites general capabilities; PEFT mitigates it by leaving base weights frozen.

## 3. Theory & Mathematical Intuition

Full fine-tuning updates a weight matrix `W ∈ R^{d×k}` by a full-rank delta `ΔW` of the same shape. LoRA's insight is that the *update* `ΔW` needed to adapt a model to a downstream task has **low intrinsic rank** — it lives in a much smaller subspace than its dimensions suggest. So instead of learning the full `d×k` matrix, LoRA factors the update:

```
ΔW = B · A     where  B ∈ R^{d×r},  A ∈ R^{r×k},  r ≪ min(d, k)
```

The adapted forward pass becomes:

```
h = W·x + ΔW·x = W·x + (alpha/r) · B·(A·x)
```

`W` stays frozen; only `A` and `B` are trainable. Parameter count drops from `d·k` to `r·(d+k)`. For `d=k=4096` and `r=8`: full = `16.7M` params, LoRA = `65.5K` — a `256×` reduction *per matrix*. `A` is initialized from a random Gaussian and `B` initialized to zero, so at step 0 `ΔW = 0` and training starts exactly at the pretrained model.

The `alpha/r` scaling decouples learning-rate behavior from rank: raising `r` for more capacity doesn't force you to re-tune the learning rate. A common heuristic is `alpha = 2r`.

**QLoRA** adds quantization of the frozen base. Weights are stored in **4-bit NormalFloat (NF4)**, an information-theoretically optimal encoding for the roughly-normal distribution of neural-net weights. During the forward/backward pass each 4-bit block is dequantized on the fly to bf16 for the matmul, then discarded — so memory holds 4-bit weights but compute stays high-precision. **Double quantization** further quantizes the quantization constants themselves, saving `~0.4 bits/param`. Crucially, gradients flow only into the bf16 LoRA adapters, never into the frozen 4-bit base.

The diagram below shows the LoRA reparameterization — the frozen path plus the trainable low-rank bypass.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="14">LoRA reparameterization:  h = W·x + (alpha/r)·B·A·x</text>

  <rect x="40" y="130" width="90" height="44" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="85" y="157" text-anchor="middle" fill="#1e293b">input x</text>

  <rect x="250" y="60" width="150" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="325" y="82" text-anchor="middle" fill="#1e293b">Frozen W</text>
  <text x="325" y="99" text-anchor="middle" fill="#64748b" font-size="11">d × k  (pretrained)</text>

  <rect x="230" y="180" width="80" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="270" y="205" text-anchor="middle" fill="#1e293b">A (r×k)</text>
  <rect x="340" y="180" width="80" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="205" text-anchor="middle" fill="#1e293b">B (d×r)</text>
  <text x="325" y="245" text-anchor="middle" fill="#16a34a" font-size="11">trainable adapters (rank r)</text>

  <rect x="560" y="130" width="110" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="615" y="152" text-anchor="middle" fill="#1e293b">output h</text>
  <text x="615" y="167" text-anchor="middle" fill="#64748b" font-size="11">sum (+)</text>

  <line x1="130" y1="145" x2="248" y2="90" stroke="#4f46e5" stroke-width="1.6" marker-end="url(#a1)"/>
  <line x1="130" y1="152" x2="228" y2="198" stroke="#16a34a" stroke-width="1.6" marker-end="url(#a1)"/>
  <line x1="310" y1="200" x2="338" y2="200" stroke="#16a34a" stroke-width="1.6" marker-end="url(#a1)"/>
  <line x1="400" y1="85" x2="558" y2="145" stroke="#4f46e5" stroke-width="1.6" marker-end="url(#a1)"/>
  <line x1="420" y1="198" x2="558" y2="158" stroke="#16a34a" stroke-width="1.6" marker-end="url(#a1)"/>
</svg>
```

## 4. Architecture & Workflow

A LoRA/QLoRA fine-tuning run proceeds through these stages:

1. **Curate the dataset.** Assemble high-quality `(prompt, response)` pairs in a chat template (system/user/assistant). Quality and diversity beat volume — `1,000` clean examples often beat `100,000` noisy ones. Deduplicate and hold out a validation split.
2. **Load the base model.** For LoRA, load in bf16. For QLoRA, load with a 4-bit `BitsAndBytesConfig` (NF4 + double quantization) so the frozen weights occupy `~1/4` the memory.
3. **Inject adapters.** Wrap the model with PEFT, specifying `target_modules` (usually the attention `q_proj`, `k_proj`, `v_proj`, `o_proj` and often the MLP projections), rank `r`, `alpha`, and dropout.
4. **Configure training.** Pick a small learning rate (`1e-4` to `2e-4` for LoRA — higher than full fine-tuning), a cosine schedule with warmup, gradient checkpointing, and a paged AdamW optimizer for QLoRA.
5. **Train.** Run SFT for `1–3` epochs, masking the loss so it only counts assistant tokens (not the prompt). Monitor validation loss to catch overfitting early.
6. **Evaluate.** Score on a held-out set plus task-specific metrics (exact-match, ROUGE, a rubric graded by an LLM judge). Compare against the base model and the prompt-only baseline.
7. **Merge or serve as adapter.** Either merge `BA` into `W` for a standalone checkpoint (zero inference overhead) or keep the adapter separate to hot-swap multiple task adapters over one base at serving time.
8. **Version & deploy.** Store the adapter with its base-model hash, training data snapshot, and hyperparameters for reproducibility.

The diagram contrasts full fine-tuning against the QLoRA pipeline and memory footprint.

```svg
<svg viewBox="0 0 740 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="185" y="24" text-anchor="middle" fill="#1e293b" font-size="14">Full fine-tuning</text>
  <rect x="40" y="40" width="290" height="120" rx="10" fill="#fef3c7" stroke="#d97706" stroke-dasharray="4 3"/>
  <rect x="60" y="60" width="110" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="115" y="82" text-anchor="middle" fill="#1e293b" font-size="11">All weights (bf16)</text>
  <rect x="60" y="102" width="110" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="115" y="124" text-anchor="middle" fill="#1e293b" font-size="11">Gradients</text>
  <rect x="185" y="60" width="130" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="250" y="82" text-anchor="middle" fill="#1e293b" font-size="11">Adam state ×2</text>
  <text x="185" y="150" text-anchor="middle" fill="#b45309" font-size="11">70B ≈ &gt;1 TB GPU RAM</text>

  <text x="555" y="24" text-anchor="middle" fill="#1e293b" font-size="14">QLoRA</text>
  <rect x="410" y="40" width="300" height="180" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-dasharray="4 3"/>
  <rect x="430" y="58" width="150" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="505" y="76" text-anchor="middle" fill="#1e293b" font-size="11">Base weights: 4-bit NF4</text>
  <text x="505" y="91" text-anchor="middle" fill="#64748b" font-size="10">frozen · dequant on the fly</text>
  <rect x="430" y="108" width="150" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="505" y="126" text-anchor="middle" fill="#1e293b" font-size="11">LoRA adapters (bf16)</text>
  <text x="505" y="141" text-anchor="middle" fill="#64748b" font-size="10">trainable · ~0.5% params</text>
  <rect x="430" y="158" width="150" height="36" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="505" y="180" text-anchor="middle" fill="#1e293b" font-size="11">Paged AdamW (adapters)</text>
  <text x="560" y="212" text-anchor="middle" fill="#4338ca" font-size="11">65B fits on one 48 GB GPU</text>

  <line x1="330" y1="100" x2="408" y2="100" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="369" y="92" text-anchor="middle" fill="#64748b" font-size="10">shrink</text>

  <rect x="250" y="250" width="240" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="370" y="274" text-anchor="middle" fill="#1e293b" font-size="12">Adapter (~100 MB)</text>
  <text x="370" y="293" text-anchor="middle" fill="#64748b" font-size="11">merge into W  or  hot-swap at serve time</text>
  <line x1="505" y1="220" x2="430" y2="250" stroke="#475569" stroke-width="1.5" marker-end="url(#a2)"/>
</svg>
```

## 5. Implementation

A complete QLoRA SFT run with Hugging Face `transformers`, `peft`, `bitsandbytes`, and `trl`.

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer, SFTConfig
from datasets import load_dataset

model_id = "meta-llama/Meta-Llama-3-8B-Instruct"

# 1. 4-bit NF4 quantization config (the "Q" in QLoRA)
bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
    bnb_4bit_compute_dtype=torch.bfloat16,   # dequant target for matmuls
)

tok = AutoTokenizer.from_pretrained(model_id)
tok.pad_token = tok.eos_token
model = AutoModelForCausalLM.from_pretrained(
    model_id, quantization_config=bnb, device_map="auto"
)
model = prepare_model_for_kbit_training(model)   # enable grad checkpointing, cast norms

# 2. LoRA adapters on attention + MLP projections
lora = LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    task_type="CAUSAL_LM",
)
model = get_peft_model(model, lora)
model.print_trainable_parameters()
# trainable params: 41,943,040 || all params: 8,072,204,288 || trainable%: 0.5196
```

Now train on a chat dataset. `trl`'s `SFTTrainer` handles templating and loss masking.

```python
ds = load_dataset("HuggingFaceH4/ultrachat_200k", split="train_sft[:5000]")

cfg = SFTConfig(
    output_dir="llama3-support-lora",
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,      # effective batch = 16
    learning_rate=2e-4,                 # LoRA tolerates higher LR than full FT
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    num_train_epochs=2,
    bf16=True,
    gradient_checkpointing=True,
    optim="paged_adamw_8bit",           # paged optimizer avoids OOM spikes
    logging_steps=10,
    max_seq_length=2048,
)
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok)
trainer.train()
trainer.model.save_pretrained("llama3-support-lora")   # saves ONLY the adapter (~160 MB)
```

Load the adapter for inference, then optionally merge for zero-overhead serving.

```python
from peft import PeftModel

base = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.bfloat16, device_map="auto")
model = PeftModel.from_pretrained(base, "llama3-support-lora")

# Option A: keep adapter separate -> can hot-swap multiple task adapters
# Option B: fold BA into W for a standalone checkpoint, no runtime add
merged = model.merge_and_unload()
merged.save_pretrained("llama3-support-merged")   # normal checkpoint, deploy to vLLM/TGI
```

**Optimization note:** For QLoRA, `paged_adamw_8bit` + `gradient_checkpointing` are the two biggest memory savers; the paged optimizer spills optimizer state to CPU during memory spikes to avoid OOM. Set `bnb_4bit_compute_dtype=torch.bfloat16` (not fp16) for training stability, and target *all* linear layers (attention + MLP) — the original QLoRA paper found this matters more than a high rank. If throughput is the goal, keep `max_seq_length` tight and pack multiple short samples per sequence.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| **Memory (QLoRA)** | Fine-tune 65B on one 48 GB GPU | 4-bit base adds dequant overhead; slightly slower steps |
| **Trainable params** | `~0.1–1%` of the model; tiny checkpoints | Rank too low can underfit hard tasks |
| **Storage / portability** | Adapters are `~10–200 MB`; ship many per base | Must pin the exact base-model version |
| **Forgetting** | Frozen base preserves general skills | Can't deeply rewrite pretrained behavior |
| **Serving** | Hot-swap adapters, or merge for zero latency | Unmerged adapters add a small runtime matmul |
| **Full fine-tuning** | Maximum capacity; can shift core behavior | Huge compute, high forgetting risk, big checkpoints |
| **Cost** | Overnight on one GPU vs a cluster for days | QLoRA quality can trail full FT by a small margin |

## 7. Common Mistakes & Best Practices

1. ⚠️ Training on messy, inconsistent data → ✅ Curate ruthlessly; a few thousand clean, on-format examples beat a noisy pile. Deduplicate and hold out a validation set.
2. ⚠️ Computing loss over the whole sequence including the prompt → ✅ Mask the loss so only assistant/completion tokens contribute; otherwise the model learns to parrot prompts.
3. ⚠️ Copying a full-fine-tuning learning rate (`~1e-5`) into LoRA → ✅ Use `1e-4`–`2e-4`; LoRA adapters need a higher LR to move.
4. ⚠️ Setting rank absurdly high "to be safe" → ✅ Start `r=8–16`; raise only if validation loss plateaus high. Bigger `r` costs memory and overfits small data.
5. ⚠️ Only adapting `q_proj`/`v_proj` → ✅ Target all linear layers (attention + MLP) for QLoRA; it consistently improves quality per the paper.
6. ⚠️ Training too many epochs → ✅ `1–3` epochs; watch validation loss and stop when it turns up. LLMs overfit small SFT sets fast.
7. ⚠️ Mismatched chat template between training and inference → ✅ Apply the model's exact `chat_template`; a wrong special-token format silently tanks quality.
8. ⚠️ Using fp16 compute dtype for QLoRA → ✅ Use bf16 compute dtype; fp16 causes overflow/instability with 4-bit bases.
9. ⚠️ Evaluating only on training-style prompts → ✅ Test out-of-distribution and adversarial inputs; check you didn't cause catastrophic forgetting of general skills.
10. ⚠️ Losing track of which base a checkpoint adapts → ✅ Version the adapter with the base-model hash, data snapshot, and hyperparameters.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** If loss won't drop, first verify loss masking and the chat template — a mis-templated dataset is the most common cause. NaN loss under QLoRA usually means fp16 compute dtype or an LR that's too high. If quality regresses on general tasks, you overfit or over-rewrote; lower epochs/LR or reduce rank. Always sanity-check by overfitting a tiny batch to near-zero loss before a full run.

**Monitoring.** Track train and validation loss (divergence = overfitting), gradient norm (spikes = instability), and task metrics on a fixed eval set every N steps. In production, log the adapter version alongside each response and monitor quality drift versus the base model.

**Security.** Fine-tuning can *undo* safety alignment — even benign data can degrade guardrails, so re-run safety evals after training. Treat training data as an injection vector: poisoned examples can implant backdoors triggered by specific phrases. Sanitize and access-control the dataset; never fine-tune on unvetted user-submitted content without review.

**Performance & Scaling.** For serving many customers, keep adapters unmerged and hot-swap them per request over one shared 4-bit base (engines like vLLM support multi-LoRA), giving hundreds of tenant-specific models at near one-model cost. For a single high-traffic model, merge the adapter to eliminate the runtime matmul. Scale training with FSDP + QLoRA when one GPU isn't enough, and use sequence packing to raise token throughput.

## 9. Interview Questions

**Q: What problem does LoRA solve, and how does it work?**
A: Full fine-tuning updates every weight plus gradients and optimizer state — infeasible memory for large models. LoRA freezes the base and learns a low-rank update `ΔW = BA` added to chosen weight matrices, training only `A` and `B`. This cuts trainable parameters by orders of magnitude while matching full-fine-tuning quality on most tasks.

**Q: What is the difference between LoRA and QLoRA?**
A: LoRA freezes a full-precision base and trains low-rank adapters. QLoRA additionally stores the frozen base in 4-bit NF4 quantization (with double quantization and paged optimizers), slashing memory so you can fine-tune very large models on a single GPU. Gradients still flow only into the bf16 adapters.

**Q: What do the LoRA hyperparameters `r` and `alpha` control?**
A: `r` is the rank — the adapter's capacity and the inner dimension of `BA`; higher `r` means more parameters and expressiveness but more overfitting risk. `alpha` scales the adapter's contribution via `(alpha/r)·BA`, decoupling capacity from effective learning rate. A common default is `alpha = 2r`.

**Q: Why is `B` initialized to zero?**
A: With `B = 0`, the initial update `ΔW = BA = 0`, so training begins exactly at the pretrained model with no random perturbation of behavior. `A` is random Gaussian so gradients can start flowing; the model then smoothly departs from the base rather than jumping.

**Q: How does fine-tuning differ from prompting/RAG, and when do you choose it?**
A: Prompting and RAG inject knowledge at inference without changing weights — great for fresh, dynamic facts. Fine-tuning changes weights to teach format, tone, or behavior that's expensive to specify in a prompt. Choose fine-tuning for consistent structure/style and latency (shorter prompts); choose RAG for knowledge that changes often.

**Q: What is catastrophic forgetting and how does PEFT mitigate it?**
A: Catastrophic forgetting is when adapting to a new task overwrites previously learned capabilities. PEFT mitigates it by freezing the base weights and only learning small adapters, so general skills are preserved. Full fine-tuning is far more prone to it, especially with high learning rates or many epochs.

**Q: What is NF4 and why use it over regular int4?**
A: NF4 (4-bit NormalFloat) is a quantization data type whose levels are chosen to be information-theoretically optimal for normally-distributed data, which matches the distribution of neural-net weights. Compared to uniform int4 it places more resolution where the weights actually concentrate, preserving accuracy better at the same bit width.

**Q: (Senior) Walk through the memory breakdown that makes QLoRA fit a 65B model on 48 GB.**
A: The 65B base at 4-bit is `~33 GB` (vs `~130 GB` at bf16). Adapters are `~0.1–0.5%` of params in bf16 — a few hundred MB. Optimizer state exists only for the adapters (not the base), so Adam's `2×` overhead is tiny. Double quantization trims the quant constants, and the paged optimizer spills state to CPU during spikes. Together that leaves room for activations under gradient checkpointing.

**Q: (Senior) You fine-tuned and general benchmarks dropped while your task metric rose. Diagnose and fix.**
A: That's catastrophic forgetting / over-specialization. Likely causes: too many epochs, too-high LR, or rank so high the adapter dominates. Fixes: reduce epochs and LR, lower rank, mix in a slice of general instruction data to regularize, or blend the adapter weight down. Re-run a general eval suite and safety evals, since alignment can also degrade.

**Q: (Senior) How do you serve 200 per-customer fine-tunes cost-effectively?**
A: Train one LoRA adapter per customer over a shared base and keep them unmerged. At serving time use a multi-LoRA-capable engine (e.g. vLLM) that loads one 4-bit base and swaps the relevant adapter per request, batching across tenants. This gives 200 distinct models at roughly single-model GPU cost; only hot, latency-critical adapters get merged into dedicated deployments.

**Q: (Senior) When would you still prefer full fine-tuning over LoRA/QLoRA?**
A: When you must deeply change core model behavior (new modality, major domain shift, teaching genuinely new skills), when you have abundant compute and data, or when the last few points of quality matter and evaluations show LoRA plateauing below full FT. Full FT also avoids adapter-management complexity for a single flagship model.

**Q: Why must training and inference use the same chat template?**
A: The model learns to associate specific special tokens and role delimiters with turn boundaries and expected behavior. If inference formats prompts differently, the model sees out-of-distribution structure and its learned behavior degrades silently — often producing rambling or role-confused output despite a "successful" training run.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Fine-tuning continues training a pretrained model on task data to bake in format, tone, and domain behavior. Full fine-tuning updates all weights and needs enormous memory. LoRA freezes the base and learns a low-rank update `ΔW = (alpha/r)·BA`, training `<1%` of parameters. QLoRA adds 4-bit NF4 quantization of the frozen base plus paged optimizers, letting you fine-tune 65B models on one GPU. Use `r=8–32`, LR `1e-4`–`2e-4`, `1–3` epochs, mask the loss to completion tokens, target all linear layers, and match the chat template. Merge adapters for zero-latency serving or hot-swap them for multi-tenant deployments.

| Knob | Typical value | Effect |
|---|---|---|
| rank `r` | 8–32 | Adapter capacity |
| `alpha` | `2r` | Update scaling |
| learning rate | 1e-4 – 2e-4 | Higher than full FT |
| epochs | 1–3 | More → overfitting |
| target_modules | all linear | Quality per QLoRA paper |
| quant | NF4 + double-quant | 4-bit base memory |
| optimizer | paged_adamw_8bit | OOM-safe |

**Flash cards**
- **LoRA update formula** → `h = W·x + (alpha/r)·B·A·x`, only `A`,`B` trained.
- **Why `B=0` at init** → adapter starts at zero, training begins exactly at the base model.
- **QLoRA's three tricks** → NF4 4-bit base, double quantization, paged optimizers.
- **LoRA learning rate** → `1e-4`–`2e-4`, higher than full fine-tuning's `~1e-5`.
- **Merge vs hot-swap** → merge for zero-latency single model; keep separate for multi-tenant swapping.

## 11. Hands-On Exercises & Mini Project

- [ ] Fine-tune Llama-3-8B with QLoRA on a 2,000-example instruction set and compare validation loss at `r=8`, `16`, `64`.
- [ ] Ablate `target_modules`: attention-only vs attention+MLP, and measure the quality delta on a held-out set.
- [ ] Verify loss masking by printing which token positions contribute to loss for one sample.
- [ ] Merge an adapter and benchmark inference latency merged vs unmerged.
- [ ] Run a general benchmark (e.g. a slice of MMLU) before and after to quantify forgetting.

**Mini Project: A Domain Support Assistant.**
Goal: turn a base 8B model into a support agent for a fictional SaaS product that answers in a fixed JSON schema (`{"intent","answer","escalate"}`).
Requirements: (1) build 1,500 curated `(question, json_answer)` pairs; (2) QLoRA fine-tune with proper chat templating and loss masking; (3) evaluate JSON-validity rate, intent accuracy, and an LLM-judge helpfulness score against a prompt-only baseline; (4) run a safety eval to confirm guardrails survived.
Extensions: add a second adapter for a different product and hot-swap them at serve time; try DPO on preference pairs to improve tone after SFT; quantify the cost difference vs full fine-tuning.

## 12. Related Topics & Free Learning Resources

Related chapters: **Quantization & Inference Optimization** (the 4-bit machinery behind QLoRA), **Serving LLMs: vLLM, Batching & Throughput** (multi-LoRA serving and merged checkpoints), **GPU Computing & Distributed Training** (scaling training with FSDP), and **MLOps: Pipelines, CI/CD & Registries** (versioning adapters and data).

**Free Learning Resources**
- **LoRA: Low-Rank Adaptation of Large Language Models** — Hu et al. (Microsoft) · *Advanced* · the original paper; read Sections 4–5 for the reparameterization and rank analysis. <https://arxiv.org/abs/2106.09685>
- **QLoRA: Efficient Finetuning of Quantized LLMs** — Dettmers et al. · *Advanced* · NF4, double quantization, and paged optimizers explained. <https://arxiv.org/abs/2305.14314>
- **Hugging Face PEFT documentation** — Hugging Face · *Intermediate* · practical `LoraConfig`, target modules, merging, and multi-adapter recipes. <https://huggingface.co/docs/peft>
- **TRL: Transformer Reinforcement Learning docs** — Hugging Face · *Intermediate* · `SFTTrainer` usage, chat templating, and packing. <https://huggingface.co/docs/trl>
- **Fine-tuning LLMs course** — DeepLearning.AI (with Lamini) · *Beginner* · short, hands-on intro to when and how to fine-tune. <https://www.deeplearning.ai/short-courses/finetuning-large-language-models/>
- **bitsandbytes documentation** — Hugging Face · *Intermediate* · 4-bit/8-bit quantization config and paged optimizers. <https://huggingface.co/docs/bitsandbytes>
- **Efficient fine-tuning guide** — Hugging Face blog ("Making LLMs even more accessible with bitsandbytes, 4-bit, and QLoRA") · *Intermediate* · end-to-end walkthrough. <https://huggingface.co/blog/4bit-transformers-bitsandbytes>

---

*AI Engineering Handbook — chapter 37.*
