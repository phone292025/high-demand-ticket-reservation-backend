import {
  applicationDefault,
  cert,
  getApps,
  initializeApp
} from "firebase-admin/app";
import type { DecodedIdToken } from "firebase-admin/auth";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import type { FirebaseAuthVerifier, FirebaseUser } from "./firebase-config";

export {
  FirebaseAuthVerifier,
  FirebaseUser,
  PublicFirebaseConfig,
  getPublicFirebaseConfig
} from "./firebase-config";

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

export function initializeFirebaseAdmin(): boolean {
  if (getApps().length > 0) {
    return true;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: normalizePrivateKey(privateKey)
      }),
      projectId
    });
    return true;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: applicationDefault(),
      projectId
    });
    return true;
  }

  return false;
}

/** Set FIREBASE_CHECK_REVOKED=false to skip the revocation lookup. */
function shouldCheckRevoked(): boolean {
  return process.env.FIREBASE_CHECK_REVOKED !== "false";
}

export function createFirebaseAuthVerifier(): FirebaseAuthVerifier | undefined {
  if (!initializeFirebaseAdmin()) {
    return undefined;
  }

  const auth = getAuth();
  const checkRevoked = shouldCheckRevoked();
  return {
    async verifyIdToken(idToken: string): Promise<FirebaseUser> {
      const decodedToken: DecodedIdToken = await auth.verifyIdToken(
        idToken,
        checkRevoked
      );
      return {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name: decodedToken.name,
        picture: decodedToken.picture
      };
    }
  };
}

export function getFirebaseMessagingOrUndefined() {
  if (!initializeFirebaseAdmin()) {
    return undefined;
  }

  return getMessaging();
}
