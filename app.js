"use strict";

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
  let data = loadData();
  let activeHistoryCustomerId = null;
  let messageTimer;

  function loadData() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return blankData();
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.customers) || !Array.isArray(parsed.transactions) || !Array.isArray(parsed.payments)) return blankData();
      return parsed;
    } catch (error) {
      console.error("Unable to load saved Utang List data.", error);
      return blankData();
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Unable to save Utang List data.", error);
      showMessage("Could not save data on this device. Check available storage.", true);
      return false;
    }
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

  function saveAndRender(message) {
    if (!persist()) return false;
    render();
    if (message) showMessage(message);
    return true;
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

  function renderHistory(customerId) {
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
      showDialog("history-dialog");
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
    showDialog("history-dialog");
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
      if (!customer || typeof customer.id !== "string" || !customer.id || typeof customer.name !== "string" || !customer.name.trim() || !SITIOS.includes(customer.sitio) || !validDate(customer.createdAt) || customers.has(customer.id)) return false;
      customers.set(customer.id, customer);
    }
    const transactionIds = new Set();
    for (const transaction of value.transactions) {
      if (!transaction || typeof transaction.id !== "string" || transactionIds.has(transaction.id) || !customers.has(transaction.customerId) || !validDate(transaction.date) || !Array.isArray(transaction.items) || !transaction.items.length) return false;
      let total = 0;
      for (const item of transaction.items) {
        if (!item || typeof item.name !== "string" || !item.name.trim() || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.price)) || Number(item.price) < 0) return false;
        item.quantity = Number(item.quantity);
        item.price = roundMoney(item.price);
        item.total = roundMoney(item.quantity * item.price);
        total += item.total;
      }
      transaction.total = roundMoney(total);
      transactionIds.add(transaction.id);
    }
    const paymentIds = new Set();
    for (const payment of value.payments) {
      if (!payment || typeof payment.id !== "string" || paymentIds.has(payment.id) || !customers.has(payment.customerId) || !validDate(payment.date) || !Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0) return false;
      payment.amount = roundMoney(payment.amount);
      paymentIds.add(payment.id);
    }
    return value.customers.every(customer => {
      const debt = value.transactions.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + row.total, 0);
      const paid = value.payments.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + row.amount, 0);
      return paid <= roundMoney(debt);
    });
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

  document.querySelector("#customer-form").addEventListener("submit", event => {
    event.preventDefault();
    const id = document.querySelector("#customer-id").value;
    const name = document.querySelector("#customer-name").value.trim();
    const sitio = document.querySelector("#customer-sitio").value;
    if (!name || !SITIOS.includes(sitio)) return;
    if (id) {
      const customer = data.customers.find(row => row.id === id);
      if (customer) Object.assign(customer, { name, sitio });
    } else {
      data.customers.push({ id: makeId(), name, sitio, createdAt: today() });
    }
    if (saveAndRender(id ? "Customer updated." : "Customer added.")) closeDialog("customer-dialog");
  });

  document.querySelector("#utang-form").addEventListener("submit", event => {
    event.preventDefault();
    try {
      const id = document.querySelector("#utang-id").value;
      const customerId = document.querySelector("#utang-customer").value;
      const date = document.querySelector("#utang-date").value;
      if (!data.customers.some(row => row.id === customerId) || !validDate(date)) throw new Error("Choose a customer and valid date.");
      const calculated = transactionFromForm();
      const previous = id && data.transactions.find(row => row.id === id);
      if (previous) {
        const paid = balanceFor(previous.customerId).paid;
        const otherDebt = data.transactions.filter(row => row.customerId === previous.customerId && row.id !== id).reduce((sum, row) => sum + row.total, 0);
        if (roundMoney(otherDebt + calculated.total) < paid) throw new Error("This edit would make recorded payments greater than the customer's total utang.");
        Object.assign(previous, { date, items: calculated.items, total: calculated.total });
      } else {
        data.transactions.push({ id: makeId(), customerId, date, items: calculated.items, total: calculated.total, createdAt: new Date().toISOString() });
      }
      if (saveAndRender(id ? "Utang updated." : "Utang recorded.")) closeDialog("utang-dialog");
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  document.querySelector("#payment-form").addEventListener("submit", event => {
    event.preventDefault();
    const customerId = document.querySelector("#payment-customer-id").value;
    const amount = roundMoney(Number(document.querySelector("#payment-amount").value));
    const date = document.querySelector("#payment-date").value;
    const balance = balanceFor(customerId).remaining;
    if (!validDate(date) || !Number.isFinite(amount) || amount <= 0) {
      showMessage("Enter a valid date and payment amount above zero.", true);
      return;
    }
    if (amount > balance) {
      showMessage(`Payment cannot be more than the remaining balance of ${money(balance)}.`, true);
      return;
    }
    data.payments.push({ id: makeId(), customerId, date, amount });
    if (saveAndRender("Payment recorded.")) closeDialog("payment-dialog");
  });

  document.querySelector("#customer-list").addEventListener("click", event => {
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
        data.customers = data.customers.filter(row => row.id !== customer.id);
        data.transactions = data.transactions.filter(row => row.customerId !== customer.id);
        data.payments = data.payments.filter(row => row.customerId !== customer.id);
        saveAndRender("Customer and history deleted.");
        break;
      }
    }
  });

  document.querySelector("#history-content").addEventListener("click", event => {
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
      data.transactions = data.transactions.filter(row => row.id !== transaction.id);
      if (saveAndRender("Utang transaction deleted.")) renderHistory(activeHistoryCustomerId);
    } else if (button.dataset.action === "delete-payment" && payment) {
      if (!window.confirm(`Delete this ${money(payment.amount)} payment record? The customer's balance will increase. This cannot be undone.`)) return;
      data.payments = data.payments.filter(row => row.id !== payment.id);
      if (saveAndRender("Payment record deleted.")) renderHistory(activeHistoryCustomerId);
    }
    
  });

  document.querySelector("#history-add-utang").addEventListener("click", () => {
    const customerId = activeHistoryCustomerId;
    closeDialog("history-dialog");
    openUtangForm(customerId);
  });

  document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => closeDialog(button.dataset.closeDialog)));
  document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));

  document.querySelector("#backup-button").addEventListener("click", () => {
    const backup = { app: "Utang List", version: 1, sitios: SITIOS, exportedAt: new Date().toISOString(), ...data };
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
      if (!window.confirm("Restore this backup? It will replace all data currently stored on this device.")) return;
      data = { customers: restored.customers, transactions: restored.transactions, payments: restored.payments };
      saveAndRender("Backup restored.");
    } catch (error) {
      showMessage(error instanceof SyntaxError ? "The selected file is not valid JSON." : error.message, true);
    } finally {
      event.target.value = "";
    }
  });

  render();
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("service-worker.js").catch(error => console.error("Service worker registration failed.", error));
  }
})();