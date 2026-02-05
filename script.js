const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const els = {
  board: document.getElementById('board'),
  status: document.getElementById('status'),
  mode: document.getElementById('mode'),
  difficulty: document.getElementById('difficulty'),
  difficultyWrapper: document.getElementById('difficulty-wrapper'),
  starter: document.getElementById('starter'),
  newGame: document.getElementById('new-game'),
  undo: document.getElementById('undo'),
  resetScore: document.getElementById('reset-score'),
  history: document.getElementById('history'),
  scoreX: document.getElementById('score-x'),
  scoreO: document.getElementById('score-o'),
  scoreDraw: document.getElementById('score-draw'),
  themeToggle: document.getElementById('theme-toggle'),
};

const state = {
  board: Array(9).fill(''),
  current: 'X',
  gameOver: false,
  winnerLine: [],
  moveHistory: [],
  scores: loadScores(),
  rounds: 0,
};

init();

function init() {
  renderBoard();
  renderScores();
  bindEvents();
  applyTheme(loadTheme());
  startGame();
}

function bindEvents() {
  els.mode.addEventListener('change', () => {
    toggleDifficultyVisibility();
    startGame();
  });
  els.difficulty.addEventListener('change', startGame);
  els.starter.addEventListener('change', startGame);
  els.newGame.addEventListener('click', startGame);
  els.undo.addEventListener('click', undoMove);
  els.resetScore.addEventListener('click', () => {
    state.scores = { X: 0, O: 0, draw: 0 };
    saveScores(state.scores);
    renderScores();
    setStatus('Счет сброшен. Игра начинается заново.');
    startGame();
  });
  els.themeToggle.addEventListener('click', () => {
    const next = document.body.classList.contains('light') ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('ttt-theme', next);
  });
}

function renderBoard() {
  els.board.innerHTML = '';
  for (let i = 0; i < 9; i += 1) {
    const btn = document.createElement('button');
    btn.className = 'cell';
    btn.dataset.index = String(i);
    btn.setAttribute('role', 'gridcell');
    btn.setAttribute('aria-label', `Клетка ${i + 1}`);
    btn.addEventListener('click', () => onCellClick(i));
    els.board.appendChild(btn);
  }
}

function startGame() {
  state.rounds += 1;
  state.board = Array(9).fill('');
  state.gameOver = false;
  state.winnerLine = [];
  state.moveHistory = [];
  state.current = determineStarter();
  toggleDifficultyVisibility();
  render();
  syncUndoState();

  if (isAiTurn()) {
    queueAiMove();
  }
}

function determineStarter() {
  const starter = els.starter.value;
  if (starter === 'human') return 'X';
  if (starter === 'ai') return 'O';
  return state.rounds % 2 === 0 ? 'O' : 'X';
}

function onCellClick(index) {
  if (state.gameOver || state.board[index] || isAiTurn()) return;
  playMove(index, state.current);

  if (!state.gameOver && isAiTurn()) {
    queueAiMove();
  }
}

function playMove(index, symbol) {
  state.board[index] = symbol;
  state.moveHistory.push({ index, symbol, board: [...state.board] });
  evaluateGame(symbol);

  if (!state.gameOver) {
    state.current = symbol === 'X' ? 'O' : 'X';
    setStatus(statusText());
  }

  render();
  renderHistory();
  syncUndoState();
}

function evaluateGame(lastSymbol) {
  const winLine = WIN_LINES.find((line) => line.every((i) => state.board[i] === lastSymbol));

  if (winLine) {
    state.gameOver = true;
    state.winnerLine = winLine;
    state.scores[lastSymbol] += 1;
    saveScores(state.scores);
    renderScores();
    setStatus(`Победил ${lastSymbol}!`);
    return;
  }

  if (state.board.every(Boolean)) {
    state.gameOver = true;
    state.scores.draw += 1;
    saveScores(state.scores);
    renderScores();
    setStatus('Ничья!');
  }
}

function queueAiMove() {
  window.setTimeout(() => {
    if (state.gameOver || !isAiTurn()) return;
    const move = chooseAiMove();
    if (move >= 0) playMove(move, 'O');
  }, 260);
}

function chooseAiMove() {
  const empty = getEmptyIndices(state.board);
  if (empty.length === 0) return -1;

  const difficulty = els.difficulty.value;
  if (difficulty === 'easy') {
    return randomItem(empty);
  }

  if (difficulty === 'medium') {
    if (Math.random() < 0.45) return randomItem(empty);
    return bestMove(state.board, 'O');
  }

  if (difficulty === 'hard') {
    if (Math.random() < 0.2) return randomItem(empty);
    return bestMove(state.board, 'O');
  }

  return bestMove(state.board, 'O');
}

function bestMove(board, aiSymbol) {
  const humanSymbol = aiSymbol === 'X' ? 'O' : 'X';
  let bestScore = -Infinity;
  let move = -1;

  for (const idx of getEmptyIndices(board)) {
    board[idx] = aiSymbol;
    const score = minimax(board, 0, false, aiSymbol, humanSymbol, -Infinity, Infinity);
    board[idx] = '';
    if (score > bestScore) {
      bestScore = score;
      move = idx;
    }
  }

  return move;
}

function minimax(board, depth, isMax, ai, human, alpha, beta) {
  const outcome = evaluateBoard(board, ai, human);
  if (outcome !== null) {
    if (outcome === ai) return 10 - depth;
    if (outcome === human) return depth - 10;
    return 0;
  }

  if (isMax) {
    let best = -Infinity;
    for (const idx of getEmptyIndices(board)) {
      board[idx] = ai;
      best = Math.max(best, minimax(board, depth + 1, false, ai, human, alpha, beta));
      board[idx] = '';
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (const idx of getEmptyIndices(board)) {
    board[idx] = human;
    best = Math.min(best, minimax(board, depth + 1, true, ai, human, alpha, beta));
    board[idx] = '';
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

function evaluateBoard(board, ai, human) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }

  if (board.every(Boolean)) return 'draw';
  return null;
}

function undoMove() {
  if (state.moveHistory.length === 0 || state.gameOver) return;
  const mode = els.mode.value;
  if (mode === 'ai') {
    for (let count = 0; count < 2; count += 1) {
      if (state.moveHistory.length === 0) break;
      const last = state.moveHistory.pop();
      state.board[last.index] = '';
    }
  } else {
    const last = state.moveHistory.pop();
    state.board[last.index] = '';
  }

  state.gameOver = false;
  state.winnerLine = [];
  state.current = resolveCurrentByCount(state.board);
  setStatus(statusText());
  render();
  renderHistory();
  syncUndoState();
}

function resolveCurrentByCount(board) {
  const xs = board.filter((v) => v === 'X').length;
  const os = board.filter((v) => v === 'O').length;
  return xs <= os ? 'X' : 'O';
}

function render() {
  const cells = els.board.querySelectorAll('.cell');
  cells.forEach((cell, index) => {
    cell.textContent = state.board[index];
    cell.classList.toggle('filled', Boolean(state.board[index]));
    cell.classList.toggle('win', state.winnerLine.includes(index));
  });
}

function renderHistory() {
  els.history.innerHTML = '';
  state.moveHistory.forEach((move, idx) => {
    const item = document.createElement('li');
    const row = Math.floor(move.index / 3) + 1;
    const col = (move.index % 3) + 1;
    item.textContent = `${idx + 1}. ${move.symbol} → (${row}, ${col})`;
    els.history.appendChild(item);
  });
}

function renderScores() {
  els.scoreX.textContent = String(state.scores.X);
  els.scoreO.textContent = String(state.scores.O);
  els.scoreDraw.textContent = String(state.scores.draw);
}

function statusText() {
  if (isAiTurn()) return 'Ход ИИ (O)…';
  return `Ход игрока ${state.current}`;
}

function setStatus(text) {
  els.status.textContent = text;
}

function isAiTurn() {
  return els.mode.value === 'ai' && state.current === 'O' && !state.gameOver;
}

function toggleDifficultyVisibility() {
  const visible = els.mode.value === 'ai';
  els.difficultyWrapper.style.display = visible ? 'grid' : 'none';
}

function syncUndoState() {
  els.undo.disabled = state.moveHistory.length === 0 || state.gameOver;
}

function getEmptyIndices(board) {
  return board
    .map((cell, idx) => (cell === '' ? idx : -1))
    .filter((idx) => idx !== -1);
}

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function loadScores() {
  try {
    const raw = localStorage.getItem('ttt-scores');
    if (!raw) return { X: 0, O: 0, draw: 0 };
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.X === 'number' &&
      typeof parsed.O === 'number' &&
      typeof parsed.draw === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return { X: 0, O: 0, draw: 0 };
}

function saveScores(scores) {
  localStorage.setItem('ttt-scores', JSON.stringify(scores));
}

function loadTheme() {
  return localStorage.getItem('ttt-theme') || 'dark';
}

function applyTheme(theme) {
  const isLight = theme === 'light';
  document.body.classList.toggle('light', isLight);
  els.themeToggle.textContent = isLight ? '☀️' : '🌙';
}
