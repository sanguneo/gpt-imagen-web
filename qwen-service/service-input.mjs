const MAX_REF = 12 * 1024 * 1024;
const MAX_REFS = 64 * 1024 * 1024;
export const MAX_BODY = MAX_REFS + 1024 * 1024;
export const PNG = Buffer.from("89504e470d0a1a0a", "hex");
export class ServiceError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function parseJob(request) {
  let fields;
  let images = [];
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    for (const key of form.keys()) {
      if (!["prompt", "negative", "size", "seed", "images", "requestId", "mode", "model"].includes(key)) throw new ServiceError("Unknown field", 400);
    }
    fields = {};
    for (const key of ["prompt", "negative", "size", "seed", "requestId", "mode", "model"]) {
      const values = form.getAll(key);
      if (values.length > 1 || values.some((value) => typeof value !== "string")) throw new ServiceError(`Invalid ${key}`, 400);
      if (values.length) fields[key] = values[0];
    }
    images = form.getAll("images");
  } else if (type.startsWith("application/json")) {
    fields = await request.json();
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
      || Object.keys(fields).some((key) => !["prompt", "negative", "size", "seed", "requestId", "mode", "model"].includes(key))) {
      throw new ServiceError("Expected prompt, negative, size and optional seed or mode; JSON does not accept references", 400);
    }
  } else {
    throw new ServiceError("Use multipart/form-data or application/json", 415);
  }
  if (typeof fields.prompt !== "string" || !fields.prompt.trim() || fields.prompt.length > 60000) throw new ServiceError("Invalid prompt (1..60000 characters)", 400);
  if (fields.requestId !== undefined && (typeof fields.requestId !== "string" || !/^[0-9a-f]{20}$/.test(fields.requestId))) throw new ServiceError("Invalid requestId (20 lowercase hex characters)", 400);
  if (fields.mode !== undefined && fields.mode !== "normal" && fields.mode !== "fast") throw new ServiceError("Invalid mode (normal or fast)", 400);
  if (fields.model !== undefined && fields.model !== "qwen-image" && fields.model !== "moss-image") throw new ServiceError("Invalid model (qwen-image or moss-image)", 400);
  if (fields.model === "moss-image" && (images.length || fields.mode === "fast")) throw new ServiceError("MOSS supports text-only normal mode", 400);
  if (fields.negative !== undefined && (typeof fields.negative !== "string" || fields.negative.length > 60000)) throw new ServiceError("Invalid negative", 400);
  if (typeof fields.size !== "string" || !/^\d{3,4}x\d{3,4}$/.test(fields.size)
    || !fields.size.split("x").map(Number).every((n) => n >= 256 && n <= 2048 && n % 32 === 0)) throw new ServiceError("Invalid size", 400);
  let seed = null;
  if (fields.seed !== undefined) {
    if ((typeof fields.seed !== "number" && typeof fields.seed !== "string")
      || (typeof fields.seed === "string" && !/^\d+$/.test(fields.seed))) throw new ServiceError("Invalid seed", 400);
    seed = Number(fields.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new ServiceError("Invalid seed", 400);
  }
  if (images.length > 16) throw new ServiceError("At most 16 images", 400);
  let total = 0;
  const refs = [];
  for (const image of images) {
    if (!(image instanceof File) || image.size === 0 || image.size > MAX_REF) throw new ServiceError("Each image must be 1..12 MiB", 400);
    total += image.size;
    if (total > MAX_REFS) throw new ServiceError("References exceed 64 MiB", 400);
    const bytes = Buffer.from(await image.arrayBuffer());
    const mime = imageType(bytes);
    if (!mime || mime !== image.type) throw new ServiceError("References must be PNG, JPEG, WebP or GIF with matching MIME type", 400);
    refs.push({ bytes, extension: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] });
  }
  return { prompt: fields.prompt, negative: fields.negative ?? "", size: fields.size, seed, refs, requestId: fields.requestId ?? null, mode: fields.mode ?? "normal", model: fields.model ?? "qwen-image" };
}
