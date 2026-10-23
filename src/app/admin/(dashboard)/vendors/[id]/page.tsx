import { OwnerDetail } from "@/components/owners/owner-detail";
import { requireRole } from "@/server/auth/guards";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("ADMIN");
  const { id } = await params;
  return <OwnerDetail type="VENDOR" id={id} />;
}
