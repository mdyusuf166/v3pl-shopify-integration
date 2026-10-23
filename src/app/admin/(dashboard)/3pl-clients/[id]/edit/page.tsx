import { OwnerEdit } from "@/components/owners/owner-edit";
import { requireRole } from "@/server/auth/guards";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  return <OwnerEdit type="THREEPL_CLIENT" id={id} />;
}
