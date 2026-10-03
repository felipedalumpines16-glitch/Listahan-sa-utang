"use strict";

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();
const loginPepper = defineSecret("LOGIN_RATE_LIMIT_PEPPER");
const MIN_PASSWORD_LENGTH = 10;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-real-store-password", 12);
const SITIOS = new Set(Array.from({ length: 7 }, (_, index) => `Sitio ${index + 1}`));

function requireStore(request) {
  if (!request.auth?.uid || request.auth.token?.storeAccount !== true) {
    throw new HttpsError("unauthenticated", "Please sign in to your store account.");
  }
  return request.auth.uid;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function calculateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw new HttpsError("invalid-argument", "Add between 1 and 100 items.");
  }
  let total = 0;
  const normalized = items.map(item => {
    if (typeof item?.name !== "string" || !item.name.trim() || item.name.length > 80 || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.price) || item.price < 0) {
      throw new HttpsError("invalid-argument", "An item has an invalid name, quantity, or price.");
    }
    const itemTotal = Math.round((item.quantity * item.price + Number.EPSILON) * 100) / 100;
    if (!Number.isFinite(itemTotal)) throw new HttpsError("invalid-argument", "An item total is too large.");
    total += itemTotal;
    if (!Number.isFinite(total)) throw new HttpsError("invalid-argument", "The transaction total is too large.");
    return { name: item.name.trim(), quantity: item.quantity, price: Math.round((item.price + Number.EPSILON) * 100) / 100, total: itemTotal };
  });
  return { items: normalized, total: Math.round(total * 100) / 100 };
}

function validateStoreData(data) {
  if (!data || !Array.isArray(data.customers) || !Array.isArray(data.transactions) || !Array.isArray(data.payments)) {
    throw new HttpsError("invalid-argument", "Backup data is invalid.");
  }
  const customers = new Map();
  for (const row of data.customers) {
    if (!row || !validId(row.id) || typeof row.name !== "string" || !row.name.trim() || row.name.length > 80 || !SITIOS.has(row.sitio) || !validDate(row.createdAt) || customers.has(row.id)) {
      throw new HttpsError("invalid-argument", "Backup contains an invalid customer.");
    }
    customers.set(row.id, { id: row.id, name: row.name.trim(), sitio: row.sitio, createdAt: row.createdAt });
  }
  const transactionIds = new Set();
  const transactions = data.transactions.map(row => {
    if (!row || !validId(row.id) || transactionIds.has(row.id) || !customers.has(row.customerId) || !validDate(row.date)) {
      throw new HttpsError("invalid-argument", "Backup contains an invalid transaction.");
    }
    transactionIds.add(row.id);
    const calculated = calculateItems(row.items);
    const createdAt = typeof row.createdAt === "string" && !Number.isNaN(Date.parse(row.createdAt)) ? row.createdAt : `${row.date}T00:00:00.000Z`;
    return { id: row.id, customerId: row.customerId, date: row.date, items: calculated.items, total: calculated.total, createdAt };
  });
  const paymentIds = new Set();
  const payments = data.payments.map(row => {
    if (!row || !validId(row.id) || paymentIds.has(row.id) || !customers.has(row.customerId) || !validDate(row.date) || !Number.isFinite(row.amount) || row.amount <= 0) {
      throw new HttpsError("invalid-argument", "Backup contains an invalid payment.");
    }
    paymentIds.add(row.id);
    const amount = Math.round((row.amount + Number.EPSILON) * 100) / 100;
    if (amount <= 0 || amount > 1e12) throw new HttpsError("invalid-argument", "Backup contains an invalid payment amount.");
    const createdAt = typeof row.createdAt === "string" && !Number.isNaN(Date.parse(row.createdAt)) ? row.createdAt : `${row.date}T00:00:00.000Z`;
    return { id: row.id, customerId: row.customerId, date: row.date, amount, createdAt };
  });
  for (const customerId of customers.keys()) {
    const debt = transactions.filter(row => row.customerId === customerId).reduce((sum, row) => sum + row.total, 0);
    const paid = payments.filter(row => row.customerId === customerId).reduce((sum, row) => sum + row.amount, 0);
    if (Math.round(paid * 100) > Math.round(debt * 100)) throw new HttpsError("invalid-argument", "Backup payments exceed a customer's recorded utang.");
  }
  return { customers: [...customers.values()], transactions, payments };
}

function normalizeStoreName(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase("en");
}

function validateCredentials(storeName, password) {
  if (typeof storeName !== "string" || !storeName.trim() || storeName.trim().length > 80 || /[\/\\\u0000-\u001f\u007f]/.test(storeName)) {
    throw new HttpsError("invalid-argument", "Enter a store name (maximum 80 characters).");
  }
  if (!normalizeStoreName(storeName)) throw new HttpsError("invalid-argument", "Enter a valid store name.");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    throw new HttpsError("invalid-argument", "Password must be between 10 and 128 characters.");
  }
}

function attemptDocumentKey(request, normalizedName) {
  const address = request.rawRequest.ip || "unknown";
  return crypto.createHmac("sha256", loginPepper.value()).update(`${address}:${normalizedName}`).digest("hex");
}

async function checkAndRecordAttempt(key) {
  const ref = db.collection("loginAttempts").doc(key);
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const attempt = snapshot.exists ? snapshot.data() : {};
    const startedAt = Number(attempt.startedAt || 0);
    const count = now - startedAt > 15 * 60 * 1000 ? 0 : Number(attempt.count || 0);
    if (count >= 5) throw new HttpsError("resource-exhausted", "Too many attempts. Please try again later.");
    transaction.set(ref, { startedAt: count ? startedAt : now, count: count + 1 });
  });
}

async function clearAttempts(key) {
  await db.collection("loginAttempts").doc(key).delete().catch(() => {});
}

exports.createStoreAccount = onCall({ region: "asia-southeast1", maxInstances: 5, enforceAppCheck: true }, async request => {
  const { storeName, password } = request.data || {};
  validateCredentials(storeName, password);
  const normalizedName = normalizeStoreName(storeName);
  const storeId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  const claimRef = db.collection("storeNames").doc(crypto.createHash("sha256").update(normalizedName).digest("hex"));
  const storeRef = db.collection("stores").doc(storeId);
  const credentialRef = db.collection("storeCredentials").doc(crypto.createHash("sha256").update(normalizedName).digest("hex"));
  try {
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(claimRef);
      if (existing.exists) throw new HttpsError("already-exists", "A store account with this name already exists.");
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      transaction.create(claimRef, { storeId });
      transaction.create(credentialRef, { storeId, passwordHash });
      transaction.create(storeRef, { storeName: storeName.trim(), createdAt: timestamp, updatedAt: timestamp });
    });
    return { customToken: await admin.auth().createCustomToken(storeId, { storeAccount: true }) };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Store account creation failed", error);
    throw new HttpsError("internal", "Could not create the store account. Please try again.");
  }
});

exports.loginStore = onCall({ region: "asia-southeast1", maxInstances: 10, secrets: [loginPepper], enforceAppCheck: true }, async request => {
  const { storeName, password } = request.data || {};
  if (typeof storeName !== "string" || !storeName.trim() || storeName.trim().length > 80 || typeof password !== "string" || !password || password.length > 128) {
    throw new HttpsError("invalid-argument", "Enter your store name and password.");
  }
  const normalizedName = normalizeStoreName(storeName);
  const nameKey = crypto.createHash("sha256").update(normalizedName).digest("hex");
  let rateLimitKey;
  try {
    rateLimitKey = attemptDocumentKey(request, normalizedName);
    await checkAndRecordAttempt(rateLimitKey);
    const credential = await db.collection("storeCredentials").doc(nameKey).get();
    const passwordMatches = await bcrypt.compare(password, credential.exists ? credential.get("passwordHash") : DUMMY_PASSWORD_HASH);
    if (!credential.exists || !passwordMatches) {
      throw new HttpsError("unauthenticated", "Store name or password is incorrect.");
    }
    await clearAttempts(rateLimitKey);
    return { customToken: await admin.auth().createCustomToken(credential.get("storeId"), { storeAccount: true }) };
  } catch (error) {
    if (error instanceof HttpsError) {
      if (error.code === "unauthenticated") throw error;
      if (error.code === "resource-exhausted") throw error;
      console.error("Store login failed", error);
      throw new HttpsError("unavailable", "Login service is temporarily unavailable.");
    }
    console.error("Store login failed", error);
    throw new HttpsError("unavailable", "Login service is temporarily unavailable.");
  }
});

exports.recordPayment = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = request.auth?.uid;
  const isStoreAccount = request.auth?.token?.storeAccount === true;
  const { customerId, payment } = request.data || {};
  if (!storeId || !isStoreAccount) throw new HttpsError("unauthenticated", "Please sign in to your store account.");
  const roundedAmount = Number.isFinite(payment?.amount) ? Math.round((payment.amount + Number.EPSILON) * 100) / 100 : 0;
  if (!validId(customerId) || !payment || !validId(payment.id) || !validDate(payment.date) || !Number.isFinite(payment.amount) || roundedAmount <= 0 || roundedAmount > 1e12) {
    throw new HttpsError("invalid-argument", "Enter a valid payment date and amount.");
  }
  const root = db.collection("stores").doc(storeId);
  const customerRef = root.collection("customers").doc(customerId);
  const guardRef = root.collection("balanceGuards").doc(customerId);
  const transactionsQuery = root.collection("transactions").where("customerId", "==", customerId);
  const paymentsQuery = root.collection("payments").where("customerId", "==", customerId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const customer = await transaction.get(customerRef);
      const guard = await transaction.get(guardRef);
      const transactions = await transaction.get(transactionsQuery);
      const payments = await transaction.get(paymentsQuery);
      if (!customer.exists) throw new HttpsError("not-found", "Customer not found.");
      const totalDebt = transactions.docs.reduce((sum, row) => sum + Number(row.get("total") || 0), 0);
      const totalPaid = payments.docs.reduce((sum, row) => sum + Number(row.get("amount") || 0), 0);
      const balance = Math.round(Math.max(0, totalDebt - totalPaid) * 100) / 100;
      if (roundedAmount > balance) throw new HttpsError("failed-precondition", "Payment is more than the remaining balance.");
      transaction.create(root.collection("payments").doc(payment.id), {
        id: payment.id,
        storeId,
        customerId,
        date: payment.date,
        amount: roundedAmount,
        createdAt: payment.createdAt || new Date().toISOString()
      });
      transaction.set(guardRef, { revision: Number(guard.get("revision") || 0) + 1 });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Payment save failed", error);
    throw new HttpsError("unavailable", "Could not save the payment. Please try again.");
  }
});

exports.saveTransaction = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { transaction: input } = request.data || {};
  if (!input || !validId(input.id) || !validId(input.customerId) || !validDate(input.date)) {
    throw new HttpsError("invalid-argument", "Choose a customer and valid transaction date.");
  }
  const calculated = calculateItems(input.items);
  const root = db.collection("stores").doc(storeId);
  const transactionRef = root.collection("transactions").doc(input.id);
  const customerRef = root.collection("customers").doc(input.customerId);
  const guardRef = root.collection("balanceGuards").doc(input.customerId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const customer = await transaction.get(customerRef);
      const existing = await transaction.get(transactionRef);
      const guard = await transaction.get(guardRef);
      const transactions = await transaction.get(root.collection("transactions").where("customerId", "==", input.customerId));
      const payments = await transaction.get(root.collection("payments").where("customerId", "==", input.customerId));
      if (!customer.exists) throw new HttpsError("not-found", "Customer not found.");
      if (existing.exists && existing.get("customerId") !== input.customerId) throw new HttpsError("permission-denied", "Transaction customer cannot be changed.");
      const otherDebt = transactions.docs.filter(row => row.id !== input.id).reduce((sum, row) => sum + Number(row.get("total") || 0), 0);
      const paid = payments.docs.reduce((sum, row) => sum + Number(row.get("amount") || 0), 0);
      if (Math.round((otherDebt + calculated.total) * 100) < Math.round(paid * 100)) {
        throw new HttpsError("failed-precondition", "Utang cannot be reduced below payments already recorded.");
      }
      const record = {
        id: input.id,
        storeId,
        customerId: input.customerId,
        date: input.date,
        items: calculated.items,
        total: calculated.total,
        createdAt: existing.exists ? existing.get("createdAt") : (input.createdAt || new Date().toISOString())
      };
      transaction.set(transactionRef, record);
      transaction.set(guardRef, { revision: Number(guard.get("revision") || 0) + 1 });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Utang save failed", error);
    throw new HttpsError("unavailable", "Could not save the utang transaction.");
  }
});

exports.deleteTransaction = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { transactionId } = request.data || {};
  if (!validId(transactionId)) throw new HttpsError("invalid-argument", "Transaction is invalid.");
  const root = db.collection("stores").doc(storeId);
  const reference = root.collection("transactions").doc(transactionId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const record = await transaction.get(reference);
      if (!record.exists) throw new HttpsError("not-found", "Transaction not found.");
      const customerId = record.get("customerId");
      const guardRef = root.collection("balanceGuards").doc(customerId);
      const guard = await transaction.get(guardRef);
      const transactions = await transaction.get(root.collection("transactions").where("customerId", "==", customerId));
      const payments = await transaction.get(root.collection("payments").where("customerId", "==", customerId));
      const debt = transactions.docs.filter(row => row.id !== transactionId).reduce((sum, row) => sum + Number(row.get("total") || 0), 0);
      const paid = payments.docs.reduce((sum, row) => sum + Number(row.get("amount") || 0), 0);
      if (Math.round(debt * 100) < Math.round(paid * 100)) throw new HttpsError("failed-precondition", "This transaction cannot be deleted because payments are recorded against it.");
      transaction.delete(reference);
      transaction.set(guardRef, { revision: Number(guard.get("revision") || 0) + 1 });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Utang deletion failed", error);
    throw new HttpsError("unavailable", "Could not delete the utang transaction.");
  }
});

exports.deletePayment = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { paymentId } = request.data || {};
  if (!validId(paymentId)) throw new HttpsError("invalid-argument", "Payment is invalid.");
  const root = db.collection("stores").doc(storeId);
  const reference = root.collection("payments").doc(paymentId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const payment = await transaction.get(reference);
      if (!payment.exists) throw new HttpsError("not-found", "Payment not found.");
      const guardRef = root.collection("balanceGuards").doc(payment.get("customerId"));
      const guard = await transaction.get(guardRef);
      transaction.delete(reference);
      transaction.set(guardRef, { revision: Number(guard.get("revision") || 0) + 1 });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Payment deletion failed", error);
    throw new HttpsError("unavailable", "Could not delete the payment.");
  }
});

exports.deleteCustomer = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { customerId } = request.data || {};
  if (!validId(customerId)) throw new HttpsError("invalid-argument", "Customer is invalid.");
  const root = db.collection("stores").doc(storeId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const customerRef = root.collection("customers").doc(customerId);
      const guardRef = root.collection("balanceGuards").doc(customerId);
      const customer = await transaction.get(customerRef);
      const guard = await transaction.get(guardRef);
      const transactions = await transaction.get(root.collection("transactions").where("customerId", "==", customerId));
      const payments = await transaction.get(root.collection("payments").where("customerId", "==", customerId));
      if (!customer.exists) throw new HttpsError("not-found", "Customer not found.");
      const debt = transactions.docs.reduce((sum, row) => sum + Number(row.get("total") || 0), 0);
      const paid = payments.docs.reduce((sum, row) => sum + Number(row.get("amount") || 0), 0);
      if (Math.round(Math.max(0, debt - paid) * 100) > 0) throw new HttpsError("failed-precondition", "Customer has an unpaid balance and cannot be deleted.");
      if (transactions.size + payments.size + 2 > 450) throw new HttpsError("resource-exhausted", "This customer has too much history to delete in one operation.");
      transaction.delete(customerRef);
      transactions.docs.forEach(row => transaction.delete(row.ref));
      payments.docs.forEach(row => transaction.delete(row.ref));
      transaction.set(guardRef, { revision: Number(guard.get("revision") || 0) + 1 });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Customer deletion failed", error);
    throw new HttpsError("unavailable", "Could not delete the customer.");
  }
});

exports.restoreStoreData = onCall({ region: "asia-southeast1", maxInstances: 5, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const data = validateStoreData(request.data?.data);
  if (data.customers.length + data.transactions.length + data.payments.length > 450) {
    throw new HttpsError("resource-exhausted", "This backup contains too many records to restore in one operation.");
  }
  const root = db.collection("stores").doc(storeId);
  let locked = false;
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (!store.exists) throw new HttpsError("not-found", "Store account not found.");
      if (store.get("maintenance") === true) throw new HttpsError("aborted", "Another restore is already in progress.");
      transaction.update(root, { maintenance: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    locked = true;
    const existingByType = {};
    for (const type of ["customers", "transactions", "payments"]) {
      existingByType[type] = await root.collection(type).get();
    }
    const writeCount = Object.values(existingByType).reduce((sum, snapshot) => sum + snapshot.size, 0)
      + data.customers.length + data.transactions.length + data.payments.length;
    if (writeCount > 450) throw new HttpsError("resource-exhausted", "This restore is too large to apply atomically. Existing data was not changed.");
    const batch = db.batch();
    Object.values(existingByType).forEach(snapshot => snapshot.docs.forEach(row => batch.delete(row.ref)));
    for (const type of ["customers", "transactions", "payments"]) {
      data[type].forEach(record => {
        if (!validId(record?.id)) throw new HttpsError("invalid-argument", "Backup contains a record without a valid ID.");
        const { storeId: ignoredStoreId, ...safeRecord } = record;
        batch.set(root.collection(type).doc(record.id), { ...safeRecord, storeId });
      });
    }
    await batch.commit();
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Backup restore failed", error);
    throw new HttpsError("unavailable", "Could not restore this backup.");
  } finally {
    if (locked) await root.update({ maintenance: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(error => console.error("Could not release the store restore lock", error));
  }
});

exports.importLegacyData = onCall({ region: "asia-southeast1", maxInstances: 5, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { fingerprint } = request.data || {};
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new HttpsError("invalid-argument", "Legacy data is invalid.");
  }
  const data = validateStoreData(request.data.data);
  const records = data.customers.length + data.transactions.length + data.payments.length;
  if (records > 450) throw new HttpsError("resource-exhausted", "There are too many records to import in one operation.");
  const root = db.collection("stores").doc(storeId);
  const marker = root.collection("migrations").doc(`legacy-${fingerprint}`);
  const customerIds = new Map(data.customers.map(record => [record.id, crypto.randomUUID()]));
  const customerWrites = data.customers.map(record => {
    const id = customerIds.get(record.id);
    const { storeId: ignoredStoreId, ...safeRecord } = record;
    return [root.collection("customers").doc(id), { ...safeRecord, id, storeId }];
  });
  const transactionWrites = data.transactions.map(record => {
    const id = crypto.randomUUID();
    const { storeId: ignoredStoreId, ...safeRecord } = record;
    return [root.collection("transactions").doc(id), { ...safeRecord, id, customerId: customerIds.get(record.customerId), storeId }];
  });
  const paymentWrites = data.payments.map(record => {
    const id = crypto.randomUUID();
    const { storeId: ignoredStoreId, ...safeRecord } = record;
    return [root.collection("payments").doc(id), { ...safeRecord, id, customerId: customerIds.get(record.customerId), storeId }];
  });
  let imported = false;
  await db.runTransaction(async transaction => {
    const store = await transaction.get(root);
    const prior = await transaction.get(marker);
    if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
    if (prior.exists) return;
    [...customerWrites, ...transactionWrites, ...paymentWrites].forEach(([ref, value]) => transaction.create(ref, value));
    transaction.create(marker, { state: "imported", completedAt: admin.firestore.FieldValue.serverTimestamp() });
    imported = true;
  });
  return { imported };
});

exports.skipLegacyImport = onCall({ region: "asia-southeast1", maxInstances: 5, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { fingerprint } = request.data || {};
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new HttpsError("invalid-argument", "Dataset marker is invalid.");
  const root = db.collection("stores").doc(storeId);
  const marker = root.collection("migrations").doc(`legacy-${fingerprint}`);
  await db.runTransaction(async transaction => {
    const store = await transaction.get(root);
    const existing = await transaction.get(marker);
    if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
    if (!existing.exists) transaction.create(marker, { state: "skipped", completedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { success: true };
});

exports.saveCustomer = onCall({ region: "asia-southeast1", maxInstances: 10, enforceAppCheck: true }, async request => {
  const storeId = requireStore(request);
  const { customer } = request.data || {};
  if (!customer || !validId(customer.id) || typeof customer.name !== "string" || !customer.name.trim() || customer.name.trim().length > 80 || !SITIOS.has(customer.sitio) || !validDate(customer.createdAt)) {
    throw new HttpsError("invalid-argument", "Enter a valid customer name, Sitio, and date.");
  }
  const root = db.collection("stores").doc(storeId);
  try {
    await db.runTransaction(async transaction => {
      const store = await transaction.get(root);
      if (store.get("maintenance") === true) throw new HttpsError("unavailable", "Store data is being restored. Please try again shortly.");
      const reference = root.collection("customers").doc(customer.id);
      const existing = await transaction.get(reference);
      transaction.set(reference, {
        id: customer.id,
        storeId,
        name: customer.name.trim(),
        sitio: customer.sitio,
        createdAt: existing.exists ? existing.get("createdAt") : customer.createdAt
      });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error("Customer save failed", error);
    throw new HttpsError("unavailable", "Could not save this customer.");
  }
});