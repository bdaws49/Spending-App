import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { Infer, v } from "convex/values";

// =============================================================================
// Plaid-backed "Spending" money app.
//
// Data flow (the browser never touches your bank credentials):
//   1. Browser asks for a LINK TOKEN  -> createLinkToken (server, secret keys)
//   2. Plaid Link UI runs in the browser, user logs into their bank
//   3. Browser hands back a one-time PUBLIC TOKEN -> exchangePublicToken
//   4. Server swaps it for a long-lived ACCESS TOKEN (stored server-side only)
//   5. syncTransactions pulls transactions via /transactions/sync
//
// Env vars (set with:  npx convex env set PLAID_CLIENT_ID xxx  etc.)
//   PLAID_CLIENT_ID   - from the Plaid dashboard
//   PLAID_SECRET      - the secret for the chosen environment
//   PLAID_ENV         - "sandbox" (default) or "production"
// =============================================================================

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function plaidBaseUrl(): string {
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  if (env === "production") return "https://production.plaid.com";
  return "https://sandbox.plaid.com";
}

// Low-level Plaid REST helper. Plaid auth travels in the JSON body.
async function plaidRequest(path: string, body: Record<string, unknown>) {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error(
      "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET with `npx convex env set`."
    );
  }

  const res = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error_message || data?.error_code || res.statusText;
    throw new Error(`Plaid ${path} failed: ${msg}`);
  }
  return data;
}

// -----------------------------------------------------------------------------
// Step 1 — create a link token for the Plaid Link browser UI.
// -----------------------------------------------------------------------------
export const createLinkToken = action({
  args: { syncKey: v.string() },
  handler: async (_ctx, args) => {
    const key = normalizeKey(args.syncKey);
    if (!key) throw new Error("A sync key is required.");

    const data = await plaidRequest("/link/token/create", {
      user: { client_user_id: key },
      client_name: "Spending",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    return { linkToken: data.link_token as string };
  },
});

// -----------------------------------------------------------------------------
// Step 3/4 — exchange the public token, store the item, and pull first batch.
// -----------------------------------------------------------------------------
export const exchangePublicToken = action({
  args: {
    syncKey: v.string(),
    publicToken: v.string(),
    institutionName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ itemId: string; added: number }> => {
    const key = normalizeKey(args.syncKey);
    if (!key) throw new Error("A sync key is required.");

    const data = await plaidRequest("/item/public_token/exchange", {
      public_token: args.publicToken,
    });

    const itemId = data.item_id as string;
    const accessToken = data.access_token as string;

    const institutionName = args.institutionName || "My bank";

    await ctx.runMutation("plaid:storeItem", {
      syncKey: key,
      itemId,
      accessToken,
      institutionName,
    });

    // Fetch the accounts on this item so the app can offer an account picker.
    await fetchAndStoreAccounts(ctx, key, itemId, accessToken, institutionName);

    // Pull transactions right away so the dashboard isn't empty.
    const result: { added: number } = await ctx.runAction(
      "plaid:syncTransactions",
      { syncKey: key }
    );
    return { itemId, added: result.added };
  },
});

// Internal — persist a freshly linked item (holds the secret access token).
export const storeItem = internalMutation({
  args: {
    syncKey: v.string(),
    itemId: v.string(),
    accessToken: v.string(),
    institutionName: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("plaidItems")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        institutionName: args.institutionName,
      });
      return existing._id;
    }
    return await ctx.db.insert("plaidItems", {
      syncKey: args.syncKey,
      itemId: args.itemId,
      accessToken: args.accessToken,
      institutionName: args.institutionName,
      createdAt: Date.now(),
    });
  },
});

// -----------------------------------------------------------------------------
// Step 5 — pull transactions for every linked bank on this key.
// Uses /transactions/sync, which is cursor-based and incremental.
// -----------------------------------------------------------------------------
export const syncTransactions = action({
  args: { syncKey: v.string() },
  handler: async (ctx, args): Promise<{ added: number; items: number }> => {
    const key = normalizeKey(args.syncKey);
    if (!key) throw new Error("A sync key is required.");

    const items: Array<{
      itemId: string;
      accessToken: string;
      cursor?: string;
      institutionName: string;
    }> = await ctx.runQuery("plaid:itemsForSync", { syncKey: key });

    let totalAdded = 0;

    for (const item of items) {
      // Keep account metadata fresh (names/masks for the account picker).
      await fetchAndStoreAccounts(
        ctx,
        key,
        item.itemId,
        item.accessToken,
        item.institutionName
      );

      let cursor = item.cursor;
      let hasMore = true;

      while (hasMore) {
        const body: Record<string, unknown> = { access_token: item.accessToken };
        if (cursor) body.cursor = cursor;

        const data = await plaidRequest("/transactions/sync", body);

        const added = (data.added || []).map(mapTxn);
        const modified = (data.modified || []).map(mapTxn);
        const removed = (data.removed || []).map(
          (r: { transaction_id: string }) => r.transaction_id
        );

        await ctx.runMutation("plaid:applySync", {
          syncKey: key,
          itemId: item.itemId,
          added,
          modified,
          removed,
          cursor: data.next_cursor,
        });

        totalAdded += added.length;
        cursor = data.next_cursor;
        hasMore = Boolean(data.has_more);
      }
    }

    return { added: totalAdded, items: items.length };
  },
});

// Shape a raw Plaid transaction into our stored row.
function mapTxn(t: any) {
  const pfc = t.personal_finance_category || {};
  return {
    transactionId: t.transaction_id as string,
    accountId: t.account_id as string,
    name: (t.name as string) || "Transaction",
    merchantName: (t.merchant_name as string) || undefined,
    amount: Number(t.amount) || 0,
    isoCurrencyCode: (t.iso_currency_code as string) || undefined,
    date: (t.date as string) || "",
    category: (pfc.primary as string) || "OTHER",
    categoryDetailed: (pfc.detailed as string) || undefined,
    pending: Boolean(t.pending),
  };
}

const txnValidator = v.object({
  transactionId: v.string(),
  accountId: v.string(),
  name: v.string(),
  merchantName: v.optional(v.string()),
  amount: v.number(),
  isoCurrencyCode: v.optional(v.string()),
  date: v.string(),
  category: v.string(),
  categoryDetailed: v.optional(v.string()),
  pending: v.boolean(),
});
type Txn = Infer<typeof txnValidator>;

// Fetch the accounts on an item from Plaid and store their metadata so the app
// can show a real account picker and filter spending to one account.
async function fetchAndStoreAccounts(
  ctx: any,
  syncKey: string,
  itemId: string,
  accessToken: string,
  institutionName: string
) {
  try {
    const data = await plaidRequest("/accounts/get", { access_token: accessToken });
    const accounts = (data.accounts || []).map((a: any) => ({
      accountId: a.account_id as string,
      name: (a.name as string) || "Account",
      officialName: (a.official_name as string) || undefined,
      mask: (a.mask as string) || undefined,
      type: (a.type as string) || undefined,
      subtype: (a.subtype as string) || undefined,
    }));
    await ctx.runMutation("plaid:storeAccounts", {
      syncKey,
      itemId,
      institutionName,
      accounts,
    });
  } catch (e) {
    console.error("Plaid /accounts/get failed:", e);
  }
}

const accountValidator = v.object({
  accountId: v.string(),
  name: v.string(),
  officialName: v.optional(v.string()),
  mask: v.optional(v.string()),
  type: v.optional(v.string()),
  subtype: v.optional(v.string()),
});

// Internal — upsert account metadata for an item.
export const storeAccounts = internalMutation({
  args: {
    syncKey: v.string(),
    itemId: v.string(),
    institutionName: v.string(),
    accounts: v.array(accountValidator),
  },
  handler: async (ctx, args) => {
    for (const a of args.accounts) {
      const existing = await ctx.db
        .query("plaidAccounts")
        .withIndex("by_accountId", (q) => q.eq("accountId", a.accountId))
        .first();
      const row = {
        syncKey: args.syncKey,
        itemId: args.itemId,
        institutionName: args.institutionName,
        ...a,
      };
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("plaidAccounts", row);
    }
  },
});

// Internal — read items (incl. access tokens & cursors) for a sync run.
// internalQuery so access tokens are NEVER reachable from the browser client.
export const itemsForSync = internalQuery({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const items = await ctx.db
      .query("plaidItems")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    return items.map((i) => ({
      itemId: i.itemId,
      accessToken: i.accessToken,
      cursor: i.cursor,
      institutionName: i.institutionName,
    }));
  },
});

// Internal — apply one page of a /transactions/sync response.
export const applySync = internalMutation({
  args: {
    syncKey: v.string(),
    itemId: v.string(),
    added: v.array(txnValidator),
    modified: v.array(txnValidator),
    removed: v.array(v.string()),
    cursor: v.string(),
  },
  handler: async (ctx, args) => {
    const upsert = async (t: Txn) => {
      const existing = await ctx.db
        .query("bankTransactions")
        .withIndex("by_transactionId", (q) =>
          q.eq("transactionId", t.transactionId)
        )
        .first();
      const row = { syncKey: args.syncKey, itemId: args.itemId, ...t };
      if (existing) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("bankTransactions", row);
      }
    };

    for (const t of args.added) await upsert(t);
    for (const t of args.modified) await upsert(t);

    for (const id of args.removed) {
      const existing = await ctx.db
        .query("bankTransactions")
        .withIndex("by_transactionId", (q) => q.eq("transactionId", id))
        .first();
      if (existing) await ctx.db.delete(existing._id);
    }

    const item = await ctx.db
      .query("plaidItems")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();
    if (item) {
      await ctx.db.patch(item._id, {
        cursor: args.cursor,
        lastSyncedAt: Date.now(),
      });
    }
  },
});

// -----------------------------------------------------------------------------
// Reads for the dashboard.
// -----------------------------------------------------------------------------

// Linked banks (safe fields only — never returns access tokens).
export const listItems = query({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const items = await ctx.db
      .query("plaidItems")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    return items.map((i) => ({
      itemId: i.itemId,
      institutionName: i.institutionName,
      lastSyncedAt: i.lastSyncedAt,
    }));
  },
});

// Accounts across all linked banks (for the account picker). No secrets.
export const listAccounts = query({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const accounts = await ctx.db
      .query("plaidAccounts")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    return accounts.map((a) => ({
      accountId: a.accountId,
      name: a.name,
      mask: a.mask,
      subtype: a.subtype,
      institutionName: a.institutionName,
    }));
  },
});

// The heart of the app: spending broken down by category, merchant and month.
export const spendingSummary = query({
  args: {
    syncKey: v.string(),
    days: v.optional(v.number()),
    accountId: v.optional(v.string()), // filter to a single account; omit for all
  },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const days = args.days ?? 30;

    // Date window (UTC-based YYYY-MM-DD string comparison is fine for filtering).
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const all = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey_and_date", (q) =>
        q.eq("syncKey", key).gte("date", since)
      )
      .collect();

    const txns = args.accountId
      ? all.filter((t) => t.accountId === args.accountId)
      : all;

    let totalSpent = 0;
    let totalIncome = 0;
    const byCategory: Record<string, number> = {};
    const byMerchant: Record<string, number> = {};
    const byMonth: Record<string, number> = {};
    let currency = "USD";

    for (const t of txns) {
      if (t.pending) continue;
      if (t.isoCurrencyCode) currency = t.isoCurrencyCode;

      // Plaid convention: positive amount = money leaving the account (spend).
      if (t.amount > 0) {
        // Ignore internal transfers so they don't masquerade as spending.
        if (t.category === "TRANSFER_OUT" || t.category === "TRANSFER_IN") {
          continue;
        }
        // Ignore credit-card bill payments: the underlying purchases are already
        // counted on the card itself, so counting the payment too would
        // double-count that spending.
        if (t.categoryDetailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") {
          continue;
        }
        totalSpent += t.amount;
        byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
        const merchant = t.merchantName || t.name;
        byMerchant[merchant] = (byMerchant[merchant] || 0) + t.amount;
        const month = t.date.slice(0, 7); // YYYY-MM
        byMonth[month] = (byMonth[month] || 0) + t.amount;
      } else if (t.amount < 0) {
        if (t.category !== "TRANSFER_IN" && t.category !== "TRANSFER_OUT") {
          totalIncome += -t.amount;
        }
      }
    }

    const toSorted = (obj: Record<string, number>) =>
      Object.entries(obj)
        .map(([label, amount]) => ({ label, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => b.amount - a.amount);

    return {
      days,
      currency,
      totalSpent: Math.round(totalSpent * 100) / 100,
      totalIncome: Math.round(totalIncome * 100) / 100,
      transactionCount: txns.filter((t) => !t.pending).length,
      categories: toSorted(byCategory),
      merchants: toSorted(byMerchant).slice(0, 10),
      months: Object.entries(byMonth)
        .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    };
  },
});

// Recent transactions feed.
export const recentTransactions = query({
  args: {
    syncKey: v.string(),
    limit: v.optional(v.number()),
    accountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const limit = args.limit ?? 40;
    const all = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const txns = args.accountId
      ? all.filter((t) => t.accountId === args.accountId)
      : all;

    const tags = await ctx.db
      .query("transactionTags")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const businessSet = new Set(
      tags.filter((t) => t.isBusiness).map((t) => t.transactionId)
    );

    return txns
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map((t) => ({
        transactionId: t.transactionId,
        name: t.merchantName || t.name,
        amount: Math.round(t.amount * 100) / 100,
        date: t.date,
        category: t.category,
        pending: t.pending,
        isBusiness: businessSet.has(t.transactionId),
      }));
  },
});

// -----------------------------------------------------------------------------
// Unlink a bank (removes it at Plaid and deletes its local transactions).
// -----------------------------------------------------------------------------
export const unlinkItem = action({
  args: { syncKey: v.string(), itemId: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const items: Array<{ itemId: string; accessToken: string }> =
      await ctx.runQuery("plaid:itemsForSync", { syncKey: key });
    const target = items.find((i) => i.itemId === args.itemId);
    if (target) {
      try {
        await plaidRequest("/item/remove", { access_token: target.accessToken });
      } catch (e) {
        console.error("Plaid /item/remove failed (continuing cleanup):", e);
      }
    }
    await ctx.runMutation("plaid:deleteItemData", {
      syncKey: key,
      itemId: args.itemId,
    });
    return { ok: true };
  },
});

export const deleteItemData = internalMutation({
  args: { syncKey: v.string(), itemId: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("plaidItems")
      .withIndex("by_itemId", (q) => q.eq("itemId", args.itemId))
      .first();
    if (item) await ctx.db.delete(item._id);

    const txns = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", args.syncKey))
      .collect();
    for (const t of txns) {
      if (t.itemId === args.itemId) await ctx.db.delete(t._id);
    }

    const accounts = await ctx.db
      .query("plaidAccounts")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", args.syncKey))
      .collect();
    for (const a of accounts) {
      if (a.itemId === args.itemId) await ctx.db.delete(a._id);
    }
  },
});

// -----------------------------------------------------------------------------
// Cron entry point — keep every linked bank fresh once a day.
// -----------------------------------------------------------------------------
export const syncAllItems = internalAction({
  args: {},
  handler: async (ctx) => {
    const keys: string[] = await ctx.runQuery("plaid:allSyncKeys", {});
    let synced = 0;
    for (const key of keys) {
      try {
        await ctx.runAction("plaid:syncTransactions", { syncKey: key });
        synced++;
      } catch (e) {
        console.error(`Daily sync failed for key ${key}:`, e);
      }
    }
    return { keysSynced: synced };
  },
});

export const allSyncKeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("plaidItems").collect();
    return Array.from(new Set(items.map((i) => i.syncKey)));
  },
});
