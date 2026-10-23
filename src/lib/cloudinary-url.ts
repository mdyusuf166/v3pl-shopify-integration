/** Client-safe Cloudinary URL helper (no secrets). */
export function optimizedImageUrl(url: string, width = 600): string {
  return url.replace("/image/upload/", `/image/upload/f_auto,q_auto,w_${width},c_limit/`);
}
