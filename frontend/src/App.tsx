import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";
import {
  Timestamp,
  addDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import "./App.css";

type AuthPhase = "idle" | "loading" | "authenticated" | "error";
type AuthMode = "sign-in" | "sign-up";
type Itinerary = {
  id: string;
  title: string;
  description: string;
  createdAt: Timestamp | null;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatTimestamp = (timestamp: Timestamp | null): string => {
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

function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<AuthPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [mode, setMode] = useState<AuthMode>("sign-in");
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
      setItineraries([]);
      setItinerariesLoading(false);
      setItineraryError(null);
      setNewItineraryTitle("");
      setNewItineraryNotes("");
      return;
    }

    setItinerariesLoading(true);
    const userItinerariesQuery = query(
      collection(db, "itineraries"),
      where("ownerUid", "==", currentUser.uid)
    );

    const unsubscribe = onSnapshot(
      userItinerariesQuery,
      (snapshot) => {
        const mapped = snapshot.docs
          .map((docSnapshot) => {
            const data = docSnapshot.data();
            const createdAtValue =
              data.createdAt instanceof Timestamp ? data.createdAt : null;

            return {
              id: docSnapshot.id,
              title:
                typeof data.title === "string" && data.title.trim()
                  ? data.title
                  : "Untitled itinerary",
              description:
                typeof data.description === "string" ? data.description : "",
              createdAt: createdAtValue,
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

    return unsubscribe;
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
      await addDoc(collection(db, "itineraries"), {
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
          <section className="card auth-card">
            <h2>Welcome back</h2>
            <p className="auth-message">
              Signed in as <strong>{currentUser.email ?? currentUser.uid}</strong>.
            </p>
            <button className="secondary" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          </section>

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
