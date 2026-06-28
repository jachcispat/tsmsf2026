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
    return `<div class="team ${html(className)}">${flagImg(name)}<span>${html(name || 'bude doplněno')}</span></div>`;
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

  function calculateSubmission(submission) {
    const matchPoints = {};
    let total = 0;
    for (const match of model.config.matches) {
      const actual = actualForMatch(match);
      const pred = predictionOf(submission, match.id);
      const points = actual.winner && clean(pred.winner) === actual.winner ? roundPoints(match.round) : 0;
      matchPoints[match.id] = points;
      total += points;
    }
    return { ...submission, matchPoints, total };
  }

  function calculatedSubmissions() {
    return (model.tableData?.submissions || []).map(calculateSubmission).sort((a, b) => b.total - a.total || clean(rowName(a)).localeCompare(clean(rowName(b)), 'cs'));
  }

  function formatScoreResult(actual) {
    const result = actual.result;
    if (!result || !Number.isInteger(result.homeScore) || !Number.isInteger(result.awayScore)) return ' : ';
    const cls = result.live ? 'result-live' : result.completed ? 'result-final' : '';
    const status = result.live ? `<span class="match-status">ŽIVĚ${result.status ? ` · ${html(result.status)}` : ''}</span>` : '';
    return `<span class="${cls}">${result.homeScore}:${result.awayScore}${status}</span>`;
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
        <td class="num"><strong>${row.total}</strong></td>
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

    const body = model.config.matches.map(match => {
      const actual = actualForMatch(match);
      const teams = actual.teams;
      const home = teams[0] || match.home;
      const away = teams[1] || match.away;
      const points = roundPoints(match.round);
      const search = `${match.round} ${home} ${away} ${actual.winner}`.toLowerCase();
      const participantCells = rows.map(row => {
        const pred = predictionOf(row, match.id);
        const pts = row.matchPoints[match.id] || 0;
        const hasActual = Boolean(actual.winner);
        const cellClass = pts ? 'hit' : hasActual ? 'miss' : '';
        return `<td class="prediction ${html(betClass(row.betType))} ${cellClass}" data-player="${html(clean(rowName(row)).toLowerCase())}">
          <span class="playoff-tip-score">${html(scoreText(pred))}</span><br>
          <span class="playoff-tip-winner">${html(pred.winner || '—')}</span><br>
          <span class="points-cell">${hasActual ? pts : ''}</span>
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

    const totals = rows.map(row => `<td><strong>${row.total}</strong></td>`).join('');
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
      <td class="sticky pr-col-round" colspan="6">CELKEM ZA PLAY-OFF</td><td class="sticky pr-col-points"></td>${totals}
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
      status.textContent = `Aktualizováno ${updated}. E-maily se na veřejné stránce nezobrazují, jsou pouze v XLSX exportu.`;
    }
  }

  async function loadJson(url, label) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return response.json();
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
      loadJson('/api/playoff-table', '/api/playoff-table'),
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
