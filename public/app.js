const app = document.getElementById('app');
const toast = document.getElementById('toast');
const role = window.location.pathname.includes('/admin') ? 'admin' : 'hero';
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const suits = ['s', 'h', 'd', 'c'];
const allCards = ranks.flatMap((rank) => suits.map((suit) => `${rank}${suit}`));
const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
const streetLabels = {
  waiting: 'Waiting',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  complete: 'Complete'
};

let state = null;
let source = null;
let cardOverrideTarget = null;
let chipFlights = [];
let chipFlightId = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatChips(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function renderAuthError() {
  app.innerHTML = `
    <main class="auth-error">
      <section>
        <h1>Unknown View</h1>
        <p>Open either /admin or /hero from the server or tunnel URL.</p>
      </section>
    </main>
  `;
}

function connect() {
  if (role !== 'admin' && role !== 'hero') {
    renderAuthError();
    return;
  }
  source = new EventSource(`/events?role=${role}`);
  source.addEventListener('state', (event) => {
    const previous = state;
    state = JSON.parse(event.data);
    const flights = buildChipFlights(previous, state);
    render();
    queueChipFlights(flights);
  });
  source.onerror = () => {
    if (!state) {
      app.innerHTML = `
        <main class="auth-error">
          <section>
            <h1>Could not connect</h1>
            <p>The server may be down, or this view path may be invalid.</p>
          </section>
        </main>
      `;
    }
  };
}

async function api(type, payload = {}) {
  const response = await fetch('/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, type, payload })
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error || 'Action failed.');
  return body;
}

function cardAttrs(meta = {}) {
  if (role !== 'admin' || !meta.target) return '';
  const attrs = [
    'data-command="open-card-override"',
    `data-target="${meta.target}"`,
    `data-index="${meta.index}"`,
    meta.seat ? `data-seat="${meta.seat}"` : '',
    'title="Override card"',
    'role="button"',
    'tabindex="0"'
  ].filter(Boolean).join(' ');
  return ` ${attrs}`;
}

function cardClass(extra = '', meta = {}) {
  return [
    'card',
    extra,
    meta.future ? 'future-card' : '',
    role === 'admin' && meta.target ? 'clickable-card' : ''
  ].filter(Boolean).join(' ');
}

function cardHtml(card, meta = {}) {
  if (!card) {
    return `<div class="${cardClass('empty', meta)}"${cardAttrs(meta)}><span class="rank">?</span><span class="suit">?</span><span class="rank bottom">?</span></div>`;
  }
  if (card === 'XX') return `<div class="${cardClass('back', meta)}"${cardAttrs(meta)}><span></span></div>`;
  const rank = card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';
  return `
    <div class="${cardClass(red ? 'red' : '', meta)}"${cardAttrs(meta)}>
      <span class="rank">${rank}</span>
      <span class="suit">${suitSymbols[suit]}</span>
      <span class="rank bottom">${rank}</span>
    </div>
  `;
}

function displayIndexForSeat(seat) {
  const seats = state.settings.seats;
  const anchor = role === 'hero' ? state.settings.heroSeat : 1;
  return (seat - anchor + seats) % seats;
}

function positionForSeat(seat, radiusX, radiusY) {
  const angle = (90 + displayIndexForSeat(seat) * (360 / state.settings.seats)) * (Math.PI / 180);
  return {
    left: 50 + Math.cos(angle) * radiusX,
    top: 50 + Math.sin(angle) * radiusY
  };
}

function playerBySeat(seat) {
  return state.players.find((player) => player.seat === Number(seat));
}

function renderChipStack(count, extraClass = '') {
  return `<div class="chips ${extraClass}">${Array.from({ length: count }, () => '<span class="chip"></span>').join('')}</div>`;
}

function potChipCount(amount) {
  if (Number(amount || 0) <= 0) return 0;
  const bigBlind = Math.max(1, Number(state.settings.bigBlind || 1));
  return Math.min(7, Math.max(1, Math.ceil(Math.log2(Number(amount || 0) / bigBlind + 1))));
}

function potScale(amount) {
  const bigBlind = Math.max(1, Number(state.settings.bigBlind || 1));
  return Math.min(1.55, 0.9 + Math.log10(Number(amount || 0) / bigBlind + 1) * 0.24).toFixed(2);
}

function renderPotStacks() {
  const pots = state.sidePots.length
    ? state.sidePots.map((pot) => ({ label: pot.label || 'Pot', amount: pot.amount }))
    : [{ label: 'Pot', amount: state.pot }];
  return `
    <div class="pot-stacks">
      ${pots.map((pot) => `
        <div class="pot-stack" style="--pile-scale:${potScale(pot.amount)};">
          ${renderChipStack(potChipCount(pot.amount), 'pot-chips')}
          <div class="pot-stack-label">${escapeHtml(pot.label)} ${formatChips(pot.amount)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function buildChipFlights(previous, next) {
  if (!previous || !next || previous.handId !== next.handId) return [];
  const oldBySeat = new Map(previous.players.map((player) => [player.seat, player]));
  return next.players
    .map((player) => {
      const old = oldBySeat.get(player.seat);
      const added = Number(player.committed || 0) - Number(old?.committed || 0);
      return added > 0 ? { seat: player.seat, amount: added } : null;
    })
    .filter(Boolean);
}

function queueChipFlights(flights) {
  if (!flights.length) return;
  const ids = [];
  for (const flight of flights) {
    const from = positionForSeat(flight.seat, 28, 23.5);
    const id = ++chipFlightId;
    ids.push(id);
    chipFlights.push({
      id,
      chipCount: Math.min(3, Math.max(1, Math.ceil(Number(flight.amount) / Math.max(1, state.settings.bigBlind * 2)))),
      fromLeft: from.left,
      fromTop: from.top,
      toLeft: 50,
      toTop: 48
    });
  }
  render();
  const idSet = new Set(ids);
  setTimeout(() => {
    chipFlights = chipFlights.filter((flight) => !idSet.has(flight.id));
    render();
  }, 900);
}

function renderChipFlight(flight) {
  return `
    <div class="chip-flight" style="--from-left:${flight.fromLeft}%;--from-top:${flight.fromTop}%;--to-left:${flight.toLeft}%;--to-top:${flight.toTop}%">
      ${renderChipStack(flight.chipCount, 'flight-chips')}
    </div>
  `;
}

function renderSeat(player) {
  const position = positionForSeat(player.seat, 43.5, 38.5);
  const classes = [
    'seat',
    player.seat === state.actionOn ? 'is-action' : '',
    player.folded ? 'folded' : '',
    player.isHero ? 'hero-seat' : ''
  ].filter(Boolean).join(' ');
  const marker = state.buttonSeat === player.seat ? '<span class="dealer">D</span>' : '<span></span>';
  const baseStatus = player.folded
    ? 'Folded'
    : player.allIn
      ? 'All in'
      : player.lastAction || (player.seat === state.actionOn ? 'Action' : '');
  const botLabel = player.botType && player.botType !== 'manual' ? player.botType.toUpperCase() : '';
  const status = [botLabel, baseStatus].filter(Boolean).join(' · ');

  return `
    <div class="${classes}" style="left:${position.left}%; top:${position.top}%;">
      <div class="seat-panel">
        <div class="seat-name">
          <span>${escapeHtml(player.name)}</span>
          ${marker}
        </div>
        <div class="stack">${formatChips(player.stack)}</div>
        <div class="hand">${player.hand.map((card, index) => cardHtml(card, { target: 'player', seat: player.seat, index })).join('')}</div>
        <div class="player-state">${escapeHtml(status)}</div>
      </div>
    </div>
  `;
}

function renderBetPile(player) {
  if (!player.streetBet) return '';
  const position = positionForSeat(player.seat, 28, 23.5);
  const chipCount = Math.min(3, Math.max(1, Math.ceil(Number(player.streetBet) / Math.max(1, state.settings.bigBlind * 2))));
  return `
    <div class="bet-pile" style="left:${position.left}%; top:${position.top}%;">
      ${renderChipStack(chipCount)}
      <div class="bet-amount">${formatChips(player.streetBet)}</div>
    </div>
  `;
}

function renderTable() {
  const players = state.players.filter((player) => player.active);
  const tableBoard = role === 'admin' ? (state.boardPreview || state.board) : state.board;
  return `
    <section class="table-shell">
      <div class="table">
        <div class="rail"></div>
        <div class="center-board">
          <div class="pot">
            <span>Total ${formatChips(state.pot)}</span>
            ${state.sidePots.length > 1 ? `<span class="pill">${state.sidePots.length} pots</span>` : ''}
          </div>
          ${renderPotStacks()}
          <div class="board">${tableBoard.map((card, index) => cardHtml(card, {
            target: 'board',
            index,
            future: role === 'admin' && !state.boardDealt?.[index]
          })).join('')}</div>
        </div>
        ${players.map(renderSeat).join('')}
        ${players.map(renderBetPile).join('')}
        ${chipFlights.map(renderChipFlight).join('')}
      </div>
      ${renderHeroBar()}
    </section>
  `;
}

function renderHeroBar() {
  if (role !== 'hero') return '';
  const hero = state.players.find((player) => player.isHero);
  const legal = state.actionOn === hero?.seat ? state.legal : null;
  return `
    <section class="hero-action-bar">
      ${legal?.canAct ? renderActionControls(legal, hero, false) : `
        <div class="action-title">${state.handComplete ? 'Hand complete' : 'Waiting for action'}</div>
        <div class="button-row"><span class="pill">${streetLabels[state.street] || state.street}</span></div>
      `}
    </section>
  `;
}

function quickWagerSizes(legal, player, wager) {
  if (!wager) return [];
  const options = [
    ['1/3', 1 / 3],
    ['2/3', 2 / 3],
    ['Pot', 1],
    ['2x Pot', 2]
  ];
  const totalPot = Number(state.totalPot ?? state.pot ?? 0);
  const toCall = Number(legal.toCall || 0);
  const min = Number(wager.min || 0);
  const max = Number(wager.max || 0);
  const playerStreetBet = Number(player.streetBet || 0);

  return options.map(([label, fraction]) => {
    const rawTarget = wager.type === 'raise'
      ? playerStreetBet + toCall + fraction * (totalPot + toCall)
      : playerStreetBet + fraction * totalPot;
    const target = Math.min(max, Math.max(min, Math.round(rawTarget)));
    return { label, value: target };
  });
}

function renderActionControls(legal, player, allowForce) {
  const wager = legal.actions.find((action) => action.type === 'bet' || action.type === 'raise');
  const quickSizes = quickWagerSizes(legal, player, wager);
  const simpleActions = legal.actions.filter((action) => action.type !== 'bet' && action.type !== 'raise');
  return `
    <div class="action-title">
      Action on ${escapeHtml(player.name)}
      ${legal.toCall ? ` · To call ${formatChips(legal.toCall)}` : ''}
      ${allowForce ? ' · admin override required for hero' : ''}
    </div>
    <div class="action-row">
      ${simpleActions.map((action) => `
        <button data-command="action" data-seat="${player.seat}" data-action="${action.type}">
          ${escapeHtml(action.label)}
        </button>
      `).join('')}
      ${wager ? `
        <label class="wager-box">
          ${wager.type === 'bet' ? 'Bet total' : 'Raise total'}
          <input id="wagerAmount" type="number" min="${wager.min}" max="${wager.max}" step="1" value="${wager.min}">
        </label>
        <div class="quick-bets">
          ${quickSizes.map((size) => `
            <button data-command="set-wager" data-value="${size.value}">${escapeHtml(size.label)}</button>
          `).join('')}
        </div>
        <button data-command="set-wager" data-value="${wager.min}">Min</button>
        <button data-command="set-wager" data-value="${wager.max}">All in</button>
        <button class="primary" data-command="action" data-seat="${player.seat}" data-action="${wager.type}" data-needs-amount="true">
          ${wager.type === 'bet' ? 'Bet' : 'Raise'}
        </button>
      ` : ''}
      ${allowForce ? `
        <label class="award-choice">
          <input id="forceHero" type="checkbox">
          Force hero override
        </label>
      ` : ''}
    </div>
  `;
}

function assignedVisibleCards(exceptCard = '') {
  const cards = [];
  for (const player of state.players) {
    for (const card of player.hand) {
      if (card && card !== 'XX' && card !== exceptCard) cards.push(card);
    }
  }
  for (const card of state.board) {
    if (card && card !== exceptCard) cards.push(card);
  }
  return new Set(cards);
}

function cardLabel(card) {
  if (!card) return 'Empty';
  return `${card[0]}${suitSymbols[card[1]]}`;
}

function cardOptions(current, allowBlank = true) {
  const assigned = assignedVisibleCards(current);
  return `
    ${allowBlank ? '<option value="">Empty</option>' : ''}
    ${allCards.map((card) => `
      <option value="${card}" ${current === card ? 'selected' : ''} ${assigned.has(card) ? 'disabled' : ''}>${cardLabel(card)}</option>
    `).join('')}
  `;
}

function cardSelect({ target, seat = '', index, current, allowBlank = true }) {
  const data = `data-command="set-card" data-target="${target}" data-seat="${seat}" data-index="${index}"`;
  return `
    <select ${data}>
      ${cardOptions(current, allowBlank)}
    </select>
  `;
}

function currentCardForTarget(target) {
  if (!target) return '';
  if (target.target === 'player') {
    const player = playerBySeat(target.seat);
    const card = player?.hand[Number(target.index)];
    return card === 'XX' ? '' : card || '';
  }
  if (target.target === 'board') return state.board[Number(target.index)] || state.boardPreview?.[Number(target.index)] || '';
  return '';
}

function cardTargetLabel(target) {
  if (!target) return '';
  if (target.target === 'player') {
    const player = playerBySeat(target.seat);
    return `${player?.name || `Seat ${target.seat}`} card ${Number(target.index) + 1}`;
  }
  return ['Flop 1', 'Flop 2', 'Flop 3', 'Turn', 'River'][Number(target.index)] || 'Board card';
}

function renderCardOverrideDialog() {
  if (role !== 'admin' || !cardOverrideTarget) return '';
  const current = currentCardForTarget(cardOverrideTarget);
  const isFutureBoard = cardOverrideTarget.target === 'board' && !state.boardDealt?.[Number(cardOverrideTarget.index)];
  return `
    <div class="modal-backdrop">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cardOverrideTitle">
        <div class="panel-title">
          <h2 id="cardOverrideTitle">Override Card</h2>
          <small>${escapeHtml(cardTargetLabel(cardOverrideTarget))}</small>
        </div>
        <div class="override-preview">${cardHtml(current, {})}</div>
        <label>Card
          <select id="overrideCardSelect">${cardOptions(current, true)}</select>
        </label>
        <div class="button-row">
          ${isFutureBoard ? '' : '<button data-command="clear-card-override">Clear</button>'}
          <button data-command="close-card-override">Cancel</button>
          <button class="primary" data-command="apply-card-override">Override</button>
        </div>
      </section>
    </div>
  `;
}

function renderAdminPanel() {
  const actionPlayer = state.actionOn ? playerBySeat(state.actionOn) : null;
  return `
    <aside class="admin-panel">
      <section class="panel-section">
        <div class="panel-title">
          <h2>Table Control</h2>
          <small>${streetLabels[state.street] || state.street}</small>
        </div>
        <div class="button-row">
          <button class="icon" title="Undo" data-command="undo" ${state.canUndo ? '' : 'disabled'}>↶</button>
          <button class="primary" data-command="new-hand">Next hand</button>
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-title">
          <h2>Current Action</h2>
          <small>${actionPlayer ? `Seat ${actionPlayer.seat}` : 'None'}</small>
        </div>
        ${actionPlayer && state.legal?.canAct
          ? renderActionControls(state.legal, actionPlayer, actionPlayer.isHero)
          : '<div class="message">No player action is currently pending.</div>'}
      </section>

      <section class="panel-section">
        <div class="panel-title"><h2>Setup</h2></div>
        <div class="form-grid three">
          <label>Seats <input id="setupSeats" type="number" min="2" max="10" value="${state.settings.seats}"></label>
          <label>Hero seat <input id="setupHero" type="number" min="1" max="${state.settings.seats}" value="${state.settings.heroSeat}"></label>
          <label>Default stack <input id="setupStack" type="number" step="1" value="${state.settings.defaultStack}"></label>
          <label>Small blind <input id="setupSb" type="number" step="1" value="${state.settings.smallBlind}"></label>
          <label>Big blind <input id="setupBb" type="number" step="1" value="${state.settings.bigBlind}"></label>
        </div>
        <div class="button-row" style="margin-top:10px;">
          <button data-command="configure">Apply and redeal</button>
          <button data-command="reset-stacks">Reset stacks</button>
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-title"><h2>Stacks and Hole Cards</h2></div>
        <div class="seat-editor">
          ${state.players.map(renderSeatEditor).join('')}
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-title"><h2>Board Override</h2></div>
        <div class="board-edit">
          ${(state.boardPreview || state.board).map((card, index) => `
            <label>${['Flop 1', 'Flop 2', 'Flop 3', 'Turn', 'River'][index]}
              ${cardSelect({ target: 'board', index, current: card, allowBlank: Boolean(state.boardDealt?.[index]) })}
            </label>
          `).join('')}
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-title"><h2>Payout</h2><small>Automatic</small></div>
        ${renderAwards()}
      </section>

      <section class="panel-section">
        <div class="panel-title"><h2>Log</h2></div>
        <div class="message-list">
          ${state.messages.map((item) => `<div class="message">${escapeHtml(item.message)}</div>`).join('') || '<div class="message">No messages yet.</div>'}
        </div>
      </section>
    </aside>
  `;
}

function renderSeatEditor(player) {
  return `
    <div class="seat-row ${player.active ? '' : 'inactive'}" data-seat="${player.seat}">
      <div class="pill">S${player.seat}${player.isHero ? ' H' : ''}</div>
      <label>Name
        <input class="name-input" data-seat="${player.seat}" value="${escapeHtml(player.name)}" ${player.isHero || !player.active ? 'disabled' : ''}>
      </label>
      <button data-command="rename" data-seat="${player.seat}" ${player.isHero || !player.active ? 'disabled' : ''}>Name</button>
      <div></div>
      <label>Stack
        <input class="stack-input" data-seat="${player.seat}" type="number" step="1" value="${player.stack}" ${!player.active ? 'disabled' : ''}>
      </label>
      <button data-command="set-stack" data-seat="${player.seat}" ${!player.active ? 'disabled' : ''}>Set</button>
      <div></div>
      <label>Bot
        <select data-command="set-bot" data-seat="${player.seat}" ${player.isHero || !player.active ? 'disabled' : ''}>
          <option value="manual" ${(player.botType || 'manual') === 'manual' ? 'selected' : ''}>Manual</option>
          <option value="fish" ${player.botType === 'fish' ? 'selected' : ''}>Fish</option>
          <option value="pro" ${player.botType === 'pro' ? 'selected' : ''}>Pro</option>
        </select>
      </label>
      <div></div>
      <div class="card-selects">
        ${cardSelect({ target: 'player', seat: player.seat, index: 0, current: player.hand[0] === 'XX' ? '' : player.hand[0] })}
        ${cardSelect({ target: 'player', seat: player.seat, index: 1, current: player.hand[1] === 'XX' ? '' : player.hand[1] })}
      </div>
    </div>
  `;
}
function renderAwards() {
  const last = state.lastAwards.map((award) => `S${award.seat}: ${formatChips(award.amount)}`).join(', ');
  return `
    <div class="message">${state.lastAwardReason ? `${escapeHtml(state.lastAwardReason)}${last ? ` · ${last}` : ''}` : 'Awards appear after showdown or folds.'}</div>
    ${state.sidePots.length ? renderPotBreakdown() : ''}
    ${state.lastAwardDetails?.length ? `
      <div class="award-block">
        <div class="award-heading">Applied payout</div>
        ${renderAwardDetails(state.lastAwardDetails)}
      </div>
    ` : ''}
    ${state.suggestedAwards.length ? `
      <div class="award-block">
        <div class="award-heading">Current automatic result</div>
        ${renderAwardDetails(state.suggestedAwards)}
      </div>
    ` : ''}
  `;
}

function renderPotBreakdown() {
  return `
    <div class="pot-breakdown">
      ${state.sidePots.map((pot) => `
        <div class="pot-line">
          <div>
            <strong>${escapeHtml(pot.label || 'Pot')}</strong>
            <span>${formatChips(pot.amount)}</span>
          </div>
          <small>eligible ${pot.eligible.map((seat) => `S${seat}`).join(', ')}</small>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAwardDetails(awards) {
  const groups = new Map();
  for (const award of awards) {
    const key = `${award.potLabel || 'Pot'}-${award.potAmount || award.amount}-${award.source || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        label: award.potLabel || 'Pot',
        amount: award.potAmount || award.amount,
        handName: award.handName,
        source: award.source,
        awards: []
      });
    }
    groups.get(key).awards.push(award);
  }

  return `
    <div class="award-detail-list">
      ${Array.from(groups.values()).map((group) => `
        <div class="award-detail">
          <div>
            <strong>${escapeHtml(group.label)}</strong>
            <span>${formatChips(group.amount)}</span>
          </div>
          <small>
            ${group.awards.map((award) => {
              const player = playerBySeat(award.seat);
              const verb = award.source === 'return' ? 'returned' : 'wins';
              const hand = award.source === 'showdown' && award.handName ? ` with ${award.handName}` : '';
              return `${escapeHtml(player?.name || `Seat ${award.seat}`)} ${verb} ${formatChips(award.amount)}${hand}`;
            }).join('; ')}
          </small>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTopbar() {
  const actionPlayer = state.actionOn ? playerBySeat(state.actionOn) : null;
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">♠</div>
        <h1>${role === 'admin' ? 'Admin View' : 'Hero View'}</h1>
      </div>
      <div class="status-line">
        <span class="pill">Hand ${state.handId}</span>
        <span class="pill">${streetLabels[state.street] || state.street}</span>
        <span class="pill">${formatChips(state.settings.smallBlind)}/${formatChips(state.settings.bigBlind)}</span>
        <span class="pill">Pot ${formatChips(state.pot)}</span>
        ${state.streetPot ? `<span class="pill">Street bets ${formatChips(state.streetPot)}</span>` : ''}
        ${actionPlayer ? `<span class="pill">Action: ${escapeHtml(actionPlayer.name)}</span>` : ''}
      </div>
    </header>
  `;
}

function render() {
  app.innerHTML = `
    ${renderTopbar()}
    <main class="view-grid ${role === 'hero' ? 'hero-only' : ''}">
      <div class="table-zone">${renderTable()}</div>
      ${role === 'admin' ? renderAdminPanel() : ''}
    </main>
    ${renderCardOverrideDialog()}
  `;
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-command]');
  if (!button || button.tagName === 'SELECT') return;
  const command = button.dataset.command;
  try {
    if (command === 'set-wager') {
      const input = document.getElementById('wagerAmount');
      if (input) input.value = button.dataset.value;
      return;
    }
    if (command === 'open-card-override') {
      if (role !== 'admin') return;
      cardOverrideTarget = {
        target: button.dataset.target,
        seat: button.dataset.seat ? Number(button.dataset.seat) : undefined,
        index: Number(button.dataset.index)
      };
      render();
      return;
    }
    if (command === 'close-card-override') {
      cardOverrideTarget = null;
      render();
      return;
    }
    if (command === 'clear-card-override' || command === 'apply-card-override') {
      if (!cardOverrideTarget) return;
      const target = { ...cardOverrideTarget };
      const card = command === 'clear-card-override' ? '' : document.getElementById('overrideCardSelect')?.value;
      cardOverrideTarget = null;
      render();
      await api('setCard', { ...target, card });
      return;
    }
    if (command === 'action') {
      const payload = {
        seat: Number(button.dataset.seat),
        action: button.dataset.action
      };
      if (button.dataset.needsAmount) {
        payload.amount = document.getElementById('wagerAmount')?.value;
      }
      const force = document.getElementById('forceHero');
      if (force?.checked) payload.forceHero = true;
      await api('playerAction', payload);
    } else if (command === 'undo') {
      await api('undo');
    } else if (command === 'new-hand') {
      await api('newHand');
    } else if (command === 'configure') {
      await api('configure', {
        seats: document.getElementById('setupSeats').value,
        heroSeat: document.getElementById('setupHero').value,
        smallBlind: document.getElementById('setupSb').value,
        bigBlind: document.getElementById('setupBb').value,
        defaultStack: document.getElementById('setupStack').value,
        resetStacks: false
      });
    } else if (command === 'reset-stacks') {
      await api('configure', {
        seats: document.getElementById('setupSeats').value,
        heroSeat: document.getElementById('setupHero').value,
        smallBlind: document.getElementById('setupSb').value,
        bigBlind: document.getElementById('setupBb').value,
        defaultStack: document.getElementById('setupStack').value,
        resetStacks: true
      });
    } else if (command === 'set-stack') {
      const seat = Number(button.dataset.seat);
      const input = document.querySelector(`.stack-input[data-seat="${seat}"]`);
      await api('setStack', { seat, amount: input.value });
    } else if (command === 'rename') {
      const seat = Number(button.dataset.seat);
      const input = document.querySelector(`.name-input[data-seat="${seat}"]`);
      await api('renamePlayer', { seat, name: input.value });
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('change', async (event) => {
  const botSelect = event.target.closest('select[data-command="set-bot"]');
  if (botSelect) {
    try {
      await api('setBot', {
        seat: Number(botSelect.dataset.seat),
        botType: botSelect.value
      });
    } catch (error) {
      showToast(error.message);
      render();
    }
    return;
  }

  const select = event.target.closest('select[data-command="set-card"]');
  if (!select) return;
  try {
    await api('setCard', {
      target: select.dataset.target,
      seat: select.dataset.seat ? Number(select.dataset.seat) : undefined,
      index: Number(select.dataset.index),
      card: select.value
    });
  } catch (error) {
    showToast(error.message);
    render();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && cardOverrideTarget) {
    cardOverrideTarget = null;
    render();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.clickable-card')) {
    event.preventDefault();
    event.target.click();
  }
});

connect();
