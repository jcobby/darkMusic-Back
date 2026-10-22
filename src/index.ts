import "dotenv/config";
import app from "./app";
import { connectDB } from "./config/db";
import { sweepAuctions } from "./controllers/auction.controller";
import { sweepGamePrizes } from "./services/prizes";
import { sendFeedbackDigest } from "./controllers/feedback.controller";
import { closeExpired as closeTriviaQuestions } from "./services/trivia";

const PORT = Number(process.env.PORT) || 5000;

async function start(): Promise<void> {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
  // Once a minute (and right away after a restart/wake): announce merch auction
  // winners; credit the game prize to the winner's wallet as soon as a month ends,
  // and release it for withdrawal once the score check is over; email new
  // feedback (at most once a day).
  const sweep = () => {
    sweepAuctions().catch((err) => console.error("[auction] sweep failed:", err));
    sweepGamePrizes().catch((err) => console.error("[games] prize sweep failed:", err));
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
