import { firebaseConfig } from "./firebase-config.js";
import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  where,
  getFirestore
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

const configReady = Object.values(firebaseConfig).every(value => typeof value === "string" && value && !value.startsWith("YOUR_"));
const INTERNAL_EMAIL_DOMAIN = "auth.utang-list.internal";
let app;
let auth;
let db;
let authInitialized = false;
const reconciledBalanceDigests = new Map();

export async function initializeCloud() {
  if (!configReady) throw new Error("Firebase web configuration is incomplete.");
  const defaultApp = getApps().find(candidate => candidate.name === "[DEFAULT]");
  app = defaultApp || initializeApp(firebaseConfig);
  if (app.options.projectId !== "utang-list" || app.options.projectId !== firebaseConfig.projectId) {
    throw new Error("Firebase is initialized for a different project. Expected utang-list.");
  }
  auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (error) {
    if (!String(error.code || "").includes("failed-precondition") && !String(error.message || "").includes("already initialized")) throw error;
    console.warn("Using the existing Firestore instance; persistent multi-tab cache could not be reconfigured.", error.code || "unknown");
    db = getFirestore(app);
  }
  const initialUser = await new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, user => {
      unsubscribe();
      resolve(user);
    }, error => {
      unsubscribe();
      reject(error);
    });
  });
  authInitialized = true;
  return initialUser;
}

export function authChanges(callback, onError) {
  if (!authInitialized) throw new Error("Firebase Auth initial state has not been resolved.");
  return onAuthStateChanged(auth, callback, onError);
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

function currentUser() {
  return auth?.currentUser || null;
}

function storeRef(storeId) {
  if (!currentUser() || currentUser().uid !== storeId) throw Object.assign(new Error("Permission denied."), { code: "permission-denied" });
  return doc(db, "stores", storeId);
}

function storeCollection(storeId, name) {
  storeRef(storeId);
  return collection(db, "stores", storeId, name);
}

function recordForWrite(storeId, record) {
  if (!record || typeof record.id !== "string" || !record.id) throw new Error("Invalid record.");
  const { id, ...fields } = record;
  return { ...fields, id, storeId };
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
    currentUserUid: currentUser()?.uid || null
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
}

function logProfileRead(user) {
  console.info("[Firebase store profile read]", profileContext(user));
}

async function readStoreProfile(user, cacheFirst = false) {
  try {
    await verifyAuthenticatedUser(user, "read");
    const reference = storeRef(user.uid);
    if (cacheFirst) {
      logProfileRead(user);
      try {
        const cached = await getDocFromCache(reference);
        if (cached.exists()) return cached.data();
      } catch (error) {
        if (navigator.onLine && error.code !== "unavailable") throw error;
      }
      if (!navigator.onLine) {
        throw Object.assign(new Error("The store profile is not available in this device's offline cache."), { code: "store/profile-not-cached" });
      }
    }
    logProfileRead(user);
    const snapshot = cacheFirst ? await getDocFromServer(reference) : await getDocFromServer(reference);
    return snapshot.exists() ? snapshot.data() : null;
  } catch (error) {
    logFirebaseError("store profile read", error, profileContext(user));
    throw Object.assign(error, { phase: "store-profile", operation: "read" });
  }
}

async function createStoreProfile(user, storeName) {
  await verifyAuthenticatedUser(user, "create");
  const cleanName = String(storeName).normalize("NFKC").trim().replace(/\s+/g, " ");
  const reference = storeRef(user.uid);
  console.info("[Firebase store profile create]", profileContext(user));
  try {
    await setDoc(reference, {
      storeId: user.uid,
      storeName: cleanName,
      normalizedStoreName: normalizeStoreName(cleanName),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    logFirebaseError("store profile create", error, profileContext(user));
    throw Object.assign(error, { phase: "store-profile", operation: "create" });
  }
  const profile = await readStoreProfile(user);
  if (!profile) throw Object.assign(new Error("The store profile was not found after creation."), { code: "store/profile-not-found", phase: "store-profile", operation: "verify" });
  return profile;
}

export async function createStoreAccount(storeName, password) {
  const email = await internalEmailFor(storeName);
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  try {
    const profile = await createStoreProfile(credential.user, storeName);
    return { user: credential.user, profile };
  } catch (error) {
    await signOut(auth).catch(signOutError => logFirebaseError("signOut after profile failure", signOutError));
    throw error;
  }
}

export async function loginStore(storeName, password) {
  const email = await internalEmailFor(storeName);
  let credential;
  try {
    credential = await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    logFirebaseError("signInWithEmailAndPassword", error);
    throw error;
  }
  const profile = await readStoreProfile(credential.user);
  if (!profile) {
    await signOut(auth);
    throw Object.assign(new Error("This authenticated account does not have a store profile."), { code: "store/profile-not-found", phase: "store-profile", operation: "read" });
  }
  return { user: credential.user, profile };
}

export async function logoutStore() {
  await signOut(auth);
}

export function currentStoreId() {
  return currentUser()?.uid || null;
}

export async function getStoreProfile(user) {
  const profile = await readStoreProfile(user, true);
  if (!profile) throw Object.assign(new Error("This authenticated account does not have a store profile."), { code: "store/profile-not-found", phase: "store-profile", operation: "read" });
  return profile;
}

export function watchStoreData(storeId, callback, onError) {
  const types = ["customers", "transactions", "payments"];
  const next = { customers: [], transactions: [], payments: [] };
  const ready = new Set();
  const snapshots = {};
  let lastReconcileDigest = "";
  const emit = () => {
    if (ready.size !== types.length) return;
    const fromCache = types.some(type => snapshots[type]?.metadata.fromCache);
    const hasPendingWrites = types.some(type => snapshots[type]?.metadata.hasPendingWrites);
    callback(structuredClone(next), { fromCache, hasPendingWrites });
    if (!fromCache && !hasPendingWrites) {
      const digest = balanceDigest(next);
      if (digest !== lastReconcileDigest) {
        lastReconcileDigest = digest;
        reconcileBalanceSummaries(storeId, next).catch(error => logFirebaseError("balance summary reconcile", error, { uid: storeId, path: `stores/${storeId}/balances` }));
      }
    }
  };
  const unsubscribers = types.map(type => onSnapshot(storeCollection(storeId, type), { includeMetadataChanges: true }, snapshot => {
    next[type] = snapshot.docs.map(row => ({ ...row.data(), id: row.id }));
    snapshots[type] = snapshot;
    ready.add(type);
    emit();
  }, onError));
  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

export function watchStoreProfile(storeId, callback, onError) {
  return onSnapshot(storeRef(storeId), { includeMetadataChanges: true }, snapshot => {
    if (!snapshot.exists()) {
      if (snapshot.metadata.fromCache) return callback(null, { fromCache: true, hasPendingWrites: snapshot.metadata.hasPendingWrites });
      return onError(Object.assign(new Error("Store account profile was not found."), { code: "store/profile-not-found" }));
    }
    callback(snapshot.data(), { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
  }, onError);
}

function balanceRef(storeId, customerId) {
  return doc(db, "stores", storeId, "balances", customerId);
}

function customerTransactionsQuery(storeId, customerId) {
  return query(storeCollection(storeId, "transactions"), where("customerId", "==", customerId));
}

function customerPaymentsQuery(storeId, customerId) {
  return query(storeCollection(storeId, "payments"), where("customerId", "==", customerId));
}

function balanceValues(transactions, payments, storeId, customerId) {
  return {
    storeId,
    customerId,
    totalDebt: transactions.docs.reduce((sum, row) => sum + Number(row.data().total || 0), 0),
    totalPaid: payments.docs.reduce((sum, row) => sum + Number(row.data().amount || 0), 0),
    recordCount: transactions.size + payments.size
  };
}

function balanceDigest(data) {
  return JSON.stringify({
    customers: data.customers.map(customer => customer.id),
    transactions: data.transactions.map(row => [row.id, row.customerId, row.total]),
    payments: data.payments.map(row => [row.id, row.customerId, row.amount])
  });
}

async function reconcileBalanceSummaries(storeId, data) {
  if (!navigator.onLine || currentStoreId() !== storeId) return;
  const totalsByCustomer = new Map(data.customers.map(customer => [customer.id, { totalDebt: 0, totalPaid: 0, recordCount: 0 }]));
  data.transactions.forEach(row => {
    const totals = totalsByCustomer.get(row.customerId);
    if (totals) {
      totals.totalDebt += Number(row.total || 0);
      totals.recordCount += 1;
    }
  });
  data.payments.forEach(row => {
    const totals = totalsByCustomer.get(row.customerId);
    if (totals) {
      totals.totalPaid += Number(row.amount || 0);
      totals.recordCount += 1;
    }
  });
  const summaries = [];
  for (const [customerId, totals] of totalsByCustomer) {
    const reference = balanceRef(storeId, customerId);
    try {
      const existing = await getDocFromServer(reference);
      if (existing.exists()) {
        const current = existing.data();
        if (current.totalDebt === totals.totalDebt && current.totalPaid === totals.totalPaid && current.recordCount === totals.recordCount) continue;
      }
    } catch (error) {
      if (!navigator.onLine) return;
      throw error;
    }
    const value = { storeId, customerId, ...totals };
    summaries.push({ reference, value });
  }
  for (let offset = 0; offset < summaries.length; offset += 450) {
    const batch = writeBatch(db);
    summaries.slice(offset, offset + 450).forEach(({ reference, value }) => batch.set(reference, value));
    await batch.commit();
  }
}

async function getBalanceSummary(storeId, customerId, useCache = false) {
  const customerRef = doc(db, "stores", storeId, "customers", customerId);
  const summaryRef = balanceRef(storeId, customerId);
  const getDocument = useCache ? getDocFromCache : getDocFromServer;
  const [customer, summary] = await Promise.all([getDocument(customerRef), getDocument(summaryRef)]);
  if (!customer.exists()) throw Object.assign(new Error("Customer not found."), { code: "not-found" });
  if (summary.exists()) return summary.data();
  const txQuery = customerTransactionsQuery(storeId, customerId);
  const payQuery = customerPaymentsQuery(storeId, customerId);
  const getQuery = useCache ? getDocsFromCache : getDocsFromServer;
  const [transactions, payments] = await Promise.all([getQuery(txQuery), getQuery(payQuery)]);
  const value = balanceValues(transactions, payments, storeId, customerId);
  const summaryReference = balanceRef(storeId, customerId);
  if (useCache) {
    const batch = writeBatch(db);
    batch.set(summaryReference, value);
    await batch.commit();
    return value;
  }
  await runTransaction(db, async transaction => {
    const current = await transaction.get(summaryReference);
    if (!current.exists()) transaction.set(summaryReference, value);
  });
  const refreshed = await getDocFromServer(summaryReference);
  return refreshed.data() || value;
}

export async function ensureBalanceSummaries(storeId, customers) {
  for (const customer of customers) {
    await getBalanceSummary(storeId, customer.id, !navigator.onLine);
  }
}

export async function saveCustomer(storeId, customer) {
  const reference = doc(storeCollection(storeId, "customers"), customer.id);
  await setDoc(reference, recordForWrite(storeId, customer));
}

async function saveTransactionOffline(storeId, transaction) {
  const reference = doc(storeCollection(storeId, "transactions"), transaction.id);
  const summary = await getBalanceSummary(storeId, transaction.customerId, true);
  const priorSnapshot = await getDocFromCache(reference).catch(() => null);
  const prior = priorSnapshot?.exists() ? priorSnapshot.data() : null;
  if (prior && prior.customerId !== transaction.customerId) throw Object.assign(new Error("Transaction customer cannot be changed."), { code: "permission-denied" });
  const totalDebt = Number(summary.totalDebt || 0) - Number(prior?.total || 0) + transaction.total;
  if (Math.round(totalDebt * 100) < Math.round(Number(summary.totalPaid || 0) * 100)) {
    throw Object.assign(new Error("Utang cannot be reduced below payments already recorded."), { code: "failed-precondition" });
  }
  const batch = writeBatch(db);
  batch.set(reference, recordForWrite(storeId, transaction));
  batch.set(balanceRef(storeId, transaction.customerId), {
    storeId,
    customerId: transaction.customerId,
    totalDebt: Math.round(totalDebt * 100) / 100,
    totalPaid: Number(summary.totalPaid || 0),
    recordCount: Number(summary.recordCount || 0) + (prior ? 0 : 1)
  });
  await batch.commit();
}

export async function saveTransaction(storeId, transaction) {
  const reference = doc(storeCollection(storeId, "transactions"), transaction.id);
  if (!navigator.onLine) return saveTransactionOffline(storeId, transaction);
  try {
    await getBalanceSummary(storeId, transaction.customerId);
    const summaryReference = balanceRef(storeId, transaction.customerId);
    await runTransaction(db, async tx => {
      const customerReference = doc(db, "stores", storeId, "customers", transaction.customerId);
      const [customer, summary, prior] = await Promise.all([tx.get(customerReference), tx.get(summaryReference), tx.get(reference)]);
      if (!customer.exists()) throw Object.assign(new Error("Customer not found."), { code: "not-found" });
      if (!summary.exists()) throw Object.assign(new Error("Customer balance is not ready."), { code: "unavailable" });
      if (prior.exists() && prior.data().customerId !== transaction.customerId) throw Object.assign(new Error("Transaction customer cannot be changed."), { code: "permission-denied" });
      const totalDebt = Number(summary.data().totalDebt || 0) - Number(prior.data()?.total || 0) + transaction.total;
      const totalPaid = Number(summary.data().totalPaid || 0);
      if (Math.round(totalDebt * 100) < Math.round(totalPaid * 100)) throw Object.assign(new Error("Utang cannot be reduced below payments already recorded."), { code: "failed-precondition" });
      tx.set(reference, recordForWrite(storeId, transaction));
      tx.set(summaryReference, { storeId, customerId: transaction.customerId, totalDebt: Math.round(totalDebt * 100) / 100, totalPaid, recordCount: Number(summary.data().recordCount || 0) + (prior.exists() ? 0 : 1) });
    });
  } catch (error) {
    if (!navigator.onLine || error.code === "unavailable") return saveTransactionOffline(storeId, transaction);
    throw error;
  }
}

export async function deleteTransaction(storeId, transactionId) {
  const reference = doc(storeCollection(storeId, "transactions"), transactionId);
  const initial = navigator.onLine ? await getDoc(reference) : await getDocFromCache(reference);
  if (!initial.exists()) return;
  const customerId = initial.data().customerId;
  const summary = await getBalanceSummary(storeId, customerId, !navigator.onLine);
  const debt = Number(summary.totalDebt || 0) - Number(initial.data().total || 0);
  const paid = Number(summary.totalPaid || 0);
  if (Math.round(debt * 100) < Math.round(paid * 100)) throw Object.assign(new Error("Recorded payments would exceed the remaining utang."), { code: "failed-precondition" });
  const batch = writeBatch(db);
  batch.delete(reference);
  batch.set(balanceRef(storeId, customerId), { storeId, customerId, totalDebt: Math.round(debt * 100) / 100, totalPaid: paid, recordCount: Math.max(0, Number(summary.recordCount || 0) - 1) });
  await batch.commit();
}

export async function deletePayment(storeId, paymentId) {
  const reference = doc(storeCollection(storeId, "payments"), paymentId);
  const initial = navigator.onLine ? await getDoc(reference) : await getDocFromCache(reference);
  if (!initial.exists()) return;
  const payment = initial.data();
  const summary = await getBalanceSummary(storeId, payment.customerId, !navigator.onLine);
  const batch = writeBatch(db);
  batch.delete(reference);
  batch.set(balanceRef(storeId, payment.customerId), {
    storeId,
    customerId: payment.customerId,
    totalDebt: Number(summary.totalDebt || 0),
    totalPaid: Math.max(0, Math.round((Number(summary.totalPaid || 0) - Number(payment.amount || 0)) * 100) / 100),
    recordCount: Math.max(0, Number(summary.recordCount || 0) - 1)
  });
  await batch.commit();
}

export async function deleteCustomer(storeId, customerId) {
  const transactionsQuery = customerTransactionsQuery(storeId, customerId);
  const paymentsQuery = customerPaymentsQuery(storeId, customerId);
  const getQuery = navigator.onLine ? getDocs : getDocsFromCache;
  const [transactions, payments] = await Promise.all([getQuery(transactionsQuery), getQuery(paymentsQuery)]);
  if (transactions.size + payments.size > 498) throw new Error("This customer's history is too large to delete at once.");
  const summary = await getBalanceSummary(storeId, customerId, !navigator.onLine);
  if (Number(summary.totalDebt || 0) > Number(summary.totalPaid || 0)) throw Object.assign(new Error("This customer has an unpaid balance and cannot be deleted."), { code: "failed-precondition" });
  const batch = writeBatch(db);
  transactions.docs.forEach(row => batch.delete(row.ref));
  payments.docs.forEach(row => batch.delete(row.ref));
  batch.delete(doc(db, "stores", storeId, "customers", customerId));
  batch.delete(balanceRef(storeId, customerId));
  await batch.commit();
}

async function recordPaymentOffline(storeId, customerId, payment) {
  const summary = await getBalanceSummary(storeId, customerId, true);
  const amount = Number(payment.amount);
  if (amount > Math.max(0, Number(summary.totalDebt || 0) - Number(summary.totalPaid || 0))) {
    throw Object.assign(new Error("Payment cannot be greater than the customer's current balance."), { code: "failed-precondition" });
  }
  const batch = writeBatch(db);
  batch.set(doc(storeCollection(storeId, "payments"), payment.id), recordForWrite(storeId, { ...payment, customerId }));
  batch.set(balanceRef(storeId, customerId), {
    storeId,
    customerId,
    totalDebt: Number(summary.totalDebt || 0),
    totalPaid: Math.round((Number(summary.totalPaid || 0) + amount) * 100) / 100,
    recordCount: Number(summary.recordCount || 0) + 1
  });
  await batch.commit();
}

export async function recordPayment(storeId, customerId, payment) {
  if (!navigator.onLine) return recordPaymentOffline(storeId, customerId, payment);
  const customerReference = doc(db, "stores", storeId, "customers", customerId);
  const paymentReference = doc(storeCollection(storeId, "payments"), payment.id);
  try {
    await getBalanceSummary(storeId, customerId);
    const summaryReference = balanceRef(storeId, customerId);
    await runTransaction(db, async tx => {
      const [customer, summary, existing] = await Promise.all([tx.get(customerReference), tx.get(summaryReference), tx.get(paymentReference)]);
      if (!customer.exists()) throw Object.assign(new Error("Customer not found."), { code: "not-found" });
      if (!summary.exists()) throw Object.assign(new Error("Customer balance is not ready."), { code: "unavailable" });
      if (existing.exists()) throw Object.assign(new Error("Payment already exists."), { code: "already-exists" });
      const totalDebt = Number(summary.data().totalDebt || 0);
      const totalPaid = Number(summary.data().totalPaid || 0);
      if (payment.amount > Math.max(0, totalDebt - totalPaid)) throw Object.assign(new Error("Payment cannot be greater than the customer's current balance."), { code: "failed-precondition" });
      tx.set(paymentReference, recordForWrite(storeId, { ...payment, customerId }));
      tx.set(summaryReference, { storeId, customerId, totalDebt, totalPaid: Math.round((totalPaid + payment.amount) * 100) / 100, recordCount: Number(summary.data().recordCount || 0) + 1 });
    });
  } catch (error) {
    if (!navigator.onLine || error.code === "unavailable") return recordPaymentOffline(storeId, customerId, payment);
    throw error;
  }
}

export async function replaceStoreData(storeId, replacement) {
  const collectionNames = ["customers", "transactions", "payments", "balances"];
  const getQuery = navigator.onLine ? getDocs : getDocsFromCache;
  const current = await Promise.all(collectionNames.map(name => getQuery(collection(db, "stores", storeId, name))));
  const deletes = current.flatMap(snapshot => snapshot.docs.map(row => row.ref));
  for (let offset = 0; offset < deletes.length; offset += 450) {
    const batch = writeBatch(db);
    deletes.slice(offset, offset + 450).forEach(reference => batch.delete(reference));
    await batch.commit();
  }
  const writes = [];
  replacement.customers.forEach(record => writes.push({ reference: doc(db, "stores", storeId, "customers", record.id), data: recordForWrite(storeId, record) }));
  replacement.customers.forEach(customer => {
    const totalDebt = replacement.transactions.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.total || 0), 0);
    const totalPaid = replacement.payments.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const recordCount = replacement.transactions.filter(row => row.customerId === customer.id).length + replacement.payments.filter(row => row.customerId === customer.id).length;
    writes.push({ reference: balanceRef(storeId, customer.id), data: { storeId, customerId: customer.id, totalDebt, totalPaid, recordCount } });
  });
  replacement.transactions.forEach(record => writes.push({ reference: doc(db, "stores", storeId, "transactions", record.id), data: recordForWrite(storeId, record) }));
  replacement.payments.forEach(record => writes.push({ reference: doc(db, "stores", storeId, "payments", record.id), data: recordForWrite(storeId, record) }));
  for (let offset = 0; offset < writes.length; offset += 450) {
    const batch = writeBatch(db);
    writes.slice(offset, offset + 450).forEach(write => batch.set(write.reference, write.data));
    await batch.commit();
  }
}

export async function readMigrationStatus(storeId, fingerprint) {
  const snapshot = await getDoc(doc(db, "stores", storeId, "migrations", `legacy-${fingerprint}`));
  return snapshot.exists() && snapshot.data().status !== "importing";
}

export async function importLegacyData(storeId, legacy, fingerprint) {
  if (!navigator.onLine) throw Object.assign(new Error("Connect to the internet before importing old data."), { code: "unavailable" });
  const marker = doc(db, "stores", storeId, "migrations", `legacy-${fingerprint}`);
  const existingMarker = await getDocFromServer(marker);
  if (existingMarker.exists() && existingMarker.data().status !== "importing") return false;
  const [customers, transactions, payments] = await Promise.all([
    getDocsFromServer(storeCollection(storeId, "customers")),
    getDocsFromServer(storeCollection(storeId, "transactions")),
    getDocsFromServer(storeCollection(storeId, "payments"))
  ]);
  if (!existingMarker.exists() && (customers.size || transactions.size || payments.size)) throw new Error("Import is only available to an empty store. Back up or restore data instead.");
  if (!existingMarker.exists()) {
    await runTransaction(db, async tx => {
      const current = await tx.get(marker);
      if (!current.exists()) tx.set(marker, { storeId, fingerprint, status: "importing", createdAt: serverTimestamp() });
    });
  }
  const operations = [
    ...legacy.customers.map(row => ({ reference: doc(db, "stores", storeId, "customers", row.id), data: recordForWrite(storeId, row) })),
    ...legacy.customers.map(customer => {
      const totalDebt = legacy.transactions.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.total || 0), 0);
      const totalPaid = legacy.payments.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const recordCount = legacy.transactions.filter(row => row.customerId === customer.id).length + legacy.payments.filter(row => row.customerId === customer.id).length;
      return { reference: balanceRef(storeId, customer.id), data: { storeId, customerId: customer.id, totalDebt, totalPaid, recordCount } };
    }),
    ...legacy.transactions.map(row => ({ reference: doc(db, "stores", storeId, "transactions", row.id), data: recordForWrite(storeId, row) })),
    ...legacy.payments.map(row => ({ reference: doc(db, "stores", storeId, "payments", row.id), data: recordForWrite(storeId, row) }))
  ];
  for (let offset = 0; offset < operations.length; offset += 450) {
    const batch = writeBatch(db);
    operations.slice(offset, offset + 450).forEach(operation => batch.set(operation.reference, operation.data));
    await batch.commit();
  }
  await updateDoc(marker, { status: "imported" });
  return true;
}

export async function skipLegacyData(storeId, fingerprint) {
  const marker = doc(db, "stores", storeId, "migrations", `legacy-${fingerprint}`);
  await runTransaction(db, async tx => {
    const current = await tx.get(marker);
    if (!current.exists()) {
      tx.set(marker, { storeId, fingerprint, status: "skipped", createdAt: serverTimestamp() });
    } else if (current.data().status === "importing") {
      tx.update(marker, { status: "skipped" });
    }
  });
}
