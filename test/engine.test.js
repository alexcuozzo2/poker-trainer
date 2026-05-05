const test = require('node:test');
const assert = require('node:assert/strict');
const { PokerGame, evaluateSeven, createDeck } = require('../src/engine');

function prepareShowdown(game, { committed, hands, board, folded = [] }) {
  const assigned = new Set(board);
  game.players.forEach((player, index) => {
    const seat = index + 1;
    const inHand = index < committed.length;
    player.active = inHand;
    player.inHand = inHand;
    player.folded = folded.includes(seat);
    player.allIn = inHand && !player.folded;
    player.stack = 0;
    player.committed = committed[index] || 0;
    player.streetBet = committed[index] || 0;
    player.hand = hands[index] || [null, null];
    for (const card of player.hand.filter(Boolean)) assigned.add(card);
  });
  game.board = board.slice();
  game.deck = createDeck().filter((card) => !assigned.has(card));
  game.street = 'river';
  game.actionOn = null;
  game.handComplete = false;
  game.sidePots = [];
  game.suggestedAwards = [];
  game.lastAwards = [];
  game.lastAwardDetails = [];
}

test('default hand uses requested table defaults', () => {
  const game = new PokerGame();
  assert.equal(game.settings.seats, 9);
  assert.equal(game.settings.heroSeat, 1);
  assert.equal(game.settings.smallBlind, 100);
  assert.equal(game.settings.bigBlind, 200);
  assert.equal(game.player(1).stack, 29900);
  assert.equal(game.player(2).stack, 29800);
  assert.equal(game.buttonSeat, 9);
  assert.equal(game.actionOn, 3);
});

test('deck deals without duplicate visible cards', () => {
  const game = new PokerGame({ seats: 6 });
  const visible = game.players
    .filter((player) => player.inHand)
    .flatMap((player) => player.hand)
    .concat(game.board.filter(Boolean));
  assert.equal(new Set(visible).size, visible.length);
});

test('minimum raise is enforced', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.equal(game.actionOn, 3);
  assert.throws(() => game.applyPlayerAction(3, 'raise', 3), /Minimum raise/);
  game.applyPlayerAction(3, 'raise', 4);
  assert.equal(game.currentBet, 400);
});

test('displayed pot excludes current street bets until the street completes', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });

  assert.equal(game.publicState('admin').pot, 0);
  assert.equal(game.publicState('admin').totalPot, 3);
  assert.equal(game.publicState('admin').streetPot, 3);

  game.applyPlayerAction(3, 'call');
  game.applyPlayerAction(1, 'call');
  game.applyPlayerAction(2, 'check');

  assert.equal(game.street, 'flop');
  assert.equal(game.publicState('admin').pot, 6);
  assert.equal(game.publicState('admin').totalPot, 6);
  assert.equal(game.publicState('admin').streetPot, 0);
});

test('side pots are calculated from contribution levels', () => {
  const game = new PokerGame({ seats: 3 });
  game.players.forEach((player, index) => {
    player.inHand = index < 3;
    player.folded = false;
    player.committed = [1000, 500, 2000][index] || 0;
  });
  const pots = game.calculateSidePots();
  const breakdown = game.calculatePotBreakdown();
  assert.deepEqual(pots.map((pot) => pot.amount), [1500, 1000]);
  assert.deepEqual(pots[0].eligible, [1, 2, 3]);
  assert.deepEqual(pots[1].eligible, [1, 3]);
  assert.deepEqual(breakdown.returns, [{ amount: 1000, seat: 3, label: 'Uncalled bet' }]);
});

test('folded dead money does not create a fake side pot', () => {
  const game = new PokerGame({ seats: 3 });
  game.players.forEach((player, index) => {
    player.inHand = index < 3;
    player.folded = index === 0;
    player.committed = [100, 200, 200][index] || 0;
  });

  const pots = game.calculateSidePots();

  assert.equal(pots.length, 1);
  assert.equal(pots[0].label, 'Main pot');
  assert.equal(pots[0].amount, 500);
  assert.deepEqual(pots[0].eligible, [2, 3]);
});

test('hand evaluator recognizes a royal flush as a straight flush', () => {
  const result = evaluateSeven(['Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d']);
  assert.equal(result.name, 'Straight flush');
  assert.deepEqual(result.score.slice(0, 2), [8, 14]);
});

test('card overrides reject duplicate visible cards', () => {
  const game = new PokerGame({ seats: 4 });
  const duplicate = game.player(1).hand[0];
  assert.throws(
    () => game.setCardOverride({ target: 'player', seat: 2, index: 0, card: duplicate }),
    /already assigned/
  );
});

test('undo walks back player actions inside the current hand', () => {
  const game = new PokerGame({ seats: 3 });
  const originalAction = game.actionOn;
  const originalSnapshot = game.snapshot();
  game.applyPlayerAction(originalAction, 'call');
  assert.notEqual(game.snapshot(), originalSnapshot);
  game.undo();
  assert.equal(game.actionOn, originalAction);
  assert.equal(game.player(originalAction).committed, JSON.parse(originalSnapshot).players[originalAction - 1].committed);
});

test('configure and redeal refunds unfinished bets before posting fresh blinds', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.equal(game.player(1).stack, 9900);
  assert.equal(game.player(2).stack, 9800);
  game.configureTable({ seats: 3, heroSeat: 1, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.equal(game.player(1).stack, 9900);
  assert.equal(game.player(2).stack, 9800);
  game.configureTable({ seats: 3, heroSeat: 1, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.equal(game.player(1).stack, 9900);
  assert.equal(game.player(2).stack, 9800);
});

test('next hand refunds unfinished commitments before rotating', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  game.startNewHand({ rotateButton: true });
  assert.equal(game.buttonSeat, 1);
  assert.equal(game.player(1).stack, 10000);
  assert.equal(game.player(2).stack, 9900);
  assert.equal(game.player(3).stack, 9800);
});

test('admin public state previews the undealt board runout', () => {
  const game = new PokerGame({ seats: 3 });
  assert.deepEqual(game.publicState('admin').boardPreview, game.deck.slice(0, 5));
});

test('future board overrides stay hidden from hero until dealt', () => {
  const game = new PokerGame({ seats: 3 });
  const river = createDeck().find((card) => !game.assignedCards().includes(card) && game.deck[4] !== card);

  game.setCardOverride({ target: 'board', index: 4, card: river });

  assert.equal(game.board[4], null);
  assert.equal(game.publicState('admin').boardPreview[4], river);
  assert.equal(game.publicState('hero').board[4], null);

  game.dealRemainingBoard();

  assert.equal(game.board[4], river);
  assert.equal(game.publicState('hero').board[4], river);
});

test('apply and redeal gives newly added seats default stacks and deals them in', () => {
  const game = new PokerGame({ seats: 2, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.equal(game.player(3).active, false);
  assert.equal(game.player(3).stack, 0);

  game.configureTable({ seats: 4, heroSeat: 1, smallBlind: 1, bigBlind: 2, defaultStack: 100 });

  assert.equal(game.player(3).active, true);
  assert.equal(game.player(4).active, true);
  assert.equal(game.player(3).inHand, true);
  assert.equal(game.player(4).inHand, true);
  assert.equal(game.player(3).hand.filter(Boolean).length, 2);
  assert.equal(game.player(4).hand.filter(Boolean).length, 2);
});

test('automatic showdown awards main and side pots to different winners', () => {
  const game = new PokerGame({ seats: 3 });
  prepareShowdown(game, {
    committed: [5000, 10000, 10000],
    hands: [['Ah', 'Ad'], ['Kc', 'Kd'], ['Qh', 'Qd']],
    board: ['2s', '7h', '9c', 'Js', '3d']
  });

  game.enterShowdown();

  assert.equal(game.player(1).stack, 15000);
  assert.equal(game.player(2).stack, 10000);
  assert.equal(game.player(3).stack, 0);
  assert.deepEqual(game.lastAwardDetails.map((award) => [award.potLabel, award.seat, award.amount]), [
    ['Main pot', 1, 15000],
    ['Side pot 1', 2, 10000]
  ]);
});

test('automatic showdown returns uncalled excess instead of creating a one-player side pot', () => {
  const game = new PokerGame({ seats: 2 });
  prepareShowdown(game, {
    committed: [5000, 10000],
    hands: [['Ah', 'Ad'], ['Kc', 'Kd']],
    board: ['2s', '7h', '9c', 'Js', '3d']
  });

  game.enterShowdown();

  assert.deepEqual(game.sidePots.map((pot) => pot.amount), [10000]);
  assert.deepEqual(game.lastAwardDetails.map((award) => [award.source, award.potLabel, award.seat, award.amount]), [
    ['return', 'Uncalled bet', 2, 5000],
    ['showdown', 'Main pot', 1, 10000]
  ]);
  assert.equal(game.player(1).stack, 10000);
  assert.equal(game.player(2).stack, 5000);
});

test('automatic showdown chops each contested pot independently', () => {
  const game = new PokerGame({ seats: 3 });
  prepareShowdown(game, {
    committed: [5000, 10000, 10000],
    hands: [['8h', '9h'], ['Td', 'Jd'], ['Qc', 'Kd']],
    board: ['2s', '3d', '4h', '5c', '6s']
  });

  game.enterShowdown();

  assert.equal(game.player(1).stack, 5000);
  assert.equal(game.player(2).stack, 10000);
  assert.equal(game.player(3).stack, 10000);
});

test('showdown card overrides automatically refresh awarded stacks', () => {
  const game = new PokerGame({ seats: 2 });
  prepareShowdown(game, {
    committed: [10000, 10000],
    hands: [['Ah', 'Ad'], ['Kc', 'Kd']],
    board: ['2s', '7h', '9c', 'Js', '3d']
  });

  game.enterShowdown();
  assert.equal(game.player(1).stack, 20000);
  assert.equal(game.player(2).stack, 0);

  game.setCardOverride({ target: 'board', index: 4, card: 'Kh' });

  assert.equal(game.player(1).stack, 0);
  assert.equal(game.player(2).stack, 20000);
  assert.equal(game.lastAwardReason, 'Automatic showdown award updated');
});


test('hero cannot be assigned villain automation', () => {
  const game = new PokerGame({ seats: 3, heroSeat: 1 });
  assert.throws(() => game.setPlayerBot(1, 'fish'), /Hero cannot be automated/);
  game.setPlayerBot(2, 'fish');
  assert.equal(game.player(2).botType, 'fish');
  assert.equal(game.publicState('admin').players[1].botType, 'fish');
});


test('fractional stack amounts are rejected', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.throws(() => game.setPlayerStack(1, 100.5), /whole numbers/);
  assert.equal(game.player(1).stack, 9900);
});

test('fractional bet and raise amounts are rejected', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  assert.throws(() => game.applyPlayerAction(3, 'raise', 4.5), /whole numbers/);
  assert.equal(game.actionOn, 3);
  assert.equal(game.player(3).stack, 10000);
});

test('chopped pots award only whole chips with odd chips first', () => {
  const game = new PokerGame({ seats: 2 });
  const awards = game.splitAmount(500, [1, 2]);
  assert.deepEqual(awards, [
    { seat: 1, amount: 300 },
    { seat: 2, amount: 200 }
  ]);
});


test('admin board preview remains available after a folded hand ends', () => {
  const game = new PokerGame({ seats: 3 });
  game.street = 'complete';
  game.handComplete = true;
  game.board = [null, null, null, null, null];
  game.deck = ['Ah', 'Kd', 'Qc', 'Js', 'Th', ...createDeck().filter((card) => !['Ah', 'Kd', 'Qc', 'Js', 'Th'].includes(card))];

  const state = game.publicState('admin');

  assert.deepEqual(state.boardPreview.slice(0, 5), ['Ah', 'Kd', 'Qc', 'Js', 'Th']);
  assert.deepEqual(state.boardDealt, [false, false, false, false, false]);
});

test('visible card override preserves reserved future board cards', () => {
  const game = new PokerGame({ seats: 3 });
  const previewBefore = game.boardRunoutPreview();
  const replacement = game.deck[8];

  game.setCardOverride({ target: 'player', seat: 1, index: 0, card: replacement });

  assert.deepEqual(game.boardRunoutPreview(), previewBefore);
});

test('reserved future board cards cannot be assigned elsewhere', () => {
  const game = new PokerGame({ seats: 3 });
  const futureFlop = game.boardRunoutPreview()[0];

  assert.throws(
    () => game.setCardOverride({ target: 'player', seat: 1, index: 0, card: futureFlop }),
    /already assigned/
  );
});

test('future board override does not change other previewed board cards', () => {
  const game = new PokerGame({ seats: 3 });
  const before = game.boardRunoutPreview();
  const replacement = game.deck[9];

  game.setCardOverride({ target: 'board', index: 3, card: replacement });

  const after = game.boardRunoutPreview();
  assert.equal(after[3], replacement);
  assert.deepEqual([after[0], after[1], after[2], after[4]], [before[0], before[1], before[2], before[4]]);
  assert.throws(
    () => game.setCardOverride({ target: 'board', index: 4, card: after[0] }),
    /already assigned/
  );
});
