import type { Owner } from "@/generated/prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  owner: Pick<
    Owner,
    "code" | "businessName" | "contactName" | "email" | "phone" | "addressLine1" | "addressLine2" | "city" | "state" | "postalCode" | "country"
  >;
  title?: string;
  description?: string;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value ?? <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

/** Read-only business profile, shared by the admin detail page and the partner portals. */
export function OwnerProfileCard({ owner, title = "Business profile", description }: Props) {
  const address = [owner.addressLine1, owner.addressLine2, [owner.city, owner.state, owner.postalCode].filter(Boolean).join(", "), owner.country]
    .filter((line) => line && line.length > 0)
    .join("\n");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Code" value={<span className="font-mono text-xs">{owner.code}</span>} />
          <Row label="Business name" value={owner.businessName} />
          <Row label="Contact person" value={owner.contactName} />
          <Row label="Email" value={owner.email} />
          <Row label="Phone" value={owner.phone} />
          <Row label="Address" value={address ? <span className="whitespace-pre-line">{address}</span> : null} />
        </dl>
      </CardContent>
    </Card>
  );
}
