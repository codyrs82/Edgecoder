# Distilled Model Pipeline — Implementation Plan

## Overview

Replace the deterministic `EdgeCoderLocalProvider` stub with a real sub-1B parameter model distilled from a strong teacher, optimized to produce executor-safe Python and JavaScript for on-device plan/code/test/iterate loops. The distilled model must generate code that passes the existing AST validators (`ast-python.ts`, `ast-javascript.ts`) and regex denylists (`subset.ts`) so that outputs land inside the executor's safe subset without cloud escalation.

This document covers teacher selection, training data strategy, distillation methodology, target export formats, benchmarking, integration into the provider layer, and estimated compute and timeline.

---

## 1. Teacher Model Selection

The teacher produces high-quality code completions that the student learns to approximate. Selection criteria: strong coding benchmarks, permissive license for distillation, and demonstrated quality on the executor-safe subset (no `exec`, `eval`, `open`, `import os`, etc.).

### Candidates

| Model | Params | License | HumanEval pass@1 | Notes |
|-------|--------|---------|-------------------|-------|
| **Qwen2.5-Coder 7B Instruct** | 7B | Apache 2.0 | ~84% | Already the default `ollama-local` model in `ProviderRegistry`. Proven compatible with existing prompt templates. Strong on Python and JS. Lowest integration risk. |
| **DeepSeek-Coder-V2-Lite-Instruct** | 16B (2.4B active MoE) | MIT | ~82% | MoE architecture means fast inference despite headline param count. Good at structured code. Larger effective capacity for richer distillation signal. |
| **StarCoder2 7B** | 7B | BigCode OpenRAIL-M | ~75% | Trained on The Stack v2. Strong multi-language coverage. License permits distillation with attribution. |
| **CodeLlama 7B Instruct** | 7B | Llama 2 Community | ~72% | Solid baseline. Llama 2 license restricts commercial use above 700M MAU; acceptable for early-stage. |

### Recommendation

**Primary teacher: Qwen2.5-Coder 7B Instruct.** Rationale:

1. Already validated end-to-end with the existing `OllamaLocalProvider` and prompt templates (`planPrompt`, `codePrompt`, `reflectPrompt`, `decomposePrompt`).
2. Apache 2.0 license imposes no restrictions on distillation or distribution.
3. Highest HumanEval score among candidates.
4. Native instruction-following format aligns with the "Output ONLY executable code" prompt pattern.

**Secondary teacher (ensemble distillation, Phase 2): DeepSeek-Coder-V2-Lite-Instruct.** Adding a second teacher's logits during distillation reduces over-fitting to a single teacher's quirks and broadens coverage. The MoE architecture makes inference tractable for large-scale data generation.

---

## 2. Training Data Strategy

### 2.1 Executor-Safe Subset Alignment

The model must learn to produce code that passes `checkSubset()` from `src/executor/subset.ts`. This means:

**Python — must stay within `ALLOWED_NODE_TYPES` in `ast-python.ts`:**
- Allowed: `Module`, `FunctionDef`, `Return`, `Assign`, `AugAssign`, `For`, `While`, `If`, `Expr`, `Call`, `BinOp`, `UnaryOp`, `Compare`, `BoolOp`, `Num`, `Str`, `List`, `Dict`, `Tuple`, `Set`, `Name`, `Subscript`, `Attribute`, `ListComp`, `DictComp`, `SetComp`, `FormattedValue`, `JoinedStr`, `Index`, `Slice`, `Constant`, `Pass`, `Break`, `Continue`, `Lambda`, `IfExp`, `GeneratorExp`, `Starred`, plus operator/keyword/comprehension nodes.
- Blocked AST nodes (implicitly): `Import`, `ImportFrom`, `ClassDef`, `AsyncFunctionDef`, `AsyncFor`, `AsyncWith`, `Await`, `Try`, `TryStar`, `ExceptHandler`, `With`, `Raise`, `Assert`, `Delete`, `Global`, `Nonlocal`, `Yield`, `YieldFrom`, decorators.
- Blocked builtins (`BLOCKED_BUILTINS`): `open`, `exec`, `eval`, `compile`, `__import__`, `globals`, `locals`, `getattr`, `setattr`, `delattr`, `vars`, `dir`, `input`, `breakpoint`, `memoryview`, `bytearray`.
- Blocked by regex denylist (`PYTHON_DENYLIST`): `exec(`, `eval(`, `compile(`, `__import__`, `import os`, `import subprocess`, `open(`, `socket`.

**JavaScript — must stay within `ALLOWED_NODE_TYPES` in `ast-javascript.ts`:**
- Allowed: `Program`, `FunctionDeclaration`, `VariableDeclaration`, `VariableDeclarator`, `ExpressionStatement`, `ReturnStatement`, `IfStatement`, `ForStatement`, `ForInStatement`, `ForOfStatement`, `WhileStatement`, `DoWhileStatement`, `BlockStatement`, `EmptyStatement`, `BreakStatement`, `ContinueStatement`, `SwitchStatement`, `SwitchCase`, `ArrayExpression`, `ObjectExpression`, `BinaryExpression`, `UnaryExpression`, `CallExpression`, `ArrowFunctionExpression`, `FunctionExpression`, `Literal`, `Identifier`, `MemberExpression`, `TemplateLiteral`, `TemplateElement`, `TaggedTemplateExpression`, `ConditionalExpression`, `LogicalExpression`, `AssignmentExpression`, `UpdateExpression`, `SpreadElement`, `Property`, `RestElement`, `ArrayPattern`, `ObjectPattern`, `AssignmentPattern`, `SequenceExpression`, `ChainExpression`, `ParenthesizedExpression`, `LabeledStatement`.
- Blocked AST nodes (implicitly): `ClassDeclaration`, `ClassExpression`, `ImportDeclaration`, `ExportNamedDeclaration`, `ExportDefaultDeclaration`, `AwaitExpression`, `YieldExpression`, `TryStatement`, `CatchClause`, `ThrowStatement`, `NewExpression`, `ThisExpression`, `MetaProperty`.
- Blocked globals (`BLOCKED_GLOBALS`): `process`, `require`, `globalThis`, `eval`, `Function`, `Proxy`, `Reflect`.
- Blocked by regex denylist (`JS_DENYLIST`): `eval(`, `Function(`, `require(`, `process.`, `fs.`, `child_process`.

### 2.2 Data Sources

| Source | Purpose | Estimated Size |
|--------|---------|----------------|
| **Teacher-generated subset corpus** | Run Qwen2.5-Coder 7B on ~50K coding prompts (HumanEval, MBPP, APPS, CodeContests, LeetCode-style) and filter outputs through `checkSubset()`. Keep only passing samples. | ~30-40K passing samples after filtering |
| **The Stack v2 (filtered)** | Mine Python and JS files from The Stack v2. Parse each through the AST validators. Keep files where 100% of functions individually pass subset check. | ~500K-1M functions |
| **Synthetic plan/code/reflect triples** | Use teacher to generate (plan, code, reflection) triples matching `planPrompt`, `codePrompt`, `reflectPrompt` formats. Ensures the student learns the full agent loop, not just code completion. | ~20K triples |
| **Executor feedback data** | Run teacher-generated code through `runCode()`. Capture (code, RunResult) pairs. Include both passing and failing examples with the reflection prompt for self-correction training. | ~15K (code, result, corrected-code) triples |

### 2.3 Data Pipeline

```
[Raw source] --> [AST filter: checkSubset()] --> [Teacher inference: generate logits] --> [Format: prompt + completion + soft labels] --> [Training dataset]
```

Steps:

1. **Collect prompts**: Aggregate from HumanEval, MBPP, APPS, natural-language coding requests.
2. **Teacher generation**: For each prompt, run teacher with `codePrompt()` format. Collect top-k completions.
3. **Subset filtering**: Pass each completion through `checkSubset("python", code)` and `checkSubset("javascript", code)`. Discard failures. Log rejection reasons for analysis.
4. **Executor validation**: Run passing code through `runCode()`. Tag samples as `{passed: true/false, stdout, stderr}`.
5. **Reflection pairs**: For failed samples, run `reflectPrompt(task, code, error)` through teacher. Filter corrected code through subset check again.
6. **Format**: Convert to instruction-tuning format with soft labels (teacher logits at temperature T) for knowledge distillation.

### 2.4 Data Quality Controls

- **Deduplication**: MinHash + Jaccard similarity dedup at function level.
- **Toxicity/PII filter**: Remove samples containing API keys, emails, or known PII patterns.
- **Subset compliance rate target**: 100% of training completions must pass `checkSubset()`. Any sample that fails is discarded, not corrected.
- **Balanced language split**: Target 60% Python / 40% JavaScript, reflecting typical user distribution.

---

## 3. Distillation Approach

### 3.1 Student Architecture

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Architecture** | Decoder-only transformer (Qwen2 family) | Matches teacher architecture for direct logit-level KD. Reuse tokenizer. |
| **Target size** | 500M parameters | Sweet spot for sub-1B: small enough for phones (4-bit = ~250MB), large enough for reasonable code quality. |
| **Context window** | 2048 tokens | Matches EDGECODER_PLAN.md Section 7 ("2K-4K tokens"). Keeps KV cache small on edge. |
| **Vocabulary** | Reuse Qwen2.5-Coder tokenizer (151K vocab) | Avoids tokenizer mismatch. Good code token coverage. |
| **Attention** | Grouped-Query Attention (GQA), 8 KV heads | Reduces memory for KV cache on mobile. |
| **Intermediate size** | ~1536 | Scaled down proportionally from 7B teacher. |
| **Layers** | 24 | Enough depth for code reasoning; keeps param count under 500M. |

### 3.2 Knowledge Distillation

**Method: Two-stage distillation.**

**Stage 1 — Logit-level KD (pre-training phase):**

- Loss: `L = alpha * L_CE(student, ground_truth) + (1 - alpha) * L_KL(student_logits/T, teacher_logits/T)`
- Temperature T = 2.0 (softens teacher distribution to reveal inter-token relationships).
- Alpha = 0.5 (equal weight on hard labels and soft labels).
- Dataset: The Stack v2 filtered corpus (~500K-1M functions).
- Objective: Transfer the teacher's general code understanding to the student.
- Framework: `torchtune` (referenced in EDGECODER_PLAN.md Section 5) or HuggingFace Transformers + custom KD trainer.

**Stage 2 — Task-specific fine-tuning with KD:**

- Same KD loss but on the EdgeCoder-specific dataset (plan/code/reflect triples, executor feedback data).
- Lower learning rate (1e-5 vs 3e-4 in Stage 1).
- Focus on the three prompt formats: `planPrompt`, `codePrompt`, `reflectPrompt`.
- Add a **subset compliance reward**: during training, periodically run `checkSubset()` on sampled outputs and log compliance rate. Use this as an offline metric (not a training signal directly) to monitor whether the student is staying in-subset.

### 3.3 Structured Pruning (Optional, Post-Distillation)

If the 500M student is still too large for target devices:

- **Width pruning**: Remove attention heads with lowest importance scores (measured by gradient-based attribution).
- **Layer pruning**: Remove layers with highest cosine similarity between input and output (redundant layers).
- **Target**: Reduce to ~350M if needed for phones.
- **Tool**: `torch.nn.utils.prune` or LLM-Pruner.
- **Validation**: Re-run subset compliance and HumanEval after pruning. Accept only if HumanEval pass@1 drops less than 5 percentage points.

### 3.4 Quantization

Apply post-training quantization for each target runtime:

| Format | Quantization | Tool | Target Size (500M model) | Primary Target |
|--------|-------------|------|-------------------------|----------------|
| **GGUF** | Q4_K_M (4-bit mixed) | llama.cpp `quantize` | ~280MB | Ollama, llama.cpp on laptops/desktops |
| **GGUF** | Q4_0 (4-bit) | llama.cpp `quantize` | ~250MB | Raspberry Pi, low-RAM devices |
| **MLX** | 4-bit | `mlx-lm` quantize | ~280MB | Apple Silicon (M1/M2/M3/M4) |
| **ONNX** | INT8 dynamic | `optimum` + ONNX Runtime | ~500MB | Cross-platform (Windows/Linux x86) |
| **ONNX** | INT4 (QLoRA-style) | `optimum` + ORT GenAI | ~280MB | Cross-platform, smaller footprint |
| **TFLite** | INT8 | TensorFlow Lite converter | ~500MB | Android phones |
| **Core ML** | 4-bit palettized | `coremltools` | ~280MB | iOS (iPhone 14+, iPad) |

### 3.5 Quantization Validation

Every quantized variant must pass:
1. **Subset compliance**: Run 500 sample prompts through the quantized model, filter outputs through `checkSubset()`. Target: >= 95% compliance (remaining 5% caught at runtime by existing subset check and queued for cloud).
2. **HumanEval pass@1**: Must be within 10 percentage points of the unquantized student.
3. **Latency**: First-token latency measured on target device class (see Section 5).

---

## 4. Target Formats and Runtimes

### 4.1 Format Matrix

| Format | Runtime | Platform | Integration | Priority |
|--------|---------|----------|-------------|----------|
| **GGUF** | llama.cpp / Ollama | macOS, Linux, Windows | Drop-in via existing `OllamaLocalProvider` or direct llama.cpp binding | P0 |
| **MLX** | MLX framework | macOS (Apple Silicon) | New `MLXProvider` class implementing `ModelProvider` | P0 |
| **ONNX** | ONNX Runtime | Windows, Linux, macOS (x86) | New `ONNXProvider` class implementing `ModelProvider` | P1 |
| **TFLite** | TensorFlow Lite | Android | Via mobile app runtime (separate from Node.js agent) | P2 |
| **Core ML** | Core ML | iOS | Via iOS app runtime (`ios/` directory) | P2 |

### 4.2 Export Pipeline

```
[PyTorch checkpoint]
    |
    +--> convert_hf_to_gguf.py --> GGUF (F16) --> llama.cpp quantize --> GGUF Q4_K_M, Q4_0
    |
    +--> mlx-lm convert + quantize --> MLX 4-bit
    |
    +--> optimum-cli export onnx --> ONNX FP32 --> onnxruntime quantize --> ONNX INT8, INT4
    |
    +--> tf-lite converter (via ONNX->TF->TFLite or direct) --> TFLite INT8
    |
    +--> coremltools convert --> Core ML 4-bit palettized
```

### 4.3 Runtime Wrappers

Each runtime wrapper implements `ModelProvider` from `src/model/providers.ts`:

```typescript
// New provider kind additions needed in providers.ts
export type ModelProviderKind =
  | "edgecoder-local"    // Distilled model via native runtime
  | "edgecoder-mlx"      // Distilled model via MLX (Apple Silicon)
  | "edgecoder-onnx"     // Distilled model via ONNX Runtime
  | "ollama-local"       // Existing Ollama provider
  | "ollama-edge"        // Existing Ollama edge provider
  | "ollama-coordinator"; // Existing Ollama coordinator provider
```

The `edgecoder-local` provider kind is reused but the implementation changes from the stub to a real inference backend. The GGUF path can work through Ollama (register the custom model as an Ollama modelfile) or through a direct llama.cpp binding (e.g., `node-llama-cpp` npm package).

---

## 5. Benchmarking Criteria

### 5.1 Code Quality Benchmarks

| Benchmark | Metric | Student Target | Teacher Baseline (Qwen2.5 7B) |
|-----------|--------|----------------|-------------------------------|
| **HumanEval** | pass@1 | >= 45% | ~84% |
| **HumanEval** | pass@10 | >= 65% | ~92% |
| **MBPP** | pass@1 | >= 50% | ~80% |
| **EdgeCoder-Eval** (custom) | subset-safe pass@1 | >= 60% | ~75% (not all teacher output is in-subset) |

**EdgeCoder-Eval** is a new benchmark (referenced in EDGECODER_PLAN.md Section 11): HumanEval and MBPP problems filtered to only those solvable within the executor subset. Solutions must pass both `checkSubset()` and `runCode()`. This is the primary quality metric.

### 5.2 Subset Compliance

| Metric | Target |
|--------|--------|
| % of generated code passing `checkSubset()` | >= 95% |
| % of subset-passing code that also passes `runCode()` | >= 70% |
| Mean iterations to passing code (using reflect loop) | <= 2.5 |

### 5.3 Latency Benchmarks

| Device Class | Device Example | Format | First Token Target | Tokens/sec Target |
|-------------|----------------|--------|-------------------|-------------------|
| **Laptop (Apple Silicon)** | M1 MacBook Air, 8GB | MLX 4-bit | < 500ms | >= 30 tok/s |
| **Laptop (x86)** | Intel i7-12th gen, 16GB | ONNX INT8 | < 1.5s | >= 15 tok/s |
| **Desktop (GPU)** | RTX 3060, 12GB | GGUF Q4_K_M | < 300ms | >= 50 tok/s |
| **Phone (iOS)** | iPhone 14 | Core ML 4-bit | < 1.5s | >= 10 tok/s |
| **Phone (Android)** | Pixel 7 | TFLite INT8 | < 2.0s | >= 8 tok/s |
| **Edge (ARM)** | Raspberry Pi 5, 8GB | GGUF Q4_0 | < 3.0s | >= 5 tok/s |

These align with EDGECODER_PLAN.md Section 12 targets: "First token < 500ms on iPhone 14 / M1" and Section 17 KPIs: "Interactive p50 first token <= 1.5s, p95 <= 3.0s."

### 5.4 Resource Consumption

| Metric | Target |
|--------|--------|
| Peak RAM (4-bit model loaded) | < 1GB |
| Disk footprint (model file) | < 300MB |
| Battery drain (10-min session, iPhone 14) | < 5% |
| Battery drain (10-min session, M1 laptop) | < 3% |

### 5.5 Benchmark Automation

Add to `eval/` directory (per EDGECODER_PLAN.md Section 11):
- `eval/humaneval.ts` — Run HumanEval through provider, filter through subset check, execute via `runCode()`.
- `eval/mbpp.ts` — Same pipeline for MBPP.
- `eval/edgecoder-eval.ts` — Custom subset-safe benchmark.
- `eval/latency.ts` — Measure first-token and throughput on local device.
- `eval/subset-compliance.ts` — Batch-run prompts and measure `checkSubset()` pass rate.

---

## 6. Integration into EdgeCoderLocalProvider

### 6.1 Current State

`EdgeCoderLocalProvider` in `src/model/providers.ts` (lines 25-120) is a deterministic stub. It pattern-matches against `planPrompt()`, `codePrompt()`, and `reflectPrompt()` formats and returns hardcoded responses. `health()` always returns `true`.

### 6.2 Target State

Replace the stub with a real inference backend while maintaining the same `ModelProvider` interface:

```typescript
export class EdgeCoderLocalProvider implements ModelProvider {
  readonly kind: ModelProviderKind = "edgecoder-local";
  private runtime: InferenceRuntime; // llama.cpp, MLX, or ONNX binding

  constructor(modelPath: string, runtimeType: "gguf" | "mlx" | "onnx") {
    this.runtime = createRuntime(runtimeType, modelPath);
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const text = await this.runtime.complete(req.prompt, {
      maxTokens: req.maxTokens ?? 512,
      temperature: 0.2,  // Low temperature for deterministic code
      stopTokens: ["```", "\n\n\n"]  // Prevent runaway generation
    });
    return { text, provider: this.kind };
  }

  async health(): Promise<boolean> {
    return this.runtime.isLoaded();
  }
}
```

### 6.3 Migration Path

1. **Phase A — Dual mode**: Add a `useDistilledModel` flag (from `LocalModelManifest` in types.ts). When false, fall back to current stub behavior. When true, load the distilled model.
2. **Phase B — Default flip**: Once EdgeCoder-Eval scores meet targets, flip the default to distilled model. Keep stub as `EdgeCoderStubProvider` for testing.
3. **Phase C — Remove stub**: After validation on all target OS (Debian, Ubuntu, Windows, macOS per EDGECODER_PLAN.md Section 9).

### 6.4 Model Loading and Lifecycle

- **Model discovery**: Check `~/.edgecoder/models/` for downloaded GGUF/MLX/ONNX files. Cross-reference with `LocalModelManifest` (from `src/common/types.ts` lines 82-88) for checksum and signature verification.
- **Lazy loading**: Do not load model into memory until first `generate()` call. Unload after configurable idle timeout (default 5 minutes) to free RAM.
- **Hot swap**: Support `ProviderRegistry.use()` to switch between distilled model, Ollama, and stub at runtime without restart. Already supported by the existing registry pattern.
- **Ollama fallback**: If the GGUF model is registered as an Ollama modelfile, the existing `OllamaLocalProvider` can serve it with zero code changes. This provides a zero-risk integration path while native bindings are built.

### 6.5 Prompt Compatibility

The distilled model must handle all four prompt formats from `src/model/prompts.ts`:

| Prompt Function | System Prefix | Expected Output |
|----------------|---------------|-----------------|
| `planPrompt(task)` | "You are a coding assistant. Create a step-by-step plan..." | Numbered steps only |
| `codePrompt(task, plan, language)` | "You are a coding assistant. Write {language} code..." | Executable code only, no markdown fences |
| `reflectPrompt(task, code, error)` | "You are a coding assistant. The following code failed..." | Fixed executable code only |
| `decomposePrompt(task)` | "You are a task decomposition assistant..." | JSON array of subtasks |

Training data must include examples of all four formats. The `decomposePrompt` format is lower priority (EDGECODER_PLAN.md says decomposition uses a larger model), but including some examples ensures the student can handle simple decompositions locally.

---

## 7. Compute Requirements and Timeline

### 7.1 Compute Estimate

*[Internal cost estimates redacted for public release]*

### 7.2 Timeline

*[Internal timeline redacted for public release]*

### 7.3 Staffing

*[Internal staffing details redacted for public release]*

---

## 8. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 500M student quality too low for useful code | Medium | High | Fall back to 800M-1B student. Increase training data. Add ensemble teacher (DeepSeek). The sub-1B constraint is a ceiling, not a floor. |
| Quantized model degrades subset compliance | Medium | Medium | Quantization-aware training (QAT) instead of post-training quantization. Test compliance at every quantization level. |
| MLX or ONNX runtime crashes on specific devices | Low | Medium | Ollama/GGUF path as universal fallback. GGUF works everywhere llama.cpp compiles. |
| Training data contamination (HumanEval in training set) | Low | High | Decontaminate: remove any exact or near-exact matches to HumanEval/MBPP problems from training data. Use n-gram overlap detection. |
| Model generates plausible but unsafe code (passes subset but has logic bugs) | High | Low | Existing executor catches runtime errors. The reflect loop (`reflectPrompt`) handles iterative correction. Cloud escalation is the backstop. |
| Tokenizer mismatch if student uses different architecture than teacher | Low | Medium | Mitigated by using Qwen2 family for both teacher and student, sharing the tokenizer. |

---

## 9. Success Criteria

The distilled model pipeline is considered complete when:

1. EdgeCoder-Eval pass@1 >= 60% (subset-safe code that executes correctly).
2. Subset compliance >= 95% (generated code passes `checkSubset()` without modification).
3. First-token latency < 500ms on M1 MacBook Air (MLX 4-bit).
4. First-token latency < 1.5s on iPhone 14 (Core ML 4-bit).
5. Model file size < 300MB (4-bit quantized).
6. Peak RAM < 1GB during inference.
7. All four prompt formats (`planPrompt`, `codePrompt`, `reflectPrompt`, `decomposePrompt`) produce well-formed outputs.
8. `EdgeCoderLocalProvider` passes existing test suite with real model (not stub).
9. Model loads and runs on macOS, Ubuntu, Windows, and Debian (per EDGECODER_PLAN.md Section 9).
10. Signed model manifest (`LocalModelManifest`) with valid checksum published to approved source.

---

## 10. File and Directory Layout

New files and directories to be created:

```
model/
  distillation/
    config.yaml              # Training hyperparameters, KD settings
    data_pipeline.py         # AST filter + teacher inference + dataset builder
    train_stage1.py          # Stage 1 logit-level KD
    train_stage2.py          # Stage 2 task-specific fine-tuning
    export_gguf.sh           # PyTorch -> GGUF conversion + quantization
    export_mlx.sh            # PyTorch -> MLX conversion + quantization
    export_onnx.sh           # PyTorch -> ONNX conversion + quantization
    export_tflite.sh         # PyTorch -> TFLite conversion
    export_coreml.sh         # PyTorch -> Core ML conversion
    subset_filter.py         # Standalone AST filter matching TypeScript validators
  evaluation/
    humaneval_runner.py       # HumanEval benchmark with subset filtering
    edgecoder_eval.py         # Custom subset-safe benchmark

runtimes/
  llama-cpp/                 # llama.cpp Node.js bindings wrapper
  mlx/                       # MLX Python bridge (called from Node via child_process or FFI)
  onnx/                      # ONNX Runtime Node.js wrapper

src/model/
  providers.ts               # Updated: EdgeCoderLocalProvider with real inference
  inference-runtime.ts       # New: InferenceRuntime interface and factory

eval/
  humaneval.ts               # TypeScript harness for HumanEval
  mbpp.ts                    # TypeScript harness for MBPP
  edgecoder-eval.ts          # TypeScript harness for EdgeCoder-Eval
  latency.ts                 # Latency measurement tool
  subset-compliance.ts       # Batch subset compliance checker
```

---

## 11. Open Questions

1. **Student architecture family**: Should the student be Qwen2 (matching teacher) or a more compact architecture like SmolLM2/Phi-3-mini? Qwen2 is recommended for tokenizer compatibility, but Phi-3-mini has demonstrated strong code quality at similar sizes.
2. **Context window**: 2048 tokens is the plan baseline. Should we train with 4096 and truncate at inference time for flexibility?
3. **Ollama-first or native-first**: Registering the GGUF as an Ollama model is zero-effort integration via existing `OllamaLocalProvider`. Building native bindings (node-llama-cpp, MLX bridge) gives more control over memory and lifecycle. Recommendation: Ollama-first for beta, native for GA.
4. **Second teacher timing**: When to add DeepSeek-Coder-V2 as ensemble teacher — during Stage 1 or as a separate Stage 3?
5. **MoE student**: Should we explore a small MoE student (e.g., 2 experts, 250M active) for better quality-per-FLOP? Adds complexity to export pipeline.
