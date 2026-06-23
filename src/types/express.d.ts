import "express";

declare global {
  namespace Express {
    interface Request {
      /** Raw request body buffer, captured for Paystack webhook HMAC verification. */
      rawBody?: Buffer;
      /** Set by requireAdmin once a valid admin JWT is verified. */
      admin?: { email: string };
    }
  }
}

export {};
