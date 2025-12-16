import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { auth, getFirestoreInstance, loadFirestore } from "./firebase";
import "./App.css";

type FirestoreTimestamp = import("firebase/firestore").Timestamp;
type Unsubscribe = import("firebase/firestore").Unsubscribe;

type AuthPhase = "idle" | "loading" | "authenticated" | "error";
type AuthMode = "sign-in" | "sign-up";
type Itinerary = {
  id: string;
  title: string;
  description: string;
  createdAt: FirestoreTimestamp | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatTimestamp = (timestamp: FirestoreTimestamp | null): string => {
  if (!timestamp) return "";
  try {
    return timestampFormatter.format(timestamp.toDate());
  } catch (error) {
    console.error("Failed to format timestamp", error);
    return "";
  }
};

const deriveReadableError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Something went wrong while processing your request.";
};

const loadFirestoreModule = loadFirestore;

const asTimestamp = (value: unknown): FirestoreTimestamp | null => {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return value as FirestoreTimestamp;
  }

  return null;
};

function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<AuthPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [profileName, setProfileName] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [itinerariesLoading, setItinerariesLoading] = useState(false);
  const [itineraryError, setItineraryError] = useState<string | null>(null);
  const [newItineraryTitle, setNewItineraryTitle] = useState("");
  const [newItineraryNotes, setNewItineraryNotes] = useState("");
  const [isCreatingItinerary, setIsCreatingItinerary] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setPhase(user ? "authenticated" : "idle");
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!currentUser) {
      setProfileName(null);
      setProfileDraft("");
      setProfileLoading(false);
      setProfileSaving(false);
      setProfileMessage(null);
      setProfileError(null);
      setShowProfileEditor(false);
      return;
    }

    setProfileLoading(true);

    let unsubscribe: Unsubscribe | undefined;
    let isActive = true;

    loadFirestoreModule()
      .then(async (module) => {
        if (!isActive) {
          return;
        }

        const { doc, onSnapshot } = module;
        const firestore = await getFirestoreInstance();
        const profileRef = doc(firestore, "profiles", currentUser.uid);

        unsubscribe = onSnapshot(
          profileRef,
          (snapshot) => {
            if (!snapshot.exists()) {
              setProfileName(null);
              setProfileDraft("");
              setProfileLoading(false);
              setProfileError(null);
              return;
            }

            const data = snapshot.data();
            const rawName =
              data && typeof data.displayName === "string"
                ? data.displayName
                : "";
            const normalized = rawName.trim();

            setProfileName(normalized || null);
            setProfileDraft(normalized);
            setProfileLoading(false);
            setProfileError(null);
          },
          (error) => {
            setProfileError(deriveReadableError(error));
            setProfileLoading(false);
          }
        );
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        setProfileError(deriveReadableError(error));
        setProfileLoading(false);
      });

    return () => {
      isActive = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [currentUser]);

  useEffect(() => {
    if (!profileMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setProfileMessage(null);
    }, 3000);

    return () => window.clearTimeout(timeout);
  }, [profileMessage]);

  useEffect(() => {
    if (!currentUser) {
      setItineraries([]);
      setItinerariesLoading(false);
      setItineraryError(null);
      setNewItineraryTitle("");
      setNewItineraryNotes("");
      return;
    }

    setItinerariesLoading(true);

    let unsubscribe: Unsubscribe | undefined;
    let isActive = true;

    loadFirestoreModule()
      .then(async ({ collection, query, where, onSnapshot }) => {
        if (!isActive) {
          return;
        }

        const firestore = await getFirestoreInstance();
        const userItinerariesQuery = query(
          collection(firestore, "itineraries"),
          where("ownerUid", "==", currentUser.uid)
        );

        unsubscribe = onSnapshot(
          userItinerariesQuery,
          (snapshot) => {
            const mapped = snapshot.docs
              .map((docSnapshot) => {
                const data = docSnapshot.data();

                return {
                  id: docSnapshot.id,
                  title:
                    typeof data.title === "string" && data.title.trim()
                      ? data.title
                      : "Untitled itinerary",
                  description:
                    typeof data.description === "string" ? data.description : "",
                  createdAt: asTimestamp(data.createdAt),
                } satisfies Itinerary;
              })
              .sort((first, second) => {
                const firstTime = first.createdAt ? first.createdAt.toMillis() : 0;
                const secondTime = second.createdAt ? second.createdAt.toMillis() : 0;
                return secondTime - firstTime;
              });

            setItineraries(mapped);
            setItineraryError(null);
            setItinerariesLoading(false);
          },
          (error) => {
            setItineraryError(deriveReadableError(error));
            setItineraries([]);
            setItinerariesLoading(false);
          }
        );
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }

        setItineraryError(deriveReadableError(error));
        setItineraries([]);
        setItinerariesLoading(false);
      });

    return () => {
      isActive = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [currentUser]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPhase("loading");
    setErrorMessage(null);

    try {
      if (mode === "sign-in") {
        await signInWithEmailAndPassword(auth, username, password);
      } else {
        await createUserWithEmailAndPassword(auth, username, password);
      }
    } catch (error) {
      setPhase("error");
      setErrorMessage(deriveReadableError(error));
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setPhase("idle");
    } catch (error) {
      setErrorMessage(deriveReadableError(error));
      setPhase("error");
    }
  };

  const toggleMode = () => {
    setUsername("");
    setPassword("");
    setErrorMessage(null);
    setMode((prevMode) => (prevMode === "sign-in" ? "sign-up" : "sign-in"));
  };

  const isAuthenticating = phase === "loading";
  const isSignUp = mode === "sign-up";

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!currentUser) {
      setProfileError("You need to be signed in to update your name.");
      return;
    }

    const trimmed = profileDraft.trim();

    if (!trimmed) {
      setProfileError("Please tell us what to call you.");
      return;
    }

    if (trimmed === (profileName?.trim() ?? "")) {
      setProfileMessage("Saved!");
      return;
    }

    setProfileSaving(true);
    setProfileError(null);
    setProfileMessage(null);

    try {
      const [{ doc, setDoc }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      const profileRef = doc(firestore, "profiles", currentUser.uid);
      await setDoc(profileRef, { displayName: trimmed }, { merge: true });

      setProfileName(trimmed);
      setProfileDraft(trimmed);
      setProfileMessage("Saved!");
    } catch (error) {
      setProfileError(deriveReadableError(error));
    } finally {
      setProfileSaving(false);
      setShowProfileEditor(false);
    }
  };

  const handleCreateItinerary = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (!currentUser) {
      setItineraryError("You need to be signed in to create an itinerary.");
      return;
    }

    setIsCreatingItinerary(true);
    setItineraryError(null);

    try {
      const [{ addDoc, collection, serverTimestamp }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      await addDoc(collection(firestore, "itineraries"), {
        title: newItineraryTitle.trim(),
        description: newItineraryNotes.trim(),
        ownerUid: currentUser.uid,
        createdAt: serverTimestamp(),
      });

      setNewItineraryTitle("");
      setNewItineraryNotes("");
    } catch (error) {
      setItineraryError(deriveReadableError(error));
    } finally {
      setIsCreatingItinerary(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Travelio</h1>
        <p className="app-subtitle">Plan itineraries securely with your Travelio account.</p>
      </header>

      {currentUser ? (
        <>
          <header className="signed-in-header">
            <div>
              <p className="signed-in-label">Travelio dashboard</p>
              <p className="signed-in-greeting">
                Hi
                {" "}
                {profileName?.trim() || currentUser.displayName?.trim() || currentUser.email || currentUser.uid}
              </p>
            </div>
            <div className="signed-in-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setShowProfileEditor((visible) => !visible);
                  setProfileMessage(null);
                  setProfileError(null);
                  setProfileDraft(profileName ?? "");
                }}
              >
                {showProfileEditor ? "Close" : "Edit profile"}
              </button>
              <button className="secondary" type="button" onClick={handleSignOut}>
                Sign out
              </button>
            </div>
          </header>

          {showProfileEditor ? (
            <section className="profile-panel" aria-live="polite">
              <form className="profile-form" onSubmit={handleProfileSubmit}>
                <label className="field profile-field">
                  <span>What should we call you?</span>
                  <input
                    type="text"
                    name="displayName"
                    placeholder="Add a friendly name"
                    value={profileDraft}
                    onChange={(event) => setProfileDraft(event.target.value)}
                    disabled={profileLoading || profileSaving}
                    required
                  />
                </label>
                <button
                  className="secondary"
                  type="submit"
                  disabled={profileLoading || profileSaving}
                >
                  {profileSaving ? "Saving..." : "Save name"}
                </button>
              </form>

              {profileError ? (
                <p className="error" role="alert">
                  {profileError}
                </p>
              ) : profileMessage ? (
                <p className="profile-status" role="status">
                  {profileMessage}
                </p>
              ) : profileLoading ? (
                <p className="muted">Loading profile...</p>
              ) : null}
            </section>
          ) : null}

          <section className="card itinerary-card" aria-live="polite">
            <div className="section-heading">
              <h2>Your itineraries</h2>
              <span className="badge">{itineraries.length}</span>
            </div>

            <form className="itinerary-form" onSubmit={handleCreateItinerary}>
              <label className="field">
                <span>Itinerary name</span>
                <input
                  type="text"
                  name="itinerary-title"
                  placeholder="Weekend getaway to Kyoto"
                  value={newItineraryTitle}
                  onChange={(event) => setNewItineraryTitle(event.target.value)}
                  required
                  disabled={isCreatingItinerary}
                />
              </label>

              <label className="field">
                <span>Notes</span>
                <textarea
                  name="itinerary-notes"
                  placeholder="Add a quick summary or highlight key stops."
                  value={newItineraryNotes}
                  onChange={(event) => setNewItineraryNotes(event.target.value)}
                  rows={4}
                  disabled={isCreatingItinerary}
                />
              </label>

              <button className="primary" type="submit" disabled={isCreatingItinerary}>
                {isCreatingItinerary ? "Saving..." : "Create itinerary"}
              </button>
            </form>

            {itineraryError ? (
              <p className="error" role="alert">
                {itineraryError}
              </p>
            ) : null}

            {itinerariesLoading ? (
              <p className="muted">Loading itineraries...</p>
            ) : itineraries.length ? (
              <ul className="itinerary-list">
                {itineraries.map((itinerary) => (
                  <li key={itinerary.id} className="itinerary-item">
                    <div className="itinerary-title-row">
                      <h3>{itinerary.title}</h3>
                      {formatTimestamp(itinerary.createdAt) ? (
                        <span className="pill">
                          {formatTimestamp(itinerary.createdAt)}
                        </span>
                      ) : null}
                    </div>
                    {itinerary.description ? (
                      <p className="itinerary-notes">{itinerary.description}</p>
                    ) : (
                      <p className="muted">No notes added yet.</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">
                No itineraries yet. Create your first plan using the form above.
              </p>
            )}
          </section>
        </>
      ) : (
        <section className="card auth-card" aria-live="polite">
          <form className="auth-form" onSubmit={handleSubmit}>
            <h2>{isSignUp ? "Create an account" : "Sign in"}</h2>
            <p className="form-helper">
              {isSignUp
                ? "Enter your email and a strong password to register a new Travelio account."
                : "Use the credentials configured in Google Cloud Identity Platform."}
            </p>

            <label className="field">
              <span>Email</span>
              <input
                type="email"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="you@example.com"
                required
                disabled={isAuthenticating}
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete={isSignUp ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={isAuthenticating}
              />
            </label>

            {isSignUp ? (
              <p className="form-note">
                Passwords must meet the policy you configure in Identity Platform.
              </p>
            ) : null}

            {errorMessage ? (
              <p className="error" role="alert">
                {errorMessage}
              </p>
            ) : null}

            <button className="primary" type="submit" disabled={isAuthenticating}>
              {isAuthenticating
                ? "Processing..."
                : isSignUp
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          <p className="form-switch">
            {isSignUp ? "Already have an account?" : "Need a Travelio account?"}
            <button
              type="button"
              className="link-button"
              onClick={toggleMode}
              disabled={isAuthenticating}
            >
              {isSignUp ? "Sign in" : "Create one"}
            </button>
          </p>
        </section>
      )}

      <footer className="app-footer">
        <p>Authentication handled by Google Cloud Identity Platform.</p>
      </footer>
    </div>
  );
}

export default App;
