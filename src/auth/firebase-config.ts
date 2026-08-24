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

/**
 * Only the browser-safe Firebase web values. Kept free of `firebase-admin`
 * imports so the HTTP layer never loads the Admin SDK.
 */
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
