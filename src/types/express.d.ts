import "express";

declare global {
  namespace Express {
    interface Request {
      /** Raw request body buffer, captured for Paystack webhook HMAC verification. */
      rawBody?: Buffer;
      /** Set by requireAdmin once a valid admin JWT is verified. */
      admin?: { email: string };
      /** Set by requireFan once a valid fan JWT is verified. */
      fan?: { id: string; email: string };
    }
  }
}

export {};
