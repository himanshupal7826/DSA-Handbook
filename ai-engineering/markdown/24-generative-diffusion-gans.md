# 24 · Generative AI: Diffusion Models & GANs

> **In one line:** Both GANs and diffusion models learn to turn noise into realistic images — GANs do it in one shot through an adversarial game, while diffusion models do it gradually by learning to reverse a step-by-step noising process.

---

## 1. Overview

Generative image models answer a deceptively hard question: given a training set of real images, can we sample *new* images from the same distribution — faces that never existed, product photos from a text prompt, art in any style? Two families dominate. **Generative Adversarial Networks (GANs)**, introduced by Goodfellow et al. in 2014, pit two networks against each other: a **generator** that fabricates images and a **discriminator** that tries to tell fakes from reals. Training is a minimax game; at equilibrium the generator produces samples the discriminator can't distinguish from real. **Diffusion models** (DDPM, 2020) take a completely different route: they define a fixed process that gradually adds Gaussian noise to an image until it's pure static, then train a network to *reverse* that process one small step at a time. Sampling starts from noise and denoises into an image.

The problem both solve is **sampling from a complex high-dimensional distribution** you can only observe through examples. You can't write down the probability density of "photorealistic images," but you can learn to generate from it. GANs solve it implicitly (no explicit likelihood, just a sample generator); diffusion solves it by learning the score/noise at every corruption level.

The historical arc matters: GANs ruled 2014–2020, producing StyleGAN's uncanny faces, but they were notoriously unstable and prone to mode collapse. Diffusion models overtook them around 2021–2022 because they train stably and cover the data distribution better, powering Stable Diffusion, DALL·E 2/3, Midjourney, and Imagen. The key practical unlock was **latent diffusion** (Stable Diffusion): run the expensive diffusion process in a compressed latent space instead of raw pixels, making high-res text-to-image cheap enough to run on a consumer GPU.

A concrete real-world example: you type "an astronaut riding a horse, photorealistic" into Stable Diffusion. A text encoder turns the prompt into embeddings; a U-Net repeatedly denoises a random latent while cross-attending to those embeddings; a decoder turns the final latent into a 512×512 image. Every modern text-to-image and text-to-video system is built on these ideas.

## 2. Core Concepts

- **Generator (G)** — a network mapping a random latent vector `z` (and optionally a condition) to a synthetic sample.
- **Discriminator (D)** — a classifier trained to distinguish real samples from the generator's fakes; provides the training signal in a GAN.
- **Adversarial / minimax game** — G and D optimize opposing objectives; G improves by fooling an improving D.
- **Mode collapse** — a GAN failure where G produces only a few distinct outputs, ignoring much of the data distribution.
- **Forward (diffusion) process** — a fixed Markov chain that adds Gaussian noise over `T` steps until the image is pure noise.
- **Reverse (denoising) process** — the learned chain that removes noise step by step to generate a sample from noise.
- **Noise prediction (ε-prediction)** — the diffusion network's job: given a noisy image and timestep, predict the noise that was added.
- **U-Net** — the encoder–decoder-with-skip-connections backbone that does the per-step denoising.
- **Latent diffusion** — running diffusion in a VAE-compressed latent space for efficiency (Stable Diffusion).
- **Classifier-free guidance (CFG)** — a sampling trick that strengthens adherence to the text prompt by extrapolating between conditional and unconditional predictions.

## 3. Theory & Mathematical Intuition

**GANs as a minimax game.** The generator `G` and discriminator `D` play:

```
min_G max_D  E_{x~data}[log D(x)] + E_{z~noise}[log(1 − D(G(z)))]
```

`D` wants to output 1 on real `x` and 0 on fakes `G(z)`; `G` wants `D(G(z))` near 1. At the theoretical optimum, `G`'s distribution equals the data distribution and `D` outputs 0.5 everywhere (it can only guess). In practice the original `log(1−D(G(z)))` term saturates when `G` is bad, so implementations use the **non-saturating** loss (`G` maximizes `log D(G(z))`) for healthier gradients. Instability comes from the two-player dynamics: if `D` gets too strong, `G`'s gradient vanishes; if too weak, `G` gets no useful signal. **Wasserstein GAN** replaces the JS-divergence objective with the Earth-Mover distance plus a gradient penalty, giving smoother gradients and fewer collapses.

**Diffusion as learned denoising.** The forward process adds noise on a schedule `β_1..β_T`. A beautiful property lets you jump to any timestep in closed form:

```
x_t = √(ᾱ_t) · x_0 + √(1 − ᾱ_t) · ε ,   ε ~ N(0, I),   ᾱ_t = Π_{s≤t}(1 − β_s)
```

So a noisy image at any level is just a scaled original plus scaled noise. The model `ε_θ(x_t, t)` is trained to predict that noise, with a stunningly simple loss:

```
L = E_{x_0, t, ε} ‖ ε − ε_θ(x_t, t) ‖²        # just MSE on the noise
```

This is where diffusion's stability comes from — it's a plain regression problem, not an adversarial game. Sampling reverses the chain: start from `x_T ~ N(0, I)` and iteratively estimate and remove noise:

```
x_{t-1} = (1/√α_t)·( x_t − (β_t/√(1−ᾱ_t))·ε_θ(x_t, t) ) + σ_t·z
```

Predicting noise `ε` is equivalent (up to scaling) to estimating the **score** `∇_x log p(x_t)` — the direction toward higher data density — which connects DDPMs to score-based generative models.

**Classifier-free guidance** sharpens conditioning: run the model with and without the text condition and extrapolate, `ε̂ = ε_uncond + w·(ε_cond − ε_uncond)`, where `w` (~7.5) trades diversity for prompt fidelity.

The diagram contrasts the two generative paradigms.

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="280" fill="#eef2ff"/>
  <text x="20" y="24" font-size="15" fill="#1e293b" font-weight="bold">GAN vs Diffusion</text>
  <text x="30" y="52" font-size="12" fill="#4f46e5" font-weight="bold">GAN: one-shot adversarial</text>
  <rect x="30" y="65" width="70" height="36" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.4"/><text x="52" y="88" font-size="11" fill="#1e293b">noise z</text>
  <rect x="140" y="65" width="80" height="36" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="158" y="88" font-size="11" fill="#1e293b">Generator</text>
  <rect x="260" y="65" width="80" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/><text x="285" y="88" font-size="11" fill="#1e293b">image</text>
  <rect x="380" y="65" width="90" height="36" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/><text x="392" y="88" font-size="11" fill="#1e293b">Discriminator</text>
  <text x="490" y="88" font-size="11" fill="#1e293b">real / fake?</text>
  <g stroke="#4f46e5" stroke-width="1.8" fill="none">
    <line x1="100" y1="83" x2="140" y2="83" marker-end="url(#a24)"/>
    <line x1="220" y1="83" x2="260" y2="83" marker-end="url(#a24)"/>
    <line x1="340" y1="83" x2="380" y2="83" marker-end="url(#a24)"/>
  </g>
  <text x="30" y="150" font-size="12" fill="#4f46e5" font-weight="bold">Diffusion: iterative denoising</text>
  <g font-size="10" fill="#1e293b">
    <rect x="30" y="165" width="60" height="40" rx="6" fill="#1e293b" stroke="#4f46e5"/><text x="42" y="189" fill="#eef2ff">noise</text>
    <rect x="140" y="165" width="60" height="40" rx="6" fill="#94a3b8" stroke="#4f46e5"/><text x="150" y="189" fill="#1e293b">x_t</text>
    <rect x="250" y="165" width="60" height="40" rx="6" fill="#cbd5e1" stroke="#4f46e5"/><text x="262" y="189" fill="#1e293b">x_2</text>
    <rect x="360" y="165" width="60" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/><text x="372" y="189" fill="#1e293b">x_1</text>
    <rect x="470" y="165" width="60" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a"/><text x="480" y="189" fill="#1e293b">image</text>
  </g>
  <g stroke="#d97706" stroke-width="1.8" fill="none">
    <line x1="90" y1="185" x2="140" y2="185" marker-end="url(#b24)"/>
    <line x1="200" y1="185" x2="250" y2="185" marker-end="url(#b24)"/>
    <line x1="310" y1="185" x2="360" y2="185" marker-end="url(#b24)"/>
    <line x1="420" y1="185" x2="470" y2="185" marker-end="url(#b24)"/>
  </g>
  <text x="150" y="235" font-size="11" fill="#1e293b">Each step: predict noise with a U-Net and subtract it.</text>
  <defs>
    <marker id="a24" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
    <marker id="b24" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 4. Architecture & Workflow

How latent text-to-image (Stable Diffusion) generates from a prompt:

1. **Encode the prompt** — a frozen text encoder (CLIP/T5) turns the prompt into a sequence of embeddings that will condition generation.
2. **Sample a latent** — draw a random latent tensor `z_T ~ N(0, I)` in the VAE's compressed space (e.g. 64×64×4 for a 512×512 image), far cheaper than pixel space.
3. **Denoise loop** — for `t = T … 1`, the U-Net takes `(z_t, t, text_embeddings)`, predicts the noise via **cross-attention** to the prompt, and the scheduler computes `z_{t-1}`. Apply classifier-free guidance each step.
4. **Guidance** — combine conditional and unconditional noise predictions with a guidance scale to control prompt adherence.
5. **Scheduler** — a sampler (DDIM, DPM-Solver, Euler) decides step sizes; modern samplers finish in 20–50 steps instead of 1000.
6. **Decode** — the VAE decoder maps the final clean latent `z_0` back to a full-resolution RGB image.
7. **Post-process / safety** — optional upscaling, and a safety checker to filter disallowed content.

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="640" height="250" fill="#e0f2fe"/>
  <text x="20" y="24" font-size="15" fill="#1e293b" font-weight="bold">Latent text-to-image pipeline</text>
  <rect x="20" y="60" width="110" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="30" y="80" font-size="10.5" fill="#1e293b">prompt text</text><text x="30" y="96" font-size="10.5" fill="#1e293b">encoder (CLIP)</text>
  <rect x="20" y="150" width="110" height="44" rx="6" fill="#1e293b" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="176" font-size="10.5" fill="#eef2ff">random latent</text>
  <rect x="180" y="100" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.6"/>
  <text x="205" y="126" font-size="11" fill="#1e293b">U-Net denoiser</text>
  <text x="196" y="144" font-size="10" fill="#1e293b">x N steps (cross-attn)</text>
  <rect x="390" y="105" width="110" height="50" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="402" y="126" font-size="10.5" fill="#1e293b">clean latent z0</text><text x="410" y="144" font-size="10.5" fill="#1e293b">scheduler</text>
  <rect x="540" y="105" width="90" height="50" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="552" y="126" font-size="10.5" fill="#1e293b">VAE decode</text><text x="560" y="144" font-size="10.5" fill="#1e293b">→ image</text>
  <g stroke="#0ea5e9" stroke-width="1.8" fill="none">
    <line x1="130" y1="82" x2="255" y2="100" marker-end="url(#c24)"/>
    <line x1="130" y1="172" x2="255" y2="160" marker-end="url(#c24)"/>
    <line x1="330" y1="130" x2="390" y2="130" marker-end="url(#c24)"/>
    <line x1="500" y1="130" x2="540" y2="130" marker-end="url(#c24)"/>
  </g>
  <path d="M255 160 C 230 200, 300 200, 300 160" fill="none" stroke="#d97706" stroke-width="1.5" marker-end="url(#d24)"/>
  <text x="215" y="215" font-size="10.5" fill="#d97706">loop: subtract predicted noise</text>
  <defs>
    <marker id="c24" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker>
    <marker id="d24" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 5. Implementation

A minimal GAN training step in PyTorch (the adversarial loop):

```python
import torch, torch.nn as nn

G = nn.Sequential(nn.Linear(64, 256), nn.ReLU(), nn.Linear(256, 784), nn.Tanh())
D = nn.Sequential(nn.Linear(784, 256), nn.LeakyReLU(0.2), nn.Linear(256, 1))
bce = nn.BCEWithLogitsLoss()
opt_g = torch.optim.Adam(G.parameters(), lr=2e-4, betas=(0.5, 0.999))
opt_d = torch.optim.Adam(D.parameters(), lr=2e-4, betas=(0.5, 0.999))

def train_step(real):                                  # real: (B, 784) in [-1,1]
    B = real.size(0)
    z = torch.randn(B, 64)
    fake = G(z)
    # --- train discriminator: reals -> 1, fakes -> 0 ---
    opt_d.zero_grad()
    d_loss = bce(D(real), torch.ones(B, 1)) + bce(D(fake.detach()), torch.zeros(B, 1))
    d_loss.backward(); opt_d.step()
    # --- train generator: fool D (non-saturating) ---
    opt_g.zero_grad()
    g_loss = bce(D(fake), torch.ones(B, 1))            # wants D(fake)=1
    g_loss.backward(); opt_g.step()
    return d_loss.item(), g_loss.item()
```

The core of diffusion training — noise a batch and regress the noise:

```python
import torch

T = 1000
betas = torch.linspace(1e-4, 0.02, T)          # linear noise schedule
alphas = 1.0 - betas
abar = torch.cumprod(alphas, dim=0)            # ᾱ_t

def diffusion_loss(model, x0):                  # x0: (B, C, H, W)
    B = x0.size(0)
    t = torch.randint(0, T, (B,), device=x0.device)
    eps = torch.randn_like(x0)
    a = abar[t].view(B, 1, 1, 1)
    x_t = a.sqrt() * x0 + (1 - a).sqrt() * eps  # closed-form forward noising
    eps_pred = model(x_t, t)                    # U-Net predicts the noise
    return torch.nn.functional.mse_loss(eps_pred, eps)   # just MSE!
```

Generating an image with the diffusers library (how you'd actually ship it):

```python
from diffusers import StableDiffusionPipeline
import torch

pipe = StableDiffusionPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5", torch_dtype=torch.float16).to("cuda")
image = pipe(
    prompt="an astronaut riding a horse, photorealistic, 50mm",
    num_inference_steps=30,          # DPM-Solver: quality at few steps
    guidance_scale=7.5,              # classifier-free guidance strength
).images[0]
image.save("astronaut.png")
```

> **Optimization:** Naive DDPM needs 1000 sampling steps; use a fast solver (DPM-Solver++, DDIM) to get comparable quality in 20–50 steps — a ~20–50× speedup. Run in fp16/bf16, enable attention slicing / xFormers memory-efficient attention for lower VRAM, and use **latent** diffusion so the U-Net operates on a 64×64 latent instead of a 512×512 image (≈48× fewer pixels). For further speedups, distill the model (LCM/Turbo) down to 1–4 steps.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | GANs | Diffusion |
|---|---|---|
| Sampling speed | Fast — one forward pass | Slow — many denoising steps (mitigated by fast solvers) |
| Training stability | Unstable; needs careful tuning | Stable; plain regression loss |
| Mode coverage | Prone to mode collapse | Excellent distribution coverage |
| Sample quality | Very sharp (StyleGAN) | State-of-the-art, high fidelity |
| Controllability | Latent editing, harder conditioning | Strong text conditioning + guidance |
| Likelihood | Implicit, none | Approximate (variational bound) |
| Compute cost | Cheap inference | Expensive inference; heavy training |

Trade-off summary: GANs win on inference speed and remain strong for real-time and super-resolution; diffusion wins on stability, diversity, and text-to-image quality, at the cost of iterative sampling.

## 7. Common Mistakes & Best Practices

1. ⚠️ Letting the GAN discriminator overpower the generator → vanishing G gradients. ✅ Balance updates; use the non-saturating or WGAN-GP loss.
2. ⚠️ Ignoring mode collapse (G outputs near-identical samples). ✅ Monitor sample diversity; add minibatch discrimination / spectral norm.
3. ⚠️ Judging generators by loss values. ✅ GAN/diffusion losses don't track quality; use FID and human eval.
4. ⚠️ Running diffusion at 1000 steps in production. ✅ Use DDIM/DPM-Solver at 20–50 steps or a distilled few-step model.
5. ⚠️ Setting classifier-free guidance too high → oversaturated, artifact-heavy images. ✅ Keep `w` around 5–8; tune per model.
6. ⚠️ Doing pixel-space diffusion at high resolution → enormous compute. ✅ Use latent diffusion (VAE-compressed space).
7. ⚠️ Forgetting the timestep embedding in the U-Net. ✅ Always condition the denoiser on `t`; it must know the noise level.
8. ⚠️ Mismatched noise schedule between training and sampling. ✅ Use the same schedule/scheduler config for both.
9. ⚠️ Using BatchNorm in a WGAN critic. ✅ Prefer LayerNorm/InstanceNorm; BN breaks the gradient-penalty assumptions.
10. ⚠️ Shipping generated media without provenance. ✅ Add watermarks/C2PA metadata and a safety filter.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Losses are unreliable for generative models, so *look at samples* frequently and track **FID** (Fréchet Inception Distance, lower = closer to real) plus diversity metrics. For GANs, plot D and G losses — a D loss crashing to ~0 signals it's winning and G will stall. For diffusion, sanity-check that a trained model can denoise a partially noised real image back to something coherent.

**Monitoring.** In serving, monitor latency per image (dominated by step count × U-Net cost), GPU memory, throughput (images/sec), and failure/refusal rates from the safety checker. Track prompt distribution and NSFW-filter hit rates. Watch for quality drift after model or scheduler changes.

**Security & safety.** Generative image models raise real risks: deepfakes, NSFW/CSAM generation, copyright and likeness misuse, and training-data memorization (models can regurgitate near-copies of training images). Deploy input/output safety classifiers, block disallowed prompts, watermark outputs (invisible watermarking, C2PA content credentials), and rate-limit to deter abuse. Be transparent that content is AI-generated.

**Performance & Scaling.** Use latent diffusion, fast samplers, fp16/bf16, memory-efficient attention, and batch generation. Distill to few-step models (LCM, SDXL-Turbo) for real-time UX. Scale training with data/model parallelism and EMA weights for stability. Cache the text encoder outputs for repeated prompts and serve behind an autoscaling GPU pool.

## 9. Interview Questions

**Q: How does a GAN train, at a high level?**
A: Two networks compete: the discriminator learns to classify real vs generated samples, and the generator learns to produce samples that fool the discriminator. It's a minimax game; as the discriminator improves, the generator is pushed to make more realistic outputs, ideally converging where fakes are indistinguishable from reals.

**Q: What is mode collapse and why does it happen?**
A: Mode collapse is when the generator produces only a few distinct outputs, ignoring much of the data distribution, because it found a small set of samples that reliably fool the current discriminator. It stems from the adversarial dynamics and is mitigated with techniques like minibatch discrimination, spectral normalization, or the Wasserstein loss.

**Q: How do diffusion models generate images?**
A: They define a fixed forward process that gradually adds Gaussian noise to an image over many steps, and train a network to reverse it by predicting the noise at each step. Generation starts from pure noise and iteratively denoises — subtracting predicted noise — until a clean sample emerges.

**Q: What exactly does the diffusion network predict, and what's the loss?**
A: Typically it predicts the noise `ε` that was added to produce the noisy input at timestep `t` (ε-prediction). The training loss is just the mean-squared error between the true and predicted noise, which makes training a stable regression problem rather than an adversarial game.

**Q: Why did diffusion models overtake GANs for text-to-image?**
A: Diffusion trains stably (simple MSE loss, no adversarial instability), covers the data distribution far better (no mode collapse), and conditions strongly on text via cross-attention plus classifier-free guidance. The main downside — slow iterative sampling — was largely solved by fast solvers and latent-space diffusion.

**Q: What is latent diffusion and why is it important?**
A: Latent diffusion runs the diffusion process in a compressed latent space produced by a VAE, rather than in raw pixel space. Since the latent is dramatically smaller (e.g. 64×64 vs 512×512), it cuts compute and memory by orders of magnitude, which is what made high-resolution text-to-image (Stable Diffusion) practical on consumer GPUs.

**Q: (Senior) What is classifier-free guidance and how does it work?**
A: CFG improves prompt adherence without a separate classifier by training the model both conditionally and unconditionally (randomly dropping the condition). At sampling, it extrapolates: `ε̂ = ε_uncond + w·(ε_cond − ε_uncond)`. Higher guidance scale `w` increases fidelity to the prompt but reduces diversity and can cause oversaturation artifacts.

**Q: (Senior) Why can't you use the loss value to judge a GAN, and what do you use?**
A: GAN losses reflect the relative balance of the two-player game, not sample quality — a low generator loss can mean the discriminator is weak, not that images are good. Instead use FID (distance between real and generated feature distributions), Inception Score, precision/recall for distributions, and human evaluation.

**Q: (Senior) Connect diffusion models to score-based generative modeling.**
A: Predicting the added noise is equivalent, up to scaling, to estimating the score `∇_x log p(x_t)` — the gradient of the data log-density at each noise level. Sampling then follows the score toward higher-density regions (Langevin/reverse-SDE dynamics), which is why DDPMs and score-based SDE models are two views of the same framework.

**Q: What role does the U-Net play in a diffusion model?**
A: The U-Net is the denoiser: an encoder–decoder with skip connections that takes the noisy image, the timestep embedding, and (for conditional models) text embeddings via cross-attention, and outputs the predicted noise. Its multi-scale structure captures both global layout and fine detail.

**Q: How do you speed up diffusion sampling?**
A: Use faster samplers (DDIM, DPM-Solver++) that take 20–50 steps instead of 1000, run in latent space, use fp16 and memory-efficient attention, and distill the model into a few-step version (LCM, Turbo) for near real-time generation.

**Q: (Senior) What are the main safety and legal risks of deploying image generators?**
A: Deepfakes and non-consensual imagery, generation of illegal or harmful content, copyright/likeness infringement, and training-data memorization (reproducing near-copies of training images). Mitigations include input/output safety classifiers, prompt blocklists, invisible watermarking and C2PA provenance, rate limiting, and clear AI-generated labeling.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** GANs generate in one shot via an adversarial game between a generator and discriminator — fast but unstable and prone to mode collapse. Diffusion models add noise to data over many steps and train a U-Net to predict/remove that noise (simple MSE loss), then sample by denoising from pure noise — stable, diverse, high-quality, but iterative. Latent diffusion runs the process in a compressed space for efficiency (Stable Diffusion); cross-attention injects the text prompt; classifier-free guidance trades diversity for prompt fidelity; fast solvers cut 1000 steps to ~20–50. Judge with FID, not loss, and deploy with safety filters and provenance.

| | GAN | Diffusion |
|---|---|---|
| Mechanism | adversarial minimax | iterative denoising |
| Loss | adversarial (BCE/Wasserstein) | MSE on predicted noise |
| Speed | fast (1 pass) | slow (many steps) |
| Stability | low | high |
| Coverage | mode collapse risk | strong |
| Quality metric | FID / human | FID / human |

Flash cards:
- **GAN's two networks?** → Generator (makes fakes) and Discriminator (detects them).
- **What does a diffusion U-Net predict?** → The noise added at timestep `t` (ε-prediction).
- **Why latent diffusion?** → Diffuse in a compressed space → far less compute for high-res.
- **What is classifier-free guidance?** → Extrapolate conditional vs unconditional to boost prompt fidelity.
- **Right way to judge quality?** → FID + human eval, not the loss value.

## 11. Hands-On Exercises & Mini Project

- [ ] Train a small GAN on MNIST and visualize mode collapse, then fix it with spectral norm.
- [ ] Implement the closed-form forward noising `x_t = √ᾱ x_0 + √(1−ᾱ) ε` and visualize a real image at several noise levels.
- [ ] Train a tiny DDPM U-Net on FashionMNIST and sample images from noise.
- [ ] With `diffusers`, sweep guidance scale (1, 5, 7.5, 15) and observe fidelity vs artifacts.
- [ ] Compare DDPM (1000 steps) vs DPM-Solver (25 steps) on wall-clock time and quality.

**Mini Project — Text-to-image playground with evaluation.**
Goal: build a small text-to-image app and quantitatively compare sampling settings.
Requirements: (1) load Stable Diffusion via `diffusers`; (2) expose prompt, steps, guidance, and seed controls; (3) generate a grid across settings; (4) compute FID against a reference set for two configurations; (5) add a safety filter and watermark to outputs.
Extensions: fine-tune with LoRA on a small custom concept; add a DPM-Solver vs DDIM speed/quality benchmark; implement image-to-image (start denoising from a noised input image); log latency and GPU memory per configuration.

## 12. Related Topics & Free Learning Resources

Related chapters: **Attention & the Transformer** (cross-attention conditions the U-Net; text encoders are Transformers), **Embeddings & Representation Learning** (latent spaces and CLIP text/image embeddings), **NLP Foundations & Tokenization** (prompts are tokenized first), and **PyTorch in Practice** (implementing and training these models).

**Free Learning Resources**
- **Generative Adversarial Networks** — Goodfellow et al. (2014) · *Advanced* · the original GAN paper. <https://arxiv.org/abs/1406.2661>
- **Denoising Diffusion Probabilistic Models (DDPM)** — Ho et al. (2020) · *Advanced* · the paper that made diffusion practical. <https://arxiv.org/abs/2006.11239>
- **High-Resolution Image Synthesis with Latent Diffusion Models** — Rombach et al. (2022) · *Advanced* · the Stable Diffusion paper. <https://arxiv.org/abs/2112.10752>
- **What are Diffusion Models?** — Lilian Weng · *Intermediate* · the clearest math-forward blog explainer. <https://lilianweng.github.io/posts/2021-07-11-diffusion-models/>
- **The Illustrated Stable Diffusion** — Jay Alammar · *Beginner* · visual walkthrough of the latent text-to-image pipeline. <https://jalammar.github.io/illustrated-stable-diffusion/>
- **Hugging Face Diffusers course/docs** — Hugging Face · *Intermediate* · hands-on training and inference with diffusion models. <https://huggingface.co/docs/diffusers/index>
- **Diffusion Models — MIT / Outlier explainer video** — Outlier · *Beginner→Intermediate* · intuitive animated introduction to the forward/reverse process. <https://www.youtube.com/watch?v=HoKDTa5jHvg>
- **CS231n: Generative Models** — Stanford · *Advanced* · lecture notes covering GANs and generative modeling. <https://cs231n.github.io/>

---

*AI Engineering Handbook — chapter 24.*
