import { firebaseConfig } from "./firebase-config.js";

const configReady = Object.values(firebaseConfig).every(value => typeof value === "string" && value && !value.startsWith("YOUR_"));
const INTERNAL_EMAIL_DOMAIN = "auth.utang-list.internal";
let app;
let auth;
let db;

export async function initializeCloud() {
  if (!configReady) throw new Error("Firebase web configuration is incomplete.");
  const defaultApp = firebase.apps.find(candidate => candidate.name === "[DEFAULT]");
  app = defaultApp || firebase.initializeApp(firebaseConfig);
  if (app.options.projectId !== "utang-list" || app.options.projectId !== firebaseConfig.projectId) {
    throw new Error("Firebase is initialized for a different project. Expected utang-list.");
  }
  auth = app.auth();
  db = app.firestore();
  await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
  try {
    await db.enablePersistence({ synchronizeTabs: true });
  } catch (error) {
    if (!["failed-precondition", "unimplemented"].includes(error.code)) throw error;
    console.warn("Persistent offline database cache is unavailable in this browser.", error.code);
  }
  return new Promise((resolve, reject) => {
    const unsubscribe = auth.onAuthStateChanged(user => {
      unsubscribe();
      resolve(user);
    }, error => {
      unsubscribe();
      reject(error);
    });
  });
}

export function authChanges(callback, onError) {
  return auth.onAuthStateChanged(callback, onError);
}

export function normalizeStoreName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

async function internalEmailFor(storeName) {
  const normalized = normalizeStoreName(storeName);
  if (!normalized || normalized.length > 80 || /[\/\\\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Enter a valid store name (maximum 80 characters).");
  }
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `store_${hash}@${INTERNAL_EMAIL_DOMAIN}`;
}

function storeRef(storeId) {
  if (!auth?.currentUser || auth.currentUser.uid !== storeId) throw new Error("Permission denied.");
  return db.collection("stores").doc(storeId);
}

function recordForWrite(storeId, record) {
  if (!record || typeof record.id !== "string" || !record.id) throw new Error("Invalid record.");
  const { id, ...fields } = record;
  return { ...fields, id, storeId };
}

function requireOnline() {
  if (!navigator.onLine) throw Object.assign(new Error("An internet connection is required for this balance-sensitive change."), { code: "unavailable" });
}

function logFirebaseError(stage, error, context = {}) {
  console.error(`[Firebase ${stage}]`, {
    ...(Object.hasOwn(context, "uid") ? { uid: context.uid } : {}),
    ...(Object.hasOwn(context, "path") ? { path: context.path } : {}),
    code: error?.code || "unknown",
    message: error?.message || String(error)
  });
}

function profileContext(user) {
  const uid = user?.uid || null;
  return {
    uid,
    projectId: db?.app?.options?.projectId || app?.options?.projectId || null,
    path: uid ? `stores/${uid}` : "stores/<missing-uid>",
    currentUserUid: auth?.currentUser?.uid || null
  };
}

async function verifyAuthenticatedUser(user, operation) {
  const context = profileContext(user);
  if (!user?.uid) throw Object.assign(new Error("Firebase returned no authenticated UID."), { code: "auth/missing-uid", phase: "store-profile", operation });
  if (context.projectId !== "utang-list" || db?.app !== app) {
    throw Object.assign(new Error("Firebase Auth and Firestore are not using the expected Firebase app/project."), { code: "firebase/app-mismatch", phase: "store-profile", operation });
  }
  if (context.currentUserUid !== user.uid) {
    throw Object.assign(new Error("Firebase Auth currentUser does not match the authenticated credential UID."), { code: "auth/user-mismatch", phase: "store-profile", operation });
  }
  await user.getIdToken();
  const currentUserUid = auth?.currentUser?.uid || null;
  if (currentUserUid !== user.uid) {
    throw Object.assign(new Error("Firebase Auth user changed before the Firestore profile request."), { code: "auth/user-mismatch", phase: "store-profile", operation });
  }
  return profileContext(user);
}

async function readStoreProfile(user, source = "server") {
  try {
    const context = await verifyAuthenticatedUser(user, "read");
    console.info("[Firebase store profile read]", context);
    const reference = db.collection("stores").doc(context.uid);
    const snapshot = await reference.get({ source });
    return snapshot.exists ? snapshot.data() : null;
  } catch (error) {
    logFirebaseError("store profile read", error, profileContext(user));
    throw Object.assign(error, { phase: "store-profile", operation: "read" });
  }
}

async function createStoreProfile(user, storeName) {
  const context = await verifyAuthenticatedUser(user, "create");
  console.info("[Firebase store profile create]", context);
  const cleanName = String(storeName).normalize("NFKC").trim().replace(/\s+/g, " ");
  const reference = db.collection("stores").doc(context.uid);
  const now = firebase.firestore.FieldValue.serverTimestamp();
  try {
    await reference.set({
      storeId: context.uid,
      storeName: cleanName,
      normalizedStoreName: normalizeStoreName(cleanName),
      createdAt: now,
      updatedAt: now
    });
  } catch (error) {
    logFirebaseError("store profile create", error, profileContext(user));
    throw Object.assign(error, { phase: "store-profile", operation: "create" });
  }
  const profile = await readStoreProfile(user, "server");
  if (!profile) throw Object.assign(new Error("The store profile was not found after creation."), { code: "store/profile-not-found", phase: "store-profile", operation: "verify" });
  return profile;
}

export async function createStoreAccount(storeName, password) {
  const email = await internalEmailFor(storeName);
  const credential = await auth.createUserWithEmailAndPassword(email, password);
  try {
    const profile = await createStoreProfile(credential.user, storeName);
    return { user: credential.user, profile };
  } catch (error) {
    await auth.signOut().catch(signOutError => logFirebaseError("signOut after profile failure", signOutError));
    throw error;
  }
}

export async function loginStore(storeName, password) {
  const email = await internalEmailFor(storeName);
  let credential;
  try {
    credential = await auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    logFirebaseError("signInWithEmailAndPassword", error);
    throw error;
  }
  const profile = await readStoreProfile(credential.user, "server");
  if (!profile) {
    await auth.signOut();
    throw Object.assign(new Error("This authenticated account does not have a store profile."), { code: "store/profile-not-found", phase: "store-profile", operation: "read" });
  }
  return { user: credential.user, profile };
}

export async function logoutStore() {
  await auth.signOut();
}

export function currentStoreId() {
  return auth?.currentUser?.uid || null;
}

export async function getStoreProfile(user) {
  const profile = await readStoreProfile(user, navigator.onLine ? "server" : "default");
  if (!profile) throw Object.assign(new Error("This authenticated account does not have a store profile."), { code: "store/profile-not-found", phase: "store-profile", operation: "read" });
  return profile;
}

export function watchStoreData(storeId, callback, onError) {
  const root = storeRef(storeId);
  const next = { customers: [], transactions: [], payments: [] };
  const ready = new Set();
  const snapshots = {};
  const collectionNames = ["customers", "transactions", "payments"];
  const emit = () => {
    if (ready.size !== 3) return;
    callback(structuredClone(next), {
      fromCache: collectionNames.some(type => snapshots[type]?.metadata.fromCache),
      hasPendingWrites: collectionNames.some(type => snapshots[type]?.metadata.hasPendingWrites)
    });
  };
  const subscriptions = collectionNames.map(type => root.collection(type).onSnapshot({ includeMetadataChanges: true }, snapshot => {
    next[type] = snapshot.docs.map(row => ({ ...row.data(), id: row.id }));
    ready.add(type);
    snapshots[type] = snapshot;
    emit();
  }, onError));
  return () => subscriptions.forEach(unsubscribe => unsubscribe());
}

export function watchStoreProfile(storeId, callback, onError) {
  return storeRef(storeId).onSnapshot({ includeMetadataChanges: true }, snapshot => {
    if (!snapshot.exists) return onError(new Error("Store account profile was not found."));
    callback(snapshot.data(), { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
  }, onError);
}

function balanceRef(root, customerId) {
  return root.collection("balances").doc(customerId);
}

export async function ensureBalanceSummaries(storeId, customers) {
  const root = storeRef(storeId);
  await Promise.all(customers.map(async customer => {
    const customerRef = root.collection("customers").doc(customer.id);
    const summaryRef = balanceRef(root, customer.id);
    const [customerSnapshot, summarySnapshot] = await Promise.all([customerRef.get(), summaryRef.get()]);
    if (!customerSnapshot.exists || summarySnapshot.exists || customerSnapshot.metadata.fromCache || summarySnapshot.metadata.fromCache) return;
    const [transactions, payments] = await Promise.all([
      root.collection("transactions").where("customerId", "==", customer.id).get(),
      root.collection("payments").where("customerId", "==", customer.id).get()
    ]);
    if (transactions.metadata.fromCache || payments.metadata.fromCache) return;
    const totalDebt = transactions.docs.reduce((sum, row) => sum + Number(row.get("total") || 0), 0);
    const totalPaid = payments.docs.reduce((sum, row) => sum + Number(row.get("amount") || 0), 0);
    await db.runTransaction(async tx => {
      const current = await tx.get(summaryRef);
      const currentCustomer = await tx.get(customerRef);
      if (!current.exists && currentCustomer.exists) {
        tx.set(summaryRef, { storeId, customerId: customer.id, totalDebt, totalPaid, recordCount: transactions.size + payments.size });
      }
    });
  }));
}

export async function saveCustomer(storeId, customer) {
  const root = storeRef(storeId);
  await root.collection("customers").doc(customer.id).set(recordForWrite(storeId, customer));
}

export async function saveTransaction(storeId, transaction) {
  requireOnline();
  const root = storeRef(storeId);
  const ref = root.collection("transactions").doc(transaction.id);
  await ensureBalanceSummaries(storeId, [{ id: transaction.customerId }]);
  const summaryRef = balanceRef(root, transaction.customerId);
  await db.runTransaction(async tx => {
    const customerRef = root.collection("customers").doc(transaction.customerId);
    const customer = await tx.get(customerRef);
    const summary = await tx.get(summaryRef);
    const prior = await tx.get(ref);
    if (!customer.exists) throw Object.assign(new Error("Customer not found."), { code: "not-found" });
    if (!summary.exists) throw Object.assign(new Error("Customer balance is not ready. Connect to the internet and retry."), { code: "unavailable" });
    if (prior.exists && prior.get("customerId") !== transaction.customerId) throw Object.assign(new Error("Transaction customer cannot be changed."), { code: "permission-denied" });
    const totalDebt = Number(summary.get("totalDebt") || 0) - Number(prior.get("total") || 0) + transaction.total;
    const totalPaid = Number(summary.get("totalPaid") || 0);
    if (Math.round(totalDebt * 100) < Math.round(totalPaid * 100)) {
      throw Object.assign(new Error("Utang cannot be reduced below payments already recorded."), { code: "failed-precondition" });
    }
    tx.set(ref, recordForWrite(storeId, transaction));
    const recordCount = Number(summary.get("recordCount") || 0) + (prior.exists ? 0 : 1);
    tx.set(summaryRef, { storeId, customerId: transaction.customerId, totalDebt: Math.round(totalDebt * 100) / 100, totalPaid, recordCount });
  });
}

export async function deleteTransaction(storeId, transactionId) {
  requireOnline();
  const root = storeRef(storeId);
  const ref = root.collection("transactions").doc(transactionId);
  const initial = await ref.get();
  if (!initial.exists) return;
  const customerId = initial.get("customerId");
  await ensureBalanceSummaries(storeId, [{ id: customerId }]);
  const summaryRef = balanceRef(root, customerId);
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (!existing.exists) return;
    const summary = await tx.get(summaryRef);
    const debt = Number(summary.get("totalDebt") || 0) - Number(existing.get("total") || 0);
    const paid = Number(summary.get("totalPaid") || 0);
    if (Math.round(debt * 100) < Math.round(paid * 100)) throw Object.assign(new Error("Recorded payments would exceed the remaining utang."), { code: "failed-precondition" });
    tx.delete(ref);
    tx.set(summaryRef, { storeId, customerId, totalDebt: Math.round(debt * 100) / 100, totalPaid: paid, recordCount: Math.max(0, Number(summary.get("recordCount") || 0) - 1) });
  });
}

export async function deletePayment(storeId, paymentId) {
  requireOnline();
  const root = storeRef(storeId);
  const ref = root.collection("payments").doc(paymentId);
  const initial = await ref.get();
  if (!initial.exists) return;
  const customerId = initial.get("customerId");
  await ensureBalanceSummaries(storeId, [{ id: customerId }]);
  const summaryRef = balanceRef(root, customerId);
  await db.runTransaction(async tx => {
    const payment = await tx.get(ref);
    const summary = await tx.get(summaryRef);
    if (!payment.exists) return;
    const totalPaid = Number(summary.get("totalPaid") || 0) - Number(payment.get("amount") || 0);
    tx.delete(ref);
    tx.set(summaryRef, { storeId, customerId, totalDebt: Number(summary.get("totalDebt") || 0), totalPaid: Math.round(totalPaid * 100) / 100, recordCount: Math.max(0, Number(summary.get("recordCount") || 0) - 1) });
  });
}

export async function deleteCustomer(storeId, customerId) {
  requireOnline();
  const root = storeRef(storeId);
  await ensureBalanceSummaries(storeId, [{ id: customerId }]);
  const [transactions, payments] = await Promise.all([
    root.collection("transactions").where("customerId", "==", customerId).get(),
    root.collection("payments").where("customerId", "==", customerId).get()
  ]);
  if (transactions.size + payments.size > 498) throw new Error("This customer's history is too large to delete at once.");
  const customerRef = root.collection("customers").doc(customerId);
  await db.runTransaction(async tx => {
    const customer = await tx.get(customerRef);
    const summary = await tx.get(balanceRef(root, customerId));
    if (!customer.exists) return;
    if (!summary.exists || Number(summary.get("recordCount") || 0) !== transactions.size + payments.size) {
      throw Object.assign(new Error("Customer history changed. Please retry the deletion."), { code: "aborted" });
    }
    if (Number(summary.get("totalDebt") || 0) > Number(summary.get("totalPaid") || 0)) {
      throw Object.assign(new Error("This customer has an unpaid balance and cannot be deleted."), { code: "failed-precondition" });
    }
    transactions.docs.forEach(row => tx.delete(row.ref));
    payments.docs.forEach(row => tx.delete(row.ref));
    tx.delete(customerRef);
    tx.delete(balanceRef(root, customerId));
  });
}

export async function recordPayment(storeId, customerId, payment) {
  requireOnline();
  const root = storeRef(storeId);
  const customerRef = root.collection("customers").doc(customerId);
  const paymentRef = root.collection("payments").doc(payment.id);
  await ensureBalanceSummaries(storeId, [{ id: customerId }]);
  const summaryRef = balanceRef(root, customerId);
  await db.runTransaction(async tx => {
    const customer = await tx.get(customerRef);
    const summary = await tx.get(summaryRef);
    if (!customer.exists) throw Object.assign(new Error("Customer not found."), { code: "not-found" });
    if (!summary.exists) throw Object.assign(new Error("Customer balance is not ready. Connect to the internet and retry."), { code: "unavailable" });
    const debt = Number(summary.get("totalDebt") || 0);
    const paid = Number(summary.get("totalPaid") || 0);
    if (payment.amount > Math.max(0, debt - paid)) throw Object.assign(new Error("Payment cannot be greater than the customer's current balance."), { code: "failed-precondition" });
    const existing = await tx.get(paymentRef);
    if (existing.exists) throw Object.assign(new Error("Payment already exists."), { code: "already-exists" });
    tx.set(paymentRef, recordForWrite(storeId, { ...payment, customerId }));
    tx.set(summaryRef, { storeId, customerId, totalDebt: debt, totalPaid: Math.round((paid + payment.amount) * 100) / 100, recordCount: Number(summary.get("recordCount") || 0) + 1 });
  });
}

export async function replaceStoreData(storeId, replacement) {
  requireOnline();
  const root = storeRef(storeId);
  const types = ["customers", "transactions", "payments", "balances"];
  const current = await Promise.all(types.map(type => root.collection(type).get()));
  const deletes = current.flatMap(snapshot => snapshot.docs.map(row => row.ref));
  for (let start = 0; start < deletes.length; start += 450) {
    const batch = db.batch();
    deletes.slice(start, start + 450).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
  const writes = [];
  replacement.customers.forEach(record => writes.push({ ref: root.collection("customers").doc(record.id), data: recordForWrite(storeId, record) }));
  replacement.customers.forEach(customer => {
    const totalDebt = replacement.transactions.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.total || 0), 0);
    const totalPaid = replacement.payments.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const recordCount = replacement.transactions.filter(row => row.customerId === customer.id).length + replacement.payments.filter(row => row.customerId === customer.id).length;
    writes.push({ ref: balanceRef(root, customer.id), data: { storeId, customerId: customer.id, totalDebt, totalPaid, recordCount } });
  });
  replacement.transactions.forEach(record => writes.push({ ref: root.collection("transactions").doc(record.id), data: recordForWrite(storeId, record) }));
  replacement.payments.forEach(record => writes.push({ ref: root.collection("payments").doc(record.id), data: recordForWrite(storeId, record) }));
  for (let start = 0; start < writes.length; start += 450) {
    const batch = db.batch();
    writes.slice(start, start + 450).forEach(write => batch.set(write.ref, write.data));
    await batch.commit();
  }
}

export async function readMigrationStatus(storeId, fingerprint) {
  const marker = storeRef(storeId).collection("migrations").doc(`legacy-${fingerprint}`);
  const snapshot = await marker.get();
  return snapshot.exists && snapshot.get("status") !== "importing";
}

export async function importLegacyData(storeId, legacy, fingerprint) {
  requireOnline();
  const root = storeRef(storeId);
  const marker = root.collection("migrations").doc(`legacy-${fingerprint}`);
  const existingMarker = await marker.get();
  if (existingMarker.exists && existingMarker.get("status") !== "importing") return false;
  const [customers, transactions, payments] = await Promise.all([
    root.collection("customers").get(), root.collection("transactions").get(), root.collection("payments").get()
  ]);
  if ([customers, transactions, payments].some(snapshot => snapshot.metadata.fromCache)) throw new Error("Connect to the internet before importing old data.");
  if (!existingMarker.exists && (customers.size || transactions.size || payments.size)) throw new Error("Import is only available to an empty store. Back up or restore data instead.");
  if (!existingMarker.exists) {
    await db.runTransaction(async tx => {
      const current = await tx.get(marker);
      if (!current.exists) tx.set(marker, { storeId, fingerprint, status: "importing", createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  }
  const operations = [
    ...legacy.customers.map(row => ({ type: "set", ref: root.collection("customers").doc(row.id), data: recordForWrite(storeId, row) })),
    ...legacy.customers.map(customer => {
      const totalDebt = legacy.transactions.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.total || 0), 0);
      const totalPaid = legacy.payments.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const recordCount = legacy.transactions.filter(row => row.customerId === customer.id).length + legacy.payments.filter(row => row.customerId === customer.id).length;
      return { type: "set", ref: balanceRef(root, customer.id), data: { storeId, customerId: customer.id, totalDebt, totalPaid, recordCount } };
    }),
    ...legacy.transactions.map(row => ({ type: "set", ref: root.collection("transactions").doc(row.id), data: recordForWrite(storeId, row) })),
    ...legacy.payments.map(row => ({ type: "set", ref: root.collection("payments").doc(row.id), data: recordForWrite(storeId, row) }))
  ];
  for (let start = 0; start < operations.length; start += 450) {
    const batch = db.batch();
    operations.slice(start, start + 450).forEach(operation => batch.set(operation.ref, operation.data));
    await batch.commit();
  }
  await marker.update({ status: "imported" });
  return true;
}

export async function skipLegacyData(storeId, fingerprint) {
  const marker = storeRef(storeId).collection("migrations").doc(`legacy-${fingerprint}`);
  await db.runTransaction(async tx => {
    const current = await tx.get(marker);
    if (!current.exists) {
      tx.set(marker, { storeId, fingerprint, status: "skipped", createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    } else if (current.get("status") === "importing") {
      tx.update(marker, { status: "skipped" });
    }
  });
}