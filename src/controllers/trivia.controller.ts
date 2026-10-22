import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { User } from "../models/User";
import { TriviaQuestion, TriviaRound, TriviaAttempt, TriviaSettings } from "../models/Trivia";
import { bidderName } from "./auction.controller";
import { clientIp } from "../utils/clientIp";
import {
  triviaSettings,
  forgetTriviaSettings,
  forgetActiveQuestions,
  lobbyView,
  isInLobby,
  seen,
  joinLobby,
  leaveLobby,
  liveQuestion,
  doneWithQuestion,
  maybeStartRound,
  questionsLeft,
  activeQuestionIds,
  closeExpired,
  isCorrectAnswer,
  GRACE_MS,
} from "../services/trivia";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const oid = (id: string) => new Types.ObjectId(id);

/**
 * Name and email-confirmed for a player — remembered for a few minutes once
 * confirmed, but only 10 s while not, so confirming the email unlocks the game
 * straight away.
 */
const players = new Map<string, { at: number; name: string; confirmed: boolean }>();
async function player(userId: string) {
  const hit = players.get(userId);
  if (hit && Date.now() - hit.at < (hit.confirmed ? 5 * 60 * 1000 : 10 * 1000)) return hit;
  const u = await User.findById(userId).select("name emailVerified").lean();
  if (!u) throw httpError(404, "Account not found");
  const p = { at: Date.now(), name: bidderName(u.name), confirmed: Boolean(u.emailVerified) };
  players.set(userId, p);
  return p;
}

/** GET /api/trivia/lobby — public: how many are ready now, the prize and the rules. */
export async function triviaLobby(_req: Request, res: Response, next: NextFunction) {
  try {
    const s = await triviaSettings();
    res.json({ open: s.open, needed: s.minPlayers, seconds: s.seconds, prizeGhs: s.prizeGhs, ...lobbyView() });
  } catch (err) {
    next(err);
  }
}

/**
 * Everything the player's page needs: lobby, their question while it's live, their
 * last result. Kept light (it's what pages load), since the server is small.
 */
async function stateFor(userId: string) {
  const s = await triviaSettings();
  if (isInLobby(userId)) {
    seen(userId);
    await maybeStartRound();
  }
  const now = Date.now();
  const uid = oid(userId);
  const [me, pendingDoc, lastDoc] = await Promise.all([
    player(userId),
    TriviaAttempt.findOne({ user: uid, result: "pending" }).select("roundNumber deadline question").lean(),
    TriviaAttempt.findOne({ user: uid, result: { $ne: "pending" } }).sort({ assignedAt: -1 }).select("result roundNumber submittedAt deadline").lean(),
  ]);
  let pending = pendingDoc;
  let last = lastDoc ? { _id: lastDoc._id, result: lastDoc.result, roundNumber: lastDoc.roundNumber, at: lastDoc.submittedAt ?? lastDoc.deadline } : null;
  if (pending && pending.deadline.getTime() + GRACE_MS <= now) {
    // Time's up and it was never answered: lock it now.
    await TriviaAttempt.updateOne({ _id: pending._id, result: "pending" }, { $set: { result: "unanswered" } });
    last = { _id: pending._id, result: "unanswered", roundNumber: pending.roundNumber, at: pending.deadline };
    pending = null;
  }
  const inQuestion = Boolean(pending);
  const text = pending ? (liveQuestion(userId)?.text ?? (await TriviaQuestion.findById(pending.question).select("text").lean())?.text ?? "") : "";
  const [left, bank] = inQuestion ? [null, null] : await Promise.all([questionsLeft(userId), activeQuestionIds()]);
  return {
    open: s.open,
    needed: s.minPlayers,
    seconds: s.seconds,
    prizeGhs: s.prizeGhs,
    ...lobbyView(),
    emailConfirmed: me.confirmed || !s.requireConfirmedEmail,
    questionsLeft: left,
    noQuestionsYet: bank !== null && bank.length === 0, // the bank is empty (not that they've had them all)
    phase: inQuestion ? "question" : isInLobby(userId) ? "ready" : "idle",
    question: pending
      ? {
          attemptId: String(pending._id),
          roundNumber: pending.roundNumber,
          text,
          remainingMs: Math.max(0, pending.deadline.getTime() - now),
          seconds: s.seconds,
        }
      : null,
    last: last ? { attemptId: String(last._id), result: last.result, roundNumber: last.roundNumber, at: last.at } : null,
  };
}

/** GET /api/trivia/state — the signed-in player's view (also counts as "still here" when they're ready). */
export async function triviaState(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await stateFor(String(req.fan?.id)));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/trivia/ping — a ready player's page checks in every 2 s: keeps them in
 * the lobby, starts the round when enough are ready, and — the moment their round
 * starts — brings their question straight back. No database reads.
 */
export async function triviaPing(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const s = await triviaSettings();
    if (isInLobby(userId)) {
      seen(userId);
      await maybeStartRound();
    }
    const q = liveQuestion(userId);
    const phase = q ? "question" : isInLobby(userId) ? "ready" : "idle";
    res.json({
      phase,
      open: s.open,
      needed: s.minPlayers,
      ...lobbyView(),
      question: q
        ? { attemptId: q.attemptId, roundNumber: q.roundNumber, text: q.text, remainingMs: Math.max(0, q.deadline - Date.now()), seconds: s.seconds }
        : null,
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/trivia/ready — "I'm Online & Ready". */
export async function triviaReady(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const s = await triviaSettings();
    if (!s.open) throw httpError(409, "Lenko Trivia is paused right now — check back soon");
    const me = await player(userId);
    if (s.requireConfirmedEmail && !me.confirmed) {
      players.delete(userId); // they may have just confirmed — check again next time
      throw httpError(403, "Confirm your email address first — check your inbox");
    }
    await closeExpired(userId);
    if (await TriviaAttempt.exists({ user: oid(userId), result: "pending" })) throw httpError(409, "Your question is live — answer it first");
    if ((await activeQuestionIds()).length === 0) throw httpError(409, "Lenko Trivia hasn't started yet — questions are coming soon");
    if ((await questionsLeft(userId)) === 0) throw httpError(409, "You've had every question — new ones are coming soon");
    joinLobby(userId, me.name, clientIp(req));
    await maybeStartRound();
    res.json(await stateFor(userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/trivia/leave — out of the lobby. */
export async function triviaLeave(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    leaveLobby(userId);
    res.json(await stateFor(userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/trivia/answer { attemptId, answer } — one go; locked once sent. Only the player's own result comes back. */
export async function triviaAnswer(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const attemptId = String(req.body?.attemptId || "");
    const answer = String(req.body?.answer ?? "").trim().slice(0, 200);
    if (!Types.ObjectId.isValid(attemptId)) throw httpError(400, "Invalid question");
    if (!answer) throw httpError(400, "Type your answer first");
    const attempt = await TriviaAttempt.findOne({ _id: attemptId, user: oid(userId) });
    if (!attempt) throw httpError(404, "Question not found");
    if (attempt.result !== "pending") {
      return res.json({ result: attempt.result, locked: true });
    }
    const now = new Date();
    if (now.getTime() > attempt.deadline.getTime() + GRACE_MS) {
      await TriviaAttempt.updateOne({ _id: attempt._id, result: "pending" }, { $set: { result: "unanswered" } });
      doneWithQuestion(userId);
      return res.json({ result: "unanswered", locked: true });
    }
    const q = await TriviaQuestion.findById(attempt.question).select("answers");
    const result = q && isCorrectAnswer(answer, q.answers) ? "correct" : "wrong";
    const saved = await TriviaAttempt.findOneAndUpdate(
      { _id: attempt._id, result: "pending" },
      { $set: { answer, submittedAt: now, result } },
      { new: true }
    );
    if (!saved) {
      const already = await TriviaAttempt.findById(attempt._id).select("result");
      return res.json({ result: already?.result ?? "wrong", locked: true });
    }
    if (result === "correct") await TriviaQuestion.updateOne({ _id: attempt.question }, { $inc: { correct: 1 } });
    doneWithQuestion(userId);
    res.json({ result, locked: true });
  } catch (err) {
    next(err);
  }
}

let boardCache: { at: number; value: unknown } | null = null;
/**
 * GET /api/trivia/leaderboard — everyone who got their question right, once their
 * round is over (answers stay private while it's live). Names shortened; answers never shown.
 */
export async function triviaLeaderboard(_req: Request, res: Response, next: NextFunction) {
  try {
    if (boardCache && Date.now() - boardCache.at < 10_000) return res.json(boardCache.value);
    const s = await triviaSettings();
    const now = new Date();
    const [entries, rounds, playersCount, correctCount] = await Promise.all([
      TriviaAttempt.find({ result: "correct", deadline: { $lt: now } })
        .sort({ submittedAt: -1 })
        .limit(300)
        .select("name roundNumber submittedAt assignedAt")
        .lean(),
      TriviaRound.countDocuments({ endsAt: { $lt: now } }),
      TriviaAttempt.distinct("user", { deadline: { $lt: now } }).then((u) => u.length),
      TriviaAttempt.countDocuments({ result: "correct", deadline: { $lt: now } }),
    ]);
    const value = {
      prizeGhs: s.prizeGhs,
      rounds,
      players: playersCount,
      correct: correctCount,
      entries: entries.map((e) => ({
        name: e.name,
        round: e.roundNumber,
        at: e.submittedAt,
        seconds: e.submittedAt ? Math.max(1, Math.round((e.submittedAt.getTime() - e.assignedAt.getTime()) / 1000)) : null,
      })),
    };
    boardCache = { at: Date.now(), value };
    res.json(value);
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------

/** GET /api/admin/trivia — settings, the lobby, questions, everyone who got it right (for paying out) and recent rounds. */
export async function adminTrivia(_req: Request, res: Response, next: NextFunction) {
  try {
    await closeExpired();
    const s = await triviaSettings();
    const [questions, winners, rounds, totals] = await Promise.all([
      TriviaQuestion.find().sort({ createdAt: -1 }).lean(),
      TriviaAttempt.find({ result: "correct" })
        .sort({ submittedAt: -1 })
        .limit(300)
        .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string; emailVerified?: boolean } | null }>("user", "name email phone emailVerified")
        .populate<{ question: { text: string } | null }>("question", "text")
        .lean(),
      TriviaRound.find().sort({ number: -1 }).limit(20).lean(),
      TriviaAttempt.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$result", n: { $sum: 1 } } }]),
    ]);
    // Everyone in those rounds, to show who answered what
    const roundAttempts = await TriviaAttempt.find({ round: { $in: rounds.map((r) => r._id) } })
      .populate<{ question: { text: string } | null }>("question", "text")
      .populate<{ user: { _id: Types.ObjectId; name?: string } | null }>("user", "name")
      .lean();
    // Same network as another player in the same round (could be one person on several accounts)
    const ipKey = (a: { round: Types.ObjectId; ip?: string }) => (a.ip ? `${String(a.round)}|${a.ip}` : "");
    const ipCount = new Map<string, number>();
    for (const a of roundAttempts) if (ipKey(a)) ipCount.set(ipKey(a), (ipCount.get(ipKey(a)) ?? 0) + 1);
    const winnerIpCount = new Map<string, number>();
    const winnerKeys = await TriviaAttempt.find({ round: { $in: winners.map((w) => w.round) } }).select("round ip").lean();
    for (const a of winnerKeys) if (ipKey(a)) winnerIpCount.set(ipKey(a), (winnerIpCount.get(ipKey(a)) ?? 0) + 1);

    const secs = (a: { submittedAt?: Date | null; assignedAt: Date }) =>
      a.submittedAt ? Math.max(1, Math.round((new Date(a.submittedAt).getTime() - new Date(a.assignedAt).getTime()) / 1000)) : null;
    const count = (r: string) => totals.find((t) => t._id === r)?.n ?? 0;
    res.json({
      settings: s,
      lobby: lobbyView(),
      totals: {
        rounds: await TriviaRound.estimatedDocumentCount(),
        attempts: totals.reduce((sum, t) => sum + t.n, 0),
        correct: count("correct"),
        wrong: count("wrong"),
        unanswered: count("unanswered"),
        live: count("pending"),
      },
      questions: questions.map((q) => ({
        id: String(q._id),
        text: q.text,
        answers: q.answers,
        active: q.active,
        asked: q.asked,
        correct: q.correct,
      })),
      winners: winners.map((w) => ({
        id: String(w._id),
        round: w.roundNumber,
        name: w.user?.name ?? w.name,
        email: w.user?.email ?? null,
        phone: w.user?.phone ?? null,
        emailConfirmed: Boolean(w.user?.emailVerified),
        userId: w.user ? String(w.user._id) : null,
        question: w.question?.text ?? "(deleted question)",
        answer: w.answer ?? "",
        seconds: secs(w),
        at: w.submittedAt,
        overridden: w.overridden,
        sharedNetwork: (winnerIpCount.get(ipKey(w)) ?? 0) > 1,
        paidGhs: w.paidGhs ?? null,
        paidNote: w.paidNote ?? null,
        paidAt: w.paidAt ?? null,
      })),
      rounds: rounds.map((r) => ({
        number: r.number,
        startedAt: r.startedAt,
        endsAt: r.endsAt,
        players: r.players,
        attempts: roundAttempts
          .filter((a) => String(a.round) === String(r._id))
          .map((a) => ({
            id: String(a._id),
            name: a.user?.name || a.name, // full name for DMY (the board shows the short one)
            question: a.question?.text ?? "(deleted question)",
            answer: a.answer ?? null,
            result: a.result,
            seconds: secs(a),
            overridden: a.overridden,
            sharedNetwork: (ipCount.get(ipKey(a)) ?? 0) > 1,
          })),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/trivia/settings { open?, minPlayers?, seconds?, prizeGhs?, requireConfirmedEmail? } */
export async function adminTriviaSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    const set: Record<string, unknown> = {};
    if (typeof b.open === "boolean") set.open = b.open;
    if (typeof b.requireConfirmedEmail === "boolean") set.requireConfirmedEmail = b.requireConfirmedEmail;
    const num = (v: unknown, min: number, max: number, label: string) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, `${label} must be between ${min} and ${max}`);
      return n;
    };
    if (b.minPlayers !== undefined) set.minPlayers = num(b.minPlayers, 2, 500, "Players needed");
    if (b.seconds !== undefined) set.seconds = num(b.seconds, 20, 600, "Seconds to answer");
    if (b.prizeGhs !== undefined) set.prizeGhs = num(b.prizeGhs, 0, 1000000, "Prize");
    await TriviaSettings.updateOne({ _id: "settings" }, { $set: set }, { upsert: true });
    forgetTriviaSettings();
    res.json(await triviaSettings());
  } catch (err) {
    next(err);
  }
}

const answersFrom = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/))
    .map((a) => String(a).trim())
    .filter(Boolean)
    .slice(0, 20);

/** POST /api/admin/trivia/questions { text, answers (one per line), active } */
export async function adminCreateQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    const text = String(req.body?.text ?? "").trim();
    const answers = answersFrom(req.body?.answers);
    if (text.length < 5) throw httpError(400, "Write the question");
    if (!answers.length) throw httpError(400, "Add at least one accepted answer");
    const q = await TriviaQuestion.create({ text, answers, active: req.body?.active !== false });
    forgetActiveQuestions();
    res.status(201).json({ id: String(q._id) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/trivia/questions/:id { text?, answers?, active? } */
export async function adminUpdateQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid id");
    const set: Record<string, unknown> = {};
    if (req.body?.text !== undefined) {
      const text = String(req.body.text).trim();
      if (text.length < 5) throw httpError(400, "Write the question");
      set.text = text;
    }
    if (req.body?.answers !== undefined) {
      const answers = answersFrom(req.body.answers);
      if (!answers.length) throw httpError(400, "Add at least one accepted answer");
      set.answers = answers;
    }
    if (typeof req.body?.active === "boolean") set.active = req.body.active;
    const q = await TriviaQuestion.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!q) throw httpError(404, "Question not found");
    forgetActiveQuestions();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/trivia/questions/:id — only a question nobody has been given (otherwise switch it off). */
export async function adminDeleteQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid id");
    if (await TriviaAttempt.exists({ question: req.params.id })) {
      throw httpError(409, "Players have already had this question — switch it off instead, so their results stay");
    }
    await TriviaQuestion.deleteOne({ _id: req.params.id });
    forgetActiveQuestions();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/trivia/attempts/:id { result?: "correct" | "wrong", paidGhs?, paidNote? }
 * Mark an answer right or wrong by hand, or record a prize payment.
 */
export async function adminUpdateAttempt(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid id");
    const a = await TriviaAttempt.findById(req.params.id);
    if (!a) throw httpError(404, "Answer not found");
    const b = req.body ?? {};
    if (b.result === "correct" || b.result === "wrong") {
      if (a.result === "pending") throw httpError(409, "This question is still live");
      if (a.result !== b.result) {
        if (a.result === "correct") await TriviaQuestion.updateOne({ _id: a.question }, { $inc: { correct: -1 } });
        if (b.result === "correct") await TriviaQuestion.updateOne({ _id: a.question }, { $inc: { correct: 1 } });
        a.result = b.result;
        a.overridden = true;
      }
    }
    if (b.paidGhs !== undefined) {
      const paid = b.paidGhs === null || b.paidGhs === "" ? null : Number(b.paidGhs);
      if (paid !== null && !(paid >= 0)) throw httpError(400, "Enter the amount paid");
      a.paidGhs = paid;
      a.paidAt = paid === null ? null : new Date();
      a.paidNote = String(b.paidNote ?? "").trim().slice(0, 200) || undefined;
    }
    await a.save();
    boardCache = null;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
