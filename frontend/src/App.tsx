import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { auth, getFirestoreInstance, loadFirestore } from "./firebase";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
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

type ItineraryEvent = {
  id: string;
  title: string;
  description: string | null;
  startDateTime: string;
  endDateTime: string;
};

type ItineraryEventDraft = {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
};

type CalendarSelection = {
  startDate: string;
  startMinutes: number;
  endDate: string;
  endMinutes: number;
};

type CalendarSegment = {
  event: ItineraryEvent;
  segmentStartMinutes: number;
  segmentEndMinutes: number;
  isStartSegment: boolean;
  isEndSegment: boolean;
};

type CalendarLayoutSegment = CalendarSegment & {
  columnIndex: number;
  columnCount: number;
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

const HOUR_MARKERS = Array.from({ length: 24 }, (_, index) => index);
const CALENDAR_SLOT_HEIGHT_PX = 48;
const CALENDAR_FORM_WIDTH_PX = 320;
const CALENDAR_FORM_HEIGHT_PX = 320;
const CALENDAR_FORM_GUTTER_PX = 16;
const CALENDAR_EVENT_GUTTER_PX = 6;
const ISO_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const padTimeSegment = (value: number): string => String(value).padStart(2, "0");
const TOTAL_DAY_MINUTES = 24 * 60;
const MIN_EVENT_DURATION = 30;
const SELECTION_STEP_MINUTES = 30;

const clampMinutes = (value: number): number => Math.max(0, Math.min(TOTAL_DAY_MINUTES, value));

const roundToSelectionStep = (value: number): number =>
  Math.round(value / SELECTION_STEP_MINUTES) * SELECTION_STEP_MINUTES;

const formatHourLabel = (hour: number): string => {
  const period = hour >= 12 ? "PM" : "AM";
  const hourInTwelve = hour % 12 || 12;
  return `${hourInTwelve}:00 ${period}`;
};

const formatDateToIsoLocal = (date: Date): string => {
  return `${date.getFullYear()}-${padTimeSegment(date.getMonth() + 1)}-${padTimeSegment(date.getDate())}`;
};

const layoutSegmentsWithColumns = (segments: CalendarSegment[]): CalendarLayoutSegment[] => {
  if (segments.length === 0) {
    return [];
  }

  type WorkingSegment = CalendarLayoutSegment & { groupId: number };

  const laidOut: WorkingSegment[] = [];
  const active: WorkingSegment[] = [];
  const freeColumns: number[] = [];
  let nextColumnIndex = 0;
  let currentGroupId = 0;

  const groupMeta = new Map<number, { maxColumns: number; members: WorkingSegment[] }>();

  const releaseFinished = (startMinutes: number) => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].segmentEndMinutes <= startMinutes) {
        freeColumns.push(active[index].columnIndex);
        active.splice(index, 1);
      }
    }
  };

  segments.forEach((segment) => {
    releaseFinished(segment.segmentStartMinutes);

    if (active.length === 0) {
      freeColumns.length = 0;
      nextColumnIndex = 0;
      currentGroupId += 1;
    }

    const columnIndex = freeColumns.length ? freeColumns.pop()! : nextColumnIndex++;
    const workingSegment: WorkingSegment = {
      ...segment,
      columnIndex,
      columnCount: 1,
      groupId: currentGroupId,
    };

    active.push(workingSegment);
    laidOut.push(workingSegment);

    let meta = groupMeta.get(currentGroupId);
    if (!meta) {
      meta = { maxColumns: 0, members: [] };
      groupMeta.set(currentGroupId, meta);
    }

    if (columnIndex + 1 > meta.maxColumns) {
      meta.maxColumns = columnIndex + 1;
    }

    meta.members.push(workingSegment);
  });

  groupMeta.forEach((meta) => {
    meta.members.forEach((segment) => {
      segment.columnCount = meta.maxColumns;
    });
  });

  return laidOut.map(({ groupId: _ignored, ...rest }) => rest);
};

type CalendarDay = {
  iso: string;
  weekdayLabel: string;
  dateLabel: string;
  isToday: boolean;
};

const calendarWeekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const calendarMonthDayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const buildCalendarDays = (start: string | null, end: string | null): CalendarDay[] => {
  if (!start || !end) {
    return [];
  }

  const normalizedStart = normalizeDateInput(start);
  const normalizedEnd = normalizeDateInput(end);

  if (!normalizedStart || !normalizedEnd) {
    return [];
  }

  const startDate = new Date(`${normalizedStart}T00:00:00`);
  const endDate = new Date(`${normalizedEnd}T00:00:00`);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return [];
  }

  const todayIso = formatDateToIsoLocal(new Date());
  const days: CalendarDay[] = [];

  for (let cursor = new Date(startDate); cursor <= endDate; cursor.setDate(cursor.getDate() + 1)) {
    const iso = formatDateToIsoLocal(cursor);
    days.push({
      iso,
      weekdayLabel: calendarWeekdayFormatter.format(cursor),
      dateLabel: calendarMonthDayFormatter.format(cursor),
      isToday: iso === todayIso,
    });
  }

  return days;
};

const combineDateWithTime = (date: string, time: string): string | null => {
  const normalizedDate = normalizeDateInput(date);
  if (!normalizedDate || typeof time !== "string") {
    return null;
  }

  const trimmedTime = time.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmedTime)) {
    return null;
  }

  const [hoursRaw, minutesRaw] = trimmedTime.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return `${normalizedDate}T${hoursRaw}:${minutesRaw}`;
};

const parseIsoLocalDateTime = (value: string): { date: string; hours: number; minutes: number } | null => {
  if (typeof value !== "string") {
    return null;
  }

  const match = ISO_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const hours = Number(match[2]);
  const minutes = Number(match[3]);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return {
    date: match[1],
    hours,
    minutes,
  };
};

const formatTimeLabelFromIso = (value: string): string => {
  const parsed = parseIsoLocalDateTime(value);
  if (!parsed) {
    return "";
  }

  const { hours, minutes } = parsed;
  const period = hours >= 12 ? "PM" : "AM";
  const hourInTwelve = hours % 12 || 12;
  const paddedMinutes = String(minutes).padStart(2, "0");
  return `${hourInTwelve}:${paddedMinutes} ${period}`;
};

const formatEventTimeRange = (start: string, end: string): string => {
  const startLabel = formatTimeLabelFromIso(start);
  const endLabel = formatTimeLabelFromIso(end);
  const startDate = start.slice(0, 10);
  const endDate = end.slice(0, 10);

  if (startLabel && endLabel) {
    if (startDate === endDate) {
      return `${startLabel} – ${endLabel}`;
    }

    const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    });

    const startDayLabel = monthDayFormatter.format(new Date(start));
    const endDayLabel = monthDayFormatter.format(new Date(end));
    return `${startDayLabel} ${startLabel} → ${endDayLabel} ${endLabel}`;
  }

  if (startLabel) {
    return startLabel;
  }

  if (endLabel) {
    return endLabel;
  }

  return "";
};

const formatMinutesToTime = (minutes: number): string => {
  const safeMinutes = clampMinutes(minutes);
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${padTimeSegment(hours)}:${padTimeSegment(mins)}`;
};

const formatMinutesToIsoLocal = (date: string, minutes: number): string =>
  `${date}T${formatMinutesToTime(minutes)}`;

const getPointerClientY = (
  nativeEvent: PointerEvent | MouseEvent | TouchEvent
): number | null => {
  if ("clientY" in nativeEvent) {
    return nativeEvent.clientY;
  }

  if ("touches" in nativeEvent && nativeEvent.touches.length > 0) {
    return nativeEvent.touches[0]?.clientY ?? null;
  }

  if ("changedTouches" in nativeEvent && nativeEvent.changedTouches.length > 0) {
    return nativeEvent.changedTouches[0]?.clientY ?? null;
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
  const [authReady, setAuthReady] = useState(false);
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
  const navigate = useNavigate();
  const location = useLocation();
  const isItineraryBuilderRoute = location.pathname.startsWith("/itineraries/");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setPhase(user ? "authenticated" : "idle");
      setAuthReady(true);
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

  useEffect(() => {
    if (!authReady) {
      return;
    }

    if (!currentUser && phase !== "loading" && location.pathname !== "/") {
      navigate("/", {
        replace: true,
        state: { from: location.pathname },
      });
    }
  }, [authReady, currentUser, phase, location.pathname, navigate]);

  useEffect(() => {
    if (!authReady || !currentUser) {
      return;
    }

    const state = location.state as { from?: string } | null;
    if (state && typeof state.from === "string" && location.pathname === "/") {
      navigate(state.from, { replace: true });
    }
  }, [authReady, currentUser, location.pathname, location.state, navigate]);

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

  const handleOpenItinerary = (itineraryId: string) => {
    navigate(`/itineraries/${itineraryId}`);
  };

  const DashboardContent = () => (
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
          {itineraries.map((itinerary) => {
            const totalTravellers =
              itinerary.travellers.males +
              itinerary.travellers.females +
              itinerary.travellers.kids;
            const travellerLabel = totalTravellers === 1 ? "traveller" : "travellers";
            const isEditingThisItinerary = editingItineraryId === itinerary.id;

            return (
              <article
                key={itinerary.id}
                className="itinerary-card-item"
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!isEditingThisItinerary) {
                    handleOpenItinerary(itinerary.id);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !isEditingThisItinerary &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    handleOpenItinerary(itinerary.id);
                  }
                }}
                aria-label={`Open itinerary ${itinerary.title}`}
              >
                <div className="itinerary-card-heading">
                  <h3>{itinerary.title}</h3>
                </div>

                <p className="date-range" aria-label="Trip dates">
                  {formatDateRange(itinerary.startDate, itinerary.endDate)}
                </p>

                <p className="traveller-total" aria-label="Total travellers">
                  {totalTravellers} {travellerLabel}
                </p>

                {isEditingThisItinerary ? (
                  <form
                    className="itinerary-edit-form"
                    onSubmit={(event) => handleUpdateItinerary(event, itinerary.id)}
                    onClick={(event) => event.stopPropagation()}
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
                        onClick={(event) => {
                          event.stopPropagation();
                          cancelEditItinerary();
                        }}
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
                      onClick={(event) => {
                        event.stopPropagation();
                        beginEditItinerary(itinerary);
                      }}
                    >
                      Edit details
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">
          No itineraries yet. Use the button above to create one.
        </p>
      )}
    </section>
  );

  if (!authReady) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <h1>Travelio</h1>
          <p className="app-subtitle">Plan itineraries securely with your Travelio account.</p>
        </header>

        <section className="card auth-card" aria-live="polite">
          <p className="muted">Checking your session…</p>
        </section>

        <footer className="app-footer">
          <p>Authentication handled by Google Cloud Identity Platform.</p>
        </footer>
      </div>
    );
  }

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
              <p className="signed-in-label">
                {isItineraryBuilderRoute ? "Itinerary builder" : "Travelio dashboard"}
              </p>
              <p className="signed-in-greeting">
                Hi
                {" "}
                {profileName?.trim() || currentUser.displayName?.trim() || currentUser.email || currentUser.uid}
              </p>
            </div>
            <div className="signed-in-actions">
              {isItineraryBuilderRoute ? (
                <button className="secondary" type="button" onClick={() => navigate("/")}>
                  Back to itineraries
                </button>
              ) : null}
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

          <Routes>
            <Route path="/" element={<DashboardContent />} />
            <Route
              path="/itineraries/:itineraryId"
              element={<ItineraryDetailView currentUser={currentUser} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
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

type ItineraryDetailDraft = {
  title: string;
  startDate: string;
  endDate: string;
  travellers: {
    males: number;
    females: number;
    kids: number;
  };
};

const toDraftFromItinerary = (value: Itinerary): ItineraryDetailDraft => ({
  title: value.title,
  startDate: value.startDate ?? "",
  endDate: value.endDate ?? "",
  travellers: {
    males: value.travellers.males,
    females: value.travellers.females,
    kids: value.travellers.kids,
  },
});

function ItineraryDetailView({ currentUser }: { currentUser: User }) {
  const { itineraryId } = useParams<{ itineraryId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [draft, setDraft] = useState<ItineraryDetailDraft>({
    title: "",
    startDate: "",
    endDate: "",
    travellers: { males: 0, females: 0, kids: 0 },
  });
  const [isEditingSidebar, setIsEditingSidebar] = useState(false);
  const [events, setEvents] = useState<ItineraryEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectionRange, setSelectionRange] = useState<CalendarSelection | null>(null);
  const [dragSelection, setDragSelection] = useState<CalendarSelection | null>(null);
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [eventDraft, setEventDraft] = useState<ItineraryEventDraft>({
    title: "",
    description: "",
    startDate: "",
    endDate: "",
    startTime: "",
    endTime: "",
  });
  const [eventFormError, setEventFormError] = useState<string | null>(null);
  const [eventSaving, setEventSaving] = useState(false);
  const [eventStatusMessage, setEventStatusMessage] = useState<string | null>(null);
  const [eventFormPosition, setEventFormPosition] = useState<{ top: number; left: number } | null>(null);
  const [eventFormPlacement, setEventFormPlacement] = useState<"left" | "right">("right");
  const dragSelectionRef = useRef<{
    anchorDate: string;
    anchorMinutes: number;
    currentDate: string;
    currentMinutes: number;
  } | null>(null);
  const dayBodyRefs = useRef(new Map<string, HTMLDivElement>());
  const eventFormRef = useRef<HTMLFormElement | null>(null);
  const calendarGridRef = useRef<HTMLDivElement | null>(null);
  const [eventDragState, setEventDragState] = useState<null | {
    eventId: string;
    date: string;
    mode: "move" | "resize-start" | "resize-end";
    originalStart: number;
    originalEnd: number;
    previewStart: number;
    previewEnd: number;
    anchorOffset?: number;
  }>(null);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setStatusMessage(null);
    }, 3000);

    return () => window.clearTimeout(timeout);
  }, [statusMessage]);


  useEffect(() => {
    if (!eventStatusMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setEventStatusMessage(null);
    }, 3000);

    return () => window.clearTimeout(timeout);
  }, [eventStatusMessage]);

  useEffect(() => {
    if (!itineraryId) {
      setLoadError("Itinerary not found.");
      setLoading(false);
      return;
    }

    let unsubscribe: Unsubscribe | undefined;
    let isActive = true;

    setLoading(true);
    setLoadError(null);
    setFormError(null);

    loadFirestoreModule()
      .then(async ({ doc, onSnapshot }) => {
        if (!isActive) {
          return;
        }

        const firestore = await getFirestoreInstance();
        const itineraryRef = doc(firestore, "itineraries", itineraryId);

        unsubscribe = onSnapshot(
          itineraryRef,
          (snapshot) => {
            if (!snapshot.exists()) {
              setLoadError("Itinerary not found or may have been deleted.");
              setItinerary(null);
              setLoading(false);
              return;
            }

            const data = snapshot.data();

            if (data && data.ownerUid !== currentUser.uid) {
              setLoadError("You do not have access to this itinerary.");
              setItinerary(null);
              setLoading(false);
              return;
            }

            const travellersData =
              data && typeof data.travellers === "object"
                ? (data.travellers as Record<string, unknown>)
                : {};

            const normalized: Itinerary = {
              id: snapshot.id,
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
            };

            setItinerary(normalized);
            setDraft(toDraftFromItinerary(normalized));
            setIsEditingSidebar(false);
            setSelectionRange(null);
            setDragSelection(null);
            dragSelectionRef.current = null;
            setIsDraggingSelection(false);
            setShowEventForm(false);
            setEventFormError(null);
            setEventStatusMessage(null);
            setEventDraft((prev) => ({
              ...prev,
              date: normalized.startDate ?? "",
            }));
            setLoadError(null);
            setFormError(null);
            setLoading(false);
          },
          (snapshotError) => {
            setLoadError(deriveReadableError(snapshotError));
            setItinerary(null);
            setLoading(false);
          }
        );
      })
      .catch((loadError) => {
        if (!isActive) {
          return;
        }

        setLoadError(deriveReadableError(loadError));
        setIsEditingSidebar(false);
        setLoading(false);
      });

    return () => {
      isActive = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [currentUser.uid, itineraryId]);

  useEffect(() => {
    if (!itineraryId || !itinerary) {
      setEvents([]);
      setEventsLoading(false);
      setEventsError(null);
      return;
    }

    let isActive = true;
    let unsubscribe: Unsubscribe | undefined;

    setEventsLoading(true);
    setEventsError(null);

    loadFirestoreModule()
      .then(async ({ collection, onSnapshot, query, where }) => {
        if (!isActive) {
          return;
        }

        const firestore = await getFirestoreInstance();
        const eventsCollection = collection(firestore, "itineraries", itineraryId, "events");
        const constrained = query(eventsCollection, where("ownerUid", "==", currentUser.uid));

        unsubscribe = onSnapshot(
          constrained,
          (snapshot) => {
            if (!isActive) {
              return;
            }

            const next: ItineraryEvent[] = [];

            snapshot.forEach((docSnapshot) => {
              const data = docSnapshot.data();
              const titleValue = typeof data.title === "string" ? data.title : null;
              const startValue = typeof data.startDateTime === "string" ? data.startDateTime : null;
              const endValue = typeof data.endDateTime === "string" ? data.endDateTime : null;

              if (!titleValue || !startValue || !endValue) {
                return;
              }

              if (!parseIsoLocalDateTime(startValue) || !parseIsoLocalDateTime(endValue)) {
                return;
              }

              const descriptionValue =
                typeof data.description === "string" && data.description.trim()
                  ? data.description
                  : null;

              next.push({
                id: docSnapshot.id,
                title: titleValue,
                description: descriptionValue,
                startDateTime: startValue,
                endDateTime: endValue,
              });
            });

            next.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
            setEvents(next);
            setEventsLoading(false);
            setEventsError(null);
          },
          (eventsErrorValue) => {
            if (!isActive) {
              return;
            }

            setEvents([]);
            setEventsLoading(false);
            const readable = deriveReadableError(eventsErrorValue);
            setEventsError(
              typeof readable === "string"
                ? readable
                : "Unable to load itinerary events right now."
            );
          }
        );
      })
      .catch((eventsLoadError) => {
        if (!isActive) {
          return;
        }

        setEvents([]);
        setEventsLoading(false);
        const readable = deriveReadableError(eventsLoadError);
        setEventsError(
          typeof readable === "string"
            ? readable
            : "Unable to load itinerary events right now."
        );
      });

    return () => {
      isActive = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [currentUser.uid, itineraryId, itinerary]);

  const handleDetailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!itineraryId) {
      setFormError("Itinerary reference missing.");
      return;
    }

    const trimmedTitle = draft.title.trim();

    if (!trimmedTitle) {
      setFormError("Itinerary name is required.");
      return;
    }

    const normalizedStart = normalizeDateInput(draft.startDate);
    const normalizedEnd = normalizeDateInput(draft.endDate);

    if (!normalizedStart || !normalizedEnd) {
      setFormError("Please provide both start and end dates.");
      return;
    }

    if (new Date(normalizedStart) > new Date(normalizedEnd)) {
      setFormError("Trip end date should be after the start date.");
      return;
    }

    const travellers = {
      males: coerceTravellerCount(draft.travellers.males),
      females: coerceTravellerCount(draft.travellers.females),
      kids: coerceTravellerCount(draft.travellers.kids),
    };

    setSaving(true);
    setFormError(null);
    setStatusMessage(null);

    try {
      const [{ doc, updateDoc }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      const itineraryRef = doc(firestore, "itineraries", itineraryId);
      await updateDoc(itineraryRef, {
        title: trimmedTitle,
        startDate: normalizedStart,
        endDate: normalizedEnd,
        travellers,
      });

      setStatusMessage("Itinerary updated");
      setIsEditingSidebar(false);
    } catch (updateError) {
      setFormError(deriveReadableError(updateError));
    } finally {
      setSaving(false);
    }
  };

  const startSidebarEdit = () => {
    if (!itinerary) {
      return;
    }

    setDraft(toDraftFromItinerary(itinerary));
    setFormError(null);
    setStatusMessage(null);
    setIsEditingSidebar(true);
  };

  const cancelSidebarEdit = () => {
    if (!itinerary) {
      return;
    }

    setDraft(toDraftFromItinerary(itinerary));
    setFormError(null);
    setStatusMessage(null);
    setIsEditingSidebar(false);
  };

  const getDefaultEventDate = () => normalizeDateInput(draft.startDate) ?? normalizeDateInput(draft.endDate) ?? "";

  const resetEventDraft = () => {
    setEventDraft({
      title: "",
      description: "",
      startDate: getDefaultEventDate(),
      endDate: getDefaultEventDate(),
      startTime: "",
      endTime: "",
    });
  };

  const cancelEventCreation = (force = false) => {
    if (eventSaving && !force) {
      return;
    }

    setSelectionRange(null);
    setDragSelection(null);
    dragSelectionRef.current = null;
    setIsDraggingSelection(false);
    setShowEventForm(false);
    setEventFormError(null);
    setEventFormPosition(null);
    setEventFormPlacement("right");
    resetEventDraft();
  };

  const openEventComposer = (range: CalendarSelection) => {
    setSelectionRange(range);
    setEventFormPosition(null);
    setEventFormPlacement("right");
    setDragSelection(null);
    dragSelectionRef.current = null;
    setIsDraggingSelection(false);
    setEventFormError(null);
    setEventStatusMessage(null);
    setShowEventForm(true);

    const safeEndMinutes = range.endMinutes >= TOTAL_DAY_MINUTES ? TOTAL_DAY_MINUTES - 1 : range.endMinutes;

    setEventDraft((previous) => ({
      title: previous.title,
      description: previous.description,
      startDate: range.startDate,
      endDate: range.endDate,
      startTime: formatMinutesToTime(range.startMinutes),
      endTime: formatMinutesToTime(safeEndMinutes),
    }));
  };

  const beginSlotSelection = (date: string, hour: number) => {
    const startMinutes = clampMinutes(hour * 60);
    const initialEndMinutes = clampMinutes(startMinutes + 60);

    dragSelectionRef.current = {
      anchorDate: date,
      anchorMinutes: startMinutes,
      currentDate: date,
      currentMinutes: initialEndMinutes,
    };

    setDragSelection(normalizeSelection(date, startMinutes, date, initialEndMinutes));
    setIsDraggingSelection(true);
    setSelectionRange(null);
    setShowEventForm(false);
    setEventFormError(null);
    setEventStatusMessage(null);
  };

  const extendSlotSelection = (date: string, hour: number) => {
    if (!isDraggingSelection || !dragSelectionRef.current) {
      return;
    }

    const { anchorDate, anchorMinutes } = dragSelectionRef.current;
    const anchorAbs = toAbsoluteMinutes(anchorDate, anchorMinutes);
    const targetStart = clampMinutes(hour * 60);
    const targetStartAbs = toAbsoluteMinutes(date, targetStart);

    if (anchorAbs === null || targetStartAbs === null) {
      return;
    }

    const movingForward = targetStartAbs >= anchorAbs;
    const currentMinutes = movingForward
      ? clampMinutes((hour + 1) * 60)
      : targetStart;

    dragSelectionRef.current = {
      anchorDate,
      anchorMinutes,
      currentDate: date,
      currentMinutes,
    };

    setDragSelection(normalizeSelection(anchorDate, anchorMinutes, date, currentMinutes));
  };

  const finalizeSlotSelection = (commit: boolean) => {
    const anchor = dragSelectionRef.current;
    dragSelectionRef.current = null;
    setIsDraggingSelection(false);
    setDragSelection(null);

    if (!commit || !anchor) {
      return;
    }

    const selection = normalizeSelection(
      anchor.anchorDate,
      anchor.anchorMinutes,
      anchor.currentDate,
      anchor.currentMinutes
    );

    openEventComposer(selection);
  };

  useEffect(() => {
    if (!isDraggingSelection) {
      return;
    }

    const commit = () => finalizeSlotSelection(true);
    const cancel = () => finalizeSlotSelection(false);

    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("mouseup", commit);
    window.addEventListener("touchend", commit);
    window.addEventListener("touchcancel", cancel);

    return () => {
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("mouseup", commit);
      window.removeEventListener("touchend", commit);
      window.removeEventListener("touchcancel", cancel);
    };
  }, [isDraggingSelection]);

  const startEventDrag = (
    calendarEvent: ItineraryEvent,
    date: string,
    mode: "move" | "resize-start" | "resize-end",
    segmentStartMinutes: number,
    segmentEndMinutes: number,
    reactEvent: ReactPointerEvent<HTMLElement>
  ) => {
    reactEvent.preventDefault();
    reactEvent.stopPropagation();

    if (reactEvent.button !== undefined && reactEvent.button !== 0) {
      return;
    }

    const container = dayBodyRefs.current.get(date);
    if (!container) {
      return;
    }

    const clientY = getPointerClientY(reactEvent.nativeEvent);

    const previewStart = clampMinutes(segmentStartMinutes);
    const previewEnd = clampMinutes(Math.max(segmentEndMinutes, previewStart + MIN_EVENT_DURATION));

    let anchorOffset: number | undefined;
    if (mode === "move" && clientY !== null) {
      const rect = container.getBoundingClientRect();
      const offsetY = clientY - rect.top;
      const pointerMinutes = clampMinutes(
        roundToSelectionStep((offsetY / CALENDAR_SLOT_HEIGHT_PX) * 60)
      );
      anchorOffset = pointerMinutes - previewStart;
    }

    setEventDragState({
      eventId: calendarEvent.id,
      date,
      mode,
      originalStart: previewStart,
      originalEnd: previewEnd,
      previewStart,
      previewEnd,
      anchorOffset,
    });

    dragSelectionRef.current = null;
    setDragSelection(null);
    setIsDraggingSelection(false);
  };

  const updateEventDragPreview = (clientY: number) => {
    setEventDragState((previous) => {
      if (!previous) {
        return previous;
      }

      const container = dayBodyRefs.current.get(previous.date);
      if (!container) {
        return previous;
      }

      const rect = container.getBoundingClientRect();
      const offsetY = clientY - rect.top;
      const pointerMinutes = clampMinutes(
        roundToSelectionStep((offsetY / CALENDAR_SLOT_HEIGHT_PX) * 60)
      );

      if (previous.mode === "move") {
        const duration = previous.originalEnd - previous.originalStart;
        const anchor = previous.anchorOffset ?? 0;
        let start = clampMinutes(pointerMinutes - anchor);
        let end = clampMinutes(start + duration);

        if (end > TOTAL_DAY_MINUTES) {
          end = TOTAL_DAY_MINUTES;
          start = clampMinutes(end - duration);
        }

        if (start < 0) {
          start = 0;
          end = clampMinutes(start + duration);
        }

        if (end - start < MIN_EVENT_DURATION) {
          end = clampMinutes(start + MIN_EVENT_DURATION);
        }

        return {
          ...previous,
          previewStart: start,
          previewEnd: end,
        };
      }

      if (previous.mode === "resize-start") {
        const capped = Math.min(pointerMinutes, previous.previewEnd - MIN_EVENT_DURATION);
        return {
          ...previous,
          previewStart: clampMinutes(Math.min(capped, previous.previewEnd - MIN_EVENT_DURATION)),
        };
      }

      const capped = Math.max(pointerMinutes, previous.previewStart + MIN_EVENT_DURATION);
      return {
        ...previous,
        previewEnd: clampMinutes(Math.min(capped, TOTAL_DAY_MINUTES)),
      };
    });
  };

  const finalizeEventDrag = (commit: boolean) => {
    const current = eventDragState;
    setEventDragState(null);

    if (!commit || !current || !itineraryId) {
      return;
    }

    if (
      current.previewStart === current.originalStart &&
      current.previewEnd === current.originalEnd
    ) {
      return;
    }

    const nextStartIso = formatMinutesToIsoLocal(current.date, current.previewStart);
    const nextEndIso = formatMinutesToIsoLocal(
      current.date,
      Math.min(current.previewEnd, TOTAL_DAY_MINUTES - 1)
    );

    Promise.all([loadFirestoreModule(), getFirestoreInstance()])
      .then(([module, firestore]) => {
        const { doc, updateDoc } = module;
        const eventRef = doc(firestore, "itineraries", itineraryId, "events", current.eventId);

        return updateDoc(eventRef, {
          startDateTime: nextStartIso,
          endDateTime: nextEndIso,
        });
      })
      .then(() => {
        setEventStatusMessage("Event updated");
      })
      .catch((error) => {
        setEventStatusMessage(deriveReadableError(error));
      });
  };

  useEffect(() => {
    if (!eventDragState) {
      return;
    }

    const handlePointerMove = (nativeEvent: PointerEvent) => {
      const y = getPointerClientY(nativeEvent);
      if (y !== null) {
        updateEventDragPreview(y);
      }
    };

    const handleMouseMove = (nativeEvent: MouseEvent) => {
      const y = getPointerClientY(nativeEvent);
      if (y !== null) {
        updateEventDragPreview(y);
      }
    };

    const handleTouchMove = (nativeEvent: TouchEvent) => {
      const y = getPointerClientY(nativeEvent);
      if (y !== null) {
        nativeEvent.preventDefault();
        updateEventDragPreview(y);
      }
    };

    const commit = () => finalizeEventDrag(true);
    const cancel = () => finalizeEventDrag(false);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", commit);
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", commit);
    window.addEventListener("touchcancel", cancel);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", commit);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", commit);
      window.removeEventListener("touchcancel", cancel);
    };
  }, [eventDragState]);

  const handleEventSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!itineraryId) {
      setEventFormError("Itinerary reference missing.");
      return;
    }

    const trimmedTitle = eventDraft.title.trim();
    if (!trimmedTitle) {
      setEventFormError("Event title is required.");
      return;
    }

    const normalizedStartDate = normalizeDateInput(eventDraft.startDate);
    const normalizedEndDate = normalizeDateInput(eventDraft.endDate);

    if (!normalizedStartDate || !normalizedEndDate) {
      setEventFormError("Please provide both start and end dates.");
      return;
    }

    const isoStart = combineDateWithTime(normalizedStartDate, eventDraft.startTime);
    const isoEnd = combineDateWithTime(normalizedEndDate, eventDraft.endTime);

    if (!isoStart || !isoEnd) {
      setEventFormError("Provide valid start and end times.");
      return;
    }

    if (isoStart >= isoEnd) {
      setEventFormError("End time should come after the start time.");
      return;
    }

    if (draft.startDate && normalizedStartDate < draft.startDate) {
      setEventFormError("Event should fall within the trip date range.");
      return;
    }

    if (draft.endDate && normalizedEndDate > draft.endDate) {
      setEventFormError("Event should fall within the trip date range.");
      return;
    }

    const descriptionValue = eventDraft.description.trim();

    setEventSaving(true);
    setEventFormError(null);
    setEventStatusMessage(null);

    try {
      const [{ addDoc, collection, serverTimestamp }, firestore] = await Promise.all([
        loadFirestoreModule(),
        getFirestoreInstance(),
      ]);

      const eventsCollection = collection(firestore, "itineraries", itineraryId, "events");
      await addDoc(eventsCollection, {
        title: trimmedTitle,
        description: descriptionValue ? descriptionValue : null,
        startDateTime: isoStart,
        endDateTime: isoEnd,
        createdAt: serverTimestamp(),
        ownerUid: currentUser.uid,
      });

      setEventStatusMessage("Event created");
      cancelEventCreation(true);
    } catch (submissionError) {
      setEventFormError(deriveReadableError(submissionError));
    } finally {
      setEventSaving(false);
    }
  };

  const totalTravellers =
    draft.travellers.males + draft.travellers.females + draft.travellers.kids;
  const travellerLabel = totalTravellers === 1 ? "traveller" : "travellers";
  const formattedDateRange = formatDateRange(draft.startDate || null, draft.endDate || null);
  const summaryBreakdown = [
    { label: "Males", value: draft.travellers.males },
    { label: "Females", value: draft.travellers.females },
    { label: "Kids", value: draft.travellers.kids },
  ];
  const calendarDays = buildCalendarDays(draft.startDate || null, draft.endDate || null);
  const shouldShowCalendar = calendarDays.length > 0;
  const shouldShowScrollHint = calendarDays.length > 7;
  const calendarRangeLabel = shouldShowCalendar
    ? `Trip calendar covering ${formattedDateRange}`
    : undefined;
  const totalCalendarMinutes = calendarDays.length * TOTAL_DAY_MINUTES;

  const floatingFormStyle: CSSProperties = eventFormPosition
    ? {
        top: `${eventFormPosition.top}px`,
        left: `${eventFormPosition.left}px`,
        opacity: 1,
        pointerEvents: "auto",
      }
    : {
        top: "0px",
        left: "0px",
        opacity: 0,
        pointerEvents: "none",
      };

  const dayIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    calendarDays.forEach((day, index) => map.set(day.iso, index));
    return map;
  }, [calendarDays]);

  const registerDayBodyRef = (date: string) => (element: HTMLDivElement | null) => {
    if (element) {
      dayBodyRefs.current.set(date, element);
    } else {
      dayBodyRefs.current.delete(date);
    }
  };

  const updateEventFormPosition = useCallback(
    (range: CalendarSelection, dimensions?: { width: number; height: number }) => {
      const gridElement = calendarGridRef.current;
      if (!gridElement) {
        return;
      }

      const startDayElement = dayBodyRefs.current.get(range.startDate);
      if (!startDayElement) {
        setEventFormPosition(null);
        return;
      }

      const formWidth = dimensions?.width ?? CALENDAR_FORM_WIDTH_PX;
      const formHeight = dimensions?.height ?? CALENDAR_FORM_HEIGHT_PX;

      const gridRect = gridElement.getBoundingClientRect();
      const dayBodyRect = startDayElement.getBoundingClientRect();

      const selectionStartOffset =
        dayBodyRect.top - gridRect.top + (range.startMinutes / 60) * CALENDAR_SLOT_HEIGHT_PX;
      const selectionEndOffset =
        dayBodyRect.top - gridRect.top + (range.endMinutes / 60) * CALENDAR_SLOT_HEIGHT_PX;
      const selectionCenter = (selectionStartOffset + selectionEndOffset) / 2;

      const maxTop = Math.max(
        gridElement.scrollHeight - formHeight - CALENDAR_FORM_GUTTER_PX,
        CALENDAR_FORM_GUTTER_PX
      );
      let top = selectionCenter - formHeight / 2;
      if (!Number.isFinite(top)) {
        top = 0;
      }
      top = Math.max(CALENDAR_FORM_GUTTER_PX, Math.min(top, maxTop));

      const offsetLeft = dayBodyRect.left - gridRect.left;
      const preferredLeft = offsetLeft + startDayElement.clientWidth + CALENDAR_FORM_GUTTER_PX;
      const maxLeft = Math.max(
        gridElement.scrollWidth - formWidth - CALENDAR_FORM_GUTTER_PX,
        CALENDAR_FORM_GUTTER_PX
      );
      let left = Math.max(CALENDAR_FORM_GUTTER_PX, Math.min(preferredLeft, maxLeft));
      let placement: "left" | "right" = "right";

      if (preferredLeft > maxLeft && offsetLeft > formWidth + CALENDAR_FORM_GUTTER_PX) {
        left = Math.max(CALENDAR_FORM_GUTTER_PX, offsetLeft - formWidth - CALENDAR_FORM_GUTTER_PX);
        placement = "left";
      }

      setEventFormPlacement(placement);
      setEventFormPosition((previous) => {
        if (previous && Math.abs(previous.top - top) < 0.5 && Math.abs(previous.left - left) < 0.5) {
          return previous;
        }

        return { top, left };
      });
    },
    []
  );

  useEffect(() => {
    if (!showEventForm || !selectionRange) {
      return;
    }

    const update = () => {
      const width = eventFormRef.current?.offsetWidth ?? CALENDAR_FORM_WIDTH_PX;
      const height = eventFormRef.current?.offsetHeight ?? CALENDAR_FORM_HEIGHT_PX;
      updateEventFormPosition(selectionRange, { width, height });
    };

    update();

    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, [showEventForm, selectionRange, updateEventFormPosition, calendarDays]);

  useEffect(() => {
    if (!showEventForm) {
      setEventFormPosition(null);
      setEventFormPlacement("right");
    }
  }, [showEventForm]);

  const normalizeSelection = (
    anchorDate: string,
    anchorMinutes: number,
    targetDate: string,
    targetMinutes: number
  ): CalendarSelection => {
    if (!calendarDays.length) {
      return {
        startDate: anchorDate,
        startMinutes: clampMinutes(anchorMinutes),
        endDate: targetDate,
        endMinutes: clampMinutes(targetMinutes),
      };
    }

    const anchorIndex = dayIndexMap.get(anchorDate) ?? 0;
    const targetIndex = dayIndexMap.get(targetDate) ?? anchorIndex;

    let anchorAbs = anchorIndex * TOTAL_DAY_MINUTES + clampMinutes(anchorMinutes);
    let targetAbs = targetIndex * TOTAL_DAY_MINUTES + clampMinutes(targetMinutes);

    let startAbs = Math.min(anchorAbs, targetAbs);
    let endAbs = Math.max(anchorAbs, targetAbs);

    const maxAbs = Math.max(totalCalendarMinutes - MIN_EVENT_DURATION, MIN_EVENT_DURATION);
    startAbs = Math.max(0, Math.min(startAbs, maxAbs));
    endAbs = Math.max(startAbs + MIN_EVENT_DURATION, Math.min(endAbs, totalCalendarMinutes));

    const startDayIndex = Math.min(
      Math.floor(startAbs / TOTAL_DAY_MINUTES),
      Math.max(calendarDays.length - 1, 0)
    );
    const endDayIndex = Math.min(
      Math.floor((endAbs - 1) / TOTAL_DAY_MINUTES),
      Math.max(calendarDays.length - 1, 0)
    );

    const normalizedStartMinutes = clampMinutes(startAbs - startDayIndex * TOTAL_DAY_MINUTES);
    let normalizedEndMinutes = endAbs - endDayIndex * TOTAL_DAY_MINUTES;
    if (normalizedEndMinutes === 0) {
      normalizedEndMinutes = TOTAL_DAY_MINUTES;
    }

    return {
      startDate: calendarDays[startDayIndex]?.iso ?? anchorDate,
      startMinutes: normalizedStartMinutes,
      endDate: calendarDays[endDayIndex]?.iso ?? targetDate,
      endMinutes: clampMinutes(normalizedEndMinutes),
    };
  };

  const toAbsoluteMinutes = (date: string, minutes: number): number | null => {
    const index = dayIndexMap.get(date);
    if (index === undefined) {
      return null;
    }

    return index * TOTAL_DAY_MINUTES + clampMinutes(minutes);
  };

  const deriveDayCoverage = (selection: CalendarSelection | null, date: string) => {
    if (!selection) {
      return null;
    }

    const selectionStartAbs = toAbsoluteMinutes(selection.startDate, selection.startMinutes);
    const selectionEndAbs = toAbsoluteMinutes(selection.endDate, selection.endMinutes);
    const dayStartAbs = toAbsoluteMinutes(date, 0);
    const dayEndAbs = toAbsoluteMinutes(date, TOTAL_DAY_MINUTES);

    if (
      selectionStartAbs === null ||
      selectionEndAbs === null ||
      dayStartAbs === null ||
      dayEndAbs === null ||
      selectionEndAbs <= dayStartAbs ||
      selectionStartAbs >= dayEndAbs
    ) {
      return null;
    }

    const start = Math.max(selectionStartAbs, dayStartAbs);
    const end = Math.min(selectionEndAbs, dayEndAbs);

    return {
      startMinutes: start - dayStartAbs,
      endMinutes: end - dayStartAbs,
    };
  };

  return (
    <section className="card itinerary-builder" aria-live="polite">
      {loading ? (
        <p className="muted">Loading itinerary...</p>
      ) : loadError ? (
        <div className="builder-state">
          <p className="error" role="alert">
            {loadError}
          </p>
          <button className="secondary" type="button" onClick={() => navigate("/")}>
            Back to itineraries
          </button>
        </div>
      ) : itinerary ? (
        <>
          <header className="builder-header">
            <div>
              <h2>{draft.title.trim() || itinerary.title}</h2>
              <p className="muted">
                {formattedDateRange} · {totalTravellers} {travellerLabel}
              </p>
            </div>
            <div className="builder-header-actions">
              <button className="secondary" type="button" onClick={() => navigate("/")}>
                Back to itineraries
              </button>
              <button
                className="secondary"
                type="button"
                onClick={isEditingSidebar ? cancelSidebarEdit : startSidebarEdit}
              >
                {isEditingSidebar ? "Cancel" : "Edit trip"}
              </button>
            </div>
          </header>

          <div className="builder-layout">
            <aside className="builder-sidebar">
              <h3>Trip details</h3>

              {isEditingSidebar ? (
                <form className="builder-form sidebar-form" onSubmit={handleDetailSubmit}>
                  <label className="field">
                    <span>Itinerary name</span>
                    <input
                      type="text"
                      value={draft.title}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          title: event.target.value,
                        }))
                      }
                      required
                      disabled={saving}
                    />
                  </label>

                  <div className="date-grid">
                    <label className="field compact-field">
                      <span>Start date</span>
                      <input
                        type="date"
                        value={draft.startDate}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            startDate: event.target.value,
                          }))
                        }
                        required
                        disabled={saving}
                      />
                    </label>
                    <label className="field compact-field">
                      <span>End date</span>
                      <input
                        type="date"
                        value={draft.endDate}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            endDate: event.target.value,
                          }))
                        }
                        required
                        disabled={saving}
                      />
                    </label>
                  </div>

                  <div className="traveller-grid">
                    <label className="field compact-field">
                      <span>Males</span>
                      <input
                        type="number"
                        min={0}
                        value={draft.travellers.males}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            travellers: {
                              ...prev.travellers,
                              males: coerceTravellerCount(event.target.value),
                            },
                          }))
                        }
                        disabled={saving}
                        inputMode="numeric"
                        pattern="\\d*"
                      />
                    </label>
                    <label className="field compact-field">
                      <span>Females</span>
                      <input
                        type="number"
                        min={0}
                        value={draft.travellers.females}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            travellers: {
                              ...prev.travellers,
                              females: coerceTravellerCount(event.target.value),
                            },
                          }))
                        }
                        disabled={saving}
                        inputMode="numeric"
                        pattern="\\d*"
                      />
                    </label>
                    <label className="field compact-field">
                      <span>Kids</span>
                      <input
                        type="number"
                        min={0}
                        value={draft.travellers.kids}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            travellers: {
                              ...prev.travellers,
                              kids: coerceTravellerCount(event.target.value),
                            },
                          }))
                        }
                        disabled={saving}
                        inputMode="numeric"
                        pattern="\\d*"
                      />
                    </label>
                  </div>

                  {formError ? (
                    <p className="error" role="alert">
                      {formError}
                    </p>
                  ) : null}

                  <button className="primary" type="submit" disabled={saving}>
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                </form>
              ) : (
                <>
                  <dl className="summary-list">
                    <div className="summary-item">
                      <dt>Name</dt>
                      <dd>{draft.title.trim() || itinerary.title}</dd>
                    </div>
                    <div className="summary-item">
                      <dt>Date range</dt>
                      <dd>{formattedDateRange}</dd>
                    </div>
                    <div className="summary-item">
                      <dt>Total travellers</dt>
                      <dd>
                        {totalTravellers} {travellerLabel}
                      </dd>
                    </div>
                    <div className="summary-item">
                      <dt>Breakdown</dt>
                      <dd>
                        <ul className="summary-breakdown">
                          {summaryBreakdown.map((entry) => (
                            <li key={entry.label}>
                              <span>{entry.label}</span>
                              <span>{entry.value}</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                  {statusMessage ? (
                    <p className="profile-status sidebar-status" role="status">
                      {statusMessage}
                    </p>
                  ) : null}
                </>
              )}
            </aside>
            <div className={`builder-main${shouldShowCalendar ? "" : " builder-main--empty"}`}>
              <section className="calendar-panel" aria-labelledby="trip-calendar-heading">
                <header className="calendar-header">
                  <div>
                    <h3 id="trip-calendar-heading">Trip calendar</h3>
                    <p className="muted">Visualise the day-by-day flow of this trip.</p>
                  </div>
                  {shouldShowScrollHint ? (
                    <p className="calendar-hint" role="note">
                      Scroll horizontally to view every day in the range.
                    </p>
                  ) : null}
                </header>

                {shouldShowCalendar ? (
                  <>
                    {eventsError ? (
                      <p className="error" role="alert">
                        {eventsError}
                      </p>
                    ) : null}
                    <div className="calendar-scroll" role="group" aria-label={calendarRangeLabel}>
                      <div className="calendar-grid" ref={calendarGridRef}>
                        <div className="calendar-time-column" aria-hidden="true">
                          <div className="calendar-time-spacer" />
                          {HOUR_MARKERS.map((hour) => (
                            <div key={hour} className="calendar-hour-cell">
                              {formatHourLabel(hour)}
                            </div>
                          ))}
                        </div>
                        {calendarDays.map((day) => {
                          const daySegments: CalendarSegment[] = events
                            .map((entry) => {
                              const parsedStart = parseIsoLocalDateTime(entry.startDateTime);
                              const parsedEnd = parseIsoLocalDateTime(entry.endDateTime);

                              if (!parsedStart || !parsedEnd) {
                                return null;
                              }

                              const eventStartAbs = toAbsoluteMinutes(
                                parsedStart.date,
                                parsedStart.hours * 60 + parsedStart.minutes
                              );
                              const eventEndAbs = toAbsoluteMinutes(
                                parsedEnd.date,
                                parsedEnd.hours * 60 + parsedEnd.minutes
                              );
                              const dayStartAbs = toAbsoluteMinutes(day.iso, 0);
                              const dayEndAbs = toAbsoluteMinutes(day.iso, TOTAL_DAY_MINUTES);

                              if (
                                eventStartAbs === null ||
                                eventEndAbs === null ||
                                dayStartAbs === null ||
                                dayEndAbs === null ||
                                eventEndAbs <= dayStartAbs ||
                                eventStartAbs >= dayEndAbs
                              ) {
                                return null;
                              }

                              const segmentStartMinutes = Math.max(eventStartAbs, dayStartAbs) - dayStartAbs;
                              const segmentEndMinutes = Math.min(eventEndAbs, dayEndAbs) - dayStartAbs;

                              return {
                                event: entry,
                                segmentStartMinutes: clampMinutes(segmentStartMinutes),
                                segmentEndMinutes: clampMinutes(segmentEndMinutes),
                                isStartSegment: eventStartAbs >= dayStartAbs,
                                isEndSegment: eventEndAbs <= dayEndAbs,
                              };
                            })
                            .filter((segment): segment is CalendarSegment =>
                              Boolean(segment && segment.segmentEndMinutes > segment.segmentStartMinutes)
                            )
                            .sort((a, b) => a.segmentStartMinutes - b.segmentStartMinutes);

                          const layoutSegments = layoutSegmentsWithColumns(daySegments);

                          return (
                            <div
                              key={day.iso}
                              className={`calendar-day-column${day.isToday ? " calendar-day-column--today" : ""}`}
                            >
                              <div className="calendar-day-header">
                                <span className="calendar-weekday">{day.weekdayLabel}</span>
                                <span className="calendar-date">{day.dateLabel}</span>
                              </div>
                              <div className="calendar-day-body" ref={registerDayBodyRef(day.iso)}>
                                <div className="calendar-selection-overlay" aria-hidden="true">
                                  {(() => {
                                    const coverage = deriveDayCoverage(dragSelection || selectionRange, day.iso);
                                    if (!coverage) {
                                      return null;
                                    }

                                    const startOffset = (coverage.startMinutes / 60) * CALENDAR_SLOT_HEIGHT_PX;
                                    const height = ((coverage.endMinutes - coverage.startMinutes) / 60) *
                                      CALENDAR_SLOT_HEIGHT_PX;

                                    return (
                                      <div
                                        className="calendar-selection-block"
                                        style={{
                                          top: `${startOffset}px`,
                                          height: `${Math.max(height, 4)}px`,
                                        }}
                                      />
                                    );
                                  })()}
                                </div>

                                {HOUR_MARKERS.map((hour) => (
                                  <button
                                    key={`${day.iso}-${hour}`}
                                    type="button"
                                    className="calendar-slot"
                                    onPointerDown={(event) => {
                                      event.preventDefault();
                                      beginSlotSelection(day.iso, hour);
                                    }}
                                    onPointerEnter={() => extendSlotSelection(day.iso, hour)}
                                    onPointerUp={() => finalizeSlotSelection(true)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        openEventComposer(
                                          normalizeSelection(
                                            day.iso,
                                            clampMinutes(hour * 60),
                                            day.iso,
                                            clampMinutes((hour + 1) * 60)
                                          )
                                        );
                                      }
                                    }}
                                    aria-label={`Create event on ${day.weekdayLabel} ${day.dateLabel} at ${formatHourLabel(hour)}`}
                                  />
                                ))}

                                <div className="calendar-day-events" aria-hidden={layoutSegments.length === 0}
                                >
                                  {layoutSegments.map((segment) => {
                                    const { event: calendarEvent, segmentStartMinutes, segmentEndMinutes } = segment;

                                    const isDraggedSegment =
                                      eventDragState &&
                                      eventDragState.eventId === calendarEvent.id &&
                                      eventDragState.date === day.iso;

                                    const previewStart = isDraggedSegment
                                      ? eventDragState.previewStart
                                      : segmentStartMinutes;
                                    const previewEnd = isDraggedSegment
                                      ? eventDragState.previewEnd
                                      : segmentEndMinutes;

                                    const durationMinutes = Math.max(
                                      previewEnd - previewStart,
                                      MIN_EVENT_DURATION
                                    );
                                    const blockHeight = (durationMinutes / 60) * CALENDAR_SLOT_HEIGHT_PX;
                                    const topOffset = (previewStart / 60) * CALENDAR_SLOT_HEIGHT_PX;

                                    const isSingleDaySegment = segment.isStartSegment && segment.isEndSegment;
                                    const canResizeStart = isSingleDaySegment;
                                    const canResizeEnd = isSingleDaySegment;
                                    const canMoveEvent = isSingleDaySegment;

                                    const widthFraction = 100 / segment.columnCount;
                                    const leftFraction = widthFraction * segment.columnIndex;
                                    const widthExpression = `calc(${widthFraction}% - ${CALENDAR_EVENT_GUTTER_PX * 2}px)`;
                                    const leftExpression = `calc(${leftFraction}% + ${CALENDAR_EVENT_GUTTER_PX}px)`;

                                    return (
                                      <div
                                        key={`${calendarEvent.id}-${day.iso}`}
                                        className={`calendar-event${isDraggedSegment ? " calendar-event--dragging" : ""}`}
                                        style={{
                                          top: `${topOffset}px`,
                                          height: `${Math.max(blockHeight, 24)}px`,
                                          left: leftExpression,
                                          width: widthExpression,
                                        }}
                                        onPointerDown={
                                          canMoveEvent
                                            ? (event) =>
                                                startEventDrag(
                                                  calendarEvent,
                                                  day.iso,
                                                  "move",
                                                  segmentStartMinutes,
                                                  segmentEndMinutes,
                                                  event
                                                )
                                            : undefined
                                        }
                                      >
                                        {canResizeStart ? (
                                          <button
                                            type="button"
                                            className="calendar-event-handle calendar-event-handle--start"
                                            onPointerDown={(event) =>
                                              startEventDrag(
                                                calendarEvent,
                                                day.iso,
                                                "resize-start",
                                                segmentStartMinutes,
                                                segmentEndMinutes,
                                                event
                                              )
                                            }
                                            aria-label="Adjust start time"
                                          />
                                        ) : null}
                                        <div className="calendar-event-content">
                                          <strong>{calendarEvent.title}</strong>
                                          <span>
                                            {formatEventTimeRange(
                                              calendarEvent.startDateTime,
                                              calendarEvent.endDateTime
                                            )}
                                          </span>
                                        </div>
                                        {canResizeEnd ? (
                                          <button
                                            type="button"
                                            className="calendar-event-handle calendar-event-handle--end"
                                            onPointerDown={(event) =>
                                              startEventDrag(
                                                calendarEvent,
                                                day.iso,
                                                "resize-end",
                                                segmentStartMinutes,
                                                segmentEndMinutes,
                                                event
                                              )
                                            }
                                            aria-label="Adjust end time"
                                          />
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {showEventForm ? (
                          <form
                            ref={eventFormRef}
                            className="calendar-event-form calendar-event-form--floating"
                            data-placement={eventFormPlacement}
                            style={floatingFormStyle}
                            onSubmit={handleEventSubmit}
                          >
                            <div className="calendar-event-grid">
                              <label className="field">
                                <span>Title</span>
                                <input
                                  type="text"
                                  value={eventDraft.title}
                                  onChange={(event) =>
                                    setEventDraft((previous) => ({
                                      ...previous,
                                      title: event.target.value,
                                    }))
                                  }
                                  required
                                  disabled={eventSaving}
                                />
                              </label>
                              <label className="field">
                                <span>Start date</span>
                                <input
                                  type="date"
                                  value={eventDraft.startDate}
                                  onChange={(event) =>
                                    setEventDraft((previous) => ({
                                      ...previous,
                                      startDate: event.target.value,
                                      endDate:
                                        previous.endDate && previous.endDate < event.target.value
                                          ? event.target.value
                                          : previous.endDate,
                                    }))
                                  }
                                  required
                                  disabled={eventSaving}
                                  min={draft.startDate || undefined}
                                  max={draft.endDate || undefined}
                                />
                              </label>
                              <label className="field">
                                <span>Start time</span>
                                <input
                                  type="time"
                                  value={eventDraft.startTime}
                                  onChange={(event) =>
                                    setEventDraft((previous) => ({
                                      ...previous,
                                      startTime: event.target.value,
                                    }))
                                  }
                                  required
                                  disabled={eventSaving}
                                  step={900}
                                />
                              </label>
                              <label className="field">
                                <span>End date</span>
                                <input
                                  type="date"
                                  value={eventDraft.endDate}
                                  onChange={(event) =>
                                    setEventDraft((previous) => ({
                                      ...previous,
                                      endDate: event.target.value,
                                    }))
                                  }
                                  required
                                  disabled={eventSaving}
                                  min={eventDraft.startDate || draft.startDate || undefined}
                                  max={draft.endDate || undefined}
                                />
                              </label>
                              <label className="field">
                                <span>End time</span>
                                <input
                                  type="time"
                                  value={eventDraft.endTime}
                                  onChange={(event) =>
                                    setEventDraft((previous) => ({
                                      ...previous,
                                      endTime: event.target.value,
                                    }))
                                  }
                                  required
                                  disabled={eventSaving}
                                  step={900}
                                />
                              </label>
                            </div>

                            <label className="field">
                              <span>Notes (optional)</span>
                              <textarea
                                value={eventDraft.description}
                                onChange={(event) =>
                                  setEventDraft((previous) => ({
                                    ...previous,
                                    description: event.target.value,
                                  }))
                                }
                                disabled={eventSaving}
                              />
                            </label>

                            {eventFormError ? (
                              <p className="error" role="alert">
                                {eventFormError}
                              </p>
                            ) : null}

                            <div className="calendar-event-actions">
                              <button className="primary" type="submit" disabled={eventSaving}>
                                {eventSaving ? "Saving..." : "Save event"}
                              </button>
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => cancelEventCreation()}
                                disabled={eventSaving}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : null}
                      </div>
                    </div>
                    {eventsLoading ? (
                      <p className="muted" role="status">
                        Loading events...
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="calendar-empty" role="status">
                    <p className="muted">Select both a start and end date to generate the calendar.</p>
                  </div>
                )}

                {!showEventForm && shouldShowCalendar ? (
                  <p className="calendar-instructions muted">
                    Click or drag across the calendar to add an event.
                  </p>
                ) : null}

                {eventStatusMessage ? (
                  <p className="profile-status calendar-status" role="status">
                    {eventStatusMessage}
                  </p>
                ) : null}
              </section>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default App;
