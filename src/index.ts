import "dotenv/config";
import app from "./app";
import { connectDB } from "./config/db";
import { sweepAuctions } from "./controllers/auction.controller";
import { sweepGamePrizes } from "./services/prizes";
import { sendFeedbackDigest } from "./controllers/feedback.controller";
import { closeExpired as closeTriviaQuestions } from "./services/trivia";
import { sweepEvents } from "./services/events";
import { ensurePoolNight } from "./services/poolNight";
import { remindMembers } from "./services/membership";
import { recheckAllPromoters } from "./services/promoter";

const PORT = Number(process.env.PORT) || 5000;

async function start(): Promise<void> {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
  // Once a minute (and right away after a restart/wake): announce merch auction
  // winners; credit the game prize to the winner's wallet as soon as a month ends,
  // and release it for withdrawal once the score check is over; pay out game events
  // as they end; set up the coming Pool Night; email new feedback (at most once a day);
  // and, once an hour, remind members whose membership ends in the next few days and
  // re-run the Lenko Army promoters' duplicate-account check.
  let lastReminders = 0;
  const sweep = () => {
    if (Date.now() - lastReminders > 3600e3) {
      lastReminders = Date.now();
      remindMembers().catch((err) => console.error("[membership] reminders failed:", err));
      recheckAllPromoters().catch((err) => console.error("[promoter] duplicate check failed:", err));
    }
    sweepAuctions().catch((err) => console.error("[auction] sweep failed:", err));
    sweepGamePrizes().catch((err) => console.error("[games] prize sweep failed:", err));
    sweepEvents().catch((err) => console.error("[events] payout sweep failed:", err));
    ensurePoolNight().catch((err) => console.error("[pool] couldn't set up Pool Night:", err));
    sendFeedbackDigest().catch((err) => console.error("[feedback] digest failed:", err));
    closeTriviaQuestions().catch((err) => console.error("[trivia] closing questions failed:", err));
  };
  void sweep();
  setInterval(sweep, 60_000);
}

start().catch((err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});
