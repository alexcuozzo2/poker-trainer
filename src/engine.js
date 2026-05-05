const crypto = require('node:crypto');

const SCALE = 100;
const MAX_SEATS = 10;
const MIN_SEATS = 2;
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));

function chipsToCents(value) {
  let number = 0;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
  else return 0;

  if (!Number.isFinite(number)) throw new Error('Chip amount must be a valid whole number.');
  if (!Number.isInteger(number)) throw new Error('Chip amounts must be whole numbers.');
  return Math.max(0, number * SCALE);
}

function centsToChips(value) {
  return Math.round(value) / SCALE;
}

function formatChips(value) {
  const chips = centsToChips(value);
  return Number.isInteger(chips) ? String(chips) : chips.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function createDeck() {
  const cards = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) cards.push(`${rank}${suit}`);
  }
  return cards;
}

function shuffle(cards) {
  const copy = cards.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const random = crypto.randomInt(index + 1);
    [copy[index], copy[random]] = [copy[random], copy[index]];
  }
  return copy;
}

function normalizeCard(card) {
  if (card === null || card === undefined || card === '') return null;
  const value = String(card).trim();
  if (value.length < 2) throw new Error('Card must look like Ah, Td, or 7c.');
  const rank = value[0].toUpperCase();
  const suit = value[1].toLowerCase();
  const normalized = `${rank}${suit}`;
  if (!RANKS.includes(rank) || !SUITS.includes(suit) || value.length !== 2) {
    throw new Error('Card must use ranks 2-9,T,J,Q,K,A and suits s,h,d,c.');
  }
  return normalized;
}

function compareScores(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function combinations(cards, size) {
  const result = [];
  const current = [];
  function walk(start) {
    if (current.length === size) {
      result.push(current.slice());
      return;
    }
    for (let index = start; index <= cards.length - (size - current.length); index += 1) {
      current.push(cards[index]);
      walk(index + 1);
      current.pop();
    }
  }
  walk(0);
  return result;
}

function straightHigh(ranks) {
  const unique = Array.from(new Set(ranks)).sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const window = unique.slice(index, index + 5);
    if (window[0] - window[4] === 4 && new Set(window).size === 5) return window[0];
  }
  return 0;
}

function evaluateFive(cards) {
  const ranks = cards.map((card) => RANK_VALUE[card[0]]).sort((a, b) => b - a);
  const suits = cards.map((card) => card[1]);
  const flush = suits.every((suit) => suit === suits[0]);
  const straight = straightHigh(ranks);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = Array.from(counts.entries())
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (flush && straight) return [8, straight];
  if (groups[0].count === 4) {
    return [7, groups[0].rank, groups.find((group) => group.count === 1).rank];
  }
  if (groups[0].count === 3 && groups[1]?.count === 2) {
    return [6, groups[0].rank, groups[1].rank];
  }
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0].count === 3) {
    return [3, groups[0].rank, ...groups.filter((group) => group.count === 1).map((group) => group.rank)];
  }
  if (groups[0].count === 2 && groups[1]?.count === 2) {
    const pairs = groups.filter((group) => group.count === 2).map((group) => group.rank).sort((a, b) => b - a);
    const kicker = groups.find((group) => group.count === 1).rank;
    return [2, ...pairs, kicker];
  }
  if (groups[0].count === 2) {
    return [1, groups[0].rank, ...groups.filter((group) => group.count === 1).map((group) => group.rank)];
  }
  return [0, ...ranks];
}

function handName(score) {
  return [
    'High card',
    'Pair',
    'Two pair',
    'Three of a kind',
    'Straight',
    'Flush',
    'Full house',
    'Four of a kind',
    'Straight flush'
  ][score[0]] || 'Unknown';
}

function evaluateSeven(cards) {
  if (cards.length < 5) throw new Error('At least five cards are required to evaluate a hand.');
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluateFive(combo);
    if (!best || compareScores(score, best.score) > 0) {
      best = { cards: combo, score, name: handName(score) };
    }
  }
  return best;
}

class PokerGame {
  constructor(options = {}) {
    this.settings = {
      seats: clampInteger(options.seats ?? 9, MIN_SEATS, MAX_SEATS),
      heroSeat: clampInteger(options.heroSeat ?? 1, 1, MAX_SEATS),
      smallBlind: chipsToCents(options.smallBlind ?? 1),
      bigBlind: chipsToCents(options.bigBlind ?? 2),
      defaultStack: chipsToCents(options.defaultStack ?? 300)
    };
    this.players = Array.from({ length: MAX_SEATS }, (_, index) => this.createPlayer(index + 1));
    this.buttonSeat = this.settings.seats;
    this.undoStack = [];
    this.messages = [];
    this.handId = 0;
    this.startNewHand({ rotateButton: false, recordUndo: false });
  }

  createPlayer(seat) {
    const active = seat <= this.settings.seats;
    const isHero = seat === this.settings.heroSeat;
    return {
      seat,
      name: isHero ? 'Hero' : `Villain ${seat}`,
      isHero,
      active,
      inHand: false,
      stack: active ? this.settings.defaultStack : 0,
      committed: 0,
      streetBet: 0,
      hand: [null, null],
      folded: false,
      allIn: false,
      actedVersion: 0,
      lastAction: '',
      botType: 'manual'
    };
  }

  snapshot() {
    return JSON.stringify({
      settings: this.settings,
      players: this.players,
      buttonSeat: this.buttonSeat,
      messages: this.messages,
      handId: this.handId,
      deck: this.deck,
      board: this.board,
      street: this.street,
      actionOn: this.actionOn,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      hasFullBetThisStreet: this.hasFullBetThisStreet,
      roundVersion: this.roundVersion,
      handComplete: this.handComplete,
      sidePots: this.sidePots,
      suggestedAwards: this.suggestedAwards,
      lastAwards: this.lastAwards,
      lastAwardDetails: this.lastAwardDetails,
      lastAwardReason: this.lastAwardReason
    });
  }

  restore(snapshot) {
    const data = JSON.parse(snapshot);
    Object.assign(this, data);
  }

  saveUndo() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 500) this.undoStack.shift();
  }

  undo() {
    if (this.undoStack.length === 0) throw new Error('Nothing left to undo in this hand.');
    this.restore(this.undoStack.pop());
    this.pushMessage('Admin undid the last change.');
  }

  pushMessage(message) {
    const item = { at: new Date().toISOString(), message };
    this.messages = [item, ...(this.messages || [])].slice(0, 16);
  }

  activePlayers() {
    return this.players.filter((player) => player.active);
  }

  handPlayers() {
    return this.players.filter((player) => player.inHand);
  }

  livePlayers() {
    return this.players.filter((player) => player.inHand && !player.folded);
  }

  player(seat) {
    const player = this.players[seat - 1];
    if (!player) throw new Error(`Seat ${seat} does not exist.`);
    return player;
  }

  nextSeat(fromSeat, predicate = (player) => player.active) {
    for (let offset = 1; offset <= MAX_SEATS; offset += 1) {
      const seat = ((fromSeat - 1 + offset) % MAX_SEATS) + 1;
      const player = this.player(seat);
      if (predicate(player)) return seat;
    }
    return null;
  }

  firstSeat(predicate) {
    for (const player of this.players) {
      if (predicate(player)) return player.seat;
    }
    return null;
  }

  rotateButton() {
    const next = this.nextSeat(this.buttonSeat, (player) => player.active && player.stack > 0);
    if (next) this.buttonSeat = next;
  }

  refundUnfinishedBets() {
    if (this.handComplete) return 0;
    let refunded = 0;
    for (const player of this.players) {
      if (player.committed > 0) {
        player.stack += player.committed;
        refunded += player.committed;
      }
      player.committed = 0;
      player.streetBet = 0;
    }
    if (refunded > 0) this.pushMessage(`Refunded ${formatChips(refunded)} from the interrupted hand.`);
    return refunded;
  }

  configureTable({ seats, heroSeat, smallBlind, bigBlind, defaultStack, resetStacks = false }) {
    const nextSettings = { ...this.settings };
    if (seats !== undefined) nextSettings.seats = clampInteger(seats, MIN_SEATS, MAX_SEATS);
    if (heroSeat !== undefined) nextSettings.heroSeat = clampInteger(heroSeat, 1, nextSettings.seats);
    if (smallBlind !== undefined) nextSettings.smallBlind = chipsToCents(smallBlind);
    if (bigBlind !== undefined) nextSettings.bigBlind = chipsToCents(bigBlind);
    if (defaultStack !== undefined) nextSettings.defaultStack = chipsToCents(defaultStack);
    if (nextSettings.bigBlind <= 0) throw new Error('Big blind must be greater than zero.');
    if (nextSettings.smallBlind < 0 || nextSettings.smallBlind > nextSettings.bigBlind) {
      throw new Error('Small blind must be between zero and the big blind.');
    }

    this.saveUndo();
    this.refundUnfinishedBets();
    const wasActive = new Map(this.players.map((player) => [player.seat, player.active]));
    this.settings = nextSettings;

    for (const player of this.players) {
      player.active = player.seat <= this.settings.seats;
      player.isHero = player.seat === this.settings.heroSeat;
      if (player.isHero) {
        player.name = 'Hero';
        player.botType = 'manual';
      } else if (player.name === 'Hero') {
        player.name = `Villain ${player.seat}`;
      }
      if (!player.botType) player.botType = 'manual';
      if (!player.active) player.stack = 0;
      if (player.active && !wasActive.get(player.seat) && player.stack <= 0) player.stack = this.settings.defaultStack;
      if (resetStacks && player.active) player.stack = this.settings.defaultStack;
    }
    if (!this.player(this.buttonSeat).active) this.buttonSeat = this.settings.seats;
    this.startNewHand({ rotateButton: false, recordUndo: false });
    this.pushMessage('Admin applied table settings.');
  }

  setBlinds({ smallBlind, bigBlind }) {
    const nextSmallBlind = smallBlind !== undefined ? chipsToCents(smallBlind) : this.settings.smallBlind;
    const nextBigBlind = bigBlind !== undefined ? chipsToCents(bigBlind) : this.settings.bigBlind;
    if (nextBigBlind <= 0) throw new Error('Big blind must be greater than zero.');
    if (nextSmallBlind < 0 || nextSmallBlind > nextBigBlind) {
      throw new Error('Small blind must be between zero and the big blind.');
    }
    this.saveUndo();
    this.settings.smallBlind = nextSmallBlind;
    this.settings.bigBlind = nextBigBlind;
    this.pushMessage(`Blinds set to ${formatChips(this.settings.smallBlind)}/${formatChips(this.settings.bigBlind)} for future hands.`);
  }

  setPlayerStack(seat, amount) {
    const stack = chipsToCents(amount);
    this.saveUndo();
    const player = this.player(seat);
    player.stack = stack;
    if (player.inHand) player.allIn = player.stack === 0 && !player.folded;
    this.pushMessage(`${player.name} stack set to ${formatChips(player.stack)}.`);
  }

  renamePlayer(seat, name) {
    this.saveUndo();
    const player = this.player(seat);
    const nextName = String(name || '').trim().slice(0, 32);
    player.name = player.isHero ? 'Hero' : nextName || `Villain ${seat}`;
  }

  setPlayerBot(seat, botType) {
    const player = this.player(Number(seat));
    const cleanType = String(botType || 'manual').toLowerCase();
    const allowed = ['manual', 'fish', 'pro'];
    if (!allowed.includes(cleanType)) throw new Error('Unknown automation type.');
    if (player.isHero && cleanType !== 'manual') throw new Error('Hero cannot be automated from the admin panel.');
    this.saveUndo();
    player.botType = cleanType;
    const label = cleanType === 'manual' ? 'manual control' : cleanType + ' automation';
    this.pushMessage(player.name + ' set to ' + label + '.');
  }

  startNewHand({ rotateButton = true, recordUndo = false, refundUnawarded = true } = {}) {
    if (recordUndo) this.saveUndo();
    if (refundUnawarded) this.refundUnfinishedBets();
    this.undoStack = [];
    const eligible = this.players.filter((player) => player.active && player.stack > 0);
    if (eligible.length < 2) {
      this.street = 'waiting';
      this.actionOn = null;
      this.handComplete = true;
      this.deck = shuffle(createDeck());
      this.board = [null, null, null, null, null];
      this.currentBet = 0;
      this.minRaise = this.settings.bigBlind;
      this.hasFullBetThisStreet = false;
      this.roundVersion = 1;
      this.sidePots = [];
      this.suggestedAwards = [];
      this.lastAwards = [];
      this.lastAwardDetails = [];
      this.lastAwardReason = '';
      this.pushMessage('At least two players need chips to start a hand.');
      return;
    }

    if (rotateButton) this.rotateButton();
    if (!this.player(this.buttonSeat).active || this.player(this.buttonSeat).stack <= 0) {
      this.buttonSeat = eligible[eligible.length - 1].seat;
    }

    this.handId += 1;
    this.deck = shuffle(createDeck());
    this.board = [null, null, null, null, null];
    this.street = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.hasFullBetThisStreet = true;
    this.roundVersion = 1;
    this.handComplete = false;
    this.sidePots = [];
    this.suggestedAwards = [];
    this.lastAwards = [];
    this.lastAwardDetails = [];
    this.lastAwardReason = '';

    for (const player of this.players) {
      player.inHand = player.active && player.stack > 0;
      player.committed = 0;
      player.streetBet = 0;
      player.hand = [null, null];
      player.folded = false;
      player.allIn = false;
      player.actedVersion = 0;
      player.lastAction = '';
    }

    const handSeats = this.handPlayers().map((player) => player.seat);
    if (handSeats.length === 2) {
      this.smallBlindSeat = this.buttonSeat;
      this.bigBlindSeat = this.nextSeat(this.smallBlindSeat, (player) => player.inHand);
    } else {
      this.smallBlindSeat = this.nextSeat(this.buttonSeat, (player) => player.inHand);
      this.bigBlindSeat = this.nextSeat(this.smallBlindSeat, (player) => player.inHand);
    }

    this.dealHoleCards();
    this.postBlind(this.smallBlindSeat, this.settings.smallBlind, 'small blind');
    this.postBlind(this.bigBlindSeat, this.settings.bigBlind, 'big blind');
    this.currentBet = Math.max(...this.handPlayers().map((player) => player.streetBet), 0);
    this.minRaise = this.settings.bigBlind;
    this.hasFullBetThisStreet = true;

    const preflopStart = handSeats.length === 2
      ? this.smallBlindSeat
      : this.nextSeat(this.bigBlindSeat, (player) => player.inHand && !player.allIn && !player.folded);
    this.actionOn = null;
    this.advanceIfNeeded(preflopStart - 1);
    this.pushMessage(`Hand ${this.handId} started.`);
  }

  dealHoleCards() {
    for (let pass = 0; pass < 2; pass += 1) {
      let seat = this.buttonSeat;
      for (let dealt = 0; dealt < this.handPlayers().length; dealt += 1) {
        seat = this.nextSeat(seat, (player) => player.inHand);
        this.player(seat).hand[pass] = this.drawCard();
      }
    }
  }

  drawCard() {
    const card = this.deck.shift();
    if (!card) throw new Error('The deck is empty.');
    return card;
  }

  postBlind(seat, amount, label) {
    const player = this.player(seat);
    const posted = Math.min(amount, player.stack);
    this.commit(player, posted);
    player.lastAction = label;
  }

  commit(player, amount) {
    const cleanAmount = Math.max(0, Math.min(amount, player.stack));
    player.stack -= cleanAmount;
    player.streetBet += cleanAmount;
    player.committed += cleanAmount;
    if (player.stack === 0 && player.inHand && !player.folded) player.allIn = true;
    return cleanAmount;
  }

  potTotal() {
    return this.players.reduce((sum, player) => sum + player.committed, 0);
  }

  streetPotTotal() {
    return this.players.reduce((sum, player) => sum + player.streetBet, 0);
  }

  displayPotTotal() {
    if (this.handComplete || this.street === 'showdown' || this.street === 'complete') return this.potTotal();
    return Math.max(0, this.potTotal() - this.streetPotTotal());
  }

  amountToCall(player) {
    return Math.max(0, this.currentBet - player.streetBet);
  }

  minFullRaiseTotal() {
    if (this.currentBet === 0) return this.settings.bigBlind;
    if (!this.hasFullBetThisStreet) return this.settings.bigBlind;
    return this.currentBet + this.minRaise;
  }

  raiseReopenedFor(player) {
    return player.actedVersion < this.roundVersion;
  }

  getLegalActions(seat) {
    const player = this.player(seat);
    const empty = {
      seat,
      canAct: false,
      toCall: 0,
      actions: [],
      minBet: 0,
      minRaiseTotal: 0,
      maxTotal: centsToChips(player.streetBet + player.stack),
      currentBet: centsToChips(this.currentBet)
    };
    if (this.handComplete || this.actionOn !== seat || !player.inHand || player.folded || player.allIn) return empty;

    const toCall = this.amountToCall(player);
    const maxTotal = player.streetBet + player.stack;
    const legal = {
      seat,
      canAct: true,
      toCall: centsToChips(toCall),
      actions: [],
      minBet: 0,
      minRaiseTotal: 0,
      maxTotal: centsToChips(maxTotal),
      currentBet: centsToChips(this.currentBet)
    };

    if (toCall > 0) {
      legal.actions.push({ type: 'fold', label: 'Fold' });
      legal.actions.push({ type: 'call', label: player.stack <= toCall ? `Call all-in ${formatChips(player.stack)}` : `Call ${formatChips(toCall)}` });
    } else {
      legal.actions.push({ type: 'check', label: 'Check' });
    }

    if (this.currentBet === 0 && player.stack > 0) {
      const minBet = Math.min(maxTotal, this.settings.bigBlind);
      legal.minBet = centsToChips(minBet);
      legal.actions.push({ type: 'bet', label: 'Bet', min: centsToChips(minBet), max: centsToChips(maxTotal) });
    }

    if (this.currentBet > 0 && maxTotal > this.currentBet && this.raiseReopenedFor(player)) {
      const minFull = this.minFullRaiseTotal();
      const minTotal = maxTotal >= minFull ? minFull : maxTotal;
      legal.minRaiseTotal = centsToChips(minTotal);
      legal.actions.push({ type: 'raise', label: 'Raise', min: centsToChips(minTotal), max: centsToChips(maxTotal) });
    }

    return legal;
  }

  applyPlayerAction(seat, action, amount) {
    if (this.handComplete) throw new Error('The hand is already complete.');
    const player = this.player(seat);
    if (this.actionOn !== seat) throw new Error(`Action is on seat ${this.actionOn}, not seat ${seat}.`);
    if (!player.inHand || player.folded || player.allIn) throw new Error('That player cannot act right now.');

    const type = String(action || '').toLowerCase();
    if (!['fold', 'check', 'call', 'bet', 'raise'].includes(type)) throw new Error('Unknown action.');
    const targetTotal = type === 'bet' || type === 'raise' ? chipsToCents(amount) : null;
    this.saveUndo();
    const toCall = this.amountToCall(player);

    if (type === 'fold') {
      if (toCall === 0) throw new Error('Cannot fold when checking is available.');
      player.folded = true;
      player.lastAction = 'fold';
      player.actedVersion = this.roundVersion;
    } else if (type === 'check') {
      if (toCall !== 0) throw new Error('Cannot check while facing a bet.');
      player.lastAction = 'check';
      player.actedVersion = this.roundVersion;
    } else if (type === 'call') {
      if (toCall <= 0) throw new Error('There is no bet to call.');
      const called = this.commit(player, Math.min(toCall, player.stack));
      player.lastAction = called < toCall ? `call all-in ${formatChips(called)}` : `call ${formatChips(called)}`;
      player.actedVersion = this.roundVersion;
    } else if (type === 'bet') {
      if (this.currentBet !== 0) throw new Error('Cannot bet after a bet has already been made.');
      this.applyAggressiveAction(player, targetTotal, 'bet');
    } else if (type === 'raise') {
      if (this.currentBet <= 0) throw new Error('Cannot raise before a bet has been made.');
      if (!this.raiseReopenedFor(player)) throw new Error('The short all-in did not reopen raising for this player.');
      this.applyAggressiveAction(player, targetTotal, 'raise');
    }

    this.advanceIfNeeded(seat);
  }

  applyAggressiveAction(player, targetTotal, label) {
    const maxTotal = player.streetBet + player.stack;
    if (targetTotal <= player.streetBet) throw new Error('Bet size must add chips.');
    if (targetTotal > maxTotal) throw new Error('Bet size exceeds this player stack.');
    if (targetTotal <= this.currentBet) throw new Error('Raise must exceed the current bet.');

    const oldCurrentBet = this.currentBet;
    const minFull = this.currentBet === 0 ? this.settings.bigBlind : this.minFullRaiseTotal();
    const allInForLess = targetTotal === maxTotal && targetTotal < minFull;
    if (targetTotal < minFull && !allInForLess) {
      throw new Error(`Minimum ${label} is ${formatChips(minFull)}.`);
    }

    const added = this.commit(player, targetTotal - player.streetBet);
    this.currentBet = targetTotal;

    if (targetTotal >= minFull) {
      if (oldCurrentBet === 0) this.minRaise = targetTotal;
      else if (!this.hasFullBetThisStreet) this.minRaise = this.settings.bigBlind;
      else this.minRaise = targetTotal - oldCurrentBet;
      this.hasFullBetThisStreet = true;
      this.roundVersion += 1;
    } else if (oldCurrentBet === 0) {
      this.hasFullBetThisStreet = false;
    }

    player.actedVersion = this.roundVersion;
    const actionWord = label === 'bet' ? 'bet' : targetTotal >= minFull ? 'raise' : 'all-in short raise';
    player.lastAction = `${actionWord} ${formatChips(targetTotal)}`;
    this.pushMessage(`${player.name} ${player.lastAction}.`);
    return added;
  }

  needsAction(player) {
    return player.inHand
      && !player.folded
      && !player.allIn
      && (player.streetBet < this.currentBet || player.actedVersion < this.roundVersion);
  }

  findNextNeedingAction(fromSeat) {
    return this.nextSeat(fromSeat, (player) => this.needsAction(player));
  }

  advanceIfNeeded(fromSeat) {
    const live = this.livePlayers();
    if (live.length === 1) {
      this.awardFoldPot(live[0].seat);
      return;
    }

    const needs = this.players.some((player) => this.needsAction(player));
    if (needs) {
      this.actionOn = this.findNextNeedingAction(fromSeat);
      return;
    }

    const canStillBet = live.filter((player) => !player.allIn);
    if (canStillBet.length <= 1 && this.street !== 'river') {
      this.dealRemainingBoard();
      this.enterShowdown();
      return;
    }

    this.advanceStreet();
  }

  advanceStreet() {
    if (this.street === 'preflop') this.startStreet('flop');
    else if (this.street === 'flop') this.startStreet('turn');
    else if (this.street === 'turn') this.startStreet('river');
    else if (this.street === 'river') this.enterShowdown();
  }

  startStreet(street) {
    this.street = street;
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.hasFullBetThisStreet = false;
    this.roundVersion = 1;
    for (const player of this.players) {
      player.streetBet = 0;
      player.actedVersion = 0;
      if (player.inHand && !player.folded && player.stack === 0) player.allIn = true;
    }

    if (street === 'flop') this.dealBoardSlots([0, 1, 2]);
    else if (street === 'turn') this.dealBoardSlots([3]);
    else if (street === 'river') this.dealBoardSlots([4]);

    const live = this.livePlayers();
    if (live.length === 1) {
      this.awardFoldPot(live[0].seat);
      return;
    }

    const canStillBet = live.filter((player) => !player.allIn);
    if (canStillBet.length <= 1) {
      if (street !== 'river') this.dealRemainingBoard();
      this.enterShowdown();
      return;
    }

    this.actionOn = this.nextSeat(this.buttonSeat, (player) => this.needsAction(player));
    if (!this.actionOn) this.advanceStreet();
  }

  dealBoardSlots(slots) {
    for (const slot of slots) {
      if (!this.board[slot]) this.board[slot] = this.drawCard();
    }
  }

  dealRemainingBoard() {
    this.dealBoardSlots([0, 1, 2, 3, 4]);
  }

  boardSlotIsDealt(index) {
    if (this.street === 'complete') return Boolean(this.board[index]);
    const visibleByStreet = {
      waiting: 0,
      preflop: 0,
      flop: 3,
      turn: 4,
      river: 5,
      showdown: 5
    };
    return index < (visibleByStreet[this.street] || 0);
  }

  deckIndexForBoardSlot(index) {
    if (this.boardSlotIsDealt(index)) return -1;
    let deckIndex = 0;
    for (let slot = 0; slot < index; slot += 1) {
      if (!this.boardSlotIsDealt(slot)) deckIndex += 1;
    }
    return deckIndex;
  }

  boardRunoutPreview() {
    const preview = [];
    let deckIndex = 0;
    for (let index = 0; index < this.board.length; index += 1) {
      if (this.board[index]) preview.push(this.board[index]);
      else {
        preview.push(this.deck[deckIndex] || null);
        deckIndex += 1;
      }
    }
    return preview;
  }

  calculateSidePots() {
    return this.calculatePotBreakdown().pots;
  }

  calculatePotBreakdown() {
    const contributors = this.players.filter((player) => player.committed > 0);
    const eligiblePlayers = contributors.filter((player) => !player.folded);
    const levels = Array.from(new Set(eligiblePlayers.map((player) => player.committed))).sort((a, b) => a - b);
    const pots = [];
    const returns = [];
    let previous = 0;

    for (const level of levels) {
      let amount = 0;
      const participants = [];
      for (const player of contributors) {
        const contribution = Math.max(0, Math.min(player.committed, level) - previous);
        if (contribution > 0) {
          amount += contribution;
          participants.push(player);
        }
      }

      if (amount > 0) {
        const eligible = eligiblePlayers.filter((player) => player.committed >= level);
        if (eligible.length === 1) {
          returns.push({
            amount,
            seat: eligible[0].seat,
            label: participants.length === 1 ? 'Uncalled bet' : 'Uncontested pot'
          });
        } else if (eligible.length > 1) {
          const potNumber = pots.length + 1;
          pots.push({
            id: potNumber,
            label: potNumber === 1 ? 'Main pot' : `Side pot ${potNumber - 1}`,
            amount,
            participants: participants.map((player) => player.seat),
            eligible: eligible.map((player) => player.seat)
          });
        }
      }
      previous = level;
    }

    const foldedExcess = contributors
      .filter((player) => player.folded)
      .reduce((sum, player) => sum + Math.max(0, player.committed - previous), 0);
    if (foldedExcess > 0) {
      if (pots.length > 0) pots[pots.length - 1].amount += foldedExcess;
      else if (returns.length > 0) returns[returns.length - 1].amount += foldedExcess;
    }

    return { pots, returns };
  }

  evaluateShowdownAwards() {
    const { pots, returns } = this.calculatePotBreakdown();
    const awards = [];
    for (const returned of returns) {
      awards.push({
        seat: returned.seat,
        amount: returned.amount,
        potAmount: returned.amount,
        potId: null,
        potLabel: returned.label,
        winners: [returned.seat],
        handName: 'Returned',
        source: 'return'
      });
    }
    for (const pot of pots) {
      const contenders = pot.eligible
        .map((seat) => this.player(seat))
        .filter((player) => player.hand.filter(Boolean).length === 2);
      if (contenders.length === 0) continue;

      let bestScore = null;
      let winners = [];
      let bestName = '';
      for (const player of contenders) {
        const evaluation = evaluateSeven([...player.hand, ...this.board].filter(Boolean));
        const comparison = bestScore ? compareScores(evaluation.score, bestScore) : 1;
        if (comparison > 0) {
          bestScore = evaluation.score;
          bestName = evaluation.name;
          winners = [player.seat];
        } else if (comparison === 0) {
          winners.push(player.seat);
        }
      }
      awards.push(...this.splitAmount(pot.amount, winners).map((award) => ({
        ...award,
        potAmount: pot.amount,
        potId: pot.id,
        potLabel: pot.label,
        participants: pot.participants,
        eligible: pot.eligible,
        winners,
        handName: bestName,
        source: 'showdown'
      })));
    }
    return awards;
  }

  splitAmount(amount, seats) {
    if (!seats.length) return [];
    const totalChips = Math.floor(amount / SCALE);
    const baseChips = Math.floor(totalChips / seats.length);
    let remainderChips = totalChips - baseChips * seats.length;
    return seats.map((seat) => {
      const extra = remainderChips > 0 ? 1 : 0;
      remainderChips -= extra;
      return { seat, amount: (baseChips + extra) * SCALE };
    });
  }

  enterShowdown() {
    this.dealRemainingBoard();
    this.street = 'showdown';
    this.actionOn = null;
    this.sidePots = this.calculateSidePots();
    this.suggestedAwards = this.evaluateShowdownAwards();
    this.applyAwards(this.suggestedAwards, 'Automatic showdown award');
  }

  awardFoldPot(seat) {
    const awards = [{ seat, amount: this.potTotal(), source: 'fold' }];
    this.street = 'complete';
    this.actionOn = null;
    this.sidePots = this.calculateSidePots();
    this.suggestedAwards = awards;
    this.applyAwards(awards, 'Everyone else folded');
  }

  reverseAwards() {
    if (!this.lastAwards || this.lastAwards.length === 0) return;
    for (const award of this.lastAwards) {
      this.player(award.seat).stack -= award.amount;
    }
    this.lastAwards = [];
    this.lastAwardDetails = [];
    this.lastAwardReason = '';
    this.handComplete = false;
  }

  applyAwards(awards, reason) {
    const totals = new Map();
    for (const award of awards) {
      totals.set(award.seat, (totals.get(award.seat) || 0) + award.amount);
    }
    const compactAwards = Array.from(totals.entries()).map(([seat, amount]) => ({ seat, amount }));
    for (const award of compactAwards) {
      this.player(award.seat).stack += award.amount;
    }
    this.lastAwards = compactAwards;
    this.lastAwardDetails = awards.map((award) => ({ ...award }));
    this.lastAwardReason = reason;
    this.handComplete = true;
    this.actionOn = null;
    this.pushMessage(reason);
  }

  refreshShowdownSuggestions() {
    if (this.street !== 'showdown') return;
    this.sidePots = this.calculateSidePots();
    this.suggestedAwards = this.evaluateShowdownAwards();
    if (this.handComplete && this.lastAwards.length > 0) {
      this.reverseAwards();
      this.applyAwards(this.suggestedAwards, 'Automatic showdown award updated');
    }
  }

  applySuggestedAwards() {
    if (this.street !== 'showdown' && this.street !== 'complete') throw new Error('Awards are only available after showdown or folds.');
    this.saveUndo();
    this.reverseAwards();
    const awards = this.street === 'showdown' ? this.evaluateShowdownAwards() : this.suggestedAwards;
    this.suggestedAwards = awards;
    this.applyAwards(awards, 'Suggested awards applied');
  }

  manualAward(seats) {
    const winners = Array.from(new Set((seats || []).map((seat) => Number(seat)).filter((seat) => this.player(seat).active)));
    if (!winners.length) throw new Error('Choose at least one winner.');
    if (this.street !== 'showdown' && this.street !== 'complete') throw new Error('Manual awards are only available at the end of a hand.');
    this.saveUndo();
    this.reverseAwards();
    const awards = this.splitAmount(this.potTotal(), winners).map((award) => ({ ...award, source: 'manual' }));
    this.applyAwards(awards, winners.length > 1 ? 'Manual chop applied' : 'Manual award applied');
  }

  assignedCards(except = {}, { includeFutureBoard = false } = {}) {
    const cards = [];
    for (const player of this.players) {
      player.hand.forEach((card, index) => {
        if (card && !(except.target === 'player' && except.seat === player.seat && except.index === index)) {
          cards.push(card);
        }
      });
    }

    const boardCards = includeFutureBoard ? this.boardRunoutPreview() : this.board;
    boardCards.forEach((card, index) => {
      if (card && !(except.target === 'board' && except.index === index)) cards.push(card);
    });
    return cards;
  }

  setCardOverride({ target, seat, index, card }) {
    this.saveUndo();
    const normalized = normalizeCard(card);
    const cleanTarget = String(target || '').toLowerCase();
    const cleanIndex = Number(index);

    if (cleanTarget === 'player') {
      const player = this.player(Number(seat));
      if (cleanIndex !== 0 && cleanIndex !== 1) throw new Error('Hole card index must be 0 or 1.');
      this.setVisibleCard({ target: 'player', seat: player.seat, index: cleanIndex }, normalized);
      this.refreshShowdownSuggestions();
      this.pushMessage(`${player.name} card ${cleanIndex + 1} overridden.`);
      return;
    }

    if (cleanTarget === 'board') {
      if (cleanIndex < 0 || cleanIndex > 4) throw new Error('Board card index must be 0-4.');
      if (this.boardSlotIsDealt(cleanIndex)) {
        this.setVisibleCard({ target: 'board', index: cleanIndex }, normalized);
        this.refreshShowdownSuggestions();
        this.pushMessage(`Board card ${cleanIndex + 1} overridden.`);
      } else {
        this.setFutureBoardCard(cleanIndex, normalized);
        this.pushMessage(`Future board card ${cleanIndex + 1} overridden.`);
      }
      return;
    }

    if (cleanTarget === 'deck') {
      if (cleanIndex < 0 || cleanIndex >= this.deck.length) throw new Error('Deck index is out of range.');
      if (!normalized) throw new Error('Future deck cards cannot be cleared.');
      if (this.assignedCards({}, { includeFutureBoard: true }).includes(normalized)) throw new Error(`${normalized} is already assigned to the table runout.`);
      const current = this.deck[cleanIndex];
      const existingIndex = this.deck.indexOf(normalized);
      if (existingIndex >= 0) {
        this.deck[existingIndex] = current;
      }
      this.deck[cleanIndex] = normalized;
      this.pushMessage(`Future deck card ${cleanIndex + 1} set to ${normalized}.`);
      return;
    }

    throw new Error('Unknown card override target.');
  }

  setFutureBoardCard(index, card) {
    if (!card) throw new Error('Future board cards cannot be cleared; choose a replacement card instead.');
    if (this.assignedCards({ target: 'board', index }, { includeFutureBoard: true }).includes(card)) {
      throw new Error(card + ' is already assigned to the table runout.');
    }
    const deckIndex = this.deckIndexForBoardSlot(index);
    if (deckIndex < 0 || deckIndex >= this.deck.length) throw new Error('That board card is already visible.');
    const current = this.deck[deckIndex];
    const existingIndex = this.deck.indexOf(card);
    if (existingIndex >= 0) this.deck[existingIndex] = current;
    else if (current !== card) throw new Error(card + ' is not available in the deck.');
    this.deck[deckIndex] = card;
  }

  setVisibleCard(target, card) {
    const assigned = this.assignedCards(target, { includeFutureBoard: true });
    if (card && assigned.includes(card)) throw new Error(card + ' is already assigned.');

    let previous = null;
    if (target.target === 'player') {
      previous = this.player(target.seat).hand[target.index];
    } else {
      previous = this.board[target.index];
    }
    if (previous === card) return;

    const deckIndex = card ? this.deck.indexOf(card) : -1;
    if (card && deckIndex < 0) throw new Error(card + ' is not available in the deck.');

    if (target.target === 'player') {
      this.player(target.seat).hand[target.index] = card;
    } else {
      this.board[target.index] = card;
    }

    if (card) {
      if (previous && !this.assignedCards().includes(previous)) this.deck[deckIndex] = previous;
      else this.deck.splice(deckIndex, 1);
    } else if (previous && !this.deck.includes(previous) && !this.assignedCards().includes(previous)) {
      this.deck.push(previous);
    }
  }

  publicState(role = 'hero') {
    const showAllCards = role === 'admin';
    const revealShowdown = this.street === 'showdown' || this.street === 'complete';
    const heroSeat = this.settings.heroSeat;
    const legal = this.actionOn ? this.getLegalActions(this.actionOn) : null;

    return {
      role,
      handId: this.handId,
      settings: {
        seats: this.settings.seats,
        heroSeat,
        smallBlind: centsToChips(this.settings.smallBlind),
        bigBlind: centsToChips(this.settings.bigBlind),
        defaultStack: centsToChips(this.settings.defaultStack)
      },
      buttonSeat: this.buttonSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      street: this.street,
      actionOn: this.actionOn,
      currentBet: centsToChips(this.currentBet),
      minRaise: centsToChips(this.minRaise),
      pot: centsToChips(this.displayPotTotal()),
      totalPot: centsToChips(this.potTotal()),
      streetPot: centsToChips(this.streetPotTotal()),
      board: this.board,
      boardPreview: showAllCards ? this.boardRunoutPreview() : this.board,
      boardDealt: this.board.map((_, index) => this.boardSlotIsDealt(index)),
      deckTop: showAllCards ? this.deck.slice(0, 16) : [],
      players: this.players.map((player) => {
        const showCards = showAllCards
          || player.seat === heroSeat
          || (revealShowdown && player.inHand && !player.folded);
        return {
          seat: player.seat,
          name: player.name,
          isHero: player.isHero,
          active: player.active,
          inHand: player.inHand,
          stack: centsToChips(player.stack),
          committed: centsToChips(player.committed),
          streetBet: centsToChips(player.streetBet),
          hand: showCards ? player.hand : player.hand.map((card) => (card ? 'XX' : null)),
          folded: player.folded,
          allIn: player.allIn,
          lastAction: player.lastAction,
          actedVersion: player.actedVersion,
          botType: player.botType || 'manual'
        };
      }),
      legal,
      sidePots: this.sidePots.map((pot) => ({
        id: pot.id,
        label: pot.label,
        amount: centsToChips(pot.amount),
        participants: pot.participants,
        eligible: pot.eligible
      })),
      suggestedAwards: this.suggestedAwards.map((award) => ({
        ...award,
        amount: centsToChips(award.amount),
        potAmount: award.potAmount ? centsToChips(award.potAmount) : undefined
      })),
      lastAwards: this.lastAwards.map((award) => ({
        ...award,
        amount: centsToChips(award.amount)
      })),
      lastAwardDetails: (this.lastAwardDetails || []).map((award) => ({
        ...award,
        amount: centsToChips(award.amount),
        potAmount: award.potAmount ? centsToChips(award.potAmount) : undefined
      })),
      lastAwardReason: this.lastAwardReason,
      handComplete: this.handComplete,
      canUndo: this.undoStack.length > 0,
      messages: this.messages
    };
  }
}

module.exports = {
  PokerGame,
  createDeck,
  normalizeCard,
  evaluateSeven,
  compareScores,
  chipsToCents,
  centsToChips,
  formatChips,
  RANKS,
  SUITS
};
