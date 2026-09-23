const state = {
  projects: [],
  activeProjectId: localStorage.getItem("ev-dashboard.activeProjectId") || "",
  activeProject: null,
  files: [],
  updatedAt: null,
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

const elements = {
  authScreen: document.getElementById("auth-screen"),
  dashboardShell: document.getElementById("dashboard-shell"),
  authForm: document.getElementById("auth-form"),
  inviteCodeInput: document.getElementById("invite-code-input"),
  authMessage: document.getElementById("auth-message"),
  projectSelect: document.getElementById("project-select"),
  projectName: document.getElementById("project-name"),
  overallProgress: document.getElementById("overall-progress"),
  updatedAt: document.getElementById("updated-at"),
  clientName: document.getElementById("client-name"),
  locationName: document.getElementById("location-name"),
  ownerName: document.getElementById("owner-name"),
  dueDate: document.getElementById("due-date"),
  phaseCards: document.getElementById("phase-cards"),
  phaseSelect: document.getElementById("phase-select"),
  reportForm: document.getElementById("report-form"),
  authorInput: document.getElementById("author-input"),
  statusSelect: document.getElementById("status-select"),
  progressInput: document.getElementById("progress-input"),
  progressValue: document.getElementById("progress-value"),
  noteInput: document.getElementById("note-input"),
  imagesInput: document.getElementById("images-input"),
  imagePreview: document.getElementById("image-preview"),
  resetForm: document.getElementById("reset-form"),
  formMessage: document.getElementById("form-message"),
  activityFeed: document.getElementById("activity-feed"),
  livePill: document.getElementById("live-pill"),
  openNewProject: document.getElementById("open-new-project"),
  newProjectForm: document.getElementById("new-project-form"),
  newProjectName: document.getElementById("new-project-name"),
  newProjectClient: document.getElementById("new-project-client"),
  newProjectDue: document.getElementById("new-project-due"),
  newProjectLocation: document.getElementById("new-project-location"),
  newProjectOwner: document.getElementById("new-project-owner"),
  newProjectMessage: document.getElementById("new-project-message"),
  cancelNewProject: document.getElementById("cancel-new-project"),
  editProjectForm: document.getElementById("edit-project-form"),
  editProjectName: document.getElementById("edit-project-name"),
  editProjectClient: document.getElementById("edit-project-client"),
  editProjectDue: document.getElementById("edit-project-due"),
  editProjectLocation: document.getElementById("edit-project-location"),
  editProjectOwner: document.getElementById("edit-project-owner"),
  editProjectShowChecklist: document.getElementById("edit-project-show-checklist"),
  inviteCodeForm: document.getElementById("invite-code-form"),
  inviteCodeRole: document.getElementById("invite-code-role"),
  inviteCodeProject: document.getElementById("invite-code-project"),
  inviteCodeLabel: document.getElementById("invite-code-label"),
  inviteCodeCustom: document.getElementById("invite-code-custom"),
  inviteCodeMessage: document.getElementById("invite-code-message"),
  inviteCodeList: document.getElementById("invite-code-list"),
  editProjectMessage: document.getElementById("edit-project-message"),
  logoutButton: document.getElementById("logout-button"),
};

const fullDateFormatter = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
});

const dateOnlyFormatter = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
});

elements.progressInput.addEventListener("input", () => {
  elements.progressValue.textContent = `${elements.progressInput.value}%`;
});

elements.imagesInput.addEventListener("change", handleFileSelection);
elements.resetForm.addEventListener("click", resetTaskForm);
elements.reportForm.addEventListener("submit", submitReport);
elements.projectSelect.addEventListener("change", handleProjectSelection);
elements.openNewProject.addEventListener("click", () => toggleSection("new"));
elements.cancelNewProject.addEventListener("click", () => toggleSection("none"));
elements.newProjectForm.addEventListener("submit", createProject);
elements.editProjectForm.addEventListener("submit", saveProjectEdits);
elements.inviteCodeForm.addEventListener("submit", createInviteCodeSubmit);
elements.authForm.addEventListener("submit", submitInviteCode);
elements.logoutButton.addEventListener("click", logout);

let eventSource = null;

await bootstrap();

async function bootstrap() {
  const auth = await getAuthStatus();
  if (auth.authenticated && auth.role === "contractor") {
    window.location.replace("/contractor.html");
    return;
  }
  if (auth.authenticated && auth.role === "client") {
    window.location.replace("/client.html");
    return;
  }
  if (auth.authenticated) {
    showDashboard();
    await loadState();
    connectLiveUpdates();
    loadInviteCodes();
    return;
  }

  showAuth();
}

async function getAuthStatus() {
  const response = await fetch("/api/auth/status");
  return response.json();
}

function showAuth() {
  elements.authScreen.classList.remove("hidden");
  elements.dashboardShell.classList.add("hidden");
}

function showDashboard() {
  elements.authScreen.classList.add("hidden");
  elements.dashboardShell.classList.remove("hidden");
}

async function loadState() {
  const response = await fetch("/api/state");
  if (response.status === 401 || response.status === 403) {
    await logout(false);
    showAuth();
    elements.authMessage.textContent = "เซสชันหมดอายุหรือไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบอีกครั้ง";
    return;
  }
  const data = await response.json();
  state.projects = data.projects || [];
  state.updatedAt = data.updatedAt || null;

  if (!state.projects.length) {
    state.activeProject = null;
    render();
    return;
  }

  const remembered = state.projects.find((project) => project.id === state.activeProjectId);
  state.activeProject = remembered || state.projects[0];
  state.activeProjectId = state.activeProject.id;
  localStorage.setItem("ev-dashboard.activeProjectId", state.activeProjectId);

  render();
}

function connectLiveUpdates() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("ready", () => {
    elements.livePill.textContent = "เชื่อมต่อสดแล้ว";
  });

  eventSource.addEventListener("update", async () => {
    elements.livePill.textContent = "กำลังอัปเดต...";
    await loadState();
    elements.livePill.textContent = "เชื่อมต่อสดแล้ว";
  });

  eventSource.onerror = () => {
    elements.livePill.textContent = "กำลังเชื่อมต่อใหม่...";
  };
}

async function submitInviteCode(event) {
  event.preventDefault();
  const code = elements.inviteCodeInput.value.trim();
  elements.authMessage.textContent = "";

  if (!code) {
    elements.authMessage.textContent = "กรุณากรอกรหัสเชิญ";
    return;
  }

  elements.authMessage.textContent = "กำลังตรวจสอบรหัสเชิญ...";

  try {
    const response = await fetch("/api/auth/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "รหัสเชิญไม่ถูกต้อง");
    }

    const data = await response.json().catch(() => ({}));
    elements.inviteCodeInput.value = "";
    elements.authMessage.textContent = "";

    if (data.role === "contractor") {
      window.location.href = "/contractor.html";
      return;
    }
    if (data.role === "client") {
      window.location.href = "/client.html";
      return;
    }

    showDashboard();
    await loadState();
    connectLiveUpdates();
  } catch (error) {
    elements.authMessage.textContent = error?.message || "เข้าสู่ระบบไม่สำเร็จ";
  }
}

async function logout(updateUi = true) {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  state.projects = [];
  state.activeProject = null;
  state.files = [];
  state.updatedAt = null;

  if (updateUi) {
    showAuth();
  }
}

function render() {
  renderProjectSelector();
  renderActiveProject();
  renderTaskBoard();
  renderFeed();
  populateProjectEditor();
}

function renderProjectSelector() {
  elements.projectSelect.innerHTML = state.projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join("");
  elements.projectSelect.value = state.activeProjectId || state.projects[0]?.id || "";
}

function renderActiveProject() {
  const project = state.activeProject;
  if (!project) {
    elements.projectName.textContent = "-";
    elements.overallProgress.textContent = "0%";
    elements.updatedAt.textContent = "-";
    elements.clientName.textContent = "-";
    elements.locationName.textContent = "-";
    elements.ownerName.textContent = "-";
    elements.dueDate.textContent = "-";
    return;
  }

  elements.projectName.textContent = project.name;
  elements.clientName.textContent = project.client || "-";
  elements.locationName.textContent = project.location || "-";
  elements.ownerName.textContent = project.owner || "-";
  elements.dueDate.textContent = project.dueDate ? dateOnlyFormatter.format(new Date(project.dueDate)) : "-";
  elements.updatedAt.textContent = state.updatedAt ? fullDateFormatter.format(new Date(state.updatedAt)) : "-";

  const average =
    project.phases.reduce((sum, phase) => sum + (Number(phase.progress) || 0), 0) / project.phases.length;
  elements.overallProgress.textContent = `${Math.round(average)}%`;
}

function renderTaskBoard() {
  const project = state.activeProject;
  if (!project) {
    elements.phaseCards.innerHTML = `<div class="feed-item">ยังไม่มีโครงการ</div>`;
    elements.phaseSelect.innerHTML = "";
    return;
  }

  elements.phaseSelect.innerHTML = project.phases
    .map((phase) => `<option value="${phase.id}">${phase.order}. ${phase.name}</option>`)
    .join("");

  elements.phaseCards.innerHTML = project.phases
    .map(
      (phase) => `
        <article class="phase-card ${statusClass(phase.status)}">
          <div class="phase-top">
            <div>
              <p class="phase-name">${phase.order}. ${phase.name}</p>
              <div class="phase-meta">${escapeHtml(statusLabel(phase.status))}</div>
            </div>
            <span class="badge ${statusBadge(phase.status)}">${phase.progress}%</span>
          </div>
          <div class="bar"><span style="width:${phase.progress}%"></span></div>
          <ul class="checklist">
            ${phase.checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
          ${
            phase.updates?.[0]
              ? `<div class="status-line"><span>ล่าสุด:</span><span>${escapeHtml(phase.updates[0].note || "ไม่มีหมายเหตุ")}</span></div>`
              : ""
          }
        </article>
      `,
    )
    .join("");

  if (!elements.phaseSelect.value) {
    elements.phaseSelect.value = project.phases[0]?.id || "";
  }
}

function renderFeed() {
  const project = state.activeProject;
  if (!project) {
    elements.activityFeed.innerHTML = `<div class="feed-item">ยังไม่มีข้อมูล</div>`;
    return;
  }

  const feedItems = project.phases.flatMap((phase) =>
    (phase.updates || []).map((update) => ({
      ...update,
      phaseName: phase.name,
      phaseId: phase.id,
      projectName: project.name,
    })),
  );

  elements.activityFeed.innerHTML = feedItems.length
    ? feedItems
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 12)
        .map(renderFeedItem)
        .join("")
    : `<div class="feed-item">ยังไม่มีความคืบหน้า</div>`;
}

function populateProjectEditor() {
  const project = state.activeProject;
  if (!project) {
    return;
  }

  elements.editProjectName.value = project.name || "";
  elements.editProjectClient.value = project.client || "";
  elements.editProjectDue.value = project.dueDate || "";
  elements.editProjectLocation.value = project.location || "";
  elements.editProjectOwner.value = project.owner || "";
  elements.editProjectShowChecklist.checked = Boolean(project.showChecklistToClient);
}

function renderFeedItem(item) {
  const images = item.images?.length
    ? `<div class="feed-images">${item.images
        .map(
          (image) =>
            `<a href="${image.url}" target="_blank" rel="noreferrer"><img src="${image.url}" alt="${escapeHtml(image.name)}" /></a>`,
        )
        .join("")}</div>`
    : "";

  return `
    <article class="feed-item">
      <div class="feed-top">
        <div>
          <p class="feed-title">${escapeHtml(item.phaseName)}</p>
          <p class="feed-sub">${escapeHtml(item.author)} · ${formatDate(item.createdAt)} · ${escapeHtml(
            statusLabel(item.status),
          )}</p>
        </div>
        <div class="badge ${statusBadge(item.status)}">${item.progress}%</div>
      </div>
      <p class="feed-note">${escapeHtml(item.note || "ไม่มีหมายเหตุ")}</p>
      ${images}
    </article>
  `;
}

function statusClass(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("done")) return "done";
  if (value.includes("block")) return "blocked";
  if (value.includes("progress")) return "in-progress";
  return "not-started";
}

function statusBadge(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("done")) return "done";
  if (value.includes("block")) return "blocked";
  if (value.includes("progress")) return "progress";
  return "todo";
}

function statusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("done")) return "เสร็จแล้ว";
  if (value.includes("block")) return "ติดขัด";
  if (value.includes("progress")) return "กำลังดำเนินการ";
  return "ยังไม่เริ่ม";
}

function formatDate(value) {
  return fullDateFormatter.format(new Date(value));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toggleSection(which) {
  elements.newProjectForm.classList.toggle("hidden", which !== "new");
  elements.newProjectMessage.textContent = "";
}

async function handleProjectSelection() {
  state.activeProjectId = elements.projectSelect.value;
  localStorage.setItem("ev-dashboard.activeProjectId", state.activeProjectId);
  state.activeProject = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0] || null;
  render();
}

async function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);
  state.files = [];
  elements.imagePreview.innerHTML = "";

  if (!files.length) return;

  const previewItems = await Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              name: file.name,
              dataUrl: reader.result,
            });
          };
          reader.readAsDataURL(file);
        }),
    ),
  );

  state.files = previewItems;
  elements.imagePreview.innerHTML = previewItems
    .map((item) => `<img src="${item.dataUrl}" alt="${escapeHtml(item.name)}" title="${escapeHtml(item.name)}" />`)
    .join("");
}

async function submitReport(event) {
  event.preventDefault();
  if (!state.activeProject) return;

  const payload = {
    projectId: state.activeProject.id,
    phaseId: elements.phaseSelect.value,
    author: elements.authorInput.value.trim() || "Operator",
    status: elements.statusSelect.value,
    progress: Number(elements.progressInput.value),
    note: elements.noteInput.value.trim(),
    images: state.files,
  };

  setFormBusy(elements.reportForm, true, "กำลังบันทึกข้อมูล...");

  try {
    const response = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error("บันทึกไม่สำเร็จ");
    }

    resetTaskForm();
    elements.authorInput.value = payload.author;
    elements.statusSelect.value = payload.status;
    elements.formMessage.textContent = "บันทึกรายงานเรียบร้อย และอัปเดตขึ้นแดชบอร์ดแบบเรียลไทม์แล้ว";
    await loadState();
  } catch (error) {
    elements.formMessage.textContent = error?.message || "เกิดข้อผิดพลาด";
  } finally {
    setFormBusy(elements.reportForm, false);
  }
}

async function createProject(event) {
  event.preventDefault();
  elements.newProjectMessage.textContent = "";
  const name = elements.newProjectName.value.trim();
  if (!name) {
    elements.newProjectMessage.textContent = "กรุณาใส่ชื่อโครงการ";
    return;
  }

  const payload = {
    name,
    client: elements.newProjectClient.value.trim(),
    dueDate: elements.newProjectDue.value,
    location: elements.newProjectLocation.value.trim(),
    owner: elements.newProjectOwner.value.trim() || "Project Engineer Team",
  };

  setFormBusy(elements.newProjectForm, true);

  try {
    const response = await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("สร้างโครงการไม่สำเร็จ");

    toggleSection("none");
    elements.newProjectForm.reset();
    elements.newProjectMessage.textContent = "สร้างโครงการใหม่เรียบร้อย";
    await loadState();
  } catch (error) {
    elements.newProjectMessage.textContent = error?.message || "เกิดข้อผิดพลาด";
  } finally {
    setFormBusy(elements.newProjectForm, false);
  }
}

async function saveProjectEdits(event) {
  event.preventDefault();
  if (!state.activeProject) return;

  elements.editProjectMessage.textContent = "";
  const payload = {
    name: elements.editProjectName.value.trim(),
    client: elements.editProjectClient.value.trim(),
    dueDate: elements.editProjectDue.value,
    location: elements.editProjectLocation.value.trim(),
    owner: elements.editProjectOwner.value.trim(),
    showChecklistToClient: elements.editProjectShowChecklist.checked,
  };

  setFormBusy(elements.editProjectForm, true);

  try {
    const response = await fetch(`/api/project/${encodeURIComponent(state.activeProject.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("บันทึกการแก้ไขไม่สำเร็จ");

    toggleSection("none");
    elements.editProjectMessage.textContent = "บันทึกการแก้ไขเรียบร้อย";
    await loadState();
  } catch (error) {
    elements.editProjectMessage.textContent = error?.message || "เกิดข้อผิดพลาด";
  } finally {
    setFormBusy(elements.editProjectForm, false);
  }
}

function resetTaskForm() {
  elements.reportForm.reset();
  elements.authorInput.value = "Operator";
  elements.statusSelect.value = "In Progress";
  elements.progressInput.value = "0";
  elements.progressValue.textContent = "0%";
  elements.imagePreview.innerHTML = "";
  state.files = [];
  elements.formMessage.textContent = "";
}

function setFormBusy(form, isBusy, message = "") {
  form.querySelectorAll("button, input, select, textarea").forEach((el) => {
    el.disabled = isBusy;
  });
  if (message && form === elements.reportForm) {
    elements.formMessage.textContent = message;
  }
}

/* ================= INVITE CODE MANAGER (ผรม. / ลูกค้า) ================= */
let inviteCodesCache = [];
let inviteProjectsCache = [];

async function loadInviteCodes() {
  try {
    const response = await fetch("/api/admin/invite-codes");
    if (!response.ok) return;
    const data = await response.json();
    inviteCodesCache = data.inviteCodes || [];
    inviteProjectsCache = data.projects || [];
    renderInviteProjectOptions();
    renderInviteCodeList();
  } catch (error) {
    // Silent: this card is a convenience, not core dashboard functionality.
  }
}

function renderInviteProjectOptions() {
  const current = elements.inviteCodeProject.value;
  elements.inviteCodeProject.innerHTML = inviteProjectsCache
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
  if (inviteProjectsCache.some((p) => p.id === current)) {
    elements.inviteCodeProject.value = current;
  }
}

function renderInviteCodeList() {
  const rows = inviteCodesCache.filter((c) => c.role === "contractor" || c.role === "client");
  if (rows.length === 0) {
    elements.inviteCodeList.innerHTML = `<p style="color:rgba(255,255,255,.55);font-size:13.5px;">ยังไม่มีรหัส ผรม./ลูกค้า ที่สร้างไว้</p>`;
    return;
  }
  elements.inviteCodeList.innerHTML = rows
    .map((c) => {
      const project = inviteProjectsCache.find((p) => p.id === c.projectId);
      const scopeLabel = c.projectId
        ? (project ? escapeHtml(project.name) : `<span style="color:#ff7f9d;">⚠ โครงการนี้ถูกลบ/ไม่พบแล้ว</span>`)
        : `<span style="color:rgba(255,255,255,.5);">ไม่ผูกโครงการ (เห็นทุกโครงการ)</span>`;
      const roleLabel = c.role === "client" ? "ลูกค้า" : "ผรม.";
      return `
        <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="min-width:0;">
            <div style="font-weight:700;font-family:'Space Grotesk',sans-serif;font-size:14px;">
              ${escapeHtml(c.code)}
              <span style="font-weight:500;font-size:11.5px;color:rgba(255,255,255,.5);margin-left:6px;">${roleLabel}${c.active ? "" : " · ปิดใช้งาน"}</span>
            </div>
            <div style="font-size:12.5px;color:rgba(255,255,255,.6);margin-top:2px;">${escapeHtml(c.label || "")}</div>
            <div style="font-size:12px;margin-top:2px;">${scopeLabel}</div>
          </div>
          <div style="display:flex;gap:8px;flex:none;">
            <button type="button" class="ghost" data-toggle-code="${escapeHtml(c.code)}" data-active="${c.active}">${c.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
            <button type="button" class="ghost" data-delete-code="${escapeHtml(c.code)}" style="color:#ff7f9d;">ลบ</button>
          </div>
        </div>`;
    })
    .join("");
}

elements.inviteCodeList.addEventListener("click", async (event) => {
  const toggleBtn = event.target.closest("[data-toggle-code]");
  const deleteBtn = event.target.closest("[data-delete-code]");
  if (toggleBtn) {
    const code = toggleBtn.getAttribute("data-toggle-code");
    const nextActive = toggleBtn.getAttribute("data-active") !== "true";
    toggleBtn.disabled = true;
    try {
      await fetch(`/api/admin/invite-codes/${encodeURIComponent(code)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      await loadInviteCodes();
    } catch (error) {
      toggleBtn.disabled = false;
    }
    return;
  }
  if (deleteBtn) {
    const code = deleteBtn.getAttribute("data-delete-code");
    if (!window.confirm(`ลบรหัส "${code}" ใช่ไหม? ผรม./ลูกค้าที่ถือรหัสนี้จะเข้าระบบไม่ได้อีก`)) return;
    deleteBtn.disabled = true;
    try {
      const response = await fetch(`/api/admin/invite-codes/${encodeURIComponent(code)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        window.alert(data.error || "ลบไม่สำเร็จ");
      }
      await loadInviteCodes();
    } catch (error) {
      deleteBtn.disabled = false;
    }
  }
});

async function createInviteCodeSubmit(event) {
  event.preventDefault();
  elements.inviteCodeMessage.textContent = "";
  const payload = {
    role: elements.inviteCodeRole.value,
    projectId: elements.inviteCodeProject.value || null,
    label: elements.inviteCodeLabel.value.trim(),
    code: elements.inviteCodeCustom.value.trim(),
  };

  setFormBusy(elements.inviteCodeForm, true);
  try {
    const response = await fetch("/api/admin/invite-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "สร้างรหัสไม่สำเร็จ");
    elements.inviteCodeMessage.textContent = `สร้างรหัส "${data.inviteCode.code}" เรียบร้อย`;
    elements.inviteCodeLabel.value = "";
    elements.inviteCodeCustom.value = "";
    await loadInviteCodes();
  } catch (error) {
    elements.inviteCodeMessage.textContent = error?.message || "เกิดข้อผิดพลาด";
  } finally {
    setFormBusy(elements.inviteCodeForm, false);
  }
}
