import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// =============================================================================
// Extra features: credit-card watch, subscription finder, budgets, business
// tags, and CSV export. All scoped by syncKey like the rest of the app.
// =============================================================================

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

// Does this transaction count as spending? (money out, not a transfer or a
// credit-card bill payment, not pending)
function isSpend(t: {
  amount: number;
  category: string;
  categoryDetailed?: string;
  pending: boolean;
}): boolean {
  if (t.pending) return false;
  if (t.amount <= 0) return false;
  if (t.category === "TRANSFER_OUT" || t.category === "TRANSFER_IN") return false;
  if (t.categoryDetailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return false;
  return true;
}

function monthStr(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

// -----------------------------------------------------------------------------
// Credit-card watch — how much you've put on credit cards this month.
// -----------------------------------------------------------------------------
export const creditCardWatch = query({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);

    const accounts = await ctx.db
      .query("plaidAccounts")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const creditIds = new Set(
      accounts.filter((a) => a.type === "credit").map((a) => a.accountId)
    );
    const creditNames = accounts
      .filter((a) => a.type === "credit")
      .map((a) => a.name);

    if (creditIds.size === 0) {
      return { hasCreditCard: false, thisMonth: 0, lastMonth: 0, names: [] };
    }

    const now = new Date();
    const thisMonth = monthStr(now);
    const lastMonth = monthStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const since = lastMonth + "-01";

    const txns = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey_and_date", (q) =>
        q.eq("syncKey", key).gte("date", since)
      )
      .collect();

    let thisM = 0;
    let lastM = 0;
    for (const t of txns) {
      if (!creditIds.has(t.accountId) || !isSpend(t)) continue;
      const m = t.date.slice(0, 7);
      if (m === thisMonth) thisM += t.amount;
      else if (m === lastMonth) lastM += t.amount;
    }
    return {
      hasCreditCard: true,
      thisMonth: Math.round(thisM * 100) / 100,
      lastMonth: Math.round(lastM * 100) / 100,
      names: creditNames,
    };
  },
});

// -----------------------------------------------------------------------------
// Subscription finder — recurring charges from the same merchant.
// -----------------------------------------------------------------------------
export const subscriptions = query({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const txns = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey_and_date", (q) =>
        q.eq("syncKey", key).gte("date", since)
      )
      .collect();

    const groups: Record<
      string,
      { display: string; amounts: number[]; dates: string[] }
    > = {};
    for (const t of txns) {
      if (!isSpend(t)) continue;
      const display = t.merchantName || t.name;
      const norm = display.toLowerCase().trim();
      if (!groups[norm]) groups[norm] = { display, amounts: [], dates: [] };
      groups[norm].amounts.push(t.amount);
      groups[norm].dates.push(t.date);
    }

    const subs: Array<{
      merchant: string;
      amount: number;
      count: number;
      lastDate: string;
    }> = [];
    for (const g of Object.values(groups)) {
      if (g.amounts.length < 2) continue;
      // recurring if the charges are roughly the same size each time
      const avg = g.amounts.reduce((a, b) => a + b, 0) / g.amounts.length;
      const consistent = g.amounts.every((a) => Math.abs(a - avg) <= Math.max(2, avg * 0.2));
      if (!consistent) continue;
      subs.push({
        merchant: g.display,
        amount: Math.round(avg * 100) / 100,
        count: g.amounts.length,
        lastDate: g.dates.sort().pop() as string,
      });
    }
    subs.sort((a, b) => b.amount - a.amount);
    const totalMonthly = Math.round(subs.reduce((a, s) => a + s.amount, 0) * 100) / 100;
    return { subs, totalMonthly };
  },
});

// -----------------------------------------------------------------------------
// Budgets — monthly cap per category, with month-to-date spend.
// -----------------------------------------------------------------------------
export const getBudgets = query({
  args: { syncKey: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const month = monthStr(new Date());
    const since = month + "-01";

    const txns = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey_and_date", (q) =>
        q.eq("syncKey", key).gte("date", since)
      )
      .collect();

    const spentByCat: Record<string, number> = {};
    for (const t of txns) {
      if (!isSpend(t) || t.date.slice(0, 7) !== month) continue;
      spentByCat[t.category] = (spentByCat[t.category] || 0) + t.amount;
    }

    const budgets = await ctx.db
      .query("budgets")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();

    return {
      month,
      budgets: budgets.map((b) => ({
        category: b.category,
        monthlyLimit: b.monthlyLimit,
        spent: Math.round((spentByCat[b.category] || 0) * 100) / 100,
      })),
    };
  },
});

export const setBudget = mutation({
  args: { syncKey: v.string(), category: v.string(), monthlyLimit: v.number() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const existing = await ctx.db
      .query("budgets")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const match = existing.find((b) => b.category === args.category);
    if (match) {
      await ctx.db.patch(match._id, { monthlyLimit: args.monthlyLimit });
    } else {
      await ctx.db.insert("budgets", {
        syncKey: key,
        category: args.category,
        monthlyLimit: args.monthlyLimit,
      });
    }
  },
});

export const deleteBudget = mutation({
  args: { syncKey: v.string(), category: v.string() },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const existing = await ctx.db
      .query("budgets")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const match = existing.find((b) => b.category === args.category);
    if (match) await ctx.db.delete(match._id);
  },
});

// -----------------------------------------------------------------------------
// Business tags — mark a transaction as a business expense.
// -----------------------------------------------------------------------------
export const setTag = mutation({
  args: {
    syncKey: v.string(),
    transactionId: v.string(),
    isBusiness: v.boolean(),
  },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const existing = await ctx.db
      .query("transactionTags")
      .withIndex("by_transactionId", (q) =>
        q.eq("transactionId", args.transactionId)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { isBusiness: args.isBusiness });
    } else {
      await ctx.db.insert("transactionTags", {
        syncKey: key,
        transactionId: args.transactionId,
        isBusiness: args.isBusiness,
      });
    }
  },
});

// -----------------------------------------------------------------------------
// CSV export — full transaction list with account name and business flag.
// -----------------------------------------------------------------------------
export const exportTransactions = query({
  args: {
    syncKey: v.string(),
    days: v.optional(v.number()),
    businessOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const key = normalizeKey(args.syncKey);
    const days = args.days ?? 365;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const txns = await ctx.db
      .query("bankTransactions")
      .withIndex("by_syncKey_and_date", (q) =>
        q.eq("syncKey", key).gte("date", since)
      )
      .collect();

    const accounts = await ctx.db
      .query("plaidAccounts")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const acctName: Record<string, string> = {};
    for (const a of accounts) acctName[a.accountId] = a.name;

    const tags = await ctx.db
      .query("transactionTags")
      .withIndex("by_syncKey", (q) => q.eq("syncKey", key))
      .collect();
    const businessSet = new Set(
      tags.filter((t) => t.isBusiness).map((t) => t.transactionId)
    );

    const rows = txns
      .filter((t) => !t.pending)
      .filter((t) => (args.businessOnly ? businessSet.has(t.transactionId) : true))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((t) => ({
        date: t.date,
        name: t.merchantName || t.name,
        amount: Math.round(t.amount * 100) / 100,
        category: t.category,
        account: acctName[t.accountId] || "",
        isBusiness: businessSet.has(t.transactionId),
      }));
    return rows;
  },
});
