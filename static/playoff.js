'use strict';

(() => {
  const playoff = {
    config: null,
    teamFlags: new Map(),
    predictions: {},
    bonuses: {},
  };

  const byId = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = (value) => String(value || '').trim();
  const html = (value) => String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));

  function matchById(id) {
    return playoff.config.matches.find(match => match.id === id);
  }

  function prediction(matchId) {
    if (!playoff.predictions[matchId]) {
      playoff.predictions[matchId] = { homeGoals: '', awayGoals: '', winner: '' };
    }
    return playoff.predictions[matchId];
  }

  function concreteOptions(match) {
    if (Array.isArray(match.winnerOptions) && match.winnerOptions.length) return match.winnerOptions;
    return [match.home, match.away].filter(Boolean);
  }

  function getWinner(matchId) {
    return clean(prediction(matchId).winner);
  }

  function getEntrants(match, stack = new Set()) {
    if (!match) return [];
    if (stack.has(match.id)) return concreteOptions(match);
    stack.add(match.id);

    const resolveSource = (source, fallback) => {
      if (!source) return [fallback].filter(Boolean);
      const sourceMatch = matchById(source.matchId);
      if (!sourceMatch) return [fallback].filter(Boolean);
      const entrants = getEntrants(sourceMatch, stack);
      const winner = getWinner(source.matchId);
      if (source.type === 'winner') {
        return winner ? [winner] : entrants;
      }
      if (source.type === 'loser') {
        if (winner && entrants.includes(winner)) return entrants.filter(team => team !== winner);
        return entrants;
      }
      return [fallback].filter(Boolean);
    };

    const teams = [
      ...resolveSource(match.homeSource, match.home),
      ...resolveSource(match.awaySource, match.away),
    ].filter(Boolean);
    stack.delete(match.id);
    return [...new Set(teams.length ? teams : concreteOptions(match))];
  }

  function sideName(match, side) {
    const entrants = getEntrants(match);
    const src = side === 'home' ? match.homeSource : match.awaySource;
    const fallback = side === 'home' ? match.home : match.away;
    if (!src) return fallback;
    const sourceMatch = matchById(src.matchId);
    if (!sourceMatch) return fallback;
    const sourceEntrants = getEntrants(sourceMatch);
    const sourceWinner = getWinner(src.matchId);
    if (src.type === 'winner') {
      return sourceWinner || fallback || `Vítěz ${src.matchId}`;
    }
    if (src.type === 'loser') {
      if (sourceWinner && sourceEntrants.includes(sourceWinner)) {
        return sourceEntrants.filter(team => team !== sourceWinner).join(' / ') || fallback || `Poražený ${src.matchId}`;
      }
      return fallback || `Poražený ${src.matchId}`;
    }
    return entrants.includes(fallback) ? fallback : fallback;
  }

  function flagImg(teamName) {
    const src = playoff.teamFlags.get(teamName);
    return src ? `<img class="flag" src="${html(src)}" alt="">` : '';
  }

  function renderTeam(teamName, className = '') {
    const name = clean(teamName);
    return `<div class="team ${className}">${flagImg(name)}<span>${html(name || 'bude doplněno')}</span></div>`;
  }

  function fillGoalSelect(select, selected) {
    select.innerHTML = '<option value="">–</option>';
    for (let i = 0; i <= 20; i += 1) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = String(i);
      select.appendChild(opt);
    }
    select.value = String(selected ?? '');
  }

  function fillWinnerSelect(select, match) {
    const current = select.value || getWinner(match.id);
    const options = getEntrants(match);
    select.innerHTML = '<option value="">Vyber postupujícího</option>';
    for (const option of options) {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      select.appendChild(opt);
    }
    if (options.includes(current)) {
      select.value = current;
    } else {
      select.value = '';
      prediction(match.id).winner = '';
    }
  }

  function betClass(item) {
    return item.className || item.id || 'normal';
  }

  function renderBetTypes() {
    const holder = byId('playoff-bet-types');
    if (!holder) return;
    holder.innerHTML = playoff.config.betTypes.map((item, index) => `
      <label class="bet-pill ${html(betClass(item))}">
        <input type="radio" name="playoff-bet-type" value="${html(item.id)}" ${index === 0 ? 'checked' : ''} required>
        <span>${html(item.label)}</span>
        <small>${Number(item.fee || 0).toLocaleString('cs-CZ')} Kč</small>
      </label>
    `).join('');
  }

  function renderBonuses() {
    const holder = byId('playoff-bonus-fields');
    if (!holder) return;
    holder.innerHTML = playoff.config.bonusFields.map(field => `
      <label>${html(field.label)}
        <input type="number" min="${field.min}" max="${field.max}" step="1" required data-playoff-bonus="${html(field.id)}">
      </label>
    `).join('');
  }

  function roundClass(round) {
    if (round.includes('1/16')) return 'round-32';
    if (round.includes('Osm')) return 'round-16';
    if (round.includes('Čtvrt')) return 'round-8';
    if (round.includes('Semi')) return 'round-4';
    if (round.includes('3')) return 'round-bronze';
    if (round.includes('Fin')) return 'round-final';
    return '';
  }

  function renderMatches() {
    const holder = byId('playoff-matches');
    if (!holder) return;
    const chunks = [];
    let currentRound = '';
    for (const match of playoff.config.matches) {
      if (match.round !== currentRound) {
        if (currentRound) chunks.push('</div>');
        currentRound = match.round;
        chunks.push(`<h3 class="playoff-round-title ${roundClass(match.round)}">${html(currentRound)}</h3><div class="playoff-round-grid">`);
      }
      const p = prediction(match.id);
      chunks.push(`
        <article class="playoff-match" data-playoff-match="${html(match.id)}">
          <div class="playoff-match-top">
            <strong>${html(match.id)}</strong>
            <span>${html(match.day || '')} ${html(match.dateTime || '')}</span>
          </div>
          <div class="playoff-teams">
            <div data-side="home">${renderTeam(sideName(match, 'home'))}</div>
            <div class="score-inputs">
              <select aria-label="Góly týmu 1" data-playoff-match-id="${html(match.id)}" data-playoff-field="homeGoals"></select>
              <span>:</span>
              <select aria-label="Góly týmu 2" data-playoff-match-id="${html(match.id)}" data-playoff-field="awayGoals"></select>
            </div>
            <div data-side="away">${renderTeam(sideName(match, 'away'), 'away')}</div>
          </div>
          <label class="winner-label">Postupující / vítěz zápasu
            <select class="winner-select" required data-playoff-match-id="${html(match.id)}" data-playoff-field="winner"></select>
          </label>
        </article>
      `);
    }
    if (currentRound) chunks.push('</div>');
    holder.innerHTML = chunks.join('');

    qsa('[data-playoff-match]').forEach(card => {
      const match = matchById(card.dataset.playoffMatch);
      const p = prediction(match.id);
      fillGoalSelect(card.querySelector('[data-playoff-field="homeGoals"]'), p.homeGoals);
      fillGoalSelect(card.querySelector('[data-playoff-field="awayGoals"]'), p.awayGoals);
      fillWinnerSelect(card.querySelector('[data-playoff-field="winner"]'), match);
    });
  }

  function refreshDynamicPart() {
    qsa('[data-playoff-match]').forEach(card => {
      const match = matchById(card.dataset.playoffMatch);
      if (!match) return;
      card.querySelector('[data-side="home"]').innerHTML = renderTeam(sideName(match, 'home'));
      card.querySelector('[data-side="away"]').innerHTML = renderTeam(sideName(match, 'away'), 'away');
      fillWinnerSelect(card.querySelector('[data-playoff-field="winner"]'), match);
    });
  }

  function collectPayload() {
    const bet = document.querySelector('input[name="playoff-bet-type"]:checked');
    const bonuses = {};
    qsa('[data-playoff-bonus]').forEach(input => { bonuses[input.dataset.playoffBonus] = input.value; });
    return {
      name: byId('playoff-name').value,
      email: byId('playoff-email').value,
      betType: bet ? bet.value : '',
      consent: byId('playoff-consent').checked,
      predictions: playoff.predictions,
      bonuses,
    };
  }

  function setMessage(message, kind = '') {
    const holder = byId('playoff-message');
    if (!holder) return;
    holder.className = `playoff-message ${kind}`;
    holder.innerHTML = message;
  }

  function bindEvents() {
    const form = byId('playoff-form');
    if (!form) return;
    document.addEventListener('change', event => {
      const el = event.target;
      if (!el || !el.dataset || !el.dataset.playoffMatchId) return;
      prediction(el.dataset.playoffMatchId)[el.dataset.playoffField] = el.value;
      if (el.dataset.playoffField === 'winner') refreshDynamicPart();
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = byId('playoff-submit');
      button.disabled = true;
      button.textContent = 'Odesílám…';
      setMessage('', '');
      try {
        const response = await fetch('/api/playoff-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectPayload()),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          const errors = (result.errors || ['Odeslání se nepodařilo.']).map(err => `<li>${html(err)}</li>`).join('');
          setMessage(`<ul>${errors}</ul>`, 'error');
          return;
        }
        const savedInfo = result.storage && result.storage.saved
          ? 'Tip je uložený a propíše se do záložky Play-off tabulka.'
          : 'Server odpověděl OK, ale potvrzení uložení nebylo vráceno.';
        const mailInfo = result.mail && result.mail.sent
          ? 'XLSX export byl poslán e-mailem správci.'
          : `E-mail se neodeslal${result.mail && result.mail.reason ? `: ${html(result.mail.reason)}` : ' – doplň SMTP_PASS v nastavení Renderu'}.`;
        setMessage(`Děkuji. ${savedInfo} ${mailInfo} <a href="#playoff-results">Otevřít play-off tabulku</a>.`, 'success');
        window.dispatchEvent(new CustomEvent('playoff-submitted'));
      } catch (error) {
        setMessage(`Odeslání se nepodařilo: ${html(error.message)}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Odeslat play-off tip';
      }
    });
  }

  async function load() {
    const [configResponse, dataResponse] = await Promise.all([
      fetch('playoff-data.json', { cache: 'no-store' }),
      fetch('data.json', { cache: 'no-store' }),
    ]);
    playoff.config = await configResponse.json();
    const siteData = await dataResponse.json();
    playoff.teamFlags = new Map((siteData.teams || []).map(team => [team.name, team.flag]));
    renderBetTypes();
    renderBonuses();
    renderMatches();
    bindEvents();
  }

  window.addEventListener('DOMContentLoaded', () => {
    load().catch(error => {
      const panel = byId('panel-playoff');
      if (panel) panel.innerHTML = `<article class="card rules-card"><h2>Pavouk se nepodařilo načíst</h2><p>${html(error.message)}</p></article>`;
    });
  });
})();
