// ========== Константы и ключи хранилища ==========
const STORAGE_KEYS = {
  STATE: "quiz.state.v2",
};
const DATA_URL = "./data/questions.json";
const DEFAULT_TIME_LIMIT_SEC = 300;
const DEFAULT_PASS_THRESHOLD = 0.7;
const STATE_VERSION = 2;

// ========== Модели ==========
/**
 * @typedef {{ id: string; text: string; options: string[]; correctIndex: number; topic?: string }} QuestionDTO
 * @typedef {{ title: string; timeLimitSec: number; passThreshold: number; questions: QuestionDTO[] }} QuizDTO
 */

class Question {
  /** @param {QuestionDTO} dto */
  constructor(dto) {
    this.id = dto.id;
    this.text = dto.text;
    this.options = dto.options;
    this.correctIndex = dto.correctIndex;
    this.topic = dto.topic ?? null;
  }
}

// ========== Сервисы ==========
class StorageService {
  static saveState(state) {
    localStorage.setItem(STORAGE_KEYS.STATE, JSON.stringify(state));
  }

  static loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STATE);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn("Saved quiz state is corrupted and was ignored.", error);
      this.clear();
      return null;
    }
  }

  static clear() {
    localStorage.removeItem(STORAGE_KEYS.STATE);
  }
}

// ========== Движок теста ==========
class QuizEngine {
  /** @param {QuizDTO} quiz */
  constructor(quiz) {
    this.title = quiz.title;
    this.timeLimitSec = quiz.timeLimitSec ?? DEFAULT_TIME_LIMIT_SEC;
    this.passThreshold = quiz.passThreshold ?? DEFAULT_PASS_THRESHOLD;
    this.questions = quiz.questions.map((q) => new Question(q));
    this.quizId = createQuizSignature(quiz);

    this.currentIndex = 0;
    /** @type {Record<string, number|undefined>} */
    this.answers = {}; // questionId -> selectedIndex
    this.remainingSec = this.timeLimitSec;
    this.deadlineMs = Date.now() + this.remainingSec * 1000;
    this.isFinished = false;
  }

  get length() {
    return this.questions.length;
  }

  get currentQuestion() {
    return this.questions[this.currentIndex];
  }

  /** @param {number} index */
  goTo(index) {
    if (Number.isInteger(index) && index >= 0 && index < this.length) {
      this.currentIndex = index;
    }
  }

  next() {
    this.goTo(this.currentIndex + 1);
  }

  prev() {
    this.goTo(this.currentIndex - 1);
  }

  /** @param {number} optionIndex */
  select(optionIndex) {
    const q = this.currentQuestion;
    if (
      !this.isFinished &&
      q &&
      Number.isInteger(optionIndex) &&
      optionIndex >= 0 &&
      optionIndex < q.options.length
    ) {
      this.answers[q.id] = optionIndex;
    }
  }

  getSelectedIndex() {
    return this.answers[this.currentQuestion.id];
  }

  getAnswerFor(questionId) {
    return this.answers[questionId];
  }

  tick(now = Date.now()) {
    if (this.isFinished) return this.finish();

    this.remainingSec = Math.max(0, Math.ceil((this.deadlineMs - now) / 1000));
    if (this.remainingSec === 0) {
      return this.finish();
    }

    return null;
  }

  finish() {
    this.isFinished = true;
    this.remainingSec = Math.max(0, this.remainingSec);

    const total = this.length;
    const correct = this.questions.reduce(
      (sum, q) => sum + (this.answers[q.id] === q.correctIndex ? 1 : 0),
      0
    );
    const percent = total ? correct / total : 0;

    return {
      correct,
      total,
      percent,
      passed: percent >= this.passThreshold,
    };
  }

  /** Восстановление/выгрузка состояния для localStorage */
  toState() {
    this.tick();
    return {
      version: STATE_VERSION,
      quizId: this.quizId,
      currentIndex: this.currentIndex,
      answers: this.answers,
      remainingSec: this.remainingSec,
      isFinished: this.isFinished,
    };
  }

  /** @param {any} state */
  static fromState(quiz, state) {
    const engine = new QuizEngine(quiz);
    if (!QuizEngine.canRestore(quiz, state)) return engine;

    const lastIndex = engine.length - 1;
    engine.currentIndex = Math.min(Math.max(state.currentIndex, 0), lastIndex);

    for (const q of engine.questions) {
      const answer = state.answers[q.id];
      if (
        Number.isInteger(answer) &&
        answer >= 0 &&
        answer < q.options.length
      ) {
        engine.answers[q.id] = answer;
      }
    }

    engine.remainingSec = Math.min(
      Math.max(0, state.remainingSec),
      engine.timeLimitSec
    );
    engine.deadlineMs = Date.now() + engine.remainingSec * 1000;
    engine.isFinished = Boolean(state.isFinished);
    return engine;
  }

  static canRestore(quiz, state) {
    return (
      state?.version === STATE_VERSION &&
      state?.quizId === createQuizSignature(quiz) &&
      Number.isInteger(state.currentIndex) &&
      state.currentIndex >= 0 &&
      state.currentIndex < quiz.questions.length &&
      state.answers &&
      typeof state.answers === "object" &&
      Number.isFinite(state.remainingSec)
    );
  }
}

// ========== DOM-утилиты ==========
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const els = {
  title: $("#quiz-title"),
  progress: $("#progress"),
  timer: $("#timer"),
  loading: $("#loading-section"),
  error: $("#error-section"),
  errorMessage: $("#error-message"),
  liveStatus: $("#live-status"),
  qSection: $("#question-section"),
  reviewHeading: $("#review-heading"),
  qText: $("#question-text"),
  form: $("#options-form"),
  quizActions: $("#quiz-actions"),
  btnPrev: $("#btn-prev"),
  btnNext: $("#btn-next"),
  btnFinish: $("#btn-finish"),
  btnBackResult: $("#btn-back-result"),
  result: $("#result-section"),
  resultSummary: $("#result-summary"),
  btnReview: $("#btn-review"),
  btnRestart: $("#btn-restart"),
};

let engine = /** @type {QuizEngine|null} */ (null);
let timerId = /** @type {number|undefined} */ (undefined);
let reviewMode = false;

// ========== Инициализация ==========
document.addEventListener("DOMContentLoaded", init);

async function init() {
  showLoading();

  try {
    const quiz = await loadQuiz();
    els.title.textContent = quiz.title;

    const saved = StorageService.loadState();
    engine = QuizEngine.fromState(quiz, saved);
    if (saved && !QuizEngine.canRestore(quiz, saved)) {
      StorageService.clear();
    }

    bindEvents();

    if (engine.isFinished) {
      renderResult(engine.finish());
    } else {
      showQuiz();
      renderAll();
      startTimer();
    }
  } catch (error) {
    handleError(error, "Не удалось загрузить тест. Проверьте файл data/questions.json.");
  }
}

async function loadQuiz() {
  let data;

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    data = await res.json();
  } catch (error) {
    throw new Error(`Ошибка загрузки данных теста: ${error.message}`);
  }

  return validateQuiz(data);
}

function validateQuiz(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Файл теста должен содержать JSON-объект.");
  }

  if (typeof data.title !== "string" || !data.title.trim()) {
    throw new Error("Поле title обязательно и должно быть строкой.");
  }

  const timeLimitSec =
    data.timeLimitSec === undefined ? DEFAULT_TIME_LIMIT_SEC : data.timeLimitSec;
  if (!Number.isFinite(timeLimitSec) || timeLimitSec <= 0) {
    throw new Error("Поле timeLimitSec должно быть положительным числом.");
  }

  const passThreshold =
    data.passThreshold === undefined ? DEFAULT_PASS_THRESHOLD : data.passThreshold;
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 1) {
    throw new Error("Поле passThreshold должно быть числом от 0 до 1.");
  }

  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("Поле questions должно быть непустым массивом.");
  }

  const ids = new Set();
  const questions = data.questions.map((q, index) => {
    if (!q || typeof q !== "object") {
      throw new Error(`Вопрос ${index + 1}: ожидается объект.`);
    }
    if (typeof q.id !== "string" || !q.id.trim()) {
      throw new Error(`Вопрос ${index + 1}: id обязателен.`);
    }
    if (ids.has(q.id)) {
      throw new Error(`Вопрос ${index + 1}: id "${q.id}" повторяется.`);
    }
    ids.add(q.id);
    if (typeof q.text !== "string" || !q.text.trim()) {
      throw new Error(`Вопрос ${index + 1}: text обязателен.`);
    }
    if (
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      !q.options.every((option) => typeof option === "string" && option.trim())
    ) {
      throw new Error(`Вопрос ${index + 1}: options должен содержать минимум 2 строки.`);
    }
    if (
      !Number.isInteger(q.correctIndex) ||
      q.correctIndex < 0 ||
      q.correctIndex >= q.options.length
    ) {
      throw new Error(`Вопрос ${index + 1}: correctIndex вне диапазона.`);
    }

    return {
      id: q.id,
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
      topic: typeof q.topic === "string" ? q.topic : undefined,
    };
  });

  return {
    title: data.title.trim(),
    timeLimitSec,
    passThreshold,
    questions,
  };
}

// ========== Таймер ==========
function startTimer() {
  stopTimer();
  timerId = window.setInterval(() => {
    if (!engine) return;

    const summary = engine.tick();
    persist();
    renderTimer();

    if (summary) {
      stopTimer();
      renderResult(summary);
    }
  }, 1000);
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = undefined;
  }
}

// ========== События ==========
function bindEvents() {
  els.btnPrev.addEventListener("click", () => {
    engine.prev();
    persist();
    renderAll();
  });

  els.btnNext.addEventListener("click", () => {
    engine.next();
    persist();
    renderAll();
  });

  els.btnFinish.addEventListener("click", () => {
    stopTimer();
    const summary = engine.finish();
    persist();
    renderResult(summary);
  });

  els.btnBackResult.addEventListener("click", () => {
    renderResult(engine.finish());
  });

  els.btnReview.addEventListener("click", () => {
    reviewMode = true;
    showReview();
    renderAll();
    announce("Режим просмотра ответов включен.");
    els.qText.focus();
  });

  els.btnRestart.addEventListener("click", () => {
    StorageService.clear();
    window.location.reload();
  });

  els.form.addEventListener("change", (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    if (target?.name === "option") {
      engine.select(Number(target.value));
      persist();
      renderNav();
    }
  });
}

// ========== Рендер ==========
function renderAll() {
  renderProgress();
  renderTimer();
  renderQuestion();
  renderNav();
}

function renderProgress() {
  els.progress.textContent = `Вопрос ${engine.currentIndex + 1} из ${
    engine.length
  }`;
}

function renderTimer() {
  const sec = engine.remainingSec ?? 0;
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  els.timer.textContent = `${m}:${s}`;
}

function renderQuestion() {
  const q = engine.currentQuestion;
  els.qText.textContent = q.text;

  els.form.innerHTML = "";
  q.options.forEach((opt, i) => {
    const id = `opt-${q.id}-${i}`;
    const chosen = engine.getAnswerFor(q.id);
    const wrapper = document.createElement("label");
    wrapper.className = "option";

    if (reviewMode) {
      if (i === q.correctIndex) wrapper.classList.add("option-correct");
      if (chosen === i && i !== q.correctIndex) {
        wrapper.classList.add("option-incorrect");
      }
    }

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "option";
    input.value = String(i);
    input.id = id;
    input.checked = engine.getSelectedIndex() === i;
    input.disabled = engine.isFinished;
    input.setAttribute("aria-label", opt);

    const span = document.createElement("span");
    span.textContent = opt;

    wrapper.appendChild(input);
    wrapper.appendChild(span);
    els.form.appendChild(wrapper);
  });

  if (reviewMode && engine.getSelectedIndex() === undefined) {
    const missed = document.createElement("p");
    missed.className = "missed-answer";
    missed.textContent = "Ответ не выбран.";
    els.form.appendChild(missed);
  }
}

function renderNav() {
  const hasSelection = Number.isInteger(engine.getSelectedIndex());
  const isLast = engine.currentIndex === engine.length - 1;

  els.btnPrev.disabled = engine.currentIndex === 0;
  els.btnNext.hidden = isLast && !reviewMode;
  els.btnNext.classList.toggle("hidden", isLast && !reviewMode);
  els.btnNext.disabled = reviewMode
    ? engine.currentIndex >= engine.length - 1
    : !(engine.currentIndex < engine.length - 1 && hasSelection);

  els.btnFinish.hidden = !isLast || engine.isFinished || reviewMode;
  els.btnFinish.classList.toggle("hidden", !isLast || engine.isFinished || reviewMode);
  els.btnFinish.disabled = !(isLast && hasSelection && !engine.isFinished);

  els.btnBackResult.hidden = !reviewMode;
  els.btnBackResult.classList.toggle("hidden", !reviewMode);
}

function renderResult(summary) {
  stopTimer();
  reviewMode = false;
  showResult();
  persist();

  const pct = Math.round(summary.percent * 100);
  const status = summary.passed ? "Пройден" : "Не пройден";
  els.resultSummary.textContent = `${summary.correct} / ${summary.total} (${pct}%) - ${status}`;
  announce(`Тест завершен. Результат: ${pct} процентов. ${status}.`);
}

function showLoading() {
  els.loading.classList.remove("hidden");
  els.error.classList.add("hidden");
  els.qSection.classList.add("hidden");
  els.quizActions.classList.add("hidden");
  els.result.classList.add("hidden");
}

function showQuiz() {
  els.loading.classList.add("hidden");
  els.error.classList.add("hidden");
  els.result.classList.add("hidden");
  els.reviewHeading.classList.add("hidden");
  els.qSection.classList.remove("hidden");
  els.quizActions.classList.remove("hidden");
}

function showResult() {
  els.loading.classList.add("hidden");
  els.error.classList.add("hidden");
  els.qSection.classList.add("hidden");
  els.quizActions.classList.add("hidden");
  els.result.classList.remove("hidden");
}

function showReview() {
  els.result.classList.add("hidden");
  els.qSection.classList.remove("hidden");
  els.quizActions.classList.remove("hidden");
  els.reviewHeading.classList.remove("hidden");
}

function showError(message) {
  els.loading.classList.add("hidden");
  els.qSection.classList.add("hidden");
  els.quizActions.classList.add("hidden");
  els.result.classList.add("hidden");
  els.errorMessage.textContent = message;
  els.error.classList.remove("hidden");
}

function handleError(error, fallbackMessage) {
  console.error(error);
  showError(error instanceof Error ? error.message : fallbackMessage);
}

function announce(message) {
  els.liveStatus.textContent = message;
}

// ========== Persist ==========
function persist() {
  if (!engine) return;

  try {
    StorageService.saveState(engine.toState());
  } catch (error) {
    console.warn("Quiz progress could not be saved.", error);
  }
}

function createQuizSignature(quiz) {
  const source = JSON.stringify({
    title: quiz.title,
    timeLimitSec: quiz.timeLimitSec ?? DEFAULT_TIME_LIMIT_SEC,
    passThreshold: quiz.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
    })),
  });

  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return `quiz-${hash.toString(16)}`;
}
