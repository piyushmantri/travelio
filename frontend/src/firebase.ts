import { initializeApp } from "firebase/app";
import type { FirebaseOptions } from "firebase/app";
import { getAuth } from "firebase/auth";

type Firestore = import("firebase/firestore").Firestore;
type FirestoreModule = typeof import("firebase/firestore");

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

Object.entries(firebaseConfig).forEach(([key, value]) => {
  if (!value) {
    throw new Error(`Missing Firebase environment value for ${key}`);
  }
});

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

let firestoreModulePromise: Promise<FirestoreModule> | null = null;
const loadFirestoreModule = () => {
  if (!firestoreModulePromise) {
    firestoreModulePromise = import("firebase/firestore");
  }

  return firestoreModulePromise;
};

let firestoreInstancePromise: Promise<Firestore> | null = null;

export const getFirestoreInstance = async (): Promise<Firestore> => {
  if (!firestoreInstancePromise) {
    firestoreInstancePromise = loadFirestoreModule().then(({ getFirestore }) =>
      getFirestore(app)
    );
  }

  return firestoreInstancePromise;
};

export const loadFirestore = loadFirestoreModule;
