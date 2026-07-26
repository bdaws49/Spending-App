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

  // One row per bank account within a linked item (checking, credit card, etc.).
  // Populated from Plaid's /accounts/get so the app can show a real account
  // picker ("Wells Fargo Checking ••1234") and filter spending to one account.
  plaidAccounts: defineTable({
    syncKey: v.string(),
    itemId: v.string(),
    accountId: v.string(),
    name: v.string(),
    officialName: v.optional(v.string()),
    mask: v.optional(v.string()), // last 4 digits
    type: v.optional(v.string()), // depository, credit, loan, ...
    subtype: v.optional(v.string()), // checking, savings, credit card, ...
    institutionName: v.string(),
  })
    .index("by_syncKey", ["syncKey"])
    .index("by_accountId", ["accountId"]),

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

  // Monthly spending cap per category (Plaid primary category).
  budgets: defineTable({
    syncKey: v.string(),
    category: v.string(),
    monthlyLimit: v.number(),
  }).index("by_syncKey", ["syncKey"]),

  // Per-transaction "business" tag for expense separation / tax export.
  transactionTags: defineTable({
    syncKey: v.string(),
    transactionId: v.string(),
    isBusiness: v.boolean(),
  })
    .index("by_syncKey", ["syncKey"])
    .index("by_transactionId", ["transactionId"]),
});
