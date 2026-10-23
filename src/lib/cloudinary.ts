import { createHash } from "node:crypto";
import { cloudinaryEnv } from "@/lib/env";

/**
 * Minimal Cloudinary helper (spec §13). No SDK: signed direct uploads from the
 * browser + server-side destroy. The API secret never leaves the server.
 */

export const PRODUCT_IMAGE_FOLDER = "v3pl/products";

function sign(params: Record<string, string | number>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + secret).digest("hex");
}

/** Parameters the browser needs to upload directly to Cloudinary (valid ~1 hour). */
export function signedUploadParams(folder = PRODUCT_IMAGE_FOLDER) {
  const env = cloudinaryEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp };
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    folder,
    timestamp,
    signature: sign(params, env.CLOUDINARY_API_SECRET),
  };
}

/** Delete an asset. Best effort: returns false instead of throwing on API errors. */
export async function destroyImage(publicId: string): Promise<boolean> {
  const env = cloudinaryEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: env.CLOUDINARY_API_KEY,
    signature: sign({ public_id: publicId, timestamp }, env.CLOUDINARY_API_SECRET),
  });
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: "POST", body });
    const json = (await res.json().catch(() => ({}))) as { result?: string };
    return res.ok && (json.result === "ok" || json.result === "not found");
  } catch {
    return false;
  }
}

/** Optimised delivery URL (auto format/quality, bounded width). */
export function optimizedImageUrl(url: string, width = 600): string {
  return url.replace("/image/upload/", `/image/upload/f_auto,q_auto,w_${width},c_limit/`);
}
