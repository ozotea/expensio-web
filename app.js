/* ============================================================
   EXPENSIO web app — Google sign-in, Drive sync, dashboard
   ------------------------------------------------------------
   Reads the SAME JSON backup the Android app writes:
     Drive folder "Expensio" → expensio-<timestamp>.json
   Backups are AES-256-GCM envelopes written by the apps; this file
   decrypts them with the same key (see decryptBackup below).
   Aggregation mirrors HomeViewModel.kt so numbers match the app.
   ============================================================ */
(function () {
  "use strict";

  /* ──────────────────────────────────────────────────────────
     1. CONFIG  — paste your two credentials here.

     a) OAuth Web Client ID
        console.cloud.google.com → APIs & Services → Credentials
        → Create credentials → OAuth client ID → Web application.
        Authorized JavaScript origins:
          http://localhost:8765
          https://<your-production-domain>

     b) API key (for the Google Picker)
        Same Credentials page → Create credentials → API key.
        (Optionally restrict it to the Google Picker API + Drive API.)

     Enable BOTH the "Google Drive API" and "Google Picker API"
     for the project. The drive.file scope below needs NO Google
     verification — the user grants access by picking their file.
     ────────────────────────────────────────────────────────── */
  const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
  const GOOGLE_API_KEY = "YOUR_GOOGLE_API_KEY";

  const SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" ");
  const FILE_ID_KEY = "expensio_file_id";

  /* ──────────────────────────────────────────────────────────
     2. DOM helpers
     ────────────────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const inr = (n) =>
    "₹" + Math.round(Math.abs(n)).toLocaleString("en-IN");
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );

  let accessToken = null;
  let tokenClient = null;

  /* ──────────────────────────────────────────────────────────
     3. Google Identity Services — token flow
     ────────────────────────────────────────────────────────── */
  function isConfigured() {
    return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("YOUR_");
  }

  function initGis() {
    if (!isConfigured()) {
      $("loginNote").textContent =
        "Google sign-in isn't configured yet — GOOGLE_CLIENT_ID is still a placeholder in app.js. " +
        "Use \u201cContinue as Guest\u201d to explore the dashboard with sample data.";
      $("loginNote").classList.add("err");
      $("googleSignIn").disabled = true;
      $("googleSignIn").title = "Add a Google OAuth Client ID in app.js to enable this";
      return;
    }
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      // GIS script not ready yet — retry shortly.
      return setTimeout(initGis, 200);
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: onToken,
      error_callback: (err) => {
        loginErr("Sign-in was cancelled or failed. " + (err && err.type ? "(" + err.type + ")" : ""));
      },
    });
  }

  function loginErr(msg) {
    const n = $("loginNote");
    n.textContent = msg;
    n.classList.add("err");
  }

  async function onToken(resp) {
    if (resp.error || !resp.access_token) {
      return loginErr("Could not get Drive access. Please try again.");
    }
    accessToken = resp.access_token;
    // remember a lightweight session flag so a refresh keeps you on the app view
    sessionStorage.setItem("expensio_signed_in", "1");
    await enterApp();
  }

  /* ──────────────────────────────────────────────────────────
     4. Drive REST calls
     ────────────────────────────────────────────────────────── */
  async function driveGet(url) {
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (r.status === 401) throw new Error("AUTH");
    if (!r.ok) throw new Error("Drive request failed (" + r.status + ")");
    return r;
  }

  async function fetchUserProfile() {
    try {
      const r = await driveGet("https://www.googleapis.com/oauth2/v3/userinfo");
      return await r.json();
    } catch {
      return null;
    }
  }

  /* ── Backup decryption ───────────────────────────────────────
     Drive backups are AES-256-GCM envelopes written by the apps
     (Android BackupCrypto.kt, iOS BackupCrypto.swift). Same secret,
     same envelope, so this dashboard keeps reading them. Backups
     written before encryption shipped carry no marker and pass
     through untouched.

     The key ships in this file exactly as it ships inside the apps:
     it stops casual editing of the Drive file and makes tampering
     detectable — it is not, and cannot be, a secret from the user. ── */
  const BACKUP_SECRET =
    "expensio.backup.v1" + "|" + "8f2a5c91d4e7b063" + "|" + "5a3e0c7b19d64f82";

  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function backupKey() {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(BACKUP_SECRET)
    );
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  }

  // Returns the backup object itself, decrypting first when it's an envelope.
  async function decryptBackup(parsed) {
    if (!parsed || parsed.expensioEncrypted !== true) return parsed;
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64ToBytes(parsed.iv), tagLength: 128 },
        await backupKey(),
        b64ToBytes(parsed.data)
      );
    } catch {
      // GCM authenticates the payload, so this means the file was edited or corrupted.
      throw new Error(
        "That backup couldn't be opened — the file looks edited or damaged."
      );
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // Download a Drive file by id (granted via the Picker) and parse it.
  async function fetchBackupById(fileId) {
    const fileApi = "https://www.googleapis.com/drive/v3/files";
    const meta = await (
      await driveGet(`${fileApi}/${fileId}?fields=id,name,modifiedTime`)
    ).json();
    const content = await (
      await driveGet(`${fileApi}/${fileId}?alt=media`)
    ).text();
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error("That file isn't valid JSON — pick an expensio-*.json backup.");
    }
    return { data: await decryptBackup(data), file: meta };
  }

  /* ── Google Picker — lets the user grant access to their backup
     file under the drive.file scope (no Google verification needed). ── */
  function loadPicker() {
    return new Promise((resolve, reject) => {
      if (window.google && google.picker) return resolve();
      if (!window.gapi) return reject(new Error("Picker library not loaded yet — try again in a moment."));
      gapi.load("picker", { callback: resolve, onerror: reject });
    });
  }

  function pickBackupFile() {
    return new Promise(async (resolve, reject) => {
      if (!GOOGLE_API_KEY || GOOGLE_API_KEY.startsWith("YOUR_")) {
        return reject(new Error("Add your Google API key in app.js to use the file picker."));
      }
      try {
        await loadPicker();
      } catch (e) {
        return reject(e);
      }
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes("application/json")
        .setQuery("expensio")
        .setMode(google.picker.DocsViewMode.LIST);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE_API_KEY)
        .setTitle("Select your Expensio backup (expensio-*.json)")
        .addView(view)
        .setCallback((d) => {
          if (d.action === google.picker.Action.PICKED) resolve(d.docs[0]);
          else if (d.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build();
      picker.setVisible(true);
    });
  }

  /* ──────────────────────────────────────────────────────────
     5. Model  — parse backup into a rich, reusable shape.
        All money math mirrors the Android view-models.
     ────────────────────────────────────────────────────────── */
  let RAW = null;     // parsed backup JSON
  let MODEL = null;   // computed model
  let CURRENT_TAB = "dashboard";

  function buildModel(b) {
    const prefs = b.preferences || {};
    const accountsAll = b.bankAccounts || [];
    const accounts = accountsAll.filter((a) => !a.isArchived);
    const archived = accountsAll.filter((a) => a.isArchived);
    const cards = b.creditCards || [];
    const budgets = b.budgets || [];
    const categories = b.categories || [];
    const accountById = Object.fromEntries(accountsAll.map((a) => [a.id, a]));
    const cardById = Object.fromEntries(cards.map((c) => [c.id, c]));

    // Enrich + sort transactions (newest first).
    const txns = (b.transactions || [])
      .slice()
      .sort((a, b) => b.date - a.date || b.createdAt - a.createdAt)
      .map((t) => {
        const isCard = t.paymentMethod === "CREDIT_CARD";
        const acct = accountById[t.accountId];
        const card = cardById[t.creditCardId];
        return Object.assign({}, t, {
          isCard,
          sourceName: isCard
            ? card ? card.cardName : "Credit Card"
            : acct ? acct.name : (t.paymentMethod || "—").replace(/_/g, " "),
          sourceLast4: isCard ? card && card.lastFourDigits : acct && acct.accountNumberLast4,
        });
      });

    // Per-account balance = openingBalance + Σincome − Σexpense (non-card).
    const activeIds = new Set(accounts.map((a) => a.id));
    const acctNet = {};
    for (const t of txns) {
      if (t.isCard || !activeIds.has(t.accountId)) continue;
      acctNet[t.accountId] = (acctNet[t.accountId] || 0) + (t.type === "INCOME" ? t.amount : t.type === "EXPENSE" ? -t.amount : 0);
    }
    const balances = {};
    let assets = 0;
    for (const a of accounts) {
      const bal = (a.openingBalance || 0) + (acctNet[a.id] || 0);
      balances[a.id] = bal;
      assets += bal;
    }
    const liabilities = cards.reduce((s, c) => s + (c.currentUsage || 0), 0);

    // Credit card usage (use stored currentUsage; derive available + %).
    const cardModel = cards.map((c) => {
      const used = c.currentUsage || 0;
      return Object.assign({}, c, {
        used,
        available: Math.max(0, (c.cardLimit || 0) - used),
        pct: c.cardLimit ? Math.min(100, (used / c.cardLimit) * 100) : 0,
      });
    });

    // EMI plan progress (paid installments from settled EMI transactions).
    const emiPlans = (b.emiPlans || []).map((p) => {
      const paid = Math.min(txns.filter((t) => t.emiPlanId === p.id && t.emiInstallmentPaid).length, p.tenureMonths);
      return Object.assign({}, p, {
        paidInstallments: paid,
        remainingInstallments: p.tenureMonths - paid,
        remainingAmount: p.totalAmount - paid * p.monthlyAmount,
        progress: p.tenureMonths ? paid / p.tenureMonths : 0,
        cardName: (cardById[p.creditCardId] || {}).cardName || "Card",
      });
    });

    // Distinct months present (newest first), default selection = latest.
    const monthMap = new Map();
    for (const t of txns) {
      const d = new Date(t.date);
      const k = d.getFullYear() * 12 + d.getMonth();
      if (!monthMap.has(k)) monthMap.set(k, { y: d.getFullYear(), m: d.getMonth(), k });
    }
    const months = [...monthMap.values()].sort((a, b) => b.k - a.k);
    const selected = months[0] || (function () { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth(), k: n.getFullYear() * 12 + n.getMonth() }; })();

    return {
      prefs, currency: prefs.primaryCurrency || "INR", userName: prefs.userName || "",
      accounts, archived, accountsAll, accountById, cardById,
      cards: cardModel, emiPlans, budgets, categories, txns,
      balances, assets, liabilities, netWorth: assets - liabilities,
      months, selected,
    };
  }

  function setData(b) { RAW = b; MODEL = buildModel(b); }

  /* ── month-scoped helpers ── */
  const inMonthOf = (t, sel) => { const d = new Date(t.date); return d.getFullYear() === sel.y && d.getMonth() === sel.m; };
  const monthTxns = (M, sel) => M.txns.filter((t) => inMonthOf(t, sel || M.selected));
  const sumType = (list, type, exclCard) => list.filter((t) => t.type === type && (!exclCard || !t.isCard)).reduce((s, t) => s + t.amount, 0);
  function categoryTotals(list) {
    const m = {};
    for (const t of list) { if (t.type !== "EXPENSE") continue; m[t.category] = (m[t.category] || 0) + t.amount; }
    return Object.entries(m).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
  }
  function topCats(list, n) {
    const cats = categoryTotals(list);
    if (cats.length <= n) return cats;
    const others = cats.slice(n - 1).reduce((s, c) => s + c.total, 0);
    return cats.slice(0, n - 1).concat([{ name: "Others", total: others }]);
  }
  const monthLabel = (sel) => new Date(sel.y, sel.m, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const prevMonth = (sel) => { const k = sel.k - 1; return { y: Math.floor(k / 12), m: ((k % 12) + 12) % 12, k }; };
  const pctChange = (cur, prev) => (!prev ? (cur ? 100 : 0) : ((cur - prev) / prev) * 100);

  /* ──────────────────────────────────────────────────────────
     6. Presentation helpers (formatters, colors, chart builders)
     ────────────────────────────────────────────────────────── */
  const PALETTE = ["#2563EB", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#0ea5e9", "#ec4899", "#94a3b8"];
  const CAT_EMOJI = {
    "Food & Dining": "🍔", Food: "🍔", Shopping: "🛍️", Travel: "✈️",
    "Bills & Utilities": "💡", Bills: "💡", EMI: "🏦", Fuel: "⛽",
    Income: "💰", Salary: "💵", Entertainment: "🎬", Health: "🏥",
    Groceries: "🛒", Transport: "🚌", Rent: "🏠", Insurance: "🛡️",
    Education: "🎓", Subscriptions: "🔁", Others: "•",
  };
  const emojiFor = (c) => CAT_EMOJI[c] || "•";
  const pmLabel = (t) => (t.isCard ? "Credit Card" : (t.paymentMethod || "—").replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()));
  const dateShort = (ms) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const dateTime = (ms) => new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const typeBadge = (t) => `<span class="tbadge ${t.type === "INCOME" ? "in" : t.type === "REFUND_CASHBACK" ? "ref" : "ex"}">${t.type === "REFUND_CASHBACK" ? "Refund" : t.type === "INCOME" ? "Income" : "Expense"}</span>`;
  const amtCell = (t) => `<span class="${t.type === "EXPENSE" ? "neg" : "pos"}">${t.type === "EXPENSE" ? "−" : "+"}${inr(t.amount)}</span>`;
  const trend = (p) => { const r = Math.round(p); return r > 0 ? `<span class="up">↑ ${r}%</span>` : r < 0 ? `<span class="down">↓ ${Math.abs(r)}%</span>` : `<span class="flat">→ 0%</span>`; };

  // Donut chart → SVG string. cats:[{name,total}], total number.
  function donutSVG(cats, total, id) {
    if (!total) return `<svg viewBox="0 0 120 120" class="donut"><circle cx="60" cy="60" r="46" fill="none" stroke="#eef2f9" stroke-width="16"/></svg>`;
    const R = 46, C = 2 * Math.PI * R;
    let off = 0;
    const arcs = cats.map((c, i) => {
      const len = (c.total / total) * C;
      const a = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="16"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
      off += len;
      return a;
    }).join("");
    return `<svg viewBox="0 0 120 120" class="donut">${arcs}
      <text x="60" y="55" text-anchor="middle" font-size="8.5" fill="#64748B" font-family="Inter">Total</text>
      <text x="60" y="69" text-anchor="middle" font-size="12" font-weight="700" fill="#0F172A" font-family="Outfit">${inr(total)}</text></svg>`;
  }
  function legendHTML(cats, total) {
    if (!total) return `<li style="color:var(--muted)">No expenses this period.</li>`;
    return cats.map((c, i) => `<li><span class="sw" style="background:${PALETTE[i % PALETTE.length]}"></span>
      <span class="nm">${esc(c.name)}</span><span class="amt">${inr(c.total)}</span>
      <span class="pct">${Math.round((c.total / total) * 100)}%</span></li>`).join("");
  }
  // Vertical bar chart → SVG. bars:[{label,value}].
  function barChartSVG(bars) {
    const W = 520, H = 180, pad = 26, max = Math.max(1, ...bars.map((b) => b.value));
    const bw = (W - pad * 2) / bars.length;
    const body = bars.map((b, i) => {
      const h = (b.value / max) * (H - pad - 20);
      const x = pad + i * bw + bw * 0.18, y = H - pad - h, w = bw * 0.64;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="4" fill="url(#bg)"/>
        <text x="${(x + w / 2).toFixed(1)}" y="${H - pad + 13}" text-anchor="middle" font-size="9.5" fill="#94a3b8" font-family="Inter">${esc(b.label)}</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="barchart" preserveAspectRatio="xMidYMid meet">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#93c5fd"/></linearGradient></defs>
      ${body}</svg>`;
  }
  const acctChip = (a) => `<div class="acct__chip" style="background:${esc(a.color || "#0F172A")}">${esc((a.name || "?").trim().charAt(0).toUpperCase())}</div>`;

  /* ──────────────────────────────────────────────────────────
     6b. Tab router
     ────────────────────────────────────────────────────────── */
  function greetTitle(M) {
    const hr = new Date().getHours();
    const part = hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening";
    const first = displayName(M).split(" ")[0];
    return `Good ${part}, ${esc(first)} 👋`;
  }
  const TABS = {
    dashboard:    { title: greetTitle,                 sub: (M) => `Here's your money summary for ${monthLabel(M.selected)}`, render: viewDashboard },
    transactions: { title: () => "Transactions",       sub: () => "All your income and expenses in one place",               render: viewTransactions, after: afterTransactions },
    accounts:     { title: () => "Accounts",           sub: () => "All your balances in one place",                          render: viewAccounts,    after: afterAccounts },
    cards:        { title: () => "Cards &amp; EMI",     sub: () => "Credit cards and installment plans",                      render: viewCards },
    analytics:    { title: () => "Analytics",           sub: () => "Understand where your money goes",                        render: viewAnalytics,   after: afterAnalytics },
    budgets:      { title: () => "Budgets",             sub: () => "Track spending against your limits",                      render: viewBudgets },
    profile:      { title: () => "Profile &amp; Settings", sub: () => "Manage your account, data and preferences",              render: viewProfile,     after: afterProfile },
  };

  function renderTab(id) {
    if (!MODEL) return;
    if (!TABS[id]) id = "dashboard";
    CURRENT_TAB = id;
    const tab = TABS[id];
    $("pageTitle").innerHTML = tab.title(MODEL);
    $("pageSub").textContent = tab.sub(MODEL);
    $("view").innerHTML = tab.render(MODEL);
    if (tab.after) tab.after(MODEL);
    document.querySelectorAll(".side__link").forEach((x) => x.classList.toggle("is-active", x.dataset.tab === id));
    $("view").scrollTo ? window.scrollTo(0, 0) : null;
  }

  /* ── Dashboard ── */
  function viewDashboard(M) {
    const sel = M.selected;
    const mt = monthTxns(M, sel);
    const nonCard = mt.filter((t) => !t.isCard);
    const income = sumType(nonCard, "INCOME"), expense = sumType(nonCard, "EXPENSE");
    const cats = topCats(mt, 6), catTotal = cats.reduce((s, c) => s + c.total, 0);
    const usage = M.cards.reduce((s, c) => s + c.used, 0), limit = M.cards.reduce((s, c) => s + (c.cardLimit || 0), 0);
    const emi = M.emiPlans.filter((p) => p.isActive).sort((a, b) => a.endDate - b.endDate)[0];
    const recent = M.txns.slice(0, 6);

    return `<div class="grid">
      <section class="hero card">
        <div class="hero__nw">
          <div class="hero__label">Net Worth</div>
          <div class="hero__val">${inr(M.netWorth)}</div>
          <div class="hero__sub">Assets ${inr(M.assets)} &nbsp;–&nbsp; Liabilities ${inr(M.liabilities)}</div>
        </div>
        <div class="hero__stats">
          <div class="hero__stat"><div class="hero__ico inc">↗</div><div><small>Income</small><b>${inr(income)}</b></div></div>
          <div class="hero__stat"><div class="hero__ico exp">↘</div><div><small>Expense</small><b>${inr(expense)}</b></div></div>
          <div class="hero__stat"><div class="hero__ico sav">▣</div><div><small>Savings</small><b>${inr(income - expense)}</b></div></div>
        </div>
      </section>

      <section class="kpis">
        <div class="kpi card"><div class="kpi__ico p">↗</div><div><small>Monthly Spend</small><b>${inr(expense)}</b></div></div>
        <div class="kpi card"><div class="kpi__ico o">▤</div><div><small>Transactions</small><b>${mt.length} this month</b></div></div>
        <div class="kpi card"><div class="kpi__ico g">▭</div><div><small>Credit Usage</small><b>${limit ? Math.round((usage / limit) * 100) + "% used" : "—"}</b></div></div>
        <div class="kpi card"><div class="kpi__ico b">▦</div><div><small>Upcoming EMI</small><b>${emi ? inr(emi.monthlyAmount) : "None"}</b></div></div>
      </section>

      <section class="card panel accounts">
        <div class="panel__head"><h2>Your Accounts</h2><a class="link" data-go="accounts">Manage →</a></div>
        <div class="acct-list">${M.accounts.length ? M.accounts.map((a) => `
          <div class="acct">
            <div class="acct__top">${acctChip(a)}
              <div><div class="acct__name">${esc(a.name)}</div>
                <div class="acct__type">${esc((a.type || "").replace(/_/g, " "))}${a.accountNumberLast4 ? " •••• " + esc(a.accountNumberLast4) : ""}</div></div>
            </div>
            <div class="acct__bal">${inr(M.balances[a.id] || 0)}</div>
          </div>`).join("") : `<p class="muted">No accounts in this backup.</p>`}</div>
      </section>

      <section class="card panel split">
        <div class="panel__head"><h2>Category Split</h2><a class="link" data-go="analytics">View Analytics →</a></div>
        <div class="split__wrap">${donutSVG(cats, catTotal)}<ul class="split__legend">${legendHTML(cats, catTotal)}</ul></div>
      </section>

      <section class="card panel recent">
        <div class="panel__head"><h2>Recent Transactions</h2><a class="link" data-go="transactions">View all →</a></div>
        <table class="txn"><thead><tr><th>Merchant</th><th>Category</th><th>Account</th><th>Date</th><th class="r">Amount</th></tr></thead>
          <tbody>${recent.length ? recent.map((t) => `<tr>
            <td><div class="merch"><span class="em">${emojiFor(t.category)}</span>${esc(t.title || t.brand || t.category)}</div></td>
            <td><span class="cat-tag">${esc(t.category)}</span></td>
            <td>${esc(t.sourceName)}</td><td>${dateShort(t.date)}</td>
            <td class="r">${amtCell(t)}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No transactions yet.</td></tr>`}</tbody>
        </table>
      </section>
    </div>`;
  }

  /* ── Transactions ── */
  const txState = { type: "ALL", q: "", account: "", category: "", tab: "all", monthKey: "latest", page: 1, perPage: 10 };

  function viewTransactions(M) {
    txState.page = 1;
    // resolve the "latest" sentinel to the newest month so the dropdown shows it
    if (txState.monthKey === "latest") txState.monthKey = String(M.selected.k);
    const monthOpts = [`<option value="all">All time</option>`]
      .concat(M.months.map((mo) => `<option value="${mo.k}">${monthLabel(mo)}</option>`)).join("");
    const acctOpts = [`<option value="">All Accounts</option>`]
      .concat(M.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`))
      .concat(M.cards.length ? [`<option value="card">Credit Cards</option>`] : []).join("");
    const catOpts = [`<option value="">All Categories</option>`]
      .concat([...new Set(M.txns.map((t) => t.category))].sort().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)).join("");

    return `<div class="tx">
      <div class="tx__toolbar card">
        <div class="fld"><label>Date Range</label><select id="txMonth">${monthOpts}</select></div>
        <div class="fld"><label>Type</label>
          <div class="seg" id="txType">
            <button data-v="ALL" class="on">All</button><button data-v="INCOME">Income</button><button data-v="EXPENSE">Expense</button>
          </div></div>
        <div class="fld"><label>Account</label><select id="txAccount">${acctOpts}</select></div>
        <div class="fld"><label>Category</label><select id="txCategory">${catOpts}</select></div>
        <div class="fld grow"><label>Search</label><input id="txSearch" type="search" placeholder="Search transactions…" /></div>
      </div>

      <div class="statrow" id="txStats"></div>

      <div class="card tx__list">
        <div class="tx__tabs">
          <div class="tabs" id="txTabs">
            <button data-v="all" class="on">All Transactions</button>
            <button data-v="recurring">Recurring</button>
            <button data-v="thismonth">This Month</button>
          </div>
          <div class="tx__count" id="txCount"></div>
        </div>
        <div class="tablewrap">
          <table class="txn txn--full">
            <thead><tr>
              <th>Date</th><th>Merchant / Description</th><th>Category</th><th>Account / Card</th>
              <th>Type</th><th class="r">Amount</th><th>Payment</th>
            </tr></thead>
            <tbody id="txRows"></tbody>
          </table>
        </div>
        <div class="tx__foot">
          <div class="perpage">Show
            <select id="txPer"><option>10</option><option>25</option><option>50</option></select> per page</div>
          <div class="pager" id="txPager"></div>
        </div>
      </div>
    </div>`;
  }

  function txScoped(M) {
    let list = M.txns;
    if (txState.tab === "thismonth") list = list.filter((t) => inMonthOf(t, M.selected));
    else if (txState.monthKey !== "all") {
      const sel = txState.monthKey === "latest" ? M.selected : (M.months.find((x) => String(x.k) === txState.monthKey) || M.selected);
      list = list.filter((t) => inMonthOf(t, sel));
    }
    if (txState.tab === "recurring") list = list.filter((t) => t.isRecurring);
    if (txState.type === "INCOME") list = list.filter((t) => t.type === "INCOME" || t.type === "REFUND_CASHBACK");
    else if (txState.type === "EXPENSE") list = list.filter((t) => t.type === "EXPENSE");
    if (txState.account === "card") list = list.filter((t) => t.isCard);
    else if (txState.account) list = list.filter((t) => String(t.accountId) === txState.account);
    if (txState.category) list = list.filter((t) => t.category === txState.category);
    if (txState.q) {
      const q = txState.q.toLowerCase();
      list = list.filter((t) => [t.title, t.brand, t.category, t.note].some((s) => (s || "").toLowerCase().includes(q)));
    }
    return list;
  }

  function applyTx(M) {
    const list = txScoped(M);
    const income = list.filter((t) => t.type === "INCOME" || t.type === "REFUND_CASHBACK").reduce((s, t) => s + t.amount, 0);
    const expense = sumType(list, "EXPENSE");
    // avg daily: over distinct active days in the scoped set
    const days = new Set(list.map((t) => new Date(t.date).toDateString())).size || 1;
    const stats = [
      { ic: "↓", cls: "g", label: "Total Income", val: inr(income) },
      { ic: "↗", cls: "r", label: "Total Expenses", val: inr(expense) },
      { ic: "≈", cls: "b", label: "Net Cash Flow", val: (income - expense < 0 ? "−" : "") + inr(income - expense) },
      { ic: "▦", cls: "o", label: "Transactions", val: String(list.length) },
      { ic: "◷", cls: "p", label: "Avg Daily Spend", val: inr(expense / days) },
    ];
    $("txStats").innerHTML = stats.map((s) => `<div class="stat card"><div class="stat__ic ${s.cls}">${s.ic}</div>
      <div><small>${s.label}</small><b>${s.val}</b></div></div>`).join("");

    $("txCount").textContent = `${list.length} transaction${list.length === 1 ? "" : "s"}`;

    const per = txState.perPage, pages = Math.max(1, Math.ceil(list.length / per));
    if (txState.page > pages) txState.page = pages;
    const start = (txState.page - 1) * per;
    const slice = list.slice(start, start + per);

    $("txRows").innerHTML = slice.length ? slice.map((t) => `<tr>
      <td class="nowrap">${dateTime(t.date)}</td>
      <td><div class="merch"><span class="em">${emojiFor(t.category)}</span><span>${esc(t.title || t.brand || t.category)}</span></div></td>
      <td><span class="cat-tag">${esc(t.category)}</span></td>
      <td><span class="src">${esc(t.sourceName)}${t.sourceLast4 ? ` <i>•••• ${esc(t.sourceLast4)}</i>` : ""}</span></td>
      <td>${typeBadge(t)}</td>
      <td class="r">${amtCell(t)}</td>
      <td class="nowrap">${esc(pmLabel(t))}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="muted" style="padding:30px;text-align:center">No transactions match these filters.</td></tr>`;

    // pager
    const btn = (p, label, dis, on) => `<button class="pg${on ? " on" : ""}" ${dis ? "disabled" : ""} data-p="${p}">${label}</button>`;
    let pg = btn(txState.page - 1, "← Prev", txState.page <= 1);
    const win = [];
    for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - txState.page) <= 1) win.push(i);
    let last = 0;
    for (const i of win) { if (i - last > 1) pg += `<span class="pg-dots">…</span>`; pg += btn(i, String(i), false, i === txState.page); last = i; }
    pg += btn(txState.page + 1, "Next →", txState.page >= pages);
    $("txPager").innerHTML = pg;
    $("txPager").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { txState.page = +b.dataset.p; applyTx(M); }));
  }

  function afterTransactions(M) {
    $("txMonth").value = txState.monthKey;
    $("txAccount").value = txState.account;
    $("txCategory").value = txState.category;
    $("txSearch").value = txState.q;
    $("txPer").value = String(txState.perPage);
    const reset = () => { txState.page = 1; applyTx(M); };
    $("txMonth").addEventListener("change", (e) => { txState.monthKey = e.target.value; reset(); });
    $("txAccount").addEventListener("change", (e) => { txState.account = e.target.value; reset(); });
    $("txCategory").addEventListener("change", (e) => { txState.category = e.target.value; reset(); });
    $("txSearch").addEventListener("input", (e) => { txState.q = e.target.value; reset(); });
    $("txPer").addEventListener("change", (e) => { txState.perPage = +e.target.value; reset(); });
    $("txType").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      txState.type = b.dataset.v;
      $("txType").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      reset();
    }));
    $("txTabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      txState.tab = b.dataset.v;
      $("txTabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      reset();
    }));
    applyTx(M);
  }

  /* ── Accounts ── */
  function viewAccounts(M) {
    if (!M.accountsAll.length) return `<div class="card empty">No accounts found in this backup.</div>`;
    const totalBal = M.assets;
    const head = `<div class="statrow">
      <div class="stat card"><div class="stat__ic b">∑</div><div><small>Total Balance</small><b>${inr(totalBal)}</b></div></div>
      <div class="stat card"><div class="stat__ic g">🏦</div><div><small>Active Accounts</small><b>${M.accounts.length}</b></div></div>
      <div class="stat card"><div class="stat__ic r">💳</div><div><small>Card Liabilities</small><b>${inr(M.liabilities)}</b></div></div>
      <div class="stat card"><div class="stat__ic p">≈</div><div><small>Net Worth</small><b>${inr(M.netWorth)}</b></div></div>
    </div>`;

    const cards = M.accounts.map((a) => {
      const c = a.color || "#0F172A";
      return `<button class="acctcard" data-id="${a.id}" style="--c:${esc(c)}">
        <div class="acctcard__top"><span class="acctcard__type">${esc((a.type || "").replace(/_/g, " "))}</span>${a.validThru ? `<span class="acctcard__vt">${esc(a.validThru)}</span>` : ""}</div>
        <div class="acctcard__name">${esc(a.name)}</div>
        <div class="acctcard__num">•••• •••• •••• ${esc(a.accountNumberLast4 || "••••")}</div>
        <div class="acctcard__bal"><small>Balance</small>${inr(M.balances[a.id] || 0)}</div>
        ${a.cardholderName ? `<div class="acctcard__holder">${esc(a.cardholderName.toUpperCase())}</div>` : ""}
      </button>`;
    }).join("");

    const archived = M.archived.length ? `<div class="panel__head" style="margin-top:18px"><h2>Archived</h2></div>
      <div class="acct-list">${M.archived.map((a) => `<div class="acct dim"><div class="acct__top">${acctChip(a)}
        <div><div class="acct__name">${esc(a.name)}</div><div class="acct__type">Archived${a.accountNumberLast4 ? " • •••• " + esc(a.accountNumberLast4) : ""}</div></div></div></div>`).join("")}</div>` : "";

    return `${head}
      <div class="acctgrid">${cards}</div>
      <div id="acctDetail"></div>
      ${archived}`;
  }

  function afterAccounts(M) {
    const sel = (id) => {
      const a = M.accountById[id];
      if (!a) return;
      document.querySelectorAll(".acctcard").forEach((c) => c.classList.toggle("sel", c.dataset.id === String(id)));
      const txns = M.txns.filter((t) => t.accountId === id && !t.isCard);
      const mt = txns.filter((t) => inMonthOf(t, M.selected));
      const income = sumType(mt, "INCOME"), expense = sumType(mt, "EXPENSE");
      $("acctDetail").innerHTML = `<div class="card panel">
        <div class="panel__head"><h2>${esc(a.name)} · activity</h2>
          <div class="acctdetail__pills"><span class="pill in">In ${inr(income)}</span><span class="pill ex">Out ${inr(expense)}</span></div></div>
        <table class="txn"><thead><tr><th>Merchant</th><th>Category</th><th>Date</th><th class="r">Amount</th></tr></thead>
          <tbody>${txns.slice(0, 10).map((t) => `<tr>
            <td><div class="merch"><span class="em">${emojiFor(t.category)}</span>${esc(t.title || t.category)}</div></td>
            <td><span class="cat-tag">${esc(t.category)}</span></td><td>${dateShort(t.date)}</td>
            <td class="r">${amtCell(t)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No transactions.</td></tr>`}</tbody>
        </table></div>`;
    };
    document.querySelectorAll(".acctcard").forEach((c) => c.addEventListener("click", () => sel(+c.dataset.id)));
    if (M.accounts[0]) sel(M.accounts[0].id);
  }

  /* ── Cards & EMI ── */
  function viewCards(M) {
    const totLimit = M.cards.reduce((s, c) => s + (c.cardLimit || 0), 0);
    const totUsed = M.cards.reduce((s, c) => s + c.used, 0);
    const totAvail = Math.max(0, totLimit - totUsed);
    const activeEmis = M.emiPlans.filter((p) => p.isActive);
    const emiMonthly = activeEmis.reduce((s, p) => s + p.monthlyAmount, 0);

    const summary = `<div class="statrow">
      <div class="stat card"><div class="stat__ic b">▭</div><div><small>Total Limit</small><b>${inr(totLimit)}</b></div></div>
      <div class="stat card"><div class="stat__ic r">↗</div><div><small>Total Used</small><b>${inr(totUsed)}</b></div></div>
      <div class="stat card"><div class="stat__ic g">✓</div><div><small>Available</small><b>${inr(totAvail)}</b></div></div>
      <div class="stat card"><div class="stat__ic p">▦</div><div><small>EMI / month</small><b>${inr(emiMonthly)}</b></div></div>
    </div>`;

    const cardCards = M.cards.length ? M.cards.map((c) => `<div class="cc">
        <div class="cc__visual" style="--c:${esc(c.cardColor || "#0F172A")}">
          <div class="cc__row"><span class="cc__brand">${esc(c.cardName)}</span><span class="cc__chip"></span></div>
          <div class="cc__num">•••• •••• •••• ${esc(c.lastFourDigits || "••••")}</div>
          <div class="cc__row cc__foot"><span>${esc((c.cardholderName || "").toUpperCase())}</span><span>${c.validThru ? "VALID " + esc(c.validThru) : ""}</span></div>
        </div>
        <div class="cc__usage">
          <div class="cc__bar"><span style="width:${c.pct.toFixed(0)}%;background:${c.pct >= 80 ? "var(--red)" : c.pct >= 50 ? "#f59e0b" : "var(--green)"}"></span></div>
          <div class="cc__meta"><span><b>${inr(c.used)}</b> used</span><span>${Math.round(c.pct)}%</span><span>${inr(c.available)} left</span></div>
          <div class="cc__sub">Limit ${inr(c.cardLimit || 0)} · Bill on day ${c.billGenerationDate || 1}${c.isFrozen ? " · ❄ Frozen" : ""}</div>
        </div>
      </div>`).join("") : `<div class="card empty">No credit cards in this backup.</div>`;

    const emiList = M.emiPlans.length ? M.emiPlans.map((p) => `<div class="emi ${p.isActive ? "" : "dim"}">
        <div class="emi__top">
          <div class="emi__ic">▦</div>
          <div class="emi__info"><b>${esc(p.title)}</b><small>${esc(p.cardName)} · ${p.tenureMonths} mo${p.interestRatePercent ? " · " + p.interestRatePercent + "%" : ""}</small></div>
          <div class="emi__amt">${inr(p.monthlyAmount)}<small>/month</small></div>
        </div>
        <div class="emi__bar"><span style="width:${(p.progress * 100).toFixed(0)}%"></span></div>
        <div class="emi__meta"><span>${p.paidInstallments} of ${p.tenureMonths} paid</span><span><b>${inr(Math.max(0, p.remainingAmount))}</b> remaining</span>${p.isActive ? "" : `<span class="emi__done">Completed</span>`}</div>
      </div>`).join("") : `<p class="muted">No EMI plans.</p>`;

    return `${summary}
      <div class="ccgrid">${cardCards}</div>
      <div class="card panel" style="margin-top:18px">
        <div class="panel__head"><h2>EMI Plans</h2><span class="muted">${activeEmis.length} active</span></div>
        <div class="emilist">${emiList}</div>
      </div>`;
  }

  /* ── Analytics ── */
  function viewAnalytics(M) {
    const sel = M.selected, prev = prevMonth(sel);
    const mt = monthTxns(M, sel), pt = monthTxns(M, prev);
    const expense = sumType(mt, "EXPENSE"), pExpense = sumType(pt, "EXPENSE");
    const income = sumType(mt.filter((t) => !t.isCard), "INCOME");
    const cats = topCats(mt, 7), catTotal = cats.reduce((s, c) => s + c.total, 0);
    const allCats = categoryTotals(mt);

    // weekly buckets W1..W5
    const weeks = [0, 0, 0, 0, 0];
    for (const t of mt) if (t.type === "EXPENSE") { const d = new Date(t.date).getDate(); weeks[Math.min(4, Math.floor((d - 1) / 7))] += t.amount; }
    const bars = weeks.map((v, i) => ({ label: "W" + (i + 1), value: v })).filter((b, i) => i < 4 || b.value > 0);

    const days = new Set(mt.map((t) => new Date(t.date).toDateString())).size || 1;
    const FIXED = new Set(["Rent", "Utilities", "Insurance", "Housing", "Bills & Utilities"]);
    const fixed = mt.filter((t) => t.type === "EXPENSE" && FIXED.has(t.category)).reduce((s, t) => s + t.amount, 0);
    const variable = expense - fixed;

    // insight
    const change = pctChange(expense, pExpense);
    let insight;
    if (!expense) insight = "No expenses recorded this month.";
    else if (allCats[0] && allCats[0].total / expense > 0.4) insight = `Your top category is ${allCats[0].name}: ${Math.round(allCats[0].total / expense * 100)}% of spending.`;
    else if (change < -1) insight = `You spent ${Math.abs(Math.round(change))}% less than last month — nice.`;
    else if (change > 1) insight = `You spent ${Math.round(change)}% more than last month.`;
    else insight = "Your spending is steady month-over-month.";

    return `<div class="card panel" style="margin-bottom:18px;display:flex;align-items:center;justify-content:space-between">
        <div><b>Period</b> <span class="muted">— ${monthLabel(sel)}</span></div>
        <select id="anMonth">${M.months.map((mo) => `<option value="${mo.k}" ${mo.k === sel.k ? "selected" : ""}>${monthLabel(mo)}</option>`).join("")}</select>
      </div>

      <div class="statrow">
        <div class="stat card"><div class="stat__ic r">↗</div><div><small>Total Expenditure</small><b>${inr(expense)}</b><span class="delta">${trend(change)} vs last month</span></div></div>
        <div class="stat card"><div class="stat__ic g">↓</div><div><small>Total Income</small><b>${inr(income)}</b></div></div>
        <div class="stat card"><div class="stat__ic b">▣</div><div><small>Savings</small><b>${inr(income - expense)}</b></div></div>
        <div class="stat card"><div class="stat__ic p">◷</div><div><small>Avg / active day</small><b>${inr(expense / days)}</b></div></div>
      </div>

      <div class="grid2">
        <div class="card panel">
          <div class="panel__head"><h2>Spending Trend</h2><span class="muted">by week</span></div>
          ${bars.length ? barChartSVG(bars) : `<p class="muted">No expenses this month.</p>`}
          <div class="fixvar"><span><i class="dot" style="background:#2563EB"></i>Fixed ${inr(fixed)}</span><span><i class="dot" style="background:#93c5fd"></i>Variable ${inr(variable)}</span></div>
        </div>
        <div class="card panel">
          <div class="panel__head"><h2>Category Split</h2></div>
          <div class="split__wrap">${donutSVG(cats, catTotal)}<ul class="split__legend">${legendHTML(cats, catTotal)}</ul></div>
        </div>
      </div>

      <div class="card insight"><span class="insight__ic">💡</span> ${esc(insight)}</div>

      <div class="card panel">
        <div class="panel__head"><h2>Top Categories</h2></div>
        <div class="topcats">${allCats.slice(0, 6).map((c, i) => `<div class="topcat">
          <div class="topcat__l"><span class="em">${emojiFor(c.name)}</span>${esc(c.name)}</div>
          <div class="topcat__bar"><span style="width:${catTotal ? (c.total / allCats[0].total * 100).toFixed(0) : 0}%;background:${PALETTE[i % PALETTE.length]}"></span></div>
          <div class="topcat__v">${inr(c.total)}<small>${expense ? Math.round(c.total / expense * 100) : 0}%</small></div>
        </div>`).join("") || `<p class="muted">No expenses this month.</p>`}</div>
      </div>`;
  }

  function afterAnalytics(M) {
    const s = $("anMonth");
    if (s) s.addEventListener("change", (e) => {
      const k = +e.target.value;
      M.selected = M.months.find((x) => x.k === k) || M.selected;
      renderTab("analytics");
    });
  }

  /* ── Budgets ── */
  function viewBudgets(M) {
    const sel = M.selected;
    const mt = monthTxns(M, sel);
    const monthBudgets = M.budgets.filter((b) => b.month === sel.m + 1 && b.year === sel.y);
    const overall = monthBudgets.find((b) => b.category == null) || M.budgets.find((b) => b.category == null);
    const catBudgets = monthBudgets.filter((b) => b.category != null);
    const spentAll = sumType(mt, "EXPENSE");
    const catSpent = Object.fromEntries(categoryTotals(mt).map((c) => [c.name, c.total]));

    const status = (used) => used >= 1 ? { c: "ex", t: "EXCEEDED" } : used >= 0.8 ? { c: "wn", t: "WARNING" } : { c: "ok", t: "SAFE" };

    let overallCard = "";
    if (overall) {
      const used = overall.limitAmount ? spentAll / overall.limitAmount : 0;
      const st = status(used);
      overallCard = `<div class="card budgethero">
        <div class="budgethero__row"><div><small>Overall Budget · ${monthLabel(sel)}</small>
          <div class="budgethero__rem ${spentAll > overall.limitAmount ? "over" : ""}">${inr(overall.limitAmount - spentAll)}<span>${spentAll > overall.limitAmount ? "over budget" : "remaining"}</span></div></div>
          <span class="bstatus ${st.c}">${st.t} ${Math.round(used * 100)}%</span></div>
        <div class="bbar"><span style="width:${Math.min(100, used * 100).toFixed(0)}%" class="${st.c}"></span></div>
        <div class="budgethero__meta"><span>${inr(spentAll)} spent</span><span>of ${inr(overall.limitAmount)}</span></div>
      </div>`;
    } else {
      overallCard = `<div class="card budgethero"><div class="budgethero__row"><div><small>Spending · ${monthLabel(sel)}</small>
        <div class="budgethero__rem">${inr(spentAll)}<span>no overall budget set</span></div></div></div></div>`;
    }

    // exceeded alert
    const exceeded = catBudgets.filter((b) => (catSpent[b.category] || 0) > b.limitAmount);
    const alert = exceeded.length ? `<div class="card balert"><span>⚠️</span> <b>${inr((catSpent[exceeded[0].category] || 0) - exceeded[0].limitAmount)} over budget in ${esc(exceeded[0].category)}</b>${exceeded.length > 1 ? ` and ${exceeded.length - 1} more` : ""}.</div>` : "";

    // per-category budget cards, or fallback: spending-by-category
    let catSection;
    if (catBudgets.length) {
      catSection = catBudgets.map((b) => {
        const spent = catSpent[b.category] || 0, used = b.limitAmount ? spent / b.limitAmount : 0, st = status(used);
        return `<div class="bcard">
          <div class="bcard__top"><div class="bcard__name"><span class="em">${emojiFor(b.category)}</span>${esc(b.category)}</div>
            <span class="bstatus ${st.c}">${st.t} ${Math.round(used * 100)}%</span></div>
          <div class="bbar"><span style="width:${Math.min(100, used * 100).toFixed(0)}%" class="${st.c}"></span></div>
          <div class="bcard__meta"><span>${spent > b.limitAmount ? inr(spent - b.limitAmount) + " over" : inr(b.limitAmount - spent) + " left"}</span>
            <span>${inr(spent)} of ${inr(b.limitAmount)}</span></div>
        </div>`;
      }).join("");
    } else {
      const cats = categoryTotals(mt);
      catSection = cats.length ? cats.map((c, i) => `<div class="bcard">
        <div class="bcard__top"><div class="bcard__name"><span class="em">${emojiFor(c.name)}</span>${esc(c.name)}</div>
          <span class="muted">${spentAll ? Math.round(c.total / spentAll * 100) : 0}% of spend</span></div>
        <div class="bbar"><span style="width:${spentAll ? (c.total / cats[0].total * 100).toFixed(0) : 0}%;background:${PALETTE[i % PALETTE.length]}"></span></div>
        <div class="bcard__meta"><span>${inr(c.total)} spent</span></div></div>`).join("")
        : `<p class="muted">No spending this month.</p>`;
    }

    // insights: days left + projected
    const now = new Date();
    const isCurrent = now.getFullYear() === sel.y && now.getMonth() === sel.m;
    const daysInMonth = new Date(sel.y, sel.m + 1, 0).getDate();
    const dayOf = isCurrent ? now.getDate() : daysInMonth;
    const projected = spentAll / dayOf * daysInMonth;
    const insights = `<div class="card panel"><div class="panel__head"><h2>Insights</h2></div>
      <ul class="binsights">
        <li><b>${daysInMonth - dayOf}</b> days left in ${monthLabel(sel).split(" ")[0]}</li>
        <li>Projected month-end spend: <b>${inr(projected)}</b>${overall && projected > overall.limitAmount ? ` <span class="down">over budget</span>` : ""}</li>
        ${categoryTotals(mt)[0] ? `<li>Biggest category: <b>${esc(categoryTotals(mt)[0].name)}</b> (${inr(categoryTotals(mt)[0].total)})</li>` : ""}
      </ul></div>`;

    return `${overallCard}${alert}
      <div class="panel__head" style="margin-top:18px"><h2>${catBudgets.length ? "Category Budgets" : "Spending by Category"}</h2><span class="muted">${monthLabel(sel)}</span></div>
      <div class="bgrid">${catSection}</div>
      ${insights}`;
  }

  /* ── Profile & Settings ──
     Mirrors the Android Profile screen. Web-capable actions are fully
     wired (dark mode, CSV/JSON export, edit name, Drive restore/sync,
     sign out, navigation, external links). Device-only items (App Lock,
     Notifications, Auto-Capture, currency conversion, budget edit, clear
     data) are shown but marked "Manage in the Android app". */
  const NAME_KEY = "expensio_name";
  const DARK_KEY = "expensio_dark";
  const displayName = (M) => localStorage.getItem(NAME_KEY) || (M && M.userName) || window.__expensioProfileName || "there";

  function applyDark(on) {
    document.body.classList.toggle("dark", !!on);
    localStorage.setItem(DARK_KEY, on ? "1" : "0");
  }

  const PM_LABEL = { CASH: "Cash", BANK_TRANSFER: "Bank Transfer", CREDIT_CARD: "Credit Card", UPI: "UPI" };
  const CURRENCIES = { INR: "Indian Rupee (₹)", USD: "US Dollar ($)", EUR: "Euro (€)", GBP: "British Pound (£)", AED: "UAE Dirham (د.إ)", AUD: "Australian Dollar (A$)" };

  function viewProfile(M) {
    const name = displayName(M);
    const email = window.__expensioProfileEmail || "";
    const avatar = window.__expensioProfilePic || "assets/logo.gif";
    const initial = (name || "?").trim().charAt(0).toUpperCase();
    const prefs = M.prefs || {};
    const dark = localStorage.getItem(DARK_KEY) === "1";
    const budget = parseFloat(prefs.monthlyBudgetLimit) || 0;
    const curr = prefs.primaryCurrency || "INR";
    const pm = prefs.defaultPaymentMethod || "Cash";
    const ver = (RAW && RAW.appVersion) || "—";
    const last = $("syncTime") ? $("syncTime").textContent : "—";

    const navRow = (icon, color, label, sub, value, attrs) =>
      `<button class="prow" ${attrs || ""}><span class="prow__ic" style="color:${color};background:${color}1a">${icon}</span>
        <span class="prow__txt"><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</span>
        ${value ? `<span class="prow__val">${value}</span>` : ""}<span class="prow__chev">›</span></button>`;

    const toggleRow = (icon, color, label, sub, on, id, disabled) =>
      `<div class="prow ${disabled ? "is-off" : ""}"><span class="prow__ic" style="color:${color};background:${color}1a">${icon}</span>
        <span class="prow__txt"><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</span>
        ${disabled ? `<span class="prow__badge">Android app</span>`
          : `<button class="switch ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}"><span></span></button>`}</div>`;

    return `<div class="profile">
      <div class="pcol">
        <!-- header -->
        <div class="phead card">
          <div class="phead__top">
            <div class="phead__avatar">${avatar ? `<img src="${esc(avatar)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'phead__init',textContent:'${initial}'}))" />` : `<span class="phead__init">${initial}</span>`}
              <button class="phead__edit" id="pEditName" title="Edit name">✏️</button></div>
            <div class="phead__id"><h2 id="pName">${esc(name)}</h2>${email ? `<p>${esc(email)}</p>` : `<p class="muted">Signed in with Google</p>`}</div>
          </div>
          <div class="phead__panel">
            <span class="phead__fact"><span class="phead__ic">🔒</span>Signed in with Google</span>
            <span class="phead__meta">Synced ${esc(last)}</span>
          </div>
        </div>

        <!-- financial targets -->
        <div class="psec">FINANCIAL TARGETS</div>
        <div class="card plist">
          ${navRow("💰", "#2563EB", "Monthly Budget", "Edit in the Android app", budget ? inr(budget) : "Not set")}
          ${navRow("🗂️", "#10B981", "Manage Categories", `${M.categories.length} categories`, "", `data-act="categories"`)}
          ${navRow("📊", "#7C5CFC", "Statistics", "View insights", "", `data-go="analytics"`)}
          ${navRow("📄", "#E67E22", "Statements", "View transactions", "", `data-go="transactions"`)}
          ${navRow("💳", "#0EA5E9", "Credit Card Usage", "Track spending", "", `data-go="cards"`)}
        </div>

        <!-- preferences -->
        <div class="psec">PREFERENCES</div>
        <div class="card plist">
          ${navRow("🌐", "#6366F1", "Language", "App language", "English")}
          ${navRow("🎯", "#16A34A", "Budget", "Category spending limits", "", `data-go="budgets"`)}
          ${toggleRow("🌙", "#F59E0B", "Dark Mode", "Switch the web app theme", dark, "pDark")}
          ${toggleRow("🔒", "#2563EB", "App Lock", "Biometric lock", false, "", true)}
          ${toggleRow("🔔", "#2563EB", "Notifications", "Transaction alerts", false, "", true)}
          ${toggleRow("🏦", "#2E7D32", "Auto Capture", "Auto-detect bank notifications", false, "", true)}
          ${navRow("₹", "#0D9488", "Primary Currency", CURRENCIES[curr] || curr, curr)}
          ${navRow("💵", "#E67E22", "Default Payment Method", "Used for new transactions", esc(PM_LABEL[pm] || pm))}
        </div>

        <!-- security & data -->
        <div class="psec">SECURITY &amp; DATA</div>
        <div class="card pprivacy">
          <div class="pprivacy__head"><span class="pprivacy__ic">🛡️</span><div><b>Your Privacy Matters</b><small>Your data is read locally from your own Google Drive.</small></div></div>
          <ul><li>🔔 No SMS or phone access — detection via notifications only (Android).</li>
            <li>☁️ Backups live in your own Google Drive — we never store your data.</li></ul>
        </div>
        <div class="card plist">
          ${navRow("☁️", "#4285F4", "Sync / Restore from Drive", `Last synced: ${esc(last)}`, "", `data-act="sync"`)}
          ${navRow("⬇️", "#10B981", "Export to CSV", "Download all transactions", "", `data-act="csv"`)}
          ${navRow("⬇️", "#0EA5E9", "Export to JSON", "Download the full backup", "", `data-act="json"`)}
        </div>
        <button class="card pdanger" data-act="disconnect">
          <span class="prow__ic" style="color:#EF4444;background:#EF44441a">🗑️</span>
          <span class="prow__txt"><b style="color:#EF4444">Disconnect this device</b><small>Clears the local session &amp; remembered file. Your Drive data is untouched.</small></span>
          <span class="prow__badge danger">LOCAL ONLY</span>
        </button>

        <!-- about -->
        <div class="psec">ABOUT</div>
        <div class="card plist">
          ${navRow("⭐", "#F59E0B", "Rate App", "On Google Play", "", `data-href="https://play.google.com/store/apps/details?id=com.ozoteaapps.expensio"`)}
          ${navRow("❓", "#2563EB", "Help &amp; Guide", "FAQ &amp; tips", "", `data-href="index.html#faq"`)}
          ${navRow("🔏", "#0D9488", "Privacy Policy", "", "", `data-href="privacy.html"`)}
          ${navRow("⚖️", "#7C5CFC", "Terms &amp; Conditions", "", "", `data-href="terms.html"`)}
        </div>

        <button class="psignout" id="pSignOut">SIGN OUT</button>
        <div class="pfoot">Version ${esc(ver)} · Web<br/>Made with ❤️ in India</div>
      </div>
    </div>`;
  }

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv(M) {
    const cols = ["Date", "Title", "Category", "Type", "Amount", "Payment Method", "Account/Card", "Note"];
    const rows = M.txns.map((t) => [
      new Date(t.date).toISOString(), t.title || t.brand || "", t.category, t.type, t.amount,
      pmLabel(t), t.sourceName + (t.sourceLast4 ? " ••••" + t.sourceLast4 : ""), (t.note || "").replace(/\s+/g, " "),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    downloadFile("expensio-transactions.csv", [cols.join(","), ...rows].join("\n"), "text/csv");
  }

  function afterProfile(M) {
    const view = $("view");
    // navigation / external links / actions (delegated; data-go handled globally)
    view.querySelectorAll("[data-href]").forEach((b) => b.addEventListener("click", () => window.open(b.dataset.href, "_blank", "noopener")));
    view.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "csv") exportCsv(M);
      else if (act === "json") downloadFile("expensio-backup.json", JSON.stringify(RAW, null, 2), "application/json");
      else if (act === "sync") { openSyncModal(); doSync($("syncModalStatus")); }
      else if (act === "categories") showCategories(M);
      else if (act === "disconnect") { if (confirm("Disconnect this device? This only clears the local session — your Google Drive data is untouched.")) logout(); }
    }));
    // dark mode toggle
    const dk = $("pDark");
    if (dk) dk.addEventListener("click", () => { const on = !dk.classList.contains("on"); dk.classList.toggle("on", on); dk.setAttribute("aria-checked", on); applyDark(on); });
    // edit name (local only)
    const edit = () => {
      const cur = displayName(M);
      const next = prompt("Display name (used for your greeting — saved on this device only):", cur === "there" ? "" : cur);
      if (next != null) { localStorage.setItem(NAME_KEY, next.trim()); $("pName").textContent = next.trim() || "there"; }
    };
    $("pEditName").addEventListener("click", edit);
    $("pName").addEventListener("click", edit);
    $("pSignOut").addEventListener("click", logout);
  }

  function showCategories(M) {
    const byType = {};
    for (const c of M.categories) (byType[c.type] = byType[c.type] || []).push(c);
    const body = Object.keys(byType).length
      ? Object.entries(byType).map(([type, list]) => `<div class="catgrp"><h4>${esc((type || "OTHER").replace(/_/g, " "))}</h4>
          <div class="catchips">${list.map((c) => `<span class="catchip"><span class="em">${emojiFor(c.name)}</span>${esc(c.name)}${c.isCustom ? ` <i>custom</i>` : ""}</span>`).join("")}</div></div>`).join("")
      : `<p class="muted">No categories in this backup.</p>`;
    const ov = document.createElement("div");
    ov.className = "modal";
    ov.innerHTML = `<div class="modal__card" style="text-align:left;max-width:520px">
      <h2 style="margin-bottom:4px">Categories</h2><p class="muted" style="margin:0 0 14px">${M.categories.length} from your backup</p>
      ${body}<div class="modal__actions" style="margin-top:18px;justify-content:flex-end"><button class="btn-primary">Close</button></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("button").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  }

  /* ──────────────────────────────────────────────────────────
     7. App flow
     ────────────────────────────────────────────────────────── */
  function showApp() {
    $("loginView").hidden = true;
    $("appView").hidden = false;
  }

  async function enterApp() {
    showApp();
    // grab profile for the avatar/name (best-effort)
    const profile = await fetchUserProfile();
    if (profile) {
      window.__expensioProfileName = profile.name;
      window.__expensioProfileEmail = profile.email;
      window.__expensioProfilePic = profile.picture;
      if (profile.picture) $("userAvatar").src = profile.picture;
    }
    // prompt to sync from Drive
    openSyncModal();
  }

  function openSyncModal() {
    $("syncModal").hidden = false;
    $("syncModalStatus").textContent = "";
    $("syncModalStatus").classList.remove("err");
  }
  function closeSyncModal() {
    $("syncModal").hidden = true;
  }

  async function loadAndRender(fileId, setStatus) {
    setStatus(`<span class="spin"></span>Reading your backup…`);
    const { data, file } = await fetchBackupById(fileId);
    setData(data);
    renderTab(CURRENT_TAB);
    localStorage.setItem(FILE_ID_KEY, fileId);
    const when = file.modifiedTime
      ? new Date(file.modifiedTime).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "just now";
    $("syncTime").textContent = when;
    closeSyncModal();
  }

  async function doSync(statusEl, forcePick) {
    const setStatus = (html, isErr) => {
      statusEl.innerHTML = html;
      statusEl.classList.toggle("err", !!isErr);
    };
    try {
      // Re-sync the same file silently if we've picked it before.
      const remembered = localStorage.getItem(FILE_ID_KEY);
      if (remembered && !forcePick) {
        try {
          await loadAndRender(remembered, setStatus);
          return;
        } catch (e) {
          if (e.message === "AUTH") throw e;
          // file moved/deleted/inaccessible — fall back to picking again
          localStorage.removeItem(FILE_ID_KEY);
        }
      }

      setStatus(`<span class="spin"></span>Opening Google Drive picker…`);
      const picked = await pickBackupFile();
      if (!picked) {
        setStatus("");
        return;
      }
      await loadAndRender(picked.id, setStatus);
    } catch (e) {
      if (e.message === "AUTH") {
        accessToken = null;
        setStatus(`Session expired. Re-authorizing…`);
        tokenClient.requestAccessToken({ prompt: "" });
        return;
      }
      setStatus(esc(e.message || "Sync failed."), true);
    }
  }

  function logout() {
    if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    sessionStorage.removeItem("expensio_signed_in");
    localStorage.removeItem(FILE_ID_KEY);
    location.reload();
  }

  /* ──────────────────────────────────────────────────────────
     8. Wire up
     ────────────────────────────────────────────────────────── */
  // Demo mode: app.html?demo renders the dashboard from a bundled sample
  // backup so you can preview the UI without setting up OAuth.
  let GUEST = false;

  async function runDemo() {
    showApp();
    $("userAvatar").src = "assets/mark.png";
    if (GUEST) {
      $("resyncBtn").hidden = true;
      $("logoutBtn").textContent = "Sign in";
    }
    try {
      const data = await (await fetch("sample-backup.json")).json();
      setData(data);
      renderTab(new URLSearchParams(location.search).get("tab") || "dashboard");
      $("syncTime").textContent = GUEST ? "guest \u00b7 sample data" : "demo data";
    } catch (e) {
      alert("Demo data failed to load: " + e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const demo = new URLSearchParams(location.search).has("demo");
    if (localStorage.getItem(DARK_KEY) === "1") document.body.classList.add("dark");

    $("userAvatar").addEventListener("click", () => MODEL && renderTab("profile"));

    $("googleSignIn").addEventListener("click", () => {
      if (!isConfigured()) return;
      if (!tokenClient) { initGis(); return loginErr("Still loading Google sign-in… try again in a moment."); }
      $("loginNote").classList.remove("err");
      $("loginNote").textContent = "";
      tokenClient.requestAccessToken({ prompt: "consent" });
    });

    $("guestBtn").addEventListener("click", () => {
      GUEST = true;
      runDemo();
    });

    $("syncNow").addEventListener("click", () => doSync($("syncModalStatus")));
    $("syncLater").addEventListener("click", closeSyncModal);
    $("resyncBtn").addEventListener("click", () => {
      if (!accessToken) return tokenClient.requestAccessToken({ prompt: "" });
      openSyncModal();
      $("resyncBtn").textContent = "⟳ Syncing…";
      doSync($("syncModalStatus")).finally(() => ($("resyncBtn").textContent = "⟳ Sync"));
    });
    $("logoutBtn").addEventListener("click", logout);

    // sidebar tab navigation
    document.querySelectorAll(".side__link").forEach((l) =>
      l.addEventListener("click", () => renderTab(l.dataset.tab))
    );
    // in-view "go to tab" links (e.g. dashboard → analytics)
    $("view").addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) renderTab(go.dataset.go);
    });

    // start: demo data preview, or the real Google sign-in flow
    if (demo) runDemo();
    else initGis();
  });
})();
