import type { Metadata } from "next";
import { OwnerForm } from "@/components/owners/owner-form";
import { PageHeader } from "@/components/layout/page-header";
import { OWNER_TYPE_META } from "@/lib/validation/owners";
import { requireRole } from "@/server/auth/guards";

const meta = OWNER_TYPE_META.THREEPL_CLIENT;
export const metadata: Metadata = { title: `New ${meta.singular}` };

export default async function Page() {
  await requireRole("ADMIN");
  return (
    <>
      <PageHeader title={`New ${meta.singular.toLowerCase()}`} description="Create the business record first, then add its portal users." />
      <div className="max-w-3xl">
        <OwnerForm type="THREEPL_CLIENT" />
      </div>
    </>
  );
}
