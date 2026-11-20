(function () {
  "use strict";

  // 用页面 URL 解析出绝对本地路径：blob worker 内相对路径不可靠，绝对路径在 http/file 下都正确
  const PYODIDE_LOCAL = new URL("pyodide/", document.baseURI).href;
  const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
  let pyodideIndex = PYODIDE_LOCAL; // 优先本地运行时，加载失败自动回退 CDN
  const PY_LOAD_TIMEOUT = 90000;  // 仅首载 Pyodide（10MB+ wasm）的超时
  const PY_RUN_TIMEOUT = 15000;   // 代码执行超时，与加载时间彻底分离
  const PER_PAGE = 20;
  const KEY_CODES = "codearena.pycodes.v2";
  const KEY_SOLVED = "codearena.pysolved.v2";
  const KEY_CURRENT = "codearena.pycurrent.v2";
  const KEY_QUIZ_ANS = "codearena.quizanswers.v2";
  const KEY_QUIZ_RESULT = "codearena.quizresult.v2";
  const KEY_MODE = "codearena.mode.v1";
  const KEY_QUIZ_CURRENT = "codearena.quizcurrent.v2";
  const KEY_QUIZ_PAPER = "codearena.quizpaper.v1";

  const $ = (id) => document.getElementById(id);
  const elements = {
    listCount: $("listCount"),
    typeTabs: $("typeTabs"),
    searchInput: $("searchInput"),
    difficultyFilters: $("difficultyFilters"),
    companyFilters: $("companyFilters"),
    paperArea: $("paperArea"),
    paperCompanyFilters: $("paperCompanyFilters"),
    paperFilters: $("paperFilters"),
    itemList: $("itemList"),
    listPager: $("listPager"),
    codeContent: $("codeContent"),
    quizContent: $("quizContent"),
    codePanel: $("codePanel"),
    quizPanel: $("quizPanel"),
    problemHeader: $("problemHeader"),
    problemBody: $("problemBody"),
    quizPaperName: $("quizPaperName"),
    quizQuestionIndex: $("quizQuestionIndex"),
    quizQuestionMeta: $("quizQuestionMeta"),
    quizQuestionText: $("quizQuestionText"),
    quizOptions: $("quizOptions"),
    prevQuiz: $("prevQuiz"),
    nextQuiz: $("nextQuiz"),
    quizAnswered: $("quizAnswered"),
    submitQuiz: $("submitQuiz"),
    quizResult: $("quizResult"),
    editor: $("codeEditor"),
    lineNumbers: $("lineNumbers"),
    console: $("console"),
    progressChip: $("progressChip"),
    toast: $("toast"),
    resetProgress: $("resetProgress"),
    resetCode: $("resetCode"),
    insertTemplate: $("insertTemplate"),
    runtimeStatus: $("runtimeStatus"),
    runCode: $("runCode"),
    submitCode: $("submitCode")
  };

  let appMode = "code";
  let currentProblem = PROBLEMS[0];
  let currentQuizId = MCQS.length ? MCQS[0].id : null;
  let currentFilter = "all";
  let currentCompany = "all";
  let currentPaper = PAPERS.length ? PAPERS[0].id : null;
  let paperCompany = "all";
  let searchTerm = "";
  let codePage = 1;
  let quizPage = 1;
  let activeTab = "code";
  let codes = readJSON(KEY_CODES, {});
  let solved = new Set(readJSON(KEY_SOLVED, []));
  let quizAnswers = readJSON(KEY_QUIZ_ANS, {});
  let quizResult = readJSON(KEY_QUIZ_RESULT, null);
  let toastTimer = null;

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用，忽略即可 */
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function diffClass(d) { return d === "简单" ? "diff-easy" : d === "中等" ? "diff-medium" : "diff-hard"; }
  function pillClass(d) { return d === "简单" ? "easy" : d === "中等" ? "medium" : "hard"; }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
  }

  function setConsole(html) { elements.console.innerHTML = html; }
  function emptyConsole() {
    setConsole('<div class="console-empty">代码区默认为空白，请从 import 开始自己写完整程序。点击「运行」查看用例结果，或「提交」判题。</div>');
  }

  function matchesSearch(term) {
    if (!searchTerm) return true;
    return String(term).toLowerCase().indexOf(searchTerm) >= 0;
  }

  function filteredQuizzes() {
    return MCQS.filter((q) =>
      q.paper === currentPaper &&
      matchesSearch(q.no + " " + q.q + " " + q.topic)
    );
  }

  function filteredProblems() {
    return PROBLEMS.filter((p) =>
      (currentFilter === "all" || p.difficulty === currentFilter) &&
      (currentCompany === "all" || p.companies.indexOf(currentCompany) >= 0) &&
      matchesSearch(p.id + " " + p.title + " " + (p.titleEn || "") + " " + p.tags.join(" "))
    );
  }

  function currentItems() {
    if (appMode === "code") {
      return filteredProblems().map((p) => ({
        kind: "code", id: p.id, title: p.title,
        difficulty: p.difficulty, meta: p.companies.slice(0, 2).join("·"),
        done: solved.has(p.id)
      }));
    }
    return filteredQuizzes().map((q) => ({
      kind: "quiz", id: q.id, no: q.no, title: q.q,
      difficulty: "", meta: q.topic,
      done: quizAnswers[q.id] !== undefined
    }));
  }

  function updateProgressChip() {
    if (appMode === "quiz") {
      const list = filteredQuizzes();
      const answered = list.filter((q) => quizAnswers[q.id] !== undefined).length;
      elements.progressChip.textContent = "选择题已答 " + answered + " / " + list.length;
    } else {
      elements.progressChip.textContent = "已解决 " + solved.size + " / " + PROBLEMS.length;
    }
  }

  function renderPager(page, totalPages) {
    const buttons = [];
    buttons.push('<button class="page-btn" data-page="prev"' + (page <= 1 ? " disabled" : "") + '>上一页</button>');
    for (let i = 1; i <= totalPages; i++) {
      buttons.push('<button class="page-btn' + (i === page ? " active" : "") + '" data-page="' + i + '">' + i + "</button>");
    }
    buttons.push('<button class="page-btn" data-page="next"' + (page >= totalPages ? " disabled" : "") + '>下一页</button>');
    buttons.push('<span class="page-info">' + page + " / " + totalPages + " 页</span>");
    elements.listPager.innerHTML = buttons.join("");
  }

  function renderList() {
    const items = currentItems();
    const totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    if (appMode === "code") codePage = Math.min(codePage, totalPages);
    else quizPage = Math.min(quizPage, totalPages);
    const page = appMode === "code" ? codePage : quizPage;
    const visible = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    elements.listCount.textContent = items.length;

    elements.itemList.innerHTML = visible.map((item) => {
      const active = appMode === "code" ? item.id === currentProblem.id : item.id === currentQuizId;
      const title = item.title.length > 30 ? item.title.slice(0, 30) + "…" : item.title;
      return '<div class="problem-item' + (active ? " active" : "") + (item.done ? " solved" : "") + '" data-kind="' + item.kind + '" data-id="' + item.id + '">' +
        '<span class="status-dot">' + (item.done ? "✓" : "") + "</span>" +
        '<div class="problem-item-main">' +
          '<div class="problem-item-title"><span class="num">' + (item.no || item.id) + ".</span>" + escapeHtml(title) + "</div>" +
          '<div class="problem-item-meta">' +
            (item.kind === "code"
              ? '<span class="difficulty ' + diffClass(item.difficulty) + '">' + escapeHtml(item.difficulty) + "</span>"
              : '<span class="type-tag">选择题</span>') +
            '<span class="tag-mini">' + escapeHtml(item.meta) + "</span>" +
          "</div>" +
        "</div>" +
      "</div>";
    }).join("") || '<div class="empty-note">当前筛选条件下没有题目。</div>';

    renderPager(page, totalPages);
    updateProgressChip();
  }

  function renderPaperFilters() {
    const companies = ["all"].concat(Array.from(new Set(PAPERS.map((p) => p.company))));
    elements.paperCompanyFilters.innerHTML = companies.map((c) =>
      '<button class="paper-co-btn' + (c === paperCompany ? " active" : "") + '" data-paper-co="' + escapeHtml(c) + '" type="button">' + (c === "all" ? "全部" : escapeHtml(c)) + "</button>"
    ).join("");
    const shown = PAPERS.filter((p) => paperCompany === "all" || p.company === paperCompany);
    elements.paperFilters.innerHTML = shown.map((p) =>
      '<button class="paper-btn' + (p.id === currentPaper ? " active" : "") + '" data-paper="' + p.id + '" type="button" title="' + escapeHtml(p.name + '｜' + p.desc) + '">' + escapeHtml(p.name) + "</button>"
    ).join("");
    const paper = PAPERS.find((p) => p.id === currentPaper);
    elements.quizPaperName.textContent = paper ? (paper.name + "｜" + paper.desc) : "";
  }

  function switchMode(mode) {
    if (mode !== "code" && mode !== "quiz") return;
    appMode = mode;
    writeJSON(KEY_MODE, mode);
    document.querySelectorAll(".type-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === mode));
    elements.codeContent.hidden = mode !== "code";
    elements.quizContent.hidden = mode !== "quiz";
    elements.codePanel.hidden = mode !== "code";
    elements.quizPanel.hidden = mode !== "quiz";
    elements.difficultyFilters.hidden = mode === "quiz";
    elements.companyFilters.hidden = mode === "quiz";
    elements.paperArea.hidden = mode !== "quiz";
    renderPaperFilters();
    renderList();
    if (mode === "quiz") {
      renderQuizQuestion();
      updateQuizAnswered();
    }
  }

  function renderProblem() {
    const p = currentProblem;
    elements.problemHeader.innerHTML =
      '<h1 class="problem-title">' + p.id + ". " + escapeHtml(p.title) + "</h1>" +
      '<div class="problem-title-en">' + escapeHtml(p.titleEn) + "</div>" +
      '<div class="problem-badges">' +
        '<span class="pill ' + pillClass(p.difficulty) + '">' + escapeHtml(p.difficulty) + "</span>" +
        '<span class="pill">Python 3 · ACM</span>' +
        p.companies.map((c) => '<span class="pill company-pill">' + escapeHtml(c) + "</span>").join("") +
        p.tags.map((t) => '<span class="pill">' + escapeHtml(t) + "</span>").join("") +
      "</div>";

    const examples = p.examples.map((ex, i) =>
      '<div class="example-card"><h4>示例 ' + (i + 1) + "</h4>" +
      "<pre>输入：\n" + escapeHtml(ex.input) + "\n\n输出：\n" + escapeHtml(ex.output) + "</pre></div>"
    ).join("");

    elements.problemBody.innerHTML =
      '<div class="section-title">题目描述</div><div class="problem-body-text">' + p.description + "</div>" +
      '<div class="section-title">输入格式</div><pre class="format-block">' + escapeHtml(p.inputFormat) + "</pre>" +
      '<div class="section-title">输出格式</div><pre class="format-block">' + escapeHtml(p.outputFormat) + "</pre>" +
      '<div class="section-title">示例</div>' + examples +
      '<div class="section-title">提示</div><ul class="constraint-list">' + p.constraints.map((c) => "<li>" + escapeHtml(c) + "</li>").join("") + "</ul>" +
      '<div class="summary-card"><h4>题型总结</h4><p>本题标签：' + escapeHtml(p.tags.join(" / ")) + "。常见于 " + escapeHtml(p.companies.join("、")) + " 的机考或面试，建议使用 ACM 模式完整读入数据后输出结果。</p></div>";
  }

  function currentCode() {
    return typeof codes[currentProblem.id] === "string" ? codes[currentProblem.id] : "";
  }

  // ACM 模式标准骨架：ACM 采用「完整程序」运行，不需要 LeetCode 那种 class Solution / if __name__ 保护。
  // 这里提供带 if __name__ == "__main__" 的模板，方便习惯写法的人一键插入。
  const ACM_TEMPLATE = [
    "import sys",
    "",
    "",
    "def solve():",
    "    data = sys.stdin.read().split()",
    "    # 在这里解析 data 并用 print 输出结果",
    "",
    "",
    'if __name__ == "__main__":',
    "    solve()",
    ""
  ].join("\n");

  function insertTemplate() {
    if (activeTab === "solution") {
      activeTab = "code";
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "code"));
    }
    elements.editor.focus();
    const value = elements.editor.value;
    const start = elements.editor.selectionStart;
    const end = elements.editor.selectionEnd;
    // 空编辑器直接写入；非空则插入到光标处
    elements.editor.value = value.slice(0, start) + ACM_TEMPLATE + value.slice(end);
    const pos = start + ACM_TEMPLATE.length;
    elements.editor.selectionStart = elements.editor.selectionEnd = pos;
    codes[currentProblem.id] = elements.editor.value;
    writeJSON(KEY_CODES, codes);
    updateLineNumbers();
    showToast("已插入 ACM 标准模板");
  }

  function updateLineNumbers() {
    const count = elements.editor.value.split("\n").length;
    const lines = [];
    for (let i = 1; i <= count; i++) lines.push(i);
    elements.lineNumbers.textContent = lines.join("\n");
    elements.lineNumbers.scrollTop = elements.editor.scrollTop;
  }

  function renderEditor() {
    elements.editor.value = activeTab === "solution" ? currentProblem.pySolution : currentCode();
    elements.editor.readOnly = activeTab === "solution";
    elements.runCode.disabled = activeTab === "solution";
    elements.submitCode.disabled = activeTab === "solution";
    const tip = activeTab === "solution" ? "请切换到「代码」页运行你编写的程序" : "";
    elements.runCode.title = tip;
    elements.submitCode.title = tip;
    elements.editor.scrollTop = 0;
    updateLineNumbers();
  }

  function selectProblem(id) {
    const next = PROBLEMS.find((p) => p.id === Number(id));
    if (!next || next.id === currentProblem.id) return;
    currentProblem = next;
    writeJSON(KEY_CURRENT, currentProblem.id);
    activeTab = "code";
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "code"));
    renderList();
    renderProblem();
    renderEditor();
    emptyConsole();
  }

  function selectQuiz(id) {
    const numId = Number(id);
    if (!MCQS.some((q) => q.id === numId) || numId === currentQuizId) return;
    currentQuizId = numId;
    writeJSON(KEY_QUIZ_CURRENT, numId);
    renderList();
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    const list = filteredQuizzes();
    let index = list.findIndex((q) => q.id === currentQuizId);
    if (index < 0 && list.length) {
      currentQuizId = list[0].id;
      index = 0;
    }
    if (!list.length) {
      elements.quizQuestionIndex.textContent = "–";
      elements.quizQuestionMeta.textContent = "";
      elements.quizQuestionText.textContent = "当前筛选条件下没有选择题。";
      elements.quizOptions.innerHTML = "";
      elements.prevQuiz.disabled = true;
      elements.nextQuiz.disabled = true;
      return;
    }
    const q = list[index];
    elements.quizQuestionIndex.textContent = String(index + 1);
    elements.quizQuestionMeta.textContent = q.company + " · " + q.topic;
    elements.quizQuestionText.textContent = q.q;
    const chosen = quizAnswers[q.id];
    elements.quizOptions.dataset.qid = String(q.id);
    elements.quizOptions.innerHTML = q.options.map((opt, j) =>
      '<label class="option' + (chosen === j ? " chosen" : "") + '">' +
        '<input type="radio" name="quizOption" value="' + j + '"' + (chosen === j ? " checked" : "") + ">" +
        '<span class="option-key">' + "ABCD"[j] + "</span><span>" + escapeHtml(opt) + "</span></label>"
    ).join("");
    elements.prevQuiz.disabled = index <= 0;
    elements.nextQuiz.disabled = index >= list.length - 1;
  }

  function updateQuizAnswered() {
    const list = filteredQuizzes();
    const answered = list.filter((q) => quizAnswers[q.id] !== undefined).length;
    elements.quizAnswered.textContent = "已答 " + answered + " / " + list.length;
    elements.submitQuiz.disabled = list.length === 0 || answered !== list.length;
  }

  function stepQuiz(delta) {
    const list = filteredQuizzes();
    const index = list.findIndex((q) => q.id === currentQuizId);
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    currentQuizId = list[next].id;
    writeJSON(KEY_QUIZ_CURRENT, currentQuizId);
    quizPage = Math.floor(next / PER_PAGE) + 1;
    renderList();
    renderQuizQuestion();
    elements.quizContent.scrollTop = 0;
  }

  const pyWorkerSource = `
let pyodide = null;

function normalizeOutput(s) {
  return String(s == null ? "" : s)
    .replace(/\\r\\n/g, "\\n")
    .split("\\n")
    .map(function (line) { return line.replace(/\\s+$/, ""); })
    .join("\\n")
    .replace(/^\\n+/, "")
    .replace(/\\n+$/, "");
}

self.onmessage = async function (e) {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      importScripts(msg.index + "pyodide.js");
      pyodide = await loadPyodide({ indexURL: msg.index });
      // 预热常用标准库，后续用例 import 直接命中缓存，减少单次执行耗时
      pyodide.runPython("import sys, io, math, collections, itertools, functools, heapq, bisect");
      self.postMessage({ type: "ready", source: msg.source });
    } catch (err) {
      self.postMessage({ type: "initError", message: String((err && err.message) || err), source: msg.source });
    }
    return;
  }

  if (msg.type === "run") {
    if (!pyodide) { self.postMessage({ type: "result", id: msg.id, compileError: "Python 运行时未就绪" }); return; }
    const results = [];
    for (const t of msg.tests) {
      // 关键修复 1：用 Python 层 sys.stdout = StringIO 捕获输出。
      // 之前的 pyodide.setStdout({batched}) 会漏掉/合并换行，导致正确答案被误判为错误。
      // 关键修复 2：globals 注入 __name__ = "__main__"，否则 if __name__ == "__main__": 分支不执行。
      const globals = pyodide.toPy({ __name__: "__main__" });
      const indented = msg.code.split("\\n").map(function (l) { return l ? "    " + l : l; }).join("\\n");
      const script =
        "import sys, io, traceback\\n" +
        "__out = io.StringIO(); __err = io.StringIO()\\n" +
        "_real_out, _real_err = sys.stdout, sys.stderr\\n" +
        "sys.stdout, sys.stderr = __out, __err\\n" +
        "sys.stdin = io.StringIO(" + JSON.stringify(t.stdin) + ")\\n" +
        "try:\\n" + indented + "\\n" +
        "except BaseException:\\n    __err.write(traceback.format_exc())\\n" +
        "finally:\\n    sys.stdout, sys.stderr = _real_out, _real_err\\n";
      const start = performance.now();
      let out = "", errText = "";
      try {
        await pyodide.runPythonAsync(script, { globals: globals, filename: "answer.py" });
        out = pyodide.runPython("__out.getvalue()", { globals }) || "";
        errText = pyodide.runPython("__err.getvalue()", { globals }) || "";
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        results.push({ passed: normalizeOutput(out) === normalizeOutput(t.expected), output: out, expected: t.expected, error: errText, time: elapsed });
      } catch (err) {
        try { out = pyodide.runPython("__out.getvalue()", { globals }) || ""; } catch (x) {}
        try { errText = pyodide.runPython("__err.getvalue()", { globals }) || ""; } catch (x) {}
        results.push({ passed: false, output: out, expected: t.expected, error: String((err && err.message) || err) + (errText ? "\\n" + errText : "") });
      } finally {
        try { globals.destroy(); } catch (x) {}
      }
    }
    self.postMessage({ type: "result", id: msg.id, results: results });
  }
};
`;

  /* 单例 Worker：Pyodide 只加载一次，后续运行/提交直接复用，避免每次重新下载 10MB+ 运行时 */
  let pyWorker = null;
  let pyWorkerUrl = null;
  let pyReady = false;
  let pyInitPromise = null;
  let runSeq = 0;

  function setRuntimeStatus(text, state) {
    if (!elements.runtimeStatus) return;
    elements.runtimeStatus.textContent = text;
    elements.runtimeStatus.className = "runtime-status " + (state || "");
  }

  function destroyWorker() {
    if (pyWorker) { try { pyWorker.terminate(); } catch (e) {} pyWorker = null; }
    if (pyWorkerUrl) { try { URL.revokeObjectURL(pyWorkerUrl); } catch (e) {} pyWorkerUrl = null; }
    pyReady = false;
    pyInitPromise = null;
  }

  function tryLoadRuntime(index, source, timeout) {
    return new Promise((resolve, reject) => {
      let worker, url;
      try {
        const blob = new Blob([pyWorkerSource], { type: "application/javascript" });
        url = URL.createObjectURL(blob);
        worker = new Worker(url);
      } catch (e) {
        reject({ compileError: "无法创建 Python 运行环境：" + String((e && e.message) || e) });
        return;
      }
      pyWorker = worker;
      pyWorkerUrl = url;
      let settled = false;
      const loadTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) {}
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        reject({ compileError: "加载超时" });
      }, timeout);
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "ready") {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimer);
          pyodideIndex = index;
          pyReady = true;
          resolve(worker);
        } else if (msg.type === "initError") {
          if (settled) return;
          settled = true;
          clearTimeout(loadTimer);
          try { worker.terminate(); } catch (e) {}
          if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
          reject({ compileError: msg.message || "加载失败" });
        }
      };
      worker.onerror = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        try { worker.terminate(); } catch (e) {}
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        reject({ compileError: event.message || "加载失败" });
      };
      setRuntimeStatus(source === "local" ? "正在加载本地 Python 运行时…" : "正在从网络加载运行时…", "loading");
      worker.postMessage({ type: "init", index: index, source: source });
    });
  }

  function ensurePyRuntime() {
    if (pyReady && pyWorker) return Promise.resolve(pyWorker);
    if (pyInitPromise) return pyInitPromise;
    // 先试本地文件（零下载、秒开），失败回退 CDN。本地超时给短一些，快速切换。
    pyInitPromise = tryLoadRuntime(PYODIDE_LOCAL, "local", 12000)
      .catch(() => tryLoadRuntime(PYODIDE_CDN, "cdn", PY_LOAD_TIMEOUT))
      .then((worker) => {
        setRuntimeStatus(pyodideIndex === PYODIDE_LOCAL ? "Python 运行时已就绪 · 本地" : "Python 运行时已就绪 · 网络", "ready");
        return worker;
      })
      .catch((err) => {
        pyInitPromise = null;
        setRuntimeStatus("运行时加载失败 · 点击重试", "error");
        throw err;
      });
    return pyInitPromise;
  }

  function runInWorker(worker, code, tests) {
    return new Promise((resolve) => {
      const id = ++runSeq;
      let done = false;
      const onMessage = (event) => {
        const msg = event.data;
        if (!msg || msg.id !== id) return;
        if (msg.type === "result") finish(msg);
      };
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(runTimer);
        worker.removeEventListener("message", onMessage);
        resolve(result);
      };
      const runTimer = setTimeout(() => {
        if (done) return;
        done = true;
        worker.removeEventListener("message", onMessage);
        // Python 死循环在 Worker 内无法被 JS 中断，只能终止整个 Worker，下次运行自动重新加载
        destroyWorker();
        setRuntimeStatus("运行时已重置 · 下次运行将重新加载", "idle");
        resolve({ timeout: true });
      }, PY_RUN_TIMEOUT);
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "run", id: id, code: code, tests: tests });
    });
  }

  function runPythonTests(code, tests) {
    return ensurePyRuntime()
      .then((worker) => runInWorker(worker, code, tests))
      .catch((err) => (err && typeof err === "object" && !Array.isArray(err) ? err : { compileError: String(err) }));
  }

  function ioBlock(label, text) {
    return '<div class="io-label">' + label + '</div><pre class="io-block">' + escapeHtml(text == null ? "" : String(text)) + "</pre>";
  }

  function renderResult(result, mode) {
    if (result.timeout) {
      setConsole('<div class="console-title fail">运行超时</div><div class="console-detail">代码执行超过 ' + (PY_RUN_TIMEOUT / 1000) + " 秒（不含运行时加载），通常是死循环或输入过大。运行时已自动重置，下次运行会重新加载。</div>");
      return;
    }
    if (result.compileError) {
      setConsole('<div class="console-title fail">运行失败</div><div class="console-detail">' + escapeHtml(result.compileError) + "</div>");
      return;
    }
    if (!result.results) {
      setConsole('<div class="console-title fail">运行失败</div><div class="console-detail">未知错误，请重试。</div>');
      return;
    }
    const results = result.results;
    const passed = results.filter((r) => r.passed).length;
    const allPassed = passed === results.length;
    const title = mode === "submit"
      ? (allPassed ? "提交通过 · Accepted" : "提交未通过 · Wrong Answer")
      : (allPassed ? "运行完成 · 全部用例通过" : "运行完成 · 部分用例未通过");
    const times = results.map((r) => r.time || 0);
    const maxTime = Math.max.apply(null, times.concat([0]));
    const rows = results.map((r, i) => {
      let detail;
      if (r.passed) detail = "用例 " + (i + 1) + " 通过" + ioBlock("输出", r.output);
      else if (r.error) detail = "用例 " + (i + 1) + " 抛出异常" + '<pre class="io-block error">' + escapeHtml(r.error) + "</pre>" + ioBlock("期望输出", r.expected);
      else detail = "用例 " + (i + 1) + " 未通过" + ioBlock("你的输出", r.output) + ioBlock("期望输出", r.expected);
      return '<div class="case-row"><span class="case-icon ' + (r.passed ? "pass" : "fail") + '">' + (r.passed ? "✓" : "✕") + '</span><span class="case-text">' + detail + "</span></div>";
    }).join("");
    setConsole('<div class="console-title ' + (allPassed ? "pass" : "fail") + '">' + title + "</div>" +
      '<div class="console-detail">通过 ' + passed + " / " + results.length + " 个测试用例" + (maxTime ? " · 单用例最大耗时 " + maxTime + " ms" : "") + "</div>" + rows);
  }

  async function execute(mode) {
    if (activeTab === "solution") { showToast("请先切换到「代码」页"); return; }
    const code = elements.editor.value;
    elements.runCode.disabled = true;
    elements.submitCode.disabled = true;
    setConsole('<div class="console-title running">' + (pyReady ? "正在执行测试用例…" : "正在准备 Python 运行时…") + '</div><div class="console-detail">' + (pyReady ? "运行时已复用，无需重复加载。" : "Pyodide 运行时只加载一次，之后所有运行/提交都会复用，请稍候。") + "</div>");
    const result = await runPythonTests(code, currentProblem.acmTests);
    renderResult(result, mode);
    if (mode === "submit") {
      const ok = result.results && result.results.length === currentProblem.acmTests.length && result.results.every((r) => r.passed);
      if (ok) {
        if (!solved.has(currentProblem.id)) {
          solved.add(currentProblem.id);
          writeJSON(KEY_SOLVED, Array.from(solved));
          renderList();
        }
        showToast("恭喜，本题提交通过！");
      } else {
        showToast("提交未通过，请查看用例结果");
      }
    }
    elements.runCode.disabled = activeTab === "solution";
    elements.submitCode.disabled = activeTab === "solution";
  }

  function gradeQuiz() {
    const list = filteredQuizzes();
    if (!list.length || list.some((q) => quizAnswers[q.id] === undefined)) { showToast("请先完成当前筛选下的全部题目"); return; }
    let correct = 0;
    const details = list.map((q) => {
      const ok = quizAnswers[q.id] === q.answer;
      if (ok) correct++;
      return '<div class="grade-item ' + (ok ? "right" : "wrong") + '">' +
        '<div class="grade-head">' + (ok ? "✓" : "✕") + " 第 " + q.no + " 题 · " + escapeHtml(q.company) + " · " + escapeHtml(q.topic) + "</div>" +
        '<div>你的答案：' + "ABCD"[quizAnswers[q.id]] + " · 正确答案：" + "ABCD"[q.answer] + "</div>" +
        '<div class="grade-explain">' + escapeHtml(q.explanation) + "</div></div>";
    }).join("");
    const rate = Math.round(correct / list.length * 100);
    elements.quizResult.innerHTML = '<div class="score-card"><div class="score-num">' + rate + '%</div><div>答对 ' + correct + " / " + list.length + " 题</div></div>" + details;
    quizResult = { rate: rate, correct: correct, total: list.length };
    writeJSON(KEY_QUIZ_RESULT, quizResult);
    showToast("批改完成");
  }

  /* 事件绑定 */
  elements.typeTabs.addEventListener("click", (event) => {
    const btn = event.target.closest(".type-btn");
    if (btn) switchMode(btn.dataset.type);
  });

  elements.searchInput.addEventListener("input", () => {
    searchTerm = elements.searchInput.value.trim().toLowerCase();
    codePage = 1;
    quizPage = 1;
    renderList();
    if (appMode === "quiz") {
      renderQuizQuestion();
      updateQuizAnswered();
    }
  });

  elements.difficultyFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".filter-btn");
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll("#difficultyFilters .filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    codePage = 1;
    renderList();
  });

  elements.companyFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".company-btn");
    if (!btn) return;
    currentCompany = btn.dataset.company;
    document.querySelectorAll(".company-btn").forEach((b) => b.classList.toggle("active", b === btn));
    codePage = 1;
    quizPage = 1;
    renderList();
    if (appMode === "quiz") {
      renderQuizQuestion();
      updateQuizAnswered();
    }
  });

  elements.paperCompanyFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".paper-co-btn");
    if (!btn || btn.dataset.paperCo === paperCompany) return;
    paperCompany = btn.dataset.paperCo;
    renderPaperFilters();
  });

  elements.paperFilters.addEventListener("click", (event) => {
    const btn = event.target.closest(".paper-btn");
    if (!btn || btn.dataset.paper === currentPaper) return;
    currentPaper = btn.dataset.paper;
    writeJSON(KEY_QUIZ_PAPER, currentPaper);
    const first = MCQS.find((q) => q.paper === currentPaper);
    currentQuizId = first ? first.id : null;
    writeJSON(KEY_QUIZ_CURRENT, currentQuizId);
    quizPage = 1;
    renderPaperFilters();
    renderList();
    renderQuizQuestion();
    updateQuizAnswered();
    elements.itemList.scrollTop = 0;
  });

  elements.itemList.addEventListener("click", (event) => {
    const item = event.target.closest(".problem-item");
    if (!item) return;
    if (item.dataset.kind === "quiz") selectQuiz(item.dataset.id);
    else selectProblem(item.dataset.id);
  });

  elements.listPager.addEventListener("click", (event) => {
    const btn = event.target.closest(".page-btn");
    if (!btn || btn.disabled) return;
    const items = currentItems();
    const totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE));
    const page = appMode === "code" ? codePage : quizPage;
    let target = page;
    if (btn.dataset.page === "prev") target = Math.max(1, page - 1);
    else if (btn.dataset.page === "next") target = Math.min(totalPages, page + 1);
    else target = Number(btn.dataset.page);
    if (appMode === "code") codePage = target;
    else quizPage = target;
    renderList();
    elements.itemList.scrollTop = 0;
  });

  elements.quizOptions.addEventListener("change", (event) => {
    const input = event.target;
    if (!input || input.type !== "radio") return;
    const qid = Number(elements.quizOptions.dataset.qid);
    quizAnswers[qid] = Number(input.value);
    writeJSON(KEY_QUIZ_ANS, quizAnswers);
    elements.quizOptions.querySelectorAll(".option").forEach((label, index) => {
      label.classList.toggle("chosen", index === Number(input.value));
    });
    renderList();
    updateQuizAnswered();
  });

  elements.prevQuiz.addEventListener("click", () => stepQuiz(-1));
  elements.nextQuiz.addEventListener("click", () => stepQuiz(1));
  elements.submitQuiz.addEventListener("click", gradeQuiz);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (activeTab === tab.dataset.tab) return;
      activeTab = tab.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      renderEditor();
    });
  });

  elements.editor.addEventListener("input", () => {
    if (activeTab !== "code") return;
    codes[currentProblem.id] = elements.editor.value;
    writeJSON(KEY_CODES, codes);
    updateLineNumbers();
  });
  elements.editor.addEventListener("scroll", () => { elements.lineNumbers.scrollTop = elements.editor.scrollTop; });
  function applyEditorChange(value, selStart, selEnd) {
    elements.editor.value = value;
    elements.editor.selectionStart = selStart;
    elements.editor.selectionEnd = selEnd;
    elements.editor.dispatchEvent(new Event("input"));
  }

  elements.editor.addEventListener("keydown", (event) => {
    if (activeTab !== "code") return;
    const editor = elements.editor;
    const value = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;

    if (event.key === "Tab") {
      event.preventDefault();
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nl = value.indexOf("\n", end);
      const blockEnd = nl === -1 ? value.length : nl;
      // 选中了多行：整块缩进 / 反缩进
      if (value.slice(lineStart, blockEnd).indexOf("\n") >= 0) {
        const lines = value.slice(lineStart, blockEnd).split("\n");
        const next = lines.map((line) => event.shiftKey
          ? line.replace(/^( {1,4}|\t)/, "")
          : "    " + line
        ).join("\n");
        applyEditorChange(value.slice(0, lineStart) + next + value.slice(blockEnd), lineStart, lineStart + next.length);
      } else if (event.shiftKey) {
        const line = value.slice(lineStart, blockEnd);
        const dedented = line.replace(/^( {1,4}|\t)/, "");
        const removed = line.length - dedented.length;
        applyEditorChange(value.slice(0, lineStart) + dedented + value.slice(blockEnd), Math.max(lineStart, start - removed), Math.max(lineStart, end - removed));
      } else {
        applyEditorChange(value.slice(0, start) + "    " + value.slice(end), start + 4, start + 4);
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nl = value.indexOf("\n", end);
      const lineEnd = nl === -1 ? value.length : nl;
      const before = value.slice(lineStart, start);
      const indentMatch = before.match(/^[ \t]*/);
      let indent = indentMatch ? indentMatch[0] : "";
      const after = value.slice(end, lineEnd);
      // 在纯空白行按回车：先回退一级缩进，符合 Python 结束代码块的习惯
      if (start === end && before.trim() === "" && after.trim() === "" && indent.length >= 4) {
        indent = indent.slice(0, -4);
        const next = indent + "\n" + indent;
        applyEditorChange(value.slice(0, lineStart) + next + value.slice(lineEnd), lineStart + indent.length + 1 + indent.length, lineStart + indent.length + 1 + indent.length);
        return;
      }
      // 以冒号结尾（含行尾注释）：自动增加一级缩进
      if (/:\s*(#.*)?$/.test(before.trimEnd())) indent += "    ";
      const next = "\n" + indent;
      applyEditorChange(value.slice(0, start) + next + value.slice(end), start + next.length, start + next.length);
    }
  });

  if (elements.insertTemplate) elements.insertTemplate.addEventListener("click", insertTemplate);
  if (elements.runtimeStatus) {
    elements.runtimeStatus.title = "点击重新加载 Python 运行时";
    elements.runtimeStatus.addEventListener("click", () => {
      if (pyReady) { showToast("Python 运行时已就绪，无需重复加载"); return; }
      ensurePyRuntime().then(() => showToast("Python 运行时已就绪"));
    });
  }

  elements.runCode.addEventListener("click", () => execute("run"));
  elements.submitCode.addEventListener("click", () => execute("submit"));

  elements.resetCode.addEventListener("click", () => {
    if (!window.confirm("确定要清空当前题目的代码吗？")) return;
    delete codes[currentProblem.id];
    writeJSON(KEY_CODES, codes);
    activeTab = "code";
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "code"));
    renderEditor();
    emptyConsole();
    showToast("代码已清空");
  });

  elements.resetProgress.addEventListener("click", () => {
    if (!window.confirm("确定清空编程题完成状态与选择题作答记录吗？")) return;
    solved.clear();
    quizAnswers = {};
    quizResult = null;
    writeJSON(KEY_SOLVED, []);
    writeJSON(KEY_QUIZ_ANS, {});
    writeJSON(KEY_QUIZ_RESULT, null);
    elements.quizResult.textContent = "提交后显示得分、你的答案、正确答案与逐题解析。";
    renderList();
    if (appMode === "quiz") {
      renderQuizQuestion();
      updateQuizAnswered();
    }
    showToast("进度已重置");
  });

  /* 初始化 */
  const savedMode = readJSON(KEY_MODE, "code");
  if (savedMode === "quiz") appMode = "quiz";
  const savedId = readJSON(KEY_CURRENT, null);
  if (savedId) {
    const found = PROBLEMS.find((p) => p.id === savedId);
    if (found) currentProblem = found;
  }
  const savedPaper = readJSON(KEY_QUIZ_PAPER, null);
  if (savedPaper && PAPERS.some((p) => p.id === savedPaper)) currentPaper = savedPaper;
  const savedQuizId = readJSON(KEY_QUIZ_CURRENT, null);
  if (savedQuizId && MCQS.some((q) => q.id === savedQuizId && q.paper === currentPaper)) currentQuizId = savedQuizId;

  switchMode(appMode);
  renderList();
  renderProblem();
  renderEditor();
  emptyConsole();
  // 打开页面即后台预加载运行时，点「运行/提交」时通常已经就绪
  ensurePyRuntime().catch(() => { /* 加载失败状态已在 ensurePyRuntime 内展示，用户可点击状态标签重试 */ });
})();
