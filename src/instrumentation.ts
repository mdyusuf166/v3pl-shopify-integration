/**
 * Next.js instrumentation hook — runs once per server instance. Registers the Shopify
 * integration handlers on the core extension points so that shipments and stock changes
 * made through Server Actions enqueue their outbound jobs (shopify-integration.md §6).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/server/services/shopify/register");
  }
}
