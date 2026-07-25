import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Keep linked bank accounts fresh - runs every day at 6:00 AM EST so the app
// shows up-to-date numbers the moment you tap the icon.
crons.daily(
  "sync bank transactions",
  {
    hourUTC: 11, // 6 AM EST = 11 AM UTC
    minuteUTC: 0,
  },
  internal.plaid.syncAllItems
);

export default crons;
