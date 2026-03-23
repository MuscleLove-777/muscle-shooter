/* ============================================
   Muscle Shooter - game.js
   MuscleLove Whack-a-mole style game
   ============================================ */

(function () {
  'use strict';

  // ── CONFIG ──
  const GAME_DURATION = 45;
  const GRID_COLS = 3;
  const GRID_ROWS = 4;
  const TOTAL_SLOTS = GRID_COLS * GRID_ROWS;
  const IMG_COUNT = 10;
  const BG_CHANGE_HITS = 10;

  // Target types: emoji, points, probability weight, isBad
  const TARGET_TYPES = [
    { emoji: '🏋️', points: 10, weight: 50, bad: false, label: '+10' },
    { emoji: '🥤', points: 20, weight: 30, bad: false, label: '+20' },
    { emoji: '⭐', points: 30, weight: 10, bad: false, label: '+30' },
    { emoji: '💀', points: -15, weight: 10, bad: true, label: '-15' },
  ];

  // Difficulty curve: [elapsedSeconds, spawnIntervalMs, visibleDurationMs, maxSimultaneous]
  const DIFFICULTY = [
    { after: 0, interval: 1200, visible: 1800, maxActive: 2 },
    { after: 10, interval: 1000, visible: 1500, maxActive: 3 },
    { after: 20, interval: 800, visible: 1200, maxActive: 4 },
    { after: 30, interval: 600, visible: 1000, maxActive: 5 },
    { after: 38, interval: 450, visible: 800, maxActive: 6 },
  ];

  // ── STATE ──
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let totalTaps = 0;
  let goodTaps = 0;
  let timeLeft = GAME_DURATION;
  let gameActive = false;
  let gameTimer = null;
  let spawnTimer = null;
  let bgIndex = 0;
  let hitCount = 0;
  let activeTargets = new Map(); // slotIndex -> { type, timeoutId }

  // ── AUDIO (Web Audio API) ──
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playSound(type) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    switch (type) {
      case 'popup':
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.linearRampToValueAtTime(900, now + 0.08);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      case 'hit':
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.linearRampToValueAtTime(1200, now + 0.06);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
        break;
      case 'miss':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.linearRampToValueAtTime(100, now + 0.15);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
        break;
      case 'bad':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.linearRampToValueAtTime(80, now + 0.3);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
        break;
      case 'combo':
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);
        osc.frequency.linearRampToValueAtTime(1400, now + 0.1);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
        break;
    }
  }

  // ── DOM REFS ──
  const $ = (id) => document.getElementById(id);
  const screens = {
    title: $('screen-title'),
    game: $('screen-game'),
    result: $('screen-result'),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ── GRID SETUP ──
  function buildGrid() {
    const container = $('grid-container');
    container.innerHTML = '';
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = i;

      const target = document.createElement('div');
      target.className = 'target';
      target.dataset.index = i;
      slot.appendChild(target);

      slot.addEventListener('click', () => onSlotTap(i));
      slot.addEventListener('touchstart', (e) => {
        e.preventDefault();
        onSlotTap(i);
      }, { passive: false });

      container.appendChild(slot);
    }
  }

  // ── TARGET SELECTION ──
  function pickTargetType() {
    const totalWeight = TARGET_TYPES.reduce((s, t) => s + t.weight, 0);
    let r = Math.random() * totalWeight;
    for (const t of TARGET_TYPES) {
      r -= t.weight;
      if (r <= 0) return t;
    }
    return TARGET_TYPES[0];
  }

  // ── DIFFICULTY ──
  function getDifficulty() {
    const elapsed = GAME_DURATION - timeLeft;
    let d = DIFFICULTY[0];
    for (const level of DIFFICULTY) {
      if (elapsed >= level.after) d = level;
    }
    return d;
  }

  // ── SPAWN TARGET ──
  function spawnTarget() {
    if (!gameActive) return;

    const diff = getDifficulty();

    // Don't exceed max simultaneous
    if (activeTargets.size >= diff.maxActive) {
      scheduleNextSpawn();
      return;
    }

    // Pick a free slot
    const freeSlots = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      if (!activeTargets.has(i)) freeSlots.push(i);
    }
    if (freeSlots.length === 0) {
      scheduleNextSpawn();
      return;
    }

    const slotIdx = freeSlots[Math.floor(Math.random() * freeSlots.length)];
    const type = pickTargetType();

    const targetEl = document.querySelectorAll('.target')[slotIdx];
    targetEl.textContent = type.emoji;
    targetEl.className = 'target pop-in';

    playSound('popup');

    // Auto-hide after visible duration
    const hideTimeout = setTimeout(() => {
      hideTarget(slotIdx, false);
    }, diff.visible);

    activeTargets.set(slotIdx, { type, timeoutId: hideTimeout });

    scheduleNextSpawn();
  }

  function scheduleNextSpawn() {
    if (!gameActive) return;
    const diff = getDifficulty();
    // Add some randomness to interval
    const jitter = diff.interval * 0.3;
    const delay = diff.interval + (Math.random() * jitter * 2 - jitter);
    spawnTimer = setTimeout(spawnTarget, Math.max(200, delay));
  }

  function hideTarget(slotIdx, wasHit) {
    const data = activeTargets.get(slotIdx);
    if (!data) return;

    clearTimeout(data.timeoutId);
    activeTargets.delete(slotIdx);

    const targetEl = document.querySelectorAll('.target')[slotIdx];

    if (wasHit) {
      targetEl.className = 'target hit-effect';
    } else {
      targetEl.className = 'target pop-out';
      // Missed a good target = break combo
      if (!data.type.bad) {
        // combo = 0; // Optional: don't break combo on miss (more forgiving)
      }
    }

    // Clean up animation class after animation ends
    setTimeout(() => {
      targetEl.className = 'target';
      targetEl.textContent = '';
    }, 350);
  }

  // ── TAP HANDLING ──
  function onSlotTap(slotIdx) {
    if (!gameActive) return;

    const data = activeTargets.get(slotIdx);
    const slotEl = document.querySelectorAll('.slot')[slotIdx];

    if (!data) {
      // Tapped empty slot
      totalTaps++;
      slotEl.classList.remove('flash-miss');
      void slotEl.offsetWidth;
      slotEl.classList.add('flash-miss');
      playSound('miss');
      combo = 0;
      updateHUD();
      return;
    }

    totalTaps++;
    const type = data.type;

    if (type.bad) {
      // Hit a bad target
      goodTaps++; // Still counts as a "hit" for accuracy
      score = Math.max(0, score + type.points);
      combo = 0;
      hideTarget(slotIdx, true);
      slotEl.classList.remove('flash-bad');
      void slotEl.offsetWidth;
      slotEl.classList.add('flash-bad');
      playSound('bad');
      showScorePopup(slotEl, type.points, 'bad');
    } else {
      // Hit a good target
      goodTaps++;
      hitCount++;
      combo++;
      if (combo > maxCombo) maxCombo = combo;

      // Combo bonus
      let comboBonus = 0;
      if (combo >= 10) comboBonus = 5;
      else if (combo >= 5) comboBonus = 3;
      else if (combo >= 3) comboBonus = 1;

      const totalPoints = type.points + comboBonus;
      score += totalPoints;

      hideTarget(slotIdx, true);

      // Visual class
      let popClass = 'good';
      if (type.points >= 30) popClass = 'perfect';
      else if (type.points >= 20) popClass = 'great';

      slotEl.classList.remove('flash-good');
      void slotEl.offsetWidth;
      slotEl.classList.add('flash-good');

      playSound('hit');
      if (combo >= 3) playSound('combo');

      showScorePopup(slotEl, totalPoints, popClass);
      if (combo >= 3) {
        setTimeout(() => {
          showScorePopup(slotEl, combo, 'combo', 'x' + combo + ' COMBO');
        }, 100);
      }

      // Background change every N hits
      if (hitCount % BG_CHANGE_HITS === 0) {
        changeBackground();
      }
    }

    updateHUD();
  }

  // ── SCORE POPUP ──
  function showScorePopup(slotEl, value, cssClass, customText) {
    const popup = document.createElement('div');
    popup.className = 'score-popup ' + cssClass;
    popup.textContent = customText || (value > 0 ? '+' + value : '' + value);

    const rect = slotEl.getBoundingClientRect();
    popup.style.left = rect.left + rect.width / 2 - 30 + 'px';
    popup.style.top = rect.top - 10 + 'px';

    $('score-popups').appendChild(popup);
    setTimeout(() => popup.remove(), 800);
  }

  // ── BACKGROUND ──
  function changeBackground() {
    bgIndex = (bgIndex % IMG_COUNT) + 1;
    $('game-bg').style.backgroundImage = 'url(images/img' + bgIndex + '.png)';
  }

  // ── HUD ──
  function updateHUD() {
    $('hud-score').textContent = score;
    $('hud-time').textContent = timeLeft;
    $('hud-combo').textContent = combo;

    const timeEl = $('hud-time');
    if (timeLeft <= 10) {
      timeEl.classList.add('warning');
    } else {
      timeEl.classList.remove('warning');
    }

    const comboEl = $('hud-combo');
    if (combo >= 3) {
      comboEl.classList.add('active');
    } else {
      comboEl.classList.remove('active');
    }
  }

  // ── GAME FLOW ──
  function startGame() {
    initAudio();

    score = 0;
    combo = 0;
    maxCombo = 0;
    totalTaps = 0;
    goodTaps = 0;
    hitCount = 0;
    timeLeft = GAME_DURATION;
    gameActive = true;
    bgIndex = 0;
    activeTargets.clear();

    buildGrid();
    updateHUD();

    // Set initial background
    bgIndex = Math.floor(Math.random() * IMG_COUNT) + 1;
    $('game-bg').style.backgroundImage = 'url(images/img' + bgIndex + '.png)';

    showScreen('game');

    // Start countdown
    gameTimer = setInterval(() => {
      timeLeft--;
      updateHUD();
      if (timeLeft <= 0) {
        endGame();
      }
    }, 1000);

    // Start spawning
    setTimeout(spawnTarget, 800);
  }

  function endGame() {
    gameActive = false;
    clearInterval(gameTimer);
    clearTimeout(spawnTimer);

    // Clear all active targets
    for (const [idx, data] of activeTargets) {
      clearTimeout(data.timeoutId);
    }
    activeTargets.clear();

    // Small delay before showing results
    setTimeout(showResults, 600);
  }

  function showResults() {
    const accuracy = totalTaps > 0 ? Math.round((goodTaps / totalTaps) * 100) : 0;

    // Rank
    let rank = 'D';
    if (score >= 500) rank = 'SSS';
    else if (score >= 400) rank = 'SS';
    else if (score >= 300) rank = 'S';
    else if (score >= 200) rank = 'A';
    else if (score >= 150) rank = 'B';
    else if (score >= 100) rank = 'C';

    // Result image
    const imgIdx = Math.floor(Math.random() * IMG_COUNT) + 1;
    $('result-img').src = 'images/img' + imgIdx + '.png';

    $('result-score').textContent = score;
    $('result-accuracy').textContent = accuracy + '%';
    $('result-combo').textContent = maxCombo;
    $('result-rank').textContent = rank;

    showScreen('result');
  }

  // ── SHARE ──
  function shareToX() {
    const accuracy = totalTaps > 0 ? Math.round((goodTaps / totalTaps) * 100) : 0;
    const text =
      '【筋肉シューティング】' + score + '点！命中率' + accuracy + '%💪 最大コンボ' + maxCombo + '！\n' +
      '#MuscleLove #MuscleShooter\n' +
      'https://www.patreon.com/cw/MuscleLove';

    const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
    window.open(url, '_blank');
  }

  // ── EVENT LISTENERS ──
  $('btn-start').addEventListener('click', startGame);
  $('btn-retry').addEventListener('click', startGame);
  $('btn-share').addEventListener('click', shareToX);

  // Preload images
  for (let i = 1; i <= IMG_COUNT; i++) {
    const img = new Image();
    img.src = 'images/img' + i + '.png';
  }

})();
