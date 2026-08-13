import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { env, isSmtpConfigured } from "../config/env";
import { User, IUser } from "../models/User";
import { signFanToken } from "../middleware/auth";
import { sendMail } from "../services/mailer";
import { renderEmail, renderText, type EmailContent } from "../services/emailTemplates";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** Store a fresh verification token on the user and return the confirmation link. */
async function setVerificationToken(user: IUser): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex");
  user.verifyTokenHash = sha256(raw);
  user.verifyTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await user.save();
  return `${env.clientUrl}/account/verify?token=${raw}`;
}

const verificationContent = (user: IUser, link: string): EmailContent => ({
  title: "Confirm your email",
  intro: `Hi${user.name ? ` ${user.name}` : ""}, confirm your email address to finish setting up your Dark Music Yard account.`,
  button: { label: "Confirm email", url: link },
  note: "This link is valid for 24 hours. If you didn't create an account, you can ignore this email.",
});

// Reward point values.
export const POINTS = {
  checkIn: 5, // per daily check-in
  referrer: 50, // to the inviter when their invitee signs up
  welcomeBonus: 25, // to a new fan who used a referral code
  perGhs: 1, // per GH₵ spent (awarded on paid orders)
};

const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const yesterdayOf = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

function publicUser(u: IUser) {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name ?? null,
    emailVerified: u.emailVerified,
    points: u.points,
    streak: u.streak,
    lastCheckIn: u.lastCheckIn ?? null,
    referralCode: u.referralCode,
    streamUntil: u.streamUntil ? u.streamUntil.toISOString() : null,
  };
}

/** POST /api/account/register */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, name } = req.body ?? {};
    if (!isEmail(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }
    const normalized = String(email).toLowerCase();
    if (await User.findOne({ email: normalized })) {
      return res.status(409).json({ message: "That email is already registered" });
    }
    const passwordHash = await bcrypt.hash(password, 10);

    // Credit the inviter (if a valid, different referral code was used) and give
    // the new fan a welcome bonus.
    const ref = typeof req.body?.ref === "string" ? req.body.ref.trim() : "";
    const referrer = ref ? await User.findOne({ referralCode: ref }) : null;

    // When email is configured, require confirmation; otherwise auto-verify so
    // the site still works without an SMTP setup.
    const needsVerification = isSmtpConfigured();
    const user = await User.create({
      email: normalized,
      passwordHash,
      name: typeof name === "string" ? name.trim() : undefined,
      emailVerified: !needsVerification,
      referralCode: crypto.randomBytes(5).toString("hex"),
      referredBy: referrer ? referrer.referralCode : undefined,
      points: referrer ? POINTS.welcomeBonus : 0,
    });

    if (referrer) {
      referrer.points += POINTS.referrer;
      await referrer.save();
    }

    if (needsVerification) {
      const link = await setVerificationToken(user);
      const content = verificationContent(user, link);
      // Fire-and-forget so a slow/broken SMTP never blocks the signup response.
      void sendMail(
        user.email,
        "Confirm your Dark Music Yard email",
        renderText(content),
        renderEmail(content)
      );
    }

    const token = signFanToken(String(user._id), user.email);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/login */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body ?? {};
    if (!isEmail(email) || typeof password !== "string") {
      return res.status(400).json({ message: "Email and password are required" });
    }
    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const token = signFanToken(String(user._id), user.email);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/account/me — current fan (requires a fan token). */
export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/verify — confirm an email address using the token. */
export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.body ?? {};
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ message: "Invalid verification link" });
    }
    const user = await User.findOne({
      verifyTokenHash: sha256(token),
      verifyTokenExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ message: "This link is invalid or has expired" });
    }
    user.emailVerified = true;
    user.verifyTokenHash = undefined;
    user.verifyTokenExpires = undefined;
    await user.save();
    res.json({ message: "Email confirmed. Thanks!" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/resend-verification — re-send the confirmation email. */
export async function resendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (user.emailVerified) return res.json({ message: "Your email is already confirmed." });
    if (!isSmtpConfigured()) {
      return res.status(503).json({ message: "Email isn't set up yet — please try again later." });
    }
    const link = await setVerificationToken(user);
    const content = verificationContent(user, link);
    const sent = await sendMail(
      user.email,
      "Confirm your Dark Music Yard email",
      renderText(content),
      renderEmail(content)
    );
    if (!sent) {
      return res.status(502).json({ message: "Couldn't send the email right now — please try again shortly." });
    }
    res.json({ message: "Confirmation email sent — check your inbox (and spam)." });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/password — change password (requires the current one). */
export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!(await bcrypt.compare(String(currentPassword ?? ""), user.passwordHash))) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: "Password changed" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/forgot — email a password-reset link (if the email exists). */
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body ?? {};
    // Always respond the same way so the endpoint can't be used to probe emails.
    const generic = { message: "If that email is registered, a reset link is on its way." };
    if (!isEmail(email)) return res.json(generic);

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (user) {
      const raw = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = sha256(raw);
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();

      const link = `${env.clientUrl}/account/reset?token=${raw}`;
      const content: EmailContent = {
        title: "Reset your password",
        intro: `Hi${user.name ? ` ${user.name}` : ""}, tap the button below to set a new password.`,
        button: { label: "Reset password", url: link },
        note: "This link is valid for 1 hour. If you didn't request this, you can ignore this email.",
      };
      void sendMail(
        user.email,
        "Reset your Dark Music Yard password",
        renderText(content),
        renderEmail(content)
      );
    }
    res.json(generic);
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/reset — set a new password using a valid reset token. */
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ message: "Invalid reset link" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }
    const user = await User.findOne({
      resetTokenHash: sha256(token),
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ message: "This reset link is invalid or has expired" });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    res.json({ message: "Password updated. You can now sign in." });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/checkin — award daily points (once per UTC day) + streak. */
export async function checkIn(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });

    const day = today();
    if (user.lastCheckIn === day) {
      return res.json({ awarded: 0, alreadyCheckedIn: true, user: publicUser(user) });
    }

    // Continue the streak only if the last check-in was yesterday; else reset.
    user.streak = user.lastCheckIn === yesterdayOf(day) ? user.streak + 1 : 1;
    user.lastCheckIn = day;
    user.points += POINTS.checkIn;
    await user.save();

    res.json({ awarded: POINTS.checkIn, alreadyCheckedIn: false, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}
