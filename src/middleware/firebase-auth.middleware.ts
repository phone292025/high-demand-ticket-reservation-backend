import { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError";
import { FirebaseAuthVerifier, FirebaseUser } from "../auth/firebase-admin";

export interface AuthenticatedRequest extends Request {
  authUser: FirebaseUser;
}

export function requireFirebaseAuth(verifier: FirebaseAuthVerifier | undefined) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      if (!verifier) {
        throw new AppError(
          503,
          "FIREBASE_NOT_CONFIGURED",
          "Firebase authentication is not configured"
        );
      }

      const authorization = request.header("Authorization");
      const match = authorization?.match(/^Bearer\s+(.+)$/i);

      if (!match) {
        throw new AppError(401, "UNAUTHORIZED", "Missing Firebase ID token");
      }

      (request as AuthenticatedRequest).authUser = await verifier.verifyIdToken(
        match[1]
      );
      next();
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }

      next(new AppError(401, "UNAUTHORIZED", "Invalid Firebase ID token"));
    }
  };
}
