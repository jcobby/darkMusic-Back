import "dotenv/config";
import app from "./app";
import { connectDB } from "./config/db";
import { sweepAuctions } from "./controllers/auction.controller";
import { sweepGamePrizes } from "./services/prizes";

const PORT = Number(process.env.PORT) || 5000;

async function start(): Promise<void> {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
  // Once a minute (and right away after a restart/wake): announce merch auction
  // winners; credit the game prize to the winner's wallet as soon as a month ends,
  // and release it for withdrawal once the score check is over.
  const sweep = () => {
    sweepAuctions().catch((err) => console.error("[auction] sweep failed:", err));
    sweepGamePrizes().catch((err) => console.error("[games] prize sweep failed:", err));
  };
  void sweep();
  setInterval(sweep, 60_000);
}

start().catch((err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});
