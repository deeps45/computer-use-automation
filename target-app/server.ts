import express from "express";
import { nanoid } from "nanoid";
import { members, nextSubAccountNumber, pendingSubAccounts } from "./db.js";
import { layout, escape, money } from "./view.js";

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.TARGET_APP_PORT || 4173);

// --- ultra-minimal session store (cookie -> username), no framework magic ---
const sessions = new Map<string, { user: string; createdAt: number }>();
function getSessionId(req: express.Request): string | undefined {
  const raw = req.headers.cookie || "";
  const m = raw.match(/cvsid=([a-zA-Z0-9_-]+)/);
  return m?.[1];
}
function requireSession(req: express.Request, res: express.Response): boolean {
  const sid = getSessionId(req);
  const sess = sid ? sessions.get(sid) : undefined;
  if (!sess) {
    res.redirect(`/login?reason=required&next=${encodeURIComponent(req.originalUrl)}`);
    return false;
  }
  return true;
}

// --- deterministic runtime-error injection, via ?simulate=... (documented in README) ---
// timeout   -> kills the session mid-flow (simulates expiry)
// slow      -> artificial 2.5s delay before responding (transient slowness)
// error500  -> outright server error (hard failure)
async function applySimulation(req: express.Request, res: express.Response): Promise<"handled" | "continue"> {
  const sim = req.query.simulate as string | undefined;
  if (!sim) return "continue";
  if (sim === "timeout") {
    const sid = getSessionId(req);
    if (sid) sessions.delete(sid);
    res.redirect("/login?reason=timeout");
    return "handled";
  }
  if (sim === "slow") {
    await new Promise((r) => setTimeout(r, 2500));
    return "continue";
  }
  if (sim === "error500") {
    res.status(500).send(layout("System Error", "", `<p>An unexpected error occurred (ref: ${nanoid(8)}). Contact systems support if this persists.</p>`));
    return "handled";
  }
  return "continue";
}

app.get("/", (req, res) => {
  const qs = req.originalUrl.includes("?") ? "?" + req.originalUrl.split("?")[1] : "";
  res.redirect("/login" + qs);
});

app.get("/login", async (req, res) => {
  if ((await applySimulation(req, res)) === "handled") return;
  const reason = req.query.reason as string | undefined;
  let banner = "";
  if (reason === "timeout") banner = `<div class="banner-warn">Your session expired due to inactivity. Please sign in again.</div>`;
  if (reason === "required") banner = `<div class="banner-warn">Please sign in to continue.</div>`;
  res.send(
    layout(
      "Sign In",
      banner,
      `<form method="post" action="/login">
        <p><label for="f-user">Username</label><input id="f-user" name="username" type="text"></p>
        <p><label for="f-pass">Password</label><input id="f-pass" name="password" type="password"></p>
        <p><button type="submit">Sign In</button></p>
      </form>`
    )
  );
});

app.post("/login", (req, res) => {
  const { username, password } = req.body as Record<string, string>;
  if (!username || !password) {
    return res.send(
      layout(
        "Sign In",
        `<div class="banner-err">Username and password are required.</div>`,
        `<form method="post" action="/login">
          <p><label for="f-user">Username</label><input id="f-user" name="username" type="text" value="${escape(username || "")}"></p>
          <p><label for="f-pass">Password</label><input id="f-pass" name="password" type="password"></p>
          <p><button type="submit">Sign In</button></p>
        </form>`
      )
    );
  }
  const sid = nanoid();
  sessions.set(sid, { user: username, createdAt: Date.now() });
  res.setHeader("Set-Cookie", `cvsid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
  const next = (req.query.next as string) || "/search";
  res.redirect(next);
});

app.get("/search", async (req, res) => {
  if (!requireSession(req, res)) return;
  if ((await applySimulation(req, res)) === "handled") return;
  res.send(
    layout(
      "Member Search",
      "",
      `<form method="get" action="/search/results">
        <p><label for="f-mid">Member ID</label><input id="f-mid" name="memberId" type="text"></p>
        <p><button type="submit">Search</button></p>
      </form>`
    )
  );
});

app.get("/search/results", async (req, res) => {
  if (!requireSession(req, res)) return;
  if ((await applySimulation(req, res)) === "handled") return;
  const memberId = String(req.query.memberId || "").trim();
  const member = members[memberId];

  if (!member) {
    return res.send(
      layout(
        "Search Results",
        "",
        `<div class="banner-warn">No member found for ID "${escape(memberId)}". Verify the ID and try again.</div>
         <p><a href="/search">Back to Search</a></p>`
      )
    );
  }
  res.send(
    layout(
      "Search Results",
      "",
      `<table class="data">
        <tr><th>Member ID</th><th>Name</th><th>Branch</th><th></th></tr>
        <tr>
          <td>${escape(member.id)}</td>
          <td>${escape(member.lastName)}, ${escape(member.firstName)}</td>
          <td>${escape(member.branch)}</td>
          <td><a href="/members/${escape(member.id)}">Open Record</a></td>
        </tr>
      </table>`
    )
  );
});

app.get("/members/:id", async (req, res) => {
  if (!requireSession(req, res)) return;
  if ((await applySimulation(req, res)) === "handled") return;
  const member = members[req.params.id];
  if (!member) {
    return res.status(404).send(
      layout("Member Not Found", "", `<div class="banner-warn">Member ${escape(req.params.id)} does not exist in the core.</div><p><a href="/search">Back to Search</a></p>`)
    );
  }
  if (member.id === "40404") {
    return res.status(403).send(
      layout(
        "Access Restricted",
        "",
        `<div class="banner-err">You do not have permission to view this member's accounts (legal hold / restricted). This action has been logged.</div>
         <p><a href="/search">Back to Search</a></p>`
      )
    );
  }
  const rows = member.accounts
    .map((a) => `<tr><td>${escape(a.type)}</td><td>${escape(a.number)}</td><td>${money(a.balance)}</td></tr>`)
    .join("");
  res.send(
    layout(
      `Member ${member.id}`,
      "",
      `<table><tr><td valign="top">
        <table class="data">
          <tr><th colspan="2">Member Detail</th></tr>
          <tr><td>Name</td><td>${escape(member.lastName)}, ${escape(member.firstName)}</td></tr>
          <tr><td>DOB</td><td>${escape(member.dobMasked)}</td></tr>
          <tr><td>Branch</td><td>${escape(member.branch)}</td></tr>
        </table>
        <table class="data">
          <tr><th>Account Type</th><th>Account Number</th><th>Balance</th></tr>
          ${rows}
        </table>
      </td></tr></table>
      <p><a href="/members/${escape(member.id)}/subaccount/new">Open Sub-Account</a> &nbsp; <a href="/search">Back to Search</a></p>`
    )
  );
});

app.get("/members/:id/subaccount/new", async (req, res) => {
  if (!requireSession(req, res)) return;
  if ((await applySimulation(req, res)) === "handled") return;
  const member = members[req.params.id];
  if (!member) return res.status(404).send(layout("Member Not Found", "", `<div class="banner-warn">Member not found.</div>`));
  res.send(
    layout(
      "Open Sub-Account",
      "",
      `<form method="post" action="/members/${escape(member.id)}/subaccount/new">
        <p><label for="f-type">Account Type</label>
          <select id="f-type" name="accountType">
            <option value="Savings">Savings</option>
            <option value="Checking">Checking</option>
          </select></p>
        <p><label for="f-nick">Nickname</label><input id="f-nick" name="nickname" type="text"></p>
        <p><label for="f-dep">Opening Deposit</label><input id="f-dep" name="openingDeposit" type="text"></p>
        <p><button type="submit">Continue</button></p>
      </form>`
    )
  );
});

app.post("/members/:id/subaccount/new", async (req, res) => {
  if (!requireSession(req, res)) return;
  const member = members[req.params.id];
  if (!member) return res.status(404).send(layout("Member Not Found", "", `<div class="banner-warn">Member not found.</div>`));
  const { accountType, nickname, openingDeposit } = req.body as Record<string, string>;
  const deposit = Number(openingDeposit);
  const MIN_DEPOSIT = 25;
  if (!nickname || !Number.isFinite(deposit) || deposit < MIN_DEPOSIT) {
    return res.send(
      layout(
        "Open Sub-Account",
        `<div class="banner-err">Validation error: nickname is required and opening deposit must be at least ${money(MIN_DEPOSIT)}.</div>`,
        `<form method="post" action="/members/${escape(member.id)}/subaccount/new">
          <p><label for="f-type">Account Type</label>
            <select id="f-type" name="accountType">
              <option value="Savings" ${accountType === "Savings" ? "selected" : ""}>Savings</option>
              <option value="Checking" ${accountType === "Checking" ? "selected" : ""}>Checking</option>
            </select></p>
          <p><label for="f-nick">Nickname</label><input id="f-nick" name="nickname" type="text" value="${escape(nickname || "")}"></p>
          <p><label for="f-dep">Opening Deposit</label><input id="f-dep" name="openingDeposit" type="text" value="${escape(openingDeposit || "")}"></p>
          <p><button type="submit">Continue</button></p>
        </form>`
      )
    );
  }
  const token = nanoid(10);
  pendingSubAccounts.set(token, { token, memberId: member.id, accountType, nickname, openingDeposit: deposit, createdAt: Date.now() });
  res.redirect(`/members/${escape(member.id)}/subaccount/confirm?token=${token}`);
});

app.get("/members/:id/subaccount/confirm", async (req, res) => {
  if (!requireSession(req, res)) return;
  if ((await applySimulation(req, res)) === "handled") return;
  const token = String(req.query.token || "");
  const pending = pendingSubAccounts.get(token);
  if (!pending || pending.memberId !== req.params.id) {
    return res.status(400).send(layout("Expired", "", `<div class="banner-err">This confirmation link is invalid or has expired. Start again.</div>`));
  }
  res.send(
    layout(
      "Confirm Sub-Account",
      `<div class="banner-warn">This action opens a new account and cannot be undone from this screen.</div>`,
      `<table class="data">
        <tr><th colspan="2">Confirm New Sub-Account</th></tr>
        <tr><td>Member</td><td>${escape(req.params.id)}</td></tr>
        <tr><td>Account Type</td><td>${escape(pending.accountType)}</td></tr>
        <tr><td>Nickname</td><td>${escape(pending.nickname)}</td></tr>
        <tr><td>Opening Deposit</td><td>${money(pending.openingDeposit)}</td></tr>
      </table>
      <form method="post" action="/members/${escape(req.params.id)}/subaccount/confirm">
        <input type="hidden" name="token" value="${escape(token)}">
        <button type="submit">Confirm &amp; Open Account</button>
      </form>`
    )
  );
});

app.post("/members/:id/subaccount/confirm", async (req, res) => {
  if (!requireSession(req, res)) return;
  const token = String(req.body.token || "");
  const pending = pendingSubAccounts.get(token);
  if (!pending || pending.memberId !== req.params.id) {
    return res.status(400).send(layout("Expired", "", `<div class="banner-err">This confirmation link is invalid or has expired. Start again.</div>`));
  }
  pendingSubAccounts.delete(token);
  const member = members[req.params.id];
  const acctNumber = nextSubAccountNumber(member.id);
  member.accounts.push({ type: pending.accountType as "Savings" | "Checking", number: acctNumber, balance: pending.openingDeposit });
  res.redirect(`/members/${escape(req.params.id)}/subaccount/success?acct=${encodeURIComponent(acctNumber)}`);
});

app.get("/members/:id/subaccount/success", (req, res) => {
  if (!requireSession(req, res)) return;
  const acct = String(req.query.acct || "");
  res.send(
    layout(
      "Sub-Account Opened",
      `<div class="banner-ok">Sub-account opened successfully.</div>`,
      `<table class="data"><tr><th>New Account Number</th></tr><tr><td>${escape(acct)}</td></tr></table>
       <p><a href="/members/${escape(req.params.id)}">Back to Member</a></p>`
    )
  );
});

app.listen(PORT, () => {
  console.log(`[target-app] CreditVantage mock console listening on http://localhost:${PORT}`);
});
