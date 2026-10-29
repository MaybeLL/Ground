/** Browser code is a fixed application asset; contract prose only arrives as data. */
export const EDITOR_CLIENT = String.raw`
const fragment = location.hash.slice(1);
const credentialFragment = /^[a-f0-9]{64}$/.test(fragment);
const token = credentialFragment
  ? fragment
  : sessionStorage.getItem("grounds-session");
if (credentialFragment) {
  sessionStorage.setItem("grounds-session", token);
  history.replaceState(null, "", location.pathname + location.search);
}
let snapshot,
  draft,
  version,
  currentRequirementIssueKeys = [],
  knownIssueKeys = [],
  dirty = false,
  busy = false,
  active = null,
  uncertain = false;
const $ = (id) => document.getElementById(id),
  clone = (x) => JSON.parse(JSON.stringify(x));
const labels = {
  requirement: "需求",
  issues: "工作项",
  summary: "摘要",
  context: "背景",
  plan: "方案说明（非约束）",
  outcomes: "预期结果",
  decisions: "设计决策",
  open_questions: "待确认问题",
  statement: "说明",
  rationale: "理由",
  options: "备选方案",
  chosen_option: "选定方案",
  trade_offs: "取舍",
  consequences: "后果",
  goals: "目标",
  constraints: "约束",
  criteria: "验收标准",
  guidance: "参考指引",
  traces_to: "关联需求",
  type: "关联类型",
  ordinal: "序号（从 1 开始）",
  key: "标识",
  input: "契约内容",
  baselineExpression: "代码基线",
  target_branch: "目标分支",
  remote: "远端名称",
  ref: "完整分支引用",
  questions: "问题",
  assumptions: "假设",
  question: "问题",
  blocking: "是否阻塞",
  assumption: "暂定假设",
  description: "描述",
  benefits: "收益",
  costs: "代价",
  gain: "收益",
  sacrifice: "牺牲",
  reason: "原因",
  kind: "类型",
};
const samples = {
  issues: {
    key: "new-issue",
    input: { format: 1, summary: "", goals: [], constraints: [] },
    baselineExpression: "HEAD",
    questions: [],
    assumptions: [],
  },
  decisions: { statement: "", rationale: "" },
  open_questions: { question: "", blocking: false },
  questions: "",
  assumptions: "",
  options: { key: "option", description: "" },
  trade_offs: { gain: "", sacrifice: "", reason: "" },
  consequences: { kind: "benefit", statement: "" },
  goals: { statement: "", criteria: [] },
  constraints: { statement: "", criteria: [] },
  traces_to: { type: "outcome", ordinal: 1 },
};
const optional = {
  requirement: { context: "", decisions: [], open_questions: [] },
  input: {
    context: "",
    plan: "",
    constraints: [],
    target_branch: { remote: "", ref: "" },
  },
  decisions: {
    rationale: "",
    context: "",
    options: [],
    chosen_option: "",
    trade_offs: [],
    consequences: [],
  },
  options: { benefits: [], costs: [] },
  goals: { guidance: [], traces_to: [] },
  constraints: { rationale: "", guidance: [], traces_to: [] },
  open_questions: { assumption: "" },
};
function element(tag, text) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(text, run) {
  const b = element("button", text);
  b.type = "button";
  b.onclick = run;
  return b;
}
function links(type) {
  return (draft.issues || [])
    .filter(
      (i) =>
        currentRequirementIssueKeys.includes(i.key) ||
        !knownIssueKeys.includes(i.key),
    )
    .flatMap((i) => [...(i.input.goals || []), ...(i.input.constraints || [])])
    .flatMap((t) => t.traces_to || [])
    .filter((l) => l.type === type);
}
function mutateArray(array, key, index, target) {
  const type =
    key === "outcomes" ? "outcome" : key === "decisions" ? "decision" : null;
  const refs = type ? links(type) : [];
  if (target === null) {
    if (refs.some((l) => l.ordinal === index + 1)) {
      alert("此条目仍被工作项目标或约束引用，请先移除相关关联。");
      return;
    }
    array.splice(index, 1);
    refs.forEach((l) => {
      if (l.ordinal > index + 1) l.ordinal--;
    });
  } else {
    [array[index], array[target]] = [array[target], array[index]];
    refs.forEach((l) => {
      if (l.ordinal === index + 1) l.ordinal = target + 1;
      else if (l.ordinal === target + 1) l.ordinal = index + 1;
    });
  }
  changed();
  renderEditor();
}
function field(parent, key, value, set, kind = key, historical = false) {
  if (historical && kind === "traces_to") {
    parent.append(
      element("p", "历史版本关联（只读）：" + JSON.stringify(value)),
    );
    return;
  }
  if (
    kind === "traces_to" &&
    !Array.isArray(value) &&
    value &&
    typeof value === "object"
  ) {
    const label = element("label", "关联需求");
    const select = element("select");
    const current = value.type + ":" + value.ordinal;
    const options = [
      ...(draft.requirement.outcomes || []).map((text, i) => ({
        id: "outcome:" + (i + 1),
        text: "结果 " + (i + 1) + "：" + text,
      })),
      ...(draft.requirement.decisions || []).map((d, i) => ({
        id: "decision:" + (i + 1),
        text: "决策 " + (i + 1) + "：" + d.statement,
      })),
    ];
    if (!options.some((o) => o.id === current))
      options.unshift({
        id: current,
        text: "原关联 " + current + "（核对绑定版本）",
      });
    options.forEach((o) => {
      const option = element("option", o.text);
      option.value = o.id;
      select.append(option);
    });
    select.value = current;
    select.onchange = () => {
      const [type, ordinal] = select.value.split(":");
      set({ type, ordinal: Number(ordinal) });
      changed();
    };
    label.append(select);
    parent.append(label);
    return;
  }

  if (Array.isArray(value)) {
    const box = element("fieldset");
    box.append(element("legend", labels[key] || key));
    value.forEach((item, i) => {
      const row = element("div");
      row.className = "row";
      if (kind === "issues") {
        row.append(element("p", item.key + " · " + (item.input.summary || "未填写摘要")));
        if (!knownIssueKeys.includes(item.key)) field(row, "key", item.key, value => item.key = value);
      } else {
      field(
        row,
        String(i + 1),
        item,
        (v) => (value[i] = v),
        kind,
        historical ||
          (kind === "issues" &&
            knownIssueKeys.includes(item.key) &&
            !currentRequirementIssueKeys.includes(item.key)),
      );
      }
      row.append(button("删除", () => mutateArray(value, key, i, null)));
      if (i > 0)
        row.append(button("上移", () => mutateArray(value, key, i, i - 1)));
      if (i + 1 < value.length)
        row.append(button("下移", () => mutateArray(value, key, i, i + 1)));
      box.append(row);
    });
    box.append(
      button("添加", () => {
        const entry = clone(samples[kind] === undefined ? "" : samples[kind]);
        if (kind === "issues") { let n = 1; while (value.some(i => i.key === "new-issue-" + n)) n++; entry.key = "new-issue-" + n; }
        value.push(entry);
        changed();
        renderEditor();
      }),
    );
    parent.append(box);
    return;
  }
  if (value && typeof value === "object") {
    const box = element("fieldset");
    box.append(element("legend", labels[key] || key));
    Object.entries(value).forEach(([k, v]) => {
      if (
        k !== "format" &&
        !(
          kind === "issues" &&
          k === "key" &&
          knownIssueKeys.includes(value.key)
        )
      )
        field(box, k, v, (n) => (value[k] = n), k, historical);
    });
    Object.entries(optional[kind] || {}).forEach(([k, v]) => {
      if (!(k in value))
        box.append(
          button("添加" + (labels[k] || k), () => {
            value[k] = clone(v);
            changed();
            renderEditor();
          }),
        );
    });
    // Optional fields must be removable, not merely clearable: emptying a text
    // field stores "" and publication then rejects it, leaving the author stuck.
    // Only fields declared optional for this kind may be removed.
    Object.keys(optional[kind] || {}).forEach((k) => {
      if (k in value && k !== "format")
        box.append(
          button("删除" + (labels[k] || k), () => {
            delete value[k];
            changed();
            renderEditor();
          }),
        );
    });
    parent.append(box);
    return;
  }
  const label = element("label", labels[key] || key);
  const input = element(
    typeof value === "boolean"
      ? "input"
      : typeof value === "number"
        ? "input"
        : "textarea",
  );
  if (typeof value === "boolean") {
    input.type = "checkbox";
    input.checked = value;
  } else if (typeof value === "number") {
    input.type = "number";
    input.value = value;
  } else input.value = value === null ? "" : value;
  input.oninput = () => {
    set(
      typeof value === "boolean"
        ? input.checked
        : typeof value === "number"
          ? Number(input.value)
          : input.value,
    );
    changed();
  };
  label.append(input);
  parent.append(label);
}

function status(text) {
  $("status").textContent = text;
}
function changed() {
  dirty = true;
  status("编辑未保存");
  controls();
}
function controls() {
  for (const el of document.querySelectorAll("button,input,textarea,select"))
    el.disabled = busy;
  $("save").disabled = busy || !active || uncertain || !!snapshot?.conflicts.length;
  $("cancel").disabled = busy || !active;
  $("validate").disabled = busy || !snapshot;
  $("reload").disabled = busy || !snapshot;
  $("editor-actions").hidden = !active;
}
async function api(path, body) {
  const response = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error((data.error || "请求失败") + (data.details?.reason ? "：" + data.details.reason : ""));
    Object.assign(error, { status: response.status, ...data });
    throw error;
  }
  return data;
}
function metadata(data) {
  currentRequirementIssueKeys = data.currentRequirementIssueKeys;
  knownIssueKeys = data.draft.issues.map((i) => i.key);
}
function at(path) {
  return path.reduce((v, k) => v?.[k], draft);
}
function setAt(path, value) {
  const owner = at(path.slice(0, -1));
  owner[path.at(-1)] = value;
}
function safeFragment(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}
function showReading(focusId) {
  const scroll = window.scrollY;
  $("reading").replaceChildren(safeFragment(snapshot.reading.html));
  $("navigation").replaceChildren(safeFragment(snapshot.reading.navigation));
  $("source").textContent = JSON.stringify(snapshot.source, null, 2);
  for (const block of $("reading").querySelectorAll("[data-edit-path]")) {
    const path = JSON.parse(block.dataset.editPath),
      label =
        block.dataset.editLabel ||
        block.querySelector("h2,h3,h4")?.textContent ||
        "区块";
    const edit = button("编辑", () =>
      requestEdit({ id: block.id, path, label }),
    );
    edit.className = "edit-block";
    edit.setAttribute("aria-label", "编辑 " + label);
    block.prepend(edit);
  }
  $("info").replaceChildren();
  if (snapshot.externalIssues)
    $("info").append(
      element("h2", "外部工作项（只读）"),
      element("pre", snapshot.externalIssues),
    );
  if (snapshot.conflicts.length)
    $("info").append(
      element("p", "存在重基冲突，保存已禁用；请通过 CLI workspace resolve 处理后重新读取。"),
      element("pre", JSON.stringify(snapshot.conflicts, null, 2)),
    );
  window.dispatchEvent(new Event("grounds-render"));
  if (focusId) {
    const node = document.getElementById(focusId);
    if (node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
    window.scrollTo(0, scroll);
  }
  controls();
}
function adopt(data, focusId) {
  snapshot = data;
  draft = clone(data.draft);
  version = data.version;
  metadata(data);
  dirty = false;
  active = null;
  uncertain = false;
  $("conflict").hidden = true;
  showReading(focusId);
}
async function load() {
  if (busy) return;
  busy = true;
  controls();
  status("正在读取本地草稿…");
  try {
    const data = await api("draft");
    const id = active?.id;
    adopt(data, id);
    status("已读取本地草稿 · " + version.slice(0, 12));
  } finally {
    busy = false;
    controls();
  }
}
function renderEditor() {
  const block = document.getElementById(active.id);
  if (!block) return;
  block.replaceChildren(element("h3", "编辑：" + active.label));
  const path = active.path,
    key = path.at(-1),
    kind = typeof key === "number" ? path.at(-2) : key;
  const historical =
    path[0] === "issues" &&
    typeof path[1] === "number" &&
    knownIssueKeys.includes(draft.issues[path[1]].key) &&
    !currentRequirementIssueKeys.includes(draft.issues[path[1]].key);
  if (at(path) === undefined)
    setAt(
      path,
      clone(
        ["context", "plan"].includes(kind)
          ? ""
          : kind === "target_branch"
            ? { remote: "", ref: "" }
            : [],
      ),
    );
  field(
    block,
    typeof key === "number" ? String(key + 1) : key,
    at(path),
    (value) => setAt(path, value),
    kind,
    historical,
  );
  const parentKind = path.at(-2);
  if (typeof key === "string" && Object.hasOwn(optional[parentKind] || {}, key))
    block.append(
      button("移除此可选字段", () => {
        delete at(path.slice(0, -1))[key];
        changed();
        block.replaceChildren(
          element("h3", "编辑：" + active.label),
          element("p", "已暂存移除此可选字段；保存生效，取消恢复。"),
        );
      }),
    );
  block.append(element("p", "修改暂留在页面；使用上方保存或取消。"));
  controls();
}
function beginEdit(target) {
  active = target;
  draft = clone(snapshot.draft);
  dirty = false;
  uncertain = false;
  renderEditor();
  status("编辑中，尚未保存");
  document
    .getElementById(active.id)
    ?.querySelector("textarea,input,select,button")
    ?.focus();
}
function choice() {
  return new Promise((resolve) => {
    const dialog = $("switch-dialog");
    dialog.showModal();
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    for (const [id, value] of [
      ["switch-save", "save"],
      ["switch-discard", "discard"],
      ["switch-stay", "stay"],
    ])
      $(id).onclick = () => finish(value);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish("stay");
    };
    $("switch-save").disabled = uncertain || !!snapshot?.conflicts.length;
  });
}
async function guard() {
  if (busy) return false;
  if (!active) return true;
  if (!dirty && !uncertain) {
    cancel(false);
    return true;
  }
  const answer = await choice();
  if (answer === "stay") return false;
  if (answer === "save") return await save();
  cancel(false);
  return true;
}
async function requestEdit(target) {
  if (active?.id === target.id) return;
  if (await guard()) beginEdit(target);
}
function cancel(ask = true) {
  if (busy) return;
  if (
    ask &&
    dirty &&
    !confirm("取消会放弃此区块及相关联动的未保存修改，确定吗？")
  )
    return;
  const id = active?.id;
  draft = clone(snapshot.draft);
  active = null;
  dirty = false;
  uncertain = false;
  $("conflict").hidden = true;
  showReading(id);
  status("已取消；显示进入编辑前的已加载内容，尚未同步其他写入");
}
async function inspectCurrent() {
  try {
    const current = await api("draft");
    $("current").textContent = JSON.stringify(current.draft, null, 2);
    $("mine").textContent = JSON.stringify(draft, null, 2);
    $("conflict").hidden = false;
    return current;
  } catch (error) {
    $("mine").textContent = JSON.stringify(draft, null, 2);
    $("current").textContent =
      "无法读取；请保留本页输入，重启 contract render --workspace " +
      (snapshot?.source?.workspace || "NAME") +
      " 后重新打开会话并核对。";
    $("conflict").hidden = false;
    return null;
  }
}
async function save() {
  if (!active || busy || uncertain || snapshot?.conflicts.length) return false;
  const sent = clone(draft),
    baseVersion = version,
    focusId = active.id;
  busy = true;
  controls();
  status("保存中…");
  try {
    const data = await api("save", {
      draft: sent,
      expectedVersion: baseVersion,
    });
    adopt(data, focusId);
    status("已保存到本地 · " + data.version.slice(0, 12));
    return true;
  } catch (error) {
    if (error.status === 409) {
      uncertain = true;
      status("保存冲突：" + error.message + "；输入已保留，请通过 CLI 处理阻塞或对照后重新读取");
      await inspectCurrent();
      return false;
    }
    if (error.commit_state === "not_committed") {
      status("保存失败（未提交）：" + error.message + "；输入已保留");
      return false;
    }
    uncertain = true;
    status("保存结果未知，正在只读核实…");
    const current = await inspectCurrent();
    if (
      current &&
      current.version !== baseVersion &&
      JSON.stringify(current.draft) === JSON.stringify(sent)
    ) {
      adopt(current, focusId);
      status("已重新读取并确认保存成功");
      return true;
    }
    status(
      "保存结果未知；输入已保留，不会自动重试。请对照磁盘内容；服务停止时重启 contract render --workspace " +
        (snapshot?.source?.workspace || "NAME"),
    );
    return false;
  } finally {
    busy = false;
    controls();
  }
}
$("save").onclick = save;
$("cancel").onclick = () => cancel();
$("reload").onclick = async () => {
  if (await guard()) {
    try {
      await load();
    } catch (error) {
      status(
        "读取失败，保存服务不可用；输入仍保留。请重新启动 contract render --workspace " +
          (snapshot?.source?.workspace || "NAME") +
          "。" +
          error.message,
      );
    }
  }
};
$("validate").onclick = async () => {
  busy = true;
  controls();
  try {
    await api("validate", { draft });
    status("内容检查通过；不代表确认或发布，发布仍需检查来源和绑定");
  } catch (error) {
    status("检查失败：" + error.message);
  } finally {
    busy = false;
    controls();
  }
};
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    status("已复制我的修改");
  } catch {
    status("请从下方“我的修改”手动复制保留");
  }
};
window.addEventListener("beforeunload", (event) => {
  if (dirty || busy || uncertain) {
    event.preventDefault();
    event.returnValue = "";
  }
});
load().catch((error) =>
  status("读取失败：" + error.message + "。请重启契约渲染命令。"),
);
`;
