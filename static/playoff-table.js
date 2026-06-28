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

  function rowName(row) {
    return row.isSeed || row.source === 'xls-import' ? `${row.name} · XLS` : row.name;
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
    if (!winner && result?.completed && Number.isInteger(result.homeScore) && Number.isInteger(result.awayScore) && result.homeScore !== result.awayScore) {
      winner = result.homeScore > result.awayScore ? result.home : result.away;
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

  function actualScoreForMatch(actual) {
    const result = actual?.result;
    if (!result || !Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore)) return null;
    const teams = actual.teams || [];
    const first = teams[0];
    const second = teams[1];
    if (first && second) {
      if (sameTeam(result.home, first) && sameTeam(result.away, second)) {
        return { homeScore: result.homeScore, awayScore: result.awayScore };
      }
      if (sameTeam(result.home, second) && sameTeam(result.away, first)) {
        return { homeScore: result.awayScore, awayScore: result.homeScore };
      }
    }
    return { homeScore: result.homeScore, awayScore: result.awayScore };
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
    const completed = actuals.filter(item => item.actual.result?.completed && Number.isInteger(item.actual.result.homeScore) && Number.isInteger(item.actual.result.awayScore));
    const values = {
      totalGoals: completed.reduce((sum, item) => sum + item.actual.result.homeScore + item.actual.result.awayScore, 0),
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
    const status = result.live ? `<span class="match-status">ŽIVĚ${result.status ? ` · ${html(result.status)}` : ''}</span>` : '';
    return `<span class="${cls}">${score.homeScore}:${score.awayScore}${status}</span>`;
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
      <div class="kpi"><strong>${leader ? html(leader.name) : '—'}</strong><span>aktuální lídr play-off</span></div>
    `;
  }

  function renderLeaderboard(rows) {
    const table = byId('playoff-results-leaderboard');
    if (!rows.length) {
      table.innerHTML = '<tbody><tr><td class="empty-state">Zatím není odeslaný žádný play-off formulář.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `<thead><tr><th>#</th><th>Hráč</th><th>Typ</th><th>Body</th><th>Odesláno</th></tr></thead><tbody>${rows.map((row, index) => `
      <tr>
        <td class="rank">${index + 1}</td>
        <td><strong>${html(rowName(row))}</strong></td>
        <td><span class="badge ${html(betClass(row.betType))}">${html(betLabel(row.betType))}</span></td>
        <td class="num"><strong>${formatPointNumber(row.total)}</strong></td>
        <td>${row.submittedAt ? new Date(row.submittedAt).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) : '—'}</td>
      </tr>
    `).join('')}</tbody>`;
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
        const cellClass = actual.final ? (pts ? 'hit' : 'miss') : '';
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
    const participantHead = rows.map(row => `<th class="participant-head" data-player="${html(clean(rowName(row)).toLowerCase())}">
      <div class="vertical-name">${html(rowName(row))}</div>
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
        const cellClass = pts.total ? 'hit' : hasActual ? 'miss' : '';
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
    renderKpis(rows);
    renderLeaderboard(rows);
    renderBonuses(rows);
    renderTable(rows);
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
    const [config, siteData, tableData] = await Promise.all([
      loadJson('playoff-data.json', 'playoff-data.json'),
      loadJson('data.json', 'data.json'),
      loadTableData(),
    ]);
    if (!tableData.ok) throw new Error(tableData.error || 'Backend vrátil neplatnou play-off tabulku.');
    model.config = config;
    model.siteData = siteData;
    model.tableData = tableData;
    model.scoreData = await loadScoresBestEffort();
    model.teamFlags = new Map((model.siteData.teams || []).map(team => [team.name, team.flag]));
    renderAll();
  }

  function bind() {
    const refresh = byId('playoff-results-refresh');
    if (refresh) refresh.addEventListener('click', () => loadTable().catch(showError));
    const search = byId('playoff-results-search');
    if (search) search.addEventListener('input', event => { model.search = event.target.value; applySearch(); });
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
