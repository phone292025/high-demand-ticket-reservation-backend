import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { DecodedIdToken, getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";

export interface FirebaseUser {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface FirebaseAuthVerifier {
  verifyIdToken(idToken: string): Promise<FirebaseUser>;
}

export interface PublicFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  vapidKey: string;
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n");
}

export function getPublicFirebaseConfig(): Partial<PublicFirebaseConfig> {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    vapidKey: process.env.FIREBASE_VAPID_KEY
  };
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

export function createFirebaseAuthVerifier(): FirebaseAuthVerifier | undefined {
  if (!initializeFirebaseAdmin()) {
    return undefined;
  }

  const auth = getAuth();
  return {
    async verifyIdToken(idToken: string): Promise<FirebaseUser> {
      const decodedToken: DecodedIdToken = await auth.verifyIdToken(idToken);
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
