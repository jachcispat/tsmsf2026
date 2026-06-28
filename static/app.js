'use strict';

const state = {
  data: null,
  api: null,
  results: new Map(),
  calculations: null,
  league: 'all',
  search: '',
  refreshTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizeName(value) {
  return (value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resultKey(home, away) {
  return `${normalizeName(home)}|${normalizeName(away)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function typeClass(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('ZLAT')) return 'gold';
  if (t.includes('STŘÍ') || t.includes('STRI')) return 'silver';
  return 'normal';
}

function typeLabel(type) {
  const cls = typeClass(type);
  return cls === 'gold' ? 'ZLATÝ' : cls === 'silver' ? 'STŘÍBRNÝ' : 'NORMÁLNÍ';
}

function isPaid(payment) {
  return !(payment || '').toUpperCase().includes('NEZAPLACENO');
}

function formatPoints(value, digits = 1) {
  return Number(value || 0).toLocaleString('cs-CZ', {minimumFractionDigits: digits, maximumFractionDigits: digits});
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(iso));
}

function flagFor(teamName) {
  const team = state.data.teams.find(t => t.name === teamName);
  return team?.flag ? `<img class="flag" src="${escapeHtml(team.flag)}" alt="">` : '';
}

function activeParticipants() {
  return state.data.participants.filter(p => p.predictions.some(x => Number.isInteger(x.home) && Number.isInteger(x.away)));
}

function calculateEverything() {
  const active = activeParticipants();
  const pointsByParticipant = new Map(state.data.participants.map(p => [p.id, Array(state.data.matches.length).fill(0)]));
  const coefficientByMatch = Array(state.data.matches.length).fill(0);
  const completed = [];
  const live = [];
  const scored = [];

  state.data.matches.forEach((match, index) => {
    const result = state.results.get(resultKey(match.home, match.away));
    const hasScore = Number.isInteger(result?.homeScore) && Number.isInteger(result?.awayScore);
    if (!hasScore || (!result?.completed && !result?.live)) return;
    scored.push(index);
    if (result.completed) completed.push(index);
    if (result.live) live.push(index);

    let correctCount = 0;
    // Stejně jako původní XLSX: do jmenovatele koeficientu vstupují všechny
    // hráčské sloupce. Prázdná tipovací buňka se v aritmetice Calc/Excel chová
    // jako nula; samotné body ale prázdný tip nikdy nedostane.
    state.data.participants.forEach(player => {
      const tip = player.predictions[index];
      const tipHome = Number.isInteger(tip.home) ? tip.home : 0;
      const tipAway = Number.isInteger(tip.away) ? tip.away : 0;
      const actualDiff = result.homeScore - result.awayScore;
      const tipDiff = tipHome - tipAway;
      const correctOutcome = (actualDiff > 0 && tipDiff > 0) || (actualDiff < 0 && tipDiff < 0);
      const correctDiff = actualDiff === tipDiff;
      const exact = result.homeScore === tipHome && result.awayScore === tipAway;
      if (exact || correctDiff || correctOutcome) correctCount += 1;
    });

    if (!correctCount) return;
    const x = Math.round((active.length / correctCount) * 10) / 10;
    const coefficient = x * (1 / Math.pow(x, 1 / 5));
    coefficientByMatch[index] = coefficient;

    active.forEach(player => {
      const tip = player.predictions[index];
      if (!Number.isInteger(tip.home) || !Number.isInteger(tip.away)) return;
      const actualDiff = result.homeScore - result.awayScore;
      const tipDiff = tip.home - tip.away;
      let base = 0;
      if (result.homeScore === tip.home && result.awayScore === tip.away) base = 5;
      else if (actualDiff === tipDiff) base = 3;
      else if (Math.sign(actualDiff) === Math.sign(tipDiff)) base = 1;
      pointsByParticipant.get(player.id)[index] = base * coefficient;
    });
  });

  const actualGoals = scored.reduce((sum, idx) => {
    const r = state.results.get(resultKey(state.data.matches[idx].home, state.data.matches[idx].away));
    return sum + r.homeScore + r.awayScore;
  }, 0);

  const bonuses = new Map(state.data.participants.map(p => [p.id, 0]));
  if (completed.length === state.data.matches.length && active.length) {
    const subtotal = active.reduce((sum, p) => sum + pointsByParticipant.get(p.id).reduce((a,b) => a+b, 0), 0);
    const average = subtotal / active.length;
    const exact = active.filter(p => p.totalGoalsTip === actualGoals);
    if (exact.length) exact.forEach(p => bonuses.set(p.id, average / 3));
    else {
      const distances = active.filter(p => Number.isInteger(p.totalGoalsTip)).map(p => Math.abs(p.totalGoalsTip - actualGoals));
      const nearest = Math.min(...distances);
      active.filter(p => Math.abs(p.totalGoalsTip - actualGoals) === nearest).forEach(p => bonuses.set(p.id, average / 6));
    }
  }

  const totals = state.data.participants.map(player => ({
    ...player,
    matchPoints: pointsByParticipant.get(player.id),
    bonus: bonuses.get(player.id) || 0,
    total: pointsByParticipant.get(player.id).reduce((a,b) => a+b, 0) + (bonuses.get(player.id) || 0),
    active: active.some(p => p.id === player.id),
  }));

  state.calculations = {active, pointsByParticipant, coefficientByMatch, completed, live, scored, actualGoals, bonuses, totals};
}

function calculateStandings() {
  const rankings = {};
  for (const group of 'ABCDEFGHIJKL') {
    const teams = state.data.teams.filter(t => t.group === group).map(t => ({
      name: t.name, flag: t.flag, fifaPoints: t.fifaPoints || 0, played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0,
    }));
    const byName = new Map(teams.map(t => [t.name, t]));
    const relevantMatches = state.data.matches.filter(m => m.group === group);
    relevantMatches.forEach(match => {
      const r = state.results.get(resultKey(match.home, match.away));
      if ((!r?.completed && !r?.live) || !Number.isInteger(r?.homeScore) || !Number.isInteger(r?.awayScore)) return;
      const h = byName.get(match.home), a = byName.get(match.away);
      h.played++; a.played++; h.gf += r.homeScore; h.ga += r.awayScore; a.gf += r.awayScore; a.ga += r.homeScore;
      if (r.homeScore > r.awayScore) { h.wins++; h.points += 3; a.losses++; }
      else if (r.homeScore < r.awayScore) { a.wins++; a.points += 3; h.losses++; }
      else { h.draws++; a.draws++; h.points++; a.points++; }
    });

    // Primary criteria: points, goal difference, goals scored.
    teams.sort((a,b) => b.points-a.points || (b.gf-b.ga)-(a.gf-a.ga) || b.gf-a.gf || b.fifaPoints-a.fifaPoints || a.name.localeCompare(b.name, 'cs'));

    // Head-to-head mini-table for blocks still tied on the first three criteria.
    let i = 0;
    while (i < teams.length) {
      let j = i + 1;
      while (j < teams.length && teams[j].points === teams[i].points && (teams[j].gf-teams[j].ga) === (teams[i].gf-teams[i].ga) && teams[j].gf === teams[i].gf) j++;
      if (j - i > 1) {
        const tiedNames = new Set(teams.slice(i,j).map(t => t.name));
        const mini = new Map([...tiedNames].map(n => [n, {points:0,gf:0,ga:0}]));
        relevantMatches.forEach(match => {
          if (!tiedNames.has(match.home) || !tiedNames.has(match.away)) return;
          const r = state.results.get(resultKey(match.home, match.away));
          if (!r?.completed && !r?.live) return;
          const h=mini.get(match.home), a=mini.get(match.away);
          h.gf+=r.homeScore; h.ga+=r.awayScore; a.gf+=r.awayScore; a.ga+=r.homeScore;
          if (r.homeScore>r.awayScore) h.points+=3; else if (r.homeScore<r.awayScore) a.points+=3; else {h.points++;a.points++;}
        });
        const sorted = teams.slice(i,j).sort((a,b) => {
          const ma=mini.get(a.name), mb=mini.get(b.name);
          return mb.points-ma.points || (mb.gf-mb.ga)-(ma.gf-ma.ga) || mb.gf-ma.gf || b.fifaPoints-a.fifaPoints;
        });
        teams.splice(i,j-i,...sorted);
      }
      i = j;
    }
    rankings[group] = teams;
  }
  return rankings;
}

function pointColor(value, max) {
  if (!max || value <= 0) return {bg: '#ffffff', fg: '#111827'};
  const t = Math.min(1, value / max);
  const from = [255,255,255], to = [112,48,160];
  const rgb = from.map((v,i) => Math.round(v + (to[i]-v)*t));
  const luminance = (0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2]);
  return {bg: `rgb(${rgb.join(',')})`, fg: luminance < 145 ? '#fff' : '#111827'};
}

function renderSync() {
  const card = $('#sync-card');
  const api = state.api;
  const liveEvents = (api?.events || []).filter(event => event.live);
  card.classList.toggle('ok', Boolean(api?.ok));
  card.classList.toggle('warn', api && !api.ok);
  card.classList.toggle('live', liveEvents.length > 0);
  $('#sync-title').textContent = liveEvents.length
    ? `Živě ${liveEvents.length} ${liveEvents.length === 1 ? 'zápas' : 'zápasy'}`
    : api?.ok ? 'Výsledky jsou aktuální' : 'Používám záložní výsledky';
  if (liveEvents.length) {
    const liveText = liveEvents.map(event => `${event.home} ${event.homeScore}:${event.awayScore} ${event.away}${event.status ? ` (${event.status})` : ''}`).join(' • ');
    $('#sync-detail').textContent = `${liveText} — obnova každých 30 s`;
  } else {
    $('#sync-detail').textContent = api?.warning || `Aktualizováno ${new Date(api.updatedAt).toLocaleString('cs-CZ', {timeZone:'Europe/Prague'})}`;
  }
  $('#footer-source').textContent = api?.source === 'ESPN' ? 'Automatické a živé výsledky: ESPN' : 'Záložní výsledky z výchozího XLSX';
}

function renderKpis() {
  const completed = state.calculations.completed.length;
  const leader = [...state.calculations.totals].sort((a,b) => b.total-a.total)[0];
  const next = state.data.matches.find(m => !state.results.get(resultKey(m.home,m.away))?.completed && new Date(m.kickoff) > new Date());
  const liveCount = state.calculations.live.length;
  const items = [
    [liveCount ? `${completed} + ${liveCount} živě` : completed, `odehráno z ${state.data.matches.length}`],
    [state.calculations.actualGoals, 'vstřelených branek'],
    [leader ? formatPoints(leader.total) : '0,0', leader ? `vede ${leader.name}` : 'průběžné body'],
    [next ? formatDateTime(next.kickoff) : '—', next ? `${next.home} - ${next.away}` : 'další zápas'],
  ];
  $('#kpis').innerHTML = items.map(([strong,span]) => `<div class="kpi"><strong>${escapeHtml(strong)}</strong><span>${escapeHtml(span)}</span></div>`).join('');
}

function leagueEligible(player, league) {
  const cls = typeClass(player.type);
  if (league === 'gold') return cls === 'gold';
  if (league === 'silver') return cls === 'gold' || cls === 'silver';
  return true;
}

function renderLeaderboard() {
  const rows = state.calculations.totals
    .filter(p => p.active && leagueEligible(p, state.league))
    .sort((a,b) => b.total-a.total || a.name.localeCompare(b.name, 'cs'));
  $('#leaderboard').innerHTML = `<thead><tr><th>#</th><th>Hráč</th><th class="num">Body</th><th class="num">Tip branek</th><th>Platba</th></tr></thead><tbody>${rows.map((p,i) => `
    <tr>
      <td class="rank">${i+1}.</td>
      <td><div class="player-cell"><strong>${escapeHtml(p.name)}</strong><span class="badge ${typeClass(p.type)}">${typeLabel(p.type)}</span></div></td>
      <td class="num"><strong>${formatPoints(p.total)}</strong>${p.bonus ? `<small> +${formatPoints(p.bonus)} bonus</small>`:''}</td>
      <td class="num">${p.totalGoalsTip ?? '—'}</td>
      <td><span class="badge ${isPaid(p.payment)?'paid':'unpaid'}">${isPaid(p.payment)?'ZAPLACENO':'NEZAPLACENO'}</span></td>
    </tr>`).join('')}</tbody>`;
}

function renderNextMatches() {
  const now = new Date();
  const next = state.data.matches.filter(m => {
    const r = state.results.get(resultKey(m.home,m.away));
    return !r?.completed && new Date(m.kickoff) > new Date(now.getTime()-3*60*60*1000);
  }).slice(0,6);
  $('#next-matches').innerHTML = next.length ? next.map(m => `
    <div class="next-match">
      <time>${formatDateTime(m.kickoff)}</time>
      <div class="team">${flagFor(m.home)}<span>${escapeHtml(m.home)}</span></div>
      <div class="score">–</div>
      <div class="team away"><span>${escapeHtml(m.away)}</span>${flagFor(m.away)}</div>
    </div>`).join('') : '<div class="empty-state">Všechny zápasy v tabulce už byly odehrány.</div>';
}

function renderMatches() {
  const participants = state.data.participants;
  const allPointValues = [];
  participants.forEach(p => state.calculations.pointsByParticipant.get(p.id).forEach(v => allPointValues.push(v)));
  const maxPoint = Math.max(0, ...allPointValues);

  const head = participants.map(p => `<th class="participant-head" data-player="${escapeHtml(p.name.toLowerCase())}">
    <div class="vertical-name">${escapeHtml(p.name)}</div>
    <div class="participant-meta"><span class="badge ${typeClass(p.type)}">${typeLabel(p.type)}</span><span class="badge ${isPaid(p.payment)?'paid':'unpaid'}">${isPaid(p.payment)?'ZAPL.':'NEZAPL.'}</span></div>
  </th>`).join('');

  const body = state.data.matches.map((m,idx) => {
    const r = state.results.get(resultKey(m.home,m.away));
    const scoreText = r && Number.isInteger(r.homeScore) && Number.isInteger(r.awayScore) ? `${r.homeScore}:${r.awayScore}` : ' : ';
    const resultClass = r?.completed ? 'result-final' : r?.live ? 'result-live' : '';
    const liveStatus = r?.status || r?.displayClock || '';
    const status = r?.live ? `<span class="match-status">ŽIVĚ${liveStatus ? ` · ${escapeHtml(liveStatus)}` : ''}</span>` : '';
    const participantCells = participants.map(p => {
      const tip = p.predictions[idx];
      const tipText = Number.isInteger(tip.home) && Number.isInteger(tip.away) ? `${tip.home}:${tip.away}` : '—';
      const pts = state.calculations.pointsByParticipant.get(p.id)[idx] || 0;
      const colors = pointColor(pts, maxPoint);
      return `<td class="prediction ${typeClass(p.type)} ${tipText==='—'?'empty':''}" data-player="${escapeHtml(p.name.toLowerCase())}">
        <span>${tipText}</span><br><span class="points-cell" style="background:${colors.bg};color:${colors.fg}">${(r?.completed || r?.live) ? formatPoints(pts) : ''}</span>
      </td>`;
    }).join('');
    return `<tr data-search="${escapeHtml(`${m.home} ${m.away}`.toLowerCase())}">
      <td class="sticky col-date">${escapeHtml(m.dayLabel)} ${escapeHtml(m.dateLabel)}</td>
      <td class="sticky col-time">${escapeHtml(m.timeLabel)}</td>
      <td class="sticky col-home"><div class="team away"><span>${escapeHtml(m.home)}</span>${flagFor(m.home)}</div></td>
      <td class="sticky col-result ${resultClass}">${scoreText}${status}</td>
      <td class="sticky col-away"><div class="team">${flagFor(m.away)}<span>${escapeHtml(m.away)}</span></div></td>
      <td class="sticky col-coef">${(r?.completed || r?.live) ? formatPoints(state.calculations.coefficientByMatch[idx],2) : ''}</td>
      ${participantCells}
    </tr>`;
  }).join('');

  const totals = participants.map(p => `<td>${p.active ? formatPoints(state.calculations.totals.find(x=>x.id===p.id).total) : '—'}</td>`).join('');
  $('#matches-table').innerHTML = `<thead><tr>
    <th class="sticky col-date corner">Datum</th><th class="sticky col-time corner">Čas</th><th class="sticky col-home corner">Domácí</th><th class="sticky col-result corner">Výsledek</th><th class="sticky col-away corner">Hosté</th><th class="sticky col-coef corner">Koef.</th>${head}
  </tr></thead><tbody>${body}</tbody><tfoot><tr>
    <td class="sticky col-date" colspan="3">CELKEM</td><td class="sticky col-result">${state.calculations.actualGoals}</td><td class="sticky col-away">branek</td><td class="sticky col-coef"></td>${totals}
  </tr></tfoot>`;
  applyMatchFilter();
}

function applyMatchFilter() {
  const needle = state.search.trim().toLowerCase();
  $$('#matches-table tbody tr').forEach(row => {
    const teamHit = row.dataset.search.includes(needle);
    let playerHit = !needle;
    if (needle) playerHit = [...row.querySelectorAll('[data-player]')].some(cell => cell.dataset.player.includes(needle));
    row.classList.toggle('hidden', Boolean(needle) && !teamHit && !playerHit);
  });
}

function renderGroups() {
  const standings = calculateStandings();
  $('#groups-grid').innerHTML = Object.entries(standings).map(([group,teams]) => {
    const groupLive = state.data.matches.some(match => match.group === group && state.results.get(resultKey(match.home,match.away))?.live);
    return `<article class="card group-card">
    <div class="group-title"><h2>Skupina ${group}${groupLive ? ' <small class="live-label">ŽIVĚ</small>' : ''}</h2><span>${teams.reduce((s,t)=>s+t.played,0)/2}/6 zápasů${groupLive ? ' · průběžně' : ''}</span></div>
    <table class="group-table"><thead><tr><th>#</th><th>Tým</th><th>Z</th><th>V</th><th>R</th><th>P</th><th>Skóre</th><th>+/-</th><th>B</th></tr></thead>
    <tbody>${teams.map((t,i)=>`<tr class="${i<2?'qualifying':''}"><td>${i+1}</td><td><div class="team">${flagFor(t.name)}<span>${escapeHtml(t.name)}</span></div></td><td>${t.played}</td><td>${t.wins}</td><td>${t.draws}</td><td>${t.losses}</td><td>${t.gf}:${t.ga}</td><td>${t.gf-t.ga}</td><td><strong>${t.points}</strong></td></tr>`).join('')}</tbody></table>
  </article>`;
  }).join('');
}

function renderRules() {
  $('#rules-list').innerHTML = `<ul>${state.data.rules.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
}

function renderAll() {
  calculateEverything();
  renderSync();
  renderKpis();
  renderLeaderboard();
  renderNextMatches();
  renderMatches();
  renderGroups();
  renderRules();
}

function mergeApiResults(api) {
  state.results.clear();
  // Workbook fallback first.
  state.data.matches.forEach(m => {
    const f = m.fallbackResult;
    if (f.completed) state.results.set(resultKey(m.home,m.away), {home:m.home,away:m.away,homeScore:f.home,awayScore:f.away,completed:true,live:false,status:'XLSX'});
  });
  // Live provider overrides the fallback.
  (api.events || []).forEach(event => {
    if (!event.home || !event.away) return;
    if (!event.completed && !event.live) return;
    state.results.set(resultKey(event.home,event.away), event);
  });
}

function scheduleNextRefresh() {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  const hasLive = (state.api?.events || []).some(event => event.live);
  const delay = hasLive ? 30 * 1000 : 2 * 60 * 1000;
  state.refreshTimer = setTimeout(() => loadScores(false), delay);
}

async function loadScores(force = false) {
  $('#refresh-button').disabled = true;
  try {
    const response = await fetch(`/api/scores${force?'?force=1':''}`, {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.api = await response.json();
  } catch (error) {
    state.api = {ok:false,source:'browser',updatedAt:new Date().toISOString(),events:[],warning:`Výsledky se nepodařilo načíst: ${error.message}`};
  } finally {
    $('#refresh-button').disabled = false;
  }
  mergeApiResults(state.api);
  renderAll();
  scheduleNextRefresh();
}

function setupUi() {
  $$('.tab').forEach(button => button.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.toggle('is-active', b === button));
    $$('.panel').forEach(p => p.classList.toggle('is-active', p.id === `panel-${button.dataset.panel}`));
    if (button.dataset.panel) {
      const targetPath = button.dataset.panel === 'overview' ? '/' : `/${button.dataset.panel}`;
      history.replaceState(null, '', targetPath);
    }
  }));
  const pathPanel = (location.pathname || '').replace(/^\//, '').replace(/\/$/, '');
  const initialPanel = (location.hash || '').replace('#', '') || pathPanel;
  if (initialPanel) {
    const initialTab = $(`.tab[data-panel="${CSS.escape(initialPanel)}"]`);
    if (initialTab) initialTab.click();
  }
  $('#refresh-button').addEventListener('click', () => loadScores(true));
  $('#match-search').addEventListener('input', event => { state.search = event.target.value; applyMatchFilter(); });
  $('#league-filter').addEventListener('click', event => {
    const button = event.target.closest('button[data-league]');
    if (!button) return;
    state.league = button.dataset.league;
    $$('#league-filter button').forEach(b => b.classList.toggle('is-active', b === button));
    renderLeaderboard();
  });
}

async function init() {
  const dataResponse = await fetch('data.json', {cache:'no-store'});
  state.data = await dataResponse.json();
  setupUi();
  await loadScores(false);
}

init().catch(error => {
  document.body.innerHTML = `<main><article class="card rules-card"><h1>Stránku se nepodařilo spustit</h1><p>${escapeHtml(error.message)}</p></article></main>`;
});
