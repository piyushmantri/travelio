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
  createdAt: FirestoreTimestamp | null;
  travellers: {
    males: number;
    females: number;
    kids: number;
  };
  startDate: string | null;
  endDate: string | null;
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

const coerceTravellerCount = (value: unknown): number => {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.floor(numericValue);
};

const normalizeDateInput = (value: string): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Expect YYYY-MM-DD from native date input
  const matches = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  return matches ? trimmed : null;
};

const formatDateRange = (startDate: string | null, endDate: string | null): string => {
  if (!startDate && !endDate) {
    return "Dates not set";
  }

  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  const safeFormat = (value: string | null): string | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : formatter.format(date);
  };

  const formattedStart = safeFormat(startDate);
  const formattedEnd = safeFormat(endDate);

  if (formattedStart && formattedEnd) {
    return `${formattedStart} – ${formattedEnd}`;
  }

  if (formattedStart) {
    return `${formattedStart}`;
  }

  if (formattedEnd) {
    return `${formattedEnd}`;
  }

  return "Dates not set";
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
  const [newItineraryTravellers, setNewItineraryTravellers] = useState({
    males: 0,
    females: 0,
    kids: 0,
  });
  const [newItineraryDates, setNewItineraryDates] = useState({
    startDate: "",
    endDate: "",
  });
  const [isCreatingItinerary, setIsCreatingItinerary] = useState(false);
  const [isItineraryFormVisible, setIsItineraryFormVisible] = useState(false);
  const [editingItineraryId, setEditingItineraryId] = useState<string | null>(null);
  const [editItineraryDraft, setEditItineraryDraft] = useState({
    males: 0,
    females: 0,
    kids: 0,
    startDate: "",
    endDate: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
      setNewItineraryTravellers({ males: 0, females: 0, kids: 0 });
      setNewItineraryDates({ startDate: "", endDate: "" });
      setIsItineraryFormVisible(false);
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
                const travellersData =
                  data && typeof data.travellers === "object"
                    ? (data.travellers as Record<string, unknown>)
                    : {};

                return {
                  id: docSnapshot.id,
                  title:
                    typeof data.title === "string" && data.title.trim()
                      ? data.title
                      : "Untitled itinerary",
                  createdAt: asTimestamp(data.createdAt),
                  travellers: {
                    males: coerceTravellerCount(travellersData.males),
                    females: coerceTravellerCount(travellersData.females),
                    kids: coerceTravellerCount(travellersData.kids),
                  },
                  startDate:
                    typeof data.startDate === "string"
                      ? normalizeDateInput(data.startDate) ?? null
                      : null,
                  endDate:
                    typeof data.endDate === "string"
                      ? normalizeDateInput(data.endDate) ?? null
                      : null,
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

    const trimmedTitle = newItineraryTitle.trim();

    if (!trimmedTitle) {
      setItineraryError("Itinerary name is required.");
      return;
    }

    const normalizedStart = normalizeDateInput(newItineraryDates.startDate);
    const normalizedEnd = normalizeDateInput(newItineraryDates.endDate);

    if (!normalizedStart || !normalizedEnd) {
      setItineraryError("Please provide both start and end dates for the trip.");
      return;
    }

    if (new Date(normalizedStart) > new Date(normalizedEnd)) {
      setItineraryError("Trip end date should be after the start date.");
      return;
    }

    const travellers = {
      males: coerceTravellerCount(newItineraryTravellers.males),
      females: coerceTravellerCount(newItineraryTravellers.females),
      kids: coerceTravellerCount(newItineraryTravellers.kids),
    };

    setIsCreatingItinerary(true);
    setItineraryError(null);

    try {
      const [{ addDoc, collection, serverTimestamp }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      await addDoc(collection(firestore, "itineraries"), {
        title: trimmedTitle,
        ownerUid: currentUser.uid,
        travellers,
        startDate: normalizedStart,
        endDate: normalizedEnd,
        createdAt: serverTimestamp(),
      });

      setNewItineraryTitle("");
      setNewItineraryTravellers({ males: 0, females: 0, kids: 0 });
      setNewItineraryDates({ startDate: "", endDate: "" });
      setIsItineraryFormVisible(false);
    } catch (error) {
      setItineraryError(deriveReadableError(error));
    } finally {
      setIsCreatingItinerary(false);
    }
  };

  const beginEditItinerary = (itinerary: Itinerary) => {
    setEditingItineraryId(itinerary.id);
    setEditItineraryDraft({
      males: itinerary.travellers.males,
      females: itinerary.travellers.females,
      kids: itinerary.travellers.kids,
      startDate: itinerary.startDate ?? "",
      endDate: itinerary.endDate ?? "",
    });
    setEditError(null);
  };

  const cancelEditItinerary = () => {
    setEditingItineraryId(null);
    setEditError(null);
    setEditItineraryDraft({ males: 0, females: 0, kids: 0, startDate: "", endDate: "" });
  };

  const handleUpdateItinerary = async (
    event: FormEvent<HTMLFormElement>,
    itineraryId: string
  ) => {
    event.preventDefault();

    if (!currentUser) {
      setEditError("You need to be signed in to update an itinerary.");
      return;
    }

    const normalizedStart = normalizeDateInput(editItineraryDraft.startDate);
    const normalizedEnd = normalizeDateInput(editItineraryDraft.endDate);

    if (!normalizedStart || !normalizedEnd) {
      setEditError("Please include both start and end dates.");
      return;
    }

    if (new Date(normalizedStart) > new Date(normalizedEnd)) {
      setEditError("Trip end date should be after the start date.");
      return;
    }

    const travellers = {
      males: coerceTravellerCount(editItineraryDraft.males),
      females: coerceTravellerCount(editItineraryDraft.females),
      kids: coerceTravellerCount(editItineraryDraft.kids),
    };

    setEditSaving(true);
    setEditError(null);

    try {
      const [{ doc, updateDoc }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      const itineraryRef = doc(firestore, "itineraries", itineraryId);
      await updateDoc(itineraryRef, {
        travellers,
        startDate: normalizedStart,
        endDate: normalizedEnd,
      });

      cancelEditItinerary();
    } catch (error) {
      setEditError(deriveReadableError(error));
    } finally {
      setEditSaving(false);
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
              <div className="itinerary-actions">
                <span className="badge">{itineraries.length}</span>
                <button
                  className="primary"
                  type="button"
                  onClick={() => {
                    setIsItineraryFormVisible((visible) => !visible);
                    setItineraryError(null);
                  }}
                  disabled={isCreatingItinerary}
                >
                  {isItineraryFormVisible ? "Close" : "New itinerary"}
                </button>
              </div>
            </div>

            {isItineraryFormVisible ? (
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

                <div className="date-grid">
                  <label className="field compact-field">
                    <span>Start date</span>
                    <input
                      type="date"
                      name="trip-start"
                      value={newItineraryDates.startDate}
                      onChange={(event) =>
                        setNewItineraryDates((prev) => ({
                          ...prev,
                          startDate: event.target.value,
                        }))
                      }
                      required
                      disabled={isCreatingItinerary}
                    />
                  </label>

                  <label className="field compact-field">
                    <span>End date</span>
                    <input
                      type="date"
                      name="trip-end"
                      value={newItineraryDates.endDate}
                      onChange={(event) =>
                        setNewItineraryDates((prev) => ({
                          ...prev,
                          endDate: event.target.value,
                        }))
                      }
                      required
                      disabled={isCreatingItinerary}
                    />
                  </label>
                </div>

                <div className="traveller-grid">
                  <label className="field compact-field">
                    <span>Males</span>
                    <input
                      type="number"
                      min={0}
                      name="traveller-males"
                      value={newItineraryTravellers.males}
                      onChange={(event) =>
                        setNewItineraryTravellers((prev) => ({
                          ...prev,
                          males: coerceTravellerCount(event.target.value),
                        }))
                      }
                      disabled={isCreatingItinerary}
                      inputMode="numeric"
                      pattern="\\d*"
                    />
                  </label>

                  <label className="field compact-field">
                    <span>Females</span>
                    <input
                      type="number"
                      min={0}
                      name="traveller-females"
                      value={newItineraryTravellers.females}
                      onChange={(event) =>
                        setNewItineraryTravellers((prev) => ({
                          ...prev,
                          females: coerceTravellerCount(event.target.value),
                        }))
                      }
                      disabled={isCreatingItinerary}
                      inputMode="numeric"
                      pattern="\\d*"
                    />
                  </label>

                  <label className="field compact-field">
                    <span>Kids</span>
                    <input
                      type="number"
                      min={0}
                      name="traveller-kids"
                      value={newItineraryTravellers.kids}
                      onChange={(event) =>
                        setNewItineraryTravellers((prev) => ({
                          ...prev,
                          kids: coerceTravellerCount(event.target.value),
                        }))
                      }
                      disabled={isCreatingItinerary}
                      inputMode="numeric"
                      pattern="\\d*"
                    />
                  </label>
                </div>

                <button className="primary" type="submit" disabled={isCreatingItinerary}>
                  {isCreatingItinerary ? "Saving..." : "Create itinerary"}
                </button>
              </form>
            ) : null}

            {itineraryError ? (
              <p className="error" role="alert">
                {itineraryError}
              </p>
            ) : itinerariesLoading ? (
              <p className="muted">Loading itineraries...</p>
            ) : itineraries.length ? (
              <div className="itinerary-grid">
                {itineraries.map((itinerary) => (
                  <article key={itinerary.id} className="itinerary-card-item">
                    <div className="itinerary-card-heading">
                      <h3>{itinerary.title}</h3>
                      {formatTimestamp(itinerary.createdAt) ? (
                        <span className="pill">
                          {formatTimestamp(itinerary.createdAt)}
                        </span>
                      ) : null}
                    </div>

                    <p className="date-range" aria-label="Trip dates">
                      {formatDateRange(itinerary.startDate, itinerary.endDate)}
                    </p>

                    <ul className="traveller-summary" aria-label="Traveller breakdown">
                      <li>
                        <span className="traveller-label">Males</span>
                        <span className="traveller-count">{itinerary.travellers.males}</span>
                      </li>
                      <li>
                        <span className="traveller-label">Females</span>
                        <span className="traveller-count">{itinerary.travellers.females}</span>
                      </li>
                      <li>
                        <span className="traveller-label">Kids</span>
                        <span className="traveller-count">{itinerary.travellers.kids}</span>
                      </li>
                    </ul>

                    {editingItineraryId === itinerary.id ? (
                      <form
                        className="itinerary-edit-form"
                        onSubmit={(event) => handleUpdateItinerary(event, itinerary.id)}
                      >
                        <div className="date-grid">
                          <label className="field compact-field">
                            <span>Start date</span>
                            <input
                              type="date"
                              value={editItineraryDraft.startDate}
                              onChange={(event) =>
                                setEditItineraryDraft((prev) => ({
                                  ...prev,
                                  startDate: event.target.value,
                                }))
                              }
                              disabled={editSaving}
                              required
                            />
                          </label>
                          <label className="field compact-field">
                            <span>End date</span>
                            <input
                              type="date"
                              value={editItineraryDraft.endDate}
                              onChange={(event) =>
                                setEditItineraryDraft((prev) => ({
                                  ...prev,
                                  endDate: event.target.value,
                                }))
                              }
                              disabled={editSaving}
                              required
                            />
                          </label>
                        </div>

                        <div className="traveller-grid">
                          <label className="field compact-field">
                            <span>Males</span>
                            <input
                              type="number"
                              min={0}
                              value={editItineraryDraft.males}
                              onChange={(event) =>
                                setEditItineraryDraft((prev) => ({
                                  ...prev,
                                  males: coerceTravellerCount(event.target.value),
                                }))
                              }
                              disabled={editSaving}
                              inputMode="numeric"
                              pattern="\\d*"
                            />
                          </label>
                          <label className="field compact-field">
                            <span>Females</span>
                            <input
                              type="number"
                              min={0}
                              value={editItineraryDraft.females}
                              onChange={(event) =>
                                setEditItineraryDraft((prev) => ({
                                  ...prev,
                                  females: coerceTravellerCount(event.target.value),
                                }))
                              }
                              disabled={editSaving}
                              inputMode="numeric"
                              pattern="\\d*"
                            />
                          </label>
                          <label className="field compact-field">
                            <span>Kids</span>
                            <input
                              type="number"
                              min={0}
                              value={editItineraryDraft.kids}
                              onChange={(event) =>
                                setEditItineraryDraft((prev) => ({
                                  ...prev,
                                  kids: coerceTravellerCount(event.target.value),
                                }))
                              }
                              disabled={editSaving}
                              inputMode="numeric"
                              pattern="\\d*"
                            />
                          </label>
                        </div>

                        {editError ? (
                          <p className="error" role="alert">
                            {editError}
                          </p>
                        ) : null}

                        <div className="edit-actions">
                          <button className="primary" type="submit" disabled={editSaving}>
                            {editSaving ? "Saving..." : "Save"}
                          </button>
                          <button
                            className="secondary"
                            type="button"
                            onClick={cancelEditItinerary}
                            disabled={editSaving}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="card-actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => beginEditItinerary(itinerary)}
                        >
                          Edit details
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">
                No itineraries yet. Use the button above to create one.
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
