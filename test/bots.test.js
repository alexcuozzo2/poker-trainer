const test = require('node:test');
const assert = require('node:assert/strict');
const { PokerGame } = require('../src/engine');
const { decideBotAction, preflopScore, postflopTexture } = require('../src/bots');

function forceAction(game, seat) {
  game.actionOn = seat;
}

test('pro bot chooses a legal aggressive action with aces preflop', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  forceAction(game, 3);
  game.player(3).hand = ['Ah', 'Ad'];

  const decision = decideBotAction(game, 3, 'pro', { random: () => 0.1 });
  const legal = game.getLegalActions(3);
  const legalTypes = legal.actions.map((action) => action.type);

  assert.equal(decision.action, 'raise');
  assert.ok(legalTypes.includes(decision.action));
  assert.ok(decision.amount >= legal.minRaiseTotal);
});

test('pro bot folds trash to a large preflop raise', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  game.applyPlayerAction(3, 'raise', 20);
  forceAction(game, 1);
  game.player(1).hand = ['7c', '2d'];

  const decision = decideBotAction(game, 1, 'pro', { random: () => 0.9 });

  assert.equal(decision.action, 'fold');
});

test('fish bot overcalls a small preflop price with a loose holding', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  forceAction(game, 3);
  game.player(3).hand = ['8h', '6h'];

  const decision = decideBotAction(game, 3, 'fish', { random: () => 0.5 });

  assert.equal(decision.action, 'call');
});

test('postflop texture detects top pair and draws without opponent card knowledge', () => {
  const texture = postflopTexture(['Ah', 'Th'], ['Ac', '9h', '2h']);

  assert.equal(texture.topPair, true);
  assert.equal(texture.flushDraw, true);
  assert.ok(preflopScore(['Ah', 'Ad']) > preflopScore(['7c', '2d']));
});


function preparePostflop(game, seat, hand, board) {
  game.street = 'flop';
  game.board = [board[0] || null, board[1] || null, board[2] || null, board[3] || null, board[4] || null];
  game.currentBet = 0;
  game.actionOn = seat;
  for (const player of game.players) {
    player.inHand = player.active;
    player.folded = false;
    player.allIn = false;
    player.streetBet = 0;
    player.actedVersion = 0;
  }
  game.player(seat).hand = hand;
}

test('postflop texture detects combo draws and board texture', () => {
  const wet = postflopTexture(['Jh', 'Th'], ['9h', '8h', '2c']);
  const dry = postflopTexture(['Ah', 'Ad'], ['Ks', '7d', '2c']);

  assert.equal(wet.comboDraw, true);
  assert.equal(wet.boardTexture, 'wet-dynamic');
  assert.equal(dry.boardTexture, 'dry-static');
});

test('fish bot fast plays value on wet dynamic boards', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  preparePostflop(game, 1, ['Jh', 'Jd'], ['Th', '9h', '8c']);

  const decision = decideBotAction(game, 1, 'fish', { random: () => 0.1 });

  assert.equal(decision.action, 'bet');
  assert.match(decision.reason, /fast-plays value/);
});

test('fish bot slow plays value on dry static boards more often', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  preparePostflop(game, 1, ['Ah', 'Ad'], ['Ks', '7d', '2c']);

  const decision = decideBotAction(game, 1, 'fish', { random: () => 0.9 });

  assert.equal(decision.action, 'check');
  assert.match(decision.reason, /slowplays value/);
});

test('fish bot checks combo draws passively when not facing a bet', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  preparePostflop(game, 1, ['Jh', 'Th'], ['9h', '8h', '2c']);

  const decision = decideBotAction(game, 1, 'fish', { random: () => 0.01 });

  assert.equal(decision.action, 'check');
  assert.match(decision.reason, /combo draw passively/);
});


test('bot wager decisions use whole chip amounts', () => {
  const game = new PokerGame({ seats: 3, smallBlind: 1, bigBlind: 2, defaultStack: 100 });
  preparePostflop(game, 1, ['Jh', 'Jd'], ['Th', '9h', '8c']);

  const decision = decideBotAction(game, 1, 'fish', { random: () => 0.1 });

  assert.equal(Number.isInteger(decision.amount), true);
});
