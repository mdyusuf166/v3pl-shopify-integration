import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, inMemoryPersistence, setPersistence, type Auth } from "firebase/auth";

/**
 * Firebase client SDK — used only on the login screens to obtain an ID token,
 * which is immediately exchanged for a server-side session cookie.
 * Persistence is in-memory: the browser never keeps a Firebase session.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseClientConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}

function firebaseClientApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

let authInstance: Auth | undefined;

export async function firebaseClientAuth(): Promise<Auth> {
  if (!authInstance) {
    authInstance = getAuth(firebaseClientApp());
    await setPersistence(authInstance, inMemoryPersistence);
  }
  return authInstance;
}
