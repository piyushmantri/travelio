import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { auth } from "./firebase";
import "./App.css";

type AuthPhase = "idle" | "loading" | "authenticated" | "error";
type AuthMode = "sign-in" | "sign-up";

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

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setPhase(user ? "authenticated" : "idle");
    });

    return unsubscribe;
  }, []);

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

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Travelio</h1>
        <p className="app-subtitle">Plan itineraries securely with your Travelio account.</p>
      </header>

      {currentUser ? (
        <section className="card auth-card">
          <h2>Welcome back</h2>
          <p className="auth-message">
            Signed in as <strong>{currentUser.email ?? currentUser.uid}</strong>.
          </p>
          <button className="secondary" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </section>
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
