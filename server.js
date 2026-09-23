import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataRoot = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(rootDir, "data");
const dataDir = dataRoot;
const uploadsDir = path.join(dataRoot, "uploads");
const stateFile = path.join(dataDir, "state.json");
const plannerFile = path.join(dataDir, "planner.json");
const inviteSecret = process.env.EV_INVITE_SECRET || "ev-dashboard-dev-secret";
const authCookieName = "ev_dashboard_auth";
const authMaxAgeSeconds = 60 * 60 * 24 * 30;
// Invite code handed out to contractors (ผรม.) for the site-report portal only.
// Change via the EV_CONTRACTOR_INVITE_CODE variable in Railway -> Variables.
const contractorInviteCode = process.env.EV_CONTRACTOR_INVITE_CODE || "EV-CONTRACTOR-2026";
// Invite code handed out to the client / project owner (ลูกค้า) — read-only
// diary reports + plan approvals only. Change via EV_CLIENT_INVITE_CODE.
// This single default code is UNSCOPED (sees every project) — keep it for
// EGAT's own internal reviewers, not for an actual outside client.
const clientInviteCode = process.env.EV_CLIENT_INVITE_CODE || "EV-CLIENT-2026";

// Give each real client their OWN invite code bound to just their project,
// via Railway -> Variables -> EV_CLIENT_INVITE_CODES, a JSON array like:
// [{"code":"EV-CLIENT-CENTRALPLAZA","projectId":"ev-station-001","label":"ลูกค้า Central Plaza"}]
function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error(`Invalid JSON in ${name}, ignoring it`);
    return [];
  }
}
// projectId must match an id in the Projects list (see GET /api/contractor/projects).
// Instead of hunting for that id, you can set "project" to (part of) the
// project's NAME instead — it gets matched against the real project list
// on every load (see resolveProjectId below). Example:
// [{"code":"EV-CLIENT-TAITAAN","project":"TAITAAN","label":"ลูกค้า Taitaan"}]
const extraClientInviteCodes = parseJsonEnv("EV_CLIENT_INVITE_CODES")
  .filter((item) => item && typeof item.code === "string" && item.code.trim())
  .map((item) => ({
    code: item.code.trim(),
    projectId: typeof item.projectId === "string" ? item.projectId : null,
    project: typeof item.project === "string" && item.project.trim() ? item.project.trim() : null,
    label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "ลูกค้า",
    active: true,
    role: "client",
  }));

// Give each contractor company their OWN invite code bound to just their
// project too, via Railway -> Variables -> EV_CONTRACTOR_INVITE_CODES, same
// JSON shape as EV_CLIENT_INVITE_CODES (projectId OR project name — see
// above). A contractor code with no projectId/project (including the
// default EV-CONTRACTOR-2026) still sees every project.
const extraContractorInviteCodes = parseJsonEnv("EV_CONTRACTOR_INVITE_CODES")
  .filter((item) => item && typeof item.code === "string" && item.code.trim())
  .map((item) => ({
    code: item.code.trim(),
    projectId: typeof item.projectId === "string" ? item.projectId : null,
    project: typeof item.project === "string" && item.project.trim() ? item.project.trim() : null,
    label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "ผรม.",
    active: true,
    role: "contractor",
  }));

// Resolves a typed project name against the real project list: exact
// (case-insensitive) match wins; otherwise, if the name appears inside
// exactly one project's full name (e.g. "TAITAAN" inside "...พร้อมติดตั้ง
// (TAITAAN)"), that one is used. Zero or multiple matches fail closed (the
// invite code ends up scoped to a project that doesn't exist, so it sees
// nothing, rather than silently falling back to "sees everything").
function resolveProjectId(name, projects) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return null;
  const exact = projects.find((p) => String(p.name || "").trim().toLowerCase() === needle);
  if (exact) return exact.id;
  const contains = projects.filter((p) => String(p.name || "").toLowerCase().includes(needle));
  return contains.length === 1 ? contains[0].id : null;
}

const port = Number(process.env.PORT || 3000);

// Total Solution Planner reads/writes this same Google Apps Script Web App
// directly from the browser (public/planner.html) — it has its own project
// registry (id like "1.1", name = contractor company, site = client/site
// name) totally separate from this server's own `state.projects`. The
// import feature below lets an admin pull that registry in here as a
// reviewed, one-time link/copy — never a silent live sync.
const plannerAppsScriptUrl = process.env.EV_PLANNER_URL
  || "https://script.google.com/macros/s/AKfycbxtpf9aNev-BTCPj2WckvLukuZJHlrBnmOFnvo7O2mS_5wQpsKzfYA1pmbGX_cAJ8nq6A/exec";

// LINE Messaging API — set via Railway -> Variables -> LINE_CHANNEL_ACCESS_TOKEN
// and LINE_CHANNEL_SECRET. Notifications are silently skipped (no crash) when
// these aren't configured, so the rest of the app works fine without them.
const lineChannelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const lineChannelSecret = process.env.LINE_CHANNEL_SECRET || "";
const lineApiBase = "https://api.line.me/v2/bot/message";
// In dev/test, override where push/reply calls go (real api.line.me is
// unreachable from this sandbox) — never set in production.
const lineApiOverrideBase = process.env.LINE_API_BASE_OVERRIDE || "";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

const defaultState = {
  inviteCodes: [
    {
      code: "EV-TEAM-2026",
      label: "ทีมงานภายใน",
      active: true,
      role: "admin",
    },
    {
      code: contractorInviteCode,
      label: "ผรม. / ทีมช่างหน้างาน",
      active: true,
      role: "contractor",
    },
    {
      code: clientInviteCode,
      label: "ลูกค้า / เจ้าของโครงการ",
      active: true,
      role: "client",
    },
  ],
  projects: [
    {
      id: "ev-station-001",
      name: "โครงการติดตั้งสถานีอัดประจุไฟฟ้า - Central Plaza",
      client: "Total Solutions",
      location: "กรุงเทพฯ",
      owner: "ทีมวิศวกรโครงการ",
      dueDate: "2026-07-31",
      phases: [
        {
          id: "survey",
          name: "สำรวจหน้างาน",
          order: 1,
          status: "In Progress",
          progress: 75,
          checklist: [
            "สำรวจพื้นที่หน้างาน",
            "ตรวจสอบโหลดไฟฟ้า",
            "บันทึกรูปถ่าย",
            "ยืนยันผังตำแหน่ง",
          ],
          updates: [
            {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              author: "นิรันดร์",
              note: "สำรวจหน้างานแล้ว และยืนยันแนวเดินสายสำหรับช่องชาร์จ A",
              progress: 75,
              status: "In Progress",
              images: [],
            },
          ],
        },
        {
          id: "pre-construction",
          name: "เตรียมก่อนก่อสร้าง",
          order: 2,
          status: "Not Started",
          progress: 10,
          checklist: [
            "ติดตามใบอนุญาตและการอนุมัติ",
            "ตรวจสอบความพร้อมวัสดุ",
            "ทบทวนแผนความปลอดภัย",
            "ประสานงานผู้รับเหมา",
          ],
          updates: [],
        },
        {
          id: "construction",
          name: "ก่อสร้าง",
          order: 3,
          status: "Not Started",
          progress: 0,
          checklist: [
            "งานโยธา",
            "เดินสายไฟ",
            "ติดตั้งตู้ไฟ",
            "ติดตั้งเครื่องชาร์จ",
          ],
          updates: [],
        },
        {
          id: "commissioning",
          name: "ทดสอบและส่งมอบ",
          order: 4,
          status: "Not Started",
          progress: 0,
          checklist: [
            "ทดสอบฉนวน",
            "ทดสอบการทำงาน",
            "ทดลองชาร์จ",
            "ลงนามส่งมอบงาน",
          ],
          updates: [],
        },
      ],
    },
  ],
  activity: [],
  contractorRecords: [],
  updatedAt: new Date().toISOString(),
};

let state = await loadState();
const sseClients = new Set();

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadsDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/line/webhook") {
      const raw = await readRawBody(req);
      const signature = req.headers["x-line-signature"];
      if (!verifyLineSignature(raw, signature)) {
        res.writeHead(401);
        return res.end();
      }
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = { events: [] };
      }
      for (const event of body.events || []) {
        handleLineEvent(event).catch((error) => console.error("LINE event error:", error.message));
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    if (req.method === "POST" && url.pathname === "/api/auth/invite") {
      const body = await readJson(req);
      return handleInviteLogin(req, res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      return handleLogout(res);
    }

    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      return sendJson(res, 200, getAuthStatus(req));
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, state);
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!requireAdmin(req, res)) return;
      return handleSse(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/report") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const updated = await applyReport(body);
      return sendJson(res, 200, updated);
    }

    if (req.method === "POST" && url.pathname === "/api/project") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const created = await createProject(body);
      return sendJson(res, 201, created);
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/project/")) {
      if (!requireAdmin(req, res)) return;
      const projectId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const body = await readJson(req);
      const updated = await updateProject(projectId, body);
      return sendJson(res, 200, updated);
    }

    if (req.method === "GET" && url.pathname === "/api/planner") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, await loadPlanner());
    }

    if (req.method === "POST" && url.pathname === "/api/planner") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const saved = await savePlanner(body);
      return sendJson(res, 200, saved);
    }

    // ---- Contractor (ผรม.) site portal ----
    // Any authenticated role may call these, but visibility is scoped inside
    // each handler: contractor sessions only ever see their own records.
    if (req.method === "POST" && url.pathname === "/api/contractor/record") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);
      if (auth.role === "client") {
        return sendJson(res, 403, { error: "Client accounts are read-only and cannot submit site records" });
      }
      const body = await readJson(req);
      const created = await createContractorRecord(auth, body);
      return sendJson(res, 201, created);
    }

    const approveMatch = url.pathname.match(/^\/api\/contractor\/record\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);
      if (auth.role !== "admin" && auth.role !== "client") {
        return sendJson(res, 403, { error: "Only the client or admin can approve a site-entry plan" });
      }
      const body = await readJson(req);
      const result = await reviewPlanRecord(auth, decodeURIComponent(approveMatch[1]), body);
      return sendJson(res, result.ok ? 200 : result.status || 400, result);
    }

    if (req.method === "GET" && url.pathname === "/api/contractor/records") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);
      const records = listContractorRecords(auth, url.searchParams.get("type"));
      return sendJson(res, 200, { records });
    }

    if (req.method === "GET" && url.pathname === "/api/contractor/projects") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);
      // A client or contractor whose invite code is bound to one project only
      // ever sees that project here — so the picker can't reveal others exist.
      if ((auth.role === "client" || auth.role === "contractor") && auth.projectId) {
        const project = (state.projects || []).find((p) => p.id === auth.projectId);
        return sendJson(res, 200, { projects: project ? [{ id: project.id, name: project.name, showChecklistToClient: Boolean(project.showChecklistToClient) }] : [] });
      }
      return sendJson(res, 200, { projects: getProjectList() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/invite-codes") {
      if (!requireAdmin(req, res)) return;
      return sendJson(res, 200, { inviteCodes: state.inviteCodes, projects: getProjectList() });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/invite-codes") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const result = await createInviteCode(body);
      return sendJson(res, result.ok ? 201 : result.status || 400, result);
    }

    const inviteCodeMatch = url.pathname.match(/^\/api\/admin\/invite-codes\/([^/]+)$/);
    if (inviteCodeMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      if (!requireAdmin(req, res)) return;
      const codeParam = decodeURIComponent(inviteCodeMatch[1]);
      if (req.method === "PATCH") {
        const body = await readJson(req);
        const result = await updateInviteCode(codeParam, body);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }
      const result = await deleteInviteCode(codeParam);
      return sendJson(res, result.ok ? 200 : result.status || 400, result);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/planner-import-preview") {
      if (!requireAdmin(req, res)) return;
      try {
        const result = await buildPlannerImportPreview();
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 502, { error: error.message || "โหลดข้อมูลจาก Planner ไม่สำเร็จ" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/planner-import-commit") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const result = await commitPlannerImport(body?.items);
      return sendJson(res, 200, result);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/contractor/record/")) {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      const result = await deleteContractorRecord(auth, id);
      return sendJson(res, result.ok ? 200 : result.status || 404, result);
    }

    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      return serveFile(res, path.join(uploadsDir, path.basename(url.pathname)));
    }

    return serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Internal Server Error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`EV dashboard running at http://0.0.0.0:${port}`);
});

process.on("SIGINT", async () => {
  await saveState();
  process.exit(0);
});

async function loadState() {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    const initial = normalizeState(structuredClone(defaultState));
    await fs.writeFile(stateFile, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
}

function normalizeState(input) {
  const normalized = input && typeof input === "object" ? input : {};
  normalized.projects = Array.isArray(normalized.projects) ? normalized.projects : structuredClone(defaultState.projects);
  normalized.inviteCodes = Array.isArray(normalized.inviteCodes) && normalized.inviteCodes.length
    ? normalized.inviteCodes
    : structuredClone(defaultState.inviteCodes);

  // Back-compat: invite codes created before roles existed are treated as admin.
  normalized.inviteCodes = normalized.inviteCodes.map((item) => ({
    ...item,
    role: item.role === "contractor" || item.role === "client" ? item.role : "admin",
  }));
  // Make sure a contractor invite code always exists, even on data created
  // before the contractor portal was added.
  if (!normalized.inviteCodes.some((item) => item.role === "contractor")) {
    normalized.inviteCodes.push({
      code: contractorInviteCode,
      label: "ผรม. / ทีมช่างหน้างาน",
      active: true,
      role: "contractor",
    });
  }
  // Same for the client (ลูกค้า) read-only + approval invite code.
  if (!normalized.inviteCodes.some((item) => item.role === "client")) {
    normalized.inviteCodes.push({
      code: clientInviteCode,
      label: "ลูกค้า / เจ้าของโครงการ",
      active: true,
      role: "client",
    });
  }
  // Sync the project-scoped client codes from EV_CLIENT_INVITE_CODES: add new
  // ones, update label/projectId/active for ones that already exist by code,
  // never touch client codes NOT listed there (e.g. the default clientInviteCode).
  for (const extra of extraClientInviteCodes) {
    const idx = normalized.inviteCodes.findIndex((item) => item.code === extra.code);
    if (idx === -1) {
      normalized.inviteCodes.push(extra);
    } else {
      normalized.inviteCodes[idx] = { ...normalized.inviteCodes[idx], ...extra };
    }
  }
  // Same sync for project-scoped contractor codes (EV_CONTRACTOR_INVITE_CODES).
  for (const extra of extraContractorInviteCodes) {
    const idx = normalized.inviteCodes.findIndex((item) => item.code === extra.code);
    if (idx === -1) {
      normalized.inviteCodes.push(extra);
    } else {
      normalized.inviteCodes[idx] = { ...normalized.inviteCodes[idx], ...extra };
    }
  }

  // Resolve any client/contractor code configured with a project NAME
  // (instead of a raw id) against the real project list. Re-resolved on
  // every load, so renaming a project in the dashboard doesn't break codes
  // that were matched by name earlier. A name that no longer matches
  // anything resolves to a sentinel that matches no real project (fail
  // closed: that code sees nothing until the name/id is fixed).
  normalized.inviteCodes = normalized.inviteCodes.map((item) => {
    if ((item.role === "client" || item.role === "contractor") && !item.projectId && item.project) {
      const resolved = resolveProjectId(item.project, normalized.projects);
      return { ...item, projectId: resolved || `unresolved:${item.project}` };
    }
    return item;
  });

  normalized.activity = Array.isArray(normalized.activity) ? normalized.activity : [];
  normalized.contractorRecords = Array.isArray(normalized.contractorRecords) ? normalized.contractorRecords : [];
  normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
  return normalized;
}

async function saveState() {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function loadPlanner() {
  try {
    const raw = await fs.readFile(plannerFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function savePlanner(body) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(plannerFile, JSON.stringify(body, null, 2), "utf8");
  return { ok: true };
}

function getAuthStatus(req) {
  const auth = getAuth(req);
  return {
    authenticated: Boolean(auth),
    inviteCode: auth?.code || null,
    role: auth?.role || null,
    projectId: auth?.projectId || null,
  };
}

function isAuthenticated(req) {
  return Boolean(getAuth(req));
}

// Verifies the session cookie and normalizes its role. Cookies signed before
// the contractor/client roles existed carry no `role` field at all — those
// were always full admin sessions, so a missing role is treated as "admin"
// rather than rejected. This makes the role rollout backward-compatible: no
// one has to log out and back in just because we shipped this feature.
function getAuth(req) {
  const auth = verifyAuthCookie(getCookies(req)[authCookieName]);
  if (!auth) return null;
  return {
    ...auth,
    role: auth.role === "contractor" || auth.role === "client" ? auth.role : "admin",
    projectId: typeof auth.projectId === "string" ? auth.projectId : null,
  };
}

// Gate for admin-only endpoints (dashboard, planner, project management).
// Contractor/client sessions are rejected here and must use their own pages.
function requireAdmin(req, res) {
  const auth = getAuth(req);
  if (!auth) {
    unauthorized(res);
    return null;
  }
  if (auth.role !== "admin") {
    sendJson(res, 403, {
      error: "CONTRACTOR_ROLE",
      message: "รหัสนี้ใช้ได้เฉพาะหน้า ผรม./ลูกค้า กรุณาเข้าใช้งานที่หน้าของคุณ",
    });
    return null;
  }
  return auth;
}

function verifyAuthCookie(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, sigPart] = parts;
  const expectedSig = signPayload(payloadPart);
  if (!safeEqual(sigPart, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function signPayload(payloadPart) {
  return createHmac("sha256", inviteSecret).update(payloadPart).digest("base64url");
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function getCookies(req) {
  const raw = req.headers.cookie || "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const key = index >= 0 ? part.slice(0, index) : part;
        const value = index >= 0 ? part.slice(index + 1) : "";
        return [decodeURIComponent(key), decodeURIComponent(value)];
      }),
  );
}

function buildAuthCookie(code, role, projectId) {
  const safeRole = role === "contractor" || role === "client" ? role : "admin";
  const payload = Buffer.from(
    JSON.stringify({
      code,
      role: safeRole,
      projectId: typeof projectId === "string" ? projectId : null,
      exp: Date.now() + authMaxAgeSeconds * 1000,
    }),
    "utf8",
  ).toString("base64url");
  const sig = signPayload(payload);
  return `${authCookieName}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${authMaxAgeSeconds}`;
}

function clearAuthCookie() {
  return `${authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function unauthorized(res) {
  return sendJson(res, 401, { error: "Unauthorized" });
}

function handleInviteLogin(req, res, body) {
  const code = String(body?.code || "").trim();
  if (!code) {
    return sendJson(res, 400, { error: "Invite code is required" });
  }

  const invite = state.inviteCodes.find((item) => item.active && item.code === code);
  if (!invite) {
    return sendJson(res, 403, { error: "Invalid invite code" });
  }

  const role = invite.role === "contractor" || invite.role === "client" ? invite.role : "admin";
  const projectId = typeof invite.projectId === "string" ? invite.projectId : null;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildAuthCookie(code, role, projectId),
  });
  res.end(JSON.stringify({ ok: true, inviteCode: code, role, projectId }));
}

function handleLogout(res) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": clearAuthCookie(),
  });
  res.end(JSON.stringify({ ok: true }));
}

async function applyReport(body) {
  const { projectId, phaseId, note = "", progress, status, author = "Operator", images = [] } = body || {};
  if (!projectId || !phaseId) {
    throw new Error("projectId and phaseId are required");
  }

  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const phase = project.phases.find((item) => item.id === phaseId);
  if (!phase) {
    throw new Error("Phase not found");
  }

  if (typeof progress === "number" && Number.isFinite(progress)) {
    phase.progress = Math.max(0, Math.min(100, Math.round(progress)));
  }

  if (status) {
    phase.status = status;
  }

  const savedImages = [];
  for (const image of images) {
    if (!image?.dataUrl) continue;
    const saved = await saveDataUrl(image.dataUrl, image.name || "upload");
    savedImages.push(saved);
  }

  const update = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    author,
    note,
    progress: phase.progress,
    status: phase.status,
    images: savedImages,
  };

  phase.updates.unshift(update);
  project.phases.sort((a, b) => a.order - b.order);

  state.activity.unshift({
    ...update,
    projectId,
    projectName: project.name,
    phaseId,
    phaseName: phase.name,
  });

  state.activity = state.activity.slice(0, 50);
  await saveState();
  broadcast({ type: "state-updated", updatedAt: state.updatedAt });
  return { ok: true, state };
}

// ---- Contractor (ผรม.) records: pre-start plan, safety checklist, diary ----
const CONTRACTOR_RECORD_TYPES = new Set(["plan", "checklist", "diary"]);

async function createContractorRecord(auth, body) {
  const type = String(body?.type || "").trim();
  if (!CONTRACTOR_RECORD_TYPES.has(type)) {
    throw new Error("Invalid record type");
  }

  const payload = body?.payload && typeof body.payload === "object" ? { ...body.payload } : {};

  // A contractor whose invite code is bound to one project can only ever
  // log work against that project — override whatever the client sent.
  if (auth.role === "contractor" && auth.projectId) {
    const project = (state.projects || []).find((p) => p.id === auth.projectId);
    payload.projectId = auth.projectId;
    if (project) payload.project = project.name;
  }

  // Plan (pre-start) records go through a client/admin approval step for site
  // entry. The approval state is always server-assigned so a contractor can
  // never submit a pre-approved or self-approved plan.
  if (type === "plan") {
    payload.approval = { status: "pending", reviewer: null, reviewerRole: null, reviewerName: null, reviewedAt: null, note: "" };
  }

  if (Array.isArray(payload.photos)) {
    const savedPhotos = [];
    for (const photo of payload.photos) {
      if (typeof photo === "string" && photo.startsWith("data:image/")) {
        const saved = await saveDataUrl(photo, "site-photo");
        savedPhotos.push(saved.url);
      } else if (typeof photo === "string") {
        savedPhotos.push(photo);
      }
    }
    payload.photos = savedPhotos;
  }

  if (typeof payload.signature === "string" && payload.signature.startsWith("data:image/")) {
    const saved = await saveDataUrl(payload.signature, "signature");
    payload.signature = saved.url;
  }

  const record = {
    id: randomUUID(),
    type,
    ownerCode: auth.code,
    createdAt: new Date().toISOString(),
    payload,
  };

  state.contractorRecords = state.contractorRecords || [];
  state.contractorRecords.unshift(record);
  state.contractorRecords = state.contractorRecords.slice(0, 3000);
  await saveState();
  broadcast({ type: "contractor-record-added", recordType: type });
  if (type === "plan") {
    notifyClientsOfNewPlan(payload).catch((error) => console.error("LINE notify (new plan) failed:", error.message));
  }
  return { ok: true, record };
}

function listContractorRecords(auth, type) {
  let records = state.contractorRecords || [];
  if (auth.role === "contractor") {
    records = records.filter((r) => r.ownerCode === auth.code);
  } else if (auth.role === "client") {
    // A client whose invite code is bound to one project (EV_CLIENT_INVITE_CODES)
    // only ever sees that project's records — never another client's work.
    // The unscoped default client code (no projectId) keeps seeing every
    // project's diary/plan (never checklist), for EGAT's own internal reviewers.
    const boundProject = auth.projectId ? (state.projects || []).find((p) => p.id === auth.projectId) : null;
    const allowChecklist = Boolean(boundProject && boundProject.showChecklistToClient);

    records = records.filter((r) => r.type === "diary" || r.type === "plan" || (r.type === "checklist" && allowChecklist));

    if (auth.projectId) {
      const projectName = boundProject ? boundProject.name : null;
      records = records.filter((r) => {
        const p = r.payload || {};
        if (p.projectId) return p.projectId === auth.projectId;
        // Back-compat for records saved before contractors picked a project
        // from the list (free-text project name, possibly not word-for-word
        // identical to the real project name) — same loose matching as
        // resolveProjectId: exact match, or either string contains the other.
        if (!projectName || typeof p.project !== "string" || !p.project.trim()) return false;
        const a = p.project.trim().toLowerCase();
        const b = projectName.trim().toLowerCase();
        return a === b || a.includes(b) || b.includes(a);
      });
    }
  }
  // admin: no filtering, sees every record from every contractor.
  if (type && type !== "all") {
    records = records.filter((r) => r.type === type);
  }
  return records;
}

function getProjectList() {
  return (state.projects || []).map((p) => ({ id: p.id, name: p.name, showChecklistToClient: Boolean(p.showChecklistToClient) }));
}

// Short, URL/label-safe tag pulled from a project name for auto-generating
// invite codes — prefers the client nickname in the LAST (...) in the name
// (e.g. "...พร้อมติดตั้ง(TAITAAN)" -> "TAITAAN"), since that's how this org
// names projects; falls back to the label or the raw name otherwise.
function extractParenTag(name) {
  const matches = String(name || "").match(/\(([^)]+)\)/g);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].slice(1, -1);
}
function slugifyCode(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9ก-๙]+/g, "")
    .slice(0, 24);
}
function generateInviteCode(role, project, label) {
  const prefix = role === "client" ? "EV-CLIENT" : "EV-CONTRACTOR";
  const tag = (project && extractParenTag(project.name)) || label || (project && project.name) || "NEW";
  const slug = slugifyCode(tag) || "NEW";
  let code = `${prefix}-${slug}`;
  let n = 2;
  while (state.inviteCodes.some((c) => c.code === code)) {
    code = `${prefix}-${slug}${n}`;
    n += 1;
  }
  return code;
}

async function createInviteCode(body) {
  const role = body?.role === "client" || body?.role === "contractor" ? body.role : null;
  if (!role) return { ok: false, status: 400, error: "role ต้องเป็น 'client' หรือ 'contractor'" };

  const projectId = typeof body?.projectId === "string" && body.projectId ? body.projectId : null;
  const project = projectId ? (state.projects || []).find((p) => p.id === projectId) : null;
  if (projectId && !project) return { ok: false, status: 400, error: "projectId ไม่ตรงกับโครงการใดเลย" };

  const label = typeof body?.label === "string" && body.label.trim()
    ? body.label.trim()
    : `${role === "client" ? "ลูกค้า" : "ผรม."} ${project ? project.name : ""}`.trim();

  let code = typeof body?.code === "string" && body.code.trim() ? body.code.trim().toUpperCase() : null;
  if (code) {
    if (state.inviteCodes.some((c) => c.code === code)) return { ok: false, status: 400, error: "รหัสนี้ถูกใช้ไปแล้ว" };
  } else {
    code = generateInviteCode(role, project, label);
  }

  const entry = { code, role, projectId, label, active: true };
  state.inviteCodes.push(entry);
  await saveState();
  broadcast({ type: "invite-code-added", code });
  return { ok: true, inviteCode: entry };
}

async function updateInviteCode(code, body) {
  const idx = state.inviteCodes.findIndex((c) => c.code === code);
  if (idx === -1) return { ok: false, status: 404, error: "ไม่พบรหัสนี้" };
  const current = state.inviteCodes[idx];
  const next = { ...current };
  if (typeof body?.label === "string") next.label = body.label.trim();
  if (typeof body?.active === "boolean") next.active = body.active;
  if (typeof body?.projectId === "string" && body.projectId) {
    if (!(state.projects || []).some((p) => p.id === body.projectId)) {
      return { ok: false, status: 400, error: "projectId ไม่ตรงกับโครงการใดเลย" };
    }
    next.projectId = body.projectId;
  } else if (body?.projectId === null) {
    next.projectId = null;
  }
  state.inviteCodes[idx] = next;
  await saveState();
  return { ok: true, inviteCode: next };
}

async function deleteInviteCode(code) {
  const idx = state.inviteCodes.findIndex((c) => c.code === code);
  if (idx === -1) return { ok: false, status: 404, error: "ไม่พบรหัสนี้" };
  const entry = state.inviteCodes[idx];
  if (entry.role === "admin") {
    const adminCount = state.inviteCodes.filter((c) => c.role === "admin" && c.active).length;
    if (adminCount <= 1) return { ok: false, status: 400, error: "ต้องมีรหัสแอดมินที่ใช้งานได้อย่างน้อย 1 รหัสเสมอ" };
  }
  state.inviteCodes.splice(idx, 1);
  await saveState();
  return { ok: true };
}

// ---- Total Solution Planner import (preview → admin confirms → commit) ----
// Same fallback list Total Solution Planner itself ships with (its
// DEFAULT_PROJECTS) — used if the live Google Sheet hasn't been saved with
// a "projects" array yet (e.g. Planner was only ever used with its local
// seed data and never triggered a save), so import still works.
const defaultPlannerProjects = [
  { id: "1.1", type: "install", name: "บริษัท เอ.ที.59 จำกัด", site: "ISUZU สำนักงานใหญ่ บางแสน ชลบุรี", pkg: "Package L · DC 180 kW ×1" },
  { id: "1.2", type: "install", name: "บริษัท อีวี เทลวี จำกัด", site: "ปั๊มเชลล์ จ.สุรินทร์", pkg: "Package L+ · DC 180 kW ×3 + Spare ระบบไฟฟ้า 1 ชุด" },
  { id: "1.3", type: "install", name: "แทนไทย (เทิดราชัน)", site: "", pkg: "Package L · DC 180 kW ×1" },
  { id: "1.4", type: "install", name: "ฮาร์ดแวร์ เฮ้าส์", site: "รังสิต", pkg: "Package L+ · DC 180 kW ×2" },
  { id: "2.1", type: "purchase", name: "บริษัท ชาร์จพลัส โซลูชั่น กรุ๊ป", site: "", pkg: "DC 180 kW ×4" },
  { id: "2.2", type: "purchase", name: "บริษัท คิว.อี แคปิตอล จำกัด", site: "", pkg: "DC 180 kW ×4" },
  { id: "2.3", type: "purchase", name: "บจก. สถานีชาร์จอีวีหาดใหญ่", site: "", pkg: "DC 180 kW ×2" },
];

async function fetchPlannerData() {
  const res = await fetch(plannerAppsScriptUrl, { method: "GET" });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Planner ตอบกลับผิดพลาด: HTTP ${res.status} — ${raw.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Planner ไม่ได้ตอบกลับเป็น JSON — เนื้อหาที่ได้: ${raw.slice(0, 200)}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error(`Planner ตอบกลับไม่ใช่ object ที่ใช้ได้ — เนื้อหาที่ได้: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(data.projects) || data.projects.length === 0) {
    data.projects = defaultPlannerProjects;
    data.projectsFallback = true;
  }
  return data;
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}
function matchTokens(text) {
  return normalizeForMatch(text)
    .split(" ")
    .filter((t) => t.length >= 3);
}
// Suggests (never assumes) which existing project a Planner entry belongs
// to, by looking for a shared, reasonably specific word (>=3 chars) between
// Planner's site/company name and the project's own name. Longer/more
// specific shared words score higher. This only ever produces a SUGGESTION
// for the admin's review screen — nothing here writes to state.
function suggestProjectMatch(plannerEntry, projects) {
  const tags = [...matchTokens(plannerEntry.site), ...matchTokens(plannerEntry.name)];
  let best = null;
  let bestScore = 0;
  for (const project of projects) {
    const projectNorm = normalizeForMatch(project.name);
    let score = 0;
    for (const tag of tags) {
      if (projectNorm.includes(tag)) score += tag.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = project;
    }
  }
  return bestScore >= 4 ? best : null;
}

async function buildPlannerImportPreview() {
  const plannerData = await fetchPlannerData();
  const plannerProjects = plannerData.projects || [];
  const items = plannerProjects.map((p) => {
    const alreadyLinked = (state.projects || []).find((sp) => sp.plannerId === p.id) || null;
    const suggestion = alreadyLinked ? null : suggestProjectMatch(p, state.projects || []);
    return {
      plannerId: p.id,
      plannerName: p.name || "",
      plannerSite: p.site || "",
      plannerPkg: p.pkg || "",
      plannerType: p.type || "",
      alreadyLinkedProjectId: alreadyLinked ? alreadyLinked.id : null,
      alreadyLinkedProjectName: alreadyLinked ? alreadyLinked.name : null,
      suggestedProjectId: suggestion ? suggestion.id : null,
      suggestedProjectName: suggestion ? suggestion.name : null,
    };
  });
  return { items, usedFallback: Boolean(plannerData.projectsFallback) };
}

async function commitPlannerImport(items) {
  let created = 0;
  let linked = 0;
  let skipped = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.action === "skip") {
      skipped += 1;
      continue;
    }
    if (item.action === "link" && typeof item.projectId === "string") {
      const project = state.projects.find((p) => p.id === item.projectId);
      if (project) {
        project.plannerId = item.plannerId;
        linked += 1;
      }
      continue;
    }
    if (item.action === "create") {
      const name = (item.plannerSite && item.plannerSite.trim()) || item.plannerName || `Planner ${item.plannerId}`;
      const project = {
        id: `project-${randomUUID()}`,
        name,
        client: item.plannerName || "",
        location: item.plannerSite || "",
        owner: "Project Engineer Team",
        dueDate: "",
        showChecklistToClient: false,
        plannerId: item.plannerId,
        phases: createDefaultPhases(),
      };
      state.projects.unshift(project);
      created += 1;
    }
  }
  state.updatedAt = new Date().toISOString();
  await saveState();
  broadcast({ type: "state-updated", updatedAt: state.updatedAt });
  return { ok: true, created, linked, skipped };
}

async function reviewPlanRecord(auth, id, body) {
  const records = state.contractorRecords || [];
  const record = records.find((r) => r.id === id);
  if (!record) return { ok: false, status: 404, error: "Not found" };
  if (record.type !== "plan") return { ok: false, status: 400, error: "Only plan records can be approved" };

  const status = body?.status === "rejected" ? "rejected" : "approved";
  record.payload.approval = {
    status,
    reviewer: auth.code,
    reviewerRole: auth.role,
    reviewerName: String(body?.reviewerName || "").trim() || null,
    reviewedAt: new Date().toISOString(),
    note: String(body?.note || "").trim(),
  };
  await saveState();
  broadcast({ type: "plan-reviewed", id, status });
  notifyContractorOfReview(record).catch((error) => console.error("LINE notify (review) failed:", error.message));
  return { ok: true, record };
}

async function deleteContractorRecord(auth, id) {
  const records = state.contractorRecords || [];
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, status: 404, error: "Not found" };
  const record = records[idx];
  if (auth.role !== "admin" && record.ownerCode !== auth.code) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  records.splice(idx, 1);
  await saveState();
  return { ok: true };
}

function createDefaultPhases() {
  return [
    {
      id: "survey",
      name: "สำรวจหน้างาน",
      order: 1,
      status: "Not Started",
      progress: 0,
      checklist: ["สำรวจพื้นที่หน้างาน", "ตรวจสอบโหลดไฟฟ้า", "บันทึกรูปถ่าย", "ยืนยันผังตำแหน่ง"],
      updates: [],
    },
    {
      id: "pre-construction",
      name: "เตรียมก่อนก่อสร้าง",
      order: 2,
      status: "Not Started",
      progress: 0,
      checklist: ["ติดตามใบอนุญาตและการอนุมัติ", "ตรวจสอบความพร้อมวัสดุ", "ทบทวนแผนความปลอดภัย", "ประสานงานผู้รับเหมา"],
      updates: [],
    },
    {
      id: "construction",
      name: "ก่อสร้าง",
      order: 3,
      status: "Not Started",
      progress: 0,
      checklist: ["งานโยธา", "เดินสายไฟ", "ติดตั้งตู้ไฟ", "ติดตั้งเครื่องชาร์จ"],
      updates: [],
    },
    {
      id: "commissioning",
      name: "ทดสอบและส่งมอบ",
      order: 4,
      status: "Not Started",
      progress: 0,
      checklist: ["ทดสอบฉนวน", "ทดสอบการทำงาน", "ทดลองชาร์จ", "ลงนามส่งมอบงาน"],
      updates: [],
    },
  ];
}

async function createProject(body) {
  const name = String(body?.name || "").trim();
  if (!name) {
    throw new Error("Project name is required");
  }

  const project = {
    id: `project-${randomUUID()}`,
    name,
    client: String(body?.client || "").trim(),
    location: String(body?.location || "").trim(),
    owner: String(body?.owner || "Project Engineer Team").trim(),
    dueDate: body?.dueDate || "",
    showChecklistToClient: Boolean(body?.showChecklistToClient),
    phases: createDefaultPhases(),
  };

  state.projects.unshift(project);
  state.updatedAt = new Date().toISOString();
  await saveState();
  broadcast({ type: "state-updated", updatedAt: state.updatedAt });
  return { ok: true, state, project };
}

async function updateProject(projectId, body) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  if (typeof body?.name === "string") project.name = body.name.trim() || project.name;
  if (typeof body?.client === "string") project.client = body.client.trim();
  if (typeof body?.location === "string") project.location = body.location.trim();
  if (typeof body?.owner === "string") project.owner = body.owner.trim();
  if (typeof body?.dueDate === "string") project.dueDate = body.dueDate;
  if (typeof body?.showChecklistToClient === "boolean") project.showChecklistToClient = body.showChecklistToClient;

  state.updatedAt = new Date().toISOString();
  await saveState();
  broadcast({ type: "state-updated", updatedAt: state.updatedAt });
  return { ok: true, state, project };
}

async function saveDataUrl(dataUrl, filenameHint) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid image data");
  }

  const mime = match[1];
  const base64 = match[2];
  const extension = mimeToExtension(mime);
  const safeName = filenameHint.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "image";
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}_${safeName}${extension}`;
  const filePath = path.join(uploadsDir, fileName);
  await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  return { name: filenameHint, url: `/uploads/${fileName}` };
}

function mimeToExtension(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  return ".img";
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function broadcast(payload) {
  const message = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

async function serveStatic(res, requestPath) {
  const filePath = path.join(publicDir, path.basename(requestPath));
  return serveFile(res, filePath);
}

async function serveFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes.get(ext) || "application/octet-stream";
    return send(res, 200, data, contentType);
  } catch {
    return send(res, 404, Buffer.from("Not Found"), "text/plain; charset=utf-8");
  }
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRawBody(req);
  const text = raw.toString("utf8");
  return text ? JSON.parse(text) : {};
}

// ---- LINE Messaging API ----
function lineApiUrl(path) {
  return `${lineApiOverrideBase || lineApiBase}${path}`;
}

function verifyLineSignature(rawBody, signatureHeader) {
  if (!lineChannelSecret || !signatureHeader) return false;
  const expected = createHmac("sha256", lineChannelSecret).update(rawBody).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

async function lineApiCall(path, body) {
  if (!lineChannelAccessToken) return; // not configured — no-op
  try {
    await fetch(lineApiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lineChannelAccessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("LINE API call failed:", error.message);
  }
}

async function lineReply(replyToken, text) {
  return lineApiCall("/reply", { replyToken, messages: [{ type: "text", text }] });
}

async function linePush(userId, text) {
  return lineApiCall("/push", { to: userId, messages: [{ type: "text", text }] });
}

// A ผรม./ลูกค้า links their LINE account by adding the OA as a friend and
// sending their invite code as a plain chat message once. No LINE Login/
// OAuth needed — this is the whole "linking" mechanism.
async function handleLineEvent(event) {
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text") return;
  const userId = event.source && event.source.userId;
  if (!userId) return;
  const code = String(event.message.text || "").trim().toUpperCase();

  const invite = (state.inviteCodes || []).find(
    (c) => c.code.toUpperCase() === code && (c.role === "client" || c.role === "contractor")
  );
  if (!invite) {
    if (event.replyToken) {
      await lineReply(event.replyToken, "ไม่พบรหัสเชิญนี้ในระบบ กรุณาตรวจสอบแล้วพิมพ์รหัสของคุณอีกครั้ง (ตัวพิมพ์เล็ก/ใหญ่ไม่เป็นไร)");
    }
    return;
  }

  invite.lineUserId = userId;
  await saveState();

  if (event.replyToken) {
    const roleLabel = invite.role === "client" ? "ลูกค้า" : "ผรม.";
    await lineReply(
      event.replyToken,
      `เชื่อมบัญชี LINE กับรหัส "${invite.code}" (${roleLabel}) สำเร็จแล้ว ✅\nจะแจ้งเตือนอัตโนมัติเมื่อมีความเคลื่อนไหวที่เกี่ยวข้องกับคุณ`
    );
  }
}

async function notifyClientsOfNewPlan(payload) {
  const targets = (state.inviteCodes || []).filter(
    (c) => c.role === "client" && c.active && c.lineUserId && (!c.projectId || c.projectId === payload.projectId)
  );
  if (targets.length === 0) return;
  const text = [
    "🔔 มีแผนก่อนวันเริ่มงานใหม่รออนุมัติ",
    `โครงการ: ${payload.project || "-"}`,
    `ผู้ส่ง: ${payload.reporter || "-"}${payload.company ? " (" + payload.company + ")" : ""}`,
    `ขอบเขตงาน: ${String(payload.scope || "-").slice(0, 100)}`,
    "",
    "เข้าไปอนุมัติได้ที่หน้าพอร์ทัลลูกค้า",
  ].join("\n");
  await Promise.allSettled(targets.map((t) => linePush(t.lineUserId, text)));
}

async function notifyContractorOfReview(record) {
  const owner = (state.inviteCodes || []).find((c) => c.code === record.ownerCode);
  if (!owner || !owner.lineUserId) return;
  const approval = record.payload.approval || {};
  const label = approval.status === "approved" ? "✅ อนุมัติเข้างานแล้ว" : "❌ ไม่อนุมัติ";
  const text = [
    "🔔 ผลการพิจารณาแผนก่อนวันเริ่มงานของคุณ",
    `ขอบเขตงาน: ${String(record.payload.scope || "-").slice(0, 100)}`,
    `ผลการพิจารณา: ${label}`,
    approval.reviewerName ? `โดย: ${approval.reviewerName}` : "",
    approval.note ? `หมายเหตุ: ${approval.note}` : "",
  ].filter(Boolean).join("\n");
  await linePush(owner.lineUserId, text);
}

