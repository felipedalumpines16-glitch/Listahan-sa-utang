# Utang List Firebase Setup

## Project and Plan

- Firebase project name: **Utang List**
- Firebase project ID: **utang-list**
- Required plan: **Spark (free)**
- Payment method or billing account: **not required**
- Cloud Functions, Cloud Run, App Check, and email delivery: **not used by this app**
- Firebase web configuration is already in `firebase-config.js`. It is public client configuration; never add Admin SDK credentials or private keys there.

The app uses Firebase Authentication Email/Password and Cloud Firestore directly from the browser. The visible forms ask only for Store Name and Password. Do not enable extra Authentication providers.

## Internal Authentication Identifier

Firebase's Email/Password provider needs an email-shaped identifier. Utang List derives it in the browser from the Store Name using Web Crypto SHA-256. It applies Unicode NFKC normalization, trims whitespace, collapses repeated spaces, and lowercases before hashing. The generated identifier is of the form `store_<sha256>@auth.utang-list.internal`.

The identifier is an implementation detail and is never displayed in the application. It is not a real, mail-receiving address. The password is passed directly to Firebase Authentication and is not written to Firestore, app localStorage, or backups. Firebase's own SDK persists the signed-in session on that device.

This design makes exactly normalized-equivalent store names map to the same Firebase Auth account on every device. Store names are not secrets; the SHA-256 value is deterministic, not an additional password. There is no real email to receive Firebase password-reset messages, so password recovery is unavailable. Do not implement a custom reset flow or collect a fake reset address.

## Firebase Console Configuration

1. Open project **utang-list** in Firebase Console.
2. Under **Authentication → Sign-in method**, enable **Email/Password**. Do not enable Email link or other providers.
3. Under **Firestore Database**, create or select the database. No billing upgrade is requested for this setup.
4. Do not configure App Check for this app; it is not initialized or required by the client.
5. Ensure the intended app host is allowed by Firebase Authentication if Firebase Console requires it for the chosen hosting setup.

First-time registration and sign-in on each new device require internet access. Firebase Auth does not provide offline first-time authentication.

## Firestore Data and Rules

Application records are isolated under:

- `stores/{uid}`: store profile, including the display name and normalized name.
- `stores/{uid}/customers/{customerId}`
- `stores/{uid}/transactions/{transactionId}`
- `stores/{uid}/payments/{paymentId}`
- `stores/{uid}/balances/{customerId}`: transactionally maintained totals used to prevent concurrent overpayments and debt edits below payments.
- `stores/{uid}/migrations/{fingerprint}`: imported/skipped legacy migration markers.

The rules require `request.auth.uid == {uid}`, validate record ownership and allowed fields, keep store ownership immutable, validate customer Sitio against the seven allowed values, and deny unrelated paths. They do not grant unauthenticated access or use the previous custom-token claim. Store owners can access only their own store path.

Rules cannot make a browser a trusted server. An authenticated owner can alter their own records, including balance summaries, with a modified client; the rules protect account-to-account isolation, not against the owner tampering with their own data. Payments and balance-sensitive edits use online Firestore transactions in the normal app, but this client-only design cannot enforce business invariants against a deliberately modified client as strongly as trusted server code.

## Deploy

From the project root, with Firebase CLI installed and the existing project selected:

```powershell
firebase login
firebase use --add
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

Select **utang-list** with `firebase use --add`. The deployment commands above do not deploy Functions. Do not run `firebase deploy --only functions`. `firebase.json` has no Functions target, and `functions/` is excluded from Hosting.

No deployment has been performed from this workspace.

## Multi-Device Test

1. Enable Email/Password and deploy Firestore rules and Hosting.
2. On PC 1, create a store with a Store Name and a strong password. No email is requested.
3. On PC 2 or a phone, enter the same normalized Store Name and password. It should resolve to the same Firebase UID and store profile.
4. Add a customer on one device and confirm the other receives it through Firestore snapshot listeners. Repeat with a transaction and payment.
5. Create a different store account and verify it cannot read the first store's profile or records.

Cross-device synchronization has not been verified against a deployed Firebase project. Test Firestore rules in the Firebase Rules Playground or Emulator Suite before production use.

## Offline, Migration, Backup, and PWA

- Firestore uses the modular SDK's `initializeFirestore()` with `persistentLocalCache()` and `persistentMultipleTabManager()`. Auth uses Firebase's local browser persistence. On restart, the app waits for Auth restoration, reads a cached `stores/{uid}` profile first, and opens the dashboard from cached data when available.
- Customer, transaction, payment, and customer-history deletion writes use stable document IDs and Firestore `setDoc`, `deleteDoc`, or `writeBatch` operations, which can queue in the persistent cache while offline. Cached listeners update the current device immediately; the SDK sends queued writes when connectivity returns, and `onSnapshot` metadata drives the `OFFLINE`, `SYNCING`, and `ONLINE` states.
- A first registration or sign-in on a new device still requires internet. Restore needs the relevant existing documents available in that device's cache to work offline. Legacy import requires internet and is offered only after a server-confirmed cloud load.
- Offline balance checks use that device's cached records. Firestore rules still enforce UID ownership, but without a trusted backend they cannot atomically reconcile two devices that independently record payments while both are offline. Such concurrent offline edits may conflict when synchronized; the displayed balance remains clamped at zero. Reconnect and verify changes before relying on the final total.
- The app displays `ONLINE`, `OFFLINE`, `SYNCING`, or `SYNC ERROR`; offline/pending writes are not labeled synced.
- Existing `utang-list-data-v1` localStorage records are retained. After the store's cloud records load from the server, the app offers Import or Skip. Import is limited to an empty store, uses stable record IDs and a fingerprint marker to prevent repeat imports, and does not delete the local copy. Skip also leaves local data untouched.
- Backups contain application records only. Restore validates records before writing and requires an internet connection.
- The PWA caches the app shell, Firebase modular SDK entrypoints, and service worker. The service-worker scope and cache URLs are resolved relative to the app's hosting path, including `https://felipedalumpines16-glitch.github.io/Listahan-sa-utang/`. Firebase Auth and Firestore API responses/private data are not static service-worker assets.

## Unused Legacy Functions Source

`functions/` still contains the previous server implementation, but the browser no longer loads or calls it, and `firebase.json` no longer configures a Functions deployment. It is not needed by the current application flow and is excluded from Hosting. The source has been left in place rather than deleted; it can be removed separately after confirming no other deployment workflow uses it.