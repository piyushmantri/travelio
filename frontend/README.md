# Travelio Frontend

This Vite + React application renders the Travelio sign-in and self-service registration experience backed by Google Cloud Identity Platform (Firebase Authentication). Users authenticate with their Travelio (GCP) credentials before they can build itineraries.

## Prerequisites

1. A Google Cloud project with [Identity Platform](https://cloud.google.com/identity-platform/docs/use-rest-api) (or Firebase Authentication) enabled.
2. A web application registered in Identity Platform (the included scripts show how to create one programmatically).
3. The web app configuration values copied from the Google Cloud console or generated via the Firebase Admin REST API. The Email/Password provider must be enabled to allow self-service account creation.

## Environment configuration

Create a `.env.local` file in the `frontend` directory with the values from your GCP project:

```bash
VITE_FIREBASE_API_KEY="your-api-key"
VITE_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your-project-id"
VITE_FIREBASE_STORAGE_BUCKET="your-project.firebasestorage.app"
VITE_FIREBASE_MESSAGING_SENDER_ID="1234567890"
VITE_FIREBASE_APP_ID="1:1234567890:web:abcdef123456"
```

> These keys are surfaced through Vite's `import.meta.env` and used in `src/firebase.ts` to initialize the Firebase SDK.

## Local development

```bash
npm install
npm run dev
```

Visit the printed URL (default `http://localhost:5173`) to either sign in or create a new account. Account creation uses `createUserWithEmailAndPassword`, so be sure Email/Password sign-in is enabled in Identity Platform.

Authenticated users can create itineraries that are stored in Cloud Firestore under the `itineraries` collection. Each document records the owner UID, itinerary title, trip start/end dates, a traveller breakdown (males, females, kids), and a server timestamp so users see their saved plans immediately after login. All of these details can be adjusted later from each itinerary card.

## Firestore setup

Ensure Cloud Firestore is enabled in the Google Cloud project:

```bash
gcloud services enable firestore.googleapis.com --project cloud-run-day-2025-471903
gcloud firestore databases describe --project cloud-run-day-2025-471903 --database='(default)'
```

If a default native database does not exist, create one in your preferred region (example below uses `asia-south1`):

```bash
gcloud firestore databases create --project cloud-run-day-2025-471903 --location=asia-south1
```

The frontend writes itineraries with an `ownerUid` filter so each user only sees their own records, and stores the chosen display name for each account in `profiles/{uid}`. If you change regions or database IDs, update the Firebase configuration accordingly.

### Security rules

Deploy the bundled `firestore.rules` to restrict read/write access so that users may only manage their own itineraries:

```bash
firebase deploy --only firestore:rules --project cloud-run-day-2025-471903 --non-interactive
```

The rules allow creates when the authenticated UID matches the `ownerUid` being written and limit reads/updates/deletes to documents owned by the requesting user.

## Production build

```bash
npm run build
npm run preview
```

`npm run build` outputs a production-ready bundle under `dist/`. Deploy this directory to your chosen GCP hosting target (e.g., Cloud Run, Firebase Hosting, or Cloud Storage behind a load balancer).

## Next steps

- Gate itinerary creation routes behind the authenticated session returned by Firebase.
- Configure additional authentication factors (MFA, SSO providers, etc.) through Identity Platform as needed.
- Harden routing and state management for the broader Travelio experience.
