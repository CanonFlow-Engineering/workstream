const screens = ["project", "board", "evidence", "approval"];
const statuses = [
  "ready",
  "claimed",
  "testing",
  "awaiting-gate",
  "accepted",
  "rejected",
  "stopped",
  "blocked",
];

let state = { projects: [], work: [] };
let selectedWorkId = "";

const $ = (selector) => document.querySelector(selector);

const element = (name, text = "", className = "") => {
  const node = document.createElement(name);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};

const notice = (message, kind = "") => {
  const node = $("#notice");
  node.textContent = message;
  node.className = `notice ${kind}`.trim();
};

const formData = (form) => Object.fromEntries(new FormData(form).entries());

const request = async (path, body) => {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    method: body === undefined ? "GET" : "POST",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "The local server rejected the request.");
  return result;
};

const showScreen = (screen) => {
  for (const name of screens) {
    $(`#${name}-screen`).hidden = name !== screen;
    document
      .querySelector(`[data-screen="${name}"]`)
      .setAttribute("aria-current", name === screen ? "page" : "false");
  }
  if (screen === "evidence") renderDetail();
};

const clear = (node) => node.replaceChildren();

const addEmpty = (container, message) =>
  container.append(element("p", message, "empty"));

const renderProjects = () => {
  const container = $("#project-list");
  clear(container);
  if (state.projects.length === 0)
    addEmpty(container, "No local projects yet.");
  for (const project of state.projects) {
    const card = element("article", "", "card");
    card.append(element("h3", project.name));
    card.append(element("p", project.description));
    card.append(element("code", project.id));
    container.append(card);
  }
  const select = $("#work-project");
  const prior = select.value;
  clear(select);
  for (const project of state.projects) {
    const option = element("option", project.name);
    option.value = project.id;
    select.append(option);
  }
  select.value = prior || state.projects[0]?.id || "";
};

const selectWork = (id) => {
  selectedWorkId = id;
  $("#detail-work").value = id;
  showScreen("evidence");
};

const renderBoard = () => {
  const board = $("#work-board");
  clear(board);
  for (const status of statuses) {
    const column = element("section", "", "work-column");
    column.append(element("h3", status));
    const items = state.work.filter((work) => work.status === status);
    if (items.length === 0) addEmpty(column, "No work.");
    for (const work of items) {
      const card = element("article", "", "work-card");
      card.append(element("strong", work.title));
      card.append(element("p", `${work.id} · ${work.projectId}`));
      card.append(
        element(
          "p",
          work.claimant ? `Claimed by ${work.claimant}` : "Unclaimed",
        ),
      );
      const detail = element("button", "Evidence");
      detail.type = "button";
      detail.addEventListener("click", () => selectWork(work.id));
      card.append(detail);
      if (work.status === "ready") {
        const claim = element("button", "Claim as architect");
        claim.type = "button";
        claim.addEventListener("click", () =>
          mutate(`/api/work/${encodeURIComponent(work.id)}/claim`, {
            actor: "architect-agent:builder",
          }),
        );
        card.append(claim);
      }
      column.append(card);
    }
    board.append(column);
  }
};

const renderQueue = () => {
  const queue = $("#approval-queue");
  clear(queue);
  const awaiting = state.work.filter((work) => work.status === "awaiting-gate");
  if (awaiting.length === 0)
    addEmpty(queue, "No work awaits a human decision.");
  for (const work of awaiting) {
    const card = element("article", "", "card");
    card.append(element("h3", work.title));
    card.append(
      element("p", `${work.id} is ready for a local human decision.`),
    );
    for (const decision of ["accept", "reject", "stop"]) {
      const button = element("button", decision);
      button.type = "button";
      button.addEventListener("click", () =>
        mutate(`/api/work/${encodeURIComponent(work.id)}/gate`, {
          actor: "human:owner",
          decision,
        }),
      );
      card.append(button);
    }
    queue.append(card);
  }
};

const renderWorkPicker = () => {
  const picker = $("#detail-work");
  const previous = selectedWorkId || picker.value;
  clear(picker);
  for (const work of state.work) {
    const option = element("option", `${work.id} — ${work.title}`);
    option.value = work.id;
    picker.append(option);
  }
  selectedWorkId = state.work.some((work) => work.id === previous)
    ? previous
    : state.work[0]?.id || "";
  picker.value = selectedWorkId;
};

const list = (items, render) => {
  const node = element("ul", "", "list");
  for (const item of items) node.append(render(item));
  return node;
};

const renderDetail = async () => {
  renderWorkPicker();
  const container = $("#work-detail");
  clear(container);
  if (!selectedWorkId) {
    addEmpty(container, "Select or create work to inspect evidence.");
    return;
  }
  try {
    const detail = await request(
      `/api/work/${encodeURIComponent(selectedWorkId)}`,
    );
    const summary = element("article", "", "detail-panel");
    summary.append(element("h3", detail.work.title));
    summary.append(element("p", `Status: ${detail.work.status}`));
    summary.append(
      element(
        "p",
        detail.work.claimant
          ? `Claimant: ${detail.work.claimant}`
          : "No architect claimant.",
      ),
    );
    const evidence = element("article", "", "detail-panel");
    evidence.append(element("h3", "Evidence objects"));
    evidence.append(
      detail.evidence.length
        ? list(detail.evidence, (item) => {
            const entry = element("li");
            entry.append(`${item.kind}: `);
            const hash = element("code", item.sha256);
            entry.append(hash, ` (${item.bytes} bytes)`);
            return entry;
          })
        : element("p", "No attached evidence.", "empty"),
    );
    const activity = element("article", "", "detail-panel");
    activity.append(element("h3", "Append-only activity"));
    activity.append(
      detail.activity.length
        ? list(detail.activity, (event) =>
            element(
              "li",
              `${event.sequence}. ${event.type} by ${event.actor.kind}:${event.actor.id}`,
            ),
          )
        : element("p", "No activity.", "empty"),
    );
    container.append(summary, evidence, activity);
  } catch (error) {
    notice(error.message, "error");
  }
};

const render = () => {
  renderProjects();
  renderBoard();
  renderQueue();
  renderWorkPicker();
};

const refresh = async () => {
  try {
    state = await request("/api/state");
    render();
    notice(
      state.initialized
        ? "Local ledger loaded. No GitHub synchronization is configured."
        : "Initialize this local ledger before starting a controlled work loop.",
      "success",
    );
  } catch (error) {
    notice(error.message, "error");
  }
};

const mutate = async (path, body) => {
  try {
    await request(path, body);
    await refresh();
    await renderDetail();
  } catch (error) {
    notice(error.message, "error");
  }
};

$("#initialize").addEventListener("click", () =>
  mutate("/api/initialize", { actor: "human:owner" }),
);
$("#refresh").addEventListener("click", refresh);
$("#detail-work").addEventListener("change", (event) => {
  selectedWorkId = event.target.value;
  renderDetail();
});

for (const button of document.querySelectorAll("[data-screen]")) {
  button.addEventListener("click", () => showScreen(button.dataset.screen));
}

$("#project-form").addEventListener("submit", (event) => {
  event.preventDefault();
  mutate("/api/projects", formData(event.currentTarget));
  event.currentTarget.reset();
});
$("#work-form").addEventListener("submit", (event) => {
  event.preventDefault();
  mutate("/api/work", formData(event.currentTarget));
  event.currentTarget.reset();
});
$("#claim-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedWorkId)
    mutate(
      `/api/work/${encodeURIComponent(selectedWorkId)}/claim`,
      formData(event.currentTarget),
    );
});
$("#evidence-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedWorkId)
    mutate(
      `/api/work/${encodeURIComponent(selectedWorkId)}/evidence`,
      formData(event.currentTarget),
    );
});
$("#handoff-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedWorkId)
    mutate(
      `/api/work/${encodeURIComponent(selectedWorkId)}/handoff`,
      formData(event.currentTarget),
    );
});
$("#test-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedWorkId)
    mutate(
      `/api/work/${encodeURIComponent(selectedWorkId)}/test`,
      formData(event.currentTarget),
    );
});
$("#judge-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (selectedWorkId)
    mutate(
      `/api/work/${encodeURIComponent(selectedWorkId)}/judge`,
      formData(event.currentTarget),
    );
});

refresh();
