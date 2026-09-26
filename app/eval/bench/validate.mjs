/**
 * Checks a model name before any GPU is rented for it.
 *
 * A name is either a profile in models/ (by its name or its Hugging Face id)
 * or a Hugging Face repository. For a repository it checks what can be known
 * without downloading anything: that it exists, that it is not gated (the pod
 * has no Hugging Face token), that it has safetensors weights (what vLLM
 * loads), that it generates text, and how much memory its weights take, which
 * decides the cards it fits on.
 *
 * What it cannot check is whether this vLLM supports the architecture or
 * serves the model well. That is what `--quick` is for.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BYTES = { F64: 8, I64: 8, F32: 4, I32: 4, U32: 4, BF16: 2, F16: 2, I16: 2, U16: 2, F8_E4M3: 1, F8_E5M2: 1, F8_E8M0: 1, I8: 1, U8: 1, BOOL: 1 };
const TEXT = new Set(['text-generation', 'image-text-to-text', 'any-to-any', 'conversational']);
// Room beside the weights for the KV cache at the benchmark's context and
// batch, CUDA graphs and activations. Generous on purpose: a card that is too
// small fails at start-up, and that start-up is paid for.
const OVERHEAD_GB = 6;
const USABLE = 0.9;

export async function profiles() {
  const dir = path.join(here, 'models');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}

async function huggingFace(id) {
  // blobs=true lists every file with its size: the weights' true size on disk,
  // which a count of parameters gets wrong for packed formats such as MXFP4.
  const response = await fetch(`https://huggingface.co/api/models/${id}?blobs=true`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status}`);
  return response.json();
}

/** Resolves and checks a model name. Never throws for a bad name: it says why. */
export async function validateModel(input) {
  const name = String(input ?? '').trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/+$/, '');
  const fail = (reason) => ({ ok: false, input: name, reason });
  if (!name) return fail('Enter a model: a Hugging Face id such as openai/gpt-oss-20b, or a profile name.');
  if (name.length > 120) return fail('That name is too long to be a model id.');

  const known = (await profiles()).find((p) => p.name === name || p.hf?.toLowerCase() === name.toLowerCase());
  const id = known?.hf ?? name;
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(id)) return fail('A Hugging Face id looks like organisation/model, for example Qwen/Qwen3.8-27B-FP8.');

  let info;
  try {
    info = await huggingFace(id);
  } catch (error) {
    return fail(`Could not reach Hugging Face to check it: ${error.message}.`);
  }
  if (!info) return fail(`No public model called ${id} on Hugging Face. Check the spelling and capitals.`);
  if (info.gated) return fail(`${info.id} is gated: it needs an accepted licence and a Hugging Face token, which the GPU pod does not have.`);
  if (info.private) return fail(`${info.id} is private.`);
  const tensors = info.safetensors?.parameters;
  if (!tensors || !Object.keys(tensors).length) return fail(`${info.id} has no safetensors weights, which vLLM needs. A GGUF-only repository cannot be served this way.`);
  if (info.pipeline_tag && !TEXT.has(info.pipeline_tag)) return fail(`${info.id} is a model for ${info.pipeline_tag.replaceAll('-', ' ')}, not one that writes text.`);

  const unknown = Object.keys(tensors).filter((t) => !(t in BYTES));
  // Some repositories ship the weights twice: Hugging Face shards and a
  // `consolidated` copy in the vendor's own layout. vLLM loads one of them,
  // so count the shards when both are there.
  const weightFiles = (info.siblings ?? []).filter((f) => f.rfilename.endsWith('.safetensors') && !f.rfilename.includes('/'));
  const shards = weightFiles.filter((f) => !/^consolidated/.test(f.rfilename));
  const fileBytes = (shards.length ? shards : weightFiles).reduce((n, f) => n + (f.size ?? 0), 0);
  const bytes = fileBytes || Object.entries(tensors).reduce((n, [dtype, count]) => n + count * (BYTES[dtype] ?? 2), 0);
  const weightsGb = Math.round((bytes / 1e9) * 10) / 10;
  const warnings = [];
  if (unknown.length && !fileBytes) warnings.push(`Unfamiliar weight types (${unknown.join(', ')}); the size is an estimate.`);
  if (known?.about && /NOT USABLE/i.test(known.about)) warnings.push(known.about);
  if (!known) warnings.push('No profile for this model: it runs with default vLLM settings. Try a quick test first.');

  return {
    ok: true,
    input: name,
    model: info.id,
    profile: known?.name ?? null,
    about: known?.about ?? null,
    cards: known?.cards ?? [],
    params_b: Math.round(((info.safetensors.total ?? 0) / 1e9) * 10) / 10,
    weights_gb: weightsGb,
    need_gb: Math.ceil(weightsGb + OVERHEAD_GB),
    dtypes: Object.keys(tensors),
    // FP8 weights need a card with FP8 in hardware (Ada, Hopper, Blackwell).
    // On Ampere vLLM falls back to a slower path, and for Ministral 3 its
    // compiler failed outright on an A40.
    fp8: Object.keys(tensors).some((t) => t.startsWith('F8')),
    architecture: info.config?.architectures?.[0] ?? null,
    pipeline: info.pipeline_tag ?? null,
    license: info.cardData?.license ?? null,
    warnings,
  };
}

/** Whether a card has room for a validated model. */
export const fits = (model, memoryGb) => model.need_gb <= memoryGb * USABLE;

/** Ampere cards: no FP8 in hardware. Matched by RunPod's names for them. */
export const isAmpere = (gpuName) => /^(A10|A30|A40|A100|RTX A\d+|RTX 30\d0)\b/.test(String(gpuName).replace(/^NVIDIA (GeForce )?/, ''));
export const suits = (model, gpu) => fits(model, gpu.memory_gb) && !(model.fp8 && isAmpere(gpu.name));
