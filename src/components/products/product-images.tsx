"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { optimizedImageUrl } from "@/lib/cloudinary-url";
import { addProductImageAction, getUploadSignatureAction, removeProductImageAction } from "@/server/actions/products";

type Image = { id: string; url: string; alt: string | null; width: number | null; height: number | null };

type Props = { productId: string; images: Image[]; canEdit: boolean; uploadsConfigured: boolean };

const MAX_BYTES = 8 * 1024 * 1024;

export function ProductImages({ productId, images, canEdit, uploadsConfigured }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const sig = await getUploadSignatureAction();
      if (!sig.ok) {
        toast.error(sig.error);
        return;
      }
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          toast.error(`${file.name}: not an image`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name}: larger than 8 MB`);
          continue;
        }
        const body = new FormData();
        body.append("file", file);
        body.append("api_key", sig.data.apiKey);
        body.append("timestamp", String(sig.data.timestamp));
        body.append("signature", sig.data.signature);
        body.append("folder", sig.data.folder);
        const res = await fetch(sig.data.uploadUrl, { method: "POST", body });
        const json = (await res.json().catch(() => ({}))) as { public_id?: string; secure_url?: string; width?: number; height?: number; error?: { message?: string } };
        if (!res.ok || !json.public_id || !json.secure_url) {
          toast.error(`${file.name}: upload failed${json.error?.message ? ` — ${json.error.message}` : ""}`);
          continue;
        }
        const saved = await addProductImageAction({ productId, cloudinaryPublicId: json.public_id, url: json.secure_url, width: json.width ?? null, height: json.height ?? null, alt: file.name.replace(/\.[^.]+$/, "") });
        if (!saved.ok) toast.error(`${file.name}: ${saved.error}`);
      }
      toast.success("Images uploaded");
      router.refresh();
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(imageId: string) {
    startTransition(async () => {
      const res = await removeProductImageAction(imageId);
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images</CardTitle>
        <CardDescription>{uploadsConfigured ? "Stored in Cloudinary, optimised on delivery." : "Image uploads are not configured for this environment."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No images yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((img) => (
              <figure key={img.id} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={optimizedImageUrl(img.url, 400)} alt={img.alt ?? ""} className="size-full object-cover" loading="lazy" />
                {canEdit && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-xs"
                    aria-label="Remove image"
                    className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                    disabled={pending}
                    onClick={() => remove(img.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </figure>
            ))}
          </div>
        )}
        {canEdit && uploadsConfigured && (
          <div>
            <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              {uploading ? "Uploading…" : "Add images"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
