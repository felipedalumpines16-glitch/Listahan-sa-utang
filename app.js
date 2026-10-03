import * as cloud from "./cloud.js";

(() => {
  const STORAGE_KEY = "utang-list-data-v1";
  const SITIOS = Array.from({ length: 7 }, (_, index) => `Sitio ${index + 1}`);
  const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
  const today = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const blankData = () => ({ customers: [], transactions: [], payments: [] });
  const money = value => peso.format(Math.max(0, Number(value) || 0));
  const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  let data = blankData();
  let syncedData = blankData();
  let activeStoreId = null;
  let activeStoreName = "";
  let unsubscribeStoreData = null;
  let unsubscribeStoreProfile = null;
  let explicitAuthInProgress = false;
  let cloudReady = false;
  let cloudServerConfirmed = false;
  let activeHistoryCustomerId = null;
  let messageTimer;

  function readLegacyData() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.customers) || !Array.isArray(parsed.transactions) || !Array.isArray(parsed.payments)) return null;
      if (!validBackup(parsed)) return null;
      return parsed;
    } catch (error) {
      console.error("Unable to read legacy Utang List data.", error);
      return null;
    }
  }

  function cloneData(value) {
    return structuredClone(value);
  }

  function balanceFor(customerId) {
    const debt = data.transactions.filter(row => row.customerId === customerId).reduce((sum, row) => sum + Number(row.total || 0), 0);
    const paid = data.payments.filter(row => row.customerId === customerId).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return { debt: roundMoney(debt), paid: roundMoney(paid), remaining: roundMoney(Math.max(0, debt - paid)) };
  }

  function showMessage(text, isError = false) {
    const message = document.querySelector("#app-message");
    message.textContent = text;
    message.classList.toggle("is-error", isError);
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { message.textContent = ""; message.classList.remove("is-error"); }, 4500);
  }

  function setCloudStatus(text, isError = false, quiet = false) {
    const status = document.querySelector("#cloud-status");
    const state = ["ONLINE", "OFFLINE", "SYNCING", "SYNC ERROR"].includes(text)
      ? text
      : (!navigator.onLine ? "OFFLINE" : isError ? "SYNC ERROR" : "SYNCING");
    status.textContent = state;
    status.dataset.state = state === "SYNC ERROR" ? "error" : state.toLowerCase();
    status.classList.toggle("is-error", state === "SYNC ERROR");
  }

  function userFacingError(error, fallback) {
    const code = error?.code || "";
    if (code === "store/profile-not-found") return "This authenticated account does not have a store profile. No profile was created during login.";
    if (error?.phase === "store-profile" && code.includes("permission-denied")) {
      return error.operation === "read"
        ? "Firebase Auth succeeded, but Firestore denied reading the store profile. Check the deployed rules for this user's UID."
        : "Firebase Auth succeeded, but Firestore denied creating the store profile. Check the deployed rules for this user's UID.";
    }
    if (code === "auth/invalid-email") return "The Store Name could not be converted to a valid Firebase sign-in identifier.";
    if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/user-not-found", "auth/wrong-password"].includes(code) || code.includes("unauthenticated")) return "Store name or password is incorrect.";
    if (["auth/email-already-in-use", "auth/account-exists-with-different-credential"].includes(code) || code.includes("already-exists")) return "This store name is already registered.";
    if (code === "auth/weak-password") return "Password must be at least 10 characters.";
    if (["auth/operation-not-allowed", "auth/configuration-not-found"].includes(code)) return "Enable Email/Password sign-in in Firebase Console, then try again.";
    if (code === "auth/network-request-failed" || !navigator.onLine) return "Internet connection is required to sign in on this device.";
    if (code.includes("unavailable")) return "Connect to the internet and retry this change.";
    if (code.includes("invalid-argument")) return "Check the information and try again.";
    if (code.includes("permission-denied")) return "Access denied. Please sign in again.";
    if (code.includes("failed-precondition")) return "Payment cannot be greater than the customer's current balance.";
    if (code === "auth/too-many-requests") return "Too many attempts. Please wait and try again.";
    return fallback;
  }

  function setAuthMessage(text, isError = false) {
    const message = document.querySelector("#auth-message");
    message.textContent = text;
    message.classList.toggle("is-error", isError);
  }

  function startStoreSession(user, storeName) {
    if (unsubscribeStoreData) unsubscribeStoreData();
    if (unsubscribeStoreProfile) unsubscribeStoreProfile();
    activeStoreId = user.uid;
    activeStoreName = storeName;
    syncedData = blankData();
    data = blankData();
    cloudReady = false;
    document.querySelector("#auth-screen").hidden = true;
    document.querySelector("#app-screen").hidden = false;
    document.querySelector("#account-store-name").textContent = storeName;
    document.querySelector("#account-menu").hidden = false;
    document.querySelector("#add-customer-open").hidden = false;
    document.querySelector("#store-info-name").textContent = storeName;
    setCloudStatus("SYNCING");
    unsubscribeStoreProfile = cloud.watchStoreProfile(activeStoreId, profile => {
      activeStoreName = profile.storeName;
      document.querySelector("#account-store-name").textContent = activeStoreName;
      document.querySelector("#store-info-name").textContent = activeStoreName;
    }, error => {
      console.warn("Store profile listener failed.", error.code || "unknown");
      setCloudStatus("SYNC ERROR");
    });
    unsubscribeStoreData = cloud.watchStoreData(activeStoreId, (next, status) => {
      syncedData = cloneData(next);
      data = cloneData(next);
      cloudReady = true;
      cloudServerConfirmed = !status.fromCache && !status.hasPendingWrites;
      render();
      if (activeHistoryCustomerId && document.querySelector("#history-dialog").open) renderHistory(activeHistoryCustomerId, false);
      setCloudStatus(!navigator.onLine || status.fromCache ? "OFFLINE" : status.hasPendingWrites ? "SYNCING" : "ONLINE");
      checkLegacyImport();
    }, error => {
      console.error("Cloud data listener failed.", error);
      setCloudStatus("SYNC ERROR", true);
      showMessage(userFacingError(error, "Could not load store data."), true);
    });
  }

  let migrationCheckRunning = false;
  async function checkLegacyImport() {
    if (!cloudReady || !cloudServerConfirmed || migrationCheckRunning || window.pendingLegacyData) return;
    const legacy = readLegacyData();
    if (!legacy || (!legacy.customers.length && !legacy.transactions.length && !legacy.payments.length)) return;
    migrationCheckRunning = true;
    try {
      const fingerprint = await digestLegacy(legacy);
      if (!(await cloud.readMigrationStatus(activeStoreId, fingerprint))) {
        window.pendingLegacyData = legacy;
        window.pendingLegacyFingerprint = fingerprint;
        showDialog("migration-dialog");
      }
    } catch (error) {
      console.error("Legacy data migration check failed.", error);
      showMessage("Could not check old data for import.", true);
    } finally {
      migrationCheckRunning = false;
    }
  }

  async function digestLegacy(legacy) {
    const bytes = new TextEncoder().encode(JSON.stringify(legacy));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function stopStoreSession() {
    if (unsubscribeStoreData) unsubscribeStoreData();
    if (unsubscribeStoreProfile) unsubscribeStoreProfile();
    unsubscribeStoreData = null;
    unsubscribeStoreProfile = null;
    activeStoreId = null;
    activeStoreName = "";
    cloudReady = false;
    cloudServerConfirmed = false;
    activeHistoryCustomerId = null;
    window.pendingLegacyData = null;
    window.pendingLegacyFingerprint = null;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    data = blankData();
    syncedData = blankData();
    document.querySelector("#app-screen").hidden = true;
    document.querySelector("#auth-screen").hidden = false;
    document.querySelector("#account-menu").hidden = true;
    document.querySelector("#add-customer-open").hidden = true;
    render();
  }

  function render() {
    const allDebt = data.transactions.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const allPaid = data.payments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const allRemaining = data.customers.reduce((sum, customer) => sum + balanceFor(customer.id).remaining, 0);
    document.querySelector("#summary-customers").textContent = data.customers.length;
    document.querySelector("#summary-debt").textContent = money(allDebt);
    document.querySelector("#summary-paid").textContent = money(allPaid);
    document.querySelector("#summary-remaining").textContent = money(allRemaining);

    const query = document.querySelector("#search-input").value.trim().toLocaleLowerCase();
    const sitio = document.querySelector("#sitio-filter").value;
    const customers = data.customers.filter(customer => customer.name.toLocaleLowerCase().includes(query) && (sitio === "all" || customer.sitio === sitio));
    document.querySelector("#customer-count").textContent = `${customers.length} ${customers.length === 1 ? "customer" : "customers"}`;
    const list = document.querySelector("#customer-list");
    list.replaceChildren();
    if (customers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = data.customers.length ? "No customers found" : "No customers yet";
      empty.append(title, document.createTextNode(data.customers.length ? "Try another name or sitio." : "Add a customer to start recording utang."));
      list.append(empty);
      return;
    }
    customers.sort((a, b) => a.name.localeCompare(b.name)).forEach(customer => list.append(createCustomerCard(customer)));
  }

  function createCustomerCard(customer) {
    const balance = balanceFor(customer.id);
    const card = document.createElement("article");
    card.className = "customer-card";
    const main = document.createElement("div");
    main.className = "customer-main";
    const name = document.createElement("h2");
    name.className = "customer-name";
    name.textContent = customer.name;
    const date = document.createElement("span");
    date.className = "customer-date";
    date.textContent = `Added ${formatDate(customer.createdAt)}`;
    main.append(name, date);

    const sitio = document.createElement("div");
    sitio.className = "customer-sitio-block";
    const sitioText = document.createElement("span");
    sitioText.className = "customer-sitio";
    sitioText.textContent = customer.sitio;
    sitio.append(sitioText);

    const balanceBlock = document.createElement("div");
    balanceBlock.className = "customer-balance-block";
    const amount = document.createElement("div");
    amount.className = "customer-balance";
    amount.textContent = money(balance.remaining);
    const status = document.createElement("span");
    status.className = `status ${balance.remaining > 0 ? "status-unpaid" : "status-paid"}`;
    status.textContent = balance.remaining > 0 ? "UNPAID" : "PAID";
    balanceBlock.append(amount, status);

    const actions = document.createElement("div");
    actions.className = "customer-actions";
    actions.append(
      actionButton("View", "view", customer.id, "button-outline"),
      actionButton("Pay", "pay", customer.id, "button-primary", balance.remaining <= 0),
      actionButton("+ Utang", "add-utang", customer.id, "button-outline"),
      actionButton("Edit", "edit-customer", customer.id, "button-outline"),
      actionButton("Delete", "delete-customer", customer.id, "button-outline")
    );
    card.append(main, sitio, balanceBlock, actions);
    return card;
  }

  function actionButton(label, action, id, style, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button ${style}`;
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.id = id;
    button.disabled = disabled;
    return button;
  }

  function formatDate(value) {
    if (!value) return "Date not set";
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { year: "numeric", month: "short", day: "numeric" }).format(parsed);
  }

  function showDialog(id) { document.getElementById(id).showModal(); }
  function closeDialog(id) { document.getElementById(id).close(); }

  function openCustomerForm(customer = null) {
    const form = document.querySelector("#customer-form");
    form.reset();
    document.querySelector("#customer-id").value = customer?.id || "";
    document.querySelector("#customer-name").value = customer?.name || "";
    document.querySelector("#customer-sitio").value = customer?.sitio || "";
    document.querySelector("#customer-dialog-title").textContent = customer ? "Edit customer" : "Add customer";
    showDialog("customer-dialog");
    document.querySelector("#customer-name").focus();
  }

  function populateCustomerSelect(selectedId = "") {
    const select = document.querySelector("#utang-customer");
    select.replaceChildren();
    data.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(customer => {
      const option = document.createElement("option");
      option.value = customer.id;
      option.textContent = `${customer.name} - ${customer.sitio}`;
      option.selected = customer.id === selectedId;
      select.append(option);
    });
    select.disabled = data.customers.length === 0;
  }

  function addItemRow(item = { name: "", quantity: "", price: "" }) {
    const template = document.querySelector("#item-row-template");
    const row = template.content.firstElementChild.cloneNode(true);
    row.querySelector(".item-name-input").value = item.name ?? "";
    row.querySelector(".item-quantity-input").value = item.quantity ?? "";
    row.querySelector(".item-price-input").value = item.price ?? "";
    document.querySelector("#item-rows").append(row);
    updateTotals();
  }

  function updateTotals() {
    let total = 0;
    document.querySelectorAll(".item-row").forEach(row => {
      const quantity = Number(row.querySelector(".item-quantity-input").value);
      const price = Number(row.querySelector(".item-price-input").value);
      const valid = Number.isInteger(quantity) && quantity > 0 && Number.isFinite(price) && price >= 0;
      const lineTotal = valid ? roundMoney(quantity * price) : 0;
      row.querySelector(".item-line-total strong").textContent = money(lineTotal);
      total += lineTotal;
    });
    document.querySelector("#utang-total").textContent = money(roundMoney(total));
  }

  function openUtangForm(customerId = "", transaction = null) {
    if (!data.customers.length) {
      showMessage("Add a customer before recording utang.", true);
      return;
    }
    const form = document.querySelector("#utang-form");
    form.reset();
    document.querySelector("#utang-id").value = transaction?.id || "";
    document.querySelector("#utang-dialog-title").textContent = transaction ? "Edit utang" : "Add utang";
    populateCustomerSelect(transaction?.customerId || customerId || data.customers[0].id);
    document.querySelector("#utang-customer").disabled = Boolean(transaction);
    document.querySelector("#utang-date").value = transaction?.date || today();
    document.querySelector("#item-rows").replaceChildren();
    (transaction?.items || [{}]).forEach(item => addItemRow(item));
    updateTotals();
    showDialog("utang-dialog");
    document.querySelector(".item-name-input").focus();
  }

  function openPaymentForm(customer) {
    const balance = balanceFor(customer.id).remaining;
    if (balance <= 0) return;
    document.querySelector("#payment-form").reset();
    document.querySelector("#payment-customer-id").value = customer.id;
    document.querySelector("#payment-customer-label").textContent = `${customer.name} · Balance ${money(balance)}`;
    document.querySelector("#payment-date").value = today();
    document.querySelector("#payment-amount").max = balance.toFixed(2);
    showDialog("payment-dialog");
    document.querySelector("#payment-amount").focus();
  }

  function renderHistory(customerId, open = true) {
    const customer = data.customers.find(row => row.id === customerId);
    if (!customer) return;
    activeHistoryCustomerId = customerId;
    const balance = balanceFor(customerId);
    document.querySelector("#history-title").textContent = customer.name;
    document.querySelector("#history-summary").textContent = `${customer.sitio} · Current balance ${money(balance.remaining)} · ${balance.remaining > 0 ? "UNPAID" : "PAID"}`;
    const entries = [
      ...data.transactions.filter(row => row.customerId === customerId).map(row => ({ ...row, kind: "debt" })),
      ...data.payments.filter(row => row.customerId === customerId).map(row => ({ ...row, kind: "payment" }))
    ].sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)));
    const content = document.querySelector("#history-content");
    content.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No utang or payments recorded for this customer.";
      content.append(empty);
      if (open && !document.querySelector("#history-dialog").open) showDialog("history-dialog");
      return;
    }
    let runningBalance = 0;
    entries.forEach(entry => {
      runningBalance = entry.kind === "debt" ? runningBalance + Number(entry.total) : Math.max(0, runningBalance - Number(entry.amount));
      const card = document.createElement("article");
      card.className = "history-entry";
      const top = document.createElement("div");
      top.className = "history-entry-top";
      const heading = document.createElement("div");
      const title = document.createElement("p");
      title.className = "history-entry-title";
      title.textContent = entry.kind === "debt" ? "Utang" : "Payment";
      const date = document.createElement("div");
      date.className = "history-entry-date";
      date.textContent = formatDate(entry.date);
      heading.append(title, date);
      const amount = document.createElement("strong");
      amount.className = "history-entry-amount";
      amount.textContent = `${entry.kind === "debt" ? "+" : "−"}${money(entry.kind === "debt" ? entry.total : entry.amount)}`;
      top.append(heading, amount);
      card.append(top);
      if (entry.kind === "debt") {
        const items = document.createElement("ul");
        items.className = "history-items";
        (entry.items || []).forEach(item => {
          const line = document.createElement("li");
          const description = document.createElement("span");
          description.textContent = `${item.name} · ${item.quantity} × ${money(item.price)}`;
          const lineTotal = document.createElement("span");
          lineTotal.textContent = money(item.total);
          line.append(description, lineTotal);
          items.append(line);
        });
        const totalLine = document.createElement("li");
        const totalLabel = document.createElement("strong");
        totalLabel.textContent = "Transaction total";
        const totalValue = document.createElement("strong");
        totalValue.textContent = money(entry.total);
        totalLine.append(totalLabel, totalValue);
        items.append(totalLine);
        card.append(items);
      }
      const bottom = document.createElement("div");
      bottom.className = "history-entry-bottom";
      const remaining = document.createElement("span");
      remaining.textContent = `Balance after entry ${money(runningBalance)}`;
      bottom.append(remaining);
      const actions = document.createElement("div");
      actions.className = "history-entry-actions";
      if (entry.kind === "debt") actions.append(actionButton("Edit", "edit-transaction", entry.id, "button-outline"));
      actions.append(actionButton("Delete", entry.kind === "debt" ? "delete-transaction" : "delete-payment", entry.id, "button-outline"));
      bottom.append(actions);
      card.append(bottom);
      content.append(card);
    });
    if (open && !document.querySelector("#history-dialog").open) showDialog("history-dialog");
  }

  function transactionFromForm() {
    const items = Array.from(document.querySelectorAll(".item-row"), row => {
      const name = row.querySelector(".item-name-input").value.trim();
      const quantity = Number(row.querySelector(".item-quantity-input").value);
      const price = Number(row.querySelector(".item-price-input").value);
      if (!name || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) throw new Error("Enter an item name, a whole quantity above zero, and a non-negative price for every item.");
      return { name, quantity, price: roundMoney(price), total: roundMoney(quantity * price) };
    });
    if (!items.length) throw new Error("Add at least one item.");
    return { items, total: roundMoney(items.reduce((sum, item) => sum + item.total, 0)) };
  }

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  }

  function validBackup(value) {
    if (!value || !Array.isArray(value.customers) || !Array.isArray(value.transactions) || !Array.isArray(value.payments)) return false;
    const customers = new Map();
    for (const customer of value.customers) {
      if (!customer || typeof customer.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(customer.id) || typeof customer.name !== "string" || !customer.name.trim() || customer.name.length > 80 || !SITIOS.includes(customer.sitio) || !validDate(customer.createdAt) || customers.has(customer.id)) return false;
      customers.set(customer.id, { id: customer.id, name: customer.name.trim(), sitio: customer.sitio, createdAt: customer.createdAt });
    }
    const transactionIds = new Set();
    const transactions = [];
    for (const transaction of value.transactions) {
      if (!transaction || typeof transaction.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(transaction.id) || transactionIds.has(transaction.id) || !customers.has(transaction.customerId) || !validDate(transaction.date) || !Array.isArray(transaction.items) || !transaction.items.length || transaction.items.length > 100) return false;
      let total = 0;
      const items = [];
      for (const item of transaction.items) {
        if (!item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.price)) || Number(item.price) < 0 || Number(item.price) > 1e12) return false;
        const quantity = Number(item.quantity);
        const price = roundMoney(item.price);
        const itemTotal = roundMoney(quantity * price);
        if (!Number.isFinite(itemTotal) || itemTotal > 1e12) return false;
        items.push({ name: item.name.trim(), quantity, price, total: itemTotal });
        total += itemTotal;
      }
      if (total > 1e12) return false;
      const createdAt = typeof transaction.createdAt === "string" && !Number.isNaN(Date.parse(transaction.createdAt)) ? transaction.createdAt : `${transaction.date}T00:00:00.000Z`;
      transactions.push({ id: transaction.id, customerId: transaction.customerId, date: transaction.date, items, total: roundMoney(total), createdAt });
      transactionIds.add(transaction.id);
    }
    const paymentIds = new Set();
    const payments = [];
    for (const payment of value.payments) {
      if (!payment || typeof payment.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payment.id) || paymentIds.has(payment.id) || !customers.has(payment.customerId) || !validDate(payment.date) || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0 || Number(payment.amount) > 1e12) return false;
      const amount = roundMoney(payment.amount);
      const createdAt = typeof payment.createdAt === "string" && !Number.isNaN(Date.parse(payment.createdAt)) ? payment.createdAt : `${payment.date}T00:00:00.000Z`;
      payments.push({ id: payment.id, customerId: payment.customerId, date: payment.date, amount, createdAt });
      paymentIds.add(payment.id);
    }
    const isBalanced = Array.from(customers.keys()).every(customerId => {
      const debt = transactions.filter(row => row.customerId === customerId).reduce((sum, row) => sum + row.total, 0);
      const paid = payments.filter(row => row.customerId === customerId).reduce((sum, row) => sum + row.amount, 0);
      return paid <= roundMoney(debt);
    });
    if (!isBalanced) return false;
    value.customers = Array.from(customers.values());
    value.transactions = transactions;
    value.payments = payments;
    return true;
  }

  document.querySelector("#add-customer-open").addEventListener("click", () => openCustomerForm());
  document.querySelector("#search-input").addEventListener("input", render);
  document.querySelector("#sitio-filter").addEventListener("change", render);
  document.querySelector("#add-item-button").addEventListener("click", () => addItemRow());
  document.querySelector("#item-rows").addEventListener("input", updateTotals);
  document.querySelector("#item-rows").addEventListener("click", event => {
    const button = event.target.closest(".remove-item");
    if (!button) return;
    if (document.querySelectorAll(".item-row").length === 1) {
      showMessage("Keep at least one item in the transaction.", true);
      return;
    }
    button.closest(".item-row").remove();
    updateTotals();
  });

  document.querySelector("#customer-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeStoreId || !cloudReady) return showMessage("Store data is still loading. Please wait.", true);
    const id = document.querySelector("#customer-id").value;
    const name = document.querySelector("#customer-name").value.trim();
    const sitio = document.querySelector("#customer-sitio").value;
    if (!name || !SITIOS.includes(sitio)) return;
    const existing = id && data.customers.find(row => row.id === id);
    const customer = {
      id: id || makeId(),
      storeId: activeStoreId,
      name,
      sitio,
      createdAt: existing?.createdAt || today()
    };
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await cloud.saveCustomer(activeStoreId, customer);
      closeDialog("customer-dialog");
      showMessage(id ? "Customer updated." : "Customer added.");
    } catch (error) {
      console.error("Customer save failed.", error);
      showMessage(userFacingError(error, "Could not save customer."), true);
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelector("#utang-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeStoreId || !cloudReady) return showMessage("Store data is still loading. Please wait.", true);
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const id = document.querySelector("#utang-id").value;
      const customerId = document.querySelector("#utang-customer").value;
      const date = document.querySelector("#utang-date").value;
      if (!data.customers.some(row => row.id === customerId) || !validDate(date)) throw new Error("Choose a customer and valid date.");
      const calculated = transactionFromForm();
      const previous = id && data.transactions.find(row => row.id === id);
      const transaction = {
        id: id || makeId(),
        storeId: activeStoreId,
        customerId: previous?.customerId || customerId,
        date,
        items: calculated.items,
        total: calculated.total,
        createdAt: previous?.createdAt || new Date().toISOString()
      };
      if (previous) {
        const paid = balanceFor(previous.customerId).paid;
        const otherDebt = data.transactions.filter(row => row.customerId === previous.customerId && row.id !== id).reduce((sum, row) => sum + row.total, 0);
        if (roundMoney(otherDebt + calculated.total) < paid) throw new Error("This edit would make recorded payments greater than the customer's total utang.");
      }
      await cloud.saveTransaction(activeStoreId, transaction);
      closeDialog("utang-dialog");
      showMessage(id ? "Utang updated." : "Utang recorded.");
    } catch (error) {
      const message = error.code?.includes("failed-precondition")
        ? "Utang cannot be reduced below payments already recorded."
        : error.code ? userFacingError(error, "Could not save utang.") : error.message;
      showMessage(message, true);
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelector("#payment-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeStoreId || !cloudReady) return showMessage("Store data is still loading. Please wait.", true);
    const submit = event.submitter;
    submit.disabled = true;
    const customerId = document.querySelector("#payment-customer-id").value;
    const amount = roundMoney(Number(document.querySelector("#payment-amount").value));
    const date = document.querySelector("#payment-date").value;
    const balance = balanceFor(customerId).remaining;
    if (!validDate(date) || !Number.isFinite(amount) || amount <= 0) {
      showMessage("Enter a valid date and payment amount above zero.", true);
      submit.disabled = false;
      return;
    }
    if (amount > balance) {
      showMessage(`Payment cannot be more than the remaining balance of ${money(balance)}.`, true);
      submit.disabled = false;
      return;
    }
    try {
      setCloudStatus("SYNCING");
      await cloud.recordPayment(activeStoreId, customerId, { id: makeId(), date, amount, createdAt: new Date().toISOString() });
      closeDialog("payment-dialog");
      showMessage("Payment recorded.");
    } catch (error) {
      console.error("Payment save failed.", error);
      setCloudStatus("SYNC ERROR", true);
      showMessage(userFacingError(error, "Could not save payment. Please try again."), true);
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelector("#customer-list").addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const customer = data.customers.find(row => row.id === button.dataset.id);
    if (!customer) return;
    switch (button.dataset.action) {
      case "view": renderHistory(customer.id); break;
      case "pay": openPaymentForm(customer); break;
      case "add-utang": openUtangForm(customer.id); break;
      case "edit-customer": openCustomerForm(customer); break;
      case "delete-customer": {
        if (balanceFor(customer.id).remaining > 0) {
          showMessage("This customer has an unpaid balance and cannot be deleted.", true);
          break;
        }
        if (!window.confirm(`Delete ${customer.name} and all of their history? This cannot be undone.`)) break;
        try {
          await cloud.deleteCustomer(activeStoreId, customer.id);
          showMessage("Customer and history deleted.");
        } catch (error) {
          console.error("Customer deletion failed.", error);
          showMessage(userFacingError(error, "Could not delete the customer."), true);
        }
        break;
      }
    }
  });

  document.querySelector("#history-content").addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button || !activeHistoryCustomerId) return;
    const transaction = data.transactions.find(row => row.id === button.dataset.id);
    const payment = data.payments.find(row => row.id === button.dataset.id);
    if (button.dataset.action === "edit-transaction" && transaction) {
      closeDialog("history-dialog");
      openUtangForm(transaction.customerId, transaction);
    } else if (button.dataset.action === "delete-transaction" && transaction) {
      const remainingDebt = data.transactions.filter(row => row.customerId === transaction.customerId && row.id !== transaction.id).reduce((sum, row) => sum + row.total, 0);
      if (roundMoney(remainingDebt) < balanceFor(transaction.customerId).paid) {
        showMessage("This transaction cannot be deleted because recorded payments would exceed the remaining utang.", true);
        return;
      }
      if (!window.confirm(`Delete this ${money(transaction.total)} utang transaction? This cannot be undone.`)) return;
      try {
        await cloud.deleteTransaction(activeStoreId, transaction.id);
        showMessage("Utang transaction deleted.");
      } catch (error) {
        console.error("Utang deletion failed.", error);
        showMessage(userFacingError(error, "Could not delete the utang transaction."), true);
      }
    } else if (button.dataset.action === "delete-payment" && payment) {
      if (!window.confirm(`Delete this ${money(payment.amount)} payment record? The customer's balance will increase. This cannot be undone.`)) return;
      try {
        await cloud.deletePayment(activeStoreId, payment.id);
        showMessage("Payment record deleted.");
      } catch (error) {
        console.error("Payment deletion failed.", error);
        showMessage(userFacingError(error, "Could not delete the payment record."), true);
      }
    }
    
  });

  document.querySelector("#history-add-utang").addEventListener("click", () => {
    const customerId = activeHistoryCustomerId;
    closeDialog("history-dialog");
    openUtangForm(customerId);
  });

  document.querySelector("#store-info-button").addEventListener("click", () => {
    document.querySelector("#account-menu").open = false;
    showDialog("store-info-dialog");
  });

  document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => closeDialog(button.dataset.closeDialog)));
  document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));

  document.querySelector("#backup-button").addEventListener("click", () => {
    const backup = {
      app: "Utang List",
      version: 1,
      storeName: activeStoreName,
      sitios: SITIOS,
      exportedAt: new Date().toISOString(),
      customers: data.customers.map(({ storeId, ...record }) => record),
      transactions: data.transactions.map(({ storeId, ...record }) => record),
      payments: data.payments.map(({ storeId, ...record }) => record)
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `utang-list-backup-${today()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showMessage("Backup downloaded.");
  });

  document.querySelector("#restore-button").addEventListener("click", () => document.querySelector("#restore-file").click());
  document.querySelector("#restore-file").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const restored = JSON.parse(await file.text());
      if (!validBackup(restored)) throw new Error("This backup is invalid or contains inconsistent records.");
      if (!window.confirm(`Restore this backup to ${activeStoreName}? It will replace all data for this store account.`)) return;
      const submit = event.target;
      submit.disabled = true;
      setCloudStatus("SYNCING");
      const replacement = { customers: restored.customers, transactions: restored.transactions, payments: restored.payments };
      await cloud.replaceStoreData(activeStoreId, replacement);
      data = cloneData(replacement);
      syncedData = cloneData(replacement);
      render();
      setCloudStatus(navigator.onLine ? "ONLINE" : "OFFLINE");
      showMessage("Backup restored.");
    } catch (error) {
      console.error("Cloud backup restore failed.", error);
      showMessage(error instanceof SyntaxError ? "The selected file is not valid JSON." : userFacingError(error, "Backup restore failed."), true);
    } finally {
      event.target.value = "";
      event.target.disabled = false;
    }
  });

  document.querySelector("#show-create-account").addEventListener("click", () => {
    document.querySelector("#login-form").hidden = true;
    document.querySelector("#create-store-form").hidden = false;
    document.querySelector("#show-create-account").hidden = true;
    document.querySelector("#show-login").hidden = false;
    document.querySelector("#auth-title").textContent = "CREATE STORE ACCOUNT";
    document.querySelector("#auth-intro").textContent = "Choose a store name and a strong password.";
    setAuthMessage("");
  });

  document.querySelector("#show-login").addEventListener("click", () => {
    document.querySelector("#create-store-form").hidden = true;
    document.querySelector("#login-form").hidden = false;
    document.querySelector("#show-login").hidden = true;
    document.querySelector("#show-create-account").hidden = false;
    document.querySelector("#auth-title").textContent = "UTANG LIST";
    document.querySelector("#auth-intro").textContent = "Sign in to access your store records.";
    setAuthMessage("");
  });

  document.querySelector("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const submit = document.querySelector("#login-submit");
    explicitAuthInProgress = true;
    submit.disabled = true;
    setAuthMessage("Signing in…");
    try {
      const { user, profile } = await cloud.loginStore(document.querySelector("#login-store-name").value.trim(), document.querySelector("#login-password").value);
      document.querySelector("#login-password").value = "";
      setAuthMessage("");
      startStoreSession(user, profile.storeName);
    } catch (error) {
      console.warn("Interactive store login failed.", {
        source: "interactive-login-failed",
        code: error.code || "unknown"
      });
      setAuthMessage(userFacingError(error, "Could not sign in. Check your connection and try again."), true);
    } finally {
      document.querySelector("#login-password").value = "";
      submit.disabled = false;
      explicitAuthInProgress = false;
    }
  });

  document.querySelector("#create-store-form").addEventListener("submit", async event => {
    event.preventDefault();
    const storeName = document.querySelector("#create-store-name").value.trim();
    const password = document.querySelector("#create-password").value;
    const confirmation = document.querySelector("#confirm-password").value;
    if (!storeName) return setAuthMessage("Store Name cannot be empty.", true);
    if (password.length < 10) return setAuthMessage("Password must be at least 10 characters.", true);
    if (password !== confirmation) return setAuthMessage("Passwords do not match.", true);
    const submit = document.querySelector("#create-store-submit");
    explicitAuthInProgress = true;
    submit.disabled = true;
    setAuthMessage("Creating store account…");
    try {
      const { user, profile } = await cloud.createStoreAccount(storeName, password);
      document.querySelector("#create-password").value = "";
      document.querySelector("#confirm-password").value = "";
      setAuthMessage("");
      startStoreSession(user, profile.storeName);
    } catch (error) {
      console.warn("Store account creation failed.", error.code || "unknown");
      setAuthMessage(userFacingError(error, "Could not create the store account. Check your connection and try again."), true);
    } finally {
      document.querySelector("#create-password").value = "";
      document.querySelector("#confirm-password").value = "";
      submit.disabled = false;
      explicitAuthInProgress = false;
    }
  });

  document.querySelector("#logout-button").addEventListener("click", async () => {
    document.querySelector("#logout-button").disabled = true;
    try {
      if (unsubscribeStoreData) unsubscribeStoreData();
      if (unsubscribeStoreProfile) unsubscribeStoreProfile();
      unsubscribeStoreData = null;
      unsubscribeStoreProfile = null;
      await cloud.logoutStore();
      stopStoreSession();
      location.reload();
    } catch (error) {
      console.error("Logout failed.", error);
      showMessage("Could not log out. Please try again.", true);
    } finally {
      document.querySelector("#logout-button").disabled = false;
    }
  });

  document.querySelector("#import-migration").addEventListener("click", async () => {
    const button = document.querySelector("#import-migration");
    button.disabled = true;
    button.textContent = "IMPORTING…";
    try {
      const legacy = window.pendingLegacyData;
      if (!legacy) throw new Error("Old data is no longer available. Reload and sign in again.");
      const imported = await cloud.importLegacyData(activeStoreId, legacy, window.pendingLegacyFingerprint);
      closeDialog("migration-dialog");
      window.pendingLegacyData = null;
      window.pendingLegacyFingerprint = null;
      showMessage(imported ? "Old data imported to this store." : "This old dataset was already imported.");
    } catch (error) {
      console.error("Legacy data import failed.", error);
      showMessage(userFacingError(error, "Could not import old data."), true);
    } finally {
      button.disabled = false;
      button.textContent = "IMPORT DATA";
    }
  });

  document.querySelector("#skip-migration").addEventListener("click", () => {
    cloud.skipLegacyData(activeStoreId, window.pendingLegacyFingerprint).then(() => {
      closeDialog("migration-dialog");
      window.pendingLegacyData = null;
      window.pendingLegacyFingerprint = null;
    }).catch(error => {
      console.error("Legacy data skip record failed.", error);
      showMessage("Could not save your Skip choice. Please try again.", true);
    });
  });

  render();
  window.addEventListener("offline", () => {
    if (activeStoreId) setCloudStatus("OFFLINE");
  });
  window.addEventListener("online", () => {
    if (activeStoreId) setCloudStatus("SYNCING");
  });
  const authControls = document.querySelectorAll("#login-submit, #create-store-submit, #show-create-account, #show-login");
  authControls.forEach(button => { button.disabled = true; });
  setAuthMessage("Checking sign-in status…");
  cloud.initializeCloud().then(async () => {
    let firstAuthEvent = true;
    let finishInitialAuthEvent;
    const initialAuthEventFinished = new Promise(resolve => { finishInitialAuthEvent = resolve; });
    let authEventQueue = Promise.resolve();

    const handleAuthState = async (authenticatedUser, skipProfileRead, isInitialEvent) => {
      if (!authenticatedUser) {
        if (activeStoreId) stopStoreSession();
        else if (isInitialEvent) setAuthMessage("");
        return;
      }
      if (skipProfileRead) return;
      if (activeStoreId === authenticatedUser.uid) return;
      if (activeStoreId && activeStoreId !== authenticatedUser.uid) stopStoreSession();
      try {
        const profile = await cloud.getStoreProfile(authenticatedUser);
        startStoreSession(authenticatedUser, profile.storeName);
      } catch (error) {
        console.warn("Could not restore authenticated store account.", error.code || "unknown");
        setAuthMessage(userFacingError(error, "Could not load this store account."), true);
        await cloud.logoutStore().catch(logoutError => console.warn("Invalid store session sign-out failed.", logoutError.code || "unknown"));
      }
    };

    cloud.authChanges(authenticatedUser => {
      const isInitialEvent = firstAuthEvent;
      firstAuthEvent = false;
      const skipProfileRead = explicitAuthInProgress;
      authEventQueue = authEventQueue.then(() => handleAuthState(authenticatedUser, skipProfileRead, isInitialEvent)).catch(error => {
        console.warn("Authentication state handling failed.", error.code || "unknown");
        setAuthMessage(userFacingError(error, "Could not restore your sign-in. Connect to the internet and reload."), true);
      });
      if (isInitialEvent) authEventQueue.finally(finishInitialAuthEvent);
    }, error => {
      console.warn("Authentication state listener failed.", error.code || "unknown");
      setAuthMessage(userFacingError(error, "Could not restore your sign-in. Connect to the internet and reload."), true);
      if (firstAuthEvent) {
        firstAuthEvent = false;
        finishInitialAuthEvent();
      }
    });

    await initialAuthEventFinished;
    authControls.forEach(button => { button.disabled = false; });
  }).catch(error => {
    console.error("Firebase initialization failed.", error);
    document.querySelector("#setup-message").textContent = error.message.includes("configuration is incomplete")
      ? "Cloud accounts are not active yet. Check the Firebase web configuration."
      : "Could not connect to the store service. Check your internet connection.";
  });

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("service-worker.js").catch(error => console.error("Service worker registration failed.", error));
  }
})();