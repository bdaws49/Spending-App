import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Standalone "Spending" app schema. All rows are scoped by `syncKey` (a personal
// secret phrase) so the same key follows the user across devices.
export default defineSchema({
  // One row per linked bank ("Item" in Plaid terms). Holds the long-lived
  // access token — this NEVER leaves the server; the browser only ever sees a
  // short-lived link_token and hands back a one-time public_token.
  plaidItems: defineTable({
    syncKey: v.string(),
    itemId: v.string(), // Plaid item_id
    accessToken: v.string(), // Plaid access_token (server-only secret)
    institutionName: v.string(),
    cursor: v.optional(v.string()), // /transactions/sync pagination cursor
    lastSyncedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_syncKey", ["syncKey"])
    .index("by_itemId", ["itemId"]),

  // One row per Plaid transaction, denormalised for fast charting.
  bankTransactions: defineTable({
    syncKey: v.string(),
    transactionId: v.string(), // Plaid transaction_id (stable, used for upsert)
    itemId: v.string(),
    accountId: v.string(),
    name: v.string(),
    merchantName: v.optional(v.string()),
    amount: v.number(), // Plaid convention: positive = money OUT, negative = money IN
    isoCurrencyCode: v.optional(v.string()),
    date: v.string(), // "YYYY-MM-DD"
    category: v.string(), // Plaid personal_finance_category.primary (or "OTHER")
    categoryDetailed: v.optional(v.string()),
    pending: v.boolean(),
  })
    .index("by_syncKey", ["syncKey"])
    .index("by_transactionId", ["transactionId"])
    .index("by_syncKey_and_date", ["syncKey", "date"]),
});
