# Travelio Frontend

This Vite + React application renders the Travelio sign-in experience backed by Google Cloud Identity Platform (Firebase Authentication). Users authenticate with their Travelio (GCP) credentials before they can build itineraries.

## Prerequisites

1. A Google Cloud project with [Identity Platform](https://cloud.google.com/identity-platform/docs/use-rest-api) (or Firebase Authentication) enabled.
2. A web application registered in Identity Platform.
3. The web app configuration values copied from the Google Cloud console.

## Environment configuration

Create a `.env.local` file in the `frontend` directory with the values from your GCP project:

```bash
VITE_FIREBASE_API_KEY="your-api-key"
VITE_FIREBASE_AUTH_DOMAIN="your-project.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your-project-id"
VITE_FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="1234567890"
VITE_FIREBASE_APP_ID="1:1234567890:web:abcdef123456"
```

> These keys are surfaced through Vite's `import.meta.env` and used in `src/firebase.ts` to initialize the Firebase SDK.

## Local development

```bash
npm install
npm run dev
```

Visit the printed URL (default `http://localhost:5173`) and sign in with a user that exists in Identity Platform. The login view handles success/failure states and exposes a sign-out button once authenticated.

## Production build

```bash
npm run build
npm run preview
```

`npm run build` outputs a production-ready bundle under `dist/`. Deploy this directory to your chosen GCP hosting target (e.g., Cloud Run, Firebase Hosting, or Cloud Storage behind a load balancer).

## Next steps

- Gate itinerary creation routes behind the authenticated session returned by Firebase.
- Integrate additional providers (Google, phone, etc.) through Identity Platform as needed.
- Harden routing and state management for the broader Travelio experience.
