import { Prisma, type ChargeBasis, type ChargeRule, type OwnerType } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { ChargeRuleFormValues } from "@/lib/validation/finance";
import { recordAudit } from "@/server/services/audit";

/**
 * Operational charge rules (NR-8, D-063). Rules are configuration; applied charges (`Charge` rows, written by
 * finance.ts at shipment time) are immutable copies — editing or deleting a rule never changes history.
 */

export class ChargeServiceError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "OWNER_NOT_FOUND" | "IN_USE",
    message: string,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

function ruleData(values: ChargeRuleFormValues) {
  return {
    name: values.name,
    chargeType: values.chargeType,
    basis: values.basis,
    amount: new Prisma.Decimal(values.amount),
    active: values.active,
    ownerId: values.ownerId || null,
    ownerType: values.ownerId ? null : values.ownerType ? (values.ownerType as OwnerType) : null,
    minWeightGrams: values.minWeightGrams,
    maxWeightGrams: values.maxWeightGrams,
    minLongestCm: values.minLongestCm === null ? null : new Prisma.Decimal(values.minLongestCm),
    maxLongestCm: values.maxLongestCm === null ? null : new Prisma.Decimal(values.maxLongestCm),
    notes: values.notes,
  };
}

async function assertOwner(db: Db, ownerId: string | null) {
  if (!ownerId) return;
  const o = await db.owner.findUnique({ where: { id: ownerId }, select: { id: true } });
  if (!o) throw new ChargeServiceError("OWNER_NOT_FOUND", "The selected owner does not exist.");
}

export async function listChargeRules(filter: { active?: boolean } = {}) {
  return prisma.chargeRule.findMany({ where: filter.active === undefined ? {} : { active: filter.active }, orderBy: [{ active: "desc" }, { chargeType: "asc" }, { name: "asc" }], include: { owner: { select: { id: true, businessName: true, code: true, type: true } }, _count: { select: { charges: true } } } });
}

export async function getChargeRule(id: string) {
  return prisma.chargeRule.findUnique({ where: { id }, include: { owner: { select: { id: true, businessName: true, code: true, type: true } }, _count: { select: { charges: true } } } });
}

export async function createChargeRule(values: ChargeRuleFormValues, actorId: string): Promise<ChargeRule> {
  const data = ruleData(values);
  await assertOwner(prisma, data.ownerId);
  return prisma.$transaction(async (tx) => {
    const rule = await tx.chargeRule.create({ data: { ...data, createdById: actorId } });
    await recordAudit({ userId: actorId, action: "charge_rule.created", entityType: "ChargeRule", entityId: rule.id, newValues: { ...data, amount: values.amount } }, tx);
    return rule;
  });
}

export async function updateChargeRule(id: string, values: ChargeRuleFormValues, actorId: string): Promise<ChargeRule> {
  const current = await prisma.chargeRule.findUnique({ where: { id } });
  if (!current) throw new ChargeServiceError("NOT_FOUND", "Charge rule not found.");
  const data = ruleData(values);
  await assertOwner(prisma, data.ownerId);
  return prisma.$transaction(async (tx) => {
    const rule = await tx.chargeRule.update({ where: { id }, data });
    await recordAudit({ userId: actorId, action: "charge_rule.updated", entityType: "ChargeRule", entityId: id, oldValues: { name: current.name, amount: current.amount.toString(), active: current.active, basis: current.basis, chargeType: current.chargeType }, newValues: { ...data, amount: values.amount } }, tx);
    return rule;
  });
}

export async function setChargeRuleActive(id: string, active: boolean, actorId: string): Promise<ChargeRule> {
  const current = await prisma.chargeRule.findUnique({ where: { id } });
  if (!current) throw new ChargeServiceError("NOT_FOUND", "Charge rule not found.");
  if (current.active === active) return current;
  return prisma.$transaction(async (tx) => {
    const rule = await tx.chargeRule.update({ where: { id }, data: { active } });
    await recordAudit({ userId: actorId, action: active ? "charge_rule.activated" : "charge_rule.deactivated", entityType: "ChargeRule", entityId: id }, tx);
    return rule;
  });
}

/** Rules can be deleted only while unused; used rules are deactivated instead so history keeps its reference. */
export async function deleteChargeRule(id: string, actorId: string): Promise<void> {
  const current = await prisma.chargeRule.findUnique({ where: { id }, include: { _count: { select: { charges: true } } } });
  if (!current) throw new ChargeServiceError("NOT_FOUND", "Charge rule not found.");
  if (current._count.charges > 0) throw new ChargeServiceError("IN_USE", `This rule has been applied ${current._count.charges} time(s). Deactivate it instead so the charge history keeps its reference.`);
  await prisma.$transaction(async (tx) => {
    await tx.chargeRule.delete({ where: { id } });
    await recordAudit({ userId: actorId, action: "charge_rule.deleted", entityType: "ChargeRule", entityId: id, oldValues: { name: current.name, amount: current.amount.toString() } }, tx);
  });
}

// ---------------------------------------------------------------------------
// Matching (pure, server-side; used by finance.recordShipmentFinancials)
// ---------------------------------------------------------------------------

export type PhysicalUnit = { weightGrams: number | null; lengthCm: Prisma.Decimal | number | null; widthCm: Prisma.Decimal | number | null; heightCm: Prisma.Decimal | number | null };

/** Longest side in cm, or null when any dimension is unknown. */
export function longestSideCm(u: PhysicalUnit): number | null {
  const dims = [u.lengthCm, u.widthCm, u.heightCm].map((d) => (d === null || d === undefined ? null : Number(d)));
  if (dims.some((d) => d === null || Number.isNaN(d))) return null;
  return Math.max(...(dims as number[]));
}

export type RuleFigures = { weightGrams: number | null; longestCm: number | null };

/** Does the rule's optional weight / dimension range accept these figures? Unknown data never matches a ranged rule. */
export function ruleMatches(rule: Pick<ChargeRule, "minWeightGrams" | "maxWeightGrams" | "minLongestCm" | "maxLongestCm">, f: RuleFigures): boolean {
  const hasWeightRange = rule.minWeightGrams !== null || rule.maxWeightGrams !== null;
  const hasDimRange = rule.minLongestCm !== null || rule.maxLongestCm !== null;
  if (hasWeightRange) {
    if (f.weightGrams === null) return false;
    if (rule.minWeightGrams !== null && f.weightGrams < rule.minWeightGrams) return false;
    if (rule.maxWeightGrams !== null && f.weightGrams > rule.maxWeightGrams) return false;
  }
  if (hasDimRange) {
    if (f.longestCm === null) return false;
    if (rule.minLongestCm !== null && f.longestCm < Number(rule.minLongestCm)) return false;
    if (rule.maxLongestCm !== null && f.longestCm > Number(rule.maxLongestCm)) return false;
  }
  return true;
}

/** Active rules that apply to this owner: owner-specific, owner-type, or global. */
export async function applicableRules(db: Db, owner: { id: string; type: OwnerType }): Promise<ChargeRule[]> {
  return db.chargeRule.findMany({ where: { active: true, OR: [{ ownerId: owner.id }, { ownerId: null, ownerType: owner.type }, { ownerId: null, ownerType: null }] }, orderBy: [{ chargeType: "asc" }, { name: "asc" }] });
}

export function describeBasis(basis: ChargeBasis): string {
  return basis === "PER_UNIT" ? "per unit" : basis === "PER_SHIPMENT" ? "per shipment" : "per order";
}
