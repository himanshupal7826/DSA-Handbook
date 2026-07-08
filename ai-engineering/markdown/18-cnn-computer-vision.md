# 18 · CNNs & Computer Vision

> **In one line:** Convolutions share weights across space to learn a hierarchy of visual features — the idea, from LeNet to ResNet to the Vision Transformer, that made machines see.

---

## 1. Overview

**Convolutional Neural Networks (CNNs)** are the architecture that took computer vision from hand-crafted feature engineering (SIFT, HOG) to end-to-end learned perception. The core insight is simple and powerful: images have **local structure** (nearby pixels are related) and **translation invariance** (a cat is a cat wherever it appears), so instead of connecting every pixel to every neuron, you slide a small learnable **filter** across the image and reuse the *same weights* everywhere. That single idea — **parameter sharing** — cuts parameters by orders of magnitude and bakes in the right inductive bias for images.

The problem CNNs solve is the curse of dimensionality on pixels. A modest 224×224×3 image is ~150,000 inputs; a fully-connected first layer with 1,000 units would need 150 million weights *for one layer* and would learn nothing about spatial locality. A convolutional layer with 64 filters of size 3×3×3 uses ~1,700 weights and learns edge detectors that generalize across the whole image. Stack these layers and the network builds a **feature hierarchy**: edges → textures → parts → objects.

The history is a series of landmark architectures. **LeNet-5** (LeCun, 1998) read handwritten digits for the US postal service. **AlexNet** (2012) won ImageNet by a huge margin and launched the deep-learning era with ReLU, dropout, and GPUs. **VGG** (2014) showed that depth with tiny 3×3 filters works. **ResNet** (2015) introduced **skip connections** and trained 152 layers, effectively solving the vanishing-gradient barrier. Then in 2020 the **Vision Transformer (ViT)** showed that with enough data, pure attention on image patches beats CNNs — and **ConvNeXt** (2022) showed a modernized CNN can match ViT right back.

A concrete example: a phone's "sort photos by content" feature runs a small CNN (often a MobileNet/EfficientNet or a fine-tuned ResNet) that takes a photo and outputs class probabilities — "beach," "dog," "receipt." It was trained once on millions of labeled images; on-device it's a few million multiply-adds per image, fast enough to run offline. The mental model to keep: **convolution = learnable, weight-shared feature detectors; pooling = spatial summarization; depth = abstraction; skip connections = trainable depth; and the whole thing is usually reused via transfer learning rather than trained from scratch.**

## 2. Core Concepts

- **Convolution** — sliding a small learnable kernel over the input and computing a dot product at each position, producing a **feature map** that responds to a particular pattern.
- **Kernel / filter** — the small weight tensor (e.g. 3×3×C_in) that is learned; each filter detects one feature and produces one output channel.
- **Stride** — how many pixels the kernel moves per step; stride 2 halves the spatial resolution and downsamples.
- **Padding** — adding a border (usually zeros) so output size is controllable; `"same"` padding keeps H×W constant, `"valid"` shrinks it.
- **Receptive field** — the region of the input that influences one output activation; it grows with depth, stride, and dilation until deep neurons "see" the whole image.
- **Parameter sharing** — the same kernel weights are applied at every spatial location, giving translation equivariance and drastically fewer parameters than a dense layer.
- **Feature map (activation map)** — the H×W×C output of a conv layer; each channel is the response of one filter across space.
- **Pooling** — a fixed downsampling op: **max pooling** keeps the strongest response in a window, **average pooling** the mean, **global average pooling** collapses each channel to one number before the classifier.
- **Skip / residual connection** — an identity shortcut `y = F(x) + x` that lets gradients and signal bypass layers, enabling very deep networks.
- **Transfer learning** — reusing a network pretrained on a large dataset (ImageNet) and fine-tuning it on your smaller task.
- **Data augmentation** — label-preserving random transforms (flip, crop, color jitter) that enlarge the effective training set and improve generalization.
- **Vision Transformer (ViT)** — a transformer that splits an image into patches, linearly embeds them as tokens, and applies self-attention instead of convolution.

## 3. Theory & Mathematical Intuition

A 2-D convolution (technically cross-correlation) of input `X` with kernel `K` of size `k×k` produces output `O` where:

```
O[i, j] = Σ_m Σ_n X[i·s + m, j·s + n] · K[m, n] + b        (s = stride)
```

For a layer with `C_in` input channels and `C_out` filters, each filter is `k×k×C_in` and there are `C_out` of them, so the parameter count is `k·k·C_in·C_out + C_out` — **independent of the image's H and W**. That is the payoff of parameter sharing: a 3×3 conv from 64→128 channels has `3·3·64·128 + 128 ≈ 74K` weights whether the image is 32×32 or 512×512. A dense layer on a flattened 224×224×3 image to just 1,000 units needs 150M weights and forgets that pixels are spatial.

**Output size** for one dimension is:

```
O = floor((W − k + 2p) / s) + 1
```

So a 224-wide input, 3×3 kernel, padding 1, stride 1 → `(224−3+2)/1 + 1 = 224` (size preserved); stride 2 → `112` (halved). This is the arithmetic you use to keep track of tensor shapes through a network.

The **receptive field** grows as you stack layers. Two stacked 3×3 convs see a 5×5 patch; three see 7×7 — with fewer parameters and more non-linearity than one 7×7 conv. That's the VGG insight: prefer stacks of small kernels. Add stride/pooling and the receptive field expands multiplicatively, so deep layers integrate information from the whole image while early layers stay local.

The diagram makes the sliding-window mechanics and channel expansion concrete:

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5">
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Convolution: a shared 3×3 kernel slides to build a feature map</text>

  <text x="120" y="54" text-anchor="middle" fill="#4f46e5" font-weight="700">Input (5×5)</text>
  <g stroke="#4f46e5" fill="#eef2ff">
    <rect x="40" y="66" width="30" height="30"/><rect x="70" y="66" width="30" height="30"/><rect x="100" y="66" width="30" height="30"/><rect x="130" y="66" width="30" height="30"/><rect x="160" y="66" width="30" height="30"/>
    <rect x="40" y="96" width="30" height="30"/><rect x="70" y="96" width="30" height="30"/><rect x="100" y="96" width="30" height="30"/><rect x="130" y="96" width="30" height="30"/><rect x="160" y="96" width="30" height="30"/>
    <rect x="40" y="126" width="30" height="30"/><rect x="70" y="126" width="30" height="30"/><rect x="100" y="126" width="30" height="30"/><rect x="130" y="126" width="30" height="30"/><rect x="160" y="126" width="30" height="30"/>
    <rect x="40" y="156" width="30" height="30"/><rect x="70" y="156" width="30" height="30"/><rect x="100" y="156" width="30" height="30"/><rect x="130" y="156" width="30" height="30"/><rect x="160" y="156" width="30" height="30"/>
    <rect x="40" y="186" width="30" height="30"/><rect x="70" y="186" width="30" height="30"/><rect x="100" y="186" width="30" height="30"/><rect x="130" y="186" width="30" height="30"/><rect x="160" y="186" width="30" height="30"/>
  </g>
  <rect x="40" y="66" width="90" height="90" fill="#fde68a" fill-opacity="0.55" stroke="#d97706" stroke-width="2.5"/>

  <text x="330" y="120" text-anchor="middle" fill="#16a34a" font-weight="700">3×3 kernel</text>
  <text x="330" y="140" text-anchor="middle" fill="#475569" font-size="11">weights shared</text>
  <text x="330" y="156" text-anchor="middle" fill="#475569" font-size="11">at every position</text>
  <line x1="200" y1="111" x2="270" y2="121" stroke="#475569" stroke-dasharray="4 3"/>
  <line x1="270" y1="140" x2="470" y2="120" stroke="#475569"/>

  <text x="560" y="54" text-anchor="middle" fill="#0ea5e9" font-weight="700">Feature map (3×3)</text>
  <g stroke="#0ea5e9" fill="#e0f2fe">
    <rect x="490" y="66" width="34" height="34"/><rect x="524" y="66" width="34" height="34"/><rect x="558" y="66" width="34" height="34"/>
    <rect x="490" y="100" width="34" height="34"/><rect x="524" y="100" width="34" height="34"/><rect x="558" y="100" width="34" height="34"/>
    <rect x="490" y="134" width="34" height="34"/><rect x="524" y="134" width="34" height="34"/><rect x="558" y="134" width="34" height="34"/>
  </g>
  <rect x="490" y="66" width="34" height="34" fill="#bae6fd" stroke="#0ea5e9" stroke-width="2.5"/>

  <text x="640" y="120" text-anchor="middle" fill="#475569" font-size="11">C_out filters</text>
  <text x="640" y="136" text-anchor="middle" fill="#475569" font-size="11">→ C_out maps</text>

  <text x="380" y="248" text-anchor="middle" fill="#1e293b" font-size="12">O[i,j] = Σ X[patch]·K + b   ·   params = k·k·C_in·C_out (independent of H,W)</text>
  <text x="380" y="270" text-anchor="middle" fill="#64748b" font-size="11">out size = floor((W − k + 2p)/s) + 1   ·   here (5−3)/1 + 1 = 3</text>
</svg>
```

Finally, why **skip connections** matter mathematically: in a plain deep net the gradient to early layers is a long product of Jacobians, which tends to vanish (or explode). A residual block computes `y = F(x) + x`, so `∂y/∂x = ∂F/∂x + I` — the `+I` guarantees a gradient path of magnitude ~1 straight back to `x`, regardless of how deep the net is. That identity shortcut is exactly why ResNet-152 trains where a plain 152-layer net does not.

## 4. Architecture & Workflow

A modern image classifier is a **stem → stages of blocks → head** pipeline. Early stages keep high resolution and few channels (learning edges/textures); deeper stages downsample spatially while widening channels (learning parts/objects); a global-average-pool and linear head produce class logits.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="cn" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">A ResNet-style classifier: stem → stages → head</text>

  <rect x="24"  y="70" width="96" height="150" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="72" y="140" text-anchor="middle" fill="#1e293b" font-weight="700">Image</text>
  <text x="72" y="158" text-anchor="middle" fill="#64748b" font-size="11">224×224×3</text>

  <rect x="150" y="80" width="110" height="130" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="205" y="128" text-anchor="middle" fill="#1e293b" font-weight="700">Stem</text>
  <text x="205" y="146" text-anchor="middle" fill="#64748b" font-size="11">7×7 conv, s2</text>
  <text x="205" y="162" text-anchor="middle" fill="#64748b" font-size="11">+ maxpool</text>

  <rect x="290" y="90" width="120" height="110" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="350" y="128" text-anchor="middle" fill="#1e293b" font-weight="700">Stage 1–4</text>
  <text x="350" y="146" text-anchor="middle" fill="#64748b" font-size="11">residual blocks</text>
  <text x="350" y="162" text-anchor="middle" fill="#64748b" font-size="11">↓H,W  ↑channels</text>

  <rect x="440" y="100" width="120" height="90" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="500" y="138" text-anchor="middle" fill="#1e293b" font-weight="700">Global avg</text>
  <text x="500" y="156" text-anchor="middle" fill="#64748b" font-size="11">pool → 1×1×512</text>

  <rect x="590" y="100" width="120" height="90" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="650" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">FC + softmax</text>
  <text x="650" y="150" text-anchor="middle" fill="#64748b" font-size="11">1000 classes</text>
  <text x="650" y="166" text-anchor="middle" fill="#64748b" font-size="11">→ probs</text>

  <line x1="120" y1="145" x2="148" y2="145" stroke="#475569" marker-end="url(#cn)"/>
  <line x1="260" y1="145" x2="288" y2="145" stroke="#475569" marker-end="url(#cn)"/>
  <line x1="410" y1="145" x2="438" y2="145" stroke="#475569" marker-end="url(#cn)"/>
  <line x1="560" y1="145" x2="588" y2="145" stroke="#475569" marker-end="url(#cn)"/>

  <rect x="270" y="240" width="240" height="66" rx="8" fill="#f8fafc" stroke="#16a34a"/>
  <text x="390" y="262" text-anchor="middle" fill="#1e293b" font-weight="700">Residual block:  y = F(x) + x</text>
  <text x="390" y="280" text-anchor="middle" fill="#64748b" font-size="11">conv→BN→ReLU→conv→BN , then add identity x</text>
  <text x="390" y="296" text-anchor="middle" fill="#64748b" font-size="11">the +x path keeps the gradient alive through depth</text>
  <path d="M350,200 L350,238" fill="none" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#cn)"/>
</svg>
```

Step by step, how an image flows through and how the model is built:

1. **Preprocess.** Resize/crop to a fixed size, convert to a tensor, and **normalize** with the dataset's channel mean/std (for ImageNet-pretrained models, the ImageNet stats).
2. **Stem.** A large-stride conv (7×7 stride 2) plus max-pool rapidly reduces resolution while extracting low-level edges, keeping later compute affordable.
3. **Stages of blocks.** Each stage stacks several **Conv→BN→ReLU** units (or residual blocks). The first block of a stage downsamples (stride 2) and doubles channels; the rest preserve shape. Depth here builds the edge→texture→part→object hierarchy.
4. **Skip connections** inside each residual block add the block's input to its output, so gradients flow directly backward and the block only has to learn a *residual* correction.
5. **Global average pooling** collapses the final H×W×C feature map to a C-vector — no giant flatten, far fewer parameters than VGG's dense head, and it's spatially robust.
6. **Classifier head.** A linear layer maps the pooled vector to class logits; **softmax** turns them into probabilities. Training uses cross-entropy.
7. **Transfer learning path.** In practice you rarely start from scratch: load ImageNet-pretrained weights, replace step 6's head with your number of classes, freeze the backbone (or use a low LR on it), and fine-tune on your data.

## 5. Implementation

First, a small **Conv-BN-ReLU-Pool** CNN for CIFAR-style 32×32 classification, written idiomatically in PyTorch 2.x.

```python
import torch
import torch.nn as nn
import torch.nn.functional as F

class ConvBlock(nn.Module):
    """Conv -> BatchNorm -> ReLU, the standard CNN unit."""
    def __init__(self, c_in, c_out, stride=1):
        super().__init__()
        self.conv = nn.Conv2d(c_in, c_out, kernel_size=3, stride=stride,
                              padding=1, bias=False)   # bias redundant before BN
        self.bn = nn.BatchNorm2d(c_out)

    def forward(self, x):
        return F.relu(self.bn(self.conv(x)), inplace=True)

class SmallCNN(nn.Module):
    def __init__(self, num_classes=10):
        super().__init__()
        self.features = nn.Sequential(
            ConvBlock(3, 64),   ConvBlock(64, 64),   nn.MaxPool2d(2),   # 32 -> 16
            ConvBlock(64, 128), ConvBlock(128, 128), nn.MaxPool2d(2),   # 16 -> 8
            ConvBlock(128, 256),ConvBlock(256, 256), nn.MaxPool2d(2),   # 8  -> 4
        )
        self.head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),     # global average pool -> 256x1x1
            nn.Flatten(),
            nn.Dropout(0.2),
            nn.Linear(256, num_classes),
        )

    def forward(self, x):
        return self.head(self.features(x))

model = SmallCNN(num_classes=10)
n_params = sum(p.numel() for p in model.parameters())
print(f"params: {n_params/1e6:.2f}M")   # params: 2.78M

x = torch.randn(8, 3, 32, 32)           # a batch of 8 CIFAR images
logits = model(x)
print(logits.shape)                     # torch.Size([8, 10])

# Trained on CIFAR-10 (SGD/AdamW, cosine LR, standard augmentation, ~50 epochs)
# this ~2.8M-param net reaches roughly 90-93% test accuracy — a strong from-scratch
# baseline. AlexNet-era nets got ~89%; a ResNet-18 gets ~95%.
```

The augmentation and normalization pipeline is as important as the model. Standard CIFAR training uses random crop + horizontal flip; ImageNet adds color jitter and often RandAugment/Mixup.

```python
from torchvision import transforms

CIFAR_MEAN, CIFAR_STD = (0.4914, 0.4822, 0.4465), (0.2470, 0.2435, 0.2616)

train_tf = transforms.Compose([
    transforms.RandomCrop(32, padding=4),          # translation invariance
    transforms.RandomHorizontalFlip(),             # left-right symmetry
    transforms.ColorJitter(0.2, 0.2, 0.2),         # lighting robustness
    transforms.ToTensor(),
    transforms.Normalize(CIFAR_MEAN, CIFAR_STD),
])
test_tf = transforms.Compose([                     # NO random ops at test time
    transforms.ToTensor(),
    transforms.Normalize(CIFAR_MEAN, CIFAR_STD),
])
```

Now the far more common real-world path — **transfer learning** with a pretrained ResNet from torchvision. You reuse ImageNet features and only retrain the head (plus optionally fine-tune the backbone at a low LR).

```python
import torch
import torch.nn as nn
from torchvision import models

def build_transfer_model(num_classes, freeze_backbone=True):
    # Modern torchvision API: load pretrained weights + their preprocessing.
    weights = models.ResNet50_Weights.IMAGENET1K_V2
    model = models.resnet50(weights=weights)
    preprocess = weights.transforms()              # correct resize/crop/normalize

    if freeze_backbone:
        for p in model.parameters():
            p.requires_grad = False                # feature extractor mode

    in_feats = model.fc.in_features                # 2048 for ResNet-50
    model.fc = nn.Linear(in_feats, num_classes)    # fresh head, always trainable
    return model, preprocess

model, preprocess = build_transfer_model(num_classes=37)   # e.g. Oxford Pets

# Discriminative fine-tuning: tiny LR on the (unfrozen) backbone, larger on the head.
def make_optimizer(model, unfreeze=False):
    if unfreeze:
        for p in model.parameters():
            p.requires_grad = True
        return torch.optim.AdamW([
            {"params": [p for n, p in model.named_parameters()
                        if not n.startswith("fc")], "lr": 1e-5},   # backbone
            {"params": model.fc.parameters(), "lr": 1e-3},         # head
        ], weight_decay=1e-4)
    # Feature-extraction phase: only the head trains.
    return torch.optim.AdamW(model.fc.parameters(), lr=1e-3, weight_decay=1e-4)

# Typical results on a small dataset (a few thousand images, Oxford-IIIT Pets):
#   frozen backbone, train head only ..... ~88-90% accuracy in ~5 epochs
#   then unfreeze + fine-tune at 1e-5 ..... ~92-94% accuracy
# Training the same ResNet-50 FROM SCRATCH on that little data would badly overfit
# and land far lower (~70%). Transfer learning is the default for < ~50k images.
```

> **Optimization note:** for inference and training throughput, set `model = model.to(memory_format=torch.channels_last)` and feed `channels_last` tensors — convolutions run markedly faster on modern GPUs in that layout. Add `torch.compile(model)` (PyTorch 2.x) and bf16 `autocast` for another large speedup. For deployment, export to **TorchScript** or **ONNX** and quantize to int8 — a ResNet-50 shrinks ~4× and speeds up ~2–4× on CPU with typically <1% accuracy loss.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Parameter sharing** | Orders of magnitude fewer weights than dense; translation equivariance | Assumes locality/stationarity — wrong for non-image tabular data |
| **Convolution** | Strong image inductive bias → learns well from limited data | Fixed local receptive field; long-range relations need depth |
| **Pooling / stride** | Downsamples, cheap, adds spatial invariance | Discards precise location; bad for dense tasks unless you use skip/up-sampling |
| **Skip connections (ResNet)** | Trainable 100+ layer nets; solves vanishing gradients | Extra memory for identity paths; more design complexity |
| **BatchNorm in CNNs** | Faster, more stable training; mild regularization | Batch-dependent; unstable at tiny batch sizes |
| **Transfer learning** | High accuracy on small data, fast, cheap | Domain gap (medical/satellite ≠ ImageNet) can limit gains |
| **Data augmentation** | Large generalization boost, nearly free | Wrong/aggressive transforms can destroy label semantics |
| **Vision Transformer** | SOTA at scale; global context from layer 1; unified with NLP | Data-hungry (needs huge datasets or heavy augmentation/distillation); weaker bias |
| **CNN vs ViT** | CNN wins on small/medium data & efficiency | ViT wins at very large scale and for multimodal fusion |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Applying random augmentation at test time** → noisy, non-reproducible metrics. ✅ Use deterministic resize/crop/normalize for validation and test.
2. ⚠️ **Forgetting to normalize with the model's expected mean/std** → a pretrained backbone sees out-of-distribution inputs and accuracy craters. ✅ Use `weights.transforms()` from torchvision.
3. ⚠️ **Training a big CNN from scratch on a few thousand images** → severe overfitting. ✅ Use transfer learning; freeze the backbone first, then fine-tune.
4. ⚠️ **Leaving BatchNorm in train mode during evaluation** → it uses batch stats instead of running stats. ✅ Call `model.eval()` (and `torch.no_grad()`) for inference.
5. ⚠️ **Fine-tuning the whole pretrained net at a high LR immediately** → catastrophic forgetting of good features. ✅ Warm up with the head, then unfreeze at a very small LR (e.g. 1e-5).
6. ⚠️ **Using a `bias=True` conv right before BatchNorm** → the bias is redundant and wasteful. ✅ Set `bias=False` on convs followed by BN.
7. ⚠️ **Mismatched input size for a net with dense (non-adaptive) heads** → shape errors or garbage. ✅ Use `AdaptiveAvgPool2d(1)`/global pooling so any spatial size works.
8. ⚠️ **Augmenting in a way that breaks labels** (vertical-flipping digits, hue-shifting for color classification) → label noise. ✅ Choose transforms that preserve the target semantics.
9. ⚠️ **Very small batches with BatchNorm** → unstable statistics. ✅ Use GroupNorm/LayerNorm or accumulate, or increase the batch.
10. ⚠️ **Ignoring class imbalance** → the model predicts the majority class. ✅ Use weighted loss, oversampling, or focal loss and report per-class metrics.
11. ⚠️ **Trusting accuracy on imbalanced or shifted data** → misleading. ✅ Track a confusion matrix, precision/recall/F1, and evaluate on the true deployment distribution.
12. ⚠️ **Reaching for a ViT on a small dataset** → underperforms a CNN because it lacks the convolutional inductive bias. ✅ Use a CNN (or a distilled/pretrained ViT) when data is limited.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Sanity-check shapes end to end (a single forward pass with a known batch) — most CNN bugs are shape mismatches from a wrong stride/padding. If accuracy is stuck near chance, verify the label mapping and the normalization stats, and overfit a *single batch* to ~100% first; a model that can't memorize one batch has a plumbing bug, not a capacity problem. **Grad-CAM** overlays show *where* the network looks — if it fixates on backgrounds or watermarks, you've found a dataset leak. Visualize augmented samples to catch label-breaking transforms.

**Monitoring.** In training, log loss, top-1/top-5 accuracy, and the train/val gap; watch a **confusion matrix** to see which classes are confused. In production, monitor **input distribution drift** (image size, brightness, class mix) and prediction-confidence distributions — a sudden shift signals a camera change, a new content type, or an upstream bug. Track p50/p99 inference latency and throughput. Sample and human-review low-confidence predictions to build a feedback loop.

**Security & robustness.** CNNs are vulnerable to **adversarial examples** — imperceptible pixel perturbations that flip the prediction; defenses include adversarial training and input preprocessing, and safety-critical systems need out-of-distribution detection. Pretrained checkpoints are executable code: load with `weights_only=True` and verify checksums to avoid supply-chain attacks. Guard against **data poisoning** in the training set (validate provenance) and be aware that models can memorize and leak training images — relevant for privacy (faces, medical scans).

**Performance & scaling.** Serve with `channels_last` + bf16 + `torch.compile`, and for edge/CPU deployment quantize to int8 (roughly 4× smaller, 2–4× faster) or distill into a smaller student (MobileNet/EfficientNet). Use TensorRT/ONNX Runtime for optimized inference. For training at scale, use **DistributedDataParallel** with one GPU per process and a large aggregate batch; mixed precision and gradient accumulation let you hit ResNet/ViT training budgets. Cache decoded images or use DALI/`webdataset` so the data loader isn't the bottleneck — with fast GPUs, JPEG decoding is often the real limiter.

## 9. Interview Questions

**Q: Why use convolutions instead of fully-connected layers for images?**
A: Convolutions exploit the local structure and translation invariance of images via **parameter sharing** — the same small filter slides everywhere, so a layer has a few thousand weights instead of the millions a dense layer would need on flattened pixels. This gives the right inductive bias (locality, translation equivariance), learns far more sample-efficiently, and produces feature detectors that generalize across the whole image.

**Q: Explain stride, padding, and how they affect output size.**
A: Stride is how many pixels the kernel moves per step — stride 2 halves resolution and downsamples. Padding adds a border (usually zeros) so you can control output size and preserve edges. The output dimension is `floor((W − k + 2p)/s) + 1`; `"same"` padding keeps H×W constant at stride 1, `"valid"` (no padding) shrinks it by `k−1`.

**Q: What is a receptive field and why does it grow with depth?**
A: The receptive field is the region of the input that influences one output activation. Each conv layer widens it by `k−1`, and stride/pooling multiply it, so stacked layers let deep neurons integrate information from progressively larger regions — from local edges to whole objects. Two stacked 3×3 convs cover 5×5 with fewer parameters and more non-linearity than a single 5×5.

**Q: How do skip connections in ResNet solve vanishing gradients?**
A: A residual block computes `y = F(x) + x`, so its Jacobian is `∂F/∂x + I`. The identity term guarantees a gradient path of magnitude ~1 straight back to the input no matter how deep the network, preventing the long product of small Jacobians from collapsing to zero. That is why ResNet trains 152 layers where a plain net of the same depth degrades.

**Q: What's the difference between max pooling and global average pooling, and when do you use each?**
A: Max pooling takes the strongest activation in a small window to downsample and add local translation invariance within the feature stages. Global average pooling collapses the *entire* final feature map per channel into one number, replacing a huge dense flatten — it has no parameters, resists overfitting, and lets the network accept variable input sizes. Modern nets use max/strided pooling in the body and global average pooling before the classifier.

**Q: Walk me through transfer learning for a new image task with only a few thousand labels.**
A: Load an ImageNet-pretrained backbone (e.g. ResNet-50), replace the final FC layer with one sized to your classes, and first **freeze the backbone** and train only the new head with the model's expected normalization. Then optionally **unfreeze and fine-tune** the whole network at a very small learning rate (with a larger LR on the head). This reuses generic edge/texture/part features and reaches high accuracy where from-scratch training would badly overfit.

**Q: Why is data augmentation so effective for vision, and what can go wrong?**
A: Augmentation applies label-preserving random transforms (crop, flip, color jitter, Mixup/RandAugment) so the model sees far more effective variety and learns invariances instead of memorizing, which reduces overfitting and improves generalization. It goes wrong when a transform breaks the label — vertical-flipping a digit, hue-shifting when color *is* the class, or cropping out the object — injecting label noise that hurts more than it helps.

**Q: (Senior) When does a Vision Transformer beat a CNN, and why?**
A: ViT wins at large data scale and for global-context or multimodal tasks. It splits the image into patches, embeds them as tokens, and uses self-attention, so every patch can attend to every other from the first layer — global receptive field immediately, unlike a CNN's slowly-growing local one. But attention has a *weaker* inductive bias, so on small/medium datasets a CNN's built-in locality and translation equivariance win; ViT needs huge datasets, heavy augmentation, or distillation (DeiT) to compete there. ConvNeXt later showed a modernized CNN matches ViT, so the gap is partly recipe, not just architecture.

**Q: (Senior) Why does BatchNorm accelerate CNN training, and what breaks it in production?**
A: BatchNorm normalizes each channel's pre-activations to zero mean/unit variance over the batch, which smooths the loss landscape, allows higher learning rates, and adds mild regularization from batch noise — collectively a large speedup. It breaks with tiny or size-1 batches (noisy statistics), for online/streaming inference (train/eval statistic mismatch), and when the batch isn't i.i.d. (e.g. sorted data). Fixes are GroupNorm/LayerNorm, SyncBatchNorm across GPUs, or freezing BN stats when fine-tuning with small batches.

**Q: (Senior) A model hits 99% train accuracy but 70% validation. Diagnose and fix.**
A: That gap is classic overfitting. First confirm it's not a leak or distribution mismatch (Grad-CAM to check it's using the object, not a watermark; verify train/val come from the same distribution and there's no duplicate leakage). Then regularize: stronger augmentation, dropout, weight decay, early stopping, and — most impactfully with limited data — transfer learning from a pretrained backbone and reducing model capacity. Re-check the val curve after each change and watch the gap, not just train loss.

**Q: How do you keep a data loader from bottlenecking GPU training?**
A: Decode and augment on CPU in parallel with `num_workers > 0` and `pin_memory=True`, prefetch, and move batches with `non_blocking=True`. If JPEG decoding still dominates, use GPU decoding (NVIDIA DALI), pre-resize/cache images, or pack them into `webdataset`/TFRecord shards for sequential reads. The goal is that GPU utilization stays near 100% — if it's low and CPU is pegged, the loader, not the model, is the limit.

**Q: What's the trade-off between deeper networks and wider networks?**
A: Depth adds representational abstraction and larger receptive fields but risks vanishing gradients (mitigated by residual connections and normalization) and higher latency. Width (more channels) increases capacity and parallelism-friendly compute but costs parameters and memory quadratically in some layers. In practice you balance both — EfficientNet's compound scaling grows depth, width, and resolution together for the best accuracy-per-FLOP.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A CNN slides small learnable **kernels** over an image, sharing weights across space to build a **feature hierarchy** (edges→textures→parts→objects) with far fewer parameters than a dense net. **Stride/padding** control output size (`floor((W−k+2p)/s)+1`); **pooling** downsamples and global-average-pool feeds the classifier. The lineage runs LeNet→AlexNet→VGG (small stacked 3×3)→**ResNet** (skip connections `y=F(x)+x` solve vanishing gradients, enabling 100+ layers)→**ViT** (patch tokens + attention, best at large scale)→ConvNeXt (modernized CNN matches ViT). **BatchNorm** speeds CNN training; **augmentation** boosts generalization; **transfer learning** (freeze backbone → fine-tune) is the default for small datasets. Guard against overfitting, adversarial inputs, and BN pitfalls at small batch sizes.

| Concept | Key fact |
|---|---|
| Conv params | `k·k·C_in·C_out` — independent of H,W |
| Output size | `floor((W − k + 2p)/s) + 1` |
| Receptive field | grows with depth, stride, dilation |
| ResNet block | `y = F(x) + x` → gradient shortcut |
| Pooling | max/avg local; global avg before head |
| BatchNorm | batch axis; breaks at batch 1 |
| Transfer learning | freeze backbone → fine-tune low LR |
| ViT | patches → tokens → attention; data-hungry |

- **Why weight sharing?** → Translation equivariance + orders-of-magnitude fewer parameters.
- **Output size formula?** → `floor((W − k + 2p)/s) + 1`.
- **What do skip connections do?** → Add identity so `∂y/∂x = ∂F/∂x + I`, keeping gradients alive.
- **CNN vs ViT on small data?** → CNN wins — its convolutional inductive bias needs less data.
- **First fix for a big train/val gap?** → Transfer learning + augmentation + weight decay/dropout.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement 2-D convolution from scratch in numpy (with stride and padding) and verify it matches `torch.nn.functional.conv2d` to 1e-5.
- [ ] Compute and annotate the output shape and parameter count of each layer in your `SmallCNN` by hand, then confirm against `torchinfo.summary`.
- [ ] Train `SmallCNN` on CIFAR-10 with and without data augmentation; report the accuracy gap and plot both curves.
- [ ] Fine-tune a pretrained ResNet-50 on a small dataset (Oxford Pets or your own), comparing frozen-backbone vs full fine-tuning accuracy.
- [ ] Use Grad-CAM to visualize what your model attends to on 10 correct and 10 incorrect predictions; write down what you learn.

**Mini Project — An image classifier from scratch to production.**
*Goal:* build, train, and package an image classifier for a real dataset (CIFAR-10, Oxford Pets, or a small custom set) that beats a documented baseline.
*Requirements:* an augmentation pipeline with correct normalization; a from-scratch `Conv-BN-ReLU` CNN *and* a transfer-learning ResNet, compared head to head; AdamW + cosine-with-warmup training with early stopping; evaluation via accuracy, a confusion matrix, and per-class F1; and a `predict(image)` function that loads the best checkpoint with `weights_only=True` and returns top-3 labels with probabilities.
*Extensions:* add Grad-CAM explanations to the prediction output; quantize the model to int8 and measure the size/latency/accuracy trade-off; export to ONNX and benchmark inference; add test-time augmentation; swap in a small ViT (or ConvNeXt-Tiny) and compare accuracy and training data efficiency.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Training Deep Nets* (chapter 17 — the optimizers, schedules, and normalization these networks are trained with), *Transformers & Attention* (the mechanism behind the Vision Transformer), *Backpropagation & Autograd* (how conv gradients are computed), *Transfer Learning & Fine-Tuning*, and *Model Deployment & Inference Optimization* (quantization, ONNX, serving).

**Free Learning Resources**
- **CS231n: Convolutional Neural Networks for Visual Recognition** — Stanford (Li, Karpathy, Johnson) · *Intermediate* · the definitive course on CNNs, from convolution arithmetic to architectures. <https://cs231n.github.io/>
- **Deep Residual Learning for Image Recognition (ResNet)** — He et al., arXiv 1512.03385 · *Advanced* · the paper that introduced skip connections and trained 152 layers. <https://arxiv.org/abs/1512.03385>
- **An Image is Worth 16×16 Words (Vision Transformer)** — Dosovitskiy et al., arXiv 2010.11929 · *Advanced* · the ViT paper — patch embeddings and attention for images. <https://arxiv.org/abs/2010.11929>
- **Feature Visualization** — Olah, Mordvintsev, Schubert (Distill) · *Intermediate* · a beautiful interactive look at what CNN filters actually learn. <https://distill.pub/2017/feature-visualization/>
- **PyTorch Transfer Learning Tutorial** — PyTorch docs · *Beginner* · hands-on freezing and fine-tuning a pretrained CNN. <https://pytorch.org/tutorials/beginner/transfer_learning_tutorial.html>
- **torchvision Models & Weights** — PyTorch docs · *Beginner* · the pretrained model zoo and the `weights.transforms()` preprocessing API. <https://pytorch.org/vision/stable/models.html>
- **Practical Deep Learning for Coders** — fast.ai (Jeremy Howard) · *Beginner* · top-down, code-first vision training with best-practice augmentation and fine-tuning. <https://course.fast.ai/>
- **A ConvNet for the 2020s (ConvNeXt)** — Liu et al., arXiv 2201.03545 · *Advanced* · how a modernized pure CNN matches Vision Transformers. <https://arxiv.org/abs/2201.03545>

---

*AI Engineering Handbook — chapter 18.*
