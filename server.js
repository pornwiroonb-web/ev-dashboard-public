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
const inviteSecret = process.env.EV_INVITE_SECRET || "ev-dashboard-dev-secret";
const authCookieName = "ev_dashboard_auth";
const authMaxAgeSeconds = 60 * 60 * 24 * 30;

const port = Number(process.env.PORT || 3000);

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
  updatedAt: new Date().toISOString(),
};

let state = await loadState();
const sseClients = new Set();

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(uploadsDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
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
      if (!isAuthenticated(req)) return unauthorized(res);
      return sendJson(res, 200, state);
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      if (!isAuthenticated(req)) return unauthorized(res);
      return handleSse(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/report") {
      if (!isAuthenticated(req)) return unauthorized(res);
      const body = await readJson(req);
      const updated = await applyReport(body);
      return sendJson(res, 200, updated);
    }

    if (req.method === "POST" && url.pathname === "/api/project") {
      if (!isAuthenticated(req)) return unauthorized(res);
      const body = await readJson(req);
      const created = await createProject(body);
      return sendJson(res, 201, created);
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/project/")) {
      if (!isAuthenticated(req)) return unauthorized(res);
      const projectId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const body = await readJson(req);
      const updated = await updateProject(projectId, body);
      return sendJson(res, 200, updated);
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
    await fs.writeFile(stateFile, JSON.stringify(defaultState, null, 2), "utf8");
    return structuredClone(defaultState);
  }
}

function normalizeState(input) {
  const normalized = input && typeof input === "object" ? input : {};
  normalized.inviteCodes = Array.isArray(normalized.inviteCodes) && normalized.inviteCodes.length
    ? normalized.inviteCodes
    : structuredClone(defaultState.inviteCodes);
  normalized.projects = Array.isArray(normalized.projects) ? normalized.projects : structuredClone(defaultState.projects);
  normalized.activity = Array.isArray(normalized.activity) ? normalized.activity : [];
  normalized.updatedAt = normalized.updatedAt || new Date().toISOString();
  return normalized;
}

async function saveState() {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function getAuthStatus(req) {
  const auth = verifyAuthCookie(getCookies(req)[authCookieName]);
  return {
    authenticated: Boolean(auth),
    inviteCode: auth?.code || null,
  };
}

function isAuthenticated(req) {
  return Boolean(verifyAuthCookie(getCookies(req)[authCookieName]));
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

function buildAuthCookie(code) {
  const payload = Buffer.from(
    JSON.stringify({
      code,
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

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": buildAuthCookie(code),
  });
  res.end(JSON.stringify({ ok: true, inviteCode: code }));
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
