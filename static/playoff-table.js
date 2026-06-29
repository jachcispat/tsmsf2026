'use strict';

(() => {
  const model = {
    config: null,
    siteData: null,
    tableData: null,
    scoreData: null,
    teamFlags: new Map(),
    resultsByPair: new Map(),
    actualCache: new Map(),
    adminData: null,
    currentRows: [],
    selectedPlayerId: '',
    search: '',
  };

  const byId = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = (value) => String(value ?? '').trim();
  const html = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

  function normalizeName(value) {
    return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function pairKey(a, b) {
    return [normalizeName(a), normalizeName(b)].sort().join('|');
  }

  function flagImg(teamName) {
    const src = model.teamFlags.get(teamName);
    return src ? `<img class="flag" src="${html(src)}" alt="">` : '';
  }

  function renderTeam(teamName, className = '') {
    const name = clean(teamName);
    const isPlaceholder = /^(vítěz|poražený) utkání/i.test(name);
    const classes = [className, isPlaceholder ? 'placeholder-team' : ''].filter(Boolean).join(' ');
    return `<div class="team ${html(classes)}">${isPlaceholder ? '' : flagImg(name)}<span>${html(name || 'bude doplněno')}</span></div>`;
  }

  function matchById(id) {
    return model.config.matches.find(match => match.id === id);
  }

  function betInfo(betType) {
    return model.config.betTypes.find(item => item.id === betType) || { id: betType || 'normal', label: betType || 'NORMÁLNÍ HRÁČ', className: betType || 'normal' };
  }

  function betClass(betType) {
    const item = betInfo(betType);
    return item.className || item.id || 'normal';
  }

  function betLabel(betType) {
    const item = betInfo(betType);
    const fee = Number.isFinite(Number(item.fee)) ? ` (${item.fee} Kč)` : '';
    return `${item.label || betType || '—'}${fee}`;
  }

  function displayPlayerName(row) {
    const name = clean(row?.name);
    if (normalizeName(name) === 'chatgpt') return 'Dan Mališ';
    return name;
  }

  function rowName(row) {
    const name = displayPlayerName(row);
    if (normalizeName(name) === 'libor') return name;
    return row.isSeed || row.source === 'xls-import' ? `${name} · XLS` : name;
  }

  function playerId(row) {
    return clean(row?.id) || normalizeName(rowName(row));
  }

  function pointsCellClass(pts, hasActual) {
    if (!hasActual) return 'pending';
    const total = number(pts?.total);
    const resultPoints = number(pts?.resultPoints);
    const advancement = number(pts?.advancement);
    if (total <= 0) return 'miss';
    if (resultPoints >= 5 && advancement > 0) return 'hit-full';
    return 'hit-partial';
  }

  function bonusCellClass(points, final) {
    if (!final) return 'pending';
    return number(points) > 0 ? 'hit-bonus' : 'miss';
  }

  function concreteOptions(match) {
    if (Array.isArray(match.winnerOptions) && match.winnerOptions.length) return match.winnerOptions;
    return [match.home, match.away].filter(Boolean);
  }

  function roundPoints(round) {
    const value = clean(round).toLowerCase();
    if (value.includes('1/16')) return 1;
    if (value.includes('osmi')) return 2;
    if (value.includes('čtvrt') || value.includes('ctvrt')) return 3;
    if (value.includes('semi')) return 4;
    if (value.includes('třet') || value.includes('tret') || value.includes('3')) return 5;
    if (value.includes('fin')) return 6;
    return 0;
  }

  const BONUS_ROWS = [
    { id: 'totalGoals', label: 'Počet gólů', points: 8 },
    { id: 'penaltyShootouts', label: 'Počet penaltových rozstřelů', points: 2 },
    { id: 'extraTimes', label: 'Počet prodloužení', points: 2 },
  ];

  function formatMatchPoints(points, hasActual) {
    if (!hasActual) return 'čeká';
    return `${formatPointNumber(points)} b`;
  }

  function sourceLabel(source, fallback) {
    const fallbackText = clean(fallback);
    if (!source || !source.matchId) return fallbackText || 'bude doplněno';
    const type = source.type === 'loser' ? 'Poražený' : 'Vítěz';
    return `${type} utkání ${source.matchId}`;
  }

  function textLooksLikePenalty(text) {
    return /penalt|penalty|pen\.?|pens|pk/i.test(clean(text));
  }

  function textLooksLikeExtraTime(text) {
    return /prodlou|extra time|after extra|\bet\b|aet/i.test(clean(text));
  }

  function eventHasPenaltyShootout(event) {
    if (!event) return false;
    if (event.penaltyShootout || event.shootout || event.decidedByPenalties) return true;
    if (Number.isFinite(Number(event.homePenaltyScore)) || Number.isFinite(Number(event.awayPenaltyScore))) return true;
    return textLooksLikePenalty(`${event.status || ''} ${event.displayClock || ''} ${event.state || ''}`);
  }

  function eventHasExtraTime(event) {
    if (!event) return false;
    if (event.extraTime || event.afterExtraTime || event.decidedAfterExtraTime) return true;
    return textLooksLikeExtraTime(`${event.status || ''} ${event.displayClock || ''} ${event.state || ''}`);
  }

  function sourceEntrants(source, fallback, stack) {
    const fallbackText = clean(fallback);
    if (!source) return fallbackText ? [fallbackText] : [];
    const sourceMatch = matchById(source.matchId);
    if (!sourceMatch) return fallbackText ? [fallbackText] : [];
    const sourceActual = actualForMatch(sourceMatch, stack);
    const sourceTeams = sourceActual.teams.length ? sourceActual.teams : concreteOptions(sourceMatch);
    if (source.type === 'winner') {
      return sourceActual.winner ? [sourceActual.winner] : sourceTeams;
    }
    if (source.type === 'loser') {
      if (sourceActual.winner) return sourceTeams.filter(team => team !== sourceActual.winner);
      return sourceTeams;
    }
    return fallbackText ? [fallbackText] : [];
  }

  function actualEntrants(match, stack = new Set()) {
    if (!match) return [];
    if (stack.has(match.id)) return concreteOptions(match);
    stack.add(match.id);
    const teams = [
      ...sourceEntrants(match.homeSource, match.home, stack),
      ...sourceEntrants(match.awaySource, match.away, stack),
    ].filter(Boolean);
    stack.delete(match.id);
    return [...new Set(teams.length ? teams : concreteOptions(match))];
  }

  function displayEntrant(source, fallback, stack = new Set()) {
    if (!source || !source.matchId) return clean(fallback) || 'bude doplněno';
    const sourceMatch = matchById(source.matchId);
    if (!sourceMatch || stack.has(source.matchId)) return sourceLabel(source, fallback);
    const sourceActual = actualForMatch(sourceMatch, new Set(stack));
    const sourceTeams = sourceActual.teams.length ? sourceActual.teams : concreteOptions(sourceMatch);
    if (source.type === 'winner' && sourceActual.winner) return sourceActual.winner;
    if (source.type === 'loser' && sourceActual.winner) {
      const loser = sourceTeams.find(team => team !== sourceActual.winner);
      if (loser) return loser;
    }
    return sourceLabel(source, fallback);
  }

  function displayTeamsForMatch(match) {
    return [
      displayEntrant(match.homeSource, match.home),
      displayEntrant(match.awaySource, match.away),
    ];
  }

  function actualForMatch(match, stack = new Set()) {
    if (!match) return { teams: [], result: null, winner: '' };
    if (model.actualCache.has(match.id)) return model.actualCache.get(match.id);
    const teams = actualEntrants(match, stack);
    let result = null;
    if (teams.length === 2) result = model.resultsByPair.get(pairKey(teams[0], teams[1])) || null;
    let winner = clean(result?.winner);
    if (!winner && result?.completed) {
      const finalHome = pickScore(result, ['finalHomeScore', 'homeFinalScore', 'homeScore']);
      const finalAway = pickScore(result, ['finalAwayScore', 'awayFinalScore', 'awayScore']);
      if (finalHome != null && finalAway != null && finalHome !== finalAway) {
        winner = finalHome > finalAway ? result.home : result.away;
      }
    }
    const payload = { teams, result, winner };
    model.actualCache.set(match.id, payload);
    return payload;
  }

  function buildResultMap() {
    model.resultsByPair.clear();
    (model.scoreData?.events || []).forEach(event => {
      if (!event.home || !event.away) return;
      if (!event.completed && !event.live) return;
      model.resultsByPair.set(pairKey(event.home, event.away), event);
    });
    model.actualCache.clear();
  }

  function predictionOf(submission, matchId) {
    return (submission.predictions && submission.predictions[matchId]) || {};
  }

  function scoreText(pred) {
    if (pred.homeGoals === '' || pred.awayGoals === '' || pred.homeGoals == null || pred.awayGoals == null) return '—';
    return `${pred.homeGoals}:${pred.awayGoals}`;
  }

  function sameTeam(a, b) {
    return normalizeName(a) === normalizeName(b);
  }

  function parseGoal(value) {
    if (value === '' || value == null) return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
  }

  function formatPointNumber(value) {
    const numeric = number(value);
    return Number.isInteger(numeric) ? String(numeric) : numeric.toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
  }

  function scoreNumber(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : null;
  }

  function pickScore(result, keys) {
    for (const key of keys) {
      const value = scoreNumber(result?.[key]);
      if (value != null) return value;
    }
    return null;
  }

  function orientScore(actual, homeValue, awayValue) {
    if (homeValue == null || awayValue == null) return null;
    const result = actual?.result;
    const teams = actual?.teams || [];
    const first = teams[0];
    const second = teams[1];
    if (result && first && second) {
      if (sameTeam(result.home, first) && sameTeam(result.away, second)) {
        return { homeScore: homeValue, awayScore: awayValue };
      }
      if (sameTeam(result.home, second) && sameTeam(result.away, first)) {
        return { homeScore: awayValue, awayScore: homeValue };
      }
    }
    return { homeScore: homeValue, awayScore: awayValue };
  }

  function actualScoreForMatch(actual) {
    const result = actual?.result;
    if (!result) return null;
    // Základní hrací doba je hlavní skóre pro bodování i bonus celkových gólů.
    const homeValue = pickScore(result, ['regulationHomeScore', 'homeRegulationScore', 'homeScore']);
    const awayValue = pickScore(result, ['regulationAwayScore', 'awayRegulationScore', 'awayScore']);
    return orientScore(actual, homeValue, awayValue);
  }

  function finalScoreForMatch(actual) {
    const result = actual?.result;
    if (!result) return null;
    const homeValue = pickScore(result, ['finalHomeScore', 'homeFinalScore', 'homeScore']);
    const awayValue = pickScore(result, ['finalAwayScore', 'awayFinalScore', 'awayScore']);
    return orientScore(actual, homeValue, awayValue);
  }

  function penaltyScoreForMatch(actual) {
    const result = actual?.result;
    if (!result) return null;
    const homeValue = pickScore(result, ['homePenaltyScore', 'penaltyHomeScore', 'homeShootoutScore']);
    const awayValue = pickScore(result, ['awayPenaltyScore', 'penaltyAwayScore', 'awayShootoutScore']);
    return orientScore(actual, homeValue, awayValue);
  }

  function resultBasePoints(pred, actual) {
    if (!actual?.result?.completed) return { points: 0, label: 'čeká' };
    const score = actualScoreForMatch(actual);
    if (!score) return { points: 0, label: 'čeká' };
    const tipHome = parseGoal(pred.homeGoals);
    const tipAway = parseGoal(pred.awayGoals);
    if (tipHome == null || tipAway == null) return { points: 0, label: 'bez tipu' };

    const actualDiff = score.homeScore - score.awayScore;
    const tipDiff = tipHome - tipAway;

    if (tipHome === score.homeScore && tipAway === score.awayScore) return { points: 5, label: 'přesně' };
    if (actualDiff === 0 && tipDiff === 0) return { points: 3, label: 'remíza' };
    if (actualDiff !== 0 && tipDiff === actualDiff) return { points: 3, label: 'rozdíl' };
    if ((actualDiff > 0 && tipDiff > 0) || (actualDiff < 0 && tipDiff < 0)) return { points: 1, label: 'vítěz' };
    return { points: 0, label: 'netrefeno' };
  }

  function predictedSourceEntrant(source, fallback, submission, stack) {
    const fallbackText = clean(fallback);
    if (!source || !source.matchId) return fallbackText || '';
    const sourceMatch = matchById(source.matchId);
    if (!sourceMatch || stack.has(source.matchId)) return sourceLabel(source, fallback);
    const sourcePred = predictionOf(submission, source.matchId);
    const predictedWinner = clean(sourcePred.winner);
    if (source.type === 'winner') return predictedWinner || sourceLabel(source, fallback);
    if (source.type === 'loser') {
      const teams = predictedEntrants(sourceMatch, submission, new Set(stack));
      if (predictedWinner && teams.length >= 2) {
        const loser = teams.find(team => !sameTeam(team, predictedWinner));
        if (loser) return loser;
      }
      return sourceLabel(source, fallback);
    }
    return fallbackText || '';
  }

  function predictedEntrants(match, submission, stack = new Set()) {
    if (!match) return [];
    if (stack.has(match.id)) return concreteOptions(match);
    stack.add(match.id);
    const teams = [
      predictedSourceEntrant(match.homeSource, match.home, submission, stack),
      predictedSourceEntrant(match.awaySource, match.away, submission, stack),
    ].filter(Boolean);
    stack.delete(match.id);
    return teams.length ? teams : concreteOptions(match);
  }

  function hasBothActualTeams(match, submission, actual) {
    const actualTeams = actual?.teams || [];
    if (actualTeams.length !== 2) return true;
    const predictedTeams = predictedEntrants(match, submission).filter(team => !/^(vítěz|poražený) utkání/i.test(clean(team)));
    if (predictedTeams.length !== 2) return true;
    return actualTeams.every(actualTeam => predictedTeams.some(predictedTeam => sameTeam(actualTeam, predictedTeam)));
  }

  function scoreMatch(match, submission) {
    const actual = actualForMatch(match);
    const pred = predictionOf(submission, match.id);
    const advancement = actual.winner && sameTeam(pred.winner, actual.winner) ? roundPoints(match.round) : 0;
    const base = resultBasePoints(pred, actual);
    const ghost = base.points > 0 && !hasBothActualTeams(match, submission, actual);
    const resultPoints = ghost ? base.points / 2 : base.points;
    const total = advancement + resultPoints;
    return {
      advancement,
      resultPoints,
      resultBasePoints: base.points,
      resultLabel: base.label,
      ghost,
      total,
      hasActual: Boolean(actual?.result?.completed && actualScoreForMatch(actual)),
    };
  }

  function playoffActuals() {
    return model.config.matches.map(match => ({ match, actual: actualForMatch(match) }));
  }

  function bonusActualValues() {
    const actuals = playoffActuals();
    const completed = actuals
      .map(item => ({ ...item, score: actualScoreForMatch(item.actual) }))
      .filter(item => item.actual.result?.completed && item.score);
    const values = {
      // Bonus celkových gólů se počítá jen ze základní hrací doby.
      totalGoals: completed.reduce((sum, item) => sum + item.score.homeScore + item.score.awayScore, 0),
      penaltyShootouts: completed.filter(item => eventHasPenaltyShootout(item.actual.result)).length,
      extraTimes: completed.filter(item => eventHasExtraTime(item.actual.result)).length,
    };
    return {
      values,
      completed: completed.length,
      totalMatches: actuals.length,
      final: completed.length === actuals.length && actuals.length > 0,
    };
  }

  function calculateBonusPointsForRows(rows) {
    const actual = bonusActualValues();
    rows.forEach(row => { row.bonusPoints = { totalGoals: 0, penaltyShootouts: 0, extraTimes: 0 }; });
    if (!actual.final) return;

    rows.forEach(row => {
      for (const bonus of BONUS_ROWS.filter(item => item.id !== 'totalGoals')) {
        const tip = Number(row.bonuses?.[bonus.id]);
        row.bonusPoints[bonus.id] = Number.isFinite(tip) && tip === actual.values[bonus.id] ? bonus.points : 0;
      }
    });

    const totalGoalsBonus = BONUS_ROWS.find(item => item.id === 'totalGoals');
    const goalTips = rows
      .map(row => ({ row, tip: Number(row.bonuses?.totalGoals) }))
      .filter(item => Number.isFinite(item.tip));
    const exactExists = goalTips.some(item => item.tip === actual.values.totalGoals);
    if (exactExists) {
      goalTips.forEach(item => { item.row.bonusPoints.totalGoals = item.tip === actual.values.totalGoals ? totalGoalsBonus.points : 0; });
    } else if (goalTips.length) {
      const bestDiff = Math.min(...goalTips.map(item => Math.abs(item.tip - actual.values.totalGoals)));
      goalTips.forEach(item => { item.row.bonusPoints.totalGoals = Math.abs(item.tip - actual.values.totalGoals) === bestDiff ? 4 : 0; });
    }
  }

  function calculateSubmissionBase(submission) {
    const matchPoints = {};
    let matchTotal = 0;
    for (const match of model.config.matches) {
      const points = scoreMatch(match, submission);
      matchPoints[match.id] = points;
      matchTotal += points.total;
    }
    return { ...submission, matchPoints, bonusPoints: {}, matchTotal, bonusTotal: 0, total: matchTotal };
  }

  function calculatedSubmissions() {
    const rows = (model.tableData?.submissions || []).map(calculateSubmissionBase);
    calculateBonusPointsForRows(rows);
    rows.forEach(row => {
      row.bonusTotal = Object.values(row.bonusPoints).reduce((sum, value) => sum + number(value), 0);
      row.total = row.matchTotal + row.bonusTotal;
    });
    return rows.sort((a, b) => b.total - a.total || clean(rowName(a)).localeCompare(clean(rowName(b)), 'cs'));
  }

  function formatScoreResult(actual) {
    const result = actual.result;
    const score = actualScoreForMatch(actual);
    if (!result || !score) return ' : ';
    const cls = result.live ? 'result-live' : result.completed ? 'result-final' : '';
    const finalScore = finalScoreForMatch(actual);
    const penaltyScore = penaltyScoreForMatch(actual);
    const suffixes = [];
    if (finalScore && (finalScore.homeScore !== score.homeScore || finalScore.awayScore !== score.awayScore)) {
      suffixes.push(`${finalScore.homeScore}:${finalScore.awayScore} pp`);
    }
    if (penaltyScore) {
      suffixes.push(`${penaltyScore.homeScore}:${penaltyScore.awayScore} pen.`);
    }
    const afterText = suffixes.length ? ` <span class="after-regular-time">(${html(suffixes.join(', '))})</span>` : '';
    const status = result.live ? `<span class="match-status">ŽIVĚ${result.status ? ` · ${html(result.status)}` : ''}</span>` : '';
    return `<span class="${cls}">${score.homeScore}:${score.awayScore}${afterText}${status}</span>`;
  }

  function renderKpis(rows) {
    const completed = model.config.matches.filter(match => actualForMatch(match).winner).length;
    const leader = rows[0];
    const totalSubmissions = model.tableData?.totalSubmissions || 0;
    const activeSubmissions = model.tableData?.activeSubmissions || 0;
    byId('playoff-results-kpis').innerHTML = `
      <div class="kpi"><strong>${activeSubmissions}</strong><span>hráčů v tabulce</span></div>
      <div class="kpi"><strong>${totalSubmissions}</strong><span>celkem odeslaných formulářů</span></div>
      <div class="kpi"><strong>${completed}/32</strong><span>zápasů s výsledkem</span></div>
      <div class="kpi"><strong>${leader ? html(rowName(leader)) : '—'}</strong><span>aktuální lídr play-off</span></div>
    `;
  }

  function renderLeaderboard(rows) {
    const table = byId('playoff-results-leaderboard');
    if (!rows.length) {
      table.innerHTML = '<tbody><tr><td class="empty-state">Zatím není odeslaný žádný play-off formulář.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `<thead><tr><th>#</th><th>Hráč</th><th>Typ</th><th>Body</th><th>Odesláno</th></tr></thead><tbody>${rows.map((row, index) => `
      <tr class="leaderboard-row" data-player-id="${html(playerId(row))}">
        <td class="rank">${index + 1}</td>
        <td><button type="button" class="player-detail-button" data-player-id="${html(playerId(row))}"><strong>${html(rowName(row))}</strong></button></td>
        <td><span class="badge ${html(betClass(row.betType))}">${html(betLabel(row.betType))}</span></td>
        <td class="num"><strong>${formatPointNumber(row.total)}</strong></td>
        <td>${row.submittedAt ? new Date(row.submittedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) : '—'}</td>
      </tr>
    `).join('')}</tbody>`;
  }

  function renderAdminSummary() {
    const target = byId('playoff-admin-summary');
    if (!target) return;
    const data = model.adminData;
    if (!data?.ok) {
      target.innerHTML = '<p class="muted">Admin souhrn zatím není dostupný.</p>';
      return;
    }
    const c = data.counts || {};
    const dup = data.duplicates || {};
    const gs = data.googleSheets || {};
    const storage = data.storage || {};
    const dupList = (dup.groups || []).length
      ? `<ul>${dup.groups.map(group => `<li>${html(group.label)} · ${html((group.names || []).join(', ') || 'bez jména')} · ${group.count}× · zdroje: ${html((group.sources || []).join(', '))}</li>`).join('')}</ul>`
      : '<span class="ok-pill">žádné viditelné duplicity</span>';
    target.innerHTML = `
      <div class="admin-card"><strong>${html(c.publicRows ?? '—')}</strong><span>řádků ve veřejné tabulce</span></div>
      <div class="admin-card"><strong>${html(c.totalRaw ?? '—')}</strong><span>raw záznamů před deduplikací</span></div>
      <div class="admin-card"><strong>${html(c.googleSheets ?? '—')}</strong><span>Google Sheets</span></div>
      <div class="admin-card"><strong>${html(c.seed ?? '—')}</strong><span>XLS/seed fallback</span></div>
      <div class="admin-card wide"><strong>Priority zdrojů</strong><span>${html((data.sourcePriority || []).join(' → '))}</span></div>
      <div class="admin-card wide"><strong>Google Sheets</strong><span>${gs.enabled ? 'zapnuto' : 'vypnuto'} · lastError: ${html(gs.lastError || 'bez chyby')}</span></div>
      <div class="admin-card wide"><strong>Duplicity</strong><span>skryté řádky: ${html(dup.hiddenRows ?? 0)}</span>${dupList}</div>
      <div class="admin-card wide"><strong>Ukládání</strong><span>${html(storage.dataDir || '')}${storage.dataDirWarning ? ` · ${html(storage.dataDirWarning)}` : ''}</span></div>
    `;
  }

  function renderPlayerDetail(row) {
    const target = byId('playoff-player-detail');
    if (!target) return;
    if (!row) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }
    const completedMatches = model.config.matches.filter(match => row.matchPoints?.[match.id]?.hasActual);
    const hits = completedMatches.filter(match => number(row.matchPoints?.[match.id]?.total) > 0).length;
    const best = completedMatches
      .map(match => ({ match, pts: row.matchPoints?.[match.id] || {} }))
      .sort((a, b) => number(b.pts.total) - number(a.pts.total))[0];
    const matchRows = model.config.matches.map(match => {
      const pred = predictionOf(row, match.id);
      const pts = row.matchPoints?.[match.id] || {};
      return `<tr><td>${html(match.id)}</td><td>${html(match.round)}</td><td>${html(scoreText(pred))}</td><td>${html(pred.winner || '—')}</td><td>${html(pts.hasActual ? formatPointNumber(pts.total) : 'čeká')}</td><td>${html(pts.hasActual ? `P:${formatPointNumber(pts.advancement)} V:${formatPointNumber(pts.resultPoints)}` : '')}</td></tr>`;
    }).join('');
    target.hidden = false;
    target.innerHTML = `
      <div class="player-detail-header">
        <div>
          <h3>Detail hráče: ${html(rowName(row))}</h3>
          <p>${html(betLabel(row.betType))} · celkem <strong>${formatPointNumber(row.total)} b</strong> · zápasy ${formatPointNumber(row.matchTotal)} b · bonusy ${formatPointNumber(row.bonusTotal)} b</p>
        </div>
        <button type="button" class="player-detail-close" aria-label="Zavřít detail">×</button>
      </div>
      <div class="player-detail-stats">
        <div><strong>${hits}/${completedMatches.length}</strong><span>bodovaných dokončených zápasů</span></div>
        <div><strong>${best ? html(best.match.id) : '—'}</strong><span>nejlepší zápas (${best ? formatPointNumber(best.pts.total) : 0} b)</span></div>
        <div><strong>${formatPointNumber(row.bonusTotal)}</strong><span>bonusové body</span></div>
      </div>
      <div class="table-wrap compact player-detail-table-wrap"><table class="player-detail-table"><thead><tr><th>Zápas</th><th>Kolo</th><th>Tip</th><th>Postupující</th><th>Body</th><th>Rozpad</th></tr></thead><tbody>${matchRows}</tbody></table></div>
    `;
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderBonuses(rows) {
    const fields = model.config.bonusFields || [];
    const table = byId('playoff-results-bonuses');
    if (!rows.length) {
      table.innerHTML = '<tbody><tr><td class="empty-state">Bonusové tipy se zobrazí po prvním odeslání formuláře.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `<thead><tr><th>Hráč</th>${fields.map(field => `<th>${html(field.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `
      <tr>
        <td><strong>${html(rowName(row))}</strong></td>
        ${fields.map(field => `<td>${html(row.bonuses?.[field.id] ?? '—')}</td>`).join('')}
      </tr>
    `).join('')}</tbody>`;
  }

  function renderBonusRows(rows) {
    const actual = bonusActualValues();
    return BONUS_ROWS.map(bonus => {
      const value = actual.values[bonus.id];
      const actualText = actual.final ? String(value) : `${value} / zatím ${actual.completed}/${actual.totalMatches} zápasů`;
      const participantCells = rows.map(row => {
        const tip = row.bonuses?.[bonus.id];
        const pts = row.bonusPoints?.[bonus.id] || 0;
        const cellClass = bonusCellClass(pts, actual.final);
        return `<td class="prediction bonus-prediction ${html(betClass(row.betType))} ${cellClass}" data-player="${html(clean(rowName(row)).toLowerCase())}">
          <span class="playoff-tip-score">${html(tip ?? '—')}</span><br>
          <span class="playoff-tip-winner">tip</span><br>
          <span class="points-cell">${actual.final ? `${formatPointNumber(pts)} b` : 'čeká'}</span>
        </td>`;
      }).join('');
      const search = `bonus ${bonus.label} ${actualText}`.toLowerCase();
      return `<tr class="bonus-row" data-search="${html(search)}">
        <td class="sticky pr-col-round">Bonus</td>
        <td class="sticky pr-col-date"></td>
        <td class="sticky pr-col-home">${html(bonus.label)}</td>
        <td class="sticky pr-col-result">${html(actualText)}</td>
        <td class="sticky pr-col-away"></td>
        <td class="sticky pr-col-winner">${actual.final ? 'vyhodnoceno' : 'čeká na konec'}</td>
        <td class="sticky pr-col-points">${bonus.points}</td>
        ${participantCells}
      </tr>`;
    }).join('');
  }

  function renderTable(rows) {
    const table = byId('playoff-results-table');
    if (!rows.length) {
      table.innerHTML = '<tbody><tr><td class="empty-state">Zatím není co zobrazit. Po odeslání formulářů se zde objeví play-off tabulka.</td></tr></tbody>';
      return;
    }
    const participantHead = rows.map(row => `<th class="participant-head" data-player="${html(clean(rowName(row)).toLowerCase())}" data-player-id="${html(playerId(row))}">
      <button type="button" class="vertical-name player-detail-button" data-player-id="${html(playerId(row))}">${html(rowName(row))}</button>
      <div class="participant-meta"><span class="badge ${html(betClass(row.betType))}">${html(betLabel(row.betType)).replace(' HRÁČ', '')}</span></div>
    </th>`).join('');

    const matchRows = model.config.matches.map(match => {
      const actual = actualForMatch(match);
      const displayTeams = displayTeamsForMatch(match);
      const home = displayTeams[0];
      const away = displayTeams[1];
      const points = roundPoints(match.round);
      const search = `${match.round} ${home} ${away} ${actual.winner}`.toLowerCase();
      const participantCells = rows.map(row => {
        const pred = predictionOf(row, match.id);
        const pts = row.matchPoints[match.id] || { total: 0, advancement: 0, resultPoints: 0, hasActual: false };
        const hasActual = pts.hasActual;
        const cellClass = pointsCellClass(pts, hasActual);
        const detail = hasActual
          ? `postup ${formatPointNumber(pts.advancement)} + výsledek ${formatPointNumber(pts.resultPoints)}${pts.ghost ? ' (½ tým duchů)' : ''}`
          : 'čeká na výsledek';
        return `<td class="prediction ${html(betClass(row.betType))} ${cellClass}" data-player="${html(clean(rowName(row)).toLowerCase())}">
          <span class="playoff-tip-score">${html(scoreText(pred))}</span><br>
          <span class="playoff-tip-winner">${html(pred.winner || '—')}</span><br>
          <span class="points-cell">${html(formatMatchPoints(pts.total, hasActual))}</span><br>
          <span class="points-detail">${html(detail)}</span>
        </td>`;
      }).join('');
      return `<tr data-search="${html(search)}">
        <td class="sticky pr-col-round">${html(match.round)}</td>
        <td class="sticky pr-col-date">${html(match.day || '')} ${html(match.dateTime || '')}</td>
        <td class="sticky pr-col-home">${renderTeam(home, 'away')}</td>
        <td class="sticky pr-col-result">${formatScoreResult(actual)}</td>
        <td class="sticky pr-col-away">${renderTeam(away)}</td>
        <td class="sticky pr-col-winner">${html(actual.winner || '—')}</td>
        <td class="sticky pr-col-points">${points}</td>
        ${participantCells}
      </tr>`;
    }).join('');

    const body = matchRows + renderBonusRows(rows);
    const totals = rows.map(row => `<td><strong>${formatPointNumber(row.total)}</strong></td>`).join('');
    table.innerHTML = `<thead><tr>
      <th class="sticky pr-col-round corner">Kolo</th>
      <th class="sticky pr-col-date corner">Datum / čas</th>
      <th class="sticky pr-col-home corner">Tým 1</th>
      <th class="sticky pr-col-result corner">Výsledek</th>
      <th class="sticky pr-col-away corner">Tým 2</th>
      <th class="sticky pr-col-winner corner">Skutečný vítěz</th>
      <th class="sticky pr-col-points corner">B</th>
      ${participantHead}
    </tr></thead><tbody>${body}</tbody><tfoot><tr>
      <td class="sticky pr-col-round" colspan="6">CELKEM ZA PLAY-OFF + BONUSY</td><td class="sticky pr-col-points"></td>${totals}
    </tr></tfoot>`;
    applySearch();
  }

  function applySearch() {
    const needle = clean(model.search).toLowerCase();
    qsa('#playoff-results-table tbody tr').forEach(row => {
      const teamHit = row.dataset.search.includes(needle);
      let playerHit = !needle;
      if (needle) playerHit = [...row.querySelectorAll('[data-player]')].some(cell => cell.dataset.player.includes(needle));
      row.classList.toggle('hidden', Boolean(needle) && !teamHit && !playerHit);
    });
  }

  function renderAll() {
    buildResultMap();
    const rows = calculatedSubmissions();
    model.currentRows = rows;
    renderKpis(rows);
    renderAdminSummary();
    renderLeaderboard(rows);
    renderBonuses(rows);
    renderTable(rows);
    if (model.selectedPlayerId) {
      renderPlayerDetail(rows.find(row => playerId(row) === model.selectedPlayerId));
    }
    const status = byId('playoff-results-status');
    if (status) {
      const updated = model.tableData?.generatedAt ? new Date(model.tableData.generatedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) : '—';
      const fallbackNote = model.tableData?.warning ? ` ${model.tableData.warning}` : '';
      status.textContent = `Aktualizováno ${updated}. E-maily se na veřejné stránce nezobrazují, jsou pouze v XLSX exportu.${fallbackNote}`;
    }
  }

  async function loadJson(url, label) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return response.json();
  }

  async function loadTableData() {
    try {
      return await loadJson('/api/playoff-table', '/api/playoff-table');
    } catch (apiError) {
      const seeded = await loadJson('playoff-initial-submissions.json', 'playoff-initial-submissions.json');
      if (!Array.isArray(seeded) || !seeded.length) throw apiError;
      const submissions = seeded
        .filter(item => item && typeof item === 'object')
        .map(item => ({ ...item, source: item.source || 'xls-import', isSeed: true }));
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        totalSubmissions: submissions.length,
        activeSubmissions: submissions.length,
        seedSubmissions: submissions.length,
        storedSubmissions: 0,
        warning: `Backend API je teď nedostupné (${apiError.message}); zobrazuji alespoň tipy importované z XLSX.`,
        submissions,
      };
    }
  }

  async function loadAdminSummary() {
    try {
      return await loadJson('/api/playoff-admin-summary', '/api/playoff-admin-summary');
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function loadScoresBestEffort() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch('/api/scores', { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      return response.ok ? await response.json() : { events: [] };
    } catch (_error) {
      return { events: [] };
    }
  }

  async function loadTable() {
    const status = byId('playoff-results-status');
    if (status) status.textContent = 'Načítám play-off tabulku…';
    const [config, siteData, tableData, adminData] = await Promise.all([
      loadJson('playoff-data.json', 'playoff-data.json'),
      loadJson('data.json', 'data.json'),
      loadTableData(),
      loadAdminSummary(),
    ]);
    if (!tableData.ok) throw new Error(tableData.error || 'Backend vrátil neplatnou play-off tabulku.');
    model.config = config;
    model.siteData = siteData;
    model.tableData = tableData;
    model.adminData = adminData;
    model.scoreData = await loadScoresBestEffort();
    model.teamFlags = new Map((model.siteData.teams || []).map(team => [team.name, team.flag]));
    renderAll();
  }

  function bind() {
    const refresh = byId('playoff-results-refresh');
    if (refresh) refresh.addEventListener('click', () => loadTable().catch(showError));
    const search = byId('playoff-results-search');
    if (search) search.addEventListener('input', event => { model.search = event.target.value; applySearch(); });
    document.addEventListener('click', event => {
      const detailButton = event.target.closest('.player-detail-button');
      if (detailButton) {
        model.selectedPlayerId = detailButton.dataset.playerId || '';
        renderPlayerDetail(model.currentRows.find(row => playerId(row) === model.selectedPlayerId));
      }
      if (event.target.closest('.player-detail-close')) {
        model.selectedPlayerId = '';
        renderPlayerDetail(null);
      }
    });
    window.addEventListener('playoff-submitted', () => loadTable().catch(showError));
  }

  function showError(error) {
    const status = byId('playoff-results-status');
    if (status) status.textContent = `Play-off tabulku se nepodařilo načíst: ${error.message}`;
  }

  window.addEventListener('DOMContentLoaded', () => {
    bind();
    loadTable().catch(showError);
  });
})();
