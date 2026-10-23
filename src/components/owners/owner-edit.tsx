import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { OwnerType } from "@/generated/prisma/client";
import { PageHeader } from "@/components/layout/page-header";
import { OwnerForm } from "@/components/owners/owner-form";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { getOwner } from "@/server/services/owners";

export async function OwnerEdit({ type, id }: { type: OwnerType; id: string }) {
  const meta = OWNER_TYPE_META[type];
  const owner = await getOwner(id, type);
  if (!owner) notFound();

  return (
    <>
      <div>
        <Link href={`${meta.basePath}/${owner.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {owner.businessName}
        </Link>
      </div>
      <PageHeader title={`Edit ${meta.singular.toLowerCase()}`} description={owner.businessName} />
      <div className="max-w-3xl">
        <OwnerForm type={type} owner={owner} />
      </div>
    </>
  );
}
