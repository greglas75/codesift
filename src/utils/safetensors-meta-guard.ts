// Validation guard for a single safetensors tensor-meta entry.
// Extracted from safetensors-loader.ts to keep that file ≤100 executable lines.

export interface RawTensorMeta {
  dtype: string;
  shape: number[];
  data_offsets: [number, number];
}

export function isValidMeta(key: string, value: unknown): RawTensorMeta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `safetensors: tensor meta for "${key}" must be a non-null object`,
    );
  }

  const v = value as Record<string, unknown>;

  if (typeof v["dtype"] !== "string") {
    throw new Error(
      `safetensors: tensor "${key}" meta.dtype must be a string`,
    );
  }

  const shape = v["shape"];
  if (
    !Array.isArray(shape) ||
    shape.length !== 2 ||
    typeof shape[0] !== "number" ||
    typeof shape[1] !== "number"
  ) {
    throw new Error(
      `safetensors: tensor "${key}" meta.shape must be a 2-element array of numbers`,
    );
  }

  // CRITICAL-2: reject NaN, Infinity, and non-integer floats in shape
  if (!Number.isInteger(shape[0]) || shape[0] < 0 || !Number.isInteger(shape[1]) || shape[1] < 0) {
    throw new Error(
      `safetensors: tensor "${key}" meta.shape must be integers >= 0`,
    );
  }

  const offsets = v["data_offsets"];
  if (
    !Array.isArray(offsets) ||
    offsets.length !== 2 ||
    typeof offsets[0] !== "number" ||
    typeof offsets[1] !== "number"
  ) {
    throw new Error(
      `safetensors: tensor "${key}" meta.data_offsets must be a 2-element array of numbers`,
    );
  }

  // CRITICAL-2 / FINDING-3: reject NaN, Infinity, non-integer floats, and
  // unsafe integers (> Number.MAX_SAFE_INTEGER) in data_offsets.
  // isSafeInteger subsumes isInteger: it rejects NaN, Infinity, floats, AND
  // values outside ±2^53-1 where integer arithmetic loses precision.
  if (
    !(Number.isSafeInteger(offsets[0]) && (offsets[0] as number) >= 0) ||
    !(Number.isSafeInteger(offsets[1]) && (offsets[1] as number) >= 0)
  ) {
    throw new Error(
      `safetensors: tensor "${key}" meta.data_offsets must be integers >= 0`,
    );
  }

  const [offsetStart, offsetEnd] = offsets as [number, number];

  if (offsetStart < 0) {
    throw new Error(
      `safetensors: tensor "${key}" data_offsets[${offsetStart}, ${offsetEnd}]: offsetStart must be >= 0`,
    );
  }

  if (offsetEnd < offsetStart) {
    throw new Error(
      `safetensors: tensor "${key}" data_offsets[${offsetStart}, ${offsetEnd}]: offsetEnd must be >= offsetStart`,
    );
  }

  return {
    dtype: v["dtype"] as string,
    shape: shape as number[],
    data_offsets: [offsetStart, offsetEnd],
  };
}
